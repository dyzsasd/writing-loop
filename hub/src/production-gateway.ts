// Private, zero-runtime-dependency production artifact gateway.
//
// The HTTP request can name only an authenticated ingest identity and audited Comfy output
// locators.  Provider and storage endpoints are immutable server configuration: no caller URL is
// ever parsed or fetched.  Assets are streamed into a content-addressed, fsync'd filesystem store
// and receipts make PUT replay exact after crashes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  MAX_PRODUCTION_ASSETS_PER_TASK,
  ProductionError,
  parseProductionCost,
  type AssetRef,
  type ProductionCost,
} from "./production-domain.ts";
import type {
  ComfyViewOutputLocator,
  FetchLike,
  ProviderOutputLocator,
  RemoteOutputLocator,
} from "./production-adapter.ts";
import {
  compareProductionOutputLocator,
  type ProductionGatewayIngestRequest,
  type ProductionIngestScope,
  type ProductionIngestResult,
} from "./production-ingestor.ts";
import {
  SHOT_REQUEST_MEDIA_TYPE,
  readShotRequestDocument,
} from "./production-shot-request.ts";

export const DEFAULT_PRODUCTION_GATEWAY_TIMEOUT_MS = 120_000;
export const DEFAULT_PRODUCTION_GATEWAY_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_PRODUCTION_GATEWAY_ASSET_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * §6.4 upload route ceiling for one ShotRequest document. It is the same 1 MiB the workspace CAS
 * (`production-cas.ts`) and the stage kernel apply, so the three bounds cannot drift apart.
 */
export const MAX_PRODUCTION_GATEWAY_UPLOAD_DOCUMENT_BYTES = 1024 * 1024;
/**
 * Fallback ceiling for an uploaded image. The deployed process passes the registry's
 * `backends[].maxInputImageBytes` instead — the same number the capability route quotes (§4.3).
 */
export const DEFAULT_PRODUCTION_GATEWAY_UPLOAD_IMAGE_BYTES = 64 * 1024 * 1024;

export type ProductionGatewayCredentialContext = {
  workspaceId: string;
  project: string;
  operation: "ingest" | "asset-read" | "asset-write" | "comfy-output-read";
};

export type ProductionGatewayCredentialResolver = (
  context: Readonly<ProductionGatewayCredentialContext>,
  signal: AbortSignal,
) => string | Promise<string>;

export type ProductionGatewayCostResolver = (
  request: Readonly<ProductionGatewayIngestRequest>,
  signal: AbortSignal,
) => ProductionCost | Promise<ProductionCost>;

/** §4.4 `openOutput`: a provider-output locator is fetched through the adapter, never through a URL. */
export type ProductionProviderOutputOpener = (
  output: Readonly<ProviderOutputLocator>,
  signal: AbortSignal,
) => Promise<{ body: ReadableStream<Uint8Array>; declaredLength: number | null }>;

/**
 * §5.3 tail frame: H3 does not return one, so the ingest kernel derives it from the ingested primary
 * video. The extractor is injected so the kernel stays free of process spawning; the default
 * implementation (`productionFfmpegLastFrameExtractor`) runs a fixed `ffmpeg` argv over two
 * gateway-owned paths.
 */
