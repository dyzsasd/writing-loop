// Visual production regression: strict Blender/keyframe schema, immutable AssetRefs and exact
// binding to canonical story scenes without duplicating story names or narrative facts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVisualMappingsManifest, parseVisualProductionManifest, parseVisualPropStatesManifest,
  readVisualCompileInputs, readVisualProduction, validateVisualProduction,
  type VisualProductionManifest,
} from "../src/visual-production.ts";
import { visualMain } from "../src/visual.ts";
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
  subjectReferences: [],
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
    candidates: [{ id: "K_MAIN", cameraId: "CAM_EST", lightingStateId: "LIGHT_DAY", dressingVariantId: "DRESS_BASE",
      sourceRenderIds: ["R_DEPTH", "R_LINE"],
      workflowProfileId: "keyframe/depth-lineart-v1", workflowSha256: "c".repeat(64), modelSha256: "d".repeat(64),
      promptSha256: "e".repeat(64), seed: 42, asset: asset("approved/s01-main.png"), status: "approved",
      reviewedBy: "operator:demo", reviewedAt: "2026-08-13T09:00:00.000Z", shotIds: ["EP001-S1-1"], containsRealFace: false,
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

const mixedState = clone(manifest); mixedState.scenes[0]!.renders[0]!.lightingStateId = "LIGHT_OTHER";
mixedState.scenes[0]!.lightingStates.push({ id: "LIGHT_OTHER", label: "另一灯光", notes: "仅用于混用回归" });
let mixedRejected = false; try { validateVisualProduction(mixedState, binding); } catch { mixedRejected = true; }
ok(mixedRejected, "同一候选不能混用另一机位、灯光或陈设状态的约束图");

const fakeApproval = clone(manifest); fakeApproval.scenes[0]!.candidates[0]!.reviewedBy = null;
let approvalRejected = false; try { parseVisualProductionManifest(fakeApproval); } catch { approvalRejected = true; }
ok(approvalRejected, "approved/rejected 必须留下操作者与 canonical 审核时间");

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

// —— §6.2 / §6.3：shotIds、subjectReferences、mappings / prop-states、候选图批准轨道 ——
{
  const legacy = clone(manifest) as Record<string, any>;
  delete legacy.subjectReferences;
  delete legacy.scenes[0].candidates[0].shotIds;
  const parsedLegacy = parseVisualProductionManifest(legacy);
  ok(parsedLegacy.subjectReferences.length === 0 && parsedLegacy.scenes[0]!.candidates[0]!.shotIds.length === 0,
    "旧清单缺 subjectReferences / shotIds 时按空数组解析（纯新增字段不使既有文件失效）");

  const duplicateShot = clone(manifest);
  duplicateShot.scenes[0]!.candidates.push({
    ...clone(duplicateShot.scenes[0]!.candidates[0]!), id: "K_ALT", status: "candidate",
    reviewedBy: null, reviewedAt: null,
  });
  let duplicateRejected = false;
  try { validateVisualProduction(duplicateShot, binding); } catch { duplicateRejected = true; }
  ok(duplicateRejected, "同一 shotId 被两张候选图占用时拒绝（无法判定该镜用哪张）");

  // 跨场景同样独占：镜头只属于一个场景，两个场景挂同一 shotId 即配置错误。
  const crossScene = clone(manifest);
  crossScene.scenes[1]!.phase = "keyframe-review";
  crossScene.scenes[1]!.blendAsset = clone(crossScene.scenes[0]!.blendAsset);
  crossScene.scenes[1]!.geometryRevision = 1;
  crossScene.scenes[1]!.cameras = clone(crossScene.scenes[0]!.cameras);
  crossScene.scenes[1]!.lightingStates = clone(crossScene.scenes[0]!.lightingStates);
  crossScene.scenes[1]!.dressingVariants = clone(crossScene.scenes[0]!.dressingVariants);
  crossScene.scenes[1]!.renders = clone(crossScene.scenes[0]!.renders);
  crossScene.scenes[1]!.candidates = [{ ...clone(crossScene.scenes[0]!.candidates[0]!), id: "K_OTHER" }];
  let crossRejected = "";
  try { validateVisualProduction(crossScene, binding); }
  catch (error) { crossRejected = error instanceof Error ? error.message : String(error); }
  ok(crossRejected.includes("被多张候选图占用"), "跨场景重复占用同一 shotId 时拒绝");

  const withSubject = clone(manifest) as Record<string, any>;
  withSubject.subjectReferences = [{
    id: "REF_C01_ARC1",
    subject: { kind: "character", characterId: "C01", appearanceStateId: "APPEARANCE_EARLY" },
    asset: asset("references/c01-early.png"),
    containsRealFace: false,
    approvedBy: "operator:demo",
    approvedAt: "2026-08-13T09:00:00.000Z",
  }];
  ok(parseVisualProductionManifest(withSubject).subjectReferences[0]!.subject.kind === "character",
    "subjectReferences 接受 character/appearanceStateId 形态");
  const halfApproved = clone(withSubject) as Record<string, any>;
  halfApproved.subjectReferences[0].approvedAt = null;
  let halfRejected = false;
  try { parseVisualProductionManifest(halfApproved); } catch { halfRejected = true; }
  ok(halfRejected, "subjectReferences 的批准人与批准时间必须同生同灭");
  const badSubject = clone(withSubject) as Record<string, any>;
  badSubject.subjectReferences[0].subject = { kind: "location", locationId: "S01" };
  let badSubjectRejected = false;
  try { parseVisualProductionManifest(badSubject); } catch { badSubjectRejected = true; }
  ok(badSubjectRejected, "subjectReferences.subject.kind 只接受 character / prop");
}

// mappings / prop-states 解析矩阵
{
  const mappings = {
    version: 1, kind: "writing-loop/visual-mappings", project: "demo",
    lighting: [{ sceneId: "S01", timeOfDay: "day", lightingStateId: "LIGHT_DAY" }],
    dressing: [{ sceneId: "S01", arcId: "ARC_EARLY", dressingVariantId: "DRESS_BASE" }],
  };
  ok(parseVisualMappingsManifest(mappings).lighting[0]!.lightingStateId === "LIGHT_DAY",
    "mappings 解析 (sceneId, timeOfDay) → LIGHT_*");
  for (const [label, mutate, needle] of [
    ["identity", (row: Record<string, any>) => { row.kind = "writing-loop/other"; }, "identity"],
    ["未知字段", (row: Record<string, any>) => { row.extra = 1; }, "字段必须精确为"],
    ["时段枚举", (row: Record<string, any>) => { row.lighting[0].timeOfDay = "noon"; }, "timeOfDay"],
    ["重复映射", (row: Record<string, any>) => { row.lighting.push(clone(row.lighting[0])); }, "不能重复"],
    ["陈设重复", (row: Record<string, any>) => { row.dressing.push(clone(row.dressing[0])); }, "不能重复"],
  ] as const) {
    const broken = clone(mappings) as Record<string, any>;
    mutate(broken);
    let message = "";
    try { parseVisualMappingsManifest(broken); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    ok(message.includes(needle), `mappings 拒绝 ${label}（实得 ${message || "无错误"}）`);
  }

  const propStates = {
    version: 1, kind: "writing-loop/visual-prop-states", project: "demo",
    objects: [{
      objectId: "O01",
      states: [
        { stateId: "O01_CLOSED", label: "木匣闭合", notes: "初始" },
        { stateId: "O01_OPEN", label: "木匣开启", notes: "揭示后" },
      ],
      timeline: [{ episode: 1, sceneId: "S01", stateId: "O01_CLOSED" }],
    }],
  };
  ok(parseVisualPropStatesManifest(propStates).objects[0]!.states.length === 2,
    "prop-states 解析每个道具的已登记状态集合");
  for (const [label, mutate, needle] of [
    ["identity", (row: Record<string, any>) => { row.version = 2; }, "identity"],
    ["未登记 stateId", (row: Record<string, any>) => { row.timeline[0].stateId = "O01_BURNT"; }, "未登记的 stateId"],
    ["排期重复", (row: Record<string, any>) => { row.objects[0].timeline.push(clone(row.objects[0].timeline[0])); }, "不能重复"],
    ["状态重复", (row: Record<string, any>) => { row.objects[0].states.push(clone(row.objects[0].states[0])); }, "不能重复"],
    ["空状态集", (row: Record<string, any>) => { row.objects[0].states = []; }, "1–64 项"],
  ] as const) {
    const broken = clone(propStates) as Record<string, any>;
    if (label === "未登记 stateId") mutate(broken.objects[0]); else mutate(broken);
    let message = "";
    try { parseVisualPropStatesManifest(broken); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    ok(message.includes(needle), `prop-states 拒绝 ${label}（实得 ${message || "无错误"}）`);
  }
}

// 候选图批准轨道（CLI）：阶段约束、canonical reviewedAt、不可改判、装配进编译 policy
{
  const captureVisual = (args: string[], cwd: string): { code: number; out: string; err: string } => {
    const out: string[] = []; const err: string[] = [];
    const oldLog = console.log; const oldError = console.error;
    console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
    try { return { code: visualMain(args, cwd), out: out.join("\n"), err: err.join("\n") }; }
    finally { console.log = oldLog; console.error = oldError; }
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-visual-cli-")));
  try {
    mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
    writeFileSync(join(root, ".writing-loop", "config.json"), JSON.stringify({
      version: 1, projects: { demo: { title: "玉京旧事", repoPath: "repo", enabled: true } },
    }, null, 2) + "\n");
    const repo = join(root, "repo");
    mkdirSync(join(repo, "visual"), { recursive: true });
    const pending = clone(manifest);
    pending.scenes[0]!.phase = "keyframe-review";
    pending.scenes[0]!.candidates[0]!.status = "candidate";
    pending.scenes[0]!.candidates[0]!.reviewedBy = null;
    pending.scenes[0]!.candidates[0]!.reviewedAt = null;
    const write = (value: unknown): void => {
      writeFileSync(join(repo, "visual", "production.v1.json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    };
    write(pending);

    const approved = captureVisual(
      ["approve-candidate", "--project", "demo", "--candidate", "K_MAIN", "--by", "art:lead", "--json"], root,
    );
    ok(approved.code === 0, `visual approve-candidate 退出 0（实得 ${approved.code}；${approved.err}）`);
    const payload = JSON.parse(approved.out) as Record<string, any>;
    ok(payload.candidate.status === "approved" && payload.candidate.reviewedBy === "art:lead"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.candidate.reviewedAt),
    "批准写入 status/reviewedBy 与 canonical UTC reviewedAt");
    ok(readVisualProduction(repo)?.manifest.scenes[0]?.candidates[0]?.status === "approved",
      "裁决落进 visual/production.v1.json");
    const inputs = readVisualCompileInputs(repo);
    ok(inputs.approvedCandidates.K_MAIN?.status === "approved"
      && inputs.approvedCandidates.K_MAIN?.sha256 === pending.scenes[0]!.candidates[0]!.asset.sha256,
    "compile policy 的 approvedCandidates 由 visual/production.v1.json 装配");

    const again = captureVisual(
      ["approve-candidate", "--project", "demo", "--candidate", "K_MAIN", "--by", "art:lead"], root,
    );
    ok(again.code === 1 && again.err.includes("不接受改判"), "已裁决的候选图不接受第二次改判");

    write({ ...pending, scenes: [{ ...pending.scenes[0]!, phase: "passes-ready" }, ...pending.scenes.slice(1)] });
    const wrongPhase = captureVisual(
      ["approve-candidate", "--project", "demo", "--candidate", "K_MAIN", "--by", "art:lead"], root,
    );
    ok(wrongPhase.code === 1 && wrongPhase.err.includes("keyframe-review"),
      "只有 keyframe-review 阶段的场景可以裁决候选图");

    write(pending);
    const rejected = captureVisual(
      ["approve-candidate", "--project", "demo", "--candidate", "K_MAIN", "--by", "art:lead", "--reject", "--json"], root,
    );
    ok(rejected.code === 0 && (JSON.parse(rejected.out) as Record<string, any>).candidate.status === "rejected",
      "--reject 写入 rejected 裁决");

    const missing = captureVisual(
      ["approve-candidate", "--project", "demo", "--candidate", "K_NONE", "--by", "art:lead"], root,
    );
    ok(missing.code === 1 && missing.err.includes("没有候选图"), "未登记的候选图 ID 被拒绝");

    // 装配路径独立复核跨场景独占：readVisualCompileInputs 不经过 validateVisualProduction。
    const crossManifest = clone(pending) as Record<string, any>;
    crossManifest.scenes[1].phase = "keyframe-review";
    crossManifest.scenes[1].blendAsset = clone(crossManifest.scenes[0].blendAsset);
    crossManifest.scenes[1].geometryRevision = 1;
    crossManifest.scenes[1].cameras = clone(crossManifest.scenes[0].cameras);
    crossManifest.scenes[1].lightingStates = clone(crossManifest.scenes[0].lightingStates);
    crossManifest.scenes[1].dressingVariants = clone(crossManifest.scenes[0].dressingVariants);
    crossManifest.scenes[1].renders = clone(crossManifest.scenes[0].renders);
    crossManifest.scenes[1].candidates = [{ ...clone(crossManifest.scenes[0].candidates[0]), id: "K_OTHER" }];
    write(crossManifest);
    let assembleError = "";
    try { readVisualCompileInputs(repo); }
    catch (error) { assembleError = error instanceof Error ? error.message : String(error); }
    ok(assembleError.includes("被多张候选图占用"),
      "readVisualCompileInputs 也复核跨场景的 shotId 独占");
    write(pending);
    const shotCandidates = readVisualCompileInputs(repo).candidatesByShotId;
    ok(shotCandidates["EP001-S1-1"]?.candidateId === "K_MAIN"
      && shotCandidates["EP001-S1-1"]?.containsRealFace === false,
    "candidatesByShotId 按 shotId 索引候选图并带出 containsRealFace");

    // 伴随文件不存在时视为空表（§6.3）。
    const empty = readVisualCompileInputs(repo);
    ok(empty.mappings === null && Object.keys(empty.propStates).length === 0,
      "mappings / prop-states 文件不存在时按空表处理");
    writeFileSync(join(repo, "visual", "mappings.v1.json"), "{ not json", { mode: 0o600 });
    let brokenMessage = "";
    try { readVisualCompileInputs(repo); } catch (error) { brokenMessage = error instanceof Error ? error.message : String(error); }
    ok(brokenMessage.includes("不是有效 JSON"), "伴随文件存在但损坏时硬错，不降级为空表");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log(fails === 0 ? "\nVISUAL_PRODUCTION_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
