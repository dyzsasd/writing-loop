// Per-project crash-recovery control ledger for the Phase 3B coordinator.
//
// Writes are short, synchronous and independent from production-state.v1.json. In particular, a
// coordinator must never keep this write lock (or the authoritative production lock) across
// network I/O; only the project coordinator lease spans a reconciliation round.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ProductionError } from "./production-domain.ts";
import {
  emptyProductionCoordinatorControlState,
  nextProductionCoordinatorControlState,
  parseProductionCoordinatorControlState,
  parseProductionCoordinatorTaskControl,
  type ProductionCoordinatorControlState,
  type ProductionCoordinatorTaskControl,
} from "./production-coordinator-domain.ts";
import {
  acquireProductionCoordinatorOwnedLock,
  productionCoordinatorProjectDirectory,
  type ProductionCoordinatorLockHooks,
} from "./production-coordinator-lock.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_CONTROL_FILE = "production-control.v1.json";
export const PRODUCTION_CONTROL_LOCK_FILE = ".production-control.v1.lock";
export const PRODUCTION_CONTROL_ACQUISITION_GATE_FILE = ".production-control.v1.acquire";
export const MAX_PRODUCTION_CONTROL_BYTES = 16 * 1024 * 1024;

export type ProductionCoordinatorStoreHooks = ProductionCoordinatorLockHooks & {
  /** Fault/race seam: a complete durable temp exists, but rename has not happened. */
  beforeRename?: (temporaryFile: string, controlFile: string) => void;
};

export type ProductionCoordinatorStoreOptions = {
  maxBytes?: number;
  hooks?: ProductionCoordinatorStoreHooks;
};

export type ProductionCoordinatorControlMutation = {
  expectedRevision: number;
  updatedAt: string;
  /** Pure synchronous transformation. Returning a Promise or malformed task list is a hard error. */
  mutate: (
    tasks: readonly ProductionCoordinatorTaskControl[],
    current: Readonly<ProductionCoordinatorControlState>,
  ) => readonly ProductionCoordinatorTaskControl[];
};

export type ProductionCoordinatorControlMutationResult = {
  previousRevision: number;
  state: ProductionCoordinatorControlState;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type LoadedState = {
  state: ProductionCoordinatorControlState;
  identity: FileIdentity | null;
};

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function storeError(message: string, cause?: unknown): ProductionError {
  const suffix = cause === undefined ? "" : `：${cause instanceof Error ? cause.message : String(cause)}`;
  return new ProductionError(`${message}${suffix}`);
}

function boundedMaxBytes(options: ProductionCoordinatorStoreOptions): number {
  const value = options.maxBytes ?? MAX_PRODUCTION_CONTROL_BYTES;
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_PRODUCTION_CONTROL_BYTES) {
    throw new ProductionError(`production control maxBytes 必须在 1024–${MAX_PRODUCTION_CONTROL_BYTES} 之间`);
  }
  return value;
}

