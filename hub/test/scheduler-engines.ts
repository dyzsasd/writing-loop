// scheduler 引擎车道自测（0.4.0 奇偶校验 + 本轮新车道）：
//   1. 0.4.0 字节奇偶校验：cli=claude/codex 默认配置（slash promptMode）下渲染的 argv
//      逐 token 不变（斜杠 prompt、flag 顺序、codex 的 opus/max→gpt-5.5/xhigh 映射）
//   2. opencode 车道：argv 形状、Claude 档位名不传 -m、provider/model 形才传 -m、
//      effort 原样 --variant（不 clamp）、dry-run 截断展示 prompt + 打印权限摘要
//   3. OPENCODE_PERMISSION 注入 spawn env：合法 JSON、wildcard-deny 基线含三处放行、
//      config scheduler.opencodePermission 整对象覆盖
//   4. inline promptMode：frontmatter 剥离、${CLAUDE_PLUGIN_ROOT} 替换为绝对路径、
//      上下文头含项目 key；claude 在 promptMode=inline 下 -p 收内联全文
//   5. --cli flag 覆盖 config（含 --cli opencode 全车道切换）
// 渲染层断言直接 import src/scheduler.ts（比 python 版的 importlib 手动装干净）；
// E2E 断言过 src/run.ts 全链路。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInlinePrompt, buildSched, fireArgv, OPENCODE_PERMISSION_DEFAULT } from "../src/scheduler.ts";
import { pluginRoot } from "../src/paths.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");

const AGENTS = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator",
  "sweep", "script-doctor", "market-watch", "reflect"];

let npass = 0, nfail = 0;
function check(desc: string, cond: boolean, extra = ""): void {
  if (cond) { npass++; console.log(`PASS ${desc}`); }
  else { nfail++; console.log(`FAIL ${desc}${extra ? `（${extra}）` : ""}`); }
}

function makeWs(overrides: Record<string, Record<string, unknown>>, schedExtra: Record<string, unknown> = {}): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "wl-eng-test.")));
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  const agents: Record<string, Record<string, unknown>> = {};
  for (const a of AGENTS) agents[a] = { enabled: false };
  Object.assign(agents, overrides);
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { ...schedExtra, agents },
    projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
  }, null, 2));
  return ws;
}

