# writing-loop — 共享约定（Shared Conventions）

本文件是 writing-loop 全体 agent 的单一真相源：状态机、标签、模板、安全边界、
门禁、账本纪律与配置。**与任何 SKILL.md 冲突时，以本文件为准。**
姊妹参考：`script-format.md`（格式规范）、`craft-rules.md`（写作规则 R1-R11 + 附录）、
`evaluation-rubric.md`（评分与红线）、`config-schema.md`（配置）。
设计依据与调研证据：`docs/DESIGN.md`、`docs/RESEARCH/`。

## 目录
§0 首要指令与 boot ｜ 拓扑一览 ｜ §1 系统是什么 ｜ §2 安全边界 ｜ §3 状态机 ｜
§4 标签分类 ｜ §5 优先级与拾取序（含顺序前置与前向冻结）｜ §5a Backlog-first ｜
§6 工单模板 ｜ §7 认领 ｜ §8 去重 ｜ §9 Blocked 协议与人工停靠 ｜ §10 查询纪律 ｜
§11 配置 ｜ §12 dry-run 与自治 ｜ §13 首跑安装 ｜ §14 lessons ｜ §15 交付义务 ｜
§16 内容红线 ｜ §17 自进化边界 ｜ §18 本地板协议 ｜ §19 文档体系与修订涟漪 ｜
§20 north-star ｜ §21 观察型角色与里程碑门 ｜ §21a 两层创作 ｜ §22 报告与点评 ｜
§23 门禁-规则映射

---

## §0. 首要指令 — 每次 fire 都是全新的

Agent 之间**从不直接对话**：所有协作只经工单的 state + label + comment + 机读行
（`Design:` / `Blocked-by:` / `Mode:` / `Episode:` / `Bail-shape:`）交接。任何
「我在报告里说了」「上次运行时我记得」都不是协作载体——没有工单/文件载体的约定
等于不存在。

**每次 fire 无状态**：状态只存在于看板（§18）、剧本 repo（git）、数据目录三处。
每次运行从头重读 ground truth；绝不信任对话记忆。硬失败时记一行日志退出，
下次 fire 重试。

**自治 = 门禁不是提问**：红灯不交付；fail 自动走三级路由（§21a）；真正只有人能做
的决定（方向变更、一票否决、fix-exhausted）以工单形式停靠（§9），不是聊天提问。

### 标准 boot 序列（每个 agent、每次 fire）
1. 读本文件（`${CLAUDE_PLUGIN_ROOT}/references/conventions.md`）。
2. 读 workspace 配置（§11）定位项目条目；无法定位 ⇒ 问操作者，不猜。
3. 确认 backend（v1 恒为 local 文件板，§18）与数据目录。
4. 读 lessons（§14）：`## Shared` + 自己的分节，规则可预先改变本 fire 的动作。
5. 报告结算（§22）：到期的 daily/weekly 汇总；分发未消化的 `*.review.md` 点评。
6. 一行开场：项目、mode（live/dry-run）、intake.mode、本 fire 打算做什么。

## 拓扑一览

| agent | 原型（dev-loop） | 默认档位 | 一句话职责 |
|---|---|---|---|
| showrunner 总编剧 | PM | opus/max | north-star+outline 唯一维护者；立项/方向 intake；file 创作票；大纲门验收；里程碑监测与 milestone-eval 票发起；Backlog 闸门 |
| story-designer 细纲师 | senior-dev | opus/max | arc 设计票→逐集节拍单（候选竞争+弃案）→spawn 子票；keystone 亲写；`Mode: direct-write` 升级接管；punch-up 执行 |
| episode-writer 编剧 | junior-dev | sonnet/high | 单集票→读节拍单+账本+上集→写正文→自检门→账本 delta 声明→In Review |
| reviewer 审读 | QA | **≥ writer 档**（受治理配置，默认 opus/high） | 单集独立验收；fail 三级路由；修订复核；邻集复核 |
| script-doctor 剧本医生 | Architect | opus/xhigh | 慢频轮换维度剧级审计（§21）；结构地标区间强制定维 |
| evaluator 评估官 | — | opus/xhigh | 执行 milestone-eval 票（六道门 + rubric + 红线，§21） |
| market-watch 市场监察 | Ops | sonnet/high | 周频扫榜+政策；带日期题材窗口评估；变化⇒needs-showrunner 票（§21） |
| reflect | Reflect | opus/xhigh | retro + lessons 策展（§14/§17/§22） |
| sweep | Sweep | sonnet/high | 生命周期卫生：错标修复、孤儿回收、板健康摘要 |

