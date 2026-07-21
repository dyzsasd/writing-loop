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
// - 车道门控（laneGating，0.6.0 操作者裁定①「no-op 判定移到调度器」）：spawn 前按各
//   agent SKILL §0 的 lane 谓词纯函数求值（板 frontmatter + state 文件 + north-star 哈希 +
//   repo HEAD，零 LLM），谓词为空 ⇒ 不 spawn、只打一行 [gated]（详见「车道门控」节；
//   config scheduler.laneGating=false 回退 0.5.0 行为）。
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
import { createHash } from "node:crypto";
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
// 默认表 —— 0.6.0 SPECS（agent|model|effort|interval|cap|stagger）。
// 操作者 T1/T3 裁定（2026-07-19，11.6h/219 fires 实测 52% no-op 之后）：
// - 间隔全面放宽——no-op 判定移入调度器门控层（laneGating）后，勤 fire 不再是发现活的
//   唯一手段，慢节律省下空转的 boot 上下文税；
// - 写作用小模型、设计/建票用大模型：episode-writer 保持 sonnet/high 且提频（180s，
//   写作是吞吐主路径）；reviewer 默认档回落 opus/high——keystone 升档机制
//   （keystoneReviewer，默认 opus/max 不变）承担顶配场景。
// cap/stagger 与 0.4.0/0.5.0 逐格不变。
// ---------------------------------------------------------------------------
export const AGENT_SPECS: ReadonlyArray<readonly [string, string, string, number, number, number]> = [
  //  agent            model     effort   interval  cap   stagger
  ["showrunner",     "opus",   "max",     600,  3600,  0],
  ["story-designer", "opus",   "max",     300,  3600, 10],
  ["episode-writer", "sonnet", "high",    180,  2400, 20],
  ["reviewer",       "opus",   "high",    300,  2400, 30],
  ["evaluator",      "opus",   "xhigh",   600,  2400, 40],
  ["sweep",          "sonnet", "high",   1800,  1200, 50],
  ["script-doctor",  "opus",   "xhigh",  7200,  2400, 60],
  ["market-watch",   "sonnet", "high",  14400,  1200, 70],
  ["reflect",        "opus",   "xhigh", 14400,  2400, 80],
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
  laneGating: boolean;                // 车道门控 config 开关（默认 true；false 回退 0.5.0 无门控行为）
  trimFirePlugins: boolean;           // fire 减肥 config 开关（默认 true；仅 claude 车道生效）
  // ↓ 运行时解析产物（resolveTrimPlugins 填充，非 config 字段）：claude 车道 fire 追加
  //   `--settings <json>` 的注入串（null=不注入——开关关闭/清单读不到/本机 claude 不支持）。
  trimSettingsJson: string | null;
  trimNote: string | null;            // 注入摘要或降级原因（--dry-run 如实打印）
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
    } else if (k === "laneGating") {
      if (typeof v !== "boolean") die(`${src}.laneGating 必须是布尔（得到 ${JSON.stringify(v)}）`);
      sched.laneGating = v;
    } else if (k === "trimFirePlugins") {
      if (typeof v !== "boolean") die(`${src}.trimFirePlugins 必须是布尔（得到 ${JSON.stringify(v)}）`);
      sched.trimFirePlugins = v;
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
    laneGating: true,
    trimFirePlugins: true,
    trimSettingsJson: null,
    trimNote: null,
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
// provider 注册表（workspace 顶层 config.json 的 `providers` 键）—— 这个 workspace 里一切
// 剧本项目共享的 OpenAI-compatible 端点基础设施；projects 只**选择**某注册端点的 model
// （"<id>/<model>" 形），不在项目层定义端点。校验规则逐字对照 dev-loop team-config.ts:
// 150-151, 286-320 迁移（那边挂在 team.providers 下——team 是它的多项目共享设施包装；
// writing-loop 是单 workspace/多剧本项目模型，无 team 概念，故去掉包装直接挂 workspace
// 顶层）。渲染/同步进 opencode.json 见 opencode-sync.ts；pre-spawn 认证 guard 与成本归因
// 见下文「命令构建」节的 opencodeProviderPrefix / providerOf / providerAuthGap。
// ---------------------------------------------------------------------------
export type ProviderEntry = {
  kind: "openai-compatible";             // 目前唯一合法值（"anthropic" 是 dev-loop 未实装的预留，不迁）
  baseUrl: string;                       // 必须匹配 /^https?:\/\//
  authTokenEnv: string;                  // 环境变量【名字】，绝不是密钥值——config 里永远不放密钥值
  models: string[];                      // 非空数组，每个元素非空字符串
  extraOptions?: Record<string, unknown>;
  effortMode?: "passthrough" | "strip";  // 缺省 = "passthrough"
};

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;   // 小写——同时是 opencode provider key 与 agents{}.model 前缀
const PROVIDER_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_ENTRY_FIELDS: ReadonlySet<string> =
  new Set(["kind", "baseUrl", "authTokenEnv", "models", "extraOptions", "effortMode"]);

function checkProviderEntry(id: string, v: unknown): ProviderEntry {
  if (v === null || typeof v !== "object" || Array.isArray(v)) die(`providers.${id} 必须是对象`);
  const e = v as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (!PROVIDER_ENTRY_FIELDS.has(k)) die(`providers.${id} 含未知字段 '${k}'`);
  }
  if (e.kind !== "openai-compatible") {
    die(`providers.${id}.kind 必须是 "openai-compatible"（得到 ${JSON.stringify(e.kind)}）`);
  }
  if (typeof e.baseUrl !== "string" || !/^https?:\/\//.test(e.baseUrl)) {
    die(`providers.${id}.baseUrl 必须匹配 /^https?:\\/\\//（得到 ${JSON.stringify(e.baseUrl)}）`);
  }
  if (typeof e.authTokenEnv !== "string") {
    die(`providers.${id}.authTokenEnv 必须是字符串（得到 ${JSON.stringify(e.authTokenEnv)}）`);
  }
  if (e.authTokenEnv.includes("://")) {
    die(`providers.${id}.authTokenEnv 不能包含 '://'（这里应填环境变量【名字】，不是 URL/密钥值；得到 ${JSON.stringify(e.authTokenEnv)}）`);
  }
  if (!PROVIDER_ENV_RE.test(e.authTokenEnv)) {
    die(`providers.${id}.authTokenEnv 必须匹配 /^[A-Z][A-Z0-9_]*$/（大写，得到 ${JSON.stringify(e.authTokenEnv)}）`);
  }
  if (!Array.isArray(e.models) || e.models.length === 0
      || !e.models.every((m) => typeof m === "string" && m.trim() !== "")) {
    die(`providers.${id}.models 必须是非空字符串数组（每个元素非空，得到 ${JSON.stringify(e.models)}）`);
  }
  if (e.extraOptions !== undefined
      && (e.extraOptions === null || typeof e.extraOptions !== "object" || Array.isArray(e.extraOptions))) {
    die(`providers.${id}.extraOptions 若存在必须是对象`);
  }
  if (e.effortMode !== undefined && e.effortMode !== "passthrough" && e.effortMode !== "strip") {
    die(`providers.${id}.effortMode 若存在必须是 "passthrough" | "strip"（得到 ${JSON.stringify(e.effortMode)}）`);
  }
  return e as ProviderEntry;
}

