# 视频生产管线执行计划与进度台账

状态日期：2026-08-31 ｜ 规格：同目录 `DESIGN.md`（v2，2026-08-28 落 9 项操作者决策）｜ v1 存档 `DESIGN.v1.md` ｜ 调研地图 `RESEARCH-MAPS.md`

原则（操作者 2026-08-28 裁定）：GPU VM（Spot g4-standard-48，镜像 `wl-comfy-h3-g4-sg`）按时计价，视频生成之前的全部工作先完成，最后一次开机完成探针与首条任务。本版唯一执行后端为 MiniMax H3 over ComfyUI；Seedance 待 BytePlus 账户（Phase 3），Veo 归后续外语项目（Phase 4）。

## 进度总表

| # | 工作项 | 规格出处 | 状态 | 位置 |
|---|---|---|---|---|
| 0-A | runtime config `transport: "insecure-private-http"` + cost basis（`tariff` / `reported-converted` + `settlement`）+ `settleQcBudget` 释放条件 + `ProductionCostSummary.byBasis` | §8.1、§4.6 | **已合并** main `1b58ee6`（2026-09-02；reviewer 1 major + 3 minor 已修，2067 PASS） | `hub/src/production-{runtime-config,domain,coordinator,read-model}.ts`、`hub/test/production-cost.ts` |
| 0-B | `production-shot-request.ts`：类型、严格解析、`deriveVideoMode`、`compileShotRequest`（H3 实现路径；seedance / veo 校验层）、`shotRequestFromScript`、`mergeShots`、`selectH3ProfileForDuration` | §4.1、§6 | **已合并**（2026-09-02；reviewer + codex 审查 8 major + 12 minor + 3 项裁定全部修复，154 用例，全链 2222 PASS） | `hub/src/production-shot-request.ts`、`hub/src/script-lint.ts`（只增导出 `sceneAnnotationLines`）、`hub/test/production-shot-request.ts` |
| 0-C | intent 枚举、云 execution 解析分支、三个新 gate、license `obligations`、`inputs[0]` 检查 | §4.2、§8.6 | 未开始（依赖 0-A、0-B 合并） | `hub/src/production-intent.ts` |
| 0-D | `ProductionProviderAdapter` 接口、capability / locator 联合类型、`ComfyUiAdapter` 包装、coordinator 家族表 | §4.4、§8.6 | 未开始 | `hub/src/production-adapter.ts` 等 |
| 0-E | CLI `production plan-shots / qc`、`visual approve-candidate`；`visual/production.v1.json` 增 `shotIds` / `subjectReferences[]`；`mappings.v1.json`、`prop-states.v1.json` schema | §4.7、§8.6 | 未开始 | `hub/src/cli.ts` 等 |
| 0-F | 文档同步（AI-SPEC fixture、config-schema、visual-production-schema） | §8.6 | 未开始（0-A 已顺带同步其涉及的两处） | `docs/`、`references/` |
| 1 | gateway 进程装配（`production-gateway-main.ts`、server-owned registry）、H3 graph 契约 v2（prompt / seed sentinel + `shot-request` slot）、stage `slotPolicy` 与 `cas://` resolver、ingest ffmpeg 尾帧、部署脚本与 systemd 单元 | §8.2 | 未开始；全部可用 fake-port 测试零 GPU 验证 | `hub/src/production-gateway-*.ts` 等 |
| VCS | `pipeline_defs/scripted-drama.yaml`、handoff v2 schema、`import_handoff.py`、`publish_check.py`、四个 artifact schema 扩展、契约测试 12 条 | §4.8、§8.3 | 已实现，576 PASS（contracts）/ 941 PASS（全量），**未提交** | `~/workspace/citronetic/video-creation-studio` 主工作树 |
| SRV | writing-loop-sg 前提：ffmpeg 6.1.1；根盘 30 → 100 GB（在线扩容，现 74 GB 可用）；剧本仓库与账本回同步到 8d90231；VPC `default-allow-internal`（10.128.0.0/9）覆盖 writing-loop-sg（10.148.0.5）与 GPU VM 之间的私网 HTTP，无需新增防火墙规则 | §8.0 | 2026-09-02 全部完成 | writing-loop-sg |
| NAR | 叙事侧数据：EP001 场 1-1 draft（`shotRequestFromScript` 预填 + 人工补 `camera`）、`mappings.v1.json`、`prop-states.v1.json`、首帧素材（S01 Blender EEVEE 渲染，`operator-upload` 入 CAS） | §6、§8.2 前提 | 未开始（依赖 0-B、0-E） | `~/dramas/yujing-jiushi` |
| GPU | 最后一次开机：创建 Spot G4 → 镜像内服务与地域门启用 → `/object_info` 节点 schema 核对 → 权重 sha256 导出入 `h3GraphContract` → gateway 部署 → 首条 fl2va 全链路（plan → confirm → worker --once → qc → handoff）→ 模拟抢占用例 → 停机 | §8.2 验收 | 未开始；脚本草案在会话 scratchpad `h3-vm.sh` | GCP asia-southeast1 |

