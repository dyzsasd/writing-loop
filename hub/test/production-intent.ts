// Phase 3B immutable intent/parser/gate/companion regression suite.
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionError, type AssetRef } from "../src/production-domain.ts";
import {
  EU_MEMBER_TERRITORIES,
  H3_ASPECT_RATIOS,
  H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES,
  MAX_PRODUCTION_INTENT_BYTES,
  MAX_PRODUCTION_INTENT_INPUTS,
  PRODUCTION_INTENT_DIRECTORY,
  PRODUCTION_INTENT_GATE_CODES,
  PRODUCTION_INTENT_OPERATIONS,
  PRODUCTION_MODEL_FAMILIES,
  SEEDANCE_MODEL_IDS,
  VEO_MODEL_IDS,
  createProductionDispatchIntent,
  enqueueProductionIntent,
  evaluateProductionIntentGates,
  parseProductionDispatchIntent,
  parseProductionIntentDraft,
  parseProductionIntentExecution,
  parseProductionIntentGateContext,
  productionIntentIdempotencyKey,
  productionIntentPath,
  readProductionIntent,
  type ProductionDispatchIntent,
  type ProductionIntentDraft,
  type ProductionIntentExecution,
  type ProductionIntentGateContext,
  type ProductionIntentResolver,
} from "../src/production-intent.ts";
import { SHOT_REQUEST_MEDIA_TYPE } from "../src/production-shot-request.ts";

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
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
  f: "f".repeat(64),
};
const at = (day: number): string => `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const asset = (
  name: string,
  sha256 = SHA.a,
  mediaType = "application/json",
): AssetRef => ({
  version: 1,
  uri: `s3://writing-loop-assets/demo/${name}`,
  sha256,
  byteLength: 123,
  mediaType,
});

function draft(overrides: Record<string, unknown> = {}): ProductionIntentDraft {
  return {
    version: 1,
    taskId: "take-h3-001",
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "ep-001",
          revision: 4,
          source: asset("episode-001.md", SHA.a, "text/markdown"),
        },
        shotId: "shot-001",
        revision: 2,
        source: asset("shot-001.json", SHA.b),
      },
    },
    createdAt: at(10),
    useTerritories: ["CN"],
    execution: {
      version: 1,
      operation: "minimax-h3",
      modelFamily: "minimax-h3",
      backendInstanceId: "h3-private-a",
      workflowSha256: SHA.c,
      modelSha256: SHA.d,
      parametersSha256: SHA.e,
      variant: "fl2va",
      durationSeconds: 8,
      shortEdge: 768,
      aspectRatio: "9:16",
    },
    inputs: [
      asset("first-frame.png", SHA.c, "image/png"),
      asset("last-frame.png", SHA.d, "image/png"),
      asset("dialogue.wav", SHA.e, "audio/wav"),
    ],
    budget: {
      version: 1,
      currency: "USD",
      estimatedAmountMicros: 500_000,
      maximumAmountMicros: 1_000_000,
    },
    rights: {
      version: 1,
      status: "cleared",
      territories: ["CN"],
      evidence: asset("rights.json", SHA.a),
      expiresAt: at(20),
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: at(10),
      evidence: asset("moderation.json", SHA.b),
    },
    license: {
      version: 1,
      status: "verified",
      basis: "community",
      territories: ["CN"],
      licenseSha256: SHA.f,
      evidence: asset("h3-license.txt", SHA.f, "text/plain"),
      issuedBy: null,
      issuedAt: at(1),
      expiresAt: null,
    },
    ...overrides,
  } as ProductionIntentDraft;
}

/** 只有四个必填字段的 gate context：四项策略字段缺省，用于「未声明」形态的判定。 */
function context(overrides: Record<string, unknown> = {}): ProductionIntentGateContext {
  return {
    version: 1,
    evaluatedAt: at(11),
    deploymentTerritories: ["CN"],
    availableBudgetMicros: 2_000_000,
    ...overrides,
  } as ProductionIntentGateContext;
}

/**
 * runtime `projects[]` 供给地域后的常态 context：处理地域已声明且与后端一致。
 * `FAMILIES_REQUIRING_PROCESSING_REGIONS` 改为全家族 deny（0-E）后，任何期望 allow 的用例都必须
 * 走这条形态——未声明地域不再放行任何家族。
 */
function regionalContext(overrides: Record<string, unknown> = {}): ProductionIntentGateContext {
  return context({
    backendProcessingRegions: ["CN"],
    allowedProcessingRegions: ["CN"],
    ...overrides,
  });
}

const intent = createProductionDispatchIntent(draft());
ok(/^[a-f0-9]{64}$/.test(intent.idempotencyKey)
  && parseProductionDispatchIntent(intent).idempotencyKey === intent.idempotencyKey,
"createProductionDispatchIntent 生成可由 strict parser 验证的 SHA-256 idempotencyKey");
ok(productionIntentIdempotencyKey(draft()) === intent.idempotencyKey,
  "显式 digest API 与 intent 工厂使用同一 canonical parsed draft");

