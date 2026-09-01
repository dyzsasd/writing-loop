// Phase 3B coordinator crash boundaries: at-most-once submit/cancel, exact outbox replay,
// idempotent ingest, strong cancellation evidence and project single-flight.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionAdapterError,
  type BackendCapabilities,
  type CancelResult,
  type PreparedSubmission,
  type ProductionAdapter,
  type RemoteJobState,
  type RemoteObservation,
  type SubmitRequest,
  type SubmitResult,
} from "../src/production-adapter.ts";
import {
  ProductionError,
  type AssetRef,
  type ProductionCost,
  type ProductionCostBasis,
  type ProductionSubjectRef,
  type ProductionTask,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import { ProductionStore } from "../src/production-store.ts";
import {
  createProductionDispatchIntent,
  type ProductionDispatchIntent,
  type ProductionIntentDraft,
} from "../src/production-intent.ts";
import {
  ProductionIngestorError,
  productionIngestKey,
  productionScopedIngestKey,
  type ProductionArtifactIngestor,
  type ProductionIngestResult,
} from "../src/production-ingestor.ts";
import { ProductionCoordinatorStore } from "../src/production-coordinator-store.ts";
import {
  ProductionInputStagerError,
  productionInputBindingsDigest,
  productionInputStageKey,
  type ProductionInputStageResult,
  type ProductionInputStager,
  type ProductionWorkflowBindingVerification,
  type ProductionWorkflowBindingVerifier,
} from "../src/production-input-stager.ts";
import {
  PRODUCTION_COORDINATOR_RETRY_MAX_DELAY_MS,
  productionCoordinatorRetryDelayMs,
  productionWorkflowSha256,
  runProductionProjectOnce,
  type ProductionCoordinatorOptions,
} from "../src/production-coordinator.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

async function rejectsProduction(operation: () => Promise<unknown>): Promise<boolean> {
  try { await operation(); return false; }
  catch (error) { return error instanceof ProductionError || error instanceof Error; }
}

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BACKEND = "comfy-prod-a";
const SHA = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
};
const REMOTE_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const WORKFLOW: Record<string, unknown> = {
  "1": { class_type: "WritingLoopTestNode", inputs: { text: "immutable", image: "writing-loop-stage-sentinel" } },
};

function asset(name: string, sha256 = SHA.a, mediaType = "application/json"): AssetRef {
  return {
    version: 1,
    uri: `s3://writing-loop-assets/coordinator/${name}`,
    sha256,
    byteLength: 123,
    mediaType,
  };
}

function subject(id: string): ProductionSubjectRef {
  return {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: {
        version: 1,
        episodeId: "episode-001",
        revision: 2,
        source: asset("episode.json", SHA.a),
      },
      shotId: `shot-${id}`,
      revision: 3,
      source: asset(`${id}.json`, SHA.b),
    },
  };
}

function intentFor(
  id: string,
  taskSubject = subject(id),
  amountMicros = 500_000,
  modelFamily: "generic" | "minimax-h3" = "generic",
  maximumAmountMicros = amountMicros,
): ProductionDispatchIntent {
  const draft: ProductionIntentDraft = {
    version: 1,
    taskId: id,
    subject: taskSubject,
    createdAt: at(0),
    useTerritories: ["CN"],
    execution: modelFamily === "generic"
      ? {
          version: 1,
          operation: "comfyui-workflow",
          modelFamily: "generic",
          backendInstanceId: BACKEND,
          workflowSha256: productionWorkflowSha256(WORKFLOW),
          modelSha256: SHA.c,
          parametersSha256: SHA.d,
        }
      : {
          version: 1,
          operation: "comfyui-workflow",
          modelFamily: "minimax-h3",
          backendInstanceId: BACKEND,
          workflowSha256: productionWorkflowSha256(WORKFLOW),
          modelSha256: SHA.c,
          parametersSha256: SHA.d,
          variant: "fl2va",
          durationSeconds: 8,
          shortEdge: 768,
          aspectRatio: "9:16",
        },
    inputs: [asset(`${id}-input.png`, SHA.c, "image/png")],
    budget: {
      version: 1,
      currency: "USD",
      estimatedAmountMicros: amountMicros,
      maximumAmountMicros,
    },
    rights: {
      version: 1,
      status: "cleared",
      territories: ["CN"],
      evidence: asset("rights.json", SHA.a),
      expiresAt: "2026-08-11T12:00:00.000Z",
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: at(1),
      evidence: asset("moderation.json", SHA.b),
    },
    license: {
      version: 1,
      status: "verified",
      basis: "provider-terms",
      territories: ["CN"],
      licenseSha256: SHA.e,
      evidence: asset("license.txt", SHA.e, "text/plain"),
      issuedBy: "private-provider",
      issuedAt: "2026-08-01T12:00:00.000Z",
      expiresAt: null,
    },
  };
  return createProductionDispatchIntent(draft);
}

function event(
  task: ProductionTask,
  type: ProductionTaskEvent["type"],
  second: number,
  extra: Record<string, unknown> = {},
): ProductionTaskEvent {
  return {
    version: 1,
    type,
    eventId: `${task.id}:${type}:${task.revision}`,
    taskId: task.id,
    expectedRevision: task.revision,
    occurredAt: at(second),
    ...extra,
  } as ProductionTaskEvent;
}

function createTask(
  root: string,
  project: string,
  id: string,
  dispatch = true,
  amountMicros = 500_000,
  modelFamily: "generic" | "minimax-h3" = "generic",
  maximumAmountMicros = amountMicros,
): { store: ProductionStore; intent: ProductionDispatchIntent; task: ProductionTask } {
  mkdirSync(join(root, ".writing-loop", project), { recursive: true });
  const store = new ProductionStore(root, WS, project);
  const intent = intentFor(id, subject(id), amountMicros, modelFamily, maximumAmountMicros);
  let task = store.create({
    version: 1,
    id,
    idempotencyKey: intent.idempotencyKey,
    subject: intent.subject,
    createdAt: intent.createdAt,
  }).task;
  if (dispatch) task = store.apply(event(task, "dispatch-requested", 2)).task;
  return { store, intent, task };
}

function submittedTask(
  root: string,
  project: string,
  id: string,
  mode: "submitting" | "submitted" | "submission-unknown" = "submitted",
): { store: ProductionStore; intent: ProductionDispatchIntent; task: ProductionTask } {
  const fixture = createTask(root, project, id);
  let task = fixture.store.apply(event(fixture.task, "submission-started", 3, {
    backendInstanceId: BACKEND,
    remoteJobId: REMOTE_IDS[0],
    requestDigest: SHA.c,
  })).task;
  if (mode === "submitted") {
    task = fixture.store.apply(event(task, "submission-confirmed", 4, {
      backendInstanceId: BACKEND,
      remoteJobId: REMOTE_IDS[0],
    })).task;
  } else if (mode === "submission-unknown") {
    task = fixture.store.apply(event(task, "submission-uncertain", 4, {
      backendInstanceId: BACKEND,
      remoteJobId: REMOTE_IDS[0],
      reason: "test-ambiguous-submit",
    })).task;
  }
  return { ...fixture, task };
}

class FakeAdapter implements ProductionAdapter {
  submitCalls = 0;
  inspectCalls = 0;
  cancelCalls = 0;
  inspectStates: Array<RemoteJobState | Error>;
  submitError: Error | null = null;
  preparedMutation: ((prepared: PreparedSubmission) => PreparedSubmission) | null = null;
  lastPrepared: PreparedSubmission | null = null;

