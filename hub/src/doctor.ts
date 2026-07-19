// `writing-loop doctor` —— 只读体检：暖色警告（W 码）不失败、结构性问题才 FAIL。
// 末行恒为 WRITING_LOOP_DOCTOR_OK / WRITING_LOOP_DOCTOR_FAILED + 恰一条 NEXT: 行。
//
// W 码表（warn 恒不影响退出码；W01 已随 python 调度器退役——调度器现为包内原生 TS）：
//   W02 repoPath 不存在 / 不是 git repo
//   W03 创作规格违规（paywall.card1 ⊄ [8..12] / audience 空——config-schema 校验规则）
//   W04 scheduler.cli 对应二进制不在 PATH（claude/codex/opencode）
//   W05 cli=opencode 且版本 < 1.2.24（dev-loop PORTABILITY 认证下限）
//   W06 cli=claude 且 promptMode!=inline 但 Claude Code 未装 writing-loop 插件（斜杠命令无从解析）
//   W07 wl-run.lock 陈旧（mtime>60min——多半是崩溃残锁，wl-run 下次启动会自动回收）
//   W08 cli=claude 且 trimFirePlugins 生效但本机不满足前提（~/.claude/settings.json 的
//       enabledPlugins 读不到 / claude 无 --settings flag）——wl-run 会优雅降级不注入，仅提示
// FAIL（结构性）：workspace 不可解析、config.json 不可解析/非对象、板目录不可写。
import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findOnPath } from "./paths.ts";
import { buildTrimSettingsJson, claudeSupportsSettingsFlag, readEnabledPlugins } from "./scheduler.ts";
import {
  dataRoot, findWorkspaceRoot, loadConfig, projectDataDir, resolveRepoPath,
  WsError, type WlConfig, type WlProject, type Workspace,
} from "./workspace.ts";

const MIN_NODE = [20, 11] as const;
const MIN_OPENCODE = [1, 2, 24] as const; // dev-loop docs/PORTABILITY.md 认证下限

// ─── 小工具 ────────────────────────────────────────────────────────────────────
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const exists = (p: string): boolean => { try { statSync(p); return true; } catch { return false; } };

function schedStr(block: Record<string, unknown> | undefined, field: string): string | null {
  const v = block?.[field];
  return typeof v === "string" ? v : null;
}

function schedBool(block: Record<string, unknown> | undefined, field: string): boolean | null {
  const v = block?.[field];
  return typeof v === "boolean" ? v : null;
}

// 生效 scheduler 旋钮：项目块 > workspace 块 > 默认（cli=claude、promptMode=slash、
// trimFirePlugins=true——与 src/scheduler.ts buildSched 的合并方向一致；--cli flag 只影响
// run，不进 doctor）。
export function effectiveScheduler(cfg: WlConfig, project: WlProject): { cli: string; promptMode: string; trimFirePlugins: boolean } {
  const wsBlock = cfg.scheduler;
  const pjBlock = project.scheduler;
  return {
    cli: schedStr(pjBlock, "cli") ?? schedStr(wsBlock, "cli") ?? "claude",
    promptMode: schedStr(pjBlock, "promptMode") ?? schedStr(wsBlock, "promptMode") ?? "slash",
    trimFirePlugins: schedBool(pjBlock, "trimFirePlugins") ?? schedBool(wsBlock, "trimFirePlugins") ?? true,
  };
}

export function opencodeVersionOf(bin: string): [number, number, number] | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

const versionLt = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

// Claude Code 侧 writing-loop 插件是否已装：先读注册表 installed_plugins.json
//（v2：plugins 键形如 "<plugin>@<marketplace>"），读不到/换版式再目录探测兜底。
export function claudePluginInstalled(claudeHome = join(homedir(), ".claude")): boolean {
  const plugins = join(claudeHome, "plugins");
  try {
    const reg = JSON.parse(readFileSync(join(plugins, "installed_plugins.json"), "utf8")) as { plugins?: Record<string, unknown> };
    if (reg.plugins && Object.keys(reg.plugins).some((k) => k === "writing-loop" || k.startsWith("writing-loop@"))) return true;
  } catch { /* 注册表缺失/换版式 ⇒ 目录探测 */ }
  for (const sub of ["cache", "marketplaces"]) {
    try {
      if (readdirSync(join(plugins, sub)).some((n) => n === "writing-loop" || n === "writing-loop-npm")) return true;
    } catch { /* 目录不在 ⇒ 继续 */ }
  }
  return false;
}

