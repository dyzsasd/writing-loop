// 单版本不变量守卫（仿 dev-loop test/version-sync.ts）：release-version.ts stamp 的全部
// 带版本号 manifest —— hub/package.json（npm 包）、hub/package-lock.json（顶层与根包）、.claude-plugin/plugin.json、
// .claude-plugin/marketplace.json（plugins[0].version）、.codex-plugin/plugin.json ——
// 必须同一版本号；否则 /plugin update 端上拿到旧 SKILL 集（marketplace 缓存类 bug）。
// .codex-plugin 虽不随 npm 包发行，但 Codex 端直接从 GitHub 树取用——0.6.0 事故（51c83c6
// 补提交的三个文件之一）证明「不进 tarball ≠ 漂移无害」，故一并硬断言。本测试在 CI
// checkout 里跑才守得住「stamp 了但没 commit」类漂移（本地磁盘上两者永远一致）。
// （.agents/plugins/marketplace.json 无版本字段，release-version 动态跳过，合理除外。）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersionMain, stampPackageLockText } from "../src/release-version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/test → 仓库根
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const read = (rel: string): any => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = read("hub/package.json").version as string;
const packageLock = read("hub/package-lock.json");
const lock = packageLock.version as string;
const lockRoot = packageLock.packages?.[""]?.version as string | undefined;
const plugin = read(".claude-plugin/plugin.json").version as string;
const market = read(".claude-plugin/marketplace.json").plugins[0].version as string;
const codex = read(".codex-plugin/plugin.json").version as string;

ok(typeof pkg === "string" && /^\d+\.\d+\.\d+/.test(pkg), `hub/package.json version 是 semver（${pkg}）`);
ok(pkg === lock, `hub/package.json（${pkg}）=== hub/package-lock.json 顶层 version（${lock}）`);
ok(pkg === lockRoot, `hub/package.json（${pkg}）=== hub/package-lock.json packages[\"\"] version（${lockRoot ?? "missing"}）`);
ok(pkg === plugin, `hub/package.json（${pkg}）=== .claude-plugin/plugin.json（${plugin}）`);
ok(plugin === market, `plugin.json（${plugin}）=== marketplace.json plugins[0]（${market}）`);
ok(pkg === codex, `hub/package.json（${pkg}）=== .codex-plugin/plugin.json（${codex}）`);
ok(read("hub/package.json").name === "@dyzsasd/writing-loop", "hub/package.json name 是 @dyzsasd/writing-loop（发布的 npm 包名——scoped；bin 仍是 writing-loop）");
ok(read(".claude-plugin/marketplace.json").plugins[0].name === "writing-loop", "marketplace plugins[0].name 是 writing-loop（Claude 插件名——与 npm 包名区分）");

// release-version regression: package-lock has many dependency `version` fields, so a global
// replacement is unsafe. The release stamp must update exactly the package's two identities with
// one file write while leaving a dependency that happens to share the old version untouched.
const fixtureRoot = mkdtempSync(join(tmpdir(), "writing-loop-release-version-"));
try {
  mkdirSync(join(fixtureRoot, "hub"), { recursive: true });
  writeFileSync(join(fixtureRoot, "hub", "package.json"), `${JSON.stringify({
    name: "@dyzsasd/writing-loop",
    version: "1.2.3",
  }, null, 2)}\n`);
  const lockFixture = `{
  "name": "@dyzsasd/writing-loop",
  "version": "1.2.3",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "@dyzsasd/writing-loop",
      "version": "1.2.3",
      "license": "MIT"
    },
    "node_modules/same-version-dependency": {
      "version": "1.2.3",
      "integrity": "sha512-UNCHANGED"
    }
  }
}
`;
  writeFileSync(join(fixtureRoot, "hub", "package-lock.json"), lockFixture);
  const releaseCode = releaseVersionMain(["2.0.0"], fixtureRoot);
  const stampedPackage = JSON.parse(readFileSync(join(fixtureRoot, "hub", "package.json"), "utf8"));
  const stampedLockText = readFileSync(join(fixtureRoot, "hub", "package-lock.json"), "utf8");
  const stampedLock = JSON.parse(stampedLockText);
  const changedLockLines = lockFixture.split("\n").filter((line, index) => line !== stampedLockText.split("\n")[index]);
  ok(releaseCode === 0 && stampedPackage.version === "2.0.0"
    && stampedLock.version === "2.0.0" && stampedLock.packages[""].version === "2.0.0"
    && stampedLock.packages["node_modules/same-version-dependency"].version === "1.2.3"
    && stampedLock.packages["node_modules/same-version-dependency"].integrity === "sha512-UNCHANGED"
    && changedLockLines.length === 2,
  "release-version 只同步 package-lock 顶层 + packages[\"\"] 两行，绝不改同版本 dependency");

  let malformedRejected = false;
  try { stampPackageLockText(lockFixture.replace('  "packages": {', ' "packages": {'), "2.0.0"); }
  catch { malformedRejected = true; }
  ok(malformedRejected, "package-lock 非 canonical scope 时 release-version fail-closed，不盲目全局替换");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nVERSION_SYNC_OK" : `\n${fails} 项检查失败 —— 跑 node hub/src/release-version.ts <version> 印齐`);
process.exit(fails === 0 ? 0 : 1);
