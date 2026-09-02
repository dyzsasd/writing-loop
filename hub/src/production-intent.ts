// Immutable Phase 3B dispatch intents and their pure pre-dispatch policy gates.
//
// An intent is the durable boundary between writing-loop and a remote production coordinator.
// It binds the exact subject revision, backend configuration digests, stable input assets and the
// evidence used to authorize one billable request.  Adapters must consume the parsed intent rather
// than rebuilding a request from mutable configuration.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  MAX_PRODUCTION_COST_MICROS,
  ProductionError,
  parseAssetRef,
  parseProductionSubjectRef,
  type AssetRef,
  type ProductionSubjectRef,
} from "./production-domain.ts";
import { NON_ISO_PROCESSING_REGIONS } from "./production-adapter.ts";
// 只在 parseInputs 内取值：production-shot-request.ts 反向依赖本模块，模块顶层引用会落进 TDZ。
import { SHOT_REQUEST_MEDIA_TYPE } from "./production-shot-request.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_INTENT_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_INTENT_DIRECTORY = "production-intents.v1";
export const MAX_PRODUCTION_INTENT_BYTES = 256 * 1024;
export const MAX_PRODUCTION_INTENT_INPUTS = 32;
export const MAX_PRODUCTION_INTENT_TERRITORIES = 64;
export const MAX_PRODUCTION_INTENT_ATTRIBUTION_SURFACES = 32;

export const PRODUCTION_INTENT_OPERATIONS = [
  "comfyui-workflow", "minimax-h3", "ark-video-task", "vertex-veo-lro",
] as const;
export type ProductionIntentOperation = typeof PRODUCTION_INTENT_OPERATIONS[number];

/** Transport and model identity are separate: H3 may execute through a ComfyUI workflow. */
export const PRODUCTION_MODEL_FAMILIES = ["generic", "minimax-h3", "seedance", "veo"] as const;
export type ProductionModelFamily = typeof PRODUCTION_MODEL_FAMILIES[number];

export const H3_VARIANTS = ["fl2va", "ref2va"] as const;
export type H3Variant = typeof H3_VARIANTS[number];

/** 火山方舟用 `doubao-` 前缀，BytePlus ModelArk 用 `dreamina-` 前缀（DESIGN §5.1）。 */
export const SEEDANCE_MODEL_IDS = [
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615",
  "doubao-seedance-2-5-260628",
  "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-fast-260128",
  "dreamina-seedance-2-0-mini-260615",
  "dreamina-seedance-2-5-260628",
] as const;
export type SeedanceModelId = typeof SEEDANCE_MODEL_IDS[number];

export const SEEDANCE_PROVIDERS = ["volcengine-ark", "byteplus-modelark"] as const;
export type SeedanceProvider = typeof SEEDANCE_PROVIDERS[number];

/** 画幅枚举以 ShotRequest 为准；4:3 / 3:4 / adaptive 不在 v1 支持（§4.2）。 */
export const SEEDANCE_ASPECT_RATIOS = ["16:9", "1:1", "9:16", "21:9"] as const;
export type SeedanceAspectRatio = typeof SEEDANCE_ASPECT_RATIOS[number];

export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export type SeedanceResolution = typeof SEEDANCE_RESOLUTIONS[number];

/** `execution_expires_after` 的 provider 区间（§5.1），按批次规模配置。 */
export const SEEDANCE_EXECUTION_EXPIRY_SECONDS = { minimum: 3_600, maximum: 259_200 } as const;

export const VEO_MODEL_IDS = [
  "veo-3.1-generate-001", "veo-3.1-fast-generate-001", "veo-3.1-lite-generate-001",
] as const;
export type VeoModelId = typeof VEO_MODEL_IDS[number];

export const VEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type VeoAspectRatio = typeof VEO_ASPECT_RATIOS[number];

export const VEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
export type VeoResolution = typeof VEO_RESOLUTIONS[number];

export const VEO_IO_MODES = ["inline-base64", "gcs"] as const;
export type VeoIoMode = typeof VEO_IO_MODES[number];

/** §4.2：fast / mini 只允许 480p / 720p；4k 只允许 `*-seedance-2-0-260128`。 */
const SEEDANCE_RESOLUTIONS_BY_MODEL_ID: Readonly<Record<SeedanceModelId, readonly SeedanceResolution[]>> = {
  "doubao-seedance-2-0-260128": ["480p", "720p", "1080p", "4k"],
  "doubao-seedance-2-0-fast-260128": ["480p", "720p"],
  "doubao-seedance-2-0-mini-260615": ["480p", "720p"],
  "doubao-seedance-2-5-260628": ["480p", "720p", "1080p"],
  "dreamina-seedance-2-0-260128": ["480p", "720p", "1080p", "4k"],
  "dreamina-seedance-2-0-fast-260128": ["480p", "720p"],
  "dreamina-seedance-2-0-mini-260615": ["480p", "720p"],
  "dreamina-seedance-2-5-260628": ["480p", "720p", "1080p"],
};

/** §4.2：lite 与 fast 只允许 720p / 1080p（fast 的 4k 在探针前拒绝）；generate-001 允许 4k。 */
const VEO_RESOLUTIONS_BY_MODEL_ID: Readonly<Record<VeoModelId, readonly VeoResolution[]>> = {
  "veo-3.1-generate-001": ["720p", "1080p", "4k"],
  "veo-3.1-fast-generate-001": ["720p", "1080p"],
  "veo-3.1-lite-generate-001": ["720p", "1080p"],
};

/** §5.1：火山方舟的 modelId 用 `doubao-` 前缀、BytePlus ModelArk 用 `dreamina-`，两者不得交叉下发。 */
const SEEDANCE_MODEL_ID_PROVIDER: Readonly<Record<SeedanceModelId, SeedanceProvider>> = {
  "doubao-seedance-2-0-260128": "volcengine-ark",
  "doubao-seedance-2-0-fast-260128": "volcengine-ark",
  "doubao-seedance-2-0-mini-260615": "volcengine-ark",
  "doubao-seedance-2-5-260628": "volcengine-ark",
  "dreamina-seedance-2-0-260128": "byteplus-modelark",
  "dreamina-seedance-2-0-fast-260128": "byteplus-modelark",
  "dreamina-seedance-2-0-mini-260615": "byteplus-modelark",
  "dreamina-seedance-2-5-260628": "byteplus-modelark",
};

/**
 * §5.1：Seedance 2.x 拒绝真人人脸参考，gate `provider-likeness-policy` 据此判定。逐 modelId 列表而不是
 * 版本号正则——新 modelId 进枚举时类型强制在这里补齐结论，不会被前缀匹配默默归类。
 */
