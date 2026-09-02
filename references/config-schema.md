# 配置 schema（config-schema）

> writing-loop 的 workspace 索引与项目配置。权威运行时状态（board/lessons/reports）一律在
> **workspace 根下的 `.writing-loop/`**（workspace-rooted 布局，§11），是各剧本 repo
> **之外**的兄弟目录——**永不进剧本 repo** 的 git 历史。复制整个 workspace 文件夹即
> 整体迁移（含在制工单）。唯一例外是可重建、非权威的本机 workspace registry 指针。

## Workspace 根解析（§11）

`.writing-loop/` 所在的目录 = workspace 根。默认从 CWD 向上逐级找已存在的
`.writing-loop/`（像 git 找 `.git`），首个命中的父目录即根。找不到 ⇒ 未在 workspace
内，请先 `writing-loop init`，再由 Studio 或 `add-script` 立项。显式逃生门 env
`WRITING_LOOP_WORKSPACE` 必须是绝对路径且其下真含 `.writing-loop/`；它优先于走查，
坏值硬错，绝不静默降级（与 README、`hub/src/workspace.ts` 同口径）。

这条普通 CLI 根解析**不查询**下述本机 registry：agent/scheduler/status 等命令的上下文仍由
CWD 或显式 `WRITING_LOOP_WORKSPACE` 决定，不会因为本机曾登记多个 workspace 就猜一个。

## 稳定 workspace identity — `<workspace>/.writing-loop/workspace.json`

每个 workspace 自己持有一个不可变、不透明的 v1 ID；它给 ActivityIndexer cursor 与 Studio
命名空间提供稳定作用域，不取 title、路径或 config 内容的 hash：

```json
{ "version": 1, "id": "ws_0123456789abcdef0123456789abcdef" }
```

- `id` 必须完整匹配 `/^ws_[a-f0-9]{32}$/`。`writing-loop init` / `workspace add` 首次以
  16 个随机 bytes 建立，之后只校验和回读，不重新生成。
- schema 严格拒绝未知字段；文件上限 8 KiB，必须是单链接普通文件，拒绝 symlink、hardlink、
  FIFO 与 device。创建使用独立 `workspace.json.lock`（O_EXCL）、0600 临时文件、file fsync、
  atomic rename 与 directory fsync。
- 复制整个 workspace 会连同 identity 一起复制。这适合“移动”（旧 root 已消失时 registry 可
  自愈指针），但不能把原件与副本同时当作两个 workspace 登记；两个现存 root 持同一 ID 会
  保守硬停，操作者必须明确决定哪个才是该 identity。

## 本机 workspace registry — `$WRITING_LOOP_HOME/workspaces.json`

registry 只保存 `ID → canonical root` 便利指针，**不复制 config、看板或剧本文档，也不成为
任何项目真相源**。`WRITING_LOOP_HOME` 缺省为 `~/.writing-loop`；若设置必须是绝对路径。

```jsonc
{
  "version": 1,
  "workspaces": [
    {
      "id": "ws_0123456789abcdef0123456789abcdef",
      "root": "/absolute/canonical/path/to/my-dramas",
      "label": "古装短剧"                       // 可选，1–256 字符
    }
  ]
}
```

- v1 最多 128 项，registry 文件最多 256 KiB；ID 与 canonical absolute root 均不得重复，
  未知字段一律拒绝。安全读写与 identity 同样拒绝链接/特殊文件，并使用独立
  `workspaces.json.lock` + fsync/atomic rename；损坏文件绝不被静默覆盖。
- `writing-loop workspace list [--json]` 是诊断读面：registry 本身报告
  `ok|missing|corrupt`，每条指针隔离报告 `ok|missing|corrupt`，单条坏指针不会掩盖其他项。
- `writing-loop workspace add [DIR] [--label L]` 规范化 root、确保 identity、登记或更新指针。
  只有同 ID 的旧 root 已不存在时才把它视为移动并自愈；两个现存 root 或同 root 的不同 ID
  都硬错。
- `writing-loop workspace remove ID` **只删除本机指针**，绝不删除 root、
  `.writing-loop/workspace.json`、项目或任何剧本文件。
- `writing-loop init` 会 best-effort register；本机 registry 损坏/锁冲突只产生告警，不把已成功
  创建 workspace 骨架的 init 反转。
- `writing-loop doctor` 对这两层保持只读：旧 workspace 缓缺 identity 为 `W12`，registry
  未建/未登记/含 degraded 指针为 `W13`，都不阻断单 workspace 创作；已存在但损坏的 identity、
  损坏 registry 或非法相对 `WRITING_LOOP_HOME` 是结构失败。doctor 不创建 home/identity/
  registry，也不拿或清理它们的锁。

Studio 可用 `--workspace ws_…` 明确选择健康登记项；登记项多于一个且未传 `--single` 时进入
multi-workspace fleet 模式，missing/corrupt root 在总台逐卡降级显示。registry 仍不参与普通
CLI 的根解析。

## workspace 索引 — `<workspace>/.writing-loop/config.json`

`projects` 的 key 是运行态目录名，必须完整匹配
`/^[a-z0-9][a-z0-9._-]{0,31}$/`（1–32 位小写 ASCII；不可含斜杠、空格或换行）。旧配置
若不满足，`writing-loop doctor` 会给出阻断错误与迁移提示，scheduler/status 不会接触其路径。

```jsonc
{
  "version": 1,
  "projects": {
    "shen-shou-park": {                    // project key（须满足上方严格 pattern）
      "title": "女儿被抓去神兽公园，我觉醒神脉杀疯了",
      "repoPath": "shen-shou-park",        // 剧本 repo：默认【相对 workspace 根】（copy 即迁移）；
                                           //   绝对路径仍允许，但该项目将失去随 workspace 复制的可迁移性
      "backend": "local",                  // v1 仅 local（§18 文件板协议）
      "ticketPrefix": "WL",                // 板 ID 前缀；counter.json 的 hint
      "mode": "live",                      // live | dry-run（dry-run 不写板不 commit）
      "enabled": true,

      // —— 创作规格（north-star/outline 的机读镜像，agent boot 时读） ——
      "format": "live-action",             // live-action | ai-anime | reelshort-en（script-format §3 参数表；
                                           //   ai-anime 使用单列的制作层预算表——特效近乎免费是形态优势）
      "monetization": "paid-app",          // paid-app | free-hongguo | reelshort-sub —— 一级开关：
                                           //   free-hongguo：一卡门→前30集完播门，卡点断言→留存钩断言，
                                           //   rubric 付费转化项换成完播/留存；reelshort-sub：卡点平缓、打脸收敛
      "genre": "revenge-slap",             // genre profile key（craft-rules 附录 A；决定 R1-R6 数值参数集。
                                           //   v1 已校准：brain-hole | revenge-slap | profession-unit；
                                           //   女频 sweet-pet/angst 为 UNCALIBRATED——add-script 立项时显式警告）
      "audience": "男性 25-45 下沉市场付费用户",   // 非空且含性别+年龄（红线①入口预防）
      "seasonStrategy": "multi-season",     // single-season | multi-season | undecided
      "currentSeason": 1,                    // 当前开发季；单季项目恒为 1
      "totalEpisodes": 80,                   // 当前季集数，不是多季项目的全剧总集数
      "paywall": {                         // 备卡制（R4.5 参数从这里读，不写死 9-11）
        "card1": [9, 10, 11],
        "card2": [26, 28, 30],
        "card3": [60]
      },
      "airedThrough": 0,                   // 已投放水位：ep≤此值的修订票机械转型为「前向修补」或 human-park，
                                           //   禁止追溯改已投放正文及其账本记录
      "episodeWordBand": [900, 1300],      // 按 format profile 默认，可覆盖
      "maxNamedCharacters": 20,            // story design 制作约束的上限来源
      "maxPrimaryScenes": 5,
      "assetLibrary": null,                // 公司 AI 资产库清单路径（或 null=无）——rubric 资产复用度的打分输入
      "marketDataPath": null,              // 操作者投喂的市场数据目录（榜单快照/政策摘要）；market-watch 优先读取
      "contextPack": {                     // 可缺省。`writing-loop story context` 的字节预算配置口（WLSYS-3685fbc /
        "maxBytes": 98304,                 //   ef70be05 / 78ca9e8e ②）：4096–262144 的整数，缺省 65536（64 KiB）。
        "perAgent": { "reviewer": 131072 } //   perAgent 按车道覆盖（键 = 十个 agent 名）。优先序：--max-bytes flag >
      },                                   //   perAgent[agent] > maxBytes > 内建默认。越界/未知字段报错，不静默回落。
                                          //   预算是审读门看得见的东西：改它 = 每集必载闭包上限变化，按 §12a 属操作者决定

      // —— 流程旋钮 ——
      "intake": {
        "mode": "autonomous",              // autonomous | passive（§5a：passive=纯用户驱动创作）
        "todoDepthCap": 10                 // 注意：episode 创作子票不计入深度（节流由顺序 pick 约束承担）
      },
      "comms": {                           // human-park / 一卡门操作者决策点的带外通知（照搬 dev-loop §9 notify）
        "provider": null,                  // "slack" | "lark" | null（null=仅 daily digest 的 needs-attention 节）
        "webhookEnv": null                 // 存 webhook 的环境变量名——config 本身不放秘密
      },
      // 注：keystone 集不在 config 配置——由 conventions §21a 硬规则决定
      //   （前3集 + 各卡点集±1 + 深谷集 + 终局3集 + 改编项目 S 级名场面集）

      // —— Codex 可选加速器（§24；缺块或 enabled:false ⇒ 100% 不变） ——
      "codex": {
        "enabled": false,                  // 且需 codex CLI 在 PATH；任一为假 ⇒ 优雅降级不用 Codex
        "imageGen": false,                 // §24a：story-designer 把 bible 视觉 token → 概念图
        "review": false,                   // §24b：reviewer/script-doctor 的异构第二引擎只读复审
        "assetsDir": "assets/concept/",    // 概念图落盘目录（剧本 repo 内，相对 repoPath）
        "model": null,                     // 传给 codex exec 的 --model（null=Codex 默认）
        "effort": null                     // 传给 codex exec 的 effort（null=Codex 默认）
      },

      // —— agent 档位覆盖（默认见 conventions 拓扑表；CLI 无关，Claude/Codex 名见拓扑表下映射） ——
      "models":  { "source-analyst": "sonnet", "episode-writer": "sonnet" },
      "efforts": { "showrunner": "max", "source-analyst": "high", "story-designer": "max" }
    }
  }
}
```

多项目语义（§11）：`enabled:false` 的项目对**一切 agent 不可见**（探针与 boot 都跳过
它）——这是操作者暂停一部剧的开关；多项目 workspace 时每 fire 恰选**一个**项目，
定位规则见 conventions §11（CWD 在某 repoPath 内 ⇒ 该项目；否则恰一个 enabled ⇒
该项目；否则问操作者，绝不猜、绝不遍历）。

## providers — 自定义 OpenAI-compatible 端点注册表（opencode 专用）

`config.json` **顶层** `providers` 块（与 `scheduler`/`projects` 同级）是这个 workspace 里
一切剧本项目共享的**端点基础设施**——`projects.*` 只**选择**某个已注册端点的某个 model
（`scheduler.agents.<agent>.model` 写成 `"<provider-id>/<model>"` 形），不在项目层再定义
端点。只有 `scheduler.cli:"opencode"` 车道会用到它（claude/codex 车道无 provider/model
启动串机制，本块对它们无效）。缺省 = 无此键（等价空注册表，一切下游优雅退化为 no-op）。

