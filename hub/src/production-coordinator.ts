// Minimal crash-safe Phase 3B production coordinator.
//
// One project lease spans the complete async round. The two durable documents retain their own
// short synchronous locks: no production/control state lock can cross a network await. Remote
// submission is deliberately at-most-once. Once submission-started is durable, recovery only
// inspects the preallocated remote id and never reconstructs/replays the POST.
import { createHash, randomUUID } from "node:crypto";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import {
  ProductionAdapterError,
  type PreparedSubmission,
  type ProductionAdapter,
  type RemoteObservation,
  type SubmitResult,
} from "./production-adapter.ts";
import {
  MAX_PRODUCTION_ASSETS_PER_TASK,
  ProductionError,
  compareProductionAscii,
  isTerminalProductionStatus,
  parseAssetRef,
  parseProductionCost,
  parseProductionTaskEvent,
  type ProductionTask,
  type ProductionTaskEvent,
} from "./production-domain.ts";
import {
  ProductionStore,
  type ApplyProductionEventResult,
} from "./production-store.ts";
import {
  evaluateProductionIntentGates,
  parseProductionDispatchIntent,
  parseProductionIntentGateContext,
  type ProductionDispatchIntent,
  type ProductionIntentGateContext,
  type ProductionIntentResolver,
  type ProductionModelFamily,
} from "./production-intent.ts";
import {
  MAX_COORDINATOR_RETRY_ATTEMPTS,
  emptyRetryState,
  parseCoordinatorRemoteObservation,
  type CoordinatorFailure,
  type CoordinatorOperation,
  type CoordinatorRemoteObservation,
  type ProductionCoordinatorTaskControl,
} from "./production-coordinator-domain.ts";
import { ProductionCoordinatorStore } from "./production-coordinator-store.ts";
import {
  withProductionCoordinatorLease,
  type ProductionCoordinatorLeaseOptions,
} from "./production-coordinator-lock.ts";
import {
  decideProductionObservation,
  parseRemoteObservation,
  type ProductionReconcileFact,
} from "./production-reconcile.ts";
import {
  ProductionIngestorError,
  type ProductionArtifactIngestor,
  type ProductionIngestResult,
} from "./production-ingestor.ts";
import {
  ProductionInputStagerError,
  parseProductionInputStageResult,
  parseProductionWorkflowBindingVerification,
  productionInputStageKey,
  type ProductionInputStageResult,
  type ProductionInputStager,
  type ProductionWorkflowBindingVerifier,
} from "./production-input-stager.ts";

export interface ProductionAdapterRegistry {
  resolve(backendInstanceId: string): ProductionAdapter | null;
}

export type ProductionWorkflowDescriptor = {
  version: 1;
  workflow: Record<string, unknown>;
  /** Trusted model identity; transport operation alone cannot identify H3-over-ComfyUI. */
  modelFamily: ProductionModelFamily;
  modelSha256: string;
  parametersSha256: string;
};

/** Resolves a pinned execution descriptor only from trusted server-side configuration and stable intent. */
export interface ProductionWorkflowResolver {
  resolve(intent: ProductionDispatchIntent, signal?: AbortSignal): Promise<ProductionWorkflowDescriptor | null>;
}

export interface ProductionGateContextResolver {
  resolve(
    intent: ProductionDispatchIntent,
    task: ProductionTask,
    signal?: AbortSignal,
  ): Promise<ProductionIntentGateContext>;
}

export type ProductionInputPipeline =
  | {
      version: 1;
      policy: "static-pre-staged";
    }
  | {
      version: 1;
      policy: "scoped-staging";
      inputStager: ProductionInputStager;
      workflowBindingVerifier: ProductionWorkflowBindingVerifier;
    };

/** Resolves one server-owned input policy from the immutable workflow identity. */
export interface ProductionInputPipelineResolver {
  resolve(
    intent: ProductionDispatchIntent,
    signal?: AbortSignal,
  ): Promise<ProductionInputPipeline | null>;
}

export type ProductionCoordinatorIssueCode =
  | "intent-missing"
  | "intent-invalid"
  | "gate-denied"
  | "adapter-missing"
  | "workflow-missing"
  | "workflow-digest-mismatch"
  | "model-family-mismatch"
  | "model-digest-mismatch"
  | "parameters-digest-mismatch"
  | "input-stager-missing"
  | "input-staging-unavailable"
  | "workflow-binding-verifier-missing"
  | "workflow-bindings-invalid"
  | "budget-reservation-conflict"
  | "submit-unknown"
  | "inspect-unavailable"
  | "remote-not-found"
  | "ingest-unavailable"
  | "cost-unreconciled"
  | "cancel-unconfirmed";

export type ProductionCoordinatorIssue = {
  version: 1;
  taskId: string;
  code: ProductionCoordinatorIssueCode;
};

export type ProductionCoordinatorRunResult = {
  version: 1;
  project: string;
  tasksVisited: number;
  submissions: number;
  inspections: number;
  cancellationAttempts: number;
  ingests: number;
  eventsApplied: number;
  skipped: number;
  issues: ProductionCoordinatorIssue[];
};

export type ProductionCoordinatorHooks = {
  /** The canonical event is durable in control.pendingEvent but is not necessarily applied yet. */
  afterPendingEventPersisted?: (event: ProductionTaskEvent) => void;
  /** Durable submission-started exists; no provider POST has occurred in this invocation yet. */
  afterSubmissionStarted?: (task: ProductionTask, prepared: PreparedSubmission) => void;
  /** Budget exposure is durable and submitPrepared is about to perform the sole POST. */
  beforeSubmit?: (task: ProductionTask, prepared: PreparedSubmission) => void;
  /** The POST returned, but submission-confirmed has not necessarily been persisted. */
  afterSubmitReturned?: (task: ProductionTask, prepared: PreparedSubmission) => void;
  /** A durable cancel-attempt=prepared exists; this invocation has not called cancel yet. */
  afterCancelPrepared?: (task: ProductionTask) => void;
  /** cancel returned, but attempted metadata is not necessarily durable yet. */
  afterCancelReturned?: (task: ProductionTask) => void;
};

