# dev-loop 可迁移机制骨架 —— writing-loop 施工图

> 调研对象：`/Users/shuai/workspace/jinko/dev-loop`（v1.1.0）
> 核心文本：`references/conventions.md`（2606 行，单一真相源，所有 agent skill 启动时必读、冲突时以它为准）
> 辅助文本：`docs/ARCHITECTURE.md`、`references/config-schema.md`、`skills/*/SKILL.md`、`.claude-plugin/plugin.json`、README.zh-CN.md
>
> 本文目的：让 writing-loop 的设计者**不必重读 173K 的 conventions.md** 就能照搬全部机制。每节按「机制是什么 → conventions.md 出处 → 关键规则原文要点 → 迁移到写作团队时可换的参数」组织。文末给出通用 / 需替换 / 可砍掉的判断表。

---

## 0. 先立心智模型：dev-loop 的三条铁律（全部可原样迁移）

在读任何具体机制之前，先记住 ARCHITECTURE.md 开头的三条不变式——它们是整个系统的地基，writing-loop 应逐字继承：

1. **看板即通道（The board is the channel）**。agent 之间**从不直接调用**，只通过工单状态（state + label + comment）交接。因此任意 agent 可以在任意时刻、任意顺序、甚至并发运行。（conventions §1）
2. **每次运行都是全新会话（Every fire is fresh）**。agent 无状态；状态只存在于三处：看板（工单）、git（提交历史）、磁盘（`*-state.json`）。每次 fire 从头重读，**绝不信任对话记忆**。崩溃、重启、上下文压缩都不会破坏循环。（conventions §0）
3. **自治 = 门禁，不是提问（Autonomy means gates, not prompts）**。`autonomy:"full"` 下 agent 自行决策执行，但「红灯永不发布」「失败自动回滚」「真正只有人能做的决定，作为事实停在工单上，而不是变成交互式提问」。（conventions §0/§12a）

另有一条元规则贯穿全文：**skill 与 conventions 冲突时，conventions 赢**（conventions 开篇："If a rule here conflicts with a skill's body, this file wins — keeping the agents interoperable is the whole point"）。这意味着 writing-loop 也应有一份唯一的 `conventions.md`，所有角色 skill §0 第一步就是读它。

**标准启动序列（每个 agent、每次 fire，定义一次，各 SKILL 只留一行指针）**（conventions §0）：
1. 读 conventions.md（冲突时覆盖 SKILL）；
2. 加载配置（§11：workspace 的 `dev-loop.json`，解析当前 project）；
3. 解析 backend（§18）；
4. 读 lessons（§14：自己的 section + `## Shared`）；
5. §22 报告启动步（结算到期的日/周/月 roll-up，处理未消化的操作者点评）；
6. 以一行运行摘要开场（project、mode、autonomy 等），然后干活。

**标准收尾**：每个 SKILL 的 §3「Close with a report」——一段紧凑总结 + §22 的 daily 追加（纯 no-op fire 不写）。硬失败时「记一行日志、干净退出，下次 fire 重试」，绝不中途挂起等人。

---

## 1. workspace / team / project 三层结构

### 机制是什么
- **workspace** = 一个目录 = 一支团队 = 一个 backend = 一份 `dev-loop.json`。所有运行时状态收在 `<workspace>/.dev-loop/` 下，**复制整个文件夹即可搬机**（可移植性 I4）。
- **repos** = 物理层注册表：真实 git clone，每个只注册一次，可被多个 project 引用（共享时必须声明 `owner`）。
- **projects** = 虚拟交付单元：引用 repo，拥有自己的 strategyDoc、testEnv、intake、agent 覆盖项。

### 出处
conventions **§27**（Team/workspace model）、**§11**（Per-project config）、`references/config-schema.md` 全文、`skills/add-project/SKILL.md`、`skills/add-repo`。

### 关键规则原文要点
- **发现顺序**：`DEVLOOP_WORKSPACE` 环境变量 → `DEVLOOP_TEAM` 经 `~/.dev-loop/workspaces.json` 索引解析 → cwd 逐级上溯找第一个含合法 `dev-loop.json` 的目录。`~/.dev-loop/` **只放可重建的索引**，不放真状态。
- **project 选择阶梯**（§11）：交互场景「显式指名 > cwd 命中注册 repo > 唯一启用的 project > 询问」；无人值守场景更严：「显式 `DEVLOOP_PROJECT` > cwd 命中 > 无法解析就 no-op 并提示」，**绝不猜第一个 project**。
- **配置 schema 骨架**（config-schema.md，`schemaVersion:2`）：
  ```jsonc
  { "team":    { key, backend, deployPolicy, docSystem, comms{provider,webhookEnv}, mode, autonomy,
                 intake{mode,todoDepthCap}, defaultCodingAgent, codingAgentDefaults, agents{cadence...} },
    "repos":   { "<ref>": { path, remote, owner, landing, autoMerge, mergeChecks, build{typecheck,build,test},
                 deploy{style,command,healthCheck,environments}, ops{checks,criticalRoutes} } },
    "projects":{ "<key>": { enabled, weight, linearProject, strategyDoc{path}, testEnv{baseUrl,authConstraint,notes},
                 intake{mode,todoDepthCap}, devSplit, mode, autonomy,
                 agents{ pm:{codingAgent,model,effort,cadence}, ... }, reports{sink}, repos[{ref,role}] } } }
  ```
- **配置分辨率规则**（§19）：任何可覆盖字段的生效值 = 「repo 自己的值（若有）else 顶层值」；team↔project 的 intake 是**逐字段就近覆盖**（field-wise，nearest wins）。
- **运行时状态布局**（§11/§27/config-schema）：
  ```
  <workspace>/.dev-loop/
    <project-key>/        # pm-state.json、qa-state.json、reports/<agent>/{daily,weekly,monthly}/、logs/
    team/                 # team 级 steward 状态、rotation cursor、fires.jsonl
    lessons/              # INDEX.md（每 fire 必读，硬预算）、<project>.md 分片、archive.md
    wt/<ticket>/          # PR 模式的每工单 worktree
    locks/  hub.db
  ```
- **状态文件纪律**（§11，血泪教训）：`*-state.json` 是**工作集不是档案**——只存固定的回看问题（上次审到的 SHA、已扫过的 lens），**原地覆盖**不追加；每工单的笔记属于工单评论，不属于状态文件（曾有 `qa-state.json` 无界追加长到 330KB）；**所有写入原子化**：同目录写临时文件再 rename（曾有非原子写导致 `pm-state.json` 损坏）。
- **秘密纪律**（§16/§27）：配置只存**环境变量名**，绝不存 URL/token 本体（含 `://` 直接校验拒绝 E07），这是「复制文件夹安全」的前提。
- **初始化三步**（§13/§27，add-project SKILL）：`team init`（纯 CLI，写 dev-loop.json 骨架，不调 LLM 不碰后端）→ `/add-project`（coding-CLI skill，操作者在场：find-or-create 后端 project、**幂等确保 label 全集**、按 §20 标题脚手架 strategyDoc、访谈 testEnv/devSplit/intake.mode、经**带校验的 mutator** 写入配置——绝不手编 JSON）→ `/add-repo`（clone + 探测 build/CI/deploy 事实 + 记录现状）。最后 `doctor` 只读体检（E01–E12 错误码、W01–W07 警告码）。

### 迁移到写作团队的可换参数
- 三层原样保留，换名即可：workspace = **写作工作室**（一个题材厂牌/一支编剧团队）；repo → **剧库目录**（一个 repo = 一部剧的稿件树，或素材库/资料库）；project → **一部剧 / 一条产品线**。
- `build/deploy/testEnv` 换成写作等价物：`build` → 格式校验/字数统计/连续性检查命令；`testEnv.baseUrl` → 「审读环境」（渲染出的成稿目录或阅读器）；`deploy` → 发布/交付渠道（可整块砍掉或退化为"归档到成稿目录"）。
- `~/.dev-loop` 索引、状态文件纪律（有界+原子写）、秘密纪律、validated-mutator 写配置、doctor 体检码——全部照搬。
- add-project 的访谈问卷换成写作问卷：题材、目标平台、集数/单集字数、人设卡位置、strategyDoc（=作品圣经）路径、intake.mode。

