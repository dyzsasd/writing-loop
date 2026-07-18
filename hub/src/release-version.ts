// `node hub/src/release-version.ts <semver>` —— 单版本印章（仿 dev-loop release-version）。
// 把同一个版本号写进所有「实有 version 字段」的 manifest，使发布永不漂移（marketplace
// 缓存类 bug：plugin.json 升了而 marketplace.json 还旧，/plugin update 端上就拿到旧 SKILL 集）。
// 候选五件套：hub/package.json、.claude-plugin/plugin.json、.claude-plugin/marketplace.json
//（plugins[0].version）、.codex-plugin/plugin.json、.agents/plugins/marketplace.json——
// 逐个读文件动态确认哪些真有 version 字段，只 stamp 实有的（.agents 的 marketplace 目前没有）。
// 每文件单行文本替换保格式 ⇒ 一行 diff。守卫：needle 非恰一处 ⇒ 拒绝盲替换。
//
// 源码树专用（故意不进 cli.ts 的 ROUTES）：它改的 manifests 不随 npm 包发布。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/src → 仓库根
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`用法: node hub/src/release-version.ts <semver>   （例 0.5.0）\n  得到: ${version ?? "(无)"}`);
  process.exit(2);
}

// rel → 从解析后的 JSON 里取当前版本；返回 undefined = 该文件没有 version 字段。
const files: Array<{ rel: string; cur: (j: any) => string | undefined }> = [
  { rel: "hub/package.json",                 cur: (j) => j.version },
  { rel: ".claude-plugin/plugin.json",       cur: (j) => j.version },
  { rel: ".claude-plugin/marketplace.json",  cur: (j) => j?.plugins?.[0]?.version },
  { rel: ".codex-plugin/plugin.json",        cur: (j) => j.version },
  { rel: ".agents/plugins/marketplace.json", cur: (j) => j?.plugins?.[0]?.version },
];

let changed = 0;
for (const f of files) {
  const path = join(repoRoot, f.rel);
  if (!existsSync(path)) { console.log(`- ${f.rel}: 文件不存在，跳过`); continue; }
  const txt = readFileSync(path, "utf8");
  const cur = f.cur(JSON.parse(txt)); // 先验证可解析 + 定位当前值
  if (typeof cur !== "string") { console.log(`- ${f.rel}: 无 version 字段，跳过`); continue; }
  if (cur === version) { console.log(`= ${f.rel}: 已是 ${version}`); continue; }
  const needle = `"version": "${cur}"`;
  const count = txt.split(needle).length - 1;
  if (count !== 1) {
    console.error(`x ${f.rel}: 期望恰一处 ${needle}，实得 ${count} 处 —— 拒绝盲替换，请人工处理`);
    process.exit(1);
  }
  writeFileSync(path, txt.replace(needle, `"version": "${version}"`));
  console.log(`+ ${f.rel}: ${cur} -> ${version}`);
  changed++;
}
console.log(`\n已把 ${version} 印进 ${changed} 个 manifest（其余 = 已同步 / 无 version 字段 / 文件缺失）。`);
