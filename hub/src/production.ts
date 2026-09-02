// `writing-loop production` — local production control surface.  Status/handoff are read-only;
// enqueue publishes a crash-safe local intent/task only and never performs provider I/O.
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readRegularTextExact } from "./bounded-fs.ts";
import { buildProductionCoordinatorReadModel, type ProductionCoordinatorReadModel } from "./production-coordinator-read-model.ts";
import { readProductionCoordinatorControlState } from "./production-coordinator-store.ts";
import { buildProductionReadModel, type ProductionReadModel } from "./production-read-model.ts";
import { formatProductionUsdMicros } from "./production-money.ts";
import {
  commitProductionTaskEnqueue,
  planProductionTaskEnqueue,
} from "./production-enqueue.ts";
import {
  MAX_PRODUCTION_STATE_BYTES,
  ProductionStore,
  readProductionState,
} from "./production-store.ts";
import { parseProductionTaskEvent } from "./production-domain.ts";
import { loadProductionRuntimeConfig } from "./production-runtime-config.ts";
import { loadProductionExecutionProfileSnapshot } from "./production-profile-snapshot.ts";
import {
  applyShotDraftPatches,
  applyVisualDefaults,
  buildShotBatchPlan,
  commitShotBatchPlan,
  parseShotBatchRequest,
  resolveShotSelection,
  shotBatchBackendInstanceId,
  shotBatchCandidateProfiles,
  shotBatchMaxStoryboardSeconds,
  type ShotBatchCompilation,
  type ShotBatchDraftIssue,
  type ShotBatchPlan,
  type ShotBatchRequest,
} from "./production-shot-plan.ts";
import {
  SHOT_REQUEST_MEDIA_TYPE,
  mergeShots,
  parseShotRequest,
  parseShotRequestDraft,
  shotRequestFromScript,
  type ShotRequestDraft,
  type ShotRequestScriptOptions,
} from "./production-shot-request.ts";
import type { ProductionExecutionProfileSnapshotRead } from "./production-profile-snapshot.ts";
import type { VisualCompileInputs } from "./visual-production.ts";
import { readVisualCompileInputs } from "./visual-production.ts";
import {
  VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
  buildVideoStudioHandoff,
  buildVideoStudioHandoffV2,
  exportVideoStudioHandoffV2,
  videoStudioGatewayAssetReader,
  videoStudioHandoffDigest,
  videoStudioWorkspaceAssetReader,
  type VideoStudioHandoffTakeSource,
} from "./production-studio-handoff.ts";
import { MAX_PRODUCTION_CAS_DOCUMENT_BYTES, readProductionCasObject } from "./production-cas.ts";
import {
  PRODUCTION_EVIDENCE_KINDS,
  registerProductionEvidence,
  type ProductionEvidenceKind,
} from "./production-evidence.ts";
import { PRODUCTION_MODERATION_STATUSES } from "./production-intent.ts";
import { readProductionBatchApproval } from "./production-batch-approval.ts";
import { WorkspaceCasLocalAssetSource } from "./production-local-asset-source.ts";
import { MAX_PRODUCTION_INTENT_BYTES, readProductionIntent } from "./production-intent.ts";
import { projectEntries, requireProjectEntry, resolveRepoPath, requireWorkspace, WsError } from "./workspace.ts";
import { readWorkspaceIdentity } from "./workspace-registry.ts";

