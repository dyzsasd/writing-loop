// ComfyUI adapter contract: bounded protocol parsing, conservative submit ambiguity and safe cancel.
import { createHash } from "node:crypto";
import {
  ComfyUiAdapter, ProductionAdapterError, type FetchLike, type ProductionAdapterErrorCode,
} from "../src/production-adapter.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const json = (value: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  ...init,
});

type SeenCall = { url: URL; init: RequestInit | undefined };

function sequence(items: Array<Response | ((url: URL, init: RequestInit | undefined) => Response | Promise<Response>)>): {
  fetch: FetchLike;
  calls: SeenCall[];
} {
  const calls: SeenCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input : new URL(input);
    calls.push({ url, init });
    const item = items.shift();
    if (!item) throw new Error("unexpected fetch");
    return typeof item === "function" ? item(url, init) : item;
  };
  return { fetch, calls };
}

async function rejectsCode(promise: Promise<unknown>, code: ProductionAdapterErrorCode, causeCode?: ProductionAdapterErrorCode): Promise<boolean> {
  try { await promise; return false; }
  catch (error) {
    return error instanceof ProductionAdapterError && error.code === code
      && (causeCode === undefined || error.causeCode === causeCode);
  }
}

const fixedNow = (): Date => new Date("2026-08-10T12:00:00.000Z");
const UUIDS = {
  accepted: "11111111-1111-4111-8111-111111111111",
  reset: "22222222-2222-4222-8222-222222222222",
  bad: "33333333-3333-4333-8333-333333333333",
  gateway: "44444444-4444-4444-8444-444444444444",
  noId: "55555555-5555-4555-8555-555555555555",
  large: "66666666-6666-4666-8666-666666666666",
  never: "77777777-7777-4777-8777-777777777777",
} as const;
const WORKFLOW: Record<string, unknown> = { "3": { class_type: "KSampler", inputs: { seed: 42 } } };
const legacyJobs404 = (): Response => new Response("404: Not Found", {
  status: 404, headers: { "content-type": "text/html" },
});
const adapter = (fetch: FetchLike, extra: Partial<ConstructorParameters<typeof ComfyUiAdapter>[0]> = {}): ComfyUiAdapter =>
  new ComfyUiAdapter({
    baseUrl: "https://render.internal.example/comfy/",
    backendInstanceId: "comfy-prod-a",
    clientId: "wl-test-client",
    fetch,
    now: fixedNow,
    ...extra,
  });

try {
  new ComfyUiAdapter({ baseUrl: "file:///tmp/comfy", backendInstanceId: "a" });
  ok(false, "adapter 拒绝非 HTTP(S) endpoint");
} catch (error) {
  ok(error instanceof ProductionAdapterError && error.code === "remote-rejected", "adapter 拒绝非 HTTP(S) endpoint");
}
try {
  new ComfyUiAdapter({ baseUrl: "https://token@example.test/comfy", backendInstanceId: "a" });
  ok(false, "adapter 拒绝 URL 内嵌凭据");
} catch (error) {
  ok(error instanceof ProductionAdapterError && error.code === "remote-rejected", "adapter 拒绝 URL 内嵌凭据");
}

{
  const mock = sequence([json({ prompt_id: UUIDS.accepted, number: 7, node_errors: {} })]);
  const client = adapter(mock.fetch);
  const caps = await client.capabilities();
  const result = await client.submit({
    idempotencyKey: "idem-123", remoteJobId: UUIDS.accepted, workflow: WORKFLOW, inputBinding: null,
  });
  const call = mock.calls[0];
  const body = JSON.parse(String(call.init?.body)) as { prompt?: unknown; client_id?: string; prompt_id?: string };
  ok(caps.backendKind === "comfyui" && !caps.providerIdempotency && caps.clientAssignedJobId
    && caps.progressHints === "optional-websocket" && caps.runningCancellation === "version-gated-best-effort",
    "capabilities 不伪造 raw ComfyUI 的幂等与已确认取消能力");
  ok(call.url.toString() === "https://render.internal.example/comfy/prompt"
    && call.init?.method === "POST"
    && call.init?.redirect === "error"
    && new Headers(call.init?.headers).get("x-writing-loop-idempotency-key") === "idem-123"
    && body.client_id === "wl-test-client" && body.prompt_id === UUIDS.accepted && typeof body.prompt === "object",
  "submit 只向受信任 base URL 发送 API-format workflow、预落盘 remote ID 与稳定幂等意图");
  ok(result.remoteJobId === UUIDS.accepted && result.acceptedAt === "2026-08-10T12:00:00.000Z"
    && result.responseDigest.length === 64, "submit 严格投影 prompt_id、时间与响应摘要");
}

