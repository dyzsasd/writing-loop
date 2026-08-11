// Canonical story-design companion for writing-loop. Markdown remains the human-readable
// screenplay asset; this strict JSON file gives the scheduler, quality gates and Studio one
// shared, deterministic view of structure, provenance and production constraints.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { readSourceIntakeStatus } from "./source-intake.ts";
import { projectEntries, resolveRepoPath, type WlConfig, WsError } from "./workspace.ts";

export const STORY_DESIGN_RELATIVE_PATH = "story/outline.v1.json";
export const MAX_STORY_DESIGN_BYTES = 4 * 1024 * 1024;

export type StoryDesignStage = "skeleton" | "beats" | "full";
export type StoryHookType = "H0" | "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7";
export type StoryCharacterTier = "lead" | "support" | "functional";

export type StoryDesignDecision = { item: string; reason: string; sourceRefs: string[] };
export type StoryDesignCharacter = {
  id: string; name: string; tier: StoryCharacterTier; role: string; arc: string | null;
  sourceRefs: string[]; firstEpisode: number; lastEpisode: number;
};
export type StoryDesignScene = {
  id: string; name: string; primary: boolean; variantOf: string | null;
  reusePlan: string | null; productionNotes: string;
};
export type StoryDesignBeat = {
  id: string; episode: number; weight: "major" | "minor"; label: string; setup: string; payoff: string;
};
export type StoryDesignEpisode = {
  number: number; arc: string; synopsis: string; hookType: StoryHookType; hook: string; suspense: string;
  agency: "active" | "reactive" | "passive"; beatIds: string[]; sceneIds: string[];
  characterIds: string[]; crowdPlan: string | null;
};

export type StoryDesignManifest = {
  version: 1;
  kind: "writing-loop/story-design";
  title: string;
  sourcePlanId: string | null;
  parameters: { totalEpisodes: number; maxPrimaryScenes: number; maxNamedCharacters: number; maxBeatGap: number };
  adaptation: {
    mode: "faithful" | "extract-core" | "reimagine";
    core: string;
    keep: StoryDesignDecision[];
    cut: StoryDesignDecision[];
    merge: StoryDesignDecision[];
    risks: StoryDesignDecision[];
  };
  characters: StoryDesignCharacter[];
  scenes: StoryDesignScene[];
  beats: StoryDesignBeat[];
  episodes: StoryDesignEpisode[];
};

export type StoryDesignPolicy = {
  totalEpisodes: number;
  maxPrimaryScenes: number;
  maxNamedCharacters: number;
  sourcePlanId: string | null;
};

export type StoryGate = {
  id: string;
  label: string;
  stage: StoryDesignStage;
  kind: "deterministic" | "judgment";
  state: "pass" | "fail" | "skipped" | "not-applicable";
  detail: string;
};

export type StoryAssetPlan = {
  characters: Array<{ id: string; name: string; tier: StoryCharacterTier; episodes: [number, number]; sourceRefs: string[] }>;
  scenes: Array<{ id: string; name: string; primary: boolean; variantOf: string | null; reusePlan: string | null }>;
  counts: { characters: number; leads: number; primaryScenes: number; beats: number; episodes: number };
};

export type StoryStudioReadModel = {
  version: 1;
  project: string;
  source: null | {
    title: string; planId: string; sha256: string; byteLength: number; chunkCount: number;
    phase: "registered" | "analyzing" | "review-ready"; selected: number; completed: number;
    allowedHarnesses: string[]; updatedAt: string;
    chunks: Array<{ id: string; headings: string[]; selected: boolean; completed: boolean }>;
  };
  story: null | { path: string; manifest: StoryDesignManifest; assets: StoryAssetPlan };
  gates: StoryGate[];
  summary: { stage: "source" | StoryDesignStage; passed: number; failed: number; skipped: number; readyForEpisodes: boolean };
  warnings: string[];
};

export class StoryDesignError extends WsError {
  constructor(message: string) { super(message); this.name = "StoryDesignError"; }
}