```jsonc
{
  "version": 1,
  "providers": {
    "synthetic": {                          // provider id：同时是 opencode provider key
                                            //   与 agents{}.model 的 "<id>/<model>" 前缀
      "kind": "openai-compatible",          // 目前唯一合法值
      "baseUrl": "https://api.synthetic.new/v1",   // 必须匹配 /^https?:\/\//
      "authTokenEnv": "SYNTHETIC_API_KEY",  // 环境变量【名字】——config 里永远不放密钥值；
                                            //   doctor W09 只查该变量是否可解析，绝不打印其值
      "models": ["hf:deepseek-ai/DeepSeek-V3.2", "hf:moonshotai/Kimi-K2-Instruct"],
      "effortMode": "strip",                // "passthrough"（默认）| "strip"
      "extraOptions": {}                    // 可选，透传进渲染出的 opencode provider options
    }
  },
  "projects": {
    "shen-shou-park": {
      "scheduler": {
        "cli": "opencode",
        "agents": {
          "episode-writer": { "model": "synthetic/hf:deepseek-ai/DeepSeek-V3.2" }
        }
      }
      /* … 其余项目字段见上节 … */
    }
  }
}
```

字段（`providers.<id>`）：
- `id`（key）：`/^[a-z0-9][a-z0-9._-]{0,31}$/`，小写。
- `kind`：`"openai-compatible"`（唯一合法值）。
- `baseUrl`：`/^https?:\/\//`。
- `authTokenEnv`：`/^[A-Z][A-Z0-9_]*$/`——环境变量**名字**，不能含 `://`（防止把 URL/
  密钥值误当名字填进去）；实际密钥只从 `process.env[authTokenEnv]` 读，config.json 本身
  绝不出现密钥值。
- `models`：非空字符串数组（每个元素非空）。
- `extraOptions`（可选）：对象，透传进渲染出的 opencode provider `options`；**不得**含
  `baseURL`/`baseUrl`/`apiKey`（端点走顶层 `baseUrl`、认证走 `authTokenEnv`——apiKey 恒
  渲染为 `{env:VAR}` 间接引用）。校验层只拦这三个保留键；其余内容**原样**写进
  opencode.json——所以绝不要把密钥值放进 extraOptions 的任何角落（如
  `headers.Authorization`），认证一律走 `authTokenEnv` 环境变量间接引用。
- `effortMode`（可选）：`"passthrough"`（默认）| `"strip"`。`strip` = 该 provider 的
  opencode fire **整个省略 `--variant`**——留给不认 variant 值的端点当逃生口（否则这类
  端点每 fire 必错）；`passthrough` = effort 照传 `--variant`。
- 未知字段一律拒绝；`providers` 若存在必须是对象（非数组）。

`writing-loop sync-opencode` 把这个注册表渲染进 `<workspace-root>/opencode.json`
（create-or-merge：新建/合并/原地更新，注册表之外的手写 provider 与其余顶层键绝不
触碰；绝不碰 `~/.config/opencode/opencode.json` 全局配置）。改了 `providers` 块后手动
跑一次该命令，再 `writing-loop doctor` 复核——doctor 对 providers 的体检不带独立编号
体系，warn 文案本身自解释：某条目的 `authTokenEnv` 环境变量不可解析（**未设置或已设置
但为空串**都算——其 opencode fire 会预检失败）、或 `opencode.json` 与本注册表有漂移
（缺失/未同步/过期，提示运行 `sync-opencode`）。两者都只读，不会自动帮你改文件；
`writing-loop run` 启动时也做同一漂移检查（只警不拦）。

注册表非空时，每个 opencode fire 的 spawn env 都带
`OPENCODE_CONFIG=<workspace-root>/opencode.json` 显式指路——不指不行：opencode 的项目级
config 发现 findUp 止步于 cwd 的 git 根，而 fire 的 cwd=repoPath 本身就是 git repo，
workspace 根的同步产物否则对 fire 不可见（sync/doctor 全绿也白搭）。

## 内建调度器 — `scheduler` 块（`writing-loop run`）

`writing-loop run` 是随 npm 包 `@dyzsasd/writing-loop` 分发的单进程调度器（原生
TypeScript，零运行时依赖；Node ≥ 20.11）：一条命令驱动一个项目的
全部 agent 循环，取代外部 tmux/cron launcher 与宿主 CLI 的 /loop。它按构造恢复 §15.6
「同一时刻至多一个 fire 在写 repo」的前提——**写 repo 四角色（showrunner /
story-designer / episode-writer / evaluator，§15.6 逐字列举的 stage+commit 主体）全局
单飞**；板上角色（reviewer / sweep / script-doctor / market-watch / reflect，从不向剧本
repo 落 commit）可与写者并发、彼此至多 2 路。故调度器驱动下共享 checkout + repo.lock
的默认轨道恒为合规，不必 worktree。§0 探针语义不变：调度器只决定「何时 spawn」，
探针仍在 spawn 后决定「能否廉价退出」——0.6.0 起「何时 spawn」含门控层（`laneGating`，
见下）：spawn 前先跑廉价车道谓词，判「确无活」的 agent 本 tick 不起进程，agent 侧
§0 探针保留作双保险。

配置在 config.json **顶层** `scheduler` 块（workspace 级），`projects.<key>.scheduler`
同形覆盖。全部字段可缺省——内建默认即实战 launcher 的 SPECS 参数表：

```jsonc
{
  "version": 1,
  "scheduler": {                          // workspace 级；projects.<key>.scheduler 同形覆盖
    "cli": "claude",                      // "claude" | "codex" | "opencode" —— fire 命令模板
                                          //   （优先级：writing-loop run --cli flag > 项目 scheduler.cli > workspace
                                          //   scheduler.cli > 默认 "claude"）：
                                          //   claude: claude -p "/writing-loop:<agent>-agent" --model M
                                          //           [--effort E] --dangerously-skip-permissions
                                          //           --add-dir <workspace>/.writing-loop   （cwd=repoPath）
                                          //   codex : codex exec -C <repoPath> --dangerously-bypass-approvals-and-sandbox
                                          //           --skip-git-repo-check --model M -c model_reasoning_effort="E"
                                          //           "/writing-loop:<agent>-agent"（档位名自动按拓扑一览映射表换算）
                                          //   opencode: opencode run [-m provider/model] [--variant E] <内联 prompt>
                                          //           （cwd=repoPath；env 注入 OPENCODE_PERMISSION，见 opencodePermission；
                                          //           -m 仅当 model 含 "/"——Claude 档位名绝不透传，省略 -m 落
                                          //           opencode 自身默认模型；prompt 恒为内联 SKILL 全文，§25）
    "promptMode": "slash",                // "slash"(默认) | "inline" —— claude/codex 车道的 prompt 传输：
                                          //   slash  = 斜杠命令 "/writing-loop:<agent>-agent"（0.4.0 原行为，逐字节一致）
                                          //   inline = 读 <插件根>/skills/<agent>-agent/SKILL.md 原文（去 YAML
                                          //            frontmatter、${CLAUDE_PLUGIN_ROOT} 字面替换为插件根绝对路径、
                                          //            前置调度器上下文头）整体作 prompt。
                                          //   opencode 无插件机制 ⇒ 恒 inline，本旋钮对它无效
    "opencodeHermetic": true,             // fire 密闭（默认 true）：XDG_CONFIG_HOME 指向
                                          //   <workspace>/.writing-loop/opencode-xdg 空目录 ⇒ 操作者
                                          //   ~/.config/opencode 的全局插件/provider/agent 一概不进 fire
                                          //   （防全局 agent 插件在无头 fire 内卡死烧 cap）。OPENCODE_CONFIG
                                          //   显式路径与 XDG_DATA 认证不受影响。false = fire 沿用全局配置。
    "opencodePermission": null,           // cli=opencode 时注入 env OPENCODE_PERMISSION 的整对象覆盖
                                          //   （null=内建默认；覆盖是整对象替换、不深合并）。内建默认：
                                          //   {"*":"deny","read":"allow","edit":"allow","glob":"allow","grep":"allow",
                                          //    "bash":"allow","task":"allow","skill":"allow","lsp":"allow",
                                          //    "external_directory":"allow","webfetch":"allow","websearch":"allow",
                                          //    "question":"deny","doom_loop":"deny"}
                                          //   相对 dev-loop 认证集三处放行：external_directory——板是 repo 外
                                          //   兄弟目录（§11），等价 claude 车道的 --add-dir；webfetch/websearch——
                                          //   market-watch 建立/显式刷新市场基线需要出网。其余逐字沿用 dev-loop 认证集
    "laneGating": true,                   // 0.6.0 调度器门控层（work-gated dispatch）总开关——操作者
                                          //   2026-07-19 裁定①「no-op 判定移到调度器」的实装：每次到点起
                                          //   fire 前按该 agent SKILL §0 的 lane 谓词做纯函数求值（板
                                          //   frontmatter 快照 + state 目录文件 + north-star 哈希 + repo
                                          //   HEAD，零 LLM、不起进程）。谓词为空 ⇒ 本 tick 不 spawn：打一行
                                          //   [gated]（不写 fires.jsonl，防账本膨胀），按同款间隔节律下次
                                          //   再算；该 agent 下一条 fires.jsonl 记录附 gatedSinceLast 结清
                                          //   计数——52% no-op fire 的 boot 上下文税在源头省掉。**单向安全
                                          //   铁律**：谓词必须是保守超集——宁假 spawn（白跑一次 boot），
                                          //   绝不假跳过（有活漏跑）；每个谓词并入对应 skill §0 的全部
                                          //   逃逸口（needs-\*/孤儿/报告结算/doc-watch）。agent 侧 §0 探针
                                          //   保留作双保险（门控是其外层实装）。--once = 操作者显式点火 ⇒
                                          //   绕过拦截照 fire（[gate] 逐 agent 求值行仅诊断）；--dry-run 下
                                          //   门控照算并逐 agent 打印求值结果。false ⇒ 关闭门控，恒 spawn
                                          //   （回退 0.5.0 行为）。**state 键名契约**（agent 写、门控读，
                                          //   两侧必须同名——键名对不上 = 门恒开、每 tick 白 boot）：
                                          //   reviewer-state.json.lastAuditedSha（Job C change-gate 基点；
                                          //   旧 lastAuditSha/lastAuditedEpisodesSha 仅作 fallback）、
                                          //   doctor-state.json.lastAuditSha、reflect-state.json.lastRetro、
                                          //   market-state.json.lastRun
    "trimFirePlugins": true,              // fire 系统面减肥（仅 cli=claude 车道生效）：每 fire 追加
                                          //   --settings '{"enabledPlugins":{…}}'——仅 writing-loop 插件保持
                                          //   启用，其余插件逐一置 false（清单**动态**读自 ~/.claude/
                                          //   settings.json 的 enabledPlugins，绝不写死），省掉无关插件的
                                          //   skill/命令面上下文税。降级链（任一不满足 ⇒ 不加 flag，fire
                                          //   照旧起，--dry-run 的 trim: 行注明原因）：config 关闭 →
                                          //   enabledPlugins 读不到 → 本机 claude 无 --settings flag。
                                          //   实测认证（claude 2.1.215）：`claude -p` 接受 --settings JSON 串，
                                          //   注入后 /writing-loop: 斜杠命令照常解析、其余插件命令面确实
                                          //   消失；doctor W08 预检同一降级链
    "graceSeconds": 30,                   // Ctrl-C / --for 到点后等 in-flight 收尾的宽限；超时 TERM→KILL
    "keystoneReviewer": {                 // keystone 升档档位（拓扑一览 keystone-stall 护栏的 launcher 分支）：
      "model": "opus", "effort": "max"    //   起 reviewer 前 glob 板，∃ In Review 且（labels∋keystone ∨ 票面机读行
    },                                    //   `Mode: direct-write`）⇒ 该 fire 用此档（direct-write 升级重写票由
                                          //   story-designer 顶配亲写，§21a-gate 要求审读档 ≥ 创作档，WLSYS-95eb134a）。
                                          //   advisory 选档——floor 判定仍归 reviewer 本体
    "agents": {                           // 每 agent 一块；全部字段可缺省。默认 = 0.6.0 SPECS 参数表
                                          //   （操作者 T1/T3 裁定：门控上线后间隔全面放宽；写作用小模型、
                                          //   设计/建票用大模型；cap/stagger 与 0.4.0/0.5.0 逐格不变）：
                                          //   showrunner     opus/max    600s   cap 3600  stagger 0
                                          //   story-designer opus/max    300s   cap 3600  stagger 10
                                          //   episode-writer sonnet/high 180s   cap 2400  stagger 20
                                          //   reviewer       opus/high   300s   cap 2400  stagger 30
                                          //     （reviewer 默认档回落 opus/high——顶配场景由 keystone 升档
                                          //     机制承担：keystoneReviewer 默认 opus/max 不变）
                                          //   evaluator      opus/xhigh  600s   cap 2400  stagger 40
                                          //   sweep          sonnet/high 1800s  cap 1200  stagger 50
                                          //   script-doctor  opus/xhigh  7200s  cap 2400  stagger 60
                                          //   market-watch   sonnet/high 300s   cap 1200  stagger 70
                                          //     （5min 仅为本地 milestone gate 响应延迟；基线完成且无
                                          //      market Ticket/新投喂时零 LLM spawn）
                                          //   reflect        opus/xhigh  14400s cap 2400  stagger 80
      "episode-writer": {
        "model": "sonnet",                // 档位取值优先序（低→高）：SPECS 默认 < workspace scheduler
                                          //   < 项目 models/efforts 映射 < 项目 scheduler。
                                          //   cli=opencode 时取 provider/model 形（含 "/"，如 "openrouter/…"）——
                                          //   Claude 档位名（opus/sonnet…）绝不透传 opencode（省略 -m 落其默认）
        "effort": "high",                 //   effort：codex 换算 reasoning effort（GPT-5.6 保留 max）；
                                          //   opencode 原样传 --variant（不换算）
        "intervalSeconds": 180,           // 上一 fire 结束 → 下一 fire 开始的间隔（非固定频率）。
                                          //   sweep 特例：显式改小它会同步收紧兜底节拍
                                          //   （cadence = min(显式 interval, 120min)；默认档不参与，
                                          //   兜底节拍即 120min——2026-08-20 裁定）
        "capSeconds": 2400,               // 每 fire 墙钟上限；超时 TERM→KILL 并记 timedOut
        "enabled": true,                  // false ⇒ 调度器不驱动该 agent（探针语义不受影响）
        "staggerSeconds": 20              // 首 fire 错峰延迟（对齐 SPECS；--once 下忽略）
        // "command": ["…", "{model}"]    // 高级/测试接缝：整条命令覆盖（数组 argv；
        //                                //   可用占位 {skill} {model} {effort} {repo} {data} {agent}）
      }
    }
  },
  "projects": { /* … 见上节 … */ }
}
```

