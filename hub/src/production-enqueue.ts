// Crash-safe local enqueue boundary for Phase 3C.
//
// This module deliberately performs no provider or gateway I/O.  It first publishes the immutable
// dispatch intent, then creates the authoritative task, and only then records dispatch-requested.
// Every step is exactly replayable, so a process crash can leave at most an orphan intent or a
// planned task; the same input resumes forward without deleting evidence or duplicating a job.
import { createHash } from "node:crypto";
import {
  createProductionDispatchIntent,
  enqueueProductionIntent,
  type ProductionDispatchIntent,
} from "./production-intent.ts";
import {
  parseProductionTaskEvent,
  type ProductionState,
  type ProductionTask,
} from "./production-domain.ts";
import { ProductionStore } from "./production-store.ts";

export type ProductionEnqueueHooks = {
  /** Immutable intent is durable; no authoritative task is necessarily present yet. */
  afterIntentPersisted?: (intent: ProductionDispatchIntent) => void;
  /** Authoritative task is durable and may still be planned. */
  afterTaskCreated?: (task: ProductionTask) => void;
};

export type EnqueueProductionTaskOptions = {
  root: string;
  workspaceId: string;
  project: string;
  draft: unknown;
  hooks?: ProductionEnqueueHooks;
};

export type ProductionEnqueuePlan = {
  version: 1;
  workspaceId: string;
  project: string;
  planId: string;
  intent: ProductionDispatchIntent;
};

export type EnqueueProductionTaskResult = {
  version: 1;
  intentCreated: boolean;
  taskCreated: boolean;
  dispatchApplied: boolean;
  intent: ProductionDispatchIntent;
  task: ProductionTask;
  state: ProductionState;
};

/** Zero-write plan. The fingerprint binds the stable workspace namespace, project and full intent. */
export function planProductionTaskEnqueue(options: {
  workspaceId: string;
  project: string;
  draft: unknown;
}): ProductionEnqueuePlan {
  const intent = createProductionDispatchIntent(options.draft);
  const identity = {
    version: 1 as const,
    workspaceId: options.workspaceId,
    project: options.project,
    intent,
  };
  const planId = createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
  return { ...identity, planId };
}

/** Confirm a zero-write plan before publishing the local dispatch request. */
export function commitProductionTaskEnqueue(
  options: EnqueueProductionTaskOptions & { confirm: string },
): EnqueueProductionTaskResult {
  const plan = planProductionTaskEnqueue(options);
  if (options.confirm !== plan.planId) {
    throw new Error("production enqueue 确认指纹不匹配；请重新执行 --plan");
  }
  return enqueueProductionTask(options);
}

/**
 * Publish one immutable dispatch request without touching a remote service.
 *
 * Durable ordering is intentional:
 *   intent O_EXCL -> task create -> dispatch-requested.
 * An exact retry resumes any prefix.  A conflicting task/intent fails closed and the already
 * published immutable evidence is retained for operator audit.
 */
export function enqueueProductionTask(options: EnqueueProductionTaskOptions): EnqueueProductionTaskResult {
  const intent = createProductionDispatchIntent(options.draft);
  const intentResult = enqueueProductionIntent(options.root, options.project, intent);
  options.hooks?.afterIntentPersisted?.(intentResult.intent);

  const store = new ProductionStore(options.root, options.workspaceId, options.project);
  const created = store.create({
    version: 1,
    id: intent.taskId,
    idempotencyKey: intent.idempotencyKey,
    subject: intent.subject,
    createdAt: intent.createdAt,
  });
  options.hooks?.afterTaskCreated?.(created.task);

  if (created.task.status !== "planned") {
    return {
      version: 1,
      intentCreated: intentResult.created,
      taskCreated: created.created,
      dispatchApplied: false,
      intent: intentResult.intent,
      task: created.task,
      state: created.state,
    };
  }

  const dispatched = store.apply(parseProductionTaskEvent({
    version: 1,
    eventId: `enqueue:${intent.idempotencyKey}`,
    taskId: intent.taskId,
    expectedRevision: created.task.revision,
    occurredAt: created.task.updatedAt,
    type: "dispatch-requested",
  }));
  return {
    version: 1,
    intentCreated: intentResult.created,
    taskCreated: created.created,
    dispatchApplied: dispatched.applied,
    intent: intentResult.intent,
    task: dispatched.task,
    state: dispatched.state,
  };
}
