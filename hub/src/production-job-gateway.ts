// Scope-bound private job proxy and writing-loop-side ProductionAdapter.
//
// This is a writing-loop-owned protocol, not an upstream ComfyUI/H3 API. Callers submit only a
// scope, preallocated job identity, profile identity and canonical workflow digest. The exact
// graph/model/custom-node selection comes from the server-owned profile registry and never crosses
// the HTTP request boundary.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseBackendCapabilities } from "./production-provider-adapter.ts";
import {
  ProductionAdapterError,
  type BackendCapabilities,
  type CancelResult,
  type FetchLike,
  type PreparedSubmission,
  type ProductionAdapter,
  type ProductionAdapterErrorCode,
  type RemoteJobState,
  type RemoteObservation,
  type RemoteOutputLocator,
  type ProductionSubmissionInputBinding,
  type SubmitRequest,
  type SubmitResult,
} from "./production-adapter.ts";
import {
  productionCanonicalJson,
  productionCanonicalJsonSha256,
} from "./production-canonical-json.ts";
import {
  PRODUCTION_SHOT_REQUEST_SLOT,
  productionInputBindingsDigest,
  type ProductionInputBinding,
  type ProductionStagedShotRequest,
} from "./production-input-stager.ts";
import {
  parseProductionIntentExecution,
  type ProductionIntentExecution,
} from "./production-intent.ts";
import {
  assertProductionH3Template,
  materializeProductionH3Workflow,
  parseProductionH3GraphContract,
  parseProductionH3StageBindingContract,
  type ProductionH3GraphContract,
  type ProductionH3ShotBinding,
  type ProductionH3StageBindingContract,
} from "./production-h3-graph.ts";
import type {
  ProductionStageReceiptClaim,
  ProductionStageReceiptRegistry,
  VerifiedStageReceipt,
} from "./production-stage-gateway.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_JOB_GATEWAY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PRODUCTION_JOB_GATEWAY_TIMEOUT_MS = 30_000;
export const DEFAULT_PRODUCTION_JOB_GATEWAY_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_PRODUCTION_JOB_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PRODUCTION_JOB_GATEWAY_RECORD_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PRODUCTION_JOB_GATEWAY_WORKFLOW_BYTES = 8 * 1024 * 1024;
/**
 * Durable records one job slot may own: request, admission request/decision, raw attempt, outcome,
 * the two settlement records, the §7 preemption and terminal verdicts, and one cancellation pair,
 * with margin. The storage authority reserves `maxRecordBytes × this` per slot.
 */
export const PRODUCTION_JOB_DURABLE_RECORDS_PER_SLOT = 14;

export type ProductionJobScope = {
  version: 1;
  workspaceId: string;
  project: string;
};

export type ProductionJobProfileRef = {
  version: 1;
  profileId: string;
  workflowDigest: string;
};

/** Exact PUT body. It deliberately has no URL/header/token/workflow/model-path field. */
export type ProductionJobPutRequest = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  idempotencyKey: string;
  profile: ProductionJobProfileRef;
  inputBinding: ProductionSubmissionInputBinding | null;
};

/** Exact cancellation PUT body. cancelKey is deterministic for one scope-bound job. */
export type ProductionJobCancellationRequest = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  cancelKey: string;
};

export type ProductionJobProfile = {
  version: 1;
  profileId: string;
  backendInstanceId: string;
  workflowDigest: string;
  /** Digest of the exact server-owned staging profile; null forbids staged inputs. */
  stageProfileDigest: string | null;
  /** Exact immutable H3 execution. Static profiles must use null. */
  execution: ProductionIntentExecution | null;
  /** Shared canonical H3 semantic graph contract. Static profiles must use null. */
  h3GraphContract: ProductionH3GraphContract | null;
  /** Ordered LoadImage source -> actual H3 generator consumer assertions. Static profiles use null. */
  stageGraphBindings: readonly ProductionH3StageBindingContract[] | null;
  /** Private server-owned template graph. It is never copied into a gateway HTTP response/request. */
  workflow: Record<string, unknown>;
};

export interface ProductionJobProfileRegistry {
  resolve(
    scope: Readonly<ProductionJobScope>,
    profileId: string,
    signal: AbortSignal,
  ): ProductionJobProfile | null | Promise<ProductionJobProfile | null>;
}

export type ProductionJobProfileValidator = (
  scope: Readonly<ProductionJobScope>,
  profile: Readonly<ProductionJobProfile>,
  signal: AbortSignal,
) => boolean | void | Promise<boolean | void>;

export type ProductionSubmissionAdmissionContext = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  requestDigest: string;
  idempotencyKey: string;
  profile: ProductionJobProfileRef;
  inputBinding: ProductionSubmissionInputBinding | null;
};

export type ProductionSubmissionAdmissionOutcome = {
  version: 1;
  state: "submitted" | "not-submitted" | "submission-unknown";
  submitResult: SubmitResult | null;
  errorCode: ProductionAdapterErrorCode | "internal" | null;
};

export type ProductionSubmissionAdmissionDecision = "allow" | "deny";

/**
 * Required fail-closed policy port. Both methods MUST be idempotent for admissionKey. Production
 * deployments should back them with a durable shared authority when more than one gateway process
 * can serve the same scope. A response-lost retry receives the exact same key and context/outcome.
 */
export interface SubmissionAdmissionPolicy {
  acquire(
    context: Readonly<ProductionSubmissionAdmissionContext>,
    admissionKey: string,
    signal: AbortSignal,
  ): ProductionSubmissionAdmissionDecision | Promise<ProductionSubmissionAdmissionDecision>;
  settle(
    context: Readonly<ProductionSubmissionAdmissionContext>,
    admissionKey: string,
    outcome: Readonly<ProductionSubmissionAdmissionOutcome>,
    signal: AbortSignal,
  ): void | Promise<void>;
}

export type ProductionJobStorageAdmissionContext = {
  version: 1;
  scope: ProductionJobScope;
  idempotencyKey: string;
  remoteJobId: string;
  requestDigest: string;
  /** Conservative upper bound for every durable record owned by this job slot. */
  recordBytesUpperBound: number;
};

export type ProductionJobStorageAdmissionDecision = "allow" | "capacity-exceeded" | "conflict";
export type ProductionJobStorageReleaseDecision = "released" | "conflict";

/**
 * Required durable storage authority. `acquire` MUST atomically bind storageKey to the exact
 * context before returning allow. Exact retries (including after process restart or response
 * loss) MUST return allow without consuming another slot/byte reservation. A different context
 * for an existing key MUST return conflict. New keys MUST enforce both per-scope job/byte limits
 * and deployment-global limits; an in-process counter is not a cluster authority. If a process
 * dies after acquire but before any record, the authority owns pending-slot TTL/manual audit;
 * the gateway never guesses that an unproven slot is safe to release.
 */
export interface ProductionJobStorageAdmissionPolicy {
  acquire(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    signal: AbortSignal,
  ): ProductionJobStorageAdmissionDecision | Promise<ProductionJobStorageAdmissionDecision>;
  /** Idempotently marks the slot non-releasable after its first exact durable job record exists. */
  commit(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    recordRef: string,
    signal: AbortSignal,
  ): void | Promise<void>;
  /**
   * Idempotently releases quota only when this key never published a job record. The authority
   * MUST treat an unknown/already-released exact key as a no-op, reject release after commit, and
   * retain the exact context binding as a drift tombstone.
   */
  release(
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
    reason: "unused-before-record",
    signal: AbortSignal,
  ): ProductionJobStorageReleaseDecision | Promise<ProductionJobStorageReleaseDecision>;
}

export type ProductionJobGatewayCredentialResolver = (
  context: Readonly<{
    scope: Readonly<ProductionJobScope>;
    operation: "put-job" | "inspect-job" | "cancel-job" | "read-capabilities";
  }>,
  signal: AbortSignal,
) => string | Promise<string>;

export type ProductionJobGatewayHooks = {
  /** Synchronous test hook immediately after link(temporary,destination), before temp unlink/fsync. */
  afterPublishLink?: (temporaryPath: string, destination: string) => void;
  /** Test/failpoint hook: durable storage authority allowed this exact slot; no store record exists. */
  afterStorageAdmission?: (
    context: Readonly<ProductionJobStorageAdmissionContext>,
    storageKey: string,
  ) => void | Promise<void>;
  /** Test/failpoint hook: the immutable request/outbox is already fsync'd. */
  afterJobDurable?: (request: Readonly<ProductionJobPutRequest>) => void | Promise<void>;
  /** Test/failpoint hook: strict prepared-submission digests are fsync'd, raw submit not called yet. */
  afterAttemptDurable?: (prepared: Readonly<PreparedSubmission>) => void | Promise<void>;
  /** Test/failpoint hook: the unique raw-attempt claim is fsync'd, raw submit not called yet. */
  afterRawAttemptDurable?: (prepared: Readonly<PreparedSubmission>) => void | Promise<void>;
  /** Test/failpoint hook: raw submit returned, result is not durable yet. */
  afterRawSubmit?: (result: Readonly<SubmitResult>) => void | Promise<void>;
  /** Test/failpoint hook: cancellation intent is fsync'd, raw cancel not called yet. */
  afterCancellationDurable?: (request: Readonly<ProductionJobCancellationRequest>) => void | Promise<void>;
  /**
   * §7 restart sweep reporting. Called for every job the sweep could not decide, so the assembling
   * process can log it: an undecided job stays pending and is retried at the next restart.
   */
  afterJobRecovery?: (fact: Readonly<{
    directory: string;
    outcome: "unresolved";
    reason: "deadline" | "inspect-failed";
  }>) => void;
};

export type ProductionJobGatewayOptions = {
  storeRoot: string;
  credentialResolver: ProductionJobGatewayCredentialResolver;
  profileRegistry: ProductionJobProfileRegistry;
  /** Required server policy hook for model/custom-node/input-slot allowlisting. */
  profileValidator: ProductionJobProfileValidator;
  /** Required read-only proof that a scoped stage receipt matches this immutable job request. */
  stageReceiptRegistry: ProductionStageReceiptRegistry;
  /** Required server-owned concurrency/budget admission authority. No permissive default exists. */
  submissionAdmissionPolicy: SubmissionAdmissionPolicy;
  /** Required durable per-scope/global job storage quota authority. No permissive default exists. */
  storageAdmissionPolicy: ProductionJobStorageAdmissionPolicy;
  rawAdapter: ProductionAdapter;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxRecordBytes?: number;
  maxWorkflowBytes?: number;
  now?: () => Date;
  hooks?: ProductionJobGatewayHooks;
};

export type ProductionJobSubmissionState = "accepted" | "rejected" | "submission-unknown";

export type ProductionJobPutResponse = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  requestDigest: string;
  submissionState: ProductionJobSubmissionState;
  submitResult: SubmitResult | null;
  observation: RemoteObservation | null;
};

export type ProductionJobGetResponse = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  observation: RemoteObservation;
};

export type ProductionJobCancellationResponse = {
  version: 1;
  scope: ProductionJobScope;
  backendInstanceId: string;
  remoteJobId: string;
  cancelKey: string;
  requestDigest: string;
  cancelResult: CancelResult | null;
  /** Raw inspection evidence only. cancelResult.confirmed always remains false. */
  observation: RemoteObservation | null;
};

export type ProductionJobGatewayErrorCode =
  | "aborted"
  | "conflict"
  | "forbidden"
  | "internal"
  | "invalid-request"
  | "not-found"
  | "raw-rejected"
  | "raw-unavailable"
  | "request-too-large"
  | "storage-capacity"
  | "unauthorized";

const ERROR_STATUS: Readonly<Record<ProductionJobGatewayErrorCode, number>> = Object.freeze({
  aborted: 503,
  conflict: 409,
  forbidden: 403,
  internal: 500,
  "invalid-request": 400,
  "not-found": 404,
  "raw-rejected": 422,
  "raw-unavailable": 502,
  "request-too-large": 413,
  "storage-capacity": 429,
  unauthorized: 401,
});

/** Stable and persistence-safe; raw messages, provider bodies, paths and tokens are discarded. */
export class ProductionJobGatewayError extends Error {
  readonly code: ProductionJobGatewayErrorCode;
  readonly status: number;

  constructor(code: ProductionJobGatewayErrorCode) {
    super(`production job gateway ${code}`);
    this.name = "ProductionJobGatewayError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export type ProductionGatewayAdapterCredentialResolver = (
  signal: AbortSignal,
) => string | Promise<string>;

/**
 * Owner-only transport declaration mirroring the runtime config field (§8.0). `tls` keeps the
 * credentialed-HTTPS rule unchanged; `insecure-private-http` trades TLS for VPC isolation and
 * therefore requires a private-IP literal endpoint plus a bearer credential.
 */
export type ProductionGatewayAdapterTransport = "tls" | "insecure-private-http";

export type ProductionGatewayAdapterOptions = {
  /** Trusted server-side job gateway root, never sourced from a task/browser payload. */
  baseUrl: string | URL;
  workspaceId: string;
  project: string;
  backendInstanceId: string;
  profileId: string;
  credentialResolver: ProductionGatewayAdapterCredentialResolver;
  transport?: ProductionGatewayAdapterTransport;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxWorkflowBytes?: number;
};

type Store = {
  root: string;
  bindings: string;
  intentBindings: string;
  scopes: string;
  temporary: string;
  device: bigint;
  inode: bigint;
};

type JobBindingRecord = {
  version: 1;
  remoteJobId: string;
  scope: ProductionJobScope;
  requestDigest: string;
};

type IntentJobBindingRecord = {
  version: 1;
  scope: ProductionJobScope;
  idempotencyKey: string;
  remoteJobId: string;
  requestDigest: string;
};

type JobRequestRecord = {
  version: 1;
  requestDigest: string;
  recordedAt: string;
  request: ProductionJobPutRequest;
};

type ResolvedSubmissionProfile = {
  profile: ProductionJobProfile;
  workflow: Record<string, unknown>;
  workflowDigest: string;
};

type StorageAdmission = Readonly<{
  context: Readonly<ProductionJobStorageAdmissionContext>;
  storageKey: string;
}>;

type JobAttemptRecord = {
  version: 1;
  requestDigest: string;
  recordedAt: string;
  providerRequestDigest: string;
  backendInstanceId: string;
  remoteJobId: string;
  idempotencyKey: string;
};

type AdmissionRequestRecord = {
  version: 1;
  admissionKey: string;
  requestDigest: string;
  recordedAt: string;
  context: ProductionSubmissionAdmissionContext;
};

type AdmissionDecisionRecord = {
  version: 1;
  admissionKey: string;
  requestDigest: string;
  recordedAt: string;
  decision: ProductionSubmissionAdmissionDecision;
};

type RawAttemptClaimRecord = {
  version: 1;
  admissionKey: string;
  requestDigest: string;
  recordedAt: string;
  recoveryNotBefore: string;
};

type AdmissionSettlementPendingRecord = {
  version: 1;
  admissionKey: string;
  requestDigest: string;
  recordedAt: string;
  outcomeDigest: string;
  outcome: ProductionSubmissionAdmissionOutcome;
};

type AdmissionSettlementAcknowledgedRecord = {
  version: 1;
  admissionKey: string;
  requestDigest: string;
  acknowledgedAt: string;
  outcomeDigest: string;
};

type JobOutcomeRecord = {
  version: 1;
  requestDigest: string;
  outcome: ProductionSubmissionAdmissionOutcome;
};

/**
 * §7 Spot preemption. ComfyUI keeps its history in-process, so a restart loses every job that was
 * still pending/running. The gateway records that verdict durably instead of letting the coordinator
 * poll a `not-found` forever, and `GET /jobs/<id>` answers from the record afterwards.
 */
type JobPreemptionRecord = {
  version: 1;
  requestDigest: string;
  remoteJobId: string;
  recordedAt: string;
  errorSummary: typeof PRODUCTION_JOB_PREEMPTED_ERROR_SUMMARY;
  responseDigest: string;
};

/**
 * A remote terminal state, recorded the first time any observation path sees one. It makes the
 * verdict durable, so the §7 restart sweep can tell "the provider forgot a running job" from "the
 * job already finished and its history has since been pruned" without asking the provider again.
 */
type JobTerminalRecord = {
  version: 1;
  requestDigest: string;
  remoteJobId: string;
  recordedAt: string;
  observation: RemoteObservation;
};

type CancellationRecord = {
  version: 1;
  requestDigest: string;
  recordedAt: string;
  request: ProductionJobCancellationRequest;
};

type CancellationResultRecord = {
  version: 1;
  requestDigest: string;
  result: CancelResult;
};

type Operation = {
  signal: AbortSignal;
  finish(): void;
};

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLOT = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const SAFE_ERROR_SUMMARY = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
/** §4.5 errorSummary 词表中的抢占类别。 */
export const PRODUCTION_JOB_PREEMPTED_ERROR_SUMMARY = "provider_failed:preempted" as const;
/** Bound on one restart sweep so a corrupt store cannot turn startup into an unbounded walk. */
export const MAX_PRODUCTION_JOB_RECOVERY_SCAN = 100_000;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REMOTE_STATES = new Set(["pending", "running", "succeeded", "failed", "cancelled", "not-found"]);
const LOCATOR_KINDS = new Set(["image", "video", "audio", "file"]);
const LOCATOR_FOLDERS = new Set(["input", "output", "temp"]);
const ADAPTER_ERROR_CODES = new Set<ProductionAdapterErrorCode>([
  "aborted", "submission-unknown", "remote-rejected", "remote-unavailable",
  "invalid-response", "response-too-large",
]);
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code: ProductionJobGatewayErrorCode): never {
  throw new ProductionJobGatewayError(code);
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function fullMatch(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0].length === value.length;
}

function safeInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail("invalid-request");
  return result;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  try { return productionCanonicalJson(value); }
  catch { fail("invalid-request"); }
}

function deepFreezeJson(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreezeJson(child);
  Object.freeze(value);
}

/** Canonical profile digest shared by the client attestation and server-owned registry. */
export function productionJobWorkflowDigest(workflow: Record<string, unknown>): string {
  try { return productionCanonicalJsonSha256(workflow); }
  catch { fail("invalid-request"); }
}

function parseScope(workspaceId: unknown, project: unknown, code: "invalid-request" | "internal" = "invalid-request"): ProductionJobScope {
  if (typeof workspaceId !== "string" || !fullMatch(SAFE_WORKSPACE_ID, workspaceId)
    || typeof project !== "string") fail(code);
  try { assertProjectKey(project); }
  catch { fail(code); }
  return { version: 1, workspaceId, project };
}

function parseScopeObject(value: unknown): ProductionJobScope {
  if (!isRecord(value) || !exactKeys(value, ["version", "workspaceId", "project"]) || value.version !== 1) {
    fail("invalid-request");
  }
  return parseScope(value.workspaceId, value.project);
}

function sameScope(left: ProductionJobScope, right: ProductionJobScope): boolean {
  return left.workspaceId === right.workspaceId && left.project === right.project;
}

function safeId(value: unknown, code: "invalid-request" | "internal" = "invalid-request"): string {
  if (typeof value !== "string" || !fullMatch(SAFE_ID, value)) fail(code);
  return value;
}

function safeProfileId(value: unknown, code: "invalid-request" | "internal" = "invalid-request"): string {
  if (typeof value !== "string" || !fullMatch(SAFE_PROFILE_ID, value)) fail(code);
  return value;
}

function parseProfileRef(value: unknown): ProductionJobProfileRef {
  if (!isRecord(value) || !exactKeys(value, ["version", "profileId", "workflowDigest"])
    || value.version !== 1 || typeof value.workflowDigest !== "string" || !SHA256.test(value.workflowDigest)) {
    fail("invalid-request");
  }
  return { version: 1, profileId: safeProfileId(value.profileId), workflowDigest: value.workflowDigest };
}

function parseInputBinding(value: unknown): ProductionSubmissionInputBinding | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ["version", "stageKey", "bindingsDigest", "intentDigest"])
    || value.version !== 1 || typeof value.stageKey !== "string" || !SHA256.test(value.stageKey)
    || typeof value.bindingsDigest !== "string" || !SHA256.test(value.bindingsDigest)
    || typeof value.intentDigest !== "string" || !SHA256.test(value.intentDigest)) fail("invalid-request");
  return {
    version: 1,
    stageKey: value.stageKey,
    bindingsDigest: value.bindingsDigest,
    intentDigest: value.intentDigest,
  };
}

function parsePutRequest(value: unknown, scope: ProductionJobScope, remoteJobId: string): ProductionJobPutRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "backendInstanceId", "remoteJobId", "idempotencyKey", "profile", "inputBinding",
  ]) || value.version !== 1) fail("invalid-request");
  const parsedScope = parseScopeObject(value.scope);
  const parsedRemoteJobId = safeId(value.remoteJobId);
  if (!sameScope(parsedScope, scope) || parsedRemoteJobId !== remoteJobId) fail("invalid-request");
  return {
    version: 1,
    scope: parsedScope,
    backendInstanceId: safeId(value.backendInstanceId),
    remoteJobId: parsedRemoteJobId,
    idempotencyKey: safeId(value.idempotencyKey),
    profile: parseProfileRef(value.profile),
    inputBinding: parseInputBinding(value.inputBinding),
  };
}

function parseCancellationRequest(
  value: unknown,
  scope: ProductionJobScope,
  remoteJobId: string,
  cancelKey: string,
): ProductionJobCancellationRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "backendInstanceId", "remoteJobId", "cancelKey",
  ]) || value.version !== 1) fail("invalid-request");
  const parsedScope = parseScopeObject(value.scope);
  if (!sameScope(parsedScope, scope) || safeId(value.remoteJobId) !== remoteJobId
    || typeof value.cancelKey !== "string" || !SHA256.test(value.cancelKey) || value.cancelKey !== cancelKey) {
    fail("invalid-request");
  }
  return {
    version: 1,
    scope: parsedScope,
    backendInstanceId: safeId(value.backendInstanceId),
    remoteJobId,
    cancelKey,
  };
}

/** Digest of the exact canonical PUT body, available before network I/O. */
export function productionJobPutRequestDigest(request: ProductionJobPutRequest): string {
  return sha256(JSON.stringify(request));
}

/** Stable storage slot identity. Request/remote drift is deliberately carried only in context. */
export function productionJobStorageKey(scope: ProductionJobScope, idempotencyKey: string): string {
  const parsedScope = parseScopeObject(scope);
  const parsedIdempotencyKey = safeId(idempotencyKey);
  try {
    return productionCanonicalJsonSha256({
      version: 1,
      scope: parsedScope,
      idempotencyKey: parsedIdempotencyKey,
    });
  } catch { fail("invalid-request"); }
}

/** Stable policy authority key. It contains no profile graph, provider URL, credential or token. */
export function productionSubmissionAdmissionKey(
  scope: ProductionJobScope,
  remoteJobId: string,
  requestDigest: string,
): string {
  const parsedScope = parseScopeObject(scope);
  const parsedRemoteJobId = safeId(remoteJobId);
  if (typeof requestDigest !== "string" || !SHA256.test(requestDigest)) fail("invalid-request");
  return sha256(JSON.stringify({ version: 1, scope: parsedScope, remoteJobId: parsedRemoteJobId, requestDigest }));
}

/** One stable cancellation intent for a scope-bound preallocated job. */
export function productionJobCancellationKey(scope: ProductionJobScope, remoteJobId: string): string {
  return sha256(JSON.stringify({ version: 1, scope, remoteJobId, operation: "cancel" }));
}

export function productionJobCancellationRequestDigest(request: ProductionJobCancellationRequest): string {
  return sha256(JSON.stringify(request));
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function safeRemotePath(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" && value.length <= 512 && (allowEmpty || value.length > 0)
    && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/")
    && !value.split("/").some((part) => part === ".." || part === ".");
}

function parseLocator(value: unknown, code: "internal" | "invalid-request" = "internal"): RemoteOutputLocator {
  if (!isRecord(value)) fail(code);
  // §4.5 判别联合：缺少 source 时按 comfy-view 读取；写入侧总带 source。
  const source = Object.prototype.hasOwnProperty.call(value, "source") ? value.source : "comfy-view";
  if (source === "provider-output") {
    if (!exactKeys(value, ["source", "remoteJobId", "outputIndex", "role", "kind"])
      || typeof value.remoteJobId !== "string" || !fullMatch(SAFE_ID, value.remoteJobId)
      || !Number.isSafeInteger(value.outputIndex) || (value.outputIndex as number) < 0
      || (value.outputIndex as number) > 127
      || (value.role !== "primary" && value.role !== "last-frame")
      || (value.kind !== "video" && value.kind !== "image")) fail(code);
    return {
      source: "provider-output",
      remoteJobId: value.remoteJobId,
      outputIndex: value.outputIndex as number,
      role: value.role,
      kind: value.kind,
    };
  }
  if (source !== "comfy-view") fail(code);
  const comfyKeys = ["nodeId", "kind", "filename", "subfolder", "folderType"];
  if (!exactKeys(value, Object.prototype.hasOwnProperty.call(value, "source")
    ? ["source", ...comfyKeys] : comfyKeys)
    || typeof value.nodeId !== "string" || !fullMatch(SAFE_ID, value.nodeId)
    || typeof value.kind !== "string" || !LOCATOR_KINDS.has(value.kind)
    || !safeRemotePath(value.filename, false) || !safeRemotePath(value.subfolder, true)
    || typeof value.folderType !== "string" || !LOCATOR_FOLDERS.has(value.folderType)) fail(code);
  return {
    source: "comfy-view",
    nodeId: value.nodeId,
    kind: value.kind as "image" | "video" | "audio" | "file",
    filename: value.filename,
    subfolder: value.subfolder,
    folderType: value.folderType as "input" | "output" | "temp",
  };
}

function parseObservation(value: unknown, expectedId: string, code: "internal" | "invalid-request" = "internal"): RemoteObservation {
  if (!isRecord(value) || !exactKeys(value, [
    "remoteJobId", "state", "observedAt", "outputs", "errorSummary", "responseDigest",
  ]) || value.remoteJobId !== expectedId || typeof value.state !== "string" || !REMOTE_STATES.has(value.state)
    || !canonicalIso(value.observedAt) || !Array.isArray(value.outputs) || value.outputs.length > 128
    || (value.errorSummary !== null && (typeof value.errorSummary !== "string"
      || !fullMatch(SAFE_ERROR_SUMMARY, value.errorSummary)))
    || typeof value.responseDigest !== "string" || !SHA256.test(value.responseDigest)) fail(code);
  return {
    remoteJobId: expectedId,
    state: value.state as RemoteObservation["state"],
    observedAt: value.observedAt,
    outputs: value.outputs.map((locator) => parseLocator(locator, code)),
    errorSummary: value.errorSummary,
    responseDigest: value.responseDigest,
  };
}

function parseSubmitResult(value: unknown, expectedId: string, code: "internal" | "invalid-request" = "internal"): SubmitResult {
  if (!isRecord(value) || !exactKeys(value, [
    "remoteJobId", "acceptedAt", "providerIdempotency", "nodeErrorCount", "responseDigest",
  ]) || value.remoteJobId !== expectedId || !canonicalIso(value.acceptedAt)
    || value.providerIdempotency !== false || !Number.isSafeInteger(value.nodeErrorCount)
    || (value.nodeErrorCount as number) < 0 || (value.nodeErrorCount as number) > 4096
    || typeof value.responseDigest !== "string" || !SHA256.test(value.responseDigest)) fail(code);
  return {
    remoteJobId: expectedId,
    acceptedAt: value.acceptedAt,
    providerIdempotency: false,
    nodeErrorCount: value.nodeErrorCount as number,
    responseDigest: value.responseDigest,
  };
}

function parseCancelResult(value: unknown, expectedId: string, code: "internal" | "invalid-request" = "internal"): CancelResult {
  if (!isRecord(value) || !exactKeys(value, [
    "remoteJobId", "accepted", "confirmed", "runningInterruptRequested", "observedAt",
  ]) || value.remoteJobId !== expectedId || typeof value.accepted !== "boolean" || value.confirmed !== false
    || typeof value.runningInterruptRequested !== "boolean" || !canonicalIso(value.observedAt)) fail(code);
  return {
    remoteJobId: expectedId,
    accepted: value.accepted,
    confirmed: false,
    runningInterruptRequested: value.runningInterruptRequested,
    observedAt: value.observedAt,
  };
}

function parseProfile(value: unknown, expected: ProductionJobPutRequest, maximumBytes: number): ProductionJobProfile {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "profileId", "backendInstanceId", "workflowDigest", "stageProfileDigest",
    "execution", "h3GraphContract", "stageGraphBindings", "workflow",
  ]) || value.version !== 1 || safeProfileId(value.profileId, "internal") !== expected.profile.profileId
    || safeId(value.backendInstanceId, "internal") !== expected.backendInstanceId
    || typeof value.workflowDigest !== "string" || !SHA256.test(value.workflowDigest)
    || (value.stageProfileDigest !== null
      && (typeof value.stageProfileDigest !== "string" || !SHA256.test(value.stageProfileDigest)))
    || !isRecord(value.workflow)) fail("forbidden");
  const staged = value.stageProfileDigest !== null;
  if (staged !== (expected.inputBinding !== null)
    || staged !== (value.execution !== null)
    || staged !== (value.h3GraphContract !== null)
    || staged !== (value.stageGraphBindings !== null)) fail("forbidden");
  let canonical: string;
  try { canonical = canonicalJson(value.workflow); }
  catch { fail("forbidden"); }
  if (Buffer.byteLength(canonical) > maximumBytes || sha256(canonical) !== value.workflowDigest) fail("forbidden");
  let workflow: Record<string, unknown>;
  try { workflow = JSON.parse(canonical) as Record<string, unknown>; }
  catch { fail("forbidden"); }
  deepFreezeJson(workflow);
  let execution: ProductionIntentExecution | null = null;
  let h3GraphContract: ProductionH3GraphContract | null = null;
  let stageGraphBindings: readonly ProductionH3StageBindingContract[] | null = null;
  if (staged) {
    try {
      execution = parseProductionIntentExecution(value.execution, "ProductionJobProfile.execution");
      h3GraphContract = parseProductionH3GraphContract(value.h3GraphContract);
      if (!Array.isArray(value.stageGraphBindings) || value.stageGraphBindings.length < 1
        || value.stageGraphBindings.length > 32) fail("forbidden");
      stageGraphBindings = Object.freeze(value.stageGraphBindings.map(
        (binding, index) => parseProductionH3StageBindingContract(binding, index),
      ));
    } catch { fail("forbidden"); }
  } else if (value.workflowDigest !== expected.profile.workflowDigest) {
    fail("forbidden");
  }
  return {
    version: 1,
    profileId: expected.profile.profileId,
    backendInstanceId: expected.backendInstanceId,
    workflowDigest: value.workflowDigest,
    stageProfileDigest: value.stageProfileDigest as string | null,
    execution: execution === null ? null : Object.freeze({ ...execution }),
    h3GraphContract,
    stageGraphBindings,
    workflow,
  };
}

function safeProviderObjectKey(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROVIDER_OBJECT_KEY.test(value)
    && !value.includes("//") && !value.startsWith("/") && !value.endsWith("/")
    && value.split("/").every((part) => part !== "." && part !== "..");
}

