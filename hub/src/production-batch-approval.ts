// 批次审批的可读记录：`plan-shots --confirm` 在**确实创建了 task** 的那一镜上，把该镜所属批次的
// 审批事实写在 `production-intents.v1` 旁边（`production-batch-approvals.v1/<taskId>.json`）。
// task 已在账本内时（精确重放、或 2b 之前发布）本次没有发布任何东西，一律不写也不改：记录回答的是
// 「这个 task 是在哪一份批次审批下发布的」，一份只是路过的批次不该把自己的指纹绑到别人的 take 上。
//
// 它是账本外的第三份不可变伴生文件，与 immutable intent、CAS 里的 ShotRequest 同级：账本事件
// 的 payload 与 digest 一个字节都不改，因此已有 task 的事件重放结果完全不变；`--confirm` 之前
// 提交的旧 task 没有这个文件，读回为 null，handoff 只出 `qc-approved` 一条门（现状）。
//
// 记录里的每一项都必须能从批次计划本身取证：`batchPlanId` 是被批准的那一份计划的指纹，
// `taskIdPrefix` 与 `phase` / `sampleShotIds` 是该指纹计算体的一部分（`policyDigest` 含
// samplePolicy 与 taskIdPrefix），`approvedAt` 取批次文档的 `createdAt`——同一个进入指纹计算体的
// 时刻。没有取 `--confirm` 的墙上时钟：那样精确重放会写出另一份字节，幂等性随之失效。
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { ProductionError } from "./production-domain.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_BATCH_APPROVAL_DIRECTORY = "production-batch-approvals.v1";
export const PRODUCTION_BATCH_APPROVAL_KIND = "writing-loop/shot-batch-approval";
/** 一条记录只有指纹、前缀与样片清单；上限按 512 镜的样片清单留足余量。 */
export const MAX_PRODUCTION_BATCH_APPROVAL_BYTES = 128 * 1024;

export type ProductionBatchApproval = {
  version: 1;
  kind: typeof PRODUCTION_BATCH_APPROVAL_KIND;
  taskId: string;
  shotId: string;
  /** 被批准的批次计划指纹；handoff v2 的 `batch-approved` 门以它作 `bindsTo.planSha256`。 */
  batchPlanId: string;
  taskIdPrefix: string;
  phase: "sample" | "bulk";
  /** samplePolicy 指名的样片；本镜是否样片由 `sampleShotIds.includes(shotId)` 判定，不另存冗余布尔。 */
  sampleShotIds: string[];
  /** 批次文档的 createdAt（进入 batchPlanId 计算体的同一时刻）。 */
  approvedAt: string;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_SAMPLE_SHOT_IDS = 512;

function fail(subject: string, detail: string): never {
  throw new ProductionError(`ProductionBatchApproval ${subject} ${detail}`);
}

const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

function requireSafeId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(subject, "必须是安全标识符");
  return value;
}

