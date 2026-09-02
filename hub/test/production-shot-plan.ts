// 批次审批与成本门（DESIGN §4.7）：plan 零写入、batchPlanId 绑定策略与输入、confirm 的 CAS/enqueue
// 顺序、样片门、QC 裁决入口、承接链波次、视觉侧默认值，以及 ep-001 场 1-1 的
// --from-script → plan → confirm 全链。
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { productionCanonicalJsonSha256 } from "../src/production-canonical-json.ts";
import { productionMain } from "../src/production.ts";
import { ProductionStore, readProductionState } from "../src/production-store.ts";
import { parseProductionTaskEvent } from "../src/production-domain.ts";
import { parseProductionExecutionProfileSnapshot } from "../src/production-profile-snapshot.ts";
import { parseShotBatchRequest, parseShotRequestScriptOptions } from "../src/production-shot-plan.ts";
import { productionCasObjectPath, readProductionCasObject } from "../src/production-cas.ts";
import {
  evaluateProductionIntentGates,
  parseProductionLicenseEvidence,
  productionIntentPath,
  readProductionIntent,
} from "../src/production-intent.ts";
import { createProductionRuntimeRegistry } from "../src/production-runtime-config.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

function capture(args: string[], cwd: string): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
  try { return { code: productionMain(args, cwd), out: out.join("\n"), err: err.join("\n") }; }
  finally { console.log = oldLog; console.error = oldError; }
}

/** 目录快照：`--plan` 的零写入判据是「命令前后整棵 workspace 逐文件字节相同」。 */
function treeSnapshot(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) { rows.push(`d ${relative(root, path)}`); walk(path); }
      else rows.push(`f ${relative(root, path)} ${info.size} ${productionCanonicalJsonSha256(readFileSync(path, "utf8"))}`);
    }
  };
  walk(root);
  return rows.join("\n");
}

const clone = <T>(value: T): T => structuredClone(value);
const SHA = {
  a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64), e: "e".repeat(64),
  f: "f".repeat(64), one: "1".repeat(64), two: "2".repeat(64), three: "3".repeat(64),
};
const AT = "2026-08-28T00:00:00.000Z";
const WORKSPACE_ID = `ws_${"a".repeat(32)}`;
const PROFILE_ID = "h3-fl2va-portrait";
const LANDSCAPE_PROFILE_ID = "h3-fl2va-landscape";

// 打包示例是仓库里唯一一份通过 strict parser 的完整 H3 runtime config（含 pinned graph 契约）；
// 这里复用它的 workflow / stagingProfile / 三个 digest，测试只替换项目与快照声明。
const EXAMPLE_RUNTIME = JSON.parse(readFileSync(
  join(import.meta.dirname, "..", "examples", "production", "representative-h3", "production-runtime.json"),
  "utf8",
)) as Record<string, any>;
const EXAMPLE_WORKFLOW = EXAMPLE_RUNTIME.workflows[0] as Record<string, any>;
const WORKFLOW_SHA = EXAMPLE_WORKFLOW.workflowSha256 as string;
const MODEL_SHA = EXAMPLE_WORKFLOW.modelSha256 as string;
const PARAMETERS_SHA = EXAMPLE_WORKFLOW.parametersSha256 as string;

const asset = (sha256: string, mediaType = "image/png", byteLength = 512_000) => ({
  version: 1 as const, uri: `cas://wl-sg/sha256/${sha256}`, sha256, byteLength, mediaType,
});

const limits = (over: Record<string, unknown> = {}) => ({
  modes: ["i2v", "fl2v"],
  durationSeconds: { min: 8, max: 8, grid: [8], gridByResolution: null },
  aspectRatios: ["9:16"],
  resolutions: ["768p"],
  maxReferenceImages: 0,
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
  ...over,
});

const capability = (over: Record<string, unknown> = {}) => ({
  backendKind: "comfyui",
  backendInstanceId: "gateway-h3-fl2va",
  modelFamilies: ["generic", "minimax-h3"],
  processingRegions: ["CN"],
  asynchronous: true,
  clientAssignedJobId: true,
  providerJobIdMapping: "none",
  inspectById: true,
  progressHints: "optional-websocket",
  pendingCancellation: "best-effort",
  runningCancellation: "version-gated-best-effort",
  providerIdempotency: false,
  inputModes: ["image-upload"],
  outputModes: ["download"],
  limitsByModelId: { [PROFILE_ID]: limits() },
  ...over,
});

// 许可 / 版权 / 审核三项都带齐 evidence：这样 gate 的其余门都通过，用例才能断言「恰只剩地域门」。
const H3_LICENSE = {
  version: 1, status: "verified", basis: "community", territories: ["CN"], licenseSha256: SHA.a,
  evidence: { version: 1, uri: `cas://wl-sg/sha256/${SHA.a}`, sha256: SHA.a, byteLength: 2_048, mediaType: "text/plain" },
  issuedBy: "MiniMaxAI", issuedAt: AT, expiresAt: null,
  obligations: { attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true },
};
const RIGHTS_EVIDENCE = {
  version: 1, uri: `cas://wl-sg/sha256/${SHA.b}`, sha256: SHA.b, byteLength: 1_024, mediaType: "application/json",
};
const MODERATION_EVIDENCE = {
  version: 1, uri: `cas://wl-sg/sha256/${SHA.c}`, sha256: SHA.c, byteLength: 1_024, mediaType: "application/json",
};

const execution = (over: Record<string, unknown> = {}) => ({
  version: 1,
  kind: "writing-loop/execution-profile",
  profileId: PROFILE_ID,
  backendInstanceId: "gateway-h3-fl2va",
  workflowSha256: WORKFLOW_SHA,
  modelSha256: MODEL_SHA,
  parametersSha256: PARAMETERS_SHA,
  resolution: "768p",
  aspectRatio: "9:16",
  generateAudio: true,
  modelFamily: "minimax-h3",
  operation: "comfyui-workflow",
  variant: "fl2va",
  shortEdge: 768,
  durationSeconds: 8,
  ...over,
});

const PRICE_TABLE = {
  version: 1, basis: "tariff", currency: "USD", microsPerOutputSecond: 430_000,
  priceAsOf: AT, source: "spot g4-standard-48 tariff",
};

/** 快照条目：profileDigest = 去掉该字段后条目的 canonical JSON sha256（与 gateway 导出同一算法）。 */
function snapshotEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = {
    version: 1,
    profileId: PROFILE_ID,
    execution: execution(),
    durationGrid: [8],
    priceTable: clone(PRICE_TABLE),
    license: clone(H3_LICENSE),
    processingRegions: ["CN"],
    ...over,
  };
  // gateway 导出时 license 已经过 parseProductionLicenseEvidence（obligations 缺省与显式 null
  // 都规范化为不带该键），digest 算在规范化之后的正本上——fixture 走同一条路径。
  const body = { ...raw, license: parseProductionLicenseEvidence(raw.license, "fixture license") };
  return { ...body, profileDigest: productionCanonicalJsonSha256(body) };
}

function snapshotOf(entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    version: 1,
    kind: "writing-loop/execution-profile-snapshot",
    casAuthority: "wl-sg",
    profiles: entries,
  };
}

const snapshot = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  snapshotOf([snapshotEntry(over)]);

function runtimeConfig(project: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = clone(EXAMPLE_RUNTIME);
  return {
    ...base,
    workspaceId: WORKSPACE_ID,
    projects: [{
      version: 1,
      project,
      enabled: true,
      backendInstanceIds: ["gateway-h3-fl2va"],
      deploymentTerritories: ["CN"],
      availableBudgetMicros: 50_000_000,
      allowedProcessingRegions: ["CN"],
      licenseCompliance: { annualRevenueUsdBelow: 1_000_000, attributionSurfaces: ["片尾字幕"] },
      usesOutputToImproveModels: false,
    }],
    workflows: [{ ...base.workflows[0], projects: [project] }],
    executionProfileSnapshotFile: "profiles/snapshot.json",
    ...over,
  };
}

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

