# 连续剧集体写作方法调研：为 AI 编剧团队借鉴人类团队的分工与文档体系

> 调研日期：2026-07-09。目标读者：writing-loop（AI 编剧团队）架构设计者。
> 核心结论先行：**人类连续剧工业的本质是"用文档和门禁把创意流程工程化"**——每个角色对应一类职责边界，每份文档对应一类状态存储，每道门禁对应一次质量校验。这套体系与 dev-loop 的 PM/QA/Dev/ticket 模型高度同构，可直接映射。

---

## 1. 美剧写作室（Writers' Room）：分工与单集流水线

### 1.1 层级与分工（The Hierarchy）

美剧写作室是一个**明确分层的创作组织**，头衔既是资历阶梯也是职责边界（来源：ScreenCraft、Final Draft、Script Magazine 等行业指南）：

| 层级 | 头衔（英文） | 职责 |
|---|---|---|
| 最终决策者 | 剧集主理人 / Showrunner（通常挂 Executive Producer） | 对剧本、选角、预算、排期、staff 聘用**有最终决定权**；守护整部剧的统一愿景（vision）；所有剧本最后一读 |
| 二号位 | 非主理执行制片 / Non-showrunning EP、联合执行制片 / Co-Executive Producer | showrunner 缺席时**代为主持写作室**（"number two"）；剧本送 showrunner 前的最后把关 |
| 高级编剧 | 监制编剧 / Supervising Producer、制片编剧 / Producer、联合制片 / Co-Producer | 深度参与 break story、带教下级、兼管选角/制作衔接 |
| 中级编剧 | 执行故事编辑 / Executive Story Editor、故事编辑 / Story Editor | 资深 staff writer 的晋升位；在房间里承担局部领导职能，是进入 producer 序列前的最后一级 |
| 初级编剧 | 编剧 / Staff Writer | 入门级，通常写第 1-2 个剧本；主要贡献 pitch 和房间讨论 |
| 支撑岗 | 写作室助理 / Writers' Assistant | **在房间里做详细笔记**，把即兴讨论转写成"清晰、可执行的 room notes"，每天分发给全体编剧——这是房间的"外部记忆" |
| 支撑岗 | 剧本协调员 / Script Coordinator | 管理剧本版本、校对格式、**维护连续性与 show bible**（详见 §2.3） |

**对 AI 团队的关键洞察**：
- 层级的实质是**决策权集中 + 产能分布**：创意产出是并行的（人人 pitch），但裁决是串行的（showrunner 一人终审），从而保证"一个声音"（one voice）。AI 团队同样需要一个"终审 agent"避免多 agent 风格漂移。
- 两个支撑岗（writers' assistant、script coordinator）不写戏，专职**维护共享状态**——这正是 AI 系统里最容易缺失的"状态账本"角色。

### 1.2 Break the Story：卡片墙 / 节拍板（Beat Board）流程

"Break the story"（拆故事/破故事）= **在写剧本之前，集体把一集的故事逐场逐拍讨论定型**（来源：Go Into The Story / Scott Myers、Final Draft、Breaking Bad 写作室访谈）：

1. **节拍（beat）**：故事内一个最小的事件单元。每个 beat 写在一张索引卡（index card）或便利贴上，钉上白板/软木板（corkboard），按幕（act）分列。
2. **可移动性是核心价值**：卡片可以随讨论在 Act I / Act II 之间挪动、合并、丢弃——结构性重排的成本极低。这是"先纲后文"的物理实现。
3. **集体作业**：一集的 break 由全体编剧参与，通常耗时 **10 天到 2 周**。Vince Gilligan 称《绝命毒师》"75% 的写作发生在拆故事阶段的写作室里"——即：**结构工作占创作总量的四分之三，成文只是最后四分之一**。
4. **多线交织**：一集通常有 A-plot / B-plot /（C-plot）（主线/副线），在板上分行并列，按场次交叉编排（interweave），确保每条线各自有起承转合。
5. 板子定型后，被指派的编剧（credited writer）拿着板子内容"go off to write"——先写 outline，再写 draft。**个人执笔，但故事归属集体**。
6. 数字化工具（WritersRoom Pro、Final Draft Beat Board、Arc Studio Plot Board 等）复刻了这套"卡片-泳道-拖拽"模型，说明该工作流已高度标准化、可软件化。

### 1.3 单集门禁流水线：pitch → outline → draft → table read → revision

一集从想法到拍摄稿要过一系列**门禁（gates）**，每道门都有明确的产物（artifact）和审批人（来源：The Development Track、Script Magazine "Writers' Room 101"、Ken Aguado）：

