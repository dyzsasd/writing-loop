# 视频生产管线执行计划与进度台账

状态日期：2026-08-31 ｜ 规格：同目录 `DESIGN.md`（v2，2026-08-28 落 9 项操作者决策）｜ v1 存档 `DESIGN.v1.md` ｜ 调研地图 `RESEARCH-MAPS.md`

原则（操作者 2026-08-28 裁定）：GPU VM（Spot g4-standard-48，镜像 `wl-comfy-h3-g4-sg`）按时计价，视频生成之前的全部工作先完成，最后一次开机完成探针与首条任务。本版唯一执行后端为 MiniMax H3 over ComfyUI；Seedance 待 BytePlus 账户（Phase 3），Veo 归后续外语项目（Phase 4）。

## 进度总表

| # | 工作项 | 规格出处 | 状态 | 位置 |
|---|---|---|---|---|
| 0-A | runtime config `transport: "insecure-private-http"` + cost basis（`tariff` / `reported-converted` + `settlement`）+ `settleQcBudget` 释放条件 + `ProductionCostSummary.byBasis` | §8.1、§4.6 | 已实现，测试全绿（2058 PASS），**未提交、待审查合并** | worktree `~/workspace/jinko/wt/writing-loop-phase0-a`（分支 `phase0-a-transport-cost`） |
| 0-B | `production-shot-request.ts`：类型、严格解析、`deriveVideoMode`、`compileShotRequest`（H3 实现路径；seedance / veo 校验层）、`shotRequestFromScript`、`mergeShots` | §4.1、§6 | 已实现，105 条用例，全链 2128 PASS，**未提交、待审查** | 本仓库主工作树（untracked 新文件 + package.json 测试链） |
| 0-C | intent 枚举、云 execution 解析分支、三个新 gate、license `obligations`、`inputs[0]` 检查 | §4.2、§8.6 | 未开始（依赖 0-A、0-B 合并） | `hub/src/production-intent.ts` |
| 0-D | `ProductionProviderAdapter` 接口、capability / locator 联合类型、`ComfyUiAdapter` 包装、coordinator 家族表 | §4.4、§8.6 | 未开始 | `hub/src/production-adapter.ts` 等 |
| 0-E | CLI `production plan-shots / qc`、`visual approve-candidate`；`visual/production.v1.json` 增 `shotIds` / `subjectReferences[]`；`mappings.v1.json`、`prop-states.v1.json` schema | §4.7、§8.6 | 未开始 | `hub/src/cli.ts` 等 |
| 0-F | 文档同步（AI-SPEC fixture、config-schema、visual-production-schema） | §8.6 | 未开始（0-A 已顺带同步其涉及的两处） | `docs/`、`references/` |
| 1 | gateway 进程装配（`production-gateway-main.ts`、server-owned registry）、H3 graph 契约 v2（prompt / seed sentinel + `shot-request` slot）、stage `slotPolicy` 与 `cas://` resolver、ingest ffmpeg 尾帧、部署脚本与 systemd 单元 | §8.2 | 未开始；全部可用 fake-port 测试零 GPU 验证 | `hub/src/production-gateway-*.ts` 等 |
| VCS | `pipeline_defs/scripted-drama.yaml`、handoff v2 schema、`import_handoff.py`、`publish_check.py`、四个 artifact schema 扩展、契约测试 12 条 | §4.8、§8.3 | 已实现，576 PASS（contracts）/ 941 PASS（全量），**未提交** | `~/workspace/citronetic/video-creation-studio` 主工作树 |
| SRV | writing-loop-sg 前提：ffmpeg 已装（6.1.1）；根盘扩容（现 29G 仅约 6G 可用）；剧本仓库回同步（服务器领先本地 1 提交 8d90231） | §8.0 | ffmpeg 完成；扩容与回同步待 gcloud 登录 | writing-loop-sg |
| NAR | 叙事侧数据：EP001 场 1-1 draft（`shotRequestFromScript` 预填 + 人工补 `camera`）、`mappings.v1.json`、`prop-states.v1.json`、首帧素材（S01 Blender EEVEE 渲染，`operator-upload` 入 CAS） | §6、§8.2 前提 | 未开始（依赖 0-B、0-E） | `~/dramas/yujing-jiushi` |
| GPU | 最后一次开机：创建 Spot G4 → 镜像内服务与地域门启用 → `/object_info` 节点 schema 核对 → 权重 sha256 导出入 `h3GraphContract` → gateway 部署 → 首条 fl2va 全链路（plan → confirm → worker --once → qc → handoff）→ 模拟抢占用例 → 停机 | §8.2 验收 | 未开始；脚本草案在会话 scratchpad `h3-vm.sh` | GCP asia-southeast1 |

