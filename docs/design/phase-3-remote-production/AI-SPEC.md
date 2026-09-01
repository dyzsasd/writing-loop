# Phase 3C AI-SPEC：远程短剧制片可恢复 control plane 与私有 Gateway

状态：Phase 3A/3B 权威账本与 coordinator、Phase 3C enqueue/worker/runtime/scoped staging/job/output Gateway 安全内核已实现；真实 H3 推理、live ComfyUI `/prompt` 兼容性证明、Gateway 依赖组合与运维部署仍由部署方提供
目标版本：production state v1
适用范围：writing-loop Hub / Studio；ComfyUI 首个远程后端

## 1. 决策摘要

Phase 3A 建立可审计的本地制片状态与安全对账原语；Phase 3B 把这些原语组合成一次一项目、可重启
恢复的 coordinator 内核。它仍不在 writing-loop 进程里运行 GPU 模型，也不让浏览器直接访问
ComfyUI、MiniMax H3 或 video-creation-studio。

```text
Studio (loopback only)
        │ read model / bounded API
        v
writing-loop production control plane
  ├─ authoritative ProductionStore
  ├─ pure job reducer
  ├─ immutable intent + rights/license/budget gates
  ├─ project lease + crash-recovery control ledger
  └─ one-shot worker → coordinator → scoped Gateway adapter
        │ stable IDs + verified AssetRef
        v
private Gateway router
  ├─ scoped stage receipt / CAS
  ├─ durable intent→remote job proxy
  └─ scoped output ingest / AssetRef
        │ pinned server profiles + admission policy
        v
remote ComfyUI / H3
approved handoff → agent-driven video studio
```

采用编译为 Node.js 20.11+ JavaScript 的 TypeScript ports/adapters 与纯 reducer，不增加第三方
runtime dependency。队列、WebSocket 与 provider callback 只能负责通知；本地
`ProductionStore` 才是任务真相源。

## 2. 成功标准与非目标

### Phase 3A + 3B + 3C 已交付

- 严格、版本化的 episode、shot、asset、job、approval 数据契约。
- 每项目持久化、原子更新且有界的 `production-state.v1.json`。
- 可穷举测试的纯任务状态机，显式表达提交结果未知、取消待确认和孤儿任务。
- provider-neutral `ProductionAdapter`，以及受信任服务端使用的 ComfyUI HTTP adapter。
- 联网前得到 exact provider body digest 的 `prepareSubmission()`，以及只接受该 envelope 的
  `submitPrepared()`。
- 不可变 `ProductionDispatchIntent` companion、rights/moderation/license/budget gate；H3 在许可排除
  地域默认 deny，只有结构化书面许可 evidence 可放行。
- 每项目单飞 lease、独立 `production-control.v1.json`、精确 pending event 重放、预算/取消 side-effect
  intent 与最近 observation。
- 串行、服务端依赖注入的 `runProductionProjectOnce()`：恢复 `submitting` 只 inspect，绝不重 POST。
- 幂等私有资产 gateway ingestor；远端 locator 只在传输请求中使用，返回稳定 `AssetRef` 后才能 QC。
- CLI/Studio 只读 control projection，以及只导出人工 approved take 的 Studio handoff manifest。
- 提供按预分配远端 ID 查询 history/status 的有界 `inspect()` 原语，使后续 coordinator 能在断线/
  重启后对账，而不是依赖 WebSocket 内存事件。
- CLI 与 Studio 只读制片视图；Studio 轮询不得触发远端网络请求。
- 自动测试覆盖状态、存储、适配器、安全隔离和安装产物。
- `production enqueue --plan/--confirm` 的零网络两阶段入队，以及 owner-only runtime config 驱动的
  `writing-loop-production-worker --config FILE --once`；计费写面没有加入 Studio HTTP。
- 每 workflow 的 `static-pre-staged | scoped-staging` 策略、H3 `fl2va/ref2va` ordered slots、四组件
  model bundle、固定 active pipeline、stage source→consumer dataflow 与 template→bound graph proof；
  未知 profile/tuple/digest 在预算和远端 I/O 前 fail-closed。
- scope-bound job Gateway：canonical PUT、durable remote ID 与 intent binding、必需 admission policy、
  单 outcome durable admission settlement、restart/concurrent at-most-once raw submit；raw ComfyUI 仍只允许
  `inputBinding=null`。
- scope-bound output ingest/CAS ownership、统一 strict Gateway router 与 literal-private-IP Node bridge。

### 本阶段明确不做

- 不把 Studio 暴露到公网，也不增加远程高权限 start/stop/render HTTP 写面。
- 不在浏览器保存 provider endpoint、token、签名 URL 或对象存储凭据。
- 不实现共享网络盘上的 `.writing-loop` 状态。
- 不改变既有 workspace/project config schema 或 `ProjectSnapshot` schema。
- 不实现生产级 Redis 队列、Temporal workflow、H3 权重/推理服务安装或视频剪辑器。
- 不提供内建常驻 daemon；一轮式 worker 交给 systemd/launchd/容器调度器触发。endpoint/profile/credential
  只来自 owner-only server runtime config 与进程凭据环境，不能由 enqueue argv、Studio HTTP 或 intent 覆盖。
- 不杜撰 `video-creation-studio` 写 API；目前只有严格 handoff/export，导入不等于 Studio 已执行。
- 不把“provider 生成成功”解释为 QC、版权审核或发布通过。

## 3. Canon 与 revision 边界

已定稿剧本是只读 canon。制片系统只能读取并引用精确 revision；渲染、下载、审核或远端服务失败
不得反向改写正文。需要改稿时创建 writing-loop 修订 ticket，形成新的 episode/shot revision。

