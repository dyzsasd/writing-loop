# writing-loop 舰队模型再审：从「9 常开循环」到「阶段工作集」

> 视角：系统设计师。质疑一个继承来的假设——writing-loop 照搬 dev-loop 的「多角色常开、
> 各自独立定频」调度模型。基于首个项目《败家天神拾荒记》174 分钟窗口实测数据，论证这是
> **范式误配**，给出阶段→工作集映射，并判断该由谁执行抑制。
>
> 依据：`references/conventions.md`（拓扑一览 + §5/§5a/§21/§21a/§22）、`docs/DESIGN.md` §8
> （「调度:手动 slash / 外部 cron。boot 六步原样」——**确认 conventions 内零阶段/舰队逻辑，
> 调度完全外置且各 agent 独立定频**）。

---

## 0. 实测数据是论证的地基

| 指标 | 数值 |
|---|---|
| 窗口 | 174 min，7 个 agent 循环各自独立定频（多为 300s） |
| 总 fire | 121 次 |
| no-op | 107 次（**88%**） |
| 有效 fire | ~14 次 → 产出全部 13 个 commit |
| episode-writer | 29 fire / **100% no-op** |
| reviewer | 26 fire / **100% no-op** |
| evaluator | 25 fire / **92% no-op** |
| story-designer | 76% no-op |
| showrunner | 63% no-op |
| 真实节奏 | 每 8-20 min 一个里程碑，**全程单线程串行**；keystone 每集出片 ~15-20min |
| 每次 no-op 成本 | 一次冷启 boot（读 conventions ~41KB + skills + lessons + 板扫描 + 模型 spin） |

**三个数字锁定诊断：**

1. **66% 的 fire 来自三个「本不该按 300s 跑」的角色**：29+26+25 = 80 fire 来自
   episode-writer（keystone 阶段结构性无活）+ reviewer（无 In Review 可验）+ evaluator
   （纯事件触发，只执行 milestone-eval 票）。这三者占全部 fire 的 66%、占全部 no-op 的
   ~72%。
2. **55 次纯空跑集中在一个阶段**：episode-writer + reviewer 合计 55 次 100% no-op，且成因
   **单一而清晰**——当前处 keystone 阶段：ep1-3 全归 story-designer 亲写（episode-writer
   lane 里一张票都没有），ep4-9 被「前一集 Done 才能写下一集」的顺序前置（§5）前置阻塞，
   至今无一集到 In Review（reviewer 无对象）。
3. **里程碑每 8-20min 到达、单线程串行**：300s（5min）cadence 意味着每个里程碑窗口内每个
   agent 要 fire 2-4 次，但**任一时刻只有 1 个 frontier agent 手上有那个里程碑**。其余 5-6
   个 fire 结构性空转。这就是 88% no-op 的机械解释。

no-op 不是免费的。107 × 41KB conventions ≈ **4.4MB 纯 conventions 重读**,外加每次 skills +
lessons + 板扫描 + 模型冷启。这是可直接消除的浪费,不是「便宜的心跳」。

---

## 1. 逐角色工作触发条件

对每个 agent 追问一句话:**什么条件下它才有活?** 答案决定它属于哪一类。