type Obj = Record<string, unknown>;
const ID = /^[A-Z][A-Z0-9_-]{0,31}$/;
const HOOKS = new Set<StoryHookType>(["H0", "H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Obj, expected: string[], label: string): void => {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new StoryDesignError(`${label} 字段必须精确为 ${wanted.join(", ")}`);
  }
};
const obj = (value: unknown, label: string): Obj => {
  if (!isObj(value)) throw new StoryDesignError(`${label} 必须是 JSON 对象`); return value;
};
const text = (value: unknown, label: string, max = 4_000): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max) {
    throw new StoryDesignError(`${label} 必须是 1–${max} 字符的非空字符串`);
  }
  return value.trim().replace(/\r\n/g, "\n");
};
const nullableText = (value: unknown, label: string, max = 4_000): string | null => value === null ? null : text(value, label, max);
const integer = (value: unknown, label: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new StoryDesignError(`${label} 必须是 ${min}–${max} 的安全整数`);
  }
  return Number(value);
};
const stringArray = (value: unknown, label: string, max = 256): string[] => {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) {
    throw new StoryDesignError(`${label} 必须是最多 ${max} 项的短字符串数组`);
  }
  const out = value.map((item) => String(item).trim());
  if (new Set(out).size !== out.length) throw new StoryDesignError(`${label} 不能重复`);
  return out;
};
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new StoryDesignError(`${label} 无效`);
  return value as T;
};

function parseDecision(value: unknown, label: string): StoryDesignDecision {
  const row = obj(value, label); keys(row, ["item", "reason", "sourceRefs"], label);
  return { item: text(row.item, `${label}.item`, 500), reason: text(row.reason, `${label}.reason`, 1_500), sourceRefs: stringArray(row.sourceRefs, `${label}.sourceRefs`, 64) };
}