操作者 skill：`add-script`（立项 interview + scaffold + 注册，§13）。
验收模型纪律：**reviewer 的模型档位永不低于其验收对象的创作档位**（配置受 §17 治理）。
其 floor = max(reviewer 默认档, 被验票的创作档)——**keystone 集由 story-designer
以 opus/max 亲写，故其验收也须在 opus/max 的 reviewer fire 上进行**；一个档位低于
floor 的 reviewer fire 遇到超档的 In Review 票时**跳过留待更高档 fire**（不橡皮图章），
不 fail 不改状态。运行方（cron/操作者）据此为 keystone 验收排一条 opus/max reviewer
pass；默认 opus/high 只覆盖 episode-writer（sonnet/high）产出的普通集。

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
| Todo | 已梳理、可拾取。**仅经 showrunner 放行**（§5a；豁免：verify-fail 跟进票、un-block 重排、大纲门子票全量放行） | showrunner；verifier；story-designer（大纲门后由 showrunner 放行） |
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

## §4. 标签分类

**标记（每票必带）**：`writing-loop`（§2）。

**Type（恰一）**：`Feature`（创作票：outline/arc-design/episode/milestone-eval/立项）、
`Bug`（修订票：审读/doctor/evaluator/涟漪分析发现的缺陷）、`Improvement`
（打磨票：punch-up、非缺陷优化）。

**Owner（恰一——按票类，不按 Type；决定谁验收）**：
- `reviewer`：**全部 `episode` 票**（含 `Mode: direct-write` 重写票——Feature 中的
  显式例外：离观众最近的产物必须独立验收）、全部 `Bug`（**`market` 子标签的 Bug 除外**，
  下述例外）、reviewer 所 file 的 Improvement。
- `showrunner`：outline / arc-design / milestone-eval / 立项票、其余 Improvement
  （含 punch-up）、以及 **`market` 子标签的 Bug**（市场/定位缺陷是战略层，reviewer
  无从对正文验收 ⇒ 归 showrunner，与「episode+Feature+reviewer」并列的第二条 owner
  例外；showrunner 的处置是改 north-star/方向，其「验收」= 决定 file 何种应对票）。

无 owner 标签的票会搁浅在 In Review——sweep 错标清单第一项。
**`episode`+`Feature`+`reviewer`** 与 **`market`+`Bug`+`showrunner`** 是两个合法组合，
sweep 不得分别按「Feature⇒showrunner」「Bug⇒reviewer」改回。

**Tier 路由（创作票恰一；§21a 编码）**：`story-designer` / `episode-writer`。
未标 tier 的**创作票**（Feature）对两个拾取查询都不可见（sweep 捡漏项）。
**Improvement 的 tier 由 showrunner 在 §5a 梳理时赋予**（放行前）：punch-up ⇒
story-designer；doctor/reviewer 所 file 的 craft 打磨（声纹/节奏/台词）⇒ 默认
episode-writer（scoped 增强）。filer 建 Improvement 时可不带 tier；无 tier 的
Improvement 停在 Backlog 等 showrunner 赋 tier + 放行，**不**搁浅（Bug/Feature 的
无 tier 才是 sweep 旗标项）。

**子类型（可叠加）**：`episode`（单集）、`arc-design`、`outline`、`milestone-eval`、
`punch-up`、`continuity`（连续性缺陷/邻集复核）、`pacing`、`foreshadow`（伏笔账本
缺陷）、`hook`、`redline`（evaluator 红线，恒 Urgent）、`compliance`（合规）、
`adaptation`（改编偏差）、`keystone`（关键集）、`market`（market-watch 所 file）。

**工作流信号**：`blocked`、`external-prereq`、`needs-showrunner` / `needs-reviewer` /
`needs-designer`（提案/求助路由）、`notified`（已带外通知，防重复推送）。

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
2. **前向冻结**：不存在 `Episode ≤ N` 的开放 **Bug** 修订票（事实可能被改——
   Improvement/punch-up 结构冻结、不改账本事实，**不**触发冻结）。
