#!/usr/bin/env node
// Internal story-design quality gate. Scheduler agents call this automatically; operators normally
// use Studio. The command is intentionally read-only and never generates story content.
import { buildStoryStudioReadModel, readStoryDesign, validateStoryDesign, type StoryDesignStage } from "./story-design.ts";
import { findWorkspaceRoot, loadConfig, WsError } from "./workspace.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | null => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; };
const has = (name: string): boolean => args.includes(name);
const usage = (): void => console.log(`用法:
  writing-loop story status --project KEY [--json]
  writing-loop story validate --project KEY [--stage skeleton|beats|full] [--json]

这些是 scheduler/agent 的确定性质量门；日常查看请使用 Studio。`);

try {
  if (!command || command === "--help" || command === "help") { usage(); process.exit(0); }
  if (!new Set(["status", "validate"]).has(command)) throw new WsError(`story 未知子命令 '${command}'`);
  const root = findWorkspaceRoot(); if (!root) throw new WsError("当前目录不在 writing-loop workspace 内");
  const key = flag("--project"); if (!key) throw new WsError("缺少 --project KEY");
  const ws = loadConfig(root);
  if (command === "status") {
    const model = buildStoryStudioReadModel(root, key, ws.config);
    if (has("--json")) console.log(JSON.stringify(model, null, 2));
    else console.log(`${key}: ${model.summary.stage} · ${model.summary.passed} pass / ${model.summary.failed} fail / ${model.summary.skipped} skipped`);
    process.exit(model.summary.failed ? 1 : 0);
  }
  const requested = flag("--stage") ?? "full";
  if (!new Set(["skeleton", "beats", "full"]).has(requested)) throw new WsError("--stage 必须是 skeleton|beats|full");
  const read = readStoryDesign(root, key, ws.config); if (!read) throw new WsError("尚无 story/outline.v1.json");
  const gates = validateStoryDesign(read.manifest, read.policy, requested as StoryDesignStage);
  if (has("--json")) console.log(JSON.stringify({ version: 1, project: key, stage: requested, gates }, null, 2));
  else for (const row of gates) console.log(`${row.state.toUpperCase().padEnd(8)} ${row.id} ${row.label} — ${row.detail}`);
  process.exit(gates.some((row) => row.state === "fail") ? 1 : 0);
} catch (error) {
  console.error(`writing-loop story: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
