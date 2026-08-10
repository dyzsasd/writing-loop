// `writing-loop production` — local production control surface.  Status/handoff are read-only;
// enqueue publishes a crash-safe local intent/task only and never performs provider I/O.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { buildProductionCoordinatorReadModel, type ProductionCoordinatorReadModel } from "./production-coordinator-read-model.ts";
import { readProductionCoordinatorControlState } from "./production-coordinator-store.ts";
import { buildProductionReadModel, type ProductionReadModel } from "./production-read-model.ts";
import { formatProductionUsdMicros } from "./production-money.ts";
import {
  commitProductionTaskEnqueue,
  planProductionTaskEnqueue,
} from "./production-enqueue.ts";
import { MAX_PRODUCTION_INTENT_BYTES } from "./production-intent.ts";
import { MAX_PRODUCTION_STATE_BYTES, readProductionState } from "./production-store.ts";
import {
  VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
  buildVideoStudioHandoff,
  videoStudioHandoffDigest,
} from "./production-studio-handoff.ts";
import { projectEntries, requireWorkspace, WsError } from "./workspace.ts";
import { readWorkspaceIdentity } from "./workspace-registry.ts";

function usage(): void {
  console.log(`writing-loop production — 远程短剧制片的本地权威状态
用法:
  writing-loop production status [--project KEY] [--json]
  writing-loop production enqueue --plan --project KEY --input FILE [--json]
  writing-loop production enqueue --project KEY --input FILE --confirm PLAN_ID [--json]
  writing-loop production handoff --project KEY --input FILE

status/handoff 只读取本地权威账本；包含暂停项目。
enqueue --plan 严格零写入；只有匹配 --confirm 才按 intent→task→dispatch-requested 顺序写本地账本。
暂停项目可生成计划，但拒绝提交 enqueue。
handoff 仅向 stdout 输出已人工 approved take 的版本化 Studio 交接清单。
这些命令都不会连接 ComfyUI、H3 或 video studio，也不会直接启动、取消或重试远端任务。`);
}

type Options = { project: string | null; json: boolean };
class ProductionUsageError extends Error {}

function parseStatusArgs(args: string[]): Options {
  let project: string | null = null;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      if (project !== null) throw new ProductionUsageError("production status: --project 只能指定一次");
      project = args[++index] ?? null;
      if (!project) throw new ProductionUsageError("production status: --project 需要项目 key");
    } else if (arg === "--json") {
      if (json) throw new ProductionUsageError("production status: --json 只能指定一次");
      json = true;
    } else {
      throw new ProductionUsageError("production status: 未知参数");
    }
  }
  return { project, json };
}

function parseHandoffArgs(args: string[]): { project: string; input: string } {
  let project: string | null = null;
  let input: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      if (project !== null) throw new ProductionUsageError("production handoff: --project 只能指定一次");
      project = args[++index] ?? null;
      if (!project) throw new ProductionUsageError("production handoff: --project 需要项目 key");
    } else if (arg === "--input") {
      if (input !== null) throw new ProductionUsageError("production handoff: --input 只能指定一次");
      input = args[++index] ?? null;
      if (!input) throw new ProductionUsageError("production handoff: --input 需要 JSON 文件路径");
    } else {
      throw new ProductionUsageError("production handoff: 未知参数");
    }
  }
  if (project === null || input === null) {
    throw new ProductionUsageError("production handoff: 必须同时提供 --project 与 --input");
  }
  return { project, input };
}

