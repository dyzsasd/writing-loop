// Provider-neutral, immutable handoff for an agent-driven video creation studio.
//
// Citronetic/video-creation-studio currently exposes persisted project artifacts and a read-only
// Backlot observer, not a durable remote execution API.  This manifest is therefore an explicit
// handoff boundary: it never claims that exporting JSON started or completed a Studio production.
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  compareProductionAscii,
  parseAssetRef,
  parseProductionState,
  type AssetRef,
  type ProductionApproval,
  type ProductionCost,
  type ProductionState,
  type ProductionTask,
  type ShotRevisionRef,
} from "./production-domain.ts";
import { planProductionTaskEnqueue } from "./production-enqueue.ts";
import {
  ProductionIngestorError,
  authorizationToken,
  boundedInteger,
  parseScope,
  raceAbort,
  trustedBaseUrl,
  type ProductionIngestorTransport,
} from "./production-ingestor.ts";
import { ProductionLocalAssetSourceError, type ProductionLocalAssetSource } from "./production-local-asset-source.ts";
import { SHOT_REQUEST_MEDIA_TYPE, shotRequestSha256 } from "./production-shot-request.ts";
import type { FetchLike } from "./production-adapter.ts";
import type { ShotRequest } from "./production-shot-request.ts";
import type {
  ProductionDispatchIntent,
  ProductionIntentExecution,
  ProductionIntentOperation,
  ProductionLicenseEvidence,
  ProductionModelFamily,
} from "./production-intent.ts";

export const VIDEO_STUDIO_HANDOFF_CONTRACT = "citronetic-video-creation-studio-codex-handoff-v1" as const;
export const VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM = "sha256:writing-loop-canonical-json-v1" as const;
export const VIDEO_STUDIO_PIPELINES = ["cinematic", "character-animation", "animation", "hybrid"] as const;
export type VideoStudioPipeline = typeof VIDEO_STUDIO_PIPELINES[number];

export type VideoStudioDelivery = {
  version: 1;
  aspectRatio: "9:16" | "16:9" | "1:1";
  width: number;
  height: number;
  fps: 24 | 25 | 30;
  container: "video/mp4";
  language: string;
};

export type VideoStudioHandoffTake = {
  version: 1;
  taskId: string;
  shot: ShotRevisionRef;
  assets: AssetRef[];
  approval: ProductionApproval;
};

export type VideoStudioHandoff = {
  version: 1;
  contract: typeof VIDEO_STUDIO_HANDOFF_CONTRACT;
  handoffId: string;
  studioProjectId: string;
  workspaceId: string;
  project: string;
  productionRevision: number;
  pipeline: VideoStudioPipeline;
  createdAt: string;
  delivery: VideoStudioDelivery;
  takes: VideoStudioHandoffTake[];
  /** This upstream is agent-orchestrated; import is not proof of execution or approval. */
  requiresAgentOrchestration: true;
};

export type VideoStudioHandoffCreate = {
  version: 1;
  handoffId: string;
  studioProjectId: string;
  pipeline: VideoStudioPipeline;
  createdAt: string;
  delivery: VideoStudioDelivery;
  taskIds: string[];
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STUDIO_PROJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGE = /^[A-Za-z][A-Za-z0-9-]{0,34}$/;
const PIPELINES = new Set<string>(VIDEO_STUDIO_PIPELINES);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new Error(`${subject} ${detail}`);
}

function exact(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const extras = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (extras.length) fail(subject, `含未知字段 ${extras.join(",")}`);
  if (missing.length) fail(subject, `缺少字段 ${missing.join(",")}`);
}

function id(value: unknown, subject: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(subject, "标识符无效");
  return value;
}

function iso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "时间无效");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(subject, "必须是规范 UTC ISO 时间");
  return value;
}

export function parseVideoStudioDelivery(value: unknown, subject = "VideoStudioDelivery"): VideoStudioDelivery {
  if (!object(value)) fail(subject, "必须是对象");
  exact(value, ["version", "aspectRatio", "width", "height", "fps", "container", "language"], subject);
  if (value.version !== 1) fail(subject, "version 必须是 1");
  if (!["9:16", "16:9", "1:1"].includes(String(value.aspectRatio))) fail(subject, "aspectRatio 无效");
  if (!Number.isSafeInteger(value.width) || (value.width as number) < 256 || (value.width as number) > 7_680
    || !Number.isSafeInteger(value.height) || (value.height as number) < 256 || (value.height as number) > 7_680) {
    fail(subject, "width/height 必须在 256–7680");
  }
  const width = value.width as number;
  const height = value.height as number;
  if ((value.aspectRatio === "9:16" && width * 16 !== height * 9)
    || (value.aspectRatio === "16:9" && width * 9 !== height * 16)
    || (value.aspectRatio === "1:1" && width !== height)) {
    fail(subject, "width/height 与 aspectRatio 不一致");
  }
  if (![24, 25, 30].includes(value.fps as number)) fail(subject, "fps 必须是 24、25 或 30");
  if (value.container !== "video/mp4") fail(subject, "v1 只支持 video/mp4");
  if (typeof value.language !== "string" || !LANGUAGE.test(value.language)) fail(subject, "language 必须是稳定 BCP-47 风格标签");
  return {
    version: 1,
    aspectRatio: value.aspectRatio as VideoStudioDelivery["aspectRatio"],
    width,
    height,
    fps: value.fps as VideoStudioDelivery["fps"],
    container: "video/mp4",
    language: value.language,
  };
}

