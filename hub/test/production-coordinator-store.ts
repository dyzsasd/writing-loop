// Phase 3B coordinator-control store regression suite: bounded reads, atomic writes and scope locks.
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyRetryState,
  type ProductionCoordinatorTaskControl,
} from "../src/production-coordinator-domain.ts";
import {
  PRODUCTION_CONTROL_LOCK_FILE,
  ProductionCoordinatorStore,
  productionCoordinatorControlPath,
  readProductionCoordinatorControlState,
} from "../src/production-coordinator-store.ts";
import {
  ProductionError,
  parseProductionTaskEvent,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsProduction = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof ProductionError && error.message.includes(needle); }
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const pendingEvent = (taskId: string): ProductionTaskEvent => ({
  version: 1,
  type: "dispatch-requested",
  eventId: `dispatch-${taskId}`,
  taskId,
  expectedRevision: 1,
  occurredAt: at(1),
});
const task = (taskId = "take-001", pending = true, observedTaskRevision = 1): ProductionCoordinatorTaskControl => ({
  version: 1,
  taskId,
  observedTaskRevision,
  budgetReservation: null,
  retryState: emptyRetryState(),
  cancelAttempt: null,
  lastObservation: null,
  pendingEvent: pending ? pendingEvent(taskId) : null,
});

const root = mkdtempSync(join(tmpdir(), "writing-loop-production-control-"));
const projectDir = join(root, ".writing-loop", "demo");
mkdirSync(projectDir, { recursive: true });

