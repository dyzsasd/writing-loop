# writing-loop

[English](README.md) · **中文** · [Français](README.fr.md)

**一个文件夹里的自治短剧编剧团队。** 9 个可启动 agent（总编剧、细纲师、编剧、
审读、剧本医生、评估官、市场监察、reflect、sweep）在一块本地工单板上，通过工单
状态协作，把一个**竖屏短剧**点子规划、拉纲、成稿、审读、评分——你给设定，团队
把它做成一部连贯的 60–100 集连续剧。

你是**总编剧之上的导演**，不是逐行编辑：工作从总编剧进件（绝不直塞给编剧），
关键集（keystone）由细纲师亲笔先行，每一稿都由独立于作者自述的审读来验收，
里程碑由一份你看得懂的 rubric 把门。

> ### ▶ 从这里开始 → **[使用指南：从一部小说到一部剧本](docs/GUIDE.zh-CN.md)**
> 最重要、最实用的一份文档——从安装插件到跑出第一份可交付的「一卡包」，全程手把手。
> 新用户请先读它。

> 内部怎么跑——分层、账本、门禁拓扑、反漂移协议：见
> [`docs/DESIGN.md`](docs/DESIGN.md)。本 README 讲的是怎么**用**它。

---

## 这是什么

一个文件夹 = 一个 project = 一部剧 = 一块本地板。里面一支小团队用四样东西把长剧
撑住连贯——这四样正是 citron 级 AI 剧本会跳过的：

- **一本圣经**（`bible/north-star.md` + 人物 + 世界观）——冻结的战略层：一句话
  故事、定位、核心情绪引擎、结局承诺、创作红线。
- **一份总大纲**（`outline.md`）——单元表、高潮五锚点、卡点规划、季级主线伏笔
  登记表、名场面与续季钩规划。
- **逐集节拍单**（`arcs/arc-NN-*.md`）——骨架与成稿之间的契约：每集的狠点子、
  三轴推进、爽点、尾钩、伏笔操作、**禁写**边界，外加落选的候选案及其弃因。
- **三本账本**（`ledgers/`）——`foreshadow.md`（planted → refreshed → paid）、
  `story-state.md`（可重建的状态 + 逐集末态 + 被动标记）、`production.md`（场景/
  角色注册表 + 成本计数器）。每集开写前先读三账本，交付时在同一 commit 里逐条
  带行号地写回一份**账本 delta 声明**。

里程碑由评估官依一份**四维十六指标 rubric** 把门：前三集微门、大纲定稿门、
**一卡包（一卡门）**——第一个真正的交付里程碑——随后是卡二门、卡三门、完本门。

两种立项：**小说改编**（拆书——把原著拆成三张清单）或**原创**（附一到两部对标剧
的轻量拆解）。

## Quick start

**1. 安装插件**（一次）。在 **Claude Code** 内：

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

或在 **Codex** 内（同一套 skill、同一块本地看板，两个 CLI 都能跑；见 conventions §24–§25）：

```
codex plugin marketplace add dyzsasd/writing-loop
```

Codex 还可作为可选的**加速器**（按项目 `codex` 配置 opt-in）：**图像生成**——把 bible 的
视觉 token 变成人物/场景概念图；以及给审读/剧本医生的**异构第二引擎审查**。未装或关闭 ⇒
一切行为完全不变。

要直接使用 Studio/命令、确定性立项、内建 scheduler 与板工具，请安装 **`writing-loop`
npm CLI**。`add-script` skill 可 fallback 到插件内置 core；已有项目也可不装全局 CLI、只用
slash agent。

```bash
npm i -g @dyzsasd/writing-loop    # writing-loop run / status / doctor / fires …
```

在 workspace 目录中打开本地编剧工作台：

