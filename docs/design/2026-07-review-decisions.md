# 2026-07 全面评审 — 操作者决策记录

> 决策记录，2026-07-16。输入：一次四维设计评审（ctx 上下文成本 / substrate 基底 /
> flows 交接流 / docs 文档体系），逐条对照 dev-loop 1.2.0 的评审-迁移经验核对；
> 发现 1 个 critical 活性缺陷（showrunner autonomous 探针对纯评论交接失明）+
> 多个 major/minor。本文件与 `docs/DESIGN.md` 同为**设计决策日志**：机制的现行规范
> 以 `references/conventions.md` 为准，两者不一致时以 conventions 为准。
> 实施遵循文末 phase 排序；对应机制修订随各 phase 落入 conventions 与 SKILL。

## D1 — 基底裁决：本地文件板保留，hub 为触发门控的将来选项

**本地文件板（`backend:"local"`，§18）保留为唯一 backend，一切修复用文件板词汇
书写一次**（无 hub、无 CLI 动词）。理由：Linear/hub backend 是 v1 的**有意裁掉**
（DESIGN.md §决策日志）；零安装、`cp -r` 即迁移、无环境变量身份（「是哪个 agent =
调了哪条 skill」）是服务非技术操作者的**声明式设计目标**；操作者的实际诉求
（每 fire 上下文可控、lint 化）100% 与基底无关；且三账本 + §15.1 原子 commit
不变量与 §5 顺序前置门本就活在 git/agent 侧，换 hub 只能搬走板的那一半，却要
强付 §18 + 探针改写成 CLI 动词、版本 pin、文件板→sqlite 迁移三笔成本。

**hub 是推迟、不是否决**：作为 propose-only 的 Phase 6 选项记录在案，**版本 pin
≥ dev-loop 1.2.0**（W10 先例：写动词最低版本约束）。两个命名触发条件——任一成立
才重开评估，否则不动：

1. **操作者要 web 看板**（dev-loop `/p/<key>/` 页面级的板浏览/操作界面诉求出现）；
2. **调度之痛超出 cron + Step-0 探针**（milestone-eval 门延迟、keystone 顶配
   reviewer 排 fire 等场景靠外部 cron + 探针 + digest 旗标已不可维护）。

届时 hub 只接**板的那一半**：状态/标签/认领/评论 1:1 映射；三账本、§15.1 原子
commit、§5 顺序前置门、beat-card-hash 指纹链**留在 git/agent 侧不动**——Phase 0-5
的全部产物（conventions/SKILL/lint 工件）在 hub 世界原样复用，无一作废。

## D2 — 上下文预算表（CJK 校准，行 + 字符双约束）

writing-loop 的 SKILL 密度 ~81B/行（UTF-8 CJK 3B/字），dev-loop ~73B/行，且 CJK
≈ 1 token/字——**照抄 dev-loop 的字节表会隐性收紧 ~15%**。故预算以**行数 + 字符数**
双计（两者皆约束，先触先算超），不用字节：

| SKILL | 行 | 字符 |
|---|---|---|
| showrunner（9,500→10,100：WL-44 第五逃逸口 + D5 cite 强制载荷，D6） | 300 | 10,100 |
| writer 层（story-designer / episode-writer） | 240 | 7,800 |
| reviewer（携带审读门全流程走查，+10% 豁免——同 dev-agent 携带 Step 0-7 的先例） | 260 | 8,500 |
| observer 层（script-doctor / market-watch / reflect） | 210 | 6,800 |
| observer 层例外：evaluator / sweep（6,800→7,100：D5 完备性断言/时钟纪律 cite 强制载荷，D6） | 210 | 7,100 |
| add-script | 270 | 8,800 |

结构预算：frontmatter description **≤400 字符**（一句角色 + 触发短语，协议
mini-spec 一律移入正文/conventions——已于 Phase 0 落地：10 份共 12,812→3,399 字符）；
Step-0 探针谓词块 **≤19 行**（lane 谓词本体；动机/单向安全/判定语义引 §0 不复述；
12→19 见 D6——WL-44 墙钟逃逸口按语义只能落探针块内）；
boot 节 **≤35 行**。

