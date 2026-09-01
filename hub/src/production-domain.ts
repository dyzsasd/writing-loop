// Authoritative production-domain DTOs and the pure task state machine.
//
// These values cross a trust boundary: backend adapters, Studio and the durable store all exchange
// plain JSON.  Every v1 parser therefore rejects unknown fields, unbounded collections and
// machine-local/expiring asset references instead of silently normalising them.
import { createHash } from "node:crypto";
import { WsError } from "./workspace.ts";

export const PRODUCTION_SCHEMA_VERSION = 1 as const;
export const MAX_PRODUCTION_TASKS = 2_048;
export const MAX_PRODUCTION_ASSETS_PER_TASK = 64;
export const MAX_PRODUCTION_EVENT_IDS_PER_TASK = 32;
export const MAX_PRODUCTION_TEXT_LENGTH = 4_096;
export const MAX_PRODUCTION_COST_MICROS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PRODUCTION_TASKS);

export const PRODUCTION_STATUSES = [
  "planned",
  "dispatch-pending",
  "submitting",
  "submitted",
  "running",
  "ingesting",
  "qc-pending",
  "approved",
  "rejected",
  "submission-unknown",
  "failed",
  "cancel-requested",
  "cancelled",
  "orphaned",
] as const;

export type ProductionStatus = typeof PRODUCTION_STATUSES[number];

export const PRODUCTION_TERMINAL_STATUSES = [
  "approved", "rejected", "failed", "cancelled", "orphaned",
] as const satisfies readonly ProductionStatus[];

export const PRODUCTION_TRANSITIONS = {
  planned: ["dispatch-pending", "cancel-requested", "failed"],
  "dispatch-pending": ["submitting", "cancel-requested", "failed"],
  submitting: ["submitted", "submission-unknown", "cancel-requested", "failed"],
  // `cancelled` remains guarded by the reducer's durable cancellationRequest + strong matching
  // observation checks. These edges are needed when a cancellation race first resumes production
  // and the provider only reports the terminal cancelled fact on a later reconciliation pass.
  submitted: ["running", "ingesting", "cancel-requested", "cancelled", "failed", "orphaned"],
  running: ["ingesting", "cancel-requested", "cancelled", "failed", "orphaned"],
  ingesting: ["qc-pending", "cancel-requested", "cancelled", "failed", "orphaned"],
  "qc-pending": ["approved", "rejected", "cancel-requested", "cancelled", "failed", "orphaned"],
  "submission-unknown": ["submitted", "running", "cancel-requested", "cancelled", "failed", "orphaned"],
  // This row is the union of possible cancellation-race recovery targets. The reducer additionally
  // constrains each recovery by the durable source phase stored on the task.
  "cancel-requested": [
    "submission-unknown", "submitted", "running", "ingesting", "qc-pending",
    "approved", "rejected", "cancelled", "failed", "orphaned",
  ],
  approved: [],
  rejected: [],
  failed: [],
  cancelled: [],
  orphaned: [],
} as const satisfies Readonly<Record<ProductionStatus, readonly ProductionStatus[]>>;

export const CANCELLATION_SOURCE_STATUSES = [
  "planned", "dispatch-pending", "submitting", "submission-unknown", "submitted", "running",
  "ingesting", "qc-pending",
] as const satisfies readonly ProductionStatus[];

export type CancellationSourceStatus = typeof CANCELLATION_SOURCE_STATUSES[number];

export type AssetRef = {
  version: 1;
  uri: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
};

export type EpisodeRevisionRef = {
  version: 1;
  episodeId: string;
  revision: number;
  source: AssetRef;
};

export type ShotRevisionRef = {
  version: 1;
  episode: EpisodeRevisionRef;
  shotId: string;
  revision: number;
  source: AssetRef;
};

export type ProductionSubjectRef =
  | { version: 1; kind: "episode"; episode: EpisodeRevisionRef }
  | { version: 1; kind: "shot"; shot: ShotRevisionRef };

/**
 * How a known amount was determined.  `reported`/`billed` come from the provider, `tariff` is the
 * configured profile price applied to a measured duration, `reported-converted` is a provider
 * amount billed in a native currency, and `estimated` remains a planning-only figure.
 */
export const PRODUCTION_COST_BASES = [
  "reported", "billed", "estimated", "tariff", "reported-converted",
] as const;

export type ProductionCostBasis = typeof PRODUCTION_COST_BASES[number];

/**
 * Native-currency evidence behind a converted USD amount.  The rate is an operator-declared
 * registry fact carrying its own date and source, so no offline exchange-rate guess is ever needed.
 *
 * `rateMicrosPerUnit` is USD micros per one unit of `nativeCurrency` (0.138 USD/CNY is 138_000), so
 * the direction is native -> USD and the identity the parser enforces is
 * `amountMicros === round_half_up(nativeAmountMicros * rateMicrosPerUnit / 1_000_000)`, evaluated in
 * BigInt so neither factor's upper bound can overflow the product.
 */
export type ProductionCostSettlement = {
  nativeCurrency: "CNY";
  nativeAmountMicros: number;
  rateMicrosPerUnit: number;
  rateAsOf: string;
  rateSource: "gateway-registry";
};

export type ProductionCost =
  | {
      version: 1;
      state: "known";
      currency: "USD";
      amountMicros: number;
      basis: ProductionCostBasis;
      /** Non-null exactly when basis is reported-converted; legacy records read as null. */
      settlement: ProductionCostSettlement | null;
    }
  | {
      version: 1;
      state: "unknown";
      reason: "not-recorded" | "provider-not-reported" | "in-flight" | "unavailable" | "legacy-record";
    };

export type ProductionApproval = {
  version: 1;
  decision: "approved" | "rejected";
  /** The qc-pending task revision that was actually reviewed. */
  taskRevision: number;
  /** The immutable episode/shot source revision shown to the reviewer. */
  subjectRevision: number;
  decidedAt: string;
  decidedBy: string;
  note: string | null;
};

export type ProductionSubmissionOutbox = {
  version: 1;
  /** Digest of the exact canonical provider request body prepared before any network call. */
  requestDigest: string;
  preparedAt: string;
  /** pending is durable before POST; unknown is reconciled by remoteJobId and is never re-POSTed. */
  state: "pending" | "acknowledged" | "unknown";
};

export type ProductionCancellationRequest = {
  version: 1;
  requestedFrom: CancellationSourceStatus;
  requestedAt: string;
  reason: string;
};

/** Durable evidence that a cancellation request actually reached a terminal cancelled fact. */
export type ProductionCancellationConfirmation =
  | {
      version: 1;
      kind: "local-no-submission";
    }
  | {
      version: 1;
      kind: "remote-terminal-observation";
      backendInstanceId: string;
      remoteJobId: string;
      state: "cancelled";
      observedAt: string;
      responseDigest: string;
    };

