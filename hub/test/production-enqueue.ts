import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitProductionTaskEnqueue,
  enqueueProductionTask,
  planProductionTaskEnqueue,
} from "../src/production-enqueue.ts";
import { readProductionIntent } from "../src/production-intent.ts";
import { ProductionStore } from "../src/production-store.ts";

let failures = 0;
function ok(condition: unknown, message: string): void {
  if (!condition) { failures++; console.error(`FAIL ${message}`); }
  else console.log(`PASS ${message}`);
}

const workspaceId = `ws_${"a".repeat(32)}`;
const sha = (letter: string): string => letter.repeat(64);
const asset = (name: string, digest: string) => ({
  version: 1 as const,
  uri: `s3://writing-loop-assets/demo/${name}`,
  sha256: digest,
  byteLength: 100,
  mediaType: "application/json",
});
const draft = (taskId = "take-enqueue") => ({
  version: 1,
  taskId,
  subject: {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: {
        version: 1,
        episodeId: "ep-001",
        revision: 1,
        source: asset("episode.json", sha("a")),
      },
      shotId: "shot-001",
      revision: 1,
      source: asset("shot.json", sha("b")),
    },
  },
  createdAt: "2026-08-10T12:00:00.000Z",
  useTerritories: ["CN"],
  execution: {
    version: 1,
    operation: "comfyui-workflow",
    modelFamily: "generic",
    backendInstanceId: "comfy-primary",
    workflowSha256: sha("c"),
    modelSha256: sha("d"),
    parametersSha256: sha("e"),
  },
  inputs: [asset("shot.json", sha("b"))],
  budget: { version: 1, currency: "USD", estimatedAmountMicros: 1_000_000, maximumAmountMicros: 2_000_000 },
  rights: { version: 1, status: "cleared", territories: ["CN"], evidence: asset("rights.json", sha("f")), expiresAt: null },
  moderation: { version: 1, status: "passed", reviewedAt: "2026-08-10T11:00:00.000Z", evidence: asset("moderation.json", sha("1")) },
  license: {
    version: 1,
    status: "verified",
    basis: "community",
    territories: ["CN"],
    licenseSha256: sha("2"),
    evidence: asset("license.json", sha("3")),
    issuedBy: "model-owner",
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
  },
});

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wl-production-enqueue-"));
  mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

{
  const fx = fixture();
  try {
    const before = new ProductionStore(fx.root, workspaceId, "demo").read();
    const plan = planProductionTaskEnqueue({ workspaceId, project: "demo", draft: draft("take-plan") });
    ok(/^[a-f0-9]{64}$/.test(plan.planId)
      && new ProductionStore(fx.root, workspaceId, "demo").read().revision === before.revision
      && readProductionIntent(fx.root, "demo", "take-plan") === null,
    "enqueue plan 绑定 workspace/project/intent 且严格零写");
    let wrongConfirm = false;
    try {
      commitProductionTaskEnqueue({
        root: fx.root, workspaceId, project: "demo", draft: draft("take-plan"), confirm: "0".repeat(64),
      });
    } catch { wrongConfirm = true; }
    ok(wrongConfirm && readProductionIntent(fx.root, "demo", "take-plan") === null
      && new ProductionStore(fx.root, workspaceId, "demo").read().tasks.length === 0,
    "错误确认指纹在 intent O_EXCL 前失败且保持零写");
    const committed = commitProductionTaskEnqueue({
      root: fx.root, workspaceId, project: "demo", draft: draft("take-plan"), confirm: plan.planId,
    });
    ok(committed.task.status === "dispatch-pending", "匹配计划指纹才提交本地 dispatch");
  } finally { fx.cleanup(); }
}

{
  const fx = fixture();
  try {
    const first = enqueueProductionTask({ root: fx.root, workspaceId, project: "demo", draft: draft() });
    ok(first.intentCreated && first.taskCreated && first.dispatchApplied
      && first.task.status === "dispatch-pending" && first.state.revision === 2,
    "enqueue 按 intent→task→dispatch 顺序发布完整本地请求");
    const replay = enqueueProductionTask({ root: fx.root, workspaceId, project: "demo", draft: draft() });
    ok(!replay.intentCreated && !replay.taskCreated && !replay.dispatchApplied
      && replay.task.status === "dispatch-pending" && replay.state.revision === first.state.revision,
    "相同 draft 精确重试不增加 task/event revision");
  } finally { fx.cleanup(); }
}

{
  const fx = fixture();
  try {
    let crashed = false;
    try {
      enqueueProductionTask({
        root: fx.root, workspaceId, project: "demo", draft: draft("take-intent-crash"),
        hooks: { afterIntentPersisted: () => { throw new Error("crash-after-intent"); } },
      });
    } catch { crashed = true; }
    const before = new ProductionStore(fx.root, workspaceId, "demo").read();
    ok(crashed && readProductionIntent(fx.root, "demo", "take-intent-crash") !== null
      && before.tasks.length === 0,
    "intent durable 后崩溃只留下安全 orphan intent，不猜测 task/remote side effect");
    const recovered = enqueueProductionTask({
      root: fx.root, workspaceId, project: "demo", draft: draft("take-intent-crash"),
    });
    ok(!recovered.intentCreated && recovered.taskCreated && recovered.dispatchApplied
      && recovered.task.status === "dispatch-pending",
    "orphan intent 的相同输入重试只向前创建 task 并 dispatch");
  } finally { fx.cleanup(); }
}

{
  const fx = fixture();
  try {
    let crashed = false;
    try {
      enqueueProductionTask({
        root: fx.root, workspaceId, project: "demo", draft: draft("take-task-crash"),
        hooks: { afterTaskCreated: () => { throw new Error("crash-after-task"); } },
      });
    } catch { crashed = true; }
    const store = new ProductionStore(fx.root, workspaceId, "demo");
    ok(crashed && store.read().tasks[0]?.status === "planned",
      "task durable 后崩溃保留 planned，尚未宣称可 dispatch");
    const recovered = enqueueProductionTask({
      root: fx.root, workspaceId, project: "demo", draft: draft("take-task-crash"),
    });
    ok(!recovered.taskCreated && recovered.dispatchApplied && recovered.task.status === "dispatch-pending",
      "planned crash prefix 的精确重试补唯一 dispatch event");
  } finally { fx.cleanup(); }
}

{
  const fx = fixture();
  try {
    enqueueProductionTask({ root: fx.root, workspaceId, project: "demo", draft: draft("take-conflict") });
    const conflicting = draft("take-conflict");
    conflicting.budget.estimatedAmountMicros = 1_000_001;
    let rejected = false;
    try { enqueueProductionTask({ root: fx.root, workspaceId, project: "demo", draft: conflicting }); }
    catch { rejected = true; }
    const state = new ProductionStore(fx.root, workspaceId, "demo").read();
    const intentBytes = readFileSync(join(
      fx.root, ".writing-loop", "demo", "production-intents.v1", "take-conflict.json",
    ), "utf8");
    ok(rejected && state.tasks.length === 1 && state.revision === 2
      && intentBytes.includes("1000000") && !intentBytes.includes("1000001"),
    "同 task 的 drift draft 在 intent 边界硬停且不覆盖既有证据/任务");
  } finally { fx.cleanup(); }
}

if (failures) process.exit(1);
console.log("PRODUCTION_ENQUEUE_OK");