export function parseVideoStudioHandoffCreate(value: unknown): VideoStudioHandoffCreate {
  if (!object(value)) fail("VideoStudioHandoffCreate", "必须是对象");
  exact(value, ["version", "handoffId", "studioProjectId", "pipeline", "createdAt", "delivery", "taskIds"], "VideoStudioHandoffCreate");
  if (value.version !== 1) fail("VideoStudioHandoffCreate", "version 必须是 1");
  if (typeof value.studioProjectId !== "string" || value.studioProjectId.length > 80
    || !STUDIO_PROJECT.test(value.studioProjectId)) {
    fail("VideoStudioHandoffCreate.studioProjectId", "必须是最多 80 位 kebab-case");
  }
  if (typeof value.pipeline !== "string" || !PIPELINES.has(value.pipeline)) {
    fail("VideoStudioHandoffCreate.pipeline", "不是允许的 Studio pipeline");
  }
  if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 2_048) {
    fail("VideoStudioHandoffCreate.taskIds", "必须是 1–2048 项数组");
  }
  const taskIds = value.taskIds.map((item, index) => id(item, `VideoStudioHandoffCreate.taskIds[${index}]`));
  if (new Set(taskIds).size !== taskIds.length) fail("VideoStudioHandoffCreate.taskIds", "不得重复");
  return {
    version: 1,
    handoffId: id(value.handoffId, "VideoStudioHandoffCreate.handoffId"),
    studioProjectId: value.studioProjectId,
    pipeline: value.pipeline as VideoStudioPipeline,
    createdAt: iso(value.createdAt, "VideoStudioHandoffCreate.createdAt"),
    delivery: parseVideoStudioDelivery(value.delivery),
    taskIds,
  };
}

/** Build a deterministic, provenance-bound bundle from already approved shot takes only. */
export function buildVideoStudioHandoff(stateValue: ProductionState, createValue: unknown): VideoStudioHandoff {
  const state = parseProductionState(stateValue);
  const create = parseVideoStudioHandoffCreate(createValue);
  if (state.updatedAt !== null && create.createdAt < state.updatedAt) {
    fail("VideoStudioHandoff.createdAt", "不得早于所绑定 productionRevision 的 updatedAt");
  }
  const tasks = create.taskIds.map((taskId) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) fail("VideoStudioHandoff", `task ${taskId} 不存在`);
    if (task.subject.kind !== "shot") fail("VideoStudioHandoff", `task ${taskId} 不是 shot take`);
    if (task.status !== "approved" || task.approval?.decision !== "approved") {
      fail("VideoStudioHandoff", `task ${taskId} 尚未 approved`);
    }
    if (!task.assets.length) fail("VideoStudioHandoff", `task ${taskId} 没有已 ingest 资产`);
    return task;
  });
  const firstEpisode = tasks[0]!.subject.kind === "shot" ? tasks[0]!.subject.shot.episode : null;
  for (const task of tasks) {
    const episode = task.subject.kind === "shot" ? task.subject.shot.episode : null;
    if (!episode || !firstEpisode || episode.episodeId !== firstEpisode.episodeId
      || episode.revision !== firstEpisode.revision || episode.source.sha256 !== firstEpisode.source.sha256) {
      fail("VideoStudioHandoff", "所有 take 必须绑定同一 episode revision");
    }
  }
  const takes: VideoStudioHandoffTake[] = tasks.map((task) => ({
    version: 1 as const,
    taskId: task.id,
    shot: task.subject.kind === "shot" ? task.subject.shot : fail("VideoStudioHandoff", "expected shot"),
    assets: task.assets.map((item) => parseAssetRef(item)),
    approval: task.approval!,
  })).sort((left, right) =>
    compareProductionAscii(left.shot.shotId, right.shot.shotId)
      || compareProductionAscii(left.taskId, right.taskId));
  const shotIds = takes.map((take) => take.shot.shotId);
  if (new Set(shotIds).size !== shotIds.length) fail("VideoStudioHandoff", "同一 handoff 不得含重复 shotId");
  return {
    version: 1,
    contract: VIDEO_STUDIO_HANDOFF_CONTRACT,
    handoffId: create.handoffId,
    studioProjectId: create.studioProjectId,
    workspaceId: state.workspaceId,
    project: state.project,
    productionRevision: state.revision,
    pipeline: create.pipeline,
    createdAt: create.createdAt,
    delivery: create.delivery,
    takes,
    requiresAgentOrchestration: true,
  };
}

/**
 * `String.prototype.isWellFormed()` 的判据，手写成正则是因为 tsconfig 的 lib 钉在 es2023——
 * package.json 的 engines 允许 node 20.11，而 es2024 的 lib 会一并放行 20.11 上并不存在的 API。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const wellFormed = (value: string): boolean => !LONE_SURROGATE.test(value);

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) fail("VideoStudioHandoff digest", "对象嵌套超过 64 层");
  if (value === null) return "null";
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    // 孤立代理项无法以 UTF-8 编码：JS 会把它替换成 U+FFFD，Python 侧则直接报错，两端的规范字节
    // 因此不可能相等。与其产出一份对不上摘要的文档，不如在这里失败。
    if (!wellFormed(value)) fail("VideoStudioHandoff digest", "字符串含孤立代理项，无法产出跨仓库一致的 UTF-8 规范字节");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("VideoStudioHandoff digest", "只接受安全整数");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (!object(value)) fail("VideoStudioHandoff digest", "只接受 JSON 值");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("VideoStudioHandoff digest", "只接受 plain JSON object");
  }
  return `{${Object.keys(value).sort().map((key) => {
    if (!wellFormed(key)) fail("VideoStudioHandoff digest", "对象键含孤立代理项");
    return `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`;
  }).join(",")}}`;
}

/**
 * Cross-repository canonical bytes: UTF-8 JSON, array order preserved, object keys sorted by
 * JavaScript/Unicode code-unit order, safe integers only, no whitespace or toJSON hooks.
 */
export function videoStudioHandoffCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

export function videoStudioHandoffDigest(value: unknown): string {
  return createHash("sha256").update(videoStudioHandoffCanonicalJson(value), "utf8").digest("hex");
}

// ——— v2：scripted-drama 交接契约（§4.8、§8.3） ———
//
// v2 与 v1 是两份并存的契约：v1 承载 cinematic / character-animation / animation / hybrid 四条
// 流水线，字段只到 take 的 assets 与 approval；v2 只承载 scripted-drama，逐 take 另带 ShotRequest、
// execution 摘要、cost、assetRoles、gates 与 license 摘要，字段名与 video-creation-studio 的
// `schemas/handoff/writing-loop-handoff.v2.schema.json` 逐字对齐（该 schema 的
// `additionalProperties: false` 使任何多余字段在导入侧即被拒绝）。
//
// JSON Schema 表达不了的四条约束由本 builder 强制：同一 episode revision、shotId 唯一、
// assetRoles 与 assets 一一覆盖、每个 take 恰好一个 role 为 take 的资产。

