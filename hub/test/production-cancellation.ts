// Strong cancellation evidence and exact document-revision invariants.
import type { CancelResult } from "../src/production-adapter.ts";
import {
  ProductionError,
  parseProductionState,
  parseProductionTaskEvent,
  taskFromCreate,
  transitionProductionTask,
  type AssetRef,
  type ProductionTaskCreate,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import { buildProductionReadModel } from "../src/production-read-model.ts";

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
const PROJECT = "demo";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const BACKEND_A = "comfy-prod-a";
const BACKEND_B = "comfy-prod-b";
const REMOTE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REMOTE_ID = "22222222-2222-4222-8222-222222222222";
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;

const asset = (uri: string, sha256: string): AssetRef => ({
  version: 1,
  uri,
  sha256,
  byteLength: 123,
  mediaType: "application/json",
});

const create = (id: string): ProductionTaskCreate => ({
  version: 1,
  id,
  idempotencyKey: `idem-${id}`,
  subject: {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: {
        version: 1,
        episodeId: "ep-001",
        revision: 1,
        source: asset("s3://writing-loop-assets/demo/episode-001.json", SHA_A),
      },
      shotId: "shot-001",
      revision: 1,
      source: asset("s3://writing-loop-assets/demo/shot-001.json", SHA_B),
    },
  },
  createdAt: at(0),
});

const eventBase = (type: ProductionTaskEvent["type"], taskId: string, eventId: string, expectedRevision: number, second: number) => ({
  version: 1,
  type,
  eventId,
  taskId,
  expectedRevision,
  occurredAt: at(second),
});

let local = taskFromCreate(create("take-local"));
local = transitionProductionTask(local, parseProductionTaskEvent({
  ...eventBase("cancellation-requested", local.id, "local-request", 1, 1),
  reason: "cancel before dispatch",
}));

ok(throwsProduction(() => parseProductionTaskEvent({
  ...eventBase("cancelled", local.id, "legacy-cancelled", 2, 2),
  reason: "HTTP 200 accepted",
}), "confirmation"), "legacy cancelled event 缺少强证据时被 strict parser 拒绝");

const acceptedRequest: CancelResult = {
  remoteJobId: REMOTE_ID,
  accepted: true,
  confirmed: false,
  runningInterruptRequested: true,
  observedAt: at(2),
};
ok(throwsProduction(() => parseProductionTaskEvent({
  ...eventBase("cancelled", local.id, "accepted-is-not-confirmed", 2, 2),
  reason: "HTTP 200 accepted",
  confirmation: acceptedRequest,
}), "kind"), "CancelResult accepted=true/confirmed=false 的结构不能冒充 cancellation confirmation");

ok(throwsProduction(() => transitionProductionTask(local, parseProductionTaskEvent({
  ...eventBase("cancelled", local.id, "remote-on-local", 2, 2),
  reason: "wrong evidence kind",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: REMOTE_ID,
    state: "cancelled",
    observedAt: at(2),
    responseDigest: SHA_A,
  },
})), "remote tuple/outbox"), "提交前取消不能伪造 remote terminal observation");

local = transitionProductionTask(local, parseProductionTaskEvent({
  ...eventBase("cancelled", local.id, "local-confirmed", 2, 2),
  reason: "no remote submission existed",
  confirmation: { version: 1, kind: "local-no-submission" },
}));
const localState = parseProductionState({
  version: 1,
  workspaceId: WS,
  project: PROJECT,
  revision: 3,
  updatedAt: at(2),
  tasks: [local],
});
const localView = buildProductionReadModel(localState);
ok(local.status === "cancelled" && local.cancellationConfirmation?.kind === "local-no-submission"
  && localView.tasks[0]?.cancellationConfirmation?.kind === "local-no-submission",
"只有无 remote tuple/outbox 的提交前取消才能持久化并投影 local-no-submission confirmation");

let remote = taskFromCreate(create("take-remote"));
remote = transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("dispatch-requested", remote.id, "remote-dispatch", 1, 1),
}));
remote = transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("submission-started", remote.id, "remote-submit", 2, 2),
  backendInstanceId: BACKEND_A,
  remoteJobId: REMOTE_ID,
  requestDigest: SHA_A,
}));
remote = transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("cancellation-requested", remote.id, "remote-request", 3, 3),
  reason: "operator cancelled after POST began",
}));

ok(throwsProduction(() => transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "local-on-remote", 4, 4),
  reason: "wrong local evidence",
  confirmation: { version: 1, kind: "local-no-submission" },
})), "不能用于 requestedFrom=submitting"), "已开始提交的任务不能用 local-no-submission 终结");

ok(throwsProduction(() => transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "wrong-remote-id", 4, 4),
  reason: "mismatched observation",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: OTHER_REMOTE_ID,
    state: "cancelled",
    observedAt: at(4),
    responseDigest: SHA_B,
  },
})), "remoteJobId 不匹配"), "远端取消证据必须绑定 task 已预落盘的 remoteJobId");

ok(throwsProduction(() => transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "wrong-backend", 4, 4),
  reason: "same UUID observed on another backend",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_B,
    remoteJobId: REMOTE_ID,
    state: "cancelled",
    observedAt: at(4),
    responseDigest: SHA_B,
  },
})), "backendInstanceId 不匹配"), "同 UUID 的另一 backend observation 不能终结本 task");

ok(throwsProduction(() => parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "non-terminal-state", 4, 4),
  reason: "request accepted only",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: REMOTE_ID,
    state: "running",
    observedAt: at(4),
    responseDigest: SHA_B,
  },
}), "必须是 cancelled"), "running/pending observation 不能冒充 terminal cancelled evidence");