export type ProductionCoordinatorOptions = {
  root: string;
  workspaceId: string;
  project: string;
  adapterRegistry: ProductionAdapterRegistry;
  intentResolver: ProductionIntentResolver;
  workflowResolver: ProductionWorkflowResolver;
  gateContextResolver: ProductionGateContextResolver;
  /** Preferred Phase 3C boundary: one trusted policy per immutable workflow/intent. */
  inputPipelineResolver?: ProductionInputPipelineResolver;
  /** When present, every model family stages immutable inputs through this trusted boundary. */
  inputStager?: ProductionInputStager;
  /** Proves the trusted graph consumes every staged slot/provider CAS key before budget exposure. */
  workflowBindingVerifier?: ProductionWorkflowBindingVerifier;
  /** Explicit compatibility mode for generic workflows whose inputs are static or already staged. */
  unstagedGenericInputMode?: "static-or-pre-staged";
  ingestor: ProductionArtifactIngestor;
  /** False pauses only fresh dispatch side effects; reconciliation/cancel/ingest continue. */
  allowDispatch?: boolean;
  now?: () => Date | string;
  allocateRemoteJobId?: () => string;
  signal?: AbortSignal;
  lease?: ProductionCoordinatorLeaseOptions;
  hooks?: ProductionCoordinatorHooks;
};

type RunContext = {
  options: ProductionCoordinatorOptions;
  production: ProductionStore;
  control: ProductionCoordinatorStore;
  result: ProductionCoordinatorRunResult;
};

type EventDetail = { type: ProductionTaskEvent["type"] } & Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_BACKEND_ERROR = /^(?:execution_error(?::[A-Za-z_][A-Za-z0-9_.]{0,119})?|execution_interrupted)$/;
const MODEL_FAMILIES = new Set<ProductionModelFamily>(["generic", "minimax-h3"]);

export const PRODUCTION_COORDINATOR_RETRY_BASE_DELAY_MS = 1_000;
export const PRODUCTION_COORDINATOR_RETRY_MAX_DELAY_MS = 300_000;
export const PRODUCTION_COORDINATOR_RETRY_JITTER_WINDOW_MS = 999;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseInputPipeline(value: unknown): ProductionInputPipeline {
  if (!isRecord(value) || value.version !== 1 || typeof value.policy !== "string") {
    throw new ProductionError("production input pipeline 无效");
  }
  if (value.policy === "static-pre-staged") {
    if (Object.keys(value).length !== 2) throw new ProductionError("production input pipeline 字段无效");
    return { version: 1, policy: "static-pre-staged" };
  }
  if (value.policy !== "scoped-staging" || Object.keys(value).length !== 4) {
    throw new ProductionError("production input pipeline 字段无效");
  }
  const inputStager = value.inputStager as ProductionInputStager | undefined;
  const workflowBindingVerifier = value.workflowBindingVerifier as ProductionWorkflowBindingVerifier | undefined;
  if (inputStager === null || inputStager === undefined || typeof inputStager.stage !== "function"
    || workflowBindingVerifier === null || workflowBindingVerifier === undefined
    || typeof workflowBindingVerifier.verify !== "function") {
    throw new ProductionError("production input pipeline 端口无效");
  }
  return { version: 1, policy: "scoped-staging", inputStager, workflowBindingVerifier };
}

function parseWorkflowDescriptor(value: unknown): ProductionWorkflowDescriptor {
  if (!isRecord(value)) throw new ProductionError("production workflow descriptor 必须是对象");
  const fields = ["version", "workflow", "modelFamily", "modelSha256", "parametersSha256"] as const;
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) {
    throw new ProductionError("production workflow descriptor 字段无效");
  }
  if (value.version !== 1 || !isRecord(value.workflow)
    || typeof value.modelFamily !== "string" || !MODEL_FAMILIES.has(value.modelFamily as ProductionModelFamily)
    || typeof value.modelSha256 !== "string" || !SHA256.test(value.modelSha256)
    || typeof value.parametersSha256 !== "string" || !SHA256.test(value.parametersSha256)) {
    throw new ProductionError("production workflow descriptor 内容无效");
  }
  return {
    version: 1,
    workflow: structuredClone(value.workflow),
    modelFamily: value.modelFamily as ProductionModelFamily,
    modelSha256: value.modelSha256,
    parametersSha256: value.parametersSha256,
  };
}

function canonicalIso(value: Date | string, subject: string): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string" || text.length > 64) throw new ProductionError(`${subject} 必须是规范 UTC ISO-8601 时间`);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new ProductionError(`${subject} 必须是规范 UTC ISO-8601 时间`);
  }
  return text;
}

function timestamp(context: RunContext, ...floors: Array<string | null | undefined>): string {
  const current = canonicalIso((context.options.now ?? (() => new Date()))(), "ProductionCoordinator clock");
  let milliseconds = Date.parse(current);
  for (const floor of floors) {
    if (floor === null || floor === undefined) continue;
    milliseconds = Math.max(milliseconds, Date.parse(canonicalIso(floor, "ProductionCoordinator timestamp floor")));
  }
  return new Date(milliseconds).toISOString();
}

/** Digest the exact JSON representation supplied to an adapter as the trusted workflow. */
export function productionWorkflowSha256(workflow: Record<string, unknown>): string {
  try { return productionCanonicalJsonSha256(workflow); }
  catch { throw new ProductionError("production workflow 不是规范 JSON"); }
}