  constructor(states: Array<RemoteJobState | Error> = ["succeeded"]) {
    this.inspectStates = [...states];
  }

  async capabilities(): Promise<BackendCapabilities> {
    return {
      backendKind: "comfyui",
      backendInstanceId: BACKEND,
      asynchronous: true,
      clientAssignedJobId: true,
      inspectById: true,
      progressHints: "optional-websocket",
      pendingCancellation: "best-effort",
      runningCancellation: "version-gated-best-effort",
      providerIdempotency: false,
      inputModes: ["image-upload"],
      outputModes: ["download"],
    };
  }

  prepareSubmission(request: SubmitRequest): PreparedSubmission {
    const prepared: PreparedSubmission = {
      version: 1,
      backendInstanceId: BACKEND,
      remoteJobId: request.remoteJobId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      request: structuredClone(request),
    };
    const result = this.preparedMutation?.(prepared) ?? prepared;
    this.lastPrepared = structuredClone(result);
    return result;
  }

  async submitPrepared(prepared: PreparedSubmission): Promise<SubmitResult> {
    this.submitCalls++;
    if (this.submitError) throw this.submitError;
    return {
      remoteJobId: prepared.remoteJobId,
      acceptedAt: at(15),
      providerIdempotency: false,
      nodeErrorCount: 0,
      responseDigest: SHA.d,
    };
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    return await this.submitPrepared(this.prepareSubmission(request));
  }

  async inspect(remoteJobId: string): Promise<RemoteObservation> {
    this.inspectCalls++;
    const next = this.inspectStates.length > 1 ? this.inspectStates.shift()! : this.inspectStates[0]!;
    if (next instanceof Error) throw next;
    return {
      remoteJobId,
      state: next,
      observedAt: at(20),
      outputs: next === "succeeded"
        ? [{ nodeId: "7", kind: "video", filename: "take.mp4", subfolder: "final", folderType: "output" }]
        : [],
      errorSummary: next === "failed" ? "execution_error:RuntimeError" : null,
      responseDigest: SHA.e,
    };
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    this.cancelCalls++;
    return {
      remoteJobId,
      accepted: true,
      confirmed: false,
      runningInterruptRequested: true,
      observedAt: at(18),
    };
  }
}

type FakeCostMode = ProductionCostBasis | "unknown";

class FakeIngestor implements ProductionArtifactIngestor {
  calls = 0;
  failuresRemaining: number;
  costMode: FakeCostMode;

  constructor(
    failuresRemaining = 0,
    costMode: FakeCostMode = "reported",
  ) {
    this.failuresRemaining = failuresRemaining;
    this.costMode = costMode;
  }

  ingestKey(task: ProductionTask, observation: RemoteObservation): string {
    return productionIngestKey(task, observation);
  }

  async ingest(task: ProductionTask, observation: RemoteObservation): Promise<ProductionIngestResult> {
    this.calls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new ProductionIngestorError("gateway-unavailable");
    }
    const cost: ProductionCost = this.costMode === "unknown"
      ? { version: 1, state: "unknown", reason: "provider-not-reported" }
      : {
          version: 1,
          state: "known",
          currency: "USD",
          // 2_880_000 CNY micros × 138_000 USD micros/CNY / 1_000_000 = 397_440 USD micros.
          amountMicros: this.costMode === "reported-converted" ? 397_440 : 400_000,
          basis: this.costMode,
          settlement: this.costMode === "reported-converted"
            ? {
                nativeCurrency: "CNY",
                nativeAmountMicros: 2_880_000,
                rateMicrosPerUnit: 138_000,
                rateAsOf: "2026-08-20T00:00:00.000Z",
                rateSource: "gateway-registry",
              }
            : null,
        };
    return {
      version: 1,
      ingestKey: this.ingestKey(task, observation),
      assets: [asset(`${task.id}.mp4`, SHA.e, "video/mp4")],
      cost,
    };
  }
}

class ScopedFakeIngestor extends FakeIngestor {
  readonly workspaceId: string;
  readonly project: string;

  constructor(workspaceId: string, project: string) {
    super();
    this.workspaceId = workspaceId;
    this.project = project;
  }

  override ingestKey(task: ProductionTask, observation: RemoteObservation): string {
    return productionScopedIngestKey(this.workspaceId, this.project, task, observation);
  }
}

class FakeInputStager implements ProductionInputStager {
  calls = 0;
  failuresRemaining: number;
  readonly workspaceId: string;
  readonly project: string;
  mutate: ((result: ProductionInputStageResult) => ProductionInputStageResult) | null = null;
  order: string[] | null = null;

  constructor(project: string, failuresRemaining = 0, workspaceId = WS) {
    this.project = project;
    this.failuresRemaining = failuresRemaining;
    this.workspaceId = workspaceId;
  }

  async stage(intent: ProductionDispatchIntent): Promise<ProductionInputStageResult> {
    this.calls++;
    this.order?.push("stage");
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new ProductionInputStagerError("gateway-unavailable");
    }
    const bindings = intent.inputs.map((input, index) => ({
      index,
      slot: index === 0 ? "first_frame" : `reference.${index}`,
      assetSha256: input.sha256,
      providerObjectKey: `staged/${index}-input.bin`,
    }));
    const result: ProductionInputStageResult = {
      version: 1,
      stageKey: productionInputStageKey(this.workspaceId, this.project, intent),
      bindingsDigest: productionInputBindingsDigest(bindings),
      bindings,
    };
    return this.mutate?.(result) ?? result;
  }
}

class FakeWorkflowBindingVerifier implements ProductionWorkflowBindingVerifier {
  calls = 0;
  order: string[] | null = null;

  async verify(
    intent: ProductionDispatchIntent,
    workflow: Record<string, unknown>,
    staged: ProductionInputStageResult,
  ): Promise<ProductionWorkflowBindingVerification> {
    this.calls++;
    this.order?.push("verify");
    const boundWorkflow = structuredClone(workflow);
    const node = boundWorkflow["1"];
    const inputs = typeof node === "object" && node !== null && !Array.isArray(node)
      ? (node as Record<string, unknown>).inputs
      : null;
    if (typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)) {
      (inputs as Record<string, unknown>).image = staged.bindings[0]?.providerObjectKey;
    }
    if (staged.bindings.length !== intent.inputs.length
      || staged.bindings[0]?.slot !== "first_frame"
      || typeof staged.bindings[0]?.providerObjectKey !== "string") {
      throw new ProductionInputStagerError("invalid-response");
    }
    return {
      version: 1,
      verified: true,
      templateWorkflowSha256: intent.execution.workflowSha256,
      boundWorkflowSha256: productionWorkflowSha256(boundWorkflow),
      workflow: boundWorkflow,
      stageKey: staged.stageKey,
      bindingsDigest: staged.bindingsDigest,
    };
  }
}

