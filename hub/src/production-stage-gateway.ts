// Private Phase 3C input-staging gateway.
//
// This boundary performs no inference and knows nothing about ComfyUI. It authenticates an exact
// workspace/project scope, resolves an intent registration to a trusted input profile, streams
// allowlisted immutable AssetRefs through content verification, and atomically publishes a
// provider-visible CAS receipt. Caller-provided URLs, slots, object keys and headers do not exist
// in the request schema.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  ProductionError,
  parseAssetRef,
  type AssetRef,
} from "./production-domain.ts";
import {
  MAX_PRODUCTION_INTENT_INPUTS,
  parseProductionIntentExecution,
  type ProductionIntentExecution,
} from "./production-intent.ts";
import {
  productionInputBindingsDigest,
  productionInputStageIdentityKey,
  type ProductionInputBinding,
  type ProductionInputStageIdentity,
  type ProductionInputStageRequest,
  type ProductionInputStageResult,
  type ProductionInputStageScope,
} from "./production-input-stager.ts";

export const DEFAULT_PRODUCTION_STAGE_GATEWAY_TIMEOUT_MS = 120_000;
export const DEFAULT_PRODUCTION_STAGE_GATEWAY_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_PRODUCTION_STAGE_GATEWAY_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

export type ProductionStageGatewayCredentialResolver = (
  scope: Readonly<ProductionInputStageScope>,
  signal: AbortSignal,
) => string | Promise<string>;

export type ProductionStageProfileLookup = {
  version: 1;
  scope: ProductionInputStageScope;
  taskId: string;
  intentDigest: string;
  execution: ProductionIntentExecution;
  /** Exact ordered immutable AssetRef identities from the registered intent. */
  inputs: ProductionInputStageRequest["inputs"];
};

export type ProductionStageProfileInput = {
  version: 1;
  index: number;
  slot: string;
  mediaTypes: string[];
};

export type ProductionStageProfile = {
  version: 1;
  registration: ProductionStageProfileLookup;
  /** Trusted provider-local namespace. Object suffixes are always derived from sha256. */
  providerCasNamespace: string;
  inputs: ProductionStageProfileInput[];
};

export interface ProductionStageProfileRegistry {
  resolve(
    lookup: Readonly<ProductionStageProfileLookup>,
    signal: AbortSignal,
  ): ProductionStageProfile | null | Promise<ProductionStageProfile | null>;
}

export type ProductionStageReceiptClaim = {
  version: 1;
  scope: ProductionInputStageScope;
  stageKey: string;
  bindingsDigest: string;
  intentDigest: string;
  /** Canonical server-registry profile digest, never a caller-selected profile ID. */
  profileDigest: string;
};

export type VerifiedStageReceipt = Readonly<{
  version: 1;
  scope: Readonly<ProductionInputStageScope>;
  stageKey: string;
  bindingsDigest: string;
  intentDigest: string;
  profileDigest: string;
  execution: Readonly<ProductionIntentExecution>;
  bindings: readonly Readonly<ProductionInputBinding>[];
}>;

export interface ProductionStageReceiptRegistry {
  verifyStageReceipt(
    claim: ProductionStageReceiptClaim,
    signal?: AbortSignal,
  ): Promise<VerifiedStageReceipt | null>;
}

export type ProductionStageAssetPolicy = {
  version: 1;
  /** Colon-suffixed, non-HTTP stable storage scheme, e.g. `s3:` or `cas:`. */
  scheme: string;
  /** Exact configured authority/bucket; wildcards are forbidden. */
  authority: string;
};

export type ProductionStageAssetSource = {
  version: 1;
  assetSha256: string;
  byteLength: number;
  mediaType: string;
  body: ReadableStream<Uint8Array>;
};

export interface ProductionStageAssetResolver {
  /** Resolve only through server-owned SDK/CAS configuration; this port intentionally has no URL. */
  resolve(
    scope: Readonly<ProductionInputStageScope>,
    asset: Readonly<AssetRef>,
    signal: AbortSignal,
  ): ProductionStageAssetSource | Promise<ProductionStageAssetSource>;
}

export type ProductionStageGatewayHooks = {
  afterAssetTempSynced?: (fact: Readonly<{ index: number; assetSha256: string }>) => void;
  afterProviderObjectPublished?: (binding: Readonly<ProductionInputBinding>) => void;
  beforeReceiptPublish?: (result: Readonly<ProductionInputStageResult>) => void;
  afterReceiptPublished?: (result: Readonly<ProductionInputStageResult>) => void;
};

export type ProductionStageGatewayOptions = {
  /** Absolute server-owned immutable provider-stage root. */
  storeRoot: string;
  credentialResolver: ProductionStageGatewayCredentialResolver;
  profileRegistry: ProductionStageProfileRegistry;
  assetResolver: ProductionStageAssetResolver;
  assetPolicies: readonly ProductionStageAssetPolicy[];
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxAssetBytes?: number;
  hooks?: ProductionStageGatewayHooks;
};

export type ProductionStageGatewayErrorCode =
  | "aborted"
  | "asset-integrity"
  | "asset-too-large"
  | "bad-request"
  | "conflict"
  | "forbidden"
  | "internal"
  | "not-found"
  | "request-too-large"
  | "resolver-unavailable"
  | "unauthorized"
  | "unsupported-media";

