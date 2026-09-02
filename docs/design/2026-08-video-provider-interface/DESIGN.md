# 视频生产管线设计：统一 provider 接口与 Seedance / Veo 3.1 / MiniMax H3 三后端接入

基线：writing-loop `main@1455194`（仓库 `/Users/shuai/workspace/jinko/writing-loop/`，下文 `hub/src/…`、`references/…`、`docs/…` 相对该仓库）；video-creation-studio `99ab86f`（仓库 `/Users/shuai/workspace/citronetic/video-creation-studio/`，下文 `tools/…`、`lib/…`、`schemas/…`、`skills/…`、`pipeline_defs/…` 相对该仓库）；剧本数据 `/Users/shuai/dramas/yujing-jiushi/`。provider 文档引用为核查时抓取的文本文件 `SP/*.txt`（scratchpad 目录）。

术语（全文固定）：ShotRequest（不可变镜头请求）、ShotRequestDraft（编译前草稿，下文简称 draft）、intent（`ProductionIntent`，不可变调度意图）、take（handoff 中已批准任务的产物）、候选图（`visual/production.v1.json` 的 `candidates[]`）、execution profile（后端静态参数文件）、Degradation（编译决策记录）、reservation（预算预留）、gateway 实例（见 §8.0）。

## 1. 结论摘要

1. 推荐架构：以 writing-loop 的 production 子系统（ProductionStore 账本 + 不可变 intent + coordinator + 私有 gateway 的 jobs / stages / ingests 三个 kernel）为执行骨架，三家后端在 gateway 内以 provider adapter 接入；video-creation-studio（下文 VCS）只承担 handoff 之后的 proposal、edit、compose、publish。
2. 三家后端的统一方式：每个镜头编译为一份内容寻址的 ShotRequest 并作为 intent `inputs[0]`，逐镜变量（模式、时长、seed、输入 slot、prompt）全部在 ShotRequest 内；后端静态参数（provider、modelId、分辨率、画幅、音频开关）在 execution profile 内并构成五项 `workflowBindingKey`；能力差异由 `BackendCapabilities.limitsByModelId` 描述，编译器据此拒绝或降级并写入 Degradation。adapter：MiniMax H3 → 现有 `ComfyUiAdapter` 经薄包装（`comfyui-workflow` / `minimax-h3`）、Seedance → `ArkVideoAdapter`（operation `ark-video-task`）、Veo 3.1 → `VertexVeoAdapter`（`vertex-veo-lro`）。coordinator ↔ gateway 契约与 ProductionTask 状态机不变。
3. 实现顺序：本版的唯一执行后端为私有部署的 MiniMax H3 over ComfyUI。Seedance 与 Veo 保留在接口定义与类型层（枚举、execution 分支、编译校验、映射表），adapter 实现后置——Seedance 待 BytePlus 账户就绪（Phase 3），Veo 只接受英文 prompt，归入后续外语项目（Phase 4）。
4. 第一条视频的最短路径：Phase 0（契约、编译器 H3 分支、CLI、runtime config 的私网 HTTP transport 选项，零网络）→ Phase 1（在 GPU VM 上装配 gateway 进程，jobs / stages / ingests 三个 kernel 与 ComfyUI 同机；worker 在本机经 IAP ssh 隧道的 loopback HTTP + bearer 访问；H3 live `/prompt` 探针）→ 一条 H3 fl2va 任务（9:16、短边 768、时长取已配置 profile 档，首帧为 operator-upload）经 `production plan-shots --plan → --confirm → production-worker --once → production qc --approve → production handoff` 入库。成本按 Spot g4-standard-48 约 1.55 USD/h 的 GPU 小时记 `tariff`，不产生 provider 账单。
5. 已决策事项（2026-08-28，操作者裁定）：

| 序 | 决策 | 落地位置 |
|---|---|---|
| 1 | 第一阶段只做私有部署的 MiniMax H3 over ComfyUI；Seedance 与 Veo 的 adapter 保留在接口设计中，实现顺序后置 | §1.3、§3、§5.1–§5.3、§8.1–§8.5 |
| 2 | 不使用 TLS，worker 与 gateway 之间为 VPC 私网明文 HTTP + 静态 bearer；runtime config 新增 owner-only 的 `transport: "insecure-private-http"` 选项（baseUrl 只允许 RFC1918 私网 IPv4 或 127.0.0.1，`credentialEnv` 保留为必填） | §8.0、§8.1、§8.6、§9.4 |
| 3 | GCP 项目 €50/月硬顶只作用于现金支出，项目持有 credit；删除项目级月度余量门与 `vmWindow` 审批点，`projects[].availableBudgetMicros` 取足够大的常量并注明本版不作为门；per-intent reservation 机制不变 | §4.6、§4.7、§9.1、§9.4 |
| 4 | 本版只做中文：`dialogue[].language` 与 prompt 语言固定 `zh-CN`；删除英文译文供给步骤；Veo 因只接受英文 prompt 归入后续外语项目 | §4.1、§5.2、§6.1、§8.5 |
| 5 | 镜头合并采用 `stageGroup` 内合并，判定条件与合并结果写入正文规则 | §6.1、§4.1 |
| 6 | H3 部署地为新加坡（asia-southeast1）：`useTerritories` 与 `deploymentTerritories` 均为 `["SG"]`，不命中 EU / GB / KR / US，无需书面许可；署名义务与年收入声明保留为项目配置项 | §5.3、§8.2、§9.1 |
| 7 | `safety_identifier` 的对账用法随 Seedance 后置，不再作为决策项 | §7、§8.4、§9.3 |
| 8 | 英文译文由写作侧 agent 供给，本版不做 | §4.1、§8.5 |
| 9 | `availableBudgetMicros` 本版不需要人工维护，先跑通链路 | §4.7、§8.6 |
| 10 | （2026-09-02）writing-loop 控制面运行在本机，远程服务器 writing-loop-sg 不是必需的；本机经 IAP ssh 隧道访问 GPU VM 上只绑 127.0.0.1 的 gateway；gateway 安装包经隧道 scp，VM 不需要出网 | §8.0、§8.2、§9.4 |

裁决的四处内部一致性修正（2026-08-28）：execution profile 与价目文件由 gateway 的 server-owned registry 持有，worker 侧只引用 `profileId` 与 digest，`plan-shots` 的估算读取 gateway 导出的只读 profile 快照文件（§4.2、§4.7）；Seedance 的 `seed` 在编译层为 error（`seed_rejected`），不再有 warning 语义（§4.1、§5.1）；`ShotRequest.output` 只保留 `aspectRatio` 与 `generateAudio` 作为请求意图并与 execution profile 校验一致，`resolutionClass` 移除，画幅枚举以 ShotRequest 的集合为准（§4.1、§4.2）；三个无触发规则的 Degradation code（`reference-video-dropped`、`reference-audio-dropped`、`native-audio-off-post-dub`）删除，视频 / 音频参考被裁剪统一记 `references-trimmed`（§4.1、§5.2）。

## 2. 现状

### 2.1 video-creation-studio（`99ab86f`）

| 组件 | 路径 | 现状 |
|---|---|---|
| 控制面 CLI | `skills/video-creation-studio/scripts/studio.py` | `doctor / pipelines / init / status` 四个确定性命令；不含 LLM 客户端，不调用 provider |
| 检查点与门 | `lib/checkpoint.py` | `human_approval_default` 阶段写 `completed` 且 `human_approved` 非 True 时抛 GATE VIOLATION；`_validate_artifacts_for_stage` 要求 completed / awaiting_human 含 canonical 与 `produces` 全部工件；`get_next_stage` 按清单顺序返回首个未完成阶段；阶段名集合 `ALL_KNOWN_STAGES` |
| 流水线清单 | `pipeline_defs/*.yaml`（12 条 + framework-smoke） | 无 scripted-drama；样片为 proposal 子阶段 |
| provider 抽象 | `tools/base_tool.py`、`tools/tool_registry.py`、`lib/scoring.py`、`tools/video/video_selector.py` | `BaseTool` 子类以类属性声明能力，`execute(inputs: dict) -> ToolResult`；`pkgutil` 自动发现注册；加权评分选择；`lib/providers/` 为空目录 |
| Seedance 官方 adapter | `tools/video/seedance_volcengine.py`、`tests/tools/test_seedance_volcengine.py` | 火山 cn-beijing 端点；t2v / i2v / 首尾帧 / 参考；本地图片转 data URL（<30 MB，body <64 MB）；seed 非空抛错；`negative_prompt` 以「避免出现：」拼入 prompt；创建 POST 不重试，轮询 429/5xx 最多 3 次；CNY 价目表与每秒 token 估算常量；实际成本按 `usage.completion_tokens` 反算 |
| Veo adapter | `tools/video/veo_video.py`、`tools/google_credentials.py` | google-genai SDK（模型 `veo-3.1-generate-preview`）或 fal；Vertex 客户端被拒绝；1080p / 4k / 参考强制 8 s；轮询上限 600 s |
| ComfyUI client | `tools/_comfyui/client.py`、`tools/video/comfyui_video.py`、`tools/graphics/comfyui_image.py`、`tests/contracts/test_comfyui_tools.py` | `/system_stats`、`/object_info`、`/prompt`（无 client_id、无调用方 prompt_id）、`/history`、`/view`、`/upload/image`；bundled WAN / Flux 模板按节点 ID 打补丁；无 MiniMaxH3 节点、无 H3 bundle、无音频 VAE 角色 |
| 合成 | `tools/video/video_compose.py` | `_render`、`_pre_compose_validation`、`_run_final_review`；按 `render_runtime` 分派 hyperframes / ffmpeg / remotion，不可用时阻断不切换 |
| 工件 schema | `schemas/artifacts/{scene_plan,asset_manifest,decision_log,proposal_packet,edit_decisions}.schema.json` | `scene_plan.scenes[].shot_language` 六字段枚举（`additionalProperties: false`）；`asset_manifest.assets[]` 含 `subtype`、`license`（`additionalProperties: false`）；`decision_log.decisions[]` 统一对象，`provider_selection` 为 `category` 枚举值 |
| 成本 | `tools/cost_tracker.py`、`config.yaml`、`lib/config_model.py` | 默认 `mode: observe`、`total_usd: null`；成本只记录，不构成暂停条件 |
| 观察板 | `backlot/state.py` | 只读推导阶段轨道、分镜卡片、`gate_skipped` 审计 |
| 执行契约文档 | `skills/video-creation-studio/references/execution-contract.md`、`skills/meta/checkpoint-protocol.md`、`skills/pipelines/cinematic/asset-director.md`、`docs/PROVIDERS.md` | 每类付费资产先出样本再批量；`reference-video-studio` 为旧版独立流程 |

### 2.2 writing-loop（`main@1455194`）

| 组件 | 路径 | 现状 |
|---|---|---|
| 任务域模型 | `hub/src/production-domain.ts` | ProductionTask 14 状态、5 终态、转移表 `PRODUCTION_TRANSITIONS`；`AssetRef{version, uri, sha256, byteLength, mediaType}`（scheme 白名单含 `cas:`、`urn:`）；`ProductionCost` 仅 USD，basis reported / billed / estimated；`MAX_PRODUCTION_TEXT_LENGTH` 4096；`ShotRevisionRef`；取消恢复矩阵 `CANCELLATION_RECOVERY_TARGETS` |
| 不可变 intent 与 gate | `hub/src/production-intent.ts` | operations `[comfyui-workflow, minimax-h3]`，families `[generic, minimax-h3]`，`H3_VARIANTS [fl2va, ref2va]`；`inputs` 1–32 个 AssetRef；`idempotencyKey = sha256(canonical draft)`；gate：预算两项、rights、moderation、license、H3 地域 written-license（EU 成员 / EU / GB / KR / US） |
| adapter 契约与 ComfyUI 实现 | `hub/src/production-adapter.ts` | `ProductionAdapter{capabilities, prepareSubmission, submitPrepared, inspect, cancel}`；`BackendCapabilities.backendKind` 字面量 `"comfyui"`；`ComfyUiAdapter`：预分配 UUID、按真实 body 字节计算 `requestDigest`、恰好一次 POST、`/queue` 与 `/history` 交叉读取、`/queue delete` + 门控 `/interrupt` |
| coordinator | `hub/src/production-coordinator.ts`、`production-coordinator-domain.ts`、`production-reconcile.ts` | intent → gate → workflow descriptor 三 digest 比对 → stage → verify → prepare → 预留 maximum → `submission-started` 落盘 → 一次 submit → inspect；`settleQcBudget` 仅 reported / billed 释放；`errorSummary` 只允许 `execution_error[:Type] \| execution_interrupted`；`MODEL_FAMILIES` |
| worker 运行时配置 | `hub/src/production-runtime-config.ts` | backends kind 仅 `comfyui \| production-gateway`（后者必须 HTTPS + `credentialEnv`，loopback 不豁免）；`workflows[]`（五项 binding 字段）、`stagingProfiles[]`（execution 必须 minimax-h3）、`projects[]`；`ImmutableWorkflowRegistry`；`ExactWorkflowBindingVerifier`；`createProductionRuntimeRegistry`；配置文件 0400/0600 |
| gateway 三 kernel | `hub/src/production-job-gateway.ts`（jobs kernel + 客户端 `ProductionGatewayAdapter`）、`production-stage-gateway.ts`（stages：CAS 硬链接到 `<root>/objects/<namespace>/<sha256>`，`assetPolicies{scheme, authority}`，媒体类型白名单）、`production-gateway.ts`（ingests：只从 `comfyBaseUrl/view` 下载，sha256 / 长度 / 魔数校验，产出 `urn:sha256:<digest>`）、`production-gateway-router.ts`（`node:http`，只绑字面私网 IP，无 TLS） | 仅接口与 kernel 类；仓库内无 gateway 进程装配，`ProductionJobProfileRegistry` / `ProductionStageProfileRegistry` 仅有接口 |
| H3 graph 契约 | `hub/src/production-h3-graph.ts`、`hub/examples/production/representative-h3/` | generator class `MiniMaxH3ImageToVideo \| MiniMaxH3ReferenceToVideo`；四组件 bundle 各带 `artifactSha256`；`assertGraph` 精确节点集合、fps 24；LoadImage sentinel；`generator.prompt` 与 `RandomNoise.noise_seed` 在参数投影内；未经 live `/prompt` 验证 |
| staging 客户端 | `hub/src/production-input-stager.ts` | `stageKey = sha256({version, scope, taskId, intentDigest, execution, inputs[{index, asset}]})` |
| ingest 客户端与读模型 | `hub/src/production-ingestor.ts`、`production-read-model.ts`、`production-money.ts` | `ingestKey` + `ingest`；`ProductionCostSummary` 按 basis 汇总 |
| CLI 与 worker | `hub/src/cli.ts`、`production.ts`、`production-enqueue.ts`、`production-worker.ts` | `production status \| enqueue --plan/--confirm \| handoff`；worker `--config FILE --once`；无 qc 写入入口、无 plan-shots、无 approve-candidate |
| handoff | `hub/src/production-studio-handoff.ts` | `VideoStudioHandoff` v1（contract `citronetic-video-creation-studio-codex-handoff-v1`）：只接受 shot、approved、非空 assets、同一 episode revision、shotId 唯一 |
| 剧本解析 | `hub/src/script-lint.ts`、`references/script-format.md` | 场景头正则（集号 / 场序 / 地点 / 时段 / 内外）、动作行 `▲`、对白、调度单 `人物：`；`ScriptScene{location, timeOfDay, interior, roster, speakers, actionLines}`；「一行动作 = 一个镜头」；`OS` = 内心独白、`VO` = 画外音 |
| 视觉制作清单 | `hub/src/visual-production.ts`、`references/visual-production-schema.md`、`/Users/shuai/dramas/yujing-jiushi/visual/production.v1.json` | 仅 S01，`phase: passes-ready`：3 个 9:16 机位（`lensMm / transform`）、2 个 `lightingStates`、1 个 `dressingVariants`、12 张 clay / depth / normal / lineart；`candidates: []`；只有 approved 候选图可作 H3 输入 |
| 剧本与设定数据 | `/Users/shuai/dramas/yujing-jiushi/episodes/ep-001…ep-060.md`、`story/outline.v1.json`、`story/assets.v1.json` | 60 集 131 场（每集 1–3 场，均值 2.18；每场动作行 2–44，均值 14.6）；人物外观 `facts[visual]`、道具状态 `lifecycle` 均为逐集散文；无 language / lipSync / 景别 / 机位 / 时长 / 站位字段；`presence` fact 只登记 33 集 |
| 设计文档与测试 | `docs/design/phase-3-remote-production/AI-SPEC.md`、`references/config-schema.md`、`hub/test/production-*.ts` | 连续性包仅在 AI-SPEC:178-180 有文字定义；AI-SPEC 与代码差异两处（cancelled 边、`ingestKey` 方法） |
| 部署 | writing-loop-sg（10.148.0.5）；GCP 镜像 `wl-comfy-h3-g4-sg`（asia-southeast1）；GCP 项目 jinko-vibe-coding | 服务器 workspace 为账本，本机 `~/dramas` 为 paused 副本；镜像未跑过推理；项目 €50/月硬顶（`stop_billing`）只作用于现金支出，项目持有 credit，本版不作为门（§4.7）；服务器 ffmpeg / Node / systemd 权限未核实 |

## 3. 三家后端能力矩阵

| 能力项 | Seedance（火山方舟 / BytePlus ModelArk） | Veo 3.1（Vertex AI） | MiniMax H3（ComfyUI，自托管） |
|---|---|---|---|
| 接入形态 | 异步任务：`POST /api/v3/contents/generations/tasks` + `GET …/tasks/{id}`；主机 `ark.cn-beijing.volces.com`（CNY）/ `ark.ap-southeast.bytepluses.com`（USD） | 异步 LRO：`:predictLongRunning` + `:fetchPredictOperation`；仅 `us-central1`（`global` 未核实） | ComfyUI `POST /prompt` + `/queue` + `/history` + `/view`；gateway 与 ComfyUI 同机 |
| 模型 ID | `doubao-seedance-2-0-260128` / `-2-0-fast-260128` / `-2-0-mini-260615` / `-2-5-260628`；BytePlus 前缀 `dreamina-` | `veo-3.1-generate-001`（GA）、`veo-3.1-fast-generate-001`（GA）、`veo-3.1-lite-generate-001`（Preview） | 四组件 bundle（UNETLoader / CLIPLoader / VAELoader×2）各带 `artifactSha256`；权重来源 Comfy-Org/MiniMax-H3 |
| t2v | 支持 | 支持 | 契约 v1 仅 fl2va / ref2va；编译返回 `unsupported_operation` |
| i2v 首帧 / 首尾帧 | `content[]` role `first_frame` / `last_frame` | `image` / `lastFrame`（lastFrame 须配合 image） | LoadImage slot `first_frame` / `last_frame`（fl2va） |
| 参考素材 | 2.0：图 ≤9 / 视频 ≤3 / 音频 ≤3，不允许仅音频，音频单段 [2,15] s；2.5：≤30 / ≤10 / ≤10，允许仅音频，单段 [2,30] s，单次素材 ≤50 | generate-001 / fast：`referenceImages[]` ≤3 张 asset 或 1 张 style，仅 8 s；lite：不支持；三者均无视频 / 音频参考 | ref2va `reference.N` ≤9 图；视频 / 音频参考不在契约内 |
| 首尾帧与参考互斥 | 是 | 是 | 是（不同 generator class） |
| 时长 | 2.0：4–15 s；2.5：4–30 s | 4 / 6 / 8 s；1080p / 4k ⇒ 8 s（保守默认，未核实） | 4–15 s；网格 = 已配置 profile 集合；帧数对齐 17k+5 |
| 画幅 | 16:9、4:3、1:1、3:4、9:16、21:9、adaptive；2.5 在 i2v / fl2v 仅 adaptive | 16:9、9:16 | 9:16、16:9、1:1 |
| 分辨率 | 480p–1080p；4k 仅 `*-seedance-2-0-260128`；fast / mini ≤720p | generate-001：720p / 1080p / 4k；fast：720p / 1080p（4k 两处文档冲突，未核实）；lite：720p / 1080p | 短边 768 |
| seed | 2.x 未列入支持 → 强制 `null`；忽略还是报错未核实 | uint32，best-effort（Veo 3.x prompt rewriter 不可关闭） | 逐档判定（`h3LimitsByProfileId`，`hub/src/production-adapter.ts`）：契约 v1 档 `seed: "unsupported"`，契约 v2 档 `seed: "uint32"`，逐镜下发且可复现 |
| prompt 语言 | 中英均可；建议中文 ≤500 字 / 英文 ≤1000 词 | 仅英文 | 无文档限制，Phase 4 实测 |
| prompt 文本指令 | 文本尾部 `--rs/--rt/--dur/--seed/--cf/--wm/--frames` 为弱校验传参；与 body 冲突时优先级未核实 | 无 | 无 |
| 原生音频 | `generate_audio`，单声道 | generate-001 / fast：模型页 Not supported 与计价页 Video + Audio 冲突 → 未核实；lite：Supported | 立体声 32 kHz |
| 对白口型 | 教程示例要求「精准对口型」，无官方指标 | 提示词驱动，无官方指标 | 官方声明 11 种语言，未实测 |
| 尾帧回传 | `return_last_frame=true` → `last_frame_url` | 无；ingest kernel ffmpeg 提取 | 无（capability `returnsLastFrame: false`）；ingest kernel 的 `#deriveLastFrame`（`hub/src/production-gateway.ts`）用注入的 ffmpeg 提取器派生，宿主机没有可用 ffmpeg 或主视频不唯一时该次 ingest 以 `derivation-failed` 失败 |
| 输出取回与保留 | `content.video_url` 24 h 有效，2.5 下载 ≤100 次；任务记录 7 天 | 响应内 base64（inline）或 `videos[].gcsUri`；LRO 结果保留期未核实 | `/view`；`outputRetention: {kind: "comfy-history", bounded: true}`，history 进程内、重启清空 |
| locator source（§4.5） | `provider-output`（Phase 3 实现） | `provider-output`（Phase 4 实现） | `comfy-view`：ingest kernel 经 `comfyBaseUrl/view` 取回；`ComfyUiAdapter` 包装因此不实现可选的 `openOutput`（`hub/src/production-provider-adapter.ts`） |
| 取消 | queued：`DELETE /tasks/{id}`；running：不支持（已确认）；终态：DELETE 为删除记录 | 未见 LRO 取消文档 → unsupported | `/queue delete` + 门控 `/interrupt` |
| 幂等 / 任务 ID | 无幂等键；provider 分配 `task_id`；`safety_identifier` 查询时原样返回 | 无幂等键；provider 分配 operation name | 调用方预分配 `prompt_id`（UUID） |
| 并发 / 限流 | 企业 RPM 600 并发 10；个人 RPM 180 并发 3；2.0 4k RPM 15 并发 1 | 50 请求 / 分钟；并发上限未核实 | 自有算力；Spot 抢占即任务丢失 |
| 处理地域 | CN（火山）/ SG（BytePlus） | US | 部署地（当前 GCP SG） |
| 真人人脸 | 2.x 拒绝含真人人脸的参考图 / 视频 | `personGeneration` 接受值三份文档不一致，未核实；v1 不下发 | 无 provider 限制（capability `realFaceReferences: "allowed"`） |
| 许可 / 合规 | 开通条件：火山余额 >200 元或 BytePlus 余额 >30 USD | 项目 `allowedProcessingRegions` 须含 US | Community License：排除 EU / GB / KR / US（需书面许可）；年收入 ≥2000 万 USD 需书面授权；须署名「MiniMax H3」；输出不得用于改进其他模型 |
| 计价 | token 制，USD（BytePlus）或 CNY（火山）；按 {resolution, withVideoInput} 二维价目；示例 2.0 480p 0.07 USD/s、720p 0.15 USD/s；2.5 720p 0.231 USD/s | 按秒：3.1 含音频 0.40（720p / 1080p）/ 0.60（4k）USD/s；fast 0.10 / 0.12 / 0.30；lite 0.05 / 0.08 | 自托管：Spot g4-standard-48 约 1.55 USD/h，按需约 4.09 USD/h；托管 API 768p 0.08 USD/s（不在本设计路径） |
| 成本 basis | `reported`（BytePlus）/ `reported-converted`（火山） | `tariff` | `tariff`（配置费率）或 `unknown` |
| 视频延长 | 支持（非目标，`mode: extend` 解析拒绝） | +7 s / 次，≤37 s（非目标） | 无独立任务类型，未核实（非目标） |
| 凭据形态 | `{kind: "api-key-env"}`：`BYTEPLUS_ARK_API_KEY` / `VOLCENGINE_ARK_API_KEY` | `{kind: "google-service-account-file", pathEnv}`（veo-m2m.json 0600）；`google-adc` 在 writing-loop-sg 不可用 | 无（loopback）或 gateway bearer |
| 当前就绪状态 | BytePlus 账户、密钥、余额不存在；adapter 实现后置到 Phase 3 | 凭据 veo-m2m.json 与 us-central1 已验证；仅接受英文 prompt，adapter 实现后置到 Phase 4（外语项目） | 镜像已建（asia-southeast1）、未跑过推理；H3 graph 未 live 验证；本版唯一的执行后端 |

## 4. 统一接口定义

### 4.0 数据流与职责划分

```text
writing-loop workspace（control plane，零 provider 网络；运行在操作者本机，见 §8.0 决策 10）
  episodes/ep-NNN.md ──script-lint.ts──▶ ShotRequestDraft
  visual/production.v1.json（approved 候选图、subjectReferences、mappings）──▶ draft.continuity
  compileShotRequest(draft, capability, policy) ──▶ ShotRequest（workspace CAS）+ ProductionIntentDraft + ValidationReport
  production plan-shots --plan / --confirm ──▶ intents + tasks（现有 enqueue 语义）
  production-worker --once（本机手动或 launchd，间隔 ≤ 6 h）──coordinator──▶ ProductionGatewayAdapter（经 IAP ssh 隧道的 loopback HTTP + bearer）
  production qc --approve / --reject ──▶ approved / rejected 事件
  production handoff --export-dir ──▶ VideoStudioHandoff v2 + 资产目录 ──▶ 本机 VCS（同一台机器，不需要 rsync）

私有 gateway（trust domain，server-owned registry；本版为与 ComfyUI 同机的单实例，见 §8.0）
  jobs kernel ── ProductionProviderAdapter
      ├─ ComfyUiAdapter（现有，H3；本版唯一实现）
      ├─ ArkVideoAdapter（Seedance，Phase 3 实现）
      └─ VertexVeoAdapter（Veo，Phase 4 实现）
  stages kernel ── 输入 CAS（现有）+ ShotRequest 内容校验 + slotPolicy（扩展）
  ingests kernel ── /view 下载（现有）+ provider-output 下载 + 尾帧提取（新）

video-creation-studio（合成端，pipeline scripted-drama，运行于本机）
  import_handoff.py ──▶ scene_plan / asset_manifest / 检查点 / decision_log
  proposal（渲染运行时门）→ edit → compose（video_compose.py）→ publish
```

