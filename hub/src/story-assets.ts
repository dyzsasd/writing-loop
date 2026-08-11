// Strict story asset graph and deterministic context-pack resolver.
//
// This graph is the sole authority for reusable story facts. There is deliberately no parallel
// Markdown projection: Studio and harness context packs render/select this data directly.
// Raw source text is never copied into this file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import { WsError } from "./workspace.ts";

export const STORY_ASSETS_RELATIVE_PATH = "story/assets.v1.json";
export const MAX_STORY_ASSETS_BYTES = 4 * 1024 * 1024;
export const DEFAULT_STORY_CONTEXT_BYTES = 64 * 1024;
export const MAX_STORY_CONTEXT_BYTES = 256 * 1024;

export type StoryAssetType = "character" | "world" | "location" | "organization" | "object"
  | "scene" | "foreshadow" | "continuity" | "episode";
export type StoryAssetStatus = "draft" | "active" | "resolved" | "retired";
export type StoryAssetAgent = "showrunner" | "story-designer" | "episode-writer" | "reviewer"
  | "script-doctor" | "evaluator" | "market-watch" | "sweep" | "reflect";
export type StoryAssetFact = {
  id: string;
  key: string;
  value: string;
  state: "current" | "planned" | "disputed" | "resolved";
  basis: "source" | "inferred" | "original";
  sourceRefs: string[];
};
export type StoryAssetRelation = { kind: string; targetId: string };
export type StoryAsset = {
  id: string;
  type: StoryAssetType;
  label: string;
  status: StoryAssetStatus;
  importance: "core" | "supporting" | "detail";
  episodes: { first: number; last: number } | null;
  summary: string;
  sourceRefs: string[];
  facts: StoryAssetFact[];
  relations: StoryAssetRelation[];
  context: { agents: StoryAssetAgent[]; priority: "required" | "supporting" | "optional" };
};
export type StoryTimelineEvent = {
  id: string;
  label: string;
  chronologyIndex: number;
  storyTimeLabel: string;
  reveal: { episode: number; order: number; mode: "linear" | "flashback" | "memory" | "flashforward" | "offscreen" };
  summary: string;
  assetIds: string[];
  sourceRefs: string[];
};
export type StoryAssetCatalog = {
  version: 1;
  kind: "writing-loop/story-assets";
  project: string;
  sourcePlanId: string | null;
  storyDesignSha256: string;
  revision: number;
  assets: StoryAsset[];
  timeline: StoryTimelineEvent[];
};

export type StoryAssetDesignBinding = {
  project: string;
  repo: string;
  sourcePlanId: string | null;
  storyDesignSha256: string;
  totalEpisodes: number;
  characters: Array<{ id: string; name: string; firstEpisode: number; lastEpisode: number }>;
  scenes: Array<{ id: string; name: string }>;
  episodes: Array<{ number: number; characterIds: string[]; sceneIds: string[] }>;
};

export type StoryAssetCatalogRead = {
  path: string;
  digest: string;
  manifest: StoryAssetCatalog;
};

export type StoryContextRequest = {
  project: string;
  ticketId: string;
  agent: StoryAssetAgent;
  episode: number | null;
  maxBytes?: number;
};

export type StoryContextAsset = Omit<StoryAsset, "context"> & {
  selectedBecause: string[];
};

export type StoryContextPack = {
  version: 1;
  kind: "writing-loop/story-context-pack";
  project: string;
  ticketId: string;
  agent: StoryAssetAgent;
  episode: number | null;
  storyDesignSha256: string;
  assetCatalogSha256: string;
  assets: StoryContextAsset[];
  timeline: Array<StoryTimelineEvent & { selectedBecause: string }>;
  omittedAssetIds: string[];
  omittedTimelineEventIds: string[];
  budget: { maxBytes: number; usedBytes: number; selectedAssets: number; omittedAssets: number;
    selectedTimelineEvents: number; omittedTimelineEvents: number };
  digest: string;
};

