// Pure, server-owned MiniMax H3 Comfy API graph contract.
//
// This contract intentionally accepts one narrow representative API-format graph. It is not a
// claim that a deployment has passed a live ComfyUI /prompt probe. Deployment admission remains a
// separate operational attestation.
//
// Two contract versions coexist (§5.3). Version 1 pins `generator.prompt` and `RandomNoise.noise_seed`
// as literals inside the parameter projection, so one graph plus one config entry carries exactly one
// shot. Version 2 replaces both with the sentinels
// `writing-loop://shot-request/<profileId>/prompt|seed`, projects the parameter manifest over those
// sentinels (they are the fixed value of the template) and fills the actual per-shot prompt/seed from
// the staged ShotRequest at materialization, re-asserting the whole graph afterwards. Version 2 also
// adds the index 0 `shot-request` stage slot, which binds no LoadImage and therefore shifts the
// LoadImage binding indices by one.
import type { ProductionIntentExecution } from "./production-intent.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLOT = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_INPUT = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/;
const SAFE_PROVIDER_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const H3_GENERATOR_CLASSES = new Set([
  "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo",
]);
const UNET_DTYPES = new Set(["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]);

export class ProductionH3GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionH3GraphError";
  }
}

export type ProductionH3GeneratorClass =
  | "MiniMaxH3ImageToVideo"
  | "MiniMaxH3ReferenceToVideo";

export type ProductionH3GeneratorContract = Readonly<{
  version: 1;
  nodeId: string;
  classType: ProductionH3GeneratorClass;
  width: number;
  height: number;
  length: number;
}>;

export type ProductionH3ModelComponentContract = Readonly<{
  version: 1;
  nodeId: string;
  classType: "UNETLoader" | "CLIPLoader" | "VAELoader";
  inputName: "unet_name" | "clip_name" | "vae_name";
  modelAlias: string;
  artifactSha256: string;
}>;

export type ProductionH3ModelBundleContract = Readonly<{
  version: 1;
  diffusion: ProductionH3ModelComponentContract;
  textEncoder: ProductionH3ModelComponentContract;
  videoVae: ProductionH3ModelComponentContract;
  audioVae: ProductionH3ModelComponentContract;
  sha256: string;
}>;

export type ProductionH3NodeContract<ClassType extends string = string> = Readonly<{
  version: 1;
  nodeId: string;
  classType: ClassType;
}>;

export type ProductionH3PipelineContract = Readonly<{
  version: 1;
  sigmaShift: ProductionH3NodeContract<"MiniMaxH3SigmaShift">;
  guider: ProductionH3NodeContract<"BasicGuider">;
  scheduler: ProductionH3NodeContract<"BasicScheduler">;
  samplerSelect: ProductionH3NodeContract<"KSamplerSelect">;
  noise: ProductionH3NodeContract<"RandomNoise">;
  sampler: ProductionH3NodeContract<"SamplerCustomAdvanced">;
  videoDecode: ProductionH3NodeContract<"VAEDecode">;
  audioDecode: ProductionH3NodeContract<"VAEDecodeAudio">;
  createVideo: ProductionH3NodeContract<"CreateVideo">;
  saveVideo: ProductionH3NodeContract<"SaveVideo">;
}>;

/** Contract v1 pins prompt/seed as literals; v2 moves both to per-shot sentinels (§5.3). */
export type ProductionH3GraphContractVersion = 1 | 2;

export type ProductionH3GraphContract = Readonly<{
  version: ProductionH3GraphContractVersion;
  generator: ProductionH3GeneratorContract;
  modelBundle: ProductionH3ModelBundleContract;
  pipeline: ProductionH3PipelineContract;
  parameterManifest: Readonly<{ version: 1; sha256: string }>;
}>;

/**
 * Fixed index 0 slot of contract v2. It binds no graph node; the gateway reads the staged object.
 * Same literal as `PRODUCTION_SHOT_REQUEST_SLOT` in production-input-stager.ts, which names it on the
 * receipt wire — this module stays free of the stager so the graph contract has no transport imports.
 */
export const PRODUCTION_H3_SHOT_REQUEST_SLOT = "shot-request";

export type ProductionH3StageBindingContract = Readonly<{
  version: 1;
  index: number;
  slot: string;
  /** null only for the contract v2 `shot-request` slot, which binds no LoadImage node. */
  source: Readonly<{
    version: 1;
    nodeId: string;
    classType: "LoadImage";
    inputName: "image";
    outputIndex: 0;
  }> | null;
  /** null exactly when `source` is null. */
  consumer: Readonly<{
    version: 1;
    nodeId: string;
    inputName: string;
  }> | null;
}>;

/** Per-shot prompt/seed filled into a contract v2 graph at materialization (§5.3). */
export type ProductionH3ShotBinding = Readonly<{
  prompt: string;
  seed: number;
}>;

export type ProductionH3ReceiptBinding = Readonly<{
  index: number;
  slot: string;
  assetSha256: string;
  providerObjectKey: string;
}>;

export type ProductionH3MaterializedWorkflow = Readonly<{
  templateWorkflowSha256: string;
  boundWorkflowSha256: string;
  workflow: Record<string, unknown>;
}>;

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new ProductionH3GraphError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, subject: string): JsonRecord {
  if (!isRecord(value)) fail(`${subject} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, keys: readonly string[], subject: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(`${subject} has unknown or missing fields`);
  }
}

function version(value: unknown, subject: string): void {
  if (value !== 1) fail(`${subject}.version must equal 1`);
}

function contractVersion(value: unknown, subject: string): ProductionH3GraphContractVersion {
  if (value !== 1 && value !== 2) fail(`${subject}.version must equal 1 or 2`);
  return value;
}

function exactString(value: unknown, pattern: RegExp, subject: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${subject} is invalid`);
  return value;
}