const ERROR_STATUS: Readonly<Record<ProductionStageGatewayErrorCode, number>> = Object.freeze({
  aborted: 503,
  "asset-integrity": 422,
  "asset-too-large": 413,
  "bad-request": 400,
  conflict: 409,
  forbidden: 403,
  internal: 500,
  "not-found": 404,
  "request-too-large": 413,
  "resolver-unavailable": 502,
  unauthorized: 401,
  "unsupported-media": 415,
});

/** Stable public error. Raw credentials, URIs, paths, source metadata and causes are discarded. */
export class ProductionStageGatewayError extends Error {
  readonly code: ProductionStageGatewayErrorCode;
  readonly status: number;

  constructor(code: ProductionStageGatewayErrorCode) {
    super(`production stage gateway ${code}`);
    this.name = "ProductionStageGatewayError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

type StageDirectories = {
  root: string;
  objects: string;
  receipts: string;
  temporary: string;
  rootDevice: bigint;
  rootInode: bigint;
};

type StageReceipt = {
  version: 1;
  stageKey: string;
  scope: ProductionInputStageScope;
  intentDigest: string;
  requestDigest: string;
  profileDigest: string;
  execution: ProductionIntentExecution;
  result: ProductionInputStageResult;
};

type ParsedStageRequest = {
  request: ProductionInputStageRequest;
  identity: ProductionInputStageIdentity;
  expectedStageKey: string;
  requestDigest: string;
};

type Operation = {
  signal: AbortSignal;
  finish(): void;
};

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLOT = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){1,7}$/;
const SAFE_OBJECT_KEY = /^[a-z0-9][a-z0-9._/-]{0,511}$/;
const SAFE_SCHEME = /^[a-z][a-z0-9+.-]{0,31}:$/;
const SAFE_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const ALLOWED_MEDIA_TYPES = new Set([
  "audio/flac", "audio/mpeg", "audio/ogg", "audio/wav",
  "image/gif", "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/webm",
]);
const FORBIDDEN_NETWORK_SCHEMES = new Set(["http:", "https:", "file:", "data:"]);
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: ProductionStageGatewayErrorCode): never {
  throw new ProductionStageGatewayError(code);
}

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail("bad-request");
  return parsed;
}

function validateToken(value: unknown): string {
  if (typeof value !== "string" || !fullMatch(TOKEN, value)) fail("internal");
  return value;
}

export function staticProductionStageGatewayCredential(token: string): ProductionStageGatewayCredentialResolver {
  const secret = validateToken(token);
  return () => secret;
}

function bearerMatches(header: string | null, expected: string): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const candidateValid = fullMatch(TOKEN, candidate) && !candidate.includes(",");
  const actual = createHash("sha256").update(candidateValid ? candidate : "invalid").digest();
  const wanted = createHash("sha256").update(expected).digest();
  return candidateValid && timingSafeEqual(actual, wanted);
}

function parseScope(
  value: unknown,
  code: ProductionStageGatewayErrorCode = "bad-request",
): ProductionInputStageScope {
  if (!isRecord(value) || !exactKeys(value, ["version", "workspaceId", "project"])
    || value.version !== 1 || typeof value.workspaceId !== "string"
    || !fullMatch(SAFE_WORKSPACE_ID, value.workspaceId)
    || typeof value.project !== "string" || !fullMatch(SAFE_PROJECT, value.project)) fail(code);
  return { version: 1, workspaceId: value.workspaceId, project: value.project };
}

function parseExecution(
  value: unknown,
  code: ProductionStageGatewayErrorCode = "bad-request",
): ProductionIntentExecution {
  try { return parseProductionIntentExecution(value, "ProductionStageRequest.execution"); }
  catch (error) {
    if (error instanceof ProductionError) fail(code);
    throw error;
  }
}

function parseInput(
  value: unknown,
  index: number,
  code: ProductionStageGatewayErrorCode = "bad-request",
): { version: 1; index: number; asset: AssetRef } {
  if (!isRecord(value) || !exactKeys(value, ["version", "index", "asset"])
    || value.version !== 1 || value.index !== index) fail(code);
  let asset: AssetRef;
  try { asset = parseAssetRef(value.asset, `ProductionStageRequest.inputs[${index}].asset`); }
  catch (error) {
    if (error instanceof ProductionError) fail(code);
    throw error;
  }
  if (asset.byteLength < 1) fail(code);
  return { version: 1, index, asset };
}

function parseStageRequest(
  value: unknown,
  pathScope: ProductionInputStageScope,
  pathStageKey: string,
  headerStageKey: string | null,
): ParsedStageRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "stageKey", "scope", "taskId", "intentDigest", "execution", "inputs",
  ]) || value.version !== 1 || value.stageKey !== pathStageKey || headerStageKey !== pathStageKey
    || typeof value.stageKey !== "string" || !fullMatch(SHA256, value.stageKey)
    || typeof value.taskId !== "string" || !fullMatch(SAFE_ID, value.taskId)
    || typeof value.intentDigest !== "string" || !fullMatch(SHA256, value.intentDigest)
    || !Array.isArray(value.inputs) || value.inputs.length < 1
    || value.inputs.length > MAX_PRODUCTION_INTENT_INPUTS) fail("bad-request");
  const scope = parseScope(value.scope);
  if (scope.workspaceId !== pathScope.workspaceId || scope.project !== pathScope.project) fail("forbidden");
  const identity: ProductionInputStageIdentity = {
    version: 1,
    scope,
    taskId: value.taskId,
    intentDigest: value.intentDigest,
    execution: parseExecution(value.execution),
    inputs: value.inputs.map((input, index) => parseInput(input, index)),
  };
  const request: ProductionInputStageRequest = { ...identity, stageKey: pathStageKey };
  return {
    request,
    identity,
    expectedStageKey: productionInputStageIdentityKey(identity),
    requestDigest: sha256(JSON.stringify(request)),
  };
}

