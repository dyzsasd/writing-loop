// Deterministically derives the packaged H3 example from AI-SPEC's executable runtime fixture.
// This keeps the documentation fixture as the source of truth while replacing its illustrative
// workflow/parameter digests with the exact canonical identities of the packaged API graph.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertProductionH3Template,
  productionH3ParameterManifestSha256,
  productionH3StageInputSentinel,
  productionH3WorkflowSha256,
} from "../dist/production-h3-graph.js";
import { parseProductionRuntimeConfig } from "../dist/production-runtime-config.js";

const hubRoot = join(import.meta.dirname, "..");
const specFile = join(hubRoot, "..", "docs", "design", "phase-3-remote-production", "AI-SPEC.md");
const exampleRoot = join(hubRoot, "examples", "production", "representative-h3");
const runtimeFile = join(exampleRoot, "production-runtime.json");
const workflowFile = join(exampleRoot, "workflows", "h3-fl2va-portrait.json");
const marker = /<!-- writing-loop-production-runtime-v1-fixture:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- writing-loop-production-runtime-v1-fixture:end -->/;

function requireObject(value, subject) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  return value;
}

function buildTemplate(contract, execution, profile) {
  const bundle = contract.modelBundle;
  const pipeline = contract.pipeline;
  const generatorInputs = {
    clip: [bundle.textEncoder.nodeId, 0],
    vae: [bundle.videoVae.nodeId, 0],
    prompt: "cinematic short-drama shot",
    width: contract.generator.width,
    height: contract.generator.height,
    length: contract.generator.length,
  };
  if (execution.variant === "ref2va") {
    generatorInputs.audio_vae = [bundle.audioVae.nodeId, 0];
    generatorInputs.ref_image_size = "match";
  }
  for (const binding of profile.bindings) {
    generatorInputs[binding.consumer.inputName] = [binding.source.nodeId, binding.source.outputIndex];
  }

  const template = {
    [contract.generator.nodeId]: { class_type: contract.generator.classType, inputs: generatorInputs },
    [bundle.diffusion.nodeId]: {
      class_type: bundle.diffusion.classType,
      inputs: { [bundle.diffusion.inputName]: bundle.diffusion.modelAlias, weight_dtype: "default" },
    },
    [bundle.textEncoder.nodeId]: {
      class_type: bundle.textEncoder.classType,
      inputs: { [bundle.textEncoder.inputName]: bundle.textEncoder.modelAlias, type: "minimax", device: "default" },
    },
    [bundle.videoVae.nodeId]: {
      class_type: bundle.videoVae.classType,
      inputs: { [bundle.videoVae.inputName]: bundle.videoVae.modelAlias },
    },
    [bundle.audioVae.nodeId]: {
      class_type: bundle.audioVae.classType,
      inputs: { [bundle.audioVae.inputName]: bundle.audioVae.modelAlias },
    },
    [pipeline.sigmaShift.nodeId]: {
      class_type: pipeline.sigmaShift.classType,
      inputs: { model: [bundle.diffusion.nodeId, 0], shift_video: 12, shift_audio: 3 },
    },
    [pipeline.guider.nodeId]: {
      class_type: pipeline.guider.classType,
      inputs: { model: [pipeline.sigmaShift.nodeId, 0], conditioning: [contract.generator.nodeId, 0] },
    },
    [pipeline.scheduler.nodeId]: {
      class_type: pipeline.scheduler.classType,
      inputs: { model: [pipeline.sigmaShift.nodeId, 0], scheduler: "simple", steps: 30, denoise: 1 },
    },
    [pipeline.samplerSelect.nodeId]: {
      class_type: pipeline.samplerSelect.classType,
      inputs: { sampler_name: "euler" },
    },
    [pipeline.noise.nodeId]: {
      class_type: pipeline.noise.classType,
      inputs: { noise_seed: 42 },
    },
    [pipeline.sampler.nodeId]: {
      class_type: pipeline.sampler.classType,
      inputs: {
        noise: [pipeline.noise.nodeId, 0],
        guider: [pipeline.guider.nodeId, 0],
        sampler: [pipeline.samplerSelect.nodeId, 0],
        sigmas: [pipeline.scheduler.nodeId, 0],
        latent_image: [contract.generator.nodeId, 1],
      },
    },
    [pipeline.videoDecode.nodeId]: {
      class_type: pipeline.videoDecode.classType,
      inputs: { samples: [pipeline.sampler.nodeId, 0], vae: [bundle.videoVae.nodeId, 0] },
    },
    [pipeline.audioDecode.nodeId]: {
      class_type: pipeline.audioDecode.classType,
      inputs: { samples: [pipeline.sampler.nodeId, 0], vae: [bundle.audioVae.nodeId, 0] },
    },
    [pipeline.createVideo.nodeId]: {
      class_type: pipeline.createVideo.classType,
      inputs: {
        images: [pipeline.videoDecode.nodeId, 0], fps: 24,
        audio: [pipeline.audioDecode.nodeId, 0], bit_depth: 8,
      },
    },
    [pipeline.saveVideo.nodeId]: {
      class_type: pipeline.saveVideo.classType,
      inputs: {
        video: [pipeline.createVideo.nodeId, 0],
        filename_prefix: "video/writing-loop-h3", format: "auto", codec: "auto",
      },
    },
  };
  for (const binding of profile.bindings) {
    template[binding.source.nodeId] = {
      class_type: binding.source.classType,
      inputs: {
        [binding.source.inputName]: productionH3StageInputSentinel(
          profile.profileId, binding.index, binding.slot,
        ),
      },
    };
  }
  return template;
}

