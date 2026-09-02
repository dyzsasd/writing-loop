// Phase 3C.2 scope-bound job proxy regression suite.
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductionAdapterError,
  type BackendCapabilities,
  type CancelResult,
  type PreparedSubmission,
  type ProductionAdapter,
  type RemoteObservation,
  type SubmitRequest,
  type SubmitResult,
} from "../src/production-adapter.ts";
import { productionInputBindingsDigest, type ProductionInputBinding } from "../src/production-input-stager.ts";
import type { ProductionIntentExecution } from "../src/production-intent.ts";
import {
  materializeProductionH3Workflow,
  productionH3ModelBundleSha256,
  productionH3ParameterManifestSha256,
  productionH3StageInputSentinel,
  type ProductionH3GraphContract,
  type ProductionH3StageBindingContract,
} from "../src/production-h3-graph.ts";
import type { ProductionStageReceiptClaim, VerifiedStageReceipt } from "../src/production-stage-gateway.ts";
import {
  DEFAULT_PRODUCTION_JOB_GATEWAY_RECORD_BYTES,
  PRODUCTION_JOB_DURABLE_RECORDS_PER_SLOT,
  ProductionGatewayAdapter,
  ProductionJobGateway,
  productionJobCancellationKey,
  productionJobPutRequestDigest,
  productionJobStorageKey,
  productionJobWorkflowDigest,
  type ProductionGatewayAdapterOptions,
  type ProductionJobGatewayOptions,
  type ProductionJobProfile,
  type ProductionJobPutRequest,
  type ProductionJobScope,
  type ProductionJobStorageAdmissionContext,
  type ProductionJobStorageAdmissionDecision,
  type ProductionJobStorageAdmissionPolicy,
} from "../src/production-job-gateway.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error("test waitUntil deadline");
}

const TOKEN_A = "job-gateway-token-A";
const TOKEN_B = "job-gateway-token-B";
const BACKEND = "comfy-prod-a";
const PROFILE_ID = "h3-ref2v-768-v1";
const REMOTE_ID = "11111111-1111-4111-8111-111111111111";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const roots: string[] = [];

const root = (): string => {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "writing-loop-job-gateway-")));
  roots.push(value);
  return value;
};

function durableStoreText(storeRoot: string): string {
  const parts: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else parts.push(readFileSync(path, "utf8"));
    }
  };
  visit(storeRoot);
  return parts.join("\n");
}

function durableStoreFiles(storeRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(storeRoot);
  return files;
}

const SCOPE_A: ProductionJobScope = {
  version: 1,
  workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  project: "drama-a",
};
const SCOPE_B: ProductionJobScope = {
  version: 1,
  workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  project: "drama-b",
};

const WORKFLOW: Record<string, unknown> = {
  "10": {
    class_type: "H3VideoNode",
    inputs: {
      model_path: "models/MiniMax-H3/model.safetensors",
      source_url: "https://must-not-cross.example/signed?token=SECRET",
      frames: 121,
    },
  },
  "20": { class_type: "SaveVideo", inputs: { video: ["10", 0] } },
};
const PROFILE: ProductionJobProfile = {
  version: 1,
  profileId: PROFILE_ID,
  backendInstanceId: BACKEND,
  workflowDigest: productionJobWorkflowDigest(WORKFLOW),
  stageProfileDigest: null,
  execution: null,
  h3GraphContract: null,
  stageGraphBindings: null,
  workflow: WORKFLOW,
};

const H3_STAGE_GRAPH_BINDINGS: readonly ProductionH3StageBindingContract[] = Object.freeze([
  Object.freeze({
    version: 1 as const,
    index: 0,
    slot: "first_frame",
    source: Object.freeze({
      version: 1 as const, nodeId: "100", classType: "LoadImage" as const, inputName: "image" as const, outputIndex: 0 as const,
    }),
    consumer: Object.freeze({ version: 1 as const, nodeId: "10", inputName: "first_frame" }),
  }),
  Object.freeze({
    version: 1 as const,
    index: 1,
    slot: "last_frame",
    source: Object.freeze({
      version: 1 as const, nodeId: "101", classType: "LoadImage" as const, inputName: "image" as const, outputIndex: 0 as const,
    }),
    consumer: Object.freeze({ version: 1 as const, nodeId: "10", inputName: "last_frame" }),
  }),
]);

const H3_TEMPLATE_WORKFLOW: Record<string, unknown> = {
  "10": {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      clip: ["21", 0], vae: ["22", 0], prompt: "A tense cinematic confrontation",
      width: 768, height: 1_344, length: 192,
      first_frame: ["100", 0], last_frame: ["101", 0],
    },
  },
  "20": { class_type: "UNETLoader", inputs: { unet_name: "diffusion_models/MiniMax-H3.safetensors", weight_dtype: "default" } },
  "21": { class_type: "CLIPLoader", inputs: { clip_name: "text_encoders/MiniMax-H3.safetensors", type: "minimax", device: "default" } },
  "22": { class_type: "VAELoader", inputs: { vae_name: "vae/MiniMax-H3-video.safetensors" } },
  "23": { class_type: "VAELoader", inputs: { vae_name: "vae/MiniMax-H3-audio.safetensors" } },
  "30": { class_type: "MiniMaxH3SigmaShift", inputs: { model: ["20", 0], shift_video: 12, shift_audio: 3 } },
  "31": { class_type: "BasicGuider", inputs: { model: ["30", 0], conditioning: ["10", 0] } },
  "32": { class_type: "BasicScheduler", inputs: { model: ["30", 0], scheduler: "simple", steps: 30, denoise: 1 } },
  "33": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  "34": { class_type: "RandomNoise", inputs: { noise_seed: 42 } },
  "35": {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["34", 0], guider: ["31", 0], sampler: ["33", 0], sigmas: ["32", 0], latent_image: ["10", 1] },
  },
  "36": { class_type: "VAEDecode", inputs: { samples: ["35", 0], vae: ["22", 0] } },
  "37": { class_type: "VAEDecodeAudio", inputs: { samples: ["35", 0], vae: ["23", 0] } },
  "38": { class_type: "CreateVideo", inputs: { images: ["36", 0], fps: 24, audio: ["37", 0], bit_depth: 8 } },
  "39": { class_type: "SaveVideo", inputs: { video: ["38", 0], filename_prefix: "writing-loop/h3", format: "auto", codec: "auto" } },
  "100": { class_type: "LoadImage", inputs: { image: productionH3StageInputSentinel(PROFILE_ID, 0, "first_frame") } },
  "101": { class_type: "LoadImage", inputs: { image: productionH3StageInputSentinel(PROFILE_ID, 1, "last_frame") } },
};

const H3_MODEL_COMPONENTS = {
  diffusion: Object.freeze({
    version: 1 as const, nodeId: "20", classType: "UNETLoader" as const, inputName: "unet_name" as const,
    modelAlias: "diffusion_models/MiniMax-H3.safetensors", artifactSha256: "1".repeat(64),
  }),
  textEncoder: Object.freeze({
    version: 1 as const, nodeId: "21", classType: "CLIPLoader" as const, inputName: "clip_name" as const,
    modelAlias: "text_encoders/MiniMax-H3.safetensors", artifactSha256: "2".repeat(64),
  }),
  videoVae: Object.freeze({
    version: 1 as const, nodeId: "22", classType: "VAELoader" as const, inputName: "vae_name" as const,
    modelAlias: "vae/MiniMax-H3-video.safetensors", artifactSha256: "3".repeat(64),
  }),
  audioVae: Object.freeze({
    version: 1 as const, nodeId: "23", classType: "VAELoader" as const, inputName: "vae_name" as const,
    modelAlias: "vae/MiniMax-H3-audio.safetensors", artifactSha256: "4".repeat(64),
  }),
};
const H3_MODEL_BUNDLE_SHA = productionH3ModelBundleSha256({
  version: 1,
  ...H3_MODEL_COMPONENTS,
  sha256: SHA_A,
});
const H3_CONTRACT_WITH_PLACEHOLDER: ProductionH3GraphContract = {
  version: 1,
  generator: { version: 1, nodeId: "10", classType: "MiniMaxH3ImageToVideo", width: 768, height: 1_344, length: 192 },
  modelBundle: { version: 1, ...H3_MODEL_COMPONENTS, sha256: H3_MODEL_BUNDLE_SHA },
  pipeline: {
    version: 1,
    sigmaShift: { version: 1, nodeId: "30", classType: "MiniMaxH3SigmaShift" },
    guider: { version: 1, nodeId: "31", classType: "BasicGuider" },
    scheduler: { version: 1, nodeId: "32", classType: "BasicScheduler" },
    samplerSelect: { version: 1, nodeId: "33", classType: "KSamplerSelect" },
    noise: { version: 1, nodeId: "34", classType: "RandomNoise" },
    sampler: { version: 1, nodeId: "35", classType: "SamplerCustomAdvanced" },
    videoDecode: { version: 1, nodeId: "36", classType: "VAEDecode" },
    audioDecode: { version: 1, nodeId: "37", classType: "VAEDecodeAudio" },
    createVideo: { version: 1, nodeId: "38", classType: "CreateVideo" },
    saveVideo: { version: 1, nodeId: "39", classType: "SaveVideo" },
  },
  parameterManifest: { version: 1, sha256: SHA_A },
};
const H3_EXECUTION_PLACEHOLDER: ProductionIntentExecution = {
  version: 1,
  operation: "comfyui-workflow",
  modelFamily: "minimax-h3",
  backendInstanceId: BACKEND,
  workflowSha256: productionJobWorkflowDigest(H3_TEMPLATE_WORKFLOW),
  modelSha256: H3_MODEL_BUNDLE_SHA,
  parametersSha256: SHA_A,
  variant: "fl2va",
  durationSeconds: 8,
  shortEdge: 768,
  aspectRatio: "9:16",
};
const H3_PARAMETER_SHA = productionH3ParameterManifestSha256(
  H3_TEMPLATE_WORKFLOW, H3_CONTRACT_WITH_PLACEHOLDER, H3_EXECUTION_PLACEHOLDER,
);
const H3_GRAPH_CONTRACT: ProductionH3GraphContract = Object.freeze({
  ...H3_CONTRACT_WITH_PLACEHOLDER,
  parameterManifest: Object.freeze({ version: 1 as const, sha256: H3_PARAMETER_SHA }),
});
const H3_EXECUTION: ProductionIntentExecution = Object.freeze({
  ...H3_EXECUTION_PLACEHOLDER,
  parametersSha256: H3_PARAMETER_SHA,
});
const STAGED_BINDINGS: readonly ProductionInputBinding[] = Object.freeze([
  Object.freeze({ index: 0, slot: "first_frame", assetSha256: SHA_A, providerObjectKey: `wlcas/sha256/aa/${SHA_A}` }),
  Object.freeze({ index: 1, slot: "last_frame", assetSha256: SHA_B, providerObjectKey: `wlcas/sha256/bb/${SHA_B}` }),
]);
const STAGED_BINDINGS_DIGEST = productionInputBindingsDigest(STAGED_BINDINGS);
const STAGED_BOUND_WORKFLOW = materializeProductionH3Workflow(
  H3_TEMPLATE_WORKFLOW,
  H3_GRAPH_CONTRACT,
  H3_EXECUTION,
  H3_STAGE_GRAPH_BINDINGS,
  STAGED_BINDINGS,
  PROFILE_ID,
).workflow;
const STAGED_BINDINGS_B: readonly ProductionInputBinding[] = Object.freeze([
  Object.freeze({ index: 0, slot: "first_frame", assetSha256: SHA_C, providerObjectKey: `wlcas/sha256/cc/${SHA_C}` }),
  Object.freeze({ index: 1, slot: "last_frame", assetSha256: SHA_D, providerObjectKey: `wlcas/sha256/dd/${SHA_D}` }),
]);
const STAGED_BINDINGS_DIGEST_B = productionInputBindingsDigest(STAGED_BINDINGS_B);
const STAGED_BOUND_WORKFLOW_B = materializeProductionH3Workflow(
  H3_TEMPLATE_WORKFLOW,
  H3_GRAPH_CONTRACT,
  H3_EXECUTION,
  H3_STAGE_GRAPH_BINDINGS,
  STAGED_BINDINGS_B,
  PROFILE_ID,
).workflow;
const STAGED_PROFILE: ProductionJobProfile = {
  version: 1,
  profileId: PROFILE_ID,
  backendInstanceId: BACKEND,
  workflowDigest: productionJobWorkflowDigest(H3_TEMPLATE_WORKFLOW),
  stageProfileDigest: SHA_D,
  execution: H3_EXECUTION,
  h3GraphContract: H3_GRAPH_CONTRACT,
  stageGraphBindings: H3_STAGE_GRAPH_BINDINGS,
  workflow: H3_TEMPLATE_WORKFLOW,
};

const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;

function capabilities(): BackendCapabilities {
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
    modelFamilies: ["generic", "minimax-h3"],
    processingRegions: ["SG"],
    providerJobIdMapping: "none",
    limitsByModelId: {},
  };
}

