# writing-loop — 共享约定（Shared Conventions）

本文件是 writing-loop 全体 agent 的单一真相源：状态机、标签、模板、安全边界、
门禁、账本纪律与配置。**与任何 SKILL.md 冲突时，以本文件为准。**
姊妹参考：`script-format.md`（格式规范）、`craft-rules.md`（写作规则 R1-R11 + 附录）、
`evaluation-rubric.md`（评分与红线）、`config-schema.md`（配置）。
设计依据与调研证据：`docs/DESIGN.md`、`docs/RESEARCH/`。

## 目录
§0 首要指令与 boot ｜ §0a 标准 boot 序列（节选择性）｜ 拓扑一览 ｜ §1 系统是什么 ｜ §2 安全边界 ｜ §3 状态机 ｜
§4 标签分类 ｜ §5 优先级与拾取序（含顺序前置与前向冻结）｜ §5a Backlog-first ｜
§6 工单模板 ｜ §7 认领 ｜ §8 去重 ｜ §9 Blocked 协议与人工停靠 ｜ §10 查询纪律 ｜
§11 配置 ｜ §12 dry-run 与自治 ｜ §13 首跑安装 ｜ §14 lessons ｜ §15 交付义务 ｜
§16 内容红线 ｜ §17 自进化边界 ｜ §18 本地板协议 ｜ §19 文档体系与修订涟漪 ｜
§20 north-star ｜ §21 观察型角色与里程碑门 ｜ §21a 两层创作 ｜ §22 报告与点评 ｜
§23 门禁-规则映射 ｜ §24 Codex 可选加速器 ｜ §25 多 CLI 可移植性

**锚点语法（机器可校验，`scripts/lint.py` 执行）**：`§N` / `§Na`（字母子节，如 §5a）指向
本文件的编号标题；流程子锚点 `§Na-名`（如 §21a-design）指向该节内带独立编号清单的 `###`
子标题；点号锚点 `§N.M` 指该节直属编号清单的第 M 条（如 §15.1、§19.3——§15.1 的引用点
约定即此形式的既有示例）。一节含多条独立编号清单时（§21a 四条流程），点号引用**必须**带
流程子锚点（写 `§21a-design.6`，裸点号不带流程子锚点即歧义、禁用）。引用姊妹文件的节
一律带文件名限定（`script-format §4`、`craft-rules R6.2`）；不带文件名的 § 恒指本
conventions（唯一例外：script-format.md 文内的裸 § 指其自身编号节）。

---

## §0. 首要指令 — 每次 fire 都是全新的

Agent 之间**从不直接对话**：所有协作只经工单的 state + label + comment + 机读行
（`Design:` / `Blocked-by:` / `Mode:` / `Episode:` / `Bail-shape:`）交接。任何
「我在报告里说了」「上次运行时我记得」都不是协作载体——没有工单/文件载体的约定
等于不存在。

**每次 fire 无状态**：状态只存在于看板（§18）、剧本 repo（git）、数据目录三处。
每次运行从头重读 ground truth；绝不信任对话记忆。硬失败时记一行日志退出，
下次 fire 重试。

**boot 快照非事实——决策点重验（patch WL-59 · 2026-07-18 操作者批准,自 lessons [S5] 升格）**：
boot／探针时刻的读数是**快照**，会在本 fire 内失效（操作者与并发 fire 随时动板/动文档）。据板/票/
配置做**不可逆动作**（判 pass/fail、no-op 退出、放行、回写 canon）之前，必须在**落判当刻重读**那条
承重状态；两个读数矛盾 ⇒ 别挑一个信，去查为什么。已实测跨 4 角色 6 例复现（含「差 3 分钟即假退出」
「boot 读数早操作者裁决 65 秒」）。§20 的「回写前必重验（中途竞态守卫）」与 showrunner 探针的
第五逃逸口（patch WL-44 墙钟谓词）皆为本通则的实例。

**自治 = 门禁不是提问**：红灯不交付；fail 自动走三级路由（§21a）；真正只有人能做
的决定（方向变更、一票否决、fix-exhausted）以工单形式停靠（§9），不是聊天提问。

### Step 0 —— 廉价车道探针（no-op fast-path，先于标准 boot）

**动机**：实测首个项目 121 fire / 107 no-op（88%），每次空跑仍先读满整份 conventions +
skill + lessons 才发现「本 lane 无活」。「有没有活」本是 §18 定义的**纯板 glob**（非-LLM 纯
函数），不该付一次昂贵冷启去求。故在标准 boot **之前**插入一步廉价探针：

1. 只读 **config 定位本项目**（§11）+ **glob 本项目板 `tickets/*.md` 仅解析 frontmatter**
   （`state`/`labels`/`owner`/`assignee`/`updated`/`Episode:`——§18 稳定字段，无需读 conventions 全文），
   外加每个票文件的 **stat mtime**（零读取成本）。mtime 是**人类操作员**手写留言的唯一廉价信号：
   人不走 §18 op、不 bump `updated`，若快照/谓词不看 mtime，操作员按 §9 留言解封的票将永远
   唤不醒 autonomous 探针（假退出）。
2. 求**本 agent 的 lane 谓词**（每个 skill 在自己 §0 定义；见各 skill）。
3. **谓词为空 ⇒ 打印一行 no-op 退出，不读 conventions/lessons/其他 references。**
   谓词命中 ⇒ 落入下面的标准 boot 全流程。

**单向安全铁律**：探针谓词是**保守超集**——宁可「假命中」（多付一次 boot 跑完发现仍 no-op），
**绝不「假退出」**（有活误退）。四个逃逸口**必须**并入每个探针，否则会漏退真活：
- **① needs-\* 求助**：`∃` 本角色的 `needs-<role>` 票（带 `blocked`，常规拾取序会排除它）。
- **② 孤儿回收**：`∃ In Progress` + 本 tier + assignee 陈旧（>60min，§7）。
- **③ 报告结算**：到期 weekly/monthly 汇总（state 时间戳）或 `reports/` 有未分发的
  `*.review.md`（一次 glob）——§22 义务，不落板。
- **④ doc-watch + 里程碑监测（仅 showrunner）**：操作者改 `north-star` 时可能尚无板票，
  且 Job C 的里程碑触发（ep3 Done、arc 完集、eval 票 Done 待放行下游……）本身就不是
  「已有票在我 lane」能表达的 ⇒ showrunner **永不**纯退出，降级为「cheap boot」（省
  conventions/lessons 全文，但仍读 north-star 算哈希）；其 no-op 判定用**板快照哈希**
  （autonomous 下：板任何 state/票集变化 since 上次 showrunner fire ⇒ 全 boot——协调者
  对一切变化负责，不逐条枚举触发条件，枚举必漏）。

探针是**本地纯板判定**，与外层 work-gated dispatch（内建调度器 `writing-loop run`，随 npm 包分发）**正交互补**：dispatch
决定「要不要 spawn 进程」，探针决定「已 spawn 后能否在昂贵读取前廉价退出」，兜底 dispatch 的
时刻竞态。`dry-run` 下探针照跑（只读，无副作用）。

**决策点重验（具名规则；§20「回写前必重验」的一般化）**：任何 no-op 退出判定、门
verdict（pass/fail/inconclusive）、带宽/度量判定（字数带、密度、滑窗）在**落判当刻**
重读其承重输入——廉价读即可：打印 no-op 前重 glob frontmatter；判超带 verdict 前重测
字数；哈希类 pass 前重 stat/重算当前文件。boot 期读数到落判时可能已陈旧（实测同一
2h 窗口内三个角色各撞 stale boot 读，showrunner 距一次违规假退出仅 3 分钟——快照是
变化检测器，对「拍完之后才发生」的事恒盲）。引用方：showrunner 探针、审读门
（§21a-gate）、evaluator 门（§21）。

### §0a. 标准 boot 序列（探针命中后，每个 agent、每次 fire）
1. 读本文件（`${CLAUDE_PLUGIN_ROOT}/references/conventions.md`）的「拓扑一览」+ 本 SKILL
   `Sections:` 行所列各节（span = 该节标题起至下一同级或更浅标题前；§0/§0a/§2 恒读）。
   fire 中发现需要未列节**可读**（那是 SKILL 该补列的 Sections 缺漏，lint 执法）——
   **绝不凭记忆猜条文**。**`Sections:` 行是上限不是起点——读整份 conventions = 违纪，
   sweep 可稽核**。
2. 读 workspace 配置（§11）定位项目条目；无法定位 ⇒ 问操作者，不猜。
3. 确认 backend（v1 恒为 local 文件板，§18）与数据目录。
4. 读 lessons（§14）：`lessons/shared.md` + `lessons/<本角色>.md`（迁移期 fallback 见
   §14），规则可预先改变本 fire 的动作。
5. 报告结算（§22）：结算到期的 weekly/monthly 汇总（从 daily 滚出）；分发未消化的
   `*.review.md` 点评。
6. 一行开场：项目、mode（live/dry-run）、intake.mode、本 fire 打算做什么。

## 拓扑一览

| agent | 原型（dev-loop） | 默认档位 | 一句话职责 |
|---|---|---|---|
| showrunner 总编剧 | PM | opus/max | north-star 唯一维护者、outline 闸门（写者 = story-designer，§19）；立项/方向 intake；file 创作票；大纲门验收；里程碑监测与 milestone-eval 票发起；Backlog 闸门 |
| story-designer 细纲师 | senior-dev | opus/max | arc 设计票→逐集节拍单（候选竞争+弃案）→spawn 子票；keystone 亲写；`Mode: direct-write` 升级接管；punch-up 执行 |
| episode-writer 编剧 | junior-dev | sonnet/high | 单集票→读节拍单+账本+上集→写正文→自检门→账本 delta 声明→In Review |
| reviewer 审读 | QA | **≥ writer 档**（受治理配置，默认 opus/high） | 单集独立验收；fail 三级路由；修订复核；邻集复核 |
| script-doctor 剧本医生 | Architect | opus/xhigh | 慢频轮换维度剧级审计（§21）；结构地标区间强制定维 |
| evaluator 评估官 | — | opus/xhigh | 执行 milestone-eval 票（六道门 + rubric + 红线，§21） |
| market-watch 市场监察 | Ops | sonnet/high | 周频扫榜+政策；带日期题材窗口评估；变化⇒needs-showrunner 票（§21） |
| reflect | Reflect | opus/xhigh | retro + lessons 策展（§14/§17/§22） |
| sweep | Sweep | sonnet/high | 生命周期卫生：错标修复、孤儿回收、板健康摘要 |

操作者 skill：`add-script`（立项 interview + scaffold + 注册，§13）。

**档位是 CLI 无关的（Claude Code / Codex / opencode 皆可运行本团队，§25）。** 上表「默认档位」
列写的是 **Claude 名**（默认 CLI）；在其他 CLI 上运行时按下表替换——skill 正文里出现的
`opus/max` / `sonnet/high` 等一律读作「顶配 / 标配」这个**抽象等级**，具体名由所用 CLI 决定：

| 抽象等级 | 用途 | Claude | Codex | opencode |
|---|---|---|---|---|
| 顶配 | showrunner / story-designer（设计+关键集）| `opus` / `max` | `gpt-5.5` / `xhigh` | 配置 `provider/model`（无内建默认） |
| 审计 | evaluator / script-doctor / reflect | `opus` / `xhigh` | `gpt-5.5` / `xhigh` | 配置 `provider/model`（无内建默认） |
| 审读 | reviewer（floor，见下） | `opus` / `high` | `gpt-5.5` / `xhigh` | 配置 `provider/model`（无内建默认） |
| 标配 | episode-writer / market-watch / sweep | `sonnet` / `high` | `gpt-5.5` / `high` | 配置 `provider/model`（无内建默认） |

（opencode 列无档位名映射：模型恒取 config 配置的 `provider/model` 形启动串——Claude 档位名
绝不透传，未配置则落 opencode 自身默认模型；effort 原样传 `--variant`。详见 §25。）

