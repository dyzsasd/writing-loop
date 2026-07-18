// writing-loop 内建调度器（wl-run）—— 单进程驱动一个项目的全部 agent 循环。
// 0.4.0 的 scripts/wl-run.py（python）一比一移植为原生 TS：语义逐条保真（生产在用），
// 并入三引擎车道（claude/codex/opencode）、promptMode（slash|inline）与 --cli 顶层覆盖。
//
// 核心裁决（WL-55）：conventions §15.6「同一时刻至多一个 fire 在写 repo」由本调度器
// **以构造保证**——写 repo 四角色（showrunner / story-designer / episode-writer /
// evaluator，§15.6 逐字列举的 stage+commit 主体）全局单飞（at most ONE in flight）；
// 板上角色（reviewer / sweep / script-doctor / market-watch / reflect，绝不向剧本 repo
// 落 commit）可与写者并发、彼此至多 2 路。于是共享 checkout + repo.lock 的默认轨道
// 恒为合规，不必 worktree。
//
// 其他职责（逐条同 0.4.0）：
// - keystone 升档：起 reviewer fire 前 glob 板 frontmatter，∃ In Review + keystone 票
//   ⇒ 本 fire 用 scheduler.keystoneReviewer 档（默认 opus/max）。launcher 只 advisory
//   选档——floor 判定仍由 reviewer agent 自己按 conventions 做（§0/§18 单一真相源不变）。
// - 遥测：每 fire 追加一行 JSON 到 <workspace>/.writing-loop/<key>/fires.jsonl
//   {agent, model, effort, startedAt, endedAt, durationSeconds, exitCode, timedOut,
//   noop, keystoneEscalated}（字段名与 0.4.0 完全一致）。时间戳一律取本进程自己的
//   UTC 时钟——agent 的自述时间不可信，墙钟谓词（§7 陈旧、§9 24h 重提醒类）以此为准。
// - 防重跑：项目级 `wl-run.lock`（scripts/board-lock.sh choreography：O_EXCL 独占创建、
//   >60min 陈旧强清；无 bash 时按同一散文语义 inline 执行）。运行中每 30s touch 心跳
//   ⇒ 活进程永不因陈旧被抢；崩溃残锁 60min 后自动回收。
// - 节律：interval = 上一 fire **结束**到下一 fire 开始的间隔（非固定频率）；每 fire
//   capSeconds 墙钟上限，超时 TERM→KILL 并记账；首 fire staggerSeconds 错峰。
//
// 配置：workspace config.json 顶层 `scheduler` 块 + `projects.<key>.scheduler` 覆盖
// （schema 见 references/config-schema.md）。要点：
// - cli："claude"（默认）| "codex" | "opencode"；顶层 flag --cli 再覆盖一层
//   （优先级：--cli > 项目 scheduler.cli > workspace scheduler.cli > 默认 "claude"）。
// - promptMode："slash"（默认，斜杠命令 prompt —— claude/codex 与 0.4.0 逐字节一致）|
//   "inline"（读 skills/<agent>-agent/SKILL.md、剥 YAML frontmatter、${CLAUDE_PLUGIN_ROOT}
//   替换为插件根绝对路径、前置调度器上下文头后整段内联）。opencode 无插件/斜杠命令机制
//   ⇒ 无视此旋钮恒 inline。
// - opencodePermission：cli=opencode 时注入 spawn env 的 OPENCODE_PERMISSION 整对象覆盖
//   （缺省用内建 wildcard-deny 基线 OPENCODE_PERMISSION_DEFAULT；不做 deep-merge）。
// 零依赖：node:* 内建 API only。自测：hub/test/scheduler*.ts（npm test）。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync,
  statSync, unlinkSync, utimesSync, writeFileSync, writeSync, existsSync, readFileSync,
} from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { pluginRoot } from "./paths.ts";
import {
  dataRoot as dataRootOf, findWorkspaceRoot, loadConfig, resolveProject, WsError,
  type WlConfig, type WlProject,
} from "./workspace.ts";

// ---------------------------------------------------------------------------
// 默认表 —— 与 0.4.0 SPECS 表逐格一致（agent|model|effort|interval|cap|stagger）
// ---------------------------------------------------------------------------
export const AGENT_SPECS: ReadonlyArray<readonly [string, string, string, number, number, number]> = [
  //  agent            model     effort   interval  cap   stagger
  ["showrunner",     "opus",   "max",     180,  3600,  0],
  ["story-designer", "opus",   "max",     240,  3600, 10],
  ["episode-writer", "sonnet", "high",    300,  2400, 20],
  ["reviewer",       "opus",   "max",     240,  2400, 30],
  ["evaluator",      "opus",   "xhigh",   240,  2400, 40],
  ["sweep",          "sonnet", "high",    600,  1200, 50],
  ["script-doctor",  "opus",   "xhigh",  1800,  2400, 60],
  ["market-watch",   "sonnet", "high",   3600,  1200, 70],
  ["reflect",        "opus",   "xhigh",  3600,  2400, 80],
];
export const AGENT_ORDER: readonly string[] = AGENT_SPECS.map((s) => s[0]);

