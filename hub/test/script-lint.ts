// script lint 自测：用 arc-02/03 实测的 fail 形态各造一条回归（票号见断言名），外加「既有已过门写法不误报」。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLintBaseline, lintEpisodeScript, parseEpisodeScript, parseLintBaseline, parsePresenceFact, resolveTicketFile,
  scenesMaxForFormat, sentenceCapForFormat, ticketDirectWrite, type ScriptLintContext } from "../src/script-lint.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FM = (extra = ""): string => `---
ep: 23
arc: arc-03
beat-card: story/outline.v1.json#episode-023
beat-card-hash: 96a90a3921ce
hook-type: H4
words: 598
foreshadow-ops: [refresh F05, plant F40]
written-by: episode-writer (run 38d7)
model: claude-sonnet-5/high
rules-version: craft-rules@1 script-format@1
${extra}---
`;
const BODY_OK = `第23集（悬笔）

23-1 沈家大院·京中寓所 夜 内
人物：顾知行、沈炼
▲ 【画面定格】炭盆归位。
▲ 【字幕：半月后】
沈炼（不看他，落笔）：今夜写完，明日就发。
顾知行（对读，劝）：一条不改，他们照样能把您办成大逆。
沈炼（低声，不看他）：输的人也要有人替他记一笔。我自己记。

23-2 官署公堂·封发一角 夜 内
人物：顾知行、书吏*1
▲ 顾知行把两份誊清稿交给书吏。
书吏（低声）：一份走通政司，一份走六科，当夜就发。

