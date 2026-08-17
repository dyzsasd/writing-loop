// Deterministic pre-submit lint for one episode script (`episodes/ep-NNN.md`) —— the machine half of
// script-format §3/§4/§6. It exists because arc-02/03 实测超过一半的审读门 fail 是纯格式/登记面缺陷
// （场数超上限、场景头不用注册景名、人物调度单漏登有台词的在场者、情绪前缀混入创作指令、正文集号
// 自指、direct-write 稿 frontmatter 缺 mode 行……），每一处都被 opus 审读抓出后走 revert→重写→再审。
// 这里全部是纯函数、零 LLM、零 I/O：episode-writer §15.3 自检门与 reviewer §21a-gate 第 0 项都读同一
// 结果，写手在转 In Review 前必须 0 error。叙事实质（连续性/信息位阶/保管链）不在这里判——那是审读门
// 带引文断言的事。
import { isAbsolute, join } from "node:path";
import { projectDataDir, WsError } from "./workspace.ts";

export type ScriptLintSeverity = "error" | "warning";
export type ScriptLintFinding = { code: string; severity: ScriptLintSeverity; line: number | null; message: string };

export type ScriptScene = {
  index: number;               // 场序 Y（来自场景头 X-Y）
  headerLine: number;          // 1-based
  episode: number;             // X
  location: string;            // 场景头地点整段（可含「·子景」）
  timeOfDay: string;
  interior: string;
  rosterLine: number | null;
  roster: Array<{ name: string; count: number | null; raw: string }>;
  speakers: Array<{ name: string; line: number; prefix: string | null; text: string }>;
  actionLines: number[];
  lines: Array<{ line: number; text: string }>;
};

export type ParsedEpisodeScript = {
  frontmatter: Record<string, string>;
  frontmatterEnd: number;      // 1-based line of closing ---（0 = 无 frontmatter）
  titleLine: number | null;
  titleEpisode: number | null;
  scenes: ScriptScene[];
  bodyLines: Array<{ line: number; text: string }>;
};

export type ScriptLintContext = {
  episode: number;
  scenes: Array<{ id: string; name: string; variantOf: string | null }>;   // outline 注册景
  characters: Array<{ id: string; name: string }>;                        // outline 注册具名角色
  card: { sceneIds: string[]; characterIds: string[]; hookType: string | null } | null; // outline episodes[]
  assetIds: Set<string>;                                                   // assets.v1.json 全部 asset id
  outlineHash12: string | null;                                            // 当前 outline sha256 前 12 位
  scenesMax: number;                                                       // profile 单集场数上限
  wordBand: [number, number] | null;                                       // 单集字数带（Chinese master ⇒ warning）
  sentenceCap: number | null;                                              // 台词每段句数上限（出海 profile = 2）
  directWrite: boolean | null;                                             // 票面 Mode: direct-write（null = 未知）
  presence: Map<number, string[]> | null;                                  // 卡面逐场在场人物（场序 → 名字/角色）
};

export const SCENE_HEADER_RE = /^(\d+)-(\d+)\s+(\S+)\s+(日|夜|晨|昏|黄昏|清晨|黎明|傍晚|午|夜半|拂晓)\s+(内|外|内外)\s*$/;
export const ACTION_PREFIX_RE = /^[▲△∆]/;
export const DIALOGUE_RE = /^([^▲△∆【（）：:\s][^（）：:]{0,30})（([^（）]*)）[：:]\s*(.*)$/;
export const ROSTER_RE = /^人物[：:]\s*(.*)$/;
export const TITLE_RE = /^第\s*(\d+)\s*集/;
export const HOOK_TYPES = new Set(["H0", "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8"]);
export const REQUIRED_FRONTMATTER = ["ep", "arc", "beat-card", "beat-card-hash", "hook-type", "words", "foreshadow-ops", "written-by", "model", "rules-version"];
// 情绪前缀里的创作指令残留（voice-anchor 词汇泄进对白提示——YJJS-89/90 实测形）。
export const PREFIX_INSTRUCTION_TOKENS = ["短句", "半句", "问句", "长句", "重动词", "用典", "句末", "台词", "对白", "sentences", "字以内", "以内"];