| 阶段 | 产物 | 审批人 / 门禁 |
|---|---|---|
| ① 故事域 / Story Area | 一段式故事方向（有时叫 arena / springboard） | 房间集体 + showrunner 认可才进入 break |
| ② 拆故事 / Breaking | 节拍板 → 节拍表（beat sheet） | showrunner 拍板"board is locked" |
| ③ 大纲 / Outline | 6-15 页逐场大纲（scene-by-scene） | showrunner 批注；**电视网/平台在大纲阶段给大量 notes**，重大结构调整必须在此消化——大纲改比剧本改便宜一个数量级 |
| ④ 初稿 / First Draft | 完整剧本（写作周期约 1-2 周/集，开发期 pilot 可达 6-8 周） | showrunner + studio notes → 修订稿（writer's second draft） |
| ⑤ 房间重写 / Room Rewrite | showrunner pass / group rewrite | showrunner 常亲自重写统一口吻（"one voice"原则） |
| ⑥ 围读 / Table Read | 全员朗读production draft | **听觉门禁**：暴露纸面上看不出的节奏、笑点、拗口台词问题。喜剧（《公园与游憩》《我为喜剧狂》等）会当场换梗、删场；围读不过的笑话活不到开拍 |
| ⑦ 拍摄稿修订 | 彩色页版本（colored pages：blue/pink/yellow…按修订轮次换色） | 进入制作后只允许小改；每轮修订有版本记录，任何人可追溯"哪一稿改了什么" |

**对 AI 团队的启示**：
- **notes 越早给成本越低**——把最强的评审算力压在 outline 阶段而非成稿阶段。
- 彩色页 = 显式版本管理 + 增量 diff，天然对应 git。
- table read 是一种"换模态校验"（读→听）：AI 等价物可以是"以观众视角逐句重放/朗读评估"的独立 QA pass，专抓节奏与口语化问题，而不是再做一遍结构审。

---

## 2. 故事圣经（Story Bible / Show Bible）

### 2.1 包含什么

show bible 是"整部剧的蓝图"：世界观、人物、语气、长线叙事潜力的**单一权威文档**（来源：Scriptation、Script Reader Pro、GL Coverage 等）。典型章节：

1. **概念层**：logline（一句话前提）、premise、tone（语气基调，常用"X meets Y"参照系 + 明确的"我们永远不做什么"）、主题（theme）、目标观众。
2. **世界观（world / mythology）**：设定规则（世界如何运转、什么可能什么不可能）、地点志、术语表。
3. **人物志（character bios）**：主角/常驻角色的背景、欲望（want）与需求（need）、人物弧线（arc）、人物关系图、**每个角色的说话方式**（voice 规则，常附台词范例）。
4. **季弧与集清单**：season arc（本季的整体起点→终点）、episode guide（未来若干集的一段式梗概）、多季规划（where the show goes in season 2-5）。
5. **格式规则**：叙事引擎（每集的故事如何产生——procedural 的 case-of-the-week 还是 serialized 的连续推进）、每集结构模板（几幕、冷开场 cold open 与否）。

### 2.2 两种 bible：pitch bible 与 working bible

- **Pitch bible（提案圣经）**：卖剧用，面向高管，重愿景轻细节，写完基本冻结。
- **Working / production bible（工作圣经）**：开机后**活文档（living document）**，随每集播出增量更新，是写作室的事实数据库。AI 团队要借鉴的是后者。

### 2.3 连续性（Continuity）由谁负责、怎么追踪

行业里连续性分两层，由不同岗位负责（来源：Wikipedia "Script coordinator"、ScreenSkills、CareerExplorer、Industrial Scripts）：

- **叙事连续性（narrative continuity）→ 剧本协调员（Script Coordinator）**：
  - 维护"show 的故事与神话记录"（record of stories and mythology）：**追踪剧情点、人物首次登场、人物背景、反复出现的设定元素**，确保跨集跨季不自相矛盾；
  - 常用工具就是**电子表格（spreadsheets）**：逐项登记需要保持一致的元素（人物描述、地点、台词引述、时间线）；
  - 负责编纂/更新 show bible 作为未来改稿的参照工具；兼管版本分发与法务审查（clearances）。
- **拍摄连续性（on-set continuity）→ 场记（Script Supervisor）**：镜头间道具、服装、动作衔接。与写作无关，AI 团队可忽略。

**关键机制**：连续性不是"大家都注意点"，而是**一个专职角色 + 一张结构化表格 + 每稿必查的流程**。剧本每出新版本，script coordinator 逐项核对账本；发现冲突提交给编剧/showrunner 裁决，本人无改稿权——**校验者与写作者分离**。

