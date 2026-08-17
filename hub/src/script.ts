#!/usr/bin/env node
// `writing-loop script lint` —— 单集正文的确定性预提交 lint（script-format §3/§4/§6 机器半边）。
// 只读：读 config、story/outline.v1.json、story/assets.v1.json、episodes/ep-NNN.md 与（可选）票面；
// 零 LLM、零写入。退出码 0 = 无 error；1 = 有 error；2 = 用法/IO 错误。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStoryDesign } from "./story-design.ts";
import { readStoryAssetCatalog } from "./story-assets.ts";
import { lintEpisodeScript, parseEpisodeScript, parsePresenceFact, resolveTicketFile, scenesMaxForFormat, sentenceCapForFormat,
  summarizeFindings, type ScriptLintContext } from "./script-lint.ts";
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
  writing-loop script lint --project KEY --episode N [--file PATH] [--ticket ID] [--json]
      对 episodes/ep-NNN.md 跑确定性格式 lint（场景头/场数/调度单/情绪前缀/集号自指/frontmatter/
      注册表闭合/台词句数……）。--ticket 时按票面 Mode: 行校验 frontmatter mode。
      退出码：0 无 error；1 有 error；2 用法或 IO 错误。`);

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h" || command === "help") { usage(); process.exit(command ? 0 : 2); }
  if (command !== "lint") throw new WsError(`script 未知子命令 '${command}'`);
  if (has("--help") || has("-h")) { usage(); process.exit(0); }
  const root = findWorkspaceRoot();
  if (!root) throw new WsError("未在 workspace 内（找不到 .writing-loop/）");
  const ws = loadConfig(root);
  const key = flag("--project");
  if (!key) throw new WsError("script lint 需要 --project KEY");
  const entry = projectEntries(ws.config).find(([candidate]) => candidate === key);
  if (!entry) throw new WsError(`config.json 无项目 '${key}'`);
  const project = entry[1] as Record<string, unknown>;
  const repo = resolveRepoPath(root, entry[1]);
  const rawEpisode = flag("--episode");
  if (!rawEpisode || !/^\d+$/.test(rawEpisode)) throw new WsError("script lint 需要 --episode N");
  const episode = Number(rawEpisode);
  const file = flag("--file") ?? join(repo, "episodes", `ep-${String(episode).padStart(3, "0")}.md`);
  if (!existsSync(file)) throw new WsError(`正文文件不存在：${file}`);
  const text = readFileSync(file, "utf8");

  const read = readStoryDesign(root, key, ws.config);
  const catalog = readStoryAssetCatalog(repo);
  const card = read?.manifest.episodes.find((row) => row.number === episode) ?? null;
  let directWrite: boolean | null = null;
  const ticketId = flag("--ticket");
  if (ticketId) {
    const ticket = readProjectResource(ws, key, "ticket", ticketId).ticket;
    if (!ticket) throw new WsError(`没有创作任务 '${ticketId}'`);
    const body = readFileSync(resolveTicketFile(root, key, ticket.summary.file), "utf8");
    directWrite = /^Mode:[ \t]*direct-write\b/m.test(body);
  }
  let presence: Map<number, string[]> | null = null;
  const epCard = catalog?.manifest.assets.find((asset) => asset.type === "episode" && asset.id === `EP${String(episode).padStart(3, "0")}`);
  const presenceFact = epCard?.facts.find((fact) => fact.key === "presence" && fact.state === "current");
  if (presenceFact && typeof presenceFact.value === "string") presence = parsePresenceFact(presenceFact.value, episode);
  const band = Array.isArray(project.episodeWordBand) && project.episodeWordBand.length === 2
    && project.episodeWordBand.every((n) => Number.isInteger(n)) ? [project.episodeWordBand[0], project.episodeWordBand[1]] as [number, number] : null;
  const format = typeof project.format === "string" ? project.format : null;
  const ctx: ScriptLintContext = {
    episode,
    scenes: read?.manifest.scenes.map((row) => ({ id: row.id, name: row.name, variantOf: row.variantOf })) ?? [],
    characters: read?.manifest.characters.map((row) => ({ id: row.id, name: row.name })) ?? [],
    card: card ? { sceneIds: [...card.sceneIds], characterIds: [...card.characterIds], hookType: card.hookType } : null,
    assetIds: new Set(catalog?.manifest.assets.map((asset) => asset.id) ?? []),
    outlineHash12: read ? read.sha256.slice(0, 12) : null,
    scenesMax: scenesMaxForFormat(format),
    wordBand: band,
    sentenceCap: sentenceCapForFormat(format),
    directWrite,
    presence,
  };
  const findings = lintEpisodeScript(parseEpisodeScript(text), ctx);
  const summary = summarizeFindings(findings);
  if (has("--json")) {
    await output(JSON.stringify({ project: key, episode, file, ok: summary.errors === 0, summary, findings }, null, 2));
  } else {
    for (const f of findings) await output(`${f.severity === "error" ? "ERROR" : "WARN "} ${f.code}${f.line !== null ? ` L${f.line}` : ""}: ${f.message}`);
    await output(`ep-${String(episode).padStart(3, "0")}: ${summary.errors} error / ${summary.warnings} warning ${summary.errors === 0 ? "· SCRIPT_LINT_OK" : "· SCRIPT_LINT_FAILED"}`);
  }
  process.exit(summary.errors === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`writing-loop script: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
