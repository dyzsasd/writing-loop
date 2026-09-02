// Trusted server-only configuration and dependency assembly for the Phase 3C production runtime.
// This module must not be imported by Studio/browser bundles: it owns private backend/gateway URLs
// and credential environment-variable names.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ComfyUiAdapter,
  type FetchLike,
  type ProductionAdapter,
} from "./production-adapter.ts";
import {
  type ProductionAdapterRegistry,
  type ProductionGateContextResolver,
  type ProductionInputPipeline,
  type ProductionInputPipelineResolver,
  type ProductionWorkflowDescriptor,
  type ProductionWorkflowResolver,
  productionWorkflowSha256,
  runProductionProjectOnce,
} from "./production-coordinator.ts";
import {
  HttpProductionArtifactIngestor,
  type ProductionArtifactIngestor,
} from "./production-ingestor.ts";
import { ProductionGatewayAdapter } from "./production-job-gateway.ts";
import {
  HttpProductionInputStager,
  type ProductionInputStageResult,
  type ProductionInputStager,
  type ProductionWorkflowBindingVerification,
  type ProductionWorkflowBindingVerifier,
} from "./production-input-stager.ts";
import {
  MAX_PRODUCTION_INTENT_INPUTS,
  PRODUCTION_MODEL_FAMILIES,
  REQUIRES_SCOPED_STAGING,
  parseProductionIntentExecution,
  readProductionIntent,
  type ProductionDispatchIntent,
  type ProductionIntentExecution,
  type ProductionIntentGateContext,
  type ProductionIntentResolver,
  type ProductionModelFamily,
} from "./production-intent.ts";
import {
  PROVIDER_INPUT_SLOTS,
  providerSlotPolicyViolation,
  providerSlotSequenceViolation,
  type ProviderInputSlot,
} from "./production-provider-adapter.ts";
import {
  hasSymlinkComponent,
  readRegularTextExact,
  type ExactReadHooks,
} from "./bounded-fs.ts";
import {
  MAX_PRODUCTION_BACKEND_CONCURRENCY,
  MAX_PRODUCTION_PROJECT_CONCURRENCY,
  MAX_PRODUCTION_RUNNER_INTERVAL_MS,
  MAX_PRODUCTION_RUNTIME_PROJECTS,
  ProductionRunner,
  type ProductionRunnableProject,
} from "./production-runner.ts";
import { readWorkspaceIdentity, WORKSPACE_ID_PATTERN } from "./workspace-registry.ts";
import {
  ProductionH3GraphError,
  assertProductionH3ExecutionContract,
  assertProductionH3Template,
  materializeProductionH3Workflow,
  parseProductionH3GraphContract,
  parseProductionH3StageBindingContract,
  type ProductionH3GeneratorClass,
  type ProductionH3GeneratorContract,
  type ProductionH3GraphContract,
  type ProductionH3ModelBundleContract,
  type ProductionH3ModelComponentContract,
  type ProductionH3PipelineContract,
  type ProductionH3StageBindingContract,
} from "./production-h3-graph.ts";

export const PRODUCTION_RUNTIME_CONFIG_VERSION = 1 as const;
export const DEFAULT_PRODUCTION_RUNTIME_CONFIG_BYTES = 512 * 1024;
export const DEFAULT_PRODUCTION_RUNTIME_WORKFLOW_BYTES = 2 * 1024 * 1024;
export const MAX_PRODUCTION_RUNTIME_BACKENDS = 64;
export const MAX_PRODUCTION_RUNTIME_WORKFLOWS = 1_024;
export const MAX_PRODUCTION_RUNTIME_STAGING_PROFILES = 256;
export const PRODUCTION_RUNTIME_WORKFLOW_INPUT_POLICIES = [
  "static-pre-staged", "scoped-staging",
] as const;
export type ProductionRuntimeWorkflowInputPolicy =
  typeof PRODUCTION_RUNTIME_WORKFLOW_INPUT_POLICIES[number];

/**
 * Owner-only transport declaration.  `insecure-private-http` trades TLS for VPC isolation plus a
 * bearer credential on a private-network endpoint; it is valid only while no third-party workload
 * shares that VPC (§9.4).  Absent means `tls` and keeps the existing HTTPS rules unchanged.
 */
export const PRODUCTION_RUNTIME_TRANSPORTS = ["tls", "insecure-private-http"] as const;
export type ProductionRuntimeTransport = typeof PRODUCTION_RUNTIME_TRANSPORTS[number];

export type ProductionRuntimeH3GeneratorClass = ProductionH3GeneratorClass;
export type ProductionRuntimeH3GeneratorContract = ProductionH3GeneratorContract;
export type ProductionRuntimeH3ModelComponentContract = ProductionH3ModelComponentContract;
export type ProductionRuntimeH3ModelBundleContract = ProductionH3ModelBundleContract;
export type ProductionRuntimeH3PipelineContract = ProductionH3PipelineContract;
export type ProductionRuntimeH3GraphContract = ProductionH3GraphContract;

export type ProductionRuntimeDirectComfyBackendConfig = Readonly<{
  version: 1;
  backendInstanceId: string;
  kind: "comfyui";
  baseUrl: string;
  credentialEnv: null;
  preferJobsApi: boolean;
}>;

export type ProductionRuntimeGatewayBackendConfig = Readonly<{
  version: 1;
  backendInstanceId: string;
  kind: "production-gateway";
  baseUrl: string;
  credentialEnv: string;
  profileId: string;
  transport: ProductionRuntimeTransport;
}>;

export type ProductionRuntimeBackendConfig =
  | ProductionRuntimeDirectComfyBackendConfig
  | ProductionRuntimeGatewayBackendConfig;

export type ProductionRuntimeGatewayConfig = Readonly<{
  version: 1;
  baseUrl: string;
  credentialEnv: string | null;
  transport: ProductionRuntimeTransport;
}>;

export type ProductionRuntimeWorkflowConfig = Readonly<{
  version: 1;
  backendInstanceId: string;
  workflowSha256: string;
  modelFamily: ProductionModelFamily;
  modelSha256: string;
  parametersSha256: string;
  projects: readonly string[];
  inputPolicy: ProductionRuntimeWorkflowInputPolicy;
  stagingProfileId: string | null;
  h3GraphContract: ProductionRuntimeH3GraphContract | null;
  /** Relative to the trusted runtime config file; absolute and parent-traversal paths are rejected. */
  file: string;
}>;

export type ProductionRuntimeStagingBindingConfig = ProductionH3StageBindingContract;

/**
 * 云家族的 stage 声明（§6.5 的 `slotPolicy`）：没有可绑定的 ComfyUI 节点，只声明 stage kernel 接受的
 * slot、顺序与每个 slot 的出现次数区间。顺序由数组位置隐含（§5 的固定输入顺序），因此同一档 profile
 * 可承载 i2v（无 last_frame）与 fl2v（有 last_frame）等镜头。本版只到类型与解析，stage kernel 侧随
 * Phase 1 落地。
 */
export type ProductionRuntimeStagingSlotConfig = Readonly<{
  slot: ProviderInputSlot;
  minCount: number;
  maxCount: number;
}>;

/** 家族决定形态：H3 是 pinned 图的 LoadImage 绑定契约，云家族是 slot policy（§8.6）。 */
export type ProductionRuntimeStagingBindings =
  | Readonly<{ kind: "h3-graph-bindings"; bindings: readonly ProductionRuntimeStagingBindingConfig[] }>
  | Readonly<{ kind: "provider-slot-policy"; slots: readonly ProductionRuntimeStagingSlotConfig[] }>;

export type ProductionRuntimeStagingProfileConfig = Readonly<{
  version: 1;
  profileId: string;
  baseUrl: string;
  credentialEnv: string | null;
  execution: ProductionIntentExecution;
  bindings: ProductionRuntimeStagingBindings;
  transport: ProductionRuntimeTransport;
}>;