export type ProductionEventReceipt = {
  version: 1;
  eventId: string;
  /** SHA-256 of parseProductionTaskEvent(event) serialized in canonical parser key order. */
  payloadDigest: string;
};

export type ProductionTask = {
  version: 1;
  id: string;
  idempotencyKey: string;
  subject: ProductionSubjectRef;
  status: ProductionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  backendInstanceId: string | null;
  remoteJobId: string | null;
  submissionOutbox: ProductionSubmissionOutbox | null;
  /** Durable audit fact; remains after a cancellation loses its race and production continues. */
  cancellationRequest: ProductionCancellationRequest | null;
  /** Required only for terminal cancelled; an accepted cancel request is never confirmation. */
  cancellationConfirmation: ProductionCancellationConfirmation | null;
  assets: AssetRef[];
  cost: ProductionCost;
  approval: ProductionApproval | null;
  statusMessage: string | null;
  /** Bounded exact-replay receipts; eventId reuse with another canonical payload is a hard error. */
  eventReceipts: ProductionEventReceipt[];
};

export type ProductionState = {
  version: 1;
  workspaceId: string;
  project: string;
  /** Authoritative document revision; every successful durable mutation increments exactly once. */
  revision: number;
  updatedAt: string | null;
  tasks: ProductionTask[];
};

export type ProductionTaskCreate = {
  version: 1;
  id: string;
  idempotencyKey: string;
  subject: ProductionSubjectRef;
  createdAt: string;
};

type ProductionEventBase = {
  version: 1;
  eventId: string;
  taskId: string;
  expectedRevision: number;
  occurredAt: string;
};

export type ProductionTaskEvent =
  | ProductionEventBase & { type: "dispatch-requested" }
  | ProductionEventBase & {
      type: "submission-started";
      backendInstanceId: string;
      remoteJobId: string;
      requestDigest: string;
    }
  | ProductionEventBase & {
      type: "submission-confirmed";
      backendInstanceId: string;
      remoteJobId: string;
    }
  | ProductionEventBase & {
      type: "submission-uncertain";
      backendInstanceId: string;
      remoteJobId: string;
      reason: string;
    }
  | ProductionEventBase & { type: "remote-started"; backendInstanceId: string; remoteJobId: string }
  | ProductionEventBase & { type: "ingestion-started" }
  | ProductionEventBase & { type: "qc-requested"; assets: AssetRef[]; cost: ProductionCost }
  | ProductionEventBase & { type: "approved"; decidedBy: string; note: string | null }
  | ProductionEventBase & { type: "rejected"; decidedBy: string; note: string }
  | ProductionEventBase & { type: "cancellation-requested"; reason: string }
  | ProductionEventBase & {
      type: "cancelled";
      reason: string;
      confirmation: ProductionCancellationConfirmation;
    }
  | ProductionEventBase & { type: "failed"; reason: string }
  | ProductionEventBase & { type: "orphaned"; reason: string };

export class ProductionError extends WsError {
  constructor(message: string) {
    super(message);
    this.name = "ProductionError";
  }
}

/** Locale-independent ordering for protocol identifiers and canonical ISO timestamps (ASCII). */
export function compareProductionAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const STATUS_SET = new Set<string>(PRODUCTION_STATUSES);
const TERMINAL_SET = new Set<string>(PRODUCTION_TERMINAL_STATUSES);
const CANCELLATION_SOURCE_SET = new Set<string>(CANCELLATION_SOURCE_STATUSES);
const CANCELLATION_RECOVERY_TARGETS = {
  planned: [],
  "dispatch-pending": [],
  submitting: ["submission-unknown", "submitted", "running"],
  "submission-unknown": ["submission-unknown", "submitted", "running"],
  submitted: ["submitted", "running", "ingesting"],
  running: ["running", "ingesting"],
  ingesting: ["ingesting", "qc-pending"],
  "qc-pending": ["qc-pending", "approved", "rejected"],
} as const satisfies Readonly<Record<CancellationSourceStatus, readonly ProductionStatus[]>>;
const CANCELLATION_EVENTUAL_STATUSES = {
  planned: [],
  "dispatch-pending": [],
  submitting: ["submission-unknown", "submitted", "running", "ingesting", "qc-pending", "approved", "rejected"],
  "submission-unknown": ["submission-unknown", "submitted", "running", "ingesting", "qc-pending", "approved", "rejected"],
  submitted: ["submitted", "running", "ingesting", "qc-pending", "approved", "rejected"],
  running: ["running", "ingesting", "qc-pending", "approved", "rejected"],
  ingesting: ["ingesting", "qc-pending", "approved", "rejected"],
  "qc-pending": ["qc-pending", "approved", "rejected"],
} as const satisfies Readonly<Record<CancellationSourceStatus, readonly ProductionStatus[]>>;
const COST_UNKNOWN_REASONS = new Set([
  "not-recorded", "provider-not-reported", "in-flight", "unavailable", "legacy-record",
]);
const COST_BASES = new Set<string>(PRODUCTION_COST_BASES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROJECT_KEY = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;
const STABLE_URI_SCHEMES = new Set(["asset:", "az:", "azure:", "cas:", "gs:", "https:", "ipfs:", "r2:", "s3:", "urn:"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new ProductionError(`${subject} ${detail}`);
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
  /** Keys a v1 record may omit; only used where an older durable record predates the field. */
  optional: readonly string[] = [],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key) && !optional.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function requireVersion(value: unknown, subject: string): void {
  if (value !== PRODUCTION_SCHEMA_VERSION) fail(subject, "version 必须是 1");
}

function requireSafeInteger(value: unknown, subject: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function requireId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail(subject, "必须是 1–128 位安全标识符（字母/数字开头，仅含字母、数字、点、下划线、冒号或连字符）");
  }
  return value;
}

function requireOpaque(value: unknown, subject: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(subject, `必须是 1–${maximum} 位且不含控制字符的字符串`);
  }
  return value;
}

function requireText(value: unknown, subject: string, allowNull = false): string | null {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PRODUCTION_TEXT_LENGTH || value.includes("\0")) {
    fail(subject, `必须是 1–${MAX_PRODUCTION_TEXT_LENGTH} 位且不含 NUL 的字符串${allowNull ? "或 null" : ""}`);
  }
  return value;
}

function requireIso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "必须是规范 UTC ISO-8601 时间");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) fail(subject, "必须是规范 UTC ISO-8601 时间");
  return value;
}

function requireSha256(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(subject, "必须是 64 位小写十六进制 sha256");
  return value;
}

