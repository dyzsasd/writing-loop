// ShotRequest 契约 / 编译器 / 剧本预填 / 镜头合并回归 —— DESIGN §4.1、§4.3、§5.1–§5.3、§6.1、§8.1 验收矩阵。
import { existsSync, readFileSync } from "node:fs";
import { ProductionError, type AssetRef } from "../src/production-domain.ts";
import { productionCanonicalJson } from "../src/production-canonical-json.ts";
import {
  DEGRADATION_CODES,
  MAX_SHOT_REQUEST_REFERENCES,
  PROVIDER_DIRECTIVE_RE,
  REFERENCE_INDEX_RE,
  SHOT_REQUEST_MEDIA_TYPE,
  SHOT_VALIDATION_CODES,
  compileShotRequest,
  deriveVideoMode,
  extractProductionTags,
  h3VariantForMode,
  mergeShots,
  parseShotCompilePolicy,
  parseShotExecutionProfile,
  parseShotRequest,
  parseShotRequestDraft,
  rewriteToCasUri,
  selectH3ProfileForDuration,
  shotMergeBlocker,
  shotRequestAssetRef,
  shotRequestFromScript,
  type CompileShotRequestResult,
  type ShotCompileCapability,
  type ShotCompilePolicy,
  type ShotExecutionProfile,
  type ShotRequestDraft,
  type ShotValidationCode,
  type VideoBackendLimits,
} from "../src/production-shot-request.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsProduction = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof ProductionError && error.message.includes(needle); }
};

const SHA = {
  a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64), e: "e".repeat(64),
  f: "f".repeat(64), one: "1".repeat(64), two: "2".repeat(64), three: "3".repeat(64), four: "4".repeat(64),
};
const AT = "2026-08-28T00:00:00.000Z";

const asset = (sha256: string, mediaType = "image/png", byteLength = 4_096): AssetRef => ({
  version: 1,
  uri: `cas://wl-sg/sha256/${sha256}`,
  sha256,
  byteLength,
  mediaType,
});

const limits = (over: Partial<VideoBackendLimits> = {}): VideoBackendLimits => ({
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
  ...over,
});

const capability = (
  over: Partial<ShotCompileCapability> = {},
  byModelId: Record<string, VideoBackendLimits> = { "h3-9x16-8s": limits() },
): ShotCompileCapability => ({
  backendKind: "comfyui",
  backendInstanceId: "gw-sg-1",
  modelFamilies: ["minimax-h3"],
  processingRegions: ["SG"],
  limitsByModelId: byModelId,
  ...over,
});

const h3Profile = (over: Record<string, unknown> = {}): ShotExecutionProfile => ({
  version: 1,
  kind: "writing-loop/execution-profile",
  profileId: "h3-9x16-8s",
  backendInstanceId: "gw-sg-1",
  workflowSha256: SHA.b,
  modelSha256: SHA.c,
  parametersSha256: SHA.d,
  resolution: "768p",
  aspectRatio: "9:16",
  generateAudio: true,
  licenseObligations: { attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true },
  modelFamily: "minimax-h3",
  operation: "comfyui-workflow",
  variant: "fl2va",
  shortEdge: 768,
  durationSeconds: 8,
  ...over,
} as ShotExecutionProfile);

const policy = (
  execution: ShotExecutionProfile = h3Profile(),
  over: Partial<ShotCompilePolicy> = {},
): ShotCompilePolicy => ({
  version: 1,
  anchorPreference: "keyframes",
  casAuthority: "wl-sg",
  compiler: "production-shot-request@1",
  execution,
  project: {
    allowedProcessingRegions: ["SG"],
    licenseCompliance: { attribution: "MiniMax H3", annualRevenueUsd: 0, usesOutputToImproveModels: false },
  },
  approvedCandidates: {},
  propStates: { O01: ["O01_CLOSED"] },
  intent: {
    taskId: "take-ep001-s1-1",
    createdAt: AT,
    useTerritories: ["SG"],
    budget: { version: 1, currency: "USD", estimatedAmountMicros: 1_000_000, maximumAmountMicros: 4_000_000 },
    rights: { version: 1, status: "cleared", territories: ["SG"], evidence: null, expiresAt: null },
    moderation: { version: 1, status: "passed", reviewedAt: AT, evidence: null },
    license: {
      version: 1, status: "verified", basis: "community", territories: ["SG"], licenseSha256: null,
      evidence: null, issuedBy: null, issuedAt: null, expiresAt: null,
    },
  },
  ...over,
});

