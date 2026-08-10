// Provider-neutral, immutable handoff for an agent-driven video creation studio.
//
// Citronetic/video-creation-studio currently exposes persisted project artifacts and a read-only
// Backlot observer, not a durable remote execution API.  This manifest is therefore an explicit
// handoff boundary: it never claims that exporting JSON started or completed a Studio production.
import { createHash } from "node:crypto";
import {
  compareProductionAscii,
  parseAssetRef,
  parseProductionState,
  type AssetRef,
  type ProductionApproval,
  type ProductionState,
  type ShotRevisionRef,
} from "./production-domain.ts";

export const VIDEO_STUDIO_HANDOFF_CONTRACT = "citronetic-video-creation-studio-codex-handoff-v1" as const;
export const VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM = "sha256:writing-loop-canonical-json-v1" as const;
export const VIDEO_STUDIO_PIPELINES = ["cinematic", "character-animation", "animation", "hybrid"] as const;
export type VideoStudioPipeline = typeof VIDEO_STUDIO_PIPELINES[number];

export type VideoStudioDelivery = {
  version: 1;
  aspectRatio: "9:16" | "16:9" | "1:1";
  width: number;
  height: number;
  fps: 24 | 25 | 30;
  container: "video/mp4";
  language: string;
};

export type VideoStudioHandoffTake = {
  version: 1;
  taskId: string;
  shot: ShotRevisionRef;
  assets: AssetRef[];
  approval: ProductionApproval;
};

export type VideoStudioHandoff = {
  version: 1;
  contract: typeof VIDEO_STUDIO_HANDOFF_CONTRACT;
  handoffId: string;
  studioProjectId: string;
  workspaceId: string;
  project: string;
  productionRevision: number;
  pipeline: VideoStudioPipeline;
  createdAt: string;
  delivery: VideoStudioDelivery;
  takes: VideoStudioHandoffTake[];
  /** This upstream is agent-orchestrated; import is not proof of execution or approval. */
  requiresAgentOrchestration: true;
};

export type VideoStudioHandoffCreate = {
  version: 1;
  handoffId: string;
  studioProjectId: string;
  pipeline: VideoStudioPipeline;
  createdAt: string;
  delivery: VideoStudioDelivery;
  taskIds: string[];
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STUDIO_PROJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGE = /^[A-Za-z][A-Za-z0-9-]{0,34}$/;
const PIPELINES = new Set<string>(VIDEO_STUDIO_PIPELINES);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new Error(`${subject} ${detail}`);
}

function exact(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const extras = Object.keys(value).filter((field) => !fields.includes(field));
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (extras.length) fail(subject, `含未知字段 ${extras.join(",")}`);
  if (missing.length) fail(subject, `缺少字段 ${missing.join(",")}`);
}

function id(value: unknown, subject: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(subject, "标识符无效");
  return value;
}

function iso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "时间无效");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(subject, "必须是规范 UTC ISO 时间");
  return value;
}

export function parseVideoStudioDelivery(value: unknown, subject = "VideoStudioDelivery"): VideoStudioDelivery {
  if (!object(value)) fail(subject, "必须是对象");
  exact(value, ["version", "aspectRatio", "width", "height", "fps", "container", "language"], subject);
  if (value.version !== 1) fail(subject, "version 必须是 1");
  if (!["9:16", "16:9", "1:1"].includes(String(value.aspectRatio))) fail(subject, "aspectRatio 无效");
  if (!Number.isSafeInteger(value.width) || (value.width as number) < 256 || (value.width as number) > 7_680
    || !Number.isSafeInteger(value.height) || (value.height as number) < 256 || (value.height as number) > 7_680) {
    fail(subject, "width/height 必须在 256–7680");
  }
  const width = value.width as number;
  const height = value.height as number;
  if ((value.aspectRatio === "9:16" && width * 16 !== height * 9)
    || (value.aspectRatio === "16:9" && width * 9 !== height * 16)
    || (value.aspectRatio === "1:1" && width !== height)) {
    fail(subject, "width/height 与 aspectRatio 不一致");
  }
  if (![24, 25, 30].includes(value.fps as number)) fail(subject, "fps 必须是 24、25 或 30");
  if (value.container !== "video/mp4") fail(subject, "v1 只支持 video/mp4");
  if (typeof value.language !== "string" || !LANGUAGE.test(value.language)) fail(subject, "language 必须是稳定 BCP-47 风格标签");
  return {
    version: 1,
    aspectRatio: value.aspectRatio as VideoStudioDelivery["aspectRatio"],
    width,
    height,
    fps: value.fps as VideoStudioDelivery["fps"],
    container: "video/mp4",
    language: value.language,
  };
}