function usage(): void {
  console.log(`writing-loop doctor — 只读体检（暖色警告不失败、结构性问题才 FAIL）
用法: writing-loop doctor`);
}

// ─── 主体 ──────────────────────────────────────────────────────────────────────
export function doctorMain(argv = process.argv.slice(2)): number {
  if (argv[0] === "--help" || argv[0] === "-h") { usage(); return 0; }
  if (argv.length) { console.error(`writing-loop doctor: 未知参数 '${argv[0]}'`); usage(); return 2; }

  let failed = false;
  let next: string | null = null; // 首个（最高优先）NEXT 建议胜出
  const ok = (m: string): void => { console.log(`ok  : ${m}`); };
  const warn = (code: string | null, m: string, suggest?: string): void => {
    console.log(`WARN${code ? ` ${code}` : ""}: ${m}`);
    if (suggest) next ??= suggest;
  };
  const fail = (m: string, suggest?: string): void => {
    console.log(`FAIL: ${m}`);
    failed = true;
    if (suggest) next ??= suggest;
  };

  console.log("writing-loop doctor — 只读体检\n");

  // 1. node 版本（发布包 engines >=20.11；老 node 多半仍能跑大半命令 ⇒ 只 warn）
  const [nMaj, nMin] = process.versions.node.split(".").map(Number);
  if (nMaj > MIN_NODE[0] || (nMaj === MIN_NODE[0] && nMin >= MIN_NODE[1])) {
    ok(`node v${process.versions.node}（engines >=${MIN_NODE.join(".")}）`);
  } else {
    warn(null, `node v${process.versions.node} 低于 engines >=${MIN_NODE.join(".")} —— 建议升级`);
  }

  // 2. workspace 可解析（调度器 wl-run 已是包内原生 TS——不再有解释器前置条件）
  let root: string | null = null;
  try {
    root = findWorkspaceRoot();
  } catch (e) {
    fail(e instanceof WsError ? e.message : String(e), "修正或 unset WRITING_LOOP_WORKSPACE");
  }
  if (root === null && !failed) {
    fail("未在 workspace 内（从 CWD 向上找不到 .writing-loop/，也无 WRITING_LOOP_WORKSPACE）",
      "writing-loop init 铺骨架（或在 Claude Code 里跑 /writing-loop:add-script 立项）");
  }

  // 3. config.json 可解析 + 项目轻校验
  let ws: Workspace | null = null;
  if (root) {
    ok(`workspace: ${root}（状态目录 ${dataRoot(root)}）`);
    try {
      ws = loadConfig(root);
    } catch (e) {
      fail(e instanceof WsError ? e.message : String(e), "修复 .writing-loop/config.json（见上方行号）");
    }
  }

  if (ws) {
    const projects = Object.entries(ws.config.projects ?? {});
    const enabled = projects.filter(([, p]) => p.enabled !== false);
    ok(`config.json 可解析（项目 ${projects.length} 个，enabled ${enabled.length} 个）`);
    if (!projects.length) next ??= "在 Claude Code 里跑 /writing-loop:add-script 立项 interview";

    for (const [key, p] of enabled) {
      console.log(`\n—— 项目 ${key} ——`);
      const repo = resolveRepoPath(ws.root, p);

      // repoPath 存在且是 git repo（.git 目录或 worktree 的 .git 文件）
      if (!isDir(repo)) warn("W02", `repoPath 不存在：${repo}`);
      else if (!exists(join(repo, ".git"))) warn("W02", `repoPath 不是 git repo（无 .git）：${repo}`);
      else ok(`repoPath 存在且是 git repo: ${repo}`);

      // 创作规格轻校验（config-schema「校验规则」）：paywall.card1 ⊂ [8..12]、audience 非空
      const card1 = p.paywall?.card1;
      if (card1 !== undefined) {
        const okCard = Array.isArray(card1) && card1.length > 0 && card1.every((x) => Number.isInteger(x) && x >= 8 && x <= 12);
        if (okCard) ok(`paywall.card1 ⊂ [8..12]: [${(card1 as number[]).join(", ")}]`);
        else warn("W03", `paywall.card1 越界（须为 [8..12] 内的非空整数数组，得到 ${JSON.stringify(card1)}）`);
      } else {
        warn("W03", "paywall.card1 缺失（备卡制 R4.5 的参数来源）");
      }
      if (typeof p.audience === "string" && p.audience.trim()) ok(`audience 非空: ${p.audience}`);
      else warn("W03", "audience 为空 —— 评估红线①（受众画像含性别+年龄）的入口预防");

      // 板目录存在可写（缺 = 还没铺板，warn；存在但不可写 = 结构性 FAIL）
      const board = join(projectDataDir(ws.root, key), "board", "tickets");
      if (!isDir(board)) {
        warn(null, `板目录尚未创建：${board}（add-script 立项或首 fire 会铺）`);
      } else {
        try {
          accessSync(board, constants.W_OK);
          ok(`板目录存在可写: ${board}`);
        } catch {
          fail(`板目录不可写：${board}`, `检查目录权限：${board}`);
        }
      }

      // scheduler.cli 二进制在 PATH + 引擎特定检查
      const { cli, promptMode, trimFirePlugins } = effectiveScheduler(ws.config, p);
      const bin = findOnPath(cli);
      if (!bin) {
        warn("W04", `scheduler.cli=${cli} 不在 PATH —— wl-run 起 fire 会失败`, `安装 ${cli}（或改 config 的 scheduler.cli）`);
      } else {
        ok(`scheduler.cli=${cli} 在 PATH: ${bin}（promptMode=${promptMode}）`);
        if (cli === "opencode") {
          const v = opencodeVersionOf(bin);
          if (!v) warn(null, "无法解析 opencode --version 输出 —— 请自查 >= 1.2.24（认证下限）");
          else if (versionLt(v, MIN_OPENCODE)) warn("W05", `opencode ${v.join(".")} < ${MIN_OPENCODE.join(".")}（认证下限）—— 请升级`);
          else ok(`opencode ${v.join(".")} >= ${MIN_OPENCODE.join(".")}（认证下限）`);
        }
      }
      if (cli === "claude" && promptMode !== "inline") {
        if (claudePluginInstalled()) ok("Claude Code 已装 writing-loop 插件（slash prompt 可解析）");
        else warn("W06",
          "cli=claude 且 promptMode!=inline，但 ~/.claude/plugins 未检出 writing-loop 插件 —— 斜杠命令 fire 会空转",
          `writing-loop install-claude-plugin 注册后在 Claude Code 里 /plugin install（或 config 设 scheduler.promptMode="inline"）`);
      }

      // fire 减肥（trimFirePlugins，0.6.0）——wl-run resolveTrimPlugins 同一降级链的预检：
      // 任一前提不满足 ⇒ wl-run 优雅降级不注入 --settings（fire 照旧起），doctor 只提示。
      if (cli === "claude") {
        if (!trimFirePlugins) {
          ok("fire 减肥：trimFirePlugins=false（config 显式关闭）—— fire 不注入 --settings");
        } else {
          const plugins = readEnabledPlugins();
          if (!plugins) {
            warn("W08", "fire 减肥：读不到 ~/.claude/settings.json 的 enabledPlugins —— 无插件清单可裁，wl-run 将不注入 --settings");
          } else if (bin && !claudeSupportsSettingsFlag(bin)) {
            warn("W08", "fire 减肥：本机 claude 不支持 --settings —— wl-run 将优雅降级不加 flag",
              "升级 Claude Code 以恢复 fire 减肥（--settings 注入）");
          } else if (bin) {
            const { disabledCount } = buildTrimSettingsJson(plugins);
            ok(`fire 减肥就绪：每 fire --settings 仅启 writing-loop 插件（其余 ${disabledCount} 个置 false）`);
          }
          // bin 缺失时 W04 已警告——无从探测 --settings，不重复告警
        }
      }

      // wl-run.lock 陈旧（>60min = 崩溃残锁的典型形状；在位且新鲜 = 调度器在跑，是 ok）
      const lock = join(projectDataDir(ws.root, key), "wl-run.lock");
      try {
        const age = Math.round((Date.now() - statSync(lock).mtimeMs) / 60000);
        if (age > 60) warn("W07", `wl-run.lock 陈旧（age ${age}min > 60min）—— 多半是崩溃残锁；wl-run 下次启动自动回收`);
        else ok(`wl-run.lock 在位且新鲜（age ${age}min）—— 调度器可能正在运行`);
      } catch { /* 无锁 = 未在跑，正常，不打行 */ }
    }
  }

  console.log("");
  console.log(failed ? "WRITING_LOOP_DOCTOR_FAILED" : "WRITING_LOOP_DOCTOR_OK");
  console.log(`NEXT: ${next ?? "writing-loop run --dry-run 预演各 agent 命令，再 writing-loop run 起团队"}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(doctorMain());
}
