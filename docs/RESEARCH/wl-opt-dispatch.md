# writing-loop 调度架构分析 — 轮询模型对阶段性/串行工作是否根本错误

> 视角：分布式调度架构师。分析对象：writing-loop（短剧剧本自治 AI 团队），首个项目
> 《败家天神拾荒记》实测 88% 空跑。事实基础：`references/conventions.md` §0/§5/§5a/§21/§21a、
> `docs/DESIGN.md` §8/§9、`references/config-schema.md`、`skills/{showrunner,script-doctor}-agent`。

---

## 0. 一句话结论

**轮询本身不是「错」的（它正确、无状态、崩溃安全），但对 writing-loop 这种阶段性 + 串行
relay 的工作，它把「有没有活」这个决定放在了错误的层——用一次昂贵的 LLM 冷启（读
51KB conventions + config + lessons + 板扫描）去求一个机械可算、且已被 §0 强制
externalize 的谓词。88% 空跑就是「用昂贵的层求廉价的判断」的直接实测签名。**

正确模型是**混合**的：**关键路径（writer→reviewer→next writer→evaluator 门）走事件驱动的
work-gated dispatch，背景观察者（doctor/market-watch/reflect/sweep）保留定频**——因为它们
的触发语义本就是「攒够时间/攒够变化」而非「某张票出现了」。所以命题**基本成立**，但精确表述
是「轮询是关键路径上的错误层」，不是「轮询处处都错」。

---

## 1. 为什么轮询与这个工作负载结构性错配（两条独立性质）

### 性质 A — 阶段性：活跃工种是一个在 7-9 车道上滑动的 1-2 宽窗口
任一时刻流水线只处在一个阶段（keystone 亲写 / 审读 / 大纲门 / 里程碑评估）。实测：
- episode-writer 29 fire / **100% no-op**、reviewer 26 fire / **100% no-op**（合计 55 次纯空跑）；
- evaluator 25 fire / 92% no-op；story-designer 76% no-op；showrunner 63% no-op。

定频轮询隐含假设「每条车道稳态有活」。真实的活可用性是**在 7 车道空间上移动的 1-2 宽窗口**。
7 个 agent 全程齐开 ⇒ 恒有 5-6 条车道结构性空转。这不是调参问题，是**拓扑错配**。

### 性质 B — 串行 relay：活恰好在上游提交 handoff 的那一刻到达
依赖图是一条链（§5 顺序前置：`ep-(N-1).md` 已成 + 无 N-1 开放创作票 + 无 Episode≤N 开放 Bug）。
下游车道的活**当且仅当**上游提交一次 handoff（一次 `state:` 改写 + 一次 git commit，§15）时出现。
handoff 之间车道可证为空。定频轮询是对一个**可闭环触发的信号**做**开环采样**——不管有没有
handoff，都按 1/周期去戳一次车道。

### 关键洞察：「我有没有活」是一个廉价的、非-LLM 的纯函数
§0 强制无状态 ⇒ 状态只在三处（板 §18、剧本 repo git、数据目录）。§10 已把拾取查询定义为
「glob `tickets/*.md` → 解析 frontmatter（含 `Episode:` 机读行）→ 进程内过滤」。**这正是一个
非-LLM 脚本能做的操作**：50 行代码读同一批文件即可判定 §5 全部前置。LLM 冷启被当成了一个
极其昂贵的轮询客户端，去求一个 `grep`/`stat` 级别的谓词。

**铁证（script-doctor 的 change-gate）**：doctor 已实现 SHA change-gate（`git log -1 -- episodes/`
比对 `doctor-state.json.lastAuditSha`），SHA 未变即 no-op。但它是 **Job 0**——**跑在 boot 之后**。
所以一次 doctor no-op **仍然付了完整 boot**（读 51KB conventions + config + lessons）才发现
「树没动」。change-gate 短路了**工作**，没短路**冷启**。这正是 work-gated dispatch 要关掉的那部分。

---

## 2. 三种调度对比：(a) 定频轮询 (b) 阶段感知舰队 (c) work-gated dispatch

| 维度 | (a) 定频轮询（现状） | (b) 阶段感知舰队（D 方案） | (c) work-gated dispatch |
|---|---|---|---|
| 判断层 | LLM boot 内 | 外部 phase driver（阶段桶） | 外部廉价扫描器（§5 拾取谓词） |
| 关掉的东西 | — | 空转的**车道** | 空转的**fire** |
| 判据粒度 | — | 阶段（一个解释） | 单票拾取（一个事实） |
| 空跑 boot | 88%（实测） | 削掉跨阶段，**留下阶段内** | ≈0（boot 根本不发起） |
| handoff 延迟 | 每跳最多 1 周期 | 每跳最多 1 周期 | watch 延迟（秒级） |
| 假阴性 | — | phase 分类可两向错 | 0（与 agent 自身拾取同谓词） |