export function parseStoryDesignManifest(value: unknown): StoryDesignManifest {
  const root = obj(value, "story design");
  keys(root, ["version", "kind", "title", "sourcePlanId", "parameters", "adaptation", "characters", "scenes", "beats", "episodes"], "story design");
  if (root.version !== 1 || root.kind !== "writing-loop/story-design") throw new StoryDesignError("story design identity 无效");
  const parameters = obj(root.parameters, "parameters");
  keys(parameters, ["totalEpisodes", "maxPrimaryScenes", "maxNamedCharacters", "maxBeatGap"], "parameters");
  const adaptation = obj(root.adaptation, "adaptation");
  keys(adaptation, ["mode", "core", "keep", "cut", "merge", "risks"], "adaptation");
  const decisions = (field: "keep" | "cut" | "merge" | "risks"): StoryDesignDecision[] => {
    const list = adaptation[field];
    if (!Array.isArray(list) || list.length > 128) throw new StoryDesignError(`adaptation.${field} 必须是最多 128 项的数组`);
    return list.map((row, index) => parseDecision(row, `adaptation.${field}[${index}]`));
  };
  if (!Array.isArray(root.characters) || root.characters.length > 200) throw new StoryDesignError("characters 必须是最多 200 项的数组");
  const characters = root.characters.map((value, index): StoryDesignCharacter => {
    const row = obj(value, `characters[${index}]`);
    keys(row, ["id", "name", "tier", "role", "arc", "sourceRefs", "firstEpisode", "lastEpisode"], `characters[${index}]`);
    const id = text(row.id, `characters[${index}].id`, 32);
    if (!ID.test(id)) throw new StoryDesignError(`characters[${index}].id 必须是安全 ASCII ID`);
    const firstEpisode = integer(row.firstEpisode, `characters[${index}].firstEpisode`, 1, 300);
    const lastEpisode = integer(row.lastEpisode, `characters[${index}].lastEpisode`, firstEpisode, 300);
    return { id, name: text(row.name, `characters[${index}].name`, 120),
      tier: enumValue(row.tier, ["lead", "support", "functional"] as const, `characters[${index}].tier`),
      role: text(row.role, `characters[${index}].role`, 1_000), arc: nullableText(row.arc, `characters[${index}].arc`, 2_000),
      sourceRefs: stringArray(row.sourceRefs, `characters[${index}].sourceRefs`, 64), firstEpisode, lastEpisode };
  });
  if (!Array.isArray(root.scenes) || root.scenes.length > 200) throw new StoryDesignError("scenes 必须是最多 200 项的数组");
  const scenes = root.scenes.map((value, index): StoryDesignScene => {
    const row = obj(value, `scenes[${index}]`);
    keys(row, ["id", "name", "primary", "variantOf", "reusePlan", "productionNotes"], `scenes[${index}]`);
    const id = text(row.id, `scenes[${index}].id`, 32);
    if (!ID.test(id) || typeof row.primary !== "boolean") throw new StoryDesignError(`scenes[${index}] identity 无效`);
    return { id, name: text(row.name, `scenes[${index}].name`, 160), primary: row.primary,
      variantOf: nullableText(row.variantOf, `scenes[${index}].variantOf`, 32),
      reusePlan: nullableText(row.reusePlan, `scenes[${index}].reusePlan`, 1_000),
      productionNotes: text(row.productionNotes, `scenes[${index}].productionNotes`, 1_500) };
  });
  if (!Array.isArray(root.beats) || root.beats.length > 2_000) throw new StoryDesignError("beats 必须是最多 2000 项的数组");
  const beats = root.beats.map((value, index): StoryDesignBeat => {
    const row = obj(value, `beats[${index}]`); keys(row, ["id", "episode", "weight", "label", "setup", "payoff"], `beats[${index}]`);
    const id = text(row.id, `beats[${index}].id`, 32); if (!ID.test(id)) throw new StoryDesignError(`beats[${index}].id 无效`);
    return { id, episode: integer(row.episode, `beats[${index}].episode`, 1, 300),
      weight: enumValue(row.weight, ["major", "minor"] as const, `beats[${index}].weight`),
      label: text(row.label, `beats[${index}].label`, 200), setup: text(row.setup, `beats[${index}].setup`, 1_500),
      payoff: text(row.payoff, `beats[${index}].payoff`, 1_500) };
  });
  if (!Array.isArray(root.episodes) || root.episodes.length > 300) throw new StoryDesignError("episodes 必须是最多 300 项的数组");
  const episodes = root.episodes.map((value, index): StoryDesignEpisode => {
    const row = obj(value, `episodes[${index}]`);
    keys(row, ["number", "arc", "synopsis", "hookType", "hook", "suspense", "agency", "beatIds", "sceneIds", "characterIds", "crowdPlan"], `episodes[${index}]`);
    if (typeof row.hookType !== "string" || !HOOKS.has(row.hookType as StoryHookType)) throw new StoryDesignError(`episodes[${index}].hookType 无效`);
    return { number: integer(row.number, `episodes[${index}].number`, 1, 300), arc: text(row.arc, `episodes[${index}].arc`, 120),
      synopsis: text(row.synopsis, `episodes[${index}].synopsis`, 2_000), hookType: row.hookType as StoryHookType,
      hook: text(row.hook, `episodes[${index}].hook`, 1_000), suspense: text(row.suspense, `episodes[${index}].suspense`, 1_000),
      agency: enumValue(row.agency, ["active", "reactive", "passive"] as const, `episodes[${index}].agency`),
      beatIds: stringArray(row.beatIds, `episodes[${index}].beatIds`, 64), sceneIds: stringArray(row.sceneIds, `episodes[${index}].sceneIds`, 64),
      characterIds: stringArray(row.characterIds, `episodes[${index}].characterIds`, 64), crowdPlan: nullableText(row.crowdPlan, `episodes[${index}].crowdPlan`, 1_000) };
  });
  return { version: 1, kind: "writing-loop/story-design", title: text(root.title, "title", 200),
    sourcePlanId: root.sourcePlanId === null ? null : text(root.sourcePlanId, "sourcePlanId", 80),
    parameters: { totalEpisodes: integer(parameters.totalEpisodes, "parameters.totalEpisodes", 1, 300),
      maxPrimaryScenes: integer(parameters.maxPrimaryScenes, "parameters.maxPrimaryScenes", 1, 100),
      maxNamedCharacters: integer(parameters.maxNamedCharacters, "parameters.maxNamedCharacters", 1, 200),
      maxBeatGap: integer(parameters.maxBeatGap, "parameters.maxBeatGap", 1, 30) },
    adaptation: { mode: enumValue(adaptation.mode, ["faithful", "extract-core", "reimagine"] as const, "adaptation.mode"),
      core: text(adaptation.core, "adaptation.core", 4_000), keep: decisions("keep"), cut: decisions("cut"),
      merge: decisions("merge"), risks: decisions("risks") }, characters, scenes, beats, episodes };
}