// license `obligations` 落地前（main@5125510）该 H3 fixture 的 digest。canonical JSON 逐字节不变才能
// 保证既有 companion 文件、ledger 里的 idempotencyKey 与 O_EXCL 重放判定继续成立（§8.1 验收）。
const H3_FIXTURE_IDEMPOTENCY_KEY = "d013359b9dd971335a8a2fcad23c426bf455fd06347c3c67f4cb6d02ea4d5f1e";
const H3_FIXTURE_CANONICAL_BYTES = 2_855;
ok(intent.idempotencyKey === H3_FIXTURE_IDEMPOTENCY_KEY
  && Buffer.byteLength(JSON.stringify(intent), "utf8") === H3_FIXTURE_CANONICAL_BYTES
  && !Object.prototype.hasOwnProperty.call(intent.license, "obligations"),
"不带 obligations 的旧 H3 intent 解析结果与 idempotencyKey 逐字节不变");
ok(productionIntentIdempotencyKey({
  ...draft(), license: { ...draft().license, obligations: null },
}) === H3_FIXTURE_IDEMPOTENCY_KEY,
"显式 obligations: null 与缺省规范化为同一 canonical intent");
const obligated = draft({
  license: {
    ...draft().license,
    obligations: { attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true },
  },
});
ok(productionIntentIdempotencyKey(obligated) !== H3_FIXTURE_IDEMPOTENCY_KEY
  && parseProductionIntentDraft(obligated).license.obligations?.attribution === "MiniMax H3",
"obligations 进入 canonical intent 与 idempotencyKey");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(),
  license: { ...draft().license, obligations: { attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000 } },
}), "缺少字段"), "obligations 一旦出现就必须是完整三字段记录");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(),
  license: {
    ...draft().license,
    obligations: { attribution: "MiniMax H3", revenueThresholdUsd: -1, noModelImprovement: true },
  },
}), "安全整数"), "obligations 的收入阈值必须是非负安全整数");

const shotSubject = draft().subject;
if (shotSubject.kind !== "shot") throw new Error("test fixture 必须是 shot subject");

const reordered = {
  ...draft(),
  rights: { ...draft().rights, territories: ["JP", "CN"] },
  useTerritories: ["JP", "CN"],
  license: { ...draft().license, territories: ["JP", "CN"] },
};
const reorderedAgain = {
  license: { ...draft().license, territories: ["CN", "JP"] },
  moderation: draft().moderation,
  rights: { ...draft().rights, territories: ["CN", "JP"] },
  budget: draft().budget,
  inputs: draft().inputs,
  execution: draft().execution,
  useTerritories: ["CN", "JP"],
  createdAt: draft().createdAt,
  subject: draft().subject,
  taskId: draft().taskId,
  version: 1,
};
ok(productionIntentIdempotencyKey(reordered) === productionIntentIdempotencyKey(reorderedAgain),
  "对象键序与集合型 territory 输入顺序不会改变 canonical idempotencyKey");

for (const [label, changed] of [
  ["taskId", { ...draft(), taskId: "take-h3-002" }],
  ["subject revision", {
    ...draft(),
    subject: { ...shotSubject, shot: { ...shotSubject.shot, revision: 3 } },
  }],
  ["backend", { ...draft(), execution: { ...draft().execution, backendInstanceId: "h3-private-b" } }],
  ["model family", { ...draft(), execution: {
    version: 1,
    operation: "comfyui-workflow",
    modelFamily: "generic",
    backendInstanceId: draft().execution.backendInstanceId,
    workflowSha256: draft().execution.workflowSha256,
    modelSha256: draft().execution.modelSha256,
    parametersSha256: draft().execution.parametersSha256,
  } }],
  ["workflow digest", { ...draft(), execution: { ...draft().execution, workflowSha256: SHA.f } }],
  ["model digest", { ...draft(), execution: { ...draft().execution, modelSha256: SHA.f } }],
  ["parameters digest", { ...draft(), execution: { ...draft().execution, parametersSha256: SHA.f } }],
  ["input AssetRef", { ...draft(), inputs: [asset("other.png", SHA.f, "image/png")] }],
] as const) {
  ok(productionIntentIdempotencyKey(changed) !== intent.idempotencyKey,
    `${label} 漂移必然改变 idempotencyKey`);
}

ok(throwsProduction(
  () => parseProductionDispatchIntent({ ...intent, idempotencyKey: SHA.a }),
  "canonical parsed intent 不匹配",
), "伪造或陈旧 idempotencyKey 被拒绝，adapter 不能消费漂移配置");
ok(throwsProduction(() => parseProductionIntentDraft({ ...draft(), futureField: true }), "不支持字段"),
  "intent 顶层未知字段 fail-closed");
ok(throwsProduction(() => parseProductionIntentExecution({ ...draft().execution, futureField: true }), "不支持字段"),
  "execution 嵌套未知字段 fail-closed");
ok(throwsProduction(() => parseProductionIntentGateContext({ ...context(), futureField: true }), "不支持字段"),
  "gate context 未知字段 fail-closed");

const h3 = draft().execution;
for (const [label, execution, needle] of [
  ["duration 下界", { ...h3, durationSeconds: 3 }, "4–15"],
  ["duration 上界", { ...h3, durationSeconds: 16 }, "4–15"],
  ["duration 小数", { ...h3, durationSeconds: 4.5 }, "安全整数"],
  ["short edge", { ...h3, shortEdge: 1024 }, "固定为 768"],
  ["aspect ratio", { ...h3, aspectRatio: "4:3" }, "必须是"],
  ["variant", { ...h3, variant: "t2v" }, "fl2va 或 ref2va"],
] as const) {
  ok(throwsProduction(() => parseProductionIntentExecution(execution), needle), `H3 ${label} 边界被 parser 拒绝`);
}
ok(parseProductionIntentExecution({ ...h3, durationSeconds: 4 }).operation === "minimax-h3"
  && parseProductionIntentExecution({
    ...h3, operation: "comfyui-workflow", durationSeconds: 15, variant: "ref2va", aspectRatio: "16:9",
  }).modelFamily === "minimax-h3",
"H3 接受 direct/ComfyUI transport、4–15 秒闭区间、fl2va/ref2va 与受限 aspect ratio");
ok(H3_ASPECT_RATIOS.length === 3
  && H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES.join(",") === "EU,GB,KR,US"
  && EU_MEMBER_TERRITORIES.length === 27 && EU_MEMBER_TERRITORIES.includes("FR")
  && EU_MEMBER_TERRITORIES.includes("DE"),
"H3 v1 的 aspect、restricted region 与 27 个 EU 成员映射集中定义");

