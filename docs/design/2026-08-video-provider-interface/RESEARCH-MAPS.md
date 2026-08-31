# MAP vcs-arch

## 1. 剧本 → 分场 → 镜头 的可机读切分点

### 1.1 分场切分（已有确定性解析器）

`episodes/ep-NNN.md` 的结构由 `hub/src/script-lint.ts` 的纯函数解析器定义，可直接复用为 ShotRequest 生成器的前端：

- 场景头正则：`/Users/shuai/workspace/jinko/writing-loop/hub/src/script-lint.ts:51` `SCENE_HEADER_RE = /^(\d+)-(\d+)\s+(\S+)\s+(日|夜|晨|昏|黄昏|清晨|黎明|傍晚|午|夜半|拂晓)\s+(内|外|内外)\s*$/`，捕获组依次为 集号 / 场序 / 地点整段（可含「·子景」）/ 时段 / 内外。
- 动作行前缀 `:52` `^[▲△∆]`；对白 `:53` `^(角色)（情绪前缀）：台词`；调度单 `:54` `^人物[：:]`；集标记 `:55` `^第\s*(\d+)\s*集`；frontmatter 必填键 `:57`。
- 解析后的 `ScriptScene` 结构（`:14-26`）已含 `index / episode / location / timeOfDay / interior / roster[{name,count}] / speakers[{name,prefix,text,line}] / actionLines[]`，即分场级 ShotRequest 所需的全部剧本侧字段。
- 规范文本：`/Users/shuai/workspace/jinko/writing-loop/references/script-format.md:48-60`（正文语法）、`:64-71`（profile 数值约束：真人短剧单集 1-4 场，AI 漫剧 1-3 场）、`:81-95`（frontmatter）。

实例：`/Users/shuai/dramas/yujing-jiushi/episodes/ep-001.md:17` `1-1 未来玉京 日 外`，`:18` `人物：谢蘅秋（年长·背影）`；`:25` `1-2 沈家大院 夜 内`；`:43` `1-3 沈家大院 日 内`。`ep-030.md:17` `30-1 官署公堂·有司递表一角 日 内` 为「注册景名·子景」形；`:41` `30-2 沈家大院·李默宅寿宴 日 内`，调度单含 `东厂番役*4、宾客*40`。

### 1.2 全季统计（对 60 集 ep-NNN.md 用同一正则实测）

- 60 集共 131 个场景头；每集场数 1-3，均值 2.18（2 场 37 集、3 场 17 集、1 场 6 集）。
- 每场动作行 2-44 行，均值 14.6；每场对白 0-25 条，均值 6.6；合计 1910 行动作、866 条对白。
- 时段只出现「日」100 / 「夜」31；内外为「内」89 / 「外」42。
- 动作行内联标注计数：【特写】255、【画面定格】98、【字幕】56、【音效】7、【特效】5、【快切】2、【碎切】2、【交叉剪辑】1、【回忆闪回7-3】1、【人名条】1。
- 地点整段共 58 种写法，全部以 outline 注册景名开头（lint `L3-scene-registry` 项，`script-lint.ts:176`），子景用「·」连接。

### 1.3 镜头切分

`script-format.md:53` 规定「一行动作 = 一个镜头」，`script-lint.ts:100` 只记录 `actionLines` 行号，不再细分。因此镜头级切分点 = 场内每一条 `▲` 行；对白行归属其前最近的 `▲` 行。剧本中的镜头语言只有内联标注（【特写】【画面定格】）与动作行中的运镜文字（`ep-001.md:20` 「镜头自城楼一次拉开到位」、`:29` 「镜头拉开」、`:53` 「推近」），无景别枚举、无机位、无焦距、无时长。8 月初《独占蔷薇》分镜数据对同一层级给出了完整字段（见 §3）。

## 2. 一个镜头的字段来源

### 2.1 场景 / 时间 / 内外

- `sceneId`：由场景头地点前缀匹配 `story/outline.v1.json` `scenes[]`（`/Users/shuai/dramas/yujing-jiushi/story/outline.v1.json:628`，S01 `:630`，S02 `:638`，S08 `:686` 为 S04 的 `variantOf` 变体）。子景写法登记在 assets 的 `F_S02_SUBSCENE_INDEX`（`story/assets.v1.json:2360`）与 `reuse-plan`（`:2262`）。
- `timeOfDay / interior`：场景头捕获组 4、5。
- 分集卡校验：`outline.v1.json:1226` episode 1 的 `sceneIds ["S08","S01"]`、`characterIds`、`crowdPlan`；episode 30 `:1852`。

### 2.2 在场人物与外观一致性

- 在场人物：场景头下一行 `人物：` 调度单（`ep-030.md:42`），或 assets 的 `EP0NN.presence` fact（`assets.v1.json:10923` 首现，`F_EP030_PRESENCE` 值为 `30-1: 顾知行、书吏*1; 30-2: 李默、赵文华、东厂番役*4、宾客*40; 30-3: 顾知行、谢蘅秋`）。60 集中只有 33 集登记了 `presence`，其余需从调度单解析。
- 外观描述：`assets.v1.json` character 资产的 `facts[key=visual]`（C01 `:49`，C02 `:224`），为文本，含分期状态（少年期青布直裰 / 入仕后素色圆领常服；第 41 集后纸叠不再随身）。`perform`（`:85`、`:255`）给表演限制（「全季不许出现拍案、狂笑」「年长叙述者只用声音与背影」）。`voice`（`F_C01_VOICE`）给语域。
- 群演：调度单 `*N` 计数；上限在 `EP0NN.production-flags`（`:8435`、`:10839`「群演上限 60 人」）与 outline `scenes[].productionNotes`。

### 2.3 道具状态来源

- object 资产共 6 项：O01 史册页 `:4012`、O02 玉牒缺页、O03 黑漆木匣 `:4146`、O04 军报底档、O05 勘合船引、O06 荐书。
- 状态键：`form`（`F_O01_FORM`：应验划朱笔、落空点墨点）、`lifecycle`（`:4039` 按集号列出出匣 / 烧毁 / 重建 / 落锁）、`last-page-state`（`:4067`）、`custody`（`:4191`，第 1 集末木匣保管留白）。
- 数字锚点：N02 `:4542` `ink-dots`（`:4579`：第 19 集 1 个、第 30 集 2 个、第 41 集 21 个）。
- 这些值为逐集散文，非按镜头的状态机；使用时需按 `(episode, scene)` 从 lifecycle 文本推导当前状态（见 §5 缺口）。

### 2.4 动作与台词

- 动作：`▲` 行文本，去掉内联标注后的正文。
- 台词：`DIALOGUE_RE` 捕获 `name / prefix / text`。说话者类型由 prefix 判定：`script-format.md:57` 定义 `OS`=内心独白、`VO`=画外音；`ep-001.md:21` `谢蘅秋（年长·VO，平缓）` 为画外音，不需口型；`ep-001.md:30` `沈家人甲（掂着匣，不看他）` 为在画对白，需口型。
- 语言：剧本正文为中文，`F_EP030_SPEC` 注明「中文母本」；`F_EP001_SPEC`（`:8446`）注明「出海英文 profile：500-800 词」。任何文件都没有 `language` 或口型字段。

### 2.5 镜头语言（来自分镜表）

`/Users/shuai/workspace/novel/独占蔷薇_场景/shots_ep123.json`：
- `meta.note`（`:3`）定义 `chars=[角色key, 标签, x, y, z, 朝向deg, 姿态]`、`cam=[机位xyz, 目标xyz, 焦距]`、`arrows=[x1,y1,x2,y2]`；`shot_defaults.res=[720,1280]`（`:4`）。
- 分场键：`id / set / title / stage / arrows / props / shots`（`:8-21`）；`props=[名称, 尺寸, 位置, 材质]`（`:20`）。
- 镜头键：`id / size / dur / action / dialogue / cam`，可选 `chars / arrows / hide`（`:22-25`）。9 分场 34 镜头，时长 2-6 秒（3 秒 20 个、4 秒 8 个、2 秒 5 个、6 秒 1 个）。
- `前三集分镜表.md:3` 画幅 9:16（720×1280）；`:10` 「同一分场内所有镜头共用同一份站位/走位，只切机位」；`:11` 每集约 60 秒；`:40-45` 表格列为 景别·机位+焦距mm / 时长 / 画面动作 / 台词 / 布局图。

### 2.6 首帧 / 尾帧 / 参考图

- `/Users/shuai/dramas/yujing-jiushi/visual/production.v1.json`：S01 `phase=passes-ready`（`:16`），`blendAsset` AssetRef（`:17-23`），3 个 9:16 机位 `CAM_ESTABLISH / CAM_COURTYARD / CAM_INTERIOR` 带 `lensMm / sensorWidthMm / transform`（`:25-58`），`lightingStates` `LIGHT_OVERCAST_DAY / LIGHT_CANDLE_NIGHT`（`:60-71`），`dressingVariants` 仅 `DRESS_SHAOXING_BASE`（`:72-78`），12 张 render（3 机位 × clay/depth/normal/lineart，`:79-175`），`candidates: []`（`:177`）。
- `references/visual-production-schema.md:13-22` 处理链：sceneId → blockout → passes → candidates → approval → approved AssetRef → H3 first/last/reference 输入；`:24-26` 只有 `approved` 候选能成为 H3 输入。
- 后端 slot 名：`docs/design/phase-3-remote-production/AI-SPEC.md:657` `first_frame`；`references/config-schema.md:702` `last_frame`、`ref_images.ref_image_N`。执行参数 `AI-SPEC.md:648-652`：`variant fl2va`、`durationSeconds 8`、`shortEdge 768`、`aspectRatio 9:16`；`:489` H3 时长范围 4-15 秒。
- AssetRef 形：`{version, uri: asset://local/sha256/…, sha256, byteLength, mediaType}`（`production.v1.json:17-23`）。

## 3. 跨镜头连续性约束的表达

三份数据各表达一层：

1. 分场共用站位：`shots_ep123.json` 分场级 `stage` 为默认站位，镜头级 `chars` 覆盖；`场景连贯性手册.md:279` 「同一分场的所有镜头共用同一站位，只变机位」；`:15` 坐标约定（局部原点=地面中心，+Y=主方向，朝向 0°=面向 +Y）。
2. 道具状态时间线：`场景连贯性手册.md:50-66` 表格按集号列出每件道具的状态变化（如 `:56` 血契戒 EP5 戴上 → EP26 裂 → EP37 脱落 → EP56 归还 → EP60 戴上）；对应玉京数据为 `F_O01_LIFECYCLE`、`F_O03_LIFECYCLE`、`F_N02_INK_DOTS`。
3. 人物外观分期：`场景连贯性手册.md:22-48` 一致性卡按集号标注伤痕、服装切换；玉京对应 `F_C01_VISUAL` 内嵌的集号断点（第 41 集后纸叠不随身；第 16-19 集狱中）。
4. 场景道具锚点：`:71-85` 每个物理场景的道具坐标（主位王座 (0,15,0)、冷棺 (-8,6,0)），玉京侧对应 `production.v1.json` 的 `dressingVariants`，目前只有 1 个变体且无物件坐标。
5. 集间承接：`script-format.md:109` 重叠帧承接；`ep-030.md:19` 开场 `【画面定格】` 重放第 29 集末帧。ShotRequest 需带 `继承上一镜/上一集末帧` 指针。
6. 时间层缝合：N05 `visual-seam`（`assets.v1.json:4816`）素银钏为两个时间层共用物件；N08 序章约束（`:4959` 首帧、`:4979` 30 秒上限、VO 不迟于第 10 秒）。

## 4. ShotRequest 字段清单草案

| 字段 | 类型 | 来源 | 必填 |
|---|---|---|---|
| `shotId` | string `EP001-S1-3` | 集号 + 场序 + ▲ 行序（`script-lint.ts:100`） | 是 |
| `episode` / `sceneIndex` | int | 场景头捕获组 1、2 | 是 |
| `scriptLine` | int | ▲ 行行号（追溯） | 是 |
| `sceneId` | string | 地点前缀匹配 `outline.v1.json:628` scenes | 是 |
| `subscene` | string\|null | 地点「·」后段；登记在 `F_S02_SUBSCENE_INDEX` | 否 |
| `timeOfDay` / `interior` | enum | 场景头捕获组 4、5 | 是 |
| `lightingStateId` | string | `production.v1.json:60-71`（需 日/夜 → LIGHT_* 映射） | 是 |
| `dressingVariantId` | string | `production.v1.json:72-78`（需 arc → DRESS_* 映射） | 是 |
| `cast[]` | `{characterId, name, count, appearance, performNotes}` | 调度单 + `facts.visual/perform`（`assets.v1.json:49,85`） | 是 |
| `cast[].stage` | `{x,y,z,yawDeg,pose}` | `shots_ep123.json` `stage/chars` 形；玉京无 | 是（缺） |
| `props[]` | `{objectId, stateAtShot, position}` | O0x `lifecycle/custody`（`:4039,4162,4191`）+ `props` 坐标形 | 是 |
| `action` | string | ▲ 行正文 | 是 |
| `productionTags[]` | enum | 【特写】【特效】【音效】【字幕:…】【画面定格】 | 否 |
| `dialogue[]` | `{speakerId, text, prefix, mode: onscreen\|OS\|VO, language, lipSync: bool}` | `DIALOGUE_RE`；mode 由 prefix 含 OS/VO 判定；language 无来源 | 否 |
| `shotSize` / `cameraMove` | enum | 分镜表 `size`（中景·倒退跟拍）；玉京只有【特写】/「拉开」 | 是（缺） |
| `cameraId` 或 `cam` | string 或 `[pos,target,focalMm]` | `production.v1.json:25-58` / `shots_ep123.json` `cam` | 是（缺） |
| `lensMm` | number | `cameras[].lensMm` 或 `cam[2]` | 是 |
| `aspectRatio` | `"9:16"` | `production.v1.json:31`、`AI-SPEC.md:652` | 是 |
| `resolution` | `[720,1280]` / shortEdge 768 | `shots_ep123.json:4`、`AI-SPEC.md:651` | 是 |
| `durationSeconds` | number 2-6（建议）/ 4-15（后端） | 分镜表 `dur`；`AI-SPEC.md:489,650` | 是（缺） |
| `firstFrame` / `lastFrame` | AssetRef | `production.v1.json` approved candidate（现为空） | 是（缺） |
| `refImages[]` | AssetRef[] | 人物定妆 / 道具参考；assets schema 无图像字段 | 否（缺） |
| `spatialPasses[]` | renderId[] | `production.v1.json:79-175` depth/normal/lineart | 否 |
| `continuity.prevShotId` / `carryFromEpisodeEnd` | string | 同场上一镜；`ep-030.md:19` 重叠帧 | 否 |
| `continuity.stageGroup` | string | 分场 ID，同组共用站位 | 是 |
| `crowd` | `{label, count, cap}` | 调度单 `*N`；`production-flags` 上限 | 否 |
| `audio` | `{sfx, bgm, vo}` | 【音效】【BGM】标注；H3 含 audio VAE（`AI-SPEC.md:603`） | 否 |
| `provenance` | `{outlineSha256, assetsRevision, productionRevision, beatCardHash}` | frontmatter `beat-card-hash`、`production.v1.json:5-6` | 是 |

## 5. 现有数据缺失、需新增生成步骤的字段

1. 镜头切分与景别 / 机位 / 时长：玉京只有 ▲ 行与【特写】标注；需一个「分镜生成」步骤产出 `shotSize / cam / dur`，输出形可直接沿用 `shots_ep123.json` 的 `shots[]`。
2. 站位与走位：玉京无 `stage/chars/arrows`；需按 S01 的 blockout 建立局部坐标站位表（`场景连贯性手册.md:15` 坐标约定可复用）。
3. 首帧 / 尾帧：`production.v1.json:177` `candidates` 为空，无 approved；需完成 keyframe-review → approved 步骤，且需按镜头而非按机位登记（当前候选只绑机位 / 灯光 / 陈设组合，`visual-production-schema.md:79-80`）。
4. 人物 / 道具参考图：assets schema 只有文本 `visual`，无 AssetRef 字段（`story-assets-schema.md:28-30` 禁止路径 / URL）；需在 production 清单新增 character / object 定妆图登记。
5. 道具状态机：`lifecycle` 为散文，需转成 `(episode, scene) → state` 表，形如 `场景连贯性手册.md:54-66`。
6. 灯光 / 陈设映射：场景头「日/夜」到 `LIGHT_*`、arc 到 `DRESS_*` 无登记；S01 全季 6 个时期只有 1 个 DRESS 变体，S02-S10 无 production 条目。
7. 台词语言与口型：无 `language`、无 `lipSync`；中文母本与英文 profile 并存（`assets.v1.json:8446` 与 `F_EP030_SPEC`），需在项目级确定输出语言并按 prefix（OS/VO）推导口型需求。
8. 群演：调度单只有计数（`宾客*40`），无分布与外观模板。
9. 序章时序约束（N08 `:4979`）为分场级总时长上限，需在镜头级分配。

关键事实：
- 场景头正则在 /Users/shuai/workspace/jinko/writing-loop/hub/src/script-lint.ts:51，捕获 集号/场序/地点/时段/内外 五段；动作行 :52、对白 :53、调度单 :54、集标记 :55
- script-lint.ts:14-26 的 ScriptScene 已含 location/timeOfDay/interior/roster/speakers/actionLines，可直接作 ShotRequest 分场层输入
- /Users/shuai/workspace/jinko/writing-loop/references/script-format.md:53 规定「一行动作 = 一个镜头」；:57 定义 OS=内心独白、VO=画外音
- 对 /Users/shuai/dramas/yujing-jiushi/episodes/ 60 集实测：131 场，每集 1-3 场均值 2.18；每场动作行 2-44 均值 14.6；每场对白 0-25 均值 6.6
- 全季场景头时段只有 日(100)/夜(31)，内(89)/外(42)；内联标注 特写 255、画面定格 98、字幕 56、音效 7、特效 5
- ep-001.md:17 `1-1 未来玉京 日 外`，:18 调度单，:21 `谢蘅秋（年长·VO，平缓）` 画外音；ep-030.md:17 `30-1 官署公堂·有司递表一角 日 内` 为「注册景·子景」形，:42 调度单含 `宾客*40`
- /Users/shuai/dramas/yujing-jiushi/story/outline.v1.json:628 scenes（S01 :630，S08 :686 variantOf S04），:1226 episode 1 的 sceneIds/characterIds/crowdPlan，:1852 episode 30
- /Users/shuai/dramas/yujing-jiushi/story/assets.v1.json revision 316，200 资产（episode 60、continuity 48、foreshadow 39、character 18、scene 10、organization 8、world 7、object 6、location 4），timeline 72 条
- 人物外观来源 assets.v1.json character facts key=visual（C01 :49，C02 :224）、perform（:85，:255），均为文本，无图像 AssetRef
- 道具状态来源 O01 史册页 :4012（lifecycle :4039，last-page-state :4067）、O03 黑漆木匣 :4146（lifecycle :4162，custody :4191）、N02 ink-dots :4579，均为逐集散文
- EP0NN 资产的 presence fact（首现 :10923）给逐场在场人物，60 集中只有 33 集登记；production-flags（:8435，:10839）给群演上限
- N08 序章约束 :4942：first-frame :4959、duration-cap :4979（序章 ≤30 秒，首帧反差 3 秒内，VO 不迟于第 10 秒）
- /Users/shuai/dramas/yujing-jiushi/visual/production.v1.json 仅 S01，phase passes-ready（:16），3 个 9:16 机位带 lensMm/transform（:25-58），2 个 lightingStates（:60-71），1 个 dressingVariant（:72-78），12 张 clay/depth/normal/lineart render（:79-175），candidates 为空（:177）
- references/visual-production-schema.md:24-26：只有人工 approved 的候选图才能成为 H3 first/last/reference 输入
- H3 slot 名：docs/design/phase-3-remote-production/AI-SPEC.md:657 first_frame；references/config-schema.md:702 last_frame 与 ref_images.ref_image_N；执行参数 AI-SPEC.md:648-652 variant fl2va、durationSeconds 8、shortEdge 768、aspectRatio 9:16；:489 时长 4-15 秒
- /Users/shuai/workspace/novel/独占蔷薇_场景/shots_ep123.json:3 定义 chars=[key,标签,x,y,z,朝向deg,姿态]、cam=[机位xyz,目标xyz,焦距]、arrows；:4 res [720,1280]
- shots_ep123.json 镜头键为 id/size/dur/action/dialogue/cam，可选 chars/arrows/hide；9 分场 34 镜头，时长 2-6 秒（3 秒占 20 个）
- 前三集分镜表.md:10 「同一分场内所有镜头共用同一份站位/走位，只切机位」；:11 每集约 60 秒；:40-45 表列 景别·机位+焦距/时长/动作/台词/布局图
- 场景连贯性手册.md:12 提示词组成规则（一致性卡外观 + 当集道具状态 + 站位关系）；:15 局部坐标约定；:50-66 道具状态时间线表；:71-85 场景道具锚点坐标；:279 分场共用站位
- 剧本为中文母本（F_EP030_SPEC），F_EP001_SPEC（assets.v1.json:8446）标注出海英文 profile；无任何 language / lipSync 字段
- script-format.md:109 重叠帧承接；ep-030.md:19 开场【画面定格】重放上集末帧，ShotRequest 需带集间承接指针

未决问题：
- 输出语言：剧本中文母本与 F_EP001_SPEC 的出海英文 profile 并存，视频台词按哪种语言生成、是否需要口型对齐，需项目级裁定
- 镜头粒度：按「一 ▲ 行 = 一镜」全季约 1910 镜；每集 60 秒预算下（分镜表:11）需要合并规则，合并依据未定义
- 首帧/尾帧的登记粒度：production.v1.json 候选图绑定机位×灯光×陈设组合，与逐镜头的首帧需求是否一一对应，还是需新增 shot 级候选表
- 人物/道具定妆参考图应登记在 production.v1.json 还是新建清单；story-assets-schema 禁止路径/URL 字段
- S01 的 6 个时期陈设变体与 S02-S10 的 production 条目尚未建立，日/夜 → LIGHT_*、arc → DRESS_* 的映射由谁维护
- H3 fl2va 单次 4-15 秒与分镜表 2-6 秒镜头的关系：一次生成一镜还是一次生成多镜后剪切
- 群演（宾客*40）的外观模板与站位分布无来源，是否需要单独的群演资产

