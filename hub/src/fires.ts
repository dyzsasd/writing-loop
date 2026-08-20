// `writing-loop fires` —— fires.jsonl 遥测尾巴：末 N 行（默认 20）表格 +
// 按 agent 聚合的成功率（聚合跑全量行——尾巴只是展示窗口）。文件缺失给友好空态。
// 时间戳可信性见 conventions §18「时钟纪律」：本账本由 wl-run 进程自己的 UTC 时钟记账。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addUsageRow, cacheHitRate, emptyUsageCell, type FireUsage, type UsageCell } from "./fire-usage.ts";
import { fmtDur, isCleanFire, readFires, type FireRow } from "./status.ts";
import { projectDataDir, requireWorkspace, resolveProject, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop fires — fires.jsonl 遥测尾巴 + 按 agent 聚合成功率
用法: writing-loop fires [--project K] [--last N] [--json]   （--last 默认 20）

计量列（input/output/cache/成本）来自各车道的结构化输出；解析不出即记「未计量」，
不以 0 充数。缓存命中率 = cacheRead /（cacheRead + input）。`);
}

type AgentAgg = { fires: number; ok: number; noop: number; timedOut: number; descendantDrains: number; authGap: number; usage: UsageCell };

// ── 近 24h 成本仪表（2026-08-20 操作者裁定：$/集 与 治理:内容 占比要在遥测口径里常驻可见，
// 阈值超限打 WARN——69h 实测 $2,639 里内容产出仅 ~22%（episode-writer 5.5%）在事后分析才被
// 发现，仪表的意义就是让这类漂移当天可见）──────────────────────────────────────────────
export const CONTENT_AGENTS: ReadonlySet<string> = new Set(["episode-writer", "story-designer", "source-analyst"]);
export const GOVERNANCE_WARN_SHARE = 0.7;   // 治理成本占比（治理/(治理+内容)）超过即 WARN
export const NOOP_WARN_USD = 10;            // 24h 窗口 no-op fire 累计成本超过即 WARN
export type WindowStats = {
  fires: number; metered: number; costUsd: number;
  noopFires: number; noopCostUsd: number;
  timedOut: number; badExits: number;       // badExits = 非零退出且非超时（超时单列）
  contentCostUsd: number; governanceCostUsd: number;
  governanceShare: number | null;           // 两侧计量成本皆 0 ⇒ null（无占比可言）
  byAgent: Record<string, { fires: number; costUsd: number }>;
};

// 纯函数：rows 里 startedAt 落在 (nowMs-windowMs, nowMs+5min] 的行进入窗口；无 startedAt/
// 解析不出的行不计入（旧账本行）。成本只累计带 costUsd 的计量行——不以 0 充数（与全量
// 聚合同一纪律）；fires/noop/超时/非零退出照常计数。
export function windowStats(rows: FireRow[], nowMs: number, windowMs = 24 * 3600_000): WindowStats {
  const out: WindowStats = { fires: 0, metered: 0, costUsd: 0, noopFires: 0, noopCostUsd: 0,
    timedOut: 0, badExits: 0, contentCostUsd: 0, governanceCostUsd: 0, governanceShare: null, byAgent: {} };
  const cutoff = nowMs - windowMs;
  for (const r of rows) {
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isNaN(t) || t <= cutoff || t > nowMs + 5 * 60_000) continue;
    out.fires++;
    const a = r.agent ?? "?";
    out.byAgent[a] ??= { fires: 0, costUsd: 0 };
    out.byAgent[a].fires++;
    if (r.noop) out.noopFires++;
    if (r.timedOut) out.timedOut++;
    else if (typeof r.exitCode === "number" && r.exitCode !== 0) out.badExits++;
    const u = usageOf(r);
    const c = u && typeof u.costUsd === "number" ? u.costUsd : null;
    if (c === null) continue;
    out.metered++; out.costUsd += c; out.byAgent[a].costUsd += c;
    if (r.noop) out.noopCostUsd += c;
    if (CONTENT_AGENTS.has(a)) out.contentCostUsd += c; else out.governanceCostUsd += c;
  }
  const denom = out.contentCostUsd + out.governanceCostUsd;
  out.governanceShare = denom > 0 ? out.governanceCostUsd / denom : null;
  return out;
}

// 窗口内新增正文集数（git log --diff-filter=A -- episodes）；非 git 仓库/git 失败 ⇒ null
// （仪表显示「不可判」，绝不以 0 充数——0 是「确证没写新集」的强断言）。
export function episodesAddedSince(repoPath: string, sinceIso: string): number | null {
  try {
    const r = spawnSync("git",
      ["log", `--since=${sinceIso}`, "--diff-filter=A", "--name-only", "--pretty=format:", "--", "episodes"],
      { cwd: repoPath, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    const eps = new Set<string>();
    for (const ln of r.stdout.split("\n")) {
      const m = /^episodes\/(ep-\d{3,}\.md)$/.exec(ln.trim());
      if (m) eps.add(m[1]);
    }
    return eps.size;
  } catch { return null; }
}

// 仪表渲染（纯函数，输出行数组——测试直接断言文案；epsAdded=null 表示不可判）。
export function renderWindowReport(w: WindowStats, epsAdded: number | null): string[] {
  if (w.fires === 0) return [];
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const lines: string[] = [];
  const perEp = epsAdded === null ? "新集不可判（repo 非 git 或 git 失败）"
    : epsAdded === 0 ? "新集 0"
    : `新集 ${epsAdded}（$${(w.costUsd / epsAdded).toFixed(0)}/集）`;
  lines.push(`近 24h：${w.fires} fire（计量 ${w.metered}）· 成本 $${w.costUsd.toFixed(2)} · ${perEp}`);
  const denom = w.contentCostUsd + w.governanceCostUsd;
  if (denom > 0) {
    lines.push(`  内容产出（episode-writer/story-designer/source-analyst）$${w.contentCostUsd.toFixed(2)}`
      + `（${pct(w.contentCostUsd / denom)}）· 治理（其余角色）$${w.governanceCostUsd.toFixed(2)}`
      + `（${pct(w.governanceCostUsd / denom)}）· no-op $${w.noopCostUsd.toFixed(2)}`);
  }
  if (w.governanceShare !== null && w.governanceShare > GOVERNANCE_WARN_SHARE) {
    lines.push(`  WARN 治理成本占比 ${pct(w.governanceShare)} > ${pct(GOVERNANCE_WARN_SHARE)}`
      + `——验收/审计/卫生开销压过内容产出，检查 showrunner/reviewer/sweep 车道`);
  }
  if (w.noopCostUsd > NOOP_WARN_USD) {
    lines.push(`  WARN no-op fire 24h 累计 $${w.noopCostUsd.toFixed(2)} > $${NOOP_WARN_USD}——车道谓词在放空炮，对照 --dry-run 查各 gate`);
  }
  if (w.timedOut > 0 || w.badExits > 0) {
    lines.push(`  WARN 超时 ${w.timedOut} 次 · 非零退出 ${w.badExits} 次（近 24h）`);
  }
  return lines;
}

const usageOf = (row: FireRow): FireUsage | null => {
  const raw = (row as unknown as { usage?: unknown }).usage;
  return raw && typeof raw === "object" ? raw as FireUsage : null;
};

const fmtTokens = (value: number | null): string => value === null ? "—"
  : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M`
  : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const fmtCost = (value: number | null): string => value === null ? "—" : `$${value.toFixed(2)}`;
const fmtRate = (value: number | null): string => value === null ? "—" : `${Math.round(value * 100)}%`;

export function aggregate(rows: FireRow[]): Record<string, AgentAgg> {
  const agg = Object.create(null) as Record<string, AgentAgg>;
  for (const r of rows) {
    const a = r.agent ?? "?";
    agg[a] ??= { fires: 0, ok: 0, noop: 0, timedOut: 0, descendantDrains: 0, authGap: 0, usage: emptyUsageCell() };
    agg[a].fires++;
    addUsageRow(agg[a].usage, usageOf(r));
    if (isCleanFire(r)) agg[a].ok++;
    if (r.noop) agg[a].noop++;
    if (r.timedOut) agg[a].timedOut++;
    if (r.descendantDrain) agg[a].descendantDrains++;
    if (r.providerAuthMissing) agg[a].authGap++;  // guard 拦截行（零 token，但拉低成功率——单列出来免当谜团）
  }
  return agg;
}

export function firesMain(argv = process.argv.slice(2)): number {
  let projectFlag: string | null = null;
  let last = 20;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--project") { projectFlag = argv[++i] ?? null; if (!projectFlag) { console.error("writing-loop fires: --project 需要值"); return 2; } }
    else if (a === "--last") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) { console.error("writing-loop fires: --last 需要 ≥1 的整数"); return 2; }
      last = v;
    } else if (a === "--json") asJson = true;
    else { console.error(`writing-loop fires: 未知参数 '${a}'`); usage(); return 2; }
  }

  let key: string, root: string, repoPath: string;
  try {
    const ws = requireWorkspace();
    const r = resolveProject(ws, projectFlag);
    key = r.key; root = ws.root; repoPath = r.repoPath;
  } catch (e) {
    console.error(`writing-loop fires: ${e instanceof WsError ? e.message : String(e)}`);
    return 1;
  }

  const ledger = join(projectDataDir(root, key), "fires.jsonl");
  const rows = readFires(ledger);
  const tail = rows.slice(-last);
  const agg = aggregate(rows);
  const overall = emptyUsageCell();
  for (const r of rows) addUsageRow(overall, usageOf(r));
  const nowMs = Date.now();
  const win = windowStats(rows, nowMs);
  const epsAdded = win.fires > 0 ? episodesAddedSince(repoPath, new Date(nowMs - 24 * 3600_000).toISOString()) : null;

  if (asJson) {
    console.log(JSON.stringify({ project: key, ledger, total: rows.length, rows: tail, byAgent: agg,
      usage: { overall, cacheHitRate: cacheHitRate(overall) },
      window24h: { ...win, episodesAdded: epsAdded,
        costPerEpisodeUsd: epsAdded ? win.costUsd / epsAdded : null } }, null, 2));
    return 0;
  }

  if (!rows.length) {
    console.log(`writing-loop fires — 项目 ${key}：尚无 fire 记录（${ledger} 不存在或为空）\n先 writing-loop run 起调度器。`);
    return 0;
  }

  console.log(`writing-loop fires — 项目 ${key}（末 ${tail.length} / 共 ${rows.length} fire；账本 ${ledger}）\n`);
  console.log(`  ${"startedAt".padEnd(26)} ${"agent".padEnd(15)} ${"model".padEnd(10)} ${"effort".padEnd(7)} ${"provider".padEnd(12)} ${"dur".padEnd(9)} ${"exit".padEnd(6)} noop  keystone`);
  for (const f of tail) {
    // exit 列三态标记：spawn! = 起进程失败；auth! = provider 认证 guard 拦截（零 token）
    const exit = f.spawnError ? "spawn!" : f.providerAuthMissing ? "auth!" : String(f.exitCode ?? "-");
    console.log(`  ${(f.startedAt ?? "-").padEnd(26)} ${(f.agent ?? "?").padEnd(15)} ${String(f.model ?? "-").padEnd(10)} ${String(f.effort ?? "-").padEnd(7)} ${String(f.provider ?? "-").padEnd(12)} ${fmtDur(f.durationSeconds).padEnd(9)} ${exit.padEnd(6)} ${(f.noop ? "yes" : "-").padEnd(5)} ${f.keystoneEscalated ? "yes" : "-"}${f.timedOut ? "  TIMEOUT" : ""}${f.descendantDrain ? "  DESCENDANT_DRAIN" : ""}`);
  }
  console.log(`\n汇总（按 agent，全 ${rows.length} fire）:`);
  for (const [agent, s] of Object.entries(agg).sort(([a], [b]) => a.localeCompare(b))) {
    const rate = s.fires ? Math.round((s.ok / s.fires) * 100) : 0;
    console.log(`  ${agent.padEnd(15)} ${String(s.fires).padStart(3)} fire · 成功 ${s.ok}/${s.fires}（${rate}%）· no-op ${s.noop}${s.timedOut ? ` · 超时 ${s.timedOut}` : ""}${s.descendantDrains ? ` · 后代清理 ${s.descendantDrains}` : ""}${s.authGap ? ` · 认证拦截 ${s.authGap}` : ""}`);
  }
  if (overall.metered > 0) {
    console.log(`\n计量（${overall.metered}/${overall.fires} fire 带 usage）:`);
    console.log(`  ${"agent".padEnd(15)} ${"计量".padEnd(8)} ${"input".padEnd(9)} ${"output".padEnd(9)} ${"cache读".padEnd(9)} ${"cache写".padEnd(9)} ${"命中率".padEnd(7)} 成本`);
    for (const [agent, s] of Object.entries(agg).sort(([a], [b]) => a.localeCompare(b))) {
      if (s.usage.metered === 0) continue;
      const u = s.usage;
      console.log(`  ${agent.padEnd(15)} ${`${u.metered}/${u.fires}`.padEnd(8)} ${fmtTokens(u.inputTokens).padEnd(9)} ${fmtTokens(u.outputTokens).padEnd(9)} ${fmtTokens(u.cacheReadTokens).padEnd(9)} ${fmtTokens(u.cacheWriteTokens).padEnd(9)} ${fmtRate(cacheHitRate(u)).padEnd(7)} ${fmtCost(u.costUsd)}`);
    }
    console.log(`  ${"合计".padEnd(15)} ${`${overall.metered}/${overall.fires}`.padEnd(8)} ${fmtTokens(overall.inputTokens).padEnd(9)} ${fmtTokens(overall.outputTokens).padEnd(9)} ${fmtTokens(overall.cacheReadTokens).padEnd(9)} ${fmtTokens(overall.cacheWriteTokens).padEnd(9)} ${fmtRate(cacheHitRate(overall)).padEnd(7)} ${fmtCost(overall.costUsd)}`);
    if (overall.costMetered < overall.metered) {
      console.log(`  （${overall.metered - overall.costMetered} 条带 token 但无成本字段——该车道未报成本，不按单价推算）`);
    }
  } else if (rows.length) {
    console.log(`\n计量：0/${rows.length} fire 带 usage —— 这些 fire 早于计量接入，或车道未提供结构化输出。`);
  }
  const report = renderWindowReport(win, epsAdded);
  if (report.length) { console.log(""); for (const ln of report) console.log(ln); }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(firesMain());
}