const comfyExecution = {
  version: 1,
  operation: "comfyui-workflow",
  modelFamily: "generic",
  backendInstanceId: "comfy-private-a",
  workflowSha256: SHA.a,
  modelSha256: SHA.b,
  parametersSha256: SHA.c,
} as const;
ok(parseProductionIntentExecution(comfyExecution).operation === "comfyui-workflow",
  "ComfyUI execution 同样绑定 backend/workflow/model/parameters digest");
ok(throwsProduction(() => parseProductionIntentExecution({ ...comfyExecution, durationSeconds: 8 }), "不支持字段"),
  "ComfyUI intent 不能夹带 H3-only 参数");
ok(throwsProduction(() => parseProductionIntentExecution({ ...comfyExecution, operation: "minimax-h3" }), "只允许 comfyui-workflow"),
  "generic modelFamily 不能冒充 direct H3 transport");

// —— 云家族 execution 分支（§4.2；本版只到解析层，adapter 归 Phase 3 / Phase 4） ——
ok(PRODUCTION_INTENT_OPERATIONS.join(",") === "comfyui-workflow,minimax-h3,ark-video-task,vertex-veo-lro"
  && PRODUCTION_MODEL_FAMILIES.join(",") === "generic,minimax-h3,seedance,veo"
  && SEEDANCE_MODEL_IDS.length === 8 && VEO_MODEL_IDS.length === 3,
"operation / modelFamily 枚举与两家云 modelId 集合集中定义");

const seedanceExecution = {
  version: 1,
  operation: "ark-video-task",
  modelFamily: "seedance",
  backendInstanceId: "ark-sg-1",
  workflowSha256: SHA.c,
  modelSha256: SHA.d,
  parametersSha256: SHA.e,
  provider: "byteplus-modelark",
  modelId: "dreamina-seedance-2-0-260128",
  resolution: "720p",
  aspectRatio: "9:16",
  generateAudio: true,
  watermark: false,
  returnLastFrame: true,
  executionExpiresAfterSeconds: 7_200,
} as const;
const veoExecution = {
  version: 1,
  operation: "vertex-veo-lro",
  modelFamily: "veo",
  backendInstanceId: "veo-us-1",
  workflowSha256: SHA.c,
  modelSha256: SHA.d,
  parametersSha256: SHA.e,
  modelId: "veo-3.1-generate-001",
  location: "us-central1",
  resolution: "1080p",
  aspectRatio: "16:9",
  generateAudio: true,
  sampleCount: 1,
  ioMode: "inline-base64",
} as const;

const parsedSeedance = parseProductionIntentExecution(seedanceExecution);
const parsedVeo = parseProductionIntentExecution(veoExecution);
ok(parsedSeedance.modelFamily === "seedance" && parsedSeedance.operation === "ark-video-task"
  && parsedVeo.modelFamily === "veo" && parsedVeo.operation === "vertex-veo-lro",
"seedance / veo execution 各自绑定 transport 与 backend/workflow/model/parameters digest");
ok(parseProductionIntentExecution({ ...seedanceExecution, resolution: "4k" }).modelFamily === "seedance"
  && parseProductionIntentExecution({ ...veoExecution, resolution: "4k" }).modelFamily === "veo"
  && parseProductionIntentExecution({ ...veoExecution, ioMode: "gcs" }).modelFamily === "veo",
"2-0-260128 允许 4k、generate-001 允许 4k 与 gcs ioMode");
ok(throwsProduction(() => parseProductionIntentExecution({ ...seedanceExecution, durationSeconds: 8 }), "不支持字段"),
  "云 execution 不接受 durationSeconds 等逐镜字段（逐镜变量在 inputs[0] 的 ShotRequest 内）");
ok(parseProductionIntentExecution({
  ...seedanceExecution, provider: "volcengine-ark", modelId: "doubao-seedance-2-0-260128",
}).modelFamily === "seedance",
"doubao- 前缀配 volcengine-ark、dreamina- 前缀配 byteplus-modelark 的组合被接受");

