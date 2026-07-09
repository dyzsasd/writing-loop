# writing-loop 设计文档（v2 — 经 4 视角对抗性评审修订）

> 基于 dev-loop v1.1.0 机制骨架的自治 AI 短剧编剧团队。workspace 中每个 project =
> 一部剧本；立项两式：小说改编 / 原创。设计输入：22 个示例剧本六组格式分析、
> 集间机制专项（R1-R7）、citron-script 尸检（10 条机制级教训）、行业三方调研、
> dev-loop 机制抽取、evaluation.xlsx 四维十六指标。
> v1→v2：38 条对抗性评审 findings（6 critical）全部裁决落地，见 §12 决策日志。
> 操作规范全文在 `references/conventions.md`（冲突时以 conventions 为准）。

## 0. 设计原理 — 为什么这套机制能治 citron 的病

citron-script 尸检结论：它不缺编剧知识，缺**「规划层与执行层之间的机制性保证」**
——剧本生成时看不到上一集、伏笔零表示、成稿是唯一无 audit 的环节。dev-loop 恰是
一台「用工单状态机强制规划被执行」的机器：看板即通道（agent 只靠工单交接）、
每次 fire 无状态（强制把故事状态 externalize 成账本——正中 AI 长篇叙事「显式状态
注入优于模型记忆」的研究结论）、验收即门禁（独立 owner 三分类，fail⇒close+follow-up）。

citron 十教训 → 机制载体（v2 修订后）：

| # | 教训 | 载体 |
|---|---|---|
| 1 | 骨架与成稿间要有逐集节拍单作契约 | arc 细纲 = 逐集节拍单（含禁写负向边界）；自检+审读双层按节拍单三分类验收 |
| 2 | 故事状态账本每集前读后写，更新本身要过审 | ledgers/story-state.md；writer 交付「账本 delta 声明」（逐条+正文行号），reviewer 逐条核对（非抽查）；doctor 回放审计 |
| 3 | 伏笔台账三态+阻断检查 | ledgers/foreshadow.md + outline 主线伏笔登记表（季级）；细纲排期、单集执行、doctor 机器闭环审计 |
| 4 | 验收清单含可判定叙事断言 | 节拍单逐项 = AC；机器检查明确定位为**格式门**，叙事实质验收 = reviewer 带引文断言 |
| 5 | 审查资源按离观众距离倒置 | 单集/跨集/剧级三层阻断门；前 3 集全 keystone；前三集微门、一卡门、卡二门、卡三门、完本门 |
| 6 | 集 N 开工前置 = 集 N-1 已验收 | pick 前置绑**票类**（集本位判定，绑所有 agent），Bug 修订开放时前向冻结 |
| 7 | 产物携带生成配置指纹；重生成开邻集复核 | frontmatter：节拍单内容哈希+model/effort+规则版本；doctor 指纹与哈希审计；修订涟漪协议（引用图追溯，非半径1） |
| 8 | 卡点/幕末集单列高价值工种 | keystone（前3集+卡点集±1+深谷+终局3集+S级名场面集）⇒ story-designer 亲写 |
| 9 | lessons 模式复制到叙事端 | §14 lessons + reflect + 操作者点评闭环原样 |
| 10 | 自查显式化 | 自检清单+账本 delta 声明写入工单评论；机器项与判断项分工序 |

## 1. 角色 roster（9 agent + 1 操作者 skill）

