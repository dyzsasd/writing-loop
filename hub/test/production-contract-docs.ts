// Executable documentation contract: AI-SPEC's marked v1 wire example must remain accepted by
// the same exactKeys parsers that protect the durable production ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAssetRef,
  parseEpisodeRevisionRef,
  parseProductionSubjectRef,
  parseShotRevisionRef,
} from "../src/production-domain.ts";
import { parseProductionRuntimeConfig } from "../src/production-runtime-config.ts";
import {
  exportExecutionProfileSnapshot,
  parseProductionGatewayRuntimeConfig,
} from "../src/production-gateway-runtime-config.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const specPath = join(import.meta.dirname, "..", "..", "docs", "design", "phase-3-remote-production", "AI-SPEC.md");
const spec = readFileSync(specPath, "utf8");
const markerStarts = spec.match(/<!-- writing-loop-production-v1-wire-fixture:start -->/g)?.length ?? 0;
const markerEnds = spec.match(/<!-- writing-loop-production-v1-wire-fixture:end -->/g)?.length ?? 0;
const fixtureMatch = /<!-- writing-loop-production-v1-wire-fixture:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- writing-loop-production-v1-wire-fixture:end -->/.exec(spec);
const runtimeMarkerStarts = spec.match(/<!-- writing-loop-production-runtime-v1-fixture:start -->/g)?.length ?? 0;
const runtimeMarkerEnds = spec.match(/<!-- writing-loop-production-runtime-v1-fixture:end -->/g)?.length ?? 0;
const runtimeFixtureMatch = /<!-- writing-loop-production-runtime-v1-fixture:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- writing-loop-production-runtime-v1-fixture:end -->/.exec(spec);
ok(markerStarts === 1 && markerEnds === 1 && fixtureMatch !== null,
  "AI-SPEC 保留唯一、稳定的 production v1 wire fixture marker");
ok(spec.includes("AssetRef.uri` 只是 opaque identity")
  && spec.includes("受信任 allowlist") && spec.includes("不得把任意 `https:` AssetRef 直接交给 `fetch`")
  && spec.includes("DNS rebinding"),
"AI-SPEC 固化 AssetRef 只能经 allowlist resolver 解析，禁止 downstream 任意 fetch 的 SSRF 边界");
ok(runtimeMarkerStarts === 1 && runtimeMarkerEnds === 1 && runtimeFixtureMatch !== null,
  "AI-SPEC 保留唯一、稳定的 Phase 3C owner-only runtime v1 fixture marker");
ok(spec.includes("VerifiedStageReceipt")
  && spec.includes("intent 的 `workflowSha256` 永远钉住 template")
  && spec.includes("boundWorkflowSha256")
  && spec.includes("ProductionJobStorageAdmissionPolicy")
  && spec.includes("recordBytesUpperBound")
  && spec.includes("unused-before-record")
  && spec.includes("拒绝 committed release")
  && spec.includes("SubmissionAdmissionPolicy.acquire()")
  && spec.includes("submitted | not-submitted | submission-unknown")
  && spec.includes("writing-loop-production-worker --config")
  && spec.includes("不提供 permissive 默认 admission"),
"AI-SPEC 固化 receipt/materialization、durable storage quota、单 outcome submission admission 与 worker 边界");
ok(spec.includes("representative API-format contract fixture")
  && spec.includes("没有经过 live ComfyUI `/prompt`")
  && spec.includes("https://docs.comfy.org/tutorials/video/minimax/minimax-h3")
  && spec.includes("comfy_extras/nodes_minimax_h3.py")
  && spec.includes("Comfy-Org/workflow_templates"),
"AI-SPEC 明示 H3 fixture 不是部署证明，并链接 Comfy 官方 primary sources");

