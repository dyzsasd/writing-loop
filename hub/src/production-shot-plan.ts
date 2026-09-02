// Batch approval and cost gate for shot dispatch (§4.7).
//
// `plan-shots --plan` is strictly zero-write: it compiles every draft, prices it against the
// gateway-exported profile snapshot and returns one `ShotBatchPlan` whose `batchPlanId` binds the
// workspace, the project, every resulting intent, the policy digest and the degradations. Changing
// any of those invalidates the fingerprint, so an approval can never be replayed against a
// different batch. `--confirm <batchPlanId>` recomputes the same plan from the same inputs and only
// then publishes: per shot it writes the immutable ShotRequest into the workspace CAS, records the
// batch approval next to the immutable intent, and calls `commitProductionTaskEnqueue` with that
// shot's own single-intent planId (§4.7 的批次/单镜两层指纹).
//
// 两条与「这一批到底跑哪几镜」有关的判据也在这里：`shotIds` / `--shot` 的按镜头筛选在编译之前生效
// （被筛掉的镜头仍在 `plan.shots[]` 里以 `selected: false` 列出，但不编译、不进 intents、不计估算）；
// `previous-shot-last-frame` 的上游 take 取证读本地权威账本——承接只成立于已入库且到达 QC 的 take，
// 批内不成链，`waves[]` 因此恒为一波。
import { createHash } from "node:crypto";
import { productionCanonicalJson, productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import { parseBackendCapabilities } from "./production-provider-adapter.ts";
import type { BackendCapabilities, BackendKind, VideoBackendLimits } from "./production-adapter.ts";
import { ProductionError, type AssetRef } from "./production-domain.ts";
import {
  createProductionDispatchIntent,
  parseProductionLicenseCompliance,
  type ProductionDispatchIntent,
  type ProductionIntentDraft,
  type ProductionLicenseCompliance,
} from "./production-intent.ts";
import {
  compileShotRequest,
  executionLimitsKey,
  parseShotRequestDraft,
  selectH3ProfileForDuration,
  shotRequestAssetRef,
  shotRequestCanonicalJson,
  withDerivedShotSeed,
  type Degradation,
  type ReferenceInput,
  type ShotAspectRatio,
  type ShotCompileCapability,
  type ShotCompilePolicy,
  type ShotExecutionProfile,
  type ShotRequest,
  type ShotRequestDraft,
  type ShotRequestScriptOptions,
  type ValidationReport,
} from "./production-shot-request.ts";
import type {
  ProductionExecutionProfileSnapshotRead,
  ProductionExecutionProfileSnapshotReadEntry,
} from "./production-profile-snapshot.ts";
import { writeProductionCasObject } from "./production-cas.ts";
import {
  PRODUCTION_BATCH_APPROVAL_KIND,
  writeProductionBatchApproval,
} from "./production-batch-approval.ts";
import { commitProductionTaskEnqueue, planProductionTaskEnqueue } from "./production-enqueue.ts";
import type { ProductionState, ProductionTask } from "./production-domain.ts";
import type { VisualCompileInputs } from "./visual-production.ts";

export const SHOT_BATCH_REQUEST_KIND = "writing-loop/shot-batch-request";
export const SHOT_BATCH_PLAN_KIND = "writing-loop/shot-batch-plan";
export const MAX_SHOT_BATCH_SHOTS = 512;
/** §4.7：reservation 以 maximum 为准，估算 × 1.5 上取整。 */
export const SHOT_BATCH_MAXIMUM_MULTIPLIER = 1.5;

export const SHOT_BATCH_PHASES = ["sample", "bulk"] as const;
export type ShotBatchPhase = typeof SHOT_BATCH_PHASES[number];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new ProductionError(`${subject} ${detail}`);
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
  subject: string,
  optional: readonly string[] = [],
): void {
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
  const extras = Object.keys(row).filter((key) => !expected.includes(key) && !optional.includes(key));
  if (missing.length || extras.length) {
    fail(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
}

function requireText(value: unknown, subject: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || CONTROL.test(value)) {
    fail(subject, `必须是 1–${max} 位无控制字符文本`);
  }
  return value as string;
}

/** 子集校验：字段级 patch 允许只补其中一两项，但不接受这个集合之外的键。 */
function onlyKeys(row: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  if (extras.length) fail(subject, `只允许补齐 ${allowed.join("、")}（未知：${extras.join("、")}）`);
}

function requireArray(value: unknown, subject: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(subject, `必须是至多 ${max} 项数组`);
  return value as unknown[];
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

// —— 剧本预填选项的运行时解析（§6.1） ——
// `ShotRequestScriptOptions` 是 TS 类型；批次文档是外部 JSON，因此这里做一次显式解析：
// 缺 subject / provenance / sceneRegistry / output / prompt 这类必填项时在装配期就报清楚，
// 而不是等 `shotRequestFromScript` 在半路上抛出难以定位的字段错误。
const SHOT_ASPECT_RATIO_VALUES = ["9:16", "16:9", "1:1", "21:9"] as const;

export function parseShotRequestScriptOptions(
  value: unknown,
  subject = "ShotBatchRequest.script.options",
): Omit<ShotRequestScriptOptions, "episode" | "sceneIndexes"> {
  const row = requireRecord(value, subject);
  // 必填六项 + 三个可选项（注册具名角色、shotId 前缀、参考裁剪策略）。
  const required = ["subject", "provenance", "sceneRegistry", "output", "defaultStoryboardDurationSeconds", "prompt"];
  const optional = ["characters", "episodeTag", "referencePolicy"];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
  const extras = Object.keys(row).filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length || extras.length) {
    fail(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
  const registry = requireArray(row.sceneRegistry, `${subject}.sceneRegistry`, 512);
  if (registry.length === 0) fail(`${subject}.sceneRegistry`, "不得为空（场景头必须能命中注册景）");
  const sceneRegistry = registry.map((entry, index) => {
    const scene = requireRecord(entry, `${subject}.sceneRegistry[${index}]`);
    exactKeys(scene, ["id", "name"], `${subject}.sceneRegistry[${index}]`);
    return {
      id: requireText(scene.id, `${subject}.sceneRegistry[${index}].id`, 64),
      name: requireText(scene.name, `${subject}.sceneRegistry[${index}].name`, 128),
    };
  });
  const output = requireRecord(row.output, `${subject}.output`);
  exactKeys(output, ["aspectRatio", "generateAudio", "seed"], `${subject}.output`);
  if (typeof output.aspectRatio !== "string"
    || !(SHOT_ASPECT_RATIO_VALUES as readonly string[]).includes(output.aspectRatio)) {
    fail(`${subject}.output.aspectRatio`, `必须是 ${SHOT_ASPECT_RATIO_VALUES.join("、")} 之一`);
  }
  if (typeof output.generateAudio !== "boolean") fail(`${subject}.output.generateAudio`, "必须是 boolean");
  if (output.seed !== null && !Number.isSafeInteger(output.seed)) {
    fail(`${subject}.output.seed`, "必须是 null 或安全整数");
  }
  const prompt = requireRecord(row.prompt, `${subject}.prompt`);
  const promptExtras = Object.keys(prompt).filter((key) => key !== "authoredBy" && key !== "language");
  if (promptExtras.length) fail(`${subject}.prompt`, `含不支持字段：${promptExtras.join("、")}`);
  const duration = row.defaultStoryboardDurationSeconds;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    fail(`${subject}.defaultStoryboardDurationSeconds`, "必须是正有限数");
  }
  let characters: Array<{ id: string; name: string }> | undefined;
  if (row.characters !== undefined) {
    characters = requireArray(row.characters, `${subject}.characters`, 512).map((entry, index) => {
      const person = requireRecord(entry, `${subject}.characters[${index}]`);
      exactKeys(person, ["id", "name"], `${subject}.characters[${index}]`);
      return {
        id: requireText(person.id, `${subject}.characters[${index}].id`, 64),
        name: requireText(person.name, `${subject}.characters[${index}].name`, 128),
      };
    });
  }
  if (row.referencePolicy !== undefined
    && row.referencePolicy !== "strict" && row.referencePolicy !== "trim_by_priority") {
    fail(`${subject}.referencePolicy`, "必须是 strict 或 trim_by_priority");
  }
  return {
    // subject / provenance 的逐字段判据由 parseShotRequestDraft 承担（同一套 v1 语义，不复制第二份）。
    subject: requireRecord(row.subject, `${subject}.subject`) as unknown as ShotRequestScriptOptions["subject"],
    provenance: requireRecord(row.provenance, `${subject}.provenance`) as unknown as ShotRequestScriptOptions["provenance"],
    sceneRegistry,
    output: {
      aspectRatio: output.aspectRatio as ShotAspectRatio,
      generateAudio: output.generateAudio,
      seed: output.seed as number | null,
    },
    defaultStoryboardDurationSeconds: duration,
    prompt: {
      authoredBy: requireText(prompt.authoredBy, `${subject}.prompt.authoredBy`, 128),
      ...(prompt.language === undefined
        ? {}
        : { language: requireText(prompt.language, `${subject}.prompt.language`, 32) }),
    },
    ...(characters === undefined ? {} : { characters }),
    ...(row.episodeTag === undefined
      ? {}
      : { episodeTag: requireText(row.episodeTag, `${subject}.episodeTag`, 32) }),
    ...(row.referencePolicy === undefined
      ? {}
      : { referencePolicy: row.referencePolicy as "strict" | "trim_by_priority" }),
  };
}

// —— 请求文档（plan-shots --input） ——

/**
 * 剧本预填的镜头无法携带分镜与写作侧字段（camera / prompt / 连续性输入，§6.1），补齐由本 patch 承担。
 * `scene` 与 `continuity` 只接受人工可决定的子集：`sceneId` / 时段 / 内外 / `stageGroup` / `prevShotId`
 * 是剧本与合并结果的事实，不接受改写。
 */
export const SHOT_DRAFT_PATCH_FIELDS = [
  "camera", "scene", "cast", "props", "crowd", "output", "continuity", "prompt",
] as const;
export const SHOT_DRAFT_PATCH_SCENE_FIELDS = ["lightingStateId", "dressingVariantId"] as const;
export const SHOT_DRAFT_PATCH_CONTINUITY_FIELDS = [
  "firstFrame", "lastFrame", "references", "spatialPasses",
] as const;

export type ShotDraftPatch = { shotId: string } & Partial<Record<typeof SHOT_DRAFT_PATCH_FIELDS[number], unknown>>;

export type ShotBatchScriptSource = {
  /** 项目 repo 内的相对路径（`episodes/ep-001.md`）。 */
  episodeFile: string;
  episode: number;
  sceneIndexes: number[] | null;
  options: Omit<ShotRequestScriptOptions, "episode" | "sceneIndexes">;
  /**
   * 合并前补齐（shotId 取预填 shotId）。`camera` 必须在这一步落位：合并的十条判定条件之一是机位
   * 相同，两侧都是 null 时不成立，镜头永远合不起来（§6.1 条件 3）。
   */
  patches: ShotDraftPatch[];
  /**
   * 合并后补齐（shotId 取存活镜头的 shotId）。prompt 与连续性输入按合并后的镜头撰写与排期，
   * 因此只能在这一步落位（§6.1 数据流：合并早于写作侧步骤）。
   */
  mergedPatches: ShotDraftPatch[];
};

export type ShotBatchSamplePolicy = {
  sampleShotIds: string[];
  requireApprovedSampleBeforeBulk: true;
};

export type ShotBatchGpuEstimate = { spotUsdPerHour: number; estimatedHours: number };

export type ShotBatchRequest = {
  version: 1;
  kind: typeof SHOT_BATCH_REQUEST_KIND;
  phase: ShotBatchPhase;
  /**
   * 后端 capability（§4.3）。快照条目带 `limits` 时（Phase 1b 起）由快照推导，本字段可为 null；
   * 两者同时给出时逐项交叉校验，不一致即拒绝出计划。快照不带 `limits` 时本字段必填——
   * 编译器需要 `limitsByModelId` 才能判定模式、时长网格与参考上限。
   */
  capability: Required<BackendCapabilities> | null;
  /** 本批次的目标后端；null 时取快照中唯一的 backendInstanceId，有多个即拒绝（不猜）。 */
  backendInstanceId: string | null;
  /** 陈设映射的 arc 键（`visual/mappings.v1.json` 的 `(sceneId, arcId)`）；null = 不自动填陈设。 */
  arcId: string | null;
  anchorPreference: "keyframes" | "references";
  compiler: string;
  /** 每镜 taskId = `<taskIdPrefix>-<shotId>`；确定性 ID 让同一批次的重放成为幂等操作。 */
  taskIdPrefix: string;
  createdAt: string;
  useTerritories: string[];
  rights: unknown;
  moderation: unknown;
  license: unknown;
  /** 目标 execution profile；null = 按分镜时长在快照的时长网格上取整选档。 */
  profileId: string | null;
  samplePolicy: ShotBatchSamplePolicy | null;
  /** GPU 小时估算是 plan 文档的附注，不构成阻断条件（§4.7）。 */
  gpuEstimate: ShotBatchGpuEstimate | null;
  shots: unknown[];
  script: ShotBatchScriptSource | null;
  /**
   * 按镜头筛选（可选键；缺省与 null 都表示不筛选）。与命令行 `--shot <id>` 等价，两者都给出时取交集。
   * 筛选在预填、合并与视觉填充之后、编译之前生效：被筛掉的镜头不编译、不进 intents、不计估算。
   */
  shotIds: string[] | null;
};

function parseShotIdSelection(value: unknown, subject: string): string[] | null {
  if (value === undefined || value === null) return null;
  const shotIds = requireArray(value, subject, MAX_SHOT_BATCH_SHOTS).map((entry, index) => {
    const shotId = requireText(entry, `${subject}[${index}]`, 128);
    if (!SAFE_ID.test(shotId)) fail(`${subject}[${index}]`, "必须是安全 shotId");
    return shotId;
  });
  if (shotIds.length === 0) fail(subject, "不得为空数组（不筛选用 null 或省略）");
  if (new Set(shotIds).size !== shotIds.length) fail(subject, "不得重复");
  return shotIds;
}

/**
 * 命令行 `--shot` 与批次文档 `shotIds` 的交集（§4.7 按镜头筛选）。两者都不给出即不筛选；
 * 交集为空是操作者错误——那样的批次一个镜头也提交不了，直接拒绝而不是出一份空计划。
 */
export function resolveShotSelection(
  documentShotIds: readonly string[] | null,
  commandShotIds: readonly string[],
): string[] | null {
  if (commandShotIds.length === 0) return documentShotIds === null ? null : [...documentShotIds];
  if (new Set(commandShotIds).size !== commandShotIds.length) {
    fail("plan-shots --shot", "同一 shotId 不得指定两次");
  }
  if (documentShotIds === null) return [...commandShotIds];
  const declared = new Set(documentShotIds);
  const intersection = commandShotIds.filter((shotId) => declared.has(shotId));
  if (intersection.length === 0) {
    fail("plan-shots --shot", `与批次文档 shotIds（${[...declared].join("、")}）没有交集`);
  }
  return intersection;
}

function parseSamplePolicy(value: unknown, subject: string): ShotBatchSamplePolicy | null {
  if (value === null) return null;
  const row = requireRecord(value, subject);
  exactKeys(row, ["sampleShotIds"], subject);
  const shotIds = requireArray(row.sampleShotIds, `${subject}.sampleShotIds`, MAX_SHOT_BATCH_SHOTS)
    .map((entry, index) => {
      const shotId = requireText(entry, `${subject}.sampleShotIds[${index}]`, 128);
      if (!SAFE_ID.test(shotId)) fail(`${subject}.sampleShotIds[${index}]`, "必须是安全 shotId");
      return shotId;
    });
  if (shotIds.length === 0) fail(`${subject}.sampleShotIds`, "不得为空（样片门必须指名样片）");
  if (new Set(shotIds).size !== shotIds.length) fail(`${subject}.sampleShotIds`, "不得重复");
  return { sampleShotIds: shotIds, requireApprovedSampleBeforeBulk: true };
}

function parseGpuEstimate(value: unknown, subject: string): ShotBatchGpuEstimate | null {
  if (value === null) return null;
  const row = requireRecord(value, subject);
  exactKeys(row, ["spotUsdPerHour", "estimatedHours"], subject);
  for (const key of ["spotUsdPerHour", "estimatedHours"] as const) {
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || (row[key] as number) <= 0) {
      fail(`${subject}.${key}`, "必须是正有限数");
    }
  }
  return { spotUsdPerHour: row.spotUsdPerHour as number, estimatedHours: row.estimatedHours as number };
}

function parsePatch(value: unknown, index: number, field: string): ShotDraftPatch {
  const subject = `${field}[${index}]`;
  const row = requireRecord(value, subject);
  const shotId = requireText(row.shotId, `${subject}.shotId`, 128);
  if (!SAFE_ID.test(shotId)) fail(`${subject}.shotId`, "必须是安全 shotId");
  const extras = Object.keys(row).filter(
    (key) => key !== "shotId" && !(SHOT_DRAFT_PATCH_FIELDS as readonly string[]).includes(key),
  );
  if (extras.length) {
    fail(subject, `只允许补齐 ${SHOT_DRAFT_PATCH_FIELDS.join("、")}（未知：${extras.join("、")}）`);
  }
  const patch: ShotDraftPatch = { shotId };
  for (const member of SHOT_DRAFT_PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, member)) continue;
    if (member === "scene") {
      onlyKeys(requireRecord(row.scene, `${subject}.scene`), SHOT_DRAFT_PATCH_SCENE_FIELDS, `${subject}.scene`);
    }
    if (member === "continuity") {
      onlyKeys(
        requireRecord(row.continuity, `${subject}.continuity`),
        SHOT_DRAFT_PATCH_CONTINUITY_FIELDS,
        `${subject}.continuity`,
      );
    }
    patch[member] = row[member];
  }
  return patch;
}

