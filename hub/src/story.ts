#!/usr/bin/env node
// Internal story-design quality gate. Scheduler agents call this automatically; operators normally
// use Studio. The command is intentionally read-only and never generates story content.
import { buildStoryStudioReadModel, readStoryDesign, type StoryDesignStage } from "./story-design.ts";
import { buildStoryContextPack, readStoryAssetCatalog, type StoryAssetAgent } from "./story-assets.ts";
import { readProjectResource } from "./project-detail.ts";
import { findWorkspaceRoot, loadConfig, projectEntries, resolveRepoPath, WsError } from "./workspace.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | null => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; };
const has = (name: string): boolean => args.includes(name);
const output = (value: string): Promise<void> => new Promise((resolve, reject) => {
  process.stdout.write(value.endsWith("\n") ? value : value + "\n", (error) => error ? reject(error) : resolve());
});
const usage = (): void => console.log(`用法:
  writing-loop story status --project KEY [--json]
  writing-loop story validate --project KEY [--stage skeleton|beats|full] [--json]
  writing-loop story context --project KEY --ticket ID --agent AGENT [--max-bytes N] [--json]

这些是 scheduler/agent 的确定性质量门；日常查看请使用 Studio。`);

try {
  if (!command || command === "--help" || command === "help") { usage(); process.exit(0); }
  if (!new Set(["status", "validate", "context"]).has(command)) throw new WsError(`story 未知子命令 '${command}'`);
  const root = findWorkspaceRoot(); if (!root) throw new WsError("当前目录不在 writing-loop workspace 内");
  const key = flag("--project"); if (!key) throw new WsError("缺少 --project KEY");
  const ws = loadConfig(root);
  if (command === "status") {
    const model = buildStoryStudioReadModel(root, key, ws.config);
    if (has("--json")) await output(JSON.stringify(model, null, 2));
    else await output(`${key}: ${model.summary.stage} · ${model.summary.passed} pass / ${model.summary.failed} fail / ${model.summary.skipped} skipped`);
    process.exit(model.summary.failed ? 1 : 0);
  }
  if (command === "context") {
    const ticketId = flag("--ticket"); const agent = flag("--agent") as StoryAssetAgent | null;
    if (!ticketId || !agent) throw new WsError("story context 需要 --ticket ID --agent AGENT");
    const ticket = readProjectResource(ws, key, "ticket", ticketId).ticket;
    if (!ticket) throw new WsError(`没有创作任务 '${ticketId}'`);
    if (ticket.summary.owner !== agent && !ticket.summary.labels.includes(agent)) {
      throw new WsError(`工单 ${ticketId} 未授权 ${agent} 读取 Context Pack`);
    }
    const read = readStoryDesign(root, key, ws.config); if (!read) throw new WsError("尚无 story/outline.v1.json");
    const entry = projectEntries(ws.config).find(([candidate]) => candidate === key);
    if (!entry) throw new WsError(`config.json 无项目 '${key}'`);
    const repo = resolveRepoPath(root, entry[1]); const catalog = readStoryAssetCatalog(repo);
    if (!catalog) throw new WsError("尚无 story/assets.v1.json");
    const rawMax = flag("--max-bytes"); const maxBytes = rawMax === null ? undefined : Number(rawMax);
    const pack = buildStoryContextPack(catalog, { project: key, repo, sourcePlanId: read.policy.sourcePlanId,
      storyDesignSha256: read.sha256, totalEpisodes: read.policy.totalEpisodes,
      characters: read.manifest.characters.map((row) => ({ id: row.id, name: row.name,
        firstEpisode: row.firstEpisode, lastEpisode: row.lastEpisode })),
      scenes: read.manifest.scenes.map((row) => ({ id: row.id, name: row.name })),
      episodes: read.manifest.episodes.map((row) => ({ number: row.number,
        characterIds: [...row.characterIds], sceneIds: [...row.sceneIds] })) },
    { project: key, ticketId, agent, episode: ticket.summary.episode, maxBytes });
    if (has("--json")) await output(JSON.stringify(pack, null, 2));
    else await output(`${ticketId}: ${pack.assets.length} assets + ${pack.timeline.length} timeline events · ${pack.budget.usedBytes}/${pack.budget.maxBytes} bytes · ${pack.digest}`);
    process.exit(0);
  }
  const requested = flag("--stage") ?? "full";
  if (!new Set(["skeleton", "beats", "full"]).has(requested)) throw new WsError("--stage 必须是 skeleton|beats|full");
  const rank = (stage: StoryDesignStage): number => ({ skeleton: 0, beats: 1, full: 2 })[stage];
  const gates = buildStoryStudioReadModel(root, key, ws.config).gates.map((row) => rank(row.stage) > rank(requested as StoryDesignStage)
    ? { ...row, state: "skipped" as const, detail: `等待 ${row.stage} 阶段` } : row);
  if (has("--json")) await output(JSON.stringify({ version: 1, project: key, stage: requested, gates }, null, 2));
  else await output(gates.map((row) => `${row.state.toUpperCase().padEnd(8)} ${row.id} ${row.label} — ${row.detail}`).join("\n"));
  process.exit(gates.some((row) => row.state === "fail") ? 1 : 0);
} catch (error) {
  console.error(`writing-loop story: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