export type ProductionLastFrameExtractor = (
  input: Readonly<{ videoPath: string; mediaType: string; byteLength: number }>,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export type ProductionGatewayOptions = {
  /** Absolute, server-owned filesystem root. It is never accepted from an HTTP request. */
  storeRoot: string;
  /** Trusted ComfyUI origin/base path. It is never accepted from an HTTP request. */
  comfyBaseUrl: string | URL;
  /** Server-only bearer secret resolver, called for every request to permit rotation. */
  credentialResolver?: ProductionGatewayCredentialResolver;
  /** Plain HTTP is development-only, literal-loopback-only, and cannot carry any bearer. */
  allowInsecureLoopback?: boolean;
  /** Optional server-only credential for ComfyUI itself. */
  comfyCredentialResolver?: ProductionGatewayCredentialResolver;
  /** Optional server-side provider accounting integration. Defaults to an honest unknown cost. */
  costResolver?: ProductionGatewayCostResolver;
  /** Required before a `provider-output` locator can be ingested; there is no URL fallback. */
  providerOutputOpener?: ProductionProviderOutputOpener;
  /**
   * Enables the derived tail frame. It is opt-in because a deployment without ffmpeg must fail
   * loudly at assembly rather than half-way through an ingest.
   */
  lastFrameExtractor?: ProductionLastFrameExtractor;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxAssetBytes?: number;
  /** §6.4 `assets` PUT ceiling for a sniffed image; the ShotRequest bound is fixed at 1 MiB. */
  maxUploadImageBytes?: number;
  maxAssets?: number;
  bindHost?: string;
  bindPort?: number;
};

export type ProductionGatewayAddress = {
  host: string;
  port: number;
};

export type ProductionGatewayServer = {
  gateway: ProductionGateway;
  address: ProductionGatewayAddress;
  close(): Promise<void>;
};

export type ProductionGatewayErrorCode =
  | "aborted"
  | "asset-too-large"
  | "bad-request"
  | "conflict"
  | "derivation-failed"
  | "forbidden"
  | "internal"
  | "not-found"
  | "provider-unavailable"
  | "request-too-large"
  | "unauthorized"
  | "unsupported-media";

const ERROR_STATUS: Readonly<Record<ProductionGatewayErrorCode, number>> = Object.freeze({
  aborted: 503,
  "asset-too-large": 413,
  "bad-request": 400,
  conflict: 409,
  "derivation-failed": 500,
  forbidden: 403,
  internal: 500,
  "not-found": 404,
  "provider-unavailable": 502,
  "request-too-large": 413,
  unauthorized: 401,
  "unsupported-media": 415,
});

/** Stable public error. It never carries a URL, token, provider body, filename, or raw cause. */
export class ProductionGatewayError extends Error {
  readonly code: ProductionGatewayErrorCode;
  readonly status: number;

  constructor(code: ProductionGatewayErrorCode) {
    super(`production gateway ${code}`);
    this.name = "ProductionGatewayError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

type GatewayDirectories = {
  root: string;
  blobs: string;
  metadata: string;
  receipts: string;
  ownership: string;
  temporary: string;
  rootDevice: bigint;
  rootInode: bigint;
};

type AssetMetadata = AssetRef & { version: 1 };

type IngestReceipt = {
  version: 1;
  scope: ProductionIngestScope;
  ingestKey: string;
  requestDigest: string;
  result: ProductionIngestResult;
};

type AssetOwnershipClaim = {
  version: 1;
  scope: ProductionIngestScope;
  asset: AssetMetadata;
};

type DownloadedAsset = {
  asset: AssetRef;
  metadata: AssetMetadata;
};

type OpenAsset = {
  handle: FileHandle;
  metadata: AssetMetadata;
};

type Operation = {
  controller: AbortController;
  signal: AbortSignal;
  timedOut(): boolean;
  finish(): void;
};

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const LOCATOR_KINDS = new Set(["image", "video", "audio", "file"]);
const FOLDER_TYPES = new Set(["output", "temp"]);
/** Media types this kernel can recognise from a magic number, i.e. everything an ingest can yield. */
const SNIFFABLE_MEDIA_TYPES = new Set([
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);
/**
 * Everything the store may hold. The ShotRequest is a JSON document with no magic number: it only
 * enters the store through the `assets` upload route (§6.4), which identifies it by content check
 * rather than by sniffing, so it is representable in metadata but never in a sniff result.
 */
const ALLOWED_MEDIA_TYPES = new Set([...SNIFFABLE_MEDIA_TYPES, SHOT_REQUEST_MEDIA_TYPE]);
const UNKNOWN_COST: ProductionCost = Object.freeze({
  version: 1,
  state: "unknown",
  reason: "provider-not-reported",
});
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: ProductionGatewayErrorCode): never {
  throw new ProductionGatewayError(code);
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) fail("aborted");
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail("bad-request");
  return result;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) fail("internal");
  return value;
}

/** A resolver keeps the credential entirely in server configuration and out of route payloads. */
export function staticProductionGatewayCredential(token: string): ProductionGatewayCredentialResolver {
  const secret = validateToken(token);
  return () => secret;
}

function parseScope(
  workspaceId: unknown,
  project: unknown,
  errorCode: ProductionGatewayErrorCode = "bad-request",
): ProductionIngestScope {
  if (typeof workspaceId !== "string" || !SAFE_WORKSPACE_ID.test(workspaceId)
    || typeof project !== "string" || !SAFE_PROJECT.test(project)) fail(errorCode);
  return { version: 1, workspaceId, project };
}

function sameScope(left: ProductionIngestScope, right: ProductionIngestScope): boolean {
  return left.version === right.version
    && left.workspaceId === right.workspaceId
    && left.project === right.project;
}

function parseScopeValue(
  value: unknown,
  errorCode: ProductionGatewayErrorCode = "bad-request",
): ProductionIngestScope {
  if (!isRecord(value) || !exactKeys(value, ["version", "workspaceId", "project"])
    || value.version !== 1) fail(errorCode);
  return parseScope(value.workspaceId, value.project, errorCode);
}

function scopeStorageId(scope: ProductionIngestScope): string {
  return sha256(JSON.stringify(scope));
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

function constantTimeBearerMatches(header: string | null, expected: string): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const candidateValid = TOKEN.test(candidate) && !candidate.includes(",");
  // Hash both sides so timingSafeEqual has equal-length inputs even for missing/malformed headers.
  const actualDigest = createHash("sha256").update(candidateValid ? candidate : "invalid").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return candidateValid && timingSafeEqual(actualDigest, expectedDigest);
}

function isPrivateBindHost(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127 || octets[0] === 10
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    if (normalized === "::1") return true;
    const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

function validateBindHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  if (!isPrivateBindHost(host)) fail("forbidden");
  return host;
}

function trustedComfyBaseUrl(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { fail("bad-request"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || url.username || url.password || url.search || url.hash) {
    fail("bad-request");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function safeRemotePath(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" && value.length <= 512
    && (allowEmpty || value.length > 0)
    && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/")
    && !value.split("/").some((part) => part === ".." || part === ".");
}

function parseLocator(value: unknown): RemoteOutputLocator {
  if (!isRecord(value)) fail("bad-request");
  // §4.5 判别联合：缺少 source 时按 comfy-view 读取；写入侧总带 source。
  const source = Object.prototype.hasOwnProperty.call(value, "source") ? value.source : "comfy-view";
  if (source === "provider-output") {
    if (!exactKeys(value, ["source", "remoteJobId", "outputIndex", "role", "kind"])
      || typeof value.remoteJobId !== "string" || !IDENTIFIER.test(value.remoteJobId)
      || !Number.isSafeInteger(value.outputIndex) || (value.outputIndex as number) < 0
      || (value.outputIndex as number) > 127
      || (value.role !== "primary" && value.role !== "last-frame")
      || (value.kind !== "video" && value.kind !== "image")) fail("bad-request");
    return {
      source: "provider-output",
      remoteJobId: value.remoteJobId,
      outputIndex: value.outputIndex as number,
      role: value.role,
      kind: value.kind,
    };
  }
  if (source !== "comfy-view") fail("bad-request");
  const comfyKeys = ["nodeId", "kind", "filename", "subfolder", "folderType"];
  if (!exactKeys(value, Object.prototype.hasOwnProperty.call(value, "source")
    ? ["source", ...comfyKeys] : comfyKeys)
    || typeof value.nodeId !== "string" || !IDENTIFIER.test(value.nodeId)
    || typeof value.kind !== "string" || !LOCATOR_KINDS.has(value.kind)
    || !safeRemotePath(value.filename, false) || !safeRemotePath(value.subfolder, true)
    || typeof value.folderType !== "string" || !FOLDER_TYPES.has(value.folderType)) {
    fail("bad-request");
  }
  return {
    source: "comfy-view",
    nodeId: value.nodeId,
    kind: value.kind as "image" | "video" | "audio" | "file",
    filename: value.filename,
    subfolder: value.subfolder,
    folderType: value.folderType as "output" | "temp",
  };
}

const compareLocator = compareProductionOutputLocator;

function parseIngestRequest(
  value: unknown,
  pathScope: ProductionIngestScope,
  pathKey: string,
  headerKey: string | null,
): ProductionGatewayIngestRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "ingestKey", "taskId", "idempotencyKey", "taskIdentityDigest",
    "backendInstanceId", "remoteJobId", "responseDigest", "locators",
  ]) || value.version !== 1 || value.ingestKey !== pathKey || headerKey !== pathKey
    || typeof value.ingestKey !== "string" || !SHA256.test(value.ingestKey)
    || typeof value.taskId !== "string" || !IDENTIFIER.test(value.taskId)
    || typeof value.idempotencyKey !== "string" || !IDENTIFIER.test(value.idempotencyKey)
    || typeof value.taskIdentityDigest !== "string" || !SHA256.test(value.taskIdentityDigest)
    || typeof value.backendInstanceId !== "string" || !IDENTIFIER.test(value.backendInstanceId)
    || typeof value.remoteJobId !== "string" || !IDENTIFIER.test(value.remoteJobId)
    || typeof value.responseDigest !== "string" || !SHA256.test(value.responseDigest)
    || !Array.isArray(value.locators) || value.locators.length < 1
    || value.locators.length > MAX_PRODUCTION_ASSETS_PER_TASK) {
    fail("bad-request");
  }
  const scope = parseScopeValue(value.scope);
  if (!sameScope(scope, pathScope)) fail("bad-request");
  const locators = value.locators.map(parseLocator);
  const canonical = [...locators].sort(compareLocator);
  if (locators.some((locator, index) => compareLocator(locator, canonical[index]!) !== 0)) fail("bad-request");
  const identities = locators.map((locator) => JSON.stringify(locator));
  if (new Set(identities).size !== identities.length) fail("bad-request");
  return {
    version: 1,
    scope,
    ingestKey: value.ingestKey,
    taskId: value.taskId,
    idempotencyKey: value.idempotencyKey,
    taskIdentityDigest: value.taskIdentityDigest,
    backendInstanceId: value.backendInstanceId,
    remoteJobId: value.remoteJobId,
    responseDigest: value.responseDigest,
    locators,
  };
}

function parseContentLength(
  value: string | null,
  maximum: number,
  tooLargeCode: ProductionGatewayErrorCode,
  malformedCode: ProductionGatewayErrorCode,
): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) fail(malformedCode);
  let size: bigint;
  try { size = BigInt(value); }
  catch { fail(malformedCode); }
  if (size > BigInt(maximum)) fail(tooLargeCode);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) fail(tooLargeCode);
  return Number(size);
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

async function readBoundedRequestJson(request: Request, maximum: number, signal: AbortSignal): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") fail("bad-request");
  const declared = parseContentLength(
    request.headers.get("content-length"), maximum, "request-too-large", "bad-request",
  );
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

