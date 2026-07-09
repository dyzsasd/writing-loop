# 使用指南：从一部小说到一部剧本

[English](GUIDE.md) · **中文** · [Français](GUIDE.fr.md)

> 这是最重要的一份文档：从安装插件，到跑出第一份可交付/可投放的「一卡包」，
> 全流程手把手。默认走**小说改编**线；文末附**原创**线的差异。

---

## 前提

- 已装好 **Claude Code 或 Codex** CLI——两个皆可（安装命令见 README；本指南以 Claude Code 为例）。
- 本机有 `git`。
- 准备好小说的**纯文本**（`.txt` / `.md`；PDF/EPUB 请先转成文本）。

---

## 第 0 步：安装插件

在 Claude Code 里执行：

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

装好后你会有一组 `/writing-loop:*` 斜杠命令（9 个 agent + `add-script`）。

---

## 第 1 步：建剧本工程目录，放进小说

**workspace 与剧本 repo 的关系**：一个 **workspace** 是一个普通文件夹，里面放若干
**剧本 repo**（每部剧一个独立 git 仓库，“文档即代码”）+ 一个 `.writing-loop/` 运行时
状态目录（config + 看板 + lessons，由 `add-script` 自动创建）。**复制这一个 workspace
文件夹 = 整体迁移全部剧本 + 在制工单**（见文末「迁移」）。

下面 `~/dramas/` 就是你的 workspace，`my-drama/` 是其中一部剧的仓库：

```bash
mkdir -p ~/dramas/my-drama/source          # ~/dramas = workspace，my-drama = 剧本 repo
git -C ~/dramas/my-drama init
cp /path/to/你的小说.txt ~/dramas/my-drama/source/novel.txt
```

> 关键：小说文本必须落在剧本仓库的 `source/` 里——改编线的拆书就基于它。

在 Claude Code 里把工作目录切到这个剧本目录（`cd ~/dramas/my-drama`），再进入第 2 步。
（`add-script` 会把 `~/dramas/` 认作 workspace 根，并在其下建 `.writing-loop/`；首剧时会
先跟你确认这个根。）

---

## 第 2 步：立项（改编线）——一条命令跑完

```
/writing-loop:add-script
```

它会**采访你**（缺项会追问，绝不用占位值蒙混进 config）。改编线你要准备回答：

**公共必答项**

- **key**：项目键，小写（如 `my-drama`）——数据目录名 + 工单前缀 + config 键，全 workspace 唯一。
- **title**：剧名。
- **受众画像（硬门）**：必须含**性别 + 年龄**（建议加地域 / 付费习惯）。模糊或缺项会被拒绝放行——这是评估红线①的入口预防。
- **合规预筛**：涉政 / 涉案（违法未惩）/ 婚恋伦理 / 平台政策边界，逐项过一遍，结论写进 `bible/north-star.md` 的 Non-goals（长期约束，每道评估门都复检）。
- **genre profile**：`brain-hole`（脑洞爽剧）/ `revenge-slap`（复仇打脸）/ `profession-unit`（职业单元）已校准；女频 `sweet-pet` / `angst` 是 **UNCALIBRATED**，会明确警告你参数未校准、质量有风险。
- **monetization**：`paid-app` / `free-hongguo` / `reelshort-sub`（决定卡点与门位语义）。
- **format**：`live-action` / `ai-anime` / `reelshort-en`（决定字数带与制作层预算；ai-anime 特效近乎免费是形态优势）。
- **规模**：`totalEpisodes`、`paywall`（备卡集号，一卡 ⊂ 第 8–12 集）、`maxPrimaryScenes`、`maxNamedCharacters`。

**改编线专属（自动进行）**

- 原著文本已在 `source/` → 它做**选书检查表评估**（主线能否压到 ≥10:1、名场面密度、角色可压缩性），不达标会提示风险。
- 产出**拆书三清单**到 `source/`：`mainline.md`（主线骨架）、`highlights.md`（爽点名场面清单，IP 核心资产）、`characters-function.md`（人物功能表，压到核心 3–5 人 / 具名 ≤20）。
- **忠实度档位**：默认「贴改」；「借壳」默认禁用并写进 Non-goals。
- **版权边界**：以授权范围为准（记入 north-star），不混入其他 IP 可识别元素。