const gate = (id: string, label: string, stage: StoryDesignStage, state: StoryGate["state"], detail: string,
  kind: StoryGate["kind"] = "deterministic"): StoryGate => ({ id, label, stage, kind, state, detail });
const stageRank = (stage: StoryDesignStage): number => ({ skeleton: 0, beats: 1, full: 2 })[stage];

export function validateStoryDesign(manifest: StoryDesignManifest, policy: StoryDesignPolicy, requested: StoryDesignStage = "full"): StoryGate[] {
  const out: StoryGate[] = [];
  const add = (id: string, label: string, stage: StoryDesignStage, pass: boolean, detail: string, kind: StoryGate["kind"] = "deterministic"): void => {
    out.push(stageRank(stage) > stageRank(requested) ? gate(id, label, stage, "skipped", `等待 ${stage} 阶段`, kind)
      : gate(id, label, stage, pass ? "pass" : "fail", detail, kind));
  };
  const ids = (rows: Array<{ id: string }>): boolean => new Set(rows.map((row) => row.id)).size === rows.length;
  add("S01", "项目参数与 North Star 一致", "skeleton",
    manifest.parameters.totalEpisodes === policy.totalEpisodes && manifest.parameters.maxPrimaryScenes === policy.maxPrimaryScenes
      && manifest.parameters.maxNamedCharacters === policy.maxNamedCharacters,
    `${manifest.parameters.totalEpisodes} 集 · ${manifest.parameters.maxPrimaryScenes} 主场景 · ${manifest.parameters.maxNamedCharacters} 具名角色`);
  add("S02", "原著 provenance 精确绑定", "skeleton",
    policy.sourcePlanId === null ? manifest.sourcePlanId === null : manifest.sourcePlanId === policy.sourcePlanId,
    policy.sourcePlanId ? `source-intake ${manifest.sourcePlanId ?? "缺失"}` : "原创项目不适用原著 plan");
  const allDecisions = [...manifest.adaptation.keep, ...manifest.adaptation.cut, ...manifest.adaptation.merge, ...manifest.adaptation.risks];
  add("S03", "改编决策有可追溯依据", "skeleton",
    policy.sourcePlanId === null || (allDecisions.length >= 4 && allDecisions.every((row) => row.sourceRefs.length > 0)),
    `${allDecisions.length} 条保留/删除/合并/风险决策`);
  const leadCount = manifest.characters.filter((row) => row.tier === "lead").length;
  add("S04", "角色分级与数量预算", "skeleton",
    ids(manifest.characters) && manifest.characters.length <= policy.maxNamedCharacters && leadCount >= 1 && leadCount <= 5
      && manifest.characters.every((row) => row.lastEpisode <= policy.totalEpisodes),
    `${manifest.characters.length}/${policy.maxNamedCharacters} 角色 · ${leadCount} 核心角色`);
  const sceneIds = new Set(manifest.scenes.map((row) => row.id));
  const primary = manifest.scenes.filter((row) => row.primary).length;
  const sceneReferences = new Map<string, number>();
  manifest.episodes.flatMap((row) => row.sceneIds).forEach((id) => sceneReferences.set(id, (sceneReferences.get(id) ?? 0) + 1));
  add("S05", "场景预算与复用计划", "skeleton", ids(manifest.scenes) && primary <= policy.maxPrimaryScenes
    && manifest.scenes.every((row) => row.variantOf === null || (sceneIds.has(row.variantOf) && row.variantOf !== row.id))
    && manifest.scenes.every((row) => (sceneReferences.get(row.id) ?? 0) !== 1 || row.reusePlan !== null),
    `${primary}/${policy.maxPrimaryScenes} 主场景；一次性场景必须说明复用/合并方案`);

  const beatIds = new Set(manifest.beats.map((row) => row.id));
  add("B01", "节拍 ID、集号与引用闭合", "beats", ids(manifest.beats)
    && manifest.beats.every((row) => row.episode <= policy.totalEpisodes)
    && manifest.episodes.every((row) => row.beatIds.every((id) => beatIds.has(id))), `${manifest.beats.length} 个节拍`);
  const major = manifest.beats.filter((row) => row.weight === "major").map((row) => row.episode).sort((a, b) => a - b);
  const anchors = [1, ...major, policy.totalEpisodes];
  const maxGap = anchors.slice(1).reduce((max, episode, index) => Math.max(max, episode - anchors[index]), 0);
  add("B02", "主节拍之间没有叙事死区", "beats", major.length >= Math.max(3, Math.ceil(policy.totalEpisodes / 15))
    && maxGap <= manifest.parameters.maxBeatGap, `主节拍 ${major.length} 个 · 最大间隔 ${maxGap}/${manifest.parameters.maxBeatGap} 集`);

  const expectedEpisodes = Array.from({ length: policy.totalEpisodes }, (_, index) => index + 1);
  add("F01", "分集连续且完整", "full", manifest.episodes.length === policy.totalEpisodes
    && manifest.episodes.every((row, index) => row.number === expectedEpisodes[index]), `${manifest.episodes.length}/${policy.totalEpisodes} 集`);
  const characterIds = new Set(manifest.characters.map((row) => row.id));
  add("F02", "分集资产引用闭合", "full", manifest.episodes.every((row) => row.sceneIds.length > 0
    && row.characterIds.length > 0 && row.sceneIds.every((id) => sceneIds.has(id)) && row.characterIds.every((id) => characterIds.has(id))),
  "每集至少一个场景和角色，且引用均存在");
  const paidHooks = manifest.episodes.filter((row) => row.hookType === "H1" || row.hookType === "H2").length;
  const repeatedHooks = manifest.episodes.some((row, index) => index > 0 && row.hookType === manifest.episodes[index - 1].hookType);
  add("F03", "钩型组合有变化且强钩占比达标", "full", manifest.episodes[0]?.hookType !== "H0"
    && paidHooks >= Math.ceil(policy.totalEpisodes / 2) && !repeatedHooks,
    `H1/H2 ${paidHooks}/${policy.totalEpisodes}；相邻钩型不可重复`);
  add("F04", "群戏具有调度方案", "full", manifest.episodes.every((row) => row.characterIds.length < 4 || row.crowdPlan !== null),
    "同集四名以上具名角色时必须写 crowdPlan");
  const quoteLike = /[“”「」]|(?:^|\s)[\p{L}\p{N}_-]{1,20}[：:]/u;
  add("F05", "结构字段不是对白草稿", "full", manifest.episodes.every((row) => !quoteLike.test(row.synopsis)
    && !quoteLike.test(row.hook) && !quoteLike.test(row.suspense)), "synopsis/hook/suspense 只写叙事事实，不提前生成对白");
  add("J01", "合规但平庸否决位", "full", true, "机器门通过不等于创作批准；Showrunner 仍须引用文本作独立判断", "judgment");
  return out;
}

