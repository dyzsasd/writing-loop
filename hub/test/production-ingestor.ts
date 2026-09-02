// Trusted asset-gateway ingestor: stable keys, strict DTOs, bounded I/O and safe errors.
import { createHash } from "node:crypto";
import {
  taskFromCreate,
  transitionProductionTask,
  type AssetRef,
  type ProductionTask,
  type ProductionTaskCreate,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import type { FetchLike, RemoteObservation, RemoteOutputLocator } from "../src/production-adapter.ts";
import {
  HttpProductionArtifactIngestor,
  ProductionIngestorError,
  productionIngestKey,
  productionScopedIngestKey,
  type HttpProductionArtifactIngestorOptions,
  type ProductionGatewayCredentialContext,
  type ProductionGatewayIngestRequest,
} from "../src/production-ingestor.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const REMOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT = "short-drama";
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;

const sourceAsset = (uri: string, digest: string): AssetRef => ({
  version: 1,
  uri,
  sha256: digest,
  byteLength: 123,
  mediaType: "application/json",
});

const createTask = (id: string): ProductionTaskCreate => ({
  version: 1,
  id,
  idempotencyKey: `idem-${id}`,
  subject: {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: {
        version: 1,
        episodeId: "ep-001",
        revision: 2,
        source: sourceAsset("s3://writing-loop-assets/demo/episode-001.json", SHA_A),
      },
      shotId: "shot-001",
      revision: 3,
      source: sourceAsset("s3://writing-loop-assets/demo/shot-001.json", SHA_B),
    },
  },
  createdAt: at(0),
});

function event(
  task: ProductionTask,
  type: ProductionTaskEvent["type"],
  id: string,
  second: number,
  extra: Record<string, unknown> = {},
): ProductionTaskEvent {
  return {
    version: 1,
    type,
    eventId: id,
    taskId: task.id,
    expectedRevision: task.revision,
    occurredAt: at(second),
    ...extra,
  } as ProductionTaskEvent;
}

function ingestingTask(backendInstanceId = "comfy-prod-a", id = "take-001"): ProductionTask {
  let task = taskFromCreate(createTask(id));
  task = transitionProductionTask(task, event(task, "dispatch-requested", `${id}-dispatch`, 1));
  task = transitionProductionTask(task, event(task, "submission-started", `${id}-submit`, 2, {
    backendInstanceId,
    remoteJobId: REMOTE_ID,
    requestDigest: SHA_C,
  }));
  task = transitionProductionTask(task, event(task, "submission-confirmed", `${id}-confirmed`, 3, {
    backendInstanceId,
    remoteJobId: REMOTE_ID,
  }));
  return transitionProductionTask(task, event(task, "ingestion-started", `${id}-ingest`, 4));
}

const LOCATORS: RemoteOutputLocator[] = [
  { nodeId: "9", kind: "audio", filename: "take.wav", subfolder: "audio", folderType: "output" },
  { nodeId: "7", kind: "video", filename: "take.mp4", subfolder: "video/final", folderType: "output" },
];

const observation = (outputs: RemoteOutputLocator[] = LOCATORS): RemoteObservation => ({
  remoteJobId: REMOTE_ID,
  state: "succeeded",
  observedAt: at(5),
  outputs,
  errorSummary: null,
  responseDigest: SHA_B,
});

const outputAsset = (uri = "s3://writing-loop-assets/demo/take-001.mp4"): AssetRef => ({
  version: 1,
  uri,
  sha256: SHA_C,
  byteLength: 4_096,
  mediaType: "video/mp4",
});

const successPayload = (ingestKey: string, assets: AssetRef[] = [outputAsset()]): unknown => ({
  version: 1,
  ingestKey,
  assets,
  cost: { version: 1, state: "known", currency: "USD", amountMicros: 123_000, basis: "reported" },
});

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<ProductionIngestorError | null> {
  try { await operation(); return null; }
  catch (error) { return error instanceof ProductionIngestorError ? error : null; }
}

const task = ingestingTask();
const forwardKey = productionIngestKey(task, observation());
const reverseKey = productionIngestKey(task, observation([...LOCATORS].reverse()));
const otherBackendKey = productionIngestKey(ingestingTask("comfy-prod-b"), observation());
const scopedForwardKey = productionScopedIngestKey(WORKSPACE_ID, PROJECT, task, observation());
const scopedReverseKey = productionScopedIngestKey(
  WORKSPACE_ID, PROJECT, task, observation([...LOCATORS].reverse()),
);
const otherScopeKey = productionScopedIngestKey(OTHER_WORKSPACE_ID, PROJECT, task, observation());
ok(forwardKey === reverseKey && /^[a-f0-9]{64}$/.test(forwardKey),
  "ingestKey 对 locator 顺序稳定并使用 canonical sha256");
