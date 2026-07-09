# writing-loop — 空跑 boot 的 token 税：量化 + no-op fast path 设计

视角：LLM 成本 / 上下文工程。聚焦一个被低估的浪费——**每次 no-op fire 仍付一次完整冷启 boot**。
实测基础：《败家天神拾荒记》174 分钟窗口，121 fire / 107 no-op（88%）/ 13 commit（~14 productive fire）。

---

## 0. 先纠一个数：conventions 比简报说的更大

| boot 输入源 | 简报估值 | **实测字节** | 实测字符 (CJK/ASCII) | 估算 token |
|---|---|---|---|---|
| `references/conventions.md` | ~41 KB | **51,420 B** | 29,742 (8,579 / 21,163) | **~15.5K** |
| `skills/episode-writer-agent/SKILL.md` | ~18 KB | **20,113 B** | 11,929 (3,212 / 8,717) | ~6.0K |
| `skills/reviewer-agent/SKILL.md` | — | **20,242 B** | 11,962 | ~6.0K |
| lessons（`## Shared` + 本 agent 分节） | — | 项目相关，0–3K token | — | ~1.5K（保守） |

token 估算法：CJK≈1.2 tok/字，ASCII/markdown≈0.25 tok/字；与 `bytes/3.3` 交叉校验一致
（51,420/3.3≈15.6K，20,113/3.3≈6.1K）。**conventions 实测 51.4KB，比简报的 41KB 还大 25%，税更重。**

关键区分——**哪部分可省**：
- SKILL.md（~6K）是 agent 自身的 system prompt，**每 fire 必付、fast-path 省不掉**（它正是那份「叫你走 fast path」的指令）。
- conventions.md（~15.5K）+ lessons（~1.5K）是 boot **第 1、4 步用 Read 工具拉进上下文的**输入——**这才是 no-op 可省的部分**，单次 ≈ **~17K token**。
- 板 glob（frontmatter 扫描）无论 fast/full 都要做，**不是省点**，但 fast-path 版只读 frontmatter 不读正文，更轻。

---

## 1. 量化：107 次空跑烧了多少 token

### 单次 no-op boot 输入
- **可省部分（conventions + lessons）**：~17K token / fire。
- **全 boot 输入（含 skill system prompt + 板 glob）**：~22–27K token / fire（板越大越高）。

### 3 小时窗口总量
| 口径 | 每 fire | ×107 no-op | 量级 |
|---|---|---|---|
| fast-path 可省（conventions+lessons） | ~17K | **~1.8M token** | **百万级** |
| 含 skill system prompt 的空跑总输入 | ~23K | ~2.5M token | — |
| 全 121 fire 的 boot 输入合计 | ~22K | ~2.66M token | — |

### signal / noise
- **fire 层**：107/121 = 88% 空跑（0 产出）；仅 ~14 fire（12%）产出全部 13 commit。
- **boot-input 层**：~2.66M token 花在 boot 上，其中 noise（107 空跑）≈ **2.35M（88%）**，signal（~14 productive）≈ 308K（12%）。**S/N 完全复刻 fire 空跑率。**
- **input↔product 比**：13 commit 的正文产出粗估 ~50K output token；整窗 boot 输入 ~2.66M ⇒ **boot 输入 : 产品输出 ≈ 50:1，其中 88% 是纯空烧。**

### 两个 100% 空跑 agent 独占过半浪费
episode-writer 29 fire + reviewer 26 fire = **55 fire 全 no-op**。55 × ~17K ≈ **~935K token**——
**可省浪费的一半以上，来自这两个 lane 谓词最简单的 agent**（见 §3 第 3、4 条）。

---

## 2. 根因是 boot 顺序：先付 41KB，第 5 步才知道「没活」

现状 §0 标准 boot 六步：**① 读 conventions（15.5K）→ ② 读 config → ③ 确认 backend → ④ 读 lessons → ⑤ 报告结算 → ⑥ 开场行**，
而**真正的「我 lane 里有没有活」判定（Job 0 / Step 1 拾取）发生在六步全跑完之后**。
于是每个空跑 fire 都**先付满全额 boot，才发现无候选票**。