CLI 面：`writing-loop run [--project K] [--once] [--dry-run] [--plan N] [--agents a,b]
[--for S] [--cli claude|codex|opencode]`。`--cli` 覆盖引擎（优先级：flag > 项目
scheduler.cli > workspace scheduler.cli > 默认 "claude"）。`--dry-run` 打印每条将起命令的完整解析（model/effort/cwd/env），零
spawn、零写、不拿锁；`--plan N` 模拟打印未来 N 个 fire 的排程；`--once` 每 agent 恰好
一 fire（操作者显式点火——绕过 laneGating 拦截，`[gate]` 逐 agent 求值行仅诊断）；
`--for S` 跑 S 秒后优雅停止；Ctrl-C = 优雅停（宽限收尾，再按立即杀）。

Harness 契约只有 `claude | codex | opencode` 三个一级 ID；其他 `--cli` 值会在 spawn 前
拒绝。`agents.<name>.command` 只是逐 agent argv 逃生口，不会把 Gemini/Kimi 等命令提升为
经过 prompt、模型、认证、权限和遥测契约测试的第四种 Harness。`providers{}` 仍只服务
OpenCode。完整矩阵见 [`docs/HARNESS.zh-CN.md`](../docs/HARNESS.zh-CN.md)。这些 Harness
负责剧本写作；ComfyUI/H3/GPU 是独立的镜头制作执行层。

运行时产物（都在项目数据目录）：**遥测账本 `fires.jsonl`**——每 fire 追加一行
`{agent, model, effort, startedAt, endedAt, durationSeconds, exitCode, timedOut, noop,
keystoneEscalated, descendantDrain?}`；`descendantDrain:true` 表示 CLI leader 已退但同
PGID 工具进程仍在，调度器已 TERM→KILL 整组；该 fire 不计成功。`noop` 从 fire 输出的尾行「no-op」标记检出（§0 廉价探针的一行
收尾）；laneGating 开启时，若该 agent 自上一条记录起有被门控跳过的排程点，下一条记录
追加 `gatedSinceLast: <次数>` 结清（被 gated 的排程点本身不写行，防账本膨胀）；
时间戳一律取调度器自己的时钟（UTC）——agent 的自述时间不可信，墙钟谓词
（§7 陈旧判据、§9 24h 重提醒类）以此账本与文件 mtime 为可信时间源。fire 全量输出落
`logs/`。**防重跑锁 `wl-run.lock`**（锁名/路径为 0.4.0 连续性保留）：`scripts/board-lock.sh`
choreography（O_EXCL 独占创建、>60min 陈旧强清，§18）；另一调度器进程在位 ⇒ 拒绝启动；运行中每 30s touch 心跳，
活进程永不因陈旧被抢，崩溃残锁 60min 后自动回收。

## token 账单（每-agent 每-fire 上下文税的度量面）

`python3 scripts/context-bill.py` —— 打印各 agent 单次 fire 的强制读取账单（SKILL 全文 +
conventions 所引节 span + boot 强制姊妹参考 + lessons 上限，含 ~tokens 估算）的 markdown
表，可直接 `>> $GITHUB_STEP_SUMMARY`；调 SPECS 档位、裁 `Sections:`、开关 laneGating /
trimFirePlugins 前后各跑一次，即得省了多少的可比数字。

## npm CLI（`writing-loop` 命令）— `@dyzsasd/writing-loop`

`npm i -g @dyzsasd/writing-loop` 安装同名 CLI（零运行时依赖；Node ≥ 20.11）。命令面：

- `writing-loop init` —— 引导确立 workspace（创建 `.writing-loop/` + config.json 骨架、确保
  `workspace.json` identity 并 best-effort 登记本机指针；立项采访走 Studio 或
  `/writing-loop:add-script`）。
- `writing-loop run` —— **上节内建调度器的本体**（原生 TS 实现在包内，无 Python 依赖）：
  语义与上节完全一致，全部 flag（`--dry-run`/`--once`/`--cli` …）见上节 CLI 面。
- `writing-loop status` —— 只读打印各项目板状态摘要（frontmatter 统计，不拿锁）。
- `writing-loop snapshot [--project K]` —— 输出包含暂停项目、剧本资产、任务、遥测与实时
  Agent 的稳定 JSON 投影；Studio 与外部编排都消费这一个 DTO。
- `writing-loop studio [--workspace ID] [--single]`（别名 `ui`）—— 在 `127.0.0.1:8791`
  启动本地编剧工作台；只允许 loopback Host。`--workspace` 选定本机 registry 中的稳定 ID；
  `--single` 即使有多个登记项也强制旧单 workspace 模式。写面只有安全启停与下节的 attended
  plan-confirm-create 立项，二者都复用共享 core，不接受任意文件写入。
- `writing-loop workspace list [--json] | add [DIR] [--label L] | remove ID` —— 管理本机
  非权威指针；remove 绝不删除 workspace 或 identity。普通 CLI 根解析不读本索引。
- `writing-loop project list|enable|disable` —— 项目清单与安全启停。运行中的 scheduler
  每秒复核 `enabled`；切到 false 会立即停止新派发并进入 graceful drain。
- `writing-loop project plan --input request.json` —— 规范化并校验完整 interview 输入，输出
  确定性、**零写入**的计划 JSON 与 `planId`；`--input -` 可从 stdin 读取。
- `writing-loop project create --input request.json --confirm PLAN_ID [--json]` —— 用同一输入
  重算计划；指纹、config 或模板有漂移就拒绝。匹配时以 durable journal 原子预留 final repo/运行态并创建，
  再经配置锁发布 config，最后执行写后验证。崩溃前若 config 尚未发布，同输入+同 `planId` 重试
  恢复；发布后的成功响应丢失则由 receipt 幂等回读。
- `writing-loop project verify KEY [--json]` —— 独立回读 config 条目、repo scaffold、Git HEAD、
  合规首张 outline 票与运行态骨架；任一失败退出 1。Studio 的 create 也调用同一验证 core。
- `writing-loop doctor` —— 环境自检：所选引擎 CLI 在位、config 可解析、残锁检测。
- `writing-loop fires` —— `fires.jsonl` 遥测账本的摘要视图。
- `writing-loop install-claude-plugin` —— 把 npm 包内的插件注册为本地 marketplace 源并装进
  Claude Code（版本钉住 CLI 自身版本）。

### 立项 request、plan 与确认指纹

CLI 的 `plan` / `create` 使用**同一份 request**，不是把 plan JSON 再喂给 create。Studio 的
表单收集同一 schema。原创示例（未列字段不能用占位值蒙混；默认值见命令输出）：

```jsonc
{
  "key": "paper-moon",
  "title": "纸月亮",
  "repoPath": "paper-moon",                 // Studio 仅接受 workspace 内、尚不存在的相对路径
  "kind": "original",                       // original | adaptation
  "logline": "她必须在十二集前揭穿伪造的家族身份。",
  "audience": "女性 25-40 岁，都市悬疑付费用户",
  "complianceNotes": "已预筛涉政、涉案、婚恋伦理与平台边界。",
  "nonGoals": ["不美化违法", "不借壳其他 IP"],
  "genre": "revenge-slap",
  "monetization": "paid-app",
  "format": "live-action",
  "seasonStrategy": "single-season",
  "currentSeason": 1,
  "totalEpisodes": 80,
  "paywall": { "card1": [9, 10, 11], "card2": [26, 28, 30], "card3": [60] },
  "episodeWordBand": [900, 1300],
  "maxPrimaryScenes": 5,
  "maxNamedCharacters": 20,
  "ticketPrefix": "PM",
  "intakeMode": "autonomous",
  "mode": "live",
  "assetLibrary": null,
  "marketDataPath": null,
  "comparables": "同类爆款 A / B",
  "differentiation": "身份证据链由女主主动反转"
}
```

改编项目不带 `comparables` / `differentiation`，而使用：

```jsonc
"adaptation": {
  "sourceTitle": "原著名",
  "sourcePath": "/workspace/原著.txt",       // workspace 内、剧本 repo 外
  "adaptationBrief": "整体开发建议、核心钩子、重构边界与季目标……",
  "rightsScope": "已确认的内部开发/改编权范围",
  "processingConsent": {
    "allowedHarnesses": ["claude"],
    "rawNovelContentMayBeSent": true,
    "confirmedAt": "2026-08-11T12:00:00.000Z"
  },
  "compressionRatio": 10,                   // v1 core 内部分析目标，不是操作者拆书答案
  "highlightCount": 3,
  "namedCharacterCount": 18,
  "riskAcknowledged": false
}
```