`production-domain.ts` 是 v1 wire schema 的唯一权威。下面字段与持久 JSON 完全一致；每个对象都要求
`version: 1`，parser 会严格拒绝未知字段：

```ts
type EpisodeRevisionRef = {
  version: 1;
  episodeId: string;
  revision: number;       // >= 1
  source: AssetRef;       // 内容 hash + 稳定存储身份
};

type ShotRevisionRef = {
  version: 1;
  episode: EpisodeRevisionRef;
  shotId: string;         // 稳定逻辑 ID，禁止数组下标
  revision: number;       // >= 1
  source: AssetRef;       // 规范化 shot manifest 的内容身份
};

type ProductionSubjectRef =
  | { version: 1; kind: "episode"; episode: EpisodeRevisionRef }
  | { version: 1; kind: "shot"; shot: ShotRevisionRef };
```

禁止 `latest`、可变分支名或未校验路径充当 revision。package、take、job、asset provenance 和
approval 都绑定精确 revision；revision 变化后旧记录保留审计，但审批不得继承。

## 4. AssetRef 与连续性包

持久状态只保存内容身份，不保存临时网络地址：

```ts
type AssetRef = {
  version: 1;
  uri: string;             // 永久逻辑 URI，由未来受信任 resolver 解析
  sha256: string;
  byteLength: number;
  mediaType: string;
};
```

v1 没有 `assetId`、`versionId`、`storageUri` 或 `storageVersionId` 字段；把这些未来候选字段写入
`production-state.v1.json` 会被当作 schema 漂移硬拒绝。资产身份由 `(uri, sha256)` 共同表达。

下面的 marker 区间是可执行契约 fixture；测试会从本文提取 JSON，并交给 production-domain 的
`parseProductionSubjectRef` 及嵌套 revision/AssetRef parser，防止文档与 `exactKeys` 再次漂移。

<!-- writing-loop-production-v1-wire-fixture:start -->
```json
{
  "version": 1,
  "kind": "shot",
  "shot": {
    "version": 1,
    "episode": {
      "version": 1,
      "episodeId": "ep-001",
      "revision": 3,
      "source": {
        "version": 1,
        "uri": "s3://writing-loop-assets/demo/episode-001.md",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "byteLength": 1200,
        "mediaType": "text/markdown"
      }
    },
    "shotId": "shot-001",
    "revision": 2,
    "source": {
      "version": 1,
      "uri": "s3://writing-loop-assets/demo/shot-001.json",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "byteLength": 640,
      "mediaType": "application/json"
    }
  }
}
```
<!-- writing-loop-production-v1-wire-fixture:end -->

硬约束：

- 禁止绝对本机路径、`file:` URI、内嵌凭据和 signed URL。
- `AssetRef.uri` 只是 opaque identity；只能交给同时固定 scheme 与 authority 的受信任 allowlist
  resolver。任何 consumer 都不得把任意 `https:` AssetRef 直接交给 `fetch`；resolver 还必须在连接时
  阻断 loopback、link-local、私网/metadata IP 与 DNS rebinding，并在下载后复核下列内容事实。
- 上传与下载后都校验 SHA-256、长度与媒体类型；对象 key 内容变化时硬停。
- ETag 不作为通用内容哈希。
- provider 专有 URL 只存在于一次传输的内存中。
- H3/ComfyUI 输出必须先 ingest、校验并登记为 AssetRef，随后才能进入 QC。

每个 shot revision 的 continuity pack 至少冻结角色/声线版本、服装与道具、场景/时间/灯光、景别与
轴线、屏幕方向、动作承接、剧情 beat、逐字对白及说话人、first/last frame、参考音视频用途，以及
model/workflow/seed/参数 fingerprint。reference 必须标注用途，不能只是无语义 URL 列表。

## 5. ProductionTask 与状态机

状态集合与合法边如下；这张表逐项对应 `PRODUCTION_TRANSITIONS`：

```text
planned             -> dispatch-pending | cancel-requested | failed
dispatch-pending    -> submitting | cancel-requested | failed
submitting          -> submitted | submission-unknown | cancel-requested | failed
submitted           -> running | ingesting | cancel-requested | failed | orphaned
running             -> ingesting | cancel-requested | failed | orphaned
ingesting           -> qc-pending | cancel-requested | failed | orphaned
qc-pending          -> approved | rejected | cancel-requested | failed | orphaned
submission-unknown  -> submitted | running | cancel-requested | failed | orphaned
cancel-requested    -> submission-unknown | submitted | running | ingesting | qc-pending |
                       approved | rejected | cancelled | failed | orphaned
approved | rejected | failed | cancelled | orphaned -> (terminal)
```

最终合法转移由纯函数 reducer 唯一定义。终态不得回退；同 event ID + 同 canonical payload 的精确
重放可幂等忽略，同 ID 不同 payload 与其他过时/乱序事件都硬错。`cancel-requested` 这一行是所有
可能取消竞态结果的并集；reducer 会再按持久化的
`cancellationRequest.requestedFrom` 限制可恢复目标。取消是请求，只有远端确认后才是 `cancelled`；
远端已经推进的事实可以安全恢复到来源阶段允许的后继，但不会抹掉取消审计记录。
`cancelled` event 还必须携带判别式 `cancellationConfirmation`：提交前的本地取消只允许
`local-no-submission`，已经绑定远端 job 的取消则必须来自匹配 backend instance + job ID 的
`cancelled` terminal observation，
并保留 observation 时间与响应 digest。`CancelResult.accepted=true`/HTTP 200 的请求事实结构上无法通过
event parser。

取消输掉竞态时，remote success fact 的直接恢复矩阵为：

```text
requestedFrom        -> allowed direct recovery target
planned              -> (none)
dispatch-pending     -> (none)
submitting           -> submission-unknown | submitted | running
submission-unknown   -> submission-unknown | submitted | running
submitted            -> submitted | running | ingesting
running              -> running | ingesting
ingesting            -> ingesting | qc-pending
qc-pending           -> qc-pending | approved | rejected
```