function usage(): void {
  console.log(`writing-loop production — 远程短剧制片的本地权威状态
用法:
  writing-loop production status [--project KEY] [--json]
  writing-loop production enqueue --plan --project KEY --input FILE [--json]
  writing-loop production enqueue --project KEY --input FILE --confirm PLAN_ID [--json]
  writing-loop production plan-shots --plan --project KEY --input FILE --config RUNTIME [--from-script <集号> [--scene N]…] [--shot ID]… [--json]
  writing-loop production plan-shots --confirm BATCH_PLAN_ID --project KEY --input FILE --config RUNTIME [--from-script <集号> [--scene N]…] [--shot ID]… [--json]
  writing-loop production qc --approve|--reject --project KEY --task ID --by WHO [--note TEXT] [--json]
  writing-loop production evidence register --project KEY --kind rights|license --file PATH --config RUNTIME [--json]
  writing-loop production evidence register --project KEY --kind moderation --file PATH --config RUNTIME --status STATUS --reviewed-at ISO [--json]
  writing-loop production handoff --project KEY --input FILE [--contract v1|v2] [--json]
  writing-loop production handoff --project KEY --input FILE --export-dir DIR --config RUNTIME [--json]

status/handoff 只读取本地权威账本；包含暂停项目。
enqueue --plan 严格零写入；只有匹配 --confirm 才按 intent→task→dispatch-requested 顺序写本地账本。
plan-shots --plan 同样严格零写入：读 runtime config 声明的只读 execution profile 快照做估算，
输出含每镜估算、后端理由、承接链波次、退化与校验汇总的批次审批文档与 batchPlanId；
--confirm 才逐镜把 ShotRequest 写入 workspace CAS、写批次审批记录并以该镜自身的 planId 提交 enqueue。
--from-script 取集号（例：--from-script 1 --scene 1），与 --input 的 script.episode / sceneIndexes 必须一致。
--shot ID 按镜头筛选（可重复），与批次文档的 shotIds 等价，两者都给出时取交集；被筛掉的镜头
不编译、不进 intents、不计估算，只在 shots[] 里以 selected: false 列出。
phase: bulk 的批次在提交前检查 samplePolicy 指名的样片 task 均为 approved。
qc 写 approved/rejected 事件（approval 绑定审批前的 qc revision）；非 qc-pending 的 task 一律拒绝。
evidence register 把证据文件写入 workspace CAS（重复登记幂等），按内容嗅探 mediaType，
输出可直接填入批次文档的对象片段与 sha256；CAS authority 取 runtime config 的 localAssetSource。
--kind moderation 必须显式给出 --status 与 --reviewed-at：审核结论与时刻是文件之外的人工事实，命令不代填。
暂停项目可生成计划，但拒绝提交 enqueue 与批次。
handoff 仅输出已人工 approved take 的版本化 Studio 交接清单，缺省为 scripted-drama 契约 v2
（takes 带 shotRequest、execution 摘要、cost、assetRoles、gates 与 license）；--contract v1 输出旧四流水线契约。
--export-dir 另写 handoff.json（规范 JSON 字节）、handoff.digest 与全部资产（<sha256>.<ext>）：
cas:// 对象优先读本机 workspace CAS，其余经 gateway 的 assets 路由（GET 方法）取回并逐文件校验 sha256 与字节长度。
这些命令都不会连接 ComfyUI、H3 或 video studio，也不会直接启动、取消或重试远端任务；
只有 handoff --export-dir 会访问 gateway 的 assets 路由（GET 方法）取回已入库资产。`);
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

type HandoffOptions = {
  project: string;
  input: string;
  contract: "v1" | "v2";
  exportDir: string | null;
  config: string | null;
  json: boolean;
};

function parseHandoffArgs(args: string[]): HandoffOptions {
  let project: string | null = null;
  let input: string | null = null;
  let contract: "v1" | "v2" | null = null;
  let exportDir: string | null = null;
  let config: string | null = null;
  let json = false;
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
    } else if (arg === "--contract") {
      if (contract !== null) throw new ProductionUsageError("production handoff: --contract 只能指定一次");
      const value = args[++index] ?? null;
      if (value !== "v1" && value !== "v2") {
        throw new ProductionUsageError("production handoff: --contract 只接受 v1 或 v2");
      }
      contract = value;
    } else if (arg === "--export-dir") {
      if (exportDir !== null) throw new ProductionUsageError("production handoff: --export-dir 只能指定一次");
      exportDir = args[++index] ?? null;
      if (!exportDir) throw new ProductionUsageError("production handoff: --export-dir 需要目录路径");
    } else if (arg === "--config") {
      if (config !== null) throw new ProductionUsageError("production handoff: --config 只能指定一次");
      config = args[++index] ?? null;
      if (!config) throw new ProductionUsageError("production handoff: --config 需要 runtime config 文件路径");
    } else if (arg === "--json") {
      if (json) throw new ProductionUsageError("production handoff: --json 只能指定一次");
      json = true;
    } else {
      throw new ProductionUsageError("production handoff: 未知参数");
    }
  }
  if (project === null || input === null) {
    throw new ProductionUsageError("production handoff: 必须同时提供 --project 与 --input");
  }
  const selected = contract ?? "v2";
  if (exportDir !== null && selected !== "v2") {
    throw new ProductionUsageError("production handoff: --export-dir 只属于 v2 契约（VCS importer 只读 v2）");
  }
  // 资产目录要经 gateway 的 assets GET 路由取回 urn:sha256 对象，baseUrl / transport / 凭据环境变量
  // 只在 runtime config 里；没有它就只能给出一份缺资产的导出，因此这里直接拒绝。
  if (exportDir !== null && config === null) {
    throw new ProductionUsageError("production handoff: --export-dir 必须同时提供 --config（gateway assets 来源）");
  }
  if (exportDir === null && config !== null) {
    throw new ProductionUsageError("production handoff: --config 只在 --export-dir 时使用");
  }
  return { project, input, contract: selected, exportDir, config, json };
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

type PlanShotsOptions = {
  project: string;
  input: string;
  config: string;
  json: boolean;
  plan: boolean;
  confirm: string | null;
  fromScript: number | null;
  scenes: number[];
  shotIds: string[];
};

