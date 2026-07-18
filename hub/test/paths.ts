// paths 单测：pkgVersion 是 semver 且与 package.json 一致；pluginRoot 源码态解析到
// 含 skills/+references/+scripts/ 的树；findOnPath 动态读 PATH。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOnPath, isPluginRoot, pkgVersion, pluginRoot } from "../src/paths.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── pkgVersion ──
const v = pkgVersion();
const pkgJson = JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8")) as { version: string };
ok(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v), `pkgVersion() 是 semver（${v}）`);
ok(v === pkgJson.version, `pkgVersion() 与 hub/package.json 一致（${pkgJson.version}）`);

// ── pluginRoot（源码态：hub/src/../.. = 仓库根；若 hub/ 已 build 出拷贝，hub/ 本身也是合法插件根） ──
const root = pluginRoot();
ok(isPluginRoot(root), `pluginRoot() 满足判据（skills/+references/+scripts/）：${root}`);
ok(existsSync(join(root, "scripts", "board-lock.sh")), "插件根下有 scripts/board-lock.sh（锁 choreography 助手）");
ok(!existsSync(join(root, "scripts", "wl-run.py")), "插件根下无 scripts/wl-run.py（python 调度器已退役——引擎在 hub/src/scheduler.ts）");
ok(existsSync(join(root, "skills", "showrunner-agent", "SKILL.md")), "插件根下有 skills/showrunner-agent/SKILL.md");
ok(existsSync(join(root, "references", "conventions.md")), "插件根下有 references/conventions.md");

// ── isPluginRoot 反例 ──
ok(!isPluginRoot(join(hubRoot, "src")), "hub/src 不是插件根（无 skills/）");

// ── findOnPath（动态读 PATH——空 PATH 下必须返回 null） ──
const savedPath = process.env.PATH;
try {
  ok(findOnPath("node") !== null, "findOnPath('node') 在正常 PATH 下命中");
  process.env.PATH = "";
  ok(findOnPath("node") === null, "空 PATH 下 findOnPath 返回 null（不猜绝对路径）");
} finally {
  process.env.PATH = savedPath;
}

console.log(fails === 0 ? "\nPATHS_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