所有来源仍可按普通错误/取消证据进入 `cancelled | failed | orphaned`；一旦恢复继续生产，原始
`cancellationRequest` 仍保留到后续状态/终态，并投影到 read model。

严格 v1 task/state envelope 是：

```ts
type ProductionSubmissionOutbox = {
  version: 1;
  requestDigest: string;
  preparedAt: string;
  state: "pending" | "acknowledged" | "unknown";
};

type ProductionCancellationRequest = {
  version: 1;
  requestedFrom: "planned" | "dispatch-pending" | "submitting" | "submission-unknown" |
                 "submitted" | "running" | "ingesting" | "qc-pending";
  requestedAt: string;
  reason: string;
};

type ProductionCancellationConfirmation =
  | { version: 1; kind: "local-no-submission" }
  | { version: 1; kind: "remote-terminal-observation"; backendInstanceId: string; remoteJobId: string;
      state: "cancelled"; observedAt: string; responseDigest: string };

type ProductionEventReceipt = {
  version: 1;
  eventId: string;
  payloadDigest: string; // strict parser 固定键序 canonical JSON 的 SHA-256
};

type ProductionCost =
  | { version: 1; state: "known"; currency: "USD"; amountMicros: number;
      basis: "reported" | "billed" | "estimated" | "tariff" | "reported-converted";
      // reported-converted 必须非 null，其余 basis 必须为 null；旧记录缺省该字段按 null 读取。
      // rateMicrosPerUnit 是 1 单位原币折合的 USD micros（0.138 USD/CNY 记 138_000），方向为
      // 原币 → USD；解析器强制 amountMicros == round_half_up(nativeAmountMicros × rate / 1_000_000)，
      // 该等式以 BigInt 计算，两个因子的上界相乘不会溢出。
      settlement: null | { nativeCurrency: "CNY"; nativeAmountMicros: number;
                           rateMicrosPerUnit: number; rateAsOf: string;
                           rateSource: "gateway-registry" } }
  | { version: 1; state: "unknown";
      reason: "not-recorded" | "provider-not-reported" | "in-flight" |
              "unavailable" | "legacy-record" };

type ProductionApproval = {
  version: 1;
  decision: "approved" | "rejected";
  taskRevision: number;
  subjectRevision: number;
  decidedAt: string;
  decidedBy: string;
  note: string | null;
};

type ProductionTask = {
  version: 1;
  id: string;                         // v1 的 take/task ID
  idempotencyKey: string;
  subject: ProductionSubjectRef;
  status: ProductionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  backendInstanceId: string | null;
  remoteJobId: string | null;
  submissionOutbox: ProductionSubmissionOutbox | null;
  cancellationRequest: ProductionCancellationRequest | null;
  cancellationConfirmation: ProductionCancellationConfirmation | null;
  assets: AssetRef[];
  cost: ProductionCost;
  approval: ProductionApproval | null;
  statusMessage: string | null;
  eventReceipts: ProductionEventReceipt[];
};

type ProductionState = {
  version: 1;
  workspaceId: string;
  project: string;
  revision: number;
  updatedAt: string | null;
  tasks: ProductionTask[];
};
```

除 terminal `cancellationConfirmation` 的最小强证据外，权威 `production-state.v1.json` 不持久化
`backendKind`、workflow/model/seed/参数 fingerprint、attempt、输入/输出分栏或最近 remote
observation。Phase 3B 把 immutable workflow/model/parameters digest 保存在每 task 的 intent companion，
把 retry/budget/cancel attempt/最近 observation 保存在非权威 `production-control.v1.json`；两者都不能
冒充权威任务字段。当前 read
model 按 basis 分列小计（`summary.cost.byBasis`）：`reported / billed / tariff / reported-converted`
计入实际发生成本，`estimated` 单列，不并入 actual；没有 actual 证据时仍为 `unknown`，不能写 0。QC/approval 独立于生成状态，并绑定被审核的 task/subject revision。
`eventReceipts` 绑定 event ID 与 canonical payload digest：完全相同的重放是 no-op，同 ID 不同 payload
会硬错；`cancellationRequest` 即使取消竞态失败也作为审计事实保留；`cancellationConfirmation` 只在
`cancelled` 终态出现并投影到 read model。

幂等键绑定同一个计费意图：

```text
sha256(backend instance + shot revision + workflow digest
       + exact inputs + parameters + takeId)
```

网络重试复用原 key；有意生成新 take 必须产生新的 `takeId`（通常也使用新 seed）。
`idempotencyKey` 与已知的 `(backendInstanceId, remoteJobId)` 都必须唯一。

## 6. Ports 与 adapter contract

纯 reducer 不导入 HTTP、文件、计时器或 provider SDK；同步 store 和异步 adapter 的实际 API 是：

```ts
class ProductionStore {
  constructor(root: string, workspaceId: string, project: string);
  read(): ProductionState;
  create(create: ProductionTaskCreate): CreateProductionTaskResult;
  apply(event: ProductionTaskEvent): ApplyProductionEventResult;
}

interface ProductionAdapter {
  capabilities(signal?: AbortSignal): Promise<BackendCapabilities>;
  // prepare 零网络，digest 精确覆盖真正发送的 provider bytes。
  prepareSubmission(request: SubmitRequest): PreparedSubmission;
  submitPrepared(prepared: PreparedSubmission, signal?: AbortSignal): Promise<SubmitResult>;
  // 兼容 wrapper；coordinator 禁止使用它绕过 durable outbox。
  submit(request: SubmitRequest, signal?: AbortSignal): Promise<SubmitResult>;
  inspect(remoteJobId: string, signal?: AbortSignal): Promise<RemoteObservation>;
  cancel(remoteJobId: string, signal?: AbortSignal): Promise<CancelResult>;
}

interface ProductionArtifactIngestor {
  ingest(task: ProductionTask, observation: RemoteObservation, signal?: AbortSignal):
    Promise<{ version: 1; ingestKey: string; assets: AssetRef[]; cost: ProductionCost }>;
}

runProductionProjectOnce(options: ProductionCoordinatorOptions):
  Promise<ProductionCoordinatorRunResult>;
```