const SEEDANCE_LIKENESS_POLICY: Readonly<Record<SeedanceModelId, "likeness-restricted" | "unrestricted">> = {
  "doubao-seedance-2-0-260128": "likeness-restricted",
  "doubao-seedance-2-0-fast-260128": "likeness-restricted",
  "doubao-seedance-2-0-mini-260615": "likeness-restricted",
  "doubao-seedance-2-5-260628": "likeness-restricted",
  "dreamina-seedance-2-0-260128": "likeness-restricted",
  "dreamina-seedance-2-0-fast-260128": "likeness-restricted",
  "dreamina-seedance-2-0-mini-260615": "likeness-restricted",
  "dreamina-seedance-2-5-260628": "likeness-restricted",
};

/** H3 v1 intentionally exposes only the output shapes the coordinator can validate end-to-end. */
export const H3_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type H3AspectRatio = typeof H3_ASPECT_RATIOS[number];

export const H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES = ["EU", "GB", "KR", "US"] as const;

/** ISO-3166 alpha-2 members of the European Union (2026), all covered by the H3 EU exclusion. */
export const EU_MEMBER_TERRITORIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;

type ProductionExecutionBase = {
  version: 1;
  operation: ProductionIntentOperation;
  modelFamily: ProductionModelFamily;
  backendInstanceId: string;
  workflowSha256: string;
  modelSha256: string;
  parametersSha256: string;
};

export type ProductionIntentExecution =
  | ProductionExecutionBase & {
      operation: "comfyui-workflow";
      modelFamily: "generic";
    }
  | ProductionExecutionBase & {
      /** H3 may be transported by the direct gateway or by a pinned ComfyUI workflow. */
      operation: "comfyui-workflow" | "minimax-h3";
      modelFamily: "minimax-h3";
      variant: H3Variant;
      durationSeconds: number;
      shortEdge: 768;
      aspectRatio: H3AspectRatio;
    }
  // 云家族的字段全部是 execution profile 的静态值；逐镜变量（模式、时长、seed、输入 slot、prompt）
  // 一律由 inputs[0] 的 ShotRequest 决定（§4.2 修正 F1），因此这两个分支没有 durationSeconds。
  | ProductionExecutionBase & {
      operation: "ark-video-task";
      modelFamily: "seedance";
      provider: SeedanceProvider;
      modelId: SeedanceModelId;
      resolution: SeedanceResolution;
      aspectRatio: SeedanceAspectRatio;
      generateAudio: boolean;
      watermark: false;
      returnLastFrame: true;
      executionExpiresAfterSeconds: number;
    }
  | ProductionExecutionBase & {
      operation: "vertex-veo-lro";
      modelFamily: "veo";
      modelId: VeoModelId;
      location: "us-central1";
      resolution: VeoResolution;
      aspectRatio: VeoAspectRatio;
      generateAudio: boolean;
      sampleCount: 1;
      ioMode: VeoIoMode;
    };

export type ProductionIntentBudget = {
  version: 1;
  currency: "USD";
  estimatedAmountMicros: number;
  maximumAmountMicros: number;
};

export type ProductionRightsEvidence = {
  version: 1;
  status: "cleared" | "unknown" | "expired" | "blocked";
  territories: string[];
  evidence: AssetRef | null;
  expiresAt: string | null;
};

export type ProductionModerationEvidence = {
  version: 1;
  status: "passed" | "not-reviewed" | "failed";
  reviewedAt: string | null;
  evidence: AssetRef | null;
};

/**
 * 许可文本附加的持续义务（§4.2）。MiniMax H3 Community License IV.1 / IV.2 / V.3 对应
 * `{attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true}`。
 */
export type ProductionLicenseObligations = {
  /** 必须署名的名称；null = 无署名义务。 */
  attribution: string | null;
  /** 许可只对年收入低于该 USD 阈值的使用者生效；null = 无收入门槛。 */
  revenueThresholdUsd: number | null;
  /** 输出不得用于改进其他模型。 */
  noModelImprovement: boolean;
};

/**
 * 项目侧对许可义务的声明（runtime `projects[].licenseCompliance`，§4.7）。intent gate 与
 * `compileShotRequest` 共用同一形状与同一判据（`licenseObligationViolations`），不存在第二份定义。
 */
export type ProductionLicenseCompliance = {
  /** 项目声明的年收入上界（USD）；null = 未声明。 */
  annualRevenueUsdBelow: number | null;
  /** 已落实署名的展示面（发布文案、片尾……）；空数组 = 未落实。 */
  attributionSurfaces: string[];
};

export type ProductionLicenseEvidence = {
  version: 1;
  status: "verified" | "unknown" | "blocked";
  basis: "community" | "provider-terms" | "written-license";
  territories: string[];
  licenseSha256: string | null;
  evidence: AssetRef | null;
  issuedBy: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /**
   * 缺省与显式 null 一律规范化为「不带该键」——旧 intent JSON 的 canonical 形态与 idempotencyKey
   * 因此逐字节不变（`ProductionLicenseObligations`，gate 见 §4.7）。
   */
  obligations?: ProductionLicenseObligations | null;
};

export type ProductionIntentDraft = {
  version: 1;
  taskId: string;
  subject: ProductionSubjectRef;
  createdAt: string;
  useTerritories: string[];
  execution: ProductionIntentExecution;
  inputs: AssetRef[];
  budget: ProductionIntentBudget;
  rights: ProductionRightsEvidence;
  moderation: ProductionModerationEvidence;
  license: ProductionLicenseEvidence;
};

export type ProductionDispatchIntent = ProductionIntentDraft & {
  /** SHA-256 of the complete canonical parsed draft. */
  idempotencyKey: string;
};

/**
 * 本次 dispatch 的输入是否含真人人脸。intent `inputs[]` 只有 AssetRef，不携带 ShotRequest 的
 * `containsRealFace`，因此该结论由 gate context 的供给方汇总后声明；`undeclared` 表示未证明不含。
 */
export const PRODUCTION_INTENT_REAL_FACE_DECLARATIONS = ["undeclared", "present", "absent"] as const;
export type ProductionIntentRealFaceDeclaration = typeof PRODUCTION_INTENT_REAL_FACE_DECLARATIONS[number];

export type ProductionIntentGateContext = {
  version: 1;
  evaluatedAt: string;
  deploymentTerritories: string[];
  availableBudgetMicros: number;
  /**
   * 以下四项来自 runtime `projects[]` 与后端 capability（§4.7）。runtime config 尚未持有这些字段
   * （§8.6 的 `production-runtime-config.ts` 行），因此解析层允许缺省：缺省即「未声明」，
   * 其判定结果与 §4.7 中的空集合形态一致（region 无可比对项，obligations 与真人人脸 deny）。
   */
  backendProcessingRegions?: string[];
  allowedProcessingRegions?: string[];
  licenseCompliance?: ProductionLicenseCompliance;
  realFaceInputs?: ProductionIntentRealFaceDeclaration;
};

