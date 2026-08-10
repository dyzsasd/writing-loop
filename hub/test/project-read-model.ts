// workspace snapshot 回归：多项目（含暂停项目）、剧本资产、票、实时 fire 与稳定指纹。
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceSnapshot, snapshotFingerprint } from "../src/project-read-model.ts";
import { loadConfig } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const ticket = (id: string, title: string, state: string, labels: string, episode: number): string => `---
id: ${id}
title: ${title}
type: Feature
state: ${state}
owner: showrunner
assignee: null
labels:
${labels.split(",").map((label) => `  - ${label}`).join("\n")}
priority: 2
updated: 2026-08-09T10:00:00.000Z
---
Episode: ${episode}
`;

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-snapshot-")));
try {
  const data = join(tmp, ".writing-loop");
  const activeData = join(data, "paper-moon");
  const tickets = join(activeData, "board", "tickets");
  const repo = join(tmp, "paper-moon");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "arcs"), { recursive: true });
  mkdirSync(join(repo, "ledgers"), { recursive: true });
  mkdirSync(join(repo, "evaluation"), { recursive: true });
  mkdirSync(join(tmp, "paused-story"), { recursive: true });

  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    futureField: { preserved: true },
    projects: {
      "paper-moon": {
        title: "纸月亮",
        repoPath: "paper-moon",
        enabled: true,
        format: "live-action",
        genre: "悬疑",
        audience: "18–35 岁女性",
        totalEpisodes: 12,
      },
      paused: { title: "冬眠中的故事", repoPath: "paused-story", enabled: false, totalEpisodes: 60 },
    },
  }, null, 2));

  writeFileSync(join(repo, "bible", "north-star.md"), "# 北极星\n\n## 一句话故事\n一个失忆编剧发现自己写下的每一集都会在现实发生。\n");
  writeFileSync(join(repo, "bible", "characters.md"), "# 人物圣经\n");
  writeFileSync(join(repo, "bible", "world.md"), "# 世界圣经\n");
  writeFileSync(join(repo, "outline.md"), "# 总大纲\n");
  writeFileSync(join(repo, "ledgers", "story-state.md"), "# 状态\n");
  writeFileSync(join(repo, "arcs", "arc-01.md"), "# 单元一\n");
  writeFileSync(join(repo, "evaluation", "milestone-01.md"), "# 评估\n");
  writeFileSync(join(repo, "episodes", "ep-001.md"), "---\narc: arc-01\nhook-type: reveal\nwords: 1320\n---\n# 消失的署名\n");
  writeFileSync(join(repo, "episodes", "ep-003.md"), `---\nwords: ${"9".repeat(180)}\n---\n# 倒写的第三集\n`);
  writeFileSync(join(repo, "episodes", "ep-1.md"), "# 非规范别名，不应成为第三份第一集\n");
  writeFileSync(join(repo, "episodes", `ep-${"9".repeat(180)}.md`), "# 非法超长集号\n");

  writeFileSync(join(tickets, "WL-1.md"), ticket("WL-1", "第一集审读", "In Review", "writing-loop,needs-showrunner", 1));
  writeFileSync(join(tickets, "WL-2.md"), ticket("WL-2", "第四集落笔", "In Progress", "writing-loop,episode", 4));
  writeFileSync(join(tickets, "WL-3.md"), "---\nid: WL-3\ntitle: 待修复票\n---\n");

  writeFileSync(join(activeData, "wl-run.lock"), `holder pid=${process.pid} at 2026-08-09T10:00:00Z\n`);
  utimesSync(join(activeData, "wl-run.lock"), new Date("2026-08-09T10:00:00.000Z"), new Date("2026-08-09T10:00:00.000Z"));
  writeFileSync(join(activeData, "run-state.json"), JSON.stringify({
    version: 1,
    project: "paper-moon",
    pid: process.pid,
    status: "running",
    cli: "codex",
    selectedAgents: ["episode-writer"],
    startedAt: "2026-08-09T09:59:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    inFlight: [{
      agent: "episode-writer", pid: process.pid, model: "gpt-5", effort: "high",
      startedAt: "2026-08-09T10:00:00.000Z", capSeconds: 900, logFile: "logs/fire.log",
    }],
  }));
  writeFileSync(join(activeData, "fires.jsonl"), [
    "null",
    "[]",
    "1",
    JSON.stringify({ agent: "bad", durationSeconds: -1 }),
    JSON.stringify({ agent: "showrunner", exitCode: 0, noop: false, endedAt: "2026-08-09T09:00:00.000Z" }),
    JSON.stringify({ agent: "episode-writer", exitCode: 1, noop: false, endedAt: "2026-08-09T09:30:00.000Z" }),
    JSON.stringify({ agent: "reviewer", exitCode: 0, descendantDrain: true, noop: false, endedAt: "2026-08-09T09:45:00.000Z" }),
  ].join("\n") + "\n");

  const snapshot = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:01:00.000Z"));
  ok(snapshot.projectCount === 2 && snapshot.enabledProjectCount === 1, "workspace 投影包含暂停项目");
  ok(snapshot.projects[0].key === "paper-moon" && snapshot.projects[1].key === "paused", "enabled 项目优先且顺序稳定");
  const project = snapshot.projects[0];
  ok(project.logline?.includes("现实发生") === true, "从北极星提取一句话故事");
  ok(project.progress.frontier === 3 && project.progress.percent === 25, "分集前沿与总集数形成进度");
  ok(project.latestEpisodes[0].number === 3 && project.latestEpisodes[0].words === null
    && project.latestEpisodes[1].words === 1320, "分集按最新优先投影元数据，超大 words 保持 null 而非 Infinity");
  ok(project.board.total === 3 && project.board.open === 3 && project.board.malformed === 1, "票统计保留畸形票并计数");
  ok(project.board.needsAttention[0]?.id === "WL-1" && project.board.inProgress[0]?.episode === 4, "block labels 与 Episode 进入 UI 投影");
  ok(project.scheduler.state === "running" && project.scheduler.inFlight[0]?.agent === "episode-writer", "实时 scheduler / in-flight agent 可观测");
  ok(project.telemetry.totalFires === 3 && project.telemetry.successfulFires === 1 && project.telemetry.successRate === 33, "成功率排除虽 exit 0 但需要清理残留进程组的非 clean fire");
  ok(project.telemetry.totalFires === 3, "语法合法但不是 FireRow 对象的 JSONL 值不会让 snapshot 崩溃或污染统计");
  ok(project.telemetry.byAgent.reviewer?.ok === 0 && project.telemetry.byAgent.reviewer?.descendantDrains === 1, "按 agent 聚合单列 descendant drain 且不误报成功");
  ok(project.documents.filter((doc) => doc.exists).length === 5, "剧情资产存在性投影");
  ok(snapshot.totals.episodes === 2 && snapshot.totals.runningAgents === 1 && snapshot.totals.needsAttention === 1, "workspace 汇总只计规范 ep-NNN 文件，不把数字别名算成重复分集");
  ok(Number.isFinite(project.progress.frontier) && JSON.stringify(project).includes('"frontier":3'),
  "超长集号文件名被忽略，不会把 Infinity 序列化为 null 或污染排序");

  const biblePath = join(repo, "bible");
  const bibleReal = join(repo, "bible-real");
  const outsideBible = join(tmp, "outside-bible-summary");
  mkdirSync(outsideBible);
  writeFileSync(join(outsideBible, "north-star.md"), "# 外部秘密\n\n## 一句话故事\n不应出现在 snapshot 的秘密。\n");
  renameSync(biblePath, bibleReal);
  symlinkSync(outsideBible, biblePath);
  const unsafeBible = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:01:00.000Z")).projects[0];
  ok(unsafeBible.logline === null
    && unsafeBible.documents.find((doc) => doc.key === "north-star")?.exists === false
    && unsafeBible.warnings.some((warning) => warning.source === "document:north-star" && warning.code === "UNSAFE_PATH"),
  "持久 bible 目录 symlink 只产生 UNSAFE_PATH，不泄露外部剧情摘要");
  unlinkSync(biblePath);
  renameSync(bibleReal, biblePath);

  const episodesPath = join(repo, "episodes");
  const episodesReal = join(repo, "episodes-real");
  const outsideEpisodes = join(tmp, "outside-episodes-summary");
  mkdirSync(outsideEpisodes);
  writeFileSync(join(outsideEpisodes, "ep-999.md"), "# 外部第 999 集\n");
  renameSync(episodesPath, episodesReal);
  symlinkSync(outsideEpisodes, episodesPath);
  const unsafeEpisodes = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:01:00.000Z")).projects[0];
  ok(unsafeEpisodes.progress.written === 0 && unsafeEpisodes.progress.frontier === 0
    && unsafeEpisodes.latestEpisodes.length === 0
    && unsafeEpisodes.warnings.some((warning) => warning.source === "episodes" && warning.code === "UNSAFE_PATH"),
  "持久 episodes 目录 symlink 只产生 UNSAFE_PATH，不投影外部分集");
  unlinkSync(episodesPath);
  renameSync(episodesReal, episodesPath);

  const ticketsReal = join(activeData, "board", "tickets-real");
  const outsideTickets = join(tmp, "outside-tickets-summary");
  mkdirSync(outsideTickets);
  writeFileSync(join(outsideTickets, "SECRET-1.md"), ticket("SECRET-1", "外部票", "Todo", "writing-loop", 1));
  renameSync(tickets, ticketsReal);
  symlinkSync(outsideTickets, tickets);
  let unsafeRuntimeRejected = false;
  try { buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:01:00.000Z")); }
  catch (error) { unsafeRuntimeRejected = error instanceof Error && error.message.includes("运行态路径含符号链接"); }
  ok(unsafeRuntimeRejected, "持久 board/tickets symlink 以稳定错误拒绝，不读取外部运行态");
  unlinkSync(tickets);
  renameSync(ticketsReal, tickets);

  writeFileSync(join(activeData, "wl-run.lock"), "fresh but not a scheduler holder\n");
  utimesSync(join(activeData, "wl-run.lock"), new Date("2026-08-09T10:00:00.000Z"), new Date("2026-08-09T10:00:00.000Z"));
  const fakeFreshLock = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:01:00.000Z")).projects[0];
  ok(fakeFreshLock.scheduler.state === "stale" && fakeFreshLock.scheduler.inFlight.length === 0,
  "任意新鲜文件不能冒充 scheduler holder lock 或复活旧 in-flight");
  writeFileSync(join(activeData, "wl-run.lock"), `holder pid=${process.pid} at 2026-08-09T10:00:00Z\n`);
  utimesSync(join(activeData, "wl-run.lock"), new Date("2026-08-09T10:00:00.000Z"), new Date("2026-08-09T10:00:00.000Z"));

  const later = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:02:00.000Z"));
  ok(snapshot.generatedAt !== later.generatedAt, "generatedAt 反映每次读取时间");
  ok(snapshotFingerprint(snapshot) === snapshotFingerprint(later), "仅生成时间变化不会触发 SSE reload");

  const staleAt = new Date("2026-08-09T08:00:00.000Z");
  utimesSync(join(activeData, "wl-run.lock"), staleAt, staleAt);
  const stale = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:02:00.000Z")).projects[0];
  ok(stale.scheduler.state === "stale" && stale.scheduler.inFlight.length === 0, "陈旧锁会清空旧 in-flight，UI 不把崩溃前 agent 显示为正在工作");

  unlinkSync(join(activeData, "wl-run.lock"));
  writeFileSync(join(activeData, "board", "wl-run.lock"), "不是 scheduler 锁\n");
  const suffixCollision = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:02:00.000Z")).projects[0];
  ok(suffixCollision.scheduler.state === "stale" && suffixCollision.scheduler.inFlight.length === 0, "名字同样以 wl-run.lock 结尾的板锁不能冒充项目 scheduler 锁");

  writeFileSync(join(tickets, "WL-999.md"), `---\nid: WL-999\ntitle: 超大摘要票\ntype: Task\nstate: Todo\nlabels: []\npriority: 1\nupdated: 2026-08-09T10:03:00.000Z\n---\n${"x".repeat(70 * 1024)}\nEpisode: 999\n`);
  for (let index = 0; index < 197; index++) {
    const id = `BULK-${String(index).padStart(3, "0")}`;
    writeFileSync(join(tickets, `${id}.md`), ticket(id, `批量票 ${index}`, "Done", "writing-loop", 1));
  }
  utimesSync(join(tickets, "WL-999.md"), new Date(), new Date());
  writeFileSync(join(repo, "episodes", "ep-004.md"), `${"x".repeat(70 * 1024)}\n# 不应被摘要读取的标题\n`);
  writeFileSync(join(activeData, "fires.jsonl"), `${"x".repeat(520 * 1024)}\n${[
    JSON.stringify({ agent: "showrunner", exitCode: 0, noop: false, endedAt: "2026-08-09T09:00:00.000Z" }),
    JSON.stringify({ agent: "episode-writer", exitCode: 1, noop: false, endedAt: "2026-08-09T09:30:00.000Z" }),
    JSON.stringify({ agent: "reviewer", exitCode: 0, descendantDrain: true, noop: false, endedAt: "2026-08-09T09:45:00.000Z" }),
  ].join("\n")}\n`);
  mkdirSync(join(activeData, "reports"), { recursive: true });
  for (let index = 0; index < 202; index++) writeFileSync(join(activeData, "reports", `report-${String(index).padStart(3, "0")}.md`), "# report\n");
  const bounded = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:04:00.000Z")).projects[0];
  ok(bounded.board.tickets.find((row) => row.id === "WL-999")?.episode === null
    && bounded.latestEpisodes[0]?.number === 4 && bounded.latestEpisodes[0]?.title === "第 4 集",
  "snapshot 对超大 ticket/episode 只读 64 KiB 摘要，不扫描隐藏在尾部的字段");
  ok(bounded.board.total === 200 && bounded.warnings.some((warning) => warning.source === "tickets" && warning.code === "COUNT_TRUNCATED"),
  "恰有 201 张票时 snapshot 只返回 200 张并显式标记 has-more 截断");
  ok(bounded.telemetry.totalFires === 3 && bounded.warnings.some((warning) => warning.source === "fires" && warning.code === "TAIL_TRUNCATED"),
  "snapshot 只解析 fires.jsonl 有界尾部并显式暴露截断");
  ok(bounded.warnings.some((warning) => warning.source === "tickets" && warning.code === "FILE_TRUNCATED")
    && bounded.warnings.some((warning) => warning.source === "episodes" && warning.code === "FILE_TRUNCATED")
    && bounded.warnings.some((warning) => warning.source === "reports" && warning.code === "COUNT_TRUNCATED"),
  "各有界来源把 file/count 截断写入稳定 snapshot warnings");

  writeFileSync(join(activeData, "fires.jsonl"), `${`${JSON.stringify({ agent: "bounded" })}\n`.repeat(2_001)}`);
  const rowBounded = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:04:30.000Z")).projects[0];
  ok(rowBounded.telemetry.totalFires === 2_000
    && rowBounded.warnings.some((warning) => warning.source === "fires" && warning.code === "TAIL_TRUNCATED"),
  "基础 snapshot 的 fire 聚合同样有 2000 行硬上限并暴露截断");

  for (let index = 0; index <= 2_048; index++) writeFileSync(join(tickets, `noise-${String(index).padStart(4, "0")}.txt`), "x");
  const flooded = buildWorkspaceSnapshot(loadConfig(tmp), Date.parse("2026-08-09T10:05:00.000Z")).projects[0];
  ok(flooded.warnings.some((warning) => warning.source === "tickets" && warning.code === "COUNT_TRUNCATED"),
  "目录 entry flood 在 2048 项处停止并暴露 COUNT_TRUNCATED");

  const configPath = join(data, "config.json");
  for (const invalidKey of ["../escape", "alpha\n"]) {
    writeFileSync(configPath, JSON.stringify({ projects: { [invalidKey]: { repoPath: "." } } }));
    let rejected = false;
    try { buildWorkspaceSnapshot(loadConfig(tmp)); } catch { rejected = true; }
    ok(rejected, `不安全项目 key ${JSON.stringify(invalidKey)} 在接触运行态路径前硬拒绝`);
  }
  for (const malformed of [null, [], 7]) {
    writeFileSync(configPath, JSON.stringify({ projects: { demo: malformed } }));
    let stable = false;
    try { buildWorkspaceSnapshot(loadConfig(tmp)); }
    catch (error) { stable = error instanceof Error && error.message.includes("项目 'demo' 必须是 JSON 对象"); }
    ok(stable, `畸形项目条目 ${JSON.stringify(malformed)} 以稳定配置错误拒绝而非 TypeError`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPROJECT_READ_MODEL_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