// 写者/板上分类 —— 依据 conventions §15.6 逐字列举的 repo commit 主体；
// reviewer 的 §15.4 revert 是写进跟进票 AC 由 writer 层执行的，reviewer 本体不 commit。
export const REPO_WRITERS: ReadonlySet<string> = new Set(["showrunner", "story-designer", "episode-writer", "evaluator"]);
export const BOARD_ONLY_MAX = 2;    // 板上角色彼此的并发上限
const GRACE_DEFAULT = 30;           // Ctrl-C / --for 到点后等 in-flight 收尾的宽限秒数
export const KEYSTONE_DEFAULT = { model: "opus", effort: "max" } as const;
const HEARTBEAT_S = 30;             // 锁心跳 touch 周期
const TICK_MS = 200;                // 主循环轮询周期（0.4.0 的 TICK_S=0.2）

// cli:"codex" 时把配置里的 Claude 档位名映射为 Codex 名（conventions 拓扑一览映射表）；
// 不在表内的值原样透传（操作者已直接写 Codex 名）。
export const CODEX_MODEL_MAP: Readonly<Record<string, string>> = { opus: "gpt-5.5", sonnet: "gpt-5.5" };
export const CODEX_EFFORT_MAP: Readonly<Record<string, string>> = { max: "xhigh", xhigh: "xhigh", high: "high", medium: "medium", low: "low" };

// cli:"opencode" fire 的权限基线（dev-loop docs/PORTABILITY.md §5 认证集 + 三处放行）：
// wildcard-deny 关掉调度器不认识的一切 exec 工具（dev-loop 认证时的 tmux 侧门发现——
// 操作者全局扩展的自定义 exec 工具会逃出窄 pattern 且丢 fire env）。相对 dev-loop
// 认证集的三处放行及理由：
// - external_directory：板目录是 repo 外的兄弟目录（conventions §11），等价 claude
//   车道的 --add-dir；
// - webfetch / websearch：market-watch 周频扫榜需要出网。
// 其余逐字沿用 dev-loop 认证集。可被 config scheduler.opencodePermission 整对象覆盖
// （不做 deep-merge）。
export const OPENCODE_PERMISSION_DEFAULT: Readonly<Record<string, string>> = {
  "*": "deny", read: "allow", edit: "allow", glob: "allow", grep: "allow",
  bash: "allow", task: "allow", skill: "allow", lsp: "allow",
  external_directory: "allow", webfetch: "allow", websearch: "allow",
  question: "deny", doom_loop: "deny",
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export function utcIso(): string {
  return new Date().toISOString(); // 毫秒精度 + Z —— 与 0.4.0 的 isoformat(milliseconds) 同形
}

const mono = (): number => performance.now() / 1000; // 单调秒（fire 时长/排程判定不受挂钟回拨影响）

// die：正常控制流的硬错误（config 违规、锁被占等）。抛 WlExit 由 schedulerMain 统一
// 落 stderr + 退出码——不用 process.exit，避免 pipe 上未刷完的输出被截断。
// （注：全文件不用 TS 参数属性糖——node 的 strip-only type-stripping 不支持它。）
export class WlExit extends Error {
  readonly code: number;
  constructor(code: number, msg: string) { super(msg); this.name = "WlExit"; this.code = code; }
}
function die(msg: string, code = 1): never { throw new WlExit(code, msg); }

function readHead(path: string, n: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got).toString("utf8"); // 非法序列成替换符——等价 errors="replace"
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------
// scheduler 配置合并（低→高：SPECS 默认 < workspace scheduler < 项目 models/efforts
// 档位映射 < 项目 scheduler —— config-schema 写明的链，逐级保真）
// ---------------------------------------------------------------------------
export type AgentBlock = {
  model: string; effort: string; intervalSeconds: number; capSeconds: number;
  enabled: boolean; staggerSeconds: number; command: string[] | null;
};
export type Sched = {
  cli: "claude" | "codex" | "opencode";
  promptMode: "slash" | "inline";
  opencodePermission: Record<string, unknown> | null; // null ⇒ 用内建 OPENCODE_PERMISSION_DEFAULT
  graceSeconds: number;
  keystoneReviewer: { model: string; effort: string };
  agents: Record<string, AgentBlock>;
};

function checkAgentBlock(src: string, blk: unknown): Record<string, Record<string, unknown>> {
  if (blk === null || typeof blk !== "object" || Array.isArray(blk)) die(`${src}.agents 必须是对象`);
  const out = blk as Record<string, unknown>;
  for (const [name, fields] of Object.entries(out)) {
    if (!AGENT_ORDER.includes(name)) die(`${src}.agents 含未知 agent '${name}'（合法：${AGENT_ORDER.join(", ")}）`);
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) die(`${src}.agents.${name} 必须是对象`);
    for (const [fld, val] of Object.entries(fields as Record<string, unknown>)) {
      if (fld === "intervalSeconds" || fld === "capSeconds" || fld === "staggerSeconds") {
        const low = fld === "staggerSeconds" ? 0 : 1;
        if (!Number.isInteger(val) || (val as number) < low) die(`${src}.agents.${name}.${fld} 必须是 ≥${low} 的整数（得到 ${JSON.stringify(val)}）`);
      } else if (fld === "enabled") {
        if (typeof val !== "boolean") die(`${src}.agents.${name}.enabled 必须是布尔（得到 ${JSON.stringify(val)}）`);
      } else if (fld === "command") {
        if (!Array.isArray(val) || val.length === 0 || !val.every((x) => typeof x === "string")) die(`${src}.agents.${name}.command 必须是非空字符串数组`);
      } else if (fld !== "model" && fld !== "effort") {
        die(`${src}.agents.${name} 含未知字段 '${fld}'`);
      }
    }
  }
  return out as Record<string, Record<string, unknown>>;
}

