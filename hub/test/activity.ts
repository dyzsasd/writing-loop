// Phase 2 activity 回归：来源语义、未知成本、未来时钟钳制、有界 fire tail、分页与 live overlay。
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectActivity } from "../src/activity.ts";
import { loadConfig, WsError } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsWs = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof WsError && error.message.includes(needle); }
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-activity-")));
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
try {
  const data = join(tmp, ".writing-loop");
  const projectData = join(data, "demo");
  const tickets = join(projectData, "board", "tickets");
  const repo = join(tmp, "repo");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(projectData, "reports"), { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "evaluation"), { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "时间线剧", repoPath: "repo", enabled: true } },
  }));
  writeFileSync(join(projectData, "events.jsonl"), "null\n" + JSON.stringify({
    id: "project.created:demo", type: "project.created", at: "2026-08-10T08:00:00.000Z",
    actor: "operator", title: "立项《时间线剧》", detail: "scaffold abc · 首票 WL-1",
  }) + "\n");
  const success = {
    agent: "reviewer", model: "gpt-5", effort: "high", provider: "openai",
    startedAt: "2026-08-10T09:00:00.000Z", endedAt: "2026-08-10T09:00:00.000Z",
    durationSeconds: 0, exitCode: 0, timedOut: false, noop: false,
  };
  const blocked = {
    agent: "episode-writer", model: "provider/model", effort: "high", provider: "custom",
    startedAt: "2026-08-10T10:00:00.000Z", endedAt: "2026-08-10T10:00:01.000Z",
    exitCode: null, timedOut: false, noop: false, providerAuthMissing: "CUSTOM_API_KEY",
  };
  // 超过 tail 预算的旧行应被显式截断；尾部两条完整 fire 仍必须可读。
  writeFileSync(join(projectData, "fires.jsonl"), `${"x".repeat(520 * 1024)}\n{"torn":\nnull\n[]\n1\n${JSON.stringify({ agent: "bad", durationSeconds: -1 })}\n${JSON.stringify(success)}\n${JSON.stringify(blocked)}\n`);
  const ticketPath = join(tickets, "WL-1.md");
  writeFileSync(ticketPath, `---
id: WL-1
title: 第一集审读
type: Feature
state: In Review
owner: reviewer
assignee: reviewer (run r1)
labels: [writing-loop, episode, reviewer]
priority: 2
created: 2026-08-10T08:30:00.000Z
updated: 2099-01-01T00:00:00.000Z
---
Episode: 1
## Context
首集。
---
## Comments
### 2026-08-10T10:30:00.000Z — episode-writer (run w1)
state: In Progress → In Review。
### 2099-01-01T00:00:00.000Z — operator
请把结尾改得更狠。
${"x".repeat(220 * 1024)}
### 2026-08-10T11:30:00.000Z — reviewer
state: In Review → Done。
`);
  utimesSync(ticketPath, new Date("2026-08-10T10:31:00.000Z"), new Date("2026-08-10T10:31:00.000Z"));
  writeFileSync(join(repo, "bible", "north-star.md"), "# 北极星\n");
  writeFileSync(join(repo, "episodes", "ep-001.md"), "# 第一集\n");
  writeFileSync(join(repo, "episodes", "ep-1.md"), "# 非规范第一集别名\n");
  writeFileSync(join(repo, "episodes", `ep-${"9".repeat(180)}.md`), "# 非法超长集号\n");
  writeFileSync(join(projectData, "reports", "daily.md"), "# Daily\n");
  writeFileSync(join(projectData, "reports", "operator.review.md"), "# Review\n");
  writeFileSync(join(repo, "evaluation", "一卡门.md"), "# Eval\n");
  writeFileSync(join(projectData, "run-state.json"), JSON.stringify({
    status: "running", pid: process.pid,
    inFlight: [{ agent: "showrunner", pid: 123, model: "opus", effort: "max", startedAt: "2026-08-10T11:59:00.000Z", logFile: "logs/showrunner.log" }],
  }, null, 2));
  writeFileSync(join(projectData, "wl-run.lock"), `holder pid=${process.pid} at 2026-08-10T11:59:00Z\n`);
  utimesSync(join(projectData, "wl-run.lock"), new Date(NOW - 1_000), new Date(NOW - 1_000));

  const ws = loadConfig(tmp);
  const page = buildProjectActivity(ws, "demo", { limit: 100, nowMs: NOW });
  ok(page.items.some((event) => event.kind === "project.created"), "权威 project event ledger 进入时间线");
  const fireOk = page.items.find((event) => event.kind === "fire.completed");
  const fireBlocked = page.items.find((event) => event.kind === "fire.blocked");
  ok(fireOk?.metrics?.durationSeconds.state === "known" && fireOk.metrics.durationSeconds.value === 0, "duration=0 保持 known，不与缺值混淆");
  ok(fireOk?.metrics?.cost.state === "unknown" && fireOk.metrics.cost.reason === "not-recorded", "已调用模型但无账单时成本明确 unknown");
  ok(fireBlocked?.metrics?.cost.state === "not-applicable" && fireBlocked.metrics.cost.reason === "provider-not-started", "认证拦截未启动 provider 时成本为 not-applicable");
  ok(page.usage.observedFires === 2 && page.usage.models["gpt-5"] === 1 && page.usage.cost.state === "unknown", "用量汇总只陈述可证实 fire/model/duration，不编造 token 或金额");
  ok(page.warnings.some((warning) => warning.code === "INVALID_ROW"), "语法合法但非对象或字段非法的 JSONL 行会被跳过并显式告警");
  ok(page.truncated && page.warnings.some((warning) => warning.source === "fires" && warning.code === "TAIL_TRUNCATED"), "fire tail 有界且通过 warning 暴露截断");

  const transition = page.items.find((event) => event.kind === "ticket.state-changed" && event.data.to === "In Review");
  const latestTransition = page.items.find((event) => event.kind === "ticket.state-changed" && event.data.to === "Done");
  const operatorComment = page.items.find((event) => event.kind === "ticket.commented");
  ok(transition?.summary.includes("In Progress → In Review") === true && transition.completeness === "authoritative", "Ticket append-only 评论生成权威转态事件");
  ok(latestTransition?.summary.includes("In Review → Done") === true
    && page.warnings.some((warning) => warning.source === "ticket:WL-1" && warning.code === "FILE_TRUNCATED"),
  "超大 ticket 用有界 head+tail 仍投影文件尾部最新流转，并诚实标记中段截断");
  ok(operatorComment?.actor.type === "operator" && operatorComment.time.anomaly === "future-clamped"
    && Date.parse(operatorComment.time.effectiveAt) <= NOW, "未来评论戳立即钳制并保留 anomaly");
  ok(page.items.some((event) => event.kind === "episode.discovered")
    && page.items.some((event) => event.kind === "document.discovered")
    && page.items.some((event) => event.kind === "report.reviewed")
    && page.items.some((event) => event.kind === "evaluation.discovered"), "分集/剧情文档/操作者点评/评估以 snapshot-only 语义投影");
  ok(page.items.filter((event) => event.kind === "episode.discovered").length === 1
    && page.items.filter((event) => event.kind === "episode.discovered").every((event) => Number.isFinite(event.data.episode)),
  "超长集号与 ep-1 数字别名不会生成 Infinity/null 或重复分集活动");
  ok(page.live.length === 1 && page.live[0].agent === "showrunner" && page.live[0].elapsedSeconds === 60, "run-state 只作为 live overlay，不伪装历史");

  const outsideArtifacts = join(tmp, "outside-artifacts");
  mkdirSync(join(outsideArtifacts, "bible"), { recursive: true });
  mkdirSync(join(outsideArtifacts, "episodes"));
  mkdirSync(join(outsideArtifacts, "evaluation"));
  writeFileSync(join(outsideArtifacts, "bible", "north-star.md"), "# 外部北极星\n");
  writeFileSync(join(outsideArtifacts, "episodes", "ep-999.md"), "# 外部分集\n");
  writeFileSync(join(outsideArtifacts, "evaluation", "secret.md"), "# 外部评估\n");
  for (const name of ["bible", "episodes", "evaluation"]) {
    renameSync(join(repo, name), join(repo, `${name}-real`));
    symlinkSync(join(outsideArtifacts, name), join(repo, name));
  }
  const unsafeArtifacts = buildProjectActivity(ws, "demo", { limit: 100, nowMs: NOW });
  ok(!unsafeArtifacts.items.some((event) => event.kind === "document.discovered" || event.kind === "episode.discovered" || event.kind === "evaluation.discovered")
    && ["document:north-star", "episodes", "evaluations"].every((source) => unsafeArtifacts.warnings.some((warning) => warning.source === source && warning.code === "UNSAFE_PATH")),
  "持久 bible/episodes/evaluation symlink 不投影外部工件，并逐来源暴露 UNSAFE_PATH");
  for (const name of ["bible", "episodes", "evaluation"]) {
    unlinkSync(join(repo, name));
    renameSync(join(repo, `${name}-real`), join(repo, name));
  }

  appendFileSync(ticketPath, `
### 2026-08-10T11:40:00.000Z — reviewer
state: Done → In Review。
${"y".repeat(70 * 1024)}
### 2026-08-10T11:41:00.000Z — reviewer
state: In Review → Done。
`);
  const identityBefore = buildProjectActivity(ws, "demo", { limit: 100, nowMs: NOW });
  const stableBefore = identityBefore.items.find((event) => event.time.reportedAt === "2026-08-10T11:41:00.000Z")?.id;
  appendFileSync(ticketPath, `
### 2026-08-10T11:42:00.000Z — operator
尾部继续追加，但上一条事件 identity 不应漂移。
${"z".repeat(80 * 1024)}
`);
  const identityAfter = buildProjectActivity(ws, "demo", { limit: 100, nowMs: NOW });
  const stableAfter = identityAfter.items.find((event) => event.time.reportedAt === "2026-08-10T11:41:00.000Z")?.id;
  ok(Boolean(stableBefore) && stableBefore === stableAfter,
  "超大 ticket 的 128 KiB tail 向前滑动时，仍可见的旧评论保持稳定事件 ID 与分页 identity");

  writeFileSync(join(projectData, "wl-run.lock"), "fresh impostor\n");
  utimesSync(join(projectData, "wl-run.lock"), new Date(NOW - 1_000), new Date(NOW - 1_000));
  const staleLive = buildProjectActivity(ws, "demo", { limit: 1, nowMs: NOW });
  ok(staleLive.live.length === 0 && staleLive.warnings.some((warning) => warning.code === "STALE_RUN_STATE"),
  "activity 只有在 run-state PID 与新鲜 holder lock 匹配且进程存活时才显示 live agent");
  writeFileSync(join(projectData, "wl-run.lock"), `holder pid=${process.pid} at 2026-08-10T11:59:00Z\n`);
  utimesSync(join(projectData, "wl-run.lock"), new Date(NOW - 1_000), new Date(NOW - 1_000));

  for (let index = 0; index <= 200; index++) {
    writeFileSync(join(projectData, "reports", `bulk-${String(index).padStart(3, "0")}.md`), "# report\n");
    writeFileSync(join(repo, "evaluation", `bulk-${String(index).padStart(3, "0")}.md`), "# evaluation\n");
  }
  const boundedArtifacts = buildProjectActivity(ws, "demo", { limit: 1, nowMs: NOW });
  ok(boundedArtifacts.truncated
    && boundedArtifacts.warnings.some((warning) => warning.source === "reports" && warning.code === "COUNT_TRUNCATED")
    && boundedArtifacts.warnings.some((warning) => warning.source === "evaluations" && warning.code === "COUNT_TRUNCATED"),
  "报告与评估超过投影上限时分别暴露 COUNT_TRUNCATED，不静默漏历史");

  const first = buildProjectActivity(ws, "demo", { limit: 3, nowMs: NOW });
  ok(Boolean(first.nextBeforeCursor) && first.hasMore, "activity page 给出有界 opaque before cursor");
  const second = buildProjectActivity(ws, "demo", { limit: 3, before: first.nextBeforeCursor, nowMs: NOW });
  ok(first.items.every((a) => second.items.every((b) => a.id !== b.id)), "分页以 (effectiveAt,id) 稳定推进、不重复");
  const wrongCursor = Buffer.from(JSON.stringify({ v: 1, project: "other", before: ["2026-01-01T00:00:00.000Z", "x"] })).toString("base64url");
  ok(throwsWs(() => buildProjectActivity(ws, "demo", { before: wrongCursor, nowMs: NOW }), "与项目或 schema 不匹配"), "cursor 绑定 project，不能跨剧复用");
  ok(throwsWs(() => buildProjectActivity(ws, "demo", { before: "not-json", nowMs: NOW }), "cursor 无效"), "损坏 cursor 明确拒绝");

  writeFileSync(join(projectData, "fires.jsonl"), `${`${JSON.stringify({ agent: "spam" })}\n`.repeat(2_000)}${JSON.stringify({ agent: "__proto__", model: "__proto__", provider: "constructor" })}\n`);
  const cappedFires = buildProjectActivity(ws, "demo", { limit: 1, nowMs: NOW });
  ok(cappedFires.usage.observedFires === 2_000
    && cappedFires.warnings.some((warning) => warning.source === "fires" && warning.code === "COUNT_TRUNCATED")
    && Object.getPrototypeOf(cappedFires.usage.models) === null
    && Object.getPrototypeOf(cappedFires.usage.providers) === null
    && cappedFires.usage.models["__proto__"] === 1 && cappedFires.usage.providers["constructor"] === 1,
  "高行数 fire ledger 只保留最近 2000 行并显式告警，不随文件行数膨胀活动对象");

  let rotated = false;
  const rotationSafe = buildProjectActivity(ws, "demo", {
    limit: 1,
    nowMs: NOW,
    beforeLedgerOpen: (file) => {
      if (!rotated && file.endsWith("fires.jsonl")) { rotated = true; unlinkSync(file); }
    },
  });
  ok(rotated && rotationSafe.usage.observedFires === 0,
  "ledger 在 lstat→open 观察窗轮转/删除时按空窗口降级，不把 activity 路由打成 500");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nACTIVITY_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
