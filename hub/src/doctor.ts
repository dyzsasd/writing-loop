// `writing-loop doctor` —— 只读体检：暖色警告（W 码）不失败、结构性问题才 FAIL。
// 末行恒为 WRITING_LOOP_DOCTOR_OK / WRITING_LOOP_DOCTOR_FAILED + 恰一条 NEXT: 行。
//
// W 码表（warn 恒不影响退出码；W01 已随 python 调度器退役——调度器现为包内原生 TS）：
//   W02 repoPath 不存在 / 不是 git repo
//   W03 创作规格违规（paywall.card1 ⊄ [8..12] / audience 空——config-schema 校验规则）
//   W04 scheduler.cli 对应二进制不在 PATH（claude/codex/opencode）
//   W05 opencode 版本 < 1.2.24（dev-loop PORTABILITY 认证下限）——cli=opencode 时查；
//       providers 注册表非空时即便本项目 cli 不是 opencode 也查（迟早会被某 agent 的
//       model 覆盖用到）
//   W06 cli=claude 且 promptMode!=inline 但 Claude Code 未装 writing-loop 插件（斜杠命令无从解析）
//   W07 wl-run.lock 陈旧（mtime>60min——多半是崩溃残锁，wl-run 下次启动会自动回收）
//   W08 cli=claude 且 trimFirePlugins 生效但本机不满足前提（~/.claude/settings.json 的
//       enabledPlugins 读不到 / claude 无 --settings flag）——wl-run 会优雅降级不注入，仅提示
//   W09 provider 注册表某条目的 authTokenEnv 环境变量不可解析（其 opencode fire 会预检失败）
//   W10 opencode.json 与 providers 注册表有漂移（缺失/未同步/过期——运行 sync-opencode 修复）
//   W11 config 已发布但 onboarding journal 仍残留（需 verify 后人工审计恢复元数据）
//   W12 workspace identity 尚未创建（旧 workspace 可用 workspace add 一次性补齐）
//   W13 本机 workspace registry 缺当前 workspace 或含 degraded 指针（registry 非权威，
//       不阻断单 workspace 创作；用 workspace list/add/remove 显式修复）
//   W14 production enqueue 崩溃前缀可用原 input + planId 精确向前恢复
// FAIL（结构性）：workspace 不可解析、config.json 不可解析/非对象、providers 注册表非法
//       （阻断 writing-loop run 整体起 fire）、板目录不可写、不可见的崩溃立项事务、
//       已存在但损坏的 workspace identity / registry（拒绝静默覆盖稳定 ID 或本机指针）、
//       会永久阻断写入/索引刷新且 owner 已退出或无法安全确认的 O_EXCL 残留锁。
import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, opendirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSymlinkComponent, readRegularTextHead } from "./bounded-fs.ts";
import { ONBOARDING_JOURNAL_MAX_BYTES } from "./onboarding.ts";
import { opencodeSyncDrift } from "./opencode-sync.ts";
import { findOnPath } from "./paths.ts";
import { inspectProductionRecovery } from "./production-recovery.ts";
import {
  authGapPhrase, buildTrimSettingsJson, claudeSupportsSettingsFlag, parseProviders,
  readEnabledPlugins, type ProviderEntry,
} from "./scheduler.ts";
import {
  inspectWorkspaceRegistry, readWorkspaceIdentity, type WorkspaceIdentity,
  type WorkspaceRegistrySnapshot,
} from "./workspace-registry.ts";
import {
  dataRoot, findWorkspaceRoot, loadConfig, projectDataDir, resolveRepoPath,
  requireProjectEntry, WsError, type WlConfig, type WlProject, type Workspace,
} from "./workspace.ts";

const MIN_NODE = [20, 11] as const;
const MIN_OPENCODE = [1, 2, 24] as const; // dev-loop docs/PORTABILITY.md 认证下限
const EXCLUSIVE_LOCK_BYTES = 8 * 1024;
const STALE_EXCLUSIVE_LOCK_MINUTES = 60;

// ─── 小工具 ────────────────────────────────────────────────────────────────────
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const exists = (p: string): boolean => { try { statSync(p); return true; } catch { return false; } };
const errorCode = (error: unknown): string | null => error && typeof error === "object" && "code" in error
  ? String((error as NodeJS.ErrnoException).code)
  : null;
