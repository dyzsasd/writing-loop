# writing-loop × dev-loop parity 路线

> 状态：Phase 1、Phase 2 与 Phase 3B 可恢复制片协调内核已实现；私有 gateway/对象存储部署、
> H3/ComfyUI 真实执行配置及 Phase 4 自动短剧发布闭环尚未实现。本文件定义“能力对齐”，
> 不要求复制软件开发界面或开发领域语义。

## 产品裁决

writing-loop 保留三条不可破坏的领域约束：

1. 一个 workspace 可容纳多部剧。
2. 一个 `projects.<key>` 就是一部剧，`repoPath` 永远指向它唯一的正文主仓库。
3. 看板、运行状态、报告在 `.writing-loop/<key>/`；剧本正文与剧情资产在 Git repo。

因此不会为了表面模仿 dev-loop，在 project 下再造一层 `scripts[]`，也不会把 Ticket、PR、
build/deploy 等软件术语搬进编剧界面。UI 的一级对象是作品、分集、故事资产、创作任务、
审读门、操作者决定与编剧 Agent。

## 已交付：Phase 1 · 可观测编剧室

| dev-loop 能力 | writing-loop 的领域化实现 | 状态 |
|---|---|---|
| 多项目首页 | 作品书架：题材/形态、梗概、分集前沿、开放任务、人工停靠、最近活动 | 完成 |
| 项目工作台 | 故事脊柱、四条创作泳道、最近分集、剧情资产、等待决定、编剧室 | 完成 |
| 实时刷新 | snapshot fingerprint + SSE；输入控件聚焦时延迟刷新 | 完成 |
| 进程监控 | `run-state.json` 暴露 scheduler 与每个 in-flight agent；结束保留 stopped 快照 | 完成（优于当前 dev-loop 历史 fire-only） |
| 机器接口 | `writing-loop snapshot` 与 `/api/snapshot` 共享稳定 DTO | 完成 |
| 项目操作 | `project list/enable/disable`；Studio 原子暂停/恢复；运行中禁用会触发 graceful drain | 完成 |
| 配置写安全 | 严格 key、O_EXCL 配置锁、temp + fsync + atomic rename、未知字段保留 | 完成 |
| 本地安全 | loopback bind、Host/Origin guard、CSP、body limit、SSE 上限 | 完成 |

启动：

```bash
writing-loop studio
writing-loop snapshot --project my-drama
writing-loop project disable my-drama
```

Studio 有意不提供“从网页启动 Agent”。当前 scheduler 会以高权限写剧本 repo；在没有独立
进程监管、明确授权和 stop/drain 协议前，把它接到 HTTP 写面会扩大安全边界。

## 已交付：Phase 2 · 持久历史与多工作区基础

| 能力 | 已实现边界 |
|---|---|
| 确定性立项 | CLI 与 Studio 共用 onboarding core：完整输入先生成**零写入** plan；`planId` 绑定规范化输入、解析后路径、config 内容、模板与实现版本。只有操作者回传同一指纹才 create；create 会重算计划、拒绝漂移，并在成功前执行写后 verify。 |
| 崩溃恢复 | core 先用原子 `mkdir` 预留 final repo/data 名称，再在 `.writing-loop/.onboarding-transactions/<key>.json` 下创建。journal 继续使用 prepared → repo-staged → data-staged → repo-promoted → data-promoted 兼容标签，但 promoted 只是完整性检查点，不再表示 staging rename。完整 commit/manifest 已落盘时，config 发布前崩溃可由**同一规范化输入 + 原 `planId`**重试续跑；摘要前半成品原样保留并硬停。config atomic replace 仍是项目可见性提交，发布后的同 plan 重试由 receipt 幂等回读。 |
| CLI / Studio | `project plan --input`、`project create --input --confirm`、`project verify`；Studio 提供 attended interview → plan 审阅 → 指纹确认 → create。新项目一次发布 scaffold Git repo、config 条目、运行态目录与首张大纲票。 |
| 按需详情 | 服务端 registry 只开放 `ticket` / `document` / `episode` / `report` / `evaluation` 五类已登记 Markdown；详情不塞进 workspace snapshot，不接受客户端文件路径。 |
| Workspace identity / registry | 每个 workspace 自持严格 v1 的 `.writing-loop/workspace.json` 稳定随机 ID；`$WRITING_LOOP_HOME/workspaces.json` 是最多 128 条的非权威本机指针表。`workspace list/add/remove` 显式管理，移动仅在旧 root 消失时自愈，两个现存副本同 ID 硬停。普通 CLI 根解析仍只看 CWD / `WRITING_LOOP_WORKSPACE`。 |
| 多工作区 Studio | 多个登记项触发 fleet 首页，missing/invalid root 在卡片上降级隔离；workspace 全部 HTML/API/SSE/写操作进入 `/w/:workspace-id/…`。unscoped GET 重定向到显式选定 workspace，unscoped POST 拒绝；一个 workspace 或 `--single` 保留旧 URL。`--workspace ID` 可从 registry 明确选择健康条目。 |
| 创作历史 | `ActivityIndexer` v2 把项目事件、fire、票评论/状态和工件观测持久为可重建 cache。metadata signature 避免无变化深扫；generation/revision 与 workspace/project-bound `before` cursor 支持稳定分页。首次窗口、retention 与损坏重建缺口全部显式 warning；旧文件 mtime 只称 `snapshot-only`。 |
| 跨重启实时刷新 | workspace/fleet 各自的 SSE event ID 聚合稳定 snapshot 与持久 activity revision。标准 `id:` + `Last-Event-ID` 可在 Studio 进程重启后恢复；相同 cursor 不重复 data，跨 workspace/fleet 或 malformed cursor 硬拒绝。SSE 仍是变更通知，不是无限历史流。 |
| 实时与用量 | `run-state.json` 作为 in-flight live overlay；provider/model/可证实时长按账本展示。现有账本没有 token/账单字段时，token usage 与 cost 明确返回 `unknown:not-recorded`，绝不估算。 |