export const PRODUCTION_INTENT_GATE_CODES = [
  "budget-maximum-exceeded",
  "budget-available-exceeded",
  "processing-region-not-allowed",
  "rights-not-cleared",
  "rights-evidence-missing",
  "rights-territory-missing",
  "rights-expired",
  "moderation-not-passed",
  "moderation-evidence-missing",
  "moderation-from-future",
  "license-not-verified",
  "license-evidence-missing",
  "license-territory-missing",
  "license-expired",
  "license-issued-in-future",
  "license-obligation-unmet",
  "h3-written-license-required",
  "provider-likeness-policy",
] as const;

export type ProductionIntentGateCode = typeof PRODUCTION_INTENT_GATE_CODES[number];

export type ProductionIntentGateFailure = {
  version: 1;
  code: ProductionIntentGateCode;
  message: string;
};

export type ProductionIntentGateDecision = {
  version: 1;
  allowed: boolean;
  failures: ProductionIntentGateFailure[];
};

/** Coordinator dependency port. Implementations may load the immutable companion locally or remotely. */
export interface ProductionIntentResolver {
  resolve(taskId: string, signal?: AbortSignal): Promise<ProductionDispatchIntent | null>;
}

export type EnqueueProductionIntentResult = {
  created: boolean;
  path: string;
  intent: ProductionDispatchIntent;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERRITORY = /^(?:[A-Z]{2}|WORLDWIDE)$/;
const PROCESSING_REGION = /^[A-Z]{2}$/;
const RIGHTS_STATUSES = new Set(["cleared", "unknown", "expired", "blocked"]);
const MODERATION_STATUSES = new Set(["passed", "not-reviewed", "failed"]);
const LICENSE_STATUSES = new Set(["verified", "unknown", "blocked"]);
const LICENSE_BASES = new Set(["community", "provider-terms", "written-license"]);
const H3_VARIANT_SET = new Set<string>(H3_VARIANTS);
const H3_ASPECT_RATIO_SET = new Set<string>(H3_ASPECT_RATIOS);
const RESTRICTED_H3_TERRITORIES = new Set<string>(H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES);
const EU_MEMBER_TERRITORY_SET = new Set<string>(EU_MEMBER_TERRITORIES);

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
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
  /** 可缺省的键；省略它们必须保持既有解析结果逐字节不变。 */
  optional: readonly string[] = [],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key) && !optional.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function requireEnum<T extends string>(value: unknown, subject: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(subject, `必须是 ${allowed.join("、")} 之一`);
  }
  return value as T;
}

function requireBoolean(value: unknown, subject: string): boolean {
  if (typeof value !== "boolean") fail(subject, "必须是布尔值");
  return value;
}

function requireVersion(value: unknown, subject: string): void {
  if (value !== PRODUCTION_INTENT_SCHEMA_VERSION) fail(subject, "version 必须是 1");
}

function requireSafeInteger(
  value: unknown,
  subject: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function requireId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail(subject, "必须是 1–128 位安全标识符");
  }
  return value;
}

function requireOpaque(value: unknown, subject: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(subject, `必须是 1–${maximum} 位且不含控制字符的字符串`);
  }
  return value;
}

function requireIso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "必须是规范 UTC ISO-8601 时间");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail(subject, "必须是规范 UTC ISO-8601 时间");
  }
  return value;
}

function nullableIso(value: unknown, subject: string): string | null {
  return value === null ? null : requireIso(value, subject);
}

function requireSha256(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(subject, "必须是 64 位小写十六进制 sha256");
  return value;
}

function nullableSha256(value: unknown, subject: string): string | null {
  return value === null ? null : requireSha256(value, subject);
}

function nullableOpaque(value: unknown, subject: string): string | null {
  return value === null ? null : requireOpaque(value, subject);
}

function parseTerritories(value: unknown, subject: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) fail(subject, "必须是地域数组");
  if ((!allowEmpty && value.length === 0) || value.length > MAX_PRODUCTION_INTENT_TERRITORIES) {
    fail(subject, `必须包含 ${allowEmpty ? "0" : "1"}–${MAX_PRODUCTION_INTENT_TERRITORIES} 个地域`);
  }
  const parsed = value.map((territory, index) => {
    if (typeof territory !== "string" || !TERRITORY.test(territory)) {
      fail(`${subject}[${index}]`, "必须是大写二位地域码、EU 或 WORLDWIDE");
    }
    return territory;
  });
  if (new Set(parsed).size !== parsed.length) fail(subject, "不得包含重复地域");
  if (parsed.includes("WORLDWIDE") && parsed.length !== 1) {
    fail(subject, "WORLDWIDE 必须单独使用，不能与具体地域混合");
  }
  return [...parsed].sort();
}

/**
 * 逐镜变量全部由 `inputs[0]` 的 ShotRequest 决定，因此云家族的 `inputs[0]` 必须是 ShotRequest
 * （§4.2、§8.6）。H3 在 graph 契约 v2（Phase 1）落地前保持现状——契约 v1 的 stage 绑定没有 index 0 的
 * `shot-request` slot；届时把该家族改为 true 即可。
 */
const FAMILIES_REQUIRING_SHOT_REQUEST_INPUT: Readonly<Record<ProductionModelFamily, boolean>> = {
  generic: false,
  "minimax-h3": false,
  seedance: true,
  veo: true,
};

/**
 * 云后端在 provider 自有地域处理素材，项目必须显式声明允许地域后才能 dispatch；本地 ComfyUI（H3 与
 * generic）在 runtime `projects[]` 供给 `allowedProcessingRegions` 前暂不强制（§4.7）。该表是那次改动的
 * 唯一改动点：四个值一起置 true 即为全家族 deny。
 */
const FAMILIES_REQUIRING_PROCESSING_REGIONS: Readonly<Record<ProductionModelFamily, boolean>> = {
  generic: false,
  "minimax-h3": false,
  seedance: true,
  veo: true,
};

/**
 * 逐镜可变的输入必须经 scoped staging 边界登记；generic 的图是静态 pinned 输入（§8.6 家族表）。
 * coordinator 的 dispatch 判定与 runtime config 的 workflow / staging profile 校验共用这一份。
 */
export const REQUIRES_SCOPED_STAGING: Readonly<Record<ProductionModelFamily, boolean>> = {
  generic: false,
  "minimax-h3": true,
  seedance: true,
  veo: true,
};