```bash
writing-loop init                 # 每个 workspace 一次：创建 .writing-loop/
writing-loop studio               # http://127.0.0.1:8791/
writing-loop workspace list       # 本机 workspace 索引
writing-loop snapshot             # 输出与 UI 相同的多项目 JSON 投影
writing-loop project list         # 包含已暂停剧本
writing-loop production status    # 本地权威 take/QC 账本；不会连接远端服务
writing-loop production enqueue --plan --project demo --input enqueue.json
writing-loop production enqueue --confirm wlprodplan_… --project demo --input enqueue.json
writing-loop-production-worker --config /etc/writing-loop/production-runtime.json --once --json
writing-loop production handoff --project demo --input handoff.json  # 仅 approved take；输出 canonical JSON
writing-loop project plan --input request.json
writing-loop project create --input request.json --confirm wlplan_…
writing-loop project verify my-drama
```

`init` 会为 workspace 在 `.writing-loop/workspace.json` 建立一个持久、不透明的 ID，并尝试
把规范化后的路径登记到有界的本机索引：`$WRITING_LOOP_HOME/workspaces.json`（默认
`~/.writing-loop/workspaces.json`；索引写失败会告警，但不会把已成功的 init 判失败）。也可显式管理：

```bash
writing-loop workspace add ../another-room --label "古装短剧"
writing-loop workspace list --json
writing-loop workspace remove ws_0123456789abcdef0123456789abcdef
writing-loop studio --workspace ws_0123456789abcdef0123456789abcdef
writing-loop studio --single       # 强制保留单 workspace 的旧 URL
```

registry 只是可重建的本机便利索引，不是项目真相源：普通 CLI 仍按 CWD /
`WRITING_LOOP_WORKSPACE` 找根；`remove` 只删指针，绝不删 workspace。登记项超过一个时，
Studio 首页成为作品工作区总台，每个 workspace 的所有路由都进入 `/w/<workspace-id>/`
命名空间；只有一个 workspace（或传 `--single`）时，原有 `/p/...`、`/api/...` 地址保持兼容。

Studio 只监听本机，以服务端渲染呈现作品书架、故事成熟度、创作任务、人工决策门、
最近分集和正在工作的 Agent。“新建项目”与 `/writing-loop:add-script` 都先做操作者在场的
采访，再调用同一个 onboarding core：生成确定性的**零写入 plan**，要求显式确认 `planId`，
才原子预留最终目录、在 journal 下创建并写后回读验证。上面的 CLI 暴露同一套
plan/create/verify 边界。自动立项只
创建全新 repo；Studio 还把目标限制在当前 workspace 内。
config 让项目可见前，durable 每项目 journal 允许在完整 commit/manifest 已落盘时，以
**同一 request + 原 `planId`**从真实进程崩溃续跑；摘要前的半成品会原样保留并硬停人工审计。
发布后 receipt 让重试幂等。恢复需要显式重跑，不是后台 daemon；config/templates
漂移、PID 仍活、产物被改或所有权歧义都会硬停人工审计。

项目页可按服务端白名单只读打开 Ticket、剧情文档、分集、报告与评估详情。活动时间线由
每项目运行态中的持久、可重建 `ActivityIndexer` v2 缓存支持；源账本、Ticket 与剧本文档仍是
权威真相。元数据签名未变化时跳过深扫；首次有界建索引、保留上限或损坏重建造成的缺口都会
显式告警。分页 cursor 绑定 workspace、项目与 index generation，不能跨域复用。
`run-state.json` 只叠加实时运行 Agent，不写进历史。

Studio SSE 的 event ID 由稳定 snapshot 与各项目持久 index revision 共同生成；Studio 进程重启后，
浏览器仍可用 `Last-Event-ID` 续接。来自另一个 workspace 或 fleet 流的 cursor 会被拒绝，而不是
静默串流。SSE 只是变更通知，历史仍以有界 activity API 为准。只展示账本可证实的模型与时长；
账本没有 token/账单证据时，
用量与成本明确显示 **unknown / 未记录**，绝不估价。除确认立项外，Studio 的其他写面仅为
原子暂停/恢复。scheduler 检测到暂停后停止新派发，完成 graceful drain 才释放项目锁。