跑完后，`add-script` 自动：

- **SCAFFOLD**：生成 `bible/`（north-star / characters / world）、`outline.md`、`ledgers/`（foreshadow / story-state / production + archive/）、`episodes/`、`evaluation/`；`git commit`。
- **REGISTER**：在 `~/dramas/.writing-loop/config.json` 登记项目，建看板目录 `~/dramas/.writing-loop/my-drama/board/`，铺 `lessons.md` 骨架。
- **首张大纲票**：file 一张 outline 工单（owner=showrunner，tier=story-designer）。
- **VERIFY**：回读校验并告诉你下一步。

> `add-script` 采访时会问 mode——首次回答 `dry-run`，它只打印“会做什么”、不写盘不 commit。确认采访结论无误后，再跑一次 `/writing-loop:add-script` 回答 `live` 正式立项。

---

## 第 3 步：让编剧团队跑起来

每个 agent 是一条斜杠命令，**无状态**：每次运行都从看板 + 仓库重读真相，做本角色当下该做的事，没活就空转。它们**只通过工单交接**，你不用手动传递。

**第一轮（改编线的自然顺序）：**

```
/writing-loop:showrunner-agent       # 管方向、门禁、里程碑与后续放行（大纲票已由 add-script 直接 file 进 Todo——§5a 豁免，story-designer 直接可拾）
/writing-loop:story-designer-agent    # 读拆书三清单 → 写 outline.md + bible；再逐个 arc 写「逐集节拍单」
/writing-loop:market-watch-agent      # 带日期的题材窗口评估——大纲定稿门的市场层评分依赖它；缺数据时该项 inconclusive，红线类会人工停靠等你补
/writing-loop:evaluator-agent         # 大纲定稿门（市场层+内容层预评+合规）
/writing-loop:episode-writer-agent    # 按集号顺序写正文；keystone 集由 story-designer 亲写
/writing-loop:reviewer-agent          # 逐集独立审读（三分类 + 邻集对读 + 每条论断带原文引用），fail 走三级回炉
```

之后就是**循环推进**：`showrunner → story-designer → episode-writer → reviewer → evaluator → script-doctor`，反复轮转，直到里程碑。

**keystone 档位提醒**：keystone 集（前 3 集 / 卡点集 / 终局）的验收需要顶配档 reviewer——用 `opus`/`max` 跑 `/writing-loop:reviewer-agent`，否则该集会被跳过留待更高档 fire 并卡住流水线（sweep 会在板健康 digest 旗标提醒你）。

你不用记精确顺序——**看板会强制真实次序**：前一集没 Done 就写不了下一集；大纲没过门子票不放行；里程碑门用 `Blocked-by` 挡住越界生产。任何 agent 跑一次没事做，就报告“无活”并退出，你接着跑下一个即可。

**想自动化**（不想手动一条条敲）：用 `/loop` 让它按间隔轮转，或用系统 `cron` 定时点这些命令。因为每个 fire 无状态，随时开停都安全。

---

## 第 4 步：盯里程碑，第一批交付是「一卡包」

评估官在关键节点出报告（存到 `evaluation/`）：

| 门 | 触发 | 你能拿到什么 |
|---|---|---|
| 前三集微门 | ep3 完成 | 钩子强度体检（第 1 集反常识冲突、第 3 集首次高潮） |
| 大纲定稿门 | 大纲写完 | 市场层 + 内容层预评、合规、伏笔登记覆盖 |
| **一卡包（一卡门）** | 前 10 集完成 | **第一份真正可交付 / 可投放测试的成品**：Bible + 前 10 集 + 切片清单 + 完播率结构代理评分 |
| 卡二 / 卡三 / 完本门 | 中段 / 2/3 处 / 全剧完成 | 逐级评分，完本门给 S+~C 定级 |

**一卡门后是「操作者决策点」**——系统会停下等你拍板：拿一卡包去投放测数据，还是直接续产。这是你介入的主控点。

---

## 系统怎么找你（人机交互回路）

