// Per-project authoritative production state.
//
// The store is deliberately synchronous and zero-dependency: mutation volume is small, while the
// lock/re-read/fsync ordering is much easier to audit when no promise can escape the critical
// section. Readers see either a complete old document or a complete new one.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  MAX_PRODUCTION_TASKS,
  ProductionError,
  compareProductionAscii,
  parseProductionState,
  parseProductionTaskCreate,
  parseProductionTaskEvent,
  productionEventDigest,
  taskFromCreate,
  transitionProductionTask,
  type ProductionState,
  type ProductionTask,
  type ProductionTaskCreate,
  type ProductionTaskEvent,
} from "./production-domain.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_STATE_FILE = "production-state.v1.json";
export const PRODUCTION_LOCK_FILE = ".production-state.v1.lock";
export const PRODUCTION_ACQUISITION_GATE_FILE = ".production-state.v1.acquire";
export const MAX_PRODUCTION_STATE_BYTES = 16 * 1024 * 1024;

export type ProductionStoreHooks = {
  /** Test/diagnostic seam: lock metadata is durable, but the authoritative file has not been read. */
  afterLock?: (lockFile: string) => void;
  /** Race seam after a lock owner is proven dead, before the final inode check and unlink. */
  beforeDeadOwnerRecovery?: (lockFile: string) => void;
  /** Fault/race seam: the complete temporary file is durable, but rename has not occurred. */
  beforeRename?: (temporaryFile: string, stateFile: string) => void;
  /** Test seam; production fsyncs the containing project directory. */
  syncDirectory?: (directory: string) => void;
};

export type ProductionStoreOptions = {
  maxBytes?: number;
  hooks?: ProductionStoreHooks;
};

export type CreateProductionTaskResult = {
  created: boolean;
  task: ProductionTask;
  state: ProductionState;
};

export type ApplyProductionEventResult = {
  applied: boolean;
  task: ProductionTask;
  state: ProductionState;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type LoadedState = { state: ProductionState; identity: FileIdentity | null };

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function storeError(message: string, cause?: unknown): ProductionError {
  const suffix = cause === undefined ? "" : `：${cause instanceof Error ? cause.message : String(cause)}`;
  return new ProductionError(`${message}${suffix}`);
}

function boundedMaxBytes(options: ProductionStoreOptions): number {
  const value = options.maxBytes ?? MAX_PRODUCTION_STATE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_PRODUCTION_STATE_BYTES) {
    throw new ProductionError(`production state maxBytes 必须在 1024–${MAX_PRODUCTION_STATE_BYTES} 之间`);
  }
  return value;
}

export function productionStatePath(root: string, project: string): string {
  assertProjectKey(project);
  return join(resolve(root), ".writing-loop", project, PRODUCTION_STATE_FILE);
}

export function emptyProductionState(workspaceId: string, project: string): ProductionState {
  return parseProductionState({
    version: 1,
    workspaceId,
    project,
    revision: 0,
    updatedAt: null,
    tasks: [],
  });
}

function ensureProjectDirectory(root: string, workspaceId: string, project: string): string {
  // Validate both bindings before touching a path derived from either input.
  emptyProductionState(workspaceId, project);
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { throw storeError(`production workspace root 不存在：${resolve(root)}`, error); }
  let cursor = canonicalRoot;
  for (const [part, label] of [[".writing-loop", "workspace state"], [project, `项目 '${project}'`]] as const) {
    cursor = join(cursor, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(cursor); }
    catch (error) { throw storeError(`${label} 目录不存在：${cursor}`, error); }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProductionError(`${label} 目录必须是真实目录（拒绝 symlink/FIFO/device）：${cursor}`);
    }
  }
  return cursor;
}