/** 场内首个 ▲ 之前就有对白（ep-018.md:18 实测形）：预填 warning 的取证语料。 */
const EP001_EARLY_DIALOGUE = [
  "第1集（还没发生的日子）",
  "",
  "1-1 未来玉京 日 外",
  "人物：谢蘅秋（年长·背影）",
  "谢蘅秋（年长·VO，平缓）：修成这一切的人，公开的名字叫顾知行。",
  "▲ 【特效】一列蒸汽机车穿过大明制式城楼门洞，白汽扑上琉璃瓦。",
  "",
].join("\n");

const CAMERA = {
  shot_size: "wide", camera_movement: "dolly_out", lens_mm: 35, lighting_key: "natural",
  depth_of_field: "deep", color_temperature: "neutral", cameraId: "CAM_A",
};

const SCRIPT_OPTIONS = {
  subject: {
    episode: { version: 1, episodeId: "ep-001", revision: 1, source: asset(SHA.e, "text/markdown", 8_192) },
    revision: 1,
    source: asset(SHA.e, "text/markdown", 8_192),
  },
  provenance: { storyDesignSha256: SHA.f, assetsRevision: 12, visualProductionSha256: null, beatCardHash: "8137791889ad" },
  sceneRegistry: [{ id: "S08", name: "未来玉京" }, { id: "S01", name: "沈家大院" }],
  characters: [{ id: "C01", name: "顾知行" }, { id: "C02", name: "谢蘅秋" }],
  output: { aspectRatio: "9:16", generateAudio: true, seed: 4_242 },
  defaultStoryboardDurationSeconds: 2,
  prompt: { authoredBy: "episode-writer" },
};

const PROMPT_PATCH = {
  text: "未来玉京城楼，蒸汽机车穿过门洞，白汽扑上琉璃瓦；镜头一次拉开到位。",
  negativeText: null,
  language: "zh-CN",
  authoredBy: "episode-writer",
  translations: [],
};

const OPERATOR_FIRST_FRAME = {
  asset: asset(SHA.one),
  origin: { kind: "operator-upload", note: "S08 未来玉京首帧，操作者上传" },
  containsRealFace: false,
};

function batchRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "writing-loop/shot-batch-request",
    phase: "sample",
    capability: capability(),
    backendInstanceId: "gateway-h3-fl2va",
    arcId: "ARC_EARLY",
    anchorPreference: "keyframes",
    compiler: "production-shot-request@1",
    taskIdPrefix: "take",
    createdAt: AT,
    useTerritories: ["CN"],
    rights: { version: 1, status: "cleared", territories: ["CN"], evidence: clone(RIGHTS_EVIDENCE), expiresAt: null },
    moderation: { version: 1, status: "passed", reviewedAt: AT, evidence: clone(MODERATION_EVIDENCE) },
    license: clone(H3_LICENSE),
    profileId: null,
    samplePolicy: null,
    gpuEstimate: { spotUsdPerHour: 1.55, estimatedHours: 0.5 },
    shots: [],
    script: {
      episodeFile: "episodes/ep-001.md",
      episode: 1,
      sceneIndexes: [1],
      options: clone(SCRIPT_OPTIONS),
      // 合并前：分镜产物逐镜落位——四条 ▲ 行同机位才可能合并。灯光由 mappings 表补，陈设人工写。
      patches: [1, 2, 3, 4].map((index) => ({
        shotId: `EP001-S1-${index}`,
        camera: clone(CAMERA),
        scene: { dressingVariantId: "DRESS_BASE" },
      })),
      // 合并后：写作侧 prompt 与首帧排期按存活镜头补齐。
      mergedPatches: [{
        shotId: "EP001-S1-1",
        continuity: { firstFrame: clone(OPERATOR_FIRST_FRAME) },
        prompt: clone(PROMPT_PATCH),
      }],
    },
    ...over,
  };
}

const MAPPINGS = {
  version: 1, kind: "writing-loop/visual-mappings", project: "demo",
  lighting: [{ sceneId: "S08", timeOfDay: "day", lightingStateId: "LIGHT_DAY" }],
  dressing: [{ sceneId: "S08", arcId: "ARC_EARLY", dressingVariantId: "DRESS_BASE" }],
};

const visualAsset = (sha256: string, mediaType = "image/png") => ({
  version: 1 as const, uri: `cas://wl-sg/sha256/${sha256}`, sha256, byteLength: 4_096, mediaType,
});

/** 一份最小但可解析的视觉清单：S08 处于 keyframe-review，带一张候选图。 */
function visualManifest(candidate: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    kind: "writing-loop/visual-production",
    project: "demo",
    storyDesignSha256: SHA.f,
    revision: 1,
    defaults: {
      coordinateSystem: "blender-z-up", unitScaleMeters: 1, renderEngine: "eevee",
      imageWorkflowProfileId: null,
    },
    subjectReferences: [],
    scenes: [{
      sceneId: "S08",
      phase: "keyframe-review",
      blendAsset: visualAsset(SHA.b, "application/x-blender"),
      geometryRevision: 1,
      cameras: [{ id: "CAM_A", label: "城楼建立镜头", lensMm: 35, sensorWidthMm: 36, aspectRatio: "9:16", transform: null }],
      lightingStates: [{ id: "LIGHT_DAY", label: "晴日", notes: "硬光" }],
      dressingVariants: [{ id: "DRESS_BASE", label: "基础陈设", notes: "未来玉京" }],
      renders: [
        { id: "R_DEPTH", cameraId: "CAM_A", lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE", pass: "depth", asset: visualAsset(SHA.c, "image/x-exr") },
        { id: "R_LINE", cameraId: "CAM_A", lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE", pass: "lineart", asset: visualAsset(SHA.d) },
      ],
      candidates: [candidate],
    }],
  };
}

const CANDIDATE = (over: Record<string, unknown> = {}) => ({
  id: "K_S08_EST",
  cameraId: "CAM_A",
  lightingStateId: "LIGHT_DAY",
  dressingVariantId: "DRESS_BASE",
  sourceRenderIds: ["R_DEPTH", "R_LINE"],
  workflowProfileId: "keyframe/depth-lineart-v1",
  workflowSha256: SHA.c,
  modelSha256: SHA.d,
  promptSha256: SHA.e,
  seed: 42,
  asset: visualAsset(SHA.three),
  status: "approved",
  reviewedBy: "art:lead",
  reviewedAt: AT,
  shotIds: ["EP001-S1-1"],
  containsRealFace: false,
  notes: "S08 建立镜头首帧",
  ...over,
});

type WorkspaceOptions = {
  snapshotDoc?: Record<string, unknown>;
  episode?: string;
  visualCandidate?: Record<string, unknown> | null;
  request?: Record<string, unknown>;
};

type Fixture = { root: string; repo: string; configFile: string; inputFile: string };

function makeWorkspace(options: WorkspaceOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-shot-plan-")));
  const data = join(root, ".writing-loop");
  mkdirSync(join(data, "demo"), { recursive: true });
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: WORKSPACE_ID }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "玉京旧事", repoPath: "repo", enabled: true } },
  }, null, 2) + "\n");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "visual"), { recursive: true });
  writeFileSync(join(repo, "episodes", "ep-001.md"), options.episode ?? EP001_SCENE_1_1);
  writeFileSync(join(repo, "visual", "mappings.v1.json"), JSON.stringify(MAPPINGS, null, 2) + "\n");
  writeFileSync(join(repo, "visual", "prop-states.v1.json"), JSON.stringify({
    version: 1, kind: "writing-loop/visual-prop-states", project: "demo",
    objects: [{
      objectId: "O01",
      states: [{ stateId: "O01_CLOSED", label: "木匣闭合", notes: "初始状态" }],
      timeline: [{ episode: 1, sceneId: "S08", stateId: "O01_CLOSED" }],
    }],
  }, null, 2) + "\n");
  if (options.visualCandidate !== undefined && options.visualCandidate !== null) {
    writeFileSync(
      join(repo, "visual", "production.v1.json"),
      JSON.stringify(visualManifest(options.visualCandidate), null, 2) + "\n",
    );
  }
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "profiles"), { recursive: true });
  const snapshotFile = join(runtime, "profiles", "snapshot.json");
  writeFileSync(snapshotFile, JSON.stringify(options.snapshotDoc ?? snapshot(), null, 2) + "\n");
  chmodSync(snapshotFile, 0o600);
  const configFile = join(runtime, "production-runtime.json");
  writeFileSync(configFile, JSON.stringify(runtimeConfig("demo"), null, 2) + "\n");
  chmodSync(configFile, 0o600);
  const inputFile = join(root, "batch.json");
  writeFileSync(inputFile, JSON.stringify(options.request ?? batchRequest(), null, 2) + "\n");
  return { root, repo, configFile, inputFile };
}