const baseDraft = (): ShotRequestDraft => parseShotRequestDraft({
  version: 1,
  kind: "writing-loop/shot-request-draft",
  shotId: "EP001-S1-1",
  subject: {
    version: 1,
    episode: { version: 1, episodeId: "ep-001", revision: 3, source: asset(SHA.e, "text/markdown", 8_192) },
    shotId: "EP001-S1-1",
    revision: 1,
    source: asset(SHA.e, "text/markdown", 8_192),
  },
  provenance: {
    storyDesignSha256: SHA.f,
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
      asset: asset(SHA.one, "image/png", 512_000),
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

const withDraft = (mutate: (draft: ShotRequestDraft) => void): ShotRequestDraft => {
  const draft = baseDraft();
  mutate(draft);
  return parseShotRequestDraft(draft);
};

const codesOf = (issues: Array<{ code: ShotValidationCode }>): ShotValidationCode[] => issues.map((i) => i.code);
const seen = new Set<ShotValidationCode>();
const expectCode = (
  result: CompileShotRequestResult,
  code: ShotValidationCode,
  message: string,
  severity: "error" | "warning" = "error",
): void => {
  const hit = result.validation.issues.find((issue) => issue.code === code && issue.severity === severity);
  if (hit) seen.add(code);
  // error 级 issue 必须同时挡住产物：含 error 的镜头不出 ShotRequest、不进批次（§4.1 末段）。
  const blocked = severity === "warning" || (result.shotRequest === null && result.intentDraft === null);
  ok(hit !== undefined && blocked,
    `${message}（${code}/${severity}；实得 ${codesOf(result.validation.issues).join(",") || "无"}${blocked ? "" : "；error 未阻断产物"}）`);
};

// —— 解析 ——
{
  const draft = baseDraft();
  ok(draft.kind === "writing-loop/shot-request-draft" && draft.camera !== null, "draft 解析：canonical 形态");
  ok(throwsProduction(() => parseShotRequestDraft({ ...draft, extra: 1 }), "含不支持字段"), "draft 解析：拒绝未知字段");
  ok(
    throwsProduction(() => parseShotRequestDraft({ ...draft, shotId: "EP001-S1-2" }), "必须与 shotId 相同"),
    "draft 解析：subject.shotId 必须与 shotId 一致",
  );
  ok(
    throwsProduction(
      () => parseShotRequestDraft({ ...draft, output: { ...draft.output, fps: 30 } }),
      "v1 固定为 24",
    ),
    "draft 解析：fps 固定 24",
  );
  ok(
    throwsProduction(
      () => parseShotRequestDraft({
        ...draft,
        continuity: {
          ...draft.continuity,
          references: Array.from({ length: MAX_SHOT_REQUEST_REFERENCES + 1 }, () => ({
            asset: asset(SHA.two), purpose: "style", subjectId: null, priority: 1, containsRealFace: false,
          })),
        },
      }),
      `至多 ${MAX_SHOT_REQUEST_REFERENCES} 项`,
    ),
    "draft 解析：references ≤ 12",
  );
  ok(
    throwsProduction(
      () => parseShotRequestDraft({ ...draft, prompt: { ...draft.prompt, text: "字".repeat(4_097) } }),
      "必须是 1–4096 位",
    ),
    "draft 解析：prompt.text ≤ MAX_PRODUCTION_TEXT_LENGTH",
  );
  ok(
    throwsProduction(
      () => parseShotRequestDraft({ ...draft, output: { ...draft.output, aspectRatio: "adaptive" } }),
      "必须是 9:16、16:9、1:1、21:9 之一",
    ),
    "draft 解析：画幅 adaptive 不在 v1 集合内",
  );
}

// —— 模式推导 ——
{
  const keyframe = baseDraft().continuity.firstFrame!;
  const reference = { asset: asset(SHA.two), purpose: "style" as const, subjectId: null, priority: 1 as const, containsRealFace: false };
  ok(deriveVideoMode({ firstFrame: null, lastFrame: null, references: [] }) === "t2v", "deriveVideoMode：无输入 → t2v");
  ok(deriveVideoMode({ firstFrame: keyframe, lastFrame: null, references: [] }) === "i2v", "deriveVideoMode：仅首帧 → i2v");
  ok(deriveVideoMode({ firstFrame: keyframe, lastFrame: keyframe, references: [] }) === "fl2v", "deriveVideoMode：首尾帧 → fl2v");
  ok(deriveVideoMode({ firstFrame: null, lastFrame: null, references: [reference] }) === "ref2v", "deriveVideoMode：仅参考 → ref2v");
  ok(h3VariantForMode("i2v") === "fl2va" && h3VariantForMode("ref2v") === "ref2va" && h3VariantForMode("t2v") === null,
    "H3 generator 映射：i2v/fl2v→fl2va、ref2v→ref2va、t2v→无");
}

// —— H3 正路 ——
{
  const result = compileShotRequest(baseDraft(), capability(), policy());
  ok(result.validation.errors === 0 && result.shotRequest !== null, "H3 编译：无 error，产出 ShotRequest");
  ok(result.validation.mode === "i2v", "H3 编译：首帧 operator-upload → i2v");
  const shotRequest = result.shotRequest!;
  ok(shotRequest.continuity.anchorMode === "keyframes", "H3 编译：anchorMode=keyframes");
  ok(shotRequest.output.durationSeconds === 8 && shotRequest.continuity.fingerprint.seedReproducible,
    "H3 编译：时长命中 profile 档、seed 可复现");
  ok(shotRequest.prompt.compiler === "production-shot-request@1" && shotRequest.prompt.selectedTranslation === null,
    "H3 编译：compiler 落盘、无译文");
  const intent = result.intentDraft!;
  const shotRef = shotRequestAssetRef(shotRequest, "wl-sg");
  ok(intent.inputs.length === 2
    && intent.inputs[0].mediaType === SHOT_REQUEST_MEDIA_TYPE
    && intent.inputs[0].sha256 === shotRef.sha256
    && intent.inputs[0].uri === `cas://wl-sg/sha256/${shotRef.sha256}`,
    "H3 编译：inputs[0] 为 ShotRequest 自身的 cas AssetRef");
  ok(intent.inputs[1].sha256 === SHA.one, "H3 编译：inputs[1] 为首帧资产");
  ok(intent.execution.modelFamily === "minimax-h3" && intent.execution.operation === "comfyui-workflow",
    "H3 编译：intent execution 为 minimax-h3 家族");
  ok(parseShotRequest(shotRequest).compile.draftSha256 === shotRequest.compile.draftSha256,
    "H3 编译：产物可被 parseShotRequest 重解析");
  ok(shotRequest.compile.degradations.length === 0, "H3 编译：正路无 Degradation");
}

// —— 后端 fixture：seedance / veo（本版只到编译校验层，无 adapter） ——
const seedanceLimits = (over: Partial<VideoBackendLimits> = {}): VideoBackendLimits => limits({
  modes: ["t2v", "i2v", "fl2v", "ref2v"],
  durationSeconds: { min: 4, max: 15, grid: null, gridByResolution: null },
  aspectRatios: ["16:9", "1:1", "9:16", "21:9"],
  resolutions: ["480p", "720p", "1080p", "4k"],
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
  audioOnlyReference: false,
  seed: "unsupported",
  promptDirectiveSyntax: "ark-text-flags",
  nativeAudio: { status: "supported", channels: "mono", verifiedBy: null },
  returnsLastFrame: true,
  realFaceReferences: "forbidden",
  ...over,
});

const seedanceProfile = (over: Record<string, unknown> = {}): ShotExecutionProfile => ({
  version: 1,
  kind: "writing-loop/execution-profile",
  profileId: "ark-2-0-720p",
  backendInstanceId: "gw-sg-2",
  workflowSha256: SHA.b,
  modelSha256: SHA.c,
  parametersSha256: SHA.d,
  resolution: "720p",
  aspectRatio: "9:16",
  generateAudio: true,
  licenseObligations: null,
  modelFamily: "seedance",
  operation: "ark-video-task",
  provider: "byteplus-modelark",
  modelId: "dreamina-seedance-2-0-260128",
  watermark: false,
  returnLastFrame: true,
  executionExpiresAfterSeconds: 7_200,
  ...over,
} as ShotExecutionProfile);

const seedanceCapability = (
  modelId = "dreamina-seedance-2-0-260128",
  backendLimits = seedanceLimits(),
): ShotCompileCapability => capability(
  { backendKind: "byteplus-modelark", backendInstanceId: "gw-sg-2", modelFamilies: ["seedance"], processingRegions: ["SG"] },
  { [modelId]: backendLimits },
);

const veoLimits = (over: Partial<VideoBackendLimits> = {}): VideoBackendLimits => limits({
  modes: ["t2v", "i2v", "fl2v", "ref2v"],
  durationSeconds: { min: 4, max: 8, grid: [4, 6, 8], gridByResolution: null },
  aspectRatios: ["16:9", "9:16"],
  resolutions: ["720p", "1080p", "4k"],
  maxReferenceImages: 3,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0,
  maxStyleImages: 1,
  seed: "uint32-best-effort",
  promptLanguages: ["en"],
  nativeAudio: { status: "unverified", channels: null, verifiedBy: null },
  ...over,
});

const veoProfile = (over: Record<string, unknown> = {}): ShotExecutionProfile => ({
  version: 1,
  kind: "writing-loop/execution-profile",
  profileId: "veo-720p",
  backendInstanceId: "gw-us-1",
  workflowSha256: SHA.b,
  modelSha256: SHA.c,
  parametersSha256: SHA.d,
  resolution: "720p",
  aspectRatio: "9:16",
  generateAudio: true,
  licenseObligations: null,
  modelFamily: "veo",
  operation: "vertex-veo-lro",
  modelId: "veo-3.1-generate-001",
  location: "us-central1",
  sampleCount: 1,
  ioMode: "inline-base64",
  ...over,
} as ShotExecutionProfile);

const veoCapability = (
  modelId = "veo-3.1-generate-001",
  backendLimits = veoLimits(),
): ShotCompileCapability => capability(
  { backendKind: "vertex-veo", backendInstanceId: "gw-us-1", modelFamilies: ["veo"], processingRegions: ["US"] },
  { [modelId]: backendLimits },
);

const cloudPolicy = (execution: ShotExecutionProfile): ShotCompilePolicy => policy(execution, {
  project: {
    allowedProcessingRegions: ["SG", "US"],
    licenseCompliance: { attribution: "MiniMax H3", annualRevenueUsd: 0, usesOutputToImproveModels: false },
  },
});

const imageReference = (sha256: string, over: Record<string, unknown> = {}) => ({
  asset: asset(sha256),
  purpose: "character-identity",
  subjectId: null,
  priority: 1,
  containsRealFace: false,
  ...over,
});

// —— H3 分支拒绝（§8.1） ——
{
  const t2v = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame = null; }),
    capability(),
    policy(),
  );
  expectCode(t2v, "unsupported_operation", "H3 拒绝 t2v");
  ok(t2v.shotRequest === null && t2v.intentDraft === null, "含 error 的镜头不产出 ShotRequest / intent");

  const negative = compileShotRequest(
    withDraft((draft) => { draft.prompt.negativeText = "避免出现现代建筑"; }),
    capability(),
    policy(),
  );
  expectCode(negative, "negative_prompt_unsupported", "H3 拒绝非空 negativeText");

  const duration = compileShotRequest(
    withDraft((draft) => { draft.output.storyboardDurationSeconds = 12; }),
    capability(),
    policy(),
  );
  expectCode(duration, "duration_out_of_range", "H3 拒绝不在已配置 profile 时长档内的时长");

  const refMode = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
    }),
    capability(),
    policy(),
  );
  expectCode(refMode, "unsupported_continuity_mode", "H3 fl2va profile 拒绝 ref2v 模式");

  const capExceeded = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.referencePolicy = "strict";
      draft.continuity.references = Array.from({ length: 10 }, (_unused, index) =>
        imageReference(String(index).repeat(64).slice(0, 64))) as ShotRequestDraft["continuity"]["references"];
    }),
    capability(undefined, { "h3-9x16-8s": limits({ modes: ["ref2v"] }) }),
    policy(h3Profile({ variant: "ref2va" })),
  );
  expectCode(capExceeded, "reference_cap_exceeded", "H3 ref2va 参考 ≤ 9，strict 下超限拒绝");
}