编剧团队可跑在**三个引擎**任一之上——Claude Code（默认）/ Codex / opencode
（`writing-loop run --cli opencode`；见 conventions §25）。

**2. 立项**——在已 init 的 workspace 中点 Studio“新建项目”，或运行立项 skill。请选择一个
**尚不存在**的 repo 路径，不要先建文件夹。attended interview 收题材、受众、monetization、
合规预筛；改编另收授权与拆书阈值。确认零写入 plan 后，共享 core 才生成文档树、注册项目、
file 第一张大纲票，并验证三处 ground truth：

```
/writing-loop:add-script
```

**3. 运行团队。** 每个 agent 都是一个 slash 命令；每次 fire 无状态，都从板 + repo
重读 ground truth。按自然顺序依次驱动，或用外部 `cron` 调度：

```
/writing-loop:showrunner-agent         # file 大纲票、把大纲门、放行队列
/writing-loop:story-designer-agent      # 写 outline+bible，再写逐集节拍单、spawn 单集票
/writing-loop:episode-writer-agent      # 按集序拾取单集票、写正文、声明账本 delta
/writing-loop:reviewer-agent            # 逐集独立验收（三分类、断言带正文引文）
/writing-loop:evaluator-agent           # 执行里程碑门（大纲定稿、一卡包、完本…）
/writing-loop:script-doctor-agent       # 慢频轮换维度的剧级审计
/writing-loop:market-watch-agent        # 周频扫榜 + 平台政策监察
/writing-loop:reflect-agent             # 日频 retro + lessons 策展
/writing-loop:sweep-agent               # 板生命周期卫生：错标修复、孤儿回收
```

**没有远程后端**——板仍是 `<workspace>/.writing-loop/<project-key>/board/`
下的一堆纯文件；可选 Studio 只是从这些文件重建的本机视图。调度要么手动 slash、
要么 `writing-loop run`、要么你自己的 `cron`。拷走文件夹即完成迁机。

总编剧把队列压浅（Backlog-first，只有它能放行到 Todo），单集票在一道顺序前置后
严格按集序流转，任何 fail 都走三级路由（notes 回炉 → `Mode: direct-write` →
人工停靠）而非卡死。

## 角色表

| 角色 | dev-loop 原型 | 职责 |
|---|---|---|
| **总编剧** Showrunner | PM | north-star + outline 唯一维护者；立项/方向 intake；file 创作票；把大纲门；发起 milestone-eval 票；Backlog 闸门。 |
| **细纲师** Story-Designer | senior-dev | 把 arc 票拆成逐集节拍单（含候选竞争 + 弃案）、spawn 单集子票、**亲写 keystone 集**、接 `Mode: direct-write` 升级、执行 punch-up。 |
| **编剧** Episode-Writer | junior-dev | 拾取单集票，读节拍单 + 三账本 + 上一集，写正文，自检，声明账本 delta，交审读。 |
| **审读** Reviewer | QA | 逐集独立验收：三分类、邻集对读、delta 逐条核对——**每条叙事断言必须带正文引文**。fail 走三级路由。 |
| **剧本医生** Script-Doctor | Architect | 慢频、SHA 门控、轮换维度的剧级审计（伏笔闭环、钩型序列、五锚点、被动率滑窗、指纹一致性、账本回放）。只 file，不改字。 |
| **评估官** Evaluator | — | 执行 milestone-eval 票：六道门、rubric、红线。报告分「机内断言 / 待实测」。 |
| **市场监察** Market-Watch | Ops | 周频扫榜 + 平台政策；带日期的题材窗口评估；窗口关闭/红海或政策新规 ⇒ file `needs-showrunner` 票。 |
| **reflect** | Reflect | 日频 retro；从复现证据策展操作者级 `lessons.md`。 |
| **sweep** | Sweep | 生命周期卫生：错标修复、孤儿回收、板健康摘要。 |

外加操作者 skill **`add-script`**——立项 interview、脚手架、注册。