---

# MAP vcs-providers

# writing-loop 远程制片子系统结构图（main @1455194）

仓库根：`/Users/shuai/workspace/jinko/writing-loop/`。下文 `hub/src/…` 与 `docs/…` 均相对该根；行号来自本次读取。

## 1. 总体分层

AI-SPEC（`docs/design/phase-3-remote-production/AI-SPEC.md:13-33`）定义三层：Studio（loopback 只读）→ writing-loop control plane（`ProductionStore` 权威账本 + 纯 reducer + 不可变 intent + gate + coordinator）→ 私有 Gateway router（stage / job / ingest 三个 kernel）→ 远端 ComfyUI/H3。所有 provider endpoint、credential、workflow 文件只来自 owner-only runtime config（AI-SPEC:509-521）。

CLI 入口 `hub/src/cli.ts:32` 把 `production` 路由到 `hub/src/production.ts`；后者只有 `status | enqueue --plan/--confirm | handoff` 三个动作（`production.ts:170-297`），全部零远端网络。worker 是独立 bin `hub/src/production-worker.ts:96-143`，只接受 `--config FILE --once [--json]`。

## 2. Ports 与 adapter contract（精确接口）

### 2.1 后端 adapter（`hub/src/production-adapter.ts`）
- `interface ProductionAdapter`（:115-123）：`capabilities(signal?) → BackendCapabilities`；`prepareSubmission(request: SubmitRequest): PreparedSubmission`（零网络）；`submitPrepared(prepared, signal?) → SubmitResult`；`submit()`（兼容 wrapper）；`inspect(remoteJobId, signal?) → RemoteObservation`；`cancel(remoteJobId, signal?) → CancelResult`。
- `BackendCapabilities`（:31-43）字段为字面量类型：`backendKind: "comfyui"`、`asynchronous: true`、`clientAssignedJobId: true`、`inspectById: true`、`progressHints: "optional-websocket"`、`pendingCancellation: "best-effort"`、`runningCancellation: "version-gated-best-effort"`、`providerIdempotency: false`、`inputModes: readonly ["image-upload"]`、`outputModes: readonly ["download"]`。
- `SubmitRequest`（:53-62）：`idempotencyKey`、`remoteJobId`（调用方预分配）、`workflow: Record<string, unknown>`（ComfyUI API-format graph）、`inputBinding: ProductionSubmissionInputBinding | null`（:45-51，字段 `version/stageKey/bindingsDigest/intentDigest`）。
- `PreparedSubmission`（:69-76）：`version/backendInstanceId/remoteJobId/idempotencyKey/requestDigest/request`。
- `SubmitResult`（:78-84）：`remoteJobId/acceptedAt/providerIdempotency: false/nodeErrorCount/responseDigest`。
- `RemoteJobState`（:86）：`pending|running|succeeded|failed|cancelled|not-found`。`RemoteOutputLocator`（:88-94）：`nodeId/kind(image|video|audio|file)/filename/subfolder/folderType(input|output|temp)`。`RemoteObservation`（:96-104）：`remoteJobId/state/observedAt/outputs/errorSummary/responseDigest`。`CancelResult`（:106-113）：`confirmed: false` 为字面量。
- 错误分类 `ProductionAdapterErrorCode`（:5-11）：`aborted|submission-unknown|remote-rejected|remote-unavailable|invalid-response|response-too-large`。
- 实现：`ComfyUiAdapter`（:429-839）；`ProductionGatewayAdapter`（`hub/src/production-job-gateway.ts:2748-3051`）。两者 `capabilities()` 都返回 `backendKind: "comfyui"`（adapter :462；job-gateway :2790）。

### 2.2 coordinator 依赖端口（`hub/src/production-coordinator.ts`）
- `ProductionAdapterRegistry.resolve(backendInstanceId)`（:74-76）。
- `ProductionWorkflowDescriptor`（:78-85）：`version/workflow/modelFamily/modelSha256/parametersSha256`；`ProductionWorkflowResolver.resolve(intent)`（:88-90）。
- `ProductionGateContextResolver.resolve(intent, task)`（:92-98）→ `ProductionIntentGateContext`。
- `ProductionInputPipeline`（:100-110）：`{policy:"static-pre-staged"}` 或 `{policy:"scoped-staging", inputStager, workflowBindingVerifier}`；`ProductionInputPipelineResolver`（:113-118）。
- `ProductionCoordinatorOptions`（:176-200）、run result（:148-159）、issue codes（:120-140）。
- `ProductionArtifactIngestor`（`hub/src/production-ingestor.ts:64-75`）：`ingestKey(task, observation): string` 与 `ingest(task, observation, signal?) → ProductionIngestResult{version, ingestKey, assets, cost}`（:57-62）。AI-SPEC:349-352 只列出 `ingest`，未列 `ingestKey`，文档与代码存在差异。
- `ProductionIntentResolver.resolve(taskId)`（`hub/src/production-intent.ts:178-180`）。
- `ProductionInputStager.stage(intent)`（`hub/src/production-input-stager.ts:74-76`）；`ProductionWorkflowBindingVerifier.verify(intent, workflow, staged)`（:94-101）→ `ProductionWorkflowBindingVerification{templateWorkflowSha256, boundWorkflowSha256, workflow, stageKey, bindingsDigest}`（:78-88）。

### 2.3 Gateway 服务端端口
- job gateway（`hub/src/production-job-gateway.ts`）：`ProductionJobProfileRegistry.resolve(scope, profileId)`（:109-115）→ `ProductionJobProfile{profileId, backendInstanceId, workflowDigest, stageProfileDigest, execution, h3GraphContract, stageGraphBindings, workflow}`（:92-107）；`ProductionJobProfileValidator`（:117-121）；`SubmissionAdmissionPolicy.acquire/settle`（:148-160）；`ProductionJobStorageAdmissionPolicy.acquire/commit/release`（:184-208）；`rawAdapter: ProductionAdapter`（:250）。
- stage gateway（`hub/src/production-stage-gateway.ts`）：`ProductionStageProfileRegistry`（:75-80）、`ProductionStageProfile{registration, providerCasNamespace, inputs[{index, slot, mediaTypes}]}`（:60-73）、`ProductionStageAssetResolver.resolve(scope, asset)`（:126-133）、`ProductionStageReceiptRegistry.verifyStageReceipt(claim)`（:103-108）、`ProductionStageAssetPolicy{scheme, authority}`（:110-116）。
- ingest gateway（`hub/src/production-gateway.ts`）：`ProductionGatewayCostResolver`（:51-54）、`comfyBaseUrl`（:60）、`comfyCredentialResolver`（:66）。
- router（`hub/src/production-gateway-router.ts:34-39, 84-96`）：`/v1/scopes/{ws}/{project}/(jobs|stages|ingests|assets)/…`，只允许 jobs GET/PUT、stages PUT、ingests PUT、assets GET；`bindHost` 只接受字面私网 IP（:58-74）。

## 3. ProductionTask 状态机（`hub/src/production-domain.ts`）

- 14 个状态（:16-31），终态 5 个（:35-37）。转移表 `PRODUCTION_TRANSITIONS`（:39-62）；代码比 AI-SPEC:186-198 多出 `submitted/running/ingesting/qc-pending/submission-unknown → cancelled` 边（:46-50，注释说明用于取消竞态后远端迟到的 cancelled 事实）。
- 取消恢复矩阵 `CANCELLATION_RECOVERY_TARGETS`（:261-270）；`CANCELLATION_EVENTUAL_STATUSES`（:271-280）。
- 事件类型 13 种（:213-244），`TARGET_BY_EVENT`（:924-938）。reducer `transitionProductionTask`（:959-1131）：同 eventId 同 payload 幂等（:966-972），revision/occurredAt 乱序硬错（:973-978），终态不可追加（:980-982）。
- 持久化不变量在 `parseProductionTask`（:568-772）：`submitting` 必须 pending outbox（:726-728）、`submission-unknown` 必须 unknown outbox（:729-731）、`qc-pending/approved/rejected` 至少 1 个 AssetRef（:736-738）、approval 绑定 `taskRevision = revision-1`（:741）。文档 revision = 任务数 + 全部 receipt 数（:805-808）。
- idempotencyKey 与 `(backendInstanceId, remoteJobId)` 全局唯一（:816, :823-829）。

## 4. ProductionIntent（`hub/src/production-intent.ts`）

- 枚举：`PRODUCTION_INTENT_OPERATIONS = ["comfyui-workflow","minimax-h3"]`（:38）；`PRODUCTION_MODEL_FAMILIES = ["generic","minimax-h3"]`（:42）；`H3_VARIANTS = ["fl2va","ref2va"]`（:45）；`H3_ASPECT_RATIOS = ["9:16","16:9","1:1"]`（:49）；受限地域 `["EU","GB","KR","US"]`（:52）+ 27 个 EU 成员（:55-58）。
- `ProductionIntentExecution`（:60-83）：公共字段 `version/operation/modelFamily/backendInstanceId/workflowSha256/modelSha256/parametersSha256`；generic 分支只允许 `operation="comfyui-workflow"`（:316-318）；H3 分支追加 `variant`、`durationSeconds`（安全整数 4–15，:351）、`shortEdge: 768`（:338）、`aspectRatio`（:339-341）。未知 modelFamily 在 :356 硬错。
- 草稿 `DRAFT_KEYS`（:461-464）：`version/taskId/subject/createdAt/useTerritories/execution/inputs/budget/rights/moderation/license`。`inputs` 必须 1–32 个 AssetRef（:294-302）。地域正则 `^(?:[A-Z]{2}|WORLDWIDE)$`（:190）。
- `idempotencyKey = sha256(JSON.stringify(parsed draft))`（:476-479）；`parseProductionDispatchIntent` 重算并比较（:493-497）。companion 文件 `production-intents.v1/<taskId>.json`，O_EXCL 写入，内容漂移拒绝（:764-810）。
- gate `evaluateProductionIntentGates`（:529-620）：预算两项（:540-545）、rights（:547-560）、moderation（:562-569）、license（:571-588）、H3 地域 written-license（:590-617）。gate context `{evaluatedAt, deploymentTerritories, availableBudgetMicros}`（:138-143）。

## 5. Backend kind 与 runtime config（`hub/src/production-runtime-config.ts`）

- kind 只有两种：`"comfyui"`（:93-100，`credentialEnv: null`、`preferJobsApi`）与 `"production-gateway"`（:102-109，`credentialEnv: string`、`profileId`）。`parseBackend` 在 :391 拒绝其他 kind。
- URL 策略 `trustedServiceUrl`（:312-344）：`direct-comfy-dev` 只允许无凭据 literal-loopback HTTP（:330-333）；`production-gateway` 必须 HTTPS + credentialEnv（:334-337）；`gateway` 允许 credentialed HTTPS 或 loopback HTTP（:338-341）。
- 顶层 `ProductionRuntimeConfig`（:163-172）：`workspaceId/projects/backends/gateway/workflows/stagingProfiles/runner`。
- `workflows[]`（:121-134）：`backendInstanceId/workflowSha256/modelFamily/modelSha256/parametersSha256/projects/inputPolicy(static-pre-staged|scoped-staging)/stagingProfileId/h3GraphContract/file`。H3 必须 scoped-staging（:436-438）；generic 的 `h3GraphContract` 必须 null（:442-444）；文件路径相对且禁止 `..`（:346-356）。
- `stagingProfiles[]`（:138-145）：`execution` 必须 `modelFamily="minimax-h3"` 且 `operation="comfyui-workflow"`（:469-471）；bindings 1–32（:472-475）。
- `projects[]`（:147-154）：`enabled/backendInstanceIds/deploymentTerritories/availableBudgetMicros`；`runner`（:156-161）。
- 交叉校验：scoped-staging 禁止绑定 raw comfyui backend（:639-644）；profile execution 与 workflow tuple 必须一致（:648-650）；gateway backend 的 `profileId` 必须等于 staging profileId（:651-653）；未被引用的 profile 拒绝（:658-660）。
- 装配 `createProductionRuntimeRegistry`（:1101-1304）：启动时读取全部 credentialEnv（:1117-1119）；comfyui → `ComfyUiAdapter`（:1128-1133）；production-gateway → `ProductionGatewayAdapter`（:1169-1185）；ingestor 使用 `config.gateway.baseUrl`（:1247-1261）。config 文件必须 owner 持有、0400/0600、单链接（:705-721）。

## 6. AssetRef 与连续性包

- `AssetRef{version, uri, sha256, byteLength, mediaType}`（`production-domain.ts:71-77`），parse :411-422。URI 白名单 scheme：`asset: az: azure: cas: gs: https: ipfs: r2: s3: urn:`（:290）；禁止本机路径、query/fragment、内嵌凭据、loopback https（:385-409）。
- Gateway ingest 产出的 AssetRef 固定 `uri = urn:sha256:<digest>`（`production-gateway.ts:1177`），媒体类型来自魔数嗅探（:470-488），允许列表 :180-191（png/jpeg/gif/webp/mp4/webm/wav/flac/ogg/mpeg）。
- 「连续性包」只出现在 AI-SPEC:178-180（角色/声线、服装道具、场景灯光、景别轴线、first/last frame、reference 用途、model/workflow/seed fingerprint），代码中没有对应类型；最接近的机读结构是 `visual/production.v1.json`（`hub/src/visual-production.ts:39-80`，候选图绑定 camera/lighting/dressing + workflowSha256/modelSha256/promptSha256/seed）。

## 7. Staging（scoped-staging）与输入绑定

- `stageKey = sha256(JSON.stringify({version, scope, taskId, intentDigest, execution, inputs[{index, asset}]}))`（`production-input-stager.ts:187-219`）；`bindingsDigest = sha256(JSON.stringify(bindings))`（:222-224）。
- 客户端 `HttpProductionInputStager.stage`：PUT `/v1/scopes/{ws}/{project}/stages/{stageKey}`，header `x-writing-loop-idempotency-key`（:446-513）；响应 bindings 必须按序、`assetSha256` 与 intent.inputs 一致、slot 唯一（:233-280）。
- 服务端 `ProductionStageGateway`：资产 URI 必须命中 `assetPolicies{scheme, authority}` 且 scheme 不在 `http: https: file: data:`（:245, :385-402）；流式校验 sha256/长度/魔数（:1056-1078）；`providerObjectKey = <namespace>/<xx>/<sha256>`（:735-739）；receipt 含 `profileDigest`（:456-463）。
- H3 绑定：`ProductionH3StageBindingContract{index, slot, source{LoadImage.image, outputIndex 0}, consumer{nodeId, inputName}}`（`production-h3-graph.ts:85-101`）；模板中 LoadImage.image 必须是 sentinel `writing-loop://stage-input/<profileId>/<index>/<slot>`（:377-385）；`materializeProductionH3Workflow` 替换为 providerObjectKey 并重新断言整图（:738-774）。
- coordinator 调度顺序（`production-coordinator.ts:720-942`）：intent → gate（扣除 outstanding reservation :742-749）→ workflow descriptor 三项 digest 比对（:768-784）→ input pipeline → stage → verify → adapter.prepare → 预留 maximum 预算（:893）→ `submission-started` 落盘 → expose → `submitPrepared` 一次 → `submission-confirmed` → inspect。

## 8. H3 graph contract 与许可门

- 生成器类 `MiniMaxH3ImageToVideo | MiniMaxH3ReferenceToVideo`（:14-16, :26-28）；四组件 model bundle（UNETLoader/CLIPLoader/VAELoader×2，:39-55）；固定 pipeline 10 节点（:63-75）；`parameterManifest.sha256`（:82）。
- 画布：16:9→1344×768，9:16→768×1344，1:1→768×768（:392-399）；帧长 `max(5, round(seconds*24))` 向上对齐到 `17k+5`（:401-405）；fl2va 1–2 slot（first_frame/last_frame），ref2va 1–9 slot（`reference.N` → `ref_images.ref_image_N`，:407-432）。
- `assertGraph`（:588-708）：节点集合精确相等（:606-610）、loader 字面量与 alias 一致、CLIP type=minimax（:616-621）、CreateVideo fps=24（:695）、SaveVideo format/codec=auto（:701-702）、参数投影 digest 等于 contract（:704-707）。
- 许可门：`deploymentTerritories` 来自 runtime `projects[]`（:147-154，解析 :498-507），经 `StaticGateContextResolver`（:1015-1037）进入 gate；`useTerritories ∪ deploymentTerritories` 中命中 EU 成员/EU/UK→GB/KR/US 时，需 `basis="written-license"` 且 `status/evidence/licenseSha256/issuedBy/issuedAt` 齐全（`production-intent.ts:590-617`）。

## 9. 预算与成本

- `ProductionCost`（`production-domain.ts:98-110`）：`known{currency:"USD", amountMicros, basis: reported|billed|estimated}` 或 `unknown{reason}`；currency 非 USD 硬错（:473）；上限 `MAX_PRODUCTION_COST_MICROS`（:14）。
- intent `budget{estimatedAmountMicros(≥0), maximumAmountMicros(≥1)}`（`production-intent.ts:85-90, :359-380`）。
- control ledger `BudgetReservation` 三态 reserved/exposed/released（`production-coordinator-domain.ts:22-36`）；coordinator 预留 maximum（:891-896），expose 在 POST 前（:503-515, :904），只有 `reported|billed` 才释放（:538-549），否则记 `cost-unreconciled`。
- 读模型 `ProductionCostSummary`（`production-read-model.ts:18-31`）；金额格式化 `<$0.01`（`production-money.ts:9`）。ingest gateway 默认 `unknown/provider-not-reported`（`production-gateway.ts:192-196`），可注入 `costResolver`。

## 10. `production handoff` 输出（`hub/src/production-studio-handoff.ts`）

- stdout JSON：`{version:1, digestAlgorithm:"sha256:writing-loop-canonical-json-v1", digest, handoff}`（`production.ts:235-240`；常量 :18）。
- `VideoStudioHandoff`（:40-54）：`version/contract:"citronetic-video-creation-studio-codex-handoff-v1"/handoffId/studioProjectId/workspaceId/project/productionRevision/pipeline(cinematic|character-animation|animation|hybrid)/createdAt/delivery/takes[]/requiresAgentOrchestration:true`。
- `delivery`（:22-30）：`aspectRatio(9:16|16:9|1:1)/width/height(256–7680 且与比例一致)/fps(24|25|30)/container:"video/mp4"/language`。
- `takes[]`（:32-38）：`taskId/shot: ShotRevisionRef/assets: AssetRef[]/approval`；只接受 `subject.kind="shot"`、`status="approved"`、非空 assets（:164-168）；全部 take 同一 episode revision（:171-178）；按 shotId+taskId 排序、shotId 唯一（:185-189）；`createdAt ≥ state.updatedAt`（:158-160）。
- digest 用自带 canonicalJson：键按 code-unit 排序、只允许安全整数、深度 ≤64（:206-222）。

## 11. H3/ComfyUI 专有假设 vs 通用部分

通用（provider 无关）：状态机与 store、AssetRef、intent 的 rights/moderation/license/budget 门、control ledger（retry/reservation/pendingEvent）、coordinator 的 prepare→persist→single-submit→inspect→ingest 协议、ingest CAS 存储与 ownership、handoff、runner/worker、router。

H3/ComfyUI 专有：`BackendCapabilities.backendKind: "comfyui"` 与 `inputModes ["image-upload"]`（adapter :32, :41）；`SubmitRequest.workflow` 为 API-format graph 且 `validatePromptGraph` 检查 `class_type/inputs`（:220-233）；ComfyUI `remoteJobId` 必须 UUID（:156, :201-206）；`RemoteOutputLocator` 是 `/view` 定位（:88-94），ingest gateway 从 `comfyBaseUrl/view` 下载（`production-gateway.ts:812-824`）；`errorSummary` 只允许 `execution_error[:Type]|execution_interrupted`（coordinator :212；coordinator-domain :114）；execution 枚举与 `workflowSha256/modelSha256/parametersSha256` 三 digest；staging profile 只服务 H3-over-Comfy；job gateway profile 必须携带 `workflow`。

## 12. 接入 Seedance（Volcengine Ark）/ Veo（Vertex AI）：缺失项与 fail-closed 检查

类型系统缺失：
1. 没有 `modelFamily` 值可表示 seedance/veo；`operation` 只有 comfyui-workflow/minimax-h3（`production-intent.ts:38, :42`）。
2. execution 必填 `workflowSha256/modelSha256/parametersSha256`（:309-312），云 API 没有 workflow graph；也没有 prompt 字段（H3 的 prompt 在 graph 参数里，`production-h3-graph.ts:538`）。
3. `inputs` 至少 1 个 AssetRef（:295），纯 text-to-video 无法表达。
4. `BackendCapabilities.backendKind` 字面量 `"comfyui"`、`clientAssignedJobId: true`、`providerIdempotency: false`（adapter :32-40）；Ark task_id / Vertex operation name 由 provider 分配。
5. `RemoteObservation.outputs` 只有 ComfyUI 文件定位，没有 URL/GCS 对象引用；`ProductionGatewayIngestRequest.locators` 同样（`production-ingestor.ts:107-118`）。
6. runtime `backends[].kind` 只有两种（:93-113）；credential 只有单个 env var（:107），值必须 `^[\x21-\x7e]+$`（:800）——Vertex 的 service-account JSON 或 ADC 无法用该形式表示。
7. `ProductionCost.currency` 只允许 USD（`production-domain.ts:473`）；Ark 以 CNY 计费时无法记录 known cost。
8. 时长/分辨率约束只为 H3 定义（4–15 s、768 short edge）；Veo（4/6/8 s，720p/1080p）与 Seedance 的档位需要新的 execution 变体。

