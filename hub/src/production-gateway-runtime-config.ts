// Trusted server-owned registry for the private production gateway process (§4.2, §8.2).
//
// This module must never be imported by Studio/browser bundles or by the worker: it owns the raw
// ComfyUI origin, the execution-profile originals with their price tables, the CAS authority and
// the durable roots on the GPU VM's persistent boot disk. The worker only ever references a
// `profileId` plus the digests it already pins in its own runtime config; the read-only snapshot
// exported here is the single price/duration source it is allowed to read (§4.2).
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  hasSymlinkComponent,
  readRegularTextExact,
  type ExactReadHooks,
} from "./bounded-fs.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import {
  ProductionH3GraphError,
  assertProductionH3Template,
  parseProductionH3GraphContract,
  parseProductionH3StageBindingContract,
  productionH3WorkflowSha256,
  type ProductionH3GraphContract,
  type ProductionH3StageBindingContract,
} from "./production-h3-graph.ts";
import {
  parseProductionIntentExecution,
  parseProductionLicenseEvidence,
  parseProductionProcessingRegions,
  type ProductionIntentExecution,
  type ProductionLicenseEvidence,
} from "./production-intent.ts";
import {
  PRODUCTION_STAGE_ALLOWED_MEDIA_TYPES,
  productionStageSlotPairingViolation,
} from "./production-stage-gateway.ts";
import { PRODUCTION_SHOT_REQUEST_SLOT } from "./production-input-stager.ts";
import { SHOT_REQUEST_MEDIA_TYPE } from "./production-shot-request.ts";
import {
  h3LimitsByProfileId,
  type ComfyUiH3ProfileCapability,
  type VideoBackendLimits,
} from "./production-adapter.ts";
import { parseVideoBackendLimits } from "./production-provider-adapter.ts";
import {
  parseShotExecutionProfile,
  type ShotExecutionProfile,
} from "./production-shot-request.ts";

export const PRODUCTION_GATEWAY_RUNTIME_CONFIG_VERSION = 1;
export const DEFAULT_PRODUCTION_GATEWAY_CONFIG_BYTES = 1024 * 1024;
export const DEFAULT_PRODUCTION_GATEWAY_WORKFLOW_BYTES = 4 * 1024 * 1024;
/** v1 binds one raw adapter per process; the bound stays for a future multi-adapter kernel. */
export const MAX_PRODUCTION_GATEWAY_BACKENDS = 16;
export const MAX_PRODUCTION_GATEWAY_EXECUTION_PROFILES = 128;
export const MAX_PRODUCTION_GATEWAY_STAGE_PROFILES = 128;

/** Stable, persistence-safe categories. Raw paths, credentials and causes never reach the caller. */
export type ProductionGatewayRuntimeConfigErrorCode =
  | "config-unreadable"
  | "config-invalid-json"
  | "config-invalid-schema"
  | "workflow-unreadable"
  | "workflow-invalid"
  | "credential-unavailable";

export class ProductionGatewayRuntimeConfigError extends Error {
  readonly code: ProductionGatewayRuntimeConfigErrorCode;

  constructor(code: ProductionGatewayRuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = "ProductionGatewayRuntimeConfigError";
    this.code = code;
  }
}

export type ProductionGatewayListenConfig = Readonly<{
  version: 1;
  /** Literal RFC1918 IPv4 or 127.0.0.1. Wildcards, public addresses and names are rejected. */
  host: string;
  /** 0 asks the kernel for an ephemeral port; deployments pin a fixed port. */
  port: number;
}>;

export type ProductionGatewayAuthConfig = Readonly<{
  version: 1;
  /** Environment variable name only. The static bearer value never enters the config file. */
  bearerEnv: string;
}>;

export type ProductionGatewayBackendConfig = Readonly<{
  version: 1;
  backendInstanceId: string;
  kind: "comfyui";
  /** Loopback plaintext only: ComfyUI runs on the same host as the gateway process (§8.0). */
  comfyBaseUrl: string;
  /**
   * §4.3 `maxInputImageBytes`. A self-hosted backend has no provider-side image ceiling to quote,
   * only a deployment declaration, so the registry owns it and the adapter never invents one.
   */
  maxInputImageBytes: number;
  profileIds: readonly string[];
}>;

/**
 * Tariff price table (§4.6). `tariff` is the only basis a v1 H3 profile can declare; the
 * `reported` / `reported-converted` bases arrive with the cloud adapters (Phase 3).
 */
export type ProductionGatewayPriceTable = Readonly<{
  version: 1;
  basis: "tariff";
  currency: "USD";
  microsPerOutputSecond: number;
  priceAsOf: string;
  source: string;
}> | null;

/**
 * Profile-level licence evidence. `ProductionLicenseEvidence.obligations` is the single home for
 * attribution / revenue-threshold / no-model-improvement duties (§4.2, 0-C); the execution profile
 * itself carries no licence field, so the registry and the intent gate share one judge.
 */
export type ProductionGatewayLicenseConfig = ProductionLicenseEvidence;

