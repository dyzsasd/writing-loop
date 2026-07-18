// status 单测：临时 workspace fixture（票 frontmatter、episodes、锁、fires.jsonl）→
// 文本模式关键行 + --json 结构化字段；畸形票容错入 "?" 桶。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTicketFrontmatter } from "../src/status.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(hubRoot, "src", "status.ts");

type R = { code: number; out: string; stdout: string };
const run = (args: string[], cwd: string): R => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};

const ticket = (id: string, title: string, state: string, labels: string[]): string => `---
id: ${id}
title: ${title}
type: Feature
state: ${state}
owner: reviewer
labels: [${labels.join(", ")}]
priority: 3
created: 2026-07-10T08:00:00Z
updated: 2026-07-10T09:00:00Z
---
Episode: 7
## Context
正文占位。
`;

// ── 单元：frontmatter 小解析器 ──
const t = parseTicketFrontmatter(ticket("WL-9", "ep-009 写作（含: 冒号）", "In Review", ["episode", "keystone"]), "WL-9.md");
ok(t !== null && t.id === "WL-9" && t.state === "In Review", "解析器取到 id/state");
ok(t !== null && t.title === "ep-009 写作（含: 冒号）", "title 含冒号不截断");
ok(t !== null && t.labels.join(",") === "episode,keystone", "labels 内联数组拆分");
ok(t !== null && t.updated === "2026-07-10T09:00:00Z", "updated 字段取到");
ok(parseTicketFrontmatter("没有 frontmatter 的正文") === null, "无 frontmatter 返回 null（容错）");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-status-")));
try {
  const ws = join(tmp, "ws");
  const proj = join(ws, ".writing-loop", "demo");
  const ticketsDir = join(proj, "board", "tickets");
  const repo = join(ws, "repo");
  mkdirSync(ticketsDir, { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "ledgers"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "示例剧", repoPath: "repo", enabled: true } },
  }));

  writeFileSync(join(ticketsDir, "WL-1.md"), ticket("WL-1", "ep-007 写作（arc-01）", "In Review", ["writing-loop", "episode", "keystone"]));
  writeFileSync(join(ticketsDir, "WL-2.md"), ticket("WL-2", "提案：genre 校准", "Backlog", ["writing-loop", "proposal", "blocked", "needs-showrunner"]));
  writeFileSync(join(ticketsDir, "WL-3.md"), ticket("WL-3", "ep-008 写作", "In Progress", ["writing-loop", "episode"]));
  writeFileSync(join(ticketsDir, "WL-4.md"), "畸形票：没有 frontmatter\n");

  writeFileSync(join(repo, "episodes", "ep-001.md"), "# ep-001\n");
  writeFileSync(join(repo, "episodes", "ep-007.md"), "# ep-007\n");

  // 锁：一枚 2h 陈旧（STALE）、一枚新鲜、一枚 repo 写锁陈旧
  const past = new Date(Date.now() - 2 * 3600 * 1000);
  writeFileSync(join(ticketsDir, "WL-3.lock"), "holder pid=1 at 2026-07-18T00:00:00Z\n");
  utimesSync(join(ticketsDir, "WL-3.lock"), past, past);
  writeFileSync(join(proj, "wl-run.lock"), "holder pid=2 at 2026-07-18T00:00:00Z\n");
  writeFileSync(join(repo, "ledgers", "foreshadow.md.lock"), "holder pid=3 at 2026-07-18T00:00:00Z\n");
  utimesSync(join(repo, "ledgers", "foreshadow.md.lock"), past, past);

  const fire = (agent: string, exit: number | null, noop = false): string =>
    JSON.stringify({ agent, model: "opus", effort: "max", startedAt: "2026-07-18T08:00:00.000Z", endedAt: "2026-07-18T08:02:00.000Z", durationSeconds: 120.5, exitCode: exit, timedOut: false, noop, keystoneEscalated: false });
  writeFileSync(join(proj, "fires.jsonl"),
    [fire("showrunner", 0), fire("story-designer", 0, true), fire("episode-writer", 1), fire("reviewer", 0), fire("sweep", 0), fire("reflect", 0)].join("\n") + "\n坏行不是JSON\n");

  // ── 文本模式 ──
  const txt = run([], ws);
  ok(txt.code === 0, `status 退出 0（实得 ${txt.code}）`);
  ok(txt.out.includes("项目 demo"), "标题行含项目 key");
  ok(/In Review 1/.test(txt.out) && /In Progress 1/.test(txt.out) && /Backlog 1/.test(txt.out), "state 计数行齐全");
  ok(txt.out.includes("WL-1") && txt.out.includes("ep-007 写作（arc-01）"), "In Review 明细列出 WL-1");
  ok(txt.out.includes("WL-2") && txt.out.includes("needs-showrunner"), "needs-* 停靠票列出 WL-2");
  ok(txt.out.includes("ep-007.md") && txt.out.includes("7"), "写作前沿 = ep-007");
  ok(txt.out.includes("STALE"), "陈旧锁被标 STALE");
  ok(txt.out.includes("wl-run.lock"), "wl-run.lock 在锁清单里（新鲜不标 STALE）");
  ok(txt.out.includes("reflect") && txt.out.includes("120.5s"), "fires 末 5 行摘要（agent/时长）");
  ok(txt.out.includes("解析失败"), "畸形票计数出现在板行");

  // ── --json ──
  const js = run(["--json", "--project", "demo"], ws);
  ok(js.code === 0, "--json 退出 0");
  const j = JSON.parse(js.stdout) as {
    project: string; board: { counts: Record<string, number>; unparsed: number };
    inReview: Array<{ id: string }>; parked: Array<{ id: string; needs: string[] }>;
    episodeFrontier: number; locks: Array<{ path: string; stale: boolean }>;
    recentFires: unknown[]; totalFires: number;
  };
  ok(j.project === "demo", "json.project");
  ok(j.board.counts["In Review"] === 1 && j.board.unparsed === 1, "json 计数 + 畸形票桶");
  ok(j.inReview.length === 1 && j.inReview[0].id === "WL-1", "json.inReview");
  ok(j.parked.length === 1 && j.parked[0].needs.includes("needs-showrunner"), "json.parked 带 needs 标签");
  ok(j.episodeFrontier === 7, "json.episodeFrontier = 7");
  ok(j.locks.some((l) => l.stale) && j.locks.some((l) => !l.stale), "json.locks 陈旧与新鲜并存");
  ok(j.recentFires.length === 5 && j.totalFires === 6, "json.recentFires 末 5 / 全 6");

  // ── 空板（板目录未建）不炸 ──
  const ws2 = join(tmp, "ws2");
  mkdirSync(join(ws2, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws2, "r"), { recursive: true });
  writeFileSync(join(ws2, ".writing-loop", "config.json"), JSON.stringify({ version: 1, projects: { x: { repoPath: "r" } } }));
  const empty = run([], ws2);
  ok(empty.code === 0 && empty.out.includes("板目录尚未创建"), "板目录缺失给友好空态");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSTATUS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
