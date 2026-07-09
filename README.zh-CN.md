# writing-loop

[English](README.md) · **中文** · [Français](README.fr.md)

**一个文件夹里的自治短剧编剧团队。** 9 个可启动 agent（总编剧、细纲师、编剧、
审读、剧本医生、评估官、市场监察、reflect、sweep）在一块本地工单板上，通过工单
状态协作，把一个**竖屏短剧**点子规划、拉纲、成稿、审读、评分——你给设定，团队
把它做成一部连贯的 60–100 集连续剧。

你是**总编剧之上的导演**，不是逐行编辑：工作从总编剧进件（绝不直塞给编剧），
关键集（keystone）由细纲师亲笔先行，每一稿都由独立于作者自述的审读来验收，
里程碑由一份你看得懂的 rubric 把门。

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

**1. 安装插件**（一次，在 Claude Code 内）：

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

**2. 立项**——在一个空的项目文件夹里运行立项 skill。它会做 interview（题材、
受众画像、monetization、合规预筛；改编项目另加原著文本 + 拆书），脚手架出 bible /
outline / ledgers / episodes 目录树，注册项目，并 file 第一张票（大纲票）：

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

**没有单独的 CLI、也没有服务端**——板就是 `~/.writing-loop/<project-key>/board/`
下的一堆纯文件，调度要么手动 slash，要么你自己的 `cron`。拷走文件夹即完成
迁机。

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

- **仅本地板。** 唯一 backend 是 `~/.writing-loop/` 下的纯文件板（协议见
  [`references/conventions.md`](references/conventions.md) §18）。无 Linear、无 hub、
  不用网络盘。调度靠手动 slash 或你自己的 `cron`。
- **仅已校准题材。** R 规则的数值参数已（基于证据）校准的是**脑洞爽剧 / 复仇
  打脸 / 职业单元剧**。女频甜宠 / 虐恋 profile 出厂即标 **`UNCALIBRATED`**（参数
  为暂定值）——`add-script` 在未校准题材立项时会显式警告。
- monetization 与 format 均为一级开关（`paid-app | free-hongguo | reelshort-sub`；
  `live-action | ai-anime | reelshort-en`），会改变门位与卡点语义。

## License

[MIT](LICENSE)。
