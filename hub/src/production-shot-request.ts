// 镜头请求（ShotRequest）契约、编译器与剧本预填 —— docs/design/2026-08-video-provider-interface/DESIGN.md
// §4.1（类型与错误码表）、§4.3（capability 描述）、§5.1–§5.3（三家后端映射）、§6.1（剧本切分与镜头合并）。
//
// 这里全部是纯函数、零 I/O、零 provider 网络：ShotRequestDraft 由 plan-shots 装配（剧本预填 + 人工补齐
// camera / prompt / 连续性输入），compileShotRequest 把 draft 编译成不可变 ShotRequest 与 intent draft，
// 并把每一处后端能力差异写成 ValidationReport issue 或 Degradation。含 error 级 issue 的镜头不出 ShotRequest、
// 不进批次（§4.1 末段）。ShotRequest 以 canonical JSON 存入 CAS 并作为 intent inputs[0]，因此 prompt 与全部
// 连续性输入自动进入 idempotencyKey 与 stageKey。
//
// 本版（Phase 0）唯一可执行后端是 MiniMax H3 over ComfyUI：只有 minimax-h3 家族能产出 intentDraft，
// seedance / veo 两个家族只到编译校验层（production-intent.ts 的 execution 分支随 Phase 3 / Phase 4 落地）。
import { productionCanonicalJson, productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import {
  MAX_PRODUCTION_TEXT_LENGTH,
  ProductionError,
  parseAssetRef,
  parseShotRevisionRef,
  type AssetRef,
  type EpisodeRevisionRef,
  type ShotRevisionRef,
} from "./production-domain.ts";
import {
  MAX_PRODUCTION_INTENT_INPUTS,
  hasExplicitWrittenLicense,
  licenseObligationViolations,
  parseProductionIntentDraft,
  parseProductionLicenseCompliance,
  parseProductionLicenseEvidence,
  type H3Variant,
  type ProductionLicenseCompliance,
  type ProductionIntentBudget,
  type ProductionIntentDraft,
  type ProductionLicenseEvidence,
  type ProductionModerationEvidence,
  type ProductionRightsEvidence,
} from "./production-intent.ts";
import { parseEpisodeScript, sceneAnnotationLines } from "./script-lint.ts";

export const SHOT_REQUEST_SCHEMA_VERSION = 1 as const;
export const SHOT_REQUEST_KIND = "writing-loop/shot-request" as const;
export const SHOT_REQUEST_DRAFT_KIND = "writing-loop/shot-request-draft" as const;
export const SHOT_REQUEST_MEDIA_TYPE = "application/vnd.writing-loop.shot-request+json";
/** ShotRequest.continuity.references 的结构上限（§4.1 字段表）；各后端另有更小的 capability 上限。 */
export const MAX_SHOT_REQUEST_REFERENCES = 12;
/** 分镜时长下界：0 会让合并条件 8（时长上界）对该行永不阻断。 */
export const MIN_STORYBOARD_DURATION_SECONDS = 0.1;
/** 合并后 action / dialogue / productionTags 的结构上限，与解析层一致（超出则不再合并）。 */
export const MAX_SHOT_ACTION_LENGTH = MAX_PRODUCTION_TEXT_LENGTH;
export const MAX_SHOT_DIALOGUE_LINES = 64;
export const MAX_SHOT_PRODUCTION_TAGS = 64;
export const DEFAULT_DIALOGUE_LANGUAGE = "zh-CN";
/** 【画面定格】是强制切分点（§6.1 条件 6）。 */
export const FREEZE_FRAME_TAG = "画面定格";

// —— §4.1 词表 ——
export const SHOT_SIZES = [
  "extreme_wide", "wide", "medium_wide", "medium", "medium_close", "close_up", "extreme_close_up",
  "over_shoulder", "insert", "establishing",
] as const;
export type ShotSize = typeof SHOT_SIZES[number];

/** scene_plan.schema.json camera_movement 的 18 个值，逐字复用。 */
export const CAMERA_MOVEMENTS = [
  "static", "pan_left", "pan_right", "tilt_up", "tilt_down", "dolly_in", "dolly_out", "tracking_left",
  "tracking_right", "crane_up", "crane_down", "handheld", "steadicam", "whip_pan", "orbital", "zoom_in",
  "zoom_out", "rack_focus",
] as const;
export type CameraMovement = typeof CAMERA_MOVEMENTS[number];

export const LENS_MM = [14, 24, 35, 50, 85, 135, 200] as const;
export type LensMm = typeof LENS_MM[number];

/** scene_plan.schema.json lighting_key 的 11 个值。 */
export const LIGHTING_KEYS = [
  "high_key", "low_key", "natural", "golden_hour", "blue_hour", "tungsten_warm", "neon", "silhouette",
  "rim_lit", "volumetric", "overcast_soft",
] as const;
export type LightingKey = typeof LIGHTING_KEYS[number];

export const DEPTHS_OF_FIELD = ["shallow", "medium", "deep"] as const;
export type DepthOfField = typeof DEPTHS_OF_FIELD[number];

export const COLOR_TEMPERATURES = ["cool", "neutral", "warm", "mixed"] as const;
export type ColorTemperature = typeof COLOR_TEMPERATURES[number];

/** 裁剪保留顺序：靠前的用途先保留（§4.1 参考裁剪）。 */
export const REFERENCE_PURPOSES = [
  "character-identity", "costume", "prop", "set-dressing", "lighting", "style", "motion", "voice",
] as const;
export type ReferencePurpose = typeof REFERENCE_PURPOSES[number];

/** extend 保留在词表内，deriveVideoMode 不产出、编译一律拒绝（§4.0 非目标）。 */
export const VIDEO_MODES = ["t2v", "i2v", "fl2v", "ref2v", "extend"] as const;
export type VideoMode = typeof VIDEO_MODES[number];

/** v1 支持的画幅集合以 ShotRequest 为准；Seedance 的 4:3 / 3:4 / adaptive 不在其中（§4.1 修正）。 */
export const SHOT_ASPECT_RATIOS = ["9:16", "16:9", "1:1", "21:9"] as const;
export type ShotAspectRatio = typeof SHOT_ASPECT_RATIOS[number];

export const TIMES_OF_DAY = ["day", "night", "dawn", "dusk"] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const INTERIORS = ["int", "ext", "int-ext"] as const;
export type Interior = typeof INTERIORS[number];

export const DIALOGUE_MODES = ["onscreen", "os", "vo"] as const;
export type DialogueMode = typeof DIALOGUE_MODES[number];

export const ANCHOR_MODES = ["keyframes", "references", "none"] as const;
export type AnchorMode = typeof ANCHOR_MODES[number];

export const REFERENCE_POLICIES = ["strict", "trim_by_priority"] as const;
export type ReferencePolicy = typeof REFERENCE_POLICIES[number];

export const KEYFRAME_ORIGIN_KINDS = [
  "approved-candidate", "previous-shot-last-frame", "previous-episode-end", "operator-upload",
] as const;
export type KeyframeOriginKind = typeof KEYFRAME_ORIGIN_KINDS[number];

/** §4.1 Degradation 词表（三个无触发规则的 code 已在 v2 删除）。 */
export const DEGRADATION_CODES = [
  "anchor-mode-selected", "duration-rounded-trim", "references-trimmed", "seed-not-reproducible",
  "negative-prompt-folded", "prompt-translated",
] as const;
export type DegradationCode = typeof DEGRADATION_CODES[number];

/** §4.1 ValidationReport 错误码表（末两项为 warning 级）。 */
export const SHOT_VALIDATION_CODES = [
  "unsupported_operation", "unsupported_continuity_mode", "last_frame_without_first",
  "keyframe_not_approved", "reference_cap_exceeded", "audio_only_reference_unsupported",
  "duration_out_of_range", "aspect_ratio_unsupported", "resolution_unsupported", "image_too_large",
  "image_mime_unsupported", "real_face_unauthorized", "license_blocked", "license_obligation_unmet",
  "processing_region_not_allowed", "prop_state_missing", "prompt_language_unsupported",
  "dialogue_language_unsupported", "prompt_contains_provider_directive", "reference_index_out_of_range",
  "seed_rejected", "output_intent_mismatch", "negative_prompt_unsupported", "native_audio_unverified",
  "prompt_length_over_recommendation",
] as const;
export type ShotValidationCode = typeof SHOT_VALIDATION_CODES[number];

export const SHOT_MODEL_FAMILIES = ["minimax-h3", "seedance", "veo"] as const;
export type ShotModelFamily = typeof SHOT_MODEL_FAMILIES[number];

export const SHOT_BACKEND_KINDS = ["comfyui", "volcengine-ark", "byteplus-modelark", "vertex-veo"] as const;
export type ShotBackendKind = typeof SHOT_BACKEND_KINDS[number];

/**
 * provider 文本指令：Ark 的弱校验传参写在 prompt 尾部（--rs/--rt/--dur/…）。词表随 provider 变动，
 * 因此按形态拒绝任意 `--flag`（前置为行首或空白 / CJK 标点），所有后端一律拒绝（§4.1）。
 */
export const PROVIDER_DIRECTIVE_RE = /(^|[\s，。；：、！？（）()])--[A-Za-z][A-Za-z_-]*/u;
/**
 * 参考序号：官方写法「图片N / 视频N / 音频N」与「@图片1」（§6.6）。
 * 裸「图」只在带 @ 前缀或数字紧邻（无空白）时算序号引用，避免「画面构图 2 层」误报。
 * 导出常量不带 g 标志（避免 lastIndex 跨调用泄漏），内部扫描时再加 gu。
 */
export const REFERENCE_INDEX_RE = /@(?:图片|图像|图|视频|音频)\s*\d+|(?:图片|图像|视频|音频)\s*\d+|图\d+/u;
/** Seedance 建议值：中文 500 字 / 英文 1000 词（§5.1）。 */
export const SEEDANCE_PROMPT_CHAR_RECOMMENDATION = 500;
export const SEEDANCE_PROMPT_WORD_RECOMMENDATION = 1000;
/** Veo 在 ref2v 与 1080p / 4k 下的保守时长（§4.2、§5.2；探针后可放宽）。 */
export const VEO_LOCKED_DURATION_SECONDS = 8;
export const VEO_LOCKED_RESOLUTIONS = ["1080p", "4k"] as const;

// —— §4.1 数据类型 ——
export type KeyframeOrigin =
  | { kind: "approved-candidate"; candidateId: string }
  | { kind: "previous-shot-last-frame"; shotId: string; taskId: string }
  | { kind: "previous-episode-end"; episodeId: string }
  | { kind: "operator-upload"; note: string };

export type KeyframeInput = { asset: AssetRef; origin: KeyframeOrigin; containsRealFace: boolean };

export type ReferenceInput = {
  asset: AssetRef;
  purpose: ReferencePurpose;
  subjectId: string | null;
  priority: 1 | 2 | 3;
  containsRealFace: boolean;
};

export type Degradation = { code: DegradationCode; from: string; to: string; requiresReapproval: boolean };

export type ShotProvenance = {
  storyDesignSha256: string;
  assetsRevision: number;
  visualProductionSha256: string | null;
  beatCardHash: string | null;
  scriptLine: number;
  /** 合并镜头并入的其余 ▲ 行行号，无合并时为空数组（§6.1）。 */
  mergedScriptLines: number[];
};

export type ShotScene = {
  sceneId: string;
  subscene: string | null;
  timeOfDay: TimeOfDay;
  interior: Interior;
  lightingStateId: string | null;
  dressingVariantId: string | null;
};

export type ShotCamera = {
  shot_size: ShotSize;
  camera_movement: CameraMovement;
  lens_mm: LensMm;
  lighting_key: LightingKey;
  depth_of_field: DepthOfField;
  color_temperature: ColorTemperature;
  cameraId: string | null;
};

export type ShotCastMember = {
  characterId: string;
  name: string;
  appearanceStateId: string;
  voiceId: string | null;
  onScreen: boolean;
  performNotes: string | null;
  stage: { x: number; y: number; z: number; yawDeg: number; pose: string } | null;
};

export type ShotProp = {
  objectId: string;
  stateId: string;
  visible: boolean;
  position: [number, number, number] | null;
};

export type ShotCrowd = { label: string; count: number; cap: number };

export type ShotDialogueLine = {
  speakerId: string;
  text: string;
  mode: DialogueMode;
  language: string;
  lipSync: boolean;
};

export type ShotOutput = {
  aspectRatio: ShotAspectRatio;
  generateAudio: boolean;
  durationSeconds: number;
  storyboardDurationSeconds: number;
  fps: 24;
  seed: number | null;
};

export type ShotContinuityFingerprint = {
  modelSha256: string | null;
  workflowSha256: string | null;
  seed: number | null;
  seedReproducible: boolean;
};

export type ShotContinuity = {
  stageGroup: string;
  prevShotId: string | null;
  anchorMode: AnchorMode;
  firstFrame: KeyframeInput | null;
  lastFrame: KeyframeInput | null;
  references: ReferenceInput[];
  referencePolicy: ReferencePolicy;
  droppedReferences: ReferenceInput[];
  spatialPasses: AssetRef[];
  fingerprint: ShotContinuityFingerprint;
};

export type ShotPromptTranslation = {
  language: string;
  text: string;
  negativeText: string | null;
  authoredBy: string;
};

export type ShotPrompt = {
  text: string;
  negativeText: string | null;
  language: string;
  authoredBy: string;
  compiler: string | null;
  selectedTranslation: { language: string; authoredBy: string } | null;
};

export type ShotRequest = {
  version: 1;
  kind: typeof SHOT_REQUEST_KIND;
  shotId: string;
  subject: ShotRevisionRef;
  provenance: ShotProvenance;
  scene: ShotScene;
  camera: ShotCamera;
  cast: ShotCastMember[];
  props: ShotProp[];
  crowd: ShotCrowd | null;
  action: string;
  productionTags: string[];
  dialogue: ShotDialogueLine[];
  output: ShotOutput;
  continuity: ShotContinuity;
  prompt: ShotPrompt;
  compile: { draftSha256: string; policyDigest: string; degradations: Degradation[] };
};

/**
 * ShotRequest 去掉 compile / anchorMode / droppedReferences / selectedTranslation / fingerprint 的形态，
 * 允许首尾帧与参考并存，另含 prompt.translations[]（本版恒为空数组，§8.5）。
 *
 * 与 §4.1 字面描述的两处差异（有意）：
 *   - output.durationSeconds 不在 draft 内 —— 它是编译取整的产物，留在 draft 会形成第二个事实来源；
 *   - camera 允许 null —— 剧本预填时分镜尚未产出（§6.1「camera 由人工填写」），compile 对 null 报错抛出。
 */
export type ShotRequestDraft = {
  version: 1;
  kind: typeof SHOT_REQUEST_DRAFT_KIND;
  shotId: string;
  subject: ShotRevisionRef;
  provenance: ShotProvenance;
  scene: ShotScene;
  camera: ShotCamera | null;
  cast: ShotCastMember[];
  props: ShotProp[];
  crowd: ShotCrowd | null;
  action: string;
  productionTags: string[];
  dialogue: ShotDialogueLine[];
  output: {
    aspectRatio: ShotAspectRatio;
    generateAudio: boolean;
    storyboardDurationSeconds: number;
    fps: 24;
    seed: number | null;
  };
  continuity: {
    stageGroup: string;
    prevShotId: string | null;
    firstFrame: KeyframeInput | null;
    lastFrame: KeyframeInput | null;
    references: ReferenceInput[];
    referencePolicy: ReferencePolicy;
    spatialPasses: AssetRef[];
  };
  prompt: {
    /** null = 写作侧尚未撰写：镜头合并是 plan-shots 的前置步骤，早于 prompt 撰写（§6.1 数据流）。 */
    text: string | null;
    negativeText: string | null;
    language: string;
    authoredBy: string;
    translations: ShotPromptTranslation[];
  };
};

export type ShotValidationIssue = {
  code: ShotValidationCode;
  field: string;
  severity: "error" | "warning";
  message: string;
};

export type ValidationReport = {
  version: 1;
  shotId: string;
  mode: VideoMode;
  issues: ShotValidationIssue[];
  errors: number;
  warnings: number;
};

// —— §4.3 capability（编译器消费的子集，逐字沿用字段名） ——
export type VideoBackendLimits = {
  modes: readonly VideoMode[];
  durationSeconds: {
    min: number;
    max: number;
    grid: readonly number[] | null;
    gridByResolution: Readonly<Record<string, readonly number[]>> | null;
  };
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  maxStyleImages: number;
  maxReferenceAssetsTotal: number | null;
  audioOnlyReference: boolean;
  keyframesAndReferencesExclusive: true;
  seed: "unsupported" | "uint32" | "uint32-best-effort" | "int32";
  /** null = 无限制；Veo 为 ["en"]。 */
  promptLanguages: readonly string[] | null;
  promptDirectiveSyntax: "ark-text-flags" | null;
  nativeAudio: {
    status: "supported" | "unsupported" | "unverified";
    channels: "mono" | "stereo" | null;
    verifiedBy: {
      modelId: string;
      probeRemoteJobId: string;
      providerJobId: string | null;
      at: string;
      hasAudio: boolean;
    } | null;
  };
  returnsLastFrame: boolean;
  maxInputImageBytes: number;
  inputImageMediaTypes: readonly string[];
  realFaceReferences: "forbidden" | "allowed";
};

export type ShotCompileCapability = {
  backendKind: ShotBackendKind;
  backendInstanceId: string;
  modelFamilies: readonly ShotModelFamily[];
  /** ISO-3166 alpha-2：cn-beijing→CN、ap-southeast-1→SG、us-central1→US。 */
  processingRegions: readonly string[];
  /** 按 modelId 索引；H3 以 profileId 为键（§4.3）。 */
  limitsByModelId: Readonly<Record<string, VideoBackendLimits>>;
};

// —— execution profile（gateway server-owned registry 的只读快照形态，§4.2） ——
type ShotExecutionProfileBase = {
  version: 1;
  kind: "writing-loop/execution-profile";
  profileId: string;
  backendInstanceId: string;
  workflowSha256: string;
  modelSha256: string;
  parametersSha256: string;
  /** 取值由 capability.limits 判定：后端多出的取值（Seedance 的 adaptive 画幅）在编译期返回 *_unsupported。 */
  resolution: string;
  aspectRatio: string;
  generateAudio: boolean;
};

export type ShotExecutionProfile =
  | (ShotExecutionProfileBase & {
      modelFamily: "minimax-h3";
      operation: "comfyui-workflow" | "minimax-h3";
      variant: H3Variant;
      shortEdge: 768;
      /** 每个时长档一份 profile（§5.3）；编译取整值必须命中该档。 */
      durationSeconds: number;
    })
  | (ShotExecutionProfileBase & {
      modelFamily: "seedance";
      operation: "ark-video-task";
      provider: "volcengine-ark" | "byteplus-modelark";
      modelId: string;
      watermark: false;
      returnLastFrame: true;
      executionExpiresAfterSeconds: number;
    })
  | (ShotExecutionProfileBase & {
      modelFamily: "veo";
      operation: "vertex-veo-lro";
      modelId: string;
      location: "us-central1";
      sampleCount: 1;
      ioMode: "inline-base64" | "gcs";
    });

export type H3ExecutionProfile = Extract<ShotExecutionProfile, { modelFamily: "minimax-h3" }>;

export type ShotCompileProjectPolicy = {
  allowedProcessingRegions: readonly string[];
  /** 与 intent gate context 的 `licenseCompliance` 同一类型、同一判据（production-intent.ts）。 */
  licenseCompliance: ProductionLicenseCompliance;
  /**
   * 输出是否会用于改进其他模型。该条款只在编译期判定，gate 不判定（§4.1、AI-SPEC 使用约束）：它描述的是
   * 产物的后续使用方式，dispatch 前拿不到可取证的事实，只能按项目声明检查。
   */
  usesOutputToImproveModels: boolean;
};

export type ApprovedCandidateRecord = {
  sha256: string;
  status: "candidate" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type ShotCompilePolicy = {
  version: 1;
  /** 首尾帧与参考并存时保留哪一侧（缺省 keyframes，§4.1）。 */
  anchorPreference: "keyframes" | "references";
  /** ShotRequest 写入 workspace CAS 后的 authority：cas://<authority>/sha256/<digest>（§4.1 资产 URI）。 */
  casAuthority: string;
  compiler: string;
  execution: ShotExecutionProfile;
  project: ShotCompileProjectPolicy;
  /** visual/production.v1.json candidates[]，按 candidateId 索引（§6.2）。 */
  approvedCandidates: Readonly<Record<string, ApprovedCandidateRecord>>;
  /** visual/prop-states.v1.json：objectId → 已登记 stateId（§6.1）。 */
  propStates: Readonly<Record<string, readonly string[]>>;
  /** intent draft 的任务面脚手架；不进入 policyDigest。 */
  intent: {
    taskId: string;
    createdAt: string;
    useTerritories: string[];
    budget: ProductionIntentBudget;
    rights: ProductionRightsEvidence;
    moderation: ProductionModerationEvidence;
    license: ProductionLicenseEvidence;
  };
};

export type CompileShotRequestResult = {
  shotRequest: ShotRequest | null;
  /**
   * 只有 minimax-h3 家族能产出：production-intent.ts 的 ark-video-task / vertex-veo-lro execution 分支
   * 随 Phase 3 / Phase 4 落地（§8.4、§8.5），本版云家族编译只出 ValidationReport。
   */
  intentDraft: ProductionIntentDraft | null;
  validation: ValidationReport;
  degradations: Degradation[];
};

// —— 解析辅助（与 production-domain.ts / production-intent.ts 同一套严格语义） ——
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CAS_AUTHORITY_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const LANGUAGE_TAG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new ProductionError(`${subject} ${detail}`);
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function requireVersion(value: unknown, subject: string): void {
  if (value !== SHOT_REQUEST_SCHEMA_VERSION) fail(subject, "version 必须是 1");
}

function requireId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(subject, "必须是 1–128 位安全标识符");
  return value;
}

function nullableId(value: unknown, subject: string): string | null {
  return value === null ? null : requireId(value, subject);
}

/** 允许换行（合并镜头后的 action 是多行拼接），只拒绝 NUL 与超长。 */
function requireText(value: unknown, subject: string, max = MAX_PRODUCTION_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) {
    fail(subject, `必须是 1–${max} 位且不含 NUL 的字符串`);
  }
  return value;
}