export const VIDEO_STUDIO_HANDOFF_CONTRACT_V2 = "citronetic-video-creation-studio-codex-handoff-v2" as const;
export const VIDEO_STUDIO_HANDOFF_V2_PIPELINE = "scripted-drama" as const;

/**
 * 本版只出账本能取证的 `qc-approved`：批次审批指纹与样片门都不落账本，凭空写出另外两个门等于
 * 伪造预授权记录。另外两个值保留在词表里，等 `plan-shots --confirm` 把 batchPlanId 持久化后再出。
 */
export const VIDEO_STUDIO_GATES = ["qc-approved", "batch-approved", "sample-approved"] as const;
export type VideoStudioGate = typeof VIDEO_STUDIO_GATES[number];

/**
 * 导出文件名的扩展名表。它是 importer 的 `EXTENSIONS_BY_MEDIA_TYPE`
 * （`skills/video-creation-studio/scripts/import_handoff.py`）的**子集**，且只收本版实际会产出的
 * 四种类型：H3 的主视频、ffmpeg 派生的尾帧、操作者上传/候选图的首帧与参考图、ShotRequest 文档。
 * 表外的 mediaType 一律拒绝导出——写出一个 importer 认不出的扩展名，等于把失败推迟到导入侧。
 */
export const VIDEO_STUDIO_ASSET_FILE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "application/vnd.writing-loop.shot-request+json": "json",
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
});

export type VideoStudioAssetRoleEntry = { sha256: string; role: string };

export type VideoStudioTakeExecution = {
  version: 1;
  operation: ProductionIntentOperation;
  modelFamily: ProductionModelFamily;
  backendInstanceId: string;
  workflowSha256: string;
  modelSha256: string;
  parametersSha256: string;
  /** 云家族的 modelId；H3 以 profile 表达，填 null。 */
  modelId: string | null;
  /** H3 的 fl2va / ref2va；其他家族填 null。 */
  variant: string | null;
  durationSeconds: number;
  aspectRatio: string;
  remoteJobId: string;
  /** 本地账本不记录 provider 侧的第二个作业 ID（gateway 概念），恒为 null。 */
  providerJobId: string | null;
};

export type VideoStudioGateRecord = {
  version: 1;
  gate: VideoStudioGate;
  bindsTo: { planSha256: string; requestSha256: string };
  approvedBy: string;
  approvedAt: string;
  system: string;
};

export type VideoStudioTakeLicense = {
  version: 1;
  summary: string;
  status: "verified" | "unknown" | "blocked";
  basis: "community" | "provider-terms" | "written-license";
  territories: string[];
  obligations: {
    attribution: string | null;
    revenueThresholdUsd: number | null;
    noModelImprovement: boolean;
  } | null;
};

export type VideoStudioHandoffV2Take = {
  version: 1;
  taskId: string;
  shot: ShotRevisionRef;
  /** 本镜不可变 ShotRequest；导出目录里以 `<sha256>.json` 出现。 */
  shotRequest: AssetRef;
  assets: AssetRef[];
  assetRoles: VideoStudioAssetRoleEntry[];
  execution: VideoStudioTakeExecution;
  cost: ProductionCost;
  gates: VideoStudioGateRecord[];
  license: VideoStudioTakeLicense;
  approval: ProductionApproval;
};

export type VideoStudioHandoffV2 = {
  version: 2;
  contract: typeof VIDEO_STUDIO_HANDOFF_CONTRACT_V2;
  handoffId: string;
  studioProjectId: string;
  workspaceId: string;
  project: string;
  productionRevision: number;
  pipeline: typeof VIDEO_STUDIO_HANDOFF_V2_PIPELINE;
  createdAt: string;
  delivery: VideoStudioDelivery;
  takes: VideoStudioHandoffV2Take[];
  /** This upstream is agent-orchestrated; import is not proof of execution or approval. */
  requiresAgentOrchestration: true;
};

export type VideoStudioHandoffV2Create = {
  version: 2;
  handoffId: string;
  studioProjectId: string;
  pipeline: typeof VIDEO_STUDIO_HANDOFF_V2_PIPELINE;
  createdAt: string;
  delivery: VideoStudioDelivery;
  taskIds: string[];
};

/**
 * 逐 take 的不可变伴生事实：immutable intent（execution / license / inputs）与它的 `inputs[0]`
 * 所指的 ShotRequest。两者都是账本外的不可变文件，由调用方按 taskId 取回后交给 builder；builder
 * 自己不做任何 I/O，因此同一份账本 + 同一批伴生文件必然产出同一份交接文档。
 */
export type VideoStudioHandoffTakeSource = {
  intent: ProductionDispatchIntent;
  shotRequest: ShotRequest;
};

export type VideoStudioHandoffSourceResolver = (taskId: string) => VideoStudioHandoffTakeSource;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const TERRITORY = /^[A-Z]{2}$/;
const REFERENCE_PURPOSE = /^[a-z][a-z0-9-]{0,63}$/;
const V2_PIPELINES = new Set<string>([VIDEO_STUDIO_HANDOFF_V2_PIPELINE]);

const LICENSE_BASIS_LABEL: Readonly<Record<ProductionLicenseEvidence["basis"], string>> = Object.freeze({
  community: "Community License",
  "provider-terms": "Provider Terms",
  "written-license": "Written License",
});

function sha256Hex(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(subject, "必须是 64 位小写 sha256");
  return value;
}

function opaque(value: unknown, subject: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail(subject, `必须是 1–${maximum} 字符的非空字符串`);
  }
  return value;
}