---

## 2. ticket 生命周期：状态机 + 所有权路由 + Backlog-first intake

### 机制是什么
一个七态状态机 + 「label 三重职能（类型/所有权/工作流信号）」+ 「Backlog 是唯一入口、PM 是唯一闸门」的节流阀。

### 出处
conventions **§3**（状态机）、**§4**（label 分类学）、**§5**（优先级与 Dev 取单顺序）、**§5a**（Backlog-first intake 与 Todo 深度上限、intake.mode）、**§6**（工单模板）、**§7**（认领并发）、**§8**（去重）。

### 关键规则原文要点

**状态集**（§3）：`Backlog / Todo / In Progress / In Review / Done / Canceled / Duplicate`（+ service backend 独有的 `Human-Blocked` 停车态）。**谁能把工单移到哪**：

| 状态 | 含义 | 谁移进来 |
|---|---|---|
| Backlog | **万能进件态（§5a）**：一切新发现的工单落在这里，对任何 dev 取单查询不可见 | 所有提单 agent + 人类；senior-dev 的设计子单在此暂存 |
| Todo | 已梳理、可被领。**只能经 PM 提升到达**，三个例外：owner 的 verify-fail 跟进单、解除阻塞的重排队、Ops 确认的事故单 | PM（提升）；owner；Dev（解锁）；Ops（仅确认事故） |
| In Progress | Dev 已认领在做 | Dev（认领） |
| In Review | Dev 做完，等 owner 验收 | Dev |
| Done | owner 对照验收标准实测通过 | **只有 owner**（PM/QA） |
| Canceled / Duplicate | 终态 | 任何 agent，须留注释 |

**全局最重要的一条**：**verify-fail ⇒ close + follow-up**（§3）。验收不通过时：把原单 `Canceled`（注释 `review failed: <哪里没过/观察到的行为>; superseded by <新单号>`），**另开一张跟进单**（回到 Todo，`relatedTo` 原单）。「每张工单恰好是一个已验证的增量；失败的增量被取代、永不悄悄重开」——历史因此能区分「发布过但没通过」与「排队待做」。

**三分类验收标准（所有验收层共用，§3）**：每次验收（Dev 自审 Step 5.5 和 owner 的 In Review 复核）都对照工单 spec 分类三种偏差——**MISSING**（要求了没做）/ **EXTRA**（做了没要求——scope creep）/ **MISUNDERSTANDING**（做错了东西）。**命中任意一条即 fail，哪怕代码很干净**。且「交接注释是实现者的自述（self-claim），只能用来定位改动，绝不能当证据；一切裁决输入是真实 diff 或你亲自观察到的行为」。

**Label 三重职能**（§4）：
- **防火墙 marker（必带）**：`dev-loop`——安全边界（§2）：每张 agent 建的单必带；每条查询必须 `label:"dev-loop"` + project 双重限定；返回结果若含无此 label 的单，「说明过滤器错了——修过滤器，绝不扩大爆炸半径」；一次改一张单，永不批量。
- **类型（恰好一个）**：`Feature`（owner=PM）/ `Bug`（owner=QA）/ `Improvement`（默认 PM，QA 提的归 QA）。
- **子类型（可加）**：`edge-case`、`incident`（Ops）、`tech-debt`（Architect）、`signal`（外部真实用户信号）、`coverage`（补回归测试）、`sensitive`（触碰敏感域 ⇒ 强制 senior 先设计）、`external-code/external-access`（外部前置的两种类别）。
- **所有权（恰好一个）**：`pm` / `qa`——**owner = 提单者 = 验收者**。没有 owner label 的单会「搁浅在 In Review，没人来验收」（Sweep 负责修）。
- **dev 分层路由（split 项目才有）**：`senior-dev` / `junior-dev`——只决定**谁写代码**，与验收者 label 正交，一张单两个 label 都带。
- **工作流信号**：`blocked`、`needs-pm`/`needs-qa`（路由）、`external-prereq`、`notified`。
- 优先级**不是 label**，是原生 `priority` 字段（1=Urgent…4=Low, 0=None）。

**Dev 取单顺序**（§5，固定死的表）：Urgent bug → Urgent feature → edge-case bug →（普通 bug 排 3.5）→ 一般 feature → improvement；同级内按 `createdAt` FIFO 防饿死；「拿不准时，缺陷优先于功能」。取单查询必须排除 `blocked`。split 项目同一顺序，但每层只取自己的切片。

**§5a Backlog-first intake（洪水阀，1.0 的核心新增）**：
- 「**看板是漏斗，PM 是闸门**」：一切新发现（PM 自己的点子、QA 的 bug、Architect 的 debt、人类进件）一律 `state:"Backlog"`，绝不直接 Todo。`Todo` 是**承诺队列**。
- PM 每 fire 跑 **Job B2**：查 Backlog（排除设计子单）→ 梳理（去重/砍掉过期点子/把模糊单精炼成 §6 合规单）→ 按 §5 顺序提升，**仅当** `count(Todo, not blocked) < intake.todoDepthCap`（默认 **10**）→ 到顶就本 fire 不提升（梳理照做）。「循环的吞吐量、而非发现速率，决定节奏」——一夜 30 条审计发现不再淹没看板。
- **intake.mode: "autonomous"（默认）| "passive"**：只管**发起权**，不管流水线。passive 下 PM 不做任何主动产品评审、不主动提单，**唯一新工作来源是显式指向 PM 的进件（§9a needs-pm）**；但验收、解锁、梳理提升照常。可设 team 级默认，project 逐字段覆盖。passive 项目可以没有 strategyDoc（文档退化为梳理上下文，不再是工作触发器）。
- 其他 agent 的发现照常流入 Backlog；要静音它们用各自的开关（enabled/weight/--agents），**绝不借 intake.mode**。

**工单模板**（§6）：Feature 模板 = Context / Acceptance criteria（可观察、可测试的复选框）/ Affected area / Repo / How to verify（**owner 未来实测的确切步骤**）。Bug 模板 = Summary / Repro steps / Expected vs actual / Environment / Severity & scope / Repo / Acceptance criteria（「上述 repro 不再复现」）。「工单必须带足 Dev 无需猜测就能动手的信息——否则 Dev 会（正确地）block 它」。标题用祈使句（Add…/Fix…）。

**认领并发**（§7）：认领**就是**状态移动——领单后立即写 `In Progress`+`assignee:me`，**再取回来核对**，不是自己就是输了竞态，放手拿下一张。验证也一样先留「我在验」评论。共享工作副本≠隔离：提交前 `git status` 确认暂存区**只有本工单的文件**。

**去重**（§8）：建单前先搜同义单（存在则评论/提优先级，不新建）；更关键的是「**对现实去重，不只对工单去重**」——能力可能已经建好了而没有工单记录，strategy doc 会过时；提单前确认缺口在**当前产品**里仍然存在。「永不提已经完成的工作；做完但没验证的，写进报告，不开新单」。

### 迁移到写作团队的可换参数
- 状态机七态**原样照搬**（Backlog/Todo/In Progress/In Review/Done/Canceled/Duplicate + 可选 Human-Blocked）。
- **类型三元组换掉**：Feature/Bug/Improvement → 例如 `新剧集/章节`（owner=策划 PM）、`审读缺陷`（逻辑硬伤、人设崩坏、连续性错误；owner=审稿 QA）、`润色/改进`。子类型换成写作域：`edge-case`→`伏笔断裂`/`节奏问题`；`sensitive`→ 触碰**关键剧情节点**（大反转、人物黑化、结局、世界观设定变更）⇒ 强制主笔先出「章纲设计」；`coverage`→「设定集/时间线补录」（每个新剧情点必须回写设定集，机制同 §15）。
- **取单顺序表重排**：例如 连载断更风险（Urgent）→ 阻塞后续章节的硬伤修复 → 当前卷章节 → 润色。表结构、FIFO、「拿不准时 X 优先」的句式照搬。
- todoDepthCap、intake.mode、模板骨架（Context/AC/How-to-verify）、verify-fail⇒close+follow-up、MISSING/EXTRA/MISUNDERSTANDING 三分类、防火墙 label（`writing-loop`）——**全部原样照搬**。AC 写法换成可判定的写作验收项（如「本章埋下 X 伏笔且与时间线表一致」「冲突在前 300 字内出现」）。