function parsePolicy(value: unknown): ProductionStageAssetPolicy {
  if (!isRecord(value) || !exactKeys(value, ["version", "scheme", "authority"])
    || value.version !== 1 || typeof value.scheme !== "string" || !fullMatch(SAFE_SCHEME, value.scheme)
    || FORBIDDEN_NETWORK_SCHEMES.has(value.scheme)
    || typeof value.authority !== "string" || !fullMatch(SAFE_AUTHORITY, value.authority)
    || value.authority.includes("..")) fail("bad-request");
  return { version: 1, scheme: value.scheme.toLowerCase(), authority: value.authority.toLowerCase() };
}

function parsePolicies(value: unknown): ProductionStageAssetPolicy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) fail("bad-request");
  const policies = value.map(parsePolicy);
  const identities = policies.map((policy) => `${policy.scheme}//${policy.authority}`);
  if (new Set(identities).size !== identities.length) fail("bad-request");
  return policies;
}

function assertAssetAllowlisted(asset: AssetRef, policies: readonly ProductionStageAssetPolicy[]): void {
  // The resolver receives the stable identity rather than a caller URL. Reject all percent escapes
  // so SDK/CAS implementations cannot disagree through one- or multi-pass decoding.
  if (asset.uri.includes("%") || asset.uri.includes("/../") || asset.uri.includes("/./")) fail("forbidden");
  let url: URL;
  try { url = new URL(asset.uri); }
  catch { fail("bad-request"); }
  if (FORBIDDEN_NETWORK_SCHEMES.has(url.protocol) || url.port || url.username || url.password
    || url.search || url.hash || !url.hostname
    || !policies.some((policy) => policy.scheme === url.protocol && policy.authority === url.hostname.toLowerCase())) {
    fail("forbidden");
  }
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); }
  catch { fail("forbidden"); }
  if (!decoded || decoded === "/" || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)
    || decoded.split("/").some((part) => part === "." || part === "..")) fail("forbidden");
}

function parseProfileInput(value: unknown, index: number): ProductionStageProfileInput {
  if (!isRecord(value) || !exactKeys(value, ["version", "index", "slot", "mediaTypes"])
    || value.version !== 1 || value.index !== index || typeof value.slot !== "string"
    || !fullMatch(SAFE_SLOT, value.slot) || !Array.isArray(value.mediaTypes)
    || value.mediaTypes.length < 1 || value.mediaTypes.length > 32) fail("internal");
  const mediaTypes = value.mediaTypes.map((mediaType) => {
    if (typeof mediaType !== "string" || !fullMatch(MEDIA_TYPE, mediaType)
      || !ALLOWED_MEDIA_TYPES.has(mediaType)) fail("internal");
    return mediaType;
  });
  const sorted = [...mediaTypes].sort();
  if (new Set(mediaTypes).size !== mediaTypes.length
    || mediaTypes.some((mediaType, position) => mediaType !== sorted[position])) fail("internal");
  return { version: 1, index, slot: value.slot, mediaTypes };
}

function parseProfile(value: unknown, lookup: ProductionStageProfileLookup): ProductionStageProfile {
  if (!isRecord(value) || !exactKeys(value, ["version", "registration", "providerCasNamespace", "inputs"])
    || value.version !== 1 || typeof value.providerCasNamespace !== "string"
    || !fullMatch(SAFE_NAMESPACE, value.providerCasNamespace)
    || !value.providerCasNamespace.endsWith("/sha256")
    || !Array.isArray(value.inputs) || value.inputs.length > MAX_PRODUCTION_INTENT_INPUTS) fail("internal");
  const registration = isRecord(value.registration) ? value.registration : null;
  if (!registration || !exactKeys(registration, [
    "version", "scope", "taskId", "intentDigest", "execution", "inputs",
  ])
    || registration.version !== 1 || typeof registration.taskId !== "string"
    || typeof registration.intentDigest !== "string" || !Array.isArray(registration.inputs)
    || registration.inputs.length < 1 || registration.inputs.length > MAX_PRODUCTION_INTENT_INPUTS) fail("internal");
  const parsedRegistration: ProductionStageProfileLookup = {
    version: 1,
    scope: parseScope(registration.scope, "internal"),
    taskId: registration.taskId,
    intentDigest: registration.intentDigest,
    execution: parseExecution(registration.execution, "internal"),
    inputs: registration.inputs.map((input, index) => parseInput(input, index, "internal")),
  };
  if (JSON.stringify(parsedRegistration) !== JSON.stringify(lookup)) fail("forbidden");
  const inputs = value.inputs.map(parseProfileInput);
  if (new Set(inputs.map((input) => input.slot)).size !== inputs.length) fail("internal");
  return {
    version: 1,
    registration: parsedRegistration,
    providerCasNamespace: value.providerCasNamespace,
    inputs,
  };
}

/**
 * Digest only execution semantics + ordered slot schema + provider CAS namespace. Registration
 * scope/task/intent stay independently bound by the receipt claim and are not profile identity.
 */
export function productionStageProfileDigest(profile: ProductionStageProfile): string {
  return sha256(JSON.stringify({
    version: 1,
    execution: profile.registration.execution,
    inputs: profile.inputs,
    providerNamespace: profile.providerCasNamespace,
  }));
}

