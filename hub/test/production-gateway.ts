// Phase 3C private gateway regression suite: strict ingress, bounded Comfy pulls and safe CAS.
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FetchLike, RemoteOutputLocator } from "../src/production-adapter.ts";
import type {
  ProductionGatewayIngestRequest,
  ProductionIngestScope,
} from "../src/production-ingestor.ts";
import {
  ProductionGateway,
  ProductionGatewayError,
  startProductionGateway,
  staticProductionGatewayCredential,
  type ProductionGatewayOptions,
} from "../src/production-gateway.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const TOKEN = "gateway-token-SECRET";
const COMFY_TOKEN = "comfy-token-SECRET";
const SCOPE_A: ProductionIngestScope = {
  version: 1,
  workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  project: "short-drama",
};
const SCOPE_B: ProductionIngestScope = {
  version: 1,
  workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  project: "short-drama",
};
const roots: string[] = [];

const root = (): string => {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "writing-loop-gateway-")));
  roots.push(value);
  return value;
};

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]),
  Buffer.from("production-video"),
]);
const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([24, 0, 0, 0]),
  Buffer.from("WAVEfmt "),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("production-audio"),
]);
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("production-image"),
]);

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const LOCATORS: RemoteOutputLocator[] = [
  { nodeId: "7", kind: "video", filename: "take.mp4", subfolder: "video/final", folderType: "output" },
  { nodeId: "9", kind: "audio", filename: "take.wav", subfolder: "audio", folderType: "output" },
];

const requestBody = (
  ingestKey = SHA_A,
  overrides: Partial<ProductionGatewayIngestRequest> = {},
): ProductionGatewayIngestRequest => ({
  version: 1,
  scope: SCOPE_A,
  ingestKey,
  taskId: "take-001",
  idempotencyKey: "idem-take-001",
  taskIdentityDigest: SHA_B,
  backendInstanceId: "comfy-prod-a",
  remoteJobId: "11111111-1111-4111-8111-111111111111",
  responseDigest: SHA_C,
  locators: LOCATORS,
  ...overrides,
});

type RequestOptions = {
  token?: string | null;
  pathKey?: string;
  headerKey?: string | null;
  body?: unknown;
  contentType?: string;
  contentLength?: string | null;
  method?: string;
  urlSuffix?: string;
  scope?: ProductionIngestScope;
};

const scopedUrl = (
  scope: ProductionIngestScope,
  tail: string,
  origin = "http://gateway.private",
): string => `${origin}/v1/scopes/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.project)}/${tail}`;

function ingestRequest(options: RequestOptions = {}): Request {
  const pathKey = options.pathKey ?? SHA_A;
  const scope = options.scope ?? SCOPE_A;
  const body = options.body ?? requestBody(pathKey, { scope });
  const headers = new Headers();
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", options.contentType ?? "application/json");
  const headerKey = options.headerKey === undefined ? pathKey : options.headerKey;
  if (headerKey !== null) headers.set("x-writing-loop-idempotency-key", headerKey);
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set("content-length", options.contentLength);
  }
  return new Request(`${scopedUrl(scope, `ingests/${pathKey}`)}${options.urlSuffix ?? ""}`, {
    method: options.method ?? "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength), ...headers },
  });
}

const outputFor = (url: URL): Uint8Array => url.searchParams.get("filename")?.endsWith(".wav") ? WAV : MP4;

type FetchCall = { url: URL; init: RequestInit };

function normalFetch(calls: FetchCall[] = []): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return response(outputFor(url));
  };
}

async function gateway(
  overrides: Partial<ProductionGatewayOptions> = {},
): Promise<{ gateway: ProductionGateway; storeRoot: string }> {
  const storeRoot = overrides.storeRoot ?? root();
  const instance = await ProductionGateway.create({
    storeRoot,
    comfyBaseUrl: "https://comfy.internal:8188/comfy",
    credentialResolver: staticProductionGatewayCredential(TOKEN),
    fetch: normalFetch(),
    maxAssetBytes: 1024 * 1024,
    ...overrides,
  });
  return { gateway: instance, storeRoot };
}

async function bodyJson(responseValue: Response): Promise<Record<string, unknown>> {
  return await responseValue.json() as Record<string, unknown>;
}