---

## 3. ticket backend 抽象 + 两层 Dev 的 Design: 指针协作

### 3.1 backend 抽象

#### 机制是什么
「工单操作」被定义为一组抽象操作（list_issues/get_issue/save_issue/save_comment/list_comments/create_issue_label/get_document），**在一处**（§18）映射到三种基座：Linear（云 MCP）、local（本地 markdown 文件板）、service（本地 sqlite hub MCP）。**工作面（work plane）三者完全一致**：状态集、转移、职责、取单、认领、去重、blocked 协议、label 语义、报告。**表面（surface plane）诚实分歧**：真实 per-agent 身份、web UI、版本化文档是 service 独有；云可见性是 Linear 独有；local 是零云地板。

#### 出处
conventions **§18** 全节、**§10**（查询纪律与写入陷阱）。

#### 关键规则原文要点
- **默认 linear**；backend 是 team 级、init 时定死，「事后切换是数据迁移，不是改配置」。
- **本地板（local）文件格式**——这是 writing-loop 最可能直接采用的形态：
  ```
  ${DATA_DIR:-~/.dev-loop}/<project-key>/board/
    counter.json          # { "prefix": "DL", "next": 42 } —— 只是起点提示，不是真相源
    tickets/DL-1.md       # 一单一文件
  ```
  工单文件 = YAML frontmatter（id/title/type/state/owner/labels[全集]/priority/assignee/relatedTo[追加合并]/duplicateOf/created/updated）+ §6 模板正文 + **append-only 带时间戳的 `## Comments` 区**。**state 存在 frontmatter 字段里（字段重写，不是按状态分文件夹——文件夹会引入移动竞态）**。「每次状态移动必须追加一条带时间戳的评论（`state: X → Y`）」——评论日志就是本地板的活动史，Reflect 靠它重建窗口。
- **ID 分配（免竞态）**：`O_CREAT|O_EXCL` 独占创建 `tickets/<prefix>-N.md`，OS 保证只有一个创建者赢；counter.json 只是 hint。ID 单调、永不复用。
- **并发**：每单锁 = 独占创建 `tickets/<ID>.lock`；读-改-写经同目录临时文件 + 原子 rename；**过期锁规则（强制）**：mtime > ~60 分钟的锁视为崩溃残留，删掉记一行继续——否则一次崩溃永久死锁该单。认领用**每 fire 唯一 run token**（`dev (run a1b2)`），写入后重读确认是自己的。
- **写入四陷阱**（§10，任何自建 backend 都要复刻的语义）：① `labels` 是 **REPLACE 式**——改一个 label 必须回传**全集**，否则掉 `dev-loop` 破防火墙；② 状态名匹配可能模糊——**每次状态移动后重取核对**（verify-after-write），没落地就重试一次，再不行留一行注释、本 fire 当没动过；③ 多 label 查询用最特异的一个过滤 + 客户端收窄，绝不放宽查询；④ markdown 传真实换行。
- **查询纪律**：永远 project+label 双限定 + 紧 limit（20–50），「结果太大说明过滤器太宽——收窄它，别翻页整个工作区」。
- **service hub 增量**：与 Linear MCP **同名同参**的工具（零文本改写换基座）；state 是 CHECK 过的枚举（写错报错而非静默错路由）；`DEVLOOP_ACTOR` 环境变量给每个 agent **真实身份**，一切写入可归因；`list_events` 追加型事件流（issue.create/transition/comment.add + actor + 时间戳）供 Reflect 重建；文档系统（strategy/roadmap 草稿-发布两段制：agent 只能 `doc.save` 存草稿，**只有 operator 能 `doc.publish`**；`design` 类文档例外——多实例、不设发布门）；一切治理护栏（verify gate、无进展熔断、Human-Blocked 提醒、accept-rate 指标）**只在 service 上存在**。

#### 迁移可换参数
- writing-loop 建议起步用 **local 文件板**（写作团队单机、无需云）——上面的文件格式、ID 分配、锁、四陷阱语义可**逐字照搬**；把 `dev-loop` label 换名，`DL-` 前缀换成剧名前缀。
- 若要 per-agent 归因和 web UI 再考虑克隆 hub 思路；Linear backend 对写作团队价值不大，可砍。

### 3.2 两层 Dev（senior 设计 + junior 实现）与 `Design:` 指针

#### 机制是什么
把单一 Dev 分成**设计层**（贵模型 opus/max：出设计、拆单、接升级）和**实现层**（便宜模型 sonnet/high：按设计写码）。协作完全靠工单状态 + 一行机器可解析的 `Design:` 指针。

#### 出处
conventions **§21a** 全节、`skills/senior-dev-agent/SKILL.md`、`skills/junior-dev-agent/SKILL.md`。

#### 关键规则原文要点
- **路由规则（提单者在建单时定层）**：`sensitive` ⇒ **永远 senior，覆盖一切**（「敏感工作绝不适用 borderline 归 junior」）；新模块/新特性（需要设计）⇒ senior（design-and-delegate）；改进/修 bug（范围明确）⇒ junior；**拿不准 ⇒ junior**（「升级机制是便宜的安全网，错投贵层才是更贵的错误」）。未标层的单对两个取单查询都不可见——搁浅，由 Sweep 兜底修。
- **设计文档是 PRODUCT 文档**：按**模块**一份、**活文档**（随模块演进更新，不是一特性一份、不是写完即弃）；小特性**不开单独文档**——设计直接写进父/子工单正文。senior **自主撰写并提交**（不是 §17 治理文件、不设操作者发布门）；真正的闸门是**设计父单到 In Review 由 PM 验**。落点按 backend：service = hub `design` doc；linear/local = 仓库文件 `docs/design/<slug>.md`。
- **design-and-delegate 六步**：领设计单 → 写/更新设计文档 → **生成具体子工单**：每张 assignee=junior、**state=`Backlog`（暂存、闸门前不可领）**、正文带一行 **`Design:` 指针**、`relatedTo:[父ID]`（子→父链接**强制**，父关单后仍可回溯）、带清晰可测 AC → 一次写入回链父单（relatedTo 全部子ID + 评论 `Designed into: …`）→ 父单移 **In Review**（senior 自己**不能**标 Done——PM 验）。
- **`Design:` 指针的三种形态**（机器可解析的一行）：
  - `Design: hubDoc:design/<slug>`（service）
  - `Design: docs/design/<slug>.md`（repo 文件）
  - `Design: parent <parent-id>`（小设计，父单本身就是设计）
- **设计闸门（PM 验父单）**：验「设计自洽、引用了它服务的 strategy/roadmap 条目、子单忠实分解它」。大模块级设计**上呈操作者签字**；普通设计 PM 直接验。**通过 → 先把所有暂存子单 Backlog→Todo 提升，再把父单标 Done**（顺序有讲究：提升幂等，但「父 Done + 子还困在 Backlog」的中途崩溃态无人再触发——所以父 Done 放最后，崩溃只留下可重触发的 In-Review 父单）。**不通过 → close+follow-up，暂存子单随父一起 Cancel**（引用了被取代的设计，绝不留孤儿）。
- **junior 流程**：只取自己切片的 Todo → 领 → **先读 `Design:` 指针指向的设计再动手**（指针缺失/坏 = block `info-needed`，绝不猜）→ 按设计+AC 实现 → 继承 dev-agent 全套门禁（**by reference 继承，不重推导**）→ In Review 交给验收 owner。
- **升级链（junior → senior → human）**：junior 的活在**真实 AC 失败**（非 flaky/infra——那种只是重试）第一次就升级：**验收者**（Feature 归 PM、Bug 归 QA）Cancel 原单并**亲自**开 senior direct-code 跟进单（`Mode: direct-code` + relatedTo）。senior 的修复**再**失败 ⇒ `fix-exhausted` ⇒ **Human-Blocked**（操作者是终点站）。「便宜层先试，贵层是安全网，你是终端」。
- **senior 的两种模式靠工单上的显式标记区分**：`Mode: design` / `Mode: direct-code` 描述行（+升级单天然 relatedTo 一张 `review failed:` 的 Cancel 单）。
- 单/双 Dev 模式由**显式配置**决定（`devSplit:true` / 调度器环境变量），「绝不从看板历史/谁干过活/任何工单推断」。

