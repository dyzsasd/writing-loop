// handoff v2 契约 —— DESIGN §4.8 / §8.3。
//
// 对齐基准是 video-creation-studio 的 `schemas/handoff/writing-loop-handoff.v2.schema.json`：整份
// schema 逐字内联在下面作为 fixture，builder 产物用一个最小 JSON Schema 子集校验器逐字段校验，
// 因此字段名、类型、枚举、pattern 与 `additionalProperties: false` 的任何漂移都会在本地失败，
// 不必等到 VCS 侧导入才发现。
//
// 摘要口径与 VCS importer 的 `canonical_json` 逐条对应（键按 UTF-16 码元排序、只接受安全整数、
// 无空白），本文件用一份独立重写的 Python 规则镜像做同字符串比对。
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProductionTaskEvent, type AssetRef, type ProductionTaskEvent } from "../src/production-domain.ts";
import { ProductionStore } from "../src/production-store.ts";
import { enqueueProductionTask } from "../src/production-enqueue.ts";
import { createProductionDispatchIntent, readProductionIntent } from "../src/production-intent.ts";
import { writeProductionCasObject, readProductionCasObject } from "../src/production-cas.ts";
import { WorkspaceCasLocalAssetSource } from "../src/production-local-asset-source.ts";
import {
  compileShotRequest,
  parseShotRequest,
  parseShotRequestDraft,
  shotRequestCanonicalJson,
  type ShotCompileCapability,
  type ShotCompilePolicy,
  type ShotExecutionProfile,
  type ShotRequestDraft,
  type VideoBackendLimits,
} from "../src/production-shot-request.ts";
import {
  VIDEO_STUDIO_ASSET_FILE_EXTENSIONS,
  VIDEO_STUDIO_HANDOFF_CONTRACT_V2,
  buildVideoStudioHandoffV2,
  exportVideoStudioHandoffV2,
  parseVideoStudioHandoffV2Create,
  videoStudioGatewayAssetReader,
  videoStudioHandoffCanonicalJson,
  videoStudioHandoffDigest,
  videoStudioWorkspaceAssetReader,
  type VideoStudioHandoffTakeSource,
  type VideoStudioHandoffV2,
} from "../src/production-studio-handoff.ts";
import { productionMain } from "../src/production.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const errorOf = (fn: () => unknown): string => {
  try { fn(); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};
const asyncErrorOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};

// —— VCS schema（逐字内联） ——

type Schema = Record<string, any>;

