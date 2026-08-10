// Server-only worker CLI boundary: trusted config path only, stable output and secret redaction.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionWorkerMain, type ProductionWorkerSignalSource } from "../src/production-worker.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

type WorkerDependencies = NonNullable<Parameters<typeof productionWorkerMain>[2]>;

async function capture(
  args: string[],
  cwd: string,
  createRegistry: NonNullable<WorkerDependencies["createRegistry"]>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
  const signalSource: ProductionWorkerSignalSource = { once: () => undefined, off: () => undefined };
  try {
    const code = await productionWorkerMain(args, cwd, { createRegistry, signalSource });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-worker-")));
try {
  mkdirSync(join(root, ".writing-loop"), { recursive: true });
  writeFileSync(join(root, ".writing-loop", "workspace.json"), JSON.stringify({
    version: 1,
    id: `ws_${"a".repeat(32)}`,
  }, null, 2) + "\n");
  writeFileSync(join(root, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: {},
  }, null, 2) + "\n");

  let factoryCalls = 0;
  let receivedRoot = "";
  let receivedConfigFile = "";
  const successfulFactory = ({ root: nextRoot, configFile }: { root: string; configFile: string }) => {
    factoryCalls++;
    receivedRoot = nextRoot;
    receivedConfigFile = configFile;
    return {
      runner: {
        runOnceAll: async () => ({
          version: 1 as const,
          startedAt: "2026-08-10T10:00:00.000Z",
          finishedAt: "2026-08-10T10:00:01.000Z",
          outcomes: [{ version: 1 as const, project: "demo", status: "succeeded" as const, result: {
            version: 1 as const, workspaceId: `ws_${"a".repeat(32)}`, project: "demo", processed: [], issues: [],
          } }],
        }),
      },
    };
  };

  const missingMode = await capture(["--config", "runtime.json"], root, successfulFactory);
  ok(missingMode.code === 2 && missingMode.err.includes("--once") && factoryCalls === 0,
    "worker 必须显式选择 --once，usage 失败不组装 runtime");
  const injection = await capture([
    "--config", "runtime.json", "--once", "--token=SUPER_SECRET_CANARY", "https://evil.test",
  ], root, successfulFactory);
  ok(injection.code === 2 && injection.err.includes("未知参数") && factoryCalls === 0
    && !injection.err.includes("SUPER_SECRET_CANARY") && !injection.err.includes("evil.test"),
    "worker argv 拒绝 endpoint/token/model 类覆盖注入，且不回显原始 argv secret");

  const success = await capture(["--config", "runtime.json", "--once", "--json"], root, successfulFactory);
  const payload = JSON.parse(success.out) as { outcomes?: Array<{ status?: string }> };
  ok(success.code === 0 && payload.outcomes?.[0]?.status === "succeeded" && factoryCalls === 1,
    "worker --once 调用一次有界 runner round 并输出稳定 JSON");
  ok(receivedRoot === root && receivedConfigFile === join(root, "runtime.json"),
    "worker 只把 canonical workspace root 与可信 config path 交给 composition root");

  const failed = await capture(["--config", "runtime.json", "--once"], root, () => ({
    runner: {
      runOnceAll: async () => ({
        version: 1 as const,
        startedAt: "2026-08-10T10:00:00.000Z",
        finishedAt: "2026-08-10T10:00:01.000Z",
        outcomes: [{ version: 1 as const, project: "demo", status: "failed" as const, code: "project-run-failed" as const }],
      }),
    },
  }));
  ok(failed.code === 1 && failed.out.includes("0 succeeded · 1 failed"),
    "worker 任一 project 稳定失败时返回非零，不隐藏部署失败");

  const canary = "SUPER_SECRET_CANARY_TOKEN";
  const crashed = await capture(["--config", "runtime.json", "--once"], root, () => {
    throw new Error(`provider exploded ${canary}`);
  });
  ok(crashed.code === 1 && crashed.err.includes("worker-failed") && !crashed.err.includes(canary),
    "未分类 composition 异常不向 stdout/stderr 泄露 token/cause");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_WORKER_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
