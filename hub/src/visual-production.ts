// Strict, story-bound visual production ledger for Blender previs and generated keyframes.
//
// Story structure remains authoritative for scene identity and reuse. This companion records only
// production facts: Blender geometry revisions, camera rigs, render passes and reviewed images.
// Large binaries never live in JSON; every produced file is an immutable AssetRef.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import { parseAssetRef, type AssetRef } from "./production-domain.ts";
import {
  TIMES_OF_DAY,
  type ApprovedCandidateRecord,
  type TimeOfDay,
} from "./production-shot-request.ts";
import { WsError } from "./workspace.ts";

export const VISUAL_PRODUCTION_RELATIVE_PATH = "visual/production.v1.json";
export const VISUAL_MAPPINGS_RELATIVE_PATH = "visual/mappings.v1.json";
export const VISUAL_PROP_STATES_RELATIVE_PATH = "visual/prop-states.v1.json";
export const MAX_VISUAL_PRODUCTION_BYTES = 4 * 1024 * 1024;
export const MAX_VISUAL_COMPANION_BYTES = 1024 * 1024;

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
  /**
   * 该候选图可作首帧的镜头（§6.2）。候选图按机位 × 灯光 × 陈设登记，逐镜首帧则按 shotId 取用；
   * 输入侧可缺省（旧清单），解析后恒为数组，空数组表示尚未排到具体镜头。
   */
  shotIds: string[];
  /**
   * 该图是否含真人人脸（§4.7 provider-likeness-policy）。输入侧可缺省，缺省解析为 true——
   * 与 gate 的 `undeclared` 同一 fail-closed 语义：未声明不等于不含。Blender 约束图生成的关键帧
   * 显式写 false。
   */
  containsRealFace: boolean;
  notes: string;
};

/**
 * 定妆参考 / 道具状态参考（§6.3）：ShotRequest `references[].subjectId` 引用 `id`。
 * `story/assets.v1.json` 不改——这里只登记不可变 AssetRef 与人工批准事实，不复制剧情设定。
 */
export type VisualSubjectReferenceSubject =
  | { kind: "character"; characterId: string; appearanceStateId: string }
  | { kind: "prop"; objectId: string; stateId: string };

export type VisualSubjectReference = {
  id: string;
  subject: VisualSubjectReferenceSubject;
  asset: AssetRef;
  containsRealFace: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
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
  /** 输入侧可缺省（旧清单），解析后恒为数组（§6.3）。 */
  subjectReferences: VisualSubjectReference[];
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
/** 与 production-shot-request 的 shotId 判据同形（`EP001-S1-1`）。 */
const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown, label: string): Obj => {
  if (!isObj(value)) throw new VisualProductionError(`${label} 必须是 JSON 对象`);
  return value;
};
/** `optional` 是纯新增字段：缺省时解析结果与新增前逐字段相同（旧清单不因 schema 增长失效）。 */
const exactKeys = (value: Obj, expected: string[], label: string, optional: string[] = []): void => {
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extras = Object.keys(value).filter((key) => !expected.includes(key) && !optional.includes(key));
  if (missing.length || extras.length) {
    throw new VisualProductionError(
      `${label} 字段必须精确为 ${[...expected].sort().join(", ")}`
      + (optional.length ? `（可选：${[...optional].sort().join(", ")}）` : "")
      + `；缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}`,
    );
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
    "workflowSha256", "modelSha256", "promptSha256", "seed", "asset", "status", "reviewedBy", "reviewedAt", "notes"],
  label, ["shotIds", "containsRealFace"]);
  if (row.containsRealFace !== undefined && typeof row.containsRealFace !== "boolean") {
    throw new VisualProductionError(`${label}.containsRealFace 必须是 boolean`);
  }
  const containsRealFace = row.containsRealFace === undefined ? true : row.containsRealFace;
  let shotIds: string[] = [];
  if (row.shotIds !== undefined) {
    if (!Array.isArray(row.shotIds) || row.shotIds.length > 256) {
      throw new VisualProductionError(`${label}.shotIds 必须是最多 256 项数组`);
    }
    shotIds = row.shotIds.map((entry, index) => {
      const shotId = text(entry, `${label}.shotIds[${index}]`, 128);
      if (!SHOT_ID.test(shotId)) throw new VisualProductionError(`${label}.shotIds[${index}] 无效`);
      return shotId;
    });
    unique(shotIds, (entry) => entry, `${label}.shotIds`);
  }
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
    status, reviewedBy, reviewedAt, shotIds, containsRealFace,
    notes: text(row.notes, `${label}.notes`, 1_000) };
}