所有 adapter 都由服务端注入受信任 endpoint 与 credential resolver；API/浏览器请求不能选择任意
base URL。adapter 响应必须限时、限制 bytes、校验 content type 和严格 DTO，错误映射为稳定分类：

- `aborted`：inspect/cancel 被调用方取消，或 submit 在任何网络 I/O 前已经取消。
- `submission-unknown`：请求可能已被接受；禁止自动再次 POST。
- `remote-rejected`：确定未接收或输入无效；POST 408/425/429 不属于安全 rejected。
- `remote-unavailable`：可按策略重试 inspect/reconcile。
- `invalid-response` / `response-too-large`：远端协议或安全错误。

`not-found` 是 `RemoteObservation.state`，不是 `ProductionAdapterErrorCode`；Phase 3B coordinator 只把它
记为 control observation/manual attention，不自动推断 `orphaned` 或 `failed`。若未来引入 TTL policy，
必须基于持久证据和显式配置另行评审。

## 7. ComfyUI quick reference 与已交付恢复算法

首个 adapter 以 ComfyUI Core v0.24.0 为核验基线，并保留 legacy server 的安全降级路径：

- `POST /prompt` 接受 API-format prompt graph、`client_id` 和调用方预分配的 `prompt_id`。
- `GET /api/jobs/{prompt_id}` 是 v0.24+ 的规范化单任务读接口；404 的精确 JSON 为
  `{"error":"Job not found"}`。
- legacy `/history/{prompt_id}` 返回终态/输出；未知 ID 是 HTTP 200 `{}`。
- `/queue` 返回在途任务且每项携完整 workflow，必须限制响应 bytes。
- `/ws` 只用于低延迟进度提示；断线不得丢失业务状态。
- `/view` 和 `/upload/image` 只能由受信任 adapter/asset gateway 使用，禁止浏览器绕过 AssetRef。
- `POST /queue {delete:[prompt_id]}` 与 v0.24 的定向 `/interrupt {prompt_id}` 都只是取消请求，
  HTTP 200 不证明任务已经停止。旧版 `/interrupt` 可能影响整个实例，未经只读 capability probe 不调用。

Phase 3A/3B 已实现的 adapter 边界：

- `prepareSubmission()` 在零网络状态生成 canonical UUID envelope，并按真正的
  `JSON.stringify({prompt, client_id, prompt_id})` bytes 计算 digest；coordinator 先把该 digest 与 ID
  落盘，再将同一个 envelope 交给 `submitPrepared()`。
- 在网络前严格验证 API-format workflow；预先 abort 时返回 `aborted` 且零网络副作用。
- 只调用一次 `POST /prompt`。仅有界 200 JSON 返回完全相同的 `prompt_id` 才算 confirmed。
- 所有 HTTP 请求固定 `redirect: "error"`；307/308 不得重放 POST body 或把工作流转发给 Location。
- 一旦 fetch 开始，timeout/reset/caller abort、408/425/429/5xx、空/超大/无效 2xx 或 ID mismatch
  都返回 `submission-unknown`；adapter 不会自动再次 POST。
- `inspect(remoteJobId)` 提供按 ID 的有界只读 observation；`cancel(remoteJobId)` 只返回请求事实，
  不会把 HTTP 200 冒充远端已停止。
- `cancelled` domain event 不接受 `CancelResult`；远端路径必须携匹配 `backendInstanceId + remoteJobId`、固定
  `state: "cancelled"`、`observedAt` 与 `responseDigest` 的 terminal observation confirmation。
- `errorSummary` 只保留稳定错误类别和极小 allowlist 内的 exception type；远端 message、URL、token、
  剧本文本与 traceback 不进入 read model/持久状态。
- adapter 本身不读写 `ProductionStore`、不扫描非终态任务、不调度重试，也不执行 ingest；这些职责
  由项目 lease 下的 coordinator 与独立 ingestor 组合。

Phase 3B coordinator 已按以下协议组合 store、adapter 与 ingestor：

1. 验证 revision、workflow/model/custom-node digest、AssetRef、rights/territory 与预算。
2. 在 store 原子事务内预分配 canonical UUID `remoteJobId`，写入精确请求 digest/outbox 与
   `submitting`，完成 fsync 后才允许网络 I/O。
3. 只调用一次 `POST /prompt`，body 同时携带 `prompt_id=remoteJobId`；raw ComfyUI **不会**按该
   ID 去重，重复 POST 仍会重复入队并可能让 history 同 key 覆盖。
4. 仅当有界 200 JSON 的 `response.prompt_id` 与预分配 ID 完全相等时记录 `submitted`。
5. 把 adapter 的歧义结果记录为 `submission-unknown`；只能按已知 ID 对账，绝不再次 POST。
6. 一次 `runProductionProjectOnce()` 扫描全部非终态；部署方的 runner 可周期调用，但 v1 不内置 daemon。
7. provider success 只进入 `ingesting`；下载与 checksum 完成后进入 `qc-pending`。
8. ingest 失败只重试同一 `ingestKey`，禁止重新生成；成功落 `qc-requested` 且 cost 是 provider
   `reported/billed` 事实后才释放 active budget reservation。`estimated` 或 `unknown` 继续保留 exposure
   并要求账单对账，不能为下一任务静默归还容量。

