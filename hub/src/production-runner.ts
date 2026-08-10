// Server-only Phase 3C scheduling for project-scoped production coordinator rounds.
//
// The runner deliberately owns no filesystem lock. Its non-reentrancy guard and concurrency
// counters live only in memory, so no runtime-wide lock is held while a project performs remote
// I/O. Cross-process safety remains the coordinator's project-scoped lease.
import type { ProductionCoordinatorRunResult } from "./production-coordinator.ts";

export const MAX_PRODUCTION_RUNTIME_PROJECTS = 256;
export const MAX_PRODUCTION_PROJECT_CONCURRENCY = 32;
export const MAX_PRODUCTION_BACKEND_CONCURRENCY = 16;
export const MAX_PRODUCTION_RUNNER_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type ProductionRunnableProject<RunResult = ProductionCoordinatorRunResult> = {
  project: string;
  /** Conservative project declaration. A run consumes one permit from every listed backend. */
  backendInstanceIds: readonly string[];
  run(signal?: AbortSignal): Promise<RunResult>;
};

export type ProductionProjectRunOutcome<RunResult = ProductionCoordinatorRunResult> =
  | { version: 1; project: string; status: "succeeded"; result: RunResult }
  | { version: 1; project: string; status: "failed"; code: "project-run-failed" }
  | { version: 1; project: string; status: "aborted"; code: "runner-aborted" };

export type ProductionRunOnceAllResult<RunResult = ProductionCoordinatorRunResult> = {
  version: 1;
  startedAt: string;
  finishedAt: string;
  outcomes: ProductionProjectRunOutcome<RunResult>[];
};

export type ProductionPeriodicRunResult<RunResult = ProductionCoordinatorRunResult> = {
  version: 1;
  ticksCompleted: number;
  lastRun: ProductionRunOnceAllResult<RunResult> | null;
  stopped: "aborted";
};