export function parseVideoStudioHandoffV2Create(value: unknown): VideoStudioHandoffV2Create {
  const subject = "VideoStudioHandoffV2Create";
  if (!object(value)) fail(subject, "必须是对象");
  exact(value, ["version", "handoffId", "studioProjectId", "pipeline", "createdAt", "delivery", "taskIds"], subject);
  if (value.version !== 2) fail(subject, "version 必须是 2（旧四流水线请加 --contract v1）");
  if (typeof value.studioProjectId !== "string" || value.studioProjectId.length > 80
    || !STUDIO_PROJECT.test(value.studioProjectId)) {
    fail(`${subject}.studioProjectId`, "必须是最多 80 位 kebab-case");
  }
  if (typeof value.pipeline !== "string" || !V2_PIPELINES.has(value.pipeline)) {
    fail(`${subject}.pipeline`, `v2 只承载 ${VIDEO_STUDIO_HANDOFF_V2_PIPELINE} 流水线`);
  }
  if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 2_048) {
    fail(`${subject}.taskIds`, "必须是 1–2048 项数组");
  }
  const taskIds = value.taskIds.map((item, index) => id(item, `${subject}.taskIds[${index}]`));
  if (new Set(taskIds).size !== taskIds.length) fail(`${subject}.taskIds`, "不得重复");
  return {
    version: 2,
    handoffId: id(value.handoffId, `${subject}.handoffId`),
    studioProjectId: value.studioProjectId,
    pipeline: VIDEO_STUDIO_HANDOFF_V2_PIPELINE,
    createdAt: iso(value.createdAt, `${subject}.createdAt`),
    delivery: parseVideoStudioDelivery(value.delivery, `${subject}.delivery`),
    taskIds,
  };
}

/**
 * 许可摘要（写入 VCS 的 `asset_manifest.assets[].license`）。它逐字段由不可变 license evidence
 * 推出——摘要不是第二处事实，只是 evidence 的确定性投影，因此同一 intent 永远得到同一句话。
 * H3 社区许可得到 `MiniMax H3 Community License; attribution required; …`，publish 前的署名检查
 * 因此能在这句话里读到必须署名的对象。
 */
function licenseSummary(license: ProductionLicenseEvidence, subject: string): string {
  const obligations = license.obligations ?? null;
  const name = obligations?.attribution ?? license.issuedBy ?? "unspecified issuer";
  const parts = [`${name} ${LICENSE_BASIS_LABEL[license.basis]}`];
  if (obligations !== null && obligations.attribution !== null) parts.push("attribution required");
  if (obligations !== null && obligations.revenueThresholdUsd !== null) {
    parts.push(`annual revenue below USD ${obligations.revenueThresholdUsd}`);
  }
  if (obligations !== null && obligations.noModelImprovement) parts.push("no model improvement");
  parts.push(`status ${license.status}`);
  const summary = parts.join("; ");
  if (summary.length > 512) fail(subject, "许可摘要超过 512 字符上限");
  return summary;
}

function takeLicense(license: ProductionLicenseEvidence, subject: string): VideoStudioTakeLicense {
  for (const [index, territory] of license.territories.entries()) {
    if (!TERRITORY.test(territory)) fail(`${subject}.territories[${index}]`, "必须是两位大写地域码");
  }
  if (license.territories.length > 256) fail(`${subject}.territories`, "超过 256 项上限");
  const obligations = license.obligations ?? null;
  return {
    version: 1,
    summary: licenseSummary(license, subject),
    status: license.status,
    basis: license.basis,
    territories: [...license.territories],
    obligations: obligations === null ? null : {
      attribution: obligations.attribution,
      revenueThresholdUsd: obligations.revenueThresholdUsd,
      noModelImprovement: obligations.noModelImprovement,
    },
  };
}

/**
 * execution 摘要。逐镜变量（时长、画幅）的唯一事实来源是 ShotRequest（§4.2 修正 F1）；execution
 * 分支自带同名静态字段时两者必须一致，不一致说明 intent 与 ShotRequest 已经漂移，拒绝导出。
 */
function takeExecution(
  execution: ProductionIntentExecution,
  shotRequest: ShotRequest,
  remoteJobId: string | null,
  subject: string,
): VideoStudioTakeExecution {
  const durationSeconds = shotRequest.output.durationSeconds;
  const aspectRatio = shotRequest.output.aspectRatio;
  let modelId: string | null = null;
  let variant: string | null = null;
  if (execution.modelFamily === "minimax-h3") {
    variant = execution.variant;
    if (execution.durationSeconds !== durationSeconds) {
      fail(subject, `execution.durationSeconds ${execution.durationSeconds} 与 ShotRequest 的 ${durationSeconds} 不一致`);
    }
    if (execution.aspectRatio !== aspectRatio) {
      fail(subject, `execution.aspectRatio ${execution.aspectRatio} 与 ShotRequest 的 ${aspectRatio} 不一致`);
    }
  } else if (execution.modelFamily === "seedance" || execution.modelFamily === "veo") {
    modelId = execution.modelId;
    if (execution.aspectRatio !== aspectRatio) {
      fail(subject, `execution.aspectRatio ${execution.aspectRatio} 与 ShotRequest 的 ${aspectRatio} 不一致`);
    }
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) {
    fail(subject, "durationSeconds 必须是 1–600 的整数");
  }
  if (aspectRatio.length > 16) fail(subject, "aspectRatio 超过 16 字符上限");
  if (remoteJobId === null) fail(subject, "已 approved 的 take 必须带 remoteJobId");
  return {
    version: 1,
    operation: execution.operation,
    modelFamily: execution.modelFamily,
    backendInstanceId: opaque(execution.backendInstanceId, `${subject}.backendInstanceId`),
    workflowSha256: sha256Hex(execution.workflowSha256, `${subject}.workflowSha256`),
    modelSha256: sha256Hex(execution.modelSha256, `${subject}.modelSha256`),
    parametersSha256: sha256Hex(execution.parametersSha256, `${subject}.parametersSha256`),
    modelId,
    variant,
    durationSeconds,
    aspectRatio,
    remoteJobId: id(remoteJobId, `${subject}.remoteJobId`),
    providerJobId: null,
  };
}

