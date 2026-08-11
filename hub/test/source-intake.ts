// Regression contract for adaptation source intake. The source remains local and
// immutable, planning is zero-write, and the outline cannot outrun source analysis.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointSourceAnalysisChunk, commitSourceIntake, finalizeSourceAnalysis, planSourceIntake,
  readSourceIntakeStatus, selectSourceAnalysisChunks, SourceIntakeError,
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
  const sections = Array.from({ length: 18 }, (_, index) => `第${index + 1}章 标题${index + 1}\n${"内容".repeat(6_000)}\n`).join("");
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
    && analysis.includes("state: Todo") && analysis.includes("source-analysis") && analysis.includes("禁止调用外部拆书 Skill"),
    "source analysis becomes Todo while outline is durably parked in Backlog");
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

  const selected = status!.manifest.chunking.chunks.slice(0, 2);
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [
    status!.manifest.chunking.chunks[0].id, status!.manifest.chunking.chunks[2].id,
  ], new Date()), "连续 chunk"), "season analysis cannot skip across a non-contiguous source range");
  ok(rejects(() => selectSourceAnalysisChunks(tmp, "demo", [selected[1].id, selected[0].id], new Date()), "连续 chunk"),
    "season analysis must preserve manifest source order");
  const selection = selectSourceAnalysisChunks(tmp, "demo", selected.map((chunk) => chunk.id), new Date("2026-08-11T01:02:00.000Z"));
  ok(selection.phase === "analyzing" && selection.remainingChunks.length === 2, "story-designer freezes a bounded season analysis range");
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
  // Real novels can have hundreds of chunks. The CLI must let its pipe drain instead of calling
  // process.exit immediately after console.log and returning a truncated, unparsable JSON value.
  const manifestFile = join(data, "demo", "source-intake.v1", "manifest.v1.json");
  const largeManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  let previousEnd = largeManifest.chunking.chunks.at(-1).endLine as number;
  for (let index = largeManifest.chunking.chunks.length; index < 80; index++) {
    const id = `chunk-${String(index + 1).padStart(4, "0")}`; previousEnd++;
    largeManifest.chunking.chunks.push({ id, path: `chunks/${id}.txt`, sha256: "a".repeat(64),
      byteLength: 1, startLine: previousEnd, endLine: previousEnd, sectionCount: 1,
      headings: [`大输出标题-${id}-` + "结构".repeat(1_000)] });
  }
  writeFileSync(manifestFile, JSON.stringify(largeManifest, null, 2) + "\n");
  const statusCli = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "source.ts"),
    "status", "--project", "demo", "--json"], { cwd: tmp, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  let parsedStatus: any = null; try { parsedStatus = JSON.parse(statusCli.stdout); } catch { /* asserted below */ }
  ok(statusCli.status === 0 && parsedStatus?.source?.manifest?.chunking?.chunks?.length === 80,
    "source status lets large manifest JSON drain completely before process exit");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSOURCE_INTAKE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
