// Server-side production backend boundary. The browser never receives backend endpoints or
// credentials; adapters exchange stable remote IDs and bounded DTOs only.
import { createHash, randomUUID } from "node:crypto";
// Type-only on purpose: this module stays a runtime leaf (node:crypto only), so the shot-request /
// intent vocabularies can name capability fields without joining their import cycle.
import type { H3AspectRatio, H3Variant, ProductionModelFamily } from "./production-intent.ts";
import type { ShotModelFamily, VideoMode } from "./production-shot-request.ts";

export type ProductionAdapterErrorCode =
  | "aborted"
  | "submission-unknown"
  | "remote-rejected"
  | "remote-unavailable"
  | "invalid-response"
  | "response-too-large";

export class ProductionAdapterError extends Error {
  readonly code: ProductionAdapterErrorCode;
  readonly status: number | null;
  readonly causeCode: Exclude<ProductionAdapterErrorCode, "submission-unknown"> | null;

  constructor(
    code: ProductionAdapterErrorCode,
    message: string,
    options: { status?: number; cause?: unknown; causeCode?: Exclude<ProductionAdapterErrorCode, "submission-unknown"> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProductionAdapterError";
    this.code = code;
    this.status = options.status ?? null;
    this.causeCode = options.causeCode ?? null;
  }
}

/**
 * 处理地域只接受 ISO-3166 alpha-2 成员国代码：集合别名 EU、非标准码 UK 在解析层拒绝，WORLDWIDE 被
 * 二位码形态排除（§4.7）。capability 与 intent gate 共用该判据。
 */
export const NON_ISO_PROCESSING_REGIONS: ReadonlySet<string> = new Set(["EU", "UK"]);

/**
 * H3 契约的画幅词表（§5.3）。本模块是运行时叶子，不能从 production-intent.ts 值导入，故在此保留一份；
 * hub/test/production-adapter.ts 有与 `H3_ASPECT_RATIOS` 相等的同步用例钉住两者。
 */
export const COMFY_H3_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;

/** §4.3 后端形态。`ShotBackendKind` 是同一词表在编译器侧的别名。 */
export const BACKEND_KINDS = ["comfyui", "volcengine-ark", "byteplus-modelark", "vertex-veo"] as const;
export type BackendKind = typeof BACKEND_KINDS[number];

/** 取回窗口：provider URL 有过期秒数，comfy 的 /history 随进程重启清空（§3、§4.3）。 */
export type VideoOutputRetention =
  | { kind: "provider-url"; seconds: number }
  | { kind: "gcs-object" }
  | { kind: "inline-spool" }
  | { kind: "comfy-history"; bounded: true };

/** §4.3 逐 modelId 的能力上限（H3 以 profileId 为键）。编译器只读该结构裁定镜头级差异。 */
export type VideoBackendLimits = {
  modes: readonly VideoMode[];
  durationSeconds: {
    min: number;
    max: number;
    grid: readonly number[] | null;
    gridByResolution: Readonly<Record<string, readonly number[]>> | null;
  };
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  maxStyleImages: number;
  maxReferenceAssetsTotal: number | null;
  audioOnlyReference: boolean;
  keyframesAndReferencesExclusive: true;
  seed: "unsupported" | "uint32" | "uint32-best-effort" | "int32";
  /** null = 无限制；Veo 为 ["en"]。 */
  promptLanguages: readonly string[] | null;
  promptDirectiveSyntax: "ark-text-flags" | null;
  nativeAudio: {
    status: "supported" | "unsupported" | "unverified";
    channels: "mono" | "stereo" | null;
    /** 必须绑定探针所用的 modelId，禁止跨 modelId 复用（§4.3）。 */
    verifiedBy: {
      modelId: string;
      probeRemoteJobId: string;
      providerJobId: string | null;
      at: string;
      hasAudio: boolean;
    } | null;
  };
  returnsLastFrame: boolean;
  maxInputImageBytes: number;
  inputImageMediaTypes: readonly string[];
  realFaceReferences: "forbidden" | "allowed";
  outputRetention: VideoOutputRetention;
};

/** 编译器消费的 capability 子集（§4.3）；`compileShotRequest` 的入参端口。 */
export type ShotCompileCapability = {
  backendKind: BackendKind;
  backendInstanceId: string;
  modelFamilies: readonly ShotModelFamily[];
  /** ISO-3166 alpha-2：cn-beijing→CN、ap-southeast-1→SG、us-central1→US。 */
  processingRegions: readonly string[];
  /** 按 modelId 索引；H3 以 profileId 为键（§4.3）。 */
  limitsByModelId: Readonly<Record<string, VideoBackendLimits>>;
};

export type BackendCapabilities = {
  backendKind: BackendKind;
  backendInstanceId: string;
  asynchronous: true;
  clientAssignedJobId: true;
  inspectById: true;
  progressHints: "optional-websocket" | "poll-only" | "callback-optional";
  pendingCancellation: "best-effort" | "unsupported";
  runningCancellation: "version-gated-best-effort" | "best-effort" | "unsupported";
  providerIdempotency: false;
  inputModes: readonly ("image-upload" | "cas-object-key" | "inline-base64" | "gcs-uri")[];
  outputModes: readonly ("download" | "provider-signed-url" | "gcs-object" | "inline-base64")[];
  // §4.3 的四个描述字段。`ProductionGatewayAdapter.capabilities()` 转发 gateway 的真实 capability
  // 后它们不再有「进程内过渡字面量」这一缺省来源，因此与跨线解析（parseBackendCapabilities）一致地必填。
  modelFamilies: readonly ProductionModelFamily[];
  processingRegions: readonly string[];
  providerJobIdMapping: "none" | "gateway-durable";
  limitsByModelId: Readonly<Record<string, VideoBackendLimits>>;
};

export type ProductionSubmissionInputBinding = {
  version: 1;
  stageKey: string;
  bindingsDigest: string;
  /** Immutable ProductionDispatchIntent.idempotencyKey. */
  intentDigest: string;
};

export type SubmitRequest = {
  /** Stable identity for one billable intent. Raw ComfyUI does not enforce it. */
  idempotencyKey: string;
  /** Preallocated and persisted before POST so an ambiguous submit remains reconcilable. */
  remoteJobId: string;
  /** ComfyUI API-format workflow, resolved by the trusted server side. */
  workflow: Record<string, unknown>;
  /** Raw ComfyUI accepts only null; the private gateway verifies scoped stage receipts. */
  inputBinding: ProductionSubmissionInputBinding | null;
};

/**
 * A submission envelope prepared and digested before the coordinator persists submission-started.
 * The request remains present so submitPrepared can reconstruct the exact provider bytes and reject
 * caller mutation before any network I/O.
 */
export type PreparedSubmission = {
  version: 1;
  backendInstanceId: string;
  remoteJobId: string;
  idempotencyKey: string;
  requestDigest: string;
  request: SubmitRequest;
};

export type SubmitResult = {
  remoteJobId: string;
  acceptedAt: string;
  providerIdempotency: false;
  nodeErrorCount: number;
  responseDigest: string;
};

export type RemoteJobState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "not-found";

/**
 * §4.5 locator 判别联合的 comfy-view 分支。读取侧对缺省 `source` 仍按 comfy-view 兼容（旧记录），
 * 写入侧总带该键，因此 durable observation 与 ingest 请求体里的 locator 一律是显式判别联合。
 */
export type ComfyViewOutputLocator = {
  source?: "comfy-view";
  nodeId: string;
  kind: "image" | "video" | "audio" | "file";
  filename: string;
  subfolder: string;
  folderType: "input" | "output" | "temp";
};

/** §4.5 provider-output 分支：不含 URL，可落入 control ledger；取回经 adapter 的 openOutput。 */
export type ProviderOutputLocator = {
  source: "provider-output";
  remoteJobId: string;
  outputIndex: number;
  role: "primary" | "last-frame";
  kind: "video" | "image";
};

export type ProductionOutputLocator = ComfyViewOutputLocator | ProviderOutputLocator;

/**
 * durable observation（`RemoteObservation` / `CoordinatorRemoteObservation`）承载 §4.5 的完整判别
 * 联合：ingest kernel 既能经 `comfyBaseUrl/view` 取回 comfy-view 产物，也能经 adapter 的 `openOutput`
 * 取回 provider-output 产物。
 */
export type RemoteOutputLocator = ProductionOutputLocator;

export type RemoteObservation = {
  remoteJobId: string;
  state: RemoteJobState;
  observedAt: string;
  outputs: RemoteOutputLocator[];
  /** Stable, persistence-safe category; never a provider message, URL, token, traceback or input. */
  errorSummary: string | null;
  responseDigest: string;
};

export type CancelResult = {
  remoteJobId: string;
  accepted: boolean;
  /** ComfyUI queue deletion does not prove a running prompt stopped. */
  confirmed: false;
  runningInterruptRequested: boolean;
  observedAt: string;
};

export interface ProductionAdapter {
  capabilities(signal?: AbortSignal): Promise<BackendCapabilities>;
  prepareSubmission(request: SubmitRequest): PreparedSubmission;
  submitPrepared(prepared: PreparedSubmission, signal?: AbortSignal): Promise<SubmitResult>;
  /** Compatibility wrapper. Coordinators must use prepareSubmission -> durable event -> submitPrepared. */
  submit(request: SubmitRequest, signal?: AbortSignal): Promise<SubmitResult>;
  inspect(remoteJobId: string, signal?: AbortSignal): Promise<RemoteObservation>;
  cancel(remoteJobId: string, signal?: AbortSignal): Promise<CancelResult>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * 一档已配置的 H3 profile。契约把 (variant, durationSeconds, aspectRatio) 钉死在 pinned graph 里，
 * 因此时长网格就是已配置 profile 集合（§5.3），capability 以 profileId 为键（§4.3）。
 */
export type ComfyUiH3ProfileCapability = {
  profileId: string;
  variant: H3Variant;
  durationSeconds: number;
  aspectRatio: H3AspectRatio;
  /**
   * 该档所用 H3 graph 契约的版本，由 gateway registry 的 `h3GraphContract.version` 提供。v1 把
   * `RandomNoise.noise_seed` 固定在 pinned graph 内，逐镜 seed 不落图，因此 capability 声明
   * `seed: "unsupported"`；v2 的 seed 是 sentinel、materialize 时逐镜填入，`seed` 为 `"uint32"`（§5.3）。
   */
  graphContractVersion: 1 | 2;
};

export type ComfyUiAdapterOptions = {
  /** Trusted, server-injected URL. Never take this value from an HTTP request. */
  baseUrl: string | URL;
  backendInstanceId: string;
  clientId?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxWorkflowBytes?: number;
  /** Optional v0.24+ optimization. Legacy queue→history remains the audited default. */
  preferJobsApi?: boolean;
  now?: () => Date;
  /** ISO-3166 alpha-2；空集合表示未声明，下游 gate 按 fail-closed 处理（§4.7）。 */
  processingRegions?: readonly string[];
  /** 已配置的 H3 profile 集合：limitsByModelId 的键与时长网格的唯一来源（§5.3）。 */
  h3Profiles?: readonly ComfyUiH3ProfileCapability[];
  /** 自托管没有 provider 侧图片上限，只有部署声明；配置了 h3Profiles 时必填。 */
  maxInputImageBytes?: number;
};

type BoundedJson = { value: unknown; digest: string };
type PendingResponse = {
  response: Response;
  signal: AbortSignal;
  callerAborted: () => boolean;
  timedOut: () => boolean;
  finish: () => void;
  discard: () => void;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUTS = 128;
const MAX_PROCESSING_REGIONS = 64;
const MAX_CAPABILITY_PROFILES = 64;
/** H3 契约把短边钉在 768（§5.3）；分辨率词表以 ShotExecutionProfile.resolution 的取值为准。 */
const H3_RESOLUTION = "768p";
/** ComfyUI LoadImage 可解码的图片类型（stage kernel 允许集合的保守子集）。 */
const H3_INPUT_IMAGE_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const H3_MAX_REFERENCE_IMAGES = 9;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TERRITORY = /^[A-Z]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const JOB_TIME_FIELDS = ["create_time", "update_time", "execution_start_time", "execution_end_time"] as const;
// Do not let a provider smuggle tokens or story text through a merely type-shaped string. Unknown
// custom exceptions remain useful as the stable `execution_error` category; this deliberately small
// allowlist only preserves well-known Python/Comfy/PyTorch exception identifiers.
const SAFE_REMOTE_EXCEPTION_TYPES = new Set([
  "AssertionError",
  "AttributeError",
  "FileNotFoundError",
  "ImportError",
  "IndexError",
  "InterruptProcessingException",
  "KeyError",
  "MemoryError",
  "ModuleNotFoundError",
  "NotImplementedError",
  "OSError",
  "OutOfMemoryError",
  "RuntimeError",
  "TypeError",
  "ValueError",
  "comfy.model_management.InterruptProcessingException",
  "torch.OutOfMemoryError",
  "torch.cuda.OutOfMemoryError",
]);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new ProductionAdapterError("remote-rejected", `${label} 必须是 ${minimum}–${maximum} 的整数`);
  }
  return resolved;
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new ProductionAdapterError("remote-rejected", `${label} 无效`);
  }
  return value;
}