/**
 * 角色表。产物侧按 mediaType 判定（唯一主视频是 take，派生的静帧是 last-frame，与 ingest 内核的
 * 尾帧派生一一对应）；输入侧按 sha256 与 ShotRequest 的 `continuity` 匹配（§4.2 的 slot 判定同一判据）。
 * 两侧必须恰好互相覆盖：多出的输入、对不上的 continuity 项、不是恰好一个 take，都拒绝导出。
 */
function takeAssets(
  task: ProductionTask,
  intent: ProductionDispatchIntent,
  shotRequest: ShotRequest,
  subject: string,
): { assets: AssetRef[]; assetRoles: VideoStudioAssetRoleEntry[] } {
  const roleByDigest = new Map<string, string>();
  const assets: AssetRef[] = [];
  const assign = (asset: AssetRef, role: string): void => {
    if (roleByDigest.has(asset.sha256)) {
      fail(subject, `资产 ${asset.sha256} 同时承担 ${roleByDigest.get(asset.sha256)} 与 ${role} 两个角色`);
    }
    roleByDigest.set(asset.sha256, role);
    assets.push(asset);
  };

  let takes = 0;
  let lastFrames = 0;
  for (const asset of task.assets) {
    const parsed = parseAssetRef(asset, `${subject}.assets`);
    if (parsed.mediaType.startsWith("video/")) { takes++; assign(parsed, "take"); }
    else if (parsed.mediaType.startsWith("image/")) { lastFrames++; assign(parsed, "last-frame"); }
    else fail(subject, `ingest 产物 ${parsed.mediaType} 既不是视频也不是图像，无法判定角色`);
  }
  if (takes !== 1) fail(subject, `必须恰好有 1 个 role 为 take 的资产，实际 ${takes} 个`);
  if (lastFrames > 1) fail(subject, `最多 1 个尾帧，实际 ${lastFrames} 个`);

  const continuity = shotRequest.continuity;
  const inputRoles = new Map<string, string>();
  if (continuity.firstFrame !== null) inputRoles.set(continuity.firstFrame.asset.sha256, "keyframe-first");
  if (continuity.lastFrame !== null) inputRoles.set(continuity.lastFrame.asset.sha256, "keyframe-last");
  for (const reference of continuity.references) {
    if (!REFERENCE_PURPOSE.test(reference.purpose)) {
      fail(subject, `参考用途 ${reference.purpose} 不是可写入 assetRole 的小写标识`);
    }
    if (inputRoles.has(reference.asset.sha256)) {
      fail(subject, `输入资产 ${reference.asset.sha256} 在 ShotRequest 中出现多次`);
    }
    inputRoles.set(reference.asset.sha256, `reference:${reference.purpose}`);
  }

  // inputs[0] 是 ShotRequest 自身，单独作为 take.shotRequest 出现，不进 assets[]。
  for (const [index, input] of intent.inputs.slice(1).entries()) {
    const role = inputRoles.get(input.sha256);
    if (role === undefined) {
      fail(subject, `intent.inputs[${index + 1}] (${input.sha256}) 在 ShotRequest continuity 中没有对应 slot`);
    }
    inputRoles.delete(input.sha256);
    assign(input, role);
  }
  if (inputRoles.size > 0) {
    fail(subject, `ShotRequest continuity 的 ${[...inputRoles.keys()].join("、")} 未出现在 intent.inputs`);
  }
  if (assets.length < 1 || assets.length > 64) fail(subject, "assets 必须是 1–64 项");
  return {
    assets,
    assetRoles: assets.map((asset) => ({ sha256: asset.sha256, role: roleByDigest.get(asset.sha256)! })),
  };
}