export class StoryAssetError extends WsError {
  constructor(message: string) { super(message); this.name = "StoryAssetError"; }
}

type Obj = Record<string, unknown>;
const ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE_REF = /^(?:src|north-star|ticket|episode|design|original):[A-Za-z0-9_./#:-]{1,220}$/;
const AGENTS: readonly StoryAssetAgent[] = ["showrunner", "story-designer", "episode-writer", "reviewer",
  "script-doctor", "evaluator", "market-watch", "sweep", "reflect"];
const TYPES: readonly StoryAssetType[] = ["character", "world", "location", "organization", "object", "scene",
  "foreshadow", "continuity", "episode"];
const STATUS: readonly StoryAssetStatus[] = ["draft", "active", "resolved", "retired"];
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Obj, expected: string[], label: string): void => {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new StoryAssetError(`${label} 字段必须精确为 ${wanted.join(", ")}`);
  }
};
const object = (value: unknown, label: string): Obj => {
  if (!isObj(value)) throw new StoryAssetError(`${label} 必须是 JSON 对象`); return value;
};
const text = (value: unknown, label: string, max = 2_000): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max) {
    throw new StoryAssetError(`${label} 必须是 1–${max} 字符的非空字符串`);
  }
  return value.trim().replace(/\r\n/g, "\n");
};
const integer = (value: unknown, label: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new StoryAssetError(`${label} 必须是 ${min}–${max} 的安全整数`);
  }
  return Number(value);
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new StoryAssetError(`${label} 无效`);
  return value as T;
};
const refs = (value: unknown, label: string, max = 128): string[] => {
  if (!Array.isArray(value) || value.length > max) throw new StoryAssetError(`${label} 必须是最多 ${max} 项的数组`);
  const out = value.map((entry, index) => {
    const ref = text(entry, `${label}[${index}]`, 256);
    if (!SOURCE_REF.test(ref) || ref.includes("..")) throw new StoryAssetError(`${label}[${index}] 不是结构化 provenance ref`);
    return ref;
  });
  if (new Set(out).size !== out.length) throw new StoryAssetError(`${label} 不能重复`);
  return out;
};

function parseFact(value: unknown, label: string): StoryAssetFact {
  const row = object(value, label); exactKeys(row, ["id", "key", "value", "state", "basis", "sourceRefs"], label);
  const id = text(row.id, `${label}.id`, 64); if (!ID.test(id)) throw new StoryAssetError(`${label}.id 无效`);
  return { id, key: text(row.key, `${label}.key`, 120), value: text(row.value, `${label}.value`, 1_200),
    state: enumValue(row.state, ["current", "planned", "disputed", "resolved"] as const, `${label}.state`),
    basis: enumValue(row.basis, ["source", "inferred", "original"] as const, `${label}.basis`),
    sourceRefs: refs(row.sourceRefs, `${label}.sourceRefs`, 32) };
}

