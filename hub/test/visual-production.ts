// Visual production regression: strict Blender/keyframe schema, immutable AssetRefs and exact
// binding to canonical story scenes without duplicating story names or narrative facts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVisualProductionManifest, readVisualProduction, validateVisualProduction,
  type VisualProductionManifest,
} from "../src/visual-production.ts";
import { renderVisualProductionSection } from "../src/studio-view.ts";
import type { StoryStudioReadModel } from "../src/story-design.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const clone = <T>(value: T): T => structuredClone(value);
const SHA = "a".repeat(64);
const asset = (name: string, mediaType = "image/png") => ({
  version: 1 as const, uri: `asset://local/yujing/${name}`, sha256: "b".repeat(64), byteLength: 1234, mediaType,
});

const manifest: VisualProductionManifest = {
  version: 1,
  kind: "writing-loop/visual-production",
  project: "demo",
  storyDesignSha256: SHA,
  revision: 1,
  defaults: { coordinateSystem: "blender-z-up", unitScaleMeters: 1, renderEngine: "eevee", imageWorkflowProfileId: null },
  scenes: [{
    sceneId: "S01", phase: "approved", blendAsset: asset("sets/s01-r1.blend", "application/x-blender"), geometryRevision: 1,
    cameras: [{ id: "CAM_EST", label: "院门建立镜头", lensMm: 28, sensorWidthMm: 36, aspectRatio: "9:16",
      transform: { locationMeters: [1, 2, 3], rotationEulerDegrees: [80, 0, 24] } }],
    lightingStates: [{ id: "LIGHT_DAY", label: "阴天日景", notes: "软光保留屋檐层次" }],
    dressingVariants: [{ id: "DRESS_BASE", label: "寒门时期", notes: "门漆剥落，不增加剧情道具" }],
    renders: [
      { id: "R_DEPTH", cameraId: "CAM_EST", lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE", pass: "depth", asset: asset("passes/s01-depth.exr", "image/x-exr") },
      { id: "R_LINE", cameraId: "CAM_EST", lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE", pass: "lineart", asset: asset("passes/s01-line.png") },
    ],
    candidates: [{ id: "K_MAIN", cameraId: "CAM_EST", sourceRenderIds: ["R_DEPTH", "R_LINE"],
      workflowProfileId: "keyframe/depth-lineart-v1", workflowSha256: "c".repeat(64), modelSha256: "d".repeat(64),
      promptSha256: "e".repeat(64), seed: 42, asset: asset("approved/s01-main.png"), status: "approved",
      notes: "人工批准的空间与光影基准，不是 H3 输出" }],
  }, {
    sceneId: "S02", phase: "planned", blendAsset: null, geometryRevision: 0,
    cameras: [{ id: "CAM_WIDE", label: "公堂广角", lensMm: 24, sensorWidthMm: 36, aspectRatio: "9:16", transform: null }],
    lightingStates: [], dressingVariants: [], renders: [], candidates: [],
  }],
};
const binding = { project: "demo", storyDesignSha256: SHA,
  scenes: [{ id: "S01", variantOf: null }, { id: "S02", variantOf: "S01" }] };

const parsed = parseVisualProductionManifest(JSON.parse(JSON.stringify(manifest)));
validateVisualProduction(parsed, binding);
ok(parsed.scenes.length === 2 && parsed.scenes[0]?.candidates[0]?.status === "approved",
  "完整 Blender→约束图→批准关键帧清单通过 strict parser 与场景绑定");
ok(!("name" in parsed.scenes[0]!), "视觉清单只引用 sceneId，不复制剧情场景名称与事实");
const studioModel = {
  version: 1, project: "demo", source: null,
  story: { path: "story/outline.v1.json", sha256: SHA,
    manifest: { scenes: [
      { id: "S01", name: "档案厅", primary: true, variantOf: null, reusePlan: "未来/过去复用几何", productionNotes: "" },
      { id: "S02", name: "河港", primary: false, variantOf: "S01", reusePlan: "状态变体", productionNotes: "" },
    ] }, assets: { scenes: [
      { id: "S01", name: "档案厅", primary: true, variantOf: null, reusePlan: "未来/过去复用几何" },
      { id: "S02", name: "河港", primary: false, variantOf: "S01", reusePlan: "状态变体" },
    ] }, catalog: null },
  visualProduction: { path: "visual/production.v1.json", digest: "9".repeat(64), manifest: parsed },
  visualProductionError: null, gates: [], summary: { stage: "full", passed: 0, failed: 0, skipped: 0, readyForEpisodes: true }, warnings: [],
} as unknown as StoryStudioReadModel;
const artHtml = renderVisualProductionSection(studioModel);
ok(artHtml.includes("Blender 布景") && artHtml.includes("空间约束通道")
  && artHtml.includes("CAM_EST · 院门建立镜头 · 28mm") && artHtml.includes("H3 输入可选")
  && artHtml.includes("H3 未启动"),
"Studio 美术资产页分别展示 Blender/约束图/批准关键帧与未启动 H3 状态");

let unknownRejected = false;
try { parseVisualProductionManifest({ ...manifest, rawWorkflow: {} }); } catch { unknownRejected = true; }
ok(unknownRejected, "strict parser 拒绝任意 workflow/未知顶层字段");

const stale = clone(manifest); stale.storyDesignSha256 = "f".repeat(64);
let staleRejected = false; try { validateVisualProduction(stale, binding); } catch { staleRejected = true; }
ok(staleRejected, "旧 story design digest 不能继续驱动新视觉生产");

const unknownScene = clone(manifest); unknownScene.scenes[0]!.sceneId = "S99";
let sceneRejected = false; try { validateVisualProduction(unknownScene, binding); } catch { sceneRejected = true; }
ok(sceneRejected, "视觉清单不能创建故事结构之外的平行场景 registry");

const missingGeometry = clone(manifest); missingGeometry.scenes[0]!.blendAsset = null;
let geometryRejected = false; try { validateVisualProduction(missingGeometry, binding); } catch { geometryRejected = true; }
ok(geometryRejected, "非 planned 阶段没有不可变 .blend AssetRef 时 fail-closed");

const noSpatialConstraint = clone(manifest); noSpatialConstraint.scenes[0]!.renders[0]!.pass = "clay";
noSpatialConstraint.scenes[0]!.renders[1]!.pass = "pose";
let constraintRejected = false; try { validateVisualProduction(noSpatialConstraint, binding); } catch { constraintRejected = true; }
ok(constraintRejected, "候选关键帧缺少 depth/normal/lineart 空间约束时拒绝");

const unsafe = clone(manifest); unsafe.scenes[0]!.blendAsset = {
  ...asset("sets/s01.blend", "application/x-blender"), uri: "/Users/operator/scene.blend",
};
let unsafeRejected = false; try { parseVisualProductionManifest(unsafe); } catch { unsafeRejected = true; }
ok(unsafeRejected, "清单拒绝本机绝对路径，二进制只以稳定 AssetRef 登记");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-visual-production-")));
try {
  mkdirSync(join(tmp, "visual"), { recursive: true });
  writeFileSync(join(tmp, "visual", "production.v1.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  const read = readVisualProduction(tmp);
  ok(read?.manifest.revision === 1 && read.digest.length === 64,
    "安全 bounded reader 读取视觉清单并给出 canonical digest");
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(fails === 0 ? "\nVISUAL_PRODUCTION_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
