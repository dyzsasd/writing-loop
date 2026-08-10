#!/usr/bin/env node
// 稳定、机器可读的 workspace 全景；编剧工作台和未来外部服务共用同一投影。
import { fileURLToPath } from "node:url";
import { buildWorkspaceSnapshot } from "./project-read-model.ts";
import { requireWorkspace, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop snapshot — 输出 workspace / 剧本项目的稳定 JSON 投影
用法: writing-loop snapshot [--project K] [--compact]`);
}

export function snapshotMain(argv = process.argv.slice(2)): number {
  let projectKey: string | null = null;
  let compact = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { usage(); return 0; }
    if (arg === "--project") {
      projectKey = argv[++i] ?? null;
      if (!projectKey) { console.error("writing-loop snapshot: --project 需要值"); return 2; }
    } else if (arg === "--compact") compact = true;
    else { console.error(`writing-loop snapshot: 未知参数 '${arg}'`); usage(); return 2; }
  }
  try {
    const snapshot = buildWorkspaceSnapshot(requireWorkspace());
    if (projectKey) {
      const project = snapshot.projects.find((item) => item.key === projectKey);
      if (!project) {
        console.error(`writing-loop snapshot: config.json 无项目 '${projectKey}'`);
        return 1;
      }
      // 与 GET /api/snapshot?project=K 保持同一个 versioned envelope；消费者可在 CLI/HTTP
      // 之间切换而不必维护两套 wire schema。
      console.log(JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        generatedAt: snapshot.generatedAt,
        project,
      }, null, compact ? 0 : 2));
    } else {
      console.log(JSON.stringify(snapshot, null, compact ? 0 : 2));
    }
    return 0;
  } catch (error) {
    console.error(`writing-loop snapshot: ${error instanceof WsError ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(snapshotMain());
}
