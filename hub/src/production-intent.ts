// Immutable Phase 3B dispatch intents and their pure pre-dispatch policy gates.
//
// An intent is the durable boundary between writing-loop and a remote production coordinator.
// It binds the exact subject revision, backend configuration digests, stable input assets and the
// evidence used to authorize one billable request.  Adapters must consume the parsed intent rather
// than rebuilding a request from mutable configuration.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  MAX_PRODUCTION_COST_MICROS,
  ProductionError,
  parseAssetRef,
  parseProductionSubjectRef,
  type AssetRef,
  type ProductionSubjectRef,
} from "./production-domain.ts";
import { assertProjectKey } from "./workspace.ts";

export const PRODUCTION_INTENT_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_INTENT_DIRECTORY = "production-intents.v1";
export const MAX_PRODUCTION_INTENT_BYTES = 256 * 1024;
export const MAX_PRODUCTION_INTENT_INPUTS = 32;
export const MAX_PRODUCTION_INTENT_TERRITORIES = 64;

export const PRODUCTION_INTENT_OPERATIONS = ["comfyui-workflow", "minimax-h3"] as const;
export type ProductionIntentOperation = typeof PRODUCTION_INTENT_OPERATIONS[number];

/** Transport and model identity are separate: H3 may execute through a ComfyUI workflow. */
export const PRODUCTION_MODEL_FAMILIES = ["generic", "minimax-h3"] as const;
export type ProductionModelFamily = typeof PRODUCTION_MODEL_FAMILIES[number];

export const H3_VARIANTS = ["fl2va", "ref2va"] as const;
export type H3Variant = typeof H3_VARIANTS[number];

/** H3 v1 intentionally exposes only the output shapes the coordinator can validate end-to-end. */
export const H3_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type H3AspectRatio = typeof H3_ASPECT_RATIOS[number];

export const H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES = ["EU", "GB", "KR", "US"] as const;

/** ISO-3166 alpha-2 members of the European Union (2026), all covered by the H3 EU exclusion. */
export const EU_MEMBER_TERRITORIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;

type ProductionExecutionBase = {
  version: 1;
  operation: ProductionIntentOperation;
  modelFamily: ProductionModelFamily;
  backendInstanceId: string;
  workflowSha256: string;
  modelSha256: string;
  parametersSha256: string;
};

export type ProductionIntentExecution =
  | ProductionExecutionBase & {
      operation: "comfyui-workflow";
      modelFamily: "generic";
    }
  | ProductionExecutionBase & {
      /** H3 may be transported by the direct gateway or by a pinned ComfyUI workflow. */
      operation: "comfyui-workflow" | "minimax-h3";
      modelFamily: "minimax-h3";
      variant: H3Variant;
      durationSeconds: number;
      shortEdge: 768;
      aspectRatio: H3AspectRatio;
    };

export type ProductionIntentBudget = {
  version: 1;
  currency: "USD";
  estimatedAmountMicros: number;
  maximumAmountMicros: number;
};

export type ProductionRightsEvidence = {
  version: 1;
  status: "cleared" | "unknown" | "expired" | "blocked";
  territories: string[];
  evidence: AssetRef | null;
  expiresAt: string | null;
};

export type ProductionModerationEvidence = {
  version: 1;
  status: "passed" | "not-reviewed" | "failed";
  reviewedAt: string | null;
  evidence: AssetRef | null;
};

export type ProductionLicenseEvidence = {
  version: 1;
  status: "verified" | "unknown" | "blocked";
  basis: "community" | "provider-terms" | "written-license";
  territories: string[];
  licenseSha256: string | null;
  evidence: AssetRef | null;
  issuedBy: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
};

export type ProductionIntentDraft = {
  version: 1;
  taskId: string;
  subject: ProductionSubjectRef;
  createdAt: string;
  useTerritories: string[];
  execution: ProductionIntentExecution;
  inputs: AssetRef[];
  budget: ProductionIntentBudget;
  rights: ProductionRightsEvidence;
  moderation: ProductionModerationEvidence;
  license: ProductionLicenseEvidence;
};