for (const [label, execution, needle] of [
  ["modelId 集合", { ...seedanceExecution, modelId: "doubao-seedance-3-0-260128" },
    ".modelId 必须是"],
  ["fast + 1080p", {
    ...seedanceExecution, modelId: "dreamina-seedance-2-0-fast-260128", resolution: "1080p",
  }, ".resolution dreamina-seedance-2-0-fast-260128 只支持 480p、720p"],
  ["mini + 4k", {
    ...seedanceExecution, modelId: "dreamina-seedance-2-0-mini-260615", resolution: "4k",
  }, ".resolution dreamina-seedance-2-0-mini-260615 只支持 480p、720p"],
  ["2.5 + 4k", { ...seedanceExecution, modelId: "doubao-seedance-2-5-260628", resolution: "4k" },
    ".resolution doubao-seedance-2-5-260628 只支持 480p、720p、1080p"],
  ["adaptive 画幅", { ...seedanceExecution, aspectRatio: "adaptive" }, ".aspectRatio 必须是"],
  ["4:3 画幅", { ...seedanceExecution, aspectRatio: "4:3" }, ".aspectRatio 必须是"],
  ["provider 枚举", { ...seedanceExecution, provider: "aliyun-dashscope" }, ".provider 必须是"],
  ["provider 与 doubao- 前缀不符", { ...seedanceExecution, modelId: "doubao-seedance-2-0-260128" },
    ".provider doubao-seedance-2-0-260128 只在 volcengine-ark 下发"],
  ["provider 与 dreamina- 前缀不符", { ...seedanceExecution, provider: "volcengine-ark" },
    ".provider dreamina-seedance-2-0-260128 只在 byteplus-modelark 下发"],
  ["expiry 下界", { ...seedanceExecution, executionExpiresAfterSeconds: 3_599 },
    ".executionExpiresAfterSeconds 必须是 3600–259200"],
  ["expiry 上界", { ...seedanceExecution, executionExpiresAfterSeconds: 259_201 },
    ".executionExpiresAfterSeconds 必须是 3600–259200"],
  ["watermark", { ...seedanceExecution, watermark: true }, ".watermark 必须固定为 false"],
  ["returnLastFrame", { ...seedanceExecution, returnLastFrame: false }, ".returnLastFrame 必须固定为 true"],
  ["transport", { ...seedanceExecution, operation: "comfyui-workflow" }, ".operation seedance transport 必须是 ark-video-task"],
] as const) {
  ok(throwsProduction(() => parseProductionIntentExecution(execution), needle), `seedance ${label} 被 parser 拒绝`);
}

for (const [label, execution, needle] of [
  ["modelId 集合", { ...veoExecution, modelId: "veo-3.0-generate-001" }, ".modelId 必须是"],
  ["lite + 4k", { ...veoExecution, modelId: "veo-3.1-lite-generate-001", resolution: "4k" },
    ".resolution veo-3.1-lite-generate-001 只支持 720p、1080p"],
  ["fast + 4k", { ...veoExecution, modelId: "veo-3.1-fast-generate-001", resolution: "4k" },
    ".resolution veo-3.1-fast-generate-001 只支持 720p、1080p"],
  ["480p", { ...veoExecution, resolution: "480p" }, ".resolution 必须是"],
  ["1:1 画幅", { ...veoExecution, aspectRatio: "1:1" }, ".aspectRatio 必须是"],
  ["location", { ...veoExecution, location: "us-east4" }, ".location v1 只接受 us-central1"],
  ["sampleCount", { ...veoExecution, sampleCount: 2 }, ".sampleCount 必须固定为 1"],
  ["ioMode", { ...veoExecution, ioMode: "signed-url" }, ".ioMode 必须是"],
  ["transport", { ...veoExecution, operation: "ark-video-task" }, ".operation veo transport 必须是 vertex-veo-lro"],
] as const) {
  ok(throwsProduction(() => parseProductionIntentExecution(execution), needle), `veo ${label} 被 parser 拒绝`);
}

// —— inputs[0]：云家族必须是 ShotRequest（§4.2、§8.6） ——
const shotRequestInput = asset("shot-request.json", SHA.f, SHOT_REQUEST_MEDIA_TYPE);
const cloudDraft = (
  execution: typeof seedanceExecution | typeof veoExecution,
  overrides: Record<string, unknown> = {},
): ProductionIntentDraft => draft({
  taskId: `take-${execution.modelFamily}-001`,
  execution,
  inputs: [shotRequestInput, asset("first-frame.png", SHA.c, "image/png")],
  ...overrides,
});
ok(parseProductionIntentDraft(cloudDraft(seedanceExecution)).inputs[0].mediaType === SHOT_REQUEST_MEDIA_TYPE
  && parseProductionIntentDraft(cloudDraft(veoExecution)).inputs[0].mediaType === SHOT_REQUEST_MEDIA_TYPE,
"云家族接受以 ShotRequest 打头的 inputs");
for (const execution of [seedanceExecution, veoExecution] as const) {
  ok(throwsProduction(() => parseProductionIntentDraft(cloudDraft(execution, {
    inputs: [asset("first-frame.png", SHA.c, "image/png"), shotRequestInput],
  })), "必须是 ShotRequest"), `${execution.modelFamily} 的 inputs[0] 不是 ShotRequest 时 fail-closed`);
}
ok(parseProductionIntentDraft(draft()).inputs[0].mediaType === "image/png",
  "H3 在 graph 契约 v2 落地前不强制 inputs[0] 为 ShotRequest（既有 intent 不受影响）");

