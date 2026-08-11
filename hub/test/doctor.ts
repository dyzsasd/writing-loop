// doctor 回归：非法项目 key 与陈旧 config 写锁必须成为结构化 FAIL，且永远保留尾行契约。
import { execFileSync } from "node:child_process";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorMain } from "../src/doctor.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-doctor-parity-")));
const data = join(tmp, ".writing-loop");
const config = join(data, "config.json");
const identityFile = join(data, "workspace.json");
const machineHome = join(tmp, "machine-home");
const registryFile = join(machineHome, "workspaces.json");
const savedWorkspace = process.env.WRITING_LOOP_WORKSPACE;
const savedHome = process.env.WRITING_LOOP_HOME;
const workspaceId = "ws_11111111111111111111111111111111";

const runDoctor = (): { code: number; output: string } => {
  const lines: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]): void => { lines.push(args.map(String).join(" ")); };
  try { return { code: doctorMain([]), output: lines.join("\n") }; }
  finally { console.log = oldLog; console.error = oldError; }
};

try {
  mkdirSync(data, { recursive: true });
  process.env.WRITING_LOOP_WORKSPACE = tmp;
  process.env.WRITING_LOOP_HOME = machineHome;
  writeFileSync(config, JSON.stringify({ projects: { "../../escape": { repoPath: ".", enabled: true } } }));
  const unsafe = runDoctor();
  ok(unsafe.code === 1 && unsafe.output.includes("非法项目 key"), "doctor 把路径穿越式 config key 报为结构性 FAIL");
  ok(unsafe.output.includes("WRITING_LOOP_DOCTOR_FAILED") && unsafe.output.includes("NEXT:"), "非法 key 不再打断 doctor 的稳定尾行契约");

  for (const malformed of [null, [], 7]) {
    writeFileSync(config, JSON.stringify({ projects: { demo: malformed } }));
    const invalidProject = runDoctor();
    ok(invalidProject.code === 1 && invalidProject.output.includes("项目 'demo' 必须是 JSON 对象")
      && invalidProject.output.includes("WRITING_LOOP_DOCTOR_FAILED") && invalidProject.output.includes("NEXT:"),
    `doctor 对 ${JSON.stringify(malformed)} 项目条目保留结构化 FAIL 尾行`);
  }

  writeFileSync(config, JSON.stringify({ projects: {} }));
  const lock = `${config}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: "2026-01-01T00:00:00.000Z" }));
  const staleAt = new Date(Date.now() - 61 * 60_000);
  utimesSync(lock, staleAt, staleAt);
  const stale = runDoctor();
  ok(stale.code === 1 && stale.output.includes("config.json.lock 陈旧"), "doctor 显式诊断会永久阻断配置写入的陈旧锁");
  ok(stale.output.includes("手动移除") && stale.output.includes("WRITING_LOOP_DOCTOR_FAILED")
    && stale.output.includes("NEXT: 确认") && !stale.output.includes("NEXT: writing-loop workspace add"),
  "陈旧锁的 FAIL 恢复动作优先于 W12/W13 普通建议，且不擅自删除");
  rmSync(lock);

  // 旧 workspace 没有稳定 ID 是可修复的暖警告。doctor 只读：不能顺手创建 identity、
  // WRITING_LOOP_HOME、registry 或任何 lock。
  writeFileSync(config, JSON.stringify({ projects: {} }));
  const noIdentity = runDoctor();
  ok(noIdentity.code === 0 && noIdentity.output.includes("WARN W12")
    && noIdentity.output.includes("writing-loop workspace add"),
  "doctor 将缺失 identity 报为 W12，并给 workspace add 的一次性迁移指引");
  ok(noIdentity.output.includes("WARN W13") && noIdentity.output.includes("registry 尚未创建"),
    "doctor 将缺失的非权威 registry 报为 W13 暖警告");
  ok(!existsSync(identityFile) && !existsSync(machineHome),
    "identity/registry 缺失体检严格只读，不创建文件、目录或锁");

  const corruptIdentityBytes = "{broken identity\n";
  writeFileSync(identityFile, corruptIdentityBytes);
  const corruptIdentity = runDoctor();
  ok(corruptIdentity.code === 1 && corruptIdentity.output.includes("workspace identity 无法安全读取")
    && corruptIdentity.output.includes("不要用新 ID 覆盖")
    && corruptIdentity.output.includes("WRITING_LOOP_DOCTOR_FAILED"),
  "已存在但损坏的 identity 是结构性 FAIL，且禁止静默换 ID");
  ok(readFileSync(identityFile, "utf8") === corruptIdentityBytes && !existsSync(machineHome),
    "损坏 identity 诊断保留原字节，仍不创建 registry home");

  writeFileSync(identityFile, JSON.stringify({ version: 1, id: workspaceId }) + "\n");
  const noRegistry = runDoctor();
  ok(noRegistry.code === 0 && !noRegistry.output.includes("WARN W12")
    && noRegistry.output.includes("WARN W13") && noRegistry.output.includes("workspace add"),
  "identity 健康但 registry 缺失时只给 W13，不阻断单 workspace 创作");
  ok(!existsSync(machineHome), "读取缺失 registry 不创建 WRITING_LOOP_HOME");

  mkdirSync(machineHome);
  writeFileSync(registryFile, JSON.stringify({ version: 1, workspaces: [] }) + "\n");
  const emptyRegistryBefore = readFileSync(registryFile, "utf8");
  const unregistered = runDoctor();
  ok(unregistered.code === 0 && unregistered.output.includes("WARN W13")
    && unregistered.output.includes(`registry 缺当前 workspace ${workspaceId}`)
    && unregistered.output.includes("writing-loop workspace add"),
  "registry 缺当前 workspace 时给可执行的 add 修复建议");
  ok(readFileSync(registryFile, "utf8") === emptyRegistryBefore,
    "缺当前 workspace 的 registry 诊断不自动注册或改写索引");

  writeFileSync(registryFile, JSON.stringify({
    version: 1,
    workspaces: [{ id: workspaceId, root: tmp, label: "Doctor fixture" }],
  }) + "\n");
  const healthyRegistryBefore = readFileSync(registryFile, "utf8");
  const healthyRegistry = runDoctor();
  ok(healthyRegistry.code === 0 && healthyRegistry.output.includes(`workspace identity: ${workspaceId}`)
    && healthyRegistry.output.includes("workspace registry 已登记当前 workspace")
    && !healthyRegistry.output.includes("WARN W12") && !healthyRegistry.output.includes("WARN W13"),
  "identity 与当前 registry 指针匹配时给健康结论");
  ok(readFileSync(registryFile, "utf8") === healthyRegistryBefore,
    "健康 registry 体检同样不做格式化或落盘写回");

  const vanishedRoot = join(tmp, "moved-away");
  writeFileSync(registryFile, JSON.stringify({
    version: 1,
    workspaces: [{ id: workspaceId, root: vanishedRoot }],
  }) + "\n");
  const degradedRegistryBefore = readFileSync(registryFile, "utf8");
  const degradedRegistry = runDoctor();
  ok(degradedRegistry.code === 0 && degradedRegistry.output.includes("WARN W13")
    && degradedRegistry.output.includes("指针为 missing")
    && degradedRegistry.output.includes("degraded 1/1")
    && degradedRegistry.output.includes("writing-loop workspace add"),
  "当前 workspace 的旧 root 指针 degraded 时给 self-heal add 指引但不阻断核心命令");
  ok(readFileSync(registryFile, "utf8") === degradedRegistryBefore,
    "degraded registry 诊断不擅自自愈或删除旧指针");

  const corruptRegistryBytes = "{broken registry\n";
  writeFileSync(registryFile, corruptRegistryBytes);
  const corruptRegistry = runDoctor();
  ok(corruptRegistry.code === 1 && corruptRegistry.output.includes("workspace registry 损坏")
    && corruptRegistry.output.includes("人工审计")
    && corruptRegistry.output.includes("WRITING_LOOP_DOCTOR_FAILED"),
  "registry 顶层严重损坏是稳定 FAIL，并要求保留现场");
  ok(readFileSync(registryFile, "utf8") === corruptRegistryBytes,
    "损坏 registry 的 doctor 诊断不覆盖原始恢复证据");

  process.env.WRITING_LOOP_HOME = "relative-home-is-invalid";
  const invalidHome = runDoctor();
  ok(invalidHome.code === 1 && invalidHome.output.includes("workspace registry 无法检查")
    && invalidHome.output.includes("WRITING_LOOP_HOME 必须是绝对路径")
    && invalidHome.output.includes("WRITING_LOOP_DOCTOR_FAILED"),
  "非法 WRITING_LOOP_HOME 不再令 doctor 抛异常，仍保留结构化尾行");
  process.env.WRITING_LOOP_HOME = machineHome;

  // Restore a healthy registry so the onboarding regression below is isolated from registry
  // diagnostics and still proves the original recovery behavior.
  writeFileSync(registryFile, JSON.stringify({
    version: 1,
    workspaces: [{ id: workspaceId, root: tmp }],
  }) + "\n");

  const identityLock = `${identityFile}.lock`;
  const healthyIdentityBytes = readFileSync(identityFile, "utf8");
  rmSync(identityFile);
  const deadIdentityLockBytes = JSON.stringify({ pid: 999_999, acquiredAt: "2026-08-10T00:00:00.000Z" }) + "\n";
  writeFileSync(identityLock, deadIdentityLockBytes);
  const deadIdentityLock = runDoctor();
  ok(deadIdentityLock.code === 1 && deadIdentityLock.output.includes("workspace identity 写锁")
    && deadIdentityLock.output.includes("owner PID 999999 已退出")
    && deadIdentityLock.output.includes("不要改写 workspace ID"),
  "doctor 诊断跨重启遗留的 workspace identity O_EXCL 锁，并给保守恢复指引");
  ok(readFileSync(identityLock, "utf8") === deadIdentityLockBytes,
    "identity 残锁诊断只读，不自动删除或改写 owner 证据");
  rmSync(identityLock);
  writeFileSync(identityFile, healthyIdentityBytes);

  const registryLock = `${registryFile}.lock`;
  const deadRegistryLockBytes = JSON.stringify({ pid: 999_998, acquiredAt: "2026-08-10T00:00:00.000Z" }) + "\n";
  writeFileSync(registryLock, deadRegistryLockBytes);
  const deadRegistryLock = runDoctor();
  ok(deadRegistryLock.code === 1 && deadRegistryLock.output.includes("workspace registry 写锁")
    && deadRegistryLock.output.includes("owner PID 999998 已退出")
    && deadRegistryLock.output.includes("不要删除"),
  "doctor 诊断跨重启遗留的 machine-local registry O_EXCL 锁");
  ok(readFileSync(registryLock, "utf8") === deadRegistryLockBytes,
    "registry 残锁诊断不擅自回收其他进程留下的 inode");
  rmSync(registryLock);

  const liveRegistryLockBytes = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n";
  writeFileSync(registryLock, liveRegistryLockBytes);
  const liveRegistryLock = runDoctor();
  ok(liveRegistryLock.code === 0 && liveRegistryLock.output.includes("workspace registry 写锁 在位且新鲜")
    && readFileSync(registryLock, "utf8") === liveRegistryLockBytes,
  "doctor 将活跃 PID 的新鲜 registry lock 视为正在写入，仍保持只读");
  rmSync(registryLock);

  writeFileSync(config, JSON.stringify({ projects: { demo: { repoPath: ".", enabled: true,
    monetization: "reelshort-sub", paywall: { card1: [], card2: [], card3: [] },
    audience: "男性 25-44 岁海外流媒体用户" } } }));
  const subscriptionPaywall = runDoctor();
  ok(subscriptionPaywall.output.includes("reelshort-sub 不适用硬付费 card1 门")
    && !subscriptionPaywall.output.includes("paywall.card1 越界")
    && !subscriptionPaywall.output.includes("paywall.card1 缺失"),
  "doctor 不把订阅项目的空 paywall.card1 误报为 paid-app 规格违规");
  const projectData = join(data, "demo");
  mkdirSync(projectData);
  const activityLock = join(projectData, ".activity-index.v2.lock");
  const deadActivityLockBytes = JSON.stringify({ pid: 999_997, createdAt: "2026-08-10T00:00:00.000Z" }) + "\n";
  writeFileSync(activityLock, deadActivityLockBytes);
  const deadActivityLock = runDoctor();
  ok(deadActivityLock.code === 1 && deadActivityLock.output.includes("activity index 刷新锁")
    && deadActivityLock.output.includes("owner PID 999997 已退出")
    && deadActivityLock.output.includes("不要删除源 ledger"),
  "doctor 覆盖每项目 activity index 的 crash-leftover lock，而不等到 Studio 永久报错");
  ok(readFileSync(activityLock, "utf8") === deadActivityLockBytes,
    "activity index 残锁诊断保留原文件供人工核对");
  rmSync(activityLock);

  const externalProjectData = join(tmp, "external-project-data");
  rmSync(projectData, { recursive: true });
  mkdirSync(externalProjectData);
  const externalActivityLock = join(externalProjectData, ".activity-index.v2.lock");
  writeFileSync(externalActivityLock, deadActivityLockBytes);
  symlinkSync(externalProjectData, projectData);
  const symlinkedActivity = runDoctor();
  ok(symlinkedActivity.code === 1 && symlinkedActivity.output.includes("activity index 刷新锁路径含符号链接")
    && readFileSync(externalActivityLock, "utf8") === deadActivityLockBytes,
  "doctor 在读取 activity lock 前拒绝 symlink parent，不跟随到 workspace 外");
  unlinkSync(projectData);
  rmSync(externalProjectData, { recursive: true });
  writeFileSync(config, JSON.stringify({ projects: {} }));

  const transactions = join(data, ".onboarding-transactions");
  mkdirSync(transactions);

  const oversizedJournal = join(transactions, "oversize.json");
  const oversizedBytes = `${"x".repeat(1024 * 1024 + 1)}\n`;
  writeFileSync(oversizedJournal, oversizedBytes);
  const oversizedStartedAt = Date.now();
  const oversized = runDoctor();
  ok(oversized.code === 1 && oversized.output.includes("journal 超过 1048576 bytes 安全预算")
    && oversized.output.includes("WRITING_LOOP_DOCTOR_FAILED") && Date.now() - oversizedStartedAt < 2_000,
  "doctor 与权威 parser 共用 1 MiB journal 上限，并保留稳定失败尾行");
  ok(readFileSync(oversizedJournal, "utf8") === oversizedBytes,
    "超大 journal 诊断不截断恢复证据");
  rmSync(oversizedJournal);

  const hardlinkVictim = join(tmp, "journal-victim.json");
  const hardlinkVictimBytes = JSON.stringify({
    kind: "writing-loop/onboarding-transaction",
    planId: "wlplan_hardlink",
    ownerPid: 999_996,
    state: "prepared",
  }) + "\n";
  writeFileSync(hardlinkVictim, hardlinkVictimBytes);
  const hardlinkJournal = join(transactions, "hard-link.json");
  linkSync(hardlinkVictim, hardlinkJournal);
  const hardlinked = runDoctor();
  ok(hardlinked.code === 1 && hardlinked.output.includes("不是可安全读取的单链接普通文件")
    && hardlinked.output.includes("WRITING_LOOP_DOCTOR_FAILED"),
  "doctor 拒绝 hardlink journal，避免把 workspace 外文件误作恢复事务");
  ok(readFileSync(hardlinkVictim, "utf8") === hardlinkVictimBytes,
    "hardlink journal 诊断不修改链接目标");
  rmSync(hardlinkJournal);

  const symlinkJournal = join(transactions, "symlink.json");
  symlinkSync(hardlinkVictim, symlinkJournal);
  const symlinkedJournal = runDoctor();
  ok(symlinkedJournal.code === 1 && symlinkedJournal.output.includes("不是可安全读取的单链接普通文件")
    && readFileSync(hardlinkVictim, "utf8") === hardlinkVictimBytes,
  "doctor 拒绝 final-component symlink journal 且不读取/改写目标");
  unlinkSync(symlinkJournal);

  const fifoJournal = join(transactions, "blocked.fifo.json");
  execFileSync("mkfifo", [fifoJournal]);
  const fifoStartedAt = Date.now();
  const fifo = runDoctor();
  ok(fifo.code === 1 && fifo.output.includes("不是可安全读取的单链接普通文件")
    && Date.now() - fifoStartedAt < 2_000 && existsSync(fifoJournal),
  "doctor 对 FIFO journal 快速失败，不阻塞且不删除特殊文件");
  unlinkSync(fifoJournal);

  rmSync(transactions, { recursive: true });
  const externalTransactions = join(tmp, "external-transactions");
  mkdirSync(externalTransactions);
  const externalJournal = join(externalTransactions, "outside.json");
  writeFileSync(externalJournal, hardlinkVictimBytes);
  symlinkSync(externalTransactions, transactions);
  const symlinkedTransactions = runDoctor();
  ok(symlinkedTransactions.code === 1 && symlinkedTransactions.output.includes("onboarding 事务路径含符号链接")
    && readFileSync(externalJournal, "utf8") === hardlinkVictimBytes,
  "doctor 不跟随 symlink onboarding 目录读取外部恢复元数据");
  unlinkSync(transactions);
  rmSync(externalTransactions, { recursive: true });
  mkdirSync(transactions);

  writeFileSync(join(transactions, "crash-moon.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "writing-loop/onboarding-transaction",
    planId: "wlplan_deadbeef",
    ownerPid: 999_999,
    state: "data-promoted",
  }));
  const crashedOnboarding = runDoctor();
  const diagnosedCrash = crashedOnboarding.code === 1 && crashedOnboarding.output.includes("未完成的崩溃立项事务")
    && crashedOnboarding.output.includes("--confirm wlplan_deadbeef");
  if (!diagnosedCrash) console.log(crashedOnboarding.output);
  ok(diagnosedCrash,
  "doctor 发现 config 尚不可见的 durable onboarding journal，并给 exact-plan 向前恢复指引");
  ok(existsSync(join(transactions, "crash-moon.json")), "doctor 对崩溃 journal 严格只读，不擅自清理恢复证据");
} finally {
  if (savedWorkspace === undefined) delete process.env.WRITING_LOOP_WORKSPACE;
  else process.env.WRITING_LOOP_WORKSPACE = savedWorkspace;
  if (savedHome === undefined) delete process.env.WRITING_LOOP_HOME;
  else process.env.WRITING_LOOP_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nDOCTOR_PARITY_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
