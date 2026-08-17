// 分集节拍单（story/assets.v1.json 里 type=episode 的 EPnnn 资产）的确定性一致性检查——大纲门的机器半边。
// 动机：arc-03 实测「卡自身矛盾 = 这一集必败」（YJJS-142：spec/production-flags 写 2 场而拍序需要 3 场；
// YJJS-97：同一资产两条 current 事实相反；YJJS-150：设计层取舍缺失），这些都漏到写作阶段才被审读门抓出，
// 每次代价 = 一次写手 fire + 一次 opus 审读 + revert。这里只做纯文本可判的部分；叙事实质仍归 showrunner J01。
import type { StoryAssetCatalog } from "./story-assets.ts";
import type { StoryDesignManifest } from "./story-design.ts";

export type StoryCardFinding = { code: string; severity: "error" | "warning"; assetId: string; message: string };

// 有 beats/spec/production-flags 任一者视为「节拍单」（季级锚位卡如 EP058/EP060 只有 payoff/hook 类事实，不在此列）。
export const CARD_MARKER_KEYS = ["beats", "spec", "production-flags"];
export const CARD_REQUIRED_KEYS = ["premise", "continuity-in", "beats", "hook", "spec", "production-flags", "info-tier", "forbidden", "foreshadow-ops"];

const currentFacts = (asset: StoryAssetCatalog["assets"][number]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const fact of asset.facts) if (fact.state === "current" && !out.has(fact.key)) out.set(fact.key, fact.value);
  return out;
};

export function lintStoryCards(catalog: StoryAssetCatalog, design: StoryDesignManifest | null, options: { scenesMax: number | null } = { scenesMax: null }): StoryCardFinding[] {
  const out: StoryCardFinding[] = [];
  const err = (assetId: string, code: string, message: string): void => { out.push({ code, severity: "error", assetId, message }); };
  const warn = (assetId: string, code: string, message: string): void => { out.push({ code, severity: "warning", assetId, message }); };
  const assetIds = new Set(catalog.assets.map((asset) => asset.id));
  const designEpisodes = new Map((design?.episodes ?? []).map((row) => [row.number, row]));
  const scenesMax = options.scenesMax;

  for (const asset of catalog.assets) {
    // C4：同一资产同一 key 不得并存两条 current 值（事实冲突用 disputed 建模）。
    const seen = new Map<string, number>();
    for (const fact of asset.facts) if (fact.state === "current") seen.set(fact.key, (seen.get(fact.key) ?? 0) + 1);
    for (const [key, n] of seen) if (n > 1) err(asset.id, "C4-duplicate-current", `key「${key}」有 ${n} 条 current 事实并存（冲突须用 disputed 显式建模）`);

    if (asset.type !== "episode") continue;
    const facts = currentFacts(asset);
    const isCard = CARD_MARKER_KEYS.some((key) => facts.has(key));
    if (!isCard) continue;
    const episode = /^EP(\d{3})$/.exec(asset.id) ? Number(asset.id.slice(2)) : asset.episodes?.first ?? null;
    // C1：节拍单核心事实齐备。
    const missing = CARD_REQUIRED_KEYS.filter((key) => !facts.has(key));
    if (missing.length) err(asset.id, "C1-card-incomplete", `节拍单缺 current 事实：${missing.join("、")}`);
    // C2：场数口径一致——spec「场数 N」、production-flags「共 N 场」、「拍序 A→B→C」三者互证；且 ≤ profile 上限。
    const spec = facts.get("spec") ?? ""; const flags = facts.get("production-flags") ?? "";
    const specCount = /场数\s*(\d+)(?!\s*[-–~])/.exec(spec)?.[1] ?? null;
    const flagCount = /共\s*(\d+)\s*场/.exec(flags)?.[1] ?? null;
    const order = /拍序\s*([A-Z0-9]+(?:\s*→\s*[A-Z0-9]+)+)/.exec(flags)?.[1] ?? null;
    if (specCount && flagCount && specCount !== flagCount) err(asset.id, "C2-scene-count", `spec 场数 ${specCount} 与 production-flags「共 ${flagCount} 场」不一致（YJJS-142 实测形）`);
    if (order) {
      const segments = order.split(/\s*→\s*/).filter(Boolean).length;
      const declared = Number(flagCount ?? specCount ?? NaN);
      if (Number.isFinite(declared) && segments !== declared) err(asset.id, "C2-scene-order", `拍序 ${order} 有 ${segments} 段，与声明场数 ${declared} 不一致（YJJS-142 实测形）`);
    }
    const count = Number(flagCount ?? specCount ?? NaN);
    if (scenesMax !== null && Number.isFinite(count) && count > scenesMax) err(asset.id, "C2-scene-cap", `声明场数 ${count} 超 profile 上限 ${scenesMax}`);
    // C3：具名角色声明与细纲 characterIds 一致。
    const named = /具名角色\s*(\d+)\s*[:：]([^。；;]*)/.exec(flags);
    if (named && episode !== null && designEpisodes.has(episode)) {
      const listed = [...new Set(named[2].match(/C\d{2,3}/g) ?? [])];
      const outline = designEpisodes.get(episode)!.characterIds;
      if (Number(named[1]) !== listed.length) err(asset.id, "C3-named-count", `production-flags 写具名角色 ${named[1]} 个但列出 ${listed.length} 个 ID（${listed.join(",")}）`);
      const missingIds = outline.filter((id) => !listed.includes(id)); const extraIds = listed.filter((id) => !outline.includes(id));
      if (missingIds.length || extraIds.length) err(asset.id, "C3-named-mismatch", `production-flags 具名角色 [${listed.join(",")}] 与细纲 episodes[${episode}].characterIds [${outline.join(",")}] 不符（缺 ${missingIds.join(",") || "—"}；多 ${extraIds.join(",") || "—"}）`);
    }
    // C5：卡面提到的资产 ID 应进 relations（否则 Context Pack 只能靠 optional 排序带上它——YJJS-97 的 O03 就是这样被裁掉的）。
    const mentioned = new Set<string>();
    for (const value of facts.values()) for (const m of value.match(/\b[A-Z]{1,2}\d{2,3}\b/g) ?? []) if (assetIds.has(m) && m !== asset.id) mentioned.add(m);
    const related = new Set(asset.relations.map((relation) => relation.targetId));
    const outlineRow = episode !== null ? designEpisodes.get(episode) : undefined;
    const covered = new Set([...related, ...(outlineRow?.characterIds ?? []), ...(outlineRow?.sceneIds ?? []),
      ...catalog.timeline.filter((event) => event.reveal.episode === episode).flatMap((event) => event.assetIds)]);
    const gaps = [...mentioned].filter((id) => !covered.has(id) && !/^EP\d{3}$/.test(id)).sort();
    if (gaps.length) warn(asset.id, "C5-unrelated-reference", `卡面提到 ${gaps.join("、")} 但既不在 relations、也不在本集 characterIds/sceneIds/timeline——它们只能按 optional 排序进 Context Pack，可能被裁`);
    // C6：presence（逐场在场人物）缺失只提示——arc-03 起 story-designer 设计模式必填，存量卡不追溯 fail。
    if (!facts.has("presence")) warn(asset.id, "C6-presence-missing", "节拍单无 presence（逐场在场人物清单）事实——写手调度单无法机器对照");
  }
  return out;
}