| 职责 | 系统 | 现有依据 |
|---|---|---|
| ShotRequest 生成、编译、版本绑定 | writing-loop hub | `hub/src/script-lint.ts`；`hub/src/visual-production.ts` |
| 不可变 intent、idempotencyKey、gate、reservation | coordinator | `hub/src/production-intent.ts`；`hub/src/production-coordinator.ts` |
| 凭据、模型 ID、execution profile、价目、并发准入 | gateway registry（worker 侧只引用 `profileId` 与 digest，§4.2） | `hub/src/production-job-gateway.ts` |
| 提交、轮询、取消、输出下载、尾帧提取 | gateway kernels | `hub/src/production-adapter.ts`；`hub/src/production-gateway.ts` |
| QC 裁决 | writing-loop（人工，`production qc`） | `hub/src/production-domain.ts` |
| 渲染运行时选择、剪辑、合成、导出 | VCS | `tools/video/video_compose.py` |

非目标：不修改 `ProductionTask` 的 14 个状态与转移表，不新增第三套状态机；不把 VCS 的 `tools/video/*.py` 接入执行路径；不实现分镜自动生成（`camera` 字段由分镜步骤或人工填写）；不建模视频延长（`mode` 保留 `extend` 值但解析拒绝）；worker、gateway、VCS Python 层不调用 LLM（prompt 译文由写作侧 agent 步骤或人工在 draft 中提供；本版不产出译文，见 §8.5）；v1 不提供静态图生成后端（候选图产出为并行人工轨道）。

### 4.1 ShotRequest（新增 `hub/src/production-shot-request.ts`）

```ts
export const SHOT_SIZES = ["extreme_wide","wide","medium_wide","medium","medium_close","close_up","extreme_close_up","over_shoulder","insert","establishing"] as const;   // = scene_plan.schema.json shot_size
export const CAMERA_MOVEMENTS = [/* scene_plan.schema.json camera_movement 的 18 个值，逐字复用 */] as const;
export const LENS_MM = [14,24,35,50,85,135,200] as const;
export const LIGHTING_KEYS = [/* scene_plan.schema.json lighting_key 的 11 个值 */] as const;
export const REFERENCE_PURPOSES = ["character-identity","costume","prop","set-dressing","lighting","style","motion","voice"] as const;  // 裁剪保留顺序
export const VIDEO_MODES = ["t2v","i2v","fl2v","ref2v","extend"] as const;   // extend 保留，解析拒绝

export type KeyframeInput = {
  asset: AssetRef;                                           // production-domain.ts；URI 形态见「资产 URI」
  origin:
    | { kind: "approved-candidate"; candidateId: string }    // visual/production.v1.json candidates[] status=approved；v1 为并行人工轨道（§6.2）
    | { kind: "previous-shot-last-frame"; shotId: string; taskId: string }
    | { kind: "previous-episode-end"; episodeId: string }    // ep-030.md【画面定格】承接
    | { kind: "operator-upload"; note: string };
  containsRealFace: boolean;
};
export type ReferenceInput = { asset: AssetRef; purpose: ReferencePurpose; subjectId: string | null; priority: 1 | 2 | 3; containsRealFace: boolean };
export const DEGRADATION_CODES = ["anchor-mode-selected","duration-rounded-trim","references-trimmed",
  "seed-not-reproducible","negative-prompt-folded","prompt-translated","seed-derived"] as const;   // 共 7 个
export type Degradation = { code: DegradationCode; from: string; to: string; requiresReapproval: boolean };

export type ShotRequest = {
  version: 1; kind: "writing-loop/shot-request";
  shotId: string;                                  // EP001-S1-3：集号-场序-▲行序
  subject: ShotRevisionRef;                        // production-domain.ts
  provenance: { storyDesignSha256: string; assetsRevision: number; visualProductionSha256: string | null; beatCardHash: string | null;
                scriptLine: number; mergedScriptLines: number[] };   // 合并镜头并入的其余 ▲ 行行号，无合并时为空数组（§6.1）
  scene: { sceneId: string; subscene: string | null; timeOfDay: "day"|"night"|"dawn"|"dusk"; interior: "int"|"ext"|"int-ext";
           lightingStateId: string | null; dressingVariantId: string | null };
  camera: { shot_size: ShotSize; camera_movement: CameraMovement; lens_mm: LensMm; lighting_key: LightingKey;
            depth_of_field: "shallow"|"medium"|"deep"; color_temperature: "cool"|"neutral"|"warm"|"mixed"; cameraId: string | null };
  cast: Array<{ characterId: string; name: string; appearanceStateId: string; voiceId: string | null; onScreen: boolean;
                performNotes: string | null; stage: { x: number; y: number; z: number; yawDeg: number; pose: string } | null }>;
  props: Array<{ objectId: string; stateId: string; visible: boolean; position: [number, number, number] | null }>;
  crowd: { label: string; count: number; cap: number } | null;
  action: string;
  productionTags: string[];                        // 【特写】【画面定格】【字幕】【音效】【特效】等内联标注
  dialogue: Array<{ speakerId: string; text: string; mode: "onscreen"|"os"|"vo"; language: string; lipSync: boolean }>;
  output: { aspectRatio: "9:16"|"16:9"|"1:1"|"21:9";        // 请求意图，编译器校验与 execution profile 的静态值相等
            generateAudio: boolean;                        // 请求意图，同上
            durationSeconds: number; storyboardDurationSeconds: number; fps: 24; seed: number | null };
            // 分辨率不在 ShotRequest 内，只由 execution profile 持有
  continuity: {
    stageGroup: string; prevShotId: string | null;
    anchorMode: "keyframes" | "references" | "none";
    firstFrame: KeyframeInput | null; lastFrame: KeyframeInput | null;
    references: ReferenceInput[]; referencePolicy: "strict" | "trim_by_priority"; droppedReferences: ReferenceInput[];
    spatialPasses: AssetRef[];                     // depth/normal/lineart 登记；v1 后端不消费
    fingerprint: { modelSha256: string | null; workflowSha256: string | null; seed: number | null; seedReproducible: boolean };  // Veo 恒为 false
  };
  prompt: { text: string; negativeText: string | null; language: string; authoredBy: string; compiler: string | null;
            selectedTranslation: { language: string; authoredBy: string } | null };   // 编译选用译文时非空，并记 prompt-translated
            // 本版 language 固定 zh-CN，selectedTranslation 恒为 null（§8.5）
  compile: { draftSha256: string; policyDigest: string; degradations: Degradation[] };
};
```

字段来源与约束：

| 字段 | 来源 / 约束 |
|---|---|
| `shotId` | 集号-场序-▲ 行序；行序来自 `script-lint.ts` 的 `actionLines` |
| `subject` | `ShotRevisionRef`（`hub/src/production-domain.ts`），绑定剧集 revision |
| `provenance` | `assetsRevision` 为 `story/assets.v1.json` 的 revision；`beatCardHash` 为剧本 frontmatter `beat-card-hash`；`scriptLine` 为 ▲ 行行号；`mergedScriptLines` 为合并镜头并入的其余 ▲ 行行号（§6.1） |
| `scene` | 场景头五段捕获组；`sceneId` 由地点前缀匹配 `story/outline.v1.json` `scenes[]`；`subscene` 为「·」后段；`lightingStateId` / `dressingVariantId` 经 `visual/mappings.v1.json` 得出，允许 null |
| `camera` | 六个枚举逐字复用 `schemas/artifacts/scene_plan.schema.json` 的 `shot_language`（该 schema 为 `additionalProperties: false`，修正 F4）；`cameraId` 引用 `production.v1.json` `cameras[]` |
| `cast[]` | 调度单与 `assets.v1.json` character `facts[visual / perform / voice]`；`stage` 为局部坐标站位（与 `shots_ep123.json` 的 `chars` 同形），允许 null |
| `props[]` | `stateId` 来自 `visual/prop-states.v1.json`；`position` 允许 null |
| `crowd` | 调度单 `*N` 计数；`cap` 来自 `EP0NN.production-flags`；允许 null |
| `dialogue[]` | `mode` 由对白前缀 `OS` / `VO` 推导（`references/script-format.md`）；`lipSync = mode === "onscreen"`；本版 `language` 固定 `zh-CN` |
| `output` | `aspectRatio` 与 `generateAudio` 为请求意图，编译器校验其与 execution profile 的同名静态值相等，不等返回 `output_intent_mismatch`（error）；画幅枚举以本表的四个取值为准，后端多出的取值（Seedance 的 4:3 / 3:4 / adaptive）不在 v1 支持；`durationSeconds` 为编译取整值，`storyboardDurationSeconds` 为分镜原值；`fps` 固定 24 |
| `continuity` | `stageGroup` 为分场 ID；`anchorMode` 由编译器决定；`lastFrame` 非空时 `firstFrame` 必须非空；`references` ≤ 12；`fingerprint.seedReproducible` 在 Veo 分支恒为 false |
| `prompt.text` | ≤ 4096 字符（`MAX_PRODUCTION_TEXT_LENGTH`） |

ShotRequest 以 `application/vnd.writing-loop.shot-request+json` 存入 CAS，作为 intent `inputs[0]`，因此 prompt 与全部连续性输入进入 `idempotencyKey` 与 `stageKey`。

`ShotRequestDraft`（`hub/src/production-shot-request.ts` 的 `ShotRequestDraft`）为 ShotRequest 去掉 `compile`、`anchorMode`、`droppedReferences`、`selectedTranslation`、`continuity.fingerprint`、`output.durationSeconds`、`prompt.compiler` 的形态，允许首尾帧与参考同时存在，另含 `prompt.translations: Array<{ language: string; text: string; negativeText: string | null; authoredBy: string }>`（可为空；本版恒为空数组，见 §8.5）。两处字段可空性与 ShotRequest 不同：`camera` 允许 null（剧本预填时分镜尚未产出，见 §6.1；编译对 null 报错），`prompt.text` 允许 null（写作侧尚未撰写，合并条件 10 据此判定）。`output.durationSeconds` 是编译取整的产物，留在 draft 会形成第二个事实来源，因此不在 draft 内。

`compileShotRequest(draft, capability, policy)` 为纯函数，输出 `{ shotRequest, intentDraft, validation }`，规则：

- 模式推导：`firstFrame && lastFrame → fl2v`；仅 `firstFrame → i2v`；`references.length > 0 → ref2v`；否则 `t2v`。首尾帧与参考并存时按 `policy.anchorPreference` 选一侧（缺省 keyframes），记 `anchor-mode-selected`（`requiresReapproval: true`）；落选侧只有其文本描述进入 prompt，图片不进入请求。
- 参考裁剪：超过 capability 上限时，`strict` 返回 `reference_cap_exceeded`；`trim_by_priority` 按 purpose 顺序（character-identity > costume > prop > set-dressing > lighting > style > motion > voice）再按 `priority` 保留，被裁剪项写入 `droppedReferences` 并记 `references-trimmed`。上限按 `limitsByModelId[modelId]` 取（§4.3），不按家族。
- 输出意图：`output.aspectRatio` 与 `output.generateAudio` 必须与 execution profile 的 `aspectRatio`、`generateAudio` 相等，不等返回 `output_intent_mismatch`（error）。分辨率不在 ShotRequest 内；profile 的 `resolution` 不在 `limitsByModelId[modelId].resolutions` 内时返回 `resolution_unsupported`；profile 的 `aspectRatio` 不在 `aspectRatios` 内时返回 `aspect_ratio_unsupported`。
- 时长：`durationSeconds = 后端网格上取整(max(4, storyboardDurationSeconds))`，Veo 取 {4, 6, 8}，记 `duration-rounded-trim`（`requiresReapproval: false`）；Veo 在 execution profile 的 `resolution ∈ {1080p, 4k}` 时网格固定为 {8}（保守默认，探针后可放宽）；H3 网格由已配置 profile 集合定义（§5.3）。
- 许可义务：`policy.project.licenseCompliance{annualRevenueUsdBelow, attributionSurfaces[]}` 与 license evidence 的 `obligations` 经 `licenseObligationViolations`（`production-intent.ts`，与 intent gate 同一纯函数）判定，违反项返回 `license_obligation_unmet`。`obligations.noModelImprovement` 只在这里判定、gate 不判定：它描述产物的后续使用方式，dispatch 前拿不到可取证的事实，因此按 `policy.project.usesOutputToImproveModels`（`licenseCompliance` 之外的独立字段）检查，并在 AI-SPEC 的使用约束中同步说明。
- seed：Seedance 分支 `output.seed` 非 null 时返回 `seed_rejected`（error，无 warning 形态）；Veo 分支接受 uint32 但总是记 `seed-not-reproducible`；H3 分支 seed 逐镜下发且可复现。H3 graph 契约 v2（capability `seed: "uint32"`）把 `RandomNoise.noise_seed` 换成 sentinel，materialize 需要一个具体整数，因此 `output.seed` 为 null 时编译期即返回 `output_intent_mismatch`（field `output.seed`），不留到 dispatch 期被 binding verifier 拒。剧本预填给不出 seed，`plan-shots --from-script` 按镜头内容派生一个 uint32（`sha256(canonicalJson(draft with seed=null))` 前 4 字节）并记 `seed-derived`（`requiresReapproval: false`）。派生位置是批次装配的最后一步：取的是**镜头合并、`mergedPatches` 与视觉填充（`applyVisualDefaults`）之后**的 draft，且在逐镜选定 execution profile **之后**——更早派生会撞上合并条件 10（「seed 不同」是阻断项，任何两镜都合不起来），而选档之前派生则无法区分该镜实际落到 v1 还是 v2 档。判定逐镜进行：只有选定档的 capability `seed` 为 `"uint32"` 时才派生，落到 v1 档（`seed: "unsupported"`）的镜头不派生、也不报警；同一批次内两种档可以共存。已写死 seed 的镜头不被覆盖，也不记退化。`shots[]` 直接给出的 draft 不派生——那里的 seed 由操作者写死。
- negative prompt：H3 契约无 negative 输入，H3 分支 `prompt.negativeText` 非 null 时返回 `negative_prompt_unsupported`（error）；Seedance 折叠进 prompt 文本并记 `negative-prompt-folded`；Veo 有原生 `negativePrompt` 字段。
- prompt 语言：后端 `limits.promptLanguages` 非 null 且不含 `draft.prompt.language` 时，若 `translations` 中存在受支持语言的译文则选用该译文作为 `prompt.text`，记 `prompt-translated`（`from: 原语言, to: 译文语言`，`requiresReapproval: true`）并写入 `selectedTranslation`；否则返回 `prompt_language_unsupported`。`dialogue[]` 中 `lipSync: true` 且 `language` 不在 `promptLanguages` 内时返回 `dialogue_language_unsupported`（含中文口型对白的镜头不路由到 Veo）。本版 draft 的 `prompt.language` 与 `dialogue[].language` 固定 `zh-CN` 且 `translations` 为空数组，因此 Veo 分支恒返回 `prompt_language_unsupported`（§8.5）。
- provider 文本指令：`prompt.text` 与 `negativeText` 命中 `(^|[\s，。；：、！？（）()])--[A-Za-z][A-Za-z_-]*` 时返回 `prompt_contains_provider_directive`（error，所有后端一律拒绝）。判据按形态而非词表：Ark 的 `--rs/--rt/--dur/--fps/--seed/--cf/--wm/--frames` 会随 provider 版本增删，任意 `--flag` 一律拒绝，参数只走请求体（长写形式与紧邻中文标点的写法同样命中）。
- 参考序号：prompt 中 `@(?:图片|图像|图|视频|音频)\s*\d+|(?:图片|图像|视频|音频)\s*\d+|图\d+` 的序号超过对应类别的参考数量时返回 `reference_index_out_of_range`。裸「图」只在带 `@` 前缀或数字紧邻（无空白）时算序号引用，避免「画面构图 2 层」误报。
- 长度提示：Seedance 分支对超过 500 中文字 / 1000 英文词的 prompt 返回 warning `prompt_length_over_recommendation`（provider 建议值）。
- `ValidationReport.issues[{code, field, severity, message}]`，错误码共 25 个（`SHOT_VALIDATION_CODES`，末两个为 warning 级）：`unsupported_operation | unsupported_continuity_mode | last_frame_without_first | keyframe_not_approved | reference_cap_exceeded | audio_only_reference_unsupported | duration_out_of_range | aspect_ratio_unsupported | resolution_unsupported | image_too_large | image_mime_unsupported | real_face_unauthorized | license_blocked | license_obligation_unmet | processing_region_not_allowed | prop_state_missing | prompt_language_unsupported | dialogue_language_unsupported | prompt_contains_provider_directive | reference_index_out_of_range | seed_rejected | output_intent_mismatch | negative_prompt_unsupported | native_audio_unverified(warning) | prompt_length_over_recommendation(warning)`。含 error 级 issue 的镜头不进入 ShotBatchPlan。

资产 URI：stage kernel 的 allowlist 要求 `scheme + authority` 命中 `assetPolicies`，`urn:` 无 authority 直接 fail（`hub/src/production-stage-gateway.ts`；`production-domain.ts` 只在 intent 层放行 `urn:`）。因此进入 intent `inputs[]` 的 AssetRef 一律使用 `cas://<cas-authority>/sha256/<digest>`（`cas:` 属 `STABLE_URI_SCHEMES`）：ShotRequest 由 `plan-shots --confirm` 写入 workspace CAS（`.writing-loop/<project>/production-cas.v1/sha256/<digest>`，`hub/src/production-cas.ts`），`<cas-authority>` 为 gateway registry 中配置的逻辑名（如 `wl-sg`），gateway 以 `ProductionStageAssetResolver` 把该 authority 解析为本地 CAS 目录；ingest 产出的 `urn:sha256:<digest>` AssetRef（`hub/src/production-gateway.ts`）在进入下一镜输入前由编译器改写为同 sha256 的 `cas://<cas-authority>/sha256/<digest>`（§6.4）。

### 4.2 intent execution 扩展（`hub/src/production-intent.ts`）

```ts
export const PRODUCTION_INTENT_OPERATIONS = ["comfyui-workflow","minimax-h3","ark-video-task","vertex-veo-lro"] as const;
export const PRODUCTION_MODEL_FAMILIES = ["generic","minimax-h3","seedance","veo"] as const;
export const SEEDANCE_MODEL_IDS = ["doubao-seedance-2-0-260128","doubao-seedance-2-0-fast-260128","doubao-seedance-2-0-mini-260615","doubao-seedance-2-5-260628",
  "dreamina-seedance-2-0-260128","dreamina-seedance-2-0-fast-260128","dreamina-seedance-2-0-mini-260615","dreamina-seedance-2-5-260628"] as const;
export const VEO_MODEL_IDS = ["veo-3.1-generate-001","veo-3.1-fast-generate-001","veo-3.1-lite-generate-001"] as const;

// 以下全部字段为 execution profile 的静态值；不含任何逐镜字段（修正 F1）
export type ProductionIntentExecution =
  | /* generic、minimax-h3 分支不变 */
  | ProductionExecutionBase & { operation: "ark-video-task"; modelFamily: "seedance";
      provider: "volcengine-ark" | "byteplus-modelark"; modelId: SeedanceModelId;
      resolution: "480p"|"720p"|"1080p"|"4k"; aspectRatio: "16:9"|"1:1"|"9:16"|"21:9";   // 画幅枚举以 ShotRequest 为准；4:3 / 3:4 / adaptive 不在 v1 支持
      generateAudio: boolean; watermark: false; returnLastFrame: true; executionExpiresAfterSeconds: number }   // [3600, 259200]，按批次规模配置（§7）
  | ProductionExecutionBase & { operation: "vertex-veo-lro"; modelFamily: "veo";
      modelId: VeoModelId; location: "us-central1"; resolution: "720p"|"1080p"|"4k"; aspectRatio: "16:9"|"9:16";
      generateAudio: boolean; sampleCount: 1; ioMode: "inline-base64" | "gcs" };
  // Veo 不含 enhancePrompt（Veo 3.x 不可关闭 prompt rewriter）与 personGeneration（v1 不下发，接受值未核实）
```

digest 语义：

| 字段 | H3-over-Comfy（现有） | Seedance / Veo |
|---|---|---|
| `workflowSha256` | pinned graph 文件 digest | execution profile 正本（`ShotExecutionProfile`，`kind: "writing-loop/execution-profile"`）中的同名字段；profile 正本由 gateway 的 server-owned registry 持有，worker 侧只引用 `profileId` 与该 digest |
| `modelSha256` | 四组件 bundle digest | `sha256(canonicalJson({provider, modelId, location}))` |
| `parametersSha256` | 参数投影 digest | `sha256(canonicalJson(profile.fixedParameters))`，与 execution 中的静态字段一一对应 |

execution profile 与价目的归属（`hub/src/production-gateway-runtime-config.ts`）：profile 正本 `ShotExecutionProfile`（`hub/src/production-shot-request.ts` 的 `parseShotExecutionProfile`）只有静态身份与固定参数——`profileId`、`backendInstanceId`、三个 digest、`resolution`、`aspectRatio`、`generateAudio`，加家族分支字段（H3 为 `variant`、`shortEdge: 768`、`durationSeconds`）。价目、许可、处理地域与 pinned graph 路径由包住它的 registry 条目 `ProductionGatewayExecutionProfileConfig` 持有（`workflowFile`、`stageProfileId`、`h3GraphContract`、`priceTable`、`license`、`processingRegions`、`intentExecution`），全部只存放在 gateway 的 server-owned registry（§8.2）；worker 侧 runtime config 只引用 `profileId` 与 `workflowSha256`，不持有正本。

`exportExecutionProfileSnapshot` 导出一份只读快照（`--export-profile-snapshot`，按 profileId 索引），每条含 `profileDigest`、`execution` 正本、`durationGrid`、`limits`、`priceTable`、`license`、`processingRegions`。`durationGrid` 与 `limits` 不在 registry 里配置，而是导出时推导：`limits` 由 `h3LimitsByProfileId`（`hub/src/production-adapter.ts`）给出——与 `capabilities` 路由同一份推导，因此 `durationGrid` 与 `limits.durationSeconds.grid` 恒等，不等即拒绝导出。快照恒含 `limits`；worker 侧解析器（`hub/src/production-profile-snapshot.ts`）把它读为可选字段，只为兼容更早版本导出的快照，`limits` 存在与否都计入 `profileDigest` 的复算。快照路径由 worker runtime config 的 `executionProfileSnapshotFile` 声明（相对 runtime config 文件，解析规则同 `workflows[].file`）。`plan-shots` 的估算读取该快照（零网络），并校验每条被选中条目的 `execution.workflowSha256` 落在本项目 `workflows[].workflowSha256` 的集合内，不在即拒绝出计划（`hub/src/production-shot-plan.ts` 的 `authorizedWorkflowSha256`）。快照与 registry 是同一份 profile 内容，价目不存在第二处。

worker 侧另有一项与快照配套的配置：`localAssetSource: {version: 1, kind: "workspace-cas", casAuthority}`（`stagingProfiles` 非空时必填）。它声明本机 workspace CAS 是 `cas://` 输入正本的持有方，`casAuthority` 必须与 gateway registry 和快照的同名字段相等；worker 用它在 staging 前上传缺失输入，并在契约 v2 提交前复核逐镜 prompt / seed（§6.4）。

逐镜变量（mode、durationSeconds、seed、输入 slot）全部由 `inputs[0]` 的 ShotRequest 决定：stage kernel 严格解析该文档并按 profile 的 `inputs` / `slotPolicy` 逐位定 slot，再由 `assertStagedContinuityMatchesShotRequest` 交叉核对——`inputs[i≥1]` 的 sha256 与 slot 基名必须与 `continuity.firstFrame / lastFrame / references[]` 同序同项，数量或顺序不符即拒绝；H3 家族另外核对 ShotRequest 的 `output.aspectRatio` / `durationSeconds` / 推导出的 variant / `generateAudio` 与不可变 execution 一致（`validateStagedShotRequest`，`hub/src/production-stage-gateway.ts`）。因此 `workflowBindingKey` 的五项（backendInstanceId、workflowSha256、modelFamily、modelSha256、parametersSha256）保持静态，staging profile 的 `execution` 可作为完整静态 execution 参与交叉校验，coordinator 的三项比对与 `parseWorkflowDescriptor` 零改动，只需把 `MODEL_FAMILIES`（`hub/src/production-coordinator.ts`）扩到四个值。

`parseProductionIntentExecution` 新增两分支的约束：

- seedance：fast / mini 只允许 480p / 720p；4k 只允许 `*-seedance-2-0-260128`；`executionExpiresAfterSeconds ∈ [3600, 259200]`；`provider` 与 modelId 前缀必须一致（`doubao-` ↔ `volcengine-ark`，`dreamina-` ↔ `byteplus-modelark`），交叉组合在解析层拒绝。
- veo：`location` 只接受 `us-central1`；`veo-3.1-lite-generate-001` 时 `resolution ∈ {720p, 1080p}`，`profile.allowedModes` 不得含 ref2v；`veo-3.1-fast-generate-001` 时 `resolution ∈ {720p, 1080p}`，4k 标 unverified，探针前拒绝；`veo-3.1-generate-001` 允许 720p / 1080p / 4k。
- 逐镜约束在编译与 gateway 两处执行：seedance `durationSeconds` 按 modelId 分档（2.0 系列 4–15，2.5 为 4–30）；2.5 在 i2v / fl2v 模式要求 `aspectRatio: adaptive`，该取值不在 v1 画幅集合内，因此 2.5 的 i2v / fl2v 组合不在 v1 路径内（Phase 3 处理）；`seed` 非 null 时编译返回 `seed_rejected`（error）；veo ref2v 固定 8 s，`reference_image` ≤3（或 1 张 style）、`reference_video` / `reference_audio` 为 0；veo `seed` 为 uint32 但仅 best-effort，Veo 分支编译时总是记录 `seed-not-reproducible`（`requiresReapproval: false`）且 `fingerprint.seedReproducible = false`；veo `resolution ∈ {1080p, 4k}` ⇒ `durationSeconds = 8`（保守默认，来源为 Gemini API 文档与 `tools/video/veo_video.py`；Phase 3 探针写入 `profile.limits` 后可放宽）。

license evidence 扩展（`ProductionLicenseEvidence`）：新增可选 `obligations: { attribution: string | null; revenueThresholdUsd: number | null; noModelImprovement: boolean } | null`；H3 填 `{ attribution: "MiniMax H3", revenueThresholdUsd: 20_000_000, noModelImprovement: true }`（MiniMax H3 Community License IV.1、IV.2、V.3）。该字段是编译器与 gate 判定许可义务的唯一来源，execution profile 不复制；缺省与显式 `null` 都规范化为「不带该键」，因此不带义务的既有 intent 的 canonical JSON 与 `idempotencyKey` 逐字节不变。gate 见 §4.7。

### 4.3 Capability descriptor（`hub/src/production-adapter.ts` 扩展）

