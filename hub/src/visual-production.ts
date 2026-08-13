// Strict, story-bound visual production ledger for Blender previs and generated keyframes.
//
// Story structure remains authoritative for scene identity and reuse. This companion records only
// production facts: Blender geometry revisions, camera rigs, render passes and reviewed images.
// Large binaries never live in JSON; every produced file is an immutable AssetRef.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import { parseAssetRef, type AssetRef } from "./production-domain.ts";
import { WsError } from "./workspace.ts";

export const VISUAL_PRODUCTION_RELATIVE_PATH = "visual/production.v1.json";
export const MAX_VISUAL_PRODUCTION_BYTES = 4 * 1024 * 1024;

export type VisualProductionPhase = "planned" | "blockout" | "passes-ready" | "keyframe-review" | "approved";
export type VisualRenderPassKind = "clay" | "depth" | "normal" | "lineart" | "object-mask" | "pose" | "motion-vector";
export type VisualCameraTransform = {
  locationMeters: [number, number, number];
  rotationEulerDegrees: [number, number, number];
};
export type VisualCameraRig = {
  id: string;
  label: string;
  lensMm: number;
  sensorWidthMm: number;
  aspectRatio: "9:16" | "16:9" | "1:1";
  transform: VisualCameraTransform | null;
};
export type VisualNamedState = { id: string; label: string; notes: string };
export type VisualRenderPass = {
  id: string;
  cameraId: string;
  lightingStateId: string;
  dressingVariantId: string;
  pass: VisualRenderPassKind;
  asset: AssetRef;
};
export type VisualGenerationCandidate = {
  id: string;
  cameraId: string;
  lightingStateId: string;
  dressingVariantId: string;
  sourceRenderIds: string[];
  workflowProfileId: string;
  workflowSha256: string;
  modelSha256: string;
  promptSha256: string;
  seed: number;
  asset: AssetRef;
  status: "candidate" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string;
};
export type VisualProductionScene = {
  sceneId: string;
  phase: VisualProductionPhase;
  blendAsset: AssetRef | null;
  geometryRevision: number;
  cameras: VisualCameraRig[];
  lightingStates: VisualNamedState[];
  dressingVariants: VisualNamedState[];
  renders: VisualRenderPass[];
  candidates: VisualGenerationCandidate[];
};
export type VisualProductionManifest = {
  version: 1;
  kind: "writing-loop/visual-production";
  project: string;
  storyDesignSha256: string;
  revision: number;
  defaults: {
    coordinateSystem: "blender-z-up";
    unitScaleMeters: number;
    renderEngine: "workbench" | "eevee" | "cycles";
    imageWorkflowProfileId: string | null;
  };
  scenes: VisualProductionScene[];
};
export type VisualProductionRead = { path: string; digest: string; manifest: VisualProductionManifest };
export type VisualProductionBinding = {
  project: string;
  storyDesignSha256: string;
  scenes: Array<{ id: string; variantOf: string | null }>;
};

export class VisualProductionError extends WsError {
  constructor(message: string) { super(message); this.name = "VisualProductionError"; }
}