**机器权威 = `scripts/context-bill.py` 的 BUDGETS 表**（Phase 1 落地），本表为其
镜像；两者不一致时以脚本为准并回改本表。

## D3 — 保留清单（任何迁移不得破坏项）

1. **§0 Step-0 廉价车道探针**（conventions §0 Step 0）。它是 writing-loop 对
   no-op 浪费（实测 88% 空跑）的原创解，比 dev-loop 的 change-gate TTL 更细粒度，
   覆盖含报告结算/孤儿逃逸在内的每条 lane——**语义逐字保留**。修复只允许**扩展**
   其输入面（如 Phase 0 把 `updated` 并入 §18 稳定字段与 showrunner 快照哈希——
   保守超集方向：只会多 boot，绝不多退），**绝不削弱单向安全铁律**（宁假命中、
   绝不假退出）。SKILL 去重（Phase 5）只把 9 份复述的探针样板缩成谓词-only 块 +
   §0 引用，判定语义不动一字。
2. **§15.1 正文+账本同 commit 原子性 + 逐行引用的账本 delta 声明**
   （conventions §15）。这是 writing-loop 最好的原创机制（reviewer 逐行核对的
   前提）；任何基底/模板迁移不得把正文与账本拆进两个提交单元，不得把 delta
   声明降级为散文交待。

## 实施排序（跨维综合）

- **Phase 0 — 基底裁决 + 关键机械修复**（S 级，无依赖，立即做）：(a) 本决策记录；
  (b) 修 critical 探针失明——§18 comment 操作 bump `updated` **且** `updated` 并入
  showrunner 快照哈希元组（两半缺一不可）；(c) needs-reviewer 补产者（§9
  info-needed 第三路由：审读判据/引文定位/期望类）；(d) §5a 第五直进 Todo 豁免
  （showrunner 所 file 的 milestone-eval 票）；(e) §5 前向冻结状态集钉死为
  Todo/In Progress/In Review + showrunner 放行时触前沿修订 Bug 最先；
  (f) market-watch 4-B/4-C 补 owner 全标签集；(g) frontmatter 瘦身 ≤400 字符 ×10。
  *落地 2026-07-16。*
- **Phase 1 — 执法基底**（M；依赖 Phase 0 的预算数）：`scripts/lint.py`（stdlib
  Python：§-引用解析含文件限定/点号锚点/歧义禁令、字面尺寸声明新鲜度 ±10%、
  骨架结构、frontmatter 上限）+ `scripts/context-bill.py`（BUDGETS 机器权威）+
  `scripts/board-lock.sh` + GitHub Actions 按 PR 打印账单。同 commit 做锚点预备：
  §21a 四条流程加字母子锚点（**只加字母/点号子锚点，绝不重编号**——定名
  §21a-design / §21a-episode / §21a-gate / §21a-fail；锚点语法总注落在 conventions
  目录节下，lint 机器执行）。预算/探针长/boot 长在 Phase 5 迁移前为 WARN-only
  （`--strict` 升级为失败）。*落地 2026-07-16。*
- **Phase 2 — 并发加固**（M；与 1/3 并行）：repo.lock 包 stage+commit（并发 cron
  配置强制 per-ticket worktree + ff-only 合回）；>30min 认领心跳评论；outline.md
  单写者化；锁法术复述改为 board-lock.sh 指针。
- **Phase 3 — 交接流 + 文档补全**（M；与 2 并行）：人工停靠回程环（parks 带
  needs-showrunner；`notified` 时间戳化 + 24h 去重复提醒）；doc-watch 自触发排除；
  north-star 进度/方向节分治（D4 类比）；大纲门版本绑定（Approved-hash /
  Design-hash / changelog 链）；sweep Job 4 残留模型更正；邻集复核 ≤2 跳的
  relatedTo 链走查；留存策略 + 15KB 账本帽的审计消费者。