### 2.4 对 AI 团队的文档体系启示

- bible 应拆成**冻结层**（premise、tone 规则、已播出事实=canon，不可变）与**活跃层**（未播出的季弧、人物当前状态，可迭代）；
- 每集交付后触发一次**bible 增量更新事务**：新事实入账、人物状态推进、伏笔账本更新（见 §4）；
- "人物志"里最有实操价值、也最常被 AI 系统遗漏的字段是 **voice 规则 + 台词范例**——这是防串味（voice drift）的锚。

---

## 3. 节拍框架：三大模型及其微短剧压缩

### 3.1 Save the Cat 15 拍（Blake Snyder, 2005）

对三幕结构的高精度切分，每拍有明确功能和**页码配额**（按 110 页折算百分比）：

1. 开场画面 Opening Image（1）2. 主题陈述 Theme Stated（5）3. 铺设 Set-Up（1-10）4. 催化剂 Catalyst（12）5. 辩论 Debate（12-25）6. 进入第二幕 Break into Two（25）7. B 故事 B Story（30）8. 乐趣与游戏 Fun and Games（30-55，"premise 的承诺"）9. 中点 Midpoint（55，假胜利/假失败）10. 坏人逼近 Bad Guys Close In（55-75）11. 一无所有 All Is Lost（75）12. 灵魂黑夜 Dark Night of the Soul（75-85）13. 进入第三幕 Break into Three（85）14. 结局 Finale（85-110）15. 终场画面 Final Image（110）。

特点：**最细粒度、带比例配额、以观众情绪投入为设计目标**。适合作为"整季弧"或"单部电影级故事"的骨架校验清单。

### 3.2 序列法（8-Sequence Method，Frank Daniel / 哥伦比亚学派）

把长片拆成 8 个 10-15 分钟的序列（A-H），**每个序列有自己的主角小目标、张力和小高潮**，像 8 部首尾相连的短片；序列间用转折点焊接。源自默片时代的胶片卷长度限制。

特点：**天然的"分集"思维**——每个 sequence 自带 mini 三幕和 dramatic question。这是三大框架里**最接近连续剧分集逻辑**的一个：把"每 12 分钟一个小闭环 + 一个新钩子"作为结构义务。

### 3.3 Dan Harmon 故事圈（Story Circle，8 步）

把坎贝尔英雄之旅压缩成一个圆环，专为半小时剧集设计（《废柴联盟》《瑞克和莫蒂》的每集引擎）：

1. You（舒适区里的角色）→ 2. Need（想要某物）→ 3. Go（进入陌生境地）→ 4. Search（适应与付出代价）→ 5. Find（得到所求）→ 6. Take（付出沉重代价）→ 7. Return（带着改变回归）→ 8. Change（角色已不同）。

特点：**最轻量、可无限复用**——每集走一圈，每条 B 线也可以走一小圈；圆形结构保证"回到起点但人已改变"，即每集既独立闭环（episodic closure）又累积人物变化（serialized growth）。

### 3.4 三者同构性

三框架高度兼容（Story Circle 的 8 步与 8-sequence 一一对齐；催化剂 Catalyst = Call to Adventure = "Something Ain't Right"），差异只在**粒度**：Save the Cat 最细（15 拍+页码），sequence 居中（8 段），story circle 最粗（8 步）。**工程含义：可以做成同一数据结构的三档缩放视图**——季弧用 15 拍，单集用 story circle，无需两套本体。

### 3.5 压缩适配到 1-2 分钟/集的微短剧（vertical micro-drama）

微短剧（ReelShort / DramaBox / 国内竖屏短剧）已收敛出自己的工业结构（来源：Filmustage、Final Draft、Vertical Writers、澎湃/腾讯新闻等中文行业报道）：

**单集结构（60-120 秒）——四拍引擎**：
1. **钩子 Hook（0-15 秒）**："不是渐入，是引爆"——继承上集悬念或抛出新冲突。中文行业称**黄金三秒**：3 秒内必须给冲突/悬念，否则划走。
2. **摩擦/发展 Friction / Development（中段约 60-90 秒）**：单一冲突升级，每句台词要么推进冲突要么在压力下暴露人物。
3. **尖峰 Spike**：本集的情绪最高点（反转/打脸/揭秘）。
4. **扣子 Cliffhanger / Button（末 10-15 秒）**：**cliffhanger 不是结尾附加物，而是全集写作的目标终点**——停在吻前一刻、对峙前一刻、秘密揭晓前一刻。

