# Story design companion v1

`story/outline.v1.json` 是 `outline.md` / `arcs/*.md` 的严格机读伴随文件。Markdown 供编剧阅读，
JSON 供 Story Designer、Showrunner、Evaluator、Studio 与确定性质量门共享同一事实。它不是第二份
模型报告，也不能含原著正文或对白草稿。

正常操作者不手工创建或维护它。Story Designer 在 source-analysis 通过后写入，并在同一个 Git
commit 中同步人读大纲；Showrunner 和 Evaluator 用 `writing-loop story validate` 独立重验。

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
派生，禁止模型另写一份会漂移的场景 registry。

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