| agent | 「有活」的充要条件 | no-op 主因 |
|---|---|---|
| **showrunner** | 恒有:doc-watch(每 fire 比对 north-star 快照)、Backlog→Todo 放行闸门、扫 `needs-showrunner`、监测里程碑触发条件→file milestone-eval 票、验收 outline/arc-design/milestone-eval/立项/punch-up/market-Bug 票、un-block 重排 | 无——它是**唯一的放行闸门 + 路由器**,始终「相关」;63% no-op 是「相关但本 fire 无待办事件」 |
| **story-designer** | 存在 ①Todo arc-design 票 或 ②Todo keystone 集票(亲写) 或 ③`Mode: direct-write` 升级票 或 ④punch-up Improvement 或 ⑤`needs-designer` 节拍修正提案 | 阶段外(如纯量产中段无 keystone、无升级)时无触发 |
| **episode-writer** | 存在满足 §5 顺序前置的 Todo 非-keystone 集票(tier=episode-writer),或 Todo 修订 Bug / craft Improvement(其 tier) | **keystone 阶段 lane 里零票**;顺序前置阻塞时全部候选被跳过(常态节流) |
| **reviewer** | 存在 In Review 的 episode / Bug,或需 file 的邻集复核,或 `needs-reviewer` | 无任何 In Review 对象时纯空跑(当前状态:串行阻塞→无一集到 In Review) |
| **script-doctor** | `episodes/` 自上次审计**有新 commit**(SHA change-gate);或当前生产集处结构地标区(强制定维) | change-gate:无新提交即 no-op(设计如此);量产前几乎无提交可审 |
| **evaluator** | **仅**存在 Todo + `milestone-eval` 票(showrunner 所 file);自己从不扫描 | 纯事件触发;门边界之外恒无票→92% no-op |
| **market-watch** | **周频**扫榜/政策 + `marketDataPath` 数据;反抖动(两来源/两周才 file) | 与集流水线完全解耦;按周计,300s cadence 下 99% 是空跑 |
| **reflect** | **日频**:对时间窗做 retro + 策展 lessons | 按日计;300s 下绝大多数 fire 无新窗口可 retro |
| **sweep** | 生命周期卫生:错标/孤儿(§7 超时 60min)/陈旧信号 + 板健康摘要 | 卫生周期性;300s 远高于错标产生速率 |

### 三分类

**(i) 关键路径 — 按阶段轮换**:`story-designer` / `episode-writer` / `reviewer`。
三者构成生产流水线(设计→写→验)。因工作是**串行 + 分阶段**的,任一时刻只有其中
**1-2 个**在 frontier 上;齐开三个 → 恒有 1-2 个结构性空转。88% no-op 的主体来自这里。

**(ii) 事件触发 — 待命**:`evaluator`(milestone-eval 票 / Blocked-by 拉起)、
`script-doctor`(SHA change-gate)、`market-watch`(周频 + 数据)、`reflect`(日频窗口)、
`sweep`(卫生周期)。这些**不该挂在紧的固定 cadence 上**——要么被事件拉起,要么按其自然
(慢)周期跑。把它们放 300s 是纯粹的 cadence 错配(evaluator 92% no-op 是活证据)。

**(iii) 协调 — 低频常在**:`showrunner`。放行闸门 + doc-watch + `needs-*` 响应者 +
milestone-eval 发起者。它必须全程 tick(否则 Backlog 永不进 Todo、操作者进件无人响应),
但即便它也可以从 300s 放宽到 600-900s——它是协调层,不是实时层。

---

## 2. 核心命题:9 循环齐开对 writing-loop 是范式误配

### 论证

**dev-loop 的前提:每个角色都有独立、持续补充的 backlog。**
- PM:功能构想是连续流,永远有下一个可提;验收在制票。
- QA:测试面永远在,永远有边界情况可测。
- Dev:Todo 队列常满。
- Architect:轮换审计总有下一个维度。
- Ops:prod 一直在跑,永远可轮询。

这五个角色是**并行 + 连续**的:各自有一条**永远在补水的独立 backlog**。工作拓扑是
**宽、浅、并行**的一片流。「9 循环齐开」对这个拓扑是**正确**的——因为任一时刻多数角色
确实都有活。

**writing-loop 的前提(被实测证伪):工作是串行 + 分阶段 + 单 frontier。**
一部剧本一次产一集,严格按 Episode 序(§5 顺序前置)、带前向冻结(§5.2)。任一时刻
「前沿」只有**一集**(或它的审读)。流水线是**窄、深、串行**的漏斗:

```
立项 → 大纲 → 定稿门 → arc 设计 → keystone 写作 → 量产 → 里程碑门 → … → 完本
```

每个阶段把工作交给下一个阶段;**阶段内通常只有一个角色是瓶颈演员**。于是 7-9 条齐开的
循环里,**结构性地保证 5-6 条无活**。

实测就是证明:88% no-op;episode-writer 在 keystone 阶段 100% no-op(ep1-3 全是
story-designer 的);reviewer 100% no-op(串行阻塞→无一集到 In Review)。**这不是调参问题,
是结构问题**:循环拓扑(独立定频、全程齐开)与工作拓扑(串行、分阶段、单前沿)相矛盾。