function parseInputs(value: unknown, subject: string, modelFamily: ProductionModelFamily): AssetRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRODUCTION_INTENT_INPUTS) {
    fail(subject, `必须是 1–${MAX_PRODUCTION_INTENT_INPUTS} 项 AssetRef 数组`);
  }
  const inputs = value.map((entry, index) => parseAssetRef(entry, `${subject}[${index}]`));
  const identities = inputs.map((entry) => `${entry.uri}\0${entry.sha256}`);
  if (new Set(identities).size !== identities.length) fail(subject, "不得包含重复 AssetRef");
  if (FAMILIES_REQUIRING_SHOT_REQUEST_INPUT[modelFamily] && inputs[0].mediaType !== SHOT_REQUEST_MEDIA_TYPE) {
    fail(`${subject}[0]`, `${modelFamily} 家族的 inputs[0] 必须是 ShotRequest（mediaType ${SHOT_REQUEST_MEDIA_TYPE}）`);
  }
  return inputs;
}

export function parseProductionIntentExecution(
  value: unknown,
  subject = "ProductionIntentExecution",
): ProductionIntentExecution {
  const row = requireRecord(value, subject);
  const common = [
    "version", "operation", "modelFamily", "backendInstanceId", "workflowSha256", "modelSha256",
    "parametersSha256",
  ] as const;
  if (row.modelFamily === "generic") {
    exactKeys(row, common, subject);
    requireVersion(row.version, subject);
    if (row.operation !== "comfyui-workflow") {
      fail(`${subject}.operation`, "generic modelFamily 只允许 comfyui-workflow transport");
    }
    return {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "generic",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
    };
  }
  if (row.modelFamily === "minimax-h3") {
    exactKeys(row, [...common, "variant", "durationSeconds", "shortEdge", "aspectRatio"], subject);
    requireVersion(row.version, subject);
    if (row.operation !== "comfyui-workflow" && row.operation !== "minimax-h3") {
      fail(`${subject}.operation`, "H3 transport 必须是 comfyui-workflow 或 minimax-h3");
    }
    if (typeof row.variant !== "string" || !H3_VARIANT_SET.has(row.variant)) {
      fail(`${subject}.variant`, "必须是 fl2va 或 ref2va");
    }
    if (row.shortEdge !== 768) fail(`${subject}.shortEdge`, "H3 v1 必须固定为 768");
    if (typeof row.aspectRatio !== "string" || !H3_ASPECT_RATIO_SET.has(row.aspectRatio)) {
      fail(`${subject}.aspectRatio`, `必须是 ${H3_ASPECT_RATIOS.join("、")}`);
    }
    return {
      version: 1,
      operation: row.operation,
      modelFamily: "minimax-h3",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
      variant: row.variant as H3Variant,
      durationSeconds: requireSafeInteger(row.durationSeconds, `${subject}.durationSeconds`, 4, 15),
      shortEdge: 768,
      aspectRatio: row.aspectRatio as H3AspectRatio,
    };
  }
  if (row.modelFamily === "seedance") {
    exactKeys(row, [
      ...common, "provider", "modelId", "resolution", "aspectRatio", "generateAudio", "watermark",
      "returnLastFrame", "executionExpiresAfterSeconds",
    ], subject);
    requireVersion(row.version, subject);
    if (row.operation !== "ark-video-task") {
      fail(`${subject}.operation`, "seedance transport 必须是 ark-video-task");
    }
    const modelId = requireEnum(row.modelId, `${subject}.modelId`, SEEDANCE_MODEL_IDS);
    const resolution = requireEnum(row.resolution, `${subject}.resolution`, SEEDANCE_RESOLUTIONS);
    const allowedResolutions = SEEDANCE_RESOLUTIONS_BY_MODEL_ID[modelId];
    if (!allowedResolutions.includes(resolution)) {
      fail(`${subject}.resolution`, `${modelId} 只支持 ${allowedResolutions.join("、")}`);
    }
    const provider = requireEnum(row.provider, `${subject}.provider`, SEEDANCE_PROVIDERS);
    const modelIdProvider = SEEDANCE_MODEL_ID_PROVIDER[modelId];
    if (provider !== modelIdProvider) {
      fail(`${subject}.provider`, `${modelId} 只在 ${modelIdProvider} 下发（modelId 前缀与 endpoint 必须一致）`);
    }
    if (row.watermark !== false) fail(`${subject}.watermark`, "必须固定为 false");
    if (row.returnLastFrame !== true) fail(`${subject}.returnLastFrame`, "必须固定为 true");
    return {
      version: 1,
      operation: "ark-video-task",
      modelFamily: "seedance",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
      provider,
      modelId,
      resolution,
      aspectRatio: requireEnum(row.aspectRatio, `${subject}.aspectRatio`, SEEDANCE_ASPECT_RATIOS),
      generateAudio: requireBoolean(row.generateAudio, `${subject}.generateAudio`),
      watermark: false,
      returnLastFrame: true,
      executionExpiresAfterSeconds: requireSafeInteger(
        row.executionExpiresAfterSeconds,
        `${subject}.executionExpiresAfterSeconds`,
        SEEDANCE_EXECUTION_EXPIRY_SECONDS.minimum,
        SEEDANCE_EXECUTION_EXPIRY_SECONDS.maximum,
      ),
    };
  }
  if (row.modelFamily === "veo") {
    exactKeys(row, [
      ...common, "modelId", "location", "resolution", "aspectRatio", "generateAudio", "sampleCount",
      "ioMode",
    ], subject);
    requireVersion(row.version, subject);
    if (row.operation !== "vertex-veo-lro") {
      fail(`${subject}.operation`, "veo transport 必须是 vertex-veo-lro");
    }
    const modelId = requireEnum(row.modelId, `${subject}.modelId`, VEO_MODEL_IDS);
    const resolution = requireEnum(row.resolution, `${subject}.resolution`, VEO_RESOLUTIONS);
    const allowedResolutions = VEO_RESOLUTIONS_BY_MODEL_ID[modelId];
    if (!allowedResolutions.includes(resolution)) {
      fail(`${subject}.resolution`, `${modelId} 只支持 ${allowedResolutions.join("、")}`);
    }
    if (row.location !== "us-central1") fail(`${subject}.location`, "v1 只接受 us-central1");
    if (row.sampleCount !== 1) fail(`${subject}.sampleCount`, "必须固定为 1");
    return {
      version: 1,
      operation: "vertex-veo-lro",
      modelFamily: "veo",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
      modelId,
      location: "us-central1",
      resolution,
      aspectRatio: requireEnum(row.aspectRatio, `${subject}.aspectRatio`, VEO_ASPECT_RATIOS),
      generateAudio: requireBoolean(row.generateAudio, `${subject}.generateAudio`),
      sampleCount: 1,
      ioMode: requireEnum(row.ioMode, `${subject}.ioMode`, VEO_IO_MODES),
    };
  }
  fail(`${subject}.modelFamily`, `必须是 ${PRODUCTION_MODEL_FAMILIES.join("、")} 之一`);
}