const HANDOFF_V2_SCHEMA: Schema =
{
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "openmontage/handoff/writing-loop-handoff.v2",
    "title": "Writing-loop Video Studio Handoff v2",
    "description": "writing-loop 的 `production handoff --export-dir` 产出的交接文档。相对 v1，takes 增加 shotRequest、execution 摘要、cost、assetRoles、gates 与 license 摘要。字段名保持 writing-loop 侧的 camelCase 原样，便于跨仓库逐字比对。整份文档按 writing-loop 的规范 JSON 规则（键按 UTF-16 码元排序、无空白、只接受安全整数）计算 sha256 摘要，导入时以该摘要与操作者带来的期望值比对。",
    "type": "object",
    "required": [
      "version",
      "contract",
      "handoffId",
      "studioProjectId",
      "workspaceId",
      "project",
      "productionRevision",
      "pipeline",
      "createdAt",
      "delivery",
      "takes",
      "requiresAgentOrchestration"
    ],
    "additionalProperties": false,
    "properties": {
      "version": { "const": 2 },
      "contract": { "const": "citronetic-video-creation-studio-codex-handoff-v2" },
      "handoffId": { "$ref": "#/$defs/identifier" },
      "studioProjectId": {
        "type": "string",
        "maxLength": 80,
        "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        "description": "VCS 侧的项目 id（kebab-case）"
      },
      "workspaceId": { "$ref": "#/$defs/identifier" },
      "project": { "$ref": "#/$defs/identifier" },
      "productionRevision": { "type": "integer", "minimum": 0 },
      "pipeline": {
        "const": "scripted-drama",
        "description": "v2 只承载 scripted-drama 流水线；v1 的四条流水线仍走 v1 契约"
      },
      "createdAt": { "$ref": "#/$defs/isoUtc" },
      "delivery": { "$ref": "#/$defs/delivery" },
      "takes": {
        "type": "array",
        "minItems": 1,
        "maxItems": 2048,
        "items": { "$ref": "#/$defs/take" }
      },
      "requiresAgentOrchestration": {
        "const": true,
        "description": "上游是 agent 编排的：导入本身不构成执行或审批证据"
      }
    },
    "$defs": {
      "identifier": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
      },
      "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
      "isoUtc": {
        "type": "string",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$",
        "description": "规范 UTC ISO 时间（与 writing-loop 的 toISOString 输出一致）"
      },
      "opaque": { "type": "string", "minLength": 1, "maxLength": 256 },
      "assetRef": {
        "type": "object",
        "required": ["version", "uri", "sha256", "byteLength", "mediaType"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "uri": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048,
            "description": "稳定存储 URI（cas: / urn: 等），不含签名 query"
          },
          "sha256": { "$ref": "#/$defs/sha256" },
          "byteLength": { "type": "integer", "minimum": 0 },
          "mediaType": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$"
          }
        }
      },
      "episodeRevisionRef": {
        "type": "object",
        "required": ["version", "episodeId", "revision", "source"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "episodeId": { "$ref": "#/$defs/identifier" },
          "revision": { "type": "integer", "minimum": 0 },
          "source": { "$ref": "#/$defs/assetRef" }
        }
      },
      "shotRevisionRef": {
        "type": "object",
        "required": ["version", "episode", "shotId", "revision", "source"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "episode": { "$ref": "#/$defs/episodeRevisionRef" },
          "shotId": { "$ref": "#/$defs/identifier" },
          "revision": { "type": "integer", "minimum": 0 },
          "source": { "$ref": "#/$defs/assetRef" }
        }
      },
      "delivery": {
        "type": "object",
        "required": ["version", "aspectRatio", "width", "height", "fps", "container", "language"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "aspectRatio": { "enum": ["9:16", "16:9", "1:1"] },
          "width": { "type": "integer", "minimum": 256, "maximum": 7680 },
          "height": { "type": "integer", "minimum": 256, "maximum": 7680 },
          "fps": { "enum": [24, 25, 30] },
          "container": { "const": "video/mp4" },
          "language": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9-]{0,34}$" }
        }
      },
      "assetRole": {
        "type": "string",
        "pattern": "^(take|last-frame|keyframe-first|keyframe-last|reference:[a-z][a-z0-9-]{0,63})$"
      },
      "assetRoleEntry": {
        "type": "object",
        "required": ["sha256", "role"],
        "additionalProperties": false,
        "properties": {
          "sha256": { "$ref": "#/$defs/sha256" },
          "role": { "$ref": "#/$defs/assetRole" }
        }
      },
      "execution": {
        "type": "object",
        "description": "intent execution 的摘要：静态字段与 gateway 记录的作业标识",
        "required": [
          "version",
          "operation",
          "modelFamily",
          "backendInstanceId",
          "workflowSha256",
          "modelSha256",
          "parametersSha256",
          "modelId",
          "variant",
          "durationSeconds",
          "aspectRatio",
          "remoteJobId",
          "providerJobId"
        ],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "operation": { "enum": ["comfyui-workflow", "minimax-h3", "ark-video-task", "vertex-veo-lro"] },
          "modelFamily": { "enum": ["generic", "minimax-h3", "seedance", "veo"] },
          "backendInstanceId": { "$ref": "#/$defs/opaque" },
          "workflowSha256": { "$ref": "#/$defs/sha256" },
          "modelSha256": { "$ref": "#/$defs/sha256" },
          "parametersSha256": { "$ref": "#/$defs/sha256" },
          "modelId": {
            "type": ["string", "null"],
            "maxLength": 256,
            "description": "云家族的 modelId；H3 以 profile 表达，填 null"
          },
          "variant": {
            "type": ["string", "null"],
            "maxLength": 64,
            "description": "H3 的 fl2va / ref2va；其他家族填 null"
          },
          "durationSeconds": { "type": "integer", "minimum": 1, "maximum": 600 },
          "aspectRatio": { "type": "string", "maxLength": 16 },
          "remoteJobId": { "$ref": "#/$defs/identifier" },
          "providerJobId": { "type": ["string", "null"], "maxLength": 256 }
        }
      },
      "cost": {
        "oneOf": [
          {
            "type": "object",
            "required": ["version", "state", "currency", "amountMicros", "basis", "settlement"],
            "additionalProperties": false,
            "properties": {
              "version": { "const": 1 },
              "state": { "const": "known" },
              "currency": { "const": "USD" },
              "amountMicros": { "type": "integer", "minimum": 0 },
              "basis": { "enum": ["reported", "billed", "estimated", "tariff", "reported-converted"] },
              "settlement": {
                "oneOf": [
                  { "type": "null" },
                  {
                    "type": "object",
                    "required": ["nativeCurrency", "nativeAmountMicros", "rateMicrosPerUnit", "rateAsOf", "rateSource"],
                    "additionalProperties": false,
                    "properties": {
                      "nativeCurrency": { "const": "CNY" },
                      "nativeAmountMicros": { "type": "integer", "minimum": 0 },
                      "rateMicrosPerUnit": { "type": "integer", "minimum": 1 },
                      "rateAsOf": { "$ref": "#/$defs/isoUtc" },
                      "rateSource": { "const": "gateway-registry" }
                    }
                  }
                ]
              }
            }
          },
          {
            "type": "object",
            "required": ["version", "state", "reason"],
            "additionalProperties": false,
            "properties": {
              "version": { "const": 1 },
              "state": { "const": "unknown" },
              "reason": {
                "enum": ["not-recorded", "provider-not-reported", "in-flight", "unavailable", "legacy-record"]
              }
            }
          }
        ]
      },
      "gateRecord": {
        "type": "object",
        "description": "writing-loop 侧已通过的门；importer 复制到检查点 metadata.gates[] 并补 handoffDigest",
        "required": ["version", "gate", "bindsTo", "approvedBy", "approvedAt", "system"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "gate": { "enum": ["qc-approved", "batch-approved", "sample-approved"] },
          "bindsTo": {
            "type": "object",
            "required": ["planSha256", "requestSha256"],
            "additionalProperties": false,
            "properties": {
              "planSha256": { "$ref": "#/$defs/sha256" },
              "requestSha256": { "$ref": "#/$defs/sha256" }
            }
          },
          "approvedBy": { "$ref": "#/$defs/opaque" },
          "approvedAt": { "$ref": "#/$defs/isoUtc" },
          "system": { "$ref": "#/$defs/opaque" }
        }
      },
      "license": {
        "type": "object",
        "description": "take 的许可摘要；summary 原样写入 asset_manifest.assets[].license",
        "required": ["version", "summary", "status", "basis", "territories", "obligations"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
          "status": { "enum": ["verified", "unknown", "blocked"] },
          "basis": { "enum": ["community", "provider-terms", "written-license"] },
          "territories": {
            "type": "array",
            "items": { "type": "string", "pattern": "^[A-Z]{2}$" },
            "maxItems": 256
          },
          "obligations": {
            "oneOf": [
              { "type": "null" },
              {
                "type": "object",
                "required": ["attribution", "revenueThresholdUsd", "noModelImprovement"],
                "additionalProperties": false,
                "properties": {
                  "attribution": {
                    "type": ["string", "null"],
                    "maxLength": 128,
                    "description": "需要署名的对象，例如 MiniMax H3；null 表示无署名义务"
                  },
                  "revenueThresholdUsd": { "type": ["integer", "null"], "minimum": 0 },
                  "noModelImprovement": { "type": "boolean" }
                }
              }
            ]
          }
        }
      },
      "approval": {
        "type": "object",
        "required": ["version", "decision", "taskRevision", "subjectRevision", "decidedAt", "decidedBy", "note"],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "decision": { "enum": ["approved", "rejected"] },
          "taskRevision": { "type": "integer", "minimum": 0 },
          "subjectRevision": { "type": "integer", "minimum": 0 },
          "decidedAt": { "$ref": "#/$defs/isoUtc" },
          "decidedBy": { "$ref": "#/$defs/opaque" },
          "note": { "type": ["string", "null"], "maxLength": 4096 }
        }
      },
      "take": {
        "type": "object",
        "required": [
          "version",
          "taskId",
          "shot",
          "shotRequest",
          "assets",
          "assetRoles",
          "execution",
          "cost",
          "gates",
          "license",
          "approval"
        ],
        "additionalProperties": false,
        "properties": {
          "version": { "const": 1 },
          "taskId": { "$ref": "#/$defs/identifier" },
          "shot": { "$ref": "#/$defs/shotRevisionRef" },
          "shotRequest": {
            "allOf": [
              { "$ref": "#/$defs/assetRef" },
              {
                "properties": {
                  "mediaType": { "const": "application/vnd.writing-loop.shot-request+json" }
                }
              }
            ],
            "description": "本镜的不可变 ShotRequest；文件以 <sha256>.json 出现在资产目录中"
          },
          "assets": {
            "type": "array",
            "minItems": 1,
            "maxItems": 64,
            "items": { "$ref": "#/$defs/assetRef" }
          },
          "assetRoles": {
            "type": "array",
            "minItems": 1,
            "maxItems": 64,
            "items": { "$ref": "#/$defs/assetRoleEntry" }
          },
          "execution": { "$ref": "#/$defs/execution" },
          "cost": { "$ref": "#/$defs/cost" },
          "gates": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "items": { "$ref": "#/$defs/gateRecord" }
          },
          "license": { "$ref": "#/$defs/license" },
          "approval": { "$ref": "#/$defs/approval" }
        }
      }
    }
  };

// —— 最小 JSON Schema 子集校验器 ——
//
// 只实现本 schema 用到的关键字：$ref / $defs、const、enum、type（含类型数组）、properties、
// required、additionalProperties、items、minItems / maxItems、minimum / maximum、
// minLength / maxLength、pattern、oneOf、allOf。未实现的关键字出现即报错，避免「校验器没看懂
// 所以通过了」这种假阳性。
const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "$defs", "$ref", "const", "enum", "type", "properties",
  "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "oneOf", "allOf",
]);

function typeMatches(expected: string, value: unknown): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number";
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  throw new Error(`未实现的 JSON Schema type：${expected}`);
}