try {
  // Bind and trusted configuration are server-only and fail closed.
  for (const host of ["0.0.0.0", "::", "gateway.example", "8.8.8.8"]) {
    let rejected = false;
    try { await gateway({ bindHost: host }); }
    catch (error) { rejected = error instanceof ProductionGatewayError; }
    ok(rejected, `public/wildcard/hostname bind ${host} 被拒绝`);
  }
  const privateGateway = await gateway({ bindHost: "10.20.30.40" });
  ok(privateGateway.gateway.bindHost === "10.20.30.40", "RFC1918 literal bind 被允许");
  privateGateway.gateway.close();
  const ipv6Gateway = await gateway({ bindHost: "::1" });
  ok(ipv6Gateway.gateway.bindHost === "::1", "IPv6 loopback literal bind 被允许");
  ipv6Gateway.gateway.close();
  let badComfy = false;
  try { await gateway({ comfyBaseUrl: "https://user:secret@comfy.internal/view?url=https://evil.example" }); }
  catch (error) { badComfy = error instanceof ProductionGatewayError; }
  ok(badComfy, "Comfy baseUrl 拒绝凭据/query，不能被配置成 URL 转发器");
  const configuredBase = root();
  const configuredTarget = join(configuredBase, "target");
  const configuredLink = join(configuredBase, "store-link");
  mkdirSync(configuredTarget, { mode: 0o700 });
  symlinkSync(configuredTarget, configuredLink);
  let symlinkRootRejected = false;
  try { await gateway({ storeRoot: configuredLink }); }
  catch (error) { symlinkRootRejected = error instanceof Error; }
  ok(symlinkRootRejected, "配置的 store root 自身为 symlink 时初始化失败关闭");

  // Happy path, content-addressed storage and exact replay.
  const calls: FetchCall[] = [];
  const happy = await gateway({
    fetch: normalFetch(calls),
    comfyCredentialResolver: staticProductionGatewayCredential(COMFY_TOKEN),
  });
  const firstResponse = await happy.gateway.handle(ingestRequest());
  const first = await bodyJson(firstResponse);
  const assets = first.assets as Array<Record<string, unknown>>;
  ok(firstResponse.status === 200 && first.version === 1 && first.ingestKey === SHA_A
    && assets.length === 2 && first.cost !== null
    && (first.cost as Record<string, unknown>).state === "unknown",
  "合法 PUT 返回严格 ingestKey/assets/unknown-cost DTO");
  ok(assets.every((asset) => asset.uri === `urn:sha256:${asset.sha256}`)
    && assets.some((asset) => asset.mediaType === "video/mp4")
    && assets.some((asset) => asset.mediaType === "audio/wav"),
  "输出 URI 只使用内容寻址 urn:sha256，MIME 来自 magic sniff");
  ok(calls.length === 2 && calls.every((call) => call.url.origin === "https://comfy.internal:8188"
    && call.url.pathname === "/comfy/view" && call.init.method === "GET"
    && call.init.redirect === "error"
    && new Headers(call.init.headers).get("authorization") === `Bearer ${COMFY_TOKEN}`),
  "所有 provider 拉流只从受信任 Comfy origin/view 派生并禁止 redirect");
  const videoDigest = digest(MP4);
  const videoPath = join(happy.storeRoot, "blobs", "sha256", videoDigest.slice(0, 2), videoDigest);
  const scopeAStorageId = digest(Buffer.from(JSON.stringify(SCOPE_A)));
  const receiptPath = join(happy.storeRoot, "receipts", scopeAStorageId, `${SHA_A}.json`);
  const ownershipPath = join(
    happy.storeRoot,
    "ownership",
    scopeAStorageId,
    "sha256",
    videoDigest.slice(0, 2),
    `${videoDigest}.json`,
  );
  const stored = lstatSync(videoPath);
  const persistedReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  ok(stored.isFile() && !stored.isSymbolicLink() && stored.nlink === 1
    && (stored.mode & 0o777) === 0o400 && readFileSync(videoPath).equals(MP4)
    && existsSync(ownershipPath) && existsSync(receiptPath)
    && JSON.stringify(persistedReceipt.scope) === JSON.stringify(SCOPE_A),
  "CAS 使用全局只读 blob，并在成功前落 scope ownership、最终落含 scope 的 receipt");

  const replayText = JSON.stringify(first);
  const replayResponse = await happy.gateway.handle(ingestRequest());
  ok(replayResponse.status === 200 && JSON.stringify(await replayResponse.json()) === replayText
    && calls.length === 2,
  "相同 PUT 从 receipt 精确 replay，不再次拉取或计费");
  const conflictResponse = await happy.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { responseDigest: SHA_B }),
  }));
  ok(conflictResponse.status === 409 && (await bodyJson(conflictResponse)).error === "conflict"
    && calls.length === 2,
  "相同 ingestKey 绑定不同请求摘要时返回 409 且不访问 provider");

  let concurrentCostCalls = 0;
  const concurrent = await gateway({
    costResolver: async () => {
      concurrentCostCalls++;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      return {
        version: 1,
        state: "known",
        currency: "USD",
        amountMicros: concurrentCostCalls,
        basis: "reported",
      };
    },
  });
  const concurrentResults = await Promise.all([
    concurrent.gateway.handle(ingestRequest()),
    concurrent.gateway.handle(ingestRequest()),
  ]);
  const concurrentBodies = await Promise.all(concurrentResults.map(async (value) => await value.text()));
  ok(concurrentResults.every((value) => value.status === 200)
    && concurrentBodies[0] === concurrentBodies[1] && concurrentCostCalls >= 1 && concurrentCostCalls <= 2,
  "并发相同 PUT 由 O_EXCL receipt 选出一个精确 winner，所有 caller 得到同一 replay");
  const concurrentConflict = await gateway();
  const conflictingResults = await Promise.all([
    concurrentConflict.gateway.handle(ingestRequest()),
    concurrentConflict.gateway.handle(ingestRequest({
      body: requestBody(SHA_A, { responseDigest: SHA_B }),
    })),
  ]);
  ok(conflictingResults.map((value) => value.status).sort().join(",") === "200,409",
    "并发不同请求争用同一 ingestKey 时严格产生一个 winner 和一个 conflict");
  concurrent.gateway.close();
  concurrentConflict.gateway.close();

  let scopedPulls = 0;
  const scopedReceipts = await gateway({
    fetch: async () => { scopedPulls++; return response(MP4); },
  });
  const scopedA = await scopedReceipts.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { scope: SCOPE_A, locators: [LOCATORS[0]!] }),
  }));
  const scopedB = await scopedReceipts.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    body: requestBody(SHA_A, { scope: SCOPE_B, locators: [LOCATORS[0]!] }),
  }));
  const scopedBConflict = await scopedReceipts.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    body: requestBody(SHA_A, { scope: SCOPE_B, responseDigest: SHA_B, locators: [LOCATORS[0]!] }),
  }));
  const scopeBStorageId = digest(Buffer.from(JSON.stringify(SCOPE_B)));
  ok(scopedA.status === 200 && scopedB.status === 200 && scopedBConflict.status === 409
    && scopedPulls === 2
    && existsSync(join(scopedReceipts.storeRoot, "receipts", scopeAStorageId, `${SHA_A}.json`))
    && existsSync(join(scopedReceipts.storeRoot, "receipts", scopeBStorageId, `${SHA_A}.json`)),
  "同一字面 ingestKey 跨 scope 不 replay；各 scope 独立 exact receipt，scope 内 drift 仍 409");
  scopedReceipts.gateway.close();

  const ownershipIsolation = await gateway({ fetch: async () => response(MP4) });
  await ownershipIsolation.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { scope: SCOPE_A, locators: [LOCATORS[0]!] }),
  }));
  const isolationBlob = join(
    ownershipIsolation.storeRoot,
    "blobs",
    "sha256",
    videoDigest.slice(0, 2),
    videoDigest,
  );
  linkSync(isolationBlob, join(ownershipIsolation.storeRoot, "known-digest-hardlink"));
  const crossScopeKnownDigest = await ownershipIsolation.gateway.handle(new Request(
    scopedUrl(SCOPE_B, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(crossScopeKnownDigest.status === 404,
    "跨 scope 已知 digest 在 ownership claim 前返回 404，甚至不会打开已损坏的全局 blob");
  ownershipIsolation.gateway.close();

  let urlLikeFetch = "";
  const urlLikeLocator = await gateway({
    fetch: async (input) => {
      urlLikeFetch = String(input);
      return response(MP4);
    },
  });
  const urlLikeResult = await urlLikeLocator.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [{
      ...LOCATORS[0]!, filename: "https://evil.example/video.mp4", subfolder: "",
    }] }),
  }));
  const urlLikeObserved = new URL(urlLikeFetch);
  ok(urlLikeResult.status === 200 && urlLikeObserved.origin === "https://comfy.internal:8188"
    && urlLikeObserved.pathname === "/comfy/view"
    && urlLikeObserved.searchParams.get("filename") === "https://evil.example/video.mp4",
  "即使 locator 文本形似 URL，也只会成为受信任 Comfy /view 的编码 query 值");
  urlLikeLocator.gateway.close();

  // GET is an authenticated, digest-only resolver with no arbitrary path/query surface.
  const getAsset = await happy.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(getAsset.status === 200 && getAsset.headers.get("content-type") === "video/mp4"
    && getAsset.headers.get("content-length") === String(MP4.length)
    && Buffer.from(await getAsset.arrayBuffer()).equals(MP4),
  "受信任 downstream 可按严格 sha256 GET，并得到固定长度/sniffed MIME");
  const unauthGet = await happy.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`),
  ));
  const queriedGet = await happy.gateway.handle(new Request(
    `${scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`)}?url=https://evil.example`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  const unknownGet = await happy.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${SHA_B}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(unauthGet.status === 401 && queriedGet.status === 404 && unknownGet.status === 404,
  "asset resolver 强制 bearer、拒绝 query，并将未知 digest 收敛为 404");

  // Authentication is constant-size compared and failures never echo secrets.
  let authFetches = 0;
  const authGateway = await gateway({ fetch: async () => { authFetches++; return response(MP4); } });
  for (const token of [null, "wrong", `${TOKEN},Bearer other`]) {
    const result = await authGateway.gateway.handle(ingestRequest({ token }));
    const text = await result.text();
    ok(result.status === 401 && !text.includes(TOKEN) && authFetches === 0,
      "缺失/错误/合并 bearer 被固定 401 拒绝且不触发 provider");
  }
  let scopeAToken = "scope-a-token-v1";
  let scopeBToken = "scope-b-token-v1";
  let scopedAuthFetches = 0;
  const authContexts: Array<{ workspaceId: string; project: string; operation: string }> = [];
  const scopedAuth = await gateway({
    credentialResolver: (context) => {
      authContexts.push({ ...context });
      return context.workspaceId === SCOPE_A.workspaceId ? scopeAToken : scopeBToken;
    },
    fetch: async () => { scopedAuthFetches++; return response(MP4); },
  });
  const aTokenAgainstB = await scopedAuth.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    token: scopeAToken,
    body: requestBody(SHA_A, { scope: SCOPE_B, locators: [LOCATORS[0]!] }),
  }));
  const scopedAuthReceipt = join(
    scopedAuth.storeRoot,
    "receipts",
    digest(Buffer.from(JSON.stringify(SCOPE_B))),
    `${SHA_A}.json`,
  );
  const wrongScopeWasZeroWrite = scopedAuthFetches === 0 && !existsSync(scopedAuthReceipt);
  const bAccepted = await scopedAuth.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    token: scopeBToken,
    body: requestBody(SHA_A, { scope: SCOPE_B, locators: [LOCATORS[0]!] }),
  }));
  const staleBToken = scopeBToken;
  scopeBToken = "scope-b-token-v2";
  const staleB = await scopedAuth.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    token: staleBToken,
    body: requestBody(SHA_A, { scope: SCOPE_B, locators: [LOCATORS[0]!] }),
  }));
  const rotatedB = await scopedAuth.gateway.handle(ingestRequest({
    scope: SCOPE_B,
    token: scopeBToken,
    body: requestBody(SHA_A, { scope: SCOPE_B, locators: [LOCATORS[0]!] }),
  }));
  const scopedAsset = await scopedAuth.gateway.handle(new Request(
    scopedUrl(SCOPE_B, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${scopeBToken}` } },
  ));
  await scopedAsset.arrayBuffer();
  ok(aTokenAgainstB.status === 401 && wrongScopeWasZeroWrite && bAccepted.status === 200 && staleB.status === 401
    && rotatedB.status === 200 && scopedAsset.status === 200 && scopedAuthFetches === 1
    && existsSync(scopedAuthReceipt)
    && authContexts.every((context) => context.workspaceId === SCOPE_B.workspaceId
      && context.project === SCOPE_B.project)
    && authContexts.some((context) => context.operation === "ingest")
    && authContexts.some((context) => context.operation === "asset-read"),
  "resolver 每请求收到 route scope/operation；A token 不能新建 B ingest，rotation 即时生效且失败零写");
  scopedAuth.gateway.close();
  const resolverSecret = "RESOLVER-SECRET-NEVER-LEAK";
  const brokenCredential = await gateway({
    credentialResolver: () => { throw new Error(resolverSecret); },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  const brokenCredentialResponse = await brokenCredential.gateway.handle(ingestRequest());
  ok(brokenCredentialResponse.status === 500
    && !(await brokenCredentialResponse.text()).includes(resolverSecret),
  "server credential resolver 异常只暴露固定 internal 类别");

  // Strict request DTO and bounded body.
  const strictGateway = await gateway();
  const invalidRequests: Array<[Request, number, string]> = [
    [ingestRequest({ contentType: "text/plain" }), 400, "非 JSON request MIME"],
    [ingestRequest({ headerKey: SHA_B }), 400, "header/body/path ingestKey 不一致"],
    [ingestRequest({ scope: SCOPE_B, body: requestBody(SHA_A, { scope: SCOPE_A }) }), 400,
      "path/body scope 不一致"],
    [ingestRequest({ urlSuffix: "?url=https://evil.example" }), 404, "ingest query"],
    [ingestRequest({ body: { ...requestBody(), arbitraryUrl: "https://evil.example" } }), 400, "未知 URL 字段"],
    [ingestRequest({ body: requestBody(SHA_A, { locators: [...LOCATORS].reverse() }) }), 400, "非 canonical locator 顺序"],
    [ingestRequest({ body: requestBody(SHA_A, { locators: [LOCATORS[0]!, LOCATORS[0]!] }) }), 400, "重复 locator"],
    [ingestRequest({ body: requestBody(SHA_A, { locators: [{ ...LOCATORS[0]!, filename: "../secret" }] }) }), 400, "locator traversal"],
    [ingestRequest({ body: requestBody(SHA_A, { locators: [{ ...LOCATORS[0]!, folderType: "input" }] as RemoteOutputLocator[] }) }), 400, "非 output/temp folder"],
    [ingestRequest({ contentLength: String(300 * 1024) }), 413, "声明 body 超限"],
    [ingestRequest({ contentLength: "not-a-number" }), 400, "畸形 body Content-Length"],
  ];
  for (const [request, statusCode, label] of invalidRequests) {
    const responseValue = await strictGateway.gateway.handle(request);
    ok(responseValue.status === statusCode, `${label} 被 strict ingress 拒绝`);
  }
  const hugeStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(300 * 1024));
      controller.close();
    },
  });
  const hugeRequest = new Request(scopedUrl(SCOPE_A, `ingests/${SHA_A}`), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-writing-loop-idempotency-key": SHA_A,
    },
    body: hugeStream,
    duplex: "half",
  } as RequestInit);
  ok((await strictGateway.gateway.handle(hugeRequest)).status === 413,
    "无 Content-Length 的 request stream 也按累计 bytes 截断");

  let legacyRouteAuthCalls = 0;
  const noLegacyRoutes = await gateway({
    credentialResolver: () => { legacyRouteAuthCalls++; return TOKEN; },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  const legacyIngest = await noLegacyRoutes.gateway.handle(new Request(
    `http://gateway.private/v1/ingests/${SHA_A}`,
    { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" },
  ));
  const legacyAsset = await noLegacyRoutes.gateway.handle(new Request(
    `http://gateway.private/v1/assets/sha256/${SHA_A}`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(legacyIngest.status === 404 && legacyAsset.status === 404 && legacyRouteAuthCalls === 0,
    "旧全局 ingest/asset route 已冻结移除，并在 credential resolver/存储前 404");
  noLegacyRoutes.gateway.close();

  // Provider output bounds, exact length, MIME sniff and kind matching.
  const providerCases: Array<[string, FetchLike, number]> = [
    ["provider Content-Length 超限", async () => response(MP4, { "content-length": String(2 * 1024 * 1024) }), 413],
    ["provider Content-Length 畸形", async () => response(MP4, { "content-length": "NaN" }), 502],
    ["provider 声明长度与 stream 不一致", async () => response(MP4, { "content-length": String(MP4.length + 1) }), 502],
    ["未知 MIME magic", async () => response(Buffer.from("plain untrusted bytes")), 415],
    ["locator kind 与 sniffed MIME 不一致", async () => response(PNG), 415],
    ["provider content-encoding 非 identity", async () => response(MP4, { "content-encoding": "gzip" }), 502],
  ];
  for (const [label, fetcher, statusCode] of providerCases) {
    const instance = await gateway({ fetch: fetcher });
    const result = await instance.gateway.handle(ingestRequest({
      body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
    }));
    ok(result.status === statusCode, `${label} 被拒绝且不写成功 receipt`);
  }
  const streamedOversize = await gateway({
    maxAssetBytes: 1024,
    fetch: async () => new Response(new Uint8Array(1025)),
  });
  ok((await streamedOversize.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }))).status === 413,
  "无 Content-Length 的 provider stream 也按累计 asset bytes 截断");

  // A single absolute deadline covers provider headers and body; redirects never follow or leak.
  const deadlineGateway = await gateway({
    timeoutMs: 70,
    fetch: async () => {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 40));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try { controller.enqueue(MP4); controller.close(); }
            catch { /* deadline cancellation won */ }
          }, 50);
        },
      }));
    },
  });
  const deadlineStart = Date.now();
  const deadlineResponse = await deadlineGateway.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  ok(deadlineResponse.status === 503 && Date.now() - deadlineStart < 180,
    "headers+body 共用单一绝对 deadline，不在收到 headers 后重置");
  const redirectSecret = "REDIRECT-SECRET-NEVER-LEAK";
  let redirectMode: RequestInit["redirect"];
  const redirectGateway = await gateway({
    fetch: async (_input, init) => {
      redirectMode = init?.redirect;
      throw new TypeError(`redirect https://evil.example/?token=${redirectSecret}`);
    },
  });
  const redirectResponse = await redirectGateway.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  ok(redirectResponse.status === 502 && redirectMode === "error"
    && !(await redirectResponse.text()).includes(redirectSecret),
  "provider redirect 被 fetch 层禁止，目标 URL/token 不进入响应");

  // Known accounting is accepted only through the server-side resolver and then receipt-bound.
  let costCalls = 0;
  const billed = await gateway({
    costResolver: () => {
      costCalls++;
      return { version: 1, state: "known", currency: "USD", amountMicros: 42_000, basis: "billed" };
    },
  });
  const billedFirst = await bodyJson(await billed.gateway.handle(ingestRequest()));
  const billedReplay = await bodyJson(await billed.gateway.handle(ingestRequest()));
  ok((billedFirst.cost as Record<string, unknown>).basis === "billed"
    && JSON.stringify(billedFirst) === JSON.stringify(billedReplay) && costCalls === 1,
  "known cost 只由 server resolver 产生并随 receipt 精确 replay");
  const badCost = await gateway({ costResolver: () => ({ version: 1, state: "known" } as never) });
  ok((await badCost.gateway.handle(ingestRequest())).status === 500,
    "非法 server cost 不会穿过严格 ProductionCost DTO");

  const crashRoot = root();
  const beforeReceiptCrash = await gateway({
    storeRoot: crashRoot,
    fetch: async () => response(MP4),
    costResolver: () => { throw new Error("simulated-process-crash-before-receipt"); },
  });
  const crashed = await beforeReceiptCrash.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  const crashClaim = join(
    crashRoot,
    "ownership",
    scopeAStorageId,
    "sha256",
    videoDigest.slice(0, 2),
    `${videoDigest}.json`,
  );
  const crashReceipt = join(crashRoot, "receipts", scopeAStorageId, `${SHA_A}.json`);
  const claimDurableBeforeReceipt = crashed.status === 500
    && existsSync(crashClaim) && !existsSync(crashReceipt);
  beforeReceiptCrash.gateway.close();
  const afterCrashRestart = await gateway({
    storeRoot: crashRoot,
    fetch: async () => response(MP4),
  });
  const recovered = await afterCrashRestart.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  const recoveredClaimInfo = lstatSync(crashClaim);
  ok(claimDurableBeforeReceipt && recovered.status === 200 && existsSync(crashReceipt)
    && recoveredClaimInfo.isFile() && recoveredClaimInfo.nlink === 1
    && (recoveredClaimInfo.mode & 0o777) === 0o400,
  "receipt 前崩溃留下 durable ownership；restart 可精确复用 claim/CAS 并最终提交 receipt");
  afterCrashRestart.gateway.close();

  const concurrentClaims = await gateway({ fetch: async () => response(MP4) });
  const claimResults = await Promise.all([
    concurrentClaims.gateway.handle(ingestRequest({
      pathKey: SHA_A,
      body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
    })),
    concurrentClaims.gateway.handle(ingestRequest({
      pathKey: SHA_B,
      body: requestBody(SHA_B, { locators: [LOCATORS[0]!] }),
    })),
  ]);
  const concurrentClaimPath = join(
    concurrentClaims.storeRoot,
    "ownership",
    scopeAStorageId,
    "sha256",
    videoDigest.slice(0, 2),
    `${videoDigest}.json`,
  );
  const concurrentClaimInfo = lstatSync(concurrentClaimPath);
  const concurrentClaimValue = JSON.parse(readFileSync(concurrentClaimPath, "utf8")) as Record<string, unknown>;
  ok(claimResults.every((result) => result.status === 200)
    && concurrentClaimInfo.nlink === 1
    && JSON.stringify(concurrentClaimValue.scope) === JSON.stringify(SCOPE_A),
  "并发不同 receipt 原子争用同一 scope claim，只留下单链接 exact ownership winner");
  concurrentClaims.gateway.close();

  // Symlink, hardlink and root-replacement attacks fail closed.
  const symlinkStore = await gateway({
    fetch: async () => response(MP4),
  });
  const singleLocator = ingestRequest({ body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }) });
  ok((await symlinkStore.gateway.handle(singleLocator)).status === 200, "安全文件攻击 fixture 已入库");
  const symlinkDigest = digest(MP4);
  const metadataPath = join(
    symlinkStore.storeRoot, "metadata", "sha256", symlinkDigest.slice(0, 2), `${symlinkDigest}.json`,
  );
  const metadataBackup = `${metadataPath}.backup`;
  renameSync(metadataPath, metadataBackup);
  symlinkSync(metadataBackup, metadataPath);
  const symlinkGet = await symlinkStore.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${symlinkDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(symlinkGet.status === 500, "metadata symlink 被 O_NOFOLLOW/lstat/inode checks 拒绝");

  const parentLinkStore = await gateway({ fetch: async () => response(MP4) });
  const outsideOwnershipTarget = root();
  symlinkSync(
    outsideOwnershipTarget,
    join(parentLinkStore.storeRoot, "ownership", scopeAStorageId),
  );
  const parentLinkResult = await parentLinkStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  ok(parentLinkResult.status === 500 && readdirSync(outsideOwnershipTarget).length === 0,
    "中间 ownership parent symlink 在逐级 mkdir 前拒绝，store 外目标保持零写");
  parentLinkStore.gateway.close();

  const ownershipLinkStore = await gateway({ fetch: async () => response(MP4) });
  await ownershipLinkStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  const claimPath = join(
    ownershipLinkStore.storeRoot,
    "ownership",
    scopeAStorageId,
    "sha256",
    videoDigest.slice(0, 2),
    `${videoDigest}.json`,
  );
  const claimBackup = `${claimPath}.backup`;
  renameSync(claimPath, claimBackup);
  symlinkSync(claimBackup, claimPath);
  const claimSymlinkGet = await ownershipLinkStore.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(claimSymlinkGet.status === 500,
    "authorization-critical ownership symlink 被 claim-first O_NOFOLLOW/inode checks 拒绝");
  ownershipLinkStore.gateway.close();

  const ownershipHardlinkStore = await gateway({ fetch: async () => response(MP4) });
  await ownershipHardlinkStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  const hardlinkClaim = join(
    ownershipHardlinkStore.storeRoot,
    "ownership",
    scopeAStorageId,
    "sha256",
    videoDigest.slice(0, 2),
    `${videoDigest}.json`,
  );
  linkSync(hardlinkClaim, join(ownershipHardlinkStore.storeRoot, "ownership-hardlink"));
  const claimHardlinkGet = await ownershipHardlinkStore.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(claimHardlinkGet.status === 500,
    "nlink>1 ownership claim 不会被当作跨进程授权数据");
  ownershipHardlinkStore.gateway.close();

  const hardlinkStore = await gateway({ fetch: async () => response(MP4) });
  await hardlinkStore.gateway.handle(ingestRequest({ body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }) }));
  const hardlinkBlob = join(
    hardlinkStore.storeRoot, "blobs", "sha256", videoDigest.slice(0, 2), videoDigest,
  );
  linkSync(hardlinkBlob, join(hardlinkStore.storeRoot, "outside-hardlink"));
  const hardlinkGet = await hardlinkStore.gateway.handle(new Request(
    scopedUrl(SCOPE_A, `assets/sha256/${videoDigest}`),
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  ok(hardlinkGet.status === 500, "nlink>1 CAS blob 被拒绝，防止 hardlink 替换/外泄");

  const receiptLinkStore = await gateway({ fetch: async () => response(MP4) });
  await receiptLinkStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  const linkedReceipt = join(receiptLinkStore.storeRoot, "receipts", scopeAStorageId, `${SHA_A}.json`);
  linkSync(linkedReceipt, join(receiptLinkStore.storeRoot, "receipt-hardlink"));
  ok((await receiptLinkStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }))).status === 500,
  "nlink>1 receipt 不会被当成可信 replay 数据");
  receiptLinkStore.gateway.close();

  const corruptRoot = root();
  const corruptDigest = digest(MP4);
  const corruptShard = join(corruptRoot, "blobs", "sha256", corruptDigest.slice(0, 2));
  mkdirSync(corruptShard, { recursive: true, mode: 0o700 });
  writeFileSync(join(corruptShard, corruptDigest), Buffer.alloc(MP4.length, 0x41), { mode: 0o400 });
  const corruptStore = await gateway({ storeRoot: corruptRoot, fetch: async () => response(MP4) });
  ok((await corruptStore.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }))).status === 500,
  "同名同长度但内容错误的既有 CAS blob 会重新 sha256 校验并拒绝");
  corruptStore.gateway.close();

  const preexistingRoot = root();
  const maliciousTarget = join(preexistingRoot, "outside-target");
  writeFileSync(maliciousTarget, MP4);
  const maliciousDigest = digest(MP4);
  const maliciousShard = join(preexistingRoot, "blobs", "sha256", maliciousDigest.slice(0, 2));
  mkdirSync(maliciousShard, { recursive: true, mode: 0o700 });
  symlinkSync(maliciousTarget, join(maliciousShard, maliciousDigest));
  const preexisting = await gateway({ storeRoot: preexistingRoot, fetch: async () => response(MP4) });
  const maliciousResponse = await preexisting.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  ok(maliciousResponse.status === 500 && readFileSync(maliciousTarget).equals(MP4),
    "预置 CAS symlink 不会被跟随、覆盖或当成已有 blob 接受");

  const replaced = await gateway();
  const originalRoot = replaced.storeRoot;
  const movedRoot = `${originalRoot}.moved`;
  renameSync(originalRoot, movedRoot);
  mkdirSync(originalRoot, { mode: 0o700 });
  const replacedResponse = await replaced.gateway.handle(ingestRequest());
  ok(replacedResponse.status === 500, "store root 被替换后 inode pin 检测在任何 fetch 前失败关闭");
  rmSync(originalRoot, { recursive: true, force: true });
  renameSync(movedRoot, originalRoot);

  const remoteSwapRoot = root();
  const remoteSwapMoved = `${remoteSwapRoot}.moved`;
  let remoteSwapped = false;
  const remoteSwap = await gateway({
    storeRoot: remoteSwapRoot,
    fetch: async () => {
      if (!remoteSwapped) {
        remoteSwapped = true;
        renameSync(remoteSwapRoot, remoteSwapMoved);
        mkdirSync(remoteSwapRoot, { mode: 0o700 });
      }
      return response(MP4);
    },
  });
  const remoteSwapResponse = await remoteSwap.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  ok(remoteSwapResponse.status === 500 && !existsSync(join(remoteSwapRoot, "tmp")),
    "provider 等待期间 store root 被替换也会在落盘前重新校验 pinned inode");
  remoteSwap.gateway.close();
  rmSync(remoteSwapRoot, { recursive: true, force: true });
  renameSync(remoteSwapMoved, remoteSwapRoot);

  // Abort and shutdown stop active streams and reject new remote actions.
  let callerSawAbort = false;
  let callerFetchStarted!: () => void;
  const callerFetchReady = new Promise<void>((resolvePromise) => { callerFetchStarted = resolvePromise; });
  const callerAbortGateway = await gateway({
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      callerFetchStarted();
      init?.signal?.addEventListener("abort", () => {
        callerSawAbort = true;
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });
  const callerController = new AbortController();
  const callerPending = callerAbortGateway.gateway.handle(new Request(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }), { signal: callerController.signal }));
  await callerFetchReady;
  callerController.abort(new Error("caller-cancelled"));
  ok((await callerPending).status === 503 && callerSawAbort,
    "caller AbortSignal 会贯穿并中止活跃 provider fetch");
  callerAbortGateway.gateway.close();

  let sawAbort = false;
  const hanging = await gateway({
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        sawAbort = true;
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });
  const pending = hanging.gateway.handle(ingestRequest({
    body: requestBody(SHA_A, { locators: [LOCATORS[0]!] }),
  }));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  hanging.gateway.close();
  const closedResponse = await pending;
  const afterClose = await hanging.gateway.handle(ingestRequest());
  ok(closedResponse.status === 503 && afterClose.status === 503 && sawAbort,
    "close 会 Abort 活跃 provider fetch，并永久禁止新请求");

  // Deployable Node HTTP adapter preserves the exact authenticated PUT/GET contract.
  const httpServer = await startProductionGateway({
    storeRoot: root(),
    comfyBaseUrl: "http://127.0.0.1:8188",
    credentialResolver: staticProductionGatewayCredential(TOKEN),
    fetch: async () => response(MP4),
    maxAssetBytes: 1024 * 1024,
    bindHost: "127.0.0.1",
    bindPort: 0,
  });
  try {
    const httpKey = SHA_A;
    const httpOrigin = `http://${httpServer.address.host}:${httpServer.address.port}`;
    const httpPut = await fetch(scopedUrl(SCOPE_A, `ingests/${httpKey}`, httpOrigin), {
      method: "PUT",
      redirect: "error",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-writing-loop-idempotency-key": httpKey,
      },
      body: JSON.stringify(requestBody(httpKey, { locators: [LOCATORS[0]!] })),
    });
    const httpResult = await bodyJson(httpPut);
    const httpAssets = Array.isArray(httpResult.assets)
      ? httpResult.assets as Array<Record<string, unknown>>
      : [];
    const httpDigest = httpAssets[0]?.sha256;
    const httpGet = await fetch(
      scopedUrl(SCOPE_A, `assets/sha256/${String(httpDigest)}`, httpOrigin),
      { headers: { authorization: `Bearer ${TOKEN}` }, redirect: "error" },
    );
    ok(httpPut.status === 200 && httpGet.status === 200
      && Buffer.from(await httpGet.arrayBuffer()).equals(MP4),
    "真实 Node HTTP server 保持 authenticated PUT ingest 与 digest-only GET resolver 契约");
  } finally {
    await httpServer.close();
  }

  happy.gateway.close();
  authGateway.gateway.close();
  brokenCredential.gateway.close();
  strictGateway.gateway.close();
  deadlineGateway.gateway.close();
  redirectGateway.gateway.close();
  billed.gateway.close();
  badCost.gateway.close();
  symlinkStore.gateway.close();
  hardlinkStore.gateway.close();
  preexisting.gateway.close();
  replaced.gateway.close();
} finally {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
}

if (fails) {
  console.error(`\n${fails} production gateway assertion(s) failed`);
  process.exit(1);
}
console.log("\nproduction gateway tests: OK");