Studio 与 `add-script` 只向操作者询问原著、改编建议、权利和 Harness 同意；三项兼容阈值由
onboarding core 依据安全默认与制作上限生成，不能让操作者把尚未分析的结果填进表单。高级 CLI
仍可显式覆盖；风险阈值未满足时必须 `riskAcknowledged:true`。`planId` 是 SHA-256 派生的稳定
确认指纹，绑定规范化 request、原著 bytes 与分块、
解析后的 workspace/repo/data 路径、将写入的项目条目和首票 ID、当前 config 原始内容摘要、
模板摘要与实现版本。`plan` 不建目录、不拿配置锁、不写 report；操作者应审阅路径、规格、文件
清单和 warnings 后才把显示的 `planId` 交给 create。

create 先取得每 key lease，以原子 `mkdir` 预留不存在的 final repo/data 名称，并在
`<workspace>/.writing-loop/.onboarding-transactions/<key>.json` durable journal 记录
`prepared → repo-staged → data-staged → repo-promoted → data-promoted`。状态名为兼容协议；
promoted 现在表示完整性检查点，不是 staging rename。repo/data 产物带事务所有权标记；
config 的 atomic replace 始终最后发生，是项目对 snapshot/scheduler 可见的提交。
可捕获异常会逆序回滚并只删除完整摘要能证明属于本事务的产物；真实崩溃保留 journal、final/旧 staging
产物和证据。

恢复不是独立后台 worker：操作者须用**完全相同的规范化 request + 原 `planId`**重跑 create。
core 只在 config/template/实现版本摘要未变时接管，并验证 marker、repo 仍是 plan 对应的干净
单 commit/精确 tracked set，以及 project-data 完整树的有界 SHA-256 manifest 与 receipt。
manifest 按排序后的相对路径编码目录/普通文件类型与完整文件 bytes，预算为最多 2,048 files、
单文件 4 MiB、总计 32 MiB；内容修改、额外文件/目录、symlink 或其他特殊类型都硬拒绝。
属于已死 journal owner 且 inode 未变的 `config.json.lock` 才可回收。config 发布并 verify 后，
marker/journal 尽力清理；即使成功响应
丢失，同 plan 也从 `state/onboarding.json` receipt 幂等返回，不重复 commit/票。若进程恰在
config 发布后、清理前崩溃，业务结果仍幂等，但残留 journal/config lock 可能需要先用 doctor
确认 PID/所有权后人工清理。

安全优先的硬停边界：活动或复用 PID、config/templates/版本漂移、marker/journal 缺失或被改、
repo 已修改、final 与 stage 同时存在等情况都要求人工审计；core 不猜所有权、不接管/删除未知
目录。若崩溃发生在 repo 完整摘要或 data manifest 持久化之前，已预留 final 中的未完成树会原样保留供
人工审计，恢复流程拒绝自动删除/重建。此流程只创建尚不存在的新 repo，不是已有 repo import
或常驻多实例协调器。

### 改编原著 source intake 与拆书门

`add-script` / Studio / CLI onboarding 对改编项目只收集原著、整体改编建议、权利范围与
Harness 同意；它们不替 story-designer 拆书。原著必须是 workspace 内、剧本 Git repo 外的
单链接普通 UTF-8 文件。`project plan` 会零写读取并绑定原著 identity、bytes、SHA-256 和确定性
分块；同一次 `project create` 在项目三处真相发布并验证后 exact-replay 该 source plan，自动
发布本地 chunks、创建 `source-analysis` Todo 票，并把 outline 置为
`Backlog+source-pending`。因此正常立项之后直接启动 scheduler，不再要求第二次手工登记。

以下两阶段命令只用于**已有改编项目迁移、恢复或高级管理**：

```bash
writing-loop source plan --project KEY --input source-intake.json
writing-loop source register --project KEY --input source-intake.json --confirm wlsrc_...
```

独立 intake v1 顶层 exact keys 为 `version/sourceTitle/sourcePath/adaptationBrief/rightsScope/
processingConsent`。`processingConsent` exact keys 为：

```json
{
  "allowedHarnesses": ["claude"],
  "rawNovelContentMayBeSent": true,
  "confirmedAt": "2026-08-11T12:00:00.000Z"
}
```

`allowedHarnesses` 只能从 `claude|codex|opencode` 选择、去重且非空；没有显式
`rawNovelContentMayBeSent:true` 时 plan 即 fail closed。plan 读取并固定源文件 identity、SHA-256、
规范化 UTF-8 与确定性 `heading-line-v1` 分块，但严格零写、零 provider 网络。planId 绑定原著
bytes、改编设计、权利范围、授权 Harness、repo/runtime 路径与全部 chunk metadata。

register 将原始 bytes 与 chunks 以 mode 0600 发布到
`.writing-loop/<key>/source-intake.v1/`，原著不进 Git；repo 只 commit
`source/adaptation-brief.md` 与指纹。它创建 `source-analysis+source-analyst` Todo 票，并给 outline
写入 `Blocked-by`。Source Analyst 先按原著顺序、每 fire 最多8块/480 KiB 完成**全部 chunk** 的
有界结构扫描，形成 book map、完整人物弧、世界演变和季界图；未覆盖全书时 `source select`
机械拒绝。之后才依据 `seasonStrategy` 为当前季冻结最多32块/2 MiB、最多4个连续窗口的深度证据，
单次 commit 带 provenance 的有界摘要并用 `source checkpoint` 核验；
全部完成后只聚合最多12条主线、12个名场面、18个人物功能并调用
`source finalize`。只有 control.phase=`review-ready` 且 showrunner 将 source-analysis 票 Done，
通用 Blocked-by resolver 才能解锁 outline。任何外部拆书 skill 产物都不能替代这条证据链。

### 结构化故事唯一事实源与质量门

source-analysis 通过后，Story Designer 才开始维护严格的 `story/outline.v1.json` 与
`story/assets.v1.json`。前者绑定 source plan、改编处置、角色
tier、场景复用、季级 beats 与逐集 hook/agency/资产引用；后者是人物、世界、地点、组织、
道具、场景、伏笔与连续性事实的唯一机读图，并分别记录 chronology 与 reveal order。

Story Designer 按 `skeleton → beats → full` 三阶段运行 `writing-loop story validate`；
Showrunner/Evaluator 在各自门内独立重跑。episode/review/evaluation 票先由 `story context`
按 ticket、agent、episode 与字节预算选择资产；不得回退整库扫描。`fail` 阻断交门，`skipped` 仅表示阶段未到，机器全绿
仍保留人工“合规但平庸”否决。完整 exact-key 契约见
[`story-design-schema.md`](story-design-schema.md) 与
[`story-assets-schema.md`](story-assets-schema.md)。正常操作者通过 Studio 查看，不需要手工执行
story/source 内部命令。

## 数据目录布局 — `<workspace>/.writing-loop/<project-key>/`

```
<workspace>/.writing-loop/
  workspace.json          # {version:1,id:"ws_<32 hex>"}；workspace 自有稳定 identity
  config.json             # workspace 项目索引（上文）
  system/proposals/       # workspace 级 Writing Loop 框架改进收件箱；绝不进入任何项目板
    WLSYS-<24hex>.json    # content-addressed immutable proposal；Studio /system 只读展示
  .onboarding-transactions/
    <key>.json            # durable create journal（成功发布+verify 后尽力删除）
    <key>.lock            # 每项目 create/recovery lease（PID 所有权）
  <project-key>/
    activity-index.v2.json # 可删除重建的持久 activity cache（不是真相源）
    .activity-index.v2.lock # ActivityIndexer 独立 O_EXCL 刷新锁（正常结束即释放）
    source-intake.v1/      # 改编原著本地运行态；全目录不进剧本 Git
      manifest.v1.json     # 原著指纹、处理授权与确定性 chunk registry
      control.v1.json      # selected/completed chunks + registered/analyzing/review-ready
      original/source.txt  # 0600 immutable 原始 bytes
      chunks/chunk-*.txt   # 0600、逐块 provider 输入
    board/
      counter.json        # { "prefix": "WL", "next": 42 }（hint；真相是 O_EXCL 独占创建）
      tickets/WL-1.md …   # 一票一文件：YAML frontmatter + 模板正文 + append-only 评论区（§18）
    lessons/              # §14 按角色分文件 lessons（per-operator：shared.md + <role>.md；
                          #   迁移期可见旧 lessons.md / lessons.md.migrated 留档）
    reports/              # §22 daily/weekly/monthly + *.review.md 操作者点评
    state/                # agent 小状态（showrunner lens、doctor SHA 等）
      onboarding.json     # 成功立项 receipt（plan/config/template 指纹、输入、scaffold commit）
    events.jsonl          # 项目级显式事件（当前 project.created / paused / resumed）
    fires.jsonl           # 调度器遥测账本（每 fire 一行 JSON；上节）
    run-state.json        # bounded/atomic 实时调度快照（scheduler + in-flight agents；退出后留 stopped）
    logs/                 # 调度器每 fire 全量输出（<UTC时间戳>-<agent>.log）
    wl-run.lock           # 调度器防重跑锁（运行中在位；退出释放；锁名 0.4.0 连续性保留）
```

`writing-loop system proposal file --input proposal.json` 是系统建议的唯一新建入口；
`writing-loop system proposal list [--json]` 与 `writing-loop system proposal show WLSYS-ID`
负责观察，`writing-loop system proposal migrate-ticket --project K --ticket ID` 仅用于把旧版误落项目板的
`[reflect-proposal]` 先完整归档再移除。系统记录严格绑定来源 project/agent、证据、建议改动、
状态与可选处理结论，单条上限 256 KiB，O_EXCL + fsync 发布，内容漂移 fail closed。
项目 scheduler、项目 snapshot 与 `needs-showrunner` 扫描都不读取该目录；Studio 的
`[/w/<workspace-id>]/system` 和 `/api/system/proposals` 是独立只读投影。

### Studio workspace 命名空间、详情 registry 与持久有界 activity

单 workspace 模式沿用原 URL。multi-workspace fleet 模式的首页为 `/`，每个 workspace 的
HTML、API、SSE 与写操作都必须位于 `/w/<workspace-id>/…`：例如
`/w/<workspace-id>/p/<key>`、`/w/<workspace-id>/api/snapshot`、
`/w/<workspace-id>/api/projects/<key>/activity`。旧式 unscoped GET 会 307 到启动时选定的
workspace；unscoped POST 直接 409，防止立项或启停落入错误 workspace。fleet 自己只开放
聚合首页、`/api/health` 与 `/api/stream`。

工作区内详情 API 为
`[/w/<workspace-id>]/api/projects/<key>/resources/<ticket|document|episode|report|evaluation>/<id>`。
服务端 registry
把 ID 解析到本项目的已登记文件：Ticket 来自本板；document 只允许创作宪章 north-star；
结构、人物、资产和时间线由 Story API/页面直接从 JSON 渲染；episode 只接受数字集号；report/evaluation
只能引用各自目录扫描出的 opaque ID。客户端不能传路径；读取拒绝 symlink/越界/非普通文件，
单份 Markdown 最多返回前 1 MiB，并以 `truncated` 和 ETag 明示。

`GET [/w/<workspace-id>]/api/projects/<key>/activity?limit=1..100&before=<opaque>` 由
`ActivityIndexer` v2 提供。它仍从 `events.jsonl` 项目事件、`fires.jsonl` 调度结果、Ticket
append-only 评论/转态与当前文档/分集/报告/评估 mtime 观测构建；fire/明示事件/转态可称
authoritative，只有 mtime 的旧工件只能称 `snapshot-only`。源账本、Ticket 与 repo 工件永远是
真相，`activity-index.v2.json` 只是可删除、可从它们重建的读缓存。

