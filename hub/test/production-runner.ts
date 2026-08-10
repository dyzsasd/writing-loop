// Phase 3C runtime scheduler: bounded concurrency, failure isolation, abort convergence and
// non-overlapping periodic ticks.
import { EventEmitter } from "node:events";
import {
  ProductionRunner,
  ProductionRunnerError,
  type ProductionRunnableProject,
} from "../src/production-runner.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runnerError(operation: () => unknown, code: string): boolean {
  try { operation(); return false; }
  catch (error) { return error instanceof ProductionRunnerError && error.code === code; }
}

const waitTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

{
  let globalActive = 0;
  let globalMaximum = 0;
  const backendActive = new Map<string, number>();
  const backendMaximum = new Map<string, number>();
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const definitions = [
    ["alpha", "shared"],
    ["bravo", "shared"],
    ["charlie", "other"],
    ["delta", "third"],
  ] as const;
  const projects: ProductionRunnableProject<string>[] = definitions.map(([project, backend], index) => ({
    project,
    backendInstanceIds: [backend],
    async run() {
      globalActive++;
      globalMaximum = Math.max(globalMaximum, globalActive);
      const next = (backendActive.get(backend) ?? 0) + 1;
      backendActive.set(backend, next);
      backendMaximum.set(backend, Math.max(backendMaximum.get(backend) ?? 0, next));
      try { await gates[index]!.promise; return project; }
      finally {
        globalActive--;
        backendActive.set(backend, (backendActive.get(backend) ?? 1) - 1);
      }
    },
  }));
  const runner = new ProductionRunner({
    projects,
    projectConcurrency: 3,
    perBackendConcurrency: 1,
    intervalMs: 10,
  });
  const run = runner.runOnceAll();
  await waitTurn();
  ok(globalActive === 3, "runOnceAll fills project concurrency with independent backends");
  ok((backendMaximum.get("shared") ?? 0) === 1, "per-backend permit prevents shared backend overlap");
  ok(globalMaximum === 3, "projectConcurrency bounds aggregate project runs");
  gates[0]!.resolve();
  await waitTurn();
  ok(globalActive === 3, "waiting project starts after its backend permit is released");
  for (const gate of gates) gate.resolve();
  const result = await run;
  ok(result.outcomes.map((entry) => entry.project).join(",") === "alpha,bravo,charlie,delta",
    "outcomes retain registry order rather than completion order");
  ok(result.outcomes.every((entry) => entry.status === "succeeded"), "all successful projects return isolated outcomes");
}

{
  const projects: ProductionRunnableProject<string>[] = [
    { project: "fail", backendInstanceIds: ["a"], run() { throw new Error("private provider detail"); } },
    { project: "pass", backendInstanceIds: ["a"], async run() { return "ok"; } },
  ];
  const result = await new ProductionRunner({
    projects, projectConcurrency: 2, perBackendConcurrency: 1, intervalMs: 10,
  }).runOnceAll();
  ok(result.outcomes[0]?.status === "failed" && result.outcomes[1]?.status === "succeeded",
    "a synchronous project failure releases its backend permit and does not reject the round");
  ok(JSON.stringify(result).includes("private provider detail") === false,
    "run result exposes only a stable failure code, not provider error text");
}

{
  const gate = deferred();
  const runner = new ProductionRunner<string>({
    projects: [{ project: "single", backendInstanceIds: ["a"], async run() { await gate.promise; return "ok"; } }],
    projectConcurrency: 1,
    perBackendConcurrency: 1,
    intervalMs: 10,
  });
  const first = runner.runOnceAll();
  ok(runnerError(() => runner.runOnceAll(), "already-running"), "runOnceAll rejects in-process re-entry immediately");
  gate.resolve();
  await first;
  await waitTurn();
  ok(!runner.running, "non-reentrancy guard is released after the round settles");
}

{
  const controller = new AbortController();
  let starts = 0;
  const projects: ProductionRunnableProject<string>[] = ["one", "two", "three"].map((project) => ({
    project,
    backendInstanceIds: ["shared"],
    async run(signal) {
      starts++;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new Error("aborted")); return; }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return project;
    },
  }));
  const runner = new ProductionRunner({
    projects, projectConcurrency: 1, perBackendConcurrency: 1, intervalMs: 10,
  });
  const run = runner.runOnceAll(controller.signal);
  await waitTurn();
  controller.abort();
  const result = await run;
  ok(starts === 1, "abort prevents pending registry projects from starting");
  ok(result.outcomes.every((entry) => entry.status === "aborted"),
    "running and pending projects converge to explicit aborted outcomes");
}

{
  const source = new EventEmitter();
  let active = 0;
  let maximum = 0;
  let starts = 0;
  let settledAfterAbort = false;
  const runner = new ProductionRunner<string>({
    projects: [{
      project: "periodic",
      backendInstanceIds: ["backend"],
      async run(signal) {
        starts++;
        active++;
        maximum = Math.max(maximum, active);
        if (starts === 2) source.emit("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 8);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            setTimeout(() => { settledAfterAbort = true; resolve(); }, 2);
          }, { once: true });
        });
        active--;
        return "ok";
      },
    }],
    projectConcurrency: 1,
    perBackendConcurrency: 1,
    intervalMs: 1,
  });
  const periodic = runner.runPeriodically({ signalSource: source });
  await waitTurn();
  ok(runnerError(() => runner.runOnceAll(), "already-running"),
    "manual round cannot enter while periodic ownership is active");
  ok(runnerError(() => runner.runPeriodically({ signalSource: source }), "periodic-already-running"),
    "a second periodic loop is rejected");
  const result = await periodic;
  ok(result.ticksCompleted === 2 && starts === 2, "periodic runner starts immediate sequential ticks until SIGTERM");
  ok(maximum === 1, "periodic interval never overlaps coordinator ticks");
  ok(settledAfterAbort && active === 0, "SIGTERM abort is delivered and current tick settles before periodic completion");
  ok(source.listenerCount("SIGTERM") === 0, "periodic runner removes process-signal listeners during convergence");
}

if (fails) {
  console.error(`\n${fails} production runner test(s) failed`);
  process.exit(1);
}
console.log("\nproduction runner tests OK");
