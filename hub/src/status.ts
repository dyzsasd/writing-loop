// `writing-loop status` —— 只读板摘要（绝不写任何文件）：各 state 计数、In Review /
// In Progress 明细、needs-* 停靠票、写作前沿（episodes/ep-*.md 最大集号）、陈旧锁扫描、
// fires.jsonl 末 5 行。frontmatter 使用 status/UI 共用的容错投影解析器；解析不出的票
// 计入 "?" 桶而不是中断（板文件是 agent 写的，偶发畸形不该弄死观测工具）。
import { lstatSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSymlinkComponent, readDirectoryNames, readRegularTextHead, readRegularTextTail } from "./bounded-fs.ts";
import { projectDataDir, requireWorkspace, resolveProject, WsError } from "./workspace.ts";

const STALE_MINUTES = 60; // 与 conventions §18 / board-lock.sh 的陈旧判据一致
const DIRECTORY_ENTRY_LIMIT = 2_048;
const TICKET_LIMIT = 200;
const TICKET_HEAD_BYTES = 64 * 1024;
const FIRE_TAIL_BYTES = 512 * 1024;
const FIRE_ROW_LIMIT = 2_000;
const MAX_FIRE_DURATION_SECONDS = 365 * 24 * 60 * 60;
export const TICKET_STATES: ReadonlySet<string> = new Set([
  "Todo", "Backlog", "In Progress", "In Review", "Done", "Canceled", "Duplicate",
]);
const EPISODE_FILE_PATTERN = /^ep-(00[1-9]|0[1-9]\d|[1-9]\d{2,5})\.md$/;

/** Canonical episode registry: ep-001…ep-999, then ep-1000…ep-999999. */
export function episodeNumberFromFile(file: string): number | null {
  const match = EPISODE_FILE_PATTERN.exec(file);
  return match ? Number(match[1]) : null;
}

export type Ticket = {
  id: string;
  title: string;
  type: string;
  state: string;
  labels: string[];
  owner: string | null;
  assignee: string | null;
  priority: number;
  updated: string;
  episode: number | null;
  file: string;
  malformed: boolean;
};
export type LockInfo = { path: string; ageMinutes: number; stale: boolean };
export type FireRow = {
  agent?: string; model?: string | null; effort?: string | null;
  startedAt?: string; endedAt?: string; durationSeconds?: number;
  exitCode?: number | null; timedOut?: boolean; noop?: boolean;
  keystoneEscalated?: boolean; descendantDrain?: boolean; spawnError?: string;
  provider?: string | null; providerAuthMissing?: string;  // 0.7.0 成本归因 + 认证 guard 拦截标记
};

export const isCleanFire = (row: FireRow): boolean =>
  row.exitCode === 0 && !row.timedOut && !row.descendantDrain;

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeLedgerString = (value: unknown, max: number, nullable = false): boolean =>
  value === undefined || (nullable && value === null)
  || (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const optionalBoolean = (row: Record<string, unknown>, key: string): boolean =>
  row[key] === undefined || typeof row[key] === "boolean";

/** Runtime gate for agent-authored JSONL; syntactically valid primitives are not FireRow values. */
export function parseFireRow(value: unknown): FireRow | null {
  if (!plainRecord(value)) return null;
  if (typeof value.agent !== "string" || !value.agent.trim() || !safeLedgerString(value.agent, 160)) return null;
  if (!["startedAt", "endedAt"].every((key) => safeLedgerString(value[key], 80))) return null;
  if (!["spawnError", "providerAuthMissing"].every((key) => safeLedgerString(value[key], 2_048))) return null;
  if (!["model", "effort", "provider"].every((key) => safeLedgerString(value[key], 256, true))) return null;
  if (!["timedOut", "noop", "keystoneEscalated", "descendantDrain"].every((key) => optionalBoolean(value, key))) return null;
  if (value.durationSeconds !== undefined
    && (typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds)
      || value.durationSeconds < 0 || value.durationSeconds > MAX_FIRE_DURATION_SECONDS)) return null;
  if (value.exitCode !== undefined && value.exitCode !== null
    && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) return null;
  return value as FireRow;
}