function nullableText(value: unknown, subject: string, max = MAX_PRODUCTION_TEXT_LENGTH): string | null {
  return value === null ? null : requireText(value, subject, max);
}

function requireBoolean(value: unknown, subject: string): boolean {
  if (typeof value !== "boolean") fail(subject, "必须是布尔值");
  return value;
}

function requireInteger(value: unknown, subject: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, subject: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的有限数`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, subject: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(subject, `必须是 ${allowed.join("、")} 之一`);
  }
  return value as T;
}

function requireArray(value: unknown, subject: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(subject, `必须是至多 ${maximum} 项的数组`);
  return value;
}

function requireSha256(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(subject, "必须是 64 位小写十六进制 sha256");
  return value;
}

function nullableSha256(value: unknown, subject: string): string | null {
  return value === null ? null : requireSha256(value, subject);
}

function requireLanguage(value: unknown, subject: string): string {
  if (typeof value !== "string" || !LANGUAGE_TAG_RE.test(value)) fail(subject, "必须是 BCP-47 语言标签");
  return value;
}

function parseKeyframeOrigin(value: unknown, subject: string): KeyframeOrigin {
  const row = requireRecord(value, subject);
  const kind = requireEnum(row.kind, `${subject}.kind`, KEYFRAME_ORIGIN_KINDS);
  if (kind === "approved-candidate") {
    exactKeys(row, ["kind", "candidateId"], subject);
    return { kind, candidateId: requireText(row.candidateId, `${subject}.candidateId`, 128) };
  }
  if (kind === "previous-shot-last-frame") {
    exactKeys(row, ["kind", "shotId", "taskId"], subject);
    return {
      kind,
      shotId: requireId(row.shotId, `${subject}.shotId`),
      taskId: requireId(row.taskId, `${subject}.taskId`),
    };
  }
  if (kind === "previous-episode-end") {
    exactKeys(row, ["kind", "episodeId"], subject);
    return { kind, episodeId: requireId(row.episodeId, `${subject}.episodeId`) };
  }
  exactKeys(row, ["kind", "note"], subject);
  return { kind, note: requireText(row.note, `${subject}.note`, 512) };
}

function parseKeyframe(value: unknown, subject: string): KeyframeInput {
  const row = requireRecord(value, subject);
  exactKeys(row, ["asset", "origin", "containsRealFace"], subject);
  return {
    asset: parseAssetRef(row.asset, `${subject}.asset`),
    origin: parseKeyframeOrigin(row.origin, `${subject}.origin`),
    containsRealFace: requireBoolean(row.containsRealFace, `${subject}.containsRealFace`),
  };
}

function nullableKeyframe(value: unknown, subject: string): KeyframeInput | null {
  return value === null ? null : parseKeyframe(value, subject);
}

function parseReference(value: unknown, subject: string): ReferenceInput {
  const row = requireRecord(value, subject);
  exactKeys(row, ["asset", "purpose", "subjectId", "priority", "containsRealFace"], subject);
  const priority = requireInteger(row.priority, `${subject}.priority`, 1, 3) as 1 | 2 | 3;
  return {
    asset: parseAssetRef(row.asset, `${subject}.asset`),
    purpose: requireEnum(row.purpose, `${subject}.purpose`, REFERENCE_PURPOSES),
    subjectId: nullableId(row.subjectId, `${subject}.subjectId`),
    priority,
    containsRealFace: requireBoolean(row.containsRealFace, `${subject}.containsRealFace`),
  };
}

function parseReferences(value: unknown, subject: string): ReferenceInput[] {
  return requireArray(value, subject, MAX_SHOT_REQUEST_REFERENCES)
    .map((entry, index) => parseReference(entry, `${subject}[${index}]`));
}

function parseProvenance(value: unknown, subject: string): ShotProvenance {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "storyDesignSha256", "assetsRevision", "visualProductionSha256", "beatCardHash", "scriptLine",
    "mergedScriptLines",
  ], subject);
  const merged = requireArray(row.mergedScriptLines, `${subject}.mergedScriptLines`, 1_024)
    .map((entry, index) => requireInteger(entry, `${subject}.mergedScriptLines[${index}]`, 1, 1_000_000));
  return {
    storyDesignSha256: requireSha256(row.storyDesignSha256, `${subject}.storyDesignSha256`),
    assetsRevision: requireInteger(row.assetsRevision, `${subject}.assetsRevision`, 0, Number.MAX_SAFE_INTEGER),
    visualProductionSha256: nullableSha256(row.visualProductionSha256, `${subject}.visualProductionSha256`),
    beatCardHash: nullableText(row.beatCardHash, `${subject}.beatCardHash`, 64),
    scriptLine: requireInteger(row.scriptLine, `${subject}.scriptLine`, 1, 1_000_000),
    mergedScriptLines: merged,
  };
}

function parseScene(value: unknown, subject: string): ShotScene {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "sceneId", "subscene", "timeOfDay", "interior", "lightingStateId", "dressingVariantId",
  ], subject);
  return {
    sceneId: requireId(row.sceneId, `${subject}.sceneId`),
    subscene: nullableText(row.subscene, `${subject}.subscene`, 128),
    timeOfDay: requireEnum(row.timeOfDay, `${subject}.timeOfDay`, TIMES_OF_DAY),
    interior: requireEnum(row.interior, `${subject}.interior`, INTERIORS),
    lightingStateId: nullableId(row.lightingStateId, `${subject}.lightingStateId`),
    dressingVariantId: nullableId(row.dressingVariantId, `${subject}.dressingVariantId`),
  };
}

function parseCamera(value: unknown, subject: string): ShotCamera {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "shot_size", "camera_movement", "lens_mm", "lighting_key", "depth_of_field", "color_temperature",
    "cameraId",
  ], subject);
  if (typeof row.lens_mm !== "number" || !(LENS_MM as readonly number[]).includes(row.lens_mm)) {
    fail(`${subject}.lens_mm`, `必须是 ${LENS_MM.join("、")} 之一`);
  }
  return {
    shot_size: requireEnum(row.shot_size, `${subject}.shot_size`, SHOT_SIZES),
    camera_movement: requireEnum(row.camera_movement, `${subject}.camera_movement`, CAMERA_MOVEMENTS),
    lens_mm: row.lens_mm as LensMm,
    lighting_key: requireEnum(row.lighting_key, `${subject}.lighting_key`, LIGHTING_KEYS),
    depth_of_field: requireEnum(row.depth_of_field, `${subject}.depth_of_field`, DEPTHS_OF_FIELD),
    color_temperature: requireEnum(row.color_temperature, `${subject}.color_temperature`, COLOR_TEMPERATURES),
    cameraId: nullableId(row.cameraId, `${subject}.cameraId`),
  };
}

function parseCast(value: unknown, subject: string): ShotCastMember[] {
  const cast = requireArray(value, subject, 64).map((entry, index) => {
    const label = `${subject}[${index}]`;
    const row = requireRecord(entry, label);
    exactKeys(row, [
      "characterId", "name", "appearanceStateId", "voiceId", "onScreen", "performNotes", "stage",
    ], label);
    let stage: ShotCastMember["stage"] = null;
    if (row.stage !== null) {
      const stageRow = requireRecord(row.stage, `${label}.stage`);
      exactKeys(stageRow, ["x", "y", "z", "yawDeg", "pose"], `${label}.stage`);
      stage = {
        x: requireFiniteNumber(stageRow.x, `${label}.stage.x`, -10_000, 10_000),
        y: requireFiniteNumber(stageRow.y, `${label}.stage.y`, -10_000, 10_000),
        z: requireFiniteNumber(stageRow.z, `${label}.stage.z`, -10_000, 10_000),
        yawDeg: requireFiniteNumber(stageRow.yawDeg, `${label}.stage.yawDeg`, -360, 360),
        pose: requireText(stageRow.pose, `${label}.stage.pose`, 128),
      };
    }
    return {
      characterId: requireId(row.characterId, `${label}.characterId`),
      name: requireText(row.name, `${label}.name`, 128),
      appearanceStateId: requireId(row.appearanceStateId, `${label}.appearanceStateId`),
      voiceId: nullableId(row.voiceId, `${label}.voiceId`),
      onScreen: requireBoolean(row.onScreen, `${label}.onScreen`),
      performNotes: nullableText(row.performNotes, `${label}.performNotes`, 512),
      stage,
    };
  });
  // 重复 characterId 会让合并条件 5 的集合比较被绕过（同一角色登记两次时集合仍"相等"）。
  const ids = cast.map((member) => member.characterId);
  if (new Set(ids).size !== ids.length) fail(subject, "不得包含重复 characterId");
  return cast;
}

function parseProps(value: unknown, subject: string): ShotProp[] {
  const props = requireArray(value, subject, 64).map((entry, index) => {
    const label = `${subject}[${index}]`;
    const row = requireRecord(entry, label);
    exactKeys(row, ["objectId", "stateId", "visible", "position"], label);
    let position: ShotProp["position"] = null;
    if (row.position !== null) {
      const raw = requireArray(row.position, `${label}.position`, 3);
      if (raw.length !== 3) fail(`${label}.position`, "必须是三元坐标或 null");
      position = [
        requireFiniteNumber(raw[0], `${label}.position[0]`, -10_000, 10_000),
        requireFiniteNumber(raw[1], `${label}.position[1]`, -10_000, 10_000),
        requireFiniteNumber(raw[2], `${label}.position[2]`, -10_000, 10_000),
      ];
    }
    return {
      objectId: requireId(row.objectId, `${label}.objectId`),
      stateId: requireId(row.stateId, `${label}.stateId`),
      visible: requireBoolean(row.visible, `${label}.visible`),
      position,
    };
  });
  const ids = props.map((prop) => prop.objectId);
  if (new Set(ids).size !== ids.length) fail(subject, "不得包含重复 objectId");
  return props;
}

function parseCrowd(value: unknown, subject: string): ShotCrowd | null {
  if (value === null) return null;
  const row = requireRecord(value, subject);
  exactKeys(row, ["label", "count", "cap"], subject);
  const count = requireInteger(row.count, `${subject}.count`, 0, 10_000);
  const cap = requireInteger(row.cap, `${subject}.cap`, 0, 10_000);
  if (count > cap) fail(`${subject}.count`, "不得超过 cap");
  return { label: requireText(row.label, `${subject}.label`, 128), count, cap };
}

function parseProductionTags(value: unknown, subject: string): string[] {
  return requireArray(value, subject, 64)
    .map((entry, index) => requireText(entry, `${subject}[${index}]`, 128));
}

function parseDialogue(value: unknown, subject: string): ShotDialogueLine[] {
  return requireArray(value, subject, 64).map((entry, index) => {
    const label = `${subject}[${index}]`;
    const row = requireRecord(entry, label);
    exactKeys(row, ["speakerId", "text", "mode", "language", "lipSync"], label);
    const mode = requireEnum(row.mode, `${label}.mode`, DIALOGUE_MODES);
    const lipSync = requireBoolean(row.lipSync, `${label}.lipSync`);
    // §6.3 字段来源：lipSync 由 mode 推导，不是独立事实——两者不一致时口型判定与合并条件 7 会背离。
    if (lipSync !== (mode === "onscreen")) fail(`${label}.lipSync`, "必须等于 mode === \"onscreen\"");
    return {
      speakerId: requireText(row.speakerId, `${label}.speakerId`, 128),
      text: requireText(row.text, `${label}.text`),
      mode,
      language: requireLanguage(row.language, `${label}.language`),
      lipSync,
    };
  });
}

function parseSpatialPasses(value: unknown, subject: string): AssetRef[] {
  return requireArray(value, subject, 32).map((entry, index) => parseAssetRef(entry, `${subject}[${index}]`));
}

function parseTranslations(value: unknown, subject: string): ShotPromptTranslation[] {
  return requireArray(value, subject, 8).map((entry, index) => {
    const label = `${subject}[${index}]`;
    const row = requireRecord(entry, label);
    exactKeys(row, ["language", "text", "negativeText", "authoredBy"], label);
    return {
      language: requireLanguage(row.language, `${label}.language`),
      text: requireText(row.text, `${label}.text`),
      negativeText: nullableText(row.negativeText, `${label}.negativeText`),
      authoredBy: requireText(row.authoredBy, `${label}.authoredBy`, 128),
    };
  });
}

const DRAFT_KEYS = [
  "version", "kind", "shotId", "subject", "provenance", "scene", "camera", "cast", "props", "crowd",
  "action", "productionTags", "dialogue", "output", "continuity", "prompt",
] as const;

export function parseShotRequestDraft(value: unknown, subject = "ShotRequestDraft"): ShotRequestDraft {
  const row = requireRecord(value, subject);
  exactKeys(row, DRAFT_KEYS, subject);
  requireVersion(row.version, subject);
  if (row.kind !== SHOT_REQUEST_DRAFT_KIND) fail(`${subject}.kind`, `必须是 ${SHOT_REQUEST_DRAFT_KIND}`);
  const shotId = requireId(row.shotId, `${subject}.shotId`);
  const shotSubject = parseShotRevisionRef(row.subject, `${subject}.subject`);
  if (shotSubject.shotId !== shotId) fail(`${subject}.subject.shotId`, "必须与 shotId 相同");

  const outputRow = requireRecord(row.output, `${subject}.output`);
  exactKeys(outputRow, ["aspectRatio", "generateAudio", "storyboardDurationSeconds", "fps", "seed"], `${subject}.output`);
  if (outputRow.fps !== 24) fail(`${subject}.output.fps`, "v1 固定为 24");

  const continuityRow = requireRecord(row.continuity, `${subject}.continuity`);
  exactKeys(continuityRow, [
    "stageGroup", "prevShotId", "firstFrame", "lastFrame", "references", "referencePolicy", "spatialPasses",
  ], `${subject}.continuity`);

  const promptRow = requireRecord(row.prompt, `${subject}.prompt`);
  exactKeys(promptRow, ["text", "negativeText", "language", "authoredBy", "translations"], `${subject}.prompt`);

  return {
    version: 1,
    kind: SHOT_REQUEST_DRAFT_KIND,
    shotId,
    subject: shotSubject,
    provenance: parseProvenance(row.provenance, `${subject}.provenance`),
    scene: parseScene(row.scene, `${subject}.scene`),
    camera: row.camera === null ? null : parseCamera(row.camera, `${subject}.camera`),
    cast: parseCast(row.cast, `${subject}.cast`),
    props: parseProps(row.props, `${subject}.props`),
    crowd: parseCrowd(row.crowd, `${subject}.crowd`),
    action: requireText(row.action, `${subject}.action`),
    productionTags: parseProductionTags(row.productionTags, `${subject}.productionTags`),
    dialogue: parseDialogue(row.dialogue, `${subject}.dialogue`),
    output: {
      aspectRatio: requireEnum(outputRow.aspectRatio, `${subject}.output.aspectRatio`, SHOT_ASPECT_RATIOS),
      generateAudio: requireBoolean(outputRow.generateAudio, `${subject}.output.generateAudio`),
      storyboardDurationSeconds: requireFiniteNumber(
        outputRow.storyboardDurationSeconds,
        `${subject}.output.storyboardDurationSeconds`,
        MIN_STORYBOARD_DURATION_SECONDS,
        600,
      ),
      fps: 24,
      seed: outputRow.seed === null ? null : requireInteger(outputRow.seed, `${subject}.output.seed`, 0, 0xffff_ffff),
    },
    continuity: {
      stageGroup: requireText(continuityRow.stageGroup, `${subject}.continuity.stageGroup`, 256),
      prevShotId: nullableId(continuityRow.prevShotId, `${subject}.continuity.prevShotId`),
      firstFrame: nullableKeyframe(continuityRow.firstFrame, `${subject}.continuity.firstFrame`),
      lastFrame: nullableKeyframe(continuityRow.lastFrame, `${subject}.continuity.lastFrame`),
      references: parseReferences(continuityRow.references, `${subject}.continuity.references`),
      referencePolicy: requireEnum(
        continuityRow.referencePolicy,
        `${subject}.continuity.referencePolicy`,
        REFERENCE_POLICIES,
      ),
      spatialPasses: parseSpatialPasses(continuityRow.spatialPasses, `${subject}.continuity.spatialPasses`),
    },
    prompt: {
      text: nullableText(promptRow.text, `${subject}.prompt.text`),
      negativeText: nullableText(promptRow.negativeText, `${subject}.prompt.negativeText`),
      language: requireLanguage(promptRow.language, `${subject}.prompt.language`),
      authoredBy: requireText(promptRow.authoredBy, `${subject}.prompt.authoredBy`, 128),
      translations: parseTranslations(promptRow.translations, `${subject}.prompt.translations`),
    },
  };
}

const SHOT_REQUEST_KEYS = [
  "version", "kind", "shotId", "subject", "provenance", "scene", "camera", "cast", "props", "crowd",
  "action", "productionTags", "dialogue", "output", "continuity", "prompt", "compile",
] as const;

/**
 * 不可变 ShotRequest 的严格解析。结构级违约以 ProductionError 抛出，消息带 §4.1 的错误码名，
 * 便于调用方与 ValidationReport 对齐（编译产物只应经由 compileShotRequest 产生）。
 */
export function parseShotRequest(value: unknown, subject = "ShotRequest"): ShotRequest {
  const row = requireRecord(value, subject);
  exactKeys(row, SHOT_REQUEST_KEYS, subject);
  requireVersion(row.version, subject);
  if (row.kind !== SHOT_REQUEST_KIND) fail(`${subject}.kind`, `必须是 ${SHOT_REQUEST_KIND}`);
  const shotId = requireId(row.shotId, `${subject}.shotId`);
  const shotSubject = parseShotRevisionRef(row.subject, `${subject}.subject`);
  if (shotSubject.shotId !== shotId) fail(`${subject}.subject.shotId`, "必须与 shotId 相同");

  const outputRow = requireRecord(row.output, `${subject}.output`);
  exactKeys(outputRow, [
    "aspectRatio", "generateAudio", "durationSeconds", "storyboardDurationSeconds", "fps", "seed",
  ], `${subject}.output`);
  if (outputRow.fps !== 24) fail(`${subject}.output.fps`, "v1 固定为 24");

  const continuityRow = requireRecord(row.continuity, `${subject}.continuity`);
  exactKeys(continuityRow, [
    "stageGroup", "prevShotId", "anchorMode", "firstFrame", "lastFrame", "references", "referencePolicy",
    "droppedReferences", "spatialPasses", "fingerprint",
  ], `${subject}.continuity`);
  const firstFrame = nullableKeyframe(continuityRow.firstFrame, `${subject}.continuity.firstFrame`);
  const lastFrame = nullableKeyframe(continuityRow.lastFrame, `${subject}.continuity.lastFrame`);
  if (lastFrame !== null && firstFrame === null) {
    fail(`${subject}.continuity.lastFrame`, "非空时 firstFrame 必须非空（last_frame_without_first）");
  }
  const references = parseReferences(continuityRow.references, `${subject}.continuity.references`);
  const anchorMode = requireEnum(continuityRow.anchorMode, `${subject}.continuity.anchorMode`, ANCHOR_MODES);
  if (anchorMode === "keyframes" && firstFrame === null) {
    fail(`${subject}.continuity.anchorMode`, "keyframes 要求 firstFrame 非空");
  }
  if (anchorMode === "references" && references.length === 0) {
    fail(`${subject}.continuity.anchorMode`, "references 要求 references 非空");
  }
  if (anchorMode === "none" && (firstFrame !== null || lastFrame !== null)) {
    fail(`${subject}.continuity.anchorMode`, "none 要求 firstFrame 与 lastFrame 均为 null");
  }
  if (firstFrame !== null && references.length > 0) {
    fail(`${subject}.continuity`, "首尾帧与参考互斥（unsupported_continuity_mode）");
  }
  const fingerprintRow = requireRecord(continuityRow.fingerprint, `${subject}.continuity.fingerprint`);
  exactKeys(fingerprintRow, ["modelSha256", "workflowSha256", "seed", "seedReproducible"], `${subject}.continuity.fingerprint`);

  const promptRow = requireRecord(row.prompt, `${subject}.prompt`);
  exactKeys(promptRow, [
    "text", "negativeText", "language", "authoredBy", "compiler", "selectedTranslation",
  ], `${subject}.prompt`);
  let selectedTranslation: ShotPrompt["selectedTranslation"] = null;
  if (promptRow.selectedTranslation !== null) {
    const translationRow = requireRecord(promptRow.selectedTranslation, `${subject}.prompt.selectedTranslation`);
    exactKeys(translationRow, ["language", "authoredBy"], `${subject}.prompt.selectedTranslation`);
    selectedTranslation = {
      language: requireLanguage(translationRow.language, `${subject}.prompt.selectedTranslation.language`),
      authoredBy: requireText(translationRow.authoredBy, `${subject}.prompt.selectedTranslation.authoredBy`, 128),
    };
  }

  const compileRow = requireRecord(row.compile, `${subject}.compile`);
  exactKeys(compileRow, ["draftSha256", "policyDigest", "degradations"], `${subject}.compile`);
  const degradations = requireArray(compileRow.degradations, `${subject}.compile.degradations`, 32)
    .map((entry, index) => {
      const label = `${subject}.compile.degradations[${index}]`;
      const degradationRow = requireRecord(entry, label);
      exactKeys(degradationRow, ["code", "from", "to", "requiresReapproval"], label);
      return {
        code: requireEnum(degradationRow.code, `${label}.code`, DEGRADATION_CODES),
        from: requireText(degradationRow.from, `${label}.from`, 512),
        to: requireText(degradationRow.to, `${label}.to`, 512),
        requiresReapproval: requireBoolean(degradationRow.requiresReapproval, `${label}.requiresReapproval`),
      };
    });

  return {
    version: 1,
    kind: SHOT_REQUEST_KIND,
    shotId,
    subject: shotSubject,
    provenance: parseProvenance(row.provenance, `${subject}.provenance`),
    scene: parseScene(row.scene, `${subject}.scene`),
    camera: parseCamera(row.camera, `${subject}.camera`),
    cast: parseCast(row.cast, `${subject}.cast`),
    props: parseProps(row.props, `${subject}.props`),
    crowd: parseCrowd(row.crowd, `${subject}.crowd`),
    action: requireText(row.action, `${subject}.action`),
    productionTags: parseProductionTags(row.productionTags, `${subject}.productionTags`),
    dialogue: parseDialogue(row.dialogue, `${subject}.dialogue`),
    output: {
      aspectRatio: requireEnum(outputRow.aspectRatio, `${subject}.output.aspectRatio`, SHOT_ASPECT_RATIOS),
      generateAudio: requireBoolean(outputRow.generateAudio, `${subject}.output.generateAudio`),
      durationSeconds: requireInteger(outputRow.durationSeconds, `${subject}.output.durationSeconds`, 1, 600),
      storyboardDurationSeconds: requireFiniteNumber(
        outputRow.storyboardDurationSeconds,
        `${subject}.output.storyboardDurationSeconds`,
        MIN_STORYBOARD_DURATION_SECONDS,
        600,
      ),
      fps: 24,
      seed: outputRow.seed === null ? null : requireInteger(outputRow.seed, `${subject}.output.seed`, 0, 0xffff_ffff),
    },
    continuity: {
      stageGroup: requireText(continuityRow.stageGroup, `${subject}.continuity.stageGroup`, 256),
      prevShotId: nullableId(continuityRow.prevShotId, `${subject}.continuity.prevShotId`),
      anchorMode,
      firstFrame,
      lastFrame,
      references,
      referencePolicy: requireEnum(
        continuityRow.referencePolicy,
        `${subject}.continuity.referencePolicy`,
        REFERENCE_POLICIES,
      ),
      droppedReferences: parseReferences(
        continuityRow.droppedReferences,
        `${subject}.continuity.droppedReferences`,
      ),
      spatialPasses: parseSpatialPasses(continuityRow.spatialPasses, `${subject}.continuity.spatialPasses`),
      fingerprint: {
        modelSha256: nullableSha256(fingerprintRow.modelSha256, `${subject}.continuity.fingerprint.modelSha256`),
        workflowSha256: nullableSha256(
          fingerprintRow.workflowSha256,
          `${subject}.continuity.fingerprint.workflowSha256`,
        ),
        seed: fingerprintRow.seed === null
          ? null
          : requireInteger(fingerprintRow.seed, `${subject}.continuity.fingerprint.seed`, 0, 0xffff_ffff),
        seedReproducible: requireBoolean(
          fingerprintRow.seedReproducible,
          `${subject}.continuity.fingerprint.seedReproducible`,
        ),
      },
    },
    prompt: {
      text: requireText(promptRow.text, `${subject}.prompt.text`),
      negativeText: nullableText(promptRow.negativeText, `${subject}.prompt.negativeText`),
      language: requireLanguage(promptRow.language, `${subject}.prompt.language`),
      authoredBy: requireText(promptRow.authoredBy, `${subject}.prompt.authoredBy`, 128),
      compiler: nullableText(promptRow.compiler, `${subject}.prompt.compiler`, 128),
      selectedTranslation,
    },
    compile: {
      draftSha256: requireSha256(compileRow.draftSha256, `${subject}.compile.draftSha256`),
      policyDigest: requireSha256(compileRow.policyDigest, `${subject}.compile.policyDigest`),
      degradations,
    },
  };
}

// —— 模式推导（§4.1） ——
export function deriveVideoMode(continuity: {
  firstFrame: KeyframeInput | null;
  lastFrame: KeyframeInput | null;
  references: readonly ReferenceInput[];
}): VideoMode {
  if (continuity.firstFrame !== null && continuity.lastFrame !== null) return "fl2v";
  if (continuity.firstFrame !== null) return "i2v";
  // lastFrame 单独出现是非法组合（last_frame_without_first），模式仍按关键帧侧判定。
  if (continuity.lastFrame !== null) return "fl2v";
  if (continuity.references.length > 0) return "ref2v";
  return "t2v";
}

/** H3 契约只有两个 generator class：fl2va（首帧 / 首尾帧）与 ref2va（参考）。 */
export function h3VariantForMode(mode: VideoMode): H3Variant | null {
  if (mode === "i2v" || mode === "fl2v") return "fl2va";
  if (mode === "ref2v") return "ref2va";
  return null;
}

export function shotRequestCanonicalJson(shotRequest: ShotRequest): string {
  return productionCanonicalJson(shotRequest);
}

export function shotRequestSha256(shotRequest: ShotRequest): string {
  return productionCanonicalJsonSha256(shotRequest);
}

/** ShotRequest 写入 workspace CAS 后的 AssetRef —— intent inputs[0]（§4.1 资产 URI）。 */
export function shotRequestAssetRef(shotRequest: ShotRequest, casAuthority: string): AssetRef {
  if (!CAS_AUTHORITY_RE.test(casAuthority)) {
    fail("ShotCompilePolicy.casAuthority", "必须是小写 CAS authority（如 wl-sg）");
  }
  const canonical = shotRequestCanonicalJson(shotRequest);
  const digest = productionCanonicalJsonSha256(shotRequest);
  return {
    version: 1,
    uri: `cas://${casAuthority}/sha256/${digest}`,
    sha256: digest,
    byteLength: Buffer.byteLength(canonical, "utf8"),
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
}

