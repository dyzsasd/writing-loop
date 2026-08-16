// `writing-loop bundle export` / `bundle import` —— 把一个 workspace 从一台机器搬到另一台。
//
// 语义是 MOVE 而不是 SYNC（dev-loop bundle.ts 同款原则）：导入端目标目录必须为空，从不覆盖
// 一个活着的 workspace；两台机器不会同时持有同一个 workspace ID 的活跃副本。
//
// 随 bundle 走的（= 一个 workspace 的全部真相源）：
//   - .writing-loop/workspace.json           稳定 workspace ID（迁移保留，registry 靠它去重）
//   - .writing-loop/config.json              项目与调度配置；导入端把每个项目 enabled 置 false，
//                                            由操作者显式 `project enable`——绝不在新机器上静默开跑
//   - .writing-loop/system/                  workspace 级系统改进收件箱
//   - .writing-loop/assets/                  内容寻址资产库（Blender 灰模等二进制）
//   - .writing-loop/<key>/                   每个项目的运行态：board / state / lessons / reports /
//                                            source-intake / fires.jsonl / events.jsonl / activity-index
//   - <repoPath>                             每个项目的剧本 repo，以 `git bundle --all` 形式携带完整
//                                            历史；导入端 `git clone` 还原，不是拷贝 .git 目录
//   - workspace 根下、config 或 source-intake 引用到的原著文件（它们刻意不进剧本 git）
//
// 刻意不带的（机器本地，带过去只会误导）：
//   - <key>/logs/                            agent 日志，体积大且只对源机器排障有用
//   - <key>/run-state.json、wl-run.lock*     调度器活跃状态与锁——新机器上没有那个进程
//   - <key>/scheduler.out.log、studio.log    同上
//   - .onboarding-transactions/              立项事务的崩溃恢复现场，只对源机器有意义
//   - config.json.bak-*                      操作者的手工备份
//   - 任何 CLI 认证（~/.claude、~/.codex）    每台机器各自登录，凭据不出境
//
// 文件格式：单个 tar.gz。顶层 `writing-loop-bundle/manifest.json` 是清单，其余每个条目都在
// manifest.files 里带 SHA-256；导入端逐文件校验后才落盘，任一不符整体拒绝。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataRoot, findWorkspaceRoot, loadConfig, projectDataDir, projectEntries, resolveRepoPath, WsError, type WlProject } from "./workspace.ts";
import { readWorkspaceIdentity, registerWorkspace } from "./workspace-registry.ts";

export const BUNDLE_SCHEMA = 1 as const;
const BUNDLE_DIR = "writing-loop-bundle";
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB 上限：超过它说明打进了不该打的东西

// 项目运行态里排除的条目（相对 <key>/）——见文件头「刻意不带的」。
const PROJECT_EXCLUDE = new Set(["logs", "run-state.json", "scheduler.out.log", "wl-run.lock"]);
const projectExcluded = (name: string): boolean => PROJECT_EXCLUDE.has(name) || name.startsWith("wl-run.lock");
// workspace 数据根排除的条目（相对 .writing-loop/）。
const DATA_ROOT_EXCLUDE = new Set([".onboarding-transactions", "studio.log", "project-archive"]);
const dataRootExcluded = (name: string): boolean => DATA_ROOT_EXCLUDE.has(name) || /^config\.json\.bak/.test(name);