export type ProductionSignalSource = {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type ProductionRunnerOptions<RunResult = ProductionCoordinatorRunResult> = {
  projects: readonly ProductionRunnableProject<RunResult>[];
  projectConcurrency: number;
  perBackendConcurrency: number;
  intervalMs: number;
  now?: () => Date | string;
};

export type ProductionPeriodicOptions = {
  signal?: AbortSignal;
  /** Defaults to process. Pass null only when a containing service owns OS signal handling. */
  signalSource?: ProductionSignalSource | null;
  stopSignals?: readonly NodeJS.Signals[];
};

export type ProductionRunnerErrorCode =
  | "invalid-config"
  | "already-running"
  | "periodic-already-running";

export class ProductionRunnerError extends Error {
  readonly code: ProductionRunnerErrorCode;

  constructor(code: ProductionRunnerErrorCode, message: string) {
    super(message);
    this.name = "ProductionRunnerError";
    this.code = code;
  }
}

const SAFE_PROJECT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_BACKEND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProductionRunnerError("invalid-config", `${label} 必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function canonicalIso(value: Date | string): string {
  const text = value instanceof Date ? value.toISOString() : value;
  const millis = typeof text === "string" ? Date.parse(text) : Number.NaN;
  if (typeof text !== "string" || text.length > 64 || !Number.isFinite(millis)
    || new Date(millis).toISOString() !== text) {
    throw new ProductionRunnerError("invalid-config", "ProductionRunner clock 必须返回规范 UTC ISO-8601 时间");
  }
  return text;
}

function copyProjects<RunResult>(value: readonly ProductionRunnableProject<RunResult>[]): ProductionRunnableProject<RunResult>[] {
  if (!Array.isArray(value) || value.length > MAX_PRODUCTION_RUNTIME_PROJECTS) {
    throw new ProductionRunnerError("invalid-config", `projects 最多包含 ${MAX_PRODUCTION_RUNTIME_PROJECTS} 项`);
  }
  const projects = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || typeof entry.project !== "string"
      || !fullMatch(SAFE_PROJECT, entry.project) || typeof entry.run !== "function"
      || !Array.isArray(entry.backendInstanceIds) || entry.backendInstanceIds.length < 1
      || entry.backendInstanceIds.length > 64) {
      throw new ProductionRunnerError("invalid-config", `projects[${index}] 无效`);
    }
    const backendInstanceIds = entry.backendInstanceIds.map((backend: unknown, backendIndex: number) => {
      if (typeof backend !== "string" || !fullMatch(SAFE_BACKEND, backend)) {
        throw new ProductionRunnerError("invalid-config", `projects[${index}].backendInstanceIds[${backendIndex}] 无效`);
      }
      return backend;
    });
    if (new Set(backendInstanceIds).size !== backendInstanceIds.length) {
      throw new ProductionRunnerError("invalid-config", `projects[${index}].backendInstanceIds 不得重复`);
    }
    return Object.freeze({
      project: entry.project,
      backendInstanceIds: Object.freeze([...backendInstanceIds].sort()),
      run: entry.run,
    });
  });
  if (new Set(projects.map((entry) => entry.project)).size !== projects.length) {
    throw new ProductionRunnerError("invalid-config", "projects 不得包含重复 project");
  }
  return projects;
}

function abortError(): Error {
  const error = new Error("production runner aborted");
  error.name = "AbortError";
  return error;
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  const listener = (): void => target.abort(source?.reason ?? abortError());
  if (source?.aborted) listener();
  else source?.addEventListener("abort", listener, { once: true });
  return () => source?.removeEventListener("abort", listener);
}

async function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ProductionRunner<RunResult = ProductionCoordinatorRunResult> {
  readonly #projects: readonly ProductionRunnableProject<RunResult>[];
  readonly #projectConcurrency: number;
  readonly #perBackendConcurrency: number;
  readonly #intervalMs: number;
  readonly #now: () => Date | string;
  #activeRun: Promise<ProductionRunOnceAllResult<RunResult>> | null = null;
  #periodicRun: Promise<ProductionPeriodicRunResult<RunResult>> | null = null;

  constructor(options: ProductionRunnerOptions<RunResult>) {
    this.#projects = Object.freeze(copyProjects(options.projects));
    this.#projectConcurrency = boundedInteger(
      options.projectConcurrency, 1, MAX_PRODUCTION_PROJECT_CONCURRENCY, "projectConcurrency",
    );
    this.#perBackendConcurrency = boundedInteger(
      options.perBackendConcurrency, 1, MAX_PRODUCTION_BACKEND_CONCURRENCY, "perBackendConcurrency",
    );
    this.#intervalMs = boundedInteger(options.intervalMs, 1, MAX_PRODUCTION_RUNNER_INTERVAL_MS, "intervalMs");
    this.#now = options.now ?? (() => new Date());
  }

  get running(): boolean { return this.#activeRun !== null; }
  get periodicRunning(): boolean { return this.#periodicRun !== null; }

  /** Run exactly the configured registry. No workspace/project discovery occurs here. */
  runOnceAll(signal?: AbortSignal): Promise<ProductionRunOnceAllResult<RunResult>> {
    if (this.#periodicRun !== null) {
      throw new ProductionRunnerError("already-running", "periodic production runner 运行期间拒绝手工重入");
    }
    return this.#startOneRound(signal);
  }

  #startOneRound(signal?: AbortSignal): Promise<ProductionRunOnceAllResult<RunResult>> {
    if (this.#activeRun !== null) {
      throw new ProductionRunnerError("already-running", "production runner 已有进行中的 round");
    }
    const run = this.#executeOneRound(signal);
    this.#activeRun = run;
    void run.finally(() => {
      if (this.#activeRun === run) this.#activeRun = null;
    }).catch(() => undefined);
    return run;
  }

  async #executeOneRound(signal?: AbortSignal): Promise<ProductionRunOnceAllResult<RunResult>> {
    const startedAt = canonicalIso(this.#now());
    const pending = this.#projects.map((project, index) => ({ project, index }));
    const outcomes = new Array<ProductionProjectRunOutcome<RunResult> | undefined>(this.#projects.length);
    const backendUsage = new Map<string, number>();
    const active = new Set<Promise<void>>();

    const canStart = (project: ProductionRunnableProject<RunResult>): boolean =>
      active.size < this.#projectConcurrency
      && project.backendInstanceIds.every((backend) => (backendUsage.get(backend) ?? 0) < this.#perBackendConcurrency);

    const reserve = (project: ProductionRunnableProject<RunResult>, amount: 1 | -1): void => {
      for (const backend of project.backendInstanceIds) {
        const next = (backendUsage.get(backend) ?? 0) + amount;
        if (next === 0) backendUsage.delete(backend);
        else backendUsage.set(backend, next);
      }
    };

    while (pending.length > 0 || active.size > 0) {
      if (signal?.aborted && pending.length > 0) {
        for (const item of pending.splice(0)) {
          outcomes[item.index] = { version: 1, project: item.project.project, status: "aborted", code: "runner-aborted" };
        }
      }

      let launched = false;
      if (!signal?.aborted) {
        for (let index = 0; index < pending.length && active.size < this.#projectConcurrency;) {
          const item = pending[index]!;
          if (!canStart(item.project)) {
            index++;
            continue;
          }
          pending.splice(index, 1);
          reserve(item.project, 1);
          let operation!: Promise<void>;
          operation = Promise.resolve().then(async () => {
            try {
              const result = await item.project.run(signal);
              outcomes[item.index] = { version: 1, project: item.project.project, status: "succeeded", result };
            } catch {
              outcomes[item.index] = signal?.aborted
                ? { version: 1, project: item.project.project, status: "aborted", code: "runner-aborted" }
                : { version: 1, project: item.project.project, status: "failed", code: "project-run-failed" };
            } finally {
              reserve(item.project, -1);
              active.delete(operation);
            }
          });
          active.add(operation);
          launched = true;
        }
      }

      if (active.size > 0) {
        await Promise.race(active);
        continue;
      }
      if (pending.length > 0 && !signal?.aborted && !launched) {
        throw new ProductionRunnerError("invalid-config", "production runner 无法为待运行项目分配 backend permit");
      }
    }

    return {
      version: 1,
      startedAt,
      finishedAt: canonicalIso(this.#now()),
      outcomes: outcomes as ProductionProjectRunOutcome<RunResult>[],
    };
  }

  /**
   * Run immediate, non-overlapping rounds until aborted or an OS stop signal is observed. The
   * current round receives the abort and is awaited before handlers are removed and this resolves.
   */
  runPeriodically(options: ProductionPeriodicOptions = {}): Promise<ProductionPeriodicRunResult<RunResult>> {
    if (this.#periodicRun !== null) {
      throw new ProductionRunnerError("periodic-already-running", "periodic production runner 已在运行");
    }
    if (this.#activeRun !== null) {
      throw new ProductionRunnerError("already-running", "production round 运行期间不能启动 periodic runner");
    }
    const run = this.#executePeriodic(options);
    this.#periodicRun = run;
    void run.finally(() => {
      if (this.#periodicRun === run) this.#periodicRun = null;
    }).catch(() => undefined);
    return run;
  }

  async #executePeriodic(options: ProductionPeriodicOptions): Promise<ProductionPeriodicRunResult<RunResult>> {
    const controller = new AbortController();
    const removeExternalAbort = forwardAbort(options.signal, controller);
    const source = options.signalSource === undefined ? process : options.signalSource;
    const stopSignals = options.stopSignals ?? ["SIGTERM"];
    if (!Array.isArray(stopSignals) || new Set(stopSignals).size !== stopSignals.length) {
      removeExternalAbort();
      throw new ProductionRunnerError("invalid-config", "stopSignals 必须是不重复的 signal 数组");
    }
    const listeners = stopSignals.map((signal) => {
      const listener = (): void => controller.abort(abortError());
      source?.once(signal, listener);
      return { signal, listener };
    });
    let ticksCompleted = 0;
    let lastRun: ProductionRunOnceAllResult<RunResult> | null = null;
    try {
      while (!controller.signal.aborted) {
        lastRun = await this.#startOneRound(controller.signal);
        ticksCompleted++;
        if (controller.signal.aborted) break;
        await waitForInterval(this.#intervalMs, controller.signal);
      }
      return { version: 1, ticksCompleted, lastRun, stopped: "aborted" };
    } finally {
      removeExternalAbort();
      for (const { signal, listener } of listeners) source?.off(signal, listener);
    }
  }
}
