// fire spawn 的 stdin 契约回归（2026-08-27 故障）。
// 实况：claude CLI 2.1.246 起在 `-p` 下仍等 stdin；调度器 spawn fire 是 detached 无 tty，
// stdin 配置若不给一个可判 EOF 的源，claude 无限等 stdin ⇒ 每个 fire 挂起（CPU 睡眠、
// 日志 0 字节、cap 前不退出，熔断器/cap 都兜不住）。修复：spawn stdin 显式给 /dev/null fd。
//
// 本测试钉住的不变量：**fire 的 stdin 必须可读到 EOF，fire 不因等 stdin 挂起**。
// 假 CLI 用 readFileSync(0) 阻塞读 stdin 直到 EOF——stdin=/dev/null ⇒ 立即 EOF ⇒ exit 0；
// 若哪天有人把 stdin 改成一个永不 EOF 的源，readFileSync 会挂到 cap ⇒ timedOut，本测失败。
// （注：claude CLI 对 "ignore" vs 显式 /dev/null 的差异是其自身行为，Node 假 CLI 复现不了；
//  本测保护的是「stdin 会 EOF」这个契约，而非复现 claude 的具体挂起。）
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string, extra = ""): void => {
  console.log((c ? "PASS " : "FAIL ") + m + (c || !extra ? "" : `（${extra}）`));
  if (!c) fails++;
};

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");
const ws = realpathSync(mkdtempSync(join(tmpdir(), "wl-stdin-")));
try {
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  // 假 CLI：阻塞读 stdin 直到 EOF，然后输出 no-op 正文并 exit 0。
  // stdin=/dev/null（修复）⇒ readFileSync(0) 立即 EOF ⇒ 秒退；stdin 挂 ⇒ readFileSync 永阻塞 ⇒ cap 杀。
  writeFileSync(join(ws, "stdin_cli.mjs"),
    "import { readFileSync } from 'node:fs';\n" +
    "readFileSync(0);\n" +  // 阻塞直到 stdin EOF
    "console.log('本 lane 无活 —— no-op');\n" +
    "process.exit(0);\n");
  const agents: Record<string, unknown> = {};
  for (const a of ["showrunner", "source-analyst", "story-designer", "episode-writer", "reviewer",
    "evaluator", "sweep", "script-doctor", "market-watch", "reflect"]) agents[a] = { enabled: false };
  // cap 6s：若 fire 因等 stdin 挂起，6s 后 timedOut；stdin=/dev/null 则秒退 exit 0。
  agents["sweep"] = { enabled: true, intervalSeconds: 1, capSeconds: 6, staggerSeconds: 0,
    command: [process.execPath, join(ws, "stdin_cli.mjs")] };
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { cli: "claude", laneGating: false, agents },  // laneGating off：确保真的 spawn
    projects: { t1: { title: "stdin 测试", repoPath: "t1", enabled: true } },
  }, null, 2));
  const env = { ...process.env }; delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [runEntry, "--project", "t1", "--for", "8"],
    { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  const ledger = join(ws, ".writing-loop", "t1", "fires.jsonl");
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { /* 无账本 */ }
  ok(rows.length >= 1, "至少起了一个 fire", `实得 ${rows.length}`);
  const exited0 = rows.filter((r) => r.exitCode === 0 && !r.timedOut);
  const hung = rows.filter((r) => r.timedOut === true);
  ok(exited0.length >= 1, "假 CLI 读到 stdin EOF 后 exit 0（stdin=/dev/null 生效，未挂起）",
    `exit0=${exited0.length} timedOut=${hung.length}`);
  ok(hung.length === 0, "无 fire 因等 stdin 挂起被 cap 杀（回归防线）", `timedOut=${hung.length}`);
} finally {
  rmSync(ws, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nFIRE_STDIN_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