function parseAsset(value: unknown, index: number): StoryAsset {
  const label = `assets[${index}]`; const row = object(value, label);
  exactKeys(row, ["id", "type", "label", "status", "importance", "episodes", "summary", "sourceRefs", "facts",
    "relations", "context"], label);
  const id = text(row.id, `${label}.id`, 64); if (!ID.test(id)) throw new StoryAssetError(`${label}.id 无效`);
  let episodes: StoryAsset["episodes"] = null;
  if (row.episodes !== null) {
    const range = object(row.episodes, `${label}.episodes`); exactKeys(range, ["first", "last"], `${label}.episodes`);
    const first = integer(range.first, `${label}.episodes.first`, 1, 300);
    episodes = { first, last: integer(range.last, `${label}.episodes.last`, first, 300) };
  }
  if (!Array.isArray(row.facts) || row.facts.length > 256) throw new StoryAssetError(`${label}.facts 必须是最多 256 项的数组`);
  const facts = row.facts.map((entry, factIndex) => parseFact(entry, `${label}.facts[${factIndex}]`));
  if (!Array.isArray(row.relations) || row.relations.length > 128) throw new StoryAssetError(`${label}.relations 必须是最多 128 项的数组`);
  const relations = row.relations.map((entry, relationIndex): StoryAssetRelation => {
    const relation = object(entry, `${label}.relations[${relationIndex}]`);
    exactKeys(relation, ["kind", "targetId"], `${label}.relations[${relationIndex}]`);
    const targetId = text(relation.targetId, `${label}.relations[${relationIndex}].targetId`, 64);
    if (!ID.test(targetId)) throw new StoryAssetError(`${label}.relations[${relationIndex}].targetId 无效`);
    return { kind: text(relation.kind, `${label}.relations[${relationIndex}].kind`, 80), targetId };
  });
  const context = object(row.context, `${label}.context`); exactKeys(context, ["agents", "priority"], `${label}.context`);
  if (!Array.isArray(context.agents) || context.agents.length < 1 || context.agents.length > AGENTS.length) {
    throw new StoryAssetError(`${label}.context.agents 必须是非空 agent 数组`);
  }
  const agents = context.agents.map((entry, agentIndex) => enumValue(entry, AGENTS, `${label}.context.agents[${agentIndex}]`));
  if (new Set(agents).size !== agents.length) throw new StoryAssetError(`${label}.context.agents 不能重复`);
  return { id, type: enumValue(row.type, TYPES, `${label}.type`), label: text(row.label, `${label}.label`, 160),
    status: enumValue(row.status, STATUS, `${label}.status`),
    importance: enumValue(row.importance, ["core", "supporting", "detail"] as const, `${label}.importance`),
    episodes, summary: text(row.summary, `${label}.summary`, 1_500), sourceRefs: refs(row.sourceRefs, `${label}.sourceRefs`),
    facts, relations, context: { agents, priority: enumValue(context.priority,
      ["required", "supporting", "optional"] as const, `${label}.context.priority`) } };
}

function parseTimelineEvent(value: unknown, index: number): StoryTimelineEvent {
  const label = `timeline[${index}]`; const row = object(value, label);
  exactKeys(row, ["id", "label", "chronologyIndex", "storyTimeLabel", "reveal", "summary", "assetIds", "sourceRefs"], label);
  const id = text(row.id, `${label}.id`, 64); if (!ID.test(id)) throw new StoryAssetError(`${label}.id 无效`);
  const reveal = object(row.reveal, `${label}.reveal`); exactKeys(reveal, ["episode", "order", "mode"], `${label}.reveal`);
  if (!Array.isArray(row.assetIds) || row.assetIds.length < 1 || row.assetIds.length > 64) throw new StoryAssetError(`${label}.assetIds 必须是 1–64 项的数组`);
  const assetIds = row.assetIds.map((entry, assetIndex) => {
    const assetId = text(entry, `${label}.assetIds[${assetIndex}]`, 64);
    if (!ID.test(assetId)) throw new StoryAssetError(`${label}.assetIds[${assetIndex}] 无效`); return assetId;
  });
  if (new Set(assetIds).size !== assetIds.length) throw new StoryAssetError(`${label}.assetIds 不能重复`);
  return { id, label: text(row.label, `${label}.label`, 200),
    chronologyIndex: integer(row.chronologyIndex, `${label}.chronologyIndex`, 1, 100_000),
    storyTimeLabel: text(row.storyTimeLabel, `${label}.storyTimeLabel`, 120),
    reveal: { episode: integer(reveal.episode, `${label}.reveal.episode`, 1, 300),
      order: integer(reveal.order, `${label}.reveal.order`, 1, 1_000),
      mode: enumValue(reveal.mode, ["linear", "flashback", "memory", "flashforward", "offscreen"] as const, `${label}.reveal.mode`) },
    summary: text(row.summary, `${label}.summary`, 1_500), assetIds, sourceRefs: refs(row.sourceRefs, `${label}.sourceRefs`) };
}

