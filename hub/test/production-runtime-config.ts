// Phase 3C server-only configuration: strict schema, exact local reads, immutable workflow
// bindings, environment-only credentials and registry-scoped project assembly.
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionWorkflowSha256 } from "../src/production-coordinator.ts";
import { productionInputBindingsDigest } from "../src/production-input-stager.ts";
import {
  createProductionDispatchIntent,
  type ProductionDispatchIntent,
  type ProductionIntentExecution,
} from "../src/production-intent.ts";
import {
  createProductionRuntimeRegistry,
  loadProductionRuntimeConfig,
  parseProductionRuntimeConfig,
  ProductionRuntimeConfigError,
} from "../src/production-runtime-config.ts";
import {
  ProductionH3GraphError,
  assertProductionH3Template,
  materializeProductionH3Workflow,
  parseProductionH3GraphContract,
  productionH3ModelBundleSha256,
  productionH3ParameterManifestSha256,
  productionH3StageInputSentinel,
  type ProductionH3GraphContract,
  type ProductionH3ModelBundleContract,
} from "../src/production-h3-graph.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

function configError(operation: () => unknown, code?: string): boolean {
  try { operation(); return false; }
  catch (error) {
    return error instanceof ProductionRuntimeConfigError && (code === undefined || error.code === code);
  }
}

async function rejectsConfig(operation: () => Promise<unknown>, code?: string): Promise<boolean> {
  try { await operation(); return false; }
  catch (error) {
    return error instanceof ProductionRuntimeConfigError && (code === undefined || error.code === code);
  }
}

const SHA = {
  model: createHash("sha256").update("model").digest("hex"),
  parameters: createHash("sha256").update("parameters").digest("hex"),
  h3Diffusion: createHash("sha256").update("h3-diffusion").digest("hex"),
  h3TextEncoder: createHash("sha256").update("h3-text-encoder").digest("hex"),
  h3VideoVae: createHash("sha256").update("h3-video-vae").digest("hex"),
  h3AudioVae: createHash("sha256").update("h3-audio-vae").digest("hex"),
};
const WORKSPACE_ID = `ws_${"a".repeat(32)}`;
const WORKFLOW: Record<string, unknown> = {
  "1": { class_type: "WritingLoopStaticT2V", inputs: { prompt: "pre-staged/static only" } },
};
const workflowSha256 = productionWorkflowSha256(WORKFLOW);

const H3_MODEL_ALIASES = {
  diffusion: "minimax/MiniMax-H3.safetensors",
  textEncoder: "minimax/Qwen3-VL-32B.safetensors",
  videoVae: "minimax/MiniMax-H3-video-vae.safetensors",
  audioVae: "minimax/MiniMax-H3-audio-vae.safetensors",
};

const h3ModelBundle = (
  diffusion: string, textEncoder: string, videoVae: string, audioVae: string,
): ProductionH3ModelBundleContract => {
  const unsigned: ProductionH3ModelBundleContract = {
    version: 1,
    diffusion: { version: 1, nodeId: diffusion, classType: "UNETLoader", inputName: "unet_name", modelAlias: H3_MODEL_ALIASES.diffusion, artifactSha256: SHA.h3Diffusion },
    textEncoder: { version: 1, nodeId: textEncoder, classType: "CLIPLoader", inputName: "clip_name", modelAlias: H3_MODEL_ALIASES.textEncoder, artifactSha256: SHA.h3TextEncoder },
    videoVae: { version: 1, nodeId: videoVae, classType: "VAELoader", inputName: "vae_name", modelAlias: H3_MODEL_ALIASES.videoVae, artifactSha256: SHA.h3VideoVae },
    audioVae: { version: 1, nodeId: audioVae, classType: "VAELoader", inputName: "vae_name", modelAlias: H3_MODEL_ALIASES.audioVae, artifactSha256: SHA.h3AudioVae },
    sha256: "0".repeat(64),
  };
  return { ...unsigned, sha256: productionH3ModelBundleSha256(unsigned) };
};

type H3Ids = Readonly<{
  generator: string; diffusion: string; textEncoder: string; videoVae: string; audioVae: string;
  sigmaShift: string; guider: string; scheduler: string; samplerSelect: string; noise: string;
  sampler: string; videoDecode: string; audioDecode: string; createVideo: string; saveVideo: string;
}>;

const h3Ids = (offset: number): H3Ids => ({
  generator: String(offset), diffusion: String(offset + 1), textEncoder: String(offset + 2),
  videoVae: String(offset + 3), audioVae: String(offset + 4), sigmaShift: String(offset + 5),
  guider: String(offset + 6), scheduler: String(offset + 7), samplerSelect: String(offset + 8),
  noise: String(offset + 9), sampler: String(offset + 10), videoDecode: String(offset + 11),
  audioDecode: String(offset + 12), createVideo: String(offset + 13), saveVideo: String(offset + 14),
});

const H3_FL_IDS = h3Ids(10);
const H3_REF_IDS = h3Ids(30);

function h3Workflow(ids: H3Ids, variant: "fl2va" | "ref2va", sources: readonly string[]): Record<string, unknown> {
  const profileId = variant === "fl2va" ? "h3-fl-profile" : "h3-ref-profile";
  const slots = variant === "fl2va" ? ["first_frame", "last_frame"] : ["reference.0", "reference.1"];
  const consumerNames = variant === "fl2va"
    ? ["first_frame", "last_frame"]
    : ["ref_images.ref_image_0", "ref_images.ref_image_1"];
  const generatorInputs: Record<string, unknown> = {
    clip: [ids.textEncoder, 0], vae: [ids.videoVae, 0], prompt: "cinematic short-drama shot",
    width: 768, height: 1_344, length: 192,
  };
  if (variant === "ref2va") {
    generatorInputs.audio_vae = [ids.audioVae, 0];
    generatorInputs.ref_image_size = "match";
  }
  for (let index = 0; index < sources.length; index++) generatorInputs[consumerNames[index]!] = [sources[index], 0];
  const workflow: Record<string, unknown> = {
    [ids.generator]: { class_type: variant === "fl2va" ? "MiniMaxH3ImageToVideo" : "MiniMaxH3ReferenceToVideo", inputs: generatorInputs },
    [ids.diffusion]: { class_type: "UNETLoader", inputs: { unet_name: H3_MODEL_ALIASES.diffusion, weight_dtype: "default" } },
    [ids.textEncoder]: { class_type: "CLIPLoader", inputs: { clip_name: H3_MODEL_ALIASES.textEncoder, type: "minimax", device: "default" } },
    [ids.videoVae]: { class_type: "VAELoader", inputs: { vae_name: H3_MODEL_ALIASES.videoVae } },
    [ids.audioVae]: { class_type: "VAELoader", inputs: { vae_name: H3_MODEL_ALIASES.audioVae } },
    [ids.sigmaShift]: { class_type: "MiniMaxH3SigmaShift", inputs: { model: [ids.diffusion, 0], shift_video: 12, shift_audio: 3 } },
    [ids.guider]: { class_type: "BasicGuider", inputs: { model: [ids.sigmaShift, 0], conditioning: [ids.generator, 0] } },
    [ids.scheduler]: { class_type: "BasicScheduler", inputs: { model: [ids.sigmaShift, 0], scheduler: "simple", steps: 30, denoise: 1 } },
    [ids.samplerSelect]: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    [ids.noise]: { class_type: "RandomNoise", inputs: { noise_seed: variant === "fl2va" ? 42 : 43 } },
    [ids.sampler]: { class_type: "SamplerCustomAdvanced", inputs: { noise: [ids.noise, 0], guider: [ids.guider, 0], sampler: [ids.samplerSelect, 0], sigmas: [ids.scheduler, 0], latent_image: [ids.generator, 1] } },
    [ids.videoDecode]: { class_type: "VAEDecode", inputs: { samples: [ids.sampler, 0], vae: [ids.videoVae, 0] } },
    [ids.audioDecode]: { class_type: "VAEDecodeAudio", inputs: { samples: [ids.sampler, 0], vae: [ids.audioVae, 0] } },
    [ids.createVideo]: { class_type: "CreateVideo", inputs: { images: [ids.videoDecode, 0], fps: 24, audio: [ids.audioDecode, 0], bit_depth: 8 } },
    [ids.saveVideo]: { class_type: "SaveVideo", inputs: { video: [ids.createVideo, 0], filename_prefix: "video/writing-loop-h3", format: "auto", codec: "auto" } },
  };
  for (let index = 0; index < sources.length; index++) {
    workflow[sources[index]!] = { class_type: "LoadImage", inputs: { image: productionH3StageInputSentinel(profileId, index, slots[index]!) } };
  }
  return workflow;
}

