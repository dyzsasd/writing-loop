// `writing-loop sync-opencode` —— 把 workspace 顶层 config.json 的 `providers` 注册表同步
// 进 <workspace-root>/opencode.json（create-or-merge，算法见 opencode-sync.ts；绝不碰
// ~/.config/opencode/opencode.json 全局配置）。操作者手改 config.json 的 providers 块后
// 手动跑本命令一次，把新增/变更的端点落进 opencode 自己的配置文件——writing-loop 的惯例
// 是操作者直接改 config.json，没有 add-provider 这类 CLI mutator。
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { syncOpencodeConfig } from "./opencode-sync.ts";
import { parseProviders } from "./scheduler.ts";
import { requireWorkspace, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop sync-opencode — 把 config.json 顶层 providers 注册表同步进 opencode.json
用法: writing-loop sync-opencode [--dir <path>]   （默认 --dir = 当前目录，向上找 .writing-loop/）

create-or-merge：providers 为空则 no-op；opencode.json 不存在则新建；已存在则逐 id 原地
覆盖，注册表之外的手写 provider 与其余顶层键绝不触碰。绝不碰全局 ~/.config/opencode/。`);
}

export function syncOpencodeMain(argv = process.argv.slice(2)): number {
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dir") {
      const v = argv[++i];
      if (!v) { console.error("writing-loop sync-opencode: --dir 需要值"); return 2; }
      dir = resolve(v);
    } else { console.error(`writing-loop sync-opencode: 未知参数 '${a}'`); usage(); return 2; }
  }

  try {
    const ws = requireWorkspace(dir);
    const providers = parseProviders(ws.config);
    const ids = Object.keys(providers);
    if (ids.length === 0) {
      console.log("writing-loop sync-opencode: providers 为空——无需同步");
      return 0;
    }
    const result = syncOpencodeConfig(ws.root, providers);
    console.log(`writing-loop sync-opencode: action=${result.action} providers=[${result.providers.join(", ")}] → ${ws.root}/opencode.json`);
    return 0;
  } catch (e) {
    console.error(`writing-loop sync-opencode: ${e instanceof WsError ? e.message : (e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(syncOpencodeMain());
}