- **Phase 4 — 节选择性 boot**（M；依赖 Phase 1 的 lint + 锚点预备；操作者的
  头号交付）：boot 序列锚点化（§0a——字母子锚点，不重编号）、每 SKILL 机读
  `Sections:` 行、boot 第 1 步从「读本文件」翻转为「读拓扑一览 + 所列节」。
- **Phase 5 — 统一 SKILL 模板迁移**（L；**最后**，纯归并——所有内容修订先落定，
  绝不重写两次）：两 agent 共享机制一律 conventions 引用不复述；探针缩为
  谓词-only（语义逐字保留，见 D3）；预算表执法生效。
- **Phase 6 — 推迟项**（L；propose-only，触发门控）：hub backend 评估，见 D1。

评审的横切义务：每个 bug 修复命名其回归检查（本 repo 无测试基建时 = Phase 1 lint
的对应断言）；conventions 自述性数字一律非字面化（如「整份 conventions」），
消除 ~51KB 类漂移；README zh/fr 随机制变化同步。

## D4 — 现场治理补丁上游化（2026-07-17；来源 = 首个生产部署 queens-gambit 板）

操作者在生产板批准的 5 条 §17 提案（WL-30/34/37/38/44），此前只打在插件缓存上
（升级即丢失，靠 `governance-patches.md` 人工重放）——**逐字上游进插件本体**，
`【patch WL-NN · 2026-07-17】` 标记保留（重放脚本 grep 即见「已在位」，幂等）：

1. **WL-30**（§21a-fail.1）：轮次计数加状态前置——只有**从 In Review 转入**的 Cancel
   计入（大纲门 fail 的连坐 Cancel 停在 Backlog/Todo，天然不计；防提前 fix-exhausted
   卡死整剧）。回归断言：queens-gambit ep-1 轮次机械求值 = 1。
2. **WL-34**（§4 + script-doctor SKILL）：第三条 owner 例外——无 `Episode:` 行的设计层
   Bug ⇒ owner=showrunner（判别符 = §6 修订票强制的 `Episode: N` 行）；sweep 合法组合
   2→3；doctor SKILL owner 按 `Episode:` 行分流（消除 SKILL 字面与实践相反）。
3. **WL-37**（§21a-design.5）：哈希纪律两处收口——①末节 new-hash 不写入文件（自指不可
   满足），权威 = 当前文件实测哈希；②重 stamp scope 覆盖机读行 + AC 正文内联哈希副本。
4. **WL-38**（§7）：接管（takeover）第二分支——In Progress ∧ assignee 陈旧 ∧ 有引用
   票号的 commit ⇒ 不回收不重排，记 `Landed: <sha>` 后接管续完；stale 时钟只认
   assignee 本人评论（§1 keystone-stall 护栏同规）；sweep digest 兜底旗标。
5. **WL-44**（showrunner SKILL Step 0）：autonomous 探针第五逃逸口（墙钟谓词）——
   停靠票最新 `Notified:` >24h 且无操作者动作 ⇒ 板哈希未变也落全 boot（§9 重提醒是
   墙钟义务，变化检测器表达不了它）。

## D5 — 四类系统性失效的机制化（2026-07-17；来源 = 操作者现场报告）

每条 = conventions 具名锚点 + 各承重 SKILL 一句 cite（共享机制只写一次）：

1. **账本不得自证**（§15 具名规则；§19.6、§21a-gate.4、writer/reviewer cite）：
   「与 canon 无冲突」判断必须对正文核实，绝不只对账本求值；delta 声明按列断言真值
   附正文行号；reviewer 只认正文引句不认账本回声；lessons 记有虚假断言史的列 = 热列，
   每触必重读正文。实证：3 张 keystone 首稿折在记账、同列虚假断言复发 4 次。
