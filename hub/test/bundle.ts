// bundle export/import 回归：往返一致性、指纹校验、MOVE 语义、机器本地文件不出境、
// 导入后项目暂停、活跃调度器与脏 repo 拒绝导出。全部走 CLI 入口（子进程），与操作者路径一致。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const CLI = join(import.meta.dirname, "..", "src", "bundle.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "wl-bundle-home-")));
const env = { ...process.env, HOME, WRITING_LOOP_HOME: join(HOME, ".writing-loop"), WRITING_LOOP_WORKSPACE: undefined as string | undefined };
const run = (cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...env, ...extraEnv } });
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---- 造一个像样的源 workspace：identity、config、项目运行态、剧本 repo、原著、CAS、机器本地文件 ----
const src = realpathSync(mkdtempSync(join(tmpdir(), "wl-bundle-src-")));
const data = join(src, ".writing-loop");
mkdirSync(join(data, "demo", "board", "tickets"), { recursive: true });
mkdirSync(join(data, "demo", "source-intake.v1", "chunks"), { recursive: true });
mkdirSync(join(data, "demo", "logs"), { recursive: true });
mkdirSync(join(data, "assets", "sha256", "ab"), { recursive: true });
mkdirSync(join(data, "system", "proposals"), { recursive: true });
mkdirSync(join(data, ".onboarding-transactions"), { recursive: true });
writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: "ws_" + "a".repeat(32) }));
writeFileSync(join(data, "config.json"), JSON.stringify({ version: 1, scheduler: { cli: "claude" },
  projects: { demo: { title: "示例剧", repoPath: "demo", enabled: true, totalEpisodes: 2 } } }, null, 2));