| 角色 | dev-loop 原型 | 档位 | 职责一句话 |
|---|---|---|---|
| **showrunner 总编剧** | PM | opus/max | north-star+outline 唯一维护者；立项/方向 intake；file 各类创作票；大纲门验收；里程碑监测与 milestone-eval 票发起；Backlog 闸门 |
| **story-designer 细纲师** | senior-dev | opus/max | arc 设计票→逐集节拍单（含候选竞争与弃案）→spawn 子票；keystone 亲写；升级接管（Mode: direct-write）；arc punch-up 执行 |
| **episode-writer 编剧** | junior-dev | sonnet/high | 单集票→读节拍单+账本+上集→写正文→自检门→账本 delta 声明→In Review |
| **reviewer 审读** | QA | ≥writer 档（受治理配置，默认 opus/high） | 单集独立验收（三分类+邻集对读+delta 逐条核对，断言必须带正文引文）；fail 三级路由；修订复核；邻集复核票 |
| **script-doctor 剧本医生** | Architect | opus/xhigh | 慢频轮换维度剧级审计（伏笔闭环/钩型序列/五锚点/同构/声纹/指纹一致性/被动率/账本回放），结构地标区间强制定维 |
| **evaluator 评估官** | （新增） | opus/xhigh | 执行 milestone-eval 票：前三集微门/大纲定稿门/一卡门/卡二门/卡三门/完本门；rubric+红线；报告分「机内断言/待实测」 |
| **market-watch 市场监察** | Ops | sonnet/high | 慢频（周）扫榜+平台政策：带日期的题材窗口评估；窗口/政策变化⇒needs-showrunner 票。evaluator 市场层打分必须引用其评估（过期⇒inconclusive） |
| **reflect** | Reflect | opus/xhigh | retro + lessons 策展（机制原样） |
| **sweep** | Sweep | sonnet/high | 生命周期卫生（机制原样 + 本设计新增票类的错标规则） |
| **add-script**（skill） | add-project | — | 立项 interview（含合规预筛+受众画像必填+扫榜引用）：原创（含对标剧轻量拆解）/ 改编（选书评估+拆书三清单）→ scaffold+注册 |

**升级链（v2 修订）**：reviewer 对单集 fail 的**三级路由**——
① 默认 = notes 回炉：close+follow-up 修订票回原 episode-writer（附结构化 notes：
位置+症状+诊断+候选 fix），至多 2 轮；② 结构性 miss（写错拍位/违反禁写/账本事实
冲突）或 2 轮用尽 ⇒ 升级 story-designer（跟进票带 `Mode: direct-write` 机读行）；
③ 任何 `Mode: direct-write` 票再 fail ⇒ fix-exhausted ⇒ human-park。keystone 首稿
（本就是 designer 写的）fail ⇒ 允许一次同层 `Mode: direct-write` 重试，再 fail 即
human-park。fail 计数的机械载体 = Mode 行 + supersede 链，不靠记忆。

## 2. 文档体系

```
<script-repo>/
  bible/{north-star,characters,world}.md    # 冻结层（改动走 showrunner/大纲门）
  outline.md                                 # 总大纲 + 单元表 + 高潮五锚点 + 卡点规划(备卡)
                                             # + 主线伏笔登记表(季级) + 名场面规划 + 续季钩规划
  arcs/arc-NN-<slug>.md                      # 逐集节拍单 + 候选竞争弃案记录
  ledgers/                                   # 活跃层（O_EXCL 锁；≤15KB rollup 纪律）
    foreshadow.md                            # 伏笔账本（含 sequel-hook 状态）
    story-state.md                           # 当前态 + 逐集末态摘要（可重建任意时点）+ 被动标记
    production.md                            # 制作预算账本：场景/角色注册表 + 打斗群戏特效计数
    archive/arc-NN.md                        # 每 arc 滚存
  episodes/ep-NNN.md                         # frontmatter 指纹（节拍单哈希/model/规则版本）+ 正文
  evaluation/                                # 里程碑评估报告 + 切片清单
  source/                                    # 改编：原著+拆书三清单；原创：对标剧轻量拆解
```

**版本纪律（反「已过门工件静默改写」）**：单集 frontmatter 记 arc 文件**内容哈希**；
doctor 每轮比对即得全部过期集清单。大纲门之后改 arc/outline 必须走 **delta 复审**：
列改动条目 → 机器算受影响已 Done 集 → showrunner 局部重验 R 序列 → 自动开复核票。
outline 定稿后的结构性变更（结局/卡点/单元表）重过 evaluator 对应分项。

**账本纪律**：① 单 commit 原子性——单集正文+全部账本更新必须同一 commit，工单转态
在 commit 之后；② fail ⇒ revert——reviewer Cancel 时记录 commit sha，跟进票强制
第一步 revert 失败稿（正文+账本一体回滚），sweep 稽核「Canceled 且未 revert」；
③ 并发——每账本文件 O_EXCL 锁（60min 过期强清），Bug 修订在制时冻结前向新集拾取；
④ rollup——story-state 只留当前值+本 arc 窗口，每 arc 滚存 archive/。

