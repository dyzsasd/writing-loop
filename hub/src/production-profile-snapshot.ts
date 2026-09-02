// Worker-side strict reader for the gateway's read-only execution profile snapshot (§4.2).
//
// The snapshot is the *only* place `plan-shots` may read a price from: the registry that owns the
// profile originals exports this file, and the worker holds no second copy of the price table. The
// parser below is deliberately field-for-field aligned with `exportExecutionProfileSnapshot`
// (`production-gateway-runtime-config.ts`); the type-only import makes that alignment a compile
// error rather than a comment, without pulling the gateway's server-only module into the worker.
import { isAbsolute, join, resolve } from "node:path";
import { hasSymlinkComponent } from "./bounded-fs.ts";
import { productionCanonicalJsonSha256 } from "./production-canonical-json.ts";
import {
  parseProductionLicenseEvidence,
  parseProductionProcessingRegions,
} from "./production-intent.ts";
import { parseVideoBackendLimits } from "./production-provider-adapter.ts";
import { readPrivateRegularTextExact } from "./production-runtime-config.ts";
import { parseShotExecutionProfile, type ShotExecutionProfile } from "./production-shot-request.ts";
import type { VideoBackendLimits } from "./production-adapter.ts";
import type {
  ProductionExecutionProfileSnapshotEntry,
  ProductionGatewayPriceTable,
} from "./production-gateway-runtime-config.ts";

export const PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND = "writing-loop/execution-profile-snapshot";
export const MAX_PRODUCTION_PROFILE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_PRODUCTION_PROFILE_SNAPSHOT_PROFILES = 256;

/**
 * Snapshot entry as the worker reads it. `limits` is the capability ceiling the gateway starts
 * exporting in Phase 1b; until then it is absent and `plan-shots` takes the limits from the batch
 * request instead. Present or absent, the entry digest is computed over exactly the keys that are
 * there, so both shapes verify against the digest the exporter wrote.
 */
export type ProductionExecutionProfileSnapshotReadEntry =
  ProductionExecutionProfileSnapshotEntry & { limits?: VideoBackendLimits };

export type ProductionExecutionProfileSnapshotRead = Readonly<{
  version: 1;
  kind: typeof PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND;
  casAuthority: string;
  profiles: readonly ProductionExecutionProfileSnapshotReadEntry[];
}>;

export class ProductionProfileSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionProfileSnapshotError";
  }
}

const CAS_AUTHORITY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fail(subject: string, detail: string): never {
  throw new ProductionProfileSnapshotError(`execution profile 快照 ${subject} ${detail}`);
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) fail(subject, "必须是 JSON 对象");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  subject: string,
  optional: readonly string[] = [],
): void {
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const extras = Object.keys(value).filter((key) => !expected.includes(key) && !optional.includes(key));
  if (missing.length || extras.length) {
    fail(subject, `字段无效（缺少：${missing.join("、") || "无"}；未知：${extras.join("、") || "无"}）`);
  }
}

function isoTimestamp(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(subject, "必须是 canonical UTC ISO 时间");
  }
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) fail(subject, "无效");
  return value as string;
}

function parsePriceTable(value: unknown, subject: string): ProductionGatewayPriceTable {
  if (value === null) return null;
  const row = record(value, subject);
  exactKeys(row, ["version", "basis", "currency", "microsPerOutputSecond", "priceAsOf", "source"], subject);
  if (row.version !== 1) fail(`${subject}.version`, "必须是 1");
  if (row.basis !== "tariff") fail(`${subject}.basis`, "v1 只支持 tariff 价目");
  if (row.currency !== "USD") fail(`${subject}.currency`, "必须是 USD");
  if (!Number.isSafeInteger(row.microsPerOutputSecond) || Number(row.microsPerOutputSecond) < 1) {
    fail(`${subject}.microsPerOutputSecond`, "必须是 >= 1 的安全整数");
  }
  if (typeof row.source !== "string" || row.source.length < 1 || row.source.length > 256
    || CONTROL.test(row.source)) {
    fail(`${subject}.source`, "必须是有界单行文本");
  }
  return Object.freeze({
    version: 1 as const,
    basis: "tariff" as const,
    currency: "USD" as const,
    microsPerOutputSecond: Number(row.microsPerOutputSecond),
    priceAsOf: isoTimestamp(row.priceAsOf, `${subject}.priceAsOf`),
    source: row.source as string,
  });
}

function parseDurationGrid(value: unknown, subject: string): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail(subject, "必须是 1–64 项时长数组");
  }
  const grid = value.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || Number(entry) < 1 || Number(entry) > 600) {
      fail(`${subject}[${index}]`, "必须是 1–600 秒的安全整数");
    }
    return Number(entry);
  });
  for (let index = 1; index < grid.length; index++) {
    if (grid[index] <= grid[index - 1]) fail(subject, "必须严格升序且不得重复");
  }
  return Object.freeze(grid);
}