#### 迁移可换参数
这是对写作团队**最有价值的机制之一**，几乎一比一映射：
- senior-dev → **主笔/责编**：为每卷/每个大剧情弧写「卷纲/章纲设计文档」（活文档、按卷一份），拆成每章工单（Backlog 暂存 + `Design: 大纲/卷三.md` 指针 + relatedTo），父单交 PM（总策划）过纲。
- junior-dev → **执笔写手**：只领已过纲的章节单，**动笔前必读章纲**，指针断了就 block。
- 升级链照搬：章节验收真失败 → 主笔亲自重写；主笔也失败 → 停给人。`sensitive` 的写作等价物 = 关键剧情节点（结局、大反转、人物弧转折）⇒ 永远主笔先出纲。
- 模型分层（贵模型出纲、便宜模型执笔）正是写作场景的成本结构，参数（model/effort）直接换。

---

## 4. north-star 机制：strategyDoc / doc-base

### 机制是什么
PM 的北极星是一份**固定标题集**的知识库文档（doc-base），PM 既照它干活，也**持续回写维护它**——「活北极星，不是过期快照」。

### 出处
conventions **§20** 全节、pm-agent SKILL Job C step 5 与 doc-watch preflight、§9a（direction intake）。

### 关键规则原文要点
- **固定八标题（逐字，init 脚手架与 PM 维护完全同名，「没有 agent 发明变体」）**：
  1. **Vision** —— 一段话北极星：产品是什么、为谁。
  2. **Goals (north star)** —— 持久追求的成果。
  3. **Non-goals** —— 明确不做，防漂移。
  4. **Current state** —— 当下真实已建成的「as-is」（init 播种一次，之后 PM 拥有，**只追加缺失小节，绝不重写既有内容**）。
  5. **Personas** —— 用户类型（也是 QA 的 persona 清单）。
  6. **Glossary** —— 领域词表，所有 agent 共享词汇。
  7. **Decisions (running log)** —— 带日期、append-only 的方向/范围决策日志及理由。
  8. **Candidate ideas** —— 溢出停车场：好点子没到提单额度时存这里，backlog 排空时再提。
- **PM 的维护义务**（pm-agent Job C step 5）：目标验收 Done 后在文档里标 ✅shipped（「未来的 run 不再重找」）；评审发现的**新方向**（超出文档的工作）决定追之后**必须写回文档**（「下一个 PM run 把它当北极星的一部分，而不是每次从头重新发现的野点子」）；每条方向/范围决策**带日期**追加进 Decisions log；**手术式编辑**——追加/批注，绝不整篇重写、绝不删用户意图。
- **doc-watch（每 fire 廉价必查）**：每次 fire 重读 strategyDoc，比对上次内容指纹（hash/标题集，存 pm-state.json）。**操作者改了文档 = 立刻要办的工作**：本 fire 就解析成具体工单，「哪怕 HEAD 没动、哪怕当前 lens 已扫过——绝不坐视新写下的方向等代码变化」。
- **有界性（ledger rollup）**：PM 每 fire 全量重读此文档，所以 Decisions log 无界增长 = 每 fire 的 token 税。超 ~20KB 或里程碑 Done 时，把该期已完成/被取代的决策**滚存**到 `docs/strategy-archive/YYYY-MM.md`，活文档里留一行索引。Vision/Goals/Non-goals/Personas 永远留在活文档。「归档是出处，永不逐 fire 重新摄取」。
- **init↔PM 交接（不重复写）**：init 只在缺失时播种 Current state 一次 + 脚手架空标题；PM 此后拥有文档。
- **写作权与人审**：strategyDoc 是「PM 自己的工件」可直接改——repo 文件形态下 PM 单独提交（只 stage 这一个文件），**git 历史就是操作者的审阅/回滚通道**；hub doc 形态下 PM 只能存草稿、操作者 publish。
- **direction intake**（§9a）：操作者要 PM「想一个问题」而非「建功能」时，走 Backlog+needs-pm 进件；PM 研究后**把结论写进 strategyDoc + Decisions log**，然后关单（纯决策）或拆子单再关（有后续建设）；真正只属于操作者的决定（不可逆/战略/证件法务）→ park Human-Blocked，绝不代拍板。

### 迁移可换参数
写作团队的完美对应物是**作品圣经（Story Bible）**：
- 八标题直译：Vision→一句话卖点与目标观众；Goals→本作要达成的核心爽点/主题；Non-goals→绝不写的雷点/题材禁区；Current state→**已发布章节的剧情现状**（追加式）；Personas→目标读者画像 + 主要人物卡索引；Glossary→世界观设定词表；Decisions log→**剧情走向决策日志**（「第 40 章决定让 X 黑化，理由…」）；Candidate ideas→剧情点子停车场。
- doc-watch（作者改了圣经 = 立刻要办）、✅标记、手术式编辑、20KB 滚存归档、init 播种一次 PM 此后拥有、direction intake——**全部照搬**。
- 写作可能需要把 doc-base 拆成「圣经 + 设定集 + 时间线」多文件，但 §20 已支持「同一路径下的 doc set」。

---

## 5. 质量门禁：Dev 的四道门 + owner 验收 + verify 标准

### 机制是什么
一条固定顺序的发布流水线：**build/test 门 → 自审门 → 发布 → 发布后冒烟+自动回滚**，之后交 **owner 独立验收**。两层验证（实现者自审 + owner 复核）都跑同一套三分类标准，「第二层存在恰恰因为第一层是自述」。

### 出处
dev-agent SKILL **Step 5 / 5.5 / 6 / 6.5 / 7**、conventions **§3**（shared verification standard）、**§15**（coverage）、qa-agent Job A、pm-agent Job A、§12b/§12c（PR 模式下门禁的变体）。

### 关键规则原文要点
- **Step 5 —— build/test 门**：按序跑目标 repo 的 `typecheck/build/test`；挂了就修，修不了就**回滚自己的改动并 block 工单**（附失败输出）。「**红灯永不 push、永不 deploy**。坏掉的主干会阻塞所有其他 agent——保护它」。两个静默欠测陷阱：glob 只跑了第一个测试文件（「跑了 1/N 的绿灯比没有门更糟」）；不许把会改生产数据的测试当门跑（跑安全子集并**如实报告跳过了什么**）。
- **Step 5.5 —— 自审门（自治版 code reviewer，机器门、绝不等人）**：
  1. **规格符合性优先**：逐行读**真实 diff** 对照 AC（「对照 diff，不是你对自己意图的记忆——两者会漂移」），标 MISSING/EXTRA/MISUNDERSTANDING；MISSING/MISUNDERSTANDING → 发布前修掉；无据 EXTRA → 裁掉（「工单就是合同」）。
  2. **质量审查**：有 code-review skill 就调，没有就自己扫正确性/安全/回归。**Critical/High 发现 = 阻断**：本 run 修掉，修不掉就**回滚改动 + block `fix-exhausted`**——「绝不把改码的活路由给 PM/QA（他们不写码），绝不等人」。Medium/Low 非阻断。
  3. 琐碎 diff（docs-only/typo）可跳过，但要声明。
  「自审揪出真 Critical 并阻断发布是 SUCCESS，不是失败」。