const H3_FL_WORKFLOW = h3Workflow(H3_FL_IDS, "fl2va", ["100", "101"]);
const H3_REF_WORKFLOW = h3Workflow(H3_REF_IDS, "ref2va", ["110", "111"]);

function h3GraphContract(
  ids: H3Ids,
  generatorClassType: "MiniMaxH3ImageToVideo" | "MiniMaxH3ReferenceToVideo",
  parametersSha256: string,
): ProductionH3GraphContract {
  return parseProductionH3GraphContract({
    version: 1,
    generator: {
      version: 1, nodeId: ids.generator, classType: generatorClassType, width: 768, height: 1_344, length: 192,
    },
    modelBundle: h3ModelBundle(ids.diffusion, ids.textEncoder, ids.videoVae, ids.audioVae),
    pipeline: {
      version: 1,
      sigmaShift: { version: 1, nodeId: ids.sigmaShift, classType: "MiniMaxH3SigmaShift" },
      guider: { version: 1, nodeId: ids.guider, classType: "BasicGuider" },
      scheduler: { version: 1, nodeId: ids.scheduler, classType: "BasicScheduler" },
      samplerSelect: { version: 1, nodeId: ids.samplerSelect, classType: "KSamplerSelect" },
      noise: { version: 1, nodeId: ids.noise, classType: "RandomNoise" },
      sampler: { version: 1, nodeId: ids.sampler, classType: "SamplerCustomAdvanced" },
      videoDecode: { version: 1, nodeId: ids.videoDecode, classType: "VAEDecode" },
      audioDecode: { version: 1, nodeId: ids.audioDecode, classType: "VAEDecodeAudio" },
      createVideo: { version: 1, nodeId: ids.createVideo, classType: "CreateVideo" },
      saveVideo: { version: 1, nodeId: ids.saveVideo, classType: "SaveVideo" },
    },
    parameterManifest: { version: 1, sha256: parametersSha256 },
  });
}

const H3_FL_CONTRACT_BASE = h3GraphContract(H3_FL_IDS, "MiniMaxH3ImageToVideo", "0".repeat(64));
const H3_REF_CONTRACT_BASE = h3GraphContract(H3_REF_IDS, "MiniMaxH3ReferenceToVideo", "0".repeat(64));
const h3ExecutionBase = (
  backendInstanceId: string,
  workflow: Record<string, unknown>,
  modelSha256: string,
  variant: "fl2va" | "ref2va",
): Extract<ProductionIntentExecution, { modelFamily: "minimax-h3" }> => ({
  version: 1,
  operation: "comfyui-workflow",
  modelFamily: "minimax-h3",
  backendInstanceId,
  workflowSha256: productionWorkflowSha256(workflow),
  modelSha256,
  parametersSha256: "0".repeat(64),
  variant,
  durationSeconds: 8,
  shortEdge: 768,
  aspectRatio: "9:16",
});
const H3_FL_EXECUTION_BASE = h3ExecutionBase(
  "h3-fl-gateway", H3_FL_WORKFLOW, H3_FL_CONTRACT_BASE.modelBundle.sha256, "fl2va",
);
const H3_REF_EXECUTION_BASE = h3ExecutionBase(
  "h3-ref-gateway", H3_REF_WORKFLOW, H3_REF_CONTRACT_BASE.modelBundle.sha256, "ref2va",
);
const H3_FL_PARAMETERS_SHA = productionH3ParameterManifestSha256(
  H3_FL_WORKFLOW, H3_FL_CONTRACT_BASE, H3_FL_EXECUTION_BASE,
);
const H3_REF_PARAMETERS_SHA = productionH3ParameterManifestSha256(
  H3_REF_WORKFLOW, H3_REF_CONTRACT_BASE, H3_REF_EXECUTION_BASE,
);
const H3_FL_CONTRACT = h3GraphContract(H3_FL_IDS, "MiniMaxH3ImageToVideo", H3_FL_PARAMETERS_SHA);
const H3_REF_CONTRACT = h3GraphContract(H3_REF_IDS, "MiniMaxH3ReferenceToVideo", H3_REF_PARAMETERS_SHA);
const H3_FL_EXECUTION: ProductionIntentExecution = {
  ...H3_FL_EXECUTION_BASE, parametersSha256: H3_FL_PARAMETERS_SHA,
};
const H3_REF_EXECUTION: ProductionIntentExecution = {
  ...H3_REF_EXECUTION_BASE, parametersSha256: H3_REF_PARAMETERS_SHA,
};

const asset = (name: string, digest: string) => ({
  version: 1 as const,
  uri: `s3://writing-loop-assets/demo/${name}`,
  sha256: digest,
  byteLength: 100,
  mediaType: "image/png",
});

function h3Intent(taskId: string, execution: ProductionIntentExecution): ProductionDispatchIntent {
  return createProductionDispatchIntent({
    version: 1,
    taskId,
    subject: {
      version: 1,
      kind: "episode",
      episode: {
        version: 1,
        episodeId: "ep-h3",
        revision: 1,
        source: { ...asset("episode.json", "1".repeat(64)), mediaType: "application/json" },
      },
    },
    createdAt: "2026-08-10T12:00:00.000Z",
    useTerritories: ["CN"],
    execution,
    inputs: [asset(`${taskId}-0.png`, "2".repeat(64)), asset(`${taskId}-1.png`, "3".repeat(64))],
    budget: { version: 1, currency: "USD", estimatedAmountMicros: 500_000, maximumAmountMicros: 500_000 },
    rights: {
      version: 1,
      status: "cleared",
      territories: ["CN"],
      evidence: { ...asset("rights.json", "4".repeat(64)), mediaType: "application/json" },
      expiresAt: null,
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: "2026-08-10T11:00:00.000Z",
      evidence: { ...asset("moderation.json", "5".repeat(64)), mediaType: "application/json" },
    },
    license: {
      version: 1,
      status: "verified",
      basis: "provider-terms",
      territories: ["CN"],
      licenseSha256: "6".repeat(64),
      evidence: { ...asset("license.json", "6".repeat(64)), mediaType: "application/json" },
      issuedBy: "MiniMaxAI",
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    },
  });
}

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    workspaceId: WORKSPACE_ID,
    projects: [
      {
        version: 1,
        project: "demo",
        enabled: true,
        backendInstanceIds: ["comfy-primary"],
        deploymentTerritories: ["CN"],
        availableBudgetMicros: 2_000_000,
      },
      {
        version: 1,
        project: "disabled",
        enabled: false,
        backendInstanceIds: ["comfy-primary"],
        deploymentTerritories: ["CN"],
        availableBudgetMicros: 0,
      },
    ],
    backends: [{
      version: 1,
      backendInstanceId: "comfy-primary",
      kind: "production-gateway",
      baseUrl: "https://jobs.internal.example/private",
      credentialEnv: "PRODUCTION_JOB_GATEWAY_TOKEN",
      profileId: "static-profile",
    }],
    gateway: {
      version: 1,
      baseUrl: "https://gateway.internal.example",
      credentialEnv: "PRODUCTION_GATEWAY_TOKEN",
    },
    workflows: [{
      version: 1,
      backendInstanceId: "comfy-primary",
      workflowSha256,
      modelFamily: "generic",
      modelSha256: SHA.model,
      parametersSha256: SHA.parameters,
      projects: ["demo"],
      inputPolicy: "static-pre-staged",
      stagingProfileId: null,
      h3GraphContract: null,
      file: "workflows/static-t2v.json",
    }],
    stagingProfiles: [],
    runner: {
      version: 1,
      intervalMs: 1_000,
      projectConcurrency: 4,
      perBackendConcurrency: 1,
    },
  };
}

