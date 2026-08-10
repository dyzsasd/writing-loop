// Pure, local-only projection of the crash-recovery control ledger.
//
// This deliberately exposes stable categories and counters only. Provider messages, credentials,
// workflow bodies and transient output URLs never enter the control document or this read model.
import { compareProductionAscii, type ProductionTaskEvent } from "./production-domain.ts";
import {
  parseProductionCoordinatorControlState,
  type CoordinatorFailure,
  type CoordinatorOperation,
  type ProductionCoordinatorControlState,
} from "./production-coordinator-domain.ts";
import type { RemoteJobState } from "./production-adapter.ts";

export type ProductionCoordinatorTaskView = {
  version: 1;
  taskId: string;
  observedTaskRevision: number;
  budget: {
    state: "none" | "reserved" | "exposed" | "released";
    reservedAmountMicros: number | null;
    reservedAt: string | null;
    exposedAt: string | null;
    releasedAt: string | null;
  };
  retry: {
    attempt: number;
    notBefore: string | null;
    operation: CoordinatorOperation | null;
    code: CoordinatorFailure["code"] | null;
  };
  cancelAttempt: "none" | "prepared" | "attempted";
  remote: {
    state: RemoteJobState | null;
    observedAt: string | null;
  };
  pendingEvent: ProductionTaskEvent["type"] | null;
};

export type ProductionCoordinatorReadModel = {
  version: 1;
  workspaceId: string;
  project: string;
  revision: number;
  updatedAt: string | null;
  summary: {
    tracked: number;
    pendingEvents: number;
    tasksWithRetryHistory: number;
    cancellationAttempts: number;
    lastObservedNotFound: number;
    budget: {
      reservedAmountMicros: number;
      exposedAmountMicros: number;
    };
  };
  tasks: ProductionCoordinatorTaskView[];
};

/** Build a deterministic read model without reading a clock, filesystem or backend. */
export function buildProductionCoordinatorReadModel(
  value: ProductionCoordinatorControlState,
): ProductionCoordinatorReadModel {
  const state = parseProductionCoordinatorControlState(value);
  const tasks: ProductionCoordinatorTaskView[] = state.tasks.map((task) => ({
    version: 1 as const,
    taskId: task.taskId,
    observedTaskRevision: task.observedTaskRevision,
    budget: task.budgetReservation === null
      ? {
          state: "none" as const,
          reservedAmountMicros: null,
          reservedAt: null,
          exposedAt: null,
          releasedAt: null,
        }
      : {
          state: task.budgetReservation.state,
          reservedAmountMicros: task.budgetReservation.reservedAmountMicros,
          reservedAt: task.budgetReservation.reservedAt,
          exposedAt: task.budgetReservation.exposedAt,
          releasedAt: task.budgetReservation.releasedAt,
        },
    retry: {
      attempt: task.retryState.attempt,
      notBefore: task.retryState.notBefore,
      operation: task.retryState.lastFailure?.operation ?? null,
      code: task.retryState.lastFailure?.code ?? null,
    },
    cancelAttempt: task.cancelAttempt?.state ?? "none" as const,
    remote: {
      state: task.lastObservation?.state ?? null,
      observedAt: task.lastObservation?.observedAt ?? null,
    },
    pendingEvent: task.pendingEvent?.type ?? null,
  })).sort((left, right) => compareProductionAscii(left.taskId, right.taskId));

  let reservedAmountMicros = 0;
  let exposedAmountMicros = 0;
  for (const task of state.tasks) {
    if (task.budgetReservation?.state === "reserved") {
      reservedAmountMicros += task.budgetReservation.reservedAmountMicros;
    } else if (task.budgetReservation?.state === "exposed") {
      exposedAmountMicros += task.budgetReservation.reservedAmountMicros;
    }
  }
  return {
    version: 1,
    workspaceId: state.workspaceId,
    project: state.project,
    revision: state.revision,
    updatedAt: state.updatedAt,
    summary: {
      tracked: tasks.length,
      pendingEvents: tasks.filter((task) => task.pendingEvent !== null).length,
      tasksWithRetryHistory: tasks.filter((task) => task.retry.attempt > 0).length,
      cancellationAttempts: tasks.filter((task) => task.cancelAttempt !== "none").length,
      lastObservedNotFound: tasks.filter((task) => task.remote.state === "not-found").length,
      budget: { reservedAmountMicros, exposedAmountMicros },
    },
    tasks,
  };
}
