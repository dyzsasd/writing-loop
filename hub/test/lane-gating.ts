// 车道门控（laneGating）自测 —— 0.6.0 操作者裁定①「no-op 判定移到调度器」的测试面。
// 覆盖（任务书 B1 验收清单）：
//   1. frontmatter 解析核：flow/block labels、引号、机读行（Episode:/Blocked-by:/Notified:）、
//      边缘形态 ⇒ malformed（单向安全的输入面）
//   2. 每个 agent lane 谓词的正反例（纯函数，构造 LaneTicket[] 直接断言）
//   3. 单向安全断言：有活但 frontmatter 边缘形态的票 ⇒ 门控放行（绝不假跳过）
//   4. 孤儿/逃逸口逐条：§7 认领陈旧（含未来戳）、needs-\*、Blocked-by resolver、
//      §9 停靠 24h 重提醒、逃逸口Ⅲ报告结算（点评分发 + weekly/monthly 窗口）
//   5. laneGating:false 奇偶：行为与 0.5.0 一致（照 fire、无 [gated] 行、fires.jsonl 行形无
//      gatedSinceLast 字段）；on 时 gatedSinceLast 结清 + --dry-run 逐谓词可观测；
//      --once = 操作者显式点火 ⇒ 绕过门控照 fire（[gate] 行仅诊断，Fix 轮 1）
// 纯函数断言直接 import src/scheduler.ts；E2E 断言过 src/run.ts 全链路（真 subprocess）。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardSnapshotHash, buildSched, evalLaneGate, keystonePending,
  laneEpisodeWriter, laneEvaluator, laneMarketWatch, laneReflect, laneReviewer,
  laneScriptDoctor, laneShowrunner, laneSourceAnalyst, laneStoryDesigner, laneSweep,
  lastMonthlyBoundaryMs, lastWeeklyBoundaryMs, parseLaneTicket,
  reportsEscape, shaEq, showrunnerBoardSnapshotHash, sweepLockScan, WlExit,
  type LaneTicket,
} from "../src/scheduler.ts";
import type { WlConfig, WlProject } from "../src/workspace.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runEntry = join(hubRoot, "src", "run.ts");
const AGENTS = ["showrunner", "source-analyst", "story-designer", "episode-writer", "reviewer", "evaluator",
  "sweep", "script-doctor", "market-watch", "reflect"];

let npass = 0, nfail = 0;
function check(desc: string, cond: boolean, extra = ""): void {
  if (cond) { npass++; console.log(`PASS ${desc}`); }
  else { nfail++; console.log(`FAIL ${desc}${extra ? `（${extra}）` : ""}`); }
}

// 固定「现在」= 2026-07-15T12:00Z（周三正午 UTC——周界 07-13 周一、月界 07-01 都远离，
// 墙钟谓词测试不受真实时钟影响）。
const NOW = Date.parse("2026-07-15T12:00:00Z");
const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;

const tk = (o: Partial<LaneTicket>): LaneTicket => ({
  id: o.id ?? "WL-1", state: o.state ?? "Todo", labels: o.labels ?? [],
  owner: o.owner ?? null, assignee: o.assignee ?? null, updatedRaw: o.updatedRaw ?? "t",
  updatedMs: o.updatedMs === undefined ? NOW - MIN : o.updatedMs,
  mtimeMs: o.mtimeMs ?? NOW - MIN, episode: o.episode ?? null,
  blockedBy: o.blockedBy ?? [], notifiedMs: o.notifiedMs ?? null, directWrite: o.directWrite ?? false, malformed: o.malformed ?? false,
});

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "wl-gate-test.")));
const touch = (path: string, ms: number): void => { utimesSync(path, new Date(ms), new Date(ms)); };

// ---------------------------------------------------------------------------
// 1. frontmatter 解析核
// ---------------------------------------------------------------------------
function testParse(): void {
  const t1 = parseLaneTicket(
    "---\nid: WL-12\ntitle: x\nstate: In Review\nowner: reviewer\n" +
    "labels: [writing-loop, Feature, episode, reviewer, episode-writer]\n" +
    "assignee: episode-writer (run 3f2a)\nupdated: 2026-07-15T11:00:00Z\n---\n" +
    "Episode: 12\nDesign: story/outline.v1.json#episode-012\nBlocked-by: WL-9\n## Comments\n" +
    "Notified: 2026-07-14T00:00:00Z\nNotified: 2026-07-15T00:00:00Z\n", "WL-12.md", 123);
  check("解析：flow labels + 机读行全字段", !t1.malformed && t1.id === "WL-12" && t1.state === "In Review"
    && t1.labels.includes("episode-writer") && t1.assignee === "episode-writer (run 3f2a)"
    && t1.updatedMs === Date.parse("2026-07-15T11:00:00Z") && t1.episode === 12
    && t1.blockedBy.join(",") === "WL-9" && t1.notifiedMs === Date.parse("2026-07-15T00:00:00Z"),
    JSON.stringify(t1));
  const t2 = parseLaneTicket(
    '---\r\nid: WL-8\r\nstate: "Todo"\r\nlabels:\r\n  - writing-loop\r\n  - "episode-writer"\r\nassignee: null\r\n---\r\nbody\r\n',
    "WL-8.md", 1);
  check("解析：CRLF + 引号 state + block 式 labels + assignee null", !t2.malformed && t2.state === "Todo"
    && t2.labels.join(",") === "writing-loop,episode-writer" && t2.assignee === null, JSON.stringify(t2));
  const t3 = parseLaneTicket("---\nid: WL-3\nstate: Todo\n---\nbody\n", "WL-3.md", 1);
  check("解析：labels 键整个缺失 ⇒ 空集而非 malformed（缺标签是 sweep 的活）", !t3.malformed && t3.labels.length === 0);
  const t4 = parseLaneTicket("---\nid: WL-4\nstate: Todo\nlabels: {oops\n---\nbody\n", "WL-4.md", 1);
  check("解析：labels 键在但值不可解析 ⇒ malformed（保守）", t4.malformed);
  const t5 = parseLaneTicket("---\nid: WL-5\nlabels: [a]\n---\nbody\n", "WL-5.md", 1);
  check("解析：state 缺失 ⇒ malformed", t5.malformed);
  const t6 = parseLaneTicket("---\nid: WL-6\nstate: Todo\nlabels: [a]\nbody 没有闭合 fence", "WL-6.md", 1);
  check("解析：frontmatter 无闭合 --- ⇒ malformed", t6.malformed);
  const t7 = parseLaneTicket("state: Todo\n", "WL-7.md", 1);
  check("解析：无 frontmatter 定界 ⇒ malformed", t7.malformed);
  // Fix 轮 1 critical①：零缩进 block labels（合法 YAML/PyYAML 默认输出形/人类手写常见形）
  // 曾被静默解析成空 labels 且 malformed=false ⇒ 门控假跳过。
  const t8 = parseLaneTicket(
    "---\nid: WL-10\nstate: Todo\nowner: reviewer\nlabels:\n- writing-loop\n- episode-writer\n---\nbody\n",
    "WL-10.md", 1);
  check("解析：零缩进 block labels ⇒ 正常解析非空（不再假空集）",
    !t8.malformed && t8.labels.join(",") === "writing-loop,episode-writer", JSON.stringify(t8));
  const t9 = parseLaneTicket(
    "---\nid: WL-11\nstate: Todo\nlabels:\n- a\nassignee: x\n---\nbody\n", "WL-11.md", 1);
  check("解析：零缩进 block 遇新键行（^\\S+: 形）即停，后续字段照常解析",
    !t9.malformed && t9.labels.join(",") === "a" && t9.assignee === "x", JSON.stringify(t9));
  const t10 = parseLaneTicket("---\nid: WL-13\nstate: Todo\nlabels:\n-\n---\nbody\n", "WL-13.md", 1);
  check("解析：block 条目 dash 起头但捕不出值 ⇒ malformed（判不出绝不猜）", t10.malformed);
  // Fix 轮 1 minor：state 词表外值（手误双空格/黏连形）曾解析「成功」后在全部精确匹配枝
  // 静默不命中 = fail-closed。
  const t11 = parseLaneTicket("---\nid: WL-14\nstate: In  Review\nlabels: [a]\n---\nbody\n", "WL-14.md", 1);
  check("解析：state 手误（词表外值 \"In  Review\"）⇒ malformed（保守放行）", t11.malformed);
  const t12 = parseLaneTicket("---\nid: WL-15\nstate: InReview\nlabels: [a]\n---\nbody\n", "WL-15.md", 1);
  check("解析：state 黏连形（\"InReview\"）⇒ malformed", t12.malformed);

  const a = [tk({ id: "WL-1", state: "Todo" }), tk({ id: "WL-2", state: "Done" })];
  const b = [a[1], a[0]]; // 同集换序
  check("板快照哈希：按 ID 排序 ⇒ 文件序无关", boardSnapshotHash(a) === boardSnapshotHash(b));
  const c = [a[0], tk({ id: "WL-2", state: "Todo" })];
  check("板快照哈希：state 变 ⇒ 哈希变", boardSnapshotHash(a) !== boardSnapshotHash(c));
  const d = [a[0], tk({ id: "WL-2", state: "Done", mtimeMs: NOW })];
  check("板快照哈希：mtime 变（人类手写留言信号）⇒ 哈希变", boardSnapshotHash(a) !== boardSnapshotHash(d));
  const sourceTodo = tk({ id: "WL-SOURCE", state: "Todo", owner: "story-designer",
    labels: ["writing-loop", "Feature", "source-analysis", "story-designer"] });
  const sourceWorking = tk({ ...sourceTodo, state: "In Progress", assignee: "story-designer (run abc)",
    updatedRaw: "later", updatedMs: NOW, mtimeMs: NOW });
  check("Showrunner 快照：原著分析 Todo→In Progress/checkpoint 心跳不算协调变化",
    showrunnerBoardSnapshotHash([sourceTodo]) === showrunnerBoardSnapshotHash([sourceWorking]));
  check("Showrunner 快照：原著分析进入 In Review 仍算协调变化",
    showrunnerBoardSnapshotHash([sourceTodo]) !== showrunnerBoardSnapshotHash([
      tk({ ...sourceWorking, state: "In Review" }),
    ]));
  check("Showrunner 快照：新增真正的 needs-showrunner 票仍算协调变化",
    showrunnerBoardSnapshotHash([sourceTodo]) !== showrunnerBoardSnapshotHash([
      sourceTodo, tk({ id: "WL-DECISION", labels: ["writing-loop", "needs-showrunner"] }),
    ]));
}

