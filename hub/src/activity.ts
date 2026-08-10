// 有界、可重建的创作活动投影。它不冒充第四真相源：fire 来自 JSONL，转态来自 Ticket
// append-only comments，其余旧文件只称 observed/discovered。详情与分页按需计算，不进入
// WorkspaceSnapshot，避免作品书架/SSE 每次携带全部 Markdown。
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { hasSymlinkComponent, readDirectoryNames } from "./bounded-fs.ts";
import {
  PROJECT_DOCUMENTS, listProjectEvaluationsBounded, listProjectReportsBounded, readProjectResource,
  type ProjectResourceKind,
} from "./project-detail.ts";
import { readSchedulerView, type SchedulerView } from "./project-read-model.ts";
import { episodeNumberFromFile, isCleanFire, listTickets, parseFireRow, type FireRow } from "./status.ts";
import { assertProjectKey, projectDataDir, resolveRepoPath, WsError, type Workspace } from "./workspace.ts";

const FIRE_BYTES = 512 * 1024;
const EVENT_BYTES = 128 * 1024;
const MAX_TICKETS = 200;
const MAX_COMMENTS_PER_TICKET = 40;
const MAX_ARTIFACTS_PER_KIND = 200;
const MAX_FIRE_LINES = 2_000;
const MAX_EVENT_LINES = 1_000;

export type Fact<T> =
  | { state: "known"; value: T; source: "ledger" | "run-state" | "filesystem" | "derived" }
  | { state: "unknown"; reason: "not-recorded" | "legacy-record" | "in-flight" | "unparseable" }
  | { state: "not-applicable"; reason: "provider-not-started" | "no-duration" };

export type ActivityMetrics = {
  provider: Fact<string>;
  model: Fact<string>;
  effort: Fact<string>;
  durationSeconds: Fact<number>;
  tokenUsage: Fact<{ input: number; output: number }>;
  cost: Fact<{ currency: "USD"; amountMicros: number; basis: "reported" | "billed" | "estimated" }>;
};

export type ActivityKind =
  | "project.created" | "project.paused" | "project.resumed"
  | "fire.completed" | "fire.failed" | "fire.timed-out" | "fire.noop" | "fire.blocked"
  | "ticket.discovered" | "ticket.commented" | "ticket.state-changed"
  | "episode.discovered" | "document.discovered" | "report.discovered" | "report.reviewed" | "evaluation.discovered";

export type ActivityEvent = {
  schemaVersion: 1;
  id: string;
  project: string;
  kind: ActivityKind;
  source: "events" | "fires" | "ticket" | "episode" | "document" | "report" | "evaluation";
  time: {
    effectiveAt: string;
    observedAt: string;
    reportedAt: string | null;
    basis: "fire-ended" | "file-mtime" | "frontmatter" | "comment" | "event-ledger";
    trust: "scheduler" | "filesystem" | "reported";
    anomaly: "future-clamped" | "invalid" | null;
  };
  actor: { type: "agent" | "operator" | "system"; id: string | null };
  subject: { type: "project" | "fire" | "ticket" | "episode" | "document" | "report" | "evaluation"; id: string; label: string };
  status: "succeeded" | "failed" | "blocked" | "changed" | "observed";
  summary: string;
  detailRef: { kind: ProjectResourceKind; id: string } | null;
  completeness: "authoritative" | "derived" | "snapshot-only";
  metrics: ActivityMetrics | null;
  data: Record<string, string | number | boolean | null>;
};

export type LiveActivity = {
  id: string;
  agent: string;
  startedAt: string;
  elapsedSeconds: number;
  model: string | null;
  effort: string | null;
  logFile: string | null;
};

export type ActivityPage = {
  schemaVersion: 1;
  project: string;
  generatedAt: string;
  cursor: string | null;
  nextBeforeCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  items: ActivityEvent[];
  live: LiveActivity[];
  usage: {
    observedFires: number;
    durationSeconds: number;
    models: Record<string, number>;
    providers: Record<string, number>;
    tokenUsage: Fact<{ input: number; output: number }>;
    cost: Fact<{ currency: "USD"; amountMicros: number; basis: "reported" | "billed" | "estimated" }>;
  };
  warnings: Array<{ source: string; code: string; message: string }>;
};

