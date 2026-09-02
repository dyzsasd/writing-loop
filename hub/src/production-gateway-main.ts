#!/usr/bin/env node
// Server-only private production gateway process (§8.2).
//
// It assembles the three kernels — jobs, stages and ingests — in one process on the GPU VM, binds
// them to a literal private IP behind one static bearer, and serves them from the strict router.
// Every provider origin, credential, template graph and price table stays inside the owner-only
// registry config; no HTTP caller can name a URL, a workflow or a model. TLS termination is out of
// scope by design: the worker reaches this endpoint over the VPC's private network (§8.0, §9.4).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ComfyUiAdapter, type ProductionAdapter } from "./production-adapter.ts";
import type { AssetRef } from "./production-domain.ts";
import {
  ProductionGateway,
  probeProductionFfmpeg,
  productionFfmpegLastFrameExtractor,
  productionGatewayBlobPath,
  type ProductionLastFrameExtractor,
} from "./production-gateway.ts";
import {
  ProductionGatewayRouter,
  startProductionGatewayRouter,
  type ProductionGatewayRouteHandler,
  type ProductionGatewayRouterServer,
} from "./production-gateway-router.ts";
import {
  ProductionGatewayRuntimeConfigError,
  exportExecutionProfileSnapshot,
  loadProductionGatewayRuntimeConfig,
  productionGatewayH3Profiles,
  productionGatewayProcessingRegions,
  readProductionGatewayWorkflow,
  type ProductionGatewayExecutionProfileConfig,
  type ProductionGatewayRuntimeConfig,
  type ProductionGatewayStageProfileConfig,
} from "./production-gateway-runtime-config.ts";
import {
  ProductionJobGateway,
  type ProductionJobProfile,
  type ProductionJobProfileRegistry,
  type ProductionJobScope,
  type ProductionJobStorageAdmissionContext,
  type ProductionJobStorageAdmissionDecision,
  type ProductionJobStorageAdmissionPolicy,
  type ProductionJobStorageReleaseDecision,
  type ProductionSubmissionAdmissionContext,
  type ProductionSubmissionAdmissionDecision,
  type ProductionSubmissionAdmissionOutcome,
  type SubmissionAdmissionPolicy,
  productionJobStorageKey,
} from "./production-job-gateway.ts";
import type { ProductionInputStageScope } from "./production-input-stager.ts";
import {
  ProductionStageGateway,
  productionStageProfileDigest,
  type ProductionStageAssetResolver,
  type ProductionStageAssetSource,
  type ProductionStageProfile,
  type ProductionStageProfileLookup,
  type ProductionStageProfileRegistry,
} from "./production-stage-gateway.ts";
import { productionCanonicalJson } from "./production-canonical-json.ts";
import { readRegularTextExact } from "./bounded-fs.ts";

export const PRODUCTION_GATEWAY_JOBS_SUBDIR = "jobs";
export const PRODUCTION_GATEWAY_STORAGE_ADMISSION_SUBDIR = "storage-admission";
/** Durable slot cap for one gateway instance; the per-scope shape of the cap is the slot itself. */
export const DEFAULT_PRODUCTION_GATEWAY_STORAGE_SLOTS = 100_000;

class ProductionGatewayMainUsageError extends Error {}

/** A host prerequisite the registry config cannot fix. Its message is operator-actionable text. */
export class ProductionGatewayMainDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionGatewayMainDependencyError";
  }
}

type GatewayMainOptions = {
  configFile: string;
  snapshotFile: string | null;
};

function usage(): void {
  console.log(`writing-loop-production-gateway — server-only 私有制片 gateway 进程
用法:
  writing-loop-production-gateway --config FILE
  writing-loop-production-gateway --config FILE --export-profile-snapshot OUT

FILE 必须是 owner-only (0400/0600) 的严格 registry 配置。进程把 jobs / stages / ingests 三个内核
装配在同一进程，绑定配置中的字面私网 IP，并对全部路由要求 Authorization: Bearer <auth.bearerEnv>。
--export-profile-snapshot 只导出只读 execution profile 快照后退出，不监听端口。
命令行不接受 endpoint、token、workflow、模型或价目覆盖。`);
}