## 3. 工单体系要点（全文见 conventions §3-§5）

- 状态机七态、verify-fail⇒close+follow-up、三分类、§5a Backlog-first、claim、
  dedupe、blocked/bail-shape 全部原样。
- **Owner 按票类**（v2 修订）：`episode` 票（含 direct-write 重写票）owner=**reviewer**
  （Feature 中的显式例外——离观众最近的产物必须独立验收）；outline/arc-design/
  milestone-eval/立项票 owner=showrunner；Bug owner=reviewer；Improvement 默认
  showrunner（reviewer 所 file 归 reviewer）。sweep 错标清单同步（episode+Feature+
  reviewer 合法）。
- **子票放行**（v2 写死）：大纲门 pass ⇒ **一次性 promote 全部子票，父票最后 Done**
  （§21a 崩溃安全序）；episode 票**不计入 todoDepthCap**（节流由顺序 pick 约束承担）。
- **顺序 pick 前置（绑票类、集本位）**：任何 agent 拾取带 `Episode: N` 的创作/重写票须满足
  ① `episodes/ep-(N-1).md` 已存在于 main（任意票产出）且无 episode=N-1 的开放创作/
  重写票；② 无 Episode ≤ N 的开放 **Bug** 修订票（前向冻结；Improvement/punch-up
  不冻结）；③ arc 首集看上一 arc 全部创作/重写票 Done（开放修订 Bug 不阻塞跨 arc）。
  direct-write 重写票天然满足①，显式豁免。
- **里程碑门工单化**：showrunner 监测条件→file `Feature+milestone-eval`（evaluator
  执行、showrunner 验收）；arc-(k+1) 设计票在前方有未 Done 的 milestone-eval 时出生即
  `blocked` + `Blocked-by: <id>` 机读行；一卡门后操作者决策点 = eval 跟进票 park
  （external-prereq，走通知轨道）。大纲票 Done 以定稿门 eval 票 Done 为 Blocked-by 前置。
- **修订涟漪协议**：Done 集的修订票交付义务含**涟漪分析**（grep 账本 ID/事实在后续集
  的全部引用→受影响集清单）；涟漪超邻集 ⇒ 不自动开票，blocked+needs-showrunner
  裁决（批量返工 or 接受偏差记入 Decisions）；自动邻集复核 = `Bug+continuity+
  owner=reviewer+tier=episode-writer`，递归 ≤2 跳，超限人裁。
- **已投放水位**：config `airedThrough`；ep≤水位的修订票机械转型 = 前向修补 or
  human-park，禁止追溯改已投放正文与其账本记录。

## 4. 门禁体系（v2：否决门 + 增强 pass + 剧级门补全）