- **Step 6 —— 按配置发布**：autoCommit/autoPush/autoDeploy 逐级执行，任一为 false 就停在那级并报告。PR 模式下在**独立 worktree** 开分支、只提交本单文件、开 PR；CI 就是 build 门。
- **Step 6.5 —— 发布后冒烟 + 自主回滚**：只要真部署了就跑 healthCheck（「小而高信号：首页+至多一条关键路由——这是活性门，不是测试」）；失败重试一次（防冷启动）；仍失败 = **回滚**（revert 本 run 全部提交、重部署、确认冒烟恢复），工单重开回 Todo 带 `Bail-shape: fix-exhausted`。「**被回滚的破坏性发布是 SUCCESS**——它保护了真实用户；下次 fire 重试修复。绝不让 prod 挂着等人」。
- **Step 7 —— 交接**：In Review + 交接注释（改了什么/哪里/怎么过的门/提交号/AC 指针）。**拆单强制令**：部分交付必须**在交接前**实际建好跟进单并在交接里引用**真实新单号**——「说了拆单却没有已建单号 = 缺陷」。**coverage 强制令**（§15）：Bug/Feature 交接必须声明覆盖结果：本 run 加了回归测试 / 已建 `[coverage]` 跟进单号 / 豁免理由——「回头补测试」不带单号 = 不完整。
- **每 run 上限**：默认 ≤3 张**实现完成**的单（「深度优于广度」；block/dup 等廉价梳理不占额度）。
- **owner 验收（In Review）**：
  - PM Job A（Feature）：先评论认领 → **实际执行工单的 How to verify 步骤**、真实操作产品（「别信 diff；信运行中的产品」）→ Stage-1 规格三分类（读真实 diff，任何命中即 fail「哪怕代码干净、被测的 AC 都过」）→ 全过才 Done；fail 走 close+follow-up。**auth 受限的降级验收路径**：无法亲测的面，用最强可得证据（diff 对照 + CI 绿 + 开放端点 + 确认已部署）并**如实写明什么测了什么没测**；连这都确认不了 → 留 In Review（inconclusive）。
  - QA Job A（Bug）：跑 repro + **测邻域**（「修复常把故障挪一步」）；still broken → close+follow-up（`re-test failed: …; superseded by …`）；**「couldn't run ≠ pass」——inconclusive 绝不是通过**，留 In Review 下次再验。「没有证据（观察到的 repro 结果/截图）的判定只是意见」。
  - **自关单兜底**：qa bug 被秒速 In Review→Done 跳过了复测窗口时，QA 靠 SHA 标记发现并照样验部署后的修复。
- **PR 模式的验收变体**（§12b）：In Review = 「等人合并+部署」；**合并 ≠ 已部署**；只对「运行环境上可观察」的行为下判定；不可观察 → 不算 fail，留 In Review 评论一次等待态。

### 迁移可换参数
- 四道门换写作等价物，**顺序与语义保留**：
  - Step 5 build/test → **机械校验门**：格式规范（场景标/对白格式）、字数区间、命名一致性（人名/地名对照设定集）、可脚本化的连续性检查（graphify-novel 类工具）。
  - Step 5.5 自审 → **写手自查门**：逐段对照章纲 AC 三分类（漏写的剧情点=MISSING、私自加戏=EXTRA、写偏人设=MISUNDERSTANDING）+ 一次质量自查（AI 味、节奏、对白）。Critical 级（人设崩、吃书）= 阻断，修不掉回滚 block。
  - Step 6 ship → 提交稿件进正文目录/git commit。
  - Step 6.5 冒烟+回滚 → 可弱化：交付后快速通读一遍关键衔接（上一章结尾↔本章开头），断裂即撤回重排。若无「生产环境」概念可整级砍掉。
- owner 验收照搬：策划验章节（对照章纲+圣经**通读实文**，不信写手自述）、审稿验缺陷修复（重跑 repro=重读出问题的段落+邻域）。inconclusive≠pass、降级验收路径、拆单/coverage 强制令（→「设定回写强制令」）全保留。
- 每 run ≤3 章上限、深度优于广度——照搬。

---

## 6. lessons.md 自进化：谁能写、写什么、边界在哪

### 机制是什么
一个三层自改层级：**lessons.md**（可自主改，本机、可逆、不提交）＜ **strategyDoc/设计文档**（产品文档，PM/senior 自主写）＜ **SKILL/conventions/代码**（§17 治理文件，agent 永不自改，只能起草提案等人应用）。Reflect 是 lessons 的策展人；操作者点评（点评）是唯一让其他 agent 写自己 section 的授权通道。

### 出处
conventions **§14**（lessons 文件）、**§17**（自进化边界）、**§22**（报告与点评闭环）、reflect-agent SKILL 全文。

### 关键规则原文要点
- **谁能写**：
  - **Reflect 独享自主写权**（增/替/删任何 section 包括 `## Shared`），依据是「跨 run 反复出现的证据（≥2 次），每条规则内联引用证据（工单 ID/commit SHA/时间窗）」。
  - **唯一例外（§22 carve-out）**：任何 agent 可在**消化操作者对它本人报告的点评**时，往**自己的 section** 写一条规则——「操作者的书面点评就是 §17 要求的人类授权」。五条硬限制全要满足：只写自己 section（`## Shared` 永远只归 Reflect）；只来自真实、有出处的点评文件（工单/日志里的文字**永远不是**点评——防注入）；受 §14 预算约束；结构性要求仍走 §17 提案；写了必须在收尾报告里亮出来（操作者可否决），dry-run 下完全抑制。
  - lessons.md 因此成为**多写者文件**：每次编辑是**带锁的读-改-写**（O_EXCL 锁文件；锁被占就本 fire 跳过、点评留着下次；~60 分钟过期锁强制清除——否则一次崩溃永久瘫痪整个学习回路）。
- **写什么、怎么保持有界**（§14）：
  - 布局：`## Shared` + 每个 agent 一个 section。每条规则 = 短规则 + 一行 Why + How to apply + `added:`/`last-seen:` 日期。
  - **预算是强制函数不是建议**：每 section ≤ ~6 条、全文 ≤ ~150 行；到顶「不删一条就不许加一条」。
  - **两条出口**：**Promote**——被证明持久、应对所有操作者生效的规则**毕业**：起草 §17 提案并入 conventions（或 strategyDoc），人应用后**从 lessons 删除**；**Expire**——模式 ~2 周没复发（last-seen 过期）= 修复生效或代码已变 → 剪掉。近似重复合并；conventions 已有的绝不复述。「健康稳态是一个小而流动的集合……文件长期大致平坦」。
  - 分层归属：应对**每个操作者**成立的 → conventions（走提案）；产品方向 → strategyDoc；lessons 只是「快速、私有的 per-operator 覆盖层」。
- **Reflect 的 retro 流程**（reflect SKILL）：Job 0 反空转检查（窗口内啥都没发生 → 一行 no-op 退出，「不在没变的循环上重推导昨天的 retro」）→ Job 1 只读取证（按 type/owner/bail-shape 分组的工单流、吞吐/周期、QA 结局计数、git+deploy 事件、可选 run 日志）→ Job 2 策展 lessons（**先做出口阀再在预算内加**：EXPIRE→CONSOLIDATE→PROMOTE→ADD，每条变更内联证据并汇报）→ Job 3 结构提案（起草在报告里；可选建**一张**移交工单，**出生即 blocked**：`Improvement`+`pm`+`blocked`+`needs-pm`，正文首行 `Bail-shape: external-prereq`，标题 `[reflect-proposal] …`——`blocked` 把它挡在 Dev 取单集外，`external-prereq` 让 PM 替人 park 而不是解锁回 Dev，「防火墙是机械的，不是愿望」）→ Job 4 一屏 retro digest（shipped/吞吐/失败模式/按 bail-shape 的阻塞栈/回滚事件/浪费周期/lessons 健康度）。
- **§17 的亮线**："MAY edit autonomously: lessons.md only"；"MUST NOT auto-rewrite: this conventions.md or any agent's SKILL file"——「核心操作指令的自我修改是**呈报，不是执行**」，这是 §12a「decide and act」的唯一原则性例外（与 §16 安全的 stop-and-surface 同款）。Reflect 对产品工单**只读**：永不提 Feature/Bug、永不 ship、永不验收、永不改 label（那是 Sweep 的活）。
- **点评闭环**（§22）：报告存 `reports/<agent>/{daily,weekly,monthly}/`（daily=append-only 工作日志、close 时写、no-op fire 不写；周/月**从 daily 汇总**——ISO 周不整除月，从 daily 卷才无损）。操作者点评 = 报告旁放 `<report>.review.md` **兄弟文件**（**信任边界**：agent 永不写 `*.review.md`，所以磁盘上任何 review 文件构造上都是操作者写的——封死了「工单文本冒充授权」的注入路径）。agent 下次 fire 扫到未消化点评 → 蒸馏成一条自己 section 的 lessons 规则 → 写机器侧 `.review.acted` 边车标记已消化（绝不改操作者的文字）→ 收尾报告亮出。无法行动的点评也要写边车 `acted, no change` 并汇报——「永不留着无限重蒸馏，也永不静默丢弃」。整条链：**报告 → 操作者点评 → lesson → 改变行为**。