更讽刺的是：evaluator（Job 0 = `Todo+milestone-eval` 无匹配即 no-op）、script-doctor（`episodes/` SHA change-gate）、
market-watch（周频 cadence gate）**本来就有廉价 no-op 判据**——但它们**排在 conventions 读之后**，所以照样先付 15.5K 才 no-op。
**判据存在，只是站错了位置。**

### 设计：cheap no-op fast path（探针前置）

在 §0 boot **第 1 步之前**插入 **Step 0 — lane 探针**：

```
Step 0（fast path，先于任何 conventions/lessons/refs 读取）：
  a. 定位 config + board dir（只读 config.json，不读 conventions）
  b. glob board/tickets/*.md，仅解析 frontmatter
     (state / labels / owner / assignee / updated) + `Episode:` 机读行
     —— 不读正文、不读 lessons、不读 script-format/craft-rules/rubric
  c. 评估「本 agent 的最小 lane 谓词」（各 skill 内联，见 §3）
  d. 检查逃逸口（§4）：needs-* 求助 / 孤儿 In Progress / 报告结算到期 / 角色无条件义务
  e. 谓词空 且 无逃逸口 ⇒ 打印一行 no-op，退出，绝不读 conventions/lessons
     谓词命中 ⇒ 落入全 boot（读 conventions…），照常处理
```

**可行性论证——谓词稳定到可内联进 skill 第一步吗？成立，三条理由：**
1. **只依赖 §18 板 frontmatter schema**（id/state/owner/labels/assignee/priority + `Episode:`/`Design:` 机读行）。§18 是 backend 契约，是 conventions 里**最稳定**的一节；改它等于换 backend。
2. **谓词是纯集合成员判定 / 时间戳比较**——不涉及任何写作判断、genre 参数、rubric。它读的 state（§3 七态）与 label（§4）都是**枚举闭集**。
3. **谓词从不需要 craft-rules / script-format / evaluation-rubric**（那些是写作判断，只在落入 full boot 后才需要）。既然如此，「本 fire 尚未读 conventions」不影响谓词求值——**谓词自足**。

**建议在 §18 加一句 normative 声明**：「lane 探针读取的 frontmatter 字段（state/labels/owner/assignee/`Episode:`）由本节定义且稳定；skill 可内联自己的 lane 谓词，并在**未读 conventions 的本 fire** 上直接依赖它。」——这句话是 fast-path 的正当性来源。

**关键健壮性属性（单向安全）**：fast-path 谓词是**保守超集**——它宽到「lane 里有任何看似可拾的票」就落入 full boot。
episode-writer 的完整 §5 顺序前置（要查 repo main 上 `ep-(N-1).md` 是否存在、有无开放 Bug）**不进探针**；探针只用更弱的
「∃ 任一 Todo+episode-writer 票」。于是可能出现**假落入**（付了 full boot、跑完 §5 门发现仍 no-op），
但**永不假退出**（绝不在有活的 fire 上误退）。**误付满 boot 可接受；漏掉活不可接受**——探针刻意偏向前者。

---

## 3. 八/九个 agent 的最小 lane 谓词（各一条）

roster 实为 9 个 agent（简报「7 循环 / 8 条」——补全为 9，标注义务型）。谓词=「满足则落入 full boot，否则 cheap 退出」。

