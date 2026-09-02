// Private input-stage gateway: scoped auth/profile registration, verified AssetRef streams,
// immutable provider CAS publication, exact replay and job-gateway receipt proofs.
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRef, ProductionSubjectRef } from "../src/production-domain.ts";
import {
  createProductionDispatchIntent,
  type ProductionDispatchIntent,
  type ProductionIntentDraft,
} from "../src/production-intent.ts";
import {
  productionInputStageIdentityKey,
  productionInputStageKey,
  type ProductionInputStageRequest,
  type ProductionInputStageResult,
  type ProductionInputStageScope,
} from "../src/production-input-stager.ts";
import {
  SHOT_REQUEST_MEDIA_TYPE,
  parseShotRequest,
  shotRequestCanonicalJson,
} from "../src/production-shot-request.ts";
import {
  ProductionStageGateway,
  ProductionStageGatewayError,
  productionStageProfileDigest,
  type ProductionStageAssetSource,
  type ProductionStageGatewayHooks,
  type ProductionStageGatewayOptions,
  type ProductionStageProfile,
  type ProductionStageProfileLookup,
} from "../src/production-stage-gateway.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT = "paper-moon";
const OTHER_PROJECT = "other-project";
const TOKEN = "stage-token-paper-moon-SECRET";
const OTHER_TOKEN = "stage-token-other-project-SECRET";
const SHA = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64) };
const roots: string[] = [];
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("trusted-stage-image"),
]);
const WAV = Buffer.concat([
  Buffer.from("RIFF"), Buffer.from([24, 0, 0, 0]), Buffer.from("WAVEfmt "),
  Buffer.from([0, 0, 0, 0]), Buffer.from("trusted-stage-audio"),
]);
const PLAIN = Buffer.from("not an image despite caller metadata");

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "writing-loop-stage-gateway-")));
  roots.push(value);
  return value;
}

function asset(uri: string, bytes: Uint8Array, mediaType: string): AssetRef {
  return { version: 1, uri, sha256: digest(bytes), byteLength: bytes.byteLength, mediaType };
}

const INPUTS = [
  asset("s3://trusted-inputs/episode/first.png", PNG, "image/png"),
  asset("s3://trusted-inputs/episode/voice.wav", WAV, "audio/wav"),
];

function subject(): ProductionSubjectRef {
  const source = (uri: string, sha256: string): AssetRef => ({
    version: 1, uri, sha256, byteLength: 123, mediaType: "application/json",
  });
  return {
    version: 1,
    kind: "shot",
    shot: {
      version: 1,
      episode: {
        version: 1,
        episodeId: "episode-001",
        revision: 2,
        source: source("s3://trusted-inputs/episode.json", SHA.a),
      },
      shotId: "shot-001",
      revision: 3,
      source: source("s3://trusted-inputs/shot.json", SHA.b),
    },
  };
}

function intentFor(inputs: AssetRef[] = INPUTS, id = "take-001"): ProductionDispatchIntent {
  const draft: ProductionIntentDraft = {
    version: 1,
    taskId: id,
    subject: subject(),
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
      evidence: { version: 1, uri: "s3://trusted-inputs/rights.json", sha256: SHA.a, byteLength: 1, mediaType: "application/json" },
      expiresAt: null,
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: at(1),
      evidence: { version: 1, uri: "s3://trusted-inputs/moderation.json", sha256: SHA.b, byteLength: 1, mediaType: "application/json" },
    },
    license: {
      version: 1,
      status: "verified",
      basis: "provider-terms",
      territories: ["CN"],
      licenseSha256: SHA.d,
      evidence: { version: 1, uri: "s3://trusted-inputs/license.txt", sha256: SHA.d, byteLength: 1, mediaType: "text/plain" },
      issuedBy: "private-provider",
      issuedAt: at(0),
      expiresAt: null,
    },
  };
  return createProductionDispatchIntent(draft);
}

function h3IntentFor(id = "take-h3"): ProductionDispatchIntent {
  const generic = intentFor([INPUTS[0]!], id);
  const { idempotencyKey: _ignored, ...draft } = generic;
  return createProductionDispatchIntent({
    ...draft,
    execution: {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "minimax-h3",
      backendInstanceId: "comfy-h3-prod-a",
      workflowSha256: SHA.a,
      modelSha256: SHA.b,
      parametersSha256: SHA.c,
      variant: "fl2va",
      durationSeconds: 6,
      shortEdge: 768,
      aspectRatio: "9:16",
    },
  } satisfies ProductionIntentDraft);
}

/** 契约 v2 / 云家族用的 ShotRequest：inputs[0] 的真实对象，stage kernel 对它做内容校验（§5.3）。 */
const SHOT_REQUEST = parseShotRequest({
  version: 1,
  kind: "writing-loop/shot-request",
  shotId: "EP001-S1-1",
  subject: {
    version: 1,
    episode: {
      version: 1,
      episodeId: "episode-001",
      revision: 2,
      source: { version: 1, uri: "cas://wl-sg/sha256/" + SHA.a, sha256: SHA.a, byteLength: 8_192, mediaType: "text/markdown" },
    },
    shotId: "EP001-S1-1",
    revision: 1,
    source: { version: 1, uri: "cas://wl-sg/sha256/" + SHA.a, sha256: SHA.a, byteLength: 8_192, mediaType: "text/markdown" },
  },
  provenance: {
    storyDesignSha256: SHA.b,
    assetsRevision: 12,
    visualProductionSha256: null,
    beatCardHash: "8137791889ad",
    scriptLine: 17,
    mergedScriptLines: [],
  },
  scene: {
    sceneId: "S01", subscene: null, timeOfDay: "night", interior: "ext",
    lightingStateId: "LIGHT_NIGHT", dressingVariantId: "DRESS_A",
  },
  camera: {
    shot_size: "wide", camera_movement: "dolly_out", lens_mm: 35, lighting_key: "natural",
    depth_of_field: "deep", color_temperature: "neutral", cameraId: "CAM_A",
  },
  cast: [],
  props: [],
  crowd: null,
  action: "蒸汽机车穿过城楼门洞，白汽扑上琉璃瓦。",
  productionTags: ["特效"],
  dialogue: [],
  output: {
    aspectRatio: "9:16", generateAudio: true, durationSeconds: 8,
    storyboardDurationSeconds: 8, fps: 24, seed: 4_242,
  },
  continuity: {
    stageGroup: "EP001-S1",
    prevShotId: null,
    anchorMode: "keyframes",
    firstFrame: {
      // 与 index 1 实际 stage 的资产同一 sha256：stage kernel 会逐条比对 ShotRequest 与回执。
      asset: {
        version: 1,
        uri: "cas://wl-sg/sha256/" + digest(PNG),
        sha256: digest(PNG),
        byteLength: PNG.byteLength,
        mediaType: "image/png",
      },
      origin: { kind: "operator-upload", note: "首帧由操作者上传" },
      containsRealFace: false,
    },
    lastFrame: null,
    references: [],
    referencePolicy: "trim_by_priority",
    droppedReferences: [],
    spatialPasses: [],
    fingerprint: { modelSha256: SHA.b, workflowSha256: SHA.a, seed: 4_242, seedReproducible: true },
  },
  prompt: {
    text: "未来玉京城楼，蒸汽机车穿过门洞，白汽扑上琉璃瓦，广角缓慢后拉。",
    negativeText: null,
    language: "zh-CN",
    authoredBy: "episode-writer",
    compiler: "production-shot-request@1",
    selectedTranslation: null,
  },
  compile: { draftSha256: SHA.d, policyDigest: SHA.a, degradations: [] },
});