function identityOf(stat: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

class ReadRace extends Error {}

function readOnce(
  file: string,
  workspaceId: string,
  project: string,
  maxBytes: number,
): LoadedState {
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") return { state: emptyProductionState(workspaceId, project), identity: null };
    throw storeError(`无法检查 production state ${file}`, error);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ProductionError(`${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > maxBytes) throw new ProductionError(`${file} 超过 ${maxBytes} bytes 安全读取上限`);

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new ProductionError(`${file} 打开后不是单链接普通文件`);
    }
    const beforeIdentity = identityOf(before);
    const openedIdentity = identityOf(opened);
    if (!sameIdentity(beforeIdentity, openedIdentity)) throw new ReadRace(`${file} 在 lstat/open 间被替换`);
    if (opened.size > maxBytes) throw new ProductionError(`${file} 超过 ${maxBytes} bytes 安全读取上限`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== bytes.length || !sameIdentity(openedIdentity, identityOf(after))) {
      throw new ReadRace(`${file} 在读取期间变化`);
    }
    const raw = bytes.toString("utf8");
    if (raw.includes("\0")) throw new ProductionError(`${file} 含 NUL 字节`);
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { throw storeError(`${file} 损坏（JSON 解析失败）`, error); }
    return {
      state: parseProductionState(value, { workspaceId, project }, file),
      identity: openedIdentity,
    };
  } catch (error) {
    if (error instanceof ProductionError || error instanceof ReadRace) throw error;
    throw storeError(`无法安全读取 production state ${file}`, error);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the primary read result */ }
  }
}

function loadState(file: string, workspaceId: string, project: string, maxBytes: number): LoadedState {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return readOnce(file, workspaceId, project, maxBytes); }
    catch (error) {
      if (!(error instanceof ReadRace) || attempt === 1) {
        if (error instanceof ReadRace) throw storeError(`production state 在读取期间持续被替换：${file}`);
        throw error;
      }
    }
  }
  throw new ProductionError("无法读取 production state");
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function assertReplaceable(file: string, expected: FileIdentity | null): void {
  if (expected === null) {
    try {
      lstatSync(file);
      throw new ProductionError(`${file} 在锁内读取后出现；拒绝覆盖未观测的文件`);
    } catch (error) {
      if (error instanceof ProductionError) throw error;
      if (errno(error) !== "ENOENT") throw storeError(`无法复核 production state ${file}`, error);
    }
    return;
  }
  let current: ReturnType<typeof lstatSync>;
  try { current = lstatSync(file); }
  catch (error) { throw storeError(`${file} 在写入期间消失`, error); }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || !sameIdentity(expected, identityOf(current))) {
    throw new ProductionError(`${file} 在写入期间被替换或不再是单链接普通文件；拒绝覆盖`);
  }
}

function atomicWrite(
  file: string,
  stateValue: ProductionState,
  expected: FileIdentity | null,
  maxBytes: number,
  hooks: ProductionStoreHooks,
): void {
  const state = parseProductionState(stateValue, {
    workspaceId: stateValue.workspaceId,
    project: stateValue.project,
  });
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (bytes.length > maxBytes) throw new ProductionError(`production state 超过 ${maxBytes} bytes 持久化上限`);
  const directory = dirname(file);
  const temporary = join(directory, `.${basename(file)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const temporaryInfo = fstatSync(fd);
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1) throw new ProductionError(`${temporary} 不是独占普通文件`);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertReplaceable(file, expected);
    hooks.beforeRename?.(temporary, file);
    // The hook models an unsynchronised writer; never overwrite a replacement introduced there.
    assertReplaceable(file, expected);
    renameSync(temporary, file);
    (hooks.syncDirectory ?? fsyncDirectory)(directory);
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    throw storeError(`无法原子写入 production state ${file}`, error);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* cleanup below */ }
    try { unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

type Lock = { fd: number; file: string; dev: number; ino: number };
type LockMetadata = {
  version: 1;
  pid: number;
  hostname: string;
  uid: number | null;
  ownerToken: string;
  acquiredAt: string;
};

const MAX_LOCK_BYTES = 1_024;
const LOCAL_HOSTNAME = hostname();
const LOCAL_UID = typeof process.getuid === "function" ? process.getuid() : null;
const LOCK_TOKEN = /^[a-f0-9]{32}$/;

function parseLockMetadata(value: unknown, info: ReturnType<typeof fstatSync>): LockMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = ["acquiredAt", "hostname", "ownerToken", "pid", "uid", "version"];
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (row.version !== 1 || !Number.isSafeInteger(row.pid) || (row.pid as number) < 1
    || typeof row.hostname !== "string" || row.hostname !== LOCAL_HOSTNAME
    || row.uid !== LOCAL_UID || (LOCAL_UID !== null && Number(info.uid) !== LOCAL_UID)
    || typeof row.ownerToken !== "string" || !LOCK_TOKEN.test(row.ownerToken)
    || typeof row.acquiredAt !== "string" || row.acquiredAt.length > 64) return null;
  const millis = Date.parse(row.acquiredAt);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== row.acquiredAt) return null;
  return {
    version: 1,
    pid: row.pid as number,
    hostname: row.hostname,
    uid: row.uid as number | null,
    ownerToken: row.ownerToken,
    acquiredAt: row.acquiredAt,
  };
}

function ownerDefinitelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return errno(error) === "ESRCH"; }
}