export type ProductionGatewayExecutionProfileConfig = Readonly<{
  version: 1;
  /** §4.2 execution profile original; the worker only holds `profileId` plus these digests. */
  execution: ShotExecutionProfile;
  /** Intent-level execution derived from the profile; it drives the job/stage kernel identity. */
  intentExecution: ProductionIntentExecution;
  /** Relative to the registry config file; resolution rules mirror `workflows[].file`. */
  workflowFile: string;
  stageProfileId: string;
  h3GraphContract: ProductionH3GraphContract;
  priceTable: ProductionGatewayPriceTable;
  license: ProductionGatewayLicenseConfig;
  /** ISO-3166 alpha-2 regions the backend actually processes in (§4.3). */
  processingRegions: readonly string[];
}>;

export type ProductionGatewayStageProfileInputConfig = Readonly<{
  version: 1;
  index: number;
  slot: string;
  mediaTypes: readonly string[];
}>;

export type ProductionGatewayStageProfileConfig = Readonly<{
  version: 1;
  stageProfileId: string;
  /** Trusted provider-local namespace; object suffixes are always derived from sha256. */
  providerCasNamespace: string;
  inputs: readonly ProductionGatewayStageProfileInputConfig[];
  bindings: readonly ProductionH3StageBindingContract[];
}>;

export type ProductionGatewayAdmissionConfig = Readonly<{
  version: 1;
  maxConcurrentPerBackend: number;
}>;

/**
 * Declarative restart policy for the Spot-preemptible GPU VM (§7). This module only parses it and
 * makes it readable on the config object; no kernel here consumes it, because the reconcile pass
 * that acts on it is worker-side (`production-reconcile.ts`) and the gateway never rewrites a ledger.
 */
export type ProductionGatewayReconcilePolicyConfig = Readonly<{
  version: 1;
  /** Restart verdict for a job record still pending/running that the provider no longer knows. */
  unknownRemoteJob: "provider-failed-preempted" | "orphaned";
  /** Minimum age before that verdict may be taken, so a slow provider is not mislabelled. */
  minObservationAgeSeconds: number;
}>;

export type ProductionGatewayRuntimeConfig = Readonly<{
  version: 1;
  listen: ProductionGatewayListenConfig;
  auth: ProductionGatewayAuthConfig;
  backends: readonly ProductionGatewayBackendConfig[];
  executionProfiles: readonly ProductionGatewayExecutionProfileConfig[];
  stageProfiles: readonly ProductionGatewayStageProfileConfig[];
  /** `cas://<authority>/sha256/<digest>` authority accepted by the stage asset resolver (§4.1). */
  casAuthority: string;
  /** Stage kernel durable root; ComfyUI reads `<objectsRoot>/objects/<namespace>/<sha256>`. */
  objectsRoot: string;
  /** Ingest kernel durable root: CAS blobs, ownership and receipts. */
  ingestRoot: string;
  /** Jobs kernel durable root: immutable job records and submission outboxes. */
  jobStateRoot: string;
  admission: ProductionGatewayAdmissionConfig;
  reconcilePolicy: ProductionGatewayReconcilePolicyConfig;
}>;

export const PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND = "writing-loop/execution-profile-snapshot";

export type ProductionExecutionProfileSnapshotEntry = Readonly<{
  version: 1;
  profileId: string;
  /** sha256 of the canonical profile document below; drift makes the worker refuse to plan. */
  profileDigest: string;
  execution: ShotExecutionProfile;
  /** H3 duration grid = the configured profile set for one output shape (§5.3). */
  durationGrid: readonly number[];
  /**
   * §4.3 limits for this profile, derived from the same function the backend adapter's
   * `capabilities()` uses, so `limits.durationSeconds.grid` and `durationGrid` cannot drift apart.
   */
  limits: VideoBackendLimits;
  priceTable: ProductionGatewayPriceTable;
  license: ProductionGatewayLicenseConfig;
  processingRegions: readonly string[];
}>;

export type ProductionExecutionProfileSnapshot = Readonly<{
  version: 1;
  kind: typeof PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND;
  casAuthority: string;
  profiles: readonly ProductionExecutionProfileSnapshotEntry[];
}>;

export type LoadProductionGatewayRuntimeConfigOptions = {
  maxConfigBytes?: number;
  /** Test seam inherited from the exact bounded reader. */
  readHooks?: ExactReadHooks;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SAFE_SLOT = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){1,7}$/;