function mediaMatchesKind(mediaType: string, kind: "image" | "video" | "audio" | "file"): boolean {
  if (!SNIFFABLE_MEDIA_TYPES.has(mediaType)) return false;
  if (kind === "file") return true;
  return mediaType.startsWith(`${kind}/`);
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, READ_FLAGS);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function ensureSafeDirectory(path: string, root: string): Promise<BigIntStats> {
  if (!inside(root, path)) fail("internal");
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (Number(before.mode) & 0o022) !== 0) fail("internal");
  const canonical = await realpath(path);
  if (canonical !== path) fail("internal");
  const after = await lstat(path, { bigint: true });
  if (!sameFile(before, after) || !after.isDirectory()) fail("internal");
  return after;
}

async function makeSafeDirectory(path: string, root: string): Promise<void> {
  if (!inside(root, path)) fail("internal");
  await ensureSafeDirectory(root, root);
  const suffix = path === root ? [] : path.slice(root.length + 1).split(sep);
  let parent = root;
  for (const component of suffix) {
    if (!component || component === "." || component === "..") fail("internal");
    const parentBefore = await ensureSafeDirectory(parent, root);
    const next = join(parent, component);
    try { await mkdir(next, { mode: 0o700 }); }
    catch (error) { if (!isNodeError(error, "EEXIST")) throw error; }
    const parentAfter = await lstat(parent, { bigint: true });
    if (!sameFile(parentBefore, parentAfter) || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()) {
      fail("internal");
    }
    await ensureSafeDirectory(next, root);
    parent = next;
  }
}

/**
 * Content-addressed blob path inside one ingest store root. Same-host readers — the stage kernel's
 * `cas://` asset resolver re-registering an already-ingested last frame (§6.4) — resolve through
 * this shared layout instead of copying the private directory constants.
 */
export function productionGatewayBlobPath(storeRoot: string, sha256: string): string {
  if (typeof storeRoot !== "string" || !isAbsolute(storeRoot) || resolve(storeRoot) === sep
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) fail("bad-request");
  return join(resolve(storeRoot), "blobs", "sha256", sha256.slice(0, 2), sha256);
}

async function initializeDirectories(configuredRoot: string): Promise<GatewayDirectories> {
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) === sep) fail("bad-request");
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const rootLink = await lstat(configuredRoot, { bigint: true });
  if (!rootLink.isDirectory() || rootLink.isSymbolicLink()) fail("bad-request");
  const root = await realpath(configuredRoot);
  const rootStat = await ensureSafeDirectory(root, root);
  const directories = {
    root,
    blobs: join(root, "blobs", "sha256"),
    metadata: join(root, "metadata", "sha256"),
    receipts: join(root, "receipts"),
    ownership: join(root, "ownership"),
    temporary: join(root, "tmp"),
  };
  for (const path of [
    directories.blobs,
    directories.metadata,
    directories.receipts,
    directories.ownership,
    directories.temporary,
  ]) {
    await makeSafeDirectory(path, root);
  }
  const pinned = await lstat(root, { bigint: true });
  return {
    ...directories,
    rootDevice: pinned.dev,
    rootInode: pinned.ino,
  };
}

function receiptPath(
  directories: GatewayDirectories,
  scope: ProductionIngestScope,
  ingestKey: string,
): string {
  return join(directories.receipts, scopeStorageId(scope), `${ingestKey}.json`);
}

function ownershipPath(
  directories: GatewayDirectories,
  scope: ProductionIngestScope,
  digest: string,
): string {
  return join(directories.ownership, scopeStorageId(scope), "sha256", digest.slice(0, 2), `${digest}.json`);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten < 1) fail("internal");
    offset += bytesWritten;
  }
}

async function createTempFile(directories: GatewayDirectories, prefix: string): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const nonce = randomBytes(24).toString("hex");
    const path = join(directories.temporary, `${prefix}-${nonce}.tmp`);
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function waitForSingleLink(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await lstat(path, { bigint: true });
    if (info.nlink === 1n || !info.isFile() || info.isSymbolicLink() || info.nlink !== 2n) return info;
    // Atomic publication uses link(temp, destination) followed by unlink(temp), so another request
    // may briefly observe nlink=2. A persistent attacker-created hardlink still fails after 200ms.
    const pause = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2));
    if (signal) await raceAbort(pause, signal);
    else await pause;
  }
  return await lstat(path, { bigint: true });
}

async function readExactSafeJson(path: string, maximum: number, signal?: AbortSignal): Promise<unknown> {
  const pathStat = await waitForSingleLink(path, signal);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n
    || pathStat.size < 1n || pathStat.size > BigInt(maximum)) fail("internal");
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathStat, opened)) fail("internal");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
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
  directories: GatewayDirectories,
  destination: string,
  value: unknown,
): Promise<"created" | "exists"> {
  if (!inside(directories.root, destination)) fail("internal");
  await makeSafeDirectory(dirname(destination), directories.root);
  const bytes = Buffer.from(JSON.stringify(value));
  const temp = await createTempFile(directories, "json");
  let linked = false;
  try {
    await writeAll(temp.handle, bytes);
    await temp.handle.sync();
    await temp.handle.chmod(0o400);
    await temp.handle.close();
    try {
      await link(temp.path, destination);
      linked = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await unlink(temp.path);
    if (linked) await syncDirectory(dirname(destination));
    return linked ? "created" : "exists";
  } catch (error) {
    await temp.handle.close().catch(() => undefined);
    await unlink(temp.path).catch(() => undefined);
    throw error;
  }
}

function parseAssetMetadata(value: unknown, expectedDigest: string): AssetMetadata {
  if (!isRecord(value) || !exactKeys(value, ["version", "uri", "sha256", "byteLength", "mediaType"])
    || value.version !== 1 || value.uri !== `urn:sha256:${expectedDigest}`
    || value.sha256 !== expectedDigest || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 1 || typeof value.mediaType !== "string"
    || !ALLOWED_MEDIA_TYPES.has(value.mediaType)) fail("internal");
  return {
    version: 1,
    uri: value.uri,
    sha256: expectedDigest,
    byteLength: value.byteLength as number,
    mediaType: value.mediaType,
  };
}

function parseReceipt(
  value: unknown,
  expectedScope: ProductionIngestScope,
  expectedKey: string,
): IngestReceipt {
  if (!isRecord(value) || !exactKeys(value, ["version", "scope", "ingestKey", "requestDigest", "result"])
    || value.version !== 1 || value.ingestKey !== expectedKey
    || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)
    || !isRecord(value.result) || !exactKeys(value.result, ["version", "ingestKey", "assets", "cost"])
    || value.result.version !== 1 || value.result.ingestKey !== expectedKey
    || !Array.isArray(value.result.assets) || value.result.assets.length < 1
    || value.result.assets.length > MAX_PRODUCTION_ASSETS_PER_TASK) fail("internal");
  const scope = parseScopeValue(value.scope, "internal");
  if (!sameScope(scope, expectedScope)) fail("internal");
  const assets = value.result.assets.map((asset) => {
    if (!isRecord(asset) || typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) fail("internal");
    return parseAssetMetadata(asset, asset.sha256);
  });
  let cost: ProductionCost;
  try { cost = parseProductionCost(value.result.cost, "ProductionGatewayReceipt.cost"); }
  catch (error) {
    if (error instanceof ProductionError) fail("internal");
    throw error;
  }
  return {
    version: 1,
    scope,
    ingestKey: expectedKey,
    requestDigest: value.requestDigest,
    result: { version: 1, ingestKey: expectedKey, assets, cost },
  };
}