function parseEnqueueArgs(args: string[]): {
  project: string;
  input: string;
  json: boolean;
  plan: boolean;
  confirm: string | null;
} {
  let project: string | null = null;
  let input: string | null = null;
  let json = false;
  let plan = false;
  let confirm: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      if (project !== null) throw new ProductionUsageError("production enqueue: --project 只能指定一次");
      project = args[++index] ?? null;
      if (!project) throw new ProductionUsageError("production enqueue: --project 需要项目 key");
    } else if (arg === "--input") {
      if (input !== null) throw new ProductionUsageError("production enqueue: --input 只能指定一次");
      input = args[++index] ?? null;
      if (!input) throw new ProductionUsageError("production enqueue: --input 需要 JSON 文件路径");
    } else if (arg === "--json") {
      if (json) throw new ProductionUsageError("production enqueue: --json 只能指定一次");
      json = true;
    } else if (arg === "--plan") {
      if (plan) throw new ProductionUsageError("production enqueue: --plan 只能指定一次");
      plan = true;
    } else if (arg === "--confirm") {
      if (confirm !== null) throw new ProductionUsageError("production enqueue: --confirm 只能指定一次");
      confirm = args[++index] ?? null;
      if (!confirm) throw new ProductionUsageError("production enqueue: --confirm 需要 PLAN_ID");
    } else {
      throw new ProductionUsageError("production enqueue: 未知参数");
    }
  }
  if (project === null || input === null) {
    throw new ProductionUsageError("production enqueue: 必须同时提供 --project 与 --input");
  }
  if (plan === (confirm !== null)) {
    throw new ProductionUsageError("production enqueue: 必须且只能选择 --plan 或 --confirm PLAN_ID");
  }
  return { project, input, json, plan, confirm };
}