const planArgs = (fixture: Fixture, extra: string[] = []): string[] => [
  "plan-shots", "--project", "demo", "--input", fixture.inputFile, "--config", fixture.configFile, ...extra,
];
const planJson = (fixture: Fixture, extra: string[] = []): Record<string, any> => {
  const result = capture(planArgs(fixture, ["--plan", "--json", ...extra]), fixture.root);
  if (!result.out.trim()) throw new Error(`plan-shots --plan 无输出（退出 ${result.code}）：${result.err}`);
  return JSON.parse(result.out) as Record<string, any>;
};

const errorOf = (fn: () => unknown): string => {
  try { fn(); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
};

// —— 快照解析 ——
{
  const parsed = parseProductionExecutionProfileSnapshot(snapshot());
  ok(parsed.profiles.length === 1 && parsed.profiles[0].profileId === PROFILE_ID
    && parsed.profiles[0].priceTable?.microsPerOutputSecond === 430_000,
  "快照严格解析：profileId、价目与时长档进入 worker 侧模型");

  const drifted = snapshot() as { profiles: Array<Record<string, any>> };
  drifted.profiles[0].priceTable.microsPerOutputSecond = 1;
  ok(errorOf(() => parseProductionExecutionProfileSnapshot(drifted)).includes("与条目内容不一致"),
    "快照价目被就地改过时 digest 校验失败（价目只有 registry 一处来源）");
  ok(errorOf(() => parseProductionExecutionProfileSnapshot({ ...snapshot(), casAuthority: "WL_SG" }))
    .includes("CAS authority"), "快照 casAuthority 必须是小写 CAS authority");

  // 多地域：两侧都规范化为升序去重后才算 digest，顺序差异不构成不一致。
  const multiRegion = parseProductionExecutionProfileSnapshot(snapshot({ processingRegions: ["CN", "SG"] }));
  ok(multiRegion.profiles[0].processingRegions.join(",") === "CN,SG",
    "多地域快照解析为升序去重集合");

  // 1b 兼容：条目带 limits 时 limits 进入 digest 计算体，不带时不进入；两种形态都能自洽。
  const withLimits = parseProductionExecutionProfileSnapshot(snapshot({ limits: limits() }));
  ok(withLimits.profiles[0].limits?.durationSeconds.max === 8,
    "快照条目带 limits 时解析出能力上限（Phase 1b 形态）");
  ok(withLimits.profiles[0].profileDigest !== parseProductionExecutionProfileSnapshot(snapshot())
    .profiles[0].profileDigest,
  "limits 进入 profileDigest 计算体：带与不带是两个不同 digest");
  const staleDigest = snapshot({ limits: limits() }) as { profiles: Array<Record<string, any>> };
  staleDigest.profiles[0].profileDigest = parseProductionExecutionProfileSnapshot(snapshot())
    .profiles[0].profileDigest;
  ok(errorOf(() => parseProductionExecutionProfileSnapshot(staleDigest)).includes("与条目内容不一致"),
    "带 limits 的条目沿用不含 limits 的 digest 时被拒");

  // license.obligations 缺省与显式 null 都规范化为「不带该键」，digest 必须相同。
  const noObligations = clone(H3_LICENSE) as Record<string, any>;
  delete noObligations.obligations;
  const nullObligations = { ...clone(H3_LICENSE), obligations: null };
  const digestFor = (license: unknown): string => parseProductionExecutionProfileSnapshot(
    snapshot({ license }),
  ).profiles[0].profileDigest;
  ok(digestFor(noObligations) === digestFor(nullObligations),
    "快照 license.obligations 缺省与显式 null 解析后 digest 相同");
}

// —— 请求文档解析 ——
{
  ok(parseShotBatchRequest(batchRequest()).phase === "sample", "批次请求解析：sample 相位");
  ok(errorOf(() => parseShotBatchRequest({ ...batchRequest(), shots: [{}] })).includes("必须且只能提供"),
    "shots[] 与 script 同时提供时拒绝（两个事实源）");

  const badPatch = batchRequest() as { script: { patches: Array<Record<string, unknown>> } };
  badPatch.script.patches[0].action = "改写动作行";
  ok(errorOf(() => parseShotBatchRequest(badPatch)).includes("只允许补齐"),
    "patch 不得改写剧本事实字段（action）");

  const badScene = batchRequest() as { script: { patches: Array<Record<string, any>> } };
  badScene.script.patches[0].scene = { sceneId: "S01" };
  ok(errorOf(() => parseShotBatchRequest(badScene)).includes("lightingStateId"),
    "scene patch 只接受 lightingStateId / dressingVariantId（场景身份是剧本事实）");

  const badContinuity = batchRequest() as { script: { mergedPatches: Array<Record<string, any>> } };
  badContinuity.script.mergedPatches[0].continuity = { stageGroup: "EP001-S9" };
  ok(errorOf(() => parseShotBatchRequest(badContinuity)).includes("firstFrame"),
    "continuity patch 不接受 stageGroup / prevShotId（合并结果是事实）");

  const noPrompt = batchRequest() as { script: { options: Record<string, any> } };
  delete noPrompt.script.options.prompt;
  ok(errorOf(() => parseShotBatchRequest(noPrompt)).includes("缺少：prompt"),
    "script.options 缺 prompt 时在装配期就拒绝");
  ok(errorOf(() => parseShotRequestScriptOptions({ ...clone(SCRIPT_OPTIONS), output: { aspectRatio: "adaptive", generateAudio: true, seed: null } }))
    .includes("aspectRatio"), "script.options 的画幅枚举在装配期校验");
  ok(parseShotRequestScriptOptions(clone(SCRIPT_OPTIONS)).characters?.length === 2,
    "script.options 的可选 characters 保留（对白 speakerId 命中注册角色）");
  ok(errorOf(() => parseShotRequestScriptOptions({ ...clone(SCRIPT_OPTIONS), unknownKey: 1 }))
    .includes("未知：unknownKey"), "script.options 拒绝未知字段");
}

// —— --plan 零写入 + batchPlanId 稳定性 ——
const first = makeWorkspace();
let batchPlanId = "";
try {
  const before = treeSnapshot(first.root);
  const planned = capture(planArgs(first, ["--plan", "--json"]), first.root);
  const after = treeSnapshot(first.root);
  ok(planned.code === 0, `plan-shots --plan 退出 0（实得 ${planned.code}；${planned.err}）`);
  ok(before === after, "plan-shots --plan 严格零写入（workspace 目录树逐文件字节不变）");
  const plan = JSON.parse(planned.out) as Record<string, any>;
  batchPlanId = plan.batchPlanId as string;
  ok(/^[a-f0-9]{64}$/.test(batchPlanId) && plan.kind === "writing-loop/shot-batch-plan",
    "plan 文档带 sha256 batchPlanId");
  ok(plan.totals.shots === 1 && plan.shots[0].shotId === "EP001-S1-1",
    `--from-script 的四条 ▲ 行合并为 1 镜（实得 ${plan.totals.shots}）`);
  ok(plan.estimates[0].estimatedAmountMicros === 430_000 * 8
    && plan.estimates[0].maximumAmountMicros === Math.ceil(430_000 * 8 * 1.5),
  "估算 = 快照价目 × 取整时长，上限为估算 × 1.5");
  ok(plan.decisions[0].profileId === PROFILE_ID && plan.decisions[0].durationSeconds === 8
    && plan.decisions[0].reason.includes("9:16/audio=true"),
  "decisions[] 记录后端选择理由：输出形状 + 时长档");
  ok(plan.samplePolicy.sampleShotIds.join(",") === "EP001-S1-1"
    && plan.samplePolicy.requireApprovedSampleBeforeBulk === true,
  "samplePolicy 缺省每个被选 profile 各 1 镜");
  ok(plan.waves.length === 1 && plan.waves[0].shotIds.join(",") === "EP001-S1-1", "承接链波次覆盖全部镜头");
  ok(plan.totals.gpu.estimatedUsd > 0 && plan.blocked === false, "GPU 小时附注随计划输出，且批次未被阻断");
  ok(plan.validation.errors === 0,
    `合并后镜头编译无 error（实得 ${JSON.stringify(plan.validation.shots[0].issues)}）`);

  const again = planJson(first);
  ok(again.batchPlanId === batchPlanId, "同一输入重复出计划得到同一 batchPlanId");

  const repriced = snapshot() as { profiles: Array<Record<string, any>> };
  const body = { ...repriced.profiles[0] };
  delete (body as Record<string, unknown>).profileDigest;
  body.priceTable = { ...PRICE_TABLE, microsPerOutputSecond: 860_000 };
  repriced.profiles[0] = { ...body, profileDigest: productionCanonicalJsonSha256(body) };
  writeFileSync(join(first.root, "runtime", "profiles", "snapshot.json"), JSON.stringify(repriced, null, 2) + "\n", { mode: 0o600 });
  ok(planJson(first).batchPlanId !== batchPlanId, "价目变化即 batchPlanId 失效（策略进入 policyDigest）");
  writeFileSync(join(first.root, "runtime", "profiles", "snapshot.json"), JSON.stringify(snapshot(), null, 2) + "\n", { mode: 0o600 });

  const changed = batchRequest() as { script: { mergedPatches: Array<Record<string, any>> } };
  changed.script.mergedPatches[0].prompt.text = "改写后的 prompt 文本，用于验证批次指纹随输入变化。";
  writeFileSync(join(first.root, "batch-2.json"), JSON.stringify(changed, null, 2) + "\n");
  const changedPlan = JSON.parse(capture([
    "plan-shots", "--project", "demo", "--input", join(first.root, "batch-2.json"),
    "--config", first.configFile, "--plan", "--json",
  ], first.root).out) as Record<string, any>;
  ok(changedPlan.batchPlanId !== batchPlanId, "镜头输入变化即 batchPlanId 失效");

  // 视觉侧的表进入 policyDigest：改一条灯光映射即失效。
  writeFileSync(join(first.repo, "visual", "mappings.v1.json"), JSON.stringify({
    ...MAPPINGS, lighting: [{ sceneId: "S08", timeOfDay: "day", lightingStateId: "LIGHT_DUSK" }],
  }, null, 2) + "\n");
  ok(planJson(first).batchPlanId !== batchPlanId, "mappings 变化即 batchPlanId 失效（视觉侧表进入 policyDigest）");
  writeFileSync(join(first.repo, "visual", "mappings.v1.json"), JSON.stringify(MAPPINGS, null, 2) + "\n");

  const beforeReject = treeSnapshot(first.root);
  const rejected = capture(planArgs(first, ["--confirm", "f".repeat(64)]), first.root);
  ok(rejected.code === 1 && rejected.err.includes("确认指纹不匹配")
    && treeSnapshot(first.root) === beforeReject,
  "错误 batchPlanId 的 --confirm 被拒且零写入");

  const mismatched = capture(planArgs(first, ["--plan", "--from-script", "2"]), first.root);
  ok(mismatched.code === 1 && mismatched.err.includes("script.episode"),
    "--from-script 与 --input 的集号不一致时拒绝");
  ok(planJson(first, ["--from-script", "1", "--scene", "1"]).batchPlanId === batchPlanId,
    "--from-script 1 --scene 1 与文档一致时得到同一计划");
} finally {
  rmSync(first.root, { recursive: true, force: true });
}

// —— 视觉侧默认值：mappings 填灯光/陈设、候选图 shotIds 填首帧 ——
{
  const noFirstFrame = batchRequest() as { script: { mergedPatches: Array<Record<string, any>> } };
  delete noFirstFrame.script.mergedPatches[0].continuity;
  const fixture = makeWorkspace({ visualCandidate: CANDIDATE(), request: noFirstFrame });
  try {
    const plan = planJson(fixture);
    ok(plan.validation.errors === 0 && plan.blocked === false,
      `候选图自动填首帧后编译通过（实得 ${JSON.stringify(plan.validation.shots[0].issues)}）`);
    const confirmed = capture(planArgs(fixture, ["--confirm", plan.batchPlanId, "--json"]), fixture.root);
    const shot = (JSON.parse(confirmed.out) as Record<string, any>).shots[0];
    const shotRequest = JSON.parse(
      readProductionCasObject(fixture.root, "demo", shot.shotRequestSha256)!.toString("utf8"),
    ) as Record<string, any>;
    ok(shotRequest.continuity.firstFrame.origin.kind === "approved-candidate"
      && shotRequest.continuity.firstFrame.origin.candidateId === "K_S08_EST"
      && shotRequest.continuity.firstFrame.containsRealFace === false,
    "候选图 shotIds 排到本镜时自动填 approved-candidate 首帧并带上 containsRealFace");
    ok(shotRequest.scene.lightingStateId === "LIGHT_DAY" && shotRequest.scene.dressingVariantId === "DRESS_BASE",
      "mappings 按 (sceneId, timeOfDay) 与 (sceneId, arcId) 填灯光与陈设");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }

  // 人工已写死首帧时不覆盖：patch 优先于表查。
  const withOperatorFrame = makeWorkspace({ visualCandidate: CANDIDATE() });
  try {
    const plan = planJson(withOperatorFrame);
    const confirmed = capture(planArgs(withOperatorFrame, ["--confirm", plan.batchPlanId, "--json"]), withOperatorFrame.root);
    const shot = (JSON.parse(confirmed.out) as Record<string, any>).shots[0];
    const shotRequest = JSON.parse(
      readProductionCasObject(withOperatorFrame.root, "demo", shot.shotRequestSha256)!.toString("utf8"),
    ) as Record<string, any>;
    ok(shotRequest.continuity.firstFrame.origin.kind === "operator-upload",
      "draft 已显式给出首帧时不被候选图覆盖");
  } finally { rmSync(withOperatorFrame.root, { recursive: true, force: true }); }

  // 尚未批准的候选图不填首帧，只记 warning——批准是并行人工轨道。
  const pending = batchRequest() as { script: { mergedPatches: Array<Record<string, any>> } };
  delete pending.script.mergedPatches[0].continuity;
  const pendingFixture = makeWorkspace({
    request: pending,
    visualCandidate: CANDIDATE({ status: "candidate", reviewedBy: null, reviewedAt: null }),
  });
  try {
    const plan = planJson(pendingFixture);
    const issues = plan.validation.shots[0].issues as Array<Record<string, string>>;
    ok(issues.some((issue) => issue.source === "visual" && issue.code === "candidate-not-approved"),
      "候选图尚未批准时记 warning 而不填首帧");
    ok(plan.validation.warnings >= 1, "视觉侧 warning 计入 validation.warnings");
  } finally { rmSync(pendingFixture.root, { recursive: true, force: true }); }

  // 已排期但被显式指为 approved-candidate 且未批准 → 编译 error，整批阻断。
  const notApproved = batchRequest() as { script: { mergedPatches: Array<Record<string, any>> } };
  notApproved.script.mergedPatches[0].continuity = {
    firstFrame: {
      asset: visualAsset(SHA.three),
      origin: { kind: "approved-candidate", candidateId: "K_S08_EST" },
      containsRealFace: false,
    },
  };
  const blockedFixture = makeWorkspace({
    request: notApproved,
    visualCandidate: CANDIDATE({ status: "candidate", reviewedBy: null, reviewedAt: null }),
  });
  try {
    const planned = capture(planArgs(blockedFixture, ["--plan", "--json"]), blockedFixture.root);
    const plan = JSON.parse(planned.out) as Record<string, any>;
    const codes = (plan.validation.shots[0].issues as Array<Record<string, string>>).map((issue) => issue.code);
    ok(planned.code === 1 && plan.blocked === true && codes.includes("keyframe_not_approved"),
      `未批准候选图作首帧时 --plan 退出 1 且标 blocked（实得 ${codes.join(",")}）`);
    ok(plan.shots[0].planId === null && plan.shots[0].shotRequestSha256 === null,
      "被阻断的镜头不产出 planId 与 ShotRequest digest");
    const confirmed = capture(planArgs(blockedFixture, ["--confirm", plan.batchPlanId]), blockedFixture.root);
    ok(confirmed.code === 1 && confirmed.err.includes("error 级校验问题"),
      "带 error 的批次 --confirm 硬拒");
  } finally { rmSync(blockedFixture.root, { recursive: true, force: true }); }
}

// —— 预填与合并的 warnings 进入计划 ——
{
  // 该语料只有一条 ▲ 行：对白落在它之前，预填把对白归入本场第一镜并记 warning。
  const early = batchRequest() as { script: Record<string, any> };
  early.script.patches = [{
    shotId: "EP001-S1-1", camera: clone(CAMERA), scene: { dressingVariantId: "DRESS_BASE" },
  }];
  const fixture = makeWorkspace({ episode: EP001_EARLY_DIALOGUE, request: early });
  try {
    const plan = planJson(fixture);
    const issues = plan.validation.shots[0].issues as Array<Record<string, string>>;
    ok(issues.some((issue) => issue.source === "prefill" && issue.code === "dialogue-before-first-action"),
      "首个动作行之前的对白记为 prefill warning 并进入计划");
    ok(plan.validation.warnings >= 1, "预填 warning 计入 validation.warnings");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }

  // 合并 warning：两镜 cast 的 characterId / appearanceStateId 相同但 performNotes 不同。
  const castConflict = batchRequest() as { script: Record<string, any> };
  const member = (performNotes: string) => ({
    characterId: "C02", name: "谢蘅秋", appearanceStateId: "APPEARANCE_LATE", voiceId: null,
    onScreen: true, performNotes, stage: null,
  });
  castConflict.script.patches = [1, 2, 3, 4].map((index) => ({
    shotId: `EP001-S1-${index}`,
    camera: clone(CAMERA),
    scene: { dressingVariantId: "DRESS_BASE" },
    cast: [member(index === 1 ? "背影，缓步" : "背影，停住")],
  }));
  const fixture2 = makeWorkspace({ request: castConflict });
  try {
    const plan = planJson(fixture2);
    const issues = plan.validation.shots[0].issues as Array<Record<string, string>>;
    ok(issues.some((issue) => issue.source === "merge"),
      `合并丢弃的 cast 差异记为 merge warning（实得 ${issues.map((row) => row.source + "/" + row.code).join(",")}）`);
  } finally { rmSync(fixture2.root, { recursive: true, force: true }); }
}

// —— 选档：先按输出形状收敛，再按时长网格上取整 ——
{
  const landscape = snapshotEntry({
    profileId: LANDSCAPE_PROFILE_ID,
    execution: execution({ profileId: LANDSCAPE_PROFILE_ID, aspectRatio: "16:9", durationSeconds: 5 }),
    durationGrid: [5],
  });
  const both = snapshotOf([snapshotEntry(), landscape]);
  const withBoth = capability({
    limitsByModelId: {
      [PROFILE_ID]: limits(),
      [LANDSCAPE_PROFILE_ID]: limits({
        aspectRatios: ["16:9"],
        durationSeconds: { min: 5, max: 5, grid: [5], gridByResolution: null },
      }),
    },
  });
  const portrait = makeWorkspace({
    snapshotDoc: both,
    request: batchRequest({ capability: withBoth }),
  });
  try {
    const plan = planJson(portrait);
    ok(plan.decisions[0].profileId === PROFILE_ID,
      `9:16 镜头选到 9:16 的档（实得 ${plan.decisions[0].profileId}）`);
  } finally { rmSync(portrait.root, { recursive: true, force: true }); }

  const landscapeOptions = clone(SCRIPT_OPTIONS) as Record<string, any>;
  landscapeOptions.output.aspectRatio = "16:9";
  const landscapeRequest = batchRequest({ capability: withBoth }) as { script: Record<string, any> };
  landscapeRequest.script.options = landscapeOptions;
  // 16:9 的档只有 5 s：四条 2 s 的 ▲ 行按该上界合并成两镜（1+2、3+4），两镜都要补 prompt。
  landscapeRequest.script.mergedPatches = ["EP001-S1-1", "EP001-S1-3"].map((shotId) => ({
    shotId,
    continuity: { firstFrame: clone(OPERATOR_FIRST_FRAME) },
    prompt: clone(PROMPT_PATCH),
  }));
  const landscapeFixture = makeWorkspace({ snapshotDoc: both, request: landscapeRequest });
  try {
    const plan = planJson(landscapeFixture);
    ok(plan.decisions.every((row: Record<string, unknown>) => row.profileId === LANDSCAPE_PROFILE_ID),
      `16:9 镜头选到 16:9 的档（实得 ${plan.decisions.map((row: Record<string, string>) => row.profileId).join(",")}）`);
    ok(plan.decisions[0].durationSeconds === 5, "选档只在同一输出形状的时长网格内取整");
  } finally { rmSync(landscapeFixture.root, { recursive: true, force: true }); }

  // 快照含多个后端而请求未声明目标后端时拒绝。
  const otherBackend = snapshotEntry({
    profileId: "h3-other",
    execution: execution({ profileId: "h3-other", backendInstanceId: "gateway-other" }),
  });
  const ambiguous = makeWorkspace({
    snapshotDoc: snapshotOf([snapshotEntry(), otherBackend]),
    request: batchRequest({ backendInstanceId: null, capability: null }),
  });
  try {
    const result = capture(planArgs(ambiguous, ["--plan"]), ambiguous.root);
    ok(result.code === 1 && result.err.includes("必须显式声明目标后端"),
      "快照含多个后端而请求未声明时拒绝出计划");
  } finally { rmSync(ambiguous.root, { recursive: true, force: true }); }
}

// —— 快照与 capability 的一致性（多地域、limits） ——
{
  const multi = makeWorkspace({
    snapshotDoc: snapshot({ processingRegions: ["CN", "SG"] }),
    request: batchRequest({ capability: capability({ processingRegions: ["SG", "CN"] }) }),
  });
  try {
    // 后端在两个地域处理素材，项目必须同时允许这两个，否则挡在 processing_region_not_allowed 上。
    const config = runtimeConfig("demo");
    ((config.projects as Array<Record<string, unknown>>)[0]!).allowedProcessingRegions = ["CN", "SG"];
    writeFileSync(multi.configFile, JSON.stringify(config, null, 2) + "\n");
    chmodSync(multi.configFile, 0o600);
    const planned = capture(planArgs(multi, ["--plan", "--json"]), multi.root);
    ok(planned.code === 0,
      `多地域 profile 与顺序不同的 capability 视为一致（实得 ${planned.code}；${planned.err}）`);
  } finally { rmSync(multi.root, { recursive: true, force: true }); }

  const disagree = makeWorkspace({
    snapshotDoc: snapshot({ processingRegions: ["CN", "SG"] }),
    request: batchRequest({ capability: capability({ processingRegions: ["CN"] }) }),
  });
  try {
    const result = capture(planArgs(disagree, ["--plan"]), disagree.root);
    ok(result.code === 1 && result.err.includes("processingRegions"),
      "快照与 capability 的地域集合真正不同时拒绝出计划");
  } finally { rmSync(disagree.root, { recursive: true, force: true }); }

  // 快照带 limits 时可以完全不给 capability（Phase 1b 形态）。
  const snapshotLimits = makeWorkspace({
    snapshotDoc: snapshot({ limits: limits() }),
    request: batchRequest({ capability: null }),
  });
  try {
    const planned = capture(planArgs(snapshotLimits, ["--plan", "--json"]), snapshotLimits.root);
    ok(planned.code === 0, `快照带 limits 时无需批次 capability（实得 ${planned.code}；${planned.err}）`);
  } finally { rmSync(snapshotLimits.root, { recursive: true, force: true }); }

  const noLimits = makeWorkspace({ request: batchRequest({ capability: null }) });
  try {
    const result = capture(planArgs(noLimits, ["--plan"]), noLimits.root);
    ok(result.code === 1 && result.err.includes("没有可用的能力上限"),
      "快照不带 limits 且请求不给 capability 时拒绝出计划");
  } finally { rmSync(noLimits.root, { recursive: true, force: true }); }

  const conflicting = makeWorkspace({
    snapshotDoc: snapshot({ limits: limits({ maxReferenceImages: 4 }) }),
    request: batchRequest(),
  });
  try {
    const result = capture(planArgs(conflicting, ["--plan"]), conflicting.root);
    ok(result.code === 1 && result.err.includes("快照 limits 与 capability"),
      "快照 limits 与请求 capability 冲突时拒绝出计划");
  } finally { rmSync(conflicting.root, { recursive: true, force: true }); }
}

// —— 快照读取纪律 ——
{
  const permissive = makeWorkspace();
  try {
    chmodSync(join(permissive.root, "runtime", "profiles", "snapshot.json"), 0o644);
    const result = capture(planArgs(permissive, ["--plan"]), permissive.root);
    ok(result.code === 1 && result.err.includes("0400/0600"),
      "快照 mode 0644 时拒绝读取（与 runtime config / pinned graph 同一纪律）");
  } finally { rmSync(permissive.root, { recursive: true, force: true }); }

  const linked = makeWorkspace();
  try {
    const runtime = join(linked.root, "runtime");
    renameSync(join(runtime, "profiles"), join(runtime, "profiles-real"));
    symlinkSync(join(runtime, "profiles-real"), join(runtime, "profiles"));
    const result = capture(planArgs(linked, ["--plan"]), linked.root);
    ok(result.code === 1 && result.err.includes("symlink"),
      "快照路径含 symlink component 时拒绝读取");
  } finally { rmSync(linked.root, { recursive: true, force: true }); }
}

// —— confirm：CAS 写入、inputs[0] 一致、幂等重放、损坏恢复 ——
const second = makeWorkspace();
try {
  const plan = planJson(second);
  const confirmed = capture(planArgs(second, ["--confirm", plan.batchPlanId, "--json"]), second.root);
  ok(confirmed.code === 0, `--confirm 退出 0（实得 ${confirmed.code}；${confirmed.err}）`);
  const result = JSON.parse(confirmed.out) as Record<string, any>;
  const shot = result.shots[0];
  ok(shot.casObjectCreated === true && shot.intentCreated === true && shot.taskCreated === true
    && shot.dispatchApplied === true && shot.status === "dispatch-pending",
  "--confirm 按 CAS → intent → task → dispatch-requested 顺序发布");

  const casFile = productionCasObjectPath(second.root, "demo", shot.shotRequestSha256);
  ok(existsSync(casFile) && casFile.endsWith(`/production-cas.v1/sha256/${shot.shotRequestSha256}`),
    "ShotRequest 以 sha256 为文件名写入 workspace CAS");
  const bytes = readProductionCasObject(second.root, "demo", shot.shotRequestSha256)!;
  const intent = readProductionIntent(second.root, "demo", shot.taskId)!;
  ok(intent.inputs[0].sha256 === shot.shotRequestSha256
    && intent.inputs[0].byteLength === bytes.length
    && intent.inputs[0].uri === `cas://wl-sg/sha256/${shot.shotRequestSha256}`
    && intent.inputs[0].mediaType === "application/vnd.writing-loop.shot-request+json",
  "intent inputs[0] 的 AssetRef 与 CAS 对象逐字段一致");
  ok(JSON.parse(bytes.toString("utf8")).shotId === "EP001-S1-1",
    "CAS 对象就是该镜的 canonical ShotRequest");
  ok(readdirSync(join(second.root, ".writing-loop", "demo", "production-cas.v1", "sha256"))
    .every((name) => /^[a-f0-9]{64}$/.test(name)),
  "发布后 CAS 目录只剩内容寻址对象，无临时文件残留");

  const replay = capture(planArgs(second, ["--confirm", plan.batchPlanId, "--json"]), second.root);
  const replayShot = (JSON.parse(replay.out) as Record<string, any>).shots[0];
  ok(replay.code === 0 && replayShot.casObjectCreated === false && replayShot.intentCreated === false
    && replayShot.taskCreated === false,
  "同一 batchPlanId 精确重放是幂等的：不重复写 CAS/intent/task");
} finally {
  rmSync(second.root, { recursive: true, force: true });
}

// 崩溃残留：最终路径上有截断文件时报可操作错误，而不是覆盖、也不是永久卡死
{
  const casFixture = makeWorkspace();
  try {
    const plan = planJson(casFixture);
    const digest = plan.shots[0].shotRequestSha256 as string;
    const casDir = join(casFixture.root, ".writing-loop", "demo", "production-cas.v1", "sha256");
    mkdirSync(casDir, { recursive: true });
    writeFileSync(join(casDir, digest), "{ truncated", { mode: 0o600 });
    const result = capture(planArgs(casFixture, ["--confirm", plan.batchPlanId]), casFixture.root);
    ok(result.code === 1 && result.err.includes("与对象名不一致") && result.err.includes("删除该文件再重试"),
      "CAS 最终路径残留截断文件时报可操作错误（不覆盖）");
  } finally { rmSync(casFixture.root, { recursive: true, force: true }); }

  const intentFixture = makeWorkspace();
  try {
    const plan = planJson(intentFixture);
    const taskId = plan.shots[0].taskId as string;
    const intentDir = join(intentFixture.root, ".writing-loop", "demo", "production-intents.v1");
    mkdirSync(intentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(intentDir, `${taskId}.json`), "{ truncated", { mode: 0o600 });
    const result = capture(planArgs(intentFixture, ["--confirm", plan.batchPlanId]), intentFixture.root);
    ok(result.code === 1 && result.err.includes("删除该文件再重试"),
      "intent companion 残留截断文件时报可操作错误（不覆盖）");
    ok(productionIntentPath(intentFixture.root, "demo", taskId).endsWith(`${taskId}.json`),
      "intent companion 路径仍由 taskId 决定");
  } finally { rmSync(intentFixture.root, { recursive: true, force: true }); }
}

// —— 承接链波次 ——
{
  const shotDraft = (index: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 1,
    kind: "writing-loop/shot-request-draft",
    shotId: `EP001-S1-${index}`,
    subject: {
      version: 1,
      episode: { version: 1, episodeId: "ep-001", revision: 1, source: asset(SHA.e, "text/markdown", 8_192) },
      shotId: `EP001-S1-${index}`,
      revision: 1,
      source: asset(SHA.e, "text/markdown", 8_192),
    },
    provenance: {
      storyDesignSha256: SHA.f, assetsRevision: 12, visualProductionSha256: null,
      beatCardHash: "8137791889ad", scriptLine: 10 + index, mergedScriptLines: [],
    },
    scene: {
      sceneId: "S08", subscene: null, timeOfDay: "day", interior: "ext",
      lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE",
    },
    camera: clone(CAMERA),
    cast: [],
    props: [],
    crowd: null,
    action: `城楼门洞第 ${index} 镜。`,
    productionTags: [],
    dialogue: [],
    output: { aspectRatio: "9:16", generateAudio: true, storyboardDurationSeconds: 8, fps: 24, seed: 4_242 },
    continuity: {
      stageGroup: "EP001-S1",
      prevShotId: null,
      firstFrame: clone(OPERATOR_FIRST_FRAME),
      lastFrame: null,
      references: [],
      referencePolicy: "trim_by_priority",
      spatialPasses: [],
    },
    prompt: clone(PROMPT_PATCH),
    ...over,
  });
  const carryFrom = (shotId: string, taskId: string) => ({
    asset: asset(SHA.two),
    origin: { kind: "previous-shot-last-frame", shotId, taskId },
    containsRealFace: false,
  });

  const chained = batchRequest({
    script: null,
    shots: [
      shotDraft(1),
      shotDraft(2, {
        continuity: {
          stageGroup: "EP001-S1", prevShotId: "EP001-S1-1",
          firstFrame: carryFrom("EP001-S1-1", "take-EP001-S1-1"),
          lastFrame: null, references: [], referencePolicy: "trim_by_priority", spatialPasses: [],
        },
      }),
    ],
  });
  const chainFixture = makeWorkspace({ request: chained });
  try {
    const plan = planJson(chainFixture);
    ok(plan.waves.length === 2 && plan.waves[0].shotIds.join(",") === "EP001-S1-1"
      && plan.waves[1].shotIds.join(",") === "EP001-S1-2",
    `承接链把依赖镜排到后一波（实得 ${JSON.stringify(plan.waves)}）`);
  } finally { rmSync(chainFixture.root, { recursive: true, force: true }); }

  const cyclic = batchRequest({
    script: null,
    shots: [
      shotDraft(1, {
        continuity: {
          stageGroup: "EP001-S1", prevShotId: null,
          firstFrame: carryFrom("EP001-S1-2", "take-EP001-S1-2"),
          lastFrame: null, references: [], referencePolicy: "trim_by_priority", spatialPasses: [],
        },
      }),
      shotDraft(2, {
        continuity: {
          stageGroup: "EP001-S1", prevShotId: null,
          firstFrame: carryFrom("EP001-S1-1", "take-EP001-S1-1"),
          lastFrame: null, references: [], referencePolicy: "trim_by_priority", spatialPasses: [],
        },
      }),
    ],
  });
  const cycleFixture = makeWorkspace({ request: cyclic });
  try {
    const result = capture(planArgs(cycleFixture, ["--plan"]), cycleFixture.root);
    ok(result.code === 1 && result.err.includes("环形依赖"), "承接链互相依赖时拒绝出计划");
  } finally { rmSync(cycleFixture.root, { recursive: true, force: true }); }
}