function parseOwnershipClaim(
  value: unknown,
  expectedScope: ProductionIngestScope,
  expectedDigest: string,
): AssetOwnershipClaim {
  if (!isRecord(value) || !exactKeys(value, ["version", "scope", "asset"])
    || value.version !== 1 || !isRecord(value.asset)) fail("internal");
  const scope = parseScopeValue(value.scope, "internal");
  if (!sameScope(scope, expectedScope)) fail("internal");
  return {
    version: 1,
    scope,
    asset: parseAssetMetadata(value.asset, expectedDigest),
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> | Headers = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function errorResponse(error: ProductionGatewayError): Response {
  const headers: Record<string, string> = error.code === "unauthorized"
    ? { "www-authenticate": "Bearer" }
    : {};
  return jsonResponse({ version: 1, error: error.code }, error.status, headers);
}

type GatewayRoute =
  | { kind: "ingest"; scope: ProductionIngestScope; ingestKey: string }
  | { kind: "asset"; scope: ProductionIngestScope; digest: string }
  | { kind: "asset-head"; scope: ProductionIngestScope; digest: string }
  | { kind: "asset-upload"; scope: ProductionIngestScope; digest: string };

function canonicalScopeSegment(raw: string, pattern: RegExp): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); }
  catch { return null; }
  return pattern.test(decoded) && encodeURIComponent(decoded) === raw ? decoded : null;
}

function parseGatewayRoute(url: URL, method: string): GatewayRoute {
  if (url.search || url.hash) fail("not-found");
  const match = /^\/v1\/scopes\/([^/]+)\/([^/]+)\/(ingests|assets\/sha256)\/([a-f0-9]{64})$/.exec(
    url.pathname,
  );
  if (!match) fail("not-found");
  const workspaceId = canonicalScopeSegment(match[1]!, SAFE_WORKSPACE_ID);
  const project = canonicalScopeSegment(match[2]!, SAFE_PROJECT);
  if (workspaceId === null || project === null) fail("not-found");
  const scope = parseScope(workspaceId, project);
  if (match[3] === "ingests") {
    if (method !== "PUT") fail("not-found");
    return { kind: "ingest", scope, ingestKey: match[4]! };
  }
  // One URL per CAS object, three methods: the worker publishes a workspace-side input with PUT,
  // probes for it with HEAD before deciding to upload, and reads a registered take back with GET.
  if (method === "GET") return { kind: "asset", scope, digest: match[4]! };
  if (method === "HEAD") return { kind: "asset-head", scope, digest: match[4]! };
  if (method === "PUT") return { kind: "asset-upload", scope, digest: match[4]! };
  fail("not-found");
}

function comfyOutputUrl(base: URL, locator: ComfyViewOutputLocator): URL {
  const url = new URL(base.toString());
  // WHATWG URL normalizes an empty HTTP pathname back to "/". Treat that root sentinel as an
  // empty prefix so a trusted origin-only base (http://127.0.0.1:8188) resolves to /view.
  const basePath = base.pathname === "/" ? "" : base.pathname;
  const outputPath = `${basePath}/view`;
  url.pathname = outputPath;
  url.searchParams.set("filename", locator.filename);
  url.searchParams.set("subfolder", locator.subfolder);
  url.searchParams.set("type", locator.folderType);
  if (url.origin !== base.origin || url.pathname !== outputPath) fail("internal");
  return url;
}

async function validatedCost(value: unknown): Promise<ProductionCost> {
  try { return parseProductionCost(value, "ProductionGateway.cost"); }
  catch (error) {
    if (error instanceof ProductionError) fail("internal");
    throw error;
  }
}

export class ProductionGateway {
  readonly #directories: GatewayDirectories;
  readonly #comfyBaseUrl: URL;
  readonly #credentialResolver: ProductionGatewayCredentialResolver | null;
  readonly #comfyCredentialResolver: ProductionGatewayCredentialResolver | null;
  readonly #costResolver: ProductionGatewayCostResolver | null;
  readonly #providerOutputOpener: ProductionProviderOutputOpener | null;
  readonly #lastFrameExtractor: ProductionLastFrameExtractor | null;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxAssetBytes: number;
  readonly #maxUploadImageBytes: number;
  readonly #maxAssets: number;
  readonly #bindHost: string;
  readonly #bindPort: number;
  readonly #allowInsecureLoopback: boolean;
  readonly #shutdown = new AbortController();
  readonly #active = new Set<AbortController>();
  #closed = false;