```ts
export type BackendKind = "comfyui" | "volcengine-ark" | "byteplus-modelark" | "vertex-veo";
export type VideoBackendLimits = {
  modes: readonly VideoMode[];
  durationSeconds: { min: number; max: number; grid: readonly number[] | null; gridByResolution: Readonly<Record<string, readonly number[]>> | null };
  aspectRatios: readonly string[]; resolutions: readonly string[];
  maxReferenceImages: number; maxReferenceVideos: number; maxReferenceAudios: number; maxStyleImages: number; maxReferenceAssetsTotal: number | null;
  audioOnlyReference: boolean;
  keyframesAndReferencesExclusive: true;
  seed: "unsupported" | "uint32" | "uint32-best-effort" | "int32";
  promptLanguages: readonly string[] | null;       // null = 无限制；Veo 为 ["en"]
  promptDirectiveSyntax: "ark-text-flags" | null;  // Seedance 文本弱校验传参（--rs/--rt/--dur/--seed/--cf/--wm/--frames）
  nativeAudio: { status: "supported" | "unsupported" | "unverified"; channels: "mono" | "stereo" | null;
                 verifiedBy: { modelId: string; probeRemoteJobId: string; providerJobId: string | null; at: string; hasAudio: boolean } | null };  // 禁止跨 modelId 复用
  returnsLastFrame: boolean; maxInputImageBytes: number; inputImageMediaTypes: readonly string[];
  realFaceReferences: "forbidden" | "allowed";
  outputRetention: { kind: "provider-url"; seconds: number } | { kind: "gcs-object" } | { kind: "inline-spool" } | { kind: "comfy-history"; bounded: true };
};
export type BackendCapabilities = {
  backendKind: BackendKind; backendInstanceId: string;
  modelFamilies: readonly ProductionModelFamily[];
  processingRegions: readonly string[];           // ISO-3166 alpha-2：cn-beijing→CN，ap-southeast-1→SG，us-central1→US
  asynchronous: true; clientAssignedJobId: true;  // 经 gateway 面向 coordinator 恒为 true
  providerJobIdMapping: "none" | "gateway-durable";
  inspectById: true; progressHints: "optional-websocket" | "poll-only" | "callback-optional";
  pendingCancellation: "best-effort" | "unsupported"; runningCancellation: "version-gated-best-effort" | "best-effort" | "unsupported";
  providerIdempotency: false;
  inputModes: readonly ("image-upload"|"cas-object-key"|"inline-base64"|"gcs-uri")[];
  outputModes: readonly ("download"|"provider-signed-url"|"gcs-object"|"inline-base64")[];
  limitsByModelId: Readonly<Record<string, VideoBackendLimits>>;   // 按 modelId 而非家族；H3 以 profileId 为键
};
```

能力描述的使用方式：编译器只读 `limitsByModelId[modelId]`（H3 以 profileId 为键）决定模式、时长网格、参考上限、语言、seed 与音频状态；`nativeAudio.verifiedBy` 必须绑定探针所用的 modelId，禁止跨 modelId 复用。编译器实际消费的是子集 `ShotCompileCapability{backendKind, backendInstanceId, modelFamilies, processingRegions, limitsByModelId}`（`hub/src/production-adapter.ts`）。H3 的 `limitsByModelId` 由 `h3LimitsByProfileId(profiles, maxInputImageBytes)` 逐 profileId 推导：`modes` 按 variant 给出（fl2va → `["i2v","fl2v"]`，ref2va → `["ref2v"]`），时长网格取同 `(variant, aspectRatio)` 下已配置的时长档升序去重，`seed` 按该档的 `h3GraphContract.version` 取 `"unsupported"`（v1）或 `"uint32"`（v2），`returnsLastFrame: false`，`nativeAudio` 为 `{status: "supported", channels: "stereo", verifiedBy: null}`，`maxInputImageBytes` 取 registry 的 `backends[].maxInputImageBytes`（自托管后端没有 provider 侧上限可引用，adapter 不猜数字）。跨线读取由 `parseVideoBackendLimits` / `parseBackendCapabilities`（`hub/src/production-provider-adapter.ts`）严格校验。coordinator 对 `submitted.remoteJobId === prepared.remoteJobId`、`providerIdempotency === false`、`nodeErrorCount` 为非负安全整数的断言（`hub/src/production-coordinator.ts`）不变：面向 coordinator 的始终是 `ProductionGatewayAdapter`，云 adapter 的 `nodeErrorCount` 固定回 0；provider 分配的 `task_id` / operation name 由 jobs kernel 的持久 job record 保存（`providerJobIdMapping: "gateway-durable"`）。

### 4.4 Provider adapter 协议（gateway 内部，新增 `hub/src/production-provider-adapter.ts`）

coordinator ↔ gateway 的 `ProductionAdapter`（`hub/src/production-adapter.ts`）与 PUT body（`hub/src/production-job-gateway.ts`）不变。现有 `PreparedSubmission.request` 类型固定为 `SubmitRequest`（字段 idempotencyKey / remoteJobId / workflow / inputBinding），`parsePreparedForProfile` 对 raw adapter 返回值强制 exactKeys、`inputBinding === null` 与 workflow digest 相等，无法承载云后端请求。因此 gateway 内部定义独立的 `PreparedProviderSubmission`，`ComfyUiAdapter` 包装保持原 `SubmitRequest` 形态：

```ts
export type ProviderJobRef = { remoteJobId: string; providerJobId: string | null };
export type BoundInput = { index: number; slot: "shot-request"|"first_frame"|"last_frame"|"reference_image"|"reference_video"|"reference_audio"; assetSha256: string; providerObjectKey: string };
export type ProviderSubmitRequest =
  | { kind: "comfy-workflow"; idempotencyKey: string; remoteJobId: string; workflow: Record<string, unknown>; inputBinding: ProductionSubmissionInputBinding | null }
  | { kind: "cloud-video"; idempotencyKey: string; remoteJobId: string; execution: CloudVideoExecution; shotRequest: ShotRequest; boundInputs: BoundInput[] };
export type PreparedProviderSubmission =
  | { kind: "comfy-workflow"; prepared: PreparedSubmission }                                   // 现有形态，parsePreparedForProfile 不变
  | { kind: "cloud-video"; version: 1; backendInstanceId: string; remoteJobId: string; idempotencyKey: string;
      requestDigest: string; executionProfileSha256: string; shotRequestSha256: string; boundInputs: BoundInput[];
      wire: { method: "POST"; url: string; headersDigest: string; body: Uint8Array } };      // requestDigest = sha256(body)
export type ProviderOutput = { outputIndex: number; role: "primary" | "last-frame"; kind: "video" | "image" };
export type ProviderSubmitResult = SubmitResult & { providerJobId: string | null };
export interface ProductionProviderAdapter {
  capabilities(signal?: AbortSignal): Promise<BackendCapabilities>;
  prepareSubmission(request: ProviderSubmitRequest): PreparedProviderSubmission;   // 零网络；requestDigest 按真实发送字节计算（同 ComfyUiAdapter）
  submitPrepared(prepared: PreparedProviderSubmission, signal?: AbortSignal): Promise<ProviderSubmitResult>;  // 恰好一次 POST
  inspect(ref: ProviderJobRef, signal?: AbortSignal): Promise<RemoteObservation>;
  cancel(ref: ProviderJobRef, signal?: AbortSignal): Promise<CancelResult>;
  // 可选成员：只有能产出 `source: "provider-output"` locator 的 adapter 才实现它。
  openOutput?(ref: ProviderJobRef, output: ProviderOutput, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; declaredLength: number | null }>;
}
```

协议要点：

- `parsePreparedForProfile` 按 profile 形态分支：workflow 形态沿用现有校验；execution-profile 形态校验 `executionProfileSha256 === profile.workflowSha256`、`shotRequestSha256 === boundInputs[0].assetSha256`、`requestDigest === sha256(wire.body)`。attempt 持久记录（`afterAttemptDurable` / `afterRawAttemptDurable`）与 `#resumeSubmission` 按同一判别联合读写；恢复路径重建 prepared 后比对 `requestDigest` 相等才允许复用「已 POST」判定。
- jobs kernel 顺序：持久化 job record（pending）→ provider POST → 持久化 `providerJobId` → 响应 coordinator。`JobRequestRecord` 增 `providerJobId`、`safetyIdentifier`、`deleteIssuedAt`。
- Ark adapter 的 `cancel`：先 `GET /tasks/{id}` 读取状态，仅当 `status == queued` 才发 `DELETE`；其余状态一律不调用 DELETE（DELETE 对 succeeded / failed / expired 任务的语义是删除记录并使其不可查询，会连同 `video_url` / `last_frame_url` / `usage` 一起丢失）。`running` 不可取消已由文档确认。Vertex adapter 的 `cancel` 固定返回 unsupported。
- Vertex adapter v1 采用 inline 模式（`ioMode: "inline-base64"`）：输入图以 `image.bytesBase64Encoded` / `lastFrame.bytesBase64Encoded` / `referenceImages[].image.bytesBase64Encoded` 发送（≤20 MB）；输出由 `fetchPredictOperation` 响应携带 base64 视频，adapter 在 `inspect` 观察到 done 且含视频时把解码字节写入 gateway 本地 spool（按 remoteJobId 命名，bounded，ingest 成功后删除；8 s 720p 约 10–15 MB，响应上限按此设定），`openOutput` 从 spool 读取。LRO 结果在 Vertex 侧的保留期未核实，spool 用于避免二次拉取。`ioMode: "gcs"`（`image.gcsUri` + `storageUri`）保留为可选形态，前提（bucket、IAM、区域）见 §9。
- `ComfyUiAdapter` 经薄包装实现该接口（`hub/src/production-provider-adapter.ts`）。该包装不实现 `openOutput`：H3 产物的 locator 是 `comfy-view`，由 ingest kernel 经 `comfyBaseUrl/view` 取回；`openOutput` 因此是接口的可选成员，只由能产出 `provider-output` locator 的云 adapter 实现。`openOutput` 返回流，签名 URL 与 OAuth token 只存在于一次传输的内存（AI-SPEC:175）。ingest kernel 复用 sha256 / 长度 / 魔数校验与 CAS 发布（`hub/src/production-gateway.ts`）。

### 4.5 task 状态机、observation、locator、errorSummary

`ProductionStatus`（14 状态、5 终态）、转移表、13 种事件类型、reducer 幂等规则（同 eventId 同 payload 幂等；revision / occurredAt 乱序硬错；终态不可追加）与持久化不变量（`submitting` 必须 pending outbox、`submission-unknown` 必须 unknown outbox、`qc-pending / approved / rejected` 至少 1 个 AssetRef、`approval.taskRevision = revision - 1`）全部不变（`hub/src/production-domain.ts`）。`RemoteJobState` 仍为 `pending | running | succeeded | failed | cancelled | not-found`。`RemoteOutputLocator` 改为判别联合：

```ts
export type RemoteOutputLocator =
  | { source: "comfy-view"; nodeId: string; kind: "image"|"video"|"audio"|"file"; filename: string; subfolder: string; folderType: "input"|"output"|"temp" }
  | { source: "provider-output"; remoteJobId: string; outputIndex: number; role: "primary"|"last-frame"; kind: "video"|"image" };
```

类型别名为 `ProductionOutputLocator`（`hub/src/production-adapter.ts`），`RemoteOutputLocator` 是它的同名导出；`comfy-view` 分支的 `source` 声明为可选（`source?: "comfy-view"`），`provider-output` 分支必填。读取兼容：`parseRemoteObservation`（`hub/src/production-reconcile.ts`）、`parseLocator` 与 `parseIngestRequest`（`hub/src/production-gateway.ts`、`production-ingestor.ts`、`production-job-gateway.ts` 各一份）、排序校验 `compareProductionOutputLocator`（`hub/src/production-ingestor.ts`，gateway 侧以 `compareLocator` 别名引用）、coordinator-domain 的 `parseOutput` 全部在缺少 `source` 时按 `comfy-view` 读取，exactKeys 按分支给出（`comfy-view` 为五字段、带 `source` 时六字段；`provider-output` 固定 `source / remoteJobId / outputIndex / role / kind` 五字段）；写入总带 `source`。`provider-output` 不含 URL，可落入 control ledger。本版只有 `comfy-view` 分支有执行路径，`provider-output` 随 Phase 3 / Phase 4 的云 adapter 启用。

`errorSummary` 词表由 `production-coordinator-domain.ts` 的 `ERROR_SUMMARY_ALTERNATIVES` 拼成 `PRODUCTION_ERROR_SUMMARY_PATTERN` 单一导出，`production-coordinator.ts` 以 `SAFE_BACKEND_ERROR` 直接引用同一个正则（不再两处各写一份）：

```text
^(?:execution_error(?::[A-Za-z_][A-Za-z0-9_.]{0,119})?|execution_interrupted
  |provider_failed(?::[A-Za-z0-9_.-]{1,64})?|provider_expired|content_filtered|quota_exceeded|invalid_input|output_expired)$
```

`provider_failed:preempted`（GPU VM 抢占，§7）与 `provider_failed:InvalidParameter.TaskTypeConstraint` 等 Ark 错误码均落在 `provider_failed:<code>` 形态内。

### 4.6 成本

`ProductionCost`（`hub/src/production-domain.ts`）扩展；`parseProductionCost` 的 exactKeys 允许缺省 `settlement`（旧记录按 null 读取）：

```ts
| { version: 1; state: "known"; currency: "USD"; amountMicros: number;
    basis: "reported" | "billed" | "estimated" | "tariff" | "reported-converted";
    settlement: null | { nativeCurrency: "CNY"; nativeAmountMicros: number; rateMicrosPerUnit: number; rateAsOf: string; rateSource: "gateway-registry" } }
```

| basis | 定义 |
|---|---|
| `reported` | BytePlus ModelArk 以 `usage.completion_tokens × 单价`（USD）。价目按 `{resolution, withVideoInput}` 二维存放，`withVideoInput` 由 `boundInputs` 是否含 `reference_video` 决定；2.0 / 2.5 含视频输入时存在最低 token 用量，查询接口的 `completion_tokens` 直接返回最低用量，估算器加入最低 token 用量表 |
| `reported-converted` | 火山方舟报告 token 用量但以 CNY 计费，USD 按 gateway registry 中带日期、带来源的汇率折算，原币金额与汇率写入 `settlement`。该汇率为操作者声明的配置项，满足「禁止离线猜测汇率」的约束意图 |
| `tariff` | provider 不报告实际费用时，按 profile 价目 × ffprobe 实测秒数。Veo 与配置了 GPU 费率的 H3 采用；未配置费率的 H3 保持 `unknown/provider-not-reported`。tariff 不覆盖 GPU VM 的开机、权重加载与空闲小时；本版不设项目级余量门，这部分只作为 plan 文档中的 GPU 小时估算附注（§4.7） |

`settleQcBudget` 对 `reported | billed | tariff | reported-converted` 释放 reservation（修正 F3）；`ProductionCostSummary`（`hub/src/production-read-model.ts`）分列 basis 小计。

### 4.7 审批与成本门

writing-loop 侧批次与样片：

| 层 | 机制 | 增量 |
|---|---|---|
| 批次人工审批 | `production plan-shots --plan` 输出 `ShotBatchPlan`；`--confirm <batchPlanId>` 才写入，内部对每个 intent 以其自身 planId 调用 `commitProductionTaskEnqueue`（`hub/src/production-enqueue.ts` 的确认指纹为单 intent planId），批次 planId 只用于批次审批 | `batchPlanId = sha256(canonicalJson({workspace, project, intents[], policyDigest, degradations[]}))`（公式不变）；plan 文档含 `createdAt`（取批次文档同名字段）、`selectedShotIds`（本次选中镜头，升序）、每镜估算（写明 modelId 与价目档）、总估算、后端选择理由 `decisions[]`、`phase: sample \| bulk`、`waves[]`（本版恒为一波，见下文承接链取证）、`droppedReferences`、`validation` 汇总、GPU 小时估算（不构成阻断条件）；`shots[]` 每条另带 `selected` 与 `selectionReason`，未选中镜头的 `planId` / `profileId` / `wave` 均为 null；策略变更即 batchPlanId 失效 |
| 样片门 | 对应 VCS「每类付费资产先出样本」（`skills/pipelines/cinematic/asset-director.md`） | `samplePolicy{sampleShotIds, requireApprovedSampleBeforeBulk: true}`，缺省取每个被选 **profile** 在批次顺序里的第一镜（`defaultSamplePolicy`）；`phase: bulk` 必须显式声明 `sampleShotIds`（要检查的是先前批次的样片，不能由本批次自证），`--confirm` 按 taskId 查本地权威账本检查 sample task 均为 `approved`。taskId 由 `<taskIdPrefix>-<shotId>` 拼出，因此 sample 批次与 bulk 批次必须使用同一个 `taskIdPrefix` |
| 估算 | `budget.estimatedAmountMicros` 由 profile 价目 × durationSeconds（Seedance 按 token 公式，含二维价目与最低 token 用量）得出；`maximumAmountMicros = ceil(estimated × SHOT_BATCH_MAXIMUM_MULTIPLIER)`，本版 multiplier 为 1.5 | `production plan-shots --plan\|--confirm --project KEY --input FILE --config RUNTIME [--from-script <集号> [--scene N]…] [--shot ID]… [--json]` 读取 `executionProfileSnapshotFile` 声明的只读 profile 快照（零网络），并复算每条 `profileDigest`、校验 `execution.workflowSha256` 落在本项目 `workflows[]` 内，价目单一来源（§4.2） |
| QC 裁决 | `production qc --approve \| --reject --project KEY --task ID --by WHO [--note TEXT] [--json]`（`hub/src/production.ts`），写 approved / rejected 事件，`approval.taskRevision = revision - 1`；`--reject` 必须给出 `--note` 原因，非 `qc-pending` 的 task 一律拒绝 | 0-E 已合并 |

`plan-shots` 的批次装配（`hub/src/production-shot-plan.ts`）：

- `policyDigest` 覆盖 `phase`、`anchorPreference`、`compiler`、`casAuthority`、`taskIdPrefix`、`backendInstanceId`、`arcId`、项目声明（`allowedProcessingRegions`、`licenseCompliance`、`usesOutputToImproveModels`）、编译真正用到的 capability、被选中 profile 的 `{profileId, profileDigest}`、`samplePolicy`、intent 脚手架（`createdAt`、`useTerritories`、`rights`、`moderation`、`license`）与视觉侧四张表（`approvedCandidates`、`propStates`、`mappings`、`candidatesByShotId`），另含本次选中的镜头集合 `selectedShotIds`。`profileDigest` 已覆盖 execution、时长网格、价目与许可，价目一改 `batchPlanId` 立刻失效；选中集合进入计算体后，同一份批次文档筛出不同镜头即为不同批次，`batchPlanId` 不同，批准不可互相顶替。
- 按镜头筛选：批次文档的可选键 `shotIds` 与命令行 `--shot <id>`（可重复）等价，两者都给出时取交集（`resolveShotSelection`）。筛选在预填、合并与视觉填充**之后**、编译**之前**生效：被筛掉的镜头不编译、不进 `intents[]`、不计估算、不进 `validation.shots`，只在 `shots[]` 以 `selected: false` 与 `selectionReason` 列出。两种情形拒绝出计划：交集为空、筛选指向不存在的镜头（合并会改变存活 shotId，静默少跑几镜比报错更难发现）。`--plan` 带 `--shot` 而 `--confirm` 不带时两次的选中集合不同，`batchPlanId` 随之不同，`--confirm` 因指纹不匹配被拒。
- `--from-script` 走剧本预填路径，输入的 `script{episodeFile, episode, sceneIndexes, options, patches, mergedPatches}` 有两处 patch：`patches` 在**合并前**补齐分镜字段（`camera` 必须在这一步落位，否则合并条件 3 恒不成立），`mergedPatches` 在**合并后**按存活 shotId 补齐 prompt 与连续性输入。两份 patch 都只允许替换 `camera`、`scene`、`cast`、`props`、`crowd`、`output`、`continuity`、`prompt` 八个成员，其中 `scene` 只接受 `lightingStateId` / `dressingVariantId`、`continuity` 只接受 `firstFrame` / `lastFrame` / `references` / `spatialPasses`；`sceneId`、时段、内外、`stageGroup`、`prevShotId` 是剧本与合并结果的事实，不接受改写。
- 视觉侧默认值（`applyVisualDefaults`）在最后一步只补空位，人工 patch 写死的值不覆盖。seed 派生紧随其后、在逐镜选定 execution profile **之后**、编译**之前**执行，因此取的是合并、`mergedPatches` 与视觉填充之后的 draft（§4.1）。`shots[]` 直接给出的 draft 不派生：派生只在 `--from-script` 路径打开（`deriveSeedWhenNull`）。
- 预填与合并的 warnings（首个动作行之前的对白、合并时被丢弃的字段）按 shotId 进入 `validation.shots[].issues`（`source: prefill | merge | visual | upstream | compile`）并计入 `validation.warnings`。前三者是装配期提示，`compile` 是 §4.1 的编译层错误码表，`upstream` 是计划期的上游取证（下一条），只有 `upstream-take-unavailable` 一个码（error 级；它属于 plan 层词表，不进 §4.1 的编译层 `ValidationReport`）。
- `previous-shot-last-frame` 的上游取证在计划期进行，读本项目的本地权威账本（`--plan` 仍为零写入）。承接只有一种成立方式，四条全部满足才放行：`origin.taskId` 已在本项目账本内；该 task 状态 ∈ {`qc-pending`, `approved`}（`dispatch-pending` / `running` / `failed` / `rejected` 的 take 没有可用尾帧）；该 task 的 subject 就是 `origin.shotId` 那一镜；该 take 唯一的 `image/*` 资产与本镜声明的尾帧 `sha256` / `byteLength` / `mediaType` 逐项相同。`uri` 不参与比对：同一份对象在账本里是 ingest 登记的 `urn:sha256:`，在批次文档里写成 `cas://`（§6.4）。任一条不满足即在该镜记一条 `upstream-take-unavailable`（error），整批随之 `blocked`，`--confirm` 拒绝提交。
- 批内不成链：ShotRequest 不可变且携带尾帧的 `asset.sha256`，上游尚未出片时该 digest 无从得知；即便猜对，`--confirm` 之后的精确重放也会看到上游停在 `dispatch-pending` 而判为不可用。因此批次内部没有顺序约束，`waves[]` 的形状保留给消费方但恒为一波。逐镜推进的走法：镜头 N 出片并 QC 之后，下一个批次用 `--shot` 选镜头 N+1，其 `continuity.firstFrame` 的 `origin.taskId` 填镜头 N 的 task id、`asset` 填镜头 N 的实际尾帧 AssetRef。
- `--plan` 严格零写入；含 error 级校验问题的批次一律拒绝提交（`--plan` 仍输出完整文档，退出码为 1）。

批次审批记录（`hub/src/production-batch-approval.ts`）：

- `--confirm` 逐镜提交时在 immutable intent 旁边写一份可读记录，路径 `.writing-loop/<project>/production-batch-approvals.v1/<taskId>.json`，exact keys `{version, kind, taskId, shotId, batchPlanId, taskIdPrefix, phase, sampleShotIds, approvedAt}`（`kind` 为 `writing-loop/shot-batch-approval`）。它是继 immutable intent、CAS 内 ShotRequest 之后账本外的第三份不可变伴生文件：账本事件的 payload 与 digest 一个字节都不改，已有 task 的事件重放结果不变。
- `approvedAt` 取批次文档的 `createdAt`——进入 `batchPlanId` 计算体的同一时刻。取 `--confirm` 的墙上时钟会让精确重放写出另一份字节，幂等性随之失效。
- 只在本次 `--confirm` 确实创建了 task 的那一镜上写。task 已在账本内（精确重放、样片批次的镜头又出现在 bulk 批次里、2b 之前发布的旧 task）时本次没有发布任何东西，一律不写也不改；否则一份只是路过的批次会把自己的 `batchPlanId` 绑到别人发布的 take 上。
- 写入纪律与 intent 相同：同目录临时文件 → fsync → `link(2)` 定名，崩溃至多留下临时文件。定名冲突的判据也相同：逐字段相同即认作精确重放并沿用既有文件；不同即拒绝覆盖，并报出文件路径与两边的 `batchPlanId`（那是一条残留的孤儿记录，由操作者核对后删除），不静默沿用。
- 崩溃窗口（task 已创建、记录尚未落盘）退化为该 take 只出 `qc-approved` 一条门，重跑 `--confirm` 也不补写（task 已在账本内）。取舍是宁可少一条门，也不发出可能绑错批次的门。
- 这份记录是 §4.8 `batch-approved` 与 `sample-approved` 两条门的唯一取证来源。

机器门与 gateway 准入：

- `evaluateProductionIntentGates`（`hub/src/production-intent.ts`）新增 `processing-region-not-allowed`、`provider-likeness-policy`、`license-obligation-unmet`；gate context 增加 `backendProcessingRegions`、`allowedProcessingRegions`、`licenseCompliance{ annualRevenueUsdBelow: number | null; attributionSurfaces: string[] }`（来自 runtime `projects[]`）与 `realFaceInputs: "undeclared" | "present" | "absent"`。四项在解析层允许缺省，缺省一律取「未声明」的 fail-closed 语义。
- `realFaceInputs` 汇总 ShotRequest 的 `containsRealFace`（intent 的 `inputs[]` 只有 AssetRef，不携带该标记）：Seedance 2.x 拒绝真人人脸参考，非 `absent`（含缺省的 `undeclared`）即 `provider-likeness-policy` deny。
- `processing-region-not-allowed` 的三条判定：`allowedProcessingRegions` 为空/缺省时四个家族一律 deny（`FAMILIES_REQUIRING_PROCESSING_REGIONS` 的四项自 0-E 起全为 true——runtime `projects[]` 已供给该字段，本地 ComfyUI 与云后端同判据）；`allowedProcessingRegions` 非空而 `backendProcessingRegions` 为空/缺省 → deny（无可比对项不等于合规）；后端任一地域不在允许集合内 → deny。两组地域只接受 ISO-3166 alpha-2 成员国代码，解析后去重升序（因此配置里的书写顺序不影响判定），集合别名 `EU`、非标准码 `UK` 与 `WORLDWIDE` 在解析层拒绝。
- `license-obligation-unmet` 在 license evidence 含 `obligations` 时判定：`revenueThresholdUsd` 非 null 且项目未声明年收入低于该阈值、又无完整 written-license evidence（`basis: written-license` 且 status verified、`licenseSha256`、`evidence`、`issuedBy`、`issuedAt` 齐全，与 H3 受限地域门同一判据）→ deny；`attribution` 非 null 且 `attributionSurfaces` 为空 → deny。该判定是一个纯函数 `licenseObligationViolations(license, compliance, { explicitWrittenLicense })`，编译器与 gate 都调用它，两侧对同一输入结论必然一致；编译器提前拒绝只为减少无效计划，writing-loop 侧仍二次强制。
- `obligations.noModelImprovement` 是编译期专属条款，gate 不判定：输出是否被用于改进其他模型是产物的后续使用方式，dispatch 前拿不到可取证的事实，只能按项目声明的 `usesOutputToImproveModels` 在编译期检查（§4.1、AI-SPEC 使用约束）。
- `SubmissionAdmissionPolicy.acquire/settle`（`hub/src/production-job-gateway.ts`）按 backend 配置并发上限（§3），只加配置。
- reservation 语义不变：估算是计划事实，reservation 以 maximum 为准。