// Phase 3 / Phase 4 的 adapter 必须对着同一份 canonical execution 落地：这两个 digest 一旦变化，说明
// 云 execution 的字段集合或规范化发生了漂移（§8.4、§8.5 验收基线）。
ok(createProductionDispatchIntent(cloudDraft(seedanceExecution)).idempotencyKey
  === "fe538267c38f98b1074f48eb7b72254192af5ca7e78af334b664804817b46ba7"
  && createProductionDispatchIntent(cloudDraft(veoExecution)).idempotencyKey
  === "ffbd9cdc5da88a70016ecb70a64411a831001dd1488561434adf600a7cf36bb5",
"seedance / veo 的 canonical intent digest 钉为 Phase 3 / Phase 4 基线");
ok(throwsProduction(() => parseProductionIntentDraft({ ...draft(), inputs: [] }), "1–32"),
  "intent 至少绑定一个输入 AssetRef");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(), inputs: Array.from({ length: MAX_PRODUCTION_INTENT_INPUTS + 1 }, (_, i) => asset(`i-${i}`, SHA.a)),
}), "1–32"), "intent 输入集合有固定上限");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(), inputs: [asset("same"), asset("same")],
}), "重复 AssetRef"), "重复输入 AssetRef 被拒绝，避免请求体放大/歧义");
ok(throwsProduction(() => parseProductionIntentDraft({ ...draft(), useTerritories: ["cn"] }), "大写二位地域码"),
  "地域必须采用 canonical 大写码");
ok(throwsProduction(() => parseProductionIntentDraft({ ...draft(), useTerritories: ["WORLDWIDE", "CN"] }), "单独使用"),
  "WORLDWIDE 不与具体地域混用，避免集合歧义");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(), budget: { ...draft().budget, estimatedAmountMicros: Number.MAX_SAFE_INTEGER },
}), "安全整数"), "预算估算受 production ledger 的固定安全上限约束");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(), budget: { ...draft().budget, estimatedAmountMicros: 0, maximumAmountMicros: 0 },
}), "1–"), "远端制片 intent 不允许零上限逃避 billable exposure");
ok(throwsProduction(() => parseProductionIntentDraft({
  ...draft(), inputs: [{ ...asset("signed"), uri: "https://assets.example/x?token=secret" }],
}), "query/fragment"), "输入继续复用严格 AssetRef parser，拒绝临时签名 URL");

const baseDecision = evaluateProductionIntentGates(intent, regionalContext());
ok(baseDecision.allowed && baseDecision.failures.length === 0,
  "CN 部署、community evidence 完整且所有门满足时允许 H3 dispatch");
const frozenBefore = JSON.stringify({ intent, context: context() });
evaluateProductionIntentGates(intent, context());
ok(JSON.stringify({ intent, context: context() }) === frozenBefore,
  "gate 是 pure function，不修改 intent/context");

const decisionCodes = (
  changedDraft: ProductionIntentDraft,
  changedContext: ProductionIntentGateContext = context(),
): string[] => evaluateProductionIntentGates(createProductionDispatchIntent(changedDraft), changedContext)
  .failures.map((failure) => failure.code);

ok(decisionCodes({
  ...draft(), budget: { ...draft().budget, estimatedAmountMicros: 1_000_001 },
}).includes("budget-maximum-exceeded"), "estimate 超过不可变 intent maximum 时 gate deny");
ok(decisionCodes(draft(), { ...context(), availableBudgetMicros: 499_999 }).includes("budget-available-exceeded"),
  "immutable maximum 超过 dispatch 时预算快照时 gate deny");
ok(decisionCodes({
  ...draft(), budget: { ...draft().budget, estimatedAmountMicros: 0, maximumAmountMicros: 1_000_000 },
}, { ...context(), availableBudgetMicros: 0 }).includes("budget-available-exceeded"),
"零估算不能绕过非零 maximum 的预算门禁");
ok(decisionCodes({ ...draft(), rights: { ...draft().rights, status: "unknown" } }).includes("rights-not-cleared"),
  "rights unknown 默认 deny");
ok(decisionCodes({ ...draft(), rights: { ...draft().rights, evidence: null } }).includes("rights-evidence-missing"),
  "rights cleared 但无 evidence 仍 deny");
ok(decisionCodes({ ...draft(), rights: { ...draft().rights, territories: ["JP"] } }).includes("rights-territory-missing"),
  "rights evidence 未覆盖使用地域时 deny");
ok(decisionCodes({ ...draft(), rights: { ...draft().rights, expiresAt: at(9) } }).includes("rights-expired"),
  "rights evidence 在 gate 时间前到期时 deny");
ok(decisionCodes({ ...draft(), rights: { ...draft().rights, expiresAt: at(11) } }).includes("rights-expired"),
  "rights evidence 在 gate 时刻到期也视为已过期");
ok(decisionCodes({ ...draft(), moderation: { ...draft().moderation, status: "not-reviewed" } }).includes("moderation-not-passed"),
  "moderation 未审默认 deny");
ok(decisionCodes({ ...draft(), moderation: { ...draft().moderation, evidence: null } }).includes("moderation-evidence-missing"),
  "moderation passed 但无 evidence 仍 deny");
ok(decisionCodes({ ...draft(), moderation: { ...draft().moderation, reviewedAt: at(12) } }).includes("moderation-from-future"),
  "未来 moderation 时间不能越过 gate");
ok(decisionCodes({ ...draft(), license: { ...draft().license, status: "unknown" } }).includes("license-not-verified"),
  "license unknown 默认 deny");
ok(decisionCodes({ ...draft(), license: { ...draft().license, evidence: null } }).includes("license-evidence-missing"),
  "license verified 但无 evidence 仍 deny");
ok(decisionCodes({ ...draft(), license: { ...draft().license, territories: ["JP"] } }).includes("license-territory-missing"),
  "license 必须同时覆盖使用与部署地域");
ok(decisionCodes({ ...draft(), license: { ...draft().license, expiresAt: at(9) } }).includes("license-expired"),
  "过期 license 不能 dispatch");
