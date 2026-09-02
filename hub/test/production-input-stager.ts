// Trusted input-staging boundary: canonical identities, strict bindings, scoped bounded HTTP.
import { createHash } from "node:crypto";
import type { AssetRef } from "../src/production-domain.ts";
import type { FetchLike } from "../src/production-adapter.ts";
import {
  createProductionDispatchIntent,
  type ProductionDispatchIntent,
  type ProductionIntentDraft,
} from "../src/production-intent.ts";
import {
  HttpProductionInputStager,
  ProductionInputStagerError,
  parseProductionInputStageResult,
  parseProductionWorkflowBindingVerification,
  productionInputBindingsDigest,
  productionInputStageKey,
  type HttpProductionInputStagerOptions,
  type ProductionInputBinding,
  type ProductionInputStageRequest,
  type ProductionInputStageResult,
} from "../src/production-input-stager.ts";
import { productionCanonicalJsonSha256 } from "../src/production-canonical-json.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT = "paper-moon";
const SHA = {
  a: "a".repeat(64),
  b: "b".repeat(64),
  c: "c".repeat(64),
  d: "d".repeat(64),
  e: "e".repeat(64),
};
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;

function asset(name: string, digest: string, mediaType: string): AssetRef {
  return {
    version: 1,
    uri: `s3://writing-loop-assets/input-staging/${name}`,
    sha256: digest,
    byteLength: 1_024,
    mediaType,
  };
}

function intentFor(id = "take-001", inputs: AssetRef[] = [
  asset("first.png", SHA.a, "image/png"),
  asset("voice.wav", SHA.b, "audio/wav"),
]): ProductionDispatchIntent {
  const draft: ProductionIntentDraft = {
    version: 1,
    taskId: id,
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "episode-001",
          revision: 2,
          source: asset("episode.json", SHA.c, "application/json"),
        },
        shotId: "shot-001",
        revision: 3,
        source: asset("shot.json", SHA.d, "application/json"),
      },
    },
    createdAt: at(0),
    useTerritories: ["CN"],
    execution: {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "generic",
      backendInstanceId: "comfy-prod-a",
      workflowSha256: SHA.a,
      modelSha256: SHA.b,
      parametersSha256: SHA.c,
    },
    inputs,
    budget: { version: 1, currency: "USD", estimatedAmountMicros: 100_000, maximumAmountMicros: 100_000 },
    rights: {
      version: 1,
      status: "cleared",
      territories: ["CN"],
      evidence: asset("rights.json", SHA.c, "application/json"),
      expiresAt: null,
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: at(1),
      evidence: asset("moderation.json", SHA.d, "application/json"),
    },
    license: {
      version: 1,
      status: "verified",
      basis: "provider-terms",
      territories: ["CN"],
      licenseSha256: SHA.e,
      evidence: asset("license.txt", SHA.e, "text/plain"),
      issuedBy: "private-provider",
      issuedAt: at(0),
      expiresAt: null,
    },
  };
  return createProductionDispatchIntent(draft);
}

function bindingsFor(intent: ProductionDispatchIntent): ProductionInputBinding[] {
  return intent.inputs.map((input, index) => ({
    index,
    slot: index === 0 ? "first_frame" : `reference_audio.${index}`,
    assetSha256: input.sha256,
    providerObjectKey: `writing-loop/${intent.taskId}/${index}-${input.sha256.slice(0, 12)}.bin`,
  }));
}