const CAS_AUTHORITY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function schemaError(subject: string, detail: string): never {
  throw new ProductionGatewayRuntimeConfigError("config-invalid-schema", `${subject} ${detail}`);
}

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) schemaError(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], subject: string): void {
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extras = keys.filter((key) => !expected.includes(key));
  if (missing.length || extras.length) {
    schemaError(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
}

function version(value: unknown, subject: string): void {
  if (value !== PRODUCTION_GATEWAY_RUNTIME_CONFIG_VERSION) schemaError(subject, "version 必须是 1");
}

function boundedInteger(value: unknown, minimum: number, maximum: number, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    schemaError(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function safeString(value: unknown, pattern: RegExp, subject: string): string {
  if (typeof value !== "string" || !fullMatch(pattern, value)) schemaError(subject, "格式无效");
  return value;
}

function boundedArray(value: unknown, minimum: number, maximum: number, subject: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    schemaError(subject, `必须是长度 ${minimum}–${maximum} 的数组`);
  }
  return value;
}

function isoTimestamp(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) schemaError(subject, "必须是 ISO-8601 UTC 时间串");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    schemaError(subject, "必须是规范 UTC ISO-8601 时间串");
  }
  return value;
}

/**
 * RFC1918 IPv4 or the loopback literal, written as a literal address. WHATWG URL canonicalises
 * numeric hosts, so a decimal-dotted match here also covers octal/hex spellings, while every domain
 * name — which could resolve anywhere — stays outside the accepted set.
 */
function isPrivateIpv4Literal(hostname: string): boolean {
  if (hostname === "127.0.0.1") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4
    || !octets.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) {
    return false;
  }
  const [first, second] = octets.map(Number) as [number, number, number, number];
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function parseListen(value: unknown): ProductionGatewayListenConfig {
  const subject = "ProductionGatewayRuntimeConfig.listen";
  const row = record(value, subject);
  exactKeys(row, ["version", "host", "port"], subject);
  version(row.version, subject);
  if (typeof row.host !== "string" || !isPrivateIpv4Literal(row.host)) {
    // 0.0.0.0/:: 与公网地址会把三个内核暴露到 VPC 之外；域名可能解析到任何地方。
    schemaError(`${subject}.host`, "必须是 RFC1918 私网 IPv4 或 127.0.0.1 字面地址");
  }
  return Object.freeze({
    version: 1 as const,
    host: row.host,
    port: boundedInteger(row.port, 0, 65_535, `${subject}.port`),
  });
}

function parseAuth(value: unknown): ProductionGatewayAuthConfig {
  const subject = "ProductionGatewayRuntimeConfig.auth";
  const row = record(value, subject);
  exactKeys(row, ["version", "bearerEnv"], subject);
  version(row.version, subject);
  return Object.freeze({
    version: 1 as const,
    bearerEnv: safeString(row.bearerEnv, SAFE_ENV, `${subject}.bearerEnv`),
  });
}

function loopbackComfyUrl(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    schemaError(subject, "必须是有界 URL 字符串");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { schemaError(subject, "必须是有效 http URL"); }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    schemaError(subject, "只接受不含 credential、query、fragment 的 http URL");
  }
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1).toLowerCase()
    : url.hostname.toLowerCase();
  const loopbackIpv4 = host.split(".").length === 4
    && host.split(".").every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(host.split(".")[0]) === 127;
  if (!loopbackIpv4 && host !== "::1") {
    schemaError(subject, "ComfyUI 必须与 gateway 同机，只接受 literal loopback 地址");
  }
  if (!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(url.pathname) || url.pathname.length > 512) {
    schemaError(subject, "path 必须是固定的安全 path segment 序列");
  }
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function parseBackend(value: unknown, index: number): ProductionGatewayBackendConfig {
  const subject = `ProductionGatewayRuntimeConfig.backends[${index}]`;
  const row = record(value, subject);
  exactKeys(row, [
    "version", "backendInstanceId", "kind", "comfyBaseUrl", "maxInputImageBytes", "profileIds",
  ], subject);
  version(row.version, subject);
  if (row.kind !== "comfyui") {
    // 云 backend kind 随 Ark / Vertex adapter 进入（Phase 3 / Phase 4）。
    schemaError(`${subject}.kind`, "v1 只支持 comfyui backend");
  }
  const profileIds = boundedArray(row.profileIds, 1, MAX_PRODUCTION_GATEWAY_EXECUTION_PROFILES, `${subject}.profileIds`)
    .map((entry, position) => safeString(entry, SAFE_PROFILE_ID, `${subject}.profileIds[${position}]`));
  if (new Set(profileIds).size !== profileIds.length) {
    schemaError(`${subject}.profileIds`, "不得包含重复 profileId");
  }
  return Object.freeze({
    version: 1 as const,
    backendInstanceId: safeString(row.backendInstanceId, SAFE_ID, `${subject}.backendInstanceId`),
    kind: "comfyui" as const,
    comfyBaseUrl: loopbackComfyUrl(row.comfyBaseUrl, `${subject}.comfyBaseUrl`),
    maxInputImageBytes: boundedInteger(
      row.maxInputImageBytes, 1_024, 4 * 1024 * 1024 * 1024, `${subject}.maxInputImageBytes`,
    ),
    profileIds: Object.freeze(profileIds),
  });
}

function relativeConfigFile(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || isAbsolute(value)
    || value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) {
    schemaError(subject, "必须是有界、无控制字符的相对 POSIX 路径");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    schemaError(subject, "不得包含空段、. 或 ..");
  }
  return value;
}

function absoluteRoot(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || !isAbsolute(value)
    || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) {
    schemaError(subject, "必须是有界、无控制字符的绝对路径");
  }
  if (value.split(sep).some((part) => part === "..")) schemaError(subject, "不得包含 .. 段");
  return resolve(value);
}