// —— 验证矩阵：每个错误码至少 1 例 ——
{
  const lastFrameOnly = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.lastFrame = draft.continuity.firstFrame;
      draft.continuity.firstFrame = null;
    }),
    capability(),
    policy(),
  );
  expectCode(lastFrameOnly, "last_frame_without_first", "尾帧不得脱离首帧单独出现");

  const notApproved = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame!.origin = { kind: "approved-candidate", candidateId: "CAND-1" }; }),
    capability(),
    policy(),
  );
  expectCode(notApproved, "keyframe_not_approved", "候选图未登记 / 未批准");

  const notApprovedStatus = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame!.origin = { kind: "approved-candidate", candidateId: "CAND-1" }; }),
    capability(),
    policy(h3Profile(), {
      approvedCandidates: { "CAND-1": { sha256: SHA.one, status: "candidate", reviewedBy: null, reviewedAt: null } },
    }),
  );
  expectCode(notApprovedStatus, "keyframe_not_approved", "候选图 status 非 approved");

  const aspect = compileShotRequest(
    withDraft((draft) => { draft.output.aspectRatio = "21:9"; }),
    capability(),
    policy(h3Profile({ aspectRatio: "21:9" })),
  );
  expectCode(aspect, "aspect_ratio_unsupported", "profile 画幅不在 capability 集合内");

  const tooLarge = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame!.asset = asset(SHA.one, "image/png", 64 * 1024 * 1024); }),
    capability(),
    policy(),
  );
  expectCode(tooLarge, "image_too_large", "输入图片超过后端体积上限");

  const badMime = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame!.asset = asset(SHA.one, "image/webp", 4_096); }),
    capability(),
    policy(),
  );
  expectCode(badMime, "image_mime_unsupported", "输入图片媒体类型不受支持");

  const blocked = compileShotRequest(baseDraft(), capability(), policy(h3Profile(), {
    intent: { ...policy().intent, license: { ...policy().intent.license, status: "blocked" } },
  }));
  expectCode(blocked, "license_blocked", "许可证据 blocked");

  const obligation = compileShotRequest(baseDraft(), capability(), policy(h3Profile(), {
    project: {
      allowedProcessingRegions: ["SG"],
      licenseCompliance: { attribution: null, annualRevenueUsd: 0, usesOutputToImproveModels: false },
    },
  }));
  expectCode(obligation, "license_obligation_unmet", "H3 署名义务未满足");

  const revenue = compileShotRequest(baseDraft(), capability(), policy(h3Profile(), {
    project: {
      allowedProcessingRegions: ["SG"],
      licenseCompliance: { attribution: "MiniMax H3", annualRevenueUsd: 25_000_000, usesOutputToImproveModels: false },
    },
  }));
  expectCode(revenue, "license_obligation_unmet", "年收入超阈值须书面授权");

  const region = compileShotRequest(baseDraft(), capability(), policy(h3Profile(), {
    project: {
      allowedProcessingRegions: ["US"],
      licenseCompliance: { attribution: "MiniMax H3", annualRevenueUsd: 0, usesOutputToImproveModels: false },
    },
  }));
  expectCode(region, "processing_region_not_allowed", "后端处理地域不在项目允许集合内");

  const propState = compileShotRequest(
    withDraft((draft) => {
      draft.props = [{ objectId: "O01", stateId: "O01_OPEN", visible: true, position: null }];
    }),
    capability(),
    policy(),
  );
  expectCode(propState, "prop_state_missing", "道具状态未登记");

  const directive = compileShotRequest(
    withDraft((draft) => { draft.prompt.text = "城楼门洞，白汽扑上琉璃瓦 --dur 5"; }),
    capability(),
    policy(),
  );
  expectCode(directive, "prompt_contains_provider_directive", "prompt 命中 provider 文本指令");

  const refIndex = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
      draft.prompt.text = "沿用 @图片2 的服饰细节。";
    }),
    capability(undefined, { "h3-9x16-8s": limits({ modes: ["ref2v"] }) }),
    policy(h3Profile({ variant: "ref2va" })),
  );
  expectCode(refIndex, "reference_index_out_of_range", "prompt 引用的参考序号越界");

  const intentMismatch = compileShotRequest(
    withDraft((draft) => { draft.output.generateAudio = false; }),
    capability(),
    policy(),
  );
  expectCode(intentMismatch, "output_intent_mismatch", "generateAudio 与 execution profile 不一致");

  const aspectMismatch = compileShotRequest(
    withDraft((draft) => { draft.output.aspectRatio = "16:9"; }),
    capability(),
    policy(),
  );
  expectCode(aspectMismatch, "output_intent_mismatch", "aspectRatio 与 execution profile 不一致");
}

// —— seedance 分支（§8.1：只到编译校验层） ——
{
  const seedRejected = compileShotRequest(baseDraft(), seedanceCapability(), cloudPolicy(seedanceProfile()));
  expectCode(seedRejected, "seed_rejected", "Seedance 拒绝非 null seed（error 级，无 warning 形态）");
  ok(seedRejected.intentDraft === null, "Seedance 本版不产出 intent draft（execution 分支后置到 Phase 3）");

  const fast1080p = compileShotRequest(
    withDraft((draft) => { draft.output.seed = null; }),
    seedanceCapability("dreamina-seedance-2-0-fast-260128", seedanceLimits({ resolutions: ["480p", "720p"] })),
    cloudPolicy(seedanceProfile({ modelId: "dreamina-seedance-2-0-fast-260128", resolution: "1080p" })),
  );
  expectCode(fast1080p, "resolution_unsupported", "Seedance fast 不支持 1080p");

  const mixed = compileShotRequest(
    withDraft((draft) => {
      draft.output.seed = null;
      draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
    }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile()),
  );
  ok(mixed.validation.errors === 0
    && mixed.degradations.some((entry) => entry.code === "anchor-mode-selected" && entry.requiresReapproval)
    && mixed.shotRequest!.continuity.references.length === 0
    && mixed.shotRequest!.continuity.droppedReferences.length === 1,
    "Seedance 首尾帧与参考混用：按 anchorPreference 选 keyframes，落选参考进 droppedReferences 并记 anchor-mode-selected");

  const audioOnly = compileShotRequest(
    withDraft((draft) => {
      draft.output.seed = null;
      draft.continuity.firstFrame = null;
      draft.continuity.references = [
        imageReference(SHA.two, { asset: asset(SHA.two, "audio/mpeg", 128_000), purpose: "voice" }),
      ] as ShotRequestDraft["continuity"]["references"];
    }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile()),
  );
  expectCode(audioOnly, "audio_only_reference_unsupported", "Seedance 2.0 不允许仅音频参考");

  const adaptive = compileShotRequest(
    withDraft((draft) => { draft.output.seed = null; }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile({ aspectRatio: "adaptive" })),
  );
  expectCode(adaptive, "aspect_ratio_unsupported", "Seedance adaptive 画幅不在 v1 集合内");

  const realFace = compileShotRequest(
    withDraft((draft) => {
      draft.output.seed = null;
      draft.continuity.firstFrame!.containsRealFace = true;
    }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile()),
  );
  expectCode(realFace, "real_face_unauthorized", "Seedance 拒绝含真人人脸的输入");

  const longPrompt = compileShotRequest(
    withDraft((draft) => {
      draft.output.seed = null;
      draft.prompt.text = "城".repeat(600);
    }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile()),
  );
  expectCode(longPrompt, "prompt_length_over_recommendation", "Seedance prompt 超过建议长度（warning）", "warning");
  ok(longPrompt.validation.errors === 0 && longPrompt.shotRequest !== null, "warning 不阻断出 ShotRequest");

  const folded = compileShotRequest(
    withDraft((draft) => {
      draft.output.seed = null;
      draft.prompt.negativeText = "现代建筑、霓虹灯";
    }),
    seedanceCapability(),
    cloudPolicy(seedanceProfile()),
  );
  ok(folded.validation.errors === 0 && folded.degradations.some((entry) => entry.code === "negative-prompt-folded"),
    "Seedance negative prompt 折叠进正文并记 negative-prompt-folded");
}

// —— veo 分支（§8.1：只到编译校验层） ——
const englishDraft = (mutate: (draft: ShotRequestDraft) => void = () => {}): ShotRequestDraft => withDraft((draft) => {
  draft.prompt.language = "en";
  draft.prompt.text = "A steam locomotive passes through a Ming-style gate tower, white steam over glazed tiles.";
  mutate(draft);
});