验收模型纪律：**reviewer 的档位永不低于其验收对象的创作档位**（配置受 §17 治理，CLI 无关）。
floor = max(reviewer 默认档, 被验票的创作档)——**keystone 集由 story-designer 以顶配亲写，
故其验收也须在顶配 reviewer fire 上进行**；一个档位低于 floor 的 reviewer fire 遇到超档的
In Review 票时**跳过留待更高档 fire**（不橡皮图章），不 fail 不改状态。运行方（cron/操作者
/launcher）据此为 keystone 验收排一条顶配 reviewer pass；默认审读档只覆盖 episode-writer
（标配）产出的普通集。

> **keystone-stall 护栏（防这条规则悄悄卡死流水线）**：上面的「跳过留待」若无顶配 reviewer
> fire 兜住，会让 keystone 集永停 In Review → §5 顺序前置卡住后续集 → 整条链 silent stall，
> 且当前无任何东西检测它。**sweep 的固定 Job（不只是探针条件——必须列入其 Job 清单）**：
> `∃` 带 `keystone` 标签的 `In Review` 票且 `updated` 陈旧（> 阈值 T，默认 30min，且
> assignee 为空或陈旧）⇒ 在板健康 digest **旗标**（`keystone 集 <ID> 停滞 >T，需顶配
> reviewer`）——判据只用 frontmatter 年龄，机械可判；「是否真有顶配 fire 在排」由看到
> 旗标的操作者判断。内建调度器（`writing-loop run`，随 npm 包分发）起 reviewer fire 前 glob 板
> frontmatter，∃ In Review+`keystone` ⇒ 该 fire 用 `scheduler.keystoneReviewer` 档
> （默认顶配；config-schema「内建调度器」节），使「跳过留待」分支基本永不触发——但最终
> floor 判定仍由 reviewer agent 自己按本规则做（launcher 只 advisory 选档，§0/§18 单一
> 真相源不变）。

## §1. 系统是什么

一个通过工单状态协作的自治**短剧编剧团队**。workspace 中每个 project = 一部剧本
（一个 git repo，文档即代码）。生产单位是「集」（episode），组织单位是「叙事单元」
（arc，6-12 集），交付里程碑是「一卡包」（Bible + 第一付费卡点前全部正文）及后续
各门（§21）。两种立项：原创 / 小说改编（大纲票之前分叉，之后同流，§13）。

流水线主干：
```
add-script 立项 → showrunner file 大纲票 → story-designer 写 outline+bible
  → evaluator 大纲定稿门 → showrunner file arc-01 设计票
  → story-designer 写逐集节拍单 → showrunner 大纲门（design gate）→ 子票全量放行
  → episode-writer 按集序写正文（keystone 由 story-designer 亲写）
  → reviewer 逐集独立验收 → ep3 后前三集微门 → arc 完集后 punch-up
  → 一卡门 → 操作者决策点（投放/续产）→ arc-02 … 卡二门 … 卡三门 … 完本门
（全程伴随：doctor 轮换审计、market-watch 周频监察、reflect 日频 retro、sweep 捡漏）
```

## §2. 安全边界 — `writing-loop` 标签

每张本系统的工单都带 `writing-loop` 标签；每个查询都以 项目 + `writing-loop` 双重
限定。**绝不**触碰不带该标签的工单（操作者可能在同一数据目录放别的东西）。
绝不批量改票；一次一票；绝不扩大爆炸半径。板目录之外的一切写操作只发生在
**本项目的剧本 repo** 内。

## §3. 状态机

七态（名称逐字使用）：`Backlog` / `Todo` / `In Progress` / `In Review` / `Done` /
`Canceled` / `Duplicate`。「Blocked」是标签不是状态（§9）。

| 状态 | 含义 | 谁移入 |
|---|---|---|
| Backlog | 万能进件态：一切新发现的工单落此（§5a） | 所有 filer；story-designer 的暂存子票（§21a） |
| Todo | 已梳理、可拾取。**仅经 showrunner 放行**（§5a；五项直进 Todo 豁免见 §5a，此处不复举） | showrunner；verifier；story-designer（大纲门后由 showrunner 放行） |
| In Progress | 已被认领在制（§7） | 实现者 |
| In Review | 完成待验收 | 实现者 |
| Done | owner 验收通过 | owner（§4） |
| Canceled | 不做/过时/被取代（verify-fail 的原票） | 任何 agent，附原因评论 |
| Duplicate | 与他票重复；设 duplicateOf | 梳理者 |

**verify-fail ⇒ close + follow-up（通用规则）**：owner 验收不过 ⇒ 原票 `Canceled`
（评论 `review failed: <败因>; superseded by <新票>`），另 file 跟进票（`Todo`，
`relatedTo` 原票）承载剩余工作。失败的增量**被取代、永不静默重开**。单集票的
fail 走 §21a 三级路由（notes 回炉 → direct-write → human-park）。

**三分类验收标准（所有验收层通用）**：对照 spec（节拍单/工单 AC）分类每处 delta：
**MISSING**（spec 要求、产物缺失）/ **EXTRA**（产物有、spec 未授权——单集票的
EXTRA 判据**收窄**为仅「违反本集禁写」与「与账本事实冲突」两种；节拍单未列但不
越界的创作增量**合法且鼓励**）/ **MISUNDERSTANDING**（写歪了）。任一命中 = fail。
实现者的自述（自检清单/交付评论）只用于**定位**，永不作为**证据**——每个判定
输入必须是正文原文或账本事实。自检门（实现者）与审读门（owner）都跑三分类：
第二层存在恰恰因为第一层是自述。**reviewer 的每条叙事断言必须附正文引文；
无法引证 = inconclusive = 不 pass。**

**空值必复算（取证纪律；patch WL-59 · 2026-07-18 操作者批准,自 lessons [S1] 升格）**：任何
「不存在／为 0／为空／拿不到／不能」的读数，在被当作证据之前，必须用一条**独立代码路径**复算——
假阳性会被复算抓住，**假阴性直接消失**（没人会去复算一个「没有」）。已实测跨 6 个角色复现。要点：
①git 对象一律 `python3 subprocess` 直取 bytes、不经 shell；②**见到 `e3b0c44298fc` = sha256("") =
你什么都没读到**，不是「该文件是这个值」——全队口令；③自述称「无 X」时不要去验证「无 X」（不可证否），
枚举全集再自判；④你自己的扫描结论（「零漏项」「无变化」）与工具读数同级，同样必须以无截断的独立路径
复算——截断读数（如 `line[:150]`）永远撑不起「零漏项」。危害面直指本节三分类、§10 写后必读、
§15.3 字数带、§21a-gate.1 版本绑定。

## §4. 标签分类

**标记（每票必带）**：`writing-loop`（§2）。

**Type（恰一）**：`Feature`（创作票：outline/arc-design/episode/milestone-eval/立项）、
`Bug`（修订票：审读/doctor/evaluator/涟漪分析发现的缺陷）、`Improvement`
（打磨票：punch-up、非缺陷优化）。

**Owner（恰一——按票类，不按 Type；决定谁验收）**：
- `reviewer`：**全部 `episode` 票**（含 `Mode: direct-write` 重写票——Feature 中的
  显式例外：离观众最近的产物必须独立验收）、全部 `Bug`（**`market` 子标签的 Bug 除外**，
  下述例外）、reviewer 所 file 的 Improvement。
- `showrunner`：outline / arc-design / milestone-eval、其余 Improvement
  （含 punch-up）、以及 **`market` 子标签的 Bug**（市场/定位缺陷是战略层，reviewer
  无从对正文验收 ⇒ 归 showrunner，与「episode+Feature+reviewer」并列的第二条 owner
  例外；showrunner 的处置是改 north-star/方向 + file 应对票，处置完由它自己关票
  `Done`——它是 owner，合法）。**【patch WL-34 · 2026-07-17 操作者批准（读法 B）】
  再补第三条 owner 例外：**无 `Episode:` 行的设计层 `Bug`**（季级账本/大纲缺陷，如
  `foreshadow`/`continuity` 命中 outline/arc/季级账本而非单集正文）归 **showrunner**——
  判别符 = 有无 §6 修订票模板强制的 `Episode: N` 行（有 = 正文层 ⇒ reviewer；无 = 设计层 ⇒
  showrunner）。贴合本节首句「按票类不按 Type」。

无 owner 标签的票会搁浅在 In Review——sweep 错标清单第一项。
**`episode`+`Feature`+`reviewer`** 与 **`market`+`Bug`+`showrunner`** 是两个合法组合，
sweep 不得分别按「Feature⇒showrunner」「Bug⇒reviewer」改回。**【patch WL-34 · 2026-07-17】
第三个合法组合：**无 `Episode:` 行的设计层 `Bug` + `showrunner`**——sweep 不得报「缺 owner」或
改回 reviewer（这是让 sweep 停止逐 fire 重复复核同一组合的直接开关）。

**Tier 路由（恰一；§21a 编码）**：`story-designer` / `episode-writer`。tier 只适用于
**两个创作 tier 拾取的票**：`episode` / `arc-design` / `outline`（及其 direct-write
重写票）与已赋 tier 的 Improvement。**`milestone-eval` 票无 tier**（evaluator 按
`milestone-eval` 子类型标签拾取，不经 tier 切片）——sweep 不得对它报「缺 tier」。
未标 tier 的**创作票**（episode/arc-design/outline）对两个拾取查询都不可见（sweep 捡漏项）。
**Improvement 的 tier 由 showrunner 在 §5a 梳理时赋予**（放行前）：punch-up ⇒
story-designer；doctor/reviewer 所 file 的 craft 打磨（声纹/节奏/台词）⇒ 默认
episode-writer（scoped 增强）。filer 建 Improvement 时可不带 tier；无 tier 的
Improvement 停在 Backlog 等 showrunner 赋 tier + 放行，**不**搁浅（Bug/Feature 的
无 tier 才是 sweep 旗标项）。

**子类型（可叠加）**：`episode`（单集）、`arc-design`、`outline`、`milestone-eval`、
`punch-up`、`continuity`（连续性缺陷/邻集复核）、`pacing`、`foreshadow`（伏笔账本
缺陷）、`hook`、`redline`（evaluator 红线，恒 Urgent）、`compliance`（合规）、
`adaptation`（改编偏差——reviewer 审读门第 7 项「原著对照」fail 时 file 的修订 Bug
所带）、`keystone`（关键集）、`market`（market-watch 所 file）。

**工作流信号（闭集）**：`blocked`、`external-prereq`、`needs-showrunner` /
`needs-reviewer` / `needs-designer`（提案/求助路由——**仅此三个** needs-\* 合法：
路由目的地只有 showrunner/reviewer/designer；不存在 needs-episode-writer /
needs-evaluator / needs-reflect 等，任何 skill 不得引用或 file）、`notified`
（已带外通知，防重复推送）。

**机读行（写在工单描述内，一行一条）**：
- `Episode: <N>` —— 一切单集类票（创作/重写/修订）必带（§5 顺序前置的判定依据）。
- `Design: arcs/arc-NN-<slug>.md` —— 单集创作票指向其节拍单。
- `Mode: direct-write` —— 升级重写票标记（fail 计数的机械载体，§21a）。
- `Blocked-by: <票ID>` —— 真实阻塞边（§9/§21 里程碑门）。
- `Bail-shape: <info-needed|decision-needed|scope-design|external-prereq|fix-exhausted>`
  —— block 评论首行，机器可解析（§9）。

优先级用工单 `priority` 字段：1=Urgent 2=High 3=Medium 4=Low 0=None。

## §5. 优先级与拾取序

实现者按各自 tier 切片拾取 `Todo`（排除 `blocked`），同 rank 内 FIFO：

| rank | 类别 |
|---|---|
| 1 | Urgent Bug（`redline`/`compliance`/卡点区缺陷） |
| 2 | Urgent Feature（补写关键集） |
| 3 | `continuity` Bug（连续性缺陷随集数复利） |
| 3.5 | 一般 Bug |
| 4 | 当前 arc 的 `episode` 票（**按 Episode 升序 + 顺序前置**，下述） |
| 5 | Improvement（punch-up 等） |