function validateSchema(schema: Schema, value: unknown, root: Schema, path: string): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) throw new Error(`未实现的 JSON Schema 关键字：${keyword}`);
  }
  if (typeof schema.$ref === "string") {
    // 2020-12 允许 $ref 与其他关键字并存，本校验器不实现那套合成；出现即抛错，避免默默忽略约束。
    const siblings = Object.keys(schema).filter((key) => key !== "$ref" && key !== "description");
    if (siblings.length) {
      throw new Error(`未实现的 $ref 同级关键字：${siblings.join(",")}`);
    }
    const match = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!match) throw new Error(`未实现的 $ref：${schema.$ref}`);
    const target = (root.$defs as Schema | undefined)?.[match[1]!] as Schema | undefined;
    if (target === undefined) throw new Error(`$ref 找不到定义：${schema.$ref}`);
    return validateSchema(target, value, root, path);
  }
  const errors: string[] = [];
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path} 必须是 ${JSON.stringify(schema.const)}，实得 ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum)
    && !schema.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${path} 不在枚举 ${JSON.stringify(schema.enum)} 内，实得 ${JSON.stringify(value)}`);
  }
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((item: string) => typeMatches(item, value))) {
      errors.push(`${path} 类型必须是 ${expected.join("|")}，实得 ${value === null ? "null" : typeof value}`);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) errors.push(...validateSchema(item, value, root, path));
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((item: Schema) => validateSchema(item, value, root, path).length === 0);
    if (matched.length !== 1) errors.push(`${path} 必须恰好匹配 oneOf 的 1 个分支，实得 ${matched.length}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} 长度 ${value.length} 小于 minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} 长度 ${value.length} 超过 maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} 不匹配 pattern ${schema.pattern}，实得 ${JSON.stringify(value)}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} ${value} 小于 minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} ${value} 超过 maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} 只有 ${value.length} 项，少于 minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path} 有 ${value.length} 项，超过 maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, root, `${path}[${index}]`)));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(row, name)) errors.push(`${path} 缺少必填字段 ${name}`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(row)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) {
          errors.push(`${path} 含 schema 未声明的字段 ${name}`);
        }
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(row, name)) {
        errors.push(...validateSchema(child, row[name], root, `${path}.${name}`));
      }
    }
  }
  return errors;
}

const schemaErrors = (value: unknown): string[] =>
  validateSchema(HANDOFF_V2_SCHEMA, value, HANDOFF_V2_SCHEMA, "$");

/**
 * 内联副本的同步判据。设了 `WL_VCS_ROOT` 时读 VCS 仓库里的 schema 原文并逐字段比对（这是权威口径，
 * 不一致直接 FAIL）；没设时退化为比对下面这个常量——它是写入本文件时那份 schema 文件的 sha256，
 * 由 `shasum -a 256 schemas/handoff/writing-loop-handoff.v2.schema.json` 取得。
 */
const HANDOFF_V2_SCHEMA_FILE_SHA256 = "0e6de2d3bc42055f5713c5151af278f627bb2c32bf0f09c3bb5649c90a90a404";
const HANDOFF_V2_SCHEMA_RELATIVE = "schemas/handoff/writing-loop-handoff.v2.schema.json";

// —— VCS importer 的 canonical JSON 规则镜像（独立重写，用于同字符串比对） ——
function pythonCanonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("嵌套超过 64 层");
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`规范 JSON 只接受安全整数，收到 ${value}`);
    if (!Number.isSafeInteger(value)) throw new Error(`整数 ${value} 超出安全整数范围`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => pythonCanonicalJson(item, depth + 1)).join(",")}]`;
  if (typeof value !== "object") throw new Error("规范 JSON 不接受该类型");
  const row = value as Record<string, unknown>;
  // Python 侧按 key.encode("utf-16-be") 的字节序排序；UTF-16BE 字节序即 UTF-16 码元序。
  const keys = Object.keys(row).sort((left, right) => {
    const a = Buffer.from(left, "utf16le").swap16();
    const b = Buffer.from(right, "utf16le").swap16();
    return Buffer.compare(a, b);
  });
  return `{${keys.map((key) => `${JSON.stringify(key)}:${pythonCanonicalJson(row[key], depth + 1)}`).join(",")}}`;
}

// —— fixture：真实编译产物 + 真实账本 ——

const AT = "2026-08-28T00:00:00.000Z";
const WORKSPACE_ID = `ws_${"a".repeat(32)}`;
const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const FIRST_FRAME = Buffer.from("first-frame-png-payload", "utf8");
const TAKE_VIDEO = Buffer.from("take-mp4-payload", "utf8");
const LAST_FRAME = Buffer.from("derived-last-frame-png-payload", "utf8");
const SECOND_VIDEO = Buffer.from("second-mp4-payload", "utf8");

const assetOf = (bytes: Buffer, mediaType: string, uri: string): AssetRef => ({
  version: 1, uri, sha256: digestOf(bytes), byteLength: bytes.length, mediaType,
});
const casAsset = (bytes: Buffer, mediaType: string): AssetRef =>
  assetOf(bytes, mediaType, `cas://wl-sg/sha256/${digestOf(bytes)}`);
const urnAsset = (bytes: Buffer, mediaType: string): AssetRef =>
  assetOf(bytes, mediaType, `urn:sha256:${digestOf(bytes)}`);

const FIRST_FRAME_ASSET = casAsset(FIRST_FRAME, "image/png");
const TAKE_ASSET = urnAsset(TAKE_VIDEO, "video/mp4");
const LAST_FRAME_ASSET = urnAsset(LAST_FRAME, "image/png");

const limits = (): VideoBackendLimits => ({
  modes: ["i2v", "fl2v", "ref2v"],
  durationSeconds: { min: 4, max: 15, grid: [5, 8], gridByResolution: null },
  aspectRatios: ["9:16", "16:9", "1:1"],
  resolutions: ["768p"],
  maxReferenceImages: 9,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0,
  maxStyleImages: 0,
  maxReferenceAssetsTotal: null,
  audioOnlyReference: false,
  keyframesAndReferencesExclusive: true,
  seed: "uint32",
  promptLanguages: null,
  promptDirectiveSyntax: null,
  nativeAudio: { status: "supported", channels: "stereo", verifiedBy: null },
  returnsLastFrame: false,
  maxInputImageBytes: 30 * 1024 * 1024,
  inputImageMediaTypes: ["image/png", "image/jpeg"],
  realFaceReferences: "allowed",
  outputRetention: { kind: "comfy-history", bounded: true },
});

const capability = (): ShotCompileCapability => ({
  backendKind: "comfyui",
  backendInstanceId: "gw-sg-1",
  modelFamilies: ["minimax-h3"],
  processingRegions: ["SG"],
  limitsByModelId: { "h3-9x16-8s": limits() },
});

const h3Profile = (): ShotExecutionProfile => ({
  version: 1,
  kind: "writing-loop/execution-profile",
  profileId: "h3-9x16-8s",
  backendInstanceId: "gw-sg-1",
  workflowSha256: "b".repeat(64),
  modelSha256: "c".repeat(64),
  parametersSha256: "d".repeat(64),
  resolution: "768p",
  aspectRatio: "9:16",
  generateAudio: true,
  modelFamily: "minimax-h3",
  operation: "comfyui-workflow",
  variant: "fl2va",
  shortEdge: 768,
  durationSeconds: 8,
} as ShotExecutionProfile);

