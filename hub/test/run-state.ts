// scheduler 实时状态回归：运行中可看见 inFlight，结束后保持 stopped 快照；atomic rename
// 让高频读取永远只看到完整 JSON。
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock, heartbeatLock, releaseLock, writeRunStateAtomic, type RunState,
} from "../src/scheduler.ts";
import { setProjectEnabled } from "../src/workspace-store.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");
const agents = ["showrunner", "story-designer", "episode-writer", "reviewer", "evaluator", "sweep", "script-doctor", "market-watch", "reflect"];

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-run-state-")));
let child: ChildProcess | null = null;
try {
  mkdirSync(join(tmp, ".writing-loop"), { recursive: true });
  mkdirSync(join(tmp, "story"), { recursive: true });

  // 旧实现固定写 `<run-state>.<pid>.tmp` 且 O_TRUNC，会跟随预植 symlink 截断 victim。
  // 新实现必须完全不碰旧可预测名字，只清理自己 O_EXCL 创建的随机 inode。
  const atomicDir = join(tmp, "atomic-state");
  mkdirSync(atomicDir);
  const atomicState = join(atomicDir, "run-state.json");
  const victim = join(atomicDir, "victim.txt");
  const victimBytes = "DO-NOT-TRUNCATE\n";
  writeFileSync(victim, victimBytes);
  const legacyPredictableTmp = `${atomicState}.${process.pid}.tmp`;
  symlinkSync(victim, legacyPredictableTmp);
  const atomicFixture: RunState = {
    version: 1, project: "atomic", pid: process.pid, status: "running", cli: "claude",
    selectedAgents: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), inFlight: [],
  };
  ok(writeRunStateAtomic(atomicState, atomicFixture), "run-state 通过随机 O_EXCL 临时 inode 原子发布");
  ok(readFileSync(victim, "utf8") === victimBytes && existsSync(legacyPredictableTmp),
    "预植旧可预测 tmp symlink 不被跟随，victim 逐字节不变");
  ok(JSON.parse(readFileSync(atomicState, "utf8")).project === "atomic"
    && !readdirSync(atomicDir).some((name) => name.includes(".snapshot-") && name.endsWith(".tmp")),
  "发布后没有本次随机 snapshot 临时文件残留");

  // ownership handle 的底层竞态回归：missing 不补建；replacement 不 touch、不删除。
  const lockProbe = join(tmp, "ownership-probe.lock");
  const missingOwner = acquireLock(lockProbe);
  ok(missingOwner !== null, "锁探针可取得 dev/ino/token ownership");
  rmSync(lockProbe);
  ok(missingOwner !== null && !heartbeatLock(missingOwner) && !existsSync(lockProbe),
    "锁 missing 后 heartbeat 报失锁且绝不重建路径");
  ok(missingOwner !== null && !releaseLock(missingOwner) && !existsSync(lockProbe),
    "锁 missing 后 release 幂等拒绝且绝不重建路径");

  const replacedOwner = acquireLock(lockProbe);
  ok(replacedOwner !== null, "replacement 探针取得 ownership");
  rmSync(lockProbe);
  const successorBytes = "holder pid=999999 at 2026-08-09T00:00:00Z\n";
  writeFileSync(lockProbe, successorBytes);
  const fixedSuccessorTime = new Date("2020-01-02T03:04:05.000Z");
  utimesSync(lockProbe, fixedSuccessorTime, fixedSuccessorTime);
  const successorMtimeMs = statSync(lockProbe).mtimeMs;
  ok(replacedOwner !== null && !heartbeatLock(replacedOwner)
    && readFileSync(lockProbe, "utf8") === successorBytes
    && statSync(lockProbe).mtimeMs === successorMtimeMs,
  "锁被替换后 heartbeat 不 touch successor");
  ok(replacedOwner !== null && !releaseLock(replacedOwner)
    && readFileSync(lockProbe, "utf8") === successorBytes,
  "锁被替换后 release 不删除 successor");
  rmSync(lockProbe);

  const fake = join(tmp, "fake-agent.mjs");
  writeFileSync(fake, "await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2] ?? 900)));\nconsole.log('fake agent complete');\n");
  const fakeTree = join(tmp, "fake-agent-tree.mjs");
  writeFileSync(fakeTree, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
if (process.argv[2] === "helper") {
  writeFileSync(process.argv[3], String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [process.argv[1], "helper", process.argv[3]], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
`);
  const agentConfig: Record<string, unknown> = {};
  for (const agent of agents) agentConfig[agent] = { enabled: false };
  agentConfig.showrunner = {
    enabled: true,
    intervalSeconds: 60,
    staggerSeconds: 0,
    capSeconds: 10,
    model: "sonnet",
    effort: "high",
    command: [process.execPath, fake, "900"],
  };
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, agents: agentConfig },
    projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
  }, null, 2));

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  child = spawn(process.execPath, [runEntry, "--project", "story", "--once", "--agents", "showrunner"], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const stateFile = join(tmp, ".writing-loop", "story", "run-state.json");
  let live: RunState | null = null;
  let validReads = 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !live) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
      validReads++;
      if (parsed.status === "running" && parsed.inFlight.length === 1) live = parsed;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "ENOENT") throw error;
    }
    await sleep(20);
  }
  ok(live !== null, `agent 执行期间出现 running/inFlight 状态${live ? "" : `（输出 ${output.slice(-300)}）`}`);
  ok(live?.project === "story" && live.pid === child.pid && live.cli === "claude", "run-state 标识项目、scheduler PID 与引擎");
  ok(live?.inFlight[0]?.agent === "showrunner" && typeof live.inFlight[0]?.pid === "number", "inFlight 标识 agent 与真实子进程 PID");
  ok(live?.inFlight[0]?.model === "sonnet" && live.inFlight[0]?.effort === "high" && live.inFlight[0]?.logFile.endsWith("showrunner.log") === true, "inFlight 暴露模型档位与相对日志路径");
  ok(validReads > 0, "运行中状态文件可反复解析");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scheduler 10s 内未退出")), 10_000);
    child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child = null;
  const stopped = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
  ok(exitCode === 0, `scheduler 干净退出（实得 ${exitCode}）`);
  ok(stopped.status === "stopped" && stopped.inFlight.length === 0, "结束快照为 stopped 且清空 inFlight");
  ok(typeof stopped.endedAt === "string" && Date.parse(stopped.endedAt) >= Date.parse(stopped.startedAt), "结束快照含合法 endedAt");
  ok(!readFileSync(stateFile, "utf8").includes(".tmp"), "最终状态是完整 JSON 文档");

  // Studio/CLI 的“暂停”必须作用于已经运行的 scheduler，而不只是下次启动：运行进程
  // 周期复核 enabled，发现 false 后停止派发并走同一 graceful drain。
  agentConfig.showrunner = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
    model: "sonnet", effort: "high", command: [process.execPath, fake, "5000"],
  };
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, graceSeconds: 1, agents: agentConfig },
    projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
  }, null, 2));
  child = spawn(process.execPath, [runEntry, "--project", "story", "--for", "10", "--agents", "showrunner"], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pauseOutput = "";
  child.stdout?.on("data", (chunk) => { pauseOutput += String(chunk); });
  child.stderr?.on("data", (chunk) => { pauseOutput += String(chunk); });
  const pauseReadyDeadline = Date.now() + 5_000;
  let pauseReady = false;
  while (Date.now() < pauseReadyDeadline && !pauseReady) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
      pauseReady = state.pid === child.pid && state.inFlight.some((fire) => fire.agent === "showrunner");
    } catch { /* 等新进程首帧 */ }
    await sleep(20);
  }
  setProjectEnabled(tmp, "story", false);
  const pauseExit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("enabled:false 后 scheduler 8s 内未收尾")), 8_000);
    child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child = null;
  const pausedState = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
  ok(pauseReady && pauseExit === 0, "运行中的项目被暂停后 scheduler 会干净退出");
  ok(pauseOutput.includes("enabled:false/已移除") && pausedState.status === "stopped", "暂停会停止继续派发并经过 stopping→stopped 收尾");
  setProjectEnabled(tmp, "story", true);

  // 主循环必须消费 ownership 检查结果：锁 missing/replaced 都停止新派发、drain 当前 fire、
  // 非零退出。replacement successor 是另一持有者的证据，finally 也绝不能删它。
  const runLockLoss = async (kind: "missing" | "replaced"): Promise<void> => {
    agentConfig.showrunner = {
      enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
      model: "sonnet", effort: "high", command: [process.execPath, fake, "5000"],
    };
    writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
      version: 1,
      scheduler: { cli: "claude", laneGating: false, graceSeconds: 0, agents: agentConfig },
      projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
    }, null, 2));
    child = spawn(process.execPath, [runEntry, "--project", "story", "--for", "20", "--agents", "showrunner"], {
      cwd: tmp,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lossOutput = "";
    child.stdout?.on("data", (chunk) => { lossOutput += String(chunk); });
    child.stderr?.on("data", (chunk) => { lossOutput += String(chunk); });
    const lock = join(tmp, ".writing-loop", "story", "wl-run.lock");
    let lossReady = false;
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline && !lossReady) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
        lossReady = state.pid === child.pid && state.inFlight.some((fire) => fire.agent === "showrunner")
          && existsSync(lock);
      } catch { /* 等 ownership 与首个 fire 同时可见 */ }
      await sleep(20);
    }
    if (lossReady) {
      rmSync(lock);
      if (kind === "replaced") writeFileSync(lock, successorBytes);
    }
    const lossExit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} 失锁后 scheduler 8s 内未退出`)), 8_000);
      child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
      child!.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child = null;
    const lossState = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
    ok(lossReady && lossExit !== 0 && lossOutput.includes("项目锁所有权已丢失"),
      `${kind} 会触发失锁 drain 并非零退出`);
    ok(lossState.status === "stopped" && lossState.inFlight.length === 0,
      `${kind} 失锁仍先 drain 完整个进程组再发布 stopped`);
    if (kind === "replaced") {
      ok(readFileSync(lock, "utf8") === successorBytes, "replacement successor 在 scheduler finally 后仍逐字节保留");
      rmSync(lock);
    } else {
      ok(!existsSync(lock), "missing 锁在 scheduler finally/heartbeat 后仍不存在（绝不补建）");
    }
  };
  await runLockLoss("missing");
  await runLockLoss("replaced");

  // --for 与 signal 共用同一不可逆 draining 状态。较短 fire 收账时，仍在运行的另一个
  // fire 不能把 run-state 从 stopping 错写回 running。
  agentConfig.showrunner = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
    model: "sonnet", effort: "high", command: [process.execPath, fake, "1400"],
  };
  agentConfig.reviewer = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
    model: "sonnet", effort: "high", command: [process.execPath, fake, "2400"],
  };
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, graceSeconds: 5, agents: agentConfig },
    projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
  }, null, 2));
  child = spawn(process.execPath, [runEntry, "--project", "story", "--for", "1", "--agents", "showrunner,reviewer"], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let drainOutput = "";
  child.stdout?.on("data", (chunk) => { drainOutput += String(chunk); });
  child.stderr?.on("data", (chunk) => { drainOutput += String(chunk); });
  const transitions: string[] = [];
  const drainDeadline = Date.now() + 8_000;
  while (Date.now() < drainDeadline && child.exitCode === null) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
      if (state.pid === child.pid) {
        const transition = `${state.status}:${state.inFlight.map((fire) => fire.agent).sort().join(",")}`;
        if (transitions.at(-1) !== transition) transitions.push(transition);
      }
    } catch { /* atomic replace/read race only permits an absent first frame */ }
    await sleep(25);
  }
  const drainExit = child.exitCode ?? await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("--for scheduler 3s 内未退出")), 3_000);
    child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child = null;
  const firstStopping = transitions.findIndex((value) => value.startsWith("stopping:"));
  const runningAfterStopping = firstStopping >= 0 && transitions.slice(firstStopping + 1).some((value) => value.startsWith("running:"));
  ok(drainExit === 0, `--for 双 agent 调度器干净退出${drainExit === 0 ? "" : `（${drainOutput.slice(-300)}）`}`);
  ok(transitions.some((value) => value === "stopping:reviewer"), `较短 fire 收账后仍保持 stopping（观测 ${transitions.join(" → ")}）`);
  ok(firstStopping >= 0 && !runningAfterStopping, "run-state 进入 stopping 后单调前进，不回跳 running");

  // 正常 cap 路径也必须等整个 PGID 消失：leader 收 TERM 退出后，忽略 TERM 的 helper
  // 仍须在 deadline 被 KILL；不能仅因 exit event 就 finish/splice 并释放项目锁。
  const capHelperPidFile = join(tmp, "cap-tree-helper.pid");
  agentConfig.showrunner = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 1,
    model: "sonnet", effort: "high", command: [process.execPath, fakeTree, "leader", capHelperPidFile],
  };
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, agents: agentConfig },
    projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
  }, null, 2));
  child = spawn(process.execPath, [runEntry, "--project", "story", "--once", "--agents", "showrunner"], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let capOutput = "";
  child.stdout?.on("data", (chunk) => { capOutput += String(chunk); });
  child.stderr?.on("data", (chunk) => { capOutput += String(chunk); });
  let capHelperPid: number | null = null;
  const capMarkerDeadline = Date.now() + 5_000;
  while (Date.now() < capMarkerDeadline && capHelperPid === null) {
    try { capHelperPid = Number(readFileSync(capHelperPidFile, "utf8")); } catch { /* 等 helper */ }
    await sleep(20);
  }
  const capExit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PGID cap scheduler 10s 内未退出")), 10_000);
    child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child = null;
  let capHelperAlive = capHelperPid !== null;
  if (capHelperPid !== null) {
    try { process.kill(capHelperPid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") capHelperAlive = false;
    }
  }
  const capState = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
  const capRows = readFileSync(join(tmp, ".writing-loop", "story", "fires.jsonl"), "utf8").trim().split("\n");
  const capRow = JSON.parse(capRows.at(-1) ?? "{}") as { timedOut?: boolean; descendantDrain?: boolean };
  ok(capExit === 0 && capOutput.includes("同进程组仍有 descendant"), "正常 poll 在 leader 退出后继续追踪同 PGID descendant");
  ok(capHelperPid !== null && !capHelperAlive, "cap TERM 后忽略信号的 descendant 会在 deadline 被 KILL");
  ok(capState.status === "stopped" && capState.inFlight.length === 0 && !existsSync(join(tmp, ".writing-loop", "story", "wl-run.lock")), "进程组归零后才结算 stopped 并释放锁");
  ok(capRow.timedOut === true && capRow.descendantDrain === true, "遥测记录 cap 与额外 descendant drain，不能误算 clean fire");

  // 故障注入：把 fires.jsonl 变成目录，使首个 fire 收账抛 EISDIR；另一 detached agent
  // 仍在长跑。scheduler 必须先杀并 reap 它，再写 stopped/释放项目锁。
  const projectState = join(tmp, ".writing-loop", "story");
  rmSync(join(projectState, "fires.jsonl"), { force: true });
  mkdirSync(join(projectState, "fires.jsonl"));
  agentConfig.showrunner = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
    model: "sonnet", effort: "high", command: [process.execPath, fake, "500"],
  };
  agentConfig.reviewer = {
    enabled: true, intervalSeconds: 60, staggerSeconds: 0, capSeconds: 10,
    model: "sonnet", effort: "high", command: [process.execPath, fakeTree, "leader", join(tmp, "tree-helper.pid")],
  };
  writeFileSync(join(tmp, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, graceSeconds: 5, agents: agentConfig },
    projects: { story: { title: "状态测试", repoPath: "story", enabled: true } },
  }, null, 2));
  child = spawn(process.execPath, [runEntry, "--project", "story", "--once", "--agents", "showrunner,reviewer"], {
    cwd: tmp,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let faultOutput = "";
  child.stdout?.on("data", (chunk) => { faultOutput += String(chunk); });
  child.stderr?.on("data", (chunk) => { faultOutput += String(chunk); });
  const helperPidFile = join(tmp, "tree-helper.pid");
  let helperPid: number | null = null;
  const faultDeadline = Date.now() + 5_000;
  while (Date.now() < faultDeadline && helperPid === null) {
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
      if (state.pid === child.pid && state.inFlight.some((fire) => fire.agent === "reviewer")) {
        helperPid = Number(readFileSync(helperPidFile, "utf8"));
      }
    } catch { /* 等首个原子快照 */ }
    await sleep(20);
  }
  const faultExit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("故障注入 scheduler 10s 内未退出")), 10_000);
    child!.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child!.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  child = null;
  const faultState = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
  let orphanAlive = helperPid !== null;
  if (helperPid !== null) {
    try { process.kill(helperPid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") orphanAlive = false;
    }
  }
  ok(faultExit !== 0 && faultOutput.includes("EISDIR"), "账本故障会让 scheduler 非零退出并保留原始错误证据");
  ok(faultState.status === "stopped" && faultState.inFlight.length === 0, "异常退出仅在 emergency drain 完成后发布 stopped");
  ok(!existsSync(join(projectState, "wl-run.lock")), "确认所有 agent 已退出后才释放项目锁");
  ok(helperPid !== null && !orphanAlive, "leader 先退且 descendant 忽略 TERM 时，仍以 PGID 存活为准 KILL 整组");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_STATE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