{
  const mock = sequence([json({ prompt_id: UUIDS.accepted, number: 8, node_errors: {} })]);
  const client = adapter(mock.fetch);
  const request = {
    idempotencyKey: "idem-prepared-body",
    remoteJobId: UUIDS.accepted,
    workflow: structuredClone(WORKFLOW),
    inputBinding: null,
  };
  const prepared = client.prepareSubmission(request);
  ok(mock.calls.length === 0 && prepared.version === 1
    && prepared.backendInstanceId === "comfy-prod-a"
    && prepared.request.remoteJobId === UUIDS.accepted
    && prepared.request.idempotencyKey === "idem-prepared-body",
  "prepareSubmission 只验证并构造提交 envelope，严格零网络副作用");
  await client.submitPrepared(prepared);
  const body = String(mock.calls[0]?.init?.body ?? "");
  const bodyDigest = createHash("sha256").update(body, "utf8").digest("hex");
  ok(prepared.requestDigest === bodyDigest && JSON.parse(body).prompt_id === UUIDS.accepted,
    "prepared requestDigest 精确等于实际 fetch body UTF-8 bytes 的 SHA-256");
}

{
  const noNetworkA = sequence([]);
  const noNetworkB = sequence([]);
  const clientA = adapter(noNetworkA.fetch, { clientId: "wl-client-a" });
  const clientB = adapter(noNetworkB.fetch, { clientId: "wl-client-b" });
  const base = {
    idempotencyKey: "idem-digest-inputs", remoteJobId: UUIDS.accepted, workflow: WORKFLOW, inputBinding: null,
  };
  const digestA = clientA.prepareSubmission(base).requestDigest;
  const digestRemote = clientA.prepareSubmission({ ...base, remoteJobId: UUIDS.reset }).requestDigest;
  const digestClient = clientB.prepareSubmission(base).requestDigest;
  ok(digestA !== digestRemote && digestA !== digestClient
    && noNetworkA.calls.length === 0 && noNetworkB.calls.length === 0,
  "prepared digest 绑定实际 body 中的 client_id 与预分配 remoteJobId");
}

{
  const mock = sequence([json({ prompt_id: UUIDS.bad })]);
  const client = adapter(mock.fetch);
  const workflow = structuredClone(WORKFLOW);
  const prepared = client.prepareSubmission({
    idempotencyKey: "idem-mutated-workflow", remoteJobId: UUIDS.bad, workflow, inputBinding: null,
  });
  (workflow["3"] as { inputs: { seed: number } }).inputs.seed = 99;
  ok(await rejectsCode(client.submitPrepared(prepared), "remote-rejected") && mock.calls.length === 0,
    "prepare 后 workflow mutation 导致 digest mismatch，并在网络前硬拒绝");
}

{
  const mock = sequence([]);
  const client = adapter(mock.fetch);
  ok(await rejectsCode(client.submit({
    idempotencyKey: "idem-no-direct-stage-binding",
    remoteJobId: UUIDS.bad,
    workflow: structuredClone(WORKFLOW),
    inputBinding: {
      version: 1,
      stageKey: "a".repeat(64),
      bindingsDigest: "b".repeat(64),
      intentDigest: "c".repeat(64),
    },
  }), "remote-rejected") && mock.calls.length === 0,
  "raw ComfyUI adapter 在网络前拒绝 scoped stage binding，绑定只能经私有 Gateway 验真");
}