function parseEntry(value: unknown, index: number): ProductionExecutionProfileSnapshotReadEntry {
  const subject = `profiles[${index}]`;
  const row = record(value, subject);
  exactKeys(row, [
    "version", "profileId", "profileDigest", "execution", "durationGrid", "priceTable",
    "license", "processingRegions",
  ], subject, ["limits"]);
  if (row.version !== 1) fail(`${subject}.version`, "必须是 1");
  if (typeof row.profileDigest !== "string" || !SHA256.test(row.profileDigest)) {
    fail(`${subject}.profileDigest`, "必须是 64 位小写 sha256");
  }
  let execution: ShotExecutionProfile;
  let license: ProductionExecutionProfileSnapshotEntry["license"];
  let processingRegions: readonly string[];
  let limits: VideoBackendLimits | undefined;
  try {
    execution = parseShotExecutionProfile(row.execution, `${subject}.execution`);
    license = parseProductionLicenseEvidence(row.license, `${subject}.license`);
    // 与 gateway 侧同一判据；两侧都规范化为升序去重，多地域 profile 的 digest 才能对上。
    processingRegions = parseProductionProcessingRegions(row.processingRegions, `${subject}.processingRegions`);
    if (row.limits !== undefined) {
      limits = parseVideoBackendLimits(row.limits, `${subject}.limits`);
    }
  } catch (error) {
    fail(subject, error instanceof Error ? error.message : String(error));
  }
  if (row.profileId !== execution.profileId) {
    fail(`${subject}.profileId`, "必须与 execution.profileId 相同");
  }
  const body = {
    version: 1 as const,
    profileId: execution.profileId,
    execution,
    durationGrid: parseDurationGrid(row.durationGrid, `${subject}.durationGrid`),
    priceTable: parsePriceTable(row.priceTable, `${subject}.priceTable`),
    license,
    processingRegions,
    ...(limits === undefined ? {} : { limits }),
  };
  // digest 由去掉该字段后的条目算出：快照被就地改过价目、时长档或许可即在此暴露。
  const digest = productionCanonicalJsonSha256(body);
  if (digest !== row.profileDigest) {
    fail(`${subject}.profileDigest`, `与条目内容不一致（重算 ${digest}）`);
  }
  return Object.freeze({ ...body, profileDigest: digest });
}

export function parseProductionExecutionProfileSnapshot(
  value: unknown,
): ProductionExecutionProfileSnapshotRead {
  const root = record(value, "");
  exactKeys(root, ["version", "kind", "casAuthority", "profiles"], "");
  if (root.version !== 1) fail("version", "必须是 1");
  if (root.kind !== PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND) {
    fail("kind", `必须是 ${PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND}`);
  }
  if (typeof root.casAuthority !== "string" || !CAS_AUTHORITY.test(root.casAuthority)) {
    fail("casAuthority", "必须是小写 CAS authority（如 wl-sg）");
  }
  if (!Array.isArray(root.profiles) || root.profiles.length < 1
    || root.profiles.length > MAX_PRODUCTION_PROFILE_SNAPSHOT_PROFILES) {
    fail("profiles", `必须包含 1–${MAX_PRODUCTION_PROFILE_SNAPSHOT_PROFILES} 项`);
  }
  const profiles = root.profiles.map(parseEntry);
  if (new Set(profiles.map((entry) => entry.profileId)).size !== profiles.length) {
    fail("profiles", "profileId 不得重复");
  }
  return Object.freeze({
    version: 1 as const,
    kind: PRODUCTION_EXECUTION_PROFILE_SNAPSHOT_KIND,
    casAuthority: root.casAuthority as string,
    profiles: Object.freeze(profiles),
  });
}

/**
 * Resolve the snapshot against the trusted runtime config file, mirroring `workflows[].file`: the
 * declared path is relative and `..`-free, no path component may be a symlink (checked before and
 * after the read), and the file itself must be an owner-only (0400/0600) single-link regular file
 * that does not change while it is read. The snapshot pins prices and duration tiers, so it gets
 * the same read discipline as the pinned graph, not a plain read.
 */
export function loadProductionExecutionProfileSnapshot(
  configFile: string,
  relativePath: string,
  maxBytes = MAX_PRODUCTION_PROFILE_SNAPSHOT_BYTES,
): ProductionExecutionProfileSnapshotRead {
  const parts = relativePath.split("/");
  if (isAbsolute(relativePath) || parts.some((part) => !part || part === "." || part === "..")) {
    fail("executionProfileSnapshotFile", "必须是无 .. 段的相对 POSIX 路径");
  }
  const configDirectory = join(resolve(configFile), "..");
  if (hasSymlinkComponent(configDirectory, parts)) {
    fail("路径", "不得包含 symlink component");
  }
  const file = join(configDirectory, relativePath);
  const text = readPrivateRegularTextExact(file, maxBytes);
  if (text === null || hasSymlinkComponent(configDirectory, parts)) {
    fail("文件", `必须是当前 euid 所有、mode 0400/0600、读取期间不变的单链接普通 UTF-8 文件，`
      + `且不超过 ${maxBytes} bytes：${file}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { fail("文件", `不是有效 JSON：${file}`); }
  return parseProductionExecutionProfileSnapshot(parsed);
}