  private constructor(options: ProductionGatewayOptions, directories: GatewayDirectories) {
    this.#directories = directories;
    this.#comfyBaseUrl = trustedComfyBaseUrl(options.comfyBaseUrl);
    this.#credentialResolver = options.credentialResolver ?? null;
    if (this.#credentialResolver !== null && typeof this.#credentialResolver !== "function") fail("bad-request");
    this.#comfyCredentialResolver = options.comfyCredentialResolver ?? null;
    this.#costResolver = options.costResolver ?? null;
    this.#providerOutputOpener = options.providerOutputOpener ?? null;
    this.#lastFrameExtractor = options.lastFrameExtractor ?? null;
    if ((this.#providerOutputOpener !== null && typeof this.#providerOutputOpener !== "function")
      || (this.#lastFrameExtractor !== null && typeof this.#lastFrameExtractor !== "function")) {
      fail("bad-request");
    }
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_PRODUCTION_GATEWAY_TIMEOUT_MS, 50, 900_000);
    this.#maxRequestBytes = boundedInteger(
      options.maxRequestBytes, DEFAULT_PRODUCTION_GATEWAY_REQUEST_BYTES, 1_024, 16 * 1024 * 1024,
    );
    this.#maxAssetBytes = boundedInteger(
      options.maxAssetBytes, DEFAULT_PRODUCTION_GATEWAY_ASSET_BYTES, 1_024, Number.MAX_SAFE_INTEGER,
    );
    this.#maxUploadImageBytes = boundedInteger(
      options.maxUploadImageBytes, DEFAULT_PRODUCTION_GATEWAY_UPLOAD_IMAGE_BYTES,
      1_024, 4 * 1024 * 1024 * 1024,
    );
    this.#maxAssets = boundedInteger(
      options.maxAssets, MAX_PRODUCTION_ASSETS_PER_TASK, 1, MAX_PRODUCTION_ASSETS_PER_TASK,
    );
    this.#bindHost = validateBindHost(options.bindHost);
    this.#bindPort = boundedInteger(options.bindPort, 0, 0, 65_535);
    this.#allowInsecureLoopback = options.allowInsecureLoopback === true;
    if (this.#allowInsecureLoopback) {
      if (!isLiteralLoopback(this.#bindHost) || this.#credentialResolver !== null) fail("bad-request");
    } else if (this.#credentialResolver === null) {
      fail("bad-request");
    }
  }

  static async create(options: ProductionGatewayOptions): Promise<ProductionGateway> {
    if (!options || typeof options !== "object" || typeof options.storeRoot !== "string") fail("bad-request");
    return new ProductionGateway(options, await initializeDirectories(options.storeRoot));
  }

  get bindHost(): string { return this.#bindHost; }
  get bindPort(): number { return this.#bindPort; }

  async #verifyRoot(): Promise<void> {
    const current = await lstat(this.#directories.root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== this.#directories.rootDevice || current.ino !== this.#directories.rootInode) fail("internal");
  }

  #operation(callerSignal: AbortSignal): Operation {
    if (this.#closed || this.#shutdown.signal.aborted) fail("aborted");
    const controller = new AbortController();
    this.#active.add(controller);
    let timeout = false;
    const abortFromCaller = (): void => controller.abort(callerSignal.reason ?? new Error("aborted"));
    const abortFromShutdown = (): void => controller.abort(new Error("shutdown"));
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    this.#shutdown.signal.addEventListener("abort", abortFromShutdown, { once: true });
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort(new Error("deadline"));
    }, this.#timeoutMs);
    let finished = false;
    return {
      controller,
      signal: controller.signal,
      timedOut: () => timeout,
      finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callerSignal.removeEventListener("abort", abortFromCaller);
        this.#shutdown.signal.removeEventListener("abort", abortFromShutdown);
        this.#active.delete(controller);
      },
    };
  }

  async #authorize(
    request: Request,
    context: Readonly<ProductionGatewayCredentialContext>,
    operation: Operation,
  ): Promise<void> {
    const url = new URL(request.url);
    if (this.#allowInsecureLoopback) {
      if (url.protocol !== "http:" || !isLiteralLoopback(url.hostname)
        || request.headers.has("authorization")) fail("unauthorized");
      return;
    }
    if (this.#credentialResolver === null) fail("unauthorized");
    let expected: string;
    try {
      expected = validateToken(await raceAbort(
        Promise.resolve(this.#credentialResolver(Object.freeze({ ...context }), operation.signal)), operation.signal,
      ));
    } catch (error) {
      if (error instanceof ProductionGatewayError) throw error;
      if (operation.signal.aborted) fail("aborted");
      fail("internal");
    }
    if (!constantTimeBearerMatches(request.headers.get("authorization"), expected)) fail("unauthorized");
  }

  async #loadReceipt(
    scope: ProductionIngestScope,
    ingestKey: string,
    signal?: AbortSignal,
  ): Promise<IngestReceipt | null> {
    await this.#verifyRoot();
    const path = receiptPath(this.#directories, scope, ingestKey);
    try {
      return parseReceipt(await readExactSafeJson(path, this.#maxRequestBytes, signal), scope, ingestKey);
    }
    catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  /**
   * `mismatchCode` separates "the store is corrupt" from "the caller's bytes are not the bytes this
   * digest already names". Only the two content comparisons take it; every identity/replacement
   * check stays `internal`, because those can only mean the store itself was tampered with.
   */
  async #validateExistingBlob(
    path: string,
    digest: string,
    length: number,
    signal: AbortSignal,
    mismatchCode: ProductionGatewayErrorCode = "internal",
  ): Promise<void> {
    const pathInfo = await waitForSingleLink(path, signal);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n) fail("internal");
    if (pathInfo.size !== BigInt(length)) fail(mismatchCode);
    const handle = await open(path, READ_FLAGS);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathInfo, opened)) fail("internal");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - offset), offset);
        if (bytesRead < 1) fail("internal");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const end = await handle.stat({ bigint: true });
      const finalPath = await lstat(path, { bigint: true });
      if (!sameFile(opened, end) || !sameFile(end, finalPath)
        || end.size !== opened.size || end.nlink !== 1n) fail("internal");
      if (hash.digest("hex") !== digest) fail(mismatchCode);
    } finally {
      await handle.close();
    }
  }

  async #publishBlob(
    tempPath: string,
    digest: string,
    length: number,
    signal: AbortSignal,
    mismatchCode: ProductionGatewayErrorCode = "internal",
  ): Promise<string> {
    await this.#verifyRoot();
    const shard = join(this.#directories.blobs, digest.slice(0, 2));
    await makeSafeDirectory(shard, this.#directories.root);
    const destination = join(shard, digest);
    let created = false;
    try {
      await link(tempPath, destination);
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await unlink(tempPath);
    if (created) {
      await syncDirectory(shard);
      const installed = await lstat(destination, { bigint: true });
      if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1n
        || installed.size !== BigInt(length)) fail("internal");
    } else {
      await this.#validateExistingBlob(destination, digest, length, signal, mismatchCode);
    }
    return destination;
  }

  async #publishMetadata(metadata: AssetMetadata, signal: AbortSignal): Promise<void> {
    await this.#verifyRoot();
    const shard = join(this.#directories.metadata, metadata.sha256.slice(0, 2));
    await makeSafeDirectory(shard, this.#directories.root);
    const path = join(shard, `${metadata.sha256}.json`);
    const status = await publishExactJson(this.#directories, path, metadata);
    if (status === "exists") {
      const existing = parseAssetMetadata(await readExactSafeJson(path, 16 * 1024, signal), metadata.sha256);
      if (JSON.stringify(existing) !== JSON.stringify(metadata)) fail("internal");
    }
  }

  async #loadOwnership(
    scope: ProductionIngestScope,
    digest: string,
    signal: AbortSignal,
  ): Promise<AssetOwnershipClaim | null> {
    await this.#verifyRoot();
    const path = ownershipPath(this.#directories, scope, digest);
    try {
      return parseOwnershipClaim(await readExactSafeJson(path, 32 * 1024, signal), scope, digest);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async #publishOwnership(
    scope: ProductionIngestScope,
    asset: AssetMetadata,
    signal: AbortSignal,
  ): Promise<void> {
    const claim: AssetOwnershipClaim = { version: 1, scope, asset };
    const path = ownershipPath(this.#directories, scope, asset.sha256);
    await this.#verifyRoot();
    requireActive(signal);
    const status = await publishExactJson(this.#directories, path, claim);
    if (status === "exists") {
      const existing = await this.#loadOwnership(scope, asset.sha256, signal);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(claim)) fail("internal");
    }
  }

  async #requireReceiptOwnership(receipt: IngestReceipt, signal: AbortSignal): Promise<void> {
    for (const asset of receipt.result.assets) {
      const claim = await this.#loadOwnership(receipt.scope, asset.sha256, signal);
      if (!claim || JSON.stringify(claim.asset) !== JSON.stringify(asset)) fail("internal");
    }
  }

  async #comfyCredential(scope: ProductionIngestScope, signal: AbortSignal): Promise<string | null> {
    if (!this.#comfyCredentialResolver) return null;
    try {
      return validateToken(await raceAbort(
        Promise.resolve(this.#comfyCredentialResolver(Object.freeze({
          workspaceId: scope.workspaceId,
          project: scope.project,
          operation: "comfy-output-read",
        }), signal)), signal,
      ));
    } catch (error) {
      if (error instanceof ProductionGatewayError) throw error;
      if (signal.aborted) fail("aborted");
      fail("provider-unavailable");
    }
  }

  /**
   * Obtain the byte stream for one audited locator. `comfy-view` goes through the trusted ComfyUI
   * origin; `provider-output` goes through the adapter's `openOutput`, which keeps any signed URL or
   * OAuth token inside that one transfer (§4.4).
   */
  async #openLocator(
    scope: ProductionIngestScope,
    locator: RemoteOutputLocator,
    operation: Operation,
  ): Promise<{ body: ReadableStream<Uint8Array>; declared: number | null }> {
    if (locator.source === "provider-output") {
      if (this.#providerOutputOpener === null) fail("provider-unavailable");
      let opened: { body: ReadableStream<Uint8Array>; declaredLength: number | null };
      try {
        opened = await raceAbort(Promise.resolve(this.#providerOutputOpener(
          Object.freeze({ ...locator }), operation.signal,
        )), operation.signal);
      } catch (error) {
        if (error instanceof ProductionGatewayError) throw error;
        if (operation.signal.aborted) fail("aborted");
        fail("provider-unavailable");
      }
      if (!opened || typeof opened !== "object" || typeof opened.body !== "object" || opened.body === null
        || typeof (opened.body as ReadableStream<Uint8Array>).getReader !== "function") {
        fail("provider-unavailable");
      }
      const declaredLength = opened.declaredLength;
      if (declaredLength !== null) {
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) {
          void opened.body.cancel().catch(() => undefined);
          fail("provider-unavailable");
        }
        if (declaredLength > this.#maxAssetBytes) {
          void opened.body.cancel().catch(() => undefined);
          fail("asset-too-large");
        }
      }
      return { body: opened.body, declared: declaredLength };
    }
    const headers: Record<string, string> = {
      accept: "application/octet-stream",
      "accept-encoding": "identity",
    };
    const comfyCredential = await this.#comfyCredential(scope, operation.signal);
    if (comfyCredential !== null) headers.authorization = `Bearer ${comfyCredential}`;
    let response: Response;
    try {
      response = await raceAbort(Promise.resolve(this.#fetch(comfyOutputUrl(this.#comfyBaseUrl, locator), {
        method: "GET",
        redirect: "error",
        headers,
        signal: operation.signal,
      })), operation.signal);
    } catch {
      if (operation.signal.aborted) fail("aborted");
      fail("provider-unavailable");
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      fail("provider-unavailable");
    }
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      void response.body.cancel().catch(() => undefined);
      fail("provider-unavailable");
    }
    let declared: number | null;
    try {
      declared = parseContentLength(
        response.headers.get("content-length"), this.#maxAssetBytes, "asset-too-large", "provider-unavailable",
      );
    } catch (error) {
      void response.body.cancel().catch(() => undefined);
      throw error;
    }
    if (declared === 0) {
      void response.body.cancel().catch(() => undefined);
      fail("unsupported-media");
    }
    return { body: response.body, declared };
  }

  /**
   * Stream one opened locator into the content-addressed store. The digest, the length and the
   * sniffed media type are all measured from the bytes actually received.
   */
  async #absorb(
    body: ReadableStream<Uint8Array>,
    declared: number | null,
    kind: "image" | "video" | "audio" | "file",
    operation: Operation,
  ): Promise<DownloadedAsset> {
    await this.#verifyRoot();
    const temporary = await createTempFile(this.#directories, "asset");
    const reader = body.getReader();
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
        if (length > this.#maxAssetBytes) {
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
      if (length < 1 || (declared !== null && declared !== length)) fail("provider-unavailable");
      const mediaType = sniffMediaType(sniff.subarray(0, sniffed));
      if (mediaType === null || !mediaMatchesKind(mediaType, kind)) fail("unsupported-media");
      await temporary.handle.sync();
      requireActive(operation.signal);
      await temporary.handle.chmod(0o400);
      await temporary.handle.close();
      closed = true;
      const digest = hash.digest("hex");
      await this.#publishBlob(temporary.path, digest, length, operation.signal);
      requireActive(operation.signal);
      const metadata: AssetMetadata = {
        version: 1,
        uri: `urn:sha256:${digest}`,
        sha256: digest,
        byteLength: length,
        mediaType,
      };
      await this.#publishMetadata(metadata, operation.signal);
      requireActive(operation.signal);
      return { asset: metadata, metadata };
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (!closed) await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }


  async #download(
    scope: ProductionIngestScope,
    locator: RemoteOutputLocator,
    operation: Operation,
  ): Promise<DownloadedAsset> {
    const opened = await this.#openLocator(scope, locator, operation);
    return await this.#absorb(opened.body, opened.declared, locator.kind, operation);
  }

  async #ingest(
    request: Request,
    scope: ProductionIngestScope,
    ingestKey: string,
    operation: Operation,
  ): Promise<Response> {
    const raw = await readBoundedRequestJson(request, this.#maxRequestBytes, operation.signal);
    const parsed = parseIngestRequest(
      raw,
      scope,
      ingestKey,
      request.headers.get("x-writing-loop-idempotency-key"),
    );
    if (parsed.locators.length > this.#maxAssets) fail("bad-request");
    const requestDigest = sha256(JSON.stringify(parsed));
    const replay = await this.#loadReceipt(scope, ingestKey, operation.signal);
    if (replay) {
      if (replay.requestDigest !== requestDigest) fail("conflict");
      await this.#requireReceiptOwnership(replay, operation.signal);
      return jsonResponse(replay.result);
    }

    const byDigest = new Map<string, AssetRef>();
    for (const locator of parsed.locators) {
      if (operation.signal.aborted) fail("aborted");
      const downloaded = await this.#download(scope, locator, operation);
      await this.#publishOwnership(scope, downloaded.metadata, operation.signal);
      requireActive(operation.signal);
      byDigest.set(downloaded.asset.sha256, downloaded.asset);
    }
    requireActive(operation.signal);
    const assets = [...byDigest.values()];
    if (assets.length < 1) fail("internal");
    const derived = await this.#deriveLastFrame(parsed, assets, operation);
    if (derived !== null) {
      await this.#publishOwnership(scope, derived, operation.signal);
      requireActive(operation.signal);
      // A provider that returns the same bytes twice must not create a duplicate AssetRef.
      if (!assets.some((asset) => asset.sha256 === derived.sha256)) assets.push(derived);
    }
    let cost = UNKNOWN_COST;
    if (this.#costResolver) {
      try {
        cost = await validatedCost(await raceAbort(
          Promise.resolve(this.#costResolver(Object.freeze(parsed), operation.signal)), operation.signal,
        ));
      } catch (error) {
        if (error instanceof ProductionGatewayError) throw error;
        if (operation.signal.aborted) fail("aborted");
        fail("internal");
      }
    }
    const result: ProductionIngestResult = { version: 1, ingestKey, assets, cost };
    const receipt: IngestReceipt = { version: 1, scope, ingestKey, requestDigest, result };
    const destination = receiptPath(this.#directories, scope, ingestKey);
    requireActive(operation.signal);
    await this.#verifyRoot();
    const published = await publishExactJson(this.#directories, destination, receipt);
    requireActive(operation.signal);
    if (published === "exists") {
      const winner = await this.#loadReceipt(scope, ingestKey, operation.signal);
      if (!winner) fail("internal");
      if (winner.requestDigest !== requestDigest) fail("conflict");
      await this.#requireReceiptOwnership(winner, operation.signal);
      return jsonResponse(winner.result);
    }
    return jsonResponse(result);
  }

  /**
   * §5.3 / §8.6: after the ingest, register the tail frame as a second AssetRef. A provider that
   * already returned one (`role: "last-frame"`) is authoritative; otherwise the injected extractor
   * derives it from the single ingested primary video. The derived blob lands in the same CAS the
   * stage kernel's `cas://` resolver reads, so the next shot can take it as its first frame (§6.4).
   */
  async #deriveLastFrame(
    request: ProductionGatewayIngestRequest,
    assets: readonly AssetRef[],
    operation: Operation,
  ): Promise<AssetMetadata | null> {
    if (this.#lastFrameExtractor === null) return null;
    if (request.locators.some((locator) =>
      locator.source === "provider-output" && locator.role === "last-frame")) return null;
    // An extractor is configured, so this deployment owes every take a tail frame. Zero or several
    // primary videos means there is no single frame to derive, and silently registering one asset
    // fewer would break the continuity chain the next shot reads (§6.4).
    const videos = assets.filter((asset) => asset.mediaType.startsWith("video/"));
    if (videos.length !== 1) fail("derivation-failed");
    const video = videos[0]!;
    if (assets.length + 1 > this.#maxAssets) fail("derivation-failed");
    await this.#verifyRoot();
    const videoPath = join(this.#directories.blobs, video.sha256.slice(0, 2), video.sha256);
    let bytes: Uint8Array;
    try {
      bytes = await raceAbort(Promise.resolve(this.#lastFrameExtractor(Object.freeze({
        videoPath,
        mediaType: video.mediaType,
        byteLength: video.byteLength,
      }), operation.signal)), operation.signal);
    } catch (error) {
      if (error instanceof ProductionGatewayError) throw error;
      if (operation.signal.aborted) fail("aborted");
      fail("derivation-failed");
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) fail("derivation-failed");
    if (bytes.byteLength > this.#maxAssetBytes) fail("asset-too-large");
    const frame = new Blob([bytes]).stream() as ReadableStream<Uint8Array>;
    const absorbed = await this.#absorb(frame, bytes.byteLength, "image", operation);
    return absorbed.metadata;
  }

  /**
   * §6.4 input upload. The worker's staging inputs — the ShotRequest `inputs[0]` and any keyframe
   * the operator supplied — originate in the workspace CAS on the control-plane host, which has no
   * path into the GPU VM's store. This route is that path, and it is content-addressed end to end:
   * the digest in the URL is the object's whole identity, the server recomputes it from the bytes it
   * actually received, and a body that hashes to anything else is refused before publication. What
   * lands is therefore always the object the caller named, so a replay is a no-op and no caller can
   * choose what a digest resolves to.
   */
  async #uploadAsset(
    request: Request,
    scope: ProductionIngestScope,
    digest: string,
    operation: Operation,
  ): Promise<Response> {
    // One hard ceiling for the transfer; the type-specific bound is applied once the bytes identify
    // themselves, because nothing before the first 64 bytes says which of the two this is.
    const ceiling = Math.max(this.#maxUploadImageBytes, MAX_PRODUCTION_GATEWAY_UPLOAD_DOCUMENT_BYTES);
    const declared = parseContentLength(
      request.headers.get("content-length"), ceiling, "asset-too-large", "bad-request",
    );
    if (!request.body) fail("bad-request");
    await this.#verifyRoot();
    const temporary = await createTempFile(this.#directories, "upload");
    const reader = request.body.getReader();
    const hash = createHash("sha256");
    const sniff = Buffer.alloc(64);
    // The ShotRequest is content-checked, so its bytes are kept; anything past the document ceiling
    // cannot be one and the buffer is dropped rather than grown to the image ceiling.
    const documentChunks: Buffer[] = [];
    let document = true;
    let sniffed = 0;
    let length = 0;
    let closed = false;
    try {
      while (true) {
        const part = await raceAbort(reader.read(), operation.signal);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > ceiling) {
          void reader.cancel().catch(() => undefined);
          fail("asset-too-large");
        }
        const take = Math.min(sniff.length - sniffed, part.value.byteLength);
        if (take > 0) {
          sniff.set(part.value.subarray(0, take), sniffed);
          sniffed += take;
        }
        if (document) {
          if (length > MAX_PRODUCTION_GATEWAY_UPLOAD_DOCUMENT_BYTES) {
            documentChunks.length = 0;
            document = false;
          } else {
            documentChunks.push(Buffer.from(part.value));
          }
        }
        hash.update(part.value);
        await writeAll(temporary.handle, part.value);
        if (operation.signal.aborted) fail("aborted");
      }
      if (length < 1 || (declared !== null && declared !== length)) fail("bad-request");
      // Identity before admission: a body that is not the named object never reaches the store, so a
      // rejected upload leaves the digest exactly as unresolvable as it was.
      if (hash.digest("hex") !== digest) fail("bad-request");
      const sniffedMediaType = sniffMediaType(sniff.subarray(0, sniffed));
      let mediaType: string;
      if (sniffedMediaType !== null) {
        // Only staging inputs travel this way. A video or audio object is a provider output and
        // reaches the store through the ingest kernel, which records its provenance.
        if (!sniffedMediaType.startsWith("image/")) fail("unsupported-media");
        if (length > this.#maxUploadImageBytes) fail("asset-too-large");
        mediaType = sniffedMediaType;
      } else {
        // No magic number: the only other admissible object is the ShotRequest document, and past
        // its ceiling there is nothing left it could be.
        if (!document) fail("asset-too-large");
        if (!readShotRequestDocument(Buffer.concat(documentChunks, length)).ok) fail("unsupported-media");
        mediaType = SHOT_REQUEST_MEDIA_TYPE;
      }
      await temporary.handle.sync();
      requireActive(operation.signal);
      await temporary.handle.chmod(0o400);
      await temporary.handle.close();
      closed = true;
      // A digest already holding different bytes is a corrupted store, not a losable race: content
      // addressing makes it unreachable through this route, and it is still refused rather than
      // overwritten.
      await this.#publishBlob(temporary.path, digest, length, operation.signal, "conflict");
      requireActive(operation.signal);
      const metadata: AssetMetadata = {
        version: 1,
        uri: `urn:sha256:${digest}`,
        sha256: digest,
        byteLength: length,
        mediaType,
      };
      await this.#publishMetadata(metadata, operation.signal);
      requireActive(operation.signal);
      await this.#publishOwnership(scope, metadata, operation.signal);
      // Identical for a first publication and for a replay: the object is its bytes, and the route
      // has no other outcome to report.
      return jsonResponse({ version: 1, sha256: digest, byteLength: length, mediaType });
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (!closed) await temporary.handle.close().catch(() => undefined);
      await unlink(temporary.path).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async #openAsset(
    scope: ProductionIngestScope,
    digest: string,
    signal: AbortSignal,
  ): Promise<OpenAsset> {
    if (!SHA256.test(digest)) fail("not-found");
    await this.#verifyRoot();
    // Authorization is claim-first: an unowned known digest must not even touch global metadata/blob.
    const ownership = await this.#loadOwnership(scope, digest, signal);
    if (!ownership) fail("not-found");
    const metadataPath = join(this.#directories.metadata, digest.slice(0, 2), `${digest}.json`);
    let metadata: AssetMetadata;
    try { metadata = parseAssetMetadata(await readExactSafeJson(metadataPath, 16 * 1024, signal), digest); }
    catch (error) {
      if (isNodeError(error, "ENOENT")) fail("not-found");
      throw error;
    }
    if (JSON.stringify(metadata) !== JSON.stringify(ownership.asset)) fail("internal");
    const blobPath = join(this.#directories.blobs, digest.slice(0, 2), digest);
    let pathInfo: Awaited<ReturnType<typeof lstat>>;
    let handle: FileHandle;
    try {
      pathInfo = await lstat(blobPath, { bigint: true });
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
        || pathInfo.size !== BigInt(metadata.byteLength)) fail("internal");
      handle = await open(blobPath, READ_FLAGS);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) fail("not-found");
      throw error;
    }
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(blobPath, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathInfo, opened) || !sameFile(opened, after)
      || opened.size !== BigInt(metadata.byteLength)) {
      await handle.close();
      fail("internal");
    }
    return { handle, metadata };
  }

  async #assetResponse(
    scope: ProductionIngestScope,
    digest: string,
    operation: Operation,
  ): Promise<Response> {
    const asset = await this.#openAsset(scope, digest, operation.signal);
    const nodeStream = asset.handle.createReadStream({
      autoClose: true,
      emitClose: true,
      start: 0,
      end: asset.metadata.byteLength - 1,
    });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      operation.finish();
    };
    nodeStream.once("close", finish);
    nodeStream.once("error", finish);
    operation.signal.addEventListener("abort", () => nodeStream.destroy(new Error("aborted")), { once: true });
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-length": String(asset.metadata.byteLength),
        "content-type": asset.metadata.mediaType,
        etag: `\"sha256:${digest}\"`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  /**
   * Existence probe on the same URL the object is read from, so a caller that gets 200 here and a
   * caller that GETs the object are answering the same question (§6.4: the worker asks before it
   * decides to upload). It opens the asset exactly as GET does and then closes it, rather than
   * testing for a file: a blob without its scope claim or its metadata is not a resolvable object.
   */
  async #assetHead(
    scope: ProductionIngestScope,
    digest: string,
    operation: Operation,
  ): Promise<Response> {
    const asset = await this.#openAsset(scope, digest, operation.signal);
    await asset.handle.close();
    return new Response(null, {
      status: 200,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-length": String(asset.metadata.byteLength),
        "content-type": asset.metadata.mediaType,
        etag: `\"sha256:${digest}\"`,
        "x-content-type-options": "nosniff",
      },
    });
  }

  /** Handle one Fetch-compatible private request; useful both in tests and non-Node hosts. */
  async handle(request: Request): Promise<Response> {
    let operation: Operation | null = null;
    let deferredFinish = false;
    // Node's HTTP server drops a HEAD response body on its own; strip it here too so the in-process
    // Fetch boundary answers a HEAD identically to the socket.
    const answer = (response: Response): Response => request.method !== "HEAD"
      ? response
      : new Response(null, { status: response.status, headers: response.headers });
    try {
      const route = parseGatewayRoute(new URL(request.url), request.method);
      operation = this.#operation(request.signal);
      await this.#verifyRoot();
      const credentialContext: ProductionGatewayCredentialContext = {
        workspaceId: route.scope.workspaceId,
        project: route.scope.project,
        operation: route.kind === "ingest"
          ? "ingest"
          : route.kind === "asset-upload" ? "asset-write" : "asset-read",
      };
      await this.#authorize(request, credentialContext, operation);
      if (route.kind === "ingest") {
        return await this.#ingest(request, route.scope, route.ingestKey, operation);
      }
      if (route.kind === "asset-upload") {
        return await this.#uploadAsset(request, route.scope, route.digest, operation);
      }
      if (route.kind === "asset-head") {
        return answer(await this.#assetHead(route.scope, route.digest, operation));
      }
      if (route.kind === "asset") {
        const response = await this.#assetResponse(route.scope, route.digest, operation);
        deferredFinish = true;
        return response;
      }
      throw new ProductionGatewayError("not-found");
    } catch (error) {
      if (error instanceof ProductionGatewayError) return answer(errorResponse(error));
      if (operation?.signal.aborted) return answer(errorResponse(new ProductionGatewayError("aborted")));
      return answer(errorResponse(new ProductionGatewayError("internal")));
    } finally {
      if (!deferredFinish) operation?.finish();
    }
  }

  /** Abort active request/provider streams and reject all future work. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown.abort(new Error("shutdown"));
    for (const controller of this.#active) controller.abort(new Error("shutdown"));
  }
}

export const DEFAULT_PRODUCTION_LAST_FRAME_BYTES = 64 * 1024 * 1024;

export type ProductionFfmpegLastFrameOptions = {
  /** Absolute path or bare program name resolved through PATH. Never taken from a request. */
  ffmpegPath?: string;
  /** Directory for the single temporary PNG. Defaults to the OS temporary directory. */
  temporaryRoot?: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
};

/**
 * Default tail-frame extractor: one fixed `ffmpeg` argv over two server-owned paths. `-update 1`
 * rewrites the same output file for every decoded frame, so what remains is exactly the last frame;
 * no seek arithmetic is involved and a one-frame clip behaves the same as a long one. Nothing in the
 * argv comes from a request — only the input blob path the kernel chose and the temporary output.
 */
export function productionFfmpegLastFrameExtractor(
  options: ProductionFfmpegLastFrameOptions = {},
): ProductionLastFrameExtractor {
  const program = options.ffmpegPath ?? "ffmpeg";
  if (typeof program !== "string" || program.length < 1 || /[\u0000-\u001f\u007f]/.test(program)) {
    throw new TypeError("production gateway ffmpeg path invalid");
  }
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_PRODUCTION_LAST_FRAME_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000
    || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1_024) {
    throw new TypeError("production gateway ffmpeg limits invalid");
  }
  return async (input, signal) => {
    const directory = await mkdtemp(join(temporaryRoot, "wl-last-frame-"));
    const output = join(directory, "last-frame.png");
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = execFile(program, [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-i", input.videoPath,
          "-an", "-update", "1", "-f", "image2", "-c:v", "png",
          output,
        ], { timeout: timeoutMs, maxBuffer: 64 * 1024, signal }, (error) => {
          if (error) reject(error);
          else resolvePromise();
        });
        child.stdin?.end();
      });
      const info = await lstat(output);
      if (!info.isFile() || info.size < 1 || info.size > maxFrameBytes) {
        throw new Error("ffmpeg produced no usable tail frame");
      }
      return await readFile(output);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/**
 * Assembly-time proof that the configured ffmpeg exists and runs. It is a fixed `-version` call with
 * no input path, so it cannot touch a store; a deployment that fails it would otherwise fail every
 * ingest at the moment a take is already paid for.
 */
export async function probeProductionFfmpeg(
  options: ProductionFfmpegLastFrameOptions = {},
): Promise<string> {
  const program = options.ffmpegPath ?? "ffmpeg";
  if (typeof program !== "string" || program.length < 1 || /[\u0000-\u001f\u007f]/.test(program)) {
    throw new TypeError("production gateway ffmpeg path invalid");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise<string>((resolvePromise, reject) => {
    const child = execFile(program, ["-hide_banner", "-version"], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(String(stdout).split("\n", 1)[0]!.trim());
    });
    child.stdin?.end();
  });
}

async function sendNodeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  if (!response.body) {
    target.end();
    return;
  }
  const body = Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>);
  await new Promise<void>((resolvePromise) => {
    const done = (): void => resolvePromise();
    target.once("close", done);
    target.once("finish", done);
    body.once("error", () => target.destroy());
    body.pipe(target);
  });
}