if (fixtureMatch) {
  try {
    const raw = JSON.parse(fixtureMatch[1]) as {
      shot?: { episode?: { source?: unknown }; source?: unknown };
    };
    const subject = parseProductionSubjectRef(raw, "AI-SPEC wire fixture");
    const shot = parseShotRevisionRef(raw.shot, "AI-SPEC shot fixture");
    const episode = parseEpisodeRevisionRef(raw.shot?.episode, "AI-SPEC episode fixture");
    const episodeAsset = parseAssetRef(raw.shot?.episode?.source, "AI-SPEC episode AssetRef fixture");
    const shotAsset = parseAssetRef(raw.shot?.source, "AI-SPEC shot AssetRef fixture");
    ok(subject.kind === "shot" && subject.shot.shotId === "shot-001"
      && shot.revision === 2 && episode.revision === 3
      && episodeAsset.mediaType === "text/markdown" && shotAsset.mediaType === "application/json",
    "AI-SPEC revision/AssetRef JSON 被真实 strict v1 parser 接受");
  } catch (error) {
    ok(false, `AI-SPEC wire fixture 与 production-domain 漂移：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (runtimeFixtureMatch) {
  try {
    const runtime = parseProductionRuntimeConfig(JSON.parse(runtimeFixtureMatch[1]));
    const workflow = runtime.workflows[0];
    const graph = workflow?.h3GraphContract;
    const profileBindings = runtime.stagingProfiles[0]?.bindings;
    const binding = profileBindings?.kind === "h3-graph-bindings" ? profileBindings.bindings[0] : undefined;
    ok(runtime.projects[0]?.project === "drama-a"
      && runtime.backends[0]?.kind === "production-gateway"
      && workflow?.inputPolicy === "scoped-staging"
      && runtime.stagingProfiles[0]?.execution.modelFamily === "minimax-h3"
      && graph?.generator.classType === "MiniMaxH3ImageToVideo"
      && graph.generator.nodeId === "10" && graph.generator.width === 768
      && graph.generator.height === 1_344 && graph.generator.length === 192
      && graph.modelBundle.sha256 === workflow.modelSha256
      && graph.modelBundle.diffusion.classType === "UNETLoader"
      && graph.modelBundle.textEncoder.classType === "CLIPLoader"
      && graph.modelBundle.videoVae.classType === "VAELoader"
      && graph.modelBundle.audioVae.classType === "VAELoader"
      && graph.pipeline.sigmaShift.classType === "MiniMaxH3SigmaShift"
      && graph.pipeline.sampler.classType === "SamplerCustomAdvanced"
      && graph.pipeline.saveVideo.classType === "SaveVideo"
      && graph.parameterManifest.sha256 === workflow.parametersSha256
      && binding?.source?.classType === "LoadImage" && binding.source.inputName === "image"
      && binding.source.outputIndex === 0 && binding.consumer?.nodeId === graph.generator.nodeId
      && binding.consumer.inputName === "first_frame",
    "AI-SPEC runtime fixture 通过真实 strict parser，并冻结 H3 四模型、active pipeline 与 source→consumer binding");
  } catch (error) {
    ok(false, `AI-SPEC runtime fixture 与 production-runtime-config 漂移：${error instanceof Error ? error.message : String(error)}`);
  }
}

const gatewayMarkerStarts = spec.match(/<!-- writing-loop-production-gateway-registry-v1-fixture:start -->/g)?.length ?? 0;
const gatewayMarkerEnds = spec.match(/<!-- writing-loop-production-gateway-registry-v1-fixture:end -->/g)?.length ?? 0;
const gatewayFixtureMatch = /<!-- writing-loop-production-gateway-registry-v1-fixture:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- writing-loop-production-gateway-registry-v1-fixture:end -->/.exec(spec);
ok(gatewayMarkerStarts === 1 && gatewayMarkerEnds === 1 && gatewayFixtureMatch !== null,
  "AI-SPEC 保留唯一、稳定的 Phase 1 gateway registry v1 fixture marker");
ok(spec.includes("writing-loop-production-gateway --config FILE")
  && spec.includes("Authorization: Bearer <auth.bearerEnv 的值>")
  && spec.includes("只接受 RFC1918 私网 IPv4 或 `127.0.0.1` 字面地址")
  && spec.includes("只接受 literal loopback HTTP")
  && spec.includes("cas://<casAuthority>/sha256/<digest>")
  && spec.includes("--export-profile-snapshot")
  && spec.includes("价目不存在第二处")
  && spec.includes("`ProductionLicenseEvidence` 形态的 `license`"),
"AI-SPEC 固化 gateway 进程的 bind、bearer、loopback ComfyUI、cas resolver 与只读价目快照边界");

if (gatewayFixtureMatch) {
  try {
    const gatewayConfig = parseProductionGatewayRuntimeConfig(JSON.parse(gatewayFixtureMatch[1]));
    const profile = gatewayConfig.executionProfiles[0];
    const stageProfile = gatewayConfig.stageProfiles[0];
    const snapshot = exportExecutionProfileSnapshot(gatewayConfig);
    ok(gatewayConfig.listen.host === "10.148.0.9" && gatewayConfig.auth.bearerEnv.length > 0
      && gatewayConfig.backends[0]?.kind === "comfyui"
      && gatewayConfig.backends[0].comfyBaseUrl.startsWith("http://127.0.0.1")
      && gatewayConfig.casAuthority === "wl-sg"
      && profile?.execution.kind === "writing-loop/execution-profile"
      && profile.execution.modelFamily === "minimax-h3"
      && profile.intentExecution.modelFamily === "minimax-h3"
      && profile.intentExecution.workflowSha256 === profile.execution.workflowSha256
      && profile.priceTable?.basis === "tariff"
      && !("licenseObligations" in profile.execution)
      && profile.license.obligations?.attribution === "MiniMax H3"
      && profile.license.obligations.revenueThresholdUsd === 20_000_000
      && profile.license.obligations.noModelImprovement === true
      && profile.processingRegions[0] === "SG"
      && stageProfile?.providerCasNamespace === "wlcas/sha256"
      && stageProfile.inputs[0]?.slot === stageProfile.bindings[0]?.slot
      && snapshot.profiles.length === 1
      && /^[a-f0-9]{64}$/.test(snapshot.profiles[0]!.profileDigest)
      && snapshot.profiles[0]!.execution.workflowSha256 === profile.execution.workflowSha256
      && snapshot.profiles[0]!.durationGrid.length === 1,
    "AI-SPEC gateway registry fixture 通过真实 strict parser（义务只在 license.obligations），并导出可校验的只读 profile 快照");
  } catch (error) {
    ok(false, `AI-SPEC gateway registry fixture 与 production-gateway-runtime-config 漂移：${
      error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(fails === 0 ? "\nPRODUCTION_CONTRACT_DOCS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