function boundedString(value: unknown, maximum: number, subject: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000\u000b\u000c\u007f]/.test(value)) fail(`${subject} is invalid`);
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${subject} is invalid`);
  }
  return value as number;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, subject: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${subject} is invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function modelAlias(value: unknown, subject: string): string {
  const alias = boundedString(value, 512, subject);
  if (alias.startsWith("/") || alias.includes("\\")) fail(`${subject} must be a relative model alias`);
  const parts = alias.split("/");
  if (parts.some((part) => part === "." || part === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._+ -]{0,199}$/.test(part))) {
    fail(`${subject} contains an invalid path segment`);
  }
  return alias;
}

function safeProviderObjectKey(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROVIDER_OBJECT_KEY.test(value)
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function parseNode<ClassType extends string>(
  value: unknown,
  classType: ClassType,
  subject: string,
): ProductionH3NodeContract<ClassType> {
  const row = record(value, subject);
  exactKeys(row, ["version", "nodeId", "classType"], subject);
  version(row.version, subject);
  if (row.classType !== classType) fail(`${subject}.classType must equal ${classType}`);
  return Object.freeze({
    version: 1,
    nodeId: exactString(row.nodeId, SAFE_ID, `${subject}.nodeId`),
    classType,
  });
}

function parseModelComponent(
  value: unknown,
  expected: Readonly<{
    classType: ProductionH3ModelComponentContract["classType"];
    inputName: ProductionH3ModelComponentContract["inputName"];
  }>,
  subject: string,
): ProductionH3ModelComponentContract {
  const row = record(value, subject);
  exactKeys(row, [
    "version", "nodeId", "classType", "inputName", "modelAlias", "artifactSha256",
  ], subject);
  version(row.version, subject);
  if (row.classType !== expected.classType || row.inputName !== expected.inputName) {
    fail(`${subject} loader class/input does not match its fixed role`);
  }
  return Object.freeze({
    version: 1,
    nodeId: exactString(row.nodeId, SAFE_ID, `${subject}.nodeId`),
    classType: expected.classType,
    inputName: expected.inputName,
    modelAlias: modelAlias(row.modelAlias, `${subject}.modelAlias`),
    artifactSha256: exactString(row.artifactSha256, SHA256, `${subject}.artifactSha256`),
  });
}

function sha256Json(value: unknown): string {
  try { return productionCanonicalJsonSha256(value); }
  catch { fail("value is not canonicalizable JSON"); }
}

export function productionH3WorkflowSha256(workflow: Record<string, unknown>): string {
  return sha256Json(workflow);
}

export function productionH3ModelBundleSha256(bundle: ProductionH3ModelBundleContract): string {
  const rows = ([
    ["diffusion", bundle.diffusion],
    ["textEncoder", bundle.textEncoder],
    ["videoVae", bundle.videoVae],
    ["audioVae", bundle.audioVae],
  ] as const).map(([role, component]) => ({
    version: 1 as const,
    role,
    classType: component.classType,
    inputName: component.inputName,
    modelAlias: component.modelAlias,
    artifactSha256: component.artifactSha256,
  })).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
  return sha256Json({ version: 1, components: rows });
}

export function parseProductionH3GraphContract(value: unknown): ProductionH3GraphContract {
  const subject = "ProductionH3GraphContract";
  const row = record(value, subject);
  exactKeys(row, ["version", "generator", "modelBundle", "pipeline", "parameterManifest"], subject);
  const graphVersion = contractVersion(row.version, subject);

  const generatorRow = record(row.generator, `${subject}.generator`);
  exactKeys(generatorRow, ["version", "nodeId", "classType", "width", "height", "length"], `${subject}.generator`);
  version(generatorRow.version, `${subject}.generator`);
  if (typeof generatorRow.classType !== "string" || !H3_GENERATOR_CLASSES.has(generatorRow.classType)) {
    fail(`${subject}.generator.classType is unsupported`);
  }
  const width = boundedInteger(generatorRow.width, 32, 8_192, `${subject}.generator.width`);
  const height = boundedInteger(generatorRow.height, 32, 8_192, `${subject}.generator.height`);
  if (width % 32 !== 0 || height % 32 !== 0) fail(`${subject}.generator dimensions must align to 32`);
  const generator: ProductionH3GeneratorContract = Object.freeze({
    version: 1,
    nodeId: exactString(generatorRow.nodeId, SAFE_ID, `${subject}.generator.nodeId`),
    classType: generatorRow.classType as ProductionH3GeneratorClass,
    width,
    height,
    length: boundedInteger(generatorRow.length, 5, 3_600, `${subject}.generator.length`),
  });

  const bundleRow = record(row.modelBundle, `${subject}.modelBundle`);
  exactKeys(bundleRow, ["version", "diffusion", "textEncoder", "videoVae", "audioVae", "sha256"], `${subject}.modelBundle`);
  version(bundleRow.version, `${subject}.modelBundle`);
  const modelBundle: ProductionH3ModelBundleContract = Object.freeze({
    version: 1,
    diffusion: parseModelComponent(bundleRow.diffusion, {
      classType: "UNETLoader", inputName: "unet_name",
    }, `${subject}.modelBundle.diffusion`),
    textEncoder: parseModelComponent(bundleRow.textEncoder, {
      classType: "CLIPLoader", inputName: "clip_name",
    }, `${subject}.modelBundle.textEncoder`),
    videoVae: parseModelComponent(bundleRow.videoVae, {
      classType: "VAELoader", inputName: "vae_name",
    }, `${subject}.modelBundle.videoVae`),
    audioVae: parseModelComponent(bundleRow.audioVae, {
      classType: "VAELoader", inputName: "vae_name",
    }, `${subject}.modelBundle.audioVae`),
    sha256: exactString(bundleRow.sha256, SHA256, `${subject}.modelBundle.sha256`),
  });
  if (productionH3ModelBundleSha256(modelBundle) !== modelBundle.sha256) {
    fail(`${subject}.modelBundle.sha256 does not attest the four exact components`);
  }

  const pipelineRow = record(row.pipeline, `${subject}.pipeline`);
  exactKeys(pipelineRow, [
    "version", "sigmaShift", "guider", "scheduler", "samplerSelect", "noise", "sampler",
    "videoDecode", "audioDecode", "createVideo", "saveVideo",
  ], `${subject}.pipeline`);
  version(pipelineRow.version, `${subject}.pipeline`);
  const pipeline: ProductionH3PipelineContract = Object.freeze({
    version: 1,
    sigmaShift: parseNode(pipelineRow.sigmaShift, "MiniMaxH3SigmaShift", `${subject}.pipeline.sigmaShift`),
    guider: parseNode(pipelineRow.guider, "BasicGuider", `${subject}.pipeline.guider`),
    scheduler: parseNode(pipelineRow.scheduler, "BasicScheduler", `${subject}.pipeline.scheduler`),
    samplerSelect: parseNode(pipelineRow.samplerSelect, "KSamplerSelect", `${subject}.pipeline.samplerSelect`),
    noise: parseNode(pipelineRow.noise, "RandomNoise", `${subject}.pipeline.noise`),
    sampler: parseNode(pipelineRow.sampler, "SamplerCustomAdvanced", `${subject}.pipeline.sampler`),
    videoDecode: parseNode(pipelineRow.videoDecode, "VAEDecode", `${subject}.pipeline.videoDecode`),
    audioDecode: parseNode(pipelineRow.audioDecode, "VAEDecodeAudio", `${subject}.pipeline.audioDecode`),
    createVideo: parseNode(pipelineRow.createVideo, "CreateVideo", `${subject}.pipeline.createVideo`),
    saveVideo: parseNode(pipelineRow.saveVideo, "SaveVideo", `${subject}.pipeline.saveVideo`),
  });

  const parameterRow = record(row.parameterManifest, `${subject}.parameterManifest`);
  exactKeys(parameterRow, ["version", "sha256"], `${subject}.parameterManifest`);
  version(parameterRow.version, `${subject}.parameterManifest`);
  const parameterManifest = Object.freeze({
    version: 1 as const,
    sha256: exactString(parameterRow.sha256, SHA256, `${subject}.parameterManifest.sha256`),
  });

  const nodeIds = [
    generator.nodeId,
    modelBundle.diffusion.nodeId, modelBundle.textEncoder.nodeId,
    modelBundle.videoVae.nodeId, modelBundle.audioVae.nodeId,
    pipeline.sigmaShift.nodeId, pipeline.guider.nodeId, pipeline.scheduler.nodeId,
    pipeline.samplerSelect.nodeId, pipeline.noise.nodeId, pipeline.sampler.nodeId,
    pipeline.videoDecode.nodeId, pipeline.audioDecode.nodeId, pipeline.createVideo.nodeId,
    pipeline.saveVideo.nodeId,
  ];
  if (new Set(nodeIds).size !== nodeIds.length) fail(`${subject} role nodeIds must be unique`);
  return Object.freeze({ version: graphVersion, generator, modelBundle, pipeline, parameterManifest });
}

export function parseProductionH3StageBindingContract(
  value: unknown,
  expectedIndex: number,
): ProductionH3StageBindingContract {
  const subject = `ProductionH3StageBindingContract[${expectedIndex}]`;
  const row = record(value, subject);
  exactKeys(row, ["version", "index", "slot", "source", "consumer"], subject);
  version(row.version, subject);
  if (row.index !== expectedIndex) fail(`${subject}.index must equal its ordered position`);
  const slot = exactString(row.slot, SAFE_SLOT, `${subject}.slot`);
  if (row.source === null || row.consumer === null) {
    // Contract v2's index 0 ShotRequest: staged and content-checked, but bound to no graph node.
    if (row.source !== null || row.consumer !== null) {
      fail(`${subject} source and consumer must be null together`);
    }
    if (slot !== PRODUCTION_H3_SHOT_REQUEST_SLOT || expectedIndex !== 0) {
      fail(`${subject} may only omit its graph binding for the index 0 ${PRODUCTION_H3_SHOT_REQUEST_SLOT} slot`);
    }
    return Object.freeze({ version: 1, index: 0, slot, source: null, consumer: null });
  }
  if (slot === PRODUCTION_H3_SHOT_REQUEST_SLOT) {
    fail(`${subject} ${PRODUCTION_H3_SHOT_REQUEST_SLOT} must not bind a LoadImage node`);
  }
  const source = record(row.source, `${subject}.source`);
  exactKeys(source, ["version", "nodeId", "classType", "inputName", "outputIndex"], `${subject}.source`);
  version(source.version, `${subject}.source`);
  if (source.classType !== "LoadImage" || source.inputName !== "image" || source.outputIndex !== 0) {
    fail(`${subject}.source must be LoadImage/image/output 0`);
  }
  const consumer = record(row.consumer, `${subject}.consumer`);
  exactKeys(consumer, ["version", "nodeId", "inputName"], `${subject}.consumer`);
  version(consumer.version, `${subject}.consumer`);
  return Object.freeze({
    version: 1,
    index: expectedIndex,
    slot,
    source: Object.freeze({
      version: 1,
      nodeId: exactString(source.nodeId, SAFE_ID, `${subject}.source.nodeId`),
      classType: "LoadImage",
      inputName: "image",
      outputIndex: 0,
    }),
    consumer: Object.freeze({
      version: 1,
      nodeId: exactString(consumer.nodeId, SAFE_ID, `${subject}.consumer.nodeId`),
      inputName: exactString(consumer.inputName, SAFE_INPUT, `${subject}.consumer.inputName`),
    }),
  });
}

export function productionH3StageInputSentinel(
  profileId: string,
  index: number,
  slot: string,
): string {
  if (!SAFE_ID.test(profileId) || !Number.isSafeInteger(index) || index < 0 || index > 31
    || !SAFE_SLOT.test(slot)) fail("stage input sentinel identity is invalid");
  return `writing-loop://stage-input/${profileId}/${index}/${encodeURIComponent(slot)}`;
}