// —— 样片门：phase bulk ——
const third = makeWorkspace();
try {
  const bulk = batchRequest({ phase: "bulk", samplePolicy: { sampleShotIds: ["EP001-S1-1"] } });
  const bulkFile = join(third.root, "bulk.json");
  writeFileSync(bulkFile, JSON.stringify(bulk, null, 2) + "\n");
  const bulkArgs = (extra: string[]): string[] => [
    "plan-shots", "--project", "demo", "--input", bulkFile, "--config", third.configFile, ...extra,
  ];
  const bulkPlan = JSON.parse(capture(bulkArgs(["--plan", "--json"]), third.root).out) as Record<string, any>;
  const blocked = capture(bulkArgs(["--confirm", bulkPlan.batchPlanId]), third.root);
  ok(blocked.code === 1 && blocked.err.includes("样片门") && blocked.err.includes("尚未入库")
    && blocked.err.includes("taskIdPrefix"),
  "phase: bulk 在样片 task 尚未入库时拒绝提交，并提示前缀必须一致");

  const samplePlan = planJson(third);
  capture(planArgs(third, ["--confirm", samplePlan.batchPlanId, "--json"]), third.root);
  const taskId = samplePlan.shots[0].taskId as string;

  const stillBlocked = capture(bulkArgs(["--confirm", bulkPlan.batchPlanId]), third.root);
  ok(stillBlocked.code === 1 && stillBlocked.err.includes("dispatch-pending"),
    "样片 task 尚未 approved 时 bulk 仍被拒（非 approved 与缺失同样阻断）");

  const store = new ProductionStore(third.root, WORKSPACE_ID, "demo");
  const takeAsset = {
    version: 1, uri: "urn:sha256:" + SHA.two, sha256: SHA.two, byteLength: 4_096, mediaType: "video/mp4",
  };
  let task = store.read().tasks.find((row) => row.id === taskId)!;
  for (const event of [
    { type: "submission-started", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "11111111-1111-4111-8111-111111111111", requestDigest: SHA.a },
    { type: "submission-confirmed", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "11111111-1111-4111-8111-111111111111" },
    { type: "remote-started", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "11111111-1111-4111-8111-111111111111" },
    { type: "ingestion-started" },
    { type: "qc-requested", assets: [takeAsset], cost: { version: 1, state: "unknown", reason: "provider-not-reported" } },
  ] as Array<Record<string, unknown>>) {
    task = store.apply(parseProductionTaskEvent({
      version: 1,
      eventId: `fixture:${String(event.type)}:${taskId}`,
      taskId,
      expectedRevision: task.revision,
      occurredAt: new Date(Date.parse(AT) + task.revision * 1_000).toISOString(),
      ...event,
    })).task;
  }
  ok(task.status === "qc-pending", `样片 fixture 推进到 qc-pending（实得 ${task.status}）`);

  const approved = capture(["qc", "--approve", "--project", "demo", "--task", taskId, "--by", "qc:lead", "--json"], third.root);
  ok(approved.code === 0, `production qc --approve 退出 0（实得 ${approved.code}；${approved.err}）`);
  const approvedTask = JSON.parse(approved.out) as Record<string, any>;
  ok(approvedTask.status === "approved" && approvedTask.approval.decidedBy === "qc:lead"
    && approvedTask.approval.taskRevision === approvedTask.revision - 1,
  "approved 事件写入且 approval.taskRevision = revision - 1");

  const again = capture(["qc", "--approve", "--project", "demo", "--task", taskId, "--by", "qc:lead"], third.root);
  ok(again.code === 1 && again.err.includes("只有 qc-pending"),
    "非 qc-pending 的 task 拒绝再次裁决（终态不可追加）");

  const passed = capture(bulkArgs(["--confirm", bulkPlan.batchPlanId, "--json"]), third.root);
  ok(passed.code === 0, `样片 approved 后 bulk 放行（实得 ${passed.code}；${passed.err}）`);

  const otherPrefix = batchRequest({
    phase: "bulk", taskIdPrefix: "shot", samplePolicy: { sampleShotIds: ["EP001-S1-1"] },
  });
  const otherFile = join(third.root, "bulk-other-prefix.json");
  writeFileSync(otherFile, JSON.stringify(otherPrefix, null, 2) + "\n");
  const otherPlan = JSON.parse(capture([
    "plan-shots", "--project", "demo", "--input", otherFile, "--config", third.configFile, "--plan", "--json",
  ], third.root).out) as Record<string, any>;
  const wrongPrefix = capture([
    "plan-shots", "--project", "demo", "--input", otherFile, "--config", third.configFile,
    "--confirm", otherPlan.batchPlanId,
  ], third.root);
  ok(wrongPrefix.code === 1 && wrongPrefix.err.includes("shot-EP001-S1-1 尚未入库"),
    "bulk 换了 taskIdPrefix 时样片门找不到样片并阻断");
} finally {
  rmSync(third.root, { recursive: true, force: true });
}