**结论:自然调度单元不是「9 个常开 agent」,而是「当前流水线阶段真正需要的那 2-3 个角色」。**
舰队应随阶段轮换其活跃集。**命题成立。**

### 诚实的反命题(何时「常开」反而对)

命题**有一个重要的定界**:它对**单项目 / 少项目 workspace**成立,随并发项目数上升而失效。

若一个 workspace 里跑**很多部剧**、各自处不同阶段,则跨剧聚合会把 9 个角色都填满:
剧 A 在量产(喂饱 writer)、剧 B 在大纲(喂饱 designer)、剧 C 到里程碑门(喂饱 evaluator)。
**多项目场景下「常开」实际上是对的**——单项目的串行分阶段在项目维度上被平均掉了。

这反过来解释了 dev-loop 为何没暴露这个病:dev-loop 通常是**一个大产品、所有轴常年活跃**
(PM/QA/Dev/Architect/Ops 都对同一 codebase 持续有活)。writing-loop 的**生产单元更小、
更串行**,所以要**很多并发剧**才填得满同一支舰队。

**这把「逻辑放哪」也一并回答了:阶段判定必须 per-project,launcher 启动的是
∪(各项目工作集)。** 单项目时那是 2-3 个 agent;5 部错峰剧时可能就是全 9 个——那时
「常开」本就没错。误配的是「单项目也强行齐开 9 条」。

### 修正命题(避免过度简化)

阶段→工作集**不是硬分区**。「量产段 story-designer 全休眠」是错的(见 §3 修正)。正确表述:
每阶段有一个**主工作集(必跑)** + 一圈**事件触发待命(可被其触发事件唤醒)**。硬 on/off
会饿死合法的少数派工作(如量产中途到达的 `Mode: direct-write` 升级票——那正是 reviewer
fail 三级路由的救援通道,饿死它 = 系统赖以自愈的机制挂起)。

---

## 3. 阶段 → 工作集映射表

七阶段。每阶段列:**必跑**(critical,主工作集) / **事件触发待命**(被其事件唤醒即起) /
**可完全休眠**(该阶段结构性零活)。

| 阶段 | 必跑 | 事件触发待命 | 可完全休眠 |
|---|---|---|---|
| **立项**(add-script,操作者 skill) | showrunner(放行首张大纲票、doc-watch) | market-watch(interview 时扫对标,操作者触发) | story-designer / episode-writer / reviewer / evaluator / script-doctor |
| **大纲**(story-designer 写 outline+bible) | **story-designer**(写大纲——大纲票 tier=story-designer,§13.4)、showrunner(低频,doc-watch) | evaluator(outline In Review→定稿门待起) | episode-writer / reviewer / script-doctor(无提交可审) |
| **定稿门**(evaluator 大纲定稿门) | **evaluator**(执行定稿门票)、showrunner(file 门票→验收 outline→pass 后 file arc-01 设计票) | story-designer(门 fail→改 outline;arc-01 设计紧随) | episode-writer / reviewer / script-doctor |
| **keystone 写作**(arc 设计 + ep1-3 亲写)⚠️**当前阶段** | **story-designer**(arc 设计 + keystone 亲写)、showrunner(大纲门验 arc-design + 放行)、**reviewer**(验 keystone In Review,需**顶配** pass) | evaluator(ep3 Done→前三集微门)、script-doctor(ep1-2 提交后 change-gate 开始有活) | **episode-writer**(ep1-3 全 keystone→它 lane 里零票=实测 29fire/100%no-op) |
| **量产**(episode-writer 逐集写) | **episode-writer**(顺序写非-keystone 集)、**reviewer**(逐集验) | **story-designer**(⚠️**非全休眠**:后续 keystone 集[卡点±1/深谷/终局3集]、下一 arc 设计票、`Mode:direct-write` 升级、`needs-designer` 提案、arc 完集后 punch-up)、script-doctor(SHA change-gate 此段最活)、evaluator(里程碑门边界)、showrunner(顶 Todo 深度、file 下一 arc/门票、un-block) | ——(无角色全休眠;writer+reviewer 主、其余事件待命) |
| **里程碑门**(一卡/卡二/卡三门) | **evaluator**(执行门票——**被 Blocked-by 拉起**:arc-(k+1) 设计票出生即 `Blocked-by: <eval票>`,§21)、showrunner(file 门票、验收、操作者决策后 un-block) | story-designer(arc-(k+1) 设计待解锁;一卡门切片不达标→punch-up)、episode-writer(门发现的修订票,但前向冻结至门过) | reviewer(除非 punch-up 复核/修订集)、script-doctor、market-watch |
| **完本**(完本门) | **evaluator**(全量 rubric+定级+续季钩)、showrunner(file、验收、回写 north-star) | story-designer(续季钩/终局 punch-up)、reflect(收官 retro) | episode-writer / reviewer / script-doctor / market-watch |