**顺序前置（绑票类、集本位——citron 教训⑥）**。任何 agent（episode-writer **和**
story-designer 都在内）拾取带 `Episode: N` 的**创作/重写**票前必须验证：
1. **前集已成**：`episodes/ep-(N-1).md` 已存在于剧本 repo main（任意票产出皆可——
   Cancel+supersede 链后按**文件**判定，不按「那张票」判定），且不存在
   `Episode: N-1` 的开放（Todo/In Progress/In Review）创作/重写票。
2. **前向冻结**：不存在 `Episode ≤ N` 的开放 **Bug** 修订票，**也不存在
   `Episode ≤ N` 的开放 `Mode: direct-write` 重写票**（**开放 = Todo/In Progress/In
   Review，与检查 1 同一状态集**——`Backlog` 票**不**触发冻结，未放行修订票的危害窗口
   由 §5a 的「触前沿修订 Bug 最先放行」兜住；事实可能被改——修订 Bug 升级为
   direct-write 后 Bug 已 Cancel，但事实仍在重写中，冻结必须延续到重写票关闭；
   Improvement/punch-up 结构冻结、不改账本事实，**不**触发冻结）。
3. **arc 首集**：上一 arc 的全部 episode 创作/重写票 Done（开放的修订 Bug 不阻塞
   跨 arc 开工——修订票本可插队并行）。
`Mode: direct-write` 重写票天然满足 1（重写的是已存在的集），显式豁免检查 1。
不满足 ⇒ 跳过取下一候选，不 block 不评论（这是常态节流，不是异常）。

### §5a. Backlog-first 进件与 Todo 深度上限

一切新发现的工单（showrunner 构想、reviewer/doctor/evaluator/market-watch 的发现、
操作者进件）落 `Backlog`，**只有 showrunner 放行到 Todo**，且放行时
`count(Todo, not blocked, 非 episode)` < `intake.todoDepthCap`（默认 10）。
放行按 §5 拾取序，但**触前沿修订 Bug 最先放行**：`Episode ≤ 当前写作前沿（repo main
最新已存在的 ep-NNN）` 的 Backlog 修订 Bug 优先于一切（§5 检查 2 的前向冻结只看
Todo/In Progress/In Review——这类票在 Backlog 每多等一 fire，就多一集正文建立在被
指认有误的事实上，涟漪随集数复利）。
五个豁免直进 Todo：verifier 的 verify-fail 跟进票、un-block 重排、
大纲门 pass 的子票全量放行、**add-script 立项时 file 的首张大纲票**（workspace 的
第一张票，此时尚无 Backlog 可梳理，等 showrunner 放行只会空转一个周期）、
**showrunner 所 file 的 milestone-eval 票**（filer 即放行阀本人，且门票挡整条流水线
——§21 明令评估侧零轮询延迟，门票自己却在 Backlog 排队等下一个 showrunner 周期是
自相矛盾）。
**`episode` 创作子票不计入深度**——它们的节流由 §5
顺序前置承担；把它们计入会让顺序队列永久顶满闸门、饿死修订票。

`intake.mode`（§11）：`autonomous`（默认）= showrunner 主动立项推进 + 上述全部；
`passive` = showrunner 不自发起草任何新工作，只响应显式进件（操作者的
`needs-showrunner` 票）——验收、放行、un-block、梳理照常。passive 即
「纯用户驱动创作」模式。

## §6. 工单模板

**单集创作票（Feature + episode + tier）**
```
标题: ep-012 写作（arc-02 危机拍 2/2）
Episode: 12
Design: arcs/arc-02-mowang.md
（keystone 集另加标签 keystone，tier=story-designer）
## Context
arc-02 节拍单 ep-012。承接 ep-011 末帧。
## Context-pack
需读（≤8 指针）: arcs/arc-02-mowang.md#ep-012；ledgers/story-state.md 当前态+ep-011 行；
  ledgers/foreshadow.md F7/F9 行；episodes/ep-011.md 末帧；bible/characters.md 女主声纹卡
关键事实: F7 已于 ep-009 planted（foreshadow.md L42）；假死信息位阶=观众知/女主不知
  （story-state L18）；本集场景预算余量 2（production.md L31）
禁读: outline.md 全文不读；north-star 只读 Non-goals+定位 两节
## Acceptance criteria
- 逐项符合节拍单 ep-012（三分类验收；EXTRA=禁写违反+账本事实冲突）
- §15 交付义务完成（单 commit / 账本 delta 声明 / production 计数）
- script-format 机读块完整且实符
## How to verify
reviewer 按 §21a 审读门清单。
```

**Context-pack（票载上下文包——2026-07-19 操作者裁定，三类创作票必备节）**：
episode / arc-design / outline 三类创作票的描述必含 `## Context-pack` 节，由**建票方**
（spawn 子票的 story-designer §21a-design.3、file 设计/大纲票的 showrunner/add-script）
必填三件：①**需读清单**（≤8 个指针）——本票所需 文件+行区间/节锚点；②**关键事实
3-5 条**——每条带出处（文件+行号或票号），拾票者可直接采信、免全文重读；③**禁读提示**
——明示本票不需要读的大文件。拾票的实现者**优先按包读**；越包读大文件不违纪，但须在
交付评论说明理由（信号回流给建票方）。包是导读不是授权边界：三分类验收（§3）的 spec
仍是节拍单/AC 本体，包内容有误不豁免实现者对 ground truth 的核对义务。

**修订票（Bug + 子类型 + episode-writer）**：Context 写症状与出处（审读 fail 的
notes / doctor 审计条目 / evaluator 红线），`Episode: N` 必带，AC 写可判定修复项
+「§19 涟漪分析完成」。

**arc 设计票（Feature + arc-design + story-designer，owner=showrunner）**：本票建票方
（showrunner）同样必填 `## Context-pack`；AC =
节拍单完整（每集全字段）+ 候选竞争弃案记录 + 伏笔排期入账本 + 预算增量合规 +
子票已 spawn（Backlog 暂存，每张含 Context-pack，§21a-design.3）。

**milestone-eval 票（Feature + milestone-eval + evaluator 执行，owner=showrunner）**：
Context 写触发条件（如「ep1-10 全 Done」）；AC = 报告落 `evaluation/` + 红线结论 +
后续动作票已 file。showrunner 所 file 的本类票**直进 Todo**（§5a 第五豁免）。

**邻集复核票（Bug + continuity + owner=reviewer + tier=episode-writer）**：由完成
修订验收的 reviewer 在同一验收动作里 file（直进 Todo，verify-fail carve-out 语义）；
`relatedTo:[修订票]` **强制回链**——§19 递归上限（≤2 跳）的机械载体是这条链回走，
不是任何人的记忆；AC =「ep-N±1 与修订后 ep-N 的承接帧/钩子兑现/信息位阶一致；
不一致处已修复」。

## §7. 认领（并发安全）

拾取 ⇒ 认领：工单 `assignee` 写入**本 fire 的唯一 run token**（如
`episode-writer (run 3f2a)`），置 `In Progress`，**重读验证 token 是自己的**才开工
（两个同角色 fire 的仲裁）。孤儿回收（每 fire 第 0 步）：`In Progress` + assignee
非本 fire + **无交付产物**（无对应 commit）+ 认领超时（>60min 无更新）⇒ 清 token
重排 `Todo`。孤儿回收判定**不要求** token 等于自己（崩溃 fire 的 token 按定义不是
现任的）。

**【patch WL-38 · 2026-07-17 操作者批准（全采纳）】接管（takeover）分支——补「commit 已落地时」的归宿。**
§15.1 强制「commit 在前、转态在后」，这个窗口是协议自造的：fire 先 commit 再崩溃 ⇒ 上面「无交付产物」
合取项为假 ⇒ 回收永不触发，该票 + 全部 `Blocked-by:` 下游永久搁浅（实例 WL-36：arc-01 剩余 9 集冻结）。
故 §7 增设**第二分支**，与 story-designer / episode-writer SKILL Step 0 既有口径对齐：**`In Progress`
∧ assignee 陈旧 >60min ∧ 存在引用本票号的 commit ⇒ 不回收（reclaim）、不重排 Todo、不重做，改为
「接管（takeover）」**——新 fire 写入自己的 run token，据票上 **`Landed: <sha> — <该 commit 已落地的
AC 清单>`**（接管的强制前置：回收/接管方必须先记它，拾取者据此只做残余）续完交付、正常转 In Review。
「回收」与「接管」是两个操作——回收保护「别把已落地 commit 重排掉」，它并未禁止「把交接做完」。有交付评论
（§15.2）齐全、只差转态者 ⇒ 接管特例：直接推进 In Review。

**认领心跳（长 fire 防误收割）**：预期超 30min 的 fire（单集起草、arc 设计、direct-write
重写）在 ~30min 处向票追加一条带时间戳的进度评论，此后每 ~30min 一条——§18 的 comment
op 同样 bump frontmatter `updated`，于是上面「>60min 无更新」的孤儿判据对活着的长 fire
永不成立。回收方（agent 第 0 步自回收与 sweep 的孤儿 Job）判 stale 一律看**最新心跳**
（`updated` / 最新评论时间戳），不是认领时刻距今的年龄。**【patch WL-38 · 2026-07-17】
stale 判据只认 assignee **本人**所留评论刷新时钟——第三方（非 assignee）在承重票上留的证据/交接评论虽
§18 自动 bump `updated`，**不得**重置 stale/孤儿时钟（否则「负责任地留交接说明」反把孤儿/护栏时钟推后、
使票更难被发现——已实测第三方 bump 把 keystone 票 WL-19 的护栏旗标推后 18min）。§1 keystone-stall 护栏
与 §7 共用 `updated`，**同样只认 assignee 本人评论**（否则 §7 治好、§1 仍瞎）。兜底：sweep 增设 digest
旗标——`In Progress` ∧ assignee 陈旧 ∧ 有引用票号的 commit ⇒ 旗标（hygiene-only，只让它可见）。
未来时间戳 = 立即 stale-可疑，绝不等其「到期」（时钟纪律，§18）。

**锁助手**：本节与 §15.5/§15.6/§18 的锁法术（O_EXCL 独占创建、>60min 陈旧强清、固定多锁序、
拿不到下一把先全释放）有一份可调用实现 `${CLAUDE_PLUGIN_ROOT}/scripts/board-lock.sh`
（含 `--self-test` 自检）；散文仍是权威——无 shell 的运行环境按散文手工执行，两者语义
一字不差。传给 board-lock.sh 的永远是 `<file>.lock`，不是 `<file>`；helper 已
fail-closed 校验（非 `.lock` 路径退 2；锁路径上的非 holder 格式文件绝不 rm、退 3，
WL-53）。

## §8. 去重

file 任何票前先查同项目开放票（标题关键词 + `Episode:` 字段 + 子类型）。同集同症状
⇒ 评论补充到既有票，不开新票。跨 arc 的同类审计发现（如两个 arc 都钩型单一）
是两张票（修复对象不同）。

## §9. Blocked 协议与人工停靠

实现中遇到无法推进：加 `blocked` 标签 + 评论首行 `Bail-shape: <形>`：
- `info-needed`：spec 不清 / `Design:` 指针断 ⇒ 路由 `needs-showrunner`（大纲/方向类）、
  `needs-designer`（节拍类）或 `needs-reviewer`（**审读判据/引文定位/期望类**——审读门
  怎么判、复核范围要澄清、需要更锐的缺陷复现；正是 reviewer Job B 消化的形）。
- `decision-needed`：两个合法方向要选 ⇒ `needs-showrunner`。
- `scope-design`：比票面大，需要设计 ⇒ `needs-showrunner`（应转 arc-design/重拆）。
- `external-prereq`：等系统外的事（操作者投放数据、授权、政策裁决）⇒ **人工停靠**。
- `fix-exhausted`：三级路由用尽（§21a）⇒ 人工停靠。
盲试上限 2 次；同一票 block-cycle ≤3（第 4 次 ⇒ 升格 external-prereq 人工停靠）。
`blocked` 票不在任何拾取序内。showrunner 每 fire 扫 `needs-showrunner`，reviewer 扫
`needs-reviewer`，story-designer 扫 `needs-designer`（裁决节拍修正提案）。

