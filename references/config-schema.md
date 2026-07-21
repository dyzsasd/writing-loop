# 配置 schema（config-schema）

> writing-loop 的 workspace 索引与项目配置。运行时状态（board/lessons/reports）一律在
> **workspace 根下的 `.writing-loop/`**（workspace-rooted 布局，§11），是各剧本 repo
> **之外**的兄弟目录——**永不进剧本 repo** 的 git 历史。复制整个 workspace 文件夹即
> 整体迁移（含在制工单）。

## Workspace 根解析（§11）

`.writing-loop/` 所在的目录 = workspace 根。**默认规则只有一条,无配置项**
(用户非技术型,保持最简):从 CWD 向上逐级找已存在的 `.writing-loop/`(像 git 找
`.git`),首个命中的父目录即根。找不到 ⇒ 未在 workspace 内,请先 `add-script` 立项
(由它确立 workspace)。另留一个显式逃生门:env `WRITING_LOOP_WORKSPACE`(绝对路径,
且其下真含 `.writing-loop/`)可显式覆盖走查;坏值硬错,绝不静默降级到向上走查
(与 hub/README、`hub/src/workspace.ts` 同口径)。

## workspace 索引 — `<workspace>/.writing-loop/config.json`

```jsonc
{
  "version": 1,
  "projects": {
    "shen-shou-park": {                    // project key（目录/板前缀作用域）
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

运行时产物（都在项目数据目录）：**遥测账本 `fires.jsonl`**——每 fire 追加一行
`{agent, model, effort, startedAt, endedAt, durationSeconds, exitCode, timedOut, noop,
keystoneEscalated}`；`noop` 从 fire 输出的尾行「no-op」标记检出（§0 廉价探针的一行
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

- `writing-loop init` —— 引导确立 workspace（创建 `.writing-loop/` + config.json 骨架；
  立项采访仍走 `/writing-loop:add-script`）。
- `writing-loop run` —— **上节内建调度器的本体**（原生 TS 实现在包内，无 Python 依赖）：
  语义与上节完全一致，全部 flag（`--dry-run`/`--once`/`--cli` …）见上节 CLI 面。
- `writing-loop status` —— 只读打印各项目板状态摘要（frontmatter 统计，不拿锁）。
- `writing-loop doctor` —— 环境自检：所选引擎 CLI 在位、config 可解析、残锁检测。
- `writing-loop fires` —— `fires.jsonl` 遥测账本的摘要视图。
- `writing-loop install-claude-plugin` —— 把 npm 包内的插件注册为本地 marketplace 源并装进
  Claude Code（版本钉住 CLI 自身版本）。

## 数据目录布局 — `<workspace>/.writing-loop/<project-key>/`

```
<workspace>/.writing-loop/
  config.json             # workspace 索引（上文）
  <project-key>/
    board/
      counter.json        # { "prefix": "WL", "next": 42 }（hint；真相是 O_EXCL 独占创建）
      tickets/WL-1.md …   # 一票一文件：YAML frontmatter + 模板正文 + append-only 评论区（§18）
    lessons/              # §14 按角色分文件 lessons（per-operator：shared.md + <role>.md；
                          #   迁移期可见旧 lessons.md / lessons.md.migrated 留档）
    reports/              # §22 daily/weekly/monthly + *.review.md 操作者点评
    state/                # agent 小状态（showrunner 的 lens 轮换、doctor 的 SHA 指纹等）
    fires.jsonl           # 调度器遥测账本（每 fire 一行 JSON；上节）
    logs/                 # 调度器每 fire 全量输出（<UTC时间戳>-<agent>.log）
    wl-run.lock           # 调度器防重跑锁（运行中在位；退出释放；锁名 0.4.0 连续性保留）
```

整个 `.writing-loop/` 是 untracked 运行时状态，是各剧本 repo 的**兄弟**目录，不进
任何剧本的 git 历史。迁移 = `cp -r <workspace> /new/place`（相对 repoPath + 状态目录
一起复制；用 `cp` 不是 `git clone`——clone 只带单个剧本 repo，不带在制工单）。

## 剧本 repo 内文档树（由 add-script scaffold；详见 conventions §19）

```
bible/{north-star,characters,world}.md   outline.md   arcs/
ledgers/{foreshadow,story-state,production}.md   ledgers/archive/（滚存目录）
episodes/   evaluation/   source/（改编立项）
```

（三个活跃账本 foreshadow/story-state/production + archive/ 滚存目录，§19 单一真相源。）

## 校验规则（add-script 写入前必须通过）
- workspace 根已确立（`.writing-loop/` 存在或本次创建，§11/§13）。
- `repoPath` 解析后存在且是 git repo（相对路径按 workspace 根解析）；**剧本 repo 应在
  workspace 根之内**（否则告警：该项目将失去随 workspace 复制的可迁移性）；board 目录
  专用（空或 writing-loop 脚手架）。
- `paywall.card1 ⊂ [8..12]`；`totalEpisodes` 与 format profile 惯例带一致（越界要求确认）。
- `audience` 非空且含性别+年龄要素（评估红线①的入口预防）。
- key 全 workspace 唯一；`ticketPrefix` 冲突时要求显式改名。
