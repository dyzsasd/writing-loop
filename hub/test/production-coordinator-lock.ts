// Phase 3B project single-flight lease regression suite with real subprocess/SIGKILL recovery.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE,
  PRODUCTION_COORDINATOR_LEASE_FILE,
  acquireProductionCoordinatorLease,
  withProductionCoordinatorLease,
} from "../src/production-coordinator-lock.ts";
import { ProductionError } from "../src/production-domain.ts";

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
const children: ChildProcess[] = [];
const lockModule = new URL("../src/production-coordinator-lock.ts", import.meta.url).href;

function spawnLeaseHolder(root: string, project: string): ChildProcess {
  const script = `
    import { writeSync } from "node:fs";
    import { acquireProductionCoordinatorLease } from ${JSON.stringify(lockModule)};
    const lease = acquireProductionCoordinatorLease(${JSON.stringify(root)}, ${JSON.stringify(WS)}, ${JSON.stringify(project)});
    writeSync(1, "LOCKED\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    lease.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function spawnPausedRecovery(root: string, project: string, releaseFile: string): ChildProcess {
  const script = `
    import { existsSync, writeSync } from "node:fs";
    import { acquireProductionCoordinatorLease } from ${JSON.stringify(lockModule)};
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const lease = acquireProductionCoordinatorLease(${JSON.stringify(root)}, ${JSON.stringify(WS)}, ${JSON.stringify(project)}, {
      hooks: {
        beforeDeadOwnerRecovery: () => {
          writeSync(1, "RECOVERING\\n");
          while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(sleeper, 0, 0, 20);
        },
        afterLock: () => {
          writeSync(1, "LOCKED\\n");
          Atomics.wait(sleeper, 0, 0);
        },
      },
    });
    lease.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForOutput(child: ChildProcess, needle: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    let output = "";
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onEnd);
      child.off("exit", onEnd);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(needle)) finish(true);
    };
    const onEnd = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout?.on("data", onData);
    child.once("error", onEnd);
    child.once("exit", onEnd);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      child.off("error", onEnd);
      child.off("exit", onExit);
      resolve(value);
    };
    const onEnd = (): void => finish(true);
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("error", onEnd);
    child.once("exit", onExit);
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.once("error", () => { clearTimeout(timer); resolve(); });
  });
}

const root = mkdtempSync(join(tmpdir(), "writing-loop-production-lease-"));
for (const project of ["simple", "async", "crash", "concurrent", "replacement", "gate-crash"]) {
  mkdirSync(join(root, ".writing-loop", project), { recursive: true });
}