// —— QC 拒绝路径与参数校验 ——
const fourth = makeWorkspace();
try {
  const plan = planJson(fourth);
  capture(planArgs(fourth, ["--confirm", plan.batchPlanId, "--json"]), fourth.root);
  const taskId = plan.shots[0].taskId as string;
  const noNote = capture(["qc", "--reject", "--project", "demo", "--task", taskId, "--by", "qc:lead"], fourth.root);
  ok(noNote.code === 2 && noNote.err.includes("--note"), "--reject 必须给出 --note 原因");
  const wrongStage = capture([
    "qc", "--reject", "--project", "demo", "--task", taskId, "--by", "qc:lead", "--note", "构图不符",
  ], fourth.root);
  ok(wrongStage.code === 1 && wrongStage.err.includes("dispatch-pending"),
    "dispatch-pending 阶段的 task 拒绝 QC 裁决");

  const store = new ProductionStore(fourth.root, WORKSPACE_ID, "demo");
  let task = store.read().tasks.find((row) => row.id === taskId)!;
  const takeAsset = {
    version: 1, uri: "urn:sha256:" + SHA.two, sha256: SHA.two, byteLength: 4_096, mediaType: "video/mp4",
  };
  for (const event of [
    { type: "submission-started", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "22222222-2222-4222-8222-222222222222", requestDigest: SHA.a },
    { type: "submission-confirmed", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "22222222-2222-4222-8222-222222222222" },
    { type: "remote-started", backendInstanceId: "gateway-h3-fl2va", remoteJobId: "22222222-2222-4222-8222-222222222222" },
    { type: "ingestion-started" },
    { type: "qc-requested", assets: [takeAsset], cost: { version: 1, state: "unknown", reason: "provider-not-reported" } },
  ] as Array<Record<string, unknown>>) {
    task = store.apply(parseProductionTaskEvent({
      version: 1,
      eventId: `fixture:${String(event.type)}:${taskId}`,
      taskId,
      expectedRevision: task.revision,
      occurredAt: new Date(Date.parse(AT) + task.revision * 1_000).toISOString(),
      ...event,
    })).task;
  }
  const rejected = capture([
    "qc", "--reject", "--project", "demo", "--task", taskId, "--by", "qc:lead", "--note", "尾帧穿帮", "--json",
  ], fourth.root);
  const rejectedTask = JSON.parse(rejected.out) as Record<string, any>;
  ok(rejected.code === 0 && rejectedTask.status === "rejected"
    && rejectedTask.approval.note === "尾帧穿帮"
    && rejectedTask.approval.taskRevision === rejectedTask.revision - 1,
  "rejected 事件写入原因并绑定审批前的 qc revision");
  ok(readProductionState(fourth.root, WORKSPACE_ID, "demo").tasks[0]?.status === "rejected",
    "裁决结果落进本地权威账本");
} finally {
  rmSync(fourth.root, { recursive: true, force: true });
}