默认 legacy 对账每次都执行 `GET /queue`，再执行 `GET /history/{id}`，并让 terminal history 优先。
同一 ID 在单份 queue 中出现多次会硬停；若 queue₁ 与 terminal history₂ 交叉，则第三次读取 queue：
queue₃ 已消失表示正常完成迁移，仍存在才视为协议冲突/潜在重复计费。queue/history 都 absent 只是一条
`not-found` observation；history 是进程内、最多约 10,000 项且重启会清空，因此已确认提交的 absent
不等于“从未提交”，由 coordinator 决定 orphan/manual audit。

v0.24+ `/api/jobs/{id}` 只有在只读 feature probe 明确成功时才可作为可选优化：精确 JSON 404 表示
route supported，404 HTML/不同 envelope 才缓存为 legacy unsupported；401/403/429/5xx、timeout、
oversize 或 invalid JSON 必须保留错误，不能静默 fallback。

ComfyUI 原生 API 没有调用方 idempotency key 保证，因此生产部署应在它前面增加内部 gateway/outbox
索引，按 writing-loop 的 `idempotencyKey` 返回既有 `prompt_id`。Phase 3A adapter 对歧义提交必须保守，
不能伪造 exactly-once。

Node 20.11 的全局 WebSocket 需要 `--experimental-websocket`；因此 WS watcher 默认可省略。即使启用，
它也没有 replay cursor，event 只能触发提前 `inspect()`，不能直接写终态。JSON 响应必须按 stream
限制 bytes，deadline 覆盖 headers 与完整 body；禁止无界 `response.json()`/`arrayBuffer()`。

## 8. 持久化、边界与故障语义

状态文件位于：

```text
<workspace-root>/.writing-loop/<project-key>/production-state.v1.json
<workspace-root>/.writing-loop/<project-key>/production-control.v1.json
<workspace-root>/.writing-loop/<project-key>/production-intents.v1/<task-id>.json
```

要求：

- 文件绑定 `workspaceId + project`；跨 scope 读取硬错。
- 文件缺失表示空 v1 state；JSON 损坏、超限或 schema 不合法必须硬错。
- document `revision` 必须精确等于 task 创建数加全部 task 的 event receipt 数；漂移或耗尽值视为损坏，
  不能进入 read model 或下一次 writer。
- 拒绝 symlink、hardlink、FIFO 和非 regular file。
- 写入使用独占 lock、锁内重读、revision+1、同目录临时文件、文件 fsync、rename、目录 fsync。
- 主锁的正常创建与 dead-owner takeover 都先经过短时 `.production-state.v1.acquire` O_EXCL gate；
  旧锁验证、删除与后继锁 fsync 在同一 gate 内完成，阻断双恢复者的 check→unlink 竞态。
- 崩溃残锁只有在严格 metadata、同 hostname/uid、`kill(pid, 0)=ESRCH` 与持 fd 的 inode 二次核验全部
  成立时才接管；活锁、坏锁、权限不明或检查后被替换的锁一律 fail-closed。
- acquisition gate 自身若在极短窗口内因 SIGKILL 残留则不自动递归接管；错误会给出精确路径，必须在
  核验 owner 已退出后人工移除，避免把同一种 TOCTOU 搬到 gate 上。
- state、jobs、events、字符串、远端原始摘要都设上限；不在权威 JSON 中保存大型 workflow 或媒体。
- remote observation 只能更新已知事实，不允许把临时 unreachable 当成 failed。
- intent companion 使用 O_EXCL 首次创建；相同 canonical digest 可精确重放，不同内容不能覆盖。
- control 是恢复账本而非第二份业务真相：保存 pending event、budget reservation/exposure/release、
  retry 类别、cancel attempt 与最近 observation；其短锁不跨网络 await。
- 项目 coordinator lease 覆盖完整 async round；主 production/control 写锁只覆盖各自同步 fsync/rename。

## 9. Studio 与 CLI 安全边界

- Studio 继续只监听 loopback，并保持 CSP `connect-src 'self'`。
- 新增项目作用域的只读 production API/read model；GET/HEAD 之外返回 405。
- 项目 key 必须通过 workspace registry 解析，防止跨 workspace/project 读取。
- 动态 provider 文本、错误、媒体类型和名称在 HTML 中统一转义。
- Studio 页面/SSE 只读取本地 state revision，不在页面请求或 poller 内探测远端。
- CLI `production status` 同时投影权威 ledger 与 control reservation/exposure，暂停项目仍可读；正数
  sub-cent 金额显示 `<$0.01`，不能伪装为 `$0.00`。
- CLI `production handoff --project KEY --input FILE` 只读 ledger 并向 stdout 输出 approved takes；
  input 必须是读取期间不变的单链接有界 UTF-8 文件。
- handoff digest 使用 `sha256:writing-loop-canonical-json-v1`：UTF-8、无空白、数组保序、对象键按
  Unicode code-unit 顺序递归排序、安全整数；CLI 明确输出算法名与 digest。handoff `createdAt` 不得
  早于所绑定 production revision/approval facts。

## 9A. 远程部署、H3 与视频 Studio 的真实边界

- writing-loop 是本地 control plane 与真相源；ComfyUI/H3/GPU 可以在另一台私网服务器。浏览器不
  直连 provider，受信任 gateway/adapter 由服务端注入 endpoint 与短期凭据。
- MiniMax H3 位于镜头音视频生成层，不是剧本/对白写作 LLM。`execution.operation` 只描述
  `comfyui-workflow`/direct gateway 等 transport，不能充当许可模型身份；必填的
  `execution.modelFamily="minimax-h3"` 冻结 variant、4–15 秒、768 short edge、aspect/model/workflow/
  parameters digest，因此 H3-over-ComfyUI 仍进入 H3 gate。受信任 workflow resolver 必须返回
  `workflow + modelFamily + modelSha256 + parametersSha256` descriptor；coordinator 在预算 reservation
  与 provider I/O 前逐项绑定 immutable intent，任何 family/digest 漂移都 fail-closed。