export function parseProductionCancellationConfirmation(
  value: unknown,
  subject = "ProductionCancellationConfirmation",
): ProductionCancellationConfirmation {
  const row = requireRecord(value, subject);
  if (row.kind === "local-no-submission") {
    exactKeys(row, ["version", "kind"], subject);
    requireVersion(row.version, subject);
    return { version: 1, kind: "local-no-submission" };
  }
  if (row.kind === "remote-terminal-observation") {
    exactKeys(row, [
      "version", "kind", "backendInstanceId", "remoteJobId", "state", "observedAt", "responseDigest",
    ], subject);
    requireVersion(row.version, subject);
    if (row.state !== "cancelled") fail(`${subject}.state`, "远端取消确认必须是 cancelled 终态观察");
    return {
      version: 1,
      kind: "remote-terminal-observation",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      remoteJobId: requireOpaque(row.remoteJobId, `${subject}.remoteJobId`),
      state: "cancelled",
      observedAt: requireIso(row.observedAt, `${subject}.observedAt`),
      responseDigest: requireSha256(row.responseDigest, `${subject}.responseDigest`),
    };
  }
  fail(`${subject}.kind`, "必须是 local-no-submission 或 remote-terminal-observation");
}

function requireStableStorageUri(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048
    || /[\u0000-\u0020\u007f\\]/.test(value)) {
    fail(subject, "必须是长度 <= 2048 且不含空白、控制字符或反斜杠的 stable storage URI");
  }
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:\//.test(value) || value.startsWith("//")) {
    fail(subject, "不得是本机绝对路径");
  }
  if (value.includes("?") || value.includes("#")) {
    fail(subject, "不得包含 query/fragment（拒绝签名 URL、临时 token 与不稳定定位）");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { fail(subject, "必须是绝对 stable storage URI"); }
  if (!STABLE_URI_SCHEMES.has(parsed.protocol)) {
    fail(subject, `scheme ${JSON.stringify(parsed.protocol)} 不属于稳定存储白名单`);
  }
  if (parsed.username || parsed.password) fail(subject, "不得内嵌用户名、密码或密钥");
  if (parsed.search || parsed.hash) fail(subject, "不得包含签名 query 或 fragment");
  if (parsed.protocol === "https:" && (!parsed.hostname || ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    fail(subject, "https storage URI 必须指向非本机稳定主机");
  }
  if (!["urn:"].includes(parsed.protocol) && !parsed.hostname) fail(subject, "层级 storage URI 必须包含存储 authority");
  return value;
}

export function parseAssetRef(value: unknown, subject = "AssetRef"): AssetRef {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "uri", "sha256", "byteLength", "mediaType"], subject);
  requireVersion(row.version, subject);
  const uri = requireStableStorageUri(row.uri, `${subject}.uri`);
  const sha256 = requireSha256(row.sha256, `${subject}.sha256`);
  const byteLength = requireSafeInteger(row.byteLength, `${subject}.byteLength`);
  if (typeof row.mediaType !== "string" || row.mediaType.length > 129 || !MEDIA_TYPE.test(row.mediaType)) {
    fail(`${subject}.mediaType`, "必须是无参数的规范 media type");
  }
  return { version: 1, uri, sha256, byteLength, mediaType: row.mediaType.toLowerCase() };
}

export function parseEpisodeRevisionRef(value: unknown, subject = "EpisodeRevisionRef"): EpisodeRevisionRef {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "episodeId", "revision", "source"], subject);
  requireVersion(row.version, subject);
  return {
    version: 1,
    episodeId: requireId(row.episodeId, `${subject}.episodeId`),
    revision: requireSafeInteger(row.revision, `${subject}.revision`, 1),
    source: parseAssetRef(row.source, `${subject}.source`),
  };
}

export function parseShotRevisionRef(value: unknown, subject = "ShotRevisionRef"): ShotRevisionRef {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "episode", "shotId", "revision", "source"], subject);
  requireVersion(row.version, subject);
  return {
    version: 1,
    episode: parseEpisodeRevisionRef(row.episode, `${subject}.episode`),
    shotId: requireId(row.shotId, `${subject}.shotId`),
    revision: requireSafeInteger(row.revision, `${subject}.revision`, 1),
    source: parseAssetRef(row.source, `${subject}.source`),
  };
}

export function parseProductionSubjectRef(value: unknown, subject = "ProductionSubjectRef"): ProductionSubjectRef {
  const row = requireRecord(value, subject);
  if (row.kind === "episode") {
    exactKeys(row, ["version", "kind", "episode"], subject);
    requireVersion(row.version, subject);
    return { version: 1, kind: "episode", episode: parseEpisodeRevisionRef(row.episode, `${subject}.episode`) };
  }
  if (row.kind === "shot") {
    exactKeys(row, ["version", "kind", "shot"], subject);
    requireVersion(row.version, subject);
    return { version: 1, kind: "shot", shot: parseShotRevisionRef(row.shot, `${subject}.shot`) };
  }
  fail(`${subject}.kind`, "必须是 episode 或 shot");
}

export function subjectRevision(subject: ProductionSubjectRef): number {
  return subject.kind === "episode" ? subject.episode.revision : subject.shot.revision;
}

function parseCostSettlement(value: unknown, subject: string): ProductionCostSettlement {
  const row = requireRecord(value, subject);
  exactKeys(row, ["nativeCurrency", "nativeAmountMicros", "rateMicrosPerUnit", "rateAsOf", "rateSource"], subject);
  if (row.nativeCurrency !== "CNY") fail(`${subject}.nativeCurrency`, "v1 仅支持 CNY 原币结算");
  if (row.rateSource !== "gateway-registry") fail(`${subject}.rateSource`, "汇率只能来自 gateway registry 的声明");
  return {
    nativeCurrency: "CNY",
    nativeAmountMicros: requireSafeInteger(
      row.nativeAmountMicros, `${subject}.nativeAmountMicros`, 0, MAX_PRODUCTION_COST_MICROS,
    ),
    rateMicrosPerUnit: requireSafeInteger(
      row.rateMicrosPerUnit, `${subject}.rateMicrosPerUnit`, 1, MAX_PRODUCTION_COST_MICROS,
    ),
    rateAsOf: requireIso(row.rateAsOf, `${subject}.rateAsOf`),
    rateSource: "gateway-registry",
  };
}