/**
 * ingest 产出的 AssetRef 是 `urn:sha256:<digest>`（`hub/src/production-gateway.ts`），stage kernel 不接受无
 * authority 的 URI。编译器在把它送进下一镜的输入前改写为 `cas://<authority>/sha256/<digest>`（sha256 与
 * byteLength 不变，ingest 已把对象写进同一 CAS 目录）——§4.1「资产 URI」段与 §6.4 承接链。
 * 其余 scheme（已经是 cas:、或 s3: 等稳定存储）原样保留。
 */
export function rewriteToCasUri(asset: AssetRef, casAuthority: string): AssetRef {
  if (!CAS_AUTHORITY_RE.test(casAuthority)) {
    fail("casAuthority", "必须是小写 CAS authority（如 wl-sg）");
  }
  const urnPrefix = `urn:sha256:`;
  if (!asset.uri.startsWith(urnPrefix)) return asset;
  const digest = asset.uri.slice(urnPrefix.length);
  if (digest !== asset.sha256) {
    fail("AssetRef.uri", `urn:sha256 的 digest 与 AssetRef.sha256 不一致（${digest} ≠ ${asset.sha256}）`);
  }
  return { ...asset, uri: `cas://${casAuthority}/sha256/${asset.sha256}` };
}

// —— 编译（§4.1 规则表） ——
export function referenceAssetKind(reference: ReferenceInput): "image" | "video" | "audio" | "other" {
  const mediaType = reference.asset.mediaType;
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "other";
}

