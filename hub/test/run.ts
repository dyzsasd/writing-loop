// run 入口整链冒烟：临时 workspace + 假项目 → src/run.ts →（原生 TS 调度器）--dry-run
// （零 spawn agent、零写 ledger、不拿锁）。另验：--plan 透传、经 cli.ts 路由同链、
// 未知 flag 退 2、无 workspace 报错指路 init/add-script、--help 可读。
// 调度器本体的行为矩阵（单飞/超时/keystone/锁）在 test/scheduler.ts。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");
const cliEntry = join(hubRoot, "src", "cli.ts");

type R = { code: number; out: string };
const run = (args: string[], cwd: string): R => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE; // 测试机残留的 env 不得影响解析
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-run-")));
try {
  // fixture：单项目 workspace（--dry-run 只要求 repoPath 目录存在）
  const ws = join(tmp, "ws");
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "repo"), { recursive: true });
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "冒烟剧", repoPath: "repo", enabled: true } },
  }, null, 2));

  const dry = run([runEntry, "--dry-run"], ws);
  ok(dry.code === 0, `run --dry-run 退出 0（实得 ${dry.code}）`);
  ok(dry.out.includes("wl-run --dry-run"), "输出含 'wl-run --dry-run'（真的走到了内建调度器）");
  ok(dry.out.includes("demo"), "dry-run 输出含项目 key（demo）");
  ok(dry.out.includes("showrunner"), "dry-run 输出含 agent 名（showrunner）");
  ok(dry.out.includes("cli=claude") && dry.out.includes("promptMode=slash"), "dry-run 头行如实反映默认 cli/promptMode");

  const plan = run([runEntry, "--plan", "3"], ws);
  ok(plan.code === 0 && plan.out.includes("--plan 3"), "--plan 3 到达调度器排程模拟");

  // 经 cli.ts 的 run 路由走同一条链
  const viaCli = run([cliEntry, "run", "--dry-run"], ws);
  ok(viaCli.code === 0 && viaCli.out.includes("wl-run --dry-run"), "writing-loop run --dry-run（经 cli.ts 路由）同样到达调度器");

  // 未知 flag：参数解析拒绝（退 2，同 0.4.0 argparse 语义）
  const bogus = run([runEntry, "--bogus-flag"], ws);
  ok(bogus.code === 2, `未知 flag 被参数解析拒绝（退 2；实得 ${bogus.code}）`);

  // --help：用法可读、不再提 --self-test（TS 侧由 npm test 承担）
  const help = run([runEntry, "--help"], ws);
  ok(help.code === 0 && help.out.includes("--cli claude|codex|opencode"), "--help 列出 --cli 三引擎");
  ok(!help.out.includes("--self-test"), "--help 不再提 --self-test");

  // 无 workspace：报错并指路 init / add-script
  const orphan = join(tmp, "orphan");
  mkdirSync(orphan);
  const noWs = run([runEntry, "--dry-run"], orphan);
  ok(noWs.code === 1, `无 workspace 退出 1（实得 ${noWs.code}）`);
  ok(noWs.out.includes("writing-loop init") && noWs.out.includes("add-script"), "无 workspace 的报错指路 init 与 add-script");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