{
  const chinese = compileShotRequest(baseDraft(), veoCapability(), cloudPolicy(veoProfile()));
  expectCode(chinese, "prompt_language_unsupported", "Veo 对 zh-CN prompt 且无译文的 draft 恒拒绝");
  ok(chinese.degradations.some((entry) => entry.code === "seed-not-reproducible"),
    "Veo 分支对每个 ShotRequest 记录 seed-not-reproducible");

  const dialogueLanguage = compileShotRequest(
    englishDraft((draft) => {
      draft.dialogue = [{ speakerId: "C02", text: "今夜写完，明日就发。", mode: "onscreen", language: "zh-CN", lipSync: true }];
    }),
    veoCapability(),
    cloudPolicy(veoProfile()),
  );
  expectCode(dialogueLanguage, "dialogue_language_unsupported", "含中文口型对白的镜头不路由到 Veo");

  const ref6s = compileShotRequest(
    englishDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
      draft.output.storyboardDurationSeconds = 6;
    }),
    veoCapability(),
    cloudPolicy(veoProfile()),
  );
  expectCode(ref6s, "duration_out_of_range", "Veo ref2v 固定 8 s，6 s 被拒");

  const liteRef = compileShotRequest(
    englishDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
      draft.output.storyboardDurationSeconds = 8;
    }),
    veoCapability("veo-3.1-lite-generate-001", veoLimits({ modes: ["t2v", "i2v", "fl2v"], resolutions: ["720p", "1080p"] })),
    cloudPolicy(veoProfile({ modelId: "veo-3.1-lite-generate-001" })),
  );
  expectCode(liteRef, "unsupported_continuity_mode", "Veo lite 不支持 ref2v");

  const lite4k = compileShotRequest(
    englishDraft((draft) => { draft.output.storyboardDurationSeconds = 8; }),
    veoCapability("veo-3.1-lite-generate-001", veoLimits({ modes: ["t2v", "i2v", "fl2v"], resolutions: ["720p", "1080p"] })),
    cloudPolicy(veoProfile({ modelId: "veo-3.1-lite-generate-001", resolution: "4k" })),
  );
  expectCode(lite4k, "resolution_unsupported", "Veo lite 不支持 4k");

  const fast4k = compileShotRequest(
    englishDraft((draft) => { draft.output.storyboardDurationSeconds = 8; }),
    veoCapability("veo-3.1-fast-generate-001", veoLimits({ resolutions: ["720p", "1080p"] })),
    cloudPolicy(veoProfile({ modelId: "veo-3.1-fast-generate-001", resolution: "4k" })),
  );
  expectCode(fast4k, "resolution_unsupported", "Veo fast 的 4k 在探针前拒绝");

  const highRes4s = compileShotRequest(
    englishDraft((draft) => { draft.output.storyboardDurationSeconds = 4; }),
    veoCapability(),
    cloudPolicy(veoProfile({ resolution: "1080p" })),
  );
  expectCode(highRes4s, "duration_out_of_range", "Veo 1080p 固定 8 s，4 s 被拒");

  const audioUnverified = compileShotRequest(
    englishDraft((draft) => { draft.output.storyboardDurationSeconds = 8; }),
    veoCapability(),
    cloudPolicy(veoProfile()),
  );
  expectCode(audioUnverified, "native_audio_unverified", "Veo generate-001 的原生音频未核实（warning）", "warning");
  ok(audioUnverified.validation.errors === 0 && audioUnverified.shotRequest !== null
    && audioUnverified.shotRequest.continuity.fingerprint.seedReproducible === false,
    "Veo 英文 prompt 正路：出 ShotRequest 且 seedReproducible=false");
  ok(audioUnverified.intentDraft === null, "Veo 本版不产出 intent draft（execution 分支后置到 Phase 4）");

  const translated = compileShotRequest(
    withDraft((draft) => {
      draft.output.storyboardDurationSeconds = 8;
      draft.prompt.translations = [{
        language: "en",
        text: "A steam locomotive passes through a Ming-style gate tower.",
        negativeText: null,
        authoredBy: "translator",
      }];
    }),
    veoCapability(),
    cloudPolicy(veoProfile()),
  );
  ok(translated.validation.errors === 0
    && translated.degradations.some((entry) => entry.code === "prompt-translated" && entry.requiresReapproval)
    && translated.shotRequest!.prompt.language === "en"
    && translated.shotRequest!.prompt.selectedTranslation?.authoredBy === "translator",
    "draft 带受支持语言译文时选用译文并记 prompt-translated（重审批）");
}

// —— 裁剪与确定性 ——
{
  const trimmed = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [
        imageReference(SHA.two, { purpose: "style", priority: 3 }),
        imageReference(SHA.three, { purpose: "character-identity", priority: 1 }),
      ] as ShotRequestDraft["continuity"]["references"];
    }),
    capability(undefined, { "h3-9x16-8s": limits({ modes: ["ref2v"], maxReferenceImages: 1 }) }),
    policy(h3Profile({ variant: "ref2va" })),
  );
  ok(trimmed.validation.errors === 0
    && trimmed.degradations.some((entry) => entry.code === "references-trimmed")
    && trimmed.shotRequest!.continuity.references.length === 1
    && trimmed.shotRequest!.continuity.references[0].asset.sha256 === SHA.three
    && trimmed.shotRequest!.continuity.droppedReferences[0].asset.sha256 === SHA.two,
    "trim_by_priority：按 purpose 顺序保留 character-identity，裁剪项进 droppedReferences");

  const first = compileShotRequest(baseDraft(), capability(), policy());
  const second = compileShotRequest(baseDraft(), capability(), policy());
  ok(productionCanonicalJson(first.shotRequest) === productionCanonicalJson(second.shotRequest),
    "确定性：同一 draft 两次编译产生字节相同的 ShotRequest");
  ok(JSON.stringify(first.intentDraft) === JSON.stringify(second.intentDraft)
    && productionCanonicalJson(first.intentDraft) === productionCanonicalJson(second.intentDraft),
    "确定性：同一 draft 两次编译产生字节相同的 intent draft");
  ok(first.shotRequest!.compile.policyDigest === second.shotRequest!.compile.policyDigest
    && first.shotRequest!.compile.draftSha256 === second.shotRequest!.compile.draftSha256,
    "确定性：draftSha256 与 policyDigest 稳定");

  const otherPolicy = compileShotRequest(baseDraft(), capability(), policy(h3Profile({ profileId: "h3-9x16-8s", parametersSha256: SHA.a })));
  ok(otherPolicy.shotRequest!.compile.policyDigest !== first.shotRequest!.compile.policyDigest,
    "policyDigest 覆盖 execution profile：参数 digest 变化时随之变化");
}

// —— 镜头合并：§6.1 八条判定条件逐条 ——
const MERGE_OPTIONS = { maxStoryboardDurationSeconds: 8 };
const castMember = (characterId: string, appearanceStateId: string) => ({
  characterId, name: characterId, appearanceStateId, voiceId: null, onScreen: true, performNotes: null, stage: null,
});
const mergeDraft = (index: number, mutate: (draft: ShotRequestDraft) => void = () => {}): ShotRequestDraft =>
  withDraft((draft) => {
    draft.shotId = `EP001-S1-${index}`;
    draft.subject.shotId = `EP001-S1-${index}`;
    draft.provenance.scriptLine = 16 + index;
    draft.output.storyboardDurationSeconds = 2;
    draft.productionTags = [];
    draft.action = `动作 ${index}`;
    draft.continuity.prevShotId = index === 1 ? null : `EP001-S1-${index - 1}`;
    draft.cast = [castMember("C01", "C01_YOUTH")];
    mutate(draft);
  });