function parseArgs(argv: string[]): GatewayMainOptions {
  let configFile: string | null = null;
  let snapshotFile: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--config") {
      if (configFile !== null) throw new ProductionGatewayMainUsageError("--config 只能指定一次");
      configFile = argv[++index] ?? null;
      if (!configFile) throw new ProductionGatewayMainUsageError("--config 需要 FILE");
    } else if (arg === "--export-profile-snapshot") {
      if (snapshotFile !== null) throw new ProductionGatewayMainUsageError("--export-profile-snapshot 只能指定一次");
      snapshotFile = argv[++index] ?? null;
      if (!snapshotFile) throw new ProductionGatewayMainUsageError("--export-profile-snapshot 需要 OUT");
    } else {
      throw new ProductionGatewayMainUsageError(`未知参数（位置 ${index + 1}）`);
    }
  }
  if (configFile === null) throw new ProductionGatewayMainUsageError("必须提供 --config FILE");
  return { configFile, snapshotFile };
}

function configError(message: string): never {
  throw new ProductionGatewayRuntimeConfigError("config-invalid-schema", message);
}

/**
 * The registry-owned bearer. It is read per request so a rotated `EnvironmentFile` takes effect at
 * the next systemd restart without any token ever entering the config file or a log line.
 */
function bearerFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096) {
    throw new ProductionGatewayRuntimeConfigError(
      "credential-unavailable",
      "gateway bearer credential 不可用（EnvironmentFile 未注入或长度不足 16）",
    );
  }
  return value;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    // Compare against itself so an early length mismatch still costs one full comparison.
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ version: 1, error: "unauthorized" }), {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": "Bearer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Bearer boundary in front of one kernel. The kernels each re-check the credential against their
 * own scoped resolver; this layer only guarantees that an unauthenticated request never reaches a
 * durable store, a provider fetch or a profile lookup.
 */
export class ProductionGatewayBearerHandler implements ProductionGatewayRouteHandler {
  readonly #inner: ProductionGatewayRouteHandler;
  readonly #bearer: () => string;

  constructor(inner: ProductionGatewayRouteHandler, bearer: () => string) {
    if (!inner || typeof inner.handle !== "function" || typeof inner.close !== "function"
      || typeof bearer !== "function") {
      throw new TypeError("production gateway bearer handler 配置无效");
    }
    this.#inner = inner;
    this.#bearer = bearer;
  }

  async handle(request: Request): Promise<Response> {
    const header = request.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) return unauthorized();
    let expected: string;
    try { expected = this.#bearer(); }
    catch { return unauthorized(); }
    if (!constantTimeEquals(header.slice("Bearer ".length), expected)) return unauthorized();
    return await this.#inner.handle(request);
  }

  close(): void { this.#inner.close(); }
}

type WorkflowTemplate = { workflow: Record<string, unknown>; workflowDigest: string };

/**
 * `productionStageProfileDigest` deliberately digests only execution semantics, the ordered slot
 * schema and the provider namespace; the registration scope/task/intent stay bound by the receipt
 * claim instead. The registry can therefore compute a profile's digest ahead of any request.
 */
function stageProfileDigestFor(
  profile: ProductionGatewayExecutionProfileConfig,
  stageProfile: ProductionGatewayStageProfileConfig,
): string {
  return productionStageProfileDigest({
    version: 1,
    registration: {
      version: 1,
      scope: { version: 1, workspaceId: "ws_00000000000000000000000000000000", project: "registry" },
      taskId: "registry",
      intentDigest: "0".repeat(64),
      execution: profile.intentExecution,
      inputs: [],
    },
    providerCasNamespace: stageProfile.providerCasNamespace,
    inputs: stageProfile.inputs.map((input) => ({
      version: 1,
      index: input.index,
      slot: input.slot,
      mediaTypes: [...input.mediaTypes],
    })),
  });
}

function stageProfileFor(
  lookup: Readonly<ProductionStageProfileLookup>,
  stageProfile: ProductionGatewayStageProfileConfig,
): ProductionStageProfile {
  return {
    version: 1,
    registration: structuredClone(lookup) as ProductionStageProfileLookup,
    providerCasNamespace: stageProfile.providerCasNamespace,
    inputs: stageProfile.inputs.map((input) => ({
      version: 1,
      index: input.index,
      slot: input.slot,
      mediaTypes: [...input.mediaTypes],
    })),
  };
}

type RegistryEntry = {
  profile: ProductionGatewayExecutionProfileConfig;
  stageProfile: ProductionGatewayStageProfileConfig;
  template: WorkflowTemplate;
  stageProfileDigest: string;
  executionKey: string;
};

/** Server-owned registry shared by the jobs and stages kernels. */
export class ProductionGatewayRegistry {
  readonly #byProfileId: ReadonlyMap<string, RegistryEntry>;
  readonly #byExecutionKey: ReadonlyMap<string, RegistryEntry>;

  constructor(entries: readonly RegistryEntry[]) {
    const byProfileId = new Map<string, RegistryEntry>();
    const byExecutionKey = new Map<string, RegistryEntry>();
    for (const entry of entries) {
      byProfileId.set(entry.profile.execution.profileId, entry);
      if (byExecutionKey.has(entry.executionKey)) {
        // Two profiles with the same immutable execution identity would make the stage kernel's
        // execution-keyed lookup ambiguous, and the coordinator's binding key non-unique.
        configError(`execution profile '${entry.profile.execution.profileId}' 与已登记 profile 的 execution identity 相同`);
      }
      byExecutionKey.set(entry.executionKey, entry);
    }
    this.#byProfileId = byProfileId;
    this.#byExecutionKey = byExecutionKey;
  }

  entry(profileId: string): RegistryEntry | null {
    return this.#byProfileId.get(profileId) ?? null;
  }

  resolveJobProfile(profileId: string): ProductionJobProfile | null {
    const entry = this.#byProfileId.get(profileId);
    if (entry === undefined) return null;
    return {
      version: 1,
      profileId,
      backendInstanceId: entry.profile.execution.backendInstanceId,
      workflowDigest: entry.template.workflowDigest,
      stageProfileDigest: entry.stageProfileDigest,
      execution: entry.profile.intentExecution,
      h3GraphContract: entry.profile.h3GraphContract,
      stageGraphBindings: entry.stageProfile.bindings,
      workflow: entry.template.workflow,
    };
  }

  resolveStageProfile(lookup: Readonly<ProductionStageProfileLookup>): ProductionStageProfile | null {
    const entry = this.#byExecutionKey.get(productionCanonicalJson(lookup.execution));
    if (entry === undefined) return null;
    if (lookup.inputs.length !== entry.stageProfile.inputs.length) return null;
    return stageProfileFor(lookup, entry.stageProfile);
  }

  /**
   * Fail-closed re-assertion that the profile the jobs kernel is about to materialize is byte-wise
   * the registry entry, not a mutated object that reached the kernel through a registry bug.
   */
  validate(_scope: Readonly<ProductionJobScope>, profile: Readonly<ProductionJobProfile>): boolean {
    const entry = this.#byProfileId.get(profile.profileId);
    if (entry === undefined) return false;
    return profile.backendInstanceId === entry.profile.execution.backendInstanceId
      && profile.workflowDigest === entry.template.workflowDigest
      && profile.stageProfileDigest === entry.stageProfileDigest
      && productionCanonicalJson(profile.execution) === entry.executionKey
      && productionCanonicalJson(profile.h3GraphContract) === productionCanonicalJson(entry.profile.h3GraphContract)
      && productionCanonicalJson(profile.stageGraphBindings) === productionCanonicalJson(entry.stageProfile.bindings);
  }
}

/**
 * Local CAS resolver for `cas://<authority>/sha256/<digest>` (§4.1). It only ever opens a path
 * derived from the AssetRef's own digest inside the gateway's ingest store, so a caller can never
 * steer the resolver at another file, and the stage kernel still re-verifies bytes and length.
 */
export class ProductionGatewayCasAssetResolver implements ProductionStageAssetResolver {
  readonly #authority: string;
  readonly #ingestRoot: string;

  constructor(authority: string, ingestRoot: string) {
    this.#authority = authority;
    this.#ingestRoot = ingestRoot;
  }

  async resolve(
    _scope: Readonly<ProductionInputStageScope>,
    asset: Readonly<AssetRef>,
    signal: AbortSignal,
  ): Promise<ProductionStageAssetSource> {
    if (signal.aborted) throw new Error("aborted");
    const url = new URL(asset.uri);
    if (url.protocol !== "cas:" || url.hostname.toLowerCase() !== this.#authority
      || url.pathname !== `/sha256/${asset.sha256}`) {
      throw new Error("cas asset identity mismatch");
    }
    const path = productionGatewayBlobPath(this.#ingestRoot, asset.sha256);
    // lstat, never stat: a symlink planted at the blob path must not let the stage kernel stream
    // (and hard-link into the provider CAS) a file outside the ingest store.
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("cas object is not a regular file");
    return {
      version: 1,
      assetSha256: asset.sha256,
      byteLength: info.size,
      mediaType: asset.mediaType,
      body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
    };
  }
}

type AdmissionSlot = {
  backendInstanceId: string;
  settled: boolean;
  decision: ProductionSubmissionAdmissionDecision;
};

/**
 * Per-backend concurrency authority (§4.7). The v1 deployment runs exactly one gateway process per
 * backend (§9.4), so an in-process idempotent record is the whole authority; a second process for
 * the same backend would need a durable shared store before this class may be reused.
 */
export class ProductionGatewayBackendAdmissionPolicy implements SubmissionAdmissionPolicy {
  readonly #maxConcurrent: number;
  readonly #slots = new Map<string, AdmissionSlot>();
  readonly #active = new Map<string, number>();

  constructor(maxConcurrentPerBackend: number) {
    this.#maxConcurrent = maxConcurrentPerBackend;
  }

  acquire(
    context: Readonly<ProductionSubmissionAdmissionContext>,
    admissionKey: string,
  ): ProductionSubmissionAdmissionDecision {
    const existing = this.#slots.get(admissionKey);
    if (existing !== undefined) return existing.decision;
    const active = this.#active.get(context.backendInstanceId) ?? 0;
    const decision: ProductionSubmissionAdmissionDecision = active >= this.#maxConcurrent ? "deny" : "allow";
    this.#slots.set(admissionKey, {
      backendInstanceId: context.backendInstanceId,
      settled: decision === "deny",
      decision,
    });
    if (decision === "allow") this.#active.set(context.backendInstanceId, active + 1);
    return decision;
  }

  settle(
    _context: Readonly<ProductionSubmissionAdmissionContext>,
    admissionKey: string,
    _outcome: Readonly<ProductionSubmissionAdmissionOutcome>,
  ): void {
    const slot = this.#slots.get(admissionKey);
    if (slot === undefined || slot.settled) return;
    slot.settled = true;
    const active = this.#active.get(slot.backendInstanceId) ?? 0;
    this.#active.set(slot.backendInstanceId, Math.max(0, active - 1));
  }
}

type StorageSlotRecord = {
  version: 1;
  context: ProductionJobStorageAdmissionContext;
  state: "pending" | "committed" | "released";
  recordRef: string | null;
};

/**
 * Durable per-scope/global job storage quota authority (AI-SPEC §9B). Slots live on the GPU VM's
 * persistent boot disk next to the job records, so a Spot preemption cannot silently free a slot
 * whose durable records survive the restart.
 */
export class ProductionGatewayDurableStorageAdmissionPolicy implements ProductionJobStorageAdmissionPolicy {
  readonly #root: string;
  readonly #maxSlots: number;

  constructor(root: string, maxSlots: number) {
    this.#root = root;
    this.#maxSlots = maxSlots;
  }

  #path(storageKey: string): string {
    if (!/^[a-f0-9]{64}$/.test(storageKey)) throw new Error("invalid storage key");
    return join(this.#root, `${storageKey}.json`);
  }

  #read(storageKey: string): StorageSlotRecord | null {
    const path = this.#path(storageKey);
    const text = readRegularTextExact(path, 64 * 1024);
    if (text !== null) return JSON.parse(text) as StorageSlotRecord;
    // An unreadable-but-present slot must never be mistaken for a free key: that would hand the
    // same quota slot to a second job and, worse, make a committed lifetime reservation releasable.
    if (existsSync(path)) throw new Error("storage admission slot unreadable");
    return null;
  }

  /**
   * Atomic slot publication: write a fresh random temporary, fsync it, then rename over the slot.
   * rename replaces the destination in one step, so no window exists in which a committed slot has
   * disappeared and could be re-acquired or released.
   */
  async #publish(storageKey: string, record: StorageSlotRecord): Promise<void> {
    const destination = this.#path(storageKey);
    const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, destination);
    const directory = await open(this.#root, "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  }

  async acquire(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
  ): Promise<ProductionJobStorageAdmissionDecision> {
    if (productionJobStorageKey(context.scope, context.idempotencyKey) !== storageKey
      || !Number.isSafeInteger(context.recordBytesUpperBound) || context.recordBytesUpperBound < 1) {
      throw new Error("invalid gateway storage context");
    }
    const exact = JSON.stringify(context);
    const existing = this.#read(storageKey);
    if (existing !== null) {
      if (JSON.stringify(existing.context) !== exact || existing.state === "released") return "conflict";
      return "allow";
    }
    // Batch sizes here are tens of jobs, so counting the slot directory is cheaper and safer than
    // a separate counter file that could itself drift from the slots it claims to count.
    const active = readdirSync(this.#root).filter((name) => name.endsWith(".json")).length;
    if (active + 1 > this.#maxSlots) return "capacity-exceeded";
    await this.#publish(storageKey, {
      version: 1,
      context: JSON.parse(exact) as ProductionJobStorageAdmissionContext,
      state: "pending",
      recordRef: null,
    });
    return "allow";
  }

  async commit(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    recordRef: string,
  ): Promise<void> {
    const existing = this.#read(storageKey);
    if (existing === null || JSON.stringify(existing.context) !== JSON.stringify(context)) {
      throw new Error("storage admission commit drift");
    }
    if (existing.state === "committed" && existing.recordRef === recordRef) return;
    if (existing.state === "released") throw new Error("storage admission commit after release");
    await this.#publish(storageKey, { ...existing, state: "committed", recordRef });
  }

  async release(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    reason: "unused-before-record",
  ): Promise<ProductionJobStorageReleaseDecision> {
    if (reason !== "unused-before-record") throw new Error("unsupported storage release reason");
    const existing = this.#read(storageKey);
    if (existing === null) return "released";
    if (JSON.stringify(existing.context) !== JSON.stringify(context)) return "conflict";
    if (existing.state === "committed") return "conflict";
    if (existing.state === "released") return "released";
    // The drift tombstone keeps the exact context binding so a late retry still conflicts.
    await this.#publish(storageKey, { ...existing, state: "released" });
    return "released";
  }
}