const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return !(error && typeof error === "object" && "code" in error
      && String((error as NodeJS.ErrnoException).code) === "ESRCH");
  }
};

function schedStr(block: Record<string, unknown> | undefined, field: string): string | null {
  const v = block?.[field];
  return typeof v === "string" ? v : null;
}

function schedBool(block: Record<string, unknown> | undefined, field: string): boolean | null {
  const v = block?.[field];
  return typeof v === "boolean" ? v : null;
}

// 生效 scheduler 旋钮：项目块 > workspace 块 > 默认（cli=claude、promptMode=slash、
// trimFirePlugins=true——与 src/scheduler.ts buildSched 的合并方向一致；--cli flag 只影响
// run，不进 doctor）。
export function effectiveScheduler(cfg: WlConfig, project: WlProject): { cli: string; promptMode: string; trimFirePlugins: boolean } {
  const wsBlock = cfg.scheduler;
  const pjBlock = project.scheduler;
  return {
    cli: schedStr(pjBlock, "cli") ?? schedStr(wsBlock, "cli") ?? "claude",
    promptMode: schedStr(pjBlock, "promptMode") ?? schedStr(wsBlock, "promptMode") ?? "slash",
    trimFirePlugins: schedBool(pjBlock, "trimFirePlugins") ?? schedBool(wsBlock, "trimFirePlugins") ?? true,
  };
}

export function opencodeVersionOf(bin: string): [number, number, number] | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

const versionLt = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

// Claude Code 侧 writing-loop 插件是否已装：先读注册表 installed_plugins.json
//（v2：plugins 键形如 "<plugin>@<marketplace>"），读不到/换版式再目录探测兜底。
export function claudePluginInstalled(claudeHome = join(homedir(), ".claude")): boolean {
  const plugins = join(claudeHome, "plugins");
  try {
    const reg = JSON.parse(readFileSync(join(plugins, "installed_plugins.json"), "utf8")) as { plugins?: Record<string, unknown> };
    if (reg.plugins && Object.keys(reg.plugins).some((k) => k === "writing-loop" || k.startsWith("writing-loop@"))) return true;
  } catch { /* 注册表缺失/换版式 ⇒ 目录探测 */ }
  for (const sub of ["cache", "marketplaces"]) {
    try {
      if (readdirSync(join(plugins, sub)).some((n) => n === "writing-loop" || n === "writing-loop-npm")) return true;
    } catch { /* 目录不在 ⇒ 继续 */ }
  }
  return false;
}

function usage(): void {
  console.log(`writing-loop doctor — 只读体检（暖色警告不失败、结构性问题才 FAIL）
用法: writing-loop doctor`);
}