export type ProductionH3ShotRequestField = "prompt" | "seed";

/** Contract v2 sentinel for one per-shot field of the staged ShotRequest (§5.3). */
export function productionH3ShotRequestSentinel(
  profileId: string,
  field: ProductionH3ShotRequestField,
): string {
  if (!SAFE_ID.test(profileId) || (field !== "prompt" && field !== "seed")) {
    fail("shot request sentinel identity is invalid");
  }
  return `writing-loop://shot-request/${profileId}/${field}`;
}

/**
 * Private marker substituted for the real profile id before a graph enters `assertGraph`, so the
 * parameter projection measures "this input is bound to the staged ShotRequest" rather than the
 * profile's name. The public API always normalizes first.
 */
const TEMPLATE_PROFILE_MARKER = "profile";

function expectedGeneratorClass(execution: ProductionIntentExecution): ProductionH3GeneratorClass {
  if (execution.modelFamily !== "minimax-h3") fail("H3 graph requires a minimax-h3 execution");
  return execution.variant === "fl2va" ? "MiniMaxH3ImageToVideo" : "MiniMaxH3ReferenceToVideo";
}

function expectedCanvas(execution: ProductionIntentExecution): Readonly<{ width: number; height: number }> {
  if (execution.modelFamily !== "minimax-h3" || execution.shortEdge !== 768) {
    fail("H3 graph requires shortEdge=768");
  }
  if (execution.aspectRatio === "16:9") return { width: 1_344, height: 768 };
  if (execution.aspectRatio === "9:16") return { width: 768, height: 1_344 };
  return { width: 768, height: 768 };
}

