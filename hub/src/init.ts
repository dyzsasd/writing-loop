// `writing-loop init` —— 铺 workspace 骨架：目标目录下建 .writing-loop/ + 空 config.json
// {"version":1,"projects":{}}。幂等：绝不覆盖任何已存在文件；已有 workspace ⇒ 打印项目清单。
// 真正的立项（interview、repo scaffold、首张 outline 票）属于 /writing-loop:add-script，
// 本命令只负责让「workspace 根」存在——非技术操作者的第一条命令。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, WsError, type WlConfig } from "./workspace.ts";

const SKELETON: WlConfig = { version: 1, projects: {} };

function usage(): void {
  console.log(`writing-loop init — 铺 workspace 骨架（.writing-loop/ + 空 config.json；幂等，绝不覆盖）
用法: writing-loop init [--dir D]   （默认 D = 当前目录）`);
}

export function initMain(argv = process.argv.slice(2)): number {
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dir") {
      const v = argv[++i];
      if (!v) { console.error("writing-loop init: --dir 需要值"); return 2; }
      dir = resolve(v);
    } else { console.error(`writing-loop init: 未知参数 '${a}'`); usage(); return 2; }
  }

  const stateDir = join(dir, ".writing-loop");
  const cfgFile = join(stateDir, "config.json");

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
    console.log(`已创建 ${stateDir}`);
  } else {
    console.log(`已存在 ${stateDir}`);
  }

  let hadConfig = false;
  if (!existsSync(cfgFile)) {
    writeFileSync(cfgFile, JSON.stringify(SKELETON, null, 2) + "\n");
    console.log(`已写入 ${cfgFile}（骨架：{"version":1,"projects":{}}）`);
  } else {
    hadConfig = true;
    console.log(`已存在 ${cfgFile}（绝不覆盖）`);
  }

  // 已有 workspace ⇒ 列项目清单（读失败只提示 doctor，不在 init 里修）
  let projectCount = 0;
  if (hadConfig) {
    try {
      const ws = loadConfig(dir);
      const projects = Object.entries(ws.config.projects ?? {});
      projectCount = projects.length;
      if (projects.length) {
        console.log("\n现有项目:");
        for (const [key, p] of projects) {
          console.log(`  ${key.padEnd(20)} ${p.enabled === false ? "[paused] " : ""}${p.title ?? ""}`);
        }
      } else {
        console.log("\n现有项目: 无");
      }
    } catch (e) {
      console.log(`\n注意: ${e instanceof WsError ? e.message : String(e)}`);
      console.log("      （init 不修配置——writing-loop doctor 看全量体检）");
    }
  }

  console.log(`\nNEXT: ${projectCount
    ? "writing-loop run 起调度器（或 writing-loop status 看板）"
    : "在 Claude Code 里跑 /writing-loop:add-script 做立项 interview（拆书或原创，由它写入 config.json 并铺剧本 repo）"}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(initMain());
}