3. **arc 首集**：上一 arc 的全部 episode 创作/重写票 Done（开放的修订 Bug 不阻塞
   跨 arc 开工——修订票本可插队并行）。
`Mode: direct-write` 重写票天然满足 1（重写的是已存在的集），显式豁免检查 1。
不满足 ⇒ 跳过取下一候选，不 block 不评论（这是常态节流，不是异常）。

### §5a. Backlog-first 进件与 Todo 深度上限

一切新发现的工单（showrunner 构想、reviewer/doctor/evaluator/market-watch 的发现、
操作者进件）落 `Backlog`，**只有 showrunner 放行到 Todo**，且放行时
`count(Todo, not blocked, 非 episode)` < `intake.todoDepthCap`（默认 10）。
三个豁免直进 Todo：verifier 的 verify-fail 跟进票、un-block 重排、
大纲门 pass 的子票全量放行。**`episode` 创作子票不计入深度**——它们的节流由 §5
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
## Acceptance criteria
- 逐项符合节拍单 ep-012（三分类验收；EXTRA=禁写违反+账本事实冲突）
- §15 交付义务完成（单 commit / 账本 delta 声明 / production 计数）
- script-format 机读块完整且实符
## How to verify
reviewer 按 §21a 审读门清单。
```

**修订票（Bug + 子类型 + episode-writer）**：Context 写症状与出处（审读 fail 的
notes / doctor 审计条目 / evaluator 红线），`Episode: N` 必带，AC 写可判定修复项
+「§19 涟漪分析完成」。

**arc 设计票（Feature + arc-design + story-designer，owner=showrunner）**：AC =
节拍单完整（每集全字段）+ 候选竞争弃案记录 + 伏笔排期入账本 + 预算增量合规 +
子票已 spawn（Backlog 暂存）。

**milestone-eval 票（Feature + milestone-eval + evaluator 执行，owner=showrunner）**：
Context 写触发条件（如「ep1-10 全 Done」）；AC = 报告落 `evaluation/` + 红线结论 +
后续动作票已 file。

**邻集复核票（Bug + continuity + owner=reviewer + tier=episode-writer）**：由完成
修订验收的 reviewer 在同一验收动作里 file（直进 Todo，verify-fail carve-out 语义）；
AC =「ep-N±1 与修订后 ep-N 的承接帧/钩子兑现/信息位阶一致；不一致处已修复」。

## §7. 认领（并发安全）

拾取 ⇒ 认领：工单 `assignee` 写入**本 fire 的唯一 run token**（如
`episode-writer (run 3f2a)`），置 `In Progress`，**重读验证 token 是自己的**才开工
（两个同角色 fire 的仲裁）。孤儿回收（每 fire 第 0 步）：`In Progress` + assignee
非本 fire + **无交付产物**（无对应 commit）+ 认领超时（>60min 无更新）⇒ 清 token
重排 `Todo`。孤儿回收判定**不要求** token 等于自己（崩溃 fire 的 token 按定义不是
现任的）。

## §8. 去重

file 任何票前先查同项目开放票（标题关键词 + `Episode:` 字段 + 子类型）。同集同症状
⇒ 评论补充到既有票，不开新票。跨 arc 的同类审计发现（如两个 arc 都钩型单一）
是两张票（修复对象不同）。

## §9. Blocked 协议与人工停靠

实现中遇到无法推进：加 `blocked` 标签 + 评论首行 `Bail-shape: <形>`：
- `info-needed`：spec 不清 / `Design:` 指针断 ⇒ 路由 `needs-showrunner`（大纲/方向类）
  或 `needs-designer`（节拍类）。
- `decision-needed`：两个合法方向要选 ⇒ `needs-showrunner`。
- `scope-design`：比票面大，需要设计 ⇒ `needs-showrunner`（应转 arc-design/重拆）。
- `external-prereq`：等系统外的事（操作者投放数据、授权、政策裁决）⇒ **人工停靠**。
- `fix-exhausted`：三级路由用尽（§21a）⇒ 人工停靠。
盲试上限 2 次；同一票 block-cycle ≤3（第 4 次 ⇒ 升格 external-prereq 人工停靠）。
`blocked` 票不在任何拾取序内。showrunner 每 fire 扫 `needs-showrunner`，reviewer 扫
`needs-reviewer`，story-designer 扫 `needs-designer`（裁决节拍修正提案）。

**人工停靠通知**：config `comms.provider` 配置时（§11），首次停靠即向带外通道推送
一条（写明票 ID + 需要的决定），加 `notified` 防重推；未配置 ⇒ 停靠票在 daily
digest 的 needs-attention 节置顶（操作者需日查——这是显式声明的 v1 fallback，
不是遗漏）。解除：操作者在票上留言/改标签，showrunner 下 fire un-block 重排。

**操作者进件（W3 等价）**：操作者随时可 file `Backlog` + `needs-showrunner` 票
（方向变更/新剧立项/点名修改）。showrunner 以完整 §9a 待遇处理：拆解为具体子票
（`Groomed into: <IDs>` 评论 + 关父票）——响应显式进件不算 passive 违例。

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
    <key>/lessons.md reports/ state/
  my-drama/                  ← 剧本 repo（创作成果，独立 git 历史，零调度噪音）
  another-drama/
```