export type ProductionRuntimeProjectConfig = Readonly<{
  version: 1;
  project: string;
  enabled: boolean;
  backendInstanceIds: readonly string[];
  deploymentTerritories: readonly string[];
  availableBudgetMicros: number;
}>;

export type ProductionRuntimeRunnerConfig = Readonly<{
  version: 1;
  intervalMs: number;
  projectConcurrency: number;
  perBackendConcurrency: number;
}>;

export type ProductionRuntimeConfig = Readonly<{
  version: 1;
  workspaceId: string;
  projects: readonly ProductionRuntimeProjectConfig[];
  backends: readonly ProductionRuntimeBackendConfig[];
  gateway: ProductionRuntimeGatewayConfig;
  workflows: readonly ProductionRuntimeWorkflowConfig[];
  stagingProfiles: readonly ProductionRuntimeStagingProfileConfig[];
  runner: ProductionRuntimeRunnerConfig;
}>;

export type ProductionRuntimeConfigErrorCode =
  | "config-unreadable"
  | "config-invalid-json"
  | "config-invalid-schema"
  | "credential-unavailable"
  | "workflow-unreadable"
  | "workflow-invalid";

export class ProductionRuntimeConfigError extends Error {
  readonly code: ProductionRuntimeConfigErrorCode;

  constructor(code: ProductionRuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = "ProductionRuntimeConfigError";
    this.code = code;
  }
}

export type LoadProductionRuntimeConfigOptions = {
  maxConfigBytes?: number;
  /** Test seam inherited from the exact bounded reader. */
  readHooks?: ExactReadHooks;
};

export type CreateProductionRuntimeRegistryOptions = LoadProductionRuntimeConfigOptions & {
  root: string;
  configFile: string;
  maxWorkflowBytes?: number;
  env?: Readonly<Record<string, string | undefined>>;
  fetchByBackend?: Readonly<Record<string, FetchLike | undefined>>;
  gatewayFetch?: FetchLike;
  stagingFetchByProfile?: Readonly<Record<string, FetchLike | undefined>>;
  now?: () => Date | string;
  /** Test seam keyed by the workflow's config-relative file name. */
  workflowReadHooks?: Readonly<Record<string, ExactReadHooks | undefined>>;
};

export type ProductionRuntimeProjectRegistration = ProductionRunnableProject & Readonly<{
  config: ProductionRuntimeProjectConfig;
  intentResolver: ProductionIntentResolver;
  workflowResolver: ProductionWorkflowResolver;
  gateContextResolver: ProductionGateContextResolver;
  adapterRegistry: ProductionAdapterRegistry;
  inputPipelineResolver: ProductionInputPipelineResolver;
  ingestor: ProductionArtifactIngestor;
  allowDispatch: boolean;
}>;