function trustedProcessingRegions(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_PROCESSING_REGIONS) {
    throw new ProductionAdapterError("remote-rejected", `processingRegions 最多 ${MAX_PROCESSING_REGIONS} 项`);
  }
  for (const region of value) {
    // 集合别名 EU、非标准码 UK 与 WORLDWIDE 在解析层拒绝（§4.7），与 production-intent.ts 同一判据。
    if (typeof region !== "string" || !TERRITORY.test(region) || NON_ISO_PROCESSING_REGIONS.has(region)) {
      throw new ProductionAdapterError("remote-rejected", "processingRegions 只接受 ISO-3166 alpha-2 成员国代码");
    }
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new ProductionAdapterError("remote-rejected", "processingRegions 不得重复");
  }
  return Object.freeze(sorted);
}

/**
 * H3 契约的能力事实（§5.3）：fl2va 走 LoadImage 首/尾帧（尾帧可缺省），ref2va 走 ref_images；
 * 短边固定 768；音频由固定 pipeline 生成立体声；尾帧不回传，由 ingest kernel 用 ffmpeg 提取。
 * 逐镜 seed 只有契约 v2 落图，v1 的档声明 seed 不受支持。
 *
 * 导出以便 gateway registry 的只读 profile 快照与 `ComfyUiAdapter.capabilities()` 共用同一份推导：
 * 快照里的 durationGrid 与 capability 的 `limitsByModelId[profileId].durationSeconds.grid` 因此恒等。
 */