合并顺序：0-A（worktree 分支合入 main）→ 0-B → 0-C → 0-D → 0-E → 0-F → Phase 1 → VCS 侧提交（独立仓库，可先行）。每片经 reviewer 审查、`npm run typecheck && npm test` 全绿后提交。

## 实现层遗留判定（实现者报告，待裁定或按计划归入后续切片）

0-A：
1. `transport: "insecure-private-http"` 当前只在解析层成立；装配层 `createProductionRuntimeRegistry` 的三个客户端（`production-ingestor.ts`、`production-input-stager.ts`、`ProductionGatewayAdapter`）URL 策略未接 transport，配置会以 invalid-config 被拒。**归入 Phase 1**（这三个文件本就在 Phase 1 改动清单内）。
2. `settlement` 按设计为必填、值可为 null：旧 cost 记录解析后多出 `settlement: null` 一键，带 cost 事件的 payloadDigest 随之变化（接受/拒绝结论与既有字段逐字不变）。按设计类型保留，不改。
3. `kind: comfyui` 拒绝 `transport` 走 exactKeys 未知字段路径，无定向错误措辞。接受现状。

0-B（10 项，编号对应实现报告）：seedance / veo 编译不产出 intentDraft（等 0-C 的 execution 分支）；veo 1080p/4k + 非 8 s 取拒绝语义而非静默上取整；draft 无 `output.durationSeconds` 与 `continuity.fingerprint`（编译产物不进 draft）；capability 类型暂定义在新文件、待 0-D 合并进 `production-adapter.ts`；license `obligations` 暂挂 `ShotExecutionProfile`、待 0-C 移入 `ProductionLicenseEvidence`；H3 `inputs[0]` 已按契约 v2 形态构造（v2 随 Phase 1 落地）；`nativeAudio unsupported + generateAudio:true` 复用 `output_intent_mismatch`；参考顺序保持 draft 原序（purpose 只决定裁剪）；`unsupported_operation`（t2v）与 `unsupported_continuity_mode`（其余）分工；`scene.subscene` 兼容无「·」的余段。

VCS（10 项）：handoff 摘要经 `--expect-digest` 传入（由 writing-loop `production handoff` 输出提供）；`version: 2`、`pipeline: "scripted-drama"`；`delivery.aspectRatio` 保留三值（无 21:9）；proposal `produces` 为 `[proposal_packet, decision_log]`；compose / publish 复用 cinematic 的 director；`publish_log` 增顶层 `attribution[]`；署名义务按 license 文本命中标记判定；输入资产不填 `license` / `provider` 字段；edit 草稿落 `edit_decisions.draft.json`（由 edit-director 补完后再写检查点）；`storyboardDurationSeconds > durationSeconds` 时出点收敛到实际时长并记 reason。
**对齐要求**：writing-loop 侧实现 `production-studio-handoff.ts` 契约 v2 与 `handoff --export-dir`（0-E / Phase 1）时，须逐字段对齐 `schemas/handoff/writing-loop-handoff.v2.schema.json`（VCS 先行落地），差异回改以 VCS schema 为准还是以 writing-loop 为准由操作者裁定。

## 操作者待办

- `gcloud auth login`（服务器扩盘与 GPU 会话的前提）。
- S01 候选图批准轨道（Blender 渲染 → `visual approve-candidate`，0-E 交付后可执行；首帧素材可先以 `operator-upload` 绕过）。
- VCS 仓库的提交（独立 git 仓库，本仓库流程不覆盖它）。
