// `writing-loop status` —— 只读板摘要（绝不写任何文件）：各 state 计数、In Review /
// In Progress 明细、needs-* 停靠票、写作前沿（episodes/ep-*.md 最大集号）、陈旧锁扫描、
// fires.jsonl 末 5 行。frontmatter 用手写 5 字段小解析器（id/title/state/labels/updated）——
// 容错优先：解析不出的票计入 "?" 桶而不是中断（板文件是 agent 写的，偶发畸形不该弄死观测工具）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { projectDataDir, requireWorkspace, resolveProject, WsError } from "./workspace.ts";

const STALE_MINUTES = 60; // 与 conventions §18 / board-lock.sh 的陈旧判据一致

export type Ticket = { id: string; title: string; state: string; labels: string[]; updated: string; file: string };
export type LockInfo = { path: string; ageMinutes: number; stale: boolean };
export type FireRow = {
  agent?: string; model?: string | null; effort?: string | null;
  startedAt?: string; endedAt?: string; durationSeconds?: number;
  exitCode?: number | null; timedOut?: boolean; noop?: boolean;
  keystoneEscalated?: boolean; spawnError?: string;
};

// ─── frontmatter 小解析器（§18 票文件格式；5 字段，容错） ───────────────────────
export function parseTicketFrontmatter(text: string, file = ""): Ticket | null {
  if (!text.startsWith("---")) return null;
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return null;
  const fm = lines.slice(1, end).join("\n");
  const field = (name: string): string => {
    const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(fm);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const labelsRaw = /^labels:[ \t]*\[(.*?)\]/m.exec(fm);
  const labels = labelsRaw
    ? labelsRaw[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    : [];
  return { id: field("id"), title: field("title"), state: field("state") || "?", labels, updated: field("updated"), file };
}

const ticketNum = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

export function listTickets(boardTicketsDir: string): { tickets: Ticket[]; unparsed: number; missingDir: boolean } {
  let names: string[];
  try {
    names = readdirSync(boardTicketsDir).filter((n) => n.endsWith(".md"));
  } catch {
    return { tickets: [], unparsed: 0, missingDir: true };
  }
  const tickets: Ticket[] = [];
  let unparsed = 0;
  for (const n of names) {
    let t: Ticket | null = null;
    try { t = parseTicketFrontmatter(readFileSync(join(boardTicketsDir, n), "utf8"), n); } catch { /* 读失败按畸形计 */ }
    if (t) tickets.push(t); else unparsed++;
  }
  tickets.sort((a, b) => ticketNum(a.id) - ticketNum(b.id));
  return { tickets, unparsed, missingDir: false };
}

// ─── 写作前沿：episodes/ep-*.md 的最大集号 ─────────────────────────────────────
export function episodeFrontier(repo: string): { max: number; file: string | null } {
  let names: string[];
  try { names = readdirSync(join(repo, "episodes")); } catch { return { max: 0, file: null }; }
  let max = 0;
  let file: string | null = null;
  for (const n of names) {
    const m = /^ep-0*(\d+)\.md$/.exec(n);
    if (m && Number(m[1]) > max) { max = Number(m[1]); file = n; }
  }
  return { max, file };
}

// ─── 陈旧锁扫描：board/*.lock（含 tickets/）、<repo>/ledgers/*.lock、
//     <repo>/.git/repo.lock、wl-run.lock —— mtime > 60min 标 STALE ────────────────
export function scanLocks(root: string, projData: string, repo: string, now = Date.now()): LockInfo[] {
  const found: string[] = [];
  const globLocks = (dir: string): void => {
    try {
      for (const n of readdirSync(dir)) if (n.endsWith(".lock")) found.push(join(dir, n));
    } catch { /* 目录不存在 ⇒ 无锁 */ }
  };
  globLocks(join(projData, "board"));
  globLocks(join(projData, "board", "tickets"));
  globLocks(join(repo, "ledgers"));
  for (const f of [join(repo, ".git", "repo.lock"), join(projData, "wl-run.lock")]) {
    try { if (statSync(f).isFile()) found.push(f); } catch { /* 不在 ⇒ 跳过 */ }
  }
  const out: LockInfo[] = [];
  for (const p of found) {
    try {
      const age = Math.round((now - statSync(p).mtimeMs) / 60000);
      out.push({ path: relative(root, p), ageMinutes: age, stale: age > STALE_MINUTES });
    } catch { /* 扫描间隙被释放 ⇒ 跳过 */ }
  }
  return out;
}

// ─── fires.jsonl 尾巴（坏行静默跳过——遥测残行不该弄死摘要） ────────────────────
export function readFires(path: string): FireRow[] {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const rows: FireRow[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s) as FireRow); } catch { /* 坏行跳过 */ }
  }
  return rows;
}