const stripCount = (raw: string): { name: string; count: number | null } => {
  const m = /^(.*?)\s*[*×x]\s*(\d+)$/.exec(raw.trim());
  return m ? { name: m[1].trim(), count: Number(m[2]) } : { name: raw.trim(), count: null };
};

export function parseEpisodeScript(text: string): ParsedEpisodeScript {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const out: ParsedEpisodeScript = { frontmatter: {}, frontmatterEnd: 0, titleLine: null, titleEpisode: null, scenes: [], bodyLines: [] };
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { out.frontmatterEnd = i + 1; i++; break; }
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (m) out.frontmatter[m[1]] = m[2].trim();
    }
    if (out.frontmatterEnd === 0) { i = 0; out.frontmatter = {}; }
  }
  let scene: ScriptScene | null = null;
  for (; i < lines.length; i++) {
    const text = lines[i]; const line = i + 1;
    if (!text.trim()) continue;
    out.bodyLines.push({ line, text });
    if (out.titleLine === null && TITLE_RE.test(text.trim()) && !scene) {
      out.titleLine = line; out.titleEpisode = Number(TITLE_RE.exec(text.trim())![1]); continue;
    }
    const h = SCENE_HEADER_RE.exec(text.trim());
    if (h) {
      scene = { index: Number(h[2]), headerLine: line, episode: Number(h[1]), location: h[3], timeOfDay: h[4], interior: h[5],
        rosterLine: null, roster: [], speakers: [], actionLines: [], lines: [] };
      out.scenes.push(scene); continue;
    }
    if (!scene) continue;
    scene.lines.push({ line, text });
    const r = ROSTER_RE.exec(text.trim());
    if (r && scene.rosterLine === null) {
      scene.rosterLine = line;
      scene.roster = r[1].split(/[、，,]/).map((s) => s.trim()).filter(Boolean).map((raw) => ({ raw, ...stripCount(raw) }));
      continue;
    }
    if (ACTION_PREFIX_RE.test(text.trim())) { scene.actionLines.push(line); continue; }
    if (/^【/.test(text.trim())) continue;   // 独立生产标注行（【插入闪回】等）
    const d = DIALOGUE_RE.exec(text.trim());
    if (d) { scene.speakers.push({ name: d[1].trim(), line, prefix: d[2].trim(), text: d[3] }); continue; }
    const bare = /^([^▲△∆【\s][^：:]{0,30})[：:]\s*(.*)$/.exec(text.trim());
    if (bare) scene.speakers.push({ name: bare[1].trim(), line, prefix: null, text: bare[2] });
  }
  return out;
}