function parsePriceTable(value: unknown, subject: string): ProductionGatewayPriceTable {
  if (value === null) return null;
  const row = record(value, subject);
  exactKeys(row, ["version", "basis", "currency", "microsPerOutputSecond", "priceAsOf", "source"], subject);
  version(row.version, subject);
  if (row.basis !== "tariff") {
    // reported / reported-converted 的二维价目随云 adapter 进入（Phase 3）。
    schemaError(`${subject}.basis`, "v1 只支持 tariff 价目");
  }
  if (row.currency !== "USD") schemaError(`${subject}.currency`, "必须是 USD");
  return Object.freeze({
    version: 1 as const,
    basis: "tariff" as const,
    currency: "USD" as const,
    microsPerOutputSecond: boundedInteger(
      row.microsPerOutputSecond, 1, Number.MAX_SAFE_INTEGER, `${subject}.microsPerOutputSecond`,
    ),
    priceAsOf: isoTimestamp(row.priceAsOf, `${subject}.priceAsOf`),
    source: safeString(row.source, SAFE_TEXT, `${subject}.source`),
  });
}

function parseLicense(value: unknown, subject: string): ProductionGatewayLicenseConfig {
  try { return Object.freeze(parseProductionLicenseEvidence(value, subject)); }
  catch (error) {
    schemaError(subject, error instanceof Error ? error.message : "license evidence 无效");
  }
}

/**
 * The intent-level execution is derived rather than configured twice: it is exactly the subset of
 * the §4.2 execution profile that `workflowBindingKey` and the stage/job kernels compare.
 */
function intentExecutionFromProfile(
  profile: ShotExecutionProfile,
  subject: string,
): ProductionIntentExecution {
  if (profile.modelFamily !== "minimax-h3") {
    schemaError(`${subject}.modelFamily`, "v1 gateway registry 只承载 minimax-h3 execution profile");
  }
  try {
    return parseProductionIntentExecution({
      version: 1,
      operation: profile.operation,
      modelFamily: "minimax-h3",
      backendInstanceId: profile.backendInstanceId,
      workflowSha256: profile.workflowSha256,
      modelSha256: profile.modelSha256,
      parametersSha256: profile.parametersSha256,
      variant: profile.variant,
      durationSeconds: profile.durationSeconds,
      shortEdge: profile.shortEdge,
      aspectRatio: profile.aspectRatio,
    }, `${subject}.execution`);
  } catch (error) {
    schemaError(`${subject}.execution`, error instanceof Error ? error.message : "无法导出 intent execution");
  }
}

function parseExecutionProfile(value: unknown, index: number): ProductionGatewayExecutionProfileConfig {
  const subject = `ProductionGatewayRuntimeConfig.executionProfiles[${index}]`;
  const row = record(value, subject);
  exactKeys(row, [
    "version", "execution", "workflowFile", "stageProfileId", "h3GraphContract", "priceTable",
    "license", "processingRegions",
  ], subject);
  version(row.version, subject);
  let execution: ShotExecutionProfile;
  try { execution = parseShotExecutionProfile(row.execution, `${subject}.execution`); }
  catch (error) {
    schemaError(`${subject}.execution`, error instanceof Error ? error.message : "execution profile 无效");
  }
  let h3GraphContract: ProductionH3GraphContract;
  try { h3GraphContract = parseProductionH3GraphContract(row.h3GraphContract); }
  catch (error) {
    if (error instanceof ProductionH3GraphError) schemaError(`${subject}.h3GraphContract`, error.message);
    throw error;
  }
  // 与 worker 侧同一份解析：去重、升序、拒绝 EU / UK 这类集合别名。排序一致才使两边算出的
  // profile digest 相等（§4.2），因此不能在这里保留配置里的原始顺序。
  boundedArray(row.processingRegions, 1, 64, `${subject}.processingRegions`);
  let regions: string[];
  try { regions = parseProductionProcessingRegions(row.processingRegions, `${subject}.processingRegions`); }
  catch (error) {
    schemaError(`${subject}.processingRegions`, error instanceof Error ? error.message : "处理地域无效");
  }
  return Object.freeze({
    version: 1 as const,
    execution,
    intentExecution: intentExecutionFromProfile(execution, subject),
    workflowFile: relativeConfigFile(row.workflowFile, `${subject}.workflowFile`),
    stageProfileId: safeString(row.stageProfileId, SAFE_PROFILE_ID, `${subject}.stageProfileId`),
    h3GraphContract,
    priceTable: parsePriceTable(row.priceTable, `${subject}.priceTable`),
    license: parseLicense(row.license, `${subject}.license`),
    processingRegions: Object.freeze(regions),
  });
}