export function h3LimitsByProfileId(
  profiles: readonly ComfyUiH3ProfileCapability[],
  maxInputImageBytes: number,
): Readonly<Record<string, VideoBackendLimits>> {
  const limits: Record<string, VideoBackendLimits> = {};
  for (const profile of profiles) {
    // 时长网格 = 同 (variant, aspectRatio) 下已配置的时长档；每档一份 pinned graph 与 config 条目。
    const grid = [...new Set(profiles
      .filter((row) => row.variant === profile.variant && row.aspectRatio === profile.aspectRatio)
      .map((row) => row.durationSeconds))].sort((left, right) => left - right);
    limits[profile.profileId] = Object.freeze({
      modes: Object.freeze(profile.variant === "fl2va" ? ["i2v", "fl2v"] as const : ["ref2v"] as const),
      durationSeconds: Object.freeze({
        min: grid[0]!,
        max: grid[grid.length - 1]!,
        grid: Object.freeze(grid),
        gridByResolution: null,
      }),
      aspectRatios: Object.freeze([profile.aspectRatio]),
      resolutions: Object.freeze([H3_RESOLUTION]),
      maxReferenceImages: profile.variant === "ref2va" ? H3_MAX_REFERENCE_IMAGES : 0,
      maxReferenceVideos: 0,
      maxReferenceAudios: 0,
      maxStyleImages: 0,
      maxReferenceAssetsTotal: null,
      audioOnlyReference: false,
      keyframesAndReferencesExclusive: true,
      seed: profile.graphContractVersion === 2 ? "uint32" : "unsupported",
      promptLanguages: null,
      promptDirectiveSyntax: null,
      nativeAudio: Object.freeze({ status: "supported", channels: "stereo", verifiedBy: null }),
      returnsLastFrame: false,
      maxInputImageBytes,
      inputImageMediaTypes: H3_INPUT_IMAGE_MEDIA_TYPES,
      realFaceReferences: "allowed",
      outputRetention: Object.freeze({ kind: "comfy-history", bounded: true }),
    });
  }
  return Object.freeze(limits);
}