/** The complete bounded projection used by persistent, rebuildable read models. */
export type ActivityScan = Pick<ActivityPage, "generatedAt" | "truncated" | "items" | "live" | "usage" | "warnings">;

type TailLine = { offset: number; raw: string };
type TailWindow = { lines: TailLine[]; truncated: boolean; countTruncated: boolean };
type Cursor = { v: 1; project: string; before: [string, string] };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const idFor = (...parts: Array<string | number>): string => digest(parts.join("\0")).slice(0, 24);
const known = <T>(value: T, source: "ledger" | "run-state" | "filesystem" | "derived"): Fact<T> => ({ state: "known", value, source });
const unknown = <T>(reason: "not-recorded" | "legacy-record" | "in-flight" | "unparseable"): Fact<T> => ({ state: "unknown", reason });
const notApplicable = <T>(reason: "provider-not-started" | "no-duration"): Fact<T> => ({ state: "not-applicable", reason });

function tailLines(file: string, maxBytes: number, maxLines: number, beforeOpen?: (file: string) => void): TailWindow {
  let stat;
  let identity: { dev: number; ino: number };
  try {
    stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return { lines: [], truncated: false, countTruncated: false };
    identity = { dev: stat.dev, ino: stat.ino };
  } catch { return { lines: [], truncated: false, countTruncated: false }; }
  let fd: number | undefined;
  try {
    beforeOpen?.(file);
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size === 0) return { lines: [], truncated: false, countTruncated: false };
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (!count) break;
      read += count;
    }
    let sliceStart = 0;
    let baseOffset = start;
    if (start > 0) {
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline < 0) return { lines: [], truncated: true, countTruncated: false };
      sliceStart = firstNewline + 1;
      baseOffset += sliceStart;
    }
    const lines: TailLine[] = [];
    let ringHead = 0;
    let countTruncated = false;
    let lineStart = sliceStart;
    for (let i = sliceStart; i <= buffer.length; i++) {
      if (i !== buffer.length && buffer[i] !== 0x0a) continue;
      const raw = buffer.subarray(lineStart, i).toString("utf8").trim();
      if (raw) {
        const item = { offset: baseOffset + (lineStart - sliceStart), raw };
        if (lines.length < maxLines) lines.push(item);
        else {
          lines[ringHead] = item;
          ringHead = (ringHead + 1) % maxLines;
          countTruncated = true;
        }
      }
      lineStart = i + 1;
    }
    const ordered = countTruncated ? [...lines.slice(ringHead), ...lines.slice(0, ringHead)] : lines;
    return { lines: ordered, truncated: start > 0, countTruncated };
  } catch {
    // Ledger rotation/removal between lstat and open is an expected observation race, not a 500.
    return { lines: [], truncated: false, countTruncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function eventTime(
  reported: string | null | undefined,
  fallback: string,
  nowMs: number,
  basis: ActivityEvent["time"]["basis"],
  trust: ActivityEvent["time"]["trust"],
): ActivityEvent["time"] {
  const fallbackMs = Date.parse(fallback);
  const safeFallback = Number.isFinite(fallbackMs) ? Math.min(fallbackMs, nowMs) : nowMs;
  const reportedMs = reported ? Date.parse(reported) : Number.NaN;
  let effective = safeFallback;
  let anomaly: ActivityEvent["time"]["anomaly"] = null;
  if (reported && Number.isNaN(reportedMs)) anomaly = "invalid";
  else if (reported && reportedMs > nowMs) anomaly = "future-clamped";
  else if (reported) effective = reportedMs;
  return {
    effectiveAt: new Date(effective).toISOString(),
    observedAt: new Date(nowMs).toISOString(),
    reportedAt: reported ?? null,
    basis,
    trust,
    anomaly,
  };
}

function fireMetrics(row: FireRow): ActivityMetrics {
  const neverStarted = Boolean(row.providerAuthMissing || row.spawnError);
  return {
    provider: typeof row.provider === "string" && row.provider ? known(row.provider, "ledger") : unknown("not-recorded"),
    model: typeof row.model === "string" && row.model ? known(row.model, "ledger") : unknown("not-recorded"),
    effort: typeof row.effort === "string" && row.effort ? known(row.effort, "ledger") : unknown("not-recorded"),
    durationSeconds: typeof row.durationSeconds === "number" ? known(row.durationSeconds, "ledger") : neverStarted ? notApplicable("no-duration") : unknown("legacy-record"),
    tokenUsage: neverStarted ? notApplicable("provider-not-started") : unknown("not-recorded"),
    cost: neverStarted ? notApplicable("provider-not-started") : unknown("not-recorded"),
  };
}

function fireKind(row: FireRow): { kind: ActivityKind; status: ActivityEvent["status"]; summary: string } {
  const agent = row.agent ?? "未知 agent";
  if (row.providerAuthMissing) return { kind: "fire.blocked", status: "blocked", summary: `${agent} 因 provider 认证未配置而未启动` };
  if (row.spawnError) return { kind: "fire.blocked", status: "blocked", summary: `${agent} 启动失败` };
  if (row.timedOut) return { kind: "fire.timed-out", status: "failed", summary: `${agent} 超时并完成进程组清理` };
  if (row.noop) return { kind: "fire.noop", status: "observed", summary: `${agent} 检查后无须改动` };
  if (isCleanFire(row)) return { kind: "fire.completed", status: "succeeded", summary: `${agent} 完成一次创作 fire` };
  return { kind: "fire.failed", status: "failed", summary: `${agent} fire 未干净完成` };
}

function fireEvents(
  key: string,
  data: string,
  nowMs: number,
  warnings: ActivityPage["warnings"],
  beforeOpen?: (file: string) => void,
): { events: ActivityEvent[]; rows: FireRow[] } {
  const tail = tailLines(join(data, "fires.jsonl"), FIRE_BYTES, MAX_FIRE_LINES, beforeOpen);
  if (tail.truncated) warnings.push({ source: "fires", code: "TAIL_TRUNCATED", message: `只投影 fires.jsonl 最后 ${FIRE_BYTES} bytes` });
  if (tail.countTruncated) warnings.push({ source: "fires", code: "COUNT_TRUNCATED", message: `只投影最近 ${MAX_FIRE_LINES} 条 fire 记录` });
  const events: ActivityEvent[] = [];
  const rows: FireRow[] = [];
  let invalidRows = 0;
  for (const line of tail.lines) {
    let row: FireRow | null;
    try { row = parseFireRow(JSON.parse(line.raw)); }
    catch { invalidRows++; continue; }
    if (!row) {
      invalidRows++;
      continue;
    }
    rows.push(row);
    const semantic = fireKind(row);
    const fallback = row.endedAt ?? row.startedAt ?? new Date(nowMs).toISOString();
    const time = eventTime(row.endedAt ?? row.startedAt, fallback, nowMs, "fire-ended", "scheduler");
    // Byte offsets are transport checkpoints, not event identity: compaction/rotation can move an
    // unchanged row. Fire rows normally carry scheduler timestamps, so canonical raw content gives
    // restart/rotation-stable idempotency while exact duplicate appends remain one logical record.
    const eventId = idFor("fire", key, line.raw);
    events.push({
      schemaVersion: 1,
      id: eventId,
      project: key,
      kind: semantic.kind,
      source: "fires",
      time,
      actor: { type: "agent", id: row.agent ?? null },
      subject: { type: "fire", id: eventId, label: row.agent ?? "fire" },
      status: semantic.status,
      summary: semantic.summary,
      detailRef: null,
      completeness: "authoritative",
      metrics: fireMetrics(row),
      data: {
        exitCode: typeof row.exitCode === "number" ? row.exitCode : null,
        timedOut: Boolean(row.timedOut),
        noop: Boolean(row.noop),
        descendantDrain: Boolean(row.descendantDrain),
      },
    });
  }
  if (invalidRows) warnings.push({ source: "fires", code: "INVALID_ROW", message: `跳过 ${invalidRows} 条无效 fire JSONL` });
  return { events, rows };
}

function ticketEvents(ws: Workspace, key: string, nowMs: number, warnings: ActivityPage["warnings"]): ActivityEvent[] {
  const data = projectDataDir(ws.root, key);
  const listed = listTickets(join(data, "board", "tickets"));
  let tickets = listed.tickets;
  if (listed.truncated) warnings.push({ source: "tickets", code: "COUNT_TRUNCATED", message: "票目录超过有界观测窗口" });
  if (listed.truncatedFiles) warnings.push({ source: "tickets", code: "FILE_TRUNCATED", message: `${listed.truncatedFiles} 张票的摘要只读取前 64 KiB` });
  if (tickets.length > MAX_TICKETS) {
    tickets = [...tickets].sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0)).slice(0, MAX_TICKETS);
    warnings.push({ source: "tickets", code: "COUNT_TRUNCATED", message: `只投影最近 ${MAX_TICKETS} 张票` });
  }
  const out: ActivityEvent[] = [];
  for (const ticket of tickets) {
    try {
      const resource = readProjectResource(ws, key, "ticket", ticket.id, {
        ticketFile: ticket.file,
        maxBytes: 64 * 1024,
        tailBytes: 128 * 1024,
      });
      const detail = resource.ticket!;
      if (resource.truncated) warnings.push({ source: `ticket:${ticket.id}`, code: "FILE_TRUNCATED", message: "票活动只读取 64 KiB 头与 128 KiB 尾；中段评论未投影" });
      const comments = detail.comments.slice(-MAX_COMMENTS_PER_TICKET);
      if (detail.comments.length > comments.length) warnings.push({ source: `ticket:${ticket.id}`, code: "COMMENTS_TRUNCATED", message: `只投影最后 ${MAX_COMMENTS_PER_TICKET} 条评论` });
      if (!comments.length) {
        const time = eventTime(ticket.updated || null, resource.updatedAt, nowMs, "frontmatter", "reported");
        out.push({
          schemaVersion: 1, id: idFor("ticket", key, ticket.id, ticket.updated, ticket.state), project: key,
          kind: "ticket.discovered", source: "ticket", time,
          actor: { type: ticket.assignee ? "agent" : "system", id: ticket.assignee ?? ticket.owner },
          subject: { type: "ticket", id: ticket.id, label: ticket.title }, status: "observed",
          summary: `${ticket.id} 当前为 ${ticket.state}`,
          detailRef: { kind: "ticket", id: ticket.id }, completeness: "snapshot-only", metrics: null,
          data: { state: ticket.state, episode: ticket.episode, malformed: ticket.malformed },
        });
        continue;
      }
      const seenComments = new Set<string>();
      for (const comment of comments) {
        const time = eventTime(comment.at, resource.updatedAt, nowMs, "comment", "reported");
        const changed = comment.stateChange;
        // Content identity remains stable when the bounded tail window advances. Exact duplicate
        // append records are one logical event and are intentionally coalesced.
        const commentId = idFor("ticket-comment", key, ticket.id, comment.at ?? "", comment.actor, comment.body);
        if (seenComments.has(commentId)) continue;
        seenComments.add(commentId);
        out.push({
          schemaVersion: 1,
          id: commentId,
          project: key,
          kind: changed ? "ticket.state-changed" : "ticket.commented",
          source: "ticket",
          time,
          actor: { type: /operator|操作者/i.test(comment.actor) ? "operator" : "agent", id: comment.actor || null },
          subject: { type: "ticket", id: ticket.id, label: ticket.title },
          status: "changed",
          summary: changed ? `${ticket.id}：${changed.from} → ${changed.to}` : `${ticket.id} 新增交接评论`,
          detailRef: { kind: "ticket", id: ticket.id },
          completeness: "authoritative",
          metrics: null,
          data: { from: changed?.from ?? null, to: changed?.to ?? null, state: ticket.state },
        });
      }
    } catch (error) {
      warnings.push({ source: `ticket:${ticket.id}`, code: "DETAIL_UNREADABLE", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

function observedEvent(
  key: string,
  source: ActivityEvent["source"],
  kind: ActivityKind,
  subjectType: ActivityEvent["subject"]["type"],
  id: string,
  label: string,
  updatedAt: string,
  nowMs: number,
  detailRef: ActivityEvent["detailRef"],
  data: ActivityEvent["data"] = {},
): ActivityEvent {
  return {
    schemaVersion: 1,
    id: idFor(source, key, id, updatedAt),
    project: key,
    kind,
    source,
    time: eventTime(null, updatedAt, nowMs, "file-mtime", "filesystem"),
    actor: { type: "system", id: null },
    subject: { type: subjectType, id, label },
    status: "observed",
    summary: `发现${label}的当前版本`,
    detailRef,
    completeness: "snapshot-only",
    metrics: null,
    data,
  };
}

function artifactEvents(ws: Workspace, key: string, nowMs: number, warnings: ActivityPage["warnings"]): ActivityEvent[] {
  const project = ws.config.projects?.[key]!;
  const repo = resolveRepoPath(ws.root, project);
  const out: ActivityEvent[] = [];
  for (const [docKey, label, path] of PROJECT_DOCUMENTS) {
    const parts = path.split("/");
    if (hasSymlinkComponent(repo, parts)) {
      warnings.push({ source: `document:${docKey}`, code: "UNSAFE_PATH", message: `${path} 含符号链接；拒绝活动投影` });
      continue;
    }
    try {
      const file = join(repo, ...parts);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      out.push(observedEvent(key, "document", "document.discovered", "document", docKey, label, stat.mtime.toISOString(), nowMs, { kind: "document", id: docKey }));
    } catch { /* 缺文档不是活动错误 */ }
  }
  const episodesUnsafe = hasSymlinkComponent(repo, ["episodes"]);
  if (episodesUnsafe) warnings.push({ source: "episodes", code: "UNSAFE_PATH", message: "分集目录含符号链接；拒绝活动投影" });
  const episodeScan = episodesUnsafe ? { names: [], truncated: false } : readDirectoryNames(join(repo, "episodes"), 2_048);
  let episodeNames = episodeScan.names.filter((name) => episodeNumberFromFile(name) !== null)
    .sort((a, b) => episodeNumberFromFile(a)! - episodeNumberFromFile(b)!);
  if (episodeScan.truncated || episodeNames.length > MAX_ARTIFACTS_PER_KIND) {
    episodeNames = episodeNames.slice(-MAX_ARTIFACTS_PER_KIND);
    warnings.push({ source: "episodes", code: "COUNT_TRUNCATED", message: `只投影 ${MAX_ARTIFACTS_PER_KIND} 个分集文件` });
  }
  for (const file of episodeNames) {
    try {
      const stat = lstatSync(join(repo, "episodes", file));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const number = episodeNumberFromFile(file)!;
      out.push(observedEvent(key, "episode", "episode.discovered", "episode", String(number), `第 ${number} 集`, stat.mtime.toISOString(), nowMs, { kind: "episode", id: String(number) }, { episode: number }));
    } catch { /* 扫描竞争 */ }
  }
  const reportsUnsafe = hasSymlinkComponent(ws.root, [".writing-loop", key, "reports"]);
  const evaluationsUnsafe = hasSymlinkComponent(repo, ["evaluation"]);
  if (reportsUnsafe) warnings.push({ source: "reports", code: "UNSAFE_PATH", message: "报告目录含符号链接；拒绝活动投影" });
  if (evaluationsUnsafe) warnings.push({ source: "evaluations", code: "UNSAFE_PATH", message: "评估目录含符号链接；拒绝活动投影" });
  const allReports = reportsUnsafe ? { rows: [], truncated: false } : listProjectReportsBounded(ws, key);
  const allEvaluations = evaluationsUnsafe ? { rows: [], truncated: false } : listProjectEvaluationsBounded(ws, key);
  if (allReports.truncated || allReports.rows.length > MAX_ARTIFACTS_PER_KIND) {
    warnings.push({ source: "reports", code: "COUNT_TRUNCATED", message: `只投影最近 ${MAX_ARTIFACTS_PER_KIND} 份创作报告` });
  }
  if (allEvaluations.truncated || allEvaluations.rows.length > MAX_ARTIFACTS_PER_KIND) {
    warnings.push({ source: "evaluations", code: "COUNT_TRUNCATED", message: `只投影最近 ${MAX_ARTIFACTS_PER_KIND} 份里程碑评估` });
  }
  const reportRows = allReports.rows.slice(0, MAX_ARTIFACTS_PER_KIND);
  const evaluationRows = allEvaluations.rows.slice(0, MAX_ARTIFACTS_PER_KIND);
  for (const row of reportRows) out.push(observedEvent(
    key, "report", row.review ? "report.reviewed" : "report.discovered", "report", row.id, row.label,
    row.updatedAt, nowMs, { kind: "report", id: row.id }, { bytes: row.bytes, review: row.review },
  ));
  for (const row of evaluationRows) out.push(observedEvent(
    key, "evaluation", "evaluation.discovered", "evaluation", row.id, row.label,
    row.updatedAt, nowMs, { kind: "evaluation", id: row.id }, { bytes: row.bytes },
  ));
  return out;
}

function projectLedgerEvents(
  key: string,
  data: string,
  nowMs: number,
  warnings: ActivityPage["warnings"],
  beforeOpen?: (file: string) => void,
): ActivityEvent[] {
  const tail = tailLines(join(data, "events.jsonl"), EVENT_BYTES, MAX_EVENT_LINES, beforeOpen);
  if (tail.truncated) warnings.push({ source: "events", code: "TAIL_TRUNCATED", message: `只投影 events.jsonl 最后 ${EVENT_BYTES} bytes` });
  if (tail.countTruncated) warnings.push({ source: "events", code: "COUNT_TRUNCATED", message: `只投影最近 ${MAX_EVENT_LINES} 条 project event` });
  const out: ActivityEvent[] = [];
  let invalidRows = 0;
  for (const line of tail.lines) {
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line.raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event row must be an object");
      row = value as Record<string, unknown>;
    } catch {
      invalidRows++;
      continue;
    }
    const rawType = typeof row.type === "string" ? row.type : "";
    const kind: ActivityKind | null = rawType === "project.created" ? "project.created"
      : rawType === "project.paused" ? "project.paused" : rawType === "project.resumed" ? "project.resumed" : null;
    if (!kind) continue;
    const at = typeof row.at === "string" ? row.at : new Date(nowMs).toISOString();
    out.push({
      schemaVersion: 1,
      // An absent producer id falls back to content, never byte offset: ledger compaction must not
      // turn an already-indexed row into a second event.
      id: typeof row.id === "string" ? row.id : idFor("events", key, line.raw),
      project: key,
      kind,
      source: "events",
      time: eventTime(at, at, nowMs, "event-ledger", "reported"),
      actor: { type: row.actor === "operator" ? "operator" : "system", id: typeof row.actor === "string" ? row.actor : null },
      subject: { type: "project", id: key, label: typeof row.title === "string" ? row.title : key },
      status: "changed",
      summary: typeof row.detail === "string" ? row.detail : typeof row.title === "string" ? row.title : rawType,
      detailRef: null,
      completeness: "authoritative",
      metrics: null,
      data: {},
    });
  }
  if (invalidRows) warnings.push({ source: "events", code: "INVALID_ROW", message: `跳过 ${invalidRows} 条无效 project event JSONL` });
  return out;
}

function liveActivities(state: SchedulerView, nowMs: number): LiveActivity[] {
  if (state.state !== "running" && state.state !== "stopping") return [];
  const out: LiveActivity[] = [];
  for (const row of state.inFlight) {
    const started = Date.parse(row.startedAt);
    out.push({
      id: idFor("live", row.agent, row.startedAt, row.pid ?? ""),
      agent: row.agent,
      startedAt: row.startedAt,
      elapsedSeconds: Number.isFinite(started) ? Math.max(0, Math.round((nowMs - started) / 1_000)) : 0,
      model: row.model || null,
      effort: row.effort || null,
      logFile: row.logFile || null,
    });
  }
  return out;
}

/** Live state is deliberately read outside the historical index. */
export function readProjectLiveActivity(
  ws: Workspace,
  key: string,
  nowMs = Date.now(),
): { live: LiveActivity[]; warnings: ActivityPage["warnings"] } {
  assertProjectKey(key);
  if (!Object.prototype.hasOwnProperty.call(ws.config.projects ?? {}, key)) throw new WsError(`config.json 无项目 '${key}'`);
  const scheduler = readSchedulerView(projectDataDir(ws.root, key), nowMs);
  const warnings: ActivityPage["warnings"] = [];
  if (scheduler.state === "stale") warnings.push({ source: "live", code: "STALE_RUN_STATE", message: "run-state 无匹配的新鲜 scheduler holder lock；不显示 live agent" });
  return { live: liveActivities(scheduler, nowMs), warnings };
}

function encodeCursor(key: string, item: ActivityEvent): string {
  return Buffer.from(JSON.stringify({ v: 1, project: key, before: [item.time.effectiveAt, item.id] } satisfies Cursor)).toString("base64url");
}

function decodeCursor(value: string, key: string): Cursor {
  if (value.length > 1_024) throw new WsError("activity cursor 过长");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new WsError("activity cursor 无效"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new WsError("activity cursor 无效");
  const row = decoded as Record<string, unknown>;
  if (row.v !== 1 || row.project !== key || !Array.isArray(row.before) || row.before.length !== 2
    || row.before.some((part) => typeof part !== "string")) throw new WsError("activity cursor 与项目或 schema 不匹配");
  return row as unknown as Cursor;
}

const order = (a: ActivityEvent, b: ActivityEvent): number =>
  b.time.effectiveAt.localeCompare(a.time.effectiveAt) || b.id.localeCompare(a.id);

const olderThan = (event: ActivityEvent, before: Cursor["before"]): boolean =>
  event.time.effectiveAt < before[0] || (event.time.effectiveAt === before[0] && event.id < before[1]);

/**
 * Performs one complete bounded source scan. This is public so the persistent index can bootstrap
 * from exactly the same projection as the backwards-compatible v1 endpoint.
 */
export function scanProjectActivity(
  ws: Workspace,
  key: string,
  options: { nowMs?: number; beforeLedgerOpen?: (file: string) => void } = {},
): ActivityScan {
  assertProjectKey(key);
  if (!Object.prototype.hasOwnProperty.call(ws.config.projects ?? {}, key)) throw new WsError(`config.json 无项目 '${key}'`);
  if (hasSymlinkComponent(ws.root, [".writing-loop", key, "board", "tickets"])) throw new WsError(`项目 '${key}' 的运行态路径含符号链接`);
  const nowMs = options.nowMs ?? Date.now();
  const data = projectDataDir(ws.root, key);
  const warnings: ActivityPage["warnings"] = [];
  const fires = fireEvents(key, data, nowMs, warnings, options.beforeLedgerOpen);
  const live = readProjectLiveActivity(ws, key, nowMs);
  warnings.push(...live.warnings);
  const items = [
    ...projectLedgerEvents(key, data, nowMs, warnings, options.beforeLedgerOpen),
    ...fires.events,
    ...ticketEvents(ws, key, nowMs, warnings),
    ...artifactEvents(ws, key, nowMs, warnings),
  ].sort(order);
  const models = Object.create(null) as Record<string, number>;
  const providers = Object.create(null) as Record<string, number>;
  let durationSeconds = 0;
  for (const row of fires.rows) {
    if (typeof row.durationSeconds === "number") durationSeconds += row.durationSeconds;
    if (typeof row.model === "string" && row.model) models[row.model] = (models[row.model] ?? 0) + 1;
    if (typeof row.provider === "string" && row.provider) providers[row.provider] = (providers[row.provider] ?? 0) + 1;
  }
  return {
    generatedAt: new Date(nowMs).toISOString(),
    truncated: warnings.some((warning) => warning.code.includes("TRUNCATED")),
    items,
    live: live.live,
    usage: {
      observedFires: fires.rows.length,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      models,
      providers,
      tokenUsage: unknown("not-recorded"),
      cost: unknown("not-recorded"),
    },
    warnings,
  };
}

export function buildProjectActivity(
  ws: Workspace,
  key: string,
  options: { limit?: number; before?: string | null; nowMs?: number; beforeLedgerOpen?: (file: string) => void } = {},
): ActivityPage {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)));
  const nowMs = options.nowMs ?? Date.now();
  const scan = scanProjectActivity(ws, key, { nowMs, beforeLedgerOpen: options.beforeLedgerOpen });
  let items = scan.items;
  const cursor = options.before ? decodeCursor(options.before, key) : null;
  if (cursor) items = items.filter((item) => olderThan(item, cursor.before));
  const hasMore = items.length > limit;
  const pageItems = items.slice(0, limit);
  return {
    schemaVersion: 1,
    project: key,
    generatedAt: new Date(nowMs).toISOString(),
    cursor: pageItems[0] ? encodeCursor(key, pageItems[0]) : null,
    nextBeforeCursor: hasMore && pageItems.at(-1) ? encodeCursor(key, pageItems.at(-1)!) : null,
    hasMore,
    truncated: scan.truncated,
    items: pageItems,
    live: scan.live,
    usage: scan.usage,
    warnings: scan.warnings,
  };
}