function parseStageProfileInput(
  value: unknown,
  index: number,
  subject: string,
): ProductionGatewayStageProfileInputConfig {
  const row = record(value, subject);
  exactKeys(row, ["version", "index", "slot", "mediaTypes"], subject);
  version(row.version, subject);
  if (row.index !== index) schemaError(`${subject}.index`, "必须与数组序号一致");
  // Same bound, allowlist, uniqueness and ascending order the stage kernel's `parseProfileInput`
  // enforces at request time: a profile that would 500 every stage PUT is refused at assembly.
  const mediaTypes = boundedArray(row.mediaTypes, 1, 32, `${subject}.mediaTypes`)
    .map((entry, position) => {
      const mediaType = safeString(entry, SAFE_MEDIA_TYPE, `${subject}.mediaTypes[${position}]`);
      if (!PRODUCTION_STAGE_ALLOWED_MEDIA_TYPES.has(mediaType)) {
        schemaError(`${subject}.mediaTypes[${position}]`, `不在 stage kernel 允许的 media type 集合内：${mediaType}`);
      }
      return mediaType;
    });
  if (new Set(mediaTypes).size !== mediaTypes.length) {
    schemaError(`${subject}.mediaTypes`, "不得包含重复 media type");
  }
  const sorted = [...mediaTypes].sort();
  if (mediaTypes.some((mediaType, position) => mediaType !== sorted[position])) {
    schemaError(`${subject}.mediaTypes`, "必须按字典序升序排列");
  }
  const slot = safeString(row.slot, SAFE_SLOT, `${subject}.slot`);
  // Same `shot-request` slot ⇔ media type pairing the stage kernel enforces per request, so a
  // profile that would be refused at request time is refused while the process is still assembling.
  const pairing = productionStageSlotPairingViolation(slot, mediaTypes);
  if (pairing !== null) schemaError(subject, pairing);
  if ((slot === PRODUCTION_SHOT_REQUEST_SLOT) !== (index === 0 && mediaTypes.length === 1
    && mediaTypes[0] === SHOT_REQUEST_MEDIA_TYPE)) {
    schemaError(subject, `${PRODUCTION_SHOT_REQUEST_SLOT} 只能是 inputs[0]（§6.5 固定输入顺序）`);
  }
  return Object.freeze({
    version: 1 as const,
    index,
    slot,
    mediaTypes: Object.freeze(mediaTypes),
  });
}

function parseStageProfile(value: unknown, index: number): ProductionGatewayStageProfileConfig {
  const subject = `ProductionGatewayRuntimeConfig.stageProfiles[${index}]`;
  const row = record(value, subject);
  exactKeys(row, ["version", "stageProfileId", "providerCasNamespace", "inputs", "bindings"], subject);
  version(row.version, subject);
  const namespace = safeString(row.providerCasNamespace, SAFE_NAMESPACE, `${subject}.providerCasNamespace`);
  if (!namespace.endsWith("/sha256")) {
    schemaError(`${subject}.providerCasNamespace`, "必须以 /sha256 结尾");
  }
  const inputs = boundedArray(row.inputs, 1, 32, `${subject}.inputs`)
    .map((entry, position) => parseStageProfileInput(entry, position, `${subject}.inputs[${position}]`));
  if (new Set(inputs.map((input) => input.slot)).size !== inputs.length) {
    schemaError(`${subject}.inputs`, "slot 必须唯一");
  }
  let bindings: readonly ProductionH3StageBindingContract[];
  try {
    bindings = Object.freeze(boundedArray(row.bindings, 1, 32, `${subject}.bindings`)
      .map((entry, position) => parseProductionH3StageBindingContract(entry, position)));
  } catch (error) {
    if (error instanceof ProductionH3GraphError) schemaError(`${subject}.bindings`, error.message);
    throw error;
  }
  if (bindings.length !== inputs.length
    || bindings.some((binding, position) => binding.slot !== inputs[position]!.slot)) {
    schemaError(`${subject}.bindings`, "index/slot 必须与 inputs 逐位一致");
  }
  return Object.freeze({
    version: 1 as const,
    stageProfileId: safeString(row.stageProfileId, SAFE_PROFILE_ID, `${subject}.stageProfileId`),
    providerCasNamespace: namespace,
    inputs: Object.freeze(inputs),
    bindings,
  });
}

function parseAdmission(value: unknown): ProductionGatewayAdmissionConfig {
  const subject = "ProductionGatewayRuntimeConfig.admission";
  const row = record(value, subject);
  exactKeys(row, ["version", "maxConcurrentPerBackend"], subject);
  version(row.version, subject);
  return Object.freeze({
    version: 1 as const,
    maxConcurrentPerBackend: boundedInteger(
      row.maxConcurrentPerBackend, 1, 256, `${subject}.maxConcurrentPerBackend`,
    ),
  });
}

function parseReconcilePolicy(value: unknown): ProductionGatewayReconcilePolicyConfig {
  const subject = "ProductionGatewayRuntimeConfig.reconcilePolicy";
  const row = record(value, subject);
  exactKeys(row, ["version", "unknownRemoteJob", "minObservationAgeSeconds"], subject);
  version(row.version, subject);
  if (row.unknownRemoteJob !== "provider-failed-preempted" && row.unknownRemoteJob !== "orphaned") {
    schemaError(`${subject}.unknownRemoteJob`, "必须是 provider-failed-preempted 或 orphaned");
  }
  return Object.freeze({
    version: 1 as const,
    unknownRemoteJob: row.unknownRemoteJob,
    minObservationAgeSeconds: boundedInteger(
      row.minObservationAgeSeconds, 0, 86_400, `${subject}.minObservationAgeSeconds`,
    ),
  });
}