**人工停靠的机械载体（每一种停靠皆然——`fix-exhausted`、`external-prereq`、操作者
决策点跟进票、§17 提案票）**：`blocked` + **`needs-showrunner`** + 对应 `Bail-shape:`
行。停靠票必须带 `needs-showrunner`——它不进任何拾取序，唯一能看见它的扫描就是
showrunner 的 un-block 队列（B1 显式涵盖全部停靠票）；不带即永久隐形。showrunner 对
停靠票**不 fake-unblock**（人类门控不推回流水线），只做两件事：操作者已动作 ⇒
un-block 重排；未动作 ⇒ 按下述重提醒节律提醒。

**人工停靠通知与重提醒**：首次停靠即通知——config `comms.provider` 配置时（§11）向
带外通道推送一条（写明票 ID + 需要的决定），未配置 ⇒ 停靠票在 daily digest 的
needs-attention 节置顶（操作者需日查——这是显式声明的 v1 fallback，不是遗漏）。
每次通知（首推与重提醒皆然）在票上追加机读评论行 `Notified: <ISO 时间戳>`，`notified`
标签保留作「已通知过」信号——**去重窗口以最新 `Notified:` 行为准，不再是一次性布尔**
（一次性布尔 = 操作者错过首推后该票永远沉默）。**重提醒**：停靠 >24h 无操作者动作
（最新 `Notified:` 之后无操作者留言/改标签）⇒ showrunner 每日**至多一条**重提醒
（comms 配置走带外，否则在 digest needs-attention 节标注停靠时长置顶）；绝不刷屏。
解除：操作者在票上留言/改标签，showrunner 下 fire un-block 重排（评论 bump
`updated`，探针可见，§18/§0）。

### §9a. 操作者进件（W3 等价）

操作者随时可 file `Backlog` + `needs-showrunner` 票
（方向变更/新剧立项/点名修改）。showrunner 以完整 §9a 待遇处理：拆解为具体子票
（`Groomed into: <IDs>` 评论 + 关父票）——响应显式进件不算 passive 违例。
进件中**点名的 north-star 方向级修改，批准即进件本身**——showrunner 直接回写并在
Decisions log 记进件票号（§20 节分级；showrunner **自发**的方向级修改才需 diff
停靠票批准）。

## §10. 查询纪律

按最窄谓词取数（项目 + `writing-loop` + state/label/`Episode:`），绝不盲读全板。
写后必读验证（§18 的锁与原子写之上再读一次确认落盘）。labels 是 REPLACE 语义：
更新时**重传全集**，漏传即删除。追加型字段（relatedTo）读-并-写。

## §11. 配置

### Workspace 根与状态目录（workspace-rooted 布局，v1 默认）

**一个 workspace = 一个普通文件夹**，里面装若干剧本 repo + 一个 `.writing-loop/`
运行时状态目录。复制这一个文件夹即整体迁移（含在制工单）。布局：

```
<workspace>/                 ← 复制它 = 全部搬走
  .writing-loop/             ← 全部运行时状态（untracked；单一文件系统）
    config.json              ← workspace 索引（repoPath 用【相对路径】）
    <key>/board/ …           ← 各项目看板（§18）
    <key>/lessons/ reports/ state/
  my-drama/                  ← 剧本 repo（创作成果，独立 git 历史，零调度噪音）
  another-drama/
```

`.writing-loop/` 是**各剧本 repo 之外**的兄弟目录——工单状态不进任何剧本的 git
历史（否则 `state: X→Y` 会污染正文提交）。它 untracked、绝不共享、绝不放网络盘
（原子 rename 需单一文件系统）。

**Workspace 根解析（boot 时）——只有一条规则，无环境变量、无配置**（用户是非技术型，
保持最简）：从 CWD **向上逐级找**已存在的 `.writing-loop/` 目录（像 git 找 `.git`），
首个命中的父目录即 workspace 根。找不到 ⇒ 未在 workspace 内：agent 报错并请操作者先
`add-script` 立项（由它确立 workspace，见 §13）；不猜、不在 home 目录乱建。

### 项目条目字段
`repoPath`（剧本 repo，**默认相对 workspace 根**——`"my-drama"`；绝对路径仍允许，
但该项目将失去随 workspace 复制的可迁移性）、`format`（live-action|ai-anime|reelshort-en）、
`monetization`（paid-app|free-hongguo|reelshort-sub——决定门位与卡点语义，
craft-rules 附录 B）、`genre`（profile key，craft-rules 附录 A——决定 R 参数集）、
`audience`（必填含性别+年龄）、`totalEpisodes`、`paywall`（备卡集号）、
`airedThrough`（已投放水位，§19）、`episodeWordBand`、`maxPrimaryScenes`、
`maxNamedCharacters`、`assetLibrary`、`marketDataPath`、`intake.{mode,todoDepthCap}`、
`comms.{provider,webhookEnv}`、`models`/`efforts` 覆盖、`mode`（live|dry-run）。
agent boot 读不到项目条目 ⇒ 问操作者，绝不猜路径。

### 多项目 workspace 的项目定位（每 fire 恰选一个项目）
一个 workspace 可注册多个剧本项目。agent 每 fire 按此规则选定**恰一个**项目：
1. CWD 位于某项目的 `repoPath` 之内 ⇒ 该项目。
2. 否则，config 里恰有一个 `enabled:true` 的项目 ⇒ 该项目。
3. 否则（多个 enabled 且 CWD 不在任一 repo 内）⇒ 问操作者选哪个，**绝不猜、绝不
   遍历全部项目**（跨项目即违 §2）。
`enabled:false` 的项目对一切 agent 不可见（探针与 boot 都跳过它）——这是操作者
暂停一部剧的开关。

## §12. dry-run 与自治

`mode:"dry-run"`：不写板、不 commit、不推送通知——打印「本会 file/验收/写什么」。
`mode:"live"`：全部生效。

### §12a. 自治边界

产品内决定（怎么写、怎么修、先做哪张票）自决不问；**人类专属决定**（方向变更、
一票否决红线、fix-exhausted、已投放集的追溯修改、预算上调）以停靠票呈现（§9），
不聊天等待。机械载体：预算上调 = `blocked`+`needs-showrunner`+`Bail-shape:
decision-needed`（超预算申请见 production 账本模板）；**方向变更** = north-star
方向级节的 diff 停靠票（§20 节分级——「什么算方向变更」由节分级机械判定，不靠
模糊裁量，这也消解了「§20 方向决策回写」与本节的表面矛盾：可自主回写的只有
进度级）。

## §13. 首跑安装（add-script）

1. **Interview**（原创）：题材/受众画像（必填性别+年龄+付费习惯——红线①入口预防）/
   对标剧（建议引用 market-watch 扫榜或操作者提供）/ 核心情绪引擎 / 规模与
   monetization / **合规预筛**（涉政涉案婚恋伦理走向——结论写入 north-star Non-goals）/
   genre profile（未校准题材显式警告，craft-rules 附录 A）。
   （改编）另加：原著文本入 `source/` → 选书检查表评估 → **拆书三清单**
   （templates/deconstruction/）→ 忠实度档位（默认贴改；借壳禁用写入 Non-goals）。
   原创管线对 1-2 部对标剧做轻量拆解（结构骨架/爽点清单/钩型序列）入 `source/`。
2. **Scaffold**：按 templates/ 生成 bible/ + outline.md（空表）+ ledgers/ 四账本 +
   episodes/ + evaluation/ 目录；git commit。
3. **注册**：写 `<workspace>/.writing-loop/config.json` 项目条目（校验规则见 config-schema）；
   创建板目录；scaffold `lessons/` 目录（shared.md + 九个角色文件，空骨架，§14）。
4. **首张票**：file 大纲票（Feature+outline+story-designer，owner=showrunner——
   **showrunner 不得自领大纲票**，保持验收独立性）。

## §14. lessons — 操作者级修正（按角色分文件）

`<workspace>/.writing-loop/<key>/lessons/` **目录**（2026-07-19 操作者裁定：自旧单文件
`lessons.md` 分拆——每 fire 只付本角色所需的 lessons 上下文税）：
- `lessons/shared.md` —— 全队通用规则（原 `## Shared` 分节）。
- `lessons/<role>.md` —— 每角色一文件，九个：showrunner / story-designer /
  episode-writer / reviewer / script-doctor / evaluator / market-watch / sweep / reflect。
每个 agent 每 fire 只读 `lessons/shared.md` + `lessons/<本角色>.md` 并遵行——**不读其他
角色文件**（那是别人 lane 的上下文税）；**只有 reflect 可写**且策展**全部文件**（从 ≥2 次
复现的证据添加/合并/过期/跨文件搬移规则，每条附证据票号）。唯一例外：任何 agent
在分发**操作者对其报告的书面点评**（`*.review.md`，§22）时可向**自己的角色文件**加一条。
预算**按文件计**：`shared.md` ≤40 行、每个角色文件 ≤30 行；每条带 `added:`/`last-seen:`；
两周未复现 ⇒ 过期删除；证明普适 ⇒ 走 §17 提案升格进本文件后从 lessons 删除。多写者 ⇒
锁协议（§18 同款，逐文件加锁）。
写作团队特有证据源：evaluator 评分趋势、reviewer fail 分类统计、punch-up 修改
类型统计——reflect 每日 retro 的输入。

**迁移条款（旧单文件 → 目录，一次性）**：boot 时见旧单文件 `lessons.md` 且**无**
`lessons/` 目录 ⇒ 迁移期——本 fire 的 **fallback 读法** = 旧文件的 `## Shared` + 自己
分节（语义等价，规则照常遵行）；分拆由 **reflect 在其下一 fire 一次性执行**：按分节拆入
`lessons/shared.md` + 各 `lessons/<role>.md`（条目原样搬移，含日期戳），原文件改名
`lessons.md.migrated` 留档（不删——迁移可稽核），收尾报告记一行。两者并存（`lessons/`
已建而旧文件未改名）= 迁移崩在中途 ⇒ 一切 agent 以 `lessons/` 为准，reflect 下一 fire
补完改名；除 reflect 外任何 agent 迁移期只用 fallback 读法，**绝不自行分拆**（写权只属
reflect）。

## §15. 交付义务（coverage 的写作等价物）— 账本回写强制令

单集票移入 In Review 前，实现者必须完成（缺一 = 审读门直接 MISSING fail）：
1. **单 commit 原子性**：单集正文 + `ledgers/` 全部更新（foreshadow 状态、
   story-state 当前值与逐集末态摘要、production 计数）在**同一个 commit**；
   工单转态永远在 commit 之后。commit message 带票号。**staging 纪律**：commit 只含
   本票产物——绝不裹挟工作树里他人/别票的未提交改动（此规则的引用点一律指 §15.1）。
2. **账本 delta 声明**：工单评论逐条列出本集产生的状态/关系/信息差/数字锚点/
   伏笔操作变化，**每条附正文行号引用**。reviewer 逐条核对 + 越声明扫描
   （漏项 = MISSING）。「无变化」也要显式声明（一集不改任何状态本身可疑，R6）。
3. **自检清单**：机器项结果（格式 schema/字数带/frontmatter 实符/场景角色∈注册表/
   合规 lint）+ 三分类自证 + 金句候选，显式写入评论。
4. **fail-revert 协议**：reviewer 判 fail 时在 Cancel 评论记录失败稿 commit sha；
   跟进票（回炉或 direct-write）的**强制第一步 = `git revert` 该 commit**（正文+账本
   一体回滚，防被否叙事的账本残留污染 canon）。**稽核（不 mutate）**：sweep 发现
   「Canceled 单集票且其 commit 未被 revert」时**在 digest 旗标并路由给该票 owner
   （reviewer）/showrunner**——sweep 是 hygiene-only（§21 的 file 权只属 doctor/
   evaluator/market-watch），它不 file 新票也不自行 revert，只把漏做 revert 的事实
   浮出给有 file 权/改 canon 权的角色补做。