ok(forwardKey !== otherBackendKey,
  "相同 remoteJobId/outputs 在不同 backend instance 上生成不同 ingestKey");
ok(scopedForwardKey === scopedReverseKey && scopedForwardKey !== otherScopeKey,
  "相同 task/digest 在同 scope 稳定、跨 scope 生成不同 ingestKey");

const secureOptions = {
  workspaceId: WORKSPACE_ID,
  project: PROJECT,
  credentialResolver: () => "TOKEN_SECRET",
} as const;

const calls: FetchCall[] = [];
const happyFetch: FetchLike = async (input, init = {}) => {
  const request = JSON.parse(String(init.body)) as ProductionGatewayIngestRequest;
  calls.push({ url: String(input), init });
  return jsonResponse(successPayload(request.ingestKey));
};
const happy = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example/private/",
  fetch: happyFetch,
});
const happyResult = await happy.ingest(task, observation());
const happyRequest = JSON.parse(String(calls[0]?.init.body)) as ProductionGatewayIngestRequest;
ok(happyResult.ingestKey === scopedForwardKey && happyResult.assets[0]?.uri === outputAsset().uri
  && happyResult.cost.state === "known", "合法 gateway DTO 被严格解析为 AssetRef + cost");
ok(calls.length === 1 && calls[0]?.init.method === "PUT" && calls[0]?.init.redirect === "error"
  && calls[0]?.url.endsWith(
    `/private/v1/scopes/${WORKSPACE_ID}/${PROJECT}/ingests/${scopedForwardKey}`,
  )
  && new Headers(calls[0]?.init.headers).get("authorization") === "Bearer TOKEN_SECRET"
  && new Headers(calls[0]?.init.headers).get("x-writing-loop-idempotency-key") === scopedForwardKey,
"ingestor 使用受信任路径、幂等 PUT、redirect:error 与旋转 credential");
ok(happyRequest.taskId === task.id && happyRequest.idempotencyKey === task.idempotencyKey
  && happyRequest.scope.workspaceId === WORKSPACE_ID && happyRequest.scope.project === PROJECT
  && happyRequest.backendInstanceId === task.backendInstanceId && happyRequest.remoteJobId === task.remoteJobId
  && happyRequest.responseDigest === observation().responseDigest && happyRequest.locators.length === 2
  && !Object.prototype.hasOwnProperty.call(happyRequest, "workflow")
  && !Object.prototype.hasOwnProperty.call(happyRequest, "uri"),
"请求只携稳定 task/remote identity、digest 与 remote locator，不上传 workflow/签名地址");

const secondResult = await happy.ingest(task, observation([...LOCATORS].reverse()));
ok(secondResult.ingestKey === happyResult.ingestKey && calls.length === 2
  && calls[1]?.url === calls[0]?.url,
"同一输入的重复 PUT 复用完全相同 ingestKey，允许 coordinator 安全重试 ingest");

let rotatedToken = "TOKEN_ONE";
const credentialContexts: ProductionGatewayCredentialContext[] = [];
const rotationHeaders: string[] = [];
const rotating = new HttpProductionArtifactIngestor({
  baseUrl: "https://asset-gateway.example",
  workspaceId: WORKSPACE_ID,
  project: PROJECT,
  credentialResolver: (context) => {
    credentialContexts.push({ ...context });
    return rotatedToken;
  },
  fetch: async (_input, init) => {
    rotationHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
    const request = JSON.parse(String(init?.body)) as ProductionGatewayIngestRequest;
    return jsonResponse(successPayload(request.ingestKey));
  },
});
await rotating.ingest(task, observation());
rotatedToken = "TOKEN_TWO";
await rotating.ingest(task, observation());
ok(rotationHeaders.join(",") === "Bearer TOKEN_ONE,Bearer TOKEN_TWO"
  && credentialContexts.length === 2
  && credentialContexts.every((context) => context.workspaceId === WORKSPACE_ID
    && context.project === PROJECT && context.operation === "ingest"),
"credential 每次请求重新解析，并收到精确 workspace/project/operation 上下文");