export function parseProductionGatewayRuntimeConfig(value: unknown): ProductionGatewayRuntimeConfig {
  const subject = "ProductionGatewayRuntimeConfig";
  const row = record(value, subject);
  exactKeys(row, [
    "version", "listen", "auth", "backends", "executionProfiles", "stageProfiles", "casAuthority",
    "objectsRoot", "ingestRoot", "jobStateRoot", "admission", "reconcilePolicy",
  ], subject);
  version(row.version, subject);

  const backends = boundedArray(row.backends, 1, MAX_PRODUCTION_GATEWAY_BACKENDS, `${subject}.backends`)
    .map(parseBackend);
  if (new Set(backends.map((backend) => backend.backendInstanceId)).size !== backends.length) {
    schemaError(`${subject}.backends`, "backendInstanceId 必须唯一");
  }
  if (backends.length !== 1) {
    // The jobs kernel binds exactly one raw adapter, and §8.0 puts one gateway instance next to one
    // ComfyUI. A second backend needs its own process, not a silently shared adapter.
    schemaError(`${subject}.backends`, "v1 gateway 进程只装配单一 backend；多 backend 需要独立实例");
  }
  const executionProfiles = boundedArray(
    row.executionProfiles, 1, MAX_PRODUCTION_GATEWAY_EXECUTION_PROFILES, `${subject}.executionProfiles`,
  ).map(parseExecutionProfile);
  const profileById = new Map(executionProfiles.map((profile) => [profile.execution.profileId, profile] as const));
  if (profileById.size !== executionProfiles.length) {
    schemaError(`${subject}.executionProfiles`, "profileId 必须唯一");
  }
  const stageProfiles = boundedArray(
    row.stageProfiles, 1, MAX_PRODUCTION_GATEWAY_STAGE_PROFILES, `${subject}.stageProfiles`,
  ).map(parseStageProfile);
  const stageProfileById = new Map(stageProfiles.map((profile) => [profile.stageProfileId, profile] as const));
  if (stageProfileById.size !== stageProfiles.length) {
    schemaError(`${subject}.stageProfiles`, "stageProfileId 必须唯一");
  }

  const bound = new Set<string>();
  for (const [index, backend] of backends.entries()) {
    for (const profileId of backend.profileIds) {
      const profile = profileById.get(profileId);
      if (profile === undefined) {
        schemaError(`${subject}.backends[${index}].profileIds`, `引用了未登记的 execution profile '${profileId}'`);
      }
      if (profile.execution.backendInstanceId !== backend.backendInstanceId) {
        schemaError(
          `${subject}.backends[${index}].profileIds`,
          `execution profile '${profileId}' 的 backendInstanceId 与本 backend 不一致`,
        );
      }
      if (bound.has(profileId)) {
        schemaError(`${subject}.backends[${index}].profileIds`, `execution profile '${profileId}' 被多个 backend 绑定`);
      }
      bound.add(profileId);
    }
  }
  for (const profile of executionProfiles) {
    if (!bound.has(profile.execution.profileId)) {
      schemaError(`${subject}.executionProfiles`, `execution profile '${profile.execution.profileId}' 未绑定任何 backend`);
    }
    if (!stageProfileById.has(profile.stageProfileId)) {
      schemaError(
        `${subject}.executionProfiles`,
        `execution profile '${profile.execution.profileId}' 引用了未登记的 stage profile '${profile.stageProfileId}'`,
      );
    }
  }

  // The three kernels create overlapping directory names (`receipts/`, `tmp/`) inside their own
  // root, so sharing a root would let one kernel's durable state collide with another's.
  const objectsRoot = absoluteRoot(row.objectsRoot, `${subject}.objectsRoot`);
  const ingestRoot = absoluteRoot(row.ingestRoot, `${subject}.ingestRoot`);
  const jobStateRoot = absoluteRoot(row.jobStateRoot, `${subject}.jobStateRoot`);
  const roots = [
    ["objectsRoot", objectsRoot], ["ingestRoot", ingestRoot], ["jobStateRoot", jobStateRoot],
  ] as const;
  for (const [leftName, left] of roots) {
    for (const [rightName, right] of roots) {
      if (leftName === rightName) continue;
      const containment = relative(left, right);
      // Equal, or one nested inside the other: the kernels would then share `receipts/` and `tmp/`.
      if (containment === "" || (!isAbsolute(containment) && containment !== ".."
        && !containment.startsWith(`..${sep}`))) {
        schemaError(subject, `${rightName} 不得等于或位于 ${leftName} 之内`);
      }
    }
  }

  return Object.freeze({
    version: 1 as const,
    listen: parseListen(row.listen),
    auth: parseAuth(row.auth),
    backends: Object.freeze(backends),
    executionProfiles: Object.freeze(executionProfiles),
    stageProfiles: Object.freeze(stageProfiles),
    casAuthority: safeString(row.casAuthority, CAS_AUTHORITY, `${subject}.casAuthority`),
    objectsRoot,
    ingestRoot,
    jobStateRoot,
    admission: parseAdmission(row.admission),
    reconcilePolicy: parseReconcilePolicy(row.reconcilePolicy),
  });
}

type PrivateFileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function privateIdentity(file: string): PrivateFileIdentity | null {
  try {
    const stat = lstatSync(file);
    const permissions = stat.mode & 0o777;
    const expectedOwner = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (permissions !== 0o600 && permissions !== 0o400)
      || (expectedOwner !== null && Number(stat.uid) !== expectedOwner)) return null;
    return {
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      ctimeMs: Number(stat.ctimeMs),
    };
  } catch { return null; }
}

function samePrivateIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Add owner/euid and 0400-or-0600 requirements around the shared exact descriptor/path reader. */
function readPrivateRegularTextExact(file: string, maxBytes: number, hooks: ExactReadHooks = {}): string | null {
  const before = privateIdentity(file);
  if (before === null) return null;
  const text = readRegularTextExact(file, maxBytes, hooks);
  const after = privateIdentity(file);
  return text !== null && after !== null && samePrivateIdentity(before, after) ? text : null;
}

export function loadProductionGatewayRuntimeConfig(
  configFile: string,
  options: LoadProductionGatewayRuntimeConfigOptions = {},
): ProductionGatewayRuntimeConfig {
  const limit = options.maxConfigBytes === undefined
    ? DEFAULT_PRODUCTION_GATEWAY_CONFIG_BYTES
    : boundedInteger(
      options.maxConfigBytes, 1_024, DEFAULT_PRODUCTION_GATEWAY_CONFIG_BYTES,
      "ProductionGatewayRuntimeConfig maxConfigBytes",
    );
  const file = resolve(configFile);
  const text = readPrivateRegularTextExact(file, limit, options.readHooks);
  if (text === null) {
    throw new ProductionGatewayRuntimeConfigError(
      "config-unreadable",
      "production gateway registry config 必须是未变化的单链接普通 UTF-8 文件（0400/0600、当前 euid 所有），且不得超过读取上限",
    );
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    throw new ProductionGatewayRuntimeConfigError("config-invalid-json", "production gateway registry config 不是有效 JSON");
  }
  return parseProductionGatewayRuntimeConfig(value);
}

export type ProductionGatewayWorkflowTemplate = Readonly<{
  profileId: string;
  workflow: Record<string, unknown>;
  workflowDigest: string;
}>;

/**
 * Reads one pinned template graph with the same bounded/private/no-symlink discipline as the worker
 * registry, then proves it against the profile's H3 contract and stage bindings before the process
 * can serve a single request.
 */
export function readProductionGatewayWorkflow(
  config: ProductionGatewayRuntimeConfig,
  configFile: string,
  profileId: string,
  options: { maxWorkflowBytes?: number; readHooks?: ExactReadHooks } = {},
): ProductionGatewayWorkflowTemplate {
  const profile = config.executionProfiles.find((entry) => entry.execution.profileId === profileId);
  if (profile === undefined) {
    throw new ProductionGatewayRuntimeConfigError("workflow-invalid", "未登记的 execution profile");
  }
  const stageProfile = config.stageProfiles.find((entry) => entry.stageProfileId === profile.stageProfileId);
  if (stageProfile === undefined) {
    throw new ProductionGatewayRuntimeConfigError("workflow-invalid", "execution profile 的 stage profile 在装配时丢失");
  }
  const configDirectory = dirname(resolve(configFile));
  const absoluteFile = resolve(configDirectory, profile.workflowFile);
  const containment = relative(configDirectory, absoluteFile);
  if (isAbsolute(containment) || containment === ".." || containment.startsWith(`..${sep}`)) {
    throw new ProductionGatewayRuntimeConfigError("config-invalid-schema", "workflow file 超出 registry config 目录");
  }
  const parts = profile.workflowFile.split("/");
  if (hasSymlinkComponent(configDirectory, parts)) {
    throw new ProductionGatewayRuntimeConfigError("workflow-unreadable", "workflow 路径不得包含 symlink component");
  }
  const limit = options.maxWorkflowBytes === undefined
    ? DEFAULT_PRODUCTION_GATEWAY_WORKFLOW_BYTES
    : boundedInteger(
      options.maxWorkflowBytes, 1_024, DEFAULT_PRODUCTION_GATEWAY_WORKFLOW_BYTES,
      "ProductionGatewayRuntimeConfig maxWorkflowBytes",
    );
  const text = readPrivateRegularTextExact(absoluteFile, limit, options.readHooks);
  if (text === null || hasSymlinkComponent(configDirectory, parts)) {
    throw new ProductionGatewayRuntimeConfigError(
      "workflow-unreadable",
      "workflow 必须是未变化的单链接普通 UTF-8 文件，且不得超过读取上限",
    );
  }
  let workflow: unknown;
  try { workflow = JSON.parse(text); }
  catch { throw new ProductionGatewayRuntimeConfigError("workflow-invalid", "registered workflow 不是有效 JSON"); }
  if (!isRecord(workflow) || Object.keys(workflow).length < 1) {
    throw new ProductionGatewayRuntimeConfigError("workflow-invalid", "registered workflow 必须是非空 JSON 对象");
  }
  const workflowDigest = productionH3WorkflowSha256(workflow);
  if (workflowDigest !== profile.execution.workflowSha256) {
    throw new ProductionGatewayRuntimeConfigError("workflow-invalid", "registered workflow digest 与 execution profile 不匹配");
  }
  try {
    assertProductionH3Template(
      workflow,
      profile.h3GraphContract,
      profile.intentExecution,
      stageProfile.bindings,
      profile.execution.profileId,
    );
  } catch (error) {
    if (error instanceof ProductionH3GraphError) {
      throw new ProductionGatewayRuntimeConfigError("workflow-invalid", error.message);
    }
    throw error;
  }
  return Object.freeze({ profileId, workflow, workflowDigest });
}