type Obj = Record<string, unknown>;
const ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown, label: string): Obj => {
  if (!isObj(value)) throw new VisualProductionError(`${label} 必须是 JSON 对象`);
  return value;
};
const exactKeys = (value: Obj, expected: string[], label: string): void => {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new VisualProductionError(`${label} 字段必须精确为 ${wanted.join(", ")}`);
  }
};
const text = (value: unknown, label: string, max = 2_000): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max) {
    throw new VisualProductionError(`${label} 必须是 1–${max} 字符的非空字符串`);
  }
  return value.trim().replace(/\r\n/g, "\n");
};
const id = (value: unknown, label: string): string => {
  const result = text(value, label, 64);
  if (!ID.test(result)) throw new VisualProductionError(`${label} 必须是安全 ASCII ID`);
  return result;
};
const number = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new VisualProductionError(`${label} 必须是 ${min}–${max} 的有限数字`);
  }
  return value;
};
const integer = (value: unknown, label: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new VisualProductionError(`${label} 必须是 ${min}–${max} 的安全整数`);
  }
  return Number(value);
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new VisualProductionError(`${label} 无效`);
  return value as T;
};
const sha = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA.test(value)) throw new VisualProductionError(`${label} 必须是 64 位小写 sha256`);
  return value;
};
const iso = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new VisualProductionError(`${label} 必须是 canonical UTC ISO 时间`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new VisualProductionError(`${label} 无效`);
  return value;
};
const unique = <T>(rows: T[], key: (row: T) => string, label: string): void => {
  const values = rows.map(key);
  if (new Set(values).size !== values.length) throw new VisualProductionError(`${label} 不能重复`);
};
const parseAsset = (value: unknown, label: string): AssetRef => {
  try { return parseAssetRef(value, label); }
  catch (error) { throw new VisualProductionError(error instanceof Error ? error.message : String(error)); }
};
const triple = (value: unknown, label: string): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) throw new VisualProductionError(`${label} 必须是 3 项数组`);
  return value.map((entry, index) => number(entry, `${label}[${index}]`, -1_000_000, 1_000_000)) as [number, number, number];
};

function parseNamedState(value: unknown, label: string): VisualNamedState {
  const row = object(value, label); exactKeys(row, ["id", "label", "notes"], label);
  return { id: id(row.id, `${label}.id`), label: text(row.label, `${label}.label`, 160),
    notes: text(row.notes, `${label}.notes`, 1_000) };
}

function parseCamera(value: unknown, label: string): VisualCameraRig {
  const row = object(value, label);
  exactKeys(row, ["id", "label", "lensMm", "sensorWidthMm", "aspectRatio", "transform"], label);
  let transform: VisualCameraTransform | null = null;
  if (row.transform !== null) {
    const value = object(row.transform, `${label}.transform`);
    exactKeys(value, ["locationMeters", "rotationEulerDegrees"], `${label}.transform`);
    transform = { locationMeters: triple(value.locationMeters, `${label}.transform.locationMeters`),
      rotationEulerDegrees: triple(value.rotationEulerDegrees, `${label}.transform.rotationEulerDegrees`) };
  }
  return { id: id(row.id, `${label}.id`), label: text(row.label, `${label}.label`, 160),
    lensMm: number(row.lensMm, `${label}.lensMm`, 1, 500), sensorWidthMm: number(row.sensorWidthMm, `${label}.sensorWidthMm`, 1, 100),
    aspectRatio: enumValue(row.aspectRatio, ["9:16", "16:9", "1:1"] as const, `${label}.aspectRatio`), transform };
}

function parseRender(value: unknown, label: string): VisualRenderPass {
  const row = object(value, label);
  exactKeys(row, ["id", "cameraId", "lightingStateId", "dressingVariantId", "pass", "asset"], label);
  const asset = parseAsset(row.asset, `${label}.asset`);
  if (!asset.mediaType.startsWith("image/")) throw new VisualProductionError(`${label}.asset 必须是图片 AssetRef`);
  return { id: id(row.id, `${label}.id`), cameraId: id(row.cameraId, `${label}.cameraId`),
    lightingStateId: id(row.lightingStateId, `${label}.lightingStateId`),
    dressingVariantId: id(row.dressingVariantId, `${label}.dressingVariantId`),
    pass: enumValue(row.pass, ["clay", "depth", "normal", "lineart", "object-mask", "pose", "motion-vector"] as const, `${label}.pass`), asset };
}