export function parseStoryAssetCatalog(value: unknown): StoryAssetCatalog {
  const root = object(value, "story assets");
  exactKeys(root, ["version", "kind", "project", "sourcePlanId", "storyDesignSha256", "revision", "assets", "timeline"], "story assets");
  if (root.version !== 1 || root.kind !== "writing-loop/story-assets") throw new StoryAssetError("story assets identity 无效");
  const project = text(root.project, "story assets.project", 32);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(project)) throw new StoryAssetError("story assets.project 无效");
  const storyDesignSha256 = text(root.storyDesignSha256, "story assets.storyDesignSha256", 64);
  if (!SHA.test(storyDesignSha256)) throw new StoryAssetError("story assets.storyDesignSha256 无效");
  if (!Array.isArray(root.assets) || root.assets.length > 500) throw new StoryAssetError("story assets.assets 必须是最多 500 项的数组");
  if (!Array.isArray(root.timeline) || root.timeline.length > 2_000) throw new StoryAssetError("story assets.timeline 必须是最多 2000 项的数组");
  return { version: 1, kind: "writing-loop/story-assets", project,
    sourcePlanId: root.sourcePlanId === null ? null : text(root.sourcePlanId, "story assets.sourcePlanId", 80),
    storyDesignSha256, revision: integer(root.revision, "story assets.revision", 1, Number.MAX_SAFE_INTEGER),
    assets: root.assets.map(parseAsset), timeline: root.timeline.map(parseTimelineEvent) };
}

export function readStoryAssetCatalog(repo: string): StoryAssetCatalogRead | null {
  const path = join(repo, STORY_ASSETS_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  const raw = readRegularTextExact(path, MAX_STORY_ASSETS_BYTES);
  if (raw === null) throw new StoryAssetError(`${STORY_ASSETS_RELATIVE_PATH} 必须是未变化、单链接、<=${MAX_STORY_ASSETS_BYTES} bytes 的 UTF-8 普通文件`);
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new StoryAssetError(`${STORY_ASSETS_RELATIVE_PATH} 不是有效 JSON`); }
  const manifest = parseStoryAssetCatalog(parsed);
  return { path, manifest, digest: productionCanonicalJsonSha256(manifest) };
}