function resultFor(intent: ProductionDispatchIntent, stageKey: string): ProductionInputStageResult {
  const bindings = bindingsFor(intent);
  return {
    version: 1,
    stageKey,
    bindingsDigest: productionInputBindingsDigest(bindings),
    bindings,
    shotRequest: null,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<ProductionInputStagerError | null> {
  try { await operation(); return null; }
  catch (error) { return error instanceof ProductionInputStagerError ? error : null; }
}

function throwsCode(operation: () => unknown, code: ProductionInputStagerError["code"]): boolean {
  try { operation(); return false; }
  catch (error) { return error instanceof ProductionInputStagerError && error.code === code; }
}

const intent = intentFor();
const key = productionInputStageKey(WS, PROJECT, intent);
ok(/^[a-f0-9]{64}$/.test(key)
  && key === productionInputStageKey(WS, PROJECT, structuredClone(intent)),
"stageKey 对相同 scope + immutable intent + 有序 inputs 确定且稳定");
ok(key !== productionInputStageKey(`${WS}-other`, PROJECT, intent)
  && key !== productionInputStageKey(WS, "other", intent)
  && key !== productionInputStageKey(WS, PROJECT, intentFor("take-001", [...intent.inputs].reverse())),
"stageKey 绑定 workspace/project 与 AssetRef 顺序，跨 scope/顺序不会碰撞");

type FetchCall = { url: string; init: RequestInit; request: ProductionInputStageRequest };
const calls: FetchCall[] = [];
const happyFetch: FetchLike = async (input, init = {}) => {
  const request = JSON.parse(String(init.body)) as ProductionInputStageRequest;
  calls.push({ url: String(input), init, request });
  return jsonResponse(resultFor(intent, request.stageKey));
};
const happy = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example/private/",
  workspaceId: WS,
  project: PROJECT,
  credentialResolver: () => "STAGING_TOKEN_SECRET",
  fetch: happyFetch,
});
const staged = await happy.stage(intent);
const request = calls[0]!.request;
ok(staged.stageKey === key && staged.bindings.length === intent.inputs.length
  && staged.bindings[0]?.slot === "first_frame", "合法 v1 gateway response 返回完整 semantic bindings");
ok(calls.length === 1 && calls[0]?.init.method === "PUT" && calls[0]?.init.redirect === "error"
  && calls[0]?.url.endsWith(`/private/v1/scopes/${WS}/${PROJECT}/stages/${key}`)
  && new Headers(calls[0]?.init.headers).get("authorization") === "Bearer STAGING_TOKEN_SECRET"
  && new Headers(calls[0]?.init.headers).get("x-writing-loop-idempotency-key") === key,
"HTTP stager 使用 server-owned scoped path、幂等 PUT、旋转 credential 与 redirect:error");
ok(JSON.stringify(Object.keys(request).sort()) === JSON.stringify([
  "execution", "inputs", "intentDigest", "scope", "stageKey", "taskId", "version",
]) && request.scope.workspaceId === WS && request.scope.project === PROJECT
  && request.taskId === intent.taskId && request.intentDigest === intent.idempotencyKey
  && JSON.stringify(request.execution) === JSON.stringify(intent.execution)
  && request.inputs.every((row, index) => row.index === index
    && JSON.stringify(row.asset) === JSON.stringify(intent.inputs[index]))
  && !Object.prototype.hasOwnProperty.call(request, "url")
  && !Object.prototype.hasOwnProperty.call(request, "endpoint")
  && !Object.prototype.hasOwnProperty.call(request, "headers"),
"请求 body 只含 scope/task/intent 摘要和有序稳定 AssetRef identity，不接受任意 endpoint/header");
const stagedAgain = await happy.stage(intent);
ok(stagedAgain.stageKey === staged.stageKey && calls.length === 2 && calls[1]?.url === calls[0]?.url
  && JSON.stringify(calls[1]?.request) === JSON.stringify(calls[0]?.request),
"同一 intent 重试复用完全相同 stageKey、路径与请求 bytes");

const valid = resultFor(intent, key);
for (const [name, drift] of [
  ["unknown-field", { ...valid, endpoint: "https://evil.invalid" }],
  ["stage-key", { ...valid, stageKey: SHA.e }],
  ["digest", { ...valid, bindingsDigest: SHA.e }],
  ["coverage", { ...valid, bindings: valid.bindings.slice(1) }],
  ["index-order", { ...valid, bindings: [...valid.bindings].reverse() }],
  ["asset-sha", { ...valid, bindings: valid.bindings.map((row, index) => index === 0 ? { ...row, assetSha256: SHA.e } : row) }],
  ["unsafe-object-key", { ...valid, bindings: valid.bindings.map((row, index) => index === 0
    ? { ...row, providerObjectKey: "../escape?token=secret" } : row) }],
  ["duplicate-slot", { ...valid, bindings: valid.bindings.map((row) => ({ ...row, slot: "same" })) }],
] as const) {
  const rejected = await captureError(async () => parseProductionInputStageResult(drift, intent, key));
  ok(rejected?.code === "invalid-response", `response drift ${name} 在 coordinator trust boundary fail-closed`);
}