export type ProductionDispatchIntent = ProductionIntentDraft & {
  /** SHA-256 of the complete canonical parsed draft. */
  idempotencyKey: string;
};

export type ProductionIntentGateContext = {
  version: 1;
  evaluatedAt: string;
  deploymentTerritories: string[];
  availableBudgetMicros: number;
};

export const PRODUCTION_INTENT_GATE_CODES = [
  "budget-maximum-exceeded",
  "budget-available-exceeded",
  "rights-not-cleared",
  "rights-evidence-missing",
  "rights-territory-missing",
  "rights-expired",
  "moderation-not-passed",
  "moderation-evidence-missing",
  "moderation-from-future",
  "license-not-verified",
  "license-evidence-missing",
  "license-territory-missing",
  "license-expired",
  "license-issued-in-future",
  "h3-written-license-required",
] as const;

export type ProductionIntentGateCode = typeof PRODUCTION_INTENT_GATE_CODES[number];

export type ProductionIntentGateFailure = {
  version: 1;
  code: ProductionIntentGateCode;
  message: string;
};

export type ProductionIntentGateDecision = {
  version: 1;
  allowed: boolean;
  failures: ProductionIntentGateFailure[];
};

/** Coordinator dependency port. Implementations may load the immutable companion locally or remotely. */
export interface ProductionIntentResolver {
  resolve(taskId: string, signal?: AbortSignal): Promise<ProductionDispatchIntent | null>;
}

export type EnqueueProductionIntentResult = {
  created: boolean;
  path: string;
  intent: ProductionDispatchIntent;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERRITORY = /^(?:[A-Z]{2}|WORLDWIDE)$/;
const RIGHTS_STATUSES = new Set(["cleared", "unknown", "expired", "blocked"]);
const MODERATION_STATUSES = new Set(["passed", "not-reviewed", "failed"]);
const LICENSE_STATUSES = new Set(["verified", "unknown", "blocked"]);
const LICENSE_BASES = new Set(["community", "provider-terms", "written-license"]);
const H3_VARIANT_SET = new Set<string>(H3_VARIANTS);
const H3_ASPECT_RATIO_SET = new Set<string>(H3_ASPECT_RATIOS);
const RESTRICTED_H3_TERRITORIES = new Set<string>(H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES);
const EU_MEMBER_TERRITORY_SET = new Set<string>(EU_MEMBER_TERRITORIES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new ProductionError(`${subject} ${detail}`);
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) fail(subject, `含不支持字段：${extras.join("、")}（v1 schema 严格拒绝未知字段）`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(subject, `缺少字段：${missing.join("、")}`);
}

function requireVersion(value: unknown, subject: string): void {
  if (value !== PRODUCTION_INTENT_SCHEMA_VERSION) fail(subject, "version 必须是 1");
}

function requireSafeInteger(
  value: unknown,
  subject: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(subject, `必须是 ${minimum}–${maximum} 的安全整数`);
  }
  return value as number;
}

function requireId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail(subject, "必须是 1–128 位安全标识符");
  }
  return value;
}

function requireOpaque(value: unknown, subject: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(subject, `必须是 1–${maximum} 位且不含控制字符的字符串`);
  }
  return value;
}

function requireIso(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length > 64) fail(subject, "必须是规范 UTC ISO-8601 时间");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail(subject, "必须是规范 UTC ISO-8601 时间");
  }
  return value;
}

function nullableIso(value: unknown, subject: string): string | null {
  return value === null ? null : requireIso(value, subject);
}

function requireSha256(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(subject, "必须是 64 位小写十六进制 sha256");
  return value;
}

function nullableSha256(value: unknown, subject: string): string | null {
  return value === null ? null : requireSha256(value, subject);
}

function nullableOpaque(value: unknown, subject: string): string | null {
  return value === null ? null : requireOpaque(value, subject);
}