export type BundleManifest = {
  bundleSchema: typeof BUNDLE_SCHEMA;
  writingLoopVersion: string;
  authoredAt: string;
  sourceHost: string;
  workspaceId: string;
  workspaceLabel: string | null;
  projects: Array<{ key: string; title: string | null; repoPath: string; gitHead: string | null; enabledAtExport: boolean }>;
  sourceFiles: string[];                       // workspace 根下随包携带的原著文件（相对 root）
  files: Record<string, { sha256: string; bytes: number }>;   // tar 内路径 → 指纹（不含 manifest 自身）
  totalBytes: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const pkgVersion = (): string => {
  try { return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
};

function usage(): void {
  console.log(`writing-loop bundle — 把 workspace 从一台机器搬到另一台（MOVE 语义，不是同步）

用法:
  writing-loop bundle export --out FILE.tar.gz [--include-logs]
      在 workspace 内执行。打包剧本 repo（完整 git 历史）、运行态板、资产库、原著文件、
      workspace 身份。默认不带 agent 日志（--include-logs 可加）。导出后 workspace 原样不动。
  writing-loop bundle import FILE.tar.gz --dir NEW_ROOT [--label L]
      NEW_ROOT 必须不存在或为空目录。逐文件校验 SHA-256，clone 剧本 repo，写 registry。
      导入后每个项目都是暂停态——先 doctor，再 project enable，再 run。
  writing-loop bundle inspect FILE.tar.gz
      只读打印清单，不解包。

迁移顺序（普通用户路径）：源机 project disable → bundle export → 传输 → 目标机 bundle import
→ doctor → project enable → run。两台机器不要同时运行同一个 workspace。`);
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const die = (msg: string): never => { console.error(`writing-loop bundle: ${msg}`); process.exit(2); };

// 递归收集目录下的普通文件（相对路径），跳过 symlink 与非普通文件——bundle 只承载可校验的内容。
function walk(root: string, skip: (rel: string, name: string, depth: number) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name); const rel = relative(root, abs);
      if (skip(rel, entry.name, depth)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(abs, depth + 1);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root, 0);
  return out;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
export function bundleExport(argv: string[]): number {
  let out: string | null = null; let includeLogs = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { out = argv[++i] ?? null; if (!out) return die("--out 需要值"); }
    else if (a === "--include-logs") includeLogs = true;
    else if (a === "--help" || a === "-h") { usage(); return 0; }
    else return die(`未知参数 '${a}'`);
  }
  if (!out) return die("需要 --out FILE.tar.gz");
  if (!/\.(tar\.gz|tgz)$/.test(out)) return die("--out 必须以 .tar.gz 或 .tgz 结尾");
  const outAbs = resolve(out);
  if (existsSync(outAbs)) return die(`${outAbs} 已存在，不覆盖`);

  let ws: ReturnType<typeof loadConfig>;
  try {
    const found = findWorkspaceRoot();
    if (!found) return die("未在 workspace 内（从 CWD 向上找不到 .writing-loop/，也无 WRITING_LOOP_WORKSPACE）");
    ws = loadConfig(found);
  } catch (e) { return die(e instanceof WsError ? e.message : String(e)); }
  const root = ws.root; const data = dataRoot(root);
  const identity = readWorkspaceIdentity(root);

  // 拒绝在调度器活跃时导出：会打进半写入的板。
  for (const [key] of projectEntries(ws.config)) {
    const rs = join(projectDataDir(root, key), "run-state.json");
    if (existsSync(rs)) {
      try {
        const st = JSON.parse(readFileSync(rs, "utf8")) as { status?: string; inFlight?: unknown[] };
        if (st.status === "running" || (Array.isArray(st.inFlight) && st.inFlight.length)) {
          return die(`项目 ${key} 的调度器仍在运行（run-state=${st.status}）——先 project disable 并等它停下，再导出`);
        }
      } catch { /* 读不出就当没在跑 */ }
    }
  }

  const stage = mkdtempSync(join(tmpdir(), "wl-bundle-"));
  const stageRoot = join(stage, BUNDLE_DIR);
  mkdirSync(stageRoot, { recursive: true });
  const files: BundleManifest["files"] = {};
  const put = (relInBundle: string, srcAbs: string): void => {
    const dst = join(stageRoot, relInBundle); mkdirSync(dirname(dst), { recursive: true });
    const buf = readFileSync(srcAbs); writeFileSync(dst, buf);
    files[relInBundle] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  };

  try {
    // 1) workspace 数据根：identity、config、system、assets、每个项目的运行态
    for (const rel of walk(data, (r, name, depth) => {
      if (depth === 0 && dataRootExcluded(name)) return true;
      // 项目目录内的排除按第二层判断
      const parts = r.split("/");
      if (parts.length >= 2 && projectExcluded(parts[1]) && !(includeLogs && parts[1] === "logs")) return true;
      return false;
    })) put(join("data", rel), join(data, rel));

    // 2) 每个项目的剧本 repo → git bundle
    const projects: BundleManifest["projects"] = [];
    for (const [key, project] of projectEntries(ws.config)) {
      const repo = resolveRepoPath(root, project as WlProject);
      if (!existsSync(join(repo, ".git"))) return die(`项目 ${key} 的 repoPath ${repo} 不是 git 仓库`);
      const dirty = git(repo, ["status", "--porcelain"]);
      if (dirty.ok && dirty.out) return die(`项目 ${key} 的剧本 repo 有未提交改动——先提交或 stash，再导出:\n${dirty.out.split("\n").slice(0, 5).join("\n")}`);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const gb = join(stage, `${key}.gitbundle`);
      const r = git(repo, ["bundle", "create", gb, "--all"]);
      if (!r.ok) return die(`git bundle 失败（${key}）: ${r.err}`);
      put(join("repos", `${key}.gitbundle`), gb);
      projects.push({ key, title: typeof project.title === "string" ? project.title : null,
        repoPath: relative(root, repo) || ".", gitHead: head.ok ? head.out : null,
        enabledAtExport: project.enabled !== false });
    }

    // 3) 原著文件：source-intake 引用的、位于 workspace 根下的文件
    const sourceFiles = new Set<string>();
    for (const [key] of projectEntries(ws.config)) {
      const manifestPath = join(projectDataDir(root, key), "source-intake.v1", "manifest.v1.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { source?: { path?: string; originalPath?: string } };
        for (const p of [m.source?.path, m.source?.originalPath]) {
          if (typeof p !== "string") continue;
          const abs = resolve(root, p);
          if (abs.startsWith(root + "/") && existsSync(abs) && statSync(abs).isFile()) sourceFiles.add(relative(root, abs));
        }
      } catch { /* manifest 形状不符就不带原著——导入端会明确报缺 */ }
    }
    for (const rel of [...sourceFiles].sort()) put(join("sources", rel), join(root, rel));

    // 4) manifest
    const totalBytes = Object.values(files).reduce((s, f) => s + f.bytes, 0);
    if (totalBytes > MAX_BUNDLE_BYTES) return die(`bundle 体积 ${totalBytes} B 超过上限 ${MAX_BUNDLE_BYTES} B`);
    const label = (() => { try { return (JSON.parse(readFileSync(join(process.env.HOME ?? "", ".writing-loop", "workspaces.json"), "utf8")) as { workspaces?: Array<{ id: string; label?: string }> })
      .workspaces?.find((w) => w.id === identity.id)?.label ?? null; } catch { return null; } })();
    const manifest: BundleManifest = { bundleSchema: BUNDLE_SCHEMA, writingLoopVersion: pkgVersion(),
      authoredAt: new Date().toISOString(), sourceHost: hostname(), workspaceId: identity.id,
      workspaceLabel: label, projects, sourceFiles: [...sourceFiles].sort(), files, totalBytes };
    writeFileSync(join(stageRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    // 5) tar.gz
    mkdirSync(dirname(outAbs), { recursive: true });
    const tar = spawnSync("tar", ["-czf", outAbs, "-C", stage, BUNDLE_DIR], { encoding: "utf8" });
    if (tar.status !== 0) return die(`tar 失败: ${tar.stderr}`);
    const outBytes = statSync(outAbs).size;
    console.log(`writing-loop bundle: 已导出 ${outAbs}`);
    console.log(`  workspace ${identity.id}${label ? `（${label}）` : ""} · ${projects.length} 个项目 · ${Object.keys(files).length} 个文件 · 内容 ${fmtBytes(totalBytes)} · 压缩后 ${fmtBytes(outBytes)}`);
    for (const p of projects) console.log(`  - ${p.key}${p.title ? `（${p.title}）` : ""} repo=${p.repoPath} head=${p.gitHead?.slice(0, 7) ?? "?"}${p.enabledAtExport ? "" : "（导出时已暂停）"}`);
    if (sourceFiles.size) console.log(`  原著文件: ${[...sourceFiles].join(", ")}`);
    if (!includeLogs) console.log(`  未携带 agent 日志（--include-logs 可加）`);
    console.log(`\n下一步: 把文件传到目标机，然后 writing-loop bundle import ${basename(outAbs)} --dir <新 workspace 路径>`);
    return 0;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------
export function bundleImport(argv: string[]): number {
  let file: string | null = null; let dir: string | null = null; let label: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") { dir = argv[++i] ?? null; if (!dir) return die("--dir 需要值"); }
    else if (a === "--label") { label = argv[++i]; if (!label) return die("--label 需要值"); }
    else if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a.startsWith("--")) return die(`未知参数 '${a}'`);
    else if (!file) file = a;
    else return die(`多余参数 '${a}'`);
  }
  if (!file) return die("需要 bundle 文件路径");
  if (!dir) return die("需要 --dir NEW_ROOT");
  const fileAbs = resolve(file); const root = resolve(dir);
  if (!existsSync(fileAbs)) return die(`${fileAbs} 不存在`);
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) return die(`${root} 不是目录`);
    if (readdirSync(root).length) return die(`${root} 非空——bundle import 是 MOVE 语义，只落进空目录，不覆盖任何现存 workspace`);
  }

  const stage = mkdtempSync(join(tmpdir(), "wl-bundle-in-"));
  try {
    const tar = spawnSync("tar", ["-xzf", fileAbs, "-C", stage], { encoding: "utf8" });
    if (tar.status !== 0) return die(`解包失败: ${tar.stderr}`);
    const stageRoot = join(stage, BUNDLE_DIR);
    const manifestPath = join(stageRoot, "manifest.json");
    if (!existsSync(manifestPath)) return die("不是 writing-loop bundle（缺 manifest.json）");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
    if (manifest.bundleSchema !== BUNDLE_SCHEMA) return die(`bundleSchema ${String(manifest.bundleSchema)} 不受支持（本版支持 ${BUNDLE_SCHEMA}）`);
    if (!/^ws_[a-f0-9]{32}$/.test(manifest.workspaceId)) return die("manifest.workspaceId 无效");

    // 1) 逐文件校验指纹——任一不符整体拒绝，目标目录零写入
    const declared = Object.keys(manifest.files);
    const present = walk(stageRoot).filter((r) => r !== "manifest.json");
    const missing = declared.filter((r) => !present.includes(r));
    const extra = present.filter((r) => !declared.includes(r));
    if (missing.length) return die(`bundle 缺 ${missing.length} 个清单文件，例如 ${missing.slice(0, 3).join(", ")}`);
    if (extra.length) return die(`bundle 含 ${extra.length} 个清单外文件，例如 ${extra.slice(0, 3).join(", ")}——拒绝`);
    for (const rel of declared) {
      const abs = join(stageRoot, rel);
      const got = sha256File(abs); const want = manifest.files[rel];
      if (got !== want.sha256 || statSync(abs).size !== want.bytes) return die(`指纹不符: ${rel}`);
    }

    // 2) 剧本 repo 预检：每个 gitbundle 先 clone 进临时目录，能 clone 才算完整（`git bundle
    //    verify` 需要在一个仓库内执行，clone 本身就是最强的校验）。此时目标目录仍零写入。
    for (const p of manifest.projects) {
      const gb = join(stageRoot, "repos", `${p.key}.gitbundle`);
      if (!existsSync(gb)) return die(`缺 repos/${p.key}.gitbundle`);
      const probe = join(stage, `probe-${p.key}`);
      const r = git(stage, ["clone", "--quiet", "--bare", gb, probe]);
      if (!r.ok) return die(`repos/${p.key}.gitbundle 不是可用的 git bundle: ${r.err}`);
      const repoAbs = resolve(root, p.repoPath);
      if (!repoAbs.startsWith(root + "/") && repoAbs !== root) return die(`项目 ${p.key} 的 repoPath 逃逸 workspace 根`);
    }

    // 3) 落盘：数据根 + 原著文件（纯拷贝，路径已校验在 stage 内）。从这里起若失败则回滚目标目录。
    mkdirSync(root, { recursive: true });
    const created = root;
    const rollback = (msg: string): never => { try { rmSync(created, { recursive: true, force: true }); } catch { /* 尽力 */ } return die(`${msg}（目标目录已回滚）`); };
    const data = dataRoot(root);
    for (const rel of declared) {
      if (rel.startsWith("data/")) { const dst = join(data, rel.slice(5)); mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, readFileSync(join(stageRoot, rel))); }
      else if (rel.startsWith("sources/")) { const dst = join(root, rel.slice(8)); mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, readFileSync(join(stageRoot, rel))); }
    }
    // identity 必须与 manifest 一致（bundle 内容自洽性）
    const identity = readWorkspaceIdentity(root);
    if (identity.id !== manifest.workspaceId) return rollback(`workspace.json 的 id ${identity.id} 与 manifest ${manifest.workspaceId} 不一致`);

    // 4) 剧本 repo：git clone 自 bundle 文件，还原完整历史与工作树
    for (const p of manifest.projects) {
      const gb = join(stageRoot, "repos", `${p.key}.gitbundle`);
      const repoAbs = resolve(root, p.repoPath);
      const clone = git(stage, ["clone", "--quiet", gb, repoAbs]);
      if (!clone.ok) return rollback(`git clone 失败（${p.key}）: ${clone.err}`);
      // clone 出来的 origin 指向临时 gitbundle 路径，删掉——它不是一个真实远端。
      git(repoAbs, ["remote", "remove", "origin"]);
      if (p.gitHead) {
        const head = git(repoAbs, ["rev-parse", "HEAD"]);
        if (head.ok && head.out !== p.gitHead) return rollback(`项目 ${p.key} 还原后 HEAD ${head.out.slice(0, 7)} 与导出时 ${p.gitHead.slice(0, 7)} 不一致`);
      }
    }

    // 5) config：每个项目 enabled=false——新机器上由操作者显式启用；写法与 project disable 一致
    const cfgPath = join(data, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { projects?: Record<string, WlProject> };
    let paused = 0;
    for (const key of Object.keys(cfg.projects ?? {})) { if (cfg.projects![key].enabled !== false) { cfg.projects![key].enabled = false; paused++; } }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    // 6) registry：用产品自己的注册流程，稳定 ID 沿用
    const reg = registerWorkspace(root, label ?? manifest.workspaceLabel ?? undefined);

    console.log(`writing-loop bundle: 已导入到 ${root}`);
    console.log(`  workspace ${reg.id}${reg.label ? `（${reg.label}）` : ""} · 来自 ${manifest.sourceHost} · 导出于 ${manifest.authoredAt}`);
    for (const p of manifest.projects) console.log(`  - ${p.key}${p.title ? `（${p.title}）` : ""} → ${resolve(root, p.repoPath)} head=${p.gitHead?.slice(0, 7) ?? "?"}`);
    if (manifest.sourceFiles.length) console.log(`  原著文件: ${manifest.sourceFiles.join(", ")}`);
    console.log(`  ${paused} 个项目已置为暂停态（不会自动开跑）`);
    console.log(`\n下一步（在 ${root} 内）:\n  writing-loop doctor\n  writing-loop project enable <key>\n  writing-loop run --project <key> --dry-run\n  writing-loop run --project <key>`);
    return 0;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------
export function bundleInspect(argv: string[]): number {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) return die("需要 bundle 文件路径");
  const asJson = argv.includes("--json");
  const r = spawnSync("tar", ["-xzOf", resolve(file), `${BUNDLE_DIR}/manifest.json`], { encoding: "utf8" });
  if (r.status !== 0) return die(`读不出 manifest: ${r.stderr}`);
  const m = JSON.parse(r.stdout) as BundleManifest;
  if (asJson) { console.log(JSON.stringify(m, null, 2)); return 0; }
  console.log(`writing-loop bundle ${basename(file)}`);
  console.log(`  schema ${m.bundleSchema} · writing-loop ${m.writingLoopVersion} · 导出于 ${m.authoredAt} @ ${m.sourceHost}`);
  console.log(`  workspace ${m.workspaceId}${m.workspaceLabel ? `（${m.workspaceLabel}）` : ""}`);
  console.log(`  ${m.projects.length} 个项目 · ${Object.keys(m.files).length} 个文件 · 内容 ${fmtBytes(m.totalBytes)}`);
  for (const p of m.projects) console.log(`  - ${p.key}${p.title ? `（${p.title}）` : ""} repo=${p.repoPath} head=${p.gitHead?.slice(0, 7) ?? "?"}`);
  if (m.sourceFiles.length) console.log(`  原著文件: ${m.sourceFiles.join(", ")}`);
  return 0;
}

// ---------------------------------------------------------------------------
const fmtBytes = (n: number): string => n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${n} B`;

export function bundleMain(argv = process.argv.slice(2)): number {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") { usage(); return sub ? 0 : 2; }
  if (sub === "export") return bundleExport(rest);
  if (sub === "import") return bundleImport(rest);
  if (sub === "inspect") return bundleInspect(rest);
  console.error(`writing-loop bundle: 未知子命令 '${sub}'`); usage(); return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(bundleMain());
}