/** 从已批准 take 构建确定性、带来源约束的 scripted-drama 交接包（§4.8）。 */
export function buildVideoStudioHandoffV2(
  stateValue: ProductionState,
  createValue: unknown,
  resolveSource: VideoStudioHandoffSourceResolver,
): VideoStudioHandoffV2 {
  const state = parseProductionState(stateValue);
  const create = parseVideoStudioHandoffV2Create(createValue);
  if (state.updatedAt !== null && create.createdAt < state.updatedAt) {
    fail("VideoStudioHandoffV2.createdAt", "不得早于所绑定 productionRevision 的 updatedAt");
  }
  const takes = create.taskIds.map((taskId) => {
    const subject = `VideoStudioHandoffV2 take ${taskId}`;
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) fail("VideoStudioHandoffV2", `task ${taskId} 不存在`);
    if (task.subject.kind !== "shot") fail("VideoStudioHandoffV2", `task ${taskId} 不是 shot take`);
    if (task.status !== "approved" || task.approval?.decision !== "approved") {
      fail("VideoStudioHandoffV2", `task ${taskId} 尚未 approved`);
    }
    if (!task.assets.length) fail("VideoStudioHandoffV2", `task ${taskId} 没有已 ingest 资产`);
    const shot = task.subject.shot;
    const source = resolveSource(taskId);
    const intent = source.intent;
    const shotRequest = source.shotRequest;
    if (intent.taskId !== taskId) fail(subject, `intent.taskId ${intent.taskId} 与 task 不一致`);
    if (intent.subject.kind !== "shot"
      || videoStudioHandoffCanonicalJson(intent.subject.shot) !== videoStudioHandoffCanonicalJson(shot)) {
      fail(subject, "intent 绑定的 shot revision 与账本不一致");
    }
    if (videoStudioHandoffCanonicalJson(shotRequest.subject) !== videoStudioHandoffCanonicalJson(shot)) {
      fail(subject, "ShotRequest 绑定的 shot revision 与账本不一致");
    }
    if (shotRequest.shotId !== shot.shotId) {
      fail(subject, `ShotRequest.shotId ${shotRequest.shotId} 与 take 的 ${shot.shotId} 不一致`);
    }
    const shotRequestAsset = parseAssetRef(intent.inputs[0], `${subject}.shotRequest`);
    if (shotRequestAsset.mediaType !== SHOT_REQUEST_MEDIA_TYPE) {
      fail(subject, `intent.inputs[0] 必须是 ${SHOT_REQUEST_MEDIA_TYPE}`);
    }
    if (shotRequestAsset.sha256 !== shotRequestSha256(shotRequest)) {
      fail(subject, "ShotRequest 文档与 intent.inputs[0] 的 sha256 不一致");
    }
    // 单 intent 确认指纹：`plan-shots --confirm` 逐镜提交时用的就是它，因此 gate 绑定的是被批准的
    // 那一份计划，而不是「某次审批」这种无法复核的说法。
    const { idempotencyKey: _key, ...draft } = intent;
    const plan = planProductionTaskEnqueue({ workspaceId: state.workspaceId, project: state.project, draft });
    if (plan.intent.idempotencyKey !== intent.idempotencyKey) {
      fail(subject, "重算的 intent idempotencyKey 与持久化 intent 不一致");
    }
    const approval = task.approval;
    const { assets, assetRoles } = takeAssets(task, intent, shotRequest, subject);
    const gate: VideoStudioGateRecord = {
      version: 1,
      gate: "qc-approved",
      bindsTo: { planSha256: plan.planId, requestSha256: shotRequestAsset.sha256 },
      approvedBy: opaque(approval.decidedBy, `${subject}.approval.decidedBy`),
      approvedAt: approval.decidedAt,
      system: "wl-qc",
    };
    const row: VideoStudioHandoffV2Take = {
      version: 1,
      taskId: task.id,
      shot,
      shotRequest: shotRequestAsset,
      assets,
      assetRoles,
      execution: takeExecution(intent.execution, shotRequest, task.remoteJobId, `${subject}.execution`),
      cost: task.cost,
      gates: [gate],
      license: takeLicense(intent.license, `${subject}.license`),
      approval,
    };
    return row;
  }).sort((left, right) =>
    compareProductionAscii(left.shot.shotId, right.shot.shotId)
      || compareProductionAscii(left.taskId, right.taskId));

  const shotIds = takes.map((take) => take.shot.shotId);
  if (new Set(shotIds).size !== shotIds.length) fail("VideoStudioHandoffV2", "同一 handoff 不得含重复 shotId");
  const first = takes[0]!.shot.episode;
  for (const take of takes) {
    const episode = take.shot.episode;
    if (episode.episodeId !== first.episodeId || episode.revision !== first.revision
      || episode.source.sha256 !== first.source.sha256) {
      fail("VideoStudioHandoffV2", "所有 take 必须绑定同一 episode revision");
    }
  }
  return {
    version: 2,
    contract: VIDEO_STUDIO_HANDOFF_CONTRACT_V2,
    handoffId: create.handoffId,
    studioProjectId: create.studioProjectId,
    workspaceId: state.workspaceId,
    project: state.project,
    productionRevision: state.revision,
    pipeline: VIDEO_STUDIO_HANDOFF_V2_PIPELINE,
    createdAt: create.createdAt,
    delivery: create.delivery,
    takes,
    requiresAgentOrchestration: true,
  };
}

// ——— `--export-dir`：交接文档 + 资产目录（§8.3） ———
//
// 导出目录是 VCS importer 的输入：`handoff.json` 是规范 JSON 字节（无缩进），`handoff.digest`
// 是它的 sha256（供 `studio.py import-handoff --expect-digest` 比对），资产按 `<sha256>.<ext>`
// 逐文件落盘。写入是「先写临时目录再 rename」：任何一次下载或校验失败都整次失败并清理，
// 目标目录里不会出现半份导出，已有内容的目录也不会被逐文件覆盖。

export const VIDEO_STUDIO_HANDOFF_DOCUMENT_FILE = "handoff.json";
export const VIDEO_STUDIO_HANDOFF_DIGEST_FILE = "handoff.digest";
export const DEFAULT_VIDEO_STUDIO_ASSET_BYTES = 512 * 1024 * 1024;
export const DEFAULT_VIDEO_STUDIO_ASSET_TIMEOUT_MS = 120_000;

/** 按 AssetRef 取回不可变字节；实现负责寻址，校验由导出侧统一做。 */
export type VideoStudioAssetReader = (asset: AssetRef, signal?: AbortSignal) => Promise<Uint8Array>;

export type VideoStudioHandoffExportFile = {
  name: string;
  sha256: string;
  byteLength: number;
};

export type VideoStudioHandoffExportResult = {
  version: 1;
  directory: string;
  digestAlgorithm: typeof VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM;
  digest: string;
  files: VideoStudioHandoffExportFile[];
};

function assetFileName(asset: AssetRef, subject: string): string {
  const extension = VIDEO_STUDIO_ASSET_FILE_EXTENSIONS[asset.mediaType];
  if (extension === undefined) {
    fail(
      subject,
      `mediaType ${asset.mediaType} 不在导出扩展名表内（本版只导出 `
        + `${Object.keys(VIDEO_STUDIO_ASSET_FILE_EXTENSIONS).join("、")}；`
        + "扩展表是 importer EXTENSIONS_BY_MEDIA_TYPE 的子集，扩表要两侧同时改)",
    );
  }
  return `${sha256Hex(asset.sha256, `${subject}.sha256`)}.${extension}`;
}

/** 交接文档引用的全部不可变对象，按 sha256 去重；同一 digest 的两条 AssetRef 必须逐字段一致。 */
export function videoStudioHandoffAssets(handoff: VideoStudioHandoffV2): AssetRef[] {
  const byDigest = new Map<string, AssetRef>();
  for (const take of handoff.takes) {
    for (const asset of [take.shotRequest, ...take.assets]) {
      const existing = byDigest.get(asset.sha256);
      if (existing === undefined) { byDigest.set(asset.sha256, asset); continue; }
      if (existing.mediaType !== asset.mediaType || existing.byteLength !== asset.byteLength) {
        fail("VideoStudioHandoffV2 导出", `资产 ${asset.sha256} 在不同 take 中的 mediaType/byteLength 不一致`);
      }
    }
  }
  return [...byDigest.values()];
}

/**
 * 目标目录是否就是本次导出的结果：文件名集合完全相同，且每个都是同名普通文件、内容 digest 相同。
 * 相同即幂等重放，不写；只要有一处不同就不是同一份导出，交给调用方拒绝。
 */