function h3Config(): Record<string, unknown> {
  const project = structuredClone((validConfig().projects as unknown[])[0]);
  (project as Record<string, unknown>).backendInstanceIds = ["h3-fl-gateway", "h3-ref-gateway"];
  return {
    version: 1,
    workspaceId: WORKSPACE_ID,
    projects: [project],
    backends: [
      {
        version: 1,
        backendInstanceId: "h3-fl-gateway",
        kind: "production-gateway",
        baseUrl: "https://jobs.internal.example/h3",
        credentialEnv: "PRODUCTION_JOB_GATEWAY_TOKEN",
        profileId: "h3-fl-profile",
      },
      {
        version: 1,
        backendInstanceId: "h3-ref-gateway",
        kind: "production-gateway",
        baseUrl: "https://jobs.internal.example/h3",
        credentialEnv: "PRODUCTION_JOB_GATEWAY_TOKEN",
        profileId: "h3-ref-profile",
      },
    ],
    gateway: structuredClone(validConfig().gateway),
    workflows: [
      {
        version: 1,
        backendInstanceId: H3_FL_EXECUTION.backendInstanceId,
        workflowSha256: H3_FL_EXECUTION.workflowSha256,
        modelFamily: H3_FL_EXECUTION.modelFamily,
        modelSha256: H3_FL_EXECUTION.modelSha256,
        parametersSha256: H3_FL_EXECUTION.parametersSha256,
        projects: ["demo"],
        inputPolicy: "scoped-staging",
        stagingProfileId: "h3-fl-profile",
        h3GraphContract: structuredClone(H3_FL_CONTRACT),
        file: "workflows/h3-fl.json",
      },
      {
        version: 1,
        backendInstanceId: H3_REF_EXECUTION.backendInstanceId,
        workflowSha256: H3_REF_EXECUTION.workflowSha256,
        modelFamily: H3_REF_EXECUTION.modelFamily,
        modelSha256: H3_REF_EXECUTION.modelSha256,
        parametersSha256: H3_REF_EXECUTION.parametersSha256,
        projects: ["demo"],
        inputPolicy: "scoped-staging",
        stagingProfileId: "h3-ref-profile",
        h3GraphContract: structuredClone(H3_REF_CONTRACT),
        file: "workflows/h3-ref.json",
      },
    ],
    stagingProfiles: [
      {
        version: 1,
        profileId: "h3-fl-profile",
        baseUrl: "https://stages.internal.example/h3",
        credentialEnv: "PRODUCTION_STAGE_TOKEN",
        execution: structuredClone(H3_FL_EXECUTION),
        bindings: [
          {
            version: 1,
            index: 0,
            slot: "first_frame",
            source: { version: 1, nodeId: "100", classType: "LoadImage", inputName: "image", outputIndex: 0 },
            consumer: { version: 1, nodeId: "10", inputName: "first_frame" },
          },
          {
            version: 1,
            index: 1,
            slot: "last_frame",
            source: { version: 1, nodeId: "101", classType: "LoadImage", inputName: "image", outputIndex: 0 },
            consumer: { version: 1, nodeId: "10", inputName: "last_frame" },
          },
        ],
      },
      {
        version: 1,
        profileId: "h3-ref-profile",
        baseUrl: "https://stages.internal.example/h3",
        credentialEnv: "PRODUCTION_STAGE_TOKEN",
        execution: structuredClone(H3_REF_EXECUTION),
        bindings: [
          {
            version: 1,
            index: 0,
            slot: "reference.0",
            source: { version: 1, nodeId: "110", classType: "LoadImage", inputName: "image", outputIndex: 0 },
            consumer: { version: 1, nodeId: H3_REF_IDS.generator, inputName: "ref_images.ref_image_0" },
          },
          {
            version: 1,
            index: 1,
            slot: "reference.1",
            source: { version: 1, nodeId: "111", classType: "LoadImage", inputName: "image", outputIndex: 0 },
            consumer: { version: 1, nodeId: H3_REF_IDS.generator, inputName: "ref_images.ref_image_1" },
          },
        ],
      },
    ],
    runner: structuredClone(validConfig().runner),
  };
}

const root = mkdtempSync(join(tmpdir(), "writing-loop-runtime-"));
const runtimeDirectory = join(root, "runtime");
const workflowDirectory = join(runtimeDirectory, "workflows");
const configFile = join(runtimeDirectory, "production-runtime.v1.json");
const workflowFile = join(workflowDirectory, "static-t2v.json");
const h3FlWorkflowFile = join(workflowDirectory, "h3-fl.json");
const h3RefWorkflowFile = join(workflowDirectory, "h3-ref.json");
mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
mkdirSync(join(root, ".writing-loop", "disabled"), { recursive: true });
mkdirSync(join(root, ".writing-loop", "rogue-not-registered"), { recursive: true });
mkdirSync(workflowDirectory, { recursive: true });
writeFileSync(join(root, ".writing-loop", "workspace.json"), `${JSON.stringify({ version: 1, id: WORKSPACE_ID })}\n`);
writeFileSync(join(root, ".writing-loop", "config.json"), `${JSON.stringify({
  version: 1,
  projects: { demo: { enabled: true }, disabled: { enabled: true } },
})}\n`);
const configText = `${JSON.stringify(validConfig(), null, 2)}\n`;
const workflowText = `${JSON.stringify(WORKFLOW, null, 2)}\n`;
writeFileSync(configFile, configText, { mode: 0o600 });
writeFileSync(workflowFile, workflowText, { mode: 0o600 });
writeFileSync(h3FlWorkflowFile, `${JSON.stringify(H3_FL_WORKFLOW, null, 2)}\n`, { mode: 0o600 });
writeFileSync(h3RefWorkflowFile, `${JSON.stringify(H3_REF_WORKFLOW, null, 2)}\n`, { mode: 0o600 });