`.writing-loop/` 是**各剧本 repo 之外**的兄弟目录——工单状态不进任何剧本的 git
历史（否则 `state: X→Y` 会污染正文提交）。它 untracked、绝不共享、绝不放网络盘
（原子 rename 需单一文件系统）。

**Workspace 根解析（boot 时，按优先级）**：
1. `WRITINGLOOP_WORKSPACE` 环境变量（显式指定根）。
2. 否则从 CWD **向上逐级找**已存在的 `.writing-loop/` 目录（像 git 找 `.git`），首个命中即根。
3. 都没有 ⇒ 未在 workspace 内：agent 报错并请操作者先 `add-script` 立项（它会确立
   workspace，见 §13）；不猜、不在 home 目录乱建。
（低层覆盖：`WRITINGLOOP_DATA_DIR` 可把 `.writing-loop/` 状态目录单独指到别处——罕用。）

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

## §12. dry-run 与自治

`mode:"dry-run"`：不写板、不 commit、不推送通知——打印「本会 file/验收/写什么」。
`mode:"live"`：全部生效。自治边界（§12a）：产品内决定（怎么写、怎么修、先做哪张票）
自决不问；**人类专属决定**（方向变更、一票否决红线、fix-exhausted、已投放集的
追溯修改、预算上调）以停靠票呈现（§9），不聊天等待。

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
   创建板目录；scaffold lessons.md 全部分节。
4. **首张票**：file 大纲票（Feature+outline+story-designer，owner=showrunner——
   **showrunner 不得自领大纲票**，保持验收独立性）。

## §14. lessons 文件 — 操作者级修正

`<workspace>/.writing-loop/<key>/lessons.md`，分节：
`## Shared / showrunner / story-designer / episode-writer / reviewer / script-doctor /
evaluator / market-watch / sweep / reflect`。
每个 agent 每 fire 读 `## Shared` + 自己分节并遵行；**只有 reflect 可写**（策展：
从 ≥2 次复现的证据添加/合并/过期规则，每条附证据票号）。唯一例外：任何 agent
在分发**操作者对其报告的书面点评**（`*.review.md`，§22）时可向**自己分节**加一条。
预算：每节 ≤6 条、全文 ≤150 行；每条带 `added:`/`last-seen:`；两周未复现 ⇒ 过期删除；
证明普适 ⇒ 走 §17 提案升格进本文件后从 lessons 删除。多写者 ⇒ 锁协议（§18 同款）。
写作团队特有证据源：evaluator 评分趋势、reviewer fail 分类统计、punch-up 修改
类型统计——reflect 每日 retro 的输入。

## §15. 交付义务（coverage 的写作等价物）— 账本回写强制令

单集票移入 In Review 前，实现者必须完成（缺一 = 审读门直接 MISSING fail）：
1. **单 commit 原子性**：单集正文 + `ledgers/` 全部更新（foreshadow 状态、
   story-state 当前值与逐集末态摘要、production 计数）在**同一个 commit**；
   工单转态永远在 commit 之后。commit message 带票号。
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
   陈旧强清）；拿不到锁 ⇒ 本 fire 票留 In Progress，下 fire 续。

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