ok(decisionCodes({ ...draft(), license: { ...draft().license, expiresAt: at(11) } }).includes("license-expired"),
  "license 在 gate 时刻到期也不能 dispatch");
ok(decisionCodes({ ...draft(), license: { ...draft().license, issuedAt: at(12) } }).includes("license-issued-in-future"),
  "未来签发的 license 不能 dispatch");

const h3Execution = draft().execution as Extract<ProductionIntentExecution, { modelFamily: "minimax-h3" }>;
const h3ComfyExecution: ProductionIntentExecution = { ...h3Execution, operation: "comfyui-workflow" };
const euCommunity = {
  ...draft(),
  useTerritories: ["EU"],
  rights: { ...draft().rights, territories: ["EU"] },
  license: { ...draft().license, territories: ["EU"] },
};
ok(decisionCodes(euCommunity).includes("h3-written-license-required"),
  "H3 community license 在 EU 默认 deny");
ok(decisionCodes({
  ...euCommunity,
  execution: h3ComfyExecution,
}).includes("h3-written-license-required"),
"H3-over-ComfyUI 仍按 modelFamily 进入 restricted-territory written-license gate");
ok(decisionCodes({
  ...euCommunity,
  execution: h3ComfyExecution,
  license: { ...euCommunity.license, basis: "provider-terms" },
}).includes("h3-written-license-required"),
"EU 的 H3-over-ComfyUI 不能用 provider-terms 绕过 written-license gate");
ok(decisionCodes({
  ...euCommunity,
  license: { ...euCommunity.license, basis: "provider-terms" },
}).includes("h3-written-license-required"),
"受限地域不能用模糊 provider-terms 绕过明确 written-license evidence 要求");
ok(decisionCodes(draft(), { ...context(), deploymentTerritories: ["GB"] })
  .includes("h3-written-license-required"),
"即使内容仅 CN 使用，H3 community backend 部署在 GB 也默认 deny");
for (const territory of ["FR", "DE", "UK", "GB"] as const) {
  const restrictedCountry = {
    ...draft(),
    useTerritories: [territory],
    rights: { ...draft().rights, territories: [territory] },
    license: { ...draft().license, territories: [territory] },
  };
  ok(decisionCodes(restrictedCountry, { ...context(), deploymentTerritories: [territory] })
    .includes("h3-written-license-required"),
  `H3 community license 在 ${territory} 不能绕过 EU/GB restricted-region 映射`);
}
const worldwideCommunity = {
  ...draft(),
  useTerritories: ["WORLDWIDE"],
  rights: { ...draft().rights, territories: ["WORLDWIDE"] },
  license: { ...draft().license, territories: ["WORLDWIDE"] },
};
ok(decisionCodes(worldwideCommunity, { ...context(), deploymentTerritories: ["WORLDWIDE"] })
  .includes("h3-written-license-required"),
"WORLDWIDE 隐含 EU/GB/KR/US，不能绕过 H3 community license 地域门");

const writtenLicense = {
  ...euCommunity,
  license: {
    ...euCommunity.license,
    basis: "written-license" as const,
    issuedBy: "MiniMax authorized licensing",
    issuedAt: at(1),
  },
};
ok(evaluateProductionIntentGates(
  createProductionDispatchIntent(writtenLicense),
  { ...regionalContext(), deploymentTerritories: ["EU"] },
).allowed, "EU 的明确 verified written-license evidence 可放行 H3");
ok(decisionCodes({
  ...writtenLicense,
  license: { ...writtenLicense.license, issuedBy: null },
}, { ...context(), deploymentTerritories: ["EU"] }).includes("h3-written-license-required"),
"仅把 basis 文本改成 written-license 不足以放行，必须有明确签发/evidence 字段");

// —— §4.7 三个新门：处理地域、许可义务、真人人脸 ——
ok(PRODUCTION_INTENT_GATE_CODES.includes("processing-region-not-allowed")
  && PRODUCTION_INTENT_GATE_CODES.includes("license-obligation-unmet")
  && PRODUCTION_INTENT_GATE_CODES.includes("provider-likeness-policy"),
"三个新 gate code 进入 PRODUCTION_INTENT_GATE_CODES");