/** 语言标签按整串或主子标签匹配：["en"] 覆盖 en-US，但不覆盖 zh-CN。 */
function languageSupported(tag: string, allowed: readonly string[]): boolean {
  const lower = tag.toLowerCase();
  const primary = lower.split("-")[0];
  return allowed.some((entry) => {
    const candidate = entry.toLowerCase();
    return candidate === lower || candidate === primary;
  });
}

/** capability 以 modelId 索引；H3 以 profileId 为键（§4.3）。 */
export function executionLimitsKey(profile: ShotExecutionProfile): string {
  return profile.modelFamily === "minimax-h3" ? profile.profileId : profile.modelId;
}

function countHanCharacters(text: string): number {
  return (text.match(/\p{Script=Han}/gu) ?? []).length;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const PURPOSE_RANK = new Map<ReferencePurpose, number>(
  REFERENCE_PURPOSES.map((purpose, index) => [purpose, index]),
);

type IssueSink = {
  issues: ShotValidationIssue[];
  error(code: ShotValidationCode, field: string, message: string): void;
  warn(code: ShotValidationCode, field: string, message: string): void;
};

function createIssueSink(): IssueSink {
  const issues: ShotValidationIssue[] = [];
  return {
    issues,
    error(code, field, message) { issues.push({ code, field, severity: "error", message }); },
    warn(code, field, message) { issues.push({ code, field, severity: "warning", message }); },
  };
}

const TERRITORY_RE = /^[A-Z]{2}$/;

/** 只保留自有属性并置空原型：policy 的三个 record 直接以外部 id 取值，原型键（constructor 等）不得命中。 */
function parseRecord<T>(
  value: unknown,
  subject: string,
  parseEntry: (entry: unknown, label: string) => T,
): Record<string, T> {
  const row = requireRecord(value, subject);
  const out: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(row)) {
    if (!Object.hasOwn(row, key)) continue;
    requireText(key, `${subject} 的键`, 128);
    out[key] = parseEntry(row[key], `${subject}[${JSON.stringify(key)}]`);
  }
  return out;
}

export function parseShotExecutionProfile(
  value: unknown,
  subject = "ShotExecutionProfile",
): ShotExecutionProfile {
  const row = requireRecord(value, subject);
  const common = [
    "version", "kind", "profileId", "backendInstanceId", "workflowSha256", "modelSha256",
    "parametersSha256", "resolution", "aspectRatio", "generateAudio", "modelFamily", "operation",
  ] as const;
  const family = requireEnum(row.modelFamily, `${subject}.modelFamily`, SHOT_MODEL_FAMILIES);
  const extras: Readonly<Record<ShotModelFamily, readonly string[]>> = {
    "minimax-h3": ["variant", "shortEdge", "durationSeconds"],
    seedance: ["provider", "modelId", "watermark", "returnLastFrame", "executionExpiresAfterSeconds"],
    veo: ["modelId", "location", "sampleCount", "ioMode"],
  };
  exactKeys(row, [...common, ...extras[family]], subject);
  requireVersion(row.version, subject);
  if (row.kind !== "writing-loop/execution-profile") {
    fail(`${subject}.kind`, "必须是 writing-loop/execution-profile");
  }
  const base = {
    version: 1 as const,
    kind: "writing-loop/execution-profile" as const,
    profileId: requireId(row.profileId, `${subject}.profileId`),
    backendInstanceId: requireText(row.backendInstanceId, `${subject}.backendInstanceId`, 256),
    workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
    modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
    parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
    resolution: requireText(row.resolution, `${subject}.resolution`, 32),
    aspectRatio: requireText(row.aspectRatio, `${subject}.aspectRatio`, 32),
    generateAudio: requireBoolean(row.generateAudio, `${subject}.generateAudio`),
  };
  if (family === "minimax-h3") {
    if (row.operation !== "comfyui-workflow" && row.operation !== "minimax-h3") {
      fail(`${subject}.operation`, "H3 transport 必须是 comfyui-workflow 或 minimax-h3");
    }
    if (row.shortEdge !== 768) fail(`${subject}.shortEdge`, "H3 v1 必须固定为 768");
    return {
      ...base,
      modelFamily: "minimax-h3",
      operation: row.operation,
      variant: requireEnum(row.variant, `${subject}.variant`, ["fl2va", "ref2va"] as const),
      shortEdge: 768,
      durationSeconds: requireInteger(row.durationSeconds, `${subject}.durationSeconds`, 1, 600),
    };
  }
  if (family === "seedance") {
    if (row.operation !== "ark-video-task") fail(`${subject}.operation`, "seedance 必须是 ark-video-task");
    if (row.watermark !== false) fail(`${subject}.watermark`, "必须固定为 false");
    if (row.returnLastFrame !== true) fail(`${subject}.returnLastFrame`, "必须固定为 true");
    return {
      ...base,
      modelFamily: "seedance",
      operation: "ark-video-task",
      provider: requireEnum(row.provider, `${subject}.provider`, ["volcengine-ark", "byteplus-modelark"] as const),
      modelId: requireText(row.modelId, `${subject}.modelId`, 128),
      watermark: false,
      returnLastFrame: true,
      // §4.2：[3600, 259200]，按批次规模配置。
      executionExpiresAfterSeconds: requireInteger(row.executionExpiresAfterSeconds, `${subject}.executionExpiresAfterSeconds`, 3_600, 259_200),
    };
  }
  if (row.operation !== "vertex-veo-lro") fail(`${subject}.operation`, "veo 必须是 vertex-veo-lro");
  if (row.location !== "us-central1") fail(`${subject}.location`, "v1 只接受 us-central1");
  if (row.sampleCount !== 1) fail(`${subject}.sampleCount`, "必须固定为 1");
  return {
    ...base,
    modelFamily: "veo",
    operation: "vertex-veo-lro",
    modelId: requireText(row.modelId, `${subject}.modelId`, 128),
    location: "us-central1",
    sampleCount: 1,
    ioMode: requireEnum(row.ioMode, `${subject}.ioMode`, ["inline-base64", "gcs"] as const),
  };
}