function parseTerritories(value: unknown, subject: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) fail(subject, "必须是地域数组");
  if ((!allowEmpty && value.length === 0) || value.length > MAX_PRODUCTION_INTENT_TERRITORIES) {
    fail(subject, `必须包含 ${allowEmpty ? "0" : "1"}–${MAX_PRODUCTION_INTENT_TERRITORIES} 个地域`);
  }
  const parsed = value.map((territory, index) => {
    if (typeof territory !== "string" || !TERRITORY.test(territory)) {
      fail(`${subject}[${index}]`, "必须是大写二位地域码、EU 或 WORLDWIDE");
    }
    return territory;
  });
  if (new Set(parsed).size !== parsed.length) fail(subject, "不得包含重复地域");
  if (parsed.includes("WORLDWIDE") && parsed.length !== 1) {
    fail(subject, "WORLDWIDE 必须单独使用，不能与具体地域混合");
  }
  return [...parsed].sort();
}

function parseInputs(value: unknown, subject: string): AssetRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PRODUCTION_INTENT_INPUTS) {
    fail(subject, `必须是 1–${MAX_PRODUCTION_INTENT_INPUTS} 项 AssetRef 数组`);
  }
  const inputs = value.map((entry, index) => parseAssetRef(entry, `${subject}[${index}]`));
  const identities = inputs.map((entry) => `${entry.uri}\0${entry.sha256}`);
  if (new Set(identities).size !== identities.length) fail(subject, "不得包含重复 AssetRef");
  return inputs;
}

export function parseProductionIntentExecution(
  value: unknown,
  subject = "ProductionIntentExecution",
): ProductionIntentExecution {
  const row = requireRecord(value, subject);
  const common = [
    "version", "operation", "modelFamily", "backendInstanceId", "workflowSha256", "modelSha256",
    "parametersSha256",
  ] as const;
  if (row.modelFamily === "generic") {
    exactKeys(row, common, subject);
    requireVersion(row.version, subject);
    if (row.operation !== "comfyui-workflow") {
      fail(`${subject}.operation`, "generic modelFamily 只允许 comfyui-workflow transport");
    }
    return {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "generic",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
    };
  }
  if (row.modelFamily === "minimax-h3") {
    exactKeys(row, [...common, "variant", "durationSeconds", "shortEdge", "aspectRatio"], subject);
    requireVersion(row.version, subject);
    if (row.operation !== "comfyui-workflow" && row.operation !== "minimax-h3") {
      fail(`${subject}.operation`, "H3 transport 必须是 comfyui-workflow 或 minimax-h3");
    }
    if (typeof row.variant !== "string" || !H3_VARIANT_SET.has(row.variant)) {
      fail(`${subject}.variant`, "必须是 fl2va 或 ref2va");
    }
    if (row.shortEdge !== 768) fail(`${subject}.shortEdge`, "H3 v1 必须固定为 768");
    if (typeof row.aspectRatio !== "string" || !H3_ASPECT_RATIO_SET.has(row.aspectRatio)) {
      fail(`${subject}.aspectRatio`, `必须是 ${H3_ASPECT_RATIOS.join("、")}`);
    }
    return {
      version: 1,
      operation: row.operation,
      modelFamily: "minimax-h3",
      backendInstanceId: requireOpaque(row.backendInstanceId, `${subject}.backendInstanceId`),
      workflowSha256: requireSha256(row.workflowSha256, `${subject}.workflowSha256`),
      modelSha256: requireSha256(row.modelSha256, `${subject}.modelSha256`),
      parametersSha256: requireSha256(row.parametersSha256, `${subject}.parametersSha256`),
      variant: row.variant as H3Variant,
      durationSeconds: requireSafeInteger(row.durationSeconds, `${subject}.durationSeconds`, 4, 15),
      shortEdge: 768,
      aspectRatio: row.aspectRatio as H3AspectRatio,
    };
  }
  fail(`${subject}.modelFamily`, "必须是 generic 或 minimax-h3");
}

