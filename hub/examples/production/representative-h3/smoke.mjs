// Install-shape, secret-free and no-network smoke for the packaged representative H3 bundle.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductionRuntimeRegistry,
  parseProductionRuntimeConfig,
} from "../../../dist/production-runtime-config.js";
import {
  materializeProductionH3Workflow,
  productionH3WorkflowSha256,
} from "../../../dist/production-h3-graph.js";
import { productionWorkerMain } from "../../../dist/production-worker.js";

const exampleRoot = import.meta.dirname;
const runtimeSource = JSON.parse(readFileSync(join(exampleRoot, "production-runtime.json"), "utf8"));
const templateSource = JSON.parse(readFileSync(
  join(exampleRoot, "workflows", "h3-fl2va-portrait.json"), "utf8",
));
const parsed = parseProductionRuntimeConfig(runtimeSource);
const workflow = parsed.workflows[0];
const profile = parsed.stagingProfiles[0];
if (workflow?.h3GraphContract === null || workflow?.h3GraphContract === undefined
  || profile === undefined) {
  throw new Error("packaged H3 runtime config lost its workflow/profile binding");
}

if (profile.bindings?.kind !== "h3-graph-bindings") {
  throw new Error("packaged H3 runtime config lost its LoadImage stage bindings");
}
const stageBindings = profile.bindings.bindings;
const sentinelBefore = templateSource[stageBindings[0].source.nodeId].inputs.image;
const materialized = materializeProductionH3Workflow(
  templateSource,
  workflow.h3GraphContract,
  profile.execution,
  stageBindings,
  stageBindings.map((binding) => ({
    index: binding.index,
    slot: binding.slot,
    assetSha256: String(binding.index + 1).repeat(64),
    providerObjectKey: `scoped/example/${binding.index}/frame.png`,
  })),
  profile.profileId,
);
if (materialized.templateWorkflowSha256 !== workflow.workflowSha256
  || materialized.boundWorkflowSha256 === materialized.templateWorkflowSha256
  || productionH3WorkflowSha256(materialized.workflow) !== materialized.boundWorkflowSha256
  || templateSource[stageBindings[0].source.nodeId].inputs.image !== sentinelBefore
  || materialized.workflow[stageBindings[0].source.nodeId].inputs.image
    !== "scoped/example/0/frame.png") {
  throw new Error("packaged H3 template→bound materialization smoke failed");
}