function issue(context: RunContext, taskId: string, code: ProductionCoordinatorIssueCode): void {
  context.result.issues.push({ version: 1, taskId, code });
}

function taskById(context: RunContext, taskId: string): ProductionTask {
  const task = context.production.read().tasks.find((row) => row.id === taskId);
  if (!task) throw new ProductionError(`production task ${taskId} 不存在`);
  return task;
}

function baseControl(task: ProductionTask): ProductionCoordinatorTaskControl {
  return {
    version: 1,
    taskId: task.id,
    observedTaskRevision: task.revision,
    budgetReservation: null,
    retryState: emptyRetryState(),
    cancelAttempt: null,
    lastObservation: null,
    pendingEvent: null,
  };
}

function putControl(
  context: RunContext,
  control: ProductionCoordinatorTaskControl,
  occurredAt?: string,
): ProductionCoordinatorTaskControl {
  const snapshot = context.control.read();
  const updatedAt = timestamp(context, snapshot.updatedAt, occurredAt);
  return context.control.put({
    expectedRevision: snapshot.revision,
    updatedAt,
    task: control,
  }).state.tasks.find((row) => row.taskId === control.taskId)!;
}

/** Get/create a control row and safely acknowledge external authoritative events. */
function controlForTask(context: RunContext, task: ProductionTask): ProductionCoordinatorTaskControl {
  const snapshot = context.control.read();
  const existing = snapshot.tasks.find((row) => row.taskId === task.id);
  if (!existing) return putControl(context, baseControl(task), task.updatedAt);
  if (existing.pendingEvent !== null) {
    throw new ProductionError(`production coordinator task ${task.id} 仍有未重放 pendingEvent`);
  }
  if (existing.observedTaskRevision > task.revision) {
    throw new ProductionError(`production coordinator control ${task.id} 超前于 authoritative task revision`);
  }
  if (existing.observedTaskRevision === task.revision) return existing;
  return putControl(context, { ...existing, observedTaskRevision: task.revision }, task.updatedAt);
}

function makeEvent(context: RunContext, task: ProductionTask, detail: EventDetail, floor?: string): ProductionTaskEvent {
  const occurredAt = timestamp(context, task.updatedAt, floor);
  const probe = parseProductionTaskEvent({
    version: 1,
    eventId: "coordinator-probe",
    taskId: task.id,
    expectedRevision: task.revision,
    occurredAt,
    ...detail,
  });
  const { eventId: _probeId, ...canonicalIdentity } = probe;
  const eventId = `pc:${createHash("sha256").update(JSON.stringify(canonicalIdentity), "utf8").digest("hex")}`;
  if (eventId.length > 128) throw new ProductionError("production coordinator eventId 超过 128 位");
  return parseProductionTaskEvent({ ...probe, eventId });
}

/** control.pendingEvent -> authoritative apply -> exact +1 clear. */
function persistAndApplyEvent(
  context: RunContext,
  taskValue: ProductionTask,
  detail: EventDetail,
  floor?: string,
): ApplyProductionEventResult {
  const task = taskById(context, taskValue.id);
  const control = controlForTask(context, task);
  const event = makeEvent(context, task, detail, floor);
  putControl(context, { ...control, observedTaskRevision: task.revision, pendingEvent: event }, event.occurredAt);
  context.options.hooks?.afterPendingEventPersisted?.(event);
  const applied = context.production.apply(event);
  if (applied.task.revision !== event.expectedRevision + 1) {
    throw new ProductionError(`pendingEvent ${event.eventId} 未精确推进一个 task revision`);
  }
  const afterApply = context.control.read().tasks.find((row) => row.taskId === task.id);
  if (!afterApply || JSON.stringify(afterApply.pendingEvent) !== JSON.stringify(event)) {
    throw new ProductionError(`pendingEvent ${event.eventId} 在 apply 后丢失或被替换`);
  }
  putControl(context, {
    ...afterApply,
    observedTaskRevision: event.expectedRevision + 1,
    pendingEvent: null,
  }, event.occurredAt);
  if (applied.applied) context.result.eventsApplied++;
  return applied;
}

function replayPendingEvents(context: RunContext): void {
  const pending = context.control.read().tasks
    .filter((row) => row.pendingEvent !== null)
    .sort((left, right) => compareProductionAscii(left.taskId, right.taskId));
  for (const row of pending) {
    const event = row.pendingEvent!;
    const applied = context.production.apply(event);
    if (applied.task.revision !== event.expectedRevision + 1) {
      throw new ProductionError(`pendingEvent ${event.eventId} 不能精确重放到 revision ${event.expectedRevision + 1}`);
    }
    const current = context.control.read().tasks.find((item) => item.taskId === row.taskId);
    if (!current || JSON.stringify(current.pendingEvent) !== JSON.stringify(event)) {
      throw new ProductionError(`pendingEvent ${event.eventId} 在重放期间被替换`);
    }
    putControl(context, {
      ...current,
      observedTaskRevision: event.expectedRevision + 1,
      pendingEvent: null,
    }, event.occurredAt);
    if (applied.applied) context.result.eventsApplied++;
  }
}

function adapterFailureCode(error: unknown): CoordinatorFailure["code"] {
  if (error instanceof ProductionAdapterError) return error.code;
  if (error instanceof ProductionIngestorError) {
    if (error.code === "aborted") return "aborted";
    if (error.code === "gateway-rejected") return "remote-rejected";
    if (error.code === "response-too-large") return "response-too-large";
    if (error.code === "invalid-response" || error.code === "invalid-input" || error.code === "invalid-config") {
      return "invalid-response";
    }
    return "remote-unavailable";
  }
  if (error instanceof ProductionInputStagerError) {
    if (error.code === "aborted") return "aborted";
    if (error.code === "gateway-rejected") return "remote-rejected";
    if (error.code === "response-too-large") return "response-too-large";
    if (error.code === "invalid-response" || error.code === "invalid-input" || error.code === "invalid-config") {
      return "invalid-response";
    }
    return "remote-unavailable";
  }
  return "invalid-control-state";
}