export function deriveStoryAssets(manifest: StoryDesignManifest): StoryAssetPlan {
  return { characters: manifest.characters.map((row) => ({ id: row.id, name: row.name, tier: row.tier,
    episodes: [row.firstEpisode, row.lastEpisode], sourceRefs: [...row.sourceRefs] })),
  scenes: manifest.scenes.map((row) => ({ id: row.id, name: row.name, primary: row.primary,
    variantOf: row.variantOf, reusePlan: row.reusePlan })),
  counts: { characters: manifest.characters.length, leads: manifest.characters.filter((row) => row.tier === "lead").length,
    primaryScenes: manifest.scenes.filter((row) => row.primary).length, beats: manifest.beats.length, episodes: manifest.episodes.length } };
}

function projectPolicy(root: string, key: string, config: WlConfig): { repo: string; policy: StoryDesignPolicy } {
  const entry = projectEntries(config).find(([candidate]) => candidate === key);
  if (!entry) throw new StoryDesignError(`config.json 无项目 '${key}'`);
  const project = entry[1];
  const value = (field: string, min: number, max: number): number => {
    const raw = project[field]; if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) throw new StoryDesignError(`项目 ${field} 配置无效`);
    return Number(raw);
  };
  const source = readSourceIntakeStatus(root, key);
  return { repo: resolveRepoPath(root, project), policy: { totalEpisodes: value("totalEpisodes", 1, 300),
    maxPrimaryScenes: value("maxPrimaryScenes", 1, 100), maxNamedCharacters: value("maxNamedCharacters", 1, 200),
    sourcePlanId: source?.manifest.planId ?? null } };
}

