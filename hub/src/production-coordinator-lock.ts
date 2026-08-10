// Project-scoped single-flight lease for the production coordinator.
//
// The lease is deliberately independent from both production-state and production-control write
// locks. A coordinator holds this lease across a complete async reconciliation round (including
// network calls), but each authoritative/control ledger mutation takes only its own short lock.
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
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { ProductionError } from "./production-domain.ts";
import { emptyProductionCoordinatorControlState } from "./production-coordinator-domain.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_COORDINATOR_LEASE_FILE = ".production-coordinator.v1.lock";
export const PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE = ".production-coordinator.v1.acquire";
export const MAX_PRODUCTION_COORDINATOR_LOCK_BYTES = 2_048;

export type ProductionCoordinatorLockHooks = {
  /** Test/diagnostic seam after the acquisition gate is gone and the requested lock is owned. */
  afterLock?: (lockFile: string) => void;
  /** Race seam after a strict owner is proven dead, before final inode verification and unlink. */
  beforeDeadOwnerRecovery?: (lockFile: string) => void;
  /** Test seam; production fsyncs the containing project directory. */
  syncDirectory?: (directory: string) => void;
};

export type ProductionCoordinatorLeaseOptions = {
  hooks?: ProductionCoordinatorLockHooks;
};

export type ProductionCoordinatorLease = {
  readonly file: string;
  readonly released: boolean;
  release(): void;
};

export type CoordinatorLockNames = {
  file: string;
  gate: string;
  label: string;
};

type OwnedLock = {
  fd: number;
  file: string;
  directory: string;
  dev: number;
  ino: number;
};

type LockMetadata = {
  version: 1;
  pid: number;
  hostname: string;
  uid: number | null;
  ownerToken: string;
  workspaceId: string;
  project: string;
  lockName: string;
  acquiredAt: string;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const LOCAL_HOSTNAME = hostname();
const LOCAL_UID = typeof process.getuid === "function" ? process.getuid() : null;
const LOCK_TOKEN = /^[a-f0-9]{32}$/;
const SAFE_LOCK_NAME = /^\.[a-z0-9][a-z0-9._-]{0,95}$/;

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function lockError(message: string, cause?: unknown): ProductionError {
  const suffix = cause === undefined ? "" : `：${cause instanceof Error ? cause.message : String(cause)}`;
  return new ProductionError(`${message}${suffix}`);
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

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
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

function syncDirectory(directory: string, hooks: ProductionCoordinatorLockHooks): void {
  (hooks.syncDirectory ?? fsyncDirectory)(directory);
}

export function productionCoordinatorProjectDirectory(
  root: string,
  workspaceId: string,
  project: string,
): string {
  // Validate scope before resolving any caller-derived project path.
  emptyProductionCoordinatorControlState(workspaceId, project);
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { throw lockError(`production coordinator workspace root 不存在：${resolve(root)}`, error); }
  let cursor = canonicalRoot;
  for (const [part, label] of [[".writing-loop", "workspace state"], [project, `项目 '${project}'`]] as const) {
    cursor = join(cursor, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(cursor); }
    catch (error) { throw lockError(`${label} 目录不存在：${cursor}`, error); }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ProductionError(`${label} 目录必须是真实目录（拒绝 symlink/FIFO/device）：${cursor}`);
    }
  }
  return cursor;
}

function validateNames(names: CoordinatorLockNames): void {
  if (!fullMatch(SAFE_LOCK_NAME, names.file) || !fullMatch(SAFE_LOCK_NAME, names.gate) || names.file === names.gate
    || typeof names.label !== "string" || names.label.length < 1 || names.label.length > 96) {
    throw new ProductionError("production coordinator lock names 无效");
  }
}

function parseLockMetadata(
  value: unknown,
  info: ReturnType<typeof fstatSync>,
  workspaceId: string,
  project: string,
  lockName: string,
): LockMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = [
    "acquiredAt", "hostname", "lockName", "ownerToken", "pid", "project", "uid", "version", "workspaceId",
  ];
  const keys = Object.keys(row).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (row.version !== 1 || !Number.isSafeInteger(row.pid) || (row.pid as number) < 1
    || row.hostname !== LOCAL_HOSTNAME || row.uid !== LOCAL_UID
    || (LOCAL_UID !== null && Number(info.uid) !== LOCAL_UID)
    || typeof row.ownerToken !== "string" || !fullMatch(LOCK_TOKEN, row.ownerToken)
    || row.workspaceId !== workspaceId || row.project !== project || row.lockName !== lockName
    || typeof row.acquiredAt !== "string" || row.acquiredAt.length > 64) return null;
  const millis = Date.parse(row.acquiredAt);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== row.acquiredAt) return null;
  return {
    version: 1,
    pid: row.pid as number,
    hostname: LOCAL_HOSTNAME,
    uid: LOCAL_UID,
    ownerToken: row.ownerToken,
    workspaceId,
    project,
    lockName,
    acquiredAt: row.acquiredAt,
  };
}

function ownerDefinitelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return errno(error) === "ESRCH"; }
}

function releaseOwnedLock(lock: OwnedLock, hooks: ProductionCoordinatorLockHooks, strict = false): void {
  let problem: unknown;
  try {
    let current: ReturnType<typeof lstatSync> | null = null;
    try { current = lstatSync(lock.file); }
    catch (error) { if (errno(error) !== "ENOENT") problem = error; }
    if (current !== null) {
      if (!current.isSymbolicLink() && current.isFile() && current.nlink === 1
        && Number(current.dev) === lock.dev && Number(current.ino) === lock.ino) {
        unlinkSync(lock.file);
        syncDirectory(lock.directory, hooks);
      } else {
        problem = new ProductionError(`${lock.file} 在释放前被替换；拒绝删除 replacement inode`);
      }
    } else if (strict && problem === undefined) {
      problem = new ProductionError(`${lock.file} 在释放前意外消失`);
    }
  } catch (error) {
    problem = error;
  } finally {
    try { closeSync(lock.fd); } catch (error) { problem ??= error; }
  }
  if (strict && problem !== undefined) throw lockError(`无法安全释放 coordinator lock ${lock.file}`, problem);
}

function tryCreateOwnedLock(
  directory: string,
  workspaceId: string,
  project: string,
  lockName: string,
  label: string,
  hooks: ProductionCoordinatorLockHooks,
): OwnedLock | null {
  const file = join(directory, lockName);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (errno(error) === "EEXIST") return null;
    throw lockError(`无法取得 ${label} ${file}`, error);
  }

  let identity: { dev: number; ino: number } | null = null;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new ProductionError(`${file} ${label} 必须是单链接普通文件`);
    identity = { dev: Number(info.dev), ino: Number(info.ino) };
    const metadata: LockMetadata = {
      version: 1,
      pid: process.pid,
      hostname: LOCAL_HOSTNAME,
      uid: LOCAL_UID,
      ownerToken: randomBytes(16).toString("hex"),
      workspaceId,
      project,
      lockName,
      acquiredAt: new Date().toISOString(),
    };
    const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    if (bytes.length > MAX_PRODUCTION_COORDINATOR_LOCK_BYTES) throw new ProductionError(`${label} metadata 超限`);
    writeAll(fd, bytes);
    fsyncSync(fd);
    syncDirectory(directory, hooks);
    return { fd, file, directory, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    try {
      const current = lstatSync(file);
      if (identity !== null && !current.isSymbolicLink() && current.isFile()
        && Number(current.dev) === identity.dev && Number(current.ino) === identity.ino) {
        unlinkSync(file);
        try { syncDirectory(directory, hooks); } catch { /* primary creation error wins */ }
      }
    } catch { /* never delete a replacement */ }
    try { closeSync(fd); } catch { /* primary creation error wins */ }
    if (error instanceof ProductionError) throw error;
    throw lockError(`无法持久化 ${label} ${file}`, error);
  }
}