try {
  const store = new ProductionCoordinatorStore(root, WS, "demo");
  const empty = store.read();
  ok(empty.revision === 0 && empty.updatedAt === null && empty.tasks.length === 0,
  "missing production-control.v1.json 只映射为绑定 scope 的 revision=0 empty state");

  let sawShortControlLock = false;
  const observedStore = new ProductionCoordinatorStore(root, WS, "demo", {
    hooks: {
      afterLock: (file) => {
        sawShortControlLock = file.endsWith(PRODUCTION_CONTROL_LOCK_FILE)
          && !existsSync(join(projectDir, ".production-state.v1.lock"));
      },
    },
  });
  const first = observedStore.put({ expectedRevision: 0, updatedAt: at(2), task: task() }).state;
  ok(sawShortControlLock && first.revision === 1 && !existsSync(join(projectDir, PRODUCTION_CONTROL_LOCK_FILE)),
  "control mutation 只短暂持有独立 O_EXCL lock，不取得 production-state 写锁");
  ok(first.tasks[0]?.pendingEvent?.eventId === "dispatch-take-001"
    && JSON.stringify(first.tasks[0]?.pendingEvent) === JSON.stringify(parseProductionTaskEvent(pendingEvent("take-001"))),
  "pendingEvent 原样 canonical 落盘，可在 applyProductionEvent 后崩溃时精确重放");

  const persistedBeforeConflict = readFileSync(store.file, "utf8");
  ok(throwsProduction(() => store.put({ expectedRevision: 0, updatedAt: at(3), task: task("take-stale") }), "revision 冲突")
    && readFileSync(store.file, "utf8") === persistedBeforeConflict,
  "stale expectedRevision 在创建 temp 前硬错且不改写 control state");

  ok(throwsProduction(() => store.put({
    expectedRevision: 1, updatedAt: at(3), task: task("take-001", false),
  }), "authoritative event 已推进") && store.read().revision === 1,
  "pendingEvent 未对应 authoritative revision +1 时不能被控制账本单方面清除");
  const second = store.put({ expectedRevision: 1, updatedAt: at(3), task: task("take-001", false, 2) }).state;
  ok(second.revision === 2 && second.tasks[0]?.pendingEvent === null
    && second.tasks[0]?.observedTaskRevision === 2,
  "清除已重放 pendingEvent 是独立 durable mutation，document revision 精确 +1");
  const third = store.put({ expectedRevision: 2, updatedAt: at(4), task: task("take-000", false) }).state;
  ok(third.revision === 3 && third.tasks.map((row) => row.taskId).join(",") === "take-000,take-001",
  "每次成功 mutation 只加一个 revision，并以稳定 taskId 顺序持久化");
  const removed = store.remove({ expectedRevision: 3, updatedAt: at(5), taskId: "take-000" }).state;
  ok(removed.revision === 4 && removed.tasks.map((row) => row.taskId).join(",") === "take-001",
  "control task 删除同样走 scope lock + revision +1");

  const beforeFault = readFileSync(store.file, "utf8");
  const faultStore = new ProductionCoordinatorStore(root, WS, "demo", {
    hooks: { beforeRename: () => { throw new Error("injected crash before rename"); } },
  });
  ok(throwsProduction(() => faultStore.put({
    expectedRevision: 4, updatedAt: at(6), task: task("take-fault", false),
  }), "无法原子写入"), "rename 前故障作为 control write failure 上报");
  ok(readFileSync(store.file, "utf8") === beforeFault
    && !existsSync(join(projectDir, PRODUCTION_CONTROL_LOCK_FILE))
    && !readdirSync(projectDir).some((name) => name.includes("production-control.v1.json.tmp-")),
  "rename 前崩溃保留完整旧 control、清理 temp 并释放自有短锁");

  const beforeReplacement = readFileSync(store.file, "utf8");
  const replacementStore = new ProductionCoordinatorStore(root, WS, "demo", {
    hooks: {
      beforeRename: (_temporary, file) => {
        unlinkSync(file);
        writeFileSync(file, "replacement control\n", { mode: 0o600 });
      },
    },
  });
  ok(throwsProduction(() => replacementStore.put({
    expectedRevision: 4, updatedAt: at(6), task: task("take-replacement", false),
  }), "被替换"), "rename 前 replacement inode 被复核发现且不会被覆盖");
  ok(readFileSync(store.file, "utf8") === "replacement control\n",
  "atomic writer 永不删除或覆盖未观测 replacement inode");
  writeFileSync(store.file, beforeReplacement);

  ok(throwsProduction(() => readProductionCoordinatorControlState(
    root, "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "demo",
  ), "不能作为"), "control state 与 workspaceId + project 绑定，拒绝跨 workspace 读取");

  for (const project of ["corrupt", "symlink", "hardlink", "oversize", "locked"]) {
    mkdirSync(join(root, ".writing-loop", project), { recursive: true });
  }
  writeFileSync(productionCoordinatorControlPath(root, "corrupt"), "{broken");
  ok(throwsProduction(() => readProductionCoordinatorControlState(root, WS, "corrupt"), "JSON"),
  "损坏 control JSON 硬错，不降级为空状态");

  const outside = join(root, "outside-control.json");
  writeFileSync(outside, JSON.stringify({ version: 1 }));
  symlinkSync(outside, productionCoordinatorControlPath(root, "symlink"));
  ok(throwsProduction(() => readProductionCoordinatorControlState(root, WS, "symlink"), "单链接普通文件"),
  "control reader 拒绝 symlink");
  unlinkSync(productionCoordinatorControlPath(root, "symlink"));

  linkSync(outside, productionCoordinatorControlPath(root, "hardlink"));
  ok(throwsProduction(() => readProductionCoordinatorControlState(root, WS, "hardlink"), "单链接普通文件"),
  "control reader 拒绝 hardlink");
  unlinkSync(productionCoordinatorControlPath(root, "hardlink"));

  writeFileSync(productionCoordinatorControlPath(root, "oversize"), "x".repeat(1_025));
  ok(throwsProduction(() => readProductionCoordinatorControlState(root, WS, "oversize", { maxBytes: 1_024 }), "安全读取上限"),
  "control reader 在 JSON parse 前执行严格 byte 上限");

  const foreignLock = join(root, ".writing-loop", "locked", PRODUCTION_CONTROL_LOCK_FILE);
  writeFileSync(foreignLock, "foreign lock\n", { mode: 0o600 });
  const lockedStore = new ProductionCoordinatorStore(root, WS, "locked");
  ok(throwsProduction(() => lockedStore.put({
    expectedRevision: 0, updatedAt: at(1), task: task("take-locked", false),
  }), "不能安全接管") && readFileSync(foreignLock, "utf8") === "foreign lock\n",
  "control writer 对 malformed/live/permission-ambiguous lock fail-closed 且不删除 foreign inode");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_COORDINATOR_STORE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