索引用便宜的 metadata source signature 判断是否需要深扫；签名未变时直接复用持久
`generation`/`revision`。变化时在独立 `.activity-index.v2.lock` 下合并稳定 event ID、去重、
按时间排序，再以随机临时文件 + file fsync + atomic rename + directory fsync 发布。index 与锁
拒绝 symlink/hardlink/非普通文件及 validate→open 身份替换。当前默认 retention 为 5,000 条/
16 MiB（实现硬上限 10,000 条/32 MiB）；累计丢弃会返回 `RETENTION_TRUNCATED`，旧 cursor
随 generation/retention 失效时返回明确错误。首次索引仍受源扫描边界约束：fires 尾 512 KiB、
events 尾 128 KiB、最近 200 张票、每票最后 40 评论、每类最多 200 个工件；因此首次有界窗口
之前的历史以 `BOOTSTRAP_GAP` 明示，其他裁剪继续返回来源 warning 与 `truncated:true`。

activity page schema 为 v2，含 `workspaceId`、`project`、`generation`、`revision`、分页
`cursor`/`nextBeforeCursor` 与项目 `sseCursor`。`before` cursor 绑定 workspace + project +
generation，并以事件 `(effectiveAt,id)` 定位；不能跨项目/跨 workspace 使用，也不能在被 retention
淘汰后假装仍连续。`run-state.json` 仅在每次响应时读入 `live[]` overlay，不持久化进 index、
不伪造成已完成历史。

usage 只汇总账本中可证实的 fire 数、时长、provider/model。当前 fire schema 没有 token 与
账单字段，所以 `tokenUsage` / `cost` 必须返回 `{state:"unknown",reason:"not-recorded"}`（provider
未启动则 `not-applicable`），Studio 显示“未记录”，绝不从模型名或时长估价。

Studio `/api/stream` 使用另一层聚合 event ID：workspace 流为
`wlsse1_<workspace-id>_<64 hex>`，fleet 流为 `wlsse1_fleet_<64 hex>`。hash 同时覆盖稳定
snapshot fingerprint 与各项目 ActivityIndexer revision，因此只改 Ticket 评论/活动、snapshot
摘要未变时也能触发刷新。SSE 帧写 `id:`；客户端重连携带 `Last-Event-ID` 时，Studio 重启后可从
持久 index 重算相同 cursor：未变化只发 `cursor-current` 注释，下一次真实变化再发新 ID。
malformed cursor、workspace/fleet 类型串用或跨 workspace cursor 均 400。这个 cursor 只表示
“该作用域读模型是否变化”，不是无限 event-log offset；历史仍从上面的有界 activity API 读取。

整个 `.writing-loop/` 是 untracked 运行时状态，是各剧本 repo 的**兄弟**目录，不进
任何剧本的 git 历史。迁移 = `cp -r <workspace> /new/place`（相对 repoPath + 状态目录
一起复制；用 `cp` 不是 `git clone`——clone 只带单个剧本 repo，不带在制工单）。迁机后在
新机器运行 `writing-loop workspace add /new/place` 重建本机指针；同机移动时须先确保旧路径
已消失再 add。若原件仍在，不要把带同一 `workspace.json` identity 的副本登记成第二个 room。

## 剧本 repo 内文档树（由 add-script scaffold）

```
bible/north-star.md
story/{outline.v1.json,assets.v1.json}
episodes/   evaluation/   source/（改编立项）
```

人物、世界、伏笔、连续性、场景与时间线只存在于 `story/assets.v1.json`；季结构只存在于
`story/outline.v1.json`。旧 Markdown 镜像由 S00 拒绝。

## Server-only production runtime（不属于 workspace config）