**节奏铁律（中文行业口诀）**："15 秒一个冲突或反转，30 秒推进一次剧情，最后 10 秒给悬念"；核心审美是**高频反转 + 情绪拉扯**，一切（题材、台词、表演、剪辑）为之服务。

**季/剧结构**：全剧 60-100 集（合计 60-90 分钟故事量）；关键商业节点是**付费卡点（paywall point）**——免费看 8-12 集后在最强悬念处收费，因此前 10 集的密度要求最高。写法上先出**时间戳骨架（timestamp skeleton）**：逐集标 Hook/Friction/Spike/Button 的秒级位置，再填台词——即"先纲后文"被压缩到了秒级。

**与三大框架的映射**：一部 80 集微短剧 ≈ 一条 Save the Cat 15 拍主弧（每拍摊到 4-8 集），每一集 ≈ 一个超压缩 story circle（只保留 Need→Take 的中段），每 8-12 集（付费卡点间隔）≈ 一个 sequence。**微短剧没有淘汰经典结构，而是把它三层嵌套化：剧级 15 拍 / 卷级 sequence / 集级四拍。**

---

## 4. 伏笔管理：setup/payoff 的工程化

### 4.1 原则：契诃夫之枪（Chekhov's Gun）与铺垫-回收（Plant and Payoff）

- 契诃夫原则："第一幕挂在墙上的枪，后幕必须打响"——**不对观众开空头支票**（false promise）；反过来，重大 payoff 必须有 plant，否则是 deus ex machina。
- 所有契诃夫之枪都是伏笔（foreshadowing），但并非所有伏笔都必须是枪：契诃夫之枪是**经济性原则**（引入即承诺），伏笔是手法。

### 4.2 工程化：追踪表的字段设计

行业与写作工具方（Literature & Latte、Novelium、No Film School 等）总结的关键教训：**"gun introduced early" 这种一句话备注在修订时几乎无用**，需要的是"活链条（living chain）"。一条合格的 plant-payoff 记录应包含：

| 字段 | 说明 |
|---|---|
| id / 名称 | 伏笔唯一标识 |
| 类型 | 道具 / 信息 / 能力 / 关系 / 台词 callback |
| plant 位置 | 第几集第几场，以什么方式埋下 |
| **归属链（custody）** | 谁持有它、谁弄丢/藏起它、谁能接触到——逐场更新 |
| **知情面（knowledge）** | 哪些角色知道它存在（观众知道≠角色知道，错位即戏剧反讽 dramatic irony） |
| 情绪负载 | 它对哪个角色有什么情感意义 |
| **刷新点（refresh）** | 长跨度伏笔必须在 payoff 前"提醒"观众 1-2 次；记录已刷新位置 |
| payoff 目标 | 计划在第几集回收、以什么形式 |
| 状态 | planted / refreshed / paid-off / **orphaned（已埋未收）** / retconned |

核心洞察（来自对写作工具的批评）：**静态笔记和世界观文档记录的是"事实"，但伏笔需要追踪的是"逐场变化的条件"**——持有权、知情面、情绪负载都会随剧情移动。这本质上是一张**状态机表**，不是一份设定文档。

### 4.3 悬念 / 开环（Open Loops）管理

- 心理机制：**蔡格尼克效应（Zeigarnik Effect）**——未完成事项占据心智远超已完成事项。连续剧靠"跨角色并置多个 open loops"维持追看。
- 结构规则：**关一个、开一个**——每集结尾闭合上集的钩子的同时抛出新钩子（loop chaining）；全部太快闭合→张力蒸发；永不闭合→观众感到被骗（clickbait 化）而弃剧。
- 工程化：维护一张 **open-loop 账本**：loop id、开启位置、悬念问题（一句疑问句）、承诺强度（观众预期多大回报）、计划闭合位置、当前状态。每集评审时核查两件事：①本集净开环数是否合理（微短剧要求恒 ≥1 且末拍必开新环）；②有没有超期未刷新的陈旧环。
- 伏笔账本与开环账本可以合并：**伏笔=作者视角的承诺，开环=观众视角的疑问**，一张表两个视图。

---

## 5. 修订体系：coverage、script doctor、punch-up 与 notes 文化

### 5.1 Script Coverage（剧本审读报告）的评估维度

coverage 是行业标准化的剧本评估报告（来源：Wikipedia、GL Coverage、WeScreenplay、ScreenCraft），三段式结构：

1. **基本信息 + logline**；
2. **梗概（synopsis）**：审读人复述故事——复述不清本身就暴露结构问题；
3. **评语（comments）**：优点/问题分析。