{
  const mock = sequence([json({ prompt_id: UUIDS.gateway })]);
  const client = adapter(mock.fetch);
  const prepared = client.prepareSubmission({
    idempotencyKey: "idem-forged-envelope", remoteJobId: UUIDS.gateway,
    workflow: structuredClone(WORKFLOW), inputBinding: null,
  });
  const badDigest = { ...prepared, requestDigest: "f".repeat(64) };
  const badRemoteId = { ...prepared, remoteJobId: UUIDS.noId };
  const badKey = { ...prepared, idempotencyKey: "idem-other-envelope" };
  ok(await rejectsCode(client.submitPrepared(badDigest), "remote-rejected")
    && await rejectsCode(client.submitPrepared(badRemoteId), "remote-rejected")
    && await rejectsCode(client.submitPrepared(badKey), "remote-rejected")
    && mock.calls.length === 0,
  "伪造 prepared digest、remote ID 或 idempotency key 均零网络硬拒绝");
}

{
  const sourceMock = sequence([]);
  const targetMock = sequence([json({ prompt_id: UUIDS.large })]);
  const source = adapter(sourceMock.fetch, { backendInstanceId: "comfy-prod-a", clientId: "wl-shared-client" });
  const target = adapter(targetMock.fetch, { backendInstanceId: "comfy-prod-b", clientId: "wl-shared-client" });
  const prepared = source.prepareSubmission({
    idempotencyKey: "idem-cross-backend", remoteJobId: UUIDS.large,
    workflow: structuredClone(WORKFLOW), inputBinding: null,
  });
  ok(await rejectsCode(target.submitPrepared(prepared), "remote-rejected")
    && sourceMock.calls.length === 0 && targetMock.calls.length === 0,
  "另一 backend instance 不能发送不属于自己的 PreparedSubmission");
}

{
  const mock = sequence([new Response(null, {
    status: 307, headers: { location: "http://169.254.169.254/latest/meta-data/" },
  })]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-redirect", remoteJobId: UUIDS.gateway, workflow: WORKFLOW, inputBinding: null,
  }), "submission-unknown") && mock.calls.length === 1 && mock.calls[0].init?.redirect === "error",
  "submit 禁止自动跟随 307/308，绝不把 workflow 重放到 Location 目标");
}

{
  const mock = sequence([() => { throw new Error("ECONNRESET"); }]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-reset", remoteJobId: UUIDS.reset, workflow: WORKFLOW, inputBinding: null,
  }),
    "submission-unknown", "remote-unavailable"),
  "POST 连接异常保守进入 submission-unknown，而非允许盲重试");
}

{
  const mock = sequence([new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } })]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-bad", remoteJobId: UUIDS.bad, workflow: WORKFLOW, inputBinding: null,
  }), "remote-rejected"),
    "确定的 4xx submit 被分类为 remote-rejected");
}

{
  const mock = sequence([new Response("gateway failed", { status: 502, headers: { "content-type": "text/plain" } })]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-502", remoteJobId: UUIDS.gateway, workflow: WORKFLOW, inputBinding: null,
  }), "submission-unknown"),
    "submit 的 5xx 不假定服务端没有产生副作用");
}

{
  const mock = sequence([new Response("proxy timeout", { status: 408, headers: { "content-type": "text/plain" } })]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-408", remoteJobId: UUIDS.gateway, workflow: WORKFLOW, inputBinding: null,
  }), "submission-unknown"), "POST 408 可能掩盖 upstream 已接收，不能分类为安全重试");
}

{
  const mock = sequence([json({ prompt_id: UUIDS.never, node_errors: {} })]);
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled before submit"));
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-pre-abort", remoteJobId: UUIDS.never, workflow: WORKFLOW, inputBinding: null,
  }, controller.signal), "aborted") && mock.calls.length === 0,
  "fetch 前已经 abort 的 submit 保持普通 aborted，且严格零网络副作用");
}

{
  const mock = sequence([json({ accepted: true })]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-no-id", remoteJobId: UUIDS.noId, workflow: WORKFLOW, inputBinding: null,
  }),
    "submission-unknown", "invalid-response"),
  "2xx 缺 prompt_id 时保留歧义，不伪造 remote job ID");
}

{
  const mock = sequence([new Response(JSON.stringify({ prompt_id: UUIDS.large }), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "99999" },
  })]);
  ok(await rejectsCode(adapter(mock.fetch, { maxResponseBytes: 1024 }).submit({
    idempotencyKey: "idem-large", remoteJobId: UUIDS.large, workflow: WORKFLOW, inputBinding: null,
  }),
    "submission-unknown", "response-too-large"),
  "已提交请求的超大响应被限流并保留 submission ambiguity");
}