会直接拒绝的 fail-closed 检查（按调用顺序）：
- `parseProductionIntentExecution` :356（未知 modelFamily）、:316-318（generic 非 comfyui-workflow）。
- `parseBackend` :391（未知 kind）；`parseWorkflow` :415-417（modelFamily）、:456（必须有 `file`）；`ImmutableWorkflowRegistry.#read` :895-897（文件 digest 必须等于 workflowSha256）；`parseStagingProfile` :469-471（非 H3 fail-closed）。
- coordinator：`parseWorkflowDescriptor` :250-255（workflow 必须是对象、modelFamily ∈ {generic, minimax-h3}）；:781-784（workflow digest 不匹配）；:799-803（H3 无 stager 或 generic 非 static 模式）；:883（prepared.request.workflow digest）；:910-915（`submitted.remoteJobId` 必须等于预分配 ID、`providerIdempotency` 必须为 false）；:561-565（非 `execution_error` 的 errorSummary 被改写为 `execution_error`，其他形态在 `parseCoordinatorRemoteObservation` 触发 :571-580 的 invalid-response）。
- reconcile：`parseRemoteObservation` :105-114 与 locator :70-100（outputs 必须是 ComfyUI 定位形状）。
- ingest gateway：`parseLocator` :339-355，`comfyOutputUrl` :812-824（只从配置的 comfyBaseUrl `/view` 拉取，无签名 URL/GCS 通道）。
- job gateway：`parseProfile` :738-756（profile 必须携带 workflow 且 digest 一致）；`parsePreparedForProfile` :1440-1442（inputBinding 必须 null、workflow digest）；`validateClientWorkflow` :2663-2682（节点必须有 class_type/inputs）。
- ComfyUiAdapter：`promptId` :201-206（UUID）、`validatePromptGraph` :220-233。

可能的接入位置：job gateway 的 `rawAdapter: ProductionAdapter`（:250）是唯一 provider 抽象点，但其上游 `#prepareForRaw`（:2164-2177）仍以 workflow graph 构造 `SubmitRequest`；要接云 API 需要新增 execution 变体、放宽 `SubmitRequest`/`RemoteObservation` 的 provider 特化字段、增加 credential 类型与 cost currency。

关键事实：
- ProductionAdapter 接口方法：capabilities/prepareSubmission/submitPrepared/submit/inspect/cancel（hub/src/production-adapter.ts:115-123）
- BackendCapabilities.backendKind 为字面量 "comfyui"，inputModes 固定 ["image-upload"]，providerIdempotency 固定 false（hub/src/production-adapter.ts:31-43）
- SubmitRequest 必含 workflow: Record<string, unknown>（ComfyUI API-format）与 inputBinding（hub/src/production-adapter.ts:53-62）
- ProductionStatus 14 个状态、终态 5 个、转移表 PRODUCTION_TRANSITIONS（hub/src/production-domain.ts:16-62）；代码比 AI-SPEC:186-198 多出多条 → cancelled 边（:46-50）
- 取消竞态恢复矩阵 CANCELLATION_RECOVERY_TARGETS（hub/src/production-domain.ts:261-270）
- PRODUCTION_INTENT_OPERATIONS = [comfyui-workflow, minimax-h3]，PRODUCTION_MODEL_FAMILIES = [generic, minimax-h3]（hub/src/production-intent.ts:38, 42）
- H3 execution 约束：variant fl2va|ref2va、durationSeconds 4–15、shortEdge 固定 768、aspectRatio 9:16|16:9|1:1（hub/src/production-intent.ts:329-354）
- intent.inputs 必须是 1–32 个 AssetRef（hub/src/production-intent.ts:294-302）
- intent idempotencyKey = sha256(canonical parsed draft)（hub/src/production-intent.ts:476-479）
- H3 许可门：useTerritories ∪ deploymentTerritories 命中 EU/GB/KR/US 时要求 written-license evidence（hub/src/production-intent.ts:590-617）
- runtime backend kind 只有 comfyui 与 production-gateway，其他 kind 在 parseBackend 硬错（hub/src/production-runtime-config.ts:93-113, 391）
- direct comfyui 只允许无凭据 literal-loopback HTTP；production-gateway 必须 HTTPS + credentialEnv（hub/src/production-runtime-config.ts:330-337）
- stagingProfiles.execution 必须 modelFamily=minimax-h3 且 operation=comfyui-workflow（hub/src/production-runtime-config.ts:469-471）
- H3 workflow 必须 scoped-staging，generic 的 h3GraphContract 必须 null（hub/src/production-runtime-config.ts:436-444）
- credentialEnv 的值必须匹配 ^[\x21-\x7e]+$ 且 ≤8192 字节（hub/src/production-runtime-config.ts:794-804）
- AssetRef uri 白名单 scheme：asset/az/azure/cas/gs/https/ipfs/r2/s3/urn（hub/src/production-domain.ts:290）；禁止 query/fragment/凭据/本机路径（:385-409）
- ingest gateway 产出 AssetRef uri 固定 urn:sha256:<digest>，媒体类型由魔数嗅探（hub/src/production-gateway.ts:1175-1181, 470-488）
- ingest gateway 只从配置的 comfyBaseUrl 的 /view 下载输出（hub/src/production-gateway.ts:812-824）
- stageKey = sha256({scope, taskId, intentDigest, execution, inputs}) 且 stage gateway 拒绝 http/https/file/data scheme 资产（hub/src/production-input-stager.ts:187-219；hub/src/production-stage-gateway.ts:245, 385-402）
- H3 帧长公式 max(5, round(s*24)) 对齐到 17k+5；画布 9:16=768×1344（hub/src/production-h3-graph.ts:392-405）
- assertGraph 要求节点集合精确、CreateVideo fps=24、SaveVideo format/codec=auto（hub/src/production-h3-graph.ts:606-610, 695, 701-702）
- coordinator 预留 budget.maximumAmountMicros，只有 cost.basis 为 reported|billed 才释放（hub/src/production-coordinator.ts:891-896, 538-549）
- coordinator 要求 submitted.remoteJobId 等于预分配 UUID 且 providerIdempotency===false（hub/src/production-coordinator.ts:856, 910-915）
- errorSummary 只接受 execution_error[:Type]|execution_interrupted（hub/src/production-coordinator.ts:212；hub/src/production-coordinator-domain.ts:114）
- ProductionCost.currency 只允许 USD（hub/src/production-domain.ts:473）
- handoff 输出 {version, digestAlgorithm:"sha256:writing-loop-canonical-json-v1", digest, handoff}（hub/src/production.ts:235-240；hub/src/production-studio-handoff.ts:18）
- handoff 只接受 shot take、status=approved、assets 非空、同一 episode revision、shotId 唯一（hub/src/production-studio-handoff.ts:164-189）
- VideoStudioDelivery：aspectRatio 三选一、fps 24|25|30、container 固定 video/mp4（hub/src/production-studio-handoff.ts:22-30, 97-125）
- ProductionArtifactIngestor 有 ingestKey 与 ingest 两个方法，AI-SPEC:349-352 只列 ingest（hub/src/production-ingestor.ts:64-75）
- job gateway 的 rawAdapter 是唯一 provider 抽象点，但 #prepareForRaw 仍以 workflow graph 构造 SubmitRequest（hub/src/production-job-gateway.ts:250, 2164-2177）
- gateway router 只允许 jobs GET/PUT、stages PUT、ingests PUT、assets GET，bindHost 必须字面私网 IP（hub/src/production-gateway-router.ts:34-39, 58-74）
- 连续性包只在 AI-SPEC:178-180 有文字定义，代码中无对应类型；最接近的是 visual/production.v1.json 的候选图结构（hub/src/visual-production.ts:39-55）

未决问题：
- 接入 Seedance/Veo 时，是否新增 modelFamily 枚举值并为每个云后端定义独立 execution 变体（时长档位、分辨率、比例），还是引入不带 workflowSha256 的新 operation；两种方案都需要改动 production-intent.ts 的 exactKeys 与 runtime-config 的交叉校验。
- ComfyUI 官方 API nodes（Veo/Seedance）是否可作为过渡路径：现有 staging profile 只允许 H3 family（runtime-config.ts:469-471），generic workflow 只能 static-pre-staged，且 API key 注入方式未在 runtime config 中建模。
- 云 API 由 provider 分配任务 ID（Ark task_id / Vertex operation name），与 coordinator 预分配 remoteJobId 并要求回显一致（coordinator.ts:910）的协议冲突，需要决定是在 gateway 侧做 ID 映射还是修改 adapter contract（clientAssignedJobId=false 分支）。
- Vertex AI 的凭据形式（service-account JSON / ADC / OAuth token）如何映射到现有单一 credentialEnv 字符串约束（runtime-config.ts:794-804）。
- Ark 以 CNY 计费时 ProductionCost 只支持 USD（production-domain.ts:473），成本记录策略未定。
- 云 API 输出为签名 URL 或 GCS 对象，现有 ingest 只从 comfyBaseUrl/view 下载（production-gateway.ts:812-824）；需要新的 output locator 形态和 asset resolver。
- AI-SPEC 与代码存在的两处差异（cancelled 边、ingestKey 方法）是否应同步修订文档。
- hub/examples/production/representative-h3/smoke.mjs 存在但未执行；README 声称它零网络，本次未验证。

---

# MAP wl-production

## 0. 范围与方法

只读检查了三处：
- `/Users/shuai/workspace/citronetic/video-creation-studio`（下称 VCS/OpenMontage）：`docs/comfyui-adapter-plan.md` 全文，`grep -ri comfy` 命中的 10 个文件（`tools/_comfyui/{client.py,metadata.py,__init__.py,workflows/*.json}`、`tools/video/comfyui_video.py`、`tools/graphics/comfyui_image.py`、`tools/video/video_selector.py`、`tools/graphics/image_selector.py`、`tests/contracts/test_comfyui_tools.py`、`.agents/skills/comfyui/SKILL.md`）。
- `/Users/shuai/workspace/jinko/writing-loop/hub/src`（下称 WL）：`production-adapter.ts`（839 行）、`production-h3-graph.ts`（774 行），以及为回答「/view、/upload/image 在哪里调用」补读的 `production-gateway.ts`、`production-stage-gateway.ts`、`production-ingestor.ts`、`production-runtime-config.ts`、`production-job-gateway.ts`、`production-intent.ts` 的相关片段。
- `/Users/shuai/workspace/jinko/writing-loop/docs/design/phase-3-remote-production/AI-SPEC.md` 第 6、7、9A、9B 节。

未运行任何脚本或测试。

## 1. VCS 的 ComfyUI adapter：形态与进度

### 1.1 进度：已实现并已合入

计划文档 `docs/comfyui-adapter-plan.md` 是 RFC 形式，但对应代码已存在并有提交历史：`6ec2bbb 2026-04-16 comfyui: add native ComfyUI provider`、`e3947e1 2026-04-17 model discovery`、`4c62186 2026-04-17 drop music tool`、`7c4bb08 2026-04-23 review items`、`2beda01 2026-07-04`/`37e4ef7 2026-07-05` T2V VAE 修正（`git log -- tools/_comfyui ...`）。文件规模：`client.py` 296 行、`metadata.py` 222 行、`comfyui_video.py` 473 行、`comfyui_image.py` 295 行、`SKILL.md` 55 行、`test_comfyui_tools.py` 666 行、3 个 workflow JSON。计划文档 §Implementation Scope（434-453 行）列出的组件与实际文件一一对应。计划文档中 `comfyui_music` 标注为 not shipped（284-296 行），代码中确实没有。

### 1.2 接口

`ComfyUIClient`（`tools/_comfyui/client.py`）：
- 构造：`COMFYUI_SERVER_URL` 环境变量，默认 `http://localhost:8188`（34-38 行）。
- `is_available()`：`GET /system_stats`，200 即可用（49-57 行）。
- `list_models()`：对 `CheckpointLoaderSimple/UNETLoader/VAELoader/CLIPLoader/LoraLoaderModelOnly` 各发一次 `GET /object_info/{class}`，从 `input.required.<field>[0]` 取可选模型名列表（77-115 行）；`check_models()` 用于 bundled 模型就绪判断（117-130 行）。
- `submit(workflow)`：`POST /prompt`，body 仅 `{"prompt": workflow}`，没有 `client_id`，没有调用方指定 `prompt_id`；响应含 `node_errors` 或 `error` 时抛 `ComfyUIError`；返回服务端生成的 `prompt_id`（136-155 行）。
- `poll(prompt_id, timeout, interval)`：循环 `GET /history/{prompt_id}`，`status.status_str == "error"` 抛错，超时抛 `ComfyUIError`（157-182 行）。不查询 `/queue`。
- `download(filename, subfolder, dest, folder_type)`：`GET /view?filename&subfolder&type`，直接把字节写到本地路径（184-204 行）。
- `upload_image(local_path, name)`：`POST /upload/image` multipart 字段 `image`，返回服务端 `name`（206-218 行）。
- `generate(workflow, output_node, dest)`：submit→poll→download 串行；只读取 `outputs[output_node]["images"]`，为空再读 `["gifs"]`（224-262 行）。`prompt_id` 不向上返回。
- `patch_workflow(workflow, {node_id: {input: value}})`：deepcopy 后按节点 ID 覆写 `inputs`，节点不存在抛错（275-291 行）。

工具层（`BaseTool` 子类）：`ComfyUIVideo`（`comfyui_video.py:94`）、`ComfyUIImage`（`comfyui_image.py:45`）。`execution_mode = SYNC`（`comfyui_video.py:101`），`execute()` 阻塞到产物落盘。

### 1.3 workflow 模板注入方式

- Bundled 模板：`tools/_comfyui/workflows/{flux2-txt2img,wan22-t2v-4step,wan22-i2v-4step}.json`，API-format，节点 ID 固定。注入用硬编码节点 ID：I2V 为 `93.text / 97.image / 98.{width,height,length} / 86.noise_seed / 108.filename_prefix`（`comfyui_video.py:409-415`）；T2V 为 `2 / 11.{width,height,batch_size} / 12 / 16`（372-377 行）；图像为 `4/5/6/7/10/13`（`comfyui_image.py:206-213`）。
- 自定义 workflow：`workflow_json` 或 `workflow_path` + 必填 `output_node`（`comfyui_video.py:260-268`）。自定义 graph 原样提交，不做任何注入（309-310 行）：prompt、seed、尺寸都不会写入自定义 graph。
- 溯源：提交前对最终 graph 计算 SHA-256（`metadata.py:182-185`），写入 `ToolResult.data.workflow_provenance`（`comfyui_video.py:436-473`）。bundled 模型栈只是文件名 + 下载 URL 列表，没有 artifact 摘要（`metadata.py:24-179`）。

### 1.4 输入上传与结果取回

- I2V：`reference_image_url` 先下载到本地 `output_path.with_suffix(".ref.png")`，再 `upload_image(name=f"om_{stem}.png")`，返回名写入 LoadImage 节点 97（`comfyui_video.py:387-411`）。
- 结果：`generate()` 返回本地路径列表；`ToolResult.data` 含 `provider/model/width/height/num_frames/fps=16(硬编码)/output/workflow_provenance`（337-358 行）。

### 1.5 幂等与恢复

- 类属性 `idempotency_key_fields`、`retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout"])`（`comfyui_video.py:195-196`）为声明性元数据；client 层没有去重逻辑，`prompt_id` 不持久化。`poll` 超时后无法按 ID 对账。`SKILL.md:55` 提示 agent「超时后先查 history 再重试」，属于人工流程说明。

### 1.6 selector 与 skill

`video_selector.py:452-456` 对携带自定义 workflow 的请求只路由到 `_custom_workflow_eligible` 的工具；`471/482` 行用 `_operation_ready` 按 t2v/i2v 分别判断 bundled 模型就绪。`SKILL.md` 定义 server contract（10-15 行）、output node 约定（24-29 行）、模型目录约定（37-42 行）。

## 2. WL 的 ComfyUiAdapter：实现程度

### 2.1 接口与能力声明

`ProductionAdapter`（`production-adapter.ts:115-123`）：`capabilities / prepareSubmission / submitPrepared / submit(兼容 wrapper) / inspect / cancel`。`BackendCapabilities`（31-43 行）：`asynchronous: true`、`clientAssignedJobId: true`、`providerIdempotency: false`、`runningCancellation: "version-gated-best-effort"`、`inputModes: ["image-upload"]`、`outputModes: ["download"]`。

### 2.2 使用的 ComfyUI 端点

adapter 内只有 5 个端点：
- `POST /prompt`，body 为 `JSON.stringify({prompt, client_id, prompt_id})`（556 行），附加 header `x-writing-loop-idempotency-key`（628 行，raw ComfyUI 忽略）。
- `GET /api/jobs/{id}`（683 行，v0.24+ 可选优化，需 `preferJobsApi`）。
- `GET /queue`（743、759 行）。
- `GET /history/{id}`（751 行）。
- `POST /queue {delete:[id]}`（818-822 行）与受门控的 `POST /interrupt {prompt_id}`（825-829 行）。

adapter 不调用 `/view`、`/upload/image`、`/system_stats`、`/object_info`、`/ws`（grep 无命中）。`/view` 由 `production-gateway.ts` 的 `comfyOutputUrl`（812-824 行）与 `#download`（1092-1150 行）调用，带 sha256 校验、字节上限、`content-encoding` 必须 identity。输入不走 `/upload/image`：`production-stage-gateway.ts#publishObject`（1003-1024 行）把已校验 sha256 的资产硬链接到 `<root>/objects/<providerCasNamespace>/<sha256>`，`providerObjectKey` 由 `materializeProductionH3Workflow` 写入 `LoadImage.image`（`production-h3-graph.ts:760-766`）。

### 2.3 幂等/恢复算法（已实现）

- `remoteJobId` 必须是 canonical UUID，由调用方预分配（201-206 行）；`prepareSubmission()` 零网络地按真正发送的 body bytes 计算 `requestDigest`（541-578 行）；`submitPrepared()` 重新构造 bytes 并与 prepared 比对（580-610 行）。
- 只 POST 一次；`redirect: "error"`（491-498 行）；4xx 且非 408/425/429 → `remote-rejected`（244-245、635-637 行），其余 HTTP 状态、超时、abort、响应不可解析、`prompt_id` 不等于预分配值 → `submission-unknown`（638-676 行）。
- `validatePromptGraph` 提交前校验 API-format 结构、节点数 ≤ 4096（220-233 行）；响应流式读取并限 2 MB（151-153、272-327 行）。
- `inspect`（legacy 路径 738-802 行）：先 `/queue` 再 `/history`；同一 ID 在 queue 出现多次 → `invalid-response`（747-749 行）；queue 与 terminal history 同时命中时第三次读 queue，仍在则报协议冲突（755-770 行）；两边都无 → `state: "not-found"`（794-801 行），由 coordinator 决定后续。终态映射看 `history.status.messages` 的 `execution_interrupted/execution_error`（397-423 行）；`errorSummary` 只保留 allowlist 内的异常类型名（162-181、381-390 行）。
- jobs API 探测：404 且 body 精确为 `{"error":"Job not found"}` 才认定 supported（687-705 行）；状态映射 `pending/in_progress/completed/failed/cancelled`（718-724 行）。
- `cancel`：总是 `POST /queue delete`；仅在 jobs API 已探测 supported 且任务 running/pending 时调 `/interrupt`（813-838 行）；返回 `confirmed: false`（110、834 行）。
- 输出：`RemoteOutputLocator {nodeId, kind, filename, subfolder, folderType}`（88-94 行）；`outputLocators` 遍历所有节点的所有分组，`images/audio/gifs/videos/video` 映射 kind（337-374 行），上限 128 项（154 行），路径安全检查（329-335 行）。取回经 `HttpProductionArtifactIngestor` `PUT /v1/scopes/.../ingests/{ingestKey}`（`production-ingestor.ts:519-529`）由 gateway 下载。

### 2.4 组装与限制

`production-runtime-config.ts:1122-1135` 只为 `kind: "comfyui"` 的 backend 构造 `ComfyUiAdapter`；direct ComfyUI 仅允许无凭据 literal-loopback HTTP（329-333 行），生产必须走 credentialed HTTPS gateway（334-337 行）。AI-SPEC §7（371-435 行）与代码一致：基线 ComfyUI Core v0.24.0（373 行）；history 为进程内、约 10,000 项、重启清空（421-423 行）；原生 API 无 idempotency key，需 gateway/outbox（429-431 行）。

测试：`hub/test/production-adapter.ts` 544 行、46 条 `ok()` 断言（自定义 harness），覆盖 body digest 与 `prompt_id`（121 行）、not-found（323、408 行）、interrupted（390 行）、重复 ID（414 行）、cancel 端点顺序（489-510 行）。

## 3. 两边对 ComfyUI 的建模差异

| 维度 | VCS | WL |
|---|---|---|
| 执行模型 | 同步工具调用，`generate()` 阻塞（`client.py:224-262`） | 异步远程 job，submit/inspect/cancel 分离（`production-adapter.ts:115-123`） |
| job 身份 | 服务端生成 `prompt_id`，不持久化 | 调用方预分配 UUID，先落盘再 POST（201-206、556 行） |
| 提交歧义 | `requests` 异常直接抛出 | 分类为 `submission-unknown`，禁止再次 POST（666-676 行） |
| 完成判定 | 轮询 `/history` 出现即完成（157-182 行） | `/queue`→`/history` 双读 + 冲突检测（738-802 行） |
| 取消 | 无 | `/queue delete` + 门控 `/interrupt`（813-838 行） |
| graph 来源 | bundled 模板 + 按节点 ID 打补丁，或不可见的自定义 graph（`comfyui_video.py:309-310, 409-415`） | 不可变模板，节点集合、class_type、连线、字面量逐项校验，只允许 `LoadImage.image` 被替换（`production-h3-graph.ts:600-707, 738-773`） |
| 摘要绑定 | 提交后记录 graph sha256（`metadata.py:182-185`） | 提交前绑定 workflow/model/parameters 三个 sha256（`production-h3-graph.ts:443-462`） |
| 模型就绪 | `/object_info` 列模型名（`client.py:77-115`） | 无运行时探测；模型以 alias + artifactSha256 由部署方 attest（`production-h3-graph.ts:39-46`） |
| 输入 | `/upload/image`（`client.py:206-218`） | 文件系统 CAS 硬链接 + object key（`production-stage-gateway.ts:1003-1024`） |
| 输出 | 只读 `images/gifs`（`client.py:241`） | `images/audio/gifs/videos/video` 全部映射（`production-adapter.ts:337-342`） |
| 错误 | 字符串消息 | 稳定错误码 + 异常类型 allowlist（5-11、162-181 行） |
| 响应边界 | 无字节上限 | 2 MB 流式上限、15 s 超时、`redirect: "error"`（151-153、491-498 行） |

## 4. MiniMax H3 节点契约的表达

### 4.1 WL