writeFileSync(join(data, "config.json.bak-old"), "{}");
writeFileSync(join(data, "studio.log"), "studio noise");
writeFileSync(join(data, "demo", "board", "tickets", "DEMO-1.md"), "---\nid: DEMO-1\nstate: Todo\n---\n");
writeFileSync(join(data, "demo", "fires.jsonl"), '{"agent":"reviewer","exitCode":0}\n');
writeFileSync(join(data, "demo", "run-state.json"), JSON.stringify({ status: "stopped", inFlight: [] }));
writeFileSync(join(data, "demo", "wl-run.lock.stale-pid-1"), "1");
writeFileSync(join(data, "demo", "logs", "old.log"), "log line");
writeFileSync(join(data, "demo", "source-intake.v1", "manifest.v1.json"), JSON.stringify({ source: { path: "novel.txt" } }));
writeFileSync(join(data, "demo", "source-intake.v1", "chunks", "chunk-0001.txt"), "第一章");
writeFileSync(join(data, "assets", "sha256", "ab", "abcd"), Buffer.from([1, 2, 3, 4]));
writeFileSync(join(data, "system", "proposals", "WLSYS-1.json"), "{}");
writeFileSync(join(data, ".onboarding-transactions", "tx.json"), "{}");
writeFileSync(join(src, "novel.txt"), "原著全文……");
// 剧本 repo（两个提交）
const repo = join(src, "demo"); mkdirSync(join(repo, "episodes"), { recursive: true });
git(repo, "init", "-q"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
writeFileSync(join(repo, "outline.md"), "# 大纲"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "init");
writeFileSync(join(repo, "episodes", "ep-001.md"), "第一集"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "ep1");
const srcHead = git(repo, "rev-parse", "HEAD").stdout.trim();

const out = join(HOME, "demo.tar.gz");
try {
  // ---- 导出 ----
  const ex = run(src, ["export", "--out", out]);
  ok(ex.status === 0 && existsSync(out), `bundle export 成功并生成文件（${ex.stderr.trim()}）`);
  const ins = run(src, ["inspect", out, "--json"]);
  const m = JSON.parse(ins.stdout || "{}") as { workspaceId?: string; projects?: Array<{ key: string; gitHead: string }>; files?: Record<string, unknown>; sourceFiles?: string[] };
  ok(m.workspaceId === "ws_" + "a".repeat(32) && m.projects?.[0]?.key === "demo" && m.projects[0].gitHead === srcHead,
  "inspect 读出 workspace ID、项目与导出时 HEAD");
  const names = Object.keys(m.files ?? {});
  ok(names.includes("data/demo/board/tickets/DEMO-1.md") && names.includes("data/assets/sha256/ab/abcd")
    && names.includes("data/system/proposals/WLSYS-1.json") && names.includes("repos/demo.gitbundle") && names.includes("sources/novel.txt"),
  "包内含板、CAS 资产、系统收件箱、剧本 git bundle 与原著文件");
  ok(!names.some((n) => n.includes("/logs/")) && !names.some((n) => n.includes("run-state.json"))
    && !names.some((n) => n.includes("wl-run.lock")) && !names.some((n) => n.includes("studio.log"))
    && !names.some((n) => n.includes("onboarding-transactions")) && !names.some((n) => n.includes("config.json.bak")),
  "机器本地文件（日志、run-state、锁、studio.log、事务现场、config 备份）不出境");
  ok(m.sourceFiles?.length === 1 && m.sourceFiles[0] === "novel.txt", "manifest.sourceFiles 登记原著相对路径");

  // ---- 导入到空目录 ----
  const dst = join(HOME, "restored");
  const im = run(HOME, ["import", out, "--dir", dst, "--label", "搬来的"]);
  ok(im.status === 0, `bundle import 成功（${im.stderr.trim()}）`);
  ok(existsSync(join(dst, ".writing-loop", "workspace.json")) && JSON.parse(readFileSync(join(dst, ".writing-loop", "workspace.json"), "utf8")).id === "ws_" + "a".repeat(32),
  "workspace 稳定 ID 原样保留");
  ok(sha(join(dst, ".writing-loop", "demo", "board", "tickets", "DEMO-1.md")) === sha(join(data, "demo", "board", "tickets", "DEMO-1.md"))
    && sha(join(dst, ".writing-loop", "assets", "sha256", "ab", "abcd")) === sha(join(data, "assets", "sha256", "ab", "abcd"))
    && sha(join(dst, "novel.txt")) === sha(join(src, "novel.txt")),
  "板、CAS 资产、原著逐字节一致");
  const dstRepo = join(dst, "demo");
  ok(git(dstRepo, "rev-parse", "HEAD").stdout.trim() === srcHead && existsSync(join(dstRepo, "episodes", "ep-001.md"))
    && git(dstRepo, "log", "--oneline").stdout.trim().split("\n").length === 2,
  "剧本 repo 以完整历史还原到同一 HEAD，工作树就位");
  ok(git(dstRepo, "remote").stdout.trim() === "", "还原后的 repo 不带指向临时 gitbundle 的 origin");
  const cfg = JSON.parse(readFileSync(join(dst, ".writing-loop", "config.json"), "utf8")) as { projects: Record<string, { enabled?: boolean }> };
  ok(cfg.projects.demo.enabled === false, "导入后项目置为暂停态，不会在新机器上静默开跑");
  const reg = JSON.parse(readFileSync(join(HOME, ".writing-loop", "workspaces.json"), "utf8")) as { workspaces: Array<{ id: string; root: string; label?: string }> };
  ok(reg.workspaces.some((w) => w.id === "ws_" + "a".repeat(32) && w.root === dst && w.label === "搬来的"),
  "registry 用产品自己的注册流程登记，ID 沿用、label 采用 --label");
  ok(!existsSync(join(dst, ".writing-loop", "demo", "logs")) && !existsSync(join(dst, ".writing-loop", "demo", "run-state.json")),
  "目标机上没有源机的日志与 run-state");

  // ---- MOVE 语义：非空目录拒绝 ----
  const busy = join(HOME, "busy"); mkdirSync(busy); writeFileSync(join(busy, "x"), "x");
  const im2 = run(HOME, ["import", out, "--dir", busy]);
  ok(im2.status === 2 && /非空|不覆盖/.test(im2.stderr) && readdirSync(busy).length === 1,
  "导入到非空目录被拒绝且目标零写入");

  // ---- 指纹校验：篡改包内文件后整体拒绝 ----
  const tampered = join(HOME, "tampered.tar.gz");
  const work = mkdtempSync(join(HOME, "tamper-"));
  spawnSync("tar", ["-xzf", out, "-C", work]);
  writeFileSync(join(work, "writing-loop-bundle", "data", "demo", "board", "tickets", "DEMO-1.md"), "---\nid: DEMO-1\nstate: Done\n---\n");
  spawnSync("tar", ["-czf", tampered, "-C", work, "writing-loop-bundle"]);
  const dst2 = join(HOME, "restored2");
  const im3 = run(HOME, ["import", tampered, "--dir", dst2]);
  ok(im3.status === 2 && /指纹不符/.test(im3.stderr) && !existsSync(join(dst2, ".writing-loop")),
  "包内文件被篡改 ⇒ 指纹不符整体拒绝，目标零写入");

  // ---- 导出拒绝：调度器运行中 ----
  writeFileSync(join(data, "demo", "run-state.json"), JSON.stringify({ status: "running", inFlight: [{ agent: "x" }] }));
  const ex2 = run(src, ["export", "--out", join(HOME, "no.tar.gz")]);
  ok(ex2.status === 2 && /仍在运行/.test(ex2.stderr) && !existsSync(join(HOME, "no.tar.gz")), "调度器运行中拒绝导出");
  writeFileSync(join(data, "demo", "run-state.json"), JSON.stringify({ status: "stopped", inFlight: [] }));

  // ---- 导出拒绝：剧本 repo 有未提交改动 ----
  writeFileSync(join(repo, "episodes", "ep-002.md"), "半成品");
  const ex3 = run(src, ["export", "--out", join(HOME, "no2.tar.gz")]);
  ok(ex3.status === 2 && /未提交/.test(ex3.stderr) && !existsSync(join(HOME, "no2.tar.gz")), "剧本 repo 有未提交改动时拒绝导出");
  rmSync(join(repo, "episodes", "ep-002.md"));

  // ---- 导出后源 workspace 原样 ----
  ok(existsSync(join(data, "demo", "logs", "old.log")) && sha(join(repo, "outline.md")) === createHash("sha256").update("# 大纲").digest("hex"),
  "导出不改动源 workspace");
} finally {
  rmSync(src, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nBUNDLE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
