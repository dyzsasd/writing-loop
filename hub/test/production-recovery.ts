// Read-only enqueue crash-prefix audit.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductionDispatchIntent,
  enqueueProductionIntent,
  PRODUCTION_INTENT_DIRECTORY,
} from "../src/production-intent.ts";
import { inspectProductionRecovery } from "../src/production-recovery.ts";
import { ProductionStore } from "../src/production-store.ts";
import { doctorMain } from "../src/doctor.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const workspaceId = `ws_${"a".repeat(32)}`;
const asset = (name: string, digest: string) => ({
  version: 1 as const,
  uri: `cas://production/${name}`,
  sha256: digest,
  byteLength: 10,
  mediaType: "application/json",
});
const draft = (taskId: string) => ({
  version: 1 as const,
  taskId,
  subject: {
    version: 1 as const,
    kind: "episode" as const,
    episode: { version: 1 as const, episodeId: "ep-001", revision: 1, source: asset("episode", "1".repeat(64)) },
  },
  createdAt: "2026-08-10T10:00:00.000Z",
  useTerritories: ["CN"],
  execution: {
    version: 1 as const,
    operation: "comfyui-workflow" as const,
    modelFamily: "generic" as const,
    backendInstanceId: "gateway-primary",
    workflowSha256: "2".repeat(64),
    modelSha256: "3".repeat(64),
    parametersSha256: "4".repeat(64),
  },
  inputs: [asset("input", "5".repeat(64))],
  budget: { version: 1 as const, currency: "USD" as const, estimatedAmountMicros: 1, maximumAmountMicros: 2 },
  rights: { version: 1 as const, status: "cleared" as const, territories: ["CN"], evidence: asset("rights", "6".repeat(64)), expiresAt: null },
  moderation: { version: 1 as const, status: "passed" as const, reviewedAt: "2026-08-10T09:00:00.000Z", evidence: asset("moderation", "7".repeat(64)) },
  license: {
    version: 1 as const, status: "verified" as const, basis: "community" as const, territories: ["CN"],
    licenseSha256: "8".repeat(64), evidence: asset("license", "9".repeat(64)),
    issuedBy: "model-owner", issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  },
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-recovery-")));
const savedWorkspace = process.env.WRITING_LOOP_WORKSPACE;
const savedHome = process.env.WRITING_LOOP_HOME;
try {
  mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
  const orphan = createProductionDispatchIntent(draft("take-orphan"));
  enqueueProductionIntent(root, "demo", orphan);
  let findings = inspectProductionRecovery(root, workspaceId, "demo");
  ok(findings.some((row) => row.code === "orphan-intent" && row.severity === "warning"),
    "intent→task 崩溃前缀被报为可 exact replay 的 orphan，不伪造 task");

  const store = new ProductionStore(root, workspaceId, "demo");
  store.create({
    version: 1, id: orphan.taskId, idempotencyKey: orphan.idempotencyKey,
    subject: orphan.subject, createdAt: orphan.createdAt,
  });
  findings = inspectProductionRecovery(root, workspaceId, "demo");
  ok(findings.some((row) => row.code === "planned-recovery-required" && row.severity === "warning")
    && !findings.some((row) => row.code === "orphan-intent"),
  "task→dispatch 崩溃前缀被报为 planned exact-replay 恢复");

  const missingIntent = createProductionDispatchIntent(draft("take-missing-intent"));
  store.create({
    version: 1, id: missingIntent.taskId, idempotencyKey: missingIntent.idempotencyKey,
    subject: missingIntent.subject, createdAt: missingIntent.createdAt,
  });
  findings = inspectProductionRecovery(root, workspaceId, "demo");
  ok(findings.some((row) => row.code === "task-without-intent"
    && row.taskId === "take-missing-intent" && row.severity === "failure"),
  "planned task 缺 immutable intent 是 fail-closed 结构性问题");

  writeFileSync(join(root, ".writing-loop", "demo", PRODUCTION_INTENT_DIRECTORY, "broken.json"), "{");
  findings = inspectProductionRecovery(root, workspaceId, "demo");
  ok(findings.some((row) => row.code === "corrupt-intent" && row.taskId === "broken"),
    "损坏 intent 不被当成 missing/empty，保留为结构性恢复证据");

  const before = JSON.stringify(store.read());
  inspectProductionRecovery(root, workspaceId, "demo");
  ok(JSON.stringify(store.read()) === before,
    "recovery audit 严格只读，不自动补 event、删 intent 或改 ledger");

  const machineHome = join(root, "machine-home");
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, ".writing-loop", "demo", "board", "tickets"), { recursive: true });
  mkdirSync(machineHome);
  writeFileSync(join(root, ".writing-loop", "workspace.json"), JSON.stringify({ version: 1, id: workspaceId }) + "\n");
  writeFileSync(join(root, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { repoPath: "repo", enabled: true } },
  }) + "\n");
  writeFileSync(join(machineHome, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: [{ id: workspaceId, root }],
  }) + "\n");
  process.env.WRITING_LOOP_WORKSPACE = root;
  process.env.WRITING_LOOP_HOME = machineHome;
  const doctorLines: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => { doctorLines.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { doctorLines.push(values.map(String).join(" ")); };
  let doctorCode: number;
  try { doctorCode = doctorMain([]); }
  finally { console.log = oldLog; console.error = oldError; }
  const doctorOutput = doctorLines.join("\n");
  ok(doctorCode === 1 && doctorOutput.includes("production corrupt-intent")
    && doctorOutput.includes("production task-without-intent")
    && doctorOutput.includes("禁止猜测或重发远端任务")
    && doctorOutput.includes("WRITING_LOOP_DOCTOR_FAILED"),
  "writing-loop doctor 把损坏/缺失 intent 提升为只读结构性 FAIL，不得自动重发");
} finally {
  if (savedWorkspace === undefined) delete process.env.WRITING_LOOP_WORKSPACE;
  else process.env.WRITING_LOOP_WORKSPACE = savedWorkspace;
  if (savedHome === undefined) delete process.env.WRITING_LOOP_HOME;
  else process.env.WRITING_LOOP_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_RECOVERY_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
