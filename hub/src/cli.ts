#!/usr/bin/env node
// `writing-loop` —— 面向操作者的统一 CLI（npm 包 @dyzsasd/writing-loop 的 bin）。
// 与 dev-loop hub/src/cli.ts 同构的薄分派器：每个子命令是 src/ 下一个自带 main 的入口模块，
// 本文件只查表 + spawnSync 转发，剩余参数原样交给入口自己的解析器。零依赖：
// 源码态由 Node >=23.6 直接 type-strip 运行 .ts；发布态跑编译出的 dist/*.js。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src（源码态）| dist（发布态）
// 以本文件自己的扩展名解析兄弟入口：`.ts` = 源码零构建直跑；`.js` = 发布产物
//（node 拒绝 type-strip node_modules 下的 .ts，发布包只带编译 JS）。
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const [cmd, ...rest] = process.argv.slice(2);

// 子命令 → [入口基名（无扩展名）, ...前置参数]。
// 注：release-version 故意不入表——它改的是源码仓库的 manifests（.claude-plugin/* 等），
// 发布包里根本没有这些文件；仓库内用 `node hub/src/release-version.ts <semver>`（仿 dev-loop）。
const ROUTES: Record<string, [string, ...string[]]> = {
  init:                    ["init"],                  // 铺 workspace 骨架（.writing-loop/ + 空 config.json）
  run:                     ["run"],                   // 起内建调度器 wl-run（原生 TS，src/scheduler.ts）
  status:                  ["status"],                // 只读板摘要（state 计数 / 停靠票 / 写作前沿 / 陈旧锁 / 末 5 fire）
  doctor:                  ["doctor"],                // 只读体检；末行 WRITING_LOOP_DOCTOR_OK / _FAILED + NEXT:
  fires:                   ["fires"],                 // fires.jsonl 遥测尾巴 + 按 agent 聚合成功率
  "install-claude-plugin": ["install-claude-plugin"], // 注册本地 npm-source marketplace 给 Claude Code
};

const version = (): string => {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const usage = (): void => {
  console.log(`writing-loop ${version()} — 自治短剧编剧团队（writers' room）CLI

用法: writing-loop <command> [args]

  init [--dir D]              铺 workspace 骨架（.writing-loop/ + 空 config.json）；已有则列项目清单
  run [--project K] [--once] [--dry-run] [--plan N] [--agents a,b] [--for S]
      [--cli claude|codex|opencode]
                              起内建调度器 wl-run（包内原生 TS，零依赖）——写 repo 角色
                              全局单飞、keystone 自动升档、fires.jsonl 遥测；Ctrl-C 优雅停
  status [--project K] [--json]
                              只读板摘要：各 state 计数、In Review / In Progress 明细、
                              needs-* 停靠票、写作前沿（episodes/ep-*.md 最大集号）、
                              陈旧锁扫描、fires.jsonl 末 5 行
  doctor                      只读体检：node/workspace/config/各项目/调度 CLI 引擎；
                              暖警告不失败、结构性问题才 FAIL；末行 DOCTOR_OK/FAILED + NEXT:
  fires [--project K] [--last N] [--json]
                              fires.jsonl 遥测尾巴（默认末 20 行）+ 按 agent 聚合成功率
  install-claude-plugin [--version V] [--dry-run]
                              写本地 npm-source marketplace，让 Claude Code 从 npm 装
                              writing-loop 插件（版本默认钉住本 CLI 自身）
  version | help

板/账本等运行时状态都在 <workspace>/.writing-loop/ 下（workspace 根 = 从 CWD 向上首个含
.writing-loop/ 的目录；env WRITING_LOOP_WORKSPACE 可显式指定，坏值硬错不降级）。
立项 interview 在 Claude Code 里跑 /writing-loop:add-script。
文档: https://github.com/dyzsasd/writing-loop（docs/GUIDE*.md, references/config-schema.md）`);
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

const route = ROUTES[cmd];
if (!route) {
  console.error(`writing-loop: 未知命令 '${cmd}'\n`);
  usage();
  process.exit(2);
}

// Ctrl-C 时不抢先死：终端把 SIGINT 发给整个前台进程组（含 wl-run），这里装个 no-op 监听，
// 等子进程自己收尾（run 的优雅停由 wl-run 做）后仍能转发它的真实退出码。
process.on("SIGINT", () => { /* 等子进程收尾 */ });

const [entryBase, ...prefix] = route;
const r = spawnSync(process.execPath, [join(here, entryBase + EXT), ...prefix, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
