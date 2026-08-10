// Persistent, rebuildable activity read model. Source ledgers/tickets/artifacts remain authoritative;
// this file only avoids repeated deep scans and provides restart-stable pagination/SSE cursors.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync,
  unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  readProjectLiveActivity, scanProjectActivity,
  type ActivityEvent, type ActivityPage, type LiveActivity,
} from "./activity.ts";
import { hasSymlinkComponent, readDirectoryNames } from "./bounded-fs.ts";
import { PROJECT_DOCUMENTS } from "./project-detail.ts";
import { assertProjectKey, projectDataDir, resolveRepoPath, WsError, type Workspace } from "./workspace.ts";

const INDEX_FILE = "activity-index.v2.json";
const LOCK_FILE = ".activity-index.v2.lock";
const DEFAULT_MAX_EVENTS = 5_000;
const HARD_MAX_EVENTS = 10_000;
const DEFAULT_MAX_INDEX_BYTES = 16 * 1024 * 1024;
const HARD_MAX_INDEX_BYTES = 32 * 1024 * 1024;
const SIGNATURE_DIRECTORY_ENTRIES = 4_096;
const MAX_WARNINGS = 256;

type Warning = ActivityPage["warnings"][number];
type Usage = ActivityPage["usage"];

const ACTIVITY_KINDS = new Set([
  "project.created", "project.paused", "project.resumed",
  "fire.completed", "fire.failed", "fire.timed-out", "fire.noop", "fire.blocked",
  "ticket.discovered", "ticket.commented", "ticket.state-changed",
  "episode.discovered", "document.discovered", "report.discovered", "report.reviewed", "evaluation.discovered",
]);
const ACTIVITY_SOURCES = new Set(["events", "fires", "ticket", "episode", "document", "report", "evaluation"]);
const SUBJECT_TYPES = new Set(["project", "fire", "ticket", "episode", "document", "report", "evaluation"]);
const RESOURCE_KINDS = new Set(["ticket", "document", "episode", "report", "evaluation"]);
const FACT_SOURCES = new Set(["ledger", "run-state", "filesystem", "derived"]);
const UNKNOWN_REASONS = new Set(["not-recorded", "legacy-record", "in-flight", "unparseable"]);
const NOT_APPLICABLE_REASONS = new Set(["provider-not-started", "no-duration"]);

export type ActivitySourceCheckpoint = {
  path: string;
  kind: "missing" | "file" | "directory" | "other";
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  entriesTruncated?: boolean;
};

export type ActivitySourceSignature = {
  digest: string;
  checkpoints: ActivitySourceCheckpoint[];
};

export type ActivityIndexSnapshot = {
  schemaVersion: 2;
  workspaceId: string;
  project: string;
  generation: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: ActivitySourceSignature;
  items: ActivityEvent[];
  usage: Usage;
  warnings: Warning[];
  truncated: boolean;
  droppedEvents: number;
};

export type IndexedActivityPage = {
  schemaVersion: 2;
  workspaceId: string;
  project: string;
  generation: string;
  revision: number;
  generatedAt: string;
  cursor: string | null;
  nextBeforeCursor: string | null;
  sseCursor: string;
  hasMore: boolean;
  truncated: boolean;
  items: ActivityEvent[];
  live: LiveActivity[];
  usage: Usage;
  warnings: Warning[];
};

export type ActivityIndexerHooks = {
  /** Tests/observability seam: called only when a full source projection will be built. */
  beforeDeepScan?: (project: string) => void;
  /** Fault-injection seam after durable temp fsync, before atomic replacement. */
  beforeRename?: (temporaryFile: string, indexFile: string) => void;
};

export type ActivityIndexerOptions = {
  maxEvents?: number;
  maxIndexBytes?: number;
  hooks?: ActivityIndexerHooks;
};

type BeforeCursor = {
  v: 2;
  kind: "before";
  workspaceId: string;
  project: string;
  generation: string;
  before: [string, string];
};