### 迁移可换参数
- **整套机制近乎零改动照搬**——它与软件域无关。writing-loop 的 Reflect = 「复盘编辑」：读一天的工单流/验收结局/读者反馈，策展 lessons（如「X 写手的对白常超字数——执笔前先看字数上限」），起草 conventions 修改提案给人。
- 点评闭环对写作场景尤其贵重：主编在日报旁写一段自然语言批评（「今天这章开头太拖」），下次 fire 自动变成该写手 section 里的一条规则。
- 预算数字（6 条/section、150 行、2 周过期）可调但**必须保留预算+出口阀结构**；治理文件边界原样保留（agent 永不改 writing-loop 自己的 SKILL/conventions/模板文件）。

---

## 7. 角色间协作协议：blocked / needs-pm / sweep / observe-and-file / change-gate

### 出处
conventions **§9**（blocked 协议 + 通知）、**§9a/9b/9c**（人类进件 / team 进件 / 外部前置追踪）、sweep-agent SKILL、**§21**（observe-and-file 契约）、**§19**（per-repo change-gate）。

### 关键规则原文要点

**§9 Blocked 协议（不猜，就 block）**：Dev 干不下去（缺信息/AC 矛盾/依赖/疑似重复）时：加 `blocked` + 路由 label（`needs-pm`/`needs-qa`）→ 解除自己的 assignee、退回 Todo（`blocked` label 使它不进取单集）→ 评论**第一行机器可解析的 bail shape**：
```
Bail-shape: info-needed | decision-needed | scope-design | external-prereq | fix-exhausted
```
- `info-needed`（缺 repro/账号/澄清）→ QA 清（哪怕没标 needs-qa）；
- `decision-needed / scope-design`（产品/范围决策）→ PM；
- `external-prereq` → park + §9c tracker 协议，**必须**再带一行 `External-kind: code|access`（code=别的团队要改码→在团队内提真单去追；access=证件/钱/法务→human-park+通知）；
- `fix-exhausted`（试过了过不了门）→ 别盲目重试；**盲试上限 2 次，第 3 次是 block 不是再试**。
- **block-cycle 上限**：同一张单第 **3 次**被 block 时升级（split 项目→senior direct-code；否则 human-park）而不是继续 Q&A 往返——「往返每圈烧掉整个 fire」。Sweep 的看板体检报告 ≥2 次 block 循环的单。

**owner 侧解锁**：PM/QA 每 fire 查自己的 blocked（**必须带 project 限定**）；PM 额外做**跨 owner 扫描**（`blocked`+`needs-pm` 不加 pm owner 过滤——qa 拥有的单也可能路由给 PM）。「**解决 = 真解锁**」：能答的就答在工单里**并且摘掉 `blocked`+`needs-*`**（把安全性编码进 AC——如加 feature flag、加回归测试——让 Dev 能安全推进），「回了话却留着 park」不算解决。只有真正人类专属的决定（不可逆/钱/法务/安全签字）才留 park 上呈。还要抓**半解锁单**：`needs-pm` 还在但 `blocked` 已被摘的（授权可能以评论形式带外到达）——每 fire 重读自己 park 过的单的最新评论,「把活干完」。解锁后的动作若本身敏感/不可逆——**owner 亲自 attended 执行**（前置验证→安全命令形态→后置验证），绝不路由回无人值守的 Dev 取单集。

**human-park 通知**（§9 notify）：留给操作者的 park（`external-prereq` 类）触发**带外** webhook ping（Slack/Lark；不能用 Linear @——共享身份下自提及被抑制）。只有 PM 发（service 上由 daemon 发,防双 ping）；消息从**封闭允许清单**构造（project/单号/bail-shape/≤80 字符标题/URL），秘密永不入消息；成功才打 `notified` label（防重报），解 park 时同一写入摘掉它（再 park 可再报）；失败只记 id、下 fire 重试。bail-shape 缺失/不可解析 → **fail closed 不通知**。

**§9a W3 人类进件**：人把活交进循环 = 建一张 `dev-loop`+`pm`+`needs-pm` 的 **Backlog** 单（绝不直接 Todo）。PM 靠每 fire 的 needs-pm 扫描发现（区分「人类新进件」和「Dev 的陈旧 bail」看最新评论）。**build ask** → 梳理成子单：先建每个子单（`relatedTo:[父]` **强制**——它在父 Done 后仍可回溯）→ 一次写入回链父单+评论 `Groomed into: …` → **才**关父单（「先关父后建子 = 断绝血统，禁止」）。**direction ask** → 想清楚、把结论写进 strategyDoc+Decisions log、关单；真正操作者专属的 → park。

**§9c W5 外部前置追踪器（park→block→auto-unpark）**：把「等外部」从死标签变成机器可走的边。① Track：PM 为外部需求建**一张** tracker 单（多张 park 单可共享）；② Block：park 单与 tracker 用**真实阻塞边**连接（linear `blockedBy`；local/service 用机器可解析评论行 `Blocked-by: <id>`；`relatedTo` 永远不是阻塞边）；③ Auto-unpark：每 PM fire（Sweep 兜底）查所有 park 单的 blocker——**零条边的永不解锁**（空集是空真——那是还没建 tracker，别上当）；≥1 条且**全部** Done/Canceled → 解锁回 Todo 并**退休这条边**（`Unblocked-by: <id>` 行；不退休则未来再 park 会瞬间自解锁）。「这机制杀死的失败模式：活在一个 label 后面静默腐烂，因为人忘了哪条评论说过需要什么」。

**Sweep 捡漏规则**（sweep SKILL,「裂缝的主人」，hygiene only）：
- Job 1 搁浅/错标：无 owner label 的 Todo 单 = **绕过 §5a 闸门的未处理进件**——退回 Backlog+`needs-pm` 交 PM（「路由给 PM，不要合法化它」）；owner/type 矛盾 → 按 type 修 owner；缺 type → 无歧义就设，有歧义**留言旗标、绝不猜**；设计子单的父已 Done 却还困在 Backlog → 补完崩溃的提升；split 项目缺层/双层标 → 修（sensitive 永远升 senior 不降级）。
- Job 2 孤儿 In Progress：无发布痕迹 + ≥6h 无动静 → 解除认领退回 Todo 留言；有痕迹 → **别动**（Dev 会 reconcile，「别跟一个走得很远的 run 打架」）。
- Job 3 陈旧信号：只**重新浮出**（留一行评论），不越权代 owner 判断；终态单永不碰。
- Job 4 看板体检 digest（只报不改）：coverage 积压、按 bail-shape 分组的阻塞栈、最老 In Review 年龄。
- 原则：「When in doubt, **report, don't mutate**」；慢节奏（~30 分钟）。

