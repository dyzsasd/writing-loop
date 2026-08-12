// Regression contract for adaptation source intake. The source remains local and
// immutable, planning is zero-write, and the outline cannot outrun source analysis.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointSourceAnalysisChunk, checkpointSourceSurveyChunk, commitSourceIntake, finalizeSourceAnalysis,
  finalizeSourceSurvey, planSourceIntake, readSourceIntakeStatus, restartSourceAnalysis,
  selectSourceAnalysisChunks, SourceIntakeError, startSourceSurvey,
} from "../src/source-intake.ts";
import { loadConfig } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const rejects = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof SourceIntakeError && error.message.includes(needle); }
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-source-intake-")));
try {
  const data = join(tmp, ".writing-loop");
  const repo = join(tmp, "drama");
  const tickets = join(data, "demo", "board", "tickets");
  mkdirSync(join(repo, "source"), { recursive: true });
  mkdirSync(tickets, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "改编剧", repoPath: "drama", enabled: true, ticketPrefix: "SRC" } },
  }, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "writing-loop test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "writing-loop@example.invalid"], { cwd: repo });
  for (const name of ["mainline.md", "highlights.md", "characters-function.md"]) writeFileSync(join(repo, "source", name), `# ${name}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "scaffold"], { cwd: repo });
  writeFileSync(join(tickets, "SRC-1.md"), `---\nid: SRC-1\ntitle: outline\ntype: Feature\nstate: Todo\nowner: showrunner\nassignee: null\nlabels: [writing-loop, Feature, outline, showrunner, story-designer]\npriority: 1\nrelatedTo: []\nduplicateOf: null\ncreated: 2026-08-11T00:00:00.000Z\nupdated: 2026-08-11T00:00:00.000Z\n---\n## Context\nempty\n`);
  writeFileSync(join(data, "demo", "board", "counter.json"), JSON.stringify({ prefix: "SRC", next: 2 }));
  const source = join(tmp, "novel.txt");
  const sections = Array.from({ length: 198 }, (_, index) => `第${index + 1}章 标题${index + 1}\n${"内容".repeat(6_000)}\n`).join("");
  writeFileSync(source, sections);
  const request = {
    version: 1,
    sourceTitle: "长篇原著",
    sourcePath: source,
    adaptationBrief: "只提供方向，由 writing-loop 自己拆解；第一季采用部分范围。",
    rightsScope: "仅用于获授权的内部改编开发。",
    processingConsent: {
      allowedHarnesses: ["claude"], rawNovelContentMayBeSent: true,
      confirmedAt: "2026-08-11T00:00:00.000Z",
    },
  };
  const ws = loadConfig(tmp);
  const before = readFileSync(join(data, "config.json"));
  const plan = planSourceIntake(tmp, "demo", ws.config, request, Date.parse("2026-08-11T01:00:00.000Z"));
  ok(plan.planId.startsWith("wlsrc_") && plan.chunking.chunkCount >= 3, "plan returns deterministic fingerprint and bounded chunks");
  ok(Buffer.compare(before, readFileSync(join(data, "config.json"))) === 0
    && !existsSync(join(data, "demo", "source-intake.v1")), "plan is strictly zero-write");
  ok(rejects(() => planSourceIntake(tmp, "demo", ws.config, {
    ...request, processingConsent: { ...request.processingConsent, rawNovelContentMayBeSent: false },
  }, Date.parse("2026-08-11T01:00:00.000Z")), "明确确认"), "raw provider processing requires explicit true consent");

  const result = commitSourceIntake(tmp, "demo", ws.config, request, plan.planId, {
    now: () => new Date("2026-08-11T01:00:00.000Z"),
  });
  const status = readSourceIntakeStatus(tmp, "demo");
  ok(result.analysisTicketId === "SRC-2" && result.outlineTicketId === "SRC-1" && status?.manifest.source.sha256 === result.sourceSha256,
    "register publishes manifest/control and a dedicated source-analysis ticket");
  ok(lstatSync(join(data, "demo", "source-intake.v1", "original", "source.txt")).mode % 0o1000 === 0o600
    && readFileSync(join(data, "demo", "source-intake.v1", "original", "source.txt"), "utf8") === sections,
    "raw novel is copied into local 0600 runtime without content drift");
  const outline = readFileSync(join(tickets, "SRC-1.md"), "utf8");
  const analysis = readFileSync(join(tickets, "SRC-2.md"), "utf8");
  ok(outline.includes("state: Backlog") && outline.includes("source-pending") && outline.includes("Blocked-by: SRC-2")
    && analysis.includes("state: Todo") && analysis.includes("source-analysis")
    && analysis.includes("source-analyst") && !analysis.includes("source-analysis, story-designer")
    && analysis.includes("先覆盖全书完成结构扫描") && !analysis.includes("480 KiB")
    && analysis.includes("禁止调用外部拆书 Skill"),
    "source analysis is routed only to Source Analyst while outline is durably parked in Backlog");
  ok(!existsSync(join(repo, "novel.txt")) && !readFileSync(join(repo, "source", "adaptation-brief.md"), "utf8").includes(sections.slice(0, 100)),
    "Git stores only source fingerprint, brief and consent—not raw novel bytes");
  const replay = commitSourceIntake(tmp, "demo", ws.config, request, plan.planId, {
    now: () => new Date("2026-08-11T01:01:00.000Z"),
  });
  ok(replay.replayed && replay.analysisTicketId === "SRC-2"
    && spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout === "",
    "exact register replay is idempotent and leaves repo clean");
  const runtimeChunk = join(data, "demo", "source-intake.v1", status!.manifest.chunking.chunks[0].path);
  const runtimeChunkBytes = readFileSync(runtimeChunk);
  writeFileSync(runtimeChunk, "tampered\n");
  ok(rejects(() => commitSourceIntake(tmp, "demo", ws.config, request, plan.planId, {
    now: () => new Date("2026-08-11T01:01:30.000Z"),
  }), "运行态损坏"), "exact replay rejects a tampered local source chunk before any analysis continues");
  writeFileSync(runtimeChunk, runtimeChunkBytes);
  ok(rejects(() => commitSourceIntake(tmp, "demo", ws.config, { ...request, adaptationBrief: "漂移" }, plan.planId), "确认指纹"),
    "brief drift cannot reuse an old confirmation fingerprint");

  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [status!.manifest.chunking.chunks[0].id], new Date()),
    "必须先完成全书结构扫描"),
  "current-season selection cannot begin before every immutable source chunk has been surveyed");
  const surveyStarted = startSourceSurvey(tmp, "demo", new Date("2026-08-11T01:01:40.000Z"));
  ok(surveyStarted.phase === "surveying" && surveyStarted.surveyedChunks.length === 0,
    "Source Analyst explicitly enters the whole-book survey phase");
  mkdirSync(join(repo, "source", "survey", "chunks"), { recursive: true });
  for (const fact of status!.manifest.chunking.chunks) {
    writeFileSync(join(repo, "source", "survey", "chunks", `${fact.id}.md`),
      `# ${fact.id} 全书结构扫描\n\nSource-intake: ${plan.planId}\nSource-chunk: ${fact.id}\nSource-sha256: ${fact.sha256}\n\n本段只记录全书阶段、人物变化、世界演变与季界候选。\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "source: survey whole book"], { cwd: repo });
  const surveyCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  ok(rejects(() => checkpointSourceSurveyChunk(tmp, "demo", ws.config,
    status!.manifest.chunking.chunks[1].id, surveyCommit), "按原著顺序推进"),
  "whole-book survey cannot skip an earlier chunk");
  for (const fact of status!.manifest.chunking.chunks) {
    checkpointSourceSurveyChunk(tmp, "demo", ws.config, fact.id, surveyCommit,
      new Date("2026-08-11T01:01:45.000Z"));
  }
  ok(rejects(() => finalizeSourceSurvey(tmp, "demo", ws.config), "book-map.md"),
    "survey checkpoints alone cannot bypass the four whole-book fact maps");
  for (const name of ["book-map.md", "character-arcs.md", "world-evolution.md", "season-map.md"]) {
    writeFileSync(join(repo, "source", name),
      `# ${name}\n\nSource-intake: ${plan.planId}\n\n${"覆盖全书的结构事实与季界判断。".repeat(60)}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "source: publish whole-book maps"], { cwd: repo });
  const surveyed = finalizeSourceSurvey(tmp, "demo", ws.config, new Date("2026-08-11T01:01:50.000Z"));
  ok(surveyed.phase === "surveyed" && surveyed.surveyedChunks.length === status!.manifest.chunking.chunks.length,
    "only exact ordered coverage plus committed whole-book maps reaches surveyed");

  const selected = [status!.manifest.chunking.chunks[0], status!.manifest.chunking.chunks.at(-1)!];
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo",
    status!.manifest.chunking.chunks.slice(0, 33).map((chunk) => chunk.id), new Date()), "最多 32"),
    "season selection mechanically rejects more than 32 chunks");
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo",
    status!.manifest.chunking.chunks.slice(0, 30).map((chunk) => chunk.id), new Date()), "最多 2097152 bytes"),
    "season selection mechanically rejects more than 2 MiB even below the chunk-count cap");
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [0, 2, 4, 6, 8]
    .map((index) => status!.manifest.chunking.chunks[index].id), new Date()), "最多 4 个连续窗口"),
  "current-season deep evidence cannot fragment into more than four windows");
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [selected[1].id, selected[0].id], new Date()), "manifest 顺序"),
    "season analysis must preserve manifest source order");
  const selection = selectSourceAnalysisChunks(tmp, "demo", selected.map((chunk) => chunk.id), new Date("2026-08-11T01:02:00.000Z"));
  ok(selection.phase === "analyzing" && selection.remainingChunks.length === 2
    && selection.selectedChunks[1] === status!.manifest.chunking.chunks.at(-1)!.id,
  "Source Analyst can freeze bounded non-prefix evidence after understanding the whole book");
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [selected[0].id], new Date()), "拒绝漂移"),
    "selected source range cannot silently drift across fires");
  mkdirSync(join(repo, "source", "deconstruction", "chunks"), { recursive: true });
  for (const fact of selected) {
    const summary = `# ${fact.id} 结构摘要\n\nSource-intake: ${plan.planId}\nSource-chunk: ${fact.id}\nSource-sha256: ${fact.sha256}\n\n## 因果功能\n\n只保留结构化功能，不复制原文。\n`;
    writeFileSync(join(repo, "source", "deconstruction", "chunks", `${fact.id}.md`), summary);
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", `source: analyze ${fact.id}`], { cwd: repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    checkpointSourceAnalysisChunk(tmp, "demo", ws.config, fact.id, commit, new Date("2026-08-11T01:03:00.000Z"));
  }
  ok(rejects(() => finalizeSourceAnalysis(tmp, "demo", ws.config), "尚未形成"),
    "chunk summaries alone cannot bypass the three-sheet aggregation gate");
  for (const name of ["mainline.md", "highlights.md", "characters-function.md"]) {
    writeFileSync(join(repo, "source", name), `# ${name}\n\nSource-intake: ${plan.planId}\n\n${"结构化改编结论。".repeat(80)}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "source: aggregate deconstruction"], { cwd: repo });
  const finalized = finalizeSourceAnalysis(tmp, "demo", ws.config, new Date("2026-08-11T01:04:00.000Z"));
  ok(finalized.phase === "review-ready" && finalized.remainingChunks.length === 0,
    "only committed provenance sheets and all selected chunks reach review-ready");
  const mainline = join(repo, "source", "mainline.md");
  const mainlineBefore = readFileSync(mainline, "utf8");
  const symlinkVictim = join(tmp, "restart-victim.txt");
  writeFileSync(symlinkVictim, "never overwrite\n");
  rmSync(mainline); symlinkSync(symlinkVictim, mainline);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "test unsafe source mirror"], { cwd: repo });
  ok(rejects(() => restartSourceAnalysis(tmp, "demo", ws.config, plan.planId), "普通单链接文件")
    && existsSync(join(repo, "source", "deconstruction"))
    && readFileSync(symlinkVictim, "utf8") === "never overwrite\n",
    "restart preflights every derived target before deleting anything and never follows a symlink");
  rmSync(mainline); writeFileSync(mainline, mainlineBefore);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "restore source mirror"], { cwd: repo });
  const rawBeforeRestart = readFileSync(join(data, "demo", "source-intake.v1", "original", "source.txt"));
  const northStar = join(repo, "bible", "north-star.md");
  mkdirSync(join(repo, "bible"), { recursive: true });
  writeFileSync(northStar, "# 北极星\n\n必须保留。\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "north star"], { cwd: repo });
  ok(rejects(() => restartSourceAnalysis(tmp, "demo", ws.config, "wrong"), "确认指纹"),
    "source restart requires the exact immutable intake fingerprint");
  const restarted = restartSourceAnalysis(tmp, "demo", ws.config, plan.planId,
    new Date("2026-08-11T01:05:00.000Z"));
  const resetStatus = readSourceIntakeStatus(tmp, "demo");
  const resetTicket = readFileSync(join(tickets, "SRC-2.md"), "utf8");
  ok(restarted.phase === "registered" && resetStatus?.control.surveyedChunks.length === 0
    && resetStatus.control.selectedChunks.length === 0 && resetStatus.control.completedChunks.length === 0
    && resetTicket.includes("source-analyst")
    && resetTicket.includes("state: Todo") && !resetTicket.includes("story-designer")
    && resetTicket.includes("票据只记录创作判断") && !resetTicket.includes("480 KiB"),
    "restart archives the old analysis and republishes one compact Source Analyst ticket");
  ok(restarted.archivePath !== null && existsSync(restarted.archivePath)
    && !existsSync(join(repo, "source", "deconstruction")) && !existsSync(join(repo, "source", "survey"))
    && !existsSync(join(repo, "source", "book-map.md")) && !existsSync(join(repo, "source", "season-map.md"))
    && readFileSync(join(repo, "source", "mainline.md"), "utf8").includes("等待 Source Analyst")
    && readFileSync(northStar, "utf8").includes("必须保留")
    && Buffer.compare(rawBeforeRestart,
      readFileSync(join(data, "demo", "source-intake.v1", "original", "source.txt"))) === 0,
    "restart clears only derived analysis while preserving raw source, North Star and Git history");
  ok(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout === "",
    "restart records a clean recovery commit");
  // Real novels can have hundreds of chunks. The CLI must let its pipe drain instead of calling
  // process.exit immediately after console.log and returning a truncated, unparsable JSON value.
  const manifestFile = join(data, "demo", "source-intake.v1", "manifest.v1.json");
  const largeManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const expectedLargeChunkCount = largeManifest.chunking.chunks.length + 47;
  let previousEnd = largeManifest.chunking.chunks.at(-1).endLine as number;
  for (let index = largeManifest.chunking.chunks.length; index < expectedLargeChunkCount; index++) {
    const id = `chunk-${String(index + 1).padStart(4, "0")}`; previousEnd++;
    largeManifest.chunking.chunks.push({ id, path: `chunks/${id}.txt`, sha256: "a".repeat(64),
      byteLength: 1, startLine: previousEnd, endLine: previousEnd, sectionCount: 1,
      headings: [`大输出标题-${id}-` + "结构".repeat(1_000)] });
  }
  writeFileSync(manifestFile, JSON.stringify(largeManifest, null, 2) + "\n");
  const statusCli = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "source.ts"),
    "status", "--project", "demo", "--json"], { cwd: tmp, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  let parsedStatus: any = null; try { parsedStatus = JSON.parse(statusCli.stdout); } catch { /* asserted below */ }
  ok(statusCli.status === 0 && parsedStatus?.source?.manifest?.chunking?.chunks?.length === expectedLargeChunkCount,
    "source status lets large manifest JSON drain completely before process exit");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSOURCE_INTAKE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
