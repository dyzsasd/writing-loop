// workspace 配置的唯一写入口。观测命令继续走 workspace.ts 的宽松只读投影；这里在
// 写前持有 config.json.lock，并以同目录临时文件 + rename 原子替换，避免两个 Studio/CLI
// 操作者互相覆盖。更新只触碰目标项目的 enabled 字段，其余（包括未来版本字段）原样透传。
import {
  closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { hasSymlinkComponent } from "./bounded-fs.ts";
import { assertProjectKey, dataRoot, projectDataDir, WsError, type WlConfig, type WlProject } from "./workspace.ts";

export { assertProjectKey, PROJECT_KEY_PATTERN } from "./workspace.ts";

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function parseConfig(raw: string, file: string): WlConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WsError(`${file} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WsError(`${file} 顶层必须是 JSON 对象`);
  }
  return value as WlConfig;
}

function formattingOf(raw: string): { indent?: number | string; eol: "\n" | "\r\n"; finalEol: boolean } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const finalEol = raw.endsWith("\n");
  if (!raw.includes("\n")) return { eol, finalEol };
  const match = /\r?\n([\t ]+)\S/.exec(raw);
  return { indent: match?.[1] ?? 2, eol, finalEol };
}

function serialized(config: WlConfig, original: string): string {
  const format = formattingOf(original);
  let next = JSON.stringify(config, null, format.indent);
  if (format.eol === "\r\n") next = next.replace(/\n/g, "\r\n");
  return next + (format.finalEol ? format.eol : "");
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

function appendProjectEvent(root: string, key: string, project: WlProject, enabled: boolean): void {
  let fd: number | undefined;
  try {
    if (hasSymlinkComponent(root, [".writing-loop", key])) throw new WsError(`项目 '${key}' 的运行态路径含符号链接`);
    const file = join(projectDataDir(root, key), "events.jsonl");
    fd = openSync(file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) {
      throw new WsError(`项目 activity ledger 必须是单链接普通文件：${file}`);
    }
    const at = new Date().toISOString();
    const event = {
      version: 1,
      id: `project.${enabled ? "resumed" : "paused"}:${at}:${randomUUID()}`,
      type: enabled ? "project.resumed" : "project.paused",
      at,
      actor: "operator",
      title: typeof project.title === "string" ? project.title : key,
      detail: enabled ? "项目恢复创作" : "项目暂停；运行中的 scheduler 将 graceful drain",
    };
    writeFileSync(fd, JSON.stringify(event) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type WorkspaceConfigSession = {
  file: string;
  raw: string;
  config: WlConfig;
  /**
   * Replace config.json exactly once while the caller still holds config.json.lock.
   * The replacement preserves indentation/EOL/mode and is temp+fsync+rename atomic.
   */
  replace(next: WlConfig, onRenamed?: () => void): void;
};

export type WorkspaceConfigRuntime = {
  /** Test seam; production uses fsync on the config parent directory after rename. */
  syncDirectory?: (dir: string) => void;
};

/**
 * Shared config write transaction. The callback runs while this process owns the O_EXCL lock and
 * receives the config re-read from disk after lock acquisition. It may perform other staged,
 * reversible filesystem promotions before calling replace(); this is what lets onboarding publish
 * repo + board + config as one coordinated commit without inventing a second lock protocol.
 */
export function withWorkspaceConfigLock<T>(
  root: string,
  action: (session: WorkspaceConfigSession) => T,
  runtime: WorkspaceConfigRuntime = {},
): T {
  const file = join(dataRoot(root), "config.json");
  const lockFile = `${file}.lock`;
  let lockFd: number | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let tempFile: string | undefined;
  let tempFd: number | undefined;

  try {
    try {
      // wx = O_CREAT | O_EXCL：同一时刻只有一个配置写者，且绝不截断已有锁。
      lockFd = openSync(lockFile, "wx", 0o600);
      const identity = fstatSync(lockFd);
      lockIdentity = { dev: identity.dev, ino: identity.ino };
    } catch (error) {
      if (errno(error) === "EEXIST") {
        let age = 0;
        try { age = Math.round((Date.now() - statSync(lockFile).mtimeMs) / 60_000); } catch { /* 竞争释放 */ }
        const recovery = age > 60
          ? "锁已超过 60 分钟，可能是崩溃残留；运行 writing-loop doctor，并在确认记录 PID 已退出后手动移除"
          : "稍后重试";
        throw new WsError(`配置正被另一进程修改（锁 ${lockFile} 已存在，age ${age}min）——${recovery}`);
      }
      throw new WsError(`无法取得配置写锁 ${lockFile}：${error instanceof Error ? error.message : String(error)}`);
    }
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
    fsyncSync(lockFd);

    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      throw new WsError(`无法读取 ${file}：${error instanceof Error ? error.message : String(error)}`);
    }
    const config = parseConfig(raw, file);
    let replaced = false;
    const replace = (next: WlConfig, onRenamed?: () => void): void => {
      if (replaced) throw new WsError("同一配置事务只能替换 config.json 一次");
      const dir = dirname(file);
      tempFile = join(dir, `.config.json.tmp-${process.pid}-${randomUUID()}`);
      let mode = 0o600;
      try { mode = statSync(file).mode & 0o777; } catch { /* read 已给出更有用的错误；保守权限兜底 */ }
      tempFd = openSync(tempFile, "wx", mode);
      writeFileSync(tempFd, serialized(next, raw), "utf8");
      fsyncSync(tempFd);
      closeSync(tempFd);
      tempFd = undefined;
      renameSync(tempFile, file); // 同目录 rename：读者只会看到完整旧版或完整新版。
      tempFile = undefined;
      replaced = true;
      onRenamed?.();
      // rename 已是不可回滚的可见性提交；onRenamed 先让 onboarding 记住该边界。目录
      // fsync 若失败必须上抛，使调用方保留 journal/markers 且不宣称断电持久化成功。
      (runtime.syncDirectory ?? fsyncDirectory)(dir);
    };
    return action({ file, raw, config, replace });
  } finally {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch { /* 最佳努力清理，保留原始异常 */ }
    }
    if (tempFile !== undefined) {
      try { unlinkSync(tempFile); } catch { /* 最佳努力清理，保留原始异常 */ }
    }
    if (lockFd !== undefined) {
      try {
        const current = statSync(lockFile);
        // 只删除仍指向自己所获 inode 的路径；若路径被外部替换，绝不误删新写者的锁。
        if (lockIdentity && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) unlinkSync(lockFile);
      } catch { /* 已被释放或不可读，不覆盖业务异常 */ }
      try { closeSync(lockFd); } catch { /* 已关闭也无妨 */ }
    }
  }
}

/**
 * 原子设置项目启停状态。未知项目与并发锁都硬错；本函数不会接管或删除别人的锁。
 * 返回更新后的项目宽松投影，便于 CLI/Studio 回显。
 */
export function setProjectEnabled(
  root: string,
  key: string,
  enabled: boolean,
  testHooks: { afterReplace?: () => void } = {},
): WlProject {
  assertProjectKey(key); // 必须先于任何路径/文件操作，阻断路径穿越式 key。

  const result = withWorkspaceConfigLock(root, ({ config, replace, file }) => {
    const projects = config.projects;
    if (projects === null || typeof projects !== "object" || Array.isArray(projects)) {
      throw new WsError(`${file} 的 projects 必须是 JSON 对象`);
    }
    if (!Object.prototype.hasOwnProperty.call(projects, key)) {
      throw new WsError(`config.json 无项目 '${key}'（现有：${Object.keys(projects ?? {}).join("、") || "无"}）`);
    }
    const project = projects[key];
    if (!project) {
      throw new WsError(`config.json 项目 '${key}' 必须是 JSON 对象`);
    }
    if (typeof project !== "object" || Array.isArray(project)) {
      throw new WsError(`config.json 项目 '${key}' 必须是 JSON 对象`);
    }

    const changed = (project.enabled !== false) !== enabled;
    if (!changed) return { project, changed };
    project.enabled = enabled;
    replace(config);
    testHooks.afterReplace?.();
    // 必须仍在 config lock 内追加：这样并发 pause/resume 的 ledger 顺序与配置提交顺序一致。
    // 遥测失败不撤销已发布 config，但 O_NOFOLLOW 保证坏 ledger/symlink 不能伤及其他文件。
    try { appendProjectEvent(root, key, project, enabled); }
    catch { /* 非权威活动遥测失败不回滚已原子提交的 config */ }
    return { project, changed };
  });
  return result.project;
}