**跨阶段(与阶段解耦,按各自自然周期,永不挂 300s):**
- `market-watch`:**周频**。与集流水线零耦合。
- `reflect`:**日频**窗口 retro。
- `sweep`:**卫生周期**(建议日频)。孤儿回收非紧急——§7 orphan 超时本就是 60min,晚 30min 无害。

**额外的「PARKED」状态(D 方案应显式枚举):** 一卡门后 = 操作者决策点,eval 跟进票以
`external-prereq` 人工停靠(§21/§9)。停靠期间**整条流水线冻结**,通知已推送(`notified`),
**只有 showrunner 需 tick**(轮询 un-block 信号),其余全部可休眠。这是一个独立的、
「几乎全灭灯」的阶段,值得 launcher 单列。

### 对 D 方案(phase driver 读板判阶段→只起该阶段 agent)的补充/修正

D 方案方向正确,但其舰队表若按「阶段=硬分区」写,会犯以下错误:

1. **【修正】量产段 story-designer 并非全休眠。** 它是事件触发待命:后续 keystone 集、
   下一 arc 设计、`Mode:direct-write` 升级、`needs-designer` 裁决、punch-up 都在量产段发生。
   硬「关掉」会**饿死升级重写票**——而 direct-write 是 reviewer fail 三级路由的第 2 级救援
   (§21a),饿死它=创作自愈机制挂起。D 的驱动必须把 story-designer 在量产段标为
   「standby-wakeable」而非「off」。
2. **【修正】里程碑门 evaluator 不是「常开轮询」,是 Blocked-by 机械拉起。** 门已被编码为
   一条 Blocked-by 边(arc-(k+1) 设计票 blocked-by eval 票,§21)。driver 只需在
   「∃ Todo+milestone-eval 票」时唤醒 evaluator——一个 cheap 板 glob,不是相位模型。
3. **【补充】reviewer 在 keystone 写作段是必跑而非待命。** 当前实测 100% no-op 只是因为
   串行阻塞尚未交出 In Review;一旦 keystone 到 In Review,reviewer 就在关键路径上,且需
   **顶配 pass**(§拓扑「reviewer 档 ≥ writer 档」;keystone 由顶配 designer 亲写→其验收
   也须顶配)。D 的驱动排 keystone 阶段时必须为 reviewer 预留一条顶配 pass。
4. **【补充】showrunner 必须每阶段 tick,永不关。** 它是放行闸门 + doc-watch + `needs-*`
   响应 + milestone-eval 发起。这是 driver 唯一绝不能熄灭的灯(否则 Backlog 死锁、操作者
   进件无人接)。它不是阶段轮换角色。
5. **【补充】人工停靠 = 独立 PARKED 阶段。** D 的阶段枚举需含此态:除 showrunner 外全灭。

---

## 4. 判断:谁执行「阶段工作集」——外部 launcher vs. conventions 自抑制

### 方案 A:外部 launcher(harness)读板算阶段→只起该阶段 agent

**利:**
- **彻底零启休眠 agent 的 boot**——最大的赢。55 次纯 no-op(keystone 段的 writer+reviewer)
  **根本不 boot**:不读 41KB conventions、不扫板、不 spin 模型。直接省成本。
