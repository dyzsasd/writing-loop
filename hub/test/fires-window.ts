// 近 24h 成本仪表（fires window24h）自测——2026-08-20 操作者裁定：$/集、治理:内容占比、
// no-op 成本要常驻遥测口径并带阈值 WARN。窗口聚合/占比/渲染全走纯函数直接断言；
// episodesAddedSince 用真实临时 git 仓库（--diff-filter=A 判「新集」，改旧集不计）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTENT_AGENTS, episodesAddedSince, GOVERNANCE_WARN_SHARE, NOOP_WARN_USD,
  renderWindowReport, windowStats,
} from "../src/fires.ts";
import type { FireRow } from "../src/status.ts";

let fails = 0;
const ok = (c: boolean, m: string, extra = ""): void => {
  console.log((c ? "PASS " : "FAIL ") + m + (c || !extra ? "" : `（${extra}）`));
  if (!c) fails++;
};

const NOW = Date.parse("2026-08-20T12:00:00Z");
const HOUR = 3600_000;
const row = (agent: string, hoursAgo: number, cost: number | null, over: Partial<FireRow> = {}): FireRow => ({
  agent, startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), exitCode: 0,
  ...(cost === null ? {} : { usage: { source: "provider", inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, currency: "USD" } } as unknown as FireRow),
  ...over,
});

// ── windowStats 聚合 ─────────────────────────────────────────────────────────
{
  const rows: FireRow[] = [
    row("episode-writer", 1, 2),
    row("story-designer", 2, 10),
    row("showrunner", 3, 12),
    row("reviewer", 4, 4),
    row("sweep", 5, 2, { noop: true }),
    row("sweep", 30, 99),                                   // 窗口外——不计
    row("episode-writer", 6, null),                         // 无计量——fires 计、成本不计
    row("story-designer", 7, 8, { exitCode: 143, timedOut: true }),
    row("evaluator", 8, 3, { exitCode: 1 }),
    { agent: "sweep", exitCode: 0 },                        // 无 startedAt——旧账本行，不入窗口
  ];
  const w = windowStats(rows, NOW);
  ok(w.fires === 8 && w.metered === 7, "窗口筛选：窗口外/无 startedAt 不计，无计量行照计 fires", JSON.stringify({ fires: w.fires, metered: w.metered }));
  ok(Math.abs(w.costUsd - 41) < 1e-9, "成本合计只累计量行", String(w.costUsd));
  ok(Math.abs(w.contentCostUsd - 20) < 1e-9 && Math.abs(w.governanceCostUsd - 21) < 1e-9,
    "内容/治理按 CONTENT_AGENTS 分账", JSON.stringify({ c: w.contentCostUsd, g: w.governanceCostUsd }));
  ok(w.governanceShare !== null && Math.abs(w.governanceShare - 21 / 41) < 1e-9, "治理占比 = 治理/(治理+内容)");
  ok(w.noopFires === 1 && Math.abs(w.noopCostUsd - 2) < 1e-9, "no-op 计数与成本");
  ok(w.timedOut === 1 && w.badExits === 1, "超时与非零退出分列（超时不重计入 badExits）",
    JSON.stringify({ t: w.timedOut, b: w.badExits }));
  ok(w.byAgent["sweep"].fires === 1, "byAgent 只含窗口内行");
  ok(CONTENT_AGENTS.has("source-analyst") && !CONTENT_AGENTS.has("script-doctor"), "内容角色集合形状");
}

// ── 占比空态 ────────────────────────────────────────────────────────────────
{
  const w = windowStats([row("sweep", 1, null)], NOW);
  ok(w.governanceShare === null && w.costUsd === 0, "零计量窗口：占比 null、成本 0（不以 0 充数的占比）");
}

// ── renderWindowReport 文案与阈值 ────────────────────────────────────────────
{
  ok(renderWindowReport(windowStats([], NOW), null).length === 0, "空窗口不渲染");
  const healthy = windowStats([row("episode-writer", 1, 30), row("showrunner", 2, 10)], NOW);
  const linesH = renderWindowReport(healthy, 2);
  ok(linesH.some((l) => l.includes("$20/集")), "有新集 ⇒ 打 $/集（40/2）", linesH.join("|"));
  ok(!linesH.some((l) => l.includes("WARN")), "治理 25%、no-op 0 ⇒ 无 WARN", linesH.join("|"));
  const gov = windowStats([row("episode-writer", 1, 2), row("showrunner", 2, 12), row("reviewer", 3, 6)], NOW);
  ok(gov.governanceShare !== null && gov.governanceShare > GOVERNANCE_WARN_SHARE
    && renderWindowReport(gov, 0).some((l) => l.includes("WARN 治理成本占比")), "治理占比 90% > 70% ⇒ WARN");
  const noop = windowStats([row("sweep", 1, NOOP_WARN_USD + 5, { noop: true })], NOW);
  ok(renderWindowReport(noop, 0).some((l) => l.includes("WARN no-op")), "no-op 24h 成本超 $10 ⇒ WARN");
  const bad = windowStats([row("story-designer", 1, 8, { exitCode: 143, timedOut: true })], NOW);
  ok(renderWindowReport(bad, 0).some((l) => l.includes("超时 1 次")), "超时进 WARN 行");
  ok(renderWindowReport(healthy, null).some((l) => l.includes("不可判")), "epsAdded null ⇒ 显示不可判，绝不当 0");
  ok(renderWindowReport(healthy, 0).some((l) => l.includes("新集 0")), "epsAdded 0 ⇒ 显示新集 0、不除零");
}

// ── episodesAddedSince（真实临时 git 仓库）───────────────────────────────────
{
  const repo = mkdtempSync(join(tmpdir(), "fires-win-"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(repo, "episodes"), { recursive: true });
  writeFileSync(join(repo, "episodes", "ep-001.md"), "x");
  git("add", "-A"); git("commit", "-qm", "ep-001");
  writeFileSync(join(repo, "episodes", "ep-002.md"), "x");
  writeFileSync(join(repo, "episodes", "ep-001.md"), "revised");   // 修订旧集——不算新增
  writeFileSync(join(repo, "notes.md"), "x");                      // episodes/ 外——不算
  git("add", "-A"); git("commit", "-qm", "ep-002 + revise");
  ok(episodesAddedSince(repo, "2020-01-01T00:00:00Z") === 2, "全窗口：两次 A 提交共 2 新集");
  const future = new Date(Date.now() + 24 * HOUR).toISOString();
  ok(episodesAddedSince(repo, future) === 0, "窗口起点在未来 ⇒ 0 新集（可证明的空）");
  ok(episodesAddedSince(join(repo, "..", "no-such-dir-xyz"), "2020-01-01T00:00:00Z") === null,
    "非 git 目录 ⇒ null（不可判，不以 0 充数）");
  rmSync(repo, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nFIRES_WINDOW_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