/**
 * H3 has one profile per configured duration (§5.3), so the duration grid a planner may quantise
 * to is exactly the configured set for one output shape.
 */
function durationGridFor(
  config: ProductionGatewayRuntimeConfig,
  profile: ProductionGatewayExecutionProfileConfig,
): readonly number[] {
  const shape = (entry: ProductionGatewayExecutionProfileConfig): string => JSON.stringify([
    entry.execution.backendInstanceId,
    entry.execution.modelFamily,
    entry.execution.modelFamily === "minimax-h3" ? entry.execution.variant : null,
    entry.execution.aspectRatio,
    entry.execution.resolution,
    entry.execution.generateAudio,
  ]);
  const key = shape(profile);
  const durations = config.executionProfiles
    .filter((entry) => shape(entry) === key && entry.execution.modelFamily === "minimax-h3")
    .map((entry) => (entry.execution as { durationSeconds: number }).durationSeconds);
  return Object.freeze([...new Set(durations)].sort((left, right) => left - right));
}

/**
 * The configured H3 profile set, in the exact shape `ComfyUiAdapter` takes. The gateway process
 * injects this into the adapter and the snapshot derives its limits from it, so the capability the
 * coordinator reads and the price/duration snapshot the planner reads have one source (§4.3, §5.3).
 */
export function productionGatewayH3Profiles(
  config: ProductionGatewayRuntimeConfig,
): readonly ComfyUiH3ProfileCapability[] {
  return Object.freeze(config.executionProfiles.map((profile) => {
    if (profile.execution.modelFamily !== "minimax-h3") {
      schemaError("ProductionGatewayRuntimeConfig.executionProfiles", "v1 registry 只承载 minimax-h3 profile");
    }
    return Object.freeze({
      profileId: profile.execution.profileId,
      variant: profile.execution.variant,
      durationSeconds: profile.execution.durationSeconds,
      aspectRatio: profile.execution.aspectRatio as ComfyUiH3ProfileCapability["aspectRatio"],
      graphContractVersion: profile.h3GraphContract.version,
    });
  }));
}

/** The union of every configured profile's processing regions (§4.3); ISO-3166 alpha-2, sorted. */
export function productionGatewayProcessingRegions(
  config: ProductionGatewayRuntimeConfig,
): readonly string[] {
  return Object.freeze([...new Set(
    config.executionProfiles.flatMap((profile) => [...profile.processingRegions]),
  )].sort());
}

export function productionExecutionProfileSnapshotEntryDigest(
  entry: Omit<ProductionExecutionProfileSnapshotEntry, "profileDigest">,
): string {
  return productionCanonicalJsonSha256(entry);
}

/**
 * Read-only profile snapshot handed to the worker host (§4.2). It carries the profile originals,
 * their canonical digests, the H3 duration grid and the price table; `plan-shots` verifies that
 * `execution.workflowSha256` equals the `workflows[].workflowSha256` it already pins.
 */
export function exportExecutionProfileSnapshot(
  config: ProductionGatewayRuntimeConfig,
): ProductionExecutionProfileSnapshot {
  const limitsByProfileId = h3LimitsByProfileId(
    productionGatewayH3Profiles(config), config.backends[0]!.maxInputImageBytes,
  );
  const profiles = config.executionProfiles.map((profile) => {
    const durationGrid = durationGridFor(config, profile);
    const derivedLimits = limitsByProfileId[profile.execution.profileId];
    if (derivedLimits === undefined) {
      schemaError("ProductionGatewayRuntimeConfig.executionProfiles", "profile 未推导出 capability limits");
    }
    // 快照里的 limits 是跨主机契约：按 §4.3 的严格读取器复算一次，导出的 JSON 一定能被 worker 解析。
    let limits: VideoBackendLimits;
    try { limits = parseVideoBackendLimits(derivedLimits, `${profile.execution.profileId}.limits`); }
    catch (error) {
      schemaError(
        "ProductionGatewayRuntimeConfig.executionProfiles",
        error instanceof Error ? error.message : "capability limits 无效",
      );
    }
    // 两处推导（按 execution 形状分组 / 按 (variant, aspectRatio) 分组）必须给出同一条时长网格；
    // 不一致说明配置里出现了同形状不同 generateAudio / resolution 的档，fail-closed 而不是二选一。
    if (JSON.stringify(limits.durationSeconds.grid) !== JSON.stringify([...durationGrid])) {
      schemaError(
        "ProductionGatewayRuntimeConfig.executionProfiles",
        `execution profile '${profile.execution.profileId}' 的时长网格与 capability limits 不一致`,
      );
    }
    const body = {
      version: 1 as const,
      profileId: profile.execution.profileId,
      execution: profile.execution,
      durationGrid,
      limits,
      priceTable: profile.priceTable,
      license: profile.license,
      processingRegions: profile.processingRegions,
    };
    return Object.freeze({
      ...body,
      profileDigest: productionExecutionProfileSnapshotEntryDigest(body),
    });
  });
  return Object.freeze({
    version: 1 as const,
    kind: PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND,
    casAuthority: config.casAuthority,
    profiles: Object.freeze(profiles),
  });
}