function parseSubjectReference(value: unknown, index: number): VisualSubjectReference {
  const label = `subjectReferences[${index}]`;
  const row = object(value, label);
  exactKeys(row, ["id", "subject", "asset", "containsRealFace", "approvedBy", "approvedAt"], label);
  const subjectRow = object(row.subject, `${label}.subject`);
  let subject: VisualSubjectReferenceSubject;
  if (subjectRow.kind === "character") {
    exactKeys(subjectRow, ["kind", "characterId", "appearanceStateId"], `${label}.subject`);
    subject = { kind: "character", characterId: id(subjectRow.characterId, `${label}.subject.characterId`),
      appearanceStateId: id(subjectRow.appearanceStateId, `${label}.subject.appearanceStateId`) };
  } else if (subjectRow.kind === "prop") {
    exactKeys(subjectRow, ["kind", "objectId", "stateId"], `${label}.subject`);
    subject = { kind: "prop", objectId: id(subjectRow.objectId, `${label}.subject.objectId`),
      stateId: id(subjectRow.stateId, `${label}.subject.stateId`) };
  } else {
    throw new VisualProductionError(`${label}.subject.kind 必须是 character 或 prop`);
  }
  const asset = parseAsset(row.asset, `${label}.asset`);
  if (!asset.mediaType.startsWith("image/")) throw new VisualProductionError(`${label}.asset 必须是图片 AssetRef`);
  if (typeof row.containsRealFace !== "boolean") throw new VisualProductionError(`${label}.containsRealFace 必须是 boolean`);
  // 批准是一次事件：批准人与批准时间同生同灭，只有一半即无法追责。
  let approvedBy: string | null = null; let approvedAt: string | null = null;
  if (row.approvedBy !== null || row.approvedAt !== null) {
    approvedBy = text(row.approvedBy, `${label}.approvedBy`, 128);
    if (!ACTOR_ID.test(approvedBy)) throw new VisualProductionError(`${label}.approvedBy 无效`);
    approvedAt = iso(row.approvedAt, `${label}.approvedAt`);
  }
  return { id: id(row.id, `${label}.id`), subject, asset,
    containsRealFace: row.containsRealFace, approvedBy, approvedAt };
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
  exactKeys(root, ["version", "kind", "project", "storyDesignSha256", "revision", "defaults", "scenes"],
    "visual production", ["subjectReferences"]);
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
  let subjectReferences: VisualSubjectReference[] = [];
  if (root.subjectReferences !== undefined) {
    if (!Array.isArray(root.subjectReferences) || root.subjectReferences.length > 1_024) {
      throw new VisualProductionError("visual production.subjectReferences 必须是最多 1024 项数组");
    }
    subjectReferences = root.subjectReferences.map(parseSubjectReference);
    unique(subjectReferences, (entry) => entry.id, "visual production.subjectReferences.id");
  }
  return { version: 1, kind: "writing-loop/visual-production", project, subjectReferences,
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

/** 一个 shotId 的首帧只能落在一张候选图上；跨场景也不行——镜头只属于一个场景，重复即配置错误。 */
function assertShotIdsExclusive(manifest: VisualProductionManifest): void {
  const owner = new Map<string, string>();
  for (const scene of manifest.scenes) {
    for (const candidate of scene.candidates) {
      for (const shotId of candidate.shotIds) {
        const previous = owner.get(shotId);
        if (previous !== undefined) {
          throw new VisualProductionError(`shotId ${shotId} 被多张候选图占用（${previous} 与 ${scene.sceneId}/${candidate.id}）`);
        }
        owner.set(shotId, `${scene.sceneId}/${candidate.id}`);
      }
    }
  }
}

export function validateVisualProduction(manifest: VisualProductionManifest, binding: VisualProductionBinding): void {
  assertShotIdsExclusive(manifest);
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

// —— visual/mappings.v1.json（§6.1、§6.3） ——
// 灯光与陈设的机读对照表。编译器不解析散文：它只读这里的 `(sceneId, timeOfDay) → LIGHT_*` 与
// `(sceneId, arcId) → DRESS_*` 两张表。
export type VisualLightingMapping = { sceneId: string; timeOfDay: TimeOfDay; lightingStateId: string };
export type VisualDressingMapping = { sceneId: string; arcId: string; dressingVariantId: string };
export type VisualMappingsManifest = {
  version: 1;
  kind: "writing-loop/visual-mappings";
  project: string;
  lighting: VisualLightingMapping[];
  dressing: VisualDressingMapping[];
};

// —— visual/prop-states.v1.json（§6.1、§6.3） ——
// `props[].stateId` 的注册表：每个道具的已登记状态集合，以及 `(episode, sceneId) → stateId` 的排期。
export type VisualPropState = { stateId: string; label: string; notes: string };
export type VisualPropTimelineEntry = { episode: number; sceneId: string; stateId: string };
export type VisualPropObject = {
  objectId: string;
  states: VisualPropState[];
  timeline: VisualPropTimelineEntry[];
};
export type VisualPropStatesManifest = {
  version: 1;
  kind: "writing-loop/visual-prop-states";
  project: string;
  objects: VisualPropObject[];
};

const projectKey = (value: unknown, label: string): string => {
  const parsed = text(value, label, 32);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(parsed)) throw new VisualProductionError(`${label} 无效`);
  return parsed;
};

function parseLightingMapping(value: unknown, index: number): VisualLightingMapping {
  const label = `lighting[${index}]`; const row = object(value, label);
  exactKeys(row, ["sceneId", "timeOfDay", "lightingStateId"], label);
  return { sceneId: id(row.sceneId, `${label}.sceneId`),
    timeOfDay: enumValue(row.timeOfDay, TIMES_OF_DAY, `${label}.timeOfDay`),
    lightingStateId: id(row.lightingStateId, `${label}.lightingStateId`) };
}

function parseDressingMapping(value: unknown, index: number): VisualDressingMapping {
  const label = `dressing[${index}]`; const row = object(value, label);
  exactKeys(row, ["sceneId", "arcId", "dressingVariantId"], label);
  return { sceneId: id(row.sceneId, `${label}.sceneId`), arcId: id(row.arcId, `${label}.arcId`),
    dressingVariantId: id(row.dressingVariantId, `${label}.dressingVariantId`) };
}

export function parseVisualMappingsManifest(value: unknown): VisualMappingsManifest {
  const root = object(value, "visual mappings");
  exactKeys(root, ["version", "kind", "project", "lighting", "dressing"], "visual mappings");
  if (root.version !== 1 || root.kind !== "writing-loop/visual-mappings") {
    throw new VisualProductionError("visual mappings identity 无效");
  }
  if (!Array.isArray(root.lighting) || root.lighting.length > 2_048) {
    throw new VisualProductionError("visual mappings.lighting 必须是最多 2048 项数组");
  }
  if (!Array.isArray(root.dressing) || root.dressing.length > 2_048) {
    throw new VisualProductionError("visual mappings.dressing 必须是最多 2048 项数组");
  }
  const lighting = root.lighting.map(parseLightingMapping);
  const dressing = root.dressing.map(parseDressingMapping);
  // 同一 (场景, 时段) 或 (场景, arc) 只能落一个状态：两条冲突的映射等于没有映射。
  unique(lighting, (entry) => `${entry.sceneId} ${entry.timeOfDay}`, "visual mappings.lighting 的 (sceneId, timeOfDay)");
  unique(dressing, (entry) => `${entry.sceneId} ${entry.arcId}`, "visual mappings.dressing 的 (sceneId, arcId)");
  return { version: 1, kind: "writing-loop/visual-mappings",
    project: projectKey(root.project, "visual mappings.project"), lighting, dressing };
}

function parsePropState(value: unknown, label: string): VisualPropState {
  const row = object(value, label); exactKeys(row, ["stateId", "label", "notes"], label);
  return { stateId: id(row.stateId, `${label}.stateId`), label: text(row.label, `${label}.label`, 160),
    notes: text(row.notes, `${label}.notes`, 1_000) };
}

function parsePropTimelineEntry(value: unknown, label: string): VisualPropTimelineEntry {
  const row = object(value, label); exactKeys(row, ["episode", "sceneId", "stateId"], label);
  return { episode: integer(row.episode, `${label}.episode`, 1, 10_000),
    sceneId: id(row.sceneId, `${label}.sceneId`), stateId: id(row.stateId, `${label}.stateId`) };
}

function parsePropObject(value: unknown, index: number): VisualPropObject {
  const label = `objects[${index}]`; const row = object(value, label);
  exactKeys(row, ["objectId", "states", "timeline"], label);
  if (!Array.isArray(row.states) || row.states.length < 1 || row.states.length > 64) {
    throw new VisualProductionError(`${label}.states 必须是 1–64 项数组`);
  }
  if (!Array.isArray(row.timeline) || row.timeline.length > 4_096) {
    throw new VisualProductionError(`${label}.timeline 必须是最多 4096 项数组`);
  }
  const states = row.states.map((entry, stateIndex) => parsePropState(entry, `${label}.states[${stateIndex}]`));
  unique(states, (entry) => entry.stateId, `${label}.states.stateId`);
  const timeline = row.timeline.map((entry, entryIndex) => parsePropTimelineEntry(entry, `${label}.timeline[${entryIndex}]`));
  unique(timeline, (entry) => `${entry.episode} ${entry.sceneId}`, `${label}.timeline 的 (episode, sceneId)`);
  const registered = new Set(states.map((entry) => entry.stateId));
  for (const entry of timeline) {
    if (!registered.has(entry.stateId)) {
      throw new VisualProductionError(`${label}.timeline 引用了未登记的 stateId ${entry.stateId}`);
    }
  }
  return { objectId: id(row.objectId, `${label}.objectId`), states, timeline };
}

export function parseVisualPropStatesManifest(value: unknown): VisualPropStatesManifest {
  const root = object(value, "visual prop states");
  exactKeys(root, ["version", "kind", "project", "objects"], "visual prop states");
  if (root.version !== 1 || root.kind !== "writing-loop/visual-prop-states") {
    throw new VisualProductionError("visual prop states identity 无效");
  }
  if (!Array.isArray(root.objects) || root.objects.length > 1_024) {
    throw new VisualProductionError("visual prop states.objects 必须是最多 1024 项数组");
  }
  const objects = root.objects.map(parsePropObject);
  unique(objects, (entry) => entry.objectId, "visual prop states.objects.objectId");
  return { version: 1, kind: "writing-loop/visual-prop-states",
    project: projectKey(root.project, "visual prop states.project"), objects };
}

function readCompanion(repo: string, relativePath: string): unknown | null {
  const path = join(repo, relativePath);
  if (!existsSync(path)) return null;
  const raw = readRegularTextExact(path, MAX_VISUAL_COMPANION_BYTES);
  if (raw === null) {
    throw new VisualProductionError(`${relativePath} 必须是未变化、单链接、<=${MAX_VISUAL_COMPANION_BYTES} bytes 的 UTF-8 普通文件`);
  }
  try { return JSON.parse(raw); }
  catch { throw new VisualProductionError(`${relativePath} 不是有效 JSON`); }
}

/** 文件不存在时视为空表（§6.3）；存在即严格解析——坏文件是硬错，不降级为空表。 */
export function readVisualMappings(repo: string): VisualMappingsManifest | null {
  const raw = readCompanion(repo, VISUAL_MAPPINGS_RELATIVE_PATH);
  return raw === null ? null : parseVisualMappingsManifest(raw);
}

export function readVisualPropStates(repo: string): VisualPropStatesManifest | null {
  const raw = readCompanion(repo, VISUAL_PROP_STATES_RELATIVE_PATH);
  return raw === null ? null : parseVisualPropStatesManifest(raw);
}

/** `compileShotRequest` 的 policy 输入中由视觉侧三份文件装配的部分（§6.2、§6.3）。 */
export type VisualShotCandidate = {
  candidateId: string;
  sceneId: string;
  asset: AssetRef;
  status: VisualGenerationCandidate["status"];
  containsRealFace: boolean;
};

export type VisualCompileInputs = {
  visualProductionSha256: string | null;
  approvedCandidates: Record<string, ApprovedCandidateRecord>;
  /** shotId → 排到该镜的候选图（§6.2）；同一 shotId 至多一张，跨场景亦然。 */
  candidatesByShotId: Record<string, VisualShotCandidate>;
  propStates: Record<string, string[]>;
  mappings: VisualMappingsManifest | null;
};

// —— 候选图批准轨道（§4.7 审批点 1、§6.2） ——
export type VisualCandidateDecision = "approved" | "rejected";
export type VisualCandidateReview = {
  candidateId: string;
  decision: VisualCandidateDecision;
  reviewedBy: string;
  reviewedAt: string;
};
export type VisualCandidateReviewResult = {
  manifest: VisualProductionManifest;
  sceneId: string;
  candidate: VisualGenerationCandidate;
};

/**
 * 纯函数：把一张候选图标成 approved / rejected。只允许 `keyframe-review` 阶段的场景——
 * `passes-ready` 尚无候选图可评，`approved` 已经定稿，两者都不是可以改判的状态（§6.2）。
 * 已有裁决的候选图不接受第二次改判：审批是事实登记，不是可覆盖的字段。
 */
export function reviewVisualCandidate(
  manifest: VisualProductionManifest,
  review: VisualCandidateReview,
): VisualCandidateReviewResult {
  if (!ACTOR_ID.test(review.reviewedBy)) throw new VisualProductionError("reviewedBy 必须是安全 actor ID");
  const reviewedAt = iso(review.reviewedAt, "reviewedAt");
  const hits = manifest.scenes.flatMap((scene) =>
    scene.candidates.filter((candidate) => candidate.id === review.candidateId).map((candidate) => ({ scene, candidate })));
  if (hits.length === 0) throw new VisualProductionError(`没有候选图 ${review.candidateId}`);
  if (hits.length > 1) throw new VisualProductionError(`候选图 ${review.candidateId} 在多个场景中重复登记`);
  const { scene, candidate } = hits[0];
  if (scene.phase !== "keyframe-review") {
    throw new VisualProductionError(`${scene.sceneId} 处于 ${scene.phase} 阶段；只有 keyframe-review 阶段可以裁决候选图`);
  }
  if (candidate.status !== "candidate") {
    throw new VisualProductionError(`候选图 ${candidate.id} 已由 ${candidate.reviewedBy} 裁决为 ${candidate.status}；不接受改判`);
  }
  const reviewed: VisualGenerationCandidate = {
    ...candidate, status: review.decision, reviewedBy: review.reviewedBy, reviewedAt,
  };
  const next = parseVisualProductionManifest({
    ...manifest,
    scenes: manifest.scenes.map((entry) => entry.sceneId !== scene.sceneId ? entry : {
      ...entry,
      candidates: entry.candidates.map((row) => row.id === candidate.id ? reviewed : row),
    }),
  });
  return { manifest: next, sceneId: scene.sceneId, candidate: reviewed };
}

/** 原子替换 `visual/production.v1.json`：写同目录临时文件 → fsync → rename → fsync 目录。 */
export function writeVisualProduction(repo: string, manifest: VisualProductionManifest): string {
  const path = join(repo, VISUAL_PRODUCTION_RELATIVE_PATH);
  const directory = dirname(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new VisualProductionError(`${VISUAL_PRODUCTION_RELATIVE_PATH} 必须是单链接普通文件`);
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_VISUAL_PRODUCTION_BYTES) {
    throw new VisualProductionError(`${VISUAL_PRODUCTION_RELATIVE_PATH} 超过 ${MAX_VISUAL_PRODUCTION_BYTES} bytes 上限`);
  }
  const temporary = join(directory, `.production.v1.json.${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try { renameSync(temporary, path); }
  catch (error) {
    try { unlinkSync(temporary); } catch { /* 临时文件清理失败不掩盖原始错误 */ }
    throw new VisualProductionError(`无法原子替换 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  let directoryFd: number | undefined;
  try { directoryFd = openSync(directory, constants.O_RDONLY); fsyncSync(directoryFd); }
  catch { /* 平台拒绝目录 fsync 时不阻断已完成的 rename */ }
  finally { if (directoryFd !== undefined) closeSync(directoryFd); }
  return path;
}

export function readVisualCompileInputs(repo: string): VisualCompileInputs {
  const visual = readVisualProduction(repo);
  // 装配路径不经过 validateVisualProduction（它要 story binding），因此这里独立复核同一条独占性。
  if (visual !== null) assertShotIdsExclusive(visual.manifest);
  const approvedCandidates = Object.create(null) as Record<string, ApprovedCandidateRecord>;
  const candidatesByShotId = Object.create(null) as Record<string, VisualShotCandidate>;
  for (const scene of visual?.manifest.scenes ?? []) {
    for (const candidate of scene.candidates) {
      if (Object.prototype.hasOwnProperty.call(approvedCandidates, candidate.id)) {
        throw new VisualProductionError(`候选图 ${candidate.id} 在多个场景中重复登记`);
      }
      approvedCandidates[candidate.id] = {
        sha256: candidate.asset.sha256,
        status: candidate.status,
        reviewedBy: candidate.reviewedBy,
        reviewedAt: candidate.reviewedAt,
      };
      for (const shotId of candidate.shotIds) {
        candidatesByShotId[shotId] = {
          candidateId: candidate.id,
          sceneId: scene.sceneId,
          asset: candidate.asset,
          status: candidate.status,
          containsRealFace: candidate.containsRealFace,
        };
      }
    }
  }
  const propStates = Object.create(null) as Record<string, string[]>;
  for (const entry of readVisualPropStates(repo)?.objects ?? []) {
    propStates[entry.objectId] = entry.states.map((state) => state.stateId);
  }
  return {
    visualProductionSha256: visual?.digest ?? null,
    approvedCandidates,
    candidatesByShotId,
    propStates,
    mappings: readVisualMappings(repo),
  };
}