// ─── 主体 ──────────────────────────────────────────────────────────────────────
export function doctorMain(argv = process.argv.slice(2)): number {
  if (argv[0] === "--help" || argv[0] === "-h") { usage(); return 0; }
  if (argv.length) { console.error(`writing-loop doctor: 未知参数 '${argv[0]}'`); usage(); return 2; }

  let failed = false;
  let next: string | null = null; // 首个（最高优先）NEXT 建议胜出
  let nextPriority: 0 | 1 | 2 = 0; // 0=unset，1=WARN/普通建议，2=FAIL 恢复动作
  const ok = (m: string): void => { console.log(`ok  : ${m}`); };
  const warn = (code: string | null, m: string, suggest?: string): void => {
    console.log(`WARN${code ? ` ${code}` : ""}: ${m}`);
    if (suggest && nextPriority < 1) { next = suggest; nextPriority = 1; }
  };
  const fail = (m: string, suggest?: string): void => {
    console.log(`FAIL: ${m}`);
    failed = true;
    if (suggest && nextPriority < 2) { next = suggest; nextPriority = 2; }
  };

  // Identity/registry/activity locks use O_EXCL and deliberately never auto-reap: only the
  // operator can decide that the original writer will not return. Doctor therefore performs a
  // bounded, inode-safe read, reports PID + mtime and gives a conservative manual recovery step.
  const diagnoseExclusiveLock = (
    file: string,
    subject: string,
    blockedAction: string,
    recoveryAction: string,
  ): void => {
    try { lstatSync(file); }
    catch (error) {
      if (errorCode(error) === "ENOENT") return;
      fail(`无法检查 ${subject} ${file}：${error instanceof Error ? error.message : String(error)}`,
        `保留现场并人工审计 ${file}`);
      return;
    }

    const read = readRegularTextHead(file, EXCLUSIVE_LOCK_BYTES);
    if (!read) {
      // A legitimate writer may have released the lock between lstat and open. Only suppress the
      // diagnostic when the path is now genuinely absent; replacement/special files remain FAIL.
      try { lstatSync(file); }
      catch (error) { if (errorCode(error) === "ENOENT") return; }
      const recovery = `确认没有活跃写者后，${recoveryAction}`;
      fail(`${subject} 无法安全读取（须为单链接普通文件）：${file} —— ${blockedAction}`, recovery);
      return;
    }
    if (read.truncated) {
      const recovery = `确认没有活跃写者后，${recoveryAction}`;
      fail(`${subject} 超过 ${EXCLUSIVE_LOCK_BYTES} bytes 安全预算：${file} —— ${blockedAction}`, recovery);
      return;
    }

    let ownerPid: number | null = null;
    let acquiredAt = "?";
    try {
      const parsed = JSON.parse(read.text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
        throw new Error("owner 元数据无效");
      }
      ownerPid = parsed.pid;
      acquiredAt = typeof parsed.acquiredAt === "string" ? parsed.acquiredAt
        : typeof parsed.createdAt === "string" ? parsed.createdAt : "?";
    } catch (error) {
      const recovery = `确认没有活跃写者后，${recoveryAction}`;
      fail(`${subject} owner 元数据无法验证：${file}（${error instanceof Error ? error.message : String(error)}）—— ${blockedAction}`,
        recovery);
      return;
    }

    const age = Math.max(0, Math.round((Date.now() - Date.parse(read.updatedAt)) / 60_000));
    const owner = `pid=${ownerPid} acquiredAt=${acquiredAt}`;
    if (!processAlive(ownerPid)) {
      const recovery = `确认 PID ${ownerPid} 已退出后，${recoveryAction}`;
      fail(`${subject} 的 owner PID ${ownerPid} 已退出（age ${age}min；${owner}）—— ${blockedAction}`, recovery);
    } else if (age > STALE_EXCLUSIVE_LOCK_MINUTES) {
      const recovery = `确认 ${owner} 对应写者已退出后，${recoveryAction}`;
      fail(`${subject} 陈旧（age ${age}min；${owner}）—— ${blockedAction}`, recovery);
    } else {
      ok(`${subject} 在位且新鲜（age ${age}min；${owner}）—— 写者可能正在工作`);
    }
  };

  console.log("writing-loop doctor — 只读体检\n");

  // 1. node 版本（发布包 engines >=20.11；老 node 多半仍能跑大半命令 ⇒ 只 warn）
  const [nMaj, nMin] = process.versions.node.split(".").map(Number);
  if (nMaj > MIN_NODE[0] || (nMaj === MIN_NODE[0] && nMin >= MIN_NODE[1])) {
    ok(`node v${process.versions.node}（engines >=${MIN_NODE.join(".")}）`);
  } else {
    warn(null, `node v${process.versions.node} 低于 engines >=${MIN_NODE.join(".")} —— 建议升级`);
  }

  // 2. workspace 可解析（调度器 wl-run 已是包内原生 TS——不再有解释器前置条件）
  let root: string | null = null;
  try {
    root = findWorkspaceRoot();
  } catch (e) {
    fail(e instanceof WsError ? e.message : String(e), "修正或 unset WRITING_LOOP_WORKSPACE");
  }
  if (root === null && !failed) {
    fail("未在 workspace 内（从 CWD 向上找不到 .writing-loop/，也无 WRITING_LOOP_WORKSPACE）",
      "writing-loop init 铺骨架（或在 Claude Code 里跑 /writing-loop:add-script 立项）");
  }

  // Stable identity + machine-local registry diagnosis. Both APIs below are diagnostic reads:
  // doctor must never call ensureWorkspaceIdentity/registerWorkspace and therefore never creates
  // workspace.json, WRITING_LOOP_HOME, registry files or locks. Registry reads are bounded by the
  // registry module (256 KiB / 128 entries), and only three degraded samples are printed here.
  let workspaceIdentity: WorkspaceIdentity | null = null;
  let identityMissing = false;
  let registry: WorkspaceRegistrySnapshot | null = null;
  let registryInspectionError: string | null = null;
  if (root) {
    try {
      workspaceIdentity = readWorkspaceIdentity(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      identityMissing = message.startsWith("workspace identity 缺失：");
      if (!identityMissing) {
        fail(`workspace identity 无法安全读取：${message}`,
          "从可信备份恢复 .writing-loop/workspace.json；不要用新 ID 覆盖损坏的稳定 identity");
      }
    }
    try {
      registry = inspectWorkspaceRegistry();
    } catch (error) {
      // writingLoopHome() validates WRITING_LOOP_HOME before the registry inspector can build a
      // snapshot. Convert that configuration error into the same stable doctor tail contract.
      registryInspectionError = error instanceof Error ? error.message : String(error);
    }

    const identityLock = join(root, ".writing-loop", "workspace.json.lock");
    if (hasSymlinkComponent(root, [".writing-loop", "workspace.json.lock"])) {
      fail(`workspace identity 写锁路径含符号链接：${identityLock}`, `人工审计并修复 ${identityLock}`);
    } else {
      diagnoseExclusiveLock(
        identityLock,
        "workspace identity 写锁",
        "稳定 identity 创建可能被崩溃残锁阻断",
        `人工审计并移除 ${identityLock}；不要改写 workspace ID`,
      );
    }
    if (registry && registry.registryStatus !== "corrupt") {
      diagnoseExclusiveLock(
        `${registry.file}.lock`,
        "workspace registry 写锁",
        "workspace add/remove 可能被崩溃残锁阻断",
        `人工审计并移除 ${registry.file}.lock；不要删除 ${registry.file}`,
      );
    }

    if (registryInspectionError) {
      fail(`workspace registry 无法检查：${registryInspectionError}`,
        "修正或 unset WRITING_LOOP_HOME，再运行 writing-loop workspace list");
    } else if (registry?.registryStatus === "corrupt") {
      fail(`workspace registry 损坏：${registry.diagnostics[0] ?? registry.file}`,
        `保留现场并人工审计 ${registry.file}；不要用 workspace add 静默覆盖`);
    }

    if (identityMissing) {
      warn("W12", `workspace identity 缺失：${join(root, ".writing-loop", "workspace.json")} —— 旧 workspace 仍可单独使用，但没有稳定 Studio namespace`,
        `writing-loop workspace add ${root}`);
    } else if (workspaceIdentity) {
      ok(`workspace identity: ${workspaceIdentity.id}`);
    }

    if (registry?.registryStatus === "missing") {
      warn("W13", `本机 workspace registry 尚未创建：${registry.file}`,
        `writing-loop workspace add ${root}`);
    } else if (registry?.registryStatus === "ok") {
      const degraded = registry.entries.filter((entry) => entry.status !== "ok");
      const currentById = workspaceIdentity
        ? registry.entries.find((entry) => entry.id === workspaceIdentity!.id)
        : undefined;
      const currentByRoot = registry.entries.find((entry) => entry.root === root);
      const currentHealthy = workspaceIdentity !== null
        && currentById?.status === "ok" && currentById.root === root;
      const currentProblem = workspaceIdentity !== null && !currentHealthy
        ? currentById
          ? `当前 ID ${workspaceIdentity.id} 的 registry 指针为 ${currentById.status}（${currentById.diagnostic ?? currentById.root}）`
          : currentByRoot
            ? `当前 root 被另一个 ID ${currentByRoot.id} 绑定（status=${currentByRoot.status}）`
            : `registry 缺当前 workspace ${workspaceIdentity.id}`
        : null;

      if (currentProblem || degraded.length) {
        const samples = degraded.slice(0, 3)
          .map((entry) => `${entry.id}=${entry.status}${entry.diagnostic ? ` (${entry.diagnostic})` : ""}`)
          .join("；");
        const suffix = degraded.length
          ? `；degraded ${degraded.length}/${registry.entries.length}${samples ? `：${samples}` : ""}`
          : "";
        warn("W13", `${currentProblem ?? "本机 registry 含不可用指针"}${suffix}`,
          currentProblem && !currentByRoot
            ? `writing-loop workspace add ${root}`
            : "运行 writing-loop workspace list 核对；确认废弃后用 workspace remove ID 只移除本机指针");
      } else if (workspaceIdentity) {
        ok(`workspace registry 已登记当前 workspace（${registry.entries.length} 条，全部健康）`);
      }
    }
  }

  // 3. config.json 可解析 + 项目轻校验
  let ws: Workspace | null = null;
  if (root) {
    ok(`workspace: ${root}（状态目录 ${dataRoot(root)}）`);
    try {
      ws = loadConfig(root);
    } catch (e) {
      fail(e instanceof WsError ? e.message : String(e), "修复 .writing-loop/config.json（见上方行号）");
    }
  }

  if (ws) {
    const rawProjects = (ws.config as Record<string, unknown>).projects;
    let projects: Array<[string, unknown]> = [];
    if (rawProjects === undefined || rawProjects === null) {
      projects = [];
    } else if (typeof rawProjects === "object" && !Array.isArray(rawProjects)) {
      projects = Object.entries(rawProjects as Record<string, unknown>);
    } else {
      fail("config.json 的 projects 必须是 JSON 对象", "修复 .writing-loop/config.json 的 projects");
    }
    const validProjects: Array<[string, WlProject]> = [];
    for (const [key, value] of projects) {
      try {
        validProjects.push([key, requireProjectEntry(key, value)]);
      } catch (error) {
        fail(error instanceof WsError ? error.message : String(error),
          "把非法项目 key 迁移为 1–32 位小写 ASCII key（建议先备份 config.json 与对应 .writing-loop 数据目录）");
      }
    }
    const enabled = validProjects.filter(([, p]) => p.enabled !== false);
    ok(`config.json 可解析（项目 ${projects.length} 个，enabled ${enabled.length} 个）`);

    // config 写锁跨项目共享；陈旧锁会阻断 Studio/CLI/add-script 的任何索引更新，doctor
    // 只诊断不擅自删除。删除前必须由操作者确认记录中的 PID 已不存活。
    const configLock = join(dataRoot(ws.root), "config.json.lock");
    if (hasSymlinkComponent(ws.root, [".writing-loop", "config.json.lock"])) {
      fail(`config.json.lock 路径含符号链接：${configLock}`, `人工审计并修复 ${configLock}`);
    } else {
      diagnoseExclusiveLock(
        configLock,
        "config.json.lock",
        "项目启停/注册会被阻断",
        `优先用原 input + planId 重试未完成立项；无 journal 时再人工审计后手动移除 ${configLock}`,
      );
    }

    // Activity index locks are intentionally per-project and can survive a process crash. Check
    // disabled projects too: re-enabling one should not reveal a permanent refresh failure later.
    for (const [key] of validProjects) {
      const activityLock = join(projectDataDir(ws.root, key), ".activity-index.v2.lock");
      if (hasSymlinkComponent(ws.root, [".writing-loop", key, ".activity-index.v2.lock"])) {
        fail(`项目 '${key}' activity index 刷新锁路径含符号链接：${activityLock}`,
          `人工审计并修复 ${projectDataDir(ws.root, key)}`);
      } else {
        diagnoseExclusiveLock(
          activityLock,
          `项目 '${key}' activity index 刷新锁`,
          "Studio activity bootstrap/refresh 会被阻断",
          `人工审计并移除 ${activityLock}；activity index 是可重建缓存，不要删除源 ledger`,
        );
      }
    }

    // Correlate immutable production intents with the authoritative ledger. This is deliberately
    // read-only: recoverable crash prefixes get an exact-replay warning, while missing/corrupt
    // evidence is structural and blocks remote dispatch until an operator audits it.
    if (workspaceIdentity) {
      for (const [key] of validProjects) {
        try {
          const findings = inspectProductionRecovery(ws.root, workspaceIdentity.id, key);
          if (findings.length === 0) {
            ok(`项目 '${key}' production enqueue 恢复链一致`);
          }
          for (const finding of findings) {
            const subject = finding.taskId === null ? `项目 '${key}'` : `项目 '${key}' task '${finding.taskId}'`;
            if (finding.severity === "failure") {
              fail(`${subject} production ${finding.code}：${finding.detail}`,
                `保留现场并人工审计 ${projectDataDir(ws.root, key)}；禁止猜测或重发远端任务`);
            } else {
              warn("W14", `${subject} production ${finding.code}：${finding.detail}`,
                "使用原 enqueue input 先 --plan，再以匹配 --confirm PLAN_ID 精确重放");
            }
          }
        } catch (error) {
          fail(`项目 '${key}' production 恢复证据无法安全读取：${error instanceof Error ? error.message : String(error)}`,
            `保留现场并人工审计 ${projectDataDir(ws.root, key)}`);
        }
      }
    }

    // Durable onboarding journal 是 config 发布前崩溃的恢复依据；doctor 只诊断，绝不
    // 删除 journal/lease/所有权标记。最多逐项读取 100 个 entry，避免损坏目录拖垮体检。
    const txDir = join(dataRoot(ws.root), ".onboarding-transactions");
    if (hasSymlinkComponent(ws.root, [".writing-loop", ".onboarding-transactions"])) {
      fail(`onboarding 事务路径含符号链接：${txDir}`, `人工审计并修复 ${txDir}`);
    } else try {
      const txInfo = lstatSync(txDir);
      if (!txInfo.isDirectory() || txInfo.isSymbolicLink()) {
        fail(`onboarding 事务路径不是普通目录：${txDir}`, `人工审计并修复 ${txDir}`);
      } else {
        const names: string[] = [];
        const handle = opendirSync(txDir);
        try {
          for (;;) {
            const entry = handle.readSync();
            if (!entry) break;
            if (names.length >= 100) {
              fail(`onboarding 事务目录超过 100 个 entry；拒绝无界扫描：${txDir}`, `人工审计 ${txDir}`);
              break;
            }
            names.push(entry.name);
          }
        } finally { handle.closeSync(); }
        for (const name of names.filter((entry) => /^[a-z0-9][a-z0-9._-]{0,31}\.json$/.test(entry)).sort()) {
          const file = join(txDir, name);
          const key = name.slice(0, -5);
          try {
            const read = readRegularTextHead(file, ONBOARDING_JOURNAL_MAX_BYTES);
            if (!read) throw new Error("journal 不是可安全读取的单链接普通文件");
            if (read.truncated) throw new Error(`journal 超过 ${ONBOARDING_JOURNAL_MAX_BYTES} bytes 安全预算`);
            const journal = JSON.parse(read.text) as {
              kind?: unknown; planId?: unknown; ownerPid?: unknown; state?: unknown;
            };
            if (journal.kind !== "writing-loop/onboarding-transaction" || typeof journal.planId !== "string"
              || typeof journal.ownerPid !== "number" || !Number.isInteger(journal.ownerPid) || journal.ownerPid <= 0
              || typeof journal.state !== "string") throw new Error("journal 结构无效");
            const visible = Object.prototype.hasOwnProperty.call(ws.config.projects ?? {}, key);
            if (visible) {
              warn("W11", `项目 '${key}' 已在 config 可见，但 onboarding journal 仍残留（state=${journal.state} planId=${journal.planId}）—— 先 project verify，再人工审计恢复元数据`);
            } else if (processAlive(journal.ownerPid)) {
              ok(`项目 '${key}' 立项事务正在执行或 PID 被复用（pid=${journal.ownerPid} state=${journal.state}）`);
            } else {
              const recovery = `用原 input 和 --confirm ${journal.planId} 重试 project create；不要手动删除受管 repo/data`;
              fail(`项目 '${key}' 有未完成的崩溃立项事务（pid=${journal.ownerPid} state=${journal.state} planId=${journal.planId}）`, recovery);
            }
          } catch (error) {
            fail(`onboarding journal 无法安全读取 ${file}：${error instanceof Error ? error.message : String(error)}`,
              `保留现场并人工审计 ${file}`);
          }
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        fail(`onboarding 事务目录无法安全读取 ${txDir}：${error instanceof Error ? error.message : String(error)}`,
          `保留现场并人工审计 ${txDir}`);
      }
      // ENOENT = 尚未使用自动立项，正常。
    }

    if (!projects.length && nextPriority < 1) {
      next = "在 Claude Code 里跑 /writing-loop:add-script 立项 interview";
      nextPriority = 1;
    }

    // provider 注册表校验（workspace 顶层 providers；先解析好，供下面 per-project 的 W05
    // 扩展条件、与循环结束后的 W09/W10 workspace 级检查共用）。非法 ⇒ FAIL（阻断
    // writing-loop run 整体起 fire，严重度同 config.json 不可解析）；providers 留空注册表，
    // 后续检查按空处理，不再重复报错。
    let providers: Record<string, ProviderEntry> = {};
    try {
      providers = parseProviders(ws.config);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "修复 .writing-loop/config.json 的 providers 块");
    }
    const providerIds = Object.keys(providers);

    for (const [key, p] of enabled) {
      console.log(`\n—— 项目 ${key} ——`);
      const repo = resolveRepoPath(ws.root, p);

      // repoPath 存在且是 git repo（.git 目录或 worktree 的 .git 文件）
      if (!isDir(repo)) warn("W02", `repoPath 不存在：${repo}`);
      else if (!exists(join(repo, ".git"))) warn("W02", `repoPath 不是 git repo（无 .git）：${repo}`);
      else ok(`repoPath 存在且是 git repo: ${repo}`);

      // 创作规格轻校验（config-schema「校验规则」）：paywall.card1 ⊂ [8..12]、audience 非空
      const card1 = p.paywall?.card1;
      if (card1 !== undefined) {
        const okCard = Array.isArray(card1) && card1.length > 0 && card1.every((x) => Number.isInteger(x) && x >= 8 && x <= 12);
        if (okCard) ok(`paywall.card1 ⊂ [8..12]: [${(card1 as number[]).join(", ")}]`);
        else warn("W03", `paywall.card1 越界（须为 [8..12] 内的非空整数数组，得到 ${JSON.stringify(card1)}）`);
      } else {
        warn("W03", "paywall.card1 缺失（备卡制 R4.5 的参数来源）");
      }
      if (typeof p.audience === "string" && p.audience.trim()) ok(`audience 非空: ${p.audience}`);
      else warn("W03", "audience 为空 —— 评估红线①（受众画像含性别+年龄）的入口预防");

      // 板目录存在可写（缺 = 还没铺板，warn；存在但不可写 = 结构性 FAIL）
      const board = join(projectDataDir(ws.root, key), "board", "tickets");
      if (!isDir(board)) {
        warn(null, `板目录尚未创建：${board}（add-script 立项或首 fire 会铺）`);
      } else {
        try {
          accessSync(board, constants.W_OK);
          ok(`板目录存在可写: ${board}`);
        } catch {
          fail(`板目录不可写：${board}`, `检查目录权限：${board}`);
        }
      }

      // scheduler.cli 二进制在 PATH + 引擎特定检查
      const { cli, promptMode, trimFirePlugins } = effectiveScheduler(ws.config, p);
      const bin = findOnPath(cli);
      if (!bin) {
        warn("W04", `scheduler.cli=${cli} 不在 PATH —— wl-run 起 fire 会失败`, `安装 ${cli}（或改 config 的 scheduler.cli）`);
      } else {
        ok(`scheduler.cli=${cli} 在 PATH: ${bin}（promptMode=${promptMode}）`);
      }
      // opencode 版本检查（W05）：cli=opencode 本身要查；providers 注册表非空时即便本项目
      // cli 不是 opencode 也查——迟早会被某 agent 的 model 覆盖成 provider/model 形用到
      // opencode，值得提前查二进制是否就绪（触发条件扩为 cli==="opencode" || providers 非空）。
      if (cli === "opencode" || providerIds.length > 0) {
        const opencodeBin = cli === "opencode" ? bin : findOnPath("opencode");
        if (opencodeBin) {
          const v = opencodeVersionOf(opencodeBin);
          if (!v) warn(null, "无法解析 opencode --version 输出 —— 请自查 >= 1.2.24（认证下限）");
          else if (versionLt(v, MIN_OPENCODE)) warn("W05", `opencode ${v.join(".")} < ${MIN_OPENCODE.join(".")}（认证下限）—— 请升级`);
          else ok(`opencode ${v.join(".")} >= ${MIN_OPENCODE.join(".")}（认证下限）`);
        } else if (cli !== "opencode") {
          // cli===opencode 时「不在 PATH」已由上面的 W04 报过，这里只覆盖新增面
          // （providers 非空但本项目当前 cli 不是 opencode），不重复发码。
          warn(null, "providers 非空但 opencode 不在 PATH —— 一旦某 agent 的 model 被覆盖成 provider/model 形，其 opencode fire 会失败");
        }
      }
      if (cli === "claude" && promptMode !== "inline") {
        if (claudePluginInstalled()) ok("Claude Code 已装 writing-loop 插件（slash prompt 可解析）");
        else warn("W06",
          "cli=claude 且 promptMode!=inline，但 ~/.claude/plugins 未检出 writing-loop 插件 —— 斜杠命令 fire 会空转",
          `writing-loop install-claude-plugin 注册后在 Claude Code 里 /plugin install（或 config 设 scheduler.promptMode="inline"）`);
      }

      // fire 减肥（trimFirePlugins，0.6.0）——wl-run resolveTrimPlugins 同一降级链的预检：
      // 任一前提不满足 ⇒ wl-run 优雅降级不注入 --settings（fire 照旧起），doctor 只提示。
      if (cli === "claude") {
        if (!trimFirePlugins) {
          ok("fire 减肥：trimFirePlugins=false（config 显式关闭）—— fire 不注入 --settings");
        } else {
          const plugins = readEnabledPlugins();
          if (!plugins) {
            warn("W08", "fire 减肥：读不到 ~/.claude/settings.json 的 enabledPlugins —— 无插件清单可裁，wl-run 将不注入 --settings");
          } else if (bin && !claudeSupportsSettingsFlag(bin)) {
            warn("W08", "fire 减肥：本机 claude 不支持 --settings —— wl-run 将优雅降级不加 flag",
              "升级 Claude Code 以恢复 fire 减肥（--settings 注入）");
          } else if (bin) {
            const { disabledCount } = buildTrimSettingsJson(plugins);
            ok(`fire 减肥就绪：每 fire --settings 仅启 writing-loop 插件（其余 ${disabledCount} 个置 false）`);
          }
          // bin 缺失时 W04 已警告——无从探测 --settings，不重复告警
        }
      }

      // wl-run.lock 陈旧（>60min = 崩溃残锁的典型形状；在位且新鲜 = 调度器在跑，是 ok）
      const lock = join(projectDataDir(ws.root, key), "wl-run.lock");
      try {
        const age = Math.round((Date.now() - statSync(lock).mtimeMs) / 60000);
        if (age > 60) warn("W07", `wl-run.lock 陈旧（age ${age}min > 60min）—— 多半是崩溃残锁；wl-run 下次启动自动回收`);
        else ok(`wl-run.lock 在位且新鲜（age ${age}min）—— 调度器可能正在运行`);
      } catch { /* 无锁 = 未在跑，正常，不打行 */ }
    }

    // provider 注册表体检（workspace 级，与项目无关，只跑一次）：
    //   W09 每条 authTokenEnv 能否从当前进程 env 解析——绝不打印变量的值，只打印变量名；
    //   W10 opencode.json 是否已同步（只读，不做任何修改——真正的写落在 sync-opencode）。
    if (providerIds.length) {
      console.log(`\n—— provider 注册表 ——`);
      for (const id of providerIds) {
        const entry = providers[id];
        // 与 providerAuthGap 同判据：空串同视为不可解析（`export KEY=` 手滑形——设了但为空，
        // opencode 会拿 "" 白跑 401），措辞点名两态之别。
        const v = process.env[entry.authTokenEnv];
        if (v !== undefined && v !== "") {
          ok(`provider '${id}' 认证 ${entry.authTokenEnv} 可解析`);
        } else {
          warn("W09", `provider '${id}' 认证环境变量 ${entry.authTokenEnv} 不可解析（${authGapPhrase(v === "" ? "empty" : "unset")}）—— 其 opencode fire 会预检失败；请 export 非空值`);
        }
      }
      const drift = opencodeSyncDrift(ws.root, providers);
      if (drift === null) ok(`opencode.json 已含 ${providerIds.length} 个注册 provider`);
      else warn("W10", `${drift} —— 运行: writing-loop sync-opencode`);
    }
  }

  console.log("");
  console.log(failed ? "WRITING_LOOP_DOCTOR_FAILED" : "WRITING_LOOP_DOCTOR_OK");
  console.log(`NEXT: ${next ?? "writing-loop run --dry-run 预演各 agent 命令，再 writing-loop run 起团队"}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(doctorMain());
}