| # | agent | 最小 lane 谓词（仅 frontmatter/时间戳/1 次 git rev） | 纯 fast-path? |
|---|---|---|---|
| 1 | **episode-writer** | ∃ 票 `state=Todo` ∧ label⊇{episode-writer} ∧ ¬blocked（Backlog 暂存子票天然不可见 → 正确 cheap 退出）；**并** ∃ 孤儿 `In Progress`+本 tier+stale-token | ✅ 纯 |
| 2 | **reviewer** | ∃ 票 `state=In Review` ∧ owner=reviewer（Job A，每 fire 廉价查）**∪** ∃ `needs-reviewer` 票 **∪** `episodes/` SHA 变（Job C 主动审）**∪** 孤儿 In Review | ✅ 纯（含 1 次 git rev） |
| 3 | **story-designer** | ∃ 票 `state=Todo` ∧ label⊇{story-designer} ∧ ¬blocked **∪** ∃ `needs-designer` 提案票 **∪** 活跃账本 >15KB（滚存到期，1 次 stat）**∪** 孤儿 In Progress+本 tier | ✅ 纯 |
| 4 | **showrunner** | **doc-watch 无条件**：读 `north-star.md` 算哈希 vs 快照 → 变即落入。**∪** ∃ In Review+owner=showrunner **∪** ∃ `needs-showrunner` **∪** Backlog 有可放行票（autonomous） | ⚠️ **半**：doc-watch 每 fire 必跑（读 north-star ~数 KB），但哈希未变+队列空仍可跳 conventions |
| 5 | **evaluator** | ∃ 票 `state=Todo` ∧ label⊇{milestone-eval}（**已有此判据，只需前移到探针**） | ✅ 纯（最干净） |
| 6 | **market-watch** | `now − lastRun < 7d` ∧ `marketDataPath` 自 lastRun 无新内容 ⇒ 退出（读 `state/market-state.json`，**零板依赖**，已有 gate，前移即可） | ✅ 纯 |
| 7 | **script-doctor** | `episodes/` 末次 commit SHA == 上次审计 SHA ⇒ 退出（读 state 游标 + 1 次 git rev，已有 gate，前移即可） | ✅ 纯 |
| 8 | **reflect** | 无新 commit（1 次 git log）∧ 无票 `updated` 晚于上次 retro 窗（frontmatter 时间戳扫描）⇒ 退出 | ✅ 纯 |
| 9 | **sweep** | ∃ 票（缺/错 owner 或 tier label）∨ ∃ 孤儿 In Progress(stale>60min) ∨ ∃ 陈旧信号——sweep 的「找活」本身**就是** frontmatter 异常扫描，等价于探针 | ✅ 纯（探针即工作） |

注：evaluator/market-watch/script-doctor **已经有 no-op 判据**——本设计对它们不是「新增判据」，而是**把已有 gate 从 boot 之后移到 boot 之前**，让 no-op 不再先付 15.5K。

---

## 4. 风险：fast path 会漏掉「看似没活其实有活」吗？逐一堵

fast-path 的正确性风险全在**「常规拾取序看不见、但确实是活」**的四类。探针谓词必须显式包含它们，否则会误退：

| 陷阱 | 为何常规查询漏 | 探针必须包含的逃逸口 |
|---|---|---|
| **needs-\* 求助票** | needs-* 票带 `blocked`，被 §5 拾取序排除；但它对**接收方**（showrunner/reviewer/story-designer）是最高优进件 | 探针谓词并上「∃ 本角色 `needs-*` label 的票」（见 §3 表 2/3/4 已含） |
| **孤儿回收** | 崩溃 fire 遗留的 `In Progress` 不在 Todo 拾取序里；但需被重置回 Todo | 探针并上「∃ `In Progress`+本 tier+assignee stale>60min」——仍是 frontmatter，天然属探针（见 §3 表 1/2/3/4/9） |
| **报告结算（§22 boot 步 5）** | 到期 daily/weekly 汇总 + 未分发 `*.review.md` 点评是**时间/文件驱动**，不落在板上 | 探针查「本角色有到期 weekly digest？」（state 时间戳）+「reports/ 有未分发 `*.review.md`？」（1 次 glob）。§22 已豁免「纯 no-op 不写 daily」，故 daily 不构成义务；但**到期 weekly + 待分发点评**必须落入 |
| **showrunner doc-watch** | 操作者改 `north-star.md` 时可能**尚无任何板票**——纯板探针看不到 | showrunner **不得**纯 fast-path 退出：每 fire 无条件读 north-star 算哈希（廉价），仅当哈希未变**且**其余队列空才跳 conventions |

**明确标出「即使无票也必须做每-fire 义务、不能纯 fast-path」的角色：**
- **showrunner**：`doc-watch`（north-star 哈希比对）无条件每 fire——它是操作者进件的唯一非板通道。→ 给它「cheap boot」而非「cheap exit」：省 conventions，但保留 north-star 读。
- **任何到期报告结算方**（reflect / showrunner 及被点评者）：weekly digest 到期或有待分发点评时，探针须落入结算路径。

**reflect 的「证据收集」不是陷阱**：reflect 在「什么都没变」时**本就该 no-op**（无证据可收）；其谓词（新 commit ∨ 新转态）已覆盖——只要有它未消化的转态就落入，不会漏。

---

## 5. 与 dispatch 层（work-gated dispatch，另一视角）的关系：**纵深防御，互不取代**