export function parseShotCompilePolicy(value: unknown, subject = "ShotCompilePolicy"): ShotCompilePolicy {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "version", "anchorPreference", "casAuthority", "compiler", "execution", "project",
    "approvedCandidates", "propStates", "intent",
  ], subject);
  requireVersion(row.version, subject);
  const casAuthority = requireText(row.casAuthority, `${subject}.casAuthority`, 63);
  if (!CAS_AUTHORITY_RE.test(casAuthority)) fail(`${subject}.casAuthority`, "必须是小写 CAS authority（如 wl-sg）");

  const projectRow = requireRecord(row.project, `${subject}.project`);
  exactKeys(projectRow, [
    "allowedProcessingRegions", "licenseCompliance", "usesOutputToImproveModels",
  ], `${subject}.project`);
  const regions = requireArray(projectRow.allowedProcessingRegions, `${subject}.project.allowedProcessingRegions`, 64)
    .map((entry, index) => {
      const label = `${subject}.project.allowedProcessingRegions[${index}]`;
      if (typeof entry !== "string" || !TERRITORY_RE.test(entry)) fail(label, "必须是大写二位地域码");
      return entry as string;
    });

  const intentRow = requireRecord(row.intent, `${subject}.intent`);
  exactKeys(intentRow, [
    "taskId", "createdAt", "useTerritories", "budget", "rights", "moderation", "license",
  ], `${subject}.intent`);
  // budget / rights / moderation 的深校验由 parseProductionIntentDraft 承担（同一套 v1 语义，
  // 不在此复制第二份判据）；这里只固定形状与 exactKeys。license 是例外：编译期就要读它的 obligations
  // 判定 license_obligation_unmet，因此直接调用 production-intent.ts 的同一个解析器，而不是第二份判据。
  const intent = {
    taskId: requireId(intentRow.taskId, `${subject}.intent.taskId`),
    createdAt: requireText(intentRow.createdAt, `${subject}.intent.createdAt`, 64),
    useTerritories: requireArray(intentRow.useTerritories, `${subject}.intent.useTerritories`, 64)
      .map((entry, index) => requireText(entry, `${subject}.intent.useTerritories[${index}]`, 16)),
    budget: requireRecord(intentRow.budget, `${subject}.intent.budget`) as unknown as ShotCompilePolicy["intent"]["budget"],
    rights: requireRecord(intentRow.rights, `${subject}.intent.rights`) as unknown as ShotCompilePolicy["intent"]["rights"],
    moderation: requireRecord(intentRow.moderation, `${subject}.intent.moderation`) as unknown as ShotCompilePolicy["intent"]["moderation"],
    license: parseProductionLicenseEvidence(intentRow.license, `${subject}.intent.license`),
  };

  return {
    version: 1,
    anchorPreference: requireEnum(row.anchorPreference, `${subject}.anchorPreference`, ["keyframes", "references"] as const),
    casAuthority,
    compiler: requireText(row.compiler, `${subject}.compiler`, 128),
    execution: parseShotExecutionProfile(row.execution, `${subject}.execution`),
    project: {
      allowedProcessingRegions: regions,
      licenseCompliance: parseProductionLicenseCompliance(
        projectRow.licenseCompliance,
        `${subject}.project.licenseCompliance`,
      ),
      usesOutputToImproveModels: requireBoolean(
        projectRow.usesOutputToImproveModels,
        `${subject}.project.usesOutputToImproveModels`,
      ),
    },
    approvedCandidates: parseRecord(row.approvedCandidates, `${subject}.approvedCandidates`, (entry, label) => {
      const candidate = requireRecord(entry, label);
      exactKeys(candidate, ["sha256", "status", "reviewedBy", "reviewedAt"], label);
      return {
        sha256: requireSha256(candidate.sha256, `${label}.sha256`),
        status: requireEnum(candidate.status, `${label}.status`, ["candidate", "approved", "rejected"] as const),
        reviewedBy: nullableText(candidate.reviewedBy, `${label}.reviewedBy`, 128),
        reviewedAt: nullableText(candidate.reviewedAt, `${label}.reviewedAt`, 64),
      };
    }),
    propStates: parseRecord(row.propStates, `${subject}.propStates`, (entry, label) =>
      requireArray(entry, label, 128).map((state, index) => requireId(state, `${label}[${index}]`))),
    intent,
  };
}

/**
 * 纯函数编译：draft + capability + execution profile → 不可变 ShotRequest、intent draft 与 ValidationReport。
 *
 * 结构性违约（camera 未补齐、profile 与 capability 的后端实例不一致、capability 缺该 modelId 的 limits）
 * 以 ProductionError 抛出——它们是装配错误，不是镜头级校验结果；镜头级差异一律进 issues / degradations。
 */