export function parseProductionBatchApproval(
  value: unknown,
  subject = "ProductionBatchApproval",
): ProductionBatchApproval {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(subject, "必须是 JSON 对象");
  const row = value as Record<string, unknown>;
  const expected = [
    "version", "kind", "taskId", "shotId", "batchPlanId", "taskIdPrefix", "phase", "sampleShotIds",
    "approvedAt",
  ];
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(row, key));
  const extras = Object.keys(row).filter((key) => !expected.includes(key));
  if (missing.length || extras.length) {
    fail(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
  if (row.version !== 1) fail(`${subject}.version`, "必须是 1");
  if (row.kind !== PRODUCTION_BATCH_APPROVAL_KIND) {
    fail(`${subject}.kind`, `必须是 ${PRODUCTION_BATCH_APPROVAL_KIND}`);
  }
  if (typeof row.batchPlanId !== "string" || !SHA256.test(row.batchPlanId)) {
    fail(`${subject}.batchPlanId`, "必须是 64 位小写 sha256");
  }
  if (typeof row.taskIdPrefix !== "string" || !TASK_PREFIX.test(row.taskIdPrefix)) {
    fail(`${subject}.taskIdPrefix`, "必须是安全前缀");
  }
  if (row.phase !== "sample" && row.phase !== "bulk") fail(`${subject}.phase`, "必须是 sample 或 bulk");
  if (!Array.isArray(row.sampleShotIds) || row.sampleShotIds.length === 0
    || row.sampleShotIds.length > MAX_SAMPLE_SHOT_IDS) {
    fail(`${subject}.sampleShotIds`, `必须是 1–${MAX_SAMPLE_SHOT_IDS} 项数组（样片门必须指名样片）`);
  }
  const sampleShotIds = row.sampleShotIds.map(
    (entry, index) => requireSafeId(entry, `${subject}.sampleShotIds[${index}]`),
  );
  if (new Set(sampleShotIds).size !== sampleShotIds.length) fail(`${subject}.sampleShotIds`, "不得重复");
  // 规范 UTC ISO：这条记录的 approvedAt 会原样成为 handoff v2 GateRecord 的 approvedAt，
  // 而 VCS 的 schema 在那一侧按 isoUtc 校验；在写入侧就守住同一判据，不把失败推迟到导入。
  if (typeof row.approvedAt !== "string" || row.approvedAt.length > 64
    || CONTROL.test(row.approvedAt)
    || !Number.isFinite(Date.parse(row.approvedAt))
    || new Date(Date.parse(row.approvedAt)).toISOString() !== row.approvedAt) {
    fail(`${subject}.approvedAt`, "必须是规范 UTC ISO-8601 时间");
  }
  // 记录与某个 take 的绑定由 `taskId` + `shotId` 两项判定（handoff v2 builder 逐项核对）。
  // `taskIdPrefix` 不参与这个判定，它记的是样片门的前缀纪律：bulk 批次必须与样片批次同前缀。
  const taskId = requireSafeId(row.taskId, `${subject}.taskId`);
  const shotId = requireSafeId(row.shotId, `${subject}.shotId`);
  return {
    version: 1,
    kind: PRODUCTION_BATCH_APPROVAL_KIND,
    taskId,
    shotId,
    batchPlanId: row.batchPlanId,
    taskIdPrefix: row.taskIdPrefix,
    phase: row.phase,
    sampleShotIds,
    approvedAt: row.approvedAt,
  };
}

/** 本镜是否被 samplePolicy 指名为样片。 */
export function productionBatchApprovalIsSample(approval: ProductionBatchApproval): boolean {
  return approval.sampleShotIds.includes(approval.shotId);
}

function assertRealDirectory(path: string, subject: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { fail(subject, `目录不存在：${path}（${error instanceof Error ? error.message : String(error)}）`); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(subject, `必须是真实目录（拒绝 symlink/FIFO/device）：${path}`);
  }
}

function projectDirectory(root: string, project: string): string {
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { fail("", `workspace root 不存在：${error instanceof Error ? error.message : String(error)}`); }
  const writingLoop = join(canonicalRoot, ".writing-loop");
  const projectPath = join(writingLoop, project);
  assertRealDirectory(writingLoop, "workspace state");
  assertRealDirectory(projectPath, `项目 '${project}'`);
  return projectPath;
}

function approvalDirectory(root: string, project: string, create: boolean): string | null {
  const directory = join(projectDirectory(root, project), PRODUCTION_BATCH_APPROVAL_DIRECTORY);
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("directory", `必须是真实目录（拒绝 symlink/FIFO/device）：${directory}`);
    }
    return directory;
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    if (errno(error) !== "ENOENT") throw error;
    if (!create) return null;
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (mkdirError) {
      if (errno(mkdirError) !== "EEXIST") {
        fail("directory", `无法创建 ${directory}：${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }
    assertRealDirectory(directory, "directory");
    return directory;
  }
}

export function productionBatchApprovalPath(root: string, project: string, taskId: string): string {
  return join(
    projectDirectory(root, project),
    PRODUCTION_BATCH_APPROVAL_DIRECTORY,
    `${requireSafeId(taskId, "taskId")}.json`,
  );
}

/** 未提交过批次、或该 task 由 2b 之前的 `--confirm` 发布时返回 null（handoff 只出 qc-approved）。 */
export function readProductionBatchApproval(
  root: string,
  project: string,
  taskId: string,
): ProductionBatchApproval | null {
  const parsedTaskId = requireSafeId(taskId, "taskId");
  const directory = approvalDirectory(root, project, false);
  if (directory === null) return null;
  const file = join(directory, `${parsedTaskId}.json`);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    fail("", `无法检查 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("", `${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > MAX_PRODUCTION_BATCH_APPROVAL_BYTES) {
    fail("", `${file} 超过 ${MAX_PRODUCTION_BATCH_APPROVAL_BYTES} bytes 安全读取上限`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size) {
      fail("", `${file} 在 lstat/open 间被替换`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("", `${file} 读取期间被截断`);
      offset += count;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (error) { fail("", `${file} JSON 损坏：${error instanceof Error ? error.message : String(error)}`); }
    const approval = parseProductionBatchApproval(value, `ProductionBatchApproval ${file}`);
    if (approval.taskId !== parsedTaskId) fail("", `${file} 内 taskId 与文件名不匹配`);
    return approval;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type WriteProductionBatchApprovalResult = {
  created: boolean;
  path: string;
  approval: ProductionBatchApproval;
};

/**
 * 与 immutable intent 同一发布纪律：同目录临时文件 → fsync → `link(2)` 定名。崩溃至多留下临时文件，
 * 定名路径上永远不会出现半份记录。
 *
 * 定名冲突的判据与 intent 相同：逐字段相同即认作同一次发布的精确重放（`created: false`），不同即拒绝
 * 覆盖并报出两边的 `batchPlanId` 与文件路径。调用方只在本次确实创建了 task 时才来写，因此一条内容
 * 不同的既有记录必然是残留的孤儿记录（上一次 confirm 写下记录后 enqueue 失败，或人工放进去的），
 * 沿用它会让 handoff 发出绑定到并未发布该 take 的批次的门——只能由操作者核对后删除。
 */
export function writeProductionBatchApproval(
  root: string,
  project: string,
  value: unknown,
): WriteProductionBatchApprovalResult {
  const approval = parseProductionBatchApproval(value);
  const directory = approvalDirectory(root, project, true)!;
  const file = join(directory, `${approval.taskId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(approval, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_PRODUCTION_BATCH_APPROVAL_BYTES) {
    fail("", `canonical 记录超过 ${MAX_PRODUCTION_BATCH_APPROVAL_BYTES} bytes 安全上限`);
  }
  const temporary = join(directory, `.${approval.taskId}.json.${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      fail("", `无法创建临时文件 ${temporary}：${error instanceof Error ? error.message : String(error)}`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) fail("", `${temporary} 创建后不是单链接普通文件`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) {
      fail("", `${temporary} 写入后 identity/长度异常`);
    }
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 保留首个错误 */ } fd = undefined; }
    try { unlinkSync(temporary); } catch { /* 临时文件清理失败不掩盖原始错误 */ }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  try {
    try { linkSync(temporary, file); }
    catch (error) {
      if (errno(error) !== "EEXIST") {
        fail("", `无法把 ${temporary} 发布为 ${file}：${error instanceof Error ? error.message : String(error)}`);
      }
      let existing: ProductionBatchApproval | null = null;
      try { existing = readProductionBatchApproval(root, project, approval.taskId); }
      catch (readError) {
        fail("", `${file} 已存在但不可读（${readError instanceof Error ? readError.message : String(readError)}）`
          + "（拒绝覆盖；请人工核对后删除该文件再重试）");
      }
      if (existing !== null && JSON.stringify(existing) === JSON.stringify(approval)) {
        return { created: false, path: file, approval: existing };
      }
      fail("", `${file} 是残留的孤儿批次审批记录：它绑定 batchPlanId `
        + `${existing === null ? "（读回为空）" : existing.batchPlanId}，本次发布该 task 的是 `
        + `${approval.batchPlanId}（拒绝覆盖；请人工核对后删除该文件再重试）`);
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* 已 link 成功，临时名残留不影响正确性 */ }
  }
  let dirFd: number | undefined;
  try { dirFd = openSync(directory, constants.O_RDONLY); fsyncSync(dirFd); }
  catch { /* 平台拒绝目录 fsync 时不阻断已完成的 link */ }
  finally { if (dirFd !== undefined) closeSync(dirFd); }
  return { created: true, path: file, approval };
}