type SseCursor = {
  v: 2;
  kind: "sse";
  workspaceId: string;
  project: string;
  generation: string;
  revision: number;
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const order = (a: ActivityEvent, b: ActivityEvent): number =>
  b.time.effectiveAt.localeCompare(a.time.effectiveAt) || b.id.localeCompare(a.id);
const tupleOf = (event: ActivityEvent): [string, string] => [event.time.effectiveAt, event.id];
const sameTuple = (event: ActivityEvent, tuple: [string, string]): boolean =>
  event.time.effectiveAt === tuple[0] && event.id === tuple[1];
const olderThan = (event: ActivityEvent, before: [string, string]): boolean =>
  event.time.effectiveAt < before[0] || (event.time.effectiveAt === before[0] && event.id < before[1]);

function requireWorkspaceId(workspaceId: string): void {
  if (!workspaceId || workspaceId.length > 256 || /[\0\r\n]/.test(workspaceId)) {
    throw new WsError("activity workspaceId 无效");
  }
}

function encodeCursor(cursor: BeforeCursor | SseCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeBeforeCursor(
  value: string,
  workspaceId: string,
  project: string,
  generation: string,
): BeforeCursor {
  if (value.length > 2_048) throw new WsError("activity cursor 过长");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new WsError("activity cursor 无效"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new WsError("activity cursor 无效");
  const row = decoded as Record<string, unknown>;
  if (row.v !== 2 || row.kind !== "before" || row.workspaceId !== workspaceId || row.project !== project
    || row.generation !== generation || !Array.isArray(row.before) || row.before.length !== 2
    || row.before.some((part) => typeof part !== "string")) {
    throw new WsError("activity cursor 与 workspace、项目或 generation 不匹配");
  }
  return row as unknown as BeforeCursor;
}

function checkpoint(file: string, relative: string): ActivitySourceCheckpoint {
  try {
    const stat = lstatSync(file);
    const kind = stat.isSymbolicLink() ? "other" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
    return {
      path: relative, kind, dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs), ctimeMs: Math.trunc(stat.ctimeMs),
    };
  } catch {
    return { path: relative, kind: "missing" };
  }
}

function directoryCheckpoints(root: string, relative: string): ActivitySourceCheckpoint[] {
  const directory = join(root, relative);
  const own = checkpoint(directory, relative);
  if (own.kind !== "directory") return [own];
  const names = readDirectoryNames(directory, SIGNATURE_DIRECTORY_ENTRIES);
  own.entriesTruncated = names.truncated;
  const rows = [own];
  for (const name of names.names.sort()) rows.push(checkpoint(join(directory, name), `${relative}/${name}`));
  return rows;
}

/** Cheap metadata-only signature; source content is parsed only when this changes. */
export function buildActivitySourceSignature(ws: Workspace, project: string): ActivitySourceSignature {
  assertProjectKey(project);
  const entry = ws.config.projects?.[project];
  if (!entry || typeof entry !== "object") throw new WsError(`config.json 无项目 '${project}'`);
  const data = projectDataDir(ws.root, project);
  const repo = resolveRepoPath(ws.root, entry);
  const rows: ActivitySourceCheckpoint[] = [
    checkpoint(join(data, "fires.jsonl"), "state/fires.jsonl"),
    checkpoint(join(data, "events.jsonl"), "state/events.jsonl"),
    ...directoryCheckpoints(data, "board/tickets"),
    ...directoryCheckpoints(data, "reports"),
    ...directoryCheckpoints(repo, "episodes"),
    ...directoryCheckpoints(repo, "evaluation"),
  ];
  for (const [, , path] of PROJECT_DOCUMENTS) rows.push(checkpoint(join(repo, path), `repo/${path}`));
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { digest: digest(JSON.stringify({ project: entry, rows })), checkpoints: rows };
}

function ensureSafeProjectDirectory(ws: Workspace, project: string): string {
  assertProjectKey(project);
  if (!Object.prototype.hasOwnProperty.call(ws.config.projects ?? {}, project)) throw new WsError(`config.json 无项目 '${project}'`);
  if (hasSymlinkComponent(ws.root, [".writing-loop", project])) throw new WsError(`项目 '${project}' 的 activity index 路径含符号链接`);
  const data = projectDataDir(ws.root, project);
  try {
    const stat = lstatSync(data);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WsError(`项目 '${project}' 的 activity index 目录不安全`);
  } catch (error) {
    if (error instanceof WsError) throw error;
    throw new WsError(`项目 '${project}' 的 activity index 目录不存在`);
  }
  return data;
}

function unsafeIndex(message: string): never {
  throw new WsError(`activity index 不安全：${message}`);
}

function readIndexFile(file: string, maxBytes: number): { value: unknown | null; invalid: boolean } {
  let before;
  try { before = lstatSync(file); }
  catch { return { value: null, invalid: false }; }
  if (!before.isFile() || before.isSymbolicLink()) unsafeIndex(`${basename(file)} 必须是普通文件`);
  if (before.nlink !== 1) unsafeIndex(`${basename(file)} 不得是硬链接`);
  if (before.size > maxBytes) return { value: null, invalid: true };
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1) {
      unsafeIndex(`${basename(file)} 在校验与读取间发生替换`);
    }
    if (stat.size > maxBytes) return { value: null, invalid: true };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== buffer.length) return { value: null, invalid: true };
    try { return { value: JSON.parse(buffer.toString("utf8")), invalid: false }; }
    catch { return { value: null, invalid: true }; }
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* read result remains valid */ }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown, max = 8_192): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isIso = (value: unknown): value is string => isString(value, 128) && Number.isFinite(Date.parse(value));