5. **账本并发**：写任何 `ledgers/*.md` 前独占创建 `<file>.lock`（O_EXCL；>60min 视为
   陈旧强清）；拿不到锁 ⇒ 本 fire 票留 In Progress，下 fire 续。**多锁纪律（防反序
   死锁与残锁）**：需要多把锁时按固定顺序获取——`foreshadow → story-state →
   production → repo`（repo 写锁见 §15.6）——任何人不得反序；中途拿不到下一把 ⇒
   **先释放已持有的全部锁**再退出本 fire（绝不持锁 bail——残锁会造成他人 ≤60min 的
   账本写冻结）。传给 board-lock.sh 的永远是 `<file>.lock`，不是 `<file>`；helper 已
   fail-closed 校验（非 `.lock` 路径退 2；锁路径上的非 holder 格式文件绝不 rm、退 3，
   WL-53）。
6. **repo 写锁（`repo.lock`）**：任何向剧本 repo 落 commit 的 stage+commit 序列——
   writer 的单集交付、story-designer 的节拍单/outline/滚存 commit、evaluator 的评估
   报告 commit、showrunner 的 north-star 回写 commit，含 `git revert` 与下述
   merge-back——整段包在 `<repoPath>/.git/repo.lock` 内（choreography 同 §15.5/§18：
   O_EXCL 独占创建、>60min 陈旧强清，`scripts/board-lock.sh acquire/release`；放在
   `.git/` 下使锁文件永不可能被 stage 进 commit）。传给 board-lock.sh 的永远是
   `<file>.lock`，不是 `<file>`；helper 已 fail-closed 校验（非 `.lock` 路径退 2；
   锁路径上的非 holder 格式文件绝不 rm、退 3，WL-53）。锁内只做 stage+commit 本身，慢活
   （写正文、写账本）都在锁外先完成——因此它持有时间最短（秒级），排在固定序**末位**
   = **最后拿、最先放**，互斥窗口最小；拿不到 ⇒ 同 §15.5 先释放已持有的全部锁，票留
   In Progress，下 fire 续。**账本锁持有至 commit 落地后才释放**（§15.5 固定序的锁在
   repo.lock 之外包住整段「写账本 → stage+commit」——先放账本锁再 commit 会让另一 fire
   在 commit 落地前改写同一账本，§15.1 的原子性即被击穿）。§15.1 的单 commit 原子性与 staging 纪律**不变**——
   repo.lock 只是把「绝不裹挟他人未提交改动」从散文纪律升级为互斥保证：两个 fire 的
   `git add`/`git commit` 从此不可能在同一 index 上交错（A 的 commit 裹走 B 已 stage
   产物的竞态在锁内无法发生）。

**账本不得自证（具名规则；审读门第 4 项与 §19 修订同规）**：账本是正文的索引，不是
第二真相源——任何「与 canon 无冲突」的判断必须对**正文**核实，绝不允许只对账本求值
（账本错误正是要抓的对象；实测同一列的虚假断言复发 4 次、3 张 keystone 首稿皆折在
账本记账上）。①义务 2 的 delta 声明按**列**断言真值：本集动了哪些列、每列附正文行号
引文——无引文的列断言无效；②reviewer 核对 delta 断言只认正文引句，绝不以账本回声
（账本自己的行）作证据；③**热列**：lessons 记有虚假断言史的账本列（同列断言曾被证伪，
≥2 次复现由 reflect 策展入 lessons，§14）= 热列——任何 fire 写或核热列时必须重读正文
对应区间取当前值，绝不沿用账本旧值。

**并发调度与 worktree 选项**：默认调度（当前形态——手动 slash 或彼此错开的 cron，
同一时刻至多一个 fire 在写 repo）下，直接在共享 checkout 上 direct-commit、
stage+commit 包进 repo.lock 已足——**不必 worktree**，别为单发配置徒增机器。内建调度器
（`writing-loop run`，随 npm 包分发）驱动时该前提是**构造保证**——写 repo 四角色全局单飞、板上角色不
commit repo（WL-55 裁决；schema 见 config-schema「内建调度器」节），默认轨道恒为合规，
repo.lock 仍照拿（fire 内保险带不撤）。操作者
若显式安排**重叠开火**（多条 cron 同窗触发多个写 repo 的 agent，或并行跑同类 fire
——cron/配置处应留一行注明），每张写 repo 的票改用 **per-ticket worktree + 锁内
ff-only merge-back**：①建 worktree（`git worktree add`，分支 `wl/<票ID>`，路径在
repo 树外如 `<workspace>/.writing-loop/<key>/wt/<票ID>`，基于最新 main；add/remove/
prune 与下述 merge-back 均在 repo.lock 内做，worktree 内部工作不需要锁）；②本票全部
写作/账本/commit 在 worktree 内完成（§15.1-§15.4 原样适用；账本 `<file>.lock` 只对
共享 checkout 有效、worktree 各持账本副本——账本冲突改由③的串行 merge-back 兜住，
rebase 冲突即冲突信号）；③落地：锁内 fetch（如有 remote）→ worktree 内 rebase main
——rebase 拉进**任何**新 commit ⇒ 先重跑自检门（合并态从未被检过）再落地 → 锁内
`git checkout main && git merge --ff-only wl/<票ID>`——ff-only 拒绝 = main 又前进了，
回 rebase 重试（≤2 轮，超限 `fix-exhausted` block §9），绝不在 main 上打 merge 结；
④清理：锁内 worktree remove + 删分支；写 repo 的 fire 起步时 `git worktree prune`
收割崩溃残留。

## §16. 内容红线（安全 doctrine 的写作等价物）

- **合规**（craft-rules R10a）：违法未惩/价值观红线/敏感题材/平台政策项——writer 自检
  与 reviewer 审读都跑合规 lint；evaluator 每道门一票否决级检查，触发 ⇒ human-park
  （不是修订票）。
- **原著版权**（改编）：改编边界以授权范围为准（立项 interview 记录）；不得混入
  其他 IP 的可识别元素。
- **真人隐私**：人设卡的「明星参考」只作视觉气质定位，不得使用真实人物姓名/
  可识别身份入正文。
- **AI 生产披露**：交付物 frontmatter 保留生成指纹（§19），不对下游隐瞒 AI 生成。

## §17. 自进化边界

reflect **可自主改**：仅 `lessons/` 目录各文件（可逆、每操作者、不入库；含 §14 的
一次性分拆迁移与改名留档）。
**任何 agent 不得自改**：本 conventions、任何 SKILL.md、craft-rules/script-format 的
规则本体、genre profile 参数表——结构性改动一律起草为**提案票**
（`blocked`+`needs-showrunner`+`external-prereq`，出生即停靠——机械防火墙：blocked
使其不进任何拾取序，external-prereq 使 showrunner 停靠给操作者而非解锁回流水线）。
操作者应用提案 = 人类授权。产品文档（north-star/outline/arcs/账本/正文）不在此列
——它们是产品本身，按 §19/§21a 的门禁流转。genre profile 校准结果同走提案流程。

## §18. Backend — 本地文件板协议（v1 唯一 backend）

板目录：`<workspace>/.writing-loop/<project-key>/board/`（workspace 根解析见 §11）。
**专用目录**：空或本系统脚手架；绝不共享、绝不网络盘（原子 rename 需单一文件系统）；
绝不 commit（它在剧本 repo 之外，本就不在任何 git 追踪里）。

```
board/
  counter.json          # { "prefix": "WL", "next": 42 }——起始提示，非真相源
  tickets/WL-1.md …     # 一票一文件
```

**票文件格式**：YAML frontmatter（机器字段）+ §6 模板正文（含机读行）+
append-only 评论区。**state 存于 frontmatter `state:` 字段**（字段改写，不是移目录）。

```markdown
---
id: WL-12
title: ep-012 写作（arc-02 危机拍 2/2）
type: Feature
state: In Review
owner: reviewer
labels: [writing-loop, Feature, episode, reviewer, episode-writer]
priority: 3
assignee: null            # 认领时 = run token（§7）
relatedTo: [WL-9]
duplicateOf: null
created: 2026-07-09T09:14:00Z
updated: 2026-07-09T11:02:00Z
---
Episode: 12
Design: arcs/arc-02-mowang.md
## Context
…
---
## Comments
### 2026-07-09T10:40:00Z — episode-writer (run 3f2a)
认领（§7）。
### 2026-07-09T11:02:00Z — episode-writer (run 3f2a)
state: In Progress → In Review。commit abc1234；账本 delta 声明如下：…
```

**每次转态必须追加带时间戳的评论**（`state: X → Y`）——评论日志是板的活动史，
reflect 的 retro 数据源。

**时钟纪律**：frontmatter、转态/心跳评论、`Notified:` 行、账本与报告里的一切时间戳
必须来自**当次执行的 `date -u`**（或等价系统时钟读取），绝不凭模型记忆拼写——拼出的
未来时间戳会把 §7/§1 的 stale 时钟推入未来、永不到期（实测把 §7 冻结约 10 小时，且
复发）。agent 对「现在几点/过了多久」的自述一概不可信；墙钟谓词（§7 60min 陈旧判据、
§9 24h 重提醒、探针 mtime 信号）一律以文件 mtime 与
`<workspace>/.writing-loop/<key>/fires.jsonl` 的 `startedAt`/`endedAt`（内建调度器
`writing-loop run` 进程自己的 UTC 时钟逐 fire 记账）为可信时间源求值——机制细节见 config-schema
「内建调度器」节。**未来戳护卫（sweep 机械修复项）**：任何 frontmatter/评论时间戳晚于当前时钟
⇒ clamp 到 now + digest 旗标；§7/§1 谓词遇未来戳不等其「到期」——带未来戳的票
**立即**按 stale-可疑处理。

**ID 分配（O_EXCL 竞争安全）**：读 counter 取起始 N → **独占创建**
`tickets/WL-N.md`（O_CREAT|O_EXCL，OS 保证唯一赢家）→ 已存在则 N+1 重试 →
成功即拥有该 ID，写入内容，尽力回写 counter（输掉回写无害）。ID 单调不复用。

**并发**：读-改-写必先独占创建 `tickets/<ID>.lock`；改经同目录临时文件 + 原子
rename；释放锁。**陈旧锁规则（强制）**：锁文件 mtime >60min ⇒ 陈旧，删除并记一行
日志继续（否则一次崩溃 fire 永久死锁该票）。临时/锁文件非 `*.md`，列表 glob 天然
忽略。认领用 run token（§7）；孤儿回收是反向检查。

**操作映射**：list=glob 本板 `tickets/*.md` 解析 frontmatter 进程内过滤（含
`Episode:` 机读行）；get=读单文件；create=分配 ID 独占创建；update=锁内读改写
（labels 全集重传、relatedTo 并集、转态评论、bump updated）；comment=追加**且同样
bump frontmatter `updated`**——评论本身就是交接载体（§9 操作者解封留言、§21a
punch-up 双签复核、停靠裁决都只以评论到达），`updated` 不动，Step-0 探针与板快照
就看不见这些交接（假退出，违反 §0 铁律）。
每个 glob **严格限定本项目板目录**——跨项目即违反 §2。

**frontmatter 字段稳定性契约（授权 Step-0 探针内联依赖，§0）**：本节定义的 frontmatter
字段（`state` / `labels` / `owner` / `assignee` / `updated` / `Episode:` 机读行）是 backend 契约中最稳定
的部分。**skill 可内联自己的 lane 谓词，并在「本 fire 尚未读 conventions」时直接依赖这些
字段**（§0 Step-0 fast-path 的正当性前提）。改动本节板 schema 等于换 backend（重大改动），
须同步审查所有内联谓词——增量审查负担可忽略。

## §19. 文档体系、版本纪律与修订涟漪协议