function sameExport(
  target: string,
  present: readonly string[],
  files: readonly VideoStudioHandoffExportFile[],
): boolean {
  if (present.length !== files.length) return false;
  const expected = new Map(files.map((file) => [file.name, file] as const));
  for (const name of present) {
    const file = expected.get(name);
    if (file === undefined) return false;
    const path = join(target, name);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(path); }
    catch { return false; }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.byteLength) return false;
    let bytes: Buffer;
    try { bytes = readFileSync(path); }
    catch { return false; }
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) return false;
  }
  return true;
}

function removeQuietly(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); }
  catch { /* 清理是尽力而为；主错误必须原样上抛 */ }
}

/**
 * 把交接文档与全部资产写进 `directory`：全部内容先落到同级临时目录，成功后才一次 rename 到位。
 * 目标目录已有内容时不覆盖——逐文件相同即判定为幂等重放（不写任何字节），否则拒绝并要求换目录。
 */
export async function exportVideoStudioHandoffV2(options: {
  handoff: VideoStudioHandoffV2;
  directory: string;
  readAsset: VideoStudioAssetReader;
}): Promise<VideoStudioHandoffExportResult> {
  const subject = "VideoStudioHandoffV2 导出";
  const target = resolve(options.directory);
  const parent = dirname(target);
  let parentInfo: ReturnType<typeof lstatSync>;
  try { parentInfo = lstatSync(parent); }
  catch (error) { fail(subject, `父目录不存在：${parent}（${error instanceof Error ? error.message : String(error)}）`); }
  if (!parentInfo.isDirectory()) fail(subject, `父目录不是目录：${parent}`);

  let targetInfo: ReturnType<typeof lstatSync> | null = null;
  try { targetInfo = lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      fail(subject, `无法检查 ${target}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (targetInfo !== null && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())) {
    fail(subject, `导出目录必须是真实目录（拒绝 symlink/文件/device）：${target}`);
  }
  const existing = targetInfo !== null;

  const document = videoStudioHandoffCanonicalJson(options.handoff);
  const digest = createHash("sha256").update(document, "utf8").digest("hex");
  const stage = join(parent, `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  mkdirSync(stage, { mode: 0o700 });
  const files: VideoStudioHandoffExportFile[] = [];
  try {
    const documentBytes = Buffer.from(document, "utf8");
    writeFileSync(join(stage, VIDEO_STUDIO_HANDOFF_DOCUMENT_FILE), documentBytes, { mode: 0o600, flag: "wx" });
    writeFileSync(join(stage, VIDEO_STUDIO_HANDOFF_DIGEST_FILE), `${digest}\n`, { mode: 0o600, flag: "wx" });
    files.push({
      name: VIDEO_STUDIO_HANDOFF_DOCUMENT_FILE,
      sha256: digest,
      byteLength: documentBytes.byteLength,
    });
    files.push({
      name: VIDEO_STUDIO_HANDOFF_DIGEST_FILE,
      sha256: createHash("sha256").update(`${digest}\n`, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(`${digest}\n`, "utf8"),
    });
    for (const asset of videoStudioHandoffAssets(options.handoff)) {
      const name = assetFileName(asset, `${subject} ${asset.uri}`);
      const bytes = await options.readAsset(asset);
      if (bytes.byteLength !== asset.byteLength) {
        fail(subject, `${asset.uri} 取回 ${bytes.byteLength} bytes，AssetRef 声明 ${asset.byteLength} bytes`);
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== asset.sha256) {
        fail(subject, `${asset.uri} 取回内容 digest ${actual} 与 AssetRef 的 ${asset.sha256} 不一致`);
      }
      writeFileSync(join(stage, name), bytes, { mode: 0o600, flag: "wx" });
      files.push({ name, sha256: asset.sha256, byteLength: asset.byteLength });
    }
  } catch (error) {
    removeQuietly(stage);
    throw error;
  }

  // 落位只有三种结局，没有「逐文件覆盖」这一种：
  //   目标不存在 / 是空目录 → 整个临时目录一次 rename，中途崩溃留下的是临时目录而不是半份导出；
  //   目标非空且与本次导出逐文件同名同 digest → 判定为已经导出过，一个字节都不写；
  //   其余 → 拒绝。逐文件覆盖既不原子，回滚时又会删掉目录里本来就有的东西。
  try {
    const present = existing ? readdirSync(target) : [];
    if (present.length === 0) {
      renameSync(stage, target);
    } else if (sameExport(target, present, files)) {
      rmSync(stage, { recursive: true, force: true });
    } else {
      fail(
        subject,
        `导出目录 ${target} 已有内容，且与本次导出的文件集合或内容不一致；`
          + "本命令不覆盖已有目录，请换一个新目录（或先人工确认后移走旧内容）",
      );
    }
  } catch (error) {
    removeQuietly(stage);
    throw error;
  }
  return {
    version: 1,
    directory: target,
    digestAlgorithm: VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
    digest,
    files,
  };
}

// ——— 资产来源：本机 workspace CAS 优先，其余经 gateway 的 assets 路由（GET 方法） ———

export type VideoStudioAssetCredentialContext = {
  workspaceId: string;
  project: string;
  operation: "asset-read";
};

export type VideoStudioAssetCredentialResolver = (
  context: Readonly<VideoStudioAssetCredentialContext>,
  signal: AbortSignal,
) => string | null | Promise<string | null>;

export type VideoStudioGatewayAssetReaderOptions = {
  /** 受信的 server 侧 gateway 根；只能来自 runtime config，绝不来自任务负载。 */
  baseUrl: string | URL;
  workspaceId: string;
  project: string;
  credentialResolver?: VideoStudioAssetCredentialResolver;
  allowInsecureLoopback?: boolean;
  transport?: ProductionIngestorTransport;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxAssetBytes?: number;
};

/**
 * baseUrl、bearer 形态、scope 与区间检查全部复用 ingest 客户端的同一批判据（§8.0），本模块不另写
 * 一份规则；这里只把 ingestor 的稳定错误码翻成带 handoff 语境的消息，便于操作者定位改哪份配置。
 */
function assertIngestorRule<T>(subject: string, detail: string, run: () => T): T {
  try { return run(); }
  catch (error) {
    if (error instanceof ProductionIngestorError) fail(subject, `${detail}（${error.code}）`);
    throw error;
  }
}

async function readExactBody(
  response: Response,
  expectedBytes: number,
  subject: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) fail(subject, "gateway 未返回响应体");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedBytes)) {
    void body.cancel().catch(() => undefined);
    fail(subject, `gateway 声明 content-length ${declared}，AssetRef 声明 ${expectedBytes} bytes`);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await raceAbort(reader.read(), signal);
      if (step.done) break;
      const chunk = step.value;
      if (chunk === undefined) continue;
      total += chunk.byteLength;
      if (total > expectedBytes) fail(subject, `响应体超过 AssetRef 声明的 ${expectedBytes} bytes`);
      chunks.push(chunk);
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已读完时 cancel 是 no-op */ }
  }
  if (total !== expectedBytes) fail(subject, `响应体 ${total} bytes 少于 AssetRef 声明的 ${expectedBytes} bytes`);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