function parseBudget(value: unknown, subject: string): ProductionIntentBudget {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "currency", "estimatedAmountMicros", "maximumAmountMicros"], subject);
  requireVersion(row.version, subject);
  if (row.currency !== "USD") fail(`${subject}.currency`, "v1 仅支持 USD");
  return {
    version: 1,
    currency: "USD",
    estimatedAmountMicros: requireSafeInteger(
      row.estimatedAmountMicros,
      `${subject}.estimatedAmountMicros`,
      0,
      MAX_PRODUCTION_COST_MICROS,
    ),
    maximumAmountMicros: requireSafeInteger(
      row.maximumAmountMicros,
      `${subject}.maximumAmountMicros`,
      1,
      MAX_PRODUCTION_COST_MICROS,
    ),
  };
}

function parseRights(value: unknown, subject: string): ProductionRightsEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "status", "territories", "evidence", "expiresAt"], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !RIGHTS_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 cleared、unknown、expired 或 blocked");
  }
  return {
    version: 1,
    status: row.status as ProductionRightsEvidence["status"],
    territories: parseTerritories(row.territories, `${subject}.territories`, true),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
    expiresAt: nullableIso(row.expiresAt, `${subject}.expiresAt`),
  };
}

function parseModeration(value: unknown, subject: string): ProductionModerationEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "status", "reviewedAt", "evidence"], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !MODERATION_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 passed、not-reviewed 或 failed");
  }
  return {
    version: 1,
    status: row.status as ProductionModerationEvidence["status"],
    reviewedAt: nullableIso(row.reviewedAt, `${subject}.reviewedAt`),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
  };
}

function parseLicense(value: unknown, subject: string): ProductionLicenseEvidence {
  const row = requireRecord(value, subject);
  exactKeys(row, [
    "version", "status", "basis", "territories", "licenseSha256", "evidence", "issuedBy",
    "issuedAt", "expiresAt",
  ], subject);
  requireVersion(row.version, subject);
  if (typeof row.status !== "string" || !LICENSE_STATUSES.has(row.status)) {
    fail(`${subject}.status`, "必须是 verified、unknown 或 blocked");
  }
  if (typeof row.basis !== "string" || !LICENSE_BASES.has(row.basis)) {
    fail(`${subject}.basis`, "必须是 community、provider-terms 或 written-license");
  }
  const issuedAt = nullableIso(row.issuedAt, `${subject}.issuedAt`);
  const expiresAt = nullableIso(row.expiresAt, `${subject}.expiresAt`);
  if (issuedAt !== null && expiresAt !== null && expiresAt < issuedAt) {
    fail(`${subject}.expiresAt`, "不得早于 issuedAt");
  }
  return {
    version: 1,
    status: row.status as ProductionLicenseEvidence["status"],
    basis: row.basis as ProductionLicenseEvidence["basis"],
    territories: parseTerritories(row.territories, `${subject}.territories`, true),
    licenseSha256: nullableSha256(row.licenseSha256, `${subject}.licenseSha256`),
    evidence: row.evidence === null ? null : parseAssetRef(row.evidence, `${subject}.evidence`),
    issuedBy: nullableOpaque(row.issuedBy, `${subject}.issuedBy`),
    issuedAt,
    expiresAt,
  };
}

function parseDraftFields(row: Record<string, unknown>, subject: string): ProductionIntentDraft {
  requireVersion(row.version, subject);
  return {
    version: 1,
    taskId: requireId(row.taskId, `${subject}.taskId`),
    subject: parseProductionSubjectRef(row.subject, `${subject}.subject`),
    createdAt: requireIso(row.createdAt, `${subject}.createdAt`),
    useTerritories: parseTerritories(row.useTerritories, `${subject}.useTerritories`),
    execution: parseProductionIntentExecution(row.execution, `${subject}.execution`),
    inputs: parseInputs(row.inputs, `${subject}.inputs`),
    budget: parseBudget(row.budget, `${subject}.budget`),
    rights: parseRights(row.rights, `${subject}.rights`),
    moderation: parseModeration(row.moderation, `${subject}.moderation`),
    license: parseLicense(row.license, `${subject}.license`),
  };
}

const DRAFT_KEYS = [
  "version", "taskId", "subject", "createdAt", "useTerritories", "execution", "inputs",
  "budget", "rights", "moderation", "license",
] as const;