function parseVerifiedStageReceipt(
  value: unknown,
  claim: ProductionStageReceiptClaim,
): VerifiedStageReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "stageKey", "bindingsDigest", "intentDigest", "profileDigest", "execution",
    "bindings", "shotRequest",
  ]) || value.version !== 1 || value.stageKey !== claim.stageKey
    || value.bindingsDigest !== claim.bindingsDigest || value.intentDigest !== claim.intentDigest
    || value.profileDigest !== claim.profileDigest || !isRecord(value.scope)
    || canonicalJson(parseScopeObjectInternal(value.scope)) !== canonicalJson(claim.scope)
    || !Array.isArray(value.bindings) || value.bindings.length < 1 || value.bindings.length > 32) fail("forbidden");
  let execution: ProductionIntentExecution;
  try { execution = parseProductionIntentExecution(value.execution, "VerifiedStageReceipt.execution"); }
  catch { fail("forbidden"); }
  const bindings: ProductionInputBinding[] = value.bindings.map((binding, index) => {
    if (!isRecord(binding) || !exactKeys(binding, ["index", "slot", "assetSha256", "providerObjectKey"])
      || binding.index !== index || typeof binding.slot !== "string" || !SAFE_SLOT.test(binding.slot)
      || typeof binding.assetSha256 !== "string" || !SHA256.test(binding.assetSha256)
      || !safeProviderObjectKey(binding.providerObjectKey)) fail("forbidden");
    return {
      index,
      slot: binding.slot,
      assetSha256: binding.assetSha256,
      providerObjectKey: binding.providerObjectKey,
    };
  });
  if (new Set(bindings.map((binding) => binding.slot)).size !== bindings.length
    || new Set(bindings.map((binding) => binding.providerObjectKey)).size !== bindings.length
    || productionInputBindingsDigest(bindings) !== claim.bindingsDigest) fail("forbidden");
  const verified: VerifiedStageReceipt = {
    version: 1,
    scope: Object.freeze({ ...claim.scope }),
    stageKey: claim.stageKey,
    bindingsDigest: claim.bindingsDigest,
    intentDigest: claim.intentDigest,
    profileDigest: claim.profileDigest,
    execution: Object.freeze({ ...execution }),
    bindings: Object.freeze(bindings.map((binding) => Object.freeze({ ...binding }))),
    shotRequest: parseVerifiedShotRequest(value.shotRequest, bindings),
  };
  return Object.freeze(verified);
}

/**
 * The per-shot projection the stage kernel read back out of the staged `inputs[0]` object. It is
 * present exactly when the profile stages a `shot-request` slot, and it is bound to that object's
 * digest, which the bindings digest already covers. A malformed shape here is a server-internal
 * fault of the paired stage kernel, not a caller error — same classification as the stage side.
 */
function parseVerifiedShotRequest(
  value: unknown,
  bindings: readonly ProductionInputBinding[],
): Readonly<ProductionStagedShotRequest> | null {
  const staged = bindings[0]?.slot === PRODUCTION_SHOT_REQUEST_SLOT;
  if (value === null) {
    if (staged) fail("internal");
    return null;
  }
  if (!staged || !isRecord(value) || !exactKeys(value, ["version", "assetSha256", "prompt", "seed"])
    || value.version !== 1 || typeof value.assetSha256 !== "string"
    || !SHA256.test(value.assetSha256) || value.assetSha256 !== bindings[0]!.assetSha256
    || typeof value.prompt !== "string" || value.prompt.length < 1 || value.prompt.length > 16_384
    || (value.seed !== null && (!Number.isSafeInteger(value.seed)
      || (value.seed as number) < 0 || (value.seed as number) > 0xffff_ffff))) fail("internal");
  return Object.freeze({
    version: 1 as const,
    assetSha256: value.assetSha256,
    prompt: value.prompt,
    seed: value.seed as number | null,
  });
}

function adapterErrorCode(error: unknown): ProductionAdapterErrorCode | "internal" {
  return error instanceof ProductionAdapterError && ADAPTER_ERROR_CODES.has(error.code) ? error.code : "internal";
}

function validateToken(value: unknown, code: "internal" | "invalid-request" = "internal"): string {
  if (typeof value !== "string" || !TOKEN.test(value)) fail(code);
  return value;
}

function constantTimeBearerMatches(header: string | null, expected: string): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const valid = TOKEN.test(candidate) && !candidate.includes(",");
  const actualDigest = createHash("sha256").update(valid ? candidate : "invalid").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return valid && timingSafeEqual(actualDigest, expectedDigest);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function ensureSafeDirectory(path: string, root: string): Promise<BigIntStats> {
  if (!inside(root, path)) fail("internal");
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || (Number(before.mode) & 0o022) !== 0
    || await realpath(path) !== path) fail("internal");
  const after = await lstat(path, { bigint: true });
  if (!sameFile(before, after) || !after.isDirectory()) fail("internal");
  return after;
}

async function ensureDirectory(path: string, root: string): Promise<void> {
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
    if (!sameFile(parentBefore, parentAfter) || !parentAfter.isDirectory()
      || parentAfter.isSymbolicLink()) fail("internal");
    await ensureSafeDirectory(next, root);
    parent = next;
  }
}

async function initializeStore(configuredRoot: string): Promise<Store> {
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) === sep) fail("invalid-request");
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const linkInfo = await lstat(configuredRoot, { bigint: true });
  if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) fail("invalid-request");
  const root = await realpath(configuredRoot);
  await ensureDirectory(root, root);
  const store = {
    root,
    bindings: join(root, "job-bindings"),
    intentBindings: join(root, "intent-bindings"),
    scopes: join(root, "scopes"),
    temporary: join(root, "tmp"),
  };
  for (const path of [store.bindings, store.intentBindings, store.scopes, store.temporary]) {
    await ensureDirectory(path, root);
  }
  const pinned = await lstat(root, { bigint: true });
  return { ...store, device: pinned.dev, inode: pinned.ino };
}

async function verifyRoot(store: Store): Promise<void> {
  const current = await lstat(store.root, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== store.device || current.ino !== store.inode) fail("internal");
}

async function createTemporary(store: Store): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const path = join(store.temporary, `${randomBytes(24).toString("hex")}.tmp`);
    try { return { path, handle: await open(path, CREATE_FLAGS, 0o600) }; }
    catch (error) {
      if (isNodeError(error, "EEXIST")) continue;
      throw error;
    }
  }
  fail("internal");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, READ_FLAGS);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function publishJson(
  store: Store,
  destination: string,
  value: unknown,
  maximum: number,
  afterLink?: (temporaryPath: string, destination: string) => void,
): Promise<boolean> {
  await verifyRoot(store);
  if (!inside(store.root, destination)) fail("internal");
  await ensureDirectory(dirname(destination), store.root);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > maximum) fail("internal");
  const temporary = await createTemporary(store);
  let created = false;
  try {
    await temporary.handle.writeFile(bytes);
    await temporary.handle.sync();
    await temporary.handle.chmod(0o400);
    const temporaryInfo = await temporary.handle.stat({ bigint: true });
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1n) fail("internal");
    await temporary.handle.close();
    try { await link(temporary.path, destination); created = true; }
    catch (error) { if (!isNodeError(error, "EEXIST")) throw error; }
    if (created) afterLink?.(temporary.path, destination);
    try { await unlink(temporary.path); }
    catch (error) {
      if (!created || !isNodeError(error, "ENOENT")) throw error;
      // A concurrent reader may have safely removed a crashed/live publisher's trusted temp link.
      const published = await lstat(destination, { bigint: true });
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n
        || !sameFile(temporaryInfo, published)) throw error;
    }
    await syncDirectory(store.temporary);
    if (created) await syncDirectory(dirname(destination));
    return created;
  } catch (error) {
    await temporary.handle.close().catch(() => undefined);
    await unlink(temporary.path).catch(() => undefined);
    throw error;
  }
}

async function waitForSingleLink(store: Store, path: string, signal?: AbortSignal): Promise<BigIntStats> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await lstat(path, { bigint: true });
    if (info.nlink === 1n || !info.isFile() || info.isSymbolicLink() || info.nlink !== 2n) return info;
    const pause = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2));
    if (signal) await raceAbort(pause, signal);
    else await pause;
  }
  let current = await lstat(path, { bigint: true });
  if (current.nlink !== 2n || !current.isFile() || current.isSymbolicLink()) return current;
  await verifyRoot(store);
  await ensureDirectory(store.temporary, store.root);
  const names = await readdir(store.temporary);
  if (names.length > 4_096) fail("internal");
  for (const name of names) {
    if (!/^[a-f0-9]{48}\.tmp$/.test(name)) continue;
    const candidate = join(store.temporary, name);
    let candidateInfo: BigIntStats;
    try { candidateInfo = await lstat(candidate, { bigint: true }); }
    catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()
      || candidateInfo.nlink !== 2n || !sameFile(current, candidateInfo)) continue;
    try { await unlink(candidate); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
    // Persist both removal of the trusted temp name and survival of the published destination.
    await syncDirectory(store.temporary);
    await syncDirectory(dirname(path));
    current = await lstat(path, { bigint: true });
    break;
  }
  return current;
}

async function readJson(store: Store, path: string, maximum: number, signal?: AbortSignal): Promise<unknown> {
  const pathInfo = await waitForSingleLink(store, path, signal);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1n
    || pathInfo.size < 1n || pathInfo.size > BigInt(maximum)) fail("internal");
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(pathInfo, opened)) fail("internal");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (part.bytesRead < 1) fail("internal");
      offset += part.bytesRead;
    }
    const end = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!sameFile(opened, end) || !sameFile(end, finalPath) || opened.size !== end.size || end.nlink !== 1n) {
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

async function optionalJson(
  store: Store,
  path: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<unknown | null> {
  try { return await readJson(store, path, maximum, signal); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return await new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolvePromise(result); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function readBoundedJsonRequest(request: Request, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    fail("invalid-request");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
    fail(/^\d+$/.test(declared) ? "request-too-large" : "invalid-request");
  }
  if (!request.body) fail("invalid-request");
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
  } finally {
    reader.releaseLock();
  }
  if (bytes < 1 || (declared !== null && Number(declared) !== bytes)) fail("invalid-request");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { fail("invalid-request"); }
  try { return JSON.parse(text); }
  catch { fail("invalid-request"); }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: ProductionJobGatewayError): Response {
  const response = jsonResponse({ version: 1, error: error.code }, error.status);
  if (error.code === "unauthorized") response.headers.set("www-authenticate", "Bearer");
  return response;
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { fail("not-found"); }
}

type ParsedRoute =
  | { kind: "job"; scope: ProductionJobScope; remoteJobId: string }
  | { kind: "cancel"; scope: ProductionJobScope; remoteJobId: string; cancelKey: string }
  | { kind: "capabilities"; scope: ProductionJobScope };

function parseRoute(url: URL): ParsedRoute {
  if (url.search || url.hash) fail("not-found");
  const parts = url.pathname.split("/");
  if (parts.length !== 6 && parts.length !== 7 && parts.length !== 9) fail("not-found");
  if (parts[0] !== "" || parts[1] !== "v1" || parts[2] !== "scopes") fail("not-found");
  const scope = parseScope(decodeSegment(parts[3]!), decodeSegment(parts[4]!));
  if (parts.length === 6) {
    if (parts[5] !== "capabilities") fail("not-found");
    return { kind: "capabilities", scope };
  }
  if (parts[5] !== "jobs") fail("not-found");
  const remoteJobId = safeId(decodeSegment(parts[6]!));
  if (parts.length === 7) return { kind: "job", scope, remoteJobId };
  if (parts[7] !== "cancellations" || !SHA256.test(parts[8]!)) fail("not-found");
  return { kind: "cancel", scope, remoteJobId, cancelKey: parts[8]! };
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

function trustedBaseUrl(
  value: string | URL,
  transport: ProductionGatewayAdapterTransport,
  hasCredentialResolver: boolean,
): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ProductionAdapterError("remote-rejected", "Production Gateway baseUrl 无效"); }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ProductionAdapterError("remote-rejected", "Production Gateway baseUrl 配置无效");
  }
  if (transport === "insecure-private-http") {
    // VPC 私网明文：只接受私网字面 IP 的 http endpoint，且仍以 bearer 鉴权（§8.0）。
    if (url.protocol !== "http:" || !isPrivateIpv4Literal(url.hostname) || !hasCredentialResolver) {
      throw new ProductionAdapterError("remote-rejected", "Production Gateway insecure-private-http baseUrl 配置无效");
    }
  } else if (url.protocol !== "https:") {
    throw new ProductionAdapterError("remote-rejected", "Production Gateway baseUrl 配置无效");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function endpoint(base: URL, scope: ProductionJobScope, suffix: string): URL {
  return new URL(
    `v1/scopes/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.project)}/${suffix}`,
    base,
  );
}

function parseBinding(value: unknown, expectedId: string): JobBindingRecord {
  if (!isRecord(value) || !exactKeys(value, ["version", "remoteJobId", "scope", "requestDigest"])
    || value.version !== 1 || safeId(value.remoteJobId, "internal") !== expectedId
    || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)) fail("internal");
  return {
    version: 1,
    remoteJobId: expectedId,
    scope: parseScopeObjectInternal(value.scope),
    requestDigest: value.requestDigest,
  };
}

function parseIntentBinding(
  value: unknown,
  expectedScope: ProductionJobScope,
  expectedKey: string,
): IntentJobBindingRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "idempotencyKey", "remoteJobId", "requestDigest",
  ]) || value.version !== 1 || safeId(value.idempotencyKey, "internal") !== expectedKey
    || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)) fail("internal");
  const scope = parseScopeObjectInternal(value.scope);
  if (!sameScope(scope, expectedScope)) fail("internal");
  return {
    version: 1,
    scope,
    idempotencyKey: expectedKey,
    remoteJobId: safeId(value.remoteJobId, "internal"),
    requestDigest: value.requestDigest,
  };
}

function parseScopeObjectInternal(value: unknown): ProductionJobScope {
  if (!isRecord(value) || !exactKeys(value, ["version", "workspaceId", "project"]) || value.version !== 1) {
    fail("internal");
  }
  return parseScope(value.workspaceId, value.project, "internal");
}

function parseStoredPutRequest(
  value: unknown,
  scope: ProductionJobScope,
  remoteJobId: string,
): ProductionJobPutRequest {
  try { return parsePutRequest(value, scope, remoteJobId); }
  catch { fail("internal"); }
}

function preemptionResponseDigest(remoteJobId: string, recordedAt: string): string {
  return sha256(JSON.stringify({
    version: 1, kind: "provider-preempted", remoteJobId, recordedAt,
  }));
}

function parsePreemptionRecord(
  value: unknown,
  request: JobRequestRecord,
): JobPreemptionRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "requestDigest", "remoteJobId", "recordedAt", "errorSummary", "responseDigest",
  ]) || value.version !== 1 || value.requestDigest !== request.requestDigest
    || value.remoteJobId !== request.request.remoteJobId || !canonicalIso(value.recordedAt)
    || value.errorSummary !== PRODUCTION_JOB_PREEMPTED_ERROR_SUMMARY
    || value.responseDigest !== preemptionResponseDigest(value.remoteJobId, value.recordedAt)) fail("internal");
  return {
    version: 1,
    requestDigest: request.requestDigest,
    remoteJobId: request.request.remoteJobId,
    recordedAt: value.recordedAt,
    errorSummary: PRODUCTION_JOB_PREEMPTED_ERROR_SUMMARY,
    responseDigest: value.responseDigest,
  };
}

const TERMINAL_REMOTE_STATES = new Set<RemoteJobState>(["succeeded", "failed", "cancelled"]);

function parseTerminalRecord(value: unknown, request: JobRequestRecord): JobTerminalRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "requestDigest", "remoteJobId", "recordedAt", "observation",
  ]) || value.version !== 1 || value.requestDigest !== request.requestDigest
    || value.remoteJobId !== request.request.remoteJobId
    || !canonicalIso(value.recordedAt)) fail("internal");
  const observation = parseObservation(value.observation, request.request.remoteJobId, "internal");
  if (!TERMINAL_REMOTE_STATES.has(observation.state)) fail("internal");
  return {
    version: 1,
    requestDigest: request.requestDigest,
    remoteJobId: request.request.remoteJobId,
    recordedAt: value.recordedAt,
    observation,
  };
}

function preemptedObservation(record: JobPreemptionRecord): RemoteObservation {
  return {
    remoteJobId: record.remoteJobId,
    state: "failed",
    observedAt: record.recordedAt,
    outputs: [],
    errorSummary: record.errorSummary,
    responseDigest: record.responseDigest,
  };
}

function parseJobRequestRecord(value: unknown, scope: ProductionJobScope, remoteJobId: string): JobRequestRecord {
  if (!isRecord(value) || !exactKeys(value, ["version", "requestDigest", "recordedAt", "request"])
    || value.version !== 1 || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)
    || !canonicalIso(value.recordedAt)) fail("internal");
  const request = parseStoredPutRequest(value.request, scope, remoteJobId);
  if (productionJobPutRequestDigest(request) !== value.requestDigest) fail("internal");
  return { version: 1, requestDigest: value.requestDigest, recordedAt: value.recordedAt, request };
}

