// H3 graph contract v1/v2 (§5.3).
//
// v1 keeps `generator.prompt` and `RandomNoise.noise_seed` as pinned literals; v2 replaces both with
// `writing-loop://shot-request/<profileId>/prompt|seed`, adds the index 0 `shot-request` stage slot
// and fills the per-shot values at materialization. The packaged representative example pins that
// the v1 path is byte-for-byte unchanged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCTION_H3_SHOT_REQUEST_SLOT,
  ProductionH3GraphError,
  assertProductionH3ExecutionContract,
  assertProductionH3Template,
  materializeProductionH3Workflow,
  parseProductionH3GraphContract,
  parseProductionH3StageBindingContract,
  productionH3ModelBundleSha256,
  productionH3ParameterManifestSha256,
  productionH3ShotRequestSentinel,
  productionH3StageInputSentinel,
  productionH3WorkflowSha256,
  type ProductionH3GraphContract,
  type ProductionH3ReceiptBinding,
  type ProductionH3StageBindingContract,
} from "../src/production-h3-graph.ts";
import {
  parseProductionIntentExecution,
  type ProductionIntentExecution,
} from "../src/production-intent.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const rejects = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) {
    return error instanceof ProductionH3GraphError && error.message.includes(needle);
  }
};

const PROFILE_ID = "h3-fl2va-portrait-v2";
const BACKEND = "gateway-h3-fl2va";
const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);

type Variant = "fl2va" | "ref2va";

function modelComponent(
  role: string,
  classType: "UNETLoader" | "CLIPLoader" | "VAELoader",
  inputName: "unet_name" | "clip_name" | "vae_name",
  nodeId: string,
): Record<string, unknown> {
  return {
    version: 1,
    nodeId,
    classType,
    inputName,
    modelAlias: `minimax-h3/${role}.safetensors`,
    artifactSha256: SHA(role.length % 2 === 0 ? "a" : "b"),
  };
}

function contractFor(
  variant: Variant,
  graphVersion: 1 | 2,
): { contract: Record<string, unknown>; bundleSha256: string } {
  const bundle = {
    version: 1 as const,
    diffusion: modelComponent("diffusion", "UNETLoader", "unet_name", "10"),
    textEncoder: modelComponent("text-encoder", "CLIPLoader", "clip_name", "11"),
    videoVae: modelComponent("video-vae", "VAELoader", "vae_name", "12"),
    audioVae: modelComponent("audio-vae", "VAELoader", "vae_name", "13"),
  };
  const bundleSha256 = productionH3ModelBundleSha256(bundle as never);
  return {
    contract: {
      version: graphVersion,
      generator: {
        version: 1,
        nodeId: "1",
        classType: variant === "fl2va" ? "MiniMaxH3ImageToVideo" : "MiniMaxH3ReferenceToVideo",
        width: 768,
        height: 1_344,
        length: 192,
      },
      modelBundle: { ...bundle, sha256: bundleSha256 },
      pipeline: {
        version: 1,
        sigmaShift: { version: 1, nodeId: "20", classType: "MiniMaxH3SigmaShift" },
        guider: { version: 1, nodeId: "21", classType: "BasicGuider" },
        scheduler: { version: 1, nodeId: "22", classType: "BasicScheduler" },
        samplerSelect: { version: 1, nodeId: "23", classType: "KSamplerSelect" },
        noise: { version: 1, nodeId: "24", classType: "RandomNoise" },
        sampler: { version: 1, nodeId: "25", classType: "SamplerCustomAdvanced" },
        videoDecode: { version: 1, nodeId: "26", classType: "VAEDecode" },
        audioDecode: { version: 1, nodeId: "27", classType: "VAEDecodeAudio" },
        createVideo: { version: 1, nodeId: "28", classType: "CreateVideo" },
        saveVideo: { version: 1, nodeId: "29", classType: "SaveVideo" },
      },
      // Replaced once the template exists; the projection never reads this field.
      parameterManifest: { version: 1, sha256: SHA("c") },
    },
    bundleSha256,
  };
}