export function parseVideoStudioHandoffCreate(value: unknown): VideoStudioHandoffCreate {
  if (!object(value)) fail("VideoStudioHandoffCreate", "必须是对象");
  exact(value, ["version", "handoffId", "studioProjectId", "pipeline", "createdAt", "delivery", "taskIds"], "VideoStudioHandoffCreate");
  if (value.version !== 1) fail("VideoStudioHandoffCreate", "version 必须是 1");
  if (typeof value.studioProjectId !== "string" || value.studioProjectId.length > 80
    || !STUDIO_PROJECT.test(value.studioProjectId)) {
    fail("VideoStudioHandoffCreate.studioProjectId", "必须是最多 80 位 kebab-case");
  }
  if (typeof value.pipeline !== "string" || !PIPELINES.has(value.pipeline)) {
    fail("VideoStudioHandoffCreate.pipeline", "不是允许的 Studio pipeline");
  }
  if (!Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > 2_048) {
    fail("VideoStudioHandoffCreate.taskIds", "必须是 1–2048 项数组");
  }
  const taskIds = value.taskIds.map((item, index) => id(item, `VideoStudioHandoffCreate.taskIds[${index}]`));
  if (new Set(taskIds).size !== taskIds.length) fail("VideoStudioHandoffCreate.taskIds", "不得重复");
  return {
    version: 1,
    handoffId: id(value.handoffId, "VideoStudioHandoffCreate.handoffId"),
    studioProjectId: value.studioProjectId,
    pipeline: value.pipeline as VideoStudioPipeline,
    createdAt: iso(value.createdAt, "VideoStudioHandoffCreate.createdAt"),
    delivery: parseVideoStudioDelivery(value.delivery),
    taskIds,
  };
}

/** Build a deterministic, provenance-bound bundle from already approved shot takes only. */
export function buildVideoStudioHandoff(stateValue: ProductionState, createValue: unknown): VideoStudioHandoff {
  const state = parseProductionState(stateValue);
  const create = parseVideoStudioHandoffCreate(createValue);
  if (state.updatedAt !== null && create.createdAt < state.updatedAt) {
    fail("VideoStudioHandoff.createdAt", "不得早于所绑定 productionRevision 的 updatedAt");
  }
  const tasks = create.taskIds.map((taskId) => {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) fail("VideoStudioHandoff", `task ${taskId} 不存在`);
    if (task.subject.kind !== "shot") fail("VideoStudioHandoff", `task ${taskId} 不是 shot take`);
    if (task.status !== "approved" || task.approval?.decision !== "approved") {
      fail("VideoStudioHandoff", `task ${taskId} 尚未 approved`);
    }
    if (!task.assets.length) fail("VideoStudioHandoff", `task ${taskId} 没有已 ingest 资产`);
    return task;
  });
  const firstEpisode = tasks[0]!.subject.kind === "shot" ? tasks[0]!.subject.shot.episode : null;
  for (const task of tasks) {
    const episode = task.subject.kind === "shot" ? task.subject.shot.episode : null;
    if (!episode || !firstEpisode || episode.episodeId !== firstEpisode.episodeId
      || episode.revision !== firstEpisode.revision || episode.source.sha256 !== firstEpisode.source.sha256) {
      fail("VideoStudioHandoff", "所有 take 必须绑定同一 episode revision");
    }
  }
  const takes: VideoStudioHandoffTake[] = tasks.map((task) => ({
    version: 1 as const,
    taskId: task.id,
    shot: task.subject.kind === "shot" ? task.subject.shot : fail("VideoStudioHandoff", "expected shot"),
    assets: task.assets.map((item) => parseAssetRef(item)),
    approval: task.approval!,
  })).sort((left, right) =>
    compareProductionAscii(left.shot.shotId, right.shot.shotId)
      || compareProductionAscii(left.taskId, right.taskId));
  const shotIds = takes.map((take) => take.shot.shotId);
  if (new Set(shotIds).size !== shotIds.length) fail("VideoStudioHandoff", "同一 handoff 不得含重复 shotId");
  return {
    version: 1,
    contract: VIDEO_STUDIO_HANDOFF_CONTRACT,
    handoffId: create.handoffId,
    studioProjectId: create.studioProjectId,
    workspaceId: state.workspaceId,
    project: state.project,
    productionRevision: state.revision,
    pipeline: create.pipeline,
    createdAt: create.createdAt,
    delivery: create.delivery,
    takes,
    requiresAgentOrchestration: true,
  };
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) fail("VideoStudioHandoff digest", "对象嵌套超过 64 层");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("VideoStudioHandoff digest", "只接受安全整数");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (!object(value)) fail("VideoStudioHandoff digest", "只接受 JSON 值");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("VideoStudioHandoff digest", "只接受 plain JSON object");
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
}

/**
 * Cross-repository canonical bytes: UTF-8 JSON, array order preserved, object keys sorted by
 * JavaScript/Unicode code-unit order, safe integers only, no whitespace or toJSON hooks.
 */
export function videoStudioHandoffCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

export function videoStudioHandoffDigest(value: unknown): string {
  return createHash("sha256").update(videoStudioHandoffCanonicalJson(value), "utf8").digest("hex");
}