// 契约 v2：同一骨架、prompt / seed 为 sentinel、index 0 是不绑定 LoadImage 的 shot-request slot。
const runtimeSourceV2 = JSON.parse(readFileSync(join(exampleRoot, "production-runtime-v2.json"), "utf8"));
const parsedV2 = parseProductionRuntimeConfig(runtimeSourceV2);
const workflowV2 = parsedV2.workflows[0];
const profileV2 = parsedV2.stagingProfiles[0];
if (workflowV2?.h3GraphContract?.version !== 2 || profileV2?.bindings?.kind !== "h3-graph-bindings") {
  throw new Error("packaged H3 contract v2 config lost its graph contract or stage bindings");
}
const templateSourceV2 = JSON.parse(readFileSync(
  join(exampleRoot, "workflows", `${profileV2.profileId}.json`), "utf8",
));
const stageBindingsV2 = profileV2.bindings.bindings;
if (stageBindingsV2[0].slot !== "shot-request" || stageBindingsV2[0].source !== null) {
  throw new Error("packaged H3 contract v2 profile lost its index 0 shot-request slot");
}
const generatorNodeV2 = workflowV2.h3GraphContract.generator.nodeId;
const noiseNodeV2 = workflowV2.h3GraphContract.pipeline.noise.nodeId;
const promptSentinel = templateSourceV2[generatorNodeV2].inputs.prompt;
const seedSentinel = templateSourceV2[noiseNodeV2].inputs.noise_seed;
const shotPrompt = "夜色中的天台，人物背对镜头缓慢后拉";
const materializedV2 = materializeProductionH3Workflow(
  templateSourceV2,
  workflowV2.h3GraphContract,
  profileV2.execution,
  stageBindingsV2,
  stageBindingsV2.map((binding) => ({
    index: binding.index,
    slot: binding.slot,
    assetSha256: String(binding.index + 1).repeat(64),
    providerObjectKey: binding.source === null
      ? "scoped/example/0/shot-request.json"
      : `scoped/example/${binding.index}/frame.png`,
  })),
  profileV2.profileId,
  { prompt: shotPrompt, seed: 4242 },
);
if (promptSentinel !== `writing-loop://shot-request/${profileV2.profileId}/prompt`
  || seedSentinel !== `writing-loop://shot-request/${profileV2.profileId}/seed`
  || materializedV2.templateWorkflowSha256 !== workflowV2.workflowSha256
  || materializedV2.workflow[generatorNodeV2].inputs.prompt !== shotPrompt
  || materializedV2.workflow[noiseNodeV2].inputs.noise_seed !== 4242
  || templateSourceV2[generatorNodeV2].inputs.prompt !== promptSentinel
  || templateSourceV2[noiseNodeV2].inputs.noise_seed !== seedSentinel) {
  throw new Error("packaged H3 contract v2 template→bound materialization smoke failed");
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-packaged-h3-")));
let networkCalls = 0;
const noNetwork = async () => {
  networkCalls++;
  throw new Error("packaged production smoke attempted network I/O");
};
try {
  const state = join(root, ".writing-loop");
  const runtime = join(root, "runtime");
  mkdirSync(join(state, "drama-a"), { recursive: true });
  mkdirSync(join(runtime, "workflows"), { recursive: true });
  writeFileSync(join(state, "workspace.json"), `${JSON.stringify({
    version: 1, id: parsed.workspaceId,
  })}\n`);
  writeFileSync(join(state, "config.json"), `${JSON.stringify({
    version: 1, projects: { "drama-a": { enabled: true } },
  })}\n`);
  const configFile = join(runtime, "production-runtime.json");
  writeFileSync(configFile, `${JSON.stringify(runtimeSource, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    join(runtime, "workflows", "h3-fl2va-portrait.json"),
    `${JSON.stringify(templateSource, null, 2)}\n`,
    { mode: 0o600 },
  );

  const credentialEnv = {};
  for (const name of [
    parsed.gateway.credentialEnv,
    ...parsed.backends.map((backend) => backend.credentialEnv),
    ...parsed.stagingProfiles.map((entry) => entry.credentialEnv),
  ]) {
    if (name !== null) credentialEnv[name] = "smoke-only-placeholder";
  }
  const registry = createProductionRuntimeRegistry({
    root,
    configFile,
    env: credentialEnv,
    fetchByBackend: Object.fromEntries(parsed.backends.map((backend) => [backend.backendInstanceId, noNetwork])),
    stagingFetchByProfile: Object.fromEntries(parsed.stagingProfiles.map((entry) => [entry.profileId, noNetwork])),
    gatewayFetch: noNetwork,
    now: () => "2026-08-10T12:00:00.000Z",
  });
  if (registry.projects.length !== 1 || registry.projects[0].allowDispatch !== true) {
    throw new Error("packaged production runtime assembly smoke failed");
  }
  const round = await registry.runner.runOnceAll();
  if (round.outcomes.length !== 1 || round.outcomes[0].status !== "succeeded" || networkCalls !== 0) {
    throw new Error("packaged runtime empty round was not hermetic");
  }

  const workerExit = await productionWorkerMain(
    ["--config", configFile, "--once", "--json"],
    root,
    {
      createRegistry: ({ root: workerRoot, configFile: workerConfig }) => {
        if (workerRoot !== root || workerConfig !== configFile) {
          throw new Error("worker changed the trusted runtime scope");
        }
        return registry;
      },
      signalSource: null,
    },
  );
  if (workerExit !== 0 || networkCalls !== 0) {
    throw new Error("packaged worker --once fake-port smoke failed");
  }
  console.log("PACKAGED_H3_PRODUCTION_SMOKE_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