export function validateStoryAssetCatalog(catalog: StoryAssetCatalog, binding: StoryAssetDesignBinding): void {
  if (catalog.project !== binding.project) throw new StoryAssetError(`asset project ${catalog.project} 与 ${binding.project} 不一致`);
  if (catalog.sourcePlanId !== binding.sourcePlanId) throw new StoryAssetError("asset sourcePlanId 与原著登记不一致");
  if (catalog.storyDesignSha256 !== binding.storyDesignSha256) throw new StoryAssetError("asset graph 绑定的是旧 story/outline.v1.json");
  const byId = new Map<string, StoryAsset>();
  for (const asset of catalog.assets) {
    if (byId.has(asset.id)) throw new StoryAssetError(`重复 asset id ${asset.id}`);
    byId.set(asset.id, asset);
    if (asset.episodes && asset.episodes.last > binding.totalEpisodes) throw new StoryAssetError(`${asset.id} 超出总集数`);
    const factIds = new Set<string>(); const currentByKey = new Map<string, string>();
    for (const fact of asset.facts) {
      if (factIds.has(fact.id)) throw new StoryAssetError(`${asset.id} 重复 fact id ${fact.id}`);
      factIds.add(fact.id);
      if (fact.state === "current" || fact.state === "planned") {
        const previous = currentByKey.get(fact.key);
        if (previous !== undefined && previous !== fact.value) throw new StoryAssetError(`${asset.id} 的 ${fact.key} 存在冲突活跃事实`);
        currentByKey.set(fact.key, fact.value);
      }
    }
  }
  const timelineIds = new Set<string>(); const chronology = new Set<number>(); const reveals = new Set<string>();
  for (const event of catalog.timeline) {
    if (timelineIds.has(event.id)) throw new StoryAssetError(`重复 timeline id ${event.id}`);
    timelineIds.add(event.id);
    if (chronology.has(event.chronologyIndex)) throw new StoryAssetError(`timeline chronologyIndex ${event.chronologyIndex} 重复`);
    chronology.add(event.chronologyIndex);
    const revealKey = `${event.reveal.episode}:${event.reveal.order}`;
    if (reveals.has(revealKey)) throw new StoryAssetError(`timeline reveal ${revealKey} 重复`);
    reveals.add(revealKey);
    if (event.reveal.episode > binding.totalEpisodes) throw new StoryAssetError(`${event.id} reveal 超出总集数`);
    for (const assetId of event.assetIds) if (!byId.has(assetId)) throw new StoryAssetError(`${event.id} 引用不存在的 asset ${assetId}`);
  }
  for (const asset of catalog.assets) {
    for (const relation of asset.relations) {
      if (relation.targetId === asset.id || !byId.has(relation.targetId)) throw new StoryAssetError(`${asset.id} relation 指向无效 asset ${relation.targetId}`);
    }
  }
  const expectedCharacters = new Map(binding.characters.map((row) => [row.id, row] as const));
  const expectedScenes = new Map(binding.scenes.map((row) => [row.id, row] as const));
  const actualCharacters = catalog.assets.filter((row) => row.type === "character");
  const actualScenes = catalog.assets.filter((row) => row.type === "scene");
  if (actualCharacters.length !== expectedCharacters.size || actualScenes.length !== expectedScenes.size) {
    throw new StoryAssetError("asset graph 的人物/场景集合必须与 story design 精确一致");
  }
  for (const asset of actualCharacters) {
    const expected = expectedCharacters.get(asset.id);
    if (!expected || asset.label !== expected.name || asset.episodes?.first !== expected.firstEpisode
      || asset.episodes.last !== expected.lastEpisode) throw new StoryAssetError(`${asset.id} 与 story design 人物身份不一致`);
  }
  for (const asset of actualScenes) {
    const expected = expectedScenes.get(asset.id);
    if (!expected || asset.label !== expected.name) throw new StoryAssetError(`${asset.id} 与 story design 场景身份不一致`);
  }
}

const intersects = (asset: StoryAsset, episode: number | null): boolean => episode === null || asset.episodes === null
  || (asset.episodes.first <= episode && episode <= asset.episodes.last);
const typeRank = (type: StoryAssetType): number => TYPES.indexOf(type);
const priorityRank = (priority: StoryAsset["context"]["priority"]): number => ({ required: 0, supporting: 1, optional: 2 })[priority];

