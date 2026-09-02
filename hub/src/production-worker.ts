#!/usr/bin/env node
// Server-only production worker entrypoint.
//
// It intentionally accepts only a trusted runtime-config path. Provider origins, credentials,
// workflow files and model identities remain inside the owner-only config/composition boundary;
// none can be overridden from argv or a Studio/browser request.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createProductionRuntimeRegistry,
  ProductionRuntimeConfigError,
} from "./production-runtime-config.ts";
import { requireWorkspace, WsError } from "./workspace.ts";
import { readWorkspaceIdentity } from "./workspace-registry.ts";
import { acquireProductionWorkerLease } from "./production-worker-lock.ts";

export type ProductionWorkerSignalSource = {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type ProductionWorkerDependencies = {
  createRegistry?: (options: {
    root: string;
    configFile: string;
  }) => {
    runner: {
      runOnceAll(signal?: AbortSignal): Promise<{
        version: 1;
        startedAt: string;
        finishedAt: string;
        outcomes: Array<{
          version: 1;
          project: string;
          status: "succeeded" | "failed" | "aborted";
          result?: unknown;
          code?: "project-run-failed" | "runner-aborted";
        }>;
      }>;
    };
  };
  signalSource?: ProductionWorkerSignalSource | null;
};

class ProductionWorkerUsageError extends Error {}

type WorkerOptions = {
  configFile: string;
  json: boolean;
};

function usage(): void {
  console.log(`writing-loop-production-worker — server-only 远端制片 worker
用法:
  writing-loop-production-worker --config FILE --once [--json]

FILE 必须是 owner-only (0400/0600) 的严格运行配置。
请用 systemd/launchd timer 周期调用 --once；命令行不接受 endpoint、token、workflow 或模型覆盖。`);
}

function parseArgs(argv: string[]): WorkerOptions {
  let configFile: string | null = null;
  let once = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--config") {
      if (configFile !== null) throw new ProductionWorkerUsageError("--config 只能指定一次");
      configFile = argv[++index] ?? null;
      if (!configFile) throw new ProductionWorkerUsageError("--config 需要 FILE");
    } else if (arg === "--once") {
      if (once) throw new ProductionWorkerUsageError("--once 只能指定一次");
      once = true;
    } else if (arg === "--json") {
      if (json) throw new ProductionWorkerUsageError("--json 只能指定一次");
      json = true;
    } else {
      throw new ProductionWorkerUsageError(`未知参数（位置 ${index + 1}）`);
    }
  }
  if (configFile === null || !once) {
    throw new ProductionWorkerUsageError("必须同时提供 --config FILE 与 --once");
  }
  return { configFile, json };
}

function publicError(error: unknown): string {
  if (error instanceof ProductionWorkerUsageError
    || error instanceof ProductionRuntimeConfigError
    || error instanceof WsError) {
    return error.message;
  }
  return "worker-failed";
}

export async function productionWorkerMain(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  dependencies: ProductionWorkerDependencies = {},
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) {
    usage();
    return 0;
  }
  try {
    const options = parseArgs(argv);
    const workspace = requireWorkspace(cwd);
    const createRegistry = dependencies.createRegistry
      ?? ((input: { root: string; configFile: string }) => createProductionRuntimeRegistry(input));
    const registry = createRegistry({
      root: workspace.root,
      configFile: resolve(cwd, options.configFile),
    });
    const workspaceId = readWorkspaceIdentity(workspace.root).id;
    const lease = acquireProductionWorkerLease(workspace.root, workspaceId);

    const controller = new AbortController();
    const signalSource = dependencies.signalSource === undefined ? process : dependencies.signalSource;
    const stop = (): void => controller.abort(new Error("production worker stopped"));
    signalSource?.once("SIGINT", stop);
    signalSource?.once("SIGTERM", stop);
    try {
      const result = await registry.runner.runOnceAll(controller.signal);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const succeeded = result.outcomes.filter((outcome) => outcome.status === "succeeded").length;
        const failed = result.outcomes.filter((outcome) => outcome.status === "failed").length;
        const aborted = result.outcomes.filter((outcome) => outcome.status === "aborted").length;
        console.log(`production worker: ${succeeded} succeeded · ${failed} failed · ${aborted} aborted`);
      }
      return result.outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0;
    } finally {
      signalSource?.off("SIGINT", stop);
      signalSource?.off("SIGTERM", stop);
      lease.release();
    }
  } catch (error) {
    console.error(`writing-loop-production-worker: ${publicError(error)}`);
    if (error instanceof ProductionWorkerUsageError) usage();
    return error instanceof ProductionWorkerUsageError ? 2 : 1;
  }
}

/**
 * npm installs a bin as a symlink and Node resolves an ESM entry to its realpath, so comparing
 * `import.meta.url` with the raw `process.argv[1]` is false under `~/.npm-global/bin/...` and the
 * process would exit 0 without ever running a pass. Compare realpaths instead.
 */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedAsMain()) {
  process.exitCode = await productionWorkerMain();
}