let insecureFetches = 0;
let publicHttpRejected = false;
try {
  new HttpProductionArtifactIngestor({
    baseUrl: "http://10.0.0.10:8787",
    workspaceId: WORKSPACE_ID,
    project: PROJECT,
    allowInsecureLoopback: true,
    fetch: async () => { insecureFetches++; return jsonResponse({}); },
  });
} catch (error) { publicHttpRejected = error instanceof ProductionIngestorError; }
let loopbackBearerRejected = false;
try {
  new HttpProductionArtifactIngestor({
    ...secureOptions,
    baseUrl: "http://127.0.0.1:8787",
    allowInsecureLoopback: true,
    fetch: async () => { insecureFetches++; return jsonResponse({}); },
  });
} catch (error) { loopbackBearerRejected = error instanceof ProductionIngestorError; }
const loopbackHeaders: Headers[] = [];
const loopbackDev = new HttpProductionArtifactIngestor({
  baseUrl: "http://127.0.0.1:8787",
  workspaceId: WORKSPACE_ID,
  project: PROJECT,
  allowInsecureLoopback: true,
  fetch: async (_input, init) => {
    insecureFetches++;
    loopbackHeaders.push(new Headers(init?.headers));
    const request = JSON.parse(String(init?.body)) as ProductionGatewayIngestRequest;
    return jsonResponse(successPayload(request.ingestKey));
  },
});
await loopbackDev.ingest(task, observation());
ok(publicHttpRejected && loopbackBearerRejected && insecureFetches === 1
  && !loopbackHeaders[0]?.has("authorization"),
"public HTTP 与 loopback bearer 在 constructor/fetch 前拒绝；显式 loopback dev 永不发送 bearer");

let redirectInit: RequestInit | undefined;
const redirectSecret = "REDIRECT_TOKEN_SECRET";
const redirecting = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  fetch: async (_input, init) => {
    redirectInit = init;
    throw new TypeError(`redirect to https://evil.example/?token=${redirectSecret}`);
  },
});
const redirectError = await captureError(() => redirecting.ingest(task, observation()));
ok(redirectError?.code === "gateway-unavailable" && redirectInit?.redirect === "error"
  && !redirectError.message.includes(redirectSecret),
"redirect 被 fetch 层禁止，重定向 URL/token 不进入稳定错误");

const timeoutStart = Date.now();
const hanging = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  timeoutMs: 60,
  fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }),
});
const timeoutError = await captureError(() => hanging.ingest(task, observation()));
ok(timeoutError?.code === "gateway-unavailable" && Date.now() - timeoutStart < 1_000,
  "headers 永久挂起受绝对 deadline 约束且只暴露固定 unavailable 类别");

const absoluteStart = Date.now();
const absolute = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  timeoutMs: 120,
  fetch: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(successPayload(scopedForwardKey))));
            controller.close();
          } catch { /* deadline cancellation already closed the stream */ }
        }, 100);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  },
});
const absoluteError = await captureError(() => absolute.ingest(task, observation()));
const absoluteElapsed = Date.now() - absoluteStart;
ok(absoluteError?.code === "gateway-unavailable" && absoluteElapsed < 165,
  `headers+body 共用一个绝对 deadline，不在收到 headers 后重置（${absoluteElapsed}ms）`);

const oversizedByHeader = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  maxResponseBytes: 1_024,
  fetch: async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "2048" },
  }),
});
ok((await captureError(() => oversizedByHeader.ingest(task, observation())))?.code === "response-too-large",
  "声明 Content-Length 超限时不读取 body 并返回固定 oversize 类别");

const oversizedStream = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  maxResponseBytes: 1_024,
  fetch: async () => new Response(new Uint8Array(1_025), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
ok((await captureError(() => oversizedStream.ingest(task, observation())))?.code === "response-too-large",
  "无 Content-Length 的流式响应也按累计 bytes 硬截断");

const badMime = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  fetch: async () => new Response(JSON.stringify(successPayload(scopedForwardKey)), {
    status: 200,
    headers: { "content-type": "text/plain" },
  }),
});
ok((await captureError(() => badMime.ingest(task, observation())))?.code === "invalid-response",
  "成功响应必须使用严格 application/json Content-Type");

const badJson = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  fetch: async () => new Response("{broken", {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
});
ok((await captureError(() => badJson.ingest(task, observation())))?.code === "invalid-response",
  "无效 JSON 被拒绝且不降级为空结果");

const responseCase = async (payload: (key: string) => unknown): Promise<ProductionIngestorError | null> => {
  const ingestor = new HttpProductionArtifactIngestor({
    ...secureOptions,
    baseUrl: "https://asset-gateway.example",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as ProductionGatewayIngestRequest;
      return jsonResponse(payload(request.ingestKey));
    },
  });
  return await captureError(() => ingestor.ingest(task, observation()));
};

ok((await responseCase((key) => ({ ...successPayload(key) as object, extra: true })))?.code === "invalid-response",
  "gateway response 顶层未知字段被 strict DTO 拒绝");