function bindingsFor(
  variant: Variant,
  graphVersion: 1 | 2,
  imageSlots: number,
): ProductionH3StageBindingContract[] {
  const rows: unknown[] = [];
  if (graphVersion === 2) {
    rows.push({
      version: 1, index: 0, slot: PRODUCTION_H3_SHOT_REQUEST_SLOT, source: null, consumer: null,
    });
  }
  const offset = graphVersion === 2 ? 1 : 0;
  for (let position = 0; position < imageSlots; position++) {
    const slot = variant === "fl2va"
      ? position === 0 ? "first_frame" : "last_frame"
      : `reference.${position}`;
    rows.push({
      version: 1,
      index: position + offset,
      slot,
      source: {
        version: 1, nodeId: `${100 + position}`, classType: "LoadImage", inputName: "image", outputIndex: 0,
      },
      consumer: {
        version: 1,
        nodeId: "1",
        inputName: variant === "fl2va" ? slot : `ref_images.ref_image_${position}`,
      },
    });
  }
  return rows.map((row, index) => parseProductionH3StageBindingContract(row, index));
}

function templateFor(
  contract: ProductionH3GraphContract,
  variant: Variant,
  bindings: readonly ProductionH3StageBindingContract[],
  profileId: string,
): Record<string, unknown> {
  const bundle = contract.modelBundle;
  const pipeline = contract.pipeline;
  const generatorInputs: Record<string, unknown> = {
    clip: [bundle.textEncoder.nodeId, 0],
    vae: [bundle.videoVae.nodeId, 0],
    prompt: contract.version === 2
      ? productionH3ShotRequestSentinel(profileId, "prompt")
      : "cinematic short-drama shot",
    width: contract.generator.width,
    height: contract.generator.height,
    length: contract.generator.length,
  };
  if (variant === "ref2va") {
    generatorInputs.audio_vae = [bundle.audioVae.nodeId, 0];
    generatorInputs.ref_image_size = "match";
  }
  for (const binding of bindings) {
    if (binding.consumer === null || binding.source === null) continue;
    generatorInputs[binding.consumer.inputName] = [binding.source.nodeId, 0];
  }
  const workflow: Record<string, unknown> = {
    [contract.generator.nodeId]: { class_type: contract.generator.classType, inputs: generatorInputs },
    [bundle.diffusion.nodeId]: {
      class_type: "UNETLoader",
      inputs: { unet_name: bundle.diffusion.modelAlias, weight_dtype: "default" },
    },
    [bundle.textEncoder.nodeId]: {
      class_type: "CLIPLoader",
      inputs: { clip_name: bundle.textEncoder.modelAlias, type: "minimax", device: "default" },
    },
    [bundle.videoVae.nodeId]: { class_type: "VAELoader", inputs: { vae_name: bundle.videoVae.modelAlias } },
    [bundle.audioVae.nodeId]: { class_type: "VAELoader", inputs: { vae_name: bundle.audioVae.modelAlias } },
    [pipeline.sigmaShift.nodeId]: {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: [bundle.diffusion.nodeId, 0], shift_video: 12, shift_audio: 3 },
    },
    [pipeline.guider.nodeId]: {
      class_type: "BasicGuider",
      inputs: { model: [pipeline.sigmaShift.nodeId, 0], conditioning: [contract.generator.nodeId, 0] },
    },
    [pipeline.scheduler.nodeId]: {
      class_type: "BasicScheduler",
      inputs: { model: [pipeline.sigmaShift.nodeId, 0], scheduler: "simple", steps: 30, denoise: 1 },
    },
    [pipeline.samplerSelect.nodeId]: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    [pipeline.noise.nodeId]: {
      class_type: "RandomNoise",
      inputs: {
        noise_seed: contract.version === 2 ? productionH3ShotRequestSentinel(profileId, "seed") : 42,
      },
    },
    [pipeline.sampler.nodeId]: {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: [pipeline.noise.nodeId, 0],
        guider: [pipeline.guider.nodeId, 0],
        sampler: [pipeline.samplerSelect.nodeId, 0],
        sigmas: [pipeline.scheduler.nodeId, 0],
        latent_image: [contract.generator.nodeId, 1],
      },
    },
    [pipeline.videoDecode.nodeId]: {
      class_type: "VAEDecode",
      inputs: { samples: [pipeline.sampler.nodeId, 0], vae: [bundle.videoVae.nodeId, 0] },
    },
    [pipeline.audioDecode.nodeId]: {
      class_type: "VAEDecodeAudio",
      inputs: { samples: [pipeline.sampler.nodeId, 0], vae: [bundle.audioVae.nodeId, 0] },
    },
    [pipeline.createVideo.nodeId]: {
      class_type: "CreateVideo",
      inputs: {
        images: [pipeline.videoDecode.nodeId, 0], fps: 24,
        audio: [pipeline.audioDecode.nodeId, 0], bit_depth: 8,
      },
    },
    [pipeline.saveVideo.nodeId]: {
      class_type: "SaveVideo",
      inputs: {
        video: [pipeline.createVideo.nodeId, 0],
        filename_prefix: "video/writing-loop-h3", format: "auto", codec: "auto",
      },
    },
  };
  for (const binding of bindings) {
    if (binding.source === null) continue;
    workflow[binding.source.nodeId] = {
      class_type: "LoadImage",
      inputs: {
        image: productionH3StageInputSentinel(profileId, binding.index, binding.slot),
      },
    };
  }
  return workflow;
}

