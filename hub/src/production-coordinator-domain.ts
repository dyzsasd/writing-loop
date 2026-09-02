// Durable, provider-neutral control state for the Phase 3B production coordinator.
//
// This is intentionally separate from production-state.v1.json: the production ledger remains
// the authoritative user-visible history, while this document only records crash-recovery facts
// needed to decide the next side effect. Every value is parsed at the disk/network trust boundary.
import {
  MAX_PRODUCTION_COST_MICROS,
  MAX_PRODUCTION_TASKS,
  ProductionError,
  compareProductionAscii,
  parseProductionTaskEvent,
  type ProductionTaskEvent,
} from "./production-domain.ts";
import type { ProductionAdapterErrorCode, RemoteJobState, RemoteOutputLocator } from "./production-adapter.ts";

export const PRODUCTION_COORDINATOR_SCHEMA_VERSION = 1 as const;
export const MAX_COORDINATOR_TASKS = MAX_PRODUCTION_TASKS;
export const MAX_COORDINATOR_RETRY_ATTEMPTS = 10_000;
export const MAX_COORDINATOR_OUTPUTS = 128;
export const MAX_COORDINATOR_ERROR_CODE_LENGTH = 96;

export type BudgetReservationBase = {
  version: 1;
  currency: "USD";
  reservedAmountMicros: number;
  reservedAt: string;
};

/**
 * `exposed` means a billable remote side effect may have happened and the reservation must not be
 * returned to the available pool. `released` preserves whether exposure happened before release.
 */
export type BudgetReservation =
  | BudgetReservationBase & { state: "reserved"; exposedAt: null; releasedAt: null }
  | BudgetReservationBase & { state: "exposed"; exposedAt: string; releasedAt: null }
  | BudgetReservationBase & { state: "released"; exposedAt: string | null; releasedAt: string };

export type CoordinatorOperation = "stage-inputs" | "submit" | "inspect" | "cancel" | "ingest";

export type CoordinatorFailure = {
  version: 1;
  operation: CoordinatorOperation;
  /** Stable category only. Never persist provider messages, URLs, prompts, tokens or tracebacks. */
  code: ProductionAdapterErrorCode | "invalid-control-state" | "budget-unavailable";
  occurredAt: string;
};

export type RetryState = {
  version: 1;
  attempt: number;
  notBefore: string | null;
  lastFailure: CoordinatorFailure | null;
};

export type CancelAttempt =
  | {
      version: 1;
      state: "prepared";
      backendInstanceId: string;
      remoteJobId: string;
      preparedAt: string;
    }
  | {
      version: 1;
      state: "attempted";
      backendInstanceId: string;
      remoteJobId: string;
      preparedAt: string;
      attemptedAt: string;
      accepted: boolean;
      /** The current adapter contract never treats HTTP acceptance as terminal confirmation. */
      confirmed: false;
      runningInterruptRequested: boolean;
    };

export type CoordinatorRemoteObservation = {
  version: 1;
  backendInstanceId: string;
  remoteJobId: string;
  state: RemoteJobState;
  observedAt: string;
  outputs: RemoteOutputLocator[];
  errorSummary: string | null;
  responseDigest: string;
};

export type ProductionCoordinatorTaskControl = {
  version: 1;
  taskId: string;
  /** Last authoritative ProductionTask.revision consumed by the coordinator. */
  observedTaskRevision: number;
  budgetReservation: BudgetReservation | null;
  retryState: RetryState;
  cancelAttempt: CancelAttempt | null;
  lastObservation: CoordinatorRemoteObservation | null;
  /** Exact canonical outbox event. Re-applying its eventId after a crash is idempotent. */
  pendingEvent: ProductionTaskEvent | null;
};