function parseScriptSource(value: unknown, subject: string): ShotBatchScriptSource | null {
  if (value === null) return null;
  const row = requireRecord(value, subject);
  exactKeys(row, ["episodeFile", "episode", "sceneIndexes", "options", "patches", "mergedPatches"], subject);
  const episodeFile = requireText(row.episodeFile, `${subject}.episodeFile`, 512);
  if (episodeFile.startsWith("/") || episodeFile.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${subject}.episodeFile`, "必须是项目 repo 内无 .. 段的相对路径");
  }
  if (!Number.isSafeInteger(row.episode) || Number(row.episode) < 1 || Number(row.episode) > 10_000) {
    fail(`${subject}.episode`, "必须是 1–10000 的安全整数");
  }
  let sceneIndexes: number[] | null = null;
  if (row.sceneIndexes !== null) {
    sceneIndexes = requireArray(row.sceneIndexes, `${subject}.sceneIndexes`, 512).map((entry, index) => {
      if (!Number.isSafeInteger(entry) || Number(entry) < 1) fail(`${subject}.sceneIndexes[${index}]`, "必须是正整数场序");
      return Number(entry);
    });
    if (sceneIndexes.length === 0) fail(`${subject}.sceneIndexes`, "不得为空数组（全部场用 null）");
  }
  const patchList = (patches: unknown, field: "patches" | "mergedPatches"): ShotDraftPatch[] => {
    const parsed = requireArray(patches, `${subject}.${field}`, MAX_SHOT_BATCH_SHOTS)
      .map((entry, index) => parsePatch(entry, index, `${subject}.${field}`));
    if (new Set(parsed.map((entry) => entry.shotId)).size !== parsed.length) {
      fail(`${subject}.${field}`, "同一 shotId 不得出现两条补齐");
    }
    return parsed;
  };
  return {
    episodeFile,
    episode: Number(row.episode),
    sceneIndexes,
    options: parseShotRequestScriptOptions(row.options, `${subject}.options`),
    patches: patchList(row.patches, "patches"),
    mergedPatches: patchList(row.mergedPatches, "mergedPatches"),
  };
}

export function parseShotBatchRequest(value: unknown, subject = "ShotBatchRequest"): ShotBatchRequest {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "version", "kind", "phase", "capability", "backendInstanceId", "arcId", "anchorPreference",
    "compiler", "taskIdPrefix", "createdAt", "useTerritories", "rights", "moderation", "license",
    "profileId", "samplePolicy", "gpuEstimate", "shots", "script",
  ], subject, ["shotIds"]);
  if (row.version !== 1) fail(`${subject}.version`, "必须是 1");
  if (row.kind !== SHOT_BATCH_REQUEST_KIND) fail(`${subject}.kind`, `必须是 ${SHOT_BATCH_REQUEST_KIND}`);
  if (row.phase !== "sample" && row.phase !== "bulk") fail(`${subject}.phase`, "必须是 sample 或 bulk");
  if (row.anchorPreference !== "keyframes" && row.anchorPreference !== "references") {
    fail(`${subject}.anchorPreference`, "必须是 keyframes 或 references");
  }
  const taskIdPrefix = requireText(row.taskIdPrefix, `${subject}.taskIdPrefix`, 32);
  if (!TASK_PREFIX.test(taskIdPrefix)) fail(`${subject}.taskIdPrefix`, "必须是安全前缀");
  const identifier = (candidate: unknown, field: string): string | null => {
    if (candidate === null) return null;
    const parsed = requireText(candidate, `${subject}.${field}`, 128);
    if (!SAFE_ID.test(parsed)) fail(`${subject}.${field}`, "必须是安全标识符");
    return parsed;
  };
  const shots = requireArray(row.shots, `${subject}.shots`, MAX_SHOT_BATCH_SHOTS);
  const script = parseScriptSource(row.script, `${subject}.script`);
  if ((shots.length === 0) === (script === null)) {
    fail(subject, "必须且只能提供 shots[] 或 script 之一");
  }
  return {
    version: 1,
    kind: SHOT_BATCH_REQUEST_KIND,
    phase: row.phase,
    capability: row.capability === null
      ? null
      : parseBackendCapabilities(row.capability, `${subject}.capability`),
    backendInstanceId: identifier(row.backendInstanceId, "backendInstanceId"),
    arcId: identifier(row.arcId, "arcId"),
    anchorPreference: row.anchorPreference,
    compiler: requireText(row.compiler, `${subject}.compiler`, 128),
    taskIdPrefix,
    createdAt: requireText(row.createdAt, `${subject}.createdAt`, 64),
    useTerritories: requireArray(row.useTerritories, `${subject}.useTerritories`, 64)
      .map((entry, index) => requireText(entry, `${subject}.useTerritories[${index}]`, 16)),
    rights: row.rights,
    moderation: row.moderation,
    license: row.license,
    profileId: identifier(row.profileId, "profileId"),
    samplePolicy: parseSamplePolicy(row.samplePolicy, `${subject}.samplePolicy`),
    gpuEstimate: parseGpuEstimate(row.gpuEstimate, `${subject}.gpuEstimate`),
    shots,
    script,
    shotIds: parseShotIdSelection(row.shotIds, `${subject}.shotIds`),
  };
}

/** 把剧本预填结果补齐为可编译 draft；剧本与合并结果的事实字段不接受改写。 */
export function applyShotDraftPatches(
  drafts: readonly ShotRequestDraft[],
  patches: readonly ShotDraftPatch[],
): ShotRequestDraft[] {
  const byShotId = new Map(patches.map((patch) => [patch.shotId, patch] as const));
  const applied = new Set<string>();
  const out = drafts.map((draft) => {
    const patch = byShotId.get(draft.shotId);
    if (patch === undefined) return draft;
    applied.add(patch.shotId);
    const next: Record<string, unknown> = { ...draft };
    for (const member of SHOT_DRAFT_PATCH_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, member)) continue;
      if (member === "scene") {
        // 字段级合并：只覆盖灯光与陈设，场景身份与时段/内外仍取剧本场景头。
        next.scene = { ...draft.scene, ...(patch.scene as Record<string, unknown>) };
      } else if (member === "continuity") {
        // 字段级合并：stageGroup 与 prevShotId 取预填/合并结果，操作者只补连续性输入本身。
        next.continuity = { ...draft.continuity, ...(patch.continuity as Record<string, unknown>) };
      } else {
        next[member] = patch[member];
      }
    }
    return parseShotRequestDraft(next, `ShotRequestDraft(${draft.shotId})`);
  });
  const unmatched = patches.filter((patch) => !applied.has(patch.shotId)).map((patch) => patch.shotId);
  if (unmatched.length) {
    fail("ShotBatchRequest.script 的补齐", `指向不存在的镜头：${unmatched.join("、")}（合并会改变存活 shotId）`);
  }
  return out;
}

// —— 视觉侧默认值（§6.1 字段来源、§6.2 关键帧来源） ——

export type ShotBatchIssue = {
  source: "compile" | "prefill" | "merge" | "visual" | "upstream";
  code: string;
  field: string;
  severity: "error" | "warning";
  message: string;
};
export type ShotBatchDraftIssue = ShotBatchIssue & { shotId: string };

/**
 * 用 `visual/mappings.v1.json` 与候选图的 `shotIds` 填 draft 里仍为空的字段：
 *   - `scene.lightingStateId` 取 `(sceneId, timeOfDay)`，`scene.dressingVariantId` 取 `(sceneId, arcId)`；
 *   - `continuity.firstFrame` 取排到该镜且已批准的候选图（origin `approved-candidate`）。
 * draft 已显式给出的值一律不覆盖——人工补齐优先于表查。排到该镜但尚未批准的候选图不填，
 * 只记 warning：批准是并行人工轨道，未批准不是错误，但也不能当成首帧用。
 */
export function applyVisualDefaults(
  drafts: readonly ShotRequestDraft[],
  visual: VisualCompileInputs,
  options: { arcId: string | null },
): { drafts: ShotRequestDraft[]; issues: ShotBatchDraftIssue[] } {
  const issues: ShotBatchDraftIssue[] = [];
  const lighting = new Map((visual.mappings?.lighting ?? []).map(
    (row) => [`${row.sceneId} ${row.timeOfDay}`, row.lightingStateId] as const));
  const dressing = new Map((visual.mappings?.dressing ?? []).map(
    (row) => [`${row.sceneId} ${row.arcId}`, row.dressingVariantId] as const));
  const out = drafts.map((draft) => {
    const scene: Record<string, unknown> = { ...draft.scene };
    if (draft.scene.lightingStateId === null) {
      const hit = lighting.get(`${draft.scene.sceneId} ${draft.scene.timeOfDay}`);
      if (hit !== undefined) scene.lightingStateId = hit;
    }
    if (draft.scene.dressingVariantId === null && options.arcId !== null) {
      const hit = dressing.get(`${draft.scene.sceneId} ${options.arcId}`);
      if (hit !== undefined) scene.dressingVariantId = hit;
    }
    let continuity: Record<string, unknown> = { ...draft.continuity };
    const candidate = visual.candidatesByShotId[draft.shotId];
    if (candidate !== undefined && draft.continuity.firstFrame === null) {
      if (candidate.status === "approved") {
        continuity = {
          ...continuity,
          firstFrame: {
            asset: candidate.asset,
            origin: { kind: "approved-candidate", candidateId: candidate.candidateId },
            containsRealFace: candidate.containsRealFace,
          },
        };
      } else {
        issues.push({
          shotId: draft.shotId,
          source: "visual",
          code: "candidate-not-approved",
          field: "continuity.firstFrame",
          severity: "warning",
          message: `候选图 ${candidate.candidateId} 排到本镜但状态为 ${candidate.status}，未作为首帧填入`,
        });
      }
    }
    return parseShotRequestDraft({ ...draft, scene, continuity }, `ShotRequestDraft(${draft.shotId})`);
  });
  return { drafts: out, issues };
}

// —— 计划文档 ——

export type ShotBatchDecision = {
  shotId: string;
  profileId: string;
  backendInstanceId: string;
  modelFamily: string;
  durationSeconds: number;
  storyboardDurationSeconds: number;
  reason: string;
};

export type ShotBatchEstimate = {
  shotId: string;
  profileId: string;
  durationSeconds: number;
  basis: "tariff";
  microsPerOutputSecond: number;
  priceAsOf: string;
  estimatedAmountMicros: number;
  maximumAmountMicros: number;
};

export type ShotBatchDroppedReference = {
  shotId: string;
  purpose: ReferenceInput["purpose"];
  priority: ReferenceInput["priority"];
  sha256: string;
};

export type ShotBatchShotValidation = {
  shotId: string;
  mode: ValidationReport["mode"];
  errors: number;
  warnings: number;
  issues: ShotBatchIssue[];
};

export type ShotBatchDegradation = Degradation & { shotId: string };

export type ShotBatchEntry = {
  shotId: string;
  taskId: string;
  /**
   * 是否落在本次镜头筛选内。未选中的镜头仍然在这份清单里列出（连同 `selectionReason`），
   * 但不编译、不进 intents、不计估算，因此 `planId` / `profileId` / `wave` 等都为 null。
   */
  selected: boolean;
  /** 未选中时说明为什么被筛掉；选中时为 null。 */
  selectionReason: string | null;
  /**
   * 单 intent 确认指纹；`--confirm` 逐 intent 用它调用 `commitProductionTaskEnqueue`。
   * 带 error 级 issue 的镜头不产出 ShotRequest 与 intent，这四项为 null（整批也随之 blocked）。
   */
  planId: string | null;
  profileId: string | null;
  wave: number | null;
  isSample: boolean;
  shotRequestSha256: string | null;
  shotRequestAsset: AssetRef | null;
  idempotencyKey: string | null;
};

/**
 * 承接链波次。承接只成立于已入库的上游 take（见 `resolveCarryChain`），批次内部没有顺序约束，
 * 因此本版恒为一波；形状保留给消费方（`--confirm` 的提交顺序与 §4.7 的计划文档）。
 */
export type ShotBatchWave = { index: number; shotIds: string[] };

export type ShotBatchPlan = {
  version: 1;
  kind: typeof SHOT_BATCH_PLAN_KIND;
  workspaceId: string;
  project: string;
  batchPlanId: string;
  policyDigest: string;
  phase: ShotBatchPhase;
  taskIdPrefix: string;
  /** 批次文档的 `createdAt`；`--confirm` 把它写进批次审批记录作 `approvedAt`。 */
  createdAt: string;
  /** 本次筛选命中的镜头（升序）；未筛选时为全部镜头。计入 `policyDigest`。 */
  selectedShotIds: string[];
  samplePolicy: ShotBatchSamplePolicy;
  /** 有任一镜头带 error 级 issue 时为 true：`--confirm` 拒绝提交整批。 */
  blocked: boolean;
  shots: ShotBatchEntry[];
  waves: ShotBatchWave[];
  decisions: ShotBatchDecision[];
  estimates: ShotBatchEstimate[];
  droppedReferences: ShotBatchDroppedReference[];
  degradations: ShotBatchDegradation[];
  validation: {
    errors: number;
    warnings: number;
    requiresReapproval: boolean;
    shots: ShotBatchShotValidation[];
  };
  totals: {
    shots: number;
    estimatedAmountMicros: number;
    maximumAmountMicros: number;
    /** §4.7：GPU 小时只作批次规模参考，不构成阻断条件。 */
    gpu: (ShotBatchGpuEstimate & { estimatedUsd: number }) | null;
  };
};

export type ShotBatchProjectPolicy = {
  allowedProcessingRegions: readonly string[];
  licenseCompliance: ProductionLicenseCompliance;
  usesOutputToImproveModels: boolean;
};

export type BuildShotBatchPlanInputs = {
  workspaceId: string;
  project: string;
  request: ShotBatchRequest;
  snapshot: ProductionExecutionProfileSnapshotRead;
  /** 本项目已授权 workflow 的 `workflowSha256` 集合（§4.2 digest 交叉校验）。 */
  authorizedWorkflowSha256: ReadonlySet<string>;
  projectPolicy: ShotBatchProjectPolicy;
  visual: VisualCompileInputs;
  drafts: readonly ShotRequestDraft[];
  /**
   * 本项目的本地权威账本。`--plan` 只读它：`previous-shot-last-frame` 的上游 take 是否已存在、
   * 是否还活着、尾帧是不是当前这一张，只有账本能取证（§4.7）。
   */
  ledger: ProductionState;
  /**
   * 按镜头筛选后的存活集合（命令行 `--shot` 与文档 `shotIds` 的交集）；null = 不筛选。
   * 指向不存在镜头的筛选是操作者错误，直接拒绝出计划。
   */
  selection?: readonly string[] | null;
  /** 预填 / 合并 / 视觉侧装配阶段的提示，进入每镜 validation 并计入 warnings。 */
  draftIssues?: readonly ShotBatchDraftIssue[];
  /**
   * `--from-script` 批次置 true：剧本预填给不出 `output.seed`，而落到 H3 graph 契约 v2 档
   * （capability `seed: "uint32"`）的镜头必须有一个具体整数才能材料化（§5.3）。逐镜按选定的档判定，
   * 落到 v1 档的镜头不派生也不报警。`shots[]` 直接给出的 draft 不适用：那里的 seed 由操作者写死。
   */
  deriveSeedWhenNull?: boolean;
};

type ShotBatchSnapshotProfile = ProductionExecutionProfileSnapshotReadEntry;

type CompiledShot = {
  draft: ShotRequestDraft;
  entry: ShotBatchSnapshotProfile;
  capability: ShotCompileCapability;
  reason: string;
  shotRequest: ShotRequest | null;
  intent: ProductionDispatchIntent | null;
  intentDraft: ProductionIntentDraft | null;
  estimate: ShotBatchEstimate;
  validation: ValidationReport;
  degradations: Degradation[];
};

export type ShotBatchCompilation = { plan: ShotBatchPlan; compiled: CompiledShot[] };

/** 家族与 provider 唯一决定后端形态；不猜、不配置第二处。 */
function backendKindFor(execution: ShotExecutionProfile): BackendKind {
  if (execution.modelFamily === "minimax-h3") return "comfyui";
  if (execution.modelFamily === "veo") return "vertex-veo";
  return execution.provider === "volcengine-ark" ? "volcengine-ark" : "byteplus-modelark";
}

/**
 * 本批次的目标后端：请求显式声明 > capability 声明 > 快照中唯一的 backendInstanceId。
 * 快照含多个后端而请求未声明时拒绝——选错后端的批次会把镜头发到另一台机器上。
 */
export function shotBatchBackendInstanceId(
  snapshot: ProductionExecutionProfileSnapshotRead,
  request: Pick<ShotBatchRequest, "backendInstanceId" | "capability">,
): string {
  const declared = request.backendInstanceId ?? request.capability?.backendInstanceId ?? null;
  const available = [...new Set(snapshot.profiles.map((entry) => entry.execution.backendInstanceId))];
  if (declared !== null) {
    if (!available.includes(declared)) {
      fail("ShotBatchRequest.backendInstanceId", `快照中没有后端 ${declared}（已配置：${available.join("、")}）`);
    }
    return declared;
  }
  if (available.length !== 1) {
    fail("ShotBatchRequest.backendInstanceId", `快照含多个后端（${available.join("、")}），必须显式声明目标后端`);
  }
  return available[0]!;
}

/** 同一输出形状（后端 + 画幅 + 音频意图）下的候选档；时长选档只在这个集合内进行。 */
export function shotBatchCandidateProfiles(
  snapshot: ProductionExecutionProfileSnapshotRead,
  shape: { backendInstanceId: string; aspectRatio: string; generateAudio: boolean },
): ProductionExecutionProfileSnapshotReadEntry[] {
  return snapshot.profiles.filter((entry) =>
    entry.execution.backendInstanceId === shape.backendInstanceId
    && entry.execution.aspectRatio === shape.aspectRatio
    && entry.execution.generateAudio === shape.generateAudio);
}

/** 镜头合并的时长上界 = 候选档集合的最大时长档；没有候选档即无法出片，拒绝。 */
export function shotBatchMaxStoryboardSeconds(
  entries: readonly ProductionExecutionProfileSnapshotReadEntry[],
  shape: { aspectRatio: string; generateAudio: boolean },
): number {
  const durations = entries.flatMap((entry) => [...entry.durationGrid]);
  if (durations.length === 0) {
    fail("ShotBatchPlan", `快照没有 ${shape.aspectRatio} / generateAudio=${shape.generateAudio} 的 execution profile`);
  }
  return Math.max(...durations);
}

/**
 * 快照与 capability 描述的是同一个后端：地域与时长网格必须一致（比较前两侧都规范化排序，
 * 顺序差异不构成不一致）。真正不等即两者之一已过期，此时估算与编译判据来自不同事实，
 * 计划不可信——拒绝出计划而不是取其一。
 */
function assertLimitsAgree(
  entry: ShotBatchSnapshotProfile,
  capability: Required<BackendCapabilities>,
): VideoBackendLimits {
  const subject = `execution profile ${entry.profileId}`;
  if (entry.execution.backendInstanceId !== capability.backendInstanceId) {
    fail(subject, `backendInstanceId ${entry.execution.backendInstanceId} 与 capability ${capability.backendInstanceId} 不一致`);
  }
  if (!capability.modelFamilies.includes(entry.execution.modelFamily)) {
    fail(subject, `capability 未声明 ${entry.execution.modelFamily} 家族`);
  }
  const key = executionLimitsKey(entry.execution);
  const limits = capability.limitsByModelId[key];
  if (limits === undefined) fail(subject, "capability.limitsByModelId 缺少该 profileId 的能力上限");
  const grid = limits.durationSeconds.grid;
  const ascending = (values: readonly number[]): number[] => [...values].sort((left, right) => left - right);
  if (grid === null
    || productionCanonicalJson(ascending(grid)) !== productionCanonicalJson(ascending(entry.durationGrid))) {
    fail(subject, `快照 durationGrid ${JSON.stringify([...entry.durationGrid])} 与 capability 时长网格 ${JSON.stringify(grid)} 不一致`);
  }
  if (productionCanonicalJson(sorted(entry.processingRegions))
    !== productionCanonicalJson(sorted(capability.processingRegions))) {
    fail(subject, `快照 processingRegions ${JSON.stringify(sorted(entry.processingRegions))} 与 capability ${JSON.stringify(sorted(capability.processingRegions))} 不一致`);
  }
  if (entry.limits !== undefined
    && productionCanonicalJson(entry.limits) !== productionCanonicalJson(limits)) {
    fail(subject, "快照 limits 与 capability.limitsByModelId 不一致");
  }
  return limits;
}

/**
 * 编译器消费的 capability 子集。快照带 `limits` 时以快照为准（registry 是 profile 正本的持有方），
 * 请求同时给出 capability 时逐项交叉校验；快照不带 `limits` 时只能取请求供给的那份。
 */
function capabilityFor(
  entry: ShotBatchSnapshotProfile,
  request: ShotBatchRequest,
): ShotCompileCapability {
  const declared = request.capability;
  if (entry.limits === undefined && declared === null) {
    fail(`execution profile ${entry.profileId}`,
      "快照未带 limits 且批次请求未提供 capability；编译器没有可用的能力上限");
  }
  const limits = declared === null ? entry.limits! : assertLimitsAgree(entry, declared);
  return {
    backendKind: declared?.backendKind ?? backendKindFor(entry.execution),
    backendInstanceId: entry.execution.backendInstanceId,
    modelFamilies: [entry.execution.modelFamily],
    processingRegions: sorted(entry.processingRegions),
    limitsByModelId: { [executionLimitsKey(entry.execution)]: entry.limits ?? limits },
  };
}

function selectProfile(
  draft: ShotRequestDraft,
  inputs: BuildShotBatchPlanInputs,
  backendInstanceId: string,
): { entry: ShotBatchSnapshotProfile; reason: string } {
  const request = inputs.request;
  if (request.profileId !== null) {
    const entry = inputs.snapshot.profiles.find((row) => row.profileId === request.profileId);
    if (entry === undefined) fail("ShotBatchRequest.profileId", `快照中没有 profile ${request.profileId}`);
    return { entry, reason: `批次显式指定 profileId=${entry.profileId}` };
  }
  const shape = {
    backendInstanceId,
    aspectRatio: draft.output.aspectRatio as string,
    generateAudio: draft.output.generateAudio,
  };
  // 先按输出形状收敛候选档，再在这个集合内按时长网格上取整——跨画幅或跨音频意图选档等于选错档。
  const candidates = shotBatchCandidateProfiles(inputs.snapshot, shape);
  if (candidates.length === 0) {
    fail(`镜头 ${draft.shotId}`,
      `快照没有 ${backendInstanceId} 上 ${shape.aspectRatio} / generateAudio=${shape.generateAudio} 的 execution profile`);
  }
  const selected = selectH3ProfileForDuration(
    draft.output.storyboardDurationSeconds, candidates.map((row) => row.execution),
  );
  if (selected === null) {
    const grid = [...new Set(candidates.flatMap((row) => [...row.durationGrid]))].sort((a, b) => a - b);
    fail(`镜头 ${draft.shotId}`,
      `分镜时长 ${draft.output.storyboardDurationSeconds}s 没有可容纳的时长档（该输出形状的网格为 [${grid.join(",")}]）`);
  }
  const entry = candidates.find((row) => row.profileId === selected.profileId)!;
  return {
    entry,
    reason: `${shape.aspectRatio}/audio=${shape.generateAudio} 的候选档 [${entry.durationGrid.join(",")}]`
      + `，分镜 ${draft.output.storyboardDurationSeconds}s 上取整到 ${selected.durationSeconds}s`,
  };
}

function profileDurationSeconds(profile: ShotExecutionProfile): number {
  if (profile.modelFamily !== "minimax-h3") {
    fail(`execution profile ${profile.profileId}`, "本版 plan-shots 只支持 minimax-h3 execution profile（云家族随 Phase 3 / 4 落地）");
  }
  return profile.durationSeconds;
}

function estimateFor(draft: ShotRequestDraft, entry: ShotBatchSnapshotProfile): ShotBatchEstimate {
  const durationSeconds = profileDurationSeconds(entry.execution);
  const priceTable = entry.priceTable;
  if (priceTable === null) {
    fail(`execution profile ${entry.profileId}`, "快照未配置价目表，无法给出批次估算（不出无法计价的计划）");
  }
  const estimatedAmountMicros = priceTable.microsPerOutputSecond * durationSeconds;
  if (!Number.isSafeInteger(estimatedAmountMicros)) {
    fail(`execution profile ${entry.profileId}`, "估算超出安全整数范围");
  }
  return {
    shotId: draft.shotId,
    profileId: entry.profileId,
    durationSeconds,
    basis: "tariff",
    microsPerOutputSecond: priceTable.microsPerOutputSecond,
    priceAsOf: priceTable.priceAsOf,
    estimatedAmountMicros,
    maximumAmountMicros: Math.ceil(estimatedAmountMicros * SHOT_BATCH_MAXIMUM_MULTIPLIER),
  };
}

function taskIdFor(prefix: string, shotId: string): string {
  const taskId = `${prefix}-${shotId}`;
  if (!SAFE_ID.test(taskId)) fail("ShotBatchRequest.taskIdPrefix", `拼出的 taskId ${taskId} 不是安全标识符`);
  return taskId;
}

/**
 * `previous-shot-last-frame` 的上游取证（§4.7）。承接只有一种成立方式：上游 take 已在本项目账本里、
 * 状态 ∈ {qc-pending, approved}、该 take 的尾帧资产就是本镜声明的这一张（sha256 / byteLength /
 * mediaType 逐项相同；`uri` 不比——同一份对象在账本里是 `urn:sha256:`，在批次文档里可以写成
 * `cas://`），且该 take 的 shot 身份确实是 origin 声明的那一镜。
 *
 * 不存在「批内承接」：ShotRequest 不可变且携带尾帧的 `asset.sha256`，上游还没出片时这个 digest
 * 只能是猜的；即便猜对，`--confirm` 之后的精确重放也会看到上游落在 dispatch-pending 而被判不可用。
 * 因此逐镜推进的走法是——镜头 N 出片并 QC 之后，下一批次用它**实际**的尾帧 AssetRef 出镜头 N+1。
 *
 * dispatch-requested / running / failed / rejected 的 take 没有可用尾帧：「跑过」不等于「跑出来了」。
 */
function resolveCarryChain(
  draft: ShotRequestDraft,
  context: { ledgerByTaskId: ReadonlyMap<string, ProductionTask>; inBatch: ReadonlySet<string> },
): ShotBatchIssue[] {
  const byTaskId = context.ledgerByTaskId;
  const issues: ShotBatchIssue[] = [];
  const slots = [
    ["continuity.firstFrame", draft.continuity.firstFrame] as const,
    ["continuity.lastFrame", draft.continuity.lastFrame] as const,
  ];
  for (const [field, keyframe] of slots) {
    if (keyframe === null || keyframe.origin.kind !== "previous-shot-last-frame") continue;
    const origin = keyframe.origin;
    const error = (message: string): void => {
      issues.push({
        source: "upstream", code: "upstream-take-unavailable", field, severity: "error", message,
      });
    };
    const task = byTaskId.get(origin.taskId);
    if (task === undefined) {
      error(`上游 take ${origin.taskId} 不在本项目账本内`
        + (context.inBatch.has(origin.shotId)
          ? `（${origin.shotId} 在本批次里，但批内承接不成立：上游必须先出片并到 QC，下一批次才能引用它的实际尾帧）`
          : ""));
      continue;
    }
    if (task.status !== "qc-pending" && task.status !== "approved") {
      error(`上游 take ${origin.taskId} 处于 ${task.status}；尾帧承接只接受 qc-pending 或 approved`);
      continue;
    }
    if (task.subject.kind !== "shot" || task.subject.shot.shotId !== origin.shotId) {
      error(`上游 take ${origin.taskId} 的镜头是 `
        + `${task.subject.kind === "shot" ? task.subject.shot.shotId : `整集 ${task.subject.episode.episodeId}`}`
        + `，与 origin 声明的 ${origin.shotId} 不一致`);
      continue;
    }
    const lastFrames = task.assets.filter((asset) => asset.mediaType.startsWith("image/"));
    if (lastFrames.length !== 1) {
      error(`上游 take ${origin.taskId} 有 ${lastFrames.length} 个尾帧资产，无法确定承接来源`);
      continue;
    }
    const upstream = lastFrames[0]!;
    const drift = (["sha256", "byteLength", "mediaType"] as const)
      .filter((key) => upstream[key] !== keyframe.asset[key]);
    if (drift.length) {
      error(`上游 take ${origin.taskId} 的尾帧与本镜声明的不一致（${drift.map((key) =>
        `${key} ${String(upstream[key])} ≠ ${String(keyframe.asset[key])}`).join("；")}）`);
    }
  }
  return issues;
}

function defaultSamplePolicy(compiled: readonly CompiledShot[], phase: ShotBatchPhase): ShotBatchSamplePolicy {
  if (phase === "bulk") {
    fail("ShotBatchRequest.samplePolicy", "phase: bulk 必须显式声明 sampleShotIds（样片门要检查的是先前批次的样片）");
  }
  // 缺省每个被选 profile 各 1 镜（§4.7）：批次顺序里该 profile 的第一镜。
  const seen = new Set<string>();
  const sampleShotIds: string[] = [];
  for (const row of compiled) {
    if (seen.has(row.entry.profileId)) continue;
    seen.add(row.entry.profileId);
    sampleShotIds.push(row.draft.shotId);
  }
  return { sampleShotIds, requireApprovedSampleBeforeBulk: true };
}

export function buildShotBatchPlan(inputs: BuildShotBatchPlanInputs): ShotBatchCompilation {
  const request = inputs.request;
  const drafts = inputs.drafts.map((draft) => parseShotRequestDraft(draft));
  if (drafts.length === 0) fail("ShotBatchPlan", "批次至少要有一个镜头");
  if (drafts.length > MAX_SHOT_BATCH_SHOTS) fail("ShotBatchPlan", `批次最多 ${MAX_SHOT_BATCH_SHOTS} 个镜头`);
  if (new Set(drafts.map((draft) => draft.shotId)).size !== drafts.length) {
    fail("ShotBatchPlan", "同一批次内 shotId 不得重复");
  }
  // draft 声明的视觉清单版本必须就是本次装配 policy 的那一版：不等即 approvedCandidates / propStates
  // 与镜头所依据的事实不是同一份。
  for (const draft of drafts) {
    const declared = draft.provenance.visualProductionSha256;
    if (declared !== null && declared !== inputs.visual.visualProductionSha256) {
      fail(`镜头 ${draft.shotId}`,
        `provenance.visualProductionSha256 ${declared} 与当前 visual/production.v1.json ${inputs.visual.visualProductionSha256 ?? "（不存在）"} 不一致`);
    }
  }
  // 按镜头筛选：命令行 `--shot` 与文档 `shotIds` 的交集，在预填 / 合并 / 视觉填充之后、编译之前
  // 生效。指向不存在镜头的筛选是操作者错误（合并会改变存活 shotId），拒绝出计划而不是静默少跑。
  const allShotIds = drafts.map((draft) => draft.shotId);
  const requested = inputs.selection ?? null;
  if (requested !== null) {
    const known = new Set(allShotIds);
    const stray = requested.filter((shotId) => !known.has(shotId));
    if (stray.length) {
      fail("ShotBatchPlan 的镜头筛选",
        `指向不存在的镜头：${stray.join("、")}（本批次存活镜头：${allShotIds.join("、")}）`);
    }
  }
  const selectedShotIds = new Set(requested ?? allShotIds);
  const selectedDrafts = drafts.filter((draft) => selectedShotIds.has(draft.shotId));
  if (selectedDrafts.length === 0) fail("ShotBatchPlan", "镜头筛选之后至少要留下一个镜头");
  const backendInstanceId = shotBatchBackendInstanceId(inputs.snapshot, request);
  const usedProfiles = new Map<string, ShotBatchSnapshotProfile>();
  const usedCapabilities = new Map<string, ShotCompileCapability>();

  const compiled: CompiledShot[] = selectedDrafts.map((selected) => {
    const { entry, reason } = selectProfile(selected, inputs, backendInstanceId);
    const capability = capabilityFor(entry, request);
    if (!inputs.authorizedWorkflowSha256.has(entry.execution.workflowSha256)) {
      fail(`execution profile ${entry.profileId}`,
        `workflowSha256 ${entry.execution.workflowSha256} 不在本项目已授权的 workflows[] 内（快照与 runtime config 不同步）`);
    }
    usedProfiles.set(entry.profileId, entry);
    usedCapabilities.set(entry.profileId, capability);
    // §5.3 契约 v2 的 seed：按该镜实际选定的档判定，落到 v1 档的镜头不派生。派生在选档之后、
    // 编译之前，draft 此时已经过合并、mergedPatches 与视觉填充，取值因此由最终镜头内容决定。
    const seedDegradations: Degradation[] = [];
    let draft = selected;
    if (inputs.deriveSeedWhenNull === true && draft.output.seed === null
      && capability.limitsByModelId[executionLimitsKey(entry.execution)]?.seed === "uint32") {
      const derived = withDerivedShotSeed(draft);
      draft = derived.draft;
      if (derived.degradation !== null) seedDegradations.push(derived.degradation);
    }
    const estimate = estimateFor(draft, entry);
    const policy: ShotCompilePolicy = {
      version: 1,
      anchorPreference: request.anchorPreference,
      casAuthority: inputs.snapshot.casAuthority,
      compiler: request.compiler,
      execution: entry.execution,
      project: {
        allowedProcessingRegions: [...inputs.projectPolicy.allowedProcessingRegions],
        licenseCompliance: parseProductionLicenseCompliance(
          {
            annualRevenueUsdBelow: inputs.projectPolicy.licenseCompliance.annualRevenueUsdBelow,
            attributionSurfaces: [...inputs.projectPolicy.licenseCompliance.attributionSurfaces],
          },
          "ShotBatchPlan.project.licenseCompliance",
        ),
        usesOutputToImproveModels: inputs.projectPolicy.usesOutputToImproveModels,
      },
      approvedCandidates: inputs.visual.approvedCandidates,
      propStates: inputs.visual.propStates,
      intent: {
        taskId: taskIdFor(request.taskIdPrefix, draft.shotId),
        createdAt: request.createdAt,
        useTerritories: request.useTerritories,
        budget: {
          version: 1,
          currency: "USD",
          estimatedAmountMicros: estimate.estimatedAmountMicros,
          maximumAmountMicros: estimate.maximumAmountMicros,
        },
        rights: request.rights as ShotCompilePolicy["intent"]["rights"],
        moderation: request.moderation as ShotCompilePolicy["intent"]["moderation"],
        license: request.license as ShotCompilePolicy["intent"]["license"],
      },
    };
    const result = compileShotRequest(draft, capability, policy);
    return {
      draft,
      entry,
      capability,
      reason,
      shotRequest: result.shotRequest,
      intentDraft: result.intentDraft,
      intent: result.intentDraft === null ? null : createProductionDispatchIntent(result.intentDraft),
      estimate,
      validation: result.validation,
      degradations: [...seedDegradations, ...result.degradations],
    };
  });

  // 承接链取证：上游 take 的账本状态与尾帧身份。承接只成立于已入库的 take，因此本批次内部没有
  // 顺序约束——`waves[]` 保留给消费方，但恒为一波。
  const carryContext = {
    ledgerByTaskId: new Map(inputs.ledger.tasks.map((task) => [task.id, task] as const)),
    inBatch: new Set(allShotIds),
  };
  const carryChain = new Map<string, ShotBatchIssue[]>(
    compiled.map((row) => [row.draft.shotId, resolveCarryChain(row.draft, carryContext)]),
  );
  const waves: ShotBatchWave[] = [{ index: 0, shotIds: compiled.map((row) => row.draft.shotId) }];
  const waveByShotId = new Map(waves.flatMap((wave) => wave.shotIds.map((shotId) => [shotId, wave.index] as const)));
  const samplePolicy = request.samplePolicy ?? defaultSamplePolicy(compiled, request.phase);
  const batchShotIds = new Set(compiled.map((row) => row.draft.shotId));
  if (request.phase === "sample") {
    const stray = samplePolicy.sampleShotIds.filter((shotId) => !batchShotIds.has(shotId));
    if (stray.length) fail("ShotBatchRequest.samplePolicy", `sample 批次的样片必须在本批次内：${stray.join("、")}`);
  }

  const profileOrder = (left: { profileId: string }, right: { profileId: string }): number =>
    left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0;
  const policyDigest = productionCanonicalJsonSha256({
    version: 1,
    phase: request.phase,
    anchorPreference: request.anchorPreference,
    compiler: request.compiler,
    casAuthority: inputs.snapshot.casAuthority,
    taskIdPrefix: request.taskIdPrefix,
    backendInstanceId,
    arcId: request.arcId,
    // 选中集合进入指纹：同一份批次文档筛出不同镜头就是不同的批次，批准不可互相顶替。
    selectedShotIds: sorted([...selectedShotIds]),
    project: {
      allowedProcessingRegions: [...inputs.projectPolicy.allowedProcessingRegions],
      licenseCompliance: {
        annualRevenueUsdBelow: inputs.projectPolicy.licenseCompliance.annualRevenueUsdBelow,
        attributionSurfaces: [...inputs.projectPolicy.licenseCompliance.attributionSurfaces],
      },
      usesOutputToImproveModels: inputs.projectPolicy.usesOutputToImproveModels,
    },
    // 编译真正用到的 capability（快照或请求供给），而不是请求的原始字面量。
    capabilities: [...usedCapabilities.entries()]
      .map(([profileId, capability]) => ({ profileId, capability }))
      .sort(profileOrder),
    // 快照条目的 digest 已覆盖 execution、时长网格、价目与许可：价目一改，batchPlanId 立刻失效。
    profiles: [...usedProfiles.values()]
      .map((entry) => ({ profileId: entry.profileId, profileDigest: entry.profileDigest }))
      .sort(profileOrder),
    samplePolicy,
    intentScaffold: {
      createdAt: request.createdAt,
      useTerritories: request.useTerritories,
      rights: request.rights,
      moderation: request.moderation,
      license: request.license,
    },
    // 视觉侧四张表都参与判定：候选图批准、道具状态、灯光/陈设映射、镜头到候选图的排期。
    visual: {
      approvedCandidates: { ...inputs.visual.approvedCandidates },
      propStates: { ...inputs.visual.propStates },
      mappings: inputs.visual.mappings,
      candidatesByShotId: { ...inputs.visual.candidatesByShotId },
    },
  });

  const degradations: ShotBatchDegradation[] = compiled.flatMap((row) =>
    row.degradations.map((entry) => ({ shotId: row.draft.shotId, ...entry })));
  const intents = compiled.flatMap((row) => (row.intent === null ? [] : [row.intent]));
  const batchPlanId = createHash("sha256").update(productionCanonicalJson({
    workspace: inputs.workspaceId,
    project: inputs.project,
    intents,
    policyDigest,
    degradations,
  }), "utf8").digest("hex");

  const sampleShotIds = new Set(samplePolicy.sampleShotIds);
  const compiledByShotId = new Map(compiled.map((row) => [row.draft.shotId, row] as const));
  // 未选中的镜头也列出：操作者要能一眼看到这一批到底少跑了哪几镜、为什么少跑。
  const shots: ShotBatchEntry[] = drafts.map((draft) => {
    const row = compiledByShotId.get(draft.shotId);
    if (row === undefined) {
      return {
        shotId: draft.shotId,
        taskId: taskIdFor(request.taskIdPrefix, draft.shotId),
        selected: false,
        selectionReason: "未在本次镜头筛选内（--shot / 批次文档 shotIds）",
        planId: null,
        profileId: null,
        wave: null,
        isSample: false,
        shotRequestSha256: null,
        shotRequestAsset: null,
        idempotencyKey: null,
      };
    }
    return {
      shotId: row.draft.shotId,
      taskId: taskIdFor(request.taskIdPrefix, row.draft.shotId),
      selected: true,
      selectionReason: null,
      planId: row.intentDraft === null ? null : planProductionTaskEnqueue({
        workspaceId: inputs.workspaceId,
        project: inputs.project,
        draft: row.intentDraft,
      }).planId,
      profileId: row.entry.profileId,
      wave: waveByShotId.get(row.draft.shotId)!,
      isSample: sampleShotIds.has(row.draft.shotId),
      shotRequestSha256: row.shotRequest === null ? null : productionCanonicalJsonSha256(row.shotRequest),
      shotRequestAsset: row.shotRequest === null
        ? null
        : shotRequestAssetRef(row.shotRequest, inputs.snapshot.casAuthority),
      idempotencyKey: row.intent?.idempotencyKey ?? null,
    };
  });

  // 预填 / 合并 / 视觉侧装配的提示与编译 issue 汇入同一份 per-shot 清单，一起计入 warnings。
  // 被筛掉的镜头没有编译结果，因此也没有 validation 行；指向它们的装配期提示随之落地。
  const draftIssues = inputs.draftIssues ?? [];
  const knownShotIds = new Set(allShotIds);
  const orphanIssues = draftIssues.filter((issue) => !knownShotIds.has(issue.shotId));
  if (orphanIssues.length) {
    fail("ShotBatchPlan.draftIssues", `提示指向不在批次内的镜头：${orphanIssues.map((issue) => issue.shotId).join("、")}`);
  }
  const shotValidation: ShotBatchShotValidation[] = compiled.map((row) => {
    const extra = draftIssues.filter((issue) => issue.shotId === row.draft.shotId);
    const carry = carryChain.get(row.draft.shotId)!;
    const issues: ShotBatchIssue[] = [
      ...extra.map(({ shotId: _shotId, ...issue }) => issue),
      ...carry,
      ...row.validation.issues.map((issue) => ({ source: "compile" as const, ...issue })),
    ];
    const extraErrors = extra.filter((issue) => issue.severity === "error").length
      + carry.filter((issue) => issue.severity === "error").length;
    const extraWarnings = extra.filter((issue) => issue.severity === "warning").length
      + carry.filter((issue) => issue.severity === "warning").length;
    return {
      shotId: row.draft.shotId,
      mode: row.validation.mode,
      errors: row.validation.errors + extraErrors,
      warnings: row.validation.warnings + extraWarnings,
      issues,
    };
  });
  const errors = shotValidation.reduce((sum, row) => sum + row.errors, 0);
  const warnings = shotValidation.reduce((sum, row) => sum + row.warnings, 0);
  const estimates = compiled.map((row) => row.estimate);
  const plan: ShotBatchPlan = {
    version: 1,
    kind: SHOT_BATCH_PLAN_KIND,
    workspaceId: inputs.workspaceId,
    project: inputs.project,
    batchPlanId,
    policyDigest,
    phase: request.phase,
    taskIdPrefix: request.taskIdPrefix,
    createdAt: request.createdAt,
    selectedShotIds: sorted([...selectedShotIds]),
    samplePolicy,
    blocked: errors > 0,
    shots,
    waves,
    decisions: compiled.map((row) => ({
      shotId: row.draft.shotId,
      profileId: row.entry.profileId,
      backendInstanceId: row.entry.execution.backendInstanceId,
      modelFamily: row.entry.execution.modelFamily,
      durationSeconds: row.estimate.durationSeconds,
      storyboardDurationSeconds: row.draft.output.storyboardDurationSeconds,
      reason: row.reason,
    })),
    estimates,
    droppedReferences: compiled.flatMap((row) =>
      (row.shotRequest?.continuity.droppedReferences ?? []).map((reference) => ({
        shotId: row.draft.shotId,
        purpose: reference.purpose,
        priority: reference.priority,
        sha256: reference.asset.sha256,
      }))),
    degradations,
    validation: {
      errors,
      warnings,
      requiresReapproval: degradations.some((entry) => entry.requiresReapproval),
      shots: shotValidation,
    },
    totals: {
      shots: compiled.length,
      estimatedAmountMicros: estimates.reduce((sum, row) => sum + row.estimatedAmountMicros, 0),
      maximumAmountMicros: estimates.reduce((sum, row) => sum + row.maximumAmountMicros, 0),
      gpu: request.gpuEstimate === null ? null : {
        ...request.gpuEstimate,
        estimatedUsd: request.gpuEstimate.spotUsdPerHour * request.gpuEstimate.estimatedHours,
      },
    },
  };
  return { plan, compiled };
}

// —— 确认与提交 ——

export type CommitShotBatchResult = {
  version: 1;
  batchPlanId: string;
  shots: Array<{
    shotId: string;
    taskId: string;
    shotRequestSha256: string;
    casObjectCreated: boolean;
    /** 批次审批记录（batchPlanId / samplePolicy / taskIdPrefix）是否本次新建。 */
    batchApprovalCreated: boolean;
    intentCreated: boolean;
    taskCreated: boolean;
    dispatchApplied: boolean;
    status: ProductionTask["status"];
  }>;
};

export type CommitShotBatchOptions = {
  root: string;
  workspaceId: string;
  project: string;
  compilation: ShotBatchCompilation;
  confirm: string;
  /** 样片门（§4.7）：`phase: bulk` 时按 taskId 读取本地权威账本，全部 approved 才放行。 */
  readState: () => ProductionState;
};

/**
 * 样片门：`phase: bulk` 的批次只有在 `samplePolicy.sampleShotIds` 对应的 task 全部 approved 时才提交。
 * 缺失的 task 与非 approved 的 task 同样阻断——「没跑过样片」不等于「样片通过」。
 * taskId 由 `taskIdPrefix` 拼出，因此样片批次与 bulk 批次必须用同一个前缀。
 */
export function assertSampleGate(plan: ShotBatchPlan, state: ProductionState): void {
  if (plan.phase !== "bulk") return;
  const byId = new Map(state.tasks.map((task) => [task.id, task] as const));
  const failures: string[] = [];
  for (const shotId of plan.samplePolicy.sampleShotIds) {
    const taskId = taskIdFor(plan.taskIdPrefix, shotId);
    const task = byId.get(taskId);
    if (task === undefined) failures.push(`${shotId}（${taskId} 尚未入库）`);
    else if (task.status !== "approved") failures.push(`${shotId}（${taskId} 为 ${task.status}）`);
  }
  if (failures.length) {
    fail("样片门", `phase: bulk 要求样片全部 approved，未通过：${failures.join("、")}`
      + "（taskId 由 taskIdPrefix 拼出，样片批次与本批次必须用同一前缀）");
  }
}

export function commitShotBatchPlan(options: CommitShotBatchOptions): CommitShotBatchResult {
  const { plan, compiled } = options.compilation;
  if (options.confirm !== plan.batchPlanId) {
    throw new ProductionError("plan-shots 确认指纹不匹配；请重新执行 --plan");
  }
  if (plan.blocked) {
    throw new ProductionError(`批次含 ${plan.validation.errors} 条 error 级校验问题；修正后重新出计划`);
  }
  assertSampleGate(plan, options.readState());

  const byShotId = new Map(compiled.map((row) => [row.draft.shotId, row] as const));
  const entryByShotId = new Map(plan.shots.map((entry) => [entry.shotId, entry] as const));
  const ordered = plan.waves.flatMap((wave) => wave.shotIds);
  const shots: CommitShotBatchResult["shots"] = [];
  for (const shotId of ordered) {
    const row = byShotId.get(shotId)!;
    const entry = entryByShotId.get(shotId)!;
    if (row.shotRequest === null || row.intentDraft === null || entry.planId === null) {
      throw new ProductionError(`镜头 ${shotId} 没有可提交的 ShotRequest（本版只有 minimax-h3 家族产出 intent）`);
    }
    // ShotRequest 逐字节写入 CAS：文件名 = 内容 sha256 = intent inputs[0].sha256（§4.1）。
    const bytes = Buffer.from(shotRequestCanonicalJson(row.shotRequest), "utf8");
    const written = writeProductionCasObject(options.root, options.project, bytes);
    if (written.sha256 !== entry.shotRequestAsset?.sha256 || written.sha256 !== entry.shotRequestSha256) {
      throw new ProductionError(`镜头 ${shotId} 的 ShotRequest 字节 digest 与计划不一致`);
    }
    const result = commitProductionTaskEnqueue({
      root: options.root,
      workspaceId: options.workspaceId,
      project: options.project,
      draft: row.intentDraft,
      confirm: entry.planId,
    });
    // 批次审批记录只在本次确实创建了 task 时写：它回答的是「这个 task 是在哪一份批次审批下发布的」。
    // task 已在账本内（精确重放、或 2b 之前发布）时本次没有发布任何东西，一律不写也不改——否则一份
    // 只是路过的批次会把自己的 batchPlanId 绑到别人发布的 take 上，handoff 会据此发出两条无据的门。
    // 崩溃窗口（task 已建、记录未写）退化为该 take 只出 qc-approved，不会出现错绑。
    let batchApprovalCreated = false;
    if (result.taskCreated) {
      batchApprovalCreated = writeProductionBatchApproval(options.root, options.project, {
        version: 1,
        kind: PRODUCTION_BATCH_APPROVAL_KIND,
        taskId: entry.taskId,
        shotId,
        batchPlanId: plan.batchPlanId,
        taskIdPrefix: plan.taskIdPrefix,
        phase: plan.phase,
        sampleShotIds: plan.samplePolicy.sampleShotIds,
        approvedAt: plan.createdAt,
      }).created;
    }
    shots.push({
      shotId,
      taskId: result.task.id,
      shotRequestSha256: written.sha256,
      casObjectCreated: written.created,
      batchApprovalCreated,
      intentCreated: result.intentCreated,
      taskCreated: result.taskCreated,
      dispatchApplied: result.dispatchApplied,
      status: result.task.status,
    });
  }
  return { version: 1, batchPlanId: plan.batchPlanId, shots };
}
