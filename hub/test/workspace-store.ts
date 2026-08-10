// workspace-store 回归：未知字段无损保留、严格 key、未知项目、O_EXCL 并发锁、CLI 启停。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectMain } from "../src/project.ts";
import { setProjectEnabled } from "../src/workspace-store.ts";
import { WsError } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsWith = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof WsError && error.message.includes(needle); }
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-workspace-store-")));
const stateDir = join(tmp, ".writing-loop");
const configFile = join(stateDir, "config.json");
const lockFile = `${configFile}.lock`;
const savedWorkspace = process.env.WRITING_LOOP_WORKSPACE;

try {
  mkdirSync(stateDir, { recursive: true });
  const fixture = {
    version: 27,
    futureTopLevel: { nested: [1, { untouched: true }], channel: "experimental" },
    scheduler: { intervalSeconds: 99, futureKnob: "keep-me" },
    projects: {
      alpha: {
        title: "甲剧",
        repoPath: "stories/alpha",
        enabled: true,
        futureProjectField: { render: { aspect: "9:16" }, flags: ["a", "b"] },
      },
      beta: { title: "乙剧", repoPath: "stories/beta", enabled: false, custom: 42 },
    },
  };
  writeFileSync(configFile, JSON.stringify(fixture, null, "\t") + "\n");
  mkdirSync(join(stateDir, "alpha"), { recursive: true });

  // 只改一个叶子，未来/未知字段与另一个项目都必须保留。
  setProjectEnabled(tmp, "alpha", false);
  const afterDisable = JSON.parse(readFileSync(configFile, "utf8")) as typeof fixture;
  ok(afterDisable.projects.alpha.enabled === false, "disable 写入目标项目");
  ok(JSON.stringify(afterDisable.futureTopLevel) === JSON.stringify(fixture.futureTopLevel), "顶层未知字段完整保留");
  ok(JSON.stringify(afterDisable.projects.alpha.futureProjectField) === JSON.stringify(fixture.projects.alpha.futureProjectField), "项目未知字段完整保留");
  ok(JSON.stringify(afterDisable.projects.beta) === JSON.stringify(fixture.projects.beta), "非目标项目不变");
  ok(readFileSync(configFile, "utf8").includes("\n\t\"version\""), "沿用原配置的 tab 缩进风格");
  ok(!readdirSync(stateDir).some((name) => name.includes(".tmp-")) && !readdirSync(stateDir).includes("config.json.lock"), "成功后无临时文件或锁残留");

  setProjectEnabled(tmp, "alpha", true);
  ok((JSON.parse(readFileSync(configFile, "utf8")) as typeof fixture).projects.alpha.enabled === true, "enable 恢复目标项目");
  const toggleEvents = readFileSync(join(stateDir, "alpha", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
  ok(toggleEvents.map((event) => event.type).join(",") === "project.paused,project.resumed", "项目启停追加可重建 activity 事件");
  setProjectEnabled(tmp, "alpha", true);
  ok(readFileSync(join(stateDir, "alpha", "events.jsonl"), "utf8").trim().split("\n").length === 2, "幂等 enable 不重复写 activity 或 config");

  const eventLedger = join(stateDir, "alpha", "events.jsonl");
  const victim = join(tmp, "event-victim.txt");
  rmSync(eventLedger);
  writeFileSync(victim, "DO NOT TOUCH\n");
  symlinkSync(victim, eventLedger);
  setProjectEnabled(tmp, "alpha", false);
  ok(readFileSync(victim, "utf8") === "DO NOT TOUCH\n", "activity ledger 的预置 symlink 不能截断或追加任意 victim");
  ok((JSON.parse(readFileSync(configFile, "utf8")) as typeof fixture).projects.alpha.enabled === false,
  "非权威 event 写失败不伪报已原子发布的启停配置失败");
  rmSync(eventLedger);

  linkSync(victim, eventLedger);
  setProjectEnabled(tmp, "alpha", true);
  ok(readFileSync(victim, "utf8") === "DO NOT TOUCH\n"
    && (JSON.parse(readFileSync(configFile, "utf8")) as typeof fixture).projects.alpha.enabled === true,
  "activity ledger 的预置硬链接不会被追加；非权威失败不撤销已提交 config");
  rmSync(eventLedger);
  setProjectEnabled(tmp, "alpha", false);
  rmSync(eventLedger);
  setProjectEnabled(tmp, "alpha", true);
  const recoveredEvents = readFileSync(eventLedger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
  ok(recoveredEvents.map((event) => event.type).join(",") === "project.resumed", "修复 ledger 后后续配置提交仍按锁内顺序追加事件");

  // 显式 barrier 卡在 replace 后、event append 前：此时 config lock 必须仍在位。
  rmSync(eventLedger);
  const barrierReady = join(tmp, "toggle-barrier.ready");
  const barrierRelease = join(tmp, "toggle-barrier.release");
  const moduleUrl = new URL("../src/workspace-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import {existsSync,writeFileSync} from "node:fs"; import {setProjectEnabled} from ${JSON.stringify(moduleUrl)}; setProjectEnabled(${JSON.stringify(tmp)}, "alpha", false, {afterReplace(){writeFileSync(${JSON.stringify(barrierReady)}, "ready"); const wait=new Int32Array(new SharedArrayBuffer(4)); while(!existsSync(${JSON.stringify(barrierRelease)})) Atomics.wait(wait,0,0,10);}});`],
  { stdio: ["ignore", "ignore", "pipe"] });
  const childErrors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => childErrors.push(chunk));
  const deadline = Date.now() + 3_000;
  while (!existsSync(barrierReady) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ok(existsSync(barrierReady) && existsSync(lockFile), "config replace 后、event append 前仍持锁，并发 pause/resume 不会反序落账");
  writeFileSync(barrierRelease, "go");
  const childCode = await new Promise<number | null>((resolve) => child.once("close", resolve));
  ok(childCode === 0 && readFileSync(eventLedger, "utf8").includes("project.paused"), `锁内 event append 后正常释放（${Buffer.concat(childErrors).toString("utf8")}）`);
  setProjectEnabled(tmp, "alpha", true);

  // 特殊文件不能让全局 config lock 永久卡死；O_NONBLOCK 后 fstat 会立即拒绝 FIFO。
  rmSync(eventLedger);
  execFileSync("mkfifo", [eventLedger]);
  const fifoChild = spawn(process.execPath, ["--input-type=module", "-e",
    `import {setProjectEnabled} from ${JSON.stringify(moduleUrl)}; setProjectEnabled(${JSON.stringify(tmp)}, "alpha", false);`],
  { stdio: ["ignore", "ignore", "pipe"] });
  const fifoExit = await Promise.race([
    new Promise<number | null>((resolve) => fifoChild.once("close", resolve)),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
  ]);
  if (fifoExit === "timeout") fifoChild.kill("SIGKILL");
  ok(fifoExit === 0 && !existsSync(lockFile), "FIFO activity ledger 被立即拒绝，不会持锁阻塞所有配置写者");
  rmSync(eventLedger);
  setProjectEnabled(tmp, "alpha", true);

  // 严格 key 在取得锁前拒绝，文件不能被触碰。
  const beforeInvalid = readFileSync(configFile, "utf8");
  for (const key of ["", "Alpha", "-alpha", "alpha/beta", "has space", "alpha\n", "a".repeat(33)]) {
    ok(throwsWith(() => setProjectEnabled(tmp, key, false), "非法项目 key"), `拒绝非法 key ${JSON.stringify(key)}`);
  }
  ok(readFileSync(configFile, "utf8") === beforeInvalid, "非法 key 不改配置");

  // 未知 key 明确报错；异常路径也要释放自己取得的锁。
  ok(throwsWith(() => setProjectEnabled(tmp, "ghost", false), "无项目 'ghost'"), "未知合法 key 明确报错");
  ok(throwsWith(() => setProjectEnabled(tmp, "constructor", false), "无项目 'constructor'"), "原型继承名也按未知 key 处理");
  ok(!readdirSync(stateDir).includes("config.json.lock"), "未知 key 失败后释放本进程锁");
  ok(!readdirSync(stateDir).some((name) => name.includes(".tmp-")), "未知 key 失败后无 temp 残留");

  // 已有锁属于另一个写者：O_EXCL 必须硬错，且既不截断也不删除该锁。
  writeFileSync(lockFile, "other-writer\n");
  const beforeLocked = readFileSync(configFile, "utf8");
  ok(throwsWith(() => setProjectEnabled(tmp, "alpha", false), "另一进程"), "并发配置锁硬错而非覆盖");
  ok(readFileSync(configFile, "utf8") === beforeLocked, "并发锁期间配置不变");
  ok(readFileSync(lockFile, "utf8") === "other-writer\n", "绝不截断或删除别人的锁");
  rmSync(lockFile);

  // CLI 入口直接发现 workspace；list 包含 active/paused，enable/disable 都落盘。
  process.env.WRITING_LOOP_WORKSPACE = tmp;
  const logs: string[] = [];
  const errors: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  let disableCode = -1;
  let enableCode = -1;
  let listCode = -1;
  let listOutput = "{}";
  console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(" ")); };
  try {
    disableCode = projectMain(["disable", "alpha"]);
    enableCode = projectMain(["enable", "alpha"]);
    logs.length = 0;
    listCode = projectMain(["list", "--json"]);
    listOutput = logs.at(-1) ?? "{}";
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  ok(disableCode === 0, "project disable CLI 成功");
  ok(enableCode === 0, "project enable CLI 成功");
  ok(listCode === 0, "project list --json CLI 成功");
  const listed = JSON.parse(listOutput) as { projects?: Array<{ key: string; enabled: boolean }> };
  ok(listed.projects?.length === 2 && listed.projects.some((p) => p.key === "beta" && !p.enabled) === true, "JSON 清单包含暂停项目");
  ok(errors.length === 0, "CLI 正常路径无错误输出");
  ok((JSON.parse(readFileSync(configFile, "utf8")) as typeof fixture).projects.alpha.enabled === true, "CLI 启停最终状态落盘");
} finally {
  if (savedWorkspace === undefined) delete process.env.WRITING_LOOP_WORKSPACE;
  else process.env.WRITING_LOOP_WORKSPACE = savedWorkspace;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nWORKSPACE_STORE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