2. **完备性断言纪律**（§21a-gate 具名块；reviewer/evaluator cite）：零值/缺席断言必须
   写明方法+覆盖面；截断/切片读永不支撑完备性结论（写 inconclusive）；永久存储
   （evaluation/、§22 报告）的历史性断言必须引工单/commit。实证：line[1:150] 切片读
   产出「零漏项 PASS」假阴性入永久证据。
3. **时钟纪律**（§18 具名块；§7 交叉引；sweep 未来戳护卫 = clamp+旗标）：一切时间戳
   来自当次执行的 `date -u`，绝不凭模型记忆拼写；未来戳 = 立即 stale-可疑。实证：
   拼出的未来戳把 §7 冻结 ~10h，复发。
4. **决策点重验**（§0 具名规则，§20「回写前必重验」的一般化；showrunner 探针/审读门/
   evaluator 门 cite）：no-op 退出、门 verdict、带宽/度量判定在落判当刻重读承重输入
   （廉价读）。实证：2h 窗口内三角色撞 stale boot 读，showrunner 距违规假退出 3 分钟。

## D6 — craft 机制化（WL-51/WL-52）+ 预算表调整

- **WL-51**（craft-rules R6.2 + §23 + showrunner A1）：邻卡调度同构检查入大纲门——
  节拍卡中段引擎/动作序列与任一相邻集同构 ⇒ 旗标换案（同构成立于卡面时修正文治不了类）。
- **WL-52**（characters 模板 + arc-beat-card 模板 + §21a-episode.2 + §21a-gate.5）：
  声纹卡 = voice 的 durable 载体（语域/禁忌语/样句/表演提示锚，可证否）；节拍卡
  「声纹锚」字段引用；writer 必读链含在场角色声纹卡；审读门第 5 项对卡验。治
  designer→writer tier 边界上的声纹断层（stage-warm 1/1/2→0/0、OS 2→0→7 摆荡）。
- **预算调整（一句理由）**：showrunner 9,500→10,100 字符、evaluator/sweep
  6,800→7,100 字符、探针块 12→19 行——D4/D5 的操作者强制载荷（WL-44 逃逸口按语义
  只能落探针块）不可静默削减，故上调预算而非裁承重内容。机器权威 =
  `scripts/context-bill.py` BUDGETS，本节与 D2 表同步回改。

## D7 — 内建调度器 wl-run：tmux launcher 退役 + WL-55 结构性裁决

单进程调度器 `hub/src/scheduler.ts`（`writing-loop run` 内建，零运行时依赖；裁决时为
`scripts/wl-run.py`，后按纯 TS 架构裁决整体移植入 npm 包）取代外部 tmux/cron launcher 与
宿主 CLI 的 /loop。裁决实质（WL-55）：§15.6「同一时刻至多一个 fire 在写 repo」的
前提不再靠部署纪律，由调度器**以构造保证**——写 repo 四角色（showrunner /
story-designer / episode-writer / evaluator，§15.6 逐字列举的 stage+commit 主体）
全局单飞；板上五角色（reviewer / sweep / script-doctor / market-watch / reflect，
从不 commit repo）可与写者并发、彼此 ≤2。共享 checkout + repo.lock 默认轨道因此
恒为合规；worktree 仍留作操作者显式安排重叠开火时的备用轨道（§15.6 原文不动）。
keystone-stall 护栏的 launcher 分支同步落地：起 reviewer 前 glob 板 frontmatter，
∃ In Review+keystone ⇒ 该 fire 自动用 scheduler.keystoneReviewer 档（advisory
选档，floor 判定仍归 reviewer 本体）。遥测 fires.jsonl 的时间戳一律取调度器自己的
UTC 时钟——墙钟谓词（§7 陈旧、§9 24h 重提醒）的可信时间源。默认参数 = 实战
launcher SPECS 表逐格搬入；schema 见 config-schema「内建调度器」节；回归 =
hub/test/scheduler*.ts（`npm test` 常跑）。D3 保留清单第 1 条的正交互补关系不动：wl-run
决定「何时 spawn」，§0 探针决定「spawn 后能否廉价退出」——当年「若将来有
launcher」的那一半如今成真。