- **相位逻辑集中一处**——一个 driver 里推理/测试/修复,而非散落在 9 个 skill。
- **保持 agent 简单无状态**(§0 首要指令:每 fire 无状态、重读 ground truth)。agent 完全
  不需知道「阶段」概念,per-role 心智模型保持干净。
- **CLI 无关不受影响**(§25):调度本就外置(DESIGN §8),给 launcher 加相位逻辑不碰插件的
  跨-CLI 可移植性;driver **只读**板(§18 真相源),天然不违反 §2 安全边界。

**弊:**
- **launcher 必须读板算阶段**——它现在需要一份 §18 板解析逻辑的**第二实现**(板之外的
  第二读者)。板格式若变→漂移风险。
- **相位判错=静默饿死流水线**——比廉价 no-op 更坏的失败模式。例:它以为在 keystone,但一张
  升级 direct-write 票到了→story-designer 永不起→票永久挂起。要防此,driver 还得对每个角色
  做「你 lane 里有 Todo 票吗?」的兜底检查——**此时它在重新实现每个角色的 pickup 谓词**。
- **阶段非干净分区**(量产要 story-designer)→driver 必须编码每个角色的事件唤醒条件,即
  **所有角色触发谓词的并集**。大量逻辑跑到插件之外。
- **治理归属分裂**:§17 说 agent 不得自改治理文件,但 phase driver 现在是**该边界之外的一个
  治理级工件**。它住哪?谁 own?谁审?

### 方案 B:conventions 自抑制(agent 检测无活→自拉长下次唤醒)

例:episode-writer 检测「我 lane 无 Todo 票 且顺序前置全阻塞」→写一个 backoff 提示,下次
cadence tick 时早退。

**利:**
- **复用已有逻辑**——agent 每 fire 本就算 pickup 谓词(§5 顺序前置、tier 切片),它**已经知道**
  自己有没有活。加「无活则退避 cadence」是极小的本地增量,不引入新板读者。
- **无中心相位判错点**——每个 agent 基于自己已读的 ground truth 为自己决策。失败有界:最坏是
  退避过猛、晚一个周期(受 backoff 上限约束)拾票,**永不永久饿死**。
- **天然处理「非干净分区」**:量产段 story-designer 退避,但升级票一出现,它下次(受上限约束的)
  唤醒本就在读板→即拾取。事件待命免费落地。
- **留在插件/conventions 内**——CLI 无关(§25),受 §17 治理,自抑制规则是 §-级约定,跨
  Claude/Codex 可移植。

**弊:**
- **仍付一次 boot 才发现无活**(读 41KB conventions + 扫板)。自抑制降**频率**,永不消除**每次
  检查的 boot 成本**。这恰是数据点名的成本(每 no-op 一次冷启)→**B 在这一点上严格弱于 A**。
- **backoff 是 per-agent 状态,须持久化**(state 目录)。§0 说 fire 无状态、状态只在
  板+repo+data-dir——「next-wake 提示」是新状态(与 §0 轻度张力,但 data-dir 本就是合法状态家:
  doctor 轮换位、doc-watch 快照已存那)。可接受,但多一个状态字段。
- **cron 下 agent 改不了自己的 cron 间隔**——只能写「sleep-until-T」提示,下 fire 读它早退。
  于是仍每 cron tick boot + 读提示 → 更便宜的 no-op(跳过板扫描),**但仍 boot**。纯 B 在外部
  cron 下只省「板扫描」那段,不省 conventions 重读/模型 spin。**要真跳过唤醒,须 launcher 认这个
  提示 → 退化为混合。**

### 推荐:混合(诚实的答案)

四层分工,恰好对齐四个优化层:

1. **【immediate-tuning / C】先修 cadence——最高性价比、最低工作量。** market-watch(周频)、
   reflect(日频)、sweep(日频)、evaluator(事件/慢频)本就不该在 300s。这四个改配置数字即可,
   零相位逻辑。evaluator 92% no-op、market-watch/reflect/sweep 的空跑**全部靠这一步消失**。
   **先做这个**。