function h3V2IntentFor(inputs: AssetRef[], id = "take-h3-v2"): ProductionDispatchIntent {
  const generic = intentFor(inputs, id);
  const { idempotencyKey: _ignored, ...draft } = generic;
  return createProductionDispatchIntent({
    ...draft,
    execution: {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "minimax-h3",
      backendInstanceId: "comfy-h3-prod-a",
      workflowSha256: SHA.a,
      modelSha256: SHA.b,
      parametersSha256: SHA.c,
      variant: "fl2va",
      durationSeconds: 8,
      shortEdge: 768,
      aspectRatio: "9:16",
    },
  } satisfies ProductionIntentDraft);
}

function seedanceIntentFor(inputs: AssetRef[], id = "take-seedance"): ProductionDispatchIntent {
  const generic = intentFor(inputs, id);
  const { idempotencyKey: _ignored, ...draft } = generic;
  return createProductionDispatchIntent({
    ...draft,
    execution: {
      version: 1,
      operation: "ark-video-task",
      modelFamily: "seedance",
      backendInstanceId: "ark-sg-1",
      workflowSha256: SHA.a,
      modelSha256: SHA.b,
      parametersSha256: SHA.c,
      provider: "byteplus-modelark",
      modelId: "dreamina-seedance-2-0-260128",
      resolution: "720p",
      aspectRatio: "9:16",
      generateAudio: true,
      watermark: false,
      returnLastFrame: true,
      executionExpiresAfterSeconds: 7_200,
    },
  } satisfies ProductionIntentDraft);
}

function v2ProfileFor(lookup: ProductionStageProfileLookup): ProductionStageProfile {
  return {
    version: 1,
    registration: structuredClone(lookup),
    providerCasNamespace: "wlcas/sha256",
    inputs: [
      { version: 1, index: 0, slot: "shot-request", mediaTypes: [SHOT_REQUEST_MEDIA_TYPE] },
      { version: 1, index: 1, slot: "first_frame", mediaTypes: ["image/png"] },
    ],
  };
}

function cloudProfileFor(
  lookup: ProductionStageProfileLookup,
  maxReferenceImages: number,
): ProductionStageProfile {
  return {
    version: 1,
    registration: structuredClone(lookup),
    providerCasNamespace: "wlcas/sha256",
    slotPolicy: [
      { version: 1, slot: "shot-request", minCount: 1, maxCount: 1, mediaTypes: [SHOT_REQUEST_MEDIA_TYPE] },
      {
        version: 1, slot: "reference_image", minCount: 1, maxCount: maxReferenceImages,
        mediaTypes: ["image/png"],
      },
    ],
  };
}

function assetSource(asset: AssetRef, bytes: Uint8Array): ProductionStageAssetSource {
  return {
    version: 1,
    assetSha256: asset.sha256,
    byteLength: asset.byteLength,
    mediaType: asset.mediaType,
    body: new Response(bytes).body!,
  };
}

const BASE_INTENT = intentFor();
const BASE_SCOPE: ProductionInputStageScope = { version: 1, workspaceId: WS, project: PROJECT };

function bodyFor(intent: ProductionDispatchIntent, scope = BASE_SCOPE): ProductionInputStageRequest {
  return {
    version: 1,
    stageKey: productionInputStageKey(scope.workspaceId, scope.project, intent),
    scope,
    taskId: intent.taskId,
    intentDigest: intent.idempotencyKey,
    execution: structuredClone(intent.execution),
    inputs: intent.inputs.map((asset, index) => ({ version: 1, index, asset: structuredClone(asset) })),
  };
}

type StageRequestOptions = {
  body?: unknown;
  pathScope?: ProductionInputStageScope;
  pathStageKey?: string;
  headerStageKey?: string | null;
  token?: string | null;
  method?: string;
  contentType?: string;
  contentLength?: string | null;
  suffix?: string;
  rawBody?: string | ReadableStream<Uint8Array>;
};