function expectedLength(execution: ProductionIntentExecution): number {
  if (execution.modelFamily !== "minimax-h3") fail("H3 graph requires a minimax-h3 execution");
  const requested = Math.max(5, Math.round(execution.durationSeconds * 24));
  return requested + ((5 - (requested % 17) + 17) % 17);
}

function validateStageContracts(
  execution: ProductionIntentExecution,
  contract: ProductionH3GraphContract,
  stageContracts: readonly ProductionH3StageBindingContract[],
): void {
  if (execution.modelFamily !== "minimax-h3") fail("H3 stage bindings require minimax-h3 execution");
  // Contract v2 prefixes the fixed LoadImage bindings with the index 0 ShotRequest slot (§5.3), so
  // the image bindings keep their v1 dataflow and only shift one position to the right.
  const offset = contract.version === 2 ? 1 : 0;
  if (offset === 1) {
    const head = stageContracts[0];
    if (head === undefined || head.index !== 0 || head.slot !== PRODUCTION_H3_SHOT_REQUEST_SLOT
      || head.source !== null || head.consumer !== null) {
      fail("H3 contract v2 requires the index 0 shot-request stage slot");
    }
  }
  const imageBindings = stageContracts.length - offset;
  if ((execution.variant === "fl2va" && (imageBindings < 1 || imageBindings > 2))
    || (execution.variant === "ref2va" && (imageBindings < 1 || imageBindings > 9))) {
    fail("H3 stage binding count is invalid for the selected variant");
  }
  const sourceIds = new Set<string>();
  for (let index = offset; index < stageContracts.length; index++) {
    const binding = stageContracts[index]!;
    const position = index - offset;
    const expectedSlot = execution.variant === "fl2va"
      ? position === 0 ? "first_frame" : "last_frame"
      : `reference.${position}`;
    const expectedInput = execution.variant === "fl2va"
      ? expectedSlot
      : `ref_images.ref_image_${position}`;
    // A v1 contract has no shot-request slot, and the parser only accepts one at index 0 — where a
    // v1 binding list must instead carry its first LoadImage slot, so this is where it is refused.
    if (binding.index !== index || binding.slot !== expectedSlot
      || binding.source === null || binding.consumer === null
      || binding.consumer.nodeId !== contract.generator.nodeId
      || binding.consumer.inputName !== expectedInput || sourceIds.has(binding.source.nodeId)) {
      fail(`H3 stage binding ${index} does not match the exact variant dataflow`);
    }
    sourceIds.add(binding.source.nodeId);
  }
  const roleIds = new Set([
    contract.generator.nodeId,
    contract.modelBundle.diffusion.nodeId, contract.modelBundle.textEncoder.nodeId,
    contract.modelBundle.videoVae.nodeId, contract.modelBundle.audioVae.nodeId,
    ...Object.values(contract.pipeline).flatMap((node) =>
      isRecord(node) && typeof node.nodeId === "string" ? [node.nodeId] : []),
  ]);
  if ([...sourceIds].some((nodeId) => roleIds.has(nodeId))) fail("H3 stage source overlaps a fixed graph role");
}

export function assertProductionH3ExecutionContract(
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
  stageContracts: readonly ProductionH3StageBindingContract[],
): void {
  if (execution.operation !== "comfyui-workflow" || execution.modelFamily !== "minimax-h3") {
    fail("H3 canonical API graph requires operation=comfyui-workflow and modelFamily=minimax-h3");
  }
  validateStageContracts(execution, contract, stageContracts);
  const canvas = expectedCanvas(execution);
  if (contract.generator.classType !== expectedGeneratorClass(execution)
    || contract.generator.width !== canvas.width || contract.generator.height !== canvas.height
    || contract.generator.length !== expectedLength(execution)) {
    fail("H3 generator contract drifted from immutable execution");
  }
  if (contract.modelBundle.sha256 !== execution.modelSha256) fail("H3 model bundle digest drifted from execution");
  if (contract.parameterManifest.sha256 !== execution.parametersSha256) {
    fail("H3 parameter manifest digest drifted from execution");
  }
}