`production-h3-graph.ts`：
- generator class 限定 `MiniMaxH3ImageToVideo`（fl2va）/`MiniMaxH3ReferenceToVideo`（ref2va）（14-16、387-390 行）。
- `width/height`：整数，32..8192，必须为 32 的倍数（264-266 行）；由 `shortEdge=768` + aspectRatio 推导为 1344×768 / 768×1344 / 768×768（392-399 行）。
- `length`：5..3600（273 行）；`expectedLength = round(durationSeconds*24)` 再向上对齐到 `17k+5`（401-405 行）；`durationSeconds` 4..15（`production-intent.ts:351`）。示例 8 s → 192。
- generator inputs：fl2va 为 `clip, vae, prompt, width, height, length, first_frame[, last_frame]`；ref2va 为 `clip, vae, audio_vae, prompt, width, height, length, ref_image_size, ref_images.ref_image_{i}`（1..9 张）（413-425、623-641 行）。
- 四组件 bundle：`diffusion=UNETLoader.unet_name`、`textEncoder=CLIPLoader.clip_name`（`type` 必须 `minimax`、`device` 必须 `default`）、`videoVae=VAELoader.vae_name`、`audioVae=VAELoader.vae_name`，每项含 `modelAlias + artifactSha256`，bundle 摘要必须等于 `execution.modelSha256`（39-55、235-250、281-297、458、612-621 行）。
- 音频 VAE：`VAEDecodeAudio.vae` 必须连到 audioVae 节点（689-691 行），`CreateVideo.audio` 连 `VAEDecodeAudio`（694 行），`fps` 必须 24，`bit_depth` 8 或 10（695-697 行）；ref2va 时 generator 的 `audio_vae` 也必须连 audioVae（637 行）。
- 固定 pipeline：`MiniMaxH3SigmaShift(shift_video, shift_audio)`、`BasicGuider`、`BasicScheduler`、`KSamplerSelect`、`RandomNoise`、`SamplerCustomAdvanced(latent_image ← generator 输出 1)`、`VAEDecode`、`VAEDecodeAudio`、`CreateVideo`、`SaveVideo(format=auto, codec=auto)`（63-75、663-702 行）。
- 代表性模板：`hub/examples/production/representative-h3/workflows/h3-fl2va-portrait.json`（节点 10 generator 768×1344×192，11-14 四组件，23 CreateVideo fps 24，100 LoadImage sentinel）；AI-SPEC 9B fixture 567-630 行同构。
- 声明未做过 live `/prompt` 验证（`production-h3-graph.ts:1-5`；AI-SPEC 503-505、520-524 行；example README 20 行）。

### 4.2 VCS

代码库中没有 `MiniMaxH3*` 节点、没有 H3 模型 bundle、没有音频 VAE 角色（grep 仅命中 `tools/video/minimax_video.py`，为 fal.ai 云 API）。最接近的表达是 WAN I2V 的 `WanImageToVideo` 节点 98 打补丁 `width/height/length`（`comfyui_video.py:412`），`fps` 硬编码 16（347 行）。要跑 H3 只能走自定义 `workflow_json + output_node`，此时不注入 prompt/seed/尺寸（309-310 行），模型栈只能由调用方以 `workflow_model_stack` 自述（460-473 行），且 `generate()` 只读 `images/gifs` 分组（`client.py:241`），不处理 `audio`。

## 5. 若两个系统都驱动同一台 ComfyUI+H3，哪一边做执行内核

基于代码事实，WL 的 `ComfyUiAdapter` + `production-h3-graph.ts` 更适合做执行内核，VCS 的 `ComfyUIClient` 适合做就绪探测与 agent 侧调用面。依据：

1. 重复执行防护：WL 预分配 `prompt_id` 并把 body digest 先落盘（`production-adapter.ts:541-578`；AI-SPEC 387-389、407-412 行）；VCS 的 `submit` 不带 `prompt_id`、不持久化返回值，超时后不能按 ID 对账（`client.py:136-182`）。
2. 恢复：WL `inspect` 有 queue/history 交叉与 not-found 语义（738-802 行）；VCS 只有 history 轮询。
3. 取消：WL 有；VCS 无。
4. H3 契约：WL 已把 generator 尺寸/帧长、四组件、音频 VAE、24 fps 编码为可校验契约（第 4.1 节）；VCS 没有 H3 表达。
5. 响应安全边界：WL 限字节、限时、禁 redirect；VCS 无上限。
6. 测试：WL 46 条断言覆盖提交歧义/对账/取消（`test/production-adapter.ts`）；VCS 666 行契约测试覆盖类属性、模板节点、selector，`generate` 的测试通过 monkeypatch 跳过 HTTP（250-283 行）。

WL 做内核时的已知缺口（代码事实）：adapter 不做 `/system_stats`、`/object_info` 就绪探测；输入依赖 `objects/` CAS 目录对 ComfyUI 可见，代码中未见目录映射说明；direct ComfyUI 仅允许 loopback HTTP（`production-runtime-config.ts:329-333`），远程实例必须经 gateway；H3 graph 未经 live 验证。这些缺口 VCS 的 `list_models/check_models/upload_image` 可以补充为探测与开发期工具，但不改变内核归属。

关键事实：
- VCS ComfyUI adapter 已实现并合入：git log 6ec2bbb(2026-04-16)、e3947e1、4c62186、7c4bb08(2026-04-23)、2beda01/37e4ef7(2026-07)，文件 tools/_comfyui/client.py(296行)、comfyui_video.py(473行)、comfyui_image.py(295行)、tests/contracts/test_comfyui_tools.py(666行)
- VCS client.submit 只发 {"prompt": workflow}，无 client_id、无调用方 prompt_id；返回服务端 prompt_id 且不向 ToolResult 透出：tools/_comfyui/client.py:136-155、224-262；comfyui_video.py:337-358
- VCS poll 仅轮询 GET /history/{id}，超时抛 ComfyUIError，不查 /queue：tools/_comfyui/client.py:157-182
- VCS 输入上传走 POST /upload/image multipart，返回名写入 LoadImage 节点 97：client.py:206-218；comfyui_video.py:404-411
- VCS 结果取回 GET /view?filename&subfolder&type，只读 outputs[node]["images"] 或 ["gifs"]：client.py:184-204、241
- VCS 模板注入为硬编码节点 ID 打补丁：I2V 93/97/98/86/108（comfyui_video.py:409-415），T2V 2/11/12/16（372-377），image 4/5/6/7/10/13（comfyui_image.py:206-213）；自定义 workflow 原样提交不注入（comfyui_video.py:309-310）
- VCS 模型就绪用 GET /object_info/{class} 列名比对，健康检查用 GET /system_stats：client.py:49-57、77-130
- VCS 代码库无 MiniMaxH3 节点、无 H3 bundle、无音频 VAE 角色；grep 仅命中 fal.ai 的 tools/video/minimax_video.py；bundled 模型栈只有文件名无 sha256：tools/_comfyui/metadata.py:24-179
- WL ComfyUiAdapter 端点：POST /prompt(body {prompt,client_id,prompt_id}, 556行)、GET /api/jobs/{id}(683)、GET /queue(743,759)、GET /history/{id}(751)、POST /queue delete(818-822)、门控 POST /interrupt(825-829)；不调用 /view、/upload/image、/system_stats、/object_info
- WL remoteJobId 必须是预分配 canonical UUID，prepareSubmission 零网络按真实 body bytes 计算 digest，submitPrepared 重建比对：production-adapter.ts:201-206、541-610
- WL 提交结果分类：4xx 非 408/425/429 → remote-rejected，其余超时/abort/无效响应/prompt_id 不匹配 → submission-unknown 且不再 POST；所有请求 redirect:"error"：production-adapter.ts:244-245、491-498、635-676
- WL inspect legacy 路径先 /queue 再 /history，同 ID 在 queue 多次 → invalid-response，queue 与 terminal history 交叉时第三次读 queue，两边皆无 → not-found：production-adapter.ts:738-802
- WL cancel 总是 POST /queue delete，仅 jobs API 已探测 supported 且 running/pending 时调 /interrupt，返回 confirmed:false：production-adapter.ts:813-838
- WL 输出 locator 解析 images/audio/gifs/videos/video 分组，上限 128 项，路径安全校验：production-adapter.ts:337-374；/view 下载在 production-gateway.ts:812-824、1092-1150
- WL 输入不走 /upload/image：stage gateway 把资产硬链接到 <root>/objects/<namespace>/<sha256>，providerObjectKey 写入 LoadImage.image：production-stage-gateway.ts:1003-1024、1086-1094；production-h3-graph.ts:760-766
- WL H3 generator 契约：class 限定 MiniMaxH3ImageToVideo(fl2va)/MiniMaxH3ReferenceToVideo(ref2va)；width/height 32..8192 且 32 倍数；length 5..3600；shortEdge=768 推导 1344×768/768×1344/768×768；length=round(dur*24) 对齐 17k+5：production-h3-graph.ts:14-16、264-273、387-405
- WL 四组件 bundle：UNETLoader.unet_name、CLIPLoader.clip_name(type=minimax, device=default)、VAELoader×2(videoVae/audioVae)，各带 modelAlias+artifactSha256，bundle sha256 必须等于 execution.modelSha256：production-h3-graph.ts:39-55、235-297、458、612-621
- WL 音频链路：VAEDecodeAudio.vae ← audioVae，CreateVideo.audio ← VAEDecodeAudio，fps 必须 24，bit_depth 8|10；ref2va 时 generator.audio_vae 也必须连 audioVae：production-h3-graph.ts:637、689-697
- WL H3 graph 明确未经 live ComfyUI /prompt 验证：production-h3-graph.ts:1-5；AI-SPEC.md:503-505、520-524；hub/examples/production/representative-h3/README.md:20
- WL 只为 kind:"comfyui" backend 构造 ComfyUiAdapter，direct ComfyUI 仅允许无凭据 literal-loopback HTTP，生产走 credentialed HTTPS gateway：production-runtime-config.ts:329-337、1122-1135
- WL adapter 测试 hub/test/production-adapter.ts 544 行、46 条 ok() 断言，覆盖 body digest/prompt_id(121)、not-found(323,408)、interrupted(390)、重复 ID(414)、cancel 端点(489-510)
- AI-SPEC §7 与代码一致：基线 ComfyUI Core v0.24.0(373行)，history 进程内约 10,000 项重启清空(421-423)，原生 API 无 idempotency 需 gateway/outbox(429-431)，WS 可选无 replay cursor(433-435)
- AI-SPEC 9A 记录 WL 对 VCS 的定位：只交付不可变 handoff，不把导出 JSON 视为已执行：AI-SPEC.md:497-498；production-studio-handoff.ts:1-17

未决问题：
- ComfyUI SaveVideo 节点在 /history outputs 中的分组名（images / gifs / videos）未在本地核实；VCS client.py:241 只读 images/gifs，若实际为 videos 则 bundled WAN 视频流程会报 No output artifacts；WL outputKind 同时处理 gifs/videos/video。
- WL stage gateway 的 objects/ CAS 目录如何对 ComfyUI 进程可见（作为 LoadImage 可解析路径的挂载或 input 目录映射）在已读代码与 representative-h3 README 中未找到说明。
- MiniMaxH3ImageToVideo / ReferenceToVideo 的官方输入 schema（ref_image_size 取值、length 上限、是否强制 32 对齐）未与 ComfyUI 源码 nodes_minimax_h3.py 本地比对；WL 的边界值来自 production-h3-graph.ts 与 AI-SPEC 引用的官方文档。
- VCS retry_policy(max_retries=1, retryable_errors=["timeout"]) 在 base_tool 执行器中是否会触发二次 POST /prompt 未读 base_tool.py 确认。
- VCS tests/contracts/test_comfyui_tools.py 与 WL hub/test/production-adapter.ts 当前是否全部通过未运行验证（本任务只读）。

---

# MAP vcs-comfy-h3

# Citronetic/video-creation-studio 架构与生产流程

仓库路径：`/Users/shuai/workspace/citronetic/video-creation-studio`。本仓库是 OpenMontage 的私有 fork，README.md:1-14 说明定位：Codex 承担研究、创意、脚本、分镜、供应商选择、审批与质检；OpenMontage 提供媒体工具、项目状态、渲染与 12 条流水线。`docs/stage-gates/` 目录只含 `.gitkeep`（来自初始提交 a3e735c），没有任何文档。

## 1. 分层架构

PROJECT_CONTEXT.md:9-19 与 docs/ARCHITECTURE.md:82-94 定义核心原则：没有 Python 编排器、没有 Python 审稿器、运行时不调用 LLM API。Agent（Codex）读取 YAML 清单与 Markdown 技能后调用 Python 工具并写 checkpoint。

三层知识结构（PROJECT_CONTEXT.md:33-41）：
- Layer 1 `tools/`：`tools/base_tool.py`（ToolContract；`ToolResult` 字段 success/data/artifacts/error/cost_usd/seed/model，base_tool.py:109-115）、`tools/tool_registry.py`（`pkgutil` 自动发现，`discover` 95、`get_by_capability` 130、`provider_menu_summary` 293）、`tools/cost_tracker.py`。
- Layer 2 `skills/`：`skills/INDEX.md` 索引；`skills/pipelines/<pipeline>/<stage>-director.md` 阶段导演技能；`skills/meta/`（reviewer、checkpoint-protocol、video-reference-analyst、taste-direction、bespoke-composition 等）；`skills/creative/`（video-gen-prompting、prompting/seedance-prompting 等）。
- Layer 3 `.agents/skills/`：82 个外部技术技能（seedance-2-0、remotion、hyperframes、ffmpeg 等）。

核心 Python 库 `lib/`：`checkpoint.py`（状态持久化与门禁）、`pipeline_loader.py`（清单加载与校验）、`delivery_promise.py`（交付类型与运动比例校验）、`scoring.py`（供应商加权评分）、`shot_prompt_builder.py`（镜头 prompt 组装）、`media_profiles.py`（平台渲染档案）、`source_media_review.py`（用户素材探测）、`events.py`（工具事件流）、`paths.py`（`PROJECTS_DIR`，可由 `OPENMONTAGE_PROJECTS_DIR` 覆盖，paths.py:13-18）、`config_model.py`（Pydantic 配置）。

## 2. Codex-native 主流程

入口技能 `skills/video-creation-studio/SKILL.md` 与 `references/execution-contract.md`。控制面是 `skills/video-creation-studio/scripts/studio.py`，四个确定性命令（studio.py:610-615）：`doctor`（能力菜单，输出 `openai_api_required: false`，328-375）、`pipelines`（清单目录，378-396）、`init`（调用 `lib.checkpoint.init_project`，拒绝 `framework-smoke` 与改写已绑定流水线，430-469）、`status`（读取 checkpoint 推导 `next_stage` 与 `next_action`：run_stage/resume_stage/awaiting_human_approval/repair_or_retry_stage/pipeline_complete，490-577）。该脚本不含 LLM 客户端、不调用供应商（docstring 2-8）。

标准循环（execution-contract.md:25-46）：doctor → 分类输入（参考视频 / 待剪素材 / 原创）并选一条流水线 → `init_project` → 提出创意、供应商候选、渲染选项、成本估算 → `get_next_stage` 定位 → 逐阶段读取 director 技能执行 → 校验 `produces` 声明的工件并按 `review_focus`/`success_criteria` 自审 → `write_checkpoint` → 遇 `human_approval_default: true` 停止 → compose 与 final_review 通过后 publish（本地导出打包）。

规范阶段顺序：`research → proposal → script → scene_plan → assets → edit → compose → publish`，或以 `idea` 起步（lib/checkpoint.py:27-40 `STAGES` 与 `CANONICAL_STAGE_ARTIFACTS`）。补充工件 `source_media_review`、`final_review`、`video_analysis_brief`（checkpoint.py:44-48）。

## 3. 12 条流水线及阶段（pipeline_defs/，另有测试用 framework-smoke）

| 流水线 | stability | 阶段 | 人工审批阶段 |
|---|---|---|---|
| animated-explainer | production | research, proposal(+sample), script, scene_plan, assets, edit, compose, publish | proposal, script, scene_plan, assets, publish |
| animation | production | 同上（proposal 含 sample） | 同上 |
| cinematic | production | research, proposal(+sample), script, scene_plan, assets, edit, compose, publish（cinematic.yaml:58-274） | proposal, script, scene_plan, assets, publish |
| character-animation | beta | research, proposal(+sample), script, character_design, rig_plan, scene_plan, assets, edit, compose, publish | proposal, script, character_design, scene_plan, assets, publish |
| documentary-montage | beta | idea, scene_plan, assets, edit, compose | idea, scene_plan, assets, edit |
| talking-head | beta | idea, script, scene_plan, assets, edit, compose, publish | idea, script, scene_plan, assets, publish |
| screen-demo | production | 同 talking-head；production_modes real_capture / synthetic_terminal（screen-demo.yaml:24-32） | 同上 |
| clip-factory | beta | idea…publish | 同上 |
| podcast-repurpose | beta | idea…publish | 同上 |
| hybrid | production | idea…publish | 同上 |
| avatar-spokesperson | production | idea…publish | 同上 |
| localization-dub | beta | idea…publish | 同上 |

`reference_input.supported: true` 的流水线：animated-explainer、animation、cinematic、character-animation（cinematic.yaml:13-21）。清单 schema `schemas/pipelines/pipeline_manifest.schema.json`：stage 字段 `skill/produces/tools_available/required_tools/review_focus/success_criteria/checkpoint_required/human_approval_default/sub_stages`（44-117）；`orchestration.max_revisions_per_stage/max_send_backs/max_wall_time_minutes`（153-165）；`extensions.custom_tools` 默认 false（166-176），`check_extension_permitted` 在 pipeline_loader.py:201-228 强制。

## 4. projects/<id>/ 布局

`init_project`（lib/checkpoint.py:204-253）创建 `artifacts/`、`assets/images|video|audio|music`、`renders/` 并写 `project.json`（version、created_at、project_id、title、pipeline_type、style_playbook）。运行期新增：
- `checkpoint_<stage>.json`（checkpoint.py:200-201）；schema 字段 version/project_id/pipeline_type/stage/status(completed|failed|awaiting_human|in_progress)/timestamp/checkpoint_policy/human_approval_required/human_approved/artifacts/review/cost_snapshot/error/metadata（schemas/checkpoints/checkpoint.schema.json:7-45）。写入先落 `.json.tmp` 再 `os.replace`（checkpoint.py:484-491）。
- `history/checkpoint_<stage>_<stamp>.json`：被替代的非 in_progress checkpoint 复制存档（289-325）。
- `decision_log.json`：追加式合并，按 decision_id 去重（328-359），并把路径回写到 proposal_packet.production_plan.decision_log_ref / render_report（459-474）。
- `cost_log.json`：CostTracker 持久化（tools/cost_tracker.py:530-544）。
- `events.jsonl`：BaseTool 自动插桩写入的 start/finish/error 事件（tools/base_tool.py:126-213；lib/events.py:77-95），项目归属由输入路径推断（events.py:46-74）。
- `artifacts/*.json`：research_brief、brief、proposal_packet、script、scene_plan、asset_manifest、edit_decisions、render_report、final_review、publish_log、decision_log（backlot/state.py:219-231）。
- `assets/sample/sample_v{N}.mp4`（样片）、`snapshots/<scene_id>.png`（atelier 场景审批静帧）、`hyperframes/`（HyperFrames 工作区，video_compose.py:1533-1536）、`renders/final.mp4`。

Backlot（`backlot/`）是只读观察板：`python -m backlot open <id>` 启动 uvicorn 服务并打开浏览器，失败不阻塞（backlot/__main__.py:55-79）；`backlot/state.py:load_board_state`（576-646）从 project.json、清单、checkpoint、history、artifacts、events.jsonl、renders 推导阶段轨道、分镜卡片（scene_plan × script × asset_manifest 连接，391-483）、成本、停滞检测（618-626）与门禁审计 `gate_skipped`（169-178）。

## 5. 镜头（shot）数据结构

系统中没有独立的 `shot` 类型；镜头信息分布在三个工件与供应商工具输入中。

（a）`scene_plan.scenes[]`（schemas/artifacts/scene_plan.schema.json:15-110）：必填 id/type/description/start_seconds/end_seconds；type 枚举 talking_head/broll/animation/character_scene/diagram/text_card/transition/generated/screen_recording；可选 script_section_id、framing、movement、transition_in/out、overlay_notes、`shot_language{shot_size, camera_movement, lens_mm(14-200), lighting_key, depth_of_field, color_temperature}`（31-52）、shot_intent、narrative_role、information_role、hero_moment、character_actions、texture_keywords、`required_assets[{type, description, source: generate|source|provided|record}]`。

（b）prompt 构造：Python 侧 `lib/shot_prompt_builder.py:build_shot_prompt`（82-143）把 shot_language 映射为五层自然语言：Layer1 相机（lens_mm、DoF）、Layer2 运动（shot_size、camera_movement，static 不输出）、Layer3 主体（description + texture_keywords）、Layer4 光线（lighting_key、color_temperature）、Layer5 风格（playbook 的 aesthetic/mood）；`build_batch_prompts` 跳过 transition 场景（146-166）。技能侧要求五方面骨架 Subject / Subject Motion / Scene / Spatial Framing / Camera（skills/creative/video-gen-prompting.md:37-49），Seedance 采用 8 组件结构与多镜头身份锚点逐字重复（skills/creative/prompting/seedance-prompting.md:23-56）；cinematic scene-director 要求每个 hero frame 覆盖五方面（skills/pipelines/cinematic/scene-director.md:50-62）；asset-director 要求 pre/critique/post 三步自审并记录在 asset 元数据（skills/pipelines/cinematic/asset-director.md:104-118）。

（c）`asset_manifest.assets[]`（schemas/artifacts/asset_manifest.schema.json:14-56）：id/type/path/source_tool/scene_id 必填，另有 prompt、seed、model、cost_usd、duration_seconds、resolution、provider、license、original_url、voice_performance。

（d）`edit_decisions.cuts[]`（schemas/artifacts/edit_decisions.schema.json:10-64）：id/source（asset id 或路径）/in_seconds/out_seconds、speed、layer、transform{scale,position,animation,crop}、transition_in/out/duration、reason；顶层必填 `render_runtime`，另有 renderer_family、composition_mode、bespoke、overlays、audio、subtitles。