function dependencies(
  root: string,
  project: string,
  adapter: FakeAdapter,
  ingestor: FakeIngestor,
  intents: readonly ProductionDispatchIntent[],
  overrides: Partial<ProductionCoordinatorOptions> = {},
): ProductionCoordinatorOptions {
  let remoteIndex = 0;
  const byTask = new Map(intents.map((intent) => [intent.taskId, intent]));
  return {
    root,
    workspaceId: WS,
    project,
    adapterRegistry: { resolve: (id) => id === BACKEND ? adapter : null },
    intentResolver: { resolve: async (taskId) => byTask.get(taskId) ?? null },
    workflowResolver: {
      resolve: async () => ({
        version: 1,
        workflow: structuredClone(WORKFLOW),
        modelFamily: "generic",
        modelSha256: SHA.c,
        parametersSha256: SHA.d,
      }),
    },
    gateContextResolver: {
      resolve: async () => ({
        version: 1,
        evaluatedAt: at(10),
        deploymentTerritories: ["CN"],
        availableBudgetMicros: 500_000,
      }),
    },
    unstagedGenericInputMode: "static-or-pre-staged",
    workflowBindingVerifier: new FakeWorkflowBindingVerifier(),
    ingestor,
    now: () => at(30),
    allocateRemoteJobId: () => REMOTE_IDS[remoteIndex++] ?? REMOTE_IDS[3],
    ...overrides,
  };
}

const root = mkdtempSync(join(tmpdir(), "writing-loop-production-coordinator-"));