**评分矩阵（grid）**：对以下维度逐项打 Excellent / Good / Fair / Poor：
- 前提/概念（premise/concept：原创性与吸引力）
- 故事线（storyline）
- 结构（structure：情节推进与连贯）
- 人物塑造（characterization：深度与可共情性）
- 对白（dialogue：质感与真实度）
- 节奏（pacing：维持兴趣的能力）
- （制片视角还有 production values / 商业性 marketability）

**总裁决三档**：**Pass（拒）/ Consider（待议）/ Recommend（推荐）**；常见做法是**对剧本和对编剧分别打分**（"pass on the script, consider the writer"）——即区分"这个作品"与"这个产能来源"的质量。

**对 AI 团队的启示**：coverage 是现成的、维度化的**评审 rubric**，可直接作为 AI 审稿 agent 的输出 schema；"复述梗概"环节尤其值得保留——让审稿 agent 先盲复述再评分，复述失真即结构性缺陷信号。

### 5.2 Script Doctor（剧本医生）

不署名的资深改稿专家，在开拍前被请来做**靶向修复**：诊断具体病灶（第三幕塌了 / 主角动机不清 / 对白平），只动病灶不重写全片。特征：**输入是别人的剧本+明确的问题清单，输出是修补稿**；与 staff writer 的区别在于不参与原创、按症状介入。AI 等价物：专科修订 agent（结构医生 / 对白医生），由 coverage 的低分维度触发。

### 5.3 Punch-Up（打磨会）

- 针对**观众反应强度**的专项增强 pass：喜剧加笑点，恐怖片加惊吓拍，情节剧加泪点——"punch-up 不只属于喜剧"。
- 经典方法（Shaula Evans 法等）：把剧本按场拆成卡片，**在不动结构的前提下**逐场提升；第二遍专门标记 running jokes（贯穿笑梗）和 callbacks（回响早期桥段）的机会。
- 铁律：**结构、人物、情节问题必须先修好才轮到 punch-up**——地基不稳时装修无意义。工程含义：修订 passes 有严格的依赖顺序：结构 pass → 人物/逻辑 pass → 对白/情绪增强 pass，不可乱序。

### 5.4 Notes 怎么给才可执行

行业共识的可执行 notes 原则（来源：John Yorke Story、Script Anatomy、No Film School、Industrial Scripts）：

1. **说"清楚/不清楚"，不说"喜欢/不喜欢"**——以"帮作者的意图更清晰"为目标，而非以评审者口味为标准。
2. **问题导向、方案随附**：不带 fix 的否定不许出口（solution-oriented）；但方案是"指路"不是"代写"——把解题权留给执笔者。
3. **只谈大事**：优先级排序，不在小毛病上刷存在感（"only sweat the big things"）。
4. **先说什么在起作用**：正面清单开头，既是士气也是"别改坏这些"的保护标记。
5. **识别"note 背后的 note"（the note behind the note）**：表层意见（"这场能不能加快点"）常包着深层问题（"我不关心这个角色"）。给注者应尽量直接给出深层诊断；收注者要学会向下挖一层再动手。
6. 房间实践：writers' assistant 把口头讨论整理成**"清晰且可执行（clear and actionable）的 room notes"当日分发**——notes 必须落成文字、当天闭环。

**对 AI 团队的 notes schema 建议**：每条 note = {层级: 结构/人物/对白/连续性, 位置, 症状描述, 深层诊断（note behind the note）, 至少一个候选 fix, 严重度}。禁止输出无位置、无诊断、无候选方案的"感想型"意见。

---

## 6. AI 长篇叙事系统：已知实践与失败

### 6.1 学术系统：hierarchical generation（先纲后文）谱系