/**
 * Recover only a well-formed, same-host/same-user lock whose PID is definitely absent. Keeping the
 * inspected fd open prevents inode reuse while the final path identity is checked. Any malformed,
 * live, permission-ambiguous or replaced lock fails closed and is left untouched.
 */
function recoverDeadOwnerLock(file: string, hooks: ProductionStoreHooks): boolean {
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) { return errno(error) === "ENOENT"; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > MAX_LOCK_BYTES) return false;

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 || opened.size > MAX_LOCK_BYTES
      || !sameIdentity(identityOf(before), identityOf(opened))) return false;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return false;
      offset += count;
    }
    if (!sameIdentity(identityOf(opened), identityOf(fstatSync(fd)))) return false;
    const raw = bytes.toString("utf8");
    if (raw.includes("\0")) return false;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { return false; }
    const metadata = parseLockMetadata(value, opened);
    if (metadata === null || !ownerDefinitelyDead(metadata.pid)) return false;

    hooks.beforeDeadOwnerRecovery?.(file);
    let current: ReturnType<typeof lstatSync>;
    try { current = lstatSync(file); }
    catch (error) { return errno(error) === "ENOENT"; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || !sameIdentity(identityOf(opened), identityOf(current))) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* recovery remains fail-closed */ }
  }
}

function tryCreateOwnedLock(file: string, label: string): Lock | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (errno(error) === "EEXIST") return null;
    throw storeError(`无法取得 ${label} ${file}`, error);
  }

  let identity: { dev: number; ino: number } | null = null;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new ProductionError(`${file} ${label} 必须是单链接普通文件`);
    identity = { dev: info.dev, ino: info.ino };
    const metadata: LockMetadata = {
      version: 1,
      pid: process.pid,
      hostname: LOCAL_HOSTNAME,
      uid: LOCAL_UID,
      ownerToken: randomBytes(16).toString("hex"),
      acquiredAt: new Date().toISOString(),
    };
    writeAll(fd, Buffer.from(`${JSON.stringify(metadata)}\n`));
    fsyncSync(fd);
    return { fd, file, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    try {
      const current = lstatSync(file);
      if (identity && !current.isSymbolicLink() && current.isFile()
        && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(file);
    } catch { /* preserve primary failure and never delete a replacement */ }
    try { closeSync(fd); } catch { /* preserve primary failure */ }
    if (error instanceof ProductionError) throw error;
    throw storeError(`无法持久化 ${label} ${file}`, error);
  }
}

function releaseLock(lock: Lock): void {
  try {
    const current = lstatSync(lock.file);
    if (!current.isSymbolicLink() && current.isFile() && current.dev === lock.dev && current.ino === lock.ino) {
      unlinkSync(lock.file);
    }
  } catch { /* never unlink a replacement lock */ }
  finally { try { closeSync(lock.fd); } catch { /* lock path identity was already handled */ } }
}

/**
 * Every main-lock creation and dead-owner takeover runs under this short-lived O_EXCL gate. The
 * gate is deliberately fail-closed: it is never automatically reclaimed, because attempting to
 * reclaim the sole recovery serializer would recreate the same check→unlink race it prevents.
 */