/** Deterministic, bounded exponential retry delay; no process-local randomness enters durable state. */
export function productionCoordinatorRetryDelayMs(
  taskId: string,
  operation: CoordinatorOperation,
  attempt: number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_COORDINATOR_RETRY_ATTEMPTS) {
    throw new ProductionError("ProductionCoordinator retry attempt 必须是正安全整数");
  }
  const exponential = Math.min(
    PRODUCTION_COORDINATOR_RETRY_MAX_DELAY_MS - PRODUCTION_COORDINATOR_RETRY_JITTER_WINDOW_MS,
    PRODUCTION_COORDINATOR_RETRY_BASE_DELAY_MS * (2 ** Math.min(attempt - 1, 30)),
  );
  const digest = createHash("sha256").update(`${taskId}\0${operation}\0${attempt}`, "utf8").digest();
  const jitter = digest.readUInt32BE(0) % (PRODUCTION_COORDINATOR_RETRY_JITTER_WINDOW_MS + 1);
  return exponential + jitter;
}

function recordFailure(context: RunContext, task: ProductionTask, operation: CoordinatorOperation, error: unknown): void {
  const control = controlForTask(context, task);
  const occurredAt = timestamp(context, task.updatedAt);
  const attempt = Math.min(MAX_COORDINATOR_RETRY_ATTEMPTS, control.retryState.attempt + 1);
  const notBefore = new Date(
    Date.parse(occurredAt) + productionCoordinatorRetryDelayMs(task.id, operation, attempt),
  ).toISOString();
  putControl(context, {
    ...control,
    retryState: {
      version: 1,
      attempt,
      notBefore,
      lastFailure: { version: 1, operation, code: adapterFailureCode(error), occurredAt },
    },
  }, occurredAt);
}

function resetRetry(context: RunContext, task: ProductionTask): ProductionCoordinatorTaskControl {
  const control = controlForTask(context, task);
  if (control.retryState.attempt === 0) return control;
  return putControl(context, { ...control, retryState: emptyRetryState() }, task.updatedAt);
}

function reserveBudget(
  context: RunContext,
  task: ProductionTask,
  amountMicros: number,
): ProductionCoordinatorTaskControl | null {
  const control = controlForTask(context, task);
  if (amountMicros === 0) return control;
  const existing = control.budgetReservation;
  if (existing !== null) {
    if (existing.state !== "reserved" || existing.reservedAmountMicros !== amountMicros) return null;
    return control;
  }
  const reservedAt = timestamp(context, task.updatedAt);
  return putControl(context, {
    ...control,
    budgetReservation: {
      version: 1,
      state: "reserved",
      currency: "USD",
      reservedAmountMicros: amountMicros,
      reservedAt,
      exposedAt: null,
      releasedAt: null,
    },
  }, reservedAt);
}

function exposeBudget(context: RunContext, task: ProductionTask): void {
  const control = controlForTask(context, task);
  const reservation = control.budgetReservation;
  if (reservation === null || reservation.state === "exposed") return;
  if (reservation.state !== "reserved") {
    throw new ProductionError(`production task ${task.id} 的 budget reservation 已释放，拒绝 remote side effect`);
  }
  const exposedAt = timestamp(context, reservation.reservedAt, task.updatedAt);
  putControl(context, {
    ...control,
    budgetReservation: { ...reservation, state: "exposed", exposedAt, releasedAt: null },
  }, exposedAt);
}

/** Release reservation capacity after authoritative QC reconciliation or a proven local no-submit. */
function releaseBudget(context: RunContext, task: ProductionTask, allowUnexposed: boolean): void {
  // A manually-created/legacy QC task with no coordinator control has nothing to settle. Avoid
  // creating bookkeeping merely by observing a skip-only task.
  if (!context.control.read().tasks.some((row) => row.taskId === task.id)) return;
  const control = controlForTask(context, task);
  const reservation = control.budgetReservation;
  if (reservation === null || reservation.state === "released") return;
  if (reservation.state === "reserved" && !allowUnexposed) return;
  const releasedAt = timestamp(context, reservation.reservedAt, reservation.exposedAt, task.updatedAt);
  putControl(context, {
    ...control,
    budgetReservation: {
      ...reservation,
      state: "released",
      exposedAt: reservation.exposedAt,
      releasedAt,
    },
  }, releasedAt);
}

function settleQcBudget(context: RunContext, task: ProductionTask): void {
  const control = context.control.read().tasks.find((row) => row.taskId === task.id);
  if (control?.budgetReservation === null || control?.budgetReservation === undefined
    || control.budgetReservation.state === "released") return;
  const reconciled = task.cost.state === "known"
    && (task.cost.basis === "reported" || task.cost.basis === "billed");
  if (!reconciled) {
    issue(context, task.id, "cost-unreconciled");
    return;
  }
  releaseBudget(context, task, false);
}

