// Phase 2 onboarding 回归：plan 零写、确认绑定、失败回滚、完整三处发布、幂等重试。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceSnapshot } from "../src/project-read-model.ts";
import { commitOnboarding, OnboardingError, planOnboarding, verifyOnboarding } from "../src/onboarding.ts";
import { loadConfig } from "../src/workspace.ts";
import { setProjectEnabled } from "../src/workspace-store.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsWith = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof OnboardingError && error.message.includes(needle); }
};
const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-onboarding-")));
const data = join(tmp, ".writing-loop");
const configFile = join(data, "config.json");
const onboardingModule = new URL("../src/onboarding.ts", import.meta.url).href;
let recoveryProcessA: ChildProcess | undefined;

const input = (key = "paper-moon", repoPath = key): Record<string, unknown> => ({
  key,
  title: "纸月亮",
  repoPath,
  kind: "original",
  logline: "落魄编剧发现她写下的每一场戏都会在现实中成真。",
  audience: "女性 25-40 岁，一二线城市付费用户",
  complianceNotes: "不涉政；违法行为有后果；婚恋关系不美化控制；遵守平台内容政策。",
  nonGoals: ["不写无代价的复仇", "不借用未授权 IP"],
  genre: "revenge-slap",
  monetization: "paid-app",
  format: "live-action",
  totalEpisodes: 80,
  paywall: { card1: [9, 10, 11], card2: [26, 28, 30], card3: [60] },
  episodeWordBand: [900, 1300],
  maxPrimaryScenes: 5,
  maxNamedCharacters: 20,
  ticketPrefix: key === "paper-moon" ? "PM" : "ST",
  intakeMode: "autonomous",
  mode: "live",
  comparables: "《对标 A》与《对标 B》的公开结构数据",
  differentiation: "女主通过改写戏剧因果反制幕后操盘者",
});