function applyLayer(sched: Sched, src: string, layer: unknown): void {
  if (layer === null || typeof layer !== "object" || Array.isArray(layer)) die(`${src} 必须是对象`);
  for (const [k, v] of Object.entries(layer as Record<string, unknown>)) {
    if (k === "agents") {
      const blocks = checkAgentBlock(src, v);
      for (const [name, blk] of Object.entries(blocks)) Object.assign(sched.agents[name], blk);
    } else if (k === "cli") {
      if (v !== "claude" && v !== "codex" && v !== "opencode") die(`${src}.cli 必须是 "claude" | "codex" | "opencode"（得到 ${JSON.stringify(v)}）`);
      sched.cli = v;
    } else if (k === "promptMode") {
      if (v !== "slash" && v !== "inline") die(`${src}.promptMode 必须是 "slash" | "inline"（得到 ${JSON.stringify(v)}）`);
      sched.promptMode = v;
    } else if (k === "opencodePermission") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) die(`${src}.opencodePermission 必须是对象（整对象覆盖内建默认，不做 deep-merge）`);
      sched.opencodePermission = v as Record<string, unknown>;
    } else if (k === "graceSeconds") {
      if (!Number.isInteger(v) || (v as number) < 0) die(`${src}.graceSeconds 必须是 ≥0 的整数`);
      sched.graceSeconds = v as number;
    } else if (k === "keystoneReviewer") {
      if (v === null || typeof v !== "object" || Array.isArray(v)
          || Object.keys(v as object).some((x) => x !== "model" && x !== "effort")) {
        die(`${src}.keystoneReviewer 只接受 {model, effort}`);
      }
      Object.assign(sched.keystoneReviewer, v);
    } else {
      die(`${src} 含未知字段 '${k}'`);
    }
  }
}

export function buildSched(cfg: WlConfig, key: string, project: WlProject): Sched {
  const sched: Sched = {
    cli: "claude",
    promptMode: "slash",
    opencodePermission: null,
    graceSeconds: GRACE_DEFAULT,
    keystoneReviewer: { ...KEYSTONE_DEFAULT },
    agents: {},
  };
  for (const [agent, model, effort, interval, cap, stagger] of AGENT_SPECS) {
    sched.agents[agent] = {
      model, effort, intervalSeconds: interval, capSeconds: cap,
      enabled: true, staggerSeconds: stagger, command: null,
    };
  }
  // ① workspace scheduler 块
  applyLayer(sched, "scheduler", cfg.scheduler ?? {});
  // ② 既有 per-project 档位映射（config-schema「agent 档位覆盖」）居中生效
  for (const [agent, m] of Object.entries((project.models as Record<string, string> | undefined) ?? {})) {
    if (sched.agents[agent]) sched.agents[agent].model = m;
  }
  for (const [agent, e] of Object.entries((project.efforts as Record<string, string> | undefined) ?? {})) {
    if (sched.agents[agent]) sched.agents[agent].effort = e;
  }
  // ③ 项目 scheduler 块（最高层，--cli flag 在 schedulerMain 里再压一层）
  applyLayer(sched, `projects.${key}.scheduler`, project.scheduler ?? {});
  return sched;
}

// ---------------------------------------------------------------------------
// keystone 升档谓词：板 frontmatter 纯 glob（不读票体）
// ---------------------------------------------------------------------------
export function keystonePending(boardTicketsDir: string): boolean {
  let names: string[];
  try { names = readdirSync(boardTicketsDir); } catch { return false; }
  for (const fn of names) {
    if (!fn.endsWith(".md")) continue;
    let head: string;
    try { head = readHead(join(boardTicketsDir, fn), 4096); } catch { continue; }
    if (!head.startsWith("---")) continue;
    const fm = head.split("\n---")[0];
    const mState = /^state:[ \t]*(.+?)[ \t]*$/m.exec(fm);
    const mLabels = /^labels:[ \t]*\[(.*?)\]/m.exec(fm);
    if (!mState || !mLabels) continue;
    const labels = mLabels[1].split(",").map((t) => t.trim());
    if (mState[1] === "In Review" && labels.includes("keystone")) return true;
  }
  return false;
}

export function resolveTier(sched: Sched, agent: string, boardDir: string): { model: string; effort: string; escalated: boolean } {
  // reviewer 且板上有 In Review+keystone ⇒ 升档。
  const blk = sched.agents[agent];
  if (agent === "reviewer" && keystonePending(boardDir)) {
    const ks = sched.keystoneReviewer;
    return { model: ks.model || blk.model, effort: ks.effort || blk.effort, escalated: true };
  }
  return { model: blk.model, effort: blk.effort, escalated: false };
}

// ---------------------------------------------------------------------------
// 命令构建（三引擎车道 + promptMode）
// ---------------------------------------------------------------------------

// 剥掉 SKILL.md 顶部的 YAML frontmatter（dev-loop run-agents 同款语义；容错无 frontmatter）。
export function stripFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return raw;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
  }
  return raw;
}