function parseBudget(value: unknown, subject: string): ProductionIntentBudget {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "currency", "estimatedAmountMicros", "maximumAmountMicros"], subject);
  requireVersion(row.version, subject);
  if (row.currency !== "USD") fail(`${subject}.currency`, "v1 仅支持 USD");
  return {
    version: 1,
    currency: "USD",
    estimatedAmountMicros: requireSafeInteger(
      row.estimatedAmountMicros,
      `${subject}.estimatedAmountMicros`,
      0,
      MAX_PRODUCTION_COST_MICROS,
    ),
    maximumAmountMicros: requireSafeInteger(
      row.maximumAmountMicros,
      `${subject}.maximumAmountMicros`,
      1,
      MAX_PRODUCTION_COST_MICROS,
    ),
  };
}

function parseRights(value: unknown, subject: string): ProductionRightsEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "status", "territories", "evidence", "expiresAt"], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !RIGHTS_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 cleared、unknown、expired 或 blocked");
  }
  return {
    version: 1,
    status: row.status as ProductionRightsEvidence["status"],
    territories: parseTerritories(row.territories, `${subject}.territories`, true),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
    expiresAt: nullableIso(row.expiresAt, `${subject}.expiresAt`),
  };
}

function parseModeration(value: unknown, subject: string): ProductionModerationEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "status", "reviewedAt", "evidence"], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !MODERATION_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 passed、not-reviewed 或 failed");
  }
  return {
    version: 1,
    status: row.status as ProductionModerationEvidence["status"],
    reviewedAt: nullableIso(row.reviewedAt, `${subject}.reviewedAt`),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
  };
}

function parseLicenseObligations(value: unknown, subject: string): ProductionLicenseObligations {
  const row = requireRecord(value, subject);
  exactKeys(row, ["attribution", "revenueThresholdUsd", "noModelImprovement"], subject);
  return {
    attribution: row.attribution === null
      ? null
      : requireOpaque(row.attribution, `${subject}.attribution`, 128),
    revenueThresholdUsd: row.revenueThresholdUsd === null
      ? null
      : requireSafeInteger(row.revenueThresholdUsd, `${subject}.revenueThresholdUsd`, 0),
    noModelImprovement: requireBoolean(row.noModelImprovement, `${subject}.noModelImprovement`),
  };
}

export function parseProductionLicenseEvidence(
  value: unknown,
  subject = "ProductionLicenseEvidence",
): ProductionLicenseEvidence {
  return parseLicense(value, subject);
}

export function parseProductionLicenseCompliance(
  value: unknown,
  subject = "ProductionLicenseCompliance",
): ProductionLicenseCompliance {
  return parseLicenseCompliance(value, subject);
}

/**
 * 明确的书面许可 evidence（§4.7）：仅把 `basis` 文本写成 written-license 不算数，必须同时有验证状态、
 * 签发方与签发时间、许可文本 digest 与稳定 evidence AssetRef。H3 受限地域门与许可义务门共用该判据。
 */
export function hasExplicitWrittenLicense(license: ProductionLicenseEvidence): boolean {
  return license.basis === "written-license"
    && license.status === "verified"
    && license.evidence !== null
    && license.licenseSha256 !== null
    && license.issuedBy !== null
    && license.issuedAt !== null;
}

export type ProductionLicenseObligationViolation = {
  clause: "revenue-threshold" | "attribution";
  /** 相对 licenseCompliance 的字段名，供编译器的 ValidationIssue.field 拼装完整路径。 */
  field: "annualRevenueUsdBelow" | "attributionSurfaces";
  message: string;
};

/**
 * 许可义务的唯一判据（§4.7）：intent gate 与 `compileShotRequest` 都调用它，两侧结论必然一致。
 * `noModelImprovement` 不在此判定——项目是否用输出改进其他模型是使用方式而非可在 dispatch 前取证的
 * 声明，只在编译期按项目声明检查（DESIGN §4.1、AI-SPEC 使用约束）。
 */
export function licenseObligationViolations(
  license: ProductionLicenseEvidence,
  compliance: ProductionLicenseCompliance,
  options: { explicitWrittenLicense: boolean },
): ProductionLicenseObligationViolation[] {
  const obligations = license.obligations ?? null;
  if (obligations === null) return [];
  const violations: ProductionLicenseObligationViolation[] = [];
  const threshold = obligations.revenueThresholdUsd;
  if (threshold !== null) {
    const declaredBelowThreshold = compliance.annualRevenueUsdBelow !== null
      && compliance.annualRevenueUsdBelow <= threshold;
    if (!declaredBelowThreshold && !options.explicitWrittenLicense) {
      violations.push({
        clause: "revenue-threshold",
        field: "annualRevenueUsdBelow",
        message: `许可以年收入低于 ${threshold} USD 为条件，项目声明为 ${compliance.annualRevenueUsdBelow ?? "未声明"}，且无明确 written-license evidence`,
      });
    }
  }
  if (obligations.attribution !== null && compliance.attributionSurfaces.length === 0) {
    violations.push({
      clause: "attribution",
      field: "attributionSurfaces",
      message: `许可要求署名「${obligations.attribution}」，项目未声明任何 attributionSurfaces`,
    });
  }
  return violations;
}

function parseLicense(value: unknown, subject: string): ProductionLicenseEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "version", "status", "basis", "territories", "licenseSha256", "evidence", "issuedBy",
    "issuedAt", "expiresAt",
  ], subject, ["obligations"]);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !LICENSE_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 verified、unknown 或 blocked");
  }
  if (typeof row.basis !== "string" || !LICENSE_BASES.has(row.basis)) {
    fail(`${subject}.basis`, "必须是 community、provider-terms 或 written-license");
  }
  const issuedAt = nullableIso(row.issuedAt, `${subject}.issuedAt`);
  const expiresAt = nullableIso(row.expiresAt, `${subject}.expiresAt`);
  if (issuedAt !== null && expiresAt !== null && expiresAt < issuedAt) {
    fail(`${subject}.expiresAt`, "不得早于 issuedAt");
  }
  // 缺省与显式 null 都规范化为「不带该键」：不带义务的旧 intent 的 canonical JSON 与 idempotencyKey 不变。
  const obligations = row.obligations === undefined || row.obligations === null
    ? null
    : parseLicenseObligations(row.obligations, `${subject}.obligations`);
  return {
    version: 1,
    status: row.status as ProductionLicenseEvidence["status"],
    basis: row.basis as ProductionLicenseEvidence["basis"],
    territories: parseTerritories(row.territories, `${subject}.territories`, true),
    licenseSha256: nullableSha256(row.licenseSha256, `${subject}.licenseSha256`),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
    issuedBy: nullableOpaque(row.issuedBy, `${subject}.issuedBy`),
    issuedAt,
    expiresAt,
    ...(obligations === null ? {} : { obligations }),
  };
}