function nodeRequest(request: IncomingMessage, address: ProductionGatewayAddress): Request {
  const rawPath = request.url ?? "/";
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) fail("bad-request");
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else headers.set(key, value);
  }
  const method = request.method ?? "GET";
  const controller = new AbortController();
  request.once("aborted", () => controller.abort(new Error("client-aborted")));
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(request) as globalThis.ReadableStream<Uint8Array>;
  const host = isIP(address.host) === 6 ? `[${address.host}]` : address.host;
  return new Request(`http://${host}:${address.port}${rawPath}`, {
    method,
    headers,
    body,
    signal: controller.signal,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Start the deployable Node HTTP boundary on a literal loopback/private IP only. */
export async function startProductionGateway(options: ProductionGatewayOptions): Promise<ProductionGatewayServer> {
  const gateway = await ProductionGateway.create(options);
  let server: Server | null = null;
  try {
    const pendingAddress: ProductionGatewayAddress = { host: gateway.bindHost, port: gateway.bindPort };
    server = createServer((incoming, outgoing) => {
      const safelySend = (response: Response): void => {
        void sendNodeResponse(response, outgoing).catch(() => {
          if (!outgoing.destroyed) outgoing.destroy();
        });
      };
      let request: Request;
      try { request = nodeRequest(incoming, pendingAddress); }
      catch (error) {
        safelySend(errorResponse(error instanceof ProductionGatewayError
          ? error : new ProductionGatewayError("bad-request")));
        return;
      }
      void gateway.handle(request).then(
        safelySend,
        () => safelySend(errorResponse(new ProductionGatewayError("internal"))),
      );
    });
    await new Promise<void>((resolvePromise, reject) => {
      server!.once("error", reject);
      server!.listen(gateway.bindPort, gateway.bindHost, () => {
        server!.removeListener("error", reject);
        resolvePromise();
      });
    });
    const actual = server.address();
    if (!actual || typeof actual === "string") fail("internal");
    const address = { host: gateway.bindHost, port: actual.port };
    pendingAddress.port = actual.port;
    let closed = false;
    return {
      gateway,
      address,
      close: async () => {
        if (closed) return;
        closed = true;
        gateway.close();
        server!.closeAllConnections();
        await new Promise<void>((resolvePromise) => server!.close(() => resolvePromise()));
      },
    };
  } catch (error) {
    gateway.close();
    server?.closeAllConnections();
    server?.close();
    throw error;
  }
}