function parseAssetSource(value: unknown, asset: AssetRef): ProductionStageAssetSource {
  if (!isRecord(value) || !exactKeys(value, ["version", "assetSha256", "byteLength", "mediaType", "body"])
    || value.version !== 1 || value.assetSha256 !== asset.sha256
    || value.byteLength !== asset.byteLength || value.mediaType !== asset.mediaType
    || typeof value.body !== "object" || value.body === null
    || typeof (value.body as ReadableStream<Uint8Array>).getReader !== "function") fail("resolver-unavailable");
  return {
    version: 1,
    assetSha256: asset.sha256,
    byteLength: asset.byteLength,
    mediaType: asset.mediaType,
    body: value.body as ReadableStream<Uint8Array>,
  };
}

function sniffMediaType(header: Uint8Array): string | null {
  const ascii = (start: number, end: number): string => Buffer.from(header.subarray(start, end)).toString("ascii");
  if (header.length >= 8 && Buffer.from(header.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (header.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (header.length >= 12 && ascii(4, 8) === "ftyp") return "video/mp4";
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return "video/webm";
  }
  if (header.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (header.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (header.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (header.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  if (header.length >= 2 && header[0] === 0xff && (header[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return await new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function parseContentLength(value: string | null, maximum: number): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) fail("bad-request");
  let parsed: bigint;
  try { parsed = BigInt(value); }
  catch { fail("bad-request"); }
  if (parsed > BigInt(maximum) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("request-too-large");
  return Number(parsed);
}

async function readBoundedJson(request: Request, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    fail("bad-request");
  }
  const declared = parseContentLength(request.headers.get("content-length"), maximum);
  if (!request.body) fail("bad-request");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await raceAbort(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        void reader.cancel().catch(() => undefined);
        fail("request-too-large");
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (bytes < 1 || (declared !== null && declared !== bytes)) fail("bad-request");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { fail("bad-request"); }
  try { return JSON.parse(text); }
  catch { fail("bad-request"); }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function ensureSafeDirectory(path: string, root: string): Promise<BigIntStats> {
  if (!inside(root, path)) fail("internal");
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (Number(before.mode) & 0o022) !== 0) fail("internal");
  if (await realpath(path) !== path) fail("internal");
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || !sameFile(before, after)) fail("internal");
  return after;
}

async function makeSafeDirectory(path: string, root: string): Promise<void> {
  if (!inside(root, path)) fail("internal");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await ensureSafeDirectory(path, root);
}

async function initializeDirectories(configuredRoot: string): Promise<StageDirectories> {
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) === sep) fail("bad-request");
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const configured = await lstat(configuredRoot, { bigint: true });
  if (!configured.isDirectory() || configured.isSymbolicLink()) fail("bad-request");
  const root = await realpath(configuredRoot);
  const rootStat = await ensureSafeDirectory(root, root);
  const directories = {
    root,
    objects: join(root, "objects"),
    receipts: join(root, "receipts"),
    temporary: join(root, "tmp"),
  };
  for (const path of [directories.objects, directories.receipts, directories.temporary]) {
    await makeSafeDirectory(path, root);
  }
  return { ...directories, rootDevice: rootStat.dev, rootInode: rootStat.ino };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, READ_FLAGS);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten < 1) fail("internal");
    offset += bytesWritten;
  }
}

async function createTempFile(directories: StageDirectories, prefix: string): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const path = join(directories.temporary, `${prefix}-${randomBytes(24).toString("hex")}.tmp`);
    try {
      const handle = await open(path, CREATE_FLAGS, 0o600);
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n) {
        await handle.close();
        await unlink(path).catch(() => undefined);
        fail("internal");
      }
      return { path, handle };
    } catch (error) {
      if (isNodeError(error, "EEXIST")) continue;
      throw error;
    }
  }
  fail("internal");
}

async function waitForSingleLink(
  path: string,
  signal: AbortSignal,
  trustedTemporaryDirectory?: string,
): Promise<BigIntStats> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await lstat(path, { bigint: true });
    if (info.nlink !== 2n || !info.isFile() || info.isSymbolicLink()) return info;
    await raceAbort(new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2)), signal);
  }
  let current = await lstat(path, { bigint: true });
  if (current.nlink === 2n && current.isFile() && !current.isSymbolicLink()
    && trustedTemporaryDirectory !== undefined) {
    const names = await readdir(trustedTemporaryDirectory);
    if (names.length > 4_096) fail("internal");
    for (const name of names) {
      if (!/^[a-z]+-[a-f0-9]{48}\.tmp$/.test(name)) continue;
      const candidate = join(trustedTemporaryDirectory, name);
      const candidateInfo = await lstat(candidate, { bigint: true });
      if (candidateInfo.isFile() && !candidateInfo.isSymbolicLink() && sameFile(current, candidateInfo)) {
        await unlink(candidate);
        await syncDirectory(trustedTemporaryDirectory);
        current = await lstat(path, { bigint: true });
        break;
      }
    }
  }
  return current;
}

