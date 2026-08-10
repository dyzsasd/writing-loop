// Trusted server-side bridge from provider-local output locators to durable AssetRef records.
//
// The ingestor never accepts a gateway URL from a task/browser, never persists credentials, and
// never treats a provider filename as an AssetRef.  One canonical, content-bound ingest key makes
// the gateway PUT safely repeatable after a coordinator crash.
import { createHash } from "node:crypto";
import {
  MAX_PRODUCTION_ASSETS_PER_TASK,
  ProductionError,
  parseAssetRef,
  parseProductionCost,
  parseProductionTask,
  type AssetRef,
  type ProductionCost,
  type ProductionTask,
} from "./production-domain.ts";
import type { FetchLike, RemoteObservation, RemoteOutputLocator } from "./production-adapter.ts";

export const MAX_PRODUCTION_INGEST_LOCATORS = 128;
export const DEFAULT_PRODUCTION_INGEST_TIMEOUT_MS = 15_000;
export const DEFAULT_PRODUCTION_INGEST_RESPONSE_BYTES = 1024 * 1024;

export type ProductionIngestorErrorCode =
  | "aborted"
  | "invalid-config"
  | "invalid-input"
  | "credential-unavailable"
  | "gateway-unavailable"
  | "gateway-rejected"
  | "invalid-response"
  | "response-too-large";

const ERROR_MESSAGES: Readonly<Record<ProductionIngestorErrorCode, string>> = Object.freeze({
  aborted: "production ingest aborted",
  "invalid-config": "production ingest configuration invalid",
  "invalid-input": "production ingest input invalid",
  "credential-unavailable": "production ingest credential unavailable",
  "gateway-unavailable": "production ingest gateway unavailable",
  "gateway-rejected": "production ingest gateway rejected request",
  "invalid-response": "production ingest gateway response invalid",
  "response-too-large": "production ingest gateway response too large",
});

/** Stable, persistence-safe error. It deliberately carries no raw URL, response body or cause. */
export class ProductionIngestorError extends Error {
  readonly code: ProductionIngestorErrorCode;
  readonly status: number | null;

  constructor(code: ProductionIngestorErrorCode, status: number | null = null) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProductionIngestorError";
    this.code = code;
    this.status = status;
  }
}

export type ProductionIngestResult = {
  version: 1;
  ingestKey: string;
  assets: AssetRef[];
  cost: ProductionCost;
};

export interface ProductionArtifactIngestor {
  /**
   * Returns the exact idempotency key that this ingestor expects for the immutable result.
   * Network implementations must include their trusted workspace/project scope in this key.
   */
  ingestKey(task: ProductionTask, observation: RemoteObservation): string;
  ingest(
    task: ProductionTask,
    observation: RemoteObservation,
    signal?: AbortSignal,
  ): Promise<ProductionIngestResult>;
}

export type ProductionIngestScope = {
  version: 1;
  workspaceId: string;
  project: string;
};

export type ProductionGatewayCredentialContext = {
  workspaceId: string;
  project: string;
  operation: "ingest";
};

export type ProductionGatewayCredentialResolver = (
  context: Readonly<ProductionGatewayCredentialContext>,
  signal: AbortSignal,
) => string | null | Promise<string | null>;

