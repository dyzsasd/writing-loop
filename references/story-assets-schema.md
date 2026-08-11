# Story assets + Context Pack v1

`story/assets.v1.json` 是剧情事实与上下文路由的唯一机读资产图。它与
`story/outline.v1.json` 分工：outline 管季结构、节拍和逐集引用；assets 管可复用的
人物、世界、地点、组织、道具、场景、伏笔、连续性事实和时间事件。Markdown 仍是人读创作面，
但任何被资产图引用的 Markdown 都必须用相对路径、section anchor 与 SHA-256 绑定。

正常操作者不手填此文件。Story Designer 在同一 Git commit 中同步 JSON 和 Markdown；
Showrunner、Reviewer、Evaluator 与 Studio 都调用同一个 parser/resolver。

## 顶层

顶层字段必须精确为：

```json
{
  "version": 1,
  "kind": "writing-loop/story-assets",
  "project": "project-key",
  "sourcePlanId": "wlsrc_... 或原创为 null",
  "storyDesignSha256": "story/outline.v1.json 的精确字节 SHA-256",
  "revision": 1,
  "assets": [],
  "timeline": []
}
```

不得把原著路径、原文或任意本地/网络 URL 填入资产。`sourceRefs` 只接受结构化 provenance：
`src:`、`north-star:`、`ticket:`、`episode:`、`design:`、`original:`。Markdown path 只允许
项目内 `bible/`、`arcs/`、`ledgers/`、`episodes/`、`source/` 下面的 `.md`，或
`outline.md` / `north-star.md`；禁止 `..`、symlink、特殊文件和 hash 漂移。

## Asset

每项字段必须精确为：

```json
{
  "id": "C01",
  "type": "character",
  "label": "角色名",
  "status": "active",
  "importance": "core",
  "episodes": { "first": 1, "last": 60 },
  "summary": "只写结构化摘要，不写原文或对白",
  "sourceRefs": ["src:chunk-0001"],
  "facts": [{
    "id": "F_C01_GOAL",
    "key": "goal",
    "value": "建立可校验的制度",
    "state": "current",
    "basis": "original",
    "sourceRefs": ["north-star:core"]
  }],
  "relations": [{ "kind": "rival", "targetId": "C02" }],
  "markdown": { "path": "bible/characters.md", "sha256": "<64 hex>", "anchor": "角色名" },
  "context": { "agents": ["episode-writer", "reviewer"], "priority": "required" }
}
```

- `type`: `character | world | location | organization | object | scene | foreshadow |
  continuity | episode`。
- `status`: `draft | active | resolved | retired`；retired 不进入新 pack。
- `facts.state`: `current | planned | disputed | resolved`。同一 asset/key 不能同时出现两个不同的
  current/planned 值；真实分歧必须显式用 disputed。
- `facts.basis`: `source | inferred | original`，禁止把推断伪装成原著事实。
- relation target 必须存在且不能自指。人物与场景的 ID、名称、集数范围必须与 outline 精确一致。

## 双轨时间线

```json
{
  "id": "T01",
  "label": "未来听证开场",
  "chronologyIndex": 20,
  "storyTimeLabel": "新历三十年",
  "reveal": { "episode": 1, "order": 1, "mode": "flashforward" },
  "summary": "史官打开封存档案。",
  "assetIds": ["C02", "S01", "F01"],
  "sourceRefs": ["north-star:frame"]
}
```

`chronologyIndex` 是故事世界真实顺序；`reveal.episode/order` 是观众揭示顺序，mode 为
`linear | flashback | memory | flashforward | offscreen`。二者不得混成一个排序字段。
ID、chronologyIndex 和 episode/order 均唯一，assetIds 必须闭合。full gate 要求每集至少一条
reveal event，Studio 以左右双轨展示。

## Ticket-scoped Context Pack

```bash
writing-loop story context --project KEY --ticket WL-12 --agent episode-writer --json
```

命令从 ticket frontmatter/body 自动取得 agent 权限与 Episode，不接受调用方自行注入 asset
路径。resolver 加载本集 outline 人物/场景、该 agent 的 required 资产、一跳关系、当前集
timeline 及相关前置事件；按稳定顺序填入默认 64 KiB（可配置 4–256 KiB）预算。输出包含
catalog/design SHA、选择原因、omitted IDs、实际字节和稳定 digest。

required asset 或本集 timeline 放不进预算、引用不闭合、事实冲突、Markdown 漂移、ticket 未授权
当前 agent 时硬停。绝不回退成全文扫 bible/ledger，也不把原著正文放入 pack。票里的 Markdown
`## Context-pack` 仅是人读预览，不能替代这份确定性输出。