export function productionCoordinatorControlPath(root: string, project: string): string {
  assertProjectKey(project);
  return join(resolve(root), ".writing-loop", project, PRODUCTION_CONTROL_FILE);
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
    if (errno(error) === "ENOENT") {
      return { state: emptyProductionCoordinatorControlState(workspaceId, project), identity: null };
    }
    throw storeError(`无法检查 production control ${file}`, error);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new ProductionError(`${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > maxBytes) throw new ProductionError(`${file} 超过 ${maxBytes} bytes 安全读取上限`);

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new ProductionError(`${file} 打开后不是单链接普通文件`);
    const beforeIdentity = identityOf(before);
    const openedIdentity = identityOf(opened);
    if (!sameIdentity(beforeIdentity, openedIdentity)) throw new ReadRace(`${file} 在 lstat/open 间被替换`);
    if (opened.size > maxBytes) throw new ProductionError(`${file} 超过 ${maxBytes} bytes 安全读取上限`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length || !sameIdentity(openedIdentity, identityOf(fstatSync(fd)))) {
      throw new ReadRace(`${file} 在读取期间变化`);
    }
    const raw = bytes.toString("utf8");
    if (raw.includes("\0")) throw new ProductionError(`${file} 含 NUL 字节`);
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { throw storeError(`${file} 损坏（JSON 解析失败）`, error); }
    return {
      state: parseProductionCoordinatorControlState(value, { workspaceId, project }, file),
      identity: openedIdentity,
    };
  } catch (error) {
    if (error instanceof ProductionError || error instanceof ReadRace) throw error;
    throw storeError(`无法安全读取 production control ${file}`, error);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve primary result */ }
  }
}

function loadState(file: string, workspaceId: string, project: string, maxBytes: number): LoadedState {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return readOnce(file, workspaceId, project, maxBytes); }
    catch (error) {
      if (!(error instanceof ReadRace) || attempt === 1) {
        if (error instanceof ReadRace) throw storeError(`production control 在读取期间持续被替换：${file}`);
        throw error;
      }
    }
  }
  throw new ProductionError("无法读取 production control");
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
      throw new ProductionError(`${file} 在锁内读取后出现；拒绝覆盖未观测的 control 文件`);
    } catch (error) {
      if (error instanceof ProductionError) throw error;
      if (errno(error) !== "ENOENT") throw storeError(`无法复核 production control ${file}`, error);
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
  stateValue: ProductionCoordinatorControlState,
  expected: FileIdentity | null,
  maxBytes: number,
  hooks: ProductionCoordinatorStoreHooks,
): void {
  const state = parseProductionCoordinatorControlState(stateValue, {
    workspaceId: stateValue.workspaceId,
    project: stateValue.project,
  });
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (bytes.length > maxBytes) throw new ProductionError(`production control 超过 ${maxBytes} bytes 持久化上限`);
  const directory = dirname(file);
  const temporary = join(directory, `.${basename(file)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new ProductionError(`${temporary} 不是独占普通文件`);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertReplaceable(file, expected);
    hooks.beforeRename?.(temporary, file);
    // The hook may model an unsynchronised replacement; verify identity again before rename.
    assertReplaceable(file, expected);
    renameSync(temporary, file);
    (hooks.syncDirectory ?? fsyncDirectory)(directory);
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    throw storeError(`无法原子写入 production control ${file}`, error);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* cleanup below */ }
    try { unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

export function readProductionCoordinatorControlState(
  root: string,
  workspaceId: string,
  project: string,
  options: ProductionCoordinatorStoreOptions = {},
): ProductionCoordinatorControlState {
  const directory = productionCoordinatorProjectDirectory(root, workspaceId, project);
  return loadState(join(directory, PRODUCTION_CONTROL_FILE), workspaceId, project, boundedMaxBytes(options)).state;
}

export function mutateProductionCoordinatorControlState(
  root: string,
  workspaceId: string,
  project: string,
  mutation: ProductionCoordinatorControlMutation,
  options: ProductionCoordinatorStoreOptions = {},
): ProductionCoordinatorControlMutationResult {
  if (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0) {
    throw new ProductionError("production control expectedRevision 必须是非负安全整数");
  }
  if (typeof mutation.mutate !== "function") throw new ProductionError("production control mutate 必须是同步函数");
  const directory = productionCoordinatorProjectDirectory(root, workspaceId, project);
  const file = join(directory, PRODUCTION_CONTROL_FILE);
  const maxBytes = boundedMaxBytes(options);
  const hooks = options.hooks ?? {};
  const lock = acquireProductionCoordinatorOwnedLock(directory, workspaceId, project, {
    file: PRODUCTION_CONTROL_LOCK_FILE,
    gate: PRODUCTION_CONTROL_ACQUISITION_GATE_FILE,
    label: "production coordinator control 写锁",
  }, hooks);
  try {
    const loaded = loadState(file, workspaceId, project, maxBytes);
    if (loaded.state.revision !== mutation.expectedRevision) {
      throw new ProductionError(
        `production control revision 冲突：期望 ${mutation.expectedRevision}，当前 ${loaded.state.revision}`,
      );
    }
    // Isolate the loaded authoritative snapshot from an accidental in-place callback mutation.
    const currentForCallback = structuredClone(loaded.state);
    const tasksValue = mutation.mutate(structuredClone(currentForCallback.tasks), currentForCallback);
    if (!Array.isArray(tasksValue)) throw new ProductionError("production control mutate 必须同步返回 task 数组");
    const tasks = tasksValue.map((task, index) =>
      parseProductionCoordinatorTaskControl(task, `ProductionCoordinatorMutation.tasks[${index}]`));
    const state = nextProductionCoordinatorControlState(loaded.state, tasks, mutation.updatedAt);
    atomicWrite(file, state, loaded.identity, maxBytes, hooks);
    return { previousRevision: loaded.state.revision, state };
  } finally {
    lock.release();
  }
}

export function putProductionCoordinatorTaskControl(
  root: string,
  workspaceId: string,
  project: string,
  input: {
    expectedRevision: number;
    updatedAt: string;
    task: ProductionCoordinatorTaskControl;
  },
  options: ProductionCoordinatorStoreOptions = {},
): ProductionCoordinatorControlMutationResult {
  const task = parseProductionCoordinatorTaskControl(input.task);
  return mutateProductionCoordinatorControlState(root, workspaceId, project, {
    expectedRevision: input.expectedRevision,
    updatedAt: input.updatedAt,
    mutate: (tasks) => [...tasks.filter((row) => row.taskId !== task.taskId), task],
  }, options);
}

export function removeProductionCoordinatorTaskControl(
  root: string,
  workspaceId: string,
  project: string,
  input: { expectedRevision: number; updatedAt: string; taskId: string },
  options: ProductionCoordinatorStoreOptions = {},
): ProductionCoordinatorControlMutationResult {
  const taskId = parseProductionCoordinatorTaskControl({
    version: 1,
    taskId: input.taskId,
    observedTaskRevision: 1,
    budgetReservation: null,
    retryState: { version: 1, attempt: 0, notBefore: null, lastFailure: null },
    cancelAttempt: null,
    lastObservation: null,
    pendingEvent: null,
  }).taskId;
  return mutateProductionCoordinatorControlState(root, workspaceId, project, {
    expectedRevision: input.expectedRevision,
    updatedAt: input.updatedAt,
    mutate: (tasks) => {
      if (!tasks.some((row) => row.taskId === taskId)) {
        throw new ProductionError(`production coordinator control task ${taskId} 不存在`);
      }
      return tasks.filter((row) => row.taskId !== taskId);
    },
  }, options);
}

export class ProductionCoordinatorStore {
  readonly #root: string;
  readonly #workspaceId: string;
  readonly #project: string;
  readonly #options: ProductionCoordinatorStoreOptions;

  constructor(
    root: string,
    workspaceId: string,
    project: string,
    options: ProductionCoordinatorStoreOptions = {},
  ) {
    emptyProductionCoordinatorControlState(workspaceId, project);
    this.#root = root;
    this.#workspaceId = workspaceId;
    this.#project = project;
    this.#options = options;
  }

  get file(): string { return productionCoordinatorControlPath(this.#root, this.#project); }

  read(): ProductionCoordinatorControlState {
    return readProductionCoordinatorControlState(this.#root, this.#workspaceId, this.#project, this.#options);
  }

  mutate(mutation: ProductionCoordinatorControlMutation): ProductionCoordinatorControlMutationResult {
    return mutateProductionCoordinatorControlState(
      this.#root, this.#workspaceId, this.#project, mutation, this.#options,
    );
  }

  put(input: {
    expectedRevision: number;
    updatedAt: string;
    task: ProductionCoordinatorTaskControl;
  }): ProductionCoordinatorControlMutationResult {
    return putProductionCoordinatorTaskControl(
      this.#root, this.#workspaceId, this.#project, input, this.#options,
    );
  }

  remove(input: {
    expectedRevision: number;
    updatedAt: string;
    taskId: string;
  }): ProductionCoordinatorControlMutationResult {
    return removeProductionCoordinatorTaskControl(
      this.#root, this.#workspaceId, this.#project, input, this.#options,
    );
  }
}