function parseCandidate(value: unknown, label: string): VisualGenerationCandidate {
  const row = object(value, label);
  exactKeys(row, ["id", "cameraId", "lightingStateId", "dressingVariantId", "sourceRenderIds", "workflowProfileId",
    "workflowSha256", "modelSha256", "promptSha256", "seed", "asset", "status", "reviewedBy", "reviewedAt", "notes"], label);
  if (!Array.isArray(row.sourceRenderIds) || row.sourceRenderIds.length < 1 || row.sourceRenderIds.length > 32) {
    throw new VisualProductionError(`${label}.sourceRenderIds 必须是 1–32 项数组`);
  }
  const sourceRenderIds = row.sourceRenderIds.map((value, index) => id(value, `${label}.sourceRenderIds[${index}]`));
  unique(sourceRenderIds, (entry) => entry, `${label}.sourceRenderIds`);
  const workflowProfileId = text(row.workflowProfileId, `${label}.workflowProfileId`, 128);
  if (!PROFILE_ID.test(workflowProfileId)) throw new VisualProductionError(`${label}.workflowProfileId 无效`);
  const asset = parseAsset(row.asset, `${label}.asset`);
  if (!asset.mediaType.startsWith("image/")) throw new VisualProductionError(`${label}.asset 必须是图片 AssetRef`);
  const status = enumValue(row.status, ["candidate", "approved", "rejected"] as const, `${label}.status`);
  let reviewedBy: string | null = null; let reviewedAt: string | null = null;
  if (status === "candidate") {
    if (row.reviewedBy !== null || row.reviewedAt !== null) throw new VisualProductionError(`${label} candidate 不能伪造已审核事实`);
  } else {
    reviewedBy = text(row.reviewedBy, `${label}.reviewedBy`, 128);
    if (!ACTOR_ID.test(reviewedBy)) throw new VisualProductionError(`${label}.reviewedBy 无效`);
    reviewedAt = iso(row.reviewedAt, `${label}.reviewedAt`);
  }
  return { id: id(row.id, `${label}.id`), cameraId: id(row.cameraId, `${label}.cameraId`),
    lightingStateId: id(row.lightingStateId, `${label}.lightingStateId`),
    dressingVariantId: id(row.dressingVariantId, `${label}.dressingVariantId`), sourceRenderIds,
    workflowProfileId, workflowSha256: sha(row.workflowSha256, `${label}.workflowSha256`),
    modelSha256: sha(row.modelSha256, `${label}.modelSha256`), promptSha256: sha(row.promptSha256, `${label}.promptSha256`),
    seed: integer(row.seed, `${label}.seed`, 0, Number.MAX_SAFE_INTEGER), asset,
    status, reviewedBy, reviewedAt, notes: text(row.notes, `${label}.notes`, 1_000) };
}

function parseScene(value: unknown, index: number): VisualProductionScene {
  const label = `scenes[${index}]`; const row = object(value, label);
  exactKeys(row, ["sceneId", "phase", "blendAsset", "geometryRevision", "cameras", "lightingStates",
    "dressingVariants", "renders", "candidates"], label);
  if (!Array.isArray(row.cameras) || row.cameras.length > 64) throw new VisualProductionError(`${label}.cameras 必须是最多 64 项数组`);
  if (!Array.isArray(row.lightingStates) || row.lightingStates.length > 32) throw new VisualProductionError(`${label}.lightingStates 必须是最多 32 项数组`);
  if (!Array.isArray(row.dressingVariants) || row.dressingVariants.length > 32) throw new VisualProductionError(`${label}.dressingVariants 必须是最多 32 项数组`);
  if (!Array.isArray(row.renders) || row.renders.length > 2_048) throw new VisualProductionError(`${label}.renders 必须是最多 2048 项数组`);
  if (!Array.isArray(row.candidates) || row.candidates.length > 2_048) throw new VisualProductionError(`${label}.candidates 必须是最多 2048 项数组`);
  const blendAsset = row.blendAsset === null ? null : parseAsset(row.blendAsset, `${label}.blendAsset`);
  if (blendAsset && blendAsset.mediaType !== "application/x-blender") throw new VisualProductionError(`${label}.blendAsset mediaType 必须是 application/x-blender`);
  const scene: VisualProductionScene = { sceneId: id(row.sceneId, `${label}.sceneId`),
    phase: enumValue(row.phase, ["planned", "blockout", "passes-ready", "keyframe-review", "approved"] as const, `${label}.phase`),
    blendAsset, geometryRevision: integer(row.geometryRevision, `${label}.geometryRevision`, 0, Number.MAX_SAFE_INTEGER),
    cameras: row.cameras.map((entry, cameraIndex) => parseCamera(entry, `${label}.cameras[${cameraIndex}]`)),
    lightingStates: row.lightingStates.map((entry, stateIndex) => parseNamedState(entry, `${label}.lightingStates[${stateIndex}]`)),
    dressingVariants: row.dressingVariants.map((entry, stateIndex) => parseNamedState(entry, `${label}.dressingVariants[${stateIndex}]`)),
    renders: row.renders.map((entry, renderIndex) => parseRender(entry, `${label}.renders[${renderIndex}]`)),
    candidates: row.candidates.map((entry, candidateIndex) => parseCandidate(entry, `${label}.candidates[${candidateIndex}]`)) };
  unique(scene.cameras, (entry) => entry.id, `${label}.cameras.id`);
  unique(scene.lightingStates, (entry) => entry.id, `${label}.lightingStates.id`);
  unique(scene.dressingVariants, (entry) => entry.id, `${label}.dressingVariants.id`);
  unique(scene.renders, (entry) => entry.id, `${label}.renders.id`);
  unique(scene.candidates, (entry) => entry.id, `${label}.candidates.id`);
  return scene;
}