export type ProductionCoordinatorControlState = {
  version: 1;
  workspaceId: string;
  project: string;
  /** Store-controlled document revision; every durable mutation increments exactly once. */
  revision: number;
  updatedAt: string | null;
  tasks: ProductionCoordinatorTaskControl[];
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/**
 * §4.5 errorSummary 词表：只允许稳定类别，禁止 provider 消息 / URL / token / traceback / 输入原文。
 * `provider_failed:<code>` 承载 GPU VM 抢占（`provider_failed:preempted`，§7）与 Ark 的错误码。
 * production-coordinator.ts 直接引用该模式，两处判据同源。
 */
const ERROR_SUMMARY_ALTERNATIVES = [
  "execution_error(?::[A-Za-z_][A-Za-z0-9_.]{0,119})?",
  "execution_interrupted",
  "provider_failed(?::[A-Za-z0-9_.-]{1,64})?",
  "provider_expired",
  "content_filtered",
  "quota_exceeded",
  "invalid_input",
  "output_expired",
];
export const PRODUCTION_ERROR_SUMMARY_PATTERN = new RegExp(`^(?:${ERROR_SUMMARY_ALTERNATIVES.join("|")})$`);
const SAFE_ERROR_SUMMARY = PRODUCTION_ERROR_SUMMARY_PATTERN;
const REMOTE_STATES = new Set<RemoteJobState>([
  "pending", "running", "succeeded", "failed", "cancelled", "not-found",
]);
const OUTPUT_KINDS = new Set(["image", "video", "audio", "file"]);
const OUTPUT_FOLDERS = new Set(["input", "output", "temp"]);
const PROVIDER_OUTPUT_KINDS = new Set(["video", "image"]);
const PROVIDER_OUTPUT_ROLES = new Set(["primary", "last-frame"]);
const OPERATIONS = new Set<CoordinatorOperation>(["stage-inputs", "submit", "inspect", "cancel", "ingest"]);
const FAILURE_CODES = new Set<CoordinatorFailure["code"]>([
  "aborted", "submission-unknown", "remote-rejected", "remote-unavailable", "invalid-response",
  "response-too-large", "invalid-control-state", "budget-unavailable",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function fail(subject: string, detail: string): never {
  throw new ProductionError(`${subject} ${detail}`);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function version(value: unknown, subject: string): void {
  if (value !== PRODUCTION_COORDINATOR_SCHEMA_VERSION) fail(subject, "version 必须是 1");
}

function integer(value: unknown, subject: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function iso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "必须是规范 UTC ISO-8601 时间");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(subject, "必须是规范 UTC ISO-8601 时间");
  return value;
}

function identifier(value: unknown, subject: string): string {
  if (typeof value !== "string" || !fullMatch(SAFE_ID, value)) fail(subject, "必须是 1–128 位安全标识符");
  return value;
}

function sha256(value: unknown, subject: string): string {
  if (typeof value !== "string" || !fullMatch(SHA256, value)) fail(subject, "必须是 64 位小写十六进制 sha256");
  return value;
}

function boolean(value: unknown, subject: string): boolean {
  if (typeof value !== "boolean") fail(subject, "必须是 boolean");
  return value;
}

function relativePath(value: unknown, subject: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\")
    || value.startsWith("/") || value.split("/").some((part) => part === "..") || (!allowEmpty && !value)) {
    fail(subject, "必须是有界安全远端相对路径");
  }
  return value;
}

export function parseBudgetReservation(value: unknown, subject = "BudgetReservation"): BudgetReservation {
  const row = record(value, subject);
  exactKeys(row, [
    "version", "state", "currency", "reservedAmountMicros", "reservedAt", "exposedAt", "releasedAt",
  ], subject);
  version(row.version, subject);
  if (row.state !== "reserved" && row.state !== "exposed" && row.state !== "released") {
    fail(`${subject}.state`, "必须是 reserved、exposed 或 released");
  }
  if (row.currency !== "USD") fail(`${subject}.currency`, "当前只支持 USD");
  const base: BudgetReservationBase = {
    version: 1,
    currency: "USD",
    reservedAmountMicros: integer(row.reservedAmountMicros, `${subject}.reservedAmountMicros`, 1, MAX_PRODUCTION_COST_MICROS),
    reservedAt: iso(row.reservedAt, `${subject}.reservedAt`),
  };
  if (row.state === "reserved") {
    if (row.exposedAt !== null || row.releasedAt !== null) fail(subject, "reserved 时 exposedAt/releasedAt 必须为 null");
    return { ...base, state: "reserved", exposedAt: null, releasedAt: null };
  }
  const exposedAt = row.exposedAt === null ? null : iso(row.exposedAt, `${subject}.exposedAt`);
  if (exposedAt !== null && exposedAt < base.reservedAt) fail(`${subject}.exposedAt`, "不得早于 reservedAt");
  if (row.state === "exposed") {
    if (exposedAt === null || row.releasedAt !== null) fail(subject, "exposed 时必须有 exposedAt 且 releasedAt 为 null");
    return { ...base, state: "exposed", exposedAt, releasedAt: null };
  }
  const releasedAt = iso(row.releasedAt, `${subject}.releasedAt`);
  if (releasedAt < base.reservedAt || (exposedAt !== null && releasedAt < exposedAt)) {
    fail(`${subject}.releasedAt`, "不得早于 reservation/exposure");
  }
  return { ...base, state: "released", exposedAt, releasedAt };
}

export function parseRetryState(value: unknown, subject = "RetryState"): RetryState {
  const row = record(value, subject);
  exactKeys(row, ["version", "attempt", "notBefore", "lastFailure"], subject);
  version(row.version, subject);
  const attempt = integer(row.attempt, `${subject}.attempt`, 0, MAX_COORDINATOR_RETRY_ATTEMPTS);
  const notBefore = row.notBefore === null ? null : iso(row.notBefore, `${subject}.notBefore`);
  let lastFailure: CoordinatorFailure | null = null;
  if (row.lastFailure !== null) {
    const failure = record(row.lastFailure, `${subject}.lastFailure`);
    exactKeys(failure, ["version", "operation", "code", "occurredAt"], `${subject}.lastFailure`);
    version(failure.version, `${subject}.lastFailure`);
    if (typeof failure.operation !== "string" || !OPERATIONS.has(failure.operation as CoordinatorOperation)) {
      fail(`${subject}.lastFailure.operation`, "不是受支持的 coordinator 操作");
    }
    if (typeof failure.code !== "string" || failure.code.length > MAX_COORDINATOR_ERROR_CODE_LENGTH
      || !FAILURE_CODES.has(failure.code as CoordinatorFailure["code"])) {
      fail(`${subject}.lastFailure.code`, "不是安全稳定错误类别");
    }
    lastFailure = {
      version: 1,
      operation: failure.operation as CoordinatorOperation,
      code: failure.code as CoordinatorFailure["code"],
      occurredAt: iso(failure.occurredAt, `${subject}.lastFailure.occurredAt`),
    };
  }
  if (attempt === 0 && (lastFailure !== null || notBefore !== null)) fail(subject, "attempt=0 时不得持有失败或退避时间");
  if (attempt > 0 && lastFailure === null) fail(subject, "attempt>0 时必须持有 lastFailure");
  if (notBefore !== null && lastFailure !== null && notBefore < lastFailure.occurredAt) {
    fail(`${subject}.notBefore`, "不得早于 lastFailure.occurredAt");
  }
  return { version: 1, attempt, notBefore, lastFailure };
}

export function emptyRetryState(): RetryState {
  return { version: 1, attempt: 0, notBefore: null, lastFailure: null };
}

export function parseCancelAttempt(value: unknown, subject = "CancelAttempt"): CancelAttempt {
  const row = record(value, subject);
  if (row.state === "prepared") {
    exactKeys(row, ["version", "state", "backendInstanceId", "remoteJobId", "preparedAt"], subject);
    version(row.version, subject);
    return {
      version: 1,
      state: "prepared",
      backendInstanceId: identifier(row.backendInstanceId, `${subject}.backendInstanceId`),
      remoteJobId: identifier(row.remoteJobId, `${subject}.remoteJobId`),
      preparedAt: iso(row.preparedAt, `${subject}.preparedAt`),
    };
  }
  if (row.state === "attempted") {
    exactKeys(row, [
      "version", "state", "backendInstanceId", "remoteJobId", "preparedAt", "attemptedAt", "accepted",
      "confirmed", "runningInterruptRequested",
    ], subject);
    version(row.version, subject);
    if (row.confirmed !== false) fail(`${subject}.confirmed`, "adapter acceptance 不能冒充 terminal cancellation confirmation");
    const preparedAt = iso(row.preparedAt, `${subject}.preparedAt`);
    const attemptedAt = iso(row.attemptedAt, `${subject}.attemptedAt`);
    if (attemptedAt < preparedAt) fail(`${subject}.attemptedAt`, "不得早于 preparedAt");
    return {
      version: 1,
      state: "attempted",
      backendInstanceId: identifier(row.backendInstanceId, `${subject}.backendInstanceId`),
      remoteJobId: identifier(row.remoteJobId, `${subject}.remoteJobId`),
      preparedAt,
      attemptedAt,
      accepted: boolean(row.accepted, `${subject}.accepted`),
      confirmed: false,
      runningInterruptRequested: boolean(row.runningInterruptRequested, `${subject}.runningInterruptRequested`),
    };
  }
  fail(`${subject}.state`, "必须是 prepared 或 attempted");
}

function parseOutput(value: unknown, subject: string): RemoteOutputLocator {
  const row = record(value, subject);
  // §4.5 的 locator 联合按 source 分支；缺少 source 时按 comfy-view 读取，写入侧总带 source。
  const source = Object.prototype.hasOwnProperty.call(row, "source") ? row.source : "comfy-view";
  if (source === "provider-output") {
    exactKeys(row, ["source", "remoteJobId", "outputIndex", "role", "kind"], subject);
    if (typeof row.kind !== "string" || !PROVIDER_OUTPUT_KINDS.has(row.kind)) {
      fail(`${subject}.kind`, "provider-output 只支持 video 或 image");
    }
    if (typeof row.role !== "string" || !PROVIDER_OUTPUT_ROLES.has(row.role)) {
      fail(`${subject}.role`, "必须是 primary 或 last-frame");
    }
    if (!Number.isSafeInteger(row.outputIndex) || (row.outputIndex as number) < 0
      || (row.outputIndex as number) > 127) {
      fail(`${subject}.outputIndex`, "必须是 0–127 的安全整数");
    }
    return {
      source: "provider-output",
      remoteJobId: identifier(row.remoteJobId, `${subject}.remoteJobId`),
      outputIndex: row.outputIndex as number,
      role: row.role as "primary" | "last-frame",
      kind: row.kind as "video" | "image",
    };
  }
  if (source !== "comfy-view") fail(`${subject}.source`, "必须是 comfy-view 或 provider-output");
  const comfyKeys = ["nodeId", "kind", "filename", "subfolder", "folderType"];
  exactKeys(
    row,
    Object.prototype.hasOwnProperty.call(row, "source") ? ["source", ...comfyKeys] : comfyKeys,
    subject,
  );
  if (typeof row.kind !== "string" || !OUTPUT_KINDS.has(row.kind)) {
    fail(`${subject}.kind`, "不是受支持的 output kind");
  }
  if (typeof row.folderType !== "string" || !OUTPUT_FOLDERS.has(row.folderType)) {
    fail(`${subject}.folderType`, "必须是 input、output 或 temp");
  }
  return {
    source: "comfy-view",
    nodeId: identifier(row.nodeId, `${subject}.nodeId`),
    kind: row.kind as "image" | "video" | "audio" | "file",
    filename: relativePath(row.filename, `${subject}.filename`),
    subfolder: relativePath(row.subfolder, `${subject}.subfolder`, true),
    folderType: row.folderType as "input" | "output" | "temp",
  };
}

export function parseCoordinatorRemoteObservation(
  value: unknown,
  subject = "CoordinatorRemoteObservation",
): CoordinatorRemoteObservation {
  const row = record(value, subject);
  exactKeys(row, [
    "version", "backendInstanceId", "remoteJobId", "state", "observedAt", "outputs", "errorSummary", "responseDigest",
  ], subject);
  version(row.version, subject);
  if (typeof row.state !== "string" || !REMOTE_STATES.has(row.state as RemoteJobState)) {
    fail(`${subject}.state`, "不是受支持的 remote job 状态");
  }
  if (!Array.isArray(row.outputs) || row.outputs.length > MAX_COORDINATOR_OUTPUTS) {
    fail(`${subject}.outputs`, `必须是最多 ${MAX_COORDINATOR_OUTPUTS} 项的数组`);
  }
  if (row.errorSummary !== null
    && (typeof row.errorSummary !== "string" || !fullMatch(SAFE_ERROR_SUMMARY, row.errorSummary))) {
    fail(`${subject}.errorSummary`, "只允许安全稳定类别，禁止 provider 消息/URL/token/traceback");
  }
  const state = row.state as RemoteJobState;
  const outputs = row.outputs.map((output, index) => parseOutput(output, `${subject}.outputs[${index}]`));
  if (state !== "succeeded" && outputs.length !== 0) fail(subject, `${state} observation 不得持有 outputs`);
  if (state !== "failed" && row.errorSummary !== null) fail(subject, `${state} observation 不得持有 errorSummary`);
  return {
    version: 1,
    backendInstanceId: identifier(row.backendInstanceId, `${subject}.backendInstanceId`),
    remoteJobId: identifier(row.remoteJobId, `${subject}.remoteJobId`),
    state,
    observedAt: iso(row.observedAt, `${subject}.observedAt`),
    outputs,
    errorSummary: row.errorSummary as string | null,
    responseDigest: sha256(row.responseDigest, `${subject}.responseDigest`),
  };
}

export function parseProductionCoordinatorTaskControl(
  value: unknown,
  subject = "ProductionCoordinatorTaskControl",
): ProductionCoordinatorTaskControl {
  const row = record(value, subject);
  exactKeys(row, [
    "version", "taskId", "observedTaskRevision", "budgetReservation", "retryState", "cancelAttempt",
    "lastObservation", "pendingEvent",
  ], subject);
  version(row.version, subject);
  const taskId = identifier(row.taskId, `${subject}.taskId`);
  const observedTaskRevision = integer(row.observedTaskRevision, `${subject}.observedTaskRevision`, 1);
  const budgetReservation = row.budgetReservation === null
    ? null
    : parseBudgetReservation(row.budgetReservation, `${subject}.budgetReservation`);
  const retryState = parseRetryState(row.retryState, `${subject}.retryState`);
  const cancelAttempt = row.cancelAttempt === null
    ? null
    : parseCancelAttempt(row.cancelAttempt, `${subject}.cancelAttempt`);
  const lastObservation = row.lastObservation === null
    ? null
    : parseCoordinatorRemoteObservation(row.lastObservation, `${subject}.lastObservation`);
  const pendingEvent = row.pendingEvent === null
    ? null
    : parseProductionTaskEvent(row.pendingEvent, `${subject}.pendingEvent`);
  if (pendingEvent !== null && pendingEvent.taskId !== taskId) fail(`${subject}.pendingEvent`, "taskId 必须与 control taskId 一致");
  if (pendingEvent !== null && pendingEvent.expectedRevision !== observedTaskRevision) {
    fail(`${subject}.pendingEvent.expectedRevision`, "必须等于 observedTaskRevision 才能精确重放");
  }
  if (lastObservation !== null && cancelAttempt !== null
    && (lastObservation.backendInstanceId !== cancelAttempt.backendInstanceId
      || lastObservation.remoteJobId !== cancelAttempt.remoteJobId)) {
    fail(subject, "lastObservation 与 cancelAttempt 的 remote tuple 不一致");
  }
  return {
    version: 1,
    taskId,
    observedTaskRevision,
    budgetReservation,
    retryState,
    cancelAttempt,
    lastObservation,
    pendingEvent,
  };
}

export function parseProductionCoordinatorControlState(
  value: unknown,
  expected: { workspaceId?: string; project?: string } = {},
  subject = "ProductionCoordinatorControlState",
): ProductionCoordinatorControlState {
  const row = record(value, subject);
  exactKeys(row, ["version", "workspaceId", "project", "revision", "updatedAt", "tasks"], subject);
  version(row.version, subject);
  if (typeof row.workspaceId !== "string" || !fullMatch(SAFE_WORKSPACE_ID, row.workspaceId)) {
    fail(`${subject}.workspaceId`, "必须是 1–128 位安全 workspace 标识符");
  }
  if (typeof row.project !== "string" || !fullMatch(SAFE_PROJECT_KEY, row.project)) {
    fail(`${subject}.project`, "必须是安全 project key");
  }
  if (expected.workspaceId !== undefined && row.workspaceId !== expected.workspaceId) {
    fail(subject, `绑定 workspaceId=${JSON.stringify(row.workspaceId)}，不能作为 ${JSON.stringify(expected.workspaceId)} 读取`);
  }
  if (expected.project !== undefined && row.project !== expected.project) {
    fail(subject, `绑定 project=${JSON.stringify(row.project)}，不能作为 ${JSON.stringify(expected.project)} 读取`);
  }
  const revision = integer(row.revision, `${subject}.revision`);
  const updatedAt = row.updatedAt === null ? null : iso(row.updatedAt, `${subject}.updatedAt`);
  if (!Array.isArray(row.tasks) || row.tasks.length > MAX_COORDINATOR_TASKS) {
    fail(`${subject}.tasks`, `必须是最多 ${MAX_COORDINATOR_TASKS} 项的数组`);
  }
  const tasks = row.tasks.map((task, index) => parseProductionCoordinatorTaskControl(task, `${subject}.tasks[${index}]`));
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) fail(`${subject}.tasks`, "taskId 不得重复");
  if (revision === 0 && (updatedAt !== null || tasks.length !== 0)) fail(subject, "revision=0 只允许 missing=>empty 状态");
  if (revision > 0 && updatedAt === null) fail(subject, "已持久化 revision 必须有 updatedAt");
  if (updatedAt !== null) {
    for (const task of tasks) {
      const factTimes = [
        task.budgetReservation?.reservedAt,
        task.budgetReservation?.exposedAt ?? undefined,
        task.budgetReservation?.releasedAt ?? undefined,
        task.retryState.lastFailure?.occurredAt,
        task.cancelAttempt?.preparedAt,
        task.cancelAttempt?.state === "attempted" ? task.cancelAttempt.attemptedAt : undefined,
        task.lastObservation?.observedAt,
        task.pendingEvent?.occurredAt,
      ].filter((time): time is string => time !== undefined);
      if (factTimes.some((time) => time > updatedAt)) {
        fail(`${subject}.updatedAt`, `不得早于 task ${task.taskId} 的 durable fact time`);
      }
    }
  }
  return {
    version: 1,
    workspaceId: row.workspaceId,
    project: row.project,
    revision,
    updatedAt,
    tasks,
  };
}

function sameBudgetBase(left: BudgetReservation, right: BudgetReservation): boolean {
  return left.currency === right.currency
    && left.reservedAmountMicros === right.reservedAmountMicros
    && left.reservedAt === right.reservedAt;
}

function assertTaskMutation(
  previous: ProductionCoordinatorTaskControl,
  next: ProductionCoordinatorTaskControl,
): void {
  const subject = `ProductionCoordinatorMutation.tasks[${JSON.stringify(next.taskId)}]`;
  if (next.observedTaskRevision < previous.observedTaskRevision) {
    fail(`${subject}.observedTaskRevision`, "不得倒退");
  }
  if (previous.pendingEvent !== null) {
    if (next.pendingEvent !== null) {
      if (JSON.stringify(next.pendingEvent) !== JSON.stringify(previous.pendingEvent)
        || next.observedTaskRevision !== previous.observedTaskRevision) {
        fail(`${subject}.pendingEvent`, "落盘后只能原样保留，不能替换 payload 或推进 observed revision");
      }
    } else if (next.observedTaskRevision !== previous.pendingEvent.expectedRevision + 1) {
      fail(`${subject}.pendingEvent`, "只能在 authoritative event 已推进 task revision 后清除");
    }
  }

  const oldBudget = previous.budgetReservation;
  const newBudget = next.budgetReservation;
  if (oldBudget === null && newBudget !== null && newBudget.state !== "reserved") {
    fail(`${subject}.budgetReservation`, "必须先 durable reserved，不能直接进入 billable exposure/released");
  }
  if (oldBudget !== null) {
    if (newBudget === null || !sameBudgetBase(oldBudget, newBudget)) {
      fail(`${subject}.budgetReservation`, "reservation identity 不得清除或改写");
    }
    if (oldBudget.state === "reserved") {
      if (newBudget.state === "reserved"
        && JSON.stringify(newBudget) !== JSON.stringify(oldBudget)) {
        fail(`${subject}.budgetReservation`, "reserved fact 不得原地改写");
      }
      if (newBudget.state === "released" && newBudget.exposedAt !== null) {
        fail(`${subject}.budgetReservation`, "billable side effect 必须先 durable exposed，不能把 exposure 与 release 合并补写");
      }
    } else if (oldBudget.state === "exposed") {
      if (newBudget.state === "reserved"
        || (newBudget.state !== "released" && JSON.stringify(newBudget) !== JSON.stringify(oldBudget))
        || (newBudget.state === "released" && newBudget.exposedAt !== oldBudget.exposedAt)) {
        fail(`${subject}.budgetReservation`, "billable exposure 不得回退或改写");
      }
    } else if (JSON.stringify(newBudget) !== JSON.stringify(oldBudget)) {
      fail(`${subject}.budgetReservation`, "released reservation 是不可变终态");
    }
  }
  if (previous.lastObservation !== null) {
    if (next.lastObservation === null) fail(`${subject}.lastObservation`, "durable remote observation 不得清除");
    if (next.lastObservation.backendInstanceId !== previous.lastObservation.backendInstanceId
      || next.lastObservation.remoteJobId !== previous.lastObservation.remoteJobId
      || next.lastObservation.observedAt < previous.lastObservation.observedAt) {
      fail(`${subject}.lastObservation`, "remote tuple 不得改变且 observedAt 不得倒退");
    }
  }

  const oldCancel = previous.cancelAttempt;
  const newCancel = next.cancelAttempt;
  if (oldCancel === null && newCancel?.state === "attempted") {
    fail(`${subject}.cancelAttempt`, "必须先 durable prepared，不能在网络调用后直接写 attempted");
  }
  if (oldCancel !== null) {
    if (newCancel === null) fail(`${subject}.cancelAttempt`, "durable cancel attempt 不得清除");
    const sameTuple = newCancel.backendInstanceId === oldCancel.backendInstanceId
      && newCancel.remoteJobId === oldCancel.remoteJobId;
    if (!sameTuple) fail(`${subject}.cancelAttempt`, "remote tuple 不得改变");
    if (oldCancel.state === "prepared") {
      if (newCancel.state === "prepared" && JSON.stringify(newCancel) !== JSON.stringify(oldCancel)) {
        fail(`${subject}.cancelAttempt`, "prepared intent 只能原样保留或完成为 attempted");
      }
      if (newCancel.state === "attempted" && newCancel.preparedAt !== oldCancel.preparedAt) {
        fail(`${subject}.cancelAttempt`, "attempted 必须完成同一个 durable prepared intent");
      }
    } else if (newCancel.state === "attempted") {
      if (JSON.stringify(newCancel) !== JSON.stringify(oldCancel)) {
        fail(`${subject}.cancelAttempt`, "attempted fact 不得原地改写；重试前必须先落新的 prepared");
      }
    } else if (newCancel.preparedAt < oldCancel.attemptedAt) {
      fail(`${subject}.cancelAttempt.preparedAt`, "新 retry intent 不得早于上一次 attemptedAt");
    }
  }
}

export function emptyProductionCoordinatorControlState(
  workspaceId: string,
  project: string,
): ProductionCoordinatorControlState {
  return parseProductionCoordinatorControlState({
    version: 1,
    workspaceId,
    project,
    revision: 0,
    updatedAt: null,
    tasks: [],
  });
}

/** Pure reducer used by the store after it has checked the caller's expected document revision. */
export function nextProductionCoordinatorControlState(
  currentValue: ProductionCoordinatorControlState,
  tasksValue: readonly ProductionCoordinatorTaskControl[],
  updatedAtValue: string,
): ProductionCoordinatorControlState {
  const current = parseProductionCoordinatorControlState(currentValue);
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new ProductionError("production coordinator control revision 已耗尽安全整数空间");
  }
  const mutationAt = iso(updatedAtValue, "ProductionCoordinatorMutation.updatedAt");
  if (current.updatedAt !== null && mutationAt < current.updatedAt) {
    throw new ProductionError("ProductionCoordinatorMutation.updatedAt 不得早于当前 control updatedAt");
  }
  const tasks = tasksValue.map((task, index) =>
    parseProductionCoordinatorTaskControl(task, `ProductionCoordinatorMutation.tasks[${index}]`));
  const previousById = new Map(current.tasks.map((task) => [task.taskId, task]));
  for (const task of tasks) {
    const previous = previousById.get(task.taskId);
    if (previous !== undefined) {
      assertTaskMutation(previous, task);
    } else {
      if (task.budgetReservation !== null && task.budgetReservation.state !== "reserved") {
        fail(`ProductionCoordinatorMutation.tasks[${JSON.stringify(task.taskId)}].budgetReservation`,
          "新 control task 必须先 durable reserved");
      }
      if (task.cancelAttempt?.state === "attempted") {
        fail(`ProductionCoordinatorMutation.tasks[${JSON.stringify(task.taskId)}].cancelAttempt`,
          "新 control task 必须先 durable prepared");
      }
    }
  }
  tasks.sort((left, right) => compareProductionAscii(left.taskId, right.taskId));
  return parseProductionCoordinatorControlState({
    version: 1,
    workspaceId: current.workspaceId,
    project: current.project,
    revision: current.revision + 1,
    updatedAt: mutationAt,
    tasks,
  }, { workspaceId: current.workspaceId, project: current.project });
}