{
  // 条件 1：同一 stageGroup
  const merged = mergeShots([mergeDraft(1), mergeDraft(2)], MERGE_OPTIONS);
  ok(merged.drafts.length === 1
    && merged.drafts[0].shotId === "EP001-S1-1"
    && merged.drafts[0].provenance.scriptLine === 17
    && merged.drafts[0].provenance.mergedScriptLines.join(",") === "18"
    && merged.drafts[0].action === "动作 1\n动作 2"
    && merged.drafts[0].output.storyboardDurationSeconds === 4,
    "合并①：条件全满足时合并，shotId / scriptLine 取首行，被并入行进 mergedScriptLines，action 换行拼接、时长取和");

  const otherGroup = mergeShots(
    [mergeDraft(1), mergeDraft(2, (draft) => { draft.continuity.stageGroup = "EP001-S2"; })],
    MERGE_OPTIONS,
  );
  ok(otherGroup.drafts.length === 2
    && shotMergeBlocker(otherGroup.drafts[0], otherGroup.drafts[1], MERGE_OPTIONS) === "stage-group",
    "合并②：条件 1 —— 跨 stageGroup 不合并");

  // 条件 2：中间隔着其他 ▲ 行则不合并
  const spaced = mergeShots(
    [
      mergeDraft(1),
      mergeDraft(2, (draft) => { draft.camera!.camera_movement = "handheld"; }),
      mergeDraft(3),
    ],
    MERGE_OPTIONS,
  );
  ok(spaced.drafts.length === 3
    && shotMergeBlocker(spaced.drafts[0], spaced.drafts[2], MERGE_OPTIONS) === null,
    "合并③：条件 2 —— 首尾两行本可合并，但中间隔着另一条 ▲ 行，不跨行合并");
  ok(shotMergeBlocker(mergeDraft(3), mergeDraft(2), MERGE_OPTIONS) === "not-adjacent",
    "合并④：条件 2 —— 行序未递增判为 not-adjacent");

  // 条件 3：机位
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.camera!.lens_mm = 85; }), MERGE_OPTIONS) === "camera",
    "合并⑤：条件 3 —— 机位六字段不同不合并");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.camera!.cameraId = "CAM_B"; }), MERGE_OPTIONS) === "camera",
    "合并⑥：条件 3 —— cameraId 不同不合并");

  // 条件 4：灯光 / 陈设
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.scene.lightingStateId = "LIGHT_NIGHT"; }), MERGE_OPTIONS) === "scene-state",
    "合并⑦：条件 4 —— lightingStateId 不同不合并");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.scene.dressingVariantId = "DRESS_B"; }), MERGE_OPTIONS) === "scene-state",
    "合并⑦b：条件 4 —— dressingVariantId 不同不合并");

  // 条件 5：cast 集合与外观状态
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.cast = [castMember("C01", "C01_ADULT")]; }), MERGE_OPTIONS) === "cast",
    "合并⑧：条件 5 —— appearanceStateId 不同不合并");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.cast = [castMember("C01", "C01_YOUTH"), castMember("C03", "C03_ADULT")]; }), MERGE_OPTIONS) === "cast",
    "合并⑨：条件 5 —— characterId 集合不同不合并");

  // 条件 6：【画面定格】
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.productionTags = ["画面定格"]; }), MERGE_OPTIONS) === "freeze-frame",
    "合并⑩：条件 6 —— 【画面定格】是强制切分点");

  // 条件 7：口型说话人
  const twoSpeakers = shotMergeBlocker(
    mergeDraft(1, (d) => { d.dialogue = [{ speakerId: "C01", text: "我自己开。", mode: "onscreen", language: "zh-CN", lipSync: true }]; }),
    mergeDraft(2, (d) => { d.dialogue = [{ speakerId: "C03", text: "改日再说。", mode: "onscreen", language: "zh-CN", lipSync: true }]; }),
    MERGE_OPTIONS,
  );
  ok(twoSpeakers === "lip-sync-speakers", "合并⑪：条件 7 —— 合并后口型说话人超过 1 不合并");
  const oneSpeakerPlusVo = mergeShots(
    [
      mergeDraft(1, (d) => { d.dialogue = [{ speakerId: "C01", text: "我自己开。", mode: "onscreen", language: "zh-CN", lipSync: true }]; }),
      mergeDraft(2, (d) => { d.dialogue = [{ speakerId: "C02", text: "他一生都在找一本对不上的旧史。", mode: "vo", language: "zh-CN", lipSync: false }]; }),
    ],
    MERGE_OPTIONS,
  );
  ok(oneSpeakerPlusVo.drafts.length === 1 && oneSpeakerPlusVo.drafts[0].dialogue.length === 2,
    "合并⑫：条件 7 —— VO / OS 不计入口型说话人，dialogue 按行序拼接");

  // 条件 8：时长上界
  ok(shotMergeBlocker(
    mergeDraft(1, (d) => { d.output.storyboardDurationSeconds = 5; }),
    mergeDraft(2, (d) => { d.output.storyboardDurationSeconds = 5; }),
    MERGE_OPTIONS,
  ) === "duration-cap", "合并⑬：条件 8 —— 合并后时长超过 profile 网格上界不合并");

  // 并集与冲突 warning
  const union = mergeShots(
    [
      mergeDraft(1, (d) => {
        d.productionTags = ["特写"];
        d.props = [{ objectId: "O01", stateId: "O01_CLOSED", visible: true, position: null }];
      }),
      mergeDraft(2, (d) => {
        d.productionTags = ["特写", "音效"];
        d.props = [{ objectId: "O01", stateId: "O01_CLOSED", visible: false, position: null }];
      }),
    ],
    MERGE_OPTIONS,
  );
  ok(union.drafts.length === 1
    && union.drafts[0].productionTags.join(",") === "特写,音效"
    && union.drafts[0].props.length === 1
    && union.drafts[0].props[0].visible === true
    && union.warnings.length === 1 && union.warnings[0].field === "props[O01]",
    "合并⑭：productionTags / props 取并集，同 id 冲突取首行值并记 warning");
}

// —— 验证矩阵完整性 ——
{
  const missing = SHOT_VALIDATION_CODES.filter((code) => !seen.has(code));
  ok(missing.length === 0, `验证矩阵覆盖全部 ${SHOT_VALIDATION_CODES.length} 个错误码（未覆盖：${missing.join(",") || "无"}）`);
  ok(DEGRADATION_CODES.length === 6, "Degradation 词表为 6 项（v2 删除三个无触发规则的 code）");
}

// —— 剧本预填（§6.1「一行动作 = 一个镜头」） ——
const scriptOptions = (episode: number, sceneRegistry: Array<{ id: string; name: string }>) => ({
  episode,
  subject: {
    episode: { version: 1 as const, episodeId: `ep-${String(episode).padStart(3, "0")}`, revision: 1, source: asset(SHA.e, "text/markdown", 8_192) },
    revision: 1,
    source: asset(SHA.e, "text/markdown", 8_192),
  },
  provenance: { storyDesignSha256: SHA.f, assetsRevision: 12, visualProductionSha256: null, beatCardHash: "8137791889ad" },
  sceneRegistry,
  characters: [{ id: "C01", name: "顾知行" }, { id: "C02", name: "谢蘅秋" }, { id: "C03", name: "沈炼" }],
  output: { aspectRatio: "9:16" as const, generateAudio: true, seed: 4_242 },
  defaultStoryboardDurationSeconds: 2,
  prompt: { authoredBy: "episode-writer" },
});

{
  const script = [
    "第7集（测试）",
    "",
    "7-1 沈家大院·京中寓所 夜 内",
    "人物：顾知行、沈炼",
    "▲ 【特写】旧纸压在黑漆木匣里。",
    "沈炼（不看他，落笔）：今夜写完，明日就发。",
    "▲ 【画面定格】他的手停在誊纸上。",
    "",
  ].join("\n");
  const prefilled = shotRequestFromScript(script, scriptOptions(7, [{ id: "S01", name: "沈家大院" }]));
  ok(prefilled.shots.length === 2 && prefilled.warnings.length === 0, "预填：一行动作 = 一个镜头");
  const [one, two] = prefilled.shots;
  ok(one.draft.shotId === "EP007-S1-1" && two.draft.shotId === "EP007-S1-2", "预填：shotId = 集号-场序-▲ 行序");
  ok(one.draft.scene.timeOfDay === "night" && one.draft.scene.interior === "int"
    && one.draft.scene.sceneId === "S01" && one.draft.scene.subscene === "京中寓所",
    "预填：场景头五段捕获组 → timeOfDay / interior / sceneId / subscene");
  ok(one.draft.continuity.stageGroup === "EP007-S1·京中寓所" && two.draft.continuity.prevShotId === "EP007-S1-1",
    "预填：stageGroup 为分场 ID，prevShotId 指向同场上一镜");
  ok(one.draft.camera === null && one.draft.prompt.text === null,
    "预填：camera 与 prompt.text 留空（分镜 / 写作侧补齐）");
  ok(one.draft.productionTags.join(",") === "特写" && two.draft.productionTags.join(",") === "画面定格",
    "预填：内联标注进 productionTags");
  ok(one.draft.dialogue.length === 1 && one.draft.dialogue[0].speakerId === "C03"
    && one.draft.dialogue[0].mode === "onscreen" && one.draft.dialogue[0].lipSync
    && one.draft.dialogue[0].language === "zh-CN" && two.draft.dialogue.length === 0,
    "预填：对白归属其前最近的 ▲ 行，language 固定 zh-CN，onscreen ⇒ lipSync");
  ok(one.draft.provenance.scriptLine === 5 && one.draft.provenance.mergedScriptLines.length === 0,
    "预填：provenance.scriptLine 为 ▲ 行行号");
  ok(one.roster.map((entry) => entry.name).join(",") === "顾知行,沈炼", "预填：调度单原样带出供 cast 装配");
  ok(extractProductionTags("▲ 【字幕：十七日】").join(",") === "字幕：十七日", "预填：标注保留冒号后的内容");
  ok(throwsProduction(
    () => shotRequestFromScript(script, scriptOptions(7, [{ id: "S02", name: "官署公堂" }])),
    "不以任何注册景名开头",
  ), "预填：地点未命中注册景名时向上抛错（先过 script-lint L3-scene-registry）");

  // MINOR 14：地点不含「·」时子景取注册景名之后的余段
  const noDot = shotRequestFromScript(
    ["第7集（测试）", "", "7-1 沈家大院祠堂前 日 外", "人物：顾知行", "▲ 门开。", ""].join("\n"),
    scriptOptions(7, [{ id: "S01", name: "沈家大院" }]),
  );
  ok(noDot.shots[0].draft.scene.subscene === "祠堂前"
    && noDot.shots[0].draft.continuity.stageGroup === "EP007-S1·祠堂前",
    "预填：地点无「·」时子景 = 注册景名之后的余段（沈家大院祠堂前 → 祠堂前）");

  // MAJOR 6：场内首个 ▲ 之前的对白（ep-018.md:18 实测形）
  const earlyDialogue = shotRequestFromScript(
    [
      "第18集（三色对不齐）",
      "",
      "18-1 玉京金殿·廷议 日 内",
      "人物：顾知行、徐阶",
      "顾知行（急促）：还有——",
      "▲ 【画面定格】访簿夹在徐阶臂下，折角朝外。",
      "▲ 差役押顾知行入殿。",
      "",
    ].join("\n"),
    scriptOptions(18, [{ id: "S03", name: "玉京金殿" }]),
  );
  ok(earlyDialogue.shots.length === 2
    && earlyDialogue.shots[0].draft.dialogue.length === 1
    && earlyDialogue.shots[0].draft.dialogue[0].speakerId === "C01"
    && earlyDialogue.shots[1].draft.dialogue.length === 0,
    "预填：首个 ▲ 之前的对白归入本场第一镜");
  ok(earlyDialogue.warnings.length === 1
    && earlyDialogue.warnings[0].code === "dialogue-before-first-action"
    && earlyDialogue.warnings[0].line === 5
    && earlyDialogue.warnings[0].text.includes("还有")
    && earlyDialogue.warnings[0].shotId === "EP018-S1-1",
    "预填：该对白在 warnings[] 记行号与原文");

  // 裁定 B：独立标注行（ep-008.md:22 形）记为紧随其后那一镜的 productionTags
  const standalone = shotRequestFromScript(
    [
      "第8集（谁握着尺）",
      "",
      "8-1 沈家大院祠堂 日 内",
      "人物：顾知行、沈炼",
      "▲ 题纸展到第一道折痕。",
      "【闪回结束】",
      "▲ 同一张题纸压上祠堂门栅。",
      "",
    ].join("\n"),
    scriptOptions(8, [{ id: "S01", name: "沈家大院" }]),
  );
  ok(standalone.shots.length === 2
    && standalone.shots[0].draft.productionTags.length === 0
    && standalone.shots[1].draft.productionTags.join(",") === "闪回结束",
    "预填：独立标注行【闪回结束】记为其后一镜的 productionTags");
}