| 门/工序 | 执行者 | 要点 |
|---|---|---|
| 自检门 | writer | 格式 schema/字数带/场景与角色∈production 注册表/合规 lint；节拍单三分类自证；**账本 delta 声明**（逐条+行号）；金句候选。机器检查=格式门定位 |
| 审读门 | reviewer | 独立三分类（**EXTRA 判据收窄 = 仅禁写违反+账本事实冲突**，其余创作增量合法且鼓励）；邻集对读；delta 逐条核对+越声明扫描；R 断言**必须带正文引文**（不可引证=inconclusive=不 pass）；合规 lint；改编项目名场面集加原著对照断言 |
| 大纲门 | showrunner | R1-R6 结构审计（**对照本项目 genre profile 参数**）+ 判断断言：逐集**狠点子**新鲜度比对、不可逆事件删除测试、禁写清单完备性（机器）、被动率预算、制作预算余量（机器）、季级伏笔到期已排入、切片候选≥3（前10集）、剧级回看（本 arc 在五锚点曲线的兑现）；显式保留「合规但平庸」否决位（引用弃案要求换案） |
| **punch-up 增强 pass**（新增） | story-designer | 每 arc 全集 Done ⇒ showrunner file `Improvement+punch-up`：结构冻结、只准增强（金句/callback/情绪峰值/table-read 式节奏），禁改结构与账本事实；reviewer 轻量复核 |
| 前三集微门（新增） | evaluator | ep3 Done 触发：第1集反常识冲突/第3集首次高潮/尾钩序列专项，fail 即修 |
| 大纲定稿门 | evaluator | 市场层（引用 market-watch 带日期评估）+内容层预评+合规红线+改编「名场面-卡点对齐表」核对；红线一票否决 ⇒ human-park（不是修订票） |
| 一卡门 | evaluator | 钩子/卡点结构断言（机内）+完播率结构代理（待实测栏）+切片清单（阈值不达标⇒punch-up 票）+制作层累计+窗口期复核 |
| 卡二门 | evaluator | 中段结构 + 制作层累计 + 市场层复核 |
| **卡三门**（新增） | evaluator | 2/3 深谷落位与深度、换轨成立性、终局总动员资产盘点（逐项核正文出处） |
| 完本门 | evaluator | 全量 rubric+定级+续季钩兼容断言 |
| doctor 轮换审计 | doctor | 伏笔闭环/钩型序列/五锚点/同构/声纹/**指纹与哈希一致性**/**被动率滑窗**/**story-state 回放**；结构地标区间强制定维 |

**writer 创造力通道**：节拍修正提案（工单评论+needs-designer 标签，designer 下 fire
裁决，不阻塞交付）——writer 不是填表机器，「合法且更狠」的写法有上行通道。

## 5. genre / format / monetization 参数化（v2）

- R1-R6 的数值参数抽出为 **genre profile**（craft-rules 附录）：v1 已校准 =
  脑洞爽剧/复仇打脸/职业单元剧（证据基础）；女频甜宠/虐恋 profile 标注
  **UNCALIBRATED**（H7 主力、关系亲密度轴替代权力轴——参数为暂定值），add-script
  对未校准题材立项时显式警告。
- **monetization 一级开关**：`paid-app | free-hongguo | reelshort-sub`。free 模式：
  一卡门→前 30 集完播门、卡点断言→留存钩断言、rubric 付费转化项按完播/留存替换；
  reelshort-sub：卡点平缓化、打脸收敛、集数 60-80。
- **format 开关**：ai-anime 的制作层预算表单列（特效近乎免费=形态优势，改审
  「生成成本/资产复用」）；live-action 按 rubric 原表。
- 评估报告头部记录**所用参数集指纹**。

## 6. 评分体系整合

- 内容层五指标 ↔ R 规则/节拍单字段逐项映射（创作端自检=评估端打分项）。
- 市场层：market-watch 供数（带日期）；无数据 ⇒ evaluator 输出「无法评估+置疑」，
  一票否决类红线在无数据时升级操作者裁决。
- 六红线机器化（v2 修正）：受众画像→立项必填；完播率→结构代理断言+待实测回填；
  卡点落差→R4.5 断言；**主角被动→节拍单主动性字段+story-state 累计+doctor 滑窗**
  （承认单集三轴推进不是被动性的有效代理）；题材打压期→market-watch 持续监控
  （非仅立项一次）；情绪过时→同上。
- **合规红线**（新增第 7 线）：违法未惩/价值观/敏感题材——自检+审读 lint、每道
  evaluator 门一票否决、立项预筛入 north-star Non-goals。

## 7. lessons / 自进化 / 报告

§14/§17/§22 机制原样（roster 分节改为本设计 9 角色）。写作特有 reflect 证据源：
evaluator 评分趋势、reviewer fail 分类统计、punch-up 修改类型统计。
操作者点评（*.review.md）→ lessons 闭环 = 「用户反馈持续改善团队」的机制载体。

## 8. Backend 与运行

v1 local 文件板 only（§18 协议逐字照搬；**workspace-rooted 布局**：运行时状态在
`<workspace>/.writing-loop/`，config 用相对 `repoPath`，`cp -r <workspace>` 即整体迁移；
workspace 根解析见 §11；前缀 `WL`）。
comms 通知：config `comms:{provider,webhookEnv}`（human-park/一卡门决策点推送）；
未配置时 fallback = daily digest 的 needs-attention 节（写入设计，不留空）。
调度：手动 slash / 外部 cron。boot 六步原样。

## 9. 吞吐预估（评审 lens:编剧工艺 的实测口径）

干净路径 2 fires/集（writer+reviewer），摊销 arc 设计与门禁 ~0.4、修订链与
doctor/reflect/sweep ~1-2 ⇒ 实测预估 3.5-5 fires/集，80 集约 300-400 fires。
门禁密度经评审判定为合理（自检/审读的重复三分类是刻意的独立性设计），
瓶颈在剧级门分布——已以前三集微门/卡三门补齐。

## 10. 插件交付物

```
.claude-plugin/{plugin,marketplace}.json   README.md README.zh-CN.md
references/{conventions,script-format,craft-rules,evaluation-rubric,config-schema}.md
skills/{showrunner,story-designer,episode-writer,reviewer,script-doctor,evaluator,
        market-watch,reflect,sweep}-agent/SKILL.md + add-script/SKILL.md
templates/{north-star,outline,arc-beat-card,episode,characters,world,
           foreshadow-ledger,story-state,production-ledger,evaluation-report}.md
templates/deconstruction/README.md
docs/DESIGN.md docs/RESEARCH/*.md（12 份调研归档）
```

## 11. 照搬 / 替换 / 砍掉

**照搬**：三铁律、boot、状态机、三分类、§5a、claim、dedupe、blocked 协议、查询纪律、
dry-run、lessons、§17、§18 local 板、§21a 结构、§22 报告点评。
**替换**：build 门→格式与叙事门禁；coverage→账本回写强制令；sensitive→keystone；
design doc→arc 节拍单；strategyDoc→north-star；Ops→market-watch；
自动回滚→fail-revert 协议。
**砍掉**：PR/autoMerge/deploy、多 repo §19（change-gate 思想保留给 doctor）、
Linear/hub backend（v1）、Communication、Codex、W5 完整外部追踪（保简化 park）。

## 12. v1→v2 评审决策日志（38 findings 裁决）

全部 38 条 findings（6 critical / 23 major / 9 minor）**全部接受**并落地：
- [0][12] 账本单 commit + fail-revert + O_EXCL 锁 → §2 账本纪律
- [1][23] 修订涟漪协议（引用图/前向冻结/递归上限/逐集快照）→ §3
- [2][7] 节拍单内容哈希 + 生成指纹 + delta 复审 → §2 版本纪律
- [3] 账本 delta 声明逐条核对 + doctor 回放审计 → §4
- [4] §评审补全（reviewer≥writer 档；断言带引文；机器检查=格式门）→ §1/§4
- [5] outline 主线伏笔登记表 + arc 门到期断言 → §2/§4
- [6][24] 候选竞争+弃案、狠点子字段、判断断言、「合规但平庸」否决位 → §4
- [8] airedThrough 水位 → §3
- [9][22] Owner 按票类（episode⇒reviewer）→ §3
- [10] 全量 promote+父票后 Done+episode 不计深度 → §3
- [11][13][21b] pick 前置绑票类、集本位、Episode 字段 → §3
- [14] 里程碑门工单化（milestone-eval 票+Blocked-by 边+park 决策点）→ §3
- [15] 邻集复核票四元组定义 → §3
- [16] Mode: direct-write 计数载体 → §1 升级链
- [17] 大纲票禁自领 → conventions
- [18] 账本 rollup ≤15KB → §2
- [19] comms 配置 + fallback 声明 → §8
- [20][28][36] punch-up 一等工序 + EXTRA 收窄 + 切片/金句字段与阈值 + 提案通道 → §4
- [21] fail 三级路由（notes 回炉默认）→ §1
- [25][26] genre profile + format/monetization 开关 → §5
- [27][30] market-watch agent + 数据依赖分级 + 无数据置疑 → §1/§6
- [29] 卡三门 + arc 门剧级回看 + doctor 强制定维 → §4
- [31] 合规红线全链路 → §6
- [32] production.md 预算账本 + 三层强制 → §2/§4
- [33] 前三集全 keystone + 前三集微门 → §4
- [34] 主动性字段 + 被动率滑窗 → §6
- [35] 改编断言（对齐表/名场面 keystone/原著对照/忠实度入节拍单）→ §4
- [37] 续季钩规划 + 兼容断言 → §2/§4