export function compileShotRequest(
  draftValue: ShotRequestDraft,
  capability: ShotCompileCapability,
  policyValue: ShotCompilePolicy,
): CompileShotRequestResult {
  const draft = parseShotRequestDraft(draftValue);
  const policy = parseShotCompilePolicy(policyValue);
  const profile = policy.execution;
  if (draft.camera === null) {
    fail("ShotRequestDraft.camera", "未补齐（分镜步骤或人工填写后方可编译）");
  }
  const camera = draft.camera;
  if (draft.prompt.text === null) {
    fail("ShotRequestDraft.prompt.text", "未撰写（写作侧步骤补齐后方可编译）");
  }
  const draftPromptText = draft.prompt.text;
  if (profile.backendInstanceId !== capability.backendInstanceId) {
    fail("ShotCompilePolicy.execution.backendInstanceId", "必须与 capability.backendInstanceId 相同");
  }
  if (!capability.modelFamilies.includes(profile.modelFamily)) {
    fail("ShotCompilePolicy.execution.modelFamily", `不在 capability.modelFamilies=[${capability.modelFamilies.join(",")}] 内`);
  }
  const limitsKey = executionLimitsKey(profile);
  const limits = capability.limitsByModelId[limitsKey];
  if (limits === undefined) {
    fail("BackendCapabilities.limitsByModelId", `缺少键 ${JSON.stringify(limitsKey)} 的 limits`);
  }

  const sink = createIssueSink();
  const degradations: Degradation[] = [];
  const family = profile.modelFamily;

  // 处理地域与许可（§4.7 的编译侧前置判定）
  for (const region of capability.processingRegions) {
    if (!policy.project.allowedProcessingRegions.includes(region)) {
      sink.error(
        "processing_region_not_allowed",
        "BackendCapabilities.processingRegions",
        `后端处理地域 ${region} 不在项目 allowedProcessingRegions=[${policy.project.allowedProcessingRegions.join(",")}] 内`,
      );
    }
  }
  if (policy.intent.license.status === "blocked") {
    sink.error("license_blocked", "ProductionIntentDraft.license.status", "许可证据为 blocked，禁止编译该镜头");
  }
  // 义务的唯一来源是 license evidence，判据是 production-intent.ts 的 licenseObligationViolations——
  // 编译器与 intent gate 对同一输入必然给出同一结论（§4.2、§4.7）。
  const license = policy.intent.license;
  for (const violation of licenseObligationViolations(license, policy.project.licenseCompliance, {
    explicitWrittenLicense: hasExplicitWrittenLicense(license),
  })) {
    sink.error("license_obligation_unmet", `project.licenseCompliance.${violation.field}`, violation.message);
  }
  // noModelImprovement 是编译期专属条款（§4.1、AI-SPEC 使用约束），gate 不判定。
  if ((license.obligations?.noModelImprovement ?? false) && policy.project.usesOutputToImproveModels) {
    sink.error(
      "license_obligation_unmet",
      "project.usesOutputToImproveModels",
      "许可禁止以输出改进其他模型，项目声明为 true",
    );
  }

  // 画幅 / 分辨率 / 输出意图（§4.1）
  if (!limits.aspectRatios.includes(profile.aspectRatio)) {
    sink.error(
      "aspect_ratio_unsupported",
      "execution.aspectRatio",
      `画幅 ${profile.aspectRatio} 不在 ${limitsKey} 支持集合 [${limits.aspectRatios.join(",")}] 内`,
    );
  }
  if (!limits.resolutions.includes(profile.resolution)) {
    sink.error(
      "resolution_unsupported",
      "execution.resolution",
      `分辨率 ${profile.resolution} 不在 ${limitsKey} 支持集合 [${limits.resolutions.join(",")}] 内`,
    );
  }
  if (draft.output.aspectRatio !== profile.aspectRatio) {
    sink.error(
      "output_intent_mismatch",
      "output.aspectRatio",
      `请求意图 ${draft.output.aspectRatio} 与 execution profile ${profile.aspectRatio} 不等`,
    );
  }
  if (draft.output.generateAudio !== profile.generateAudio) {
    sink.error(
      "output_intent_mismatch",
      "output.generateAudio",
      `请求意图 ${draft.output.generateAudio} 与 execution profile ${profile.generateAudio} 不等`,
    );
  }
  if (draft.output.generateAudio && limits.nativeAudio.status === "unsupported") {
    sink.error(
      "output_intent_mismatch",
      "output.generateAudio",
      `${limitsKey} 不支持原生音频，无法满足 generateAudio 意图`,
    );
  }
  if (draft.output.generateAudio && limits.nativeAudio.status === "unverified") {
    sink.warn(
      "native_audio_unverified",
      "output.generateAudio",
      `${limitsKey} 的原生音频状态未核实（探针前不作为结论）`,
    );
  }

  // 锚定侧选择与模式推导（§4.1）
  let firstFrame = draft.continuity.firstFrame;
  let lastFrame = draft.continuity.lastFrame;
  let references = [...draft.continuity.references];
  const droppedReferences: ReferenceInput[] = [];
  const hasKeyframes = firstFrame !== null || lastFrame !== null;
  if (hasKeyframes && references.length > 0 && limits.keyframesAndReferencesExclusive) {
    if (policy.anchorPreference === "keyframes") {
      droppedReferences.push(...references);
      references = [];
      degradations.push({
        code: "anchor-mode-selected",
        from: "keyframes+references",
        to: "keyframes",
        requiresReapproval: true,
      });
    } else {
      firstFrame = null;
      lastFrame = null;
      degradations.push({
        code: "anchor-mode-selected",
        from: "keyframes+references",
        to: "references",
        requiresReapproval: true,
      });
    }
  }
  if (lastFrame !== null && firstFrame === null) {
    sink.error("last_frame_without_first", "continuity.lastFrame", "lastFrame 非空时 firstFrame 必须非空");
  }
  const mode = deriveVideoMode({ firstFrame, lastFrame, references });
  const anchorMode: AnchorMode = firstFrame !== null || lastFrame !== null
    ? "keyframes"
    : references.length > 0 ? "references" : "none";
  if (!limits.modes.includes(mode)) {
    // t2v 在契约里根本没有对应 generator（H3 §3），其余模式是连续性组合不被支持。
    if (mode === "t2v") {
      sink.error("unsupported_operation", "continuity", `${limitsKey} 不支持 t2v（契约无对应 generator）`);
    } else {
      sink.error(
        "unsupported_continuity_mode",
        "continuity",
        `模式 ${mode} 不在 ${limitsKey} 支持集合 [${limits.modes.join(",")}] 内`,
      );
    }
  }
  if (family === "minimax-h3") {
    // variant === null 只发生在 t2v，上一条已记 unsupported_operation，这里不再叠加第二条。
    const variant = h3VariantForMode(mode);
    if (variant !== null && variant !== profile.variant) {
      sink.error(
        "unsupported_continuity_mode",
        "execution.variant",
        `模式 ${mode} 对应 H3 generator ${variant}，与 profile.variant=${profile.variant} 不一致`,
      );
    }
  }

  // 参考上限与裁剪（§4.1）
  const kinds = new Map<ReferenceInput, "image" | "video" | "audio" | "other">();
  for (const reference of references) kinds.set(reference, referenceAssetKind(reference));
  const ordered = [...references].sort((left, right) => {
    const rank = (PURPOSE_RANK.get(left.purpose) ?? 0) - (PURPOSE_RANK.get(right.purpose) ?? 0);
    if (rank !== 0) return rank;
    if (left.priority !== right.priority) return left.priority - right.priority;
    return references.indexOf(left) - references.indexOf(right);
  });
  const counters = { image: 0, video: 0, audio: 0, style: 0, total: 0 };
  const kept = new Set<ReferenceInput>();
  const overflow: ReferenceInput[] = [];
  // §5.2：Veo 的 referenceImages 是「≤3 张 asset 或 1 张 style」，二者互斥；按 purpose 顺序先到先得。
  const styleExclusiveWithAssets = family === "veo";
  for (const reference of ordered) {
    const kind = kinds.get(reference)!;
    const isStyle = reference.purpose === "style";
    const next = {
      image: counters.image + (kind === "image" && !isStyle ? 1 : 0),
      video: counters.video + (kind === "video" ? 1 : 0),
      audio: counters.audio + (kind === "audio" ? 1 : 0),
      style: counters.style + (kind === "image" && isStyle ? 1 : 0),
      total: counters.total + 1,
    };
    const fits = next.image <= limits.maxReferenceImages
      && next.video <= limits.maxReferenceVideos
      && next.audio <= limits.maxReferenceAudios
      && next.style <= limits.maxStyleImages
      && !(styleExclusiveWithAssets && next.image > 0 && next.style > 0)
      && (limits.maxReferenceAssetsTotal === null || next.total <= limits.maxReferenceAssetsTotal);
    if (fits) {
      kept.add(reference);
      counters.image = next.image;
      counters.video = next.video;
      counters.audio = next.audio;
      counters.style = next.style;
      counters.total = next.total;
    } else {
      overflow.push(reference);
    }
  }
  // 裁剪掉的项若在 draft 原序中排在某个保留项之前，保留项的序号会前移，prompt 里写死的「图片N」随之错位。
  let referenceIndexesShifted = false;
  if (overflow.length > 0) {
    if (draft.continuity.referencePolicy === "strict") {
      sink.error(
        "reference_cap_exceeded",
        "continuity.references",
        `参考数量超过 ${limitsKey} 上限（图 ${limits.maxReferenceImages} / 视频 ${limits.maxReferenceVideos} / 音频 ${limits.maxReferenceAudios} / style ${limits.maxStyleImages}），referencePolicy=strict 不裁剪`,
      );
    } else {
      // 裁剪按 purpose 顺序再按 priority；保留项在 ShotRequest 里维持 draft 原序，
      // 以免 prompt 里「图片N」的序号被编译器悄悄改写（§6.6）。
      const preTrim = references;
      const maxKeptIndex = preTrim.reduce(
        (acc, reference, index) => (kept.has(reference) ? index : acc),
        -1,
      );
      referenceIndexesShifted = overflow.some((reference) => preTrim.indexOf(reference) < maxKeptIndex);
      references = preTrim.filter((reference) => kept.has(reference));
      droppedReferences.push(...overflow);
      degradations.push({
        code: "references-trimmed",
        from: `${ordered.length} 项参考`,
        to: `${references.length} 项参考`,
        // 裁剪改变了下发给后端的素材集合，一律需要重新裁定（不因"只少了低优先级项"而免审）。
        requiresReapproval: true,
      });
    }
  }
  const keptKinds = references.map((reference) => kinds.get(reference)!);
  if (references.length > 0 && keptKinds.every((kind) => kind === "audio") && !limits.audioOnlyReference) {
    sink.error(
      "audio_only_reference_unsupported",
      "continuity.references",
      `${limitsKey} 不接受仅音频参考`,
    );
  }

  // 输入资产的体积 / 媒体类型 / 真人人脸 / 候选图批准（§4.1、§6.2）
  const checkRealFace = (containsRealFace: boolean, field: string): void => {
    if (containsRealFace && limits.realFaceReferences === "forbidden") {
      sink.error("real_face_unauthorized", field, `${limitsKey} 拒绝含真人人脸的输入`);
    }
  };
  const checkImageAsset = (asset: AssetRef, field: string): void => {
    if (asset.byteLength > limits.maxInputImageBytes) {
      sink.error(
        "image_too_large",
        field,
        `输入 ${asset.byteLength} 字节超过 ${limitsKey} 上限 ${limits.maxInputImageBytes}`,
      );
    }
    if (!limits.inputImageMediaTypes.includes(asset.mediaType)) {
      sink.error(
        "image_mime_unsupported",
        field,
        `媒体类型 ${asset.mediaType} 不在 ${limitsKey} 支持集合 [${limits.inputImageMediaTypes.join(",")}] 内`,
      );
    }
  };
  for (const [slot, keyframe] of [["firstFrame", firstFrame], ["lastFrame", lastFrame]] as const) {
    if (keyframe === null) continue;
    const field = `continuity.${slot}`;
    checkImageAsset(keyframe.asset, field);
    checkRealFace(keyframe.containsRealFace, field);
    if (keyframe.origin.kind === "approved-candidate") {
      const candidate = Object.hasOwn(policy.approvedCandidates, keyframe.origin.candidateId)
        ? policy.approvedCandidates[keyframe.origin.candidateId]
        : undefined;
      if (candidate === undefined) {
        sink.error("keyframe_not_approved", field, `候选图 ${keyframe.origin.candidateId} 不在 visual/production.v1.json`);
      } else if (candidate.status !== "approved" || candidate.reviewedBy === null || candidate.reviewedAt === null) {
        sink.error("keyframe_not_approved", field, `候选图 ${keyframe.origin.candidateId} 未批准或缺复核署名`);
      } else if (candidate.sha256 !== keyframe.asset.sha256) {
        sink.error("keyframe_not_approved", field, `候选图 ${keyframe.origin.candidateId} 的 sha256 与输入资产不符`);
      }
    }
  }
  references.forEach((reference, index) => {
    const field = `continuity.references[${index}]`;
    const kind = kinds.get(reference)!;
    if (kind === "image") checkImageAsset(reference.asset, field);
    else if (kind === "other") {
      sink.error(
        "image_mime_unsupported",
        field,
        `媒体类型 ${reference.asset.mediaType} 既非图片也非视频 / 音频参考`,
      );
    }
    checkRealFace(reference.containsRealFace, field);
  });

  // 输入资产重复：intent inputs[] 不接受重复 AssetRef（production-intent.ts），且同一张图占两个 slot
  // 在语义上也不成立（首尾帧相同 = 静止镜头，参考重复 = 序号虚增）。在编译期判定，不留给 intent 解析抛错。
  const inputIdentities = new Map<string, string>();
  for (const [field, entry] of [
    ["continuity.firstFrame", firstFrame?.asset ?? null],
    ["continuity.lastFrame", lastFrame?.asset ?? null],
    ...references.map((reference, index) => [`continuity.references[${index}]`, reference.asset] as const),
  ] as const) {
    if (entry === null) continue;
    // 以 sha256 为身份：urn:sha256 与 cas:// 两种写法在 §6.4 的再登记后指向同一对象，
    // 只比 uri 会把「同一素材换个写法」放过去，到 parseProductionIntentDraft 才抛错。
    const identity = entry.sha256;
    const previous = inputIdentities.get(identity);
    if (previous !== undefined) {
      sink.error(
        "unsupported_continuity_mode",
        field,
        `与 ${previous} 指向同一资产（sha256 ${entry.sha256.slice(0, 12)}…），一份 intent 的 inputs[] 不接受重复 AssetRef`,
      );
    } else {
      inputIdentities.set(identity, field);
    }
  }

  // 道具状态登记（§6.1）
  draft.props.forEach((prop, index) => {
    const registered = Object.hasOwn(policy.propStates, prop.objectId)
      ? policy.propStates[prop.objectId]
      : undefined;
    if (registered === undefined || !registered.includes(prop.stateId)) {
      sink.error(
        "prop_state_missing",
        `props[${index}].stateId`,
        `道具 ${prop.objectId} 的状态 ${prop.stateId} 未登记于 visual/prop-states.v1.json`,
      );
    }
  });

  // 时长网格（§4.1、§4.2）
  const storyboardSeconds = draft.output.storyboardDurationSeconds;
  const base = Math.max(4, storyboardSeconds);
  const gridByResolution = limits.durationSeconds.gridByResolution;
  const grid = gridByResolution !== null && Object.hasOwn(gridByResolution, profile.resolution)
    ? gridByResolution[profile.resolution]
    : limits.durationSeconds.grid;
  let durationSeconds: number | null = null;
  if (grid !== null && grid !== undefined) {
    const candidates = [...grid].sort((left, right) => left - right);
    durationSeconds = candidates.find((value) => value >= base) ?? null;
    if (durationSeconds === null) {
      sink.error(
        "duration_out_of_range",
        "output.storyboardDurationSeconds",
        `分镜时长 ${storyboardSeconds}s 上取整后超出 ${limitsKey} 时长档 [${candidates.join(",")}]`,
      );
    }
  } else {
    durationSeconds = Math.ceil(base);
  }
  if (durationSeconds !== null
    && (durationSeconds < limits.durationSeconds.min || durationSeconds > limits.durationSeconds.max)) {
    sink.error(
      "duration_out_of_range",
      "output.durationSeconds",
      `时长 ${durationSeconds}s 不在 ${limitsKey} 区间 [${limits.durationSeconds.min},${limits.durationSeconds.max}]`,
    );
    durationSeconds = null;
  }
  if (durationSeconds !== null && durationSeconds !== storyboardSeconds) {
    degradations.push({
      code: "duration-rounded-trim",
      from: `${storyboardSeconds}s`,
      to: `${durationSeconds}s`,
      requiresReapproval: false,
    });
  }
  if (durationSeconds !== null && family === "veo") {
    // ref2v 与 1080p / 4k 的时长被后端锁死为 8s（保守默认）。此处校验而不再次上取整：
    // 4s → 8s 会成倍改变成本与画面时长，属于须重新裁定的差异，不做静默改写。
    const locked = mode === "ref2v" || (VEO_LOCKED_RESOLUTIONS as readonly string[]).includes(profile.resolution);
    if (locked && durationSeconds !== VEO_LOCKED_DURATION_SECONDS) {
      sink.error(
        "duration_out_of_range",
        "output.durationSeconds",
        `Veo 在 ${mode === "ref2v" ? "ref2v" : profile.resolution} 下固定 ${VEO_LOCKED_DURATION_SECONDS}s，得到 ${durationSeconds}s`,
      );
    }
  }
  if (durationSeconds !== null && family === "minimax-h3" && durationSeconds !== profile.durationSeconds) {
    sink.error(
      "duration_out_of_range",
      "output.durationSeconds",
      `时长 ${durationSeconds}s 与已配置 profile ${profile.profileId} 的时长档 ${profile.durationSeconds}s 不一致`,
    );
  }

  // seed（§4.1、§5.1、§5.2）
  const seed = draft.output.seed;
  if (seed !== null && limits.seed === "unsupported") {
    sink.error("seed_rejected", "output.seed", `${limitsKey} 未列入 seed 支持，output.seed 必须为 null`);
  }
  if (limits.seed === "uint32-best-effort") {
    degradations.push({
      code: "seed-not-reproducible",
      from: "seed",
      to: "best-effort（prompt rewriter 不可关闭）",
      requiresReapproval: false,
    });
  }
  const seedReproducible = limits.seed === "uint32" || limits.seed === "int32";

  // negative prompt（§4.1、§5.1、§5.3）
  if (draft.prompt.negativeText !== null) {
    if (family === "minimax-h3") {
      sink.error(
        "negative_prompt_unsupported",
        "prompt.negativeText",
        "H3 契约无 negative 输入，negativeText 必须为 null（不折进 prompt 文本）",
      );
    } else if (family === "seedance") {
      degradations.push({
        code: "negative-prompt-folded",
        from: "prompt.negativeText",
        to: "prompt.text 追加「避免出现：…」",
        requiresReapproval: false,
      });
    }
  }

  // prompt 语言与译文选用（§4.1、§8.5）
  let promptText = draftPromptText;
  let promptNegative = draft.prompt.negativeText;
  let promptLanguage = draft.prompt.language;
  let selectedTranslation: ShotPrompt["selectedTranslation"] = null;
  if (limits.promptLanguages !== null && !languageSupported(promptLanguage, limits.promptLanguages)) {
    const translation = draft.prompt.translations
      .find((entry) => languageSupported(entry.language, limits.promptLanguages!)) ?? null;
    if (translation === null) {
      sink.error(
        "prompt_language_unsupported",
        "prompt.language",
        `${limitsKey} 只接受 [${limits.promptLanguages.join(",")}]，draft 语言 ${promptLanguage} 且无可用译文`,
      );
    } else {
      degradations.push({
        code: "prompt-translated",
        from: promptLanguage,
        to: translation.language,
        requiresReapproval: true,
      });
      promptText = translation.text;
      promptNegative = translation.negativeText;
      promptLanguage = translation.language;
      selectedTranslation = { language: translation.language, authoredBy: translation.authoredBy };
    }
  }
  draft.dialogue.forEach((line, index) => {
    if (!line.lipSync || limits.promptLanguages === null) return;
    if (!languageSupported(line.language, limits.promptLanguages)) {
      sink.error(
        "dialogue_language_unsupported",
        `dialogue[${index}].language`,
        `口型对白语言 ${line.language} 不在 ${limitsKey} 支持集合 [${limits.promptLanguages.join(",")}] 内`,
      );
    }
  });

  // provider 文本指令与参考序号（§4.1、§6.6）
  for (const [field, text] of [["prompt.text", promptText], ["prompt.negativeText", promptNegative]] as const) {
    if (text !== null && PROVIDER_DIRECTIVE_RE.test(text)) {
      sink.error(
        "prompt_contains_provider_directive",
        field,
        `命中 provider 文本指令形态 ${JSON.stringify(PROVIDER_DIRECTIVE_RE.exec(text)![0].trim())}（\`--flag\` 一律拒绝，参数只走请求体）`,
      );
    }
  }
  const availableByCategory = {
    image: keptKinds.filter((kind) => kind === "image").length,
    video: keptKinds.filter((kind) => kind === "video").length,
    audio: keptKinds.filter((kind) => kind === "audio").length,
  };
  const scanner = new RegExp(REFERENCE_INDEX_RE.source, "gu");
  const referenceMentions = [...promptText.matchAll(scanner)];
  for (const match of referenceMentions) {
    const hit = match[0];
    const category = hit.includes("视频") ? "video" : hit.includes("音频") ? "audio" : "image";
    const index = Number(/(\d+)$/.exec(hit)![1]);
    const available = availableByCategory[category];
    if (!Number.isInteger(index) || index < 1 || index > available) {
      sink.error(
        "reference_index_out_of_range",
        "prompt.text",
        `prompt 引用「${hit}」，但该类参考只有 ${available} 项`,
      );
    }
  }
  if (referenceIndexesShifted && referenceMentions.length > 0) {
    sink.error(
      "reference_index_out_of_range",
      "continuity.references",
      `裁剪掉的参考排在保留项之前，保留项序号将前移，prompt 里写死的「${referenceMentions[0][0]}」会指向另一份素材；请改写 prompt 或改用 referencePolicy=strict`,
    );
  }

  // 长度提示（§5.1 provider 建议值）
  if (family === "seedance") {
    const hanCount = countHanCharacters(promptText);
    const wordCount = countWords(promptText);
    if (hanCount > SEEDANCE_PROMPT_CHAR_RECOMMENDATION || wordCount > SEEDANCE_PROMPT_WORD_RECOMMENDATION) {
      sink.warn(
        "prompt_length_over_recommendation",
        "prompt.text",
        `prompt 中文 ${hanCount} 字 / 英文 ${wordCount} 词，超过建议值 ${SEEDANCE_PROMPT_CHAR_RECOMMENDATION} 字 / ${SEEDANCE_PROMPT_WORD_RECOMMENDATION} 词`,
      );
    }
  }

  const issues = sink.issues;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const validation: ValidationReport = {
    version: 1,
    shotId: draft.shotId,
    mode,
    issues,
    errors,
    warnings: issues.length - errors,
  };
  if (errors > 0 || durationSeconds === null) {
    return { shotRequest: null, intentDraft: null, validation, degradations };
  }

  const draftSha256 = productionCanonicalJsonSha256(draft);
  const casRewrite = (asset: AssetRef): AssetRef => rewriteToCasUri(asset, policy.casAuthority);
  const rewrittenFirstFrame = firstFrame === null ? null : { ...firstFrame, asset: casRewrite(firstFrame.asset) };
  const rewrittenLastFrame = lastFrame === null ? null : { ...lastFrame, asset: casRewrite(lastFrame.asset) };
  const rewrittenReferences = references.map((reference) => ({ ...reference, asset: casRewrite(reference.asset) }));
  const rewrittenDropped = droppedReferences.map((reference) => ({ ...reference, asset: casRewrite(reference.asset) }));
  const rewrittenPasses = draft.continuity.spatialPasses.map(casRewrite);
  const policyDigest = productionCanonicalJsonSha256({
    version: policy.version,
    anchorPreference: policy.anchorPreference,
    casAuthority: policy.casAuthority,
    compiler: policy.compiler,
    execution: profile,
    project: {
      allowedProcessingRegions: [...policy.project.allowedProcessingRegions],
      licenseCompliance: { ...policy.project.licenseCompliance },
    },
    capability: {
      backendKind: capability.backendKind,
      backendInstanceId: capability.backendInstanceId,
      modelFamilies: [...capability.modelFamilies],
      processingRegions: [...capability.processingRegions],
      limits,
    },
  });

  const shotRequest = parseShotRequest({
    version: 1,
    kind: SHOT_REQUEST_KIND,
    shotId: draft.shotId,
    subject: draft.subject,
    provenance: draft.provenance,
    scene: draft.scene,
    camera,
    cast: draft.cast,
    props: draft.props,
    crowd: draft.crowd,
    action: draft.action,
    productionTags: draft.productionTags,
    dialogue: draft.dialogue,
    output: {
      aspectRatio: draft.output.aspectRatio,
      generateAudio: draft.output.generateAudio,
      durationSeconds,
      storyboardDurationSeconds: draft.output.storyboardDurationSeconds,
      fps: 24,
      seed,
    },
    continuity: {
      stageGroup: draft.continuity.stageGroup,
      prevShotId: draft.continuity.prevShotId,
      anchorMode,
      firstFrame: rewrittenFirstFrame,
      lastFrame: rewrittenLastFrame,
      references: rewrittenReferences,
      referencePolicy: draft.continuity.referencePolicy,
      droppedReferences: rewrittenDropped,
      spatialPasses: rewrittenPasses,
      fingerprint: {
        modelSha256: profile.modelSha256,
        workflowSha256: profile.workflowSha256,
        seed,
        seedReproducible,
      },
    },
    prompt: {
      text: promptText,
      negativeText: promptNegative,
      language: promptLanguage,
      authoredBy: draft.prompt.authoredBy,
      compiler: policy.compiler,
      selectedTranslation,
    },
    compile: { draftSha256, policyDigest, degradations },
  });

  return {
    shotRequest,
    intentDraft: buildIntentDraft(shotRequest, capability, policy, durationSeconds),
    validation,
    degradations,
  };
}