function parseDraftFields(row: Record<string, unknown>, subject: string): ProductionIntentDraft {
  requireVersion(row.version, subject);
  // inputs[0] 的形态按 execution 家族判定，因此 execution 先解析；返回对象的键序保持不变
  // （JSON.stringify 的插入序即 idempotencyKey 的输入）。
  const execution = parseProductionIntentExecution(row.execution, `${subject}.execution`);
  return {
    version: 1,
    taskId: requireId(row.taskId, `${subject}.taskId`),
    subject: parseProductionSubjectRef(row.subject, `${subject}.subject`),
    createdAt: requireIso(row.createdAt, `${subject}.createdAt`),
    useTerritories: parseTerritories(row.useTerritories, `${subject}.useTerritories`),
    execution,
    inputs: parseInputs(row.inputs, `${subject}.inputs`, execution.modelFamily),
    budget: parseBudget(row.budget, `${subject}.budget`),
    rights: parseRights(row.rights, `${subject}.rights`),
    moderation: parseModeration(row.moderation, `${subject}.moderation`),
    license: parseLicense(row.license, `${subject}.license`),
  };
}

const DRAFT_KEYS = [
  "version", "taskId", "subject", "createdAt", "useTerritories", "execution", "inputs",
  "budget", "rights", "moderation", "license",
] as const;

export function parseProductionIntentDraft(
  value: unknown,
  subject = "ProductionIntentDraft",
): ProductionIntentDraft {
  const row = requireRecord(value, subject);
  exactKeys(row, DRAFT_KEYS, subject);
  return parseDraftFields(row, subject);
}

/** Digest the complete parser-canonical draft; JSON insertion order is fixed by parseDraftFields. */
export function productionIntentIdempotencyKey(value: unknown): string {
  const draft = parseProductionIntentDraft(value);
  return createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
}

export function createProductionDispatchIntent(value: unknown): ProductionDispatchIntent {
  const draft = parseProductionIntentDraft(value);
  return { ...draft, idempotencyKey: productionIntentIdempotencyKey(draft) };
}

export function parseProductionDispatchIntent(
  value: unknown,
  subject = "ProductionDispatchIntent",
): ProductionDispatchIntent {
  const row = requireRecord(value, subject);
  exactKeys(row, [...DRAFT_KEYS, "idempotencyKey"], subject);
  const draft = parseDraftFields(row, subject);
  const expected = productionIntentIdempotencyKey(draft);
  const actual = requireSha256(row.idempotencyKey, `${subject}.idempotencyKey`);
  if (actual !== expected) {
    fail(`${subject}.idempotencyKey`, "与 canonical parsed intent 不匹配（拒绝可变配置漂移）");
  }
  return { ...draft, idempotencyKey: expected };
}

/**
 * 处理地域是数据实际被处理的物理位置，只接受 ISO-3166 alpha-2 国家/地区代码。集合别名 EU 与非标准码
 * UK 长得像 alpha-2 但不指向单一处理地，显式拒绝——否则 `allowedProcessingRegions: ["EU"]` 会把
 * 「允许 27 个成员国」写成一个既不匹配 FR 也不匹配 DE 的字面量，判定结果与配置意图相反。
 */
function parseProcessingRegions(value: unknown, subject: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PRODUCTION_INTENT_TERRITORIES) {
    fail(subject, `必须是最多 ${MAX_PRODUCTION_INTENT_TERRITORIES} 项的地域数组`);
  }
  const parsed = value.map((entry, index) => {
    const label = `${subject}[${index}]`;
    if (typeof entry !== "string" || !PROCESSING_REGION.test(entry)) {
      fail(label, "必须是大写二位地域码");
    }
    if (NON_ISO_PROCESSING_REGIONS.has(entry as string)) {
      fail(label, `${entry} 是集合别名或非标准码，处理地域必须写 ISO-3166 alpha-2 成员国代码（EU→FR、DE……；UK→GB）`);
    }
    return entry as string;
  });
  if (new Set(parsed).size !== parsed.length) fail(subject, "不得包含重复地域");
  return [...parsed].sort();
}

function parseLicenseCompliance(value: unknown, subject: string): ProductionLicenseCompliance {
  const row = requireRecord(value, subject);
  exactKeys(row, ["annualRevenueUsdBelow", "attributionSurfaces"], subject);
  const surfaces = row.attributionSurfaces;
  if (!Array.isArray(surfaces) || surfaces.length > MAX_PRODUCTION_INTENT_ATTRIBUTION_SURFACES) {
    fail(`${subject}.attributionSurfaces`, `必须是最多 ${MAX_PRODUCTION_INTENT_ATTRIBUTION_SURFACES} 项的数组`);
  }
  const parsed = surfaces.map((entry, index) =>
    requireOpaque(entry, `${subject}.attributionSurfaces[${index}]`, 128));
  if (new Set(parsed).size !== parsed.length) fail(`${subject}.attributionSurfaces`, "不得包含重复署名面");
  return {
    annualRevenueUsdBelow: row.annualRevenueUsdBelow === null
      ? null
      : requireSafeInteger(row.annualRevenueUsdBelow, `${subject}.annualRevenueUsdBelow`, 0),
    attributionSurfaces: [...parsed].sort(),
  };
}

export function parseProductionIntentGateContext(
  value: unknown,
  subject = "ProductionIntentGateContext",
): ProductionIntentGateContext {
  const row = requireRecord(value, subject);
  exactKeys(
    row,
    ["version", "evaluatedAt", "deploymentTerritories", "availableBudgetMicros"],
    subject,
    ["backendProcessingRegions", "allowedProcessingRegions", "licenseCompliance", "realFaceInputs"],
  );
  requireVersion(row.version, subject);
  const context: ProductionIntentGateContext = {
    version: 1,
    evaluatedAt: requireIso(row.evaluatedAt, `${subject}.evaluatedAt`),
    deploymentTerritories: parseTerritories(
      row.deploymentTerritories,
      `${subject}.deploymentTerritories`,
    ),
    availableBudgetMicros: requireSafeInteger(
      row.availableBudgetMicros,
      `${subject}.availableBudgetMicros`,
      0,
      MAX_PRODUCTION_COST_MICROS,
    ),
  };
  if (row.backendProcessingRegions !== undefined) {
    context.backendProcessingRegions = parseProcessingRegions(
      row.backendProcessingRegions,
      `${subject}.backendProcessingRegions`,
    );
  }
  if (row.allowedProcessingRegions !== undefined) {
    context.allowedProcessingRegions = parseProcessingRegions(
      row.allowedProcessingRegions,
      `${subject}.allowedProcessingRegions`,
    );
  }
  if (row.licenseCompliance !== undefined) {
    context.licenseCompliance = parseLicenseCompliance(
      row.licenseCompliance,
      `${subject}.licenseCompliance`,
    );
  }
  if (row.realFaceInputs !== undefined) {
    context.realFaceInputs = requireEnum(
      row.realFaceInputs,
      `${subject}.realFaceInputs`,
      PRODUCTION_INTENT_REAL_FACE_DECLARATIONS,
    );
  }
  return context;
}