export function buildStoryContextPack(
  catalogRead: StoryAssetCatalogRead,
  binding: StoryAssetDesignBinding,
  request: StoryContextRequest,
): StoryContextPack {
  validateStoryAssetCatalog(catalogRead.manifest, binding);
  if (request.project !== binding.project) throw new StoryAssetError("context request project 不匹配");
  if (!/^[A-Z][A-Z0-9_-]{0,31}-\d{1,9}$/.test(request.ticketId)) throw new StoryAssetError("context ticketId 无效");
  if (!AGENTS.includes(request.agent)) throw new StoryAssetError("context agent 无效");
  if (request.episode !== null && (!Number.isSafeInteger(request.episode) || request.episode < 1 || request.episode > binding.totalEpisodes)) {
    throw new StoryAssetError("context episode 无效");
  }
  const maxBytes = request.maxBytes ?? DEFAULT_STORY_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4_096 || maxBytes > MAX_STORY_CONTEXT_BYTES) throw new StoryAssetError("context maxBytes 必须是 4096–262144");
  const byId = new Map(catalogRead.manifest.assets.map((asset) => [asset.id, asset] as const));
  const mandatory = new Map<string, string[]>();
  const addReason = (id: string, reason: string): void => {
    const current = mandatory.get(id) ?? []; if (!current.includes(reason)) current.push(reason); mandatory.set(id, current);
  };
  if (request.episode !== null) {
    const episode = request.episode;
    // Character/scene requirements come from the exact design companion rather than caller input.
    const designEpisode = binding.episodes.find((row) => row.number === episode);
    for (const id of designEpisode?.characterIds ?? []) addReason(id, `episode:${episode}:character`);
    for (const id of designEpisode?.sceneIds ?? []) addReason(id, `episode:${episode}:scene`);
    for (const event of catalogRead.manifest.timeline.filter((row) => row.reveal.episode === episode)) {
      for (const id of event.assetIds) addReason(id, `timeline:${event.id}`);
    }
  }
  for (const asset of catalogRead.manifest.assets) {
    if (asset.status === "retired" || !asset.context.agents.includes(request.agent) || !intersects(asset, request.episode)) continue;
    if (asset.context.priority === "required") addReason(asset.id, request.episode === null ? "agent:required-global" : "episode:required");
  }
  // One-hop relation closure gives the selected facts their named counterparts without opening a
  // free graph traversal. Only already-visible, in-scope assets may enter the pack.
  for (const id of [...mandatory.keys()]) {
    const source = byId.get(id); if (!source) throw new StoryAssetError(`required asset ${id} 不存在`);
    for (const relation of source.relations) {
      const target = byId.get(relation.targetId);
      if (target && target.status !== "retired" && target.context.agents.includes(request.agent) && intersects(target, request.episode)) {
        addReason(target.id, `relation:${id}:${relation.kind}`);
      }
    }
  }
  for (const id of mandatory.keys()) {
    const asset = byId.get(id);
    if (!asset) throw new StoryAssetError(`required asset ${id} 不存在`);
    if (asset.status === "retired" || !asset.context.agents.includes(request.agent) || !intersects(asset, request.episode)) {
      throw new StoryAssetError(`required asset ${id} 不允许进入 ${request.agent} 的当前 context`);
    }
  }
  const candidates = catalogRead.manifest.assets.filter((asset) => asset.status !== "retired"
    && asset.context.agents.includes(request.agent) && intersects(asset, request.episode))
    .sort((left, right) => Number(!mandatory.has(left.id)) - Number(!mandatory.has(right.id))
      || priorityRank(left.context.priority) - priorityRank(right.context.priority)
      || typeRank(left.type) - typeRank(right.type) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const projected = (asset: StoryAsset): StoryContextAsset => ({ id: asset.id, type: asset.type, label: asset.label,
    status: asset.status, importance: asset.importance, episodes: asset.episodes ? { ...asset.episodes } : null,
    summary: asset.summary, sourceRefs: [...asset.sourceRefs], facts: asset.facts.map((fact) => ({ ...fact, sourceRefs: [...fact.sourceRefs] })),
    relations: asset.relations.map((relation) => ({ ...relation })),
    selectedBecause: mandatory.get(asset.id) ?? [`agent:${request.agent}:${asset.context.priority}`] });
  const selected: StoryContextAsset[] = [];
  const timelineCandidates = catalogRead.manifest.timeline.filter((event) => request.episode === null
    ? ["story-designer", "showrunner", "evaluator"].includes(request.agent)
    : event.reveal.episode === request.episode)
    .sort((left, right) => left.reveal.episode - right.reveal.episode || left.reveal.order - right.reveal.order
      || left.chronologyIndex - right.chronologyIndex);
  if (request.episode !== null) {
    const currentIds = new Set(timelineCandidates.flatMap((event) => event.assetIds));
    const prior = catalogRead.manifest.timeline.filter((event) => event.reveal.episode < request.episode!
      && event.assetIds.some((id) => currentIds.has(id)))
      .sort((left, right) => right.reveal.episode - left.reveal.episode || right.reveal.order - left.reveal.order)[0];
    if (prior) timelineCandidates.unshift(prior);
  }
  const selectedTimeline: Array<StoryTimelineEvent & { selectedBecause: string }> = [];
  const make = (assets: StoryContextAsset[], timeline: Array<StoryTimelineEvent & { selectedBecause: string }>, omitted: string[],
    omittedTimeline: string[], usedBytes: number, digest: string): StoryContextPack => ({
    version: 1, kind: "writing-loop/story-context-pack", project: request.project, ticketId: request.ticketId,
    agent: request.agent, episode: request.episode, storyDesignSha256: binding.storyDesignSha256,
    assetCatalogSha256: catalogRead.digest, assets, timeline, omittedAssetIds: omitted,
    omittedTimelineEventIds: omittedTimeline,
    budget: { maxBytes, usedBytes, selectedAssets: assets.length, omittedAssets: omitted.length,
      selectedTimelineEvents: timeline.length, omittedTimelineEvents: omittedTimeline.length }, digest,
  });
  const sizeOf = (assets: StoryContextAsset[], timeline: Array<StoryTimelineEvent & { selectedBecause: string }>, omitted: string[], omittedTimeline: string[]): number => {
    let used = 0;
    for (let index = 0; index < 4; index++) {
      const next = Buffer.byteLength(JSON.stringify(make(assets, timeline, omitted, omittedTimeline, used, "0".repeat(64))), "utf8");
      if (next === used) break; used = next;
    }
    return used;
  };
  for (const candidate of candidates) {
    const item = projected(candidate); const next = [...selected, item];
    const omitted = candidates.slice(next.length).map((asset) => asset.id);
    if (sizeOf(next, selectedTimeline, omitted, timelineCandidates.map((event) => event.id)) <= maxBytes) selected.push(item);
    else if (mandatory.has(candidate.id)) throw new StoryAssetError(`context budget 无法容纳 required asset ${candidate.id}`);
  }
  for (const event of timelineCandidates) {
    const item = { ...event, reveal: { ...event.reveal }, assetIds: [...event.assetIds], sourceRefs: [...event.sourceRefs],
      selectedBecause: request.episode !== null && event.reveal.episode === request.episode ? "revealed-in-target-episode" : "related-prior-event" };
    if (!event.assetIds.every((id) => selected.some((asset) => asset.id === id))) continue;
    const next = [...selectedTimeline, item];
    const omittedAssets = candidates.filter((asset) => !selected.some((selectedAsset) => selectedAsset.id === asset.id)).map((asset) => asset.id);
    const omittedTimeline = timelineCandidates.filter((candidate) => !next.some((selectedEvent) => selectedEvent.id === candidate.id)).map((candidate) => candidate.id);
    if (sizeOf(selected, next, omittedAssets, omittedTimeline) <= maxBytes) selectedTimeline.push(item);
    else if (request.episode !== null && event.reveal.episode === request.episode) throw new StoryAssetError(`context budget 无法容纳本集 timeline event ${event.id}`);
  }
  const omitted = candidates.filter((asset) => !selected.some((item) => item.id === asset.id)).map((asset) => asset.id);
  const omittedTimeline = timelineCandidates.filter((event) => !selectedTimeline.some((item) => item.id === event.id)).map((event) => event.id);
  const usedBytes = sizeOf(selected, selectedTimeline, omitted, omittedTimeline);
  const withoutDigest = make(selected, selectedTimeline, omitted, omittedTimeline, usedBytes, "");
  return make(selected, selectedTimeline, omitted, omittedTimeline, usedBytes, productionCanonicalJsonSha256(withoutDigest));
}
