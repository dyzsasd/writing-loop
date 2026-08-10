// Read-only recovery audit for the local enqueue crash prefixes.
//
// The coordinator must never guess through missing/corrupt immutable intent evidence. This audit
// correlates intent companions with the authoritative production ledger and reports exact-replay
// recovery work without deleting, repairing or otherwise mutating either side.
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import {
  PRODUCTION_INTENT_DIRECTORY,
  readProductionIntent,
  type ProductionDispatchIntent,
} from "./production-intent.ts";
import { readProductionState } from "./production-store.ts";
import { hasSymlinkComponent } from "./bounded-fs.ts";
import { projectDataDir } from "./workspace.ts";

export const MAX_PRODUCTION_RECOVERY_ENTRIES = 4_096;

export type ProductionRecoveryFindingCode =
  | "corrupt-intent"
  | "intent-task-mismatch"
  | "orphan-intent"
  | "planned-recovery-required"
  | "task-without-intent"
  | "unrecognized-intent-entry";

export type ProductionRecoveryFinding = {
  version: 1;
  severity: "warning" | "failure";
  code: ProductionRecoveryFindingCode;
  taskId: string | null;
  detail: string;
};

const SAFE_INTENT_FILE = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.json$/;

function finding(
  severity: ProductionRecoveryFinding["severity"],
  code: ProductionRecoveryFindingCode,
  taskId: string | null,
  detail: string,
): ProductionRecoveryFinding {
  return { version: 1, severity, code, taskId, detail };
}

function errno(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

function listIntentTaskIds(root: string, project: string): {
  taskIds: string[];
  findings: ProductionRecoveryFinding[];
} {
  const directory = join(projectDataDir(root, project), PRODUCTION_INTENT_DIRECTORY);
  if (hasSymlinkComponent(root, [".writing-loop", project, PRODUCTION_INTENT_DIRECTORY])) {
    return {
      taskIds: [],
      findings: [finding("failure", "corrupt-intent", null, "intent directory 路径含符号链接")],
    };
  }
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(directory); }
  catch (error) {
    if (errno(error) === "ENOENT") return { taskIds: [], findings: [] };
    return {
      taskIds: [],
      findings: [finding("failure", "corrupt-intent", null, "intent directory 无法安全检查")],
    };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return {
      taskIds: [],
      findings: [finding("failure", "corrupt-intent", null, "intent directory 不是真实目录")],
    };
  }

  const taskIds: string[] = [];
  const findings: ProductionRecoveryFinding[] = [];
  const directoryHandle = opendirSync(directory);
  let count = 0;
  try {
    for (;;) {
      const entry = directoryHandle.readSync();
      if (entry === null) break;
      count++;
      if (count > MAX_PRODUCTION_RECOVERY_ENTRIES) {
        findings.push(finding(
          "failure", "unrecognized-intent-entry", null,
          `intent directory 超过 ${MAX_PRODUCTION_RECOVERY_ENTRIES} 项有界扫描上限`,
        ));
        break;
      }
      const match = SAFE_INTENT_FILE.exec(entry.name);
      if (!match || !entry.isFile()) {
        findings.push(finding(
          "failure", "unrecognized-intent-entry", null,
          "intent directory 含未识别或非普通文件 entry",
        ));
        continue;
      }
      taskIds.push(match[1]!);
    }
  } finally {
    directoryHandle.closeSync();
  }
  taskIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return { taskIds, findings };
}

/** Inspect one project without writing recovery state or contacting a provider. */
export function inspectProductionRecovery(
  root: string,
  workspaceId: string,
  project: string,
): ProductionRecoveryFinding[] {
  const state = readProductionState(root, workspaceId, project);
  const listed = listIntentTaskIds(root, project);
  const findings = [...listed.findings];
  const intents = new Map<string, ProductionDispatchIntent>();

  for (const taskId of listed.taskIds) {
    try {
      const intent = readProductionIntent(root, project, taskId);
      if (intent === null) {
        findings.push(finding("failure", "corrupt-intent", taskId, "intent 在检查窗口内消失"));
      } else {
        intents.set(taskId, intent);
      }
    } catch {
      findings.push(finding("failure", "corrupt-intent", taskId, "intent 无法通过严格 immutable parser"));
    }
  }

  const tasks = new Map(state.tasks.map((task) => [task.id, task] as const));
  for (const [taskId, intent] of intents) {
    const task = tasks.get(taskId);
    if (task === undefined) {
      findings.push(finding(
        "warning", "orphan-intent", taskId,
        "immutable intent 已持久化但 task 尚未创建；用原 input + planId 精确重放 enqueue",
      ));
      continue;
    }
    if (task.idempotencyKey !== intent.idempotencyKey
      || JSON.stringify(task.subject) !== JSON.stringify(intent.subject)
      || task.createdAt !== intent.createdAt) {
      findings.push(finding(
        "failure", "intent-task-mismatch", taskId,
        "authoritative task 与 immutable intent 的 identity/subject/createdAt 不匹配",
      ));
      continue;
    }
    if (task.status === "planned") {
      findings.push(finding(
        "warning", "planned-recovery-required", taskId,
        "task 已持久化但 dispatch-requested 尚未落账；用原 input + planId 精确重放 enqueue",
      ));
    }
  }

  for (const task of state.tasks) {
    if (intents.has(task.id)) continue;
    if (task.status === "planned" || task.status === "dispatch-pending") {
      findings.push(finding(
        "failure", "task-without-intent", task.id,
        `${task.status} task 缺少 immutable intent；禁止 coordinator 猜测或提交`,
      ));
    }
  }

  return findings.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "failure" ? -1 : 1;
    const leftId = left.taskId ?? "";
    const rightId = right.taskId ?? "";
    return leftId < rightId ? -1 : leftId > rightId ? 1
      : left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  });
}