| 系统 | 机构/年份 | 核心机制 | 关键教训 |
|---|---|---|---|
| **Dramatron**（DeepMind, 2022, CHI 2023） | logline → 人物表 → 情节节拍（plot beats）→ 场景地点描述 → 逐场对白，逐层条件生成（prompt chaining） | 层级化生成显著优于"平铺续写"（flat generation）的长程连贯性；15 位职业编剧试用，认可其在**世界观搭建与创意发散**上的价值，有人把 4 部重度改写的合写剧本搬上舞台 | ①**定位为合写（co-writing），"未被设计或评估用于自主创作"**；②产出被评"公式化（formulaic）"；③自上而下流程不符合所有作者的工作方式——需要允许回到上层改纲 |
| **Re3**（Berkeley, EMNLP 2022） | **Plan-Draft-Rewrite-Edit 四模块**：先生成结构化计划（setting/人物/大纲），起草时把"计划+当前故事状态"动态注入 prompt；Rewrite 按连贯性/相关性重排候选，Edit 做事实一致性修正 | 确立了"**计划 + 状态注入 + 重写 + 编辑**"的闭环范式：生成侧不指望模型自己记住，而是每步显式喂给它该记住的东西 |
| **DOC**（Detailed Outline Control, 2023） | 把大纲细化到更低层级并用 detailed controller 约束草稿贴纲 | 大纲粒度越细、控制越显式，长文连贯性越好——**连贯性来自大纲工程而非模型记忆** |
| **RecurrentGPT**（2023） | 用语言本身模拟 LSTM：每步产出"本段内容 + 长短期记忆摘要 + 下一步计划" | 显式的滚动记忆/计划槽位可支撑任意长度，但质量随距离仍衰减 |
| **SCORE**（2025） | 状态追踪（人物/物品状态机，如"死亡"为吸收态 absorbing state）+ RAG（分集摘要+关键物品检索） | 物品状态一致性可提到 **98%**——**结构化状态机 + 检索注入是当前最有效的一致性方案** |
| **FACTTRACK**（2024） | **带时间戳的世界状态追踪（time-aware world state tracking）**：每个事实带生效时间区间，可检测大纲内的原子事实冲突 | 事实必须带时间维度——"X 是 Y"不够，要"X 自第 12 集起是 Y" |
| **"Lost in Stories"**（2026, 一致性 bug 实证研究） | 对 LLM 长故事做一致性缺陷标注 | ①最高发的是**事实类与时间类**矛盾；②bug **集中在叙事中段**（开头记得牢、近期在窗口内、中间是模糊区）；③高熵段落（模型不确定处）更易出错——可用熵作为校验优先级信号 |

### 6.2 产品实践与教训

**AI 写作产品（Sudowrite / NovelAI / NovelCrafter 等）**（来源：Novarrium 长篇实测、InkfluenceAI 对比评测）：
- 25 章长篇实测中多数工具**在第 5 章后开始崩坏**，五类失败模式：人物事实漂移（瞳色/身高/性格无故变化、角色"未卜先知"或失忆）、世界规则漂移（魔法体系变机制）、情节时序矛盾、关系突变（敌人隔夜变盟友）、腔调漂移（voice/genre drift）。
- 根因："AI 对开头记得尚可、近章记得很好、**中间一片模糊**"（attention degradation）；即便 200K 上下文也不可靠。
- **被动式故事圣经无效**：NovelAI 的 Lorebook、各家的 story bible 都是"AI 可以查但没被强制使用"的被动参照物；且模型在参照物与训练分布冲突时倾向训练分布。
- 有效方案五原则：**①全量登记（track everything）②注入而非指望（inject, don't hope——把相关事实显式塞进每次 prompt）③早验频验（verify early and often，错误会复利）④锁定不可变事实（lock immutable facts：死亡、世界基本规则单独标记为不可改写）⑤用带结构化事实强制（structured fact enforcement）与主动校验的专用系统**。

**Fable Studio SHOW-1 / Showrunner（AI 生成剧集平台，2023-2024）**：
- 用 LLM + 定制扩散模型 + **多智能体模拟（multi-agent simulation）**生成完整动画剧集（曾以《南方公园》演示）；2024 年上线 "Netflix of AI" 平台 Showrunner。
- 核心论点：裸生成系统"缺乏长期创作过程所需的**语境引导与意图性（contextual guidance and intentionality）**"；解法是让人物在持续模拟中积累**历史、目标、情绪、事件、位置**等数据点，生成场景时以模拟状态为条件——即用模拟充当"活的 bible"。
- 教训：意图性不能指望单次 prompt，要有一个**持续演化的世界状态源**供每次生成取材；但平台内容至今被普遍评价为新奇有余、剧作深度不足——状态一致性解决了"不穿帮"，没解决"好看"。

### 6.3 失败模式汇总（AI 长篇叙事的已知坑）

1. **中段塌陷**：一致性 bug 集中于叙事中部（首尾效应）；
2. **被动参照物失效**：不强制注入的 bible/lorebook 形同虚设；
3. **训练分布回拉**：设定与俗套冲突时，模型滑向俗套（cliché gravity）；
4. **伏笔孤儿化**：埋下不收、或 payoff 无 plant——因为没有承诺账本；
5. **状态无时间维度**：只记"是什么"不记"何时起/何时止"，时序矛盾无法检测；
6. **一次成型幻觉**：跳过 outline 门禁直出成文，结构问题以最贵的形式暴露；
7. **公式化**：层级生成保住了结构却磨平了惊喜（Dramatron 的"formulaic"批评）——需要 punch-up 型的增强 pass 和允许违反模板的旁路；
8. **多 agent 声音打架**：无终审角色时风格/口吻碎片化。

