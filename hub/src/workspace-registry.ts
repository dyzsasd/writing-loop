// Stable workspace identity + bounded, non-authoritative machine-local registry.
//
// A workspace owns its opaque ID in <root>/.writing-loop/workspace.json. The registry merely
// remembers ID -> canonical root pointers under WRITING_LOOP_HOME; normal CLI root discovery does
// not consult it. Both files use strict v1 schemas so a future writer never silently erases fields
// it does not understand.
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { WsError } from "./workspace.ts";

export const WORKSPACE_IDENTITY_VERSION = 1 as const;
export const WORKSPACE_REGISTRY_VERSION = 1 as const;
export const MAX_REGISTRY_ENTRIES = 128;
export const MAX_IDENTITY_BYTES = 8 * 1024;
export const MAX_REGISTRY_BYTES = 256 * 1024;
export const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{32}$/;

export type WorkspaceIdentity = { version: 1; id: string };
export type RegisteredWorkspace = { id: string; root: string; label?: string };
type RegistryDocument = { version: 1; workspaces: RegisteredWorkspace[] };

export type RegistryEntryStatus = RegisteredWorkspace & {
  status: "ok" | "missing" | "corrupt";
  diagnostic?: string;
};

export type WorkspaceRegistrySnapshot = {
  home: string;
  file: string;
  registryStatus: "ok" | "missing" | "corrupt";
  degraded: boolean;
  entries: RegistryEntryStatus[];
  diagnostics: string[];
};

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new WsError(`${subject} 含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
}

function assertWorkspaceId(id: unknown, subject = "workspace ID"): asserts id is string {
  if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id)) {
    throw new WsError(`${subject} 必须匹配 ${WORKSPACE_ID_PATTERN.source}`);
  }
}

function assertLabel(label: unknown): asserts label is string | undefined {
  if (label === undefined) return;
  if (typeof label !== "string" || label.length < 1 || label.length > 256 || label.includes("\0")) {
    throw new WsError("workspace label 必须是 1–256 字符的字符串");
  }
}

function parseIdentity(raw: string, file: string): WorkspaceIdentity {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new WsError(`${file} 损坏：${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(value)) throw new WsError(`${file} 顶层必须是 JSON 对象`);
  exactKeys(value, ["version", "id"], file);
  if (value.version !== WORKSPACE_IDENTITY_VERSION) throw new WsError(`${file} version 必须是 1`);
  assertWorkspaceId(value.id, `${file} 的 id`);
  return { version: 1, id: value.id };
}

function parseRegistry(raw: string, file: string): RegistryDocument {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new WsError(`${file} 损坏：${error instanceof Error ? error.message : String(error)}`); }
  if (!isRecord(value)) throw new WsError(`${file} 顶层必须是 JSON 对象`);
  exactKeys(value, ["version", "workspaces"], file);
  if (value.version !== WORKSPACE_REGISTRY_VERSION) throw new WsError(`${file} version 必须是 1`);
  if (!Array.isArray(value.workspaces)) throw new WsError(`${file} 的 workspaces 必须是数组`);
  if (value.workspaces.length > MAX_REGISTRY_ENTRIES) {
    throw new WsError(`${file} 超过 ${MAX_REGISTRY_ENTRIES} 条本机索引上限`);
  }
  const seenIds = new Set<string>();
  const seenRoots = new Set<string>();
  const workspaces = value.workspaces.map((entry, index): RegisteredWorkspace => {
    const subject = `${file} workspaces[${index}]`;
    if (!isRecord(entry)) throw new WsError(`${subject} 必须是 JSON 对象`);
    exactKeys(entry, ["id", "root", "label"], subject);
    assertWorkspaceId(entry.id, `${subject}.id`);
    if (typeof entry.root !== "string" || !isAbsolute(entry.root) || entry.root.includes("\0") || resolve(entry.root) !== entry.root) {
      throw new WsError(`${subject}.root 必须是规范化绝对路径`);
    }
    assertLabel(entry.label);
    if (seenIds.has(entry.id)) throw new WsError(`${file} 含重复 workspace ID ${entry.id}`);
    if (seenRoots.has(entry.root)) throw new WsError(`${file} 含重复 root ${entry.root}`);
    seenIds.add(entry.id);
    seenRoots.add(entry.root);
    return entry.label === undefined
      ? { id: entry.id, root: entry.root }
      : { id: entry.id, root: entry.root, label: entry.label };
  });
  return { version: 1, workspaces };
}

type SafeRead =
  | { kind: "missing" }
  | { kind: "ok"; text: string; identity: { dev: number; ino: number } }
  | { kind: "invalid"; message: string };