可捕获异常会逆序回滚且只删除带本事务所有权证明的产物；真实崩溃保留 journal 与标记，
由操作者重跑原 create 才恢复，并不是后台 worker。活跃/复用 PID、config/templates/实现版本
漂移、marker/journal 被改、repo 不再是干净单 commit、final/旧 staging 歧义都会保守硬停，要求人工
审计而不是猜测接管。若崩溃发生在 config 已发布、清理尚未完成的窗口，receipt 保证业务重试
幂等，但残留 journal/config lock 可能仍需 doctor 辅助下人工清理。自动立项仍只支持尚不存在
的新 repo。data manifest 覆盖排序后的相对路径、目录/文件类型与完整文件内容；修改、额外项、
symlink/特殊文件均拒绝。若崩溃落在摘要持久化之前，已预留 final 中的未完成树原样保留供人工审计，
不会被恢复流程删除或重建。

## 当前数据流

```text
workspace.json ─> stable workspace ID ─┐
$WRITING_LOOP_HOME/workspaces.json ────┼─> fleet catalog ─> /w/:id namespace
                                       │
config.json ───────────────┐            │
board/tickets/*.md ────────┤            │
script repo ───────────────┼─> ActivityIndexer v2 cache + snapshot / detail registry
events.jsonl + fires.jsonl ─┤                         ├> CLI / scoped JSON API
run-state.json + lock ─────┘                         ├> Studio HTML + live overlay
                                                     └> scoped SSE id + Last-Event-ID

Studio / add-script / CLI interview
        └─> onboarding plan（零写）─> 指纹确认 ─> journaled create ─> verify

Studio pause/resume ─> workspace-store ─> config lock ─> atomic config replacement
```

`project-read-model`、`project-detail` 与 `ActivityIndexer` 组成磁盘协议的只读边界，并复用唯一的
Ticket frontmatter 解析器。HTML、JSON 和未来桌面/云壳都不能各自再写一套 Markdown 解析。
Activity index 是可删除重建的读缓存，不提升为新真相源；`run-state` live overlay 也不落入历史。
identity/registry/index 采用互不混用的 O_EXCL 锁，安全有界读、随机临时文件、fsync + atomic
rename；symlink、hardlink 与特殊文件会被拒绝。详情读取另以 fd/path identity 封住
validate→open 竞争窗。
同权限本机进程若在一次摘要扫描期间恶意执行目录 ABA 交换不属于 Studio 的隔离边界——它本就
能直接读取这些文件；Studio 是 loopback 操作者观测面，不是针对同 UID 对手的文件沙箱。

## Phase 2 完成边界与后续缺口

