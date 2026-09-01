// Stable, offline projection of the authoritative production state.
// No wall clock or backend lookup participates, so identical state bytes always produce identical
// JSON (including task ordering and a deliberately honest unknown cost summary).
import {
  PRODUCTION_COST_BASES,
  PRODUCTION_STATUSES,
  compareProductionAscii,
  isTerminalProductionStatus,
  parseProductionState,
  subjectRevision,
  type ProductionApproval,
  type ProductionCancellationConfirmation,
  type ProductionCancellationRequest,
  type ProductionCost,
  type ProductionCostBasis,
  type ProductionState,
  type ProductionStatus,
} from "./production-domain.ts";

export type ProductionCostBasisSubtotal = {
  amountMicros: number;
  tasks: number;
};

export type ProductionCostSummary = {
  currency: "USD";
  /** Estimates are planning facts, never evidence that money was actually incurred. */
  estimatedAmountMicros: number;
  estimatedTasks: number;
  /** Known amounts split by how each was determined; bases never collapse into one total. */
  byBasis: Record<ProductionCostBasis, ProductionCostBasisSubtotal>;
  actual: {
    state: "known" | "unknown";
    /** Null means a complete actual total cannot be stated; knownAmountMicros is only a subtotal. */
    amountMicros: number | null;
    knownAmountMicros: number;
    unknownTasks: number;
    reason: null | "not-recorded" | "partial-or-unreported";
  };
};

export type ProductionTaskView = {
  id: string;
  idempotencyKey: string;
  kind: "episode" | "shot";
  episodeId: string;
  shotId: string | null;
  subjectRevision: number;
  status: ProductionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  backendInstanceId: string | null;
  remoteJobId: string | null;
  submissionState: "pending" | "acknowledged" | "unknown" | null;
  cancellationRequest: ProductionCancellationRequest | null;
  cancellationConfirmation: ProductionCancellationConfirmation | null;
  assetCount: number;
  cost: ProductionCost;
  approval: ProductionApproval | null;
  statusMessage: string | null;
};

export type ProductionReadModel = {
  version: 1;
  workspaceId: string;
  project: string;
  revision: number;
  updatedAt: string | null;
  summary: {
    total: number;
    active: number;
    terminal: number;
    needsAttention: number;
    byStatus: Record<ProductionStatus, number>;
    cost: ProductionCostSummary;
  };
  tasks: ProductionTaskView[];
};

const ACTIVE_STATUSES = new Set<ProductionStatus>([
  "dispatch-pending", "submitting", "submitted", "running", "ingesting", "qc-pending",
  "submission-unknown", "cancel-requested",
]);

const ATTENTION_STATUSES = new Set<ProductionStatus>([
  "qc-pending", "rejected", "submission-unknown", "failed", "cancel-requested", "orphaned",
]);

function emptyStatusCounts(): Record<ProductionStatus, number> {
  return {
    planned: 0,
    "dispatch-pending": 0,
    submitting: 0,
    submitted: 0,
    running: 0,
    ingesting: 0,
    "qc-pending": 0,
    approved: 0,
    rejected: 0,
    "submission-unknown": 0,
    failed: 0,
    "cancel-requested": 0,
    cancelled: 0,
    orphaned: 0,
  };
}

function emptyBasisSubtotals(): Record<ProductionCostBasis, ProductionCostBasisSubtotal> {
  return {
    reported: { amountMicros: 0, tasks: 0 },
    billed: { amountMicros: 0, tasks: 0 },
    estimated: { amountMicros: 0, tasks: 0 },
    tariff: { amountMicros: 0, tasks: 0 },
    "reported-converted": { amountMicros: 0, tasks: 0 },
  };
}