/** Bounded read which rejects symlinks, hardlinks, devices and FIFOs before they can block. */
function readSingleLinkRegular(file: string, maxBytes: number): SafeRead {
  let fd: number | undefined;
  try {
    let before: ReturnType<typeof lstatSync>;
    try { before = lstatSync(file); }
    catch (error) {
      return errno(error) === "ENOENT"
        ? { kind: "missing" }
        : { kind: "invalid", message: `无法检查 ${file}：${error instanceof Error ? error.message : String(error)}` };
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      return { kind: "invalid", message: `${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）` };
    }
    if (before.size > maxBytes) return { kind: "invalid", message: `${file} 超过 ${maxBytes} bytes 读取上限` };
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const current = fstatSync(fd);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino) {
      return { kind: "invalid", message: `${file} 在读取期间被替换或不是单链接普通文件` };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > maxBytes) return { kind: "invalid", message: `${file} 超过 ${maxBytes} bytes 读取上限` };
    const text = buffer.subarray(0, offset).toString("utf8");
    if (text.includes("\0")) return { kind: "invalid", message: `${file} 含 NUL 字节` };
    return { kind: "ok", text, identity: { dev: current.dev, ino: current.ino } };
  } catch (error) {
    return { kind: "invalid", message: `无法安全读取 ${file}：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve diagnostic */ }
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertNoSymlinkComponents(dir: string, subject: string): void {
  const absolute = resolve(dir);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new WsError(`${subject} 路径含 symlink：${cursor}`);
    } catch (error) {
      if (error instanceof WsError) throw error;
      if (errno(error) === "ENOENT") return; // remaining descendants do not exist yet
      throw new WsError(`无法检查 ${subject} 路径 ${cursor}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function ensureDirectory(dir: string, subject: string): void {
  assertNoSymlinkComponents(dir, subject);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch (error) { throw new WsError(`无法创建 ${subject} ${dir}：${error instanceof Error ? error.message : String(error)}`); }
  assertNoSymlinkComponents(dir, subject);
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WsError(`${subject} ${dir} 必须是真实目录（拒绝 symlink）`);
}

function validateExistingDirectory(dir: string, subject: string): void {
  assertNoSymlinkComponents(dir, subject);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(dir); }
  catch (error) {
    if (errno(error) === "ENOENT") return;
    throw new WsError(`无法检查 ${subject} ${dir}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WsError(`${subject} ${dir} 必须是真实目录（拒绝 symlink）`);
}

function canonicalWorkspaceRoot(input: string): string {
  const absolute = resolve(input);
  let root: string;
  try { root = realpathSync(absolute); }
  catch { throw new WsError(`workspace 目录不存在：${absolute}`); }
  if (!statSync(root).isDirectory()) throw new WsError(`workspace root 不是目录：${root}`);
  const stateDir = join(root, ".writing-loop");
  let stateInfo: ReturnType<typeof lstatSync>;
  try { stateInfo = lstatSync(stateDir); }
  catch { throw new WsError(`${root} 下没有 .writing-loop/ ——先运行 writing-loop init`); }
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new WsError(`${stateDir} 必须是真实目录（拒绝 symlink）`);
  }
  return root;
}

export function writingLoopHome(envValue: string | undefined = process.env.WRITING_LOOP_HOME): string {
  if (envValue === undefined) return join(homedir(), ".writing-loop");
  if (!isAbsolute(envValue)) throw new WsError(`WRITING_LOOP_HOME 必须是绝对路径（得到 ${JSON.stringify(envValue)}）`);
  return resolve(envValue);
}

function registryPath(home = writingLoopHome()): string { return join(home, "workspaces.json"); }

type Lock = { fd: number; file: string; identity: { dev: number; ino: number } };

function acquireLock(file: string, subject: string): Lock {
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) {
    if (errno(error) === "EEXIST") throw new WsError(`${subject} 正被另一进程修改（锁 ${file} 已存在）——稍后重试`);
    throw new WsError(`无法取得 ${subject} 写锁 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  const info = fstatSync(fd);
  const lock: Lock = { fd, file, identity: { dev: info.dev, ino: info.ino } };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
    fsyncSync(fd);
    return lock;
  } catch (error) {
    releaseLock(lock);
    throw new WsError(`无法持久化 ${subject} 写锁 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseLock(lock: Lock): void {
  try {
    const current = lstatSync(lock.file);
    if (!current.isSymbolicLink() && current.dev === lock.identity.dev && current.ino === lock.identity.ino) unlinkSync(lock.file);
  } catch { /* missing/replaced lock belongs to nobody or somebody else */ }
  try { closeSync(lock.fd); } catch { /* already closed */ }
}

function atomicJsonReplace(file: string, value: unknown, existing?: { dev: number; ino: number }): void {
  const dir = dirname(file);
  const temp = join(dir, `.${file.slice(file.lastIndexOf("/") + 1)}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  let promoted = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (existing) {
      const current = lstatSync(file);
      if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
        || current.dev !== existing.dev || current.ino !== existing.ino) {
        throw new WsError(`${file} 在写入期间被替换；拒绝覆盖`);
      }
    } else {
      try {
        lstatSync(file);
        throw new WsError(`${file} 在写入期间出现；拒绝覆盖`);
      } catch (error) {
        if (error instanceof WsError) throw error;
        if (errno(error) !== "ENOENT") throw error;
      }
    }
    renameSync(temp, file);
    promoted = true;
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve original failure */ }
    if (!promoted) try { unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
  }
}

export function readWorkspaceIdentity(rootInput: string): WorkspaceIdentity {
  const root = canonicalWorkspaceRoot(rootInput);
  const file = join(root, ".writing-loop", "workspace.json");
  const read = readSingleLinkRegular(file, MAX_IDENTITY_BYTES);
  if (read.kind === "missing") throw new WsError(`workspace identity 缺失：${file}`);
  if (read.kind === "invalid") throw new WsError(read.message);
  return parseIdentity(read.text, file);
}

/** Create the stable identity once; later calls only validate and return it. */
export function ensureWorkspaceIdentity(rootInput: string): WorkspaceIdentity {
  const root = canonicalWorkspaceRoot(rootInput);
  const stateDir = join(root, ".writing-loop");
  const file = join(stateDir, "workspace.json");
  const initial = readSingleLinkRegular(file, MAX_IDENTITY_BYTES);
  if (initial.kind === "ok") return parseIdentity(initial.text, file);
  if (initial.kind === "invalid") throw new WsError(initial.message);

  const lock = acquireLock(`${file}.lock`, "workspace identity");
  try {
    const afterLock = readSingleLinkRegular(file, MAX_IDENTITY_BYTES);
    if (afterLock.kind === "ok") return parseIdentity(afterLock.text, file);
    if (afterLock.kind === "invalid") throw new WsError(afterLock.message);
    const identity: WorkspaceIdentity = { version: 1, id: `ws_${randomBytes(16).toString("hex")}` };
    atomicJsonReplace(file, identity);
    return identity;
  } finally {
    releaseLock(lock);
  }
}

function readRegistryDocument(file: string): { kind: "missing" } | { kind: "ok"; document: RegistryDocument; identity: { dev: number; ino: number } } {
  const read = readSingleLinkRegular(file, MAX_REGISTRY_BYTES);
  if (read.kind === "missing") return read;
  if (read.kind === "invalid") throw new WsError(read.message);
  return { kind: "ok", document: parseRegistry(read.text, file), identity: read.identity };
}

function inspectEntry(entry: RegisteredWorkspace): RegistryEntryStatus {
  let rootInfo: ReturnType<typeof lstatSync>;
  try { rootInfo = lstatSync(entry.root); }
  catch (error) {
    return errno(error) === "ENOENT"
      ? { ...entry, status: "missing", diagnostic: `root 不存在：${entry.root}` }
      : { ...entry, status: "corrupt", diagnostic: `无法检查 root：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { ...entry, status: "corrupt", diagnostic: `root 不是安全目录：${entry.root}` };
  }
  try {
    const identity = readWorkspaceIdentity(entry.root);
    if (identity.id !== entry.id) return { ...entry, status: "corrupt", diagnostic: `identity ID 不匹配（实际 ${identity.id}）` };
    return { ...entry, status: "ok" };
  } catch (error) {
    return { ...entry, status: "corrupt", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

/** Diagnostic read: a corrupt registry is reported, while corrupt entries are isolated per row. */
export function inspectWorkspaceRegistry(): WorkspaceRegistrySnapshot {
  const home = writingLoopHome();
  const file = registryPath(home);
  let read: ReturnType<typeof readRegistryDocument>;
  try {
    validateExistingDirectory(home, "WRITING_LOOP_HOME");
    read = readRegistryDocument(file);
  }
  catch (error) {
    return {
      home, file, registryStatus: "corrupt", degraded: true, entries: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (read.kind === "missing") {
    return { home, file, registryStatus: "missing", degraded: false, entries: [], diagnostics: [] };
  }
  const entries = read.document.workspaces.map(inspectEntry);
  const diagnostics = entries.flatMap((entry) => entry.diagnostic ? [`${entry.id}: ${entry.diagnostic}`] : []);
  return { home, file, registryStatus: "ok", degraded: diagnostics.length > 0, entries, diagnostics };
}

function identityAtExistingRoot(root: string): WorkspaceIdentity | null {
  try { return readWorkspaceIdentity(root); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    try { lstatSync(root); } catch (rootError) { if (errno(rootError) === "ENOENT") return null; }
    throw error;
  }
}

/** Register by canonical root. If a former root vanished, the stable ID moves to the new pointer. */
export type WorkspaceRegistryRuntime = {
  /** Test seam used to prove that inode-safe release never deletes a replacement lock. */
  afterLock?: (lockFile: string) => void;
};

export function registerWorkspace(
  rootInput: string,
  label?: string,
  runtime: WorkspaceRegistryRuntime = {},
): RegisteredWorkspace {
  assertLabel(label);
  const root = canonicalWorkspaceRoot(rootInput);
  const identity = ensureWorkspaceIdentity(root);
  const home = writingLoopHome();
  ensureDirectory(home, "WRITING_LOOP_HOME");
  const file = registryPath(home);
  const lock = acquireLock(`${file}.lock`, "workspace registry");
  try {
    runtime.afterLock?.(lock.file);
    const read = readRegistryDocument(file); // corrupt/special registry must never be overwritten
    const document: RegistryDocument = read.kind === "missing" ? { version: 1, workspaces: [] } : read.document;
    const sameId = document.workspaces.find((entry) => entry.id === identity.id);
    const sameRoot = document.workspaces.find((entry) => entry.root === root);

    if (sameId && sameId.root !== root) {
      const formerIdentity = identityAtExistingRoot(sameId.root);
      if (formerIdentity?.id === identity.id) {
        throw new WsError(`duplicate workspace identity ${identity.id}：两个现存 root（${sameId.root}、${root}）`);
      }
    }
    if (sameRoot && sameRoot.id !== identity.id) {
      throw new WsError(`registry root ${root} 已绑定另一个 workspace ID ${sameRoot.id}`);
    }

    const nextEntry: RegisteredWorkspace = label === undefined
      ? { id: identity.id, root }
      : { id: identity.id, root, label };
    let changed = false;
    if (sameId) {
      const effective = label === undefined && sameId.label !== undefined ? { ...nextEntry, label: sameId.label } : nextEntry;
      const index = document.workspaces.indexOf(sameId);
      changed = JSON.stringify(document.workspaces[index]) !== JSON.stringify(effective);
      document.workspaces[index] = effective;
    } else {
      if (document.workspaces.length >= MAX_REGISTRY_ENTRIES) {
        throw new WsError(`workspace registry 已达 ${MAX_REGISTRY_ENTRIES} 条上限；请先 remove 不再使用的 ID`);
      }
      document.workspaces.push(nextEntry);
      changed = true;
    }
    document.workspaces.sort((a, b) => a.id.localeCompare(b.id));
    if (changed || read.kind === "missing") {
      atomicJsonReplace(file, document, read.kind === "ok" ? read.identity : undefined);
    }
    return document.workspaces.find((entry) => entry.id === identity.id)!;
  } finally {
    releaseLock(lock);
  }
}

/** Remove only the local pointer; workspace files and identity are never touched. */
export function removeWorkspaceRegistration(id: string): boolean {
  assertWorkspaceId(id);
  const home = writingLoopHome();
  ensureDirectory(home, "WRITING_LOOP_HOME");
  const file = registryPath(home);
  const lock = acquireLock(`${file}.lock`, "workspace registry");
  try {
    const read = readRegistryDocument(file);
    if (read.kind === "missing") return false;
    const next = read.document.workspaces.filter((entry) => entry.id !== id);
    if (next.length === read.document.workspaces.length) return false;
    atomicJsonReplace(file, { version: 1, workspaces: next } satisfies RegistryDocument, read.identity);
    return true;
  } finally {
    releaseLock(lock);
  }
}

/** Resolve an explicit ID only. This API intentionally accepts no root-path fallback. */
export function resolveRegisteredWorkspace(id: string): RegisteredWorkspace {
  assertWorkspaceId(id);
  const snapshot = inspectWorkspaceRegistry();
  if (snapshot.registryStatus === "corrupt") throw new WsError(snapshot.diagnostics[0] ?? "workspace registry 损坏");
  const entry = snapshot.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new WsError(`workspace registry 无 ID ${id}`);
  if (entry.status !== "ok") throw new WsError(`workspace ${id} ${entry.status}：${entry.diagnostic ?? "不可用"}`);
  const { status: _status, diagnostic: _diagnostic, ...registered } = entry;
  return registered;
}