/** Caller holds the acquisition gate, serializing dead-owner inspection and successor creation. */
function recoverDeadOwnerLock(
  directory: string,
  workspaceId: string,
  project: string,
  lockName: string,
  hooks: ProductionCoordinatorLockHooks,
): boolean {
  const file = join(directory, lockName);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) { return errno(error) === "ENOENT"; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > MAX_PRODUCTION_COORDINATOR_LOCK_BYTES) return false;

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 || opened.size > MAX_PRODUCTION_COORDINATOR_LOCK_BYTES
      || !sameIdentity(identityOf(before), identityOf(opened))) return false;
    const bytes = Buffer.alloc(Number(opened.size));
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
    const metadata = parseLockMetadata(value, opened, workspaceId, project, lockName);
    if (metadata === null || !ownerDefinitelyDead(metadata.pid)) return false;

    hooks.beforeDeadOwnerRecovery?.(file);
    let current: ReturnType<typeof lstatSync>;
    try { current = lstatSync(file); }
    catch (error) { return errno(error) === "ENOENT"; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || !sameIdentity(identityOf(opened), identityOf(current))) return false;
    unlinkSync(file);
    syncDirectory(directory, hooks);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* recovery remains fail-closed */ }
  }
}

/**
 * Shared short-lock primitive for production-control writes. Public only so the store can use the
 * exact lease-audited recovery code; coordinator consumers should use the lease API below.
 */
export function acquireProductionCoordinatorOwnedLock(
  directory: string,
  workspaceId: string,
  project: string,
  names: CoordinatorLockNames,
  hooks: ProductionCoordinatorLockHooks = {},
): { file: string; release(): void } {
  validateNames(names);
  const gate = tryCreateOwnedLock(directory, workspaceId, project, names.gate, `${names.label} acquisition gate`, hooks);
  if (gate === null) {
    throw new ProductionError(`${names.label} acquisition gate ${join(directory, names.gate)} 已存在；拒绝并发创建或接管主锁`);
  }

  let main: OwnedLock | null = null;
  let acquisitionError: unknown;
  try {
    main = tryCreateOwnedLock(directory, workspaceId, project, names.file, names.label, hooks);
    if (main === null) {
      if (!recoverDeadOwnerLock(directory, workspaceId, project, names.file, hooks)) {
        throw new ProductionError(`${names.label} ${join(directory, names.file)} 已存在且不能安全接管`);
      }
      main = tryCreateOwnedLock(directory, workspaceId, project, names.file, names.label, hooks);
      if (main === null) throw new ProductionError(`${names.label} 在 acquisition gate 内被外部替换；拒绝接管`);
    }
  } catch (error) {
    acquisitionError = error;
  }

  try {
    releaseOwnedLock(gate, hooks, true);
  } catch (error) {
    acquisitionError ??= error;
  }
  if (acquisitionError !== undefined || main === null) {
    if (main !== null) releaseOwnedLock(main, hooks);
    if (acquisitionError instanceof ProductionError) throw acquisitionError;
    throw lockError(`无法取得 ${names.label}`, acquisitionError);
  }

  try { hooks.afterLock?.(main.file); }
  catch (error) {
    releaseOwnedLock(main, hooks);
    if (error instanceof ProductionError) throw error;
    throw lockError(`${names.label} afterLock hook 失败`, error);
  }
  let released = false;
  return {
    file: main.file,
    release: () => {
      if (released) return;
      released = true;
      releaseOwnedLock(main!, hooks);
    },
  };
}

export function acquireProductionCoordinatorLease(
  root: string,
  workspaceId: string,
  project: string,
  options: ProductionCoordinatorLeaseOptions = {},
): ProductionCoordinatorLease {
  const directory = productionCoordinatorProjectDirectory(root, workspaceId, project);
  const owned = acquireProductionCoordinatorOwnedLock(directory, workspaceId, project, {
    file: PRODUCTION_COORDINATOR_LEASE_FILE,
    gate: PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE,
    label: "production coordinator project lease",
  }, options.hooks);
  let released = false;
  return {
    file: owned.file,
    get released() { return released; },
    release() {
      if (released) return;
      released = true;
      owned.release();
    },
  };
}

/** Keeps the project lease across the entire async operation, including all remote I/O. */
export async function withProductionCoordinatorLease<T>(
  root: string,
  workspaceId: string,
  project: string,
  operation: () => Promise<T>,
  options: ProductionCoordinatorLeaseOptions = {},
): Promise<T> {
  const lease = acquireProductionCoordinatorLease(root, workspaceId, project, options);
  try { return await operation(); }
  finally { lease.release(); }
}