function isWarning(value: unknown): value is Warning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return isString(row.source, 1_024) && isString(row.code, 256) && isString(row.message, 8_192);
}

function isFact(value: unknown, knownValue: (candidate: unknown) => boolean): boolean {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "known") return FACT_SOURCES.has(String(value.source)) && knownValue(value.value);
  if (value.state === "unknown") return UNKNOWN_REASONS.has(String(value.reason));
  if (value.state === "not-applicable") return NOT_APPLICABLE_REASONS.has(String(value.reason));
  return false;
}

const isTokenUsage = (value: unknown): boolean => isRecord(value)
  && Number.isSafeInteger(value.input) && (value.input as number) >= 0
  && Number.isSafeInteger(value.output) && (value.output as number) >= 0;
const isCost = (value: unknown): boolean => isRecord(value) && value.currency === "USD"
  && Number.isSafeInteger(value.amountMicros) && (value.amountMicros as number) >= 0
  && new Set(["reported", "billed", "estimated"]).has(String(value.basis));

function isMetrics(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return isFact(value.provider, (candidate) => isString(candidate, 1_024))
    && isFact(value.model, (candidate) => isString(candidate, 1_024))
    && isFact(value.effort, (candidate) => isString(candidate, 256))
    && isFact(value.durationSeconds, (candidate) => isFiniteNumber(candidate) && candidate >= 0)
    && isFact(value.tokenUsage, isTokenUsage)
    && isFact(value.cost, isCost);
}

function isCountMap(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length > 2_048) return false;
  return Object.entries(value).every(([key, count]) => isString(key, 1_024)
    && Number.isSafeInteger(count) && (count as number) >= 0);
}

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.observedFires) && (value.observedFires as number) >= 0
    && isFiniteNumber(value.durationSeconds) && value.durationSeconds >= 0
    && isCountMap(value.models) && isCountMap(value.providers)
    && isFact(value.tokenUsage, isTokenUsage) && isFact(value.cost, isCost);
}