---

## 7. 综合：人类体系 → AI 编剧团队的映射表

| 人类角色/机制 | 职能本质 | AI 团队等价物（writing-loop 建议） |
|---|---|---|
| Showrunner | 愿景守护 + 终审裁决权 | 终审 agent（唯一有权 lock 大纲/发布成稿；持有 tone 规则） |
| Staff writer / 房间集体 pitch | 并行创意产出 | 生成 agent（可多实例并行出 beat 候选） |
| Story editor / 高级编剧 | 结构把关、带教式反馈 | 结构评审 agent（在 outline 门禁上运行 coverage rubric） |
| Writers' assistant | 讨论→可执行 notes 的转写 | 会话摘要器：每轮多 agent 讨论落成结构化 room notes |
| Script coordinator | 连续性账本 + 版本管理 | **连续性 agent：维护事实账本/伏笔账本/人物状态机，每稿必查，只报告不改稿** |
| Show bible（working） | 单一权威状态库 | 分层 bible：冻结层（canon）+ 活跃层（当前状态）；每集交付后事务性更新 |
| Beat board | 低成本结构重排 | 结构化 beat 数据（卡片=记录），大纲阶段可自由增删移 |
| Pitch→outline→draft→table read 门禁 | 分阶段质量闸，早期消化大改 | ticket 状态机：premise → beats(locked) → outline(approved) → draft → 朗读式 QA → 发布 |
| Table read | 换模态校验（节奏/口语） | 观众视角重放 pass：逐句评节奏、口语度、钩子强度 |
| Script coverage | 维度化评分 + 三档裁决 | QA agent 输出 schema：盲复述 + 六维评分 + Pass/Consider/Recommend |
| Script doctor | 靶向专科修复 | 按 coverage 低分维度触发的专项修订 agent |
| Punch-up | 结构冻结后的情绪增强 pass | 最后一道"反转密度/情绪拉扯"增强 pass（微短剧尤其需要） |
| Notes 文化 | 可执行反馈协议 | note schema：位置+症状+深层诊断+候选 fix+严重度；禁感想 |
| Plant-payoff 追踪 | 承诺账本（状态机） | 伏笔/开环账本：custody、知情面、刷新点、orphaned 检测 |
| 微短剧四拍+付费卡点 | 秒级结构模板 | 集级模板校验：黄金三秒、末拍必留扣子、卡点前悬念峰值 |

**一句话总纲**：人类连续剧工业用**专职状态维护者（coordinator）+ 分阶段门禁（gates）+ 可执行反馈协议（notes）**驯服了几十人×几十集的复杂度；AI 长篇叙事研究则反复证明**连贯性来自大纲工程与显式状态注入，而非模型记忆**。两条证据链指向同一架构：**先纲后文的分层数据、写作/校验角色分离、强制注入的结构化账本、以及一个握有终审权的单一声音。**

---

## 主要来源