**§21 observe-and-file 契约（Ops/Architect 共享）**：外向 agent「**观察 + 提单，永不生产**」——只读所观察之物、不实现/不发布/不验收/不回滚；工单是它们唯一的输出通道。Ops 的**反抖动**规则：只对「确认的、重复的」劣化行动（≥2 次隔时重探 + 上个 fire 已在挂/硬 5xx；任何一次重探恢复 = 记日志不提单）；**对唯一一张开着的 incident 去重**（刷新它，绝不每 fire 刷屏新单）。Architect 按**轮换维度**审计（drift/重复/死码/依赖 CVE/一致性/缺失抽象），提 `tech-debt` Improvement。

**§19 change-gate（变更门）**：PM/QA 的昂贵扫描（产品评审/全量测试）以「**被看护的代码动没动**」为闸：状态文件存 per-repo SHA map；每 fire 算每个 repo 的 HEAD——**任一 repo 动了** = 跑差异聚焦审查并重置 lens 轮换；**没动** = PM 转去扫「该 SHA 下未扫过的下一个 lens」，QA 直接 no-op（或投资于**新覆盖面**：审一个从没扫过的面——「扩覆盖是有限积压，不是永动机做功」；全覆盖后回到简报 no-op）。记录的是**实际审过的 SHA**，不是 run 结束时的 HEAD（中途可能又有人 ship）。「稳态是节流阀，不是全停」。

### 迁移可换参数
- bail-shape 枚举可改词但**保留机器可解析首行 + 按 shape 决定路由**：写作版如 `info-needed`（缺设定/缺前情）、`decision-needed`（剧情方向要策划拍板）、`scope-design`（该拆卷纲）、`external-prereq`（等作者本人/平台方）、`fix-exhausted`（改了两稿还过不了）。
- 盲试上限 2、block-cycle 上限 3、needs-pm 跨 owner 扫描、W3 先子后父、W5 tracker 三步（含空集陷阱与边退休）、Sweep 全部规则、通知允许清单——**照搬**。
- change-gate 的「SHA」换成**稿件树的内容指纹**（正文目录的 git HEAD 或文件 hash 集）；lens 轮换 = 审读维度轮换（节奏/人设一致性/对白质量/伏笔账本/读者爽点密度…）。
- observe-and-file 的写作等价物：Ops→**平台数据观察员**（追更数据/读者评论区，确认且重复的口碑劣化才提单）；Architect→**全稿健康审计**（轮换维度：设定漂移/桥段重复/无效人物/文风不一致），可合并成一个角色或前期砍掉。

---

## 8. 运行方式：调度、开场、收尾

### 出处
conventions **§0**（boot 序列）、**§27**（Scheduling）、**§22**（报告）、README.zh-CN「运行 loop」、各 SKILL 的 §0/§3、ARCHITECTURE.md。

### 关键规则原文要点
- **两种触发方式**：① 手动 slash（`/pm-agent` 等——每个 agent 是一个 Claude plugin skill）；② `dev-loop run` 单一调度器驱动全队：每 agent 有自己的 **cadence**（默认：pm/qa/senior/junior=5m 按 project；sweep=30m、ops=10m、reflect/communication=daily，team scope；architect=daily 按 project），fire 时按**平滑加权轮询**选 project（`weight`=份额，enabled:false/weight:0 退出）；rotation cursor 在调度器与 Agent View `/loop` 行之间共享（`next-project --agent`），防双触发/饿死。每次 fire 记入 `team/fires.jsonl`。有 `--plan n` 预演、`--once --dry-run` 打印命令、`--max-fires` 成本上限、`--change-gate` 静默期跳 fire、`--fire-timeout` 杀卡死 fire。
- **模型/努力度在进程启动时应用**（§11）：per-agent `codingAgent/model/effort/cadence` 由调度器注入，「skill 不在 fire 中途自己选模型」。默认档位：senior=opus/max、junior=sonnet/high、pm=max、reflect/architect=xhigh、qa/sweep/ops=high。
- **一次 run 的标准开场**（读什么状态）：boot 六步（§0，见本文 0 节）之后每个角色先跑**廉价必做查询**（PM/QA 的 Job A 验收队列 + Job B 阻塞队列永远先跑），昂贵工作（Job C）过 change-gate；Dev 先 Step 0 **孤儿回收**（上个崩溃 fire 留下的 In Progress：查有无发布痕迹——有就接着收尾，没有就重排队）再取单。
- **一次 run 的标准收尾**（写什么记录）：SKILL §3 的 close report（角色专属的紧凑清单：验了什么/提了什么/block 了什么/发布了什么）+ §22 daily 追加（**做了实事才写**；no-op fire 不写或合并成一行 idle）+ 状态文件原地更新（实际审过的 SHA 等）。dry-run 下一切写入抑制、只打印意图。
- **成本观**（ARCHITECTURE.md）：「token 是运行成本，**频率**通常是大头」；看 **acceptance rate（verified÷filed）**——低于约 50%，循环在制造审阅工作而不是节省它。
- **人类的角色**：README.zh-CN——「你是 **director**，不是 reviewer」：需求建成 Backlog+needs-pm 单交 PM，不直接派给 dev；每天读一条 digest（team KPI、QA 质量、board flow、north-star delta、"needs the director" 小节——好日子应为空）；incident 即时推送。

### 迁移可换参数
- 手动 slash + 单调度器 + per-agent cadence + 加权轮询多作品——结构照搬；写作团队的 cadence 可整体放慢（写一章比修一个 bug 慢得多：执笔 agent 可 30m–2h，复盘每日）。
- 开场/收尾契约、孤儿回收、dry-run、fires.jsonl、acceptance-rate 指标——照搬。
- director 心智（人只当总监：进件走 PM、每天一条 digest、点评驱动进化）是 writing-loop 的正确人机界面。

---

## 9. 判断：什么照搬、什么替换、什么砍掉

### A. 纯通用机制——原样照搬（改名即可）

| 机制 | 出处 |
|---|---|
| 三条铁律（看板即通道 / fire 无状态 / 门禁式自治） | §0/§1/ARCH |
| conventions 单一真相源 + 冲突时覆盖 SKILL + 各 SKILL §0 一行指针 | 开篇/§0 |
| 标准 boot 六步 + close report + 硬失败一行退出 | §0/§22/各 SKILL §3 |
| 七态状态机 + verify-fail⇒close+follow-up（增量被取代永不重开） | §3 |
| MISSING/EXTRA/MISUNDERSTANDING 三分类 + 「自述只用于定位不作证据」 | §3 |
| label 三重职能 + 防火墙 label + owner=提单者=验收者 | §2/§4 |
| Backlog-first + PM 闸门 + todoDepthCap + intake.mode | §5a |
| 取单顺序表 + FIFO + blocked 排除 | §5 |
| 认领即状态移动 + verify-after-write + labels REPLACE 全集纪律 | §7/§10 |
| 去重（对工单 + **对现实**） | §8 |
| blocked 协议全套（bail-shape 首行、盲试≤2、block-cycle≤3、跨 owner 扫描、半解锁回收、W3 先子后父、W5 tracker） | §9/9a/9c |
| Sweep 捡漏全部规则 + 「report, don't mutate」 | sweep SKILL |
| lessons.md 三层自改边界 + 预算/出口阀 + 点评闭环 + 信任边界（agent 永不写 review 文件） | §14/§17/§22 |
| Reflect retro 四步 + [proposal] 单出生即 blocked 的机械防火墙 | reflect SKILL |
| north-star doc-base 固定标题 + doc-watch + ✅回写 + Decisions log + 20KB 滚存 | §20 |
| 两层 Dev：路由规则（sensitive 强制升层/拿不准降层）+ Design: 指针 + Backlog 暂存子单 + 设计闸门（先提升子后 Done 父）+ 升级链 junior→senior→human | §21a |
| change-gate（内容指纹 + lens 轮换 + 「稳态是节流阀」） | §19/pm/qa preflight |
| 报告树（daily append-only / 周月从 daily 卷 / 日期用 shell 算不用推理） | §22 |
| 状态文件纪律（有界 + 原地覆盖 + 原子 rename）、锁 + 过期锁规则、O_EXCL ID 分配 | §11/§18 |
| workspace 三层 + 可移植（复制文件夹）+ validated mutator + doctor 体检 | §27/§11/add-project |
| 调度器（cadence + 加权轮询 + 共享 cursor + dry-run/plan/max-fires） | §27/README |
| director 人机界面（进件走 PM、daily digest、needs-the-director 空为佳） | §22a/README |
| 秘密纪律（env 名不存值、报告/工单无 PII、allow-list 通知消息） | §16/§9 |