export function parseProductionCost(value: unknown, subject = "ProductionCost"): ProductionCost {
  const row = requireRecord(value, subject);
  if (row.state === "known") {
    exactKeys(row, ["version", "state", "currency", "amountMicros", "basis"], subject, ["settlement"]);
    requireVersion(row.version, subject);
    if (row.currency !== "USD") fail(`${subject}.currency`, "v1 仅支持 USD，禁止离线猜测汇率");
    if (!COST_BASES.has(String(row.basis))) {
      fail(`${subject}.basis`, `必须是 ${PRODUCTION_COST_BASES.join("、")} 之一`);
    }
    const basis = row.basis as ProductionCostBasis;
    const amountMicros = requireSafeInteger(
      row.amountMicros, `${subject}.amountMicros`, 0, MAX_PRODUCTION_COST_MICROS,
    );
    // Records written before the converted basis carry no settlement; absent reads as null.
    const settlement = row.settlement === undefined || row.settlement === null
      ? null
      : parseCostSettlement(row.settlement, `${subject}.settlement`);
    if ((basis === "reported-converted") !== (settlement !== null)) {
      fail(`${subject}.settlement`, "reported-converted 必须记录原币结算，其余 basis 必须是 null");
    }
    if (settlement !== null) {
      // The USD amount must be exactly the declared conversion of the native amount, so a drifting
      // rate or a hand-edited total cannot pass as settled evidence.  BigInt keeps the product exact.
      const expected = (BigInt(settlement.nativeAmountMicros) * BigInt(settlement.rateMicrosPerUnit)
        + 500_000n) / 1_000_000n;
      if (BigInt(amountMicros) !== expected) {
        fail(
          `${subject}.amountMicros`,
          `必须等于原币金额按声明汇率 half-up 折算的 ${expected} micros`
            + `（${settlement.nativeAmountMicros} × ${settlement.rateMicrosPerUnit} / 1000000），实际是 ${amountMicros}`,
        );
      }
    }
    return {
      version: 1,
      state: "known",
      currency: "USD",
      amountMicros,
      basis,
      settlement,
    };
  }
  if (row.state === "unknown") {
    exactKeys(row, ["version", "state", "reason"], subject);
    requireVersion(row.version, subject);
    if (!COST_UNKNOWN_REASONS.has(String(row.reason))) {
      fail(`${subject}.reason`, "不是受支持的 unknown 原因");
    }
    return {
      version: 1,
      state: "unknown",
      reason: row.reason as "not-recorded" | "provider-not-reported" | "in-flight" | "unavailable" | "legacy-record",
    };
  }
  fail(`${subject}.state`, "必须是 known 或 unknown");
}

function parseApproval(value: unknown, subject: string): ProductionApproval {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "decision", "taskRevision", "subjectRevision", "decidedAt", "decidedBy", "note"], subject);
  requireVersion(row.version, subject);
  if (row.decision !== "approved" && row.decision !== "rejected") fail(`${subject}.decision`, "必须是 approved 或 rejected");
  const note = requireText(row.note, `${subject}.note`, true);
  if (row.decision === "rejected" && note === null) fail(`${subject}.note`, "rejected 必须给出原因");
  return {
    version: 1,
    decision: row.decision,
    taskRevision: requireSafeInteger(row.taskRevision, `${subject}.taskRevision`, 1),
    subjectRevision: requireSafeInteger(row.subjectRevision, `${subject}.subjectRevision`, 1),
    decidedAt: requireIso(row.decidedAt, `${subject}.decidedAt`),
    decidedBy: requireOpaque(row.decidedBy, `${subject}.decidedBy`),
    note,
  };
}

function parseAssets(value: unknown, subject: string): AssetRef[] {
  if (!Array.isArray(value)) fail(subject, "必须是数组");
  if (value.length > MAX_PRODUCTION_ASSETS_PER_TASK) {
    fail(subject, `超过 ${MAX_PRODUCTION_ASSETS_PER_TASK} 项上限`);
  }
  const assets = value.map((asset, index) => parseAssetRef(asset, `${subject}[${index}]`));
  const identities = new Set<string>();
  for (const asset of assets) {
    const identity = `${asset.uri}\0${asset.sha256}`;
    if (identities.has(identity)) fail(subject, `含重复 asset ${asset.uri}`);
    identities.add(identity);
  }
  return assets;
}

export function parseProductionTaskCreate(value: unknown, subject = "ProductionTaskCreate"): ProductionTaskCreate {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "id", "idempotencyKey", "subject", "createdAt"], subject);
  requireVersion(row.version, subject);
  return {
    version: 1,
    id: requireId(row.id, `${subject}.id`),
    idempotencyKey: requireOpaque(row.idempotencyKey, `${subject}.idempotencyKey`),
    subject: parseProductionSubjectRef(row.subject, `${subject}.subject`),
    createdAt: requireIso(row.createdAt, `${subject}.createdAt`),
  };
}

export function taskFromCreate(value: ProductionTaskCreate): ProductionTask {
  const create = parseProductionTaskCreate(value);
  return {
    version: 1,
    id: create.id,
    idempotencyKey: create.idempotencyKey,
    subject: create.subject,
    status: "planned",
    revision: 1,
    createdAt: create.createdAt,
    updatedAt: create.createdAt,
    backendInstanceId: null,
    remoteJobId: null,
    submissionOutbox: null,
    cancellationRequest: null,
    cancellationConfirmation: null,
    assets: [],
    cost: { version: 1, state: "unknown", reason: "not-recorded" },
    approval: null,
    statusMessage: null,
    eventReceipts: [],
  };
}