（e）首尾帧与参考图的传入：由供应商工具输入决定。`tools/video/seedance_volcengine.py` 输入 schema（120-168）：operation 枚举 text_to_video/image_to_video/reference_to_video/first_last_frame_to_video；`image_url/image_path`、`first_frame_url/first_frame_path`、`last_frame_url/last_frame_path`、`reference_image_urls/paths`（≤9）、`reference_video_urls`（≤3）。请求构造按 operation 赋 role（first_frame/last_frame/reference_image/reference_video，310-357）；本地图片 base64 编码为 data URL，单图 ≥30MB 拒绝（272-278），请求体 ≥64MB 拒绝（380）；不支持 seed（supports 89-100）。`tools/video/veo_video.py` 使用同一组键（132-153），backend 枚举 auto/google/fal（83-87），reference/1080p/4k 强制 8 秒（343-357）。`video_selector` 在 image_to_video 时把 `reference_image_path` 上传 fal 转 `image_url`（tools/video/video_selector.py:307-315）。旧版参考工作流的 blueprint `shots[]`（skills/reference-video-studio/assets/blueprint.schema.json:59-85）直接携带这些键，`_shot_inputs` 原样映射并解析本地路径（skills/reference-video-studio/scripts/studio.py:507-549）。scene_plan 与 asset_manifest schema 没有首尾帧字段；在正式流水线中由 agent 在 assets 阶段按 director 技能把已生成的图片路径作为工具输入传入。

## 6. 审批与成本门

成本：`BaseTool.estimate_cost`（base_tool.py:354）为每次调用预估；`CostTracker` 生命周期 estimate → reserve → reconcile/refund（cost_tracker.py:114-222）。默认 `mode: observe`、`total_usd: null`（config.yaml:9-14；lib/config_model.py:35-42）；`reserve` 仅在 WARN/CAP 且配置阈值时抛 `ApprovalRequiredError`/`BudgetExceededError`（147-178）；`cost_snapshot` 在无上限时返回 `budget_verdict: no_budget_set`（96-110）。AGENT_GUIDE.md:112-123 与 execution-contract.md:78-98 规定：成本只记录、不构成暂停条件；proposal_packet 设 `cost_estimate.budget_verdict: "no_budget_set"`，审批对象是精确供应商/模型与创意方案。

审批门（stage gate）：清单 `human_approval_default` 为唯一权威（checkpoint-protocol.md:104-108）。`write_checkpoint`（lib/checkpoint.py:362-493）从 project.json 回填 pipeline_type（382-392），经 `_stage_requires_approval`（256-286，未知 pipeline_type 抛错、fail-closed）读取清单；被门禁阶段写 `completed` 而 `human_approved` 非 True 时抛 `GATE VIOLATION`（404-431）。协议（checkpoint-protocol.md:110-149）：写 `awaiting_human` → 展示工件摘要、审查结论、成本快照 → 结束回合 → 用户批准后重写 `completed, human_approved=True`；审批按门逐次生效，全程预授权必须记录为 decision_log `approval_policy`。同时 `completed/awaiting_human` 必须含 `produces` 声明的全部工件并通过 schema 校验（104-163）。测试 tests/backlot/test_gate_scenarios.py:31-50 覆盖门禁违规与拼写错误 fail-closed。

样片（sample）：清单 `sub_stages`（cinematic.yaml:103-112、animated-explainer.yaml:105-114、animation.yaml:110-119、character-animation.yaml:97-111），condition `video_analysis_brief_exists` 或 `approved_concept_exists`，`human_approval_default: true`。子阶段不是 checkpoint 阶段（`get_stage_order(include_sub_stages=True)` 输出 `proposal.sample`，pipeline_loader.py:125-149）；执行方式为 proposal 检查点 `metadata.sub_stage: "sample"`，输出存 `assets/sample/`（execution-contract.md:141-145；checkpoint-protocol.md:202-234）。assets 阶段还要求每类付费资产先出一个样本再批量（cinematic asset-director.md:52-71；explainer asset-director.md:68-79，最多 3 轮）。

完整运行：assets 门审阅逐场素材（filmstrip/snapshots），不得用完整渲染替代审阅；compose 只在 assets 批准后运行（checkpoint-protocol.md:151-167）。

旧版 reference-video-studio 的四步门：`validate-blueprint` → `estimate`（返回 `blueprint_sha256`，studio.py:551-583，hash 见 310-312）→ `generate --dry-run` → `generate --approved-blueprint-sha256 <hash> --sample-shot <id>` → 同 hash 全量；hash 不匹配拒绝（636-651）；失败不换供应商并写 `generation_report.json` 含 `provider_job_may_still_be_running`/`provider_task_id`（673-696）。`--approved-budget-usd` 仍可解析但被忽略（docs/CODEX_VIDEO_STUDIO_GUIDE_ZH.md:944）。

## 7. 其他质量门

- reviewer 元技能：每阶段自审，advisory，最多 2 轮，critical 须附 proposed_fix（skills/meta/reviewer.md:1-60；AGENT_GUIDE.md:593-602）。
- 编排限制：`max_revisions_per_stage: 3`、`max_send_backs: 3`、`max_wall_time_minutes: 12`（cinematic.yaml:23-28）。
- 合成前校验 `_pre_compose_validation`（tools/video/video_compose.py:1190-1291）：`DeliveryPromise.validate_cuts` 运动比例（lib/delivery_promise.py:113-193，motion_led 要求 ≥70% 真实运动切片、禁止静帧回退）、slideshow 风险评分 fail 阻断、缺 renderer_family 阻断。
- 渲染后 `_run_final_review`（1975）附加到结果，status fail 时返回失败（1470-1490），并检测 render_runtime 与 proposal 不一致（2202-2244）。

## 8. 供应商选择的决策层

决策在 proposal 阶段由 agent 做出并写入 `proposal_packet.production_plan`：stages[].tools[].provider/why_this_provider、provider_rankings、delivery_promise、renderer_family、render_runtime、composition_mode、voice_selection、music_source（schemas/artifacts/proposal_packet.schema.json:67-280），并记 decision_log `provider_selection`/`render_runtime_selection`/`composition_mode`（decision_log.schema.json:25-46）。execution-contract.md:85-88 要求先以 `operation: rank` 调用 selector 展示排序，再用 `preferred_provider`/`allowed_providers` 锁定执行。

Python 执行层：`video_selector.execute`（tools/video/video_selector.py:274-332）rank 模式返回 `lib.scoring.rank_providers` 结果；生成模式 `_select_best_tool`（334-403）先按 `allowed_providers` 过滤，`preferred_provider` 仅在与最高分差距 ≤0.15 时生效（28、384-396）。评分权重 task_fit 0.30/output_quality 0.20/control 0.15/reliability 0.15/cost_efficiency 0.10/latency 0.05/continuity 0.05（lib/scoring.py:36-45），含同义词扩展、参考条件加分、cinematic 高级特性加分（373-530）。供应商内部后端选择：veo `backend=auto` 按凭据选 google/fal（veo_video.py:265-270）；seedance 校验 `model` 与 `model_variant` 一致（seedance_volcengine.py:231-249）。

合成运行时：Remotion 与 HyperFrames 同时可用时必须都展示（AGENT_GUIDE.md:144-158）；锁定在 `proposal_packet.production_plan.render_runtime`，原样带入 `edit_decisions.render_runtime`。

## 9. 渲染合成如何接收供应商输出

供应商工具把 MP4 写到调用方指定的 `output_path`（Seedance 立即下载并返回 task_id、operation、last_frame_url，seedance_volcengine.py:555-600），`ToolResult` 携带 artifacts/cost_usd/model/seed；agent 将其登记为 `asset_manifest.assets[]`（path 位于 projects/<id>/assets/video）。edit 阶段 cuts.source 引用 asset id。

`video_compose._render`（video_compose.py:1296-1493）：要求 `edit_decisions.render_runtime` 非空且合法（1319-1348）；`composition_mode: atelier` 且 remotion 时走 `_render_via_atelier`（717、1351-1357）；否则用 asset_manifest 建 id→path 映射解析 cuts（1366-1377），执行 `_pre_compose_validation`，按 runtime 分派：`_render_via_hyperframes`（1495-1611，不可用时返回阻断而不切换）、`_render_via_ffmpeg`（1613-1671，调用 `_compose` 做 concat/音频/字幕，390-）、Remotion `_remotion_render`（1673-，cuts.source 转 file:// URI 1706-1713，props JSON 交 `npx remotion render`，组件映射见 remotion-composer/SCENE_TYPES.md:11-27：无 type 的 mp4 走 OffthreadVideo、图片走 Img+Ken Burns、text_card/stat_card/charts/terminal_scene 等走 React 组件）。`_needs_remotion` 在 Remotion 可用时恒为 True（1150-1188）。输出档案由 `lib/media_profiles.py`（youtube_landscape/shorts/tiktok/cinematic 等，42-128；`ffmpeg_output_args` 155-165）决定。compose 阶段产出 `render_report` 与 `final_review`（cinematic.yaml:223-225）。旧版参考流程用 `VideoStitch` 拼接 `clips/NNN-<id>.mp4`（reference studio studio.py:729-770）。

## 10. Codex-native 的含义：技能 prompt 与 Python 的分工

技能 prompt（Markdown）承担：流水线路由（pipeline-routing.md）、阶段循环与停止规则（execution-contract.md）、创意工作（研究、概念、脚本、分镜、prompt 撰写与自审）、供应商候选展示与审批语义、运行时/authoring mode 双决策、blocker 上报格式、decision_log 记录规则、参考视频的视觉解读（video-reference-analyst.md:98-120 要求 Codex 直接查看关键帧，不调用外部视觉 API）。

Python 承担确定性逻辑：能力发现与安全菜单（studio.py `_safe_provider_menu` 177-245 含密钥脱敏）、清单/工件/checkpoint schema 校验、门禁强制、历史存档、decision_log 合并、成本记录、供应商评分与锁定、供应商 API 调用/轮询/下载/计费、交付承诺与 slideshow 风险校验、渲染分派与 final review、用户素材探测（lib/source_media_review.py:308、502）、事件流与 Backlot。

安装方式：把两个技能目录软链接到 `~/.codex/skills/`（README.md:18-23）；`.codex/prompts/` 另有 backlot、ink-art、animated-drawing。`reference-video-studio` 仅作本地分析器或显式旧版独立流程，不替代正式项目状态（execution-contract.md:133-150）。

## 11. 最近 3 个 Citronetic 提交（作者 kl704，2026-07-17）

- `6de3251` Add Codex-native video creation studio（15:50，19 文件 +4920）：新增 `skills/reference-video-studio/`（SKILL.md、canvas 前后端 server.py/app.js/index.html/styles.css、scripts/studio.py 914 行、blueprint.schema.json、blueprint-example.json、references/providers.md、analysis-requirements.txt）、`tools/video/seedance_volcengine.py`（610 行官方 Ark 适配器）及测试、docs/PROVIDERS.md、.env.example、README。
- `7161c26` feat: add Codex-native video creation studio（18:06，33 文件 +2675/-195）：新增 `skills/video-creation-studio/`（SKILL.md、execution-contract.md、pipeline-routing.md、scripts/studio.py 658 行、agents/openai.yaml）；修改 lib/checkpoint.py(+54)、lib/env_loader.py、lib/source_media_review.py(+292)、schemas cost_log/decision_log/pipeline_manifest、tools/base_tool.py、cost_tracker.py、tool_registry.py、video-reference-analyst.md；新增多组测试。
- `99ab86f` feat: remove budget gates and add Chinese studio guide（18:35，60 文件 +1773/-338）：config.yaml budget `mode: warn→observe`、`total_usd: 10.00→null`、阈值置 null；lib/config_model.py BudgetConfig 默认值同步；tools/cost_tracker.py 默认 OBSERVE/None，`cost_snapshot` 增加 `budget_verdict`，无上限时不写 `budget_total_usd`；12 个 pipeline_defs 删除 `budget_default_usd`；新增 docs/CODEX_VIDEO_STUDIO_GUIDE_ZH.md（1184 行）；ARCHITECTURE.md「Budget Governance」改为「Cost Observability」；多份 executive-producer/proposal-director 技能删除预算上限措辞；两个 studio 技能及测试同步更新。

关键事实：
- 无 Python 编排器，agent 读 YAML+MD 驱动流水线：PROJECT_CONTEXT.md:9-19，docs/ARCHITECTURE.md:82-94
- studio.py 四个确定性命令 doctor/pipelines/init/status，不含 LLM 客户端：skills/video-creation-studio/scripts/studio.py:2-8, 610-615
- init_project 创建 artifacts/、assets/{images,video,audio,music}、renders/ 与 project.json：lib/checkpoint.py:204-253
- checkpoint 文件为 projects/<id>/checkpoint_<stage>.json，被替代版本复制到 history/：lib/checkpoint.py:200-201, 289-325
- 门禁强制：human_approval_default 阶段写 completed 且 human_approved 非 True 抛 GATE VIOLATION：lib/checkpoint.py:404-431
- 未知 pipeline_type 时 fail-closed 抛错：lib/checkpoint.py:256-286；测试 tests/backlot/test_gate_scenarios.py:42-50
- decision_log 追加式合并并回写 decision_log_ref：lib/checkpoint.py:328-359, 459-474
- PROJECTS_DIR 可由 OPENMONTAGE_PROJECTS_DIR 覆盖：lib/paths.py:13-18
- 预算默认 observe、total_usd null，reserve 仅在 WARN/CAP 抛错：config.yaml:9-14，lib/config_model.py:35-42，tools/cost_tracker.py:147-178
- cost_snapshot 无上限时返回 budget_verdict no_budget_set：tools/cost_tracker.py:96-110
- 样片为 proposal 的 sub_stage，条件 video_analysis_brief_exists，不是 checkpoint 阶段：pipeline_defs/cinematic.yaml:103-112，lib/pipeline_loader.py:125-149，execution-contract.md:141-145
- assets 门要求逐场审阅，compose 仅在 assets 批准后运行：skills/meta/checkpoint-protocol.md:151-167
- 旧版参考流程用 blueprint SHA-256 绑定审批，hash 不匹配拒绝生成：skills/reference-video-studio/scripts/studio.py:310-312, 644-648
- scene_plan.scenes[].shot_language 字段 shot_size/camera_movement/lens_mm/lighting_key/depth_of_field/color_temperature：schemas/artifacts/scene_plan.schema.json:31-52
- build_shot_prompt 五层组装 camera/movement/subject/lighting/style：lib/shot_prompt_builder.py:82-143
- Seedance 输入含 first_frame_url/path、last_frame_url/path、reference_image_urls/paths(≤9)、reference_video_urls(≤3)：tools/video/seedance_volcengine.py:158-168
- Seedance 本地图片 base64 编码为 data URL，单图 30MB、请求体 64MB 上限，不支持 seed：tools/video/seedance_volcengine.py:272-278, 380, 89-100
- Veo backend auto 按凭据选 google/fal，reference/1080p/4k 强制 8 秒：tools/video/veo_video.py:265-270, 343-357
- video_selector preferred_provider 仅在与最高分差距 ≤0.15 时生效，allowed_providers 过滤候选：tools/video/video_selector.py:28, 347-350, 384-396
- 供应商评分权重 task_fit 0.30/quality 0.20/control 0.15/reliability 0.15/cost 0.10/latency 0.05/continuity 0.05：lib/scoring.py:36-45
- render_runtime 锁定于 proposal_packet.production_plan 并带入 edit_decisions，video_compose 缺失或非法时拒绝：schemas/artifacts/proposal_packet.schema.json:153-157，tools/video/video_compose.py:1319-1348
- video_compose 用 asset_manifest 解析 cuts.source 后按 hyperframes/ffmpeg/remotion 分派，不可用时返回阻断不切换：tools/video/video_compose.py:1366-1421, 1495-1520
- 合成前校验 delivery promise 运动比例与 slideshow 风险，失败阻断渲染：tools/video/video_compose.py:1190-1291，lib/delivery_promise.py:113-193
- Remotion 路径把 cuts.source 转 file:// URI 交 npx remotion render；cut.type 到组件映射见 remotion-composer/SCENE_TYPES.md:11-27；tools/video/video_compose.py:1706-1713
- BaseTool 自动插桩写 events.jsonl 供 Backlot：tools/base_tool.py:126-213，lib/events.py:77-95
- Backlot 只读推导状态，含 gate_skipped 审计与停滞检测：backlot/state.py:169-178, 618-626
- docs/stage-gates/ 仅含 .gitkeep，无文档：来自初始提交 a3e735c
- 提交 99ab86f 将 budget mode warn→observe、total_usd 10→null 并删除清单 budget_default_usd：git show 99ab86f config.yaml/lib/config_model.py/tools/cost_tracker.py
- 提交 7161c26 新增 skills/video-creation-studio（studio.py 658 行）；提交 6de3251 新增 skills/reference-video-studio 与 tools/video/seedance_volcengine.py（610 行）：git log -3 --stat

未决问题：
- docs/stage-gates/ 为空目录（仅 .gitkeep），仓库内没有名为 stage gates 的独立文档；本报告以清单 human_approval_default + checkpoint 门禁 + reviewer + 合成前校验作为 stage gate 的实际实现，未找到进一步的正式定义。
- 正式流水线中首尾帧/参考图如何从 assets 阶段的图片绑定到视频生成调用：scene_plan 与 asset_manifest schema 没有 first_frame/last_frame 字段，grep 各 director 技能也未见明确指引（仅 docs/PROVIDERS.md:92 提及工具能力）；目前只能由 agent 在调用工具时手动传参。
- config.yaml 的 checkpoint.storage_dir: pipeline 与 lib/paths.py 的 projects/ 根目录不一致，未验证 config 值是否在任何代码路径中被读取。
- video_compose 解析 asset path 时按原字符串使用（1366-1377），未验证相对路径在非仓库根目录 cwd 下的行为。
- skills/reference-video-studio/canvas/server.py（677 行）与 hyperframes_compose.py 未逐行阅读；canvas 的审批门实现细节未核对。
- fork 基线：git log 显示上游 PR 合并记录（#354/#363/#325/#323）在三个 Citronetic 提交之前，具体基于上游哪个 tag 未查明。

---

# MAP provider-apis

# video-creation-studio provider 抽象层还原

仓库根：`/Users/shuai/workspace/citronetic/video-creation-studio`。下文路径均相对该目录。

## 0. `lib/providers/` 的实际状态

- `lib/providers/` 仅含一个 0 字节的 `__init__.py`，没有任何代码。`docs/ARCHITECTURE.md:41` 标注为「Reserved for future provider abstractions」。
- 实际的 provider 抽象层位于 `tools/base_tool.py`（基类与数据类型）、`tools/tool_registry.py`（自动发现与注册）、`lib/scoring.py`（排序打分）、`tools/video/video_selector.py`（能力级路由），以及 `tools/<family>/*.py` 下的具体 provider 类。

## 1. 基类 / 协议：`tools/base_tool.py`

**类：`BaseTool(ABC)`** (`tools/base_tool.py:205`)。子类通过类属性声明能力，只有一个抽象方法。

类属性（声明方式，`:216-270`）：
- 身份：`name`、`version`、`tier: ToolTier`、`stability: ToolStability`、`execution_mode: ExecutionMode`、`determinism: Determinism`、`runtime: ToolRuntime` (`:216-222`)。
- 依赖：`dependencies: list[str]`，前缀 `cmd:`/`binary:`/`env:`/`python:`，由 `check_dependencies()` (`:282-305`) 解析；`install_instructions` (`:226-227`)。
- 能力声明：`capability`（能力族，selector 按此聚合）、`provider`（厂商名）、`capabilities: list[str]`（操作列表）、`input_schema`/`output_schema`/`artifact_schema`（JSON Schema dict）、`supports: dict[str, Any]`（特性开关）、`best_for`/`not_good_for`、`provider_matrix` (`:230-240`)。
- 资源与重试：`resource_profile: ResourceProfile`、`retry_policy: RetryPolicy` (`:243-244`)。
- 幂等：`resume_support`、`idempotency_key_fields` (`:247-248`)；`side_effects`、`fallback`、`fallback_tools` (`:251-253`)；`agent_skills`（指向 `.agents/skills/` 的 Layer 3 skill，`:259`）；`user_visible_verification` (`:262`)；打分提示 `quality_score`/`historical_success_rate`/`latency_p50_seconds` (`:268-270`)。

方法签名：
- `get_status(self) -> ToolStatus` (`:274`)：默认调用 `check_dependencies()`，多数 API provider 重写为检查环境变量。
- `get_info(self) -> dict` (`:307-350`)：注册表/菜单读取的契约快照。
- `estimate_cost(self, inputs: dict) -> float` (`:354`)、`estimate_runtime(self, inputs) -> float` (`:358`)，默认 0。
- `idempotency_key(self, inputs) -> str` (`:364`)。
- `execute(self, inputs: dict[str, Any]) -> ToolResult`，`@abstractmethod` (`:372-375`)。
- `dry_run(self, inputs) -> dict` (`:377-385`)。
- `run_command(...)` (`:389-431`) 子进程封装。

请求类型：所有 provider 接收 `dict[str, Any]`，没有 pydantic 请求模型；`input_schema` 只是声明，基类不做校验。

响应类型：`@dataclass ToolResult` (`:108-118`)，字段 `success, data: dict, artifacts: list[str], error: Optional[str], cost_usd, duration_seconds, seed, model`。

其他数据类型：`ResourceProfile` (`:90-97`)、`RetryPolicy` (`:100-105`)；枚举 `ToolTier` (`:43`)、`ToolStability` (`:53`)、`ToolStatus` (`:59`, AVAILABLE/UNAVAILABLE/DEGRADED)、`ToolRuntime` (`:65`)、`ExecutionMode` (`:73`)、`Determinism` (`:78`)、`ResumeSupport` (`:84`)。

错误类型：`DependencyError(Exception)` (`:456`)、`ToolCommandError(subprocess.CalledProcessError)` (`:434-453`)。API provider 的运行时错误统一以 `ToolResult(success=False, error=...)` 返回，不抛出。

自动埋点：`__init_subclass__` (`:208-213`) 用 `_instrument_execute` (`:126-202`) 包装每个具体 `execute`，向项目 `events.jsonl` 写 start/finish/error 事件。模块导入时执行 `_load_dotenv()` (`:28-40`) 读取仓库 `.env`。

## 2. 注册表：`tools/tool_registry.py`