const policy = (taskId: string): ShotCompilePolicy => ({
  version: 1,
  anchorPreference: "keyframes",
  casAuthority: "wl-sg",
  compiler: "production-shot-request@1",
  execution: h3Profile(),
  project: {
    allowedProcessingRegions: ["SG"],
    licenseCompliance: { annualRevenueUsdBelow: 1_000_000, attributionSurfaces: ["片尾字幕"] },
    usesOutputToImproveModels: false,
  },
  approvedCandidates: {},
  propStates: {},
  intent: {
    taskId,
    createdAt: AT,
    useTerritories: ["SG"],
    budget: { version: 1, currency: "USD", estimatedAmountMicros: 1_000_000, maximumAmountMicros: 4_000_000 },
    rights: { version: 1, status: "cleared", territories: ["SG"], evidence: null, expiresAt: null },
    moderation: { version: 1, status: "passed", reviewedAt: AT, evidence: null },
    license: {
      version: 1, status: "verified", basis: "community", territories: ["SG"], licenseSha256: null,
      evidence: null, issuedBy: null, issuedAt: null, expiresAt: null,
      obligations: { attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true },
    },
  },
});

const draftFor = (shotId: string): ShotRequestDraft => parseShotRequestDraft({
  version: 1,
  kind: "writing-loop/shot-request-draft",
  shotId,
  subject: {
    version: 1,
    episode: {
      version: 1, episodeId: "ep-001", revision: 3,
      source: casAsset(Buffer.from("episode-001-source", "utf8"), "text/markdown"),
    },
    shotId,
    revision: 1,
    source: casAsset(Buffer.from(`${shotId}-source`, "utf8"), "text/markdown"),
  },
  provenance: {
    storyDesignSha256: "f".repeat(64),
    assetsRevision: 12,
    visualProductionSha256: null,
    beatCardHash: "8137791889ad",
    scriptLine: 17,
    mergedScriptLines: [],
  },
  scene: {
    sceneId: "S02", subscene: null, timeOfDay: "day", interior: "ext",
    lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_A",
  },
  camera: {
    shot_size: "wide", camera_movement: "dolly_out", lens_mm: 35, lighting_key: "natural",
    depth_of_field: "deep", color_temperature: "neutral", cameraId: "CAM_A",
  },
  cast: [],
  props: [],
  crowd: null,
  action: "一列蒸汽机车穿过大明制式城楼门洞，白汽扑上琉璃瓦。",
  productionTags: ["特效"],
  dialogue: [],
  output: { aspectRatio: "9:16", generateAudio: true, storyboardDurationSeconds: 8, fps: 24, seed: 4_242 },
  continuity: {
    stageGroup: "EP001-S1",
    prevShotId: null,
    firstFrame: {
      asset: FIRST_FRAME_ASSET,
      origin: { kind: "operator-upload", note: "1-1 首帧由操作者上传" },
      containsRealFace: false,
    },
    lastFrame: null,
    references: [],
    referencePolicy: "trim_by_priority",
    spatialPasses: [],
  },
  prompt: {
    text: "未来玉京城楼，蒸汽机车穿过门洞，白汽扑上琉璃瓦，广角缓慢后拉。",
    negativeText: null,
    language: "zh-CN",
    authoredBy: "episode-writer",
    translations: [],
  },
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-handoff-v2-")));
let server: Server | null = null;
try {
  const data = join(root, ".writing-loop");
  mkdirSync(join(data, "demo"), { recursive: true });
  mkdirSync(join(root, "repo"));
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: WORKSPACE_ID }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "玉京旧事", repoPath: "repo", enabled: true } },
  }, null, 2) + "\n");

  const store = new ProductionStore(root, WORKSPACE_ID, "demo");
  const at = (second: number): string => `2026-08-28T00:01:${String(second).padStart(2, "0")}.000Z`;
  const apply = (
    taskId: string, type: ProductionTaskEvent["type"], second: number, extra: Record<string, unknown> = {},
  ): void => {
    const task = store.read().tasks.find((row) => row.id === taskId)!;
    store.apply(parseProductionTaskEvent({
      version: 1, type, eventId: `${taskId}-${task.revision}-${type}`, taskId,
      expectedRevision: task.revision, occurredAt: at(second), ...extra,
    }));
  };

  /** 逐镜落地一条真实链路：编译 → ShotRequest 进 CAS → intent + task → 入库 → QC approved。 */
  function publishTake(shotId: string, taskId: string, remoteJobId: string, assets: AssetRef[]): void {
    const compiled = compileShotRequest(draftFor(shotId), capability(), policy(taskId));
    if (compiled.shotRequest === null || compiled.intentDraft === null) {
      throw new Error(`${shotId} 编译未产出 ShotRequest：${JSON.stringify(compiled.validation.issues)}`);
    }
    writeProductionCasObject(root, "demo", Buffer.from(shotRequestCanonicalJson(compiled.shotRequest), "utf8"));
    enqueueProductionTask({ root, workspaceId: WORKSPACE_ID, project: "demo", draft: compiled.intentDraft });
    apply(taskId, "submission-started", 2, {
      backendInstanceId: "gw-sg-1", remoteJobId, requestDigest: "e".repeat(64),
    });
    apply(taskId, "submission-confirmed", 3, { backendInstanceId: "gw-sg-1", remoteJobId });
    apply(taskId, "ingestion-started", 4);
    apply(taskId, "qc-requested", 5, {
      assets,
      cost: { version: 1, state: "known", currency: "USD", amountMicros: 1_240_000, basis: "tariff" },
    });
    apply(taskId, "approved", 6, { decidedBy: "qc:lead", note: "picture lock" });
  }

  publishTake("EP001-S1-1", "take-ep001-s1-1", "11111111-1111-4111-8111-111111111111",
    [TAKE_ASSET, LAST_FRAME_ASSET]);

  const resolveSource = (taskId: string): VideoStudioHandoffTakeSource => {
    const intent = readProductionIntent(root, "demo", taskId);
    if (intent === null) throw new Error(`intent ${taskId} 不存在`);
    const bytes = readProductionCasObject(root, "demo", intent.inputs[0]!.sha256);
    if (bytes === null) throw new Error(`ShotRequest ${intent.inputs[0]!.sha256} 不在 CAS`);
    return { intent, shotRequest: parseShotRequest(JSON.parse(bytes.toString("utf8"))) };
  };

  const create = {
    version: 2 as const,
    handoffId: "handoff-ep001-s1-v2",
    studioProjectId: "yujing-jiushi-ep001",
    pipeline: "scripted-drama" as const,
    createdAt: "2026-08-28T00:02:00.000Z",
    delivery: {
      version: 1 as const, aspectRatio: "9:16" as const, width: 1080, height: 1920,
      fps: 24 as const, container: "video/mp4" as const, language: "zh-CN",
    },
    taskIds: ["take-ep001-s1-1"],
  };
  const handoff = buildVideoStudioHandoffV2(store.read(), create, resolveSource);

  // —— schema 逐字段对齐 ——
  const errors = schemaErrors(handoff);
  ok(errors.length === 0, `builder 产物满足 VCS 的 handoff v2 schema（实得 ${errors.slice(0, 3).join("；") || "无错误"}）`);
  ok(handoff.version === 2 && handoff.contract === VIDEO_STUDIO_HANDOFF_CONTRACT_V2
    && handoff.pipeline === "scripted-drama" && handoff.requiresAgentOrchestration === true
    && handoff.workspaceId === WORKSPACE_ID && handoff.project === "demo",
    "顶层身份：version 2 / v2 contract / scripted-drama / 仍需 agent 编排");

  const take = handoff.takes[0]!;
  ok(take.shotRequest.mediaType === "application/vnd.writing-loop.shot-request+json"
    && take.shotRequest.sha256 === resolveSource("take-ep001-s1-1").intent.inputs[0]!.sha256,
    "take.shotRequest 就是 intent.inputs[0] 的不可变 ShotRequest");
  ok(take.assets.length === 3 && take.assetRoles.length === 3
    && new Set(take.assetRoles.map((row) => row.sha256)).size === 3
    && take.assetRoles.map((row) => row.role).sort().join(",") === "keyframe-first,last-frame,take",
    "assetRoles 与 assets 一一覆盖：唯一主视频 take、派生尾帧 last-frame、首帧 keyframe-first");
  ok(take.assetRoles.find((row) => row.sha256 === TAKE_ASSET.sha256)?.role === "take"
    && take.assetRoles.find((row) => row.sha256 === LAST_FRAME_ASSET.sha256)?.role === "last-frame"
    && take.assetRoles.find((row) => row.sha256 === FIRST_FRAME_ASSET.sha256)?.role === "keyframe-first",
    "角色按 mediaType 与 ShotRequest continuity 判定，不靠数组位置");
  ok(!take.assets.some((asset) => asset.sha256 === take.shotRequest.sha256),
    "ShotRequest 不进 assets[]（importer 的 asset_manifest 只收 video/image/audio）");

  ok(Object.keys(take.execution).sort().join(",") === [
    "aspectRatio", "backendInstanceId", "durationSeconds", "modelFamily", "modelId", "modelSha256",
    "operation", "parametersSha256", "providerJobId", "remoteJobId", "variant", "version",
    "workflowSha256",
  ].join(","), "execution 只投影 schema 声明的 13 个字段（H3 的 shortEdge 等静态字段被投影掉）");
  ok(take.execution.operation === "comfyui-workflow" && take.execution.modelFamily === "minimax-h3"
    && take.execution.modelId === null && take.execution.variant === "fl2va"
    && take.execution.durationSeconds === 8 && take.execution.aspectRatio === "9:16"
    && take.execution.remoteJobId === "11111111-1111-4111-8111-111111111111"
    && take.execution.providerJobId === null,
    "execution：H3 的 modelId 为 null、variant 为 fl2va、时长与画幅取自 ShotRequest、remoteJobId 取自账本");

  ok(take.cost.state === "known" && take.cost.basis === "tariff" && take.cost.settlement === null,
    "cost 直接沿用 parseProductionCost 规范化后的账本事实（非 reported-converted 时 settlement 为 null）");
  ok(take.gates.length === 1 && take.gates[0]!.gate === "qc-approved"
    && take.gates[0]!.system === "wl-qc"
    && take.gates[0]!.approvedBy === "qc:lead"
    && take.gates[0]!.approvedAt === take.approval.decidedAt
    && take.gates[0]!.bindsTo.requestSha256 === take.shotRequest.sha256
    && /^[a-f0-9]{64}$/.test(take.gates[0]!.bindsTo.planSha256),
    "gates 只出账本有据的 qc-approved，bindsTo 绑定单 intent planId 与 ShotRequest digest");
  ok(take.license.summary === "MiniMax H3 Community License; attribution required; "
    + "annual revenue below USD 20000000; no model improvement; status verified"
    && take.license.obligations?.attribution === "MiniMax H3"
    && take.license.obligations.revenueThresholdUsd === 20_000_000
    && take.license.obligations.noModelImprovement === true,
    "license 摘要是 license evidence 的确定性投影，署名对象出现在摘要里供 publish 前检查");
  ok(take.approval.decision === "approved" && take.approval.decidedBy === "qc:lead",
    "approval 形状与账本一致");

  // —— 摘要口径与 VCS importer 一致 ——
  const canonical = videoStudioHandoffCanonicalJson(handoff);
  ok(canonical === pythonCanonicalJson(handoff),
    "规范 JSON 与 importer 的 canonical_json 逐字符相同");
  ok(videoStudioHandoffDigest(handoff) === createHash("sha256").update(canonical, "utf8").digest("hex"),
    "digest 就是规范 JSON 字节的 sha256");
  ok(!canonical.includes("\n") && !canonical.includes(": ") && !canonical.includes(", "),
    "规范 JSON 无空白");
  {
    // 键序判据是 UTF-16 码元序，不是码位序：两侧必须对同一组键给出同一顺序。
    const mixed = { "＀": 1, "\u{1F600}": 2, b: 3, "é": 4 };
    ok(videoStudioHandoffCanonicalJson(mixed) === pythonCanonicalJson(mixed)
      && videoStudioHandoffCanonicalJson(mixed).indexOf("\uD83D") < videoStudioHandoffCanonicalJson(mixed).indexOf("＀"),
      "非 ASCII 与代理对键的排序两侧一致（UTF-16 码元序）");
  }

  // —— 与 VCS importer 的规范字节逐字比对（固定样本） ——
  //
  // 样本覆盖非 ASCII 键、代理对键、控制字符 / U+2028 / U+2029 / DEL 与 +-(2^53-1)。
  // 下面两个常量由 video-creation-studio 的 importer 现算得到（VCS 仓库根执行）：
  //   .venv/bin/python -c "import sys,json,hashlib;
  //     sys.path.insert(0,'skills/video-creation-studio/scripts'); import import_handoff as ih;
  //     c=ih.canonical_json(json.load(open('sample.json')));
  //     print(json.dumps(c)); print(hashlib.sha256(c.encode()).hexdigest())"
  // 改这两个常量之前先在 VCS 侧重算：它们是「两个仓库对同一份文档给出同一串字节」的唯一取证。
  const CANONICAL_SAMPLE_JSON = String.raw`{
    "b": 3,
    "\u00e9": "caf\u00e9 \u884c",
    "\uff00": "u+ff00 key",
    "\ud83d\ude00": [
      "surrogate pair key",
      "line\u2028sep",
      "para\u2029sep"
    ],
    "max": 9007199254740991,
    "min": -9007199254740991,
    "nested": {
      "\t tab key": {
        "z": null,
        "a": true,
        "Z": false
      }
    },
    "ctrl \u0001 del \u007f": "tab\there\nnewline",
    "quote \" backslash \\ slash /": "\u001f unit sep"
  }`;
  const CANONICAL_SAMPLE = JSON.parse(CANONICAL_SAMPLE_JSON) as Record<string, unknown>;
  const PY_CANONICAL_BYTES = "{\"b\":3,\"ctrl \\u0001 del \u007f\":\"tab\\there\\nnewline\",\"max\":9007199254740991,\"min\":-9007199254740991,\"nested\":{\"\\t tab key\":{\"Z\":false,\"a\":true,\"z\":null}},\"quote \\\" backslash \\\\ slash /\":\"\\u001f unit sep\",\"\u00e9\":\"caf\u00e9 \u884c\",\"\ud83d\ude00\":[\"surrogate pair key\",\"line\u2028sep\",\"para\u2029sep\"],\"\uff00\":\"u+ff00 key\"}";
  const PY_CANONICAL_DIGEST = "dafe5f55f7b35b0eec7db79a4884b6dec9932eb445643bc076eec0aa7d126f88";
  ok(videoStudioHandoffCanonicalJson(CANONICAL_SAMPLE) === PY_CANONICAL_BYTES,
    "固定样本的规范字节与 VCS importer 现算结果逐字符相同");
  ok(createHash("sha256").update(videoStudioHandoffCanonicalJson(CANONICAL_SAMPLE), "utf8").digest("hex")
    === PY_CANONICAL_DIGEST,
    "固定样本的 sha256 与 VCS importer 现算结果相同");
  ok(pythonCanonicalJson(CANONICAL_SAMPLE) === PY_CANONICAL_BYTES,
    "本文件里的 Python 规则镜像对同一样本也给出同一串字节");
  ok(errorOf(() => videoStudioHandoffCanonicalJson({ lone: "a\uD800b" })).includes("孤立代理项"),
    "孤立代理项无法产出跨仓库一致的 UTF-8 字节，规范化直接失败");
  ok(errorOf(() => videoStudioHandoffCanonicalJson({ "k\uDC00": 1 })).includes("对象键含孤立代理项"),
    "对象键里的孤立代理项同样失败");

  // —— 内联 schema 副本与 VCS 原文的同步 ——
  {
    const vcsRoot = process.env.WL_VCS_ROOT ?? null;
    if (vcsRoot !== null) {
      const raw = readFileSync(join(vcsRoot, HANDOFF_V2_SCHEMA_RELATIVE), "utf8");
      ok(JSON.stringify(JSON.parse(raw)) === JSON.stringify(HANDOFF_V2_SCHEMA),
        "WL_VCS_ROOT 已设：内联 schema 副本与 VCS 仓库原文逐字段相等");
    } else {
      const inlined = HANDOFF_V2_SCHEMA as Record<string, unknown>;
      ok(/^[a-f0-9]{64}$/.test(HANDOFF_V2_SCHEMA_FILE_SHA256)
        && inlined.$id === "openmontage/handoff/writing-loop-handoff.v2",
        "未设 WL_VCS_ROOT：只核对写入本文件时的 schema 文件 sha256 与 $id（设 WL_VCS_ROOT 做逐字段比对）");
    }
    ok(errorOf(() => validateSchema(
      { $ref: "#/$defs/sha256", minLength: 1 }, "x", HANDOFF_V2_SCHEMA, "$",
    )).includes("未实现的 $ref 同级关键字"),
      "校验器拒绝 $ref 与 description 之外的同级关键字，不默默忽略约束");
  }

  ok(buildVideoStudioHandoffV2(store.read(), create, resolveSource).takes[0]!.gates[0]!.bindsTo.planSha256
    === take.gates[0]!.bindsTo.planSha256,
    "同一账本 + 同一伴生 intent 重复构建得到同一 planSha256（指纹由不可变 intent 重算，不是新造的）");

  // —— create 输入的拒绝面 ——
  ok(errorOf(() => parseVideoStudioHandoffV2Create({ ...create, version: 1 })).includes("version 必须是 2"),
    "v1 交接输入不会被 v2 解析器接受");
  ok(errorOf(() => parseVideoStudioHandoffV2Create({ ...create, pipeline: "cinematic" }))
    .includes("scripted-drama"), "v2 只承载 scripted-drama 流水线");
  ok(errorOf(() => parseVideoStudioHandoffV2Create({ ...create, studioProjectId: "../escape" }))
    .includes("kebab-case"), "Studio project id 拒绝路径穿越");
  ok(errorOf(() => parseVideoStudioHandoffV2Create({ ...create, remoteUrl: "https://studio.example" }))
    .includes("含未知字段"), "create 不接受注入的远程 Studio endpoint");

  // —— builder 的拒绝面 ——
  publishTake("EP001-S1-2", "take-ep001-s1-2", "22222222-2222-4222-8222-222222222222",
    [TAKE_ASSET, urnAsset(SECOND_VIDEO, "video/mp4")]);
  ok(errorOf(() => buildVideoStudioHandoffV2(store.read(), {
    ...create, createdAt: "2026-08-28T00:03:00.000Z", taskIds: ["take-ep001-s1-2"],
  }, resolveSource)).includes("必须恰好有 1 个 role 为 take 的资产"),
    "两个主视频时拒绝导出：importer 要求每个 take 恰好一个 take 角色");
  // ShotRequest 被 inputs[0] 的 digest 钉住，intent 被自身 idempotencyKey 钉住：两条链先各自失败。
  ok(errorOf(() => buildVideoStudioHandoffV2(store.read(), create, (taskId) => {
    const source = resolveSource(taskId);
    const drifted = JSON.parse(JSON.stringify(source.shotRequest)) as Record<string, any>;
    drifted.action = "被改写的动作行";
    return { intent: source.intent, shotRequest: parseShotRequest(drifted) };
  })).includes("ShotRequest 文档与 intent.inputs[0] 的 sha256 不一致"),
    "ShotRequest 与 intent.inputs[0] 漂移时拒绝导出");
  // 自洽但多出一个输入的 intent：idempotencyKey 重算得过，角色表这一层仍然挡住。
  ok(errorOf(() => buildVideoStudioHandoffV2(store.read(), create, (taskId) => {
    const source = resolveSource(taskId);
    const { idempotencyKey: _key, ...draft } = source.intent;
    return {
      intent: createProductionDispatchIntent({
        ...draft, inputs: [...draft.inputs, urnAsset(SECOND_VIDEO, "image/png")],
      }),
      shotRequest: source.shotRequest,
    };
  })).includes("在 ShotRequest continuity 中没有对应 slot"),
    "intent 输入在 ShotRequest continuity 里找不到 slot 时拒绝导出");

  store.create({
    version: 1,
    id: "take-pending",
    idempotencyKey: "idem-take-pending",
    subject: store.read().tasks[0]!.subject,
    createdAt: "2026-08-28T00:04:00.000Z",
  });
  ok(errorOf(() => buildVideoStudioHandoffV2(store.read(), {
    ...create, createdAt: "2026-08-28T00:05:00.000Z", taskIds: ["take-pending"],
  }, resolveSource)).includes("尚未 approved"),
    "未经人工 QC 裁决的 take 不能进交接文档");

  // —— gateway assets 客户端：baseUrl 判据与 bearer ——
  {
    // baseUrl / scope / 区间判据复用 ingest 客户端的同一批函数，因此三种违规都收敛到同一条消息。
    const rule = "不满足 gateway baseUrl 判据";
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "https://gateway.example/", workspaceId: WORKSPACE_ID, project: "demo",
    })).includes(rule), "HTTPS gateway 缺 bearer 时拒绝装配");
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "http://gateway.example/", workspaceId: WORKSPACE_ID, project: "demo",
      transport: "insecure-private-http", credentialResolver: () => "token",
    })).includes(rule), "insecure-private-http 拒绝域名 endpoint（只接受私网字面 IP）");
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "http://127.0.0.1:8790/", workspaceId: WORKSPACE_ID, project: "demo",
      allowInsecureLoopback: true, credentialResolver: () => "token",
    })).includes(rule), "无凭据 loopback 开发形态不接受同时携带 bearer");
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "http://[::1]:8790/", workspaceId: WORKSPACE_ID, project: "demo",
      allowInsecureLoopback: true,
    })) === "", "loopback 判据与 ingest 客户端一致：[::1] 也是字面 loopback");
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "http://127.0.0.1:8790/", workspaceId: WORKSPACE_ID, project: "../escape",
      allowInsecureLoopback: true,
    })).includes("workspaceId / project 不是安全标识符"), "scope 校验复用 ingest 客户端的 parseScope");
    ok(errorOf(() => videoStudioGatewayAssetReader({
      baseUrl: "http://127.0.0.1:8790/", workspaceId: WORKSPACE_ID, project: "demo",
      allowInsecureLoopback: true, timeoutMs: 10,
    })).includes("不在 50–300000 区间"), "timeoutMs 区间复用 ingest 客户端的 boundedInteger");

    let seenAuthorization: string | null = null;
    let seenUrl = "";
    const reader = videoStudioGatewayAssetReader({
      baseUrl: "https://gateway.example/base/",
      workspaceId: WORKSPACE_ID,
      project: "demo",
      credentialResolver: () => "s3cr3t",
      fetch: async (input, init) => {
        seenUrl = String(input);
        seenAuthorization = new Headers(init?.headers as Record<string, string>).get("authorization");
        return new Response(TAKE_VIDEO, { status: 200 });
      },
    });
    const bytes = await reader(TAKE_ASSET);
    ok(Buffer.from(bytes).equals(TAKE_VIDEO)
      && seenAuthorization === "Bearer s3cr3t"
      && seenUrl === `https://gateway.example/base/v1/scopes/${WORKSPACE_ID}/demo/assets/sha256/${TAKE_ASSET.sha256}`,
      "gateway assets GET 走 v1/scopes/<ws>/<project>/assets/sha256/<digest> 并带 bearer");
    ok((await asyncErrorOf(() => reader({ ...TAKE_ASSET, byteLength: TAKE_VIDEO.length + 1 })))
      .includes("AssetRef 声明"), "响应体字节数与 AssetRef 不符时失败，不返回半截内容");
  }

  // —— --export-dir：下载、校验、清理、幂等 ——
  const blobs = new Map<string, Buffer>([
    [FIRST_FRAME_ASSET.sha256, FIRST_FRAME],
    [TAKE_ASSET.sha256, TAKE_VIDEO],
    [LAST_FRAME_ASSET.sha256, LAST_FRAME],
  ]);
  let corruptDigest: string | null = null;
  server = createServer((request, response) => {
    const match = /^\/v1\/scopes\/([^/]+)\/([^/]+)\/assets\/sha256\/([a-f0-9]{64})$/.exec(request.url ?? "");
    if (!match || match[1] !== WORKSPACE_ID || match[2] !== "demo" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    const body = blobs.get(match[3]!);
    if (body === undefined) { response.writeHead(404).end(); return; }
    const payload = match[3] === corruptDigest ? Buffer.alloc(body.length, 0x41) : body;
    response.writeHead(200, { "content-length": String(payload.length), "content-type": "application/octet-stream" });
    response.end(payload);
  });
  const port = await new Promise<number>((resolvePort) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  const gatewayReader = videoStudioGatewayAssetReader({
    baseUrl: `http://127.0.0.1:${port}/`,
    workspaceId: WORKSPACE_ID,
    project: "demo",
    allowInsecureLoopback: true,
  });
  const readAsset = videoStudioWorkspaceAssetReader({
    local: new WorkspaceCasLocalAssetSource({ root, project: "demo", casAuthority: "wl-sg" }),
    gateway: gatewayReader,
  });

  const exportDir = join(root, "export");
  const result = await exportVideoStudioHandoffV2({ handoff, directory: exportDir, readAsset });
  const shotRequestFile = `${take.shotRequest.sha256}.json`;
  const written = readdirSync(exportDir).sort();
  ok(written.join(",") === [
    "handoff.digest", "handoff.json", `${FIRST_FRAME_ASSET.sha256}.png`, `${LAST_FRAME_ASSET.sha256}.png`,
    `${TAKE_ASSET.sha256}.mp4`, shotRequestFile,
  ].sort().join(","), `导出目录按 <sha256>.<ext> 落盘全部资产（实得 ${written.join(",")}）`);
  ok(readFileSync(join(exportDir, "handoff.json"), "utf8") === canonical
    && readFileSync(join(exportDir, "handoff.digest"), "utf8") === `${result.digest}\n`
    && result.digest === videoStudioHandoffDigest(handoff),
    "handoff.json 是规范 JSON 字节，handoff.digest 是它的 sha256（供 --expect-digest 比对）");
  ok(digestOf(readFileSync(join(exportDir, `${TAKE_ASSET.sha256}.mp4`))) === TAKE_ASSET.sha256
    && digestOf(readFileSync(join(exportDir, `${FIRST_FRAME_ASSET.sha256}.png`))) === FIRST_FRAME_ASSET.sha256
    && digestOf(readFileSync(join(exportDir, shotRequestFile))) === take.shotRequest.sha256,
    "每个资产文件的内容 digest 与文件名一致（ShotRequest 走本机 CAS，其余走 gateway）");

  const fingerprint = (dir: string): string => readdirSync(dir).sort()
    .map((name) => `${name}:${digestOf(readFileSync(join(dir, name)))}:${statSync(join(dir, name)).mtimeMs}`)
    .join("|");
  const before = fingerprint(exportDir);
  const replay = await exportVideoStudioHandoffV2({ handoff, directory: exportDir, readAsset });
  ok(before === fingerprint(exportDir) && replay.digest === result.digest,
    "重复导出到同一目录判定为幂等重放：内容与 mtime 都没动过（一个字节都没写）");


  {
    // 目标目录非空且与本次导出不一致时拒绝：逐文件覆盖既不原子，回滚又会删掉目录里本来就有的东西。
    const target = join(root, "export-occupied");
    await exportVideoStudioHandoffV2({ handoff, directory: target, readAsset });
    const strayPath = join(target, "operator-note.txt");
    const strayBody = "操作者手工放进来的文件，不该被导出命令动到";
    writeFileSync(strayPath, strayBody);
    const occupied = fingerprint(target);
    const message = await asyncErrorOf(() =>
      exportVideoStudioHandoffV2({ handoff, directory: target, readAsset }));
    ok(message.includes("已有内容") && fingerprint(target) === occupied
      && readFileSync(strayPath, "utf8") === strayBody,
      `目标目录多出一个文件即拒绝导出，且旧文件逐字节原样（实得 ${message.slice(0, 40)}）`);

    // 同名但内容不同也算不一致：不能让一份被改过的 handoff.json 混过 --expect-digest。
    const drifted = join(root, "export-drifted");
    await exportVideoStudioHandoffV2({ handoff, directory: drifted, readAsset });
    writeFileSync(join(drifted, "handoff.json"), "{}");
    const driftedPrint = fingerprint(drifted);
    const driftedMessage = await asyncErrorOf(() =>
      exportVideoStudioHandoffV2({ handoff, directory: drifted, readAsset }));
    ok(driftedMessage.includes("已有内容") && fingerprint(drifted) === driftedPrint
      && readFileSync(join(drifted, "handoff.json"), "utf8") === "{}",
      "同名文件内容不同同样拒绝，被改过的 handoff.json 不会被静默覆盖");

    // 空目录按「目标不存在」处理：整个临时目录一次 rename 到位。
    const emptyTarget = join(root, "export-empty");
    mkdirSync(emptyTarget);
    const intoEmpty = await exportVideoStudioHandoffV2({ handoff, directory: emptyTarget, readAsset });
    ok(intoEmpty.digest === result.digest
      && readdirSync(emptyTarget).sort().join(",") === written.join(","),
      "已存在的空目录按整目录 rename 落位");
  }

  {
    // 扩展名表是 importer EXTENSIONS_BY_MEDIA_TYPE 的子集；表外的 mediaType 在导出侧就拒绝。
    // 下面这份表逐字抄自 skills/video-creation-studio/scripts/import_handoff.py。
    const IMPORTER_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
      "video/mp4": ["mp4"],
      "video/quicktime": ["mov"],
      "video/webm": ["webm"],
      "image/png": ["png"],
      "image/jpeg": ["jpg", "jpeg"],
      "image/webp": ["webp"],
      "audio/mpeg": ["mp3"],
      "audio/wav": ["wav"],
      "audio/mp4": ["m4a"],
      "application/vnd.writing-loop.shot-request+json": ["json"],
    };
    const entries = Object.entries(VIDEO_STUDIO_ASSET_FILE_EXTENSIONS);
    ok(entries.length === 4
      && entries.every(([mediaType, extension]) =>
        (IMPORTER_EXTENSIONS[mediaType] ?? []).includes(extension)),
      `导出扩展名表是 importer EXTENSIONS_BY_MEDIA_TYPE 的子集（实得 ${JSON.stringify(entries)}）`);

    const webp = JSON.parse(JSON.stringify(handoff)) as VideoStudioHandoffV2;
    webp.takes[0]!.assets[0] = { ...webp.takes[0]!.assets[0]!, mediaType: "image/webp" };
    const message = await asyncErrorOf(() => exportVideoStudioHandoffV2({
      handoff: webp, directory: join(root, "export-webp"), readAsset,
    }));
    ok(message.includes("不在导出扩展名表内") && !existsSync(join(root, "export-webp")),
      "表外 mediaType（importer 认得但本版不产出）在导出侧就拒绝并说明");
  }

  {
    corruptDigest = TAKE_ASSET.sha256;
    const target = join(root, "export-corrupt");
    const message = await asyncErrorOf(() =>
      exportVideoStudioHandoffV2({ handoff, directory: target, readAsset }));
    corruptDigest = null;
    const leftovers = readdirSync(root).filter((name) => name.startsWith(".export-corrupt"));
    ok(message.includes("取回内容 digest") && !existsSync(target) && leftovers.length === 0,
      `资产 digest 不符时整次导出失败并清理临时目录（实得 ${message.slice(0, 60)}）`);
  }

  // —— CLI ——
  // 账本在上面的拒绝面用例里又推进了若干 revision，因此 CLI 用一份更晚的 createdAt 重新交接：
  // createdAt 不得早于所绑定 productionRevision 的 updatedAt。
  const cliCreate = { ...create, createdAt: "2026-08-28T00:10:00.000Z" };
  const cliDigest = videoStudioHandoffDigest(buildVideoStudioHandoffV2(store.read(), cliCreate, resolveSource));
  const inputFile = join(root, "handoff-input.json");
  writeFileSync(inputFile, JSON.stringify(cliCreate, null, 2) + "\n");
  const runtime = JSON.parse(readFileSync(
    join(import.meta.dirname, "..", "examples", "production", "representative-h3", "production-runtime.json"),
    "utf8",
  )) as Record<string, any>;
  const configFile = join(root, "production-runtime.json");
  writeFileSync(configFile, JSON.stringify({
    ...runtime,
    workspaceId: WORKSPACE_ID,
    projects: [{ ...runtime.projects[0], project: "demo" }],
    workflows: [{ ...runtime.workflows[0], projects: ["demo"] }],
    gateway: { version: 1, baseUrl: `http://127.0.0.1:${port}/`, credentialEnv: null, transport: "tls" },
    executionProfileSnapshotFile: null,
  }, null, 2) + "\n");
  chmodSync(configFile, 0o600);

  const capture = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
    try { return { code: await productionMain(args, root), out: out.join("\n"), err: err.join("\n") }; }
    finally { console.log = oldLog; console.error = oldError; }
  };

  const stdoutOnly = await capture(["handoff", "--project", "demo", "--input", inputFile]);
  if (stdoutOnly.code !== 0) throw new Error(`handoff 缺省输出失败：${stdoutOnly.err}`);
  const payload = JSON.parse(stdoutOnly.out) as { version: number; digest: string; handoff: VideoStudioHandoffV2 };
  ok(stdoutOnly.code === 0 && payload.version === 2 && payload.digest === cliDigest
    && schemaErrors(payload.handoff).length === 0,
    "handoff 缺省输出 v2 交接文档，digest 与同一账本重算的结果一致");

  const cliDir = join(root, "cli-export");
  const exported = await capture([
    "handoff", "--project", "demo", "--input", inputFile, "--export-dir", cliDir, "--config", configFile, "--json",
  ]);
  const report = JSON.parse(exported.out) as { digest: string; directory: string; files: Array<{ name: string }> };
  ok(exported.code === 0 && report.digest === cliDigest
    && readdirSync(cliDir).sort().join(",") === written.join(",")
    && report.files.length === written.length,
    "CLI --export-dir 写出同一份交接文档与资产目录");
  const humanExport = await capture([
    "handoff", "--project", "demo", "--input", inputFile, "--export-dir", cliDir, "--config", configFile,
  ]);
  ok(humanExport.code === 0
    && humanExport.out.includes(`import-handoff ${cliCreate.studioProjectId}`)
    && humanExport.out.includes(`--assets-dir ${cliDir}`)
    && humanExport.out.includes(`--expect-digest ${cliDigest}`),
    "非 --json 输出直接给出 VCS 侧可执行的 import-handoff 命令");

  const wrongWorkspace = join(root, "runtime-wrong-ws.json");
  writeFileSync(wrongWorkspace, readFileSync(configFile, "utf8").replace(WORKSPACE_ID, `ws_${"b".repeat(32)}`));
  chmodSync(wrongWorkspace, 0o600);
  const mismatched = await capture([
    "handoff", "--project", "demo", "--input", inputFile,
    "--export-dir", join(root, "cli-export-2"), "--config", wrongWorkspace,
  ]);
  ok(mismatched.code === 1 && mismatched.err.includes("workspaceId 与本 workspace 身份不一致"),
    "runtime config 的 workspaceId 与本 workspace 不一致时拒绝导出");
} finally {
  if (server !== null) await new Promise<void>((done) => server!.close(() => done()));
  rmSync(root, { recursive: true, force: true });
}

if (fails) {
  console.error(`PRODUCTION_STUDIO_HANDOFF_V2_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_STUDIO_HANDOFF_V2_OK");