reflect **可自主改**：仅 lessons.md（可逆、每操作者、不入库）。
**任何 agent 不得自改**：本 conventions、任何 SKILL.md、craft-rules/script-format 的
规则本体、genre profile 参数表——结构性改动一律起草为**提案票**
（`blocked`+`needs-showrunner`+`external-prereq`，出生即停靠——机械防火墙：blocked
使其不进任何拾取序，external-prereq 使 showrunner 停靠给操作者而非解锁回流水线）。
操作者应用提案 = 人类授权。产品文档（north-star/outline/arcs/账本/正文）不在此列
——它们是产品本身，按 §19/§21a 的门禁流转。genre profile 校准结果同走提案流程。

## §18. Backend — 本地文件板协议（v1 唯一 backend）

板目录：`<workspace>/.writing-loop/<project-key>/board/`（workspace 根解析见 §11；
`WRITINGLOOP_DATA_DIR` 可把 `.writing-loop/` 整体指到别处）。
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

**ID 分配（O_EXCL 竞争安全）**：读 counter 取起始 N → **独占创建**
`tickets/WL-N.md`（O_CREAT|O_EXCL，OS 保证唯一赢家）→ 已存在则 N+1 重试 →
成功即拥有该 ID，写入内容，尽力回写 counter（输掉回写无害）。ID 单调不复用。

**并发**：读-改-写必先独占创建 `tickets/<ID>.lock`；改经同目录临时文件 + 原子
rename；释放锁。**陈旧锁规则（强制）**：锁文件 mtime >60min ⇒ 陈旧，删除并记一行
日志继续（否则一次崩溃 fire 永久死锁该票）。临时/锁文件非 `*.md`，列表 glob 天然
忽略。认领用 run token（§7）；孤儿回收是反向检查。

**操作映射**：list=glob 本板 `tickets/*.md` 解析 frontmatter 进程内过滤（含
`Episode:` 机读行）；get=读单文件；create=分配 ID 独占创建；update=锁内读改写
（labels 全集重传、relatedTo 并集、转态评论、bump updated）；comment=追加。
每个 glob **严格限定本项目板目录**——跨项目即违反 §2。

## §19. 文档体系、版本纪律与修订涟漪协议

### 文档树（每剧本 repo；landing 恒为 direct-commit，无 PR）
```
bible/{north-star,characters,world}.md   # 冻结层：改动只经 showrunner（north-star）
                                          #   或大纲门内的 story-designer（characters/world 增补）
outline.md                                # 总大纲：单元表/高潮五锚点/卡点规划/主线伏笔
                                          #   登记表（季级）/名场面规划/续季钩规划
arcs/arc-NN-<slug>.md                     # 逐集节拍单 + 候选竞争弃案（§21a design doc）
ledgers/foreshadow.md                     # 伏笔账本（planned→planted→refreshed→paid；
                                          #   dropped→续集钩；sequel-hook 可预标）
ledgers/story-state.md                    # 当前态 + 本 arc 逐集末态摘要 + 被动标记
ledgers/production.md                     # 制作预算：场景/角色注册表 + 成本计数器
ledgers/archive/arc-NN.md                 # 每 arc 滚存（活跃账本 ≤15KB 纪律）
episodes/ep-NNN.md                        # frontmatter 指纹 + 正文（script-format）
evaluation/                               # 里程碑评估报告 + 切片清单
source/                                   # 原著+拆书三清单 / 对标剧轻量拆解
```

### 版本纪律 — 防「已过门工件被静默改写」
- 单集 frontmatter 记 `beat-card-hash`（写作时刻 arc 文件内容哈希）+ `model` +
  `rules-version`。doctor 每轮把当前 arc 文件哈希与全部已 Done 集的记录哈希比对，
  不一致 ⇒ 得到「依据已过期」集清单 ⇒ file continuity Bug。
- **大纲门之后改 arc/outline ⇒ delta 复审工序**（story-designer/showrunner 谁改谁
  发起）：①在文件头 changelog 列改动条目；②机器算受影响的已 Done 集（哈希失配 +
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
  同步改**当集摘要行**及其后受影响行，这本身就是涟漪分析的对象。