- open-weight H3-Base 与官方托管完整 2K 链不是同一交付物；本仓库不声称安装权重或提供 H3 推理。
- H3 社区许可的排除地域在 intent gate 默认 deny；EU 与全部 27 个成员国 ISO2、GB/UK、KR、US
  （以及涵盖它们的 WORLDWIDE）只有 verified written-license evidence 才能 dispatch。托管 API 的
  独立条款仍需单独法律审核。
- 当前核验到的 `video-creation-studio` 是 agent/Codex 驱动项目，没有可据以实现 exactly-once 远程
  job 的稳定写契约。因此只交付不可变 handoff，不把导出 JSON 冒充为已导入、已合成或已发布。

H3 graph v1 的语义基线来自 Comfy 官方的一手资料：[MiniMax H3 教程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)、
[ComfyUI H3 core nodes 源码](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py)
与 [官方 workflow templates](https://github.com/Comfy-Org/workflow_templates/tree/main/templates)。这些来源用于
冻结 native `MiniMaxH3ImageToVideo`/`MiniMaxH3ReferenceToVideo`、24fps、`17k+5` frame alignment、
四模型组件和 active sampler/decode/save dataflow；它们不等于本仓库已下载权重、安装 custom nodes，或已对
某个真实 ComfyUI 实例完成 `/prompt` 验收。

## 9B. Phase 3C 部署与 runtime contract

正式进程分成两个信任域：writing-loop worker 只连接私有 Gateway；Gateway 的 server-owned registry 才
能看到 raw ComfyUI origin、完整 graph、模型/custom-node lock、stage profile、资产 resolver 与累计预算/
并发 admission policy。浏览器、intent、enqueue JSON 都不能覆盖这些值。

```text
writing-loop production enqueue --plan --project drama-a --input enqueue.json
writing-loop production enqueue --confirm <planId> --project drama-a --input enqueue.json
writing-loop-production-worker --config /etc/writing-loop/production-runtime.json --once --json
```

runtime config 必须是 owner-owned、单链接、`0400` 或 `0600` 的有界 UTF-8 JSON；只保存环境变量名称，
不保存 token 值。`production-gateway` 必须是 credentialed HTTPS。唯一 direct Comfy escape hatch 是无凭据
literal-loopback HTTP development endpoint，不得用于远程生产。下面 fixture 由文档测试直接交给 strict
runtime parser，字段漂移会使 CI 失败。它是 **representative API-format contract fixture**：其中 alias、
artifact digest、workflow digest 与参数 digest 只演示 server-owned identity 绑定，不是可下载模型清单，也
没有经过 live ComfyUI `/prompt`；部署时必须用实际 graph/artifact attestation 替换并执行兼容性探针：

<!-- writing-loop-production-runtime-v1-fixture:start -->
```json
{
  "version": 1,
  "workspaceId": "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "projects": [
    {
      "version": 1,
      "project": "drama-a",
      "enabled": true,
      "backendInstanceIds": ["gateway-h3-fl2va"],
      "deploymentTerritories": ["CN"],
      "availableBudgetMicros": 5000000
    }
  ],
  "backends": [
    {
      "version": 1,
      "backendInstanceId": "gateway-h3-fl2va",
      "kind": "production-gateway",
      "baseUrl": "https://production-gateway.internal.example/",
      "credentialEnv": "WRITING_LOOP_GATEWAY_TOKEN",
      "profileId": "h3-fl2va-portrait"
    }
  ],
  "gateway": {
    "version": 1,
    "baseUrl": "https://production-gateway.internal.example/",
    "credentialEnv": "WRITING_LOOP_GATEWAY_TOKEN"
  },
  "workflows": [
    {
      "version": 1,
      "backendInstanceId": "gateway-h3-fl2va",
      "workflowSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "modelFamily": "minimax-h3",
      "modelSha256": "d153e5de740ec05a573d03497225a9bdb144666816cec2d4ba7ab5e0c8239a9a",
      "parametersSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "projects": ["drama-a"],
      "inputPolicy": "scoped-staging",
      "stagingProfileId": "h3-fl2va-portrait",
      "h3GraphContract": {
        "version": 1,
        "generator": {
          "version": 1,
          "nodeId": "10",
          "classType": "MiniMaxH3ImageToVideo",
          "width": 768,
          "height": 1344,
          "length": 192
        },
        "modelBundle": {
          "version": 1,
          "diffusion": {
            "version": 1,
            "nodeId": "11",
            "classType": "UNETLoader",
            "inputName": "unet_name",
            "modelAlias": "minimax/MiniMax-H3.safetensors",
            "artifactSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          },
          "textEncoder": {
            "version": 1,
            "nodeId": "12",
            "classType": "CLIPLoader",
            "inputName": "clip_name",
            "modelAlias": "minimax/Qwen3-VL-32B.safetensors",
            "artifactSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          },
          "videoVae": {
            "version": 1,
            "nodeId": "13",
            "classType": "VAELoader",
            "inputName": "vae_name",
            "modelAlias": "minimax/MiniMax-H3-video-vae.safetensors",
            "artifactSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
          },
          "audioVae": {
            "version": 1,
            "nodeId": "14",
            "classType": "VAELoader",
            "inputName": "vae_name",
            "modelAlias": "minimax/MiniMax-H3-audio-vae.safetensors",
            "artifactSha256": "9999999999999999999999999999999999999999999999999999999999999999"
          },
          "sha256": "d153e5de740ec05a573d03497225a9bdb144666816cec2d4ba7ab5e0c8239a9a"
        },
        "pipeline": {
          "version": 1,
          "sigmaShift": { "version": 1, "nodeId": "15", "classType": "MiniMaxH3SigmaShift" },
          "guider": { "version": 1, "nodeId": "16", "classType": "BasicGuider" },
          "scheduler": { "version": 1, "nodeId": "17", "classType": "BasicScheduler" },
          "samplerSelect": { "version": 1, "nodeId": "18", "classType": "KSamplerSelect" },
          "noise": { "version": 1, "nodeId": "19", "classType": "RandomNoise" },
          "sampler": { "version": 1, "nodeId": "20", "classType": "SamplerCustomAdvanced" },
          "videoDecode": { "version": 1, "nodeId": "21", "classType": "VAEDecode" },
          "audioDecode": { "version": 1, "nodeId": "22", "classType": "VAEDecodeAudio" },
          "createVideo": { "version": 1, "nodeId": "23", "classType": "CreateVideo" },
          "saveVideo": { "version": 1, "nodeId": "24", "classType": "SaveVideo" }
        },
        "parameterManifest": {
          "version": 1,
          "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      },
      "file": "workflows/h3-fl2va-portrait.json"
    }
  ],
  "stagingProfiles": [
    {
      "version": 1,
      "profileId": "h3-fl2va-portrait",
      "baseUrl": "https://production-gateway.internal.example/",
      "credentialEnv": "WRITING_LOOP_GATEWAY_TOKEN",
      "execution": {
        "version": 1,
        "operation": "comfyui-workflow",
        "modelFamily": "minimax-h3",
        "backendInstanceId": "gateway-h3-fl2va",
        "workflowSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "modelSha256": "d153e5de740ec05a573d03497225a9bdb144666816cec2d4ba7ab5e0c8239a9a",
        "parametersSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "variant": "fl2va",
        "durationSeconds": 8,
        "shortEdge": 768,
        "aspectRatio": "9:16"
      },
      "bindings": [
        {
          "version": 1,
          "index": 0,
          "slot": "first_frame",
          "source": {
            "version": 1,
            "nodeId": "100",
            "classType": "LoadImage",
            "inputName": "image",
            "outputIndex": 0
          },
          "consumer": {
            "version": 1,
            "nodeId": "10",
            "inputName": "first_frame"
          }
        }
      ]
    }
  ],
  "runner": {
    "version": 1,
    "intervalMs": 5000,
    "projectConcurrency": 1,
    "perBackendConcurrency": 1
  }
}
```
<!-- writing-loop-production-runtime-v1-fixture:end -->

一次 staged dispatch 的强制顺序是：rights/license/budget gate → exact immutable template/profile lookup →
scoped asset staging → `VerifiedStageReceipt`（exact execution + ordered bindings）→ trusted materializer 把
provider object key 只写入 allowlisted `LoadImage.image` → source output 0 到真实 H3 generator consumer 的
exact edge proof → canonical bound workflow identity → reserve maximum cost → durable `submission-started` →
expose budget → Gateway canonical PUT。intent 的 `workflowSha256` 永远钉住 template；同一 template 对不同
asset receipt 会得到不同、稳定的 `boundWorkflowSha256`。worker 提交 bound digest；Gateway 不接收 caller
graph，而是从自己的 template 与 verified receipt 独立重建同一 bound graph，digest 不一致即拒绝。

Gateway 在任何 raw provider I/O 前完成 scope/profile/receipt/template→bound 的纯验证，再用稳定
`storageKey=hash(scope,idempotencyKey)` 调用必需的 durable `ProductionJobStorageAdmissionPolicy`；它按
Gateway 计算的 `recordBytesUpperBound` 原子约束 per-scope job/byte 与 deployment-global quota，且必须在
任何 global remote-ID、scoped intent 或 job record 之前 allow。完全相同的重放在容量已满时仍复用原 slot；
同 key 不同 remote/request 是 conflict。Gateway 发布首个 global binding 后、任何第二条 record 前，必须
以 exact `recordRef` 幂等 `commit(context,storageKey,recordRef)`；commit 后 slot 变为不可 release 的 lifetime
reservation，只允许由受控 retention/GC 回收，不能因 submission deny 就释放并让不可变审计记录无限填盘。
只有 O_EXCL loser 已证明本请求零 record 时，才可幂等
`release(context,storageKey,"unused-before-record")`；authority 必须拒绝 committed release 并保留 context
drift tombstone。`acquire/commit/release` 的响应丢失与进程重启都只能重放相同参数。

通过 storage admission 后，再用稳定
`admissionKey` 调用必需且幂等的 durable `SubmissionAdmissionPolicy.acquire()`。allow 后只允许一个
`submitted | not-submitted | submission-unknown` outcome；先持久化 outcome，再以相同 key/outcome 调用
`settle()`，响应丢失或重启只能重放 settlement，不能产生第二个 outcome 或第二次 raw submit。deny 是
确定未提交；allow 后若 raw-attempt claim 的 deadline 到期而无结果，只能落 `submission-unknown`。相同
intent 换 remote ID、相同 remote ID 换 intent、tuple drift、receipt 跨 scope/profile 复用或用 receipt B
冒充 graph A 都在 raw I/O 前冲突。成功输出只能经 scope-bound ingest/CAS claim 变成稳定 `AssetRef`，
之后才进入 `qc-pending`。

Gateway router 只委派以下 writing-loop-owned contract；它们不是 ComfyUI 上游 API：

- `PUT /v1/scopes/{workspace}/{project}/stages/{stageKey}`
- `PUT|GET /v1/scopes/{workspace}/{project}/jobs/{remoteJobId}` 与 scoped cancellation PUT
- `PUT /v1/scopes/{workspace}/{project}/ingests/{ingestKey}`
- `GET /v1/scopes/{workspace}/{project}/assets/sha256/{digest}`

Node bridge 只允许 literal private IP；生产 TLS/mTLS、credential issuance、server profile/asset registry、
durable storage/submission admission backend、raw Comfy/H3 服务与模型供应链 attestation 仍是部署责任。
仓库提供安全内核和 composition ports，不提供 permissive 默认 admission，也不把单进程 semaphore
或进程内文件计数冒充集群硬配额。

## 10. Guardrails

以下条件必须阻断 dispatch 或发布：

- episode/shot revision、workflow digest、输入 checksum 或权限证据缺失。
- AssetRef 指向临时/本机地址，或下载后的 hash/长度不匹配。
- `rightsStatus` 为 `unknown`、`expired` 或 `blocked`。
- moderation、真人肖像/声音同意、地域或预算门未通过。
- H3 open-weight backend 位于或向其许可证排除地域提供使用，且没有书面授权。
- `submission-unknown` 的潜在重复成本尚未对账。
- 技术 QC、连续性 QC、权利审核或发布审批未绑定当前 revision。

ComfyUI 必须部署在私网/鉴权 gateway 后；custom nodes 是任意 Python 代码，workflow/node/model 需要
allowlist 与版本 digest。不得把原生 8188 端口暴露到公网。

## 11. Evaluation Strategy

### 自动化门禁

| 维度 | Good | Bad | Stakes |
| --- | --- | --- | --- |
| revision 锁定 | 所有对象绑定精确 digest；新稿产生新 revision | `latest`、审批漂移、制片失败改正文 | Critical |
| 状态与幂等 | 合法转移可恢复；歧义提交不重复 POST | 终态回退、重复计费、WS 丢失即丢状态 | Critical |
| 资产完整性 | ingest 校验 hash/bytes/type 并登记 provenance | 只存 URL、key 内容变化仍继续 | Critical |
| 隔离与安全 | scope 严格绑定、HTML 转义、endpoint 服务端注入 | 跨 workspace 泄露、SSRF、XSS | Critical |
| QC 与权利 | 生成、QC、审批是独立阶段且绑定 revision | success 自动 approved；旧审批复用 | High |
| 成本纪律 | estimate/actual 分离，缺失显示 unknown | 未知费用显示 0 或无限自动重试 | High |

每次变更至少运行：

- reducer 转移表、重复/乱序事件、终态回退和 approval revision 测试。
- store 幂等、唯一性、scope binding、损坏/特殊文件、并发锁和原子写测试。
- adapter 超时、AbortSignal、响应上限、非法 JSON/DTO、可信 endpoint 与歧义提交测试。
- Studio GET/HEAD/405、跨 workspace、XSS 与“页面/SSE 不访问远端”测试。
- CLI JSON/文本输出、暂停项目、安装后 artifact smoke 与完整 typecheck/test。

### 人工 reference dataset

在连接真实 GPU 前准备一个无版权争议的小型金标集：至少 2 个项目、2 个 workspace、3 个分集、
12 个镜头，覆盖双人对白、动作承接、服装/伤势变化、first/last frame、语音和失败素材。为每个镜头
保存 continuity pack、预期技术规格、允许/禁止的参考用途、QC reason codes 和预算上限。

上线前由 showrunner、分镜/连续性、剪辑/QC、制片、版权/安全和运维共同校准。Critical 自动门禁
必须 100% 通过；任何 checksum/scope/revision/idempotency 失败都阻断发布。

## 12. Production Monitoring

Phase 3A/3B 定义并投影本地可证实指标，不伪造 provider 成本：

- 各状态 job 数与停留时长；queue/generation/ingest p50/p95。
- `submission-unknown`、orphaned、重复 remote ID、reconcile failure 比率。
- checksum/bytes/media validation、rights/moderation/budget gate 失败数。
- 每个 approved shot 的 take 数、首 take 通过率、废片成本、每获批秒成本。
- estimate、reserved、actual-known、actual-unknown 和潜在重复计费敞口分别统计。
- adapter timeout/invalid-response/oversize、后端健康 observation 的时间与新鲜度。

告警必须给出 workspace/project/job 的稳定 ID 和安全错误摘要，不能包含 token、signed URL、完整
workflow、剧本文本或 provider 原始敏感 payload。

## 13. 后续升级触发器

- 已运营 Redis、需要多消费者、队列级优先级/限流：实现 BullMQ `JobDispatcher`，store 仍是权威。
- 多日流程、多个控制器、可靠 timer/human wait/补偿与版本化恢复：迁移 Temporal orchestrator。
- 只有状态图出现大量嵌套/并行 guard 时考虑 XState。
- 只有 LLM 动态决定分支、工具与人工中断时才考虑 LangGraph；确定性制片控制不使用它。

## 14. 协议依据

- [ComfyUI v0.24.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.24.0)
- [ComfyUI v0.24.0 OpenAPI](https://github.com/Comfy-Org/ComfyUI/blob/v0.24.0/openapi.yaml)
- [ComfyUI server routes](https://github.com/Comfy-Org/ComfyUI/blob/v0.24.0/server.py)
- [ComfyUI queue/history implementation](https://github.com/Comfy-Org/ComfyUI/blob/v0.24.0/execution.py)
- [ComfyUI jobs DTO](https://github.com/Comfy-Org/ComfyUI/blob/v0.24.0/comfy_execution/jobs.py)
- [ComfyUI security policy](https://github.com/Comfy-Org/ComfyUI/blob/v0.24.0/SECURITY.md)
- [Node.js 20.11 globals](https://nodejs.org/download/release/v20.11.0/docs/api/globals.html)
- [MiniMax H3 license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