export function readStoryDesign(root: string, key: string, config: WlConfig): { path: string; manifest: StoryDesignManifest; policy: StoryDesignPolicy } | null {
  const entry = projectEntries(config).find(([candidate]) => candidate === key);
  if (!entry) throw new StoryDesignError(`config.json 无项目 '${key}'`);
  const repo = resolveRepoPath(root, entry[1]);
  const path = join(repo, STORY_DESIGN_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  const { policy } = projectPolicy(root, key, config);
  const raw = readRegularTextExact(path, MAX_STORY_DESIGN_BYTES);
  if (raw === null) throw new StoryDesignError(`${STORY_DESIGN_RELATIVE_PATH} 必须是未变化、单链接、<=${MAX_STORY_DESIGN_BYTES} bytes 的 UTF-8 普通文件`);
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new StoryDesignError(`${STORY_DESIGN_RELATIVE_PATH} 不是有效 JSON`); }
  return { path, manifest: parseStoryDesignManifest(value), policy };
}

export function buildStoryStudioReadModel(root: string, key: string, config: WlConfig): StoryStudioReadModel {
  const warnings: string[] = [];
  let source: StoryStudioReadModel["source"] = null;
  try {
    const status = readSourceIntakeStatus(root, key);
    if (status) {
      const selected = new Set(status.control.selectedChunks); const completed = new Set(status.control.completedChunks);
      source = { title: status.manifest.source.title, planId: status.manifest.planId, sha256: status.manifest.source.sha256,
        byteLength: status.manifest.source.byteLength, chunkCount: status.manifest.chunking.chunks.length, phase: status.control.phase,
        selected: selected.size, completed: completed.size, allowedHarnesses: [...status.manifest.adaptation.processingConsent.allowedHarnesses],
        updatedAt: status.control.updatedAt, chunks: status.manifest.chunking.chunks.map((row) => ({ id: row.id,
          headings: [...row.headings], selected: selected.has(row.id), completed: completed.has(row.id) })) };
    }
  } catch (error) { warnings.push(`原著状态不可读：${error instanceof Error ? error.message : String(error)}`); }
  let story: StoryStudioReadModel["story"] = null;
  let gates: StoryGate[] = [];
  try {
    const read = readStoryDesign(root, key, config);
    if (read) { gates = validateStoryDesign(read.manifest, read.policy, "full");
      story = { path: STORY_DESIGN_RELATIVE_PATH, manifest: read.manifest, assets: deriveStoryAssets(read.manifest) }; }
    else gates = [gate("S00", "结构化故事资产已建立", "skeleton", "fail", `等待 story-designer 创建 ${STORY_DESIGN_RELATIVE_PATH}`)];
  } catch (error) { gates = [gate("S00", "结构化故事资产可解析", "skeleton", "fail", error instanceof Error ? error.message : String(error))]; }
  const passed = gates.filter((row) => row.state === "pass").length;
  const failed = gates.filter((row) => row.state === "fail").length;
  const skipped = gates.filter((row) => row.state === "skipped").length;
  const stage: StoryStudioReadModel["summary"]["stage"] = source && source.phase !== "review-ready" ? "source"
    : !story ? "skeleton" : story.manifest.episodes.length === story.manifest.parameters.totalEpisodes ? "full"
      : story.manifest.beats.length ? "beats" : "skeleton";
  return { version: 1, project: key, source, story, gates,
    summary: { stage, passed, failed, skipped, readyForEpisodes: story !== null && failed === 0 && stage === "full" }, warnings };
}