证据登记（`hub/src/production-evidence.ts`）。rights / moderation / license 三种 evidence 在 intent gate 上都要求一个稳定的 AssetRef，该命令把证据文件写入 workspace CAS 并输出可直接粘进批次文档对应段落的对象片段：

```
production evidence register --project KEY --kind rights|license --file PATH --config RUNTIME [--json]
production evidence register --project KEY --kind moderation --file PATH --config RUNTIME --status STATUS --reviewed-at <规范 UTC ISO> [--json]
```

- 写入 `.writing-loop/<project>/production-cas.v1/sha256/<digest>`，内容寻址，重复登记同一份文件是幂等的（`casObjectCreated: false`）。输出片段按 kind：`rights` 给 `{evidence}`，`moderation` 给 `{status, reviewedAt, evidence}`，`license` 给 `{licenseSha256, evidence}`。片段只填这份文件能取证的部分，rights 的地域与有效期、license 的签发方与义务由操作者在批次文档里补齐。
- `mediaType` 按内容判定，不看扩展名：`%PDF-` 魔数 → `application/pdf`；可往返的 UTF-8 且去空白后以 `{` / `[` 开头并能 JSON 解析 → `application/json`；其余可往返的 UTF-8 且除制表 / 换行 / 回车外无控制字符 → `text/plain`。以 `{` / `[` 开头却解析失败的回落到文本判据（带 BOM 的 JSON、以 `[Exhibit A]` 开头的许可证正文都是这一形态）。三者都判不出即拒绝登记，不退化为 `application/octet-stream`：AssetRef 的 `mediaType` 随 intent 固化进不可变证据。
- 单份证据上限 4 MiB（`MAX_PRODUCTION_EVIDENCE_BYTES`），比 CAS 的文档上限 1 MiB 宽：证据 AssetRef 不进 intent `inputs[]`、也不经 handoff 导出，不受 stage 与导出侧的文档判据约束。空文件、非单链接普通文件、读取期间被替换的文件一律拒绝。
- `--kind moderation` 必须显式给出 `--status`（词表与 intent 侧 `parseModeration` 同源，导出为 `PRODUCTION_MODERATION_STATUSES`：`passed` / `not-reviewed` / `failed`）与 `--reviewed-at`（规范 UTC ISO），缺一即拒绝；其余两个 kind 不接受这两个参数。审核结论与审核时刻是文件之外的人工事实，命令不代填。
- `--config` 必填，CAS authority 取 runtime config 的 `localAssetSource.casAuthority`，不另设 `--authority`：猜错的 authority 会让 worker 的本机对象源以 authority-mismatch 失败。authority 判据由 `production-domain.ts` 导出的 `PRODUCTION_CAS_AUTHORITY`（`/^[a-z0-9][a-z0-9-]{0,62}$/`）单点持有，runtime config、profile 快照、本机对象源、ShotRequest 装配与证据登记五处共用。

审批点总表：

| 序 | 审批点 | 责任人 | 落地位置 | 输入 |
|---|---|---|---|---|
| 1 | 候选图批准（并行轨道，不阻塞） | 视觉负责人 | `writing-loop visual approve-candidate --project KEY --candidate ID --by WHO [--reject] [--json]`（0-E 已合并，`hub/src/visual.ts`），原子改写 `visual/production.v1.json` 并由人工 git 提交 | Blender 约束图 → 候选图 |
| 2 | 批次审批 `plan-shots --confirm` | 制片负责人 | 本机 workspace（`~/dramas`，§8.0 决策 10） | plan 文档：degradations、费用与 GPU 小时估算、后端理由 |
| 3 | 样片门 | 同上 | `phase: bulk` 的 `--confirm` 检查 sample 均 approved | sample take |
| 4 | QC 裁决 `production qc` | QC 负责人 | 本机 workspace | take、尾帧、上游状态 |
| 5 | VCS proposal（渲染运行时） | 合成负责人 | 本机 VCS 检查点 | proposal_packet |
| 6 | publish | 发布负责人 | 本机 VCS，含署名检查 | publish_log |

`visual approve-candidate` 的两条阶段约束（`reviewVisualCandidate`，`hub/src/visual-production.ts`）：只有 `keyframe-review` 阶段的场景可以裁决；已裁决的候选图不接受第二次改判，改判须人工把该候选图的 `status` 改回 `candidate` 并把 `reviewedBy` / `reviewedAt` 清为 `null`。该命令不渲染、不连接 ComfyUI、不 enqueue 任何任务。

机器执行环节：`production-worker --config <FILE> --once` 在本机运行（批次期间手动或 launchd 定时，间隔 ≤ 6 h，credentialEnv 由本机环境注入）。writing-loop-sg 上的 systemd timer 保留为可选部署方式（§8.0）。

项目级预算门。已核实事实：GCP 项目 jinko-vibe-coding 存在 €50/月硬顶（预算 `vibe-coding-50eur-hard-cap`，阈值 0.5 / 0.9 / 1.0，Pub/Sub → Cloud Function `budget-cutoff` 执行 `stop_billing`，恢复需手动 `gcloud billing projects link`）；G4 目录价（新加坡）g4-standard-48 按需约 4.09 USD/h、Spot 约 1.55 USD/h。该硬顶只作用于现金支出，项目持有的 credit 不受其约束（决策 3）。

因此本版不设项目级月度余量门：

1. `projects[].availableBudgetMicros` 取足够大的常量，本版不作为门，也不需要人工维护（不设 `maintainedBy` / `asOf`）。
2. GPU VM 的启停不设独立审批点，gate context 不含 `vmWindow`，worker 不按时间窗过滤 H3 intent。
3. per-intent 的 reservation 机制原样保留：`budget.estimatedAmountMicros` 与 `maximumAmountMicros` 照常写入，intent gate 的预算两项照常判定，`settleQcBudget` 照常释放。
4. plan 文档仍附 GPU 小时估算（按 Spot 1.55 USD/h × 批次预计运行小时），作为批次规模的参考，不构成阻断条件。
5. `stop_billing` 一旦触发仍会停止全部 VM，恢复流程见 §7。

### 4.8 VCS 侧：scripted-drama 流水线与 GateRecord

新建 `pipeline_defs/scripted-drama.yaml`，stages 顺序 `proposal → scene_plan → assets → edit → compose → publish`（阶段名均在 `ALL_KNOWN_STAGES`；`get_next_stage` 按清单顺序返回首个未完成阶段），`reference_input.supported: false`（修正 F2：importer 不再代写 research / proposal / script 检查点）。

| 阶段 | produces | 门 | 由谁写 |
|---|---|---|---|
| proposal | proposal_packet（含 `production_plan.render_runtime`、`composition_mode`、`decision_log_ref`；`_run_final_review` 比对该字段） | `human_approval_default: true` | agent 展示 Remotion / HyperFrames / ffmpeg 与配音、配乐来源，人工批准 |
| scene_plan | scene_plan（每镜一个 `type: generated` 场景，`shot_language` 直接复制 ShotRequest.camera，`continuity{first_frame_asset_id, last_frame_asset_id, reference_asset_ids[]}`，`shot_request_ref`） | true，importer 写 `completed, human_approved: true` | importer |
| assets | asset_manifest（`sha256 / role / provider_job_id / plan_sha256 / writing_loop_task_id / cost_usd / prompt / model`，`license` 填 handoff take 的许可摘要，如 `MiniMax H3 Community License; attribution required`） | 同上 | importer |
| edit / compose / publish | edit_decisions（importer 提供草稿，每镜一条 cut，按 `storyboardDurationSeconds` 裁切）/ render_report + final_review / publish_log | edit、compose 不设门，publish 人工；publish 前检查：asset_manifest 中任一 take 的 license 含署名义务时，publish_log 必须含 `attribution: ["MiniMax H3"]` 且成片或发布文案中出现该署名 | agent |

预授权记录：handoff 契约 v2 的每个 take 带 `gates[]`，三条门各有各自的取证来源，缺一即不出：

| gate | 取证来源 | `bindsTo.planSha256` | `approvedBy` / `approvedAt` | `system` |
|---|---|---|---|---|
| `qc-approved` | 账本的 QC 裁决（`approval.decidedBy` / `decidedAt`） | 不可变 intent 重算出的单 intent 确认指纹（即 `--confirm` 逐镜提交时用的那一个） | QC 裁决人与裁决时刻 | `wl-qc` |
| `batch-approved` | 批次审批记录（§4.7） | 该记录的 `batchPlanId` | `wl-plan-shots` / 批次文档的 `createdAt` | `wl-plan-shots` |
| `sample-approved` | 批次审批记录，且 `shotId ∈ sampleShotIds` | 该记录的 `batchPlanId` | 该样片自己的 QC 裁决人与裁决时刻 | `wl-sample-gate` |

三条门的 `bindsTo.requestSha256` 都是该镜 ShotRequest 的 digest。无批次审批记录的 task（2b 之前的 `--confirm` 发布）只出 `qc-approved`；不在 `sampleShotIds` 内的镜头不出 `sample-approved`；`sample-approved` 只对已 approved 的样片 take 出；记录的 `taskId` 或 `shotId` 与 take 对不上时整份交接失败。`batch-approved` 的 `approvedBy` 记的是签发这条门的控制面，不冒充人工审批人：本版 `--confirm` 只接受批次指纹，没有操作者身份输入；人工署名需后续为 `--confirm` 增加 `--by`。

VCS importer（`978c632`）把每个 take 的全部 GateRecord 按 take 顺序、take 内原顺序复制进 scene_plan 与 assets 检查点的 `metadata.gates[]`（各补 `handoffDigest`）。每种门每个 take 至多一条，`qc-approved` 必需；三条门都核对 `bindsTo.requestSha256` 等于该 take 的 `shotRequest.sha256`，并校验 `planSha256` 为 64 位小写 sha256、`approvedAt` 为规范 UTC ISO、`approvedBy` 与 `system` 非空。门的语义由 writing-loop 决定，importer 不解释。`asset_manifest` 与 `decision_log` 的 `plan_sha256` 取自 `qc-approved` 门（单 intent 计划摘要）。decision_log 另追加 `approval_policy` 与逐 take 的 `provider_selection`（写明供应商由 writing-loop 批次审批锁定）。Backlot `gate_skipped` 审计（`backlot/state.py`）据此可追溯。`CostTracker` 保持 observe，take 的 `cost` 写入 `cost_log.json`。

## 5. 后端映射

三家共用的固定项：`inputs[0]` 为 ShotRequest（H3 契约 v1 除外，见 §5.3）；`inputs[i≥1]` 顺序固定为 `[first_frame?, last_frame?, reference_image*, reference_video*, reference_audio*]`；所有后端一律拒绝 `prompt_contains_provider_directive`、`mode: extend`；`output.fps` 固定 24，三家均无对应请求字段。

### 5.1 Seedance（`ArkVideoAdapter`，operation `ark-video-task`）

实现顺序：Phase 3（BytePlus 账户就绪后）。本版只在类型层保留该分支的枚举、execution 解析与编译校验，不实现 adapter。

| 接口字段 | Ark 请求 / 响应字段 | 处理 |
|---|---|---|
| `execution.provider` | 主机 `ark.cn-beijing.volces.com`（volcengine-ark）/ `ark.ap-southeast.bytepluses.com`（byteplus-modelark），endpoint host 参数化 | 凭据 `{kind: "api-key-env"}`：`VOLCENGINE_ARK_API_KEY` / `BYTEPLUS_ARK_API_KEY`，Bearer |
| `execution.modelId` | `model` | `SEEDANCE_MODEL_IDS` 之一；BytePlus 用 `dreamina-` 前缀 |
| `prompt.text`、`prompt.negativeText` | `content[0]{type: "text", text}`；negative 以「避免出现：」折叠进同一文本 | 记 Degradation `negative-prompt-folded`；中文 >500 字 / 英文 >1000 词 → warning `prompt_length_over_recommendation` |
| `prompt.language` | 无字段 | `promptLanguages: null`（中英均可） |
| 模式 t2v | `content[]` 仅 text 项 | — |
| 模式 i2v：`continuity.firstFrame` | `content[]` 追加 `{type: "image_url", image_url: {url: <data URL>}, role: "first_frame"}` | 图 <30 MB、body <64 MB；超限 `image_too_large` |
| 模式 fl2v：`firstFrame` + `lastFrame` | role `first_frame` 与 `last_frame` 两项 | `lastFrame` 单独出现 → `last_frame_without_first` |
| 模式 ref2v：`continuity.references[]` | role `reference_image` / `reference_video` / `reference_audio`（`type` 对应 image_url / video_url / audio_url） | 按 purpose 顺序排列；上限 2.0：9 / 3 / 3，2.5：30 / 10 / 10（单次素材 ≤50）；2.0 仅音频 → `audio_only_reference_unsupported`；超限按 `referencePolicy` 处理；首尾帧与参考并存由编译器 `anchorMode` 决定 |
| `output.durationSeconds` | `duration` | 2.0 系列 [4,15]、2.5 [4,30]，整数网格上取整，记 `duration-rounded-trim` |
| `execution.aspectRatio` | `ratio` | 画幅枚举以 ShotRequest 为准（9:16 / 16:9 / 1:1 / 21:9），4:3 / 3:4 / adaptive 不在 v1 支持；2.5 在 i2v / fl2v 模式要求 `adaptive`，该组合因此不在 v1 路径内 |
| `execution.resolution` | `resolution` | fast / mini 仅 480p / 720p；4k 仅 `*-seedance-2-0-260128`；违反 → `resolution_unsupported` |
| `execution.generateAudio` | `generate_audio` | 单声道 |
| `execution.watermark: false` | `watermark: false` | 固定 |
| `execution.returnLastFrame: true` | `return_last_frame: true` → 响应 `content.last_frame_url` | ingest 登记为 `role: last-frame` 资产 |
| `execution.executionExpiresAfterSeconds` | `execution_expires_after` | [3600, 259200]，按批次规模配置 |
| `output.seed` | 不下发 | 2.x 未列入支持；`output.seed` 非 null 时编译返回 `seed_rejected`（error）；provider 对该参数忽略还是报错未核实 |
| `remoteJobId` | `safety_identifier`（remoteJobId 派生的 64 位十六进制串，查询时原样返回） | 用于 `list-window` 对账相关键；政策未确认前 `reconcilePolicy: none`；该用法随 Seedance 实现后置到 Phase 3 |
| provider 任务 ID | 创建响应 `id` | 持久化为 `JobRequestRecord.providerJobId` |
| 轮询 | `GET /api/v3/contents/generations/tasks/{id}`：queued → pending、running → running、succeeded、failed、cancelled、expired → failed:`provider_expired` | 429 / 5xx 最多 3 次，`Retry-After` 或指数退避上限 30 s |
| 主输出 | `content.video_url`（24 h 有效，2.5 下载 ≤100 次） | `openOutput` 流式下载；403 / 404 → `output_expired` |
| 成本 | `usage.completion_tokens` × `{resolution, withVideoInput}` 价目 | BytePlus → `reported`；火山 → `reported-converted`（汇率来自 gateway registry） |
| 取消 | `GET` 后仅 queued 时 `DELETE /tasks/{id}` | running 不可取消；终态禁止 DELETE |
| `containsRealFace` | 无字段 | 2.x 拒绝真人人脸参考 → gate `provider-likeness-policy` deny |
| 处理地域 | cn-beijing → CN；ap-southeast-1 → SG | 须在项目 `allowedProcessingRegions` 内 |
| 并发准入 | 企业 RPM 600 / 并发 10；个人 RPM 180 / 并发 3；2.0 4k 并发 1 | `SubmissionAdmissionPolicy` 配置 |

### 5.2 Veo 3.1（`VertexVeoAdapter`，operation `vertex-veo-lro`）

实现顺序：Phase 4（后续外语项目）。Veo 只接受英文 prompt，本版 prompt 固定 `zh-CN` 且 draft 不带译文，编译恒返回 `prompt_language_unsupported`；本版只在类型层保留该分支的枚举、execution 解析与编译校验，不实现 adapter。

| 接口字段 | Vertex 请求 / 响应字段 | 处理 |
|---|---|---|
| `execution.modelId`、`execution.location` | `POST https://us-central1-aiplatform.googleapis.com/v1/projects/{project}/locations/us-central1/publishers/google/models/{modelId}:predictLongRunning` | `location` 只接受 `us-central1`；凭据 `{kind: "google-service-account-file", pathEnv}`（veo-m2m.json 0600），gateway 换取短期 access token；`google-adc` 在 writing-loop-sg 不可用 |
| `prompt.text` | `instances[0].prompt` | `promptLanguages: ["en"]`：中文母本须选用 draft 译文（记 `prompt-translated`，重审批），无译文 → `prompt_language_unsupported`；本版 draft 不带译文，该分支恒返回该错误 |
| `prompt.negativeText` | `parameters.negativePrompt` | 原生字段 |
| `dialogue[]`（`lipSync: true` 且 `language` 非 en） | 无字段 | `dialogue_language_unsupported`，该镜头不路由 Veo |
| 模式 t2v | 仅 `prompt` | — |
| 模式 i2v：`firstFrame` | `instances[0].image{mimeType, bytesBase64Encoded}`（v1 inline；gcs 模式 `gcsUri`） | 仅 JPEG / PNG，≤20 MB；违反 → `image_mime_unsupported` / `image_too_large` |
| 模式 fl2v：`lastFrame` | `instances[0].lastFrame{…}`（须同时传 `image`） | 同上 |
| 模式 ref2v：`references[]` | `instances[0].referenceImages[]{image, referenceType: "asset" \| "style"}` | ≤3 张 asset 或 1 张 style（purpose `style` 单独成 style），固定 8 s；仅 generate-001 / fast；lite 的 `allowedModes` 不含 ref2v → `unsupported_continuity_mode` |
| `references[]` 视频 / 音频 | 无字段（上限 0） | 按 `referencePolicy`：strict → `reference_cap_exceeded`；trim → 裁剪并记 `references-trimmed`（视频 / 音频参考不设独立 Degradation code） |
| `output.durationSeconds` | `parameters.durationSeconds` | 网格 {4, 6, 8}；`resolution ∈ {1080p, 4k}` 时固定 8（保守默认） |
| `execution.aspectRatio` | `parameters.aspectRatio` | 16:9 / 9:16 |
| `execution.resolution` | `parameters.resolution` | generate-001：720p / 1080p / 4k；fast：720p / 1080p（4k 探针前拒绝）；lite：720p / 1080p |
| `execution.generateAudio` | `parameters.generateAudio` | generate-001 / fast 的 `nativeAudio.status = unverified` → warning `native_audio_unverified`，Phase 3 按 modelId 探针 |
| `execution.sampleCount: 1` | `parameters.sampleCount: 1` | 固定 |
| `output.seed` | `parameters.seed`（uint32） | best-effort；每个 Veo ShotRequest 记 `seed-not-reproducible`，`fingerprint.seedReproducible = false` |
| enhancePrompt、personGeneration | 不下发 | prompt rewriter 不可关闭；personGeneration 接受值未核实 |
| `execution.ioMode` | inline：响应内 `bytesBase64Encoded`；gcs：`parameters.storageUri` + `videos[].gcsUri` | v1 inline；gcs 前提（bucket、IAM、区域）未核实 |
| `remoteJobId` | 无字段 | provider 分配 operation `name` → `providerJobId`（gateway-durable） |
| 轮询 | `POST …/models/{modelId}:fetchPredictOperation {operationName}`：`done=false` → running；`error` → failed；`raiMediaFilteredCount > 0` 且无视频 → failed:`content_filtered` | 429 / RESOURCE_EXHAUSTED → `quota_exceeded`（提交阶段 → `remote-unavailable` 退避） |
| 主输出 | `response.videos[0].bytesBase64Encoded` → gateway spool（按 remoteJobId 命名，ingest 后删除） | `openOutput` 读 spool；8 s 720p 约 10–15 MB |
| 尾帧 | 无字段 | ingest kernel `ffmpeg -sseof -0.05 -i <video> -frames:v 1 -c:v png` 派生 `role: last-frame` 资产 |
| 成本 | 无 usage 字段 | `tariff`：profile 价目 × ffprobe 实测秒数 |
| 取消 | 未见 LRO 取消文档 | `pendingCancellation` / `runningCancellation` 均 unsupported，coordinator 跳过远端调用 |
| 处理地域 | us-central1 → US | 项目 `allowedProcessingRegions` 须含 US，否则 gate `processing-region-not-allowed` |
| 并发准入 | 50 请求 / 分钟；并发上限未核实 | 配置项 |

### 5.3 MiniMax H3（`ComfyUiAdapter` 包装，operation `comfyui-workflow` / modelFamily `minimax-h3`）

实现顺序：Phase 1，本版唯一的执行后端。下表的「契约 v2」项已随 Phase 1b 合并（`h3GraphContract.version` 取 1 或 2，两版并存；逐镜 prompt 与 seed 必须为 sentinel，否则每个镜头都需要独立的 pinned graph 与 config 条目）。sentinel 的两种形态：stage 输入为 `writing-loop://stage-input/<profileId>/<index>/<slot>`（`productionH3StageInputSentinel`），逐镜 ShotRequest 字段为 `writing-loop://shot-request/<profileId>/prompt|seed`（`productionH3ShotRequestSentinel`）；参数投影对模板 profileId 占位符计算，因此同一 profile 的每个镜头共用一份 `parametersSha256`，materialize 时从 stage 出的 ShotRequest 填入实际值并重新断言整图（`hub/src/production-h3-graph.ts`）。

| 接口字段 | ComfyUI 节点输入 / 端点 | 处理 |
|---|---|---|
| `execution.variant`、`aspectRatio`、`shortEdge: 768`、`durationSeconds` | generator class `MiniMaxH3ImageToVideo`（fl2va）/ `MiniMaxH3ReferenceToVideo`（ref2va）；`width / height` 由 aspectRatio 推导（16:9 → 1344×768，9:16 → 768×1344，1:1 → 768×768）；`length = max(5, round(seconds×24))` 向上对齐 `17k+5` | 全部为 pinned graph 参数投影；时长网格 = 已配置 `(variant, durationSeconds, aspectRatio)` profile 集合，每档需独立 `h3GraphContract` + workflow 文件 + `stagingProfile` 条目（`hub/src/production-h3-graph.ts`；`production-runtime-config.ts`） |
| 模式 t2v | 无（契约仅 fl2va / ref2va） | `unsupported_operation` |
| 模式 i2v / fl2v：`firstFrame` / `lastFrame` | `LoadImage.image` = `providerObjectKey`（模板 sentinel `writing-loop://stage-input/<profileId>/<index>/<slot>`，slot `first_frame` / `last_frame`） | stage kernel 硬链接到 `<root>/objects/<namespace>/<sha256>`，ComfyUI 与 gateway 同一文件系统 |
| 模式 ref2v：`references[]` 图片 | `ref_images.ref_image_N`（`reference.N` slot，N ≤ 9） | 按 purpose 顺序 |
| `references[]` 视频 / 音频 | 契约 v1 / v2 无对应绑定（上限 0） | 按 `referencePolicy` 处理 |
| `prompt.text` | 契约 v2（1b 已合并）：`generator.prompt` 为 sentinel `writing-loop://shot-request/<profileId>/prompt`，参数投影对 sentinel 模板计算，materialize 时从 ShotRequest 填入并重新断言整图。契约 v1 把 `generator.prompt` 放在参数投影内，逐镜 prompt 需要逐镜 graph 与 config 条目，不能承载批量镜头 | `prompt.negativeText`：契约无对应输入，编译器在 H3 分支要求其为 null，非 null 返回 `negative_prompt_unsupported`（error）；不把否定表述折进 prompt 文本，H3 对否定表述的响应未核实（§9.3） |
| `output.seed` | 契约 v2（1b 已合并）：sentinel `writing-loop://shot-request/<profileId>/seed`，逐镜 seed 从 ShotRequest 填入；`assertGraph` 断言该 sentinel 在整图中恰好出现一次 | 可复现，`fingerprint.seedReproducible = true`，capability `seed: "uint32"`；v1 档为 `seed: "unsupported"` |
| `execution.generateAudio` | 固定 pipeline：`VAEDecodeAudio.vae ← audioVae`，`CreateVideo.audio ← VAEDecodeAudio` | 始终生成立体声 32 kHz |
| `output.fps` | `CreateVideo.fps = 24` | 契约断言 |
| ShotRequest（`inputs[0]`） | 契约 v2（1b 已合并）：stage 契约在固定绑定前增加 index 0 的 `shot-request` slot（mediaType `application/vnd.writing-loop.shot-request+json`，`bindings[0]` 的 `source` 与 `consumer` 同为 `null`，gateway 从 receipt 的 staged object 读取），其后的 LoadImage 绑定 index 顺延一位，`ref_image_N` 仍按 LoadImage 位置编号（N = index − 1） | stage kernel 对该 mediaType 改为内容校验：严格解析为 ShotRequest、canonical 字节复算、输出意图与不可变 execution 一致，并把 `prompt.text` 与 `output.seed` 作为回执的 `shotRequest` 投影返回（`hub/src/production-stage-gateway.ts`）。slot 名与该 mediaType 一一对应，任一边单独出现即被拒 |
| `remoteJobId` | `POST /prompt` body `{prompt, client_id, prompt_id}`，`prompt_id` = 预分配 UUID | `providerJobIdMapping: "none"` |
| 轮询 | `GET /queue` + `GET /history/{id}`（`/api/jobs/{id}` 可选） | 现有 |
| 主输出 | `RemoteOutputLocator{source: "comfy-view", …}` → ingest 经 `comfyBaseUrl/view` | 本版 ingest kernel 与 ComfyUI 同机，`comfyBaseUrl` 为 loopback；SaveVideo 在 `/history` 中的分组名以实测写入测试 |
| 尾帧 | 无 | ingest kernel 的 `#deriveLastFrame` 用注入的 ffmpeg 提取器派生，同 Veo；失败即该次 ingest `derivation-failed` |
| 成本 | 无 usage | `tariff`（配置 GPU 费率）或 `unknown/provider-not-reported`；VM 小时只作为 plan 文档的估算附注 |
| 取消 | `POST /queue {delete}` + 门控 `POST /interrupt` | 现有 |
| 许可 | 本版 `useTerritories` 与 `deploymentTerritories` 均为 `["SG"]`，不命中 EU / GB / KR / US，无需 written-license evidence；`obligations`（署名「MiniMax H3」、年收入阈值 2000 万 USD、输出不得用于改进其他模型）仍由 gate `license-obligation-unmet` 判定 | 现有 gate + 新 gate；项目侧以 `licenseCompliance` 声明年收入与署名面 |
| Spot 抢占 | gateway 进程启动时的抢占扫描（`recoverPreemptedJobs`，`hub/src/production-job-gateway.ts`）遍历 `jobStateRoot/jobs/` 下的持久 job record | 逐条判定，详见 §7 |