### 文档树（每剧本 repo；landing 恒为 direct-commit，无 PR；一切 stage+commit 包在 repo 写锁内，§15.6）
```
bible/{north-star,characters,world}.md   # 冻结层：改动只经 showrunner（north-star）
                                          #   或大纲门内的 story-designer（characters/world 增补）
outline.md                                # 总大纲：单元表/高潮五锚点/卡点规划/主线伏笔
                                          #   登记表（季级）/名场面规划/续季钩规划
                                          #   （单写者 story-designer；showrunner 的进度
                                          #   回写一律落 north-star 当前进度，§20——
                                          #   单元表「细纲状态」列由 designer 在设计票内维护）
arcs/arc-NN-<slug>.md                     # 逐集节拍单 + 候选竞争弃案（§21a design doc）
ledgers/foreshadow.md                     # 伏笔账本（planned→planted→refreshed→paid；
                                          #   dropped→续集钩；sequel-hook 可预标）
ledgers/story-state.md                    # 当前态 + 本 arc 逐集末态摘要 + 被动标记
ledgers/production.md                     # 制作预算：场景/角色注册表 + 成本计数器
ledgers/archive/arc-NN.md                 # 每 arc 滚存（活跃账本 ≤25KB 纪律；见下）
episodes/ep-NNN.md                        # frontmatter 指纹 + 正文（script-format）
evaluation/                               # 里程碑评估报告 + 切片清单
source/                                   # 原著+拆书三清单 / 对标剧轻量拆解
```

### 版本纪律 — 防「已过门工件被静默改写」
- 单集 frontmatter 记 `beat-card-hash`（写作时刻 arc 文件内容哈希）+ `model` +
  `rules-version`。doctor 每轮把当前 arc 文件哈希与全部已 Done 集的记录哈希比对，
  不一致 ⇒ 得到「依据已过期」集清单 ⇒ file continuity Bug。
- **大纲门之后改 arc/outline ⇒ delta 复审工序**（发起者 = story-designer——它是
  outline/arcs 的唯一写者，见文档树；showrunner 需要结构变更 ⇒ file 票给
  story-designer，不亲改）：①在文件头 changelog 列改动条目（**必带 `prev→new` 哈希对**，
  §21a-design.5——sweep 的版本链稽核只认哈希对，纯文字条目不算数）；②机器算受影响的已 Done 集（哈希失配 +
  改动条目涉及的 Episode 区间）；③showrunner 对改动区局部重验 R1/R2 序列；
  ④对受影响已 Done 集逐张 file continuity 复核票。跳过此工序的直接改写 =
  sweep/doctor 稽核项。
  （**开票权归属**：delta 复审是一次**计划内的规划层改动**——发起改动者本身有资格
  逐张 file 复核票，无需转 showrunner 裁决。这与下述「修订涟漪协议」不同：后者是
  正文层 Bug 修订**意外**发现超邻集涟漪，因其为非计划的连锁返工才必须转 showrunner
  批。一句话：**计划内改规划层 = 改动者自行开复核票；意外的正文层超邻集涟漪 =
  转 showrunner 裁决**。）
- **outline 定稿后的结构性变更**（结局承诺/卡点/单元表）额外重过 evaluator
  定稿门对应分项（file milestone-eval 复审票）。

### 修订涟漪协议 — 改已 Done 的集
1. **涟漪分析（修订票交付义务）**：修订者在正文修改前，grep 本次将改动的账本条目
  （伏笔 ID / 角色状态 / 信息差事实 / 数字锚点）在 ep-(N+1).. 的全部引用，
  在工单评论列出**受影响集清单**。
2. **邻集内**（受影响 ⊆ ep-N±1）：完成修订；验收它的 reviewer 在同一验收动作里
  file 邻集复核票（§6）。
3. **超邻集**：**不得自行开票**——修订票转 `blocked`+`needs-showrunner`，showrunner
  裁决：批量返工（按受影响清单逐张 file 复核票）或接受偏差（记入 north-star
  Decisions log + 账本加偏差备注）。
4. **递归上限**：复核票引发的再修订 ≤2 跳；超限 ⇒ 人工停靠（一次结构修订引发
  修订风暴 = 该由人重新决策的信号）。
5. **前向冻结**（§5）：Bug 修订开放期间，`Episode ≥ 修订集` 的新创作票不可拾取。
6. **账本历史**：story-state 的逐集末态摘要使「截至 ep-N 的状态」可重建——修订时
  同步改**当集摘要行**及其后受影响行，这本身就是涟漪分析的对象。修订中的一切
  「与 canon 无冲突」判断以正文为准（账本不得自证，§15；热列必重读正文）。
7. **已投放水位（airedThrough）**：`Episode ≤ airedThrough` 的修订票机械转型——
  要么改写为**前向修补票**（在未投放的后续集内解释/兜住，原集正文不动），要么
  人工停靠。禁止追溯修改已投放集的正文与其账本记录（观众 canon 不可变）。

## §20. north-star（bible/north-star.md）— 剧本的战略文档

八节结构（templates/north-star.md）：一句话故事 / 定位 / 核心情绪引擎 / 结局承诺 /
创作红线（Non-goals）/ 制作约束 / 当前进度 / Decisions log + Candidate ideas。
**showrunner 是唯一写者**，但**按节分两级**（模板内逐节标注）：
- **进度级（自主回写）**：`当前进度` / `Decisions log` / `Candidate ideas`——里程碑
  过门、方向决策**记录**、评级结果、偏差接受、候选构想，发生即回写，无需批准。
- **方向级（默认级——凡未列入进度级的节皆是）**：`一句话故事` / `定位` /
  `结局承诺` / `创作红线（Non-goals）` / `制作约束`（`核心情绪引擎` 未列入进度级，
  同属方向级）。这些节的改动**就是** §12a 的「方向变更 = 人类专属」：showrunner 把
  **精确的节 diff** 起草为停靠票（`blocked`+`needs-showrunner`+`external-prereq`，
  §17 同款防火墙三件套，走 §9 通知与 24h 重提醒轨道），操作者在票上留言批准（或
  直接改文档）后才 commit 回写，票号记入 Decisions log。**例外**：操作者显式进件
  （§9a）点名的方向修改，批准即进件本身——直接回写，记进件票号。market-watch 信号
  触发的 `定位`/`Non-goals` 修改**恒走本流程**（showrunner 不得以市场信号为由自主
  改方向级节）。稽核方 = sweep（方向级节改动而无对应已批准停靠票 ⇒ digest 旗标）。
showrunner 职责：
- **doc-watch（自触发排除——异源版本规则）**：每 fire 对比 state 目录快照哈希。
  基线 = **showrunner 自己最近一次回写后的内容哈希**——每次自己写 north-star
  （进度级回写或获批的方向级回写），**写完的同一动作内立即刷新快照**（不等 fire
  收尾）；因此「哈希变了」只可能是自己没写过的版本 = 操作者动了北极星 = 最高优先
  进件，按 §9a 拆解执行。自己的回写**绝不**触发 watch（否则每次回写都会在下 fire
  伪装成操作者进件，并永久击穿 cheap-boot）。崩在「写完—刷新」之间 ⇒ 下 fire 把
  自己的回写误判为进件——假阳性，§8 去重兜住，方向安全（§0 单向安全：绝不反向，
  刷新绝不先于写完）。**回写前必重验（中途竞态守卫——§0「boot 快照非事实」通则的实例）**：每个回写点在 repo 写锁内、
  动笔**之前**重读 north-star 再算一次哈希，与本 fire 开头 doc-watch 所见比对——
  不一致 = 操作员在本 fire 进行中动了北极星，**本次回写中止**（操作员编辑绝不许被
  自己的回写 commit 吞进基线），该 foreign 版本按上面 watch 命中分支处理；一致才写。
- **回写**：进度级内容发生即回写。过时的北极星比没有更危险。
- **滚存**：Decisions log >20KB ⇒ 滚存归档留索引；`当前进度` 节 >15KB 同款处理（patch WL-66）。
其他 agent 只读。所有创作产物与 north-star 冲突时：north-star 赢，冲突本身
file Bug（continuity）。

## §21. 观察型角色与里程碑门

三个观察型角色共同遵守 **observe-and-file 契约**：只读产品文档 + file 票（Backlog，
§5a），**绝不**直接改正文/账本/大纲，绝不验收他人工作，绝不互相触发——一切经板。

### script-doctor（慢频，SHA change-gate）
上次审计以来 `episodes/` 无新 commit ⇒ 本 fire no-op（change-gate）。有变化 ⇒
按维度**轮换**审计（state 目录记轮换位置），每 fire 一个维度：
1. 伏笔账本闭环（机器）：到期未回收 / 未埋先收 / >8 集未擦亮 / 登记表-账本失配。
2. 钩型序列（机器）：R1.2/R1.3 连用与配给（对照本项目 genre profile）。
3. 指纹与哈希一致性（机器）：beat-card-hash 失配清单；季内 model/rules-version
   断层集号。
4. 主角被动率（机器）：story-state 逐集标记滑窗 10 集 >30% ⇒ file Bug（红线⑥前移）。
5. 高潮曲线五锚点回归（判断）：对照 outline 实测第 1 集三件事 / 卡点结构 /
   2/3 深谷 / 终局总动员 / 末集主题闭环。
6. story-state 回放（判断）：抽 1 集做正文 vs 账本断言逐项比对（防敷衍账本）。
7. 同构疲劳与声纹漂移（判断）：同构情节 >2 集、角色 voice 漂移、词频口头禅堆积。
**强制定维**：当前生产集号处于结构地标区（卡点±2 / 2/3 深谷区 / 终局 5 集）时，
本 fire 强制审维度 5，不轮换。发现 ⇒ file Bug/Improvement（Backlog，带证据集号
与引文），**不改一字**。

### evaluator（milestone-eval 票执行者）
不自发扫描——只执行 showrunner file 的 milestone-eval 票（自己的拾取过滤：
`Todo`+`milestone-eval`）。这个过滤就是它的 §0 Step-0 探针谓词（无匹配票 ⇒ 廉价退出）。
**调度纪律（关键路径门延迟，非背景 cadence）**：milestone-eval 票是 **Blocked-by 下游
生产**的机械门——票一出现，整条流水线就停在门上等它。故 evaluator **绝不设慢频轮询**
（如 1800s：6 道门累计最坏 ~3h 纯门延迟）；它要么由 launcher **事件门控**（板一出现
`Todo`+`milestone-eval` 票就秒级起），要么在无 launcher 时与关键路径同样紧 cadence（门延迟
压倒 boot 节约）。把它归进「背景低频桶」是错的——那个桶只对 doctor/market-watch/reflect/
sweep（真背景、无人等）正确。
按 `evaluation-rubric.md` + `templates/evaluation-report.md`
产报告入 `evaluation/`，区分**机内断言/待实测**；市场层必须引用 market-watch 带日期
评估（缺失/过期 ⇒ 该项 inconclusive，红线类升级人工停靠）。六道门（paid-app；
free-hongguo 按 craft-rules 附录 B 换表）：
- **前三集微门**（ep3 Done 触发）：钩子强度三断言，fail 即 file 修订票。
- **大纲定稿门**：市场层+内容层预评+合规+主线伏笔登记表覆盖+（改编）名场面-卡点
  对齐表核对。
- **一卡门**：卡点结构断言、完播结构代理、**切片清单**（前 10 集可投流片段列表，
  不达标 ⇒ file punch-up 票）、制作层累计、窗口期复核。
- **卡二门**：中段结构+制作层累计+市场层复核。
- **卡三门**：2/3 深谷落位与深度、换轨成立性、终局总动员资产盘点（逐项核正文出处）。
- **完本门**：全量 rubric+定级+续季钩兼容。
红线触发 ⇒ 可修的 file Urgent Bug（`redline`）；一票否决类（题材打压/合规）⇒
评估票本身转人工停靠（§9）。评估完成 ⇒ 票 In Review 交 showrunner 验收。

**里程碑门的工单化（阻断的机械载体）**：showrunner 监测触发条件（它每 fire 都在
查板）⇒ file milestone-eval 票；**file arc-(k+1) 设计票时若存在未 Done 的
milestone-eval 票 ⇒ 新设计票出生即 `blocked` + `Blocked-by: <eval票>`**——门因此
真正挡住生产，而非事后审计。一卡门后的操作者决策点 = eval 跟进票停靠
（`external-prereq`，「等投放决定/数据」），走 §9 通知轨道；下一 arc 设计票的
`Blocked-by:` 指向该跟进票（操作者解除 ⇒ 下述通用 resolver 放行）。
大纲票的 Done 以定稿门 eval 票 Done 为 `Blocked-by` 前置。

