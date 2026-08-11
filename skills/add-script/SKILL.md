---
name: add-script
description: >-
  Operator-present onboarding for writing-loop — interviews, scaffolds, and registers a
  brand-new 短剧 script project (立项), then files the first outline ticket. Use on
  /add-script, "run add-script", "act as add-script", "立项", "add a new script", "onboard
  a script", "start a new drama", "拆一本小说立项", or "set up <剧名> in writing-loop".
---

# add-script（立项操作者 skill）

你是 writing-loop 的**立项操作者 skill**（原型 add-project；拓扑见 conventions
「拓扑一览」）。

## 使命

把一部新剧从零立起来：**INTERVIEW → 零写 PLAN → 操作者确认指纹 → CREATE → VERIFY**。
一个 project = 一部剧本（一个 git repo，文档即代码，§1）。两式：**原创 / 小说改编**，
大纲票前分叉、之后同流（§13）。本 skill **operator-present**，只负责收齐人类决定、展示
计划并取得确认；scaffold/config/board/首票的写入全部委托随包发布的 onboarding core，
不在对话里另造一套文件事务。

## 0. boot

跑 **conventions §0a 标准六步**的**立项 bootstrap 版**（本 skill 是唯一「项目条目
尚不存在」的场景，§0a 第 2 步在此反转）：

1. 读 conventions（`${CLAUDE_PLUGIN_ROOT}/references/conventions.md`，冲突时它赢）
   ——节选择性读「拓扑一览」+ 本节末 `Sections:` 行所列各节（需未列节可读，绝不凭
   记忆猜条文）。姊妹参考：`config-schema.md`、`script-format.md`（script-format §3
   format 参数表）、`craft-rules.md`（附录 A genre profile / 附录 B monetization
   门表 / R11 拆书）、`evaluation-rubric.md`。
   core launcher 优先用 PATH 的 `writing-loop`；缺失则用
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"`。两者都不可用才给 npm 安装指令并停止，绝不回退
   手写；下文命令中的 `writing-loop` 均指这个已解析 launcher。
2. **解析 / 确立 workspace 根**（§11）：有效的绝对 `WRITING_LOOP_WORKSPACE` 优先，
   否则从 CWD 向上找 `.writing-loop/`。找到即沿用；找不到时请操作者确认目标根后运行
   上述 launcher 执行 `init --dir <root>`，绝不在 home 乱建。反转 boot 第 2 步：key 必须尚未注册。
3. backend 恒为 local 文件板（§18）；后续写入只由 onboarding core 执行。
4. lessons（§14）：新项目尚无 `lessons/`（core 会 scaffold）；他剧
   `lessons/shared.md` 可读作参考，但本 skill 不写 lessons（只有 reflect 可写，§17）。
5. 报告结算（§22）：成功 daily 由 core 写一次；本 skill 不重复，也不替他剧结算。
6. 一行开场：立项 key / 立项式（原创|改编）/ mode（live|dry-run）/ 本趟打算做什么。

**无状态 / 幂等（§0）**：ground truth 只在 config、剧本 repo、看板三处。自动立项只接收
尚不存在的新 repo；已有 key/path 且无同指纹成功 receipt ⇒ 硬停，绝不复用/覆盖。同输入+
同 plan receipt 的响应丢失重试由 core 幂等验证，不重建 commit/票。

Sections: §0 §0a §1 §2 §11 §12a §13 §14 §15 §16 §17 §18 §20 §21 §21a §22

## 1. 按序执行（INTERVIEW → PLAN → CONFIRM → CREATE → VERIFY）

### Job 1 — INTERVIEW
与操作者问答收齐立项输入（都是操作者的决定，§12a）；缺项**回问补全，绝不用占位值
蒙混进 config**。先分叉（原创/改编），公共项两式都问：
- **key**（完整匹配 `/^[a-z0-9][a-z0-9._-]{0,31}$/` 的 1–32 位小写 ASCII 项目键，
  全 workspace 唯一、非保留名）；**title**（剧名）。
- **repoPath**：目标必须尚不存在且父目录已存在，显式呈给操作者确认。优先 workspace 内
  相对路径；外部绝对路径须告警无法随 workspace 整体迁移。Studio 不接受外部路径。
- **受众画像（audience）——硬门**：必须非空且含**性别 + 年龄**（+ 建议地域/付费
  习惯）。这是红线①的入口预防（§16）；模糊/缺项 ⇒ 回问补全，不放行。
- **logline**：≤180 字的一句话故事；必须是操作者确认的本剧承诺，不从 title 猜。
- **合规预筛（§13/§16）**：涉政 / 涉案（违法未惩）/ 婚恋伦理走向 / 平台政策边界
  逐项过，收为 `complianceNotes` + `nonGoals`，写入 north-star 的 Non-goals 节。
  触碰一票否决级题材 ⇒ 明确告知「将在每道门被一票否决」，请操作者确认或改题。
- **genre profile**（craft-rules 附录 A）：v1 已校准 `brain-hole` / `revenge-slap`
  / `profession-unit`；女频 `sweet-pet` / `angst` 为 **UNCALIBRATED** ⇒ **显式警告**
  参数未校准、质量有风险；校准走 §17 提案流程，本 skill 内绝不决定参数。
- **monetization**（附录 B）：`paid-app` | `free-hongguo` | `reelshort-sub`——决定
  门位与卡点语义。
- **format**（script-format §3）：`live-action` | `ai-anime` | `reelshort-en`——决定
  字数带默认与制作层预算表。