try {
  mkdirSync(data, { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    version: 17,
    futureTopLevel: { preserve: true },
    projects: { legacy: { title: "旧剧", repoPath: "legacy", ticketPrefix: "LG", enabled: false, future: 42 } },
  }, null, "\t") + "\n");

  const beforePlan = readFileSync(configFile, "utf8");
  let plan = planOnboarding(tmp, input());
  const planAgain = planOnboarding(tmp, input());
  ok(plan.planId === planAgain.planId && plan.templateDigest === planAgain.templateDigest, "相同输入/config/templates 生成确定性 plan 指纹");
  ok(readFileSync(configFile, "utf8") === beforePlan && !existsSync(join(tmp, "paper-moon")), "plan 严格零写");
  ok(plan.files.includes("episodes/.gitkeep") && plan.outlineTicket.id === "PM-1", "plan 列出可克隆空目录与唯一首票");
  ok(plan.requiresConfirmation && plan.projectConfig.repoPath === "paper-moon", "plan 明示确认门并保持相对 repoPath");

  const badAudience = { ...input("bad-audience"), audience: "喜欢爽剧的人", ticketPrefix: "BA" };
  ok(throwsWith(() => planOnboarding(tmp, badAudience), "性别与年龄段"), "受众缺性别/年龄硬拒绝");
  const riskyAdaptation = {
    ...input("risky-book"), kind: "adaptation", ticketPrefix: "RB",
    comparables: undefined, differentiation: undefined,
    adaptation: { rightsScope: "已授权第一卷", compressionRatio: 8, highlightCount: 2, namedCharacterCount: 25, riskAcknowledged: false },
  };
  ok(throwsWith(() => planOnboarding(tmp, riskyAdaptation), "riskAcknowledged:true"), "改编三阈值不达标需显式确认");

  const malformedConfig = JSON.parse(beforePlan) as { projects: Record<string, unknown> };
  malformedConfig.projects.bad = null;
  writeFileSync(configFile, JSON.stringify(malformedConfig, null, 2) + "\n");
  const malformedInput = { ...input("malformed-config"), ticketPrefix: "MC" };
  ok(throwsWith(() => planOnboarding(tmp, malformedInput), "项目 'bad' 必须是 JSON 对象")
    && throwsWith(() => commitOnboarding(tmp, malformedInput, "wlplan_000000000000000000000000"), "项目 'bad' 必须是 JSON 对象")
    && !existsSync(join(tmp, "malformed-config")) && !existsSync(join(data, "malformed-config")),
  "plan/create 对 null 项目条目返回稳定配置错误且严格零写，不泄漏 TypeError/500");
  writeFileSync(configFile, beforePlan);

  ok(throwsWith(() => commitOnboarding(tmp, input(), "wlplan_wrong"), "确认指纹不匹配"), "错误确认指纹不产生写入");
  ok(!existsSync(join(tmp, "paper-moon")) && !existsSync(join(data, "paper-moon")), "确认失败后三处 ground truth 不变");

  // final 名在首次检查后被并发占用，也必须由原子 mkdir 失败；绝不以 rename 覆盖文件、
  // symlink 或空目录。事务知道自己尚未取得所有权，因此可清 journal 而不触碰目标。
  const noClobberInput = { ...input("no-clobber"), ticketPrefix: "NC", title: "不可覆盖" };
  const noClobberPlan = planOnboarding(tmp, noClobberInput);
  const plantedTarget = join(tmp, "no-clobber");
  const plantedVictim = join(tmp, "no-clobber-victim.txt");
  const plantedBytes = "FOREIGN TARGET — KEEP BYTE FOR BYTE\n";
  writeFileSync(plantedVictim, plantedBytes);
  ok(throwsWith(() => commitOnboarding(tmp, noClobberInput, noClobberPlan.planId, {
    uuid: () => "no-clobber-case",
    beforeRepoReservation: () => symlinkSync(plantedVictim, plantedTarget),
  }), "立项临时目录碰撞"), "check→reservation 间出现的 final target 使立项硬停");
  ok(realpathSync(plantedTarget) === realpathSync(plantedVictim) && readFileSync(plantedTarget, "utf8") === plantedBytes
    && !Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "no-clobber")
    && !existsSync(join(data, ".onboarding-transactions", "no-clobber.json")),
  "原子 final reservation 逐字节保留并发目标，且不发布 config/journal");
  rmSync(plantedTarget);
  rmSync(plantedVictim);

  const swapParent = join(tmp, "swap-parent");
  const swapParentAside = join(tmp, "swap-parent-aside");
  const redirectParent = join(tmp, "redirect-parent");
  mkdirSync(swapParent);
  mkdirSync(redirectParent);
  const parentSwapInput = { ...input("parent-swap", "swap-parent/parent-swap"), ticketPrefix: "PS", title: "父目录竞态" };
  const parentSwapPlan = planOnboarding(tmp, parentSwapInput);
  ok(throwsWith(() => commitOnboarding(tmp, parentSwapInput, parentSwapPlan.planId, {
    uuid: () => "parent-swap-case",
    beforeRepoReservation: () => {
      renameSync(swapParent, swapParentAside);
      symlinkSync(redirectParent, swapParent);
    },
  }), "repo parent"), "plan 后被替换成 symlink 的 repo parent 在 reservation 前硬停");
  ok(!existsSync(join(redirectParent, "parent-swap"))
    && !Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "parent-swap"),
  "parent identity pin 阻止 scaffold 写入替代 physical 目录");
  unlinkSync(swapParent);
  renameSync(swapParentAside, swapParent);

  // 在 repo promotion 后注入故障：config/data/repo 都必须回到不可见、可重试状态。
  ok(throwsWith(() => commitOnboarding(tmp, input(), plan.planId, {
    uuid: () => "rollback-case",
    now: () => new Date("2026-08-10T08:00:00.000Z"),
    afterRepoPromoted: () => { throw new Error("fault after repo promotion"); },
  }), "fault after repo promotion"), "repo promotion 后故障向上传递");
  ok(!existsSync(join(tmp, "paper-moon")) && !existsSync(join(data, "paper-moon")), "config 发布前故障完整回滚 repo/data");
  ok(!readdirSync(tmp).some((name) => name.includes("writing-loop-onboard"))
    && !readdirSync(data).some((name) => name.includes("onboarding-paper-moon"))
    && !existsSync(`${configFile}.lock`), "回滚后无 staging 或配置锁残留");
  ok(!Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "paper-moon"), "失败项目从 snapshot 权威 config 中不可见");

  // 即使 promotion 后目标路径被外部替换，回滚也只能停住并保留证据，不能把未知目录
  // rename/delete 成“自己的 staging”。这是所有权标记存在的核心安全边界。
  const foreignInput = { ...input("foreign-guard"), ticketPrefix: "FG", title: "边界守卫" };
  const foreignPlan = planOnboarding(tmp, foreignInput);
  const foreignRepo = join(tmp, "foreign-guard");
  const ownedAside = join(tmp, "owned-foreign-aside");
  ok(throwsWith(() => commitOnboarding(tmp, foreignInput, foreignPlan.planId, {
    uuid: () => "foreign-guard-case",
    afterRepoPromoted: () => {
      renameSync(foreignRepo, ownedAside);
      mkdirSync(foreignRepo);
      writeFileSync(join(foreignRepo, "UNRELATED.txt"), "do not delete\n");
      throw new Error("foreign replacement");
    },
  }), "自动回滚未完成"), "目标被外部替换时拒绝把未知 repo 当作本事务回滚");
  ok(readFileSync(join(foreignRepo, "UNRELATED.txt"), "utf8") === "do not delete\n", "故障清理绝不删除或搬移现存无关 repo");

  // 真正让子进程在 repo+data promotion 后退出：catch/finally 都不会执行，留下 journal、
  // 所有权标记与 config lock。父进程随后必须只凭原 plan 恢复并完成可见性提交。
  const crashInput = { ...input("crash-moon"), ticketPrefix: "CR", title: "坠月" };
  const crashPlan = planOnboarding(tmp, crashInput);
  const crashScript = `
    import { commitOnboarding } from ${JSON.stringify(onboardingModule)};
    const raw = JSON.parse(process.env.WL_CRASH_INPUT);
    commitOnboarding(process.env.WL_CRASH_ROOT, raw, process.env.WL_CRASH_PLAN, {
      uuid: () => "real-crash-case",
      now: () => new Date("2026-08-10T08:30:00.000Z"),
      beforeConfigReplace: () => process.exit(86),
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", crashScript], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      WL_CRASH_ROOT: tmp,
      WL_CRASH_INPUT: JSON.stringify(crashInput),
      WL_CRASH_PLAN: crashPlan.planId,
    },
  });
  const crashRepo = join(tmp, "crash-moon");
  const crashData = join(data, "crash-moon");
  const crashJournal = join(data, ".onboarding-transactions", "crash-moon.json");
  ok(crashed.status === 86 && existsSync(crashRepo) && existsSync(crashData), "子进程在 repo/data 已 promotion 后模拟真实崩溃");
  ok(existsSync(crashJournal) && existsSync(`${configFile}.lock`)
    && !Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "crash-moon"), "崩溃前 config 仍是不可见提交，durable journal 与死锁保留");
  const crashJournalOriginal = `${crashJournal}.original`;
  const crashJournalBytes = readFileSync(crashJournal, "utf8");
  renameSync(crashJournal, crashJournalOriginal);
  linkSync(crashJournalOriginal, crashJournal);
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "单链接普通文件")
    && readFileSync(crashJournalOriginal, "utf8") === crashJournalBytes,
  "崩溃恢复 parser 与 doctor 一致拒绝 hardlink journal，且不修改链接目标");
  unlinkSync(crashJournal);
  renameSync(crashJournalOriginal, crashJournal);
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, "wlplan_wrong"), "不同输入或不同指纹"), "崩溃事务拒绝不同确认指纹接管");
  ok(throwsWith(() => commitOnboarding(tmp, { ...crashInput, title: "另一个项目" }, crashPlan.planId), "不同输入或不同指纹"), "崩溃事务拒绝不同输入借用 receipt");
  ok(existsSync(crashRepo) && existsSync(crashData) && existsSync(crashJournal), "错误恢复请求不清理或改写受管产物");

  const crashCounter = join(crashData, "board", "counter.json");
  const originalCounter = readFileSync(crashCounter, "utf8");
  writeFileSync(crashCounter, JSON.stringify({ prefix: "CR", next: 999 }, null, 2) + "\n");
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "内容摘要与 journal 不匹配"),
    "崩溃后运行态板被修改时拒绝把漂移数据发布进 config");
  ok(existsSync(crashRepo) && existsSync(crashData) && existsSync(crashJournal)
    && (JSON.parse(readFileSync(crashCounter, "utf8")) as { next?: number }).next === 999,
  "data 摘要失败保留 journal 与现场，绝不删除或偷偷修复操作者数据");
  writeFileSync(crashCounter, originalCounter);
  const unexpectedData = join(crashData, "UNEXPECTED.txt");
  writeFileSync(unexpectedData, "foreign data\n");
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "内容摘要与 journal 不匹配"),
    "崩溃后受管 data 被注入额外文件时拒绝恢复");
  rmSync(unexpectedData);
  const unexpectedLink = join(crashData, "foreign-link");
  symlinkSync(configFile, unexpectedLink);
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "不能包含符号链接"),
    "崩溃后的受管 data 出现 symlink 时在读取目标前硬拒绝");
  rmSync(unexpectedLink);
  const directoryFlood = join(crashData, "directory-flood");
  mkdirSync(directoryFlood);
  for (let index = 0; index <= 2_048; index++) mkdirSync(join(directoryFlood, `d-${String(index).padStart(4, "0")}`));
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "2048 entries"),
    "崩溃现场的空目录洪泛在逐项扫描预算内硬停，不一次性物化无界目录");
  rmSync(directoryFlood, { recursive: true });
  const deepRoot = join(crashData, "deep-tree");
  let deepCursor = deepRoot;
  for (let depth = 0; depth <= 65; depth++) {
    mkdirSync(deepCursor);
    deepCursor = join(deepCursor, "d");
  }
  ok(throwsWith(() => commitOnboarding(tmp, crashInput, crashPlan.planId), "目录深度超过"),
    "崩溃现场的深层目录在固定深度预算内硬停，不递归耗尽调用栈");
  rmSync(deepRoot, { recursive: true });

  // A 接管 crash journal 后因 data drift 可捕获失败，但保持长驻；lease 已释放时 ownerPid
  // 不能继续把 A 冒充为活动事务。B 修复证据后必须能在 A 仍存活时 exact retry。
  writeFileSync(crashCounter, JSON.stringify({ prefix: "CR", next: 777 }, null, 2) + "\n");
  const recoveryScript = `
    import { commitOnboarding } from ${JSON.stringify(onboardingModule)};
    const raw = JSON.parse(process.env.WL_CRASH_INPUT);
    let message = "";
    try { commitOnboarding(process.env.WL_CRASH_ROOT, raw, process.env.WL_CRASH_PLAN); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    process.send?.({ ready: message.includes("内容摘要与 journal 不匹配"), message });
    setInterval(() => {}, 1000);
  `;
  recoveryProcessA = spawn(process.execPath, ["--input-type=module", "--eval", recoveryScript], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      WL_CRASH_ROOT: tmp,
      WL_CRASH_INPUT: JSON.stringify(crashInput),
      WL_CRASH_PLAN: crashPlan.planId,
    },
  });
  const recoveryAReady = await new Promise<boolean>((resolveReady) => {
    const timer = setTimeout(() => resolveReady(false), 10_000);
    recoveryProcessA!.once("message", (message) => {
      clearTimeout(timer);
      resolveReady(Boolean(message && typeof message === "object" && "ready" in message && message.ready));
    });
    recoveryProcessA!.once("exit", () => { clearTimeout(timer); resolveReady(false); });
  });
  const ownerAfterCaughtRecovery = (JSON.parse(readFileSync(crashJournal, "utf8")) as { ownerPid?: number }).ownerPid;
  ok(recoveryAReady && recoveryProcessA.exitCode === null && ownerAfterCaughtRecovery !== recoveryProcessA.pid,
    "恢复进程 A 捕获硬停后释放 lease，并原子撤销自身 active owner 标记");
  writeFileSync(crashCounter, originalCounter);
  const recovered = commitOnboarding(tmp, crashInput, crashPlan.planId);
  const recoveredGit = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: crashRepo, encoding: "utf8" });
  ok(recovered.verification.ok && recovered.createdAt === "2026-08-10T08:30:00.000Z"
    && recoveryProcessA.exitCode === null, "进程 B 在 A 仍活时 exact retry，并保留原 receipt");
  recoveryProcessA.kill();
  await new Promise<void>((resolveExit) => {
    if (recoveryProcessA!.exitCode !== null) resolveExit();
    else recoveryProcessA!.once("exit", () => resolveExit());
  });
  recoveryProcessA = undefined;
  ok(recoveredGit.stdout.trim() === "1" && !existsSync(crashJournal) && !existsSync(`${configFile}.lock`), "恢复不重复 scaffold commit，并清理 journal/死锁");
  ok(!existsSync(join(crashRepo, ".git", "writing-loop-onboarding-owner.json"))
    && !existsSync(join(crashData, ".writing-loop-onboarding-owner.json")), "config 发布并 verify 后清理事务所有权标记");

  // config rename 是不可逆可见性边界。子进程在 rename 后、目录 fsync/lock finally/verify
  // 之前退出时，retry 必须保留已发布 repo+data，并证明后清理死锁、journal 与 markers。
  const visibleCrashInput = { ...input("visible-crash"), ticketPrefix: "VC", title: "可见崩溃" };
  const visibleCrashPlan = planOnboarding(tmp, visibleCrashInput);
  const visibleCrashScript = `
    import { commitOnboarding } from ${JSON.stringify(onboardingModule)};
    const raw = JSON.parse(process.env.WL_CRASH_INPUT);
    commitOnboarding(process.env.WL_CRASH_ROOT, raw, process.env.WL_CRASH_PLAN, {
      uuid: () => "visible-crash-case",
      now: () => new Date("2026-08-10T09:00:00.000Z"),
      afterConfigRenamed: () => process.exit(87),
    });
  `;
  const visibleCrashed = spawnSync(process.execPath, ["--input-type=module", "--eval", visibleCrashScript], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      WL_CRASH_ROOT: tmp,
      WL_CRASH_INPUT: JSON.stringify(visibleCrashInput),
      WL_CRASH_PLAN: visibleCrashPlan.planId,
    },
  });
  const visibleRepo = join(tmp, "visible-crash");
  const visibleData = join(data, "visible-crash");
  const visibleJournal = join(data, ".onboarding-transactions", "visible-crash.json");
  ok(visibleCrashed.status === 87 && Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "visible-crash")
    && existsSync(visibleRepo) && existsSync(visibleData), "config rename 后真实崩溃保留三处已发布 ground truth");
  ok(existsSync(visibleJournal) && existsSync(`${configFile}.lock`)
    && existsSync(join(visibleRepo, ".git", "writing-loop-onboarding-owner.json"))
    && existsSync(join(visibleData, ".writing-loop-onboarding-owner.json")), "可见性崩溃留下可证明的 journal/lock/markers");
  const visibleRecovered = commitOnboarding(tmp, visibleCrashInput, visibleCrashPlan.planId);
  ok(visibleRecovered.verification.ok && !existsSync(visibleJournal) && !existsSync(`${configFile}.lock`)
    && !existsSync(join(visibleRepo, ".git", "writing-loop-onboarding-owner.json"))
    && !existsSync(join(visibleData, ".writing-loop-onboarding-owner.json")),
  "exact retry 不回滚可见项目，并清理 post-config crash 恢复元数据");

  const syncFailInput = { ...input("sync-fail"), ticketPrefix: "SF", title: "目录持久化失败" };
  const syncFailPlan = planOnboarding(tmp, syncFailInput);
  const syncFailRepo = join(tmp, "sync-fail");
  const syncFailData = join(data, "sync-fail");
  const syncFailJournal = join(data, ".onboarding-transactions", "sync-fail.json");
  ok(throwsWith(() => commitOnboarding(tmp, syncFailInput, syncFailPlan.planId, {
    uuid: () => "sync-fail-case",
    syncConfigDirectory: () => { throw new Error("injected config directory fsync failure"); },
  }), "injected config directory fsync failure")
    && Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "sync-fail")
    && existsSync(syncFailRepo) && existsSync(syncFailData) && existsSync(syncFailJournal)
    && existsSync(join(syncFailRepo, ".git", "writing-loop-onboarding-owner.json"))
    && existsSync(join(syncFailData, ".writing-loop-onboarding-owner.json")),
  "config rename 后目录 fsync 失败会上抛且不宣称成功、不回滚或清理恢复证据");
  const syncFailRecovered = commitOnboarding(tmp, syncFailInput, syncFailPlan.planId);
  ok(syncFailRecovered.verification.ok && !existsSync(syncFailJournal)
    && !existsSync(join(syncFailRepo, ".git", "writing-loop-onboarding-owner.json"))
    && !existsSync(join(syncFailData, ".writing-loop-onboarding-owner.json")),
  "目录 fsync 失败后的 exact retry 回读已可见三处真相并安全完成清理");

  const reservedCrashScript = `
    import { commitOnboarding } from ${JSON.stringify(onboardingModule)};
    const raw = JSON.parse(process.env.WL_CRASH_INPUT);
    const hook = process.env.WL_RESERVED_HOOK;
    const runtime = {
      uuid: () => process.env.WL_RESERVED_UUID,
      now: () => new Date("2026-08-10T09:05:00.000Z"),
      [hook]: () => process.exit(Number(process.env.WL_RESERVED_EXIT)),
    };
    commitOnboarding(process.env.WL_CRASH_ROOT, raw, process.env.WL_CRASH_PLAN, runtime);
  `;
  const crashAtReservation = (
    raw: Record<string, unknown>, planId: string, hook: "afterRepoReserved" | "afterDataReserved", code: number,
  ) => spawnSync(process.execPath, ["--input-type=module", "--eval", reservedCrashScript], {
    cwd: join(import.meta.dirname, ".."), encoding: "utf8",
    env: {
      ...process.env,
      WL_CRASH_ROOT: tmp,
      WL_CRASH_INPUT: JSON.stringify(raw),
      WL_CRASH_PLAN: planId,
      WL_RESERVED_HOOK: hook,
      WL_RESERVED_UUID: `${hook}-case`,
      WL_RESERVED_EXIT: String(code),
    },
  });

  const repoReservedInput = { ...input("repo-reserved"), ticketPrefix: "RR", title: "仓库保留态" };
  const repoReservedPlan = planOnboarding(tmp, repoReservedInput);
  const repoReservedCrash = crashAtReservation(repoReservedInput, repoReservedPlan.planId, "afterRepoReserved", 88);
  const repoReservedPath = join(tmp, "repo-reserved");
  ok(repoReservedCrash.status === 88 && existsSync(join(repoReservedPath, ".writing-loop-onboarding-owner.json"))
    && !existsSync(join(repoReservedPath, "README.md")), "SIGKILL-equivalent repo reservation crash 留下 durable owner marker 而非假完整 repo");
  const repoForeign = join(repoReservedPath, "OPERATOR-NOTE.txt");
  writeFileSync(repoForeign, "manual evidence — preserve\n");
  ok(throwsWith(() => commitOnboarding(tmp, repoReservedInput, repoReservedPlan.planId), "保留现场拒绝自动删除或重建")
    && readFileSync(repoForeign, "utf8") === "manual evidence — preserve\n"
    && existsSync(join(data, ".onboarding-transactions", "repo-reserved.json"))
    && !Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "repo-reserved"),
  "commit 摘要前崩溃的 repo 与随后人工文件逐字节保留，exact retry 硬停而不递归清理");

  const dataReservedInput = { ...input("data-reserved"), ticketPrefix: "DR", title: "数据保留态" };
  const dataReservedPlan = planOnboarding(tmp, dataReservedInput);
  const dataReservedCrash = crashAtReservation(dataReservedInput, dataReservedPlan.planId, "afterDataReserved", 89);
  const dataReservedPath = join(data, "data-reserved");
  ok(dataReservedCrash.status === 89 && existsSync(join(dataReservedPath, ".writing-loop-onboarding-owner.json"))
    && !existsSync(join(dataReservedPath, "state", "onboarding.json")), "SIGKILL-equivalent data reservation crash 留下可证明 partial data");
  const dataForeign = join(dataReservedPath, "OPERATOR-NOTE.txt");
  writeFileSync(dataForeign, "manual data evidence — preserve\n");
  ok(throwsWith(() => commitOnboarding(tmp, dataReservedInput, dataReservedPlan.planId), "保留现场拒绝自动删除或重建")
    && readFileSync(dataForeign, "utf8") === "manual data evidence — preserve\n"
    && existsSync(join(data, ".onboarding-transactions", "data-reserved.json"))
    && !Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "data-reserved"),
  "data 摘要前崩溃的运行态与随后人工文件逐字节保留，exact retry 硬停而不递归清理");

  // workspace 内的 parent symlink 必须在 plan 时规范化成同一个 physical final/config 路径，
  // 避免发布成功后 receipt 与 config 因 lexical/physical 分叉而自相矛盾。
  const physicalParent = join(tmp, "canonical-stories");
  const linkedParent = join(tmp, "stories-link");
  mkdirSync(physicalParent);
  symlinkSync(physicalParent, linkedParent);
  const linkedInput = { ...input("linked-story", "stories-link/linked-story"), ticketPrefix: "LS", title: "链接故事" };
  const linkedPlan = planOnboarding(tmp, linkedInput);
  ok(linkedPlan.repoPath === join(physicalParent, "linked-story")
    && linkedPlan.projectConfig.repoPath === "canonical-stories/linked-story", "plan 统一 workspace 内 symlink parent 的 physical identity");
  const linkedResult = commitOnboarding(tmp, linkedInput, linkedPlan.planId);
  ok(linkedResult.verification.ok && verifyOnboarding(tmp, "linked-story").ok,
    "canonical repoPath 在 config/receipt/verify 三处保持一致");

  // 两个恢复者同时 pin 同一个 dead lease inode 后放行：其中一个可接管，另一个即使在
  // lstat→删除窗口看见 successor，也只能 quarantine+复核+还原，绝不能删掉新锁。
  const leaseRaceInput = { ...input("lease-race"), ticketPrefix: "LR", title: "租约竞态" };
  const leaseRacePlan = planOnboarding(tmp, leaseRaceInput);
  const txDir = join(data, ".onboarding-transactions");
  mkdirSync(txDir, { recursive: true });
  const staleLease = join(txDir, "lease-race.lock");
  writeFileSync(staleLease, JSON.stringify({ pid: 999_999_999, acquiredAt: "2020-01-01T00:00:00.000Z" }) + "\n");
  const raceGo = join(tmp, "lease-race.go");
  const raceReadyA = join(tmp, "lease-race-a.ready");
  const raceReadyB = join(tmp, "lease-race-b.ready");
  const raceResultA = join(tmp, "lease-race-a.result.json");
  const raceResultB = join(tmp, "lease-race-b.result.json");
  const leaseRaceScript = `
    import { existsSync, writeFileSync } from "node:fs";
    import { commitOnboarding } from ${JSON.stringify(onboardingModule)};
    const raw = JSON.parse(process.env.WL_RACE_INPUT);
    let result;
    try {
      const committed = commitOnboarding(process.env.WL_RACE_ROOT, raw, process.env.WL_RACE_PLAN, {
        uuid: () => process.env.WL_RACE_UUID,
        afterStaleLeaseRead: () => {
          writeFileSync(process.env.WL_RACE_READY, "ready\\n");
          const deadline = Date.now() + 10_000;
          const cell = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(process.env.WL_RACE_GO)) {
            if (Date.now() > deadline) throw new Error("lease race barrier timeout");
            Atomics.wait(cell, 0, 0, 10);
          }
        },
      });
      result = { ok: true, planId: committed.planId };
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    writeFileSync(process.env.WL_RACE_RESULT, JSON.stringify(result));
  `;
  const spawnRace = (name: "a" | "b", ready: string, resultFile: string): ChildProcess => spawn(
    process.execPath, ["--input-type=module", "--eval", leaseRaceScript], {
      cwd: join(import.meta.dirname, ".."), stdio: "ignore",
      env: {
        ...process.env,
        WL_RACE_ROOT: tmp,
        WL_RACE_INPUT: JSON.stringify(leaseRaceInput),
        WL_RACE_PLAN: leaseRacePlan.planId,
        WL_RACE_UUID: `lease-race-${name}`,
        WL_RACE_READY: ready,
        WL_RACE_GO: raceGo,
        WL_RACE_RESULT: resultFile,
      },
    },
  );
  const raceA = spawnRace("a", raceReadyA, raceResultA);
  const raceB = spawnRace("b", raceReadyB, raceResultB);
  const bothPinned = await waitUntil(() => existsSync(raceReadyA) && existsSync(raceReadyB));
  writeFileSync(raceGo, "go\n");
  await Promise.all([raceA, raceB].map((child) => new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))));
  const raceResults = [raceResultA, raceResultB].map((file) => JSON.parse(readFileSync(file, "utf8")) as { ok?: boolean; message?: string });
  ok(bothPinned && raceResults.filter((row) => row.ok).length === 1,
    "两个恢复者同时 pin dead inode 时恰有一个取得 successor lease");
  ok(Object.prototype.hasOwnProperty.call(loadConfig(tmp).config.projects ?? {}, "lease-race")
    && !existsSync(staleLease) && !existsSync(join(txDir, "lease-race.json"))
    && !readdirSync(txDir).some((name) => name.includes("lease-race.lock.unlink-")),
  "失败恢复者不删除 successor，成功者完成发布并清理 lease/journal/quarantine");

  // crash-moon 的成功恢复合法改变了 config，因此 paper-moon 需重新预览并确认新指纹。
  plan = planOnboarding(tmp, input());
  const result = commitOnboarding(tmp, input(), plan.planId, {
    uuid: () => "success-case",
    now: () => new Date("2026-08-10T09:30:00.000Z"),
  });
  ok(result.verification.ok && verifyOnboarding(tmp, "paper-moon").ok, "commit 后独立 verify 三处 ground truth");
  const config = JSON.parse(readFileSync(configFile, "utf8")) as {
    version: number; futureTopLevel?: { preserve?: boolean };
    projects: Record<string, { title?: string; repoPath?: string; enabled?: boolean }>;
  };
  ok(config.version === 17 && config.futureTopLevel?.preserve === true, "立项 lossless 保留 config 顶层未知字段");
  ok(config.projects["paper-moon"]?.repoPath === "paper-moon" && config.projects["paper-moon"]?.enabled === true, "config 最后发布完整项目条目");
  const repo = join(tmp, "paper-moon");
  const northStar = readFileSync(join(repo, "bible", "north-star.md"), "utf8");
  const production = readFileSync(join(repo, "ledgers", "production.md"), "utf8");
  ok(northStar.includes("她写下的每一场戏") && northStar.includes("女性 25-40 岁") && northStar.includes("合规预筛"), "north-star 落入采访决定而非占位猜测");
  ok(production.includes("主场景 ≤5") && production.includes("具名角色 ≤20") && production.includes("format：live-action"), "production ledger 初始化制作预算");
  ok(["arcs", "episodes", "evaluation", "ledgers/archive"].every((dir) => existsSync(join(repo, ...dir.split("/"), ".gitkeep"))), "空创作目录进入 Git scaffold");
  const git = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" });
  ok(git.status === 0 && git.stdout.trim().split("\n").length === 1 && git.stdout.includes("立项 paper-moon"), "新 repo 只有一个可验证 scaffold commit");
  const ticket = readFileSync(join(data, "paper-moon", "board", "tickets", "PM-1.md"), "utf8");
  ok(ticket.includes("state: Todo") && ticket.includes("owner: showrunner") && ticket.includes("story-designer")
    && ticket.includes("## Context-pack") && ticket.includes("## Acceptance criteria") && ticket.includes("## How to verify"), "首张且唯一大纲票满足门禁协议");
  ok((JSON.parse(readFileSync(join(data, "paper-moon", "board", "counter.json"), "utf8")) as { next?: number }).next === 2, "counter hint 推进到下一 ID");
  ok(readdirSync(join(data, "paper-moon", "board", "tickets")).length === 1, "立项恒只创建一张首票");
  const snapshot = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-10T10:00:00.000Z"));
  ok(snapshot.projects.some((project) => project.key === "paper-moon" && project.board.tickets[0]?.malformed === false), "config 发布后统一 read model 一次读到完整非畸形项目");

  // verify 以 receipt 为三处 ground truth 的锚：缺失/篡改、config identity 漂移、非祖先
  // HEAD 与原 outline ticket 丢失都必须失败，不能仅凭“有几个同名文件”误报成功。
  const receiptFile = join(data, "paper-moon", "state", "onboarding.json");
  const receiptRaw = readFileSync(receiptFile, "utf8");
  const paperData = join(data, "paper-moon");
  const paperDataAside = join(tmp, "paper-moon-data-aside");
  renameSync(paperData, paperDataAside);
  symlinkSync(paperDataAside, paperData);
  ok(!verifyOnboarding(tmp, "paper-moon").ok
    && throwsWith(() => commitOnboarding(tmp, input(), plan.planId), "项目 data 根"),
  "project data 根被换成 symlink 时 verify/retry 在读取 receipt 前硬停");
  unlinkSync(paperData);
  renameSync(paperDataAside, paperData);
  rmSync(receiptFile);
  ok(!verifyOnboarding(tmp, "paper-moon").ok
    && throwsWith(() => commitOnboarding(tmp, input(), plan.planId), "项目 key 'paper-moon' 已存在"), "receipt 缺失时 verify 与 same-plan retry 都硬失败");
  symlinkSync(configFile, receiptFile);
  ok(!verifyOnboarding(tmp, "paper-moon").ok, "receipt symlink 不会被当作可信立项凭据读取");
  rmSync(receiptFile);
  writeFileSync(receiptFile, receiptRaw);
  writeFileSync(receiptFile, receiptRaw.trimEnd() + " ".repeat(300 * 1024));
  ok(!verifyOnboarding(tmp, "paper-moon").ok
    && throwsWith(() => commitOnboarding(tmp, input(), plan.planId), "读取预算"),
  "receipt JSON 即使语法有效也不能越过固定读取预算");
  writeFileSync(receiptFile, receiptRaw);
  const tamperedReceipt = JSON.parse(receiptRaw) as Record<string, unknown>;
  tamperedReceipt.key = "other-project";
  writeFileSync(receiptFile, JSON.stringify(tamperedReceipt, null, 2) + "\n");
  ok(!verifyOnboarding(tmp, "paper-moon").ok, "receipt invariant identity 被篡改时 verify 失败");
  writeFileSync(receiptFile, receiptRaw);

  const configBeforeDrift = readFileSync(configFile, "utf8");
  const driftedConfig = JSON.parse(configBeforeDrift) as { projects: Record<string, Record<string, unknown>> };
  driftedConfig.projects["paper-moon"].repoPath = "somewhere-else";
  writeFileSync(configFile, JSON.stringify(driftedConfig, null, "\t") + "\n");
  ok(!verifyOnboarding(tmp, "paper-moon").ok
    && throwsWith(() => commitOnboarding(tmp, input(), plan.planId), "ground truth 不完整"), "config repoPath 与 receipt 冲突时拒绝幂等成功");
  writeFileSync(configFile, configBeforeDrift);

  const originalHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const originalTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const unrelatedCommit = spawnSync("git", [
    "-c", "user.name=writing-loop", "-c", "user.email=writing-loop@local",
    "commit-tree", originalTree, "-m", "unrelated root",
  ], { cwd: repo, encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["update-ref", "HEAD", unrelatedCommit], { cwd: repo, encoding: "utf8" });
  ok(!verifyOnboarding(tmp, "paper-moon").ok, "receipt scaffold commit 不是当前 HEAD 祖先时 verify 失败");
  spawnSync("git", ["update-ref", "HEAD", originalHead], { cwd: repo, encoding: "utf8" });

  const outlineFile = join(data, "paper-moon", "board", "tickets", "PM-1.md");
  const outlineRaw = readFileSync(outlineFile, "utf8");
  renameSync(outlineFile, `${outlineFile}.bak`);
  ok(!verifyOnboarding(tmp, "paper-moon").ok, "receipt 指定的原 outline ticket 缺失时 verify 失败");
  renameSync(`${outlineFile}.bak`, outlineFile);
  writeFileSync(outlineFile, outlineRaw.replace(/^id: PM-1$/m, "id: PM-999"));
  ok(!verifyOnboarding(tmp, "paper-moon").ok, "同文件中的 outline ticket identity 被替换时 verify 失败");
  writeFileSync(outlineFile, outlineRaw);
  writeFileSync(outlineFile, outlineRaw + "\n" + "x".repeat(2 * 1024 * 1024));
  ok(verifyOnboarding(tmp, "paper-moon").ok, "超大 outline ticket 只读有界 frontmatter head，仍允许合法评论历史增长");
  writeFileSync(outlineFile, outlineRaw);

  // 合法项目演进不破坏 receipt identity：启停/airedThrough、额外票、首票转态与后续 commit
  // 都应允许；客户端成功响应丢失后仍只幂等回读，不重建 scaffold 或票。
  writeFileSync(outlineFile, outlineRaw.replace(/^state: Todo$/m, "state: In Progress"));
  writeFileSync(join(data, "paper-moon", "board", "tickets", "PM-2.md"), `---
id: PM-2
title: "后续工作"
type: Task
state: Todo
owner: showrunner
assignee: null
labels: [writing-loop]
priority: 2
updated: 2026-08-10T10:10:00.000Z
---
`);
  writeFileSync(join(repo, "README.md"), readFileSync(join(repo, "README.md"), "utf8") + "\n项目进入正常演进。\n");
  spawnSync("git", ["add", "README.md"], { cwd: repo, encoding: "utf8" });
  spawnSync("git", [
    "-c", "user.name=writing-loop", "-c", "user.email=writing-loop@local",
    "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "docs: advance project",
  ], { cwd: repo, encoding: "utf8" });
  setProjectEnabled(tmp, "paper-moon", false);
  const evolvedConfig = JSON.parse(readFileSync(configFile, "utf8")) as { projects: Record<string, Record<string, unknown>> };
  evolvedConfig.projects["paper-moon"].airedThrough = 3;
  writeFileSync(configFile, JSON.stringify(evolvedConfig, null, "\t") + "\n");
  const commitsBeforeRetry = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const ticketsBeforeRetry = readdirSync(join(data, "paper-moon", "board", "tickets")).length;
  const retry = commitOnboarding(tmp, input(), plan.planId);
  const gitRetry = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" });
  ok(retry.commit === result.commit && retry.createdAt === result.createdAt && retry.verification.ok, "合法进展后相同 plan 重试仍返回原 receipt");
  ok(gitRetry.stdout.trim() === commitsBeforeRetry
    && readdirSync(join(data, "paper-moon", "board", "tickets")).length === ticketsBeforeRetry, "幂等重试不重复 commit 或建票");

  // config 在预览后发生无关变化，旧确认也必须失效，而不是覆盖新字段。
  const staleInput = input("stale-plan");
  const stalePlan = planOnboarding(tmp, staleInput);
  const changed = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  changed.concurrentWriter = { arrived: true };
  writeFileSync(configFile, JSON.stringify(changed, null, "\t") + "\n");
  ok(throwsWith(() => commitOnboarding(tmp, staleInput, stalePlan.planId), "确认指纹不匹配"), "config 变化使旧 plan 确认失效");
  ok(!existsSync(join(tmp, "stale-plan")) && !existsSync(join(data, "stale-plan")), "陈旧 plan 不留下半项目");
} finally {
  if (recoveryProcessA?.exitCode === null) recoveryProcessA.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nONBOARDING_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