export function parseProductionIntentDraft(
  value: unknown,
  subject = "ProductionIntentDraft",
): ProductionIntentDraft {
  const row = requireRecord(value, subject);
  exactKeys(row, DRAFT_KEYS, subject);
  return parseDraftFields(row, subject);
}

/** Digest the complete parser-canonical draft; JSON insertion order is fixed by parseDraftFields. */
export function productionIntentIdempotencyKey(value: unknown): string {
  const draft = parseProductionIntentDraft(value);
  return createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
}

export function createProductionDispatchIntent(value: unknown): ProductionDispatchIntent {
  const draft = parseProductionIntentDraft(value);
  return { ...draft, idempotencyKey: productionIntentIdempotencyKey(draft) };
}

export function parseProductionDispatchIntent(
  value: unknown,
  subject = "ProductionDispatchIntent",
): ProductionDispatchIntent {
  const row = requireRecord(value, subject);
  exactKeys(row, [...DRAFT_KEYS, "idempotencyKey"], subject);
  const draft = parseDraftFields(row, subject);
  const expected = productionIntentIdempotencyKey(draft);
  const actual = requireSha256(row.idempotencyKey, `${subject}.idempotencyKey`);
  if (actual !== expected) {
    fail(`${subject}.idempotencyKey`, "与 canonical parsed intent 不匹配（拒绝可变配置漂移）");
  }
  return { ...draft, idempotencyKey: expected };
}

export function parseProductionIntentGateContext(
  value: unknown,
  subject = "ProductionIntentGateContext",
): ProductionIntentGateContext {
  const row = requireRecord(value, subject);
  exactKeys(row, ["version", "evaluatedAt", "deploymentTerritories", "availableBudgetMicros"], subject);
  requireVersion(row.version, subject);
  return {
    version: 1,
    evaluatedAt: requireIso(row.evaluatedAt, `${subject}.evaluatedAt`),
    deploymentTerritories: parseTerritories(
      row.deploymentTerritories,
      `${subject}.deploymentTerritories`,
    ),
    availableBudgetMicros: requireSafeInteger(
      row.availableBudgetMicros,
      `${subject}.availableBudgetMicros`,
      0,
      MAX_PRODUCTION_COST_MICROS,
    ),
  };
}

function territoryCovered(grants: readonly string[], territory: string): boolean {
  return grants.includes("WORLDWIDE") || grants.includes(territory);
}