// —— ep-001 场 1-1 端到端（§8.1 验收）——
// 剧本数据不入库：1-1 场文本内联为 fixture；设 WL_EP001_PATH 时额外对整集文件跑同一核对。
const EP001_SCENE_1_1 = [
  "第1集（还没发生的日子）",
  "",
  "1-1 未来玉京 日 外",
  "人物：谢蘅秋（年长·背影）",
  "▲ 【特效】一列蒸汽机车穿过大明制式城楼门洞，白汽扑上琉璃瓦。",
  "▲ 【特效】镜头自城楼一次拉开到位——铁轨、织坊、报房、票号街、议事堂同在一镜。",
  "谢蘅秋（年长·VO，平缓）：修成这一切的人，公开的名字叫顾知行，官至首辅。他一生都在找一本对不上的旧史。",
  "▲ 白发背影停在报房墙前，腕上一只素银钏。",
  "▲ 【特写】墙上装裱着一叠折过的旧纸。",
  "",
].join("\n");

const runEp001Case = (scriptText: string, label: string): void => {
  const prefilled = shotRequestFromScript(scriptText, {
    ...scriptOptions(1, [{ id: "S08", name: "未来玉京" }, { id: "S01", name: "沈家大院" }]),
    sceneIndexes: [1],
  });
  const shots = prefilled.shots;
  ok(shots.length === 4 && prefilled.warnings.length === 0, `${label} 1-1：预填 4 个镜头（实得 ${shots.length}）`);
  ok(shots.every((entry) => entry.draft.scene.sceneId === "S08" && entry.draft.scene.timeOfDay === "day"
    && entry.draft.scene.interior === "ext"),
    `${label} 1-1：场景头 → S08 / day / ext`);
  ok(shots.filter((entry) => entry.draft.productionTags.includes("特效")).length === 2
    && shots.filter((entry) => entry.draft.productionTags.includes("特写")).length === 1,
    `${label} 1-1：【特效】×2、【特写】×1`);
  const voLines = shots.flatMap((entry) => entry.draft.dialogue);
  ok(voLines.length === 1 && voLines[0].mode === "vo" && !voLines[0].lipSync && voLines[0].speakerId === "C02",
    `${label} 1-1：1 条 VO 对白，speakerId 命中注册角色且不计口型`);

  // 人工补齐 camera（分镜步骤的产物），再走合并 → 解析 → 编译
  const filled = shots.map((entry) => parseShotRequestDraft({
    ...entry.draft,
    camera: {
      shot_size: "wide", camera_movement: "dolly_out", lens_mm: 35, lighting_key: "natural",
      depth_of_field: "deep", color_temperature: "neutral", cameraId: "CAM_A",
    },
    scene: { ...entry.draft.scene, lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_A" },
  }));
  const mergedScene = mergeShots(filled, MERGE_OPTIONS);
  ok(mergedScene.drafts.length === 1 && mergedScene.drafts[0].provenance.mergedScriptLines.length === 3
    && mergedScene.drafts[0].output.storyboardDurationSeconds === 8,
    `${label} 1-1：四条 ▲ 行合并为一个镜头（2 s × 4 = 8 s，未超时长上界）`);

  const draft = parseShotRequestDraft({
    ...mergedScene.drafts[0],
    continuity: {
      ...mergedScene.drafts[0].continuity,
      firstFrame: {
        asset: asset(SHA.one, "image/png", 512_000),
        origin: { kind: "operator-upload", note: "S08 未来玉京首帧，操作者上传" },
        containsRealFace: false,
      },
    },
    prompt: {
      ...mergedScene.drafts[0].prompt,
      text: "未来玉京城楼，蒸汽机车穿过门洞，白汽扑上琉璃瓦；镜头一次拉开到位，白发背影停在报房墙前。",
    },
  });
  const result = compileShotRequest(draft, capability(), policy());
  ok(result.validation.errors === 0 && result.shotRequest !== null,
    `${label} 1-1：H3 fl2va 编译通过（实得 issue ${codesOf(result.validation.issues).join(",") || "无"}）`);
  ok(result.validation.mode === "i2v" && result.shotRequest!.output.durationSeconds === 8
    && result.shotRequest!.continuity.firstFrame!.origin.kind === "operator-upload",
    `${label} 1-1：首帧 operator-upload、时长命中已配置 profile 档`);
  ok(result.intentDraft !== null && result.intentDraft.inputs.length === 2
    && result.intentDraft.inputs[0].mediaType === SHOT_REQUEST_MEDIA_TYPE,
    `${label} 1-1：产出 intent draft，inputs[0] 为 ShotRequest`);
};

runEp001Case(EP001_SCENE_1_1, "ep-001 fixture");
{
  const episodePath = process.env.WL_EP001_PATH;
  if (episodePath !== undefined && episodePath !== "") {
    ok(existsSync(episodePath), `WL_EP001_PATH 指向的剧本存在（${episodePath}）`);
    if (existsSync(episodePath)) runEp001Case(readFileSync(episodePath, "utf8"), "ep-001 整集");
  }
}

// —— 0-B 审查修复回归 ——
{
  // MAJOR 1：被并入镜头的 shotId 在其余镜头的 prevShotId 上改写
  const chain = mergeShots(
    [mergeDraft(1), mergeDraft(2), mergeDraft(3, (draft) => { draft.camera!.lens_mm = 85; })],
    MERGE_OPTIONS,
  );
  ok(chain.drafts.length === 2
    && chain.drafts[0].shotId === "EP001-S1-1"
    && chain.drafts[1].shotId === "EP001-S1-3"
    && chain.drafts[1].continuity.prevShotId === "EP001-S1-1",
    "合并⑮：被并入的 EP001-S1-2 从 prevShotId 上改写为存活镜头，不留悬空引用");
  const survivors = new Set(chain.drafts.map((draft) => draft.shotId));
  ok(chain.drafts.every((draft) => draft.continuity.prevShotId === null || survivors.has(draft.continuity.prevShotId)),
    "合并⑯：合并结果里所有 prevShotId 都指向存活镜头");

  // MAJOR 2：条件 9 / 条件 10 / crowd
  const withFirstFrame = mergeDraft(2, (draft) => {
    draft.continuity.firstFrame = {
      asset: asset(SHA.four, "image/png", 4_096),
      origin: { kind: "operator-upload", note: "右行独有首帧" },
      containsRealFace: false,
    };
  });
  ok(shotMergeBlocker(mergeDraft(1), withFirstFrame, MERGE_OPTIONS) === "continuity-inputs",
    "合并⑰：条件 9 —— 右行连续性输入与左行不同不合并（否则被静默丢弃）");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2), MERGE_OPTIONS) === null,
    "合并⑱：条件 9 —— 两行连续性输入相同则不阻断");
  const refRight = mergeDraft(2, (draft) => {
    draft.continuity.firstFrame = null;
    draft.continuity.references = [imageReference(SHA.two)] as ShotRequestDraft["continuity"]["references"];
  });
  ok(shotMergeBlocker(mergeDraft(1, (d) => { d.continuity.firstFrame = null; }), refRight, MERGE_OPTIONS) === "continuity-inputs",
    "合并⑲：条件 9 —— 右行独有参考不合并");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.output.seed = 7; }), MERGE_OPTIONS) === "shot-parameters",
    "合并⑳：条件 10 —— output.seed 不同不合并");
  ok(shotMergeBlocker(mergeDraft(1), mergeDraft(2, (d) => { d.prompt.text = "另一条已撰写的 prompt"; }), MERGE_OPTIONS) === "shot-parameters",
    "合并㉑：条件 10 —— 两侧 prompt.text 非空且不同不合并");
  const oneSideAuthored = mergeShots(
    [mergeDraft(1, (d) => { d.prompt.text = null; }), mergeDraft(2)],
    MERGE_OPTIONS,
  );
  ok(oneSideAuthored.drafts.length === 1
    && oneSideAuthored.drafts[0].prompt.text === baseDraft().prompt.text,
    "合并㉒：条件 10 —— 一侧 prompt.text 为 null 时合并并保留已撰写的一侧");
  const crowdMerge = mergeShots(
    [
      mergeDraft(1),
      mergeDraft(2, (d) => { d.crowd = { label: "沈家人", count: 7, cap: 8 }; }),
    ],
    MERGE_OPTIONS,
  );
  ok(crowdMerge.drafts.length === 1
    && crowdMerge.drafts[0].crowd?.count === 7
    && crowdMerge.warnings.length === 0,
    "合并㉓：crowd 一侧为空时取另一侧，不记 warning");
  const crowdConflict = mergeShots(
    [
      mergeDraft(1, (d) => { d.crowd = { label: "沈家人", count: 7, cap: 8 }; }),
      mergeDraft(2, (d) => { d.crowd = { label: "沈家人", count: 3, cap: 8 }; }),
    ],
    MERGE_OPTIONS,
  );
  ok(crowdConflict.drafts.length === 1
    && crowdConflict.drafts[0].crowd?.count === 7
    && crowdConflict.warnings.some((entry) => entry.field === "crowd"),
    "合并㉔：crowd 两侧不同时取首行并记 warning");

  // MINOR 10：结构上限纳入判定
  const manyVo = (count: number, index: number) => mergeDraft(index, (draft) => {
    draft.dialogue = Array.from({ length: count }, () => ({
      speakerId: "C02", text: "旁白。", mode: "vo" as const, language: "zh-CN", lipSync: false,
    }));
  });
  ok(shotMergeBlocker(manyVo(40, 1), manyVo(30, 2), MERGE_OPTIONS) === "structure-cap",
    "合并㉕：合并后 dialogue 超过解析层上限不合并（不留到末尾重解析才抛错）");

  // MINOR 20：输入顺序校验
  ok(throwsProduction(() => mergeShots([mergeDraft(3), mergeDraft(1)], MERGE_OPTIONS), "必须按行序排列"),
    "合并㉖：mergeShots 拒绝行序倒置的输入");
  ok(throwsProduction(
    () => mergeShots(
      [
        mergeDraft(1),
        mergeDraft(2, (d) => { d.continuity.stageGroup = "EP001-S2"; }),
        mergeDraft(3),
      ],
      MERGE_OPTIONS,
    ),
    "在中断后重新出现",
  ), "合并㉗：mergeShots 拒绝同一 stageGroup 被打断后重现的输入");
}

