// Production domain/store regression suite: immutable refs, monotonic transitions and durable truth.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionError,
  canTransitionProductionTask,
  compareProductionAscii,
  parseAssetRef,
  parseProductionState,
  type AssetRef,
  type ProductionTaskCreate,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import { buildProductionReadModel } from "../src/production-read-model.ts";
import {
  PRODUCTION_ACQUISITION_GATE_FILE,
  PRODUCTION_LOCK_FILE,
  ProductionStore,
  productionStatePath,
  readProductionState,
} from "../src/production-store.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsProduction = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof ProductionError && error.message.includes(needle); }
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const asset = (uri = "s3://writing-loop-assets/demo/episode-001.md", sha256 = SHA_A): AssetRef => ({
  version: 1,
  uri,
  sha256,
  byteLength: 123,
  mediaType: "text/markdown",
});
const createTask = (id = "take-001", idempotencyKey = "idem-take-001"): ProductionTaskCreate => ({
  version: 1,
  id,
  idempotencyKey,
  subject: {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: { version: 1, episodeId: "ep-001", revision: 7, source: asset() },
      shotId: "shot-001",
      revision: 3,
      source: asset("s3://writing-loop-assets/demo/shot-001.json", SHA_B),
    },
  },
  createdAt: at(1),
});
const event = (
  type: ProductionTaskEvent["type"],
  eventId: string,
  expectedRevision: number,
  second: number,
  extra: Record<string, unknown> = {},
): ProductionTaskEvent => ({
  version: 1,
  type,
  eventId,
  taskId: "take-001",
  expectedRevision,
  occurredAt: at(second),
  ...extra,
} as ProductionTaskEvent);

const forTask = (
  taskId: string,
  type: ProductionTaskEvent["type"],
  eventId: string,
  expectedRevision: number,
  second: number,
  extra: Record<string, unknown> = {},
): ProductionTaskEvent => ({ ...event(type, eventId, expectedRevision, second, extra), taskId });

const lockChildren: ChildProcess[] = [];
const productionStoreModule = new URL("../src/production-store.ts", import.meta.url).href;

ok([
  "take_a", "take-a", "take:1", "take-Z", "take._", "take-A",
].sort(compareProductionAscii).join(",") === "take-A,take-Z,take-a,take._,take:1,take_a",
"production protocol ID 使用 ASCII/code-unit 顺序，不依赖主机 locale/ICU");

function spawnLockHolder(root: string, project: string, input: ProductionTaskCreate): ChildProcess {
  const script = `
    import { writeSync } from "node:fs";
    import { ProductionStore } from ${JSON.stringify(productionStoreModule)};
    const store = new ProductionStore(${JSON.stringify(root)}, ${JSON.stringify(WS)}, ${JSON.stringify(project)}, {
      hooks: { afterLock: () => {
        writeSync(1, "LOCKED\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } },
    });
    store.create(${JSON.stringify(input)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  lockChildren.push(child);
  return child;
}

function spawnPausedRecovery(
  root: string,
  project: string,
  input: ProductionTaskCreate,
  releaseFile: string,
): ChildProcess {
  const script = `
    import { existsSync, writeSync } from "node:fs";
    import { ProductionStore } from ${JSON.stringify(productionStoreModule)};
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const store = new ProductionStore(${JSON.stringify(root)}, ${JSON.stringify(WS)}, ${JSON.stringify(project)}, {
      hooks: {
        beforeDeadOwnerRecovery: () => {
          writeSync(1, "RECOVERING\\n");
          while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(sleeper, 0, 0, 20);
        },
        afterLock: () => {
          writeSync(1, "LOCKED\\n");
          Atomics.wait(sleeper, 0, 0);
        },
      },
    });
    store.create(${JSON.stringify(input)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  lockChildren.push(child);
  return child;
}

function waitForOutput(child: ChildProcess, needle: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let output = "";
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onEnd);
      child.off("exit", onEnd);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(needle)) finish(true);
    };
    const onEnd = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout?.on("data", onData);
    child.once("error", onEnd);
    child.once("exit", onEnd);
  });
}