function isSourceSignature(value: unknown): value is ActivitySourceSignature {
  if (!isRecord(value) || !/^[a-f0-9]{64}$/.test(String(value.digest)) || !Array.isArray(value.checkpoints)
    || value.checkpoints.length > SIGNATURE_DIRECTORY_ENTRIES * 4 + 64) return false;
  return value.checkpoints.every((candidate) => {
    if (!isRecord(candidate) || !isString(candidate.path, 4_096)
      || !new Set(["missing", "file", "directory", "other"]).has(String(candidate.kind))) return false;
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const) {
      if (candidate[field] !== undefined && !isFiniteNumber(candidate[field])) return false;
    }
    return candidate.entriesTruncated === undefined || typeof candidate.entriesTruncated === "boolean";
  });
}

function isEvent(value: unknown, project: string): value is ActivityEvent {
  if (!isRecord(value)) return false;
  const row = value as Record<string, unknown>;
  const time = row.time;
  const actor = row.actor;
  const subject = row.subject;
  const detailRef = row.detailRef;
  if (row.schemaVersion !== 1 || row.project !== project || !isString(row.id, 512) || !row.id
    || !ACTIVITY_KINDS.has(String(row.kind)) || !ACTIVITY_SOURCES.has(String(row.source))
    || !isRecord(time) || !isIso(time.effectiveAt) || !isIso(time.observedAt)
    || !(time.reportedAt === null || isString(time.reportedAt, 1_024))
    || !new Set(["fire-ended", "file-mtime", "frontmatter", "comment", "event-ledger"]).has(String(time.basis))
    || !new Set(["scheduler", "filesystem", "reported"]).has(String(time.trust))
    || !(time.anomaly === null || new Set(["future-clamped", "invalid"]).has(String(time.anomaly)))
    || !isRecord(actor) || !new Set(["agent", "operator", "system"]).has(String(actor.type))
    || !(actor.id === null || isString(actor.id, 1_024))
    || !isRecord(subject) || !SUBJECT_TYPES.has(String(subject.type)) || !isString(subject.id, 1_024)
    || !isString(subject.label, 65_536)
    || !new Set(["succeeded", "failed", "blocked", "changed", "observed"]).has(String(row.status))
    || !isString(row.summary, 131_072)
    || !(detailRef === null || (isRecord(detailRef) && RESOURCE_KINDS.has(String(detailRef.kind)) && isString(detailRef.id, 1_024)))
    || !new Set(["authoritative", "derived", "snapshot-only"]).has(String(row.completeness))
    || !isMetrics(row.metrics) || !isRecord(row.data)) return false;
  return Object.values(row.data).every((item) => item === null || typeof item === "string"
    || typeof item === "boolean" || isFiniteNumber(item));
}

function parseIndex(value: unknown, maxEvents: number): ActivityIndexSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 2 || typeof row.workspaceId !== "string" || typeof row.project !== "string"
    || !/^[a-f0-9]{32}$/.test(String(row.generation)) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || !isIso(row.createdAt) || !isIso(row.updatedAt)
    || !isSourceSignature(row.source)
    || !Array.isArray(row.items) || row.items.length > maxEvents || !row.items.every((item) => isEvent(item, row.project as string))
    || !isUsage(row.usage)
    || !Array.isArray(row.warnings) || row.warnings.length > MAX_WARNINGS || !row.warnings.every(isWarning)
    || typeof row.truncated !== "boolean" || !Number.isSafeInteger(row.droppedEvents) || (row.droppedEvents as number) < 0) return null;
  return row as unknown as ActivityIndexSnapshot;
}

function assertReplaceableIndex(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) unsafeIndex(`${basename(file)} 拒绝替换非独占普通文件`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function serializedBytes(value: ActivityIndexSnapshot): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function atomicWriteIndex(file: string, value: ActivityIndexSnapshot, maxBytes: number, hooks: ActivityIndexerHooks): void {
  const directory = dirname(file);
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  const bytes = serializedBytes(value);
  if (bytes.length > maxBytes) throw new WsError(`activity index 元数据超过 ${maxBytes} bytes 安全预算`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertReplaceableIndex(file);
    hooks.beforeRename?.(temporary, file);
    renameSync(temporary, file);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* cleanup below */ }
    try { unlinkSync(temporary); } catch { /* renamed or already absent */ }
  }
}