export type HttpProductionArtifactIngestorOptions = {
  /** Trusted server-side gateway. It must never originate in an HTTP request or task payload. */
  baseUrl: string | URL;
  workspaceId: string;
  project: string;
  /** Required for HTTPS. It is forbidden for the explicit plaintext loopback development mode. */
  credentialResolver?: ProductionGatewayCredentialResolver;
  allowInsecureLoopback?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type ProductionGatewayIngestRequest = {
  version: 1;
  scope: ProductionIngestScope;
  ingestKey: string;
  taskId: string;
  idempotencyKey: string;
  taskIdentityDigest: string;
  backendInstanceId: string;
  remoteJobId: string;
  responseDigest: string;
  locators: RemoteOutputLocator[];
};

type PreparedIngest = {
  task: ProductionTask;
  observation: RemoteObservation;
  request: ProductionGatewayIngestRequest;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOCATOR_KINDS = new Set(["image", "video", "audio", "file"]);
const INGESTIBLE_FOLDERS = new Set(["output", "temp"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: ProductionIngestorErrorCode, status: number | null = null): never {
  throw new ProductionIngestorError(code, status);
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail("invalid-config");
  return result;
}

function parseScope(workspaceId: unknown, project: unknown): ProductionIngestScope {
  if (typeof workspaceId !== "string" || !SAFE_WORKSPACE_ID.test(workspaceId)
    || typeof project !== "string" || !SAFE_PROJECT.test(project)) fail("invalid-config");
  return { version: 1, workspaceId, project };
}

function isLiteralLoopback(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

function trustedBaseUrl(
  value: string | URL,
  allowInsecureLoopback: boolean,
  hasCredentialResolver: boolean,
): { url: URL; insecureLoopback: boolean } {
  let url: URL;
  try { url = new URL(value); }
  catch { fail("invalid-config"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || url.username || url.password || url.search || url.hash) {
    fail("invalid-config");
  }
  const insecureLoopback = url.protocol === "http:";
  if (insecureLoopback) {
    if (!allowInsecureLoopback || !isLiteralLoopback(url.hostname) || hasCredentialResolver) {
      fail("invalid-config");
    }
  } else if (!hasCredentialResolver) {
    fail("invalid-config");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return { url, insecureLoopback };
}

function endpoint(base: URL, scope: ProductionIngestScope, ingestKey: string): URL {
  return new URL(
    `v1/scopes/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.project)}/ingests/${ingestKey}`,
    base,
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function safeRemotePath(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" && value.length <= 512
    && (allowEmpty || value.length > 0)
    && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/")
    && !value.split("/").some((part) => part === "..");
}

function parseLocator(value: unknown): RemoteOutputLocator {
  if (!isRecord(value) || !exactKeys(value, ["nodeId", "kind", "filename", "subfolder", "folderType"])) {
    fail("invalid-input");
  }
  if (typeof value.nodeId !== "string" || !IDENTIFIER.test(value.nodeId)
    || typeof value.kind !== "string" || !LOCATOR_KINDS.has(value.kind)
    || !safeRemotePath(value.filename, false) || !safeRemotePath(value.subfolder, true)
    || typeof value.folderType !== "string" || !INGESTIBLE_FOLDERS.has(value.folderType)) {
    fail("invalid-input");
  }
  return {
    nodeId: value.nodeId,
    kind: value.kind as RemoteOutputLocator["kind"],
    filename: value.filename,
    subfolder: value.subfolder,
    folderType: value.folderType as "output" | "temp",
  };
}

function canonicalLocators(value: unknown): RemoteOutputLocator[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRODUCTION_INGEST_LOCATORS) {
    fail("invalid-input");
  }
  // Locale collation can vary by host. Canonical wire identity uses raw Unicode code-unit order.
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const rows = value.map(parseLocator).sort((left, right) =>
    compare(left.nodeId, right.nodeId)
      || compare(left.kind, right.kind)
      || compare(left.folderType, right.folderType)
      || compare(left.subfolder, right.subfolder)
      || compare(left.filename, right.filename));
  const identities = rows.map((row) => JSON.stringify(row));
  if (new Set(identities).size !== identities.length) fail("invalid-input");
  return rows;
}

function parseSucceededObservation(value: unknown, task: ProductionTask): RemoteObservation {
  if (!isRecord(value) || !exactKeys(value, [
    "remoteJobId", "state", "observedAt", "outputs", "errorSummary", "responseDigest",
  ])) fail("invalid-input");
  if (value.state !== "succeeded" || value.errorSummary !== null
    || typeof value.remoteJobId !== "string" || !IDENTIFIER.test(value.remoteJobId)
    || value.remoteJobId !== task.remoteJobId || !canonicalIso(value.observedAt)
    || typeof value.responseDigest !== "string" || !SHA256.test(value.responseDigest)) {
    fail("invalid-input");
  }
  return {
    remoteJobId: value.remoteJobId,
    state: "succeeded",
    observedAt: value.observedAt,
    outputs: canonicalLocators(value.outputs),
    errorSummary: null,
    responseDigest: value.responseDigest,
  };
}

function parseTask(value: unknown): ProductionTask {
  try {
    const task = parseProductionTask(value);
    if (task.backendInstanceId === null || task.remoteJobId === null) fail("invalid-input");
    return task;
  } catch (error) {
    if (error instanceof ProductionIngestorError) throw error;
    if (error instanceof ProductionError) fail("invalid-input");
    fail("invalid-input");
  }
}

function prepareIngest(
  scope: ProductionIngestScope,
  taskValue: ProductionTask,
  observationValue: RemoteObservation,
): PreparedIngest {
  const task = parseTask(taskValue);
  const observation = parseSucceededObservation(observationValue, task);
  const taskIdentity = {
    version: 1 as const,
    id: task.id,
    idempotencyKey: task.idempotencyKey,
    subject: task.subject,
  };
  const taskIdentityDigest = sha256(JSON.stringify(taskIdentity));
  const ingestKey = sha256(JSON.stringify({
    version: 1,
    scope,
    backendInstanceId: task.backendInstanceId,
    remoteJobId: task.remoteJobId,
    responseDigest: observation.responseDigest,
    locators: observation.outputs,
    taskIdentity,
  }));
  return {
    task,
    observation,
    request: {
      version: 1,
      scope,
      ingestKey,
      taskId: task.id,
      idempotencyKey: task.idempotencyKey,
      taskIdentityDigest,
      backendInstanceId: task.backendInstanceId!,
      remoteJobId: task.remoteJobId!,
      responseDigest: observation.responseDigest,
      locators: observation.outputs,
    },
  };
}

/** Canonical key for one remote result and immutable task identity; polling time/order is ignored. */
export function productionIngestKey(task: ProductionTask, observation: RemoteObservation): string {
  // Legacy coordinator-only identity. Network ingestion must use productionScopedIngestKey.
  return prepareIngest({ version: 1, workspaceId: "legacy", project: "legacy" }, task, observation)
    .request.ingestKey;
}

/** Canonical network idempotency key. Scope is deliberately part of the content identity. */
export function productionScopedIngestKey(
  workspaceId: string,
  project: string,
  task: ProductionTask,
  observation: RemoteObservation,
): string {
  return prepareIngest(parseScope(workspaceId, project), task, observation).request.ingestKey;
}

function parseIngestResult(value: unknown, expectedKey: string): ProductionIngestResult {
  if (!isRecord(value) || !exactKeys(value, ["version", "ingestKey", "assets", "cost"])
    || value.version !== 1 || value.ingestKey !== expectedKey
    || !Array.isArray(value.assets) || value.assets.length < 1
    || value.assets.length > MAX_PRODUCTION_ASSETS_PER_TASK) {
    fail("invalid-response");
  }
  let assets: AssetRef[];
  let cost: ProductionCost;
  try {
    assets = value.assets.map((asset, index) => parseAssetRef(asset, `ProductionIngestResult.assets[${index}]`));
    cost = parseProductionCost(value.cost, "ProductionIngestResult.cost");
  } catch {
    fail("invalid-response");
  }
  const uris = assets.map((asset) => asset.uri);
  if (new Set(uris).size !== uris.length) fail("invalid-response");
  return { version: 1, ingestKey: expectedKey, assets, cost };
}

function contentTypeIsJson(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) fail("invalid-response");
    let declaredBytes: bigint;
    try { declaredBytes = BigInt(declared); }
    catch { fail("invalid-response"); }
    if (declaredBytes > BigInt(maxBytes)) {
      void response.body?.cancel().catch(() => undefined);
      fail("response-too-large");
    }
  }
  if (!contentTypeIsJson(response)) {
    void response.body?.cancel().catch(() => undefined);
    fail("invalid-response");
  }
  if (!response.body) fail("invalid-response");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      let part;
      try { part = await raceAbort(reader.read(), signal); }
      catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      }
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        fail("response-too-large");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) fail("invalid-response");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { fail("invalid-response"); }
  try { return JSON.parse(text); }
  catch { fail("invalid-response"); }
}

function authorizationToken(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || !/^[\x21-\x7e]+$/.test(value)) {
    fail("credential-unavailable");
  }
  return value;
}

export class HttpProductionArtifactIngestor implements ProductionArtifactIngestor {
  readonly #baseUrl: URL;
  readonly #scope: ProductionIngestScope;
  readonly #credentialResolver: ProductionGatewayCredentialResolver | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: HttpProductionArtifactIngestorOptions) {
    if (!options || typeof options !== "object") fail("invalid-config");
    this.#scope = parseScope(options.workspaceId, options.project);
    this.#credentialResolver = options.credentialResolver ?? null;
    if (this.#credentialResolver !== null && typeof this.#credentialResolver !== "function") fail("invalid-config");
    const trusted = trustedBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
      this.#credentialResolver !== null,
    );
    this.#baseUrl = trusted.url;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_PRODUCTION_INGEST_TIMEOUT_MS, 50, 300_000);
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes, DEFAULT_PRODUCTION_INGEST_RESPONSE_BYTES, 1_024, 16 * 1024 * 1024,
    );
  }

  ingestKey(task: ProductionTask, observation: RemoteObservation): string {
    return productionScopedIngestKey(
      this.#scope.workspaceId,
      this.#scope.project,
      task,
      observation,
    );
  }

  async ingest(
    taskValue: ProductionTask,
    observationValue: RemoteObservation,
    callerSignal?: AbortSignal,
  ): Promise<ProductionIngestResult> {
    const prepared = prepareIngest(this.#scope, taskValue, observationValue);
    const body = JSON.stringify(prepared.request);
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("deadline"));
    }, this.#timeoutMs);

    try {
      let credential: string | null = null;
      if (this.#credentialResolver) {
        try {
          credential = authorizationToken(await raceAbort(
            Promise.resolve(this.#credentialResolver({
              workspaceId: this.#scope.workspaceId,
              project: this.#scope.project,
              operation: "ingest",
            }, controller.signal)), controller.signal,
          ));
        } catch (error) {
          if (error instanceof ProductionIngestorError) throw error;
          if (callerSignal?.aborted) fail("aborted");
          if (timedOut) fail("gateway-unavailable");
          fail("credential-unavailable");
        }
      }
      if (this.#credentialResolver !== null && credential === null) fail("credential-unavailable");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "x-writing-loop-idempotency-key": prepared.request.ingestKey,
      };
      if (credential !== null) headers.authorization = `Bearer ${credential}`;

      let response: Response;
      try {
        response = await raceAbort(Promise.resolve(this.#fetch(endpoint(
          this.#baseUrl,
          this.#scope,
          prepared.request.ingestKey,
        ), {
          method: "PUT",
          redirect: "error",
          headers,
          body,
          signal: controller.signal,
        })), controller.signal);
      } catch {
        if (callerSignal?.aborted) fail("aborted");
        fail("gateway-unavailable");
      }

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        fail(response.status >= 400 && response.status < 500 ? "gateway-rejected" : "gateway-unavailable", response.status);
      }

      let value: unknown;
      try { value = await readBoundedJson(response, this.#maxResponseBytes, controller.signal); }
      catch (error) {
        if (error instanceof ProductionIngestorError) throw error;
        if (callerSignal?.aborted) fail("aborted");
        if (timedOut) fail("gateway-unavailable");
        fail("invalid-response");
      }
      return parseIngestResult(value, prepared.request.ingestKey);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
