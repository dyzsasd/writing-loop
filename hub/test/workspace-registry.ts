// Stable identity / non-authoritative registry regression suite.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMain } from "../src/init.ts";
import {
  ensureWorkspaceIdentity, inspectWorkspaceRegistry, readWorkspaceIdentity, registerWorkspace,
  removeWorkspaceRegistration, resolveRegisteredWorkspace, writingLoopHome, WORKSPACE_ID_PATTERN,
  MAX_IDENTITY_BYTES, MAX_REGISTRY_BYTES,
} from "../src/workspace-registry.ts";
import { workspaceRegistryMain } from "../src/workspace-registry-cli.ts";
import { WsError } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsWith = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof WsError && error.message.includes(needle); }
};
const makeWorkspace = (parent: string, name: string): string => {
  const root = join(parent, name);
  mkdirSync(join(root, ".writing-loop"), { recursive: true });
  writeFileSync(join(root, ".writing-loop", "config.json"), '{"version":1,"projects":{}}\n');
  return root;
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-registry-")));
const savedHome = process.env.WRITING_LOOP_HOME;
const savedWorkspace = process.env.WRITING_LOOP_WORKSPACE;

try {
  const home = join(tmp, "home");
  process.env.WRITING_LOOP_HOME = home;

  // Identity is opaque, stable, strict and created exactly once.
  const alpha = makeWorkspace(tmp, "alpha");
  const alphaIdentity = ensureWorkspaceIdentity(alpha);
  ok(WORKSPACE_ID_PATTERN.test(alphaIdentity.id), "identity 创建 opaque ws_<32 hex> ID");
  ok(ensureWorkspaceIdentity(alpha).id === alphaIdentity.id, "identity 创建幂等且不轮换 ID");
  ok(readWorkspaceIdentity(alpha).id === alphaIdentity.id, "bounded identity reader 读回稳定 ID");

  const first = registerWorkspace(alpha, "Alpha room");
  ok(first.id === alphaIdentity.id && first.root === alpha, "register 写入 ID → canonical root 指针");
  const alias = join(tmp, "alpha-alias");
  symlinkSync(alpha, alias, "dir");
  const aliased = registerWorkspace(alias);
  ok(aliased.root === alpha && inspectWorkspaceRegistry().entries.length === 1,
    "canonical symlink alias 去重且保留原 label");
  ok(resolveRegisteredWorkspace(alphaIdentity.id).root === alpha, "显式 ID 解析返回健康 registry entry");

  // Copying identity produces a hard conflict while both roots exist.
  const clone = makeWorkspace(tmp, "alpha-copy");
  copyFileSync(join(alpha, ".writing-loop", "workspace.json"), join(clone, ".writing-loop", "workspace.json"));
  ok(throwsWith(() => registerWorkspace(clone), "duplicate workspace identity"),
    "复制后的两个现存 root 同 ID 时注册硬错");
  ok(inspectWorkspaceRegistry().entries.length === 1, "duplicate identity 失败不污染 registry");
  const duplicateStudio = spawnSync(process.execPath, [new URL("../src/studio.ts", import.meta.url).pathname, "--port", "8791"], {
    cwd: clone,
    encoding: "utf8",
    timeout: 3_000,
    env: { ...process.env, WRITING_LOOP_HOME: home, WRITING_LOOP_WORKSPACE: clone },
  });
  ok(duplicateStudio.status === 2 && `${duplicateStudio.stdout}${duplicateStudio.stderr}`.includes("duplicate workspace identity"),
    "Studio 启动不会吞掉复制 identity 冲突并把同一 /w/:id 路由到错误 root");

  // Moving a root preserves identity and self-heals the stale pointer when the old path vanished.
  const movable = makeWorkspace(tmp, "movable");
  const movableRegistered = registerWorkspace(movable, "Moving room");
  const moved = join(tmp, "moved");
  renameSync(movable, moved);
  const healed = registerWorkspace(moved);
  ok(healed.id === movableRegistered.id && healed.root === moved && healed.label === "Moving room",
    "旧 root 消失后按稳定 ID 移动自愈并保留 label");
  ok(inspectWorkspaceRegistry().entries.some((entry) => entry.id === healed.id && entry.root === moved),
    "registry 不残留 moved workspace 的旧 root");

  // One missing/corrupt entry must not hide healthy peers.
  const missing = makeWorkspace(tmp, "will-go-missing");
  const missingId = registerWorkspace(missing).id;
  rmSync(missing, { recursive: true });
  const corrupt = makeWorkspace(tmp, "corrupt-identity");
  const corruptId = registerWorkspace(corrupt).id;
  writeFileSync(join(corrupt, ".writing-loop", "workspace.json"), "{bad json\n");
  const isolated = inspectWorkspaceRegistry();
  ok(isolated.degraded && isolated.entries.find((entry) => entry.id === alphaIdentity.id)?.status === "ok",
    "degraded registry 仍返回健康 entry");
  ok(isolated.entries.find((entry) => entry.id === missingId)?.status === "missing",
    "缺失 root 单项标为 missing");
  ok(isolated.entries.find((entry) => entry.id === corruptId)?.status === "corrupt",
    "损坏 identity 单项标为 corrupt");

  // Independent O_EXCL lock: another writer's bytes and registry remain untouched.
  const lockFile = join(home, "workspaces.json.lock");
  writeFileSync(lockFile, "other writer\n");
  const beforeLocked = readFileSync(join(home, "workspaces.json"), "utf8");
  ok(throwsWith(() => registerWorkspace(alpha), "另一进程"), "registry 并发 O_EXCL lock 硬错");
  ok(readFileSync(lockFile, "utf8") === "other writer\n"
    && readFileSync(join(home, "workspaces.json"), "utf8") === beforeLocked,
  "并发失败不截断别人的 lock 且不覆盖 registry");
  rmSync(lockFile);

  registerWorkspace(alpha, undefined, { afterLock(file) {
    unlinkSync(file);
    writeFileSync(file, "replacement lock\n");
  } });
  ok(readFileSync(lockFile, "utf8") === "replacement lock\n",
    "registry release 按 inode 校验，不删除路径上的 replacement lock");
  rmSync(lockFile);

  const identityLocked = makeWorkspace(tmp, "identity-locked");
  const identityLockFile = join(identityLocked, ".writing-loop", "workspace.json.lock");
  writeFileSync(identityLockFile, "other identity writer\n");
  ok(throwsWith(() => ensureWorkspaceIdentity(identityLocked), "另一进程"), "identity 创建也拒绝并发写者");
  ok(readFileSync(identityLockFile, "utf8") === "other identity writer\n", "identity lock victim 不被删除");

  // Strict unknown-field policy is diagnostic; writers never silently overwrite corrupt/new schema.
  const registryFile = join(home, "workspaces.json");
  const strictFixture = readFileSync(registryFile, "utf8").replace('"workspaces":', '"future": true,\n  "workspaces":');
  writeFileSync(registryFile, strictFixture);
  const strictSnapshot = inspectWorkspaceRegistry();
  ok(strictSnapshot.registryStatus === "corrupt" && strictSnapshot.diagnostics.some((d) => d.includes("不支持字段")),
    "registry 未知字段按严格 v1 schema 明确诊断");
  ok(throwsWith(() => registerWorkspace(alpha), "不支持字段"), "写入不能静默覆盖未知 schema");
  ok(readFileSync(registryFile, "utf8") === strictFixture, "拒绝写入时损坏/未来 registry 字节不变");

  const oversizedIdentity = makeWorkspace(tmp, "oversized-identity");
  writeFileSync(join(oversizedIdentity, ".writing-loop", "workspace.json"), "x".repeat(MAX_IDENTITY_BYTES + 1));
  ok(throwsWith(() => readWorkspaceIdentity(oversizedIdentity), "读取上限"), "identity 读取严格受 byte budget 限制");

  const oversizedHome = join(tmp, "home-oversized");
  mkdirSync(oversizedHome);
  writeFileSync(join(oversizedHome, "workspaces.json"), "x".repeat(MAX_REGISTRY_BYTES + 1));
  process.env.WRITING_LOOP_HOME = oversizedHome;
  const oversizedRegistry = inspectWorkspaceRegistry();
  ok(oversizedRegistry.registryStatus === "corrupt" && oversizedRegistry.diagnostics.some((d) => d.includes("读取上限")),
    "registry 读取严格受 byte budget 限制");

  const crowdedHome = join(tmp, "home-crowded");
  mkdirSync(crowdedHome);
  writeFileSync(join(crowdedHome, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: Array.from({ length: 129 }, (_, index) => ({
      id: `ws_${index.toString(16).padStart(32, "0")}`,
      root: join(tmp, `crowded-${index}`),
    })),
  }));
  process.env.WRITING_LOOP_HOME = crowdedHome;
  ok(inspectWorkspaceRegistry().diagnostics.some((d) => d.includes("超过 128 条")), "registry 拒绝超过 128 条的索引");

  // Registry special-file targets never touch their victims and FIFO is rejected without blocking.
  for (const kind of ["symlink", "hardlink", "fifo"] as const) {
    const attackHome = join(tmp, `home-${kind}`);
    mkdirSync(attackHome);
    process.env.WRITING_LOOP_HOME = attackHome;
    const attackRegistry = join(attackHome, "workspaces.json");
    const victim = join(tmp, `registry-${kind}-victim.txt`);
    writeFileSync(victim, "DO NOT TOUCH\n");
    if (kind === "symlink") symlinkSync(victim, attackRegistry);
    else if (kind === "hardlink") linkSync(victim, attackRegistry);
    else execFileSync("mkfifo", [attackRegistry]);
    const started = Date.now();
    ok(throwsWith(() => registerWorkspace(alpha), "单链接普通文件"), `registry ${kind} target 被拒绝`);
    ok(readFileSync(victim, "utf8") === "DO NOT TOUCH\n", `registry ${kind} victim 内容不变`);
    if (kind === "fifo") ok(Date.now() - started < 500, "registry FIFO 在 open 前有界拒绝，不阻塞");
  }

  // Identity special-file targets likewise fail closed without touching the victim.
  for (const kind of ["symlink", "hardlink", "fifo"] as const) {
    const workspace = makeWorkspace(tmp, `identity-${kind}`);
    const identityFile = join(workspace, ".writing-loop", "workspace.json");
    const victim = join(tmp, `identity-${kind}-victim.txt`);
    writeFileSync(victim, "IDENTITY VICTIM\n");
    if (kind === "symlink") symlinkSync(victim, identityFile);
    else if (kind === "hardlink") linkSync(victim, identityFile);
    else execFileSync("mkfifo", [identityFile]);
    const started = Date.now();
    ok(throwsWith(() => ensureWorkspaceIdentity(workspace), "单链接普通文件"), `identity ${kind} target 被拒绝`);
    ok(readFileSync(victim, "utf8") === "IDENTITY VICTIM\n", `identity ${kind} victim 内容不变`);
    if (kind === "fifo") ok(Date.now() - started < 500, "identity FIFO 有界拒绝，不阻塞");
  }

  // Home validation includes relative paths, files and final-path symlinks.
  process.env.WRITING_LOOP_HOME = "relative/home";
  ok(throwsWith(() => registerWorkspace(alpha), "必须是绝对路径"), "相对 WRITING_LOOP_HOME 硬错");
  const badHome = join(tmp, "home-is-file");
  writeFileSync(badHome, "not a directory\n");
  process.env.WRITING_LOOP_HOME = badHome;
  ok(throwsWith(() => registerWorkspace(alpha), "无法创建"), "WRITING_LOOP_HOME 指向文件时硬错");
  const homeTarget = join(tmp, "home-target");
  mkdirSync(homeTarget);
  const linkedHome = join(tmp, "home-link");
  symlinkSync(homeTarget, linkedHome, "dir");
  process.env.WRITING_LOOP_HOME = linkedHome;
  ok(throwsWith(() => registerWorkspace(alpha), "symlink"), "WRITING_LOOP_HOME final symlink 被拒绝");
  ok(inspectWorkspaceRegistry().registryStatus === "corrupt", "只读 registry 也诊断 symlink home 为 corrupt");
  const ancestorTarget = join(tmp, "ancestor-target");
  mkdirSync(ancestorTarget);
  const ancestorLink = join(tmp, "ancestor-link");
  symlinkSync(ancestorTarget, ancestorLink, "dir");
  process.env.WRITING_LOOP_HOME = join(ancestorLink, "nested-home");
  ok(throwsWith(() => registerWorkspace(alpha), "路径含 symlink"), "WRITING_LOOP_HOME ancestor symlink 被拒绝");
  delete process.env.WRITING_LOOP_HOME;
  ok(writingLoopHome().endsWith(".writing-loop"), "未设置 WRITING_LOOP_HOME 时默认 ~/.writing-loop");

  // Corrupt top-level registry remains diagnosable and write-protected.
  const corruptHome = join(tmp, "home-corrupt");
  mkdirSync(corruptHome);
  process.env.WRITING_LOOP_HOME = corruptHome;
  writeFileSync(join(corruptHome, "workspaces.json"), "{ definitely broken\n");
  const corruptRegistry = inspectWorkspaceRegistry();
  ok(corruptRegistry.registryStatus === "corrupt" && corruptRegistry.degraded,
    "损坏 registry 读取返回可诊断 degraded snapshot");
  const corruptBytes = readFileSync(join(corruptHome, "workspaces.json"), "utf8");
  ok(throwsWith(() => registerWorkspace(alpha), "损坏"), "损坏 registry 阻止写入");
  ok(readFileSync(join(corruptHome, "workspaces.json"), "utf8") === corruptBytes,
    "写路径绝不静默覆盖损坏 registry");
  const corruptCli = spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "workspace", "list"],
    { encoding: "utf8", env: { ...process.env, WRITING_LOOP_HOME: corruptHome } });
  ok(corruptCli.status === 0 && corruptCli.stdout.includes("registry: corrupt (degraded)")
    && corruptCli.stdout.includes("diagnostic:"), "human CLI 清楚输出 corrupt/degraded 与诊断");

  // CLI add/list/remove uses ID selection; remove leaves root + stable identity intact.
  const cliHome = join(tmp, "home-cli");
  const cliWorkspace = makeWorkspace(tmp, "cli-workspace");
  process.env.WRITING_LOOP_HOME = cliHome;
  const cliFile = new URL("../src/cli.ts", import.meta.url);
  const cliEnv = { ...process.env, WRITING_LOOP_HOME: cliHome };
  const cliAdd = spawnSync(process.execPath, [cliFile.pathname, "workspace", "add", cliWorkspace, "--label", "CLI room"],
    { encoding: "utf8", env: cliEnv });
  const cliId = /registered (ws_[a-f0-9]{32})/.exec(cliAdd.stdout)?.[1];
  ok(cliAdd.status === 0 && cliId !== undefined, "writing-loop workspace add CLI route 注册并输出 ID");
  const cliList = spawnSync(process.execPath, [cliFile.pathname, "workspace", "list", "--json"],
    { encoding: "utf8", env: cliEnv });
  const listed = JSON.parse(cliList.stdout) as { entries?: Array<{ id?: string; label?: string; status?: string }> };
  ok(cliList.status === 0 && listed.entries?.some((entry) => entry.id === cliId && entry.label === "CLI room" && entry.status === "ok") === true,
    "writing-loop workspace list --json 输出健康状态与 label");
  const pathRemove = spawnSync(process.execPath, [cliFile.pathname, "workspace", "remove", cliWorkspace],
    { encoding: "utf8", env: cliEnv });
  ok(pathRemove.status === 2 && existsSync(cliWorkspace), "workspace remove 只接受 ID，拒绝 root path 选择");
  const cliRemove = spawnSync(process.execPath, [cliFile.pathname, "workspace", "remove", cliId ?? "bad"],
    { encoding: "utf8", env: cliEnv });
  ok(cliRemove.status === 0 && existsSync(cliWorkspace)
    && existsSync(join(cliWorkspace, ".writing-loop", "workspace.json")),
  "workspace remove CLI 只删指针，不删目录或稳定 identity");
  ok(inspectWorkspaceRegistry().entries.length === 0, "CLI remove 后本机 pointer 已删除");

  // Direct CLI entry also reports missing registry clearly.
  const emptyHome = join(tmp, "home-empty");
  process.env.WRITING_LOOP_HOME = emptyHome;
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]): void => { logs.push(args.map(String).join(" ")); };
  let listCode = -1;
  try { listCode = workspaceRegistryMain(["list"]); }
  finally { console.log = oldLog; }
  ok(listCode === 0 && logs.some((line) => line.includes("registry: missing")), "human CLI 清楚输出 missing registry");

  // init best-effort registration is hermetic under WRITING_LOOP_HOME.
  const initHome = join(tmp, "home-init");
  const initWorkspace = join(tmp, "init-workspace");
  process.env.WRITING_LOOP_HOME = initHome;
  const initLogs: string[] = [];
  console.log = (...args: unknown[]): void => { initLogs.push(args.map(String).join(" ")); };
  let initCode = -1;
  try { initCode = initMain(["--dir", initWorkspace]); }
  finally { console.log = oldLog; }
  const initSnapshot = inspectWorkspaceRegistry();
  ok(initCode === 0 && initSnapshot.entries.length === 1 && initSnapshot.entries[0].root === initWorkspace,
    "init 成功后 best-effort 注册到隔离 WRITING_LOOP_HOME");
  ok(initLogs.some((line) => line.includes("workspace ID:")), "init 输出已注册的稳定 ID");

  const degradedInitHome = join(tmp, "home-init-corrupt");
  mkdirSync(degradedInitHome);
  writeFileSync(join(degradedInitHome, "workspaces.json"), "{ broken\n");
  const degradedInitWorkspace = join(tmp, "init-degraded");
  process.env.WRITING_LOOP_HOME = degradedInitHome;
  const degradedLogs: string[] = [];
  console.log = (...args: unknown[]): void => { degradedLogs.push(args.map(String).join(" ")); };
  let degradedInitCode = -1;
  try { degradedInitCode = initMain(["--dir", degradedInitWorkspace]); }
  finally { console.log = oldLog; }
  ok(degradedInitCode === 0 && existsSync(join(degradedInitWorkspace, ".writing-loop", "config.json")),
    "registry 损坏时 init 仍 best-effort 成功");
  ok(degradedLogs.some((line) => line.includes("索引注册失败（init 已成功）")), "init 清楚输出 registry degraded 警告");

  // Public remove API has identical pointer-only semantics and is idempotently false when absent.
  process.env.WRITING_LOOP_HOME = initHome;
  const initId = initSnapshot.entries[0].id;
  ok(removeWorkspaceRegistration(initId), "remove API 删除现存 pointer");
  ok(!removeWorkspaceRegistration(initId) && existsSync(initWorkspace), "remove API 缺失返回 false 且 workspace 仍存在");
} finally {
  if (savedHome === undefined) delete process.env.WRITING_LOOP_HOME;
  else process.env.WRITING_LOOP_HOME = savedHome;
  if (savedWorkspace === undefined) delete process.env.WRITING_LOOP_WORKSPACE;
  else process.env.WRITING_LOOP_WORKSPACE = savedWorkspace;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nWORKSPACE_REGISTRY_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