let scopedCall: FetchCall | null = null;
const scopedProject = "other-project";
const scopedKey = productionInputStageKey(WS, scopedProject, intent);
const scoped = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example/private/",
  workspaceId: WS,
  project: scopedProject,
  fetch: async (input, init = {}) => {
    const scopedRequest = JSON.parse(String(init.body)) as ProductionInputStageRequest;
    scopedCall = { url: String(input), init, request: scopedRequest };
    return jsonResponse(resultFor(intent, scopedRequest.stageKey));
  },
});
await scoped.stage(intent);
const capturedScoped = scopedCall as FetchCall | null;
ok(capturedScoped !== null && capturedScoped.request.scope.project === scopedProject
  && capturedScoped.request.stageKey === scopedKey
  && capturedScoped.url.includes(`/scopes/${WS}/${scopedProject}/stages/${scopedKey}`),
"workspace/project scope 同时进入 stageKey、固定路径与 request body");

const templateWorkflow = { node: "trusted" };
const boundWorkflow = { node: "trusted", staged: "provider/input.png" };
const workflowSha = productionCanonicalJsonSha256(templateWorkflow);
const boundWorkflowSha = productionCanonicalJsonSha256(boundWorkflow);
const proof = {
  version: 1 as const,
  verified: true as const,
  templateWorkflowSha256: workflowSha,
  boundWorkflowSha256: boundWorkflowSha,
  workflow: boundWorkflow,
  stageKey: valid.stageKey,
  bindingsDigest: valid.bindingsDigest,
};
ok(parseProductionWorkflowBindingVerification(proof, proof).verified,
"binding verifier proof 严格绑定 template/bound workflow、stage 与 bindings digests");
ok(parseProductionWorkflowBindingVerification({
  ...proof,
  workflow: { staged: "provider/input.png", node: "trusted" },
}, proof).boundWorkflowSha256 === boundWorkflowSha,
"binding proof uses shared canonical workflow identity rather than object insertion order");
ok((await captureError(async () => parseProductionWorkflowBindingVerification(
  { ...proof, bindingsDigest: SHA.e }, proof,
)))?.code === "invalid-response",
"binding verifier proof drift 被 strict parser 拒绝");
ok((await captureError(async () => parseProductionWorkflowBindingVerification(
  { ...proof, workflow: { ...boundWorkflow, staged: "drift.png" } }, proof,
)))?.code === "invalid-response",
"binding verifier rejects a bound workflow that does not match its returned digest");

ok(throwsCode(() => new HttpProductionInputStager({
  baseUrl: "http://asset-gateway.example", workspaceId: WS, project: PROJECT,
}), "invalid-config") && throwsCode(() => new HttpProductionInputStager({
  baseUrl: "http://asset-gateway.example", workspaceId: WS, project: PROJECT,
  credentialResolver: () => "PUBLIC_HTTP_TOKEN",
}), "invalid-config"),
"public HTTP 无论有无 bearer 都在 constructor trust boundary 被拒绝");
ok(throwsCode(() => new HttpProductionInputStager({
  baseUrl: "http://127.0.0.1:8188", workspaceId: WS, project: PROJECT,
}), "invalid-config") && throwsCode(() => new HttpProductionInputStager({
  baseUrl: "http://127.0.0.1:8188", workspaceId: WS, project: PROJECT,
  allowInsecureLoopback: true, credentialResolver: () => "LOOPBACK_TOKEN",
}), "invalid-config") && !throwsCode(() => new HttpProductionInputStager({
  baseUrl: "http://127.0.0.1:8188", workspaceId: WS, project: PROJECT,
  allowInsecureLoopback: true,
}), "invalid-config"),
"HTTP 只允许显式 loopback dev 且严禁携带 credentialResolver");

let abortedCredentials = 0;
let abortedFetches = 0;
const preAborted = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example",
  workspaceId: WS,
  project: PROJECT,
  credentialResolver: () => { abortedCredentials++; return "secret"; },
  fetch: async () => { abortedFetches++; return jsonResponse(valid); },
});
const preController = new AbortController();
preController.abort(new Error("stop"));
ok((await captureError(() => preAborted.stage(intent, preController.signal)))?.code === "aborted"
  && abortedCredentials === 0 && abortedFetches === 0,
"预先 abort 在 credential resolver/fetch 前停止，零网络副作用");

const inFlightAbort = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example", workspaceId: WS, project: PROJECT,
  fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }),
});
const inFlightController = new AbortController();
const inFlightPromise = captureError(() => inFlightAbort.stage(intent, inFlightController.signal));
inFlightController.abort(new Error("caller stop token=secret"));
const inFlightError = await inFlightPromise;
ok(inFlightError?.code === "aborted" && !inFlightError.message.includes("token=secret"),
"caller mid-flight abort 终止 fetch 且只返回脱敏 aborted 类别");