ok((await responseCase(() => successPayload(SHA_A)))?.code === "invalid-response",
  "gateway 返回不匹配的 ingestKey 被拒绝");
ok((await responseCase((key) => successPayload(key, [])))?.code === "invalid-response",
  "空 assets 不得推进到 qc-pending");
ok((await responseCase((key) => successPayload(key, [outputAsset(), outputAsset()])))?.code === "invalid-response",
  "重复 AssetRef URI 被拒绝");

const signedSecret = "SIGNED_URL_TOKEN_SECRET";
const signedError = await responseCase((key) => successPayload(key, [
  outputAsset(`https://assets.example/take.mp4?token=${signedSecret}`),
]));
ok(signedError?.code === "invalid-response" && !signedError.message.includes(signedSecret),
  "signed URL AssetRef 被 domain parser 拒绝且 token 不进入错误");
ok((await responseCase((key) => successPayload(key, [outputAsset("file:///tmp/take.mp4")])))?.code === "invalid-response",
  "本机 file URI 不能由私有 gateway 冒充稳定 AssetRef");

const gatewaySecret = "GATEWAY_BODY_TOKEN_SECRET";
const secretResponse = await responseCase((key) => ({
  ...successPayload(key) as object,
  message: `https://gateway.example/error?token=${gatewaySecret}`,
}));
ok(secretResponse?.code === "invalid-response"
  && !secretResponse.message.includes(gatewaySecret)
  && !JSON.stringify(secretResponse).includes(gatewaySecret),
"gateway message/URL/token 不会穿过固定错误分类");

const credentialSecret = "CREDENTIAL_RESOLVER_TOKEN_SECRET";
const credentialFailure = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  credentialResolver: () => { throw new Error(`token=${credentialSecret}`); },
  fetch: async () => { throw new Error("must not fetch"); },
});
const credentialError = await captureError(() => credentialFailure.ingest(task, observation()));
ok(credentialError?.code === "credential-unavailable"
  && !credentialError.message.includes(credentialSecret)
  && !JSON.stringify(credentialError).includes(credentialSecret),
"credential resolver 原始异常与 token 不进入错误对象，且网络前失败");

const requestDigest = createHash("sha256").update(JSON.stringify(happyRequest.locators)).digest("hex");
ok(/^[a-f0-9]{64}$/.test(happyRequest.taskIdentityDigest) && /^[a-f0-9]{64}$/.test(requestDigest),
  "gateway request 对 task identity 和 canonical locator 都只使用稳定内容身份");

const wrongRemote = { ...observation(), remoteJobId: "22222222-2222-4222-8222-222222222222" };
const inputCalls: FetchCall[] = [];
const inputGuard = new HttpProductionArtifactIngestor({
  ...secureOptions,
  baseUrl: "https://asset-gateway.example",
  fetch: async (input, init = {}) => { inputCalls.push({ url: String(input), init }); return jsonResponse({}); },
});
ok((await captureError(() => inputGuard.ingest(task, wrongRemote)))?.code === "invalid-input"
  && inputCalls.length === 0,
"observation remoteJobId 不匹配时在 credential/network 前拒绝");

// §8.0 owner-only transport: VPC 私网明文 HTTP 只在「私网字面 IP + 非空 bearer」下成立，
// 且不放宽既有 allowInsecureLoopback（无凭据 loopback 开发通道）的语义。
const transportCredential = (): string => "PRIVATE_NET_TOKEN";
const constructed = (options: Partial<HttpProductionArtifactIngestorOptions>): boolean => {
  try {
    new HttpProductionArtifactIngestor({
      baseUrl: "https://gateway.example",
      workspaceId: WORKSPACE_ID,
      project: PROJECT,
      fetch: async () => jsonResponse({}),
      ...options,
    });
    return true;
  } catch { return false; }
};
ok(constructed({
  baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http",
  credentialResolver: transportCredential,
}), "ingestor：insecure-private-http + RFC1918 字面 IP + credential 被接受");
ok(!constructed({
  baseUrl: "http://203.0.113.9:8790", transport: "insecure-private-http",
  credentialResolver: transportCredential,
}), "ingestor：insecure-private-http 拒绝公网 IP endpoint");
ok(!constructed({
  baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http",
}), "ingestor：insecure-private-http 缺 credentialResolver 时拒绝");
ok(!constructed({
  baseUrl: "http://10.148.0.9:8790", credentialResolver: transportCredential,
}), "ingestor：缺省 transport 仍要求 HTTPS，私网明文 http 被拒");

if (fails) {
  console.error(`PRODUCTION_INGESTOR_FAILED ${fails}`);
  process.exit(1);
}
console.log("PRODUCTION_INGESTOR_OK");