7. **已投放水位（airedThrough）**：`Episode ≤ airedThrough` 的修订票机械转型——
  要么改写为**前向修补票**（在未投放的后续集内解释/兜住，原集正文不动），要么
  人工停靠。禁止追溯修改已投放集的正文与其账本记录（观众 canon 不可变）。

## §20. north-star（bible/north-star.md）— 剧本的战略文档

八节结构（templates/north-star.md）：一句话故事 / 定位 / 核心情绪引擎 / 结局承诺 /
创作红线（Non-goals）/ 制作约束 / 当前进度 / Decisions log + Candidate ideas。
**showrunner 是唯一写者**，职责：
- **doc-watch**：每 fire 对比上次快照（state 目录存哈希），操作者的任何修改 =
  最高优先进件，按 §9a 拆解执行。
- **回写**：里程碑过门、方向决策、评级结果、偏差接受——发生即回写「当前进度」
  与「Decisions log」。过时的北极星比没有更危险。
- **滚存**：Decisions log >20KB ⇒ 滚存归档留索引。
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
`Todo`+`milestone-eval`）。按 `evaluation-rubric.md` + `templates/evaluation-report.md`
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
（`external-prereq`，「等投放决定/数据」），走 §9 通知轨道；操作者解除后
showrunner 放行 arc-02。大纲票的 Done 以定稿门 eval 票 Done 为 `Blocked-by` 前置。

### market-watch（周频）
从 `marketDataPath`（操作者投喂优先）+ WebSearch（平台热榜/政策公告/编剧社群
风向）产出**带日期**的题材窗口评估（state 目录 + 摘要写入 north-star「定位」节
经由 needs-showrunner 票请 showrunner 回写——observe-and-file，自己不动 bible）。
本项目题材转入打压期/红海、或政策新规触及本剧 ⇒ file `market` Bug/needs-showrunner
（Urgent 视严重度）。反抖动：单次信号不 file，两个独立来源或两周连续信号才 file。
无数据可得 ⇒ 记「本周无数据」，不编造。

## §21a. 两层创作 — story-designer / episode-writer

### arc 设计票流程（design-and-delegate）
1. 拾取 arc-design 票 → 认领（§7）。
2. **写节拍单** `arcs/arc-NN-<slug>.md`（templates/arc-beat-card.md 全字段）：
   五拍分布、升级轴、逐集节拍卡（狠点子/承接/三轴/主动性/爽点/尾钩/伏笔操作/
   信息位阶/切片金句候选/禁写/制作 flags/规格）、**候选竞争**（反转/危机/尾钩
   ≥2-3 组备选 + 弃案理由）、伏笔排期写入账本（含本 arc 窗口到期的季级登记项）、
   制作预算增量核对（production.md 余量；超编先走超预算申请）。自主 commit。
3. **spawn 单集子票**：每集一张（§6 模板），`state:"Backlog"` 暂存、
   `Design:` + `Episode:` 机读行、`relatedTo:[父票]`；keystone 集（**前 3 集**、
   各卡点集±1、2/3 深谷集、终局 3 集、改编项目的 S 级名场面集）标 `keystone` +
   tier=story-designer，其余 tier=episode-writer。
4. 父票回链子票清单（`Designed into: …` 评论）→ 父票 In Review。
5. **大纲门（showrunner 验收）**——检查清单见 §23。pass ⇒ **先全量 promote 全部
   子票 Backlog→Todo，最后父票 Done**（崩溃安全序：崩在中间留下的是「票已放行、
   父票未关」，sweep 可安全补关；反序会造成永久 Backlog 死锁）。fail ⇒ §3
   close+follow-up（子票随失败设计一并 Canceled，绝不留孤儿）。
6. **punch-up**：本 arc 全部 episode 票 Done 后，showrunner file
   `Improvement+punch-up`（tier=story-designer，owner=showrunner）：**结构冻结、
   只准增强**——金句、callback、情绪峰值、逐句朗读式节奏（table-read 等价物）；
   禁改结构与账本事实（改了 = reviewer 复核 EXTRA fail）；产物过 reviewer 轻量复核
   （此 punch-up 票 owner 例外地由 showrunner 验收 + reviewer 复核评论双签）。