export type ProductionRuntimeInstanceRegistry = Readonly<{
  config: ProductionRuntimeConfig;
  adapterRegistry: ProductionAdapterRegistry;
  workflowResolver: ProductionWorkflowResolver;
  projects: readonly ProductionRuntimeProjectRegistration[];
  runner: ProductionRunner;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERRITORY = /^(?:[A-Z]{2}|WORLDWIDE)$/;
const MODEL_FAMILIES = new Set<string>(PRODUCTION_MODEL_FAMILIES);
/** 只有 H3 经 pinned ComfyUI 图执行，需要 graph contract；其余家族必须显式 null。 */
const REQUIRES_H3_GRAPH_CONTRACT: Readonly<Record<ProductionModelFamily, boolean>> = {
  generic: false,
  "minimax-h3": true,
  seedance: false,
  veo: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function schemaError(subject: string, detail: string): never {
  throw new ProductionRuntimeConfigError("config-invalid-schema", `${subject} ${detail}`);
}

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) schemaError(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  subject: string,
  /** Owner-only opt-in keys; omitting them must keep the pre-existing parse result. */
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extras = keys.filter((key) => !expected.includes(key) && !optional.includes(key));
  if (missing.length || extras.length) {
    schemaError(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
}

function version(value: unknown, subject: string): void {
  if (value !== PRODUCTION_RUNTIME_CONFIG_VERSION) schemaError(subject, "version 必须是 1");
}

function boundedInteger(value: unknown, minimum: number, maximum: number, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    schemaError(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function boundedReadLimit(value: unknown, fallback: number, maximum: number, subject: string): number {
  return value === undefined ? fallback : boundedInteger(value, 1_024, maximum, subject);
}

function safeString(value: unknown, pattern: RegExp, subject: string): string {
  if (typeof value !== "string" || !fullMatch(pattern, value)) schemaError(subject, "格式无效");
  return value;
}

function sha256(value: unknown, subject: string): string {
  return safeString(value, SHA256, subject);
}

function credentialEnv(value: unknown, subject: string): string | null {
  if (value === null) return null;
  return safeString(value, SAFE_ENV, subject);
}

/** Absent transport keeps the pre-existing HTTPS/loopback rules, so old configs parse unchanged. */
function transport(value: unknown, subject: string): ProductionRuntimeTransport {
  if (value === undefined) return "tls";
  if (typeof value !== "string" || !(PRODUCTION_RUNTIME_TRANSPORTS as readonly string[]).includes(value)) {
    schemaError(subject, "必须是 tls 或 insecure-private-http");
  }
  return value as ProductionRuntimeTransport;
}

function parseH3GraphContract(value: unknown, subject: string): ProductionRuntimeH3GraphContract {
  try { return parseProductionH3GraphContract(value); }
  catch (error) {
    if (error instanceof ProductionH3GraphError) schemaError(subject, error.message);
    throw error;
  }
}

function isLiteralLoopback(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
  if (host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

/**
 * RFC1918 IPv4 or the loopback literal, written as a literal address.  WHATWG URL already
 * canonicalises numeric hosts, so a decimal-dotted match here also covers octal/hex spellings while
 * every domain name — which could resolve anywhere — stays outside the accepted set.
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

function trustedServiceUrl(
  value: unknown,
  subject: string,
  secretEnv: string | null,
  policy: "gateway" | "production-gateway" | "direct-comfy-dev" = "gateway",
  declaredTransport: ProductionRuntimeTransport = "tls",
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) schemaError(subject, "必须是有界 URL 字符串");
  let url: URL;
  try { url = new URL(value); }
  catch { schemaError(subject, "必须是有效 http(s) URL"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname
    || url.username || url.password || url.search || url.hash) {
    schemaError(subject, "只接受不含 credential、query、fragment 的 http(s) URL");
  }
  if (!/^(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(url.pathname) || url.pathname.length > 512) {
    schemaError(subject, "path 必须是固定的安全 path segment 序列");
  }
  const literalLoopback = isLiteralLoopback(url.hostname);
  if (declaredTransport === "insecure-private-http") {
    // 明文只在 VPC 私网内成立：endpoint 必须是私网字面 IP，且仍以 bearer credential 鉴权。
    if (url.protocol !== "http:") {
      schemaError(subject, "insecure-private-http transport 只接受 http:// endpoint");
    }
    if (!isPrivateIpv4Literal(url.hostname)) {
      schemaError(subject, "insecure-private-http transport 只接受 RFC1918 私网 IPv4 或 127.0.0.1 字面地址");
    }
    if (secretEnv === null) {
      schemaError(subject, "insecure-private-http transport 必须引用非空 credentialEnv");
    }
  } else if (policy === "direct-comfy-dev") {
    if (url.protocol !== "http:" || secretEnv !== null || !literalLoopback) {
      schemaError(subject, "direct ComfyUI 仅允许无凭据的 literal-loopback HTTP development endpoint");
    }
  } else if (policy === "production-gateway") {
    if (url.protocol !== "https:" || secretEnv === null) {
      schemaError(subject, "production gateway 必须是带 server credentialEnv 的 HTTPS endpoint");
    }
  } else if ((url.protocol === "http:" && (secretEnv !== null || !literalLoopback))
    || (url.protocol === "https:" && secretEnv === null)) {
    schemaError(subject, "gateway 必须是 credentialed HTTPS，或无凭据 literal-loopback HTTP development endpoint");
  }
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function relativeWorkflowFile(value: unknown, subject: string): string {
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

function parseBackend(value: unknown, index: number): ProductionRuntimeBackendConfig {
  const subject = `ProductionRuntimeConfig.backends[${index}]`;
  const row = record(value, subject);
  if (row.kind === "comfyui") {
    exactKeys(row, ["version", "backendInstanceId", "kind", "baseUrl", "credentialEnv", "preferJobsApi"], subject);
    version(row.version, subject);
    if (row.credentialEnv !== null) schemaError(`${subject}.credentialEnv`, "direct ComfyUI development backend 禁止 credential");
    if (typeof row.preferJobsApi !== "boolean") schemaError(`${subject}.preferJobsApi`, "必须是 boolean");
    return Object.freeze({
      version: 1,
      backendInstanceId: safeString(row.backendInstanceId, SAFE_ID, `${subject}.backendInstanceId`),
      kind: "comfyui",
      baseUrl: trustedServiceUrl(row.baseUrl, `${subject}.baseUrl`, null, "direct-comfy-dev"),
      credentialEnv: null,
      preferJobsApi: row.preferJobsApi,
    });
  }
  if (row.kind === "production-gateway") {
    exactKeys(
      row, ["version", "backendInstanceId", "kind", "baseUrl", "credentialEnv", "profileId"], subject,
      ["transport"],
    );
    version(row.version, subject);
    const backendCredentialEnv = credentialEnv(row.credentialEnv, `${subject}.credentialEnv`);
    if (backendCredentialEnv === null) schemaError(`${subject}.credentialEnv`, "production gateway 必须引用 server credential env");
    const backendTransport = transport(row.transport, `${subject}.transport`);
    return Object.freeze({
      version: 1,
      backendInstanceId: safeString(row.backendInstanceId, SAFE_ID, `${subject}.backendInstanceId`),
      kind: "production-gateway",
      baseUrl: trustedServiceUrl(
        row.baseUrl, `${subject}.baseUrl`, backendCredentialEnv, "production-gateway", backendTransport,
      ),
      credentialEnv: backendCredentialEnv,
      profileId: safeString(row.profileId, SAFE_PROFILE_ID, `${subject}.profileId`),
      transport: backendTransport,
    });
  }
  schemaError(`${subject}.kind`, "必须是 comfyui 或 production-gateway");
}

function parseGateway(value: unknown): ProductionRuntimeGatewayConfig {
  const subject = "ProductionRuntimeConfig.gateway";
  const row = record(value, subject);
  exactKeys(row, ["version", "baseUrl", "credentialEnv"], subject, ["transport"]);
  version(row.version, subject);
  const gatewayCredentialEnv = credentialEnv(row.credentialEnv, `${subject}.credentialEnv`);
  const gatewayTransport = transport(row.transport, `${subject}.transport`);
  return Object.freeze({
    version: 1,
    baseUrl: trustedServiceUrl(
      row.baseUrl, `${subject}.baseUrl`, gatewayCredentialEnv, "gateway", gatewayTransport,
    ),
    credentialEnv: gatewayCredentialEnv,
    transport: gatewayTransport,
  });
}

function parseWorkflow(value: unknown, index: number): ProductionRuntimeWorkflowConfig {
  const subject = `ProductionRuntimeConfig.workflows[${index}]`;
  const row = record(value, subject);
  exactKeys(row, [
    "version", "backendInstanceId", "workflowSha256", "modelFamily", "modelSha256",
    "parametersSha256", "projects", "inputPolicy", "stagingProfileId", "h3GraphContract", "file",
  ], subject);
  version(row.version, subject);
  if (typeof row.modelFamily !== "string" || !MODEL_FAMILIES.has(row.modelFamily)) {
    schemaError(`${subject}.modelFamily`, `必须是 ${PRODUCTION_MODEL_FAMILIES.join("、")} 之一`);
  }
  const modelFamily = row.modelFamily as ProductionModelFamily;
  if (!Array.isArray(row.projects) || row.projects.length < 1
    || row.projects.length > MAX_PRODUCTION_RUNTIME_PROJECTS) {
    schemaError(`${subject}.projects`, `必须包含 1–${MAX_PRODUCTION_RUNTIME_PROJECTS} 个 project`);
  }
  const projects = row.projects.map((entry, projectIndex) =>
    safeString(entry, SAFE_PROJECT, `${subject}.projects[${projectIndex}]`));
  if (new Set(projects).size !== projects.length) schemaError(`${subject}.projects`, "不得重复");
  if (typeof row.inputPolicy !== "string"
    || !(PRODUCTION_RUNTIME_WORKFLOW_INPUT_POLICIES as readonly string[]).includes(row.inputPolicy)) {
    schemaError(`${subject}.inputPolicy`, "必须是 static-pre-staged 或 scoped-staging");
  }
  const inputPolicy = row.inputPolicy as ProductionRuntimeWorkflowInputPolicy;
  const stagingProfileId = row.stagingProfileId === null
    ? null
    : safeString(row.stagingProfileId, SAFE_PROFILE_ID, `${subject}.stagingProfileId`);
  if ((inputPolicy === "static-pre-staged") !== (stagingProfileId === null)) {
    schemaError(subject, "static-pre-staged 必须使用 null profile；scoped-staging 必须引用 stagingProfileId");
  }
  if (REQUIRES_SCOPED_STAGING[modelFamily] && inputPolicy !== "scoped-staging") {
    schemaError(subject, `${modelFamily} workflow 的输入逐镜可变，必须使用 scoped-staging`);
  }
  const h3GraphContract = REQUIRES_H3_GRAPH_CONTRACT[modelFamily]
    ? parseH3GraphContract(row.h3GraphContract, `${subject}.h3GraphContract`)
    : null;
  if (!REQUIRES_H3_GRAPH_CONTRACT[modelFamily] && row.h3GraphContract !== null) {
    schemaError(`${subject}.h3GraphContract`, `${modelFamily} workflow 不经 pinned ComfyUI 图执行，必须显式使用 null`);
  }
  return Object.freeze({
    version: 1,
    backendInstanceId: safeString(row.backendInstanceId, SAFE_ID, `${subject}.backendInstanceId`),
    workflowSha256: sha256(row.workflowSha256, `${subject}.workflowSha256`),
    modelFamily,
    modelSha256: sha256(row.modelSha256, `${subject}.modelSha256`),
    parametersSha256: sha256(row.parametersSha256, `${subject}.parametersSha256`),
    projects: Object.freeze([...projects].sort()),
    inputPolicy,
    stagingProfileId,
    h3GraphContract,
    file: relativeWorkflowFile(row.file, `${subject}.file`),
  });
}

function parseStagingBindings(
  value: unknown,
  family: ProductionModelFamily,
  subject: string,
): ProductionRuntimeStagingBindings {
  if (family === "minimax-h3") {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRODUCTION_INTENT_INPUTS) {
      schemaError(subject, `H3 profile 必须声明 1–${MAX_PRODUCTION_INTENT_INPUTS} 项 LoadImage 绑定契约`);
    }
    const bindings = value.map((entry, bindingIndex): ProductionRuntimeStagingBindingConfig => {
      try { return parseProductionH3StageBindingContract(entry, bindingIndex); }
      catch (error) {
        if (error instanceof ProductionH3GraphError) schemaError(`${subject}[${bindingIndex}]`, error.message);
        throw error;
      }
    });
    if (new Set(bindings.map((binding) => binding.slot)).size !== bindings.length
      || new Set(bindings.map((binding) => binding.source.nodeId)).size !== bindings.length
      || new Set(bindings.map((binding) => `${binding.consumer.nodeId}\0${binding.consumer.inputName}`)).size !== bindings.length) {
      schemaError(subject, "slot、LoadImage source 与 consumer target 均不得重复");
    }
    return Object.freeze({ kind: "h3-graph-bindings", bindings: Object.freeze(bindings) });
  }
  // 云家族：请求体由 execution profile + ShotRequest 决定，没有可绑定的图节点，只声明 slot 与顺序。
  const row = record(value, subject);
  exactKeys(row, ["version", "kind", "slots"], subject);
  version(row.version, subject);
  if (row.kind !== "provider-slot-policy") {
    schemaError(`${subject}.kind`, `${family} profile 的 bindings 必须是 provider-slot-policy`);
  }
  if (!Array.isArray(row.slots) || row.slots.length < 1 || row.slots.length > MAX_PRODUCTION_INTENT_INPUTS) {
    schemaError(`${subject}.slots`, `必须包含 1–${MAX_PRODUCTION_INTENT_INPUTS} 项`);
  }
  const slots = row.slots.map((entry, slotIndex): ProductionRuntimeStagingSlotConfig => {
    const slotSubject = `${subject}.slots[${slotIndex}]`;
    const slotRow = record(entry, slotSubject);
    exactKeys(slotRow, ["slot", "minCount", "maxCount"], slotSubject);
    if (typeof slotRow.slot !== "string" || !(PROVIDER_INPUT_SLOTS as readonly string[]).includes(slotRow.slot)) {
      schemaError(`${slotSubject}.slot`, `必须是 ${PROVIDER_INPUT_SLOTS.join("、")} 之一`);
    }
    return Object.freeze({
      slot: slotRow.slot as ProviderInputSlot,
      minCount: boundedInteger(slotRow.minCount, 0, MAX_PRODUCTION_INTENT_INPUTS, `${slotSubject}.minCount`),
      maxCount: boundedInteger(slotRow.maxCount, 1, MAX_PRODUCTION_INTENT_INPUTS, `${slotSubject}.maxCount`),
    });
  });
  const violation = providerSlotPolicyViolation(slots);
  if (violation !== null) schemaError(`${subject}.slots`, violation);
  return Object.freeze({ kind: "provider-slot-policy", slots: Object.freeze(slots) });
}

function parseStagingProfile(value: unknown, index: number): ProductionRuntimeStagingProfileConfig {
  const subject = `ProductionRuntimeConfig.stagingProfiles[${index}]`;
  const row = record(value, subject);
  exactKeys(
    row, ["version", "profileId", "baseUrl", "credentialEnv", "execution", "bindings"], subject,
    ["transport"],
  );
  version(row.version, subject);
  const profileCredentialEnv = credentialEnv(row.credentialEnv, `${subject}.credentialEnv`);
  const profileTransport = transport(row.transport, `${subject}.transport`);
  let execution: ProductionIntentExecution;
  try { execution = parseProductionIntentExecution(row.execution, `${subject}.execution`); }
  catch { schemaError(`${subject}.execution`, "不是严格 ProductionIntentExecution"); }
  if (!REQUIRES_SCOPED_STAGING[execution.modelFamily]) {
    schemaError(`${subject}.execution`, "generic workflow 的输入是静态 pinned，不得注册 staging profile");
  }
  if (execution.modelFamily === "minimax-h3" && execution.operation !== "comfyui-workflow") {
    schemaError(`${subject}.execution`, "H3 staging profile 只装配 comfyui-workflow 传输形态");
  }
  const bindings = parseStagingBindings(row.bindings, execution.modelFamily, `${subject}.bindings`);
  return Object.freeze({
    version: 1,
    profileId: safeString(row.profileId, SAFE_PROFILE_ID, `${subject}.profileId`),
    baseUrl: trustedServiceUrl(
      row.baseUrl, `${subject}.baseUrl`, profileCredentialEnv, "gateway", profileTransport,
    ),
    credentialEnv: profileCredentialEnv,
    execution: Object.freeze({ ...execution }),
    bindings: Object.freeze(bindings),
    transport: profileTransport,
  });
}

function parseTerritories(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    schemaError(subject, "必须包含 1–64 个地域");
  }
  const parsed = value.map((entry, index) => safeString(entry, TERRITORY, `${subject}[${index}]`));
  if (new Set(parsed).size !== parsed.length || (parsed.includes("WORLDWIDE") && parsed.length !== 1)) {
    schemaError(subject, "不得重复，且 WORLDWIDE 必须单独使用");
  }
  return Object.freeze([...parsed].sort());
}

function parseProject(value: unknown, index: number): ProductionRuntimeProjectConfig {
  const subject = `ProductionRuntimeConfig.projects[${index}]`;
  const row = record(value, subject);
  exactKeys(row, [
    "version", "project", "enabled", "backendInstanceIds", "deploymentTerritories", "availableBudgetMicros",
  ], subject);
  version(row.version, subject);
  if (typeof row.enabled !== "boolean") schemaError(`${subject}.enabled`, "必须是 boolean");
  if (!Array.isArray(row.backendInstanceIds) || row.backendInstanceIds.length < 1
    || row.backendInstanceIds.length > MAX_PRODUCTION_RUNTIME_BACKENDS) {
    schemaError(`${subject}.backendInstanceIds`, `必须包含 1–${MAX_PRODUCTION_RUNTIME_BACKENDS} 项`);
  }
  const backendInstanceIds = row.backendInstanceIds.map((entry, backendIndex) =>
    safeString(entry, SAFE_ID, `${subject}.backendInstanceIds[${backendIndex}]`));
  if (new Set(backendInstanceIds).size !== backendInstanceIds.length) {
    schemaError(`${subject}.backendInstanceIds`, "不得重复");
  }
  return Object.freeze({
    version: 1,
    project: safeString(row.project, SAFE_PROJECT, `${subject}.project`),
    enabled: row.enabled,
    backendInstanceIds: Object.freeze([...backendInstanceIds].sort()),
    deploymentTerritories: parseTerritories(row.deploymentTerritories, `${subject}.deploymentTerritories`),
    availableBudgetMicros: boundedInteger(
      row.availableBudgetMicros, 0, Number.MAX_SAFE_INTEGER, `${subject}.availableBudgetMicros`,
    ),
  });
}

function parseRunner(value: unknown): ProductionRuntimeRunnerConfig {
  const subject = "ProductionRuntimeConfig.runner";
  const row = record(value, subject);
  exactKeys(row, ["version", "intervalMs", "projectConcurrency", "perBackendConcurrency"], subject);
  version(row.version, subject);
  return Object.freeze({
    version: 1,
    intervalMs: boundedInteger(row.intervalMs, 250, MAX_PRODUCTION_RUNNER_INTERVAL_MS, `${subject}.intervalMs`),
    projectConcurrency: boundedInteger(
      row.projectConcurrency, 1, MAX_PRODUCTION_PROJECT_CONCURRENCY, `${subject}.projectConcurrency`,
    ),
    perBackendConcurrency: boundedInteger(
      row.perBackendConcurrency, 1, MAX_PRODUCTION_BACKEND_CONCURRENCY, `${subject}.perBackendConcurrency`,
    ),
  });
}

function validateH3GraphContractExpectations(
  workflow: ProductionRuntimeWorkflowConfig,
  profile: ProductionRuntimeStagingProfileConfig,
  subject: string,
): void {
  if (workflow.modelFamily !== "minimax-h3") return;
  const contract = workflow.h3GraphContract;
  if (contract === null) schemaError(subject, "缺少 H3 graph contract");
  if (profile.bindings.kind !== "h3-graph-bindings") schemaError(subject, "H3 workflow 的 staging profile 必须声明 LoadImage 绑定契约");
  try { assertProductionH3ExecutionContract(contract, profile.execution, profile.bindings.bindings); }
  catch (error) {
    if (error instanceof ProductionH3GraphError) schemaError(subject, error.message);
    throw error;
  }
}

export function parseProductionRuntimeConfig(value: unknown): ProductionRuntimeConfig {
  const subject = "ProductionRuntimeConfig";
  const row = record(value, subject);
  exactKeys(row, [
    "version", "workspaceId", "projects", "backends", "gateway", "workflows", "stagingProfiles", "runner",
  ], subject);
  version(row.version, subject);
  if (!Array.isArray(row.projects) || row.projects.length > MAX_PRODUCTION_RUNTIME_PROJECTS) {
    schemaError(`${subject}.projects`, `最多包含 ${MAX_PRODUCTION_RUNTIME_PROJECTS} 项`);
  }
  if (!Array.isArray(row.backends) || row.backends.length < 1 || row.backends.length > MAX_PRODUCTION_RUNTIME_BACKENDS) {
    schemaError(`${subject}.backends`, `必须包含 1–${MAX_PRODUCTION_RUNTIME_BACKENDS} 项`);
  }
  if (!Array.isArray(row.workflows) || row.workflows.length < 1 || row.workflows.length > MAX_PRODUCTION_RUNTIME_WORKFLOWS) {
    schemaError(`${subject}.workflows`, `必须包含 1–${MAX_PRODUCTION_RUNTIME_WORKFLOWS} 项`);
  }
  if (!Array.isArray(row.stagingProfiles) || row.stagingProfiles.length > MAX_PRODUCTION_RUNTIME_STAGING_PROFILES) {
    schemaError(`${subject}.stagingProfiles`, `最多包含 ${MAX_PRODUCTION_RUNTIME_STAGING_PROFILES} 项`);
  }
  const projects = row.projects.map(parseProject);
  const backends = row.backends.map(parseBackend);
  const workflows = row.workflows.map(parseWorkflow);
  const stagingProfiles = row.stagingProfiles.map(parseStagingProfile);
  const backendIds = new Set(backends.map((entry) => entry.backendInstanceId));
  if (backendIds.size !== backends.length) schemaError(`${subject}.backends`, "backendInstanceId 不得重复");
  if (new Set(projects.map((entry) => entry.project)).size !== projects.length) {
    schemaError(`${subject}.projects`, "project 不得重复");
  }
  const projectById = new Map(projects.map((entry) => [entry.project, entry] as const));
  const backendById = new Map(backends.map((entry) => [entry.backendInstanceId, entry] as const));
  for (const project of projects) {
    if (project.backendInstanceIds.some((backend) => !backendIds.has(backend))) {
      schemaError(`${subject}.projects.${project.project}`, "引用未注册 backendInstanceId");
    }
  }
  const workflowKeys = new Set<string>();
  const workflowDigestBindings = new Set<string>();
  const profileById = new Map<string, ProductionRuntimeStagingProfileConfig>();
  const profileExecutionKeys = new Set<string>();
  for (const profile of stagingProfiles) {
    if (profileById.has(profile.profileId)) schemaError(`${subject}.stagingProfiles`, "profileId 不得重复");
    profileById.set(profile.profileId, profile);
    const executionKey = JSON.stringify(profile.execution);
    if (profileExecutionKeys.has(executionKey)) {
      schemaError(`${subject}.stagingProfiles`, "完整 immutable execution 不得绑定多个 staging profile");
    }
    profileExecutionKeys.add(executionKey);
  }
  const usedProfiles = new Set<string>();
  for (const workflow of workflows) {
    if (!backendIds.has(workflow.backendInstanceId)) {
      schemaError(`${subject}.workflows`, "引用未注册 backendInstanceId");
    }
    const key = workflowBindingKey(workflow);
    if (workflowKeys.has(key)) schemaError(`${subject}.workflows`, "immutable workflow binding 不得重复");
    workflowKeys.add(key);
    const digestBinding = JSON.stringify([workflow.backendInstanceId, workflow.workflowSha256]);
    if (workflowDigestBindings.has(digestBinding)) {
      schemaError(`${subject}.workflows`, "同一 backend/workflow digest 不得声明多个 model/parameters identity");
    }
    workflowDigestBindings.add(digestBinding);
    for (const projectId of workflow.projects) {
      const project = projectById.get(projectId);
      if (project === undefined) schemaError(`${subject}.workflows`, `引用未注册 project '${projectId}'`);
      if (!project.backendInstanceIds.includes(workflow.backendInstanceId)) {
        schemaError(`${subject}.workflows`, `project '${projectId}' 未授权 workflow backend`);
      }
    }
    const backend = backendById.get(workflow.backendInstanceId)!;
    if (workflow.inputPolicy === "scoped-staging" && backend.kind === "comfyui") {
      schemaError(
        `${subject}.workflows`,
        "scoped-staging workflow 禁止绑定 raw comfyui development backend；必须使用 scope-bound production-gateway",
      );
    }
    if (workflow.inputPolicy === "scoped-staging") {
      const profile = profileById.get(workflow.stagingProfileId!);
      if (profile === undefined) schemaError(`${subject}.workflows`, "引用未注册 stagingProfileId");
      if (workflowBindingKey(profile.execution) !== key) {
        schemaError(`${subject}.workflows`, "staging profile execution 与 immutable workflow tuple 不匹配");
      }
      if (backend.kind === "production-gateway" && backend.profileId !== profile.profileId) {
        schemaError(`${subject}.workflows`, "job gateway profileId 与 staging profileId 不匹配");
      }
      validateH3GraphContractExpectations(workflow, profile, `${subject}.workflows`);
      usedProfiles.add(profile.profileId);
    }
  }
  if (usedProfiles.size !== stagingProfiles.length) {
    schemaError(`${subject}.stagingProfiles`, "不得注册未被 scoped-staging workflow 引用的 profile");
  }
  return Object.freeze({
    version: 1,
    workspaceId: safeString(row.workspaceId, WORKSPACE_ID_PATTERN, `${subject}.workspaceId`),
    projects: Object.freeze(projects),
    backends: Object.freeze(backends),
    gateway: parseGateway(row.gateway),
    workflows: Object.freeze(workflows),
    stagingProfiles: Object.freeze(stagingProfiles),
    runner: parseRunner(row.runner),
  });
}

export function loadProductionRuntimeConfig(
  configFile: string,
  options: LoadProductionRuntimeConfigOptions = {},
): ProductionRuntimeConfig {
  const limit = boundedReadLimit(
    options.maxConfigBytes, DEFAULT_PRODUCTION_RUNTIME_CONFIG_BYTES,
    DEFAULT_PRODUCTION_RUNTIME_CONFIG_BYTES, "ProductionRuntimeConfig maxConfigBytes",
  );
  const file = resolve(configFile);
  const text = readPrivateRegularTextExact(file, limit, options.readHooks);
  if (text === null) {
    throw new ProductionRuntimeConfigError(
      "config-unreadable",
      "production runtime config 必须是未变化的单链接普通 UTF-8 文件，且不得超过读取上限",
    );
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    throw new ProductionRuntimeConfigError("config-invalid-json", "production runtime config 不是有效 JSON");
  }
  return parseProductionRuntimeConfig(value);
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

function workflowBindingKey(value: {
  backendInstanceId: string;
  workflowSha256: string;
  modelFamily: ProductionModelFamily;
  modelSha256: string;
  parametersSha256: string;
}): string {
  return JSON.stringify([
    value.backendInstanceId,
    value.workflowSha256,
    value.modelFamily,
    value.modelSha256,
    value.parametersSha256,
  ]);
}

function executionIdentityKey(value: ProductionIntentExecution): string {
  return JSON.stringify(value);
}

function assertWorkflowH3GraphContract(
  config: ProductionRuntimeWorkflowConfig,
  profile: ProductionRuntimeStagingProfileConfig | null,
  workflow: Record<string, unknown>,
): void {
  if (config.modelFamily !== "minimax-h3") return;
  const contract = config.h3GraphContract;
  if (contract === null || profile === null || profile.bindings.kind !== "h3-graph-bindings") {
    throw new ProductionRuntimeConfigError("workflow-invalid", "H3 workflow 缺少 graph contract/staging profile");
  }
  try { assertProductionH3Template(workflow, contract, profile.execution, profile.bindings.bindings, profile.profileId); }
  catch (error) {
    if (error instanceof ProductionH3GraphError) {
      throw new ProductionRuntimeConfigError("workflow-invalid", error.message);
    }
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("production runtime aborted");
  error.name = "AbortError";
  throw error;
}

function canonicalNow(now: () => Date | string): string {
  const value = now();
  const text = value instanceof Date ? value.toISOString() : value;
  const millis = typeof text === "string" ? Date.parse(text) : Number.NaN;
  if (typeof text !== "string" || text.length > 64 || !Number.isFinite(millis)
    || new Date(millis).toISOString() !== text) {
    throw new ProductionRuntimeConfigError("config-invalid-schema", "runtime clock 必须返回规范 UTC ISO-8601 时间");
  }
  return text;
}

function secretFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string | null,
): string | null {
  if (name === null) return null;
  const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ProductionRuntimeConfigError("credential-unavailable", `credential environment '${name}' 不可用`);
  }
  return value;
}

class MapAdapterRegistry implements ProductionAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, ProductionAdapter>;

  constructor(entries: Iterable<readonly [string, ProductionAdapter]>) {
    this.#adapters = new Map(entries);
  }

  resolve(backendInstanceId: string): ProductionAdapter | null {
    return this.#adapters.get(backendInstanceId) ?? null;
  }
}

class LocalIntentResolver implements ProductionIntentResolver {
  readonly #root: string;
  readonly #project: string;

  constructor(root: string, project: string) {
    this.#root = root;
    this.#project = project;
  }

  async resolve(taskId: string, signal?: AbortSignal): Promise<ProductionDispatchIntent | null> {
    throwIfAborted(signal);
    const result = readProductionIntent(this.#root, this.#project, taskId);
    throwIfAborted(signal);
    return result;
  }
}

type WorkflowFileBinding = {
  config: ProductionRuntimeWorkflowConfig;
  profile: ProductionRuntimeStagingProfileConfig | null;
  absoluteFile: string;
};

class ImmutableWorkflowRegistry implements ProductionWorkflowResolver {
  readonly #bindings: ReadonlyMap<string, WorkflowFileBinding>;
  readonly #configDirectory: string;
  readonly #maxBytes: number;
  readonly #hooks: Readonly<Record<string, ExactReadHooks | undefined>>;

  constructor(
    configDirectory: string,
    workflows: readonly ProductionRuntimeWorkflowConfig[],
    stagingProfiles: readonly ProductionRuntimeStagingProfileConfig[],
    maxBytes: number,
    hooks: Readonly<Record<string, ExactReadHooks | undefined>>,
  ) {
    this.#configDirectory = configDirectory;
    this.#maxBytes = maxBytes;
    this.#hooks = hooks;
    const profileById = new Map(stagingProfiles.map((profile) => [profile.profileId, profile] as const));
    this.#bindings = new Map(workflows.map((config) => {
      const absoluteFile = resolve(configDirectory, config.file);
      const containment = relative(configDirectory, absoluteFile);
      if (isAbsolute(containment) || containment === ".." || containment.startsWith(`..${sep}`)) {
        throw new ProductionRuntimeConfigError("config-invalid-schema", "workflow file 超出 runtime config 目录");
      }
      const profile = config.stagingProfileId === null ? null : profileById.get(config.stagingProfileId) ?? null;
      return [workflowBindingKey(config), { config, profile, absoluteFile }] as const;
    }));
  }

  #read(binding: WorkflowFileBinding, signal?: AbortSignal): ProductionWorkflowDescriptor {
    throwIfAborted(signal);
    const parts = binding.config.file.split("/");
    if (hasSymlinkComponent(this.#configDirectory, parts)) {
      throw new ProductionRuntimeConfigError("workflow-unreadable", "workflow 路径不得包含 symlink component");
    }
    const text = readPrivateRegularTextExact(
      binding.absoluteFile,
      this.#maxBytes,
      Object.prototype.hasOwnProperty.call(this.#hooks, binding.config.file)
        ? this.#hooks[binding.config.file] ?? {}
        : {},
    );
    if (text === null || hasSymlinkComponent(this.#configDirectory, parts)) {
      throw new ProductionRuntimeConfigError(
        "workflow-unreadable",
        "workflow 必须是未变化的单链接普通 UTF-8 文件，且不得超过读取上限",
      );
    }
    throwIfAborted(signal);
    let workflow: unknown;
    try { workflow = JSON.parse(text); }
    catch { throw new ProductionRuntimeConfigError("workflow-invalid", "registered workflow 不是有效 JSON"); }
    if (!isRecord(workflow) || Object.keys(workflow).length < 1) {
      throw new ProductionRuntimeConfigError("workflow-invalid", "registered workflow 必须是非空 JSON 对象");
    }
    if (productionWorkflowSha256(workflow) !== binding.config.workflowSha256) {
      throw new ProductionRuntimeConfigError("workflow-invalid", "registered workflow digest 与 immutable binding 不匹配");
    }
    assertWorkflowH3GraphContract(binding.config, binding.profile, workflow);
    return {
      version: 1,
      workflow,
      modelFamily: binding.config.modelFamily,
      modelSha256: binding.config.modelSha256,
      parametersSha256: binding.config.parametersSha256,
    };
  }

  assertAllReadable(): void {
    for (const binding of this.#bindings.values()) this.#read(binding);
  }

  async resolve(intent: ProductionDispatchIntent, signal?: AbortSignal): Promise<ProductionWorkflowDescriptor | null> {
    // Deliberately return the pinned graph byte-semantics unchanged. Consuming intent.inputs here
    // would silently introduce an unaudited upload/template protocol and overstate H3 integration.
    const binding = this.#bindings.get(workflowBindingKey(intent.execution));
    return binding === undefined ? null : this.#read(binding, signal);
  }
}

class ScopedWorkflowResolver implements ProductionWorkflowResolver {
  readonly #base: ProductionWorkflowResolver;
  readonly #allowedBindings: ReadonlySet<string>;

  constructor(base: ProductionWorkflowResolver, allowed: readonly ProductionRuntimeWorkflowConfig[]) {
    this.#base = base;
    this.#allowedBindings = new Set(allowed.map(workflowBindingKey));
  }

  resolve(intent: ProductionDispatchIntent, signal?: AbortSignal): Promise<ProductionWorkflowDescriptor | null> {
    if (!this.#allowedBindings.has(workflowBindingKey(intent.execution))) return Promise.resolve(null);
    return this.#base.resolve(intent, signal);
  }
}

class ExactWorkflowBindingVerifier implements ProductionWorkflowBindingVerifier {
  readonly #profile: ProductionRuntimeStagingProfileConfig;
  readonly #workflowConfig: ProductionRuntimeWorkflowConfig;
  readonly #executionKey: string;

  constructor(profile: ProductionRuntimeStagingProfileConfig, workflowConfig: ProductionRuntimeWorkflowConfig) {
    this.#profile = profile;
    this.#workflowConfig = workflowConfig;
    this.#executionKey = executionIdentityKey(profile.execution);
  }

  async verify(
    intent: ProductionDispatchIntent,
    workflow: Record<string, unknown>,
    staged: ProductionInputStageResult,
    signal?: AbortSignal,
  ): Promise<ProductionWorkflowBindingVerification> {
    throwIfAborted(signal);
    const declared = this.#profile.bindings;
    // H3 的绑定契约逐条对应一个图节点，数量恒定；云家族的 slotPolicy 是计数区间（同一 profile 承载
    // i2v 与 fl2v 等镜头），因此只先按 [Σmin, Σmax] 做界限检查，顺序与逐 slot 计数交给下面的判据。
    const stagedCountValid = declared.kind === "h3-graph-bindings"
      ? staged.bindings.length === declared.bindings.length
      : staged.bindings.length >= declared.slots.reduce((sum, slot) => sum + slot.minCount, 0)
        && staged.bindings.length <= declared.slots.reduce((sum, slot) => sum + slot.maxCount, 0);
    const templateWorkflowSha256 = productionWorkflowSha256(workflow);
    if (executionIdentityKey(intent.execution) !== this.#executionKey
      || templateWorkflowSha256 !== intent.execution.workflowSha256
      || templateWorkflowSha256 !== this.#workflowConfig.workflowSha256
      || !stagedCountValid) {
      throw new ProductionRuntimeConfigError("workflow-invalid", "staging profile 与 immutable execution/workflow 不匹配");
    }
    if (declared.kind === "provider-slot-policy") {
      // 云家族没有可材料化的图：注册的 workflow 就是 execution profile 快照，template 即 bound。
      // 这里按 slotPolicy 的顺序与计数区间核对 staged.bindings；ShotRequest 的内容校验在 stage kernel。
      const sequenceViolation = providerSlotSequenceViolation(
        declared.slots,
        staged.bindings.map((binding) => binding.slot as ProviderInputSlot),
      );
      if (sequenceViolation !== null) {
        throw new ProductionRuntimeConfigError(
          "workflow-invalid", `staged slot 不满足 profile slotPolicy：${sequenceViolation}`,
        );
      }
      throwIfAborted(signal);
      return {
        version: 1,
        verified: true,
        templateWorkflowSha256,
        boundWorkflowSha256: templateWorkflowSha256,
        workflow,
        stageKey: staged.stageKey,
        bindingsDigest: staged.bindingsDigest,
      };
    }
    const contract = this.#workflowConfig.h3GraphContract;
    if (contract === null) throw new ProductionRuntimeConfigError("workflow-invalid", "H3 graph contract 缺失");
    let materialized;
    try {
      materialized = materializeProductionH3Workflow(
        workflow,
        contract,
        this.#profile.execution,
        declared.bindings,
        staged.bindings,
        this.#profile.profileId,
      );
    } catch (error) {
      if (error instanceof ProductionH3GraphError) {
        throw new ProductionRuntimeConfigError("workflow-invalid", error.message);
      }
      throw error;
    }
    throwIfAborted(signal);
    return {
      version: 1,
      verified: true,
      templateWorkflowSha256: materialized.templateWorkflowSha256,
      boundWorkflowSha256: materialized.boundWorkflowSha256,
      workflow: materialized.workflow,
      stageKey: staged.stageKey,
      bindingsDigest: staged.bindingsDigest,
    };
  }
}

type RuntimePipelineBinding = Readonly<{
  workflowKey: string;
  executionKey: string | null;
  pipeline: ProductionInputPipeline;
}>;

class ConfiguredInputPipelineResolver implements ProductionInputPipelineResolver {
  readonly #bindings: ReadonlyMap<string, RuntimePipelineBinding>;

  constructor(bindings: readonly RuntimePipelineBinding[]) {
    this.#bindings = new Map(bindings.map((binding) => [binding.workflowKey, binding]));
  }

  async resolve(intent: ProductionDispatchIntent, signal?: AbortSignal): Promise<ProductionInputPipeline | null> {
    throwIfAborted(signal);
    const binding = this.#bindings.get(workflowBindingKey(intent.execution));
    if (binding === undefined
      || (binding.executionKey !== null && binding.executionKey !== executionIdentityKey(intent.execution))) {
      return null;
    }
    return binding.pipeline;
  }
}

class StaticGateContextResolver implements ProductionGateContextResolver {
  readonly #project: ProductionRuntimeProjectConfig;
  readonly #now: () => Date | string;

  constructor(project: ProductionRuntimeProjectConfig, now: () => Date | string) {
    this.#project = project;
    this.#now = now;
  }

  async resolve(
    _intent: ProductionDispatchIntent,
    _task: Parameters<ProductionGateContextResolver["resolve"]>[1],
    signal?: AbortSignal,
  ): Promise<ProductionIntentGateContext> {
    throwIfAborted(signal);
    return {
      version: 1,
      evaluatedAt: canonicalNow(this.#now),
      deploymentTerritories: [...this.#project.deploymentTerritories],
      availableBudgetMicros: this.#project.availableBudgetMicros,
    };
  }
}

function validateWorkspaceRoot(rootValue: string): string {
  let root: string;
  try { root = realpathSync(resolve(rootValue)); }
  catch { throw new ProductionRuntimeConfigError("config-invalid-schema", "production workspace root 不存在"); }
  let state: ReturnType<typeof lstatSync>;
  try { state = lstatSync(resolve(root, ".writing-loop")); }
  catch { throw new ProductionRuntimeConfigError("config-invalid-schema", "production workspace 缺少 .writing-loop 目录"); }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new ProductionRuntimeConfigError("config-invalid-schema", ".writing-loop 必须是真实目录");
  }
  return root;
}

function validateWorkspaceBindings(root: string, config: ProductionRuntimeConfig): ReadonlyMap<string, boolean> {
  let durableId: string;
  try { durableId = readWorkspaceIdentity(root).id; }
  catch {
    throw new ProductionRuntimeConfigError("config-invalid-schema", "无法读取 durable workspace identity");
  }
  if (durableId !== config.workspaceId) {
    throw new ProductionRuntimeConfigError("config-invalid-schema", "runtime config workspaceId 与 durable workspace identity 不匹配");
  }
  const workspaceConfigFile = join(root, ".writing-loop", "config.json");
  const raw = readRegularTextExact(workspaceConfigFile, 4 * 1024 * 1024);
  if (raw === null) {
    throw new ProductionRuntimeConfigError("config-invalid-schema", "workspace config 必须是有界单链接普通 UTF-8 JSON 文件");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new ProductionRuntimeConfigError("config-invalid-schema", "workspace config 不是有效 JSON"); }
  if (!isRecord(value) || !isRecord(value.projects)) {
    throw new ProductionRuntimeConfigError("config-invalid-schema", "workspace config.projects 必须是对象");
  }
  const enabledByProject = new Map<string, boolean>();
  for (const project of config.projects) {
    const registered = Object.prototype.hasOwnProperty.call(value.projects, project.project)
      ? value.projects[project.project]
      : undefined;
    if (!isRecord(registered)) {
      throw new ProductionRuntimeConfigError(
        "config-invalid-schema", `runtime project '${project.project}' 未在 workspace config 注册`,
      );
    }
    if (registered.enabled !== undefined && typeof registered.enabled !== "boolean") {
      throw new ProductionRuntimeConfigError(
        "config-invalid-schema", `workspace project '${project.project}'.enabled 必须是 boolean`,
      );
    }
    enabledByProject.set(project.project, registered.enabled !== false);
    let state: ReturnType<typeof lstatSync>;
    try { state = lstatSync(join(root, ".writing-loop", project.project)); }
    catch {
      throw new ProductionRuntimeConfigError("config-invalid-schema", `runtime project '${project.project}' 状态目录不存在`);
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new ProductionRuntimeConfigError("config-invalid-schema", `runtime project '${project.project}' 状态目录必须是真实目录`);
    }
  }
  return enabledByProject;
}

/** Build all private adapters/resolvers once from a trusted local registry. No network call occurs. */
export function createProductionRuntimeRegistry(
  options: CreateProductionRuntimeRegistryOptions,
): ProductionRuntimeInstanceRegistry {
  const root = validateWorkspaceRoot(options.root);
  const configFile = resolve(options.configFile);
  const config = loadProductionRuntimeConfig(configFile, options);
  const workspaceProjectEnabled = validateWorkspaceBindings(root, config);
  const env = options.env ?? process.env;
  const maxWorkflowBytes = boundedReadLimit(
    options.maxWorkflowBytes,
    DEFAULT_PRODUCTION_RUNTIME_WORKFLOW_BYTES,
    DEFAULT_PRODUCTION_RUNTIME_WORKFLOW_BYTES,
    "ProductionRuntimeConfig maxWorkflowBytes",
  );

  // Fail at assembly instead of converting a missing server secret into repeated remote failures.
  for (const backend of config.backends) secretFromEnvironment(env, backend.credentialEnv);
  secretFromEnvironment(env, config.gateway.credentialEnv);
  for (const profile of config.stagingProfiles) secretFromEnvironment(env, profile.credentialEnv);

  const backendById = new Map(config.backends.map((backend) => [backend.backendInstanceId, backend] as const));
  const directAdapters = new Map(config.backends.flatMap((backend) => {
    if (backend.kind !== "comfyui") return [];
    const configuredFetch = options.fetchByBackend !== undefined
      && Object.prototype.hasOwnProperty.call(options.fetchByBackend, backend.backendInstanceId)
      ? options.fetchByBackend[backend.backendInstanceId]
      : undefined;
    const adapter = new ComfyUiAdapter({
      baseUrl: backend.baseUrl,
      backendInstanceId: backend.backendInstanceId,
      preferJobsApi: backend.preferJobsApi,
      fetch: configuredFetch ?? fetch,
    });
    return [[backend.backendInstanceId, adapter] as const];
  }));
  // A gateway adapter is scope-bound and therefore never appears in this unscoped registry.
  const adapterRegistry = new MapAdapterRegistry(directAdapters);

  const workflowResolver = new ImmutableWorkflowRegistry(
    dirname(configFile), config.workflows, config.stagingProfiles,
    maxWorkflowBytes, options.workflowReadHooks ?? {},
  );
  // The same exact, inode/path-revalidated read is repeated on every dispatch, so post-start drift
  // also fails closed. This startup pass reports invalid deployment artifacts before any request.
  workflowResolver.assertAllReadable();
  const stagingProfileById = new Map(
    config.stagingProfiles.map((profile) => [profile.profileId, profile] as const),
  );

  const now = options.now ?? (() => new Date());
  const projects: ProductionRuntimeProjectRegistration[] = config.projects
    .map((project) => {
      const projectAdapters = project.backendInstanceIds.map((backendInstanceId) => {
        const backend = backendById.get(backendInstanceId);
        if (backend === undefined) {
          throw new ProductionRuntimeConfigError("config-invalid-schema", "project backend binding 在 assembly 时丢失");
        }
        if (backend.kind === "comfyui") {
          const adapter = directAdapters.get(backend.backendInstanceId);
          if (adapter === undefined) {
            throw new ProductionRuntimeConfigError("config-invalid-schema", "direct ComfyUI adapter 在 assembly 时丢失");
          }
          return [backend.backendInstanceId, adapter] as const;
        }
        const configuredFetch = options.fetchByBackend !== undefined
          && Object.prototype.hasOwnProperty.call(options.fetchByBackend, backend.backendInstanceId)
          ? options.fetchByBackend[backend.backendInstanceId]
          : undefined;
        const adapter = new ProductionGatewayAdapter({
          baseUrl: backend.baseUrl,
          workspaceId: config.workspaceId,
          project: project.project,
          backendInstanceId: backend.backendInstanceId,
          profileId: backend.profileId,
          credentialResolver: (signal) => {
            throwIfAborted(signal);
            const secret = secretFromEnvironment(env, backend.credentialEnv);
            if (secret === null) {
              throw new ProductionRuntimeConfigError("credential-unavailable", "production gateway credential 不可用");
            }
            return secret;
          },
          fetch: configuredFetch ?? fetch,
        });
        return [backend.backendInstanceId, adapter] as const;
      });
      const scopedAdapterRegistry = new MapAdapterRegistry(projectAdapters);
      const intentResolver = new LocalIntentResolver(root, project.project);
      const authorizedWorkflows = config.workflows.filter((workflow) => workflow.projects.includes(project.project));
      const scopedWorkflowResolver = new ScopedWorkflowResolver(workflowResolver, authorizedWorkflows);
      const gateContextResolver = new StaticGateContextResolver(project, now);
      const scope = Object.freeze({
        workspaceId: config.workspaceId,
        project: project.project,
      });
      const stagedPipelines = new Map<string, ProductionInputPipeline>();
      const inputPipelineResolver = new ConfiguredInputPipelineResolver(authorizedWorkflows.map((workflow) => {
        if (workflow.inputPolicy === "static-pre-staged") {
          return Object.freeze({
            workflowKey: workflowBindingKey(workflow),
            executionKey: null,
            pipeline: Object.freeze({ version: 1 as const, policy: "static-pre-staged" as const }),
          });
        }
        const stagedBackend = backendById.get(workflow.backendInstanceId);
        if (stagedBackend === undefined || stagedBackend.kind === "comfyui") {
          throw new ProductionRuntimeConfigError(
            "config-invalid-schema",
            "scoped-staging workflow 只能装配 scope-bound production-gateway adapter",
          );
        }
        const profile = stagingProfileById.get(workflow.stagingProfileId!);
        if (profile === undefined) {
          throw new ProductionRuntimeConfigError("config-invalid-schema", "staging profile 在 assembly 时丢失");
        }
        let pipeline = stagedPipelines.get(profile.profileId);
        if (pipeline === undefined) {
          const configuredStageFetch = options.stagingFetchByProfile !== undefined
            && Object.prototype.hasOwnProperty.call(options.stagingFetchByProfile, profile.profileId)
            ? options.stagingFetchByProfile[profile.profileId]
            : undefined;
          const inputStager: ProductionInputStager = new HttpProductionInputStager({
            baseUrl: profile.baseUrl,
            workspaceId: scope.workspaceId,
            project: scope.project,
            allowInsecureLoopback: new URL(profile.baseUrl).protocol === "http:",
            fetch: configuredStageFetch ?? fetch,
            credentialResolver: profile.credentialEnv === null ? undefined : (signal) => {
              throwIfAborted(signal);
              return secretFromEnvironment(env, profile.credentialEnv);
            },
          });
          pipeline = Object.freeze({
            version: 1,
            policy: "scoped-staging",
            inputStager,
            workflowBindingVerifier: new ExactWorkflowBindingVerifier(profile, workflow),
          });
          stagedPipelines.set(profile.profileId, pipeline);
        }
        return Object.freeze({
          workflowKey: workflowBindingKey(workflow),
          executionKey: executionIdentityKey(profile.execution),
          pipeline,
        });
      }));
      const ingestor = new HttpProductionArtifactIngestor({
        baseUrl: config.gateway.baseUrl,
        workspaceId: config.workspaceId,
        project: project.project,
        allowInsecureLoopback: new URL(config.gateway.baseUrl).protocol === "http:",
        fetch: options.gatewayFetch ?? fetch,
        credentialResolver: config.gateway.credentialEnv === null ? undefined : (context, signal) => {
          throwIfAborted(signal);
          if (context.workspaceId !== config.workspaceId || context.project !== project.project
            || context.operation !== "ingest") {
            throw new ProductionRuntimeConfigError("config-invalid-schema", "ingestor credential scope 漂移");
          }
          return secretFromEnvironment(env, config.gateway.credentialEnv);
        },
      });
      const allowDispatch = project.enabled && workspaceProjectEnabled.get(project.project) === true;
      return Object.freeze({
        project: project.project,
        config: project,
        backendInstanceIds: project.backendInstanceIds,
        adapterRegistry: scopedAdapterRegistry,
        intentResolver,
        workflowResolver: scopedWorkflowResolver,
        gateContextResolver,
        inputPipelineResolver,
        ingestor,
        allowDispatch,
        run: (signal?: AbortSignal) => runProductionProjectOnce({
          root,
          workspaceId: config.workspaceId,
          project: project.project,
          adapterRegistry: scopedAdapterRegistry,
          intentResolver,
          workflowResolver: scopedWorkflowResolver,
          gateContextResolver,
          inputPipelineResolver,
          ingestor,
          allowDispatch,
          now,
          signal,
        }),
      });
    });
  const runner = new ProductionRunner({
    projects,
    projectConcurrency: config.runner.projectConcurrency,
    perBackendConcurrency: config.runner.perBackendConcurrency,
    intervalMs: config.runner.intervalMs,
    now,
  });
  return Object.freeze({
    config,
    adapterRegistry,
    workflowResolver,
    projects: Object.freeze(projects),
    runner,
  });
}
