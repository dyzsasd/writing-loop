// 发布产物冒烟（仿 dev-loop test/build-artifact.ts 的动机）：`npm test` 跑的是 src/*.ts 源码
// （Node ≥23.6 type-stripping 零构建），发布装到用户机上的却是编译出的 dist/*.js ——
// 构建断裂 / 装机即死的入口在绿门里不可见。本套件 (a) 真跑发布构建，(b) 冒烟编译产物 bin，
// (c) 在「装机形」布局（dist/ 拷贝 + 包根插件负载、无仓库兄弟目录）下过一遍
// run --dry-run / status / fires / doctor / install-claude-plugin 全链路。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // hub/
const pkgVersion = (JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8")) as { version: string }).version;
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// 从 hubRoot 起子进程；捕获 status+stdout+合并输出。非零退出是断言数据，不抛。
const run = (cmd: string, args: string[], opts: { cwd?: string } = {}): { code: number; out: string; stdout: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? hubRoot, encoding: "utf8", env, timeout: 300_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};

function parsePackJson(stdout: string): Array<{ files?: Array<{ path: string }> }> {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  try { return JSON.parse(stdout.slice(start)) as Array<{ files?: Array<{ path: string }> }>; }
  catch { return []; }
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-build-artifact-")));
try {
  // ── AC1：发布/prepack 构建成功，emit 编译入口 + 把插件负载拷到包根 ──
  const build = run("npm", ["run", "build"]);
  ok(build.code === 0, `npm run build → 退出 0（发布构建编译 dist/）${build.code !== 0 ? `：${build.out.slice(-400)}` : ""}`);
  const distDir = join(hubRoot, "dist");
  ok(existsSync(join(distDir, "cli.js")), "dist/cli.js emit（包的 bin 入口）");
  ok(existsSync(join(distDir, "run.js")) && existsSync(join(distDir, "scheduler.js")), "dist/run.js + dist/scheduler.js emit（内建 TS 调度器随包编译）");
  ok(existsSync(join(hubRoot, "skills", "showrunner-agent", "SKILL.md"))
    && existsSync(join(hubRoot, "references", "conventions.md"))
    && existsSync(join(hubRoot, "scripts", "board-lock.sh"))
    && existsSync(join(hubRoot, "templates"))
    && existsSync(join(hubRoot, ".claude-plugin", "plugin.json")),
    "包根含完整插件负载（skills/references/scripts/templates/.claude-plugin —— build 拷贝）");
  ok(!existsSync(join(hubRoot, "scripts", "wl-run.py")) && !existsSync(join(hubRoot, "scripts", "test-wl-run.py")),
    "包内 scripts/ 无 wl-run.py / test-wl-run.py（python 调度器已退役，board-lock.sh 等 agent 工具保留）");

  const pack = run("npm", ["--silent", "pack", "--dry-run", "--json"]);
  const packed = new Set(parsePackJson(pack.stdout)[0]?.files?.map((f) => f.path) ?? []);
  ok(pack.code === 0
    && packed.has("dist/cli.js") && packed.has("dist/scheduler.js")
    && packed.has("skills/showrunner-agent/SKILL.md")
    && packed.has("scripts/board-lock.sh")
    && packed.has(".claude-plugin/plugin.json")
    && ![...packed].some((p) => p.endsWith("wl-run.py")),
    "npm pack 装载 dist + 插件负载，且不含 wl-run.py");

  // ── AC2：编译产物能跑（.ts→.js 兄弟 import 改写成立） ──
  const ver = run(process.execPath, [join(distDir, "cli.js"), "version"]);
  ok(ver.code === 0 && ver.stdout.trim() === pkgVersion, `编译 cli.js version → 退出 0 且 == package.json（${pkgVersion}）`);
  const help = run(process.execPath, [join(distDir, "cli.js"), "help"]);
  ok(help.code === 0 && help.out.includes("writing-loop"), "编译 cli.js help → 退出 0");
  const runHelp = run(process.execPath, [join(distDir, "cli.js"), "run", "--help"]);
  ok(runHelp.code === 0 && runHelp.out.includes("--cli claude|codex|opencode"), "编译 cli.js run --help → 调度器用法可读");

  // ── AC3：装机形布局（dist/ 拷贝 + 包根插件负载；无仓库 ../skills 兄弟可回退） ──
  const inst = join(tmp, "pkg"); // inst/dist/cli.js → here=inst/dist，包根 = inst
  cpSync(distDir, join(inst, "dist"), { recursive: true });
  for (const d of ["skills", "references", "scripts", "templates", ".claude-plugin"]) {
    cpSync(join(hubRoot, d), join(inst, d), { recursive: true });
  }
  cpSync(join(hubRoot, "package.json"), join(inst, "package.json"));
  const instCli = join(inst, "dist", "cli.js");

  // fixture workspace：单项目 + 已有票/账本/遥测（status/fires 有内容可断言）
  const ws = join(tmp, "ws");
  const proj = join(ws, ".writing-loop", "demo");
  mkdirSync(join(proj, "board", "tickets"), { recursive: true });
  mkdirSync(join(ws, "repo", "episodes"), { recursive: true });
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "装机冒烟剧", repoPath: "repo", enabled: true, audience: "女频·25-40", paywall: { card1: [9, 10] } } },
  }, null, 2));
  writeFileSync(join(ws, "repo", "episodes", "ep-003.md"), "# ep-003\n");
  writeFileSync(join(proj, "board", "tickets", "WL-1.md"),
    "---\nid: WL-1\ntitle: ep-004 写作\ntype: Feature\nstate: In Review\nowner: reviewer\nlabels: [writing-loop, episode, keystone]\nupdated: 2026-07-18T08:00:00Z\n---\nbody\n");
  writeFileSync(join(proj, "fires.jsonl"),
    JSON.stringify({ agent: "showrunner", model: "opus", effort: "max", startedAt: "2026-07-18T08:00:00.000Z", endedAt: "2026-07-18T08:01:00.000Z", durationSeconds: 60, exitCode: 0, timedOut: false, noop: false, keystoneEscalated: false }) + "\n");

  const instDry = run(process.execPath, [instCli, "run", "--dry-run", "--project", "demo"], { cwd: ws });
  ok(instDry.code === 0 && instDry.out.includes("wl-run --dry-run")
    && instDry.out.includes("claude") && instDry.out.includes("/writing-loop:showrunner-agent")
    && instDry.out.includes("KEYSTONE 升档中"),
    "装机形 run --dry-run → 内建调度器渲染 claude 命令 + keystone 升档谓词读到板（包根插件负载解析成功）");
  const instInline = run(process.execPath, [instCli, "run", "--dry-run", "--project", "demo", "--cli", "opencode"], { cwd: ws });
  ok(instInline.code === 0 && instInline.out.includes("opencode run") && instInline.out.includes("【writing-loop 调度器上下文】"),
    "装机形 run --dry-run --cli opencode → 从包根 skills/ 组装 inline prompt（无仓库兄弟目录可回退）");
  const instStatus = run(process.execPath, [instCli, "status", "--project", "demo"], { cwd: ws });
  ok(instStatus.code === 0 && instStatus.out.includes("WL-1") && instStatus.out.includes("ep-003"),
    "装机形 status → 板/前沿可读");
  const instFires = run(process.execPath, [instCli, "fires", "--project", "demo"], { cwd: ws });
  ok(instFires.code === 0 && instFires.out.includes("showrunner"), "装机形 fires → 遥测尾巴可读");
  const instDoctor = run(process.execPath, [instCli, "doctor"], { cwd: ws });
  ok(instDoctor.code === 0 && instDoctor.out.includes("WRITING_LOOP_DOCTOR_OK") && instDoctor.out.includes("NEXT:"),
    `装机形 doctor → DOCTOR_OK + NEXT:（暖警告不失败）${instDoctor.code !== 0 ? `：${instDoctor.out.slice(-400)}` : ""}`);
  ok(!instDoctor.out.includes("python"), "doctor 输出无任何 python 检查（调度器已原生化）");

  const mktDir = join(tmp, "claude-marketplace");
  const instMkt = run(process.execPath, [instCli, "install-claude-plugin", "--dest", mktDir], { cwd: ws });
  const mktFile = join(mktDir, ".claude-plugin", "marketplace.json");
  const mkt = existsSync(mktFile) ? JSON.parse(readFileSync(mktFile, "utf8")) as { plugins?: Array<{ source?: { source?: string; package?: string; version?: string } }> } : null;
  ok(instMkt.code === 0
    && mkt?.plugins?.[0]?.source?.source === "npm"
    && mkt?.plugins?.[0]?.source?.package === "@dyzsasd/writing-loop"
    && mkt?.plugins?.[0]?.source?.version === pkgVersion,
    "装机形 install-claude-plugin → 写 npm-source marketplace.json 且版本钉住本 CLI");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nBUILD_ARTIFACT_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