function admissionContext(request: JobRequestRecord): ProductionSubmissionAdmissionContext {
  return {
    version: 1,
    scope: { ...request.request.scope },
    backendInstanceId: request.request.backendInstanceId,
    remoteJobId: request.request.remoteJobId,
    requestDigest: request.requestDigest,
    idempotencyKey: request.request.idempotencyKey,
    profile: { ...request.request.profile },
    inputBinding: request.request.inputBinding === null ? null : { ...request.request.inputBinding },
  };
}

function parseAttemptRecord(value: unknown, request: JobRequestRecord): JobAttemptRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "requestDigest", "recordedAt", "providerRequestDigest",
    "backendInstanceId", "remoteJobId", "idempotencyKey",
  ]) || value.version !== 1 || value.requestDigest !== request.requestDigest
    || !canonicalIso(value.recordedAt) || typeof value.providerRequestDigest !== "string"
    || !SHA256.test(value.providerRequestDigest)
    || value.backendInstanceId !== request.request.backendInstanceId
    || value.remoteJobId !== request.request.remoteJobId
    || value.idempotencyKey !== request.request.idempotencyKey) fail("internal");
  return {
    version: 1,
    requestDigest: request.requestDigest,
    recordedAt: value.recordedAt,
    providerRequestDigest: value.providerRequestDigest,
    backendInstanceId: request.request.backendInstanceId,
    remoteJobId: request.request.remoteJobId,
    idempotencyKey: request.request.idempotencyKey,
  };
}

function parseAdmissionRequestRecord(value: unknown, request: JobRequestRecord): AdmissionRequestRecord {
  const expectedContext = admissionContext(request);
  const expectedKey = productionSubmissionAdmissionKey(
    request.request.scope, request.request.remoteJobId, request.requestDigest,
  );
  if (!isRecord(value) || !exactKeys(value, [
    "version", "admissionKey", "requestDigest", "recordedAt", "context",
  ]) || value.version !== 1 || value.admissionKey !== expectedKey
    || value.requestDigest !== request.requestDigest || !canonicalIso(value.recordedAt)
    || canonicalJson(value.context) !== canonicalJson(expectedContext)) fail("internal");
  return {
    version: 1,
    admissionKey: expectedKey,
    requestDigest: request.requestDigest,
    recordedAt: value.recordedAt,
    context: expectedContext,
  };
}

function parseAdmissionDecisionRecord(
  value: unknown,
  request: JobRequestRecord,
  admissionKey: string,
): AdmissionDecisionRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "admissionKey", "requestDigest", "recordedAt", "decision",
  ]) || value.version !== 1 || value.admissionKey !== admissionKey
    || value.requestDigest !== request.requestDigest || !canonicalIso(value.recordedAt)
    || (value.decision !== "allow" && value.decision !== "deny")) fail("internal");
  return {
    version: 1,
    admissionKey,
    requestDigest: request.requestDigest,
    recordedAt: value.recordedAt,
    decision: value.decision,
  };
}

function parseRawAttemptClaimRecord(
  value: unknown,
  request: JobRequestRecord,
  admissionKey: string,
): RawAttemptClaimRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "admissionKey", "requestDigest", "recordedAt", "recoveryNotBefore",
  ]) || value.version !== 1 || value.admissionKey !== admissionKey
    || value.requestDigest !== request.requestDigest || !canonicalIso(value.recordedAt)
    || !canonicalIso(value.recoveryNotBefore)
    || Date.parse(value.recoveryNotBefore) < Date.parse(value.recordedAt)) fail("internal");
  return {
    version: 1,
    admissionKey,
    requestDigest: request.requestDigest,
    recordedAt: value.recordedAt,
    recoveryNotBefore: value.recoveryNotBefore,
  };
}

function parseAdmissionOutcome(value: unknown, request: JobRequestRecord): ProductionSubmissionAdmissionOutcome {
  if (!isRecord(value) || !exactKeys(value, ["version", "state", "submitResult", "errorCode"])
    || value.version !== 1 || (value.state !== "submitted" && value.state !== "not-submitted"
      && value.state !== "submission-unknown")) fail("internal");
  const submitResult = value.submitResult === null
    ? null
    : parseSubmitResult(value.submitResult, request.request.remoteJobId);
  const errorCode = value.errorCode;
  if (errorCode !== null && (errorCode !== "internal" && (typeof errorCode !== "string"
    || !ADAPTER_ERROR_CODES.has(errorCode as ProductionAdapterErrorCode)))) fail("internal");
  if ((value.state === "submitted" && (submitResult === null || errorCode !== null))
    || (value.state !== "submitted" && (submitResult !== null || errorCode === null))) fail("internal");
  return {
    version: 1,
    state: value.state,
    submitResult,
    errorCode: errorCode as ProductionSubmissionAdmissionOutcome["errorCode"],
  };
}

function admissionOutcomeDigest(outcome: ProductionSubmissionAdmissionOutcome): string {
  return sha256(JSON.stringify(outcome));
}

function parseAdmissionSettlementPendingRecord(
  value: unknown,
  request: JobRequestRecord,
  admissionKey: string,
  expectedOutcome: ProductionSubmissionAdmissionOutcome,
): AdmissionSettlementPendingRecord {
  const expectedDigest = admissionOutcomeDigest(expectedOutcome);
  if (!isRecord(value) || !exactKeys(value, [
    "version", "admissionKey", "requestDigest", "recordedAt", "outcomeDigest", "outcome",
  ]) || value.version !== 1 || value.admissionKey !== admissionKey
    || value.requestDigest !== request.requestDigest || !canonicalIso(value.recordedAt)
    || value.outcomeDigest !== expectedDigest) fail("internal");
  const outcome = parseAdmissionOutcome(value.outcome, request);
  if (admissionOutcomeDigest(outcome) !== expectedDigest
    || canonicalJson(outcome) !== canonicalJson(expectedOutcome)) fail("internal");
  return {
    version: 1,
    admissionKey,
    requestDigest: request.requestDigest,
    recordedAt: value.recordedAt,
    outcomeDigest: expectedDigest,
    outcome,
  };
}

function parseAdmissionSettlementAcknowledgedRecord(
  value: unknown,
  request: JobRequestRecord,
  admissionKey: string,
  outcomeDigest: string,
): AdmissionSettlementAcknowledgedRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "admissionKey", "requestDigest", "acknowledgedAt", "outcomeDigest",
  ]) || value.version !== 1 || value.admissionKey !== admissionKey
    || value.requestDigest !== request.requestDigest || !canonicalIso(value.acknowledgedAt)
    || value.outcomeDigest !== outcomeDigest) fail("internal");
  return {
    version: 1,
    admissionKey,
    requestDigest: request.requestDigest,
    acknowledgedAt: value.acknowledgedAt,
    outcomeDigest,
  };
}

function parseOutcomeRecord(value: unknown, request: JobRequestRecord): JobOutcomeRecord {
  if (!isRecord(value) || !exactKeys(value, ["version", "requestDigest", "outcome"])
    || value.version !== 1 || value.requestDigest !== request.requestDigest) fail("internal");
  return {
    version: 1,
    requestDigest: request.requestDigest,
    outcome: parseAdmissionOutcome(value.outcome, request),
  };
}

function parseStoredCancellation(
  value: unknown,
  scope: ProductionJobScope,
  remoteJobId: string,
  cancelKey: string,
): ProductionJobCancellationRequest {
  try { return parseCancellationRequest(value, scope, remoteJobId, cancelKey); }
  catch { fail("internal"); }
}

function parseCancellationRecord(
  value: unknown,
  scope: ProductionJobScope,
  remoteJobId: string,
  cancelKey: string,
): CancellationRecord {
  if (!isRecord(value) || !exactKeys(value, ["version", "requestDigest", "recordedAt", "request"])
    || value.version !== 1 || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)
    || !canonicalIso(value.recordedAt)) fail("internal");
  const request = parseStoredCancellation(value.request, scope, remoteJobId, cancelKey);
  if (productionJobCancellationRequestDigest(request) !== value.requestDigest) fail("internal");
  return { version: 1, requestDigest: value.requestDigest, recordedAt: value.recordedAt, request };
}

function parseCancellationResultRecord(
  value: unknown,
  request: CancellationRecord,
): CancellationResultRecord {
  if (!isRecord(value) || !exactKeys(value, ["version", "requestDigest", "result"])
    || value.version !== 1 || value.requestDigest !== request.requestDigest) fail("internal");
  return {
    version: 1,
    requestDigest: request.requestDigest,
    result: parseCancelResult(value.result, request.request.remoteJobId),
  };
}

function parsePreparedForProfile(
  value: unknown,
  request: ProductionJobPutRequest,
  expectedWorkflowDigest: string,
): PreparedSubmission {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "backendInstanceId", "remoteJobId", "idempotencyKey", "requestDigest", "request",
  ]) || value.version !== 1 || value.backendInstanceId !== request.backendInstanceId
    || value.remoteJobId !== request.remoteJobId || value.idempotencyKey !== request.idempotencyKey
    || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)
    || !isRecord(value.request) || !exactKeys(value.request, [
      "idempotencyKey", "remoteJobId", "workflow", "inputBinding",
    ])
    || value.request.idempotencyKey !== request.idempotencyKey
    || value.request.remoteJobId !== request.remoteJobId || value.request.inputBinding !== null
    || !isRecord(value.request.workflow)
    || productionJobWorkflowDigest(value.request.workflow) !== expectedWorkflowDigest) fail("internal");
  return {
    version: 1,
    backendInstanceId: request.backendInstanceId,
    remoteJobId: request.remoteJobId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: value.requestDigest,
    request: {
      idempotencyKey: request.idempotencyKey,
      remoteJobId: request.remoteJobId,
      workflow: value.request.workflow,
      inputBinding: null,
    },
  };
}

function scopeHash(scope: ProductionJobScope): string {
  return sha256(JSON.stringify(scope));
}

function idHash(remoteJobId: string): string {
  return sha256(remoteJobId);
}

function bindingPath(store: Store, remoteJobId: string): string {
  const digest = idHash(remoteJobId);
  return join(store.bindings, digest.slice(0, 2), `${digest}.json`);
}

function intentBindingPath(store: Store, scope: ProductionJobScope, idempotencyKey: string): string {
  return join(store.intentBindings, scopeHash(scope), `${sha256(idempotencyKey)}.json`);
}

function jobDirectory(store: Store, scope: ProductionJobScope, remoteJobId: string): string {
  return join(store.scopes, scopeHash(scope), "jobs", idHash(remoteJobId));
}

function jobFile(store: Store, scope: ProductionJobScope, remoteJobId: string, name: string): string {
  return join(jobDirectory(store, scope, remoteJobId), name);
}

function cancellationDirectory(
  store: Store,
  scope: ProductionJobScope,
  remoteJobId: string,
  cancelKey: string,
): string {
  return join(jobDirectory(store, scope, remoteJobId), "cancellations", cancelKey);
}

export class ProductionJobGateway {
  readonly #store: Store;
  readonly #credentialResolver: ProductionJobGatewayCredentialResolver;
  readonly #profileRegistry: ProductionJobProfileRegistry;
  readonly #profileValidator: ProductionJobProfileValidator;
  readonly #stageReceiptRegistry: ProductionStageReceiptRegistry;
  readonly #submissionAdmissionPolicy: SubmissionAdmissionPolicy;
  readonly #storageAdmissionPolicy: ProductionJobStorageAdmissionPolicy;
  readonly #rawAdapter: ProductionAdapter;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxRecordBytes: number;
  readonly #maxWorkflowBytes: number;
  readonly #now: () => Date;
  readonly #hooks: ProductionJobGatewayHooks;
  readonly #shutdown = new AbortController();
  readonly #active = new Set<AbortController>();
  readonly #admissionAcquireFlights = new Map<string, Promise<AdmissionDecisionRecord>>();
  readonly #admissionSettlementFlights = new Map<string, Promise<void>>();
  #closed = false;

