// `writing-loop fires` —— fires.jsonl 遥测尾巴：末 N 行（默认 20）表格 +
// 按 agent 聚合的成功率（聚合跑全量行——尾巴只是展示窗口）。文件缺失给友好空态。
// 时间戳可信性见 conventions §18「时钟纪律」：本账本由 wl-run 进程自己的 UTC 时钟记账。
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtDur, readFires, type FireRow } from "./status.ts";
import { projectDataDir, requireWorkspace, resolveProject, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop fires — fires.jsonl 遥测尾巴 + 按 agent 聚合成功率
用法: writing-loop fires [--project K] [--last N] [--json]   （--last 默认 20）`);
}

type AgentAgg = { fires: number; ok: number; noop: number; timedOut: number };

export function aggregate(rows: FireRow[]): Record<string, AgentAgg> {
  const agg: Record<string, AgentAgg> = {};
  for (const r of rows) {
    const a = r.agent ?? "?";
    agg[a] ??= { fires: 0, ok: 0, noop: 0, timedOut: 0 };
    agg[a].fires++;
    if (r.exitCode === 0) agg[a].ok++;
    if (r.noop) agg[a].noop++;
    if (r.timedOut) agg[a].timedOut++;
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

  if (asJson) {
    console.log(JSON.stringify({ project: key, ledger, total: rows.length, rows: tail, byAgent: agg }, null, 2));
    return 0;
  }

  if (!rows.length) {
    console.log(`writing-loop fires — 项目 ${key}：尚无 fire 记录（${ledger} 不存在或为空）\n先 writing-loop run 起调度器。`);
    return 0;
  }

  console.log(`writing-loop fires — 项目 ${key}（末 ${tail.length} / 共 ${rows.length} fire；账本 ${ledger}）\n`);
  console.log(`  ${"startedAt".padEnd(26)} ${"agent".padEnd(15)} ${"model".padEnd(10)} ${"effort".padEnd(7)} ${"dur".padEnd(9)} ${"exit".padEnd(6)} noop  keystone`);
  for (const f of tail) {
    const exit = f.spawnError ? "spawn!" : String(f.exitCode ?? "-");
    console.log(`  ${(f.startedAt ?? "-").padEnd(26)} ${(f.agent ?? "?").padEnd(15)} ${String(f.model ?? "-").padEnd(10)} ${String(f.effort ?? "-").padEnd(7)} ${fmtDur(f.durationSeconds).padEnd(9)} ${exit.padEnd(6)} ${(f.noop ? "yes" : "-").padEnd(5)} ${f.keystoneEscalated ? "yes" : "-"}${f.timedOut ? "  TIMEOUT" : ""}`);
  }
  console.log(`\n汇总（按 agent，全 ${rows.length} fire）:`);
  for (const [agent, s] of Object.entries(agg).sort(([a], [b]) => a.localeCompare(b))) {
    const rate = s.fires ? Math.round((s.ok / s.fires) * 100) : 0;
    console.log(`  ${agent.padEnd(15)} ${String(s.fires).padStart(3)} fire · 成功 ${s.ok}/${s.fires}（${rate}%）· no-op ${s.noop}${s.timedOut ? ` · 超时 ${s.timedOut}` : ""}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(firesMain());
}