export type ProductionGatewayProcess = {
  config: ProductionGatewayRuntimeConfig;
  server: ProductionGatewayRouterServer;
  /** Result of the §7 restart sweep run before the listener opened. */
  recovery: { scanned: number; rewritten: number; unresolved: number };
  close(): Promise<void>;
};

export type StartProductionGatewayProcessOptions = {
  configFile: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the ComfyUI backend transport; production always uses the global fetch. */
  comfyFetchByBackend?: Readonly<Record<string, typeof fetch | undefined>>;
  /** Test seam for the tail-frame extractor; production always uses the system ffmpeg. */
  lastFrameExtractor?: ProductionLastFrameExtractor;
  /** Test seam for the assembly-time ffmpeg probe; production runs `ffmpeg -version`. */
  ffmpegProbe?: () => Promise<string>;
  /** Test seam for the jobs kernel per-operation deadline; production uses the kernel default. */
  jobTimeoutMs?: number;
  maxWorkflowBytes?: number;
  maxStorageSlots?: number;
};

export async function startProductionGatewayProcess(
  options: StartProductionGatewayProcessOptions,
): Promise<ProductionGatewayProcess> {
  const configFile = resolve(options.configFile);
  const config = loadProductionGatewayRuntimeConfig(configFile);
  const env = options.env ?? process.env;
  const bearer = (): string => bearerFromEnvironment(env, config.auth.bearerEnv);
  // Fail closed before any listener exists: an un-injected EnvironmentFile must not start a process
  // that answers 401 to its only client while looking healthy to systemd.
  bearer();

  const backendByProfileId = new Map<string, string>();
  for (const backend of config.backends) {
    for (const profileId of backend.profileIds) backendByProfileId.set(profileId, backend.backendInstanceId);
  }
  const entries: RegistryEntry[] = config.executionProfiles.map((profile) => {
    const stageProfile = config.stageProfiles.find((entry) => entry.stageProfileId === profile.stageProfileId);
    if (stageProfile === undefined) configError("stage profile 在装配时丢失");
    const template = readProductionGatewayWorkflow(config, configFile, profile.execution.profileId, {
      maxWorkflowBytes: options.maxWorkflowBytes,
    });
    return {
      profile,
      stageProfile,
      template: { workflow: template.workflow, workflowDigest: template.workflowDigest },
      stageProfileDigest: stageProfileDigestFor(profile, stageProfile),
      executionKey: productionCanonicalJson(profile.intentExecution),
    };
  });
  const registry = new ProductionGatewayRegistry(entries);

  // The parser already rejects a second backend (one raw adapter per process, §8.0).
  const backend = config.backends[0]!;
  // §4.3: the capability the coordinator reads is derived from the registry, not from a literal —
  // the same H3 profile set the read-only snapshot derives its limits from (§4.2).
  const rawAdapter: ProductionAdapter = new ComfyUiAdapter({
    baseUrl: backend.comfyBaseUrl,
    backendInstanceId: backend.backendInstanceId,
    processingRegions: productionGatewayProcessingRegions(config),
    h3Profiles: productionGatewayH3Profiles(config),
    maxInputImageBytes: backend.maxInputImageBytes,
    fetch: options.comfyFetchByBackend?.[backend.backendInstanceId],
  });
  if (backendByProfileId.size !== config.executionProfiles.length) {
    configError("execution profile 与 backend 绑定不完整");
  }

  // §5.3 tail frame: prove the host prerequisite before any kernel owns durable state, so a missing
  // ffmpeg is a start-up failure with a readable reason instead of a per-ingest failure later.
  const probe = options.ffmpegProbe ?? (() => probeProductionFfmpeg());
  try { await probe(); }
  catch (error) {
    throw new ProductionGatewayMainDependencyError(
      "ingest 内核要用系统 ffmpeg 从主视频派生尾帧（§5.3），但 `ffmpeg -version` 探针失败："
      + `${error instanceof Error ? error.name : "unknown"}。先在本机安装可用的 ffmpeg 再启动 gateway。`,
    );
  }

  const jobsRoot = join(config.jobStateRoot, PRODUCTION_GATEWAY_JOBS_SUBDIR);
  const admissionRoot = join(config.jobStateRoot, PRODUCTION_GATEWAY_STORAGE_ADMISSION_SUBDIR);
  await mkdir(admissionRoot, { recursive: true, mode: 0o700 });

  // Every kernel below owns durable state and, for the ingest kernel, in-flight provider fetches.
  // A partial assembly must therefore close what it already opened instead of leaking it.
  const started: Array<{ close(): void }> = [];
  const abandon = (): void => {
    for (const kernel of started.reverse()) {
      try { kernel.close(); }
      catch { /* shutdown is best-effort; every remaining kernel still receives close. */ }
    }
  };
  try {
    const stages = await ProductionStageGateway.create({
      storeRoot: config.objectsRoot,
      credentialResolver: () => bearer(),
      profileRegistry: {
        resolve: (lookup) => registry.resolveStageProfile(lookup),
      } satisfies ProductionStageProfileRegistry,
      assetResolver: new ProductionGatewayCasAssetResolver(config.casAuthority, config.ingestRoot),
      assetPolicies: [{ version: 1, scheme: "cas:", authority: config.casAuthority }],
    });
    started.push(stages);
    const jobs = await ProductionJobGateway.create({
      storeRoot: jobsRoot,
      credentialResolver: () => bearer(),
      profileRegistry: {
        resolve: (_scope, profileId) => registry.resolveJobProfile(profileId),
      } satisfies ProductionJobProfileRegistry,
      profileValidator: (scope, profile) => registry.validate(scope, profile),
      stageReceiptRegistry: stages,
      submissionAdmissionPolicy: new ProductionGatewayBackendAdmissionPolicy(
        config.admission.maxConcurrentPerBackend,
      ),
      storageAdmissionPolicy: new ProductionGatewayDurableStorageAdmissionPolicy(
        admissionRoot, options.maxStorageSlots ?? DEFAULT_PRODUCTION_GATEWAY_STORAGE_SLOTS,
      ),
      rawAdapter,
      ...(options.jobTimeoutMs === undefined ? {} : { timeoutMs: options.jobTimeoutMs }),
      hooks: {
        // §7: an undecided job stays pending and is retried at the next restart; say so, because the
        // aggregate counts alone do not tell the operator which job the sweep could not reach.
        afterJobRecovery: (fact) => {
          console.error(`production gateway: preemption sweep unresolved (${fact.reason})`);
        },
      },
    });
    started.push(jobs);
    // §7: a Spot preemption (or any ComfyUI restart) loses the provider's in-process history, so the
    // durable job records that were still pending/running are settled before the port opens — the
    // coordinator must never poll a job the provider can no longer account for.
    const recovery = await jobs.recoverPreemptedJobs();
    const ingests = await ProductionGateway.create({
      storeRoot: config.ingestRoot,
      comfyBaseUrl: backend.comfyBaseUrl,
      credentialResolver: () => bearer(),
      // §5.3: H3 does not return a tail frame, so the deployed process always derives one. A host
      // without a usable ffmpeg fails the ingest rather than silently registering a take whose
      // continuity frame the next shot needs (§6.4).
      lastFrameExtractor: options.lastFrameExtractor
        // Same filesystem as the CAS the frame lands in, so the extraction never crosses devices.
        ?? productionFfmpegLastFrameExtractor({ temporaryRoot: join(config.ingestRoot, "tmp") }),
      ...(options.comfyFetchByBackend?.[backend.backendInstanceId] === undefined
        ? {}
        : { fetch: options.comfyFetchByBackend[backend.backendInstanceId] }),
    });
    started.push(ingests);

    const router = new ProductionGatewayRouter({
      jobs: new ProductionGatewayBearerHandler(jobs, bearer),
      stages: new ProductionGatewayBearerHandler(stages, bearer),
      artifacts: new ProductionGatewayBearerHandler(ingests, bearer),
    });
    const server = await startProductionGatewayRouter(router, {
      bindHost: config.listen.host,
      bindPort: config.listen.port,
    });
    return {
      config,
      server,
      recovery,
      close: async () => { await server.close(); },
    };
  } catch (error) {
    abandon();
    throw error;
  }
}