async function readExactSafeJson(
  path: string,
  maximum: number,
  signal: AbortSignal,
  trustedTemporaryDirectory?: string,
): Promise<unknown> {
  const pathInfo = await waitForSingleLink(path, signal, trustedTemporaryDirectory);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
    || (Number(pathInfo.mode) & 0o222) !== 0
    || pathInfo.size < 1n || pathInfo.size > BigInt(maximum)) fail("internal");
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathInfo, opened)) fail("internal");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await raceAbort(handle.read(bytes, offset, bytes.length - offset, offset), signal);
      if (part.bytesRead < 1) fail("internal");
      offset += part.bytesRead;
    }
    const end = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!sameFile(opened, end) || !sameFile(end, finalPath) || end.size !== opened.size || end.nlink !== 1n) {
      fail("internal");
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("internal"); }
    try { return JSON.parse(text); }
    catch { fail("internal"); }
  } finally {
    await handle.close();
  }
}

async function publishExactJson(
  directories: StageDirectories,
  destination: string,
  value: unknown,
): Promise<"created" | "exists"> {
  if (!inside(directories.root, destination)) fail("internal");
  await makeSafeDirectory(dirname(destination), directories.root);
  const temporary = await createTempFile(directories, "receipt");
  let linked = false;
  try {
    await writeAll(temporary.handle, Buffer.from(JSON.stringify(value)));
    await temporary.handle.chmod(0o400);
    // Persist both bytes and the immutable mode before the atomic publication link.
    await temporary.handle.sync();
    await temporary.handle.close();
    try {
      await link(temporary.path, destination);
      linked = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await unlink(temporary.path);
    if (linked) await syncDirectory(dirname(destination));
    return linked ? "created" : "exists";
  } catch (error) {
    await temporary.handle.close().catch(() => undefined);
    await unlink(temporary.path).catch(() => undefined);
    throw error;
  }
}

function providerObjectKey(namespace: string, digest: string): string {
  const key = `${namespace}/${digest.slice(0, 2)}/${digest}`;
  if (!fullMatch(SAFE_OBJECT_KEY, key)) fail("internal");
  return key;
}

function parseStoredBinding(value: unknown, expectedIndex: number): ProductionInputBinding {
  if (!isRecord(value) || !exactKeys(value, ["index", "slot", "assetSha256", "providerObjectKey"])
    || value.index !== expectedIndex || typeof value.slot !== "string" || !fullMatch(SAFE_SLOT, value.slot)
    || typeof value.assetSha256 !== "string" || !fullMatch(SHA256, value.assetSha256)
    || typeof value.providerObjectKey !== "string"
    || !fullMatch(SAFE_OBJECT_KEY, value.providerObjectKey)
    || value.providerObjectKey.includes("//") || value.providerObjectKey.split("/").some((part) => part === "." || part === "..")) {
    fail("internal");
  }
  return {
    index: expectedIndex,
    slot: value.slot,
    assetSha256: value.assetSha256,
    providerObjectKey: value.providerObjectKey,
  };
}

function parseStoredReceipt(
  value: unknown,
  expectedScope: ProductionInputStageScope,
  expectedStageKey: string,
): StageReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "stageKey", "scope", "intentDigest", "requestDigest", "profileDigest", "execution", "result",
  ]) || value.version !== 1 || value.stageKey !== expectedStageKey
    || typeof value.intentDigest !== "string" || !fullMatch(SHA256, value.intentDigest)
    || typeof value.requestDigest !== "string" || !fullMatch(SHA256, value.requestDigest)
    || typeof value.profileDigest !== "string" || !fullMatch(SHA256, value.profileDigest)
    || JSON.stringify(parseScope(value.scope, "internal")) !== JSON.stringify(expectedScope)
    || !isRecord(value.result) || !exactKeys(value.result, ["version", "stageKey", "bindingsDigest", "bindings"])
    || value.result.version !== 1 || value.result.stageKey !== expectedStageKey
    || typeof value.result.bindingsDigest !== "string" || !fullMatch(SHA256, value.result.bindingsDigest)
    || !Array.isArray(value.result.bindings) || value.result.bindings.length < 1
    || value.result.bindings.length > MAX_PRODUCTION_INTENT_INPUTS) fail("internal");
  const bindings = value.result.bindings.map(parseStoredBinding);
  if (new Set(bindings.map((binding) => binding.slot)).size !== bindings.length
    || productionInputBindingsDigest(bindings) !== value.result.bindingsDigest) fail("internal");
  return {
    version: 1,
    stageKey: expectedStageKey,
    scope: expectedScope,
    intentDigest: value.intentDigest,
    requestDigest: value.requestDigest,
    profileDigest: value.profileDigest,
    execution: parseExecution(value.execution, "internal"),
    result: {
      version: 1,
      stageKey: expectedStageKey,
      bindingsDigest: value.result.bindingsDigest,
      bindings,
    },
  };
}

function assertReceiptMatchesRequest(receipt: StageReceipt, parsed: ParsedStageRequest): void {
  if (receipt.intentDigest !== parsed.request.intentDigest
    || JSON.stringify(receipt.execution) !== JSON.stringify(parsed.request.execution)
    || receipt.result.bindings.length !== parsed.request.inputs.length
    || receipt.result.bindings.some((binding, index) =>
      binding.assetSha256 !== parsed.request.inputs[index]!.asset.sha256)) fail("internal");
}

