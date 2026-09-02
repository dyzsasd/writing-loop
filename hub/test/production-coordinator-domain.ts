// Phase 3B coordinator-control DTO regression suite.
import {
  MAX_COORDINATOR_OUTPUTS,
  MAX_COORDINATOR_TASKS,
  emptyProductionCoordinatorControlState,
  emptyRetryState,
  nextProductionCoordinatorControlState,
  parseBudgetReservation,
  parseCancelAttempt,
  parseCoordinatorRemoteObservation,
  parseProductionCoordinatorControlState,
  parseProductionCoordinatorTaskControl,
  parseRetryState,
  type ProductionCoordinatorTaskControl,
} from "../src/production-coordinator-domain.ts";
import { ProductionError, type ProductionTaskEvent } from "../src/production-domain.ts";

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
const SHA = "a".repeat(64);
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const event = (taskId = "take-001", expectedRevision = 1): ProductionTaskEvent => ({
  version: 1,
  type: "dispatch-requested",
  eventId: "coord-dispatch-take-001",
  taskId,
  expectedRevision,
  occurredAt: at(1),
});
const control = (taskId = "take-001"): ProductionCoordinatorTaskControl => ({
  version: 1,
  taskId,
  observedTaskRevision: 1,
  budgetReservation: {
    version: 1,
    state: "reserved",
    currency: "USD",
    reservedAmountMicros: 2_000_000,
    reservedAt: at(0),
    exposedAt: null,
    releasedAt: null,
  },
  retryState: emptyRetryState(),
  cancelAttempt: null,
  lastObservation: null,
  pendingEvent: event(taskId),
});

const parsed = parseProductionCoordinatorTaskControl(control());
ok(parsed.pendingEvent?.eventId === "coord-dispatch-take-001"
  && parsed.pendingEvent.expectedRevision === parsed.observedTaskRevision,
"pendingEvent 保存完整 canonical eventId/payload，可在 crash 后按同一 expectedRevision 精确重放");

ok(throwsProduction(() => parseProductionCoordinatorTaskControl({ ...control(), future: true }), "不支持字段"),
"control task 严格拒绝未知字段");
ok(throwsProduction(() => parseProductionCoordinatorTaskControl({
  ...control(), taskId: "take-001\n", pendingEvent: event("take-001\n"),
}), "安全标识符"), "标识符 regex 必须全字符串匹配，拒绝 JavaScript $ 可跳过的末尾换行");
ok(throwsProduction(() => parseProductionCoordinatorTaskControl({
  ...control(), pendingEvent: event("another-task"),
}), "taskId 必须"), "pendingEvent 不能跨 task 重放");
ok(throwsProduction(() => parseProductionCoordinatorTaskControl({
  ...control(), observedTaskRevision: 2,
}), "必须等于 observedTaskRevision"), "pendingEvent 必须绑定 coordinator 已观察的 authoritative task revision");

const exposed = parseBudgetReservation({
  ...control().budgetReservation,
  state: "exposed",
  exposedAt: at(1),
  releasedAt: null,
});
const released = parseBudgetReservation({ ...exposed, state: "released", releasedAt: at(2) });
ok(exposed.state === "exposed" && released.state === "released" && released.exposedAt === at(1),
"BudgetReservation 单调保存 reserved→exposed→released 的 billable exposure 事实");
ok(throwsProduction(() => parseBudgetReservation({
  ...control().budgetReservation, state: "released", releasedAt: at(2), exposedAt: at(3),
}), "不得早于"), "预算释放时间不能早于 exposure");
ok(throwsProduction(() => parseBudgetReservation({
  ...control().budgetReservation, reservedAmountMicros: 0,
}), "1–"), "预算 reservation 拒绝零值/无界金额");

ok(throwsProduction(() => parseRetryState({
  version: 1,
  attempt: 1,
  notBefore: at(4),
  lastFailure: { version: 1, operation: "submit", code: "provider said token=secret", occurredAt: at(3) },
}), "安全稳定错误类别"), "RetryState 只落稳定错误类别，不持久化 provider 文本或 token");
ok(throwsProduction(() => parseRetryState({
  version: 1, attempt: 0, notBefore: at(4), lastFailure: null,
}), "attempt=0"), "零次 retry 不得伪造 backoff");
ok(parseRetryState({
  version: 1,
  attempt: 1,
  notBefore: at(4),
  lastFailure: { version: 1, operation: "stage-inputs", code: "remote-unavailable", occurredAt: at(3) },
}).lastFailure?.operation === "stage-inputs", "RetryState v1 可稳定表达 input staging operation");