export const fmtDur = (s: number | undefined): string =>
  typeof s === "number" ? `${s.toFixed(1)}s` : "-";

function usage(): void {
  console.log(`writing-loop status — 只读板摘要
用法: writing-loop status [--project K] [--json]`);
}

export function statusMain(argv = process.argv.slice(2)): number {
  let projectFlag: string | null = null;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--project") { projectFlag = argv[++i] ?? null; if (!projectFlag) { console.error("writing-loop status: --project 需要值"); return 2; } }
    else if (a === "--json") asJson = true;
    else { console.error(`writing-loop status: 未知参数 '${a}'`); usage(); return 2; }
  }

  let key: string, repoPath: string, root: string;
  try {
    const ws = requireWorkspace();
    const r = resolveProject(ws, projectFlag);
    key = r.key; repoPath = r.repoPath; root = ws.root;
  } catch (e) {
    console.error(`writing-loop status: ${e instanceof WsError ? e.message : String(e)}`);
    return 1;
  }

  const projData = projectDataDir(root, key);
  const { tickets, unparsed, missingDir } = listTickets(join(projData, "board", "tickets"));
  const counts: Record<string, number> = {};
  for (const t of tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  if (unparsed) counts["?"] = unparsed;
  const inReview = tickets.filter((t) => t.state === "In Review");
  const inProgress = tickets.filter((t) => t.state === "In Progress");
  // 终态（Done/Canceled/Duplicate）的票不再是「待操作者」——按 §3 已出生命周期，只看开放态
  const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]);
  const parked = tickets.filter(
    (t) => !TERMINAL.has(t.state) && t.labels.some((l) => l.startsWith("needs-")),
  );
  const frontier = episodeFrontier(repoPath);
  const locks = scanLocks(root, projData, repoPath);
  const fires = readFires(join(projData, "fires.jsonl"));
  const recent = fires.slice(-5);

  if (asJson) {
    console.log(JSON.stringify({
      project: key,
      repoPath,
      board: { total: tickets.length, unparsed, missingDir, counts },
      inReview,
      inProgress,
      parked: parked.map((t) => ({ ...t, needs: t.labels.filter((l) => l.startsWith("needs-")) })),
      episodeFrontier: frontier.max,
      episodeFrontierFile: frontier.file,
      locks,
      recentFires: recent,
      totalFires: fires.length,
    }, null, 2));
    return 0;
  }

  const line = (t: Ticket): string => `  ${t.id.padEnd(8)} ${t.title}${t.labels.length ? `  [${t.labels.join(", ")}]` : ""}`;
  console.log(`writing-loop status — 项目 ${key}（repo: ${repoPath}）`);
  if (missingDir) {
    console.log("\n板目录尚未创建（board/tickets/）—— 还没铺板或还没第一张票");
  } else {
    const order = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"];
    const parts = [...order.filter((s) => counts[s]), ...Object.keys(counts).filter((s) => !order.includes(s))]
      .map((s) => `${s} ${counts[s]}`);
    console.log(`\n板（${tickets.length} 票${unparsed ? `，另 ${unparsed} 张解析失败` : ""}）: ${parts.join(" · ") || "空"}`);
  }
  console.log(`\nIn Review（审读门前）:`);
  console.log(inReview.length ? inReview.map(line).join("\n") : "  无");
  console.log(`In Progress（在写）:`);
  console.log(inProgress.length ? inProgress.map(line).join("\n") : "  无");
  console.log(`needs-* 停靠票:`);
  console.log(parked.length ? parked.map((t) => `${line(t)}  state=${t.state}`).join("\n") : "  无");
  console.log(`\n写作前沿: ${frontier.max ? `episodes/${frontier.file}（最大集号 ${frontier.max}）` : "episodes/ 尚无 ep-*.md"}`);
  console.log(`锁:`);
  console.log(locks.length
    ? locks.map((l) => `  ${l.path.padEnd(44)} age ${l.ageMinutes}min${l.stale ? "  STALE(>60min)" : ""}`).join("\n")
    : "  无 .lock 在位");
  console.log(`fires.jsonl 末 ${recent.length} fire${fires.length ? `（共 ${fires.length} 行）` : ""}:`);
  console.log(recent.length
    ? recent.map((f) => `  ${(f.startedAt ?? "-").padEnd(26)} ${(f.agent ?? "?").padEnd(15)} exit ${f.spawnError ? "spawn!" : String(f.exitCode ?? "-")}  ${fmtDur(f.durationSeconds)}${f.noop ? "  no-op" : ""}${f.keystoneEscalated ? "  keystone" : ""}`).join("\n")
    : "  尚无 fire 记录（writing-loop run 起调度器）");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(statusMain());
}