/** Pure and deterministic: invalid wire data throws; valid-but-unapproved evidence returns deny. */
export function evaluateProductionIntentGates(
  intentValue: unknown,
  contextValue: unknown,
): ProductionIntentGateDecision {
  const intent = parseProductionDispatchIntent(intentValue);
  const context = parseProductionIntentGateContext(contextValue);
  const failures: ProductionIntentGateFailure[] = [];
  const deny = (code: ProductionIntentGateCode, message: string): void => {
    failures.push({ version: 1, code, message });
  };

  if (intent.budget.estimatedAmountMicros > intent.budget.maximumAmountMicros) {
    deny("budget-maximum-exceeded", "预算估算超过 intent 的不可变单任务上限");
  }
  if (intent.budget.maximumAmountMicros > context.availableBudgetMicros) {
    deny("budget-available-exceeded", "不可变单任务上限超过本次 gate 的可用预算快照");
  }

  if (intent.rights.status !== "cleared") {
    deny("rights-not-cleared", `rights 状态为 ${intent.rights.status}`);
  }
  if (intent.rights.evidence === null) {
    deny("rights-evidence-missing", "缺少稳定 AssetRef 形式的 rights evidence");
  }
  for (const territory of intent.useTerritories) {
    if (!territoryCovered(intent.rights.territories, territory)) {
      deny("rights-territory-missing", `rights evidence 未覆盖使用地域 ${territory}`);
    }
  }
  if (intent.rights.expiresAt !== null && intent.rights.expiresAt <= context.evaluatedAt) {
    deny("rights-expired", "rights evidence 在 gate 时已过期");
  }

  if (intent.moderation.status !== "passed") {
    deny("moderation-not-passed", `moderation 状态为 ${intent.moderation.status}`);
  }
  if (intent.moderation.evidence === null || intent.moderation.reviewedAt === null) {
    deny("moderation-evidence-missing", "缺少 moderation 时间或稳定 evidence AssetRef");
  } else if (intent.moderation.reviewedAt > context.evaluatedAt) {
    deny("moderation-from-future", "moderation reviewedAt 晚于 gate 时间");
  }

  if (intent.license.status !== "verified" || intent.license.licenseSha256 === null) {
    deny("license-not-verified", `license 状态为 ${intent.license.status} 或缺少 license digest`);
  }
  if (intent.license.evidence === null) {
    deny("license-evidence-missing", "缺少稳定 AssetRef 形式的 license evidence");
  }
  const licenseTerritories = new Set([...intent.useTerritories, ...context.deploymentTerritories]);
  for (const territory of [...licenseTerritories].sort()) {
    if (!territoryCovered(intent.license.territories, territory)) {
      deny("license-territory-missing", `license evidence 未覆盖使用/部署地域 ${territory}`);
    }
  }
  if (intent.license.expiresAt !== null && intent.license.expiresAt <= context.evaluatedAt) {
    deny("license-expired", "license evidence 在 gate 时已过期");
  }
  if (intent.license.issuedAt !== null && intent.license.issuedAt > context.evaluatedAt) {
    deny("license-issued-in-future", "license issuedAt 晚于 gate 时间");
  }

  if (intent.execution.modelFamily === "minimax-h3") {
    const restricted = new Set<string>();
    if (licenseTerritories.has("WORLDWIDE")) {
      for (const territory of H3_RESTRICTED_COMMUNITY_LICENSE_TERRITORIES) restricted.add(territory);
    } else {
      for (const territory of licenseTerritories) {
        if (territory === "EU" || EU_MEMBER_TERRITORY_SET.has(territory)) restricted.add("EU");
        else if (territory === "UK") restricted.add("GB");
        else if (RESTRICTED_H3_TERRITORIES.has(territory)) restricted.add(territory);
      }
    }
    const explicitWrittenLicense = intent.license.basis === "written-license"
      && intent.license.status === "verified"
      && intent.license.evidence !== null
      && intent.license.licenseSha256 !== null
      && intent.license.issuedBy !== null
      && intent.license.issuedAt !== null;
    if (restricted.size > 0 && !explicitWrittenLicense) {
      deny(
        "h3-written-license-required",
        `MiniMax H3 open-weight license 在 ${[...restricted].sort().join("、")} 默认禁止 dispatch；需要明确 written-license evidence`,
      );
    }
    if (intent.license.basis === "written-license" && !explicitWrittenLicense
      && !failures.some((failure) => failure.code === "h3-written-license-required")) {
      deny("h3-written-license-required", "H3 written-license 必须包含验证状态、签发方/时间、digest 与 evidence");
    }
  }

  return { version: 1, allowed: failures.length === 0, failures };
}

function errno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function assertRealDirectory(path: string, subject: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { fail(subject, `目录不存在：${path}（${error instanceof Error ? error.message : String(error)}）`); }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(subject, `必须是真实目录（拒绝 symlink/FIFO/device）：${path}`);
  }
}

function projectDirectory(root: string, project: string): string {
  assertProjectKey(project);
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(resolve(root)); }
  catch (error) { fail("ProductionIntent", `workspace root 不存在：${error instanceof Error ? error.message : String(error)}`); }
  const writingLoop = join(canonicalRoot, ".writing-loop");
  const projectPath = join(writingLoop, project);
  assertRealDirectory(writingLoop, "ProductionIntent workspace state");
  assertRealDirectory(projectPath, `ProductionIntent project '${project}'`);
  return projectPath;
}

function intentDirectory(root: string, project: string, create: boolean): string | null {
  const directory = join(projectDirectory(root, project), PRODUCTION_INTENT_DIRECTORY);
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail("ProductionIntent directory", `必须是真实目录（拒绝 symlink/FIFO/device）：${directory}`);
    }
    return directory;
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    if (errno(error) !== "ENOENT") throw error;
    if (!create) return null;
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (mkdirError) {
      if (errno(mkdirError) !== "EEXIST") {
        fail("ProductionIntent directory", `无法创建 ${directory}：${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`);
      }
    }
    assertRealDirectory(directory, "ProductionIntent directory");
    return directory;
  }
}

