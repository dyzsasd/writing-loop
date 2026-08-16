// `writing-loop fires` —— fires.jsonl 遥测尾巴：末 N 行（默认 20）表格 +
// 按 agent 聚合的成功率（聚合跑全量行——尾巴只是展示窗口）。文件缺失给友好空态。
// 时间戳可信性见 conventions §18「时钟纪律」：本账本由 wl-run 进程自己的 UTC 时钟记账。
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

  let key: string, root: string;
  try {
    const ws = requireWorkspace();
    const r = resolveProject(ws, projectFlag);
    key = r.key; root = ws.root;
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

  if (asJson) {
    console.log(JSON.stringify({ project: key, ledger, total: rows.length, rows: tail, byAgent: agg,
      usage: { overall, cacheHitRate: cacheHitRate(overall) } }, null, 2));
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
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(firesMain());
}