function parsePlanShotsArgs(args: string[]): PlanShotsOptions {
  let project: string | null = null;
  let input: string | null = null;
  let config: string | null = null;
  let json = false;
  let plan = false;
  let confirm: string | null = null;
  let fromScript: number | null = null;
  const scenes: number[] = [];
  const shotIds: string[] = [];
  const once = (value: unknown, flag: string): void => {
    if (value !== null && value !== false) throw new ProductionUsageError(`production plan-shots: ${flag} 只能指定一次`);
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--project") {
      once(project, arg); project = args[++index] ?? null;
      if (!project) throw new ProductionUsageError("production plan-shots: --project 需要项目 key");
    } else if (arg === "--input") {
      once(input, arg); input = args[++index] ?? null;
      if (!input) throw new ProductionUsageError("production plan-shots: --input 需要 JSON 文件路径");
    } else if (arg === "--config") {
      once(config, arg); config = args[++index] ?? null;
      if (!config) throw new ProductionUsageError("production plan-shots: --config 需要 runtime config 路径");
    } else if (arg === "--json") {
      once(json, arg); json = true;
    } else if (arg === "--plan") {
      once(plan, arg); plan = true;
    } else if (arg === "--confirm") {
      once(confirm, arg); confirm = args[++index] ?? null;
      if (!confirm) throw new ProductionUsageError("production plan-shots: --confirm 需要 BATCH_PLAN_ID");
    } else if (arg === "--from-script") {
      once(fromScript, arg);
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new ProductionUsageError("production plan-shots: --from-script 需要集号");
      fromScript = value;
    } else if (arg === "--scene") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new ProductionUsageError("production plan-shots: --scene 需要场序");
      scenes.push(value);
    } else if (arg === "--shot") {
      const value = args[++index] ?? "";
      if (!value) throw new ProductionUsageError("production plan-shots: --shot 需要 shotId");
      if (shotIds.includes(value)) {
        throw new ProductionUsageError(`production plan-shots: --shot ${value} 重复指定`);
      }
      shotIds.push(value);
    } else {
      throw new ProductionUsageError("production plan-shots: 未知参数");
    }
  }
  if (project === null || input === null || config === null) {
    throw new ProductionUsageError("production plan-shots: 必须同时提供 --project、--input 与 --config");
  }
  if (plan === (confirm !== null)) {
    throw new ProductionUsageError("production plan-shots: 必须且只能选择 --plan 或 --confirm BATCH_PLAN_ID");
  }
  if (scenes.length > 0 && fromScript === null) {
    throw new ProductionUsageError("production plan-shots: --scene 必须与 --from-script 一起使用");
  }
  return { project, input, config, json, plan, confirm, fromScript, scenes, shotIds };
}

type EvidenceOptions = {
  project: string;
  kind: ProductionEvidenceKind;
  file: string;
  config: string;
  json: boolean;
  /** `--kind moderation` 专有：审核结论与审核时刻是文件之外的人工事实，命令不代填。 */
  moderation: { status: string; reviewedAt: string } | null;
};

function parseEvidenceArgs(args: string[]): EvidenceOptions {
  const [sub, ...rest] = args;
  if (sub !== "register") throw new ProductionUsageError("production evidence: 只支持 register 子命令");
  let project: string | null = null;
  let kind: ProductionEvidenceKind | null = null;
  let file: string | null = null;
  let config: string | null = null;
  let json = false;
  let status: string | null = null;
  let reviewedAt: string | null = null;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--project") {
      if (project !== null) throw new ProductionUsageError("production evidence register: --project 只能指定一次");
      project = rest[++index] ?? null;
      if (!project) throw new ProductionUsageError("production evidence register: --project 需要项目 key");
    } else if (arg === "--kind") {
      if (kind !== null) throw new ProductionUsageError("production evidence register: --kind 只能指定一次");
      const value = rest[++index] ?? "";
      if (!(PRODUCTION_EVIDENCE_KINDS as readonly string[]).includes(value)) {
        throw new ProductionUsageError(
          `production evidence register: --kind 只接受 ${PRODUCTION_EVIDENCE_KINDS.join(" | ")}`,
        );
      }
      kind = value as ProductionEvidenceKind;
    } else if (arg === "--file") {
      if (file !== null) throw new ProductionUsageError("production evidence register: --file 只能指定一次");
      file = rest[++index] ?? null;
      if (!file) throw new ProductionUsageError("production evidence register: --file 需要文件路径");
    } else if (arg === "--config") {
      if (config !== null) throw new ProductionUsageError("production evidence register: --config 只能指定一次");
      config = rest[++index] ?? null;
      if (!config) throw new ProductionUsageError("production evidence register: --config 需要 runtime config 路径");
    } else if (arg === "--status") {
      if (status !== null) throw new ProductionUsageError("production evidence register: --status 只能指定一次");
      const value = rest[++index] ?? "";
      if (!(PRODUCTION_MODERATION_STATUSES as readonly string[]).includes(value)) {
        throw new ProductionUsageError(
          `production evidence register: --status 只接受 ${PRODUCTION_MODERATION_STATUSES.join(" | ")}`,
        );
      }
      status = value;
    } else if (arg === "--reviewed-at") {
      if (reviewedAt !== null) throw new ProductionUsageError("production evidence register: --reviewed-at 只能指定一次");
      reviewedAt = rest[++index] ?? null;
      if (!reviewedAt) throw new ProductionUsageError("production evidence register: --reviewed-at 需要规范 UTC ISO 时间");
    } else if (arg === "--json") {
      if (json) throw new ProductionUsageError("production evidence register: --json 只能指定一次");
      json = true;
    } else {
      throw new ProductionUsageError("production evidence register: 未知参数");
    }
  }
  if (project === null || kind === null || file === null) {
    throw new ProductionUsageError("production evidence register: 必须同时提供 --project、--kind 与 --file");
  }
  // 审核结论与审核时刻在文件里取不到证：passed / not-reviewed / failed 与复核时刻都是操作者的事实。
  // 缺省成「passed + 现在」等于凭空写出一次审核记录，因此 moderation 必须显式给出，其余 kind 不接受。
  if (kind === "moderation" && (status === null || reviewedAt === null)) {
    throw new ProductionUsageError(
      "production evidence register: --kind moderation 必须同时提供 --status 与 --reviewed-at"
        + "（审核结论与时刻是文件之外的人工事实，命令不代填）",
    );
  }
  if (kind !== "moderation" && (status !== null || reviewedAt !== null)) {
    throw new ProductionUsageError(
      `production evidence register: --status 与 --reviewed-at 只属于 --kind moderation（本次是 ${kind}）`,
    );
  }
  // AssetRef 的 `cas://<authority>/…` 只有 runtime config 声明 authority（`localAssetSource`）；
  // 没有它就只能猜一个 authority，而猜错的 AssetRef 会在 worker 的本机对象源上以 authority-mismatch 失败。
  if (config === null) {
    throw new ProductionUsageError(
      "production evidence register: 必须提供 --config（CAS authority 只在 runtime config 的 localAssetSource）",
    );
  }
  return {
    project, kind, file, config, json,
    moderation: kind === "moderation" ? { status: status as string, reviewedAt: reviewedAt as string } : null,
  };
}