ok(decisionCodes(draft(), context({
  backendProcessingRegions: ["US"], allowedProcessingRegions: ["SG"],
})).includes("processing-region-not-allowed"),
"后端处理地域不在项目允许集合内时 deny");
ok(evaluateProductionIntentGates(intent, context({
  backendProcessingRegions: ["SG"], allowedProcessingRegions: ["CN", "SG"],
})).allowed, "处理地域在允许集合内时放行");
ok(decisionCodes(draft(), context({ allowedProcessingRegions: ["SG"] }))
  .includes("processing-region-not-allowed"),
"项目声明了允许地域而后端处理地域未声明时 deny（无可比对项不等于合规）");
ok(decisionCodes(cloudDraft(seedanceExecution), context({ realFaceInputs: "absent" }))
  .includes("processing-region-not-allowed")
  && decisionCodes(cloudDraft(veoExecution), context()).includes("processing-region-not-allowed"),
"项目未声明 allowedProcessingRegions 时云家族 deny");
// 0-E：runtime `projects[]` 供给 `allowedProcessingRegions` 后 `FAMILIES_REQUIRING_PROCESSING_REGIONS`
// 改为全家族 true，本地 ComfyUI 与云后端同判据（原用例期望 H3 / generic 暂放行）。
const genericDraft = (): ProductionIntentDraft => draft({
  taskId: "take-generic-001",
  execution: {
    version: 1,
    operation: "comfyui-workflow",
    modelFamily: "generic",
    backendInstanceId: "h3-private-a",
    workflowSha256: SHA.c,
    modelSha256: SHA.d,
    parametersSha256: SHA.e,
  },
});
ok(decisionCodes(draft(), context({ backendProcessingRegions: ["SG"] }))
  .includes("processing-region-not-allowed")
  && decisionCodes(genericDraft(), context({ backendProcessingRegions: ["SG"] }))
    .includes("processing-region-not-allowed"),
"项目未声明 allowedProcessingRegions 时 H3 / generic 同样 deny（0-E 起全家族强制）");
ok(throwsProduction(
  () => parseProductionIntentGateContext(context({ backendProcessingRegions: ["WORLDWIDE"] })),
  "大写二位地域码",
), "处理地域只接受 ISO-3166 alpha-2，不接受 WORLDWIDE 这类集合别名");
for (const alias of ["EU", "UK"] as const) {
  ok(throwsProduction(
    () => parseProductionIntentGateContext(context({ allowedProcessingRegions: [alias] })),
    "集合别名或非标准码",
  ), `处理地域拒绝 ${alias}（要求写成员国代码）`);
}
ok(parseProductionIntentGateContext(context({ allowedProcessingRegions: ["FR", "DE", "GB"] }))
  .allowedProcessingRegions?.join(",") === "DE,FR,GB",
"处理地域接受成员国代码并规范化排序");
// 0-E 前该用例期望「缺省四项策略字段时 H3 仍放行」；地域改为全家族强制后，缺省即 deny 且只 deny 这一项。
const bareDecision = evaluateProductionIntentGates(intent, context());
ok(!bareDecision.allowed
  && bareDecision.failures.map((failure) => failure.code).join(",") === "processing-region-not-allowed",
"缺省四项策略字段时 H3 只因未声明处理地域 deny（其余门结论不变）");

const obligationCodes = decisionCodes(obligated);
ok(obligationCodes.filter((code) => code === "license-obligation-unmet").length === 2,
  "项目既未声明年收入也未声明署名面时，两项义务各 deny 一次");
ok(evaluateProductionIntentGates(createProductionDispatchIntent(obligated), regionalContext({
  licenseCompliance: { annualRevenueUsdBelow: 1_000_000, attributionSurfaces: ["片尾字幕", "发布文案"] },
})).allowed, "声明年收入低于阈值且已落实署名面时放行");
ok(decisionCodes(obligated, context({
  licenseCompliance: { annualRevenueUsdBelow: 25_000_000, attributionSurfaces: ["片尾字幕"] },
})).includes("license-obligation-unmet"),
"声明的年收入上界高于许可阈值时 deny");
ok(decisionCodes(obligated, context({
  licenseCompliance: { annualRevenueUsdBelow: 1_000_000, attributionSurfaces: [] },
})).includes("license-obligation-unmet"),
"署名面为空时 deny");
ok(evaluateProductionIntentGates(createProductionDispatchIntent(draft({
  license: {
    ...draft().license,
    basis: "written-license",
    issuedBy: "MiniMax authorized licensing",
    obligations: { attribution: null, revenueThresholdUsd: 20_000_000, noModelImprovement: true },
  },
})), regionalContext()).allowed,
"完整 written-license evidence 解除年收入阈值条款");
// 豁免判据与 H3 受限地域门同一个 hasExplicitWrittenLicense：只改 basis 文本不算数，且该判据不限家族。
ok(decisionCodes(cloudDraft(seedanceExecution, {
  license: {
    ...draft().license,
    basis: "written-license",
    issuedBy: null,
    obligations: { attribution: null, revenueThresholdUsd: 20_000_000, noModelImprovement: true },
  },
}), context({
  allowedProcessingRegions: ["SG"], backendProcessingRegions: ["SG"], realFaceInputs: "absent",
})).includes("license-obligation-unmet"),
"非 H3 家族同样要求完整 written-license evidence：basis 文本 + issuedBy null 不构成豁免");

const seedanceGateDraft = cloudDraft(seedanceExecution);
const seedanceContext = (realFaceInputs: string): ProductionIntentGateContext => context({
  allowedProcessingRegions: ["SG"], backendProcessingRegions: ["SG"], realFaceInputs,
});
ok(decisionCodes(seedanceGateDraft).includes("provider-likeness-policy"),
  "缺省真人人脸声明时 Seedance 2.x deny（未证明不含即按含处理）");
ok(decisionCodes(seedanceGateDraft, seedanceContext("undeclared")).includes("provider-likeness-policy"),
  "显式 undeclared 与缺省同结论：Seedance 2.x deny");
ok(decisionCodes(seedanceGateDraft, seedanceContext("present")).includes("provider-likeness-policy"),
  "输入声明含真人人脸时 Seedance 2.x deny");
ok(evaluateProductionIntentGates(
  createProductionDispatchIntent(seedanceGateDraft),
  seedanceContext("absent"),
).allowed, "输入声明不含真人人脸且地域合规时 Seedance 放行");
ok(!decisionCodes(draft(), context({ realFaceInputs: "present" })).includes("provider-likeness-policy"),
  "真人人脸门只作用于 Seedance 2.x，H3 不受影响");