function trustedH3Profiles(
  value: readonly ComfyUiH3ProfileCapability[] | undefined,
  maxInputImageBytes: number | undefined,
): Readonly<Record<string, VideoBackendLimits>> {
  if (value === undefined) return Object.freeze({});
  if (!Array.isArray(value) || value.length > MAX_CAPABILITY_PROFILES) {
    throw new ProductionAdapterError("remote-rejected", `h3Profiles 必须是最多 ${MAX_CAPABILITY_PROFILES} 项的数组`);
  }
  if (value.length === 0) return Object.freeze({});
  // 自托管后端没有 provider 侧的图片上限可引用，只有部署声明；缺省即无判据，不猜一个数字。
  if (maxInputImageBytes === undefined) {
    throw new ProductionAdapterError("remote-rejected", "配置了 h3Profiles 时必须声明 maxInputImageBytes");
  }
  const bytes = boundedInteger(
    maxInputImageBytes, maxInputImageBytes, 1_024, 4 * 1024 * 1024 * 1024, "maxInputImageBytes",
  );
  for (const profile of value) {
    if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
      throw new ProductionAdapterError("remote-rejected", "h3Profiles 项必须是对象");
    }
    identifier(profile.profileId, "h3Profiles[].profileId");
    if (profile.variant !== "fl2va" && profile.variant !== "ref2va") {
      throw new ProductionAdapterError("remote-rejected", "h3Profiles[].variant 必须是 fl2va 或 ref2va");
    }
    if (typeof profile.aspectRatio !== "string"
      || !(COMFY_H3_ASPECT_RATIOS as readonly string[]).includes(profile.aspectRatio)) {
      throw new ProductionAdapterError(
        "remote-rejected", `h3Profiles[].aspectRatio 必须是 ${COMFY_H3_ASPECT_RATIOS.join("、")} 之一`,
      );
    }
    if (profile.graphContractVersion !== 1 && profile.graphContractVersion !== 2) {
      throw new ProductionAdapterError("remote-rejected", "h3Profiles[].graphContractVersion 必须是 1 或 2");
    }
    boundedInteger(profile.durationSeconds, profile.durationSeconds, 1, 600, "h3Profiles[].durationSeconds");
  }
  if (new Set(value.map((profile) => profile.profileId)).size !== value.length) {
    throw new ProductionAdapterError("remote-rejected", "h3Profiles[].profileId 不得重复");
  }
  return h3LimitsByProfileId(value, bytes);
}

function promptId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ProductionAdapterError("remote-rejected", "ComfyUI remoteJobId 必须是预落盘的 canonical UUID");
  }
  return value;
}

function jsonCompatible(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => jsonCompatible(item, depth + 1));
  if (!object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.keys(value).length <= 10_000
    && Object.values(value).every((item) => jsonCompatible(item, depth + 1));
}

function validatePromptGraph(workflow: Record<string, unknown>): void {
  const nodes = Object.entries(workflow);
  if (!nodes.length || nodes.length > 4_096) {
    throw new ProductionAdapterError("remote-rejected", "ComfyUI workflow 节点数无效或超限");
  }
  for (const [nodeId, node] of nodes) {
    if (!IDENTIFIER.test(nodeId) || !object(node)
      || typeof node.class_type !== "string" || !node.class_type || node.class_type.length > 240
      || !object(node.inputs) || !jsonCompatible(node.inputs)
      || (node._meta !== undefined && (!object(node._meta) || !jsonCompatible(node._meta)))) {
      throw new ProductionAdapterError("remote-rejected", `ComfyUI workflow node '${nodeId.slice(0, 80)}' 不是有效 API-format node`);
    }
  }
}

function exactOwnKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    throw new ProductionAdapterError("remote-rejected", `${label} 字段无效`);
  }
}

const submitDefinitelyRejected = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;

function trustedBaseUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new ProductionAdapterError("remote-rejected", "ComfyUI baseUrl 无效", { cause: error }); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new ProductionAdapterError("remote-rejected", "ComfyUI baseUrl 只接受 http(s) URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProductionAdapterError("remote-rejected", "ComfyUI baseUrl 不能包含凭据、query 或 fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function endpoint(base: URL, path: string): URL {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname}${path}`.replace(/\/{2,}/g, "/");
  return url;
}

function contentTypeIsJson(response: Response): boolean {
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  allowEmpty = false,
  signal?: AbortSignal,
): Promise<BoundedJson> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProductionAdapterError("response-too-large", `远端响应超过 ${maxBytes} bytes`);
  }
  const isJson = contentTypeIsJson(response);
  if (!isJson && !allowEmpty) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProductionAdapterError("invalid-response", "远端响应 Content-Type 不是 JSON");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        let part;
        if (signal) {
          let rejectAbort: ((reason?: unknown) => void) | null = null;
          const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
          const onAbort = (): void => rejectAbort?.(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          try { part = await Promise.race([reader.read(), aborted]); }
          catch (error) {
            void reader.cancel(error).catch(() => undefined);
            throw error;
          } finally { signal.removeEventListener("abort", onAbort); }
        } else {
          part = await reader.read();
        }
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new ProductionAdapterError("response-too-large", `远端响应超过 ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = Buffer.concat(chunks, bytes);
  const digest = createHash("sha256").update(body).digest("hex");
  if (!body.length && allowEmpty) return { value: null, digest };
  if (!isJson) throw new ProductionAdapterError("invalid-response", "远端响应 Content-Type 不是 JSON");
  try { return { value: JSON.parse(body.toString("utf8")), digest }; }
  catch (error) { throw new ProductionAdapterError("invalid-response", "远端响应不是有效 JSON", { cause: error }); }
}

function relativeRemotePath(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 512 || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || value.split("/").some((part) => part === "..") || (!allowEmpty && !value)) {
    throw new ProductionAdapterError("invalid-response", `${label} 含不安全的远端路径`);
  }
  return value;
}

