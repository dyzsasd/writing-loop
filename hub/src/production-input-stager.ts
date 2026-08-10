// Trusted Phase 3C input staging boundary.
//
// A browser/task can name only immutable AssetRef identities. The server-owned gateway resolves
// those identities through its profile registry, copies them into provider-local storage and
// returns semantic slots plus opaque provider object keys. No signed download URL, arbitrary
// endpoint/header, credential or provider response text crosses this contract.
import { createHash } from "node:crypto";
import {
  ProductionError,
  parseAssetRef,
  type AssetRef,
} from "./production-domain.ts";
import {
  parseProductionDispatchIntent,
  type ProductionDispatchIntent,
  type ProductionIntentExecution,
} from "./production-intent.ts";
import type { FetchLike } from "./production-adapter.ts";
import { assertProjectKey } from "./workspace.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";

export const PRODUCTION_INPUT_STAGE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PRODUCTION_INPUT_STAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_PRODUCTION_INPUT_STAGE_RESPONSE_BYTES = 256 * 1024;

export type ProductionInputStagerErrorCode =
  | "aborted"
  | "invalid-config"
  | "invalid-input"
  | "credential-unavailable"
  | "gateway-unavailable"
  | "gateway-rejected"
  | "invalid-response"
  | "response-too-large";

const ERROR_MESSAGES: Readonly<Record<ProductionInputStagerErrorCode, string>> = Object.freeze({
  aborted: "production input staging aborted",
  "invalid-config": "production input staging configuration invalid",
  "invalid-input": "production input staging input invalid",
  "credential-unavailable": "production input staging credential unavailable",
  "gateway-unavailable": "production input staging gateway unavailable",
  "gateway-rejected": "production input staging gateway rejected request",
  "invalid-response": "production input staging gateway response invalid",
  "response-too-large": "production input staging gateway response too large",
});

/** Persistence-safe error: raw URL/body/token/cause/provider text is intentionally discarded. */
export class ProductionInputStagerError extends Error {
  readonly code: ProductionInputStagerErrorCode;
  readonly status: number | null;

  constructor(code: ProductionInputStagerErrorCode, status: number | null = null) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProductionInputStagerError";
    this.code = code;
    this.status = status;
  }
}

export type ProductionInputBinding = {
  index: number;
  slot: string;
  assetSha256: string;
  providerObjectKey: string;
};

export type ProductionInputStageResult = {
  version: 1;
  stageKey: string;
  bindingsDigest: string;
  bindings: ProductionInputBinding[];
};

export interface ProductionInputStager {
  stage(intent: ProductionDispatchIntent, signal?: AbortSignal): Promise<ProductionInputStageResult>;
}

export type ProductionWorkflowBindingVerification = {
  version: 1;
  verified: true;
  /** Digest pinned by the immutable intent and measured before any dynamic materialization. */
  templateWorkflowSha256: string;
  /** Digest of the detached graph after exact staged provider keys have been materialized. */
  boundWorkflowSha256: string;
  workflow: Record<string, unknown>;
  stageKey: string;
  bindingsDigest: string;
};

/**
 * Trusted profile-registry port. Implementations must prove the exact graph consumes every staged
 * slot at its expected provider CAS key; merely accepting a stage response is insufficient.
 */
export interface ProductionWorkflowBindingVerifier {
  verify(
    intent: ProductionDispatchIntent,
    workflow: Record<string, unknown>,
    staged: ProductionInputStageResult,
    signal?: AbortSignal,
  ): Promise<ProductionWorkflowBindingVerification>;
}

export type ProductionInputStageScope = {
  version: 1;
  workspaceId: string;
  project: string;
};

export type ProductionInputStageRequest = {
  version: 1;
  stageKey: string;
  scope: ProductionInputStageScope;
  taskId: string;
  intentDigest: string;
  /** Exact immutable execution tuple used only to select a trusted server-side stage profile. */
  execution: ProductionIntentExecution;
  inputs: Array<{ version: 1; index: number; asset: AssetRef }>;
};

export type ProductionInputStageIdentity = Omit<ProductionInputStageRequest, "stageKey">;

export type ProductionInputStagerCredentialResolver = (
  signal: AbortSignal,
) => string | null | Promise<string | null>;

export type HttpProductionInputStagerOptions = {
  /** Fixed server-side gateway root; never source this from a task, intent or browser request. */
  baseUrl: string | URL;
  workspaceId: string;
  project: string;
  credentialResolver?: ProductionInputStagerCredentialResolver;
  /** Development-only escape hatch. HTTP remains limited to loopback and cannot carry a bearer. */
  allowInsecureLoopback?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SLOT = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: ProductionInputStagerErrorCode, status: number | null = null): never {
  throw new ProductionInputStagerError(code, status);
}

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Workflow(value: Record<string, unknown>): string {
  try { return productionCanonicalJsonSha256(value); }
  catch { fail("invalid-response"); }
}

