// workspace 单测：根发现（走查命中、env 优先、非法 env 硬错）、config 装载（行号报错）、
// 项目解析三优先级（flag > cwd 在 repoPath 内 > 恰一 enabled）与歧义报错。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findWorkspaceRoot, loadConfig, resolveProject, resolveRepoPath, WsError,
} from "../src/workspace.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const throwsWith = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (e) { return e instanceof WsError && e.message.includes(needle); }
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-ws-")));
const savedEnv = process.env.WRITING_LOOP_WORKSPACE;
delete process.env.WRITING_LOOP_WORKSPACE;

try {
  // ── fixture：A = 双项目 workspace；B = 单项目 workspace ──
  const A = join(tmp, "wsA");
  mkdirSync(join(A, ".writing-loop"), { recursive: true });
  mkdirSync(join(A, "repo1", "sub"), { recursive: true });
  mkdirSync(join(A, "repo2"), { recursive: true });
  writeFileSync(join(A, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: {
      p1: { title: "剧一", repoPath: "repo1", enabled: true },
      p2: { title: "剧二", repoPath: "repo2", enabled: true },
      p3: { title: "暂停剧", repoPath: "repo2", enabled: false },
    },
  }, null, 2));

  const B = join(tmp, "wsB");
  mkdirSync(join(B, ".writing-loop"), { recursive: true });
  mkdirSync(join(B, "solo"), { recursive: true });
  writeFileSync(join(B, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { solo: { title: "独苗", repoPath: "solo" } },
  }));

  // ── 根发现：走查 ──
  ok(findWorkspaceRoot(join(A, "repo1", "sub")) === A, "从 repo 深处向上走查命中 workspace 根");
  ok(findWorkspaceRoot(A) === A, "根目录自身命中");
  ok(findWorkspaceRoot(tmp) === null, "无 .writing-loop/ 的树返回 null（不是抛错）");

  // ── 根发现：env 优先 + 坏值硬错 ──
  process.env.WRITING_LOOP_WORKSPACE = B;
  ok(findWorkspaceRoot(join(A, "repo1")) === B, "WRITING_LOOP_WORKSPACE 优先于 cwd 走查");
  process.env.WRITING_LOOP_WORKSPACE = "relative/path";
  ok(throwsWith(() => findWorkspaceRoot(A), "绝对路径"), "相对路径 env 硬错（不降级走查）");
  process.env.WRITING_LOOP_WORKSPACE = join(tmp, "nowhere");
  ok(throwsWith(() => findWorkspaceRoot(A), ".writing-loop"), "env 指向无 .writing-loop/ 的目录硬错");
  delete process.env.WRITING_LOOP_WORKSPACE;

  // ── config 装载 ──
  const wsA = loadConfig(A);
  ok(Object.keys(wsA.config.projects ?? {}).length === 3, "loadConfig 读到 3 个项目");
  ok(resolveRepoPath(A, wsA.config.projects!.p1) === join(A, "repo1"), "相对 repoPath 按 workspace 根解析");
  const broken = join(tmp, "wsBroken");
  mkdirSync(join(broken, ".writing-loop"), { recursive: true });
  writeFileSync(join(broken, ".writing-loop", "config.json"), `{\n  "version": 1,\n  oops\n}`);
  ok(throwsWith(() => loadConfig(broken), "第 3 行"), "JSON 解析失败带行号（第 3 行）");
  const noCfg = join(tmp, "wsNoCfg");
  mkdirSync(join(noCfg, ".writing-loop"), { recursive: true });
  ok(throwsWith(() => loadConfig(noCfg), "add-script"), "config.json 缺失 → 指到 add-script 立项");

  // ── 项目解析：三优先级 ──
  const r1 = resolveProject(wsA, "p2", A);
  ok(r1.key === "p2" && r1.repoPath === join(A, "repo2"), "--project flag 最高优先");
  const r2 = resolveProject(wsA, null, join(A, "repo1", "sub"));
  ok(r2.key === "p1", "无 flag 时 CWD 在某 repoPath 内 ⇒ 该项目");
  const wsB = loadConfig(B);
  const r3 = resolveProject(wsB, null, tmp);
  ok(r3.key === "solo", "恰一个 enabled ⇒ 该项目（cwd 不在任何 repo 内也行）");
  ok(throwsWith(() => resolveProject(wsA, null, tmp), "--project"), "多 enabled 且 cwd 不定位 ⇒ 歧义报错要求 --project");
  ok(throwsWith(() => resolveProject(wsA, null, tmp), "p1"), "歧义报错列出候选 key");
  ok(throwsWith(() => resolveProject(wsA, "ghost", A), "现有"), "未知 key 报错并列出现有项目");
  ok(throwsWith(() => resolveProject(wsA, "p3", A), "enabled:false"), "enabled:false 项目按 flag 指名也拒绝");
  // p3 与 p2 同 repoPath 但 disabled——cwd 匹配只扫 enabled，p2 胜出
  ok(resolveProject(wsA, null, join(A, "repo2")).key === "p2", "cwd 匹配跳过 enabled:false 的项目");
} finally {
  if (savedEnv === undefined) delete process.env.WRITING_LOOP_WORKSPACE;
  else process.env.WRITING_LOOP_WORKSPACE = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nWORKSPACE_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
