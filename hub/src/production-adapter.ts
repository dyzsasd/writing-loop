// Server-side production backend boundary. The browser never receives backend endpoints or
// credentials; adapters exchange stable remote IDs and bounded DTOs only.
import { createHash, randomUUID } from "node:crypto";

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

export type BackendCapabilities = {
  backendKind: "comfyui";
  backendInstanceId: string;
  asynchronous: true;
  clientAssignedJobId: true;
  inspectById: true;
  progressHints: "optional-websocket";
  pendingCancellation: "best-effort";
  runningCancellation: "version-gated-best-effort";
  providerIdempotency: false;
  inputModes: readonly ["image-upload"];
  outputModes: readonly ["download"];
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

export type RemoteOutputLocator = {
  nodeId: string;
  kind: "image" | "video" | "audio" | "file";
  filename: string;
  subfolder: string;
  folderType: "input" | "output" | "temp";
};

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
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
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
  }

  async capabilities(_signal?: AbortSignal): Promise<BackendCapabilities> {
    return {
      backendKind: "comfyui",
      backendInstanceId: this.#backendInstanceId,
      asynchronous: true,
      clientAssignedJobId: true,
      inspectById: true,
      progressHints: "optional-websocket",
      pendingCancellation: "best-effort",
      runningCancellation: "version-gated-best-effort",
      providerIdempotency: false,
      inputModes: ["image-upload"],
      outputModes: ["download"],
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
