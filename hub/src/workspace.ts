// workspace 发现与项目解析（conventions §11 / config-schema「Workspace 根解析」的 TS 侧镜像）。
// 板等一切运行时状态都在 <workspace>/.writing-loop/ 下；根解析 = 从 CWD 向上逐级找已存在的
// .writing-loop/（像 git 找 .git）。另留一个显式逃生门：env WRITING_LOOP_WORKSPACE——
// 绝对路径且真的含 .writing-loop/ 才认；坏值硬错，绝不静默降级到走查（显式指定错了还
// 悄悄用别的根，是最难排查的一类串项目事故）。
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

export class WsError extends Error {
  constructor(msg: string) { super(msg); this.name = "WsError"; }
}

// config.json 的最小机读形状（config-schema.md 的宽松镜像——多余字段一律透传不校验，
// 校验属于 doctor/add-script，不属于路径解析层）。
export type WlProject = {
  title?: string;
  repoPath?: string;
  enabled?: boolean;
  audience?: string;
  paywall?: { card1?: unknown; card2?: unknown; card3?: unknown };
  scheduler?: Record<string, unknown>;
  [k: string]: unknown;
};
export type WlConfig = {
  version?: number;
  providers?: Record<string, unknown>;   // 端点注册表（OpenAI-compatible，opencode 专用）；
                                          //   真正的校验/类型在 scheduler.ts 的 parseProviders
                                          //   （与 scheduler 字段同一模式：这里只做宽松镜像）
  scheduler?: Record<string, unknown>;
  projects?: Record<string, WlProject>;
  [k: string]: unknown;
};
export type Workspace = { root: string; config: WlConfig };
export type ResolvedProject = { key: string; project: WlProject; repoPath: string };

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
const canon = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

// ─── 根发现 ────────────────────────────────────────────────────────────────────
export function findWorkspaceRoot(cwd = process.cwd()): string | null {
  // ① 显式 env：必须是绝对路径且真含 .writing-loop/；坏值硬错不降级。
  const explicit = process.env.WRITING_LOOP_WORKSPACE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new WsError(`WRITING_LOOP_WORKSPACE 必须是绝对路径（得到 '${explicit}'）——修正或 unset 该变量`);
    }
    if (!isDir(join(explicit, ".writing-loop"))) {
      throw new WsError(`WRITING_LOOP_WORKSPACE=${explicit} 下没有 .writing-loop/ ——修正或 unset 该变量`);
    }
    return canon(explicit);
  }
  // ② 从 realpath(CWD) 向上逐级找 .writing-loop/，到文件系统根为止；找不到返回 null。
  let dir = canon(cwd);
  for (;;) {
    if (isDir(join(dir, ".writing-loop"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── .writing-loop/ 路径 API ───────────────────────────────────────────────────
export function dataRoot(root: string): string { return join(root, ".writing-loop"); }
export function projectDataDir(root: string, key: string): string { return join(dataRoot(root), key); }
export function resolveRepoPath(root: string, project: WlProject): string {
  const rp = project.repoPath ?? "";
  return isAbsolute(rp) ? rp : join(root, rp);
}

// ─── config 装载 ───────────────────────────────────────────────────────────────
// JSON.parse 失败时给出行号——config.json 是操作者手改的文件，"position 217" 没人会数。
export function loadConfig(root: string): Workspace {
  const file = join(dataRoot(root), "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new WsError(`找不到 ${file} —— 先在 Claude Code 里跑 /writing-loop:add-script 立项（骨架可先用 writing-loop init 铺）`);
  }
  let config: WlConfig;
  try {
    config = JSON.parse(raw) as WlConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let where = "";
    const lc = /line (\d+) column (\d+)/.exec(msg);          // V8 新式报错已带行列
    const pos = /position (\d+)/.exec(msg);                  // 老式只有偏移 ⇒ 自己数行
    if (lc) {
      where = `（第 ${lc[1]} 行第 ${lc[2]} 列）`;
    } else if (pos) {
      const before = raw.slice(0, Number(pos[1]));
      const line = before.split("\n").length;
      const col = Number(pos[1]) - before.lastIndexOf("\n");
      where = `（第 ${line} 行第 ${col} 列）`;
    }
    throw new WsError(`${file} 解析失败${where}：${msg}`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new WsError(`${file} 顶层必须是 JSON 对象`);
  }
  return { root, config };
}

// ─── 项目解析（conventions §11 定位语义；scheduler.ts 与各观测命令共用） ────────
// 优先级：--project flag > CWD 在某 enabled 项目 repoPath 内 > 恰一个 enabled；
// 歧义时列出候选报错，绝不猜、绝不遍历。
export function resolveProject(ws: Workspace, flagKey?: string | null, cwd = process.cwd()): ResolvedProject {
  const projects = ws.config.projects ?? {};
  const enabled = Object.entries(projects).filter(([, p]) => p.enabled !== false);
  if (flagKey) {
    const p = projects[flagKey];
    if (!p) {
      throw new WsError(`config.json 无项目 '${flagKey}'（现有：${Object.keys(projects).join("、") || "无"}）`);
    }
    if (p.enabled === false) {
      throw new WsError(`项目 '${flagKey}' 已 enabled:false（操作者暂停中）—— 不驱动`);
    }
    return { key: flagKey, project: p, repoPath: resolveRepoPath(ws.root, p) };
  }
  const c = canon(cwd);
  for (const [key, p] of enabled) {
    const repo = canon(resolveRepoPath(ws.root, p));
    if (c === repo || c.startsWith(repo + sep)) {
      return { key, project: p, repoPath: resolveRepoPath(ws.root, p) };
    }
  }
  if (enabled.length === 1) {
    const [key, p] = enabled[0];
    return { key, project: p, repoPath: resolveRepoPath(ws.root, p) };
  }
  if (enabled.length === 0) {
    throw new WsError("无 enabled 项目 —— 先在 Claude Code 里跑 /writing-loop:add-script 立项（或检查 config.json 各项目的 enabled 开关）");
  }
  throw new WsError(`多项目 workspace，无法唯一定位 —— 用 --project 指定（enabled：${enabled.map(([k]) => k).join("、")}）`);
}

// 便捷组合：发现根 + 装 config；未在 workspace 内 ⇒ WsError（统一措辞，各命令直接透传）。
export function requireWorkspace(cwd = process.cwd()): Workspace {
  const root = findWorkspaceRoot(cwd);
  if (!root) {
    throw new WsError("未在 workspace 内（从 CWD 向上找不到 .writing-loop/，也无 WRITING_LOOP_WORKSPACE）——\n  writing-loop init 铺骨架，或在 Claude Code 里跑 /writing-loop:add-script 立项");
  }
  return loadConfig(root);
}