const timeoutStart = Date.now();
const hanging = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example",
  workspaceId: WS,
  project: PROJECT,
  timeoutMs: 60,
  fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }),
});
ok((await captureError(() => hanging.stage(intent)))?.code === "gateway-unavailable"
  && Date.now() - timeoutStart < 1_000, "永久挂起 headers 受绝对 deadline 约束");

const absoluteStart = Date.now();
const absolute = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example",
  workspaceId: WS,
  project: PROJECT,
  timeoutMs: 120,
  fetch: async (_input, init = {}) => {
    const stageRequest = JSON.parse(String(init.body)) as ProductionInputStageRequest;
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(resultFor(intent, stageRequest.stageKey))));
            controller.close();
          } catch { /* deadline cancellation already closed stream */ }
        }, 100);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  },
});
const absoluteError = await captureError(() => absolute.stage(intent));
ok(absoluteError?.code === "gateway-unavailable" && Date.now() - absoluteStart < 170,
"credential/headers/body 共用一个绝对 deadline，不在收到 headers 后重置");

const oversizedHeader = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example", workspaceId: WS, project: PROJECT, maxResponseBytes: 1_024,
  fetch: async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "2048" },
  }),
});
ok((await captureError(() => oversizedHeader.stage(intent)))?.code === "response-too-large",
"Content-Length 声明超限时拒绝读取 body");
const oversizedStream = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example", workspaceId: WS, project: PROJECT, maxResponseBytes: 1_024,
  fetch: async () => new Response(new Uint8Array(1_025), {
    status: 200, headers: { "content-type": "application/json" },
  }),
});
ok((await captureError(() => oversizedStream.stage(intent)))?.code === "response-too-large",
"无 Content-Length 时按累计 bytes 硬截断响应流");

const redirectSecret = "REDIRECT_TOKEN_SECRET";
let redirectInit: RequestInit | undefined;
const redirecting = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example", workspaceId: WS, project: PROJECT,
  fetch: async (_input, init) => {
    redirectInit = init;
    throw new TypeError(`redirect to https://evil.invalid/?token=${redirectSecret}`);
  },
});
const redirectError = await captureError(() => redirecting.stage(intent));
ok(redirectError?.code === "gateway-unavailable" && redirectInit?.redirect === "error"
  && !redirectError.message.includes(redirectSecret),
"redirect URL/token 被脱敏为固定错误类别且 fetch 禁止 follow");

const credentialSecret = "CREDENTIAL_PROVIDER_SECRET";
const badCredential = new HttpProductionInputStager({
  baseUrl: "https://asset-gateway.example", workspaceId: WS, project: PROJECT,
  credentialResolver: () => { throw new Error(credentialSecret); },
});
const credentialError = await captureError(() => badCredential.stage(intent));
ok(credentialError?.code === "credential-unavailable" && !credentialError.message.includes(credentialSecret),
"credential resolver 失败不泄漏 token/provider message");

// §8.0 owner-only transport: VPC 私网明文 HTTP 只在「私网字面 IP + 非空 bearer」下成立，
// 且不放宽既有 allowInsecureLoopback（无凭据 loopback 开发通道）的语义。
const stagerConstructed = (options: Partial<HttpProductionInputStagerOptions>): boolean => {
  try {
    new HttpProductionInputStager({
      baseUrl: "https://asset-gateway.example",
      workspaceId: WS,
      project: PROJECT,
      fetch: async () => new Response("{}"),
      ...options,
    });
    return true;
  } catch { return false; }
};
ok(stagerConstructed({
  baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http",
  credentialResolver: () => "PRIVATE_NET_TOKEN",
}), "input stager：insecure-private-http + RFC1918 字面 IP + credential 被接受");
ok(!stagerConstructed({
  baseUrl: "http://203.0.113.9:8790", transport: "insecure-private-http",
  credentialResolver: () => "PRIVATE_NET_TOKEN",
}), "input stager：insecure-private-http 拒绝公网 IP endpoint");
ok(!stagerConstructed({
  baseUrl: "http://10.148.0.9:8790", transport: "insecure-private-http",
}), "input stager：insecure-private-http 缺 credentialResolver 时拒绝");
ok(!stagerConstructed({
  baseUrl: "http://10.148.0.9:8790", credentialResolver: () => "PRIVATE_NET_TOKEN",
}), "input stager：缺省 transport 仍要求 HTTPS，私网明文 http 被拒");

console.log(fails === 0 ? "\nPRODUCTION_INPUT_STAGER_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
