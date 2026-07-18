// scheduler（wl-run）端到端自测 —— 0.4.0 scripts/test-wl-run.py 的 23 项检查一比一移植
// （用例名 test_* → 同名 TS 函数；假 agent 从 python 脚本换成 node 脚本，其余语义逐条保真）。
// 每个用例起一个独立临时 workspace + 假 agent 命令（scheduler.agents.<a>.command 测试接缝，
// 真 subprocess 全链路），覆盖：
//   1. 间隔触发 + fires.jsonl 行 + no-op 尾行检测（§0 的一行 no-op 收尾）
//   2. 写者全局单飞（时间戳 marker 文件证明两写者从不重叠）+ 板上 ≤2 并发
//      + 写者×板上确有并发（WL-55 的结构性解）
//   3. capSeconds 超时 TERM→KILL（进程组真被杀，无游魂）
//   4. keystone 升档（播种 In Review+keystone 假板 ⇒ reviewer fire 换 keystoneReviewer 档）
//   5. --dry-run 零 spawn 零写（且 claude 默认命令形完整解析）
//   6. --plan 只模拟不 spawn
//   7. wl-run.lock 防重跑（board-lock choreography：在位即拒起；跑完释放）
// 引擎车道/权限/inline prompt 的新用例在 test/scheduler-engines.ts。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");

const AGENTS = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator",
  "sweep", "script-doctor", "market-watch", "reflect"];
const WRITERS = new Set(["showrunner", "story-designer", "episode-writer", "evaluator"]);

// 假 agent（node 版，语义同 python 版）：markers 文件记 start/end/msg 三类行，可指定睡眠秒数。
const FAKE_AGENT = `import { appendFileSync } from "node:fs";
const [markers, agent, sleepS, ...msgParts] = process.argv.slice(2);
const msg = msgParts.join(" ");
const w = (line) => appendFileSync(markers, line + "\\n");
w(\`start \${agent} \${Date.now() / 1000}\`);
await new Promise((r) => setTimeout(r, parseFloat(sleepS) * 1000));
w(\`end \${agent} \${Date.now() / 1000}\`);
if (msg) w(\`msg \${agent} \${msg}\`);
console.log(msg || "done");
`;

let npass = 0, nfail = 0;
function check(desc: string, cond: boolean, extra = ""): void {
  if (cond) { npass++; console.log(`PASS ${desc}`); }
  else { nfail++; console.log(`FAIL ${desc}${extra ? `（${extra}）` : ""}`); }
}

type AgentOverride = Record<string, unknown>;

// 临时 workspace：.writing-loop/config.json + 项目 repo 目录 t1/ + 假 agent 脚本。
// agentOverrides: {agent: 覆盖块}；未提及的 agent 一律 enabled:false。
function makeWs(agentOverrides: Record<string, AgentOverride>, schedExtra: Record<string, unknown> = {}): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "wl-run-test.")));
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  writeFileSync(join(ws, "fake_agent.mjs"), FAKE_AGENT);
  rewriteAgents(ws, agentOverrides, schedExtra);
  return ws;
}

