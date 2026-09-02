# Blender previs + Visual production v1

`visual/production.v1.json` 是场景进入美术制作后的唯一机读清单。它不复制剧情资产：场景 ID、名称、
变体和复用计划仍由 `story/outline.v1.json` 决定；本文件只记录 Blender 布景、固定机位、渲染通道、
生图候选和人工批准图片，并以 `storyDesignSha256` 精确绑定当前故事版本。

Writing-loop 剧本 agents 不会自动创建 `.blend`、调用 ComfyUI 或启动 GPU。清单由后续视觉制作工具或
人工制片流程维护，Studio 只读展示。大型 `.blend`、EXR、PNG 和视频不进 JSON/Git，必须先存入
操作者批准的本地内容寻址资产库，再以不可变 `AssetRef` 登记。

## 处理链

```text
outline sceneId
  → Blender blockout + fixed cameras
  → clay/depth/normal/lineart/object-mask/pose/motion-vector
  → pinned still-image workflow
  → candidates
  → human approval
  → approved AssetRef
  → optional H3 first/last/reference input
```

H3 v1 不直接消费 Blender depth/normal。约束图用于生成稳定关键帧；只有批准图片才能成为后续 H3
输入候选。`approved` 不会自行 enqueue H3，也不代表视频 QC 已通过。

## 顶层

```json
{
  "version": 1,
  "kind": "writing-loop/visual-production",
  "project": "project-key",
  "storyDesignSha256": "story/outline.v1.json 的精确字节 SHA-256",
  "revision": 1,
  "defaults": {
    "coordinateSystem": "blender-z-up",
    "unitScaleMeters": 1,
    "renderEngine": "eevee",
    "imageWorkflowProfileId": null
  },
  "scenes": [],
  "subjectReferences": []
}
```

`subjectReferences[]` 是纯新增的可选字段：旧清单缺该键时按空数组解析，既有文件不因 schema 增长失效。

## Scene production

每项场景只能引用 outline 中已经存在的 `sceneId`，不能写 `name`、剧情摘要或第二份 `variantOf`。

```json
{
  "sceneId": "S01",
  "phase": "planned",
  "blendAsset": null,
  "geometryRevision": 0,
  "cameras": [{
    "id": "CAM_EST",
    "label": "院门建立镜头",
    "lensMm": 28,
    "sensorWidthMm": 36,
    "aspectRatio": "9:16",
    "transform": null
  }],
  "lightingStates": [{ "id": "LIGHT_DAY", "label": "阴天日景", "notes": "软光保留屋檐层次" }],
  "dressingVariants": [{ "id": "DRESS_BASE", "label": "寒门时期", "notes": "基础陈设" }],
  "renders": [],
  "candidates": []
}
```

阶段固定为：

- `planned`：允许尚无 `.blend`；只登记试点目标和计划机位。
- `blockout`：必须登记 `application/x-blender` AssetRef 和 `geometryRevision >= 1`。
- `passes-ready`：至少一个渲染通道已入库。
- `keyframe-review`：至少一张带 workflow/model/prompt digest 与 seed 的候选图片。
- `approved`：至少一张候选图由人工标成 `approved`。

候选图必须绑定一个精确的机位、灯光状态和陈设版本；引用的所有 render IDs 必须属于同一组合，且
至少有一个 `depth | normal | lineart` 空间约束。`approved/rejected` 还必须登记 `reviewedBy` 与
canonical UTC `reviewedAt`，pending candidate 两项必须为 `null`。这样 Blender
不是一张一次性参考图，而是每次生成都可复验的几何来源。raw prompt、raw workflow、模型路径、任意
URL、远程凭据和绝对本机路径都不属于 schema。

候选图可选带 `shotIds: []`：该候选图可作首帧的镜头（候选图按机位 × 灯光 × 陈设登记，逐镜首帧按
shotId 取用）。一个 shotId 只能被一张候选图占用，跨场景亦然——镜头只属于一个场景，重复即配置错误。
缺该键时按空数组解析。

候选图还可选带 `containsRealFace`：该图是否含真人人脸（§4.7 `provider-likeness-policy`）。缺该键时
解析为 `true`，与 gate 的 `undeclared` 同一 fail-closed 语义——未声明不等于不含。Blender 约束图生成
的关键帧显式写 `false`。`plan-shots` 按 `shotIds` 自动填首帧时，把这一位原样带进 ShotRequest；排到某镜
但尚未批准（`status` 仍是 `candidate`）的候选图不填首帧，只在该镜的计划里记一条 `source: visual` 的
warning。人工已写死 `continuity.firstFrame` 的镜头不被覆盖。