// promptMode:"inline"（及 opencode 恒定形态）的 fire prompt 组装：
// 读 <插件根>/skills/<agent>-agent/SKILL.md，剥 YAML frontmatter，把正文里的字面
// ${CLAUDE_PLUGIN_ROOT} 替换为插件根绝对路径，再前置调度器上下文头 + 分隔线。
export function buildInlinePrompt(agent: string, key: string, repo: string, dataRootPath: string, root: string | null): string {
  if (!root) die("promptMode=inline 需要完整插件 checkout —— 解析不到插件根（skills/+references/+scripts/）");
  const skillPath = join(root, "skills", `${agent}-agent`, "SKILL.md");
  if (!existsSync(skillPath)) die(`promptMode=inline 需要完整插件 checkout —— 找不到 ${skillPath}`);
  const body = stripFrontmatter(readFileSync(skillPath, "utf8")).replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  const header =
    `【writing-loop 调度器上下文】本 fire 由 writing-loop 调度器启动（非交互操作者会话）。` +
    `项目 key: ${key}；剧本 repo: ${repo}；workspace 状态目录: ${dataRootPath}；` +
    `插件根（skill 引用中的 \${CLAUDE_PLUGIN_ROOT} 均指此路径）: ${root}。` +
    `以下是本 fire 要执行的 skill 全文——严格遵循：`;
  return header + "\n\n" + "─".repeat(40) + "\n\n" + body;
}

// ⇒ {argv, inlinePrompt}。inlinePrompt 非 null 时即 argv 里内联的整段 prompt（dry-run 据此
// 截断展示）；slash 模式与 command 覆盖恒为 null。
export function fireArgv(
  sched: Sched, agent: string, model: string, effort: string, repo: string,
  dataRootPath: string, key: string, root: string | null,
): { argv: string[]; inlinePrompt: string | null } {
  const skill = `/writing-loop:${agent}-agent`;
  const override = sched.agents[agent].command;
  if (override) {
    // 测试接缝（0.4.0 同款）：{skill}{model}{effort}{repo}{data}{agent} 占位符逐 token 替换。
    const subs: Record<string, string> = {
      "{skill}": skill, "{model}": model, "{effort}": effort || "",
      "{repo}": repo, "{data}": dataRootPath, "{agent}": agent,
    };
    const argv = override.map((tok) => {
      for (const [k, v] of Object.entries(subs)) tok = tok.replaceAll(k, v);
      return tok;
    });
    return { argv, inlinePrompt: null };
  }
  // opencode 无插件/斜杠命令机制 ⇒ 无视 promptMode 恒 inline；claude/codex 按旋钮走，
  // slash（默认）与 0.4.0 逐字节一致。
  const inline = sched.cli === "opencode" || sched.promptMode === "inline";
  const prompt = inline ? buildInlinePrompt(agent, key, repo, dataRootPath, root) : skill;
  if (sched.cli === "opencode") {
    // 模型名规则：Claude 档位名（opus/sonnet…不含 "/"）绝不传给 opencode——省略 -m
    // 落 opencode 自身默认模型；仅 provider/model 形（含 "/"）才传。effort 原样传
    // --variant（opencode 的 reasoning-effort 旗标，值随模型而定 —— 不做 codex 的
    // max→xhigh clamp）。cwd 与 claude 车道一致 = repoPath（spawn 处统一）。
    const argv = ["opencode", "run"];
    if (model && model.includes("/")) argv.push("-m", model);
    if (effort) argv.push("--variant", effort);
    argv.push(prompt);
    return { argv, inlinePrompt: prompt };
  }
  if (sched.cli === "codex") {
    const m = CODEX_MODEL_MAP[model] ?? model;
    const e = effort ? (CODEX_EFFORT_MAP[effort] ?? effort) : null;
    const argv = ["codex", "exec", "-C", repo,
      "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--model", m];
    if (e) argv.push("-c", `model_reasoning_effort="${e}"`);
    argv.push(prompt);
    return { argv, inlinePrompt: inline ? prompt : null };
  }
  // claude —— 与 0.4.0 launcher 调用形逐 flag 一致（slash 模式下 -p 收斜杠命令；
  // inline 模式下 -p 收内联全文，其余 flag 不变）
  const argv = ["claude", "-p", prompt, "--model", model];
  if (effort) argv.push("--effort", effort);
  argv.push("--dangerously-skip-permissions", "--add-dir", dataRootPath);
  return { argv, inlinePrompt: inline ? prompt : null };
}

export function fireEnv(sched: Sched): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const homeBin = join(homedir(), ".local", "bin");
  env.PATH = homeBin + delimiter + (env.PATH ?? "");
  if (sched.cli === "opencode") {
    // 在继承 process.env 之后赋值 ⇒ fire 策略压过操作者自己的 export
    // （dev-loop PORTABILITY §5 认证同款）。紧凑 JSON 序列化。
    env.OPENCODE_PERMISSION = JSON.stringify(effectiveOpencodePermission(sched));
  }
  return env;
}

export function effectiveOpencodePermission(sched: Sched): Record<string, unknown> {
  // 空对象与 null 同视为「未覆盖」（0.4.0 falsy 语义）——整对象覆盖，不做 deep-merge。
  const p = sched.opencodePermission;
  return p && Object.keys(p).length ? p : { ...OPENCODE_PERMISSION_DEFAULT };
}

// ---------------------------------------------------------------------------
// 项目锁（board-lock.sh choreography；缺 bash 时 inline 同语义）
// ---------------------------------------------------------------------------
function lockHelper(): string | null {
  try {
    const p = join(pluginRoot(), "scripts", "board-lock.sh");
    return existsSync(p) ? p : null;
  } catch { return null; }
}

// 与 board-lock.sh is_holder_shaped 的锚定文法逐字对齐（秒精度、无后缀）——两个工具互认
// 彼此的锁；任何偏离都会让对方把本方残锁判成「非锁文件」而拒收（WL-53 守卫的反面）。
function holderLine(): string {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `holder pid=${process.pid} at ${ts}\n`;
}

const HOLDER_RE = /^holder pid=\d+ at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n?$/;