type QcOptions = {
  task: string;
  by: string;
  note: string | null;
  decision: "approved" | "rejected";
  project: string;
  json: boolean;
};

function parseQcArgs(args: string[]): QcOptions {
  let task: string | null = null;
  let by: string | null = null;
  let note: string | null = null;
  let project: string | null = null;
  let decision: "approved" | "rejected" | null = null;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--approve" || arg === "--reject") {
      if (decision !== null) throw new ProductionUsageError("production qc: --approve 与 --reject 只能选择一个");
      decision = arg === "--approve" ? "approved" : "rejected";
    } else if (arg === "--task") {
      if (task !== null) throw new ProductionUsageError("production qc: --task 只能指定一次");
      task = args[++index] ?? null;
      if (!task) throw new ProductionUsageError("production qc: --task 需要 task id");
    } else if (arg === "--by") {
      if (by !== null) throw new ProductionUsageError("production qc: --by 只能指定一次");
      by = args[++index] ?? null;
      if (!by) throw new ProductionUsageError("production qc: --by 需要裁决人");
    } else if (arg === "--note") {
      if (note !== null) throw new ProductionUsageError("production qc: --note 只能指定一次");
      note = args[++index] ?? null;
      if (!note) throw new ProductionUsageError("production qc: --note 需要说明文本");
    } else if (arg === "--project") {
      if (project !== null) throw new ProductionUsageError("production qc: --project 只能指定一次");
      project = args[++index] ?? null;
      if (!project) throw new ProductionUsageError("production qc: --project 需要项目 key");
    } else if (arg === "--json") {
      if (json) throw new ProductionUsageError("production qc: --json 只能指定一次");
      json = true;
    } else {
      throw new ProductionUsageError("production qc: 未知参数");
    }
  }
  if (decision === null) throw new ProductionUsageError("production qc: 必须提供 --approve 或 --reject");
  if (task === null || by === null || project === null) {
    throw new ProductionUsageError("production qc: 必须同时提供 --project、--task 与 --by");
  }
  if (decision === "rejected" && note === null) {
    throw new ProductionUsageError("production qc: --reject 必须给出 --note 原因");
  }
  return { task, by, note, decision, project, json };
}

function readHandoffInput(file: string): unknown {
  const text = readRegularTextExact(file, MAX_PRODUCTION_STATE_BYTES);
  if (text === null) {
    throw new WsError(`handoff input 必须是 <=${MAX_PRODUCTION_STATE_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  try { return JSON.parse(text); }
  catch { throw new WsError("handoff input 不是有效 JSON"); }
}

/**
 * handoff v2 逐 take 的不可变伴生事实：immutable intent 与它 `inputs[0]` 指向的 ShotRequest。
 * 两者都只从本机账本目录读取（零网络）；缺任一项即整份交接失败——execution / license / 输入角色
 * 没有第二个来源，缺了就只能靠猜，而猜出来的交接文档会被 VCS 当成事实导入。
 */
function handoffTakeSourceResolver(root: string, project: string): (taskId: string) => VideoStudioHandoffTakeSource {
  return (taskId: string): VideoStudioHandoffTakeSource => {
    const intent = readProductionIntent(root, project, taskId);
    if (intent === null) {
      throw new WsError(`task '${taskId}' 的 immutable intent 不存在；handoff v2 需要它提供 execution/license/inputs`);
    }
    const shotRequestAsset = intent.inputs[0];
    if (shotRequestAsset === undefined) {
      throw new WsError(`task '${taskId}' 的 intent 没有 inputs[0] ShotRequest；本版 handoff v2 只承载 plan-shots 提交的镜头`);
    }
    // 先按 mediaType 认出这确实是一份 ShotRequest 文档，再按文档上限读——否则一个指向数百 MB 视频
    // 的 inputs[0] 会被当成文档整个读进内存，然后才在解析层失败。
    if (shotRequestAsset.mediaType !== SHOT_REQUEST_MEDIA_TYPE) {
      throw new WsError(`task '${taskId}' 的 intent.inputs[0] 是 ${shotRequestAsset.mediaType}，`
        + `不是 ${SHOT_REQUEST_MEDIA_TYPE}；handoff v2 的 shotRequest 只认这一种`);
    }
    const bytes = readProductionCasObject(
      root, project, shotRequestAsset.sha256, MAX_PRODUCTION_CAS_DOCUMENT_BYTES,
    );
    if (bytes === null) {
      throw new WsError(`task '${taskId}' 的 ShotRequest ${shotRequestAsset.sha256} 不在本机 workspace CAS`);
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
      throw new WsError(`task '${taskId}' 的 ShotRequest 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      intent,
      shotRequest: parseShotRequest(value, `ShotRequest ${shotRequestAsset.sha256}`),
      // 2b 之前 `--confirm` 发布的 task 没有批次审批记录，读回 null：那样的 take 只出 qc-approved。
      batchApproval: readProductionBatchApproval(root, project, taskId),
    };
  };
}