const countSentences = (dialogue: string): number => {
  // 句号/问号/叹号（全角半角）各计一句；省略号不计；结尾无终止符的残句计一句。
  const cleaned = dialogue.replace(/[「」『』“”"'（）()【】]/g, "").trim();
  if (!cleaned) return 0;
  const terminators = cleaned.match(/[。！？!?]+/g) ?? [];
  const tail = /[。！？!?]+$/.test(cleaned) ? 0 : 1;
  return terminators.length + tail;
};

export function lintEpisodeScript(script: ParsedEpisodeScript, ctx: ScriptLintContext): ScriptLintFinding[] {
  const out: ScriptLintFinding[] = [];
  const err = (code: string, line: number | null, message: string): void => { out.push({ code, severity: "error", line, message }); };
  const warn = (code: string, line: number | null, message: string): void => { out.push({ code, severity: "warning", line, message }); };
  const fm = script.frontmatter;

  // —— L1 frontmatter（script-format §4）——
  if (script.frontmatterEnd === 0) err("L1-frontmatter", 1, "缺 YAML frontmatter（script-format §4 硬）");
  for (const key of REQUIRED_FRONTMATTER) if (!(key in fm) || fm[key] === "") err("L1-frontmatter", 1, `frontmatter 缺 \`${key}\``);
  if (fm.ep !== undefined && Number(fm.ep) !== ctx.episode) err("L1-frontmatter", 1, `frontmatter ep=${fm.ep} 与集号 ${ctx.episode} 不符`);
  if (fm["hook-type"] !== undefined && !HOOK_TYPES.has(fm["hook-type"])) err("L1-frontmatter", 1, `hook-type \`${fm["hook-type"]}\` 不在 H0–H8`);
  if (fm["hook-type"] !== undefined && ctx.card?.hookType && fm["hook-type"] !== ctx.card.hookType) {
    err("L10-hook-type", 1, `hook-type ${fm["hook-type"]} 与细纲 episodes[${ctx.episode}].hookType=${ctx.card.hookType} 不符`);
  }
  if (fm["beat-card"] !== undefined && !fm["beat-card"].endsWith(`#episode-${String(ctx.episode).padStart(3, "0")}`)) {
    err("L1-frontmatter", 1, `beat-card 应指向 story/outline.v1.json#episode-${String(ctx.episode).padStart(3, "0")}（得到 ${fm["beat-card"]}）`);
  }
  if (fm["beat-card-hash"] !== undefined && !/^[a-f0-9]{12}$/.test(fm["beat-card-hash"])) err("L1-frontmatter", 1, "beat-card-hash 须为 sha256 前 12 位十六进制");
  else if (fm["beat-card-hash"] && ctx.outlineHash12 && fm["beat-card-hash"] !== ctx.outlineHash12) {
    warn("L11-beat-card-hash", 1, `beat-card-hash ${fm["beat-card-hash"]} ≠ 当前 outline ${ctx.outlineHash12}（细纲已变，reviewer 判是否需重 stamp）`);
  }
  if (fm.words !== undefined) {
    if (!/^\d+$/.test(fm.words)) err("L1-frontmatter", 1, `words 须为整数（得到 ${fm.words}）`);
    else if (ctx.wordBand && (Number(fm.words) < ctx.wordBand[0] || Number(fm.words) > ctx.wordBand[1])) {
      warn("L9-words", 1, `words=${fm.words} 在字数带 ${ctx.wordBand[0]}–${ctx.wordBand[1]} 之外（中文母本按 YJJS-27 口径仅作参照）`);
    }
  }
  if (fm["foreshadow-ops"] !== undefined) {
    const inner = fm["foreshadow-ops"].replace(/^\[|\]$/g, "").trim();
    if (inner) for (const op of inner.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^(plant|refresh|payoff)\s+([A-Z]+\d+)$/.exec(op);
      if (!m) err("L12-foreshadow-ops", 1, `foreshadow-ops 条目 \`${op}\` 不是 \`plant|refresh|payoff <资产ID>\` 形`);
      else if (ctx.assetIds.size && !ctx.assetIds.has(m[2])) err("L12-foreshadow-ops", 1, `foreshadow-ops 引用的资产 ${m[2]} 不在 story/assets.v1.json`);
    }
  }
  if (ctx.directWrite === true && fm.mode !== "direct-write") err("L1-mode", 1, "本票为 Mode: direct-write，frontmatter 须带 `mode: direct-write`（fail 计数的机械载体）");
  if (ctx.directWrite === false && fm.mode === "direct-write") err("L1-mode", 1, "本票不是 Mode: direct-write，frontmatter 不得带 `mode: direct-write`");

  // —— L2 集标记与集号自指 ——
  if (script.titleLine === null) err("L2-title", null, "缺集标记行「第X集」（须在 frontmatter 后、首个场景头前独立一行）");
  else if (script.titleEpisode !== ctx.episode) err("L2-title", script.titleLine, `集标记「第${script.titleEpisode}集」与集号 ${ctx.episode} 不符`);
  for (const scene of script.scenes) for (const l of scene.lines) {
    if (/第\s*\d+\s*集/.test(l.text) && !/【回忆闪回\s*\d+-\d+】/.test(l.text)) err("L2-self-reference", l.line, `正文出现集号自指「${/第\s*\d+\s*集/.exec(l.text)![0]}」（YJJS-127 实测形）`);
  }

  // —— L3/L4 场景头与场数 ——
  if (script.scenes.length === 0) err("L3-scene-header", null, "没有任何合法场景头（X-Y 地点 日/夜 内/外）");
  if (script.scenes.length > ctx.scenesMax) err("L4-scene-count", script.scenes[ctx.scenesMax]?.headerLine ?? null, `场数 ${script.scenes.length} 超 profile 上限 ${ctx.scenesMax}（YJJS-141 实测形）`);
  const sceneNames = new Map<string, { id: string; variantOf: string | null }>();
  for (const s of ctx.scenes) sceneNames.set(s.name, { id: s.id, variantOf: s.variantOf });
  const cardSceneIds = new Set(ctx.card?.sceneIds ?? []);
  script.scenes.forEach((scene, k) => {
    if (scene.episode !== ctx.episode) err("L3-scene-header", scene.headerLine, `场景头 ${scene.episode}-${scene.index} 的集号 ≠ ${ctx.episode}`);
    if (scene.index !== k + 1) err("L3-scene-header", scene.headerLine, `场序应为 ${k + 1}，得到 ${scene.index}（须从 1 连续）`);
    // 注册景名前缀匹配：「沈家大院·京中寓所」「沈家大院祠堂前」都归 S01（最长前缀优先）。
    let reg: { id: string; variantOf: string | null; name: string } | null = null;
    for (const [name, meta] of sceneNames) if (scene.location.startsWith(name) && (!reg || name.length > reg.name.length)) reg = { ...meta, name };
    if (ctx.scenes.length && !reg) err("L3-scene-registry", scene.headerLine, `场景头地点「${scene.location}」不以注册景名开头（YJJS-154 实测形；注册景：${[...sceneNames.keys()].slice(0, 12).join("、")}${sceneNames.size > 12 ? "…" : ""}）`);
    else if (reg && cardSceneIds.size) {
      const rootId = reg.variantOf ?? reg.id;
      if (!cardSceneIds.has(reg.id) && !cardSceneIds.has(rootId)) err("L3-scene-budget", scene.headerLine, `景 ${reg.id}「${reg.name}」不在细纲 episodes[${ctx.episode}].sceneIds=[${[...cardSceneIds].join(",")}]（新增景须先改细纲）`);
    }
    if (scene.rosterLine === null) err("L5-roster", scene.headerLine, `场 ${scene.episode}-${scene.index} 缺「人物：」调度单（须紧跟场景头）`);
    else if (scene.lines[0]?.line !== scene.rosterLine) warn("L5-roster", scene.rosterLine, "「人物：」调度单不是场景头后的第一行");
    if (scene.rosterLine !== null && scene.roster.length === 0) err("L5-roster", scene.rosterLine, "调度单为空");
  });

  // —— L5 调度单 ↔ 有台词者；L13 具名角色 ∈ 细纲 ——
  const registeredNames = new Map(ctx.characters.map((c) => [c.name, c.id]));
  const cardCharIds = new Set(ctx.card?.characterIds ?? []);
  const baseName = (name: string): string => name.replace(/[（(].*$/, "").trim();
  for (const scene of script.scenes) {
    // 调度单名（去掉「（年长·VO）」类批注）；泛称功能角色「差役」覆盖台词里的「差役甲/乙」（项目既有已过门形）。
    const rosterBases = scene.roster.map((r) => baseName(r.name));
    const covers = (speaker: string): boolean => rosterBases.some((rb) => rb === speaker || speaker.startsWith(rb) || rb.startsWith(speaker));
    for (const sp of scene.speakers) {
      const speakerBase = baseName(sp.name);
      if (!covers(speakerBase) && !covers(sp.name)) {
        // 允许 VO/OS 的画外者以「角色（VO）」形出现在台词但不在场：仅当前缀明示 VO
        const isVo = /\bVO\b|画外/.test(sp.prefix ?? "");
        if (!isVo) err("L5-roster-speaker", sp.line, `「${sp.name}」有台词但不在场 ${scene.episode}-${scene.index} 的调度单 [${rosterBases.join("、")}]（YJJS-87/89/90 实测形）`);
      }
    }
    for (const r of scene.roster) {
      const id = registeredNames.get(baseName(r.name));
      if (id) {
        if (cardCharIds.size && !cardCharIds.has(id)) err("L13-character-budget", scene.rosterLine, `具名角色 ${baseName(r.name)}（${id}）不在细纲 episodes[${ctx.episode}].characterIds=[${[...cardCharIds].join(",")}]（超编/禁写）`);
      } else if (r.count === null && ctx.characters.length) {
        warn("L13-unregistered-name", scene.rosterLine, `调度单条目「${r.raw}」不是注册具名角色且未带 *N 人头计数（不具名功能角色建议写成「书吏*1」形；若是新具名角色须先入细纲注册表）`);
      }
    }
    if (ctx.presence && ctx.presence.has(scene.index)) {
      const expected = new Set(ctx.presence.get(scene.index)!.map((s) => stripCount(s).name));
      const got = new Set(scene.roster.map((r) => r.name));
      const missing = [...expected].filter((n) => !got.has(n)); const extra = [...got].filter((n) => !expected.has(n));
      if (missing.length || extra.length) err("L5-presence", scene.rosterLine ?? scene.headerLine, `场 ${scene.index} 调度单与卡面 presence 不符：缺 [${missing.join("、")}] 多 [${extra.join("、")}]`);
    }
  }

  // —— L6 对白：情绪前缀 100% 必带、前缀不含创作指令、句数上限 ——
  for (const scene of script.scenes) for (const sp of scene.speakers) {
    if (sp.prefix === null || sp.prefix === "") err("L6-prefix", sp.line, `「${sp.name}」台词缺情绪/动作前缀（script-format §3：100% 必带）`);
    else {
      const bad = PREFIX_INSTRUCTION_TOKENS.filter((t) => sp.prefix!.includes(t));
      if (bad.length) err("L6-prefix-instruction", sp.line, `情绪前缀「${sp.prefix}」混入创作指令词 ${bad.join("/")}（YJJS-89/90 实测形）`);
    }
    if (ctx.sentenceCap !== null && !/\bOS\b|\bVO\b/.test(sp.prefix ?? "")) {
      const n = countSentences(sp.text);
      if (n > ctx.sentenceCap) err("L6-sentences", sp.line, `台词 ${n} 句 > 上限 ${ctx.sentenceCap}（W07.dialogue-sentence-spec）：「${sp.text.slice(0, 40)}…」`);
    }
  }

  // —— L7 动作行 / 尾帧 ——
  for (const scene of script.scenes) for (const l of scene.lines) {
    if (ACTION_PREFIX_RE.test(l.text.trim()) && !/^[▲△∆]\s/.test(l.text.trim()) && l.text.trim().length > 1) warn("L7-action", l.line, "动作行前缀后建议留一空格");
  }
  const last = script.scenes.at(-1)?.lines.at(-1);
  if (last && !(ACTION_PREFIX_RE.test(last.text.trim()) && /【画面定格】/.test(last.text))) warn("L8-final-freeze", last.line, "末行不是【画面定格】动作行（N11 尾帧登记按最后一个【画面定格】求值；不是则 reviewer 判尾钩）");
  return out;
}

export function scenesMaxForFormat(format: string | null | undefined): number {
  // script-format §3 数值约束：真人短剧 1-4；AI 漫剧 1-3；出海英文 1-3。
  if (!format) return 4;
  if (/reelshort|en\b|overseas|漫剧|anime|ai-/.test(format)) return 3;
  return 4;
}

export function sentenceCapForFormat(format: string | null | undefined): number | null {
  return format && /reelshort|en\b|overseas/.test(format) ? 2 : null;
}

export function summarizeFindings(findings: ScriptLintFinding[]): { errors: number; warnings: number } {
  return { errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warning").length };
}

// 卡面 presence fact（story-designer 设计模式新增，逐场在场人物）解析：
//   "23-1: 顾知行、沈炼; 23-2: 顾知行、书吏*1; 23-3: 顾知行"（分隔符 ; 或 ；或换行）
export function parsePresenceFact(value: string, episode: number): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const seg of value.split(/[;；\n]/)) {
    const m = /^\s*(\d+)-(\d+)\s*[:：]\s*(.*?)\s*$/.exec(seg);
    if (!m || Number(m[1]) !== episode) continue;
    out.set(Number(m[2]), m[3].split(/[、，,]/).map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

export function assertLintContext(ctx: ScriptLintContext): void {
  if (!Number.isInteger(ctx.episode) || ctx.episode < 1) throw new WsError("script lint: episode 须为正整数");
  if (!Number.isInteger(ctx.scenesMax) || ctx.scenesMax < 1) throw new WsError("script lint: scenesMax 须为正整数");
}

// ticket.summary.file 是相对 board/tickets/ 的文件名——按项目运行态目录解析，与 cwd 无关
// （首版按 cwd 解析，只有在 board/tickets/ 下跑 --ticket 才成功——YJJS-118 交付评论实测）。
export function resolveTicketFile(root: string, key: string, file: string): string {
  return isAbsolute(file) ? file : join(projectDataDir(root, key), "board", "tickets", file);
}

// —— 存量豁免（waiver/baseline）——门中途启用时，门落地前已交付且项目正式裁定「不追溯改写」的
// 存量正文不该永久假红（WLSYS-4dbfc385：ep-002「淳安县衙」）。每项目一份显式、可稽核的
// `<repoPath>/.writing-loop-lint-baseline.json`：{ "version": 1, "entries": [ { "episode": 2,
// "code": "L3-scene-registry", "match": "淳安县衙", "ticketId": "YJJS-154", "reason": "…", "recordedAt": ISO } ] }。
// 精确命中（同集 + 同 code + message 含 match）的 finding 降级为 warning 并标 `WAIVED by <ticketId>`；
// 只豁免登记的那一条，不豁免同 code 的其他命中；写入者 = showrunner/操作者（裁定级动作）。
export type ScriptLintWaiver = { episode: number; code: string; match: string; ticketId: string; reason: string; recordedAt: string };
export const LINT_BASELINE_RELATIVE_PATH = ".writing-loop-lint-baseline.json";

export function parseLintBaseline(value: unknown): ScriptLintWaiver[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WsError("lint baseline 必须是对象");
  const root = value as Record<string, unknown>;
  if (root.version !== 1) throw new WsError("lint baseline version 必须是 1");
  if (!Array.isArray(root.entries)) throw new WsError("lint baseline entries 必须是数组");
  return root.entries.map((row, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new WsError(`lint baseline entries[${index}] 必须是对象`);
    const entry = row as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!["episode", "code", "match", "ticketId", "reason", "recordedAt"].includes(key)) throw new WsError(`lint baseline entries[${index}] 含未知字段 '${key}'`);
    if (!Number.isInteger(entry.episode) || (entry.episode as number) < 1) throw new WsError(`lint baseline entries[${index}].episode 须为正整数`);
    for (const key of ["code", "match", "ticketId", "reason", "recordedAt"]) {
      if (typeof entry[key] !== "string" || !(entry[key] as string).trim()) throw new WsError(`lint baseline entries[${index}].${key} 须为非空字符串`);
    }
    if (Number.isNaN(Date.parse(entry.recordedAt as string))) throw new WsError(`lint baseline entries[${index}].recordedAt 须为 ISO 时间`);
    return { episode: entry.episode as number, code: entry.code as string, match: entry.match as string,
      ticketId: entry.ticketId as string, reason: entry.reason as string, recordedAt: entry.recordedAt as string };
  });
}

export function applyLintBaseline(findings: ScriptLintFinding[], episode: number, waivers: ScriptLintWaiver[]): ScriptLintFinding[] {
  return findings.map((finding) => {
    if (finding.severity !== "error") return finding;
    const waiver = waivers.find((row) => row.episode === episode && row.code === finding.code && finding.message.includes(row.match));
    return waiver ? { ...finding, severity: "warning", message: `${finding.message} —— WAIVED by ${waiver.ticketId}（${waiver.reason}）` } : finding;
  });
}