const waitForLocked = (child: ChildProcess): Promise<boolean> => waitForOutput(child, "LOCKED\n");

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(value);
    };
    const onError = (): void => finish(true);
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-")));
try {
  const projectDir = join(root, ".writing-loop", "demo");
  mkdirSync(projectDir, { recursive: true });
  const store = new ProductionStore(root, WS, "demo");

  const empty = store.read();
  ok(empty.revision === 0 && empty.tasks.length === 0 && empty.updatedAt === null,
    "missing production state 明确投影为空 v1，而非损坏或缓存猜测");

  const first = store.create(createTask());
  const replay = store.create(createTask());
  ok(first.created && !replay.created && replay.state.revision === 1 && replay.task.id === "take-001",
    "同一 idempotencyKey + 精确 subject 创建任务幂等且不增加 document revision");
  ok(throwsProduction(() => store.create(createTask("take-other", "idem-take-001")), "已绑定另一创建请求"),
    "idempotencyKey 不能被另一 take/subject 复用");
  ok(throwsProduction(() => store.create({ ...createTask(), createdAt: at(2) }), "已绑定另一创建请求"),
    "同一 idempotencyKey 也不能静默吞掉不同 createdAt 的非精确重放");

  let task = store.apply(event("dispatch-requested", "evt-01", 1, 2)).task;
  task = store.apply(event("submission-started", "evt-02", 2, 3, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "11111111-1111-4111-8111-111111111111",
    requestDigest: SHA_B,
  })).task;
  ok(task.status === "submitting" && task.submissionOutbox?.state === "pending"
    && task.remoteJobId === "11111111-1111-4111-8111-111111111111",
  "submission-started 在任何 POST 前原子持久化 backend、预分配 remote ID 与 outbox digest");

  const uncertainEvent = event("submission-uncertain", "evt-03", 3, 4, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "11111111-1111-4111-8111-111111111111",
    reason: "ack timeout",
  });
  const uncertain = store.apply(uncertainEvent);
  const replayEvent = store.apply(uncertainEvent);
  ok(uncertain.task.status === "submission-unknown" && uncertain.task.submissionOutbox?.state === "unknown"
    && !replayEvent.applied && replayEvent.state.revision === uncertain.state.revision,
  "提交响应丢失进入 submission-unknown；同 event replay 是零写入 no-op");
  ok(!canTransitionProductionTask("submission-unknown", "submitting")
    && throwsProduction(() => store.apply(event("submission-started", "evt-repost", 4, 5, {
      backendInstanceId: "comfy-prod-a",
      remoteJobId: "11111111-1111-4111-8111-111111111111",
      requestDigest: SHA_B,
    })), "非法 transition"),
  "submission-unknown 没有回到 submitting 的路径，领域层阻断盲目第二次 POST");

  task = store.apply(event("submission-confirmed", "evt-04", 4, 6, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "11111111-1111-4111-8111-111111111111",
  })).task;
  task = store.apply(event("remote-started", "evt-05", 5, 7, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "11111111-1111-4111-8111-111111111111",
  })).task;
  task = store.apply(event("ingestion-started", "evt-06", 6, 8)).task;
  task = store.apply(event("qc-requested", "evt-07", 7, 9, {
    assets: [asset("s3://writing-loop-assets/demo/take-001.mp4")],
    cost: { version: 1, state: "unknown", reason: "provider-not-reported" },
  })).task;
  task = store.apply(event("approved", "evt-08", 8, 10, { decidedBy: "producer-a", note: "continuity passed" })).task;
  ok(task.status === "approved" && task.revision === 9 && task.approval?.taskRevision === 8
    && task.approval.subjectRevision === 3 && task.assets.length === 1,
  "remote success 必须经过 ingest + QC，并把人工 approval 绑定精确 task/shot revision");
  const documentBeforeTerminalReplay = store.read().revision;
  ok(throwsProduction(() => store.apply(event("failed", "evt-after-terminal", 9, 11, { reason: "late failure" })), "终态"),
    "approved 终态拒绝乱序回退");
  ok(store.read().revision === documentBeforeTerminalReplay, "非法终态事件不改变权威文件");
  const futureApproval = structuredClone(store.read());
  futureApproval.tasks[0]!.approval!.decidedAt = at(11);
  ok(throwsProduction(() => parseProductionState(futureApproval), "审批时间漂移"),
    "approved parser 固化 approval.decidedAt===task.updatedAt，handoff 不能早于真实审批");

  const cancelProjectDir = join(root, ".writing-loop", "cancel-race");
  mkdirSync(cancelProjectDir, { recursive: true });
  const cancelStore = new ProductionStore(root, WS, "cancel-race");

  cancelStore.create(createTask("take-cancel-submit", "idem-cancel-submit"));
  cancelStore.apply(forTask("take-cancel-submit", "dispatch-requested", "cs-01", 1, 2));
  cancelStore.apply(forTask("take-cancel-submit", "submission-started", "cs-02", 2, 3, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "22222222-2222-4222-8222-222222222222",
    requestDigest: SHA_A,
  }));
  const submitCancellation = forTask("take-cancel-submit", "cancellation-requested", "cs-03", 3, 4, {
    reason: "producer changed direction",
  });
  let cancelledRace = cancelStore.apply(submitCancellation).task;
  cancelledRace = cancelStore.apply(forTask("take-cancel-submit", "submission-confirmed", "cs-04", 4, 5, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "22222222-2222-4222-8222-222222222222",
  })).task;
  ok(cancelledRace.status === "submitted"
    && cancelledRace.cancellationRequest?.requestedFrom === "submitting"
    && cancelledRace.cancellationRequest.reason === "producer changed direction",
  "取消输掉提交竞态时恢复到 submitted，并永久保留原始取消来源/原因");
  cancelledRace = cancelStore.apply(forTask("take-cancel-submit", "remote-started", "cs-05", 5, 6, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "22222222-2222-4222-8222-222222222222",
  })).task;
  cancelledRace = cancelStore.apply(forTask("take-cancel-submit", "ingestion-started", "cs-06", 6, 7)).task;
  cancelledRace = cancelStore.apply(forTask("take-cancel-submit", "qc-requested", "cs-07", 7, 8, {
    assets: [asset("s3://writing-loop-assets/demo/cancel-race-submit.mp4")],
    cost: { version: 1, state: "unknown", reason: "provider-not-reported" },
  })).task;
  cancelledRace = cancelStore.apply(forTask("take-cancel-submit", "approved", "cs-08", 8, 9, {
    decidedBy: "producer-a", note: "keep completed take",
  })).task;
  ok(cancelledRace.status === "approved" && cancelledRace.cancellationRequest?.requestedFrom === "submitting"
    && cancelledRace.eventReceipts.length === 8
    && cancelledRace.eventReceipts.every((receipt) => receipt.payloadDigest.length === 64),
  "取消审计事实跨 running/ingesting/qc/approval 保留，事件收据绑定 canonical SHA-256");
  const cancelledRaceView = buildProductionReadModel(cancelStore.read()).tasks
    .find((row) => row.id === "take-cancel-submit");
  ok(cancelledRaceView?.cancellationRequest?.requestedFrom === "submitting"
    && cancelledRaceView.cancellationRequest.reason === "producer changed direction",
  "取消输掉竞态后的来源/原因完整投影到 Studio 共用 read model");

  const reorderedExactReplay: ProductionTaskEvent = {
    reason: "producer changed direction",
    occurredAt: at(4),
    expectedRevision: 3,
    taskId: "take-cancel-submit",
    eventId: "cs-03",
    type: "cancellation-requested",
    version: 1,
  };
  const exactReplay = cancelStore.apply(reorderedExactReplay);
  ok(!exactReplay.applied && exactReplay.task.revision === cancelledRace.revision,
    "event key 顺序不同但 canonical payload 相同仍是零写入精确重放");
  const beforeConflictingReplay = cancelStore.read().revision;
  const conflictingCancellation: ProductionTaskEvent = {
    version: 1,
    type: "cancellation-requested",
    eventId: "cs-03",
    taskId: "take-cancel-submit",
    expectedRevision: 3,
    occurredAt: at(4),
    reason: "different cancellation intent",
  };
  ok(throwsProduction(() => cancelStore.apply(conflictingCancellation), "冲突重放")
    && cancelStore.read().revision === beforeConflictingReplay,
  "同 eventId 的不同 canonical payload 硬错且不增加 document revision");

  cancelStore.create(createTask("take-cancel-ingest", "idem-cancel-ingest"));
  cancelStore.apply(forTask("take-cancel-ingest", "dispatch-requested", "ci-01", 1, 10));
  cancelStore.apply(forTask("take-cancel-ingest", "submission-started", "ci-02", 2, 11, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "33333333-3333-4333-8333-333333333333",
    requestDigest: SHA_B,
  }));
  cancelStore.apply(forTask("take-cancel-ingest", "submission-confirmed", "ci-03", 3, 12, {
    backendInstanceId: "comfy-prod-a", remoteJobId: "33333333-3333-4333-8333-333333333333",
  }));
  cancelStore.apply(forTask("take-cancel-ingest", "remote-started", "ci-04", 4, 13, {
    backendInstanceId: "comfy-prod-a", remoteJobId: "33333333-3333-4333-8333-333333333333",
  }));
  cancelStore.apply(forTask("take-cancel-ingest", "ingestion-started", "ci-05", 5, 14));
  cancelStore.apply(forTask("take-cancel-ingest", "cancellation-requested", "ci-06", 6, 15, {
    reason: "cancel arrived after download began",
  }));
  const beforeInvalidCancelRecovery = cancelStore.read().revision;
  ok(throwsProduction(() => cancelStore.apply(forTask(
    "take-cancel-ingest", "submission-confirmed", "ci-invalid", 7, 16, {
      backendInstanceId: "comfy-prod-a", remoteJobId: "33333333-3333-4333-8333-333333333333",
    },
  )), "不允许安全恢复") && cancelStore.read().revision === beforeInvalidCancelRecovery,
  "cancel-requested 只能按 durable requestedFrom 单调恢复，禁止 ingesting 回退到 submitted");
  let ingestRecovery = cancelStore.apply(forTask("take-cancel-ingest", "qc-requested", "ci-07", 7, 16, {
    assets: [asset("s3://writing-loop-assets/demo/cancel-race-ingest.mp4")],
    cost: { version: 1, state: "unknown", reason: "provider-not-reported" },
  })).task;
  const qcAttention = buildProductionReadModel(cancelStore.read());
  ok(qcAttention.summary.needsAttention === 1
    && qcAttention.tasks.find((row) => row.id === "take-cancel-ingest")?.status === "qc-pending",
  "read model 将等待人工 QC 的 take 计入 needsAttention，与 Studio 卡片/汇总一致");
  ingestRecovery = cancelStore.apply(forTask("take-cancel-ingest", "approved", "ci-08", 8, 17, {
    decidedBy: "producer-a", note: "ingest completed before cancellation",
  })).task;
  ok(ingestRecovery.status === "approved" && ingestRecovery.cancellationRequest?.requestedFrom === "ingesting",
    "ingesting 取消输掉竞态后可安全继续到 qc-pending 与 approval");

  cancelStore.create(createTask("take-cancel-qc", "idem-cancel-qc"));
  cancelStore.apply(forTask("take-cancel-qc", "dispatch-requested", "cq-01", 1, 20));
  cancelStore.apply(forTask("take-cancel-qc", "submission-started", "cq-02", 2, 21, {
    backendInstanceId: "comfy-prod-a",
    remoteJobId: "44444444-4444-4444-8444-444444444444",
    requestDigest: SHA_A,
  }));
  cancelStore.apply(forTask("take-cancel-qc", "submission-confirmed", "cq-03", 3, 22, {
    backendInstanceId: "comfy-prod-a", remoteJobId: "44444444-4444-4444-8444-444444444444",
  }));
  cancelStore.apply(forTask("take-cancel-qc", "remote-started", "cq-04", 4, 23, {
    backendInstanceId: "comfy-prod-a", remoteJobId: "44444444-4444-4444-8444-444444444444",
  }));
  cancelStore.apply(forTask("take-cancel-qc", "ingestion-started", "cq-05", 5, 24));
  cancelStore.apply(forTask("take-cancel-qc", "qc-requested", "cq-06", 6, 25, {
    assets: [asset("s3://writing-loop-assets/demo/cancel-race-qc.mp4")],
    cost: { version: 1, state: "unknown", reason: "provider-not-reported" },
  }));
  cancelStore.apply(forTask("take-cancel-qc", "cancellation-requested", "cq-07", 7, 26, {
    reason: "late cancel while producer was reviewing",
  }));
  const qcRecovery = cancelStore.apply(forTask("take-cancel-qc", "approved", "cq-08", 8, 27, {
    decidedBy: "producer-a", note: "approval won the cancellation race",
  })).task;
  ok(qcRecovery.status === "approved" && qcRecovery.approval?.taskRevision === 8
    && qcRecovery.cancellationRequest?.requestedFrom === "qc-pending",
  "qc-pending 的取消请求不会吞掉已完成 take，人工审批可直接裁决竞态结果");
  const forgedCancellationSource = structuredClone(cancelStore.read());
  const forgedTask = forgedCancellationSource.tasks.find((row) => row.id === "take-cancel-qc")!;
  forgedTask.cancellationRequest!.requestedFrom = "planned";
  ok(throwsProduction(() => parseProductionState(forgedCancellationSource), "不得伪造 remote submission"),
    "parser 约束 cancellationRequest 来源阶段，拒绝与 durable remote facts 矛盾的伪造来源");

  const second = store.create(createTask("take-002", "idem-take-002"));
  const secondDispatch: ProductionTaskEvent = {
    ...event("dispatch-requested", "evt-20", 1, 12), taskId: "take-002",
  };
  store.apply(secondDispatch);
  const duplicateRemote: ProductionTaskEvent = {
    ...event("submission-started", "evt-21", 2, 13, {
      backendInstanceId: "comfy-prod-a",
      remoteJobId: "11111111-1111-4111-8111-111111111111",
      requestDigest: SHA_A,
    }),
    taskId: "take-002",
  };
  const beforeDuplicate = store.read().revision;
  ok(second.created && throwsProduction(() => store.apply(duplicateRemote), "重复 remote job"),
    "(backendInstanceId, remoteJobId) 从 submitting 阶段起即为全项目唯一");
  ok(store.read().revision === beforeDuplicate, "remote tuple 冲突在创建 temp file 前失败且保持旧状态");

  const beforeFault = readFileSync(productionStatePath(root, "demo"), "utf8");
  const faultStore = new ProductionStore(root, WS, "demo", {
    hooks: { beforeRename: () => { throw new Error("injected crash before rename"); } },
  });
  const invalidOrder: ProductionTaskEvent = {
    ...event("failed", "evt-fault", 2, 14, { reason: "test crash" }), taskId: "take-002",
  };
  ok(throwsProduction(() => faultStore.apply(invalidOrder), "无法原子写入"),
    "rename 前故障作为写失败上报");
  ok(readFileSync(productionStatePath(root, "demo"), "utf8") === beforeFault
    && !existsSync(join(projectDir, PRODUCTION_LOCK_FILE)),
  "rename 前故障保留完整旧文件并释放自有 lock");

  const readModel = buildProductionReadModel(store.read());
  ok(readModel.summary.total === 2 && readModel.summary.byStatus.approved === 1
    && readModel.summary.cost.actual.state === "unknown"
    && readModel.summary.cost.actual.amountMicros === null,
  "read model 不把 provider 未上报的成本伪装成 0");
  const splitCostState = structuredClone(store.read());
  splitCostState.tasks[0]!.cost = {
    version: 1, state: "known", currency: "USD", amountMicros: 2_000_000, basis: "billed",
  };
  splitCostState.tasks[1]!.cost = {
    version: 1, state: "known", currency: "USD", amountMicros: 5_000_000, basis: "estimated",
  };
  const splitCost = buildProductionReadModel(splitCostState).summary.cost;
  ok(splitCost.actual.state === "unknown" && splitCost.actual.amountMicros === null
    && splitCost.actual.knownAmountMicros === 2_000_000 && splitCost.actual.unknownTasks === 1
    && splitCost.estimatedAmountMicros === 5_000_000 && splitCost.estimatedTasks === 1,
  "read model 将 estimated 与 actual 分栏，估算绝不冒充已发生成本");
  ok(throwsProduction(() => readProductionState(root, "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "demo"), "不能作为"),
    "production state 与 workspaceId + project 绑定，拒绝跨 workspace 读取");

  ok(throwsProduction(() => parseAssetRef({ ...asset("file:///tmp/take.mp4") }), "scheme"),
    "AssetRef 拒绝本机 file URI");
  ok(throwsProduction(() => parseAssetRef({ ...asset("https://objects.example/take.mp4?token=secret") }), "query"),
    "AssetRef 拒绝 signed URL/query token");
  ok(throwsProduction(() => parseProductionState({ ...store.read(), futureField: true }), "不支持字段"),
    "权威 v1 DTO 严格拒绝未知字段，避免静默协议漂移");
  ok(throwsProduction(() => parseProductionState({ ...store.read(), updatedAt: at(0) }), "时间回拨"),
    "production document updatedAt 不能早于 task/approval facts，避免伪造早期 handoff provenance");

  writeFileSync(join(projectDir, PRODUCTION_LOCK_FILE), "foreign lock\n");
  ok(throwsProduction(() => store.create(createTask("take-003", "idem-take-003")), "另一进程"),
    "既有 O_EXCL lock 阻断并发 writer");
  ok(readFileSync(join(projectDir, PRODUCTION_LOCK_FILE), "utf8") === "foreign lock\n",
    "writer 绝不删除不属于自己的 lock");
  unlinkSync(join(projectDir, PRODUCTION_LOCK_FILE));

  for (const project of ["crash-lock", "replacement-lock", "concurrent-recovery", "gate-crash"]) {
    mkdirSync(join(root, ".writing-loop", project), { recursive: true });
  }
  const crashInput = createTask("take-crash-lock", "idem-crash-lock");
  const liveChild = spawnLockHolder(root, "crash-lock", crashInput);
  const liveReady = await waitForLocked(liveChild);
  ok(liveReady, "真实子进程已持有并 fsync production O_EXCL lock");
  if (liveReady) {
    const crashLockFile = join(root, ".writing-loop", "crash-lock", PRODUCTION_LOCK_FILE);
    const liveBytes = readFileSync(crashLockFile, "utf8");
    const crashStore = new ProductionStore(root, WS, "crash-lock");
    ok(throwsProduction(() => crashStore.create(crashInput), "不能安全接管")
      && readFileSync(crashLockFile, "utf8") === liveBytes,
    "kill(pid, 0) 可见的活 owner 永不被 stale recovery 删除或改写");
    await killAndWait(liveChild);
    const recovered = crashStore.create(crashInput);
    ok(recovered.created && !existsSync(crashLockFile),
      "SIGKILL 后的同 uid/hostname、严格 metadata 残锁可按 dead PID 安全接管");
  }

  const concurrentInput = createTask("take-concurrent-recovery", "idem-concurrent-recovery");
  const staleSeed = spawnLockHolder(root, "concurrent-recovery", concurrentInput);
  const staleSeedReady = await waitForLocked(staleSeed);
  ok(staleSeedReady, "并发恢复 fixture 先由真实子进程持有 durable 主锁");
  if (staleSeedReady) {
    await killAndWait(staleSeed);
    const concurrentDir = join(root, ".writing-loop", "concurrent-recovery");
    const concurrentLockFile = join(concurrentDir, PRODUCTION_LOCK_FILE);
    const concurrentGateFile = join(concurrentDir, PRODUCTION_ACQUISITION_GATE_FILE);
    const recoveryRelease = join(concurrentDir, ".release-recovery");
    const staleBytes = readFileSync(concurrentLockFile, "utf8");
    const firstRecoverer = spawnPausedRecovery(root, "concurrent-recovery", concurrentInput, recoveryRelease);
    const firstInsideGate = await waitForOutput(firstRecoverer, "RECOVERING\n");
    ok(firstInsideGate && existsSync(concurrentGateFile)
      && readFileSync(concurrentLockFile, "utf8") === staleBytes,
    "首个恢复者在 acquisition gate 内验证旧锁，尚未删除可信残锁");

    const secondRecoverer = spawnLockHolder(root, "concurrent-recovery", concurrentInput);
    const secondExited = await waitForExit(secondRecoverer, 3_000);
    ok(secondExited && readFileSync(concurrentLockFile, "utf8") === staleBytes,
      "第二个真实恢复进程被 O_EXCL acquisition gate 挡住，不能进入主锁 critical section");

    writeFileSync(recoveryRelease, "continue\n");
    const firstEntered = await waitForLocked(firstRecoverer);
    const successorBytes = firstEntered ? readFileSync(concurrentLockFile, "utf8") : "";
    let successorPid: number | null = null;
    try { successorPid = Number((JSON.parse(successorBytes) as { pid?: unknown }).pid); } catch { /* assertion below */ }
    const concurrentStore = new ProductionStore(root, WS, "concurrent-recovery");
    const liveSuccessorRejected = firstEntered
      && throwsProduction(() => concurrentStore.create(concurrentInput), "不能安全接管");
    ok(firstEntered && secondExited && successorPid === firstRecoverer.pid
      && !existsSync(concurrentGateFile) && liveSuccessorRejected
      && readFileSync(concurrentLockFile, "utf8") === successorBytes,
    "双恢复者最多一个进入 critical section，后继活主锁不会被 loser/后续 contender 删除");

    await killAndWait(firstRecoverer);
    const finalRecovery = concurrentStore.create(concurrentInput);
    ok(finalRecovery.created && !existsSync(concurrentLockFile) && !existsSync(concurrentGateFile),
      "并发胜者 SIGKILL 后仍可通过新 gate 安全恢复其可信主锁");
  }

  const gateCrashInput = createTask("take-gate-crash", "idem-gate-crash");
  const gateSeed = spawnLockHolder(root, "gate-crash", gateCrashInput);
  const gateSeedReady = await waitForLocked(gateSeed);
  ok(gateSeedReady, "gate crash fixture 取得真实 durable 主锁");
  if (gateSeedReady) {
    await killAndWait(gateSeed);
    const gateCrashDir = join(root, ".writing-loop", "gate-crash");
    const gateCrashLock = join(gateCrashDir, PRODUCTION_LOCK_FILE);
    const gateCrashGate = join(gateCrashDir, PRODUCTION_ACQUISITION_GATE_FILE);
    const gateCrashRelease = join(gateCrashDir, ".never-release");
    const staleMainBytes = readFileSync(gateCrashLock, "utf8");
    const gateVictim = spawnPausedRecovery(root, "gate-crash", gateCrashInput, gateCrashRelease);
    const gateHeld = await waitForOutput(gateVictim, "RECOVERING\n");
    ok(gateHeld && existsSync(gateCrashGate), "恢复者只在极短主锁 acquisition 窗口持有 gate");
    if (gateHeld) {
      await killAndWait(gateVictim);
      const residualGateBytes = readFileSync(gateCrashGate, "utf8");
      const gateCrashStore = new ProductionStore(root, WS, "gate-crash");
      ok(throwsProduction(() => gateCrashStore.create(gateCrashInput), "acquisition gate")
        && readFileSync(gateCrashGate, "utf8") === residualGateBytes
        && readFileSync(gateCrashLock, "utf8") === staleMainBytes,
      "gate 自身若 SIGKILL 残留则 fail-closed，绝不递归执行有 TOCTOU 的自动接管");
      unlinkSync(gateCrashGate); // 测试模拟人工核验 owner 已死后的显式修复。
      ok(gateCrashStore.create(gateCrashInput).created && !existsSync(gateCrashLock),
        "人工审计并移除残 gate 后，主 operation lock 仍可走可信 dead-owner recovery");
    }
  }

  const replacementInput = createTask("take-replacement-lock", "idem-replacement-lock");
  const replacementChild = spawnLockHolder(root, "replacement-lock", replacementInput);
  const replacementReady = await waitForLocked(replacementChild);
  ok(replacementReady, "replacement race fixture 取得可信 production lock");
  if (replacementReady) {
    await killAndWait(replacementChild);
    const replacementFile = join(root, ".writing-loop", "replacement-lock", PRODUCTION_LOCK_FILE);
    const replacementStore = new ProductionStore(root, WS, "replacement-lock", {
      hooks: {
        beforeDeadOwnerRecovery: (file) => {
          unlinkSync(file);
          writeFileSync(file, "replacement lock\n", { mode: 0o600 });
        },
      },
    });
    ok(throwsProduction(() => replacementStore.create(replacementInput), "不能安全接管")
      && readFileSync(replacementFile, "utf8") === "replacement lock\n",
    "dead-owner 检查后的 replacement inode 永不被 recovery 删除");
  }

  for (const project of ["corrupt", "symlink", "hardlink", "oversize"]) {
    mkdirSync(join(root, ".writing-loop", project), { recursive: true });
  }
  writeFileSync(productionStatePath(root, "corrupt"), "{broken");
  ok(throwsProduction(() => readProductionState(root, WS, "corrupt"), "JSON"),
    "corrupt 权威 state 硬错，不降级为空缓存");

  const outside = join(root, "outside-state.json");
  writeFileSync(outside, JSON.stringify({ version: 1 }));
  symlinkSync(outside, productionStatePath(root, "symlink"));
  ok(throwsProduction(() => readProductionState(root, WS, "symlink"), "单链接普通文件"),
    "production state 拒绝 symlink");
  unlinkSync(productionStatePath(root, "symlink"));

  linkSync(outside, productionStatePath(root, "hardlink"));
  ok(throwsProduction(() => readProductionState(root, WS, "hardlink"), "单链接普通文件"),
    "production state 拒绝 hardlink");
  unlinkSync(productionStatePath(root, "hardlink"));

  writeFileSync(productionStatePath(root, "oversize"), "x".repeat(1_025));
  ok(throwsProduction(() => readProductionState(root, WS, "oversize", { maxBytes: 1_024 }), "安全读取上限"),
    "production state 在 parse 前执行严格 byte 上限");
} finally {
  await Promise.all(lockChildren.map((child) => killAndWait(child)));
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