远程制片 worker 使用独立的 owner-only JSON，通过
`writing-loop-production-worker --config /absolute/production-runtime.json --once` 装配。该文件不是
`.writing-loop/config.json` 的字段，Studio/API/intent/enqueue 也不能覆盖它。完整且由 strict parser
执行验证的 v1 fixture 见
[`docs/design/phase-3-remote-production/AI-SPEC.md`](https://github.com/dyzsasd/writing-loop/blob/main/docs/design/phase-3-remote-production/AI-SPEC.md#9b-phase-3c-%E9%83%A8%E7%BD%B2%E4%B8%8E-runtime-contract)。

顶层 exact keys：`version`、`workspaceId`、`projects`、`backends`、`gateway`、`workflows`、
`stagingProfiles`、`runner`，外加可选的 `executionProfileSnapshotFile` 与 `localAssetSource`。
文件必须是当前 euid 所有、
单链接普通文件，mode 只能 `0400`/`0600`；
workflow graph 同样按有界单链接普通文件逐次读取并复核 inode/digest。配置只允许保存 `credentialEnv`
环境变量名，不允许保存 token、Authorization header、任意请求 URL 或签名资产 URL。

- `projects[]` exact keys：`version`、`project`、`enabled`、`backendInstanceIds`、
  `deploymentTerritories`、`availableBudgetMicros`、`allowedProcessingRegions`、`licenseCompliance`、
  `usesOutputToImproveModels`。后三项是 intent gate 与编译器的项目侧声明（§4.7）：
  - `allowedProcessingRegions`：素材允许被处理的物理地域，ISO-3166 alpha-2；空数组即「未声明」，
    四个 modelFamily 一律 deny（`processing-region-not-allowed`）。集合别名 `EU`、非标准码 `UK` 与
    `WORLDWIDE` 在解析层拒绝。
  - `licenseCompliance{annualRevenueUsdBelow, attributionSurfaces[]}`：与 gate context 同形状、同判据。
  - `usesOutputToImproveModels`：`obligations.noModelImprovement` 的编译期判据，gate 不判定。
  `StaticGateContextResolver` 把前两项直接供给 gate context；`backendProcessingRegions` 来自后端
  capability（`ProductionAdapter.capabilities().processingRegions`），`realFaceInputs` 由 `inputs[0]`
  的 ShotRequest 正本（workspace CAS）汇总，缺该输入即 `undeclared`。
- `executionProfileSnapshotFile`（可选）：gateway 导出的只读 execution profile 快照路径，相对本
  runtime config 文件，解析规则同 `workflows[].file`（无 `..`、无空段、非绝对路径）。缺省为 null，
  此时 `production plan-shots` 拒绝出计划——没有价目与时长档就无法给出可审批的批次估算。
- `localAssetSource`（`stagingProfiles` 非空时必填，否则可缺省为 null）exact keys：`version`、
  `kind`、`casAuthority`。`kind` 本版只有 `workspace-cas`：本机 workspace CAS
  （`.writing-loop/<project>/production-cas.v1/sha256/<digest>`）即 `cas://` 输入的正本持有方，
  路径由装配层按 workspace root 与 project 推出，不写进配置文件。单个 CAS 对象上限 64 MiB
  （`MAX_PRODUCTION_CAS_OBJECT_BYTES`），其中 ShotRequest 这类文档另有 1 MiB 上限
  （`MAX_PRODUCTION_CAS_DOCUMENT_BYTES`，与 gateway `assets` 路由的文档上限同值）。
  `casAuthority` 必须与 gateway registry 的 `casAuthority` 和 execution profile 快照里的同名字段相等。
  worker 用它做两件事（§6.4）：
  - staging 之前逐个 `cas://` 输入向 gateway `HEAD /v1/scopes/<ws>/<project>/assets/sha256/<digest>`，
    404 即 `PUT` 上传原始字节。上传失败或本机取不到该对象时，该次 stage 直接失败，不带着缺失输入继续。
    上传目标取 `stagingProfiles[].baseUrl`（不是顶层 `gateway.baseUrl`）：对象必须落到解析 `cas://`
    的那台主机上，而 `cas://` 由 stage kernel 解析。这条前提是「stage kernel 与 `assets` 路由在同一
    进程、共用同一个 ingest CAS」——本版的 gateway 装配即如此（§8.0）。若将来把 stage 与 ingest 拆到
    不同进程或不同 CAS，必须重新裁定上传目标；
  - H3 graph 契约 v2 提交前，从本机正本重新读出 `prompt.text` 与 `output.seed`，与 stage 回执的
    `shotRequest` 投影逐字比对，不一致即 `workflow-invalid`，不提交。
  声明另一个 authority 的 `cas://` 输入在上传前即被拒——它不可能被本 gateway 解析。
- `production-gateway` backend：credentialed HTTPS、固定 safe path、server profile alias；按 project
  构造 scope-bound adapter。
- direct `comfyui` backend：仅无凭据 literal-loopback HTTP development endpoint；正式远程部署禁止。
- owner-only `transport`（`backends[]` 的 `production-gateway`、顶层 `gateway`、`stagingProfiles[]` 三处
  可选，缺省等价于 `tls`，即上述 HTTPS 规则不变）：取 `insecure-private-http` 时 `baseUrl` 必须是
  `http://` 且 host 为 RFC1918 私网 IPv4（10/8、172.16/12、192.168/16）或 `127.0.0.1` 的字面地址，
  `credentialEnv` 必须非空；域名、公网 IP、`https:`、IPv6 与 `kind: comfyui` 一律拒绝。该选项以 VPC
  隔离或 ssh 隧道替代 TLS，威胁模型与适用条件如下，任一条不成立时必须改回 `transport: "tls"`：
  - 当前拓扑（操作者 2026-09-02 裁定）：worker 与全部 writing-loop 控制面运行在操作者本机，经 IAP
    ssh 隧道 `-L 8790:127.0.0.1:8790` 访问 GPU VM 上的 gateway，因此 `baseUrl` 为
    `http://127.0.0.1:8790`，明文段只存在于本机 loopback，跨主机段由 ssh 加密；
  - GPU VM 上的 gateway 只绑 `127.0.0.1`，不监听任何对外地址，ComfyUI 同样只在 loopback；
  - 备选拓扑（worker 与 gateway 同 VPC、gateway 绑 VPC 内网 IP）仍然成立，此时额外要求防火墙不对
    公网开放 gateway 端口、且入站只允许该 worker 主机的内网 IP；明文段对同 VPC 内的其他工作负载可见，
    VPC 内出现第三方工作负载时该前提失效；
  - GPU VM 按批次启停，非批次期间不存在监听端口；
  - 不适用于跨 VPC、跨云或经公网的部署。
- workflow：完整 backend/model/workflow/parameters tuple、显式 projects allowlist、必填
  `inputPolicy: static-pre-staged | scoped-staging` 与 `h3GraphContract`。两项按 modelFamily 家族表判定：
  `minimax-h3`、`seedance`、`veo` 的输入逐镜可变，只能用 `scoped-staging`；只有 `minimax-h3` 经 pinned
  ComfyUI 图执行并带 graph contract，`generic` / `seedance` / `veo` 的 `h3GraphContract` 必须显式为 `null`。
  H3 contract 固定 native generator、768 short-edge canvas、24fps 对应的
  `17k+5` length、diffusion/text encoder/video VAE/audio VAE 四组件 bundle digest、active
  SigmaShift→guider/scheduler→sampler→双 decode→CreateVideo→SaveVideo pipeline，以及实际参数投影 digest。
  `h3GraphContract.version` 取 1 或 2（两版并存）：v1 把 `generator.prompt` 与 `RandomNoise.noise_seed`
  钉成字面量，一份 graph 只承载一个镜头；v2 把两者换成 sentinel
  `writing-loop://shot-request/<profileId>/prompt|seed`，参数投影按 sentinel 计算（因此同一 profile 的
  每个镜头共用一份 `parametersSha256`），materialize 时从 stage 出的 ShotRequest 填入实际值并重新断言
  整图。v2 要求 `output.seed` 非空：pinned graph 的 `noise_seed` 必须是具体整数。
- staging profile：完整 execution 与按家族判别的 `bindings`。`minimax-h3` 用有序
  `index/slot/source/consumer` 的 LoadImage 绑定契约（数组形）：v1 source 只能是 `LoadImage.image`
  output 0；consumer 必须是 contract 中真实 H3 generator 的 `first_frame`、`last_frame` 或
  `ref_images.ref_image_N`。source→consumer exact edge、无 fanout、无 decoy node 与 provider key 唯一性
  都在 graph verifier 中证明。graph 契约 v2 的绑定数组以 `{index: 0, slot: "shot-request", source: null,
  consumer: null}` 开头（该 slot 只 stage、不绑定图节点），其后的 LoadImage 绑定 index 顺延一位，
  consumer 的 `ref_image_N` 仍按 LoadImage 位置编号（N = index − 1）。
  `seedance` / `veo` 没有可绑定的图节点，`bindings` 改用
  `{version: 1, kind: "provider-slot-policy", slots: [{slot, minCount, maxCount}]}`（§6.5）：`slot` 取
  `shot-request | first_frame | last_frame | reference_image | reference_video | reference_audio`，顺序由数组
  位置隐含，必须按 `shot-request`、首帧、尾帧、图片参考、视频参考、音频参考 严格升序且每个 slot 只出现
  一次（重复次数由计数区间表达）；`shot-request` 恒为首项且 `minCount = maxCount = 1`，`first_frame` 与
  `last_frame` 的 `maxCount` 只能是 1。计数区间让同一档 profile 承载 i2v（无尾帧）与 fl2v（有尾帧）等
  镜头，不必逐镜建档。云家族的 verifier 不材料化图：template digest == bound digest，只按该声明的顺序与
  计数区间核对 staged bindings。
  `generic` 的输入是静态 pinned，不得注册 staging profile。未知/漂移 profile 在预算与 provider I/O 前
  fail-closed。
- intent license evidence 的可选 `obligations`（`{attribution, revenueThresholdUsd, noModelImprovement}`，
  三字段一旦出现就必须齐全）：许可文本附加的持续义务，是编译器与 intent gate 共同的唯一来源，
  execution profile 不复制该字段。MiniMax H3 Community License IV.1 / IV.2 / V.3 对应
  `{"attribution": "MiniMax H3", "revenueThresholdUsd": 20000000, "noModelImprovement": true}`。缺省与显式
  `null` 都规范化为「不带该键」，因此不带义务的既有 intent 的 canonical JSON 与 `idempotencyKey` 逐字节不变。
- intent gate context 的四项策略字段（来自项目配置与后端 capability，缺省即「未声明」）：
  - `backendProcessingRegions` 与 `allowedProcessingRegions`：数据实际被处理的物理位置，取 ISO-3166
    alpha-2 国家/地区代码。集合别名 `EU`、非标准码 `UK` 与 `WORLDWIDE` 一律拒绝——欧盟须逐个写成员国
    代码（`FR`、`DE`……），英国写 `GB`。判定：项目声明了 `allowedProcessingRegions` 而后端地域未声明
    → deny；后端任一地域不在允许集合内 → deny；项目未声明 `allowedProcessingRegions` 时四个家族
    （`generic`、`minimax-h3`、`seedance`、`veo`）一律 deny——runtime `projects[]` 已供给该字段，
    本地 ComfyUI 与云后端同判据。deny 码为 `processing-region-not-allowed`。
  - `licenseCompliance{annualRevenueUsdBelow, attributionSurfaces[]}`：项目对许可义务的声明。
    `obligations.revenueThresholdUsd` 非 null 而项目未声明年收入低于该阈值、且没有完整的
    written-license evidence（`basis: written-license` 且 status verified、`licenseSha256`、`evidence`、
    `issuedBy`、`issuedAt` 齐全）时 deny `license-obligation-unmet`；`obligations.attribution` 非 null 而
    `attributionSurfaces` 为空时同样 deny。义务判据在编译器与 gate 是同一个纯函数，两侧结论必然一致。
  - `realFaceInputs`（`undeclared | present | absent`）：汇总 ShotRequest 的 `containsRealFace`
    （intent 的 `inputs[]` 只有 AssetRef，不携带该标记）。Seedance 2.x 拒绝真人人脸参考，未声明
    `absent` 即 `provider-likeness-policy` deny。
- `obligations.noModelImprovement` 只在编译期按项目声明的 `usesOutputToImproveModels` 判定，gate 不判定：
  输出是否被用于改进其他模型是产物的后续使用方式，dispatch 前拿不到可取证的事实（AI-SPEC 使用约束）。
  该字段是 `ShotCompilePolicy.project` 的独立字段，不在 `licenseCompliance` 内。
- canonical workflow identity：intent/config 的 `workflowSha256` 钉住 immutable template。scoped stage 返回
  exact execution + ordered bindings 的 `VerifiedStageReceipt`；trusted materializer 只替换上述 allowlisted
  source literal，产生 `boundWorkflowSha256`。worker 发送 bound digest，job Gateway 从 server-owned template
  与 receipt 独立重建并比较；HTTP caller 永远不能提交 graph。
- runner：一轮内 project/backend 并发上限；跨进程由 workspace worker lease 单飞，远端集群累计配额
  仍必须由 Gateway 的 durable `SubmissionAdmissionPolicy` 强制执行。policy 以稳定 `admissionKey` 幂等
  `acquire/settle`，一个 allow 只能落一个 `submitted | not-submitted | submission-unknown` outcome；重启或
  settlement 响应丢失只能重放相同 key/outcome，不能再次 raw submit。
- job storage 是另一项必需 authority：`ProductionJobStorageAdmissionPolicy.acquire(context, storageKey)`
  在任何 global/scoped binding 或 job record 前，按 Gateway 提供的 `recordBytesUpperBound` 原子执行
  per-scope job/byte 与 deployment-global cap。exact retry 即使 cap 已满也复用原 slot；同 key context drift
  冲突。首个 global binding 后、任何第二 record 前，以 exact `recordRef` 幂等 `commit`；committed slot
  覆盖不可变 durable records 的 lifetime，只能由受控 retention/GC 回收。只有 O_EXCL loser 证明自己零
  record 时可用固定 reason `unused-before-record` 幂等 `release`；authority 必须拒绝 committed release 并
  保留 drift tombstone。三种操作都必须能在进程重启或响应丢失后用相同参数安全重放。

AI-SPEC 中的 runtime JSON 是 strict parser 会执行的 representative API-format contract fixture，不是模型
下载 manifest，也没有经过 live ComfyUI `/prompt`。部署方必须用实际 workflow/model artifact digest、
server profile 与 Comfy 兼容性证明替换示例值；参见 [Comfy H3 教程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)、
[H3 core nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py) 与
[官方 workflow templates](https://github.com/Comfy-Org/workflow_templates/tree/main/templates)。

## Server-only production gateway registry（不属于 workspace config）

私有制片 gateway 进程使用第二份 owner-only JSON，通过
`writing-loop-production-gateway --config /absolute/production-gateway.json` 装配。它与 worker 的
`production-runtime.json` 是**两台主机上的两份文件**：worker 只持有 `profileId` 与已钉住的 digest，
gateway registry 才持有 raw ComfyUI origin、template graph、价目与 CAS authority。完整且由 strict
parser 执行验证的 v1 fixture 见
[`AI-SPEC.md` §9B.1](https://github.com/dyzsasd/writing-loop/blob/main/docs/design/phase-3-remote-production/AI-SPEC.md)。

文件要求与 worker runtime config 相同：当前 euid 所有、单链接普通文件，mode 只能 `0400`/`0600`，
只保存环境变量名，不保存 token。顶层 exact keys：`version`、`listen`、`auth`、`backends`、
`executionProfiles`、`stageProfiles`、`casAuthority`、`objectsRoot`、`ingestRoot`、`jobStateRoot`、
`admission`、`reconcilePolicy`。

- `listen{host, port}`：`host` 只接受 RFC1918 私网 IPv4（10/8、172.16/12、192.168/16）或 `127.0.0.1`
  字面地址；`0.0.0.0`、公网 IP 与域名在监听前被拒。当前拓扑推荐 `127.0.0.1`：worker 在操作者本机，
  经 IAP ssh 隧道 `-L 8790:127.0.0.1:8790` 连到 VM 上的 gateway，VM 上没有对外监听面。
  `port` 为 0–65535，`0` 表示取临时端口（测试用），部署固定端口。
- `auth{bearerEnv}`：静态 bearer 的环境变量名，由 systemd `EnvironmentFile`（0600）注入。全部路由
  要求 `Authorization: Bearer <该变量的值>`，缺失或错误一律 401。bearer 短于 16 字符时进程拒绝启动。
- `backends[]`：v1 只支持 `kind: "comfyui"`，字段为 `backendInstanceId`、`comfyBaseUrl`（只接受
  literal loopback HTTP，ComfyUI 与 gateway 同机）、`maxInputImageBytes`、`profileIds[]`。数组长度
  必须为 1：jobs 内核只绑一个 raw adapter，第二个 backend 需要独立实例，解析层直接拒绝。
  `maxInputImageBytes`（1 KiB–4 GiB）是自托管后端的输入图片上限声明：ComfyUI 没有 provider 侧上限
  可引用，adapter 不猜数字，该值经 capability 的 `limitsByModelId[profileId].maxInputImageBytes`
  与只读快照的 `limits` 一起对外。
- `executionProfiles[]`：`execution` 是 §4.2 execution profile 正本
  （`kind: "writing-loop/execution-profile"`，含 profileId、modelFamily、operation、backendInstanceId、
  workflowSha256 / modelSha256 / parametersSha256、variant、shortEdge、durationSeconds、aspectRatio、
  resolution、generateAudio）；`workflowFile` 是相对 registry config 的 pinned graph
  路径（解析规则同 `workflows[].file`：无 `..`、无 symlink component、单链接普通文件、digest 必须等于
  `execution.workflowSha256`）；`h3GraphContract` 与 `stageProfileId` 绑定 graph 与 slot 契约；
  `priceTable` 为 `null` 或 `{basis: "tariff", currency: "USD", microsPerOutputSecond, priceAsOf, source}`；
  `license` 是 `ProductionLicenseEvidence` 形态（`parseProductionLicenseEvidence` 解析），署名 /
  收入阈值 / 禁止改进模型三项义务只在其 `obligations`，与 intent gate 同一判据，execution profile
  本身不再带 license 字段；`processingRegions[]` 是 ISO-3166 alpha-2 实际处理地域。intent 级
  execution 由 profile 推导，不二次配置。
- `stageProfiles[]`：`providerCasNamespace`（以 `/sha256` 结尾）、有序 `inputs[]{index, slot, mediaTypes}`
  与 H3 `bindings[]`；两者逐位按 index/slot 对齐，否则拒绝。`mediaTypes` 必须落在 stage 内核的允许
  集合内（`application/vnd.writing-loop.shot-request+json`、`audio/flac|mpeg|ogg|wav`、
  `image/gif|jpeg|png|webp`、`video/mp4|webm`）、去重且按字典序升序、至多 32 项——与内核请求期的
  `parseProfileInput` 同一规则，避免「启动成功但每个 stages 请求 500」。
  H3 graph 契约 v2 的 profile 在 `inputs[0]` 声明 `slot: "shot-request"`、
  `mediaTypes: ["application/vnd.writing-loop.shot-request+json"]`，对应的 `bindings[0]` 的
  `source` 与 `consumer` 同为 `null`（该 slot 不绑定 LoadImage），其余 LoadImage 绑定 index 顺延一位。
  `shot-request` 这个 slot 名与该 mediaType 一一对应：任何一边单独出现都被拒。
- `casAuthority`：stage 资产只接受 `cas://<casAuthority>/sha256/<digest>`，解析到本机 ingest CAS
  （承接链的尾帧因此不需要跨主机取回）。同一个 ingest CAS 也是 `assets` 路由的对象空间：
  `GET|HEAD|PUT /v1/scopes/<workspaceId>/<project>/assets/sha256/<digest>` 是同一个内容寻址对象的
  三种方法（bearer 与其余路由相同）。`PUT` 的请求体是原始字节，服务端重算 sha256 必须等于路径中的
  digest，否则 400 且不落盘；同字节重放为幂等 200，同名不同字节为 409（内容寻址下不可能由该路由
  产生，仍拒绝覆盖）。媒体类型由字节嗅探判定，只接受图片（上限取 `backends[].maxInputImageBytes`）
  与 ShotRequest 正本（嗅探不出媒体类型时按内容校验，上限 1 MiB，判据与 stage 内核相同）；视频 /
  音频等 provider 产物只经 ingest 内核入库，在该路由上被 415 拒绝。`HEAD` 只答存在性（200/404，
  无响应体），worker 用它决定是否上传（§6.4）。
- `objectsRoot` / `ingestRoot` / `jobStateRoot`：持久化启动盘上的三个独立绝对路径。stage 内核把资产
  硬链接到 `<objectsRoot>/objects/<namespace>/<sha256>`（ComfyUI 必须能读该目录）；ingest CAS 在
  `<ingestRoot>/blobs/sha256/`；`jobStateRoot` 下由 gateway 划分 `jobs/`（不可变 job record）与
  `storage-admission/`（durable storage slot）。三者不得相等，也不得互相嵌套。
- `admission{maxConcurrentPerBackend}`：per-backend **在途提交数上限**（1–256）——同时持有 admission
  slot 而尚未 settle 的提交数，不是 provider 侧的并发渲染数。slot 在 `settle()` 时释放（一次 allow
  只落一个 `submitted | not-submitted | submission-unknown` outcome）。v1 为单实例 gateway，该
  authority 即进程内幂等记录；同一 backend 出现第二个 gateway 进程时必须换成共享 durable 实现。
- `reconcilePolicy{unknownRemoteJob, minObservationAgeSeconds}`：Spot 抢占重启后的判定声明
  （`provider-failed-preempted` 或 `orphaned`，以及取该判定前的最短观察秒数）。本版由操作者的
  reconcile 流程消费，gateway 进程自身不改写任何账本。

### 只读 execution profile 快照

`writing-loop-production-gateway --config FILE --export-profile-snapshot OUT` 只导出快照后退出，不监听
端口。导出前逐个证明 pinned graph（存在、单链接、digest 等于 `execution.workflowSha256`、通过 H3 模板
断言），任一条不成立即拒绝导出，避免发布一份本机并未部署的 digest。OUT 以 `0600` 写入，格式为：

```json
{
  "version": 1,
  "kind": "writing-loop/execution-profile-snapshot",
  "casAuthority": "wl-sg",
  "profiles": [
    {
      "version": 1,
      "profileId": "h3-fl2va-portrait",
      "profileDigest": "<sha256 of the canonical entry without this field>",
      "execution": { "...": "§4.2 execution profile 正本" },
      "durationGrid": [8],
      "limits": { "...": "§4.3 VideoBackendLimits，与 capabilities 路由同源" },
      "priceTable": { "version": 1, "basis": "tariff", "currency": "USD", "microsPerOutputSecond": 430,
                      "priceAsOf": "2026-08-28T00:00:00.000Z", "source": "..." },
      "license": { "version": 1, "status": "verified", "basis": "community", "territories": ["SG"],
                   "licenseSha256": null, "evidence": null, "issuedBy": "MiniMaxAI",
                   "issuedAt": "2026-01-01T00:00:00.000Z", "expiresAt": null,
                   "obligations": { "attribution": "MiniMax H3", "revenueThresholdUsd": 20000000,
                                    "noModelImprovement": true } },
      "processingRegions": ["SG"]
    }
  ]
}
```

`profileDigest` 是去掉该字段后条目的 canonical JSON sha256——`execution`、`durationGrid`、`limits`、
`priceTable`、`license`、`processingRegions` 全部计入，任一项变化 digest 即变化。

`limits` 是 §4.3 的 `VideoBackendLimits`，导出前经 `parseVideoBackendLimits` 复算一次形状；它与
`capabilities` 路由返回的 `limitsByModelId[profileId]` 取自同一份推导，因此
`durationGrid === limits.durationSeconds.grid` 恒成立（不等时导出直接失败）。`durationGrid` 是同一输出形状
（backendInstanceId + modelFamily + variant + aspectRatio + resolution + generateAudio）下已配置 profile
的时长集合升序去重（§5.3：H3 每档时长一份 profile）。`processingRegions` 与 worker 侧共用同一份地域
解析：去重、升序、拒绝 `EU` / `UK` 这类集合别名——配置里的书写顺序不影响 digest。worker 侧 runtime config 的
`executionProfileSnapshotFile` 声明该文件路径，`plan-shots` 零网络读取它做估算，并校验
`execution.workflowSha256` 与自身 `workflows[].workflowSha256` 相等，不等即拒绝出计划。价目只有这
一处来源，registry 与快照是同一份 profile 内容。

worker 侧解析器（`hub/src/production-profile-snapshot.ts`）与导出端逐字段对齐，并重算每条
`profileDigest`：快照被就地改过价目、时长档或许可即在此暴露。快照按与 pinned graph 相同的纪律读取
（相对路径无 `..`、路径段不得是 symlink（读前读后各查一次）、当前 euid 所有、mode `0400`/`0600`、
单链接普通文件、读取期间不变）。

`limits` 在读取侧是可选字段：存在即计入 `profileDigest` 的计算体，缺省即不计，两种形态都能与导出端
的 digest 对上。当前 gateway 的导出恒含 `limits`（与 `capabilities` 路由同源，见上），可选只是为了读入
更早版本导出的快照。`processingRegions` 两侧都规范化为升序去重后再参与 digest 与比对，顺序差异不构成
不一致。

## 批次审批输入（`production plan-shots --input`，不属于 workspace config）

批次审批文档的输入是一份普通 JSON（非 owner-only），顶层 exact keys：`version`、`kind`
（`writing-loop/shot-batch-request`）、`phase`、`capability`、`anchorPreference`、`compiler`、
`taskIdPrefix`、`createdAt`、`useTerritories`、`rights`、`moderation`、`license`、`profileId`、
`samplePolicy`、`gpuEstimate`、`shots`、`script`，外加一个可选键 `shotIds`。

- `phase`：`sample` 或 `bulk`。`bulk` 必须显式声明 `samplePolicy.sampleShotIds`——样片门检查的是
  先前批次的样片，不能由本批次自证。`sample` 的 `samplePolicy` 可为 null，缺省取每个被选 profile
  在批次顺序里的第一镜。
- `capability`：后端能力描述（§4.3 `BackendCapabilities` 全字段），可为 `null`。当前 gateway 导出的
  快照恒带 `limits`，因此本字段可省，由快照推导；读入不带 `limits` 的旧快照时必填——编译器需要
  `limitsByModelId` 才能判定模式、时长网格与参考上限。两者同时给出时逐项交叉校验（`backendInstanceId`、modelFamily、
  `processingRegions`、时长网格、`limits` 本身），任一不一致即拒绝出计划。
- `backendInstanceId`：本批次的目标后端；`null` 时取快照中唯一的 `backendInstanceId`，快照含多个
  后端而未声明即拒绝（选错后端会把镜头发到另一台机器上）。
- `arcId`：`visual/mappings.v1.json` 的陈设映射键（`(sceneId, arcId)`）；`null` = 不自动填陈设。
- `profileId` 为 `null` 时的选档顺序：先按 `(backendInstanceId, output.aspectRatio,
  output.generateAudio)` 收敛候选档，再在这个集合内按时长网格上取整。镜头合并的时长上界也取该集合的
  最大档——跨画幅或跨音频意图选档等于选错档。
- `shots[]` 与 `script` 二选一。`script{episodeFile, episode, sceneIndexes, options, patches,
  mergedPatches}` 走剧本预填路径：`patches` 在合并**前**补齐分镜字段（`camera` 必须在这一步落位，
  否则合并条件 3 恒不成立），`mergedPatches` 在合并**后**按存活 shotId 补齐 prompt 与连续性输入。
  两份 patch 都只允许替换 `camera`、`scene`、`cast`、`props`、`crowd`、`output`、`continuity`、
  `prompt` 八个成员。其中 `scene` 与 `continuity` 是字段级合并：`scene` 只接受
  `lightingStateId` / `dressingVariantId`，`continuity` 只接受
  `firstFrame` / `lastFrame` / `references` / `spatialPasses`；`sceneId`、时段、内外、
  `stageGroup`、`prevShotId` 是剧本与合并结果的事实，不接受改写。
- 预填与合并的 warnings（首个动作行之前的对白、合并时被丢弃的字段）不丢弃：它们按 shotId 进入计划的
  `validation.shots[].issues`（`source: prefill | merge`）并计入 `validation.warnings`。
- 视觉侧默认值在最后一步补空位，人工 patch 已写死的值不覆盖：`scene.lightingStateId` 取
  `visual/mappings.v1.json` 的 `(sceneId, timeOfDay)`，`scene.dressingVariantId` 取
  `(sceneId, arcId)`，`continuity.firstFrame` 取候选图 `shotIds` 排到该镜且已批准的那一张
  （origin `approved-candidate`，`containsRealFace` 原样带入）。排到该镜但尚未批准的候选图不填，
  只记一条 `source: visual` 的 warning。这四张视觉侧表全部纳入 `policyDigest`。
- `taskIdPrefix`：每镜 `taskId = <taskIdPrefix>-<shotId>`。确定性 taskId 让同一批次的精确重放成为
  幂等操作（CAS 对象、intent、批次审批记录与 task 都不重复写）。
- `gpuEstimate{spotUsdPerHour, estimatedHours}`：plan 文档的 GPU 小时附注，不构成阻断条件（§4.7）。
- `shotIds`（可选，缺省与 `null` 都表示不筛选）：按镜头筛选的存活集合，与命令行 `--shot <id>`
  （可重复）等价，两者都给出时取交集，交集为空即拒绝出计划。筛选在预填、合并与视觉填充**之后**、
  编译**之前**生效：被筛掉的镜头不编译、不进 intents、不计估算，只在 `shots[]` 里以
  `selected: false` 与 `selectionReason` 列出（`planId` / `profileId` / `wave` 均为 null）。
  指向不存在镜头的筛选直接拒绝——合并会改变存活 shotId，静默少跑几镜比报错更难发现。

`--plan` 严格零写入，输出 `ShotBatchPlan`：`batchPlanId`、`policyDigest`、`createdAt`、
`selectedShotIds`、每镜 `decisions` 与 `estimates`、承接链 `waves[]`、`droppedReferences`、
`degradations`、`validation` 汇总与总估算。
`batchPlanId = sha256(canonicalJson({workspace, project, intents[], policyDigest, degradations[]}))`；
策略（价目、capability、项目声明、samplePolicy、intent 脚手架、视觉侧表、选中集合）或任一镜头输入
变化即失效。`--confirm <batchPlanId>` 重算同一计划后逐镜按 CAS → 批次审批记录 → intent → task →
dispatch-requested 发布；带 error 级校验问题的批次一律拒绝提交（`--plan` 仍输出完整文档，但退出码
为 1）。`--confirm` 只提交选中镜头。

`validation.shots[].issues[]` 的 `source` 取 `prefill | merge | visual | upstream | compile` 五者之一。
前三者是装配期提示（见上），`compile` 是 §4.1 的编译错误码表，`upstream` 只有一个码：

| 码 | 级别 | 判据 |
| --- | --- | --- |
| `upstream-take-unavailable` | error | `continuity.firstFrame` / `lastFrame` 的 origin 为 `previous-shot-last-frame`，但上游 take 在账本里不可用 |

尾帧承接只有一种成立方式，全部满足才放行：

1. `origin.taskId` 已在本项目账本里；
2. 该 task 状态 ∈ `{qc-pending, approved}`——`dispatch-pending` / `running` / `failed` / `rejected`
   的 take 没有可用尾帧，「跑过」不等于「跑出来了」；
3. 该 task 的 subject 就是 `origin.shotId` 那一镜；
4. 该 take 的尾帧资产（`assets[]` 里唯一的 `image/*`）与本镜声明的那一张 `sha256` / `byteLength` /
   `mediaType` 逐项相同。`uri` 不参与比对：同一份对象在账本里是 ingest 登记的 `urn:sha256:`，在批次
   文档里可以写成 `cas://`。

**批内不成链。** ShotRequest 不可变且携带尾帧的 `asset.sha256`，上游还没出片时那个 digest 只能是猜的；
即便猜对，`--confirm` 之后的精确重放也会看到上游落在 `dispatch-pending` 而被判不可用，与「精确重放
幂等」矛盾。因此本版没有「同一批次内先跑 A 再跑 B」这条路径，`waves[]` 的形状保留给消费方，但依赖
集合恒为空，**每个批次只有一波**。

逐镜推进的走法：镜头 N 出片并 QC 之后，下一个批次用 `--shot` 选镜头 N+1，它的
`continuity.firstFrame` 写 `previous-shot-last-frame`，`asset` 填镜头 N 的**实际**尾帧 AssetRef
（`production status --json` 或账本里的那一份），`origin.taskId` 填镜头 N 的 task id。

样片门按 taskId 查本地权威账本，而 taskId 由 `<taskIdPrefix>-<shotId>` 拼出：**sample 批次与 bulk
批次必须使用同一个 `taskIdPrefix`**，否则 bulk 会去找一批根本不存在的 task 而永远被阻断。

### 批次审批记录（`production-batch-approvals.v1/<taskId>.json`）

`--confirm` 逐镜提交时，在 immutable intent 旁边写一份可读记录，exact keys：`version`、`kind`
（`writing-loop/shot-batch-approval`）、`taskId`、`shotId`、`batchPlanId`、`taskIdPrefix`、`phase`、
`sampleShotIds`、`approvedAt`。它是账本外的第三份不可变伴生文件（前两份是 intent 与 CAS 里的
ShotRequest）：账本事件的 payload 与 digest 一个字节都不改，2b 之前发布的 task 没有这个文件，
读回为 null。

- **只在本次确实创建了 task 的那一镜上写。** 记录回答的是「这个 task 是在哪一份批次审批下发布的」，
  而 task 只被创建一次：精确重放、样片批次里的镜头又出现在 bulk 批次里、2b 之前发布的旧 task，这些
  情形下本次 `--confirm` 没有发布任何东西，一律不写也不改。否则一份只是路过的批次会把自己的
  `batchPlanId` 绑到别人发布的 take 上，handoff 会据此发出两条无据的门。
- `approvedAt` 取批次文档的 `createdAt`——进入 `batchPlanId` 计算体的同一时刻。不取 `--confirm` 的
  墙上时钟：那样精确重放会写出另一份字节，幂等性随之失效。
- 发布纪律与 intent 相同（同目录临时文件 → fsync → `link(2)` 定名），定名冲突的判据也相同：逐字段
  相同即认作精确重放；不同即拒绝覆盖，并报出两边的 `batchPlanId` 与文件路径——那是一条残留的孤儿
  记录，只能由操作者核对后删除。
- 崩溃窗口：task 已创建、记录尚未落盘时进程死亡，该 take 退化为只出 `qc-approved` 一条门（重跑
  `--confirm` 也不会补写，因为 task 已在账本内）。这是有意的：宁可少一条门，也不发出可能绑错批次的门。
- 这份记录是 handoff v2 的 `batch-approved` / `sample-approved` 两条门的唯一取证来源（见下）。

## 证据登记（`production evidence register`，不属于 workspace config）

```
writing-loop production evidence register --project K --kind rights|license \
  --file PATH --config RUNTIME [--json]
writing-loop production evidence register --project K --kind moderation \
  --file PATH --config RUNTIME --status passed|not-reviewed|failed --reviewed-at <规范 UTC ISO> [--json]
```

把一份权利 / 审核 / 许可证据文件写入 workspace CAS
（`.writing-loop/<project>/production-cas.v1/sha256/<digest>`），并输出可直接填入批次文档对应段落的
对象片段与 sha256。内容寻址，重复登记同一份文件是幂等的（`casObjectCreated: false`）。

- `mediaType` 按内容判定，不看扩展名：`%PDF-` 魔数 ⇒ `application/pdf`；可往返的 UTF-8 且去空白后以
  `{` / `[` 开头并能 JSON 解析 ⇒ `application/json`；其余可往返的 UTF-8 且除制表 / 换行 / 回车外无
  控制字符 ⇒ `text/plain`。以 `{` / `[` 开头却解析失败的**回落到文本判据**（带 BOM 的 JSON、以
  `[Exhibit A]` 开头的许可证正文都长这样）。三者都判不出即拒绝登记，而不是退化成
  `application/octet-stream`——AssetRef 的 `mediaType` 会随 intent 固化进不可变证据，写错一次就永远
  错在那里。
- 单份证据上限 4 MiB；空文件、非单链接普通文件、读取期间被替换的文件一律拒绝。
- 输出片段按 kind：`rights` 给 `{evidence}`；`moderation` 给 `{status, reviewedAt, evidence}`；
  `license` 给 `{licenseSha256, evidence}`。片段只填这份文件能取证的部分——rights 的地域与有效期、
  license 的签发方与义务、moderation 的审核结论与审核时刻都是文件之外的人工事实。
- 因此 `--kind moderation` 必须显式给出 `--status`（取值与 intent 侧 `moderation.status` 同一词表：
  `passed` / `not-reviewed` / `failed`）与 `--reviewed-at`（规范 UTC ISO）；缺一即拒绝。缺省成
  「passed + 登记时刻」等于凭空写出一次审核记录。其余两个 kind 不接受这两个参数。
- `--config` 是必需的：AssetRef 的 `cas://<authority>/sha256/<digest>` 里的 authority 只在 runtime
  config 的 `localAssetSource.casAuthority`，猜错的 authority 会让 worker 的本机对象源以
  authority-mismatch 失败。

## 交接输入（`production handoff --input`，不属于 workspace config）

交接文档的输入是一份普通 JSON（非 owner-only），顶层 exact keys：`version`、`handoffId`、
`studioProjectId`、`pipeline`、`createdAt`、`delivery`、`taskIds`。

- `version` 决定契约：`2` 是缺省的 scripted-drama 契约
  （`citronetic-video-creation-studio-codex-handoff-v2`），`pipeline` 只接受 `scripted-drama`；
  `--contract v1` 读 `version: 1` 的输入，`pipeline` 取 `cinematic | character-animation |
  animation | hybrid` 四条旧流水线之一。两份契约并存，字段互不覆盖。
- `studioProjectId`：VCS 侧的项目 id，最多 80 位 kebab-case。
- `createdAt`：规范 UTC ISO，不得早于所绑定 productionRevision 的 `updatedAt`。
- `taskIds`：1–2048 个 task id，不得重复；只接受 QC 已 approved 的 shot take，全部 take 必须绑定
  同一 episode revision 且 shotId 唯一。

v2 的每个 take 另带 `shotRequest`（不可变 ShotRequest 的 AssetRef）、`execution` 摘要、账本
`cost`、`assetRoles[]`、`gates[]` 与 `license` 摘要。这些字段的事实来源是账本外的两份不可变伴生
文件——`production-intents.v1/<taskId>.json` 与 `production-cas.v1/sha256/<ShotRequest digest>`；
任一缺失即整份交接失败，不做推断。`gates[]` 逐条都要有取证来源：

| gate | 取证来源 | `bindsTo.planSha256` | `approvedBy` / `approvedAt` | `system` |
| --- | --- | --- | --- | --- |
| `qc-approved` | 账本的 QC 裁决 | 不可变 intent 重算出的单 intent 确认指纹（`--confirm` 逐镜提交时用的就是它） | QC 裁决人与裁决时刻 | `wl-qc` |
| `batch-approved` | 批次审批记录 | 该记录的 `batchPlanId` | `wl-plan-shots` / 批次文档的 `createdAt` | `wl-plan-shots` |
| `sample-approved` | 批次审批记录，且 `shotId ∈ sampleShotIds` | 该记录的 `batchPlanId` | QC 裁决人与裁决时刻 | `wl-sample-gate` |

三条门的 `bindsTo.requestSha256` 都是该镜 ShotRequest 的 digest。批次审批记录不存在（2b 之前提交的
task）时只出 `qc-approved`；不在 `sampleShotIds` 内的镜头不出 `sample-approved`。记录绑定的 `taskId`
或 `shotId` 与 take 对不上时整份交接失败。

`batch-approved` 的 `approvedBy` 记的是签发这条门的本机控制面，不是人：本版 `--confirm` 只接受
批次指纹，没有操作者身份输入，因此没有可取证的人工署名可填。

`--export-dir DIR` 另写三类文件，写入前先落到同级临时目录、成功后才 rename 到位：

- `handoff.json`：规范 JSON 字节（键按 UTF-16 码元排序、无空白、只接受安全整数）；
- `handoff.digest`：上面这份字节的 sha256，供 VCS 的 `studio.py import-handoff --expect-digest`；
- 每个被引用资产一个 `<sha256>.<ext>`（`video/mp4→mp4`、`image/png→png`、`image/jpeg→jpg`、
  ShotRequest→`json`）。该表是 importer `EXTENSIONS_BY_MEDIA_TYPE` 的子集，只覆盖本版实际会产出的
  四种类型；表外的 mediaType 直接拒绝导出，扩表要两侧同时改。

资产来源：`cas://` 对象先问本机对象源（runtime config 的 `localAssetSource`，即 workspace CAS；它
校验 authority、digest 与字节长度），其余（含 ingest 产出的 `urn:sha256:`）经 gateway 的
`v1/scopes/<workspaceId>/<project>/assets/sha256/<digest>` 路由的 GET 方法取回，baseUrl、transport
与 bearer 判据与 ingest 客户端共用同一批函数，取自 `--config` 指向的 runtime config 顶层 `gateway`。
因此 `--export-dir` 必须同时给出 `--config`，且导出期间 gateway 必须在运行。每个文件落盘前逐一
校验 sha256 与字节长度，任一不符即整次导出失败并清理临时目录——目标目录里不会出现半份导出。

落位只有三种结局：目标目录不存在或是空目录时整个临时目录一次 rename；目标目录已有内容且与本次
导出逐文件同名同 digest 时判定为幂等重放，一个字节都不写；其余情况一律拒绝并要求换新目录。本命令
不逐文件覆盖已有目录——那既不原子，回滚时又会删掉目录里本来就有的文件。

## 校验规则（onboarding plan/create 必须通过）
- workspace 根已由 `writing-loop init` 确立（`.writing-loop/config.json` 存在，§11/§13）。
- `repoPath` 的父目录存在，目标路径**尚不存在**，且不能是 workspace 根、其祖先或
  `.writing-loop/` 内部；相对路径解析后必须仍在 workspace 内。CLI 允许显式外部绝对路径但
  告警失去整体复制迁移能力；Studio 只允许 workspace 内相对路径。
- `paywall.card1 ⊂ [8..12]`；`totalEpisodes` 与 format profile 惯例带一致（越界要求确认）。
- `seasonStrategy` 必须是 `single-season|multi-season|undecided`；`currentSeason` 为 1–100，
  且 `single-season` 时只能为 1。`totalEpisodes` 与 paywall 一律属于当前季。
- `audience` 非空且含性别+年龄要素（评估红线①的入口预防）。
- key 全 workspace 唯一；`ticketPrefix` 冲突时要求显式改名；PATH 中必须有 Git，create 才能
  生成并验证首个 scaffold commit。