function normalizedObservation(
  task: ProductionTask,
  backendInstanceId: string,
  value: RemoteObservation,
): { remote: RemoteObservation; control: CoordinatorRemoteObservation } {
  try {
    const parsed = parseRemoteObservation(value);
    if (task.remoteJobId === null || parsed.remoteJobId !== task.remoteJobId) {
      throw new ProductionAdapterError("invalid-response", "inspect remoteJobId 与 durable task tuple 不匹配");
    }
    const errorSummary = parsed.state === "failed"
      ? (parsed.errorSummary !== null && SAFE_BACKEND_ERROR.test(parsed.errorSummary)
        ? parsed.errorSummary
        : "execution_error")
      : null;
    const remote = parseRemoteObservation({
      ...parsed,
      outputs: parsed.state === "succeeded" ? parsed.outputs : [],
      errorSummary,
    });
    const control = parseCoordinatorRemoteObservation({
      version: 1,
      backendInstanceId,
      ...remote,
    });
    return { remote, control };
  } catch (error) {
    if (error instanceof ProductionAdapterError) throw error;
    throw new ProductionAdapterError("invalid-response", "inspect response 无法形成安全 durable observation");
  }
}

function saveObservation(
  context: RunContext,
  task: ProductionTask,
  observation: CoordinatorRemoteObservation,
): void {
  const control = controlForTask(context, task);
  putControl(context, {
    ...control,
    retryState: emptyRetryState(),
    lastObservation: observation,
  }, observation.observedAt);
}

function remoteFromControl(observation: CoordinatorRemoteObservation): RemoteObservation {
  return parseRemoteObservation({
    remoteJobId: observation.remoteJobId,
    state: observation.state,
    observedAt: observation.observedAt,
    outputs: observation.outputs,
    errorSummary: observation.errorSummary,
    responseDigest: observation.responseDigest,
  });
}

function factDetail(task: ProductionTask, fact: ProductionReconcileFact): EventDetail {
  if (fact.type === "submission-uncertain") {
    if (task.backendInstanceId === null || task.remoteJobId === null) {
      throw new ProductionError(`production task ${task.id} 缺少 durable remote tuple`);
    }
    return {
      type: "submission-uncertain",
      backendInstanceId: task.backendInstanceId,
      remoteJobId: task.remoteJobId,
      reason: fact.reason,
    };
  }
  return fact as EventDetail;
}

async function ingestSucceeded(
  context: RunContext,
  taskValue: ProductionTask,
  observation: RemoteObservation,
): Promise<void> {
  const task = taskById(context, taskValue.id);
  if (task.status !== "ingesting") return;
  context.result.ingests++;
  let ingested: ProductionIngestResult;
  try {
    const expectedIngestKey = context.options.ingestor.ingestKey(task, observation);
    const result = await context.options.ingestor.ingest(task, observation, context.options.signal);
    if (result.version !== 1 || result.ingestKey !== expectedIngestKey
      || !Array.isArray(result.assets) || result.assets.length < 1
      || result.assets.length > MAX_PRODUCTION_ASSETS_PER_TASK) {
      throw new ProductionIngestorError("invalid-response");
    }
    let assets;
    let cost;
    try {
      assets = result.assets.map((value, index) =>
        parseAssetRef(value, `ProductionIngestResult.assets[${index}]`));
      cost = parseProductionCost(result.cost, "ProductionIngestResult.cost");
    } catch {
      throw new ProductionIngestorError("invalid-response");
    }
    if (new Set(assets.map((value) => value.uri)).size !== assets.length) {
      throw new ProductionIngestorError("invalid-response");
    }
    ingested = {
      version: 1,
      ingestKey: result.ingestKey,
      assets,
      cost,
    };
  } catch (error) {
    recordFailure(context, taskById(context, task.id), "ingest", error);
    issue(context, task.id, "ingest-unavailable");
    return;
  }
  // Durable mutations and fault hooks stay outside the remote catch: a pending qc event must not
  // be obscured by a secondary retry-state write after the gateway already returned.
  resetRetry(context, task);
  const qc = persistAndApplyEvent(context, task, {
    type: "qc-requested",
    assets: ingested.assets,
    cost: ingested.cost,
  }, observation.observedAt);
  settleQcBudget(context, qc.task);
}

async function inspectAndAdvance(
  context: RunContext,
  taskValue: ProductionTask,
  adapter: ProductionAdapter,
): Promise<void> {
  let task = taskById(context, taskValue.id);
  if (task.remoteJobId === null || task.backendInstanceId === null) {
    throw new ProductionError(`production task ${task.id} 缺少 durable remote tuple`);
  }
  context.result.inspections++;
  let normalized: ReturnType<typeof normalizedObservation>;
  try {
    const observation = await adapter.inspect(task.remoteJobId, context.options.signal);
    normalized = normalizedObservation(task, task.backendInstanceId, observation);
  } catch (error) {
    recordFailure(context, task, "inspect", error);
    issue(context, task.id, "inspect-unavailable");
    return;
  }
  saveObservation(context, task, normalized.control);
  const decision = decideProductionObservation(task, normalized.remote);
  for (const fact of decision.facts) {
    task = persistAndApplyEvent(
      context,
      task,
      factDetail(task, fact),
      normalized.remote.observedAt,
    ).task;
  }
  if (decision.reason === "remote-not-found") issue(context, task.id, "remote-not-found");
  if (decision.disposition === "ingest") {
    await ingestSucceeded(context, task, normalized.remote);
  }
}

async function resumeIngest(context: RunContext, task: ProductionTask): Promise<void> {
  const control = controlForTask(context, task);
  if (control.lastObservation === null || control.lastObservation.state !== "succeeded"
    || control.lastObservation.backendInstanceId !== task.backendInstanceId
    || control.lastObservation.remoteJobId !== task.remoteJobId) {
    recordFailure(context, task, "ingest", new ProductionError("missing succeeded observation"));
    issue(context, task.id, "ingest-unavailable");
    return;
  }
  await ingestSucceeded(context, task, remoteFromControl(control.lastObservation));
}