function parseClaim(value: unknown): ProductionStageReceiptClaim {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "stageKey", "bindingsDigest", "intentDigest", "profileDigest",
  ]) || value.version !== 1 || typeof value.stageKey !== "string" || !fullMatch(SHA256, value.stageKey)
    || typeof value.bindingsDigest !== "string" || !fullMatch(SHA256, value.bindingsDigest)
    || typeof value.intentDigest !== "string" || !fullMatch(SHA256, value.intentDigest)
    || typeof value.profileDigest !== "string" || !fullMatch(SHA256, value.profileDigest)) fail("bad-request");
  return {
    version: 1,
    scope: parseScope(value.scope),
    stageKey: value.stageKey,
    bindingsDigest: value.bindingsDigest,
    intentDigest: value.intentDigest,
    profileDigest: value.profileDigest,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: ProductionStageGatewayError): Response {
  const response = jsonResponse({ version: 1, error: error.code }, error.status);
  if (error.code === "unauthorized") response.headers.set("www-authenticate", "Bearer");
  return response;
}

function decodeScopePath(pathname: string): { scope: ProductionInputStageScope; stageKey: string } | null {
  const match = /^\/v1\/scopes\/([^/]+)\/([^/]+)\/stages\/([a-f0-9]{64})$/.exec(pathname);
  if (!match) return null;
  let workspaceId: string;
  let project: string;
  try {
    workspaceId = decodeURIComponent(match[1]!);
    project = decodeURIComponent(match[2]!);
  } catch { return null; }
  if (!fullMatch(SAFE_WORKSPACE_ID, workspaceId) || !fullMatch(SAFE_PROJECT, project)
    || encodeURIComponent(workspaceId) !== match[1] || encodeURIComponent(project) !== match[2]) return null;
  return { scope: { version: 1, workspaceId, project }, stageKey: match[3]! };
}

export class ProductionStageGateway implements ProductionStageReceiptRegistry {
  readonly #directories: StageDirectories;
  readonly #credentialResolver: ProductionStageGatewayCredentialResolver;
  readonly #profileRegistry: ProductionStageProfileRegistry;
  readonly #assetResolver: ProductionStageAssetResolver;
  readonly #policies: ProductionStageAssetPolicy[];
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxAssetBytes: number;
  readonly #hooks: ProductionStageGatewayHooks;
  readonly #shutdown = new AbortController();
  readonly #active = new Set<AbortController>();
  #closed = false;