function readEnqueueInput(file: string): unknown {
  const text = readRegularTextExact(file, MAX_PRODUCTION_INTENT_BYTES);
  if (text === null) {
    throw new WsError(`enqueue input 必须是 <=${MAX_PRODUCTION_INTENT_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  try { return JSON.parse(text); }
  catch { throw new WsError("enqueue input 不是有效 JSON"); }
}

/** `plan-shots` 的输入与 handoff / enqueue 同一读取纪律：有界、单链接、读取期间不变。 */
function readBatchRequestInput(file: string): ShotBatchRequest {
  const text = readRegularTextExact(file, MAX_PRODUCTION_STATE_BYTES);
  if (text === null) {
    throw new WsError(`plan-shots input 必须是 <=${MAX_PRODUCTION_STATE_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new WsError("plan-shots input 不是有效 JSON"); }
  return parseShotBatchRequest(parsed);
}

function readEpisodeScript(repo: string, relativePath: string): string {
  const file = join(repo, relativePath);
  const text = readRegularTextExact(file, MAX_PRODUCTION_STATE_BYTES);
  if (text === null) {
    throw new WsError(`剧本必须是 <=${MAX_PRODUCTION_STATE_BYTES} bytes、读取期间不变的单链接 UTF-8 普通文件：${file}`);
  }
  return text;
}

/**
 * 组装本批次的 draft：要么由 `shots[]` 直接给出，要么按 §6.1 从剧本预填并合并后用 patch 补齐
 * camera / prompt / 连续性输入。合并上界取快照时长网格的最大档——超过它的镜头没有可执行的 profile。
 */
/**
 * 组装本批次的 draft 与装配期提示。draft 要么由 `shots[]` 直接给出，要么按 §6.1 从剧本预填、
 * 合并、两段 patch 补齐；预填与合并的 warnings 不丢弃——它们是人工要看的镜头级事实
 * （首个动作行之前的对白、合并时被丢弃的 cast 差异），随计划一起进 validation。
 */
function batchDrafts(
  request: ShotBatchRequest,
  repo: string,
  snapshot: ProductionExecutionProfileSnapshotRead,
  visual: VisualCompileInputs,
  assertion: { fromScript: number | null; scenes: number[] },
): { drafts: ShotRequestDraft[]; issues: ShotBatchDraftIssue[] } {
  const issues: ShotBatchDraftIssue[] = [];
  let drafts: ShotRequestDraft[];
  if (request.script === null) {
    if (assertion.fromScript !== null) {
      throw new WsError("plan-shots: 指定了 --from-script，但 --input 没有 script 段");
    }
    drafts = request.shots.map((entry, index) => parseShotRequestDraft(entry, `ShotBatchRequest.shots[${index}]`));
  } else {
    const script = request.script;
    if (assertion.fromScript !== null && assertion.fromScript !== script.episode) {
      throw new WsError(`plan-shots: --from-script ${assertion.fromScript} 与 --input 的 script.episode ${script.episode} 不一致`);
    }
    const declared = script.sceneIndexes === null ? null : [...script.sceneIndexes].sort((a, b) => a - b);
    const asked = assertion.scenes.length === 0 ? null : [...assertion.scenes].sort((a, b) => a - b);
    if (asked !== null && (declared === null || JSON.stringify(asked) !== JSON.stringify(declared))) {
      throw new WsError(`plan-shots: --scene ${asked.join(",")} 与 --input 的 script.sceneIndexes ${declared?.join(",") ?? "全部场"} 不一致`);
    }
    const options = {
      ...script.options,
      episode: script.episode,
      ...(script.sceneIndexes === null ? {} : { sceneIndexes: script.sceneIndexes }),
    } as unknown as ShotRequestScriptOptions;
    // 合并上界取「同一输出形状」下已配置档的最大时长：跨画幅或跨音频意图的档不能容纳本批镜头。
    const shape = {
      backendInstanceId: shotBatchBackendInstanceId(snapshot, request),
      aspectRatio: script.options.output.aspectRatio as string,
      generateAudio: script.options.output.generateAudio,
    };
    const maxStoryboardDurationSeconds = shotBatchMaxStoryboardSeconds(
      shotBatchCandidateProfiles(snapshot, shape), shape,
    );
    const prefilled = shotRequestFromScript(readEpisodeScript(repo, script.episodeFile), options);
    for (const warning of prefilled.warnings) {
      issues.push({
        shotId: warning.shotId, source: "prefill", code: warning.code,
        field: `provenance.scriptLine:${warning.line}`, severity: "warning", message: warning.message,
      });
    }
    // 顺序按 §6.1 的数据流：camera 等分镜字段先落位（否则条件 3 恒不成立，镜头合不起来），
    // 合并之后再按存活镜头补 prompt 与连续性输入。
    const filled = applyShotDraftPatches(prefilled.shots.map((entry) => entry.draft), script.patches);
    const merged = mergeShots(filled, { maxStoryboardDurationSeconds });
    for (const warning of merged.warnings) {
      issues.push({
        shotId: warning.shotId, source: "merge", code: "merge-discarded-field",
        field: warning.field, severity: "warning", message: warning.message,
      });
    }
    drafts = applyShotDraftPatches(merged.drafts, script.mergedPatches);
  }
  // 视觉侧的两张表在最后一步补空位：人工 patch 已经写死的值不覆盖。契约 v2 的派生 seed 更靠后，
  // 在 buildShotBatchPlan 里逐镜按选定的档补（§5.3），因此它取的是视觉填充之后的镜头内容。
  const withVisual = applyVisualDefaults(drafts, visual, { arcId: request.arcId });
  return { drafts: withVisual.drafts, issues: [...issues, ...withVisual.issues] };
}

type PlanShotsContext = {
  compilation: ShotBatchCompilation;
  root: string;
  workspaceId: string;
};

function buildPlanShotsContext(options: PlanShotsOptions, cwd: string): PlanShotsContext {
  const workspace = requireWorkspace(cwd);
  const workspaceId = readWorkspaceIdentity(workspace.root).id;
  const entry = projectEntries(workspace.config).find(([key]) => key === options.project);
  if (!entry) throw new WsError(`没有项目 '${options.project}'`);
  const repo = resolveRepoPath(workspace.root, requireProjectEntry(entry[0], entry[1]));

  const runtime = loadProductionRuntimeConfig(resolve(cwd, options.config));
  if (runtime.workspaceId !== workspaceId) {
    throw new WsError("runtime config 的 workspaceId 与本 workspace 身份不一致");
  }
  const runtimeProject = runtime.projects.find((row) => row.project === options.project);
  if (runtimeProject === undefined) {
    throw new WsError(`runtime config 未登记项目 '${options.project}'；无法取得地域与许可义务声明`);
  }
  if (runtime.executionProfileSnapshotFile === null) {
    throw new WsError("runtime config 未声明 executionProfileSnapshotFile；plan-shots 无法读取价目与时长档");
  }
  const snapshot = loadProductionExecutionProfileSnapshot(
    resolve(cwd, options.config), runtime.executionProfileSnapshotFile,
  );
  const authorizedWorkflowSha256 = new Set(
    runtime.workflows
      .filter((workflow) => workflow.projects.includes(options.project))
      .map((workflow) => workflow.workflowSha256),
  );

  const request = readBatchRequestInput(resolve(cwd, options.input));
  const visual = readVisualCompileInputs(repo);
  const assembled = batchDrafts(request, repo, snapshot, visual, {
    fromScript: options.fromScript,
    scenes: options.scenes,
  });
  return {
    root: workspace.root,
    workspaceId,
    compilation: buildShotBatchPlan({
      workspaceId,
      project: options.project,
      request,
      snapshot,
      // 只读账本：`previous-shot-last-frame` 的上游 take 状态与尾帧身份只有它能取证（仍然零写入）。
      ledger: readProductionState(workspace.root, workspaceId, options.project),
      selection: resolveShotSelection(request.shotIds, options.shotIds),
      authorizedWorkflowSha256,
      projectPolicy: {
        allowedProcessingRegions: runtimeProject.allowedProcessingRegions,
        licenseCompliance: runtimeProject.licenseCompliance,
        usesOutputToImproveModels: runtimeProject.usesOutputToImproveModels,
      },
      visual,
      drafts: assembled.drafts,
      draftIssues: assembled.issues,
      // 剧本预填给不出 seed；`shots[]` 直接给出的 draft 由操作者写死，不派生。
      deriveSeedWhenNull: request.script !== null,
    }),
  };
}

/** 批次审批文档（§4.7）：每镜估算与后端理由、承接链波次、退化与校验汇总、总估算与 GPU 小时附注。 */
function renderShotBatchPlan(plan: ShotBatchPlan): string {
  const lines: string[] = [];
  lines.push(`batch ${plan.batchPlanId}`);
  lines.push(`  project=${plan.project} phase=${plan.phase} 镜头=${plan.totals.shots} policy=${plan.policyDigest.slice(0, 12)}`);
  for (const decision of plan.decisions) {
    const estimate = plan.estimates.find((row) => row.shotId === decision.shotId)!;
    lines.push(`  - ${decision.shotId} → ${decision.profileId} (${decision.modelFamily}/${decision.backendInstanceId})`
      + ` ${decision.durationSeconds}s · 估算 ${formatProductionUsdMicros(estimate.estimatedAmountMicros)}`
      + ` / 上限 ${formatProductionUsdMicros(estimate.maximumAmountMicros)} · ${decision.reason}`);
  }
  const excluded = plan.shots.filter((shot) => !shot.selected);
  if (excluded.length) {
    // 同一原因的镜头并成一行：逐镜重复同一句话会把真正要看的镜头号淹掉。
    const byReason = new Map<string, string[]>();
    for (const shot of excluded) {
      const reason = shot.selectionReason ?? "";
      byReason.set(reason, [...(byReason.get(reason) ?? []), shot.shotId]);
    }
    lines.push(`  未选中 ${excluded.length} 镜（不编译、不进 intents、不计估算）：`
      + [...byReason].map(([reason, shotIds]) => `${shotIds.join(",")}（${reason}）`).join("；"));
  }
  lines.push(`  波次：${plan.waves.map((wave) => `w${wave.index}[${wave.shotIds.join(",")}]`).join(" → ")}`);
  lines.push(`  样片：${plan.samplePolicy.sampleShotIds.join("、")}`
    + `（bulk 前必须全部 approved=${plan.samplePolicy.requireApprovedSampleBeforeBulk}）`);
  if (plan.degradations.length) {
    lines.push(`  退化 ${plan.degradations.length} 条：`
      + plan.degradations.map((row) => `${row.shotId} ${row.code}${row.requiresReapproval ? "(需重新批准)" : ""}`).join("、"));
  }
  if (plan.droppedReferences.length) {
    lines.push(`  裁剪参考 ${plan.droppedReferences.length} 项：`
      + plan.droppedReferences.map((row) => `${row.shotId} ${row.purpose}/p${row.priority}`).join("、"));
  }
  lines.push(`  校验：${plan.validation.errors} error · ${plan.validation.warnings} warning`);
  for (const shot of plan.validation.shots) {
    for (const issue of shot.issues) {
      lines.push(`    · ${shot.shotId} [${issue.severity}/${issue.source}] ${issue.code} ${issue.field}：${issue.message}`);
    }
  }
  lines.push(`  总估算 ${formatProductionUsdMicros(plan.totals.estimatedAmountMicros)}`
    + ` · reservation 上限 ${formatProductionUsdMicros(plan.totals.maximumAmountMicros)}`);
  lines.push(plan.totals.gpu === null
    ? "  GPU 小时：未声明（附注项，不构成阻断条件）"
    : `  GPU 小时：${plan.totals.gpu.estimatedHours} h × ${plan.totals.gpu.spotUsdPerHour} USD/h`
      + ` ≈ ${plan.totals.gpu.estimatedUsd.toFixed(2)} USD（附注项，不构成阻断条件）`);
  lines.push(plan.blocked
    ? "  零写入；批次含 error 级校验问题，修正后重新出计划"
    : `  零写入；使用 --confirm ${plan.batchPlanId} 提交`);
  return lines.join("\n");
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

export async function productionMain(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") { usage(); return 0; }
  if (!action) { usage(); return 2; }
  if (action !== "status" && action !== "enqueue" && action !== "handoff"
    && action !== "plan-shots" && action !== "qc" && action !== "evidence") {
    console.error("writing-loop production: 未知操作");
    usage();
    return 2;
  }

  try {
    if (action === "evidence") {
      const options = parseEvidenceArgs(rest);
      const workspace = requireWorkspace(cwd);
      const workspaceId = readWorkspaceIdentity(workspace.root).id;
      if (!projectEntries(workspace.config).some(([key]) => key === options.project)) {
        throw new WsError(`没有项目 '${options.project}'`);
      }
      const runtime = loadProductionRuntimeConfig(resolve(cwd, options.config));
      if (runtime.workspaceId !== workspaceId) {
        throw new WsError("runtime config 的 workspaceId 与本 workspace 身份不一致");
      }
      if (runtime.localAssetSource === null) {
        throw new WsError("runtime config 未声明 localAssetSource；证据 AssetRef 没有可用的 CAS authority");
      }
      const registered = registerProductionEvidence({
        root: workspace.root,
        project: options.project,
        kind: options.kind,
        file: resolve(cwd, options.file),
        casAuthority: runtime.localAssetSource.casAuthority,
        ...(options.moderation === null ? {} : { moderation: options.moderation }),
      });
      if (options.json) console.log(JSON.stringify(registered, null, 2));
      else {
        console.log(`${registered.kind} ${registered.sha256} · ${registered.byteLength} bytes`
          + ` · ${registered.mediaType} · cas=${registered.casObjectCreated ? "created" : "existing"}`);
        console.log(`  ${registered.path}`);
        console.log(`  批次文档 ${registered.kind} 段可直接填入：`);
        console.log(JSON.stringify(registered.fragment, null, 2).split("\n").map((line) => `  ${line}`).join("\n"));
      }
      return 0;
    }
    if (action === "plan-shots") {
      const options = parsePlanShotsArgs(rest);
      const context = buildPlanShotsContext(options, cwd);
      const plan = context.compilation.plan;
      if (options.plan) {
        // 严格零写入：只输出计划文档，不碰 CAS、intent、账本。
        if (options.json) console.log(JSON.stringify(plan, null, 2));
        else console.log(renderShotBatchPlan(plan));
        return plan.blocked ? 1 : 0;
      }
      const workspace = requireWorkspace(cwd);
      const project = projectEntries(workspace.config).find(([key]) => key === options.project);
      if (project && project[1].enabled === false) {
        throw new WsError(`项目 '${options.project}' 已暂停；恢复项目后才能提交批次`);
      }
      const result = commitShotBatchPlan({
        root: context.root,
        workspaceId: context.workspaceId,
        project: options.project,
        compilation: context.compilation,
        confirm: options.confirm as string,
        readState: () => readProductionState(context.root, context.workspaceId, options.project),
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`batch ${result.batchPlanId} · ${result.shots.length} 镜已提交`);
        for (const shot of result.shots) {
          console.log(`  - ${shot.shotId} ${shot.taskId} ${shot.status} · shot-request=${shot.shotRequestSha256.slice(0, 12)} `
            + `cas=${shot.casObjectCreated ? "created" : "existing"} `
            + `approval=${shot.batchApprovalCreated ? "created" : "existing"} `
            + `intent=${shot.intentCreated ? "created" : "existing"} `
            + `task=${shot.taskCreated ? "created" : "existing"} dispatch=${shot.dispatchApplied ? "applied" : "existing"}`);
        }
      }
      return 0;
    }
    if (action === "qc") {
      const options = parseQcArgs(rest);
      const workspace = requireWorkspace(cwd);
      const workspaceId = readWorkspaceIdentity(workspace.root).id;
      if (!projectEntries(workspace.config).some(([key]) => key === options.project)) {
        throw new WsError(`没有项目 '${options.project}'`);
      }
      const store = new ProductionStore(workspace.root, workspaceId, options.project);
      const task = store.read().tasks.find((row) => row.id === options.task);
      if (task === undefined) throw new WsError(`项目 '${options.project}' 没有 task '${options.task}'`);
      if (task.status !== "qc-pending") {
        throw new WsError(`task '${options.task}' 处于 ${task.status}；只有 qc-pending 的 take 可以裁决`);
      }
      const occurredAt = new Date().toISOString();
      const applied = store.apply(parseProductionTaskEvent({
        version: 1,
        // eventId 由 taskId 与被审阅的 revision 拼出；重放由上面的状态检查拒绝（终态不可再裁决）。
        eventId: `qc:${options.decision}:${options.task}:${task.revision}`,
        taskId: options.task,
        expectedRevision: task.revision,
        occurredAt: occurredAt < task.updatedAt ? task.updatedAt : occurredAt,
        type: options.decision,
        decidedBy: options.by,
        note: options.note,
      }));
      const approval = applied.task.approval;
      if (options.json) {
        console.log(JSON.stringify({
          version: 1, taskId: applied.task.id, status: applied.task.status,
          revision: applied.task.revision, approval,
        }, null, 2));
      } else {
        console.log(`${applied.task.id} ${applied.task.status} · 由 ${approval?.decidedBy} 于 ${approval?.decidedAt} 裁决`
          + `（审阅 revision ${approval?.taskRevision}）`);
      }
      return 0;
    }
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
      const state = readProductionState(workspace.root, workspaceId, options.project);
      const create = readHandoffInput(resolve(cwd, options.input));
      if (options.contract === "v1") {
        const handoff = buildVideoStudioHandoff(state, create);
        console.log(JSON.stringify({
          version: 1,
          digestAlgorithm: VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
          digest: videoStudioHandoffDigest(handoff),
          handoff,
        }, null, 2));
        return 0;
      }
      const handoff = buildVideoStudioHandoffV2(
        state, create, handoffTakeSourceResolver(workspace.root, options.project),
      );
      const digest = videoStudioHandoffDigest(handoff);
      if (options.exportDir === null) {
        console.log(JSON.stringify({
          version: 2,
          digestAlgorithm: VIDEO_STUDIO_HANDOFF_DIGEST_ALGORITHM,
          digest,
          handoff,
        }, null, 2));
        return 0;
      }
      const runtime = loadProductionRuntimeConfig(resolve(cwd, options.config as string));
      if (runtime.workspaceId !== workspaceId) {
        throw new WsError("runtime config 的 workspaceId 与本 workspace 身份不一致");
      }
      const result = await exportVideoStudioHandoffV2({
        handoff,
        directory: resolve(cwd, options.exportDir),
        readAsset: videoStudioWorkspaceAssetReader({
          // §6.4 的本机对象源：ShotRequest 与操作者上传的首帧正本都在本机 CAS，零网络取回。
          local: runtime.localAssetSource === null ? null : new WorkspaceCasLocalAssetSource({
            root: workspace.root,
            project: options.project,
            casAuthority: runtime.localAssetSource.casAuthority,
          }),
          gateway: videoStudioGatewayAssetReader({
            baseUrl: runtime.gateway.baseUrl,
            workspaceId,
            project: options.project,
            transport: runtime.gateway.transport,
            // insecure-private-http 有自己的私网 + bearer 规则，不复用无凭据 loopback 开发豁免。
            allowInsecureLoopback: runtime.gateway.transport === "tls"
              && new URL(runtime.gateway.baseUrl).protocol === "http:",
            credentialResolver: runtime.gateway.credentialEnv === null ? undefined : () => {
              const secret = process.env[runtime.gateway.credentialEnv as string];
              if (secret === undefined || secret === "") {
                throw new WsError(`gateway 凭据环境变量 ${runtime.gateway.credentialEnv} 未设置`);
              }
              return secret;
            },
          }),
        }),
      });
      if (options.json) {
        console.log(JSON.stringify({
          version: 1,
          digestAlgorithm: result.digestAlgorithm,
          digest: result.digest,
          directory: result.directory,
          handoffId: handoff.handoffId,
          takes: handoff.takes.length,
          files: result.files,
        }, null, 2));
      } else {
        console.log(`${handoff.handoffId} → ${result.directory}`);
        console.log(`  ${handoff.takes.length} take · digest ${result.digest}`);
        for (const file of result.files) console.log(`  - ${file.name} ${file.byteLength} bytes`);
        console.log(`  VCS 侧：studio.py import-handoff ${handoff.studioProjectId}`
          + ` --handoff ${join(result.directory, "handoff.json")} --assets-dir ${result.directory}`
          + ` --expect-digest ${result.digest}`);
      }
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
  process.exit(await productionMain());
}