function isHolderShaped(path: string): boolean {
  try { return HOLDER_RE.test(readHead(path, 256)); } catch { return false; }
}

export function acquireLock(lockPath: string): boolean {
  if (!lockPath.endsWith(".lock")) throw new Error("锁路径必须以 .lock 结尾（防误传目标文件）");
  const helper = lockHelper();
  if (helper) {
    const r = spawnSync("bash", [helper, "acquire", lockPath], { stdio: ["ignore", "inherit", "inherit"] });
    if (!r.error) return r.status === 0;
    // bash 二进制缺失 ⇒ 落入 inline 同语义路径
  }
  for (const attempt of [1, 2]) {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT|O_EXCL|O_WRONLY：OS 保证唯一赢家
      writeSync(fd, holderLine());
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > 60 * 60 * 1000; } catch { stale = false; }
      if (attempt === 1 && stale) {
        // WL-53 守卫（inline 同 board-lock.sh）：超龄但非 holder 格式 ⇒ 绝不 rm。
        if (!isHolderShaped(lockPath)) {
          console.error(`wl-run: ${lockPath} 超龄但不是本工具的锁文件——绝不删除，请人工检查（WL-53）`);
          return false;
        }
        console.error(`wl-run: stale lock >60min，强清重试：${lockPath}`);
        try { unlinkSync(lockPath); } catch { /* 竞争者先清了 ⇒ 重试照样走 O_EXCL */ }
        continue;
      }
      return false;
    }
  }
  return false;
}

export function releaseLock(lockPath: string): void {
  const helper = lockHelper();
  if (helper) {
    const r = spawnSync("bash", [helper, "release", lockPath], { stdio: ["ignore", "inherit", "inherit"] });
    if (!r.error) return;
  }
  if (isHolderShaped(lockPath)) {
    try { unlinkSync(lockPath); } catch { /* 已被清 ⇒ 幂等 */ }
  } else {
    console.error(`wl-run: ${lockPath} 不是 holder 格式——拒绝释放删除，请人工检查（WL-53）`);
  }
}

export function heartbeatLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    try { writeFileSync(lockPath, holderLine()); } // 锁被外力移走 —— 重建，绝不无锁裸跑
    catch { /* 目录都没了也不弄死主循环 */ }
  }
}

// ---------------------------------------------------------------------------
// fire 生命周期
// ---------------------------------------------------------------------------
class Fire {
  readonly startedMono = mono();
  readonly startedIso = utcIso();
  timedOut = false;
  killDeadline: number | null = null;
  exited = false;
  rc: number | null = null;          // 信号死 ⇒ 负信号号（同 python subprocess returncode）
  spawnError: string | null = null;
  readonly agent: string;
  readonly child: ChildProcess;
  readonly model: string;
  readonly effort: string;
  readonly escalated: boolean;
  readonly cap: number;
  readonly logPath: string;
  constructor(agent: string, child: ChildProcess, model: string, effort: string,
    escalated: boolean, cap: number, logPath: string) {
    this.agent = agent; this.child = child; this.model = model; this.effort = effort;
    this.escalated = escalated; this.cap = cap; this.logPath = logPath;
  }
}

// §0：no-op fire 打印一行含「no-op」的收尾 —— 取输出尾部检测。
export function detectNoop(logPath: string): boolean {
  let tail: string;
  try {
    const fd = openSync(logPath, "r");
    try {
      const size = fstatSync(fd).size;
      const n = Math.min(4096, size);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      tail = buf.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return false; }
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-5).some((l) => l.toLowerCase().includes("no-op"));
}

function killpg(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, sig); } // detached ⇒ 子进程是进程组长，负 pid 杀全组
  catch { /* 组已消失 / 无权限 ⇒ 静默（同 0.4.0） */ }
}

const signalNumber = (sig: NodeJS.Signals): number =>
  (osConstants.signals as Record<string, number | undefined>)[sig] ?? 1;

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
export type Args = {
  project: string | null;
  cli: "claude" | "codex" | "opencode" | null;
  once: boolean;
  dryRun: boolean;
  plan: number | null;
  agents: string | null;
  forSeconds: number;
};

const USAGE = `wl-run — writing-loop 内建调度器：单进程驱动一个项目的全部 agent 循环
（写 repo 角色全局单飞；keystone 自动升档；fires.jsonl 遥测）。原生 TS，随 @dyzsasd/writing-loop 内建。

用法: writing-loop run [--project K] [--once] [--dry-run] [--plan N] [--agents a,b] [--for S]
                       [--cli claude|codex|opencode]

  --project K   项目 key（多项目 workspace 必填）
  --cli C       本次运行的 CLI 引擎：claude | codex | opencode
                （优先级：本 flag > 项目 scheduler.cli > workspace scheduler.cli > 默认 claude）
  --once        每个入选 agent 恰好 fire 一次（忽略 stagger），跑完即退
  --dry-run     打印每条将起命令的完整解析（model/effort/cwd/env；opencode 另打印
                OPENCODE_PERMISSION 摘要与截断 prompt），不 spawn、不写 ledger、不拿锁
  --plan N      模拟打印未来 N 个 fire 的排程（零 spawn）
  --agents a,b  只驱动这些 agent（逗号分隔；接受 showrunner 或 showrunner-agent 形）
  --for S       运行 S 秒后优雅停止（0 = 直到 Ctrl-C；再按一次 Ctrl-C 立即杀）

配置：<workspace>/.writing-loop/config.json 顶层 scheduler 块 + projects.<key>.scheduler 覆盖
（schema 见 references/config-schema.md）。promptMode："slash"（默认）| "inline"；opencode 恒 inline。
板/账本/遥测都在 <workspace>/.writing-loop/<key>/ 下（fires.jsonl、wl-run.lock、logs/）。`;