{
  const mock = sequence([json({
    id: "prompt-modern", status: "pending", priority: 3, outputs_count: 0,
    create_time: 1_754_828_800_000, update_time: 1_754_828_800_100,
  })]);
  const result = await adapter(mock.fetch, { preferJobsApi: true }).inspect("prompt-modern");
  ok(result.state === "pending" && mock.calls.length === 1
    && mock.calls[0].url.pathname === "/comfy/api/jobs/prompt-modern"
    && mock.calls[0].init?.redirect === "error",
  "ComfyUI v0.24+ 使用完整 shape 的单任务 jobs API，inspect 也固定禁止 redirect");
}

{
  const mock = sequence([json({ id: "prompt-modern-bad", status: "toString", priority: 1, outputs_count: 0 })]);
  ok(await rejectsCode(adapter(mock.fetch, { preferJobsApi: true }).inspect("prompt-modern-bad"), "invalid-response"),
    "jobs API status 使用封闭枚举，原型继承名不能绕过校验");
}

{
  const mock = sequence([json({
    id: "prompt-modern-time", status: "pending", priority: 1, outputs_count: 0, create_time: "not-a-timestamp",
  })]);
  ok(await rejectsCode(adapter(mock.fetch, { preferJobsApi: true }).inspect("prompt-modern-time"), "invalid-response"),
    "jobs API 可选时间字段必须是非负有限 number");
}

{
  const secret = "Bearer TOKEN_SECRET https://signed.example/take?token=URL_SECRET 剧本文本";
  const mock = sequence([json({
    id: "prompt-modern-failed", status: "failed", priority: 2, outputs_count: 0,
    execution_error: {
      exception_type: "ValueError",
      exception_message: secret,
      message: "MESSAGE_SECRET",
      traceback: ["TRACEBACK_SECRET"],
    },
  })]);
  const result = await adapter(mock.fetch, { preferJobsApi: true }).inspect("prompt-modern-failed");
  const projected = JSON.stringify(result);
  ok(result.state === "failed" && result.errorSummary === "execution_error:ValueError"
    && !projected.includes("TOKEN_SECRET") && !projected.includes("URL_SECRET")
    && !projected.includes("剧本文本") && !projected.includes("MESSAGE_SECRET")
    && !projected.includes("TRACEBACK_SECRET"),
  "jobs errorSummary 只保留稳定类别与 allowlisted exception_type，不投影消息、URL、token 或正文");
}

{
  const mock = sequence([json({ error: "Job not found" }, { status: 404 })]);
  const result = await adapter(mock.fetch, { preferJobsApi: true }).inspect("prompt-modern-missing");
  ok(result.state === "not-found" && mock.calls.length === 1,
    "jobs API 精确 JSON 404 被识别为受支持的 remote-missing observation，不降级猜测");
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({
    "prompt-done": {
      status: { completed: true, status_str: "success" },
      outputs: {
        "9": { images: [{ filename: "take-01.png", subfolder: "shots/ep01", type: "output" }] },
        "10": { audio: [{ filename: "take-01.wav", subfolder: "audio", type: "output" }] },
      },
    },
  })]);
  const result = await adapter(mock.fetch).inspect("prompt-done");
  ok(result.state === "succeeded" && result.outputs.length === 2
    && result.outputs[0].kind === "image" && result.outputs[1].kind === "audio"
    && result.outputs.every((row) => !("url" in row)),
  "history success 只返回有界 remote locator，不拼接下载 URL");
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({
    "prompt-failed": {
      status: { completed: true, status_str: "error STATUS_SECRET https://signed.example/a?token=URL_SECRET <script>" },
      outputs: {},
    },
  })]);
  const result = await adapter(mock.fetch).inspect("prompt-failed");
  const projected = JSON.stringify(result);
  ok(result.state === "failed" && result.errorSummary === "execution_error"
    && !projected.includes("STATUS_SECRET") && !projected.includes("URL_SECRET") && !projected.includes("<script>"),
  "legacy status_str 只决定稳定失败类别，原始状态文本不会进入投影");
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({
    "prompt-unsafe-type": {
      status: {
        completed: true,
        messages: [["execution_error", {
          exception_type: "BearerSecretError",
          exception_message: "TOKEN_SECRET",
          message: "MESSAGE_SECRET",
        }]],
      },
      outputs: {},
    },
  })]);
  const result = await adapter(mock.fetch).inspect("prompt-unsafe-type");
  ok(result.state === "failed" && result.errorSummary === "execution_error"
    && !JSON.stringify(result).includes("BearerSecretError") && !JSON.stringify(result).includes("TOKEN_SECRET"),
  "未知或可疑 exception_type 降级为稳定类别，不能借类型字段夹带敏感文本");
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({
    "prompt-interrupted": {
      status: {
        completed: true,
        status_str: "error",
        messages: [["execution_interrupted", { prompt_id: "prompt-interrupted", traceback: ["SECRET"] }]],
      },
      outputs: {},
    },
  })]);
  const result = await adapter(mock.fetch).inspect("prompt-interrupted");
  ok(result.state === "cancelled" && result.errorSummary === "execution_interrupted"
    && !JSON.stringify(result).includes("SECRET"),
  "history 用 terminal message 区分 interrupted，且不投影 traceback/current inputs");
}

