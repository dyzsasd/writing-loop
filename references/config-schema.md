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
      "totalEpisodes": 80,
      "paywall": {                         // 备卡制（R4.5 参数从这里读，不写死 9-11）
        "card1": [9, 10, 11],
        "card2": [26, 28, 30],
        "card3": [60]
      },
      "airedThrough": 0,                   // 已投放水位：ep≤此值的修订票机械转型为「前向修补」或 human-park，
                                           //   禁止追溯改已投放正文及其账本记录
      "episodeWordBand": [900, 1300],      // 按 format profile 默认，可覆盖
      "maxNamedCharacters": 20,            // production.md 预算账本的上限来源
      "maxPrimaryScenes": 5,
      "assetLibrary": null,                // 公司 AI 资产库清单路径（或 null=无）——rubric 资产复用度的打分输入
      "marketDataPath": null,              // 操作者投喂的市场数据目录（榜单快照/政策摘要）；market-watch 优先读取

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
      "models":  { "episode-writer": "sonnet" },
      "efforts": { "showrunner": "max", "story-designer": "max" }
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
                                          //   market-watch 周频扫榜需要出网。其余逐字沿用 dev-loop 认证集
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
                                          //   （回退 0.5.0 行为）
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
      "model": "opus", "effort": "max"    //   起 reviewer 前 glob 板 frontmatter，∃ In Review+keystone 票
    },                                    //   ⇒ 该 fire 用此档。advisory 选档——floor 判定仍归 reviewer 本体
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
                                          //   market-watch   sonnet/high 14400s cap 1200  stagger 70
                                          //   reflect        opus/xhigh  14400s cap 2400  stagger 80
      "episode-writer": {
        "model": "sonnet",                // 档位取值优先序（低→高）：SPECS 默认 < workspace scheduler
                                          //   < 项目 models/efforts 映射 < 项目 scheduler。
                                          //   cli=opencode 时取 provider/model 形（含 "/"，如 "openrouter/…"）——
                                          //   Claude 档位名（opus/sonnet…）绝不透传 opencode（省略 -m 落其默认）
        "effort": "high",                 //   effort：codex 换算 reasoning effort（max→xhigh）；
                                          //   opencode 原样传 --variant（不换算）
        "intervalSeconds": 180,           // 上一 fire 结束 → 下一 fire 开始的间隔（非固定频率）
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
`source/adaptation-brief.md` 与指纹。它创建 `source-analysis+story-designer` Todo 票，并给 outline
写入 `Blocked-by`。story-designer 先用 `source select` 冻结本季范围，再每 fire 恰处理一块，
单独 commit 带 provenance 的摘要并用 `source checkpoint` 核验；全部完成后聚合三清单并调用
`source finalize`。只有 control.phase=`review-ready` 且 showrunner 将 source-analysis 票 Done，
通用 Blocked-by resolver 才能解锁 outline。任何外部拆书 skill 产物都不能替代这条证据链。

### 结构化故事伴随文件与质量门

source-analysis 通过后，Story Designer 同步维护人读 `outline.md` / `arcs/*.md` 与严格的
`story/outline.v1.json`。后者绑定 source plan、改编处置、角色 tier、场景复用、季级 beats 与
逐集 hook/agency/资产引用；人物/场景资产清单从它确定性派生，不由另一次模型调用重写。

Story Designer 按 `skeleton → beats → full` 三阶段运行 `writing-loop story validate`；
Showrunner/Evaluator 在各自门内独立重跑。`fail` 阻断交门，`skipped` 仅表示阶段未到，机器全绿
仍保留人工“合规但平庸”否决。完整 exact-key 契约见
[`story-design-schema.md`](story-design-schema.md)。正常操作者通过 Studio 查看，不需要手工执行
story/source 内部命令。

## 数据目录布局 — `<workspace>/.writing-loop/<project-key>/`

```
<workspace>/.writing-loop/
  workspace.json          # {version:1,id:"ws_<32 hex>"}；workspace 自有稳定 identity
  config.json             # workspace 项目索引（上文）
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
把 ID 解析到本项目的已登记文件：Ticket 来自本板；document 只允许 north-star、characters、
world、outline、foreshadow、story-state、production；episode 只接受数字集号；report/evaluation
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

## 剧本 repo 内文档树（由 add-script scaffold；详见 conventions §19）

```
bible/{north-star,characters,world}.md   outline.md   arcs/
ledgers/{foreshadow,story-state,production}.md   ledgers/archive/（滚存目录）
episodes/   evaluation/   source/（改编立项）
```

（三个活跃账本 foreshadow/story-state/production + archive/ 滚存目录，§19 单一真相源。）

## Server-only production runtime（不属于 workspace config）

远程制片 worker 使用独立的 owner-only JSON，通过
`writing-loop-production-worker --config /absolute/production-runtime.json --once` 装配。该文件不是
`.writing-loop/config.json` 的字段，Studio/API/intent/enqueue 也不能覆盖它。完整且由 strict parser
执行验证的 v1 fixture 见
[`docs/design/phase-3-remote-production/AI-SPEC.md`](https://github.com/dyzsasd/writing-loop/blob/main/docs/design/phase-3-remote-production/AI-SPEC.md#9b-phase-3c-%E9%83%A8%E7%BD%B2%E4%B8%8E-runtime-contract)。

顶层 exact keys：`version`、`workspaceId`、`projects`、`backends`、`gateway`、`workflows`、
`stagingProfiles`、`runner`。文件必须是当前 euid 所有、单链接普通文件，mode 只能 `0400`/`0600`；
workflow graph 同样按有界单链接普通文件逐次读取并复核 inode/digest。配置只允许保存 `credentialEnv`
环境变量名，不允许保存 token、Authorization header、任意请求 URL 或签名资产 URL。

- `production-gateway` backend：credentialed HTTPS、固定 safe path、server profile alias；按 project
  构造 scope-bound adapter。
- direct `comfyui` backend：仅无凭据 literal-loopback HTTP development endpoint；正式远程部署禁止。
- workflow：完整 backend/model/workflow/parameters tuple、显式 projects allowlist、必填
  `inputPolicy: static-pre-staged | scoped-staging` 与 `h3GraphContract`（generic 必须为 `null`）；MiniMax H3
  只能用 `scoped-staging`。H3 contract 固定 native generator、768 short-edge canvas、24fps 对应的
  `17k+5` length、diffusion/text encoder/video VAE/audio VAE 四组件 bundle digest、active
  SigmaShift→guider/scheduler→sampler→双 decode→CreateVideo→SaveVideo pipeline，以及实际参数投影 digest。
- staging profile：完整 H3 execution 与有序 `index/slot/source/consumer`。v1 source 只能是
  `LoadImage.image` output 0；consumer 必须是 contract 中真实 H3 generator 的 `first_frame`、
  `last_frame` 或 `ref_images.ref_image_N`。source→consumer exact edge、无 fanout、无 decoy node 与 provider
  key 唯一性都在 graph verifier 中证明；未知/漂移 profile 在预算与 provider I/O 前 fail-closed。
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

## 校验规则（onboarding plan/create 必须通过）
- workspace 根已由 `writing-loop init` 确立（`.writing-loop/config.json` 存在，§11/§13）。
- `repoPath` 的父目录存在，目标路径**尚不存在**，且不能是 workspace 根、其祖先或
  `.writing-loop/` 内部；相对路径解析后必须仍在 workspace 内。CLI 允许显式外部绝对路径但
  告警失去整体复制迁移能力；Studio 只允许 workspace 内相对路径。
- `paywall.card1 ⊂ [8..12]`；`totalEpisodes` 与 format profile 惯例带一致（越界要求确认）。
- `audience` 非空且含性别+年龄要素（评估红线①的入口预防）。
- key 全 workspace 唯一；`ticketPrefix` 冲突时要求显式改名；PATH 中必须有 Git，create 才能
  生成并验证首个 scaffold commit。