function stageRequest(options: StageRequestOptions = {}): Request {
  const body = options.body ?? bodyFor(BASE_INTENT);
  const typed = body as Partial<ProductionInputStageRequest>;
  const pathScope = options.pathScope ?? typed.scope ?? BASE_SCOPE;
  const pathStageKey = options.pathStageKey ?? typed.stageKey ?? SHA.a;
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  const token = options.token === undefined
    ? (pathScope.project === OTHER_PROJECT ? OTHER_TOKEN : TOKEN)
    : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const headerKey = options.headerStageKey === undefined ? pathStageKey : options.headerStageKey;
  if (headerKey !== null) headers.set("x-writing-loop-idempotency-key", headerKey);
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set("content-length", options.contentLength);
  }
  return new Request(
    `http://stage.private/v1/scopes/${encodeURIComponent(pathScope.workspaceId)}`
      + `/${encodeURIComponent(pathScope.project)}/stages/${pathStageKey}${options.suffix ?? ""}`,
    {
      method: options.method ?? "PUT",
      headers,
      body: options.rawBody ?? JSON.stringify(body),
      ...(options.rawBody instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit,
  );
}

function profileFor(lookup: ProductionStageProfileLookup, intent: ProductionDispatchIntent): ProductionStageProfile {
  return {
    version: 1,
    registration: structuredClone(lookup),
    providerCasNamespace: "wlcas/sha256",
    inputs: intent.inputs.map((input, index) => ({
      version: 1,
      index,
      slot: index === 0 ? "first_frame" : `reference_audio.${index}`,
      mediaTypes: [input.mediaType],
    })),
  };
}

type HarnessOptions = {
  credentialResolver?: ProductionStageGatewayOptions["credentialResolver"];
  profileResolver?: ProductionStageGatewayOptions["profileRegistry"]["resolve"];
  assetResolver?: ProductionStageGatewayOptions["assetResolver"]["resolve"];
  assetPolicies?: ProductionStageGatewayOptions["assetPolicies"];
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxAssetBytes?: number;
  hooks?: ProductionStageGatewayHooks;
  storeRoot?: string;
};

type Harness = {
  gateway: ProductionStageGateway;
  storeRoot: string;
  counts: { credentials: number; profiles: number; assets: number };
  profiles: ProductionStageProfile[];
};

async function harness(intent = BASE_INTENT, overrides: HarnessOptions = {}): Promise<Harness> {
  const storeRoot = overrides.storeRoot ?? root();
  const counts = { credentials: 0, profiles: 0, assets: 0 };
  const profiles: ProductionStageProfile[] = [];
  const bytesBySha = new Map<string, Uint8Array>([
    [digest(PNG), PNG], [digest(WAV), WAV], [digest(PLAIN), PLAIN],
  ]);
  const gateway = await ProductionStageGateway.create({
    storeRoot,
    credentialResolver: overrides.credentialResolver ?? ((scope) => {
      counts.credentials++;
      return scope.project === OTHER_PROJECT ? OTHER_TOKEN : TOKEN;
    }),
    profileRegistry: {
      resolve: overrides.profileResolver ?? ((lookup) => {
        counts.profiles++;
        if (lookup.taskId !== intent.taskId || lookup.intentDigest !== intent.idempotencyKey
          || JSON.stringify(lookup.execution) !== JSON.stringify(intent.execution)
          || JSON.stringify(lookup.inputs) !== JSON.stringify(bodyFor(intent).inputs)) return null;
        const profile = profileFor(lookup, intent);
        profiles.push(profile);
        return profile;
      }),
    },
    assetResolver: {
      resolve: overrides.assetResolver ?? ((_scope, asset) => {
        counts.assets++;
        const bytes = bytesBySha.get(asset.sha256);
        if (!bytes) throw new Error("asset missing URL=secret");
        return {
          version: 1,
          assetSha256: asset.sha256,
          byteLength: asset.byteLength,
          mediaType: asset.mediaType,
          body: new Response(bytes).body!,
        };
      }),
    },
    assetPolicies: overrides.assetPolicies ?? [{ version: 1, scheme: "s3:", authority: "trusted-inputs" }],
    timeoutMs: overrides.timeoutMs,
    maxRequestBytes: overrides.maxRequestBytes,
    maxAssetBytes: overrides.maxAssetBytes ?? 1024 * 1024,
    hooks: overrides.hooks,
  });
  return { gateway, storeRoot, counts, profiles };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

try {
  // Happy path: exact scoped registry lookup, verified streams and sha-only provider object keys.
  const happy = await harness();
  const requestBody = bodyFor(BASE_INTENT);
  const firstResponse = await happy.gateway.handle(stageRequest({ body: requestBody }));
  const first = await json(firstResponse) as unknown as ProductionInputStageResult;
  const expectedKeys = BASE_INTENT.inputs.map((input) =>
    `wlcas/sha256/${input.sha256.slice(0, 2)}/${input.sha256}`);
  ok(firstResponse.status === 200 && first.version === 1 && first.stageKey === requestBody.stageKey
    && first.bindings.length === 2
    && first.bindings.map((binding) => binding.slot).join(",") === "first_frame,reference_audio.1"
    && first.bindings.map((binding) => binding.providerObjectKey).join(",") === expectedKeys.join(","),
  "合法 scoped PUT 由 trusted profile 生成 ordered slots 与纯 sha-derived provider CAS keys");
  ok(happy.counts.credentials === 1 && happy.counts.profiles === 1 && happy.counts.assets === 2,
  "每个新 stage 只调用 scoped credential/profile registry 与 allowlisted asset resolver，不含推理/adapter port");
  for (let index = 0; index < BASE_INTENT.inputs.length; index++) {
    const input = BASE_INTENT.inputs[index]!;
    const objectPath = join(happy.storeRoot, "objects", ...expectedKeys[index]!.split("/"));
    const info = lstatSync(objectPath);
    ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o400
      && digest(readFileSync(objectPath)) === input.sha256,
    `input[${index}] 经长度/sha/MIME magic 复核后只读原子发布到 provider CAS`);
  }
  const receiptPath = join(happy.storeRoot, "receipts", WS, PROJECT, `${requestBody.stageKey}.json`);
  ok(existsSync(receiptPath) && (lstatSync(receiptPath).mode & 0o777) === 0o400,
    "成功 stage 以 scoped 只读 receipt durable 发布");

  const profileDigest = productionStageProfileDigest(happy.profiles[0]!);
  const backendProfileDrift = structuredClone(happy.profiles[0]!);
  backendProfileDrift.registration.execution.backendInstanceId = "comfy-prod-b";
  const slotProfileDrift = structuredClone(happy.profiles[0]!);
  slotProfileDrift.inputs![0] = { ...slotProfileDrift.inputs![0]!, slot: "alternate_first_frame" };
  const namespaceProfileDrift = structuredClone(happy.profiles[0]!);
  namespaceProfileDrift.providerCasNamespace = "othercas/sha256";
  ok(profileDigest.length === 64
    && productionStageProfileDigest(backendProfileDrift) !== profileDigest
    && productionStageProfileDigest(slotProfileDrift) !== profileDigest
    && productionStageProfileDigest(namespaceProfileDrift) !== profileDigest,
  "profileDigest canonical 绑定完整 execution（含 backend）、ordered slot schema 与 provider namespace");
  const verifiedReceipt = await happy.gateway.verifyStageReceipt({
    version: 1,
    scope: BASE_SCOPE,
    stageKey: first.stageKey,
    bindingsDigest: first.bindingsDigest,
    intentDigest: BASE_INTENT.idempotencyKey,
    profileDigest,
  });
  ok(verifiedReceipt !== null
    && JSON.stringify(verifiedReceipt.execution) === JSON.stringify(BASE_INTENT.execution)
    && JSON.stringify(verifiedReceipt.bindings) === JSON.stringify(first.bindings)
    && Object.isFrozen(verifiedReceipt) && Object.isFrozen(verifiedReceipt.execution)
    && Object.isFrozen(verifiedReceipt.bindings) && Object.isFrozen(verifiedReceipt.bindings[0]),
  "job gateway 获得 detached immutable exact receipt：claim + execution + ordered provider bindings");
  ok((await happy.gateway.verifyStageReceipt({
    version: 1,
    scope: BASE_SCOPE,
    stageKey: first.stageKey,
    bindingsDigest: SHA.a,
    intentDigest: BASE_INTENT.idempotencyKey,
    profileDigest,
  })) === null && (await happy.gateway.verifyStageReceipt({
    version: 1,
    scope: { ...BASE_SCOPE, project: OTHER_PROJECT },
    stageKey: first.stageKey,
    bindingsDigest: first.bindingsDigest,
    intentDigest: BASE_INTENT.idempotencyKey,
    profileDigest,
  })) === null, "receipt registry 对 bindings drift 与跨 scope claim 均返回 null，且不进行网络/推理");

  const replayText = JSON.stringify(first);
  const replayResponse = await happy.gateway.handle(stageRequest({ body: requestBody }));
  ok(replayResponse.status === 200 && JSON.stringify(await replayResponse.json()) === replayText
    && happy.counts.profiles === 1 && happy.counts.assets === 2,
  "exact replay 直接返回 immutable receipt，不重复 registry/AssetRef 解析或 CAS side effect");
  const driftBody = structuredClone(requestBody);
  driftBody.execution.workflowSha256 = SHA.d;
  const conflict = await happy.gateway.handle(stageRequest({ body: driftBody, pathStageKey: requestBody.stageKey }));
  ok(conflict.status === 409 && (await json(conflict)).error === "conflict"
    && happy.counts.profiles === 1 && happy.counts.assets === 2,
  "既有 stageKey 遇到 execution/request drift 返回 409，receipt 与 provider objects 不变");
  const intentDigestDrift = structuredClone(requestBody);
  intentDigestDrift.intentDigest = SHA.d;
  const inputDrift = structuredClone(requestBody);
  inputDrift.inputs[0] = { ...inputDrift.inputs[0]!, asset: { ...inputDrift.inputs[0]!.asset, sha256: SHA.d } };
  ok((await happy.gateway.handle(stageRequest({
    body: intentDigestDrift, pathStageKey: requestBody.stageKey,
  }))).status === 409 && (await happy.gateway.handle(stageRequest({
    body: inputDrift, pathStageKey: requestBody.stageKey,
  }))).status === 409,
  "既有 immutable receipt 对 intentDigest/ordered AssetRef drift 也统一返回 409，不泄漏内部校验类别");

  // Concurrency converges through immutable object/receipt publication.
  const concurrent = await harness();
  const concurrentBody = bodyFor(BASE_INTENT);
  const concurrentResponses = await Promise.all([
    concurrent.gateway.handle(stageRequest({ body: concurrentBody })),
    concurrent.gateway.handle(stageRequest({ body: concurrentBody })),
  ]);
  const concurrentTexts = await Promise.all(concurrentResponses.map(async (value) => await value.text()));
  ok(concurrentResponses.every((value) => value.status === 200)
    && concurrentTexts[0] === concurrentTexts[1]
    && existsSync(join(concurrent.storeRoot, "receipts", WS, PROJECT, `${concurrentBody.stageKey}.json`)),
  "并发 exact PUT 通过 CAS/O_EXCL atomic receipt 收敛到逐字节相同 winner");
  const postConcurrentDrift = structuredClone(concurrentBody);
  postConcurrentDrift.execution.parametersSha256 = SHA.d;
  ok((await concurrent.gateway.handle(stageRequest({
    body: postConcurrentDrift, pathStageKey: concurrentBody.stageKey,
  }))).status === 409, "并发 winner 之后任何相同 key/different bytes 都稳定 conflict");

  // Scope and rotating credentials bind path, body, auth resolver and receipt directory together.
  let rotatedToken = TOKEN;
  const scoped = await harness(BASE_INTENT, {
    credentialResolver: (scope) => scope.project === PROJECT ? rotatedToken : OTHER_TOKEN,
  });
  ok((await scoped.gateway.handle(stageRequest({ token: "wrong" }))).status === 401,
    "错误 bearer 在 body/profile/asset 解析前被 scoped credential resolver 拒绝");
  const scopedFirst = await scoped.gateway.handle(stageRequest());
  rotatedToken = "rotated-stage-token-SECRET";
  const oldToken = await scoped.gateway.handle(stageRequest({ token: TOKEN }));
  const newToken = await scoped.gateway.handle(stageRequest({ token: rotatedToken }));
  ok(scopedFirst.status === 200 && oldToken.status === 401 && newToken.status === 200,
    "credential 每次请求按 scope 重新解析，轮换后旧 token 立即失效且新 token 可 exact replay");
  const crossScope = await scoped.gateway.handle(stageRequest({
    body: bodyFor(BASE_INTENT),
    pathScope: { version: 1, workspaceId: WS, project: OTHER_PROJECT },
    token: OTHER_TOKEN,
  }));
  ok(crossScope.status === 403 && !existsSync(join(
    scoped.storeRoot, "receipts", WS, OTHER_PROJECT, `${requestBody.stageKey}.json`,
  )), "path/body/auth scope 不一致时拒绝跨 scope 读取、写入或 receipt replay");

  // Registry is authoritative for the exact execution tuple and ordered slot/media schema.
  const missingProfile = await harness(BASE_INTENT, { profileResolver: () => null });
  ok((await missingProfile.gateway.handle(stageRequest())).status === 403,
    "未注册 intent/execution tuple 在 asset resolver 前 fail-closed");
  const driftProfile = await harness(BASE_INTENT, {
    profileResolver: (lookup) => {
      const profile = profileFor(lookup, BASE_INTENT);
      profile.registration.intentDigest = SHA.d;
      return profile;
    },
  });
  ok((await driftProfile.gateway.handle(stageRequest())).status === 403,
    "registry 返回的 registration 必须 exact 复核 scope/task/intent/execution/ordered AssetRef tuple");
  const substitutedAsset = asset("s3://trusted-inputs/episode/substitute.png", PNG, "image/png");
  const substitutedBody = structuredClone(bodyFor(BASE_INTENT));
  substitutedBody.inputs[0] = { version: 1, index: 0, asset: substitutedAsset };
  substitutedBody.stageKey = productionInputStageIdentityKey({
    version: 1,
    scope: substitutedBody.scope,
    taskId: substitutedBody.taskId,
    intentDigest: substitutedBody.intentDigest,
    execution: substitutedBody.execution,
    inputs: substitutedBody.inputs,
  });
  const substituted = await harness();
  const substitutedResponse = await substituted.gateway.handle(stageRequest({ body: substitutedBody }));
  ok(substitutedResponse.status === 403 && substituted.counts.assets === 0
    && !existsSync(join(substituted.storeRoot, "receipts", WS, PROJECT, `${substitutedBody.stageKey}.json`)),
  "已注册 intentDigest 不能被调用方替换 ordered AssetRef；registry 在 resolver/receipt 前 exact fail-closed");
  const shortProfile = await harness(BASE_INTENT, {
    profileResolver: (lookup) => ({ ...profileFor(lookup, BASE_INTENT), inputs: [profileFor(lookup, BASE_INTENT).inputs![0]!] }),
  });
  ok((await shortProfile.gateway.handle(stageRequest())).status === 403,
    "profile slot 数量必须完整覆盖 ordered intent inputs");
  const wrongMediaProfile = await harness(BASE_INTENT, {
    profileResolver: (lookup) => {
      const profile = profileFor(lookup, BASE_INTENT);
      profile.inputs![0] = { ...profile.inputs![0]!, mediaTypes: ["video/mp4"] };
      return profile;
    },
  });
  ok((await wrongMediaProfile.gateway.handle(stageRequest())).status === 415,
    "AssetRef mediaType 必须被对应 ordered profile slot 明确允许");
  const h3Intent = h3IntentFor();
  const h3 = await harness(h3Intent);
  const h3Response = await h3.gateway.handle(stageRequest({ body: bodyFor(h3Intent) }));
  const h3Profile = h3.profiles[0]!;
  const h3ProfileDigest = productionStageProfileDigest(h3Profile);
  const h3DurationDrift = structuredClone(h3Profile);
  if (h3DurationDrift.registration.execution.modelFamily === "minimax-h3") {
    h3DurationDrift.registration.execution.durationSeconds = 10;
  }
  const h3AspectDrift = structuredClone(h3Profile);
  if (h3AspectDrift.registration.execution.modelFamily === "minimax-h3") {
    h3AspectDrift.registration.execution.aspectRatio = "16:9";
  }
  ok(h3Response.status === 200 && h3Profile.inputs![0]?.slot === "first_frame"
    && productionStageProfileDigest(h3DurationDrift) !== h3ProfileDigest
    && productionStageProfileDigest(h3AspectDrift) !== h3ProfileDigest,
  "H3-over-Comfy profile exact 绑定 variant/duration/aspect ratio 与 ordered semantic slot");
  const callerSlot = await harness();
  const callerSlotBody = { ...bodyFor(BASE_INTENT), slot: "caller_injected", providerObjectKey: "evil/key" };
  ok((await callerSlot.gateway.handle(stageRequest({ body: callerSlotBody }))).status === 400,
    "request schema 拒绝 caller slot/providerObjectKey，semantic binding 只能来自 server registry");

  // AssetRef allowlist removes arbitrary network/path/redirect/DNS surfaces before resolver use.
  const httpsInput = asset("https://cdn.example/stable/input.png", PNG, "image/png");
  const httpsIntent = intentFor([httpsInput], "take-https");
  const httpsHarness = await harness(httpsIntent);
  ok((await httpsHarness.gateway.handle(stageRequest({ body: bodyFor(httpsIntent) }))).status === 403
    && httpsHarness.counts.assets === 0,
  "即使是无 query 的 https AssetRef 也不能绕过 server scheme+authority/CAS allowlist 或触发 DNS");
  const pathAsset: AssetRef = {
    ...INPUTS[0]!, uri: "s3://trusted-inputs/%2e%2e/private/secret.png",
  };
  const pathIntent = intentFor([pathAsset], "take-path");
  const pathHarness = await harness(pathIntent);
  ok((await pathHarness.gateway.handle(stageRequest({ body: bodyFor(pathIntent) }))).status === 403
    && pathHarness.counts.assets === 0,
  "allowlisted authority 内的 encoded traversal 仍在 resolver 前被拒绝");
  const doubleEncodedPathAsset: AssetRef = {
    ...INPUTS[0]!, uri: "s3://trusted-inputs/%252e%252e/private/secret.png",
  };
  const doubleEncodedPathIntent = intentFor([doubleEncodedPathAsset], "take-double-path");
  const doubleEncodedPathHarness = await harness(doubleEncodedPathIntent);
  ok((await doubleEncodedPathHarness.gateway.handle(stageRequest({
    body: bodyFor(doubleEncodedPathIntent),
  }))).status === 403 && doubleEncodedPathHarness.counts.assets === 0,
  "多重 percent decoding 不能让 server SDK/CAS resolver 对路径产生歧义");
  let metadataCalls = 0;
  const metadataHarness = await harness(BASE_INTENT, {
    assetResolver: (_scope, asset) => {
      metadataCalls++;
      const bytes = asset.sha256 === digest(PNG) ? PNG : WAV;
      return {
        version: 1,
        assetSha256: asset.sha256,
        byteLength: asset.byteLength,
        mediaType: asset.mediaType,
        body: new Response(bytes).body!,
        redirect: "https://evil.example/?token=SECRET",
      } as unknown as ProductionStageAssetSource;
    },
  });
  const metadataResponse = await metadataHarness.gateway.handle(stageRequest());
  ok(metadataResponse.status === 502 && metadataCalls === 1
    && !(await metadataResponse.text()).includes("evil.example"),
  "resolver source DTO 严格拒绝 URL/header/redirect 等任意 metadata，并只暴露脱敏类别");
  let badPolicy = false;
  try { await harness(BASE_INTENT, { assetPolicies: [{ version: 1, scheme: "https:", authority: "cdn.example" }] }); }
  catch (error) { badPolicy = error instanceof ProductionStageGatewayError; }
  ok(badPolicy, "server policy 自身也不能配置 public HTTP(S)/file fetch 或 DNS-rebind surface");

  // Byte length, digest and MIME magic are independently reverified while streaming.
  const wrongHash = await harness(BASE_INTENT, {
    assetResolver: (_scope, asset) => ({
      version: 1,
      assetSha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      body: new Response(Buffer.alloc(asset.byteLength, 0x41)).body!,
    }),
  });
  ok((await wrongHash.gateway.handle(stageRequest())).status === 422,
    "resolver 返回同长度但 sha256 错误的 bytes 时 asset-integrity fail-closed");
  const wrongLengthMetadata = await harness(BASE_INTENT, {
    assetResolver: (_scope, asset) => ({
      version: 1,
      assetSha256: asset.sha256,
      byteLength: asset.byteLength + 1,
      mediaType: asset.mediaType,
      body: new Response(PNG).body!,
    }),
  });
  ok((await wrongLengthMetadata.gateway.handle(stageRequest())).status === 502,
    "resolver 声明 byteLength 与 immutable AssetRef 不一致时不读取 stream");
  const truncated = await harness(BASE_INTENT, {
    assetResolver: (_scope, asset) => ({
      version: 1,
      assetSha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      body: new Response((asset.sha256 === digest(PNG) ? PNG : WAV).subarray(0, 5)).body!,
    }),
  });
  ok((await truncated.gateway.handle(stageRequest())).status === 422,
    "stream 实际长度短于 AssetRef byteLength 时拒绝发布 object/receipt");
  const fakeImage = asset("s3://trusted-inputs/fake.png", PLAIN, "image/png");
  const fakeImageIntent = intentFor([fakeImage], "take-fake-image");
  const fakeImageHarness = await harness(fakeImageIntent);
  ok((await fakeImageHarness.gateway.handle(stageRequest({ body: bodyFor(fakeImageIntent) }))).status === 415,
    "sha/length 均正确但 MIME magic 与 mediaType 不符时拒绝 staging");
  const tooLargeAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/too-large.png",
    sha256: SHA.a,
    byteLength: 2_048,
    mediaType: "image/png",
  };
  const tooLargeIntent = intentFor([tooLargeAsset], "take-too-large");
  const tooLargeHarness = await harness(tooLargeIntent, { maxAssetBytes: 1_024 });
  ok((await tooLargeHarness.gateway.handle(stageRequest({ body: bodyFor(tooLargeIntent) }))).status === 413
    && tooLargeHarness.counts.assets === 0,
  "AssetRef 声明超出 per-asset bound 时在 resolver stream 前拒绝");

  // Request/asset deadline and abort are single absolute bounds.
  const bounded = await harness(BASE_INTENT, { maxRequestBytes: 1_024 });
  const hugeBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_025)); controller.close(); },
  });
  ok((await bounded.gateway.handle(stageRequest({ rawBody: hugeBody }))).status === 413,
    "无 Content-Length request stream 仍按累计 bytes 上限截断");
  let deadlineSawAbort = false;
  const deadline = await harness(BASE_INTENT, {
    timeoutMs: 60,
    assetResolver: async (_scope, _asset, signal) => await new Promise<ProductionStageAssetSource>((_resolve, reject) => {
      signal.addEventListener("abort", () => { deadlineSawAbort = true; reject(signal.reason); }, { once: true });
    }),
  });
  const deadlineStart = Date.now();
  ok((await deadline.gateway.handle(stageRequest())).status === 503 && deadlineSawAbort
    && Date.now() - deadlineStart < 1_000,
  "auth/body/profile/asset stream 共用单一 absolute deadline，并传播到 active resolver");
  let callerSawAbort = false;
  let resolverStarted!: () => void;
  const resolverReady = new Promise<void>((resolve) => { resolverStarted = resolve; });
  const aborting = await harness(BASE_INTENT, {
    assetResolver: async (_scope, _asset, signal) => await new Promise<ProductionStageAssetSource>((_resolve, reject) => {
      resolverStarted();
      signal.addEventListener("abort", () => { callerSawAbort = true; reject(signal.reason); }, { once: true });
    }),
  });
  const callerController = new AbortController();
  const pendingAbort = aborting.gateway.handle(new Request(stageRequest(), { signal: callerController.signal }));
  await resolverReady;
  callerController.abort(new Error("caller token=SECRET"));
  const abortedResponse = await pendingAbort;
  ok(abortedResponse.status === 503 && callerSawAbort && !(await abortedResponse.text()).includes("SECRET"),
    "caller abort 中止 resolver/stream，且错误响应不回显 signal reason/token");

  // Crash points leave either no receipt or a complete immutable receipt; retries converge exactly.
  let beforeReceiptCrash = true;
  const crashBefore = await harness(BASE_INTENT, {
    hooks: { beforeReceiptPublish: () => { if (beforeReceiptCrash) { beforeReceiptCrash = false; throw new Error("crash"); } } },
  });
  const crashBody = bodyFor(BASE_INTENT);
  const crashed = await crashBefore.gateway.handle(stageRequest({ body: crashBody }));
  const crashReceipt = join(crashBefore.storeRoot, "receipts", WS, PROJECT, `${crashBody.stageKey}.json`);
  ok(crashed.status === 500 && !existsSync(crashReceipt)
    && existsSync(join(crashBefore.storeRoot, "objects", ...expectedKeys[0]!.split("/"))),
  "before receipt crash 可留下 verified immutable CAS object，但绝不伪造成功 receipt");
  const recovered = await crashBefore.gateway.handle(stageRequest({ body: crashBody }));
  ok(recovered.status === 200 && existsSync(crashReceipt),
    "crash retry 重验既有 CAS object 并原子发布同一 receipt");
  let afterReceiptCrash = true;
  const crashAfter = await harness(BASE_INTENT, {
    hooks: { afterReceiptPublished: () => { if (afterReceiptCrash) { afterReceiptCrash = false; throw new Error("crash"); } } },
  });
  const afterBody = bodyFor(BASE_INTENT);
  const afterFailure = await crashAfter.gateway.handle(stageRequest({ body: afterBody }));
  const resolverCallsAfterReceipt = crashAfter.counts.assets;
  const afterRecovery = await crashAfter.gateway.handle(stageRequest({ body: afterBody }));
  ok(afterFailure.status === 500 && afterRecovery.status === 200
    && crashAfter.counts.assets === resolverCallsAfterReceipt,
  "receipt publish 后 crash 的 retry 只 exact replay，不重复 resolver/CAS side effect");
  let tempCrash = true;
  const crashTemp = await harness(BASE_INTENT, {
    hooks: { afterAssetTempSynced: () => { if (tempCrash) { tempCrash = false; throw new Error("crash"); } } },
  });
  ok((await crashTemp.gateway.handle(stageRequest())).status === 500
    && readdirSync(join(crashTemp.storeRoot, "tmp")).length === 0
    && !existsSync(join(crashTemp.storeRoot, "objects", ...expectedKeys[0]!.split("/")))
    && !existsSync(join(crashTemp.storeRoot, "receipts", WS, PROJECT, `${bodyFor(BASE_INTENT).stageKey}.json`)),
  "asset temp fsync 后 crash 会清理 O_EXCL temp，且不会留下 object/receipt 假成功");

  const staleLink = await harness();
  await staleLink.gateway.handle(stageRequest());
  const staleObject = join(staleLink.storeRoot, "objects", ...expectedKeys[0]!.split("/"));
  const staleObjectTemp = join(staleLink.storeRoot, "tmp", `asset-${"e".repeat(48)}.tmp`);
  linkSync(staleObject, staleObjectTemp);
  const sameAssetsNewIntent = intentFor(INPUTS, "take-after-object-link-crash");
  staleLink.gateway.close();
  const staleObjectRecoveryGateway = await harness(sameAssetsNewIntent, { storeRoot: staleLink.storeRoot });
  const staleLinkRecovery = await staleObjectRecoveryGateway.gateway.handle(stageRequest({
    body: bodyFor(sameAssetsNewIntent),
  }));
  ok(staleLinkRecovery.status === 200 && !existsSync(staleObjectTemp)
    && lstatSync(staleObject).nlink === 1,
  "link→unlink 窗口进程崩溃留下的 trusted asset temp hardlink 会在下次 CAS publish 时安全收敛");

  const staleReceipt = await harness();
  await staleReceipt.gateway.handle(stageRequest());
  const staleReceiptPath = join(
    staleReceipt.storeRoot, "receipts", WS, PROJECT, `${bodyFor(BASE_INTENT).stageKey}.json`,
  );
  const staleReceiptTemp = join(staleReceipt.storeRoot, "tmp", `receipt-${"d".repeat(48)}.tmp`);
  linkSync(staleReceiptPath, staleReceiptTemp);
  const staleReceiptReplay = await staleReceipt.gateway.handle(stageRequest());
  ok(staleReceiptReplay.status === 200 && !existsSync(staleReceiptTemp)
    && lstatSync(staleReceiptPath).nlink === 1,
  "link→unlink 窗口进程崩溃留下的 trusted temp hardlink 会在 exact receipt replay 时安全收敛");

  // Filesystem attacks cannot replace immutable CAS/receipt targets.
  const attackedRoot = root();
  const attackedKey = expectedKeys[0]!;
  const attackedPath = join(attackedRoot, "objects", ...attackedKey.split("/"));
  mkdirSync(join(attackedRoot, "objects", ...attackedKey.split("/").slice(0, -1)), { recursive: true, mode: 0o700 });
  const victim = join(attackedRoot, "victim");
  writeFileSync(victim, Buffer.from("victim"));
  symlinkSync(victim, attackedPath);
  const attacked = await harness(BASE_INTENT, { storeRoot: attackedRoot });
  ok((await attacked.gateway.handle(stageRequest())).status === 500
    && readFileSync(victim, "utf8") === "victim",
  "预置 provider object symlink 不会被跟随、覆盖或当成 CAS 命中");

  const receiptAttack = await harness();
  await receiptAttack.gateway.handle(stageRequest());
  const linkedReceipt = join(
    receiptAttack.storeRoot, "receipts", WS, PROJECT, `${bodyFor(BASE_INTENT).stageKey}.json`,
  );
  linkSync(linkedReceipt, join(receiptAttack.storeRoot, "receipt-hardlink"));
  ok((await receiptAttack.gateway.handle(stageRequest())).status === 500,
    "nlink>1 receipt 不被可信 replay registry 接受");

  // —— stage 契约 v2：index 0 shot-request slot、内容校验与 slotPolicy（§5.3、§6.5） ——
  const shotRequestBytes = Buffer.from(shotRequestCanonicalJson(SHOT_REQUEST), "utf8");
  const shotRequestAsset: AssetRef = {
    version: 1,
    uri: `s3://trusted-inputs/episode/${SHOT_REQUEST.shotId}.json`,
    sha256: digest(shotRequestBytes),
    byteLength: shotRequestBytes.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const v2Intent = h3V2IntentFor([shotRequestAsset, INPUTS[0]!]);
  const v2 = await harness(v2Intent, {
    profileResolver: (lookup) => v2ProfileFor(lookup),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === shotRequestAsset.sha256
      ? shotRequestBytes
      : PNG),
  });
  const v2Response = await v2.gateway.handle(stageRequest({ body: bodyFor(v2Intent) }));
  const v2Result = await v2Response.json() as ProductionInputStageResult;
  ok(v2Response.status === 200 && v2Result.bindings[0]?.slot === "shot-request"
    && v2Result.bindings[1]?.slot === "first_frame"
    && v2Result.shotRequest?.assetSha256 === shotRequestAsset.sha256
    && v2Result.shotRequest.prompt === SHOT_REQUEST.prompt.text
    && v2Result.shotRequest.seed === SHOT_REQUEST.output.seed,
  "stage 契约 v2：index 0 为 shot-request slot，回执携带逐镜 prompt / seed 投影");

  // 同一份文档，只是键序不同：sha256 按这串字节计算，因此内容校验必须靠 canonical 复算而非 digest。
  const nonCanonical = Buffer.from(
    JSON.stringify(Object.fromEntries(Object.entries(SHOT_REQUEST).reverse())), "utf8",
  );
  const nonCanonicalAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/episode/non-canonical.json",
    sha256: digest(nonCanonical),
    byteLength: nonCanonical.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const nonCanonicalIntent = h3V2IntentFor([nonCanonicalAsset, INPUTS[0]!], "take-h3-v2-noncanonical");
  const nonCanonicalHarness = await harness(nonCanonicalIntent, {
    profileResolver: (lookup) => v2ProfileFor(lookup),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === nonCanonicalAsset.sha256
      ? nonCanonical
      : PNG),
  });
  ok((await nonCanonicalHarness.gateway.handle(stageRequest({ body: bodyFor(nonCanonicalIntent) }))).status === 422,
    "shot-request 对象必须是 canonical ShotRequest 字节，重新序列化的等价文档被拒");

  const plainJson = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
  const plainAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/episode/plain.json",
    sha256: digest(plainJson),
    byteLength: plainJson.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const plainIntent = h3V2IntentFor([plainAsset, INPUTS[0]!], "take-h3-v2-plain");
  const plainHarness = await harness(plainIntent, {
    profileResolver: (lookup) => v2ProfileFor(lookup),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === plainAsset.sha256 ? plainJson : PNG),
  });
  ok((await plainHarness.gateway.handle(stageRequest({ body: bodyFor(plainIntent) }))).status === 415,
    "shot-request slot 改为内容校验：不是 ShotRequest 的 JSON 被拒");

  const driftedShotRequest = parseShotRequest({
    ...structuredClone(SHOT_REQUEST),
    output: { ...SHOT_REQUEST.output, aspectRatio: "16:9" },
  });
  const driftedBytes = Buffer.from(shotRequestCanonicalJson(driftedShotRequest), "utf8");
  const driftedAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/episode/drifted.json",
    sha256: digest(driftedBytes),
    byteLength: driftedBytes.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const driftedIntent = h3V2IntentFor([driftedAsset, INPUTS[0]!], "take-h3-v2-drift");
  const driftedHarness = await harness(driftedIntent, {
    profileResolver: (lookup) => v2ProfileFor(lookup),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === driftedAsset.sha256 ? driftedBytes : PNG),
  });
  ok((await driftedHarness.gateway.handle(stageRequest({ body: bodyFor(driftedIntent) }))).status === 415,
    "ShotRequest 的 output 意图必须与 immutable execution 一致，画幅漂移被拒");

  // 云家族：slotPolicy 顺序与计数区间，可重复 slot 以带序号实例回执。ShotRequest 的 references[]
  // 必须与实际 stage 的三张图逐条同 sha256，否则本次 stage 被拒（见下面的错配用例）。
  const referenceAssets = [SHA.a, SHA.b, SHA.c].map((seed, index) => ({
    version: 1 as const,
    uri: `s3://trusted-inputs/episode/reference-${index}.png`,
    sha256: digest(Buffer.concat([PNG, Buffer.from(seed.slice(0, 4))])),
    byteLength: PNG.byteLength + 4,
    mediaType: "image/png",
  }));
  const referenceBytes = new Map(referenceAssets.map((asset, index) =>
    [asset.sha256, Buffer.concat([PNG, Buffer.from([SHA.a, SHA.b, SHA.c][index]!.slice(0, 4))])]));
  const referenceShotRequest = parseShotRequest({
    ...structuredClone(SHOT_REQUEST),
    continuity: {
      ...structuredClone(SHOT_REQUEST.continuity),
      anchorMode: "references",
      firstFrame: null,
      lastFrame: null,
      references: referenceAssets.map((asset, index) => ({
        asset: { ...asset, uri: `cas://wl-sg/sha256/${asset.sha256}` },
        purpose: "character-identity",
        subjectId: null,
        priority: (index + 1) as 1 | 2 | 3,
        containsRealFace: false,
      })),
    },
  });
  const referenceShotRequestBytes = Buffer.from(shotRequestCanonicalJson(referenceShotRequest), "utf8");
  const referenceShotRequestAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/episode/ref-shot-request.json",
    sha256: digest(referenceShotRequestBytes),
    byteLength: referenceShotRequestBytes.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const cloudBytesFor = (asset: AssetRef): Uint8Array =>
    asset.sha256 === referenceShotRequestAsset.sha256
      ? referenceShotRequestBytes
      : asset.sha256 === shotRequestAsset.sha256 ? shotRequestBytes : referenceBytes.get(asset.sha256)!;
  const cloudIntent = seedanceIntentFor([referenceShotRequestAsset, ...referenceAssets]);
  const cloudHarness = await harness(cloudIntent, {
    profileResolver: (lookup) => cloudProfileFor(lookup, 3),
    assetResolver: (_scope, asset) => assetSource(asset, cloudBytesFor(asset)),
  });
  const cloudResponse = await cloudHarness.gateway.handle(stageRequest({ body: bodyFor(cloudIntent) }));
  const cloudResult = await cloudResponse.json() as ProductionInputStageResult;
  ok(cloudResponse.status === 200
    && cloudResult.bindings.map((binding) => binding.slot).join(",")
      === "shot-request,reference_image.0,reference_image.1,reference_image.2",
  "slotPolicy 的 maxCount > 1 经真实 stage kernel 产出带序号的 slot 实例");

  const overCountHarness = await harness(cloudIntent, {
    profileResolver: (lookup) => cloudProfileFor(lookup, 2),
    assetResolver: (_scope, asset) => assetSource(asset, cloudBytesFor(asset)),
  });
  ok((await overCountHarness.gateway.handle(stageRequest({ body: bodyFor(cloudIntent) }))).status === 403,
    "staged 输入超出 slotPolicy 的 maxCount 时 stage kernel 拒绝");

  // ShotRequest 声明的连续性输入与实际 stage 的资产必须逐条一致（顺序、slot 与 sha256）。
  const swappedIntent = seedanceIntentFor(
    [referenceShotRequestAsset, referenceAssets[1]!, referenceAssets[0]!, referenceAssets[2]!],
    "take-seedance-swapped",
  );
  const swappedHarness = await harness(swappedIntent, {
    profileResolver: (lookup) => cloudProfileFor(lookup, 3),
    assetResolver: (_scope, asset) => assetSource(asset, cloudBytesFor(asset)),
  });
  ok((await swappedHarness.gateway.handle(stageRequest({ body: bodyFor(swappedIntent) }))).status === 403,
    "staged 参考顺序与 ShotRequest.references 不一致时被拒");
  const foreignFrameIntent = h3V2IntentFor([shotRequestAsset, INPUTS[1]!], "take-h3-v2-foreign-frame");
  const foreignFrameHarness = await harness(foreignFrameIntent, {
    profileResolver: (lookup) => ({
      ...v2ProfileFor(lookup),
      inputs: [
        { version: 1, index: 0, slot: "shot-request", mediaTypes: [SHOT_REQUEST_MEDIA_TYPE] },
        { version: 1, index: 1, slot: "first_frame", mediaTypes: ["audio/wav"] },
      ],
    }),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === shotRequestAsset.sha256
      ? shotRequestBytes
      : WAV),
  });
  ok((await foreignFrameHarness.gateway.handle(stageRequest({ body: bodyFor(foreignFrameIntent) }))).status === 403,
    "staged 首帧不是 ShotRequest.continuity.firstFrame 指向的资产时被拒");

  // prompt.text 按 graph 契约的 bounded scalar 规则校验。NUL 已被 parseShotRequest 拒绝，两条规则的
  // 实际差集是 VT / FF / DEL：它们能通过 ShotRequest 解析，却不能进 pinned graph 的字面量。
  const controlPrompt = parseShotRequest({
    ...structuredClone(SHOT_REQUEST),
    prompt: { ...structuredClone(SHOT_REQUEST.prompt), text: "夜色\u000c天台" },
  });
  const controlBytes = Buffer.from(shotRequestCanonicalJson(controlPrompt), "utf8");
  const controlAsset: AssetRef = {
    version: 1,
    uri: "s3://trusted-inputs/episode/control-prompt.json",
    sha256: digest(controlBytes),
    byteLength: controlBytes.byteLength,
    mediaType: SHOT_REQUEST_MEDIA_TYPE,
  };
  const controlIntent = h3V2IntentFor([controlAsset, INPUTS[0]!], "take-h3-v2-control-prompt");
  const controlHarness = await harness(controlIntent, {
    profileResolver: (lookup) => v2ProfileFor(lookup),
    assetResolver: (_scope, asset) => assetSource(asset, asset.sha256 === controlAsset.sha256 ? controlBytes : PNG),
  });
  ok((await controlHarness.gateway.handle(stageRequest({ body: bodyFor(controlIntent) }))).status === 415,
    "prompt.text 含控制字符时 stage kernel 拒绝（与 pinned graph 的 bounded scalar 同一规则）");

  // No inference/adapter surface is present or invoked by a stage operation.
  let inferenceCalls = 0;
  const noInference = await harness();
  await noInference.gateway.handle(stageRequest());
  ok(inferenceCalls === 0 && noInference.counts.assets === 2,
    "stage gateway 只解析/校验/复制资产；不会提交 Comfy/H3 job 或触发推理计费");

  for (const instance of [
    happy, concurrent, scoped, missingProfile, driftProfile, substituted, shortProfile, wrongMediaProfile,
    h3, callerSlot, httpsHarness, pathHarness, doubleEncodedPathHarness, metadataHarness, wrongHash,
    wrongLengthMetadata, truncated, fakeImageHarness, tooLargeHarness, bounded, deadline, aborting,
    crashBefore, crashAfter, crashTemp, attacked, receiptAttack, staleObjectRecoveryGateway, staleReceipt,
    noInference, v2, nonCanonicalHarness, plainHarness, driftedHarness, cloudHarness, overCountHarness,
    swappedHarness, foreignFrameHarness, controlHarness,
  ]) instance.gateway.close();
} finally {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_STAGE_GATEWAY_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