for (const [queueKey, expected] of [["queue_running", "running"], ["queue_pending", "pending"]] as const) {
  const queue = { queue_running: [], queue_pending: [] } as Record<string, unknown[]>;
  queue[queueKey] = [[1, "prompt-queue", {}, {}, []]];
  const mock = sequence([json(queue), json({})]);
  const result = await adapter(mock.fetch).inspect("prompt-queue");
  ok(result.state === expected && mock.calls.map((call) => call.url.pathname).join(",")
    === "/comfy/queue,/comfy/history/prompt-queue",
    `queue→history 完整对账为 ${expected}，避免完成转移竞态`);
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({})]);
  const result = await adapter(mock.fetch).inspect("prompt-gone");
  ok(result.state === "not-found", "history 与 queue 均无记录时只报告 not-found，不擅自写 failed/orphaned");
}

{
  const duplicate = [[1, "prompt-duplicate", {}, {}, []], [2, "prompt-duplicate", {}, {}, []]];
  const mock = sequence([json({ queue_running: duplicate, queue_pending: [] })]);
  ok(await rejectsCode(adapter(mock.fetch).inspect("prompt-duplicate"), "invalid-response"),
    "同一 prompt_id 在 queue 出现两次时硬停，暴露潜在重复计费");
}

{
  const mock = sequence([
    json({ queue_running: [[1, "prompt-conflict", {}, {}, []]], queue_pending: [] }),
    json({ "prompt-conflict": { status: { completed: true, status_str: "success" }, outputs: {} } }),
    json({ queue_running: [[1, "prompt-conflict", {}, {}, []]], queue_pending: [] }),
  ]);
  ok(await rejectsCode(adapter(mock.fetch).inspect("prompt-conflict"), "invalid-response"),
    "同一 prompt_id 持续位于 terminal history 与 queue 时拒绝重复计费冲突");
}

{
  const mock = sequence([
    json({ queue_running: [[1, "prompt-race", {}, {}, []]], queue_pending: [] }),
    json({ "prompt-race": { status: { completed: true, status_str: "success" }, outputs: {} } }),
    json({ queue_running: [], queue_pending: [] }),
  ]);
  const result = await adapter(mock.fetch).inspect("prompt-race");
  ok(result.state === "succeeded" && mock.calls.length === 3,
    "queue₁→history₂ 的正常完成竞态经 queue₃ 消失确认，不误报重复任务");
}

{
  const neverEnding = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
  const mock = sequence([new Response(neverEnding, { status: 200, headers: { "content-type": "application/json" } })]);
  ok(await rejectsCode(adapter(mock.fetch, { timeoutMs: 50 }).inspect("prompt-slow"), "remote-unavailable"),
    "timeout 覆盖响应体读取，远端只发 headers 不能永久占住 reconciler");
}

