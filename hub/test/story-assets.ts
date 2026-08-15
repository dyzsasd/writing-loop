// Structured story asset/context regression: strict identity, stale Markdown, timeline dual order,
// ticket/episode selection, relation closure, stable digest and bounded output.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStoryContextPack, parseStoryAssetCatalog, readStoryAssetCatalog, validateStoryAssetCatalog,
  type StoryAssetCatalog, type StoryAssetDesignBinding,
} from "../src/story-assets.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => { console.log((condition ? "PASS " : "FAIL ") + message); if (!condition) fails++; };
const throws = (fn: () => unknown, pattern: RegExp, message: string): void => {
  let error = ""; try { fn(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  ok(pattern.test(error), message + (error ? `（${error}）` : "（没有抛错）"));
};
const clone = <T>(value: T): T => structuredClone(value);
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-story-assets-")));
try {
  const repo = join(tmp, "repo"); mkdirSync(join(repo, "story"), { recursive: true });
  const binding: StoryAssetDesignBinding = { project: "demo", repo, sourcePlanId: "wlsrc_demo",
    storyDesignSha256: "a".repeat(64), totalEpisodes: 2,
    characters: [{ id: "C01", name: "周砚衡", firstEpisode: 1, lastEpisode: 2 },
      { id: "C02", name: "季鹤声", firstEpisode: 1, lastEpisode: 2 }],
    scenes: [{ id: "S01", name: "未来听证厅" }, { id: "S02", name: "旧档案库" }],
    episodes: [{ number: 1, characterIds: ["C01", "C02"], sceneIds: ["S01"] },
      { number: 2, characterIds: ["C01"], sceneIds: ["S02"] }] };
  const agents = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator"] as const;
  const asset = (id: string, type: StoryAssetCatalog["assets"][number]["type"], label: string,
    episodes: { first: number; last: number } | null, priority: "required" | "supporting" | "optional" = "supporting") => ({
    id, type, label, status: "active" as const, importance: priority === "required" ? "core" as const : "supporting" as const,
    episodes, summary: `${label} 的结构化剧情事实。`, sourceRefs: ["src:chunk-001"], facts: [], relations: [],
    context: { agents: [...agents], priority },
  });
  const catalog: StoryAssetCatalog = { version: 1, kind: "writing-loop/story-assets", project: "demo",
    sourcePlanId: "wlsrc_demo", storyDesignSha256: "a".repeat(64), revision: 1,
    assets: [
      { ...asset("C01", "character", "周砚衡", { first: 1, last: 2 }, "required"),
        facts: [{ id: "F_C01_GOAL", key: "goal", value: "建立可校验制度", state: "current", basis: "original", sourceRefs: ["north-star:core"] }],
        relations: [{ kind: "rival", targetId: "C02" }] },
      asset("C02", "character", "季鹤声", { first: 1, last: 2 }),
      asset("S01", "scene", "未来听证厅", { first: 1, last: 1 }, "optional"),
      asset("S02", "scene", "旧档案库", { first: 2, last: 2 }),
      { ...asset("F01", "foreshadow", "死亡名册偏航", { first: 1, last: 2 }, "required"),
        facts: [{ id: "F_F01_STATE", key: "lifecycle", value: "planted", state: "current", basis: "original", sourceRefs: ["design:B01"] }],
        relations: [{ kind: "observed-by", targetId: "C01" }] },
      { ...asset("W01", "world", "工业大明制度", null, "required"), facts: [1, 2, 3].map((number) => ({
        id: `F_W01_RULE_${number}`, key: `rule-${number}`, value: "制度约束".repeat(180), state: "current" as const,
        basis: "original" as const, sourceRefs: ["north-star:world"] })) },
    ],
    timeline: [
      { id: "T01", label: "未来听证开场", chronologyIndex: 20, storyTimeLabel: "新历三十年",
        reveal: { episode: 1, order: 1, mode: "flashforward" }, summary: "季鹤声打开封存档案。",
        assetIds: ["C02", "S01", "F01"], sourceRefs: ["north-star:frame"] },
      { id: "T02", label: "档案库醒来", chronologyIndex: 1, storyTimeLabel: "旧历元年春",
        reveal: { episode: 2, order: 1, mode: "memory" }, summary: "周砚衡确认记忆与世界线不一致。",
        assetIds: ["C01", "S02", "F01"], sourceRefs: ["original:season-design"] },
    ] };
  const parsed = parseStoryAssetCatalog(JSON.parse(JSON.stringify(catalog)));
  validateStoryAssetCatalog(parsed, binding);
  ok(parsed.timeline[0].chronologyIndex > parsed.timeline[1].chronologyIndex
    && parsed.timeline[0].reveal.episode < parsed.timeline[1].reveal.episode,
  "时间线分别保存故事时序与观众揭示顺序，倒叙不被排序时抹平");
  writeFileSync(join(repo, "story", "assets.v1.json"), JSON.stringify(parsed, null, 2));
  const read = readStoryAssetCatalog(repo)!;
  const pack = buildStoryContextPack(read, binding, { project: "demo", ticketId: "DEMO-2", agent: "episode-writer", episode: 2 });
  const pack2 = buildStoryContextPack(read, binding, { project: "demo", ticketId: "DEMO-2", agent: "episode-writer", episode: 2 });
  ok(pack.digest === pack2.digest && JSON.stringify(pack) === JSON.stringify(pack2), "同一 ticket/episode 生成字节稳定的 Context Pack");
  ok(pack.assets.some((row) => row.id === "C01") && pack.assets.some((row) => row.id === "S02")
    && pack.assets.some((row) => row.id === "F01") && !pack.assets.some((row) => row.id === "S01"),
  "第 2 集只加载设计引用、required 与一跳关系资产，不带无关第 1 集场景");
  ok(pack.timeline.some((row) => row.id === "T02" && row.selectedBecause === "revealed-in-target-episode")
    && pack.budget.usedBytes === Buffer.byteLength(JSON.stringify(pack), "utf8")
    && pack.budget.usedBytes <= pack.budget.maxBytes, "Context Pack 带本集 timeline 及精确可审计字节预算");
  ok(!JSON.stringify(pack).includes("官居一品.txt") && !JSON.stringify(pack).includes("markdown"),
  "Context Pack 只含结构化事实，不携原著正文或平行 Markdown 指针");

  const crowdedCatalog = clone(parsed);
  crowdedCatalog.assets.push(asset("D01", "continuity", "可选旁支", { first: 2, last: 2 }, "optional"));
  crowdedCatalog.timeline[1].summary = "本集时间线必须先于可选资产进入预算。".repeat(70);
  const crowdedRead = { path: "fixture", digest: "b".repeat(64), manifest: parseStoryAssetCatalog(crowdedCatalog) };
  let reservedPack: ReturnType<typeof buildStoryContextPack> | null = null;
  for (let maxBytes = 4_096; maxBytes <= 32_768 && reservedPack === null; maxBytes += 32) {
    try {
      reservedPack = buildStoryContextPack(crowdedRead, binding,
        { project: "demo", ticketId: "DEMO-2", agent: "episode-writer", episode: 2, maxBytes });
    } catch (caught) {
      if (!(caught instanceof Error) || !caught.message.includes("context budget")) throw caught;
    }
  }
  ok(reservedPack !== null && reservedPack.timeline.some((row) => row.id === "T02")
    && reservedPack.omittedAssetIds.includes("D01") && reservedPack.budget.usedBytes <= reservedPack.budget.maxBytes,
  "本集 timeline 先预留预算，可选资产不得把它挤出 Context Pack");

  const orphan = clone(parsed); orphan.assets[0].relations[0].targetId = "MISSING";
  throws(() => validateStoryAssetCatalog(orphan, binding), /不存在|无效/, "孤儿关系 fail-closed");
  const conflict = clone(parsed); conflict.assets[0].facts.push({ ...conflict.assets[0].facts[0], id: "F_C01_OTHER", value: "相反目标" });
  throws(() => validateStoryAssetCatalog(conflict, binding), /冲突活跃事实/, "同 key 的冲突 current/planned 事实被拒绝");
  const collision = clone(parsed); collision.timeline[1].reveal = { ...collision.timeline[0].reveal };
  throws(() => validateStoryAssetCatalog(collision, binding), /timeline reveal .*重复/, "同一集同一 reveal order 的时间事件被拒绝");
  const duplicateProjection = clone(parsed) as unknown as { assets: Array<Record<string, unknown>> };
  duplicateProjection.assets[0].markdown = { path: "bible/characters.md", sha256: "a".repeat(64), anchor: "主角" };
  throws(() => parseStoryAssetCatalog(duplicateProjection), /字段必须精确/, "asset schema 拒绝重新引入平行 Markdown 剧情投影");
  throws(() => buildStoryContextPack(read, binding, { project: "demo", ticketId: "DEMO-2", agent: "episode-writer", episode: 2, maxBytes: 4_096 }),
    /budget 无法容纳 required asset/, "required 资产放不进预算时硬停，不静默裁剪关键事实");

  const design = { version: 1, kind: "writing-loop/story-design", title: "测试故事", sourcePlanId: null,
    parameters: { totalEpisodes: 2, maxPrimaryScenes: 2, maxNamedCharacters: 2, maxBeatGap: 2 },
    adaptation: { mode: "reimagine", core: "记忆与历史偏航。", keep: [], cut: [], merge: [], risks: [] },
    characters: [{ id: "C01", name: "周砚衡", tier: "lead", role: "调查偏航", arc: "相信证据", sourceRefs: [], firstEpisode: 1, lastEpisode: 2 },
      { id: "C02", name: "季鹤声", tier: "support", role: "不可靠叙述", arc: "保存矛盾", sourceRefs: [], firstEpisode: 1, lastEpisode: 2 }],
    scenes: [{ id: "S01", name: "未来听证厅", primary: true, variantOf: null, reusePlan: "双时空复用", productionNotes: "固定几何" },
      { id: "S02", name: "旧档案库", primary: true, variantOf: null, reusePlan: "多集复用", productionNotes: "档案墙" }],
    beats: [{ id: "B01", episode: 1, weight: "major", label: "听证", setup: "空椅", payoff: "档案开启" },
      { id: "B02", episode: 2, weight: "major", label: "醒来", setup: "历史记忆", payoff: "第一处偏差" }],
    episodes: [{ number: 1, arc: "未来", synopsis: "听证会开启档案。", hookType: "H1", hook: "一张名册缺人。", suspense: "谁改写了记录。", agency: "active", beatIds: ["B01"], sceneIds: ["S01"], characterIds: ["C01", "C02"], crowdPlan: null },
      { number: 2, arc: "过去", synopsis: "主角在档案库验证偏差。", hookType: "H2", hook: "旧史第一次失效。", suspense: "记忆是否可信。", agency: "active", beatIds: ["B02"], sceneIds: ["S02"], characterIds: ["C01"], crowdPlan: null }] };
  const designRaw = JSON.stringify(design, null, 2); const designSha = createHash("sha256").update(designRaw).digest("hex");
  writeFileSync(join(repo, "story", "outline.v1.json"), designRaw);
  const cliCatalog = clone(parsed); cliCatalog.sourcePlanId = null; cliCatalog.storyDesignSha256 = designSha;
  writeFileSync(join(repo, "story", "assets.v1.json"), JSON.stringify(cliCatalog, null, 2));
  mkdirSync(join(tmp, ".writing-loop", "demo", "board", "tickets"), { recursive: true });
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({ version: 1, projects: { demo: {
    title: "测试故事", repoPath: "repo", enabled: true, totalEpisodes: 2, maxPrimaryScenes: 2, maxNamedCharacters: 2,
  } } }, null, 2));
  writeFileSync(join(tmp, ".writing-loop", "demo", "board", "tickets", "DEMO-2.md"),
    "---\nid: DEMO-2\ntitle: ep-002 写作\ntype: Feature\nstate: Todo\nowner: reviewer\nlabels: [writing-loop, episode, episode-writer]\npriority: 1\nassignee: null\nupdated: 2026-08-11T00:00:00Z\n---\nEpisode: 2\n## Context\n测试\n");
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "story.ts"), "context", "--project", "demo",
    "--ticket", "DEMO-2", "--agent", "episode-writer", "--json"], { cwd: tmp, encoding: "utf8" });
  const cliPack = (() => { try { return JSON.parse(cli.stdout) as { episode?: number; agent?: string; digest?: string }; } catch { return null; } })();
  ok(cli.status === 0 && cliPack?.episode === 2 && cliPack.agent === "episode-writer" && /^[a-f0-9]{64}$/.test(cliPack.digest ?? ""),
  `story context CLI 从 ticket 自动绑定 Episode/agent 并输出稳定 pack digest${cli.status === 0 && cliPack ? "" : `（stdout=${cli.stdout.trim()} stderr=${cli.stderr.trim()}）`}`);
  const unauthorized = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "story.ts"), "context", "--project", "demo",
    "--ticket", "DEMO-2", "--agent", "market-watch", "--json"], { cwd: tmp, encoding: "utf8" });
  ok(unauthorized.status === 2 && unauthorized.stderr.includes("未授权"), "ticket 未授权的 agent 在读取任何剧情资产前被拒绝");

  // 一跳关系闭包不得把资产升级为硬性必载：本集设计引用面之外、经 relation 带入的 supporting/
  // optional 资产必须可被预算裁掉，否则它们会挤掉本集 timeline event 使该集无合法开工路径。
  const relationCatalog: StoryAssetCatalog = clone(catalog);
  const bulk = (id: string, label: string) => ({
    ...asset(id, "object" as const, label, { first: 1, last: 2 }, "optional" as const),
    facts: [1, 2, 3, 4].map((number) => ({ id: `F_${id}_${number}`, key: `k-${number}`,
      value: "关系闭包带入的旁支事实".repeat(100), state: "current" as const,
      basis: "original" as const, sourceRefs: ["design:side"] })),
  });
  relationCatalog.assets = [
    ...relationCatalog.assets.map((row) => row.id !== "C01" ? row : { ...clone(row),
      relations: [{ kind: "rival", targetId: "C02" }, { kind: "carries", targetId: "O91" },
        { kind: "carries", targetId: "O92" }, { kind: "carries", targetId: "O93" }] }),
    bulk("O91", "旁支册一"), bulk("O92", "旁支册二"), bulk("O93", "旁支册三"),
  ];
  const relationParsed = parseStoryAssetCatalog(JSON.parse(JSON.stringify(relationCatalog)));
  validateStoryAssetCatalog(relationParsed, binding);
  const relationRepo = join(tmp, "relation-repo"); mkdirSync(join(relationRepo, "story"), { recursive: true });
  writeFileSync(join(relationRepo, "story", "assets.v1.json"), JSON.stringify(relationParsed, null, 2));
  const relationRead = readStoryAssetCatalog(relationRepo)!;
  const relationRequest = { project: "demo", ticketId: "DEMO-2", agent: "episode-writer" as const, episode: 2 };
  const full = buildStoryContextPack(relationRead, { ...binding, repo: relationRepo }, relationRequest);
  const sideBytes = Math.max(...["O91", "O92", "O93"].map((id) =>
    Buffer.byteLength(JSON.stringify(full.assets.find((row) => row.id === id) ?? {}), "utf8")));
  // 预算取「完整包再减去一条旁支」——修复前三条旁支是 mandatory 会硬装并挤掉 T02，修复后它们让位。
  const tight = full.budget.usedBytes - sideBytes;
  const tightPack = buildStoryContextPack(relationRead, { ...binding, repo: relationRepo }, { ...relationRequest, maxBytes: tight });
  ok(tightPack.timeline.some((row) => row.id === "T02" && row.selectedBecause === "revealed-in-target-episode"),
  "预算收紧时本集 timeline event 仍在包内，不被关系闭包带入的旁支资产挤出");
  ok(tightPack.assets.some((row) => row.id === "C01") && tightPack.assets.some((row) => row.id === "S02")
    && tightPack.assets.some((row) => row.id === "F01"),
  "预算收紧时本集设计引用面与 required 资产仍全部保留");
  ok(tightPack.omittedAssetIds.some((id) => ["O91", "O92", "O93"].includes(id)),
  "经一跳关系带入、不在本集设计引用面内的 optional 资产可被预算裁掉并登记在 omitted");
  const relationReason = full.selection["O91"] ?? [];
  ok(relationReason.some((reason) => reason.startsWith("relation:C01:")),
  "关系带入的资产在预算允许时仍进包，并保留 relation 选中理由");

  // 全局请求（episode: null）下，只覆盖单一集的 required 资产必须降级为候选：它的 required 是
  // 相对那一集而言的。否则逐集资产随交付集数线性累积，最终超过任何预算使设计车道无法开工。
  const seasonCatalog: StoryAssetCatalog = clone(catalog);
  const perEpisode = (id: string, episode: number) => ({
    ...asset(id, "episode" as const, `第 ${episode} 集设计`, { first: episode, last: episode }, "required" as const),
    facts: [1, 2, 3, 4].map((number) => ({ id: `F_${id}_${number}`, key: `beat-${number}`,
      value: "逐集节拍与制作说明".repeat(100), state: "current" as const,
      basis: "original" as const, sourceRefs: ["design:beat"] })),
  });
  seasonCatalog.assets = [...seasonCatalog.assets, perEpisode("EP01", 1), perEpisode("EP02", 2)];
  const seasonParsed = parseStoryAssetCatalog(JSON.parse(JSON.stringify(seasonCatalog)));
  validateStoryAssetCatalog(seasonParsed, binding);
  const seasonRepo = join(tmp, "season-repo"); mkdirSync(join(seasonRepo, "story"), { recursive: true });
  writeFileSync(join(seasonRepo, "story", "assets.v1.json"), JSON.stringify(seasonParsed, null, 2));
  const seasonRead = readStoryAssetCatalog(seasonRepo)!;
  const seasonBinding = { ...binding, repo: seasonRepo };
  const seasonFull = buildStoryContextPack(seasonRead, seasonBinding,
    { project: "demo", ticketId: "DEMO-9", agent: "story-designer", episode: null });
  const epBytes = Math.max(...["EP01", "EP02"].map((id) =>
    Buffer.byteLength(JSON.stringify(seasonFull.assets.find((row) => row.id === id) ?? {}), "utf8")));
  const seasonTight = buildStoryContextPack(seasonRead, seasonBinding,
    { project: "demo", ticketId: "DEMO-9", agent: "story-designer", episode: null, maxBytes: seasonFull.budget.usedBytes - epBytes });
  ok(seasonTight.assets.some((row) => row.id === "W01") && seasonTight.assets.some((row) => row.id === "C01"),
  "全局请求预算收紧时，跨集 required 资产（世界规则、主角）仍是必载面");
  ok(seasonTight.omittedAssetIds.some((id) => ["EP01", "EP02"].includes(id)),
  "全局请求预算收紧时，只覆盖单一集的 required 资产降级为候选并可被裁掉");
  const scopedReason = seasonFull.selection["EP01"] ?? [];
  ok(scopedReason.includes("agent:required-episode-scoped"),
  "降级的逐集 required 资产在预算允许时仍进包，并标注降级理由");
  const episodeScoped = buildStoryContextPack(seasonRead, seasonBinding,
    { project: "demo", ticketId: "DEMO-2", agent: "story-designer", episode: 1 });
  ok((episodeScoped.selection["EP01"] ?? []).includes("episode:required"),
  "指定本集时，该集的 required 资产仍是硬性必载，不受全局降级影响");

  // 缓存契约：pack 的稳定段必须先于每请求可变段序列化，否则据此拼的 prompt 无公共前缀可缓存。
  const byteCommonPrefix = (left: unknown, right: unknown): number => {
    const a = Buffer.from(JSON.stringify(left)), b = Buffer.from(JSON.stringify(right));
    let index = 0; while (index < a.length && index < b.length && a[index] === b[index]) index++; return index;
  };
  const keys = Object.keys(seasonFull);
  ok(keys.indexOf("assets") < keys.indexOf("agent") && keys.indexOf("assets") < keys.indexOf("ticketId")
    && keys.indexOf("assets") < keys.indexOf("episode") && keys.indexOf("assets") < keys.indexOf("assetCatalogSha256")
    && keys.indexOf("assets") < keys.indexOf("selection") && keys.indexOf("assets") < keys.indexOf("digest"),
  "Context Pack 字段顺序把 assets 排在 agent/ticketId/episode/catalog digest/selection/digest 之前");
  const ticketA = buildStoryContextPack(seasonRead, seasonBinding,
    { project: "demo", ticketId: "DEMO-2", agent: "story-designer", episode: 1 });
  const ticketB = buildStoryContextPack(seasonRead, seasonBinding,
    { project: "demo", ticketId: "DEMO-77", agent: "story-designer", episode: 1 });
  const assetsEnd = JSON.stringify(ticketA).indexOf("\"ticketId\"");
  ok(byteCommonPrefix(ticketA, ticketB) >= assetsEnd && assetsEnd > 0,
  "同集不同 ticket 的两个 pack 共享覆盖整个 assets 段的字节前缀");
  const emitted = ticketA.assets.map((row) => row.id);
  const reordered = [...ticketA.assets].sort((left, right) => {
    const l = Number(left.episodes !== null && left.episodes.first === left.episodes.last);
    const r = Number(right.episodes !== null && right.episodes.first === right.episodes.last);
    return l - r || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }).map((row) => row.id);
  ok(emitted.filter((id) => reordered.includes(id)).length === emitted.length
    && emitted[0] !== undefined && !emitted.slice(0, -1).some((_id, index) => {
      const current = ticketA.assets[index], next = ticketA.assets[index + 1];
      const cs = Number(current.episodes !== null && current.episodes.first === current.episodes.last);
      const ns = Number(next.episodes !== null && next.episodes.first === next.episodes.last);
      return cs > ns;
    }),
  "assets 输出顺序把跨集资产排在单集资产之前，与本集 tier 无关");
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log(fails === 0 ? "\nSTORY_ASSETS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