function graphNode(workflow: JsonRecord, nodeId: string, classType: string, keys: readonly string[]): JsonRecord {
  if (!Object.prototype.hasOwnProperty.call(workflow, nodeId)) fail(`H3 graph is missing node ${nodeId}`);
  const node = record(workflow[nodeId], `H3 graph node ${nodeId}`);
  exactKeys(node, ["class_type", "inputs"], `H3 graph node ${nodeId}`);
  if (node.class_type !== classType) fail(`H3 graph node ${nodeId} class_type drifted`);
  const inputs = record(node.inputs, `H3 graph node ${nodeId}.inputs`);
  exactKeys(inputs, keys, `H3 graph node ${nodeId}.inputs`);
  return inputs;
}

function assertLink(value: unknown, sourceNodeId: string, outputIndex: number, subject: string): void {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== sourceNodeId || value[1] !== outputIndex) {
    fail(`${subject} must be exact link [${sourceNodeId},${outputIndex}]`);
  }
}

function countExactString(value: unknown, expected: string): number {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === expected) { count++; continue; }
    if (Array.isArray(next)) stack.push(...next);
    else if (isRecord(next)) stack.push(...Object.values(next));
  }
  return count;
}

function countLink(value: unknown, sourceNodeId: string, outputIndex: number): number {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (Array.isArray(next)) {
      if (next.length === 2 && next[0] === sourceNodeId && next[1] === outputIndex) count++;
      stack.push(...next);
    } else if (isRecord(next)) stack.push(...Object.values(next));
  }
  return count;
}

type ParameterRow = Readonly<{
  version: 1;
  role: string;
  classType: string;
  inputName: string;
  value: string | number | boolean | null;
}>;

function parameterLiteral(value: unknown, subject: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string" && value.length <= 16_384
    && !/[\u0000\u000b\u000c\u007f]/.test(value)) return value;
  fail(`${subject} must be a bounded JSON scalar literal`);
}