function acquireAcquisitionGate(directory: string): Lock {
  const file = join(directory, PRODUCTION_ACQUISITION_GATE_FILE);
  const gate = tryCreateOwnedLock(file, "production acquisition gate");
  if (gate === null) {
    throw new ProductionError(`production acquisition gate ${file} 已存在；拒绝并发创建或接管主锁`);
  }
  return gate;
}

/** Caller must hold the acquisition gate for this directory. */
function acquireMainLockUnderGate(directory: string, hooks: ProductionStoreHooks): Lock {
  const file = join(directory, PRODUCTION_LOCK_FILE);
  let lock = tryCreateOwnedLock(file, "production state 写锁");
  if (lock !== null) return lock;
  if (!recoverDeadOwnerLock(file, hooks)) {
    throw new ProductionError(`production state 正被另一进程修改（O_EXCL 锁 ${file} 已存在且不能安全接管）——稍后重试`);
  }
  lock = tryCreateOwnedLock(file, "production state 写锁");
  if (lock === null) {
    throw new ProductionError(`production state 写锁 ${file} 在 acquisition gate 内被外部替换；拒绝接管`);
  }
  return lock;
}

function acquireLock(directory: string, hooks: ProductionStoreHooks): Lock {
  const gate = acquireAcquisitionGate(directory);
  let lock: Lock;
  try {
    // Old-lock verification/removal and the fully fsynced successor lock are one gate-protected
    // acquisition transaction. No compliant second recoverer can enter the lstat→unlink window.
    lock = acquireMainLockUnderGate(directory, hooks);
  } finally {
    releaseLock(gate);
  }

  try {
    // The acquisition gate must be gone before user/test code enters the state critical section.
    hooks.afterLock?.(lock.file);
    return lock;
  } catch (error) {
    releaseLock(lock);
    if (error instanceof ProductionError) throw error;
    throw storeError(`production state 写锁 ${lock.file} 的 afterLock hook 失败`, error);
  }
}

function withLock<T>(directory: string, hooks: ProductionStoreHooks, operation: () => T): T {
  const lock = acquireLock(directory, hooks);
  try { return operation(); }
  finally { releaseLock(lock); }
}

function nextDocument(
  current: ProductionState,
  tasks: ProductionTask[],
  mutationAt: string,
): ProductionState {
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ProductionError("production document revision 已耗尽安全整数空间");
  return parseProductionState({
    version: 1,
    workspaceId: current.workspaceId,
    project: current.project,
    revision: current.revision + 1,
    updatedAt: current.updatedAt === null || mutationAt > current.updatedAt ? mutationAt : current.updatedAt,
    tasks: [...tasks].sort((left, right) => compareProductionAscii(left.id, right.id)),
  }, { workspaceId: current.workspaceId, project: current.project });
}

function sameCreation(existing: ProductionTask, create: ProductionTaskCreate): boolean {
  return existing.id === create.id
    && existing.createdAt === create.createdAt
    && JSON.stringify(existing.subject) === JSON.stringify(create.subject);
}

export function readProductionState(
  root: string,
  workspaceId: string,
  project: string,
  options: ProductionStoreOptions = {},
): ProductionState {
  const directory = ensureProjectDirectory(root, workspaceId, project);
  return loadState(join(directory, PRODUCTION_STATE_FILE), workspaceId, project, boundedMaxBytes(options)).state;
}

