// `node hub/src/release-version.ts <semver>` —— 单版本印章（仿 dev-loop release-version）。
// 把同一个版本号写进所有「实有 version 字段」的 manifest，使发布永不漂移（marketplace
// 缓存类 bug：plugin.json 升了而 marketplace.json 还旧，/plugin update 端上就拿到旧 SKILL 集）。
// 普通 manifest + npm lock：hub/package.json、hub/package-lock.json、.claude-plugin/plugin.json、.claude-plugin/marketplace.json
//（plugins[0].version）、.codex-plugin/plugin.json、.agents/plugins/marketplace.json——
// 逐个读文件动态确认哪些真有 version 字段，只 stamp 实有的（.agents 的 marketplace 目前没有）。
// 每文件单行文本替换保格式 ⇒ 一行 diff。守卫：needle 非恰一处 ⇒ 拒绝盲替换。
//
// 源码树专用（故意不进 cli.ts 的 ROUTES）：它改的 manifests 不随 npm 包发布。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/src → 仓库根

// rel → 从解析后的 JSON 里取当前版本；返回 undefined = 该文件没有 version 字段。
const files: Array<{ rel: string; cur: (j: any) => string | undefined }> = [
  { rel: "hub/package.json",                 cur: (j) => j.version },
  { rel: ".claude-plugin/plugin.json",       cur: (j) => j.version },
  { rel: ".claude-plugin/marketplace.json",  cur: (j) => j?.plugins?.[0]?.version },
  { rel: ".codex-plugin/plugin.json",        cur: (j) => j.version },
  { rel: ".agents/plugins/marketplace.json", cur: (j) => j?.plugins?.[0]?.version },
];

/**
 * Surgically stamp only package-lock's top-level package version and packages[""].version.
 * Dependency versions with the same old value are outside those two lexical scopes and remain
 * byte-for-byte untouched. Both targets are validated before this function returns one new file,
 * so the caller can persist the pair with a single write.
 */
export function stampPackageLockText(text: string, version: string): string {
  const parsed = JSON.parse(text) as { version?: unknown; packages?: Record<string, { version?: unknown }> };
  const topVersion = parsed.version;
  const rootVersion = parsed.packages?.[""]?.version;
  if (typeof topVersion !== "string" || typeof rootVersion !== "string") {
    throw new Error("hub/package-lock.json 缺少顶层 version 或 packages[\"\"].version");
  }
  const packagesMarker = '  "packages": {';
  const packagesAt = text.indexOf(packagesMarker);
  if (packagesAt < 0) throw new Error("hub/package-lock.json 缺少 canonical packages block");
  const rootMarker = '    "": {';
  const rootAt = text.indexOf(rootMarker, packagesAt + packagesMarker.length);
  if (rootAt < 0) throw new Error("hub/package-lock.json 缺少 canonical packages[\"\"] block");
  let rootEnd = text.indexOf('\n    "', rootAt + rootMarker.length);
  if (rootEnd < 0) rootEnd = text.indexOf("\n  }", rootAt + rootMarker.length);
  if (rootEnd < 0) throw new Error("hub/package-lock.json packages[\"\"] block 未闭合");

  const replaceScopedLine = (scope: string, indent: string, current: string, label: string): string => {
    const needle = `${indent}"version": "${current}",`;
    const count = scope.split(needle).length - 1;
    if (count !== 1) throw new Error(`${label} 期望恰一处 ${needle}，实得 ${count} 处`);
    return current === version ? scope : scope.replace(needle, `${indent}"version": "${version}",`);
  };

  const header = replaceScopedLine(text.slice(0, packagesAt), "  ", topVersion, "package-lock 顶层");
  const beforeRoot = text.slice(packagesAt, rootAt);
  const root = replaceScopedLine(text.slice(rootAt, rootEnd), "      ", rootVersion, "package-lock packages[\"\"]");
  const updated = header + beforeRoot + root + text.slice(rootEnd);
  const verified = JSON.parse(updated) as { version?: unknown; packages?: Record<string, { version?: unknown }> };
  if (verified.version !== version || verified.packages?.[""]?.version !== version) {
    throw new Error("hub/package-lock.json stamp 后版本复核失败");
  }
  return updated;
}

export function releaseVersionMain(argv = process.argv.slice(2), root = repoRoot): number {
  const version = argv[0];
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`用法: node hub/src/release-version.ts <semver>   （例 0.5.0）\n  得到: ${version ?? "(无)"}`);
    return 2;
  }

  let changed = 0;
  for (const f of files) {
    const path = join(root, f.rel);
    if (!existsSync(path)) { console.log(`- ${f.rel}: 文件不存在，跳过`); continue; }
    const txt = readFileSync(path, "utf8");
    const cur = f.cur(JSON.parse(txt)); // 先验证可解析 + 定位当前值
    if (typeof cur !== "string") { console.log(`- ${f.rel}: 无 version 字段，跳过`); continue; }
    if (cur === version) { console.log(`= ${f.rel}: 已是 ${version}`); continue; }
    const needle = `"version": "${cur}"`;
    const count = txt.split(needle).length - 1;
    if (count !== 1) {
      console.error(`x ${f.rel}: 期望恰一处 ${needle}，实得 ${count} 处 —— 拒绝盲替换，请人工处理`);
      return 1;
    }
    writeFileSync(path, txt.replace(needle, `"version": "${version}"`));
    console.log(`+ ${f.rel}: ${cur} -> ${version}`);
    changed++;
  }

  const lockRel = "hub/package-lock.json";
  const lockPath = join(root, lockRel);
  if (!existsSync(lockPath)) {
    console.log(`- ${lockRel}: 文件不存在，跳过`);
  } else {
    const before = readFileSync(lockPath, "utf8");
    try {
      const after = stampPackageLockText(before, version);
      if (after === before) console.log(`= ${lockRel}: 两处 package version 已是 ${version}`);
      else {
        writeFileSync(lockPath, after);
        console.log(`+ ${lockRel}: 顶层 + packages[\"\"] -> ${version}`);
        changed++;
      }
    } catch (error) {
      console.error(`x ${lockRel}: ${error instanceof Error ? error.message : String(error)} —— 拒绝盲替换，请人工处理`);
      return 1;
    }
  }

  console.log(`\n已把 ${version} 印进 ${changed} 个 manifest（其余 = 已同步 / 无 version 字段 / 文件缺失）。`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(releaseVersionMain());
}