合并顺序：0-A（worktree 分支合入 main）→ 0-B → 0-C → 0-D → 0-E → 0-F → Phase 1 → VCS 侧提交（独立仓库，可先行）。每片经 reviewer 审查、`npm run typecheck && npm test` 全绿后提交。

## 实现层遗留判定（实现者报告，待裁定或按计划归入后续切片）

0-A：
1. `transport: "insecure-private-http"` 当前只在解析层成立；装配层 `createProductionRuntimeRegistry` 的三个客户端（`production-ingestor.ts`、`production-input-stager.ts`、`ProductionGatewayAdapter`）URL 策略未接 transport，配置会以 invalid-config 被拒。**归入 Phase 1**（这三个文件本就在 Phase 1 改动清单内）。
2. `settlement` 按设计为必填、值可为 null：旧 cost 记录解析后多出 `settlement: null` 一键，带 cost 事件的 payloadDigest 随之变化（接受/拒绝结论与既有字段逐字不变）。按设计类型保留，不改。
3. `kind: comfyui` 拒绝 `transport` 走 exactKeys 未知字段路径，无定向错误措辞。接受现状。
4. 审查（2026-09-02）裁定：`settlement.rateMicrosPerUnit` = 1 单位原币折合的 USD micros，`amountMicros = round_half_up(nativeAmountMicros × rate / 1e6)`，解析器精确校验（已要求实现者补入）。Studio 表层是否展示 cost basis（`studio-view.ts` 现只显示「实际 $X」）归 0-E / 0-F 裁定；`executionProfileSnapshotFile` 的读取归 0-E（`plan-shots` 估算）。装配层三处 URL 策略未接 transport 的拒绝当前无测试钉住，Phase 1 接入时先补失败用例。

0-B 审查修复后的 6 项实现判断（2026-09-02）：`ShotRequestDraft.prompt.text` 在写作侧撰写前为 null（预填不再复制动作行；`compileShotRequest` 遇 null 抛装配错误，与 `camera` 同级——**EP001 试点前需为每个合并后镜头撰写 prompt**，归 NAR）；输入资产重复以 sha256 为身份；execution profile 的 `aspectRatio` / `resolution` 类型为 string、取值由 `capability.limits` 判定；合并条件 4 实现为整个 `scene` 对象相等；阻断枚举值 `freeze-frame` 覆盖【画面定格】【插入闪回】【闪回结束】三个强制切分标注（`FORCED_SPLIT_TAGS`）；DESIGN §4.1 / §6.1 / §6.6 / §8.1 已随修复同步（provider 指令正则放宽为任意 `--flag`、序号正则三分支、合并条件 9「连续性输入不同」与 10「prompt / seed 不同」、ep-001 1-1 场内联 fixture 与 `WL_EP001_PATH`）。

0-B（10 项，编号对应实现报告）：seedance / veo 编译不产出 intentDraft（等 0-C 的 execution 分支）；veo 1080p/4k + 非 8 s 取拒绝语义而非静默上取整；draft 无 `output.durationSeconds` 与 `continuity.fingerprint`（编译产物不进 draft）；capability 类型暂定义在新文件、待 0-D 合并进 `production-adapter.ts`；license `obligations` 暂挂 `ShotExecutionProfile`、待 0-C 移入 `ProductionLicenseEvidence`；H3 `inputs[0]` 已按契约 v2 形态构造（v2 随 Phase 1 落地）；`nativeAudio unsupported + generateAudio:true` 复用 `output_intent_mismatch`；参考顺序保持 draft 原序（purpose 只决定裁剪）；`unsupported_operation`（t2v）与 `unsupported_continuity_mode`（其余）分工；`scene.subscene` 兼容无「·」的余段。

VCS（10 项）：handoff 摘要经 `--expect-digest` 传入（由 writing-loop `production handoff` 输出提供）；`version: 2`、`pipeline: "scripted-drama"`；`delivery.aspectRatio` 保留三值（无 21:9）；proposal `produces` 为 `[proposal_packet, decision_log]`；compose / publish 复用 cinematic 的 director；`publish_log` 增顶层 `attribution[]`；署名义务按 license 文本命中标记判定；输入资产不填 `license` / `provider` 字段；edit 草稿落 `edit_decisions.draft.json`（由 edit-director 补完后再写检查点）；`storyboardDurationSeconds > durationSeconds` 时出点收敛到实际时长并记 reason。
**对齐要求**：writing-loop 侧实现 `production-studio-handoff.ts` 契约 v2 与 `handoff --export-dir`（0-E / Phase 1）时，须逐字段对齐 `schemas/handoff/writing-loop-handoff.v2.schema.json`（VCS 先行落地），差异回改以 VCS schema 为准还是以 writing-loop 为准由操作者裁定。

## 操作者待办

- `gcloud auth login`（服务器扩盘与 GPU 会话的前提）。
- S01 候选图批准轨道（Blender 渲染 → `visual approve-candidate`，0-E 交付后可执行；首帧素材可先以 `operator-upload` 绕过）。
- VCS 仓库的提交（独立 git 仓库，本仓库流程不覆盖它）。