async function dispatchPending(context: RunContext, taskValue: ProductionTask): Promise<void> {
  const task = taskById(context, taskValue.id);
  let intent: ProductionDispatchIntent;
  try {
    const resolved = await context.options.intentResolver.resolve(task.id, context.options.signal);
    if (resolved === null) { issue(context, task.id, "intent-missing"); return; }
    intent = parseProductionDispatchIntent(resolved);
    if (intent.taskId !== task.id || intent.idempotencyKey !== task.idempotencyKey
      || JSON.stringify(intent.subject) !== JSON.stringify(task.subject)) {
      issue(context, task.id, "intent-invalid");
      return;
    }
  } catch {
    issue(context, task.id, "intent-invalid");
    return;
  }

  let gateContext: ProductionIntentGateContext;
  try {
    const supplied = parseProductionIntentGateContext(
      await context.options.gateContextResolver.resolve(intent, task, context.options.signal),
    );
    const outstanding = context.control.read().tasks.reduce((total, row) => {
      if (row.taskId === task.id || row.budgetReservation === null || row.budgetReservation.state === "released") return total;
      return total + row.budgetReservation.reservedAmountMicros;
    }, 0);
    gateContext = {
      ...supplied,
      availableBudgetMicros: Math.max(0, supplied.availableBudgetMicros - outstanding),
    };
    if (!evaluateProductionIntentGates(intent, gateContext).allowed) {
      issue(context, task.id, "gate-denied");
      return;
    }
  } catch {
    issue(context, task.id, "gate-denied");
    return;
  }

  let descriptor: ProductionWorkflowDescriptor;
  try {
    const resolved = await context.options.workflowResolver.resolve(intent, context.options.signal);
    if (resolved === null) { issue(context, task.id, "workflow-missing"); return; }
    descriptor = parseWorkflowDescriptor(resolved);
  } catch {
    issue(context, task.id, "workflow-missing");
    return;
  }
  if (descriptor.modelFamily !== intent.execution.modelFamily) {
    issue(context, task.id, "model-family-mismatch");
    return;
  }
  if (descriptor.modelSha256 !== intent.execution.modelSha256) {
    issue(context, task.id, "model-digest-mismatch");
    return;
  }
  if (descriptor.parametersSha256 !== intent.execution.parametersSha256) {
    issue(context, task.id, "parameters-digest-mismatch");
    return;
  }
  const workflow = descriptor.workflow;
  if (productionWorkflowSha256(workflow) !== intent.execution.workflowSha256) {
    issue(context, task.id, "workflow-digest-mismatch");
    return;
  }
  let submissionWorkflow = workflow;
  let submissionWorkflowSha256 = intent.execution.workflowSha256;

  let inputPipeline: ProductionInputPipeline;
  if (context.options.inputPipelineResolver !== undefined) {
    try {
      const resolved = await context.options.inputPipelineResolver.resolve(intent, context.options.signal);
      if (resolved === null) throw new ProductionError("production input pipeline 未注册");
      inputPipeline = parseInputPipeline(resolved);
    } catch {
      issue(context, task.id, "input-stager-missing");
      return;
    }
  } else if (context.options.inputStager === undefined) {
    if (intent.execution.modelFamily === "minimax-h3"
      || context.options.unstagedGenericInputMode !== "static-or-pre-staged") {
      issue(context, task.id, "input-stager-missing");
      return;
    }
    inputPipeline = { version: 1, policy: "static-pre-staged" };
  } else {
    if (context.options.workflowBindingVerifier === undefined) {
      issue(context, task.id, "workflow-binding-verifier-missing");
      return;
    }
    inputPipeline = {
      version: 1,
      policy: "scoped-staging",
      inputStager: context.options.inputStager,
      workflowBindingVerifier: context.options.workflowBindingVerifier,
    };
  }

  let staged: ProductionInputStageResult | null = null;
  if (inputPipeline.policy === "scoped-staging") {
    try {
      staged = parseProductionInputStageResult(
        await inputPipeline.inputStager.stage(intent, context.options.signal),
        intent,
        productionInputStageKey(context.options.workspaceId, context.options.project, intent),
      );
    } catch (error) {
      recordFailure(context, taskById(context, task.id), "stage-inputs", error);
      issue(context, task.id, "input-staging-unavailable");
      return;
    }
    try {
      const verification = await inputPipeline.workflowBindingVerifier.verify(
        intent,
        structuredClone(workflow),
        staged,
        context.options.signal,
      );
      const parsedVerification = parseProductionWorkflowBindingVerification(verification, {
        templateWorkflowSha256: intent.execution.workflowSha256,
        stageKey: staged.stageKey,
        bindingsDigest: staged.bindingsDigest,
      });
      submissionWorkflow = parsedVerification.workflow;
      submissionWorkflowSha256 = parsedVerification.boundWorkflowSha256;
      resetRetry(context, task);
    } catch (error) {
      recordFailure(context, taskById(context, task.id), "stage-inputs", error);
      issue(context, task.id, "workflow-bindings-invalid");
      return;
    }
  }

  const adapter = context.options.adapterRegistry.resolve(intent.execution.backendInstanceId);
  if (adapter === null) { issue(context, task.id, "adapter-missing"); return; }

  const remoteJobId = (context.options.allocateRemoteJobId ?? randomUUID)();
  let prepared: PreparedSubmission;
  try {
    prepared = adapter.prepareSubmission({
      idempotencyKey: task.idempotencyKey,
      remoteJobId,
      workflow: submissionWorkflow,
      inputBinding: staged === null ? null : {
        version: 1,
        stageKey: staged.stageKey,
        bindingsDigest: staged.bindingsDigest,
        intentDigest: intent.idempotencyKey,
      },
    });
    if (prepared.version !== 1
      || prepared.backendInstanceId !== intent.execution.backendInstanceId
      || prepared.remoteJobId !== remoteJobId
      || prepared.idempotencyKey !== task.idempotencyKey
      || !SHA256.test(prepared.requestDigest)
      || prepared.request.remoteJobId !== remoteJobId
      || prepared.request.idempotencyKey !== task.idempotencyKey
      || JSON.stringify(prepared.request.inputBinding) !== JSON.stringify(staged === null ? null : {
        version: 1,
        stageKey: staged.stageKey,
        bindingsDigest: staged.bindingsDigest,
        intentDigest: intent.idempotencyKey,
      })
      || productionWorkflowSha256(prepared.request.workflow) !== submissionWorkflowSha256) {
      throw new ProductionAdapterError("remote-rejected", "prepared submission 与 immutable intent 不匹配");
    }
  } catch {
    issue(context, task.id, "intent-invalid");
    return;
  }

  // A caller-controlled estimate is informational, not a spending cap. Reserve the immutable
  // maximum so estimate=0 cannot create an untracked billable submission.
  if (reserveBudget(context, task, intent.budget.maximumAmountMicros) === null) {
    issue(context, task.id, "budget-reservation-conflict");
    return;
  }
  let current = persistAndApplyEvent(context, task, {
    type: "submission-started",
    backendInstanceId: prepared.backendInstanceId,
    remoteJobId: prepared.remoteJobId,
    requestDigest: prepared.requestDigest,
  }).task;
  context.options.hooks?.afterSubmissionStarted?.(current, prepared);
  exposeBudget(context, current);
  context.options.hooks?.beforeSubmit?.(current, prepared);
  context.result.submissions++;
  let submitted: SubmitResult;
  try {
    submitted = await adapter.submitPrepared(prepared, context.options.signal);
    if (submitted.remoteJobId !== prepared.remoteJobId
      || submitted.providerIdempotency !== false
      || !Number.isSafeInteger(submitted.nodeErrorCount) || submitted.nodeErrorCount < 0
      || !SHA256.test(submitted.responseDigest)) {
      throw new ProductionAdapterError("submission-unknown", "submit response remoteJobId 不匹配");
    }
    try { canonicalIso(submitted.acceptedAt, "Production submit acceptedAt"); }
    catch { throw new ProductionAdapterError("submission-unknown", "submit response acceptedAt 无效"); }
  } catch (error) {
    recordFailure(context, taskById(context, task.id), "submit", error);
    const latest = taskById(context, task.id);
    if (latest.status === "submitting") {
      persistAndApplyEvent(context, latest, {
        type: "submission-uncertain",
        backendInstanceId: prepared.backendInstanceId,
        remoteJobId: prepared.remoteJobId,
        reason: `submit-exception:${adapterFailureCode(error)}`,
      });
    }
    issue(context, task.id, "submit-unknown");
    return;
  }
  // Crash/fault hooks and durable-ledger failures are intentionally outside the submit catch.
  // The provider may have accepted the job; converting a local commit failure into another
  // coordinator mutation can obscure pendingEvent. Recovery must instead replay/inspect.
  context.options.hooks?.afterSubmitReturned?.(current, prepared);
  current = persistAndApplyEvent(context, current, {
    type: "submission-confirmed",
    backendInstanceId: prepared.backendInstanceId,
    remoteJobId: prepared.remoteJobId,
  }, submitted.acceptedAt).task;
  await inspectAndAdvance(context, current, adapter);
}