  private constructor(options: ProductionStageGatewayOptions, directories: StageDirectories) {
    this.#directories = directories;
    if (typeof options.credentialResolver !== "function"
      || !options.profileRegistry || typeof options.profileRegistry.resolve !== "function"
      || !options.assetResolver || typeof options.assetResolver.resolve !== "function") fail("bad-request");
    this.#credentialResolver = options.credentialResolver;
    this.#profileRegistry = options.profileRegistry;
    this.#assetResolver = options.assetResolver;
    this.#policies = parsePolicies(options.assetPolicies);
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_PRODUCTION_STAGE_GATEWAY_TIMEOUT_MS, 50, 900_000);
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes, DEFAULT_PRODUCTION_STAGE_GATEWAY_REQUEST_BYTES, 1_024, 16 * 1024 * 1024,
    );
    this.#maxAssetBytes = boundedInteger(
      options.maxAssetBytes, DEFAULT_PRODUCTION_STAGE_GATEWAY_ASSET_BYTES, 1_024, Number.MAX_SAFE_INTEGER,
    );
    this.#hooks = options.hooks ?? {};
  }

  static async create(options: ProductionStageGatewayOptions): Promise<ProductionStageGateway> {
    if (!options || typeof options !== "object" || typeof options.storeRoot !== "string") fail("bad-request");
    return new ProductionStageGateway(options, await initializeDirectories(options.storeRoot));
  }

  async #verifyRoot(): Promise<void> {
    const current = await lstat(this.#directories.root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== this.#directories.rootDevice || current.ino !== this.#directories.rootInode) fail("internal");
  }

  #operation(callerSignal: AbortSignal): Operation {
    if (this.#closed || this.#shutdown.signal.aborted) fail("aborted");
    const controller = new AbortController();
    this.#active.add(controller);
    const fromCaller = (): void => controller.abort(callerSignal.reason ?? new Error("aborted"));
    const fromShutdown = (): void => controller.abort(new Error("shutdown"));
    if (callerSignal.aborted) fromCaller();
    else callerSignal.addEventListener("abort", fromCaller, { once: true });
    this.#shutdown.signal.addEventListener("abort", fromShutdown, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("deadline")), this.#timeoutMs);
    let finished = false;
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callerSignal.removeEventListener("abort", fromCaller);
        this.#shutdown.signal.removeEventListener("abort", fromShutdown);
        this.#active.delete(controller);
      },
    };
  }

  async #authorize(request: Request, scope: ProductionInputStageScope, operation: Operation): Promise<void> {
    let expected: string;
    try {
      expected = validateToken(await raceAbort(
        Promise.resolve(this.#credentialResolver(Object.freeze(structuredClone(scope)), operation.signal)),
        operation.signal,
      ));
    } catch (error) {
      if (error instanceof ProductionStageGatewayError) throw error;
      if (operation.signal.aborted) fail("aborted");
      fail("internal");
    }
    if (!bearerMatches(request.headers.get("authorization"), expected)) fail("unauthorized");
  }

  #receiptPath(scope: ProductionInputStageScope, stageKey: string): string {
    return join(this.#directories.receipts, scope.workspaceId, scope.project, `${stageKey}.json`);
  }

  async #loadReceipt(parsed: ParsedStageRequest, signal: AbortSignal): Promise<StageReceipt | null> {
    await this.#verifyRoot();
    try { return parseStoredReceipt(await readExactSafeJson(
      this.#receiptPath(parsed.request.scope, parsed.request.stageKey), this.#maxRequestBytes, signal,
      this.#directories.temporary,
    ), parsed.request.scope, parsed.request.stageKey); }
    catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async #profile(parsed: ParsedStageRequest, signal: AbortSignal): Promise<ProductionStageProfile> {
    const lookup: ProductionStageProfileLookup = {
      version: 1,
      scope: parsed.request.scope,
      taskId: parsed.request.taskId,
      intentDigest: parsed.request.intentDigest,
      execution: parsed.request.execution,
      inputs: parsed.request.inputs,
    };
    let value: ProductionStageProfile | null;
    try { value = await raceAbort(Promise.resolve(this.#profileRegistry.resolve(
      Object.freeze(structuredClone(lookup)), signal,
    )), signal); }
    catch (error) {
      if (error instanceof ProductionStageGatewayError) throw error;
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    if (value === null) fail("forbidden");
    const profile = parseProfile(value, lookup);
    if (profile.inputs.length !== parsed.request.inputs.length) fail("forbidden");
    for (let index = 0; index < profile.inputs.length; index++) {
      if (!profile.inputs[index]!.mediaTypes.includes(parsed.request.inputs[index]!.asset.mediaType)) {
        fail("unsupported-media");
      }
    }
    return profile;
  }

  async #validateExistingObject(path: string, digest: string, length: number, signal: AbortSignal): Promise<void> {
    const pathInfo = await waitForSingleLink(path, signal, this.#directories.temporary);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
      || (Number(pathInfo.mode) & 0o222) !== 0 || pathInfo.size !== BigInt(length)) fail("internal");
    const handle = await open(path, READ_FLAGS);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathInfo, opened)) fail("internal");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < length) {
        const part = await raceAbort(
          handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset), signal,
        );
        if (part.bytesRead < 1) fail("internal");
        hash.update(buffer.subarray(0, part.bytesRead));
        offset += part.bytesRead;
      }
      const end = await handle.stat({ bigint: true });
      const finalPath = await lstat(path, { bigint: true });
      if (hash.digest("hex") !== digest || !sameFile(opened, end) || !sameFile(end, finalPath)
        || end.size !== opened.size || end.nlink !== 1n) fail("internal");
    } finally {
      await handle.close();
    }
  }

  async #publishObject(
    temporaryPath: string,
    objectKey: string,
    digest: string,
    length: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#verifyRoot();
    const destination = join(this.#directories.objects, ...objectKey.split("/"));
    if (!inside(this.#directories.objects, destination)) fail("internal");
    await makeSafeDirectory(dirname(destination), this.#directories.root);
    let created = false;
    try {
      await link(temporaryPath, destination);
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await unlink(temporaryPath);
    if (created) await syncDirectory(dirname(destination));
    await this.#validateExistingObject(destination, digest, length, signal);
  }

  async #stageAsset(
    parsed: ParsedStageRequest,
    profile: ProductionStageProfile,
    index: number,
    operation: Operation,
  ): Promise<ProductionInputBinding> {
    const input = parsed.request.inputs[index]!;
    const profileInput = profile.inputs[index]!;
    assertAssetAllowlisted(input.asset, this.#policies);
    if (input.asset.byteLength > this.#maxAssetBytes) fail("asset-too-large");
    let sourceValue: ProductionStageAssetSource;
    try {
      sourceValue = await raceAbort(Promise.resolve(this.#assetResolver.resolve(
        Object.freeze(structuredClone(parsed.request.scope)),
        Object.freeze(structuredClone(input.asset)),
        operation.signal,
      )), operation.signal);
    } catch (error) {
      if (error instanceof ProductionStageGatewayError) throw error;
      if (operation.signal.aborted) fail("aborted");
      fail("resolver-unavailable");
    }
    const source = parseAssetSource(sourceValue, input.asset);
    const temporary = await createTempFile(this.#directories, "asset");
    const reader = source.body.getReader();
    const hash = createHash("sha256");
    const sniff = Buffer.alloc(64);
    let sniffed = 0;
    let length = 0;
    let closed = false;
    try {
      while (true) {
        const part = await raceAbort(reader.read(), operation.signal);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > this.#maxAssetBytes || length > input.asset.byteLength) {
          void reader.cancel().catch(() => undefined);
          fail("asset-too-large");
        }
        const take = Math.min(sniff.length - sniffed, part.value.byteLength);
        if (take > 0) {
          sniff.set(part.value.subarray(0, take), sniffed);
          sniffed += take;
        }
        hash.update(part.value);
        await writeAll(temporary.handle, part.value);
        if (operation.signal.aborted) fail("aborted");
      }
      const actualDigest = hash.digest("hex");
      if (length !== input.asset.byteLength || actualDigest !== input.asset.sha256) fail("asset-integrity");
      const sniffedMediaType = sniffMediaType(sniff.subarray(0, sniffed));
      if (sniffedMediaType === null || sniffedMediaType !== input.asset.mediaType
        || !profileInput.mediaTypes.includes(sniffedMediaType)) fail("unsupported-media");
      await temporary.handle.chmod(0o400);
      // Persist both bytes and the immutable mode before the atomic publication link.
      await temporary.handle.sync();
      this.#hooks.afterAssetTempSynced?.(Object.freeze({ index, assetSha256: input.asset.sha256 }));
      if (operation.signal.aborted) fail("aborted");
      await temporary.handle.close();
      closed = true;
      const binding: ProductionInputBinding = {
        index,
        slot: profileInput.slot,
        assetSha256: input.asset.sha256,
        providerObjectKey: providerObjectKey(profile.providerCasNamespace, input.asset.sha256),
      };
      await this.#publishObject(
        temporary.path, binding.providerObjectKey, input.asset.sha256, input.asset.byteLength, operation.signal,
      );
      this.#hooks.afterProviderObjectPublished?.(Object.freeze(structuredClone(binding)));
      if (operation.signal.aborted) fail("aborted");
      return binding;
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (!closed) await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async #stage(request: Request, path: { scope: ProductionInputStageScope; stageKey: string }, operation: Operation): Promise<Response> {
    const parsed = parseStageRequest(
      await readBoundedJson(request, this.#maxRequestBytes, operation.signal),
      path.scope,
      path.stageKey,
      request.headers.get("x-writing-loop-idempotency-key"),
    );
    const replay = await this.#loadReceipt(parsed, operation.signal);
    if (replay) {
      if (replay.requestDigest !== parsed.requestDigest) fail("conflict");
      assertReceiptMatchesRequest(replay, parsed);
      return jsonResponse(replay.result);
    }
    if (parsed.expectedStageKey !== parsed.request.stageKey) fail("bad-request");
    const profile = await this.#profile(parsed, operation.signal);
    const profileDigest = productionStageProfileDigest(profile);
    const bindings: ProductionInputBinding[] = [];
    for (let index = 0; index < parsed.request.inputs.length; index++) {
      bindings.push(await this.#stageAsset(parsed, profile, index, operation));
    }
    const result: ProductionInputStageResult = {
      version: 1,
      stageKey: parsed.request.stageKey,
      bindingsDigest: productionInputBindingsDigest(bindings),
      bindings,
    };
    this.#hooks.beforeReceiptPublish?.(Object.freeze(structuredClone(result)));
    if (operation.signal.aborted) fail("aborted");
    await this.#verifyRoot();
    const receipt: StageReceipt = {
      version: 1,
      stageKey: parsed.request.stageKey,
      scope: parsed.request.scope,
      intentDigest: parsed.request.intentDigest,
      requestDigest: parsed.requestDigest,
      profileDigest,
      execution: structuredClone(profile.registration.execution),
      result,
    };
    const published = await publishExactJson(
      this.#directories, this.#receiptPath(parsed.request.scope, parsed.request.stageKey), receipt,
    );
    if (published === "exists") {
      const winner = await this.#loadReceipt(parsed, operation.signal);
      if (!winner) fail("internal");
      if (winner.requestDigest !== parsed.requestDigest) fail("conflict");
      assertReceiptMatchesRequest(winner, parsed);
      return jsonResponse(winner.result);
    }
    this.#hooks.afterReceiptPublished?.(Object.freeze(structuredClone(result)));
    return jsonResponse(result);
  }

  /** Fetch-compatible route handler for a private server/mount. */
  async handle(request: Request): Promise<Response> {
    let operation: Operation | null = null;
    try {
      const url = new URL(request.url);
      if (url.search || url.hash) fail("not-found");
      const path = decodeScopePath(url.pathname);
      if (!path || request.method !== "PUT") fail("not-found");
      operation = this.#operation(request.signal);
      await this.#verifyRoot();
      await this.#authorize(request, path.scope, operation);
      return await this.#stage(request, path, operation);
    } catch (error) {
      if (error instanceof ProductionStageGatewayError) return errorResponse(error);
      if (operation?.signal.aborted) return errorResponse(new ProductionStageGatewayError("aborted"));
      return errorResponse(new ProductionStageGatewayError("internal"));
    } finally {
      operation?.finish();
    }
  }

  /** Server-internal exact receipt proof for the job gateway; performs no network or mutation. */
  async verifyStageReceipt(
    claimValue: ProductionStageReceiptClaim,
    callerSignal?: AbortSignal,
  ): Promise<VerifiedStageReceipt | null> {
    let claim: ProductionStageReceiptClaim;
    try { claim = parseClaim(claimValue); }
    catch (error) {
      if (error instanceof ProductionStageGatewayError) return null;
      throw error;
    }
    const fallback = new AbortController();
    const operation = this.#operation(callerSignal ?? fallback.signal);
    try {
      await this.#verifyRoot();
      let value: unknown;
      try {
        value = await readExactSafeJson(
          this.#receiptPath(claim.scope, claim.stageKey), this.#maxRequestBytes, operation.signal,
          this.#directories.temporary,
        );
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return null;
        throw error;
      }
      const receipt = parseStoredReceipt(value, claim.scope, claim.stageKey);
      if (!(receipt.result.bindingsDigest === claim.bindingsDigest
        && receipt.intentDigest === claim.intentDigest
        && receipt.profileDigest === claim.profileDigest)) return null;
      const verified: VerifiedStageReceipt = {
        version: 1,
        scope: Object.freeze({ ...receipt.scope }),
        stageKey: receipt.stageKey,
        bindingsDigest: receipt.result.bindingsDigest,
        intentDigest: receipt.intentDigest,
        profileDigest: receipt.profileDigest,
        execution: Object.freeze(structuredClone(receipt.execution)),
        bindings: Object.freeze(receipt.result.bindings.map((binding) => Object.freeze({ ...binding }))),
      };
      return Object.freeze(verified);
    } finally {
      operation.finish();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown.abort(new Error("shutdown"));
    for (const controller of this.#active) controller.abort(new Error("shutdown"));
  }
}