### (c) 相对 (b) 的增量价值 — 严格支配
1. **(b) 削空车道，(c) 削空 fire。** (b) 是阶段粒度：keystone 阶段里 story-designer 亲写 ep2 约
   15-20min，一条「为 keystone 阶段起的」reviewer pane 在这 15-20min 里**仍会 boot-then-no-op
   3-4 次**（票还没到 In Review）。这正是实测 reviewer 26 fire / 100% no-op 的形状——(b) 削不掉。
   (c) 只在 ep2 落 In Review 那一刻起 reviewer 一次。
2. **(c) 算的谓词更简单、更精确。** (b) 要求 driver 判「现在是什么阶段」——这是一个**解释**，可两向
   出错。(c) 求「lane X 现在有没有过 §5 的候选票」——这是一个**事实**，且**与 agent boot 时自己会
   求的谓词逐字相同**，故对 agent 的决定**零假阴性**：扫描器说「有」则 agent 必拾，说「无」则 agent
   本就会 no-op。
3. **(c) 吞并 (b)。** 阶段感知舰队就是你跑 (c) 后观察哪些车道亮起来所得到的结果——你永远不需要给
   阶段命名。凡 (b) 会关掉的（空闲阶段的车道 = 没有候选票），(c) 也关掉；(c) 额外关掉 (b) 留下的
   阶段内瞬空 case。
4. **成本结构。** (c) 的扫描器是 §10 已经规定的 glob+parse，把一次 51KB-LLM-boot 的 no-op 换成
   ~1ms 的文件扫描。88% → 趋近 0（只剩真正的 §7 竞态 fire）。

**结论：(c) 把「有没有活」这个决定整个搬出 LLM；(b) 只是减少你把多少个 LLM 对准轮询。**
给定串行 relay（keystone 亲写 15-20min 期间 reviewer 车道全程为空），(b) 的 started-reviewer
每集要 no-op 3-4 次，(c) 恰好起一次。

---

## 3. 事件驱动 vs 轮询：串行 relay 延迟的机制与消除

### 延迟数学（任务口径）
定频下每次 handoff 平均等半个周期、最坏等一整个周期才被下游下一次 poll 发现。
10 集串行链 ≈ 20 次 handoff × 300s ≈ **100min 纯延迟**（最坏，每跳一整周期），半周期均值
也有 ~50min。这是注入一条「实际工作是写作本身」的链里的**纯调度延迟**，且**加 agent 也消不掉**
（加人不缩短串行链），只有换事件驱动才能消。

### work-gated dispatch 消除机制
- 板是文件。一次 handoff = 一次 frontmatter `state:` 写 + 一次 git commit（episode+ledgers，§15）。
  两者都是文件系统事件。
- watcher 监视板目录 + repo 的 `episodes/` HEAD：Darwin 上用 FSEvents（`fswatch`）或每 5-10s 一次
  廉价 glob+stat（非-LLM，~ms）。任一变化 ⇒ 对受影响车道重算 §5/§21 拾取谓词。
- ep-N 落 In Review（reviewer 车道新增候选）⇒ **watch 延迟内**（秒级）起 reviewer，不是最多 300s。
- reviewer 把 ep-N 判 Done ⇒ ep-(N+1) 的 §5 前置翻真 ⇒ 立即起 episode-writer。

**300s/跳 → watch 延迟（秒级）。100min 纯延迟塌缩为「实际工作时间 + 跳数×秒级」。**
这是事件驱动的决定性胜利：**延迟不再是 cadence 的函数，而是 work 的函数。**

### 诚实边界与竞态兜底
- work-gated dispatch **不加速工作本身**，只消除工作之间的调度延迟。keystone 15-20min/集的
  LLM 亲写仍是 work-bound；净赚的是那 ~50-100min 纯 idle 等待 + 88% 空跑 boot。
- 一次 handoff = 多次文件写（票 frontmatter + commit）⇒ watcher 必须 **debounce**，否则双发。
- 但**双发无害**：§7 已有 run-token 认领 + 孤儿回收——两个同角色 fire 抢同一票时，输家重读 token
  退让。故 work-gated dispatch **不需要精确 exactly-once，可以 at-least-once**，安全性由 §7 兜底。
  这大幅降低了 (c) 的实现风险：dispatcher 可以简单且略微过热而不损正确性。

---

## 4. 两个交互 gotcha：验证与对策