const attempted = parseCancelAttempt({
  version: 1,
  state: "attempted",
  backendInstanceId: "comfy-prod-a",
  remoteJobId: "11111111-1111-4111-8111-111111111111",
  preparedAt: at(1),
  attemptedAt: at(2),
  accepted: true,
  confirmed: false,
  runningInterruptRequested: true,
});
ok(attempted.state === "attempted" && attempted.confirmed === false,
"CancelAttempt 持久化 prepared/attempted，但 adapter HTTP acceptance 永不冒充终态确认");
ok(throwsProduction(() => parseCancelAttempt({ ...attempted, confirmed: true }), "不能冒充"),
"CancelAttempt confirmed=true 被 strict parser 拒绝");

const observation = parseCoordinatorRemoteObservation({
  version: 1,
  backendInstanceId: "comfy-prod-a",
  remoteJobId: "11111111-1111-4111-8111-111111111111",
  state: "succeeded",
  observedAt: at(3),
  outputs: [{ nodeId: "9", kind: "video", filename: "take.mp4", subfolder: "episode-1", folderType: "output" }],
  errorSummary: null,
  responseDigest: SHA,
});
const firstOutput = observation.outputs[0];
ok(firstOutput?.source === "comfy-view" && firstOutput.filename === "take.mp4",
  "lastObservation 保存有界、相对的远端 output locator，并归一化写出 source");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation, state: "running",
}), "不得持有 outputs"), "非 succeeded observation 不能伪造 outputs");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation, state: "failed", outputs: [], errorSummary: "https://evil.invalid/?token=secret",
}), "安全稳定类别"), "lastObservation 禁止持久化远端 URL/token/error message");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation, outputs: Array.from({ length: MAX_COORDINATOR_OUTPUTS + 1 }, () => observation.outputs[0]),
}), `最多 ${MAX_COORDINATOR_OUTPUTS}`), "lastObservation 在逐项解析前执行 output 数量上限");

// —— §4.5 locator 按 source 分支（缺省即 comfy-view）与 errorSummary 词表 ——
const comfyLocator = {
  nodeId: "9", kind: "video", filename: "take.mp4", subfolder: "episode-1", folderType: "output",
};
const withSource = parseCoordinatorRemoteObservation({
  ...observation, outputs: [{ source: "comfy-view", ...comfyLocator }],
});
const withoutSource = parseCoordinatorRemoteObservation(observation);
ok(JSON.stringify(withSource.outputs) === JSON.stringify(withoutSource.outputs)
  && withSource.outputs[0]?.source === "comfy-view",
"source: comfy-view 与缺省读法一致，归一化后 durable 记录总带 source");
const durableProviderOutput = parseCoordinatorRemoteObservation({
  ...observation,
  outputs: [{ source: "provider-output", remoteJobId: "job-1", outputIndex: 0, role: "last-frame", kind: "image" }],
});
ok(JSON.stringify(durableProviderOutput.outputs) === JSON.stringify([{
  source: "provider-output", remoteJobId: "job-1", outputIndex: 0, role: "last-frame", kind: "image",
}]), "provider-output locator 经 openOutput 取回路径装配后可进入 durable observation");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation,
  outputs: [{ source: "provider-output", remoteJobId: "job-1", outputIndex: 0, role: "primary", kind: "audio" }],
}), "只支持 video 或 image"), "provider-output 的 kind 只接受 video / image");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation, outputs: [{ source: "gcs", ...comfyLocator }],
}), "必须是 comfy-view 或 provider-output"), "未知 locator source 被拒绝");
ok(throwsProduction(() => parseCoordinatorRemoteObservation({
  ...observation, outputs: [{ ...comfyLocator, source: "comfy-view", extra: 1 }],
}), "含不支持字段"), "带 source 的 comfy-view locator 仍执行 exactKeys");

const failedWith = (errorSummary: string): unknown =>
  ({ ...observation, state: "failed", outputs: [], errorSummary });