class FakeRawAdapter implements ProductionAdapter {
  prepareCalls = 0;
  submitCalls = 0;
  inspectCalls = 0;
  cancelCalls = 0;
  state: RemoteObservation["state"] = "pending";
  submitError: ProductionAdapterError | null = null;
  inspectError: ProductionAdapterError | null = null;
  cancelError: ProductionAdapterError | null = null;
  inspectHandler: ((remoteJobId: string, signal?: AbortSignal) => Promise<RemoteObservation>) | null = null;
  submitSecret: string | null = null;
  onSubmit: (() => void) | null = null;
  requestDigestSalt = "";
  readonly preparedRequests: SubmitRequest[] = [];

  async capabilities(): Promise<BackendCapabilities> { return capabilities(); }

  prepareSubmission(request: SubmitRequest): PreparedSubmission {
    this.prepareCalls++;
    this.preparedRequests.push(request);
    return {
      version: 1,
      backendInstanceId: BACKEND,
      remoteJobId: request.remoteJobId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: createHash("sha256")
        .update(JSON.stringify(request))
        .update(this.requestDigestSalt)
        .digest("hex"),
      request,
    };
  }

  async submitPrepared(prepared: PreparedSubmission): Promise<SubmitResult> {
    this.submitCalls++;
    this.onSubmit?.();
    if (this.submitError) throw this.submitError;
    if (this.submitSecret) throw new Error(this.submitSecret);
    this.state = "pending";
    return {
      remoteJobId: prepared.remoteJobId,
      acceptedAt: at(1),
      providerIdempotency: false,
      nodeErrorCount: 0,
      responseDigest: SHA_A,
    };
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    return await this.submitPrepared(this.prepareSubmission(request));
  }

  async inspect(remoteJobId: string, signal?: AbortSignal): Promise<RemoteObservation> {
    this.inspectCalls++;
    if (this.inspectHandler) return await this.inspectHandler(remoteJobId, signal);
    if (this.inspectError) throw this.inspectError;
    if (signal?.aborted) throw new ProductionAdapterError("aborted", "raw aborted");
    return {
      remoteJobId,
      state: this.state,
      observedAt: at(2),
      outputs: this.state === "succeeded"
        ? [{ nodeId: "20", kind: "video", filename: "take.mp4", subfolder: "final", folderType: "output" }]
        : [],
      errorSummary: this.state === "cancelled" ? "cancelled" : null,
      responseDigest: SHA_B,
    };
  }

  async cancel(remoteJobId: string): Promise<CancelResult> {
    this.cancelCalls++;
    if (this.cancelError) throw this.cancelError;
    // Acceptance is deliberately not terminal evidence. State remains whatever inspect reports.
    return {
      remoteJobId,
      accepted: true,
      confirmed: false,
      runningInterruptRequested: true,
      observedAt: at(3),
    };
  }
}

type StorageSlot = {
  context: string;
  scope: string;
  bytes: number;
  state: "pending" | "committed" | "released";
  recordRef: string | null;
};

class DurableTestStorageAdmissionPolicy implements ProductionJobStorageAdmissionPolicy {
  readonly slots = new Map<string, StorageSlot>();
  readonly acquiredKeys: string[] = [];
  readonly committedKeys: string[] = [];
  readonly releasedKeys: string[] = [];
  readonly #perScopeJobs: number;
  readonly #perScopeBytes: number;
  readonly #globalJobs: number;
  readonly #globalBytes: number;

  constructor(limits: {
    perScopeJobs?: number;
    perScopeBytes?: number;
    globalJobs?: number;
    globalBytes?: number;
  } = {}) {
    this.#perScopeJobs = limits.perScopeJobs ?? Number.POSITIVE_INFINITY;
    this.#perScopeBytes = limits.perScopeBytes ?? Number.POSITIVE_INFINITY;
    this.#globalJobs = limits.globalJobs ?? Number.POSITIVE_INFINITY;
    this.#globalBytes = limits.globalBytes ?? Number.POSITIVE_INFINITY;
  }

  get activeSlots(): number {
    return [...this.slots.values()].filter((slot) => slot.state !== "released").length;
  }

  get committedSlots(): number {
    return [...this.slots.values()].filter((slot) => slot.state === "committed").length;
  }

  get releasedSlots(): number {
    return [...this.slots.values()].filter((slot) => slot.state === "released").length;
  }

  acquire(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
  ): ProductionJobStorageAdmissionDecision {
    this.acquiredKeys.push(storageKey);
    if (productionJobStorageKey(context.scope, context.idempotencyKey) !== storageKey
      || !Number.isSafeInteger(context.recordBytesUpperBound) || context.recordBytesUpperBound < 1) {
      throw new Error("invalid gateway storage context");
    }
    const exact = JSON.stringify(context);
    const existing = this.slots.get(storageKey);
    if (existing) {
      if (existing.context !== exact || existing.state === "released") return "conflict";
      return "allow";
    }
    const scope = JSON.stringify(context.scope);
    const active = [...this.slots.values()].filter((slot) => slot.state !== "released");
    const scoped = active.filter((slot) => slot.scope === scope);
    const scopedBytes = scoped.reduce((sum, slot) => sum + slot.bytes, 0);
    const globalBytes = active.reduce((sum, slot) => sum + slot.bytes, 0);
    if (scoped.length + 1 > this.#perScopeJobs
      || scopedBytes + context.recordBytesUpperBound > this.#perScopeBytes
      || active.length + 1 > this.#globalJobs
      || globalBytes + context.recordBytesUpperBound > this.#globalBytes) {
      return "capacity-exceeded";
    }
    this.slots.set(storageKey, {
      context: exact,
      scope,
      bytes: context.recordBytesUpperBound,
      state: "pending",
      recordRef: null,
    });
    return "allow";
  }

  commit(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    recordRef: string,
  ): void {
    this.committedKeys.push(storageKey);
    const slot = this.slots.get(storageKey);
    if (!slot || slot.context !== JSON.stringify(context) || slot.state === "released"
      || !/^[a-f0-9]{64}$/.test(recordRef)
      || (slot.recordRef !== null && slot.recordRef !== recordRef)) {
      throw new Error("invalid storage commit");
    }
    slot.state = "committed";
    slot.recordRef = recordRef;
  }

  release(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    reason: "unused-before-record",
  ): "released" | "conflict" {
    this.releasedKeys.push(storageKey);
    if (reason !== "unused-before-record") throw new Error("invalid release reason");
    const slot = this.slots.get(storageKey);
    if (!slot) return "released"; // Required unknown-key no-op for a fresh pre-existing remote conflict.
    if (slot.context !== JSON.stringify(context) || slot.state === "committed") return "conflict";
    if (slot.state === "released") return "released";
    slot.state = "released";
    return "released";
  }
}

type Harness = {
  gateway: ProductionJobGateway;
  adapter: ProductionGatewayAdapter;
  raw: FakeRawAdapter;
  calls: Array<{ url: URL; init: RequestInit; body: string }>;
  setClientFetch(fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>): ProductionGatewayAdapter;
};

async function harness(options: {
  storeRoot?: string;
  scope?: ProductionJobScope;
  raw?: FakeRawAdapter;
  hooks?: ProductionJobGatewayOptions["hooks"];
  serverToken?: () => string;
  serverCredentialResolver?: ProductionJobGatewayOptions["credentialResolver"];
  admissionPolicy?: ProductionJobGatewayOptions["submissionAdmissionPolicy"];
  storageAdmissionPolicy?: ProductionJobGatewayOptions["storageAdmissionPolicy"];
  clientToken?: () => string;
  validator?: ProductionJobGatewayOptions["profileValidator"];
  profile?: ProductionJobProfile;
  stageReceiptRegistry?: ProductionJobGatewayOptions["stageReceiptRegistry"];
  timeoutMs?: number;
  clientTimeoutMs?: number;
  now?: () => Date;
} = {}): Promise<Harness> {
  const raw = options.raw ?? new FakeRawAdapter();
  const scope = options.scope ?? SCOPE_A;
  const calls: Array<{ url: URL; init: RequestInit; body: string }> = [];
  const profile = options.profile ?? PROFILE;
  const server = await ProductionJobGateway.create({
    storeRoot: options.storeRoot ?? root(),
    credentialResolver: options.serverCredentialResolver ?? (() => options.serverToken?.() ?? TOKEN_A),
    profileRegistry: {
      resolve: (requestedScope, profileId) =>
        requestedScope.workspaceId === scope.workspaceId && requestedScope.project === scope.project
          && profileId === PROFILE_ID ? profile : null,
    },
    profileValidator: options.validator ?? (() => true),
    stageReceiptRegistry: options.stageReceiptRegistry ?? {
      verifyStageReceipt: async (claim) => verifiedReceiptForClaim(claim),
    },
    submissionAdmissionPolicy: options.admissionPolicy ?? {
      acquire: () => "allow",
      settle: () => undefined,
    },
    storageAdmissionPolicy: options.storageAdmissionPolicy ?? new DurableTestStorageAdmissionPolicy(),
    rawAdapter: raw,
    timeoutMs: options.timeoutMs,
    hooks: options.hooks,
    now: options.now ?? (() => new Date(at(0))),
  });
  const bridge = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url: new URL(String(input)), init, body });
    return await server.handle(new Request(String(input), init));
  };
  const buildAdapter = (fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>) =>
    new ProductionGatewayAdapter({
      baseUrl: "https://job-gateway.internal/",
      workspaceId: scope.workspaceId,
      project: scope.project,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID,
      credentialResolver: () => options.clientToken?.() ?? TOKEN_A,
      fetch: fetcher,
      timeoutMs: options.clientTimeoutMs ?? options.timeoutMs,
      maxResponseBytes: 64 * 1024,
    });
  return {
    gateway: server,
    adapter: buildAdapter(bridge),
    raw,
    calls,
    setClientFetch: buildAdapter,
  };
}

const submitRequest = (workflow: Record<string, unknown> = WORKFLOW): SubmitRequest => ({
  idempotencyKey: "idem-take-001",
  remoteJobId: REMOTE_ID,
  workflow,
  inputBinding: null,
});

const stagedSubmitRequest = (
  remoteJobId = "88888888-8888-4888-8888-888888888888",
  idempotencyKey = SHA_C,
  workflow: Record<string, unknown> = STAGED_BOUND_WORKFLOW,
  bindingsDigest = STAGED_BINDINGS_DIGEST,
): SubmitRequest => ({
  idempotencyKey,
  remoteJobId,
  workflow,
  inputBinding: {
    version: 1,
    stageKey: SHA_A,
    bindingsDigest,
    intentDigest: idempotencyKey,
  },
});

function verifiedReceiptForClaim(
  claim: ProductionStageReceiptClaim,
  options: {
    execution?: ProductionIntentExecution;
    bindings?: readonly ProductionInputBinding[];
  } = {},
): VerifiedStageReceipt {
  const bindings = options.bindings ?? STAGED_BINDINGS;
  return Object.freeze({
    version: 1,
    scope: Object.freeze({ ...claim.scope }),
    stageKey: claim.stageKey,
    bindingsDigest: claim.bindingsDigest,
    intentDigest: claim.intentDigest,
    profileDigest: claim.profileDigest,
    execution: Object.freeze({ ...(options.execution ?? H3_EXECUTION) }),
    bindings: Object.freeze(bindings.map((binding) => Object.freeze({ ...binding }))),
    shotRequest: null,
  });
}

async function captureAdapterError(operation: () => Promise<unknown>): Promise<ProductionAdapterError | null> {
  try { await operation(); return null; }
  catch (error) { return error instanceof ProductionAdapterError ? error : null; }
}

