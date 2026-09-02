// Workspace-side content-addressed store for the immutable ShotRequest documents that
// `production plan-shots --confirm` publishes as `intent.inputs[0]` (§4.1 资产 URI).
//
// The object body is the exact canonical JSON the AssetRef pins, so the file name *is* the identity:
// `<root>/.writing-loop/<project>/production-cas.v1/sha256/<digest>`.
//
// Publication is atomic: bytes go to a same-directory temporary file, are fsynced, and only then
// appear at their final name via `link(2)`. A crash can therefore leave a stray temporary file but
// never a half-written object at the addressed path, and `link` gives the same
// exactly-one-winner semantics as O_EXCL. The digest is recomputed from the bytes on both sides, so
// an exact replay is a no-op and a drifted body can never masquerade as an already published object.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { ProductionError } from "./production-domain.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_CAS_DIRECTORY = "production-cas.v1";
export const PRODUCTION_CAS_ALGORITHM_DIRECTORY = "sha256";
/** One ShotRequest document; the intent envelope itself is bounded by MAX_PRODUCTION_INTENT_BYTES. */
export const MAX_PRODUCTION_CAS_OBJECT_BYTES = 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function fail(message: string, cause?: unknown): never {
  const suffix = cause === undefined ? "" : `：${cause instanceof Error ? cause.message : String(cause)}`;
  throw new ProductionError(`production CAS ${message}${suffix}`);
}

function assertRealDirectory(path: string, label: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { fail(`${label} 目录不存在：${path}`, error); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} 必须是真实目录（拒绝 symlink/FIFO/device）：${path}`);
  }
}

/** `<root>/.writing-loop/<project>/production-cas.v1/sha256`; `create` 时按 0700 建目录。 */
export function productionCasDirectory(root: string, project: string, create: boolean): string | null {
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { fail(`workspace root 不存在：${resolve(root)}`, error); }
  const writingLoop = join(canonicalRoot, ".writing-loop");
  assertRealDirectory(writingLoop, "workspace state");
  const projectPath = join(writingLoop, project);
  assertRealDirectory(projectPath, `项目 '${project}'`);
  const directory = join(projectPath, PRODUCTION_CAS_DIRECTORY, PRODUCTION_CAS_ALGORITHM_DIRECTORY);
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`objects 目录必须是真实目录（拒绝 symlink/FIFO/device）：${directory}`);
    }
    return directory;
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    if (errno(error) !== "ENOENT") throw error;
    if (!create) return null;
    try { mkdirSync(directory, { mode: 0o700, recursive: true }); }
    catch (mkdirError) {
      if (errno(mkdirError) !== "EEXIST") fail(`无法创建 ${directory}`, mkdirError);
    }
    assertRealDirectory(directory, "objects");
    return directory;
  }
}

function requireDigest(sha256: string): string {
  if (!SHA256.test(sha256)) fail("对象名必须是 64 位小写 sha256");
  return sha256;
}

/** Where one object lives, whether or not it (or the directory) exists yet. */
export function productionCasObjectPath(root: string, project: string, sha256: string): string {
  assertProjectKey(project);
  return join(
    resolve(root), ".writing-loop", project,
    PRODUCTION_CAS_DIRECTORY, PRODUCTION_CAS_ALGORITHM_DIRECTORY, requireDigest(sha256),
  );
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try { fd = openSync(directory, constants.O_RDONLY); fsyncSync(fd); }
  catch { /* 平台拒绝目录 fsync 时不阻断已完成的 link */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

export type WriteProductionCasObjectResult = { created: boolean; path: string; sha256: string };

/**
 * Publish one immutable object. The file name is the digest of the bytes handed in, so an exact
 * replay resolves to `created: false`; anything already at that path whose bytes hash to something
 * else is a corrupted store and is reported as such rather than silently overwritten.
 */
export function writeProductionCasObject(
  root: string,
  project: string,
  bytes: Uint8Array,
): WriteProductionCasObjectResult {
  if (bytes.length > MAX_PRODUCTION_CAS_OBJECT_BYTES) {
    fail(`对象超过 ${MAX_PRODUCTION_CAS_OBJECT_BYTES} bytes 安全上限`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = productionCasDirectory(root, project, true)!;
  const file = join(directory, digest);
  const temporary = join(directory, `.${digest}.${randomBytes(8).toString("hex")}`);

  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) { fail(`无法创建临时文件 ${temporary}`, error); }
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) fail(`${temporary} 创建后不是单链接普通文件`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) {
      fail(`${temporary} 写入后 identity/长度异常`);
    }
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 保留首个错误 */ } fd = undefined; }
    try { unlinkSync(temporary); } catch { /* 临时文件清理失败不掩盖原始错误 */ }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  try {
    // link 是原子的且不覆盖：赢的一方发布完整对象，输的一方读回比对。
    try { linkSync(temporary, file); }
    catch (error) {
      if (errno(error) !== "EEXIST") fail(`无法把 ${temporary} 发布为 ${file}`, error);
      // 已存在的对象必须逐字节等于本次内容；崩溃残留的截断文件会在这里以可操作错误暴露。
      const existing = readProductionCasObject(root, project, digest);
      if (existing === null) fail(`${file} 已存在但不可读（拒绝覆盖；请人工核对后删除该文件再重试）`);
      return { created: false, path: file, sha256: digest };
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* 已 link 成功，临时名残留不影响正确性 */ }
  }
  syncDirectory(directory);
  return { created: true, path: file, sha256: digest };
}

/** Exact bounded read; a body whose digest no longer matches its name is a hard error, not a miss. */
export function readProductionCasObject(
  root: string,
  project: string,
  sha256: string,
  maxBytes = MAX_PRODUCTION_CAS_OBJECT_BYTES,
): Buffer | null {
  const digest = requireDigest(sha256);
  const directory = productionCasDirectory(root, project, false);
  if (directory === null) return null;
  const file = join(directory, digest);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    fail(`无法检查 ${file}`, error);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(`${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > maxBytes) fail(`${file} 超过 ${maxBytes} bytes 安全读取上限`);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || Number(opened.size) !== Number(before.size)) {
      fail(`${file} 在 lstat/open 间被替换`);
    }
    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, offset);
      if (read <= 0) fail(`${file} 读取期间被截断`);
      offset += read;
    }
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== digest) {
      fail(`${file} 内容 digest ${actual} 与对象名不一致（对象损坏；请人工核对后删除该文件再重试）`);
    }
    return body;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