export function productionIntentPath(root: string, project: string, taskId: string): string {
  const parsedTaskId = requireId(taskId, "ProductionIntent.taskId");
  return join(projectDirectory(root, project), PRODUCTION_INTENT_DIRECTORY, `${parsedTaskId}.json`);
}

function sameFile(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino)
    && Number(left.size) === Number(right.size) && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function boundedIntentBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > MAX_PRODUCTION_INTENT_BYTES) {
    fail("ProductionIntent maxBytes", `必须是 1024–${MAX_PRODUCTION_INTENT_BYTES} 的安全整数`);
  }
  return maxBytes;
}

export function readProductionIntent(
  root: string,
  project: string,
  taskId: string,
  maxBytes = MAX_PRODUCTION_INTENT_BYTES,
): ProductionDispatchIntent | null {
  const limit = boundedIntentBytes(maxBytes);
  const parsedTaskId = requireId(taskId, "ProductionIntent.taskId");
  const directory = intentDirectory(root, project, false);
  if (directory === null) return null;
  const file = join(directory, `${parsedTaskId}.json`);
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(file); }
  catch (error) {
    if (errno(error) === "ENOENT") return null;
    fail("ProductionIntent", `无法检查 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("ProductionIntent", `${file} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
  }
  if (before.size > limit) fail("ProductionIntent", `${file} 超过 ${limit} bytes 安全读取上限`);

  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      fail("ProductionIntent", `${file} 在 lstat/open 间被替换或不是单链接普通文件`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== bytes.length || !sameFile(before, after)) {
      fail("ProductionIntent", `${file} 在读取期间变化（immutable companion 被修改）`);
    }
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes) || raw.includes("\0")) {
      fail("ProductionIntent", `${file} 不是无 NUL 的规范 UTF-8 JSON`);
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { fail("ProductionIntent", `${file} JSON 损坏：${error instanceof Error ? error.message : String(error)}`); }
    const intent = parseProductionDispatchIntent(value, `ProductionIntent ${file}`);
    if (intent.taskId !== parsedTaskId) fail("ProductionIntent", `${file} 内 taskId 与文件名不匹配`);
    return intent;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the primary result */ }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Persist one immutable companion with O_EXCL. Exact replay is a no-op; any task/config drift is a
 * hard conflict. A crash-truncated file remains fail-closed for explicit operator audit.
 */
export function enqueueProductionIntent(
  root: string,
  project: string,
  value: unknown,
  maxBytes = MAX_PRODUCTION_INTENT_BYTES,
): EnqueueProductionIntentResult {
  const limit = boundedIntentBytes(maxBytes);
  const intent = parseProductionDispatchIntent(value);
  const directory = intentDirectory(root, project, true)!;
  const file = join(directory, `${intent.taskId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(intent, null, 2)}\n`, "utf8");
  if (bytes.length > limit) fail("ProductionIntent", `canonical intent 超过 ${limit} bytes 安全上限`);

  let fd: number | undefined;
  try {
    try {
      fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        fail("ProductionIntent", `无法 O_EXCL 创建 ${file}：${error instanceof Error ? error.message : String(error)}`);
      }
      const existing = readProductionIntent(root, project, intent.taskId, limit);
      if (existing !== null && JSON.stringify(existing) === JSON.stringify(intent)) {
        return { created: false, path: file, intent: existing };
      }
      fail("ProductionIntent", `${file} 已绑定另一 canonical intent（拒绝覆盖或配置漂移）`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) {
      fail("ProductionIntent", `${file} 创建后不是单链接普通文件`);
    }
    writeAll(fd, bytes);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || written.size !== bytes.length) {
      fail("ProductionIntent", `${file} 写入后 identity/长度异常`);
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  syncDirectory(directory);
  return { created: true, path: file, intent };
}
