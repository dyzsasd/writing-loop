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
  type ProductionIntentGateContext,
  type ProductionIntentResolver,
} from "../src/production-intent.ts";

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

function context(overrides: Record<string, unknown> = {}): ProductionIntentGateContext {
  return {
    version: 1,
    evaluatedAt: at(11),
    deploymentTerritories: ["CN"],
    availableBudgetMicros: 2_000_000,
    ...overrides,
  } as ProductionIntentGateContext;
}

const intent = createProductionDispatchIntent(draft());
ok(/^[a-f0-9]{64}$/.test(intent.idempotencyKey)
  && parseProductionDispatchIntent(intent).idempotencyKey === intent.idempotencyKey,
"createProductionDispatchIntent 生成可由 strict parser 验证的 SHA-256 idempotencyKey");
ok(productionIntentIdempotencyKey(draft()) === intent.idempotencyKey,
  "显式 digest API 与 intent 工厂使用同一 canonical parsed draft");

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

const baseDecision = evaluateProductionIntentGates(intent, context());
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
  execution: { ...euCommunity.execution, operation: "comfyui-workflow" },
}).includes("h3-written-license-required"),
"H3-over-ComfyUI 仍按 modelFamily 进入 restricted-territory written-license gate");
ok(decisionCodes({
  ...euCommunity,
  execution: { ...euCommunity.execution, operation: "comfyui-workflow" },
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
  { ...context(), deploymentTerritories: ["EU"] },
).allowed, "EU 的明确 verified written-license evidence 可放行 H3");
ok(decisionCodes({
  ...writtenLicense,
  license: { ...writtenLicense.license, issuedBy: null },
}, { ...context(), deploymentTerritories: ["EU"] }).includes("h3-written-license-required"),
"仅把 basis 文本改成 written-license 不足以放行，必须有明确签发/evidence 字段");

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