function parameterRows(
  workflow: JsonRecord,
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
): ParameterRow[] {
  const generatorNode = record(workflow[contract.generator.nodeId], "H3 generator");
  if (generatorNode.class_type !== contract.generator.classType) fail("H3 generator class_type drifted");
  const generator = record(generatorNode.inputs, "H3 generator.inputs");
  const diffusion = graphNode(workflow, contract.modelBundle.diffusion.nodeId, "UNETLoader", ["unet_name", "weight_dtype"]);
  const textEncoder = graphNode(workflow, contract.modelBundle.textEncoder.nodeId, "CLIPLoader", ["clip_name", "type", "device"]);
  const sigma = graphNode(workflow, contract.pipeline.sigmaShift.nodeId, "MiniMaxH3SigmaShift", ["model", "shift_video", "shift_audio"]);
  const scheduler = graphNode(workflow, contract.pipeline.scheduler.nodeId, "BasicScheduler", ["model", "scheduler", "steps", "denoise"]);
  const samplerSelect = graphNode(workflow, contract.pipeline.samplerSelect.nodeId, "KSamplerSelect", ["sampler_name"]);
  const noise = graphNode(workflow, contract.pipeline.noise.nodeId, "RandomNoise", ["noise_seed"]);
  const createVideo = graphNode(workflow, contract.pipeline.createVideo.nodeId, "CreateVideo", ["images", "fps", "audio", "bit_depth"]);
  const saveVideo = graphNode(workflow, contract.pipeline.saveVideo.nodeId, "SaveVideo", ["video", "filename_prefix", "format", "codec"]);
  // Contract v2 projects both per-shot inputs at their sentinel value, so one profile's parameter
  // manifest stays constant across every shot it carries (§5.3).
  const promptProjection = contract.version === 2
    ? productionH3ShotRequestSentinel(TEMPLATE_PROFILE_MARKER, "prompt")
    : generator.prompt;
  const seedProjection = contract.version === 2
    ? productionH3ShotRequestSentinel(TEMPLATE_PROFILE_MARKER, "seed")
    : noise.noise_seed;
  const rows: ParameterRow[] = [
    ["generator", contract.generator.classType, "prompt", promptProjection],
    ["generator", contract.generator.classType, "width", generator.width],
    ["generator", contract.generator.classType, "height", generator.height],
    ["generator", contract.generator.classType, "length", generator.length],
    ["diffusion", "UNETLoader", "weight_dtype", diffusion.weight_dtype],
    ["textEncoder", "CLIPLoader", "type", textEncoder.type],
    ["textEncoder", "CLIPLoader", "device", textEncoder.device],
    ["sigmaShift", "MiniMaxH3SigmaShift", "shift_video", sigma.shift_video],
    ["sigmaShift", "MiniMaxH3SigmaShift", "shift_audio", sigma.shift_audio],
    ["scheduler", "BasicScheduler", "scheduler", scheduler.scheduler],
    ["scheduler", "BasicScheduler", "steps", scheduler.steps],
    ["scheduler", "BasicScheduler", "denoise", scheduler.denoise],
    ["samplerSelect", "KSamplerSelect", "sampler_name", samplerSelect.sampler_name],
    ["noise", "RandomNoise", "noise_seed", seedProjection],
    ["createVideo", "CreateVideo", "fps", createVideo.fps],
    ["createVideo", "CreateVideo", "bit_depth", createVideo.bit_depth],
    ["saveVideo", "SaveVideo", "filename_prefix", saveVideo.filename_prefix],
    ["saveVideo", "SaveVideo", "format", saveVideo.format],
    ["saveVideo", "SaveVideo", "codec", saveVideo.codec],
  ].map(([role, classType, inputName, value]) => ({
    version: 1 as const,
    role: role as string,
    classType: classType as string,
    inputName: inputName as string,
    value: parameterLiteral(value, `${role}.${inputName}`),
  }));
  if (execution.modelFamily === "minimax-h3" && execution.variant === "ref2va") {
    rows.push({
      version: 1,
      role: "generator",
      classType: contract.generator.classType,
      inputName: "ref_image_size",
      value: parameterLiteral(generator.ref_image_size, "generator.ref_image_size"),
    });
  }
  return rows.sort((left, right) => {
    const leftKey = JSON.stringify([left.role, left.classType, left.inputName]);
    const rightKey = JSON.stringify([right.role, right.classType, right.inputName]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function productionH3ParameterManifestSha256(
  workflow: Record<string, unknown>,
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
): string {
  return sha256Json({ version: 1, parameters: parameterRows(workflow, contract, execution) });
}

function assertGraph(
  workflow: Record<string, unknown>,
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
  stageContracts: readonly ProductionH3StageBindingContract[],
  boundProviderKeys: ReadonlyMap<number, string> | null,
  boundShot: ProductionH3ShotBinding | null,
): void {
  assertProductionH3ExecutionContract(contract, execution, stageContracts);
  if (execution.modelFamily !== "minimax-h3") fail("H3 execution narrowing failed");
  if (contract.version === 1 && boundShot !== null) fail("H3 contract v1 has no per-shot binding");
  if (contract.version === 2 && boundProviderKeys !== null && boundShot === null) {
    fail("H3 contract v2 requires the staged ShotRequest prompt/seed at materialization");
  }
  const imageBindings = stageContracts.filter((binding) => binding.source !== null);

  const p = contract.pipeline;
  const b = contract.modelBundle;
  const expectedNodeIds = new Set([
    contract.generator.nodeId, b.diffusion.nodeId, b.textEncoder.nodeId, b.videoVae.nodeId, b.audioVae.nodeId,
    p.sigmaShift.nodeId, p.guider.nodeId, p.scheduler.nodeId, p.samplerSelect.nodeId, p.noise.nodeId,
    p.sampler.nodeId, p.videoDecode.nodeId, p.audioDecode.nodeId, p.createVideo.nodeId, p.saveVideo.nodeId,
    ...imageBindings.map((binding) => binding.source!.nodeId),
  ]);
  const actualNodeIds = Object.keys(workflow);
  if (actualNodeIds.length !== expectedNodeIds.size
    || actualNodeIds.some((nodeId) => !expectedNodeIds.has(nodeId))) {
    fail("H3 graph node set contains a missing, extra, or decoy node");
  }

  const diffusion = graphNode(workflow, b.diffusion.nodeId, "UNETLoader", ["unet_name", "weight_dtype"]);
  const textEncoder = graphNode(workflow, b.textEncoder.nodeId, "CLIPLoader", ["clip_name", "type", "device"]);
  const videoVae = graphNode(workflow, b.videoVae.nodeId, "VAELoader", ["vae_name"]);
  const audioVae = graphNode(workflow, b.audioVae.nodeId, "VAELoader", ["vae_name"]);
  if (diffusion.unet_name !== b.diffusion.modelAlias || textEncoder.clip_name !== b.textEncoder.modelAlias
    || videoVae.vae_name !== b.videoVae.modelAlias || audioVae.vae_name !== b.audioVae.modelAlias
    || typeof diffusion.weight_dtype !== "string" || !UNET_DTYPES.has(diffusion.weight_dtype)
    || textEncoder.type !== "minimax" || textEncoder.device !== "default") {
    fail("H3 actual loader literals drifted from the trusted four-component model bundle");
  }

  const generatorKeys = execution.variant === "fl2va"
    ? ["clip", "vae", "prompt", "width", "height", "length",
      ...imageBindings.map((binding) => binding.consumer!.inputName)]
    : ["clip", "vae", "audio_vae", "prompt", "width", "height", "length", "ref_image_size",
      ...imageBindings.map((binding) => binding.consumer!.inputName)];
  const generator = graphNode(workflow, contract.generator.nodeId, contract.generator.classType, generatorKeys);
  assertLink(generator.clip, b.textEncoder.nodeId, 0, "H3 generator.clip");
  assertLink(generator.vae, b.videoVae.nodeId, 0, "H3 generator.vae");
  if (generator.width !== contract.generator.width || generator.height !== contract.generator.height
    || generator.length !== contract.generator.length || typeof generator.prompt !== "string"
    || generator.prompt.length < 1 || generator.prompt.length > 16_384) {
    fail("H3 generator literal parameters drifted");
  }
  if (contract.version === 2) {
    const expectedPrompt = boundShot === null
      ? productionH3ShotRequestSentinel(TEMPLATE_PROFILE_MARKER, "prompt")
      : boundShot.prompt;
    if (generator.prompt !== expectedPrompt) fail("H3 generator.prompt is not the contract v2 shot value");
    if (boundShot === null && countExactString(workflow, expectedPrompt) !== 1) {
      fail("H3 contract v2 prompt sentinel must occur exactly once");
    }
  }
  if (execution.variant === "ref2va") {
    assertLink(generator.audio_vae, b.audioVae.nodeId, 0, "H3 generator.audio_vae");
    if (generator.ref_image_size !== "match" && generator.ref_image_size !== "max") {
      fail("H3 generator.ref_image_size is invalid");
    }
  }

  for (const binding of imageBindings) {
    const source = graphNode(workflow, binding.source!.nodeId, "LoadImage", ["image"]);
    const expectedSourceValue = boundProviderKeys === null
      ? productionH3StageInputSentinel(TEMPLATE_PROFILE_MARKER, binding.index, binding.slot)
      : boundProviderKeys.get(binding.index);
    // The public API substitutes the actual profile id before entering assertGraph; `profile` is a
    // private marker used only when a caller supplied an already-normalized template expectation.
    if (typeof expectedSourceValue !== "string" || source.image !== expectedSourceValue) {
      fail(`H3 stage source ${binding.index} literal drifted`);
    }
    assertLink(generator[binding.consumer!.inputName], binding.source!.nodeId, 0,
      `H3 generator.${binding.consumer!.inputName}`);
    if (countLink(workflow, binding.source!.nodeId, 0) !== 1) {
      fail(`H3 stage source ${binding.index} must feed exactly one authorized consumer`);
    }
    if (countExactString(workflow, expectedSourceValue) !== 1) {
      fail(`H3 stage source literal ${binding.index} must occur exactly once`);
    }
  }

  const sigma = graphNode(workflow, p.sigmaShift.nodeId, "MiniMaxH3SigmaShift", ["model", "shift_video", "shift_audio"]);
  assertLink(sigma.model, b.diffusion.nodeId, 0, "H3 sigmaShift.model");
  boundedNumber(sigma.shift_video, 0.01, 100, "H3 sigmaShift.shift_video");
  boundedNumber(sigma.shift_audio, 0.01, 100, "H3 sigmaShift.shift_audio");
  const guider = graphNode(workflow, p.guider.nodeId, "BasicGuider", ["model", "conditioning"]);
  assertLink(guider.model, p.sigmaShift.nodeId, 0, "H3 guider.model");
  assertLink(guider.conditioning, contract.generator.nodeId, 0, "H3 guider.conditioning");
  const scheduler = graphNode(workflow, p.scheduler.nodeId, "BasicScheduler", ["model", "scheduler", "steps", "denoise"]);
  assertLink(scheduler.model, p.sigmaShift.nodeId, 0, "H3 scheduler.model");
  boundedString(scheduler.scheduler, 128, "H3 scheduler.scheduler");
  boundedInteger(scheduler.steps, 1, 10_000, "H3 scheduler.steps");
  boundedNumber(scheduler.denoise, 0, 1, "H3 scheduler.denoise");
  const samplerSelect = graphNode(workflow, p.samplerSelect.nodeId, "KSamplerSelect", ["sampler_name"]);
  boundedString(samplerSelect.sampler_name, 128, "H3 samplerSelect.sampler_name");
  const noise = graphNode(workflow, p.noise.nodeId, "RandomNoise", ["noise_seed"]);
  if (contract.version === 2 && boundShot === null) {
    const sentinel = productionH3ShotRequestSentinel(TEMPLATE_PROFILE_MARKER, "seed");
    if (noise.noise_seed !== sentinel) fail("H3 noise.noise_seed is not the contract v2 seed sentinel");
    if (countExactString(workflow, sentinel) !== 1) {
      fail("H3 contract v2 seed sentinel must occur exactly once");
    }
  } else {
    boundedInteger(noise.noise_seed, 0, Number.MAX_SAFE_INTEGER, "H3 noise.noise_seed");
    if (boundShot !== null && noise.noise_seed !== boundShot.seed) {
      fail("H3 noise.noise_seed is not the contract v2 shot seed");
    }
  }
  const sampler = graphNode(workflow, p.sampler.nodeId, "SamplerCustomAdvanced",
    ["noise", "guider", "sampler", "sigmas", "latent_image"]);
  assertLink(sampler.noise, p.noise.nodeId, 0, "H3 sampler.noise");
  assertLink(sampler.guider, p.guider.nodeId, 0, "H3 sampler.guider");
  assertLink(sampler.sampler, p.samplerSelect.nodeId, 0, "H3 sampler.sampler");
  assertLink(sampler.sigmas, p.scheduler.nodeId, 0, "H3 sampler.sigmas");
  assertLink(sampler.latent_image, contract.generator.nodeId, 1, "H3 sampler.latent_image");
  const videoDecode = graphNode(workflow, p.videoDecode.nodeId, "VAEDecode", ["samples", "vae"]);
  assertLink(videoDecode.samples, p.sampler.nodeId, 0, "H3 videoDecode.samples");
  assertLink(videoDecode.vae, b.videoVae.nodeId, 0, "H3 videoDecode.vae");
  const audioDecode = graphNode(workflow, p.audioDecode.nodeId, "VAEDecodeAudio", ["samples", "vae"]);
  assertLink(audioDecode.samples, p.sampler.nodeId, 0, "H3 audioDecode.samples");
  assertLink(audioDecode.vae, b.audioVae.nodeId, 0, "H3 audioDecode.vae");
  const createVideo = graphNode(workflow, p.createVideo.nodeId, "CreateVideo", ["images", "fps", "audio", "bit_depth"]);
  assertLink(createVideo.images, p.videoDecode.nodeId, 0, "H3 createVideo.images");
  assertLink(createVideo.audio, p.audioDecode.nodeId, 0, "H3 createVideo.audio");
  if (createVideo.fps !== 24 || (createVideo.bit_depth !== 8 && createVideo.bit_depth !== 10)) {
    fail("H3 CreateVideo fps/bit_depth is invalid");
  }
  const saveVideo = graphNode(workflow, p.saveVideo.nodeId, "SaveVideo", ["video", "filename_prefix", "format", "codec"]);
  assertLink(saveVideo.video, p.createVideo.nodeId, 0, "H3 saveVideo.video");
  boundedString(saveVideo.filename_prefix, 512, "H3 saveVideo.filename_prefix");
  if (saveVideo.format !== "auto") fail("H3 SaveVideo v1 requires format=auto");
  if (saveVideo.codec !== "auto") fail("H3 SaveVideo v1 requires codec=auto");

  if (productionH3ParameterManifestSha256(workflow, contract, execution)
    !== contract.parameterManifest.sha256) {
    fail("H3 actual graph parameter projection digest drifted");
  }
}

function normalizeTemplateForProfile(
  template: Record<string, unknown>,
  contract: ProductionH3GraphContract,
  stageContracts: readonly ProductionH3StageBindingContract[],
  profileId: string,
): Record<string, unknown> {
  const normalized = structuredClone(template);
  for (const binding of stageContracts) {
    if (binding.source === null) continue;
    const node = normalized[binding.source.nodeId];
    if (!isRecord(node) || !isRecord(node.inputs)) fail("H3 stage source is missing");
    if (node.inputs.image !== productionH3StageInputSentinel(profileId, binding.index, binding.slot)) {
      fail(`H3 template source ${binding.index} does not contain the fixed sentinel`);
    }
    node.inputs.image = productionH3StageInputSentinel(TEMPLATE_PROFILE_MARKER, binding.index, binding.slot);
  }
  if (contract.version === 2) {
    for (const [field, node, input] of [
      ["prompt", contract.generator.nodeId, "prompt"],
      ["seed", contract.pipeline.noise.nodeId, "noise_seed"],
    ] as const) {
      const target = normalized[node];
      if (!isRecord(target) || !isRecord(target.inputs)) fail(`H3 contract v2 ${field} node is missing`);
      if (target.inputs[input] !== productionH3ShotRequestSentinel(profileId, field)) {
        fail(`H3 template ${field} does not contain the fixed contract v2 sentinel`);
      }
      target.inputs[input] = productionH3ShotRequestSentinel(TEMPLATE_PROFILE_MARKER, field);
    }
  }
  return normalized;
}

export function assertProductionH3Template(
  workflow: Record<string, unknown>,
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
  stageContracts: readonly ProductionH3StageBindingContract[],
  profileId: string,
): void {
  const normalized = normalizeTemplateForProfile(workflow, contract, stageContracts, profileId);
  assertGraph(normalized, contract, execution, stageContracts, null, null);
}

function parseShotBinding(
  contract: ProductionH3GraphContract,
  shotBinding: ProductionH3ShotBinding | null,
): ProductionH3ShotBinding | null {
  if (contract.version === 1) {
    if (shotBinding !== null) fail("H3 contract v1 does not accept a per-shot binding");
    return null;
  }
  if (shotBinding === null) fail("H3 contract v2 requires the staged ShotRequest prompt/seed");
  boundedString(shotBinding.prompt, 16_384, "H3 shot binding prompt");
  // ShotRequest.output.seed is a uint32 (production-shot-request.ts); a null seed cannot be
  // materialized into a pinned graph and is rejected here rather than silently substituted.
  boundedInteger(shotBinding.seed, 0, 0xffff_ffff, "H3 shot binding seed");
  return Object.freeze({ prompt: shotBinding.prompt, seed: shotBinding.seed });
}

export function materializeProductionH3Workflow(
  template: Record<string, unknown>,
  contract: ProductionH3GraphContract,
  execution: ProductionIntentExecution,
  stageContracts: readonly ProductionH3StageBindingContract[],
  receiptBindings: readonly ProductionH3ReceiptBinding[],
  profileId: string,
  shotBinding: ProductionH3ShotBinding | null = null,
): ProductionH3MaterializedWorkflow {
  assertProductionH3Template(template, contract, execution, stageContracts, profileId);
  const shot = parseShotBinding(contract, shotBinding);
  if (receiptBindings.length !== stageContracts.length) fail("H3 receipt binding count drifted");
  const bound = structuredClone(template);
  const providerKeys = new Map<number, string>();
  const usedKeys = new Set<string>();
  for (let index = 0; index < stageContracts.length; index++) {
    const expected = stageContracts[index]!;
    const actual = receiptBindings[index];
    if (actual === undefined || actual.index !== index || actual.slot !== expected.slot
      || !SHA256.test(actual.assetSha256) || !safeProviderObjectKey(actual.providerObjectKey)) {
      fail(`H3 receipt binding ${index} is invalid or reordered`);
    }
    if (usedKeys.has(actual.providerObjectKey)) fail("H3 receipt provider keys must be unique");
    usedKeys.add(actual.providerObjectKey);
    // The shot-request slot is staged and content-checked but binds no graph node (§5.3).
    if (expected.source === null) continue;
    const node = record(bound[expected.source.nodeId], `H3 stage source ${index}`);
    const inputs = record(node.inputs, `H3 stage source ${index}.inputs`);
    if (inputs.image !== productionH3StageInputSentinel(profileId, index, expected.slot)) {
      fail(`H3 stage source ${index} sentinel drifted before materialization`);
    }
    inputs.image = actual.providerObjectKey;
    providerKeys.set(index, actual.providerObjectKey);
  }
  if (shot !== null) {
    const generator = record(bound[contract.generator.nodeId], "H3 generator");
    const generatorInputs = record(generator.inputs, "H3 generator.inputs");
    if (generatorInputs.prompt !== productionH3ShotRequestSentinel(profileId, "prompt")) {
      fail("H3 prompt sentinel drifted before materialization");
    }
    generatorInputs.prompt = shot.prompt;
    const noise = record(bound[contract.pipeline.noise.nodeId], "H3 noise");
    const noiseInputs = record(noise.inputs, "H3 noise.inputs");
    if (noiseInputs.noise_seed !== productionH3ShotRequestSentinel(profileId, "seed")) {
      fail("H3 seed sentinel drifted before materialization");
    }
    noiseInputs.noise_seed = shot.seed;
  }
  assertGraph(bound, contract, execution, stageContracts, providerKeys, shot);
  return Object.freeze({
    templateWorkflowSha256: productionH3WorkflowSha256(template),
    boundWorkflowSha256: productionH3WorkflowSha256(bound),
    workflow: structuredClone(bound),
  });
}