function usageDie(msg: string): never {
  console.error(`用法: writing-loop run [--project K] [--once] [--dry-run] [--plan N] [--agents a,b] [--for S] [--cli claude|codex|opencode]`);
  die(msg, 2);
}

export function parseArgs(argv: string[]): Args | "help" {
  const args: Args = { project: null, cli: null, once: false, dryRun: false, plan: null, agents: null, forSeconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) usageDie(`参数 ${a} 需要值`);
      return v;
    };
    if (a === "--help" || a === "-h") return "help";
    else if (a === "--project") args.project = val();
    else if (a === "--cli") {
      const v = val();
      if (v !== "claude" && v !== "codex" && v !== "opencode") usageDie(`--cli 必须是 claude | codex | opencode（得到 '${v}'）`);
      args.cli = v;
    } else if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--plan") {
      const v = Number(val());
      if (!Number.isInteger(v)) usageDie("--plan 需要整数 N");
      args.plan = v;
    } else if (a === "--agents") args.agents = val();
    else if (a === "--for") {
      const v = Number(val());
      if (!Number.isFinite(v)) usageDie("--for 需要秒数 S");
      args.forSeconds = v;
    } else usageDie(`未知参数 '${a}'`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 调度器主体
// ---------------------------------------------------------------------------
export class Scheduler {
  readonly projData: string;
  readonly boardDir: string;
  readonly logsDir: string;
  readonly ledgerPath: string;
  readonly lockPath: string;
  readonly selected: string[];
  readonly inflight: Fire[] = [];
  readonly firedOnce = new Set<string>();
  stopRequested = 0;                 // 1 = 优雅停，2 = 立即杀
  private logSeq = 0;

  readonly args: Args;
  readonly wsRoot: string;
  readonly dataRootPath: string;
  readonly key: string;
  readonly repo: string;
  readonly sched: Sched;
  readonly root: string | null;      // 插件根（inline prompt / board-lock.sh）；解析不到留 null

  constructor(args: Args, wsRoot: string, dataRootPath: string, key: string,
    repo: string, sched: Sched, root: string | null) {
    this.args = args; this.wsRoot = wsRoot; this.dataRootPath = dataRootPath;
    this.key = key; this.repo = repo; this.sched = sched; this.root = root;
    this.projData = join(dataRootPath, key);
    this.boardDir = join(this.projData, "board", "tickets");
    this.logsDir = join(this.projData, "logs");
    this.ledgerPath = join(this.projData, "fires.jsonl");
    this.lockPath = join(this.projData, "wl-run.lock");
    this.selected = this.selectAgents(args.agents);
  }

  private selectAgents(spec: string | null): string[] {
    if (!spec) return AGENT_ORDER.filter((a) => this.sched.agents[a].enabled);
    const out: string[] = [];
    for (const tok of spec.split(",")) {
      let name = tok.trim();
      if (name.endsWith("-agent")) name = name.slice(0, -"-agent".length);
      if (!AGENT_ORDER.includes(name)) die(`--agents 含未知 agent '${tok.trim()}'（合法：${AGENT_ORDER.join(", ")}）`);
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  // ---- 并发闸 ----
  slotFree(agent: string): boolean {
    if (REPO_WRITERS.has(agent)) return !this.inflight.some((f) => REPO_WRITERS.has(f.agent));
    return this.inflight.filter((f) => !REPO_WRITERS.has(f.agent)).length < BOARD_ONLY_MAX;
  }

  // ---- 遥测 ----
  private ledgerAppend(row: Record<string, unknown>): void {
    appendFileSync(this.ledgerPath, JSON.stringify(row) + "\n");
  }

  // ---- 起 fire ----
  launch(agent: string): void {
    const { model, effort, escalated } = resolveTier(this.sched, agent, this.boardDir);
    const { argv } = fireArgv(this.sched, agent, model, effort, this.repo, this.dataRootPath, this.key, this.root);
    mkdirSync(this.logsDir, { recursive: true });
    this.logSeq++;
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
    const logPath = join(this.logsDir, `${stamp}-${String(this.logSeq).padStart(2, "0")}-${agent}.log`);
    const fd = openSync(logPath, "w");
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: this.repo, env: fireEnv(this.sched),
        stdio: ["ignore", fd, fd], detached: true, // detached ⇒ 新进程组（cap 超时可 killpg 全组）
      });
    } catch (e) {
      // 同步 spawn 失败（罕见）：同 0.4.0 的 OSError 分支——记 spawnError 行、不进 inflight。
      closeSync(fd);
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[${utcIso()}] FAIL ${agent}：无法起进程（${msg}）`);
      const nowIso = utcIso();
      this.ledgerAppend({
        agent, model, effort, startedAt: nowIso, endedAt: nowIso, durationSeconds: 0,
        exitCode: null, timedOut: false, noop: false, keystoneEscalated: escalated, spawnError: msg,
      });
      this.firedOnce.add(agent);
      return;
    }
    closeSync(fd); // 子进程已持有 fd
    const fire = new Fire(agent, child, model, effort, escalated, this.sched.agents[agent].capSeconds, logPath);
    child.on("error", (e) => {
      // 异步 spawn 失败（ENOENT 典型形）：exit 事件不会来 ⇒ 这里标记，由 poll 收账。
      if (fire.rc === null && !fire.exited) { fire.spawnError = e.message; fire.exited = true; }
    });
    child.on("exit", (code, signal) => {
      fire.rc = code ?? (signal ? -signalNumber(signal) : null);
      fire.exited = true;
    });
    this.inflight.push(fire);
    this.firedOnce.add(agent);
    const cls = REPO_WRITERS.has(agent) ? "repo-writer" : "board-only";
    console.log(`[${fire.startedIso}] fire ${agent}（${model}/${effort || "-"}${escalated ? "，keystone 升档" : ""}，${cls}，cap ${fire.cap}s）→ ${relative(this.projData, logPath)}`);
  }

  // ---- 收 fire ----
  private finish(fire: Fire, rc: number | null): number {
    this.inflight.splice(this.inflight.indexOf(fire), 1);
    const ended = utcIso();
    const dur = Math.round((mono() - fire.startedMono) * 1000) / 1000;
    const noop = detectNoop(fire.logPath);
    this.ledgerAppend({
      agent: fire.agent, model: fire.model, effort: fire.effort,
      startedAt: fire.startedIso, endedAt: ended, durationSeconds: dur,
      exitCode: rc, timedOut: fire.timedOut, noop, keystoneEscalated: fire.escalated,
    });
    const flags: string[] = [];
    if (fire.timedOut) flags.push(`TIMEOUT>${fire.cap}s`);
    if (noop) flags.push("no-op");
    console.log(`[${ended}] done ${fire.agent} exit ${rc} in ${dur.toFixed(1)}s${flags.length ? `（${flags.join("，")}）` : ""}`);
    return mono() + this.sched.agents[fire.agent].intervalSeconds;
  }

  private finishSpawnError(fire: Fire): void {
    // 0.4.0 语义：spawn 失败记 spawnError 行、fired_once 记名，但不推 due（连续模式下
    // 下一 tick 立即重试——二进制装好即恢复，不留长空窗）。
    this.inflight.splice(this.inflight.indexOf(fire), 1);
    console.log(`[${utcIso()}] FAIL ${fire.agent}：无法起进程（${fire.spawnError}）`);
    const nowIso = utcIso();
    this.ledgerAppend({
      agent: fire.agent, model: fire.model, effort: fire.effort,
      startedAt: fire.startedIso, endedAt: nowIso, durationSeconds: 0,
      exitCode: null, timedOut: false, noop: false, keystoneEscalated: fire.escalated,
      spawnError: fire.spawnError,
    });
  }

  pollInflight(due: Map<string, number>): void {
    const now = mono();
    for (const fire of [...this.inflight]) {
      if (fire.exited) {
        if (fire.spawnError !== null && fire.rc === null) this.finishSpawnError(fire);
        else due.set(fire.agent, this.finish(fire, fire.rc));
        continue;
      }
      if (fire.killDeadline !== null) {
        if (now >= fire.killDeadline) {
          killpg(fire.child, "SIGKILL");
          fire.killDeadline = now + 3600; // 已 KILL，等 reap
        }
      } else if (now - fire.startedMono > fire.cap) {
        console.log(`[${utcIso()}] fire ${fire.agent} 超 cap ${fire.cap}s —— TERM（3s 后 KILL）`);
        fire.timedOut = true;
        killpg(fire.child, "SIGTERM");
        fire.killDeadline = now + 3;
      }
    }
  }

  killAll(sig: NodeJS.Signals): void {
    for (const fire of this.inflight) {
      killpg(fire.child, sig);
      if (fire.killDeadline === null) fire.killDeadline = mono() + 3;
    }
  }

  // ---- 主循环 ----
  async run(): Promise<number> {
    mkdirSync(this.projData, { recursive: true });
    if (!acquireLock(this.lockPath)) {
      die(`另一个 wl-run 正持有 ${this.lockPath}（或 <60min 前崩溃）—— 先停它，或等陈旧锁 60min 自动回收`);
    }
    const onSignal = (): void => { this.stopRequested = Math.min(this.stopRequested + 1, 2); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const start = mono();
    const due = new Map<string, number>();
    for (const a of this.selected) {
      due.set(a, this.args.once ? start : start + this.sched.agents[a].staggerSeconds);
    }
    let lastBeat = start;
    let graceDeadline: number | null = null;
    console.log(
      `wl-run: 项目 ${this.key} · cli=${this.sched.cli} · agents=${this.selected.join(",")} · ` +
      `单飞写者=${this.selected.filter((a) => REPO_WRITERS.has(a)).join(",") || "无"} · 板上≤${BOARD_ONLY_MAX} 并发\n` +
      `        repo=${this.repo}\n        ledger=${this.ledgerPath}`);
    try {
      for (;;) {
        this.pollInflight(due);
        const now = mono();
        const stopping = this.stopRequested > 0
          || (this.args.forSeconds > 0 && now - start >= this.args.forSeconds);
        if (this.stopRequested >= 2) this.killAll("SIGKILL");
        if (stopping) {
          if (graceDeadline === null) {
            graceDeadline = now + this.sched.graceSeconds;
            if (this.inflight.length) {
              console.log(`wl-run: 停止请求 —— 等 in-flight 收尾（宽限 ${this.sched.graceSeconds}s，再按一次 Ctrl-C 立即杀）`);
            }
          }
          if (!this.inflight.length) break;
          if (now >= graceDeadline) {
            this.killAll("SIGTERM");
            graceDeadline = now + 3600; // TERM 已发；kill_deadline 接管
          }
        } else {
          const order = [...this.selected].sort((a, b) =>
            (due.get(a)! - due.get(b)!) || (AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b)));
          for (const agent of order) {
            if (this.inflight.some((f) => f.agent === agent)) continue;
            if (this.args.once && this.firedOnce.has(agent)) continue;
            if (due.get(agent)! > now || !this.slotFree(agent)) continue;
            this.launch(agent);
          }
        }
        if (this.args.once && !this.inflight.length && this.selected.every((a) => this.firedOnce.has(a))) break;
        if (now - lastBeat >= HEARTBEAT_S) {
          heartbeatLock(this.lockPath);
          lastBeat = now;
        }
        await new Promise((r) => setTimeout(r, TICK_MS));
      }
    } finally {
      releaseLock(this.lockPath);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    console.log(`wl-run: 干净停止（ledger：${this.ledgerPath}）`);
    return 0;
  }

  // ---- dry-run / plan ----
  dryRun(): number {
    console.log(`wl-run --dry-run: 项目 ${this.key} · cli=${this.sched.cli} · promptMode=${this.sched.promptMode} —— 只打印将起的命令，不 spawn、不写 ledger、不拿锁`);
    for (const agent of this.selected) {
      const { model, effort, escalated } = resolveTier(this.sched, agent, this.boardDir);
      const { argv, inlinePrompt } = fireArgv(this.sched, agent, model, effort, this.repo, this.dataRootPath, this.key, this.root);
      const blk = this.sched.agents[agent];
      const cls = REPO_WRITERS.has(agent) ? "repo-writer（全局单飞）" : `board-only（≤${BOARD_ONLY_MAX} 并发）`;
      console.log(`\n${agent}  [${cls}]  interval ${blk.intervalSeconds}s · cap ${blk.capSeconds}s${escalated ? " · KEYSTONE 升档中（板上有 In Review+keystone）" : ""}`);
      const toks = argv.map((a) => {
        if (inlinePrompt !== null && a === inlinePrompt && a.length > 120) {
          // 内联 prompt 截断展示（完整内容只进真 spawn，不刷屏）
          return `'${a.slice(0, 120).replaceAll("\n", "\\n")}…[${a.length} chars]'`;
        }
        return a.includes(" ") ? `'${a}'` : a;
      });
      console.log(`  cmd : ${toks.join(" ")}`);
      console.log(`  cwd : ${this.repo}`);
      console.log(`  env : PATH=~/.local/bin:$PATH（继承其余环境）`);
      if (this.sched.cli === "opencode") {
        console.log(`  perm: OPENCODE_PERMISSION=${JSON.stringify(effectiveOpencodePermission(this.sched))}`);
      }
    }
    return 0;
  }

  plan(n: number): number {
    console.log(`wl-run --plan ${n}: cli=${this.sched.cli} · 未来 ${n} 个 fire 的排程模拟（假定每 fire 0 秒完成；实际次序还受单飞/并发闸与 fire 时长影响）`);
    const due: Array<[number, number, string]> = this.selected.map((a) =>
      [this.sched.agents[a].staggerSeconds, AGENT_ORDER.indexOf(a), a]);
    for (let i = 0; i < n; i++) {
      due.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
      const [t, idx, agent] = due.shift()!;
      const blk = this.sched.agents[agent];
      const cls = REPO_WRITERS.has(agent) ? "repo-writer" : "board-only";
      console.log(`  ${`T+${t}s`.padEnd(8)} ${agent.padEnd(15)} ${blk.model}/${blk.effort || "-"}（${cls}）`);
      due.push([t + blk.intervalSeconds, idx, agent]);
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 入口（run.ts 直接调用；--help/参数错误/WsError 都在这里统一落地）
// ---------------------------------------------------------------------------
export async function schedulerMain(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed === "help") { console.log(USAGE); return 0; }
    const args = parsed;

    const wsRoot = findWorkspaceRoot(); // env WRITING_LOOP_WORKSPACE 优先；坏值 WsError
    if (!wsRoot) {
      die("未在 workspace 内（从 CWD 向上找不到 .writing-loop/，也无 WRITING_LOOP_WORKSPACE）——\n  writing-loop init 铺骨架，或在 Claude Code 里跑 /writing-loop:add-script 立项");
    }
    const ws = loadConfig(wsRoot);
    const { key, repoPath } = resolveProject(ws, args.project);
    let repoIsDir = false;
    try { repoIsDir = statSync(repoPath).isDirectory(); } catch { repoIsDir = false; }
    if (!repoIsDir) die(`项目 ${key} 的 repoPath 不存在：${repoPath}`);
    if (!isAbsolute(repoPath)) die(`repoPath 解析出非绝对路径：${repoPath}`); // 防御：workspace.ts 恒给绝对

    const sched = buildSched(ws.config, key, ws.config.projects![key]);
    if (args.cli) sched.cli = args.cli; // 顶层 flag 压过两层 config（--dry-run/--plan 亦如实反映）

    let root: string | null = null;
    try { root = pluginRoot(); } catch { root = null; } // slash 模式用不到；inline/锁助手缺根时各自兜底

    const s = new Scheduler(args, wsRoot, dataRootOf(wsRoot), key, repoPath, sched, root);
    if (!s.selected.length) die("无入选 agent（全部 enabled:false？）");
    if (args.plan !== null) return s.plan(args.plan);
    if (args.dryRun) return s.dryRun();
    return await s.run();
  } catch (e) {
    if (e instanceof WlExit) {
      if (e.message) console.error(`wl-run: ${e.message}`);
      return e.code;
    }
    if (e instanceof WsError) {
      console.error(`wl-run: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