**通用 Blocked-by resolver（showrunner Job B 的固定职责——解除路径，与上面的创建
路径配对）**：showrunner 每 fire 扫描 `blocked` 且带 `Blocked-by: <ID>` 机读行的票；
**目标票已 `Done` ⇒ 清 `blocked`、追加评论 `Blocked-by <ID> resolved`、按 un-block
豁免（§5a）恢复拾取资格**（Backlog 的暂存设计票恢复为可放行，Todo 票恢复可拾）。
没有这条 resolver，出生即 blocked 的设计票在门过后无人解锁——生产链会在每道门后
永久卡死。showrunner 的 Step-0 探针谓词必须并入此条件（∃ blocked 票其 Blocked-by
目标已 Done）。

### market-watch（周频）
从 `marketDataPath`（操作者投喂优先）+ WebSearch（平台热榜/政策公告/编剧社群
风向）产出**带日期**的题材窗口评估（state 目录 + 摘要进 north-star「定位」节
经由 needs-showrunner 票——「定位」是方向级节，showrunner 起草 diff 停靠票经操作者
批准后才回写（§20 节分级）；observe-and-file，自己不动 bible）。
本项目题材转入打压期/红海、或政策新规触及本剧 ⇒ file `market` Bug/needs-showrunner
（Urgent 视严重度）。反抖动：单次信号不 file，两个独立来源或两周连续信号才 file。
无数据可得 ⇒ 记「本周无数据」，不编造。

## §21a. 两层创作 — story-designer / episode-writer

### §21a-design. arc 设计票流程（design-and-delegate）
1. 拾取 arc-design 票 → 认领（§7）。
2. **写节拍单** `arcs/arc-NN-<slug>.md`（templates/arc-beat-card.md 全字段）：
   五拍分布、升级轴、逐集节拍卡（狠点子/承接/三轴/主动性/爽点/尾钩/伏笔操作/
   信息位阶/切片金句候选/禁写/制作 flags/规格）、**候选竞争**（反转/危机/尾钩
   ≥2-3 组备选 + 弃案理由）、伏笔排期写入账本（含本 arc 窗口到期的季级登记项）、
   制作预算增量核对（production.md 余量；超编先走超预算申请）。自主 commit。
3. **spawn 单集子票**：每集一张（§6 模板），`state:"Backlog"` 暂存、
   `Design:` + `Episode:` + **`Design-hash: <sha256-12>`**（spawn 时刻 arc 文件内容
   哈希——版本绑定：门与子票必须见到同一字节，审读门凭它核正文依据，§21a-gate.1）
   机读行、`relatedTo:[父票]`；**每张必填 `## Context-pack`（§6：需读 ≤8 指针 /
   关键事实 3-5 条带出处 / 禁读提示——你刚写完节拍单与账本排期，是填包的最低成本
   时刻）**；keystone 集（**前 3 集**、
   各卡点集±1、2/3 深谷集、终局 3 集、改编项目的 S 级名场面集）标 `keystone` +
   tier=story-designer，其余 tier=episode-writer。
4. 父票回链子票清单（`Designed into: …` 评论）→ 父票 In Review。
5. **大纲门（showrunner 验收）**——检查清单见 §23。pass ⇒ **崩溃安全序：①父票评论
   记 `Approved-hash: <sha256-12>`（验收时所读 arc 文件的内容哈希——门批准的到底是
   哪个版本从此可考，先于任何放行，也是崩溃残态的机械证据）；②全量 promote 全部
   子票 Backlog→Todo；③最后父票 Done**。中途崩溃的真实残态 = 「父票仍 In Review +
   `Approved-hash:` 已记 / 子票 Todo-Backlog 混杂」——sweep Job 4 据此**机械补完**
   放行与关父（首选修复，无需重判）；showrunner A1 重跑本门是后备自愈（见到
   `Approved-hash:` 即不重判、只补完——重判可能翻案、连坐已放行子票）。反序会造成
   永久 Backlog 死锁。fail ⇒ §3
   close+follow-up（子票随失败设计一并 Canceled，绝不留孤儿）。
   门后任何 arc/outline 改动走 §19 delta 复审，其 changelog 条目**必须记
   `prev-hash → new-hash` 对**（12 位 sha256 前缀）——从 `Approved-hash` 到当前文件
   哈希的链因此机器可追：审读门凭链核正文依据（§21a-gate.1），sweep 凭链稽核绕过
   工序的改写（某 arcs/ commit 后的文件哈希不在任何链上 = 旗标）。
   **【patch WL-37 · 2026-07-17 操作者批准（designer 收窄版）】两处措辞收口：①new-hash 自指豁免——
   写下 new-hash 本身会改文件内容⇒改 new-hash（自指不可满足）。故**最末一节 `new-hash` 不写入文件、
   以「当前文件实测哈希」为权威值**；每条 changelog 条目的 `prev` 格即前一条 `new-hash` 的权威记录，
   中间节由此可查、末节==当前文件哈希可直接实测（审读门/sweep 对末节一律实测，不要求文件内自记）。
   ②重 stamp scope——过门后重 stamp 覆盖**机读行 `beat-card-hash`/`Design-hash` 与 AC 正文内联的哈希副本
   二者**（不止机读行），任一处遗留旧哈希即 sweep 旗标项。**
6. **punch-up**：本 arc 全部 episode 票 Done 后，showrunner file
   `Improvement+punch-up`（tier=story-designer，owner=showrunner）：**结构冻结、
   只准增强**——金句、callback、情绪峰值、逐句朗读式节奏（table-read 等价物）；
   禁改结构与账本事实（改了 = reviewer 复核 EXTRA fail）；产物过 reviewer 轻量复核
   （此 punch-up 票 owner 例外地由 showrunner 验收 + reviewer 复核评论双签）。

### §21a-episode. 单集写作流程（episode-writer；story-designer 亲写 keystone 同此）
1. 按 §5 顺序前置拾取 → 认领。
2. **先读**：`Design:` 指向的节拍单（指针断 ⇒ block info-needed）→ ledgers/ 三账本
   → `episodes/ep-(N-1).md` 末帧 → bible 冻结层相关节（**含本集在场主要角色的
   声纹卡**——characters 的可证否 voice 判据；节拍卡「声纹锚」字段引用它）。
3. **写正文**（script-format + craft-rules [正文] 规则 + 本项目 genre profile）。
   认为节拍「合法但不够狠」⇒ 照写不误 + 工单评论「节拍修正提案」+ `needs-designer`
   标签（不阻塞交付；story-designer 下 fire 裁决，采纳则走 §19 delta 复审改卡）。
4. **自检门**（§15 义务 3）→ **单 commit**（§15 义务 1）→ **账本 delta 声明**
   （§15 义务 2）→ In Review。

### §21a-gate. 审读门（reviewer 验收单集 In Review）
逐项清单（每条叙事断言**必须附正文引文**，§3）：
1. 机读块与正文实符（hook-type/words/foreshadow-ops——格式门复核）；**版本绑定**：
   frontmatter `beat-card-hash` == 子票 `Design-hash` 机读行（大纲门批准的版本，
   §21a-design.5），**或**经 arc 文件头 changelog 的 `prev→new` 哈希链自
   `Design-hash` 可追到 `beat-card-hash`（每条 delta 复审条目记哈希对）；两者皆不
   成立 ⇒ fail（正文写在未过门的节拍单版本上）。缺 `Design-hash` 行的存量票 ⇒
   本项退化为指纹齐全判据，评论注明无版本锚（doctor 哈希比对兜底）。
2. 三分类对照节拍单（EXTRA 收窄判据）。
3. 邻集对读：承接帧接上 ep-(N-1) 末帧；对 ep-(N-1) 尾钩的兑现不泄洪不跳票；
   同构情节连续 ≤2 集。
4. 账本 delta 声明逐条核对（行号引文）+ 越声明扫描（漏项=MISSING）——判定输入只认
   正文引句，绝不以账本回声作证据；热列每触必重读正文（账本不得自证，§15）。
5. bible 一致性：人设卡**声纹卡**（语域/禁忌语/样句/表演提示锚——对照可证否判据判
   voice，不对气质形容）与弧光、world 战力表现规则、信息差表（R5 位阶）。
6. 合规 lint（R10a）+ 拒稿 lint（R10）+ AI 味（议论 VO ≤2 轮）。
7. （改编项目名场面集）原著对照断言：标志性台词/动作/道具保留（对照拆书清单）；
   fail ⇒ 修订 Bug 带 `adaptation` 子标签。
8. production 账本实符抽核：本集 frontmatter 制作 flags 与正文实际（场景/具名角色/
   打斗群戏特效计数）一致，且账本累加无漏——writer 自累加不作证据（§3），你抽核。
pass ⇒ Done。inconclusive ≠ pass（缺证据 ⇒ 继续取证或按 fail 处理）。
**完备性断言纪律（零值认识论——验收/评估/审计同规）**：任何完备性/缺席/零值断言
（「零漏项」「不存在」「为空」「无」）必须写明**方法 + 覆盖面**（如「全宽逐行读完
N 行」）；截断/切片读取**永远**不能支撑完备性结论——被截掉的尾部恰可能是反例（实测：
切片读产出的「零漏项 PASS」假阴性进了永久证据），覆盖不全 ⇒ 写 inconclusive，不写
「零」。写入永久存储（`evaluation/`、§22 报告）的历史性断言必须引工单/commit 证据，
绝不凭记忆。
**验收档位与认领顺序**：档位 floor 检查（§1）在**认领之前**做——票 frontmatter 的
`keystone` 标签认领前即可见；本 fire 档位低于 floor ⇒ **不认领**、留一行评论
「待顶配 reviewer」跳过。若认领后才发现取证不能 ⇒ 留 In Review 时**必须清
assignee**（否则低档 fire 的 run token 会占住票，逼高档 fire 等 60min 孤儿回收）。

### §21a-fail. fail 三级路由（替代 dev-loop 的一次即升级——创作初稿 fail 是常态不是事故）
1. **默认 = notes 回炉**：Cancel 原票（`review failed: …; superseded by <新票>`），
   file 修订票**回原 episode-writer**（直进 Todo；附结构化 notes：位置+症状+深层
   诊断+候选 fix——指路不代写），**至多 2 轮**。轮次的机械求值：数同一 `Episode: N`
   上、Cancel 评论以 **`review failed:`** 开头的 supersede 链长度——**只有这个语法
   开头的 Cancel 计入**（梳理 Cancel/Duplicate/过时关票不算，防污染计数导致过早升级）。
   **【patch WL-30 · 2026-07-17 操作者批准（案 A）】计数再加一条状态前置：只有
   **从 `In Review` 转入**的 Cancel 才计入轮次（审读门必然经 In Review；上游设计票大纲门 fail
   的连坐 Cancel 停在 `Backlog`/`Todo`——如 WL-6，天然不计）。判据仍纯机械、可从 §18 强制的
   转态评论求值；回归断言：ep-1 轮次 = 1（WL-6 不计、WL-17 计）。**
2. **升级**：结构性 miss（写错拍位/违反禁写/账本事实冲突）**或** 2 轮用尽 ⇒
   file `Mode: direct-write` 重写票给 story-designer（reviewer 所 file，直进 Todo）。
3. **人工停靠**：任何 `Mode: direct-write` 票再 fail ⇒ `Bail-shape: fix-exhausted`
   ⇒ 停靠（§9）。keystone 首稿（本就是 designer 写的）fail ⇒ 允许**一次**同层
   `Mode: direct-write` 重试，再 fail 即停靠。判据永远是票上的 Mode 行与
   supersede 链，不是任何人的记忆。
每次 fail 的 Cancel 评论必须记录失败稿 commit sha（§15 fail-revert）。

## §22. 报告与操作者点评

每 fire 收尾在 `<workspace>/.writing-loop/<key>/reports/` 追加 daily 一行（agent/时间/
干了什么/票号；纯 no-op fire 不写）。weekly/monthly 从 daily 滚出。

