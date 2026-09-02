import {
  parseProductionTaskEvent,
  taskFromCreate,
  transitionProductionTask,
  type AssetRef,
  type ProductionTask,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import { decideProductionObservation, parseRemoteObservation } from "../src/production-reconcile.ts";
import type { RemoteJobState, RemoteObservation } from "../src/production-adapter.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throws = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; } catch (error) { return error instanceof Error && error.message.includes(needle); }
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const BACKEND = "comfy-prod-a";
const REMOTE = "11111111-1111-4111-8111-111111111111";
const at = (second: number): string => `2026-08-10T14:00:${String(second).padStart(2, "0")}.000Z`;
const asset: AssetRef = {
  version: 1,
  uri: "s3://writing-loop-assets/demo/shot.json",
  sha256: SHA_A,
  byteLength: 42,
  mediaType: "application/json",
};

const baseTask = (): ProductionTask => taskFromCreate({
  version: 1,
  id: "take-001",
  idempotencyKey: "idem-take-001",
  createdAt: at(0),
  subject: {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: { version: 1, episodeId: "ep-001", revision: 1, source: asset },
      shotId: "shot-001",
      revision: 1,
      source: asset,
    },
  },
});

function apply(task: ProductionTask, type: ProductionTaskEvent["type"], second: number, extra: Record<string, unknown> = {}): ProductionTask {
  return transitionProductionTask(task, parseProductionTaskEvent({
    version: 1,
    type,
    eventId: `evt-${task.revision}-${type}`,
    taskId: task.id,
    expectedRevision: task.revision,
    occurredAt: at(second),
    ...extra,
  }));
}

function submitted(status: "submitting" | "submission-unknown" | "submitted" | "running" | "ingesting" = "submitting"): ProductionTask {
  let task = apply(baseTask(), "dispatch-requested", 1);
  task = apply(task, "submission-started", 2, {
    backendInstanceId: BACKEND,
    remoteJobId: REMOTE,
    requestDigest: SHA_A,
  });
  if (status === "submitting") return task;
  if (status === "submission-unknown") return apply(task, "submission-uncertain", 3, {
    backendInstanceId: BACKEND,
    remoteJobId: REMOTE,
    reason: "network-ambiguous",
  });
  task = apply(task, "submission-confirmed", 3, { backendInstanceId: BACKEND, remoteJobId: REMOTE });
  if (status === "submitted") return task;
  task = apply(task, "remote-started", 4, { backendInstanceId: BACKEND, remoteJobId: REMOTE });
  if (status === "running") return task;
  return apply(task, "ingestion-started", 5);
}

const observation = (state: RemoteJobState, second = 10): RemoteObservation => ({
  remoteJobId: REMOTE,
  state,
  observedAt: at(second),
  outputs: state === "succeeded" ? [{
    nodeId: "9",
    kind: "video",
    filename: "take-001.mp4",
    subfolder: "h3",
    folderType: "output",
  }] : [],
  errorSummary: state === "failed" ? "execution_error:RuntimeError" : null,
  responseDigest: SHA_B,
});

let decision = decideProductionObservation(submitted("submitting"), observation("not-found"));
ok(decision.disposition === "events" && decision.facts.length === 1
  && decision.facts[0]?.type === "submission-uncertain",
"接管已 prepared 的 submitting 只转 unknown，对 not-found 绝不重 POST/failed");

decision = decideProductionObservation(submitted("submission-unknown"), observation("pending"));
ok(decision.facts.map((fact) => fact.type).join(",") === "submission-confirmed",
"unknown + pending 只补远端已接收事实");

decision = decideProductionObservation(submitted("submission-unknown"), observation("succeeded"));
ok(decision.disposition === "ingest"
  && decision.facts.map((fact) => fact.type).join(",") === "submission-confirmed,ingestion-started",
"unknown + succeeded 先补 confirmed，再进入 ingest，永不重新生成");

decision = decideProductionObservation(submitted("submitted"), observation("running"));
ok(decision.facts.map((fact) => fact.type).join(",") === "remote-started",
"submitted + running 单调推进 running");

decision = decideProductionObservation(submitted("running"), observation("pending"));
ok(decision.disposition === "noop" && decision.reason === "remote-regressed",
"远端 pending 回退不会让本地 running 回退");

decision = decideProductionObservation(submitted("ingesting"), observation("succeeded"));
ok(decision.disposition === "ingest" && decision.facts.length === 0,
"ingesting 重启只重试资产 ingest，不增加生成状态事件");

let cancelledRace = submitted("running");
cancelledRace = apply(cancelledRace, "cancellation-requested", 6, { reason: "operator cancel" });
decision = decideProductionObservation(cancelledRace, observation("cancelled", 7));
ok(decision.facts[0]?.type === "cancelled"
  && decision.facts[0].confirmation.kind === "remote-terminal-observation",
"只有匹配 terminal observation 才把取消请求映射为 cancelled 强事实");

decision = decideProductionObservation(submitted("running"), observation("cancelled"));
ok(decision.facts[0]?.type === "failed"
  && decision.facts[0].reason === "remote-cancelled-without-local-request",
"无本地取消请求的 provider cancelled 被视为异常失败");

decision = decideProductionObservation(submitted("running"), observation("not-found"));
ok(decision.disposition === "manual-attention" && decision.facts.length === 0,
"not-found 默认保持人工对账，不自动 orphan/failed");

decision = decideProductionObservation(submitted("running"), observation("failed"));
ok(decision.facts[0]?.type === "failed"
  && decision.facts[0].reason === "remote-failed:execution_error:RuntimeError",
"remote failed 只持久化已 allowlist 的稳定类别");

ok(throws(() => parseRemoteObservation({
  ...observation("failed"),
  errorSummary: "token=super-secret https://evil.example/story",
}), "persistence-safe"), "可疑远端错误文本不能进入 reconciliation fact");

ok(throws(() => parseRemoteObservation({
  ...observation("succeeded"),
  outputs: [{
    nodeId: "9", kind: "video", filename: "../secret.mp4", subfolder: "", folderType: "output",
  }],
}), "unsafe"), "output locator 路径穿越在 durable decision 前被拒绝");

ok(throws(() => decideProductionObservation(submitted("running"), {
  ...observation("running"), remoteJobId: "22222222-2222-4222-8222-222222222222",
}), "remote tuple"), "另一 remote job 的 observation 不能推进本 task");

// —— §4.5 locator 按 source 分支：缺省即 comfy-view，写入侧尚未落 source ——
const succeeded = observation("succeeded");
const taggedComfy = parseRemoteObservation({
  ...succeeded,
  outputs: [{ source: "comfy-view", ...succeeded.outputs[0]! }],
});
ok(JSON.stringify(taggedComfy.outputs) === JSON.stringify(succeeded.outputs),
"source: comfy-view 与缺省读法一致，归一化后 ingest 请求体字节不变");
ok(throws(() => parseRemoteObservation({
  ...succeeded,
  outputs: [{ source: "provider-output", remoteJobId: REMOTE, outputIndex: 0, role: "primary", kind: "video" }],
}), "openOutput 取回路径尚未装配"),
"provider-output locator 在 ingest kernel 装配前 fail-closed 拒绝");
ok(throws(() => parseRemoteObservation({
  ...succeeded, outputs: [{ source: "provider-url", ...succeeded.outputs[0]! }],
}), "must be comfy-view or provider-output"), "未知 locator source 被拒绝");

if (fails) {
  console.error(`PRODUCTION_RECONCILE_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_RECONCILE_OK");