function withProjectLock<T>(data: string, operation: () => T): T {
  const file = join(data, LOCK_FILE);
  let fd: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    try {
      fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WsError("activity index 正由另一个进程刷新");
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) unsafeIndex("刷新锁必须是独占普通文件");
    identity = { dev: stat.dev, ino: stat.ino };
    writeSync(fd, Buffer.from(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`));
    fsyncSync(fd);
    return operation();
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* release path still checked */ }
    if (identity) {
      try {
        const current = lstatSync(file);
        if (!current.isSymbolicLink() && current.isFile() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(file);
      } catch { /* never unlink a replacement lock */ }
    }
  }
}

function mergeWarnings(...groups: Warning[][]): Warning[] {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const warning of groups.flat()) {
    const key = `${warning.source}\0${warning.code}\0${warning.message}`;
    if (!seen.has(key) && out.length < MAX_WARNINGS) { seen.add(key); out.push(warning); }
  }
  return out;
}

export class ActivityIndexer {
  readonly #ws: Workspace;
  readonly #maxEvents: number;
  readonly #maxIndexBytes: number;
  readonly #hooks: ActivityIndexerHooks;

  constructor(ws: Workspace, options: ActivityIndexerOptions = {}) {
    this.#ws = ws;
    this.#maxEvents = Math.min(HARD_MAX_EVENTS, Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS)));
    this.#maxIndexBytes = Math.min(HARD_MAX_INDEX_BYTES, Math.max(64 * 1024, Math.trunc(options.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES)));
    this.#hooks = options.hooks ?? {};
  }

  #load(workspaceId: string, project: string): { index: ActivityIndexSnapshot | null; invalid: boolean } {
    const data = ensureSafeProjectDirectory(this.#ws, project);
    const read = readIndexFile(join(data, INDEX_FILE), this.#maxIndexBytes);
    const index = parseIndex(read.value, this.#maxEvents);
    const mismatched = Boolean(index && (index.workspaceId !== workspaceId || index.project !== project));
    // This file is explicitly a rebuildable cache. A stale synthetic workspace ID from the
    // pre-registry era or a malformed project binding invalidates old cursors, but must not brick
    // the authoritative workspace until an operator manually deletes the cache.
    return { index: mismatched ? null : index, invalid: read.invalid || mismatched || (read.value !== null && !index) };
  }

  refresh(workspaceId: string, project: string, options: { nowMs?: number } = {}): ActivityIndexSnapshot {
    requireWorkspaceId(workspaceId);
    const data = ensureSafeProjectDirectory(this.#ws, project);
    // The common SSE poll path is read-only when source metadata has not moved. Avoid creating and
    // fsyncing a lock file every poll/project; a concurrent writer can safely publish a newer
    // revision after this observation and the next poll will see it. Changed/invalid state is
    // rechecked under the lock below before any durable replacement.
    const optimistic = this.#load(workspaceId, project);
    const optimisticSource = buildActivitySourceSignature(this.#ws, project);
    if (optimistic.index && optimistic.index.source.digest === optimisticSource.digest) return optimistic.index;
    return withProjectLock(data, () => {
      const loaded = this.#load(workspaceId, project);
      const source = buildActivitySourceSignature(this.#ws, project);
      if (loaded.index && loaded.index.source.digest === source.digest) return loaded.index;

      this.#hooks.beforeDeepScan?.(project);
      const nowMs = options.nowMs ?? Date.now();
      const scan = scanProjectActivity(this.#ws, project, { nowMs });
      const byId = new Map<string, ActivityEvent>();
      for (const event of loaded.index?.items ?? []) byId.set(event.id, event);
      for (const event of scan.items) byId.set(event.id, event);
      const merged = [...byId.values()].sort(order);
      const droppedNow = Math.max(0, merged.length - this.#maxEvents);
      const items = merged.slice(0, this.#maxEvents);
      let droppedEvents = (loaded.index?.droppedEvents ?? 0) + droppedNow;
      const structuralWarnings = scan.warnings.filter((warning) => warning.source !== "live");
      if (!loaded.index && scan.truncated) structuralWarnings.push({
        source: "index", code: "BOOTSTRAP_GAP", message: "首次索引来自有界活动扫描；窗口之前的历史未进入索引",
      });
      if (loaded.invalid) structuralWarnings.push({
        source: "index", code: "INDEX_REBUILT", message: "既有索引无效或超出读取预算；已从非权威缓存外的源重建",
      });
      const now = new Date(nowMs).toISOString();
      const index: ActivityIndexSnapshot = {
        schemaVersion: 2,
        workspaceId,
        project,
        generation: loaded.index?.generation ?? randomBytes(16).toString("hex"),
        revision: (loaded.index?.revision ?? 0) + 1,
        createdAt: loaded.index?.createdAt ?? now,
        updatedAt: now,
        source,
        items,
        usage: scan.usage,
        warnings: mergeWarnings(
          (loaded.index?.warnings ?? []).filter((warning) => warning.code !== "RETENTION_TRUNCATED"),
          structuralWarnings,
        ),
        truncated: scan.truncated || droppedEvents > 0 || Boolean(loaded.index?.truncated),
        droppedEvents,
      };
      // Count is not enough: unusually large summaries/checkpoints must obey the byte budget too.
      while (index.items.length && serializedBytes(index).length > this.#maxIndexBytes) {
        index.items.pop();
        droppedEvents++;
        index.droppedEvents = droppedEvents;
        index.truncated = true;
      }
      if (droppedEvents) index.warnings = mergeWarnings(index.warnings, [{
        source: "index", code: "RETENTION_TRUNCATED",
        message: `索引硬上限 ${this.#maxEvents} 条 / ${this.#maxIndexBytes} bytes；累计丢弃 ${droppedEvents} 条旧事件，旧 cursor 将过期`,
      }]);
      atomicWriteIndex(join(data, INDEX_FILE), index, this.#maxIndexBytes, this.#hooks);
      return index;
    });
  }

  read(workspaceId: string, project: string): ActivityIndexSnapshot | null {
    requireWorkspaceId(workspaceId);
    return this.#load(workspaceId, project).index;
  }

  buildPage(
    workspaceId: string,
    project: string,
    options: { limit?: number; before?: string | null; nowMs?: number; refresh?: boolean } = {},
  ): IndexedActivityPage {
    requireWorkspaceId(workspaceId);
    const index = options.refresh === false ? this.read(workspaceId, project) ?? this.refresh(workspaceId, project, options)
      : this.refresh(workspaceId, project, options);
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)));
    let items = index.items;
    if (options.before) {
      const cursor = decodeBeforeCursor(options.before, workspaceId, project, index.generation);
      if (!index.items.some((event) => sameTuple(event, cursor.before))) {
        throw new WsError("activity cursor 已过期（索引 retention 或 generation 已推进）");
      }
      items = items.filter((event) => olderThan(event, cursor.before));
    }
    const hasMore = items.length > limit;
    const pageItems = items.slice(0, limit);
    const beforeCursor = (event: ActivityEvent): string => encodeCursor({
      v: 2, kind: "before", workspaceId, project, generation: index.generation, before: tupleOf(event),
    });
    const live = readProjectLiveActivity(this.#ws, project, options.nowMs ?? Date.now());
    return {
      schemaVersion: 2,
      workspaceId,
      project,
      generation: index.generation,
      revision: index.revision,
      generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
      cursor: pageItems[0] ? beforeCursor(pageItems[0]) : null,
      nextBeforeCursor: hasMore && pageItems.at(-1) ? beforeCursor(pageItems.at(-1)!) : null,
      sseCursor: encodeCursor({
        v: 2, kind: "sse", workspaceId, project, generation: index.generation, revision: index.revision,
      }),
      hasMore,
      truncated: index.truncated,
      items: pageItems,
      live: live.live,
      usage: index.usage,
      warnings: mergeWarnings(index.warnings, live.warnings),
    };
  }
}