## 6. 连续性输入与叙事侧数据流

### 6.1 剧本 → ShotRequestDraft 的切分点与字段来源

切分点由 `hub/src/script-lint.ts` 的纯函数解析器定义：场景头正则捕获 集号 / 场序 / 地点整段（可含「·子景」）/ 时段 / 内外；动作行前缀 `^[▲△∆]`；对白 `^(角色)（情绪前缀）：台词`；调度单 `^人物[：:]`；集标记。`references/script-format.md` 规定「一行动作 = 一个镜头」，因此镜头切分点 = 场内每一条 ▲ 行，对白行归属其前最近的 ▲ 行。全季实测：60 集 131 场；内联标注【特写】255、【画面定格】98、【字幕】56、【音效】7、【特效】5。

| draft 字段 | 来源 | 填写方 |
|---|---|---|
| `shotId`、`provenance.scriptLine`、`action`、`productionTags`、`dialogue[].{speakerId, text, mode}`、`scene.{timeOfDay, interior, subscene}` | ▲ 行、对白前缀（`OS` / `VO`）、场景头捕获组 | `script-lint.ts` 预填（`shotRequestFromScript`） |
| `scene.sceneId` | 地点前缀匹配 `story/outline.v1.json` `scenes[]`（lint `L3-scene-registry`） | 预填 |
| `cast[].{characterId, name, appearanceStateId, voiceId, performNotes}` | 调度单或 `EP0NN.presence` fact（60 集中 33 集登记）+ `story/assets.v1.json` character `facts[visual / perform / voice]`（分期外观为散文，`appearanceStateId` 需人工对应） | 预填 + 人工 |
| `cast[].stage`、`props[].position`、`crowd` | 《玉京旧事》当前无来源；数据形与 `/Users/shuai/workspace/novel/独占蔷薇_场景/shots_ep123.json` 的 `chars / props` 一致 | 允许 null；进入 prompt 编译与 QC 清单 |
| `props[].stateId` | `visual/prop-states.v1.json`（由 `F_O0x_LIFECYCLE` 散文人工转成 `(episode, scene) → stateId` 表） | 人工；缺表 → `prop_state_missing` |
| `scene.lightingStateId`、`dressingVariantId` | `visual/mappings.v1.json`（日 / 夜 → `LIGHT_*`，arc → `DRESS_*`） | 人工维护 |
| `camera`（六字段 + `cameraId`） | 分镜步骤或人工；Phase 0 试点手填 | 人工 |
| `output.{aspectRatio, storyboardDurationSeconds, generateAudio, seed}` | 分镜表（`shots_ep123.json` 镜头 `dur` 为 2–6 s）；项目输出档 9:16；分辨率不在 draft 内 | 分镜 / 人工 |
| `dialogue[].language`、`lipSync` | 本版固定 `zh-CN`（决策 4）；`lipSync` 由 `mode` 推导 | 预填 |
| `prompt.{text, negativeText, language, authoredBy}`、`prompt.translations[]` | 写作侧 agent 步骤或人工；本版 `language` 固定 `zh-CN`、`translations[]` 恒为空数组、H3 分支 `negativeText` 必须为 null | 写作侧 |
| `continuity.{stageGroup, prevShotId, firstFrame, lastFrame, references, referencePolicy, spatialPasses}` | 分场 ID；同场上一镜；`visual/production.v1.json`（候选图、`subjectReferences[]`、render passes）；上一镜 ingest 产物 | 编译前由 plan-shots 装配 |

镜头合并规则（决策 5）。全季约 1910 个 ▲ 行、每集约 60 秒成片，逐行成镜的粒度过细，因此在 draft 装配阶段按 `stageGroup` 内合并。合并为 `plan-shots` 的确定性前置步骤，不调用 LLM。相邻两条 ▲ 行合并的判定条件全部满足才合并，逐对判定后可继续与下一行合并。判定由纯函数 `shotMergeBlocker(left, right, options)`（`hub/src/production-shot-request.ts`）按下表顺序执行，返回 `null` 表示可合并，否则返回第一条不满足的条件码（词表 `SHOT_MERGE_BLOCKERS`）：

| 序 | 条件码 | 条件 |
|---|---|---|
| 1 | `stage-group` | 同一 `continuity.stageGroup`（同一集、同一场、同一子景） |
| 2 | `not-adjacent` | 右行的 `provenance.scriptLine` 严格大于左行已并入的最大行号（`max(scriptLine, mergedScriptLines)`）。「中间没有其他 ▲ 行」由调用方按剧本顺序逐对传入连续镜头保证 |
| 3 | `camera` | `camera` 六字段与 `cameraId` 完全相同；任一侧 `camera` 为 null 即不合并 |
| 4 | `scene-state` | 整个 `scene` 对象的 canonical JSON 相同（`sceneId`、`subscene`、`timeOfDay`、`interior`、`lightingStateId`、`dressingVariantId` 六项，不只是灯光与陈设） |
| 5 | `cast` | `cast[]` 长度相同，且每个 `characterId` 与其 `appearanceStateId` 一一对应相同（`stage` 站位、`performNotes` 等允许不同） |
| 6 | `freeze-frame` | 两行都不含强制切分标注 `FORCED_SPLIT_TAGS`：【画面定格】【插入闪回】【闪回结束】（前者是镜头结束定格，后两者是闪回进出点，必须落在镜头边界上） |
| 7 | `lip-sync-speakers` | 合并后 `dialogue[]` 中 `lipSync: true` 的说话人不超过 1 个 |
| 8 | `duration-cap` | 合并后 `storyboardDurationSeconds` 之和不超过 `options.maxStoryboardDurationSeconds`（execution profile 集合的时长网格上界） |
| 9 | `continuity-inputs` | 右行的 `continuity.{firstFrame, lastFrame, references, spatialPasses}` 为空，或与左行完全相同（合并只保留首行的连续性输入，右行非空且不同即丢信息） |
| 10 | `shot-parameters` | 逐镜请求参数一致：`output.{seed, aspectRatio, generateAudio}` 相同，且两行 `prompt.text` 不是「都非 null 且整个 `prompt` 对象不同」（`prompt.text` 为 null 表示写作侧尚未撰写，不构成冲突） |

十条之后还有一道结构上限兜底 `structure-cap`：合并结果的 `action` 长度、`dialogue[]` 条数与 `productionTags` 并集必须仍在解析层上限（`MAX_SHOT_ACTION_LENGTH` / `MAX_SHOT_DIALOGUE_LINES` / `MAX_SHOT_PRODUCTION_TAGS`）内，否则不合并——超限会在末尾重解析时抛错。

合并结果：`shotId` 与 `provenance.scriptLine` 取首行的值；被并入行的行号写入 `provenance.mergedScriptLines`（无合并时为空数组）；`action` 按行序以换行拼接；`productionTags` 取并集；`props[]` 与 `cast[]` 取并集（同 id 冲突时取首行值并在 `validation` 记 warning）；`crowd` 一侧为空取另一侧、两侧不同取首行并记 warning；`dialogue[]` 按行序拼接；`storyboardDurationSeconds` 取和；`prompt` 取已撰写的一侧。被并入镜头的 `shotId` 在其余镜头的 `continuity.prevShotId` 上改写为吸收它的存活镜头，不留悬空引用。合并只改变 draft，编译规则与 ShotRequest 结构不变。

两处非「一行动作 = 一个镜头」的语料形态（预填按此处理，不改 `script-lint.ts` 既有判据）：场内首个 ▲ 之前出现的对白（`ep-018.md:18` 实测形）归入本场第一镜，并在预填返回值的 `warnings[]` 记行号与原文；整行生产标注（`ep-008.md:22` 的【闪回结束】形）记为紧随其后那一镜的 `productionTags`，并因此成为条件 6 的强制切分点。

### 6.2 关键帧来源

`firstFrame` / `lastFrame` 的 `origin.kind = approved-candidate` 时，编译器校验 `visual/production.v1.json` 中该候选图 `status: "approved"`、`reviewedBy / reviewedAt` 非空且 sha256 命中（`references/visual-production-schema.md`）。`VisualGenerationCandidate`（`hub/src/visual-production.ts`）增加可选 `shotIds: string[]`，解决候选图按机位 × 灯光 × 陈设登记与逐镜首帧的对应。v1 实际来源：当前 `production.v1.json` 仅 S01 passes-ready、`candidates` 为空、`imageWorkflowProfileId` 未定义，Blender 5.2.1 仅本机 GUI（addon 拒绝 `-b` 模式、socket 仅 localhost、不代为启动），且三家后端均为视频后端；因此 v1 关键帧来源为 `previous-shot-last-frame`、`previous-episode-end`、`operator-upload` 三种，`approved-candidate` 为并行人工轨道：按场景 × 机位 × 灯光排期（不按镜头），以「S01 候选图批准」单独验收，不阻塞任何 Phase。批准动作由 Phase 0 新增的 `visual approve-candidate --candidate <id> --by <who>` 写入。

### 6.3 定妆参考、灯光 / 陈设 / 道具状态

- `visual/production.v1.json` 新增顶层 `subjectReferences[]`，每项 exactKeys 为 `{id, subject, asset: AssetRef, containsRealFace, approvedBy, approvedAt}`；`subject` 是判别联合 `{kind: "character", characterId, appearanceStateId}` 或 `{kind: "prop", objectId, stateId}`；ShotRequest 的 `references[].subjectId` 引用这里的 `id`。`approvedBy` 与 `approvedAt` 同生同灭，两者都为 `null` 表示尚未批准。旧清单缺该键时按空数组解析，既有文件不因 schema 增长失效。`story/assets.v1.json` schema 不改（禁止路径 / URL）。
- 候选图（`candidates[]`）新增两个可选键：`shotIds: string[]`（该候选图可作首帧的镜头，一个 shotId 只能被一张候选图占用，跨场景亦然；缺该键按空数组解析）与 `containsRealFace`（缺该键解析为 `true`，与 gate 的 `undeclared` 同一 fail-closed 语义）。`plan-shots` 按 `shotIds` 自动填首帧时把 `containsRealFace` 原样带进 ShotRequest。
- 新增 `visual/mappings.v1.json`（`kind: "writing-loop/visual-mappings"`，两张表 `lighting[]{sceneId, timeOfDay, lightingStateId}` 与 `dressing[]{sceneId, arcId, dressingVariantId}`，同一 `(sceneId, timeOfDay)` 或 `(sceneId, arcId)` 只能落一个状态）与 `visual/prop-states.v1.json`（`kind: "writing-loop/visual-prop-states"`，`objects[]{objectId, states[]{stateId, label, notes}, timeline[]{episode, sceneId, stateId}}`，`timeline` 只能引用同一道具已登记的 `stateId`，同一 `(episode, sceneId)` 不得出现两条）。三份文件的相对路径常量在 `hub/src/visual-production.ts`：`VISUAL_PRODUCTION_RELATIVE_PATH` / `VISUAL_MAPPINGS_RELATIVE_PATH` / `VISUAL_PROP_STATES_RELATIVE_PATH`。编译器不解析散文。

### 6.4 承接链

`carryFrom`（origin `previous-shot-last-frame`）指向上一镜 task 已 ingest 的 `role: last-frame` 资产，来源任务状态 ∈ {qc-pending, approved}（修正 F10：不要求 approved，避免批量退化为逐镜串行）。这一条件与尾帧身份在 `plan-shots` 的计划期取证（§4.7）：读本项目的本地权威账本（只读，`--plan` 仍为零写入），核对 `origin.taskId` 已在账本内、状态落在上述两个值上、该 task 的 subject 就是 `origin.shotId` 那一镜、该 take 唯一的 `image/*` 资产与本镜声明的尾帧 `sha256` / `byteLength` / `mediaType` 逐项相同（`uri` 不比对：账本里是 ingest 登记的 `urn:sha256:`，批次文档里写成 `cas://`）。任一条不满足即记 `upstream-take-unavailable`（error），整批随之 `blocked`，`--confirm` 拒绝提交。因此承接只成立于已入库并到达 QC 的上游 take，批内不成链，`waves[]` 恒为一波；逐镜推进的走法是镜头 N 出片并 QC 之后，下一个批次用 `--shot` 选镜头 N+1，`origin.taskId` 与 `carryFrom` 的 AssetRef 都填镜头 N 的实际值。来源任务被 rejected 后，依赖它的未提交 intent 需要重新出一版批次（`plan-shots --plan` 重新装配，`batchPlanId` 随之改变；本版没有独立的 `--refresh` 子选项），已提交的在 QC 摘要标注「上游被拒」。Seedance 由 `return_last_frame` 直接产出尾帧；Veo 与 H3 由 ingest kernel 执行 `ffmpeg -sseof -0.05 -i <video> -frames:v 1 -c:v png` 产出第二个 `urn:sha256` AssetRef，metadata 记录 `derivedFrom: {sha256, tool: "ffmpeg", version}`。再登记步骤：ingest 产出的 AssetRef 为 `urn:sha256:<digest>`，stage kernel 不接受无 authority 的 URI；编译器把 carryFrom 资产改写为 `cas://<cas-authority>/sha256/<digest>`（sha256 不变，ingest 已把对象写入同一 CAS 目录），gateway registry 为该 authority 配置 `ProductionStageAssetResolver` 与 `assetPolicies` 条目。本版 gateway 为单实例，H3 输出与下一镜 staging 共用 GPU VM 持久盘上的同一 CAS 目录，不涉及跨实例取回。

正本在本机的输入（`inputs[0]` 的 ShotRequest、操作者上传的首帧、已批准候选图）由 worker 送到 GPU VM，不经手工复制：gateway 的 `assets` 资源同一个 URL 支持 `GET|HEAD|PUT`（bearer 与其余路由相同），`PUT` 的请求体是原始字节、服务端重算 sha256 必须等于路径中的 digest（否则 400 且不落盘），同字节重放为幂等 200、同名不同字节为 409；媒体类型由字节嗅探判定，图片按 registry 的 `maxInputImageBytes` 限长，嗅探不出类型时按 ShotRequest 内容校验（与 stage kernel 同一判据）、上限 1 MiB，视频 / 音频等 provider 产物只经 ingest kernel 入库。worker 侧 `HttpProductionInputStager` 在 PUT `/stages` 之前对每个 `cas://` 输入先 `HEAD`，404 才上传；上传目标取 `stagingProfiles[].baseUrl`（不是顶层 `gateway.baseUrl`）——对象必须落到解析 `cas://` 的那台主机上。上传失败即该次 stage 失败（fail-closed，不进入提交），错误码见 §7。对象源为 runtime config 的 `localAssetSource: {version: 1, kind: "workspace-cas", casAuthority}`（`hub/src/production-local-asset-source.ts` 的 `WorkspaceCasLocalAssetSource`），只接受与该 authority 相同的 `cas://` URI，读回时逐项核对 digest 与 `byteLength`。本机 workspace CAS 的路径为 `.writing-loop/<project>/production-cas.v1/sha256/<digest>`（`hub/src/production-cas.ts` 的 `productionCasObjectPath`，目录常量 `PRODUCTION_CAS_DIRECTORY` / `PRODUCTION_CAS_ALGORITHM_DIRECTORY`），单个对象上限 `MAX_PRODUCTION_CAS_OBJECT_BYTES` = 64 MiB，ShotRequest 这类文档上限 `MAX_PRODUCTION_CAS_DOCUMENT_BYTES` = 1 MiB。路径由装配层按 workspace root 与 project 推出，不写进配置文件。同一个对象源也是契约 v2 逐镜 prompt / seed 的独立复核来源（§5.3）：worker 提交前从本机正本重新读出两值，与 stage 回执的 `shotRequest` 投影逐字比对，不一致即 `workflow-invalid`。Phase 3 / Phase 4 增开第二个 gateway 实例（云 adapter 与云输出 ingest，可直接跑在本机 loopback）后，跨实例 resolver 经对端的 `assets` GET 路由取对象并核对 sha256。

### 6.5 输入顺序与 stage profile

输入顺序固定为 `[shot-request, first_frame?, last_frame?, reference_image*, reference_video*, reference_audio*]`。stage profile 有两种形态，二选一（`hub/src/production-stage-gateway.ts` 的 `ProductionStageProfile`）：H3 沿用固定 `inputs[{version, index, slot, mediaTypes}]`（graph 逐 profile 钉死节点集合），云家族改用 `slotPolicy[{version, slot, minCount, maxCount, mediaTypes}]`。H3 profile 在契约 v1 保持固定绑定（不含 ShotRequest），契约 v2 在固定绑定前增加 index 0 的 `shot-request` slot。

`slotPolicy` 的计数区间由 `resolveSlotPolicyInputs` 单趟前向分配：一个输入停留在当前条目直到该条目的媒体类型不再接受它或已达 `maxCount`，游标只有在当前条目已满足 `minCount` 后才前移，末尾再逐条复查 `minCount`。`first_frame` 与 `last_frame` 同为图片，靠 `maxCount: 1` 先填满前一条来区分；`reference_image` 到 `reference_video` / `reference_audio` 的交界靠媒体类型区分；首尾帧与参考混用这一种两条规则都判不出的组合，在 profile 解析期即被拒（`keyframesAndReferencesExclusive`，§4.3）。`maxCount > 1` 的可重复 slot 产出**带序号的 slot 实例** `<slot>.<ordinal>`（ordinal 从 0 起），因此一份回执可以承载多张参考图；`maxCount === 1` 的 slot 保持原名。计数区间让同一档 profile 承载 i2v（无尾帧）与 fl2v（有尾帧），不必逐镜建档。

`stageKey`（`hub/src/production-input-stager.ts`）已含 execution 与全部 inputs，连续性输入自动进入幂等键。

### 6.6 参考用途与序号

参考用途只决定 role 与顺序（Ark `reference_image` 按 purpose 排序；Veo `style` 单独成 `referenceType: style`）；prompt 中引用参考序号时，编译器按 `@(?:图片|图像|图|视频|音频)\s*\d+|(?:图片|图像|视频|音频)\s*\d+|图\d+` 识别（官方写法为「图片N / 视频N / 音频N」与「@图片1」；裸「图」只在带 `@` 前缀或数字紧邻时算引用，避免「画面构图 2 层」误报），校验序号不超过对应类别的参考数量，越界返回 `reference_index_out_of_range`。`trim_by_priority` 裁剪掉的参考若在 draft 原序中排在某个保留项之前，保留项序号会前移：此时 prompt 只要出现序号引用即返回 `reference_index_out_of_range`（error），`references-trimmed` 一律 `requiresReapproval: true`。

## 7. 错误与恢复语义

- 提交：三家均恰好一次 POST；coordinator 先落盘 `submission-started` 再 `submitPrepared`。jobs kernel 顺序：持久化 job record（pending）→ provider POST → 持久化 `providerJobId` → 响应 coordinator。POST 结果不明（超时、5xx 无 body、响应不可解析）→ `submission-unknown`，不再 POST。
- `submission-unknown` 对账：`providerJobId` 已落盘时按 ID 对账；未落盘时按后端 `reconcilePolicy: "list-window" | "none"`。Ark 列表接口 `GET /api/v3/contents/generations/tasks` 只支持 filter.status / service_tier / task_ids / model、分页 [1,500]、最近 7 天、无 created_at 区间筛选，items 含 created_at、model、safety_identifier；因此 `list-window` 以创建时传入的 `safety_identifier`（≤64 字符英文串，查询时原样返回）作为相关键：值为 remoteJobId 派生的 64 位十六进制串，对账时按 status=queued / running 分页列出并匹配。该用法是否符合平台使用政策未核实，未确认前 Ark 的 reconcilePolicy 为 `none`；该项随 Seedance 实现后置到 Phase 3（决策 7）。Vertex operations 列表是否覆盖 `predictLongRunning` 未核实，Vertex 为 `none`。`none` 时经 `MAX_COORDINATOR_RETRY_ATTEMPTS` 内固定窗口后转 `orphaned`，reservation 保持 `exposed`。
- `execution_expires_after`：从 created_at 起算，超时任务被标记 expired，取值 [3600, 259200]。作为 profile 配置项 `executionExpiresAfterSeconds`，按批次规模 / 并发上限 / 单任务时长估算（例如 2.0 4k 并发 1 的 wave 不能用 3600）；孤儿风险由对账与相关键处理，不依赖最小过期时间。
- 终态映射：

| provider 状态 | observation.state | errorSummary |
|---|---|---|
| Ark `failed`，error.code 属审核类 | failed | `content_filtered` |
| Ark `failed`，error.code 属限流 / 并发 | failed | `quota_exceeded` |
| Ark `failed`，`InvalidParameter.*`（含 2.5 排队后才返回的 `InvalidParameter.TaskTypeConstraint` / `TaskTypeMismatch`） | failed | `invalid_input` |
| Ark `failed` 其他 / `expired` / `cancelled` | failed / failed / cancelled | `provider_failed:<code>` / `provider_expired` / — |
| Vertex `done` 且 videos 空、`raiMediaFilteredCount > 0` | failed | `content_filtered` |
| Vertex error 429 / 其他 | failed | `quota_exceeded` / `provider_failed:<code>` |
| Ark 查询返回 NotFound 类错误（任务 ID 仅保存 7 天；或记录已被 DELETE；HTTP 状态码由 Phase 1 fixture 实测）/ Vertex operation 不存在 | not-found | 交 `decideProductionObservation`（`hub/src/production-reconcile.ts`）；对账日志区分「已删除」与「已过期」两种来源（jobs kernel 记录是否曾对该 ID 发过 DELETE） |
| GPU VM 抢占：gateway 启动扫描判定为不可解释缺失的 job record（判据见下） | failed | `provider_failed:preempted` |

Ark error.code 到类别的具体映射表在 Phase 1 由录制 fixture 填充。2.5 的参数错误可能在排队后才出现，reservation 在此期间保持 exposed。

- 限流：Ark 429、Vertex 429 / RESOURCE_EXHAUSTED 在提交阶段 → `remote-unavailable`，走 coordinator 指数退避（`PRODUCTION_COORDINATOR_RETRY_*`）；轮询 GET 在 429 / 5xx 时最多 3 次尝试，延迟取 `Retry-After` 或指数退避上限 30 s（对齐 `tools/video/seedance_volcengine.py`）。
- 输出过期：Ark `video_url` 24 h。inspect 到 `succeeded` 后在同一 worker 轮次内 ingest；`openOutput` 返回 403 / 404 → observation 改写为 `failed: output_expired`，cost 仍按 usage 记 `reported`。运维要求 worker 调度间隔 ≤ 6 h。
- 内容过滤：终态 failed，不重试同一 intent；修改 prompt 产生新的 ShotRequest sha256 与 idempotencyKey。
- 取消：Ark 先 GET 后仅 queued 时 DELETE（§4.4）；Veo unsupported，coordinator 跳过远端调用；现有 `cancel-unconfirmed` issue 与 `CANCELLATION_RECOVERY_TARGETS`（`hub/src/production-domain.ts`）覆盖竞态，测试加入「DELETE 前状态已变为 succeeded」用例（预期不发 DELETE，任务按 succeeded ingest）。
- 输入上传（§6.4 `assets` 路由）：digest 与请求体不符 → 400 且不落盘；同字节重放 → 200（响应逐字节相同）；同名不同字节 → 409（内容寻址下不可能由该路由产生，仍拒绝覆盖）；超出图片上限或 ShotRequest 的 1 MiB 上限 → 413；嗅探为视频 / 音频、或既嗅探不出又不是 ShotRequest 正本 → 415。worker 侧（`#publishLocalInputs`，`hub/src/production-input-stager.ts`）：本机对象源取不到该对象 → `local-asset-unavailable`；gateway 4xx → `gateway-rejected`、5xx 与网络失败（含超时）→ `gateway-unavailable`。三者一律使该次 stage 失败，intent 不进入提交路径，重试即重放同一次上传。
- 尾帧派生（§6.4）：ingest kernel 的 `#deriveLastFrame`（`hub/src/production-gateway.ts`）在配置了提取器时对每个 take 都欠一帧尾帧，因此主视频不唯一（0 个或多个）、资产数超上限、提取器抛错或返回空字节都以 `derivation-failed` 使该次 ingest 失败，而不是登记一条缺连续性尾帧的 take；派生出的帧超过单资产上限则为 `asset-too-large`。provider 自带 `role: "last-frame"` 的产物直接入库，不再派生。
- 凭据不可用：装配期 fail-closed（`hub/src/production-runtime-config.ts`）；Vertex token 刷新失败在 POST 前抛 `remote-unavailable`。
- billing 解除恢复：`stop_billing` 触发后全部 VM 停止，进行中的 H3 任务随 ComfyUI 进程内 history 丢失（AI-SPEC:421-423）。恢复顺序：`gcloud billing projects link` → 重启 GPU VM（gateway 与 ComfyUI 随 systemd 单元启动，持久盘上的 job record 与 CAS 对象保留）→ gateway 启动时的抢占扫描按上文三前置改写受影响 job record → worker 对 `submission-unknown` / `orphaned` 对账 → 受影响 intent 重新 plan。
- GPU VM 抢占（Spot）：job record 与 CAS `objects` 目录都在 VM 的持久化启动盘上；抢占后手动重启 VM，处理同上一条最后两步。抢占不丢失已入库的资产与账本记录，只丢失 ComfyUI 进程内 history 中未完成的任务。
- 抢占扫描（`recoverPreemptedJobs` / `#recoverOneJobUnderDeadline`，`hub/src/production-job-gateway.ts`）在 gateway 进程启动时执行一次，遍历 `jobStateRoot/jobs/` 下的持久 job record。四类记录直接跳过：已有 `preempted.json`、已有 `terminal.json`、`outcome.json` 的 outcome 为 `not-submitted`、以及没有 `raw-attempt.json`（POST 尚未发出，提交路径仍归 coordinator，改写会污染在跑的重试）。其余记录逐条 `inspect`：观察到终态即写 `terminal.json` 并跳过；观察结果非 `not-found` 也跳过；只有 `not-found` 才 durable 写入一条 `preempted.json`（含 `requestDigest`、`remoteJobId`、`recordedAt`、`errorSummary: provider_failed:preempted` 与响应 digest），之后该任务的 `GET /jobs/{id}` 直接按该判定回答 `failed`，不再询问 provider。因此进入改写的三个前置是：有 raw attempt claim、无终态记录、provider 说 `not-found`。单个任务 inspect 失败或超过自己的截止时间只计 `unresolved`，留待下一次重启判定，不中断整轮扫描。
- `terminal.json` 是同一套记录的另一半：任何观察路径（`GET /jobs/{id}`、PUT 的提交响应、cancel 取证）看到 `succeeded / failed / cancelled` 时先 durable 写入它（首个写入者胜出），之后的读取直接按它回答。它把「provider 忘了一个在跑的任务」与「任务早已结束、history 只是被裁掉了」区分开，也是抢占扫描的第二条跳过判据。