  private constructor(options: ProductionJobGatewayOptions, store: Store) {
    this.#store = store;
    this.#credentialResolver = options.credentialResolver;
    this.#profileRegistry = options.profileRegistry;
    this.#profileValidator = options.profileValidator;
    this.#stageReceiptRegistry = options.stageReceiptRegistry;
    this.#submissionAdmissionPolicy = options.submissionAdmissionPolicy;
    this.#storageAdmissionPolicy = options.storageAdmissionPolicy;
    this.#rawAdapter = options.rawAdapter;
    if (typeof this.#credentialResolver !== "function" || !this.#profileRegistry
      || typeof this.#profileRegistry.resolve !== "function" || typeof this.#profileValidator !== "function"
      || !this.#stageReceiptRegistry || typeof this.#stageReceiptRegistry.verifyStageReceipt !== "function"
      || !this.#submissionAdmissionPolicy || typeof this.#submissionAdmissionPolicy.acquire !== "function"
      || typeof this.#submissionAdmissionPolicy.settle !== "function"
      || !this.#storageAdmissionPolicy || typeof this.#storageAdmissionPolicy.acquire !== "function"
      || typeof this.#storageAdmissionPolicy.commit !== "function"
      || typeof this.#storageAdmissionPolicy.release !== "function"
      || !this.#rawAdapter || typeof this.#rawAdapter.capabilities !== "function"
      || typeof this.#rawAdapter.prepareSubmission !== "function"
      || typeof this.#rawAdapter.submitPrepared !== "function" || typeof this.#rawAdapter.inspect !== "function"
      || typeof this.#rawAdapter.cancel !== "function") fail("invalid-request");
    this.#timeoutMs = safeInteger(
      options.timeoutMs, DEFAULT_PRODUCTION_JOB_GATEWAY_TIMEOUT_MS, 50, 900_000,
    );
    this.#maxRequestBytes = safeInteger(
      options.maxRequestBytes, DEFAULT_PRODUCTION_JOB_GATEWAY_REQUEST_BYTES, 1_024, 16 * 1024 * 1024,
    );
    this.#maxRecordBytes = safeInteger(
      options.maxRecordBytes, DEFAULT_PRODUCTION_JOB_GATEWAY_RECORD_BYTES, 1_024, 64 * 1024 * 1024,
    );
    this.#maxWorkflowBytes = safeInteger(
      options.maxWorkflowBytes, DEFAULT_PRODUCTION_JOB_GATEWAY_WORKFLOW_BYTES, 1_024, 64 * 1024 * 1024,
    );
    this.#now = options.now ?? (() => new Date());
    this.#hooks = options.hooks ?? {};
  }

  static async create(options: ProductionJobGatewayOptions): Promise<ProductionJobGateway> {
    if (!options || typeof options !== "object" || typeof options.storeRoot !== "string") fail("invalid-request");
    return new ProductionJobGateway(options, await initializeStore(options.storeRoot));
  }

  #operation(callerSignal: AbortSignal): Operation {
    if (this.#closed || this.#shutdown.signal.aborted) fail("aborted");
    const controller = new AbortController();
    this.#active.add(controller);
    const callerAbort = (): void => controller.abort(callerSignal.reason ?? new Error("aborted"));
    const shutdownAbort = (): void => controller.abort(new Error("shutdown"));
    if (callerSignal.aborted) callerAbort();
    else callerSignal.addEventListener("abort", callerAbort, { once: true });
    this.#shutdown.signal.addEventListener("abort", shutdownAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("deadline")), this.#timeoutMs);
    let finished = false;
    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        callerSignal.removeEventListener("abort", callerAbort);
        this.#shutdown.signal.removeEventListener("abort", shutdownAbort);
        this.#active.delete(controller);
      },
    };
  }

  async #authorize(
    request: Request,
    context: Readonly<{
      scope: Readonly<ProductionJobScope>;
      operation: "put-job" | "inspect-job" | "cancel-job" | "read-capabilities";
    }>,
    signal: AbortSignal,
  ): Promise<void> {
    let expected: string;
    try {
      expected = validateToken(await raceAbort(Promise.resolve(this.#credentialResolver(context, signal)), signal));
    } catch (error) {
      if (error instanceof ProductionJobGatewayError) throw error;
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    if (!constantTimeBearerMatches(request.headers.get("authorization"), expected)) fail("unauthorized");
  }

  async #publish(destination: string, value: unknown): Promise<boolean> {
    return await publishJson(
      this.#store, destination, value, this.#maxRecordBytes, this.#hooks.afterPublishLink,
    );
  }

  async #loadBinding(remoteJobId: string, signal: AbortSignal): Promise<JobBindingRecord | null> {
    await verifyRoot(this.#store);
    const value = await optionalJson(
      this.#store, bindingPath(this.#store, remoteJobId), this.#maxRecordBytes, signal,
    );
    return value === null ? null : parseBinding(value, remoteJobId);
  }

  async #loadIntentBinding(
    scope: ProductionJobScope,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<IntentJobBindingRecord | null> {
    await verifyRoot(this.#store);
    const value = await optionalJson(
      this.#store,
      intentBindingPath(this.#store, scope, idempotencyKey), this.#maxRecordBytes, signal,
    );
    return value === null ? null : parseIntentBinding(value, scope, idempotencyKey);
  }

  async #loadJob(
    scope: ProductionJobScope,
    remoteJobId: string,
    signal: AbortSignal,
  ): Promise<JobRequestRecord | null> {
    await verifyRoot(this.#store);
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, scope, remoteJobId, "request.json"), this.#maxRecordBytes, signal,
    );
    return value === null ? null : parseJobRequestRecord(value, scope, remoteJobId);
  }

  async #requireOwnedJob(
    scope: ProductionJobScope,
    remoteJobId: string,
    signal: AbortSignal,
  ): Promise<JobRequestRecord> {
    const binding = await this.#loadBinding(remoteJobId, signal);
    if (!binding || !sameScope(binding.scope, scope)) fail("not-found");
    const request = await this.#loadJob(scope, remoteJobId, signal);
    if (!request || request.requestDigest !== binding.requestDigest) fail("not-found");
    return request;
  }

  async #loadPreemption(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<JobPreemptionRecord | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "preempted.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parsePreemptionRecord(value, request);
  }

  async #loadTerminal(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<JobTerminalRecord | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "terminal.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parseTerminalRecord(value, request);
  }

  /** First writer wins: a concurrent observer's record is read back and returned unchanged. */
  async #recordTerminal(
    request: JobRequestRecord,
    observation: RemoteObservation,
    signal: AbortSignal,
  ): Promise<RemoteObservation> {
    const record: JobTerminalRecord = {
      version: 1,
      requestDigest: request.requestDigest,
      remoteJobId: request.request.remoteJobId,
      recordedAt: this.#now().toISOString(),
      observation,
    };
    const path = jobFile(this.#store, request.request.scope, request.request.remoteJobId, "terminal.json");
    const created = await this.#publish(path, record);
    if (created) return observation;
    const existing = await this.#loadTerminal(request, signal);
    return existing === null ? observation : existing.observation;
  }

  /**
   * The one observation path for a job. Durable verdicts outrank the provider: a preemption record
   * (§7) means the provider can no longer account for the job, and a recorded terminal state stays
   * the answer after ComfyUI's in-process history is pruned or lost. Otherwise the provider is asked
   * once, and a terminal answer is made durable so later reads and the restart sweep agree with it.
   * Returns null when the provider could not be reached.
   */
  async #observeJob(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<RemoteObservation | null> {
    const preempted = await this.#loadPreemption(request, signal);
    if (preempted !== null) return preemptedObservation(preempted);
    const terminal = await this.#loadTerminal(request, signal);
    if (terminal !== null) return terminal.observation;
    const observation = await this.#tryInspect(request.request.remoteJobId, signal);
    if (observation === null) return null;
    if (!TERMINAL_REMOTE_STATES.has(observation.state)) return observation;
    return await this.#recordTerminal(request, observation, signal);
  }

  /**
   * §7 restart sweep. Every durable job record that had already reached its raw submission attempt
   * and that the provider no longer knows is rewritten to `provider_failed:preempted`. A job the
   * provider still knows, and a job whose inspection could not be completed, are both left alone:
   * this pass only records a verdict it has evidence for, and reports what it could not decide.
   */
  async recoverPreemptedJobs(callerSignal?: AbortSignal): Promise<{
    scanned: number;
    rewritten: number;
    unresolved: number;
  }> {
    let scanned = 0;
    let rewritten = 0;
    let unresolved = 0;
    await verifyRoot(this.#store);
    let scopeDirectories: string[];
    try { scopeDirectories = await readdir(this.#store.scopes); }
    catch (error) {
      if (isNodeError(error, "ENOENT")) return { scanned: 0, rewritten: 0, unresolved: 0 };
      throw error;
    }
    for (const scopeDirectory of scopeDirectories.sort()) {
      if (!SHA256.test(scopeDirectory)) continue;
      const jobsRoot = join(this.#store.scopes, scopeDirectory, "jobs");
      let jobDirectories: string[];
      try { jobDirectories = await readdir(jobsRoot); }
      catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      for (const jobDirectory of jobDirectories.sort()) {
        if (!SHA256.test(jobDirectory)) continue;
        if (scanned >= MAX_PRODUCTION_JOB_RECOVERY_SCAN) fail("internal");
        scanned++;
        const outcome = await this.#recoverOneJob(
          join(jobsRoot, jobDirectory), scopeDirectory, callerSignal,
        );
        if (outcome === "rewritten") rewritten++;
        else if (outcome === "unresolved") unresolved++;
      }
    }
    return { scanned, rewritten, unresolved };
  }

  /**
   * One job, under its own deadline: a long batch must not make the whole sweep time out. Only a
   * caller abort or a shutdown ends the sweep; this job's own deadline elapsing means "no verdict
   * for this job", which is reported as `unresolved` and left for the next restart.
   */
  async #recoverOneJob(
    directory: string,
    scopeDirectory: string,
    callerSignal?: AbortSignal,
  ): Promise<"rewritten" | "unresolved" | "skipped"> {
    const fallback = new AbortController();
    const operation = this.#operation(callerSignal ?? fallback.signal);
    try { return await this.#recoverOneJobUnderDeadline(directory, scopeDirectory, operation.signal); }
    catch (error) {
      if (callerSignal?.aborted === true || this.#shutdown.signal.aborted) throw error;
      if (error instanceof ProductionJobGatewayError && error.code === "aborted") {
        this.#hooks.afterJobRecovery?.(Object.freeze({
          directory, outcome: "unresolved" as const, reason: "deadline",
        }));
        return "unresolved";
      }
      throw error;
    }
    finally { operation.finish(); }
  }

  async #recoverOneJobUnderDeadline(
    directory: string,
    scopeDirectory: string,
    signal: AbortSignal,
  ): Promise<"rewritten" | "unresolved" | "skipped"> {
    const value = await optionalJson(this.#store, join(directory, "request.json"), this.#maxRecordBytes, signal);
    if (value === null) return "skipped";
    if (!isRecord(value) || !isRecord(value.request)) fail("internal");
    const scope = parseScopeObjectInternal((value.request as Record<string, unknown>).scope);
    const remoteJobId = safeId((value.request as Record<string, unknown>).remoteJobId, "internal");
    // The store path is derived from the record's own identity, so a record found under a foreign
    // directory name is a corrupt store, not a job to make a verdict about.
    if (scopeHash(scope) !== scopeDirectory || idHash(remoteJobId) !== basename(directory)) fail("internal");
    const request = parseJobRequestRecord(value, scope, remoteJobId);
    if (await this.#loadPreemption(request, signal) !== null) return "skipped";
    // A recorded terminal state is the durable answer already: the job finished, and a pruned
    // provider history must not turn it into a preemption.
    if (await this.#loadTerminal(request, signal) !== null) return "skipped";
    // A durable not-submitted outcome proves no provider request was ever attempted.
    const outcomeValue = await optionalJson(
      this.#store, join(directory, "outcome.json"), this.#maxRecordBytes, signal,
    );
    if (outcomeValue !== null && parseOutcomeRecord(outcomeValue, request).outcome.state === "not-submitted") {
      return "skipped";
    }
    // No raw attempt claim means no POST was ever issued for this record; the coordinator's own
    // submission path still owns it, and marking it preempted would poison a live retry.
    const attempt = await optionalJson(
      this.#store, join(directory, "raw-attempt.json"), this.#maxRecordBytes, signal,
    );
    if (attempt === null) return "skipped";
    // Only a submitted, non-terminal job reaches the provider here.
    let observation: RemoteObservation;
    try { observation = parseObservation(await this.#rawAdapter.inspect(remoteJobId, signal), remoteJobId); }
    catch {
      if (signal.aborted) fail("aborted");
      this.#hooks.afterJobRecovery?.(Object.freeze({
        directory, outcome: "unresolved" as const, reason: "inspect-failed",
      }));
      return "unresolved";
    }
    if (TERMINAL_REMOTE_STATES.has(observation.state)) {
      await this.#recordTerminal(request, observation, signal);
      return "skipped";
    }
    if (observation.state !== "not-found") return "skipped";
    const recordedAt = this.#now().toISOString();
    const record: JobPreemptionRecord = {
      version: 1,
      requestDigest: request.requestDigest,
      remoteJobId,
      recordedAt,
      errorSummary: PRODUCTION_JOB_PREEMPTED_ERROR_SUMMARY,
      responseDigest: preemptionResponseDigest(remoteJobId, recordedAt),
    };
    await this.#publish(join(directory, "preempted.json"), record);
    return "rewritten";
  }

  async #resolveProfile(request: ProductionJobPutRequest, signal: AbortSignal): Promise<ProductionJobProfile> {
    let raw: ProductionJobProfile | null;
    try {
      raw = await raceAbort(Promise.resolve(
        this.#profileRegistry.resolve(Object.freeze(request.scope), request.profile.profileId, signal),
      ), signal);
    } catch (error) {
      if (signal.aborted) fail("aborted");
      if (error instanceof ProductionJobGatewayError) throw error;
      fail("forbidden");
    }
    if (raw === null) fail("forbidden");
    const profile = parseProfile(raw, request, this.#maxWorkflowBytes);
    let decision: boolean | void;
    try {
      decision = await raceAbort(Promise.resolve(
        this.#profileValidator(Object.freeze(request.scope), Object.freeze(profile), signal),
      ), signal);
    } catch (error) {
      if (signal.aborted) fail("aborted");
      if (error instanceof ProductionJobGatewayError) throw error;
      fail("forbidden");
    }
    if (decision === false) fail("forbidden");
    if (productionJobWorkflowDigest(profile.workflow) !== profile.workflowDigest) fail("forbidden");
    return profile;
  }

  async #verifiedStageReceipt(
    request: ProductionJobPutRequest,
    profile: ProductionJobProfile,
    signal: AbortSignal,
  ): Promise<VerifiedStageReceipt> {
    if (profile.stageProfileDigest === null || profile.execution === null
      || profile.h3GraphContract === null || profile.stageGraphBindings === null
      || request.inputBinding === null) fail("forbidden");
    const claim: ProductionStageReceiptClaim = {
      version: 1,
      scope: request.scope,
      stageKey: request.inputBinding.stageKey,
      bindingsDigest: request.inputBinding.bindingsDigest,
      intentDigest: request.inputBinding.intentDigest,
      profileDigest: profile.stageProfileDigest,
    };
    let verified: VerifiedStageReceipt | null = null;
    try {
      verified = await raceAbort(Promise.resolve(this.#stageReceiptRegistry.verifyStageReceipt({
        ...claim,
      }, signal)), signal);
    } catch {
      if (signal.aborted) fail("aborted");
    }
    if (verified === null) fail("forbidden");
    const parsed = parseVerifiedStageReceipt(verified, claim);
    if (canonicalJson(parsed.execution) !== canonicalJson(profile.execution)) fail("forbidden");
    return parsed;
  }

  async #resolveSubmissionProfile(
    request: ProductionJobPutRequest,
    signal: AbortSignal,
  ): Promise<ResolvedSubmissionProfile> {
    const profile = await this.#resolveProfile(request, signal);
    if (profile.stageProfileDigest === null) {
      if (request.inputBinding !== null || profile.execution !== null || profile.h3GraphContract !== null
        || profile.stageGraphBindings !== null || profile.workflowDigest !== request.profile.workflowDigest) {
        fail("forbidden");
      }
      return { profile, workflow: profile.workflow, workflowDigest: profile.workflowDigest };
    }
    const receipt = await this.#verifiedStageReceipt(request, profile, signal);
    if (profile.execution === null || profile.h3GraphContract === null || profile.stageGraphBindings === null
      || profile.execution.workflowSha256 !== profile.workflowDigest) fail("forbidden");
    // Contract v2 fills prompt/seed from the staged ShotRequest the stage kernel content-checked
    // and re-read; a null seed cannot be materialized into a pinned graph (§5.3).
    let shotBinding: ProductionH3ShotBinding | null = null;
    if (profile.h3GraphContract.version === 2) {
      if (receipt.shotRequest === null || receipt.shotRequest.seed === null) fail("forbidden");
      shotBinding = { prompt: receipt.shotRequest.prompt, seed: receipt.shotRequest.seed };
    } else if (receipt.shotRequest !== null) {
      fail("forbidden");
    }
    let materialized: ReturnType<typeof materializeProductionH3Workflow>;
    try {
      assertProductionH3Template(
        profile.workflow,
        profile.h3GraphContract,
        profile.execution,
        profile.stageGraphBindings,
        profile.profileId,
      );
      materialized = materializeProductionH3Workflow(
        profile.workflow,
        profile.h3GraphContract,
        profile.execution,
        profile.stageGraphBindings,
        receipt.bindings,
        profile.profileId,
        shotBinding,
      );
    } catch { fail("forbidden"); }
    if (materialized.templateWorkflowSha256 !== profile.workflowDigest
      || materialized.boundWorkflowSha256 !== request.profile.workflowDigest) fail("forbidden");
    let canonical: string;
    try { canonical = canonicalJson(materialized.workflow); }
    catch { fail("forbidden"); }
    if (Buffer.byteLength(canonical) > this.#maxWorkflowBytes
      || sha256(canonical) !== materialized.boundWorkflowSha256) fail("forbidden");
    const workflow = JSON.parse(canonical) as Record<string, unknown>;
    deepFreezeJson(workflow);
    return {
      profile,
      workflow,
      workflowDigest: materialized.boundWorkflowSha256,
    };
  }

  #storageAdmissionContext(
    request: ProductionJobPutRequest,
    requestDigest: string,
  ): Readonly<ProductionJobStorageAdmissionContext> {
    const recordBytesUpperBound = this.#maxRecordBytes * PRODUCTION_JOB_DURABLE_RECORDS_PER_SLOT;
    if (!Number.isSafeInteger(recordBytesUpperBound) || recordBytesUpperBound < 1) fail("internal");
    return Object.freeze({
      version: 1,
      scope: Object.freeze({ ...request.scope }),
      idempotencyKey: request.idempotencyKey,
      remoteJobId: request.remoteJobId,
      requestDigest,
      recordBytesUpperBound,
    });
  }

  #storageAdmission(
    request: ProductionJobPutRequest,
    requestDigest: string,
  ): StorageAdmission {
    return Object.freeze({
      storageKey: productionJobStorageKey(request.scope, request.idempotencyKey),
      context: this.#storageAdmissionContext(request, requestDigest),
    });
  }

  async #acquireStorageAdmission(admission: StorageAdmission, signal: AbortSignal): Promise<void> {
    let decision: ProductionJobStorageAdmissionDecision;
    try {
      decision = await raceAbort(Promise.resolve(
        this.#storageAdmissionPolicy.acquire(admission.context, admission.storageKey, signal),
      ), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    if (decision === "conflict") fail("conflict");
    if (decision === "capacity-exceeded") fail("storage-capacity");
    if (decision !== "allow") fail("internal");
    try {
      await raceAbort(Promise.resolve(
        this.#hooks.afterStorageAdmission?.(admission.context, admission.storageKey),
      ), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
  }

  async #commitStorageAdmission(
    admission: StorageAdmission,
    binding: JobBindingRecord,
    signal: AbortSignal,
  ): Promise<void> {
    let recordRef: string;
    try { recordRef = productionCanonicalJsonSha256(binding); }
    catch { fail("internal"); }
    try {
      await raceAbort(Promise.resolve(this.#storageAdmissionPolicy.commit(
        admission.context, admission.storageKey, recordRef, signal,
      )), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
  }

  async #releaseUnusedStorageAdmission(admission: StorageAdmission, signal: AbortSignal): Promise<void> {
    let decision: ProductionJobStorageReleaseDecision;
    try {
      decision = await raceAbort(Promise.resolve(this.#storageAdmissionPolicy.release(
        admission.context, admission.storageKey, "unused-before-record", signal,
      )), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    if (decision === "conflict") fail("conflict");
    if (decision !== "released") fail("internal");
  }

  #admissionContextForPolicy(record: AdmissionRequestRecord): Readonly<ProductionSubmissionAdmissionContext> {
    const context: ProductionSubmissionAdmissionContext = {
      ...record.context,
      scope: Object.freeze({ ...record.context.scope }),
      profile: Object.freeze({ ...record.context.profile }),
      inputBinding: record.context.inputBinding === null
        ? null
        : Object.freeze({ ...record.context.inputBinding }),
    };
    return Object.freeze(context);
  }

  async #loadAdmissionRequest(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<AdmissionRequestRecord | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "admission-request.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parseAdmissionRequestRecord(value, request);
  }

  async #ensureAdmissionRequest(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<AdmissionRequestRecord> {
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "admission-request.json",
    );
    const admissionKey = productionSubmissionAdmissionKey(
      request.request.scope, request.request.remoteJobId, request.requestDigest,
    );
    const record: AdmissionRequestRecord = {
      version: 1,
      admissionKey,
      requestDigest: request.requestDigest,
      recordedAt: this.#now().toISOString(),
      context: admissionContext(request),
    };
    if (await this.#publish(destination, record)) return record;
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    return parseAdmissionRequestRecord(existing, request);
  }

  async #loadAdmissionDecision(
    request: JobRequestRecord,
    admissionKey: string,
    signal: AbortSignal,
  ): Promise<AdmissionDecisionRecord | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "admission-decision.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parseAdmissionDecisionRecord(value, request, admissionKey);
  }

  async #runAdmissionAcquire(
    request: JobRequestRecord,
    admission: AdmissionRequestRecord,
    signal: AbortSignal,
  ): Promise<AdmissionDecisionRecord> {
    let decision: ProductionSubmissionAdmissionDecision;
    try {
      decision = await raceAbort(Promise.resolve(this.#submissionAdmissionPolicy.acquire(
        this.#admissionContextForPolicy(admission), admission.admissionKey, signal,
      )), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    if (decision !== "allow" && decision !== "deny") fail("internal");
    const durable: AdmissionDecisionRecord = {
      version: 1,
      admissionKey: admission.admissionKey,
      requestDigest: request.requestDigest,
      recordedAt: this.#now().toISOString(),
      decision,
    };
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "admission-decision.json",
    );
    if (await this.#publish(destination, durable)) return durable;
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    const parsed = parseAdmissionDecisionRecord(existing, request, admission.admissionKey);
    if (parsed.decision !== decision) fail("internal");
    return parsed;
  }

  async #acquireAdmission(
    request: JobRequestRecord,
    admission: AdmissionRequestRecord,
    signal: AbortSignal,
  ): Promise<AdmissionDecisionRecord> {
    const durable = await this.#loadAdmissionDecision(request, admission.admissionKey, signal);
    if (durable) return durable;
    const existingFlight = this.#admissionAcquireFlights.get(admission.admissionKey);
    if (existingFlight) return await raceAbort(existingFlight, signal);
    let flight!: Promise<AdmissionDecisionRecord>;
    flight = this.#runAdmissionAcquire(request, admission, signal).finally(() => {
      if (this.#admissionAcquireFlights.get(admission.admissionKey) === flight) {
        this.#admissionAcquireFlights.delete(admission.admissionKey);
      }
    });
    this.#admissionAcquireFlights.set(admission.admissionKey, flight);
    return await raceAbort(flight, signal);
  }

  async #loadRawAttemptClaim(
    request: JobRequestRecord,
    admissionKey: string,
    signal: AbortSignal,
  ): Promise<RawAttemptClaimRecord | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "raw-attempt.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parseRawAttemptClaimRecord(value, request, admissionKey);
  }

  async #claimRawAttempt(
    request: JobRequestRecord,
    admissionKey: string,
    signal: AbortSignal,
  ): Promise<{ claimed: boolean; record: RawAttemptClaimRecord }> {
    const now = this.#now();
    const record: RawAttemptClaimRecord = {
      version: 1,
      admissionKey,
      requestDigest: request.requestDigest,
      recordedAt: now.toISOString(),
      recoveryNotBefore: new Date(now.getTime() + this.#timeoutMs).toISOString(),
    };
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "raw-attempt.json",
    );
    if (await this.#publish(destination, record)) return { claimed: true, record };
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    return {
      claimed: false,
      record: parseRawAttemptClaimRecord(existing, request, admissionKey),
    };
  }

  async #recordPreparedAttempt(
    request: JobRequestRecord,
    prepared: PreparedSubmission,
    signal: AbortSignal,
  ): Promise<boolean> {
    const record: JobAttemptRecord = {
      version: 1,
      requestDigest: request.requestDigest,
      recordedAt: this.#now().toISOString(),
      providerRequestDigest: prepared.requestDigest,
      backendInstanceId: request.request.backendInstanceId,
      remoteJobId: request.request.remoteJobId,
      idempotencyKey: request.request.idempotencyKey,
    };
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "attempt.json",
    );
    if (await this.#publish(destination, record)) return true;
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    const parsed = parseAttemptRecord(existing, request);
    if (parsed.providerRequestDigest !== prepared.requestDigest) fail("internal");
    return false;
  }

  async #loadAdmissionOutcome(
    request: JobRequestRecord,
    _admissionKey: string,
    signal: AbortSignal,
  ): Promise<ProductionSubmissionAdmissionOutcome | null> {
    const value = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "outcome.json"),
      this.#maxRecordBytes,
      signal,
    );
    return value === null ? null : parseOutcomeRecord(value, request).outcome;
  }

  async #runAdmissionSettlement(
    request: JobRequestRecord,
    admission: AdmissionRequestRecord,
    pending: AdmissionSettlementPendingRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await raceAbort(Promise.resolve(this.#submissionAdmissionPolicy.settle(
        this.#admissionContextForPolicy(admission),
        admission.admissionKey,
        Object.freeze({
          ...pending.outcome,
          submitResult: pending.outcome.submitResult === null
            ? null
            : Object.freeze({ ...pending.outcome.submitResult }),
        }),
        signal,
      )), signal);
    } catch {
      if (signal.aborted) fail("aborted");
      fail("internal");
    }
    const acknowledged: AdmissionSettlementAcknowledgedRecord = {
      version: 1,
      admissionKey: admission.admissionKey,
      requestDigest: request.requestDigest,
      acknowledgedAt: this.#now().toISOString(),
      outcomeDigest: pending.outcomeDigest,
    };
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId,
      "admission-settlement-acknowledged.json",
    );
    if (await this.#publish(destination, acknowledged)) return;
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    parseAdmissionSettlementAcknowledgedRecord(
      existing, request, admission.admissionKey, pending.outcomeDigest,
    );
  }

  async #settleAdmission(
    request: JobRequestRecord,
    admission: AdmissionRequestRecord,
    outcome: ProductionSubmissionAdmissionOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const pendingPath = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "admission-settlement-pending.json",
    );
    const pendingRecord: AdmissionSettlementPendingRecord = {
      version: 1,
      admissionKey: admission.admissionKey,
      requestDigest: request.requestDigest,
      recordedAt: this.#now().toISOString(),
      outcomeDigest: admissionOutcomeDigest(outcome),
      outcome,
    };
    let pending = pendingRecord;
    if (!await this.#publish(pendingPath, pendingRecord)) {
      const existing = await optionalJson(this.#store, pendingPath, this.#maxRecordBytes, signal);
      if (existing === null) fail("internal");
      pending = parseAdmissionSettlementPendingRecord(
        existing, request, admission.admissionKey, outcome,
      );
    }
    const acknowledgedValue = await optionalJson(
      this.#store,
      jobFile(
        this.#store, request.request.scope, request.request.remoteJobId,
        "admission-settlement-acknowledged.json",
      ),
      this.#maxRecordBytes,
      signal,
    );
    if (acknowledgedValue !== null) {
      parseAdmissionSettlementAcknowledgedRecord(
        acknowledgedValue, request, admission.admissionKey, pending.outcomeDigest,
      );
      return;
    }
    const existingFlight = this.#admissionSettlementFlights.get(admission.admissionKey);
    if (existingFlight) return await raceAbort(existingFlight, signal);
    let flight!: Promise<void>;
    flight = this.#runAdmissionSettlement(request, admission, pending, signal).finally(() => {
      if (this.#admissionSettlementFlights.get(admission.admissionKey) === flight) {
        this.#admissionSettlementFlights.delete(admission.admissionKey);
      }
    });
    this.#admissionSettlementFlights.set(admission.admissionKey, flight);
    await raceAbort(flight, signal);
  }

  async #persistJobOutcome(
    request: JobRequestRecord,
    outcome: ProductionSubmissionAdmissionOutcome,
    signal: AbortSignal,
  ): Promise<ProductionSubmissionAdmissionOutcome> {
    const destination = jobFile(
      this.#store, request.request.scope, request.request.remoteJobId, "outcome.json",
    );
    const durable: JobOutcomeRecord = { version: 1, requestDigest: request.requestDigest, outcome };
    if (await this.#publish(destination, durable)) return outcome;
    const existing = await optionalJson(this.#store, destination, this.#maxRecordBytes, signal);
    if (existing === null) fail("internal");
    return parseOutcomeRecord(existing, request).outcome;
  }

  async #persistJobError(
    request: JobRequestRecord,
    state: "not-submitted" | "submission-unknown",
    code: ProductionAdapterErrorCode | "internal",
    signal: AbortSignal,
  ): Promise<ProductionSubmissionAdmissionOutcome> {
    return await this.#persistJobOutcome(request, {
      version: 1,
      state,
      submitResult: null,
      errorCode: code,
    }, signal);
  }

  async #persistJobResult(
    request: JobRequestRecord,
    result: SubmitResult,
    signal: AbortSignal,
  ): Promise<ProductionSubmissionAdmissionOutcome> {
    return await this.#persistJobOutcome(request, {
      version: 1,
      state: "submitted",
      submitResult: result,
      errorCode: null,
    }, signal);
  }

  async #prepareForRaw(
    request: JobRequestRecord,
    resolvedProfile: ResolvedSubmissionProfile | null,
    signal: AbortSignal,
  ): Promise<PreparedSubmission> {
    const resolved = resolvedProfile ?? await this.#resolveSubmissionProfile(request.request, signal);
    if (productionJobWorkflowDigest(resolved.workflow) !== resolved.workflowDigest) fail("forbidden");
    return parsePreparedForProfile(this.#rawAdapter.prepareSubmission({
      idempotencyKey: request.request.idempotencyKey,
      remoteJobId: request.request.remoteJobId,
      workflow: resolved.workflow,
      inputBinding: null,
    }), request.request, resolved.workflowDigest);
  }

  async #resumeSubmission(
    request: JobRequestRecord,
    resolvedProfile: ResolvedSubmissionProfile | null,
    signal: AbortSignal,
  ): Promise<Response> {
    const admissionKey = productionSubmissionAdmissionKey(
      request.request.scope, request.request.remoteJobId, request.requestDigest,
    );
    let admission = await this.#loadAdmissionRequest(request, signal);
    let decision = admission === null
      ? null
      : await this.#loadAdmissionDecision(request, admission.admissionKey, signal);
    let outcome = await this.#loadAdmissionOutcome(request, admissionKey, signal);
    if (outcome !== null) {
      if (admission === null || decision === null) fail("internal");
      if (decision.decision === "allow") await this.#settleAdmission(request, admission, outcome, signal);
      return await this.#submissionResponse(request, signal);
    }

    const existingRawAttempt = await this.#loadRawAttemptClaim(request, admissionKey, signal);
    if (existingRawAttempt !== null) {
      if (admission === null || decision?.decision !== "allow") fail("internal");
      if (this.#now().getTime() >= Date.parse(existingRawAttempt.recoveryNotBefore)) {
        await this.#persistJobError(request, "submission-unknown", "submission-unknown", signal);
        outcome = await this.#loadAdmissionOutcome(request, admissionKey, signal);
        if (outcome === null) fail("internal");
        await this.#settleAdmission(request, admission, outcome, signal);
      }
      return await this.#submissionResponse(request, signal);
    }

    let prepared: PreparedSubmission;
    if (admission === null) {
      // Fresh work performs every trusted, side-effect-free validation before reserving budget.
      prepared = await this.#prepareForRaw(request, resolvedProfile, signal);
      admission = await this.#ensureAdmissionRequest(request, signal);
      decision = await this.#acquireAdmission(request, admission, signal);
    } else {
      // A pending request may be an acquire response-loss. Replay the exact stable key first so an
      // externally committed allow can always be settled if later pre-raw validation fails.
      decision ??= await this.#acquireAdmission(request, admission, signal);
      if (decision.decision === "deny") {
        await this.#persistJobError(request, "not-submitted", "remote-rejected", signal);
        return await this.#submissionResponse(request, signal);
      }
      try {
        prepared = await this.#prepareForRaw(request, resolvedProfile, signal);
      } catch (error) {
        await this.#persistJobError(request, "not-submitted", adapterErrorCode(error), signal);
        outcome = await this.#loadAdmissionOutcome(request, admission.admissionKey, signal);
        if (outcome === null) fail("internal");
        await this.#settleAdmission(request, admission, outcome, signal);
        return await this.#submissionResponse(request, signal);
      }
    }
    if (decision.decision === "deny") {
      await this.#persistJobError(request, "not-submitted", "remote-rejected", signal);
      return await this.#submissionResponse(request, signal);
    }
    let attemptCreated: boolean;
    try {
      attemptCreated = await this.#recordPreparedAttempt(request, prepared, signal);
    } catch {
      // No raw-attempt claim exists at this point. In particular, a restarted adapter may prepare
      // different provider bytes than the already-durable attempt. Close that pre-submit permit
      // deterministically instead of leaking it or guessing that the provider saw a request.
      await this.#persistJobError(request, "not-submitted", "internal", signal);
      outcome = await this.#loadAdmissionOutcome(request, admission.admissionKey, signal);
      if (outcome === null) fail("internal");
      await this.#settleAdmission(request, admission, outcome, signal);
      return await this.#submissionResponse(request, signal);
    }
    if (attemptCreated) {
      await raceAbort(Promise.resolve(this.#hooks.afterAttemptDurable?.(Object.freeze(prepared))), signal);
    }
    const rawAttempt = await this.#claimRawAttempt(request, admission.admissionKey, signal);
    if (!rawAttempt.claimed) {
      outcome = await this.#loadAdmissionOutcome(request, admission.admissionKey, signal);
      if (outcome === null && this.#now().getTime() >= Date.parse(rawAttempt.record.recoveryNotBefore)) {
        await this.#persistJobError(request, "submission-unknown", "submission-unknown", signal);
        outcome = await this.#loadAdmissionOutcome(request, admission.admissionKey, signal);
      }
      if (outcome !== null) await this.#settleAdmission(request, admission, outcome, signal);
      return await this.#submissionResponse(request, signal);
    }
    await raceAbort(Promise.resolve(this.#hooks.afterRawAttemptDurable?.(Object.freeze(prepared))), signal);
    try {
      const result = parseSubmitResult(
        await this.#rawAdapter.submitPrepared(prepared, signal), request.request.remoteJobId,
      );
      await raceAbort(Promise.resolve(this.#hooks.afterRawSubmit?.(Object.freeze(result))), signal);
      await this.#persistJobResult(request, result, signal);
    } catch (error) {
      const code = adapterErrorCode(error);
      await this.#persistJobError(
        request, code === "remote-rejected" ? "not-submitted" : "submission-unknown", code, signal,
      );
    }
    outcome = await this.#loadAdmissionOutcome(request, admission.admissionKey, signal);
    if (outcome === null) fail("internal");
    await this.#settleAdmission(request, admission, outcome, signal);
    if (signal.aborted) fail("aborted");
    return await this.#submissionResponse(request, signal);
  }

  async #tryInspect(remoteJobId: string, signal: AbortSignal): Promise<RemoteObservation | null> {
    try {
      return parseObservation(await this.#rawAdapter.inspect(remoteJobId, signal), remoteJobId);
    } catch {
      if (signal.aborted) fail("aborted");
      return null;
    }
  }

  async #submissionResponse(
    request: JobRequestRecord,
    signal: AbortSignal,
  ): Promise<Response> {
    const outcomeValue = await optionalJson(
      this.#store,
      jobFile(this.#store, request.request.scope, request.request.remoteJobId, "outcome.json"),
      this.#maxRecordBytes,
      signal,
    );
    const outcome = outcomeValue === null ? null : parseOutcomeRecord(outcomeValue, request).outcome;
    const result = outcome?.submitResult ?? null;
    // A durable not-submitted outcome proves no provider request was attempted, regardless of
    // whether the reason is a policy denial or an internal pre-raw drift. Do not turn a response
    // render into an unnecessary provider network call.
    const observation = outcome?.state === "not-submitted"
      ? null
      : await this.#observeJob(request, signal);
    const submissionState: ProductionJobSubmissionState = outcome?.state === "submitted" ? "accepted"
      : outcome?.state === "not-submitted" && outcome.errorCode === "remote-rejected"
        ? "rejected"
        : "submission-unknown";
    const response: ProductionJobPutResponse = {
      version: 1,
      scope: request.request.scope,
      backendInstanceId: request.request.backendInstanceId,
      remoteJobId: request.request.remoteJobId,
      requestDigest: request.requestDigest,
      submissionState,
      submitResult: result,
      observation,
    };
    return jsonResponse(response, submissionState === "accepted" ? 200 : submissionState === "rejected" ? 422 : 202);
  }

  async #putJob(
    httpRequest: Request,
    route: Extract<ParsedRoute, { kind: "job" }>,
    signal: AbortSignal,
  ): Promise<Response> {
    const body = parsePutRequest(
      await readBoundedJsonRequest(httpRequest, this.#maxRequestBytes, signal), route.scope, route.remoteJobId,
    );
    const requestDigest = productionJobPutRequestDigest(body);
    if (httpRequest.headers.get("x-writing-loop-request-digest") !== requestDigest
      || httpRequest.headers.get("x-writing-loop-idempotency-key") !== body.idempotencyKey) {
      fail("invalid-request");
    }
    if (body.inputBinding !== null && body.inputBinding.intentDigest !== body.idempotencyKey) {
      fail("invalid-request");
    }

    const existingIntentBinding = await this.#loadIntentBinding(body.scope, body.idempotencyKey, signal);
    if (existingIntentBinding && (existingIntentBinding.remoteJobId !== body.remoteJobId
      || existingIntentBinding.requestDigest !== requestDigest)) fail("conflict");
    const existingBinding = await this.#loadBinding(route.remoteJobId, signal);
    const existingBindingConflicts = existingBinding !== null
      && (!sameScope(existingBinding.scope, route.scope) || existingBinding.requestDigest !== requestDigest);
    const existingJob = await this.#loadJob(route.scope, route.remoteJobId, signal);
    const existingJobMatches = existingJob !== null && existingJob.requestDigest === requestDigest
      && JSON.stringify(existingJob.request) === JSON.stringify(body);
    if (existingJobMatches && !existingBindingConflicts) {
      return await this.#resumeSubmission(existingJob, null, signal);
    }
    const existingRemoteConflicts = existingBindingConflicts || existingJob !== null;
    // An exact scoped intent record is already this key's own durable record. Even if the remote
    // side is inconsistent, it is committed/non-releasable and must fail without policy release.
    if (existingRemoteConflicts && existingIntentBinding !== null) fail("conflict");

    const profile = await this.#resolveSubmissionProfile(body, signal);
    const storageAdmission = this.#storageAdmission(body, requestDigest);
    if (existingRemoteConflicts) {
      // No record exists for this storage key; every remote record belongs to another context.
      // This is also the exact replay path for a response-lost prior release.
      await this.#releaseUnusedStorageAdmission(storageAdmission, signal);
      fail("conflict");
    }
    // The durable quota authority owns the stable slot before any global/scoped job record is
    // published. Profile/receipt/H3 proof above is pure and prevents invalid requests consuming it.
    await this.#acquireStorageAdmission(storageAdmission, signal);
    // Claim the global remote ID first. If two intents race for one ID, the loser must not poison
    // its scoped intent binding. The inverse race may leave only an unusable random remote-ID
    // tombstone, while the winning intent remains recoverable and unique.
    const binding: JobBindingRecord = { version: 1, remoteJobId: body.remoteJobId, scope: body.scope, requestDigest };
    const bindingCreated = await this.#publish(bindingPath(this.#store, body.remoteJobId), binding);
    if (!bindingCreated) {
      const winner = await this.#loadBinding(body.remoteJobId, signal);
      if (!winner || !sameScope(winner.scope, body.scope) || winner.requestDigest !== requestDigest) {
        // O_EXCL proved this key published no record. Release only this uncommitted loser slot.
        await this.#releaseUnusedStorageAdmission(storageAdmission, signal);
        fail("conflict");
      }
    }
    // Commit before a second job record. A response-lost commit stops here; exact replay finds the
    // same binding and repeats acquire+commit without ever releasing a potentially durable slot.
    await this.#commitStorageAdmission(storageAdmission, binding, signal);
    const intentBinding: IntentJobBindingRecord = {
      version: 1,
      scope: body.scope,
      idempotencyKey: body.idempotencyKey,
      remoteJobId: body.remoteJobId,
      requestDigest,
    };
    const intentBindingCreated = await this.#publish(
      intentBindingPath(this.#store, body.scope, body.idempotencyKey), intentBinding,
    );
    if (!intentBindingCreated) {
      const winner = await this.#loadIntentBinding(body.scope, body.idempotencyKey, signal);
      if (!winner || winner.remoteJobId !== body.remoteJobId || winner.requestDigest !== requestDigest) {
        fail("conflict");
      }
    }
    const record: JobRequestRecord = {
      version: 1,
      requestDigest,
      recordedAt: this.#now().toISOString(),
      request: body,
    };
    const requestPath = jobFile(this.#store, body.scope, body.remoteJobId, "request.json");
    const created = await this.#publish(requestPath, record);
    if (!created) {
      const winner = await this.#loadJob(body.scope, body.remoteJobId, signal);
      if (!winner || winner.requestDigest !== requestDigest) fail("conflict");
      return await this.#resumeSubmission(winner, null, signal);
    }

    await raceAbort(Promise.resolve(this.#hooks.afterJobDurable?.(Object.freeze(body))), signal);
    return await this.#resumeSubmission(record, profile, signal);
  }

  async #getJob(route: Extract<ParsedRoute, { kind: "job" }>, signal: AbortSignal): Promise<Response> {
    const request = await this.#requireOwnedJob(route.scope, route.remoteJobId, signal);
    const observation = await this.#observeJob(request, signal);
    if (observation === null) fail("raw-unavailable");
    const response: ProductionJobGetResponse = {
      version: 1,
      scope: route.scope,
      backendInstanceId: request.request.backendInstanceId,
      remoteJobId: route.remoteJobId,
      observation,
    };
    return jsonResponse(response);
  }

  async #putCancellation(
    httpRequest: Request,
    route: Extract<ParsedRoute, { kind: "cancel" }>,
    signal: AbortSignal,
  ): Promise<Response> {
    const job = await this.#requireOwnedJob(route.scope, route.remoteJobId, signal);
    const body = parseCancellationRequest(
      await readBoundedJsonRequest(httpRequest, this.#maxRequestBytes, signal),
      route.scope,
      route.remoteJobId,
      route.cancelKey,
    );
    const requestDigest = productionJobCancellationRequestDigest(body);
    if (body.backendInstanceId !== job.request.backendInstanceId
      || httpRequest.headers.get("x-writing-loop-request-digest") !== requestDigest
      || httpRequest.headers.get("x-writing-loop-idempotency-key") !== route.cancelKey) fail("invalid-request");
    const directory = cancellationDirectory(this.#store, route.scope, route.remoteJobId, route.cancelKey);
    const requestPath = join(directory, "request.json");
    const record: CancellationRecord = {
      version: 1,
      requestDigest,
      recordedAt: this.#now().toISOString(),
      request: body,
    };
    const created = await this.#publish(requestPath, record);
    let durableRecord = record;
    if (!created) {
      durableRecord = parseCancellationRecord(
        await readJson(this.#store, requestPath, this.#maxRecordBytes, signal),
        route.scope, route.remoteJobId, route.cancelKey,
      );
      if (durableRecord.requestDigest !== requestDigest || JSON.stringify(durableRecord.request) !== JSON.stringify(body)) {
        fail("conflict");
      }
    } else {
      await raceAbort(Promise.resolve(this.#hooks.afterCancellationDurable?.(Object.freeze(body))), signal);
      try {
        const result = parseCancelResult(
          await this.#rawAdapter.cancel(route.remoteJobId, signal), route.remoteJobId,
        );
        const durable: CancellationResultRecord = { version: 1, requestDigest, result };
        await this.#publish(join(directory, "result.json"), durable);
      } catch {
        if (signal.aborted) fail("aborted");
        // The immutable cancellation request remains the honest outbox. Never infer terminal state.
      }
    }
    const resultValue = await optionalJson(
      this.#store, join(directory, "result.json"), this.#maxRecordBytes, signal,
    );
    const result = resultValue === null ? null : parseCancellationResultRecord(resultValue, durableRecord).result;
    const observation = await this.#observeJob(job, signal);
    const response: ProductionJobCancellationResponse = {
      version: 1,
      scope: route.scope,
      backendInstanceId: job.request.backendInstanceId,
      remoteJobId: route.remoteJobId,
      cancelKey: route.cancelKey,
      requestDigest,
      cancelResult: result,
      observation,
    };
    return jsonResponse(response);
  }

  /** Fetch-compatible private HTTP boundary. */
  /**
   * §8.6 capability forwarding: the answer is the raw adapter's own capability descriptor, parsed
   * with the same strict reader the coordinator uses on the wire. The kernel never authors a
   * literal — a backend whose descriptor does not satisfy §4.3 must fail here, not silently
   * present a fabricated one.
   */
  async #capabilities(scope: ProductionJobScope, signal: AbortSignal): Promise<Response> {
    let raw: BackendCapabilities;
    try { raw = await raceAbort(Promise.resolve(this.#rawAdapter.capabilities(signal)), signal); }
    catch {
      if (signal.aborted) fail("aborted");
      fail("raw-unavailable");
    }
    let parsed: Required<BackendCapabilities>;
    try { parsed = parseBackendCapabilities(raw, "ProductionJobGateway.capabilities"); }
    catch { fail("internal"); }
    return jsonResponse({ version: 1, scope, capabilities: parsed });
  }

  async handle(request: Request): Promise<Response> {
    let operation: Operation | null = null;
    try {
      const route = parseRoute(new URL(request.url));
      const credentialOperation = route.kind === "cancel" && request.method === "PUT"
        ? "cancel-job" as const
        : route.kind === "job" && request.method === "PUT"
          ? "put-job" as const
          : route.kind === "job" && request.method === "GET"
            ? "inspect-job" as const
            : route.kind === "capabilities" && request.method === "GET"
              ? "read-capabilities" as const
              : null;
      if (credentialOperation === null) fail("not-found");
      operation = this.#operation(request.signal);
      await verifyRoot(this.#store);
      await this.#authorize(request, Object.freeze({
        scope: Object.freeze({ ...route.scope }),
        operation: credentialOperation,
      }), operation.signal);
      if (route.kind === "capabilities") return await this.#capabilities(route.scope, operation.signal);
      if (route.kind === "job" && request.method === "PUT") return await this.#putJob(request, route, operation.signal);
      if (route.kind === "job" && request.method === "GET") return await this.#getJob(route, operation.signal);
      if (route.kind === "cancel" && request.method === "PUT") {
        return await this.#putCancellation(request, route, operation.signal);
      }
      throw new ProductionJobGatewayError("not-found");
    } catch (error) {
      if (error instanceof ProductionJobGatewayError) return errorResponse(error);
      if (operation?.signal.aborted) return errorResponse(new ProductionJobGatewayError("aborted"));
      return errorResponse(new ProductionJobGatewayError("internal"));
    } finally {
      operation?.finish();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown.abort(new Error("shutdown"));
    for (const controller of this.#active) controller.abort(new Error("shutdown"));
  }
}

function adapterFailure(
  code: ProductionAdapterErrorCode,
  message: string,
  status?: number,
): ProductionAdapterError {
  return new ProductionAdapterError(code, message, status === undefined ? {} : { status });
}

function clientScope(value: unknown, expected: ProductionJobScope): ProductionJobScope {
  try {
    const scope = parseScopeObject(value);
    if (!sameScope(scope, expected)) throw new Error("scope mismatch");
    return scope;
  } catch {
    throw adapterFailure("invalid-response", "Production Gateway scope 响应无效");
  }
}

function clientObservation(value: unknown, remoteJobId: string): RemoteObservation {
  try { return parseObservation(value, remoteJobId, "invalid-request"); }
  catch { throw adapterFailure("invalid-response", "Production Gateway observation 响应无效"); }
}

function clientSubmitResult(value: unknown, remoteJobId: string): SubmitResult {
  try { return parseSubmitResult(value, remoteJobId, "invalid-request"); }
  catch { throw adapterFailure("invalid-response", "Production Gateway submit result 响应无效"); }
}

function clientCancelResult(value: unknown, remoteJobId: string): CancelResult {
  try { return parseCancelResult(value, remoteJobId, "invalid-request"); }
  catch { throw adapterFailure("invalid-response", "Production Gateway cancel result 响应无效"); }
}

function parsePutResponse(
  value: unknown,
  expectedScope: ProductionJobScope,
  expectedBackend: string,
  expectedId: string,
  expectedDigest: string,
): ProductionJobPutResponse {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "backendInstanceId", "remoteJobId", "requestDigest",
    "submissionState", "submitResult", "observation",
  ]) || value.version !== 1 || value.backendInstanceId !== expectedBackend
    || value.remoteJobId !== expectedId || value.requestDigest !== expectedDigest
    || (value.submissionState !== "accepted" && value.submissionState !== "rejected"
      && value.submissionState !== "submission-unknown")) {
    throw adapterFailure("invalid-response", "Production Gateway submit 响应 DTO 无效");
  }
  const scope = clientScope(value.scope, expectedScope);
  const submitResult = value.submitResult === null ? null : clientSubmitResult(value.submitResult, expectedId);
  const observation = value.observation === null ? null : clientObservation(value.observation, expectedId);
  if ((value.submissionState === "accepted") !== (submitResult !== null)
    || (value.submissionState !== "accepted" && submitResult !== null)) {
    throw adapterFailure("invalid-response", "Production Gateway submit state/result 不一致");
  }
  return {
    version: 1,
    scope,
    backendInstanceId: expectedBackend,
    remoteJobId: expectedId,
    requestDigest: expectedDigest,
    submissionState: value.submissionState,
    submitResult,
    observation,
  };
}

function parseGetResponse(
  value: unknown,
  expectedScope: ProductionJobScope,
  expectedBackend: string,
  expectedId: string,
): ProductionJobGetResponse {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "backendInstanceId", "remoteJobId", "observation",
  ]) || value.version !== 1 || value.backendInstanceId !== expectedBackend || value.remoteJobId !== expectedId) {
    throw adapterFailure("invalid-response", "Production Gateway inspect 响应 DTO 无效");
  }
  return {
    version: 1,
    scope: clientScope(value.scope, expectedScope),
    backendInstanceId: expectedBackend,
    remoteJobId: expectedId,
    observation: clientObservation(value.observation, expectedId),
  };
}

function parseCancellationResponse(
  value: unknown,
  expectedScope: ProductionJobScope,
  expectedBackend: string,
  expectedId: string,
  expectedCancelKey: string,
  expectedDigest: string,
): ProductionJobCancellationResponse {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "scope", "backendInstanceId", "remoteJobId", "cancelKey", "requestDigest",
    "cancelResult", "observation",
  ]) || value.version !== 1 || value.backendInstanceId !== expectedBackend || value.remoteJobId !== expectedId
    || value.cancelKey !== expectedCancelKey || value.requestDigest !== expectedDigest) {
    throw adapterFailure("invalid-response", "Production Gateway cancel 响应 DTO 无效");
  }
  return {
    version: 1,
    scope: clientScope(value.scope, expectedScope),
    backendInstanceId: expectedBackend,
    remoteJobId: expectedId,
    cancelKey: expectedCancelKey,
    requestDigest: expectedDigest,
    cancelResult: value.cancelResult === null ? null : clientCancelResult(value.cancelResult, expectedId),
    observation: value.observation === null ? null : clientObservation(value.observation, expectedId),
  };
}

function validateClientWorkflow(value: unknown, maximum: number): Record<string, unknown> {
  if (!isRecord(value)) throw adapterFailure("remote-rejected", "Production Gateway workflow 必须是对象");
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 4096) {
    throw adapterFailure("remote-rejected", "Production Gateway workflow 节点数无效");
  }
  for (const [nodeId, node] of entries) {
    if (!fullMatch(SAFE_ID, nodeId) || !isRecord(node) || typeof node.class_type !== "string"
      || node.class_type.length < 1 || node.class_type.length > 240 || !isRecord(node.inputs)) {
      throw adapterFailure("remote-rejected", "Production Gateway workflow 不是合法 API-format graph");
    }
  }
  let canonical: string;
  try { canonical = canonicalJson(value); }
  catch { throw adapterFailure("remote-rejected", "Production Gateway workflow 不是 canonical JSON"); }
  if (Buffer.byteLength(canonical) > maximum) {
    throw adapterFailure("remote-rejected", "Production Gateway workflow 超限");
  }
  return value;
}

function parseClientSubmitRequest(value: SubmitRequest, maximum: number): SubmitRequest {
  if (!isRecord(value) || !exactKeys(value, ["idempotencyKey", "remoteJobId", "workflow", "inputBinding"])) {
    throw adapterFailure("remote-rejected", "Production Gateway submit request 字段无效");
  }
  let idempotencyKey: string;
  let remoteJobId: string;
  try {
    idempotencyKey = safeId(value.idempotencyKey);
    remoteJobId = safeId(value.remoteJobId);
  } catch {
    throw adapterFailure("remote-rejected", "Production Gateway submit identity 无效");
  }
  let inputBinding: ProductionSubmissionInputBinding | null;
  try { inputBinding = parseInputBinding(value.inputBinding); }
  catch { throw adapterFailure("remote-rejected", "Production Gateway input binding 无效"); }
  return {
    idempotencyKey,
    remoteJobId,
    workflow: validateClientWorkflow(value.workflow, maximum),
    inputBinding,
  };
}

async function readClientJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw adapterFailure("invalid-response", "Production Gateway Content-Length 无效");
    if (BigInt(declared) > BigInt(maximum)) {
      void response.body?.cancel().catch(() => undefined);
      throw adapterFailure("response-too-large", "Production Gateway 响应超限");
    }
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw adapterFailure("invalid-response", "Production Gateway 响应 MIME 无效");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await raceAbort(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        void reader.cancel().catch(() => undefined);
        throw adapterFailure("response-too-large", "Production Gateway 响应超限");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes < 1 || (declared !== null && Number(declared) !== bytes)) {
    throw adapterFailure("invalid-response", "Production Gateway 响应长度无效");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { throw adapterFailure("invalid-response", "Production Gateway 响应编码无效"); }
  try { return JSON.parse(text); }
  catch { throw adapterFailure("invalid-response", "Production Gateway 响应 JSON 无效"); }
}

export class ProductionGatewayAdapter implements ProductionAdapter {
  readonly #baseUrl: URL;
  readonly #scope: ProductionJobScope;
  readonly #backendInstanceId: string;
  readonly #profileId: string;
  readonly #credentialResolver: ProductionGatewayAdapterCredentialResolver;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxWorkflowBytes: number;

  constructor(options: ProductionGatewayAdapterOptions) {
    const transport = options.transport ?? "tls";
    if (transport !== "tls" && transport !== "insecure-private-http") {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter transport 配置无效");
    }
    this.#baseUrl = trustedBaseUrl(options.baseUrl, transport, typeof options.credentialResolver === "function");
    try {
      this.#scope = parseScope(options.workspaceId, options.project);
      this.#backendInstanceId = safeId(options.backendInstanceId);
      this.#profileId = safeProfileId(options.profileId);
    } catch {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter scope/profile 配置无效");
    }
    if (typeof options.credentialResolver !== "function") {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter credential resolver 缺失");
    }
    this.#credentialResolver = options.credentialResolver;
    this.#fetch = options.fetch ?? fetch;
    try {
      this.#timeoutMs = safeInteger(
        options.timeoutMs, DEFAULT_PRODUCTION_JOB_GATEWAY_TIMEOUT_MS, 50, 300_000,
      );
      this.#maxResponseBytes = safeInteger(
        options.maxResponseBytes, DEFAULT_PRODUCTION_JOB_GATEWAY_RESPONSE_BYTES, 1_024, 16 * 1024 * 1024,
      );
      this.#maxWorkflowBytes = safeInteger(
        options.maxWorkflowBytes, DEFAULT_PRODUCTION_JOB_GATEWAY_WORKFLOW_BYTES, 1_024, 64 * 1024 * 1024,
      );
    } catch {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter limits 配置无效");
    }
  }

  /**
   * §8.6: read the gateway's forwarded capability descriptor instead of authoring a literal here.
   * The gateway derives it from its own registry, so the coordinator sees the backend's real model
   * families, processing regions and per-profile limits (§4.3).
   */
  async capabilities(signal?: AbortSignal): Promise<BackendCapabilities> {
    const exchanged = await this.#exchange(
      endpoint(this.#baseUrl, this.#scope, "capabilities"),
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (exchanged.status !== 200) {
      throw adapterFailure(
        exchanged.status >= 400 && exchanged.status < 500 ? "remote-rejected" : "remote-unavailable",
        `Production Gateway capabilities 返回 ${exchanged.status}`,
      );
    }
    const value = exchanged.value;
    if (!isRecord(value) || !exactKeys(value, ["version", "scope", "capabilities"]) || value.version !== 1) {
      throw adapterFailure("invalid-response", "Production Gateway capabilities 响应无效");
    }
    const scope = value.scope;
    if (!isRecord(scope) || scope.workspaceId !== this.#scope.workspaceId
      || scope.project !== this.#scope.project) {
      throw adapterFailure("invalid-response", "Production Gateway capabilities scope 与本 adapter 不一致");
    }
    const parsed = parseBackendCapabilities(value.capabilities, "ProductionGatewayAdapter.capabilities");
    if (parsed.backendInstanceId !== this.#backendInstanceId) {
      throw adapterFailure("invalid-response", "Production Gateway capabilities backendInstanceId 不一致");
    }
    return parsed;
  }

  #putBody(requestValue: SubmitRequest): { request: SubmitRequest; body: ProductionJobPutRequest; digest: string } {
    const request = parseClientSubmitRequest(requestValue, this.#maxWorkflowBytes);
    const body: ProductionJobPutRequest = {
      version: 1,
      scope: this.#scope,
      backendInstanceId: this.#backendInstanceId,
      remoteJobId: request.remoteJobId,
      idempotencyKey: request.idempotencyKey,
      profile: {
        version: 1,
        profileId: this.#profileId,
        workflowDigest: productionJobWorkflowDigest(request.workflow),
      },
      inputBinding: request.inputBinding,
    };
    return { request, body, digest: productionJobPutRequestDigest(body) };
  }

  prepareSubmission(requestValue: SubmitRequest): PreparedSubmission {
    const prepared = this.#putBody(requestValue);
    return {
      version: 1,
      backendInstanceId: this.#backendInstanceId,
      remoteJobId: prepared.request.remoteJobId,
      idempotencyKey: prepared.request.idempotencyKey,
      requestDigest: prepared.digest,
      request: prepared.request,
    };
  }

  #validatePrepared(value: PreparedSubmission): { prepared: PreparedSubmission; body: ProductionJobPutRequest } {
    if (!isRecord(value) || !exactKeys(value, [
      "version", "backendInstanceId", "remoteJobId", "idempotencyKey", "requestDigest", "request",
    ]) || value.version !== 1 || value.backendInstanceId !== this.#backendInstanceId
      || typeof value.requestDigest !== "string" || !SHA256.test(value.requestDigest)) {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter PreparedSubmission 无效");
    }
    const rebuilt = this.#putBody(value.request);
    if (value.remoteJobId !== rebuilt.request.remoteJobId || value.idempotencyKey !== rebuilt.request.idempotencyKey
      || value.requestDigest !== rebuilt.digest) {
      throw adapterFailure("remote-rejected", "ProductionGatewayAdapter PreparedSubmission 已漂移");
    }
    return {
      prepared: {
        version: 1,
        backendInstanceId: this.#backendInstanceId,
        remoteJobId: rebuilt.request.remoteJobId,
        idempotencyKey: rebuilt.request.idempotencyKey,
        requestDigest: rebuilt.digest,
        request: rebuilt.request,
      },
      body: rebuilt.body,
    };
  }

  async #exchange(
    url: URL,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<{ status: number; value: unknown }> {
    const controller = new AbortController();
    let timedOut = false;
    const callerAbort = (): void => controller.abort(callerSignal?.reason ?? new Error("aborted"));
    if (callerSignal?.aborted) callerAbort();
    else callerSignal?.addEventListener("abort", callerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("deadline"));
    }, this.#timeoutMs);
    try {
      if (controller.signal.aborted) throw adapterFailure("aborted", "Production Gateway 请求已取消");
      let credential: string;
      try {
        credential = validateToken(await raceAbort(
          Promise.resolve(this.#credentialResolver(controller.signal)), controller.signal,
        ));
      } catch (error) {
        if (error instanceof ProductionAdapterError) throw error;
        if (callerSignal?.aborted) throw adapterFailure("aborted", "Production Gateway credential 请求已取消");
        throw adapterFailure("remote-unavailable", "Production Gateway credential 不可用");
      }
      let response: Response;
      try {
        response = await raceAbort(Promise.resolve(this.#fetch(url, {
          ...init,
          redirect: "error",
          headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${credential}` },
          signal: controller.signal,
        })), controller.signal);
      } catch (error) {
        if (callerSignal?.aborted) throw adapterFailure("aborted", "Production Gateway 请求已取消");
        throw adapterFailure("remote-unavailable", timedOut
          ? "Production Gateway 请求超时" : "Production Gateway 不可用");
      }
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => undefined);
        return { status: response.status, value: null };
      }
      return {
        status: response.status,
        value: await readClientJson(response, this.#maxResponseBytes, controller.signal),
      };
    } catch (error) {
      if (error instanceof ProductionAdapterError) throw error;
      if (callerSignal?.aborted) throw adapterFailure("aborted", "Production Gateway 请求已取消");
      if (timedOut) throw adapterFailure("remote-unavailable", "Production Gateway 请求超时");
      throw adapterFailure("invalid-response", "Production Gateway 响应无效");
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", callerAbort);
    }
  }

  async submit(request: SubmitRequest, signal?: AbortSignal): Promise<SubmitResult> {
    return await this.submitPrepared(this.prepareSubmission(request), signal);
  }

  async submitPrepared(value: PreparedSubmission, signal?: AbortSignal): Promise<SubmitResult> {
    const { prepared, body } = this.#validatePrepared(value);
    if (signal?.aborted) throw adapterFailure("aborted", "Production Gateway submit 在网络前已取消");
    let exchanged: { status: number; value: unknown };
    try {
      exchanged = await this.#exchange(
        endpoint(this.#baseUrl, this.#scope, `jobs/${encodeURIComponent(prepared.remoteJobId)}`),
        {
          method: "PUT",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-writing-loop-idempotency-key": prepared.idempotencyKey,
            "x-writing-loop-request-digest": prepared.requestDigest,
          },
          body: JSON.stringify(body),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ProductionAdapterError && error.code === "remote-rejected") throw error;
      const causeCode = error instanceof ProductionAdapterError && error.code !== "submission-unknown"
        ? error.code : "invalid-response";
      throw new ProductionAdapterError("submission-unknown", "Production Gateway submit 结果未知", {
        cause: error,
        causeCode,
      });
    }
    if (exchanged.status === 409 || exchanged.status === 400 || exchanged.status === 403
      || exchanged.status === 429
      || exchanged.status === 401 || exchanged.status === 422) {
      throw adapterFailure("remote-rejected", "Production Gateway 拒绝 submit", exchanged.status);
    }
    if (exchanged.status !== 200 && exchanged.status !== 202) {
      throw new ProductionAdapterError("submission-unknown", "Production Gateway submit HTTP 结果未知", {
        status: exchanged.status,
      });
    }
    const parsed = parsePutResponse(
      exchanged.value,
      this.#scope,
      this.#backendInstanceId,
      prepared.remoteJobId,
      prepared.requestDigest,
    );
    if (parsed.submissionState === "accepted" && parsed.submitResult) return parsed.submitResult;
    if (parsed.submissionState === "rejected") {
      throw adapterFailure("remote-rejected", "Production Gateway raw submit 被拒绝", exchanged.status);
    }
    throw new ProductionAdapterError("submission-unknown", "Production Gateway 已持久化 job，但提交仍需 inspect", {
      status: exchanged.status,
    });
  }

  async inspect(remoteJobIdValue: string, signal?: AbortSignal): Promise<RemoteObservation> {
    let remoteJobId: string;
    try { remoteJobId = safeId(remoteJobIdValue); }
    catch { throw adapterFailure("remote-rejected", "Production Gateway remoteJobId 无效"); }
    const exchanged = await this.#exchange(
      endpoint(this.#baseUrl, this.#scope, `jobs/${encodeURIComponent(remoteJobId)}`),
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    if (exchanged.status !== 200) {
      throw adapterFailure(
        exchanged.status >= 400 && exchanged.status < 500 ? "remote-rejected" : "remote-unavailable",
        "Production Gateway inspect 失败",
        exchanged.status,
      );
    }
    return parseGetResponse(
      exchanged.value, this.#scope, this.#backendInstanceId, remoteJobId,
    ).observation;
  }

  async cancel(remoteJobIdValue: string, signal?: AbortSignal): Promise<CancelResult> {
    let remoteJobId: string;
    try { remoteJobId = safeId(remoteJobIdValue); }
    catch { throw adapterFailure("remote-rejected", "Production Gateway remoteJobId 无效"); }
    const cancelKey = productionJobCancellationKey(this.#scope, remoteJobId);
    const body: ProductionJobCancellationRequest = {
      version: 1,
      scope: this.#scope,
      backendInstanceId: this.#backendInstanceId,
      remoteJobId,
      cancelKey,
    };
    const requestDigest = productionJobCancellationRequestDigest(body);
    const exchanged = await this.#exchange(
      endpoint(
        this.#baseUrl,
        this.#scope,
        `jobs/${encodeURIComponent(remoteJobId)}/cancellations/${cancelKey}`,
      ),
      {
        method: "PUT",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-writing-loop-idempotency-key": cancelKey,
          "x-writing-loop-request-digest": requestDigest,
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (exchanged.status !== 200) {
      throw adapterFailure(
        exchanged.status >= 400 && exchanged.status < 500 ? "remote-rejected" : "remote-unavailable",
        "Production Gateway cancel 失败",
        exchanged.status,
      );
    }
    const parsed = parseCancellationResponse(
      exchanged.value,
      this.#scope,
      this.#backendInstanceId,
      remoteJobId,
      cancelKey,
      requestDigest,
    );
    if (parsed.cancelResult) return parsed.cancelResult;
    return {
      remoteJobId,
      accepted: false,
      confirmed: false,
      runningInterruptRequested: false,
      observedAt: parsed.observation?.observedAt ?? new Date().toISOString(),
    };
  }
}