### Gotcha ① — keystone 验收 floor vs 只起一个廉价 reviewer pane
**机制（conventions L69-74）**：reviewer 档 floor = max(reviewer 默认档, 被验票创作档)。keystone 由
story-designer 以**顶配**（opus/max）亲写 ⇒ 其验收须在**顶配** reviewer fire 上跑。默认审读档是
opus/**high**；一个 opus/high reviewer 遇到 keystone（opus/max）的 In Review 票时**跳过留待更高档
fire**（不橡皮图章、不 fail、不改状态）。

**验证 — 真实、机械强制的 stall**：当前正处 keystone 阶段（ep1-3 全归 story-designer 亲写），
**每一集 In Review 都是 keystone**。若运行方只起一个廉价（high）reviewer pane，它会对 ep1/ep2/ep3
**逐集「跳过留待」**，而更高档 reviewer fire 从没被排上 ⇒ 三集永远停 In Review、永不到 Done。而
§5 前置要求 ep-(N-1) 无开放创作票（In Review 就是开放）⇒ ep-(N+1) 也起不来 ⇒ **整条链卡在
keystone 审读 floor 上**。conventions L72-74 本身已把义务甩给运行方（「运行方据此为 keystone 验收
排一条顶配 reviewer pass」）——**说明 loop-design 已知这个坑，但把它变成了一个脆弱的人肉依赖**
（操作者必须记得手动加那条顶配 pane）。

**对策 — 这正是 (c) 发光而 (b) 不够的地方**：扫描器从板即知 In Review 票带 `keystone` 标签，也知道
所需 floor（票 tier vs reviewer 默认，纯查表）。故 dispatcher 可**按正确档位起 reviewer**：见 keystone
In Review ⇒ 用 opus/max（顶配）而非 opus/high 起 reviewer。**档位变成被门控票的计算属性，而非人肉
provision 的静态 pane 属性**。config 已有 per-agent `efforts` 覆盖，dispatcher 读票标签 → 定 effort。
(c) 下 §1 的「跳过留待」分支基本永不触发——dispatcher 从不对超档票起欠档 reviewer。
**补充护栏**（即便保留轮询）：sweep/reflect 应加一个检测——「keystone In Review 票 aging > T 且 run
log 里无顶配 reviewer fire」⇒ digest 旗标，把 silent stall 浮出。当前无任何东西检测它，票就干坐着。

### Gotcha ② — evaluator 降 1800s 省成本 vs milestone-eval 是 Blocked-by 下游生产的门
**机制（§21）**：milestone-eval 票是机械门——「file arc-(k+1) 设计票时若存在未 Done 的
milestone-eval 票 ⇒ 新设计票出生即 blocked + Blocked-by」。故**整个下游**（下一 arc 设计、及其
传递的全部 episode）Blocked-by 这张 eval 票 Done；outline 票 Done 也 Blocked-by 定稿门 eval 票。

**验证 — 假节约**：showrunner 在 T 时刻写下 milestone-eval 票（一次板写）。evaluator 每 1800s poll。
最坏该票刚好在 evaluator 上次 poll 后出现 ⇒ 等 ~1800s（30min）evaluator 才 boot 拾它。这 30min 里
**整条流水线停在门上**：无下一 arc 设计、无下集、outline 本身也 blocked。「慢 evaluator cadence」
省下的成本，被偿还为**每个里程碑门最多 30min 的全流水线 stall**。6 道门 ⇒ 关键路径上最多 ~3 小时
纯门延迟，只为省几个 evaluator boot——而 work-gate 本可免费避免这些 boot。B 方案的「里程碑触发
1800s」桶**把关键路径门延迟和背景 cadence 混为一谈**：它对 doctor/market-watch/reflect（真背景，
无人等）正确，对 evaluator（经 Blocked-by 在关键路径上）错误。

**双重 cadence 跳**：showrunner 也只在**它自己 fire** 时才发现触发条件（如 ep1-10 全 Done）并 file
eval 票。故门路径上有**两个** cadence 跳：①showrunner 得 fire 才注意到触发并 file；②evaluator 得
fire 才拾。纯轮询下两者都加延迟。

**对策 — evaluator 是 work-gated dispatch 的头号招牌**：showrunner 把 eval 票写到 Todo（板写）的
那一刻，watcher 见新 `Todo+milestone-eval` 票在 evaluator 车道 ⇒ 秒级起 evaluator。1800s 最坏 →
watch 延迟。**evaluator 的正确 cadence 是「恰当一张 milestone-eval 票存在时，否则永不」——按定义
是事件门，不是周期。** 双 cadence 跳同样塌缩：board 到「ep10 Done」⇒ 起 showrunner ⇒ file eval 票
（板写）⇒ 立即触发 evaluator。门以「work-time + 2×watch 延迟」穿过，而非最多 2×周期。
**若必须保留轮询**（无 dispatcher）：evaluator 的安全做法**不是** 1800s，而是保持与关键路径 writer
同样的紧 cadence 并吞下 boot 成本——因为门延迟压倒 boot 节约。但正解是让 evaluator 事件门控。

---

## 5. writing-loop 应否补一个 launcher（`wl run`）？

**判断：应该补，且它应做 work-gated dispatch，而非仅 phase-level。** 理由（§2/§3/§4 已论证）：
work-gated 严格支配 phase-level——吞并它、更精确、消阶段内空跑、为 gotcha ① 算档位、为 gotcha ②
事件塌缩门延迟；而使能谓词（§5/§21 拾取）**已被 §10/§18 完整规定为非-LLM 板 glob**。板格式本就是
为机器可扫而设计的；launcher 只是读它已经写在那里的东西。

### 但要害是划清：哪些是 loop-design（进 conventions/config，受 §17 治理），哪些是纯 harness（外部脚本）

**分界线：拾取谓词是 loop-design；派发机制是 harness。**

- **loop-design（已在 conventions，launcher 绝不重复实现）**：§5 顺序前置、§5a Todo 深度上限、
  §21 Blocked-by 门、§1 reviewer floor、§7 认领/孤儿。它们定义「一条车道何时有合法活」，**本就是
  agent 自己 boot 时的逻辑**。**launcher 绝不能把它们重实现为第二真相源**——那正是 §0 所禁的
  「两个真相源」漂移。做法：launcher 的门是 agent 拾取的**保守超集**（「可能有活」），agent 自己的
  boot 仍是权威的「确实有活」。launcher 过发（说「可能」而实为「无」）⇒ agent boot、发现无活、
  no-op——就那一次退化回今天的行为，**永不退化为不正确**。这把 agent 的 §5 逻辑保持为单一真相源，
  使 launcher 成为一个**不可能破坏正确性**的纯优化。安全架构 = **launcher 廉价保守预筛 + agent boot
  权威判定 + §7 并发兜底**。

- **harness（外部脚本，不受 §17 治理，不作为 conventions 规范条目）**：watch/poll 循环本身、debounce、
  进程 spawn、cron/daemon 接线、tier→effort 查表、comms。这是调度管道，正是 DESIGN §8 已写明的
  「scheduling = 手动 slash / 外部 cron」那个槽。`wl run` 就是「你自己的 cron」的产品化形态——把
  「外部 cron」从一个哑计时器升级为一个板感知触发器。**它不是新 agent、不 file 票、不做任何创作或
  门禁决定**，只决定「何时 boot 哪个已定义的 agent」，基于「已定义的板状态」。这使它稳稳落在
  §2/§17 的 harness 一侧：从不碰票内容、不改状态、不绕门。

### 所以「loop-design 还是纯 harness」的裁决
**它是消费 loop-design 不变量、但零新增的 harness。** 唯一的 loop-design 改动是一句规范契约 +
一个 opt-in config 块。其余全是 DESIGN §8 已预留槽位的外部管道。我们改的是**何时 fire**（DESIGN
已明确 externalize 的东西），**不改 loop 语义**（状态机、门、owner、三分类全不动）。

### 要写进哪里（三处）
1. **conventions（一句规范契约）**：新增（挂在 §8 邻近 / 扩 §0 拓扑）——「work-discovery 可由外部
   dispatcher 预门控；dispatcher 的门是 advisory 且保守；agent boot 时的 §5/§21 拾取仍是权威；
   过发退化为 no-op，绝不退化为不正确；§7 处理任何 spawn 竞态。」**这是让 launcher 安全合法的那
   一句**——它是 §24 Codex「advisory，绝不权威」条款的调度版，应以完全相同的精神写。没有它，
   launcher 就是一个未文档化的第二调度器，后来维护者可能误当权威。
2. **config-schema（opt-in 块，缺席 ⇒ 100% 不变，同 `codex` 优雅降级契约）**：
   `scheduling.mode: "manual"|"dispatch"`（默认 manual = 今天）、`scheduling.watch: "fsevents"|"poll"`、
   `scheduling.pollInterval`、`scheduling.eventGated`（车道集：showrunner/story-designer/episode-writer/
   reviewer/evaluator）、`scheduling.backgroundCadence`（doctor/market-watch/reflect/sweep 各自周期）。
   per-project（mode/live-vs-dry-run/档位皆 per-project）。
3. **外部脚本 `wl run`（插件 repo 内、skills 兄弟位、**不是** SKILL.md）**：实际 daemon。CLI 无关
   管道（§25 精神），只调 `/writing-loop:<agent>-agent`（Claude）或 Codex 等价。读 config、watch
   板+repo、算保守门、spawn。

### 关键细分：不是所有车道都 work-gate——背景观察者留 cadence（混合 launcher）
- **事件门车道（关键路径，88% 浪费 + 100% relay 延迟所在）**：showrunner、story-designer、
  episode-writer、reviewer、evaluator——按「创造出可拾活的板状态变化」spawn。
  - showrunner 的 **doc-watch 是完美事件门**：watch `bible/north-star.md` mtime；操作者一改 ⇒ 起
    showrunner。「showrunner 轮询以发现操作者编辑」→「操作者编辑 spawn showrunner」。
- **cadence 车道（真背景，cadence 语义正确）**：doctor（周期 + SHA 预门）、market-watch（周）、
  reflect（日）、sweep（周期卫生）。work-gate 它们是错的（reflect 的活是看一段历史窗口，没有单张
  票「意味着 run reflect」）。
  - **doctor 的甜点**：launcher 可**在 harness 里吸收 doctor 的 SHA change-gate**（自己算
    `git log -1 -- episodes/` 的 sha 比对），只在 episodes/ 真动过 **且** 慢 cadence 到点时才 spawn
    doctor。这把 doctor 现在的「boot-then-no-op」（付 boot）变成「根本不 boot」。

**这个混合是诚实且精确的答案**：关键串行路径（88% 浪费 + 全部 relay 延迟）work-gate，真背景
观察者（cadence 语义正确处）保留定频。

---

## 6. 立即桥接（launcher 落地前，直播项目现在就在 stall）

C 方案（立即调参）+ 手动 (b)，零代码，今天就做：
- **keystone 阶段只起两条车道**：story-designer（亲写）+ 一条**顶配（opus/max）reviewer** pass
  （治 gotcha ①）。**关掉** episode-writer（ep4-9 被 §5 前置阻塞，无可拾）、evaluator（还没有
  milestone-eval 票）、market-watch（周频，一周一次不是 300s）、reflect（日频，一天一次）。这就是
  手动阶段感知舰队，零代码拿回大部分跨阶段收益。
- **evaluator 不设 1800s，改按需**：showrunner 一 file milestone-eval 票就手动起 evaluator（治
  gotcha ②）。launcher 落地前这是操作者动作。
- 这是桥；launcher 把它产品化。

**量化（同产出下）**：121 fire / 107 no-op / 174min → 混合 launcher 下关键路径只在真 handoff fire
（keystone 阶段 ~13 commit 来自 ~14 生产 fire）+ 背景 cadence（doctor per-commit、reflect 日 1、
market 周 0-1、sweep 少数）≈ **25-35 fire**，**~70-75% fire 削减**；100min relay 延迟 → 秒级×跳数。
诚实注：keystone 是 designer 串行、15-20min/集，wall-clock 仍 work-bound；launcher 不加速写作，
它消掉 idle boot、消掉跳间等待、修掉两个 stall。

---

## 7. 对整个命题最强的反驳与诚实回应

**反驳**：「88% 是错排产放大的，不是轮询本身。调 cadence（C）+ 手动关空闲 agent（手动 b）就能
拿回大部分，根本不需要 launcher。」

**回应**：对**跨阶段**浪费部分成立（手动舰队能修），但——
1. 它把持续的人肉运维负担压给非技术操作者（要懂当前阶段、手动切 pane——正是产品想自动化掉的）；
2. 它对**阶段内 relay 延迟**（300s/handoff 项）**无能为力**——不换事件驱动就调不掉；
3. 它不修 gotcha ① 的档位选择、不修 gotcha ② 的门延迟——这俩是**正确性/吞吐 stall，不只是成本**。

所以调参是真实但**部分且运维脆弱**的缓解；launcher 是持久修复。故 launcher 列为高影响主项，
调参列为低成本桥。

**「轮询根本错吗」的精确裁决**：作为正确性模型，轮询不错（鲁棒、简单、崩溃安全）；但对
**阶段性/串行工作的 work-discovery**，它是**错误的层**——付 LLM 冷启去求一个机械廉价、已完全
externalize 的谓词。此工作负载的正解是**关键路径事件驱动 work-gated dispatch + 背景观察者
保留 cadence**。88% 空跑是「用昂贵层求廉价决定」的直接实测签名。**命题基本成立，精确化为
「关键路径上的错误层」，而非「处处皆错」。**

—— 完 ——