type ProductionIntentGatePolicy = {
  backendProcessingRegions: readonly string[];
  allowedProcessingRegions: readonly string[];
  licenseCompliance: ProductionLicenseCompliance;
  realFaceInputs: ProductionIntentRealFaceDeclaration;
};

/** 未声明的策略字段取「空集合 / 未声明」形态——§4.7 的判定对该形态与显式空值结论相同。 */
function gatePolicy(context: ProductionIntentGateContext): ProductionIntentGatePolicy {
  return {
    backendProcessingRegions: context.backendProcessingRegions ?? [],
    allowedProcessingRegions: context.allowedProcessingRegions ?? [],
    licenseCompliance: context.licenseCompliance
      ?? { annualRevenueUsdBelow: null, attributionSurfaces: [] },
    realFaceInputs: context.realFaceInputs ?? "undeclared",
  };
}

function territoryCovered(grants: readonly string[], territory: string): boolean {
  return grants.includes("WORLDWIDE") || grants.includes(territory);
}

/** Pure and deterministic: invalid wire data throws; valid-but-unapproved evidence returns deny. */
export function evaluateProductionIntentGates(
  intentValue: unknown,
  contextValue: unknown,
): ProductionIntentGateDecision {
  const intent = parseProductionDispatchIntent(intentValue);
  const context = parseProductionIntentGateContext(contextValue);
  const policy = gatePolicy(context);
  const failures: ProductionIntentGateFailure[] = [];
  const deny = (code: ProductionIntentGateCode, message: string): void => {
    failures.push({ version: 1, code, message });
  };

  if (intent.budget.estimatedAmountMicros > intent.budget.maximumAmountMicros) {
    deny("budget-maximum-exceeded", "预算估算超过 intent 的不可变单任务上限");
  }
  if (intent.budget.maximumAmountMicros > context.availableBudgetMicros) {
    deny("budget-available-exceeded", "不可变单任务上限超过本次 gate 的可用预算快照");
  }

  // 处理地域门（§4.7）。runtime config 目前还不供给这两组地域（§8.6 的 runtime-config 行），因此空集合的
  // 语义按家族分裂：云家族的处理地在境外，未声明即 deny；minimax-h3 / generic 暂放行。runtime-config
  // 供给 regions 后改为全家族 deny（EXECUTION-PLAN 的「0-C 审查后的两处遗留」(b)）。
  if (policy.allowedProcessingRegions.length === 0) {
    if (FAMILIES_REQUIRING_PROCESSING_REGIONS[intent.execution.modelFamily]) {
      deny(
        "processing-region-not-allowed",
        `项目未声明 allowedProcessingRegions，${intent.execution.modelFamily} 家族不得 dispatch`,
      );
    }
  } else if (policy.backendProcessingRegions.length === 0) {
    deny(
      "processing-region-not-allowed",
      `后端处理地域未声明，无法与项目 allowedProcessingRegions=[${policy.allowedProcessingRegions.join("、")}] 比对`,
    );
  } else {
    for (const region of policy.backendProcessingRegions) {
      if (!policy.allowedProcessingRegions.includes(region)) {
        deny(
          "processing-region-not-allowed",
          `后端处理地域 ${region} 不在项目 allowedProcessingRegions=[${policy.allowedProcessingRegions.join("、")}] 内`,
        );
      }
    }
  }

  if (intent.rights.status !== "cleared") {
    deny("rights-not-cleared", `rights 状态为 ${intent.rights.status}`);
  }
  if (intent.rights.evidence === null) {
    deny("rights-evidence-missing", "缺少稳定 AssetRef 形式的 rights evidence");
  }
  for (const territory of intent.useTerritories) {
    if (!territoryCovered(intent.rights.territories, territory)) {
      deny("rights-territory-missing", `rights evidence 未覆盖使用地域 ${territory}`);
    }
  }
  if (intent.rights.expiresAt !== null && intent.rights.expiresAt <= context.evaluatedAt) {
    deny("rights-expired", "rights evidence 在 gate 时已过期");
  }

  if (intent.moderation.status !== "passed") {
    deny("moderation-not-passed", `moderation 状态为 ${intent.moderation.status}`);
  }
  if (intent.moderation.evidence === null || intent.moderation.reviewedAt === null) {
    deny("moderation-evidence-missing", "缺少 moderation 时间或稳定 evidence AssetRef");
  } else if (intent.moderation.reviewedAt > context.evaluatedAt) {
    deny("moderation-from-future", "moderation reviewedAt 晚于 gate 时间");
  }

  if (intent.license.status !== "verified" || intent.license.licenseSha256 === null) {
    deny("license-not-verified", `license 状态为 ${intent.license.status} 或缺少 license digest`);
  }
  if (intent.license.evidence === null) {
    deny("license-evidence-missing", "缺少稳定 AssetRef 形式的 license evidence");
  }
  const licenseTerritories = new Set([...intent.useTerritories, ...context.deploymentTerritories]);
  for (const territory of [...licenseTerritories].sort()) {
    if (!territoryCovered(intent.license.territories, territory)) {
      deny("license-territory-missing", `license evidence 未覆盖使用/部署地域 ${territory}`);
    }
  }
  if (intent.license.expiresAt !== null && intent.license.expiresAt <= context.evaluatedAt) {
    deny("license-expired", "license evidence 在 gate 时已过期");
  }
  if (intent.license.issuedAt !== null && intent.license.issuedAt > context.evaluatedAt) {
    deny("license-issued-in-future", "license issuedAt 晚于 gate 时间");
  }

  // 许可附加义务（§4.7）：编译器已提前拒绝一次，这里是 dispatch 前的二次强制，判据与编译器同一函数。
  const explicitWrittenLicense = hasExplicitWrittenLicense(intent.license);
  for (const violation of licenseObligationViolations(
    intent.license, policy.licenseCompliance, { explicitWrittenLicense },
  )) {
    deny("license-obligation-unmet", violation.message);
  }

  if (intent.execution.modelFamily === "minimax-h3") {
    const restricted = new Set<string>();
    if (licenseTerritories.has("WORLDWIDE")) {
      for (const territory of H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES) restricted.add(territory);
    } else {
      for (const territory of licenseTerritories) {
        if (territory === "EU" || EU_MEMBER_TERRITORY_SET.has(territory)) restricted.add("EU");
        else if (territory === "UK") restricted.add("GB");
        else if (RESTRICTED_H3_TERRITORIES.has(territory)) restricted.add(territory);
      }
    }
    if (restricted.size > 0 && !explicitWrittenLicense) {
      deny(
        "h3-written-license-required",
        `MiniMax H3 open-weight license 在 ${[...restricted].sort().join("、")} 默认禁止 dispatch；需要明确 written-license evidence`,
      );
    }
    if (intent.license.basis === "written-license" && !explicitWrittenLicense
      && !failures.some((failure) => failure.code === "h3-written-license-required")) {
      deny("h3-written-license-required", "H3 written-license 必须包含验证状态、签发方/时间、digest 与 evidence");
    }
  }

  // Seedance 2.x 拒绝真人人脸参考（§5.1）：intent inputs[] 不携带该标记，未声明即视为未证明不含。
  if (intent.execution.modelFamily === "seedance"
    && SEEDANCE_LIKENESS_POLICY[intent.execution.modelId] === "likeness-restricted"
    && policy.realFaceInputs !== "absent") {
    deny(
      "provider-likeness-policy",
      `${intent.execution.modelId} 拒绝含真人人脸的输入，本次 realFaceInputs 声明为 ${policy.realFaceInputs}`,
    );
  }

  return { version: 1, allowed: failures.length === 0, failures };
}