ok(throwsProduction(() => transitionProductionTask(remote, parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "stale-observation", 4, 4),
  reason: "observation predates request",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: REMOTE_ID,
    state: "cancelled",
    observedAt: at(2),
    responseDigest: SHA_B,
  },
})), "必须位于取消请求"), "远端 terminal observation 不能早于 durable cancellation request");

const remoteCancelledEvent = parseProductionTaskEvent({
  ...eventBase("cancelled", remote.id, "remote-confirmed", 4, 5),
  reason: "inspect observed terminal cancellation",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: REMOTE_ID,
    state: "cancelled",
    observedAt: at(4),
    responseDigest: SHA_B,
  },
});
remote = transitionProductionTask(remote, remoteCancelledEvent);
const remoteState = parseProductionState({
  version: 1,
  workspaceId: WS,
  project: PROJECT,
  revision: 5,
  updatedAt: at(5),
  tasks: [remote],
});
const remoteView = buildProductionReadModel(remoteState);
ok(remote.status === "cancelled" && remote.submissionOutbox?.state === "acknowledged"
  && remote.cancellationConfirmation?.kind === "remote-terminal-observation"
  && remote.cancellationConfirmation.responseDigest === SHA_B
  && remoteView.tasks[0]?.cancellationConfirmation?.kind === "remote-terminal-observation"
  && remoteView.summary.terminal === 1 && remoteView.summary.active === 0,
"匹配的 cancelled terminal observation 才会确认取消、强化 outbox fact 并投影证据");

let delayed = taskFromCreate(create("take-delayed-cancel"));
delayed = transitionProductionTask(delayed, parseProductionTaskEvent({
  ...eventBase("dispatch-requested", delayed.id, "delayed-dispatch", 1, 1),
}));
delayed = transitionProductionTask(delayed, parseProductionTaskEvent({
  ...eventBase("submission-started", delayed.id, "delayed-submit", 2, 2),
  backendInstanceId: BACKEND_A,
  remoteJobId: OTHER_REMOTE_ID,
  requestDigest: SHA_A,
}));
delayed = transitionProductionTask(delayed, parseProductionTaskEvent({
  ...eventBase("cancellation-requested", delayed.id, "delayed-request", 3, 3),
  reason: "cancel while submit is racing",
}));
delayed = transitionProductionTask(delayed, parseProductionTaskEvent({
  ...eventBase("remote-started", delayed.id, "delayed-running", 4, 4),
  backendInstanceId: BACKEND_A,
  remoteJobId: OTHER_REMOTE_ID,
}));
delayed = transitionProductionTask(delayed, parseProductionTaskEvent({
  ...eventBase("cancelled", delayed.id, "delayed-confirmed", 5, 6),
  reason: "later inspect finally observed cancelled",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: OTHER_REMOTE_ID,
    state: "cancelled",
    observedAt: at(5),
    responseDigest: SHA_B,
  },
}));
ok(delayed.status === "cancelled" && delayed.cancellationRequest?.requestedFrom === "submitting"
  && delayed.cancellationConfirmation?.kind === "remote-terminal-observation",
"取消竞态先恢复到 running 后，稍晚到达的匹配 cancelled observation 仍能落成终态");

let unsolicited = taskFromCreate(create("take-unsolicited-cancel"));
unsolicited = transitionProductionTask(unsolicited, parseProductionTaskEvent({
  ...eventBase("dispatch-requested", unsolicited.id, "unsolicited-dispatch", 1, 1),
}));
unsolicited = transitionProductionTask(unsolicited, parseProductionTaskEvent({
  ...eventBase("submission-started", unsolicited.id, "unsolicited-submit", 2, 2),
  backendInstanceId: BACKEND_A,
  remoteJobId: OTHER_REMOTE_ID,
  requestDigest: SHA_A,
}));
unsolicited = transitionProductionTask(unsolicited, parseProductionTaskEvent({
  ...eventBase("submission-confirmed", unsolicited.id, "unsolicited-confirmed", 3, 3),
  backendInstanceId: BACKEND_A,
  remoteJobId: OTHER_REMOTE_ID,
}));
ok(throwsProduction(() => transitionProductionTask(unsolicited, parseProductionTaskEvent({
  ...eventBase("cancelled", unsolicited.id, "unsolicited-terminal", 4, 4),
  reason: "provider cancelled without a local request",
  confirmation: {
    version: 1,
    kind: "remote-terminal-observation",
    backendInstanceId: BACKEND_A,
    remoteJobId: OTHER_REMOTE_ID,
    state: "cancelled",
    observedAt: at(4),
    responseDigest: SHA_B,
  },
})), "缺少 durable cancellationRequest"),
"新增 cancelled 边不会允许 provider 在无本地取消请求时伪造正常取消终态");

ok(throwsProduction(() => parseProductionState({
  version: 1,
  workspaceId: WS,
  project: PROJECT,
  revision: Number.MAX_SAFE_INTEGER,
  updatedAt: at(5),
  tasks: [],
}), "必须精确等于"), "空账本拒绝 MAX_SAFE_INTEGER revision，不能制造永久写拒绝服务");

ok(throwsProduction(() => parseProductionState({
  ...remoteState,
  revision: remoteState.revision + 1,
}), "期望 5"), "document revision 漂移会按 task 创建数 + event receipt 数精确拒绝");

ok(throwsProduction(() => buildProductionReadModel({
  ...remoteState,
  revision: Number.MAX_SAFE_INTEGER,
}), "必须精确等于"), "read model 不投影伪造 revision 或 SSE cursor");

if (fails) {
  console.error(`PRODUCTION_CANCELLATION_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_CANCELLATION_OK");