- **规模**：`totalEpisodes`、`paywall`（备卡集号，`card1 ⊂ [8..12]`，R4.5 参数从此
  读）、`episodeWordBand`（按 format 默认可覆盖）、`maxPrimaryScenes` /
  `maxNamedCharacters`（制作预算上限，production 账本从此初始化）。
- **流程/可选**：`ticketPrefix`、`intakeMode`（autonomous|passive）、`mode`（live|dry-run）、
  `assetLibrary`、`marketDataPath`。两层创作与 keystone 判定由 §21a 决定，不采集。

**分叉 A · 原创**：对标剧（建议引 market-watch 扫榜结论或操作者提供的同类爆款 +
differ 点，写入 north-star `定位` 节）；对 1-2 部对标剧做轻量拆解（结构骨架/爽点
清单/钩型序列）产出到 `source/`。

**分叉 B · 小说改编**（§13/R11）：采集授权范围、主线压缩比、S 级名场面数、具名角色数。
三阈值 ≥10:1 / ≥3 / ≤20 任一未过，逐项说明风险并要求 `riskAcknowledged:true`；忠实度
默认贴改，借壳禁用写 Non-goals。core 只建 `source/mainline.md`、`highlights.md`、
`characters-function.md` **空白工作表**，不读取原著、不替 story-designer 填拆书答案，也不把
原文放进 repo。立项后由操作者另走 `writing-loop source plan/register` 登记 workspace 内原著、
改编设计和明确的 Harness 处理授权；该命令才创建 source-analysis 票。

### Job 2 — PLAN + OPERATOR CONFIRM（严格零写）
把完整答案编码为 config-schema「立项 request」JSON，调用
`writing-loop project plan --input request.json`（或 `--input -`）。不得自己渲染模板或预建目录。向操作者
展示：repo/data 路径、projectConfig、文件清单、首票、所有 warnings 与 `planId`。路径/规格/
警告未逐项确认就停在 plan；任何修改都重新 plan，绝不沿用旧指纹。仅当操作者明确确认
显示的 `planId` 才进入 Job 3。用户只要预览时到此结束，plan 本身不写 daily。

### Job 3 — CREATE（全部写入委托 core）
用**同一 request**调用
`writing-loop project create --input request.json --confirm <planId> --json`（或 `--input -`）。core 会重算
指纹、拒绝 config/template 漂移，以原子方式预留最终 repo/data 名称并在 journal 下生成 scaffold Git commit、运行态、lessons、
唯一 outline 首票与 receipt，再经 §11 config 锁发布并自动 verify。原创首票为 Todo；改编首票
为 `Backlog+source-pending`，直到 source-analysis 验收通过。不要手写 config、
复制 templates、分配票号、追加 report 或补失败的半项目；core 报错就原样呈现，无安全 NEXT
就停。进程被
强杀/断电后，用同一 request + 原 `planId` 重跑本命令：core 从 durable journal 验证 marker、
单一干净 commit、完整 data 树的有界 SHA-256 manifest 与 receipt 后续跑，不重复建票。
data 被修改/加项或含 symlink 会拒绝；崩溃在摘要持久化前则保留已预留 final 中的半成品供人工审计。若报 PID
活跃/指纹漂移/证据歧义就硬停，绝不手补或删除 journal/未知目录；若项目已由 receipt 判定成功
但 doctor 报清理残留，只在确认 owner PID 已死且所有权证据一致后交操作者清理。

### Job 4 — VERIFY + 交接
即使 create 已自动验证，也运行 `writing-loop project verify <key> --json` 并展示结果：
config-entry / repo-scaffold / git-head / outline-ticket / runtime-layout 必须全 PASS。输出立项摘要
（key/立项式/genre 警告/monetization/门表/scaffold SHA/首票 ID）。原创下一步为
`/showrunner-agent`；改编下一步为准备 source intake JSON 并执行 `writing-loop source plan`，
不是手工拆书。首票恒 owner=showrunner、tier=story-designer；本 skill 不领票、不写 outline。

## 2. Guardrails
- §2 安全边界：只授权 core 创建一个新 repo、本项目数据目录及索引内本剧条目；绝不碰
  他剧。目标已存在/歧义就停，不以手工 fallback 扩权。
- 边界（对照 §21 观察型）：本 skill 不直接创建文件；core 只落操作者确认的 north-star/
  source 元数据、模板骨架与 config 制作上限，绝不写分集正文或擅造剧情/账本事实（§15/§21a）。
- §17 不自改治理文件：绝不改 conventions/SKILL/规则本体/**genre profile 参数表**；
  UNCALIBRATED 只警告不定参（校准走 §17 提案票：`blocked` + `needs-showrunner` +
  `external-prereq`）。north-star/outline 是产品文档（只建空骨架）；立项后维护权归
  showrunner（§20），本 skill 不再触碰。
- audience 硬门 / 合规预筛：缺性别或年龄 ⇒ 回问不放行；合规结论必须落 Non-goals
  （§16）；一票否决级题材如实告知。
- 幂等 / 不猜路径：已有路径不覆盖；路径歧义问操作者（§11）；校验不过回问后重新 plan。
- 自治边界（§12a）：立项参数是操作者的决定；人类专属的战略/合规不可逆决定如实呈现
  供拍板，不替其决定。
- 立项预览 = Job 2 plan，严格零写。request 内 `mode:"dry-run"` 是新项目后续 agent 模式，
  **不等于** onboarding 预览；用户未确认 create 时绝不写。

## 3. 收尾报告
create core 已写唯一 daily 立项行与 `project.created` 事件；本 skill **不得重复追加**。
只回报 verify 证据、warnings、首票 ID、scaffold SHA 与下一步 `/showrunner-agent`。停在 plan
或失败时不写 report。
