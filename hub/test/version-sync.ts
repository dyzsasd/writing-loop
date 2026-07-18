// 单版本不变量守卫（仿 dev-loop test/version-sync.ts）：随包发行的三个 manifest ——
// hub/package.json（npm 包）、.claude-plugin/plugin.json、.claude-plugin/marketplace.json
// （plugins[0].version）—— 必须同一版本号；否则 /plugin update 端上拿到旧 SKILL 集
// （marketplace 缓存类 bug）。`node hub/src/release-version.ts <v>` 一次印全；本测试守它们
// 永不静默漂移。（.codex-plugin/.agents 两份 manifest 不随 npm 包发行，由 release-version
// 顺手 stamp，不在本守卫硬断言范围。）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/test → 仓库根
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const read = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = read("hub/package.json").version as string;
const plugin = read(".claude-plugin/plugin.json").version as string;
const market = read(".claude-plugin/marketplace.json").plugins[0].version as string;

ok(typeof pkg === "string" && /^\d+\.\d+\.\d+/.test(pkg), `hub/package.json version 是 semver（${pkg}）`);
ok(pkg === plugin, `hub/package.json（${pkg}）=== .claude-plugin/plugin.json（${plugin}）`);
ok(plugin === market, `plugin.json（${plugin}）=== marketplace.json plugins[0]（${market}）`);
ok(read("hub/package.json").name === "@dyzsasd/writing-loop", "hub/package.json name 是 @dyzsasd/writing-loop（发布的 npm 包名——scoped；bin 仍是 writing-loop）");
ok(read(".claude-plugin/marketplace.json").plugins[0].name === "writing-loop", "marketplace plugins[0].name 是 writing-loop（Claude 插件名——与 npm 包名区分）");

console.log(fails === 0 ? "\nVERSION_SYNC_OK" : `\n${fails} 项检查失败 —— 跑 node hub/src/release-version.ts <version> 印齐`);
process.exit(fails === 0 ? 0 : 1);