/**
 * intent draft：inputs[0] 为 ShotRequest 自身的 CAS AssetRef，其后依次是
 * [first_frame?, last_frame?, reference_image*, reference_video*, reference_audio*]（§6.5）。
 */
function buildIntentDraft(
  shotRequest: ShotRequest,
  capability: ShotCompileCapability,
  policy: ShotCompilePolicy,
  durationSeconds: number,
): ProductionIntentDraft | null {
  const profile = policy.execution;
  if (profile.modelFamily !== "minimax-h3") return null;
  const inputs: AssetRef[] = [shotRequestAssetRef(shotRequest, policy.casAuthority)];
  if (shotRequest.continuity.firstFrame !== null) inputs.push(shotRequest.continuity.firstFrame.asset);
  if (shotRequest.continuity.lastFrame !== null) inputs.push(shotRequest.continuity.lastFrame.asset);
  for (const reference of shotRequest.continuity.references) inputs.push(reference.asset);
  if (inputs.length > MAX_PRODUCTION_INTENT_INPUTS) {
    fail("ProductionIntentDraft.inputs", `输入数量 ${inputs.length} 超过上限 ${MAX_PRODUCTION_INTENT_INPUTS}`);
  }
  return parseProductionIntentDraft({
    version: 1,
    taskId: policy.intent.taskId,
    subject: { version: 1, kind: "shot", shot: shotRequest.subject },
    createdAt: policy.intent.createdAt,
    useTerritories: policy.intent.useTerritories,
    execution: {
      version: 1,
      operation: profile.operation,
      modelFamily: "minimax-h3",
      backendInstanceId: capability.backendInstanceId,
      workflowSha256: profile.workflowSha256,
      modelSha256: profile.modelSha256,
      parametersSha256: profile.parametersSha256,
      variant: profile.variant,
      durationSeconds,
      shortEdge: profile.shortEdge,
      aspectRatio: shotRequest.output.aspectRatio,
    },
    inputs,
    budget: policy.intent.budget,
    rights: policy.intent.rights,
    moderation: policy.intent.moderation,
    license: policy.intent.license,
  });
}

// —— 剧本预填（§6.1「一行动作 = 一个镜头」） ——
export type ScriptSceneRegistryEntry = { id: string; name: string };

export type ShotRequestScriptOptions = {
  /** 集号，用于校验场景头 X 段与生成 shotId 前缀。 */
  episode: number;
  /** shotId / stageGroup 前缀，缺省 `EP` + 三位集号。 */
  episodeTag?: string;
  subject: { episode: EpisodeRevisionRef; revision: number; source: AssetRef };
  provenance: {
    storyDesignSha256: string;
    assetsRevision: number;
    visualProductionSha256: string | null;
    beatCardHash: string | null;
  };
  /** outline 注册景（最长前缀匹配，同 script-lint 的 L3-scene-registry）。 */
  sceneRegistry: readonly ScriptSceneRegistryEntry[];
  /** 注册具名角色；命中时 dialogue[].speakerId 取角色 ID，否则取剧本里的名字。 */
  characters?: readonly { id: string; name: string }[];
  output: { aspectRatio: ShotAspectRatio; generateAudio: boolean; seed: number | null };
  /** 分镜表缺位时每条 ▲ 行的占位时长（§6.1：分镜 / 人工填写）。 */
  defaultStoryboardDurationSeconds: number;
  prompt: { authoredBy: string; language?: string };
  referencePolicy?: ReferencePolicy;
  /** 只预填这些场序；缺省取全部场。 */
  sceneIndexes?: readonly number[];
};

export type ScriptShotDraft = {
  draft: ShotRequestDraft;
  sceneIndex: number;
  location: string;
  /** 调度单原样带出，供 cast[] / crowd 的人工与 assets 步骤填写（§6.1）。 */
  roster: Array<{ name: string; count: number | null; raw: string }>;
};

export type ScriptPrefillWarning = {
  code: "dialogue-before-first-action";
  line: number;
  text: string;
  shotId: string;
  message: string;
};

export type ScriptPrefillResult = { shots: ScriptShotDraft[]; warnings: ScriptPrefillWarning[] };

const TIME_OF_DAY_MAP: Readonly<Record<string, TimeOfDay>> = {
  日: "day", 午: "day", 夜: "night", 夜半: "night",
  晨: "dawn", 清晨: "dawn", 黎明: "dawn", 拂晓: "dawn",
  昏: "dusk", 黄昏: "dusk", 傍晚: "dusk",
};
const INTERIOR_MAP: Readonly<Record<string, Interior>> = { 内: "int", 外: "ext", 内外: "int-ext" };
const PRODUCTION_TAG_RE = /【([^】]+)】/g;

export function episodeTagFor(episode: number): string {
  return `EP${String(episode).padStart(3, "0")}`;
}

/** 内联标注 tag 的标签段：「字幕：十七日」→「字幕」。 */
export function productionTagLabel(tag: string): string {
  return tag.split(/[：:]/, 1)[0];
}

export function extractProductionTags(line: string): string[] {
  const tags: string[] = [];
  for (const match of line.matchAll(PRODUCTION_TAG_RE)) if (!tags.includes(match[1])) tags.push(match[1]);
  return tags;
}

/** OS = 内心独白、VO = 画外音（references/script-format.md）；其余按同场发声处理。 */
export function dialogueModeFromPrefix(prefix: string | null): DialogueMode {
  const value = prefix ?? "";
  if (/\bVO\b/i.test(value) || value.includes("画外")) return "vo";
  if (/\bOS\b/i.test(value) || value.includes("内心")) return "os";
  return "onscreen";
}

function resolveSceneRegistryEntry(
  location: string,
  registry: readonly ScriptSceneRegistryEntry[],
): ScriptSceneRegistryEntry {
  let best: ScriptSceneRegistryEntry | null = null;
  for (const entry of registry) {
    if (location.startsWith(entry.name) && (best === null || entry.name.length > best.name.length)) best = entry;
  }
  if (best === null) {
    fail("shotRequestFromScript", `场景头地点「${location}」不以任何注册景名开头（先过 script-lint L3-scene-registry）`);
  }
  return best;
}

/** 子景 = 注册景名之后的余段，去掉分隔用的「·」前缀（「沈家大院·京中寓所」→「京中寓所」）。 */
function sceneSubscene(location: string, sceneName: string): string | null {
  const value = location.slice(sceneName.length).replace(/^·/, "").trim();
  return value === "" ? null : value;
}

/**
 * 用 script-lint 的解析结果预填 draft：一条 ▲ 行一个镜头，对白归属其前最近的 ▲ 行。
 * camera 与 prompt.text 留 null（分镜 / 写作侧补齐），cast / props / crowd / 连续性输入留空由 plan-shots 装配。
 *
 * 两处非「一行动作 = 一个镜头」的语料形态：
 *   - 场内首个 ▲ 之前就有对白（ep-018.md:18 实测形）——归入本场第一镜并在 warnings[] 记行号与原文；
 *   - 独立标注行（整行【闪回结束】等，ep-008.md:22 实测形）——记为紧随其后那一镜的 productionTags，
 *     并因此成为合并的强制切分点（§6.1 条件 6）。
 */
export function shotRequestFromScript(
  scriptText: string,
  options: ShotRequestScriptOptions,
): ScriptPrefillResult {
  const parsed = parseEpisodeScript(scriptText);
  const episodeTag = options.episodeTag ?? episodeTagFor(options.episode);
  const characterIds = new Map((options.characters ?? []).map((entry) => [entry.name, entry.id]));
  const promptLanguage = options.prompt.language ?? DEFAULT_DIALOGUE_LANGUAGE;
  const referencePolicy = options.referencePolicy ?? "trim_by_priority";
  const shots: ScriptShotDraft[] = [];
  const warnings: ScriptPrefillWarning[] = [];

  for (const scene of parsed.scenes) {
    if (scene.episode !== options.episode) {
      fail("shotRequestFromScript", `场景头 ${scene.episode}-${scene.index} 的集号与 options.episode=${options.episode} 不符`);
    }
    if (options.sceneIndexes && !options.sceneIndexes.includes(scene.index)) continue;
    const registryEntry = resolveSceneRegistryEntry(scene.location, options.sceneRegistry);
    const subscene = sceneSubscene(scene.location, registryEntry.name);
    const timeOfDay = TIME_OF_DAY_MAP[scene.timeOfDay];
    if (timeOfDay === undefined) fail("shotRequestFromScript", `未知时段「${scene.timeOfDay}」`);
    const interior = INTERIOR_MAP[scene.interior];
    if (interior === undefined) fail("shotRequestFromScript", `未知内外「${scene.interior}」`);
    const stageGroup = `${episodeTag}-S${scene.index}${subscene === null ? "" : `·${subscene}`}`;
    const lineText = new Map(scene.lines.map((entry) => [entry.line, entry.text]));
    const annotations = sceneAnnotationLines(scene);

    let prevShotId: string | null = null;
    scene.actionLines.forEach((actionLine, ordinal) => {
      const previousActionLine = ordinal === 0 ? scene.headerLine : scene.actionLines[ordinal - 1];
      const nextActionLine = scene.actionLines[ordinal + 1] ?? Number.MAX_SAFE_INTEGER;
      const raw = (lineText.get(actionLine) ?? "").trim();
      const action = raw.replace(/^[▲△∆]\s*/, "").trim();
      if (action === "") fail("shotRequestFromScript", `第 ${actionLine} 行动作行为空`);
      const shotId = `${episodeTag}-S${scene.index}-${ordinal + 1}`;
      // 场内第一镜额外承接场景头与它之间的对白（首个 ▲ 之前的台词）。
      const dialogueFrom = ordinal === 0 ? previousActionLine : actionLine;
      const dialogue: ShotDialogueLine[] = scene.speakers
        .filter((speaker) => speaker.line > dialogueFrom && speaker.line < nextActionLine)
        .map((speaker) => {
          const mode = dialogueModeFromPrefix(speaker.prefix);
          if (speaker.line < actionLine) {
            warnings.push({
              code: "dialogue-before-first-action",
              line: speaker.line,
              text: (lineText.get(speaker.line) ?? speaker.text).trim(),
              shotId,
              message: `场 ${scene.episode}-${scene.index} 首个 ▲ 行之前的对白（第 ${speaker.line} 行）归入第一镜 ${shotId}`,
            });
          }
          return {
            speakerId: characterIds.get(speaker.name) ?? speaker.name,
            text: speaker.text.trim() === "" ? speaker.text : speaker.text.trim(),
            mode,
            language: DEFAULT_DIALOGUE_LANGUAGE,
            lipSync: mode === "onscreen",
          };
        });
      const leadingTags = annotations
        .filter((entry) => entry.line > previousActionLine && entry.line < actionLine)
        .flatMap((entry) => extractProductionTags(entry.text));
      const productionTags: string[] = [];
      for (const tag of [...leadingTags, ...extractProductionTags(raw)]) {
        if (!productionTags.includes(tag)) productionTags.push(tag);
      }
      const draft: ShotRequestDraft = {
        version: 1,
        kind: SHOT_REQUEST_DRAFT_KIND,
        shotId,
        subject: {
          version: 1,
          episode: options.subject.episode,
          shotId,
          revision: options.subject.revision,
          source: options.subject.source,
        },
        provenance: {
          storyDesignSha256: options.provenance.storyDesignSha256,
          assetsRevision: options.provenance.assetsRevision,
          visualProductionSha256: options.provenance.visualProductionSha256,
          beatCardHash: options.provenance.beatCardHash,
          scriptLine: actionLine,
          mergedScriptLines: [],
        },
        scene: { sceneId: registryEntry.id, subscene, timeOfDay, interior, lightingStateId: null, dressingVariantId: null },
        camera: null,
        cast: [],
        props: [],
        crowd: null,
        action,
        productionTags,
        dialogue,
        output: {
          aspectRatio: options.output.aspectRatio,
          generateAudio: options.output.generateAudio,
          storyboardDurationSeconds: options.defaultStoryboardDurationSeconds,
          fps: 24,
          seed: options.output.seed,
        },
        continuity: {
          stageGroup,
          prevShotId,
          firstFrame: null,
          lastFrame: null,
          references: [],
          referencePolicy,
          spatialPasses: [],
        },
        prompt: {
          text: null,
          negativeText: null,
          language: promptLanguage,
          authoredBy: options.prompt.authoredBy,
          translations: [],
        },
      };
      shots.push({
        draft: parseShotRequestDraft(draft),
        sceneIndex: scene.index,
        location: scene.location,
        roster: scene.roster.map((entry) => ({ name: entry.name, count: entry.count, raw: entry.raw })),
      });
      prevShotId = shotId;
    });
  }
  return { shots, warnings };
}

