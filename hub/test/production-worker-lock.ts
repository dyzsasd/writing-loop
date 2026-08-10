// Workspace-level worker single-flight prevents per-process backend permits from multiplying.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionError } from "../src/production-domain.ts";
import {
  acquireProductionWorkerLease,
  PRODUCTION_WORKER_LEASE_FILE,
} from "../src/production-worker-lock.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-worker-lock-")));
const workspaceId = `ws_${"a".repeat(32)}`;
try {
  mkdirSync(join(root, ".writing-loop"));
  writeFileSync(join(root, ".writing-loop", "workspace.json"), JSON.stringify({ version: 1, id: workspaceId }) + "\n");
  const first = acquireProductionWorkerLease(root, workspaceId);
  let contended = false;
  try { acquireProductionWorkerLease(root, workspaceId); }
  catch (error) {
    contended = error instanceof ProductionError
      && error.message.includes("production workspace worker lease")
      && error.message.includes("已存在");
  }
  ok(contended && existsSync(join(root, ".writing-loop", PRODUCTION_WORKER_LEASE_FILE)),
    "两个独立 worker 实例不能同时取得 workspace 单飞锁");
  first.release();
  const successor = acquireProductionWorkerLease(root, workspaceId);
  ok(first.released && !successor.released,
    "前一 worker 安全释放后 successor 可取得新 inode lease");
  successor.release();
  ok(!existsSync(join(root, ".writing-loop", PRODUCTION_WORKER_LEASE_FILE)),
    "worker round 收敛后只删除自己持有的 lease inode");

  const moduleUrl = new URL("../src/production-worker-lock.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { acquireProductionWorkerLease } from ${JSON.stringify(moduleUrl)};
    const lease = acquireProductionWorkerLease(process.env.WL_TEST_ROOT, process.env.WL_TEST_WORKSPACE_ID);
    process.stdout.write("READY\\n");
    process.stdin.resume();
    process.stdin.once("end", () => { lease.release(); });
  `], {
    env: { ...process.env, WL_TEST_ROOT: root, WL_TEST_WORKSPACE_ID: workspaceId },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("child lease timeout")), 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        rejectReady(new Error(`child lease exited ${code}`));
      }
    });
  });
  let crossProcessContended = false;
  try { acquireProductionWorkerLease(root, workspaceId); }
  catch (error) { crossProcessContended = error instanceof ProductionError; }
  ok(crossProcessContended,
    "真实独立 Node 进程持有 worker lease 时，第二进程不能绕过 per-backend 单飞");
  child.stdin.end();
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("child release timeout")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveExit();
      else rejectExit(new Error(`child release exited ${code}`));
    });
  });
  ok(!existsSync(join(root, ".writing-loop", PRODUCTION_WORKER_LEASE_FILE)),
    "真实子进程正常收敛后释放 workspace lease");

  let mismatch = false;
  try { acquireProductionWorkerLease(root, `ws_${"b".repeat(32)}`); }
  catch (error) { mismatch = error instanceof ProductionError && error.message.includes("durable identity"); }
  ok(mismatch, "workspace worker lease 必须精确绑定 durable workspace identity");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_WORKER_LOCK_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