function setSchedKey(ws: string, key: string, val: unknown): void {
  const path = join(ws, ".writing-loop", "config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { scheduler: Record<string, unknown> };
  cfg.scheduler[key] = val;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function runWl(ws: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  delete env.OPENCODE_PERMISSION; // 操作者残留 export 不得影响断言（调度器本就要压过它）
  const r = spawnSync(process.execPath, [runEntry, ...args], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ledger(ws: string): unknown[] {
  try {
    return readFileSync(join(ws, ".writing-loop", "t1", "fires.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

// --dry-run 输出 ⇒ {agent: cmd 行}（agent 段首行不缩进且带 [分类]）
function dryCmds(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const ln of stdout.split("\n")) {
    if (ln && !ln.startsWith(" ") && ln.includes("[")) cur = ln.split(/\s+/)[0];
    else if (ln.trim().startsWith("cmd :") && cur) out[cur] = ln.split("cmd :")[1].trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 0.4.0 字节奇偶校验：默认配置（slash promptMode）下 claude/codex 渲染逐 token 不变
// ---------------------------------------------------------------------------
function testArgvParity040(): void {
  const project = { repoPath: "t1" };
  const sched = buildSched({ projects: { t1: project } }, "t1", project);
  let r = fireArgv(sched, "showrunner", "opus", "max", "/abs/repo", "/abs/ws/.writing-loop", "t1", null);
  check("奇偶校验：cli=claude 默认渲染 argv 与 0.4.0 逐 token 一致（斜杠 prompt、flag 顺序）",
    JSON.stringify(r.argv) === JSON.stringify([
      "claude", "-p", "/writing-loop:showrunner-agent", "--model", "opus",
      "--effort", "max", "--dangerously-skip-permissions", "--add-dir", "/abs/ws/.writing-loop",
    ]) && r.inlinePrompt === null,
    `argv=${JSON.stringify(r.argv)}`);
  sched.cli = "codex";
  r = fireArgv(sched, "showrunner", "opus", "max", "/abs/repo", "/abs/ws/.writing-loop", "t1", null);
  check("奇偶校验：cli=codex 默认渲染 argv 与 0.4.0 逐 token 一致（含 opus/max→gpt-5.5/xhigh 映射）",
    JSON.stringify(r.argv) === JSON.stringify([
      "codex", "exec", "-C", "/abs/repo", "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check", "--model", "gpt-5.5", "-c", 'model_reasoning_effort="xhigh"',
      "/writing-loop:showrunner-agent",
    ]) && r.inlinePrompt === null,
    `argv=${JSON.stringify(r.argv)}`);
}

// ---------------------------------------------------------------------------
// 2. opencode 车道（dry-run 全链路）
// ---------------------------------------------------------------------------
function testOpencodeDryRun(): void {
  const ws = makeWs({
    showrunner: { enabled: true },                                              // 默认 opus/max —— Claude 档位名
    reviewer: { enabled: true, model: "anthropic/claude-opus-4", effort: "high" }, // provider/model 形
  }, { cli: "opencode" });
  const r = runWl(ws, "--project", "t1", "--dry-run");
  const cmds = dryCmds(r.stdout);
  const sr = cmds["showrunner"] ?? "", rv = cmds["reviewer"] ?? "";
  check("opencode dry-run：rc=0 且零 spawn 零写", r.code === 0 && ledger(ws).length === 0,
    `rc=${r.code} stderr=${r.stderr.slice(-300)}`);
  const repo = join(ws, "t1");
  check("opencode：argv 以 opencode run 开头且 dry-run 打印 cwd=repo",
    sr.startsWith("opencode run") && rv.startsWith("opencode run") && r.stdout.includes(`cwd : ${repo}`),
    `sr=${sr.slice(0, 80)} rv=${rv.slice(0, 80)}`);
  check("opencode：Claude 档位名（opus）不传 -m（落 opencode 默认模型）", !` ${sr}`.includes(" -m "), `cmd=${sr.slice(0, 120)}`);
  check("opencode：provider/model 形（含 /）传 -m", rv.includes("-m anthropic/claude-opus-4"), `cmd=${rv.slice(0, 120)}`);
  check("opencode：effort 原样 --variant（max 不做 codex 的 xhigh clamp）",
    sr.includes("--variant max") && rv.includes("--variant high") && !sr.includes("xhigh"));
  check("opencode：dry-run 截断展示 prompt（120 字符 + …[N chars]）",
    sr.includes("…[") && sr.includes("chars]") && sr.includes("【writing-loop 调度器上下文】"));
  check("opencode：dry-run 打印 OPENCODE_PERMISSION 摘要", r.stdout.includes('OPENCODE_PERMISSION={"*":"deny"'));
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. OPENCODE_PERMISSION 注入 spawn env（真 spawn，command 覆盖接缝取回 env）
// ---------------------------------------------------------------------------
function testOpencodePermissionEnv(): void {
  const ws = makeWs({}, { cli: "opencode" });
  const probe = join(ws, "env_probe.mjs");
  const outPath = join(ws, "perm.txt");
  writeFileSync(probe, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.env.OPENCODE_PERMISSION ?? "MISSING");
`);
  const overrides = {
    sweep: { enabled: true, intervalSeconds: 1, capSeconds: 30, command: [process.execPath, probe, outPath] },
  };
  // 重写 agents（makeWs 只放了全禁用表）
  const cfgPath = join(ws, ".writing-loop", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { scheduler: { agents: Record<string, unknown> } };
  Object.assign(cfg.scheduler.agents, overrides);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = runWl(ws, "--project", "t1", "--once", "--agents", "sweep");
  let perm: Record<string, unknown> | null = null;
  try { perm = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>; } catch { perm = null; }
  check("OPENCODE_PERMISSION：注入 spawn env 且为合法 JSON 对象",
    r.code === 0 && perm !== null && typeof perm === "object",
    `rc=${r.code} perm=${JSON.stringify(perm)} stderr=${r.stderr.slice(-200)}`);
  check('OPENCODE_PERMISSION：默认 wildcard-deny 基线（"*":deny + 三处放行）',
    perm !== null && perm["*"] === "deny" && perm["external_directory"] === "allow"
    && perm["webfetch"] === "allow" && perm["websearch"] === "allow" && perm["question"] === "deny",
    `perm=${JSON.stringify(perm)}`);
  check("OPENCODE_PERMISSION：内建默认与规格逐键一致",
    JSON.stringify(perm) === JSON.stringify(OPENCODE_PERMISSION_DEFAULT), `perm=${JSON.stringify(perm)}`);
  const custom = { "*": "deny", bash: "allow" };
  setSchedKey(ws, "opencodePermission", custom); // 整对象覆盖，不 merge
  unlinkSync(outPath);
  runWl(ws, "--project", "t1", "--once", "--agents", "sweep");
  let perm2: unknown = null;
  try { perm2 = JSON.parse(readFileSync(outPath, "utf8")); } catch { perm2 = null; }
  check("OPENCODE_PERMISSION：config scheduler.opencodePermission 整对象覆盖生效",
    JSON.stringify(perm2) === JSON.stringify(custom), `perm2=${JSON.stringify(perm2)}`);
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. inline promptMode（单元三断言 + claude 车道 E2E）
// ---------------------------------------------------------------------------
function testInlinePrompt(): void {
  const root = pluginRoot(); // 源码态 = 仓库根（skills/ 在此）
  const p = buildInlinePrompt("sweep", "projX", "/abs/repo", "/abs/ws/.writing-loop", root);
  const sep = "─".repeat(40);
  const [header, body] = [p.slice(0, p.indexOf(sep)), p.slice(p.indexOf(sep) + sep.length)];
  check("inline：frontmatter 已剥离（正文不以 --- 开头、无 name: 行）",
    !body.trimStart().startsWith("---") && !body.includes("name: sweep-agent"));
  check("inline：${CLAUDE_PLUGIN_ROOT} 已替换为插件根绝对路径",
    !body.includes("${CLAUDE_PLUGIN_ROOT}") && body.includes(root));
  check("inline：上下文头含项目 key 与三条绝对路径",
    header.includes("【writing-loop 调度器上下文】") && header.includes("项目 key: projX")
    && header.includes("剧本 repo: /abs/repo") && header.includes("workspace 状态目录: /abs/ws/.writing-loop")
    && header.includes(root));
  // 端到端：claude 在 promptMode=inline 下 -p 收内联全文（dry-run 截断展示）
  const ws = makeWs({ showrunner: { enabled: true } }, { promptMode: "inline" });
  const r = runWl(ws, "--project", "t1", "--dry-run");
  const sr = dryCmds(r.stdout)["showrunner"] ?? "";
  check("inline：claude promptMode=inline 用内联 prompt（-p + 截断展示 + flag 不变）",
    sr.startsWith("claude -p '【writing-loop 调度器上下文】") && sr.includes("chars]")
    && sr.includes("--model opus") && sr.includes("--dangerously-skip-permissions")
    && !sr.includes("/writing-loop:showrunner-agent"),
    `cmd=${sr.slice(0, 200)}`);
  check("inline：dry-run 头行如实反映 promptMode=inline", r.stdout.includes("promptMode=inline"));
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. --cli flag 覆盖 config
// ---------------------------------------------------------------------------
function testCliFlagOverride(): void {
  const ws = makeWs({ showrunner: { enabled: true } }, { cli: "codex" }); // config 说 codex
  const r = runWl(ws, "--project", "t1", "--dry-run", "--cli", "claude");
  const sr = dryCmds(r.stdout)["showrunner"] ?? "";
  check("--cli flag 覆盖 config（codex→claude，输出如实反映）",
    r.stdout.includes("cli=claude") && sr.startsWith("claude -p /writing-loop:showrunner-agent"),
    `cmd=${sr.slice(0, 120)}`);
  const r2 = runWl(ws, "--project", "t1", "--dry-run", "--cli", "opencode");
  const sr2 = dryCmds(r2.stdout)["showrunner"] ?? "";
  check("--cli opencode：整车道切换（opencode run + 权限摘要）",
    r2.stdout.includes("cli=opencode") && sr2.startsWith("opencode run")
    && r2.stdout.includes("OPENCODE_PERMISSION="), `cmd=${sr2.slice(0, 120)}`);
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
for (const [name, fn] of [
  ["testArgvParity040", testArgvParity040],
  ["testOpencodeDryRun", testOpencodeDryRun],
  ["testOpencodePermissionEnv", testOpencodePermissionEnv],
  ["testInlinePrompt", testInlinePrompt],
  ["testCliFlagOverride", testCliFlagOverride],
] as Array<[string, () => void]>) {
  try { fn(); }
  catch (e) { nfail++; console.log(`FAIL ${name} 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`); }
}
console.log(`\ntest-scheduler-engines: ${npass} pass, ${nfail} fail${nfail === 0 ? "\nSCHEDULER_ENGINES_OK" : ""}`);
process.exit(nfail ? 1 : 0);