function parseScope(workspaceId: unknown, project: unknown): ProductionInputStageScope {
  if (typeof workspaceId !== "string" || !fullMatch(SAFE_WORKSPACE_ID, workspaceId)) fail("invalid-config");
  if (typeof project !== "string") fail("invalid-config");
  try { assertProjectKey(project); }
  catch { fail("invalid-config"); }
  return { version: 1, workspaceId, project };
}

function parseIntent(value: unknown): ProductionDispatchIntent {
  try { return parseProductionDispatchIntent(value); }
  catch (error) {
    if (error instanceof ProductionError) fail("invalid-input");
    fail("invalid-input");
  }
}

function canonicalStageIdentity(
  scope: ProductionInputStageScope,
  intent: ProductionDispatchIntent,
): ProductionInputStageIdentity {
  return {
    version: 1,
    scope,
    taskId: intent.taskId,
    intentDigest: intent.idempotencyKey,
    execution: structuredClone(intent.execution),
    inputs: intent.inputs.map((asset, index) => ({
      version: 1 as const,
      index,
      asset: parseAssetRef(asset, `ProductionInputStageRequest.inputs[${index}].asset`),
    })),
  };
}

/** Digest a parser-canonical request identity. Callers must not pass unvalidated objects. */
export function productionInputStageIdentityKey(identity: ProductionInputStageIdentity): string {
  return sha256(JSON.stringify(identity));
}

/** Stable identity for one scope + immutable intent + ordered AssetRef list. */
export function productionInputStageKey(
  workspaceId: string,
  project: string,
  intentValue: ProductionDispatchIntent,
): string {
  const scope = parseScope(workspaceId, project);
  const intent = parseIntent(intentValue);
  return productionInputStageIdentityKey(canonicalStageIdentity(scope, intent));
}

/** Digest of the exact canonical binding array; array order is semantically significant. */
export function productionInputBindingsDigest(bindings: readonly ProductionInputBinding[]): string {
  return sha256(JSON.stringify(bindings));
}

function safeProviderObjectKey(value: unknown): value is string {
  return typeof value === "string" && fullMatch(SAFE_PROVIDER_OBJECT_KEY, value)
    && !value.includes("//") && !value.startsWith("/") && !value.endsWith("/")
    && value.split("/").every((part) => part !== "." && part !== "..");
}

/** Strictly validates gateway bindings against the ordered immutable intent inputs. */
export function parseProductionInputStageResult(
  value: unknown,
  intentValue: ProductionDispatchIntent,
  expectedStageKey?: string,
): ProductionInputStageResult {
  const intent = parseIntent(intentValue);
  if (!isRecord(value) || !exactKeys(value, ["version", "stageKey", "bindingsDigest", "bindings"])
    || value.version !== PRODUCTION_INPUT_STAGE_SCHEMA_VERSION
    || typeof value.stageKey !== "string" || !fullMatch(SHA256, value.stageKey)
    || (expectedStageKey !== undefined && value.stageKey !== expectedStageKey)
    || typeof value.bindingsDigest !== "string" || !fullMatch(SHA256, value.bindingsDigest)
    || !Array.isArray(value.bindings) || value.bindings.length !== intent.inputs.length) {
    fail("invalid-response");
  }
  const bindings: ProductionInputBinding[] = value.bindings.map((binding, position) => {
    if (!isRecord(binding) || !exactKeys(binding, ["index", "slot", "assetSha256", "providerObjectKey"])
      || !Number.isSafeInteger(binding.index) || binding.index !== position
      || typeof binding.slot !== "string" || !fullMatch(SAFE_SLOT, binding.slot)
      || typeof binding.assetSha256 !== "string" || !fullMatch(SHA256, binding.assetSha256)
      || binding.assetSha256 !== intent.inputs[position]?.sha256
      || !safeProviderObjectKey(binding.providerObjectKey)) {
      fail("invalid-response");
    }
    return {
      index: position,
      slot: binding.slot,
      assetSha256: binding.assetSha256,
      providerObjectKey: binding.providerObjectKey,
    };
  });
  const objectKeyDigests = new Map<string, string>();
  let conflictingObjectKey = false;
  for (const binding of bindings) {
    const previous = objectKeyDigests.get(binding.providerObjectKey);
    if (previous !== undefined && previous !== binding.assetSha256) conflictingObjectKey = true;
    objectKeyDigests.set(binding.providerObjectKey, binding.assetSha256);
  }
  if (new Set(bindings.map((binding) => binding.slot)).size !== bindings.length
    || conflictingObjectKey || value.bindingsDigest !== productionInputBindingsDigest(bindings)) {
    fail("invalid-response");
  }
  return {
    version: 1,
    stageKey: value.stageKey,
    bindingsDigest: value.bindingsDigest,
    bindings,
  };
}