Phase 2 的**基础目标**已经完成：确定性/可恢复立项、白名单详情、持久有界创作历史、跨进程
SSE 恢复、稳定 workspace identity、本机 registry 和隔离的 multi-workspace Studio。这里的
“完成”不等于无限 event sourcing：首次索引受源扫描窗口约束，retention 会淘汰旧事件，二者均
必须显式告警；SSE cursor 只说明某作用域读模型是否变化，不是账本 offset。

仍待后续阶段解决：

- **完整写作指标与真实成本采集**：补分集吞吐、审读退回率、停靠时长、钩型/角色/场景覆盖；
  provider 账本真正记录 token/账单后才能显示成本，缺数据仍是 `unknown`。
- **调度器进程管理写面**：Studio 仍不从 HTTP 启动高权限 Agent；start/stop/drain 要在独立
  监管、授权与孤儿恢复协议完成后再开放。
- **关联制作资源与自动制片**：见 Phase 3/4。当前已有受信任依赖注入的 `runOnce()` coordinator、
  私有资产 ingestor port 与 approved-take Studio handoff，但尚无 CLI/浏览器远程启动面、MiniMax H3
  推理部署、真实 gateway/对象存储或经验证的 Studio 可写 API。

## Phase 3 · writing 场景的 multi-repo

正文 repo 仍唯一；“多 repo”改造成**关联制作资源**而不是多代码仓：

- `story`：现有 `repoPath`，唯一可被编剧 Agent 写入的正文主仓。
- `assets`：角色定妆、场景、声音与 LoRA/参考图资产库。
- `production`：分镜、镜头 manifest、视频 takes、剪辑与 QC 工件。
- `automation`：ComfyUI workflow 与模型部署配置，默认只读或由专门制片 Agent 写。
- `sources`：原著、市场材料、版权授权范围，通常只读。

后续配置会采用“workspace 物理资源 registry + project 引用”的形式；共享资源必须有唯一 owner，
路径用最近祖先匹配且歧义时硬错。这个 schema 在迁移器与 doctor 就绪前不会提前写入正式配置。

## Phase 4 · 自动短剧制片桥

```text
writing-loop
  分集定稿 + production ledger
       │ export episode package
       v
shot manifest / continuity pack
       │
       ├─> ComfyUI：角色/场景参考资产与可复现 workflow
       ├─> MiniMax H3：T2VA / FL2VA / reference-to-video takes
       └─> video-creation-studio：审批、版本、合成、字幕、QC、成本与发布包
```

桥接协议以不可变 episode revision、shot ID、角色/场景 token、first/last frame、参考音视频、
seed/model/workflow fingerprint、take、成本和审批状态为核心。视频生成失败只回写制片任务，不能
静默改动已定稿剧本；需要改剧本时必须重新进入 writing-loop 的 ticket/review gate。

### Phase 3A + 3B 已交付边界

Phase 3A 已落下严格 versioned revision/AssetRef/task/approval 契约、每项目原子
`production-state.v1.json`、纯 reducer、只读 CLI/Studio 流水线及保守的 ComfyUI adapter。Phase 3B
在此之上加入不可变 intent、rights/moderation/license/budget 门禁、精确 prepare→落盘→单次提交、
项目级 lease 与 `production-control.v1.json`、纯 observation decision、幂等私有 ingestor、control
只读投影，以及只含人工 approved take 的 Studio handoff。重启后的 `submitting` 只 inspect，绝不
重 POST；浏览器仍不接触 endpoint 或凭据。

这仍不等于 Phase 3/4 完成：关联资源 registry、私有 gateway/对象存储的真实部署、后台 runner、
H3/ComfyUI 固定 workflow/model 配置、真实账单采集与经验证的 Studio 合成写回仍是后续阶段。
完整协议与门禁见 [`phase-3-remote-production/AI-SPEC.md`](phase-3-remote-production/AI-SPEC.md)。

## 完成 parity 的验收定义

当操作者能够在一个界面中安全完成以下闭环，才称为 parity，而不是“有一个看板页面”：

1. 选择/创建 workspace，完整立项一部剧并验证三处真相一致。
2. 浏览所有剧、剧情资产、创作任务、历史活动、用量与正在运行的 Agent。
3. 安全暂停、恢复、启动、drain 与诊断调度器，不留下孤儿进程。
4. 管理正文主仓和关联资产/制片资源，迁移后仍能自愈路径索引。
5. 从已定稿分集导出版本化制片包，经 ComfyUI/H3/Studio 产出 takes，并把审批/QC 结果关联回原集。