{
  // MAJOR 3：裁剪导致 prompt 序号错位 → error（且 references-trimmed 需重审批）
  const refCapability = capability(undefined, { "h3-9x16-8s": limits({ modes: ["ref2v"], maxReferenceImages: 1 }) });
  const refPolicy = policy(h3Profile({ variant: "ref2va" }));
  const shifted = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [
        imageReference(SHA.two, { purpose: "style", priority: 3 }),
        imageReference(SHA.three, { purpose: "character-identity", priority: 1 }),
      ] as ShotRequestDraft["continuity"]["references"];
      draft.prompt.text = "沿用 图片1 的构图。";
    }),
    refCapability,
    refPolicy,
  );
  expectCode(shifted, "reference_index_out_of_range", "裁剪掉的参考排在保留项之前且 prompt 写了序号 → 拒绝");
  const trimmedNoMention = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = null;
      draft.continuity.references = [
        imageReference(SHA.two, { purpose: "style", priority: 3 }),
        imageReference(SHA.three, { purpose: "character-identity", priority: 1 }),
      ] as ShotRequestDraft["continuity"]["references"];
    }),
    refCapability,
    refPolicy,
  );
  ok(trimmedNoMention.validation.errors === 0
    && trimmedNoMention.degradations.some((entry) => entry.code === "references-trimmed" && entry.requiresReapproval),
    "references-trimmed 一律 requiresReapproval: true（裁剪改变了下发素材集合）");

  // MAJOR 4：urn:sha256 关键帧 / 参考 / spatialPasses 改写为 cas://
  const urnAsset = { ...asset(SHA.one, "image/png", 512_000), uri: `urn:sha256:${SHA.one}` };
  const rewritten = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.firstFrame = {
        asset: urnAsset,
        origin: { kind: "previous-shot-last-frame", shotId: "EP001-S1-0", taskId: "take-ep001-s1-0" },
        containsRealFace: false,
      };
      draft.continuity.spatialPasses = [{ ...asset(SHA.four, "image/png", 2_048), uri: `urn:sha256:${SHA.four}` }];
    }),
    capability(),
    policy(),
  );
  ok(rewritten.validation.errors === 0
    && rewritten.shotRequest!.continuity.firstFrame!.asset.uri === `cas://wl-sg/sha256/${SHA.one}`
    && rewritten.shotRequest!.continuity.firstFrame!.asset.sha256 === SHA.one
    && rewritten.shotRequest!.continuity.spatialPasses[0].uri === `cas://wl-sg/sha256/${SHA.four}`
    && rewritten.intentDraft!.inputs[1].uri === `cas://wl-sg/sha256/${SHA.one}`,
    "承接链：ingest 的 urn:sha256 输入在编译期改写为 cas://<authority>/sha256/<digest>（§4.1、§6.4）");
  ok(rewriteToCasUri(asset(SHA.two), "wl-sg").uri === `cas://wl-sg/sha256/${SHA.two}`
    && rewriteToCasUri({ ...asset(SHA.two), uri: `s3://bucket/${SHA.two}` }, "wl-sg").uri === `s3://bucket/${SHA.two}`,
    "承接链：非 urn scheme 原样保留");
  ok(throwsProduction(
    () => rewriteToCasUri({ ...asset(SHA.two), uri: `urn:sha256:${SHA.three}` }, "wl-sg"),
    "与 AssetRef.sha256 不一致",
  ), "承接链：urn digest 与 sha256 不一致时抛错");

  // MAJOR 5：同一资产占两个输入 slot → 编译期 error，不留给 intent 解析抛错
  const duplicated = compileShotRequest(
    withDraft((draft) => {
      draft.continuity.lastFrame = {
        asset: asset(SHA.one, "image/png", 512_000),
        origin: { kind: "operator-upload", note: "与首帧同一张图" },
        containsRealFace: false,
      };
    }),
    capability(),
    policy(),
  );
  expectCode(duplicated, "unsupported_continuity_mode", "首尾帧指向同一资产 → 编译期拒绝（不抛 ProductionError）");

  // MAJOR 8：intent execution 的 shortEdge 取 profile 值
  const h3 = compileShotRequest(baseDraft(), capability(), policy());
  ok(h3.intentDraft!.execution.modelFamily === "minimax-h3"
    && h3.intentDraft!.execution.shortEdge === (h3Profile() as { shortEdge: number }).shortEdge,
    "intent execution 的 shortEdge 来自 execution profile（解析层把 H3 v1 钉在 768）");

  // MINOR 9：原型键不触发 TypeError
  const prototypeProp = compileShotRequest(
    withDraft((draft) => {
      draft.props = [{ objectId: "constructor", stateId: "O01_CLOSED", visible: true, position: null }];
    }),
    capability(),
    policy(),
  );
  expectCode(prototypeProp, "prop_state_missing", "propStates 用原型键取值不命中 Object.prototype");
  const prototypeCandidate = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame!.origin = { kind: "approved-candidate", candidateId: "constructor" }; }),
    capability(),
    policy(),
  );
  expectCode(prototypeCandidate, "keyframe_not_approved", "approvedCandidates 用原型键取值不命中 Object.prototype");

  // MINOR 13：Veo 的 asset 参考与 style 参考互斥
  const veoStyle = compileShotRequest(
    englishDraft((draft) => {
      draft.output.storyboardDurationSeconds = 8;
      draft.continuity.firstFrame = null;
      draft.continuity.references = [
        imageReference(SHA.two, { purpose: "character-identity", priority: 1 }),
        imageReference(SHA.three, { purpose: "style", priority: 1 }),
      ] as ShotRequestDraft["continuity"]["references"];
    }),
    veoCapability(),
    cloudPolicy(veoProfile()),
  );
  ok(veoStyle.validation.errors === 0
    && veoStyle.shotRequest!.continuity.references.length === 1
    && veoStyle.shotRequest!.continuity.references[0].purpose === "character-identity"
    && veoStyle.shotRequest!.continuity.droppedReferences[0].purpose === "style",
    "Veo：referenceImages 为「≤3 张 asset 或 1 张 style」，二者互斥（§5.2）");

  // MINOR 16：t2v 只报一条
  const t2vOnce = compileShotRequest(
    withDraft((draft) => { draft.continuity.firstFrame = null; }),
    capability(),
    policy(),
  );
  ok(codesOf(t2vOnce.validation.issues).join(",") === "unsupported_operation",
    `H3 t2v 只报 unsupported_operation（实得 ${codesOf(t2vOnce.validation.issues).join(",")}）`);

  // 裁定 A：任意 --flag 一律拒绝，中文破折号不误报
  const longFlag = compileShotRequest(
    withDraft((draft) => { draft.prompt.text = "城楼门洞，白汽扑上琉璃瓦 --frames_per_second 24"; }),
    capability(),
    policy(),
  );
  expectCode(longFlag, "prompt_contains_provider_directive", "长写 --flag 命中 provider 文本指令");
  const cjkAdjacent = compileShotRequest(
    withDraft((draft) => { draft.prompt.text = "城楼门洞，--dur 5，白汽扑上琉璃瓦"; }),
    capability(),
    policy(),
  );
  expectCode(cjkAdjacent, "prompt_contains_provider_directive", "紧邻中文标点的 --flag 命中");
  ok(!PROVIDER_DIRECTIVE_RE.test("镜头自城楼一次拉开到位——铁轨、织坊、报房同在一镜。"),
    "中文破折号「——」不误报为 provider 指令");

  // 裁定 12：裸「图」只在 @ 前缀或数字紧邻时算序号引用
  const falsePositive = compileShotRequest(
    withDraft((draft) => { draft.prompt.text = "画面构图 2 层，前景是城楼。"; }),
    capability(),
    policy(),
  );
  ok(falsePositive.validation.errors === 0, "「画面构图 2 层」不误报 reference_index_out_of_range");
  const atBare = compileShotRequest(
    withDraft((draft) => { draft.prompt.text = "沿用 @图1 的构图。"; }),
    capability(),
    policy(),
  );
  expectCode(atBare, "reference_index_out_of_range", "「@图1」在无参考时越界");
  ok(!REFERENCE_INDEX_RE.flags.includes("g"), "导出的 REFERENCE_INDEX_RE 不带 g 标志（lastIndex 不跨调用泄漏）");

  // 裁定 C：H3 时长档选择
  const profiles = [h3Profile({ profileId: "h3-9x16-5s", durationSeconds: 5 }), h3Profile()];
  ok(selectH3ProfileForDuration(3, profiles)?.durationSeconds === 5
    && selectH3ProfileForDuration(6, profiles)?.durationSeconds === 8
    && selectH3ProfileForDuration(12, profiles) === null
    && selectH3ProfileForDuration(4, [veoProfile()]) === null,
    "selectH3ProfileForDuration：按网格上取整选档，超上界返回 null");
}