export function parseProductionWorkflowBindingVerification(
  value: unknown,
  expected: { templateWorkflowSha256: string; stageKey: string; bindingsDigest: string },
): ProductionWorkflowBindingVerification {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "verified", "templateWorkflowSha256", "boundWorkflowSha256", "workflow",
    "stageKey", "bindingsDigest",
  ]) || value.version !== 1 || value.verified !== true
    || typeof value.templateWorkflowSha256 !== "string" || !fullMatch(SHA256, value.templateWorkflowSha256)
    || value.templateWorkflowSha256 !== expected.templateWorkflowSha256
    || typeof value.boundWorkflowSha256 !== "string" || !fullMatch(SHA256, value.boundWorkflowSha256)
    || !isRecord(value.workflow) || Object.keys(value.workflow).length < 1
    || sha256Workflow(value.workflow) !== value.boundWorkflowSha256
    || typeof value.stageKey !== "string" || !fullMatch(SHA256, value.stageKey)
    || value.stageKey !== expected.stageKey
    || typeof value.bindingsDigest !== "string" || !fullMatch(SHA256, value.bindingsDigest)
    || value.bindingsDigest !== expected.bindingsDigest) {
    fail("invalid-response");
  }
  return {
    version: 1,
    verified: true,
    templateWorkflowSha256: value.templateWorkflowSha256,
    boundWorkflowSha256: value.boundWorkflowSha256,
    workflow: structuredClone(value.workflow),
    stageKey: value.stageKey,
    bindingsDigest: value.bindingsDigest,
  };
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

function trustedBaseUrl(
  value: string | URL,
  allowInsecureLoopback: boolean,
  hasCredentialResolver: boolean,
): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { fail("invalid-config"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || url.username || url.password || url.search || url.hash) fail("invalid-config");
  if (url.protocol === "http:") {
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!allowInsecureLoopback || !loopback || hasCredentialResolver) fail("invalid-config");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function endpoint(base: URL, scope: ProductionInputStageScope, stageKey: string): URL {
  return new URL(
    `v1/scopes/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.project)}/stages/${stageKey}`,
    base,
  );
}

function authorizationToken(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || !/^[\x21-\x7e]+$/.test(value)) {
    fail("credential-unavailable");
  }
  return value;
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
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
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
      let part: { done: boolean; value?: Uint8Array };
      try { part = await raceAbort(reader.read(), signal); }
      catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      }
      if (part.done) break;
      if (part.value === undefined) fail("invalid-response");
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

export class HttpProductionInputStager implements ProductionInputStager {
  readonly #baseUrl: URL;
  readonly #scope: ProductionInputStageScope;
  readonly #credentialResolver: ProductionInputStagerCredentialResolver | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: HttpProductionInputStagerOptions) {
    if (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== "boolean") {
      fail("invalid-config");
    }
    this.#baseUrl = trustedBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
      options.credentialResolver !== undefined,
    );
    this.#scope = parseScope(options.workspaceId, options.project);
    this.#credentialResolver = options.credentialResolver ?? null;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_PRODUCTION_INPUT_STAGE_TIMEOUT_MS, 50, 300_000);
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes, DEFAULT_PRODUCTION_INPUT_STAGE_RESPONSE_BYTES, 1_024, 16 * 1024 * 1024,
    );
  }

  async stage(intentValue: ProductionDispatchIntent, callerSignal?: AbortSignal): Promise<ProductionInputStageResult> {
    const intent = parseIntent(intentValue);
    const identity = canonicalStageIdentity(this.#scope, intent);
    const stageKey = productionInputStageIdentityKey(identity);
    const request: ProductionInputStageRequest = { ...identity, stageKey };
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
      if (controller.signal.aborted) fail("aborted");
      let credential: string | null = null;
      if (this.#credentialResolver) {
        try {
          credential = authorizationToken(await raceAbort(
            Promise.resolve(this.#credentialResolver(controller.signal)), controller.signal,
          ));
        } catch (error) {
          if (error instanceof ProductionInputStagerError) throw error;
          if (callerSignal?.aborted) fail("aborted");
          if (timedOut) fail("gateway-unavailable");
          fail("credential-unavailable");
        }
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "x-writing-loop-idempotency-key": stageKey,
      };
      if (credential !== null) headers.authorization = `Bearer ${credential}`;

      let response: Response;
      try {
        response = await raceAbort(Promise.resolve(this.#fetch(endpoint(this.#baseUrl, this.#scope, stageKey), {
          method: "PUT",
          redirect: "error",
          headers,
          body: JSON.stringify(request),
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
        if (error instanceof ProductionInputStagerError) throw error;
        if (callerSignal?.aborted) fail("aborted");
        if (timedOut) fail("gateway-unavailable");
        fail("invalid-response");
      }
      return parseProductionInputStageResult(value, intent, stageKey);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