function deriveExample() {
  const source = readFileSync(specFile, "utf8");
  const match = marker.exec(source);
  if (match === null) throw new Error("AI-SPEC runtime fixture marker is missing or ambiguous");
  const runtime = requireObject(JSON.parse(match[1]), "AI-SPEC runtime fixture");
  if (!Array.isArray(runtime.workflows) || runtime.workflows.length !== 1
    || !Array.isArray(runtime.stagingProfiles) || runtime.stagingProfiles.length !== 1) {
    throw new Error("packaged example requires the AI-SPEC fixture to contain one H3 workflow/profile");
  }
  const workflow = requireObject(runtime.workflows[0], "AI-SPEC workflow");
  const profile = requireObject(runtime.stagingProfiles[0], "AI-SPEC staging profile");
  const contract = requireObject(workflow.h3GraphContract, "AI-SPEC H3 graph contract");
  const execution = requireObject(profile.execution, "AI-SPEC H3 execution");
  const template = buildTemplate(contract, execution, profile);

  const workflowSha256 = productionH3WorkflowSha256(template);
  const parametersSha256 = productionH3ParameterManifestSha256(template, contract, execution);
  workflow.workflowSha256 = workflowSha256;
  workflow.parametersSha256 = parametersSha256;
  contract.parameterManifest.sha256 = parametersSha256;
  execution.workflowSha256 = workflowSha256;
  execution.parametersSha256 = parametersSha256;

  const parsed = parseProductionRuntimeConfig(runtime);
  const parsedWorkflow = parsed.workflows[0];
  const parsedProfile = parsed.stagingProfiles[0];
  if (parsedWorkflow?.h3GraphContract === null || parsedWorkflow?.h3GraphContract === undefined
    || parsedProfile === undefined) {
    throw new Error("derived packaged example did not preserve its H3 graph/profile");
  }
  assertProductionH3Template(
    template, parsedWorkflow.h3GraphContract, parsedProfile.execution,
    parsedProfile.bindings, parsedProfile.profileId,
  );
  return {
    runtime: `${JSON.stringify(runtime, null, 2)}\n`,
    workflow: `${JSON.stringify(template, null, 2)}\n`,
  };
}

const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error("usage: node test/generate-production-example.mjs [--check|--write]");
}
const derived = deriveExample();
if (mode === "--write") {
  mkdirSync(join(exampleRoot, "workflows"), { recursive: true });
  writeFileSync(runtimeFile, derived.runtime);
  writeFileSync(workflowFile, derived.workflow);
  console.log("PRODUCTION_PACKAGE_EXAMPLE_WRITTEN");
} else {
  if (readFileSync(runtimeFile, "utf8") !== derived.runtime
    || readFileSync(workflowFile, "utf8") !== derived.workflow) {
    throw new Error("packaged production example drifted; run generator with --write");
  }
  // Keep npm pack's stdout machine-readable: prepack forwards build stdout into command
  // substitution, while stderr remains operator-visible.
  console.error("PRODUCTION_PACKAGE_EXAMPLE_OK");
}