// —— gate context 供给（§4.7） ——
const gateFixture = makeWorkspace();
try {
  cpSync(
    join(import.meta.dirname, "..", "examples", "production", "representative-h3", "workflows"),
    join(gateFixture.root, "runtime", "workflows"),
    { recursive: true },
  );
  // pinned graph 与 runtime config 同一读取纪律：owner-only 0600 普通文件。
  chmodSync(join(gateFixture.root, "runtime", "workflows", "h3-fl2va-portrait.json"), 0o600);
  const plan = planJson(gateFixture);
  capture(planArgs(gateFixture, ["--confirm", plan.batchPlanId, "--json"]), gateFixture.root);
  const intent = readProductionIntent(gateFixture.root, "demo", plan.shots[0].taskId as string)!;

  // gate context 的 backendProcessingRegions 来自 gateway 的 capabilities 路由（§4.3、§8.6）：
  // 用 fake 后端服务它，两个用例分别观察「后端未声明地域」与「后端声明了项目允许的地域」。
  let declaredRegions: readonly string[] = [];
  let capabilityCalls = 0;
  const capabilityFetch = async (input: string | URL | Request): Promise<Response> => {
    if (!new URL(input.toString()).pathname.endsWith("/capabilities")) {
      throw new Error("gate context 只应读 capabilities 路由");
    }
    capabilityCalls++;
    return new Response(JSON.stringify({
      version: 1,
      scope: { version: 1, workspaceId: WORKSPACE_ID, project: "demo" },
      capabilities: {
        backendKind: "comfyui",
        backendInstanceId: "gateway-h3-fl2va",
        modelFamilies: ["minimax-h3"],
        processingRegions: [...declaredRegions],
        asynchronous: true,
        clientAssignedJobId: true,
        providerJobIdMapping: "none",
        inspectById: true,
        progressHints: "optional-websocket",
        pendingCancellation: "best-effort",
        runningCancellation: "version-gated-best-effort",
        providerIdempotency: false,
        inputModes: ["image-upload"],
        outputModes: ["download"],
        limitsByModelId: {},
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const registry = createProductionRuntimeRegistry({
    root: gateFixture.root,
    configFile: gateFixture.configFile,
    env: { WRITING_LOOP_GATEWAY_TOKEN: "t".repeat(32) },
    fetchByBackend: { "gateway-h3-fl2va": capabilityFetch },
  });
  const gate = await registry.projects[0]!.gateContextResolver.resolve(
    intent,
    {} as Parameters<typeof registry.projects[0]["gateContextResolver"]["resolve"]>[1],
  );
  ok(gate.allowedProcessingRegions?.join(",") === "CN"
    && gate.licenseCompliance?.annualRevenueUsdBelow === 1_000_000
    && gate.licenseCompliance?.attributionSurfaces.join(",") === "片尾字幕",
  "gate context 的 allowedProcessingRegions / licenseCompliance 来自 runtime projects[]");
  ok(gate.realFaceInputs === "absent",
    `realFaceInputs 由 inputs[0] 的 ShotRequest 汇总（实得 ${gate.realFaceInputs}）`);
  // 后端未声明处理地域时空集合即 fail-closed：gate 真的因为「后端地域未声明」而 deny，且只 deny 这一项。
  const decision = evaluateProductionIntentGates(intent, gate);
  const codes = decision.failures.map((failure) => failure.code).join(",");
  ok(!decision.allowed && codes === "processing-region-not-allowed"
    && gate.backendProcessingRegions?.length === 0,
  `后端地域未声明时 gate 恰以 processing-region-not-allowed deny（实得 ${codes || "allowed"}）`);

  // 后端声明了项目允许的地域后，同一 intent 的地域门不再 deny。
  declaredRegions = ["CN"];
  const allowedRegistry = createProductionRuntimeRegistry({
    root: gateFixture.root,
    configFile: gateFixture.configFile,
    env: { WRITING_LOOP_GATEWAY_TOKEN: "t".repeat(32) },
    fetchByBackend: { "gateway-h3-fl2va": capabilityFetch },
  });
  const allowedGate = await allowedRegistry.projects[0]!.gateContextResolver.resolve(
    intent,
    {} as Parameters<typeof registry.projects[0]["gateContextResolver"]["resolve"]>[1],
  );
  const allowedCodes = evaluateProductionIntentGates(intent, allowedGate)
    .failures.map((failure) => failure.code);
  ok(allowedGate.backendProcessingRegions?.join(",") === "CN"
    && !allowedCodes.includes("processing-region-not-allowed"),
  `后端声明项目允许的处理地域后该门通过（实得 ${allowedCodes.join(",") || "allowed"}）`);

  // 同一 registry 内按 backendInstanceId 缓存：逐个 intent 评估 gate 不会重复取 capability。
  const callsBefore = capabilityCalls;
  await allowedRegistry.projects[0]!.gateContextResolver.resolve(
    intent,
    {} as Parameters<typeof registry.projects[0]["gateContextResolver"]["resolve"]>[1],
  );
  ok(capabilityCalls === callsBefore,
    "gate context 按 backendInstanceId 缓存 capability，一轮内每个后端只取一次");

  const bare = await registry.projects[0]!.gateContextResolver.resolve(
    { ...intent, inputs: [intent.inputs[1]!] },
    {} as Parameters<typeof registry.projects[0]["gateContextResolver"]["resolve"]>[1],
  );
  ok(bare.realFaceInputs === "undeclared", "inputs[0] 不是 ShotRequest 时 realFaceInputs 为 undeclared");
} finally {
  rmSync(gateFixture.root, { recursive: true, force: true });
}

// —— 快照与 runtime config 不同步时拒绝出计划 ——
const fifth = makeWorkspace();
try {
  const drifted = runtimeConfig("demo");
  (drifted.workflows as Array<Record<string, unknown>>)[0].workflowSha256 = "9".repeat(64);
  ((drifted.stagingProfiles as Array<Record<string, unknown>>)[0].execution as Record<string, unknown>).workflowSha256 = "9".repeat(64);
  writeFileSync(fifth.configFile, JSON.stringify(drifted, null, 2) + "\n");
  chmodSync(fifth.configFile, 0o600);
  const result = capture(planArgs(fifth, ["--plan"]), fifth.root);
  ok(result.code === 1 && result.err.includes("已授权的 workflows"),
    "快照 profile 的 workflowSha256 不在 runtime config 授权集合内时拒绝出计划");

  const noSnapshot = runtimeConfig("demo");
  delete noSnapshot.executionProfileSnapshotFile;
  writeFileSync(fifth.configFile, JSON.stringify(noSnapshot, null, 2) + "\n");
  chmodSync(fifth.configFile, 0o600);
  const missing = capture(planArgs(fifth, ["--plan"]), fifth.root);
  ok(missing.code === 1 && missing.err.includes("executionProfileSnapshotFile"),
    "runtime config 未声明快照路径时拒绝出计划");
} finally {
  rmSync(fifth.root, { recursive: true, force: true });
}

console.log(fails === 0 ? "OK" : `${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