/** 经 gateway 的 `v1/scopes/<ws>/<project>/assets/sha256/<digest>` 取回一个不可变对象。 */
export function videoStudioGatewayAssetReader(
  options: VideoStudioGatewayAssetReaderOptions,
): VideoStudioAssetReader {
  const configSubject = "VideoStudio gateway assets";
  const transport = options.transport ?? "tls";
  if (transport !== "tls" && transport !== "insecure-private-http") {
    fail(configSubject, "transport 配置无效");
  }
  const credentialResolver = options.credentialResolver ?? null;
  if (credentialResolver !== null && typeof credentialResolver !== "function") {
    fail(configSubject, "credentialResolver 必须是函数");
  }
  const baseUrl = assertIngestorRule(
    `${configSubject} baseUrl`,
    "不满足 gateway baseUrl 判据：credentialed HTTPS、insecure-private-http 的私网字面 IP + bearer，"
      + "或显式声明的无凭据 literal-loopback 开发形态",
    () => trustedBaseUrl(options.baseUrl, options.allowInsecureLoopback === true, credentialResolver !== null, transport).url,
  );
  const scope = assertIngestorRule(
    `${configSubject} scope`, "workspaceId / project 不是安全标识符",
    () => parseScope(options.workspaceId, options.project),
  );
  const timeoutMs = assertIngestorRule(
    `${configSubject} timeoutMs`, "不在 50–300000 区间",
    () => boundedInteger(options.timeoutMs, DEFAULT_VIDEO_STUDIO_ASSET_TIMEOUT_MS, 50, 300_000),
  );
  const maxAssetBytes = assertIngestorRule(
    `${configSubject} maxAssetBytes`, "不在 1024–4 GiB 区间",
    () => boundedInteger(options.maxAssetBytes, DEFAULT_VIDEO_STUDIO_ASSET_BYTES, 1_024, 4 * 1024 * 1024 * 1024),
  );
  const fetchImpl: FetchLike = options.fetch ?? fetch;

  return async (asset: AssetRef, callerSignal?: AbortSignal): Promise<Uint8Array> => {
    const subject = `VideoStudio gateway assets ${asset.sha256}`;
    if (asset.byteLength > maxAssetBytes) {
      fail(subject, `AssetRef 声明 ${asset.byteLength} bytes，超过 ${maxAssetBytes} 上限`);
    }
    const url = new URL(
      `v1/scopes/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.project)}`
        + `/assets/sha256/${asset.sha256}`,
      baseUrl,
    );
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("deadline")), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "*/*" };
      if (credentialResolver !== null) {
        const resolved = await raceAbort(
          Promise.resolve(credentialResolver(
            { workspaceId: scope.workspaceId, project: scope.project, operation: "asset-read" },
            controller.signal,
          )),
          controller.signal,
        );
        const credential = assertIngestorRule(subject, "bearer 凭据形态无效", () => authorizationToken(resolved));
        if (credential === null) fail(subject, "bearer 凭据不可用");
        headers.authorization = `Bearer ${credential}`;
      }
      let response: Response;
      try {
        response = await raceAbort(
          Promise.resolve(fetchImpl(url, {
            method: "GET", redirect: "error", headers, signal: controller.signal,
          })),
          controller.signal,
        );
      } catch (error) {
        fail(subject, `gateway 不可达：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        fail(subject, `gateway assets 返回 ${response.status}`);
      }
      return await readExactBody(response, asset.byteLength, subject, controller.signal);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

/**
 * 导出用的资产来源：`cas://` 对象先问本机对象源（§6.4 的 `WorkspaceCasLocalAssetSource`，它校验
 * authority、digest 与字节长度），查不到再回落 gateway；`urn:sha256:` 一律经 gateway。没有配置
 * gateway 时，落不到本地的对象直接失败，而不是给出一份缺资产的导出。
 */
export function videoStudioWorkspaceAssetReader(options: {
  local: ProductionLocalAssetSource | null;
  gateway: VideoStudioAssetReader | null;
}): VideoStudioAssetReader {
  return async (asset: AssetRef, signal?: AbortSignal): Promise<Uint8Array> => {
    const subject = `VideoStudio 资产 ${asset.uri}`;
    const casUri = asset.uri.startsWith("cas://");
    if (!casUri && !asset.uri.startsWith("urn:sha256:")) {
      fail(subject, "只支持 cas:// 与 urn:sha256: 两种可寻址来源");
    }
    if (casUri && options.local !== null) {
      try { return await options.local.read(asset, signal); }
      catch (error) {
        // 本机没有这份对象是正常的（正本在 GPU VM 的 ingest CAS）；内容对不上号则是损坏，必须上抛。
        if (!(error instanceof ProductionLocalAssetSourceError)
          || (error.code !== "not-found" && error.code !== "unsupported-uri"
            && error.code !== "authority-mismatch")) {
          fail(subject, `本机对象源读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (options.gateway === null) {
      fail(subject, "不在本机 workspace CAS 中，且未配置 gateway assets 来源（导出需要 --config）");
    }
    return options.gateway(asset, signal);
  };
}
