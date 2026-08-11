#!/usr/bin/env node
// `writing-loop source` — register a workspace-local adaptation source and hand its
// deterministic chunks to writing-loop's own source-analysis ticket. This command
// never calls a model or a remote endpoint itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkpointSourceAnalysisChunk, commitSourceIntake, finalizeSourceAnalysis, planSourceIntake,
  readSourceIntakeStatus, selectSourceAnalysisChunks, SourceIntakeError,
} from "./source-intake.ts";
import { requireWorkspace, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop source — 原著登记与 writing-loop 拆书入口
用法:
  writing-loop source plan --project KEY --input request.json
  writing-loop source register --project KEY --input request.json --confirm PLAN_ID [--json]
  writing-loop source status --project KEY [--json]
  writing-loop source select --project KEY --chunks chunk-0001,chunk-0002 [--json]
  writing-loop source checkpoint --project KEY --chunk chunk-0001 --commit SHA [--json]
  writing-loop source finalize --project KEY [--json]

plan 严格零写、零模型调用；register 把原著复制为本地不可变分块，提交改编设计，
并创建 story-designer/source-analysis 票。原著全文不进入剧本 Git repo。
只有 request 中明确授权的 Harness 才能在后续 writing-loop run 中按块读取原著。`);
}

function payload(file: string): unknown {
  try { return JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")); }
  catch (error) {
    throw new SourceIntakeError(`无法读取 source intake 输入 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function sourceMain(argv = process.argv.slice(2)): number {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") { usage(); return 0; }
  if (!action) { usage(); return 2; }
  try {
    const ws = requireWorkspace();
    let project: string | null = null;
    let input: string | null = null;
    let confirmation: string | null = null;
    let chunks: string | null = null;
    let chunk: string | null = null;
    let commit: string | null = null;
    let asJson = false;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index];
      if (arg === "--project") project = rest[++index] ?? null;
      else if (arg === "--input") input = rest[++index] ?? null;
      else if (arg === "--confirm") confirmation = rest[++index] ?? null;
      else if (arg === "--chunks") chunks = rest[++index] ?? null;
      else if (arg === "--chunk") chunk = rest[++index] ?? null;
      else if (arg === "--commit") commit = rest[++index] ?? null;
      else if (arg === "--json") asJson = true;
      else { console.error(`writing-loop source ${action}: 未知参数 '${arg}'`); return 2; }
    }
    if (!project) { console.error(`writing-loop source ${action}: 缺少 --project KEY`); return 2; }

    if (action === "plan") {
      if (!input || confirmation !== null || chunks || chunk || commit) { console.error("writing-loop source plan: 需要 --input，且不接受其他操作参数"); return 2; }
      console.log(JSON.stringify(planSourceIntake(ws.root, project, ws.config, payload(input)), null, 2));
      return 0;
    }
    if (action === "register") {
      if (!input || !confirmation || chunks || chunk || commit) { console.error("writing-loop source register: 需要 --input 与 --confirm PLAN_ID"); return 2; }
      const result = commitSourceIntake(ws.root, project, ws.config, payload(input), confirmation);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`《${project}》原著已登记给 writing-loop。`);
        console.log(`  source sha256: ${result.sourceSha256}`);
        console.log(`  local chunks: ${result.chunkCount}`);
        console.log(`  source-analysis ticket: ${result.analysisTicketId}`);
        console.log(`  blocked outline ticket: ${result.outlineTicketId}`);
        console.log("NEXT: writing-loop run --project " + project + " --cli <authorized-harness>");
      }
      return 0;
    }
    if (action === "status") {
      if (input !== null || confirmation !== null || chunks || chunk || commit) { console.error("writing-loop source status: 不接受其他操作参数"); return 2; }
      const status = readSourceIntakeStatus(ws.root, project);
      if (asJson) console.log(JSON.stringify({ project, source: status }, null, 2));
      else if (!status) console.log(`项目 ${project} 尚未登记原著。`);
      else {
        console.log(`writing-loop source — ${project}`);
        console.log(`  title: ${status.manifest.source.title}`);
        console.log(`  sha256: ${status.manifest.source.sha256}`);
        console.log(`  chunks: ${status.control.completedChunks.length}/${status.control.selectedChunks.length || status.manifest.chunking.chunks.length}`);
        console.log(`  phase: ${status.control.phase}`);
        console.log(`  ticket: ${status.control.analysisTicketId}`);
      }
      return 0;
    }
    if (action === "select") {
      if (!chunks || input || confirmation || chunk || commit) { console.error("writing-loop source select: 需要 --chunks，且不接受 intake/checkpoint 参数"); return 2; }
      const ids = chunks.split(",").map((value) => value.trim()).filter(Boolean);
      const result = selectSourceAnalysisChunks(ws.root, project, ids);
      console.log(asJson ? JSON.stringify(result, null, 2) : `已冻结 ${result.selectedChunks.length} 个 source chunks；下一块：${result.remainingChunks[0] ?? "无"}`);
      return 0;
    }
    if (action === "checkpoint") {
      if (!chunk || !commit || input || confirmation || chunks) { console.error("writing-loop source checkpoint: 需要 --chunk 与 --commit"); return 2; }
      const result = checkpointSourceAnalysisChunk(ws.root, project, ws.config, chunk, commit);
      console.log(asJson ? JSON.stringify(result, null, 2) : `已验收 ${chunk}；剩余 ${result.remainingChunks.length} 块。`);
      return 0;
    }
    if (action === "finalize") {
      if (input || confirmation || chunks || chunk || commit) { console.error("writing-loop source finalize: 不接受额外参数"); return 2; }
      const result = finalizeSourceAnalysis(ws.root, project, ws.config);
      console.log(asJson ? JSON.stringify(result, null, 2) : "source-analysis 已进入 review-ready；请交 showrunner 验收。");
      return 0;
    }
    console.error(`writing-loop source: 未知操作 '${action}'`);
    usage();
    return 2;
  } catch (error) {
    console.error(`writing-loop source: ${error instanceof WsError ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(sourceMain());