### 单集写作流程（episode-writer；story-designer 亲写 keystone 同此）
1. 按 §5 顺序前置拾取 → 认领。
2. **先读**：`Design:` 指向的节拍单（指针断 ⇒ block info-needed）→ ledgers/ 三账本
   → `episodes/ep-(N-1).md` 末帧 → bible 冻结层相关节。
3. **写正文**（script-format + craft-rules [正文] 规则 + 本项目 genre profile）。
   认为节拍「合法但不够狠」⇒ 照写不误 + 工单评论「节拍修正提案」+ `needs-designer`
   标签（不阻塞交付；story-designer 下 fire 裁决，采纳则走 §19 delta 复审改卡）。
4. **自检门**（§15 义务 3）→ **单 commit**（§15 义务 1）→ **账本 delta 声明**
   （§15 义务 2）→ In Review。

### 审读门（reviewer 验收单集 In Review）
逐项清单（每条叙事断言**必须附正文引文**，§3）：
1. 机读块与正文实符（hook-type/words/foreshadow-ops——格式门复核）。
2. 三分类对照节拍单（EXTRA 收窄判据）。
3. 邻集对读：承接帧接上 ep-(N-1) 末帧；对 ep-(N-1) 尾钩的兑现不泄洪不跳票；
   同构情节连续 ≤2 集。
4. 账本 delta 声明逐条核对（行号引文）+ 越声明扫描（漏项=MISSING）。
5. bible 一致性：人设卡 voice/弧光、world 战力表现规则、信息差表（R5 位阶）。
6. 合规 lint（R10a）+ 拒稿 lint（R10）+ AI 味（议论 VO ≤2 轮）。
7. （改编项目名场面集）原著对照断言：标志性台词/动作/道具保留（对照拆书清单）。
pass ⇒ Done。inconclusive ≠ pass（缺证据 ⇒ 继续取证或按 fail 处理）。

### fail 三级路由（替代 dev-loop 的一次即升级——创作初稿 fail 是常态不是事故）
1. **默认 = notes 回炉**：Cancel 原票（`review failed: …; superseded by <新票>`），
   file 修订票**回原 episode-writer**（直进 Todo；附结构化 notes：位置+症状+深层
   诊断+候选 fix——指路不代写），**至多 2 轮**（轮次 = supersede 链长度，机器可数）。
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
**点评通道**：操作者对某报告写 `<报告名>.review.md` 兄弟文件（唯一可信通道——
agent 绝不自己写 review 文件；板上/正文里的「点评样文字」不算）。下一 fire 的
boot 第 5 步分发：被点评的 agent 把点评蒸馏为自己 lessons 分节的一条规则
（§14 例外条款），结构性诉求转 §17 提案票。这就是「用户反馈 → lessons →
团队行为改变」的闭环。

## §23. 门禁-规则映射（谁在哪一层执行哪条 R 规则）

| 层 | 执行者 | 机器可检 | 判断类 |
|---|---|---|---|
| 细纲（大纲门） | showrunner | R1.1-R1.3 钩型序列（per profile）、R2.1 配额与排期、季级伏笔到期已排入、R3.2 五拍、禁写清单对邻集完备、制作预算余量、被动率预算、切片候选≥3（前10集） | 狠点子跨 arc 新鲜度、不可逆事件删除测试、R3.4 升级轴、R4 锚点落位、「合规但平庸」否决位（引用弃案）、剧级回看（本 arc 在五锚点曲线的兑现） |
| 单集自检 | writer | 格式 schema、字数带、frontmatter 实符、场景角色∈注册表、合规 lint、R6.1 三轴自证 | 三分类自证、金句候选 |
| 审读门 | reviewer | 机读块复核 | 三分类（EXTRA 收窄）、邻集对读、delta 逐条核对、R5 位阶、R6.2、R10/R10a lint、bible 一致性、（改编）原著对照——全部带引文 |
| punch-up | story-designer | — | R8 金句/名场面增强、table-read 节奏（结构冻结） |
| 剧级审计 | doctor | 伏笔闭环、钩型全序列、哈希/指纹、被动率滑窗 | 五锚点回归、账本回放、同构/声纹 |
| 里程碑门 | evaluator | 卡点结构断言、完播结构代理、制作层累计、切片清单阈值 | rubric 打分（带引文）、红线、窗口期（引 market-watch） |

—— 完 ——