完整角色契约：[`docs/DESIGN.md`](docs/DESIGN.md) §1 +
[`references/conventions.md`](references/conventions.md)（拓扑一览）。

## 文档体系

每个项目都是一个 git repo，文档即代码：

```
<script-repo>/
  bible/{north-star,characters,world}.md   # 冻结层——改动走 showrunner / 大纲门
  outline.md                               # 总大纲：单元表 + 高潮五锚点 + 卡点规划
                                           #   + 季级主线伏笔登记表 + 名场面 & 续季钩规划
  arcs/arc-NN-<slug>.md                    # 逐集节拍单 + 候选竞争 & 弃案记录
  ledgers/                                 # 活跃层（O_EXCL 锁；≤15KB rollup 纪律）
    foreshadow.md                          #   伏笔账本（planted → refreshed → paid；含续集钩状态）
    story-state.md                         #   当前态 + 逐集末态摘要 + 被动标记
    production.md                          #   制作预算：场景/角色注册表 + 成本计数器
    archive/arc-NN.md                      #   每 arc 滚存
  episodes/ep-NNN.md                       # frontmatter 指纹（节拍单哈希 / model / 规则版本）+ 正文
  evaluation/                              # 里程碑报告 + 切片清单
  source/                                  # 改编：原著文本 + 拆书三清单
                                           #   原创：对标剧轻量拆解
```

两条纪律防「已过门工件被静默改写」：每集记下它写作时所依据节拍单的**内容哈希**
（医生每轮比对即得全部过期集清单），且大纲门之后对 arc/outline 的任何改动都要走
**delta 复审**、为受影响的 Done 集自动开连续性票。

## 里程碑门

评估官依 rubric 与红线跑六道门，且**只**执行总编剧 file 的 `milestone-eval` 票：

| 门 | 触发 | 要点 |
|---|---|---|
| **前三集微门** | ep3 Done | 钩子强度：第 1 集反常识冲突、首次高潮、尾钩序列。 |
| **大纲定稿门** | 大纲成稿 | 市场层（引用 market-watch 带日期评估）+ 内容层预评 + 合规 + 伏笔登记表覆盖。 |
| **一卡包（一卡门）** | 卡点前全部成稿 | 卡点结构、完播率结构代理、切片清单、制作层累计、窗口期复核。**第一个真正的交付里程碑。** |
| **卡二门** | 中段 | 中段结构 + 制作层累计 + 市场层复核。 |
| **卡三门** | 2/3 处 | 2/3 深谷落位与深度、换轨成立性、终局总动员资产盘点（逐项核正文）。 |
| **完本门** | 全剧 Done | 全量 rubric + 定级 + 续季钩兼容。 |

红线触发要么 file Urgent `redline` Bug（可修），要么把评估票停靠给人裁决
（一票否决类）。市场层无新数据时报告判「inconclusive」，绝不编造。

## 治 citron 的病

writing-loop 的设计从一部失败 AI 连续剧（citron-script）的尸检出发：它不缺编剧
知识——它缺**规划层与执行层之间的机制性保证**。每个症状对上一套机制，而不是一句
劝诫：

| citron 症状 | writing-loop 机制 |
|---|---|
| 成稿时**看不到上一集** | 顺序前置（集 N 等 `ep-(N-1)` 落 main）+ 每集开写前必读上一集末帧与三账本。 |
| **伏笔零表示**——埋了就忘 | `foreshadow.md` 三态账本 + 大纲季级登记表 + 医生的机器闭环审计（到期未收、未埋先收、>8 集未擦亮）。 |
| **成稿是唯一无 audit 的环节** | 每集由审读独立三分类验收，**每条叙事断言必须带正文引文**（不可引证 = inconclusive = 不 pass）。 |
| **主角漂向被动** | 节拍单主动性字段 + `story-state` 累计标记 + 医生 10 集被动率滑窗（>30% 即 file Bug）。 |
| **骨架与成稿脱节**、高潮拍落地平淡 | 逐集节拍单是硬契约；keystone 集由细纲师亲笔；里程碑门对照 rubric 验收结构。 |

