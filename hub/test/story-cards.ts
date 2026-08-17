// 分集节拍单一致性检查（story validate A03）自测——按 arc-03 实测的卡矛盾形态各造一条回归。
import { lintStoryCards } from "../src/story-cards.ts";
import type { StoryAssetCatalog } from "../src/story-assets.ts";
import type { StoryDesignManifest } from "../src/story-design.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const fact = (key: string, value: string, state = "current") => ({ id: `F_${key}`, key, value, state, basis: "original", sourceRefs: [] });
const card = (id: string, facts: Array<ReturnType<typeof fact>>, relations: Array<{ kind: string; targetId: string }> = []) => ({
  id, type: "episode", label: id, status: "active", importance: "supporting", episodes: { first: Number(id.slice(2)), last: Number(id.slice(2)) },
  summary: "", sourceRefs: [], relations, facts, context: { agents: ["episode-writer"], priority: "required" },
});
const CORE = (over: Record<string, string> = {}) => [
  fact("premise", "x"), fact("continuity-in", "x"), fact("beats", over.beats ?? "B024 …"), fact("hook", "H4"), fact("info-tier", "x"),
  fact("forbidden", "x"), fact("foreshadow-ops", "refresh F05"),
  fact("spec", over.spec ?? "场数 3；台词每段 ≤2 sentences"),
  fact("production-flags", over.flags ?? "场景 S01＋S02，共 3 场（拍序 S01→S02→S01）。具名角色 2：C01、C03。"),
];
const catalog = (assets: unknown[], timeline: unknown[] = []): StoryAssetCatalog => ({
  version: 1, kind: "writing-loop/story-assets", project: "demo", sourcePlanId: null, storyDesignSha256: "x", revision: 1,
  assets: [...assets, { id: "F05", type: "foreshadow", label: "F05", status: "active", importance: "supporting", episodes: null, summary: "", sourceRefs: [], relations: [], facts: [], context: { agents: ["episode-writer"], priority: "optional" } },
    { id: "O03", type: "object", label: "O03", status: "active", importance: "supporting", episodes: null, summary: "", sourceRefs: [], relations: [], facts: [], context: { agents: ["episode-writer"], priority: "optional" } }],
  timeline,
} as unknown as StoryAssetCatalog);
const design = { episodes: [{ number: 23, characterIds: ["C01", "C03"], sceneIds: ["S01", "S02"] }] } as unknown as StoryDesignManifest;
const codes = (findings: ReturnType<typeof lintStoryCards>, sev = "error") => findings.filter((f) => f.severity === sev).map((f) => f.code);

ok(codes(lintStoryCards(catalog([card("EP023", CORE())]), design, { scenesMax: 3 })).length === 0, "一致的节拍单 0 error");
ok(codes(lintStoryCards(catalog([card("EP023", CORE({ spec: "场数 2；台词每段 ≤2 sentences" }))]), design, { scenesMax: 3 })).includes("C2-scene-count"),
  "YJJS-142：spec 场数 2 vs production-flags 共 3 场 ⇒ C2-scene-count");
ok(codes(lintStoryCards(catalog([card("EP023", CORE({ flags: "共 2 场（拍序 S01→S02→S01）。具名角色 2：C01、C03。" }))]), design, { scenesMax: 3 })).includes("C2-scene-order"),
  "YJJS-142：拍序三段 vs 声明 2 场 ⇒ C2-scene-order");
ok(codes(lintStoryCards(catalog([card("EP023", CORE({ spec: "场数 4", flags: "共 4 场。具名角色 2：C01、C03。" }))]), design, { scenesMax: 3 })).includes("C2-scene-cap"),
  "声明场数 4 超 profile 上限 3 ⇒ C2-scene-cap");
ok(!codes(lintStoryCards(catalog([card("EP001", CORE({ spec: "场数 1-3（序章 1 场＋正片 2 场）", flags: "场景 S08＋S01。具名角色 2：C01、C03。" }))]), { episodes: [{ number: 1, characterIds: ["C01", "C03"], sceneIds: ["S01", "S08"] }] } as unknown as StoryDesignManifest, { scenesMax: 3 })).some((c) => c.startsWith("C2")),
  "spec 写场数区间「1-3」且 flags 无「共 N 场」时不比对（EP001 既有形不误报）");
ok(codes(lintStoryCards(catalog([card("EP023", CORE({ flags: "共 3 场（拍序 S01→S02→S01）。具名角色 3：C01、C03。" }))]), design, { scenesMax: 3 })).includes("C3-named-count"),
  "具名角色写 3 个却只列 2 个 ID ⇒ C3-named-count");
ok(codes(lintStoryCards(catalog([card("EP023", CORE({ flags: "共 3 场（拍序 S01→S02→S01）。具名角色 2：C01、C06。" }))]), design, { scenesMax: 3 })).includes("C3-named-mismatch"),
  "具名角色 ID 与细纲 characterIds 不符 ⇒ C3-named-mismatch");
ok(!codes(lintStoryCards(catalog([card("EP001", CORE({ flags: "具名角色 3：C01、C02（本集仅背影）、C03。" }))]), { episodes: [{ number: 1, characterIds: ["C01", "C02", "C03"], sceneIds: ["S01"] }] } as unknown as StoryDesignManifest, { scenesMax: 3 })).some((c) => c.startsWith("C3")),
  "ID 之间夹批注「C02（本集仅背影）」仍能取全（EP001 既有形不误报）");
ok(codes(lintStoryCards(catalog([card("EP023", CORE().filter((f) => f.key !== "info-tier" && f.key !== "forbidden"))]), design, { scenesMax: 3 })).includes("C1-card-incomplete"),
  "节拍单缺 info-tier/forbidden ⇒ C1-card-incomplete");
ok(!codes(lintStoryCards(catalog([card("EP060", [fact("payoff", "x"), fact("hook", "x")])]), design, { scenesMax: 3 })).length,
  "季级锚位卡（无 beats/spec/production-flags）不按节拍单要求");
ok(codes(lintStoryCards(catalog([card("EP023", [...CORE(), fact("hook", "另一条 current")])]), design, { scenesMax: 3 })).includes("C4-duplicate-current"),
  "YJJS-97 形：同一 key 两条 current ⇒ C4-duplicate-current");
const withRef = lintStoryCards(catalog([card("EP023", CORE({ beats: "B024，木匣入 O03，纸叠 F05" }))]), design, { scenesMax: 3 });
ok(codes(withRef, "warning").includes("C5-unrelated-reference") && withRef.some((f) => f.code === "C5-unrelated-reference" && f.message.includes("O03")),
  "卡面提到 O03 但不在 relations/timeline ⇒ C5 warning（Context Pack 只能按 optional 带）");
ok(!codes(lintStoryCards(catalog([card("EP023", CORE({ beats: "木匣入 O03" }), [{ kind: "uses", targetId: "O03" }, { kind: "uses", targetId: "F05" }])]), design, { scenesMax: 3 }), "warning").includes("C5-unrelated-reference"),
  "进了 relations 的引用不再提示");
ok(codes(lintStoryCards(catalog([card("EP023", CORE())]), design, { scenesMax: 3 }), "warning").includes("C6-presence-missing")
  && !codes(lintStoryCards(catalog([card("EP023", [...CORE(), fact("presence", "23-1: 顾知行、沈炼")])]), design, { scenesMax: 3 }), "warning").includes("C6-presence-missing"),
  "缺 presence 事实只 warning；有则不提示");

console.log(fails === 0 ? "\nSTORY_CARDS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