## 8. 分阶段落地计划

### 8.0 部署拓扑（全部 Phase 的前提）

拓扑裁定（操作者 2026-09-02，决策 10）：writing-loop 的控制面运行在操作者本机，远程服务器 writing-loop-sg 不是必需的。本机不在 GCP 的 VPC 内，与 GPU VM 之间用 IAP 的 ssh 隧道把 gateway 端口映射到本机的 127.0.0.1；gateway 只绑定 VM 上的 127.0.0.1。该做法不需要改代码：worker 侧 `transport: "insecure-private-http"` 本来就接受「127.0.0.1 字面地址 + 非空 credentialEnv」的 http URL（§8.1，已合并的 0-A / 1a）。

约束来源：worker 侧 `production-gateway` backend 缺省必须为 HTTPS 且 `credentialEnv` 非空；`gateway`（ingest）与 `stagingProfiles[]` 缺省只接受「credentialed HTTPS」或「无凭据 literal-loopback HTTP」；显式 `transport: "insecure-private-http"` 时接受 http + RFC1918 私网 IPv4 或 127.0.0.1 字面地址 + 非空 credentialEnv（`hub/src/production-runtime-config.ts` 的 `trustedServiceUrl`，装配层三客户端同规则）。gateway 进程以 `node:http` 监听，`listen.host` 只接受字面私网 IPv4 或 127.0.0.1（`production-gateway-runtime-config.ts`），不含 TLS。minimax-h3 workflow 必须 scoped-staging；stage kernel 把资产硬链接到 `<objectsRoot>/objects/<namespace>/<sha256>` 并把 providerObjectKey 写入 `LoadImage.image`，ComfyUI 必须能读该目录，因此 gateway 与 ComfyUI 同机。

传输方式（决策 2 + 决策 10）：worker 与 gateway 之间不使用 TLS。隧道两端都是 loopback：本机侧 `http://127.0.0.1:8790`，VM 侧 gateway 绑定 `127.0.0.1:8790`；ssh 隧道本身经 IAP 加密。`transport` 字段的校验规则不变：

| 项 | 规则 |
|---|---|
| protocol | 只接受 `http:`；`https:` 与其他 scheme 拒绝 |
| host | 只接受字面 IP，且落在 RFC1918 私网 IPv4（10/8、172.16/12、192.168/16）或 127.0.0.1；域名、公网 IP、通配地址一律拒绝 |
| `credentialEnv` | 必须非空，静态 bearer；本机由 shell 环境或 launchd 的 EnvironmentVariables 注入；`kind: "comfyui"` 的 direct-dev backend 不接受该 transport |
| 其余 | URL 不得含 credential、query、fragment；path 仍按固定安全 segment 序列校验 |

威胁模型与适用条件（写入 `references/config-schema.md`）：

- gateway 只绑定 VM 的 127.0.0.1，VM 没有外网 IP，VPC 内也不暴露 gateway 端口；唯一入口是经 IAP 认证的 ssh 隧道（防火墙只需放行 IAP 网段 35.235.240.0/20 的 22 端口）；
- GPU VM 按批次启停，非批次期间不存在监听端口；
- bearer 与请求体只在隧道两端的 loopback 上明文出现；
- 该选项不适用于把 gateway 直接暴露到 VPC 或公网的部署；若 gateway 改绑 VPC 内网 IP，须重新评估。

拓扑表：

| 主机 | 组件 | 说明 |
|---|---|---|
| 本机（macOS） | writing-loop workspace `~/dramas`（ProductionStore：intent、task、事件）、CLI（`plan-shots` / `qc` / `handoff` / `visual approve-candidate`）、`production-worker --once`（批次期间手动或 launchd 定时运行）、Blender 候选图轨道、VCS（scripted-drama 流水线） | 账本只在本机写入；handoff 导出目录即本机路径，不需要 rsync。批次期间保持 `gcp-h3-vm.sh tunnel`（转发 8790 gateway 与 8188 ComfyUI）；`credentialEnv` 由本机环境注入；runtime config 文件权限 0400/0600 |
| GPU VM（Spot g4-standard-48，镜像 `wl-comfy-h3-g4-sg`，asia-southeast1，按批次启停，无外网 IP） | ComfyUI、gateway 单实例（jobs / stages / ingests 三个 kernel，H3 profile；`listen.host: 127.0.0.1`）、CAS `objects` 目录与 ComfyUI 同一文件系统 | 持久化启动盘：job record、CAS `objects` 与 ingest 产物在 Spot 抢占或停机后保留；gateway 安装包由本机 `npm pack` 后经隧道 scp 到 VM 安装，VM 不需要出网（不需要 Cloud NAT 或外网 IP）；`handoff --export-dir` 经 gateway 的 `assets` GET 路由取回资产，因此导出时 VM 必须在运行 |
| writing-loop-sg（可选） | 剧本创作阶段的调度器与 Studio；不参与视频生产 | 剧本已完本，服务器上的项目已暂停；如需继续在服务器上写剧本，剧本仓库以 git 同步回本机后再出片。worker 的 systemd 单元模板保留为可选部署方式 |

worker runtime config：`backends[]`、`gateway`（ingest）与 `stagingProfiles[]` 的 baseUrl 全部为 `http://127.0.0.1:8790`，`transport: "insecure-private-http"`；`localAssetSource` 为 `{version: 1, kind: "workspace-cas", casAuthority: "wl-sg"}`，其 `casAuthority` 必须与 gateway registry 及 profile 快照的同名字段相等；`executionProfileSnapshotFile` 指向由 `--export-profile-snapshot` 导出、再经隧道取回本机的只读快照。gateway 侧 `comfyBaseUrl` 为 `http://127.0.0.1:8188`。接入 Seedance（Phase 3）与 Veo（Phase 4）时，云 adapter 与云输出 ingest 的 gateway 实例可以直接运行在本机（loopback，不需要隧道），届时的跨实例 CAS 取回按 §6.4 处理。

### 8.1 Phase 0：契约与编译器（零网络）

落地状态：已分五片合并（0-A `1b58ee6`、0-B、0-C `b9aad32`、0-D `5ce7116`、0-E `356f1fe`），逐片进度见同目录 `EXECUTION-PLAN.md`。实际改动文件与下表的计划清单有出入，以 §8.6 的改动文件总表为准。

| 项 | 内容 |
|---|---|
| 改动文件 | 新增 `hub/src/production-shot-request.ts`、`hub/src/production-provider-adapter.ts`；修改 `hub/src/production-intent.ts`、`production-adapter.ts`、`production-domain.ts`、`production-coordinator.ts`、`production-coordinator-domain.ts`、`production-reconcile.ts`、`production-ingestor.ts`、`production-read-model.ts`、`production-runtime-config.ts`、`production.ts`、`cli.ts`、`visual-production.ts`；`docs/design/phase-3-remote-production/AI-SPEC.md`；`references/config-schema.md`、`references/visual-production-schema.md`；`hub/test/production-*.ts` |
| 交付物 | ShotRequest 类型、解析、`deriveVideoMode`、`compileShotRequest`、`shotRequestFromScript`、镜头合并（§6.1）；intent 新枚举与三个 execution 分支（H3 为实现路径；seedance / veo 只到类型、解析与编译校验层，adapter 后置）；三个 gate 与 license `obligations`；capability 与 locator 联合类型；`ProductionProviderAdapter` 接口、`PreparedProviderSubmission` 与 `ComfyUiAdapter` 包装；cost 扩展；runtime config 的 `transport: "insecure-private-http"` 选项与 `executionProfileSnapshotFile`；`production plan-shots`、`production qc`、`visual approve-candidate` 子命令；`visual/production.v1.json` 的 `shotIds`、`subjectReferences[]` 与 `mappings.v1.json`、`prop-states.v1.json` schema；AI-SPEC fixture 更新与「H3 输出不得用于改进其他模型」使用约束 |
| 验收标准 | 现有 `hub/test/production-*.ts` 全部通过；旧 H3 intent JSON 解析结果与 idempotencyKey 不变；validate 矩阵测试（每家后端 × 每个错误码至少 1 例，含 `prompt_contains_provider_directive`、`prompt_language_unsupported`、`dialogue_language_unsupported`、`reference_index_out_of_range`、`license_obligation_unmet`、`output_intent_mismatch`、`negative_prompt_unsupported`）；H3 分支拒绝 t2v、拒绝非空 `negativeText`、拒绝不在已配置 profile 集合内的时长档；seedance 分支拒绝 `seed ≠ null`（error 级 `seed_rejected`）、fast + 1080p、2.0 仅音频参考、`adaptive` 画幅，首尾帧与参考混用时按 `anchorPreference` 选侧并记 `anchor-mode-selected`（`requiresReapproval: true`）；veo 分支拒绝 6 s ref2v、lite + ref2v、lite + 4k、fast + 4k、1080p + 4 s，并对 `zh-CN` prompt 返回 `prompt_language_unsupported`；veo 分支对每个 ShotRequest 记录 `seed-not-reproducible`；镜头合并的十条判定条件逐条有用例（可合并、机位不同不合并、强制切分标注不合并、口型说话人超过 1 不合并、时长超上界不合并、右行连续性输入不同不合并、prompt / seed 不同不合并），并有合并后 `prevShotId` 改写与乱序输入抛错各 1 例；`output.aspectRatio` / `generateAudio` 与 profile 不一致各 1 例被拒；同一 draft 编译产生字节相同的 ShotRequest 与 intent draft；`--plan` 零写入（目录快照前后一致）；runtime config 解析测试：`transport: "insecure-private-http"` 对 10.x / 127.0.0.1 + 非空 `credentialEnv` 通过，对公网 IP、域名、`https:`、空 `credentialEnv`、`kind: comfyui` 各拒绝 1 例，缺省 transport 仍要求 HTTPS；ep-001 场 1-1 的文本（作为测试 fixture 内联，剧本数据不入库）经 `script-lint.ts` 预填的 draft 在补齐 `camera` 与 `prompt.text` 后通过合并、解析与编译（H3 fl2va 模式，首帧为 `operator-upload`）；设 `WL_EP001_PATH` 时额外对整集文件做同一核对 |
| 前提条件（并行外部，负责人：项目操作者） | (a) 尾帧派生所需的 ffmpeg / ffprobe 在实际运行 gateway 的主机上可用（GPU VM，§9.3）；(b) S01 候选图批准轨道启动（§6.2，不阻塞任何 Phase） |

### 8.2 Phase 1：gateway 进程装配与部署（GPU VM 同机）

落地状态：代码侧已分三片合并（1a `75c0e9b`、1b `e2a084e`、1c `f1bf475`）。需要 GPU 会话才能取证的验收项（live `/prompt` 探针、权重 sha256 清单、真实任务、承接链、模拟抢占、SaveVideo 分组名）仍为待验收。

| 项 | 内容 |
|---|---|
| 改动文件（实际） | 新增 `hub/src/production-gateway-runtime-config.ts`、`production-gateway-main.ts`、`production-local-asset-source.ts`；修改 `production-job-gateway.ts`、`production-stage-gateway.ts`、`production-gateway.ts`、`production-gateway-router.ts`、`production-h3-graph.ts`、`production-shot-request.ts`、`production-shot-plan.ts`、`production-runtime-config.ts`、`production-input-stager.ts`、`production-ingestor.ts`、`production.ts`；`writing-loop-operator/`（gateway 与 worker 的 systemd 单元、`scripts/gcp-h3-vm.sh`：Spot 创建 / 启停 / 开机自动关机硬上限 / `tunnel` 同时转发 8790 与 8188）；测试 `hub/test/production-gateway-main.ts`（新增）与 `production-{h3-graph,stage-gateway,gateway,job-gateway,input-stager,runtime-config,shot-plan}.ts` 扩展。`handoff --export-dir` 与其导出脚本随 Phase 2 交付，不在本 Phase |
| 交付物（已合并） | server-owned registry `parseProductionGatewayRuntimeConfig`（顶层 exact keys `version / listen / auth / backends / executionProfiles / stageProfiles / casAuthority / objectsRoot / ingestRoot / jobStateRoot / admission / reconcilePolicy`；`backends[]` 只支持 `kind: "comfyui"` 且数组长度必须为 1，带 `maxInputImageBytes`）与只读快照导出 `exportExecutionProfileSnapshot`（`--export-profile-snapshot OUT`，恒含 `limits`，`durationGrid === limits.durationSeconds.grid` 不等即拒绝导出，§4.2）；gateway 进程装配 `production-gateway-main.ts`（三个 kernel 同进程，`listen.host` 只接受字面私网 IPv4 或 `127.0.0.1`，bearer `timingSafeEqual` 比较，无 TLS，优雅停机）；持久化启动盘上的 `jobStateRoot/jobs/` job record 与 CAS `objects` 目录；H3 graph 契约 v2（`h3GraphContract.version` 取 1 或 2 并存；`generator.prompt` 与 `RandomNoise.noise_seed` 改为 sentinel `writing-loop://shot-request/<profileId>/prompt\|seed`，`assertGraph` 断言每个 sentinel 恰好出现一次，materialize 时填入并重新断言整图）；stage 契约 v2（`inputs[0]` / `bindings[0]` 为 `shot-request` slot，`source` 与 `consumer` 同为 `null`，其后 LoadImage 绑定 index 顺延一位）；stage kernel 的 `slotPolicy` 计数区间与带序号 slot 实例、ShotRequest 内容校验（严格解析 + canonical 字节复算 + 输出意图比对 + 回执 `shotRequest` 投影）与 `cas://` resolver；jobs kernel 的 profile 双形态、`PreparedProviderSubmission` 判别联合与 `capabilities` 路由转发；ingest kernel 的可注入 ffmpeg 尾帧提取（装配期探针，失败即 `derivation-failed`）与 `assets` 路由的内容寻址上传（`GET` / `HEAD` / `PUT`，§6.4）；抢占恢复（`terminal.json` + 启动扫描 `recoverPreemptedJobs`，§7）；worker 侧按家族分派的 binding verifier、本机对象源 `localAssetSource`（`production-local-asset-source.ts`）、staging 前的自动上传与契约 v2 的 prompt / seed 独立复核；gateway 与 `production-worker` 的 systemd 单元模板、`gcp-h3-vm.sh`（含 `tunnel` 双端口转发与开机自动关机硬上限） |
| 待交付（Phase 2） | `handoff --export-dir` 与导出脚本 |
| 验收标准（已达成，零网络部分） | `assertGraph` 对 v1 模板的结果不变，v2 模板的 sentinel 唯一性与 materialize 后整图断言各有用例；worker 经 `insecure-private-http` 提交到 gateway，bearer 错误被拒、正确被受理各 1 例；公网 IP 与域名 baseUrl 在装配期被拒各 1 例；`listen.host` 对 `0.0.0.0`、公网 IP 与域名在监听前被拒；快照导出的 `durationGrid` 与 capability 网格不一致即失败；`assets` 路由的 400 / 409 / 413 / 415 与 worker 侧 `local-asset-unavailable` / `gateway-rejected` / `gateway-unavailable` 逐码有用例；抢占扫描的四类跳过与三前置改写逐条有用例 |
| 验收标准（待 GPU 会话取证） | H3 live `/prompt` 探针：在 `wl-comfy-h3-g4-sg` 上验证 cuda132 驱动 + int8_convrot + ComfyUI 0.31 的 MiniMaxH3 节点 schema 与 `assertGraph` 一致，结果写入 h3-comfy-deployment-status；从镜像导出四组件权重 sha256 清单写入 `h3GraphContract` 的 `artifactSha256`；一条 H3 fl2va 任务（9:16、短边 768、已配置时长档，首帧为 `operator-upload`）经 `plan-shots --plan → --confirm → production-worker --once → production qc --approve → production handoff` 全链路入库，产出主视频与 ffmpeg 尾帧两个 AssetRef，cost basis `tariff`，reservation 释放；SaveVideo 在 `/history` 中的分组名以实测写入 `outputLocators` 测试；第二条 fl2va 任务以第一条的尾帧作 `firstFrame`（承接链，经 `cas://` 再登记）入库；模拟 Spot 抢占（停止 VM）后重启，扫描把符合三前置的 job record 改写为 `provider_failed:preempted`，job record 与 CAS 对象在重启后仍可读，reservation 处理正确 |
| 前提条件 | Phase 0 验收通过；§8.0 的本机与 GPU VM、IAP ssh 隧道（防火墙只需放行 IAP 网段 35.235.240.0/20 的 22 端口）；Spot G4 配额（按需 RTX PRO 6000 配额为 0，无按需回退；Spot 配额 8）；从镜像导出四组件权重 sha256 清单写入 `h3GraphContract` 的 `artifactSha256`（清单存放位置未记录，§9.3）；首帧素材以 `operator-upload` 提供并写入本机 workspace CAS `.writing-loop/<project>/production-cas.v1/`（由 worker 经 `assets` 路由自动上传到 GPU VM，不需要手工复制；`approved-candidate` 轨道不阻塞本 Phase，§6.2）；`useTerritories` / `deploymentTerritories` 配置为 `["SG"]`，项目 `licenseCompliance` 声明年收入与署名面 |

### 8.3 Phase 2：VCS 导入与合成（EP001 场 1-1 端到端试点）

落地状态：writing-loop 侧已分两片合并（2a `0190d19` handoff 契约 v2 与 `--export-dir`；2b `ee65459` `plan-shots` 补强），VCS 侧 importer 已提交（`978c632`）。端到端试点待 GPU 会话。

| 项 | 内容 |
|---|---|
| 改动文件 | writing-loop：`hub/src/production.ts`（`handoff --export-dir`、`plan-shots --shot`、`evidence register`）、`production-studio-handoff.ts`（契约 v2 与三条门）、`production-shot-plan.ts`（按镜头筛选、上游取证、批次审批记录写入）、新增 `production-batch-approval.ts` 与 `production-evidence.ts`；VCS：新增 `pipeline_defs/scripted-drama.yaml`、`skills/pipelines/scripted-drama/{proposal-director,edit-director}.md`、`skills/video-creation-studio/scripts/import_handoff.py`、`tests/contracts/test_import_handoff.py`；修改 `skills/video-creation-studio/scripts/studio.py`（`import-handoff` 命令）、`skills/video-creation-studio/references/execution-contract.md`、`schemas/artifacts/scene_plan.schema.json`、`asset_manifest.schema.json`、`decision_log.schema.json`、publish 校验脚本、`backlot/state.py`、`docs/PROVIDERS.md` |
| 交付物 | `handoff --export-dir`（经 gateway `assets` GET 路由下载 `urn:sha256` 资产，文件名 `<sha256>.<ext>`）；handoff 契约 v2（takes 增加 `shotRequest: AssetRef`、`execution` 摘要、`cost`、`assetRoles[]`、`gates[]`、`license` 摘要）；`plan-shots` 补强（2b）：批次审批记录 `production-batch-approvals.v1/<taskId>.json` 与据此发出的 `batch-approved` / `sample-approved` 两条门、按镜头筛选（`--shot` 与批次文档 `shotIds`）、计划期上游取证（`upstream-take-unavailable`）、`production evidence register`、CAS authority 正则统一为 `PRODUCTION_CAS_AUTHORITY`；scripted-drama 清单；importer；scene_plan / asset_manifest / decision_log schema 增字段；proposal / edit director 技能 |
| 验收标准 | 导入后 `studio.py status` 报告 `next_stage: proposal`，proposal 批准后报告 `next_stage: edit`；`video_compose` 以 ffmpeg runtime 渲染 9:16 成片，`_pre_compose_validation` 通过；Backlot `gate_skipped` 为空；importer 契约测试覆盖 digest 不匹配、sha256 不匹配、非 approved take 均拒绝；publish 署名检查对含 H3 take 的 manifest 生效（fixture），`publish_log.attribution` 含 `MiniMax H3`；2b：批次审批记录只在确实创建 task 时写、孤儿记录拒绝覆盖、无记录的 take 只出 `qc-approved` 各 1 例，`--shot` 与 `shotIds` 取交集及无交集 / 指向不存在镜头 / `--plan` 带 `--shot` 而 `--confirm` 不带（指纹不匹配）各 1 例，`upstream-take-unavailable` 的四条判据逐条有用例，证据登记的三种 mediaType 判定与 `--kind moderation` 缺 `--status` / `--reviewed-at` 被拒各 1 例 |
| 前提条件 | Phase 1 的 9:16 takes；1-1 场共 4 个 ▲ 行（【特效】×2、【特写】×1、1 条 VO），按 §6.1 的合并规则确定实际镜头数；成本为 GPU 小时（Spot 约 1.55 USD/h），无 provider 账单；本机 VCS 环境（Python 环境、ffmpeg、`pipeline_defs` 新清单）；导出期间 GPU VM 必须运行（资产在 VM 持久盘），`handoff --export-dir` 后 rsync 到本机 |

### 8.4 Phase 3：Seedance over BytePlus（账户就绪后）

| 项 | 内容 |
|---|---|
| 改动文件 | 新增 `hub/src/production-ark-adapter.ts` 与 `hub/test/production-ark-adapter.ts`、parity fixture；修改 `production-job-gateway.ts`（`JobRequestRecord` 增 `providerJobId`、`safetyIdentifier`、`deleteIssuedAt`；cancel 路径走「先 GET 后 DELETE」）、`production-gateway.ts`（`provider-output` 下载路径）、`production-gateway-runtime-config.ts`（Ark endpoint host、汇率、准入上限）、`production-runtime-config.ts`（第二个 gateway 实例条目） |
| 交付物 | Ark adapter（endpoint host 参数化：火山 / BytePlus；凭据 `{kind: "api-key-env"}`）；第二个 gateway 实例（云 adapter 与云输出 ingest，可跑在本机 loopback）与跨实例 CAS 取回（§6.4）；jobs kernel 的 `providerJobId` 持久化；ingest kernel 的 `provider-output` 路径；从 `tests/tools/test_seedance_volcengine.py` 导出请求 payload 与状态机 parity fixture（范围限定为 payload 形状与状态机；该测试的定价基于火山 CNY 表），BytePlus USD 价目以官方计价页单独建 fixture |
| 验收标准 | 录制 Ark 响应 fixture 覆盖 queued / running / succeeded / failed（含 `InvalidParameter.*`）/ expired / NotFound 与 429，以及「body 参数与文本指令冲突」实测以确定优先级；一条真实 t2v 任务 4 s / 480p / 9:16（`doubao-seedance-2-0-260128` 等价 BytePlus modelId，官方示例 480p 0.07 USD/s → 约 0.28 USD）全链路入库，产出主视频与 `return_last_frame` 尾帧两个 AssetRef，cost basis `reported`，reservation 释放；Ark cancel 状态机测试含「DELETE 前状态已变为 succeeded」用例（预期不发 DELETE，任务按 succeeded ingest）；`safety_identifier` 的对账用法经平台确认后启用 `list-window`，否则保持 `none` |
| 前提条件 | BytePlus 账户注册与认证、充值 ≥30 USD、Seedance 模型开通、签发 `BYTEPLUS_ARK_API_KEY`；项目 `allowedProcessingRegions` 含 SG（BytePlus ap-southeast-1）或 CN（火山）；`safety_identifier` 用作对账相关键的平台政策确认 |

### 8.5 Phase 4：Veo over Vertex（后续外语项目）

| 项 | 内容 |
|---|---|
| 改动文件 | 新增 `hub/src/production-vertex-veo-adapter.ts` 与测试；修改 `production-gateway.ts`（inline spool）、`production-gateway-runtime-config.ts`（tariff 价目、`allowedProcessingRegions`）；writing-loop 写作流程增加英文译文产物（draft 的 `prompt.translations[]`） |
| 交付物 | Vertex adapter（service-account 文件凭据；v1 inline 模式：输入 `bytesBase64Encoded` ≤20 MB、输出 base64 → spool；`ioMode: gcs` 可选，附 bucket / IAM / 区域核实项）；`tariff` 计费；`processing-region-not-allowed` gate 接入项目配置（`allowedProcessingRegions` 加 US）；英文 prompt 译文的 draft 供给步骤（写作侧 agent，决策 8）；音频探针 |
| 验收标准 | us-central1 一条 8 s / 720p / 9:16 i2v 真实任务（约 3.2 USD）；音频探针按 profile 实际配置的每个 modelId 各跑一条 4 s 任务（至少 `veo-3.1-generate-001`；若配置 fast 亦跑）并记录 operation name 写入 `nativeAudio.verifiedBy{modelId, probeRemoteJobId, providerJobId}`，lite 的探针只用于 lite profile，2026-08-07 的 fast 非静音样本因无 operation name 不作为 verifiedBy 证据；fast 4k、1080p / 4k 是否强制 8 s 两项实测结论写入 `profile.limits`（personGeneration 接受值可选探针，v1 不下发）；`seed` 固定两次生成的 sha256 比对记录为实测结论，预期为不一致；Veo 任务 reservation 释放 |
| 前提条件 | 外语项目立项（本版只做中文，决策 4）；Phase 1 的 gateway 与部署、Phase 3 的第二个 gateway 实例；项目 `allowedProcessingRegions` 含 US；写作侧译文供给步骤已定义并产出 `prompt.translations[]`；writing-loop-sg 上 `google-adc` 不可用，使用 veo-m2m.json（0600）service-account 文件 |

### 8.6 改动文件总表

writing-loop `hub/src/`（下表为 0-A…0-E 与 1a…1c 合并后的实际改动，基线 `main@1455194` → `main@f06653f`；`production-studio-handoff.ts` 的契约 v2 与 `handoff --export-dir` 归 Phase 2，尚未合并）：