try {
  let insecureClientFetches = 0;
  let insecureClientRejected = false;
  try {
    new ProductionGatewayAdapter({
      baseUrl: "http://job-gateway.internal/",
      workspaceId: SCOPE_A.workspaceId,
      project: SCOPE_A.project,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID,
      credentialResolver: () => TOKEN_A,
      fetch: async () => { insecureClientFetches++; return new Response(); },
    });
  } catch (error) { insecureClientRejected = error instanceof ProductionAdapterError; }
  ok(insecureClientRejected && insecureClientFetches === 0,
    "ProductionGatewayAdapter constructor 在 fetch 前拒绝任意 HTTP，bearer 只允许 HTTPS");

  const missingPolicyRaw = new FakeRawAdapter();
  let missingPolicyRejected = false;
  try {
    await ProductionJobGateway.create({
      storeRoot: root(),
      credentialResolver: () => TOKEN_A,
      profileRegistry: { resolve: () => PROFILE },
      profileValidator: () => true,
      stageReceiptRegistry: {
        verifyStageReceipt: async (claim: ProductionStageReceiptClaim) => verifiedReceiptForClaim(claim),
      },
      rawAdapter: missingPolicyRaw,
    } as unknown as ProductionJobGatewayOptions);
  } catch (error) { missingPolicyRejected = error instanceof Error; }
  ok(missingPolicyRejected && missingPolicyRaw.prepareCalls === 0 && missingPolicyRaw.submitCalls === 0,
    "生产 job gateway 缺少 SubmissionAdmissionPolicy 时 constructor fail-closed，无 permissive default");

  const missingStoragePolicyRaw = new FakeRawAdapter();
  let missingStoragePolicyRejected = false;
  try {
    await ProductionJobGateway.create({
      storeRoot: root(),
      credentialResolver: () => TOKEN_A,
      profileRegistry: { resolve: () => PROFILE },
      profileValidator: () => true,
      stageReceiptRegistry: {
        verifyStageReceipt: async (claim: ProductionStageReceiptClaim) => verifiedReceiptForClaim(claim),
      },
      submissionAdmissionPolicy: { acquire: () => "allow", settle: () => undefined },
      rawAdapter: missingStoragePolicyRaw,
    } as unknown as ProductionJobGatewayOptions);
  } catch (error) { missingStoragePolicyRejected = error instanceof Error; }
  ok(missingStoragePolicyRejected
    && missingStoragePolicyRaw.prepareCalls === 0 && missingStoragePolicyRaw.submitCalls === 0,
  "生产 job gateway 缺少 durable StorageAdmissionPolicy 时 constructor fail-closed，无本地 permissive quota");

  // Happy path: local prepare knows exact gateway PUT digest and no private graph crosses HTTP.
  const happy = await harness();
  const prepared = happy.adapter.prepareSubmission(submitRequest());
  const reorderedWorkflow = {
    "20": { inputs: { video: ["10", 0] }, class_type: "SaveVideo" },
    "10": {
      inputs: {
        frames: 121,
        source_url: "https://must-not-cross.example/signed?token=SECRET",
        model_path: "models/MiniMax-H3/model.safetensors",
      },
      class_type: "H3VideoNode",
    },
  };
  const reordered = happy.adapter.prepareSubmission(submitRequest(reorderedWorkflow));
  ok(prepared.requestDigest === reordered.requestDigest && /^[a-f0-9]{64}$/.test(prepared.requestDigest),
    "prepareSubmission 在网络前产生 scope/profile/canonical-workflow 绑定的 exact PUT digest");
  const submitted = await happy.adapter.submitPrepared(prepared);
  const sent = happy.calls[0]!;
  const sentBody = JSON.parse(sent.body) as ProductionJobPutRequest;
  ok(submitted.remoteJobId === REMOTE_ID && happy.raw.prepareCalls === 1 && happy.raw.submitCalls === 1,
    "首次合法 PUT 在 durable outbox 后只调用一次 raw prepare/submit");
  ok(sent.url.pathname === `/v1/scopes/${SCOPE_A.workspaceId}/${SCOPE_A.project}/jobs/${REMOTE_ID}`
    && sent.init.method === "PUT" && sent.init.redirect === "error"
    && new Headers(sent.init.headers).get("x-writing-loop-request-digest") === prepared.requestDigest,
  "客户端使用自有 scope-bound PUT 契约、exact digest header 与 redirect:error");
  ok(sentBody.scope.workspaceId === SCOPE_A.workspaceId && sentBody.scope.project === SCOPE_A.project
    && sentBody.remoteJobId === REMOTE_ID && sentBody.profile.profileId === PROFILE_ID
    && !Object.prototype.hasOwnProperty.call(sentBody, "workflow")
    && !Object.prototype.hasOwnProperty.call(sentBody.profile, "workflow")
    && !sent.body.includes("model.safetensors")
    && !sent.body.includes("must-not-cross") && !sent.body.includes(TOKEN_A)
    && !Object.keys(sentBody).some((key) => /url|header|token|model/i.test(key)),
  "job PUT 只发送 scope/identity/profile digest，不携 URL/header/token/workflow/model path");

  const stagedProfile = STAGED_PROFILE;
  const stageClaims: unknown[] = [];
  const staged = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async (claim) => {
        stageClaims.push(claim);
        return verifiedReceiptForClaim(claim);
      },
    },
  });
  const stagedRequest = stagedSubmitRequest();
  await staged.adapter.submit(stagedRequest);
  const exactClaim = stageClaims[0] as {
    scope?: ProductionJobScope;
    stageKey?: string;
    bindingsDigest?: string;
    intentDigest?: string;
    profileDigest?: string;
  } | undefined;
  ok(staged.raw.submitCalls === 1 && stageClaims.length === 1
    && exactClaim?.scope?.workspaceId === SCOPE_A.workspaceId
    && exactClaim.stageKey === stagedRequest.inputBinding?.stageKey
    && exactClaim.bindingsDigest === stagedRequest.inputBinding?.bindingsDigest
    && exactClaim.intentDigest === stagedRequest.idempotencyKey
    && exactClaim.profileDigest === SHA_D,
  "staged job 在 durable attempt/raw submit 前验证 exact scope+stage+bindings+intent+profile receipt tuple");
  const stagedRawWorkflow = staged.raw.preparedRequests[0]?.workflow;
  const stagedRawText = JSON.stringify(stagedRawWorkflow ?? {});
  const stagedGeneratorInputs = (stagedRawWorkflow?.["10"] as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  const stagedFirstSource = (stagedRawWorkflow?.["100"] as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  const stagedLastSource = (stagedRawWorkflow?.["101"] as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  const templateFirstSource = (H3_TEMPLATE_WORKFLOW["100"] as { inputs: Record<string, unknown> }).inputs;
  const templateLastSource = (H3_TEMPLATE_WORKFLOW["101"] as { inputs: Record<string, unknown> }).inputs;
  ok(stagedFirstSource?.image === STAGED_BINDINGS[0]!.providerObjectKey
    && stagedLastSource?.image === STAGED_BINDINGS[1]!.providerObjectKey
    && JSON.stringify(stagedGeneratorInputs?.first_frame) === JSON.stringify(["100", 0])
    && JSON.stringify(stagedGeneratorInputs?.last_frame) === JSON.stringify(["101", 0])
    && stagedRawText.split(STAGED_BINDINGS[0]!.providerObjectKey).length - 1 === 1
    && stagedRawText.split(STAGED_BINDINGS[1]!.providerObjectKey).length - 1 === 1
    && productionJobWorkflowDigest(stagedRawWorkflow!) === productionJobWorkflowDigest(STAGED_BOUND_WORKFLOW)
    && templateFirstSource.image === productionH3StageInputSentinel(PROFILE_ID, 0, "first_frame")
    && templateLastSource.image === productionH3StageInputSentinel(PROFILE_ID, 1, "last_frame"),
  "server 从 immutable template + receipt A 物化唯一 provider keys，并证明 LoadImage source→真实 H3 generator topology");
  staged.gateway.close();

  const stagedB = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async (claim) => verifiedReceiptForClaim(claim, { bindings: STAGED_BINDINGS_B }),
    },
  });
  const stagedBRequest = stagedSubmitRequest(
    "89898989-8989-4989-8989-898989898989",
    "e".repeat(64),
    STAGED_BOUND_WORKFLOW_B,
    STAGED_BINDINGS_DIGEST_B,
  );
  await stagedB.adapter.submit(stagedBRequest);
  const stagedBRawWorkflow = stagedB.raw.preparedRequests[0]?.workflow;
  const stagedBFirstSource = (stagedBRawWorkflow?.["100"] as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  const stagedBLastSource = (stagedBRawWorkflow?.["101"] as { inputs?: Record<string, unknown> } | undefined)?.inputs;
  ok(stagedB.raw.submitCalls === 1
    && stagedBFirstSource?.image === STAGED_BINDINGS_B[0]!.providerObjectKey
    && stagedBLastSource?.image === STAGED_BINDINGS_B[1]!.providerObjectKey
    && productionJobWorkflowDigest(stagedBRawWorkflow!) === productionJobWorkflowDigest(STAGED_BOUND_WORKFLOW_B)
    && templateFirstSource.image === productionH3StageInputSentinel(PROFILE_ID, 0, "first_frame")
    && templateLastSource.image === productionH3StageInputSentinel(PROFILE_ID, 1, "last_frame"),
  "同一 server template 可用 receipt B 派生独立 bound graph，raw 只看到 B keys 且 template 不被污染");
  stagedB.gateway.close();

  let receiptBGraphADurableCalls = 0;
  const receiptBGraphA = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async (claim) => verifiedReceiptForClaim(claim, { bindings: STAGED_BINDINGS_B }),
    },
    hooks: { afterJobDurable: () => { receiptBGraphADurableCalls++; } },
  });
  const receiptBGraphAError = await captureAdapterError(() => receiptBGraphA.adapter.submit(stagedSubmitRequest(
    "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a",
    "f".repeat(64),
    STAGED_BOUND_WORKFLOW,
    STAGED_BINDINGS_DIGEST_B,
  )));
  ok(receiptBGraphAError?.code === "remote-rejected" && receiptBGraphADurableCalls === 0
    && receiptBGraphA.raw.prepareCalls === 0 && receiptBGraphA.raw.submitCalls === 0,
  "合法 receipt B 不能授权 client digest 指向 graph A；在任何 durable binding/prepare/raw 前 403");
  receiptBGraphA.gateway.close();

  const wrongSlotBindings: readonly ProductionInputBinding[] = Object.freeze([
    Object.freeze({ ...STAGED_BINDINGS[0]!, slot: "decoy_frame" }),
    STAGED_BINDINGS[1]!,
  ]);
  const wrongSlotDigest = productionInputBindingsDigest(wrongSlotBindings);
  let wrongSlotDurableCalls = 0;
  const wrongSlotReceipt = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async (claim) => verifiedReceiptForClaim(claim, { bindings: wrongSlotBindings }),
    },
    hooks: { afterJobDurable: () => { wrongSlotDurableCalls++; } },
  });
  const wrongSlotError = await captureAdapterError(() => wrongSlotReceipt.adapter.submit(stagedSubmitRequest(
    "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b",
    "1".repeat(64),
    STAGED_BOUND_WORKFLOW,
    wrongSlotDigest,
  )));
  ok(wrongSlotError?.code === "remote-rejected" && wrongSlotDurableCalls === 0
    && wrongSlotReceipt.raw.prepareCalls === 0 && wrongSlotReceipt.raw.submitCalls === 0,
  "receipt ordered slot 与 server stageGraphBindings 漂移时不能借 decoy loader 消费 key，零 durable/raw side effect");
  wrongSlotReceipt.gateway.close();

  let executionDriftDurableCalls = 0;
  const executionDriftReceipt = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async (claim) => verifiedReceiptForClaim(claim, {
        execution: { ...H3_EXECUTION, durationSeconds: 6 },
      }),
    },
    hooks: { afterJobDurable: () => { executionDriftDurableCalls++; } },
  });
  const executionDriftError = await captureAdapterError(
    () => executionDriftReceipt.adapter.submit(stagedSubmitRequest()),
  );
  ok(executionDriftError?.code === "remote-rejected" && executionDriftDurableCalls === 0
    && executionDriftReceipt.raw.prepareCalls === 0 && executionDriftReceipt.raw.submitCalls === 0,
  "receipt execution tuple 必须与 server profile exact canonical 相等，tuple drift 零 durable/prepare/raw");
  executionDriftReceipt.gateway.close();

  let mismatchedIntentReceiptCalls = 0;
  let mismatchedIntentDurableCalls = 0;
  const mismatchedIntent = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: {
      verifyStageReceipt: async () => { mismatchedIntentReceiptCalls++; return null; },
    },
    hooks: { afterJobDurable: () => { mismatchedIntentDurableCalls++; } },
  });
  const mismatchedIntentRequest = stagedSubmitRequest();
  mismatchedIntentRequest.inputBinding = { ...mismatchedIntentRequest.inputBinding!, intentDigest: SHA_D };
  const mismatchedIntentError = await captureAdapterError(
    () => mismatchedIntent.adapter.submit(mismatchedIntentRequest),
  );
  ok(mismatchedIntentError?.code === "remote-rejected" && mismatchedIntentReceiptCalls === 0
    && mismatchedIntentDurableCalls === 0
    && mismatchedIntent.raw.prepareCalls === 0 && mismatchedIntent.raw.submitCalls === 0,
  "inputBinding.intentDigest 必须等于 job idempotencyKey，漂移在 receipt/raw/store side effect 前拒绝");
  mismatchedIntent.gateway.close();

  for (const drift of ["stage", "bindings", "profile", "scope"] as const) {
    let receiptCalls = 0;
    let durableCalls = 0;
    const driftProfile = drift === "profile" ? { ...stagedProfile, stageProfileDigest: SHA_C } : stagedProfile;
    const rejectedReceipt = await harness({
      scope: drift === "scope" ? SCOPE_B : SCOPE_A,
      profile: driftProfile,
      stageReceiptRegistry: {
        verifyStageReceipt: async (claim) => {
          receiptCalls++;
          const allowed = claim.scope.workspaceId === SCOPE_A.workspaceId
            && claim.scope.project === SCOPE_A.project
            && claim.stageKey === SHA_A && claim.bindingsDigest === STAGED_BINDINGS_DIGEST
            && claim.intentDigest === SHA_C && claim.profileDigest === SHA_D;
          return allowed ? verifiedReceiptForClaim(claim) : null;
        },
      },
      hooks: { afterJobDurable: () => { durableCalls++; } },
    });
    const driftedRequest = stagedSubmitRequest();
    if (drift === "stage") driftedRequest.inputBinding = { ...driftedRequest.inputBinding!, stageKey: SHA_B };
    if (drift === "bindings") {
      driftedRequest.inputBinding = { ...driftedRequest.inputBinding!, bindingsDigest: SHA_C };
    }
    const rejectedReceiptError = await captureAdapterError(
      () => rejectedReceipt.adapter.submit(driftedRequest),
    );
    ok(rejectedReceiptError?.code === "remote-rejected" && receiptCalls === 1 && durableCalls === 0
      && rejectedReceipt.raw.prepareCalls === 0 && rejectedReceipt.raw.submitCalls === 0,
    `${drift} receipt claim 漂移在 durable job/attempt 与 raw I/O 前 fail-closed`);
    rejectedReceipt.gateway.close();
  }

  const stagedWithoutBinding = await harness({ profile: stagedProfile });
  const stagedWithoutBindingError = await captureAdapterError(
    () => stagedWithoutBinding.adapter.submit(submitRequest()),
  );
  const staticWithBinding = await harness();
  const staticWithBindingError = await captureAdapterError(
    () => staticWithBinding.adapter.submit(stagedSubmitRequest()),
  );
  ok(stagedWithoutBindingError?.code === "remote-rejected"
    && staticWithBindingError?.code === "remote-rejected"
    && stagedWithoutBinding.raw.submitCalls === 0 && staticWithBinding.raw.submitCalls === 0,
  "staged profile 必须有 binding，static profile 必须无 binding，二者不可降级或混用");
  stagedWithoutBinding.gateway.close();
  staticWithBinding.gateway.close();

  const throwingReceipt = await harness({
    profile: stagedProfile,
    stageReceiptRegistry: { verifyStageReceipt: async () => { throw new Error("STAGE_SECRET"); } },
  });
  const throwingReceiptError = await captureAdapterError(
    () => throwingReceipt.adapter.submit(stagedSubmitRequest()),
  );
  ok(throwingReceiptError?.code === "remote-rejected"
    && !throwingReceiptError.message.includes("STAGE_SECRET")
    && throwingReceipt.raw.prepareCalls === 0 && throwingReceipt.raw.submitCalls === 0,
  "stage receipt registry unavailable 时脱敏 fail-closed，绝不触发 raw provider");
  throwingReceipt.gateway.close();

  const reuseRoot = root();
  const firstReuse = await harness({ storeRoot: reuseRoot, profile: stagedProfile });
  await firstReuse.adapter.submit(stagedSubmitRequest());
  firstReuse.gateway.close();
  const reuseRaw = new FakeRawAdapter();
  const restartedReuse = await harness({ storeRoot: reuseRoot, profile: stagedProfile, raw: reuseRaw });
  const reuseError = await captureAdapterError(() => restartedReuse.adapter.submit(stagedSubmitRequest(
    "99999999-9999-4999-8999-999999999999",
  )));
  ok(reuseError?.code === "remote-rejected" && reuseRaw.prepareCalls === 0 && reuseRaw.submitCalls === 0,
  "同一 scoped intent/stage receipt 重启后不能绑定第二个 remote job，避免重复计费");
  restartedReuse.gateway.close();

  const concurrentReuse = await harness({ profile: stagedProfile });
  const concurrentResults = await Promise.allSettled([
    concurrentReuse.adapter.submit(stagedSubmitRequest("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
    concurrentReuse.adapter.submit(stagedSubmitRequest("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
  ]);
  ok(concurrentResults.filter((row) => row.status === "fulfilled").length === 1
    && concurrentReuse.raw.submitCalls === 1,
  "同一 scoped intent/stage receipt 并发抢两个 remote job 时 O_EXCL binding 只允许一次 raw submit");
  concurrentReuse.gateway.close();

  const crossScopeRoot = root();
  const crossScopeA = await harness({ storeRoot: crossScopeRoot, scope: SCOPE_A, profile: stagedProfile });
  const crossScopeB = await harness({ storeRoot: crossScopeRoot, scope: SCOPE_B, profile: stagedProfile });
  await crossScopeA.adapter.submit(stagedSubmitRequest("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  await crossScopeB.adapter.submit(stagedSubmitRequest("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
  ok(crossScopeA.raw.submitCalls === 1 && crossScopeB.raw.submitCalls === 1,
  "intent binding 按 workspace/project 隔离；不同 scope 的独立 receipt 不会互相占用");
  crossScopeA.gateway.close();
  crossScopeB.gateway.close();

  const remoteRace = await harness();
  const sameRemoteA: SubmitRequest = {
    ...submitRequest(), idempotencyKey: "intent-race-a", remoteJobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };
  const sameRemoteB: SubmitRequest = { ...sameRemoteA, idempotencyKey: "intent-race-b" };
  const remoteRaceResults = await Promise.allSettled([
    remoteRace.adapter.submit(sameRemoteA), remoteRace.adapter.submit(sameRemoteB),
  ]);
  const loser = remoteRaceResults[0]?.status === "rejected" ? sameRemoteA : sameRemoteB;
  const loserRemoteDrift = await captureAdapterError(
    () => remoteRace.adapter.submit({ ...loser, remoteJobId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
  );
  ok(remoteRaceResults.filter((row) => row.status === "fulfilled").length === 1
    && loserRemoteDrift?.code === "remote-rejected" && remoteRace.raw.submitCalls === 1,
  "不同 intent 并发抢同一 remote ID 时仅一方提交；loser 的同 intent/new remote 漂移保持 conflict");
  remoteRace.gateway.close();

  const storageRecordBound = DEFAULT_PRODUCTION_JOB_GATEWAY_RECORD_BYTES
    * PRODUCTION_JOB_DURABLE_RECORDS_PER_SLOT;
  const capacityPolicy = new DurableTestStorageAdmissionPolicy({
    perScopeJobs: 2,
    perScopeBytes: storageRecordBound * 2,
    globalJobs: 10,
    globalBytes: storageRecordBound * 10,
  });
  const capacityRoot = root();
  const capacityRaw = new FakeRawAdapter();
  const capacity = await harness({
    storeRoot: capacityRoot,
    raw: capacityRaw,
    storageAdmissionPolicy: capacityPolicy,
  });
  const capacityRequests: SubmitRequest[] = [0, 1, 2].map((index) => ({
    ...submitRequest(),
    idempotencyKey: `storage-cap-intent-${index}`,
    remoteJobId: `storage-cap-job-${index}`,
  }));
  const capacityResults = await Promise.allSettled(
    capacityRequests.map((request) => capacity.adapter.submit(request)),
  );
  const capacityDeniedIndex = capacityResults.findIndex((result) => result.status === "rejected");
  const capacityWinnerIndex = capacityResults.findIndex((result) => result.status === "fulfilled");
  const capacityDeniedRequest = capacityRequests[capacityDeniedIndex]!;
  const capacityWinnerRequest = capacityRequests[capacityWinnerIndex]!;
  const capacityStoreText = durableStoreText(capacityRoot);
  const capacityContext = JSON.parse([...capacityPolicy.slots.values()][0]!.context) as {
    recordBytesUpperBound?: number;
  };
  ok(capacityResults.filter((result) => result.status === "fulfilled").length === 2
    && capacityResults.filter((result) => result.status === "rejected").length === 1
    && capacityRaw.prepareCalls === 2 && capacityRaw.submitCalls === 2
    && capacityPolicy.activeSlots === 2 && capacityPolicy.committedSlots === 2
    && capacityPolicy.slots.size === 2
    && !capacityStoreText.includes(capacityDeniedRequest.remoteJobId)
    && capacityContext.recordBytesUpperBound === storageRecordBound
    && Number.isSafeInteger(capacityContext.recordBytesUpperBound),
  "per-scope job+byte cap=2 并发3个unique intent仅2个产生store/raw prepare；server计算有限record upper bound");
  const capacityAcquireCallsBeforeReplay = capacityPolicy.acquiredKeys.length;
  await capacity.adapter.submit(capacityWinnerRequest);
  const capacityDrift = await captureAdapterError(() => capacity.adapter.submit({
    ...capacityWinnerRequest,
    remoteJobId: "storage-cap-drifted-remote",
  }));
  ok(capacityPolicy.activeSlots === 2 && capacityPolicy.slots.size === 2
    && capacityPolicy.acquiredKeys.length === capacityAcquireCallsBeforeReplay
    && capacityRaw.prepareCalls === 2 && capacityRaw.submitCalls === 2
    && capacityDrift?.code === "remote-rejected",
  "cap满时 exact replay复用既有job且slot不变；same intent/new remote在policy前conflict且不多占slot");
  capacity.gateway.close();

  const slotCrashPolicy = new DurableTestStorageAdmissionPolicy({ perScopeJobs: 1, globalJobs: 1 });
  const slotCrashRoot = root();
  const slotCrashRaw = new FakeRawAdapter();
  const slotCrash = await harness({
    storeRoot: slotCrashRoot,
    raw: slotCrashRaw,
    storageAdmissionPolicy: slotCrashPolicy,
    hooks: { afterStorageAdmission: () => { throw new Error("crash-after-storage-slot"); } },
  });
  const slotCrashPrepared = slotCrash.adapter.prepareSubmission(submitRequest());
  const slotCrashError = await captureAdapterError(() => slotCrash.adapter.submitPrepared(slotCrashPrepared));
  ok(slotCrashError?.code === "submission-unknown" && durableStoreFiles(slotCrashRoot).length === 0
    && slotCrashPolicy.activeSlots === 1 && slotCrashPolicy.committedSlots === 0
    && slotCrashRaw.prepareCalls === 0 && slotCrashRaw.submitCalls === 0,
  "storage slot allow后、首record前crash保持pending且store/raw零副作用");
  slotCrash.gateway.close();
  const slotCrashRestart = await harness({
    storeRoot: slotCrashRoot,
    raw: slotCrashRaw,
    storageAdmissionPolicy: slotCrashPolicy,
  });
  await slotCrashRestart.adapter.submitPrepared(slotCrashPrepared);
  ok(slotCrashPolicy.activeSlots === 1 && slotCrashPolicy.committedSlots === 1
    && slotCrashPolicy.acquiredKeys.length === 2
    && slotCrashPolicy.acquiredKeys[0] === slotCrashPolicy.acquiredKeys[1]
    && slotCrashRaw.prepareCalls === 1 && slotCrashRaw.submitCalls === 1,
  "slot-before-binding crash经重启以同storageKey/context幂等重放，不重复计数");
  slotCrashRestart.gateway.close();

  const invalidReceiptStorage = new DurableTestStorageAdmissionPolicy();
  const invalidReceiptRoot = root();
  const invalidReceiptRaw = new FakeRawAdapter();
  const invalidReceipt = await harness({
    storeRoot: invalidReceiptRoot,
    raw: invalidReceiptRaw,
    profile: STAGED_PROFILE,
    storageAdmissionPolicy: invalidReceiptStorage,
    stageReceiptRegistry: { verifyStageReceipt: async () => null },
  });
  const invalidReceiptError = await captureAdapterError(
    () => invalidReceipt.adapter.submit(stagedSubmitRequest()),
  );
  ok(invalidReceiptError?.code === "remote-rejected"
    && invalidReceiptStorage.acquiredKeys.length === 0
    && durableStoreFiles(invalidReceiptRoot).length === 0
    && invalidReceiptRaw.prepareCalls === 0 && invalidReceiptRaw.submitCalls === 0,
  "无效profile/stage receipt在storage acquire与任何store/raw副作用前拒绝");
  invalidReceipt.gateway.close();

  const globalStoragePolicy = new DurableTestStorageAdmissionPolicy({
    perScopeJobs: 2,
    perScopeBytes: storageRecordBound * 2,
    globalJobs: 3,
    globalBytes: storageRecordBound * 3,
  });
  const globalRawA = new FakeRawAdapter();
  const globalRawB = new FakeRawAdapter();
  const globalA = await harness({
    scope: SCOPE_A, raw: globalRawA, storageAdmissionPolicy: globalStoragePolicy,
  });
  const globalB = await harness({
    scope: SCOPE_B, raw: globalRawB, storageAdmissionPolicy: globalStoragePolicy,
  });
  await globalA.adapter.submit({
    ...submitRequest(), idempotencyKey: "global-a-1", remoteJobId: "global-a-job-1",
  });
  await globalA.adapter.submit({
    ...submitRequest(), idempotencyKey: "global-a-2", remoteJobId: "global-a-job-2",
  });
  await globalB.adapter.submit({
    ...submitRequest(), idempotencyKey: "global-b-1", remoteJobId: "global-b-job-1",
  });
  const globalDenied = await captureAdapterError(() => globalB.adapter.submit({
    ...submitRequest(), idempotencyKey: "global-b-2", remoteJobId: "global-b-job-2",
  }));
  const scopeCounts = [...globalStoragePolicy.slots.values()]
    .filter((slot) => slot.state !== "released")
    .reduce((counts, slot) => counts.set(slot.scope, (counts.get(slot.scope) ?? 0) + 1), new Map<string, number>());
  ok(globalDenied?.code === "remote-rejected" && globalStoragePolicy.activeSlots === 3
    && globalStoragePolicy.committedSlots === 3
    && scopeCounts.get(JSON.stringify(SCOPE_A)) === 2
    && scopeCounts.get(JSON.stringify(SCOPE_B)) === 1
    && globalRawA.prepareCalls === 2 && globalRawB.prepareCalls === 1,
  "shared durable policy同时隔离per-scope job/byte cap并实施跨gateway global job/byte cap");
  globalA.gateway.close();
  globalB.gateway.close();

  const commitLossBase = new DurableTestStorageAdmissionPolicy({ perScopeJobs: 1, globalJobs: 1 });
  let loseFirstCommitResponse = true;
  const commitLossPolicy: ProductionJobStorageAdmissionPolicy = {
    acquire: (context, key) => commitLossBase.acquire(context, key),
    commit: (context, key, recordRef) => {
      commitLossBase.commit(context, key, recordRef);
      if (loseFirstCommitResponse) {
        loseFirstCommitResponse = false;
        throw new Error("storage commit response lost SECRET");
      }
    },
    release: (context, key, reason) => commitLossBase.release(context, key, reason),
  };
  const commitLossRoot = root();
  const commitLossRaw = new FakeRawAdapter();
  const commitLost = await harness({
    storeRoot: commitLossRoot,
    raw: commitLossRaw,
    storageAdmissionPolicy: commitLossPolicy,
  });
  const commitLossPrepared = commitLost.adapter.prepareSubmission(submitRequest());
  const commitLossError = await captureAdapterError(() => commitLost.adapter.submitPrepared(commitLossPrepared));
  ok(commitLossError?.code === "submission-unknown" && commitLossBase.activeSlots === 1
    && commitLossBase.committedSlots === 1 && commitLossBase.committedKeys.length === 1
    && durableStoreFiles(commitLossRoot).length === 1
    && commitLossRaw.prepareCalls === 0 && commitLossRaw.submitCalls === 0,
  "首record后storage commit response-loss停止在global binding，不release committed slot且零raw");
  commitLost.gateway.close();
  const commitRecovered = await harness({
    storeRoot: commitLossRoot,
    raw: commitLossRaw,
    storageAdmissionPolicy: commitLossPolicy,
  });
  await commitRecovered.adapter.submitPrepared(commitLossPrepared);
  ok(commitLossBase.activeSlots === 1 && commitLossBase.committedSlots === 1
    && commitLossBase.acquiredKeys.length === 2 && commitLossBase.committedKeys.length === 2
    && commitLossBase.acquiredKeys[0] === commitLossBase.acquiredKeys[1]
    && commitLossRaw.prepareCalls === 1 && commitLossRaw.submitCalls === 1,
  "storage commit response-loss经重启 exact acquire+commit重放，recordRef/slot不漂移且raw仅一次");
  commitRecovered.gateway.close();

  const releaseLossBase = new DurableTestStorageAdmissionPolicy({ perScopeJobs: 2, globalJobs: 2 });
  let loseFirstReleaseResponse = true;
  const releaseLossPolicy: ProductionJobStorageAdmissionPolicy = {
    acquire: (context, key) => releaseLossBase.acquire(context, key),
    commit: (context, key, recordRef) => releaseLossBase.commit(context, key, recordRef),
    release: (context, key, reason) => {
      const decision = releaseLossBase.release(context, key, reason);
      if (loseFirstReleaseResponse) {
        loseFirstReleaseResponse = false;
        throw new Error("storage release response lost SECRET");
      }
      return decision;
    },
  };
  let storageAdmissions = 0;
  let openStorageAdmissions!: () => void;
  const storageAdmissionGate = new Promise<void>((resolvePromise) => { openStorageAdmissions = resolvePromise; });
  const releaseLossRaw = new FakeRawAdapter();
  const releaseLoss = await harness({
    raw: releaseLossRaw,
    storageAdmissionPolicy: releaseLossPolicy,
    hooks: {
      afterStorageAdmission: async () => {
        storageAdmissions++;
        await storageAdmissionGate;
      },
    },
  });
  const sharedRemoteA = {
    ...submitRequest(), idempotencyKey: "storage-remote-race-a", remoteJobId: "storage-shared-remote",
  };
  const sharedRemoteB = { ...sharedRemoteA, idempotencyKey: "storage-remote-race-b" };
  const storageRacePromises = [sharedRemoteA, sharedRemoteB]
    .map((request) => captureAdapterError(() => releaseLoss.adapter.submit(request)));
  await waitUntil(() => storageAdmissions === 2);
  openStorageAdmissions();
  const storageRaceErrors = await Promise.all(storageRacePromises);
  const releasedRequest = storageRaceErrors[0] === null ? sharedRemoteB : sharedRemoteA;
  ok(storageRaceErrors.filter((error) => error === null).length === 1
    && storageRaceErrors.filter((error) => error?.code === "submission-unknown").length === 1
    && releaseLossBase.activeSlots === 1 && releaseLossBase.committedSlots === 1
    && releaseLossBase.releasedSlots === 1 && releaseLossBase.slots.size === 2
    && releaseLossRaw.prepareCalls === 1 && releaseLossRaw.submitCalls === 1,
  "different intent并发抢同remote时allowed=2/committed=1/released=1；release response-loss不触发raw loser");
  const releasedReplay = await captureAdapterError(() => releaseLoss.adapter.submit(releasedRequest));
  const releasedRemoteDrift = await captureAdapterError(() => releaseLoss.adapter.submit({
    ...releasedRequest, remoteJobId: "storage-released-new-remote",
  }));
  const storageSlotsBeforeUnknownRelease = releaseLossBase.slots.size;
  const freshRemoteConflict = await captureAdapterError(() => releaseLoss.adapter.submit({
    ...submitRequest(), idempotencyKey: "storage-fresh-conflict", remoteJobId: "storage-shared-remote",
  }));
  ok(releasedReplay?.code === "remote-rejected" && releasedRemoteDrift?.code === "remote-rejected"
    && freshRemoteConflict?.code === "remote-rejected"
    && releaseLossBase.releasedKeys.length === 3
    && releaseLossBase.slots.size === storageSlotsBeforeUnknownRelease
    && releaseLossBase.activeSlots === 1,
  "release response-loss exact replay幂等；released intent漂移不重占；fresh conflict对unknown release为no-op后仍409");
  await releaseLoss.adapter.submit({
    ...submitRequest(), idempotencyKey: "storage-cap-recovered", remoteJobId: "storage-cap-recovered-job",
  });
  const slotsBeforeOccupiedDrift = releaseLossBase.slots.size;
  const releasedOccupiedDrift = await captureAdapterError(() => releaseLoss.adapter.submit({
    ...releasedRequest, remoteJobId: "storage-cap-recovered-job",
  }));
  ok(releaseLossBase.activeSlots === 2 && releaseLossBase.committedSlots === 2
    && releaseLossBase.releasedSlots === 1 && releaseLossBase.slots.size === slotsBeforeOccupiedDrift
    && releasedOccupiedDrift?.code === "remote-rejected" && releaseLossRaw.submitCalls === 2,
  "loser release后配额可恢复；released intent漂移到已占remote仍409，committed slot从不release");
  releaseLoss.gateway.close();

  const mutationRaw = new FakeRawAdapter();
  const mutationGuard = await harness({
    raw: mutationRaw,
    validator: (_scope, profile) => {
      const node = profile.workflow["10"] as { inputs: { frames: number } };
      node.inputs.frames = 999;
      return true;
    },
  });
  const mutationError = await captureAdapterError(() => mutationGuard.adapter.submit(submitRequest()));
  ok(mutationError?.code === "remote-rejected"
    && mutationRaw.prepareCalls === 0 && mutationRaw.submitCalls === 0,
  "server profile graph 先 detached+deep-freeze；validator 不能在 digest 校验后漂移 raw workflow");
  mutationGuard.gateway.close();

  const admissionOrder: string[] = [];
  const admissionContexts: unknown[] = [];
  const admissionOutcomes: unknown[] = [];
  const admissionKeys: string[] = [];
  const admissionRaw = new FakeRawAdapter();
  admissionRaw.onSubmit = () => admissionOrder.push("raw-submit");
  const admitted = await harness({
    raw: admissionRaw,
    hooks: { afterAttemptDurable: () => { admissionOrder.push("attempt-durable"); } },
    admissionPolicy: {
      acquire: (context, admissionKey) => {
        admissionOrder.push("permit-acquired");
        admissionContexts.push(context);
        admissionKeys.push(admissionKey);
        return "allow";
      },
      settle: (_context, admissionKey, outcome) => {
        admissionOrder.push("permit-settled");
        admissionKeys.push(admissionKey);
        admissionOutcomes.push(outcome);
      },
    },
  });
  await admitted.adapter.submit(submitRequest());
  const admissionContextText = JSON.stringify(admissionContexts[0]);
  const admissionContext = admissionContexts[0] as { profile?: Record<string, unknown> } | undefined;
  const admissionOutcome = admissionOutcomes[0] as { state?: string } | undefined;
  ok(admissionOrder.join(",") === "permit-acquired,attempt-durable,raw-submit,permit-settled"
    && admissionOutcome?.state === "submitted"
    && admissionKeys.length === 2 && admissionKeys[0] === admissionKeys[1]
    && /^[a-f0-9]{64}$/.test(admissionKeys[0] ?? "")
    && admissionContextText.includes(SCOPE_A.workspaceId)
    && admissionContextText.includes(PROFILE_ID)
    && !Object.prototype.hasOwnProperty.call(admissionContext?.profile ?? {}, "workflow")
    && !admissionContextText.includes("source_url"),
  "stable admissionKey 在 durable decision 后保护唯一 raw submit，并以同 key 脱敏 settle");
  admitted.gateway.close();

  let deniedAdmissionCalls = 0;
  const deniedRaw = new FakeRawAdapter();
  const deniedRoot = root();
  const denied = await harness({
    storeRoot: deniedRoot,
    raw: deniedRaw,
    admissionPolicy: {
      acquire: () => { deniedAdmissionCalls++; return "deny"; },
      settle: () => { throw new Error("deny must not settle"); },
    },
  });
  const deniedPrepared = denied.adapter.prepareSubmission(submitRequest());
  const deniedFirst = await captureAdapterError(() => denied.adapter.submitPrepared(deniedPrepared));
  const deniedReplay = await captureAdapterError(() => denied.adapter.submitPrepared(deniedPrepared));
  ok(deniedFirst?.code === "remote-rejected" && deniedReplay?.code === "remote-rejected"
    && deniedAdmissionCalls === 1 && deniedRaw.prepareCalls === 1
    && deniedRaw.submitCalls === 0 && deniedRaw.inspectCalls === 0
    && !durableStoreText(deniedRoot).includes("must-not-cross")
    && !durableStoreText(deniedRoot).includes("model.safetensors"),
  "admission deny 持久 fail-closed；exact replay 不再 acquire且小型记录不落盘 workflow/canary");
  denied.gateway.close();

  const unavailablePolicyRaw = new FakeRawAdapter();
  const unavailablePolicy = await harness({
    raw: unavailablePolicyRaw,
    admissionPolicy: {
      acquire: () => { throw new Error("quota-store-secret"); },
      settle: () => undefined,
    },
  });
  const unavailablePolicyError = await captureAdapterError(
    () => unavailablePolicy.adapter.submit(submitRequest()),
  );
  ok(unavailablePolicyError?.code === "submission-unknown"
    && !unavailablePolicyError.message.includes("quota-store-secret")
    && unavailablePolicyRaw.submitCalls === 0 && unavailablePolicyRaw.inspectCalls === 0,
  "admission authority 不可用时返回可恢复 unknown，脱敏且零 raw I/O");
  unavailablePolicy.gateway.close();

  // Acquire response loss: the durable request survives, and restart/concurrent exact replays use
  // the same authority key. Only the raw-attempt O_EXCL winner may reach the provider.
  const acquireRecoveryRoot = root();
  const acquireRecoveryRaw = new FakeRawAdapter();
  let acquireRecoveryCalls = 0;
  let acquireRecoverySettles = 0;
  const acquiredKeys: string[] = [];
  let releaseRecoveredAcquire!: () => void;
  const recoveredAcquireGate = new Promise<void>((resolvePromise) => { releaseRecoveredAcquire = resolvePromise; });
  const recoverableAcquirePolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: async (_context, admissionKey) => {
      acquireRecoveryCalls++;
      acquiredKeys.push(admissionKey);
      if (acquireRecoveryCalls === 1) {
        // Simulate the durable authority committing allow while its response is lost.
        throw new Error("acquire response lost SECRET");
      }
      await recoveredAcquireGate;
      return "allow" as const;
    },
    settle: (_context, admissionKey) => {
      acquireRecoverySettles++;
      if (admissionKey !== acquiredKeys[0]) throw new Error("key drift");
    },
  };
  const acquireLost = await harness({
    storeRoot: acquireRecoveryRoot,
    raw: acquireRecoveryRaw,
    admissionPolicy: recoverableAcquirePolicy,
  });
  const acquireLostPrepared = acquireLost.adapter.prepareSubmission(submitRequest());
  const acquireLostError = await captureAdapterError(
    () => acquireLost.adapter.submitPrepared(acquireLostPrepared),
  );
  acquireLost.gateway.close();
  const acquireRecovered = await harness({
    storeRoot: acquireRecoveryRoot,
    raw: acquireRecoveryRaw,
    admissionPolicy: recoverableAcquirePolicy,
  });
  const concurrentAcquireRecovery = [
    acquireRecovered.adapter.submitPrepared(acquireLostPrepared),
    acquireRecovered.adapter.submitPrepared(acquireLostPrepared),
  ];
  releaseRecoveredAcquire();
  const acquireRecoveryResults = await Promise.allSettled(concurrentAcquireRecovery);
  ok(acquireLostError?.code === "submission-unknown"
    && acquireRecoveryCalls === 2 && acquiredKeys.length === 2 && acquiredKeys[0] === acquiredKeys[1]
    && acquireRecoveryRaw.submitCalls === 1 && acquireRecoverySettles === 1
    && acquireRecoveryResults.some((result) => result.status === "fulfilled"),
  "acquire response-lost 经重启/并发 exact replay 仅以同 admissionKey 恢复，raw/acquire authority 各一次语义");
  acquireRecovered.gateway.close();

  // Settlement response loss: raw outcome and pending outbox are durable before policy.settle.
  // Restart replays only the idempotent settlement, never acquire or raw submit.
  const settleRestartRoot = root();
  const settleRestartRaw = new FakeRawAdapter();
  let settleRestartAcquireCalls = 0;
  let settleRestartCalls = 0;
  const settleRestartKeys: string[] = [];
  const settleRestartPolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: (_context, admissionKey) => {
      settleRestartAcquireCalls++;
      settleRestartKeys.push(admissionKey);
      return "allow";
    },
    settle: (_context, admissionKey) => {
      settleRestartCalls++;
      settleRestartKeys.push(admissionKey);
      if (settleRestartCalls === 1) throw new Error("settle response lost SECRET");
    },
  };
  const settleLost = await harness({
    storeRoot: settleRestartRoot,
    raw: settleRestartRaw,
    admissionPolicy: settleRestartPolicy,
  });
  const settleLostPrepared = settleLost.adapter.prepareSubmission(submitRequest());
  const settleLostError = await captureAdapterError(() => settleLost.adapter.submitPrepared(settleLostPrepared));
  settleLost.gateway.close();
  const settleRestarted = await harness({
    storeRoot: settleRestartRoot,
    raw: settleRestartRaw,
    admissionPolicy: settleRestartPolicy,
  });
  const settleRecoveredResult = await settleRestarted.adapter.submitPrepared(settleLostPrepared);
  ok(settleLostError?.code === "submission-unknown" && settleRecoveredResult.remoteJobId === REMOTE_ID
    && settleRestartAcquireCalls === 1 && settleRestartCalls === 2
    && settleRestartRaw.submitCalls === 1 && settleRestartRaw.prepareCalls === 1
    && settleRestartKeys.every((key) => key === settleRestartKeys[0]),
  "settle 首次 response-lost 后重启 exact replay 收敛 pending→ack：raw=1/acquire=1/settle=2");
  settleRestarted.gateway.close();

  // Concurrent exact replays share one in-process settlement flight while the durable authority
  // remains the cross-process idempotency boundary.
  const settleConcurrentRaw = new FakeRawAdapter();
  let settleConcurrentAcquireCalls = 0;
  let settleConcurrentCalls = 0;
  let releaseSettlement!: () => void;
  const settlementGate = new Promise<void>((resolvePromise) => { releaseSettlement = resolvePromise; });
  let markSettlementStarted!: () => void;
  const settlementStarted = new Promise<void>((resolvePromise) => { markSettlementStarted = resolvePromise; });
  const settleConcurrent = await harness({
    raw: settleConcurrentRaw,
    admissionPolicy: {
      acquire: () => { settleConcurrentAcquireCalls++; return "allow"; },
      settle: async () => {
        settleConcurrentCalls++;
        if (settleConcurrentCalls === 1) throw new Error("first settle response lost");
        markSettlementStarted();
        await settlementGate;
      },
    },
  });
  const settleConcurrentPrepared = settleConcurrent.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => settleConcurrent.adapter.submitPrepared(settleConcurrentPrepared));
  const settlementReplayA = settleConcurrent.adapter.submitPrepared(settleConcurrentPrepared);
  await settlementStarted;
  const settlementReplayB = settleConcurrent.adapter.submitPrepared(settleConcurrentPrepared);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  releaseSettlement();
  const settlementReplayResults = await Promise.allSettled([settlementReplayA, settlementReplayB]);
  ok(settlementReplayResults.every((result) => result.status === "fulfilled")
    && settleConcurrentAcquireCalls === 1 && settleConcurrentCalls === 2
    && settleConcurrentRaw.submitCalls === 1 && settleConcurrentRaw.prepareCalls === 1,
  "并发 exact replay 单飞同一 pending settlement，不重复 acquire/raw/settle authority 调用");
  settleConcurrent.gateway.close();

  const inspectBefore = happy.raw.inspectCalls;
  const replay = await happy.adapter.submitPrepared(prepared);
  ok(replay.responseDigest === submitted.responseDigest && happy.raw.submitCalls === 1
    && happy.raw.prepareCalls === 1 && happy.raw.inspectCalls === inspectBefore + 1,
  "exact PUT replay 只 inspect 预分配 ID 并复用 durable result，绝不 raw re-POST");

  const driftBody: ProductionJobPutRequest = {
    ...sentBody,
    idempotencyKey: "idem-drift",
  };
  const driftDigest = productionJobPutRequestDigest(driftBody);
  const drift = await happy.gateway.handle(new Request(sent.url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${TOKEN_A}`,
      "content-type": "application/json",
      "x-writing-loop-idempotency-key": driftBody.idempotencyKey,
      "x-writing-loop-request-digest": driftDigest,
    },
    body: JSON.stringify(driftBody),
  }));
  ok(drift.status === 409 && happy.raw.submitCalls === 1,
    "同 scope/remote ID 的 body drift 返回 409，不访问 raw adapter");

  // A durable request without a raw-attempt claim can be recovered safely after restart.
  const durableRoot = root();
  const durableRaw = new FakeRawAdapter();
  const failed = await harness({
    storeRoot: durableRoot,
    raw: durableRaw,
    hooks: { afterJobDurable: () => { throw new Error("simulated-crash-after-durable"); } },
  });
  const durablePrepared = failed.adapter.prepareSubmission(submitRequest());
  const firstFailure = await captureAdapterError(() => failed.adapter.submitPrepared(durablePrepared));
  ok(firstFailure?.code === "submission-unknown" && durableRaw.prepareCalls === 0 && durableRaw.submitCalls === 0,
    "durable request failpoint 发生在 raw prepare/submit 前，客户端只得到 submission-unknown");
  failed.gateway.close();
  const restarted = await harness({ storeRoot: durableRoot, raw: durableRaw });
  const restartResult = await restarted.adapter.submitPrepared(durablePrepared);
  ok(restartResult.remoteJobId === REMOTE_ID && durableRaw.prepareCalls === 1
    && durableRaw.submitCalls === 1 && durableRaw.inspectCalls === 1,
  "进程重启后可凭 raw-attempt marker 缺失证明未提交，并安全完成唯一一次 POST");

  const attemptRoot = root();
  const attemptRaw = new FakeRawAdapter();
  const attemptFailed = await harness({
    storeRoot: attemptRoot,
    raw: attemptRaw,
    hooks: { afterAttemptDurable: () => { throw new Error("simulated-crash-before-submit"); } },
  });
  const attemptPrepared = attemptFailed.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => attemptFailed.adapter.submitPrepared(attemptPrepared));
  attemptFailed.gateway.close();
  const attemptRestart = await harness({ storeRoot: attemptRoot, raw: attemptRaw });
  await attemptRestart.adapter.submitPrepared(attemptPrepared);
  const attemptFile = durableStoreFiles(attemptRoot).find((path) => path.endsWith("/attempt.json"));
  const attemptText = attemptFile ? readFileSync(attemptFile, "utf8") : "";
  const attemptValue = attemptText ? JSON.parse(attemptText) as Record<string, unknown> : {};
  ok(attemptRaw.prepareCalls === 2 && attemptRaw.submitCalls === 1 && attemptRaw.inspectCalls === 1
    && Buffer.byteLength(attemptText) < 1_024
    && Object.keys(attemptValue).sort().join(",")
      === "backendInstanceId,idempotencyKey,providerRequestDigest,recordedAt,remoteJobId,requestDigest,version"
    && !attemptText.includes("workflow") && !attemptText.includes("source_url")
    && !attemptText.includes("model.safetensors"),
  "attempt 固定为<1KiB摘要/identity元数据且无workflow/source_url；重启重建graph后仍只POST一次");

  const digestDriftRoot = root();
  const digestDriftInitialRaw = new FakeRawAdapter();
  let digestDriftAcquireCalls = 0;
  let digestDriftSettleCalls = 0;
  const digestDriftOutcomes: string[] = [];
  const digestDriftPolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: () => { digestDriftAcquireCalls++; return "allow"; },
    settle: (_context, _key, outcome) => {
      digestDriftSettleCalls++;
      digestDriftOutcomes.push(`${outcome.state}/${outcome.errorCode}`);
    },
  };
  const digestDriftCrash = await harness({
    storeRoot: digestDriftRoot,
    raw: digestDriftInitialRaw,
    admissionPolicy: digestDriftPolicy,
    hooks: { afterAttemptDurable: () => { throw new Error("upgrade-after-prepared-attempt"); } },
  });
  const digestDriftPrepared = digestDriftCrash.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => digestDriftCrash.adapter.submitPrepared(digestDriftPrepared));
  digestDriftCrash.gateway.close();
  const digestDriftRestartRaw = new FakeRawAdapter();
  digestDriftRestartRaw.requestDigestSalt = "new-adapter-provider-shape";
  const digestDriftRestart = await harness({
    storeRoot: digestDriftRoot,
    raw: digestDriftRestartRaw,
    admissionPolicy: digestDriftPolicy,
  });
  const digestDriftFirstReplay = await captureAdapterError(
    () => digestDriftRestart.adapter.submitPrepared(digestDriftPrepared),
  );
  const digestDriftSecondReplay = await captureAdapterError(
    () => digestDriftRestart.adapter.submitPrepared(digestDriftPrepared),
  );
  ok(digestDriftFirstReplay?.code === "submission-unknown"
    && digestDriftSecondReplay?.code === "submission-unknown"
    && digestDriftAcquireCalls === 1 && digestDriftSettleCalls === 1
    && digestDriftOutcomes.join(",") === "not-submitted/internal"
    && digestDriftInitialRaw.submitCalls === 0 && digestDriftRestartRaw.submitCalls === 0
    && digestDriftRestartRaw.prepareCalls === 1 && digestDriftRestartRaw.inspectCalls === 0,
  "prepared provider digest 在重启升级后漂移时持久 not-submitted/internal 并 settle；后续不 reacquire/raw I/O");
  digestDriftRestart.gateway.close();

  const preAdmissionRoot = root();
  const preAdmissionRaw = new FakeRawAdapter();
  let preAdmissionAcquireCalls = 0;
  let preAdmissionSettleCalls = 0;
  const preAdmissionPolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: () => { preAdmissionAcquireCalls++; return "allow"; },
    settle: () => { preAdmissionSettleCalls++; },
  };
  const preAdmissionCrash = await harness({
    storeRoot: preAdmissionRoot,
    raw: preAdmissionRaw,
    admissionPolicy: preAdmissionPolicy,
    hooks: { afterJobDurable: () => { throw new Error("crash-before-admission"); } },
  });
  const preAdmissionPrepared = preAdmissionCrash.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => preAdmissionCrash.adapter.submitPrepared(preAdmissionPrepared));
  preAdmissionCrash.gateway.close();
  const preAdmissionUnavailable = await harness({
    storeRoot: preAdmissionRoot,
    raw: preAdmissionRaw,
    admissionPolicy: preAdmissionPolicy,
    validator: () => { throw new Error("registry unavailable"); },
  });
  const preAdmissionUnavailableError = await captureAdapterError(
    () => preAdmissionUnavailable.adapter.submitPrepared(preAdmissionPrepared),
  );
  ok(preAdmissionUnavailableError?.code === "remote-rejected"
    && preAdmissionAcquireCalls === 0 && preAdmissionSettleCalls === 0
    && preAdmissionRaw.prepareCalls === 0 && preAdmissionRaw.submitCalls === 0,
  "job durable 后崩溃且 trusted profile 恢复失败时，validation 在 admission 前 fail-closed");
  preAdmissionUnavailable.gateway.close();

  const allowedPreRawRoot = root();
  const allowedPreRawRaw = new FakeRawAdapter();
  let allowedPreRawAcquireCalls = 0;
  let allowedPreRawSettleCalls = 0;
  const allowedPreRawPolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: () => { allowedPreRawAcquireCalls++; return "allow"; },
    settle: (_context, _key, outcome) => {
      allowedPreRawSettleCalls++;
      if (outcome.state !== "not-submitted") throw new Error("pre-raw outcome drift");
    },
  };
  const allowedPreRawCrash = await harness({
    storeRoot: allowedPreRawRoot,
    raw: allowedPreRawRaw,
    admissionPolicy: allowedPreRawPolicy,
    hooks: { afterAttemptDurable: () => { throw new Error("crash-after-allow-before-raw-claim"); } },
  });
  const allowedPreRawPrepared = allowedPreRawCrash.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => allowedPreRawCrash.adapter.submitPrepared(allowedPreRawPrepared));
  allowedPreRawCrash.gateway.close();
  const allowedPreRawUnavailable = await harness({
    storeRoot: allowedPreRawRoot,
    raw: allowedPreRawRaw,
    admissionPolicy: allowedPreRawPolicy,
    validator: () => { throw new Error("registry unavailable after allow"); },
  });
  const allowedPreRawError = await captureAdapterError(
    () => allowedPreRawUnavailable.adapter.submitPrepared(allowedPreRawPrepared),
  );
  ok(allowedPreRawError?.code === "submission-unknown"
    && allowedPreRawAcquireCalls === 1 && allowedPreRawSettleCalls === 1
    && allowedPreRawRaw.prepareCalls === 1 && allowedPreRawRaw.submitCalls === 0,
  "durable allow 后 pre-raw trusted validation 失败会持久 not-submitted 并 settle，不泄漏 reservation");
  allowedPreRawUnavailable.gateway.close();

  const rawClaimRoot = root();
  const rawClaimRaw = new FakeRawAdapter();
  let rawClaimNow = new Date(at(0));
  let rawClaimAcquireCalls = 0;
  let rawClaimSettleCalls = 0;
  const rawClaimPolicy: ProductionJobGatewayOptions["submissionAdmissionPolicy"] = {
    acquire: () => { rawClaimAcquireCalls++; return "allow"; },
    settle: (_context, _key, outcome) => {
      rawClaimSettleCalls++;
      if (outcome.state !== "submission-unknown") throw new Error("unsafe recovery outcome");
    },
  };
  const rawClaimCrash = await harness({
    storeRoot: rawClaimRoot,
    raw: rawClaimRaw,
    admissionPolicy: rawClaimPolicy,
    now: () => rawClaimNow,
    hooks: { afterRawAttemptDurable: () => { throw new Error("crash-after-raw-attempt-claim"); } },
  });
  const rawClaimPrepared = rawClaimCrash.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => rawClaimCrash.adapter.submitPrepared(rawClaimPrepared));
  rawClaimCrash.gateway.close();
  rawClaimNow = new Date(at(31));
  const rawClaimRecovered = await harness({
    storeRoot: rawClaimRoot,
    raw: rawClaimRaw,
    admissionPolicy: rawClaimPolicy,
    now: () => rawClaimNow,
    validator: () => { throw new Error("must not resolve after raw claim"); },
  });
  const rawClaimRecoveryError = await captureAdapterError(
    () => rawClaimRecovered.adapter.submitPrepared(rawClaimPrepared),
  );
  await captureAdapterError(() => rawClaimRecovered.adapter.submitPrepared(rawClaimPrepared));
  ok(rawClaimRecoveryError?.code === "submission-unknown"
    && rawClaimAcquireCalls === 1 && rawClaimSettleCalls === 1
    && rawClaimRaw.submitCalls === 0 && rawClaimRaw.prepareCalls === 1,
  "raw-attempt claim 后崩溃经绝对 deadline 持久 unknown 并 settle；重启绝不猜测性二次 POST");
  rawClaimRecovered.gateway.close();

  const outcomeRaceRoot = root();
  const outcomeRaceRaw = new FakeRawAdapter();
  let outcomeRaceNow = new Date(at(0));
  let outcomeRaceSettleCalls = 0;
  const settledRaceStates: string[] = [];
  let rawResultReady!: () => void;
  const rawResultReached = new Promise<void>((resolvePromise) => { rawResultReady = resolvePromise; });
  let releaseRawResult!: () => void;
  const rawResultGate = new Promise<void>((resolvePromise) => { releaseRawResult = resolvePromise; });
  const outcomeRace = await harness({
    storeRoot: outcomeRaceRoot,
    raw: outcomeRaceRaw,
    now: () => outcomeRaceNow,
    admissionPolicy: {
      acquire: () => "allow",
      settle: (_context, _key, outcome) => {
        outcomeRaceSettleCalls++;
        settledRaceStates.push(outcome.state);
      },
    },
    hooks: {
      afterRawSubmit: async () => {
        rawResultReady();
        await rawResultGate;
      },
    },
  });
  const outcomeRacePrepared = outcomeRace.adapter.prepareSubmission(submitRequest());
  const rawOwner = captureAdapterError(() => outcomeRace.adapter.submitPrepared(outcomeRacePrepared));
  await rawResultReached;
  outcomeRaceNow = new Date(at(31));
  const recoveryWinner = await captureAdapterError(
    () => outcomeRace.adapter.submitPrepared(outcomeRacePrepared),
  );
  releaseRawResult();
  const rawOwnerResult = await rawOwner;
  const outcomeFiles = durableStoreFiles(outcomeRaceRoot);
  ok(recoveryWinner?.code === "submission-unknown" && rawOwnerResult?.code === "submission-unknown"
    && outcomeRaceRaw.submitCalls === 1 && outcomeRaceSettleCalls === 1
    && settledRaceStates.join(",") === "submission-unknown"
    && outcomeFiles.filter((path) => path.endsWith("/outcome.json")).length === 1
    && !outcomeFiles.some((path) => path.endsWith("/result.json") || path.endsWith("/error.json")),
  "raw success 与 deadline recovery 竞态通过单 outcome.json first-wins，settlement 永远读取同一 tagged outcome");
  outcomeRace.gateway.close();

  // Raw ambiguity and client-side response loss both preserve at-most-once.
  const ambiguousRaw = new FakeRawAdapter();
  ambiguousRaw.submitError = new ProductionAdapterError("submission-unknown", "secret raw response lost");
  ambiguousRaw.onSubmit = () => { ambiguousRaw.state = "running"; };
  const ambiguousRoot = root();
  const ambiguous = await harness({ storeRoot: ambiguousRoot, raw: ambiguousRaw });
  const ambiguousPrepared = ambiguous.adapter.prepareSubmission(submitRequest());
  const ambiguousError = await captureAdapterError(() => ambiguous.adapter.submitPrepared(ambiguousPrepared));
  const ambiguousReplay = await captureAdapterError(() => ambiguous.adapter.submitPrepared(ambiguousPrepared));
  ok(ambiguousError?.code === "submission-unknown" && ambiguousReplay?.code === "submission-unknown"
    && ambiguousRaw.submitCalls === 1 && ambiguousRaw.inspectCalls === 2
    && !durableStoreText(ambiguousRoot).includes("must-not-cross")
    && !durableStoreText(ambiguousRoot).includes("model.safetensors"),
  "raw submit ambiguity 的 durable unknown/attempt 均为小型元数据，exact retry 只增加 inspectCalls");

  const lossRaw = new FakeRawAdapter();
  const loss = await harness({ raw: lossRaw });
  let lostOnce = false;
  const lossAdapter = loss.setClientFetch(async (input, init = {}) => {
    const response = await loss.gateway.handle(new Request(String(input), init));
    if (!lostOnce) {
      lostOnce = true;
      void response.body?.cancel();
      throw new TypeError("simulated client response loss SECRET");
    }
    return response;
  });
  const lossPrepared = lossAdapter.prepareSubmission(submitRequest());
  const lostError = await captureAdapterError(() => lossAdapter.submitPrepared(lossPrepared));
  const recovered = await lossAdapter.submitPrepared(lossPrepared);
  ok(lostError?.code === "submission-unknown" && recovered.remoteJobId === REMOTE_ID
    && lossRaw.submitCalls === 1 && lossRaw.prepareCalls === 1,
  "HTTP 响应丢失后 exact PUT 从 durable result+inspect 恢复，raw submitCalls 仍为 1");

  const afterRawRoot = root();
  const afterRaw = new FakeRawAdapter();
  const afterRawCrash = await harness({
    storeRoot: afterRawRoot,
    raw: afterRaw,
    hooks: { afterRawSubmit: () => { throw new Error("crash-after-raw-submit"); } },
  });
  const afterRawPrepared = afterRawCrash.adapter.prepareSubmission(submitRequest());
  await captureAdapterError(() => afterRawCrash.adapter.submitPrepared(afterRawPrepared));
  afterRawCrash.gateway.close();
  const afterRawRestart = await harness({ storeRoot: afterRawRoot, raw: afterRaw });
  await captureAdapterError(() => afterRawRestart.adapter.submitPrepared(afterRawPrepared));
  ok(afterRaw.submitCalls === 1 && afterRaw.prepareCalls === 1 && afterRaw.inspectCalls === 2,
    "raw submit 已返回但 result 未持久化的 crash window 也绝不二次 POST");

  // Scope binding prevents cross-tenant read/cancel/ID reuse.
  const crossRaw = happy.raw;
  // Use the same live server with a B-scoped client: its routes cannot observe A's global binding.
  const crossAdapter = new ProductionGatewayAdapter({
    baseUrl: "https://job-gateway.internal/",
    workspaceId: SCOPE_B.workspaceId,
    project: SCOPE_B.project,
    backendInstanceId: BACKEND,
    profileId: PROFILE_ID,
    credentialResolver: () => TOKEN_A,
    fetch: async (input, init = {}) => await happy.gateway.handle(new Request(String(input), init)),
  });
  const inspectCount = crossRaw.inspectCalls;
  const cancelCount = crossRaw.cancelCalls;
  const crossInspect = await captureAdapterError(() => crossAdapter.inspect(REMOTE_ID));
  const crossCancel = await captureAdapterError(() => crossAdapter.cancel(REMOTE_ID));
  const crossSubmit = await captureAdapterError(() => crossAdapter.submit(submitRequest()));
  ok(crossInspect?.code === "remote-rejected" && crossCancel?.code === "remote-rejected"
    && crossSubmit?.code === "remote-rejected" && crossRaw.inspectCalls === inspectCount
    && crossRaw.cancelCalls === cancelCount && crossRaw.submitCalls === 1,
  "跨 scope 相同 ID 不能 read/cancel/reuse，且不会触发 raw inspect/cancel/submit");

  const scopedCredentialRoot = root();
  const scopedCredentialRaw = new FakeRawAdapter();
  let expectedBToken = TOKEN_B;
  let clientBToken = TOKEN_A;
  const jobAuthContexts: Array<{ scope: ProductionJobScope; operation: string }> = [];
  const scopedCredentials = await harness({
    storeRoot: scopedCredentialRoot,
    scope: SCOPE_B,
    raw: scopedCredentialRaw,
    clientToken: () => clientBToken,
    serverCredentialResolver: (context) => {
      jobAuthContexts.push({ scope: { ...context.scope }, operation: context.operation });
      return context.scope.workspaceId === SCOPE_B.workspaceId ? expectedBToken : TOKEN_A;
    },
  });
  const wrongScopeCredential = await captureAdapterError(() => scopedCredentials.adapter.submit(submitRequest()));
  const bindingDigest = createHash("sha256").update(REMOTE_ID).digest("hex");
  const bindingFile = join(
    scopedCredentialRoot,
    "bindings",
    bindingDigest.slice(0, 2),
    `${bindingDigest}.json`,
  );
  const unauthorizedWasZeroWrite = !existsSync(bindingFile)
    && scopedCredentialRaw.prepareCalls === 0 && scopedCredentialRaw.submitCalls === 0;
  clientBToken = TOKEN_B;
  await scopedCredentials.adapter.submit(submitRequest());
  expectedBToken = "job-gateway-token-B-v2";
  clientBToken = expectedBToken;
  await scopedCredentials.adapter.inspect(REMOTE_ID);
  const inspectCallsAfterRotation = scopedCredentialRaw.inspectCalls;
  clientBToken = TOKEN_B;
  const staleScopeCredential = await captureAdapterError(() => scopedCredentials.adapter.inspect(REMOTE_ID));
  clientBToken = expectedBToken;
  await scopedCredentials.adapter.cancel(REMOTE_ID);
  ok(wrongScopeCredential?.code === "remote-rejected" && unauthorizedWasZeroWrite
    && staleScopeCredential?.code === "remote-rejected"
    && scopedCredentialRaw.inspectCalls === inspectCallsAfterRotation + 1
    && jobAuthContexts.every((context) => context.scope.workspaceId === SCOPE_B.workspaceId
      && context.scope.project === SCOPE_B.project)
    && jobAuthContexts.some((context) => context.operation === "put-job")
    && jobAuthContexts.some((context) => context.operation === "inspect-job")
    && jobAuthContexts.some((context) => context.operation === "cancel-job"),
  "job resolver 按 route scope/operation 每请求取 token；A token 不能新建 B job且 auth失败零 raw/零 store");
  scopedCredentials.gateway.close();

  // Cancellation is durable/idempotent but never promoted to terminal without inspect evidence.
  const cancelRaw = new FakeRawAdapter();
  cancelRaw.state = "running";
  const cancellation = await harness({ raw: cancelRaw });
  await cancellation.adapter.submit(submitRequest());
  cancelRaw.state = "running";
  const cancelFirst = await cancellation.adapter.cancel(REMOTE_ID);
  const cancelInspectAfterFirst = cancelRaw.inspectCalls;
  const cancelReplay = await cancellation.adapter.cancel(REMOTE_ID);
  ok(cancelFirst.accepted && cancelFirst.confirmed === false && cancelReplay.confirmed === false
    && cancelRaw.cancelCalls === 1 && cancelRaw.inspectCalls === cancelInspectAfterFirst + 1,
  "cancel PUT 首次只调用一次 raw cancel；200/accepted 仍 confirmed:false，exact replay 只 inspect");
  cancelRaw.state = "cancelled";
  const confirmedObservation = await cancellation.adapter.inspect(REMOTE_ID);
  const stillUnconfirmedCancel = await cancellation.adapter.cancel(REMOTE_ID);
  ok(confirmedObservation.state === "cancelled" && stillUnconfirmedCancel.confirmed === false
    && cancelRaw.cancelCalls === 1,
  "只有后续 raw inspect 可观察 cancelled；cancel API 自身永不冒充终态");
  ok(productionJobCancellationKey(SCOPE_A, REMOTE_ID) === productionJobCancellationKey(SCOPE_A, REMOTE_ID)
    && productionJobCancellationKey(SCOPE_A, REMOTE_ID) !== productionJobCancellationKey(SCOPE_B, REMOTE_ID),
  "cancelKey 对相同 scope/job 稳定，并绑定 workspace/project");

  // Credentials rotate per request; old credentials fail before raw calls.
  let serverToken = TOKEN_A;
  let clientToken = TOKEN_A;
  const rotatingRaw = new FakeRawAdapter();
  const rotating = await harness({
    raw: rotatingRaw,
    serverToken: () => serverToken,
    clientToken: () => clientToken,
  });
  await rotating.adapter.submit(submitRequest());
  serverToken = TOKEN_B;
  clientToken = TOKEN_B;
  const rotatedObservation = await rotating.adapter.inspect(REMOTE_ID);
  const rawInspectsAfterRotation = rotatingRaw.inspectCalls;
  clientToken = TOKEN_A;
  const oldCredential = await captureAdapterError(() => rotating.adapter.inspect(REMOTE_ID));
  ok(rotatedObservation.remoteJobId === REMOTE_ID && oldCredential?.code === "remote-rejected"
    && rotatingRaw.inspectCalls === rawInspectsAfterRotation,
  "server/client credential resolver 每请求旋转；旧 bearer 在 raw inspect 前固定拒绝");

  // Redirect/error/oversize and deadline failures are bounded and sanitized.
  let redirectMode: RequestInit["redirect"];
  const redirectAdapter = happy.setClientFetch(async (_input, init) => {
    redirectMode = init?.redirect;
    throw new TypeError("redirect https://evil.example/?token=REDIRECT_SECRET");
  });
  const redirectError = await captureAdapterError(() => redirectAdapter.inspect(REMOTE_ID));
  ok(redirectError?.code === "remote-unavailable" && redirectMode === "error"
    && !redirectError.message.includes("REDIRECT_SECRET"),
  "客户端禁止 gateway redirect，错误不回显重定向 URL/token");

  const oversizedAdapter = happy.setClientFetch(async () => new Response(new Uint8Array(65 * 1024), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(65 * 1024) },
  }));
  const oversized = await captureAdapterError(() => oversizedAdapter.inspect(REMOTE_ID));
  ok(oversized?.code === "response-too-large", "客户端按 Content-Length 拒绝 oversized gateway response");

  const deadlineAdapter = new ProductionGatewayAdapter({
    baseUrl: "https://job-gateway.internal/",
    workspaceId: SCOPE_A.workspaceId,
    project: SCOPE_A.project,
    backendInstanceId: BACKEND,
    profileId: PROFILE_ID,
    credentialResolver: () => TOKEN_A,
    timeoutMs: 60,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          try { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
          catch { /* deadline cancelled */ }
        }, 100);
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const deadlineStart = Date.now();
  const deadlineError = await captureAdapterError(() => deadlineAdapter.inspect(REMOTE_ID));
  ok(deadlineError?.code === "remote-unavailable" && Date.now() - deadlineStart < 150,
    "credential+headers+body 共用单一客户端 absolute deadline");

  const serverDeadlineRaw = new FakeRawAdapter();
  const serverDeadline = await harness({ raw: serverDeadlineRaw, timeoutMs: 400, clientTimeoutMs: 1_000 });
  await serverDeadline.adapter.submit(submitRequest());
  let rawInspectAborted = false;
  serverDeadlineRaw.inspectHandler = async (_remoteJobId, signal) => await new Promise<RemoteObservation>(
    (_resolve, reject) => signal?.addEventListener("abort", () => {
      rawInspectAborted = true;
      reject(signal.reason);
    }, { once: true }),
  );
  const serverDeadlineStart = Date.now();
  const serverDeadlineResponse = await serverDeadline.gateway.handle(new Request(
    `https://job-gateway.internal/v1/scopes/${SCOPE_A.workspaceId}/${SCOPE_A.project}/jobs/${REMOTE_ID}`,
    { headers: { authorization: `Bearer ${TOKEN_A}` } },
  ));
  ok(serverDeadlineResponse.status === 503 && rawInspectAborted
    && Date.now() - serverDeadlineStart < 700,
  "server auth+store+single raw inspect 共用一个 absolute deadline，并向 raw adapter 传播 Abort");
  serverDeadline.gateway.close();

  const liveCleanupRoot = root();
  const liveCleanupRaw = new FakeRawAdapter();
  let liveCleanupLinks = 0;
  let liveCleanupSameInode = false;
  const liveCleanup = await harness({
    storeRoot: liveCleanupRoot,
    raw: liveCleanupRaw,
    hooks: {
      afterPublishLink: (temporaryPath, destination) => {
        if (liveCleanupLinks !== 0) return;
        const temporaryInfo = statSync(temporaryPath);
        const destinationInfo = statSync(destination);
        liveCleanupSameInode = temporaryInfo.dev === destinationInfo.dev
          && temporaryInfo.ino === destinationInfo.ino
          && temporaryInfo.nlink === 2 && destinationInfo.nlink === 2;
        liveCleanupLinks++;
        // Simulate a trusted reader cleaning this exact inode while the live publisher resumes.
        unlinkSync(temporaryPath);
      },
    },
  });
  await liveCleanup.adapter.submit(submitRequest());
  ok(liveCleanupLinks === 1 && liveCleanupSameInode
    && readdirSync(join(liveCleanupRoot, "tmp")).length === 0
    && durableStoreFiles(liveCleanupRoot).every((path) => statSync(path).nlink === 1)
    && liveCleanupRaw.prepareCalls === 1 && liveCleanupRaw.submitCalls === 1,
  "live trusted cleanup与publisher temp unlink竞态：ENOENT仅在destination同inode/nlink=1时接受并完成提交");
  liveCleanup.gateway.close();

  const hardlinkCrashRoot = root();
  const hardlinkCrashRaw = new FakeRawAdapter();
  const hardlinkCrash = await harness({ storeRoot: hardlinkCrashRoot, raw: hardlinkCrashRaw });
  const hardlinkPrepared = hardlinkCrash.adapter.prepareSubmission(submitRequest());
  await hardlinkCrash.adapter.submitPrepared(hardlinkPrepared);
  const hardlinkRequestFile = durableStoreFiles(hardlinkCrashRoot)
    .find((path) => path.endsWith("/request.json"));
  if (!hardlinkRequestFile) throw new Error("missing request record for hardlink crash fixture");
  const orphanedTemporary = join(hardlinkCrashRoot, "tmp", `${"e".repeat(48)}.tmp`);
  linkSync(hardlinkRequestFile, orphanedTemporary);
  const crashLinkWasExact = statSync(hardlinkRequestFile).nlink === 2
    && statSync(orphanedTemporary).ino === statSync(hardlinkRequestFile).ino;
  hardlinkCrash.gateway.close();
  const hardlinkRecovered = await harness({ storeRoot: hardlinkCrashRoot, raw: hardlinkCrashRaw });
  await hardlinkRecovered.adapter.submitPrepared(hardlinkPrepared);
  ok(crashLinkWasExact && !existsSync(orphanedTemporary)
    && statSync(hardlinkRequestFile).nlink === 1
    && readdirSync(join(hardlinkCrashRoot, "tmp")).length === 0
    && hardlinkCrashRaw.prepareCalls === 1 && hardlinkCrashRaw.submitCalls === 1,
  "link→unlink crash残留经重启只清理trusted 48hex tmp同inode，并fsync tmp+destination parent后安全读取");
  hardlinkRecovered.gateway.close();

  const symlinkStoreRoot = root();
  const symlinkOutside = root();
  const symlinkRaw = new FakeRawAdapter();
  const symlinkGuard = await harness({ storeRoot: symlinkStoreRoot, raw: symlinkRaw });
  const symlinkScopeHash = createHash("sha256").update(JSON.stringify(SCOPE_A)).digest("hex");
  symlinkSync(symlinkOutside, join(symlinkStoreRoot, "scopes", symlinkScopeHash));
  const symlinkEscape = await captureAdapterError(() => symlinkGuard.adapter.submit(submitRequest()));
  ok(symlinkEscape?.code === "submission-unknown" && readdirSync(symlinkOutside).length === 0
    && symlinkRaw.prepareCalls === 0 && symlinkRaw.submitCalls === 0,
  "dynamic store中间parent symlink在逐级non-recursive mkdir时fail-closed，store外零目录/文件写入");
  symlinkGuard.gateway.close();

  const strictRaw = new FakeRawAdapter();
  const strict = await harness({ raw: strictRaw });
  const oversizedRequest = await strict.gateway.handle(new Request(
    `https://job-gateway.internal/v1/scopes/${SCOPE_A.workspaceId}/${SCOPE_A.project}/jobs/${REMOTE_ID}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
    },
  ));
  const unknownBody = { ...(JSON.parse(sent.body) as Record<string, unknown>), url: "https://evil.example" };
  const unknownRequest = await strict.gateway.handle(new Request(
    `https://job-gateway.internal/v1/scopes/${SCOPE_A.workspaceId}/${SCOPE_A.project}/jobs/${REMOTE_ID}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        "content-type": "application/json",
        "x-writing-loop-idempotency-key": "idem-take-001",
        "x-writing-loop-request-digest": prepared.requestDigest,
      },
      body: JSON.stringify(unknownBody),
    },
  ));
  ok(oversizedRequest.status === 413 && unknownRequest.status === 400
    && strictRaw.prepareCalls === 0 && strictRaw.submitCalls === 0,
  "server 同时按 body bytes 截断并 strict-reject 任意 URL/未知字段，raw 调用保持为零");
  strict.gateway.close();

  const profileRaw = new FakeRawAdapter();
  const profileMismatch = await harness({ raw: profileRaw });
  const differentWorkflow = { "1": { class_type: "OtherNode", inputs: {} } };
  const profileError = await captureAdapterError(() => profileMismatch.adapter.submit(submitRequest(differentWorkflow)));
  ok(profileError?.code === "remote-rejected" && profileRaw.prepareCalls === 0 && profileRaw.submitCalls === 0,
    "server registry 的 exact graph digest/profile allowlist 在 raw prepare 前拒绝漂移 workflow");

  const validatorRaw = new FakeRawAdapter();
  const validatorRejected = await harness({ raw: validatorRaw, validator: () => false });
  const validatorError = await captureAdapterError(() => validatorRejected.adapter.submit(submitRequest()));
  ok(validatorError?.code === "remote-rejected" && validatorRaw.prepareCalls === 0
    && validatorRaw.submitCalls === 0,
  "必需的 server profile validator 可在 raw prepare 前否决模型/custom-node profile");
  validatorRejected.gateway.close();

  const secretRaw = new FakeRawAdapter();
  const rawSecret = "RAW_PROVIDER_TOKEN_NEVER_LEAK";
  secretRaw.submitSecret = rawSecret;
  const sanitized = await harness({ raw: secretRaw });
  const sanitizedError = await captureAdapterError(() => sanitized.adapter.submit(submitRequest()));
  ok(sanitizedError?.code === "submission-unknown" && !sanitizedError.message.includes(rawSecret)
    && !JSON.stringify(sanitizedError).includes(rawSecret),
  "raw adapter 原始异常/token 被稳定 submission-unknown 类别脱敏");

  for (const instance of [
    happy, restarted, attemptRestart, ambiguous, loss, afterRawRestart, cancellation,
    rotating, profileMismatch, sanitized,
  ]) instance.gateway.close();
} finally {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
}

// §8.0 owner-only transport: VPC 私网明文 HTTP 只在「私网字面 IP + 非空 bearer」下成立，
// 缺省 transport 仍然只接受 credentialed HTTPS。
const adapterConstructed = (options: Partial<ProductionGatewayAdapterOptions>): boolean => {
  try {
    new ProductionGatewayAdapter({
      baseUrl: "https://jobs.internal.example",
      workspaceId: SCOPE_A.workspaceId,
      project: SCOPE_A.project,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID,
      credentialResolver: () => TOKEN_A,
      ...options,
    });
    return true;
  } catch { return false; }
};
ok(adapterConstructed({ baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http" }),
  "gateway adapter：insecure-private-http + RFC1918 字面 IP + credential 被接受");
ok(!adapterConstructed({ baseUrl: "http://203.0.113.9:8790", transport: "insecure-private-http" }),
  "gateway adapter：insecure-private-http 拒绝公网 IP endpoint");
ok(!adapterConstructed({
  baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http", credentialResolver: undefined,
}), "gateway adapter：insecure-private-http 缺 credentialResolver 时拒绝");
ok(!adapterConstructed({ baseUrl: "http://10.148.0.9:8790" }),
  "gateway adapter：缺省 transport 仍要求 HTTPS，私网明文 http 被拒");

if (fails) {
  console.error(`\n${fails} production job gateway assertion(s) failed`);
  process.exit(1);
}
console.log("\nproduction job gateway tests: OK");
