// 按需详情回归：Ticket 结构/评论、文档/分集/报告 registry、大小限制与 symlink 防线。
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjectEvaluations, listProjectEvaluationsBounded, listProjectReports, listProjectReportsBounded,
  parseTicketDetail, readProjectResource,
} from "../src/project-detail.ts";
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

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-project-detail-")));
try {
  const data = join(tmp, ".writing-loop");
  const projectData = join(data, "demo");
  const tickets = join(projectData, "board", "tickets");
  const reports = join(projectData, "reports");
  const repo = join(tmp, "repo");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(reports, { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "evaluation"), { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "详情剧", repoPath: "repo", enabled: true } },
  }, null, 2));
  const ticketBody = `---
id: WL-12
title: "ep-012 写作：终局前夜"
type: Feature
state: In Review
owner: reviewer
assignee: episode-writer (run abc)
labels: [writing-loop, Feature, episode, reviewer]
priority: 3
relatedTo: [WL-9, WL-10]
duplicateOf: null
created: 2026-08-09T09:00:00.000Z
updated: 2026-08-09T11:02:00.000Z
---
Episode: 12
## Context
接续第十一集尾钩。

## Context-pack
- bible/north-star.md

## Acceptance criteria
- 必须兑现 F-03。

## How to verify
reviewer 逐行核对。

---
## Comments
### 2026-08-09T10:40:00.000Z — episode-writer (run abc)
认领（§7）。

附加交接：
- 先核对上一集尾钩；
- 再兑现 F-03。
### 2026-08-09T11:02:00.000Z — episode-writer (run abc)
state: In Progress → In Review。commit abc1234。
`;
  writeFileSync(join(tickets, "WL-12.md"), ticketBody);
  writeFileSync(join(repo, "bible", "north-star.md"), "# 北极星\n\n<script>alert(1)</script>\n");
  writeFileSync(join(repo, "episodes", "ep-012.md"), "# 第十二集：终局前夜\n\n正文\n");
  writeFileSync(join(repo, "episodes", "ep-12.md"), "# 非规范别名：绝不能被详情任意选中\n");
  writeFileSync(join(reports, "daily.md"), "# Daily\n");
  writeFileSync(join(reports, "operator.review.md"), "# 操作者点评\n");
  writeFileSync(join(repo, "evaluation", "一卡门.md"), "# 一卡门评估\n");

  const parsed = parseTicketDetail(ticketBody, "WL-12.md");
  ok(parsed.summary.id === "WL-12" && parsed.relatedTo.join(",") === "WL-9,WL-10", "Ticket detail 复用摘要 parser 并读取关联票");
  ok(parsed.sections.context?.includes("第十一集") === true && parsed.sections.contextPack?.includes("north-star") === true
    && parsed.sections.acceptanceCriteria?.includes("F-03") === true && parsed.sections.howToVerify?.includes("逐行") === true,
  "Ticket detail 拆出四个创作交接节");
  ok(parsed.comments.length === 2 && parsed.comments[0].body.includes("附加交接")
    && parsed.comments[0].body.includes("再兑现 F-03") && parsed.comments[1].stateChange?.from === "In Progress"
    && parsed.comments[1].stateChange?.to === "In Review", "多段 append-only 评论不在空行处截断，并投影真实流转事件");

  const ws = loadConfig(tmp);
  const ticket = readProjectResource(ws, "demo", "ticket", "WL-12");
  ok(ticket.ticket?.summary.episode === 12 && ticket.relativePath === "board/tickets/WL-12.md", "Ticket detail 由安全文件名映射并复核文内 ID");
  const doc = readProjectResource(ws, "demo", "document", "north-star");
  ok(doc.content.includes("<script>") && doc.etag.length === 64, "详情返回原始 Markdown + ETag，留给 UI 按文本 escaping");
  const episode = readProjectResource(ws, "demo", "episode", "12");
  ok(episode.title === "第十二集：终局前夜" && episode.relativePath === "episodes/ep-012.md", "分集 ID 经 registry 映射而非任意路径");
  const reportRows = listProjectReports(ws, "demo");
  const evaluationRows = listProjectEvaluations(ws, "demo");
  ok(reportRows.length === 2 && reportRows.some((row) => row.review), "报告索引区分操作者 review");
  ok(evaluationRows.length === 1 && readProjectResource(ws, "demo", "evaluation", evaluationRows[0].id).content.includes("一卡门"), "评估报告按服务端 hash ID 读取");
  for (let index = 0; index < 198; index++) writeFileSync(join(reports, `boundary-${String(index).padStart(3, "0")}.md`), "# report\n");
  writeFileSync(join(reports, "boundary-198.md"), "# report\n");
  for (let index = 0; index < 200; index++) writeFileSync(join(repo, "evaluation", `boundary-${String(index).padStart(3, "0")}.md`), "# evaluation\n");
  const boundedReports = listProjectReportsBounded(ws, "demo");
  const boundedEvaluations = listProjectEvaluationsBounded(ws, "demo");
  ok(boundedReports.rows.length === 200 && boundedReports.truncated
    && boundedEvaluations.rows.length === 200 && boundedEvaluations.truncated,
  "恰有 201 份报告/评估时第 201 项只作 has-more 哨兵，投影严格返回 200 项并告警");
  ok(throwsWs(() => readProjectResource(ws, "demo", "ticket", "../config"), "详情 id 无效"), "详情 id 拒绝路径穿越");
  ok(throwsWs(() => readProjectResource(ws, "demo", "document", "../../outside"), "详情 id 无效"), "文档接口不接受 path 参数");

  const oldTicket = `---\nid: ZZ-999\ntitle: 投影窗外的旧票\ntype: Task\nstate: Done\nlabels: []\npriority: 1\nupdated: 2020-01-01T00:00:00.000Z\n---\nEpisode: 999\n`;
  writeFileSync(join(tickets, "ZZ-999.md"), oldTicket);
  for (let index = 0; index < 201; index++) writeFileSync(join(tickets, `AA-${String(index).padStart(3, "0")}.md`), oldTicket.replaceAll("ZZ-999", `AA-${String(index).padStart(3, "0")}`));
  ok(readProjectResource(ws, "demo", "ticket", "ZZ-999").ticket?.summary.id === "ZZ-999",
  "详情 API 可读取 snapshot/activity 201 票窗口之外的已知安全 ticket，不误报 404");

  const projectDataReal = `${projectData}-real`;
  renameSync(projectData, projectDataReal);
  symlinkSync(projectDataReal, projectData);
  ok(throwsWs(() => readProjectResource(ws, "demo", "ticket", "WL-12"), "不跟随符号链接"),
  "持久 project-data 中间 symlink 不能把详情读取锚到 workspace 外部或替代目录");
  unlinkSync(projectData);
  renameSync(projectDataReal, projectData);

  // 固定 registry 目标若被换成 symlink，也不能借 trusted doc key 读项目外文件。
  rmSync(join(repo, "bible", "north-star.md"));
  const outside = join(tmp, "outside-secret.md");
  writeFileSync(outside, "SECRET\n");
  symlinkSync(outside, join(repo, "bible", "north-star.md"));
  ok(throwsWs(() => readProjectResource(ws, "demo", "document", "north-star"), "不跟随符号链接"), "固定文档 registry 同样拒绝 symlink 逃逸");

  rmSync(join(repo, "bible", "north-star.md"));
  writeFileSync(join(repo, "bible", "north-star.md"), "SAFE\n");
  const outsideBible = join(tmp, "outside-bible");
  mkdirSync(outsideBible);
  writeFileSync(join(outsideBible, "north-star.md"), "SECRET FROM SWAPPED DIRECTORY\n");
  let swapped = false;
  try {
    readProjectResource(ws, "demo", "document", "north-star", { beforeOpen: () => {
      renameSync(join(repo, "bible"), join(repo, "bible-original"));
      symlinkSync(outsideBible, join(repo, "bible"));
    } });
  } catch (error) {
    swapped = error instanceof WsError && /不跟随符号链接|越出允许的项目根|打开竞争窗/.test(error.message);
  }
  ok(swapped, "中间目录在 validate→open 竞争窗被替换时，fd/path 二次绑定拒绝外部内容");
  unlinkSync(join(repo, "bible"));
  renameSync(join(repo, "bible-original"), join(repo, "bible"));

  writeFileSync(join(repo, "bible", "characters.md"), "x".repeat(1024 * 1024 + 500));
  const large = readProjectResource(ws, "demo", "document", "characters");
  ok(large.truncated && Buffer.byteLength(large.content) === 1024 * 1024 && large.bytes > Buffer.byteLength(large.content), "详情读取严格限制 1 MiB 并显式标 truncated");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPROJECT_DETAIL_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