// —— 镜头合并（§6.1 决策 5，十条判定条件） ——
export const SHOT_MERGE_BLOCKERS = [
  "stage-group", "not-adjacent", "camera", "scene-state", "cast", "freeze-frame", "lip-sync-speakers",
  "duration-cap", "continuity-inputs", "shot-parameters", "structure-cap",
] as const;
export type ShotMergeBlocker = typeof SHOT_MERGE_BLOCKERS[number];

/** 与【画面定格】同级的强制切分标注：闪回的进出点也必须落在镜头边界上（§6.1 条件 6）。 */
export const FORCED_SPLIT_TAGS = [FREEZE_FRAME_TAG, "插入闪回", "闪回结束"] as const;

export type ShotMergeOptions = {
  /** execution profile 时长网格上界（条件 8）。 */
  maxStoryboardDurationSeconds: number;
};

export type ShotMergeWarning = { shotId: string; field: string; message: string };
export type ShotMergeResult = { drafts: ShotRequestDraft[]; warnings: ShotMergeWarning[] };

const sameCamera = (left: ShotCamera | null, right: ShotCamera | null): boolean =>
  left !== null && right !== null
  && left.shot_size === right.shot_size
  && left.camera_movement === right.camera_movement
  && left.lens_mm === right.lens_mm
  && left.lighting_key === right.lighting_key
  && left.depth_of_field === right.depth_of_field
  && left.color_temperature === right.color_temperature
  && left.cameraId === right.cameraId;

const sameCast = (left: readonly ShotCastMember[], right: readonly ShotCastMember[]): boolean => {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((member) => [member.characterId, member]));
  return left.every((member) => {
    const counterpart = rightById.get(member.characterId);
    return counterpart !== undefined && counterpart.appearanceStateId === member.appearanceStateId;
  });
};

const hasForcedSplitTag = (draft: ShotRequestDraft): boolean =>
  draft.productionTags.some((tag) => (FORCED_SPLIT_TAGS as readonly string[]).includes(productionTagLabel(tag)));

const lipSyncSpeakers = (dialogue: readonly ShotDialogueLine[]): Set<string> =>
  new Set(dialogue.filter((line) => line.lipSync).map((line) => line.speakerId));

const lastScriptLine = (draft: ShotRequestDraft): number =>
  Math.max(draft.provenance.scriptLine, ...draft.provenance.mergedScriptLines);

const sameJson = (left: unknown, right: unknown): boolean =>
  productionCanonicalJson(left) === productionCanonicalJson(right);

/** 右行是否带来了左行没有的连续性输入（条件 9）：合并会丢弃右行的这些字段，因此只要不同就不合并。 */
const continuityInputsConflict = (left: ShotRequestDraft, right: ShotRequestDraft): boolean => {
  const l = left.continuity;
  const r = right.continuity;
  if (r.firstFrame !== null && !sameJson(l.firstFrame, r.firstFrame)) return true;
  if (r.lastFrame !== null && !sameJson(l.lastFrame, r.lastFrame)) return true;
  if (r.references.length > 0 && !sameJson(l.references, r.references)) return true;
  if (r.spatialPasses.length > 0 && !sameJson(l.spatialPasses, r.spatialPasses)) return true;
  return false;
};

/** 逐镜请求参数（prompt 与 output 意图）不同则不合并（条件 10）：合并只能保留一份。 */
const shotParametersConflict = (left: ShotRequestDraft, right: ShotRequestDraft): boolean => {
  if (left.output.seed !== right.output.seed) return true;
  if (left.output.aspectRatio !== right.output.aspectRatio) return true;
  if (left.output.generateAudio !== right.output.generateAudio) return true;
  // prompt 尚未撰写的一侧不构成冲突（合并早于写作侧步骤）；两侧都写了且不同则不能二选一。
  if (left.prompt.text !== null && right.prompt.text !== null && !sameJson(left.prompt, right.prompt)) return true;
  return false;
};

/**
 * 相邻两条 ▲ 行是否可合并：返回 null 表示十条判定条件全部满足，否则返回第一条不满足的条件。
 * 调用方按数组顺序传入同一份剧本的连续镜头，条件 2（中间没有其他 ▲ 行）即由数组相邻性 + 行序递增保证。
 */
export function shotMergeBlocker(
  left: ShotRequestDraft,
  right: ShotRequestDraft,
  options: ShotMergeOptions,
): ShotMergeBlocker | null {
  if (left.continuity.stageGroup !== right.continuity.stageGroup) return "stage-group";
  if (right.provenance.scriptLine <= lastScriptLine(left)) return "not-adjacent";
  if (!sameCamera(left.camera, right.camera)) return "camera";
  if (!sameJson(left.scene, right.scene)) return "scene-state";
  if (!sameCast(left.cast, right.cast)) return "cast";
  if (hasForcedSplitTag(left) || hasForcedSplitTag(right)) return "freeze-frame";
  const speakers = lipSyncSpeakers([...left.dialogue, ...right.dialogue]);
  if (speakers.size > 1) return "lip-sync-speakers";
  const total = left.output.storyboardDurationSeconds + right.output.storyboardDurationSeconds;
  if (total > options.maxStoryboardDurationSeconds) return "duration-cap";
  if (continuityInputsConflict(left, right)) return "continuity-inputs";
  if (shotParametersConflict(left, right)) return "shot-parameters";
  // 合并结果仍须满足解析层的结构上限，否则会在末尾重解析时抛错。
  const tags = new Set([...left.productionTags, ...right.productionTags]);
  if (left.action.length + 1 + right.action.length > MAX_SHOT_ACTION_LENGTH
    || left.dialogue.length + right.dialogue.length > MAX_SHOT_DIALOGUE_LINES
    || tags.size > MAX_SHOT_PRODUCTION_TAGS) return "structure-cap";
  return null;
}

function mergePair(
  left: ShotRequestDraft,
  right: ShotRequestDraft,
  warnings: ShotMergeWarning[],
): ShotRequestDraft {
  const cast = [...left.cast];
  for (const member of right.cast) {
    const existing = cast.find((entry) => entry.characterId === member.characterId);
    if (existing === undefined) { cast.push(member); continue; }
    if (!sameJson(existing, member)) {
      warnings.push({
        shotId: left.shotId,
        field: `cast[${member.characterId}]`,
        message: `合并 ▲ 行 ${right.provenance.scriptLine} 时角色 ${member.characterId} 字段冲突，取首行值`,
      });
    }
  }
  const props = [...left.props];
  for (const prop of right.props) {
    const existing = props.find((entry) => entry.objectId === prop.objectId);
    if (existing === undefined) { props.push(prop); continue; }
    if (!sameJson(existing, prop)) {
      warnings.push({
        shotId: left.shotId,
        field: `props[${prop.objectId}]`,
        message: `合并 ▲ 行 ${right.provenance.scriptLine} 时道具 ${prop.objectId} 字段冲突，取首行值`,
      });
    }
  }
  const productionTags = [...left.productionTags];
  for (const tag of right.productionTags) if (!productionTags.includes(tag)) productionTags.push(tag);
  // crowd：一侧为空取另一侧；两侧都有且不同取首行并记 warning。
  let crowd = left.crowd;
  if (crowd === null) crowd = right.crowd;
  else if (right.crowd !== null && !sameJson(crowd, right.crowd)) {
    warnings.push({
      shotId: left.shotId,
      field: "crowd",
      message: `合并 ▲ 行 ${right.provenance.scriptLine} 时群众演员登记冲突，取首行值`,
    });
  }
  // prompt：未撰写的一侧不覆盖已撰写的一侧（两侧都写且不同的情况已被条件 10 挡在合并之前）。
  const prompt = left.prompt.text !== null || right.prompt.text === null ? left.prompt : right.prompt;
  return {
    ...left,
    provenance: {
      ...left.provenance,
      mergedScriptLines: [
        ...left.provenance.mergedScriptLines,
        right.provenance.scriptLine,
        ...right.provenance.mergedScriptLines,
      ],
    },
    cast,
    props,
    crowd,
    action: `${left.action}\n${right.action}`,
    productionTags,
    dialogue: [...left.dialogue, ...right.dialogue],
    output: {
      ...left.output,
      storyboardDurationSeconds: left.output.storyboardDurationSeconds + right.output.storyboardDurationSeconds,
    },
    prompt,
  };
}

/**
 * plan-shots 的确定性前置步骤：在 stageGroup 内按 §6.1 的判定条件逐对合并（不调用 LLM）。
 * shotId 与 provenance.scriptLine 取首行；被并入行写入 mergedScriptLines；action 按行序换行拼接；
 * productionTags / cast / props 取并集；dialogue 按行序拼接；storyboardDurationSeconds 取和；
 * 被并入镜头的 shotId 在其余镜头的 continuity.prevShotId 上改写为存活镜头，不留悬空引用。
 *
 * 输入必须是同一份剧本按行序排列的镜头（scriptLine 非递减、同一 stageGroup 的镜头连续出现）；
 * 违反即抛 ProductionError——乱序输入下「相邻」判据（条件 2）不成立，静默合并会错接镜头。
 */
export function mergeShots(drafts: readonly ShotRequestDraft[], options: ShotMergeOptions): ShotMergeResult {
  if (!Number.isFinite(options.maxStoryboardDurationSeconds) || options.maxStoryboardDurationSeconds <= 0) {
    fail("ShotMergeOptions.maxStoryboardDurationSeconds", "必须是正有限数");
  }
  const parsed = drafts.map((draft) => parseShotRequestDraft(draft));
  const seenGroups = new Set<string>();
  let previousGroup: string | null = null;
  let previousLine = -1;
  parsed.forEach((draft, index) => {
    if (draft.provenance.scriptLine < previousLine) {
      fail(`mergeShots 输入 [${index}]`, `scriptLine ${draft.provenance.scriptLine} 小于前一项 ${previousLine}（必须按行序排列）`);
    }
    previousLine = lastScriptLine(draft);
    const group = draft.continuity.stageGroup;
    if (group !== previousGroup) {
      if (seenGroups.has(group)) {
        fail(`mergeShots 输入 [${index}]`, `stageGroup ${JSON.stringify(group)} 在中断后重新出现（同一分场的镜头必须连续）`);
      }
      seenGroups.add(group);
      previousGroup = group;
    }
  });

  const warnings: ShotMergeWarning[] = [];
  const merged: ShotRequestDraft[] = [];
  const redirect = new Map<string, string>();
  for (const current of parsed) {
    const previous = merged.at(-1);
    if (previous !== undefined && shotMergeBlocker(previous, current, options) === null) {
      const survivor = mergePair(previous, current, warnings);
      merged[merged.length - 1] = survivor;
      redirect.set(current.shotId, survivor.shotId);
      continue;
    }
    merged.push(current);
  }
  // 被并入的 shotId 不再存在：把指向它的 prevShotId 改写为吸收它的存活镜头（可能连环重定向）。
  const resolvePrev = (shotId: string): string => {
    let cursor = shotId;
    const guard = new Set<string>([cursor]);
    while (redirect.has(cursor)) {
      const next = redirect.get(cursor)!;
      if (guard.has(next)) break;
      guard.add(next);
      cursor = next;
    }
    return cursor;
  };
  return {
    drafts: merged.map((draft) => parseShotRequestDraft({
      ...draft,
      continuity: {
        ...draft.continuity,
        prevShotId: draft.continuity.prevShotId === null ? null : resolvePrev(draft.continuity.prevShotId),
      },
    })),
    warnings,
  };
}

/**
 * H3 的时长网格 = 已配置 profile 集合（§5.3：每个 (variant, durationSeconds, aspectRatio) 档一份 profile）。
 * 按网格上取整后选时长档相等的 profile；没有能容纳该分镜时长的档则返回 null（调用方据此拒绝出计划）。
 */
export function selectH3ProfileForDuration(
  storyboardDurationSeconds: number,
  profiles: readonly ShotExecutionProfile[],
): H3ExecutionProfile | null {
  const h3 = profiles.filter((profile): profile is H3ExecutionProfile => profile.modelFamily === "minimax-h3");
  if (h3.length === 0) return null;
  const base = Math.max(4, storyboardDurationSeconds);
  const tiers = [...new Set(h3.map((profile) => profile.durationSeconds))].sort((a, b) => a - b);
  const tier = tiers.find((value) => value >= base);
  if (tier === undefined) return null;
  return h3.find((profile) => profile.durationSeconds === tier) ?? null;
}