try {
  const loaded = loadProductionRuntimeConfig(configFile);
  ok(loaded.workspaceId === WORKSPACE_ID && Object.isFrozen(loaded),
    "trusted single-link bounded JSON config loads as immutable strict v1 data");

  const unknownTop = structuredClone(validConfig());
  unknownTop.token = "plaintext-forbidden";
  ok(configError(() => parseProductionRuntimeConfig(unknownTop), "config-invalid-schema"),
    "strict top-level schema rejects plaintext token fields");

  const unknownGateway = structuredClone(validConfig());
  (unknownGateway.gateway as Record<string, unknown>).bearerToken = "plaintext-forbidden";
  ok(configError(() => parseProductionRuntimeConfig(unknownGateway), "config-invalid-schema"),
    "strict nested gateway schema rejects plaintext bearer token fields");

  const invalidCredentialEnv = structuredClone(validConfig());
  ((invalidCredentialEnv.backends as Record<string, unknown>[])[0]!).credentialEnv = "secret-value.with-punctuation";
  ok(configError(() => parseProductionRuntimeConfig(invalidCredentialEnv), "config-invalid-schema"),
    "credentialEnv accepts environment names only, not token-shaped values");

  const insecureCredentialedBackend = structuredClone(validConfig());
  ((insecureCredentialedBackend.backends as Record<string, unknown>[])[0]!).baseUrl = "http://comfy.internal.example";
  ok(configError(() => parseProductionRuntimeConfig(insecureCredentialedBackend), "config-invalid-schema"),
    "credentialed production job gateway cannot expose a bearer token over HTTP");

  const directComfyDevelopment = structuredClone(validConfig());
  (directComfyDevelopment.backends as Record<string, unknown>[])[0] = {
    version: 1,
    backendInstanceId: "comfy-primary",
    kind: "comfyui",
    baseUrl: "http://127.0.0.1:8188/dev",
    credentialEnv: null,
    preferJobsApi: false,
  };
  ok(parseProductionRuntimeConfig(directComfyDevelopment).backends[0]?.kind === "comfyui",
    "direct ComfyUI is available only as explicit uncredentialed literal-loopback development backend");
  const publicDirectComfy = structuredClone(directComfyDevelopment);
  ((publicDirectComfy.backends as Record<string, unknown>[])[0]!).baseUrl = "https://comfy.internal.example";
  ok(configError(() => parseProductionRuntimeConfig(publicDirectComfy), "config-invalid-schema"),
    "direct ComfyUI production endpoint cannot bypass the scoped job gateway");
  const namedLoopbackComfy = structuredClone(directComfyDevelopment);
  ((namedLoopbackComfy.backends as Record<string, unknown>[])[0]!).baseUrl = "http://localhost:8188";
  ok(configError(() => parseProductionRuntimeConfig(namedLoopbackComfy), "config-invalid-schema"),
    "direct ComfyUI development escape hatch requires a literal loopback address");

  const gatewayWithPath = structuredClone(validConfig());
  (gatewayWithPath.gateway as Record<string, unknown>).baseUrl = "https://gateway.internal.example/private/v1/";
  ok((parseProductionRuntimeConfig(gatewayWithPath).gateway.baseUrl) === "https://gateway.internal.example/private/v1",
    "gateway URL canonicalizes an exact HTTPS origin plus fixed safe path");

  const publicPlaintextGateway = structuredClone(validConfig());
  (publicPlaintextGateway.gateway as Record<string, unknown>).baseUrl = "http://gateway.example.test";
  (publicPlaintextGateway.gateway as Record<string, unknown>).credentialEnv = null;
  ok(configError(() => parseProductionRuntimeConfig(publicPlaintextGateway), "config-invalid-schema"),
    "public plaintext gateway is rejected even without credentials");

  const loopbackDevelopment = structuredClone(validConfig());
  (loopbackDevelopment.gateway as Record<string, unknown>).baseUrl = "http://127.0.0.1:8080/dev";
  (loopbackDevelopment.gateway as Record<string, unknown>).credentialEnv = null;
  ok(parseProductionRuntimeConfig(loopbackDevelopment).gateway.baseUrl === "http://127.0.0.1:8080/dev",
    "explicit uncredentialed loopback HTTP remains available for local development");

  // Owner-only `transport: insecure-private-http`: VPC-private plaintext plus a bearer credential.
  const defaultTransport = parseProductionRuntimeConfig(validConfig());
  const defaultBackend = defaultTransport.backends[0];
  ok(defaultTransport.gateway.transport === "tls"
    && defaultBackend?.kind === "production-gateway" && defaultBackend.transport === "tls",
  "omitted transport reads as tls and leaves the existing HTTPS rules in force");

  const privateBackend = structuredClone(validConfig());
  const privateBackendRow = (privateBackend.backends as Record<string, unknown>[])[0]!;
  privateBackendRow.baseUrl = "http://10.128.0.7:8080/jobs";
  privateBackendRow.transport = "insecure-private-http";
  const parsedPrivateBackend = parseProductionRuntimeConfig(privateBackend).backends[0];
  ok(parsedPrivateBackend?.kind === "production-gateway"
    && parsedPrivateBackend.transport === "insecure-private-http"
    && parsedPrivateBackend.baseUrl === "http://10.128.0.7:8080/jobs"
    && parsedPrivateBackend.credentialEnv === "PRODUCTION_JOB_GATEWAY_TOKEN",
  "job gateway backend accepts RFC1918 plaintext HTTP only with an explicit transport and a credential");

  const tlsBackendOnHttp = structuredClone(validConfig());
  ((tlsBackendOnHttp.backends as Record<string, unknown>[])[0]!).baseUrl = "http://10.128.0.7:8080/jobs";
  ok(configError(() => parseProductionRuntimeConfig(tlsBackendOnHttp), "config-invalid-schema"),
    "a private address alone does not relax the default HTTPS requirement");

  const privateBackendOverHttps = structuredClone(privateBackend);
  ((privateBackendOverHttps.backends as Record<string, unknown>[])[0]!).baseUrl = "https://10.128.0.7:8080/jobs";
  ok(configError(() => parseProductionRuntimeConfig(privateBackendOverHttps), "config-invalid-schema"),
    "insecure-private-http is a plaintext-only declaration and cannot be claimed for an HTTPS endpoint");

  const publicPrivateTransport = structuredClone(privateBackend);
  ((publicPrivateTransport.backends as Record<string, unknown>[])[0]!).baseUrl = "http://203.0.113.10:8080/jobs";
  ok(configError(() => parseProductionRuntimeConfig(publicPrivateTransport), "config-invalid-schema"),
    "insecure-private-http rejects a routable public address");

  for (const host of ["172.15.0.1", "172.32.0.1", "0.0.0.0", "127.0.0.2"]) {
    const outsideRange = structuredClone(privateBackend);
    ((outsideRange.backends as Record<string, unknown>[])[0]!).baseUrl = `http://${host}:8080/jobs`;
    ok(configError(() => parseProductionRuntimeConfig(outsideRange), "config-invalid-schema"),
      `insecure-private-http rejects ${host}, which sits outside the RFC1918 blocks and the loopback literal`);
  }
  const rfc1918Edge = structuredClone(privateBackend);
  ((rfc1918Edge.backends as Record<string, unknown>[])[0]!).baseUrl = "http://192.168.1.1:8080/jobs";
  const parsedRfc1918Edge = parseProductionRuntimeConfig(rfc1918Edge).backends[0];
  ok(parsedRfc1918Edge?.kind === "production-gateway"
    && parsedRfc1918Edge.baseUrl === "http://192.168.1.1:8080/jobs",
  "insecure-private-http accepts the 192.168/16 block alongside 10/8 and 172.16/12");

  const explicitTls = structuredClone(validConfig());
  ((explicitTls.backends as Record<string, unknown>[])[0]!).transport = "tls";
  (explicitTls.gateway as Record<string, unknown>).transport = "tls";
  ok(JSON.stringify(parseProductionRuntimeConfig(explicitTls))
    === JSON.stringify(parseProductionRuntimeConfig(validConfig())),
  "an explicit transport: tls parses byte-identically to omitting the field");

  const comfyPrivateTransport = structuredClone(directComfyDevelopment);
  ((comfyPrivateTransport.backends as Record<string, unknown>[])[0]!).transport = "insecure-private-http";
  ok(configError(() => parseProductionRuntimeConfig(comfyPrivateTransport), "config-invalid-schema"),
    "direct ComfyUI backend does not accept the transport field and keeps its loopback-only rule");

  const privateGateway = structuredClone(validConfig());
  (privateGateway.gateway as Record<string, unknown>).baseUrl = "http://127.0.0.1:8080/ingest";
  (privateGateway.gateway as Record<string, unknown>).transport = "insecure-private-http";
  const parsedPrivateGateway = parseProductionRuntimeConfig(privateGateway).gateway;
  ok(parsedPrivateGateway.transport === "insecure-private-http"
    && parsedPrivateGateway.baseUrl === "http://127.0.0.1:8080/ingest"
    && parsedPrivateGateway.credentialEnv === "PRODUCTION_GATEWAY_TOKEN",
  "ingest gateway accepts the literal loopback address under an explicit private-HTTP transport");

  const uncredentialedPrivateGateway = structuredClone(privateGateway);
  (uncredentialedPrivateGateway.gateway as Record<string, unknown>).credentialEnv = null;
  ok(configError(() => parseProductionRuntimeConfig(uncredentialedPrivateGateway), "config-invalid-schema"),
    "plaintext private transport still requires a bearer credential, unlike the loopback dev escape hatch");

  const namedPrivateGateway = structuredClone(privateGateway);
  (namedPrivateGateway.gateway as Record<string, unknown>).baseUrl = "http://gateway.internal.example";
  ok(configError(() => parseProductionRuntimeConfig(namedPrivateGateway), "config-invalid-schema"),
    "insecure-private-http rejects a domain name that could resolve anywhere");

  const unknownBackend = structuredClone(validConfig());
  ((unknownBackend.projects as Record<string, unknown>[])[0]!).backendInstanceIds = ["unregistered"];
  ok(configError(() => parseProductionRuntimeConfig(unknownBackend), "config-invalid-schema"),
    "project registry cannot reference an unregistered backend instance");

  const duplicateBinding = structuredClone(validConfig());
  (duplicateBinding.workflows as unknown[]).push(structuredClone((duplicateBinding.workflows as unknown[])[0]));
  ok(configError(() => parseProductionRuntimeConfig(duplicateBinding), "config-invalid-schema"),
    "workflow tuple digest/model/model-sha/parameters-sha binding is unique");

  const equivocalBinding = structuredClone(validConfig());
  const secondBinding = structuredClone((equivocalBinding.workflows as Record<string, unknown>[])[0]!);
  secondBinding.modelSha256 = "f".repeat(64);
  (equivocalBinding.workflows as Record<string, unknown>[]).push(secondBinding);
  ok(configError(() => parseProductionRuntimeConfig(equivocalBinding), "config-invalid-schema"),
    "one backend/workflow digest cannot equivocate across multiple model identities");

  const absoluteWorkflow = structuredClone(validConfig());
  ((absoluteWorkflow.workflows as Record<string, unknown>[])[0]!).file = workflowFile;
  ok(configError(() => parseProductionRuntimeConfig(absoluteWorkflow), "config-invalid-schema"),
    "workflow registry rejects absolute paths");

  const configSymlink = join(runtimeDirectory, "config-symlink.json");
  symlinkSync(configFile, configSymlink);
  ok(configError(() => loadProductionRuntimeConfig(configSymlink), "config-unreadable"),
    "runtime config rejects a final symlink");
  unlinkSync(configSymlink);

  const configHardlink = join(runtimeDirectory, "config-hardlink.json");
  linkSync(configFile, configHardlink);
  ok(configError(() => loadProductionRuntimeConfig(configHardlink), "config-unreadable"),
    "runtime config rejects hard-linked files");
  unlinkSync(configHardlink);

  chmodSync(configFile, 0o644);
  ok(configError(() => loadProductionRuntimeConfig(configFile), "config-unreadable"),
    "runtime config rejects group/world-readable permissions");
  chmodSync(configFile, 0o600);

  chmodSync(configFile, 0o400);
  ok(loadProductionRuntimeConfig(configFile).workspaceId === WORKSPACE_ID,
    "owner-only read-only 0400 runtime config is accepted");
  chmodSync(configFile, 0o600);

  ok(configError(() => loadProductionRuntimeConfig(configFile, {
    readHooks: {
      afterRead() {
        writeFileSync(configFile, configText.replace(WORKSPACE_ID, `ws_${"b".repeat(32)}`));
        const changed = new Date("2030-01-01T00:00:00.000Z");
        utimesSync(configFile, changed, changed);
      },
    },
  }), "config-unreadable"), "same-inode config mutation is rejected by post-read descriptor/path revalidation");
  writeFileSync(configFile, configText, { mode: 0o600 });

  const mismatchedWorkspace = structuredClone(validConfig());
  mismatchedWorkspace.workspaceId = `ws_${"b".repeat(32)}`;
  const mismatchedWorkspaceFile = join(runtimeDirectory, "mismatched-workspace.json");
  writeFileSync(mismatchedWorkspaceFile, `${JSON.stringify(mismatchedWorkspace)}\n`, { mode: 0o600 });
  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile: mismatchedWorkspaceFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
  }), "config-invalid-schema"), "runtime workspaceId must exactly match the durable workspace identity");

  const missingProject = structuredClone(validConfig());
  ((missingProject.projects as Record<string, unknown>[])[1]!).project = "missing";
  const missingProjectFile = join(runtimeDirectory, "missing-project.json");
  writeFileSync(missingProjectFile, `${JSON.stringify(missingProject)}\n`, { mode: 0o600 });
  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile: missingProjectFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
  }), "config-invalid-schema"), "every runtime project must already exist in workspace config.projects");

  const workspaceConfigFile = join(root, ".writing-loop", "config.json");
  writeFileSync(workspaceConfigFile, `${JSON.stringify({
    version: 1,
    projects: { demo: { enabled: false }, disabled: { enabled: true } },
  })}\n`);
  const workspacePausedRegistry = createProductionRuntimeRegistry({
    root,
    configFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
  });
  ok(workspacePausedRegistry.projects.find((entry) => entry.project === "demo")?.allowDispatch === false,
    "workspace pause disables fresh dispatch while retaining the project for reconciliation");
  writeFileSync(workspaceConfigFile, `${JSON.stringify({
    version: 1,
    projects: { demo: { enabled: true }, disabled: { enabled: true } },
  })}\n`);

  let backendRequests = 0;
  let backendAuthorization: string | null = null;
  const registry = createProductionRuntimeRegistry({
    root,
    configFile,
    env: {
      PRODUCTION_JOB_GATEWAY_TOKEN: "server-job-gateway-secret",
      PRODUCTION_GATEWAY_TOKEN: "server-gateway-secret",
    },
    fetchByBackend: {
      "comfy-primary": async (input, init) => {
        backendRequests++;
        backendAuthorization = new Headers(init?.headers).get("authorization");
        const body = JSON.parse(String(init?.body)) as {
          scope: { version: 1; workspaceId: string; project: string };
          backendInstanceId: string;
          remoteJobId: string;
        };
        const requestDigest = new Headers(init?.headers).get("x-writing-loop-request-digest")!;
        ok(new URL(input.toString()).pathname.includes(`/v1/scopes/${WORKSPACE_ID}/demo/jobs/`)
          && body.scope.workspaceId === WORKSPACE_ID && body.scope.project === "demo",
        "ProductionGatewayAdapter request path/body carry the exact project scope");
        return new Response(JSON.stringify({
          version: 1,
          scope: body.scope,
          backendInstanceId: body.backendInstanceId,
          remoteJobId: body.remoteJobId,
          requestDigest,
          submissionState: "accepted",
          submitResult: {
            remoteJobId: body.remoteJobId,
            acceptedAt: "2026-08-10T12:00:01.000Z",
            providerIdempotency: false,
            nodeErrorCount: 0,
            responseDigest: "d".repeat(64),
          },
          observation: null,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    gatewayFetch: async () => { throw new Error("assembly must not call gateway"); },
    now: () => "2026-08-10T12:00:00.000Z",
  });
  ok(backendRequests === 0, "registry assembly validates local artifacts without network I/O");
  ok(registry.projects.map((entry) => entry.project).join(",") === "demo,disabled",
    "instance registry retains configured paused projects for reconcile and never scans rogue workspace directories");
  ok(registry.projects[0]?.allowDispatch === true && registry.projects[1]?.allowDispatch === false,
    "runtime project enabled state maps to coordinator allowDispatch without disabling reconciliation");
  ok(registry.projects[0]?.backendInstanceIds.join(",") === "comfy-primary",
    "project registration carries conservative backend permits for the runner");
  const registryRound = await registry.runner.runOnceAll();
  ok(registryRound.outcomes.length === 2 && registryRound.outcomes[0]?.project === "demo"
    && registryRound.outcomes[1]?.project === "disabled"
    && registryRound.outcomes.every((entry) => entry.status === "succeeded"),
  "assembled runOnceAll executes only the explicit project registry");
  const execution = {
    version: 1 as const,
    operation: "comfyui-workflow" as const,
    modelFamily: "generic" as const,
    backendInstanceId: "comfy-primary",
    workflowSha256,
    modelSha256: SHA.model,
    parametersSha256: SHA.parameters,
  };
  const resolverIntent = { execution } as unknown as ProductionDispatchIntent;
  ok((await registry.projects[0]!.inputPipelineResolver.resolve(resolverIntent))?.policy === "static-pre-staged",
    "per-workflow static input policy resolves explicitly instead of enabling a project-wide fallback");
  const descriptor = await registry.workflowResolver.resolve(resolverIntent);
  ok(descriptor?.workflow !== WORKFLOW && productionWorkflowSha256(descriptor!.workflow) === workflowSha256,
    "workflow resolver rereads a digest-bound JSON graph and returns detached provider input");
  const mismatch = await registry.workflowResolver.resolve({
    execution: { ...execution, parametersSha256: "f".repeat(64) },
  } as unknown as ProductionDispatchIntent);
  ok(mismatch === null, "workflow resolver requires the complete immutable execution tuple");
  ok(await registry.projects[1]!.workflowResolver.resolve(resolverIntent) === null,
    "project-scoped workflow resolver rejects a tuple not present in its explicit projects allowlist");

  const gate = await registry.projects[0]!.gateContextResolver.resolve(
    resolverIntent,
    {} as Parameters<typeof registry.projects[0]["gateContextResolver"]["resolve"]>[1],
  );
  ok(gate.deploymentTerritories.join(",") === "CN" && gate.availableBudgetMicros === 2_000_000,
    "project-scoped gate resolver uses trusted deployment territory and budget configuration");
  ok(await registry.projects[0]!.intentResolver.resolve("missing-task") === null,
    "local intent resolver stays inside the registered project companion directory");

  ok(registry.adapterRegistry.resolve("comfy-primary") === null,
    "unscoped registry never exposes a project-scoped production gateway adapter");
  const adapter = registry.projects[0]!.adapterRegistry.resolve("comfy-primary")!;
  const remoteJobId = "11111111-1111-4111-8111-111111111111";
  const prepared = adapter.prepareSubmission({
    idempotencyKey: "intent-1", remoteJobId, workflow: WORKFLOW, inputBinding: null,
  });
  await adapter.submitPrepared(prepared);
  ok(backendAuthorization === "Bearer server-job-gateway-secret" && backendRequests === 1,
    "job gateway credential is resolved from the server environment and attached only at request time");
  ok(registry.projects[0]!.ingestor !== registry.projects[1]!.ingestor,
    "artifact ingestors are constructed per project and never shared across scopes");

  const missingInputPolicy = structuredClone(validConfig());
  delete (missingInputPolicy.workflows as Record<string, unknown>[])[0]!.inputPolicy;
  ok(configError(() => parseProductionRuntimeConfig(missingInputPolicy), "config-invalid-schema"),
    "workflow inputPolicy is required; omission defaults to fail-closed rather than static fallback");
  const unauthorizedWorkflowProject = structuredClone(validConfig());
  ((unauthorizedWorkflowProject.workflows as Record<string, unknown>[])[0]!).projects = ["ghost"];
  ok(configError(() => parseProductionRuntimeConfig(unauthorizedWorkflowProject), "config-invalid-schema"),
    "workflow projects allowlist cannot name an unregistered project");
  const missingStagingProfile = structuredClone(h3Config());
  (missingStagingProfile.stagingProfiles as unknown[]).pop();
  ok(configError(() => parseProductionRuntimeConfig(missingStagingProfile), "config-invalid-schema"),
    "scoped-staging workflow fails closed when its immutable staging profile is missing");
  const missingGraphContract = structuredClone(h3Config());
  delete (missingGraphContract.workflows as Record<string, unknown>[])[0]!.h3GraphContract;
  ok(configError(() => parseProductionRuntimeConfig(missingGraphContract), "config-invalid-schema"),
    "H3 workflow cannot omit its server-owned native graph contract");
  const derivedLengthDrift = structuredClone(h3Config());
  const driftedGeneratorContract = ((derivedLengthDrift.workflows as Record<string, unknown>[])[0]!
    .h3GraphContract as Record<string, Record<string, unknown>>).generator!;
  driftedGeneratorContract.length = 362;
  ok(configError(() => parseProductionRuntimeConfig(derivedLengthDrift), "config-invalid-schema"),
    "generator contract length cannot independently drift from immutable duration at 24fps/17k+5 alignment");
  const bundleArtifactDrift = structuredClone(h3Config());
  const driftedH3Contract = (bundleArtifactDrift.workflows as Record<string, unknown>[])[0]!
    .h3GraphContract as Record<string, unknown>;
  const driftedModelBundle = driftedH3Contract.modelBundle as Record<string, unknown>;
  const driftedAudioVae = driftedModelBundle.audioVae as Record<string, unknown>;
  driftedAudioVae.artifactSha256 = "f".repeat(64);
  ok(configError(() => parseProductionRuntimeConfig(bundleArtifactDrift), "config-invalid-schema"),
    "four-component model bundle digest rejects any single artifact attestation drift");
  const directH3Transport = structuredClone(h3Config());
  ((directH3Transport.stagingProfiles as Record<string, unknown>[])[0]!.execution as Record<string, unknown>)
    .operation = "minimax-h3";
  ok(configError(() => parseProductionRuntimeConfig(directH3Transport), "config-invalid-schema"),
    "H3 graph contract rejects direct minimax-h3 transport without a graph adapter");
  const rawComfyStaged = structuredClone(h3Config());
  (rawComfyStaged.backends as Record<string, unknown>[])[0] = {
    version: 1,
    backendInstanceId: H3_FL_EXECUTION.backendInstanceId,
    kind: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
    credentialEnv: null,
    preferJobsApi: false,
  };
  ok(configError(() => parseProductionRuntimeConfig(rawComfyStaged), "config-invalid-schema"),
    "scoped-staging workflow cannot target raw direct Comfy adapter without inputBinding support");

  const privateStagingProfile = structuredClone(h3Config());
  const privateProfileRow = (privateStagingProfile.stagingProfiles as Record<string, unknown>[])[0]!;
  privateProfileRow.baseUrl = "http://172.16.4.9:8188/stage";
  privateProfileRow.transport = "insecure-private-http";
  const parsedPrivateProfile = parseProductionRuntimeConfig(privateStagingProfile).stagingProfiles[0];
  ok(parsedPrivateProfile?.transport === "insecure-private-http"
    && parsedPrivateProfile.baseUrl === "http://172.16.4.9:8188/stage"
    && parsedPrivateProfile.credentialEnv === "PRODUCTION_STAGE_TOKEN"
    && parseProductionRuntimeConfig(h3Config()).stagingProfiles[0]?.transport === "tls",
  "staging profile accepts RFC1918 plaintext HTTP under the owner-only transport and defaults to tls");

  const ipv6StagingProfile = structuredClone(privateStagingProfile);
  ((ipv6StagingProfile.stagingProfiles as Record<string, unknown>[])[0]!).baseUrl = "http://[fd00::1]:8188/stage";
  ok(configError(() => parseProductionRuntimeConfig(ipv6StagingProfile), "config-invalid-schema"),
    "insecure-private-http is an IPv4-literal allowlist and rejects IPv6 hosts");

  const unknownTransport = structuredClone(privateStagingProfile);
  ((unknownTransport.stagingProfiles as Record<string, unknown>[])[0]!).transport = "plaintext";
  ok(configError(() => parseProductionRuntimeConfig(unknownTransport), "config-invalid-schema"),
    "transport accepts only the two declared values");
  const immutableH3Config = parseProductionRuntimeConfig(h3Config());
  const immutableH3Execution = immutableH3Config.stagingProfiles[0]!.execution;
  let nestedExecutionMutationRejected = false;
  try {
    (immutableH3Execution as unknown as Record<string, unknown>).durationSeconds = 9;
  } catch { nestedExecutionMutationRejected = true; }
  ok(nestedExecutionMutationRejected
    && Object.isFrozen(immutableH3Execution)
    && immutableH3Execution.modelFamily === "minimax-h3" && immutableH3Execution.durationSeconds === 8,
  "staging profile freezes its nested immutable execution identity against post-parse drift");

  const h3ConfigFile = join(runtimeDirectory, "h3-runtime.json");
  writeFileSync(h3ConfigFile, `${JSON.stringify(h3Config(), null, 2)}\n`, { mode: 0o600 });
  const graphAttestationRejected = (
    name: string,
    graph: Record<string, unknown>,
  ): boolean => {
    const driftConfig = structuredClone(h3Config());
    const digest = productionWorkflowSha256(graph);
    const driftWorkflow = (driftConfig.workflows as Record<string, unknown>[])[0]!;
    const driftProfile = (driftConfig.stagingProfiles as Record<string, unknown>[])[0]!;
    const graphFileName = `workflows/${name}.json`;
    driftWorkflow.workflowSha256 = digest;
    driftWorkflow.file = graphFileName;
    (driftProfile.execution as Record<string, unknown>).workflowSha256 = digest;
    const graphFile = join(runtimeDirectory, graphFileName);
    const driftConfigFile = join(runtimeDirectory, `${name}-runtime.json`);
    writeFileSync(graphFile, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(driftConfigFile, `${JSON.stringify(driftConfig, null, 2)}\n`, { mode: 0o600 });
    return configError(() => createProductionRuntimeRegistry({
      root,
      configFile: driftConfigFile,
      env: {
        PRODUCTION_JOB_GATEWAY_TOKEN: "server-job-gateway-secret",
        PRODUCTION_GATEWAY_TOKEN: "server-gateway-secret",
        PRODUCTION_STAGE_TOKEN: "server-stage-secret",
      },
    }), "workflow-invalid");
  };
  const durationDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((durationDriftGraph["10"] as Record<string, unknown>).inputs as Record<string, unknown>).length = 362;
  ok(graphAttestationRejected("h3-duration-drift", durationDriftGraph),
    "H3 registry rejects actual native generator duration 8→15 even when template digest is re-pinned");
  const classTypeDriftGraph = structuredClone(H3_FL_WORKFLOW);
  (classTypeDriftGraph["10"] as Record<string, unknown>).class_type = "UntrustedLookalikeH3Node";
  ok(graphAttestationRejected("h3-class-type-drift", classTypeDriftGraph),
    "H3 registry requires the exact native generator class_type selected by variant");
  const canvasDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((canvasDriftGraph["10"] as Record<string, unknown>).inputs as Record<string, unknown>).width = 1_344;
  ok(graphAttestationRejected("h3-canvas-drift", canvasDriftGraph),
    "H3 registry rejects actual generator width/height drift from the canonical 768x1344 canvas");
  const loaderDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((loaderDriftGraph[H3_FL_IDS.diffusion] as Record<string, unknown>).inputs as Record<string, unknown>).unet_name =
    "diffusion_models/rogue.safetensors";
  ok(graphAttestationRejected("h3-loader-drift", loaderDriftGraph),
    "H3 registry rejects actual UNETLoader alias drift from its trusted model attestation");
  const manifestDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((manifestDriftGraph[H3_FL_IDS.sigmaShift] as Record<string, unknown>).inputs as Record<string, unknown>).shift_video = 13;
  ok(graphAttestationRejected("h3-parameter-manifest-drift", manifestDriftGraph),
    "H3 registry recomputes parametersSha256 from actual SigmaShift/sampler literals");
  const clipLoaderDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((clipLoaderDriftGraph[H3_FL_IDS.textEncoder] as Record<string, unknown>).inputs as Record<string, unknown>)
    .clip_name = "minimax/rogue-qwen.safetensors";
  ok(graphAttestationRejected("h3-clip-loader-drift", clipLoaderDriftGraph),
    "H3 registry rejects Qwen text-encoder alias drift from the four-component bundle");
  const videoVaeDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((videoVaeDriftGraph[H3_FL_IDS.videoVae] as Record<string, unknown>).inputs as Record<string, unknown>)
    .vae_name = "minimax/rogue-video-vae.safetensors";
  ok(graphAttestationRejected("h3-video-vae-drift", videoVaeDriftGraph),
    "H3 registry rejects video VAE alias drift from the four-component bundle");
  const audioVaeLinkDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((audioVaeLinkDriftGraph[H3_FL_IDS.audioDecode] as Record<string, unknown>).inputs as Record<string, unknown>)
    .vae = [H3_FL_IDS.videoVae, 0];
  ok(graphAttestationRejected("h3-audio-vae-link-drift", audioVaeLinkDriftGraph),
    "H3 registry requires the attested audio VAE on the active audio decode path");
  const extraDecoyGraph = structuredClone(H3_FL_WORKFLOW);
  extraDecoyGraph["999"] = { class_type: "SaveVideo", inputs: {
    video: [H3_FL_IDS.createVideo, 0], filename_prefix: "video/rogue", format: "auto", codec: "auto",
  } };
  ok(graphAttestationRejected("h3-extra-output-decoy", extraDecoyGraph),
    "H3 registry rejects every extra/decoy node, including a second output branch");
  const rogueOutputGraph = structuredClone(H3_FL_WORKFLOW);
  ((rogueOutputGraph[H3_FL_IDS.saveVideo] as Record<string, unknown>).inputs as Record<string, unknown>)
    .video = [H3_FL_IDS.generator, 1];
  ok(graphAttestationRejected("h3-rogue-output-edge", rogueOutputGraph),
    "H3 registry pins the unique SaveVideo to the exact active decode/create DAG");
  const sourceLinkDriftGraph = structuredClone(H3_FL_WORKFLOW);
  ((sourceLinkDriftGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>)
    .first_frame = ["101", 0];
  ok(graphAttestationRejected("h3-source-link-drift", sourceLinkDriftGraph),
    "H3 registry rejects staged source fan-in/link drift even after template digest is re-pinned");
  const sourceClassDriftGraph = structuredClone(H3_FL_WORKFLOW);
  (sourceClassDriftGraph["100"] as Record<string, unknown>).class_type = "LoadImageLookalike";
  ok(graphAttestationRejected("h3-source-class-drift", sourceClassDriftGraph),
    "H3 registry accepts only native LoadImage/image/output-0 stage sources");
  const wrongOutputIndexGraph = structuredClone(H3_FL_WORKFLOW);
  ((wrongOutputIndexGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>)
    .first_frame = ["100", 1];
  const tripleLinkGraph = structuredClone(H3_FL_WORKFLOW);
  ((tripleLinkGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>)
    .first_frame = ["100", 0, "decoy"];
  const numericLinkGraph = structuredClone(H3_FL_WORKFLOW);
  ((numericLinkGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>)
    .first_frame = 100;
  ok(graphAttestationRejected("h3-source-wrong-output", wrongOutputIndexGraph)
    && graphAttestationRejected("h3-source-triple-link", tripleLinkGraph)
    && graphAttestationRejected("h3-source-numeric-link", numericLinkGraph),
  "H3 source links reject wrong output index, tuple arity and numeric lookalikes");

  const parsedH3 = parseProductionRuntimeConfig(h3Config());
  const flStageContracts = parsedH3.stagingProfiles[0]!.bindings;
  const baseParameterDigest = productionH3ParameterManifestSha256(
    H3_FL_WORKFLOW, H3_FL_CONTRACT, H3_FL_EXECUTION,
  );
  const widthProjectionGraph = structuredClone(H3_FL_WORKFLOW);
  ((widthProjectionGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>).width = 800;
  const heightProjectionGraph = structuredClone(H3_FL_WORKFLOW);
  ((heightProjectionGraph[H3_FL_IDS.generator] as Record<string, unknown>).inputs as Record<string, unknown>).height = 1_312;
  ok(baseParameterDigest !== productionH3ParameterManifestSha256(
    widthProjectionGraph, H3_FL_CONTRACT, H3_FL_EXECUTION,
  ) && baseParameterDigest !== productionH3ParameterManifestSha256(
    heightProjectionGraph, H3_FL_CONTRACT, H3_FL_EXECUTION,
  ), "fixed H3 parameter projection contains width and height exactly as distinct inference parameters");

  const oneFrameWorkflow = h3Workflow(H3_FL_IDS, "fl2va", ["100"]);
  const oneFrameExecution: ProductionIntentExecution = {
    ...H3_FL_EXECUTION,
    workflowSha256: productionWorkflowSha256(oneFrameWorkflow),
  };
  let oneFrameAccepted = true;
  try {
    assertProductionH3Template(
      oneFrameWorkflow, H3_FL_CONTRACT, oneFrameExecution, [flStageContracts[0]!], "h3-fl-profile",
    );
  } catch { oneFrameAccepted = false; }
  ok(oneFrameAccepted, "canonical fl2va v1 accepts first_frame-only as well as first+last official optional inputs");

  const receiptBindingsA = flStageContracts.map((binding) => ({
    index: binding.index,
    slot: binding.slot,
    assetSha256: binding.index === 0 ? "2".repeat(64) : "3".repeat(64),
    providerObjectKey: `cas/take-a/${binding.index}.png`,
  }));
  const receiptBindingsB = receiptBindingsA.map((binding) => ({
    ...binding, providerObjectKey: binding.providerObjectKey.replace("take-a", "take-b"),
  }));
  const templateBeforeMaterialization = JSON.stringify(H3_FL_WORKFLOW);
  const materializedA = materializeProductionH3Workflow(
    H3_FL_WORKFLOW, H3_FL_CONTRACT, H3_FL_EXECUTION, flStageContracts, receiptBindingsA, "h3-fl-profile",
  );
  const materializedARepeat = materializeProductionH3Workflow(
    H3_FL_WORKFLOW, H3_FL_CONTRACT, H3_FL_EXECUTION, flStageContracts, receiptBindingsA, "h3-fl-profile",
  );
  const materializedB = materializeProductionH3Workflow(
    H3_FL_WORKFLOW, H3_FL_CONTRACT, H3_FL_EXECUTION, flStageContracts, receiptBindingsB, "h3-fl-profile",
  );
  const boundFirstSource = ((materializedA.workflow["100"] as Record<string, unknown>).inputs as Record<string, unknown>).image;
  ok(JSON.stringify(H3_FL_WORKFLOW) === templateBeforeMaterialization
    && materializedA.templateWorkflowSha256 === H3_FL_EXECUTION.workflowSha256
    && materializedA.boundWorkflowSha256 !== materializedA.templateWorkflowSha256
    && materializedA.boundWorkflowSha256 === materializedARepeat.boundWorkflowSha256
    && materializedA.boundWorkflowSha256 !== materializedB.boundWorkflowSha256
    && boundFirstSource === receiptBindingsA[0]!.providerObjectKey,
  "materializer keeps the template immutable and produces stable, per-stage bound workflows/digests");
  const reorderedTemplate = Object.fromEntries(Object.entries(H3_FL_WORKFLOW).reverse());
  const reorderedMaterialized = materializeProductionH3Workflow(
    reorderedTemplate, H3_FL_CONTRACT, H3_FL_EXECUTION, flStageContracts, receiptBindingsA, "h3-fl-profile",
  );
  ok(productionWorkflowSha256(reorderedTemplate) === H3_FL_EXECUTION.workflowSha256
    && reorderedMaterialized.boundWorkflowSha256 === materializedA.boundWorkflowSha256,
  "workflow identity uses shared canonical JSON and is invariant to harmless object-key insertion order");
  let traversalRejected = false;
  try {
    materializeProductionH3Workflow(
      H3_FL_WORKFLOW, H3_FL_CONTRACT, H3_FL_EXECUTION, flStageContracts,
      [{ ...receiptBindingsA[0]!, providerObjectKey: "cas/../outside.png" }, receiptBindingsA[1]!],
      "h3-fl-profile",
    );
  } catch (error) { traversalRejected = error instanceof ProductionH3GraphError; }
  ok(traversalRejected && JSON.stringify(H3_FL_WORKFLOW) === templateBeforeMaterialization,
    "providerObjectKey traversal is rejected before any bound graph is returned or template is mutated");
  let stageMode: "valid" | "reordered" = "valid";
  let stageRequests = 0;
  const stageFetch = (
    slots: readonly string[],
    providerKeys: readonly string[],
  ) => async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    stageRequests++;
    const headers = new Headers(init?.headers);
    const request = JSON.parse(String(init?.body)) as {
      stageKey: string;
      scope: { workspaceId: string; project: string };
      inputs: Array<{ index: number; asset: { sha256: string } }>;
    };
    ok(headers.get("authorization") === "Bearer server-stage-secret"
      && request.scope.workspaceId === WORKSPACE_ID && request.scope.project === "demo"
      && new URL(input.toString()).pathname.includes(`/v1/scopes/${WORKSPACE_ID}/demo/stages/${request.stageKey}`),
    "H3 input stager keeps credential and exact scope on the server-owned stage route");
    let bindings = request.inputs.map((entry, index) => ({
      index,
      slot: slots[index]!,
      assetSha256: entry.asset.sha256,
      providerObjectKey: providerKeys[index]!,
    }));
    if (stageMode === "reordered") bindings = [...bindings].reverse();
    return new Response(JSON.stringify({
      version: 1,
      stageKey: request.stageKey,
      bindingsDigest: productionInputBindingsDigest(bindings),
      bindings,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const h3Registry = createProductionRuntimeRegistry({
    root,
    configFile: h3ConfigFile,
    env: {
      PRODUCTION_JOB_GATEWAY_TOKEN: "server-job-gateway-secret",
      PRODUCTION_GATEWAY_TOKEN: "server-gateway-secret",
      PRODUCTION_STAGE_TOKEN: "server-stage-secret",
    },
    stagingFetchByProfile: {
      "h3-fl-profile": stageFetch(
        ["first_frame", "last_frame"], ["staged/fl-first.png", "staged/fl-last.png"],
      ),
      "h3-ref-profile": stageFetch(
        ["reference.0", "reference.1"], ["staged/ref-0.png", "staged/ref-1.png"],
      ),
    },
    gatewayFetch: async () => { throw new Error("assembly must not ingest"); },
  });
  ok(stageRequests === 0, "H3 runtime assembly performs no staging or provider network I/O");

  const flIntent = h3Intent("take-h3-fl", H3_FL_EXECUTION);
  const flPipeline = await h3Registry.projects[0]!.inputPipelineResolver.resolve(flIntent);
  const flDescriptor = await h3Registry.projects[0]!.workflowResolver.resolve(flIntent);
  ok(flPipeline?.policy === "scoped-staging" && flDescriptor?.modelFamily === "minimax-h3",
    "H3 fl2va resolves an exact project-authorized scoped staging pipeline and pinned graph");
  if (flPipeline?.policy !== "scoped-staging" || flDescriptor === null) throw new Error("fl2va fixture did not resolve");
  const flStaged = await flPipeline.inputStager.stage(flIntent);
  const flProof = await flPipeline.workflowBindingVerifier.verify(flIntent, flDescriptor.workflow, flStaged);
  ok(flProof.verified && flProof.stageKey === flStaged.stageKey
    && flProof.bindingsDigest === flStaged.bindingsDigest
    && flProof.templateWorkflowSha256 === flIntent.execution.workflowSha256
    && flProof.boundWorkflowSha256 !== flProof.templateWorkflowSha256
    && (((flProof.workflow["100"] as Record<string, unknown>).inputs as Record<string, unknown>).image)
      === flStaged.bindings[0]!.providerObjectKey,
  "concrete fl2va verifier materializes every ordered staged key into its exact source and returns the bound graph");

  const refIntent = h3Intent("take-h3-ref", H3_REF_EXECUTION);
  const refPipeline = await h3Registry.projects[0]!.inputPipelineResolver.resolve(refIntent);
  const refDescriptor = await h3Registry.projects[0]!.workflowResolver.resolve(refIntent);
  if (refPipeline?.policy !== "scoped-staging" || refDescriptor === null) throw new Error("ref2va fixture did not resolve");
  const refStaged = await refPipeline.inputStager.stage(refIntent);
  const refProof = await refPipeline.workflowBindingVerifier.verify(refIntent, refDescriptor.workflow, refStaged);
  ok(refProof.verified && refStaged.bindings.map((binding) => binding.slot).join(",") === "reference.0,reference.1",
    "concrete ref2va profile preserves and verifies ordered reference slots");

  stageMode = "reordered";
  let reorderedRejected = false;
  try { await flPipeline.inputStager.stage(flIntent); }
  catch { reorderedRejected = true; }
  ok(reorderedRejected, "H3 gateway binding reordering is rejected before graph verification");
  stageMode = "valid";

  const missingGraphBinding = structuredClone(flDescriptor.workflow);
  delete ((missingGraphBinding["10"] as Record<string, unknown>).inputs as Record<string, unknown>).last_frame;
  let missingGraphBindingRejected = false;
  try { await flPipeline.workflowBindingVerifier.verify(flIntent, missingGraphBinding, flStaged); }
  catch { missingGraphBindingRejected = true; }
  ok(missingGraphBindingRejected, "H3 graph missing one configured staged input is rejected");
  const driftedGraph = structuredClone(flDescriptor.workflow);
  (((driftedGraph["10"] as Record<string, unknown>).inputs as Record<string, unknown>).first_frame) = "staged/drift.png";
  let graphDriftRejected = false;
  try { await flPipeline.workflowBindingVerifier.verify(flIntent, driftedGraph, flStaged); }
  catch { graphDriftRejected = true; }
  ok(graphDriftRejected, "H3 graph/provider-object binding drift is rejected by the concrete verifier");
  ok(await h3Registry.projects[0]!.inputPipelineResolver.resolve({
    ...flIntent,
    execution: { ...H3_FL_EXECUTION, durationSeconds: 9 },
  } as ProductionDispatchIntent) === null,
  "H3 profile resolution binds the complete execution tuple, including duration/variant/aspect fields");

  writeFileSync(workflowFile, workflowText.replace("pre-staged/static only", "changed/static content"));
  ok(await rejectsConfig(() => registry.workflowResolver.resolve(resolverIntent), "workflow-invalid"),
    "post-start workflow drift is rejected before backend submission");
  writeFileSync(workflowFile, workflowText, { mode: 0o600 });

  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "server-job-gateway-secret" },
  }), "credential-unavailable"), "registry assembly fails closed when a credential environment variable is missing");

  const workflowSymlink = join(workflowDirectory, "linked.json");
  symlinkSync(workflowFile, workflowSymlink);
  const linkedConfig = structuredClone(validConfig());
  ((linkedConfig.workflows as Record<string, unknown>[])[0]!).file = "workflows/linked.json";
  const linkedConfigFile = join(runtimeDirectory, "linked-runtime.json");
  writeFileSync(linkedConfigFile, `${JSON.stringify(linkedConfig)}\n`, { mode: 0o600 });
  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile: linkedConfigFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
  }), "workflow-unreadable"), "workflow resolver rejects symlink-backed registered artifacts");
  unlinkSync(workflowSymlink);

  const workflowHardlink = join(workflowDirectory, "hardlinked.json");
  linkSync(workflowFile, workflowHardlink);
  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
  }), "workflow-unreadable"), "workflow resolver rejects a multiply-linked registered artifact");
  unlinkSync(workflowHardlink);

  let mutatedDuringWorkflowRead = false;
  ok(configError(() => createProductionRuntimeRegistry({
    root,
    configFile,
    env: { PRODUCTION_JOB_GATEWAY_TOKEN: "a", PRODUCTION_GATEWAY_TOKEN: "b" },
    workflowReadHooks: {
      "workflows/static-t2v.json": {
        afterRead() {
          mutatedDuringWorkflowRead = true;
          writeFileSync(workflowFile, workflowText.replace("pre-staged/static only", "changed/static content"));
          const changed = new Date("2031-01-01T00:00:00.000Z");
          utimesSync(workflowFile, changed, changed);
        },
      },
    },
  }), "workflow-unreadable") && mutatedDuringWorkflowRead,
  "same-inode workflow mutation is rejected by exact descriptor/path revalidation");
  writeFileSync(workflowFile, workflowText, { mode: 0o600 });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fails) {
  console.error(`\n${fails} production runtime config test(s) failed`);
  process.exit(1);
}
console.log("\nproduction runtime config tests OK");
