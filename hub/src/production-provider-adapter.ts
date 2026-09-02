// Gateway-internal provider adapter protocol (DESIGN §4.4). The coordinator-facing contract
// (`ProductionAdapter` in production-adapter.ts, and the PUT body in production-job-gateway.ts) is
// unchanged: `PreparedSubmission.request` is fixed to `SubmitRequest` and cannot carry a cloud
// request, so the gateway keeps its own `PreparedProviderSubmission` discriminated union.
//
// This slice implements the comfy-workflow shape only (a thin wrapper over `ComfyUiAdapter`, whose
// observable behaviour is unchanged). The cloud-video shape is types plus a strict parser; the Ark
// and Vertex adapters land in Phase 3 / Phase 4 (§8.4、§8.5).
import { createHash } from "node:crypto";
import {
  BACKEND_KINDS,
  NON_ISO_PROCESSING_REGIONS,
  ProductionAdapterError,
  type BackendCapabilities,
  type BackendKind,
  type CancelResult,
  type PreparedSubmission,
  type ProductionAdapter,
  type ProductionOutputLocator,
  type ProductionSubmissionInputBinding,
  type RemoteObservation,
  type SubmitRequest,
  type SubmitResult,
  type VideoBackendLimits,
  type VideoOutputRetention,
} from "./production-adapter.ts";
import { PRODUCTION_MODEL_FAMILIES, type ProductionIntentExecution } from "./production-intent.ts";
import { VIDEO_MODES, type ShotRequest } from "./production-shot-request.ts";

/** §4.4 BoundInput 的 slot 词表；顺序即 §5 固定的输入顺序。 */
export const PROVIDER_INPUT_SLOTS = [
  "shot-request", "first_frame", "last_frame", "reference_image", "reference_video", "reference_audio",
] as const;
export type ProviderInputSlot = typeof PROVIDER_INPUT_SLOTS[number];

export type ProviderJobRef = {
  remoteJobId: string;
  /** provider 分配的 task_id / operation name；ComfyUI 由调用方预分配 prompt_id，因此恒为 null。 */
  providerJobId: string | null;
};

export type BoundInput = {
  index: number;
  slot: ProviderInputSlot;
  assetSha256: string;
  providerObjectKey: string;
};

/** 云家族的 execution profile：逐镜变量全部来自 inputs[0] 的 ShotRequest（§4.2）。 */
export type CloudVideoExecution = Extract<
  ProductionIntentExecution,
  { operation: "ark-video-task" | "vertex-veo-lro" }
>;

export type ProviderSubmitRequest =
  | {
      kind: "comfy-workflow";
      idempotencyKey: string;
      remoteJobId: string;
      workflow: Record<string, unknown>;
      inputBinding: ProductionSubmissionInputBinding | null;
    }
  | {
      kind: "cloud-video";
      idempotencyKey: string;
      remoteJobId: string;
      execution: CloudVideoExecution;
      shotRequest: ShotRequest;
      boundInputs: BoundInput[];
    };

export type ProviderWireRequest = {
  method: "POST";
  url: string;
  headersDigest: string;
  body: Uint8Array;
};

export type PreparedProviderSubmission =
  | { kind: "comfy-workflow"; prepared: PreparedSubmission }
  | {
      kind: "cloud-video";
      version: 1;
      backendInstanceId: string;
      remoteJobId: string;
      idempotencyKey: string;
      /** sha256(wire.body)：按真实发送字节计算，与 ComfyUiAdapter 同一口径。 */
      requestDigest: string;
      executionProfileSha256: string;
      shotRequestSha256: string;
      boundInputs: BoundInput[];
      wire: ProviderWireRequest;
    };

export type ProviderOutput = {
  outputIndex: number;
  role: "primary" | "last-frame";
  kind: "video" | "image";
};

export type ProviderSubmitResult = SubmitResult & { providerJobId: string | null };