2. **【launcher/dispatch / 精简版 D】launcher 只对「整阶段干净休眠」的两个角色做粗粒度门控**:
   episode-writer(立项/大纲/定稿门/keystone-only 全程休眠)与 reviewer(首个 In Review 前休眠)。
   这两个是 55 次纯 no-op 的来源——**用一个 cheap 板 glob**(「∃ 可拾的非-keystone 集票?」/
   「∃ In Review?」)决定起不起,**不是全相位模型**,谓词简单且安全。省掉 ~55 次 boot,单招最高值。

3. **【loop-design / B】事件待命角色(story-designer / script-doctor)用 data-dir backoff 提示
   自抑制**,但**保持可唤醒**——它们的「有活?」谓词太纠缠、不宜外置(外置=在 launcher 里重实现
   §5 顺序前置 + tier 切片 + 升级检测)。让它们自退避但下 fire 仍读板→升级票永不被饿死。

4. **【deeper-tradeoff】相位判定必须 per-project,launcher 启动 ∪(各项目工作集)。** 单项目=
   2-3 agent;5 部错峰剧=可能全 9。这既是「常开何时对」的定界(§2 反命题),也回答了「逻辑放哪」:
   **一个 per-project 相位闸,跨项目取并集**。showrunner 恒 tick(唯一绝不熄的灯),它顺带就是天然
   的 per-project 相位观察者——可让它在 report 里输出「本项目当前阶段」,launcher 据此起舰队,而非让
   launcher 独立重解析板(消解方案 A「第二板读者」之弊)。

**一句话:C 立即做(纯调参);D 只用于两个干净休眠角色(粗门控);B 用于纠缠的事件待命角色
(自抑制但可唤醒);showrunner 恒开并充当 per-project 相位信号源。避免把「9 独立定频」直接换成
「1 个全知 phase driver」——那只是把 88% no-op 换成一个可能判错、住在治理边界之外的单点。**

---

## 5. 与既有方案(A/B/C/D)的对账

| 既有方案 | 本分析裁决 |
|---|---|
| **A 阶段感知舰队**(关掉当前阶段没活的 agent) | **对,但须「主工作集 + 事件待命」而非硬 on/off**。只有 episode-writer / reviewer 可整阶段硬关;story-designer / doctor / evaluator 是「可唤醒待命」,硬关会饿死升级/门票。 |
| **B cadence 分档**(关键路径 120s/协调 240s/里程碑触发 1800s/周频卫生不变) | **方向对,数字需重排**。关键路径角色(writer/reviewer)问题不是 cadence 太慢而是**阶段外根本不该起**(120s 只会让 keystone 段的空跑更密)。分档对**事件/周期类**(evaluator/market-watch/reflect/sweep)才是主药。 |
| **C 立即调参** | **最高性价比,先做**。把 market-watch/reflect/sweep/evaluator 从 300s 拉到其自然周期,零结构改动即消除大半 no-op。 |
| **D phase driver 读板判阶段→只起该阶段 agent** | **正确的终局,但需 §3 五条修正**(量产 designer 非休眠、门 evaluator 是 Blocked-by 拉起、keystone reviewer 必跑且顶配、showrunner 恒开、PARKED 独立态),且 driver 应**复用 showrunner 的 per-project 相位输出**而非独立重解析板。 |

---

## 6. 落地次序(按 impact/effort)

1. **(C,即刻)** 修四个角色 cadence:market-watch→周频、reflect→日频、sweep→日频、
   evaluator→仅「∃ Todo milestone-eval」时起。**纯配置,消除 ~50% no-op。**
2. **(精简 D,小)** launcher 加两个 cheap glob 门控:episode-writer 仅「∃ 可拾非-keystone 集票」
   时起、reviewer 仅「∃ In Review」时起。**省掉 keystone 段 55 次纯 boot。**
3. **(B,中)** conventions 加一条自抑制约定:事件待命角色(designer/doctor)无活时写 data-dir
   backoff 提示、下 fire 早退但仍读板;上限保证升级/change-gate 不被饿死。
4. **(深层,中)** showrunner report 输出「本项目当前阶段」;launcher 跨项目取 ∪(工作集)。
   **让「常开」随并发项目数自然回归为对的模型。**