23-3 沈家大院·京中寓所 夜 内
人物：顾知行
▲ 【画面定格】他的手停在誊纸上，笔尖悬着。
`;
const ctx = (over: Partial<ScriptLintContext> = {}): ScriptLintContext => ({
  episode: 23,
  scenes: [{ id: "S01", name: "沈家大院", variantOf: null }, { id: "S02", name: "官署公堂", variantOf: null }, { id: "S03", name: "玉京金殿", variantOf: null }],
  characters: [{ id: "C01", name: "顾知行" }, { id: "C03", name: "沈炼" }, { id: "C06", name: "严世蕃" }, { id: "C02", name: "谢蘅秋" }],
  card: { sceneIds: ["S01", "S02"], characterIds: ["C01", "C03"], hookType: "H4" },
  assetIds: new Set(["F05", "F40", "O03", "EP023"]),
  outlineHash12: "96a90a3921ce",
  scenesMax: 3, wordBand: [500, 800], sentenceCap: 2, directWrite: false, presence: null, ...over,
});
const run = (text: string, over: Partial<ScriptLintContext> = {}) => lintEpisodeScript(parseEpisodeScript(text), ctx(over));
const errors = (text: string, over: Partial<ScriptLintContext> = {}) => run(text, over).filter((f) => f.severity === "error");
const codes = (text: string, over: Partial<ScriptLintContext> = {}) => errors(text, over).map((f) => f.code);

// 解析核
const parsed = parseEpisodeScript(FM() + BODY_OK);
ok(parsed.frontmatter.ep === "23" && parsed.titleEpisode === 23 && parsed.scenes.length === 3, "解析：frontmatter/集标记/三场景");
ok(parsed.scenes[1].roster.map((r) => `${r.name}:${r.count}`).join(",") === "顾知行:null,书吏:1", "解析：调度单含 *N 人头计数");
ok(parsed.scenes[0].speakers.length === 3 && parsed.scenes[0].speakers[0].prefix === "不看他，落笔", "解析：台词与情绪前缀");

// 干净稿 0 error（ep-023 过门稿骨架）
ok(errors(FM() + BODY_OK).length === 0, `干净稿 0 error（${errors(FM() + BODY_OK).map((f) => f.code + ":" + f.message).join(" | ")}）`);

// YJJS-141：场数 4 超上限 3
const four = FM() + BODY_OK + `\n23-4 沈家大院 夜 内\n人物：顾知行\n▲ 【画面定格】他起身。\n`;
ok(codes(four).includes("L4-scene-count"), "YJJS-141：场数 4 > 上限 3 ⇒ L4-scene-count");
ok(!codes(four, { scenesMax: 4 }).includes("L4-scene-count"), "真人 profile 上限 4 时同稿不报");

// YJJS-154：场景头不以注册景名开头
ok(codes(FM() + BODY_OK.replace("23-2 官署公堂·封发一角", "23-2 官署封发一角")).includes("L3-scene-registry"), "YJJS-154：「官署封发一角」不以注册景名开头 ⇒ L3-scene-registry");
ok(!codes(FM() + BODY_OK.replace("23-1 沈家大院·京中寓所", "23-1 沈家大院祠堂前")).includes("L3-scene-registry"), "既有已过门形「沈家大院祠堂前」按最长前缀归 S01，不误报");
ok(codes(FM() + BODY_OK.replace("23-2 官署公堂·封发一角", "23-2 玉京金殿")).includes("L3-scene-budget"), "注册景 S03 不在细纲 sceneIds ⇒ L3-scene-budget（新增景须先改细纲）");

// YJJS-87/89/90：有台词者不在调度单
ok(codes(FM() + BODY_OK.replace("人物：顾知行、书吏*1", "人物：顾知行")).includes("L5-roster-speaker"), "YJJS-90：书吏有台词却不在调度单 ⇒ L5-roster-speaker");
const generic = FM() + BODY_OK.replace("人物：顾知行、书吏*1", "人物：顾知行、差役").replace("书吏（低声）", "差役甲（低声）");
ok(!codes(generic).includes("L5-roster-speaker"), "既有已过门形：调度单泛称「差役」覆盖台词「差役甲」，不误报");
ok(!codes(FM() + BODY_OK.replace("人物：顾知行、沈炼", "人物：顾知行、沈炼、谢蘅秋（年长·VO）"), { card: { sceneIds: ["S01", "S02"], characterIds: ["C01", "C03", "C02"], hookType: "H4" } }).includes("L13-character-budget"),
  "调度单带批注「谢蘅秋（年长·VO）」按基名识别注册角色");
ok(codes(FM() + BODY_OK.replace("人物：顾知行、沈炼", "人物：顾知行、沈炼、严世蕃")).includes("L13-character-budget"), "注册角色严世蕃不在细纲 characterIds ⇒ L13-character-budget（超编/禁写）");
ok(run(FM() + BODY_OK.replace("人物：顾知行、书吏*1", "人物：顾知行、书吏")).some((f) => f.code === "L13-unregistered-name" && f.severity === "warning"),
  "不具名角色未带 *N ⇒ 只 warning（arc-01/02 既有过门写法不追溯 fail）");

// YJJS-89/90：情绪前缀混入创作指令
ok(codes(FM() + BODY_OK.replace("沈炼（不看他，落笔）", "沈炼（短句，不看他）")).includes("L6-prefix-instruction"), "YJJS-89：前缀含「短句」⇒ L6-prefix-instruction");
ok(codes(FM() + BODY_OK.replace("书吏（低声）：", "书吏：")).includes("L6-prefix"), "无情绪前缀的对白 ⇒ L6-prefix");
ok(codes(FM() + BODY_OK.replace("今夜写完，明日就发。", "今夜写完。明日就发。发了就走。")).includes("L6-sentences"), "台词 3 句 > 出海 profile 上限 2 ⇒ L6-sentences");
ok(!codes(FM() + BODY_OK.replace("今夜写完，明日就发。", "今夜写完。明日就发。发了就走。"), { sentenceCap: null }).includes("L6-sentences"), "无句数上限的 profile 不报");

// YJJS-127：正文集号自指
ok(codes(FM() + BODY_OK.replace("▲ 顾知行把两份誊清稿交给书吏。", "▲ 顾知行想起第21集那夜。")).includes("L2-self-reference"), "YJJS-127：正文出现「第21集」⇒ L2-self-reference");
ok(!codes(FM() + BODY_OK.replace("▲ 顾知行把两份誊清稿交给书吏。", "【回忆闪回 21-3】")).includes("L2-self-reference"), "场号引用闪回标签不算自指");

// YJJS-157：direct-write 票 frontmatter 缺 mode
ok(codes(FM() + BODY_OK, { directWrite: true }).includes("L1-mode"), "YJJS-157：Mode: direct-write 票缺 `mode: direct-write` ⇒ L1-mode");
ok(!codes(FM("mode: direct-write\n") + BODY_OK, { directWrite: true }).includes("L1-mode"), "带 mode 行的 direct-write 稿通过");
ok(codes(FM("mode: direct-write\n") + BODY_OK, { directWrite: false }).includes("L1-mode"), "非 direct-write 票却带 mode 行 ⇒ L1-mode");

// —— WLSYS-352989e：L1-mode 的 directWrite 只可由「本集出稿票」裁定 ——
// 修复前 script.ts 用 `/^Mode: direct-write/.test(--ticket 票体)` 从任意票求 directWrite：拿一集
// direct-write 正文用其 continuity Bug 复核票（无裸 `episode` 标签、有 `Episode:` 行、无 Mode 行）去 lint 时，
// 旧逻辑求得 directWrite=false ⇒ 对带 `mode: direct-write` 的正文误报 L1-mode（回炉重写→再审空转）。
// 出稿票判据：labels 含裸 `episode` 标签 ∧ 票体 `Episode: N` == 本集号（tests 上文 FM 集号=23）。
const DW_ISSUE_TICKET = "labels: [writing-loop, Feature, episode, continuity, reviewer, story-designer]\nEpisode: 23\nMode: direct-write\n";
const PLAIN_ISSUE_TICKET = "labels: [writing-loop, Feature, episode, reviewer, episode-writer]\nEpisode: 23\n";
const BUG_REVIEW_TICKET = "labels: [writing-loop, Bug, continuity, reviewer, episode-writer]\nEpisode: 23\n";
const PUNCHUP_TICKET = "labels: [writing-loop, Improvement, punch-up, showrunner, story-designer]\n";
ok(ticketDirectWrite(DW_ISSUE_TICKET, 23) === true, "出稿票（labels∋episode ∧ Episode:23 ∧ Mode: direct-write）⇒ directWrite=true");
ok(ticketDirectWrite(PLAIN_ISSUE_TICKET, 23) === false, "出稿票（非 direct-write）⇒ directWrite=false（真检保留）");
ok(ticketDirectWrite(BUG_REVIEW_TICKET, 23) === null, "单集 Bug 复核票（无裸 episode 标签）⇒ null（跳过 L1-mode；修复前求得 false ⇒ 对 DW 集假阳性）");
ok(ticketDirectWrite(PUNCHUP_TICKET, 23) === null, "arc punch-up 票（无 Episode: 行）⇒ null（修复前求得 false）");
ok(ticketDirectWrite(DW_ISSUE_TICKET, 24) === null, "出稿票 Episode(23)≠lint集号(24) ⇒ null（别集票不裁定本集 mode）");
ok(!codes(FM("mode: direct-write\n") + BODY_OK, { directWrite: ticketDirectWrite(BUG_REVIEW_TICKET, 23) }).includes("L1-mode"),
  "全链路：direct-write 正文以复核票 lint ⇒ L1-mode 跳过（假阳性消解；修复前 directWrite=false ⇒ 误报）");

// frontmatter / 细纲一致性
ok(codes(FM().replace("hook-type: H4", "hook-type: H1") + BODY_OK).includes("L10-hook-type"), "hook-type 与细纲 hookType 不符 ⇒ L10-hook-type");
ok(codes(FM().replace("plant F40", "plant F99") + BODY_OK).includes("L12-foreshadow-ops"), "foreshadow-ops 引用不存在的资产 ⇒ L12-foreshadow-ops");
ok(codes(FM().replace("words: 598\n", "") + BODY_OK).includes("L1-frontmatter"), "frontmatter 缺 words ⇒ L1-frontmatter");
ok(codes(FM() + BODY_OK.replace("第23集（悬笔）", "第24集（悬笔）")).includes("L2-title"), "集标记集号不符 ⇒ L2-title");
ok(codes(FM() + BODY_OK.replace("23-2 官署公堂·封发一角", "23-3 官署公堂·封发一角")).includes("L3-scene-header"), "场序不连续 ⇒ L3-scene-header");
ok(run(FM().replace("96a90a3921ce", "aaaaaaaaaaaa") + BODY_OK).some((f) => f.code === "L11-beat-card-hash" && f.severity === "warning"), "beat-card-hash 与当前 outline 不同 ⇒ warning（reviewer 判是否重 stamp）");
ok(run(FM().replace("words: 598", "words: 900") + BODY_OK).some((f) => f.code === "L9-words" && f.severity === "warning"), "words 出字数带 ⇒ warning（中文母本仅参照）");

// 卡面 presence（story-designer 新增逐场在场人物）
const presence = parsePresenceFact("23-1: 顾知行、沈炼; 23-2: 顾知行、书吏*1; 23-3: 顾知行", 23);
ok(presence.size === 3 && presence.get(2)!.join(",") === "顾知行,书吏*1", "presence fact 解析");
ok(!codes(FM() + BODY_OK, { presence }).includes("L5-presence"), "调度单与 presence 一致 ⇒ 不报");
ok(codes(FM() + BODY_OK.replace("人物：顾知行、沈炼", "人物：顾知行"), { presence }).includes("L5-presence"), "调度单缺 presence 所列在场者 ⇒ L5-presence");

// profile 推导
ok(scenesMaxForFormat("reelshort-en") === 3 && scenesMaxForFormat("cn-live") === 4 && sentenceCapForFormat("reelshort-en") === 2 && sentenceCapForFormat("cn-live") === null, "profile 推导：出海 3 场/2 句，真人 4 场/无句上限");

// --ticket 路径解析与 cwd 无关（YJJS-118 实测：首版按 cwd 解析，只在 board/tickets/ 下可用）
ok(resolveTicketFile("/ws", "demo", "YJJS-118.md") === join("/ws", ".writing-loop", "demo", "board", "tickets", "YJJS-118.md")
  && resolveTicketFile("/ws", "demo", "/abs/x.md") === "/abs/x.md", "--ticket 文件按 <workspace>/.writing-loop/<key>/board/tickets/ 解析，绝对路径原样");

// 存量豁免（WLSYS-4dbfc385）：门落地前已交付且裁定不追溯改写的正文，登记 baseline 后精确命中降为 WAIVED warning
const waivers = parseLintBaseline({ version: 1, entries: [{ episode: 23, code: "L3-scene-registry", match: "官署封发一角", ticketId: "YJJS-154", reason: "裁定不追溯", recordedAt: "2026-08-17T00:00:00Z" }] });
const legacy = run(FM() + BODY_OK.replace("23-2 官署公堂·封发一角", "23-2 官署封发一角"));
const waived = applyLintBaseline(legacy, 23, waivers);
ok(legacy.some((f) => f.code === "L3-scene-registry" && f.severity === "error") && waived.every((f) => f.code !== "L3-scene-registry" || (f.severity === "warning" && f.message.includes("WAIVED by YJJS-154"))),
  "baseline 精确命中 ⇒ 降级 warning 并标 WAIVED by 票号");
ok(applyLintBaseline(legacy, 24, waivers).some((f) => f.code === "L3-scene-registry" && f.severity === "error"), "baseline 只豁免登记的那一集，不跨集");
ok(applyLintBaseline(run(FM() + BODY_OK.replace("23-2 官署公堂·封发一角", "23-2 别处")), 23, waivers).some((f) => f.code === "L3-scene-registry" && f.severity === "error"), "同 code 但 match 不同的命中不豁免");
let threw = false; try { parseLintBaseline({ version: 1, entries: [{ episode: 2, code: "X" }] }); } catch { threw = true; }
ok(threw, "baseline 缺字段报错，不静默");

const help = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "script", "lint", "--help"], { encoding: "utf8" });
ok(help.status === 0 && help.stdout.includes("script lint --project"), "CLI：writing-loop script lint --help 可用");

console.log(fails === 0 ? "\nSCRIPT_LINT_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