try {
  const retryDelayA = productionCoordinatorRetryDelayMs("take-delay", "stage-inputs", 1);
  const retryDelayB = productionCoordinatorRetryDelayMs("take-delay", "stage-inputs", 5);
  const retryDelayMax = productionCoordinatorRetryDelayMs("take-delay", "stage-inputs", 10_000);
  ok(retryDelayA === productionCoordinatorRetryDelayMs("take-delay", "stage-inputs", 1)
    && retryDelayA < retryDelayB && retryDelayMax <= PRODUCTION_COORDINATOR_RETRY_MAX_DELAY_MS,
  "retry delay 使用 task/operation/attempt 的确定性 jitter，并按指数增长后有界封顶");

  const zeroEstimate = createTask(
    root, "budget-maximum-gate", "take-zero-estimate", true, 0, "generic", 1_000_000,
  );
  const zeroEstimateAdapter = new FakeAdapter(["succeeded"]);
  const zeroEstimateResult = await runProductionProjectOnce(dependencies(
    root, "budget-maximum-gate", zeroEstimateAdapter, new FakeIngestor(), [zeroEstimate.intent], {
      gateContextResolver: { resolve: async () => ({
        version: 1, evaluatedAt: at(10), deploymentTerritories: ["CN"], availableBudgetMicros: 0,
      }) },
    },
  ));
  ok(zeroEstimateAdapter.submitCalls === 0
    && new ProductionCoordinatorStore(root, WS, "budget-maximum-gate").read().tasks.length === 0
    && zeroEstimateResult.issues.some((row) => row.code === "gate-denied"),
  "estimate=0 仍按 immutable maximum gate/reserve，可用预算为 0 时零 exposure 且零 billable submit");

  // Fresh dispatch stages immutable inputs only after gates + pinned workflow validation and before budget.
  const stagedFixture = createTask(root, "input-stage-order", "take-staged");
  const stagedAdapter = new FakeAdapter(["succeeded"]);
  const stagedInput = new FakeInputStager("input-stage-order");
  const stagedVerifier = new FakeWorkflowBindingVerifier();
  const stageOrder: string[] = [];
  stagedInput.order = stageOrder;
  stagedVerifier.order = stageOrder;
  await runProductionProjectOnce(dependencies(
    root, "input-stage-order", stagedAdapter, new FakeIngestor(), [stagedFixture.intent], {
      inputStager: stagedInput,
      workflowBindingVerifier: stagedVerifier,
      gateContextResolver: {
        resolve: async () => {
          stageOrder.push("gate");
          return {
            version: 1, evaluatedAt: at(10), deploymentTerritories: ["CN"], availableBudgetMicros: 500_000,
          };
        },
      },
      workflowResolver: {
        resolve: async () => {
          stageOrder.push("workflow");
          return {
            version: 1, workflow: structuredClone(WORKFLOW), modelFamily: "generic",
            modelSha256: SHA.c, parametersSha256: SHA.d,
          };
        },
      },
      hooks: {
        afterSubmissionStarted: () => {
          const reservation = new ProductionCoordinatorStore(root, WS, "input-stage-order")
            .read().tasks[0]?.budgetReservation;
          stageOrder.push(reservation?.state === "reserved" ? "budget-reserved" : "budget-missing");
        },
        beforeSubmit: () => stageOrder.push("submit"),
      },
    },
  ));
  const stagedPrepared = stagedAdapter.lastPrepared;
  const stagedPreparedNode = stagedPrepared?.request.workflow["1"] as Record<string, unknown> | undefined;
  const stagedPreparedInputs = stagedPreparedNode?.inputs as Record<string, unknown> | undefined;
  const stagedDurableTask = stagedFixture.store.read().tasks[0];
  ok(JSON.stringify(stageOrder) === JSON.stringify([
    "gate", "workflow", "stage", "verify", "budget-reserved", "submit",
  ]) && stagedInput.calls === 1 && stagedVerifier.calls === 1 && stagedAdapter.submitCalls === 1
    && stagedPreparedInputs?.image === "staged/0-input.bin"
    && stagedPrepared !== null
    && productionWorkflowSha256(stagedPrepared.request.workflow) !== stagedFixture.intent.execution.workflowSha256
    && stagedDurableTask?.submissionOutbox?.requestDigest === stagedPrepared.requestDigest,
  "dispatch 严格执行 gate→trusted workflow→stage→binding verify→bound workflow prepare→durable outbox→submit");

  const strippedBinding = createTask(root, "stripped-stage-binding", "take-stripped-binding");
  const strippedBindingAdapter = new FakeAdapter(["succeeded"]);
  strippedBindingAdapter.preparedMutation = (prepared) => ({
    ...prepared,
    request: { ...prepared.request, inputBinding: null },
  });
  const strippedBindingRun = await runProductionProjectOnce(dependencies(
    root, "stripped-stage-binding", strippedBindingAdapter, new FakeIngestor(), [strippedBinding.intent], {
      inputStager: new FakeInputStager("stripped-stage-binding"),
      workflowBindingVerifier: new FakeWorkflowBindingVerifier(),
    },
  ));
  const strippedBindingControl = new ProductionCoordinatorStore(root, WS, "stripped-stage-binding").read();
  const strippedBindingRejected = strippedBindingAdapter.submitCalls === 0
    && strippedBindingControl.tasks.every((row) => row.budgetReservation === null)
    && strippedBindingRun.issues.some((row) => row.code === "intent-invalid");
  ok(strippedBindingRejected,
  "adapter 若丢弃 verified stage binding，coordinator 在预算/outbox/provider I/O 前拒绝 prepared envelope");

  // H3 never falls through to an unstaged ComfyUI request. Generic compatibility requires an
  // explicit static/pre-staged marker rather than an unsafe default.
  const h3NoStager = createTask(root, "h3-no-stager", "take-h3", true, 500_000, "minimax-h3");
  const h3Adapter = new FakeAdapter(["succeeded"]);
  const h3Run = await runProductionProjectOnce(dependencies(
    root, "h3-no-stager", h3Adapter, new FakeIngestor(), [h3NoStager.intent], {
      workflowResolver: {
        resolve: async () => ({
          version: 1, workflow: structuredClone(WORKFLOW), modelFamily: "minimax-h3",
          modelSha256: SHA.c, parametersSha256: SHA.d,
        }),
      },
    },
  ));
  ok(h3NoStager.store.read().tasks[0]?.status === "dispatch-pending"
    && h3Adapter.submitCalls === 0 && h3Adapter.inspectCalls === 0
    && new ProductionCoordinatorStore(root, WS, "h3-no-stager").read().revision === 0
    && h3Run.issues.some((row) => row.code === "input-stager-missing"),
  "H3-over-ComfyUI 无 stager 时在 provider 网络/预算/control mutation 前 fail-closed");

  const genericNoMarker = createTask(root, "generic-no-marker", "take-generic");
  const genericNoMarkerAdapter = new FakeAdapter(["succeeded"]);
  const genericNoMarkerRun = await runProductionProjectOnce(dependencies(
    root, "generic-no-marker", genericNoMarkerAdapter, new FakeIngestor(), [genericNoMarker.intent], {
      unstagedGenericInputMode: undefined,
    },
  ));
  ok(genericNoMarkerAdapter.submitCalls === 0
    && genericNoMarkerRun.issues.some((row) => row.code === "input-stager-missing"),
  "generic 无 stager 也必须显式声明 static-or-pre-staged compatibility mode");

  const mixedStatic = createTask(root, "mixed-input-policy", "take-static");
  const mixedStaged = createTask(root, "mixed-input-policy", "take-staged");
  const mixedAdapter = new FakeAdapter(["succeeded"]);
  const mixedStager = new FakeInputStager("mixed-input-policy");
  const mixedVerifier = new FakeWorkflowBindingVerifier();
  await runProductionProjectOnce(dependencies(
    root, "mixed-input-policy", mixedAdapter, new FakeIngestor(),
    [mixedStatic.intent, mixedStaged.intent], {
      unstagedGenericInputMode: undefined,
      workflowBindingVerifier: undefined,
      inputPipelineResolver: {
        resolve: async (intent) => intent.taskId === mixedStatic.task.id
          ? { version: 1, policy: "static-pre-staged" }
          : {
              version: 1,
              policy: "scoped-staging",
              inputStager: mixedStager,
              workflowBindingVerifier: mixedVerifier,
            },
      },
    },
  ));
  ok(mixedAdapter.submitCalls === 2 && mixedStager.calls === 1 && mixedVerifier.calls === 1
    && mixedStatic.store.read().tasks.every((row) => row.status === "qc-pending"),
  "同一项目按 immutable intent 解析 mixed input policy，仅 scoped-staging workflow 触发 staging");

  const unknownPolicy = createTask(root, "unknown-input-policy", "take-unknown-policy");
  const unknownPolicyAdapter = new FakeAdapter(["succeeded"]);
  const unknownPolicyRun = await runProductionProjectOnce(dependencies(
    root, "unknown-input-policy", unknownPolicyAdapter, new FakeIngestor(), [unknownPolicy.intent], {
      unstagedGenericInputMode: undefined,
      workflowBindingVerifier: undefined,
      inputPipelineResolver: { resolve: async () => null },
    },
  ));
  ok(unknownPolicyAdapter.submitCalls === 0
    && new ProductionCoordinatorStore(root, WS, "unknown-input-policy").read().revision === 0
    && unknownPolicyRun.issues.some((row) => row.code === "input-stager-missing"),
  "未注册的 per-workflow input policy 在预算/control/provider I/O 前 fail-closed");

  // A gateway failure persists a deterministic retry deadline but does not reserve/expose budget
  // or create submission-started. A restart before the deadline is a true zero-side-effect skip.
  const stageRetry = createTask(root, "stage-retry", "take-stage-retry");
  const stageRetryAdapter = new FakeAdapter(["succeeded"]);
  const stageRetryInput = new FakeInputStager("stage-retry", 1);
  const stageRetryOptions = dependencies(
    root, "stage-retry", stageRetryAdapter, new FakeIngestor(), [stageRetry.intent], {
      inputStager: stageRetryInput,
      now: () => at(30),
    },
  );
  const stageFailureRun = await runProductionProjectOnce(stageRetryOptions);
  const stageFailureControl = new ProductionCoordinatorStore(root, WS, "stage-retry").read();
  const stageFailureRetry = stageFailureControl.tasks[0]?.retryState;
  const expectedStageNotBefore = new Date(
    Date.parse(at(30)) + productionCoordinatorRetryDelayMs(stageRetry.task.id, "stage-inputs", 1),
  ).toISOString();
  ok(stageFailureRetry?.lastFailure?.operation === "stage-inputs"
    && stageFailureRetry.notBefore === expectedStageNotBefore
    && stageFailureControl.tasks[0]?.budgetReservation === null
    && stageRetry.store.read().tasks[0]?.status === "dispatch-pending"
    && stageRetryAdapter.submitCalls === 0
    && stageFailureRun.issues.some((row) => row.code === "input-staging-unavailable"),
  "stage 失败只持久化稳定 stage-inputs retry/backoff，零预算且不写 submission-started");
  const restartNotBefore = new ProductionCoordinatorStore(root, WS, "stage-retry")
    .read().tasks[0]?.retryState.notBefore;
  const beforeRetryState = JSON.stringify(new ProductionCoordinatorStore(root, WS, "stage-retry").read());
  const justBeforeStageRetry = new Date(Date.parse(expectedStageNotBefore) - 1).toISOString();
  await runProductionProjectOnce({ ...stageRetryOptions, now: () => justBeforeStageRetry });
  ok(restartNotBefore === expectedStageNotBefore && stageRetryInput.calls === 1
    && stageRetryAdapter.submitCalls === 0
    && JSON.stringify(new ProductionCoordinatorStore(root, WS, "stage-retry").read()) === beforeRetryState,
  "stage retry 的 notBefore 跨重启稳定，未到期时 stage/submit 均零调用且 control 零 mutation");
  await runProductionProjectOnce({ ...stageRetryOptions, now: () => expectedStageNotBefore });
  ok(stageRetryInput.calls === 2 && stageRetryAdapter.submitCalls === 1
    && stageRetry.store.read().tasks[0]?.status === "qc-pending"
    && new ProductionCoordinatorStore(root, WS, "stage-retry").read().tasks[0]?.retryState.attempt === 0,
  "到达 notBefore 时幂等 stage 恰重试一次，成功后 reset retry 并继续一次 submit");

  const stageDrift = createTask(root, "stage-drift", "take-stage-drift");
  const stageDriftAdapter = new FakeAdapter(["succeeded"]);
  const stageDriftInput = new FakeInputStager("stage-drift");
  stageDriftInput.mutate = (result) => ({ ...result, stageKey: SHA.e });
  const stageDriftRun = await runProductionProjectOnce(dependencies(
    root, "stage-drift", stageDriftAdapter, new FakeIngestor(), [stageDrift.intent], {
      inputStager: stageDriftInput,
    },
  ));
  ok(stageDriftAdapter.submitCalls === 0
    && new ProductionCoordinatorStore(root, WS, "stage-drift").read().tasks[0]?.budgetReservation === null
    && stageDriftRun.issues.some((row) => row.code === "input-staging-unavailable"),
  "即使自定义 stager 返回 scope/stageKey drift，coordinator 仍在预算与 submit 前复核并拒绝");

  const missingVerifier = createTask(root, "missing-binding-verifier", "take-missing-verifier");
  const missingVerifierAdapter = new FakeAdapter(["succeeded"]);
  const unusedWithoutVerifier = new FakeInputStager("missing-binding-verifier");
  const missingVerifierRun = await runProductionProjectOnce(dependencies(
    root, "missing-binding-verifier", missingVerifierAdapter, new FakeIngestor(), [missingVerifier.intent], {
      inputStager: unusedWithoutVerifier,
      workflowBindingVerifier: undefined,
    },
  ));
  ok(unusedWithoutVerifier.calls === 0 && missingVerifierAdapter.submitCalls === 0
    && new ProductionCoordinatorStore(root, WS, "missing-binding-verifier").read().revision === 0
    && missingVerifierRun.issues.some((row) => row.code === "workflow-binding-verifier-missing"),
  "任意 model 注入 stager 后都强制需要 server-owned binding verifier，缺失时 staging/预算/submit 全部为零");

  const unreferenced = createTask(root, "unreferenced-binding", "take-unreferenced");
  const unreferencedAdapter = new FakeAdapter(["succeeded"]);
  const unreferencedStager = new FakeInputStager("unreferenced-binding");
  const untrustedProofVerifier = new FakeWorkflowBindingVerifier();
  const unreferencedRun = await runProductionProjectOnce(dependencies(
    root, "unreferenced-binding", unreferencedAdapter, new FakeIngestor(), [unreferenced.intent], {
      inputStager: unreferencedStager,
      workflowBindingVerifier: {
        verify: async (...args) => ({
          ...await untrustedProofVerifier.verify(args[0], args[1], args[2]),
          boundWorkflowSha256: SHA.e,
        }),
      },
    },
  ));
  ok(unreferencedStager.calls === 1 && unreferencedAdapter.submitCalls === 0
    && new ProductionCoordinatorStore(root, WS, "unreferenced-binding").read().tasks[0]?.budgetReservation === null
    && unreferencedRun.issues.some((row) => row.code === "workflow-bindings-invalid"),
  "binding verifier 伪造 bound workflow digest 时被 strict proof parser 拒绝，零预算且零 submit");

  // The same durable backoff gate covers recovered inspect and ingest operations.
  const inspectRetry = submittedTask(root, "inspect-backoff", "take-inspect-backoff");
  const inspectRetryAdapter = new FakeAdapter([
    new ProductionAdapterError("remote-unavailable", "provider secret"), "running",
  ]);
  const inspectRetryIngestor = new FakeIngestor();
  const inspectUnusedStager = new FakeInputStager("inspect-backoff");
  const inspectOptions = dependencies(
    root, "inspect-backoff", inspectRetryAdapter, inspectRetryIngestor, [inspectRetry.intent], {
      inputStager: inspectUnusedStager,
      now: () => at(30),
    },
  );
  await runProductionProjectOnce(inspectOptions);
  const inspectNotBefore = new ProductionCoordinatorStore(root, WS, "inspect-backoff")
    .read().tasks[0]!.retryState.notBefore!;
  const inspectControlBefore = JSON.stringify(new ProductionCoordinatorStore(root, WS, "inspect-backoff").read());
  await runProductionProjectOnce({ ...inspectOptions, now: () => new Date(Date.parse(inspectNotBefore) - 1).toISOString() });
  ok(inspectRetryAdapter.inspectCalls === 1 && inspectRetryAdapter.submitCalls === 0
    && inspectRetryIngestor.calls === 0 && inspectUnusedStager.calls === 0
    && JSON.stringify(new ProductionCoordinatorStore(root, WS, "inspect-backoff").read()) === inspectControlBefore,
  "inspect retry 未到期时 submit/inspect/ingest/stage 全部零新增调用且零 mutation");
  await runProductionProjectOnce({ ...inspectOptions, now: () => inspectNotBefore });
  ok(inspectRetryAdapter.inspectCalls === 2
    && new ProductionCoordinatorStore(root, WS, "inspect-backoff").read().tasks[0]?.retryState.attempt === 0,
  "inspect retry 到期后恰执行一次并在成功 observation 后 reset");

  const submitBackoff = createTask(root, "submit-backoff", "take-submit-backoff");
  const submitBackoffAdapter = new FakeAdapter(["pending"]);
  submitBackoffAdapter.submitError = new ProductionAdapterError("submission-unknown", "provider token=secret");
  const submitBackoffIngestor = new FakeIngestor();
  const submitBackoffStager = new FakeInputStager("submit-backoff");
  const submitOptions = dependencies(
    root, "submit-backoff", submitBackoffAdapter, submitBackoffIngestor, [submitBackoff.intent], {
      inputStager: submitBackoffStager,
      now: () => at(30),
    },
  );
  await runProductionProjectOnce(submitOptions);
  const submitNotBefore = new ProductionCoordinatorStore(root, WS, "submit-backoff")
    .read().tasks[0]!.retryState.notBefore!;
  const submitControlBefore = JSON.stringify(new ProductionCoordinatorStore(root, WS, "submit-backoff").read());
  submitBackoffAdapter.submitError = null;
  await runProductionProjectOnce({ ...submitOptions, now: () => new Date(Date.parse(submitNotBefore) - 1).toISOString() });
  ok(submitBackoffAdapter.submitCalls === 1 && submitBackoffAdapter.inspectCalls === 0
    && submitBackoffIngestor.calls === 0 && submitBackoffStager.calls === 1
    && JSON.stringify(new ProductionCoordinatorStore(root, WS, "submit-backoff").read()) === submitControlBefore,
  "ambiguous submit retry 未到期时 submit/inspect/ingest/stage 全部零新增调用且零 mutation");
  await runProductionProjectOnce({ ...submitOptions, now: () => submitNotBefore });
  ok(submitBackoffAdapter.submitCalls === 1 && submitBackoffAdapter.inspectCalls === 1
    && submitBackoffStager.calls === 1
    && new ProductionCoordinatorStore(root, WS, "submit-backoff").read().tasks[0]?.retryState.attempt === 0,
  "ambiguous submit 到期后只 inspect durable remote id 一次，永不重复 POST/stage");

  const ingestBackoff = submittedTask(root, "ingest-backoff", "take-ingest-backoff");
  const ingestBackoffAdapter = new FakeAdapter(["succeeded"]);
  const ingestBackoffIngestor = new FakeIngestor(1);
  const ingestUnusedStager = new FakeInputStager("ingest-backoff");
  const ingestOptions = dependencies(
    root, "ingest-backoff", ingestBackoffAdapter, ingestBackoffIngestor, [ingestBackoff.intent], {
      inputStager: ingestUnusedStager,
      now: () => at(30),
    },
  );
  await runProductionProjectOnce(ingestOptions);
  const ingestNotBefore = new ProductionCoordinatorStore(root, WS, "ingest-backoff")
    .read().tasks[0]!.retryState.notBefore!;
  const ingestControlBefore = JSON.stringify(new ProductionCoordinatorStore(root, WS, "ingest-backoff").read());
  await runProductionProjectOnce({ ...ingestOptions, now: () => new Date(Date.parse(ingestNotBefore) - 1).toISOString() });
  ok(ingestBackoffAdapter.inspectCalls === 1 && ingestBackoffAdapter.submitCalls === 0
    && ingestBackoffIngestor.calls === 1 && ingestUnusedStager.calls === 0
    && JSON.stringify(new ProductionCoordinatorStore(root, WS, "ingest-backoff").read()) === ingestControlBefore,
  "ingest retry 未到期时 submit/inspect/ingest/stage 全部零新增调用且零 mutation");
  await runProductionProjectOnce({ ...ingestOptions, now: () => ingestNotBefore });
  ok(ingestBackoffIngestor.calls === 2 && ingestBackoffAdapter.inspectCalls === 1
    && ingestBackoff.store.read().tasks[0]?.status === "qc-pending",
  "ingest retry 到期后只重放幂等 ingest 一次，不重复 inspect/submit");

  // Workspace pause blocks only new dispatch. Existing remote work still reconciles.
  const pausedFresh = createTask(root, "paused-dispatch", "take-new");
  const pausedRunning = submittedTask(root, "paused-dispatch", "take-running");
  const pausedAdapter = new FakeAdapter(["running"]);
  const pausedStager = new FakeInputStager("paused-dispatch");
  await runProductionProjectOnce(dependencies(
    root, "paused-dispatch", pausedAdapter, new FakeIngestor(), [pausedFresh.intent, pausedRunning.intent], {
      allowDispatch: false,
      inputStager: pausedStager,
    },
  ));
  ok(pausedFresh.store.read().tasks.find((task) => task.id === pausedFresh.task.id)?.status === "dispatch-pending"
    && pausedFresh.store.read().tasks.find((task) => task.id === pausedRunning.task.id)?.status === "running"
    && pausedStager.calls === 0 && pausedAdapter.submitCalls === 0 && pausedAdapter.inspectCalls === 1,
  "allowDispatch=false 只暂停 fresh dispatch，既有 submitted/running 仍继续 reconcile");

  // Trusted descriptor binds actual model identity before any budget reservation or provider I/O.
  for (const [project, code, descriptor] of [
    ["descriptor-family", "model-family-mismatch", {
      version: 1 as const,
      workflow: structuredClone(WORKFLOW),
      modelFamily: "minimax-h3" as const,
      modelSha256: SHA.c,
      parametersSha256: SHA.d,
    }],
    ["descriptor-model", "model-digest-mismatch", {
      version: 1 as const,
      workflow: structuredClone(WORKFLOW),
      modelFamily: "generic" as const,
      modelSha256: SHA.e,
      parametersSha256: SHA.d,
    }],
    ["descriptor-parameters", "parameters-digest-mismatch", {
      version: 1 as const,
      workflow: structuredClone(WORKFLOW),
      modelFamily: "generic" as const,
      modelSha256: SHA.c,
      parametersSha256: SHA.e,
    }],
    ["descriptor-workflow", "workflow-digest-mismatch", {
      version: 1 as const,
      workflow: { "1": { class_type: "WritingLoopTestNode", inputs: { text: "drifted" } } },
      modelFamily: "generic" as const,
      modelSha256: SHA.c,
      parametersSha256: SHA.d,
    }],
  ] as const) {
    const fixture = createTask(root, project, `take-${project}`);
    const adapter = new FakeAdapter(["succeeded"]);
    const run = await runProductionProjectOnce(dependencies(
      root, project, adapter, new FakeIngestor(), [fixture.intent], {
        workflowResolver: { resolve: async () => structuredClone(descriptor) },
      },
    ));
    ok(fixture.store.read().tasks[0]?.status === "dispatch-pending"
      && adapter.submitCalls === 0 && adapter.inspectCalls === 0 && adapter.cancelCalls === 0
      && new ProductionCoordinatorStore(root, WS, project).read().revision === 0
      && run.issues.some((row) => row.taskId === fixture.task.id && row.code === code),
    `${code} 在预算 reservation 与 provider 网络 I/O 前 fail-closed`);
  }

  // Happy path plus budget capacity reuse after QC settlement.
  const budgetA = createTask(root, "budget", "take-a");
  const budgetB = createTask(root, "budget", "take-b");
  const budgetAdapter = new FakeAdapter(["succeeded"]);
  const budgetIngestor = new FakeIngestor();
  const budgetRun = await runProductionProjectOnce(dependencies(
    root, "budget", budgetAdapter, budgetIngestor, [budgetA.intent, budgetB.intent],
  ));
  const budgetState = budgetA.store.read();
  const budgetControl = new ProductionCoordinatorStore(root, WS, "budget").read();
  ok(budgetState.tasks.every((task) => task.status === "qc-pending")
    && budgetAdapter.submitCalls === 2 && budgetAdapter.inspectCalls === 2
    && budgetIngestor.calls === 2 && budgetRun.submissions === 2,
  "happy path 在单次 run 内完成 prepare→submit→inspect→幂等 ingest→qc");
  ok(budgetControl.tasks.length === 2
    && budgetControl.tasks.every((row) => row.budgetReservation?.state === "released"
      && row.budgetReservation.exposedAt !== null),
  "qc-requested 后 exposed reservation 结算为 released，下一任务可复用同一预算容量");

  const scopedFixture = createTask(root, "scoped-ingest", "take-scoped-ingest");
  const scopedAdapter = new FakeAdapter(["succeeded"]);
  const scopedIngestor = new ScopedFakeIngestor(WS, "scoped-ingest");
  await runProductionProjectOnce(dependencies(
    root, "scoped-ingest", scopedAdapter, scopedIngestor, [scopedFixture.intent],
  ));
  ok(scopedFixture.store.read().tasks[0]?.status === "qc-pending"
    && scopedIngestor.calls === 1,
  "coordinator 使用 ingestor 的 scoped idempotency key 校验结果，不回退到 legacy key");

  for (const costMode of ["unknown", "estimated"] as const) {
    const project = `cost-${costMode}`;
    const first = createTask(root, project, "take-a");
    const second = createTask(root, project, "take-b");
    const adapter = new FakeAdapter(["succeeded"]);
    const ingestor = new FakeIngestor(0, costMode);
    const run = await runProductionProjectOnce(dependencies(
      root, project, adapter, ingestor, [first.intent, second.intent],
    ));
    const state = first.store.read();
    const control = new ProductionCoordinatorStore(root, WS, project).read();
    ok(state.tasks.find((task) => task.id === "take-a")?.status === "qc-pending"
      && state.tasks.find((task) => task.id === "take-b")?.status === "dispatch-pending"
      && adapter.submitCalls === 1
      && control.tasks.find((row) => row.taskId === "take-a")?.budgetReservation?.state === "exposed"
      && run.issues.some((row) => row.taskId === "take-a" && row.code === "cost-unreconciled")
      && run.issues.some((row) => row.taskId === "take-b" && row.code === "gate-denied"),
    `${costMode} cost 不释放 exposure，后续同预算 task 不会 dispatch/超支`);
  }
  for (const costMode of ["billed", "tariff", "reported-converted"] as const) {
    const project = `cost-${costMode}`;
    const settledA = createTask(root, project, "take-a");
    const settledB = createTask(root, project, "take-b");
    const settledAdapter = new FakeAdapter(["succeeded"]);
    await runProductionProjectOnce(dependencies(
      root,
      project,
      settledAdapter,
      new FakeIngestor(0, costMode),
      [settledA.intent, settledB.intent],
    ));
    ok(settledAdapter.submitCalls === 2
      && new ProductionCoordinatorStore(root, WS, project).read().tasks
        .every((row) => row.budgetReservation?.state === "released"),
    `${costMode} cost 与 reported 一样完成预算对账并允许容量复用`);
  }
  const beforeQcSkip = { submits: budgetAdapter.submitCalls, inspects: budgetAdapter.inspectCalls, ingests: budgetIngestor.calls };
  await runProductionProjectOnce(dependencies(
    root, "budget", budgetAdapter, budgetIngestor, [budgetA.intent, budgetB.intent],
  ));
  ok(budgetAdapter.submitCalls === beforeQcSkip.submits && budgetAdapter.inspectCalls === beforeQcSkip.inspects
    && budgetIngestor.calls === beforeQcSkip.ingests,
  "qc-pending/terminal tasks 不触发 submit、inspect 或 ingest");

  // Recovered unknown/submitting paths never POST.
  const unknown = submittedTask(root, "unknown", "take-unknown", "submission-unknown");
  const unknownAdapter = new FakeAdapter(["running"]);
  await runProductionProjectOnce(dependencies(root, "unknown", unknownAdapter, new FakeIngestor(), [unknown.intent]));
  ok(unknownAdapter.submitCalls === 0 && unknownAdapter.inspectCalls === 1
    && unknown.store.read().tasks[0]?.status === "running",
  "submission-unknown 重启只 inspect durable remote id，绝不重 POST");

  const noReservation = submittedTask(root, "missing-reservation", "take-missing", "submitting");
  const noReservationAdapter = new FakeAdapter(["pending"]);
  await runProductionProjectOnce(dependencies(
    root, "missing-reservation", noReservationAdapter, new FakeIngestor(), [noReservation.intent],
  ));
  ok(noReservationAdapter.submitCalls === 0 && noReservationAdapter.inspectCalls === 1
    && noReservation.store.read().tasks[0]?.status === "submitted",
  "recovered submitting 即使 control 缺 budget reservation 也只 inspect、绝不猜测重 POST");

  // Exact pendingEvent replay precedes dependencies and remote I/O.
  const pending = createTask(root, "pending-fail", "take-pending");
  const pendingAdapter = new FakeAdapter(["pending"]);
  const pendingOptions = dependencies(root, "pending-fail", pendingAdapter, new FakeIngestor(), [pending.intent], {
    hooks: {
      afterPendingEventPersisted: (row) => {
        if (row.type === "submission-started") throw new Error("fail after pending outbox");
      },
    },
  });
  ok(await rejectsProduction(() => runProductionProjectOnce(pendingOptions))
    && pending.store.read().tasks[0]?.status === "dispatch-pending"
    && new ProductionCoordinatorStore(root, WS, "pending-fail").read().tasks[0]?.pendingEvent?.type === "submission-started"
    && pendingAdapter.submitCalls === 0,
  "afterPendingEventPersisted 崩溃保留 exact outbox 且 provider 尚未被调用");
  await runProductionProjectOnce(dependencies(
    root, "pending-fail", pendingAdapter, new FakeIngestor(), [pending.intent],
  ));
  ok(pendingAdapter.submitCalls === 0 && pendingAdapter.inspectCalls === 1
    && new ProductionCoordinatorStore(root, WS, "pending-fail").read().tasks[0]?.pendingEvent === null,
  "重启先精确重放 pendingEvent，再按 submitting 恢复为 inspect-only");

  const started = createTask(root, "started-fail", "take-started");
  const startedAdapter = new FakeAdapter(["pending"]);
  ok(await rejectsProduction(() => runProductionProjectOnce(dependencies(
    root, "started-fail", startedAdapter, new FakeIngestor(), [started.intent], {
      hooks: { afterSubmissionStarted: () => { throw new Error("fail after submission-started"); } },
    },
  ))) && started.store.read().tasks[0]?.status === "submitting" && startedAdapter.submitCalls === 0,
  "submission-started durable 后 failpoint 不会提前调用 submitPrepared");
  await runProductionProjectOnce(dependencies(
    root, "started-fail", startedAdapter, new FakeIngestor(), [started.intent],
  ));
  ok(startedAdapter.submitCalls === 0 && startedAdapter.inspectCalls === 1,
  "submission-started failpoint 重启严格 inspect-only");

  const confirm = createTask(root, "confirm-fail", "take-confirm");
  const confirmAdapter = new FakeAdapter(["pending"]);
  ok(await rejectsProduction(() => runProductionProjectOnce(dependencies(
    root, "confirm-fail", confirmAdapter, new FakeIngestor(), [confirm.intent], {
      hooks: {
        afterPendingEventPersisted: (row) => {
          if (row.type === "submission-confirmed") throw new Error("fail during ledger commit");
        },
      },
    },
  ))) && confirmAdapter.submitCalls === 1
    && confirm.store.read().tasks[0]?.status === "submitting"
    && new ProductionCoordinatorStore(root, WS, "confirm-fail").read().tasks[0]?.pendingEvent?.type === "submission-confirmed",
  "provider 成功后的 submission-confirmed 落账故障作为硬崩溃保留 pendingEvent，不被 submit catch 掩盖");
  await runProductionProjectOnce(dependencies(
    root, "confirm-fail", confirmAdapter, new FakeIngestor(), [confirm.intent],
  ));
  ok(confirmAdapter.submitCalls === 1 && confirmAdapter.inspectCalls === 1,
  "确认事件重放后继续 inspect，已成功的 POST 永不重复");

  // Transport failure and not-found never invent business terminal facts.
  const unavailable = submittedTask(root, "unavailable", "take-unavailable");
  const unavailableAdapter = new FakeAdapter([
    new ProductionAdapterError("remote-unavailable", "secret provider detail"),
  ]);
  const unavailableBefore = JSON.stringify(unavailable.store.read());
  await runProductionProjectOnce(dependencies(
    root, "unavailable", unavailableAdapter, new FakeIngestor(), [unavailable.intent],
  ));
  ok(JSON.stringify(unavailable.store.read()) === unavailableBefore
    && new ProductionCoordinatorStore(root, WS, "unavailable").read().tasks[0]?.retryState.lastFailure?.code === "remote-unavailable",
  "inspect unavailable 只记录 control 稳定错误类别，authoritative production 零突变");
  const inspectBackoff = new ProductionCoordinatorStore(root, WS, "unavailable")
    .read().tasks[0]!.retryState.notBefore!;
  const cancelDuringBackoff = unavailable.store.apply(event(
    unavailable.store.read().tasks[0]!, "cancellation-requested", 31, { reason: "operator-urgent" },
  )).task;
  await runProductionProjectOnce(dependencies(
    root, "unavailable", unavailableAdapter, new FakeIngestor(), [unavailable.intent], { now: () => at(31) },
  ));
  ok(at(31) < inspectBackoff && cancelDuringBackoff.status === "cancel-requested"
    && unavailableAdapter.cancelCalls === 1,
  "操作员紧急取消优先于既有 inspect notBefore，不让远端继续计费等退避");

  const missing = submittedTask(root, "not-found", "take-not-found");
  const missingAdapter = new FakeAdapter(["not-found"]);
  await runProductionProjectOnce(dependencies(root, "not-found", missingAdapter, new FakeIngestor(), [missing.intent]));
  ok(missing.store.read().tasks[0]?.status === "submitted"
    && missing.store.read().tasks[0]?.statusMessage === null,
  "remote not-found 保留 submitted 供人工审计，不自动 failed/orphaned");

  // Ingest retries use the durable succeeded observation and never inspect/submit again.
  const retry = submittedTask(root, "ingest-retry", "take-ingest");
  const retryAdapter = new FakeAdapter(["succeeded"]);
  const retryIngestor = new FakeIngestor(1);
  await runProductionProjectOnce(dependencies(root, "ingest-retry", retryAdapter, retryIngestor, [retry.intent]));
  const callsAfterFailure = { submits: retryAdapter.submitCalls, inspects: retryAdapter.inspectCalls };
  ok(retry.store.read().tasks[0]?.status === "ingesting" && retryIngestor.calls === 1,
  "ingest gateway 失败保留 ingesting 与 durable succeeded observation");
  const retryDue = new ProductionCoordinatorStore(root, WS, "ingest-retry")
    .read().tasks[0]!.retryState.notBefore!;
  await runProductionProjectOnce(dependencies(
    root, "ingest-retry", retryAdapter, retryIngestor, [retry.intent], { now: () => retryDue },
  ));
  ok(retry.store.read().tasks[0]?.status === "qc-pending" && retryIngestor.calls === 2
    && retryAdapter.submitCalls === callsAfterFailure.submits
    && retryAdapter.inspectCalls === callsAfterFailure.inspects,
  "ingesting 重启只重放幂等 ingest，不 submit 且不重复 inspect");

  // Cancel acceptance is never terminal; only a matching inspect cancelled observation is proof.
  const cancellation = submittedTask(root, "cancel", "take-cancel");
  cancellation.task = cancellation.store.apply(event(cancellation.task, "cancellation-requested", 5, {
    reason: "operator-request",
  })).task;
  const cancelAdapter = new FakeAdapter(["running", "cancelled"]);
  await runProductionProjectOnce(dependencies(root, "cancel", cancelAdapter, new FakeIngestor(), [cancellation.intent]));
  ok(cancellation.store.read().tasks[0]?.status === "cancel-requested" && cancelAdapter.cancelCalls === 1,
  "cancel HTTP acceptance/200 不产生 terminal cancelled，仍等待 inspect 强证据");
  await runProductionProjectOnce(dependencies(root, "cancel", cancelAdapter, new FakeIngestor(), [cancellation.intent]));
  const cancelled = cancellation.store.read().tasks[0]!;
  ok(cancelled.status === "cancelled"
    && cancelled.cancellationConfirmation?.kind === "remote-terminal-observation"
    && cancelAdapter.cancelCalls === 1 && cancelAdapter.inspectCalls === 2,
  "匹配 backend/job/digest 的 inspect cancelled 强证据才终态，cancel side effect 最多一次");
  const terminalCalls = { cancel: cancelAdapter.cancelCalls, inspect: cancelAdapter.inspectCalls };
  await runProductionProjectOnce(dependencies(root, "cancel", cancelAdapter, new FakeIngestor(), [cancellation.intent]));
  ok(cancelAdapter.cancelCalls === terminalCalls.cancel && cancelAdapter.inspectCalls === terminalCalls.inspect,
  "cancelled terminal 后 coordinator 完全跳过 remote actions");

  const cancelCrash = submittedTask(root, "cancel-crash", "take-cancel-crash");
  cancelCrash.task = cancelCrash.store.apply(event(cancelCrash.task, "cancellation-requested", 5, {
    reason: "operator-request",
  })).task;
  const cancelCrashAdapter = new FakeAdapter(["cancelled"]);
  ok(await rejectsProduction(() => runProductionProjectOnce(dependencies(
    root, "cancel-crash", cancelCrashAdapter, new FakeIngestor(), [cancelCrash.intent], {
      hooks: { afterCancelReturned: () => { throw new Error("crash after cancel response"); } },
    },
  ))) && cancelCrashAdapter.cancelCalls === 1
    && new ProductionCoordinatorStore(root, WS, "cancel-crash").read().tasks[0]?.cancelAttempt?.state === "prepared",
  "cancel 返回后崩溃只留下 durable prepared（远端结果未知）");
  await runProductionProjectOnce(dependencies(
    root, "cancel-crash", cancelCrashAdapter, new FakeIngestor(), [cancelCrash.intent],
  ));
  ok(cancelCrashAdapter.cancelCalls === 1 && cancelCrashAdapter.inspectCalls === 1
    && cancelCrash.store.read().tasks[0]?.status === "cancelled",
  "prepared cancelAttempt 重启只 inspect，不重发 cancel");

  const localCancel = createTask(root, "local-cancel", "take-local-cancel");
  const localControlStore = new ProductionCoordinatorStore(root, WS, "local-cancel");
  localControlStore.put({
    expectedRevision: 0,
    updatedAt: at(3),
    task: {
      version: 1,
      taskId: localCancel.task.id,
      observedTaskRevision: localCancel.task.revision,
      budgetReservation: {
        version: 1,
        state: "reserved",
        currency: "USD",
        reservedAmountMicros: 500_000,
        reservedAt: at(3),
        exposedAt: null,
        releasedAt: null,
      },
      retryState: { version: 1, attempt: 0, notBefore: null, lastFailure: null },
      cancelAttempt: null,
      lastObservation: null,
      pendingEvent: null,
    },
  });
  localCancel.task = localCancel.store.apply(event(localCancel.task, "cancellation-requested", 5, {
    reason: "operator-request",
  })).task;
  localCancel.task = localCancel.store.apply(event(localCancel.task, "cancelled", 6, {
    reason: "local-cancelled-before-submission",
    confirmation: { version: 1, kind: "local-no-submission" },
  })).task;
  const localCancelAdapter = new FakeAdapter(["succeeded"]);
  await runProductionProjectOnce(dependencies(
    root, "local-cancel", localCancelAdapter, new FakeIngestor(), [localCancel.intent],
  ));
  const localReservation = localControlStore.read().tasks[0]?.budgetReservation;
  ok(localReservation?.state === "released" && localReservation.exposedAt === null
    && localCancelAdapter.submitCalls === 0 && localCancelAdapter.inspectCalls === 0,
  "重启观察到 local-no-submission cancelled 时释放未暴露 reservation，且零远端动作");

  // Already-aborted runs perform recovery bookkeeping only and start no new remote operation.
  const aborted = createTask(root, "aborted", "take-aborted");
  const abortedAdapter = new FakeAdapter(["succeeded"]);
  const abortedIngestor = new FakeIngestor();
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await runProductionProjectOnce(dependencies(
    root, "aborted", abortedAdapter, abortedIngestor, [aborted.intent], { signal: controller.signal },
  ));
  ok(aborted.store.read().tasks[0]?.status === "dispatch-pending"
    && abortedAdapter.submitCalls === 0 && abortedAdapter.inspectCalls === 0
    && abortedAdapter.cancelCalls === 0 && abortedIngestor.calls === 0,
  "预先 aborted signal 不启动 submit/inspect/cancel/ingest 新远端动作");

  // Project lease covers dependency awaits: a live second coordinator cannot enter the round.
  const leaseFixture = createTask(root, "lease", "take-lease");
  const leaseAdapter = new FakeAdapter(["pending"]);
  let enterResolver!: () => void;
  const entered = new Promise<void>((resolve) => { enterResolver = resolve; });
  let releaseResolver!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolver = resolve; });
  const firstOptions = dependencies(root, "lease", leaseAdapter, new FakeIngestor(), [leaseFixture.intent], {
    intentResolver: {
      resolve: async () => {
        enterResolver();
        await release;
        return null;
      },
    },
  });
  const firstRun = runProductionProjectOnce(firstOptions);
  await entered;
  const contenderRejected = await rejectsProduction(() => runProductionProjectOnce(
    dependencies(root, "lease", leaseAdapter, new FakeIngestor(), [leaseFixture.intent]),
  ));
  releaseResolver();
  await firstRun;
  ok(contenderRejected && leaseAdapter.submitCalls === 0,
  "project lease 覆盖完整 async run，两个 coordinator 只有一个进入依赖/remote round");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_COORDINATOR_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