type Fixture = {
  contract: ProductionH3GraphContract;
  execution: ProductionIntentExecution;
  bindings: ProductionH3StageBindingContract[];
  workflow: Record<string, unknown>;
};

function fixture(
  variant: Variant,
  graphVersion: 1 | 2,
  imageSlots: number,
  profileId = PROFILE_ID,
): Fixture {
  const raw = contractFor(variant, graphVersion);
  const bindings = bindingsFor(variant, graphVersion, imageSlots);
  const draftContract = parseProductionH3GraphContract({
    ...raw.contract,
    parameterManifest: { version: 1, sha256: SHA("c") },
  });
  const workflow = templateFor(draftContract, variant, bindings, profileId);
  const parametersSha256 = productionH3ParameterManifestSha256(workflow, draftContract, ({
    version: 1,
    operation: "comfyui-workflow",
    modelFamily: "minimax-h3",
    backendInstanceId: BACKEND,
    workflowSha256: SHA("d"),
    modelSha256: raw.bundleSha256,
    parametersSha256: SHA("c"),
    variant,
    durationSeconds: 8,
    shortEdge: 768,
    aspectRatio: "9:16",
  } as unknown) as ProductionIntentExecution);
  const contract = parseProductionH3GraphContract({
    ...raw.contract,
    parameterManifest: { version: 1, sha256: parametersSha256 },
  });
  const execution = parseProductionIntentExecution({
    version: 1,
    operation: "comfyui-workflow",
    modelFamily: "minimax-h3",
    backendInstanceId: BACKEND,
    workflowSha256: productionH3WorkflowSha256(workflow),
    modelSha256: raw.bundleSha256,
    parametersSha256,
    variant,
    durationSeconds: 8,
    shortEdge: 768,
    aspectRatio: "9:16",
  });
  return { contract, execution, bindings, workflow };
}

const receipt = (
  bindings: readonly ProductionH3StageBindingContract[],
): ProductionH3ReceiptBinding[] => bindings.map((binding) => ({
  index: binding.index,
  slot: binding.slot,
  assetSha256: SHA(String(binding.index)),
  providerObjectKey: `writing-loop/objects/sha256/${binding.index}${SHA("e").slice(1)}`,
}));

// —— 契约 v1：既有路径不变 ——
const v1 = fixture("fl2va", 1, 2);
assertProductionH3Template(v1.workflow, v1.contract, v1.execution, v1.bindings, PROFILE_ID);
const v1Bound = materializeProductionH3Workflow(
  v1.workflow, v1.contract, v1.execution, v1.bindings, receipt(v1.bindings), PROFILE_ID,
);
ok(v1Bound.templateWorkflowSha256 === v1.execution.workflowSha256
  && v1Bound.boundWorkflowSha256 !== v1Bound.templateWorkflowSha256
  && ((v1Bound.workflow["24"] as Record<string, unknown>).inputs as Record<string, unknown>).noise_seed === 42,
"契约 v1 的 prompt / seed 仍是 pinned 字面量，materialize 只替换 LoadImage 输入");
ok(rejects(() => materializeProductionH3Workflow(
  v1.workflow, v1.contract, v1.execution, v1.bindings, receipt(v1.bindings), PROFILE_ID,
  { prompt: "x", seed: 1 },
), "v1 does not accept a per-shot binding"), "契约 v1 拒绝逐镜 prompt / seed 绑定");
const v2Bindings = bindingsFor("fl2va", 2, 1);
ok(rejects(() => assertProductionH3ExecutionContract(v1.contract, v1.execution, v2Bindings),
  "stage binding 0 does not match the exact variant dataflow"),
"契约 v1 不接受 shot-request slot：index 0 必须是本 variant 的首个 LoadImage 绑定");
ok(rejects(() => parseProductionH3StageBindingContract({
  version: 1, index: 1, slot: PRODUCTION_H3_SHOT_REQUEST_SLOT, source: null, consumer: null,
}, 1), "index 0"), "shot-request slot 只能出现在 index 0");
ok(rejects(() => parseProductionH3StageBindingContract({
  version: 1,
  index: 0,
  slot: PRODUCTION_H3_SHOT_REQUEST_SLOT,
  source: { version: 1, nodeId: "100", classType: "LoadImage", inputName: "image", outputIndex: 0 },
  consumer: { version: 1, nodeId: "1", inputName: "first_frame" },
}, 0), "must not bind a LoadImage node"), "shot-request slot 不得绑定 LoadImage 节点");