async function cancelRequested(context: RunContext, taskValue: ProductionTask): Promise<void> {
  let task = taskById(context, taskValue.id);
  if (task.remoteJobId === null && task.backendInstanceId === null) {
    const cancelled = persistAndApplyEvent(context, task, {
      type: "cancelled",
      reason: "local-cancelled-before-submission",
      confirmation: { version: 1, kind: "local-no-submission" },
    });
    releaseBudget(context, cancelled.task, true);
    return;
  }
  if (task.remoteJobId === null || task.backendInstanceId === null) {
    throw new ProductionError(`production task ${task.id} cancellation remote tuple 不完整`);
  }
  const adapter = context.options.adapterRegistry.resolve(task.backendInstanceId);
  if (adapter === null) { issue(context, task.id, "adapter-missing"); return; }
  let control = controlForTask(context, task);
  if (control.cancelAttempt !== null
    && (control.cancelAttempt.backendInstanceId !== task.backendInstanceId
      || control.cancelAttempt.remoteJobId !== task.remoteJobId)) {
    throw new ProductionError(`production task ${task.id} cancelAttempt remote tuple 冲突`);
  }
  if (control.cancelAttempt === null) {
    const preparedAt = timestamp(context, task.updatedAt);
    control = putControl(context, {
      ...control,
      cancelAttempt: {
        version: 1,
        state: "prepared",
        backendInstanceId: task.backendInstanceId,
        remoteJobId: task.remoteJobId,
        preparedAt,
      },
    }, preparedAt);
    context.options.hooks?.afterCancelPrepared?.(task);
    context.result.cancellationAttempts++;
    let cancelResult: Awaited<ReturnType<ProductionAdapter["cancel"]>> | null = null;
    try {
      cancelResult = await adapter.cancel(task.remoteJobId, context.options.signal);
      if (cancelResult.remoteJobId !== task.remoteJobId || cancelResult.confirmed !== false
        || typeof cancelResult.accepted !== "boolean"
        || typeof cancelResult.runningInterruptRequested !== "boolean") {
        throw new ProductionAdapterError("invalid-response", "cancel response 与 durable remote tuple 不匹配");
      }
      try { canonicalIso(cancelResult.observedAt, "Production cancel observedAt"); }
      catch { throw new ProductionAdapterError("invalid-response", "cancel response observedAt 无效"); }
    } catch (error) {
      recordFailure(context, task, "cancel", error);
      cancelResult = null;
    }
    if (cancelResult !== null) {
      // As for submission, crash hooks and control commit failures must leave prepared durable and
      // propagate. Recovery treats that side effect as ambiguous and only inspects.
      context.options.hooks?.afterCancelReturned?.(task);
      const attemptedAt = timestamp(context, preparedAt, cancelResult.observedAt);
      control = controlForTask(context, task);
      putControl(context, {
        ...control,
        retryState: emptyRetryState(),
        cancelAttempt: {
          version: 1,
          state: "attempted",
          backendInstanceId: task.backendInstanceId,
          remoteJobId: task.remoteJobId,
          preparedAt,
          attemptedAt,
          accepted: cancelResult.accepted,
          confirmed: false,
          runningInterruptRequested: cancelResult.runningInterruptRequested,
        },
      }, attemptedAt);
    }
  }
  task = taskById(context, task.id);
  await inspectAndAdvance(context, task, adapter);
  if (taskById(context, task.id).status === "cancel-requested") {
    issue(context, task.id, "cancel-unconfirmed");
  }
}