export function createProductionTask(
  root: string,
  workspaceId: string,
  project: string,
  input: ProductionTaskCreate,
  options: ProductionStoreOptions = {},
): CreateProductionTaskResult {
  const create = parseProductionTaskCreate(input);
  const directory = ensureProjectDirectory(root, workspaceId, project);
  const file = join(directory, PRODUCTION_STATE_FILE);
  const maxBytes = boundedMaxBytes(options);
  const hooks = options.hooks ?? {};
  return withLock(directory, hooks, () => {
    // Authoritative re-read happens only after this process durably owns the O_EXCL lock.
    const loaded = loadState(file, workspaceId, project, maxBytes);
    const byKey = loaded.state.tasks.find((task) => task.idempotencyKey === create.idempotencyKey);
    if (byKey) {
      if (!sameCreation(byKey, create)) {
        throw new ProductionError(`idempotencyKey ${JSON.stringify(create.idempotencyKey)} 已绑定另一创建请求`);
      }
      return { created: false, task: byKey, state: loaded.state };
    }
    if (loaded.state.tasks.some((task) => task.id === create.id)) {
      throw new ProductionError(`production task id ${create.id} 已存在且 idempotencyKey 不同`);
    }
    if (loaded.state.tasks.length >= MAX_PRODUCTION_TASKS) {
      throw new ProductionError(`production state 已达 ${MAX_PRODUCTION_TASKS} 个 task 上限`);
    }
    const task = taskFromCreate(create);
    const state = nextDocument(loaded.state, [...loaded.state.tasks, task], create.createdAt);
    atomicWrite(file, state, loaded.identity, maxBytes, hooks);
    return { created: true, task, state };
  });
}

export function applyProductionEvent(
  root: string,
  workspaceId: string,
  project: string,
  input: ProductionTaskEvent,
  options: ProductionStoreOptions = {},
): ApplyProductionEventResult {
  const event = parseProductionTaskEvent(input);
  const directory = ensureProjectDirectory(root, workspaceId, project);
  const file = join(directory, PRODUCTION_STATE_FILE);
  const maxBytes = boundedMaxBytes(options);
  const hooks = options.hooks ?? {};
  return withLock(directory, hooks, () => {
    const loaded = loadState(file, workspaceId, project, maxBytes);
    const taskIndex = loaded.state.tasks.findIndex((task) => task.id === event.taskId);
    if (taskIndex < 0) throw new ProductionError(`production task ${event.taskId} 不存在`);
    const owner = loaded.state.tasks.find((task) => task.id !== event.taskId
      && task.eventReceipts.some((receipt) => receipt.eventId === event.eventId));
    if (owner) throw new ProductionError(`eventId ${event.eventId} 已属于另一 task ${owner.id}`);
    const current = loaded.state.tasks[taskIndex];
    const priorReceipt = current.eventReceipts.find((receipt) => receipt.eventId === event.eventId);
    if (priorReceipt) {
      if (priorReceipt.payloadDigest !== productionEventDigest(event)) {
        throw new ProductionError(`eventId ${event.eventId} 已绑定另一 canonical payload（拒绝冲突重放）`);
      }
      return { applied: false, task: current, state: loaded.state };
    }
    const task = transitionProductionTask(current, event);
    const tasks = [...loaded.state.tasks];
    tasks[taskIndex] = task;
    // parseProductionState performs the global remote tuple uniqueness check before any temp file
    // is created, including tuples reserved by a submitting/unknown outbox.
    const state = nextDocument(loaded.state, tasks, event.occurredAt);
    atomicWrite(file, state, loaded.identity, maxBytes, hooks);
    return { applied: true, task, state };
  });
}

export class ProductionStore {
  readonly #root: string;
  readonly #workspaceId: string;
  readonly #project: string;
  readonly #options: ProductionStoreOptions;

  constructor(root: string, workspaceId: string, project: string, options: ProductionStoreOptions = {}) {
    // Constructor validates protocol bindings but leaves filesystem observation to each call.
    emptyProductionState(workspaceId, project);
    this.#root = root;
    this.#workspaceId = workspaceId;
    this.#project = project;
    this.#options = options;
  }

  get file(): string { return productionStatePath(this.#root, this.#project); }

  read(): ProductionState {
    return readProductionState(this.#root, this.#workspaceId, this.#project, this.#options);
  }

  create(input: ProductionTaskCreate): CreateProductionTaskResult {
    return createProductionTask(this.#root, this.#workspaceId, this.#project, input, this.#options);
  }

  apply(event: ProductionTaskEvent): ApplyProductionEventResult {
    return applyProductionEvent(this.#root, this.#workspaceId, this.#project, event, this.#options);
  }
}