/**
 * Atomic 0600 publication of the read-only snapshot: a pre-planted symlink at the destination is
 * refused rather than written through, and the rename makes a partially written snapshot
 * unobservable to the worker host that rsyncs it.
 */
async function writeSnapshot(config: ProductionGatewayRuntimeConfig, outFile: string): Promise<string> {
  const snapshot = exportExecutionProfileSnapshot(config);
  const destination = resolve(outFile);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (existsSync(destination)) {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new ProductionGatewayRuntimeConfigError(
        "config-invalid-schema", "snapshot 输出路径必须是普通文件，不接受 symlink 或目录",
      );
    }
  }
  const temporary = `${destination}.${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, destination);
  const directoryHandle = await open(directory, "r");
  try { await directoryHandle.sync(); }
  finally { await directoryHandle.close(); }
  return destination;
}

/**
 * Operator-actionable failure text without leaking a provider body, path or credential. Config and
 * usage errors are authored here and print verbatim; everything else prints only its class name and
 * a stable `code` (Node's `EADDRNOTAVAIL`/`EADDRINUSE`, a kernel's error code), never its message.
 */
function publicError(error: unknown): string {
  if (error instanceof ProductionGatewayMainUsageError
    || error instanceof ProductionGatewayMainDependencyError
    || error instanceof ProductionGatewayRuntimeConfigError) {
    return error.message;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const stableCode = typeof code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code)
      ? code
      : null;
    return stableCode === null
      ? `gateway-failed (${error.name})`
      : `gateway-failed (${error.name}: ${stableCode})`;
  }
  return "gateway-failed";
}

export type ProductionGatewayMainDependencies = {
  signalSource?: {
    once(signal: NodeJS.Signals, listener: () => void): unknown;
    off(signal: NodeJS.Signals, listener: () => void): unknown;
  } | null;
  start?: (options: StartProductionGatewayProcessOptions) => Promise<ProductionGatewayProcess>;
  env?: Readonly<Record<string, string | undefined>>;
};

export async function productionGatewayMain(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  dependencies: ProductionGatewayMainDependencies = {},
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")) {
    usage();
    return 0;
  }
  try {
    const options = parseArgs(argv);
    const configFile = resolve(cwd, options.configFile);
    if (options.snapshotFile !== null) {
      const config = loadProductionGatewayRuntimeConfig(configFile);
      // Prove every pinned graph before publishing its digest: a snapshot the worker trusts must
      // not name a `workflowSha256` whose graph is missing or has drifted on this host.
      for (const profile of config.executionProfiles) {
        readProductionGatewayWorkflow(config, configFile, profile.execution.profileId);
      }
      const written = await writeSnapshot(config, resolve(cwd, options.snapshotFile));
      console.log(`production gateway: execution profile snapshot → ${written}`);
      return 0;
    }
    const start = dependencies.start ?? startProductionGatewayProcess;
    const process_ = await start({
      configFile,
      ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    });
    console.log(
      `production gateway: listening on ${process_.server.address.host}:${process_.server.address.port}`
      + ` · ${process_.config.executionProfiles.length} execution profile(s)`
      + ` · preemption sweep ${process_.recovery.rewritten}/${process_.recovery.scanned} rewritten`
      + `, ${process_.recovery.unresolved} unresolved`,
    );
    const signalSource = dependencies.signalSource === undefined ? process : dependencies.signalSource;
    let resolveStop: (() => void) | null = null;
    const onSignal = (): void => resolveStop?.();
    try {
      await new Promise<void>((resolvePromise) => {
        resolveStop = resolvePromise;
        signalSource?.once("SIGINT", onSignal);
        signalSource?.once("SIGTERM", onSignal);
        if (signalSource === null) resolvePromise();
      });
    } finally {
      signalSource?.off("SIGINT", onSignal);
      signalSource?.off("SIGTERM", onSignal);
    }
    // A second signal while the kernels drain means the operator wants out now, not a longer wait.
    const hardExit = (): void => process.exit(130);
    signalSource?.once("SIGINT", hardExit);
    signalSource?.once("SIGTERM", hardExit);
    try { await process_.close(); }
    finally {
      signalSource?.off("SIGINT", hardExit);
      signalSource?.off("SIGTERM", hardExit);
    }
    return 0;
  } catch (error) {
    console.error(`writing-loop-production-gateway: ${publicError(error)}`);
    if (error instanceof ProductionGatewayMainUsageError) usage();
    return error instanceof ProductionGatewayMainUsageError ? 2 : 1;
  }
}

/**
 * npm installs a bin as a symlink and Node resolves an ESM entry to its realpath, so comparing
 * `import.meta.url` with the raw `process.argv[1]` is false under `~/.npm-global/bin/...` and the
 * process would exit 0 without ever starting. Compare realpaths instead.
 */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedAsMain()) {
  process.exitCode = await productionGatewayMain();
}