- `ToolRegistry` (`:56`)；`discover(package_name="tools")` (`:95-111`) 用 `pkgutil.walk_packages` 导入 `tools` 包全部模块，`register_module` (`:74-85`) 实例化模块内定义的非抽象 `BaseTool` 子类并按 `tool.name` 登记；跳过 `base_tool`/`tool_registry`。单例 `registry` (`:469`)。
- 查询：`get_by_capability` (`:130`)、`get_by_provider` (`:134`)、`find_by_capability` (`:154`)、`find_fallback` (`:161-173`)、`capability_catalog` (`:189`)、`provider_catalog` (`:199`)、`provider_menu` (`:226-291`，排除 `provider == "selector"`)、`provider_menu_summary` (`:293-448`，按 `env:` 依赖生成 `setup_offers`，`:397-415`）。

## 3. 已实现 provider 清单

### 3.1 video_generation（`tools/video/`）
| 工具名 | provider | 网关/端点 | 操作 | 备注 |
|---|---|---|---|---|
| `seedance_volcengine` | seedance | Volcengine Ark 官方 | t2v / i2v 首帧 / 首尾帧 / 参考图+视频+音频 | 见 §4 |
| `seedance_video` | seedance | fal.ai `queue.fal.run/bytedance/seedance-2.0[/fast]/<op>` (`seedance_video.py:196-199,260`) | t2v / i2v(+`end_image_url` 尾帧) / reference | seed 支持 (`:211-212`)，分辨率 480p/720p (`:102-106`)，参考图 9/3/3 (`:228-251`)，轮询每 5s 无上限 (`:270-281`)，成本 0.3034/0.2419 USD/s (`:170-175`) |
| `seedance_replicate` | seedance | Replicate `api.replicate.com/v1/models/bytedance/seedance-2.0[-fast]/predictions` (`seedance_replicate.py:158-160,184`) | t2v / i2v(`image` 字段 `:173-174`) | `Prefer: wait=60` (`:179`)，轮询每 3s (`:194-201`)，成本 0.30/0.24 USD/s (`:135-141`) |
| `veo_video` | veo | `backend` auto/google/fal (`veo_video.py:83-88`) | t2v / i2v / reference / first_last_frame | 见 §5 |
| `kling_video` | kling | fal.ai `queue.fal.run/fal-ai/kling-video/<variant>/<op>` (`kling_video.py:134,152`) | t2v / i2v(`image_url`) | variant v3/standard、v2.1/master|pro|standard (`:72`)，duration 5/10 (`:77`)，比例 16:9/9:16/1:1 (`:83`)，成本 0.10/0.20/0.30 per 5s (`:107-114`) |
| `kling_official_video` | kling_official | 官方 API | t2v / i2v(首帧+`image_tail` 尾帧) / reference(omni) | 见 §6 |
| `minimax_video` | minimax | fal.ai `minimax/<variant>/...` (`minimax_video.py:128-134`) | t2v / i2v | |
| `grok_video` | grok | `api.x.ai/v1/videos/generations` (`grok_video.py:240`)，轮询 `/v1/videos/{id}` (`:255`) | t2v / i2v / reference | 480p 0.05、720p 0.07 USD/s (`:172`) |
| `runway_video` | runway | `api.dev.runwayml.com/v1/{text,image}_to_video` (`runway_video.py:193-195`) | t2v / i2v | 默认 `model=seedance_2.0` (`:53`)，payload `promptText/duration/ratio/watermark` (`:180-186`) |
| `higgsfield_video` | higgsfield | `platform.higgsfield.ai/v1/generations` (`higgsfield_video.py:202`) | t2v / i2v | 默认 `seedance_2.0` (`:30`) |
| `heygen_video` | heygen | `api.heygen.com/v1/workflows/executions` (`_shared.py:531`) | t2v / i2v | provider_variant 表 `_shared.py:15-33`，Seedance 仅 1.x |
| `sora_video` | openai | OpenAI SDK | t2v / i2v | 模型 sora-2/sora-2-pro (`sora_video.py:29`) |
| `gemini_omni_video` | gemini_omni | `generativelanguage.googleapis.com/v1beta` (`gemini_omni_video.py:38`) | t2v / i2v / reference / edit_video | |
| `comfyui_video` | comfyui | 本地/远程 ComfyUI | t2v / i2v / custom_workflow | `supports.custom_workflow` (selector 特判) |
| `wan_video` / `hunyuan_video` / `cogvideo_video` / `ltx_video_local` | 本地 GPU | diffusers（`_shared.py:300-383`） | t2v / i2v | 需 `VIDEO_GEN_LOCAL_ENABLED` (`_shared.py:183-195`) |
| `ltx_video_modal` | ltx-modal | `MODAL_LTX2_ENDPOINT_URL` (`_shared.py:569-656`) | t2v / i2v | |
| `pexels_video` / `pixabay_video` | pexels/pixabay | 素材检索 | search/download | 输入键为 `query` |
| `video_selector` | selector | 路由 | rank / t2v / i2v / reference | 见 §7 |

### 3.2 image_generation（`tools/graphics/`）
`flux_image`(flux, FAL_KEY)、`recraft_image`(recraft, FAL_KEY)、`google_imagen`(google_imagen)、`openai_image`(openai)、`grok_image`(grok, 支持 image_edit/多参考图)、`dashscope_image`(dashscope, 支持 watermark/seed)、`kling_official_image`(kling_official, `env:KLING_API_KEY`)、`comfyui_image`、`local_diffusion`、`pexels_image`/`pixabay_image`、`image_gen`(provider="multi"，ARCHITECTURE 标注 deprecated)、`image_selector`。

### 3.3 tts / music / avatar（`tools/audio/`, `tools/avatar/`）
- TTS：`elevenlabs_tts`、`google_tts`、`openai_tts`、`piper_tts`(`cmd:piper`)、`doubao_tts`(ASYNC, `/api/v3/tts/submit|query`)、`dashscope_tts`、`kling_tts`(`env:KLING_API_KEY`)、`tts_selector`。
- 音乐：`music_gen`(elevenlabs)、`suno_music`(ASYNC)、`google_music`(Lyria)、`pixabay_music`/`freesound_music`(检索)、`music_library`(本地)。
- avatar：`kling_avatar`、`kling_lip_sync`、`lip_sync`(wav2lip)、`talking_head`(sadtalker)。

## 4. Seedance Volcengine 逐行：`tools/video/seedance_volcengine.py`

- 类头 `:31-42`：`name="seedance_volcengine"`, `provider="seedance"`, `stability=BETA`, `execution_mode=ASYNC`, `determinism=STOCHASTIC`, `runtime=API`。
- 端点 `CREATE_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"` (`:44`)；查询 URL 为 `CREATE_URL/{task_id}` (`:497`)。
- 模型 ID 常量 `MODEL_IDS` (`:45-49`)：standard→`doubao-seedance-2-0-260128`，fast→`doubao-seedance-2-0-fast-260128`，mini→`doubao-seedance-2-0-mini-260615`。
- 价格表 `PRICE_CNY_PER_MILLION_TOKENS` (`:50-65`)，按 variant×resolution×是否带视频输入；`ESTIMATED_TOKENS_PER_SECOND` (`:68-73`) 480p 30k / 720p 55k / 1080p 120k / 4k 480k。
- `dependencies = []` (`:75`)；可用性由 `get_status` (`:227-228`) 读取 `VOLCENGINE_ARK_API_KEY` 或 `ARK_API_KEY` (`:224-225`)。
- `capabilities` (`:83-88`)：`text_to_video`、`image_to_video`、`reference_to_video`、`first_last_frame_to_video`；`supports` (`:89-102`) 声明 `seed: False`、`reference_video/reference_audio/native_audio: True`。`fallback_tools` (`:81`)：seedance_video、seedance_replicate、veo_video。`quality_score=0.95` (`:112`)。
- `input_schema` (`:114-185`)：`duration` 整数 4-15 或字符串 "auto"/"4".."15"，默认 "5" (`:139-145`)；`aspect_ratio` 枚举 auto/adaptive/21:9/16:9/4:3/1:1/3:4/9:16，默认 adaptive (`:146-150`)；`resolution` 480p/720p/1080p/4k，默认 720p (`:151-155`)；`generate_audio` 默认 True (`:156`)；`watermark` 默认 False (`:157`)；`return_last_frame` (`:158`)；`image_url/image_path`；`reference_image_urls/paths` maxItems 9，`reference_video_urls` 3，`reference_audio_urls` 3 (`:161-164`)；`first_frame_url/path`、`last_frame_url/path` (`:165-168`)；`seed` 标注 Rejected (`:169-172`)；`priority` 0-9、`safety_identifier`、`execution_expires_after` 3600-259200 (`:173-175`)；`poll_interval_seconds` 默认 5、`timeout_seconds` 默认 900 (`:176-177`)；`estimated_cost_usd_per_second` (`:178-182`)；`output_path`。无 `callback_url`。
- 模型解析 `_model` (`:236-252`)：优先级 `inputs.model` > 环境变量 `VOLCENGINE_SEEDANCE_MODEL` > `MODEL_IDS[model_variant]`；若配置值是已知公共 Model ID 且与 `model_variant` 不一致，抛 `ValueError`。
- 时长 `_duration` (`:254-265`)：`"auto"`→`-1`；其余转 int 且限定 4..15。
- 本地图片 `_image_data_url` (`:267-278`)：文件必须存在、小于 30 MB、mimetype 为 `image/*`，编码为 `data:<mime>;base64,...`。
- `_build_payload` (`:287-382`)：
  - `seed` 非空直接抛 `ValueError` (`:288-289`)。
  - fast/mini 仅允许 480p/720p (`:295-296`)。
  - `negative_prompt` 拼接进 prompt 文本：`"\n避免出现：..."` (`:306-307`)。
  - `content` 列表首项 `{"type":"text","text":prompt}` (`:308`)；`image_to_video` 追加 `{"type":"image_url","image_url":{"url":...},"role":"first_frame"}` (`:314-316`)；`first_last_frame_to_video` 追加 first_frame 与 last_frame 两项 (`:328-333`)；`reference_to_video` 按 role `reference_image`/`reference_video`/`reference_audio` 追加 (`:352-363`)，上限 9/3/3 (`:342-347`)，仅音频不允许 (`:348-351`)。
  - `aspect_ratio` "auto" 映射为 "adaptive" (`:365-367`)。
  - 请求 body 字段：`model, content, resolution, ratio, duration, generate_audio, watermark` (`:368-376`)，可选透传 `return_last_frame, priority, safety_identifier, execution_expires_after` (`:377-379`)；序列化后 ≥64 MB 抛错 (`:380-381`)。
- 成本预估 `estimate_cost` (`:384-402`)：`tokens = ESTIMATED_TOKENS_PER_SECOND[res] × 秒数`（auto 按 15 s），单价取 `without_video_input`，除以 `VOLCENGINE_CNY_PER_USD`（默认 7.2）再乘 `VOLCENGINE_SEEDANCE_ESTIMATE_MULTIPLIER`（默认 1.2）；`estimated_cost_usd_per_second` 只能提高估算。实际成本 `_actual_cost` (`:407-428`)：用返回 `usage.completion_tokens`、返回 `model` 反查 variant、返回 `resolution`；有 `reference_video_urls` 时用 `with_video_input` 单价。
- HTTP：`_headers` Bearer (`:431-432`)；`_request_json` (`:455-485`) timeout `(10, 60)`；创建 POST `retry_safe=False` 只发一次 (`:466-468, 536-543`)；轮询 GET 在 429/≥500 时重试，总尝试 `max_retries+1=3` 次，延迟取 `Retry-After` 或 `2×2^attempt`，上限 30 s。错误信息格式 `HTTP <status>, <code>: <message>; request_id=...` (`:444-453`)。
- 轮询 `_poll_task` (`:487-511`)：状态 `succeeded` 返回 task；`failed/expired/cancelled` 抛 `RuntimeError`；`queued/running` 继续；其他状态视为异常；超过 `timeout_seconds` 抛 `TimeoutError`。
- `execute` (`:524-610`)：无 key 返回失败 `ToolResult`；提交取 `id`；轮询；取 `content.video_url`，`requests.get(video_url, timeout=(10,300))` 下载，写入 `output_path`（默认 `seedance_volcengine_output.mp4`，`:570`）；任何异常经 `_safe_error` 脱敏 (`:513-522`) 后返回 `ToolResult(success=False, error="Volcengine Seedance 2.0 generation failed: task <id>: ...")`；成功 `data` 含 `provider="seedance", gateway="volcengine", model, task_id, operation, aspect_ratio, resolution, duration, generate_audio, usage, remote_url, last_frame_url, output, output_path, format="mp4"` 加 `probe_output`（`_shared.py:659-696`，ffprobe 时长/分辨率/编码），`cost_usd=_actual_cost`。
- 测试 `tests/tools/test_seedance_volcengine.py`：契约与注册发现 (`:51-63`)、payload 形状 (`:75-91`)、Endpoint ID 与 auto (`:94-101`)、变体不一致 (`:104-112`)、首尾帧与参考角色 (`:115-144`)、data URL (`:147-153`)、输入校验 (`:156-170`)、创建 POST 不重试 (`:278-296`)、分辨率定价 (`:299-317`)。

## 5. Veo：`tools/video/veo_video.py`

- `backend` auto 时先 Google 凭据后 FAL (`:265-276`)；`get_status` 任一可用 (`:181-185`)。
- Google 路径 `_execute_google` (`:282-538`)：`get_genai_client` (`tools/google_credentials.py:41-64`)；Vertex 客户端被拒绝 (`:311-316`)；`model_variant` veo3/veo3.1 映射 `veo-3.1-generate-preview` (`:324-330`)；`GenerateVideosConfig(aspect_ratio, duration_seconds, resolution, number_of_videos=1)` + `generate_audio/negative_prompt/seed` (`:361-373`)；1080p/4k 或 reference 强制 8 s (`:342-358`)；i2v 传 `image=` (`:402-411`)；首尾帧 `config.last_frame` (`:425`)；参考图 `config.reference_images` ASSET 类型 (`:428-458`)；轮询 `client.operations.get` 每 5 s，上限 `GOOGLE_API_TIMEOUT_SECONDS=600` (`google_credentials.py:22`, `veo_video.py:472-482`)；下载 `client.files.download` + `video_asset.save` (`:504-508`)。
- fal 路径 `_execute_fal` (`:540-717`)：model_path `veo3.1`、`veo3.1/image-to-video`、`/reference-to-video`、`/first-last-frame-to-video` (`:571-577`)；veo3.1 的 reference/首尾帧要求 `duration="8s"` (`:557-568`)；payload `duration, aspect_ratio, resolution, generate_audio, negative_prompt, seed, auto_fix, safety_tolerance` (`:579-595`)；本地图片转 data URI (`:242-251`)；reference 用 `image_urls` (`:618`)，首尾帧 `first_frame_url/last_frame_url` (`:632-633`)；提交 `queue.fal.run/fal-ai/{model_path}` (`:642`)，轮询 5 s 上限 600 s (`:653-672`)。
- 成本：Google 0.40 USD/s；fal 按 variant/resolution/audio 0.10-0.60 USD/s (`:187-225`)。比例枚举仅 16:9/9:16 (`:109-113`)，分辨率 720p/1080p/4k (`:119-123`)。无 watermark、无 callback。

## 6. Kling Official：`tools/video/kling_official_video.py` + `tools/_kling/`

- `dependencies=["env:KLING_API_KEY"]` (`:56`)；`api_family` classic/turbo/omni (`:90-94`)；`model_name` 枚举 `VIDEO_MODELS` (`tools/_kling/schemas.py:38-50`)；duration "3".."15"、比例 16:9/9:16/1:1、分辨率 720p/1080p、mode std/pro/4k、sound on/off (`schemas.py:84-88`)。
- classic：`/v1/videos/text2video`、`/v1/videos/image2video` (`:310, 327`)；i2v 用 `image`（首帧）+ `image_tail`（尾帧）(`:312-323`)，本地图片转原始 base64 (`tools/_kling/media.py:40-47`)；`element_list`；multi_shot/shot_type/multi_prompt (`:471-492`)。
- turbo：`/text-to-video/kling-3.0-turbo`、`/image-to-video/kling-3.0-turbo` (`:352, 363`)，i2v 只接受 URL (`:354-358`)。
- omni：`/v1/videos/omni-video` (`:383`)，`image_list/video_list/element_list`，视频只接受 URL (`:556-557`)。
- 水印：`watermark`→`watermark_info.enabled` (`:458-459, 463-464`)；回调：`callback_url` 经 `validate_callback_url` (`tools/_kling/callbacks.py:8-17`) 透传但仍轮询，结果记录 `polling_used=True` (`:637-647`)；`external_task_id` 透传。
- 客户端 `KlingClient` (`tools/_kling/client.py:25`)：base URL `KLING_API_BASE_URL` 或 `https://api-singapore.klingai.com` (`schemas.py:10`)；`poll_classic` (`client.py:76-101`) 状态 submitted/processing/succeed/failed；`poll_turbo` GET `/tasks?task_ids=` (`:110-135`)；重试码 1302/1303/5000/5001/5002 与 HTTP 500/503/504 (`tools/_kling/errors.py:30-31`)。
- 错误类型 `KlingAPIError(message, code, request_id, http_status, response)` (`errors.py:9-27`)；execute 捕获后写入 `data.error_code/request_id/http_status` (`:245-256`)。
- 成本 `estimate_cost` (`:179-200`) 为保守估算，`dry_run` 标注 `cost_estimate_confidence="low"` (`:205-214`)。
- 结果落盘：多输出用 `numbered_output_path` (`media.py:108-111`)，默认 `kling_official_video.mp4` (`:603`)。

## 7. provider 选择逻辑

1. `video_selector` (`tools/video/video_selector.py`)：`_providers` 从 `registry.get_by_capability("video_generation")` 取候选 (`:214-219`)；`_filter_candidates` (`:447-485`) 按 operation 用 `supports.image_to_video`/`reference_to_video` 或 `input_schema` 是否含 `image_url`/`reference_image_url`/`reference_image_urls` 判定；`_select_best_tool` (`:334-403`)：`allowed_providers` 过滤 (`:348-350`)、`VIDEO_GEN_LOCAL_MODEL` 环境提示 (`:353-363`)、`rank_providers` 排序、`preferred_provider` 仅在加权分差 ≤ `preferred_provider_gap`（默认 0.15，`:29`）时生效 (`:384-395`)；按 tool name 而非 provider 键控，同一 provider 多个网关均可选 (`:367-374`)。执行前自动把 `reference_image_path` 经 `upload_image_fal` 转成 `image_url` (`:307-316`)；结果补充 `selected_tool/selected_provider/selection_reason/provider_score/alternatives_considered/fallback_tools` (`:319-331`)。
2. 打分 `lib/scoring.py`：`ProviderScore.weighted_score` 权重 task_fit 0.30 / quality 0.20 / control 0.15 / reliability 0.15 / cost 0.10 / latency 0.05 / continuity 0.05 (`:36-45`)；`quality_score` 直接采用 (`:455-457`)；reference 需求加分 (`:481-486`)；cinematic 意图对 `native_audio/multi_shot/camera_direction/lip_sync/cinematic_quality` 加分 (`:495-518`)；`estimate_cost` 结果进入 cost_efficiency (`:416-421`)。
3. `media_profiles.py`：只定义输出渲染 profile（`MediaProfile` `:22-37`、`ALL_PROFILES` `:133-139`、`ffmpeg_output_args` `:155-165`），不参与 provider 选择。
4. `config.yaml` / `lib/config_model.py`：只有 `llm/budget/checkpoint/output/paths`，无 provider 选择字段。
5. pipeline 配置：`pipeline_defs/*.yaml` 通过 `tools_available/required_tools/optional_tools/preferred_tools` 列工具名（schema `schemas/pipelines/pipeline_manifest.schema.json:64-88`），`cinematic.yaml:108,173,181` 列的是 `video_selector`/`image_selector` 而非具体 provider；`lib/pipeline_loader.py:152-162` 汇总所需工具。
6. skill 指令：`.agents/skills/seedance-2-0/SKILL.md:17` 要求通过 `video_selector` 传 `preferred_provider="seedance"`，`:37-46` 列出网关表（文档仍将 Volcengine 标为 roadmap）；`AGENT_GUIDE.md:323` Provider Menu、`:455-456` selector/provider 两层、`:526-530` selector 表；`skills/creative/video-gen-prompting.md:17` 将 Seedance 2.0 定为默认；工具的 `agent_skills` 字段指向对应 skill。

## 8. 密钥读取

- `lib/env_loader.py`：`load_dotenv_file` (`:15-34`) 用 `dotenv_values` 读取，非空进程值优先，空值不覆盖；`load_env` (`:37-41`)、`get_env` (`:44`)、`require_env` (`:49-54`)。
- 加载时机：`tools/base_tool.py:28-40` 导入即加载；`ToolRegistry._load_dotenv` (`tool_registry.py:88-93`) 在 `discover` 时再加载。
- provider 内读取方式为直接 `os.environ.get`：seedance_volcengine `:224-225`；fal 系 `FAL_KEY`/`FAL_AI_API_KEY`（`seedance_video.py:162-163`）；Kling `KlingClient.__init__` (`client.py:35-36`)；Google `has_google_credentials` (`google_credentials.py:32-38`) 与 service account (`:81-128`)。`dependencies` 中 `env:` 声明仅 kling_official 系列使用（`kling_official_video.py:56`），其余 provider `dependencies=[]` 并重写 `get_status`。

## 9. 成本估算与记账

- 每个 provider 自行实现 `estimate_cost`；成功后的 `ToolResult.cost_usd` 多数等于预估值（seedance_video `:322`、veo `:535`、kling_official `:284`），只有 `seedance_volcengine` 用返回 token 反算 (`:607`)。
- `tools/cost_tracker.py` `CostTracker` (`:40`)：`estimate` (`:114`) / `reserve` (`:130`) / `reconcile` (`:208`) / `refund` (`:217`)，持久化到 `cost_log.json` (`:331-354`)；模式 observe/warn/cap 来自 `config_model.BudgetMode`。仓库内除测试与 AGENT_GUIDE 外无代码调用 `CostTracker`，由 agent 按指引手动调用。

## 10. 新增 provider 所需清单

1. 在 `tools/<family>/<name>.py` 定义 `BaseTool` 子类（类名 PascalCase 无 Tool 后缀，`AGENT_GUIDE.md:507-520`）。
2. 类属性：`name`、`capability`（必须与 selector 的 capability 一致才会被路由）、`provider`、`tier=ToolTier.GENERATE`、`stability`、`execution_mode`、`determinism`、`runtime=ToolRuntime.API`。
3. `dependencies`（`env:KEY` 可自动生成 setup_offers）或重写 `get_status`；`install_instructions`（provider menu 直接展示）。
4. `capabilities` 列表 + `supports` dict（selector 过滤与 scoring 使用的键：`image_to_video`、`reference_to_video`、`reference_image`、`multiple_reference_images`、`seed`、`aspect_ratio`、`negative_prompt`、`native_audio`、`multi_shot`、`camera_direction`、`lip_sync`、`cinematic_quality`、`custom_workflow`）；`best_for`（task_fit 关键词匹配）；`quality_score`；`fallback_tools`；`agent_skills`。
5. `input_schema`（含 `prompt`、`operation`、`output_path`；i2v 需暴露 `image_url` 或 `reference_image_url` 键，selector 据此自动上传本地图）、`output_schema`、`idempotency_key_fields`、`side_effects`、`user_visible_verification`、`resource_profile(network_required=True)`、`retry_policy`。
6. 方法：`estimate_cost`、`estimate_runtime`、`execute`（返回 `ToolResult`，`data` 含 `provider/model/output/output_path/format` 并合并 `probe_output`；失败以 `ToolResult(success=False, error=...)` 返回；`requests` 等在 `execute` 内延迟导入）；可选 `is_operation_available(operation)`（`video_selector.py:488-492`）、`dry_run`。
7. 注册：无需手动；`ToolRegistry.discover` 自动导入 `tools` 包内所有模块，模块顶层必须可导入。
8. 文档与配置：`docs/PROVIDERS.md` 新增章节与 Provider-to-Tool Mapping 表 (`:909-927`)；`.env.example` 增加变量；可选 `.agents/skills/<skill>/SKILL.md` 并在 `agent_skills` 引用。
9. 测试：参照 `tests/tools/test_seedance_volcengine.py`（契约+注册发现、payload、mock HTTP）；`tests/contracts/` 存放契约测试。

关键事实：
- lib/providers/ 仅含 0 字节 __init__.py；docs/ARCHITECTURE.md:41 标注为预留目录，实际抽象层在 tools/base_tool.py 与 tools/tool_registry.py
- BaseTool(ABC) 定义于 tools/base_tool.py:205，唯一抽象方法 execute(self, inputs: dict[str, Any]) -> ToolResult (tools/base_tool.py:372-375)
- ToolResult dataclass 字段 success/data/artifacts/error/cost_usd/duration_seconds/seed/model (tools/base_tool.py:108-118)
- 能力声明靠类属性 capability/provider/capabilities/input_schema/supports/best_for (tools/base_tool.py:230-240)；dependencies 前缀 cmd:/binary:/env:/python: 由 check_dependencies 解析 (tools/base_tool.py:282-305)
- 错误类型：DependencyError (tools/base_tool.py:456)、ToolCommandError (tools/base_tool.py:434)；API provider 运行时错误以 ToolResult(success=False) 返回
- ToolRegistry.discover 用 pkgutil.walk_packages 自动注册 tools 包内非抽象 BaseTool 子类，无需手动注册 (tools/tool_registry.py:74-111)
- SeedanceVolcengine CREATE_URL = https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks，查询 URL 为 CREATE_URL/{task_id} (tools/video/seedance_volcengine.py:44, 497)
- MODEL_IDS: standard=doubao-seedance-2-0-260128, fast=doubao-seedance-2-0-fast-260128, mini=doubao-seedance-2-0-mini-260615 (tools/video/seedance_volcengine.py:45-49)
- 模型解析优先级 inputs.model > VOLCENGINE_SEEDANCE_MODEL > MODEL_IDS[model_variant]，已知公共 ID 与 variant 不一致抛 ValueError (tools/video/seedance_volcengine.py:236-252)
- Volcengine duration 4..15 或 auto(-1)，aspect_ratio 枚举 auto/adaptive/21:9/16:9/4:3/1:1/3:4/9:16 默认 adaptive，resolution 480p/720p/1080p/4k 默认 720p，fast/mini 仅 480p/720p (tools/video/seedance_volcengine.py:139-155, 254-265, 295-296)
- Volcengine seed 非空直接抛 ValueError；negative_prompt 以「避免出现：」拼接进 prompt (tools/video/seedance_volcengine.py:288-289, 306-307)
- Volcengine 首尾帧通过 content 数组中 role=first_frame / last_frame 的 image_url 项传入；参考生成 role=reference_image/reference_video/reference_audio，上限 9/3/3，仅音频不允许 (tools/video/seedance_volcengine.py:314-363)
- Volcengine 请求 body 字段 model/content/resolution/ratio/duration/generate_audio/watermark，可选 return_last_frame/priority/safety_identifier/execution_expires_after，body 上限 64MB，本地图片 <30MB 转 data URL (tools/video/seedance_volcengine.py:267-278, 368-381)
- Volcengine 创建 POST 不重试，轮询 GET 在 429/5xx 时最多 3 次尝试；轮询默认 5s、超时默认 900s，状态 succeeded/failed/expired/cancelled/queued/running (tools/video/seedance_volcengine.py:455-511, 536-554)
- Volcengine 成本：预估按 ESTIMATED_TOKENS_PER_SECOND × CNY 价格表 / VOLCENGINE_CNY_PER_USD(7.2) × 1.2；实际按返回 usage.completion_tokens 反算 (tools/video/seedance_volcengine.py:384-428)
- Volcengine 结果下载 content.video_url，写入 output_path 默认 seedance_volcengine_output.mp4，data 含 gateway=volcengine/task_id/usage/remote_url/last_frame_url (tools/video/seedance_volcengine.py:555-610)
- seedance_video (fal) 端点 https://queue.fal.run/bytedance/seedance-2.0[/fast]/<op>，支持 seed 与 end_image_url 尾帧，轮询 while True 无超时 (tools/video/seedance_video.py:196-199, 211-221, 260-281)
- seedance_replicate 端点 api.replicate.com/v1/models/bytedance/seedance-2.0[-fast]/predictions，Prefer: wait=60，i2v 用 image 字段 (tools/video/seedance_replicate.py:158-188)
- veo_video 双后端 google/fal：Google 用 google-genai SDK 模型 veo-3.1-generate-preview，1080p/4k 或 reference 强制 8s，首尾帧走 config.last_frame，轮询上限 600s (tools/video/veo_video.py:324-358, 425, 472-482)
- veo_video fal 路径 model_path veo3.1[/image-to-video|/reference-to-video|/first-last-frame-to-video]，payload 含 seed/negative_prompt/resolution/generate_audio，无 watermark/callback (tools/video/veo_video.py:571-595)
- kling_official_video 分 classic(/v1/videos/text2video, image2video 含 image_tail 尾帧)/turbo(/text-to-video/kling-3.0-turbo)/omni(/v1/videos/omni-video)，watermark→watermark_info，callback_url 透传但仍轮询 (tools/video/kling_official_video.py:310-327, 352-363, 383, 458-467, 637-647)
- Kling 官方错误类型 KlingAPIError(message, code, request_id, http_status, response)，重试码 1302/1303/5000/5001/5002 (tools/_kling/errors.py:9-31)；默认 base URL https://api-singapore.klingai.com (tools/_kling/schemas.py:10)
- video_selector 从 registry.get_by_capability('video_generation') 自动发现候选，preferred_provider 仅在分差 ≤0.15 时生效，按 tool name 键控使同 provider 多网关均可选 (tools/video/video_selector.py:214-219, 29, 367-395)
- lib/scoring.py 权重 task_fit 0.30/quality 0.20/control 0.15/reliability 0.15/cost 0.10/latency 0.05/continuity 0.05；quality_score 直接采用；cinematic 意图对 native_audio 等特性加分 (lib/scoring.py:36-45, 455-457, 495-518)
- media_profiles.py 仅定义输出渲染 profile（分辨率/编码/crf），不参与 provider 选择 (lib/media_profiles.py:22-37, 133-165)；config.yaml 无 provider 选择字段 (config.yaml:1-33)
- pipeline_defs 通过 tools_available 等字段引用 video_selector/image_selector 而非具体 provider (pipeline_defs/cinematic.yaml:108, 173, 181; schemas/pipelines/pipeline_manifest.schema.json:64-88)
- env_loader.load_dotenv_file 非空进程值优先、空值不覆盖 (lib/env_loader.py:15-34)；base_tool 导入时与 registry.discover 时各加载一次 .env (tools/base_tool.py:28-40, tools/tool_registry.py:88-93)
- 密钥别名：ARK_API_KEY/VOLCENGINE_ARK_API_KEY、FAL_KEY/FAL_AI_API_KEY、GOOGLE_API_KEY/GEMINI_API_KEY(+服务账号)、KLING_API_KEY(+KLING_API_BASE_URL) (.env.example:5-34; tools/google_credentials.py:32-38)
- CostTracker 提供 estimate/reserve/reconcile 并写 cost_log.json，但仓库内无工具代码自动调用，由 agent 手动记账 (tools/cost_tracker.py:114-223, 331-354)
- skill 指令：.agents/skills/seedance-2-0/SKILL.md:17 要求经 video_selector 传 preferred_provider=seedance；其网关表 :37-46 仍把 Volcengine 标为 roadmap，与已实现的 seedance_volcengine 不一致

未决问题：
- lib/providers/ 预留目录是否有迁移计划；当前 provider 抽象完全依赖 tools/base_tool.py，若要独立的 provider 协议层需新建
- seedance_video (fal) 与 kling_video/minimax_video 的轮询循环为 while True 无超时上限 (tools/video/seedance_video.py:270-281)，与 seedance_volcengine/veo 的有界超时行为不一致，是否需要统一
- video_selector 的 aspect_ratio 枚举仅 16:9/9:16/1:1 (tools/video/video_selector.py:82-87)，而 seedance 支持 21:9；input_schema 不做运行时校验，实际透传行为未验证
- AGENT_GUIDE.md:530 描述 selector 路由为 user preference > availability > discovery order，与 lib/scoring.py 的加权打分实现不一致，文档待更新
- .agents/skills/seedance-2-0/SKILL.md:44 仍将 Volcengine 标为 roadmap、fal 为 primary，与 docs/PROVIDERS.md:77-102 及已实现的 seedance_volcengine 不一致
- seedance_volcengine 的 CNY 价格表与每秒 token 估算常量是否与当前 Ark 官方价格一致，仓库内无来源时间戳
- seedance_video (fal) 的 end_image_url 提供首尾帧能力，但 supports 未声明 first_last_frame_to_video，selector 的 reference/首尾帧路由无法感知
- CostTracker 与 provider 的 cost_usd 之间没有自动衔接，实际记账依赖 agent 遵循指引手动调用

---

# MAP narrative-inputs

# 三家视频生成后端 API 与能力核实（2026-08-27）

调研方式：官方文档页为 JS 渲染，WebFetch 只返回导航；改用 curl 下载 HTML 后本地解析（Google 页面用 stdlib HTMLParser；火山/BytePlus 页面解析嵌入的 Quill delta JSON）。解析后的文本保存在 scratchpad：`/private/tmp/claude-501/-Users-shuai-dramas-archived-20260816-moved-to-writing-loop-sg/c533fca5-53a0-49fb-ac8e-b68005f5d7a2/scratchpad/`（下文简写为 `SP/`）。行号均指 `SP/*.txt`。

---

## 1. Seedance（火山方舟 Ark / BytePlus ModelArk）

### 1.1 端点
| 项 | 火山方舟 | BytePlus ModelArk |
|---|---|---|
| 创建任务 | `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`（`SP/ark_create.txt:2`，源 https://docs.volcengine.com/docs/82379/1520757） | `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`（`SP/bp_1520757.txt:2`，源 https://docs.byteplus.com/en/docs/ModelArk/1520757） |
| 查询任务 | `GET .../api/v3/contents/generations/tasks/{id}`（`SP/ark_1521309.txt:2`） | 同路径（https://docs.byteplus.com/en/docs/ModelArk/1521309） |
| 列表 / 取消删除 | 文档 1521675 / 1521720（BytePlus 导航列出） | 同 |
| 区域 | cn-beijing | 全部模型仅 ap-southeast-1；eu-west-1 只有 seed-2-0 与 seedream-5-0-lite（`SP/bp_1330310.txt:8-18`） |

### 1.2 当前模型 ID（模型列表页）
| 火山方舟（`SP/ark_1330310.txt`） | BytePlus（`SP/bp_1330310.txt`） | 状态 |
|---|---|---|
| doubao-seedance-2-5-260628（:2480） | dreamina-seedance-2-5-260628（:249） | 主线模型 |
| doubao-seedance-2-0-260128（:868） | dreamina-seedance-2-0-260128（:1183） | 在售，唯一支持 4K |
| doubao-seedance-2-0-fast-260128（:1230） | dreamina-seedance-2-0-fast-260128（:2001） | 在售 |
| doubao-seedance-2-0-mini-260615（:2524） | dreamina-seedance-2-0-mini-260615（:1855） | 在售 |
| doubao-seedance-1-5-pro-251215（:199，标注「即将下线」） | seedance-1-5-pro-251215（:803） | 火山侧即将下线 |
| doubao-seedance-1-0-pro-250528（:1940） | seedance-1-0-pro-250528（:915） | 在售 |
| doubao-seedance-1-0-pro-fast-251015（:742） | seedance-1-0-pro-fast-251015（:2457） | 在售 |
| Seedance 1.0 lite（seedance-1-0-lite-t2v/i2v-250428） | 仅存在于 BytePlus 旧页 https://docs.byteplus.com/en/docs/modelark/1553576 | 两侧当前模型列表均未收录，是否仍可调用 **未核实** |

### 1.3 请求字段（`SP/ark_create.txt`，BytePlus 英文版 `SP/bp_1520757.txt` 内容一致）
- `model`；`content[]`：`type` ∈ text / image_url / video_url / audio_url / draft_task；`role`：图片 first_frame / last_frame / reference_image，视频固定 reference_video，音频固定 reference_audio（:57, :265-269, :577, :505, :305）。首帧、首尾帧、全模态参考三种场景互斥（:259）。
- 参考素材上限：Seedance 2.0 系列 图 0-9、视频 0-3、音频 0-3，音频不可单独输入（:367）；Seedance 2.5 图 0-30、视频 0-10、音频 0-10，支持仅音频，单次素材上限 50（:357；`SP/ark_2607688.txt:2`）。视频单段 2.0：2-15 s 总长 ≤15 s；2.5：2-30 s 总长 ≤30 s（:693-701）。音频单段同上，≤15 MB（:325-329）。
- 图片：jpeg/png/webp/bmp/tiff/gif，1.5 pro 起支持 heic/heif；宽高比 [0.4,2.5]，边长 [300,6000] px，<30 MB，请求体 ≤64 MB（:621-627）。视频：mp4/mov，480p-4k，fps 24-60，≤200 MB（:687-713）。
- `duration`：2.5 默认 -1，范围 [4,30] 或 -1；2.0 系列 [4,15] 或 -1；1.5 pro [4,12] 或 -1；1.0 pro / pro fast [2,12]（:1249-1257）。`frames`（仅 1.0 pro 系列）[29,289] 且形如 25+4n（:339-351）。
- `ratio`：16:9、4:3、1:1、3:4、9:16、21:9、adaptive；2.x 与 1.5 pro 默认 adaptive（:549-573）。2.5 在视频编辑/延长/首帧/首尾帧任务仅允许 adaptive（:555-561）。
- `resolution`：2.5 480p/720p/1080p；2.0 480p/720p/1080p/4k；2.0 fast 与 mini 仅 480p/720p；1.x 480p/720p/1080p（:475-487）。2.5 的 1080p 与 2.0 的 4k 为 10bit + H.265（:467）。
- `seed`：默认 -1，范围 [-1, 2147483647]，官方标注「模型支持」仅 1.5 pro、1.0 pro、1.0 pro fast（:585-603），且「相同 seed 生成类似结果，不保证完全一致」（:593）。**Seedance 2.0/2.5 未列入 seed 支持范围。**
- `generate_audio` 默认 true，支持 2.5 / 2.0 系列 / 1.5 pro；输出音频为单声道；建议对白置于双引号内（:724-742）。
- `watermark` 默认 false（:803-809）；`callback_url` 推送结构同查询接口，状态 queued/running/succeeded/failed/expired，失败重试 3 次（:116-132）；`return_last_frame`（:535-543）；`camera_fixed` 仅 1.x（:443-459）；`service_tier` default/flex，2.x 不支持 flex（:59-77）；`priority` [0,9] 仅 2.x（:79-107）；`execution_expires_after` 默认 172800 s，范围 [3600,259200]（:525-533）；`omni_reference_task_type` auto/reference/edit/extend 仅 2.5（:150-174）；`output_format` mp4/mov 仅 2.5（:403-419）；`tools.web_search` 2.x（:200-210）；`draft` 仅 1.5 pro（:509-523）。
- 合规：2.5/2.0 系列不接受含真人人脸的参考图/视频，需使用平台近 30 天产物、预置虚拟人像或已授权真人素材（:788-796, :644）。开通条件：火山余额 >200 元或购买节省计划/资源包（:489-499）；BytePlus 余额 >USD 30（`SP/bp_1520757.txt:246-252`）。

### 1.4 返回结构与轮询（`SP/ark_1521309.txt`）
创建接口异步返回 `id`（任务保存 7 天）。查询返回 `id`、`model`、`status`（queued/running/cancelled/succeeded/failed，:88-100；expired 由超时产生）、`content.video_url`（24 h 有效，2.5 下载上限 100 次，:206-210）、`content.last_frame_url`（:241-247）、`usage.completion_tokens`/`total_tokens`（2.0 系列有最低 token 用量，:70-78）、`duration` 或 `frames`（二者只返回一个，:129-133, :235-239）、`resolution`、`ratio`、`seed`、`generate_audio`、`created_at`/`updated_at`、`error{code,message}`。仅可查询最近 7 天记录（:8）。

### 1.5 配额（模型列表页）
- 2.5 / 2.0 / 2.0 fast / 2.0 mini（非 4K）：企业用户 RPM 600、并发 10；个人用户 RPM 180、并发 3；flex 不支持（`SP/ark_1330310.txt:2484-2496`；`SP/bp_1330310.txt:279-291`）。
- 2.0 的 4K：RPM 15、并发 1（`SP/bp_1330310.txt:1229-1241`）。
- 1.5 pro / 1.0 pro / 1.0 pro fast：RPM 600、并发 10；flex TPD 500B（`SP/bp_1330310.txt:821-829, :933-941`）。
- 页面注明限流为理论最大值，不保证（`SP/bp_1330310.txt:24`）。

### 1.6 计价（`SP/bp_1544106.txt`、`SP/ark_1544106.txt`）
token 用量 = (输入视频时长 + 输出时长) × 输出宽 × 输出高 × 帧率 / 1024；仅对成功任务计费；2.x 含视频输入时有最低 token 用量（`SP/bp_1544106.txt:72-92`）。
| 模型 | USD / 百万 token（无视频输入 / 含视频输入） | CNY / 百万 token |
|---|---|---|
| 2.5 480p·720p | 10.70 / 6.40（:1013-1017） | 70 / 42（`ark_1544106.txt:1723-1727`） |
| 2.5 1080p | 11.7 / 7.0，8-14 至 9-17 期间 72 折（:1019-1023） | 77 / 46，72 折后约 2.7 元/秒（:1729-1733, :74） |
| 2.0 480p·720p / 1080p / 4K | 7.0/4.3；7.7/4.7；4.0/2.4（:823-839） | 46/28；51/31；26/16（:1545-1561） |
| 2.0 fast | 5.6 / 3.3，限时 75 折（:1789-1793） | 37 / 22（:1807-1811） |
| 2.0 mini | 3.5 / 2.1，限时 4 折（:1365-1369） | 23 / 14（:1237-1241） |
| 1.5 pro | 有声 2.4 / 无声 1.2；flex 1.2 / 0.6（:547-555） | 有声 16 / 无声 8；flex 8 / 4（:3105-3115） |
| 1.0 pro；1.0 pro fast | 2.5（flex 1.25）；1.0（flex 0.5）（:2137-2141, :387-391） | 15（flex 7.5）；4.2（flex 2.1）（:1387-1391, :2455-2459） |
官方示例（16:9，5 s，无视频输入，USD）：2.5 480p 0.514（0.103/s）、720p 1.156（0.231/s）、1080p 2.843（0.569/s）（:1969-1971, :1711-1713, :2077-2079）；2.0 720p 0.76（0.15/s）、480p 0.35（0.07/s）、1080p 1.87（0.37/s）、4K 3.89（0.78/s）（:1671-1685）；2.0 fast 720p 0.60（0.12/s）（:211-217）；2.0 mini 720p 0.38（0.08/s）（:417-423）。

### 1.7 能力矩阵（Seedance 2.5 / 2.0）
t2v ✓；i2v 首帧 ✓；首尾帧 ✓；多参考图 ✓（2.0 ≤9，2.5 ≤30）；视频延长 ✓（2.0/2.5，2.5 需 ratio=adaptive）；原生音频 ✓（generate_audio，单声道）；对白口型：官方 2.5 教程示例提示词要求「精准对口型」并给出多语言歌词（`SP/ark_2607688.txt:643`），台词用 {} 标记（:365），无独立口型指标；最大时长 2.5 30 s、2.0 15 s；分辨率 2.5 ≤1080p、2.0 ≤4K；9:16 ✓；seed 可复现：2.x 未列入支持，1.x 支持但不保证一致；异步（创建 + 轮询/回调）；并发 企业 10 / 个人 3；单价见 1.6。

---

## 2. Veo 3.1 on Vertex AI（文档现名 Gemini Enterprise Agent Platform）

### 2.1 模型 ID 与状态（`SP/veo31.txt`，源 https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate）
| ID | 阶段 | 发布 / 退役 | 输出分辨率 | 参考图 | 时长 |
|---|---|---|---|---|---|
| veo-3.1-generate-001 | GA（:97） | 2025-11-17 / 2026-11-17 或之后（:98-99） | 720p, 1080p, 4K（:77-78） | Asset images 支持（:39-41） | 4/6/8 s，参考图生视频仅 8 s（:67-68） |
| veo-3.1-fast-generate-001 | GA（:192） | 同上 | 720p, 1080p（:172-173） | 支持 | 4/6/8 s |
| veo-3.1-lite-generate-001 | Preview（:297） | 2026-04-02（:298） | 720p, 1080p | 不支持（:239-240） | 4/6/8 s |
| veo-3.1-generate-preview / veo-3.1-fast-generate-preview | Preview，退役日 2026-04-02（:411-413, :526-528） | 2025-10-15 | 720p, 1080p, 4k | 支持 | 同上 |
Release notes：2026-03-24 起 veo-3.0-generate-001/fast 弃用并迁移至 3.1；2026-01-13 参考生视频支持 9:16 与 1080p/4k 上采样；2026-04-02 Lite 公开预览（https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes）。

### 2.2 端点与轮询（`SP/veo_refimg.txt:683-826`）
- `POST https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/publishers/google/models/MODEL_ID:predictLongRunning` → `{"name": ".../operations/OPERATION_ID"}`。
- `POST .../models/MODEL_ID:fetchPredictOperation`，body `{"operationName": "..."}` → `{name, done, response:{raiMediaFilteredCount, videos:[{gcsUri 或 bytesBase64Encoded, mimeType:"video/mp4"}]}}`；未传 storageUri 时返回 base64（:626-629）。
- 区域：仅 us-central1（`SP/veo31.txt:90`）。

### 2.3 instances（`SP/g_VideoGenerationModelInstance.txt`）
`prompt`；`image{mimeType image/jpeg|image/png, bytesBase64Encoded|gcsUri}`（首帧，与 video/referenceImages 互斥）；`lastFrame`（须同时传 image）；`video{mimeType video/mp4|mov|mpeg|mpg|avi|wmv|mpegps|flv, gcsUri|bytesBase64Encoded}`（无 mask 时为延长，有 mask 时为编辑）；`mask{maskMode insert|remove|remove_static|outpaint}`；`referenceImages[]{image, referenceType asset|style}`，最多 3 张 asset 或 1 张 style，必须带 prompt；`cameraControl`（fixed/pan_left/…/pull_out，仅配合 image）。

### 2.4 parameters（`SP/g_VideoGenerationModelParams.txt`）
`sampleCount`（1-4，`SP/veo_refimg.txt:674-676`）、`storageUri`（gs://）、`fps`、`durationSeconds`（4/6/8）、`seed`（uint32 0-4294967295；sampleCount>1 时每条视频不同 seed；enhancePrompt=true 时不保证一致）、`aspectRatio` 16:9/9:16、`resolution`（参考页写 720p/1080p；模型页与指南含 4k，指南注「4k (Veo 3.1 Preview models only)」，`SP/veo_refimg.txt:637`，与模型页 GA 支持 4K 的说法不一致）、`personGeneration`（参考页 dont_allow/allow_adult/allowAll；操作指南写 allow_adult/disallow，`SP/veo_refimg.txt:659-665`，两处枚举不一致）、`pubsubTopic`、`negativePrompt`、`enhancePrompt` 默认 true、`generateAudio` 默认 true、`compressionQuality` optimized(默认)/lossless、`task` textToVideo/imageToVideo/referenceToVideo/edit/extend/upscale、`resizeMode` pad(默认)/crop。
- 输入图片：≤20 MB（`SP/veo31.txt:71-72`），仅 JPEG/PNG，建议 ≥720p 且 16:9 或 9:16，否则会缩放或居中裁剪（`SP/g_generate-videos-from-an-image.txt:718-727`）。
- 视频延长：输入 1-30 s、24 fps、720p/1080p/4k、9:16 或 16:9；每次延长 7 s；Veo 最长延长至 37 s（`SP/g_extend-videos.txt:10-13, :103-117`）。
- 配额：模型页写「Regional online prediction requests per base model per minute: 50」（GA 与 fast/lite），preview generate 为 10（`SP/veo31.txt:93, :407`）；并发上限 **未核实**（官方 quotas 页无 Veo 行）。消费方式：Provisioned Throughput 支持，Batch 不支持（:54-57）。

### 2.5 音频与对白
参数参考与计价页均以「Video + Audio」为默认；但模型页能力表将 veo-3.1-generate-001 / fast 的「Sound generation」标为 Not supported、Lite 标为 Supported（`SP/veo31.txt:44-45, :139-140, :243-244`），与计价页（`SP/veo_pricing.txt:2346-2360`）冲突，属文档不一致，需实测确认。对白通过提示词（「the man in the red hat says: …」）驱动，提示词指南仍写「Audio is supported by veo-3.0-generate-001 in Preview」（`SP/g_promptguide.txt:378-397`）；口型无官方指标。

### 2.6 计价（https://cloud.google.com/vertex-ai/generative-ai/pricing，`SP/veo_pricing.txt:2330-2530`，USD/秒）
| 模型 | 含音频 | 无音频 |
|---|---|---|
| Veo 3.1 | 0.40（720p/1080p），0.60（4k） | 0.20，0.40（4k） |
| Veo 3.1 Fast | 0.10（720p）、0.12（1080p）、0.30（4k） | 0.08、0.10、0.25 |
| Veo 3.1 Lite | 0.05（720p）、0.08（1080p） | 0.03、0.05 |

### 2.7 能力矩阵（veo-3.1-generate-001）
t2v ✓；i2v 首帧 ✓；首尾帧 ✓（lastFrame）；多参考图 ✓（≤3 asset 或 1 style，仅 8 s）；视频延长 ✓（+7 s/次，≤37 s）；原生音频：参数默认 true，模型页标 Not supported（冲突）；对白：提示词驱动；最大单次 8 s；分辨率 720p/1080p/4K；9:16 ✓；seed 可复现（需 enhancePrompt=false，sampleCount=1）；异步 LRO；配额 50 req/min，并发未核实；单价见 2.6。

---

## 3. MiniMax H3（开源权重）

### 3.1 发布
- API/Hailuo 上线 2026-07-31（https://www.minimax.io/blog/minimax-h3）；权重开源 2026-08-03（https://www.minimax.io/news/minimax-h3-open-source）；许可证版本日期 2026-08-02（https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE）。
- H3-Omni-Transformer 33B 稠密（其中 AdaLN 分支约 13B）；文本编码器 Qwen3-VL-32B（取第 50 层隐状态）；Visual VAE f16t4d24（16× 空间、4× 时间、24 通道）；Audio VAE 双声道 32 kHz、40 Hz 潜变量率（news 页与 HF 模型卡）。
- 模态：T2VA、FL2VA（首帧/尾帧/首尾帧）、Ref2VA（图 ≤9、视频 ≤3 且每段 2-15 s、音频 ≤3，音频须搭配图或视频，混合 ≤12 个文件）；音画联合生成，原生立体声；对白/口型 11 种语言（阿、中、英、法、德、意、日、韩、葡、俄、西）。
- 输出：短边 768p（16:9 为 1344×768），4-15 s，24 fps，宽高比 21:9/16:9/4:3/1:1/3:4/9:16；2K 仅经 H3-Regenerate-2K，该模块与 H3-Context-IR、稀疏注意力实现均未开源（news 页）。
- 权重仓库：MiniMaxAI/MiniMax-H3（HF）、MiniMax/MiniMax-H3（ModelScope）、Comfy-Org/MiniMax-H3（ComfyUI 版）。

### 3.2 权重清单
MiniMaxAI/MiniMax-H3（总 498 GB，BF16）：`transformer/` 14 分片 66.3 GB（FL2VA）；`transformer_ref/` 14 分片 66.3 GB（Ref2VA）；`text_encoder/` 14 分片约 66.7 GB（Qwen3-VL-32B，含 tokenizer/preprocessor 配置）；`vae/` 3 分片 10.4 GB；`audio_vae/` 605 MB；另有 `FL2VA/`、`Ref2VA/`、`processor/`、`scheduler/`、`audio_scheduler/`、`tokenizer/`。
Comfy-Org/MiniMax-H3：`diffusion_models/` fl2va 与 ref2va 各 5 个：bf16 66.3 GB、int8_convrot 34 GB、pruned_bf16 40.2 GB、pruned_fp8_scaled 21 GB、pruned_int8_convrot 21 GB；`text_encoders/` qwen3vl_32b_minimax_h3 bf16 51.5 GB、int8_convrot 27.1 GB、nvfp4_awq 15.7 GB；`vae/` minimax_h3_video_vae_fp16 5.21 GB、minimax_h3_audio_vae_fp32 605 MB；`loras/` fl2v_turbo_4step_768p、fl2v_turbo_8step、ref2v_turbo_4step 各 1.96 GB。README 建议优先 int8_convrot（需 cu130），fp8_scaled 仅在无法用 int8 时使用，nvfp4 文本编码器不要求 Blackwell。

### 3.3 显存与量化
- 官方模型卡仅给 BF16 与 4 GPU 部署示例（`sglang serve --num-gpus 4`），未给显存数字。
- vLLM 官方 recipe（https://recipes.vllm.ai/MiniMaxAI/MiniMax-H3）：4×B300/GB200 最优；2×RTX 5090（32 GB）或 2×RTX 4090（24 GB）需分层卸载 DLO 且主机内存 384 GiB 级；单卡 ≥24 GB 需 CPU offload；FP8 为在线量化、仅 DiT 且与 DLO 不兼容；INT8 用于 Ascend；DGX Spark 强制 FP8。4×B300 上 FL2VA 8.7 s 1248×768 端到端 86.96 s。
- ComfyUI 路线（pruned int8 21 GB + nvfp4 文本编码器 15.7 GB）社区实测：RTX 5070 Ti 16 GB 在 640×384、226 帧、20 步下 190 s，峰值显存约 7.4 GB（https://github.com/Tomiigo/minimax-h3-16gb，非官方）。

### 3.4 许可证（MiniMax H3 Community License，LICENSE 原文）
Applicable Territory 为全球但排除 Excluded Territories：欧盟、英国、韩国、美国；被排除地区需通过 https://platform.minimax.io/h3-license 申请授权（HF 讨论区官方回复称自动批准，https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/12）。商用：年收入 >2000 万美元需事先书面授权；商用产品界面须显著展示「MiniMax H3」；不得用模型或其输出改进其他 AI 模型；分发须附协议与 NOTICE；香港特别行政区法律与法院管辖。托管 API 不受地域限制（同讨论区）。

### 3.5 ComfyUI 节点
ComfyUI 核心 `comfy_extras/nodes_minimax_h3.py`（https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py）定义 5 个节点：EmptyMiniMaxH3LatentAV（width 默认 1344、height 768、length 默认 124，min 5、max 3600、step 17）、**MiniMaxH3ImageToVideo**（first_frame/last_frame 可选）、MiniMaxH3AddGuide、**MiniMaxH3ReferenceToVideo**（ref_images/ref_videos/ref_video_audios/ref_audios，ref_image_size match/max）、**MiniMaxH3SigmaShift**（显示名 ModelSamplingMiniMaxH3，shift_video 12.0、shift_audio 3.0）。三个待核实节点名均真实存在。官方教程要求 ComfyUI ≥0.30.0（https://docs.comfy.org/tutorials/video/minimax/minimax-h3）。社区节点：Anil-matcha/minimax-h3-comfyui（API 封装）、nkxx188/ComfyUI-MiniMaxH3-Easy、ethanfel/ComfyUI-MiniMax-H3-Guide、KJNodes 的 MiniMaxH3MemoryEfficientSageAttentionPatch。

### 3.6 托管 API 单价
platform.minimax.io 按量计费页：2K $0.13/秒、768P $0.08/秒；输入图片前 5 张免费，之后 $0.04/张（https://platform.minimax.io/docs/guides/pricing-paygo.md）；视频套餐页注明「MiniMax H3 is not supported yet」。并发上限官方页未列 → 未核实。

### 3.7 能力矩阵（本地开源权重）
t2v ✓；i2v 首帧 ✓；首尾帧 ✓（FL2VA）；多参考图 ✓（≤9 图 + ≤3 视频 + ≤3 音频，Ref2VA）；视频延长：无独立延长任务，可用 MiniMaxH3AddGuide 锚定帧实现（未有官方「extend」接口）→ 未核实；原生音频 ✓（立体声 32 kHz）；对白口型 ✓（11 语言）；最大 15 s；768p（2K 仅 API）；9:16 ✓；seed 可复现 ✓（本地采样器 seed）；同步本地推理；并发取决于自有算力；单价：自托管，托管 API $0.08-0.13/秒。

---

## 4. 三家对照（要点）
| 维度 | Seedance 2.5 | Veo 3.1 (GA) | MiniMax H3 本地 |
|---|---|---|---|
| 最大时长 | 30 s | 8 s（延长至 37 s） | 15 s |
| 分辨率 | ≤1080p（2.0 ≤4K） | 720p/1080p/4K | 768p |
| 参考图 | ≤30（2.0 ≤9） | ≤3 | ≤9 |
| 原生音频 | 单声道 | 文档冲突 | 立体声 |
| seed | 2.x 未列支持 | 支持（需关闭 enhancePrompt） | 支持 |
| 并发 | 企业 10 / 个人 3 | 未核实 | 自有算力 |
| 720p 5 s 参考价 | $1.156 | $2.00（含音频） | 自托管 |

关键事实：
- Seedance 创建任务端点：火山 POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks（SP/ark_create.txt:2）；BytePlus POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks（SP/bp_1520757.txt:2）
- Seedance 查询端点 GET .../contents/generations/tasks/{id}；video_url 有效期 24 h，2.5 下载上限 100 次，任务记录保留 7 天（SP/ark_1521309.txt:2-12）
- 当前 Seedance 模型 ID：doubao-seedance-2-5-260628 / 2-0-260128 / 2-0-fast-260128 / 2-0-mini-260615 / 1-5-pro-251215（即将下线）/ 1-0-pro-250528 / 1-0-pro-fast-251015（SP/ark_1330310.txt:199,742,868,1230,1940,2480,2524）；BytePlus 前缀为 dreamina-seedance-2-x 与 seedance-1-x（SP/bp_1330310.txt:249,803,915,1183,1855,2001,2457）
- Seedance 2.0 参考上限 图 0-9、视频 0-3、音频 0-3，音频不可单独输入；2.5 图 0-30、视频 0-10、音频 0-10，支持仅音频，30 秒连贯直出（SP/ark_create.txt:357,367）
- Seedance duration：2.5 [4,30] 或 -1；2.0 系列 [4,15] 或 -1；1.5 pro [4,12]；1.0 pro [2,12]（SP/ark_create.txt:1249-1257）；resolution 2.5 ≤1080p，2.0 含 4k，fast/mini 仅 480p/720p（:475-487）
- Seedance ratio 枚举 16:9、4:3、1:1、3:4、9:16、21:9、adaptive；2.5 在编辑/延长/首帧任务仅允许 adaptive（SP/ark_create.txt:549-561）
- Seedance seed 范围 [-1,2147483647]，官方「模型支持」仅列 1.5 pro / 1.0 pro / 1.0 pro fast，且相同 seed 不保证完全一致（SP/ark_create.txt:585-603）
- Seedance generate_audio 默认 true，支持 2.5/2.0/1.5 pro，输出为单声道，建议对白置于双引号（SP/ark_create.txt:724-742）；watermark 默认 false（:803-809）；callback_url 状态 queued/running/succeeded/failed/expired（:116-132）
- Seedance 2.x 不接受含真人人脸的参考图/视频（SP/ark_create.txt:788-796）；开通需余额 >200 元或 >USD 30（:489-499；SP/bp_1520757.txt:246-252）
- Seedance 2.x 配额：企业 RPM 600/并发 10，个人 RPM 180/并发 3；2.0 4K RPM 15/并发 1；flex 不支持（SP/bp_1330310.txt:279-291,1215-1243）
- Seedance 计价：token=(输入视频时长+输出时长)×宽×高×帧率/1024；2.5 USD 10.70/6.40（480p-720p）、11.7/7.0（1080p，限时 72 折）；2.0 7.0/4.3、7.7/4.7、4K 4.0/2.4（SP/bp_1544106.txt:76,823-839,1013-1023）；CNY 2.5 70/42、77/46；2.0 46/28、51/31、26/16（SP/ark_1544106.txt:1545-1561,1723-1733）
- Seedance 2.5 官方示例价（16:9 5 s）：480p $0.514、720p $1.156、1080p $2.843（约 $0.569/秒）（SP/bp_1544106.txt:1711-1713,1969-1971,2077-2079）
- Veo 3.1 模型 ID：veo-3.1-generate-001 GA（2025-11-17 发布）、veo-3.1-fast-generate-001 GA、veo-3.1-lite-generate-001 Preview（2026-04-02）、preview 变体退役日 2026-04-02（SP/veo31.txt:96-99,191-194,296-298,410-413）
- Veo 3.1 GA 规格：4/6/8 s，参考图生视频仅 8 s，每次最多 4 条，输入图 ≤20 MB，9:16/16:9，输出 720p/1080p/4K，24 fps，仅 us-central1，配额 50 请求/分钟（SP/veo31.txt:67-93）
- Veo 端点：POST .../publishers/google/models/MODEL_ID:predictLongRunning 与 :fetchPredictOperation（body operationName），响应 videos[].gcsUri/bytesBase64Encoded 与 raiMediaFilteredCount（SP/veo_refimg.txt:683-826）
- Veo parameters：sampleCount、storageUri、fps、durationSeconds、seed（sampleCount>1 时各视频 seed 不同；enhancePrompt 开启则不保证一致）、aspectRatio 16:9/9:16、personGeneration dont_allow/allow_adult/allowAll、negativePrompt、enhancePrompt 默认 true、generateAudio 默认 true、compressionQuality optimized/lossless、task、resizeMode pad/crop（SP/g_VideoGenerationModelParams.txt）
- Veo instances：image 仅 image/jpeg、image/png；lastFrame 须配合 image；video 无 mask 为延长、有 mask 为编辑；referenceImages 最多 3 张 asset 或 1 张 style（SP/g_VideoGenerationModelInstance.txt）
- Veo 延长：输入 1-30 s、24 fps、720p/1080p/4k；每次延长 7 s，最长 37 s（SP/g_extend-videos.txt:10-13,103-117）
- Veo 计价（USD/秒）：3.1 含音频 0.40（720p/1080p）、0.60（4k），无音频 0.20/0.40；Fast 0.10/0.12/0.30；Lite 0.05/0.08（SP/veo_pricing.txt:2346-2440）
- Veo 3.1 模型页将 veo-3.1-generate-001 与 fast 的 Sound generation 标为 Not supported，Lite 标为 Supported，与计价页「Video + Audio」冲突（SP/veo31.txt:44-45,139-140,243-244）
- MiniMax H3：API 2026-07-31 上线，权重 2026-08-03 开源，33B 稠密 Omni Transformer，文本编码器 Qwen3-VL-32B，768p、4-15 s、24 fps、32 kHz 立体声，11 语言对白；Context-IR、Regenerate-2K、稀疏注意力未开源（https://www.minimax.io/news/minimax-h3-open-source；https://huggingface.co/MiniMaxAI/MiniMax-H3）
- MiniMax H3 许可证（2026-08-02）：排除欧盟、英国、韩国、美国；年收入 >2000 万美元需书面授权；商用界面须显示「MiniMax H3」；禁止用于改进其他模型；香港法律管辖（https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE）
- ComfyUI 核心 nodes_minimax_h3.py 定义 EmptyMiniMaxH3LatentAV、MiniMaxH3ImageToVideo、MiniMaxH3AddGuide、MiniMaxH3ReferenceToVideo、MiniMaxH3SigmaShift（显示名 ModelSamplingMiniMaxH3）；要求 ComfyUI ≥0.30.0（https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py；https://docs.comfy.org/tutorials/video/minimax/minimax-h3）
- MiniMaxAI/MiniMax-H3 总 498 GB：transformer 与 transformer_ref 各 14 分片 66.3 GB，text_encoder 14 分片约 66.7 GB，vae 10.4 GB，audio_vae 605 MB（https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/main）
- Comfy-Org/MiniMax-H3：diffusion bf16 66.3 GB、int8_convrot 34 GB、pruned_bf16 40.2 GB、pruned_fp8_scaled 21 GB、pruned_int8_convrot 21 GB；text_encoders bf16 51.5 GB、int8 27.1 GB、nvfp4_awq 15.7 GB；video VAE fp16 5.21 GB、audio VAE fp32 605 MB；3 个 turbo LoRA 各 1.96 GB（https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main）
- MiniMax H3 vLLM 官方 recipe：4×B300 最优；2×RTX 5090 / 2×4090 需 DLO 与 384 GiB 主机内存；单卡 ≥24 GB 需 CPU offload；FP8 在线量化仅 DiT 且与 DLO 不兼容；INT8 用于 Ascend（https://recipes.vllm.ai/MiniMaxAI/MiniMax-H3）
- MiniMax H3 托管 API：2K $0.13/秒、768P $0.08/秒，前 5 张输入图免费后 $0.04/张（https://platform.minimax.io/docs/guides/pricing-paygo.md）

未决问题：
- Veo 3.1 GA 模型页「Sound generation: Not supported」与计价页/参数参考（generateAudio 默认 true）冲突，实际是否输出音频需以 API 实测为准
- Veo 4K：参考图指南写「4k (Veo 3.1 Preview models only)」，而模型页 veo-3.1-generate-001 输出分辨率含 4K，GA 端点能否请求 resolution=4k 未核实
- Veo personGeneration 枚举两处不一致（dont_allow/allow_adult/allowAll 与 allow_adult/disallow），实际接受值未核实
- Veo 并发上限（同时进行的长时操作数）官方页未给出，未核实；模型页配额文本写作「50 tokens per minute」，应为请求数
- Seedance 2.0/2.5 是否接受 seed 参数：官方字段说明未列入支持，是否被忽略或报错未核实
- Seedance 1.0 lite（seedance-1-0-lite-t2v/i2v-250428）当前是否仍可调用未核实，两侧模型列表均未收录
- Seedance 对白口型质量无官方指标，仅教程示例提示词要求「精准对口型」
- MiniMax H3 托管 API 并发上限官方未列（第三方称免费 2 / 付费 15，未核实）
- MiniMax H3 本地权重的「视频延长」无独立任务类型，是否可通过 MiniMaxH3AddGuide 或 Ref2VA 实现连贯延长未核实
- MiniMax H3 官方未给出各量化档位的显存数字，24 GB 以下单卡路线仅有社区实测（640×384 低分辨率）

---