// —— 契约 v2：sentinel 模板与逐镜 materialize ——
const v2 = fixture("fl2va", 2, 2);
assertProductionH3Template(v2.workflow, v2.contract, v2.execution, v2.bindings, PROFILE_ID);
ok(v2.bindings[0]?.slot === PRODUCTION_H3_SHOT_REQUEST_SLOT && v2.bindings[0].source === null
  && v2.bindings[1]?.slot === "first_frame" && v2.bindings[1].index === 1
  && v2.bindings[1].consumer?.inputName === "first_frame"
  && v2.bindings[2]?.slot === "last_frame" && v2.bindings[2].index === 2,
"契约 v2 的 index 0 固定为不绑定 LoadImage 的 shot-request slot，LoadImage 绑定 index 顺延");
ok(((v2.workflow["1"] as Record<string, unknown>).inputs as Record<string, unknown>).prompt
    === `writing-loop://shot-request/${PROFILE_ID}/prompt`
  && ((v2.workflow["24"] as Record<string, unknown>).inputs as Record<string, unknown>).noise_seed
    === `writing-loop://shot-request/${PROFILE_ID}/seed`,
"契约 v2 的 pinned graph 以 sentinel 承载 prompt 与 noise_seed");

const v2Bound = materializeProductionH3Workflow(
  v2.workflow, v2.contract, v2.execution, v2.bindings, receipt(v2.bindings), PROFILE_ID,
  { prompt: "夜色中的天台，人物背对镜头", seed: 4_294_967_295 },
);
const boundGenerator = (v2Bound.workflow["1"] as Record<string, unknown>).inputs as Record<string, unknown>;
const boundNoise = (v2Bound.workflow["24"] as Record<string, unknown>).inputs as Record<string, unknown>;
ok(boundGenerator.prompt === "夜色中的天台，人物背对镜头" && boundNoise.noise_seed === 4_294_967_295
  && v2Bound.templateWorkflowSha256 === v2.execution.workflowSha256,
"materialize 从 ShotRequest 填入实际 prompt 与 seed 并保持 template digest 不变");

const otherShot = materializeProductionH3Workflow(
  v2.workflow, v2.contract, v2.execution, v2.bindings, receipt(v2.bindings), PROFILE_ID,
  { prompt: "另一镜的提示词", seed: 7 },
);
ok(otherShot.boundWorkflowSha256 !== v2Bound.boundWorkflowSha256
  && productionH3ParameterManifestSha256(otherShot.workflow, v2.contract, v2.execution)
    === v2.contract.parameterManifest.sha256
  && productionH3ParameterManifestSha256(v2Bound.workflow, v2.contract, v2.execution)
    === v2.contract.parameterManifest.sha256,
"参数投影对 sentinel 计算：同一 profile 的每个镜头共用一份 parametersSha256");

ok(rejects(() => materializeProductionH3Workflow(
  v2.workflow, v2.contract, v2.execution, v2.bindings, receipt(v2.bindings), PROFILE_ID,
), "v2 requires the staged ShotRequest"), "契约 v2 缺逐镜 prompt / seed 时拒绝 materialize");
ok(rejects(() => materializeProductionH3Workflow(
  v2.workflow, v2.contract, v2.execution, v2.bindings, receipt(v2.bindings), PROFILE_ID,
  { prompt: "x", seed: 4_294_967_296 },
), "H3 shot binding seed"), "逐镜 seed 超出 uint32 时拒绝");
ok(rejects(() => materializeProductionH3Workflow(
  v2.workflow, v2.contract, v2.execution, v2.bindings, receipt(v2.bindings), PROFILE_ID,
  { prompt: "", seed: 1 },
), "H3 shot binding prompt"), "逐镜 prompt 为空时拒绝");