// ---------------------------------------------------------------------------
// 2. 各 lane 谓词正反例 + 孤儿/逃逸口逐条（纯函数）
// ---------------------------------------------------------------------------
function testEpisodeWriter(): void {
  const ew = ["writing-loop", "Feature", "episode", "reviewer", "episode-writer"];
  check("episode-writer 正例：∃ Todo+tier", laneEpisodeWriter([tk({ labels: ew })], NOW).length > 0);
  check("episode-writer 正例：修订 Bug（无 episode 子标签）不被子类型收窄",
    laneEpisodeWriter([tk({ labels: ["writing-loop", "Bug", "reviewer", "episode-writer"] })], NOW).length > 0);
  // WLSYS-6267a4c：主进件排除 blocked——§9 blocked 票不在任何拾取序内，命中它只能产出又一次
  // no-op；人工停靠（external-prereq/fix-exhausted）可站 24h+，「一次白 boot」实为每 tick 白 boot。
  // 解封 = §18 labels update op，主进件项随即恢复为真——不存在假退出窗口。
  check("episode-writer 主进件排除 blocked：Todo+tier+blocked 不命中（WLSYS-6267a4c）",
    laneEpisodeWriter([tk({ labels: [...ew, "blocked"] })], NOW).length === 0);
  check("episode-writer 孤儿口不受 blocked 收窄：In Progress+blocked+认领陈旧仍命中",
    laneEpisodeWriter([tk({ state: "In Progress", labels: [...ew, "blocked"], assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("episode-writer 反例：Backlog 暂存不可见", laneEpisodeWriter([tk({ state: "Backlog", labels: ew })], NOW).length === 0);
  check("episode-writer 反例：他 tier 不拾",
    laneEpisodeWriter([tk({ labels: ["writing-loop", "Feature", "story-designer"] })], NOW).length === 0);
  check("episode-writer 反例：空板", laneEpisodeWriter([], NOW).length === 0);
  const claimed = { state: "In Progress", labels: ew, assignee: "episode-writer (run aa11)" } as const;
  check("episode-writer 孤儿正例：In Progress 认领陈旧 >60min（§7）",
    laneEpisodeWriter([tk({ ...claimed, updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("episode-writer 孤儿反例：认领新鲜（<60min）不命中",
    laneEpisodeWriter([tk({ ...claimed, updatedMs: NOW - 10 * MIN })], NOW).length === 0);
  check("episode-writer 孤儿正例：updated 是未来戳 ⇒ stale-可疑立即命中（§18 时钟纪律）",
    laneEpisodeWriter([tk({ ...claimed, updatedMs: NOW + HOUR })], NOW).length > 0);
  check("episode-writer 孤儿正例：updated 解析不出 ⇒ 保守命中",
    laneEpisodeWriter([tk({ ...claimed, updatedMs: null })], NOW).length > 0);
  check("episode-writer 孤儿正例：In Progress 无 assignee（搁浅形）⇒ 保守命中",
    laneEpisodeWriter([tk({ state: "In Progress", labels: ew, assignee: null })], NOW).length > 0);
}

function testStoryDesigner(): void {
  const sd = ["writing-loop", "Feature", "arc-design", "showrunner", "story-designer"];
  check("story-designer 正例：∃ Todo+tier", laneStoryDesigner([tk({ labels: sd })], NOW).length > 0);
  check("story-designer 主进件排除 blocked：Todo+tier+blocked 不命中（WLSYS-6267a4c）",
    laneStoryDesigner([tk({ labels: [...sd, "blocked"] })], NOW).length === 0);
  check("story-designer 孤儿口不受 blocked 收窄：In Progress+blocked+认领陈旧仍命中",
    laneStoryDesigner([tk({ state: "In Progress", labels: [...sd, "blocked"], assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("story-designer 逃逸口Ⅰ正例：needs-designer 求助（带 blocked 的非终态）",
    laneStoryDesigner([tk({ state: "Todo", labels: ["writing-loop", "blocked", "needs-designer"] })], NOW).length > 0);
  check("story-designer 逃逸口Ⅰ反例：终态票残留 needs-designer 不命中",
    laneStoryDesigner([tk({ state: "Done", labels: ["writing-loop", "needs-designer"] })], NOW).length === 0);
  check("story-designer 孤儿正例：In Progress 认领陈旧",
    laneStoryDesigner([tk({ state: "In Progress", labels: sd, assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("story-designer 反例：episode-writer 票不入本 lane",
    laneStoryDesigner([tk({ labels: ["writing-loop", "episode", "episode-writer"] })], NOW).length === 0);
  const legacySource = tk({ labels: ["writing-loop", "Feature", "source-analysis", "story-designer"] });
  check("Source Analyst 正例：新票与 legacy source-analysis 都进入专用车道",
    laneSourceAnalyst([legacySource], NOW).length > 0);
  check("Story Designer 反例：即使 legacy 票仍带 story-designer 也不得抢原著分析",
    laneStoryDesigner([legacySource], NOW).length === 0);
}

function testReviewer(): void {
  check("reviewer 正例：∃ In Review（owner=showrunner 的 punch-up 也算——A-3 双签保守超集）",
    laneReviewer([tk({ state: "In Review", labels: ["writing-loop", "Improvement", "punch-up", "showrunner"] })], NOW, false).length > 0);
  check("reviewer 逃逸口Ⅰ正例：needs-reviewer",
    laneReviewer([tk({ state: "Todo", labels: ["writing-loop", "blocked", "needs-reviewer"] })], NOW, false).length > 0);
  check("reviewer 孤儿正例：In Review 认领陈旧（§7）",
    laneReviewer([tk({ state: "In Review", assignee: "reviewer (run bb)", updatedMs: NOW - 2 * HOUR })], NOW, false).length > 0);
  check("reviewer Job C 正例：episodes/∪story assets 自上次审计有改动 ⇒ 命中", laneReviewer([], NOW, true).length > 0);
  check("reviewer Job C 保守：diff 不可判（git 失败/base 无效）⇒ 命中", laneReviewer([], NOW, null).length > 0);
  check("reviewer 反例：板空 + 零 diff ⇒ 谓词为空", laneReviewer([], NOW, false).length === 0);
  check("reviewer 反例：Todo 票不触发（验收门只看 In Review）",
    laneReviewer([tk({ state: "Todo", labels: ["writing-loop", "episode", "reviewer"] })], NOW, false).length === 0);
  check("reviewer 主进件排除 blocked：In Review+owner:reviewer+blocked（§9 停靠）不命中（WLSYS-6267a4c）",
    laneReviewer([tk({ state: "In Review", owner: "reviewer", labels: ["writing-loop", "Feature", "episode", "reviewer", "episode-writer", "blocked"] })], NOW, false).length === 0);
  check("reviewer 主进件排除 blocked：In Review+punch-up+blocked 同样不命中",
    laneReviewer([tk({ state: "In Review", labels: ["writing-loop", "Improvement", "punch-up", "showrunner", "blocked"] })], NOW, false).length === 0);
  check("reviewer 逃逸口Ⅰ不受收窄：In Review+blocked+needs-reviewer 仍命中",
    laneReviewer([tk({ state: "In Review", labels: ["writing-loop", "reviewer", "blocked", "needs-reviewer"] })], NOW, false).length > 0);
  check("reviewer 孤儿口不受收窄：In Review+blocked+认领陈旧仍命中",
    laneReviewer([tk({ state: "In Review", labels: ["writing-loop", "reviewer", "blocked"], assignee: "reviewer (run bb)", updatedMs: NOW - 2 * HOUR })], NOW, false).length > 0);
  // 主进件对齐 SKILL §0 逐字：Job A = In Review + owner:reviewer；A-3 = In Review + punch-up。
  // owner=showrunner 的设计/裁定票在 In Review 等的是 showrunner 大纲门，reviewer 命中它只会
  // 全 boot 后判「不属审读门 lane」（yujing-jiushi YJJS-97 实测）。owner 缺失 ⇒ 保守命中。
  check("reviewer 主进件：In Review+owner:showrunner（设计票等大纲门）不命中",
    laneReviewer([tk({ state: "In Review", owner: "showrunner", labels: ["writing-loop", "Bug", "continuity", "showrunner", "story-designer"] })], NOW, false).length === 0);
  check("reviewer 主进件：In Review+owner:reviewer 命中",
    laneReviewer([tk({ state: "In Review", owner: "reviewer", labels: ["writing-loop", "Feature", "episode", "reviewer", "episode-writer"] })], NOW, false).length > 0);
  check("reviewer 主进件：In Review+owner 缺失 ⇒ 保守命中",
    laneReviewer([tk({ state: "In Review", owner: null, labels: ["writing-loop", "Feature", "episode", "reviewer", "episode-writer"] })], NOW, false).length > 0);
}

function testEvaluator(): void {
  const me = ["writing-loop", "Feature", "milestone-eval", "showrunner"];
  check("evaluator 正例：∃ Todo+milestone-eval", laneEvaluator([tk({ labels: me })], NOW).length > 0);
  check("evaluator 主进件排除 blocked：Todo+milestone-eval+blocked 不命中（WLSYS-6267a4c；与 Job 0 拾取过滤一致）",
    laneEvaluator([tk({ labels: [...me, "blocked"] })], NOW).length === 0);
  check("evaluator 孤儿口不受 blocked 收窄：In Progress+blocked+认领陈旧仍命中",
    laneEvaluator([tk({ state: "In Progress", labels: [...me, "blocked"], assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("evaluator 孤儿正例：In Progress+milestone-eval 认领陈旧",
    laneEvaluator([tk({ state: "In Progress", labels: me, assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW).length > 0);
  check("evaluator 孤儿反例：认领新鲜不命中",
    laneEvaluator([tk({ state: "In Progress", labels: me, assignee: "x", updatedMs: NOW - 5 * MIN })], NOW).length === 0);
  check("evaluator 反例：无 milestone-eval 票 ⇒ 空",
    laneEvaluator([tk({ labels: ["writing-loop", "Feature", "episode", "episode-writer"] })], NOW).length === 0);
}

function testShowrunner(): void {
  const cur = { board: "H1", northStar: "N1" };
  check("showrunner 正例：无基线（首评估）⇒ 已变", laneShowrunner([], NOW, cur, null).length > 0);
  check("showrunner 反例：基线相等且无墙钟枝 ⇒ 空", laneShowrunner([], NOW, cur, { ...cur }).length === 0);
  check("showrunner 正例：板快照哈希变化", laneShowrunner([], NOW, cur, { board: "H0", northStar: "N1" }).length > 0);
  check("showrunner 正例：north-star 哈希变化（doc-watch）", laneShowrunner([], NOW, cur, { board: "H1", northStar: "N0" }).length > 0);
  const blockedByDone = [
    tk({ id: "WL-30", state: "Todo", labels: ["writing-loop", "blocked"], blockedBy: ["WL-31"] }),
    tk({ id: "WL-31", state: "Done" }),
  ];
  check("showrunner 正例：∃ blocked 票其 Blocked-by 目标已 Done（§21 resolver）",
    laneShowrunner(blockedByDone, NOW, cur, { ...cur }).length > 0);
  const blockedByOpen = [
    tk({ id: "WL-30", state: "Todo", labels: ["writing-loop", "blocked"], blockedBy: ["WL-31"] }),
    tk({ id: "WL-31", state: "Todo" }),
  ];
  check("showrunner 反例：Blocked-by 目标未 Done ⇒ 不动",
    laneShowrunner(blockedByOpen, NOW, cur, { ...cur }).length === 0);
  const park = (notifiedMs: number | null, o: Partial<LaneTicket> = {}): LaneTicket =>
    tk({ state: "Todo", labels: ["writing-loop", "blocked", "needs-showrunner", "external-prereq"], notifiedMs, ...o });
  check("showrunner 正例：停靠票最新 Notified: >24h（WL-44 墙钟谓词）",
    laneShowrunner([park(NOW - 25 * HOUR)], NOW, cur, { ...cur }).length > 0);
  check("showrunner 反例：Notified: <24h ⇒ 不提醒", laneShowrunner([park(NOW - HOUR)], NOW, cur, { ...cur }).length === 0);
  check("showrunner 正例：停靠票无任何 Notified: 且 >24h 未动 ⇒ 命中（首通知漏发保守面）",
    laneShowrunner([park(null, { updatedMs: NOW - 25 * HOUR, mtimeMs: NOW - 25 * HOUR })], NOW, cur, { ...cur }).length > 0);
  check("showrunner 正例：Notified: 未来戳 ⇒ stale-可疑命中",
    laneShowrunner([park(NOW + 25 * HOUR)], NOW, cur, { ...cur }).length > 0);
}

function testSweep(): void {
  const fresh = NOW - 5 * MIN;
  // 标齐 owner+tier 的整洁票（错标即时枝的反面基底）
  const clean: Partial<LaneTicket> = { owner: "reviewer", labels: ["writing-loop", "Feature", "episode", "episode-writer"] };
  check("sweep 正例：∃ In Progress", laneSweep([tk({ state: "In Progress", ...clean })], NOW, false, fresh).length > 0);
  check("sweep 正例：∃ .lock（板/剧情资产/repo）", laneSweep([], NOW, true, fresh).length > 0);
  check("sweep 保守：锁扫描不可判 ⇒ 命中", laneSweep([], NOW, null, fresh).length > 0);
  const ks = ["writing-loop", "Feature", "episode", "keystone", "reviewer", "story-designer"];
  check("sweep 正例：keystone-stall（In Review 停滞 >30min，§1 护栏）",
    laneSweep([tk({ state: "In Review", owner: "reviewer", labels: ks, updatedMs: NOW - 31 * MIN })], NOW, false, fresh).length > 0);
  check("sweep 反例：keystone In Review 未满 30min 不算 stall",
    laneSweep([tk({ state: "In Review", owner: "reviewer", labels: ks, updatedMs: NOW - 10 * MIN })], NOW, false, fresh).length === 0);
  check("sweep 正例：兜底节拍——距上次 sweep fire >30min", laneSweep([], NOW, false, NOW - 31 * MIN).length > 0);
  check("sweep 保守：上次 fire 无从考证 ⇒ 命中", laneSweep([], NOW, false, null).length > 0);
  check("sweep 反例：板整洁/无锁/无 stall/节拍未到 ⇒ 空", laneSweep([tk({ state: "Todo", ...clean })], NOW, false, fresh).length === 0);
  // Fix 轮 1 minor：错标即时枝（SKILL §0 逃逸口②前半）直接机械实现，不再靠 cadence 兜底
  check("sweep 错标即时枝：非终态票缺全部十个 tier 标签 ⇒ 命中",
    laneSweep([tk({ state: "Todo", owner: "reviewer", labels: ["writing-loop", "episode"] })], NOW, false, fresh).length > 0);
  check("sweep 错标即时枝：owner 字段缺失 ⇒ 命中",
    laneSweep([tk({ state: "Todo", labels: ["writing-loop", "episode-writer"] })], NOW, false, fresh).length > 0);
  check("sweep 错标反例：终态票缺标不入卫生面",
    laneSweep([tk({ state: "Done" })], NOW, false, fresh).length === 0);
  // Fix 轮 1 minor：cadence 阈值随 config 调短跟进（laneSweep 第 5 参；min 上界在 evalLaneGate）
  check("sweep cadence 随 config 缩短：阈值 10min 时 12min 前的干净 fire 即到点",
    laneSweep([], NOW, false, NOW - 12 * MIN, 10 * MIN).length > 0);
  check("sweep cadence 随 config 缩短反例：阈值 10min、5min 前刚跑过 ⇒ 空",
    laneSweep([], NOW, false, NOW - 5 * MIN, 10 * MIN).length === 0);
  const source: Partial<LaneTicket> = { owner: "story-designer",
    labels: ["writing-loop", "Feature", "source-analysis", "story-designer"] };
  check("sweep 原著专注模式：新鲜 In Progress + 正常 repo lock + cadence 到期仍不打断写作",
    laneSweep([tk({ state: "In Progress", assignee: "story-designer (run source)",
      updatedMs: NOW - 5 * MIN, ...source })], NOW, true, NOW - HOUR).length === 0);
  check("sweep 原著专注模式：认领陈旧仍作为孤儿恢复候选",
    laneSweep([tk({ state: "In Progress", assignee: "story-designer (run source)",
      updatedMs: NOW - 2 * HOUR, ...source })], NOW, true, NOW - HOUR).length > 0);
  check("sweep 原著专注模式：Todo 时遗留 lock 仍需清理",
    laneSweep([tk({ state: "Todo", ...source })], NOW, true, NOW - HOUR).length > 0);
}

function testMarketWatch(): void {
  check("market 基线：state 缺失/lastRun 不可解析 ⇒ spawn", laneMarketWatch([], NOW, null, null).length > 0);
  check("market 反例：仅时间流逝一年也不自动复跑", laneMarketWatch([], NOW, NOW - 365 * DAY, null).length === 0);
  check("market 正例：显式合法 Todo+market 请求", laneMarketWatch([
    tk({ state: "Todo", labels: ["writing-loop", "Improvement", "market", "showrunner"] }),
  ], NOW, NOW - DAY, null).length > 0);
  check("market 回归：agent 名 market-watch 不是合法票标签，不能承载刷新请求", laneMarketWatch([
    tk({ state: "Todo", labels: ["writing-loop", "Improvement", "market-watch", "showrunner"] }),
  ], NOW, NOW - DAY, null).length === 0);
  check("market 反例：人工停靠的 market 票不应被拾取", laneMarketWatch([
    tk({ state: "Todo", labels: ["writing-loop", "Improvement", "market", "showrunner", "blocked"] }),
  ], NOW, NOW - DAY, null).length === 0);
  check("market 正例：孤儿 In Progress 可恢复", laneMarketWatch([
    tk({ state: "In Progress", labels: ["writing-loop", "Improvement", "market", "showrunner"],
      assignee: "market-watch", updatedMs: NOW - 2 * HOUR }),
  ], NOW, NOW - DAY, null).length > 0);
  check("market 正例：marketDataPath 有新内容（mtime 越过 lastRun）",
    laneMarketWatch([], NOW, NOW - DAY, NOW - HOUR).length > 0);
  check("market 反例：投喂内容早于 lastRun ⇒ 空", laneMarketWatch([], NOW, NOW - DAY, NOW - 2 * DAY).length === 0);
  check("market 正例：lastRun 未来戳 ⇒ stale-可疑命中", laneMarketWatch([], NOW, NOW + DAY, null).length > 0);
}

function testScriptDoctor(): void {
  check("doctor 保守：state 缺失/lastAuditSha null 首跑 ⇒ 失败开", laneScriptDoctor([], NOW, "abc123", null).length > 0);
  check("doctor 保守：git 读不到 ⇒ 失败开", laneScriptDoctor([], NOW, null, "abc123").length > 0);
  check("doctor 正例：episodes/ SHA 变化", laneScriptDoctor([], NOW, "bbb", "aaa").length > 0);
  check("doctor 反例：SHA 未变（全长）⇒ 空", laneScriptDoctor([], NOW, "aaa", "aaa").length === 0);
  check("doctor 反例：短/长 sha 前缀互认 ⇒ 空", laneScriptDoctor([], NOW, "a22529f35cf2f5400e", "a22529f").length === 0);
  check("doctor 正例：episodes/ 零 commit（\"\"）≠ 已记 sha ⇒ 命中（空值绝不当前缀，§0 空值复算）",
    laneScriptDoctor([], NOW, "", "abc").length > 0);
  check("doctor 孤儿正例：In Progress+script-doctor 认领陈旧",
    laneScriptDoctor([tk({ state: "In Progress", labels: ["writing-loop", "script-doctor"], assignee: "x", updatedMs: NOW - 2 * HOUR })], NOW, "a", "a").length > 0);
  check("shaEq：空串绝不当任意串前缀", !shaEq("", "abc") && !shaEq("abc", "") && shaEq("abcdef", "abc") && shaEq("abc", "abcdef"));
}

function testReflect(): void {
  check("reflect 保守：state 缺失 ⇒ spawn", laneReflect(NOW, null).length > 0);
  check("reflect 正例：日频窗口到期（≥24h）", laneReflect(NOW, NOW - 25 * HOUR).length > 0);
  check("reflect 反例：窗口未到 ⇒ 空", laneReflect(NOW, NOW - 2 * HOUR).length === 0);
  check("reflect 正例：上次 retro 未来戳 ⇒ stale-可疑命中", laneReflect(NOW, NOW + HOUR).length > 0);
}

// ---------------------------------------------------------------------------
// 3. 逃逸口Ⅲ报告结算（真实文件 + utimes 控制 mtime）
// ---------------------------------------------------------------------------
function testReportsEscape(): void {
  check("周界计算：2026-07-15（周三）⇒ 周一 07-13 00:00Z",
    lastWeeklyBoundaryMs(NOW) === Date.parse("2026-07-13T00:00:00Z"));
  check("月界计算：⇒ 07-01 00:00Z", lastMonthlyBoundaryMs(NOW) === Date.parse("2026-07-01T00:00:00Z"));

  const ws = tmp();
  const rdir = join(ws, "reports");
  check("reports/ 不存在（ENOENT）⇒ 可证明的空，不命中", reportsEscape(rdir, NOW, null) === null);
  mkdirSync(rdir, { recursive: true });
  check("reports/ 空目录 ⇒ 不命中", reportsEscape(rdir, NOW, NOW - HOUR) === null);

  // 点评分发：mtime × 上次干净 fire 时刻收敛（存在性判定会因「点评永不删除」永久假命中）
  const rev = join(rdir, "2026-07-14.review.md");
  writeFileSync(rev, "点评");
  touch(rev, NOW - HOUR);
  check("点评正例：*.review.md 晚于上次干净 fire ⇒ 命中", (reportsEscape(rdir, NOW, NOW - 2 * HOUR) ?? "").includes("点评"));
  check("点评保守：上次干净 fire 无从考证 ⇒ 命中", reportsEscape(rdir, NOW, null) !== null);
  check("点评反例：该 agent 干净 fire 已晚于点评 mtime ⇒ 收敛不再命中", reportsEscape(rdir, NOW, NOW - 30 * MIN) === null);
  rmSync(rev);

  // weekly：上周 daily 在界前 + agent 上次干净 fire 也在界前 ⇒ 命中一次；fire 过界后收敛
  const daily = join(rdir, "2026-07-12.md");
  writeFileSync(daily, "daily");
  touch(daily, Date.parse("2026-07-12T23:00:00Z"));
  const beforeBoundary = Date.parse("2026-07-12T23:30:00Z");
  check("weekly 正例：界前 daily + 界前 lastClean ⇒ 到期命中",
    (reportsEscape(rdir, NOW, beforeBoundary) ?? "").includes("weekly"));
  check("weekly 反例：agent 已在界后干净 fire ⇒ 收敛", reportsEscape(rdir, NOW, Date.parse("2026-07-14T00:00:00Z")) === null);

  // monthly：取月初为「现在」，令 weekly 界（06-29 周一）≤ daily mtime < 月界（07-01）以隔离 monthly 枝
  const NOW2 = Date.parse("2026-07-01T12:00:00Z");
  touch(daily, Date.parse("2026-06-29T06:00:00Z"));
  check("monthly 正例：月界已跨、daily 在界前 ⇒ 到期命中",
    (reportsEscape(rdir, NOW2, Date.parse("2026-06-30T00:00:00Z")) ?? "").includes("monthly"));
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. evalLaneGate 集成（真实临时目录）：单向安全边缘形态 + state/git 接缝 + 锁扫描
// ---------------------------------------------------------------------------
type IoOver = { nowMs?: number; lastCleanEndMs?: number | null; marketDataPath?: string | null;
  sweepIntervalMs?: number | null;
  showrunnerBaseline?: { board: string; northStar: string } | null;
  gitSha?: (r: string, ...p: string[]) => string | null;
  gitDiff?: (r: string, base: string, paths: readonly string[]) => boolean | null;
  episodeScripts?: (r: string) => boolean | null };

function gateWorld(): { ws: string; boardDir: string; projData: string; repo: string; io: (o?: IoOver) => Parameters<typeof evalLaneGate>[1] } {
  const ws = tmp();
  const projData = join(ws, ".writing-loop", "t1");
  const boardDir = join(projData, "board", "tickets");
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  const io = (o: IoOver = {}): Parameters<typeof evalLaneGate>[1] => ({
    nowMs: NOW, boardDir, projData, repoPath: repo,
    lastCleanEndMs: NOW - 5 * MIN, gitSha: () => "sha0", ...o,
  });
  return { ws, boardDir, projData, repo, io };
}

function testEdgeShapeUnidirectional(): void {
  const w = gateWorld();
  // 有活但 frontmatter 边缘形态（block labels + 引号 state + CRLF）⇒ 必须放行
  mkdirSync(w.boardDir, { recursive: true });
  writeFileSync(join(w.boardDir, "WL-8.md"),
    '---\r\nid: WL-8\r\nstate: "Todo"\r\nlabels:\r\n  - writing-loop\r\n  - Feature\r\n  - episode\r\n  - "episode-writer"\r\nupdated: 2026-07-15T11:59:00Z\r\n---\r\nEpisode: 3\r\n');
  const g1 = evalLaneGate("episode-writer", w.io());
  check("单向安全：有活但边缘形态（block labels/引号/CRLF）⇒ 门控放行", g1.open, g1.reasons.join("；"));

  // Fix 轮 1 critical①回归：零缩进 block 的**真活票**必须经 labels 主枝放行（不是 malformed
  // 兜底）——旧解析把它读成空 labels 且 malformed=false ⇒ 假跳过，票可搁置至偶发放行。
  writeFileSync(join(w.boardDir, "WL-8.md"),
    "---\nid: WL-8\ntitle: ep-003 写作\nstate: Todo\nowner: reviewer\nlabels:\n- writing-loop\n- Feature\n- episode\n- reviewer\n- episode-writer\nupdated: 2026-07-15T11:59:00Z\n---\nEpisode: 3\n");
  const g1z = evalLaneGate("episode-writer", w.io());
  check("单向安全：零缩进 block 真活票 ⇒ 经「∃ Todo+episode-writer」主枝放行",
    g1z.open && g1z.reasons.some((r) => r.includes("∃ Todo+episode-writer")), g1z.reasons.join("；"));

  // 解析不出的票 ⇒ 对全部 agent 保守放行（连零板依赖的 market-watch 也放行——统一安全不变量）
  writeFileSync(join(w.boardDir, "WL-9.md"), "---\nid: WL-9\nstate: Todo\nlabels: {oops\n---\nbody\n");
  mkdirSync(join(w.projData, "state"), { recursive: true });
  writeFileSync(join(w.projData, "state", "market-state.json"),
    JSON.stringify({ lastRun: new Date(NOW - DAY).toISOString() }));
  const g2 = evalLaneGate("market-watch", w.io());
  check("单向安全：malformed 票 ⇒ 对全部 agent 保守放行（market-watch 亦然）",
    g2.open && g2.reasons.some((r) => r.includes("边缘形态")), g2.reasons.join("；"));
  const g3 = evalLaneGate("evaluator", w.io());
  check("单向安全：malformed 票 ⇒ evaluator 放行", g3.open);

  // 无闭合 fence 同判
  writeFileSync(join(w.boardDir, "WL-9.md"), "---\nid: WL-9\nstate: Todo\n没有闭合 fence\n");
  check("单向安全：无闭合 fence ⇒ 放行", evalLaneGate("reflect", { ...w.io(), }).open);
  rmSync(w.ws, { recursive: true, force: true });

  // 板目录整个不存在 = 可证明的空板 ⇒ episode-writer 正常 gated（不是含糊）
  const w2 = gateWorld();
  mkdirSync(join(w2.projData, "state"), { recursive: true });
  writeFileSync(join(w2.projData, "state", "reflect-state.json"),
    JSON.stringify({ lastRetro: new Date(NOW - HOUR).toISOString() }));
  const g4 = evalLaneGate("episode-writer", w2.io());
  check("空板（目录 ENOENT）⇒ episode-writer 正常 gated", !g4.open, g4.reasons.join("；"));
  const g5 = evalLaneGate("reflect", w2.io());
  check("reflect：窗口未到 + 无板依赖 ⇒ gated", !g5.open, g5.reasons.join("；"));
  check("未知 agent ⇒ 保守放行", evalLaneGate("nonesuch", w2.io()).open);
  rmSync(w2.ws, { recursive: true, force: true });
}

function testStateAndGitSeams(): void {
  const w = gateWorld();
  mkdirSync(join(w.projData, "state"), { recursive: true });

  // reviewer Job C：state sha × git diff 接缝（Fix 轮 1 major④：现行判据 =
  // git diff <prev>..HEAD -- episodes/ story/assets.v1.json，任一非空即开门）
  writeFileSync(join(w.projData, "state", "reviewer-state.json"),
    JSON.stringify({ lastAuditedEpisodesSha: "aaa111" }));
  const diffSpy: string[][] = [];
  const spy = (ret: boolean | null) => (_r: string, base: string, paths: readonly string[]): boolean | null => {
    diffSpy.push([base, ...paths]);
    return ret;
  };
  check("reviewer：episodes/∪story assets 零 diff ⇒ gated", !evalLaneGate("reviewer", w.io({ gitDiff: spy(false) })).open);
  check("reviewer：diff 判据收到旧 schema fallback 基点 + 双 pathspec",
    diffSpy.length === 1 && diffSpy[0].join(" ") === "aaa111 episodes/ story/assets.v1.json", JSON.stringify(diffSpy));
  check("reviewer：有 diff（assets-only 修订同样可见）⇒ open", evalLaneGate("reviewer", w.io({ gitDiff: spy(true) })).open);
  check("reviewer：diff 不可判（git 失败/base 无效）⇒ 保守 open", evalLaneGate("reviewer", w.io({ gitDiff: spy(null) })).open);
  writeFileSync(join(w.projData, "state", "reviewer-state.json"),
    JSON.stringify({ lastAuditSha: "ccc333", lastAuditedEpisodesSha: "aaa111" }));
  diffSpy.length = 0;
  evalLaneGate("reviewer", w.io({ gitDiff: spy(false) }));
  check("reviewer：基点键序对齐 gateNote——lastAuditSha 优先于旧 lastAuditedEpisodesSha",
    diffSpy.length === 1 && diffSpy[0][0] === "ccc333", JSON.stringify(diffSpy));
  // WLSYS-f5482b7a 回归①：reviewer agent 实际写入的键是 lastAuditedSha（yujing-jiushi
  // state/reviewer-state.json 实测形：{version, lastAuditedSha, lastAuditedAt, auditedEpisodes,
  // note}）。修复前调度器只读 lastAuditSha/lastAuditedEpisodesSha ⇒ prev 恒 null ⇒ 走首跑分支
  // ⇒ 有正文的项目恒开门（528 fire 中 254 次白 boot）。
  writeFileSync(join(w.projData, "state", "reviewer-state.json"), JSON.stringify({
    version: 1, lastAuditedSha: "e4a7f8a", lastAuditedAt: "2026-08-15T05:14:31Z", auditedEpisodes: [1, 2, 3],
  }));
  diffSpy.length = 0;
  const gAgentKey = evalLaneGate("reviewer", w.io({ gitDiff: spy(false), gitSha: () => "scaffold-sha" }));
  check("reviewer：agent 实写键 lastAuditedSha 被当作 diff 基点（不落首跑分支）",
    diffSpy.length === 1 && diffSpy[0][0] === "e4a7f8a", JSON.stringify(diffSpy));
  check("reviewer：lastAuditedSha 基点后零 diff ⇒ gated（修复前恒 open）", !gAgentKey.open, gAgentKey.reasons.join("；"));
  writeFileSync(join(w.projData, "state", "reviewer-state.json"),
    JSON.stringify({ lastAuditedSha: "new111", lastAuditSha: "old222" }));
  diffSpy.length = 0;
  evalLaneGate("reviewer", w.io({ gitDiff: spy(false) }));
  check("reviewer：键序 lastAuditedSha（现行实写）> lastAuditSha（旧）",
    diffSpy.length === 1 && diffSpy[0][0] === "new111", JSON.stringify(diffSpy));
  rmSync(join(w.projData, "state", "reviewer-state.json"));
  check("reviewer：state 缺失 + episodes/∪story assets 确证零 commit ⇒ 可证明无活，gated",
    !evalLaneGate("reviewer", w.io({ gitSha: () => "" })).open);
  // WLSYS-f5482b7a 回归②：首跑分支须与 doctor 分支同款 hasEpisodeScripts 守卫——立项 scaffold
  // 的 episodes/.gitkeep 让 pathspec SHA 非空，但确无 ep-NNN.md ⇒ 可证明无 Job C 活。
  check("reviewer：state 缺失 + 只有 scaffold（无 ep-*.md）⇒ 即使 pathspec 有 commit 也 gated",
    !evalLaneGate("reviewer", w.io({ gitSha: () => "scaffold-sha", episodeScripts: () => false })).open);
  check("reviewer：state 缺失 + 有正文 + 有 commit ⇒ 保守 open",
    evalLaneGate("reviewer", w.io({ gitSha: () => "abc", episodeScripts: () => true })).open);
  check("reviewer：state 缺失 + episodes 目录不可判 ⇒ 保守 open",
    evalLaneGate("reviewer", w.io({ gitSha: () => "abc", episodeScripts: () => null })).open);
  check("reviewer：state 缺失 + 有 commit ⇒ 保守 open",
    evalLaneGate("reviewer", w.io({ gitSha: () => "abc" })).open);

  // doctor：失败开 + 前缀互认
  check("doctor：state 缺失且已有正文 ⇒ 失败开 open",
    evalLaneGate("script-doctor", w.io({ gitSha: () => "abc", episodeScripts: () => true })).open);
  check("doctor：只有 scaffold、无 ep-*.md ⇒ state 缺失也在 spawn 前 gated",
    !evalLaneGate("script-doctor", w.io({ gitSha: () => "abc", episodeScripts: () => false })).open);
  check("doctor：episodes 目录不可判 ⇒ 保守 open",
    evalLaneGate("script-doctor", w.io({ gitSha: () => "abc", episodeScripts: () => null })).open);
  writeFileSync(join(w.projData, "state", "doctor-state.json"), JSON.stringify({ lastAuditSha: "abc123", cursor: 3 }));
  check("doctor：sha 前缀互认 ⇒ gated",
    !evalLaneGate("script-doctor", w.io({ gitSha: () => "abc123def456", episodeScripts: () => true })).open);
  check("doctor：sha 变 ⇒ open",
    evalLaneGate("script-doctor", w.io({ gitSha: () => "fff", episodeScripts: () => true })).open);
  writeFileSync(join(w.projData, "state", "doctor-state.json"), JSON.stringify({ lastAuditSha: null, cursor: 0 }));
  check("doctor：lastAuditSha 为 null 且已有正文的首跑 ⇒ 失败开 open",
    evalLaneGate("script-doctor", w.io({ gitSha: () => "abc", episodeScripts: () => true })).open);

  // market：真实投喂文件 mtime × lastRun
  writeFileSync(join(w.projData, "state", "market-state.json"),
    JSON.stringify({ lastRun: new Date(NOW - DAY).toISOString() }));
  writeFileSync(join(w.projData, "state", "market-assessment.md"), "# 市场基线\n");
  const feed = join(w.ws, "market-feed");
  mkdirSync(feed, { recursive: true });
  const feedFile = join(feed, "榜单.md");
  writeFileSync(feedFile, "hot");
  touch(feedFile, NOW - 2 * DAY);
  touch(feed, NOW - 2 * DAY);
  check("market：投喂内容早于 lastRun ⇒ gated", !evalLaneGate("market-watch", w.io({ marketDataPath: feed })).open);
  touch(feedFile, NOW - HOUR);
  check("market：投喂目录出现新内容 ⇒ open", evalLaneGate("market-watch", w.io({ marketDataPath: feed })).open);
  check("market：state 缺字段 ⇒ 保守 open", (() => {
    writeFileSync(join(w.projData, "state", "market-state.json"), JSON.stringify({ signals: {} }));
    return evalLaneGate("market-watch", w.io()).open;
  })());
  writeFileSync(join(w.projData, "state", "market-state.json"),
    JSON.stringify({ lastRun: new Date(NOW - 365 * DAY).toISOString() }));
  check("market：基线再旧也不会仅因时间流逝而 open", !evalLaneGate("market-watch", w.io()).open);
  const reportsDir = join(w.projData, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const oldDaily = join(reportsDir, "2026-07-01.md");
  writeFileSync(oldDaily, "# old daily\n");
  touch(oldDaily, NOW - 14 * DAY);
  check("market：旧日报跨周/月也不会自动唤醒 LLM",
    !evalLaneGate("market-watch", w.io({ lastCleanEndMs: NOW - 14 * DAY })).open);
  const operatorReview = join(reportsDir, "market.review.md");
  writeFileSync(operatorReview, "请按新的发行平台刷新市场基线。\n");
  touch(operatorReview, NOW - HOUR);
  check("market：人工点评仍是明确刷新输入",
    evalLaneGate("market-watch", w.io({ lastCleanEndMs: NOW - 2 * HOUR })).open);
  rmSync(operatorReview);

  const storyTicket = join(w.boardDir, "WL-STORY.md");
  mkdirSync(w.boardDir, { recursive: true });
  writeFileSync(storyTicket, `---\nid: WL-STORY\ntitle: 设计第一季\nstate: Todo\nowner: story-designer\n` +
    `labels: [writing-loop, Feature, story-designer]\nassignee: null\nupdated: 2026-07-15T11:00:00Z\n---\n`);
  rmSync(join(w.projData, "state", "market-assessment.md"), { force: true });
  check("story-designer：市场基线缺失时即使有 Todo 也 gated", !evalLaneGate("story-designer", w.io()).open);
  check("market：只有 lastRun 而评估正文缺失时重新建立基线", evalLaneGate("market-watch", w.io()).open);
  writeFileSync(join(w.projData, "state", "market-assessment.md"), "# 市场基线\n");
  check("story-designer：市场基线形成后 Todo lane 打开", evalLaneGate("story-designer", w.io()).open);
  check("story-designer：新投喂资料尚未刷新时保持 gated", !evalLaneGate("story-designer", w.io({ marketDataPath: feed })).open);
  const marketTicket = join(w.boardDir, "WL-MARKET.md");
  writeFileSync(marketTicket, `---\nid: WL-MARKET\ntitle: 更新发行市场\nstate: Todo\nowner: showrunner\n` +
    `labels: [writing-loop, Improvement, market, showrunner]\nassignee: null\nupdated: 2026-07-15T11:00:00Z\n---\n`);
  check("story-designer：显式市场更新未完成时保持 gated", !evalLaneGate("story-designer", w.io()).open);
  check("market：显式市场更新 Ticket 立即打开", evalLaneGate("market-watch", w.io()).open);
  writeFileSync(marketTicket, `---\nid: WL-MARKET\ntitle: 更新发行市场\nstate: Todo\nowner: showrunner\n` +
    `labels: [writing-loop, Improvement, market, showrunner, blocked, needs-showrunner, external-prereq]\n` +
    `assignee: null\nupdated: 2026-07-15T11:00:00Z\n---\n`);
  check("market 回归：人工停靠的合法 market 票不启动 Market Watch", !evalLaneGate("market-watch", w.io()).open);
  check("market 回归：人工停靠的 market 票不冻结已有市场基线后的创作车道",
    evalLaneGate("story-designer", w.io()).open);

  // reflect：字段别名与到期
  writeFileSync(join(w.projData, "state", "reflect-state.json"),
    JSON.stringify({ lastRetro: new Date(NOW - 25 * HOUR).toISOString() }));
  check("reflect：窗口到期 ⇒ open", evalLaneGate("reflect", w.io()).open);
  mkdirSync(w.boardDir, { recursive: true });
  const sourceTicket = (state: "Todo" | "In Review"): string =>
    `---\nid: WL-SOURCE\ntitle: 分析原著\nstate: ${state}\nowner: story-designer\n` +
    `labels: [writing-loop, Feature, source-analysis, story-designer]\n` +
    `assignee: null\nupdated: 2026-07-15T11:00:00Z\n---\n`;
  writeFileSync(join(w.boardDir, "WL-SOURCE.md"), sourceTicket("Todo"));
  check("reflect：原著分析 Todo 期间即使日频到期也 gated",
    !evalLaneGate("reflect", w.io()).open);
  writeFileSync(join(w.boardDir, "WL-SOURCE.md"), sourceTicket("In Review"));
  check("reflect：原著分析进入 In Review 后恢复日频回顾",
    evalLaneGate("reflect", w.io()).open);
  rmSync(w.ws, { recursive: true, force: true });
}

// Fix 轮 1 critical②回归：reflect 的「lessons 迁移待办（§14）」逃逸口——skill 写了、TS 必须
// 实现；窗口内（anti-thrash 关门）也必须被迁移残留唤醒（真实临时目录两形态各一例）。
function testReflectLessonsMigration(): void {
  const w = gateWorld();
  mkdirSync(join(w.projData, "state"), { recursive: true });
  writeFileSync(join(w.projData, "state", "reflect-state.json"),
    JSON.stringify({ lastRetro: new Date(NOW - HOUR).toISOString() }));  // 日频窗口内 ⇒ 仅迁移枝能开门
  check("reflect：窗口内且无迁移残留 ⇒ gated（基底）", !evalLaneGate("reflect", w.io()).open);
  writeFileSync(join(w.projData, "lessons.md"), "## Shared\n- x\n## reflect\n- y\n");
  const g1 = evalLaneGate("reflect", w.io());
  check("reflect 迁移待办：lessons.md 在、lessons/ 缺失 ⇒ 窗口内也 open",
    g1.open && g1.reasons.some((r) => r.includes("迁移待办")), g1.reasons.join("；"));
  mkdirSync(join(w.projData, "lessons"), { recursive: true });
  writeFileSync(join(w.projData, "lessons", "shared.md"), "- x\n");
  const g2 = evalLaneGate("reflect", w.io());
  check("reflect 迁移残态：lessons/ 已建而 lessons.md 未改名 .migrated ⇒ open",
    g2.open && g2.reasons.some((r) => r.includes("残态")), g2.reasons.join("；"));
  // 迁移完成形：旧文件已改名 .migrated ⇒ 两次 stat 均不再命中
  rmSync(join(w.projData, "lessons.md"));
  writeFileSync(join(w.projData, "lessons.md.migrated"), "## Shared\n- x\n");
  check("reflect：迁移完成（lessons/ 在、旧文件已改名）⇒ gated", !evalLaneGate("reflect", w.io()).open);
  rmSync(w.ws, { recursive: true, force: true });
}

// 结构化资产-only 修订必须对 Job C change-gate 可见。真 git 仓库、不注接缝。
function testJobCStructuredAssetsOnlyCommit(): void {
  const w = gateWorld();
  const g = (...a: string[]): { status: number | null; stdout: string } => {
    const r = spawnSync("git", ["-C", w.repo, "-c", "user.email=t@t.t", "-c", "user.name=t",
      "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", timeout: 15_000 });
    return { status: r.status, stdout: (r.stdout ?? "").trim() };
  };
  if (g("--version").status !== 0) {
    check("Job C assets-only：本机无 git —— 门控本会保守放行，用例跳过", true);
    rmSync(w.ws, { recursive: true, force: true });
    return;
  }
  const io = { nowMs: NOW, boardDir: w.boardDir, projData: w.projData, repoPath: w.repo, lastCleanEndMs: NOW - 5 * MIN };
  g("init", "-q");
  mkdirSync(join(w.repo, "episodes"), { recursive: true });
  writeFileSync(join(w.repo, "episodes", "ep-001.md"), "第 1 集\n");
  g("add", "-A"); g("commit", "-q", "-m", "ep-001");
  const base = g("rev-parse", "HEAD").stdout;
  mkdirSync(join(w.projData, "state"), { recursive: true });
  writeFileSync(join(w.projData, "state", "reviewer-state.json"), JSON.stringify({ lastAuditSha: base }));
  check("Job C（真 git）：审计基点后零改动 ⇒ gated", !evalLaneGate("reviewer", io).open);
  mkdirSync(join(w.repo, "story"), { recursive: true });
  writeFileSync(join(w.repo, "story", "assets.v1.json"), "{\"revision\":1}\n");
  g("add", "-A"); g("commit", "-q", "-m", "structured-assets-only 修订");
  const gOpen = evalLaneGate("reviewer", io);
  check("Job C（真 git）：structured-assets-only commit ⇒ open",
    gOpen.open && gOpen.reasons.some((r) => r.includes("Job C")), gOpen.reasons.join("；"));
  writeFileSync(join(w.projData, "state", "reviewer-state.json"),
    JSON.stringify({ lastAuditSha: g("rev-parse", "HEAD").stdout.slice(0, 7) }));  // 7 位短 sha 实测形
  check("Job C（真 git）：基点推进到新 HEAD（短 sha）⇒ 收敛 gated", !evalLaneGate("reviewer", io).open);
  writeFileSync(join(w.projData, "state", "reviewer-state.json"), JSON.stringify({ lastAuditSha: "deadbeef" }));
  check("Job C（真 git）：base 无效 ⇒ diff 不可判，保守 open", evalLaneGate("reviewer", io).open);
  rmSync(w.ws, { recursive: true, force: true });
}

// Fix 轮 1 minor：sweep cadence 阈值 = min(config interval, 30min)——操作者调短节律时门控
// 随动；调长不放宽（上界 30min 恒在）。
function testSweepCadenceKnob(): void {
  const w = gateWorld();
  mkdirSync(w.boardDir, { recursive: true });
  check("sweep cadence：interval=10min、12min 前干净 fire ⇒ open（旧固定 30min 会压掉）",
    evalLaneGate("sweep", w.io({ sweepIntervalMs: 10 * MIN, lastCleanEndMs: NOW - 12 * MIN })).open);
  check("sweep cadence：interval=10min、5min 前刚跑过 ⇒ gated",
    !evalLaneGate("sweep", w.io({ sweepIntervalMs: 10 * MIN, lastCleanEndMs: NOW - 5 * MIN })).open);
  check("sweep cadence：interval=2h 也不放宽上界——31min 前干净 fire 即 open",
    evalLaneGate("sweep", w.io({ sweepIntervalMs: 2 * HOUR, lastCleanEndMs: NOW - 31 * MIN })).open);
  check("sweep cadence：interval 缺省（未接线）回落 30min 档，20min 前干净 fire ⇒ gated",
    !evalLaneGate("sweep", w.io({ lastCleanEndMs: NOW - 20 * MIN })).open);
  rmSync(w.ws, { recursive: true, force: true });
}

function testSweepLocksAndShowrunnerBaseline(): void {
  const w = gateWorld();
  mkdirSync(w.boardDir, { recursive: true });
  mkdirSync(join(w.projData, "state"), { recursive: true });

  // sweep：三类锁逐条 + 全清后 gated
  const freshIo = (o: IoOver = {}): Parameters<typeof evalLaneGate>[1] => w.io({ lastCleanEndMs: NOW - 5 * MIN, ...o });
  check("sweep：无锁/无 In Progress/节拍未到 ⇒ gated", !evalLaneGate("sweep", freshIo()).open);
  writeFileSync(join(w.boardDir, "WL-1.md.lock"), "holder pid=1 at 2026-07-15T11:00:00Z\n");
  check("sweep：板票锁 ⇒ open", evalLaneGate("sweep", freshIo()).open);
  rmSync(join(w.boardDir, "WL-1.md.lock"));
  mkdirSync(join(w.repo, ".git"), { recursive: true });
  writeFileSync(join(w.repo, ".git", "story-assets.lock"), "x");
  check("sweep：结构化剧情资产锁 ⇒ open", evalLaneGate("sweep", freshIo()).open);
  rmSync(join(w.repo, ".git", "story-assets.lock"));
  writeFileSync(join(w.repo, ".git", "repo.lock"), "x");
  check("sweep：repo 写锁 ⇒ open", evalLaneGate("sweep", freshIo()).open);
  rmSync(join(w.repo, ".git", "repo.lock"));
  check("sweepLockScan：全清 ⇒ false", sweepLockScan(w.boardDir, w.repo) === false);
  check("sweep：节拍兜底 ⇒ open", evalLaneGate("sweep", freshIo({ lastCleanEndMs: NOW - 31 * MIN })).open);

  // showrunner：基线流转（evalLaneGate 返回的哈希即基线载体）
  writeFileSync(join(w.boardDir, "WL-SOURCE.md"),
    "---\nid: WL-SOURCE\ntitle: 分析原著\nstate: Todo\nowner: story-designer\n" +
    "labels: [writing-loop, Feature, source-analysis, story-designer]\n" +
    "assignee: null\nupdated: 2026-07-15T11:00:00Z\n---\n");
  check("showrunner：原著分析期间无基线也 gated，不占用 Story Designer 的单飞锁",
    !evalLaneGate("showrunner", w.io({ showrunnerBaseline: null })).open);
  rmSync(join(w.boardDir, "WL-SOURCE.md"));
  const g1 = evalLaneGate("showrunner", w.io({ showrunnerBaseline: null }));
  check("showrunner：无基线 ⇒ open 且返回板/north-star 哈希", g1.open && g1.boardHash.length > 0 && g1.northStarHash === "absent");
  const base = { board: g1.boardHash, northStar: g1.northStarHash! };
  check("showrunner：基线相等 ⇒ gated", !evalLaneGate("showrunner", w.io({ showrunnerBaseline: base })).open);
  writeFileSync(join(w.boardDir, "WL-2.md"), "---\nid: WL-2\nstate: Backlog\nlabels: [writing-loop]\n---\nbody\n");
  const g2 = evalLaneGate("showrunner", w.io({ showrunnerBaseline: base }));
  check("showrunner：板出现新票（含 Backlog）⇒ 板快照变化 open", g2.open && g2.reasons.some((r) => r.includes("板快照")));
  const base2 = { board: g2.boardHash, northStar: g2.northStarHash! };
  mkdirSync(join(w.repo, "bible"), { recursive: true });
  writeFileSync(join(w.repo, "bible", "north-star.md"), "# 北极星\n");
  const g3 = evalLaneGate("showrunner", w.io({ showrunnerBaseline: base2 }));
  check("showrunner：north-star 内容变 ⇒ doc-watch open", g3.open && g3.reasons.some((r) => r.includes("north-star")));

  // keystonePending 经新解析核：引号形态也升档；Done 不升
  writeFileSync(join(w.boardDir, "WL-3.md"),
    '---\nid: WL-3\nstate: "In Review"\nlabels: [writing-loop, Feature, episode, "keystone", reviewer]\n---\nbody\n');
  check("keystonePending：引号 frontmatter 也识别", keystonePending(w.boardDir));
  writeFileSync(join(w.boardDir, "WL-3.md"),
    "---\nid: WL-3\nstate: Done\nlabels: [writing-loop, keystone]\n---\nbody\n");
  check("keystonePending：非 In Review 不升档", !keystonePending(w.boardDir));
  // WLSYS-95eb134a：§21a-fail.2 升级重写票（票面机读行 `Mode: direct-write`，story-designer 顶配亲写，
  // 无 keystone 标签）In Review 时同样升档——否则 reviewer 默认档 < 顶配 floor，§21a-gate 不认领，
  // 票停靠、§5 前向冻结让全板无在途创作（yujing-jiushi YJJS-101 实测：26 次 fire 无一能认领）。
  writeFileSync(join(w.boardDir, "WL-3.md"),
    "---\nid: WL-3\nstate: In Review\nowner: reviewer\nlabels: [writing-loop, Feature, episode, continuity, reviewer, story-designer]\n---\nEpisode: 20\nDesign: story/outline.v1.json#episode-020\nMode: direct-write\n");
  check("keystonePending：In Review + 票面 `Mode: direct-write`（无 keystone 标签）也升档", keystonePending(w.boardDir));
  writeFileSync(join(w.boardDir, "WL-3.md"),
    "---\nid: WL-3\nstate: Todo\nowner: reviewer\nlabels: [writing-loop, Feature, episode, reviewer, story-designer]\n---\nEpisode: 20\nMode: direct-write\n");
  check("keystonePending：Todo 的 direct-write 票不升档", !keystonePending(w.boardDir));
  writeFileSync(join(w.boardDir, "WL-3.md"),
    "---\nid: WL-3\nstate: In Review\nowner: reviewer\nlabels: [writing-loop, Feature, episode, reviewer, episode-writer]\n---\nEpisode: 20\nMode: standard\n");
  check("keystonePending：In Review 但 Mode 非 direct-write 且无 keystone ⇒ 不升档", !keystonePending(w.boardDir));
  rmSync(w.ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. config 开关 + laneGating:false 奇偶（E2E，真 subprocess）
// ---------------------------------------------------------------------------
function testConfigKnob(): void {
  const proj: WlProject = { title: "t", repoPath: "t1", enabled: true };
  const cfg = (sched: Record<string, unknown>): WlConfig => ({ version: 1, scheduler: sched, projects: { t1: proj } });
  check("config：laneGating 默认 true", buildSched(cfg({}), "t1", proj).laneGating === true);
  check("config：workspace scheduler.laneGating=false 生效", buildSched(cfg({ laneGating: false }), "t1", proj).laneGating === false);
  const projOverride: WlProject = { ...proj, scheduler: { laneGating: true } };
  check("config：项目层覆盖 workspace 层",
    buildSched(cfg({ laneGating: false }), "t1", projOverride).laneGating === true);
  let threw = false;
  try { buildSched(cfg({ laneGating: "yes" }), "t1", proj); }
  catch (e) { threw = e instanceof WlExit; }
  check("config：laneGating 非布尔 ⇒ 硬错", threw);
}

// —— E2E 基建（同 test/scheduler.ts 形）——
const FAKE_AGENT = `const msg = process.argv.slice(2).join(" ");
console.log(msg || "done");
`;
type AgentOverride = Record<string, unknown>;
function makeWs(overrides: Record<string, AgentOverride>, schedExtra: Record<string, unknown> = {}): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "wl-gate-e2e.")));
  mkdirSync(join(ws, ".writing-loop"), { recursive: true });
  mkdirSync(join(ws, "t1"), { recursive: true });
  writeFileSync(join(ws, "fake_agent.mjs"), FAKE_AGENT);
  const agents: Record<string, AgentOverride> = {};
  for (const a of AGENTS) agents[a] = { enabled: false };
  Object.assign(agents, overrides);
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1, scheduler: { ...schedExtra, agents },
    projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
  }, null, 2));
  return ws;
}
function runWl(ws: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WRITING_LOOP_WORKSPACE;
  const r = spawnSync(process.execPath, [runEntry, ...args], { cwd: ws, encoding: "utf8", env, timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function ledger(ws: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(ws, ".writing-loop", "t1", "fires.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}
const EW_TICKET = "---\nid: WL-9\ntitle: ep-001 写作\ntype: Feature\nstate: Todo\nowner: reviewer\n" +
  "labels: [writing-loop, Feature, episode, reviewer, episode-writer]\nupdated: 2026-07-15T11:00:00Z\n---\nEpisode: 1\n";
function seedTicket(ws: string): void {
  const tdir = join(ws, ".writing-loop", "t1", "board", "tickets");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, "WL-9.md"), EW_TICKET);
}
const fakeCmd = (ws: string, ...extra: string[]): string[] => [process.execPath, join(ws, "fake_agent.mjs"), ...extra];

function testParityOffE2E(): void {
  // laneGating:false ⇒ 0.5.0 行为逐字回退：空板照 fire、零 [gated]、行形无 gatedSinceLast
  const ws = makeWs({});
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { laneGating: false, agents: Object.fromEntries(AGENTS.map((a) => [a, a === "episode-writer"
      ? { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws) }
      : { enabled: false }])) },
    projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
  }, null, 2));
  const r = runWl(ws, "--project", "t1", "--once", "--agents", "episode-writer");
  const rows = ledger(ws);
  check("奇偶（off）：空板照 fire（rc=0 且 1 行账本）", r.code === 0 && rows.length === 1,
    `rc=${r.code} rows=${rows.length} stderr=${r.stderr.slice(-200)}`);
  check("奇偶（off）：行形无 gatedSinceLast 字段（0.5.0 一致）", rows.length === 1 && !("gatedSinceLast" in rows[0]));
  check("奇偶（off）：无 [gated]/[gate]/laneGating 渲染", !r.stdout.includes("[gated]") && !r.stdout.includes("[gate]") && !r.stdout.includes("laneGating"));
  rmSync(ws, { recursive: true, force: true });
}

function testGatingOnE2E(): void {
  // 门控默认开，连续模式（--for）承载拦截语义：空板 ⇒ episode-writer 不 spawn
  const mkCfg = (ws: string): void => {
    writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
      version: 1,
      scheduler: { agents: Object.fromEntries(AGENTS.map((a) => [a, a === "episode-writer"
        ? { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws) }
        : { enabled: false }])) },
      projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
    }, null, 2));
  };
  let ws = makeWs({});
  mkCfg(ws);
  let r = runWl(ws, "--project", "t1", "--for", "3", "--agents", "episode-writer");
  check("门控开（--for）：空板 ⇒ 不 spawn、零账本行", r.code === 0 && ledger(ws).length === 0,
    `rc=${r.code} rows=${ledger(ws).length}`);
  check("门控开（--for）：打 [gated] 行", r.stdout.includes("[gated] episode-writer"), r.stdout.slice(-400));
  // 播种真活 ⇒ 放行 fire；首行无 gatedSinceLast（本进程计数 0——gated 发生在上一个进程）
  seedTicket(ws);
  r = runWl(ws, "--project", "t1", "--for", "3", "--agents", "episode-writer");
  const rows = ledger(ws);
  check("门控开（--for）：∃ Todo+tier ⇒ 放行 fire", r.code === 0 && rows.length >= 1, `rc=${r.code} rows=${rows.length}`);
  check("门控开：跨进程 gatedCount 不残留（本进程 0 次 ⇒ 无字段）", rows.length >= 1 && !("gatedSinceLast" in rows[0]));
  rmSync(ws, { recursive: true, force: true });

  // --once = 操作者显式点火（Fix 轮 1 major③）：绕过门控拦截，空板也照 fire——cron 式
  // --once 部署的点火绝不被静默吞掉；[gate] 逐 agent 求值行保留作诊断。
  ws = makeWs({});
  mkCfg(ws);
  r = runWl(ws, "--project", "t1", "--once", "--agents", "episode-writer");
  const onceRows = ledger(ws);
  check("--once：空板照 fire（门控不拦截，恰 1 行账本）", r.code === 0 && onceRows.length === 1,
    `rc=${r.code} rows=${onceRows.length} stderr=${r.stderr.slice(-200)}`);
  check("--once：打印 [gate] 诊断行（谓词为空）且无 [gated] 跳过行",
    r.stdout.includes("[gate] episode-writer：lane 谓词为空") && !r.stdout.includes("[gated]"),
    r.stdout.slice(-400));
  rmSync(ws, { recursive: true, force: true });
}

function testGatedSinceLastE2E(): void {
  // 同进程内：先 gated（板空）→ 板上出现活（由 board-only 的 sweep fire 写入）→ fire 行结清 gatedSinceLast
  const ws = makeWs({});
  const tdir = join(ws, ".writing-loop", "t1", "board", "tickets");
  const seed = join(ws, "seed-ticket.md");
  writeFileSync(seed, EW_TICKET);
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { agents: Object.fromEntries(AGENTS.map((a) => {
      if (a === "episode-writer") return [a, { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws, "writing") }];
      if (a === "sweep") return [a, { enabled: true, intervalSeconds: 30, capSeconds: 30, staggerSeconds: 0,
        command: ["sh", "-c", `sleep 1 && mkdir -p '${tdir}' && cp '${seed}' '${tdir}/WL-9.md'`] }];
      return [a, { enabled: false }];
    })) },
    projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
  }, null, 2));
  const r = runWl(ws, "--project", "t1", "--for", "6");
  const rows = ledger(ws).filter((x) => x.agent === "episode-writer");
  check("gatedSinceLast：episode-writer 先被 gated 再放行（≥1 行）", r.code === 0 && rows.length >= 1
    && r.stdout.includes("[gated] episode-writer"), `rc=${r.code} rows=${rows.length}\n${r.stdout.slice(-400)}`);
  check("gatedSinceLast：下一条账本行结清计数（≥1）",
    rows.length >= 1 && typeof rows[0].gatedSinceLast === "number" && (rows[0].gatedSinceLast as number) >= 1,
    JSON.stringify(rows[0] ?? null));
  rmSync(ws, { recursive: true, force: true });
}

function testShowrunnerBaselineE2E(): void {
  // 连续模式：fire#1（无基线 ⇒ open）干净退出提交基线 ⇒ 板/north-star 未动 ⇒ 此后恒 gated
  const ws = makeWs({});
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    scheduler: { agents: Object.fromEntries(AGENTS.map((a) => [a, a === "showrunner"
      ? { enabled: true, intervalSeconds: 1, capSeconds: 30, staggerSeconds: 0, command: fakeCmd(ws, "run") }
      : { enabled: false }])) },
    projects: { t1: { title: "t", repoPath: "t1", backend: "local", ticketPrefix: "WL", mode: "live", enabled: true } },
  }, null, 2));
  const r = runWl(ws, "--project", "t1", "--for", "4");
  const rows = ledger(ws).filter((x) => x.agent === "showrunner");
  check("showrunner 基线：4s 窗内恰 1 次 fire（首次 open、干净退出后恒 gated）",
    r.code === 0 && rows.length === 1 && r.stdout.includes("[gated] showrunner"),
    `rc=${r.code} rows=${rows.length}\n${r.stdout.slice(-300)}`);
  rmSync(ws, { recursive: true, force: true });
}

function testDryRunObservability(): void {
  let ws = makeWs({ showrunner: { enabled: true }, reviewer: { enabled: true } });
  let r = runWl(ws, "--project", "t1", "--dry-run");
  check("dry-run（on）：头行标注 laneGating=on 且逐 agent 打印 gate 行",
    r.code === 0 && r.stdout.includes("laneGating=on") && r.stdout.includes("  gate: "), r.stdout.slice(0, 300));
  check("dry-run（on）：零账本写", ledger(ws).length === 0);
  rmSync(ws, { recursive: true, force: true });
  ws = makeWs({ showrunner: { enabled: true }, reviewer: { enabled: true } }, { laneGating: false });
  r = runWl(ws, "--project", "t1", "--dry-run");
  check("dry-run（off 奇偶）：无 laneGating 标注、无 gate 行（0.5.0 渲染一致）",
    r.code === 0 && !r.stdout.includes("laneGating") && !r.stdout.includes("  gate: "));
  rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
const cases: Array<[string, () => void]> = [
  ["testParse", testParse],
  ["testEpisodeWriter", testEpisodeWriter],
  ["testStoryDesigner", testStoryDesigner],
  ["testReviewer", testReviewer],
  ["testEvaluator", testEvaluator],
  ["testShowrunner", testShowrunner],
  ["testSweep", testSweep],
  ["testMarketWatch", testMarketWatch],
  ["testScriptDoctor", testScriptDoctor],
  ["testReflect", testReflect],
  ["testReportsEscape", testReportsEscape],
  ["testEdgeShapeUnidirectional", testEdgeShapeUnidirectional],
  ["testStateAndGitSeams", testStateAndGitSeams],
  ["testReflectLessonsMigration", testReflectLessonsMigration],
  ["testJobCStructuredAssetsOnlyCommit", testJobCStructuredAssetsOnlyCommit],
  ["testSweepCadenceKnob", testSweepCadenceKnob],
  ["testSweepLocksAndShowrunnerBaseline", testSweepLocksAndShowrunnerBaseline],
  ["testConfigKnob", testConfigKnob],
  ["testParityOffE2E", testParityOffE2E],
  ["testGatingOnE2E", testGatingOnE2E],
  ["testGatedSinceLastE2E", testGatedSinceLastE2E],
  ["testShowrunnerBaselineE2E", testShowrunnerBaselineE2E],
  ["testDryRunObservability", testDryRunObservability],
];
for (const [name, fn] of cases) {
  try { fn(); }
  catch (e) { nfail++; console.log(`FAIL ${name} 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`); }
}
console.log(`\ntest-lane-gating: ${npass} pass, ${nfail} fail${nfail === 0 ? "\nLANE_GATING_OK" : ""}`);
process.exit(nfail ? 1 : 0);
