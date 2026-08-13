# Story design authority v1

`story/outline.v1.json` 是季结构、arc、节拍和分集设计的**唯一事实源**。Story Designer、
Showrunner、Evaluator、Studio 与确定性质量门直接读取它；不存在平行的 `outline.md` 或
`arcs/*.md`。它不能含原著正文或对白草稿。

可复用剧情事实、双轨时间线与选择性 Harness context 不放在本文件，统一进入
[`story/assets.v1.json`](story-assets-schema.md)。outline 是结构权威，assets 是事实/路由权威；
人物与场景身份必须精确一致，二者以 `storyDesignSha256` 绑定。

正常操作者不手工创建或维护它。Story Designer 在 source-analysis 通过后写入；Studio 直接
把结构渲染成人读视图，Showrunner 和 Evaluator 用 `writing-loop story validate` 独立重验。

## 顶层契约

顶层字段必须精确为：

```json
{
  "version": 1,
  "kind": "writing-loop/story-design",
  "title": "剧名",
  "sourcePlanId": "wlsrc_... 或原创项目为 null",
  "parameters": {
    "totalEpisodes": 60,
    "maxPrimaryScenes": 4,
    "maxNamedCharacters": 18,
    "maxBeatGap": 8
  },
  "adaptation": {
    "mode": "extract-core",
    "core": "只描述本项目提炼后的核心引擎",
    "keep": [{ "item": "保留项", "reason": "原因", "sourceRefs": ["chunk-0001"] }],
    "cut": [{ "item": "删除项", "reason": "原因", "sourceRefs": ["chunk-0002"] }],
    "merge": [{ "item": "合并项", "reason": "原因", "sourceRefs": ["chunk-0003"] }],
    "risks": [{ "item": "相似性/史实/制作风险", "reason": "处置", "sourceRefs": ["chunk-0004"] }]
  },
  "characters": [],
  "scenes": [],
  "beats": [],
  "episodes": []
}
```

- `adaptation.mode`: `faithful | extract-core | reimagine`。
- 改编项目的 `sourcePlanId` 必须与 source-intake manifest 精确一致；决策必须引用已分析的
  chunk/聚合表，不得把模型猜测冒充原著事实。原创项目为 `null`。
- `parameters` 必须与项目 config/North Star 一致；JSON 不能自行扩大集数、角色或场景预算。

## Characters / scenes / beats / episodes

角色精确字段：`id/name/tier/role/arc/sourceRefs/firstEpisode/lastEpisode`。`tier` 只能是
`lead | support | functional`；功能角色可以 `arc:null`，不要为填表硬造人物弧。ID 是稳定 ASCII
标识，改名不应让分集引用失效。

场景精确字段：`id/name/primary/variantOf/reusePlan/productionNotes`。一次性使用的场景必须写
`reusePlan`；`variantOf` 显式表达同一空间的时代、天气或状态变体。Studio 的美术资产页只从这里
派生，禁止模型另写会漂移的场景 registry。场景进入 Blender 灰模与关键帧制作后，生产状态进入
[`visual/production.v1.json`](visual-production-schema.md)；该清单只能引用 scene ID，不能复制剧情事实。

节拍精确字段：`id/episode/weight/label/setup/payoff`。`weight` 为 `major | minor`；主节拍之间
不能超过 `maxBeatGap`。

分集精确字段：

```json
{
  "number": 1,
  "arc": "单元名",
  "synopsis": "叙事事实，不写对白",
  "hookType": "H1",
  "hook": "结尾改变了什么",
  "suspense": "观众接下来追问什么",
  "agency": "active",
  "beatIds": ["B01"],
  "sceneIds": ["S01"],
  "characterIds": ["C01"],
  "crowdPlan": null
}
```

`hookType` 为 `H0..H7`；`agency` 为 `active | reactive | passive`。四名及以上具名角色同集出现
时必须写 `crowdPlan`。结构字段出现角色冒号对白、引号对白会被 deterministic gate 拒绝。

## 分阶段质量门

```bash
writing-loop story validate --project KEY --stage skeleton
writing-loop story validate --project KEY --stage beats
writing-loop story validate --project KEY --stage full --json
```

- `skeleton`: 参数/provenance、改编处置、角色 tier、场景预算/复用。
- `beats`: ID 与引用闭合、主节拍密度和叙事死区。
- `full`: 集号连续、资产引用、钩型组合、群戏调度、禁止提前写对白。
- `skipped` 表示阶段未到，不能计作 pass；`not-applicable` 与 pass 也必须视觉区分。
- `J01` 永远保留给 Showrunner 的“合规但平庸”人工否决。机器全绿不代表创作批准。

`writing-loop story status --project KEY --json` 和 Studio `/api/projects/KEY/story` 使用同一个
本地只读模型。它们不会调用模型、读取原著正文或启动 GPU/H3。

`writing-loop story validate` 同时验证 outline 与 assets；`writing-loop story context --project
KEY --ticket ID --agent AGENT --json` 生成有界、可复现、ticket-scoped Context Pack。

## 单一事实源门

下列旧路径一旦存在，S00 必须失败且 scheduler 不得进入分集写作：`outline.md`、
`bible/characters.md`、`bible/world.md`、`ledgers/foreshadow.md`、
`ledgers/story-state.md`、`ledgers/production.md`。Git 历史负责审计，不用 Markdown 镜像存副本。