| 文件 | 改动 |
|---|---|
| `production-shot-request.ts`（新增） | ShotRequest / ShotRequestDraft / `ShotExecutionProfile` 类型与严格解析；`deriveVideoMode`、`compileShotRequest`、`shotRequestFromScript`、镜头合并 `shotMergeBlocker` + `SHOT_MERGE_BLOCKERS` + `FORCED_SPLIT_TAGS`、`derivedShotSeed` / `withDerivedShotSeed`、输出意图校验；`SHOT_VALIDATION_CODES`（25）与 `DEGRADATION_CODES`（7） |
| `production-intent.ts` | 枚举扩展；两个云 execution 分支（本版只到解析层）；`parseProductionIntentExecution` 新增解析（静态字段与 modelId 级约束）；`parseInputs` 增加 `inputs[0]` mediaType 必须为 shot-request 的检查；license evidence `obligations`；三个 gate code、gate context 四字段与 deny 逻辑；`FAMILIES_REQUIRING_PROCESSING_REGIONS` 四家族全 deny；`licenseObligationViolations` 单一判据 |
| `production-adapter.ts` | `BACKEND_KINDS`、`VideoOutputRetention`、`VideoBackendLimits`、`ShotCompileCapability`、`BackendCapabilities` 迁入本文件；locator 判别联合 `ComfyViewOutputLocator \| ProviderOutputLocator`，输出总带 `source`；`h3LimitsByProfileId` 逐 profileId 推导 H3 能力，`ComfyUiAdapter.capabilities()` 按 profile 集合生成；`SubmitRequest` / `PreparedSubmission` 不变 |
| `production-provider-adapter.ts`（新增） | `ProductionProviderAdapter` 接口（`openOutput` 为可选成员）、`ProviderSubmitRequest` 与 `PreparedProviderSubmission` 判别联合、`BoundInput`、`ComfyUiAdapter` 薄包装，以及 capability / limits / locator 的跨线严格解析 |
| `production-coordinator.ts` | `SAFE_BACKEND_ERROR` 引用统一的 errorSummary 正则；`MODEL_FAMILIES` 扩到四值；「H3 必须有 stager」改为家族表 `REQUIRES_SCOPED_STAGING`；`settleQcBudget` 的 `SETTLED_COST_BASES` 增 `tariff` / `reported-converted` |
| `production-coordinator-domain.ts` | `ERROR_SUMMARY_ALTERNATIVES` → `PRODUCTION_ERROR_SUMMARY_PATTERN` 单一导出（含 `provider_failed:<code>`）；`parseOutput` 按 `source` 分支，缺省按 `comfy-view` 读取 |
| `production-reconcile.ts`、`production-ingestor.ts` | `parseRemoteObservation` / `parseLocator` / `compareProductionOutputLocator` 随 locator 联合变化；`ProductionArtifactIngestor` 保留 `ingestKey(task, observation)` 与 `ingest(...)` 两个成员 |
| `production-domain.ts` | cost 扩展（`tariff` / `reported-converted` 与 `settlement`，`amountMicros` 与汇率的等式以 BigInt 校验）。`production-read-model.ts` 增 `summary.cost.byBasis` 小计 |
| `production-runtime-config.ts`（worker 侧） | 家族集合；scoped-staging 强制与 `h3GraphContract: null` 规则按家族表；`bindings` 改为判别联合（`h3-graph-bindings` \| `provider-slot-policy`）；`backends[]`、`gateway`、`stagingProfiles[]` 三处 exactKeys 增 owner-only 的 `transport`（`"tls"` \| `"insecure-private-http"`），URL 策略函数增加对应分支（只接受 RFC1918 私网 IPv4 或 127.0.0.1 的 http URL，`credentialEnv` 必须非空，`kind: comfyui` 不接受该 transport），缺省仍为 HTTPS 规则；新增顶层可选 `executionProfileSnapshotFile` 与 `localAssetSource`；`parseProject` exactKeys 增 `allowedProcessingRegions`、`licenseCompliance`、`usesOutputToImproveModels`，`availableBudgetMicros` 保留为常量字段；backend kind 仍为 `comfyui \| production-gateway`；binding verifier 按家族分派 |
| `production-profile-snapshot.ts`（新增） | worker 侧只读 execution profile 快照解析：与导出端逐字段对齐、重算每条 `profileDigest`、按 pinned graph 同一纪律读取文件；`limits` 读为可选字段以兼容更早的快照 |
| `production-cas.ts`（新增） | 本机 workspace CAS：`productionCasDirectory` / `productionCasObjectPath`（`.writing-loop/<project>/production-cas.v1/sha256/<digest>`）、原子发布、异步读取与分码错误；上限 `MAX_PRODUCTION_CAS_OBJECT_BYTES` 64 MiB、`MAX_PRODUCTION_CAS_DOCUMENT_BYTES` 1 MiB |
| `production-local-asset-source.ts`（新增） | `WorkspaceCasLocalAssetSource`：按 `casAuthority` 只接受同 authority 的 `cas://` URI，读回时核对 digest 与 `byteLength`；契约 v2 的 prompt / seed 复核也走它 |
| `production-input-stager.ts` | `#publishLocalInputs`：staging 前对每个 `cas://` 输入先 `HEAD` 再按需 `PUT`（目标为 `stagingProfiles[].baseUrl`），错误分 `local-asset-unavailable` / `gateway-rejected` / `gateway-unavailable`；提交前用本机正本复核回执的 `shotRequest` 投影，不一致即 `workflow-invalid` |
| `production-gateway-runtime-config.ts`（新增） | server-owned registry 的严格解析（顶层 12 个 exact key、`listen.host` 私网/回环字面地址、`backends[]` 长度 1 且带 `maxInputImageBytes`、`executionProfiles[]` 正本 + graph 文件 digest 复核 + `priceTable` / `license` / `processingRegions`、`stageProfiles[]` 与绑定逐位对齐）；地域去重升序 `productionGatewayProcessingRegions`；`exportExecutionProfileSnapshot` 只读快照导出（恒含 `limits`，与 capability 网格一致性 fail-closed） |
| `production-gateway-main.ts`（新增） | 三内核同进程装配、bearer 鉴权、绑定校验与优雅停机；`ProductionGatewayCasAssetResolver`（`cas://<casAuthority>` → 本机 ingest CAS）与 `assetPolicies` 条目注入；ffmpeg 尾帧提取器注入与装配期探针；`--export-profile-snapshot` 分支 |
| `production-stage-gateway.ts` | profile 增 `slotPolicy`（`{version, slot, minCount, maxCount, mediaTypes}`，与固定 `inputs` 二选一）与前向分配 `resolveSlotPolicyInputs`（带序号 slot 实例）；允许媒体类型集合增 `application/vnd.writing-loop.shot-request+json`，该类型改为内容校验并把 `prompt.text` / `output.seed` 作为回执的 `shotRequest` 投影返回；`ProductionStageAssetResolver` 端口 |
| `production-job-gateway.ts` | `rawAdapter` 类型改为 `ProductionProviderAdapter`；`parsePreparedForProfile` 与 attempt 持久记录按 `PreparedProviderSubmission` 分支；`capabilities()` 转发；`terminal.json` durable 终态记录与启动时的抢占扫描 `recoverPreemptedJobs` / `#recoverOneJobUnderDeadline`（写 `preempted.json`，`errorSummary: provider_failed:preempted`） |
| `production-gateway-router.ts` | `METHODS` 增 `assets: GET/HEAD/PUT` 与 scope 级 `capabilities: GET`；`route` 对无对象段的 `capabilities` 单独判定 |
| `production-gateway.ts` | `parseLocator` / `compareLocator` / `parseIngestRequest` 随 locator 联合变化；`assets` 路由的内容寻址上传（sha256 复算不符 400、同字节重放 200、同名不同字节 409、超限 413、非图片且非 ShotRequest 正本 415，与 ingest 同一 temp + fsync + link 原子路径）；`#deriveLastFrame` 按 `role: last-frame` 或 ffmpeg 派生登记第二资产，失败即 `derivation-failed` |
| `production-h3-graph.ts` | 契约 v2：`h3GraphContract.version` 取 1 或 2；绑定契约与 stage 契约校验增加 `shot-request` slot（`source` / `consumer` 为 `null`）；`productionH3ShotRequestSentinel` 与 `productionH3StageInputSentinel`，`generator.prompt` 与 `RandomNoise.noise_seed` 改为 sentinel，参数投影对模板占位符计算，materialize 后重新断言整图 |
| `production-shot-plan.ts`（新增） | `ShotBatchRequest` / `ShotBatchPlan` 解析与装配：选档、估算、`policyDigest` 与 `batchPlanId`、承接链 `waves[]`、`samplePolicy` 与样片门、`applyVisualDefaults`、逐镜 seed 派生判定、`--plan` 零写入与 `--confirm` 的逐镜 CAS → intent → task 发布 |
| `production.ts`、`cli.ts` | `production plan-shots --plan/--confirm`（含 `--from-script` / `--scene` / `--config`）与 `production qc --approve\|--reject`；`cli.ts` 增 `visual` 路由与三条用法说明 |
| `visual.ts`（新增）、`visual-production.ts` | `writing-loop visual approve-candidate` 子命令与 `reviewVisualCandidate`（只允许 `keyframe-review` 阶段、已裁决不改判、原子写回）；候选图增 `shotIds` / `containsRealFace`，顶层增 `subjectReferences[]`；`visual/mappings.v1.json` 与 `visual/prop-states.v1.json` 的类型、解析与路径常量 |
| `script-lint.ts` | 只增只读投影 `sceneAnnotationLines`（整行 `【…】` 生产标注），既有 lint 判据不变 |
| `production-worker.ts` | 入口 main 判定改为比对 realpath（npm bin 是 symlink，原判定会静默退出 0） |
| 后续阶段新增 | `production-ark-adapter.ts`（Phase 3）、`production-vertex-veo-adapter.ts`（Phase 4）；`production-job-gateway.ts` 的 `JobRequestRecord` 增 `providerJobId` / `safetyIdentifier` / `deleteIssuedAt` 与 Ark 的「先 GET 后 DELETE」cancel 路径同属 Phase 3；`production-gateway.ts` 的 `provider-output` 下载路径与 Vertex inline spool 属 Phase 3 / Phase 4；`production-studio-handoff.ts` 的契约 v2 与 `handoff --export-dir` 属 Phase 2 |
| 文档与测试 | AI-SPEC 的三个 fixture 与 §5 / §7 / §9 / §9B；`references/config-schema.md`；`references/visual-production-schema.md`；`hub/test/` 新增五个文件 `production-shot-request.ts`、`production-shot-plan.ts`、`production-provider-adapter.ts`、`production-gateway-main.ts`、`production-cost.ts`，并扩展既有 `production-*.ts` 与 `visual-production.ts` |

video-creation-studio：

| 文件 | 改动 |
|---|---|
| `pipeline_defs/scripted-drama.yaml`、`skills/pipelines/scripted-drama/*.md`（新增）；`skills/video-creation-studio/references/execution-contract.md` | 清单、director 技能；handoff 导入路由与 scripted-drama 停止规则 |
| `skills/video-creation-studio/scripts/import_handoff.py`、`tests/contracts/test_import_handoff.py`（新增）；`skills/video-creation-studio/scripts/studio.py` | importer 与契约测试；`import-handoff` 命令 |
| `schemas/artifacts/scene_plan.schema.json` | `scenes[]` 增 `shot_request_ref`、`continuity{first_frame_asset_id, last_frame_asset_id, reference_asset_ids[]}` |
| `schemas/artifacts/asset_manifest.schema.json` | `assets[]` 增 `sha256`、`role`（`take \| last-frame \| keyframe-first \| keyframe-last \| reference:<purpose>`）、`provider_job_id`、`plan_sha256`、`writing_loop_task_id`；现有 `license` 承载 handoff 的许可摘要（修正 F5：显式修改 schema） |
| `schemas/artifacts/decision_log.schema.json` | `decisions[]` 为统一对象且 `additionalProperties: false`，因此在 `decisions[].properties` 增加可选 `plan_sha256`、`degradations[]`（对所有 category 生效） |
| publish 阶段 | `publish_log` 增 `attribution[]`；publish 前的校验脚本检查含署名义务的 license 时 `attribution` 含 `MiniMax H3` |
| `backlot/state.py` | 分镜卡片显示 `provider_job_id`、尾帧缩略图、GateRecord 来源 |
| `docs/PROVIDERS.md` | 说明生成阶段由 writing-loop 承担时 `video_selector` 不参与；`tools/video/veo_video.py` 不变 |

## 9. 风险与未核实清单

### 9.1 风险与未决问题

1. H3 graph 未经 live 验证：契约 v2 改变参数投影范围（`generator.prompt` 与 `RandomNoise.noise_seed` 转为 sentinel），需与 ComfyUI ≥0.30.0 的 MiniMaxH3 节点契约实测对齐；SaveVideo 在 `/history` 中的输出分组名未核实；四组件权重 sha256 清单在镜像中的存放位置未记录。三项均在 Phase 1 的 live `/prompt` 探针与首条任务中确定，属本版的主要技术风险。
2. Spot 抢占：按需 RTX PRO 6000 配额为 0，无按需回退，Spot 抢占即当前 ComfyUI 进程内任务丢失。持久化启动盘保证 job record 与 CAS 对象在重启后可读；改写路径已实现（启动扫描 `recoverPreemptedJobs`，§7），但抢占后仍需人工重启 VM，且整条路径未在真实抢占下取证（§9.3）。
3. GPU VM 停机期间 `handoff --export-dir` 不可执行：资产在 VM 持久盘，导出经 gateway 的 `assets` GET 路由。导出必须在 VM 运行期间完成，否则 Phase 2 的导入步骤阻塞。
4. H3 契约无 negative prompt 输入：本版编译层拒绝非空 `negativeText`，否定表述只能写进正向 prompt 或不写；H3 对否定表述的响应未核实（§9.3）。
5. gateway 进程与 ComfyUI 同机的部署链路从未在真实主机上跑过：`production-gateway-main.ts` 与 registry 已合并（1a–1c），但镜像内的服务启用、地域门、权重清单导出与 gateway 安装（本机 `npm pack` → 经隧道 scp）都要到 GPU 会话才验证。
6. 明文 HTTP 的适用条件（§8.0）：当前拓扑下 gateway 只绑 VM 的 `127.0.0.1`，明文段只在隧道两端的 loopback 上出现，跨主机段由 IAP ssh 隧道加密，因此 VPC 内其他工作负载看不到 bearer 与请求体。该结论绑定这一拓扑：若把 gateway 改绑 VPC 内网 IP，明文段对同 VPC 内的工作负载可见，须重新评估或改回 `transport: "tls"`。
7. 分镜数据缺口（景别、机位、时长、站位）：EP001 试点前需补齐 `prop-states.v1.json` 与 `mappings.v1.json`，`camera` 六字段由人工填写。`visual/production.v1.json` 的 `candidates` 为空，本版关键帧来源为 `operator-upload`、`previous-shot-last-frame`、`previous-episode-end` 三种，`approved-candidate` 为并行人工轨道。
8. MiniMax H3 Community License 的年收入阈值与署名义务需项目级声明（`licenseCompliance`）。部署地与使用地均为 SG，不命中 EU / GB / KR / US，本版不需要书面许可；地域配置变更时该结论失效。
9. VCS 预授权检查点依赖 GateRecord 与 decision_log 解释来源；`get_next_stage` 在 proposal 未完成而 scene_plan / assets 已完成时的表现以 Phase 2 验收为准。
10. `MAX_PRODUCTION_INTENT_INPUTS = 32` 与 Seedance 2.5 的 30 张参考上限接近；ShotRequest 的 12 张限制为设计约束。
11. Seedance（Phase 3）：2.x 拒绝真人人脸参考且 seed 不可用，跨镜头人物一致性依赖参考图与首尾帧链；2.x 对 seed 参数忽略还是报错未核实；body 参数与文本指令冲突时的优先级未核实；查询接口对已过期 / 已删除任务返回的 HTTP 状态码未核实；输出 URL 24 h 有效期与 worker 调度间隔耦合，停摆超过 24 h 导致已计费任务 `output_expired`；火山 CNY 计费需汇率配置，默认先接 BytePlus（USD）回避。
12. Seedance / Vertex 均无幂等键；`submission-unknown` 对账依赖 `safety_identifier` 作为相关键，该用法是否符合平台使用政策未核实（随 Phase 3 处理）；未确认前 reconcilePolicy 为 `none`，最坏情况为 `execution_expires_after` 内排队孤儿产生费用并计入 exposure。
13. Veo（Phase 4）：音频能力文档冲突只在 generate-001 与 fast 上（模型页 Not supported、计价页 Video + Audio），lite 探针不能推及其他 modelId；fast 4k 文档冲突、1080p / 4k 强制 8 s（Gemini API 文档明文，Vertex 操作指南无说明，本文采用保守规则）、personGeneration 接受值、并发上限均未核实；`global` 区域未核实，本文不支持；LRO 结果保留期未核实（inline spool 规避）；gcs 模式的 bucket、IAM、区域三项未核实。
14. Veo（Phase 4）的凭据：writing-loop-sg 的 VM 默认 SA scope 不含 cloud-platform，`google-adc` 在该主机不可用；Phase 4 用 service-account 文件（veo-m2m.json，0600），换绑 SA 需停机。该项随控制面迁到本机（决策 10）后取决于届时实际运行云 gateway 实例的主机。

### 9.2 本轮核查关闭的未决项

Seedance running 状态不可取消（文档确认）；Veo 3.x 不可关闭 prompt rewriter（文档确认，seed 改为 best-effort）；Veo lite 不支持参考图、fast / lite 无 4k 输出（模型页确认）。

0-A…0-E 与 1a…1c 合并后关闭的项（判据已在代码与测试内）：gateway 进程装配不在仓库内（`production-gateway-main.ts` 与 `production-gateway-runtime-config.ts` 已合并）；TLS 终结与证书分发（改为 `transport: "insecure-private-http"` + IAP ssh 隧道，决策 2 + 决策 10）；GPU VM 出网前提（安装包由本机 `npm pack` 后经隧道 scp，不需要 Cloud NAT 或外网 IP，2026-09-02 核实 asia-southeast1 无 NAT、默认子网 Private Google Access 关闭）；writing-loop-sg 的 ffmpeg / 根盘（ffmpeg 6.1.1、根盘 100 GB 已核实，且该主机按决策 10 不再参与视频生产）；`allowedProcessingRegions` 缺省时 H3 / generic 是否放行（0-E 起四家族一律 deny）；正本资产送到 GPU VM 的通道（1c 的 `assets` `PUT` / `HEAD` 路由与 worker 侧自动上传）。

### 9.3 未核实清单

| 项 | 影响范围 | 核实方式 / 阶段 |
|---|---|---|
| H3 graph live 行为、节点 schema 与契约一致性 | 契约 v2、Phase 1 首条任务 | Phase 1 live `/prompt` 探针 |
| H3 SaveVideo 在 `/history` 中的输出分组名 | `outputLocators` 与 ingest | Phase 1 实测写入测试 |
| H3 四组件权重 sha256 清单在镜像中的存放位置 | `h3GraphContract` 的 modelBundle attestation | Phase 1 从镜像导出 |
| H3 对否定表述的响应、prompt 语言限制 | H3 分支 `negativeText` 处理、prompt 编写 | Phase 1 之后按样片评估；本版拒绝非空 `negativeText` |
| H3 视频延长能力 | 非目标 | 未核实 |
| GPU VM 上的 ffmpeg / ffprobe 与 gateway 的 systemd 单元 | 尾帧派生（无可用 ffmpeg 即 `derivation-failed`）与 gateway 常驻 | GPU 会话部署时核实 |
| Spot 抢占后的实际恢复行为 | 抢占扫描三前置、job record 与 CAS 对象在重启后的可读性 | GPU 会话的模拟抢占用例 |
| Seedance 2.x seed 参数行为、body 与文本指令冲突优先级、NotFound HTTP 状态码 | 编译规则、fixture | Phase 3 录制 fixture |
| Seedance 对白口型质量 | 无官方指标 | Phase 3 样片评估 |
| `safety_identifier` 用作相关键的平台政策 | Ark reconcilePolicy | Phase 3 前向平台确认 |
| Veo generate-001 / fast 原生音频 | `nativeAudio.status`、含对白镜头路由 | Phase 4 按 modelId 探针，记录 operation name |
| Veo fast 4k | `parseProductionIntentExecution` veo 分支 | Phase 4 实测写入 `profile.limits`，之前拒绝 |
| Veo 1080p / 4k 是否强制 8 s | 时长网格 `gridByResolution` | Phase 4 实测，之前固定 {8} |
| Veo personGeneration 接受值 | 不下发 | Phase 4 可选探针 |
| Veo 并发上限、`global` 区域、LRO 保留期、gcs 前提 | 准入配置、location、spool、ioMode | 官方 quotas 页无 Veo 行；gcs 仅在启用时核实 |
| Vertex operations 列表是否覆盖 `predictLongRunning` | reconcilePolicy | 未核实，Vertex 固定 `none` |

### 9.4 权衡

| 方案 | 收益 | 影响 |
|---|---|---|
| 云后端 kind 只在 gateway registry 扩展，worker 侧 backends[].kind 保持 `comfyui \| production-gateway` | 凭据不进入 worker | 没有云后端的开发期直连通道，联调必须先部署 gateway 进程；jobs 端点在本版为私网明文 HTTP + bearer（owner-only 选项），本机联调需在同 VPC 内或改用 loopback 形态 |
| 本版 gateway 为单实例，三个 kernel 与 ComfyUI 同机在 GPU VM 上 | stage kernel 的硬链接模型与 ComfyUI 同一文件系统的要求得以保持；无跨实例 CAS 取回；只有一处入站端点 | 账本与执行分处两台主机；CAS 与 job record 随 VM 持久盘存在，导出资产要求 VM 运行。替代方案为 stage kernel 增加远端上传模式（`/upload/image`），需放弃 CAS 硬链接模型，本文不采用 |
| worker 与 gateway 之间不使用 TLS，改为明文 HTTP + bearer 的 owner-only 选项（`transport: "insecure-private-http"`），当前拓扑下两端都是 loopback、跨主机段由 IAP ssh 隧道加密 | 省去证书签发、分发与轮转，GPU VM 按需启停时不需要维护证书生命周期 | 放宽了 `production-runtime-config.ts` 的 fail-closed 约束，安全性改由隧道与 gateway 只绑 `127.0.0.1` 承担；适用条件写入配置文档，改绑 VPC 内网 IP 或跨 VPC / 公网部署时失效 |
| 控制面固定在操作者本机（决策 10） | 账本单一写入者且与 VCS、Blender 同机，handoff 不需要 rsync | worker 与 gateway 不同网，必须经 IAP ssh 隧道；批次期间隧道必须保持，导出资产时 GPU VM 必须在运行 |
| 五个 binding 字段全部静态、逐镜变量全部放入 ShotRequest | registry、coordinator 比对、staging profile 交叉校验零改动 | gateway 必须解析 ShotRequest 才能构造请求，intent 的 execution 不再自描述时长与模式，H3 的时长档仍需逐档 profile |
| ShotRequest 作为 CAS 资产进入 inputs[0] | prompt 与连续性输入被 idempotencyKey 与 stageKey 覆盖 | stage kernel 需要为无魔数的 JSON 增加内容校验，t2v 任务也必须先入 CAS，且所有输入 AssetRef 须使用带 authority 的 `cas://` URI |
| provider 分配的 task_id 由 jobs kernel 持久映射，coordinator 契约不变 | PUT body 零改动 | POST 与 providerJobId 落盘之间的崩溃窗口只能按后端相关键对账或转 orphaned |
| 尾帧承接对 Seedance 用 return_last_frame，对 Veo 与 H3 用 ffmpeg 提取 | 三家统一为 `role: last-frame` 资产 | 提取帧与模型内部末帧存在编码差异 |
| 首尾帧与参考并存时以 anchorMode 编译决策并强制重审批 | 连续性输入不被静默丢弃 | 审批轮次增加 |
| Veo 只接受英文 prompt，编译器只选用 draft 中已提供的译文并记 `prompt-translated` 强制重审批 | worker / gateway 不调用 LLM 的约束得以保持 | 写作侧多一个译文产物，含中文口型对白的镜头不能用 Veo；本版不做译文，Veo 归入后续外语项目 |
| Veo v1 采用 inline base64 输入输出 | 不引入 bucket、IAM 与区域前提，与已验证的 veo_generate.sh 路径一致 | gateway 内存与 spool 承担约 10–15 MB / 任务，输入受 20 MB 限制 |
| 新增 tariff 与 reported-converted basis | Veo、H3、火山任务可释放预留 | 账面金额可信度低于 reported / billed，读模型需分列；GPU VM 小时不在 tariff 内，本版只作为 plan 文档的估算附注 |
| 后端选择由 compileShotRequest 的确定性过滤与偏好顺序完成 | 同一 draft 在同一配置下总是编译出相同 intent | 没有按质量 / 成本自动权衡 |
| 分镜时长与后端最小时长的差异通过多生成、edit 阶段裁切解决 | 接口不需要逐后端裁切参数 | 每镜多支付 1–4 秒生成费用 |
| VCS 以 scripted-drama 清单承接并由 importer 预授权 scene_plan / assets 检查点 | 写作侧 QC 只做一次 | VCS 的 reviewer 自审与供应商选择在该路径下被跳过，需要 GateRecord 与 decision_log 解释门的来源 |
| 第一阶段只用私有部署的 H3，Seedance 与 Veo 保留在类型层、实现后置 | 第一条真实任务不被外部账户开通与译文供给阻塞，且不产生 provider 账单 | H3 只支持 fl2va / ref2va，首条任务需要 `operator-upload` 首帧；契约 v2 从 Phase 4 提前到 Phase 1；三家后端的 parity 只在类型层验证，两家云 adapter 的实际差异要到 Phase 3 / Phase 4 才暴露 |
| 项目级月度余量门删除，只保留 per-intent reservation | 减少一个人工审批点与一处需要手工维护的配置；GPU 小时不构成阻断 | 项目级现金支出没有自动阻断，依赖操作者对 credit 余额的判断；`stop_billing` 触发时仍会停止全部 VM |
| 镜头合并规则固定为 `stageGroup` 内、十条判定条件全部满足（另加一道结构上限兜底） | 合并结果确定性、可测试，不需要 LLM 参与 | 判定条件保守，跨机位或跨灯光的连续动作不会被合并，实际镜头数仍高于逐集 60 秒的成片预算，需要分镜阶段主动统一机位 |

## 10. 附录：修订记录

本节记录 v1 成文时（2026-08-27）核查修订的处理方式，按当时的设计状态陈述，不随 v2 改写。其中被 2026-08-28 的 9 项决策取代的条目（TLS 终结与证书方案、gateway 双实例、GCP 项目级月度余量门与 VM 时间窗审批、Phase 1 后端裁定、Veo 译文供给），以 §11 的 v2 修订记录为准。

来源：核查修订记录 39 条（api-accuracy 16、codebase-fit 10、operations 12、未质疑内容 1），按主题归并；每条保留处理方式。状态标签：已修正（major / blocker）、已处理（minor）、保留。

### 10.0 相对评审骨架（视角 A）的修正清单 F1–F13

修订记录与正文中的 F 编号指此表。