function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function assertRealDirectory(path: string, subject: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { fail(subject, `目录不存在：${path}（${error instanceof Error ? error.message : String(error)}）`); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(subject, `必须是真实目录（拒绝 symlink/FIFO/device）：${path}`);
  }
}

function projectDirectory(root: string, project: string): string {
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { fail("ProductionIntent", `workspace root 不存在：${error instanceof Error ? error.message : String(error)}`); }
  const writingLoop = join(canonicalRoot, ".writing-loop");
  const projectPath = join(writingLoop, project);
  assertRealDirectory(writingLoop, "ProductionIntent workspace state");
  assertRealDirectory(projectPath, `ProductionIntent project '${project}'`);
  return projectPath;
}

function intentDirectory(root: string, project: string, create: boolean): string | null {
  const directory = join(projectDirectory(root, project), PRODUCTION_INTENT_DIRECTORY);
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("ProductionIntent directory", `必须是真实目录（拒绝 symlink/FIFO/device）：${directory}`);
    }
    return directory;
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    if (errno(error) !== "ENOENT") throw error;
    if (!create) return null;
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (mkdirError) {
      if (errno(mkdirError) !== "EEXIST") {
        fail("ProductionIntent directory", `无法创建 ${directory}：${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }
    assertRealDirectory(directory, "ProductionIntent directory");
    return directory;
  }
}

export function productionIntentPath(root: string, project: string, taskId: string): string {
  const parsedTaskId = requireId(taskId, "ProductionIntent.taskId");
  return join(projectDirectory(root, project), PRODUCTION_INTENT_DIRECTORY, `${parsedTaskId}.json`);
}

function sameFile(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size) && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function boundedIntentBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > MAX_PRODUCTION_INTENT_BYTES) {
    fail("ProductionIntent maxBytes", `必须是 1024–${MAX_PRODUCTION_INTENT_BYTES} 的安全整数`);
  }
  return maxBytes;
}

export function readProductionIntent(
  root: string,
  project: string,
  taskId: string,
  maxBytes = MAX_PRODUCTION_INTENT_BYTES,
): ProductionDispatchIntent | null {
  const limit = boundedIntentBytes(maxBytes);
  const parsedTaskId = requireId(taskId, "ProductionIntent.taskId");
  const directory = intentDirectory(root, project, false);
  if (directory === null) return null;
  const file = join(directory, `${parsedTaskId}.json`);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    fail("ProductionIntent", `无法检查 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("ProductionIntent", `${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > limit) fail("ProductionIntent", `${file} 超过 ${limit} bytes 安全读取上限`);

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      fail("ProductionIntent", `${file} 在 lstat/open 间被替换或不是单链接普通文件`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== bytes.length || !sameFile(before, after)) {
      fail("ProductionIntent", `${file} 在读取期间变化（immutable companion 被修改）`);
    }
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes) || raw.includes("\0")) {
      fail("ProductionIntent", `${file} 不是无 NUL 的规范 UTF-8 JSON`);
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { fail("ProductionIntent", `${file} JSON 损坏：${error instanceof Error ? error.message : String(error)}`); }
    const intent = parseProductionDispatchIntent(value, `ProductionIntent ${file}`);
    if (intent.taskId !== parsedTaskId) fail("ProductionIntent", `${file} 内 taskId 与文件名不匹配`);
    return intent;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the primary result */ }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Persist one immutable companion with O_EXCL. Exact replay is a no-op; any task/config drift is a
 * hard conflict. A crash-truncated file remains fail-closed for explicit operator audit.
 */
export function enqueueProductionIntent(
  root: string,
  project: string,
  value: unknown,
  maxBytes = MAX_PRODUCTION_INTENT_BYTES,
): EnqueueProductionIntentResult {
  const limit = boundedIntentBytes(maxBytes);
  const intent = parseProductionDispatchIntent(value);
  const directory = intentDirectory(root, project, true)!;
  const file = join(directory, `${intent.taskId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(intent, null, 2)}\n`, "utf8");
  if (bytes.length > limit) fail("ProductionIntent", `canonical intent 超过 ${limit} bytes 安全上限`);

  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        fail("ProductionIntent", `无法 O_EXCL 创建 ${file}：${error instanceof Error ? error.message : String(error)}`);
      }
      const existing = readProductionIntent(root, project, intent.taskId, limit);
      if (existing !== null && JSON.stringify(existing) === JSON.stringify(intent)) {
        return { created: false, path: file, intent: existing };
      }
      fail("ProductionIntent", `${file} 已绑定另一 canonical intent（拒绝覆盖或配置漂移）`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      fail("ProductionIntent", `${file} 创建后不是单链接普通文件`);
    }
    writeAll(fd, bytes);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) {
      fail("ProductionIntent", `${file} 写入后 identity/长度异常`);
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(directory);
  return { created: true, path: file, intent };
}