for (const summary of [
  "provider_failed:preempted", "provider_failed:InvalidParameter.TaskTypeConstraint", "provider_failed",
  "provider_expired", "content_filtered", "quota_exceeded", "invalid_input", "output_expired",
  "execution_error:torch.OutOfMemoryError", "execution_interrupted",
]) {
  const parsed = parseCoordinatorRemoteObservation(failedWith(summary));
  ok(parsed.errorSummary === summary, `errorSummary 词表接受 ${summary}`);
}
for (const summary of ["provider_failed:", "provider_crashed", "preempted", "provider_failed:超时"]) {
  ok(throwsProduction(() => parseCoordinatorRemoteObservation(failedWith(summary)), "安全稳定类别"),
    `errorSummary 词表拒绝 ${JSON.stringify(summary)}`);
}

const empty = emptyProductionCoordinatorControlState(WS, PROJECT);
ok(throwsProduction(() => nextProductionCoordinatorControlState(empty, [{
  ...control(),
  pendingEvent: null,
  budgetReservation: exposed,
}], at(5)), "先 durable reserved"),
"新 control task 不能直接标为 exposed，必须在任何 billable side effect 前先落 reservation");
ok(throwsProduction(() => nextProductionCoordinatorControlState(empty, [{
  ...control(),
  pendingEvent: null,
  cancelAttempt: attempted,
}], at(5)), "先 durable prepared"),
"新 control task 不能在 cancel 网络调用后才补写 attempted");
const cancelPrepared: ProductionCoordinatorTaskControl = {
  ...control(),
  budgetReservation: null,
  pendingEvent: null,
  cancelAttempt: {
    version: 1,
    state: "prepared",
    backendInstanceId: attempted.backendInstanceId,
    remoteJobId: attempted.remoteJobId,
    preparedAt: attempted.preparedAt,
  },
};
const cancelPreparedState = nextProductionCoordinatorControlState(empty, [cancelPrepared], at(5));
const cancelAttemptedState = nextProductionCoordinatorControlState(cancelPreparedState, [{
  ...cancelPrepared, cancelAttempt: attempted,
}], at(6));
ok(cancelAttemptedState.tasks[0]?.cancelAttempt?.state === "attempted",
"CancelAttempt 只有 prepared durable intent 才能完成为 attempted fact");
const first = nextProductionCoordinatorControlState(empty, [control()], at(5));
ok(throwsProduction(() => nextProductionCoordinatorControlState(first, [{
  ...control(),
  budgetReservation: released,
}], at(6)), "先 durable exposed"),
"有 billable exposure 的 reservation 不能从 reserved 直接补写 released，必须先落 exposed fact");
ok(throwsProduction(() => nextProductionCoordinatorControlState(first, [{
  ...control(), pendingEvent: null,
}], at(6)), "authoritative event 已推进"),
"pendingEvent 不能仅从 control 清除；必须同时观察到 authoritative task revision +1");
const second = nextProductionCoordinatorControlState(first, [{
  ...control(), observedTaskRevision: 2, pendingEvent: null,
}], at(6));
ok(first.revision === 1 && second.revision === 2 && second.updatedAt === at(6),
"每次 control reducer mutation 精确 revision +1");
ok(throwsProduction(() => nextProductionCoordinatorControlState(second, [{
  ...second.tasks[0]!, budgetReservation: null,
}], at(7)), "reservation identity"),
"BudgetReservation 一旦创建就不能被清空，从而防止释放/暴露事实回退后重复花费");
ok(throwsProduction(() => nextProductionCoordinatorControlState(second, second.tasks, at(5)), "不得早于"),
"control updatedAt 不允许倒退");
ok(throwsProduction(() => parseProductionCoordinatorControlState({ ...second, future: true }), "不支持字段"),
"control document 严格拒绝未知字段");
ok(throwsProduction(() => parseProductionCoordinatorControlState({
  version: 1,
  workspaceId: WS,
  project: PROJECT,
  revision: 1,
  updatedAt: at(1),
  tasks: Array.from({ length: MAX_COORDINATOR_TASKS + 1 }, () => null),
}), `最多 ${MAX_COORDINATOR_TASKS}`), "control document 在逐项解析前执行 task 数量上限");
ok(throwsProduction(() => parseProductionCoordinatorControlState(second, {
  workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
}), "不能作为"), "control document 与 workspaceId/project scope 绑定");

console.log(fails === 0 ? "\nPRODUCTION_COORDINATOR_DOMAIN_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