| 编号 | 问题 | 核对结果 | 处理 |
|---|---|---|---|
| F1 | parametersSha256 含逐镜字段 | `workflowBindingKey` 由 backendInstanceId、workflowSha256、modelFamily、modelSha256、parametersSha256 五项组成（`hub/src/production-runtime-config.ts`）；`ImmutableWorkflowRegistry.#read` 返回 config 固定值；coordinator 逐项比对（`production-coordinator.ts`） | 五项全部为 execution profile 静态值；逐镜字段只存在于 inputs[0] 的 ShotRequest（§4.2） |
| F2 | importer 代写 research / proposal / script 检查点 | `_validate_artifacts_for_stage` 要求 completed / awaiting_human 含 canonical 与 produces 全部工件（`lib/checkpoint.py`） | 新建 `pipeline_defs/scripted-drama.yaml`（§4.8） |
| F3 | Veo 成本 basis=estimated 不释放 reservation | `settleQcBudget` 仅 reported / billed 释放（`production-coordinator.ts`） | 新增 basis `tariff`、`reported-converted`（§4.6） |
| F4 | 镜头语言枚举与 scene_plan schema 不一致 | `shot_language` 为 `additionalProperties: false`（`schemas/artifacts/scene_plan.schema.json`） | ShotRequest.camera 直接采用该 schema 枚举（§4.1） |
| F5 | asset_manifest 增字段与「不改 schema」冲突 | assets 项 `additionalProperties: false`，已有 subtype 与 license（`schemas/artifacts/asset_manifest.schema.json`） | 显式修改两份 schema（§8.6） |
| F6 | 缺站位、群演、声线、stageGroup | AI-SPEC:178-180 连续性包要求 | 增字段，允许 null（§4.1） |
| F7 | job gateway 改动遗漏 | `parseProfile` 要求 workflow 为对象且 staged 时 h3GraphContract 非空；`validateClientWorkflow` 要求节点含 class_type / inputs（`hub/src/production-job-gateway.ts`） | 列入 §8.6 |
| F8 | Veo `global`、1080p / 4k 强制 8 s、personGeneration 枚举未核实 | Vertex 文档仅 us-central1；8 s 规则来源为 `tools/video/veo_video.py`，Gemini API 文档亦明文 1080p / 4k 仅 8 s | location 固定 us-central1；1080p / 4k ⇒ 8 s 作为保守默认规则；personGeneration v1 不下发；4k 按 modelId 处理（§4.2、§5.2） |
| F9 | Veo 参考图约束表述错误 | ≤3 张 asset 或 1 张 style，且仅 veo-3.1-generate-001 与 fast 支持，lite 不支持 | 修正（§5.2） |
| F10 | carryFrom 要求上游 approved，批量退化为逐镜串行 | — | 上游状态 ∈ {qc-pending, approved}（§6.4） |
| F11 | 缺 t2v 行 | `H3_VARIANTS` 仅 fl2va / ref2va（`hub/src/production-intent.ts`） | 映射表增 t2v 行（§5.3） |
| F12 | Seedance adapter TS 重写、价目两处存放 | — | 价目只存在于 execution profile 文件；VCS 测试导出 payload parity fixture，定价 fixture 单独建（§8.2） |
| F13 | H3 参数投影含 `generator.prompt` 与 `noise_seed`（`hub/src/production-h3-graph.ts`），逐镜 prompt 需要逐镜 pinned graph 与 config 条目 | 已核对 | Phase 4 引入 H3 graph 契约 v2：prompt / seed sentinel（§5.3、§8.5） |

### 10.1 API 准确性（api-accuracy）

- [major] Veo `enhancePrompt: false` 与 seed 可复现 → 已修正：Veo execution 删除 enhancePrompt 与 personGeneration；capability seed 增 `uint32-best-effort`；Veo 分支总是记录 `seed-not-reproducible`，`fingerprint` 增 `seedReproducible`（Veo 恒为 false）；Phase 3 验收保留固定 seed 两次生成比对，预期结论改为不一致；关闭项注明 Veo 3.x 不可关闭 prompt rewriter。
- [major] Veo prompt 仅英文 → 已修正：limits 增 `promptLanguages`（Veo 为 ["en"]）；draft 增 `prompt.translations`、ShotRequest 增 `prompt.selectedTranslation`，编译器选用译文时记 `prompt-translated`（requiresReapproval: true），无译文返回 `prompt_language_unsupported`，lipSync 对白语言不受支持返回 `dialogue_language_unsupported`；非目标写明译文由写作侧提供、编译器不调用 LLM；映射表增「prompt 语言」行；风险 10 / 18 记录译文供给步骤未定义。
- [major] Veo 分辨率 / 参考图应按 modelId 约束 → 已修正：veo 分支按 modelId 约束（lite 拒绝 4k 与 ref2v；fast 4k 标 unverified 探针前拒绝；generate-001 允许 4k）；capability 改为 `limitsByModelId`；映射表参考与分辨率行按 modelId 分列；Phase 0 验收增加 lite+ref2v、lite+4k、fast+4k 用例；F9 更正。
- [major] Veo 音频探针用 lite 不能推及 GA / fast → 已修正：`nativeAudio.verifiedBy` 增 modelId 与 providerJobId，禁止跨 modelId 复用；映射表原生音频行按 modelId 写明冲突来源；Phase 3 探针改为每个配置的 modelId 各跑一条 4 s 任务并记录 operation name，lite 只用于 lite profile；风险 1 改写。
- [major] Seedance 文本弱校验传参（--rs/--rt/--dur/--seed 等） → 已修正：编译器对 `prompt.text` 与 `negativeText` 检查 `(^|\s)--(rs|rt|dur|fps|seed|cf|wm|frames)\b`，命中返回 `prompt_contains_provider_directive`（error，所有后端一律拒绝）；capability 增 `promptDirectiveSyntax`；映射表增「prompt 文本指令」行并注明 gateway 二次校验；Phase 1 fixture 增加 body 与文本指令冲突实测；风险 6 记录优先级未核实。
- [major] Ark 取消语义（DELETE 对已完成任务为删除记录） → 已修正：Ark cancel 先 GET 状态、仅 queued 才 DELETE，其余状态禁止调用；running 不可取消由文档确认，关闭项记录；映射表取消行改写；§7 取消条款与测试增加「DELETE 前状态已变为 succeeded」用例；`JobRequestRecord` 增 `deleteIssuedAt`，cancel 路径列入改动。
- [major] MiniMax H3 Community License 三项义务未表达 → 已修正：目标 1 写明三项义务；`ProductionLicenseEvidence` 增 `obligations{attribution, revenueThresholdUsd, noModelImprovement}`；新增 gate `license-obligation-unmet` 与项目 `licenseCompliance` 配置；asset_manifest 现有 `license` 字段承载 handoff take 的许可摘要，publish 前署名检查；Phase 2 handoff v2 takes 增 license 摘要，Phase 4 前置增 `licenseCompliance` 配置；AI-SPEC 增「输出不得用于改进其他模型」约束；publish_log 增 `attribution[]`；风险 17 记录。
- [minor] personGeneration 枚举不一致 → 已处理：Veo execution 不下发 personGeneration（类型中移除，注释说明接受值未核实）；映射表提交行同步；Phase 3 列为可选探针；F8 更正。
- [minor] 1080p / 4k 强制 8 s 应作保守默认 → 已处理：时长规则对 Veo 1080p / 4k 固定网格 {8}；逐镜约束写明保守规则与来源；`durationSeconds` 增 `gridByResolution`；Phase 0 验收增加 1080p + 4 s 被拒；风险 2 保留探针后放宽。
- [minor] Ark list-window 对账缺相关键 → 已处理：§7 对账段改写为以 `safety_identifier`（remoteJobId 派生 64 位十六进制串）作相关键，按 status 分页匹配；平台使用政策合规未核实，未确认前 Ark reconcilePolicy 为 `none`；提交 body 增 `safety_identifier`；`JobRequestRecord` 增 `safetyIdentifier`；风险 3 改写。
- [minor] Seedance 2.5 参考上限与仅音频 → 已处理：映射表参考行按 modelId 分列（2.0：9/3/3 不允许仅音频、音频 [2,15] s；2.5：30/10/10 允许仅音频、[2,30] s、单次素材 ≤50）；limits 增 `audioOnlyReference` 与 `maxReferenceAssetsTotal`；错误码增 `audio_only_reference_unsupported`；Phase 0 验收增 2.0 仅音频参考被拒。
- [minor] 参考序号写法与 prompt 长度建议 → 已处理：序号正则改为 `@?(图片|图像|图|视频|音频)\s*(\d+)`，越界返回 `reference_index_out_of_range`；Seedance 分支增 warning `prompt_length_over_recommendation`（中文 ≤500 字 / 英文 ≤1000 词）；映射表 prompt 语言行注明建议值。
- [minor] `execution_expires_after` 固定 3600 → 已处理：Seedance execution 增 `executionExpiresAfterSeconds`（[3600, 259200]）作为 profile 配置项；§7 写明按批次规模 / 并发上限 / 单任务时长估算，孤儿风险由对账与相关键处理；映射表提交行同步。
- [minor] 价目未区分含 / 不含视频输入与最低 token 用量，Phase 1 估算未指明 modelId → 已处理：reported 计算按 `{resolution, withVideoInput}` 二维价目、由 boundInputs 是否含 `reference_video` 选档、估算器加入最低 token 用量表；估算与 plan 文档写明 modelId 与价目档；Phase 1 验收写明 modelId 与估算（2.0 480p 4 s 约 0.28 USD、2.5 约 0.41 USD）。
- [minor] 2.5 参数错误可能在排队后异步返回 → 已处理：终态映射表增加 `InvalidParameter.*`（含 TaskTypeConstraint / TaskTypeMismatch）→ failed:`invalid_input`，写明排队期间 reservation 保持 exposed；Phase 1 fixture 覆盖该错误码。
- [minor] not-found 不应写死 404 与 7 天 → 已处理：映射改为「查询返回 NotFound 类错误（过期或已 DELETE，状态码由 Phase 1 fixture 实测）→ not-found」，对账日志按 jobs kernel 是否发过 DELETE 区分两种来源；风险 6 记录状态码未核实。

### 10.2 代码库契合（codebase-fit）

- [major] `PreparedSubmission` 无法承载 cloud-video，`parsePreparedForProfile` 与恢复路径未列入 → 已修正：定义 gateway 内部 `PreparedProviderSubmission` 判别联合（comfy-workflow 沿用原 PreparedSubmission；cloud-video 含 executionProfileSha256、shotRequestSha256、boundInputs、wire body 与 requestDigest），`ComfyUiAdapter` 包装保持 SubmitRequest；写明 `parsePreparedForProfile` 按 profile 形态分支的校验项；改动清单补入 parsePreparedForProfile、attempt 持久记录、`#resumeSubmission`，并注明 `SubmitRequest` / `PreparedSubmission` 不变。
- [major] 云家族走 scoped-staging 时 worker 侧 `ExactWorkflowBindingVerifier` 与 gateway 侧 `#verifiedStageReceipt` / `#resolveSubmissionProfile` fail-closed → 已修正：`production-runtime-config.ts` 增按家族分派的 verifier（云家族校验 template == bound、staged.bindings 与 ShotRequest slot 一致）与装配分支；`production-job-gateway.ts` 两处按 profile 形态分支（execution-profile 形态跳过 H3 模板断言，改为 receipt 与 ShotRequest 内容校验）；Phase 4 交付列入 worker 侧 verifier。
- [major] `urn:sha256` AssetRef 无 authority，stage kernel allowlist 拒绝 → 已修正：新增「资产 URI」段：进入 inputs[] 的 AssetRef 一律为 `cas://<cas-authority>/sha256/<digest>`，ShotRequest 由 `plan-shots --confirm` 写入 workspace CAS，gateway 以 `ProductionStageAssetResolver` 解析该 authority；承接链增加尾帧再登记步骤（编译器改写 urn → cas，sha256 不变）与跨实例取回；Phase 1 交付与验收（承接链经 `cas://` 再登记）；stage gateway resolver 与 assetPolicies、ingest 同步写入列入改动。
- [minor] production-gateway backend 要求 HTTPS + credentialEnv，本机联调不豁免 → 已处理：与 operations blocker 合并，部署拓扑写明约束来源与 TLS 终结方案；权衡补充本机联调需自签证书或本地反代；Phase 1 交付 TLS 终结与证书分发。
- [minor] H3 时长档需逐档 profile → 已处理：映射表时长行改写为「网格 = 已配置 (variant, durationSeconds, aspectRatio) profile 集合，每档需独立 h3GraphContract + workflow 文件 + stagingProfile 条目」；时长规则注明 H3 网格来源；Phase 4 `compileShotRequest` H3 分支在该集合内取整；权衡补充。
- [minor] ShotRequest 到 H3 gateway 的传递方式未定义 → 已处理：映射表逐镜 prompt 行与输入顺序段写明 H3 契约 v2 在 `validateStageContracts` 前增加 index 0 的 `shot-request` slot（不绑定 LoadImage，gateway 从 receipt 的 staged object 读取），LoadImage 绑定 index 顺延；Phase 4 交付与改动清单列入 `production-h3-graph.ts` 改动。
- [minor] `decision_log.schema.json` `provider_selection` 只是 category 枚举 → 已处理：改为在 `decisions[].properties` 增加可选 `plan_sha256`、`degradations[]`（对所有 category 生效）。
- [minor] 改动清单遗漏 `parseProject` exactKeys、`parseIngestRequest` / `compareLocator`、`parseOutput`、router capabilities 路由、批次 planId 与单 intent planId 不一致 → 已处理：改动清单补入对应位置；读取兼容段同步；写明 `--confirm <batchPlanId>` 内部对每个 intent 以其自身 planId 调用 `commitProductionTaskEnqueue`，批次 planId 只用于批次审批。
- [minor] 引用行号与基线不一致 → 已处理：全文更正 `production-coordinator.ts` 词表、`MODEL_FAMILIES`、retry 常量、reserve；`production-h3-graph.ts` noise_seed；`production-runtime-config.ts` ImmutableWorkflowRegistry、workflowBindingKey；`production-domain.ts` ShotRevisionRef；`production-stage-gateway.ts` ALLOWED_MEDIA_TYPES；AI-SPEC；parsePreparedForProfile。行号已在 main@1455194 重新核对。
- [minor] parity fixture 定价只覆盖火山 CNY 路径 → 已处理：Phase 1 限定 parity fixture 范围为请求 payload 形状与状态机；BytePlus USD 价目以官方计价页单独建 fixture；Ark adapter endpoint host 参数化；F12 同步。

### 10.3 运维（operations）

- [blocker] jobs 端点要求 HTTPS + credential，仓库 gateway 仅明文 HTTP 私网 IP，缺 TLS 终止 / 证书 / 部署主机 → 已修正：新增部署拓扑（约束来源、实例 A 部署到 writing-loop-sg、TLS 终结只绑私网 IP 且不复用 0.0.0.0/0 的 443 规则、私有 CA + `NODE_EXTRA_CA_CERTS` 或内网域名证书、credentialEnv 经 EnvironmentFile 0600）；Phase 0 并行前置增加服务器 ffmpeg / Node / systemd 核实；Phase 1 交付部署项，验收增加 credential 拒绝 / 受理两例；风险 11 记录服务器环境未核实。
- [blocker] BytePlus 账户与密钥不存在 → 已修正：Phase 0 并行前置列出账户注册、充值 ≥30 USD、模型开通、独立 env 名 `BYTEPLUS_ARK_API_KEY`（负责人：项目操作者；截止：Phase 0 验收前）；Phase 1 增加「后端裁定」：未就绪则 Phase 1 改为 Veo fast，Seedance 顺延 Phase 3；Ark adapter endpoint host 参数化；映射表凭据行区分两平台 env 名；风险 14 与权衡记录。
- [blocker] €50/月项目硬顶覆盖 VM、调度器与 Veo，预算门未覆盖，无 billing 解除恢复流程 → 已修正：新增 GCP 项目级月度余量门（估算计入 Veo 费用与按 Spot 1.55 USD/h × 批准时间窗的 VM 小时；`availableBudgetMicros` 由操作者按 €50 减固定支出维护并记录 maintainedBy / asOf；GPU VM 启停为独立审批点并绑定时间窗；bulk 前必须决策提高硬顶或迁移独立项目）；tariff 注明不覆盖 VM 小时；§7 增加 billing 解除恢复流程与 Spot 抢占处理；风险 15 记录抵扣金状态未核实。
- [blocker] H3 必须走 production-gateway 且 stage kernel 与 ComfyUI 同一文件系统，gateway 拓扑未定 → 已修正：明确双实例拓扑（实例 A 常驻 writing-loop-sg 服务云后端与 ingest；实例 B 随 GPU VM 与 ComfyUI 同机，objects 目录本地可见；ingest 经 GPU VM 上的 TLS 代理 + bearer 访问 /view），runtime config backends[] / stagingProfiles[] 按后端使用不同 baseUrl；承接链跨实例 CAS 取回；Phase 4 前置交付实例 B 的 systemd 服务单元与 TLS 代理；权衡记录替代方案（远端上传模式）不采用。
- [blocker] 「第一条视频最短路径」隐藏六项前提；已验证 Veo 资产使 Veo-first 更短 → 已修正：控制面固定为服务器 workspace（plan / confirm / qc / handoff 经 ssh 执行，worker systemd timer ≤6 h，handoff rsync 回本机）；Phase 0 / 1 把六项前提（gateway 进程、TLS、主机、账户、账本位置、worker 调度）逐项列入交付与前置；Phase 1 增加后端裁定（Veo fast 替代路径约 0.40 USD）；Phase 1 真实任务直接产出 9:16 并保留为 Phase 2 输入；权衡记录。
- [major] Veo 固定 gcs 模式引入 bucket / IAM / 区域前提，ADC 在 writing-loop-sg 不可用，音频探针错配 → 已修正：Veo execution 增 `ioMode: inline-base64 | gcs`（v1 inline）；写明 inline 模式实现（bytesBase64Encoded 输入 ≤20 MB、base64 输出写入 gateway spool、响应上限按 8 s 720p 约 10–15 MB），gcs 为可选并附核实项；outputModes 增 `inline-base64`、outputRetention 增 `inline-spool`；凭据行写明 google-adc 在该主机不可用、v1 用 veo-m2m.json 0600；Phase 3 `allowedProcessingRegions` 加 US；音频探针按 GA 与 fast 各跑一条并记录 operation name，2026-08-07 样本不作为证据；风险 2 / 16 记录 LRO 保留期与 SA 换绑待办。
- [major] Phase 4 前置未列（Spot 创建、配额、权重 sha256 清单、live 探针顺序） → 已修正：Phase 0 并行前置增加零新代码的 live `/prompt` 探针（`ssh -L` + curl 或 VCS client），Phase 4 前置列出 Spot 创建脚本与抢占重启流程、按需配额为 0 无回退、服务与地域门、权重 sha256 清单导出到 modelBundle attestation、实例 B 服务单元；errorSummary 与 §7 增加 `provider_failed:preempted`（实例 B 重启后对持久 job record 中不在 /history 的任务改写）；每个 H3 批次绑定 VM 时间窗；Phase 4 验收增加模拟抢占用例；风险 7 改写。
- [major] 人工审批缺总表，候选图批准无 CLI，VM 启停无审批，worker 定时无交付 → 已修正：新增审批点总表（候选图批准 → GCP 余量与 VM 时间窗 → plan-shots --confirm → sample → qc → VCS proposal → publish，含责任人与落地位置）；Phase 0 新增 `visual approve-candidate --candidate --by` 子命令；worker systemd timer + EnvironmentFile(0600) 列为 Phase 1 交付。
- [major] Blender 单飞使 approved-candidate 链路为人工串行且无静态图后端，v1 关键帧来源未声明 → 已修正：非目标与关键帧来源段写明 v1 关键帧来源仅 previous-shot-last-frame / previous-episode-end / operator-upload，approved-candidate 为并行人工轨道（按场景 × 机位 × 灯光排期，以 S01 候选图批准单独验收，不阻塞任何 Phase），静态图后端列为后续可选；`KeyframeInput` 注释同步；Phase 0 并行前置启动候选图轨道；风险 8 改写。
- [major] Phase 2 依赖 Phase 1 的 9:16 takes、本机 VCS 环境与私网资产传输通道 → 已修正：Phase 1 真实任务改为 9:16 并保留为 Phase 2 输入；Phase 2 增加前置（1-1 新批次约 3 USD、本机 VCS 依赖、服务器导出后 rsync）；部署拓扑写明本机 worker 不直达私网 gateway。
- [minor] H3 许可地域与 written-license 申请未列前置 → 已处理：Phase 4 前置增加确定 useTerritories / deploymentTerritories，含 US / EU / GB / KR 时先在 platform.minimax.io/h3-license 申请并写入 intent license evidence；风险 17 记录。
- [minor] Phase 0 验收「script-lint 预填 draft 通过解析」依赖剧本不存在的字段 → 已处理：非目标注明 `camera` 字段由人工在 Phase 0 手填、script-lint 只预填可推导字段；Phase 0 验收改为「预填 draft + 人工补齐 camera 字段后通过解析与编译（t2v 模式）」。

### 10.4 未质疑内容

- 修正清单 F1–F13、ShotRequest 类型主体、errorSummary 词表、cost basis 定义、定妆参考 / 灯光陈设 / 站位群演三段、VCS 流水线表、VCS 改动清单大部分条目、风险 4 / 5 / 9 / 12 / 13、原有权衡全部保留；仅对被质疑的行号与表述做更正或补充。

## 11. v2 修订记录（2026-08-28）

依据操作者的 9 项决策与 4 处内部一致性裁决修订；v1 存档为同目录 `DESIGN.v1.md`。

| 序 | 决策 / 裁决 | 改动的章节 |
|---|---|---|
| 决策 1 | 第一阶段只做私有部署的 MiniMax H3 over ComfyUI；Seedance 与 Veo 的 adapter 保留在接口设计中，实现顺序后置 | §1（结论摘要 1–4 条重写）；§3（当前就绪状态行）；§4.0（数据流的 adapter 分支）；§5.1 / §5.2 / §5.3（各增实现顺序说明）；§8.1–§8.5（Phase 重排为 H3 → VCS → Seedance → Veo）；§9.1（风险按阶段重排）；§9.4（权衡新增一行，删除后端裁定行） |
| 决策 2 | 不使用 TLS，改为 VPC 私网明文 HTTP + bearer，新增 owner-only 的 `transport: "insecure-private-http"` | §4.0（数据流标注）；§8.0（传输方式、校验规则表、威胁模型与适用条件、拓扑表）；§8.1（Phase 0 交付与 runtime config 解析验收）；§8.2（Phase 1 部署与验收）；§8.6（`production-runtime-config.ts` 行）；§9.1（第 6 项）；§9.3（VPC 隔离前提）；§9.4（新增权衡行，改写云后端 kind 行） |
| 决策 3 | 删除 GCP 项目级月度余量门与 `vmWindow` 审批点，`availableBudgetMicros` 取常量，保留 per-intent reservation | §4.6（tariff 定义）；§4.7（plan 文档字段、gate context、审批点总表由 7 行减为 6 行、月度余量门整段改写为项目级预算门）；§5.3（删除 VM 时间窗行、改写成本行）；§8.6（runtime config 行）；§9.1（删除原第 15 项）；§9.3（删除抵扣金行）；§9.4（tariff 行，新增预算门权衡行） |
| 决策 4 | 本版只做中文，`dialogue[].language` 与 prompt 语言固定 `zh-CN`，删除英文译文供给步骤 | §4.0（非目标）；§4.1（prompt 类型注释、dialogue 字段行、draft 描述、prompt 语言编译规则）；§5.2（prompt 行）；§6.1（draft 字段表两行）；§8.5（Phase 4 前提为外语项目立项）；§9.4（Veo 译文权衡行） |
| 决策 5 | 镜头合并采用 `stageGroup` 内合并，判定条件写入正文规则 | §6.1（新增合并规则段与判定条件表、合并结果定义）；§4.1（`provenance.mergedScriptLines` 字段与字段来源行）；§8.1（Phase 0 交付与验收用例）；§8.3（Phase 2 前提按合并规则确定镜头数）；§9.1（删除原第 9 项镜头粒度）；§9.4（新增合并规则权衡行） |
| 决策 6 | H3 部署地为新加坡，`useTerritories` / `deploymentTerritories` 均为 `["SG"]`，无需书面许可 | §2.2（部署行）；§3（当前就绪状态行）；§5.3（许可行）；§8.2（Phase 1 前提）；§9.1（第 8 项） |
| 决策 7 | `safety_identifier` 的对账用法随 Seedance 后置 | §5.1（`remoteJobId` 行）；§7（对账段）；§8.4（Phase 3 前提与验收）；§9.1（第 12 项）；§9.3（核实阶段改为 Phase 3 前） |
| 决策 8 | 英文译文由写作侧 agent 供给，本版不做 | §4.0（非目标）；§4.1（draft 描述与 prompt 类型注释）；§8.5（Phase 4 交付与前提） |
| 决策 9 | `availableBudgetMicros` 本版不需要人工维护 | §4.7（项目级预算门第 1 条）；§8.6（runtime config 行删除 `maintainedBy / asOf`） |
| 裁决 a | execution profile 与价目文件由 gateway 的 server-owned registry 持有，worker 侧只引用 `profileId` 与 digest，`plan-shots` 估算读取 gateway 导出的只读 profile 快照文件 | §4.2（digest 表 workflowSha256 行、新增 profile 归属段）；§4.7（估算行）；§8.1（Phase 0 交付新增 `executionProfileSnapshotFile`）；§8.2（Phase 1 交付新增快照导出）；§8.6（runtime config 行） |
| 裁决 b | Seedance 的 `seed` 在编译层为 error，删除 `seed_rejected` 的 warning 语义 | §4.1（新增 seed 编译规则、错误码表）；§4.2（seedance 逐镜约束）；§5.1（`output.seed` 行）；§8.1（Phase 0 验收） |
| 裁决 c | `ShotRequest.output` 只保留 `aspectRatio` 与 `generateAudio` 作为请求意图并与 execution profile 校验一致，移除 `resolutionClass`，画幅枚举以 ShotRequest 的集合为准 | §4.1（`output` 类型、字段来源行、新增输出意图编译规则、错误码 `output_intent_mismatch`、时长规则改引 profile 的 resolution）；§4.2（seedance execution 画幅枚举与逐镜约束）；§5.1（`execution.aspectRatio` 行）；§6.1（draft 字段表 output 行）；§8.1（Phase 0 验收） |
| 裁决 d | 删除三个无触发规则的 Degradation code | §4.1（`Degradation` 类型删除 `reference-video-dropped`、`reference-audio-dropped`、`native-audio-off-post-dub`）；§5.2（视频 / 音频参考裁剪统一记 `references-trimmed`） |
| 结构 | 删除已决策事项清单；新增本节 | 删除原 §9.5「需决策事项」（9 项全部已决策，见 §1 的已决策事项表）；新增 §11 |

新增的编译错误码：`output_intent_mismatch`（输出意图与 execution profile 不一致）、`negative_prompt_unsupported`（H3 契约无 negative 输入）。`seed_rejected` 由 warning 改为 error。

因 Phase 重排产生的两处设计后果，记录在此：H3 graph 契约 v2（`generator.prompt` 与 `RandomNoise.noise_seed` 为 sentinel）由原 Phase 4 提前到 Phase 1，理由是逐镜 prompt 与 seed 在契约 v1 下需要逐镜 pinned graph 与 config 条目，无法承载批量镜头，且 ShotRequest 作为 `inputs[0]` 的设计依赖 stage 契约 v2 的 `shot-request` slot；H3 只支持 fl2va / ref2va，因此 Phase 0 与 Phase 1 的首条任务改为 fl2va，首帧以 `operator-upload` 提供（`approved-candidate` 候选图轨道为并行人工轨道，不阻塞）。