function outputKind(group: string): RemoteOutputLocator["kind"] {
  if (group === "images") return "image";
  if (group === "audio") return "audio";
  if (group === "gifs" || group === "videos" || group === "video") return "video";
  return "file";
}

function outputLocators(outputs: unknown): RemoteOutputLocator[] {
  if (outputs === undefined || outputs === null) return [];
  if (!object(outputs)) throw new ProductionAdapterError("invalid-response", "ComfyUI history.outputs 必须是对象");
  const rows: RemoteOutputLocator[] = [];
  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!IDENTIFIER.test(nodeId) || !object(nodeOutput)) {
      throw new ProductionAdapterError("invalid-response", "ComfyUI output node 无效");
    }
    for (const [group, entries] of Object.entries(nodeOutput)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (rows.length >= MAX_OUTPUTS) {
          throw new ProductionAdapterError("invalid-response", `ComfyUI outputs 超过 ${MAX_OUTPUTS} 项`);
        }
        if (!object(entry) || !("filename" in entry)) continue;
        const folderType = entry.type;
        if (folderType !== "input" && folderType !== "output" && folderType !== "temp") {
          throw new ProductionAdapterError("invalid-response", "ComfyUI output.type 无效");
        }
        rows.push({
          // §4.5：写入侧总带 source；读取侧对缺省 source 仍按 comfy-view 兼容。
          source: "comfy-view",
          nodeId,
          kind: outputKind(group),
          filename: relativeRemotePath(entry.filename, "ComfyUI output.filename"),
          subfolder: relativeRemotePath(entry.subfolder ?? "", "ComfyUI output.subfolder", true),
          folderType,
        });
      }
    }
  }
  return rows;
}

function queueCount(value: unknown, remoteJobId: string): number {
  if (!Array.isArray(value)) throw new ProductionAdapterError("invalid-response", "ComfyUI queue 必须是数组");
  return value.filter((row) => Array.isArray(row) && row.length >= 2 && row[1] === remoteJobId).length;
}

function safeExecutionErrorSummary(value: unknown): string {
  if (!object(value) || typeof value.exception_type !== "string") return "execution_error";
  const exceptionType = value.exception_type;
  if (exceptionType.length > 120
    || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(exceptionType)
    || !SAFE_REMOTE_EXCEPTION_TYPES.has(exceptionType)) {
    return "execution_error";
  }
  return `execution_error:${exceptionType}`;
}

function validOptionalJobTimes(value: Record<string, unknown>): boolean {
  return JOB_TIME_FIELDS.every((field) => value[field] === undefined
    || (typeof value[field] === "number" && Number.isFinite(value[field]) && (value[field] as number) >= 0));
}

