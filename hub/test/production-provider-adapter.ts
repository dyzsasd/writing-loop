// Provider adapter 协议（DESIGN §4.4）：ComfyUI 薄包装与被包装 adapter 行为一致；云形态与 §4.3
// capability、§4.5 locator 只到类型与严格解析。
import { createHash } from "node:crypto";
import {
  ComfyUiAdapter,
  ProductionAdapterError,
  type FetchLike,
  type PreparedSubmission,
} from "../src/production-adapter.ts";
import {
  comfyUiProviderAdapter,
  parseBackendCapabilities,
  parsePreparedProviderSubmission,
  parseProductionOutputLocator,
  parseProviderJobRef,
  providerInputSlotOrderViolation,
  providerSlotPolicyViolation,
  providerSlotSequenceViolation,
  type ProviderInputSlot,
  type ProviderSlotPolicyEntry,
} from "../src/production-provider-adapter.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const rejects = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof ProductionAdapterError && error.message.includes(needle); }
};

const PROMPT = "11111111-1111-4111-8111-111111111111";
const SHA = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64) };
const WORKFLOW: Record<string, unknown> = { "3": { class_type: "KSampler", inputs: { seed: 42 } } };
const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" },
});

/** 无状态的 fake ComfyUI：同一序列对两个客户端返回同样的响应，结果可逐字节比对。 */
function fakeComfy(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input : new URL(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/prompt")) return json({ prompt_id: PROMPT, number: 1, node_errors: {} });
    if (url.pathname.includes("/api/jobs/")) {
      return new Response("404: Not Found", { status: 404, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("/queue")) {
      return method === "POST" ? new Response("", { status: 200 }) : json({ queue_running: [], queue_pending: [] });
    }
    if (url.pathname.includes("/history/")) {
      return json({
        [PROMPT]: {
          status: { completed: true, status_str: "success", messages: [] },
          outputs: { "9": { gifs: [{ filename: "take.mp4", subfolder: "h3", type: "output" }] } },
        },
      });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike): ComfyUiAdapter => new ComfyUiAdapter({
  baseUrl: "https://render.internal.example/comfy/",
  backendInstanceId: "comfy-prod-a",
  clientId: "wl-test-client",
  fetch,
  now: () => new Date("2026-08-28T00:00:00.000Z"),
});

// —— 包装与被包装 adapter 行为一致 ——
{
  const rawPort = fakeComfy();
  const wrappedPort = fakeComfy();
  const raw = client(rawPort.fetch);
  const wrapped = comfyUiProviderAdapter(client(wrappedPort.fetch));
  const request = {
    idempotencyKey: "idem-take-001",
    remoteJobId: PROMPT,
    workflow: structuredClone(WORKFLOW),
    inputBinding: null,
  } as const;

  const rawPrepared = raw.prepareSubmission({ ...request, workflow: structuredClone(WORKFLOW) });
  const wrappedPrepared = wrapped.prepareSubmission({ kind: "comfy-workflow", ...request });
  ok(wrappedPrepared.kind === "comfy-workflow"
    && JSON.stringify((wrappedPrepared as { prepared: PreparedSubmission }).prepared) === JSON.stringify(rawPrepared),
  "prepareSubmission 包装后 envelope 与直接调用逐字节一致");

  const rawSubmit = await raw.submitPrepared(rawPrepared);
  const wrappedSubmit = await wrapped.submitPrepared(wrappedPrepared);
  const { providerJobId, ...wrappedSubmitCore } = wrappedSubmit;
  ok(JSON.stringify(wrappedSubmitCore) === JSON.stringify(rawSubmit) && providerJobId === null,
  "submitPrepared 结果一致，ComfyUI 的 providerJobId 恒为 null");

  const rawObservation = await raw.inspect(PROMPT);
  const wrappedObservation = await wrapped.inspect({ remoteJobId: PROMPT, providerJobId: null });
  ok(JSON.stringify(wrappedObservation) === JSON.stringify(rawObservation)
    && rawObservation.outputs.length === 1 && rawObservation.state === "succeeded",
  "inspect 结果一致（含 outputs 与 responseDigest）");

  const rawCancel = await raw.cancel(PROMPT);
  const wrappedCancel = await wrapped.cancel({ remoteJobId: PROMPT, providerJobId: null });
  ok(JSON.stringify(wrappedCancel) === JSON.stringify(rawCancel) && !rawCancel.confirmed,
  "cancel 结果一致，且不伪造已确认取消");

  ok(rawPort.calls.join("|") === wrappedPort.calls.join("|") && rawPort.calls.length > 0,
  "包装不引入、不省略任何一次远端请求");

  const caps = await wrapped.capabilities();
  ok(caps.backendKind === "comfyui" && caps.providerJobIdMapping === "none",
  "capabilities 直接转发被包装 adapter 的描述");
  ok(wrapped.openOutput === undefined,
  "comfy-view locator 由 ingest kernel 经 /view 取回，包装不提供 openOutput");
}

// —— 形态判别：云请求与外来 providerJobId 一律拒绝 ——
{
  const wrapped = comfyUiProviderAdapter(client(fakeComfy().fetch));
  ok(rejects(() => wrapped.prepareSubmission({
    kind: "cloud-video",
    idempotencyKey: "idem-a",
    remoteJobId: PROMPT,
    execution: null as never,
    shotRequest: null as never,
    boundInputs: [],
  }), "只接受 comfy-workflow 形态"), "ComfyUI 包装拒绝 cloud-video 请求形态");
  let refRejected = false;
  try { await wrapped.inspect({ remoteJobId: PROMPT, providerJobId: "task-9" }); }
  catch (error) { refRejected = error instanceof ProductionAdapterError && error.message.includes("不分配 providerJobId"); }
  ok(refRejected, "ComfyUI 包装拒绝携带 providerJobId 的 ref");
  ok(rejects(() => parseProviderJobRef({ remoteJobId: PROMPT }), "缺少字段"), "ProviderJobRef 执行 exactKeys");
}

// —— §4.5 locator：三种 source 的解析与拒绝 ——
{
  const comfy = { nodeId: "9", kind: "video", filename: "take.mp4", subfolder: "h3", folderType: "output" };
  const legacy = parseProductionOutputLocator(comfy);
  const tagged = parseProductionOutputLocator({ source: "comfy-view", ...comfy });
  ok(legacy.source === "comfy-view" && JSON.stringify(legacy) === JSON.stringify(tagged),
  "缺少 source 时按 comfy-view 读取，与显式 comfy-view 等价");
  const provider = parseProductionOutputLocator({
    source: "provider-output", remoteJobId: "job-1", outputIndex: 1, role: "last-frame", kind: "image",
  });
  ok(provider.source === "provider-output" && provider.kind === "image"
    && !Object.prototype.hasOwnProperty.call(provider, "filename"),
  "provider-output locator 不含 URL 与 comfy 路径字段");
  ok(rejects(() => parseProductionOutputLocator({ source: "gcs", ...comfy }), "comfy-view 或 provider-output"),
  "未知 source 被拒绝");
  ok(rejects(() => parseProductionOutputLocator({
    source: "provider-output", remoteJobId: "job-1", outputIndex: 0, role: "primary", kind: "audio",
  }), "kind"), "provider-output 的 kind 只允许 video / image");
  ok(rejects(() => parseProductionOutputLocator({
    source: "provider-output", remoteJobId: "job-1", outputIndex: 0, role: "primary", kind: "video",
    filename: "take.mp4",
  }), "含不支持字段"), "provider-output 不接受 comfy 字段混写");
  ok(rejects(() => parseProductionOutputLocator({ ...comfy, subfolder: "../etc" }), "不安全的远端路径"),
  "comfy-view 仍拒绝路径穿越");
  ok(rejects(() => parseProductionOutputLocator({ source: null, ...comfy }), "comfy-view 或 provider-output"),
  "显式 source: null 不按缺省读取，是无效值");
  ok(rejects(() => parseProductionOutputLocator({ ...comfy, filename: "take\u0000.mp4" }), "不安全的远端路径")
    && rejects(() => parseProductionOutputLocator({ ...comfy, subfolder: "h3\u001f" }), "不安全的远端路径"),
  "comfy-view 拒绝控制字符");
  ok(rejects(() => parseProductionOutputLocator({ ...comfy, filename: "." }), "单段文件名")
    && rejects(() => parseProductionOutputLocator({ ...comfy, filename: ".." }), "不安全的远端路径"),
  "comfy-view 拒绝 . 与 .. 作为文件名");
}

// —— §4.4 PreparedProviderSubmission ——
{
  const body = new TextEncoder().encode(JSON.stringify({ model: "doubao-seedance-2-5-260628" }));
  const cloud = {
    kind: "cloud-video",
    version: 1,
    backendInstanceId: "ark-sg-1",
    remoteJobId: PROMPT,
    idempotencyKey: "idem-take-002",
    requestDigest: createHash("sha256").update(body).digest("hex"),
    executionProfileSha256: SHA.b,
    shotRequestSha256: SHA.a,
    boundInputs: [
      { index: 0, slot: "shot-request", assetSha256: SHA.a, providerObjectKey: "cas/shot.json" },
      { index: 1, slot: "first_frame", assetSha256: SHA.b, providerObjectKey: "cas/first.png" },
      { index: 2, slot: "reference_image", assetSha256: SHA.c, providerObjectKey: "cas/ref-0.png" },
    ],
    wire: {
      method: "POST",
      url: "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
      headersDigest: SHA.c,
      body,
    },
  };
  const parsed = parsePreparedProviderSubmission(cloud);
  ok(parsed.kind === "cloud-video" && parsed.boundInputs.length === 3
    && parsed.boundInputs[0]!.slot === "shot-request",
  "cloud-video prepared 形态解析：wire 字节、slot 顺序与 digest 自洽");
  ok(rejects(() => parsePreparedProviderSubmission({ ...cloud, requestDigest: SHA.a }), "与 wire.body 的真实字节不一致"),
  "requestDigest 必须等于 sha256(wire.body)");
  ok(rejects(() => parsePreparedProviderSubmission({ ...cloud, shotRequestSha256: SHA.c }), "boundInputs[0].assetSha256"),
  "shotRequestSha256 必须等于 boundInputs[0].assetSha256");
  ok(rejects(() => parsePreparedProviderSubmission({
    ...cloud,
    boundInputs: [
      { index: 0, slot: "shot-request", assetSha256: SHA.a, providerObjectKey: "cas/shot.json" },
      { index: 1, slot: "reference_image", assetSha256: SHA.c, providerObjectKey: "cas/ref-0.png" },
      { index: 2, slot: "first_frame", assetSha256: SHA.b, providerObjectKey: "cas/first.png" },
    ],
  }), "固定输入顺序"), "boundInputs 违反固定输入顺序被拒绝");
  ok(rejects(() => parsePreparedProviderSubmission({
    ...cloud,
    boundInputs: [{ index: 0, slot: "first_frame", assetSha256: SHA.a, providerObjectKey: "cas/first.png" }],
    shotRequestSha256: SHA.a,
  }), "inputs[0] 必须是 shot-request"), "boundInputs[0] 必须是 ShotRequest");
  ok(rejects(() => parsePreparedProviderSubmission({
    ...cloud, wire: { ...cloud.wire, url: "http://ark.internal/api" },
  }), "https URL"), "wire.url 只接受 https");
  ok(rejects(() => parsePreparedProviderSubmission({
    ...cloud, wire: { ...cloud.wire, method: "PUT" },
  }), "必须是 POST"), "wire.method 只接受 POST");
  ok(rejects(() => parsePreparedProviderSubmission({ ...cloud, kind: "ark" }), "comfy-workflow 或 cloud-video"),
  "未知 prepared 形态被拒绝");

  const comfyPrepared = client(fakeComfy().fetch).prepareSubmission({
    idempotencyKey: "idem-take-003", remoteJobId: PROMPT, workflow: structuredClone(WORKFLOW), inputBinding: null,
  });
  const parsedComfy = parsePreparedProviderSubmission({ kind: "comfy-workflow", prepared: comfyPrepared });
  ok(parsedComfy.kind === "comfy-workflow"
    && JSON.stringify(parsedComfy.prepared) === JSON.stringify(comfyPrepared),
  "comfy-workflow prepared 形态原样通过判别联合解析");
  ok(rejects(() => parsePreparedProviderSubmission({
    kind: "comfy-workflow", prepared: { ...comfyPrepared, remoteJobId: "22222222-2222-4222-8222-222222222222" },
  }), "与 envelope 不一致"), "comfy-workflow envelope 与内层 request 的 ID 必须一致");
  ok(rejects(() => parsePreparedProviderSubmission({
    kind: "comfy-workflow",
    prepared: {
      ...comfyPrepared,
      request: {
        ...comfyPrepared.request,
        inputBinding: { version: 1, stageKey: SHA.a, bindingsDigest: SHA.b, intentDigest: "idem-take-003" },
      },
    },
  }), "intentDigest"), "scoped inputBinding 的 intentDigest 必须是 sha256（与 job gateway 同判据）");
  ok(rejects(() => parsePreparedProviderSubmission({
    kind: "comfy-workflow",
    prepared: {
      ...comfyPrepared,
      request: { ...comfyPrepared.request, workflow: { big: { text: "x".repeat(3 * 1024 * 1024) } } },
    },
  }), "bytes"), "comfy-workflow 的 graph 在解析期就受字节上限约束");
}

// —— §6.5 slotPolicy 判据 ——
{
  const policy = (entries: ProviderSlotPolicyEntry[]): ProviderSlotPolicyEntry[] => entries;
  const seedancePolicy = policy([
    { slot: "shot-request", minCount: 1, maxCount: 1 },
    { slot: "first_frame", minCount: 1, maxCount: 1 },
    { slot: "last_frame", minCount: 0, maxCount: 1 },
    { slot: "reference_image", minCount: 0, maxCount: 3 },
  ]);
  ok(providerSlotPolicyViolation(seedancePolicy) === null, "slotPolicy 良构：顺序升序、单例 maxCount=1");
  ok(providerSlotPolicyViolation(policy([{ slot: "first_frame", minCount: 1, maxCount: 1 }])) !== null
    && providerSlotPolicyViolation(policy([{ slot: "shot-request", minCount: 0, maxCount: 1 }])) !== null
    && providerSlotPolicyViolation(policy([
      { slot: "shot-request", minCount: 1, maxCount: 1 }, { slot: "first_frame", minCount: 0, maxCount: 2 },
    ])) !== null
    && providerSlotPolicyViolation(policy([
      { slot: "shot-request", minCount: 1, maxCount: 1 },
      { slot: "last_frame", minCount: 0, maxCount: 1 },
      { slot: "first_frame", minCount: 0, maxCount: 1 },
    ])) !== null
    && providerSlotPolicyViolation(policy([
      { slot: "shot-request", minCount: 1, maxCount: 1 }, { slot: "reference_image", minCount: 3, maxCount: 2 },
    ])) !== null,
  "slotPolicy 拒绝首项非 shot-request、shot-request 计数不为 1、单例 maxCount>1、slot 乱序与空计数区间");
  ok(providerSlotSequenceViolation(seedancePolicy, ["shot-request", "first_frame"]) === null
    && providerSlotSequenceViolation(seedancePolicy, ["shot-request", "first_frame", "last_frame"]) === null,
  "同一 slotPolicy 同时承载 i2v（无尾帧）与 fl2v（有尾帧）");
  ok(providerSlotSequenceViolation(seedancePolicy, ["shot-request"]) !== null
    && providerSlotSequenceViolation(
      seedancePolicy,
      ["shot-request", "first_frame", "reference_image", "reference_image", "reference_image", "reference_image"],
    ) !== null
    && providerSlotSequenceViolation(seedancePolicy, ["shot-request", "last_frame", "first_frame"]) !== null
    && providerSlotSequenceViolation(seedancePolicy, ["shot-request", "first_frame", "reference_video"]) !== null,
  "slotPolicy 拒绝缺 min、超 max、顺序错与词表内但未声明的 slot");
}

// —— slot 顺序判据（runtime config 的 slotPolicy 与 gateway 的 BoundInput 共用） ——
{
  const order = (slots: ProviderInputSlot[]): string | null => providerInputSlotOrderViolation(slots);
  ok(order(["shot-request", "first_frame", "last_frame", "reference_image", "reference_image", "reference_audio"]) === null,
  "固定顺序下参考类 slot 可重复");
  ok(order(["first_frame"]) !== null && order(["shot-request", "last_frame", "first_frame"]) !== null
    && order(["shot-request", "first_frame", "first_frame"]) !== null && order([]) !== null,
  "缺 ShotRequest、乱序与单例 slot 重复均被拒绝");
}

// —— §4.3 capability 解析 ——
{
  const source = await new ComfyUiAdapter({
    baseUrl: "https://render.internal.example/comfy/",
    backendInstanceId: "comfy-prod-a",
    fetch: fakeComfy().fetch,
    processingRegions: ["SG"],
    maxInputImageBytes: 30 * 1024 * 1024,
    h3Profiles: [{
      profileId: "h3-9x16-8s", variant: "fl2va", durationSeconds: 8, aspectRatio: "9:16", graphContractVersion: 1,
    }],
  }).capabilities();
  const wire = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const parsed = parseBackendCapabilities(wire);
  ok(JSON.stringify(parsed) === JSON.stringify(wire),
  "ComfyUiAdapter 的 capability 跨线往返后逐字段不变");
  ok(parsed.limitsByModelId["h3-9x16-8s"]?.durationSeconds.grid?.join(",") === "8"
    && parsed.limitsByModelId["h3-9x16-8s"]?.outputRetention.kind === "comfy-history",
  "limitsByModelId 以 modelId 为键逐条解析，含取回窗口");
  for (const [label, mutate] of [
    ["缺 limitsByModelId", (row: Record<string, unknown>) => { delete row.limitsByModelId; }],
    ["缺 processingRegions", (row: Record<string, unknown>) => { delete row.processingRegions; }],
    ["未知 backendKind", (row: Record<string, unknown>) => { row.backendKind = "runpod"; }],
    ["伪造 provider 幂等", (row: Record<string, unknown>) => { row.providerIdempotency = true; }],
    ["未知 providerJobIdMapping", (row: Record<string, unknown>) => { row.providerJobIdMapping = "provider-assigned"; }],
    ["地域集合别名", (row: Record<string, unknown>) => { row.processingRegions = ["EU"]; }],
    ["modelFamilies 重复", (row: Record<string, unknown>) => { row.modelFamilies = ["generic", "generic"]; }],
    ["时长网格乱序", (row: Record<string, unknown>) => {
      const limits = (row.limitsByModelId as Record<string, { durationSeconds: { grid: number[] } }>)["h3-9x16-8s"]!;
      limits.durationSeconds.grid = [8, 5];
    }],
    ["首尾帧与参考互斥被否认", (row: Record<string, unknown>) => {
      (row.limitsByModelId as Record<string, Record<string, unknown>>)["h3-9x16-8s"]!
        .keyframesAndReferencesExclusive = false;
    }],
    ["未知取回窗口", (row: Record<string, unknown>) => {
      (row.limitsByModelId as Record<string, Record<string, unknown>>)["h3-9x16-8s"]!
        .outputRetention = { kind: "provider-cache" };
    }],
  ] as const) {
    const broken = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    mutate(broken);
    let refused = false;
    try { parseBackendCapabilities(broken); }
    catch (error) { refused = error instanceof ProductionAdapterError && error.code === "invalid-response"; }
    ok(refused, `capability 解析拒绝：${label}`);
  }
  const probed = JSON.parse(JSON.stringify(wire)) as Record<string, Record<string, Record<string, unknown>>>;
  probed.limitsByModelId["h3-9x16-8s"]!.nativeAudio = {
    status: "unverified",
    channels: null,
    verifiedBy: {
      modelId: "h3-9x16-8s", probeRemoteJobId: PROMPT, providerJobId: null,
      at: "2026-08-28T00:00:00.000Z", hasAudio: true,
    },
  };
  ok(parseBackendCapabilities(probed).limitsByModelId["h3-9x16-8s"]?.nativeAudio.verifiedBy?.modelId === "h3-9x16-8s",
  "nativeAudio.verifiedBy 绑定探针所用的 modelId");
  for (const at of ["not-a-time", "2026-08-28T00:00:00Z", "2026-13-01T00:00:00.000Z"]) {
    const broken = JSON.parse(JSON.stringify(probed)) as Record<string, Record<string, Record<string, unknown>>>;
    (broken.limitsByModelId["h3-9x16-8s"]!.nativeAudio as Record<string, unknown>).verifiedBy = {
      modelId: "h3-9x16-8s", probeRemoteJobId: PROMPT, providerJobId: null, at, hasAudio: true,
    };
    let refused = false;
    try { parseBackendCapabilities(broken); }
    catch (error) { refused = error instanceof ProductionAdapterError && error.code === "invalid-response"; }
    ok(refused, `nativeAudio.verifiedBy.at 拒绝非规范时间 ${JSON.stringify(at)}`);
  }
}

console.log(fails === 0 ? "\nPRODUCTION_PROVIDER_ADAPTER_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