const literalPrompt = structuredClone(v2.workflow);
((literalPrompt["1"] as Record<string, unknown>).inputs as Record<string, unknown>).prompt = "写死的提示词";
ok(rejects(() => assertProductionH3Template(
  literalPrompt, v2.contract, v2.execution, v2.bindings, PROFILE_ID,
), "prompt does not contain the fixed contract v2 sentinel"), "契约 v2 拒绝把 prompt 写成字面量的模板");
const literalSeed = structuredClone(v2.workflow);
((literalSeed["24"] as Record<string, unknown>).inputs as Record<string, unknown>).noise_seed = 42;
ok(rejects(() => assertProductionH3Template(
  literalSeed, v2.contract, v2.execution, v2.bindings, PROFILE_ID,
), "seed does not contain the fixed contract v2 sentinel"), "契约 v2 拒绝把 noise_seed 写成字面量的模板");
const foreignProfile = fixture("fl2va", 2, 2, "h3-other-profile");
ok(rejects(() => assertProductionH3Template(
  foreignProfile.workflow, v2.contract, v2.execution, v2.bindings, PROFILE_ID,
), "sentinel"), "sentinel 里的 profileId 必须与本 profile 一致");

// v2 without the shot-request slot: the binding list no longer starts at index 0 with it.
const missingShotRequest = bindingsFor("fl2va", 1, 2);
ok(rejects(() => assertProductionH3ExecutionContract(v2.contract, v2.execution, missingShotRequest),
  "contract v2 requires the index 0 shot-request stage slot"),
"契约 v2 缺 index 0 shot-request slot 时拒绝");

// ref2va under v2: LoadImage consumers keep `ref_image_<position>` while the slot index shifts.
const ref2va = fixture("ref2va", 2, 3);
assertProductionH3Template(ref2va.workflow, ref2va.contract, ref2va.execution, ref2va.bindings, PROFILE_ID);
ok(ref2va.bindings[1]?.slot === "reference.0"
  && ref2va.bindings[1].consumer?.inputName === "ref_images.ref_image_0"
  && ref2va.bindings[3]?.slot === "reference.2"
  && ref2va.bindings[3].consumer?.inputName === "ref_images.ref_image_2",
"契约 v2 的 ref2va 参考绑定按 LoadImage 位置编号，index 因 shot-request 顺延一位");

// —— 打包示例钉住 v1 路径逐字节不变 ——
const exampleRoot = join(import.meta.dirname, "..", "examples", "production", "representative-h3");
const runtime = JSON.parse(
  readFileSync(join(exampleRoot, "production-runtime.json"), "utf8"),
) as Record<string, unknown>;
const exampleTemplate = JSON.parse(
  readFileSync(join(exampleRoot, "workflows", "h3-fl2va-portrait.json"), "utf8"),
) as Record<string, unknown>;
const exampleWorkflow = (runtime.workflows as Record<string, unknown>[])[0]!;
const exampleProfile = (runtime.stagingProfiles as Record<string, unknown>[])[0]!;
const exampleContract = parseProductionH3GraphContract(exampleWorkflow.h3GraphContract);
const exampleExecution = parseProductionIntentExecution(exampleProfile.execution);
const exampleBindings = (exampleProfile.bindings as unknown[])
  .map((row, index) => parseProductionH3StageBindingContract(row, index));
assertProductionH3Template(
  exampleTemplate, exampleContract, exampleExecution, exampleBindings,
  String(exampleProfile.profileId),
);
ok(exampleContract.version === 1
  && productionH3WorkflowSha256(exampleTemplate) === exampleWorkflow.workflowSha256
  && productionH3ParameterManifestSha256(exampleTemplate, exampleContract, exampleExecution)
    === exampleWorkflow.parametersSha256
  && exampleContract.parameterManifest.sha256 === exampleWorkflow.parametersSha256,
"打包的 representative-h3 v1 示例：assertGraph 与两个 digest 逐字节不变");

if (fails) {
  console.error(`PRODUCTION_H3_GRAPH_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_H3_GRAPH_OK");