- **人工停靠票**：真正需要你决策的事（方向变更、一票否决、fix-exhausted、等投放数据）会以停靠票形式出现。配置了 `comms.provider` 时，系统会向带外通道推送一条通知（票 ID + 需要的决定）；未配置则每天看 daily digest 的 needs-attention 节（在 `~/dramas/.writing-loop/my-drama/reports/`）。
- **门后等待**：一卡门后系统停下等你决策，不会自行续产（见第 4 步）。
- **给某个 agent 反馈**：对它的某份报告写一个 `<报告名>.review.md` **兄弟文件**（与被点评的报告同在 `~/dramas/.writing-loop/my-drama/reports/` 目录）。该 agent 下次运行会把你的点评蒸馏进自己的 lessons 分节，长期改变行为。
- **评估报告**：在剧本 repo 的 `evaluation/` 里。

---

## 产物在哪 / 怎么看进度

- **正文**：`~/dramas/my-drama/episodes/ep-001.md …`
- **大纲与圣经**：`outline.md`、`bible/`
- **伏笔 / 状态 / 制作账本**：`ledgers/`（防割裂、防伏笔丢失的核心）
- **评估报告**：`evaluation/`
- **工单看板**（团队在忙什么）：`~/dramas/.writing-loop/my-drama/board/tickets/*.md`

> 运行时状态（config + 看板 + lessons + 报告）都在 `~/dramas/.writing-loop/` 里——它是
> **各剧本 repo 之外**的兄弟目录，所以工单状态**不会污染你的正文 git 历史**。

---

## 迁移：复制一个 workspace 就搬走全部

因为 config 用**相对 `repoPath`**、运行时状态就在 workspace 内，整体迁移只需复制这一个
文件夹（含在制工单）：

```bash
cp -r ~/dramas /new/place/dramas      # 剧本 + 大纲 + 账本 + 在制看板一起搬
```

- 用 **`cp`（不是 `git clone`）**：clone 只带单个剧本 repo 的创作成果，不带在制工单。
- 只想搬**已完成的创作成果**（不要在制调度状态）：`git clone ~/dramas/my-drama` 即可——
  每部剧本 repo 本身就自包含（bible / outline / ledgers / episodes 全在里面）。
- 别把 workspace 放到网络盘上多机同时写（会 race）；顺序复制迁移没问题。

---

## 一个最小示例（你实际会敲的东西）

```
# 1. 安装（一次）
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```
```bash
# 2. 建仓库放小说
mkdir -p ~/dramas/nanny-revenge/source && git -C ~/dramas/nanny-revenge init
cp ~/Downloads/百万打工嫂.txt ~/dramas/nanny-revenge/source/novel.txt
```
```
# 3. 立项（在 ~/dramas/nanny-revenge 目录下）——先 dry-run 看采访结论
/writing-loop:add-script
# 采访大致这样答：key=nanny-revenge，title=百万打工嫂的觉醒，
# 受众=女性 28-45 下沉市场付费用户，genre=revenge-slap，
# monetization=paid-app，format=ai-anime，totalEpisodes=40，一卡=第 10 集
```
```
# 4. 驱动团队（dry-run 确认结论后，再跑一次 add-script 答 live 正式立项，然后循环轮转）
/writing-loop:showrunner-agent
/writing-loop:story-designer-agent
/writing-loop:market-watch-agent
/writing-loop:evaluator-agent
/writing-loop:episode-writer-agent
/writing-loop:reviewer-agent
# …重复轮转，直到一卡门 → 决策点
```

---

## 两个提醒

1. **先 `dry-run` 再 `live`**——立项采访的结论（受众、genre、卡点位）会长期约束全流程，值得先核一遍。
2. **女频甜宠 / 虐恋是 UNCALIBRATED**——能跑，但节拍参数是暂定值，`add-script` 会警告；男频三类（脑洞 / 复仇 / 职业）有示例校准，质量最稳。

---

## 原创线的差异（不从小说出发时）

第 2 步的 `add-script` 采访走**原创分叉**：不需要原著文本，改为提供**对标剧**（+ 热度 + 我们 differ 在哪），系统对 1–2 部对标剧做轻量拆解（结构骨架 / 爽点清单 / 钩型序列）到 `source/`，供大纲阶段参考。其余步骤（第 3、4 步）与改编线**完全相同**——两条线只在大纲之前分叉，之后同流。

---

想直接看效果？把你手头的任一部小说文本给我，我可以实跑一遍
`add-script` + 第一轮，把真实产物（大纲、前几集、评估报告）生成出来。
