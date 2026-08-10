// `writing-loop workspace` — explicit management for the non-authoritative local ID registry.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectWorkspaceRegistry, registerWorkspace, removeWorkspaceRegistration,
} from "./workspace-registry.ts";
import { WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop workspace — 本机 workspace ID 索引（不参与普通 CLI 根解析）
用法:
  writing-loop workspace list [--json]
  writing-loop workspace add [DIR] [--label L]
  writing-loop workspace remove ID

remove 只删除本机指针，绝不删除 workspace 目录或 .writing-loop/workspace.json。`);
}

export function workspaceRegistryMain(argv = process.argv.slice(2)): number {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") { usage(); return 0; }
  try {
    if (command === "list") {
      let json = false;
      for (const arg of args) {
        if (arg === "--json") json = true;
        else throw new WsError(`workspace list: 未知参数 '${arg}'`);
      }
      const snapshot = inspectWorkspaceRegistry();
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        console.log(`registry: ${snapshot.registryStatus}${snapshot.degraded ? " (degraded)" : ""} — ${snapshot.file}`);
        if (!snapshot.entries.length) console.log("workspaces: 无");
        for (const entry of snapshot.entries) {
          console.log(`${entry.id}  [${entry.status}]  ${entry.label ? `${entry.label}  ` : ""}${entry.root}`);
          if (entry.diagnostic) console.log(`  ${entry.diagnostic}`);
        }
        for (const diagnostic of snapshot.diagnostics) console.log(`diagnostic: ${diagnostic}`);
      }
      return 0;
    }

    if (command === "add") {
      let dir: string | undefined;
      let label: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--label") {
          label = args[++i];
          if (label === undefined) throw new WsError("workspace add: --label 需要值");
        } else if (arg.startsWith("-")) {
          throw new WsError(`workspace add: 未知参数 '${arg}'`);
        } else if (dir === undefined) {
          dir = arg;
        } else {
          throw new WsError("workspace add: 只能指定一个 DIR");
        }
      }
      const entry = registerWorkspace(resolve(dir ?? process.cwd()), label);
      console.log(`registered ${entry.id}`);
      console.log(`root: ${entry.root}`);
      if (entry.label) console.log(`label: ${entry.label}`);
      return 0;
    }

    if (command === "remove") {
      if (args.length !== 1) throw new WsError("workspace remove: 需要且只接受一个 ID");
      const removed = removeWorkspaceRegistration(args[0]);
      if (!removed) throw new WsError(`workspace registry 无 ID ${args[0]}`);
      console.log(`removed pointer ${args[0]}（workspace 目录未删除）`);
      return 0;
    }

    throw new WsError(`未知 workspace 子命令 '${command}'`);
  } catch (error) {
    console.error(`writing-loop workspace: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof WsError ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(workspaceRegistryMain());
}