export function parseVisualProductionManifest(value: unknown): VisualProductionManifest {
  const root = object(value, "visual production");
  exactKeys(root, ["version", "kind", "project", "storyDesignSha256", "revision", "defaults", "scenes"], "visual production");
  if (root.version !== 1 || root.kind !== "writing-loop/visual-production") throw new VisualProductionError("visual production identity 无效");
  const project = text(root.project, "visual production.project", 32);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(project)) throw new VisualProductionError("visual production.project 无效");
  const defaults = object(root.defaults, "visual production.defaults");
  exactKeys(defaults, ["coordinateSystem", "unitScaleMeters", "renderEngine", "imageWorkflowProfileId"], "visual production.defaults");
  const imageWorkflowProfileId = defaults.imageWorkflowProfileId === null ? null
    : text(defaults.imageWorkflowProfileId, "visual production.defaults.imageWorkflowProfileId", 128);
  if (imageWorkflowProfileId !== null && !PROFILE_ID.test(imageWorkflowProfileId)) throw new VisualProductionError("visual production.defaults.imageWorkflowProfileId 无效");
  if (!Array.isArray(root.scenes) || root.scenes.length > 200) throw new VisualProductionError("visual production.scenes 必须是最多 200 项数组");
  const scenes = root.scenes.map(parseScene); unique(scenes, (entry) => entry.sceneId, "visual production.scenes.sceneId");
  return { version: 1, kind: "writing-loop/visual-production", project,
    storyDesignSha256: sha(root.storyDesignSha256, "visual production.storyDesignSha256"),
    revision: integer(root.revision, "visual production.revision", 1, Number.MAX_SAFE_INTEGER),
    defaults: { coordinateSystem: enumValue(defaults.coordinateSystem, ["blender-z-up"] as const, "visual production.defaults.coordinateSystem"),
      unitScaleMeters: number(defaults.unitScaleMeters, "visual production.defaults.unitScaleMeters", 0.000001, 1_000),
      renderEngine: enumValue(defaults.renderEngine, ["workbench", "eevee", "cycles"] as const, "visual production.defaults.renderEngine"),
      imageWorkflowProfileId }, scenes };
}

