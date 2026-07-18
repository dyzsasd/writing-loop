// hub 的路径解析原语：包版本、插件根、PATH 上的可执行文件发现。
// 与 dev-loop hub/src/paths.ts 同构——src/paths.ts（源码态）与 dist/paths.js（发布态）
// 都在包根下一层，../package.json 两种形态下都能解析。
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src（源码态）| <pkg>/dist（发布态）

// 本包自己的版本号（daemon/守卫/版本钉住都从这一处读）。读不到给空串，不抛——
// 版本号只用于展示与钉住，绝不该弄死一条命令。
let cachedVersion: string | undefined;
export function pkgVersion(): string {
  if (cachedVersion === undefined) {
    try {
      cachedVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "";
    } catch {
      cachedVersion = "";
    }
  }
  return cachedVersion;
}

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// 插件根判据：skills/ 与 references/ 与 scripts/ 三者同在的目录——
// SKILL.md、conventions、board-lock.sh 等 agent 工具全从这棵树取。
export function isPluginRoot(dir: string): boolean {
  return isDir(join(dir, "skills")) && isDir(join(dir, "references")) && isDir(join(dir, "scripts"));
}

// 插件根解析：候选 resolve(here,"..")（发布态——build 把 skills/references/scripts/templates
// 拷进包根）与 resolve(here,"..","..")（源码态——hub/src 的上上级即仓库根）。
// 都不中 ⇒ 清晰报错，不猜第三个位置。
export function pluginRoot(): string {
  const candidates = [resolve(here, ".."), resolve(here, "..", "..")];
  for (const c of candidates) if (isPluginRoot(c)) return c;
  throw new Error(
    `writing-loop: 找不到插件根（需同时含 skills/ + references/ + scripts/ 的目录）。试过：${candidates.join("、")}。` +
    `发布包损坏请重装 @dyzsasd/writing-loop；源码运行请从完整仓库 checkout 启动。`,
  );
}

// PATH 走查找可执行文件（doctor 检查 claude/codex/opencode 也用这一个原语）。
// 找不到返回 null——报错措辞由调用方决定。
export function findOnPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* 下一个候选 */ }
    }
  }
  return null;
}
