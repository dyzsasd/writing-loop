// Small synchronous filesystem primitives for local read models. Every operation has a byte or
// entry budget, rejects linked/special final paths, and verifies the opened descriptor is a
// single-link regular file.
import {
  closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync,
} from "node:fs";
import { join } from "node:path";

export type BoundedText = {
  text: string;
  bytes: number;
  updatedAt: string;
  truncated: boolean;
};

export type BoundedNames = {
  names: string[];
  truncated: boolean;
};

export type ExactReadHooks = {
  /** Test seam after bytes are read but before fd/path identity is revalidated. */
  afterRead?: () => void;
};

/** Existing path components only; missing descendants are safe-empty, any symlink is unsafe. */
export function hasSymlinkComponent(root: string, parts: string[]): boolean {
  let cursor = root;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("\0")) return true;
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function readRegularTextHead(file: string, maxBytes: number): BoundedText | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    if (text.includes("\0")) return null;
    return { text, bytes: stat.size, updatedAt: stat.mtime.toISOString(), truncated: stat.size > maxBytes };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the read result */ }
  }
}

/**
 * Read a complete small decision input and reject any same-inode mutation or path replacement.
 * Unlike the head/tail projections, truncation is never accepted and UTF-8 must be canonical.
 */
export function readRegularTextExact(
  file: string,
  maxBytes: number,
  hooks: ExactReadHooks = {},
): string | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > maxBytes) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    const same = (left: typeof opened, right: typeof opened): boolean =>
      left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
    if (!opened.isFile() || opened.nlink !== 1 || !same(before, opened)
      || opened.size < 1 || opened.size > maxBytes) return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) return null;
      offset += count;
    }
    hooks.afterRead?.();
    const afterFd = fstatSync(fd);
    const afterPath = lstatSync(file);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1
      || !same(opened, afterFd) || !same(opened, afterPath)) return null;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { return null; }
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the read result */ }
  }
}

export function readRegularTextTail(file: string, maxBytes: number): BoundedText | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1) return null;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset);
      if (!count) break;
      offset += count;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (text.includes("\0")) return null;
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    return { text, bytes: stat.size, updatedAt: stat.mtime.toISOString(), truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the read result */ }
  }
}

/** Incremental directory scan. It never materializes more than maxEntries names. */
export function readDirectoryNames(dir: string, maxEntries: number): BoundedNames {
  const names: string[] = [];
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return { names, truncated: false };
    handle = opendirSync(dir);
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return { names, truncated: false };
      if (names.length >= maxEntries) return { names, truncated: true };
      names.push(entry.name);
    }
  } catch {
    return { names: [], truncated: false };
  } finally {
    if (handle) try { handle.closeSync(); } catch { /* preserve the scan result */ }
  }
}