function statusResult(status: Record<string, unknown> | undefined): {
  state: "running" | "succeeded" | "failed" | "cancelled";
  errorSummary: string | null;
} {
  if (!status) return { state: "running", errorSummary: null };
  const messages = status.messages;
  if (messages !== undefined && (!Array.isArray(messages) || messages.length > 512)) {
    throw new ProductionAdapterError("invalid-response", "ComfyUI history.status.messages 无效或超限");
  }
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const row = messages[index];
      if (!Array.isArray(row) || row.length < 1 || typeof row[0] !== "string") continue;
      if (row[0] === "execution_interrupted") {
        return { state: "cancelled", errorSummary: "execution_interrupted" };
      }
      if (row[0] === "execution_error") {
        return { state: "failed", errorSummary: safeExecutionErrorSummary(row[1]) };
      }
    }
  }
  const statusText = typeof status.status_str === "string" ? status.status_str.slice(0, 240) : null;
  if (statusText !== null && /(?:error|fail)/i.test(statusText)) {
    return { state: "failed", errorSummary: "execution_error" };
  }
  return { state: status.completed === true ? "succeeded" : "running", errorSummary: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ComfyUiAdapter implements ProductionAdapter {
  readonly #baseUrl: URL;
  readonly #backendInstanceId: string;
  readonly #clientId: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxWorkflowBytes: number;
  readonly #preferJobsApi: boolean;
  readonly #now: () => Date;
  readonly #processingRegions: readonly string[];
  readonly #limitsByModelId: Readonly<Record<string, VideoBackendLimits>>;
  readonly #modelFamilies: readonly ProductionModelFamily[];
  #jobsApi: "unknown" | "supported" | "unsupported" = "unknown";

  constructor(options: ComfyUiAdapterOptions) {
    this.#baseUrl = trustedBaseUrl(options.baseUrl);
    this.#backendInstanceId = identifier(options.backendInstanceId, "backendInstanceId");
    this.#clientId = identifier(options.clientId ?? `wl-${randomUUID()}`, "clientId");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 50, 300_000, "timeoutMs");
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes, DEFAULT_RESPONSE_BYTES, 1_024, 16 * 1024 * 1024, "maxResponseBytes",
    );
    this.#maxWorkflowBytes = boundedInteger(
      options.maxWorkflowBytes, DEFAULT_WORKFLOW_BYTES, 1_024, 16 * 1024 * 1024, "maxWorkflowBytes",
    );
    if (options.preferJobsApi !== undefined && typeof options.preferJobsApi !== "boolean") {
      throw new ProductionAdapterError("remote-rejected", "preferJobsApi 必须是 boolean");
    }
    this.#preferJobsApi = options.preferJobsApi ?? false;
    this.#now = options.now ?? (() => new Date());
    this.#processingRegions = trustedProcessingRegions(options.processingRegions);
    this.#limitsByModelId = trustedH3Profiles(options.h3Profiles, options.maxInputImageBytes);
    // 一台 ComfyUI 始终能跑 pinned 的 generic 图；H3 只有在配置了 profile 档时才成立。
    this.#modelFamilies = Object.freeze(
      Object.keys(this.#limitsByModelId).length > 0
        ? ["generic" as const, "minimax-h3" as const]
        : ["generic" as const],
    );
  }

  async capabilities(_signal?: AbortSignal): Promise<BackendCapabilities> {
    return {
      backendKind: "comfyui",
      backendInstanceId: this.#backendInstanceId,
      modelFamilies: this.#modelFamilies,
      processingRegions: this.#processingRegions,
      asynchronous: true,
      clientAssignedJobId: true,
      // 调用方预分配 prompt_id，provider 不另发 ID（§5.3）。
      providerJobIdMapping: "none",
      inspectById: true,
      progressHints: "optional-websocket",
      pendingCancellation: "best-effort",
      runningCancellation: "version-gated-best-effort",
      providerIdempotency: false,
      inputModes: ["image-upload"],
      outputModes: ["download"],
      limitsByModelId: this.#limitsByModelId,
    };
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<PendingResponse> {
    const controller = new AbortController();
    let timedOut = false;
    let finished = false;
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("timeout")); }, this.#timeoutMs);
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    try {
      // Never let fetch follow redirects. A 307/308 would otherwise replay POST /prompt (or a
      // cancellation request) with its body and credentials to a different origin, violating both
      // the exactly-once submission boundary and the trusted-endpoint SSRF boundary.
      const response = await this.#fetch(endpoint(this.#baseUrl, path), {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      return {
        response,
        signal: controller.signal,
        callerAborted: () => signal?.aborted === true,
        timedOut: () => timedOut,
        finish,
        discard: () => {
          void response.body?.cancel().catch(() => undefined);
          if (!controller.signal.aborted) controller.abort(new Error("response discarded"));
          finish();
        },
      };
    } catch (error) {
      finish();
      if (signal?.aborted) throw new ProductionAdapterError("aborted", "远端请求已取消", { cause: error });
      throw new ProductionAdapterError("remote-unavailable", timedOut ? "远端请求超时" : `远端请求失败：${errorMessage(error)}`, { cause: error });
    }
  }

  async #json(path: string, init: RequestInit, signal: AbortSignal | undefined, allowEmpty = false): Promise<BoundedJson> {
    const pending = await this.#request(path, init, signal);
    const response = pending.response;
    if (!response.ok) {
      pending.discard();
      const code = response.status >= 400 && response.status < 500 ? "remote-rejected" : "remote-unavailable";
      throw new ProductionAdapterError(code, `远端返回 HTTP ${response.status}`, { status: response.status });
    }
    return this.#decode(pending, allowEmpty);
  }

  async #decode(pending: PendingResponse, allowEmpty = false): Promise<BoundedJson> {
    try { return await readBoundedJson(pending.response, this.#maxResponseBytes, allowEmpty, pending.signal); }
    catch (error) {
      if (error instanceof ProductionAdapterError) throw error;
      if (pending.callerAborted()) throw new ProductionAdapterError("aborted", "远端响应体读取已取消", { cause: error });
      if (pending.timedOut()) throw new ProductionAdapterError("remote-unavailable", "远端请求超时", { cause: error });
      throw new ProductionAdapterError("invalid-response", `远端响应体读取失败：${errorMessage(error)}`, { cause: error });
    } finally {
      pending.finish();
    }
  }

  #submissionBytes(value: SubmitRequest): {
    request: SubmitRequest;
    body: string;
    requestDigest: string;
  } {
    if (!object(value)) throw new ProductionAdapterError("remote-rejected", "ComfyUI submit request 必须是对象");
    exactOwnKeys(value, ["idempotencyKey", "remoteJobId", "workflow", "inputBinding"], "ComfyUI submit request");
    const idempotencyKey = identifier(value.idempotencyKey, "idempotencyKey");
    const remoteJobId = promptId(value.remoteJobId);
    if (value.inputBinding !== null) {
      throw new ProductionAdapterError("remote-rejected", "raw ComfyUI 不接受 scoped input binding");
    }
    if (!object(value.workflow)) throw new ProductionAdapterError("remote-rejected", "ComfyUI workflow 必须是 API-format 对象");
    validatePromptGraph(value.workflow);
    let body: string;
    try { body = JSON.stringify({ prompt: value.workflow, client_id: this.#clientId, prompt_id: remoteJobId }); }
    catch (error) { throw new ProductionAdapterError("remote-rejected", "ComfyUI workflow 无法序列化", { cause: error }); }
    if (Buffer.byteLength(body) > this.#maxWorkflowBytes) {
      throw new ProductionAdapterError("remote-rejected", `ComfyUI workflow 超过 ${this.#maxWorkflowBytes} bytes`);
    }
    return {
      request: { idempotencyKey, remoteJobId, workflow: value.workflow, inputBinding: null },
      body,
      requestDigest: createHash("sha256").update(body, "utf8").digest("hex"),
    };
  }

  prepareSubmission(request: SubmitRequest): PreparedSubmission {
    const prepared = this.#submissionBytes(request);
    return {
      version: 1,
      backendInstanceId: this.#backendInstanceId,
      remoteJobId: prepared.request.remoteJobId,
      idempotencyKey: prepared.request.idempotencyKey,
      requestDigest: prepared.requestDigest,
      request: prepared.request,
    };
  }

  #validatePreparedSubmission(value: PreparedSubmission): { prepared: PreparedSubmission; body: string } {
    if (!object(value)) throw new ProductionAdapterError("remote-rejected", "PreparedSubmission 必须是对象");
    exactOwnKeys(value, [
      "version", "backendInstanceId", "remoteJobId", "idempotencyKey", "requestDigest", "request",
    ], "PreparedSubmission");
    if (value.version !== 1) throw new ProductionAdapterError("remote-rejected", "PreparedSubmission.version 必须是 1");
    const backendInstanceId = identifier(value.backendInstanceId, "PreparedSubmission.backendInstanceId");
    const remoteJobId = promptId(value.remoteJobId);
    const idempotencyKey = identifier(value.idempotencyKey, "PreparedSubmission.idempotencyKey");
    if (typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)) {
      throw new ProductionAdapterError("remote-rejected", "PreparedSubmission.requestDigest 无效");
    }
    const rebuilt = this.#submissionBytes(value.request);
    if (backendInstanceId !== this.#backendInstanceId
      || remoteJobId !== rebuilt.request.remoteJobId
      || idempotencyKey !== rebuilt.request.idempotencyKey
      || value.requestDigest !== rebuilt.requestDigest) {
      throw new ProductionAdapterError("remote-rejected", "PreparedSubmission 与当前 backend 或请求 bytes 不匹配");
    }
    return {
      prepared: {
        version: 1,
        backendInstanceId,
        remoteJobId,
        idempotencyKey,
        requestDigest: value.requestDigest,
        request: rebuilt.request,
      },
      body: rebuilt.body,
    };
  }

  async submit(request: SubmitRequest, signal?: AbortSignal): Promise<SubmitResult> {
    return this.submitPrepared(this.prepareSubmission(request), signal);
  }

  async submitPrepared(value: PreparedSubmission, signal?: AbortSignal): Promise<SubmitResult> {
    const { prepared, body } = this.#validatePreparedSubmission(value);
    const expectedRemoteJobId = prepared.remoteJobId;
    if (signal?.aborted) throw new ProductionAdapterError("aborted", "ComfyUI 提交在网络 I/O 前已取消");
    try {
      const pending = await this.#request("/prompt", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          // Raw ComfyUI ignores this; an authenticated gateway may enforce it and return the
          // existing prompt_id. The local outbox still remains authoritative.
          "x-writing-loop-idempotency-key": prepared.idempotencyKey,
        },
        body,
      }, signal);
      const response = pending.response;
      if (!response.ok) {
        pending.discard();
        if (submitDefinitelyRejected(response.status)) {
          throw new ProductionAdapterError("remote-rejected", `ComfyUI 拒绝提交（HTTP ${response.status}）`, { status: response.status });
        }
        throw new ProductionAdapterError("submission-unknown", `ComfyUI 提交结果未知（HTTP ${response.status}）`, { status: response.status });
      }
      let decoded: BoundedJson;
      try { decoded = await this.#decode(pending, false); }
      catch (error) {
        if (error instanceof ProductionAdapterError) {
          throw new ProductionAdapterError("submission-unknown", `ComfyUI 可能已接收任务，但响应不可验证：${error.message}`, {
            cause: error, causeCode: error.code === "submission-unknown" ? "invalid-response" : error.code,
          });
        }
        throw error;
      }
      if (!object(decoded.value) || decoded.value.prompt_id !== expectedRemoteJobId) {
        throw new ProductionAdapterError("submission-unknown", "ComfyUI 可能已接收任务，但没有返回有效 prompt_id", {
          causeCode: "invalid-response",
        });
      }
      const nodeErrors = decoded.value.node_errors;
      if (nodeErrors !== undefined && !object(nodeErrors)) {
        throw new ProductionAdapterError("submission-unknown", "ComfyUI 返回的 node_errors 无效", { causeCode: "invalid-response" });
      }
      return {
        remoteJobId: decoded.value.prompt_id,
        acceptedAt: this.#now().toISOString(),
        providerIdempotency: false,
        nodeErrorCount: nodeErrors ? Object.keys(nodeErrors).length : 0,
        responseDigest: decoded.digest,
      };
    } catch (error) {
      if (error instanceof ProductionAdapterError) {
        if (error.code === "remote-unavailable" || error.code === "aborted") {
          throw new ProductionAdapterError("submission-unknown", `ComfyUI 提交结果未知：${error.message}`, {
            cause: error, causeCode: error.code,
          });
        }
        throw error;
      }
      throw new ProductionAdapterError("submission-unknown", `ComfyUI 提交结果未知：${errorMessage(error)}`, { cause: error });
    }
  }

  async #inspectJobsApi(id: string, signal?: AbortSignal): Promise<RemoteObservation | null> {
    if (this.#jobsApi === "unsupported") return null;
    const observedAt = (): string => this.#now().toISOString();
    const previous = this.#jobsApi;
    const pending = await this.#request(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "GET", headers: { accept: "application/json" },
    }, signal);
    const response = pending.response;
    if (response.status === 404) {
      if (!contentTypeIsJson(response)) {
        pending.discard();
        if (previous === "unknown") { this.#jobsApi = "unsupported"; return null; }
        throw new ProductionAdapterError("invalid-response", "ComfyUI jobs API 在已探测支持后返回非 JSON 404");
      }
      const decoded = await this.#decode(pending, false);
      const exactNotFound = object(decoded.value) && decoded.value.error === "Job not found"
        && Object.keys(decoded.value).length === 1;
      if (exactNotFound) {
        this.#jobsApi = "supported";
        return {
          remoteJobId: id, state: "not-found", observedAt: observedAt(), outputs: [], errorSummary: null,
          responseDigest: decoded.digest,
        };
      }
      if (previous === "unknown") { this.#jobsApi = "unsupported"; return null; }
      throw new ProductionAdapterError("invalid-response", "ComfyUI jobs API 返回未知 404 envelope");
    }
    if (!response.ok) {
      pending.discard();
      const code = response.status >= 400 && response.status < 500 ? "remote-rejected" : "remote-unavailable";
      throw new ProductionAdapterError(code, `ComfyUI jobs API 返回 HTTP ${response.status}`, { status: response.status });
    }
    const decoded = await this.#decode(pending, false);
    if (!object(decoded.value) || decoded.value.id !== id || typeof decoded.value.status !== "string"
      || typeof decoded.value.priority !== "number" || !Number.isFinite(decoded.value.priority)
      || !Number.isSafeInteger(decoded.value.outputs_count) || (decoded.value.outputs_count as number) < 0
      || !validOptionalJobTimes(decoded.value)) {
      throw new ProductionAdapterError("invalid-response", "ComfyUI jobs API DTO 无效");
    }
    const state: RemoteJobState | undefined = decoded.value.status === "pending" ? "pending"
      : decoded.value.status === "in_progress" ? "running"
      : decoded.value.status === "completed" ? "succeeded"
      : decoded.value.status === "failed" ? "failed"
      : decoded.value.status === "cancelled" ? "cancelled"
      : undefined;
    if (!state) throw new ProductionAdapterError("invalid-response", "ComfyUI jobs API status 无效");
    const errorSummary = state === "failed" ? safeExecutionErrorSummary(decoded.value.execution_error)
      : state === "cancelled" ? "cancelled" : null;
    this.#jobsApi = "supported";
    return {
      remoteJobId: id,
      state,
      observedAt: observedAt(),
      outputs: decoded.value.outputs === undefined ? [] : outputLocators(decoded.value.outputs),
      errorSummary,
      responseDigest: decoded.digest,
    };
  }

  async #inspectLegacy(id: string, signal?: AbortSignal): Promise<RemoteObservation> {
    const observedAt = (): string => this.#now().toISOString();
    // Query queue before history. When a prompt completes between both requests, history contains
    // the terminal record; the reverse order has a history→queue transfer race that can report a
    // live prompt as not-found.
    const queue = await this.#json("/queue", { method: "GET", headers: { accept: "application/json" } }, signal);
    if (!object(queue.value)) throw new ProductionAdapterError("invalid-response", "ComfyUI queue 响应必须是对象");
    const running = queueCount(queue.value.queue_running, id);
    const pending = queueCount(queue.value.queue_pending, id);
    if (running + pending > 1) {
      throw new ProductionAdapterError("invalid-response", "同一 ComfyUI prompt_id 在 queue 中出现多次，可能已重复计费");
    }

    const history = await this.#json(`/history/${encodeURIComponent(id)}`, { method: "GET", headers: { accept: "application/json" } }, signal);
    if (!object(history.value)) throw new ProductionAdapterError("invalid-response", "ComfyUI history 必须是对象");
    const entry = history.value[id];
    if (entry !== undefined) {
      if (running || pending) {
        // queue was sampled first. A normal completion can therefore appear in queue₁ and history₂.
        // Re-sample queue only for this overlap: disappearance proves the transfer; persistence
        // exposes a real duplicate-ID conflict that could otherwise double bill the same take.
        const confirmation = await this.#json("/queue", {
          method: "GET", headers: { accept: "application/json" },
        }, signal);
        if (!object(confirmation.value)) {
          throw new ProductionAdapterError("invalid-response", "ComfyUI queue 确认响应必须是对象");
        }
        const confirmationCount = queueCount(confirmation.value.queue_running, id)
          + queueCount(confirmation.value.queue_pending, id);
        if (confirmationCount > 0) {
          throw new ProductionAdapterError("invalid-response", "同一 ComfyUI prompt_id 持续同时存在于 terminal history 与 queue");
        }
      }
      if (!object(entry)) throw new ProductionAdapterError("invalid-response", "ComfyUI history entry 必须是对象");
      const status = entry.status;
      if (status !== undefined && !object(status)) throw new ProductionAdapterError("invalid-response", "ComfyUI history.status 必须是对象");
      const terminal = statusResult(object(status) ? status : undefined);
      return {
        remoteJobId: id,
        state: terminal.state,
        observedAt: observedAt(),
        outputs: outputLocators(entry.outputs),
        errorSummary: terminal.errorSummary,
        responseDigest: history.digest,
      };
    }

    if (running || pending) return {
      remoteJobId: id,
      state: running ? "running" : "pending",
      observedAt: observedAt(),
      outputs: [],
      errorSummary: null,
      responseDigest: createHash("sha256").update(queue.digest).update(history.digest).digest("hex"),
    };

    return {
      remoteJobId: id,
      state: "not-found",
      observedAt: observedAt(),
      outputs: [],
      errorSummary: null,
      responseDigest: createHash("sha256").update(queue.digest).update(history.digest).digest("hex"),
    };
  }

  async inspect(remoteJobId: string, signal?: AbortSignal): Promise<RemoteObservation> {
    const id = identifier(remoteJobId, "remoteJobId");
    if (this.#preferJobsApi) {
      const modern = await this.#inspectJobsApi(id, signal);
      if (modern) return modern;
    }
    return this.#inspectLegacy(id, signal);
  }

  async cancel(remoteJobId: string, signal?: AbortSignal): Promise<CancelResult> {
    const id = identifier(remoteJobId, "remoteJobId");
    // A read-only jobs API probe gates targeted interrupt. Older ComfyUI versions implement an
    // instance-wide `/interrupt` and may ignore prompt_id, so calling it without proof is unsafe.
    const observed = await this.#inspectJobsApi(id, signal);
    await this.#json("/queue", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ delete: [id] }),
    }, signal, true);
    const targeted = this.#jobsApi === "supported" && (observed?.state === "running" || observed?.state === "pending");
    if (targeted) {
      await this.#json("/interrupt", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ prompt_id: id }),
      }, signal, true);
    }
    return {
      remoteJobId: id,
      accepted: true,
      confirmed: false,
      runningInterruptRequested: targeted,
      observedAt: this.#now().toISOString(),
    };
  }
}