try {
  const simpleDir = join(root, ".writing-loop", "simple");
  const simpleLease = acquireProductionCoordinatorLease(root, WS, "simple");
  const simpleBytes = readFileSync(simpleLease.file, "utf8");
  let simpleMetadata: Record<string, unknown> = {};
  try { simpleMetadata = JSON.parse(simpleBytes) as Record<string, unknown>; } catch { /* assertions below */ }
  ok(existsSync(simpleLease.file)
    && simpleMetadata.pid === process.pid
    && simpleMetadata.workspaceId === WS
    && simpleMetadata.project === "simple"
    && simpleMetadata.lockName === PRODUCTION_COORDINATOR_LEASE_FILE,
  "lease metadata 严格绑定 uid/hostname/PID/token/workspace/project/lock name 并 durable 落盘");
  ok(!existsSync(join(simpleDir, PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE))
    && !existsSync(join(simpleDir, ".production-state.v1.lock"))
    && !existsSync(join(simpleDir, ".production-control.v1.lock")),
  "lease acquisition gate 只覆盖主锁接管事务，且绝不取得 production/control state 写锁");
  ok(throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "simple"), "不能安全接管")
    && readFileSync(simpleLease.file, "utf8") === simpleBytes,
  "同项目 live lease 阻断第二 coordinator 且 contender 不改写 owner inode");
  simpleLease.release();
  simpleLease.release();
  ok(simpleLease.released && !existsSync(join(simpleDir, PRODUCTION_COORDINATOR_LEASE_FILE)),
  "lease release 幂等且只删除自有 inode");

  const asyncDir = join(root, ".writing-loop", "async");
  let heldBeforeAwait = false;
  let heldAfterAwait = false;
  await withProductionCoordinatorLease(root, WS, "async", async () => {
    heldBeforeAwait = existsSync(join(asyncDir, PRODUCTION_COORDINATOR_LEASE_FILE));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    heldAfterAwait = existsSync(join(asyncDir, PRODUCTION_COORDINATOR_LEASE_FILE))
      && throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "async"), "不能安全接管");
  });
  ok(heldBeforeAwait && heldAfterAwait && !existsSync(join(asyncDir, PRODUCTION_COORDINATOR_LEASE_FILE)),
  "withProductionCoordinatorLease 覆盖完整 async/network round，并在 finally 释放");

  const crashDir = join(root, ".writing-loop", "crash");
  const crashChild = spawnLeaseHolder(root, "crash");
  const crashReady = await waitForOutput(crashChild, "LOCKED\n");
  ok(crashReady, "真实子进程取得并 fsync coordinator lease");
  if (crashReady) {
    const lockFile = join(crashDir, PRODUCTION_COORDINATOR_LEASE_FILE);
    const liveBytes = readFileSync(lockFile, "utf8");
    ok(throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "crash"), "不能安全接管")
      && readFileSync(lockFile, "utf8") === liveBytes,
    "kill(pid, 0) 可见的 live owner 永不被 stale recovery 删除");
    await killAndWait(crashChild);
    const recovered = acquireProductionCoordinatorLease(root, WS, "crash");
    ok(existsSync(recovered.file) && JSON.parse(readFileSync(recovered.file, "utf8")).pid === process.pid,
    "SIGKILL 后只接管同 uid/hostname/scope 且 PID 明确 ESRCH 的严格残锁");
    recovered.release();
  }

  const concurrentDir = join(root, ".writing-loop", "concurrent");
  const seed = spawnLeaseHolder(root, "concurrent");
  const seedReady = await waitForOutput(seed, "LOCKED\n");
  ok(seedReady, "双恢复 fixture 先取得真实 durable lease");
  if (seedReady) {
    await killAndWait(seed);
    const lockFile = join(concurrentDir, PRODUCTION_COORDINATOR_LEASE_FILE);
    const gateFile = join(concurrentDir, PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE);
    const releaseFile = join(concurrentDir, ".release-recovery");
    const staleBytes = readFileSync(lockFile, "utf8");
    const first = spawnPausedRecovery(root, "concurrent", releaseFile);
    const firstInGate = await waitForOutput(first, "RECOVERING\n");
    ok(firstInGate && existsSync(gateFile) && readFileSync(lockFile, "utf8") === staleBytes,
    "首个恢复者在 acquisition gate 内验证旧 inode，尚未删除可信残锁");

    const second = spawnLeaseHolder(root, "concurrent");
    const secondExited = await waitForExit(second, 3_000);
    ok(secondExited && readFileSync(lockFile, "utf8") === staleBytes,
    "第二真实恢复者被 O_EXCL gate 阻断，不能进入 lstat→unlink 窗口");

    const locked = waitForOutput(first, "LOCKED\n");
    writeFileSync(releaseFile, "continue\n");
    const firstLocked = await locked;
    const successorBytes = firstLocked ? readFileSync(lockFile, "utf8") : "{}";
    let successorPid: unknown;
    try { successorPid = (JSON.parse(successorBytes) as { pid?: unknown }).pid; } catch { /* assertion below */ }
    ok(firstLocked && successorPid === first.pid && !existsSync(gateFile)
      && throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "concurrent"), "不能安全接管")
      && readFileSync(lockFile, "utf8") === successorBytes,
    "双恢复者最多一个进入 round，后继 live lease 不被 loser/后续 contender 删除");
    await killAndWait(first);
    const finalRecovery = acquireProductionCoordinatorLease(root, WS, "concurrent");
    finalRecovery.release();
    ok(!existsSync(lockFile) && !existsSync(gateFile),
    "并发胜者 SIGKILL 后可由新 gate 安全恢复并正常释放");
  }

  const replacementDir = join(root, ".writing-loop", "replacement");
  const replacementSeed = spawnLeaseHolder(root, "replacement");
  const replacementReady = await waitForOutput(replacementSeed, "LOCKED\n");
  ok(replacementReady, "replacement race fixture 取得可信 lease");
  if (replacementReady) {
    await killAndWait(replacementSeed);
    const lockFile = join(replacementDir, PRODUCTION_COORDINATOR_LEASE_FILE);
    ok(throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "replacement", {
      hooks: {
        beforeDeadOwnerRecovery: (file) => {
          unlinkSync(file);
          writeFileSync(file, "replacement lease\n", { mode: 0o600 });
        },
      },
    }), "不能安全接管") && readFileSync(lockFile, "utf8") === "replacement lease\n",
    "dead-owner 检查后的 replacement inode 永不被 recovery 删除");
  }

  const gateDir = join(root, ".writing-loop", "gate-crash");
  const gateSeed = spawnLeaseHolder(root, "gate-crash");
  const gateSeedReady = await waitForOutput(gateSeed, "LOCKED\n");
  ok(gateSeedReady, "gate crash fixture 取得真实 durable lease");
  if (gateSeedReady) {
    await killAndWait(gateSeed);
    const lockFile = join(gateDir, PRODUCTION_COORDINATOR_LEASE_FILE);
    const gateFile = join(gateDir, PRODUCTION_COORDINATOR_ACQUISITION_GATE_FILE);
    const neverRelease = join(gateDir, ".never-release");
    const staleMain = readFileSync(lockFile, "utf8");
    const victim = spawnPausedRecovery(root, "gate-crash", neverRelease);
    const gateHeld = await waitForOutput(victim, "RECOVERING\n");
    ok(gateHeld && existsSync(gateFile), "恢复者只在 lease acquisition 窗口持有 recovery gate");
    if (gateHeld) {
      await killAndWait(victim);
      const residualGate = readFileSync(gateFile, "utf8");
      ok(throwsProduction(() => acquireProductionCoordinatorLease(root, WS, "gate-crash"), "acquisition gate")
        && readFileSync(gateFile, "utf8") === residualGate
        && readFileSync(lockFile, "utf8") === staleMain,
      "gate 自身 SIGKILL 残留时 fail-closed，绝不递归自动接管 recovery serializer");
      unlinkSync(gateFile); // 测试模拟人工确认 gate owner 已死后的显式修复。
      const repaired = acquireProductionCoordinatorLease(root, WS, "gate-crash");
      repaired.release();
      ok(!existsSync(lockFile), "人工审计移除残 gate 后仍可安全恢复原 lease");
    }
  }
} finally {
  await Promise.all(children.map((child) => killAndWait(child)));
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_COORDINATOR_LOCK_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
