// 规约节选内联自测（2026-08-25「上下文三刀」①②）：Sections 解析、code-fence 感知切节、
// 逐字提取、字节稳定、门控命中枝恒附在常量段之后（缓存前缀不被变量内容打断）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConventionsDigest, buildInlinePrompt, DEFAULT_SKILL_SECTIONS, fireArgv,
  gateReasonsTail, parseSkillSections, splitConventionsSections, buildSched,
} from "../src/scheduler.ts";
import type { WlConfig, WlProject } from "../src/workspace.ts";

let fails = 0;
const ok = (c: boolean, m: string, extra = ""): void => {
  console.log((c ? "PASS " : "FAIL ") + m + (c || !extra ? "" : `（${extra}）`));
  if (!c) fails++;
};
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── parseSkillSections ──────────────────────────────────────────────────────
ok(parseSkillSections("blah\nSections: §0 §0a §21a-gate §24b\n").join(",") === "0,0a,21a-gate,24b",
  "Sections 行解析：剥 § 前缀、保序");
ok(parseSkillSections("没有清单的散文 SKILL").join(",") === DEFAULT_SKILL_SECTIONS.join(","),
  "无 Sections 行 ⇒ 保守默认集（source-analyst 形）");

// ── splitConventionsSections（合成文档：fence 感知 + 非 § 子标题不断节）────────
{
  const doc = [
    "# 大标题", "导语一行", "",
    "## §0. 首要指令", "零节内容",
    "```", "## §99. fence 里的假标题——不得断节", "```",
    "零节继续",
    "### §0a. 标准 boot", "0a 内容",
    "## §11. 配置", "11 内容",
    "### Workspace 根与状态目录", "子标题内容随 §11 走",
    "## §21a-light. 轻通道", "light 内容",
  ].join("\n");
  const m = splitConventionsSections(doc);
  ok((m.get("__preamble__") ?? "").includes("导语一行"), "首个 § 前的导语归 __preamble__");
  ok((m.get("0") ?? "").includes("fence 里的假标题") && (m.get("0") ?? "").includes("零节继续")
    && !m.has("99"), "code-fence 内的标题行不断节");
  ok((m.get("11") ?? "").includes("子标题内容随 §11 走"), "非 § 子标题不断节、随父节走");
  ok(m.has("21a-light") && (m.get("21a-light") ?? "").includes("light 内容"), "带连字符的节 id（21a-light）可切");
}

// ── buildConventionsDigest（真文件）─────────────────────────────────────────
{
  const conv = readFileSync(join(hubRoot, "references", "conventions.md"), "utf8");
  const dRev = buildConventionsDigest(hubRoot, "reviewer");
  const dWriter = buildConventionsDigest(hubRoot, "episode-writer");
  ok(dRev.includes("§21a-gate") && dRev.includes("§0a"), "reviewer 节选含其 Sections 节（§21a-gate/§0a）");
  ok(dRev.length > 40_000 && dRev.length < conv.length, "reviewer 节选是真子集（>40KB 且 < 全文）",
    `len=${dRev.length}`);
  ok(!dWriter.includes("## §13."), "episode-writer 节选不含未列节 §13（首跑安装）");
  ok(dWriter.includes("§21a-episode"), "episode-writer 节选含 §21a-episode");
  // 逐字：节选中任取 §15 标题行后的首 200 字符必须逐字出现在原文
  const i = dWriter.indexOf("## §15.");
  ok(i >= 0 && conv.includes(dWriter.slice(i, i + 200)), "节选内容与原文逐字一致（§15 抽查）");
  ok(buildConventionsDigest(hubRoot, "reviewer") === dRev, "同一 agent 两次构建字节恒等（memo + 稳定）");
}

// ── prompt 装配顺序：常量段（header+skill+节选）→ 变量尾巴（门控命中枝）────────
{
  const p1 = buildInlinePrompt("sweep", "k1", "/r", "/d", hubRoot);
  const p2 = buildInlinePrompt("sweep", "k1", "/r", "/d", hubRoot);
  ok(p1 === p2, "inline prompt 跨调用字节恒等（缓存前缀基础）");
  ok(p1.includes("【规约节选】") && p1.indexOf("【规约节选】") > p1.indexOf("─".repeat(40)),
    "规约节选块在 skill 正文之后");
  // header 本身有意提及占位符字面量（向 agent 解释含义）——只对节选块断言已替换
  const digestPart = p1.slice(p1.indexOf("【规约节选】"));
  ok(!digestPart.includes("${CLAUDE_PLUGIN_ROOT}"), "节选块内 ${CLAUDE_PLUGIN_ROOT} 已替换为绝对路径");
  ok(gateReasonsTail(null) === "" && gateReasonsTail([]) === "", "无命中枝 ⇒ 空尾巴（prompt 保持纯常量）");
  const tail = gateReasonsTail(["∃ Todo+episode-writer（T-1）"]);
  ok(tail.includes("门控命中枝") && tail.includes("重验"), "命中枝尾巴带 §0 重验提示");
  // fireArgv 全链：inline 模式 + 命中枝 ⇒ 常量前缀完全一致、变量只在末尾
  const cfg = { version: 1, projects: { t1: { title: "x", repoPath: "t1" } } } as unknown as WlConfig;
  const proj = { title: "x", repoPath: "t1" } as unknown as WlProject;
  const sched = buildSched(cfg, "t1", proj);
  sched.promptMode = "inline";
  const a = fireArgv(sched, "sweep", "sonnet", "low", "/r", "/d", "t1", hubRoot, {}, null);
  const b = fireArgv(sched, "sweep", "sonnet", "low", "/r", "/d", "t1", hubRoot, {}, ["枝一", "枝二"]);
  const pa = a.inlinePrompt ?? "", pb = b.inlinePrompt ?? "";
  ok(pb.startsWith(pa), "带命中枝的 prompt 以无命中枝版本为前缀（变量恒在常量之后）");
  ok(pb.includes("- 枝一") && pb.includes("- 枝二"), "命中枝逐条列出");
}

console.log(fails === 0 ? "\nINLINE_DIGEST_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