### B. 软件特有——需要替换成写作等价物

| dev-loop 概念 | writing-loop 等价物建议 |
|---|---|
| Feature / Bug / Improvement | 章节/剧集任务（策划 owner）/ 审读缺陷（审稿 owner：逻辑硬伤、吃书、人设崩）/ 润色改进 |
| repo / 多 repo + `repo:<name>` label | 稿件树（正文/大纲/设定集各目录或多部作品多 repo）；多作品时保留 repo label 路由 |
| build/typecheck/test 门 | 机械校验：格式、字数、命名一致性、可脚本化连续性检查 |
| Step 5.5 code review | 写手自查：对照章纲三分类 + 质量清单（AI 味/节奏/对白）；Critical=人设崩/吃书 |
| deploy + healthCheck + 回滚 | 交付成稿目录 + 衔接通读；「回滚」=撤回重排（可弱化） |
| testEnv.baseUrl（QA 实测环境） | 审读环境：渲染成稿 + 设定集 + 时间线账本；QA 的「repro」=指认具体段落 |
| coverage 回归测试（§15） | 设定回写强制令：每个新剧情点交接时必须已回写设定集/时间线，或已建 `[设定补录]` 跟进单 |
| strategyDoc 八标题 | 作品圣经：卖点与读者 / 核心主题爽点 / 雷点禁区 / 剧情现状 / 读者画像+人物卡 / 世界观词表 / 剧情决策日志 / 点子停车场 |
| senior/junior dev | 主笔（出卷纲章纲、接重写升级）/ 执笔写手（按纲写章） |
| `sensitive` 域（auth/支付/PII…） | 关键剧情节点：结局、大反转、人物弧转折、世界观设定变更 ⇒ 强制主笔先出纲 |
| Ops（prod 监控） | 平台/读者数据观察员（反抖动 + 单一开放事故单去重照搬）——前期可砍 |
| Architect（代码健康轮换审计） | 全稿健康审计（设定漂移/桥段重复/文风不一致）——可并入审稿或 Reflect |
| Communication（对外文章草稿） | 简介/预告/运营文案起草（draft-only 契约照搬）——可选 |
| acceptance rate、cycle time 指标 | 章节过稿率（一次验收通过÷提交）、章周期、重写率 |
| SHA change-gate | 稿件树 git HEAD / 内容 hash；lens=审读维度轮换 |
| review lenses（PM 评审棱镜） | 策划评审棱镜：节奏、爽点密度、人物成长线、伏笔账本、市场对标 |

### C. 可以砍掉（写作场景不需要或第一版不需要）

| 机制 | 理由 |
|---|---|
| §12b/§12c PR landing、autoMerge、release-PR、worktree 隔离、gh CLI 全套 | 纯 git/GitHub 工程机制。写作若用 git 直接 direct-commit 即可；「人审后合入」的需求已被 owner 验收覆盖 |
| Linear backend 及其 MCP 写入陷阱细节 | 写作团队单机本地板足够；但**保留 backend 抽象层**（§18 的操作映射表），日后可换 |
| service hub 的 Linear mirror、reports.sink:"linear"、第二 CLI 可移植（§26） | 云可见性/多 CLI 是 dev-loop 的生态需求 |
| Codex 集成（§24） | 可选加速器思想可留（图像生成→封面/插画倒是有对应物），第一版砍 |
| deployPolicy 天花板、多环境 deploy PR、Step 6.5 的 prod 回滚细节 | 无生产环境概念；保留「交付后快速核验」的弱化版即可 |
| 多 repo 的跨 repo deploy barrier 讨论、per-repo testEnv gap | 工程特有的诚实限制说明 |
| §9b team intake（跨 project 拆分） | 单作品起步用不上；多作品工作室日后可加回 |
| Human-Blocked 真实状态 + daemon 定时提醒 | 起步用 label park + 一次性 webhook 通知即可；daemon 是 service 基建 |

### D. 三条移植时的忠告（从文本中读出的设计意图）

1. **先抄「防退化」的部分，再抄「功能」的部分。** conventions 里最长的段落几乎都是失败模式的疫苗：REPLACE 式 label 掉防火墙、空 blocker 集的空真陷阱、锁不设过期的永久死锁、状态文件无界增长、ISO 周跨年、review 文件被冒充。writing-loop 的第一版 conventions 应该保留这些「血泪注脚」的结构位置。
2. **每条协作都要有「机械载体」，不能靠报告或默契。** 原文反复出现的句式是 "so the escalation always has a mechanical ticket-state carrier, never a report hand-off"——升级、提案、进件、外部等待，全部落成带机器可解析行（`Bail-shape:` / `Design:` / `Blocked-by:` / `Mode:`）的工单状态。writing-loop 的任何新协议都应照此设计。
3. **verification 必须独立于 self-claim，且「done 可被机器或独立角色判定」是采用该架构的前提。** ARCHITECTURE.md 明说：「当 done 大体主观、产出无法被自动拒绝时，别用这个循环——没有真实验证，循环只是以更高速率产出更多可疑工作」。写作的「done」天然偏主观，所以 writing-loop 的成败关键在于把验收标准工程化：章纲 AC 写成可判定项、机械校验门尽量做厚、连续性检查工具化——这是设计阶段要投入最重的地方。

---

## 附录：conventions.md 章节速查（写 writing-loop conventions 时的对照表）

| 节 | 主题 | 迁移判定 |
|---|---|---|
| §0 | fire 无状态 + boot 六步 | 照搬 |
| Topology | 一屏角色表 + 「别混淆」清单 | 照搬（换角色名） |
| §1 | 循环是什么（ASCII 流程图） | 照搬 |
| §2 | 防火墙 label | 照搬（换 label 名） |
| §3 | 状态机 + verify-fail 规则 + 三分类验收 | 照搬 |
| §4 | label 分类学 | 结构照搬，词表替换 |
| §5/5a | 取单顺序 / Backlog-first + intake.mode | 照搬（顺序表重排） |
| §6 | 工单模板 | 结构照搬，字段替换 |
| §7/§8 | 认领并发 / 去重 | 照搬 |
| §9/9a/9c | blocked / 人类进件 / 外部追踪 | 照搬（bail-shape 词表可换） |
| §10 | 查询纪律 + 写入陷阱 | 照搬（本地板语义） |
| §11 | per-project 配置 + 状态文件纪律 | 照搬（schema 字段替换） |
| §12/12a | dry-run / autonomy | 照搬 |
| §12b/12c | PR landing / autoMerge | 砍 |
| §13 | 首次设置清单 | 照搬（label 集替换） |
| §14 | lessons 文件 | 照搬 |
| §15 | coverage 回归测试 | 替换为「设定回写」 |
| §16 | 安全教义 | 照搬（PII→真人隐私/未发布剧透） |
| §17 | 自进化边界 | 照搬 |
| §18 | backend 抽象 + 本地板规格 | 照搬本地板；抽象层保留 |
| §19 | 多 repo + change-gate | change-gate 照搬；多 repo 简化 |
| §20 | doc-base | 照搬（标题替换为圣经八栏） |
| §21 | 外向 agent 契约 | 契约照搬；角色可砍/合并 |
| §21a | 两层 Dev | 照搬（主笔/执笔） |
| §22/22a | 报告 + 点评 + digest | 照搬 |
| §23 | 报告入 Linear | 砍 |
| §24 | Codex | 砍（或留图像→封面） |
| §25 | 方向经 PM（Director 已删除的教训） | 采纳教训：不设讨论板，方向走 PM 进件 |
| §26 | 第二 CLI | 砍 |
| §27 | workspace 模型 + 调度 | 照搬 |