async function processTask(context: RunContext, taskId: string): Promise<void> {
  const task = taskById(context, taskId);
  context.result.tasksVisited++;
  if (context.options.signal?.aborted) {
    context.result.skipped++;
    return;
  }
  if (task.status === "qc-pending" || task.status === "approved" || task.status === "rejected") {
    // Completes a crash that happened after qc-requested/approval but before control release.
    settleQcBudget(context, task);
    context.result.skipped++;
    return;
  }
  if (task.status === "cancelled" && task.cancellationConfirmation?.kind === "local-no-submission") {
    releaseBudget(context, task, true);
    context.result.skipped++;
    return;
  }
  if (task.status === "failed" && task.backendInstanceId === null
    && task.remoteJobId === null && task.submissionOutbox === null) {
    releaseBudget(context, task, true);
    context.result.skipped++;
    return;
  }
  const taskControl = context.control.read().tasks.find((row) => row.taskId === task.id);
  const retry = taskControl?.retryState;
  if (retry?.notBefore !== null && retry?.notBefore !== undefined && retry.lastFailure !== null) {
    // A deadline belongs to the operation that failed, not to the task as a whole. In particular,
    // an inspect backoff must never delay a newly requested cancellation while the remote job may
    // still be running and billing. A prepared/attempted cancellation is inspect-only and does
    // continue to respect an inspect deadline.
    const nextOperation: CoordinatorOperation | null = task.status === "dispatch-pending"
      ? retry.lastFailure.operation === "stage-inputs" ? "stage-inputs" : "submit"
      : task.status === "ingesting" ? "ingest"
      : task.status === "cancel-requested"
        ? taskControl?.cancelAttempt === null || taskControl?.cancelAttempt === undefined ? "cancel" : "inspect"
        : task.status === "submitting" || task.status === "submission-unknown"
          ? retry.lastFailure.operation === "submit" ? "submit" : "inspect"
          : task.status === "submitted" || task.status === "running" ? "inspect"
          : null;
    const now = canonicalIso((context.options.now ?? (() => new Date()))(), "ProductionCoordinator clock");
    if (nextOperation === retry.lastFailure.operation && now < retry.notBefore) {
      context.result.skipped++;
      return;
    }
  }
  if (isTerminalProductionStatus(task.status) || task.status === "planned") {
    context.result.skipped++;
    return;
  }
  if (task.status === "dispatch-pending") {
    if (context.options.allowDispatch === false) {
      context.result.skipped++;
      return;
    }
    await dispatchPending(context, task);
    return;
  }
  if (task.status === "ingesting") {
    await resumeIngest(context, task);
    return;
  }
  if (task.status === "cancel-requested") {
    await cancelRequested(context, task);
    return;
  }
  if (task.backendInstanceId === null || task.remoteJobId === null) {
    throw new ProductionError(`production task ${task.id} status=${task.status} 缺少 durable remote tuple`);
  }
  const adapter = context.options.adapterRegistry.resolve(task.backendInstanceId);
  if (adapter === null) { issue(context, task.id, "adapter-missing"); return; }
  // A recovered submitting task may already have crossed the provider boundary. Exposure is
  // conservative and the only safe action is inspect; submitPrepared is never called here.
  if (task.status === "submitting") exposeBudget(context, task);
  await inspectAndAdvance(context, task, adapter);
}

/** Run one serial, project-scoped coordinator round. */
export async function runProductionProjectOnce(
  options: ProductionCoordinatorOptions,
): Promise<ProductionCoordinatorRunResult> {
  if (options.inputPipelineResolver !== undefined
    && (options.inputStager !== undefined || options.workflowBindingVerifier !== undefined
      || options.unstagedGenericInputMode !== undefined)) {
    throw new ProductionError("inputPipelineResolver 不能与 legacy input pipeline options 混用");
  }
  const result: ProductionCoordinatorRunResult = {
    version: 1,
    project: options.project,
    tasksVisited: 0,
    submissions: 0,
    inspections: 0,
    cancellationAttempts: 0,
    ingests: 0,
    eventsApplied: 0,
    skipped: 0,
    issues: [],
  };
  return await withProductionCoordinatorLease(options.root, options.workspaceId, options.project, async () => {
    const context: RunContext = {
      options,
      production: new ProductionStore(options.root, options.workspaceId, options.project),
      control: new ProductionCoordinatorStore(options.root, options.workspaceId, options.project),
      result,
    };
    // Exact durable event replay always precedes any dependency resolution or remote I/O.
    replayPendingEvents(context);
    const taskIds = context.production.read().tasks.map((task) => task.id).sort(compareProductionAscii);
    for (const taskId of taskIds) await processTask(context, taskId);
    return result;
  }, options.lease);
}