// ─── frontmatter 小解析器（§18 票文件格式；仪表盘/status 共用的只读投影） ───────
const stripQuotes = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");

export function parseTicketFrontmatter(text: string, file = ""): Ticket | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return null;
  const fm = lines.slice(1, end);
  const field = (name: string): string => {
    for (const line of fm) {
      const m = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`).exec(line);
      if (m) return stripQuotes(m[1]);
    }
    return "";
  };
  let malformed = false;
  let labels: string[] = [];
  const labelsIdx = fm.findIndex((line) => /^labels:/.test(line));
  if (labelsIdx >= 0) {
    const inline = fm[labelsIdx].slice("labels:".length).trim();
    if (inline === "" || inline === "[]") {
      const block: string[] = [];
      for (let i = labelsIdx + 1; i < fm.length; i++) {
        const item = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(fm[i]);
        if (item) block.push(stripQuotes(item[1]));
        else if (/^[ \t]*$/.test(fm[i])) continue;
        else if (/^[ \t]*-/.test(fm[i])) { malformed = true; break; }
        else break;
      }
      labels = block;
    } else {
      const flow = /^\[(.*)\]$/.exec(inline);
      if (flow) labels = flow[1].split(",").map((v) => stripQuotes(v.trim())).filter(Boolean);
      else malformed = true;
    }
  }
  const stateRaw = field("state");
  const state = TICKET_STATES.has(stateRaw) ? stateRaw : "?";
  if (!field("id") || !field("title") || state === "?") malformed = true;
  const priorityRaw = Number(field("priority"));
  const body = lines.slice(end + 1).join("\n");
  const ep = /^Episode:[ \t]*(\d{1,6})(?!\d)/m.exec(body);
  const nullable = (value: string): string | null => value && value !== "null" && value !== "~" ? value : null;
  return {
    id: field("id") || file.replace(/\.md$/, ""),
    title: field("title") || "未命名创作任务",
    type: field("type") || "Task",
    state,
    labels,
    owner: nullable(field("owner")),
    assignee: nullable(field("assignee")),
    priority: Number.isInteger(priorityRaw) ? priorityRaw : 0,
    updated: field("updated"),
    episode: ep && Number(ep[1]) > 0 ? Number(ep[1]) : null,
    file,
    malformed,
  };
}

const ticketNum = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

export function listTickets(boardTicketsDir: string): { tickets: Ticket[]; unparsed: number; missingDir: boolean; truncated: boolean; truncatedFiles: number } {
  const scanned = readDirectoryNames(boardTicketsDir, DIRECTORY_ENTRY_LIMIT);
  const ranked = scanned.names.filter((name) => name.endsWith(".md")).map((name) => {
    try { return { name, mtimeMs: lstatSync(join(boardTicketsDir, name)).mtimeMs }; }
    catch { return { name, mtimeMs: 0 }; }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  let names = ranked.map((row) => row.name);
  const truncated = scanned.truncated || names.length > TICKET_LIMIT;
  names = names.slice(0, TICKET_LIMIT);
  if (!scanned.names.length) {
    try {
      if (!statSync(boardTicketsDir).isDirectory()) return { tickets: [], unparsed: 0, missingDir: true, truncated: false, truncatedFiles: 0 };
    } catch { return { tickets: [], unparsed: 0, missingDir: true, truncated: false, truncatedFiles: 0 }; }
  }
  const tickets: Ticket[] = [];
  let unparsed = 0;
  let truncatedFiles = 0;
  for (const n of names) {
    let t: Ticket | null = null;
    const read = readRegularTextHead(join(boardTicketsDir, n), TICKET_HEAD_BYTES);
    if (read) {
      if (read.truncated) truncatedFiles++;
      t = parseTicketFrontmatter(read.text, n);
    }
    if (t) { tickets.push(t); if (t.malformed) unparsed++; }
    else unparsed++;
  }
  tickets.sort((a, b) => ticketNum(a.id) - ticketNum(b.id));
  return { tickets, unparsed, missingDir: false, truncated, truncatedFiles };
}

// ─── 写作前沿：episodes/ep-*.md 的最大集号 ─────────────────────────────────────
export function episodeFrontier(repo: string): { max: number; file: string | null } {
  const names = readDirectoryNames(join(repo, "episodes"), DIRECTORY_ENTRY_LIMIT).names;
  let max = 0;
  let file: string | null = null;
  for (const n of names) {
    const number = episodeNumberFromFile(n);
    if (number !== null && number > max) { max = number; file = n; }
  }
  return { max, file };
}

// ─── 陈旧锁扫描：board/*.lock（含 tickets/）、<repo>/.git/story-assets.lock、
//     <repo>/.git/repo.lock、wl-run.lock —— mtime > 60min 标 STALE ────────────────
export function scanLocks(root: string, projData: string, repo: string, now = Date.now()): LockInfo[] {
  const found: string[] = [];
  const globLocks = (dir: string): void => {
    for (const n of readDirectoryNames(dir, 512).names) if (n.endsWith(".lock")) found.push(join(dir, n));
  };
  globLocks(join(projData, "board"));
  globLocks(join(projData, "board", "tickets"));
  for (const f of [join(repo, ".git", "story-assets.lock"), join(repo, ".git", "repo.lock"), join(projData, "wl-run.lock")]) {
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
export function readFiresBounded(path: string): { rows: FireRow[]; truncated: boolean; invalid: number } {
  const read = readRegularTextTail(path, FIRE_TAIL_BYTES);
  if (!read) return { rows: [], truncated: false, invalid: 0 };
  const rows: FireRow[] = [];
  let invalid = 0;
  const allLines = read.text.split("\n");
  const end = allLines.at(-1)?.trim() === "" ? allLines.length - 1 : allLines.length;
  const first = Math.max(0, end - FIRE_ROW_LIMIT);
  for (const line of allLines.slice(first, end)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = parseFireRow(JSON.parse(s));
      if (row) rows.push(row);
      else invalid++;
    } catch { invalid++; }
  }
  return { rows, truncated: read.truncated || first > 0, invalid };
}

export const readFires = (path: string): FireRow[] => readFiresBounded(path).rows;

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
  if (hasSymlinkComponent(root, [".writing-loop", key, "board", "tickets"])) {
    console.error(`writing-loop status: 项目 '${key}' 的运行态路径含符号链接`);
    return 1;
  }
  const { tickets, unparsed, missingDir, truncated: ticketsTruncated, truncatedFiles } = listTickets(join(projData, "board", "tickets"));
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
  const firesWindow = readFiresBounded(join(projData, "fires.jsonl"));
  const fires = firesWindow.rows;
  const recent = fires.slice(-5);

  if (asJson) {
    console.log(JSON.stringify({
      project: key,
      repoPath,
      board: { total: tickets.length, unparsed, missingDir, truncated: ticketsTruncated, truncatedFiles, counts },
      inReview,
      inProgress,
      parked: parked.map((t) => ({ ...t, needs: t.labels.filter((l) => l.startsWith("needs-")) })),
      episodeFrontier: frontier.max,
      episodeFrontierFile: frontier.file,
      locks,
      recentFires: recent,
      totalFires: fires.length,
      firesTruncated: firesWindow.truncated,
      invalidFireRows: firesWindow.invalid,
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
    if (ticketsTruncated) console.log("  WARN: 票目录超过有界观测窗口；这里只显示最近 200 张可解析候选");
    if (truncatedFiles) console.log(`  WARN: ${truncatedFiles} 张票只读取前 ${TICKET_HEAD_BYTES / 1024} KiB 摘要`);
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
  console.log(`fires.jsonl 末 ${recent.length} fire${fires.length ? `（有界窗口 ${fires.length} 行）` : ""}${firesWindow.truncated ? " [TAIL_TRUNCATED]" : ""}:`);
  console.log(recent.length
    ? recent.map((f) => `  ${(f.startedAt ?? "-").padEnd(26)} ${(f.agent ?? "?").padEnd(15)} exit ${f.spawnError ? "spawn!" : f.providerAuthMissing ? "auth!" : String(f.exitCode ?? "-")}  ${fmtDur(f.durationSeconds)}${f.noop ? "  no-op" : ""}${f.keystoneEscalated ? "  keystone" : ""}`).join("\n")
    : "  尚无 fire 记录（writing-loop run 起调度器）");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(statusMain());
}