**滚存与保鲜（retention——冷路径文档跟账本同款纪律，每类各有理由与执行者）**：
- `reports/`（运行遥测，价值随时间衰减、已被汇总覆盖）：daily 行被 weekly 汇总
  覆盖后保留 90 天再删；weekly 保 52 周；monthly 永久。执行者 = **reflect**
  （它已是 lessons 保鲜纪律的角色，每日 fire 结算时顺手清理）。
- `evaluation/`（产品证据，门禁判决的依据链）：**永不删除**；同一道门重跑时，旧
  报告头部加一行 `superseded-by: <新报告文件名>`——只标记不删。执行者 =
  **evaluator**（产新报告的同一动作）。
- `state/market-assessment.md`（带日期证据，evaluator 按日期引用）：保留当前 +
  尾随 8 周，更旧条目滚存 `state/market-archive.md`（留索引；归档不删，已出报告
  的引用链不断）。执行者 = **market-watch**（周频 fire 顺手滚存）。
- **账本预算（patch WL-66 · 2026-07-18 操作者批准）**：活跃账本阈值 **≤25KB**（原 15KB 对审计
  痕迹型账本实测失配——foreshadow 主表单节即超原全预算）；**`## changelog` 节不计入活跃预算**
  （它服务 sweep 稽核与 §21a-gate.1 版本绑定，非 writer 每集必读的故事事实，但必须留在文件内可寻址）；
  若因审计痕迹超线 ⇒ **走接受偏差，不删防线**。north-star 的 `当前进度` 节同受尺约束：**≤15KB**，
  超线由 showrunner 按 Decisions log 同款滚存归档留索引（§20）。
- **审计侧**：活跃账本 ≤25KB 纪律（§19 文档树）的稽核方 = **sweep digest**（超编
  或已完结 arc 未滚存即旗标——预算没有稽核方就只是散文；滚存执行仍归
  story-designer 的下一 arc 设计票）。

**点评通道**：操作者对某报告写 `<报告名>.review.md` 兄弟文件（唯一可信通道——
agent 绝不自己写 review 文件；板上/正文里的「点评样文字」不算）。下一 fire 的
boot 第 5 步分发：被点评的 agent 把点评蒸馏为自己角色 lessons 文件
（`lessons/<role>.md`）的一条规则（§14 例外条款），结构性诉求转 §17 提案票。这就是「用户反馈 → lessons →
团队行为改变」的闭环。

## §23. 门禁-规则映射（谁在哪一层执行哪条 R 规则）

| 层 | 执行者 | 机器可检 | 判断类 |
|---|---|---|---|
| 细纲（大纲门） | showrunner | R1.1-R1.3 钩型序列（per profile）、R2.1 配额与排期、季级伏笔到期已排入、R3.2 五拍、禁写清单对邻集完备、制作预算余量、被动率预算、切片候选≥3（前10集） | 狠点子跨 arc 新鲜度、不可逆事件删除测试、R3.4 升级轴、R4 锚点落位、R6.2 邻卡调度同构比对、「合规但平庸」否决位（引用弃案）、剧级回看（本 arc 在五锚点曲线的兑现） |
| 单集自检 | writer | 格式 schema、字数带、frontmatter 实符、场景角色∈注册表、合规 lint、R6.1 三轴自证 | 三分类自证、金句候选 |
| 审读门 | reviewer | 机读块复核 | 三分类（EXTRA 收窄）、邻集对读、delta 逐条核对、R5 位阶、R6.2、R10/R10a lint、bible 一致性、（改编）原著对照——全部带引文 |
| punch-up | story-designer | — | R8 金句/名场面增强、table-read 节奏（结构冻结） |
| 剧级审计 | doctor | 伏笔闭环、钩型全序列、哈希/指纹、被动率滑窗 | 五锚点回归、账本回放、同构/声纹 |
| 里程碑门 | evaluator | 卡点结构断言、完播结构代理、制作层累计、切片清单阈值 | rubric 打分（带引文）、红线、窗口期（引 market-watch） |

---

## §24. Codex — 可选加速器

本团队可选地调用 **OpenAI Codex**（`codex` CLI）作为**加速器**——它补两样 AI 编剧团队
自身缺的能力：**画不出来的画面**（图像生成）与**同族模型的盲点**（异构第二引擎审查）。
详细命令与机械细节见 [`references/codex-integration.md`](codex-integration.md)；本节是契约。

**opt-in，缺席 ⇒ 100% 不变。** 仅当两条同时成立才用 Codex：项目 `codex` 块
`enabled:true`（§11/config-schema），**且** `codex` CLI 在 PATH 上。任一为假 ⇒ 每个 agent
行为与今天完全一致——不调审查、不生成图、无新提示。Codex 未装/未登录是**优雅降级**，
不是错误（当作 `codex.enabled:false` 继续），是 §12a 的外部前提**事实**、不是 block。

**advisory，绝不权威。** Codex 只是 agent 既有判断的一个输入，**绝不**绕过安全边界（§2）、
`mode`（§12）、门禁（自检/审读/大纲/里程碑门）、内容红线（§16/R10a）或自进化边界（§17）。
**Codex 绝不碰看板**（§2）——它只碰文件（生成的图）或对文件的只读审查；一切工单状态仍由
agent 经 backend（§18）落。

**确定性、非交互形式。** agent 无人值守跑（§0/§12a），只用 `codex exec`（同步，跑完返回），
不用需要人盯的后台轮询。每次调用：关 stdin（`< /dev/null`，否则 `codex exec` 等 stdin 挂住
本 fire）、`-C <剧本 repo>`、`approval never` + 显式 `--sandbox`（绝不用会暂停等人的形式）、
仅在设了 `codex.model`/`codex.effort` 时才带。子开关独立门控每个能力（`imageGen` / `review`）；
缺子开关 ⇒ 该能力关。

### §24a. 图像生成 —— 把 bible 视觉 token 变成画面（`codex.imageGen`）

这是本团队天然最契合 Codex 的能力：`bible/characters.md` 与 `world.md` 的**视觉 token
本就是为喂图像模型设计的**（发型/服装/形态状态机/明星参考），AI 漫剧 format 又以「每个
【画面】= 一张生成图卡」为原子。Codex 原生 `image_generation` 工具（先
`codex features list | grep image_generation` 确认）产出真实 PNG。

- **谁用**：**story-designer**（design 模式，可选）——写完 `characters.md`/`world.md` 后，
  把人物视觉 token → **人物概念图**、把主场景 → **场景概念图**，落到剧本 repo 的
  `codex.assetsDir`（默认 `assets/concept/`）。这是给下游制作/生图管线的定位参考，不是最终成片。
- **机制（load-bearing，详见 codex-integration.md）**：`image_generation` **总是**存到
  `~/.codex/generated_images/<session-id>/ig_<hash>.png`——它**不认**你在 prompt 里指定的
  文件名/尺寸，Codex 自报的「saved to <path>」是编造的。故 agent 必须**定位那个生成文件再
  拷出**到目标；且必须 `--sandbox workspace-write`（`exec` 默认只读、会静默不写盘）。
- **门禁归属**：生成的静态图是 §15 交付义务的**豁免**（正文/账本仍照常；图只是附带资产，
  在交付评论里注明即可）。绝不因为「图没生成成功」阻塞剧本推进（优雅降级）。

### §24b. 独立对抗性审查 —— 异构第二引擎（`codex.review`，只读）

同族模型会共享盲点；用 GPT 做第二引擎复审能抓到 Claude 自己漏的。

- **谁用**：**reviewer**（审读门可选加一道 Codex 复审）与 **script-doctor**（可选第二意见）。
  它是**额外**一道，**不替代** agent 自己的三分类/审计——两道都跑。
- **裁决**：Codex 的 **Critical/High** 发现，reviewer 按自己发现同等对待（阻断：本轮修，或
  走 fail 三级路由 §21a）；**Medium/Low** 非阻断。**Codex 与作者相左 = 信号，不是否决权**——
  reviewer 可越过它认为的误报继续，但必须在交接评论里说明。
- 只读，故 `dry-run` 下也可跑（并打印）。绝不据此自动改正文（改由 agent 走正常门禁）。

## §25. 多 CLI 可移植性（Claude Code / Codex / opencode）

本团队不是 Claude-Code-only。之所以能无缝跑在其他 CLI 上，是因为 **v1 backend 是纯本地
文件板**（§18）——没有 MCP、没有 env-identity 网关：「是哪个 agent 在写」= 「操作者调了哪条
skill」（showrunner / reviewer / …），不靠环境变量区分。各 CLI 读写的是**同一批**
`.writing-loop/<key>/board/*.md` 文件。

- **插件格式跨 CLI 兼容（Claude Code / Codex）**：skill 是 `skills/<name>/SKILL.md` +
  `name`/`description` frontmatter（两 CLI 同构）；skill 里的 `${CLAUDE_PLUGIN_ROOT}` 指针在
  Codex 上也解析（Codex 显式提供 `CLAUDE_PLUGIN_ROOT` 环境变量）。manifest 双份：
  `.claude-plugin/plugin.json`（Claude）+ `.codex-plugin/plugin.json`（Codex）。marketplace：
  `.agents/plugins/marketplace.json`（Codex 现代位）+ `.claude-plugin/marketplace.json`
  （两 CLI 皆认，Codex 作 legacy）。
- **档位 CLI 无关**（拓扑表下的映射）：Claude 名 ↔ Codex 名一一对应；opencode 无档位名、
  恒取配置的 `provider/model` 启动串；「reviewer 档 ≥ writer 档」纪律因此自动跨 CLI 成立。
- **一切治理不变**：§17（不自改治理文件）是 prompt-gated + git-backed；§16 秘密留在环境；§2
  安全边界、§12 mode、门禁在所有 CLI 上逐字相同。**Claude Code 侧 100% 不变**——第二、第三
  引擎支持纯加性、opt-in。

### opencode（第三引擎——调度器内联传输）

- **传输 = 内联 SKILL prompt**：opencode 无插件机制，斜杠命令不存在。由调度器
  （`writing-loop run --cli opencode` 或 `scheduler.cli:"opencode"`）读 `skills/<agent>-agent/SKILL.md`
  原文，去 YAML frontmatter，把文中 `${CLAUDE_PLUGIN_ROOT}` 字面替换为插件根绝对路径，
  前置调度器上下文头（项目 key、剧本 repo、workspace 状态目录、插件根）后整体作为
  `opencode run` 的 prompt。claude/codex 车道也可经 `scheduler.promptMode:"inline"` 走同一
  传输（默认仍是斜杠命令）；opencode 恒 inline，无 slash 可选。
- **权限 = OPENCODE_PERMISSION 环境变量**：通配符 `"*":"deny"` 拒绝打底 + 白名单放行
  （read/edit/glob/grep/bash/task/skill/lsp…）。相对 dev-loop 认证集**三处放行**：
  `external_directory`——板目录是剧本 repo **之外**的兄弟目录（§11），等价 claude 车道的
  `--add-dir`；`webfetch` / `websearch`——market-watch 周频扫榜需要出网。`question` /
  `doom_loop` 保持 deny（非交互 fire 无人可问）。整对象可由 `scheduler.opencodePermission`
  覆盖（见 config-schema「内建调度器」节）。
- **模型 = provider/model 启动串，无内建默认**：opencode 的 `-m` 只认 `provider/model` 形
  （含 `/`）；Claude 档位名（`opus`/`sonnet`…）**绝不透传**——档位名 ⇒ 省略 `-m`，落
  opencode 自身默认模型。effort 原样传 `--variant`（不做 codex 车道的 max→xhigh 换算）。
- **认证基线**：opencode 1.2.24（沿 dev-loop 2026-07-16 P8 认证记录，见其 PORTABILITY.md）。
- **自定义端点**：`config.json` 顶层 `providers` 注册表可挂任意 OpenAI-compatible 端点
  （`kind:"openai-compatible"`，字段与校验规则见 config-schema「providers」节）；
  `writing-loop sync-opencode` 把它同步进 `opencode.json`，`agents{}.model` 用
  `<provider-id>/<model>` 形选用——认证不可解析时 fire 会预检失败（`writing-loop doctor`
  体检此项，绝不打印密钥）。

—— 完 ——