{
  const startedAt = Date.now();
  const delayedHeadersThenHangingBody: FetchLike = (_input, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    const headersTimer = setTimeout(() => {
      const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
      resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    }, 150);
    const abort = (): void => {
      clearTimeout(headersTimer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  const rejected = await rejectsCode(
    adapter(delayedHeadersThenHangingBody, { timeoutMs: 240 }).inspect("prompt-shared-deadline"),
    "remote-unavailable",
  );
  const elapsedMs = Date.now() - startedAt;
  ok(rejected && elapsedMs < 325,
    `headers+body 共用一个 240ms 绝对 deadline，不在 headers 后重置计时器（${elapsedMs}ms）`);
}

{
  const mock = sequence([json({ queue_running: [], queue_pending: [] }), json({
    "prompt-path": {
      status: { completed: true, status_str: "success" },
      outputs: { "1": { images: [{ filename: "../secret", subfolder: "", type: "output" }] } },
    },
  })]);
  ok(await rejectsCode(adapter(mock.fetch).inspect("prompt-path"), "invalid-response"),
    "history output locator 拒绝路径穿越");
}

{
  const mock = sequence([
    json({ id: "prompt-pending", status: "in_progress", priority: 1, outputs_count: 0 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 204 }),
  ]);
  const result = await adapter(mock.fetch).cancel("prompt-pending");
  const [, queueCall, interruptCall] = mock.calls;
  ok(queueCall.url.pathname === "/comfy/queue" && queueCall.init?.method === "POST"
    && JSON.parse(String(queueCall.init?.body)).delete[0] === "prompt-pending"
    && result.accepted && !result.confirmed && result.runningInterruptRequested
    && mock.calls.every((call) => call.init?.redirect === "error"),
  "cancel 只请求删除指定 queue item，且不把请求伪装成已取消");
  ok(interruptCall.url.pathname === "/comfy/interrupt"
    && JSON.parse(String(interruptCall.init?.body)).prompt_id === "prompt-pending",
    "运行中取消使用带 prompt_id 的定向 best-effort interrupt");
}

{
  const mock = sequence([json({ id: "prompt-incomplete", status: "in_progress", priority: 1 })]);
  ok(await rejectsCode(adapter(mock.fetch).cancel("prompt-incomplete"), "invalid-response")
    && mock.calls.length === 1 && mock.calls[0].url.pathname === "/comfy/api/jobs/prompt-incomplete"
    && mock.calls[0].init?.redirect === "error",
  "不完整 jobs DTO 不能证明 targeted interrupt 能力，取消在 /queue 与 /interrupt 前硬停");
}

{
  const mock = sequence([legacyJobs404(), new Response(null, { status: 204 })]);
  const result = await adapter(mock.fetch).cancel("prompt-legacy");
  ok(result.accepted && !result.runningInterruptRequested
    && mock.calls.map((call) => call.url.pathname).join(",") === "/comfy/api/jobs/prompt-legacy,/comfy/queue"
    && mock.calls.every((call) => call.init?.redirect === "error"),
  "legacy ComfyUI 只删除 pending queue item，绝不冒险调用可能是实例级的 /interrupt");
}

{
  const mock = sequence([json({})]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "bad key", remoteJobId: UUIDS.never, workflow: WORKFLOW, inputBinding: null,
  }), "remote-rejected")
    && mock.calls.length === 0, "无效 idempotency key 在网络前被拒绝");
}

{
  const mock = sequence([json({})]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-invalid-graph", remoteJobId: UUIDS.never,
    workflow: { "1": { class_type: "KSampler", inputs: { seed: Number.NaN } } },
    inputBinding: null,
  }), "remote-rejected") && mock.calls.length === 0,
  "非 API-format/非 JSON-safe workflow 在网络前被拒绝");
}

{
  const mock = sequence([json({})]);
  ok(await rejectsCode(adapter(mock.fetch).submit({
    idempotencyKey: "idem-invalid-uuid", remoteJobId: "prompt-not-a-uuid", workflow: WORKFLOW,
    inputBinding: null,
  }), "remote-rejected") && mock.calls.length === 0,
  "ComfyUI submit 只接受已持久化 canonical UUID remoteJobId");
}

console.log(fails === 0 ? "\nPRODUCTION_ADAPTER_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