function costSummary(state: ProductionState): ProductionCostSummary {
  let knownActualAmountMicros = 0;
  let unknownActualTasks = 0;
  let estimatedAmountMicros = 0;
  let estimatedTasks = 0;
  let onlyNotRecorded = true;
  const byBasis = emptyBasisSubtotals();
  for (const task of state.tasks) {
    if (task.cost.state === "known") {
      byBasis[task.cost.basis].amountMicros += task.cost.amountMicros;
      byBasis[task.cost.basis].tasks++;
    }
    if (task.cost.state === "known" && task.cost.basis === "estimated") {
      estimatedAmountMicros += task.cost.amountMicros;
      estimatedTasks++;
      unknownActualTasks++;
      onlyNotRecorded = false;
    } else if (task.cost.state === "known") {
      knownActualAmountMicros += task.cost.amountMicros;
      onlyNotRecorded = false;
    } else {
      unknownActualTasks++;
      if (task.cost.reason !== "not-recorded") onlyNotRecorded = false;
    }
  }
  const base = { currency: "USD" as const, estimatedAmountMicros, estimatedTasks, byBasis };
  if (state.tasks.length > 0 && unknownActualTasks === 0) {
    return {
      ...base,
      actual: {
        state: "known",
        amountMicros: knownActualAmountMicros,
        knownAmountMicros: knownActualAmountMicros,
        unknownTasks: 0,
        reason: null,
      },
    };
  }
  return {
    ...base,
    actual: {
      state: "unknown",
      amountMicros: null,
      knownAmountMicros: knownActualAmountMicros,
      unknownTasks: unknownActualTasks,
      reason: state.tasks.length === 0 || onlyNotRecorded ? "not-recorded" : "partial-or-unreported",
    },
  };
}

function taskView(task: ProductionState["tasks"][number]): ProductionTaskView {
  const episode = task.subject.kind === "episode" ? task.subject.episode : task.subject.shot.episode;
  return {
    id: task.id,
    idempotencyKey: task.idempotencyKey,
    kind: task.subject.kind,
    episodeId: episode.episodeId,
    shotId: task.subject.kind === "shot" ? task.subject.shot.shotId : null,
    subjectRevision: subjectRevision(task.subject),
    status: task.status,
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    backendInstanceId: task.backendInstanceId,
    remoteJobId: task.remoteJobId,
    submissionState: task.submissionOutbox?.state ?? null,
    cancellationRequest: task.cancellationRequest,
    cancellationConfirmation: task.cancellationConfirmation,
    assetCount: task.assets.length,
    cost: task.cost,
    approval: task.approval,
    statusMessage: task.statusMessage,
  };
}

export function buildProductionReadModel(value: ProductionState): ProductionReadModel {
  const state = parseProductionState(value);
  const byStatus = emptyStatusCounts();
  let active = 0;
  let terminal = 0;
  let needsAttention = 0;
  for (const task of state.tasks) {
    byStatus[task.status]++;
    if (ACTIVE_STATUSES.has(task.status)) active++;
    if (isTerminalProductionStatus(task.status)) terminal++;
    if (ATTENTION_STATUSES.has(task.status)) needsAttention++;
  }
  // Keep an explicit assertion adjacent to the fixed-key projection: adding a domain status without
  // updating this v1 view must fail loudly in development rather than disappearing from Studio.
  if (Object.keys(byStatus).length !== PRODUCTION_STATUSES.length) {
    throw new Error("production read model status table is out of sync with the v1 domain");
  }
  const cost = costSummary(state);
  if (Object.keys(cost.byBasis).length !== PRODUCTION_COST_BASES.length) {
    throw new Error("production read model cost basis table is out of sync with the v1 domain");
  }
  const tasks = state.tasks.map(taskView).sort((left, right) =>
    compareProductionAscii(right.updatedAt, left.updatedAt) || compareProductionAscii(left.id, right.id));
  return {
    version: 1,
    workspaceId: state.workspaceId,
    project: state.project,
    revision: state.revision,
    updatedAt: state.updatedAt,
    summary: {
      total: state.tasks.length,
      active,
      terminal,
      needsAttention,
      byStatus,
      cost,
    },
    tasks,
  };
}
