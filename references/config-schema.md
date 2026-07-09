# 配置 schema（config-schema）

> writing-loop 的 workspace 索引与项目配置。运行时状态（board/lessons/reports）一律在
> 数据目录 `~/.writing-loop/`（可用 `WRITINGLOOP_DATA_DIR` 覆盖），**永不进剧本 repo**。

## workspace 索引 — `~/.writing-loop/config.json`

```jsonc
{
  "version": 1,
  "projects": {
    "shen-shou-park": {                    // project key（目录/板前缀作用域）
      "title": "女儿被抓去神兽公园，我觉醒神脉杀疯了",
      "repoPath": "/abs/path/to/script-repo",   // 剧本 repo（文档即代码）
      "backend": "local",                  // v1 仅 local（§18 文件板协议）
      "ticketPrefix": "WL",                // 板 ID 前缀；counter.json 的 hint
      "mode": "live",                      // live | dry-run（dry-run 不写板不 commit）
      "enabled": true,

      // —— 创作规格（north-star/outline 的机读镜像，agent boot 时读） ——
      "format": "live-action",             // live-action | ai-anime | reelshort-en（script-format §3 参数表；
                                           //   ai-anime 使用单列的制作层预算表——特效近乎免费是形态优势）
      "monetization": "paid-app",          // paid-app | free-hongguo | reelshort-sub —— 一级开关：
                                           //   free-hongguo：一卡门→前30集完播门，卡点断言→留存钩断言，
                                           //   rubric 付费转化项换成完播/留存；reelshort-sub：卡点平缓、打脸收敛
      "genre": "revenge-slap",             // genre profile key（craft-rules 附录 A；决定 R1-R6 数值参数集。
                                           //   v1 已校准：brain-hole | revenge-slap | profession-unit；
                                           //   女频 sweet-pet/angst 为 UNCALIBRATED——add-script 立项时显式警告）
      "audience": "男性 25-45 下沉市场付费用户",   // 非空且含性别+年龄（红线①入口预防）
      "totalEpisodes": 80,
      "paywall": {                         // 备卡制（R4.5 参数从这里读，不写死 9-11）
        "card1": [9, 10, 11],
        "card2": [26, 28, 30],
        "card3": [60]
      },
      "airedThrough": 0,                   // 已投放水位：ep≤此值的修订票机械转型为「前向修补」或 human-park，
                                           //   禁止追溯改已投放正文及其账本记录
      "episodeWordBand": [900, 1300],      // 按 format profile 默认，可覆盖
      "maxNamedCharacters": 20,            // production.md 预算账本的上限来源
      "maxPrimaryScenes": 5,
      "assetLibrary": null,                // 公司 AI 资产库清单路径（或 null=无）——rubric 资产复用度的打分输入
      "marketDataPath": null,              // 操作者投喂的市场数据目录（榜单快照/政策摘要）；market-watch 优先读取

      // —— 流程旋钮 ——
      "intake": {
        "mode": "autonomous",              // autonomous | passive（§5a：passive=纯用户驱动创作）
        "todoDepthCap": 10                 // 注意：episode 创作子票不计入深度（节流由顺序 pick 约束承担）
      },
      "comms": {                           // human-park / 一卡门操作者决策点的带外通知（照搬 dev-loop §9 notify）
        "provider": null,                  // "slack" | "lark" | null（null=仅 daily digest 的 needs-attention 节）
        "webhookEnv": null                 // 存 webhook 的环境变量名——config 本身不放秘密
      },
      "keystoneEpisodes": "auto",          // auto = 第1集 + 各卡点集±1 + 深谷集 + 终局3集；或显式数组
      "writerSplit": true,                 // true=story-designer/episode-writer 两层（默认）；false=单 writer

      // —— agent 档位覆盖（默认见 conventions 拓扑表） ——
      "models":  { "episode-writer": "sonnet" },
      "efforts": { "showrunner": "max", "story-designer": "max" }
    }
  }
}
```

## 数据目录布局 — `~/.writing-loop/<project-key>/`

```
board/
  counter.json          # { "prefix": "WL", "next": 42 }（hint；真相是 O_EXCL 独占创建）
  tickets/WL-1.md …     # 一票一文件：YAML frontmatter + 模板正文 + append-only 评论区（§18）
lessons.md              # §14 分节 lessons（per-operator，永不 commit）
reports/                # §22 daily/weekly/monthly + *.review.md 操作者点评
state/                  # agent 小状态（showrunner 的 lens 轮换、doctor 的 SHA 指纹等）
```

## 剧本 repo 内文档树（由 add-script scaffold；详见 conventions §19）

```
bible/{north-star,characters,world}.md   outline.md   arcs/
ledgers/{foreshadow,story-state,production}.md   ledgers/archive/（滚存目录）
episodes/   evaluation/   source/（改编立项）
```

（三个活跃账本 foreshadow/story-state/production + archive/ 滚存目录，§19 单一真相源。）

## 校验规则（add-script 写入前必须通过）
- `repoPath` 存在且是 git repo；board 目录专用（空或 writing-loop 脚手架）。
- `paywall.card1 ⊂ [8..12]`；`totalEpisodes` 与 format profile 惯例带一致（越界要求确认）。
- `audience` 非空且含性别+年龄要素（评估红线①的入口预防）。
- key 全 workspace 唯一；`ticketPrefix` 冲突时要求显式改名。