// workspace 顶层 providers 键 ⇒ 校验后的注册表（id → ProviderEntry）。缺省 = {}（no-op，
// 一切下游——guard/sync/doctor——按空注册表优雅退化，不视为错误）。
export function parseProviders(cfg: WlConfig): Record<string, ProviderEntry> {
  const raw = cfg.providers;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) die("providers 必须是对象（id → ProviderEntry）");
  const out: Record<string, ProviderEntry> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROVIDER_KEY_RE.test(id)) die(`providers 的 id '${id}' 不合法（须匹配 /^[a-z0-9][a-z0-9._-]{0,31}$/，小写）`);
    out[id] = checkProviderEntry(id, v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// keystone 升档谓词：板 frontmatter 纯 glob（不读票体判断，仅解析 §18 稳定字段）。
// 0.6.0 起与车道门控共用同一个 frontmatter 解析核（parseLaneTicket/readBoardTickets）——
// 0.5.0 的 head-regex 解析被原语义扩展（额外容错引号/block 式 labels，方向只会多升档，安全）。
// ---------------------------------------------------------------------------
export function keystonePending(boardTicketsDir: string): boolean {
  return readBoardTickets(boardTicketsDir).tickets
    .some((t) => t.state === "In Review" && t.labels.includes("keystone"));
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
// 车道门控（laneGating —— 操作者 2026-07-19 裁定①「no-op 判定移到调度器」的实装）
//
// 实测 11.6h/219 fires 52% no-op：每次空转仍先付全 boot 的上下文税才发现「本 lane 无活」。
// conventions §0 预留的门控层在此落地：dispatch 决定「要不要 spawn 进程」，agent 侧
// Step-0 探针**保留**作双保险（已 spawn 后能否廉价退出，兜时刻竞态）。每个 agent 的
// lane 谓词从其 SKILL §0 探针段**如实**移植为 TS 纯函数——输入只有 板 frontmatter 快照、
// state 目录文件 stat/内容、north-star 哈希、repo HEAD（git 只读子进程），绝不调 LLM。
//
// 单向安全铁律（§0，不可违背）：谓词是**保守超集**——宁「假 spawn」（白跑一次 boot），
// 绝不「假跳过」（有活漏跑）。落实为五条工程规则：
// ① 任何读取失败/形状不可判（板目录读不到、frontmatter 边缘形态、state 文件缺失、git
//    不可用）⇒ 一律判 open（spawn）。板/reports 目录 ENOENT 例外——「还没有票/报告」是
//    可证明的空，不是含糊。
// ② 每个谓词并入对应 SKILL §0 的全部逃逸口：Ⅰ needs-\*（§4 闭集——仅 designer/reviewer/
//    showrunner 存在入口）；Ⅱ 孤儿（认领陈旧 >60min，§7；updated 缺失/未来戳 = stale-可疑
//    立即命中，§18 时钟纪律）；Ⅲ 报告结算（九个角色的 SKILL §0 全都有，reportsEscape 统一
//    并入）；Ⅳ doc-watch + 里程碑监测（仅 showrunner——板快照哈希 + north-star 哈希承载）。
// ③ showrunner 的变化检测基线只在其 fire **干净退出**（exit 0 且未超时）后提交；崩溃/
//    超时 ⇒ 基线清空 ⇒ 下次求值恒「已变」。孤儿老化这类纯墙钟转变对快照不可见——由
//    sweep 的 30min 兜底节拍回收孤儿后经板写唤醒（SKILL 同款设计：sweep 是系统兜底）。
// ④ 墙钟真相源 = 文件 mtime 与 fires.jsonl 的调度器 UTC 时钟（§18——agent 自述时间不可信）。
// ⑤ §5 顺序前置、floor 档位、passive 条件清单等**收窄性**判断一概不进门控（那是 agent 侧
//    的第二层精滤）——门控只做其 SKILL 谓词的保守超集。
//
// 门控不过 ⇒ 不 spawn：打一行 [gated] 日志（不写 fires.jsonl，防账本膨胀）；每 agent 记
// gatedCount，该 agent 下一条 fires.jsonl 记录附 gatedSinceLast 字段结清。--once = 操作者
// 显式要求跑一轮 ⇒ **绕过门控直接 launch**（Fix 轮 1 裁定口径；[gate] 逐 agent 求值照打，
// 仅诊断不拦截）；--dry-run 下门控照算并打印每 agent 的谓词求值结果（可观测）。
// config scheduler.laneGating 默认 true。
// ---------------------------------------------------------------------------

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["Done", "Canceled", "Duplicate"]);
// 票 state 的闭集词表（§18；与 agent/board_op.py 写入面一致）。词表外的值（手误
// "In  Review"/"InReview" 类）解析「成功」但随后所有精确匹配枝都静默不命中 = fail-closed
// ——按单向安全一律标 malformed（保守放行，Fix 轮 1）。
export const TICKET_STATES: ReadonlySet<string> = new Set(["Todo", "Backlog", "In Progress", "In Review", ...TERMINAL_STATES]);
const CLAIM_STALE_MS = 60 * 60_000;       // §7 认领陈旧阈值（60min）
const KEYSTONE_STALL_MS = 30 * 60_000;    // §1 keystone-stall 护栏阈值（默认 30min）
const SWEEP_CADENCE_MS = 30 * 60_000;     // sweep 兜底节拍（SKILL §0 cadence gate，30min 级）
const PARK_REMIND_MS = 24 * 60 * 60_000;  // §9 停靠 24h 重提醒
const MARKET_WEEK_MS = 7 * 24 * 60 * 60_000;   // market-watch 周频窗口
const RETRO_WINDOW_MS = 24 * 60 * 60_000;      // reflect 日频窗口
const CLOCK_SKEW_MS = 2 * 60_000;         // 容忍的正向时钟偏差；再往后即未来戳 = stale-可疑（§18）

// 门控视角的一张票：§18 稳定 frontmatter 字段 + 三条机读行（Episode:/Blocked-by:/Notified:）。
export type LaneTicket = {
  id: string;
  state: string;
  labels: string[];
  owner: string | null;        // sweep 错标即时枝的输入（缺失 = 错标候选，非解析失败）
  assignee: string | null;
  updatedRaw: string;          // 原样入板快照哈希（showrunner SKILL 拼串定义沿用）
  updatedMs: number | null;    // 解析失败 ⇒ null（墙钟谓词按 stale-可疑处理）
  mtimeMs: number;             // 人类操作员手写留言的唯一廉价信号（§0）
  episode: number | null;      // `Episode: N` 机读行
  blockedBy: string[];         // `Blocked-by: <ID>` 机读行（可多条）
  notifiedMs: number | null;   // 最新一条可解析的 `Notified: <ISO>` 评论行
  malformed: boolean;          // 关键字段（frontmatter 定界/state/labels 值）解析不出 ⇒ 保守放行
};

const stripQuotes = (s: string): string => s.replace(/^["']/, "").replace(/["']$/, "");

// frontmatter 解析核——keystone 升档与车道门控共用；在 0.5.0 keystonePending 正则的
// state/labels 之上扩展 id/owner/assignee/updated 与正文机读行。容错原则 = 单向安全：判不出
// 的关键值标 malformed（⇒ 门控保守放行），绝不猜；state 对照 TICKET_STATES 闭集词表校验；
// labels 认 flow（[a, b]）与 block（- a 逐行，**任意缩进**——零缩进 block 是合法 YAML/
// PyYAML 默认输出形/人类手写常见形，只认带缩进曾致真活票被解析成空 labels 假跳过，Fix 轮 1）
// 两种 YAML 形，键整个缺失 = 空集（缺标签是 sweep 错标清单的活，非解析失败）。
export function parseLaneTicket(raw: string, fileName: string, mtimeMs: number): LaneTicket {
  const t: LaneTicket = {
    id: fileName.replace(/\.md$/, ""), state: "", labels: [], owner: null, assignee: null,
    updatedRaw: "", updatedMs: null, mtimeMs, episode: null, blockedBy: [],
    notifiedMs: null, malformed: false,
  };
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") { t.malformed = true; return t; }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) { t.malformed = true; return t; }
  const fm = lines.slice(1, end);
  const field = (key: string): string | null => {
    for (const ln of fm) {
      const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`).exec(ln);
      if (m) return m[1];
    }
    return null;
  };
  const id = field("id");
  if (id) t.id = stripQuotes(id);
  const state = field("state");
  if (state === null || stripQuotes(state) === "") t.malformed = true;
  else {
    t.state = stripQuotes(state);
    // 闭集词表校验（Fix 轮 1）：词表外值 = 手误/未知形态，精确匹配枝会静默漏 ⇒ 保守放行。
    if (!TICKET_STATES.has(t.state)) t.malformed = true;
  }
  const labelsIdx = fm.findIndex((ln) => /^labels:/.test(ln));
  if (labelsIdx >= 0) {
    const inline = fm[labelsIdx].slice("labels:".length).trim();
    if (inline === "" || inline === "[]") {
      // block 式条目接受**任意缩进**（含零缩进——PyYAML 默认输出形）；遇新键行（^\S+: 形，
      // 天然不以 - 起头）即停；- 起头但捕不出值（孤 "-" 类）⇒ malformed（判不出绝不猜）。
      const items: string[] = [];
      for (let i = labelsIdx + 1; i < fm.length; i++) {
        const m = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(fm[i]);
        if (m) items.push(stripQuotes(m[1]));
        else if (/^[ \t]*$/.test(fm[i])) continue;
        else if (/^[ \t]*-/.test(fm[i])) { t.malformed = true; break; }
        else break;
      }
      t.labels = items;
    } else {
      const m = /^\[(.*)\]$/.exec(inline);
      if (m) t.labels = m[1].split(",").map((x) => stripQuotes(x.trim())).filter(Boolean);
      else t.malformed = true;    // labels 键在、值不是认识的形 ⇒ 保守
    }
  }
  const owner = field("owner");
  if (owner !== null) {
    const v = stripQuotes(owner);
    t.owner = v === "" || v === "null" || v === "~" ? null : v;
  }
  const assignee = field("assignee");
  if (assignee !== null) {
    const v = stripQuotes(assignee);
    t.assignee = v === "" || v === "null" || v === "~" ? null : v;
  }
  const updated = field("updated");
  if (updated !== null) {
    t.updatedRaw = updated;
    const ms = Date.parse(stripQuotes(updated));
    t.updatedMs = Number.isNaN(ms) ? null : ms;
  }
  const body = lines.slice(end + 1).join("\n");
  const ep = /^Episode:[ \t]*(\d+)/m.exec(body);
  if (ep) t.episode = Number(ep[1]);
  for (const m of body.matchAll(/^Blocked-by:[ \t]*(\S+)/gm)) t.blockedBy.push(m[1]);
  for (const m of body.matchAll(/^Notified:[ \t]*(.+?)[ \t]*$/gm)) {
    const ms = Date.parse(m[1]);
    if (!Number.isNaN(ms)) t.notifiedMs = Math.max(t.notifiedMs ?? -Infinity, ms);
  }
  return t;
}

export type BoardSnap = { tickets: LaneTicket[]; unreadable: boolean; anyMalformed: boolean };

// 板快照：glob 本项目板 tickets/*.md 仅解析 frontmatter + stat mtime（§0 探针同款输入面）。
// 目录 ENOENT = 还没有票（可证明的空板，合法）；其他读取失败 ⇒ unreadable（保守放行）。
export function readBoardTickets(ticketsDir: string): BoardSnap {
  let names: string[];
  try { names = readdirSync(ticketsDir); }
  catch (e) {
    return { tickets: [], unreadable: (e as NodeJS.ErrnoException).code !== "ENOENT", anyMalformed: false };
  }
  const tickets: LaneTicket[] = [];
  let anyMalformed = false;
  for (const fn of names.sort()) {
    if (!fn.endsWith(".md")) continue;   // .lock/临时文件天然忽略（§18）
    try {
      const p = join(ticketsDir, fn);
      const mtimeMs = statSync(p).mtimeMs;
      const t = parseLaneTicket(readFileSync(p, "utf8"), fn, mtimeMs);
      if (t.malformed) anyMalformed = true;
      tickets.push(t);
    } catch {
      anyMalformed = true;   // 单票读失败（写入竞态/权限）⇒ 保守
    }
  }
  return { tickets, unreadable: false, anyMalformed };
}

// showrunner 板快照哈希——沿用其 SKILL §0 定义：按 ID 排序、拼 id+state+labels+assignee+
// updated+mtime 后求哈希（`updated` 承载评论交接 §18；`mtime` 承载人类手写留言 §0——缺一即假退出）。
export function boardSnapshotHash(tickets: LaneTicket[]): string {
  const rows = [...tickets]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => [t.id, t.state, t.labels.join(","), t.assignee ?? "", t.updatedRaw, String(t.mtimeMs)].join("\0"));
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

// 文件内容哈希；ENOENT ⇒ "absent"（合法态，参与变更比对）；其他读取失败 ⇒ null（保守放行）。
export function hashFileOrAbsent(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null; }
}

// §7 认领陈旧（墙钟谓词）：updated 缺失/解析不出/未来戳 ⇒ stale-可疑立即命中（§18 时钟
// 纪律：绝不等未来戳「到期」）。阈值可换档（§1 keystone-stall 用 30min）。
export function claimStale(t: LaneTicket, nowMs: number, staleMs = CLAIM_STALE_MS): boolean {
  if (t.updatedMs === null) return true;
  if (t.updatedMs > nowMs + CLOCK_SKEW_MS) return true;
  return nowMs - t.updatedMs > staleMs;
}

// 孤儿形（逃逸口Ⅱ）：In Progress/In Review 认领位上 assignee 空（搁浅形）或认领陈旧。
const orphaned = (t: LaneTicket, nowMs: number): boolean => t.assignee === null || claimStale(t, nowMs);

const fmtHit = (branch: string, t?: LaneTicket): string => (t ? `${branch}（${t.id}）` : branch);

// 短/长 SHA 前缀互认（state 文件实测记 7 位短 sha；doctor change-gate 用——reviewer Job C
// 已改走 gitDiffChanged 的 diff 判据）；空串绝不当任意串的前缀
// （e3b0c44 教训——「什么都没读到」不等于「相等」，§0 空值必复算）。
export function shaEq(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  return a.startsWith(b) || b.startsWith(a);
}

// —— 各 agent lane 谓词（SKILL §0 如实移植；返回命中枝清单，空数组 = 谓词为空）——

// episode-writer（SKILL §0）：∃ Todo+tier（**任意 Type**——修订 Bug/Improvement 无
// episode 子标签，谓词绝不按子类型收窄，否则 Urgent 修订会被 cheap-exit 掉；**不排除
// blocked**——SKILL 谓词原文未排除，与 evaluator 同口径「更保守一档」，假命中代价 =
// 一次白 boot）∪ Ⅱ孤儿。Ⅰ对本角色为空集（§4 无 needs-episode-writer）；Ⅲ由 reportsEscape
// 统一并入；§5 顺序前置不进谓词（被前置挡住也让它假命中，由 agent 侧 §5 门 no-op；
// Backlog 暂存子票天然不可见，正确 cheap 退出）。
export function laneEpisodeWriter(tickets: LaneTicket[], nowMs: number): string[] {
  const hits: string[] = [];
  const todo = tickets.find((t) => t.state === "Todo" && t.labels.includes("episode-writer"));
  if (todo) hits.push(fmtHit("∃ Todo+episode-writer", todo));
  const orphan = tickets.find((t) => t.state === "In Progress" && t.labels.includes("episode-writer") && orphaned(t, nowMs));
  if (orphan) hits.push(fmtHit("孤儿 In Progress（§7 认领陈旧）", orphan));
  return hits;
}

// story-designer（SKILL §0）：∃ Todo+tier（arc-design/keystone 集/direct-write 升级/
// punch-up 全在本切片；**不排除 blocked**——SKILL 谓词原文未排除，与 evaluator 同口径）
// ∪ Ⅰ needs-designer 求助（节拍修正提案裁决——非终态即有活）∪
// Ⅱ孤儿。不按生产阶段收窄（SKILL 明令：量产段仍需接 keystone/下一 arc）。
export function laneStoryDesigner(tickets: LaneTicket[], nowMs: number): string[] {
  const hits: string[] = [];
  const todo = tickets.find((t) => t.state === "Todo" && t.labels.includes("story-designer"));
  if (todo) hits.push(fmtHit("∃ Todo+story-designer", todo));
  const needs = tickets.find((t) => !TERMINAL_STATES.has(t.state) && t.labels.includes("needs-designer"));
  if (needs) hits.push(fmtHit("needs-designer 求助（§9）", needs));
  const orphan = tickets.find((t) => t.state === "In Progress" && t.labels.includes("story-designer") && orphaned(t, nowMs));
  if (orphan) hits.push(fmtHit("孤儿 In Progress（§7 认领陈旧）", orphan));
  return hits;
}

// reviewer（SKILL §0）：∃ In Review（**任意**——owner:reviewer 主队列与 punch-up 双签、
// 档位待升的 keystone 票等全部形态的保守超集；agent 侧再精滤）∪ Ⅰ needs-reviewer ∪
// Ⅱ孤儿（In Review 认领陈旧，§7）∪ Job C change-gate（`git diff <上次审计 sha>..HEAD --
// episodes/ ledgers/` 非空；不可判 ⇒ 保守命中）。判据现行版 = reviewer-state gateNote
// 现场裁定（fire #177 实测）：旧「episodes/ HEAD 比对」对**账本-only 修订**结构性不可见
// （假阴性），而账本-only 恰是修订的主导形状——Job C 职责本含账本抽检（SKILL Job C）。
export function laneReviewer(tickets: LaneTicket[], nowMs: number, changedSinceAudit: boolean | null): string[] {
  const hits: string[] = [];
  const ir = tickets.find((t) => t.state === "In Review");
  if (ir) hits.push(fmtHit("∃ In Review", ir));
  const needs = tickets.find((t) => !TERMINAL_STATES.has(t.state) && t.labels.includes("needs-reviewer"));
  if (needs) hits.push(fmtHit("needs-reviewer 求助（§9）", needs));
  const orphan = tickets.find((t) => t.state === "In Review" && t.assignee !== null && claimStale(t, nowMs));
  if (orphan) hits.push(fmtHit("孤儿 In Review（§7 认领陈旧）", orphan));
  if (changedSinceAudit === null) hits.push("episodes/∪ledgers/ 自上次审计的 diff 不可判——保守命中（Job C change-gate）");
  else if (changedSinceAudit) hits.push("episodes/∪ledgers/ 自上次审计 sha 有改动（Job C change-gate）");
  return hits;
}

// evaluator（SKILL §0）：∃ Todo+milestone-eval（不排除 blocked——比 Job 0 拾取过滤更保守
// 一档；unblock 属 showrunner 车道）∪ Ⅱ孤儿。Ⅰ不存在 needs-evaluator（§4 闭集）。
// evaluator 是 Blocked-by 阻断闸的执行机构（§21）——探针命中即尽快 spawn。
export function laneEvaluator(tickets: LaneTicket[], nowMs: number): string[] {
  const hits: string[] = [];
  const todo = tickets.find((t) => t.state === "Todo" && t.labels.includes("milestone-eval"));
  if (todo) hits.push(fmtHit("∃ Todo+milestone-eval", todo));
  const orphan = tickets.find((t) => t.state === "In Progress" && t.labels.includes("milestone-eval") && orphaned(t, nowMs));
  if (orphan) hits.push(fmtHit("孤儿 In Progress（§7 认领陈旧）", orphan));
  return hits;
}

// showrunner（SKILL §0 + patch WL-44 第五逃逸口 + §21 Blocked-by resolver，全部逃逸口逐条）：
// - 板快照哈希变化 ∨ north-star 哈希变化（doc-watch 恒跑；无基线 = 首评估/上次 fire 未
//   干净退出 = 已变——协调者对一切变化负责，不逐条枚举触发条件）；
// - ∃ blocked 票其 Blocked-by 目标已 Done（B3 通用 resolver——§21 明令探针必须并入此
//   条件，否则每道门过后生产链永久卡死）；
// - ∃ 停靠票（blocked+needs-showrunner，§9 停靠恒带此路由）最新 `Notified:` >24h
//   （WL-44 墙钟谓词——板冻结时哈希恒等会让 §9 重提醒时钟永不求值）；无任何 Notified:
//   行且票面 >24h 未动 ⇒ 同判（首次通知义务漏发的保守面）。
// passive 模式不单列条件清单：快照+墙钟枝对 passive 亦为保守超集（Backlog 存量的「可
// 放行」转变必经板写——票态迁移/深度腾位都 bump 快照），agent 侧 passive 清单仍是第二层。
export function laneShowrunner(
  tickets: LaneTicket[], nowMs: number,
  cur: { board: string; northStar: string },
  baseline: { board: string; northStar: string } | null,
): string[] {
  const hits: string[] = [];
  if (!baseline) hits.push("无板快照基线（首次求值/上次 fire 未干净退出）——视作已变");
  else {
    if (baseline.board !== cur.board) hits.push("板快照哈希变化");
    if (baseline.northStar !== cur.northStar) hits.push("north-star 哈希变化（doc-watch）");
  }
  const byId = new Map(tickets.map((t) => [t.id, t] as const));
  const resolvable = tickets.find((t) => !TERMINAL_STATES.has(t.state) && t.labels.includes("blocked")
    && t.blockedBy.some((id) => byId.get(id)?.state === "Done"));
  if (resolvable) hits.push(fmtHit("Blocked-by 目标已 Done 待放行（§21 resolver）", resolvable));
  const parked = tickets.find((t) => {
    if (TERMINAL_STATES.has(t.state) || !t.labels.includes("blocked") || !t.labels.includes("needs-showrunner")) return false;
    if (t.notifiedMs !== null) return t.notifiedMs > nowMs + CLOCK_SKEW_MS || nowMs - t.notifiedMs > PARK_REMIND_MS;
    const lastTouch = Math.max(t.updatedMs ?? 0, t.mtimeMs);
    return nowMs - lastTouch > PARK_REMIND_MS;
  });
  if (parked) hits.push(fmtHit("停靠票 24h 重提醒到期（§9/WL-44）", parked));
  return hits;
}

// sweep（SKILL §0 + 操作者裁定五枝）：∃ In Progress（孤儿回收候选面）∨ ∃ 任何 .lock
// （板票锁/账本锁/repo 写锁——Job 3 陈旧锁清理）∨ 错标即时枝（SKILL §0 逃逸口②前半，
// frontmatter 机械可判：非终态票缺全部九个 tier 标签或 owner 字段缺失——Fix 轮 1 前靠
// cadence 枝兜底，interval<30min 配置下会延迟清理）∨ keystone-stall（In Review+keystone 且
// updated 陈旧 >30min——比 SKILL 判据少 assignee 合取，更保守）∨ 兜底节拍（距上次 sweep
// 干净 fire 超卫生周期 cadenceMs = min(config interval, 30min)——SKILL「默认 30min 级」，
// 操作者调短节律时门控随动，绝不压掉 skill cadence 本会跑的 fire；纯节拍义务由此枝兜住）。
// Ⅰ needs-sweep 不存在（§4 闭集）；上次 fire 无从考证 ⇒ 保守命中。
export function laneSweep(
  tickets: LaneTicket[], nowMs: number, anyLock: boolean | null,
  lastSweepEndMs: number | null, cadenceMs = SWEEP_CADENCE_MS,
): string[] {
  const hits: string[] = [];
  const ip = tickets.find((t) => t.state === "In Progress");
  if (ip) hits.push(fmtHit("∃ In Progress", ip));
  if (anyLock === null) hits.push("锁扫描不可判——保守命中");
  else if (anyLock) hits.push("∃ .lock 文件（板/账本/repo）");
  const mislabeled = tickets.find((t) => !TERMINAL_STATES.has(t.state)
    && (t.owner === null || !t.labels.some((l) => AGENT_ORDER.includes(l))));
  if (mislabeled) hits.push(fmtHit("错标：非终态票缺 owner/tier 标签（SKILL §0 逃逸口②）", mislabeled));
  const ks = tickets.find((t) => t.state === "In Review" && t.labels.includes("keystone") && claimStale(t, nowMs, KEYSTONE_STALL_MS));
  if (ks) hits.push(fmtHit("keystone-stall（In Review 停滞 >30min，§1 护栏）", ks));
  if (lastSweepEndMs === null || nowMs - lastSweepEndMs > cadenceMs) {
    hits.push(`兜底节拍：距上次 sweep fire >${Math.round(cadenceMs / 60_000)}min（保守）`);
  }
  return hits;
}

// market-watch（SKILL §0 cadence gate，零板依赖）：state/market-state.json 的 lastRun
// 周频到期 ∨ marketDataPath 有新内容（mtime 越过 lastRun）∨ state 缺失/不可读（保守
// spawn）。Ⅰ needs-\* 不适用（无求助入口）。
export function laneMarketWatch(nowMs: number, lastRunMs: number | null, dataNewestMs: number | null): string[] {
  if (lastRunMs === null) return ["market-state.json 缺失/lastRun 不可解析——保守 spawn"];
  const hits: string[] = [];
  if (lastRunMs > nowMs + CLOCK_SKEW_MS) hits.push("lastRun 是未来戳——stale-可疑（§18 时钟纪律）");
  else if (nowMs - lastRunMs >= MARKET_WEEK_MS) hits.push("周频到期（距上次 ≥7 天）");
  if (dataNewestMs !== null && dataNewestMs > lastRunMs) hits.push("marketDataPath 有新内容（mtime 越过 lastRun）");
  return hits;
}

// script-doctor（SKILL §0 SHA change-gate）：episodes/ 末次 commit SHA ≠ doctor-state
// lastAuditSha。失败开（SKILL 逐字）：state 缺失/字段 null 首跑/git 读不到 ⇒ 一律命中。
// ∪ Ⅱ孤儿（In Progress+script-doctor——observe-and-file 角色常态不认领，空集无害）。
export function laneScriptDoctor(tickets: LaneTicket[], nowMs: number, curSha: string | null, lastSha: string | null): string[] {
  const hits: string[] = [];
  if (lastSha === null) hits.push("doctor-state 缺失/lastAuditSha 为 null（首跑）——失败开");
  else if (curSha === null) hits.push("episodes/ HEAD 读不到——失败开");
  else if (!shaEq(curSha, lastSha)) hits.push("episodes/ SHA 变化（change-gate 命中）");
  const orphan = tickets.find((t) => t.state === "In Progress" && t.labels.includes("script-doctor") && orphaned(t, nowMs));
  if (orphan) hits.push(fmtHit("孤儿 In Progress（§7 认领陈旧）", orphan));
  return hits;
}

// reflect（SKILL §0 anti-thrash 日频窗口）：距上次 retro ≥24h ∨ state 缺失（保守 spawn）。
// Ⅰ needs-reflect 不存在；Ⅱ reflect 从不认领（SKILL §0 无孤儿枝）。SKILL §0 另有
// 「lessons 迁移待办（§14）」逃逸口——纯文件 stat，在 evalLaneGate 的 reflect 分支实现
// （本函数保持纯墙钟签名）。
export function laneReflect(nowMs: number, lastRetroMs: number | null): string[] {
  if (lastRetroMs === null) return ["reflect-state 缺失/上次 retro 时间戳不可解析——保守 spawn"];
  if (lastRetroMs > nowMs + CLOCK_SKEW_MS) return ["上次 retro 是未来戳——stale-可疑（§18 时钟纪律）"];
  if (nowMs - lastRetroMs >= RETRO_WINDOW_MS) return ["日频窗口到期（距上次 retro ≥24h）"];
  return [];
}

// —— 逃逸口Ⅲ：报告结算（§22——九个角色的 SKILL §0 全都并入本枝）——机械化口径：
// - 未分发点评：reports/*.review.md 的 mtime 晚于本 agent 上次**干净** fire 结束时刻 ⇒
//   该 agent 还没有过「boot 第 5 步分发」的机会 ⇒ 命中；上次干净 fire 无从考证 ⇒ 保守
//   命中。（点评文件永不删除（§22 retention），存在性判定会永久假命中——mtime×fire 时刻
//   才收敛：每份点评每 agent 至多多付一次 boot。）
// - 到期 weekly/monthly 汇总：结算窗口 = 自然周/月界（UTC；周界 = 周一 00:00）。上次干净
//   fire 早于当前界、且界前存在 daily 报告（YYYY-MM-DD.md）⇒ 该 agent 尚未在本窗口内全
//   boot 过（boot 第 5 步会结算到期汇总）⇒ 命中一次，其干净 fire 后自动收敛。
// 时刻来源 = fires.jsonl 的调度器 UTC 时钟（§18 认可的墙钟真相源；agent 自述时间不可信）。
export function lastWeeklyBoundaryMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}
export function lastMonthlyBoundaryMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function reportsEscape(reportsDir: string, nowMs: number, lastCleanEndMs: number | null): string | null {
  let names: string[];
  try { names = readdirSync(reportsDir); }
  catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "reports/ 读取失败——保守命中";
  }
  const dailyMtimes: number[] = [];
  for (const fn of names) {
    const p = join(reportsDir, fn);
    if (fn.endsWith(".review.md")) {
      let m: number;
      try { m = statSync(p).mtimeMs; } catch { return `点评文件 ${fn} stat 失败——保守命中`; }
      if (lastCleanEndMs === null || m > lastCleanEndMs) return `未分发点评 ${fn}（§22）`;
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(fn)) {
      try { dailyMtimes.push(statSync(p).mtimeMs); } catch { /* 消失中的文件忽略 */ }
    }
  }
  if (dailyMtimes.length) {
    const wk = lastWeeklyBoundaryMs(nowMs);
    const mo = lastMonthlyBoundaryMs(nowMs);
    if ((lastCleanEndMs === null || lastCleanEndMs < wk) && dailyMtimes.some((m) => m < wk)) {
      return "到期 weekly 汇总窗口已跨界（§22）";
    }
    if ((lastCleanEndMs === null || lastCleanEndMs < mo) && dailyMtimes.some((m) => m < mo)) {
      return "到期 monthly 汇总窗口已跨界（§22）";
    }
  }
  return null;
}

// marketDataPath 新内容探测：文件 ⇒ 自身 mtime；目录 ⇒ 有界递归取最大 mtime（预算内扫
// 不完/读错 ⇒ Infinity = 保守命中）；不存在 ⇒ null（操作者未投喂，可证明的空）。
export function newestMtimeUnder(path: string, budget = 512): number | null {
  let st;
  try { st = statSync(path); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : Infinity; }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  let seen = 0;
  const queue = [path];
  while (queue.length) {
    const dir = queue.shift()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { return Infinity; }
    for (const fn of names) {
      if (++seen > budget) return Infinity;
      const p = join(dir, fn);
      let s;
      try { s = statSync(p); } catch { return Infinity; }
      newest = Math.max(newest, s.mtimeMs);
      if (s.isDirectory()) queue.push(p);
    }
  }
  return newest;
}

// sweep 锁扫描：板票锁 board/tickets/*.lock + 账本锁 <repo>/ledgers/*.md.lock + repo 写锁
// <repo>/.git/repo.lock（§18/§15.5/§15.6 三类）。wl-run.lock 在项目数据目录顶层、不在扫描
// 面——那是调度器自己的锁。读取失败 ⇒ null（保守）；目录 ENOENT = 无锁可证明。
export function sweepLockScan(ticketsDir: string, repoPath: string): boolean | null {
  let undetermined = false;
  for (const dir of [ticketsDir, join(repoPath, "ledgers")]) {
    try {
      if (readdirSync(dir).some((fn) => fn.endsWith(".lock"))) return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") undetermined = true;
    }
  }
  try {
    if (statSync(join(repoPath, ".git", "repo.lock")).isFile()) return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") undetermined = true;
  }
  return undetermined ? null : false;
}

// repo HEAD 探针（reviewer Job C 首跑 / doctor change-gate）：pathspec（可多枚）限定的末次
// commit SHA。非 git 仓库/git 缺失/超时 ⇒ null（保守命中）；"" = 尚无 commit 触及该路径
// （可证明的空）。
export function gitLastSha(repo: string, ...pathspecs: string[]): string | null {
  try {
    const r = spawnSync("git", ["log", "-1", "--format=%H", "--", ...pathspecs],
      { cwd: repo, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout.trim();
  } catch { return null; }
}

// reviewer Job C 现行判据本体（gateNote 现场版）：`git diff --quiet <base>..HEAD -- <paths>`。
// exit 1 ⇒ true（有改动，开门）；exit 0 ⇒ false（可关）；base 无效/非 git 仓库/git 失败/
// 超时 ⇒ null（不可判，保守开）。两 commit 形只比已提交树——与 agent 侧 state 备忘一致。
export function gitDiffChanged(repo: string, baseSha: string, pathspecs: readonly string[]): boolean | null {
  try {
    const r = spawnSync("git", ["diff", "--quiet", `${baseSha}..HEAD`, "--", ...pathspecs],
      { cwd: repo, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return null;
    if (r.status === 0) return false;
    if (r.status === 1) return true;
    return null;
  } catch { return null; }
}

const readStateJson = (path: string): Record<string, unknown> | null => {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return j !== null && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch { return null; }
};
const stateStr = (j: Record<string, unknown> | null, ...keys: string[]): string | null => {
  if (!j) return null;
  for (const k of keys) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

export type GateEval = {
  open: boolean;
  reasons: string[];              // 命中枝清单（open=false 时为空 = lane 谓词为空）
  boardHash: string;              // showrunner 基线载体（其 fire 干净退出后提交）
  northStarHash: string | null;   // 仅 showrunner 求值；null = 读取失败（不提交基线）
};
export type GateIo = {
  nowMs?: number;                  // 测试接缝；缺省取真实墙钟
  boardDir: string;                // <projData>/board/tickets
  projData: string;                // state/ 与 reports/ 的根
  repoPath: string;
  marketDataPath?: string | null;
  lastCleanEndMs?: number | null;  // 本 agent 上次干净 fire 结束（调度器 UTC 时钟）
  sweepIntervalMs?: number | null; // sweep 配置节律（cadence 枝取 min(此值, 30min)；缺省按 30min）
  showrunnerBaseline?: { board: string; northStar: string } | null;
  gitSha?: (repo: string, ...pathspecs: string[]) => string | null;   // 测试接缝
  gitDiff?: (repo: string, baseSha: string, pathspecs: readonly string[]) => boolean | null; // 测试接缝
};

// 车道门控总入口：采集只读输入 ⇒ 分发 lane 谓词 ⇒ 并入逃逸口Ⅲ。任何不可判都以 reasons
// 落 open（单向安全）；本函数零写副作用（--dry-run/--once 可安全照算）。
export function evalLaneGate(agent: string, io: GateIo): GateEval {
  const nowMs = io.nowMs ?? Date.now();
  const git = io.gitSha ?? gitLastSha;
  const lastClean = io.lastCleanEndMs ?? null;
  const snap = readBoardTickets(io.boardDir);
  const reasons: string[] = [];
  // frontmatter 边缘形态/板不可读 ⇒ 对**全部** agent 保守放行——统一的安全不变量：
  // 解析不出的票可能属于任何 lane，agent 侧探针（LLM 解析更宽容）是修复它的机会。
  if (snap.unreadable) reasons.push("板目录读取失败——保守放行");
  if (snap.anyMalformed) reasons.push("板上存在 frontmatter 边缘形态票——保守放行");
  const boardHash = boardSnapshotHash(snap.tickets);
  let northStarHash: string | null = null;
  const statePath = (name: string): string => join(io.projData, "state", name);
  switch (agent) {
    case "episode-writer":
      reasons.push(...laneEpisodeWriter(snap.tickets, nowMs));
      break;
    case "story-designer":
      reasons.push(...laneStoryDesigner(snap.tickets, nowMs));
      break;
    case "reviewer": {
      // Job C change-gate 现行判据（reviewer-state gateNote 现场裁定，fire #177 实测）：
      // 有 prev sha ⇒ `git diff --quiet <prev>..HEAD -- episodes/ ledgers/`（任一路径非空
      // 即开门——账本-only 修订对旧「episodes/ HEAD 比对」判据结构性不可见，假阴性）。
      // base 键序对齐 gateNote：先 lastAuditSha（现行基点），后 lastAuditedEpisodesSha
      // （旧 schema fallback）。首跑（state 缺失）且 episodes/∪ledgers/ 确证零 commit ⇒
      // 可证明无 Job C 活（不是含糊）；其余任何不可判恒保守命中。
      const diff = io.gitDiff ?? gitDiffChanged;
      const prev = stateStr(readStateJson(statePath("reviewer-state.json")), "lastAuditSha", "lastAuditedEpisodesSha");
      let changed: boolean | null;
      if (prev === null) {
        const cur = git(io.repoPath, "episodes/", "ledgers/");
        changed = cur === null ? null : cur !== "";
      } else {
        changed = diff(io.repoPath, prev, ["episodes/", "ledgers/"]);
      }
      reasons.push(...laneReviewer(snap.tickets, nowMs, changed));
      break;
    }
    case "evaluator":
      reasons.push(...laneEvaluator(snap.tickets, nowMs));
      break;
    case "showrunner": {
      northStarHash = hashFileOrAbsent(join(io.repoPath, "bible", "north-star.md"));
      if (northStarHash === null) reasons.push("north-star 读取失败——保守放行");
      const cur = { board: boardHash, northStar: northStarHash ?? "unreadable" };
      reasons.push(...laneShowrunner(snap.tickets, nowMs, cur, io.showrunnerBaseline ?? null));
      break;
    }
    case "sweep": {
      // cadence 上界 30min、随 config 调短跟进（min）——操作者把 interval 调短时门控随动。
      const cadenceMs = Math.min(io.sweepIntervalMs ?? SWEEP_CADENCE_MS, SWEEP_CADENCE_MS);
      reasons.push(...laneSweep(snap.tickets, nowMs, sweepLockScan(io.boardDir, io.repoPath), lastClean, cadenceMs));
      break;
    }
    case "market-watch": {
      const raw = stateStr(readStateJson(statePath("market-state.json")), "lastRun");
      const parsed = raw === null ? NaN : Date.parse(raw);
      const newest = io.marketDataPath ? newestMtimeUnder(io.marketDataPath) : null;
      reasons.push(...laneMarketWatch(nowMs, Number.isNaN(parsed) ? null : parsed, newest));
      break;
    }
    case "script-doctor": {
      const lastSha = stateStr(readStateJson(statePath("doctor-state.json")), "lastAuditSha");
      reasons.push(...laneScriptDoctor(snap.tickets, nowMs, git(io.repoPath, "episodes/"), lastSha));
      break;
    }
    case "reflect": {
      const raw = stateStr(readStateJson(statePath("reflect-state.json")), "lastRetro", "lastRetroAt", "lastRun");
      const parsed = raw === null ? NaN : Date.parse(raw);
      reasons.push(...laneReflect(nowMs, Number.isNaN(parsed) ? null : parsed));
      // lessons 迁移待办逃逸口（reflect SKILL §0 逐字 / §14 迁移条款，执行者=reflect；
      // 两次 stat 零读取成本——窗口内也必须唤醒，否则迁移义务被日频门假跳过，Fix 轮 1）：
      // 旧单文件在而 lessons/ 缺失 = 迁移待办；两者并存 = 迁移崩在中途的残态（未改名
      // .migrated），同命中。
      const legacyLessons = join(io.projData, "lessons.md");
      if (existsSync(legacyLessons)) {
        reasons.push(existsSync(join(io.projData, "lessons"))
          ? "lessons 迁移中途残态：lessons/ 已建而 lessons.md 未改名 .migrated（§14）"
          : "lessons 迁移待办：旧单文件 lessons.md 在、lessons/ 目录缺失（§14）");
      }
      break;
    }
    default:
      reasons.push(`未知 agent '${agent}'——保守放行`);
  }
  const rep = reportsEscape(join(io.projData, "reports"), nowMs, lastClean);
  if (rep) reasons.push(`逃逸口Ⅲ：${rep}`);
  return { open: reasons.length > 0, reasons, boardHash, northStarHash };
}

// ---------------------------------------------------------------------------
// fire 系统面减肥（trimFirePlugins —— 操作者 2026-07-19 上下文税裁定的插件面）
// claude 车道每 fire 追加 `--settings '{"enabledPlugins":{…}}'`：仅 writing-loop 插件
// 保持启用，其余插件逐一置 false——省掉与本 loop 无关插件的 skill/命令面上下文税。
// 插件清单**动态**读自 ~/.claude/settings.json 的 enabledPlugins（写死清单会过时）。
// 实测认证（claude 2.1.215，2026-07-19）：`claude -p` 接受 --settings JSON 串；注入后
// /writing-loop: 斜杠命令照常解析（反证：连 writing-loop 也置 false ⇒ "Unknown command"）。
// 降级链（任一不满足 ⇒ 不加 flag，fire 照旧起，--dry-run 注明原因）：
//   trimFirePlugins=false → enabledPlugins 读不到 → 本机 claude --help 无 --settings。
// ---------------------------------------------------------------------------

// ~/.claude/settings.json 的 enabledPlugins 表；读不到/形状不对 ⇒ null（无清单可裁）。
export function readEnabledPlugins(settingsPath = join(homedir(), ".claude", "settings.json")): Record<string, boolean> | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { enabledPlugins?: unknown };
    const ep = raw.enabledPlugins;
    if (ep === null || ep === undefined || typeof ep !== "object" || Array.isArray(ep)) return null;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(ep as Record<string, unknown>)) out[k] = Boolean(v);
    return out;
  } catch { return null; }
}

// 清单 ⇒ 注入串：writing-loop@*（任意 marketplace 后缀）保持 true，其余全 false；
// 清单里连 writing-loop 都没有 ⇒ 补上规范键 "writing-loop@writing-loop": true。
export function buildTrimSettingsJson(enabled: Record<string, boolean>): { json: string; disabledCount: number } {
  const out: Record<string, boolean> = {};
  let hasWl = false, disabledCount = 0;
  for (const k of Object.keys(enabled)) {
    if (k.split("@")[0] === "writing-loop") { out[k] = true; hasWl = true; }
    else { out[k] = false; disabledCount++; }
  }
  if (!hasWl) out["writing-loop@writing-loop"] = true;
  return { json: JSON.stringify({ enabledPlugins: out }), disabledCount };
}

// 本机 claude 是否支持 --settings（--help 探测；按 bin 记忆化——每次 wl-run 至多探一次）。
const settingsFlagCache = new Map<string, boolean>();
export function claudeSupportsSettingsFlag(bin = "claude"): boolean {
  let hit = settingsFlagCache.get(bin);
  if (hit === undefined) {
    try {
      const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      hit = !r.error && typeof r.stdout === "string" && r.stdout.includes("--settings");
    } catch { hit = false; }
    settingsFlagCache.set(bin, hit);
  }
  return hit;
}

// 启动时解析一次（schedulerMain 在 --cli 覆盖之后调用），产物挂在 sched 上：
// fireArgv 纯读 sched.trimSettingsJson，单元测试直接构造 sched 时默认 null（0.4.0 奇偶不破）。
export function resolveTrimPlugins(
  sched: Sched,
  opts: { settingsPath?: string; supportsFlag?: (bin?: string) => boolean } = {},
): void {
  sched.trimSettingsJson = null;
  sched.trimNote = null;
  if (sched.cli !== "claude") return; // codex/opencode 车道无 --settings 面
  if (!sched.trimFirePlugins) {
    sched.trimNote = "trimFirePlugins=false（config 关闭）—— 不注入 --settings";
    return;
  }
  const enabled = readEnabledPlugins(opts.settingsPath);
  if (!enabled) {
    sched.trimNote = "读不到 ~/.claude/settings.json 的 enabledPlugins ⇒ 无插件清单可裁，本次不注入 --settings";
    return;
  }
  if (!(opts.supportsFlag ?? claudeSupportsSettingsFlag)()) {
    sched.trimNote = "本机 claude 不支持 --settings ⇒ 优雅降级：不加 flag（升级 Claude Code 可恢复 fire 减肥）";
    return;
  }
  const { json, disabledCount } = buildTrimSettingsJson(enabled);
  sched.trimSettingsJson = json;
  sched.trimNote = `--settings 注入：仅 writing-loop 插件启用（其余 ${disabledCount} 个插件本 fire 置 false）`;
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
  // inline 模式下 -p 收内联全文，其余 flag 不变）；fire 减肥注入串（若已解析出）
  // 追加在尾部——前缀 token 序 0.4.0 奇偶不变。
  const argv = ["claude", "-p", prompt, "--model", model];
  if (effort) argv.push("--effort", effort);
  argv.push("--dangerously-skip-permissions", "--add-dir", dataRootPath);
  if (sched.trimSettingsJson) argv.push("--settings", sched.trimSettingsJson);
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
// provider 归因 + pre-spawn 认证 guard（dev-loop run-agents.ts:222-227, 245-253, 883-936
// 逐条迁移）。opencodeProviderPrefix 只做字符串解析，不查注册表——未命中注册表的前缀是
// opencode 内建 provider（openai/anthropic/openrouter…自带认证），认证是 opencode 自己的
// 责任，不是 writing-loop 的事。providerAuthGap 才做注册表查找 + 环境变量可解析性判定，
// 供 dryRun()（只 note、不拦截）与 launch()（真拦截、不 spawn）共用同一判据。
// ---------------------------------------------------------------------------

// model 的 provider 前缀（"provider/model" 形的斜杠前段）；不含 "/" ⇒ null（Claude 档位名
// 或 opencode 自身默认模型，两者都不在本注册表的管辖范围内）。
export function opencodeProviderPrefix(model: string | undefined): string | null {
  return model && model.includes("/") ? model.split("/")[0] : null;
}

// fires.jsonl 的成本归因维度（dev-loop providerOf 逐字迁移）：claude 车道恒 "anthropic"、
// codex 车道恒 "openai"；opencode 车道取 model 的 provider 前缀（Claude 档位名/opencode
// 自身默认模型 ⇒ null，不虚构归因）。
export function providerOf(cli: Sched["cli"], model: string | undefined): string | null {
  if (cli === "opencode") return opencodeProviderPrefix(model);
  return cli === "claude" ? "anthropic" : "openai";
}

// pre-spawn 认证 guard：只在 cli=opencode 且 model 的 provider 前缀命中注册表条目时才可能
// 拦截——未命中（内建 provider）⇒ 一律放行，不做任何校验。命中且 authTokenEnv 环境变量
// 不可解析 ⇒ 返回 {prefix, authTokenEnv}；其余一切情况（非 opencode 车道 / 无前缀 / 未命中
// 注册表 / 认证可解析）⇒ null，一律放行——这不是「默认拒绝」的安全边界，只是给操作者一个
// 尽早的失败信号（真出问题时 opencode 自己也会在 fire 内部报认证错误，这里只是提前拦截，
// 省一次白跑的 boot）。
export function providerAuthGap(
  providers: Record<string, ProviderEntry>, cli: Sched["cli"], model: string | undefined,
): { prefix: string; authTokenEnv: string } | null {
  if (cli !== "opencode") return null;
  const prefix = opencodeProviderPrefix(model);
  if (prefix === null) return null;
  const entry = providers[prefix];
  if (!entry) return null;
  if (process.env[entry.authTokenEnv] !== undefined) return null;
  return { prefix, authTokenEnv: entry.authTokenEnv };
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
  // showrunner 门控基线候选（spawn 时刻的板/north-star 哈希）——仅其 fire 干净退出后提交
  // 为调度器基线（车道门控节规则③）；其余 agent 恒 null。
  gateSnapshot: { board: string; northStar: string } | null = null;
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
  --once        每个入选 agent 恰好 fire 一次（忽略 stagger；操作者显式点火 ⇒ 绕过
                车道门控拦截，[gate] 逐 agent 求值行仅诊断），跑完即退
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
  readonly marketDataPath: string | null;  // 项目条目 marketDataPath（market-watch 门控输入，§11）
  readonly providers: Record<string, ProviderEntry>;  // workspace 顶层 provider 注册表（pre-spawn 认证 guard 输入）

  // —— 车道门控运行时状态（laneGating）——
  // gatedCount：每 agent 被门控跳过的次数，该 agent 下一条 fires.jsonl 记录以
  // gatedSinceLast 结清（[gated] 本身不写账本，防膨胀）。
  private readonly gatedCount = new Map<string, number>();
  // lastCleanEndMs：每 agent 上次干净 fire（exit 0 且未超时）的结束时刻——逃逸口Ⅲ报告
  // 结算与 sweep 兜底节拍的墙钟基点；启动时从 fires.jsonl 回放（跨进程重启仍可判）。
  private readonly lastCleanEndMs = new Map<string, number>();
  private ledgerSeeded = false;
  // showrunner 变化检测基线（板快照哈希 + north-star 哈希）——只在其 fire 干净退出后
  // 提交（spawn 时刻采样）；崩溃/超时 ⇒ 清空 ⇒ 下次求值恒「已变」（保守）。
  private showrunnerBaseline: { board: string; northStar: string } | null = null;

  constructor(args: Args, wsRoot: string, dataRootPath: string, key: string,
    repo: string, sched: Sched, root: string | null, project: WlProject | null = null,
    providers: Record<string, ProviderEntry> = {}) {
    this.args = args; this.wsRoot = wsRoot; this.dataRootPath = dataRootPath;
    this.key = key; this.repo = repo; this.sched = sched; this.root = root;
    this.providers = providers;
    this.projData = join(dataRootPath, key);
    this.boardDir = join(this.projData, "board", "tickets");
    this.logsDir = join(this.projData, "logs");
    this.ledgerPath = join(this.projData, "fires.jsonl");
    this.lockPath = join(this.projData, "wl-run.lock");
    this.selected = this.selectAgents(args.agents);
    const mdp = project?.marketDataPath;
    this.marketDataPath = typeof mdp === "string" && mdp
      ? (isAbsolute(mdp) ? mdp : join(wsRoot, mdp)) : null;
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
    // 车道门控的账本结清：被 gated 的排程点不写行（防膨胀），累计数附在该 agent 下一条
    // 记录的 gatedSinceLast 字段；laneGating=false 时字段永不出现（0.5.0 行形奇偶不破）。
    if (this.sched.laneGating && typeof row.agent === "string") {
      const n = this.gatedCount.get(row.agent) ?? 0;
      if (n > 0) { row.gatedSinceLast = n; this.gatedCount.set(row.agent, 0); }
    }
    appendFileSync(this.ledgerPath, JSON.stringify(row) + "\n");
  }

  // ---- 车道门控 ----
  // fires.jsonl 回放各 agent 上次干净 fire 结束时刻（§18 认可的墙钟真相源）；读不到/无
  // 记录 ⇒ 相应谓词保守命中。每进程至多回放一次，此后由 finish() 在线维护。
  private seedLastCleanFromLedger(): void {
    if (this.ledgerSeeded) return;
    this.ledgerSeeded = true;
    let raw: string;
    try { raw = readFileSync(this.ledgerPath, "utf8"); } catch { return; }
    for (const ln of raw.split("\n")) {
      if (!ln.trim()) continue;
      try {
        const r = JSON.parse(ln) as { agent?: unknown; endedAt?: unknown; exitCode?: unknown; timedOut?: unknown };
        if (typeof r.agent !== "string" || typeof r.endedAt !== "string") continue;
        if (r.exitCode !== 0 || r.timedOut === true) continue;
        const t = Date.parse(r.endedAt);
        if (!Number.isNaN(t)) this.lastCleanEndMs.set(r.agent, Math.max(t, this.lastCleanEndMs.get(r.agent) ?? 0));
      } catch { /* 坏行跳过 */ }
    }
  }

  evalGate(agent: string): GateEval {
    return evalLaneGate(agent, {
      boardDir: this.boardDir,
      projData: this.projData,
      repoPath: this.repo,
      marketDataPath: this.marketDataPath,
      lastCleanEndMs: this.lastCleanEndMs.get(agent) ?? null,
      sweepIntervalMs: this.sched.agents["sweep"].intervalSeconds * 1000,
      showrunnerBaseline: this.showrunnerBaseline,
    });
  }

  // ---- 起 fire ----
  launch(agent: string, gate: GateEval | null = null): void {
    const { model, effort, escalated } = resolveTier(this.sched, agent, this.boardDir);
    // pre-spawn 认证 guard（dev-loop run-agents.ts:883-936 移植）：cli=opencode 且 model 的
    // provider 前缀命中注册表条目、但 authTokenEnv 环境变量不可解析 ⇒ 不 spawn，仍记账
    // （同现有 spawnError 分支的「不 spawn 但仍记账」模式），不进 inflight。
    const gap = providerAuthGap(this.providers, this.sched.cli, model);
    if (gap) {
      console.log(`[${utcIso()}] FAIL ${agent}：provider '${gap.prefix}' 认证环境变量 ${gap.authTokenEnv} 不可解析 —— 请 export 该变量后重试（doctor 会体检此项）`);
      const nowIso = utcIso();
      this.ledgerAppend({
        agent, model, effort, startedAt: nowIso, endedAt: nowIso, durationSeconds: 0,
        exitCode: null, timedOut: false, noop: false, keystoneEscalated: escalated,
        provider: providerOf(this.sched.cli, model), providerAuthMissing: gap.authTokenEnv,
      });
      this.firedOnce.add(agent);
      return;
    }
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
        exitCode: null, timedOut: false, noop: false, keystoneEscalated: escalated,
        provider: providerOf(this.sched.cli, model), spawnError: msg,
      });
      this.firedOnce.add(agent);
      return;
    }
    closeSync(fd); // 子进程已持有 fd
    const fire = new Fire(agent, child, model, effort, escalated, this.sched.agents[agent].capSeconds, logPath);
    // showrunner 基线候选 = 门控求值时刻的快照（north-star 读取失败 ⇒ 不设候选，保持保守）
    fire.gateSnapshot = gate && agent === "showrunner" && gate.northStarHash !== null
      ? { board: gate.boardHash, northStar: gate.northStarHash } : null;
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
    // 车道门控账本维护：干净退出（exit 0 且未超时）才推进墙钟基点/提交 showrunner 基线；
    // 崩溃/超时 ⇒ 基线清空 ⇒ 下次门控求值恒「已变」（单向安全规则③）。
    const clean = rc === 0 && !fire.timedOut;
    if (clean) this.lastCleanEndMs.set(fire.agent, Date.now());
    if (fire.agent === "showrunner") this.showrunnerBaseline = clean ? fire.gateSnapshot : null;
    this.ledgerAppend({
      agent: fire.agent, model: fire.model, effort: fire.effort,
      startedAt: fire.startedIso, endedAt: ended, durationSeconds: dur,
      exitCode: rc, timedOut: fire.timedOut, noop, keystoneEscalated: fire.escalated,
      provider: providerOf(this.sched.cli, fire.model),
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
    if (fire.agent === "showrunner") this.showrunnerBaseline = null; // 未跑成 ⇒ 保守（下次恒「已变」）
    console.log(`[${utcIso()}] FAIL ${fire.agent}：无法起进程（${fire.spawnError}）`);
    const nowIso = utcIso();
    this.ledgerAppend({
      agent: fire.agent, model: fire.model, effort: fire.effort,
      startedAt: fire.startedIso, endedAt: nowIso, durationSeconds: 0,
      exitCode: null, timedOut: false, noop: false, keystoneEscalated: fire.escalated,
      provider: providerOf(this.sched.cli, fire.model), spawnError: fire.spawnError,
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
    if (this.sched.laneGating) this.seedLastCleanFromLedger();
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
      `wl-run: 项目 ${this.key} · cli=${this.sched.cli}${this.sched.laneGating ? " · laneGating=on" : ""} · agents=${this.selected.join(",")} · ` +
      `单飞写者=${this.selected.filter((a) => REPO_WRITERS.has(a)).join(",") || "无"} · 板上≤${BOARD_ONLY_MAX} 并发\n` +
      `        repo=${this.repo}\n        ledger=${this.ledgerPath}` +
      (this.sched.trimNote ? `\n        trim=${this.sched.trimNote}` : ""));
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
            if (!this.sched.laneGating) { this.launch(agent); continue; }
            // 车道门控：spawn 前求本 agent 的 lane 谓词（求值发生在落判当刻——§0 决策点
            // 重验天然满足）。谓词为空 ⇒ 不 spawn，按与 fire 同型的节律推进 due（[gated]
            // 求值频率 = 0.5.0 的 fire 频率，无额外扫描面）。
            const g = this.evalGate(agent);
            if (this.args.once) {
              // --once = 操作者显式要求「每 agent 恰好跑一轮」（Fix 轮 1 裁定口径）——门控
              // 只诊断不拦截：逐 agent 打印求值结果后无条件 launch（cron 式 --once 部署的
              // 点火绝不被静默吞掉）；连续模式语义不变。
              console.log(`[gate] ${agent}：${g.open ? `open —— ${g.reasons.join("；")}` : "lane 谓词为空（--once 显式点火 —— 照 fire，仅诊断）"}`);
              this.launch(agent, g);
              continue;
            }
            if (!g.open) {
              const n = (this.gatedCount.get(agent) ?? 0) + 1;
              this.gatedCount.set(agent, n);
              console.log(`[${utcIso()}] [gated] ${agent}：lane 谓词为空 —— 不 spawn（自上一条账本记录起第 ${n} 次）`);
              due.set(agent, mono() + this.sched.agents[agent].intervalSeconds);
              continue;
            }
            this.launch(agent, g);
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
    console.log(`wl-run --dry-run: 项目 ${this.key} · cli=${this.sched.cli} · promptMode=${this.sched.promptMode}${this.sched.laneGating ? " · laneGating=on" : ""} —— 只打印将起的命令，不 spawn、不写 ledger、不拿锁`);
    if (this.sched.trimNote) console.log(`trim: ${this.sched.trimNote}`); // fire 减肥注入/降级如实注明
    if (this.sched.laneGating) this.seedLastCleanFromLedger(); // 门控求值全程只读（不写 ledger/不拿锁承诺不破）
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
        const gap = providerAuthGap(this.providers, this.sched.cli, model);
        if (gap) {
          console.log(`  note: provider '${gap.prefix}' 认证环境变量 ${gap.authTokenEnv} 不可解析 —— 真实 fire 会预检失败（doctor 会体检此项）`);
        }
      }
      if (this.sched.laneGating) {
        // 门控照算并逐 agent 打印谓词求值结果（可观测性承诺；求值零写副作用）
        const g = this.evalGate(agent);
        console.log(`  gate: ${g.open ? `open —— ${g.reasons.join("；")}` : "lane 谓词为空（本 fire 将被 gated，不 spawn）"}`);
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

    const project = ws.config.projects![key];
    const sched = buildSched(ws.config, key, project);
    if (args.cli) sched.cli = args.cli; // 顶层 flag 压过两层 config（--dry-run/--plan 亦如实反映）
    // fire 减肥解析恰在 --cli 覆盖之后（车道已定）；--plan 是纯排程模拟（不渲染命令），
    // 不必为它探 claude --help。
    if (args.plan === null) resolveTrimPlugins(sched);
    // provider 注册表：workspace 顶层，与 --cli 覆盖无关（哪条车道都可能引用它），故不
    // 挂在 --plan 门槛后——纯内存校验零 I/O，即使 --plan 也值得早早校验暴露配置错误。
    const providers = parseProviders(ws.config);

    let root: string | null = null;
    try { root = pluginRoot(); } catch { root = null; } // slash 模式用不到；inline/锁助手缺根时各自兜底

    const s = new Scheduler(args, wsRoot, dataRootOf(wsRoot), key, repoPath, sched, root, project, providers);
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