export interface ProductionProviderAdapter {
  capabilities(signal?: AbortSignal): Promise<BackendCapabilities>;
  /** 零网络；requestDigest 按真实发送字节计算。 */
  prepareSubmission(request: ProviderSubmitRequest): PreparedProviderSubmission;
  /** 恰好一次 POST。 */
  submitPrepared(prepared: PreparedProviderSubmission, signal?: AbortSignal): Promise<ProviderSubmitResult>;
  inspect(ref: ProviderJobRef, signal?: AbortSignal): Promise<RemoteObservation>;
  cancel(ref: ProviderJobRef, signal?: AbortSignal): Promise<CancelResult>;
  /**
   * 只有能产出 `source: "provider-output"` locator 的 adapter 才实现该方法；comfy-view locator 由
   * ingest kernel 经 `comfyBaseUrl/view` 取回（§4.5、§5.3），因此 ComfyUI 包装不提供它。
   */
  openOutput?(
    ref: ProviderJobRef,
    output: ProviderOutput,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; declaredLength: number | null }>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/;
const TERRITORY = /^[A-Z]{2}$/;
const MEDIA_TYPE = /^[a-z]+\/[A-Za-z0-9.+-]+$/;
/** NUL 与其余 C0/DEL 一律拒绝（与 production-reconcile.ts 的 locator 判据一致）。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_BOUND_INPUTS = 32;
const MAX_PROVIDER_REQUEST_BYTES = 64 * 1024 * 1024;
/** 与 ComfyUiAdapter 的 DEFAULT_WORKFLOW_BYTES 同量级；序列化后计。 */
const MAX_COMFY_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITY_MODELS = 256;
const MAX_CAPABILITY_LIST = 64;
/** §5 的固定输入顺序：inputs[0] 为 ShotRequest，其后首帧、尾帧、图片、视频、音频参考。 */
const SLOT_ORDER = new Map<ProviderInputSlot, number>(
  PROVIDER_INPUT_SLOTS.map((slot, index) => [slot, index] as const),
);
const SINGLETON_SLOTS = new Set<ProviderInputSlot>(["shot-request", "first_frame", "last_frame"]);
const PROGRESS_HINTS = new Set(["optional-websocket", "poll-only", "callback-optional"]);
const PENDING_CANCELLATION = new Set(["best-effort", "unsupported"]);
const RUNNING_CANCELLATION = new Set(["version-gated-best-effort", "best-effort", "unsupported"]);
const INPUT_MODES = new Set(["image-upload", "cas-object-key", "inline-base64", "gcs-uri"]);
const OUTPUT_MODES = new Set(["download", "provider-signed-url", "gcs-object", "inline-base64"]);
const SEED_KINDS = new Set(["unsupported", "uint32", "uint32-best-effort", "int32"]);
const NATIVE_AUDIO_STATES = new Set(["supported", "unsupported", "unverified"]);
const LOCATOR_FOLDERS = new Set(["input", "output", "temp"]);
const COMFY_LOCATOR_KINDS = new Set(["image", "video", "audio", "file"]);
const PROVIDER_LOCATOR_KINDS = new Set(["video", "image"]);
const PROVIDER_LOCATOR_ROLES = new Set(["primary", "last-frame"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function rejected(subject: string, detail: string): never {
  throw new ProductionAdapterError("remote-rejected", `${subject} ${detail}`);
}

function invalid(subject: string, detail: string): never {
  throw new ProductionAdapterError("invalid-response", `${subject} ${detail}`);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
  fail: (subject: string, detail: string) => never,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function text(value: unknown, pattern: RegExp, subject: string, fail: (subject: string, detail: string) => never): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(subject, "无效");
  return value as string;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  subject: string,
  fail: (subject: string, detail: string) => never,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function boundedList(
  value: unknown,
  subject: string,
  maximum: number,
  fail: (subject: string, detail: string) => never,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(subject, `必须是最多 ${maximum} 项的数组`);
  return value as unknown[];
}

function enumeration<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  subject: string,
  fail: (subject: string, detail: string) => never,
): T {
  if (typeof value !== "string" || !allowed.has(value)) fail(subject, `不在受支持取值内`);
  return value as T;
}

// —— §4.5 locator ——

/**
 * §4.5 的 locator 判别联合读取：缺少 `source` 时按 comfy-view 读取，写入总带 `source`。
 * 各持久化边界（coordinator control ledger、ingest 请求体）另有各自的 exactKeys 校验。
 */
export function parseProductionOutputLocator(
  value: unknown,
  subject = "RemoteOutputLocator",
): ProductionOutputLocator {
  if (!isRecord(value)) invalid(subject, "必须是 JSON 对象");
  // 缺少 source 才按 comfy-view 读取；显式 null / 非字符串是无效值，与 coordinator-domain、
  // reconcile 的同名判据一致（§4.5）。
  const source = Object.prototype.hasOwnProperty.call(value, "source") ? value.source : "comfy-view";
  if (source !== "comfy-view" && source !== "provider-output") {
    invalid(`${subject}.source`, "必须是 comfy-view 或 provider-output");
  }
  if (source === "provider-output") {
    exactKeys(value, ["source", "remoteJobId", "outputIndex", "role", "kind"], subject, invalid);
    return {
      source: "provider-output",
      remoteJobId: text(value.remoteJobId, IDENTIFIER, `${subject}.remoteJobId`, invalid),
      outputIndex: safeInteger(value.outputIndex, 0, 127, `${subject}.outputIndex`, invalid),
      role: enumeration(value.role, PROVIDER_LOCATOR_ROLES, `${subject}.role`, invalid),
      kind: enumeration(value.kind, PROVIDER_LOCATOR_KINDS, `${subject}.kind`, invalid),
    };
  }
  const comfyKeys = ["nodeId", "kind", "filename", "subfolder", "folderType"];
  exactKeys(
    value,
    Object.prototype.hasOwnProperty.call(value, "source") ? ["source", ...comfyKeys] : comfyKeys,
    subject,
    invalid,
  );
  const relative = (field: "filename" | "subfolder", allowEmpty: boolean): string => {
    const item = value[field];
    if (typeof item !== "string" || item.length > 512 || CONTROL_CHARACTERS.test(item)
      || item.includes("\\") || item.startsWith("/") || item.split("/").some((part) => part === "..")
      || (!allowEmpty && item.length === 0)) {
      invalid(`${subject}.${field}`, "含不安全的远端路径");
    }
    return item as string;
  };
  const filename = relative("filename", false);
  if (filename.includes("/") || filename === "." || filename === "..") {
    invalid(`${subject}.filename`, "必须是单段文件名");
  }
  return {
    source: "comfy-view",
    nodeId: text(value.nodeId, IDENTIFIER, `${subject}.nodeId`, invalid),
    kind: enumeration(value.kind, COMFY_LOCATOR_KINDS, `${subject}.kind`, invalid),
    filename,
    subfolder: relative("subfolder", true),
    folderType: enumeration(value.folderType, LOCATOR_FOLDERS, `${subject}.folderType`, invalid),
  };
}

// —— §4.4 provider job ref / prepared submission ——

export function parseProviderJobRef(value: unknown, subject = "ProviderJobRef"): ProviderJobRef {
  if (!isRecord(value)) rejected(subject, "必须是 JSON 对象");
  exactKeys(value, ["remoteJobId", "providerJobId"], subject, rejected);
  return {
    remoteJobId: text(value.remoteJobId, IDENTIFIER, `${subject}.remoteJobId`, rejected),
    providerJobId: value.providerJobId === null
      ? null
      : text(value.providerJobId, IDENTIFIER, `${subject}.providerJobId`, rejected),
  };
}

export function parseProviderOutput(value: unknown, subject = "ProviderOutput"): ProviderOutput {
  if (!isRecord(value)) rejected(subject, "必须是 JSON 对象");
  exactKeys(value, ["outputIndex", "role", "kind"], subject, rejected);
  return {
    outputIndex: safeInteger(value.outputIndex, 0, 127, `${subject}.outputIndex`, rejected),
    role: enumeration(value.role, PROVIDER_LOCATOR_ROLES, `${subject}.role`, rejected),
    kind: enumeration(value.kind, PROVIDER_LOCATOR_KINDS, `${subject}.kind`, rejected),
  };
}

/**
 * §6.5 的 slot policy 条目：一档 stage profile 声明「按固定顺序，本 slot 允许出现 [min,max] 次」。
 * 顺序由数组位置隐含（§5 的固定输入顺序），不再逐条写 index。
 */
export type ProviderSlotPolicyEntry = {
  slot: ProviderInputSlot;
  minCount: number;
  maxCount: number;
};

/**
 * slot policy 自身的良构判据：`shot-request` 恒为首项且 min=max=1；slot 严格按 §5 顺序升序且不重复
 * （重复次数由 [min,max] 表达）；三个单例 slot 的 maxCount 至多 1。返回 null 表示成立。
 */
export function providerSlotPolicyViolation(entries: readonly ProviderSlotPolicyEntry[]): string | null {
  if (entries.length < 1) return "必须至少声明 inputs[0] 的 shot-request";
  const head = entries[0]!;
  if (head.slot !== "shot-request") return "inputs[0] 必须是 shot-request";
  if (head.minCount !== 1 || head.maxCount !== 1) return "shot-request 的 minCount 与 maxCount 必须都是 1";
  for (const [position, entry] of entries.entries()) {
    if (!Number.isSafeInteger(entry.minCount) || !Number.isSafeInteger(entry.maxCount)
      || entry.minCount < 0 || entry.maxCount < 1 || entry.minCount > entry.maxCount
      || entry.maxCount > MAX_BOUND_INPUTS) {
      return `${entry.slot} 的计数区间必须满足 0 ≤ minCount ≤ maxCount ≤ ${MAX_BOUND_INPUTS} 且 maxCount ≥ 1`;
    }
    if (SINGLETON_SLOTS.has(entry.slot) && entry.maxCount !== 1) {
      return `${entry.slot} 至多出现一次，maxCount 必须是 1`;
    }
    if (position > 0 && SLOT_ORDER.get(entry.slot)! <= SLOT_ORDER.get(entries[position - 1]!.slot)!) {
      return "slot 必须按固定输入顺序 first_frame、last_frame、图片参考、视频参考、音频参考 严格升序且不重复";
    }
  }
  return null;
}

/**
 * 一条具体的 staged slot 序列是否满足 policy：按 policy 顺序消费同 slot 的连续段，段长落在
 * [minCount, maxCount] 内，且序列必须被恰好消费完。返回 null 表示成立。
 */
export function providerSlotSequenceViolation(
  policy: readonly ProviderSlotPolicyEntry[],
  slots: readonly ProviderInputSlot[],
): string | null {
  let position = 0;
  for (const entry of policy) {
    let count = 0;
    while (position < slots.length && slots[position] === entry.slot && count < entry.maxCount) {
      position++;
      count++;
    }
    if (count < entry.minCount) return `${entry.slot} 至少需要 ${entry.minCount} 项，实得 ${count}`;
    if (position < slots.length && slots[position] === entry.slot) {
      return `${entry.slot} 至多 ${entry.maxCount} 项，实得更多`;
    }
  }
  if (position !== slots.length) {
    return `staged slot ${slots[position]} 不在 policy 声明的顺序内`;
  }
  return null;
}

/**
 * §5 的固定输入顺序判据：`inputs[0]` 为 ShotRequest，其后依次是 first_frame、last_frame 与三类参考；
 * 三个单例 slot 各至多一次。返回 null 表示成立，否则返回可直接进错误消息的原因。
 */
export function providerInputSlotOrderViolation(slots: readonly ProviderInputSlot[]): string | null {
  if (slots.length < 1) return "必须至少含 inputs[0] 的 ShotRequest";
  if (slots[0] !== "shot-request") return "inputs[0] 必须是 shot-request";
  for (let index = 1; index < slots.length; index++) {
    if (SLOT_ORDER.get(slots[index]!)! < SLOT_ORDER.get(slots[index - 1]!)!) {
      return "违反固定输入顺序 first_frame、last_frame、图片参考、视频参考、音频参考";
    }
  }
  for (const slot of SINGLETON_SLOTS) {
    if (slots.filter((entry) => entry === slot).length > 1) return `${slot} 不得出现多次`;
  }
  return null;
}

function parseBoundInputs(value: unknown, subject: string): BoundInput[] {
  const rows = boundedList(value, subject, MAX_BOUND_INPUTS, rejected);
  if (rows.length < 1) rejected(subject, "必须至少含 inputs[0] 的 ShotRequest");
  const bound = rows.map((row, index): BoundInput => {
    const label = `${subject}[${index}]`;
    if (!isRecord(row)) rejected(label, "必须是 JSON 对象");
    exactKeys(row, ["index", "slot", "assetSha256", "providerObjectKey"], label, rejected);
    const declared = safeInteger(row.index, 0, MAX_BOUND_INPUTS - 1, `${label}.index`, rejected);
    if (declared !== index) rejected(`${label}.index`, "必须与数组位置一致（顺序即输入顺序）");
    return {
      index: declared,
      slot: enumeration(row.slot, new Set(PROVIDER_INPUT_SLOTS), `${label}.slot`, rejected),
      assetSha256: text(row.assetSha256, SHA256, `${label}.assetSha256`, rejected),
      providerObjectKey: text(row.providerObjectKey, OBJECT_KEY, `${label}.providerObjectKey`, rejected),
    };
  });
  const violation = providerInputSlotOrderViolation(bound.map((row) => row.slot));
  if (violation !== null) rejected(`${subject}.slot`, violation);
  if (new Set(bound.map((row) => row.providerObjectKey)).size !== bound.length) {
    rejected(`${subject}.providerObjectKey`, "不得重复");
  }
  return bound;
}

/**
 * comfy-workflow envelope 的形态校验。权威判据（backend 身份、请求 bytes 复算、workflow 是否是
 * API-format graph）在 `ComfyUiAdapter.#validatePreparedSubmission` 内，这里只保证联合分支可安全读取，
 * 并在解析期就把 graph 体积挡在 adapter 的同量级上限内。
 */
function parsePreparedSubmissionShape(value: unknown, subject: string): PreparedSubmission {
  if (!isRecord(value)) rejected(subject, "必须是 JSON 对象");
  exactKeys(
    value,
    ["version", "backendInstanceId", "remoteJobId", "idempotencyKey", "requestDigest", "request"],
    subject,
    rejected,
  );
  if (value.version !== 1) rejected(`${subject}.version`, "必须是 1");
  const request = value.request;
  if (!isRecord(request)) rejected(`${subject}.request`, "必须是 JSON 对象");
  exactKeys(request, ["idempotencyKey", "remoteJobId", "workflow", "inputBinding"], `${subject}.request`, rejected);
  if (!isRecord(request.workflow)) rejected(`${subject}.request.workflow`, "必须是 API-format 对象");
  let workflowBytes: number;
  try { workflowBytes = Buffer.byteLength(JSON.stringify(request.workflow) ?? ""); }
  catch { return rejected(`${subject}.request.workflow`, "无法序列化"); }
  if (workflowBytes > MAX_COMFY_WORKFLOW_BYTES) {
    rejected(`${subject}.request.workflow`, `超过 ${MAX_COMFY_WORKFLOW_BYTES} bytes`);
  }
  const binding = request.inputBinding;
  if (binding !== null) {
    if (!isRecord(binding)) rejected(`${subject}.request.inputBinding`, "必须是 null 或 scoped binding 对象");
    exactKeys(binding, ["version", "stageKey", "bindingsDigest", "intentDigest"], `${subject}.request.inputBinding`, rejected);
    if (binding.version !== 1) rejected(`${subject}.request.inputBinding.version`, "必须是 1");
    text(binding.stageKey, IDENTIFIER, `${subject}.request.inputBinding.stageKey`, rejected);
    text(binding.bindingsDigest, SHA256, `${subject}.request.inputBinding.bindingsDigest`, rejected);
    text(binding.intentDigest, SHA256, `${subject}.request.inputBinding.intentDigest`, rejected);
  }
  const remoteJobId = text(value.remoteJobId, IDENTIFIER, `${subject}.remoteJobId`, rejected);
  const idempotencyKey = text(value.idempotencyKey, IDENTIFIER, `${subject}.idempotencyKey`, rejected);
  if (request.remoteJobId !== remoteJobId || request.idempotencyKey !== idempotencyKey) {
    rejected(`${subject}.request`, "remoteJobId / idempotencyKey 与 envelope 不一致");
  }
  return {
    version: 1,
    backendInstanceId: text(value.backendInstanceId, IDENTIFIER, `${subject}.backendInstanceId`, rejected),
    remoteJobId,
    idempotencyKey,
    requestDigest: text(value.requestDigest, SHA256, `${subject}.requestDigest`, rejected),
    request: request as unknown as SubmitRequest,
  };
}

/**
 * 判别联合的严格读取。cloud-video 形态的自洽判据按 §4.4：`requestDigest === sha256(wire.body)`、
 * `shotRequestSha256 === boundInputs[0].assetSha256`。与 profile 相关的判据
 * （`executionProfileSha256 === profile.workflowSha256`）由 job gateway 的 parsePreparedForProfile 承担。
 */
export function parsePreparedProviderSubmission(
  value: unknown,
  subject = "PreparedProviderSubmission",
): PreparedProviderSubmission {
  if (!isRecord(value)) rejected(subject, "必须是 JSON 对象");
  if (value.kind === "comfy-workflow") {
    exactKeys(value, ["kind", "prepared"], subject, rejected);
    return { kind: "comfy-workflow", prepared: parsePreparedSubmissionShape(value.prepared, `${subject}.prepared`) };
  }
  if (value.kind !== "cloud-video") rejected(`${subject}.kind`, "必须是 comfy-workflow 或 cloud-video");
  exactKeys(value, [
    "kind", "version", "backendInstanceId", "remoteJobId", "idempotencyKey", "requestDigest",
    "executionProfileSha256", "shotRequestSha256", "boundInputs", "wire",
  ], subject, rejected);
  if (value.version !== 1) rejected(`${subject}.version`, "必须是 1");
  const wireValue = value.wire;
  if (!isRecord(wireValue)) rejected(`${subject}.wire`, "必须是 JSON 对象");
  exactKeys(wireValue, ["method", "url", "headersDigest", "body"], `${subject}.wire`, rejected);
  if (wireValue.method !== "POST") rejected(`${subject}.wire.method`, "必须是 POST");
  const body = wireValue.body;
  if (!(body instanceof Uint8Array)) rejected(`${subject}.wire.body`, "必须是 Uint8Array");
  if (body.byteLength < 1 || body.byteLength > MAX_PROVIDER_REQUEST_BYTES) {
    rejected(`${subject}.wire.body`, `必须是 1–${MAX_PROVIDER_REQUEST_BYTES} bytes`);
  }
  let url: URL;
  try { url = new URL(String(wireValue.url)); }
  catch (error) { throw new ProductionAdapterError("remote-rejected", `${subject}.wire.url 不是有效 URL`, { cause: error }); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    rejected(`${subject}.wire.url`, "只接受不含凭据与 fragment 的 https URL");
  }
  const boundInputs = parseBoundInputs(value.boundInputs, `${subject}.boundInputs`);
  const requestDigest = text(value.requestDigest, SHA256, `${subject}.requestDigest`, rejected);
  if (createHash("sha256").update(body).digest("hex") !== requestDigest) {
    rejected(`${subject}.requestDigest`, "与 wire.body 的真实字节不一致");
  }
  const shotRequestSha256 = text(value.shotRequestSha256, SHA256, `${subject}.shotRequestSha256`, rejected);
  if (shotRequestSha256 !== boundInputs[0]!.assetSha256) {
    rejected(`${subject}.shotRequestSha256`, "必须等于 boundInputs[0].assetSha256");
  }
  return {
    kind: "cloud-video",
    version: 1,
    backendInstanceId: text(value.backendInstanceId, IDENTIFIER, `${subject}.backendInstanceId`, rejected),
    remoteJobId: text(value.remoteJobId, IDENTIFIER, `${subject}.remoteJobId`, rejected),
    idempotencyKey: text(value.idempotencyKey, IDENTIFIER, `${subject}.idempotencyKey`, rejected),
    requestDigest,
    executionProfileSha256: text(value.executionProfileSha256, SHA256, `${subject}.executionProfileSha256`, rejected),
    shotRequestSha256,
    boundInputs,
    wire: { method: "POST", url: url.toString(), headersDigest: text(wireValue.headersDigest, SHA256, `${subject}.wire.headersDigest`, rejected), body },
  };
}

// —— §4.3 capability 解析（gateway 的 capabilities 资源与只读 profile 快照共用） ——

function parseOutputRetention(value: unknown, subject: string): VideoOutputRetention {
  if (!isRecord(value)) invalid(subject, "必须是 JSON 对象");
  if (value.kind === "provider-url") {
    exactKeys(value, ["kind", "seconds"], subject, invalid);
    return { kind: "provider-url", seconds: safeInteger(value.seconds, 1, 31_536_000, `${subject}.seconds`, invalid) };
  }
  if (value.kind === "gcs-object" || value.kind === "inline-spool") {
    exactKeys(value, ["kind"], subject, invalid);
    return { kind: value.kind };
  }
  if (value.kind === "comfy-history") {
    exactKeys(value, ["kind", "bounded"], subject, invalid);
    if (value.bounded !== true) invalid(`${subject}.bounded`, "必须是 true");
    return { kind: "comfy-history", bounded: true };
  }
  return invalid(`${subject}.kind`, "不在受支持取值内");
}

export function parseVideoBackendLimits(value: unknown, subject = "VideoBackendLimits"): VideoBackendLimits {
  if (!isRecord(value)) invalid(subject, "必须是 JSON 对象");
  exactKeys(value, [
    "modes", "durationSeconds", "aspectRatios", "resolutions", "maxReferenceImages", "maxReferenceVideos",
    "maxReferenceAudios", "maxStyleImages", "maxReferenceAssetsTotal", "audioOnlyReference",
    "keyframesAndReferencesExclusive", "seed", "promptLanguages", "promptDirectiveSyntax", "nativeAudio",
    "returnsLastFrame", "maxInputImageBytes", "inputImageMediaTypes", "realFaceReferences", "outputRetention",
  ], subject, invalid);
  const modes = boundedList(value.modes, `${subject}.modes`, VIDEO_MODES.length, invalid)
    .map((mode, index) => enumeration<typeof VIDEO_MODES[number]>(
      mode, new Set(VIDEO_MODES), `${subject}.modes[${index}]`, invalid,
    ));
  if (new Set(modes).size !== modes.length) invalid(`${subject}.modes`, "不得重复");
  const duration = value.durationSeconds;
  if (!isRecord(duration)) invalid(`${subject}.durationSeconds`, "必须是 JSON 对象");
  exactKeys(duration, ["min", "max", "grid", "gridByResolution"], `${subject}.durationSeconds`, invalid);
  const min = safeInteger(duration.min, 1, 600, `${subject}.durationSeconds.min`, invalid);
  const max = safeInteger(duration.max, min, 600, `${subject}.durationSeconds.max`, invalid);
  const grid = duration.grid === null ? null : parseDurationGrid(duration.grid, `${subject}.durationSeconds.grid`, min, max);
  let gridByResolution: Record<string, readonly number[]> | null = null;
  if (duration.gridByResolution !== null) {
    if (!isRecord(duration.gridByResolution)) invalid(`${subject}.durationSeconds.gridByResolution`, "必须是 null 或对象");
    gridByResolution = {};
    for (const [resolution, entry] of Object.entries(duration.gridByResolution)) {
      gridByResolution[text(resolution, IDENTIFIER, `${subject}.durationSeconds.gridByResolution key`, invalid)] =
        parseDurationGrid(entry, `${subject}.durationSeconds.gridByResolution.${resolution}`, min, max);
    }
  }
  const nativeAudio = value.nativeAudio;
  if (!isRecord(nativeAudio)) invalid(`${subject}.nativeAudio`, "必须是 JSON 对象");
  exactKeys(nativeAudio, ["status", "channels", "verifiedBy"], `${subject}.nativeAudio`, invalid);
  const channels = nativeAudio.channels;
  if (channels !== null && channels !== "mono" && channels !== "stereo") {
    invalid(`${subject}.nativeAudio.channels`, "必须是 null、mono 或 stereo");
  }
  let verifiedBy: VideoBackendLimits["nativeAudio"]["verifiedBy"] = null;
  if (nativeAudio.verifiedBy !== null) {
    const probe = nativeAudio.verifiedBy;
    if (!isRecord(probe)) invalid(`${subject}.nativeAudio.verifiedBy`, "必须是 null 或探针记录");
    exactKeys(probe, ["modelId", "probeRemoteJobId", "providerJobId", "at", "hasAudio"], `${subject}.nativeAudio.verifiedBy`, invalid);
    if (typeof probe.hasAudio !== "boolean") invalid(`${subject}.nativeAudio.verifiedBy.hasAudio`, "必须是 boolean");
    if (typeof probe.at !== "string" || probe.at.length > 64) {
      invalid(`${subject}.nativeAudio.verifiedBy.at`, "必须是规范 UTC ISO-8601 时间");
    }
    const at = probe.at;
    const millis = Date.parse(at);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== at) {
      invalid(`${subject}.nativeAudio.verifiedBy.at`, "必须是规范 UTC ISO-8601 时间");
    }
    verifiedBy = {
      modelId: text(probe.modelId, IDENTIFIER, `${subject}.nativeAudio.verifiedBy.modelId`, invalid),
      probeRemoteJobId: text(probe.probeRemoteJobId, IDENTIFIER, `${subject}.nativeAudio.verifiedBy.probeRemoteJobId`, invalid),
      providerJobId: probe.providerJobId === null
        ? null
        : text(probe.providerJobId, IDENTIFIER, `${subject}.nativeAudio.verifiedBy.providerJobId`, invalid),
      at,
      hasAudio: probe.hasAudio,
    };
  }
  const flag = (field: "audioOnlyReference" | "returnsLastFrame"): boolean => {
    if (typeof value[field] !== "boolean") invalid(`${subject}.${field}`, "必须是 boolean");
    return value[field] as boolean;
  };
  if (value.keyframesAndReferencesExclusive !== true) {
    invalid(`${subject}.keyframesAndReferencesExclusive`, "必须是 true（三家后端一致）");
  }
  if (value.realFaceReferences !== "forbidden" && value.realFaceReferences !== "allowed") {
    invalid(`${subject}.realFaceReferences`, "必须是 forbidden 或 allowed");
  }
  if (value.promptDirectiveSyntax !== null && value.promptDirectiveSyntax !== "ark-text-flags") {
    invalid(`${subject}.promptDirectiveSyntax`, "必须是 null 或 ark-text-flags");
  }
  return {
    modes,
    durationSeconds: { min, max, grid, gridByResolution },
    aspectRatios: boundedList(value.aspectRatios, `${subject}.aspectRatios`, MAX_CAPABILITY_LIST, invalid)
      .map((entry, index) => text(entry, /^[1-9][0-9]{0,2}:[1-9][0-9]{0,2}$/, `${subject}.aspectRatios[${index}]`, invalid)),
    resolutions: boundedList(value.resolutions, `${subject}.resolutions`, MAX_CAPABILITY_LIST, invalid)
      .map((entry, index) => text(entry, IDENTIFIER, `${subject}.resolutions[${index}]`, invalid)),
    maxReferenceImages: safeInteger(value.maxReferenceImages, 0, 1_024, `${subject}.maxReferenceImages`, invalid),
    maxReferenceVideos: safeInteger(value.maxReferenceVideos, 0, 1_024, `${subject}.maxReferenceVideos`, invalid),
    maxReferenceAudios: safeInteger(value.maxReferenceAudios, 0, 1_024, `${subject}.maxReferenceAudios`, invalid),
    maxStyleImages: safeInteger(value.maxStyleImages, 0, 1_024, `${subject}.maxStyleImages`, invalid),
    maxReferenceAssetsTotal: value.maxReferenceAssetsTotal === null
      ? null
      : safeInteger(value.maxReferenceAssetsTotal, 0, 1_024, `${subject}.maxReferenceAssetsTotal`, invalid),
    audioOnlyReference: flag("audioOnlyReference"),
    keyframesAndReferencesExclusive: true,
    seed: enumeration<VideoBackendLimits["seed"]>(value.seed, SEED_KINDS, `${subject}.seed`, invalid),
    promptLanguages: value.promptLanguages === null
      ? null
      : boundedList(value.promptLanguages, `${subject}.promptLanguages`, MAX_CAPABILITY_LIST, invalid)
        .map((entry, index) => text(entry, /^[a-z]{2}(?:-[A-Z]{2})?$/, `${subject}.promptLanguages[${index}]`, invalid)),
    promptDirectiveSyntax: value.promptDirectiveSyntax as "ark-text-flags" | null,
    nativeAudio: {
      status: enumeration<"supported" | "unsupported" | "unverified">(
        nativeAudio.status, NATIVE_AUDIO_STATES, `${subject}.nativeAudio.status`, invalid,
      ),
      channels: channels as "mono" | "stereo" | null,
      verifiedBy,
    },
    returnsLastFrame: flag("returnsLastFrame"),
    maxInputImageBytes: safeInteger(value.maxInputImageBytes, 1_024, 4 * 1024 * 1024 * 1024, `${subject}.maxInputImageBytes`, invalid),
    inputImageMediaTypes: boundedList(value.inputImageMediaTypes, `${subject}.inputImageMediaTypes`, MAX_CAPABILITY_LIST, invalid)
      .map((entry, index) => text(entry, MEDIA_TYPE, `${subject}.inputImageMediaTypes[${index}]`, invalid)),
    realFaceReferences: value.realFaceReferences as "forbidden" | "allowed",
    outputRetention: parseOutputRetention(value.outputRetention, `${subject}.outputRetention`),
  };
}

function parseDurationGrid(value: unknown, subject: string, min: number, max: number): readonly number[] {
  const rows = boundedList(value, subject, MAX_CAPABILITY_LIST, invalid)
    .map((entry, index) => safeInteger(entry, min, max, `${subject}[${index}]`, invalid));
  if (rows.length < 1) invalid(subject, "必须至少含一档");
  if (new Set(rows).size !== rows.length) invalid(subject, "不得重复");
  if (rows.some((entry, index) => index > 0 && entry <= rows[index - 1]!)) invalid(subject, "必须严格升序");
  return rows;
}

/** 跨线 capability：§4.3 的全部字段必填（进程内过渡字面量的缺省不适用于这里）。 */
export function parseBackendCapabilities(value: unknown, subject = "BackendCapabilities"): Required<BackendCapabilities> {
  if (!isRecord(value)) invalid(subject, "必须是 JSON 对象");
  exactKeys(value, [
    "backendKind", "backendInstanceId", "modelFamilies", "processingRegions", "asynchronous",
    "clientAssignedJobId", "providerJobIdMapping", "inspectById", "progressHints", "pendingCancellation",
    "runningCancellation", "providerIdempotency", "inputModes", "outputModes", "limitsByModelId",
  ], subject, invalid);
  if (value.asynchronous !== true) invalid(`${subject}.asynchronous`, "必须是 true");
  if (value.clientAssignedJobId !== true) invalid(`${subject}.clientAssignedJobId`, "必须是 true（经 gateway 面向 coordinator 恒为 true）");
  if (value.inspectById !== true) invalid(`${subject}.inspectById`, "必须是 true");
  if (value.providerIdempotency !== false) invalid(`${subject}.providerIdempotency`, "必须是 false");
  if (value.providerJobIdMapping !== "none" && value.providerJobIdMapping !== "gateway-durable") {
    invalid(`${subject}.providerJobIdMapping`, "必须是 none 或 gateway-durable");
  }
  const families = boundedList(value.modelFamilies, `${subject}.modelFamilies`, PRODUCTION_MODEL_FAMILIES.length, invalid)
    .map((entry, index) => enumeration<typeof PRODUCTION_MODEL_FAMILIES[number]>(
      entry, new Set(PRODUCTION_MODEL_FAMILIES), `${subject}.modelFamilies[${index}]`, invalid,
    ));
  if (families.length < 1 || new Set(families).size !== families.length) {
    invalid(`${subject}.modelFamilies`, "必须非空且不得重复");
  }
  const regions = boundedList(value.processingRegions, `${subject}.processingRegions`, MAX_CAPABILITY_LIST, invalid)
    .map((entry, index) => {
      const region = text(entry, TERRITORY, `${subject}.processingRegions[${index}]`, invalid);
      if (NON_ISO_PROCESSING_REGIONS.has(region)) {
        invalid(`${subject}.processingRegions[${index}]`, "是集合别名或非标准码，必须写 ISO-3166 alpha-2 成员国代码");
      }
      return region;
    });
  if (new Set(regions).size !== regions.length) invalid(`${subject}.processingRegions`, "不得重复");
  const modes = <T extends string>(field: "inputModes" | "outputModes", allowed: ReadonlySet<string>): readonly T[] => {
    const rows = boundedList(value[field], `${subject}.${field}`, MAX_CAPABILITY_LIST, invalid)
      .map((entry, index) => enumeration<T>(entry, allowed, `${subject}.${field}[${index}]`, invalid));
    if (rows.length < 1 || new Set(rows).size !== rows.length) invalid(`${subject}.${field}`, "必须非空且不得重复");
    return rows;
  };
  const limitsValue = value.limitsByModelId;
  if (!isRecord(limitsValue)) invalid(`${subject}.limitsByModelId`, "必须是 JSON 对象");
  const models = Object.keys(limitsValue);
  if (models.length > MAX_CAPABILITY_MODELS) {
    invalid(`${subject}.limitsByModelId`, `最多 ${MAX_CAPABILITY_MODELS} 个 modelId`);
  }
  const limitsByModelId: Record<string, VideoBackendLimits> = {};
  for (const modelId of models) {
    limitsByModelId[text(modelId, IDENTIFIER, `${subject}.limitsByModelId key`, invalid)] =
      parseVideoBackendLimits(limitsValue[modelId], `${subject}.limitsByModelId.${modelId}`);
  }
  return {
    backendKind: enumeration<BackendKind>(value.backendKind, new Set(BACKEND_KINDS), `${subject}.backendKind`, invalid),
    backendInstanceId: text(value.backendInstanceId, IDENTIFIER, `${subject}.backendInstanceId`, invalid),
    modelFamilies: families,
    processingRegions: regions,
    asynchronous: true,
    clientAssignedJobId: true,
    providerJobIdMapping: value.providerJobIdMapping,
    inspectById: true,
    progressHints: enumeration(value.progressHints, PROGRESS_HINTS, `${subject}.progressHints`, invalid),
    pendingCancellation: enumeration(value.pendingCancellation, PENDING_CANCELLATION, `${subject}.pendingCancellation`, invalid),
    runningCancellation: enumeration(value.runningCancellation, RUNNING_CANCELLATION, `${subject}.runningCancellation`, invalid),
    providerIdempotency: false,
    inputModes: modes<"image-upload" | "cas-object-key" | "inline-base64" | "gcs-uri">("inputModes", INPUT_MODES),
    outputModes: modes<"download" | "provider-signed-url" | "gcs-object" | "inline-base64">("outputModes", OUTPUT_MODES),
    limitsByModelId,
  };
}

// —— ComfyUiAdapter 包装 ——

function comfyRemoteJobId(ref: ProviderJobRef, subject: string): string {
  const parsed = parseProviderJobRef(ref, subject);
  // providerJobIdMapping: "none"——ComfyUI 不分配第二个 ID，出现即说明 ref 来自别的后端。
  if (parsed.providerJobId !== null) rejected(`${subject}.providerJobId`, "ComfyUI 不分配 providerJobId，必须是 null");
  return parsed.remoteJobId;
}

/**
 * `ComfyUiAdapter` 的薄包装：只做形态判别与转发，提交字节、观察投影与取消语义全部由被包装的
 * adapter 决定，行为与直接调用它完全一致。
 */
export function comfyUiProviderAdapter(adapter: ProductionAdapter): ProductionProviderAdapter {
  return {
    capabilities(signal?: AbortSignal): Promise<BackendCapabilities> {
      return adapter.capabilities(signal);
    },
    prepareSubmission(request: ProviderSubmitRequest): PreparedProviderSubmission {
      if (!isRecord(request)) rejected("ProviderSubmitRequest", "必须是 JSON 对象");
      if (request.kind !== "comfy-workflow") {
        rejected("ProviderSubmitRequest.kind", "ComfyUI 后端只接受 comfy-workflow 形态");
      }
      exactKeys(
        request as unknown as Record<string, unknown>,
        ["kind", "idempotencyKey", "remoteJobId", "workflow", "inputBinding"],
        "ProviderSubmitRequest",
        rejected,
      );
      const submit: SubmitRequest = {
        idempotencyKey: request.idempotencyKey,
        remoteJobId: request.remoteJobId,
        workflow: request.workflow,
        inputBinding: request.inputBinding,
      };
      return { kind: "comfy-workflow", prepared: adapter.prepareSubmission(submit) };
    },
    async submitPrepared(prepared: PreparedProviderSubmission, signal?: AbortSignal): Promise<ProviderSubmitResult> {
      if (!isRecord(prepared)) rejected("PreparedProviderSubmission", "必须是 JSON 对象");
      if (prepared.kind !== "comfy-workflow") {
        rejected("PreparedProviderSubmission.kind", "ComfyUI 后端只接受 comfy-workflow 形态");
      }
      exactKeys(prepared as unknown as Record<string, unknown>, ["kind", "prepared"], "PreparedProviderSubmission", rejected);
      // envelope 的权威校验（backend 身份与请求 bytes 复算）留在被包装的 adapter 内。
      const result = await adapter.submitPrepared(prepared.prepared, signal);
      return { ...result, providerJobId: null };
    },
    inspect(ref: ProviderJobRef, signal?: AbortSignal): Promise<RemoteObservation> {
      return adapter.inspect(comfyRemoteJobId(ref, "ProviderJobRef"), signal);
    },
    cancel(ref: ProviderJobRef, signal?: AbortSignal): Promise<CancelResult> {
      return adapter.cancel(comfyRemoteJobId(ref, "ProviderJobRef"), signal);
    },
  };
}