| | dispatch 门（launcher/phase-driver） | boot fast-path（本设计） |
|---|---|---|
| 守的边界 | 「**要不要 spawn 这个 agent 进程**」 | 「已被 spawn，**能不能在昂贵读取前退出**」 |
| 省的成本 | 整个 fire：进程冷启 + skill system prompt(~6K) + 模型 spin-up | conventions+lessons(~17K)，省不掉 skill/进程 |
| 准确性 | **粗、可能错**：用「片刻前」的板快照决策，存在竞态（决策后活才出现 / 快照陈旧） | **ground-truth 精确**：§0 要求每 fire 从头重读真相，不信任任何先前快照 |
| 落点 | 外部编排（cron/launcher），blast radius 大 | 本地（conventions §0 + 各 skill），可独立 ship |

**结论：两者组合，缺一不可。**
- fast-path **不被 dispatch 取代**：即便 work-gated dispatch 完美，dispatch 用的是**片刻前的近似**；fast-path 是**fire 时刻的真相校验兜底**，专治 dispatch 的竞态误判（dispatch 说有活、fire 时活已被别的 fire 抢走 → fast-path 廉价退出，而非付满 boot）。dispatch 完美时 fast-path 极少触发，成本近零；dispatch 简陋/缺失时 fast-path 仍把残余空跑压到近免费。
- fast-path **不取代 dispatch**：它省不掉进程 spin-up + skill system prompt(~6K/fire) + 板 glob；**只有 dispatch 能避免 spawn 本身**。
- **落地次序**：fast-path 是**本地、可独立先行**的改动（不动 runner），能立刻回收大头（§1：~90% 空跑达成 cheap 退出 ⇒ 约 **~1.5M token** 单靠 fast-path 就能省下，无需任何 launcher 改动）。dispatch 是后续的外层优化。

---

## 6. 这是 loop-design 改动：具体落点

改 **conventions §0 + 各 skill boot 段**（不改 code、不改 rubric）：

**A. `references/conventions.md` §0「标准 boot 序列」——重构为七步（新增 Step 0）**
- 现「六步」前插入 **Step 0 — 廉价 lane 探针（no-op fast path）**：定位 config+board → glob frontmatter → 求本 agent 内联谓词 → 查四类逃逸口 → 空则一行 no-op 退出（**不读 conventions/lessons/refs**），否则落入原六步。
- 原步骤顺延（读 conventions / config / backend / lessons / 报告结算 / 开场行）。

**B. `references/conventions.md` §18——加一句谓词稳定性声明**（见 §2）：授权 skill 内联 lane 谓词并在未读 conventions 的本 fire 直接依赖 §18 字段。

**C. `references/conventions.md` §22——澄清 fast-path 与报告结算的边界**：no-op 退出可跳 daily 行（§22 已有豁免），但**到期 weekly digest + 待分发 `*.review.md`** 是 Step 0 逃逸口，须落入结算。

**D. 各 `skills/<agent>/SKILL.md` 的「0. 先读规则(boot)」段——每个 prepend「Step 0 — lane 探针」块**，写死该 agent 的 §3 谓词 + §4 逃逸口。
- 最大且最干净的两处：**episode-writer**（谓词=∃Todo+本tier ∨ 孤儿）、**reviewer**（谓词=∃In Review+owner:reviewer ∨ needs-reviewer ∨ SHA变 ∨ 孤儿）——这两个 100% 空跑 agent 一落地就回收 §1 的 ~935K。
- **evaluator / market-watch / script-doctor**：把**已有的** Job 0 / cadence-gate / SHA-gate 判据**提到 Step 0**（前移，非新增）。
- **showrunner**：标注为「cheap boot 而非 cheap exit」——doc-watch 保留、conventions 可跳。

**E.（可选）§21 加一行**：声明观察型角色的既有 gate（evaluator/doctor/market-watch）**即** Step 0 fast-path 的实例，统一心智模型。

---

## 附：一句话

**boot 顺序把 15.5KB 的 conventions 读放在「判断有没有活」之前，是这套 88%-空跑循环里最纯粹的可省浪费。**
把一个只读 frontmatter 的廉价 lane 探针前置到 boot 第 0 步——谓词自足、单向安全（永不误退）、本地可独立 ship——
单靠它就能从 107 次空跑里回收约 1.5M input token，且与 work-gated dispatch 正交互补（纵深防御，互不取代）。