候选图与 render pass 的绑定约束（`validateVisualProduction`）：候选图引用的每个 render 必须与它自己的
`(cameraId, lightingStateId, dressingVariantId)` 完全一致，且其中至少有一个 pass 属于
`depth | normal | lineart`；同一 `(camera, lighting, dressing, pass)` 组合的 render 不得重复登记。

## 候选图批准轨道

```bash
writing-loop visual approve-candidate --project KEY --candidate ID --by WHO [--reject] [--json]
```

命令只更新该候选图的 `status` / `reviewedBy` / `reviewedAt`（canonical UTC，取执行时刻），不渲染、
不连接 ComfyUI、不 enqueue 任何制片任务。约束两条：

- 只有 `keyframe-review` 阶段的场景可以裁决——`passes-ready` 尚无候选图可评，`approved` 已经定稿。
- 已有裁决的候选图不接受第二次改判：审批是事实登记，不是可覆盖的字段。确需改判时人工把该候选图的
  `status` 改回 `candidate` 并把 `reviewedBy` / `reviewedAt` 清为 `null`，再重新裁决。

`compileShotRequest` 的 `approvedCandidates` 由本文件的 `candidates[]` 装配（键为候选图 ID，值为
`{sha256, status, reviewedBy, reviewedAt}`）；`firstFrame.origin.kind = approved-candidate` 时编译器
据此校验候选图已批准且 sha256 命中。

## 定妆参考（`subjectReferences[]`）

```json
{
  "id": "REF_C01_ARC1",
  "subject": { "kind": "character", "characterId": "C01", "appearanceStateId": "APPEARANCE_EARLY" },
  "asset": { "version": 1, "uri": "…", "sha256": "…", "byteLength": 1234, "mediaType": "image/png" },
  "containsRealFace": false,
  "approvedBy": "operator:demo",
  "approvedAt": "2026-08-13T09:00:00.000Z"
}
```

`subject` 是判别联合：`{kind: "character", characterId, appearanceStateId}` 或
`{kind: "prop", objectId, stateId}`。ShotRequest 的 `references[].subjectId` 引用这里的 `id`。
`approvedBy` 与 `approvedAt` 同生同灭（只有一半即无法追责），两者都为 `null` 表示尚未批准。
`story/assets.v1.json` 不改：这里只登记不可变 AssetRef 与人工批准事实，不复制剧情设定。

## `visual/mappings.v1.json`

编译器不解析散文。灯光与陈设按两张机读表取值；文件不存在时视为空表，存在但损坏时硬错。

```json
{
  "version": 1,
  "kind": "writing-loop/visual-mappings",
  "project": "project-key",
  "lighting": [{ "sceneId": "S01", "timeOfDay": "day", "lightingStateId": "LIGHT_DAY" }],
  "dressing": [{ "sceneId": "S01", "arcId": "ARC_EARLY", "dressingVariantId": "DRESS_BASE" }]
}
```

`timeOfDay` 取 `day | night | dawn | dusk`（与 ShotRequest 同一枚举）。同一 `(sceneId, timeOfDay)`
或 `(sceneId, arcId)` 只能落一个状态：两条冲突的映射等于没有映射。

## `visual/prop-states.v1.json`

`props[].stateId` 的注册表：每个道具的已登记状态集合，以及 `(episode, sceneId) → stateId` 的排期。
`compileShotRequest` 的 `propStates` 取每个 `objectId` 的已登记 stateId 集合；镜头引用未登记的状态
即 `prop_state_missing`。

```json
{
  "version": 1,
  "kind": "writing-loop/visual-prop-states",
  "project": "project-key",
  "objects": [{
    "objectId": "O01",
    "states": [{ "stateId": "O01_CLOSED", "label": "木匣闭合", "notes": "初始状态" }],
    "timeline": [{ "episode": 1, "sceneId": "S01", "stateId": "O01_CLOSED" }]
  }]
}
```

`timeline` 只能引用同一道具已登记的 `stateId`，同一 `(episode, sceneId)` 不得出现两条。

## 《玉京旧事》试点

第一轮只把 `S01` 排入 `planned`：三个 9:16 固定机位、阴天日景/烛火夜景、寒门基础陈设。先在本地
Blender 输出灰模与空间通道；不启动 H3/GPU。通过跨机位连续性审核后，再为 `S02/S03/S04` 建立
基础布景，并让 `S09/S10/S08` 复用已有几何做时代/状态变体。