完整对照（citron 十条教训 → 各自的机制载体）见
[`docs/DESIGN.md`](docs/DESIGN.md) §0。

## 与 dev-loop 的关系

writing-loop 搭在 **[dev-loop](https://github.com/dyzsasd/dev-loop)** 的机制骨架
上——机制同源，是刻意的设计。工单状态机、Backlog-first 进件、三分类验收、
claim/dedupe/blocked 协议、两层创作分工（senior 设计 → junior 实现）、
observe-and-file 契约、lessons + reflect 自进化闭环、本地文件板协议，全部照搬。
对照：

| dev-loop | writing-loop |
|---|---|
| PM → strategy doc | 总编剧 → north-star |
| senior-dev / junior-dev | 细纲师 / 编剧 |
| QA | 审读 |
| Architect | 剧本医生 |
| Ops | 市场监察 |
| design doc | arc 节拍单 |
| build/test 门 | 格式 + 叙事门禁 |
| coverage 强制令 | 账本回写强制令 |
| 自动回滚 | fail-revert 协议 |

砍掉的：PR / auto-merge / deploy、多 repo change-gate（思想保留给医生）、
Linear/hub backend（v1 纯本地）、Communication/Codex agent。完整的照搬/替换/砍掉
台账见 [`docs/DESIGN.md`](docs/DESIGN.md) §11。

## v1 边界

- **仅本地板。** 唯一真相源是 `<workspace>/.writing-loop/` 下的纯文件板（协议见
  [`references/conventions.md`](references/conventions.md) §18）。Studio 是仅限本机的
  观测投影（写面只有确认立项与启停），不是第二套 backend。无 Linear、云服务或网络盘。
  调度可用手动 slash、内建 scheduler 或自己的 `cron`。
- **Phase 2 基础能力已完成，但还不是完整产品 parity。** 指纹确认立项、同指纹 journal
  崩溃恢复、白名单详情、持久有界 activity、跨重启 SSE、稳定 workspace identity/registry 与
  多工作区 Studio 命名空间均已交付。更丰富的写作指标和真实 provider 成本仍需权威账本先增加
  字段；没有证据时继续显示 `unknown`，绝不估算。
- **Phase 3C 已交付可远程部署的制片 control plane 与私有 Gateway 内核，但还不是打包好的 GPU
  一体机。** 在 Phase 3A/3B 的 revision/AssetRef、原子账本、门禁、精确单次提交与恢复协调器之上，
  当前已有零网络 plan/confirm enqueue、一轮式 `writing-loop-production-worker`、owner-only runtime
  config、逐 workflow 输入策略、H3 四模型/fixed-pipeline contract、source→consumer staging、
  template→bound graph materialization、verified receipt、durable admission settlement，以及 scope-bound
  stage/job/output Gateway 与统一 strict router。Studio 的 production HTTP 面仍只读；endpoint、profile、
  token 不能从浏览器或 enqueue argv 注入。正式部署仍需提供 H3/ComfyUI 推理、TLS/mTLS、凭据签发、
  server profile 与模型/custom-node attestation、资产存储、durable admission/配额和真实账单对账。
  文档中的 representative API-format fixture 尚未经过 live ComfyUI `/prompt`，不代表 H3 已部署。
  H3 位于镜头音视频生成层，不替代 writing-loop 的剧本写作模型；MiniMax 地域/商业许可仍是上线门禁。
- **仅已校准题材。** R 规则的数值参数已（基于证据）校准的是**脑洞爽剧 / 复仇
  打脸 / 职业单元剧**。女频甜宠 / 虐恋 profile 出厂即标 **`UNCALIBRATED`**（参数
  为暂定值）——`add-script` 在未校准题材立项时会显式警告。
- monetization 与 format 均为一级开关（`paid-app | free-hongguo | reelshort-sub`；
  `live-action | ai-anime | reelshort-en`），会改变门位与卡点语义。

## License

[MIT](LICENSE)。