function rewriteAgents(ws: string, overrides: Record<string, AgentOverride>, schedExtra?: Record<string, unknown>): void {
  const path = join(ws, ".writing-loop", "config.json");
  let cfg: { scheduler?: Record<string, unknown> };
  try { cfg = JSON.parse(readFileSync(path, "utf8")); }
  catch {
    cfg = {
      version: 1, scheduler: {},
      projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
    } as never;
  }
  const agents: Record<string, AgentOverride> = {};
  for (const a of AGENTS) agents[a] = { enabled: false };
  Object.assign(agents, overrides);
  cfg.scheduler = { ...(cfg.scheduler ?? {}), ...(schedExtra ?? {}), agents };
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

function fakeCmd(ws: string, sleepS: number, ...extra: string[]): string[] {
  return [process.execPath, join(ws, "fake_agent.mjs"), join(ws, "markers.txt"), "{agent}", String(sleepS), ...extra];
}

function runWl(ws: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE; // 测试机残留的 env 不得影响解析
  const r = spawnSync(process.execPath, [runEntry, ...args], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

type Row = {
  agent: string; model: string; effort: string; startedAt: string; endedAt: string;
  durationSeconds: number; exitCode: number | null; timedOut: boolean; noop: boolean;
  keystoneEscalated: boolean; spawnError?: string;
};
function ledger(ws: string): Row[] {
  try {
    return readFileSync(join(ws, ".writing-loop", "t1", "fires.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
  } catch { return []; }
}

type Mark = { kind: string; agent: string; t: number; text: string };
function markers(ws: string): Mark[] {
  let raw: string;
  try { raw = readFileSync(join(ws, "markers.txt"), "utf8"); } catch { return []; }
  const out: Mark[] = [];
  for (const ln of raw.split("\n")) {
    const parts = ln.split(" ");
    if (parts.length < 3) continue;
    const [kind, agent, ...rest] = parts;
    out.push({ kind, agent, t: kind === "msg" ? 0 : Number(rest[0]), text: rest.join(" ") });
  }
  return out;
}

type Span = { agent: string; s: number; e: number };
function spans(marks: Mark[]): Span[] {
  // 按 agent 配对 start/end ⇒ [(agent, s, e)]（时间序配对）
  const starts = new Map<string, number[]>();
  const out: Span[] = [];
  for (const m of marks) {
    if (m.kind === "start") {
      if (!starts.has(m.agent)) starts.set(m.agent, []);
      starts.get(m.agent)!.push(m.t);
    } else if (m.kind === "end") {
      out.push({ agent: m.agent, s: starts.get(m.agent)!.shift()!, e: m.t });
    }
  }
  return out;
}

const overlaps = (a: Span, b: Span, eps = 0.05): boolean => a.s < b.e - eps && b.s < a.e - eps;

const validTs = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s));

function seedKeystoneTicket(ws: string, state = "In Review"): void {
  const tdir = join(ws, ".writing-loop", "t1", "board", "tickets");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, "WL-1.md"),
    `---\nid: WL-1\ntitle: ep-003 keystone\ntype: Feature\nstate: ${state}\nowner: reviewer\n` +
    `labels: [writing-loop, Feature, episode, keystone, reviewer, episode-writer]\n---\n\nbody\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

function testIntervalNoopLedger(): void {
  const ws = makeWs({});
  rewriteAgents(ws, {
    showrunner: { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws, 0.2, "working") },
    sweep: { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws, 0, "本 lane 无活 —— no-op") },
  });
  const r = runWl(ws, "--project", "t1", "--for", "4");
  const rows = ledger(ws);
  const sr = rows.filter((x) => x.agent === "showrunner");
  const sw = rows.filter((x) => x.agent === "sweep");
  check("间隔触发：4s 窗内 showrunner ≥2 次 fire", sr.length >= 2,
    `得 ${sr.length}；rc=${r.code} stderr=${r.stderr.slice(-300)}`);
  check("间隔触发：sweep ≥2 次 fire", sw.length >= 2, `得 ${sw.length}`);
  check("wl-run 优雅退出 rc=0", r.code === 0, `rc=${r.code}`);
  check("ledger：sweep 尾行 no-op 被检出", sw.length > 0 && sw.every((x) => x.noop));
  check("ledger：showrunner 非 no-op", sr.length > 0 && !sr.some((x) => x.noop));
  check("ledger：exitCode 0 / timedOut false", rows.every((x) => x.exitCode === 0 && !x.timedOut));
  const okTs = rows.every((x) => validTs(x.startedAt) && validTs(x.endedAt) && Date.parse(x.startedAt) <= Date.parse(x.endedAt));
  check("ledger：launcher 时钟时间戳可解析且 startedAt≤endedAt", okTs);
  rmSync(ws, { recursive: true, force: true });
}

function testSingleFlight(): void {
  const ws = makeWs({});
  const overrides: Record<string, AgentOverride> = {};
  for (const a of ["showrunner", "story-designer", "episode-writer",   // 写者 3 名
    "reviewer", "sweep", "market-watch"]) {                            // 板上 3 名（争 2 槽）
    overrides[a] = { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws, 0.7) };
  }
  rewriteAgents(ws, overrides);
  const r = runWl(ws, "--project", "t1", "--for", "6");
  const sp = spans(markers(ws));
  const wSp = sp.filter((x) => WRITERS.has(x.agent));
  const bSp = sp.filter((x) => !WRITERS.has(x.agent));
  let noWriterOverlap = true;
  for (let i = 0; i < wSp.length; i++) {
    for (let j = i + 1; j < wSp.length; j++) if (overlaps(wSp[i], wSp[j])) noWriterOverlap = false;
  }
  const writerNames = new Set(wSp.map((x) => x.agent));
  check(`单飞：任意两个写者 fire 从不重叠（${wSp.length} 个写者 span，≥2 名写者）`,
    wSp.length >= 3 && writerNames.size >= 2 && noWriterOverlap,
    `rc=${r.code} 写者=${[...writerNames].sort().join(",")}`);
  let boardMax = 0;
  for (const x of bSp) {
    boardMax = Math.max(boardMax, bSp.filter((y) => y === x || overlaps(x, y)).length);
  }
  check(`板上并发 ≤2（实测最大 ${boardMax}）`, boardMax > 0 && boardMax <= 2);
  const cross = wSp.some((w) => bSp.some((b) => overlaps(w, b)));
  check("写者×板上确有并发（板上不被写者单飞饿死）", cross && bSp.length >= 3, `板上 span=${bSp.length}`);
  rmSync(ws, { recursive: true, force: true });
}

async function testCapTimeoutKill(): Promise<void> {
  const ws = makeWs({});
  const canary = `wlrun-canary-${process.pid}`;
  rewriteAgents(ws, {
    showrunner: { enabled: true, intervalSeconds: 1, capSeconds: 1, command: fakeCmd(ws, 30, canary) },
  });
  const t0 = Date.now();
  const r = runWl(ws, "--project", "t1", "--once", "--agents", "showrunner");
  const dur = (Date.now() - t0) / 1000;
  const rows = ledger(ws);
  check("cap 超时：fire 被杀且 wl-run 正常收尾", r.code === 0 && rows.length === 1,
    `rc=${r.code} rows=${rows.length}`);
  if (rows.length) {
    check("cap 超时：timedOut=true 且 exitCode<0",
      rows[0].timedOut && typeof rows[0].exitCode === "number" && (rows[0].exitCode as number) < 0,
      `row=${JSON.stringify(rows[0])}`);
  }
  check(`cap 超时：远早于 30s 假 agent 睡眠（实际 ${dur.toFixed(1)}s）`, dur < 15);
  await sleep(500);
  const left = spawnSync("pgrep", ["-f", canary], { encoding: "utf8" });
  check("cap 超时：进程组无游魂（pgrep 空）", left.status !== 0, `存活：${(left.stdout ?? "").trim()}`);
  rmSync(ws, { recursive: true, force: true });
}

function testKeystoneEscalation(): void {
  const ws = makeWs({});
  rewriteAgents(ws, {
    reviewer: {
      enabled: true, intervalSeconds: 1, capSeconds: 30, model: "sonnet", effort: "high",
      command: fakeCmd(ws, 0, "model={model}", "effort={effort}"),
    },
  });
  seedKeystoneTicket(ws, "In Review");
  const r = runWl(ws, "--project", "t1", "--once", "--agents", "reviewer");
  let rows = ledger(ws);
  let msgs = markers(ws).filter((m) => m.kind === "msg");
  check("keystone 升档：命令收到 opus/max", msgs.some((m) => m.text.includes("model=opus effort=max")),
    `msgs=${JSON.stringify(msgs.map((m) => m.text))} rc=${r.code}`);
  check("keystone 升档：ledger keystoneEscalated=true 且 model=opus",
    rows.length > 0 && rows[rows.length - 1].keystoneEscalated && rows[rows.length - 1].model === "opus");
  // 反例：keystone 票不在 In Review ⇒ 不升档
  seedKeystoneTicket(ws, "Done");
  unlinkSync(join(ws, "markers.txt"));
  unlinkSync(join(ws, ".writing-loop", "t1", "fires.jsonl"));
  runWl(ws, "--project", "t1", "--once", "--agents", "reviewer");
  rows = ledger(ws);
  msgs = markers(ws).filter((m) => m.kind === "msg");
  check("keystone 反例：Done 票不触发升档（sonnet/high）",
    msgs.some((m) => m.text.includes("model=sonnet effort=high"))
    && rows.length > 0 && !rows[rows.length - 1].keystoneEscalated);
  rmSync(ws, { recursive: true, force: true });
}

function testDryRun(): void {
  const ws = makeWs({});
  const canary = join(ws, "should-not-exist");
  rewriteAgents(ws, {
    showrunner: { enabled: true, command: ["sh", "-c", `touch ${canary}`] },
    reviewer: { enabled: true },  // 无 command ⇒ 走 claude 默认模板
  });
  const r = runWl(ws, "--project", "t1", "--dry-run");
  let canaryExists = true;
  try { readFileSync(canary); } catch { canaryExists = false; }
  check("dry-run：rc=0 且零 spawn（canary 不存在）", r.code === 0 && !canaryExists);
  check("dry-run：不写 fires.jsonl", ledger(ws).length === 0);
  check("dry-run：claude 默认命令形完整解析",
    r.stdout.includes("claude") && r.stdout.includes("/writing-loop:reviewer-agent")
    && r.stdout.includes("--model") && r.stdout.includes("--dangerously-skip-permissions")
    && r.stdout.includes("--add-dir") && r.stdout.includes("cwd :"));
  rmSync(ws, { recursive: true, force: true });
}

function testPlan(): void {
  const ws = makeWs({});
  rewriteAgents(ws, { showrunner: { enabled: true }, reviewer: { enabled: true } });
  const r = runWl(ws, "--project", "t1", "--plan", "5");
  const lines = r.stdout.split("\n").filter((ln) => ln.trim().startsWith("T+"));
  check("plan：恰好 N 行排程且零 spawn", r.code === 0 && lines.length === 5 && ledger(ws).length === 0,
    `行数=${lines.length}`);
  rmSync(ws, { recursive: true, force: true });
}

function testLockGuard(): void {
  const ws = makeWs({});
  rewriteAgents(ws, { sweep: { enabled: true, intervalSeconds: 1, capSeconds: 30, command: fakeCmd(ws, 0) } });
  const proj = join(ws, ".writing-loop", "t1");
  mkdirSync(proj, { recursive: true });
  const lock = join(proj, "wl-run.lock");
  writeFileSync(lock, "holder pid=99999 (another wl-run)\n");
  let r = runWl(ws, "--project", "t1", "--once", "--agents", "sweep");
  check("锁在位：拒绝启动（rc!=0 且报锁路径）", r.code !== 0 && r.stderr.includes("wl-run.lock"), `rc=${r.code}`);
  unlinkSync(lock);
  r = runWl(ws, "--project", "t1", "--once", "--agents", "sweep");
  let lockLeft = true;
  try { readFileSync(lock); } catch { lockLeft = false; }
  check("锁释放后：正常运行且跑完自动释放锁", r.code === 0 && !lockLeft, `rc=${r.code} stderr=${r.stderr.slice(-200)}`);
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
const cases: Array<[string, () => void | Promise<void>]> = [
  ["testIntervalNoopLedger", testIntervalNoopLedger],
  ["testSingleFlight", testSingleFlight],
  ["testCapTimeoutKill", testCapTimeoutKill],
  ["testKeystoneEscalation", testKeystoneEscalation],
  ["testDryRun", testDryRun],
  ["testPlan", testPlan],
  ["testLockGuard", testLockGuard],
];
for (const [name, fn] of cases) {
  try { await fn(); }
  catch (e) { nfail++; console.log(`FAIL ${name} 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`); }
}
console.log(`\ntest-scheduler: ${npass} pass, ${nfail} fail${nfail === 0 ? "\nSCHEDULER_OK" : ""}`);
process.exit(nfail ? 1 : 0);