// —— 解析层不变量（MINOR 11 / 15 / 17 / 18）——
{
  const draft = baseDraft();
  ok(throwsProduction(
    () => parseShotRequestDraft({ ...draft, output: { ...draft.output, storyboardDurationSeconds: 0 } }),
    "storyboardDurationSeconds",
  ), "draft 解析：storyboardDurationSeconds 必须为正");
  ok(throwsProduction(
    () => parseShotRequestDraft({
      ...draft,
      cast: [
        { characterId: "C01", name: "顾知行", appearanceStateId: "C01_YOUTH", voiceId: null, onScreen: true, performNotes: null, stage: null },
        { characterId: "C01", name: "顾知行", appearanceStateId: "C01_ADULT", voiceId: null, onScreen: true, performNotes: null, stage: null },
      ],
    }),
    "不得包含重复 characterId",
  ), "draft 解析：拒绝重复 characterId（否则合并条件 5 可被绕过）");
  ok(throwsProduction(
    () => parseShotRequestDraft({
      ...draft,
      props: [
        { objectId: "O01", stateId: "O01_CLOSED", visible: true, position: null },
        { objectId: "O01", stateId: "O01_OPEN", visible: true, position: null },
      ],
    }),
    "不得包含重复 objectId",
  ), "draft 解析：拒绝重复 objectId");
  ok(throwsProduction(
    () => parseShotRequestDraft({
      ...draft,
      dialogue: [{ speakerId: "C01", text: "我自己开。", mode: "vo", language: "zh-CN", lipSync: true }],
    }),
    'lipSync 必须等于 mode === "onscreen"',
  ), "draft 解析：lipSync 必须由 mode 推导");

  const compiled = compileShotRequest(baseDraft(), capability(), policy()).shotRequest!;
  ok(throwsProduction(
    () => parseShotRequest({
      ...compiled,
      continuity: { ...compiled.continuity, anchorMode: "none" },
    }),
    "none 要求 firstFrame 与 lastFrame 均为 null",
  ), "ShotRequest 解析：anchorMode=none 时首尾帧必须为空");
  ok(throwsProduction(
    () => parseShotRequest({
      ...compiled,
      continuity: {
        ...compiled.continuity,
        fingerprint: { modelSha256: SHA.c, workflowSha256: SHA.b, seed: 1 },
      },
    }),
    "缺少字段：seedReproducible",
  ), "ShotRequest 解析：fingerprint 字段必须齐全");
  ok(throwsProduction(
    () => parseShotRequest({
      ...compiled,
      continuity: {
        ...compiled.continuity,
        droppedReferences: [{ asset: asset(SHA.two), purpose: "style", subjectId: null, priority: 1, containsRealFace: false, note: "x" }],
      },
    }),
    "含不支持字段",
  ), "ShotRequest 解析：droppedReferences 拒绝未知字段");

  ok(throwsProduction(
    () => parseShotExecutionProfile({ ...h3Profile(), extra: 1 }),
    "含不支持字段",
  ), "execution profile 解析：exactKeys 拒绝未知字段");
  ok(throwsProduction(
    () => parseShotExecutionProfile({ ...h3Profile(), operation: "ark-video-task" }),
    "H3 transport 必须是",
  ), "execution profile 解析：家族与 operation 必须匹配");
  ok(throwsProduction(
    () => parseShotExecutionProfile(seedanceProfile({ executionExpiresAfterSeconds: 60 })),
    "executionExpiresAfterSeconds",
  ), "execution profile 解析：seedance 过期时间必须在 [3600, 259200]");
  ok(throwsProduction(
    () => parseShotCompilePolicy({ ...policy(), extra: 1 }),
    "含不支持字段",
  ), "compile policy 解析：exactKeys 拒绝未知字段");
  ok(throwsProduction(
    () => parseShotCompilePolicy({ ...policy(), casAuthority: "WL_SG" }),
    "CAS authority",
  ), "compile policy 解析：casAuthority 必须是小写 authority");
  ok(parseShotCompilePolicy(policy()).propStates.O01.join(",") === "O01_CLOSED",
    "compile policy 解析：propStates 正常键位可读");

  const candidateMismatch = compileShotRequest(
    withDraft((entry) => { entry.continuity.firstFrame!.origin = { kind: "approved-candidate", candidateId: "CAND-1" }; }),
    capability(),
    policy(h3Profile(), {
      approvedCandidates: { "CAND-1": { sha256: SHA.four, status: "approved", reviewedBy: "operator", reviewedAt: AT } },
    }),
  );
  expectCode(candidateMismatch, "keyframe_not_approved", "候选图 sha256 与输入资产不符");
}

console.log(fails === 0 ? "\nPRODUCTION_SHOT_REQUEST_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