// The interface is intentionally exercised at compile-time and preserves parser validation at the
// trust boundary: a coordinator cannot treat an unparsed arbitrary object as a resolved intent.
const resolver: ProductionIntentResolver = {
  async resolve(taskId: string): Promise<ProductionDispatchIntent | null> {
    return taskId === intent.taskId ? parseProductionDispatchIntent(intent) : null;
  },
};
ok((await resolver.resolve(intent.taskId))?.idempotencyKey === intent.idempotencyKey
  && await resolver.resolve("missing") === null,
"ProductionIntentResolver port 支持 coordinator 的异步本地/远端实现");

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-intent-")));
try {
  const projectDirectory = join(root, ".writing-loop", "demo");
  mkdirSync(projectDirectory, { recursive: true });
  const queued = enqueueProductionIntent(root, "demo", intent);
  const replay = enqueueProductionIntent(root, "demo", intent);
  const read = readProductionIntent(root, "demo", intent.taskId);
  ok(queued.created && !replay.created && read?.idempotencyKey === intent.idempotencyKey,
    "O_EXCL companion 首次创建、精确重放 no-op、随后可严格读取");
  ok(queued.path === productionIntentPath(root, "demo", intent.taskId)
    && (lstatSync(queued.path).mode & 0o777) === 0o600,
  "companion 路径按 taskId 固定且新文件权限为 0600");
  ok(JSON.stringify(JSON.parse(readFileSync(queued.path, "utf8"))) === JSON.stringify(intent),
    "落盘内容是 parser-canonical intent，不保留调用方键序/别名");

  const drifted = createProductionDispatchIntent({
    ...draft(), execution: { ...draft().execution, parametersSha256: SHA.f },
  });
  ok(throwsProduction(() => enqueueProductionIntent(root, "demo", drifted), "已绑定另一 canonical intent"),
    "同 taskId 的 config drift 即使自带新合法 digest 也不能覆盖 immutable companion");

  const intentDir = join(projectDirectory, PRODUCTION_INTENT_DIRECTORY);
  const originalBytes = readFileSync(queued.path);
  const hardlinkPath = join(intentDir, "hardlink-task.json");
  linkSync(queued.path, hardlinkPath);
  ok(throwsProduction(() => readProductionIntent(root, "demo", "hardlink-task"), "单链接普通文件"),
    "companion reader 拒绝 hardlink");
  rmSync(hardlinkPath);
  ok(readProductionIntent(root, "demo", intent.taskId)?.idempotencyKey === intent.idempotencyKey,
    "移除测试 hardlink 后原 companion 恢复单链接且仍可读");

  const symlinkTask = "symlink-task";
  symlinkSync(queued.path, join(intentDir, `${symlinkTask}.json`));
  ok(throwsProduction(() => readProductionIntent(root, "demo", symlinkTask), "单链接普通文件"),
    "companion reader 拒绝 symlink");

  const mismatch = createProductionDispatchIntent({ ...draft(), taskId: "inside-task" });
  writeFileSync(join(intentDir, "outside-task.json"), `${JSON.stringify(mismatch)}\n`, { mode: 0o600 });
  ok(throwsProduction(() => readProductionIntent(root, "demo", "outside-task"), "taskId 与文件名不匹配"),
    "文件名 taskId 与正文绑定，不能以另一任务路径读取");

  writeFileSync(join(intentDir, "oversized-task.json"), Buffer.alloc(MAX_PRODUCTION_INTENT_BYTES + 1, 0x20), { mode: 0o600 });
  ok(throwsProduction(() => readProductionIntent(root, "demo", "oversized-task"), "安全读取上限"),
    "companion reader 在 JSON.parse 前执行固定 byte budget");

  writeFileSync(join(intentDir, "invalid-utf8.json"), Buffer.from([0xff]), { mode: 0o600 });
  ok(throwsProduction(() => readProductionIntent(root, "demo", "invalid-utf8"), "规范 UTF-8"),
    "companion reader 拒绝非规范 UTF-8，而不接受替换字符归一化");
  ok(throwsProduction(() => readProductionIntent(root, "demo", intent.taskId, 1), "1024"),
    "caller 不能把读取预算设置为零/不安全值");

  const partialTask = "partial-task";
  writeFileSync(join(intentDir, `${partialTask}.json`), "{", { mode: 0o600 });
  const partialIntent = createProductionDispatchIntent({ ...draft(), taskId: partialTask });
  ok(throwsProduction(() => enqueueProductionIntent(root, "demo", partialIntent), "JSON 损坏"),
    "既有崩溃残片 fail-closed，enqueue 不会覆盖或盲目修复");

  const symlinkProjectRoot = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-intent-symlink-")));
  try {
    mkdirSync(join(symlinkProjectRoot, ".writing-loop"));
    symlinkSync(projectDirectory, join(symlinkProjectRoot, ".writing-loop", "demo"));
    ok(throwsProduction(() => productionIntentPath(symlinkProjectRoot, "demo", intent.taskId), "真实目录"),
      "project directory symlink 不能把 companion 重定向到 workspace 外");
  } finally {
    rmSync(symlinkProjectRoot, { recursive: true, force: true });
  }

  // Guard against an accidental test mutation of the authoritative fixture.
  ok(Buffer.compare(readFileSync(queued.path), originalBytes) === 0,
    "所有 replay/攻击路径均未改写首次落盘的 immutable intent bytes");
  chmodSync(queued.path, 0o600);
  ok(existsSync(queued.path), "companion 在测试结束前保持 durable");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_INTENT_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