function readHandoffInput(file: string): unknown {
  const text = readRegularTextExact(file, MAX_PRODUCTION_STATE_BYTES);
  if (text === null) {
    throw new WsError(`handoff input 必须是 <=${MAX_PRODUCTION_STATE_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  try { return JSON.parse(text); }
  catch { throw new WsError("handoff input 不是有效 JSON"); }
}

function readEnqueueInput(file: string): unknown {
  const text = readRegularTextExact(file, MAX_PRODUCTION_INTENT_BYTES);
  if (text === null) {
    throw new WsError(`enqueue input 必须是 <=${MAX_PRODUCTION_INTENT_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  try { return JSON.parse(text); }
  catch { throw new WsError("enqueue input 不是有效 JSON"); }
}

const costLabel = (model: ProductionReadModel): string => {
  const cost = model.summary.cost;
  const actual = cost.actual;
  const actualLabel = actual.state === "known"
    ? `实际 ${formatProductionUsdMicros(actual.amountMicros ?? 0)}`
    : actual.knownAmountMicros > 0
      ? `实际 ${formatProductionUsdMicros(actual.knownAmountMicros)} 已知；${actual.unknownTasks} 项实际成本未知`
      : `${actual.unknownTasks} 项实际成本未知`;
  const estimateLabel = cost.estimatedTasks > 0
    ? `；估算 ${formatProductionUsdMicros(cost.estimatedAmountMicros)}（${cost.estimatedTasks} 项）`
    : "";
  return actualLabel + estimateLabel;
};

const coordinatorLabel = (model: ProductionCoordinatorReadModel): string => {
  const summary = model.summary;
  if (model.revision === 0) return "control 尚未启动";
  const exposure = summary.budget.exposedAmountMicros > 0
    ? ` · 敞口 ${formatProductionUsdMicros(summary.budget.exposedAmountMicros)}`
    : "";
  return `control r${model.revision} · ${summary.pendingEvents} pending event · ${summary.tasksWithRetryHistory} retry-history · ${summary.lastObservedNotFound} last-not-found${exposure}`;
};

export function productionMain(argv = process.argv.slice(2), cwd = process.cwd()): number {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") { usage(); return 0; }
  if (!action) { usage(); return 2; }
  if (action !== "status" && action !== "enqueue" && action !== "handoff") {
    console.error("writing-loop production: 未知操作");
    usage();
    return 2;
  }

  try {
    if (action === "enqueue") {
      const options = parseEnqueueArgs(rest);
      const workspace = requireWorkspace(cwd);
      const workspaceId = readWorkspaceIdentity(workspace.root).id;
      const project = projectEntries(workspace.config).find(([key]) => key === options.project);
      if (!project) throw new WsError(`没有项目 '${options.project}'`);
      const draft = readEnqueueInput(resolve(cwd, options.input));
      const plan = planProductionTaskEnqueue({
        workspaceId,
        project: options.project,
        draft,
      });
      if (options.plan) {
        const output = {
          version: 1 as const,
          mode: "plan" as const,
          planId: plan.planId,
          workspaceId: plan.workspaceId,
          project: plan.project,
          taskId: plan.intent.taskId,
          idempotencyKey: plan.intent.idempotencyKey,
        };
        if (options.json) console.log(JSON.stringify(output, null, 2));
        else console.log(`${output.taskId} plan=${output.planId} · 零写入；使用 --confirm ${output.planId} 提交`);
        return 0;
      }
      if (project[1].enabled === false) {
        throw new WsError(`项目 '${options.project}' 已暂停；恢复项目后才能 enqueue 制片任务`);
      }
      const result = commitProductionTaskEnqueue({
        root: workspace.root,
        workspaceId,
        project: options.project,
        draft,
        confirm: options.confirm as string,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.task.id} ${result.task.status} · intent=${result.intentCreated ? "created" : "existing"} · task=${result.taskCreated ? "created" : "existing"} · dispatch=${result.dispatchApplied ? "applied" : "existing"}`);
      }
      return 0;
    }
    if (action === "handoff") {
      const options = parseHandoffArgs(rest);
      const workspace = requireWorkspace(cwd);
      const workspaceId = readWorkspaceIdentity(workspace.root).id;
      if (!projectEntries(workspace.config).some(([key]) => key === options.project)) {
        throw new WsError(`没有项目 '${options.project}'`);
      }
      const handoff = buildVideoStudioHandoff(
        readProductionState(workspace.root, workspaceId, options.project),
        readHandoffInput(resolve(cwd, options.input)),
      );
      console.log(JSON.stringify({
        version: 1,
        digestAlgorithm: VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
        digest: videoStudioHandoffDigest(handoff),
        handoff,
      }, null, 2));
      return 0;
    }
    const options = parseStatusArgs(rest);
    const workspace = requireWorkspace(cwd);
    const workspaceId = readWorkspaceIdentity(workspace.root).id;
    const entries = projectEntries(workspace.config);
    const selected = options.project === null
      ? entries
      : entries.filter(([key]) => key === options.project);
    if (options.project !== null && selected.length === 0) {
      throw new WsError(`没有项目 '${options.project}'`);
    }
    const projects = selected.map(([key, project]) => ({
      key,
      title: typeof project.title === "string" ? project.title : "",
      enabled: project.enabled !== false,
      production: buildProductionReadModel(readProductionState(workspace.root, workspaceId, key)),
      coordinator: buildProductionCoordinatorReadModel(
        readProductionCoordinatorControlState(workspace.root, workspaceId, key),
      ),
    }));

    if (options.json) {
      console.log(JSON.stringify({
        version: 1,
        workspace: { id: workspaceId, root: workspace.root },
        projects,
      }, null, 2));
      return 0;
    }

    console.log(`writing-loop production — ${workspace.root}`);
    console.log(`workspace ${workspaceId}\n`);
    if (!projects.length) {
      console.log("尚无项目，也没有制片账本。");
      return 0;
    }
    for (const row of projects) {
      const model = row.production;
      console.log(`${row.key} ${row.enabled ? "[active]" : "[paused]"} ${row.title || "未命名"}`);
      console.log(`  ${model.summary.total} takes · ${model.summary.active} active · ${model.summary.needsAttention} needs attention · ${costLabel(model)} · state r${model.revision}`);
      console.log(`  ${coordinatorLabel(row.coordinator)}`);
      const visible = model.tasks.slice(0, 12);
      for (const task of visible) {
        const subject = task.kind === "shot" ? `${task.episodeId}/${task.shotId}` : task.episodeId;
        console.log(`  - ${task.id}  ${task.status.padEnd(20)} ${subject}  remote=${task.remoteJobId ?? "—"}`);
      }
      if (model.tasks.length > visible.length) console.log(`  … ${model.tasks.length - visible.length} 个较早 take 请用 --json 查看`);
      console.log("");
    }
    return 0;
  } catch (error) {
    console.error(`writing-loop production: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof ProductionUsageError) { usage(); return 2; }
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(productionMain());
}