- Writers' room 分工：[ScreenCraft](https://screencraft.org/blog/simple-guide-to-the-tv-writers-room-hierarchy/)、[Final Draft](https://www.finaldraft.com/blog/whos-in-a-tv-writers-room-roles-and-jobs-explained)、[Script Magazine](https://scriptmag.com/features/writers-room-101-tv-writer-job-titles)、[Wikipedia: Writers' room](https://en.wikipedia.org/wiki/Writers%27_room)
- Break the story：[Go Into The Story (Scott Myers)](https://gointothestory.blcklst.com/how-do-tv-writers-write-they-break-the-story-first-d066e32065d5)、[Final Draft: Beat Board](https://blog.finaldraft.com/what-is-a-beat-board-anyway)、[Breaking Bad 写作室](https://screenwritingfromiowa.wordpress.com/2018/10/09/inside-the-breaking-bad-writers-room-how-bad-ideas-can-lead-to-good-ideas/)、[WritersRoom Pro](https://www.writersroompro.com/)
- 开发流程与门禁：[The Development Track](https://thedevelopmenttrack.com/the-complete-guide-to-tv-development-pt-4/)、[Ken Aguado](https://ken-aguado.medium.com/the-timeline-for-the-making-of-a-tv-series-3b1fcb7f8448)、[Script Magazine: Writing the Outline](https://scriptmag.com/features/writers-room-101-writing-outline)
- Story bible：[Scriptation](https://scriptation.com/blog/tv-show-bible-and-character-bibles-guide/)、[Script Reader Pro](https://www.scriptreaderpro.com/tv-show-bible-examples/)、[GL Coverage](https://glcoverage.com/2025/08/13/what-is-a-tv-series-bible/)
- Script coordinator 与连续性：[Wikipedia](https://en.wikipedia.org/wiki/Script_coordinator)、[CareerExplorer](https://www.careerexplorer.com/careers/script-coordinator/)、[Industrial Scripts](https://industrialscripts.com/script-coordinator/)、[ScreenSkills](https://www.screenskills.com/job-profiles/browse/film-and-tv-drama/technical/script-supervisor-film-and-tv-drama/)
- 节拍框架：[StudioBinder: Save the Cat](https://www.studiobinder.com/blog/save-the-cat-beat-sheet/)、[Reedsy](https://reedsy.com/blog/guide/story-structure/save-the-cat-beat-sheet/)、[Final Draft: Story Circle](https://www.finaldraft.com/blog/how-to-harness-dan-harmons-story-circle-to-tell-better-stories)、[Ignacio Miranda: Comparing Story Structures](https://medium.com/@IgnacioWrites/comparing-every-form-of-story-structure-f98e3d5f7e2c)
- 微短剧：[Filmustage](https://filmustage.com/blog/how-to-write-a-vertical-drama-script/)、[Final Draft: Verticals](https://www.finaldraft.com/blog/what-are-verticals-and-micro-dramas)、[Vertical Writers](https://www.verticalwriters.com/)、[人民日报：网络微短剧的生产模式](http://paper.people.com.cn/rmlt/pc/content/202412/31/content_30051038.html)、[澎湃：中国短剧生态实录](https://www.thepaper.cn/newsDetail_forward_27715115)、[腾讯新闻：编剧中心制](https://news.qq.com/rain/a/20240521A029WH00)
- Setup/payoff：[StudioBinder: Chekhov's Gun](https://www.studiobinder.com/blog/chekhovs-gun/)、[No Film School: Plant and Payoff](https://nofilmschool.com/plant-and-payoff-in-screenwriting)、[Literature & Latte](https://www.literatureandlatte.com/blog/chekhovs-gun-examples)、[Novelium](https://novelium.com/blog/chekhovs-gun-examples)
- Open loops：[Film School Sucks: Open & Closed Loops](https://filmschoolsucks.substack.com/p/open-and-closed-loops-how-to-make)、[Jay Acunzo: 6 Types of Open Loops](https://jayacunzo.com/blog/techniques-to-transform-your-storytelling-the-6-types-of-open-loops)
- Coverage / notes / punch-up：[Wikipedia: Script coverage](https://en.wikipedia.org/wiki/Script_coverage)、[WeScreenplay](https://www.wescreenplay.com/blog/script-coverage-guide/)、[ScreenCraft: Coverage Ratings](https://screencraft.org/blog/script-coverage-ratings-explained/)、[John Yorke Story: How to Give Script Notes](https://www.johnyorkestory.com/2017/07/how-to-give-script-notes/)、[Script Anatomy](https://scriptanatomy.com/notes-the-give-and-take/)、[ScriptArsenal: The Punch-Up](https://scriptarsenal.com/blogs/screenwriting-tips/the-punch-up)、[Shaula Evans Punch-Up Method](https://othernetwork.com/2014/03/08/the-shaula-evans-comedy-punch-up-method-from-the-blacklist/)、[Table read: StudioBinder](https://www.studiobinder.com/blog/table-read-through/)、[Celtx](https://blog.celtx.com/what-is-a-table-read/)
- AI 系统：[Dramatron (arXiv 2209.14958)](https://arxiv.org/pdf/2209.14958)、[Dramatron GitHub](https://github.com/google-deepmind/dramatron)、[CHI 2023 论文](https://dl.acm.org/doi/10.1145/3544548.3581225)、[Re3 (EMNLP 2022)](https://aclanthology.org/2022.emnlp-main.296/)、[RecurrentGPT](https://arxiv.org/pdf/2305.13304)、[SCORE](https://arxiv.org/pdf/2503.23512)、[FACTTRACK](https://arxiv.org/pdf/2407.16347)、[Lost in Stories (arXiv 2603.05890)](https://arxiv.org/abs/2603.05890)、[SHOW-1 / Fable](https://fablestudio.github.io/showrunner-agents/)、[Novarrium: AI Story Consistency](https://novarrium.com/blog/ai-story-consistency-complete-guide)、[Novarrium: 25 章实测](https://novarrium.com/blog/ai-writing-tools-keep-contradicting-themselves)、[InkfluenceAI 评测](https://www.inkfluenceai.com/blog/best-ai-for-writing-novels-2026)