export function parseProductionTask(value: unknown, subject = "ProductionTask"): ProductionTask {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "version", "id", "idempotencyKey", "subject", "status", "revision", "createdAt", "updatedAt",
    "backendInstanceId", "remoteJobId", "submissionOutbox", "cancellationRequest", "cancellationConfirmation",
    "assets", "cost", "approval", "statusMessage", "eventReceipts",
  ], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !STATUS_SET.has(row.status)) fail(`${subject}.status`, "不是受支持的 production 状态");
  const status = row.status as ProductionStatus;
  const revision = requireSafeInteger(row.revision, `${subject}.revision`, 1);
  const createdAt = requireIso(row.createdAt, `${subject}.createdAt`);
  const updatedAt = requireIso(row.updatedAt, `${subject}.updatedAt`);
  if (updatedAt < createdAt) fail(`${subject}.updatedAt`, "不得早于 createdAt");
  const backendInstanceId = row.backendInstanceId === null
    ? null
    : requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`);
  const remoteJobId = row.remoteJobId === null
    ? null
    : requireOpaque(row.remoteJobId, `${subject}.remoteJobId`);
  if (remoteJobId !== null && backendInstanceId === null) fail(subject, "remoteJobId 存在时 backendInstanceId 不能为空");
  let submissionOutbox: ProductionSubmissionOutbox | null = null;
  if (row.submissionOutbox !== null) {
    const outbox = requireRecord(row.submissionOutbox, `${subject}.submissionOutbox`);
    exactKeys(outbox, ["version", "requestDigest", "preparedAt", "state"], `${subject}.submissionOutbox`);
    requireVersion(outbox.version, `${subject}.submissionOutbox`);
    if (outbox.state !== "pending" && outbox.state !== "acknowledged" && outbox.state !== "unknown") {
      fail(`${subject}.submissionOutbox.state`, "必须是 pending、acknowledged 或 unknown");
    }
    submissionOutbox = {
      version: 1,
      requestDigest: requireSha256(outbox.requestDigest, `${subject}.submissionOutbox.requestDigest`),
      preparedAt: requireIso(outbox.preparedAt, `${subject}.submissionOutbox.preparedAt`),
      state: outbox.state,
    };
  }
  if (submissionOutbox !== null && (backendInstanceId === null || remoteJobId === null)) {
    fail(subject, "submissionOutbox 必须与预分配 backendInstanceId + remoteJobId 一起持久化");
  }
  let cancellationRequest: ProductionCancellationRequest | null = null;
  if (row.cancellationRequest !== null) {
    const request = requireRecord(row.cancellationRequest, `${subject}.cancellationRequest`);
    exactKeys(request, ["version", "requestedFrom", "requestedAt", "reason"], `${subject}.cancellationRequest`);
    requireVersion(request.version, `${subject}.cancellationRequest`);
    if (typeof request.requestedFrom !== "string" || !CANCELLATION_SOURCE_SET.has(request.requestedFrom)) {
      fail(`${subject}.cancellationRequest.requestedFrom`, "不是可取消的 production 来源阶段");
    }
    cancellationRequest = {
      version: 1,
      requestedFrom: request.requestedFrom as CancellationSourceStatus,
      requestedAt: requireIso(request.requestedAt, `${subject}.cancellationRequest.requestedAt`),
      reason: requireText(request.reason, `${subject}.cancellationRequest.reason`)!,
    };
    if (cancellationRequest.requestedAt < createdAt || cancellationRequest.requestedAt > updatedAt) {
      fail(`${subject}.cancellationRequest.requestedAt`, "必须位于 task createdAt–updatedAt 范围内");
    }
  }
  const cancellationConfirmation = row.cancellationConfirmation === null
    ? null
    : parseProductionCancellationConfirmation(row.cancellationConfirmation, `${subject}.cancellationConfirmation`);
  const assets = parseAssets(row.assets, `${subject}.assets`);
  const cost = parseProductionCost(row.cost, `${subject}.cost`);
  const approval = row.approval === null ? null : parseApproval(row.approval, `${subject}.approval`);
  const statusMessage = requireText(row.statusMessage, `${subject}.statusMessage`, true);
  if (!Array.isArray(row.eventReceipts) || row.eventReceipts.length > MAX_PRODUCTION_EVENT_IDS_PER_TASK) {
    fail(`${subject}.eventReceipts`, `必须是最多 ${MAX_PRODUCTION_EVENT_IDS_PER_TASK} 项的数组`);
  }
  const eventReceipts = row.eventReceipts.map((value, index): ProductionEventReceipt => {
    const receiptSubject = `${subject}.eventReceipts[${index}]`;
    const receipt = requireRecord(value, receiptSubject);
    exactKeys(receipt, ["version", "eventId", "payloadDigest"], receiptSubject);
    requireVersion(receipt.version, receiptSubject);
    return {
      version: 1,
      eventId: requireId(receipt.eventId, `${receiptSubject}.eventId`),
      payloadDigest: requireSha256(receipt.payloadDigest, `${receiptSubject}.payloadDigest`),
    };
  });
  const eventIds = eventReceipts.map((receipt) => receipt.eventId);
  if (new Set(eventIds).size !== eventIds.length) fail(`${subject}.eventReceipts`, "eventId 不得重复");
  if (revision !== eventReceipts.length + 1) fail(`${subject}.revision`, "必须等于 eventReceipts.length + 1");

  const remoteRequired = new Set<ProductionStatus>([
    "submitting", "submission-unknown", "submitted", "running", "ingesting", "qc-pending", "approved", "rejected",
  ]);
  if (remoteRequired.has(status) && (!backendInstanceId || !remoteJobId)) {
    fail(subject, `${status} 必须绑定 backendInstanceId + remoteJobId`);
  }
  if ((status === "planned" || status === "dispatch-pending")
    && (backendInstanceId !== null || remoteJobId !== null || submissionOutbox !== null)) {
    fail(subject, `${status} 不得预先绑定 remote backend/job`);
  }
  if ((status === "cancel-requested" || status === "cancelled") && cancellationRequest === null) {
    fail(subject, `${status} 必须保留 cancellationRequest 与原始来源阶段`);
  }
  if (status === "cancelled" && cancellationConfirmation === null) {
    fail(subject, "cancelled 必须保留强类型 cancellationConfirmation，不能把取消请求已接受当作终态");
  }
  if (status !== "cancelled" && cancellationConfirmation !== null) {
    fail(subject, `${status} 不得持有 terminal cancellationConfirmation`);
  }
  if (status === "cancel-requested" && cancellationRequest?.requestedAt !== updatedAt) {
    fail(subject, "cancel-requested 的 updatedAt 必须等于 cancellationRequest.requestedAt");
  }
  if (cancellationRequest !== null) {
    const source = cancellationRequest.requestedFrom;
    if (source === "planned" || source === "dispatch-pending") {
      if (backendInstanceId !== null || remoteJobId !== null || submissionOutbox !== null) {
        fail(subject, `cancellationRequest.requestedFrom=${source} 不得伪造 remote submission`);
      }
    } else {
      if (backendInstanceId === null || remoteJobId === null || submissionOutbox === null) {
        fail(subject, `cancellationRequest.requestedFrom=${source} 必须保留当时的 remote tuple/outbox`);
      }
      if (["submitted", "running", "ingesting", "qc-pending"].includes(source)
        && submissionOutbox.state !== "acknowledged") {
        fail(subject, `cancellationRequest.requestedFrom=${source} 必须保留 acknowledged outbox`);
      }
      if (source === "submission-unknown" && submissionOutbox.state === "pending") {
        fail(subject, "submission-unknown 来源的取消请求不得回退为 pending outbox");
      }
      if (source === "qc-pending" && assets.length === 0) {
        fail(subject, "qc-pending 来源的取消请求必须保留已审阅 AssetRef");
      }
    }
  }
  if (cancellationConfirmation?.kind === "local-no-submission") {
    const source = cancellationRequest?.requestedFrom;
    if (source !== "planned" && source !== "dispatch-pending") {
      fail(subject, `local-no-submission 取消确认不能用于 requestedFrom=${source ?? "missing"}`);
    }
    if (backendInstanceId !== null || remoteJobId !== null || submissionOutbox !== null) {
      fail(subject, "local-no-submission 取消确认不得与 remote tuple/outbox 共存");
    }
  }
  if (cancellationConfirmation?.kind === "remote-terminal-observation") {
    if (backendInstanceId === null || remoteJobId === null || submissionOutbox === null || cancellationRequest === null) {
      fail(subject, "remote-terminal-observation 必须绑定既有 remote tuple/outbox 与 cancellationRequest");
    }
    if (cancellationConfirmation.backendInstanceId !== backendInstanceId) {
      fail(subject, "remote-terminal-observation.backendInstanceId 与 task backendInstanceId 不匹配");
    }
    if (cancellationConfirmation.remoteJobId !== remoteJobId) {
      fail(subject, "remote-terminal-observation.remoteJobId 与 task remoteJobId 不匹配");
    }
    if (cancellationConfirmation.observedAt < cancellationRequest.requestedAt
      || cancellationConfirmation.observedAt > updatedAt) {
      fail(subject, "remote-terminal-observation.observedAt 必须位于取消请求与 task updatedAt 之间");
    }
    if (submissionOutbox.state !== "acknowledged") {
      fail(subject, "remote-terminal-observation 已证明远端接收，submissionOutbox 必须是 acknowledged");
    }
  }
  if (cancellationRequest !== null
    && !["cancel-requested", "cancelled", "failed", "orphaned"].includes(status)
    && !(CANCELLATION_EVENTUAL_STATUSES[cancellationRequest.requestedFrom] as readonly ProductionStatus[]).includes(status)) {
    fail(subject, `${status} 不能由 cancellationRequest.requestedFrom=${cancellationRequest.requestedFrom} 安全恢复得到`);
  }
  if (status === "submitting" && submissionOutbox?.state !== "pending") {
    fail(subject, "submitting 必须持久化 pending submission outbox 后才能执行 POST");
  }
  if (status === "submission-unknown" && submissionOutbox?.state !== "unknown") {
    fail(subject, "submission-unknown 必须保留 remote tuple 与 unknown outbox，以 remoteJobId reconcile 且不得重 POST");
  }
  if (["submitted", "running", "ingesting", "qc-pending", "approved", "rejected"].includes(status)
    && submissionOutbox?.state !== "acknowledged") {
    fail(subject, `${status} 必须保留 acknowledged submission outbox`);
  }
  if (["qc-pending", "approved", "rejected"].includes(status) && assets.length === 0) {
    fail(subject, `${status} 必须至少持久化一个 AssetRef`);
  }
  if (approval !== null) {
    if (status !== approval.decision) fail(subject, "approval.decision 必须与终态一致");
    if (approval.taskRevision !== revision - 1) fail(subject, "approval.taskRevision 必须绑定审批前的 qc revision");
    if (approval.decidedAt !== updatedAt) {
      fail(`${subject}.approval.decidedAt`, "必须等于 terminal task.updatedAt（拒绝审批时间漂移）");
    }
  } else if (status === "approved" || status === "rejected") {
    fail(subject, `${status} 必须持久化 revision-bound approval`);
  }
  const parsedSubject = parseProductionSubjectRef(row.subject, `${subject}.subject`);
  if (approval !== null && approval.subjectRevision !== subjectRevision(parsedSubject)) {
    fail(subject, "approval.subjectRevision 与不可变 source revision 不匹配");
  }
  return {
    version: 1,
    id: requireId(row.id, `${subject}.id`),
    idempotencyKey: requireOpaque(row.idempotencyKey, `${subject}.idempotencyKey`),
    subject: parsedSubject,
    status,
    revision,
    createdAt,
    updatedAt,
    backendInstanceId,
    remoteJobId,
    submissionOutbox,
    cancellationRequest,
    cancellationConfirmation,
    assets,
    cost,
    approval,
    statusMessage,
    eventReceipts,
  };
}

export function parseProductionState(
  value: unknown,
  expected: { workspaceId?: string; project?: string } = {},
  subject = "ProductionState",
): ProductionState {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "workspaceId", "project", "revision", "updatedAt", "tasks"], subject);
  requireVersion(row.version, subject);
  if (typeof row.workspaceId !== "string" || !SAFE_WORKSPACE_ID.test(row.workspaceId)) {
    fail(`${subject}.workspaceId`, "必须是 1–128 位安全 workspace 标识符");
  }
  if (typeof row.project !== "string" || !SAFE_PROJECT_KEY.test(row.project)) {
    fail(`${subject}.project`, "必须是安全 project key");
  }
  if (expected.workspaceId !== undefined && row.workspaceId !== expected.workspaceId) {
    fail(subject, `绑定 workspaceId=${JSON.stringify(row.workspaceId)}，不能作为 ${JSON.stringify(expected.workspaceId)} 读取`);
  }
  if (expected.project !== undefined && row.project !== expected.project) {
    fail(subject, `绑定 project=${JSON.stringify(row.project)}，不能作为 ${JSON.stringify(expected.project)} 读取`);
  }
  const revision = requireSafeInteger(row.revision, `${subject}.revision`);
  const updatedAt = row.updatedAt === null ? null : requireIso(row.updatedAt, `${subject}.updatedAt`);
  if (!Array.isArray(row.tasks) || row.tasks.length > MAX_PRODUCTION_TASKS) {
    fail(`${subject}.tasks`, `必须是最多 ${MAX_PRODUCTION_TASKS} 项的数组`);
  }
  const tasks = row.tasks.map((task, index) => parseProductionTask(task, `${subject}.tasks[${index}]`));
  if (revision === 0 && (updatedAt !== null || tasks.length !== 0)) fail(subject, "revision=0 只允许 missing=>empty 状态");
  if (revision > 0 && updatedAt === null) fail(subject, "已持久化 revision 必须有 updatedAt");
  if (updatedAt !== null && tasks.some((task) => task.updatedAt > updatedAt)) {
    fail(`${subject}.updatedAt`, "不得早于任何 task.updatedAt（拒绝 document 时间回拨）");
  }
  const expectedRevision = tasks.reduce((sum, task) => sum + 1 + task.eventReceipts.length, 0);
  if (revision !== expectedRevision) {
    fail(`${subject}.revision`, `必须精确等于 task 创建数 + event receipt 数（期望 ${expectedRevision}）`);
  }

  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const eventIds = new Set<string>();
  const remoteJobs = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) fail(subject, `含重复 task id ${task.id}`);
    if (idempotencyKeys.has(task.idempotencyKey)) fail(subject, `含重复 idempotencyKey ${task.idempotencyKey}`);
    ids.add(task.id);
    idempotencyKeys.add(task.idempotencyKey);
    for (const receipt of task.eventReceipts) {
      if (eventIds.has(receipt.eventId)) fail(subject, `含跨 task 重复 eventId ${receipt.eventId}`);
      eventIds.add(receipt.eventId);
    }
    if (task.remoteJobId !== null) {
      const identity = `${task.backendInstanceId}\0${task.remoteJobId}`;
      if (remoteJobs.has(identity)) {
        fail(subject, `含重复 remote job (${task.backendInstanceId}, ${task.remoteJobId})`);
      }
      remoteJobs.add(identity);
    }
  }
  return { version: 1, workspaceId: row.workspaceId, project: row.project, revision, updatedAt, tasks };
}

const BASE_EVENT_KEYS = ["version", "type", "eventId", "taskId", "expectedRevision", "occurredAt"] as const;

export function parseProductionTaskEvent(value: unknown, subject = "ProductionTaskEvent"): ProductionTaskEvent {
  const row = requireRecord(value, subject);
  requireVersion(row.version, subject);
  const base = {
    version: 1 as const,
    eventId: requireId(row.eventId, `${subject}.eventId`),
    taskId: requireId(row.taskId, `${subject}.taskId`),
    expectedRevision: requireSafeInteger(row.expectedRevision, `${subject}.expectedRevision`, 1),
    occurredAt: requireIso(row.occurredAt, `${subject}.occurredAt`),
  };
  switch (row.type) {
    case "dispatch-requested":
    case "ingestion-started":
      exactKeys(row, BASE_EVENT_KEYS, subject);
      return { ...base, type: row.type };
    case "submission-started":
      exactKeys(row, [...BASE_EVENT_KEYS, "backendInstanceId", "remoteJobId", "requestDigest"], subject);
      return {
        ...base,
        type: row.type,
        backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
        remoteJobId: requireOpaque(row.remoteJobId, `${subject}.remoteJobId`),
        requestDigest: requireSha256(row.requestDigest, `${subject}.requestDigest`),
      };
    case "submission-confirmed":
    case "remote-started":
      exactKeys(row, [...BASE_EVENT_KEYS, "backendInstanceId", "remoteJobId"], subject);
      return {
        ...base,
        type: row.type,
        backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
        remoteJobId: requireOpaque(row.remoteJobId, `${subject}.remoteJobId`),
      };
    case "submission-uncertain":
      exactKeys(row, [...BASE_EVENT_KEYS, "backendInstanceId", "remoteJobId", "reason"], subject);
      return {
        ...base,
        type: row.type,
        backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
        remoteJobId: requireOpaque(row.remoteJobId, `${subject}.remoteJobId`),
        reason: requireText(row.reason, `${subject}.reason`)!,
      };
    case "qc-requested":
      exactKeys(row, [...BASE_EVENT_KEYS, "assets", "cost"], subject);
      return { ...base, type: row.type, assets: parseAssets(row.assets, `${subject}.assets`), cost: parseProductionCost(row.cost, `${subject}.cost`) };
    case "approved":
      exactKeys(row, [...BASE_EVENT_KEYS, "decidedBy", "note"], subject);
      return {
        ...base,
        type: row.type,
        decidedBy: requireOpaque(row.decidedBy, `${subject}.decidedBy`),
        note: requireText(row.note, `${subject}.note`, true),
      };
    case "rejected":
      exactKeys(row, [...BASE_EVENT_KEYS, "decidedBy", "note"], subject);
      return {
        ...base,
        type: row.type,
        decidedBy: requireOpaque(row.decidedBy, `${subject}.decidedBy`),
        note: requireText(row.note, `${subject}.note`)!,
      };
    case "cancelled":
      exactKeys(row, [...BASE_EVENT_KEYS, "reason", "confirmation"], subject);
      return {
        ...base,
        type: row.type,
        reason: requireText(row.reason, `${subject}.reason`)!,
        confirmation: parseProductionCancellationConfirmation(row.confirmation, `${subject}.confirmation`),
      };
    case "cancellation-requested":
    case "failed":
    case "orphaned":
      exactKeys(row, [...BASE_EVENT_KEYS, "reason"], subject);
      return { ...base, type: row.type, reason: requireText(row.reason, `${subject}.reason`)! };
    default:
      fail(`${subject}.type`, "不是受支持的 production event");
  }
}

function digestParsedProductionEvent(event: ProductionTaskEvent): string {
  return createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex");
}

/** Digest an event after strict parsing/canonical field ordering, so JSON key order cannot change replay identity. */
export function productionEventDigest(value: ProductionTaskEvent): string {
  return digestParsedProductionEvent(parseProductionTaskEvent(value));
}

const TARGET_BY_EVENT: Readonly<Record<ProductionTaskEvent["type"], ProductionStatus>> = Object.freeze({
  "dispatch-requested": "dispatch-pending",
  "submission-started": "submitting",
  "submission-confirmed": "submitted",
  "submission-uncertain": "submission-unknown",
  "remote-started": "running",
  "ingestion-started": "ingesting",
  "qc-requested": "qc-pending",
  approved: "approved",
  rejected: "rejected",
  "cancellation-requested": "cancel-requested",
  cancelled: "cancelled",
  failed: "failed",
  orphaned: "orphaned",
});

export function isTerminalProductionStatus(status: ProductionStatus): boolean {
  return TERMINAL_SET.has(status);
}

export function canTransitionProductionTask(from: ProductionStatus, to: ProductionStatus): boolean {
  // Each literal array is narrower than the union as a whole; widen only at this lookup boundary.
  return (PRODUCTION_TRANSITIONS[from] as readonly ProductionStatus[]).includes(to);
}

function assertRemoteIdentity(task: ProductionTask, backendInstanceId: string, remoteJobId?: string): void {
  if (task.backendInstanceId !== null && task.backendInstanceId !== backendInstanceId) {
    fail("ProductionTaskEvent", `backendInstanceId 不能从 ${task.backendInstanceId} 改为 ${backendInstanceId}`);
  }
  if (remoteJobId !== undefined && task.remoteJobId !== null && task.remoteJobId !== remoteJobId) {
    fail("ProductionTaskEvent", `remoteJobId 不能从 ${task.remoteJobId} 改为 ${remoteJobId}`);
  }
}

/** Pure, deterministic transition reducer. It performs no I/O and never mutates its arguments. */
export function transitionProductionTask(taskValue: ProductionTask, eventValue: ProductionTaskEvent): ProductionTask {
  const task = parseProductionTask(taskValue);
  const event = parseProductionTaskEvent(eventValue);
  if (event.taskId !== task.id) fail("ProductionTaskEvent.taskId", `与 task ${task.id} 不匹配`);
  const payloadDigest = digestParsedProductionEvent(event);
  // Exact retries are no-ops even though expectedRevision is now stale; the same ID can never
  // acknowledge a different fact.
  const priorReceipt = task.eventReceipts.find((receipt) => receipt.eventId === event.eventId);
  if (priorReceipt) {
    if (priorReceipt.payloadDigest !== payloadDigest) {
      fail("ProductionTaskEvent.eventId", `${event.eventId} 已绑定另一 canonical payload（拒绝冲突重放）`);
    }
    return task;
  }
  if (event.expectedRevision !== task.revision) {
    fail("ProductionTaskEvent.expectedRevision", `期望 ${event.expectedRevision}，当前 task revision 为 ${task.revision}（拒绝乱序事件）`);
  }
  if (event.occurredAt < task.updatedAt) {
    fail("ProductionTaskEvent.occurredAt", `早于 task.updatedAt=${task.updatedAt}（拒绝乱序事件）`);
  }
  const target = TARGET_BY_EVENT[event.type];
  if (isTerminalProductionStatus(task.status)) {
    fail("ProductionTaskEvent", `终态 ${task.status} 禁止回退或追加 ${target}`);
  }
  if (!canTransitionProductionTask(task.status, target)) {
    fail("ProductionTaskEvent", `非法 transition ${task.status} -> ${target}`);
  }
  if (task.status === "cancel-requested" && !["cancelled", "failed", "orphaned"].includes(target)) {
    const source = task.cancellationRequest?.requestedFrom;
    if (source === undefined
      || !(CANCELLATION_RECOVERY_TARGETS[source] as readonly ProductionStatus[]).includes(target)) {
      fail("ProductionTaskEvent", `cancellationRequest 来源 ${source ?? "missing"} 不允许安全恢复到 ${target}`);
    }
  }
  if (task.eventReceipts.length >= MAX_PRODUCTION_EVENT_IDS_PER_TASK) {
    fail("ProductionTask.eventReceipts", `超过 ${MAX_PRODUCTION_EVENT_IDS_PER_TASK} 项安全上限`);
  }

  let backendInstanceId = task.backendInstanceId;
  let remoteJobId = task.remoteJobId;
  let submissionOutbox = task.submissionOutbox;
  let cancellationRequest = task.cancellationRequest;
  let cancellationConfirmation = task.cancellationConfirmation;
  let assets = task.assets;
  let cost = task.cost;
  let approval: ProductionApproval | null = null;
  let statusMessage: string | null = null;

  switch (event.type) {
    case "submission-started":
      assertRemoteIdentity(task, event.backendInstanceId, event.remoteJobId);
      backendInstanceId = event.backendInstanceId;
      remoteJobId = event.remoteJobId;
      submissionOutbox = {
        version: 1,
        requestDigest: event.requestDigest,
        preparedAt: event.occurredAt,
        state: "pending",
      };
      break;
    case "submission-confirmed":
    case "remote-started":
      assertRemoteIdentity(task, event.backendInstanceId, event.remoteJobId);
      backendInstanceId = event.backendInstanceId;
      remoteJobId = event.remoteJobId;
      if (submissionOutbox === null) fail("ProductionTaskEvent", "远端确认前缺少 durable submission outbox");
      submissionOutbox = { ...submissionOutbox, state: "acknowledged" };
      break;
    case "submission-uncertain":
      assertRemoteIdentity(task, event.backendInstanceId, event.remoteJobId);
      backendInstanceId = event.backendInstanceId;
      remoteJobId = event.remoteJobId;
      if (submissionOutbox === null) fail("ProductionTaskEvent", "submission timeout 前缺少 durable submission outbox");
      submissionOutbox = { ...submissionOutbox, state: "unknown" };
      statusMessage = event.reason;
      break;
    case "qc-requested":
      if (task.status === "cancel-requested" && cancellationRequest?.requestedFrom === "qc-pending"
        && (JSON.stringify(event.assets) !== JSON.stringify(task.assets)
          || JSON.stringify(event.cost) !== JSON.stringify(task.cost))) {
        fail("ProductionTaskEvent", "从已存在的 qc-pending 取消竞态恢复时不得替换已审阅 assets/cost");
      }
      assets = event.assets;
      cost = event.cost;
      break;
    case "approved":
    case "rejected":
      approval = {
        version: 1,
        decision: event.type,
        taskRevision: task.revision,
        subjectRevision: subjectRevision(task.subject),
        decidedAt: event.occurredAt,
        decidedBy: event.decidedBy,
        note: event.note,
      };
      statusMessage = event.note;
      break;
    case "cancellation-requested":
      if (cancellationRequest !== null) {
        fail("ProductionTaskEvent", "同一 task 已有 cancellationRequest；不得覆盖原始取消来源");
      }
      if (!CANCELLATION_SOURCE_SET.has(task.status)) {
        fail("ProductionTaskEvent", `${task.status} 不是可记录的取消来源阶段`);
      }
      cancellationRequest = {
        version: 1,
        requestedFrom: task.status as CancellationSourceStatus,
        requestedAt: event.occurredAt,
        reason: event.reason,
      };
      statusMessage = event.reason;
      break;
    case "cancelled": {
      if (cancellationRequest === null) {
        fail("ProductionTaskEvent", "cancelled 前缺少 durable cancellationRequest");
      }
      if (event.confirmation.kind === "local-no-submission") {
        const source = cancellationRequest.requestedFrom;
        if (source !== "planned" && source !== "dispatch-pending") {
          fail("ProductionTaskEvent", `local-no-submission 取消确认不能用于 requestedFrom=${source}`);
        }
        if (backendInstanceId !== null || remoteJobId !== null || submissionOutbox !== null) {
          fail("ProductionTaskEvent", "local-no-submission 取消确认不得与 remote tuple/outbox 共存");
        }
      } else {
        if (backendInstanceId === null || remoteJobId === null || submissionOutbox === null) {
          fail("ProductionTaskEvent", "remote-terminal-observation 前缺少 durable remote tuple/outbox");
        }
        if (event.confirmation.backendInstanceId !== backendInstanceId) {
          fail("ProductionTaskEvent", "remote-terminal-observation.backendInstanceId 与 task backendInstanceId 不匹配");
        }
        if (event.confirmation.remoteJobId !== remoteJobId) {
          fail("ProductionTaskEvent", "remote-terminal-observation.remoteJobId 与 task remoteJobId 不匹配");
        }
        if (event.confirmation.observedAt < cancellationRequest.requestedAt
          || event.confirmation.observedAt > event.occurredAt) {
          fail("ProductionTaskEvent", "remote-terminal-observation.observedAt 必须位于取消请求与 event occurredAt 之间");
        }
        // A terminal observation proves that the preallocated remote ID was accepted even if the
        // original POST response was lost. Preserve that stronger fact in the durable outbox.
        submissionOutbox = { ...submissionOutbox, state: "acknowledged" };
      }
      cancellationConfirmation = event.confirmation;
      statusMessage = event.reason;
      break;
    }
    case "failed":
    case "orphaned":
      statusMessage = event.reason;
      break;
    case "dispatch-requested":
    case "ingestion-started":
      break;
  }

  return parseProductionTask({
    ...task,
    status: target,
    revision: task.revision + 1,
    updatedAt: event.occurredAt,
    backendInstanceId,
    remoteJobId,
    submissionOutbox,
    cancellationRequest,
    cancellationConfirmation,
    assets,
    cost,
    approval,
    statusMessage,
    eventReceipts: [...task.eventReceipts, { version: 1, eventId: event.eventId, payloadDigest }],
  });
}