export function readVisualProduction(repo: string): VisualProductionRead | null {
  const path = join(repo, VISUAL_PRODUCTION_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  const raw = readRegularTextExact(path, MAX_VISUAL_PRODUCTION_BYTES);
  if (raw === null) throw new VisualProductionError(`${VISUAL_PRODUCTION_RELATIVE_PATH} 必须是未变化、单链接、<=${MAX_VISUAL_PRODUCTION_BYTES} bytes 的 UTF-8 普通文件`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new VisualProductionError(`${VISUAL_PRODUCTION_RELATIVE_PATH} 不是有效 JSON`); }
  const manifest = parseVisualProductionManifest(parsed);
  return { path, manifest, digest: productionCanonicalJsonSha256(manifest) };
}

export function validateVisualProduction(manifest: VisualProductionManifest, binding: VisualProductionBinding): void {
  if (manifest.project !== binding.project) throw new VisualProductionError(`visual project ${manifest.project} 与 ${binding.project} 不一致`);
  if (manifest.storyDesignSha256 !== binding.storyDesignSha256) throw new VisualProductionError("visual production 绑定的是旧 story/outline.v1.json");
  const storyScenes = new Map(binding.scenes.map((scene) => [scene.id, scene] as const));
  for (const scene of manifest.scenes) {
    if (!storyScenes.has(scene.sceneId)) throw new VisualProductionError(`${scene.sceneId} 不属于 story design 场景`);
    if (scene.phase !== "planned" && scene.blendAsset === null) throw new VisualProductionError(`${scene.sceneId} ${scene.phase} 阶段必须登记 .blend AssetRef`);
    if (scene.blendAsset === null && scene.geometryRevision !== 0) throw new VisualProductionError(`${scene.sceneId} 未登记 .blend 时 geometryRevision 必须为 0`);
    if (scene.blendAsset !== null && scene.geometryRevision < 1) throw new VisualProductionError(`${scene.sceneId} 已登记 .blend 时 geometryRevision 必须 >= 1`);
    const cameras = new Set(scene.cameras.map((entry) => entry.id));
    const lighting = new Set(scene.lightingStates.map((entry) => entry.id));
    const dressing = new Set(scene.dressingVariants.map((entry) => entry.id));
    const renders = new Map(scene.renders.map((entry) => [entry.id, entry] as const));
    const renderSlots = new Set<string>();
    for (const render of scene.renders) {
      if (!cameras.has(render.cameraId) || !lighting.has(render.lightingStateId) || !dressing.has(render.dressingVariantId)) {
        throw new VisualProductionError(`${scene.sceneId}/${render.id} 引用了不存在的 camera/light/dressing`);
      }
      const slot = `${render.cameraId}:${render.lightingStateId}:${render.dressingVariantId}:${render.pass}`;
      if (renderSlots.has(slot)) throw new VisualProductionError(`${scene.sceneId} render slot ${slot} 重复`);
      renderSlots.add(slot);
    }
    for (const candidate of scene.candidates) {
      if (!cameras.has(candidate.cameraId) || !lighting.has(candidate.lightingStateId) || !dressing.has(candidate.dressingVariantId)) {
        throw new VisualProductionError(`${scene.sceneId}/${candidate.id} 引用了不存在的 camera/light/dressing`);
      }
      const sources = candidate.sourceRenderIds.map((source) => renders.get(source));
      if (sources.some((source) => !source)) throw new VisualProductionError(`${scene.sceneId}/${candidate.id} 引用了不存在的 render`);
      if (sources.some((source) => source!.cameraId !== candidate.cameraId
        || source!.lightingStateId !== candidate.lightingStateId || source!.dressingVariantId !== candidate.dressingVariantId)) {
        throw new VisualProductionError(`${scene.sceneId}/${candidate.id} 混用了其他机位、灯光或陈设的约束图`);
      }
      if (!sources.some((source) => source && ["depth", "normal", "lineart"].includes(source.pass))) {
        throw new VisualProductionError(`${scene.sceneId}/${candidate.id} 缺少 depth/normal/lineart 空间约束`);
      }
    }
    if (scene.phase === "passes-ready" && scene.renders.length === 0) throw new VisualProductionError(`${scene.sceneId} passes-ready 阶段必须有 render pass`);
    if (scene.phase === "keyframe-review" && scene.candidates.length === 0) throw new VisualProductionError(`${scene.sceneId} keyframe-review 阶段必须有候选图`);
    if (scene.phase === "approved" && !scene.candidates.some((candidate) => candidate.status === "approved")) {
      throw new VisualProductionError(`${scene.sceneId} approved 阶段必须有批准图片`);
    }
  }
}
