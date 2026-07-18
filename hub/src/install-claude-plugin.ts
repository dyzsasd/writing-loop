// `writing-loop install-claude-plugin` —— 注册一个本地 marketplace，其唯一插件用 `npm`
// source，让 Claude Code 直接从 npm 装已发布的 @dyzsasd/writing-loop 插件（无 GitHub、
// 无会与 npm 版本漂移的文件拷贝）。逐字仿 dev-loop 同名文件的结构：写出小小的
// marketplace.json + 打印两条交互式 /plugin 命令（本 CLI 无法替用户执行它们）。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pkgVersion } from "./paths.ts";

const MARKETPLACE = "writing-loop-npm";
const PLUGIN = "writing-loop";
const defaultDest = (): string => join(homedir(), ".claude", "plugins", "marketplaces", MARKETPLACE);

function usage(): void {
  console.log(`writing-loop install-claude-plugin — 注册本地 npm-source marketplace 给 Claude Code

用法:
  writing-loop install-claude-plugin [--dest <dir>] [--package <name>] [--version <semver>] [--dry-run]

写一个 marketplace.json，其插件从 npm 拉取（默认 @dyzsasd/writing-loop），然后打印两条
交互式 /plugin 命令。无 GitHub、无文件拷贝——npm 包是插件版本的单一真相源。

选项:
  --dest <dir>       marketplace 目录（默认 ~/.claude/plugins/marketplaces/${MARKETPLACE}）
  --package <name>   npm 包名（默认 @dyzsasd/writing-loop）
  --version <semver> 钉住某版本（默认钉本 CLI 自身版本；--version latest 回到浮动 latest）
  --dry-run          只打印 marketplace.json 与命令，不写文件`);
}

function die(msg: string, code = 2): never {
  console.error(`writing-loop install-claude-plugin: ${msg}`);
  process.exit(code);
}

export function installClaudePlugin(argv = process.argv.slice(2)): number {
  const opts = { dest: defaultDest(), pkg: "@dyzsasd/writing-loop", version: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i] ?? die(`${a} 需要值`);
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--package") opts.pkg = next();
    else if (a === "--version") opts.version = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else die(`未知选项 '${a}'`);
  }

  // 版本默认钉住本 CLI 自身版本——不钉的话 Claude Code 解析 npm `latest` dist-tag，
  // 可能装到比 CLI 老的插件（缺最新 skills）。--version <semver|dist-tag> 覆盖；
  // 传 --version latest 显式回到浮动 latest。
  const version = opts.version || pkgVersion();
  const source: Record<string, string> = { source: "npm", package: opts.pkg };
  if (version && version !== "latest") source.version = version;
  const marketplace = { name: MARKETPLACE, owner: { name: "Shuai" }, plugins: [{ name: PLUGIN, source }] };
  const file = join(opts.dest, ".claude-plugin", "marketplace.json");
  const json = JSON.stringify(marketplace, null, 2) + "\n";

  if (opts.dryRun) {
    console.log(`将写入 ${file}:\n${json}`);
  } else {
    mkdirSync(join(opts.dest, ".claude-plugin"), { recursive: true });
    writeFileSync(file, json);
    console.log(`已写入 ${file}`);
  }
  console.log(`\n接着在 Claude Code 里跑这两条交互式命令:`);
  console.log(`  /plugin marketplace add ${opts.dest}`);
  console.log(`  /plugin install ${PLUGIN}@${MARKETPLACE}`);
  console.log(`\n将安装 ${opts.pkg}@${version || "latest"}（默认钉住本 CLI 版本；--version 可改）。`);
  console.log(`然后 /reload-plugins（或重启）。skills 以 /writing-loop:showrunner-agent … /writing-loop:add-script 出现。`);
  if (!opts.dryRun && !existsSync(file)) die(`写入失败 ${file}`, 1);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(installClaudePlugin());
}
