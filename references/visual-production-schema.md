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
  "scenes": []
}
```

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

## 《玉京旧事》试点

第一轮只把 `S01` 排入 `planned`：三个 9:16 固定机位、阴天日景/烛火夜景、寒门基础陈设。先在本地
Blender 输出灰模与空间通道；不启动 H3/GPU。通过跨机位连续性审核后，再为 `S02/S03/S04` 建立
基础布景，并让 `S09/S10/S08` 复用已有几何做时代/状态变体。
