// Phase 2 项目立项服务：把 add-script 的 SCAFFOLD → REGISTER → 首票 → VERIFY
// 做成确定性、可测试的 plan/confirm/commit 边界。INTERVIEW 仍由人或 UI 收集答案；
// 本模块只接受完整答案，绝不用占位值猜操作者的战略/合规决定。
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readFileSync, readSync, realpathSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findOnPath, pkgVersion, pluginRoot } from "./paths.ts";
import { parseTicketFrontmatter, TICKET_STATES } from "./status.ts";
import { withWorkspaceConfigLock } from "./workspace-store.ts";
import {
  assertProjectKey, dataRoot, loadConfig, projectDataDir, projectEntries, resolveRepoPath, WsError,
  type WlConfig, type WlProject,
} from "./workspace.ts";

const FORMATS = new Set(["live-action", "ai-anime", "reelshort-en"]);
const MONETIZATION = new Set(["paid-app", "free-hongguo", "reelshort-sub"]);
const GENRES = new Set(["brain-hole", "revenge-slap", "profession-unit", "sweet-pet", "angst"]);
const INTAKE_MODES = new Set(["autonomous", "passive"]);
const PROJECT_MODES = new Set(["live", "dry-run"]);
const TICKET_PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;
const UNCALIBRATED = new Set(["sweet-pet", "angst"]);
const AGENTS = [
  "showrunner", "story-designer", "episode-writer", "reviewer", "evaluator",
  "script-doctor", "market-watch", "reflect", "sweep",
] as const;
const OWNER_MARKER = ".writing-loop-onboarding-owner.json";
const REPO_GIT_OWNER_MARKER = "writing-loop-onboarding-owner.json";
const TRANSACTION_DIR = ".onboarding-transactions";

type JsonObject = Record<string, unknown>;
export type OnboardingKind = "original" | "adaptation";
export type OnboardingInput = {
  key: string;
  title: string;
  repoPath: string;
  kind: OnboardingKind;
  logline: string;
  audience: string;
  complianceNotes: string;
  nonGoals: string[];
  genre: string;
  monetization: string;
  format: string;
  totalEpisodes: number;
  paywall: { card1: number[]; card2: number[]; card3: number[] };
  episodeWordBand: [number, number];
  maxPrimaryScenes: number;
  maxNamedCharacters: number;
  ticketPrefix: string;
  intakeMode: "autonomous" | "passive";
  mode: "live" | "dry-run";
  assetLibrary: string | null;
  marketDataPath: string | null;
  comparables: string | null;
  differentiation: string | null;
  adaptation: null | {
    rightsScope: string;
    compressionRatio: number;
    highlightCount: number;
    namedCharacterCount: number;
    riskAcknowledged: boolean;
  };
};

export type OnboardingPlan = {
  schemaVersion: 1;
  kind: "writing-loop/onboarding-plan";
  planId: string;
  workspaceRoot: string;
  configDigest: string;
  templateDigest: string;
  implementationVersion: string;
  input: OnboardingInput;
  projectConfig: WlProject;
  repoPath: string;
  configRepoPath: string;
  projectDataPath: string;
  outlineTicket: { id: string; title: string; state: "Todo"; path: string };
  files: string[];
  warnings: string[];
  requiresConfirmation: true;
};

export type OnboardingVerification = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

export type OnboardingResult = {
  planId: string;
  key: string;
  title: string;
  repoPath: string;
  projectDataPath: string;
  outlineTicketId: string;
  commit: string;
  createdAt: string;
  verification: OnboardingVerification;
};

export type OnboardingRuntime = {
  now?: () => Date;
  uuid?: () => string;
  /** Test seam used to prove a failure between promotions rolls the repo back. */
  afterRepoPromoted?: () => void;
  /** Test seam used to prove final-path reservation never replaces a concurrently planted target. */
  beforeRepoReservation?: () => void;
  /** Test seams for hard crashes after an owned final name is durably reserved but before scaffold completion. */
  afterRepoReserved?: () => void;
  afterDataReserved?: () => void;
  /** Test seam used to prove a failure before config publication rolls both directories back. */
  beforeConfigReplace?: () => void;
  /** Test seam at the irreversible config rename boundary, before the directory durability barrier. */
  afterConfigRenamed?: () => void;
  /** Test seam for a failed config parent-directory durability barrier after visible rename. */
  syncConfigDirectory?: (dir: string) => void;
  /** Test-only barrier after a dead lease inode is pinned and before quarantine reclaim. */
  afterStaleLeaseRead?: (file: string, pid: number) => void;
};

type OnboardingTransactionState =
  | "prepared"
  | "repo-staged"
  | "data-staged"
  | "repo-promoted"
  | "data-promoted";

type OnboardingTransactionJournal = {
  schemaVersion: 1;
  kind: "writing-loop/onboarding-transaction";
  transactionId: string;
  ownerPid: number;
  state: OnboardingTransactionState;
  planId: string;
  planDigest: string;
  inputDigest: string;
  plan: OnboardingPlan;
  repoStagePath: string;
  dataStagePath: string;
  createdAt: string;
  commit: string | null;
  dataDigest: string | null;
};

type OnboardingOwnerMarker = {
  schemaVersion: 1;
  kind: "writing-loop/onboarding-owner";
  artifact: "repo" | "data";
  transactionId: string;
  planId: string;
  targetPath: string;
};

export class OnboardingError extends WsError {
  constructor(message: string) { super(message); this.name = "OnboardingError"; }
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const errno = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
const record = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OnboardingError(`${label} 必须是 JSON 对象`);
  }
  return value as JsonObject;
};
const text = (obj: JsonObject, key: string, max = 1_000): string => {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) throw new OnboardingError(`${key} 必须是非空字符串`);
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length > max) throw new OnboardingError(`${key} 不能超过 ${max} 字符`);
  if (normalized.includes("\0")) throw new OnboardingError(`${key} 不能包含 NUL`);
  return normalized;
};
const oneLine = (obj: JsonObject, key: string, max: number): string => {
  const value = text(obj, key, max).replace(/\s+/g, " ");
  if (/\p{Cc}/u.test(value)) throw new OnboardingError(`${key} 不能包含控制字符`);
  return value;
};
const integer = (obj: JsonObject, key: string, min: number, max: number): number => {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new OnboardingError(`${key} 必须是 ${min}–${max} 的整数`);
  }
  return value;
};
const bool = (obj: JsonObject, key: string, fallback = false): boolean => {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new OnboardingError(`${key} 必须是 boolean`);
  return value;
};
const nullableText = (obj: JsonObject, key: string, max = 1_000): string | null => {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new OnboardingError(`${key} 必须是 null 或不超过 ${max} 字符的字符串`);
  }
  return value.trim() || null;
};
const stringList = (obj: JsonObject, key: string): string[] => {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new OnboardingError(`${key} 必须是字符串数组`);
  }
  const out = value.map((item) => String(item).trim()).filter(Boolean);
  if (out.length > 20 || out.some((item) => item.length > 240)) throw new OnboardingError(`${key} 最多 20 项、每项最多 240 字符`);
  return out;
};
const numberList = (value: unknown, label: string, fallback: number[], max = 300): number[] => {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)) {
    throw new OnboardingError(`${label} 必须是 1–${max} 的整数数组`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
};
const enumValue = <T extends string>(obj: JsonObject, key: string, allowed: Set<string>, fallback?: T): T => {
  const value = obj[key] ?? fallback;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new OnboardingError(`${key} 必须是 ${[...allowed].join(" | ")}`);
  }
  return value as T;
};

const defaultWordBand = (format: string): [number, number] =>
  format === "live-action" ? [900, 1_300] : format === "ai-anime" ? [550, 850] : [500, 800];

function normalizeInput(raw: unknown): OnboardingInput {
  const obj = record(raw, "立项输入");
  const key = oneLine(obj, "key", 32);
  assertProjectKey(key);
  const kind = enumValue<OnboardingKind>(obj, "kind", new Set(["original", "adaptation"]), "original");
  const format = enumValue<string>(obj, "format", FORMATS);
  const monetization = enumValue<string>(obj, "monetization", MONETIZATION);
  const genre = enumValue<string>(obj, "genre", GENRES);
  const audience = oneLine(obj, "audience", 240);
  const genderSignal = /(男|女|男性|女性|男频|女频|不限性别|全性别|men|women|all genders)/i.test(audience);
  const ageSignal = /(?:\d{1,2})\s*(?:-|–|—|~|至|到)\s*(?:\d{1,2})(?:\s*岁)?|(?:\d{1,2})\s*\+/i.test(audience);
  if (!genderSignal || !ageSignal) {
    throw new OnboardingError("audience 必须明确包含性别与年龄段（例如：女性 25-40 岁）");
  }
  const bandValue = obj.episodeWordBand;
  const band = bandValue === undefined ? defaultWordBand(format) : numberList(bandValue, "episodeWordBand", [], 10_000);
  if (band.length !== 2 || band[0] >= band[1]) throw new OnboardingError("episodeWordBand 必须是递增的两个整数");
  const paywallRaw = obj.paywall === undefined ? {} : record(obj.paywall, "paywall");
  const paywall = {
    card1: numberList(paywallRaw.card1, "paywall.card1", monetization === "paid-app" ? [9, 10, 11] : []),
    card2: numberList(paywallRaw.card2, "paywall.card2", monetization === "paid-app" ? [26, 28, 30] : []),
    card3: numberList(paywallRaw.card3, "paywall.card3", monetization === "paid-app" ? [60] : []),
  };
  if (monetization === "paid-app" && (!paywall.card1.length || paywall.card1.some((n) => n < 8 || n > 12))) {
    throw new OnboardingError("paid-app 的 paywall.card1 必须非空且全部位于 8–12 集");
  }
  const totalEpisodes = integer(obj, "totalEpisodes", 1, 300);
  for (const [card, values] of Object.entries(paywall)) {
    if (values.some((n) => n > totalEpisodes)) throw new OnboardingError(`paywall.${card} 不能超过 totalEpisodes`);
  }
  const ticketPrefix = obj.ticketPrefix === undefined ? "WL" : oneLine(obj, "ticketPrefix", 8);
  if (!TICKET_PREFIX.test(ticketPrefix)) throw new OnboardingError("ticketPrefix 必须匹配 /^[A-Z][A-Z0-9]{0,7}$/");

  let adaptation: OnboardingInput["adaptation"] = null;
  let comparables: string | null = null;
  let differentiation: string | null = null;
  if (kind === "original") {
    comparables = oneLine(obj, "comparables", 500);
    differentiation = oneLine(obj, "differentiation", 500);
  } else {
    const a = record(obj.adaptation, "adaptation");
    adaptation = {
      rightsScope: oneLine(a, "rightsScope", 1_000),
      compressionRatio: integer(a, "compressionRatio", 1, 1_000),
      highlightCount: integer(a, "highlightCount", 0, 1_000),
      namedCharacterCount: integer(a, "namedCharacterCount", 1, 1_000),
      riskAcknowledged: bool(a, "riskAcknowledged"),
    };
    const risky = adaptation.compressionRatio < 10 || adaptation.highlightCount < 3 || adaptation.namedCharacterCount > 20;
    if (risky && !adaptation.riskAcknowledged) {
      throw new OnboardingError("改编项目未满足压缩比≥10:1、S级名场面≥3、具名角色≤20；须显式 riskAcknowledged:true 才能继续");
    }
  }

  return {
    key,
    title: oneLine(obj, "title", 120),
    repoPath: text(obj, "repoPath", 1_000),
    kind,
    logline: oneLine(obj, "logline", 180),
    audience,
    complianceNotes: text(obj, "complianceNotes", 2_000),
    nonGoals: stringList(obj, "nonGoals"),
    genre,
    monetization,
    format,
    totalEpisodes,
    paywall,
    episodeWordBand: [band[0], band[1]],
    maxPrimaryScenes: integer(obj, "maxPrimaryScenes", 1, 100),
    maxNamedCharacters: integer(obj, "maxNamedCharacters", 1, 200),
    ticketPrefix,
    intakeMode: enumValue<"autonomous" | "passive">(obj, "intakeMode", INTAKE_MODES, "autonomous"),
    mode: enumValue<"live" | "dry-run">(obj, "mode", PROJECT_MODES, "live"),
    assetLibrary: nullableText(obj, "assetLibrary"),
    marketDataPath: nullableText(obj, "marketDataPath"),
    comparables,
    differentiation,
    adaptation,
  };
}

const within = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);

export const ONBOARDING_JOURNAL_MAX_BYTES = 1024 * 1024;
const OWNER_MARKER_BYTES = 16 * 1024;
const LEASE_BYTES = 4 * 1024;
const RECEIPT_BYTES = 256 * 1024;
const OUTLINE_HEAD_BYTES = 64 * 1024;

type BoundedRegularRead = {
  bytes: Buffer;
  size: number;
  dev: number;
  ino: number;
};

type DirectoryIdentity = { path: string; real: string; dev: number; ino: number };

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new OnboardingError(`${label} 必须是普通目录：${path}`);
  return { path, real: realpathSync(path), dev: info.dev, ino: info.ino };
}

function assertDirectoryIdentity(identity: DirectoryIdentity, label: string): void {
  const current = lstatSync(identity.path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
    || realpathSync(identity.path) !== identity.real) {
    throw new OnboardingError(`${label} 在 final reservation 前被替换：${identity.path}`);
  }
}

/**
 * Open a regular file without following its final component, pin the inode across pathname checks,
 * and read at most maxBytes. Callers that need a complete JSON document set requireComplete=true;
 * frontmatter callers may deliberately consume only a bounded head.
 */
function readBoundedRegular(
  file: string,
  maxBytes: number,
  label: string,
  options: { requireComplete?: boolean; allowedRootReal?: string } = {},
): BoundedRegularRead {
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new OnboardingError(`${label} 必须是单链接普通文件（拒绝 symlink/hardlink/FIFO/device）`);
    }
    const beforeReal = realpathSync(file);
    if (options.allowedRootReal && !within(options.allowedRootReal, beforeReal)) {
      throw new OnboardingError(`${label} 越出受管目录`);
    }
    fd = openSync(beforeReal,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
      throw new OnboardingError(`${label} 在打开期间被替换`);
    }
    if (options.requireComplete && opened.size > maxBytes) {
      throw new OnboardingError(`${label} 超过读取预算（${maxBytes} bytes）`);
    }
    const length = Math.min(opened.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(file);
    const afterReal = realpathSync(file);
    if (offset !== length || after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || current.dev !== opened.dev || current.ino !== opened.ino
      || current.nlink !== 1 || afterReal !== beforeReal
      || (options.allowedRootReal && !within(options.allowedRootReal, afterReal))) {
      throw new OnboardingError(`${label} 在读取期间发生变化`);
    }
    return { bytes: buffer.subarray(0, offset), size: opened.size, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(`${label} 无法安全读取：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 原始错误优先 */ }
  }
}

function readBoundedText(
  file: string,
  maxBytes: number,
  label: string,
  options: { requireComplete?: boolean; allowedRootReal?: string } = {},
): string {
  return readBoundedRegular(file, maxBytes, label, options).bytes.toString("utf8");
}

function assertProjectDataRoot(root: string, key: string): string {
  const parent = dataRoot(root);
  const parentReal = realpathSync(parent);
  const data = projectDataDir(root, key);
  const info = lstatSync(data);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OnboardingError(`项目 data 根必须是 .writing-loop 内的普通目录：${data}`);
  }
  const dataReal = realpathSync(data);
  if (dirname(dataReal) !== parentReal || basename(dataReal) !== key) {
    throw new OnboardingError(`项目 data 根越出 .writing-loop：${data}`);
  }
  return dataReal;
}

function resolveRepoTarget(
  root: string,
  repoInput: string,
  requireAbsent: boolean,
): { absolute: string; stored: string; external: boolean } {
  if (/\r|\n|\0/.test(repoInput)) throw new OnboardingError("repoPath 不能包含换行或 NUL");
  const rootReal = realpathSync(root);
  const absolute = resolve(root, repoInput);
  const parent = dirname(absolute);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new OnboardingError(`repoPath 的父目录必须先存在：${parent}`);
  }
  const parentReal = realpathSync(parent);
  const physical = join(parentReal, absolute.slice(parent.length).replace(/^[/\\]+/, ""));
  const state = realpathSync(join(rootReal, ".writing-loop"));
  if (physical === rootReal || within(physical, rootReal) || within(state, physical)) {
    throw new OnboardingError("repoPath 不能是 workspace 根、其祖先或 .writing-loop 内部");
  }
  if (!isAbsolute(repoInput) && !within(rootReal, physical)) {
    throw new OnboardingError("相对 repoPath 经符号链接解析后越出 workspace；外部仓请显式使用绝对路径");
  }
  if (requireAbsent && existsSync(physical)) {
    throw new OnboardingError(`repoPath 已存在：${physical}；自动立项 v1 只创建全新 repo，已有内容请继续使用 /writing-loop:add-script`);
  }
  const external = !within(rootReal, physical);
  return { absolute: physical, stored: external ? physical : relative(rootReal, physical) || ".", external };
}

const resolveNewRepo = (root: string, repoInput: string): { absolute: string; stored: string; external: boolean } =>
  resolveRepoTarget(root, repoInput, true);

function projectConfigFor(input: OnboardingInput, storedRepoPath: string): WlProject {
  return {
    title: input.title,
    repoPath: storedRepoPath,
    backend: "local",
    ticketPrefix: input.ticketPrefix,
    mode: input.mode,
    enabled: true,
    format: input.format,
    monetization: input.monetization,
    genre: input.genre,
    audience: input.audience,
    totalEpisodes: input.totalEpisodes,
    paywall: input.paywall,
    airedThrough: 0,
    episodeWordBand: input.episodeWordBand,
    maxNamedCharacters: input.maxNamedCharacters,
    maxPrimaryScenes: input.maxPrimaryScenes,
    assetLibrary: input.assetLibrary,
    marketDataPath: input.marketDataPath,
    intake: { mode: input.intakeMode, todoDepthCap: 10 },
    comms: { provider: null, webhookEnv: null },
  };
}

function planIdFor(plan: Pick<OnboardingPlan,
  "workspaceRoot" | "configDigest" | "templateDigest" | "implementationVersion" | "input"
  | "projectConfig" | "repoPath" | "projectDataPath" | "outlineTicket"
>): string {
  const core = {
    schemaVersion: 1,
    workspaceRoot: plan.workspaceRoot,
    configDigest: plan.configDigest,
    templateDigest: plan.templateDigest,
    implementationVersion: plan.implementationVersion,
    input: plan.input,
    projectConfig: plan.projectConfig,
    repoPath: plan.repoPath,
    projectDataPath: plan.projectDataPath,
    outlineTicketId: plan.outlineTicket.id,
  };
  return `wlplan_${hash(JSON.stringify(core)).slice(0, 24)}`;
}

function usualEpisodeWarning(format: string, monetization: string, total: number): string | null {
  if (format === "ai-anime" && (total < 36 || total > 60)) return "AI 漫剧通常为 36–60 集；本计划采用了操作者确认的越界规模。";
  if (format === "reelshort-en" && (total < 60 || total > 80)) return "出海英文短剧通常为 60–80 集；本计划采用了操作者确认的越界规模。";
  if (format === "live-action" && monetization === "paid-app" && (total < 80 || total > 100)) return "付费真人短剧通常为 80–100 集；本计划采用了操作者确认的越界规模。";
  if (format === "live-action" && monetization === "free-hongguo" && total < 80) return "免费真人短剧通常为 80 集以上；本计划采用了操作者确认的越界规模。";
  return null;
}

function planFiles(input: OnboardingInput): string[] {
  const files = [
    "README.md", "bible/north-star.md", "bible/characters.md", "bible/world.md", "outline.md",
    "ledgers/foreshadow.md", "ledgers/story-state.md", "ledgers/production.md",
    "arcs/.gitkeep", "episodes/.gitkeep", "evaluation/.gitkeep", "ledgers/archive/.gitkeep",
  ];
  if (input.kind === "original") files.push("source/benchmarks.md");
  else files.push("source/mainline.md", "source/highlights.md", "source/characters-function.md");
  return files;
}

function onboardingTemplateDigest(): string {
  const names = [
    "north-star.md", "characters.md", "world.md", "outline.md", "foreshadow-ledger.md",
    "story-state.md", "production-ledger.md", "deconstruction/README.md",
  ];
  return hash(names.map((name) => `${name}\0${template(name)}`).join("\0"));
}

export function planOnboarding(root: string, raw: unknown): OnboardingPlan {
  const ws = loadConfig(root);
  const input = normalizeInput(raw);
  const projects = projectsObject(ws.config);
  const entries = onboardingProjectEntries(ws.config);
  if (Object.prototype.hasOwnProperty.call(projects ?? {}, input.key)) throw new OnboardingError(`项目 key '${input.key}' 已存在`);
  for (const [key, project] of entries) {
    if (project.ticketPrefix === input.ticketPrefix) {
      throw new OnboardingError(`ticketPrefix '${input.ticketPrefix}' 已被项目 '${key}' 使用；请显式选择其他前缀`);
    }
  }
  const repo = resolveNewRepo(root, input.repoPath);
  for (const [key, project] of entries) {
    if (resolve(resolveRepoPath(root, project)) === repo.absolute) throw new OnboardingError(`repoPath 已由项目 '${key}' 注册`);
  }
  const dataPath = projectDataDir(root, input.key);
  if (existsSync(dataPath)) throw new OnboardingError(`项目运行态目录已存在：${dataPath}`);
  if (!findOnPath("git")) throw new OnboardingError("PATH 中找不到 git，无法创建可验证的首个 scaffold commit");

  const configRaw = readFileSync(join(dataRoot(root), "config.json"), "utf8");
  const configDigest = hash(configRaw);
  const templateDigest = onboardingTemplateDigest();
  const implementationVersion = pkgVersion() || "source";
  const projectConfig = projectConfigFor(input, repo.stored);
  const ticketId = `${input.ticketPrefix}-1`;
  const warnings: string[] = [];
  if (repo.external) warnings.push("repoPath 位于 workspace 外部：整体复制 workspace 时不会随之迁移。");
  if (UNCALIBRATED.has(input.genre)) warnings.push(`genre '${input.genre}' 尚未校准，后续质量参数必须经过 evaluator/操作者确认。`);
  const episodeWarning = usualEpisodeWarning(input.format, input.monetization, input.totalEpisodes);
  if (episodeWarning) warnings.push(episodeWarning);
  if (input.adaptation && (input.adaptation.compressionRatio < 10 || input.adaptation.highlightCount < 3 || input.adaptation.namedCharacterCount > 20)) {
    warnings.push("改编三阈值未全部满足；操作者已显式确认风险，风险数据会写入 source 与 Non-goals。");
  }
  const plan: OnboardingPlan = {
    schemaVersion: 1,
    kind: "writing-loop/onboarding-plan",
    planId: "",
    workspaceRoot: realpathSync(root),
    configDigest,
    templateDigest,
    implementationVersion,
    input,
    projectConfig,
    repoPath: repo.absolute,
    configRepoPath: repo.stored,
    projectDataPath: dataPath,
    outlineTicket: {
      id: ticketId,
      title: `完成《${input.title}》总大纲与冻结层`,
      state: "Todo",
      path: join(dataPath, "board", "tickets", `${ticketId}.md`),
    },
    files: planFiles(input),
    warnings,
    requiresConfirmation: true,
  };
  plan.planId = planIdFor(plan);
  return plan;
}

const replaceAll = (source: string, values: Record<string, string>): string => {
  let out = source;
  for (const [key, value] of Object.entries(values)) out = out.split(key).join(value);
  return out;
};

const template = (name: string): string => readFileSync(join(pluginRoot(), "templates", name), "utf8");
const writeNew = (file: string, body: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body.endsWith("\n") ? body : body + "\n", { encoding: "utf8", flag: "wx" });
};

function renderNorthStar(input: OnboardingInput): string {
  const freeEpisodes = input.paywall.card1.length ? Math.max(0, Math.min(...input.paywall.card1) - 1) : input.totalEpisodes;
  let raw = replaceAll(template("north-star.md"), {
    "{片名}": input.title,
    "{N}": String(input.totalEpisodes),
    "{M}": String(freeEpisodes),
    "主场景 ≤5": `主场景 ≤${input.maxPrimaryScenes}`,
    "具名角色 ≤20": `具名角色 ≤${input.maxNamedCharacters}`,
  });
  raw = raw.replace(/(## 一句话故事（Vision）\n)/, `$1${input.logline}\n`);
  raw = raw.replace(/^- 题材标签：.*$/m, `- 题材标签：${input.genre}`);
  raw = raw.replace(/^- 目标受众画像：.*$/m, `- 目标受众画像：${input.audience}`);
  raw = raw.replace(/^- 对标剧：.*$/m, `- 对标剧：${input.kind === "original" ? input.comparables : "授权原著；拆书清单见 source/"}`);
  raw = raw.replace(/^- format profile：.*$/m, `- format profile：${input.format}`);
  const nonGoals = [
    `- 合规预筛：${input.complianceNotes.replace(/\s+/g, " ")}`,
    ...(input.kind === "adaptation" ? ["- 忠实度默认贴改；借壳改编禁用；只使用授权范围内素材。"] : []),
    ...input.nonGoals.map((item) => `- ${item}`),
  ].join("\n");
  raw = raw.replace(/(## 创作红线（Non-goals）\n)/, `$1${nonGoals}\n`);
  return raw;
}

function renderRepoReadme(plan: OnboardingPlan): string {
  return `# 《${plan.input.title}》创作仓库

> writing-loop 项目 \`${plan.input.key}\` · ${plan.input.kind === "original" ? "原创" : "小说改编"} · ${plan.input.format}

${plan.input.logline}

## 文档索引

| 路径 | 用途 | 维护与门禁 |
|---|---|---|
| \`bible/north-star.md\` | 方向、受众、红线与当前进度 | showrunner；方向级变更需操作者批准 |
| \`bible/characters.md\` / \`world.md\` | 人物与世界冻结层 | showrunner / 大纲门内的 story-designer |
| \`outline.md\` | 全剧结构、卡点与主线伏笔 | story-designer 起草，showrunner + evaluator 过门 |
| \`arcs/\` | 单元细纲与逐集节拍 | 大纲门 |
| \`episodes/\` | 分集正文 | writer → reviewer → evaluator |
| \`ledgers/\` | 伏笔、故事状态、制作预算 | 与正文同批更新并经审读核对 |
| \`evaluation/\` | 里程碑评估与 superseded 历史 | evaluator；文件名含片名与里程碑 |
| \`source/\` | 对标拆解或授权原著拆书清单 | 只作证据，不混入未授权 IP |

运行态、看板与报告不进 Git，位于：

\`${join(plan.workspaceRoot, ".writing-loop", plan.input.key)}\`

市场评估的固定证据路径：

\`${join(plan.workspaceRoot, ".writing-loop", plan.input.key, "state", "market-assessment.md")}\`
`;
}

function scaffoldSource(repoStage: string, input: OnboardingInput): void {
  if (input.kind === "original") {
    writeNew(join(repoStage, "source", "benchmarks.md"), `# 对标剧轻量拆解

- 对标：${input.comparables}
- 差异化：${input.differentiation}

## 结构骨架

<!-- 只记录可验证结构，不复制受版权保护的正文。 -->

## 爽点与钩型序列

<!-- 由 market-watch/story-designer 补充来源与证据。 -->
`);
    return;
  }
  const a = input.adaptation!;
  const preface = `> 授权范围：${a.rightsScope}\n> 立项阈值：压缩比 ${a.compressionRatio}:1 · S级名场面 ${a.highlightCount} · 具名角色 ${a.namedCharacterCount}\n`;
  writeNew(join(repoStage, "source", "mainline.md"), `# 主线骨架\n\n${preface}\n| # | 主线事件 | 原著章节 | 保留/压缩/删除 | 目标集区间 |\n|---|---|---|---|---|\n`);
  writeNew(join(repoStage, "source", "highlights.md"), `# 爽点名场面清单\n\n${preface}\n| # | 名场面 | 原著章节 | 爽点类型 | 对齐目标 | 视听翻译方案 |\n|---|---|---|---|---|---|\n`);
  writeNew(join(repoStage, "source", "characters-function.md"), `# 人物功能表\n\n${preface}\n| 原著角色 | 功能 | 处置（保留/合并/删除） | 剧中定位 |\n|---|---|---|---|\n`);
}

function scaffoldRepo(stage: string, plan: OnboardingPlan): void {
  const input = plan.input;
  const values = {
    "{片名}": input.title,
    "{config.maxPrimaryScenes}": String(input.maxPrimaryScenes),
    "{config.maxNamedCharacters}": String(input.maxNamedCharacters),
    "{live-action | ai-anime | reelshort-en}": input.format,
    "{NNN}": "000",
    "{NN}": "00",
    "{N}": String(input.totalEpisodes),
    "{8-9}": String(input.paywall.card1[0] ?? 9),
    "{9-10}": String(input.paywall.card1[1] ?? input.paywall.card1[0] ?? 10),
    "{10-11}": String(input.paywall.card1[2] ?? input.paywall.card1.at(-1) ?? 11),
    "{9/10/11}": input.paywall.card1.join("/") || "无硬卡点",
    "{26-30}": input.paywall.card2.join("/") || "无硬卡点",
    "{~60}": input.paywall.card3.join("/") || "无硬卡点",
  };
  mkdirSync(stage, { recursive: true });
  writeNew(join(stage, "README.md"), renderRepoReadme(plan));
  writeNew(join(stage, "bible", "north-star.md"), renderNorthStar(input));
  for (const [source, target] of [
    ["characters.md", "bible/characters.md"],
    ["world.md", "bible/world.md"],
    ["outline.md", "outline.md"],
    ["foreshadow-ledger.md", "ledgers/foreshadow.md"],
    ["story-state.md", "ledgers/story-state.md"],
    ["production-ledger.md", "ledgers/production.md"],
  ] as const) {
    writeNew(join(stage, ...target.split("/")), replaceAll(template(source), values));
  }
  for (const dir of ["arcs", "episodes", "evaluation", "ledgers/archive"]) {
    writeNew(join(stage, ...dir.split("/"), ".gitkeep"), "");
  }
  scaffoldSource(stage, input);
}

function outlineTicket(plan: OnboardingPlan, createdAt: string): string {
  const input = plan.input;
  const facts = [
    `- genre=${input.genre}（config.json）`,
    `- monetization=${input.monetization}；paywall=${JSON.stringify(input.paywall)}（config.json）`,
    `- format=${input.format}；总集数=${input.totalEpisodes}（config.json）`,
    `- 合规预筛：${input.complianceNotes.replace(/\s+/g, " ")}（bible/north-star.md#创作红线）`,
  ].join("\n");
  const adaptation = input.kind === "adaptation"
    ? "\n- 对照 source/highlights.md 完成名场面-卡点对齐表；只读拆书三清单，不读/复制原著全文。"
    : "\n- 对照 source/benchmarks.md 的结构与差异化证据。";
  return `---
id: ${plan.outlineTicket.id}
title: ${JSON.stringify(plan.outlineTicket.title)}
type: Feature
state: Todo
owner: showrunner
assignee: null
labels: [writing-loop, Feature, outline, showrunner, story-designer]
priority: 1
relatedTo: []
duplicateOf: null
created: ${createdAt}
updated: ${createdAt}
---
## Context

北极星与空白创作骨架已由立项服务建立。第一步是完成 \`outline.md\`，并补齐
\`bible/characters.md\` 与 \`bible/world.md\` 的冻结层；showrunner 只验收，不自领起草。

## Context-pack

必读（≤8 指针）：\`bible/north-star.md\` 全文、\`outline.md\`、\`bible/characters.md\`、
\`bible/world.md\`、\`ledgers/production.md\`、\`source/\` 下的结构化拆解。

关键事实：
${facts}${adaptation}

## Acceptance criteria

- outline 分段大纲、单元表、高潮五锚点、卡点规划完整。
- 主线伏笔登记表含必备四件套，名场面与续季钩有明确规划。
- characters/world 冻结层补齐，制作预算不超过 config 上限。
- 另 file milestone-eval 大纲定稿门，并以 Blocked-by 建立前置关系。

## How to verify

showrunner 做结构预审；evaluator 通过大纲定稿门后才能进入分集写作。

---
## Comments
### ${createdAt} — add-script
立项服务创建首张大纲票；下一步运行 /showrunner-agent。
`;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    const evidence = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-800);
    throw new OnboardingError(`git ${args[0]} 失败${evidence ? `：${evidence}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function initializeGitRepo(stage: string, key: string): string {
  runGit(stage, ["init", "--quiet"]);
  // 所有权标记留在 .git 私有元数据中，不进入 scaffold commit；发布 config 后再清理。
  renameSync(join(stage, OWNER_MARKER), join(stage, ".git", REPO_GIT_OWNER_MARKER));
  runGit(stage, ["add", "--all"]);
  runGit(stage, [
    "-c", "user.name=writing-loop", "-c", "user.email=writing-loop@local",
    "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", `chore(scaffold): 立项 ${key}`,
  ]);
  return runGit(stage, ["rev-parse", "HEAD"]);
}

function scaffoldData(stage: string, plan: OnboardingPlan, createdAt: string, commit: string): void {
  const tickets = join(stage, "board", "tickets");
  mkdirSync(tickets, { recursive: true });
  writeNew(join(stage, "board", "counter.json"), JSON.stringify({ prefix: plan.input.ticketPrefix, next: 2 }, null, 2));
  writeNew(join(tickets, `${plan.outlineTicket.id}.md`), outlineTicket(plan, createdAt));
  mkdirSync(join(stage, "reports"), { recursive: true });
  writeNew(join(stage, "reports", "daily.md"), `# Daily\n\n- ${createdAt} · add-script · 完成立项与 scaffold commit ${commit.slice(0, 12)} · 首票 ${plan.outlineTicket.id} · NEXT /showrunner-agent`);
  mkdirSync(join(stage, "state"), { recursive: true });
  mkdirSync(join(stage, "lessons"), { recursive: true });
  writeNew(join(stage, "lessons", "shared.md"), "# Shared lessons\n\n<!-- 仅 reflect 可写。 -->");
  for (const agent of AGENTS) writeNew(join(stage, "lessons", `${agent}.md`), `# ${agent} lessons\n\n<!-- 仅 reflect 可写。 -->`);
  const event = {
    version: 1,
    id: `project.created:${plan.planId}`,
    type: "project.created",
    at: createdAt,
    actor: "operator",
    title: `立项《${plan.input.title}》`,
    detail: `scaffold ${commit.slice(0, 12)} · 首票 ${plan.outlineTicket.id}`,
    metadata: { planId: plan.planId, commit, ticketId: plan.outlineTicket.id },
  };
  writeNew(join(stage, "events.jsonl"), JSON.stringify(event));
  writeNew(join(stage, "state", "onboarding.json"), JSON.stringify({
    schemaVersion: 1,
    planId: plan.planId,
    key: plan.input.key,
    ticketPrefix: plan.input.ticketPrefix,
    outlineTicketId: plan.outlineTicket.id,
    createdAt,
    commit,
    projectConfig: plan.projectConfig,
    repoPath: plan.repoPath,
    configDigest: plan.configDigest,
    templateDigest: plan.templateDigest,
    input: plan.input,
  }, null, 2));
}

const projectsObject = (config: WlConfig): Record<string, WlProject> => {
  if (config.projects === null || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    throw new OnboardingError("config.json 的 projects 必须是 JSON 对象");
  }
  return config.projects ?? {};
};

function onboardingProjectEntries(config: WlConfig): Array<[string, WlProject]> {
  projectsObject(config);
  try { return projectEntries(config); }
  catch (error) {
    throw new OnboardingError(error instanceof Error ? error.message : String(error));
  }
}

const transactionDir = (root: string): string => join(dataRoot(root), TRANSACTION_DIR);
const transactionJournalPath = (root: string, key: string): string => join(transactionDir(root), `${key}.json`);
const transactionLeasePath = (root: string, key: string): string => join(transactionDir(root), `${key}.lock`);

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new OnboardingError(`durability 目标不是普通目录：${path}`);
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new OnboardingError(`durability 目录在打开期间被替换：${path}`);
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 原始错误优先 */ }
  }
}

/** Flush a newly-created bounded tree bottom-up before its durable journal state advances. */
function syncOwnedTree(root: string): void {
  let entries = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 64) throw new OnboardingError("受管产物的目录深度超过 durability 预算（64）");
    const handle = opendirSync(dir);
    const names: string[] = [];
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        entries++;
        if (entries > 8_192) throw new OnboardingError("受管产物超过 durability 预算（8192 entries）");
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    names.sort();
    for (const name of names) {
      const path = join(dir, name);
      const before = lstatSync(path);
      if (before.isSymbolicLink()) throw new OnboardingError(`受管产物不能包含符号链接：${path}`);
      if (before.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!before.isFile()) throw new OnboardingError(`受管产物只能包含普通文件或目录：${path}`);
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new OnboardingError(`受管文件在 durability flush 前被替换：${path}`);
        }
        fsyncSync(fd);
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* 原始错误优先 */ }
      }
    }
    syncDirectory(dir);
  };
  visit(root, 0);
  syncDirectory(dirname(root));
}

function ensureTransactionDir(root: string): string {
  const dir = transactionDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new OnboardingError(`立项事务目录不是普通目录：${dir}`);
  }
  return dir;
}

function atomicWriteJournal(file: string, journal: OnboardingTransactionJournal): void {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 原始错误优先 */ }
    if (existsSync(temp)) try { unlinkSync(temp); } catch { /* 原始错误优先 */ }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return errno(error) !== "ESRCH"; }
}

function readLeasePid(file: string): { pid: number; dev: number; ino: number } {
  try {
    const read = readBoundedRegular(file, LEASE_BYTES, "立项事务锁", { requireComplete: true });
    const value = JSON.parse(read.bytes.toString("utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) throw new OnboardingError(`立项事务锁缺少有效 PID：${file}`);
    return { pid: Number(value.pid), dev: read.dev, ino: read.ino };
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(`无法读取立项事务锁 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function unlinkSameFile(file: string, identity: { dev: number; ino: number; pid?: number }): boolean {
  const dir = dirname(file);
  const quarantine = join(dir, `.${basename(file)}.unlink-${process.pid}-${randomUUID()}`);
  let moved = false;
  try {
    // rename first: validation and deletion now target an unpredictable quarantine name rather than
    // a pathname that a successor can replace between lstat and unlink.
    renameSync(file, quarantine);
    moved = true;
    const current = lstatSync(quarantine);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new OnboardingError(`锁在回收前已被 successor 替换：${file}`);
    }
    if (identity.pid !== undefined && readLeasePid(quarantine).pid !== identity.pid) {
      throw new OnboardingError(`锁内容在回收前已变化：${file}`);
    }
    unlinkSync(quarantine);
    moved = false;
    syncDirectory(dir);
    return true;
  } catch {
    // Mismatch is fail-closed: restore the moved inode only when the original name is still free.
    // If a successor already owns that name, preserve quarantine evidence and never delete either.
    if (moved && existsSync(quarantine) && !existsSync(file)) {
      try {
        renameSync(quarantine, file);
        moved = false;
        syncDirectory(dir);
      } catch { /* caller receives false and stops after bounded retries */ }
    }
    return false;
  }
}

function acquireTransactionLease(root: string, key: string, runtime: OnboardingRuntime = {}): () => void {
  const dir = ensureTransactionDir(root);
  const file = transactionLeasePath(root, key);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(file, "wx", 0o600);
      const identity = fstatSync(fd);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
      fsyncSync(fd);
      syncDirectory(dir);
      return () => {
        try { unlinkSameFile(file, { dev: identity.dev, ino: identity.ino }); } catch { /* no-op */ }
        try { closeSync(fd!); } catch { /* no-op */ }
      };
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* no-op */ }
      if (errno(error) !== "EEXIST") {
        throw error instanceof OnboardingError
          ? error
          : new OnboardingError(`无法取得立项事务锁 ${file}：${error instanceof Error ? error.message : String(error)}`);
      }
      const stale = readLeasePid(file);
      if (processIsAlive(stale.pid)) {
        throw new OnboardingError(`项目 '${key}' 的立项事务仍由 PID ${stale.pid} 执行；拒绝并发接管`);
      }
      runtime.afterStaleLeaseRead?.(file, stale.pid);
      if (!unlinkSameFile(file, stale)) continue;
    }
  }
  throw new OnboardingError(`无法安全接管项目 '${key}' 的崩溃事务锁；请检查 ${file}`);
}

function removeCrashedConfigLock(root: string, expectedPid: number): void {
  if (expectedPid === process.pid || processIsAlive(expectedPid)) return;
  const file = join(dataRoot(root), "config.json.lock");
  if (!existsSync(file)) return;
  let lock: { pid: number; dev: number; ino: number };
  try { lock = readLeasePid(file); }
  catch (error) {
    throw new OnboardingError(`崩溃恢复不能证明配置锁归本事务所有：${error instanceof Error ? error.message : String(error)}`);
  }
  if (lock.pid !== expectedPid) {
    throw new OnboardingError(`配置锁属于 PID ${lock.pid}，而崩溃事务记录 PID ${expectedPid}；拒绝删除他人锁`);
  }
  if (!unlinkSameFile(file, lock)) {
    throw new OnboardingError(`配置锁在恢复检查期间被替换；拒绝接管 ${file}`);
  }
}

function parseJournal(file: string): OnboardingTransactionJournal {
  let value: unknown;
  try {
    value = JSON.parse(readBoundedText(file, ONBOARDING_JOURNAL_MAX_BYTES, "立项 journal", { requireComplete: true }));
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(`立项 journal 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const journal = record(value, "立项 journal") as OnboardingTransactionJournal;
  const states = new Set<OnboardingTransactionState>([
    "prepared", "repo-staged", "data-staged", "repo-promoted", "data-promoted",
  ]);
  if (journal.schemaVersion !== 1 || journal.kind !== "writing-loop/onboarding-transaction"
    || typeof journal.transactionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(journal.transactionId)
    || !Number.isInteger(journal.ownerPid) || journal.ownerPid <= 0
    || typeof journal.state !== "string" || !states.has(journal.state)
    || typeof journal.planId !== "string" || typeof journal.planDigest !== "string"
    || typeof journal.inputDigest !== "string" || typeof journal.createdAt !== "string"
    || (journal.commit !== null && (typeof journal.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(journal.commit)))
    || (journal.dataDigest !== null && (typeof journal.dataDigest !== "string" || !/^[0-9a-f]{64}$/i.test(journal.dataDigest)))
    || typeof journal.repoStagePath !== "string" || typeof journal.dataStagePath !== "string") {
    throw new OnboardingError(`立项 journal 结构无效：${file}`);
  }
  return journal;
}

function assertJournalMatches(
  root: string,
  journal: OnboardingTransactionJournal,
  requested: OnboardingInput,
  confirmation: string,
  allowPublishedConfig = false,
): OnboardingPlan {
  const plan = journal.plan;
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== "writing-loop/onboarding-plan") {
    throw new OnboardingError("立项 journal 中的 plan 结构无效");
  }
  if (confirmation !== journal.planId || confirmation !== plan.planId) {
    throw new OnboardingError("检测到未完成的立项事务；只能用原确认指纹重试");
  }
  const requestedDigest = hash(JSON.stringify(requested));
  if (journal.inputDigest !== requestedDigest || JSON.stringify(plan.input) !== JSON.stringify(requested)) {
    throw new OnboardingError("检测到未完成的立项事务；只能用完全相同的规范化输入重试");
  }
  if (journal.planDigest !== hash(JSON.stringify(plan)) || planIdFor(plan) !== plan.planId) {
    throw new OnboardingError("立项 journal 的 plan 指纹校验失败；拒绝恢复");
  }
  const rootReal = realpathSync(root);
  const repo = resolveRepoTarget(root, requested.repoPath, false);
  const expectedData = projectDataDir(root, requested.key);
  const expectedRepoStage = join(dirname(repo.absolute), `.writing-loop-onboard-${requested.key}-${journal.transactionId}`);
  const expectedDataStage = join(dataRoot(root), `.onboarding-${requested.key}-${journal.transactionId}`);
  const expectedProject = projectConfigFor(requested, repo.stored);
  const expectedFiles = planFiles(requested);
  if (plan.workspaceRoot !== rootReal || plan.repoPath !== repo.absolute || plan.configRepoPath !== repo.stored
    || plan.projectDataPath !== expectedData || journal.repoStagePath !== expectedRepoStage
    || journal.dataStagePath !== expectedDataStage || plan.outlineTicket.id !== `${requested.ticketPrefix}-1`
    || plan.outlineTicket.path !== join(expectedData, "board", "tickets", `${requested.ticketPrefix}-1.md`)
    || JSON.stringify(plan.projectConfig) !== JSON.stringify(expectedProject)
    || JSON.stringify(plan.files) !== JSON.stringify(expectedFiles)) {
    throw new OnboardingError("立项 journal 的受管路径或计划内容与当前请求不一致；拒绝恢复");
  }
  if (onboardingTemplateDigest() !== plan.templateDigest
    || (pkgVersion() || "source") !== plan.implementationVersion) {
    throw new OnboardingError("立项实现或模板在崩溃后已变化；为避免发布混合版本产物，拒绝自动恢复");
  }
  const configRaw = readFileSync(join(dataRoot(root), "config.json"), "utf8");
  if (!allowPublishedConfig && hash(configRaw) !== plan.configDigest) {
    throw new OnboardingError("立项崩溃后 config.json 已变化；只能保留 journal 并由操作者审计，拒绝基于旧计划发布");
  }
  return plan;
}

function ownerMarker(journal: OnboardingTransactionJournal, artifact: "repo" | "data"): OnboardingOwnerMarker {
  return {
    schemaVersion: 1,
    kind: "writing-loop/onboarding-owner",
    artifact,
    transactionId: journal.transactionId,
    planId: journal.planId,
    targetPath: artifact === "repo" ? journal.plan.repoPath : journal.plan.projectDataPath,
  };
}

function createOwnedStage(path: string, marker: OnboardingOwnerMarker): void {
  if (existsSync(path)) throw new OnboardingError(`立项临时目录碰撞：${path}`);
  mkdirSync(path);
  try { writeNew(join(path, OWNER_MARKER), JSON.stringify(marker, null, 2)); }
  catch (error) {
    try { rmSync(path); } catch { /* 目录不再为空时绝不递归删除 */ }
    throw error;
  }
}

function reserveOwnedFinal(
  path: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
  parent: DirectoryIdentity,
): void {
  assertDirectoryIdentity(parent, `${artifact} parent`);
  createOwnedStage(path, ownerMarker(journal, artifact));
  try {
    assertDirectoryIdentity(parent, `${artifact} parent`);
    const expectedReal = join(parent.real, basename(path));
    if (realpathSync(path) !== expectedReal) throw new OnboardingError(`${artifact} final reservation 越出已固定 parent：${path}`);
  } catch (error) {
    try { safelyRemoveOwned(path, artifact, journal, false); }
    catch (cleanupError) {
      throw new OnboardingError(`${error instanceof Error ? error.message : String(error)}；reservation 回滚未完成：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw error;
  }
}

function assertPlainDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new OnboardingError(`受管产物不是普通目录：${path}`);
}

function readOwnerMarker(
  path: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
): string {
  assertPlainDirectory(path);
  const candidates = artifact === "repo"
    ? [join(path, OWNER_MARKER), join(path, ".git", REPO_GIT_OWNER_MARKER)]
    : [join(path, OWNER_MARKER)];
  const found = candidates.filter((candidate) => existsSync(candidate));
  if (found.length !== 1) throw new OnboardingError(`无法唯一证明 ${path} 属于当前立项事务`);
  let marker: unknown;
  try {
    marker = JSON.parse(readBoundedText(found[0], OWNER_MARKER_BYTES, "立项所有权标记", {
      requireComplete: true,
      allowedRootReal: realpathSync(path),
    }));
  }
  catch { throw new OnboardingError(`立项所有权标记无法解析：${found[0]}`); }
  if (JSON.stringify(marker) !== JSON.stringify(ownerMarker(journal, artifact))) {
    throw new OnboardingError(`产物所有权标记与当前事务不匹配：${path}`);
  }
  return found[0];
}

function removeOwnerMarkerIfPresent(
  path: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
): void {
  const candidates = artifact === "repo"
    ? [join(path, OWNER_MARKER), join(path, ".git", REPO_GIT_OWNER_MARKER)]
    : [join(path, OWNER_MARKER)];
  if (!candidates.some((candidate) => existsSync(candidate))) return;
  const marker = readOwnerMarker(path, artifact, journal);
  unlinkSync(marker);
  syncDirectory(dirname(marker));
}

function assertReservationOnly(
  path: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
): void {
  const marker = readOwnerMarker(path, artifact, journal);
  const entries = readdirSync(path).sort();
  if (entries.length !== 1 || join(path, entries[0]) !== marker) {
    throw new OnboardingError(`受管 ${artifact} 尚无完整摘要且包含无法证明归属的内容；保留现场：${path}`);
  }
}

function assertOwnedRepo(path: string, journal: OnboardingTransactionJournal, complete: boolean): string | null {
  if (!complete) {
    assertReservationOnly(path, "repo", journal);
    return null;
  }
  readOwnerMarker(path, "repo", journal);
  const head = runGit(path, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/i.test(head) || (journal.commit !== null && head !== journal.commit)) {
    throw new OnboardingError(`受管 repo 的 HEAD 与 journal 不匹配：${path}`);
  }
  if (runGit(path, ["rev-list", "--count", "HEAD"]) !== "1" || runGit(path, ["status", "--porcelain"]) !== "") {
    throw new OnboardingError(`受管 repo 已在崩溃后被修改；拒绝自动恢复：${path}`);
  }
  const tracked = runGit(path, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const expected = [...journal.plan.files].sort();
  if (JSON.stringify(tracked) !== JSON.stringify(expected)) {
    throw new OnboardingError(`受管 repo 的 scaffold 文件集合与 plan 不匹配：${path}`);
  }
  return head;
}

function managedDataDigest(root: string): string {
  const digest = createHash("sha256");
  const rootReal = realpathSync(root);
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (depth > 64) throw new OnboardingError("受管 data 的目录深度超过恢复审计预算（64）");
    const names: string[] = [];
    const handle = opendirSync(dir);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        entries++;
        if (entries > 2_048) throw new OnboardingError("受管 data 超过恢复审计预算（2048 entries）");
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    names.sort();
    for (const name of names) {
      if (!prefix && name === OWNER_MARKER) continue;
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (Buffer.byteLength(rel) > 4_096) throw new OnboardingError("受管 data 的相对路径超过恢复审计预算（4096 bytes）");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new OnboardingError(`受管 data 不能包含符号链接：${rel}`);
      if (info.isDirectory()) {
        digest.update(`D\0${rel.length}\0${rel}\0`);
        visit(path, rel, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new OnboardingError(`受管 data 只能包含普通文件或目录：${rel}`);
      files++;
      if (files > 2_048 || info.size > 4 * 1024 * 1024 || bytes + info.size > 32 * 1024 * 1024) {
        throw new OnboardingError("受管 data 超过恢复审计预算（2048 files / 4 MiB each / 32 MiB total）");
      }
      const read = readBoundedRegular(path, 4 * 1024 * 1024, `受管 data 文件 ${rel}`, {
        requireComplete: true,
        allowedRootReal: rootReal,
      });
      bytes += read.size;
      if (bytes > 32 * 1024 * 1024) throw new OnboardingError("受管 data 超过恢复审计预算（32 MiB total）");
      digest.update(`F\0${rel.length}\0${rel}\0${read.bytes.length}\0`);
      digest.update(read.bytes);
      digest.update("\0");
    }
  };
  visit(root, "", 0);
  return digest.digest("hex");
}

function assertOwnedData(path: string, journal: OnboardingTransactionJournal, complete: boolean): void {
  if (!complete) {
    assertReservationOnly(path, "data", journal);
    return;
  }
  readOwnerMarker(path, "data", journal);
  if (!journal.dataDigest || managedDataDigest(path) !== journal.dataDigest) {
    throw new OnboardingError(`受管 data 的内容摘要与 journal 不匹配；拒绝自动恢复：${path}`);
  }
  const receiptPath = join(path, "state", "onboarding.json");
  let receipt: Record<string, unknown>;
  try {
    receipt = record(JSON.parse(readBoundedText(receiptPath, RECEIPT_BYTES, "立项 receipt", {
      requireComplete: true,
      allowedRootReal: realpathSync(path),
    })), "立项 receipt");
  }
  catch (error) { throw new OnboardingError(`受管 data receipt 无效：${error instanceof Error ? error.message : String(error)}`); }
  if (receipt.planId !== journal.planId || receipt.key !== journal.plan.input.key
    || receipt.ticketPrefix !== journal.plan.input.ticketPrefix
    || receipt.outlineTicketId !== journal.plan.outlineTicket.id || receipt.createdAt !== journal.createdAt
    || receipt.commit !== journal.commit || receipt.repoPath !== journal.plan.repoPath
    || JSON.stringify(receipt.input) !== JSON.stringify(journal.plan.input)) {
    throw new OnboardingError(`受管 data receipt 与 journal 不匹配：${path}`);
  }
}

function safelyRemoveOwned(
  path: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
  complete: boolean,
): void {
  if (!existsSync(path)) return;
  const parent = dirname(path);
  const quarantine = join(parent, `.${basename(path)}.remove-${process.pid}-${randomUUID()}`);
  let moved = false;
  try {
    renameSync(path, quarantine);
    moved = true;
    const identity = lstatSync(quarantine);
    if (artifact === "repo") assertOwnedRepo(quarantine, journal, complete);
    else assertOwnedData(quarantine, journal, complete);
    const current = lstatSync(quarantine);
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new OnboardingError(`待清理产物在验证后被替换：${path}`);
    }
    rmSync(quarantine, { recursive: true });
    moved = false;
    syncDirectory(parent);
  } catch (error) {
    if (moved && existsSync(quarantine) && !existsSync(path)) {
      try {
        renameSync(quarantine, path);
        moved = false;
        syncDirectory(parent);
      } catch { /* 保留 quarantine 证据，绝不删除无法证明的树 */ }
    }
    throw error;
  }
}

function rollbackOwnedPromotion(
  finalPath: string,
  stagePath: string,
  artifact: "repo" | "data",
  journal: OnboardingTransactionJournal,
  complete: boolean,
  failures: string[],
): void {
  if (!existsSync(finalPath)) return;
  let moved = false;
  try {
    if (existsSync(stagePath)) throw new OnboardingError(`回滚 staging 已被占用：${stagePath}`);
    renameSync(finalPath, stagePath);
    moved = true;
    if (artifact === "repo") assertOwnedRepo(stagePath, journal, complete);
    else assertOwnedData(stagePath, journal, complete);
    syncDirectory(dirname(finalPath));
  } catch (error) {
    if (moved && existsSync(stagePath) && !existsSync(finalPath)) {
      try {
        renameSync(stagePath, finalPath);
        moved = false;
        syncDirectory(dirname(finalPath));
      } catch { /* 保留 staging 证据，绝不覆盖新出现的 final */ }
    }
    failures.push(`${finalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const STATE_ORDER: Record<OnboardingTransactionState, number> = {
  prepared: 0,
  "repo-staged": 1,
  "data-staged": 2,
  "repo-promoted": 3,
  "data-promoted": 4,
};

function advanceJournal(
  file: string,
  journal: OnboardingTransactionJournal,
  state: OnboardingTransactionState,
): void {
  if (STATE_ORDER[state] > STATE_ORDER[journal.state]) journal.state = state;
  atomicWriteJournal(file, journal);
}

function removeJournal(file: string, transactionId: string): void {
  if (!existsSync(file)) return;
  const current = parseJournal(file);
  if (current.transactionId !== transactionId) throw new OnboardingError(`journal 已被另一事务替换：${file}`);
  unlinkSync(file);
  syncDirectory(dirname(file));
}

export function commitOnboarding(
  root: string,
  raw: unknown,
  confirmation: string,
  runtime: OnboardingRuntime = {},
): OnboardingResult {
  const requested = normalizeInput(raw);
  const receiptPath = join(projectDataDir(root, requested.key), "state", "onboarding.json");
  const journalFile = transactionJournalPath(root, requested.key);

  // config 是可见性提交。只有 receipt + config + verify 三者同时成立才算已完成；
  // data 已 promotion 但 config 尚未发布时，receipt 只是 journal 证明的一部分，必须走恢复。
  const completedResult = (): OnboardingResult | null => {
    if (!existsSync(receiptPath)) return null;
    let receipt: {
      planId?: unknown; key?: unknown; ticketPrefix?: unknown; outlineTicketId?: unknown;
      createdAt?: unknown; commit?: unknown; input?: unknown; repoPath?: unknown;
    };
    try {
      const dataReal = assertProjectDataRoot(root, requested.key);
      const state = join(projectDataDir(root, requested.key), "state");
      assertPlainDirectory(state);
      receipt = JSON.parse(readBoundedText(receiptPath, RECEIPT_BYTES, "已有立项 receipt", {
        requireComplete: true,
        allowedRootReal: dataReal,
      })) as typeof receipt;
    }
    catch (error) { throw new OnboardingError(`已有立项 receipt 无法解析：${error instanceof Error ? error.message : String(error)}`); }
    if (receipt.planId !== confirmation || receipt.key !== requested.key
      || receipt.ticketPrefix !== requested.ticketPrefix || receipt.outlineTicketId !== `${requested.ticketPrefix}-1`
      || JSON.stringify(receipt.input) !== JSON.stringify(requested)) {
      throw new OnboardingError("项目已有不同输入或不同指纹的立项 receipt；拒绝重复覆盖");
    }
    const ws = loadConfig(root);
    const project = ws.config.projects?.[requested.key];
    if (!project) {
      if (existsSync(journalFile)) return null;
      throw new OnboardingError("项目已有立项 receipt，但 config 可见性提交缺失且无恢复 journal；请停止调度并运行 writing-loop doctor");
    }
    const verification = verifyOnboarding(root, requested.key);
    if (!verification.ok) throw new OnboardingError("项目已有立项 receipt，但三处 ground truth 不完整；请停止调度并运行 writing-loop doctor");
    return {
      planId: String(receipt.planId),
      key: requested.key,
      title: requested.title,
      repoPath: project ? resolveRepoPath(root, project) : String(receipt.repoPath ?? ""),
      projectDataPath: projectDataDir(root, requested.key),
      outlineTicketId: `${requested.ticketPrefix}-1`,
      commit: String(receipt.commit ?? ""),
      createdAt: String(receipt.createdAt ?? ""),
      verification,
    };
  };

  const alreadyComplete = completedResult();
  // A config-visible crash may leave the durable journal/markers/config lock behind. Exact retry
  // enters the per-key lease to prove and clean those artifacts; a clean completed project returns
  // immediately without manufacturing a new transaction.
  if (alreadyComplete && !existsSync(journalFile)) return alreadyComplete;

  let preview: OnboardingPlan | undefined;
  if (!existsSync(journalFile)) {
    preview = planOnboarding(root, requested);
    if (confirmation !== preview.planId) {
      throw new OnboardingError(`确认指纹不匹配；请重新预览并显式确认 ${preview.planId}`);
    }
  }

  const releaseLease = acquireTransactionLease(root, requested.key, runtime);
  let journal: OnboardingTransactionJournal | undefined;
  let fresh = false;
  let published = false;
  let claimedExistingJournal = false;
  let previousJournalOwnerPid: number | undefined;
  let ownedRepoFinal = false;
  let ownedDataFinal = false;

  try {
    const racedComplete = completedResult();
    if (racedComplete) {
      if (!existsSync(journalFile)) return racedComplete;
      journal = parseJournal(journalFile);
      const previousOwnerPid = journal.ownerPid;
      const plan = assertJournalMatches(root, journal, requested, confirmation, true);
      if (journal.commit !== racedComplete.commit || journal.createdAt !== racedComplete.createdAt
        || plan.repoPath !== racedComplete.repoPath || plan.projectDataPath !== racedComplete.projectDataPath) {
        throw new OnboardingError("已发布项目的 journal 与 receipt/result identity 不一致；拒绝清理恢复证据");
      }
      removeCrashedConfigLock(root, previousOwnerPid);
      removeOwnerMarkerIfPresent(plan.repoPath, "repo", journal);
      removeOwnerMarkerIfPresent(plan.projectDataPath, "data", journal);
      removeJournal(journalFile, journal.transactionId);
      return racedComplete;
    }

    if (existsSync(journalFile)) {
      journal = parseJournal(journalFile);
      const previousOwnerPid = journal.ownerPid;
      const plan = assertJournalMatches(root, journal, requested, confirmation);
      // per-key O_EXCL lease 是“当前是否有人恢复”的唯一真值。ownerPid 只用于证明并清理
      // 上一次进程遗留的 config lock，不能把一个已释放 lease 的长驻 Studio PID 当活事务。
      removeCrashedConfigLock(root, previousOwnerPid);
      previousJournalOwnerPid = previousOwnerPid;
      claimedExistingJournal = true;
      journal.ownerPid = process.pid;
      journal.plan = plan;
      atomicWriteJournal(journalFile, journal);
    } else {
      const plan = preview ?? planOnboarding(root, requested);
      if (confirmation !== plan.planId) {
        throw new OnboardingError(`确认指纹不匹配；请重新预览并显式确认 ${plan.planId}`);
      }
      const transactionId = (runtime.uuid ?? randomUUID)();
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(transactionId)) {
        throw new OnboardingError("立项 transaction id 只能包含字母、数字、点、下划线或连字符");
      }
      journal = {
        schemaVersion: 1,
        kind: "writing-loop/onboarding-transaction",
        transactionId,
        ownerPid: process.pid,
        state: "prepared",
        planId: plan.planId,
        planDigest: hash(JSON.stringify(plan)),
        inputDigest: hash(JSON.stringify(plan.input)),
        plan,
        repoStagePath: join(dirname(plan.repoPath), `.writing-loop-onboard-${plan.input.key}-${transactionId}`),
        dataStagePath: join(dataRoot(root), `.onboarding-${plan.input.key}-${transactionId}`),
        createdAt: (runtime.now ?? (() => new Date()))().toISOString(),
        commit: null,
        dataDigest: null,
      };
      atomicWriteJournal(journalFile, journal);
      fresh = true;
    }

    const plan = journal.plan;
    const repoStage = journal.repoStagePath;
    const dataStage = journal.dataStagePath;

    // config 才是可见性提交，因此新事务直接用 mkdir(O_EXCL 语义) 原子占住 final 名称，
    // 再在该受管目录中搭建 scaffold。这样不存在 exists→rename 覆盖竞争：任何预先出现的
    // file/symlink/empty dir 都会让 mkdir 硬错并逐字节保留。旧版 staging 只保留审计证据，
    // 不再用缺少 RENAME_NOREPLACE 的 rename 猜测式 promotion。
    const repoParent = directoryIdentity(dirname(plan.repoPath), "repo parent");
    if (repoParent.real !== dirname(plan.repoPath)) throw new OnboardingError(`repo parent 不再是 plan 固定的 physical 目录：${repoParent.path}`);
    let repoAtFinal = existsSync(plan.repoPath);
    const repoAtStage = existsSync(repoStage);
    if (repoAtFinal && repoAtStage) throw new OnboardingError("repo 的 final 与 staging 同时存在；拒绝猜测所有权");
    if (repoAtStage) throw new OnboardingError(`检测到旧版 repo staging；当前实现拒绝无 no-replace 保证的 promotion，请人工审计：${repoStage}`);
    if (repoAtFinal && journal.commit === null) {
      readOwnerMarker(plan.repoPath, "repo", journal);
      throw new OnboardingError("repo 在完整 commit 摘要持久化前中断；目录内文件无法逐项证明归属，保留现场拒绝自动删除或重建");
    }
    if (repoAtFinal) {
      const head = assertOwnedRepo(plan.repoPath, journal, true)!;
      ownedRepoFinal = true;
      if (journal.commit === null) journal.commit = head;
      syncOwnedTree(plan.repoPath);
      advanceJournal(journalFile, journal, "repo-staged");
    } else {
      if (STATE_ORDER[journal.state] > STATE_ORDER.prepared) {
        throw new OnboardingError("journal 声明 repo 已生成，但受管 repo 缺失；拒绝重建未知缺口");
      }
      runtime.beforeRepoReservation?.();
      reserveOwnedFinal(plan.repoPath, "repo", journal, repoParent);
      ownedRepoFinal = true;
      repoAtFinal = true;
      syncOwnedTree(plan.repoPath);
      runtime.afterRepoReserved?.();
      scaffoldRepo(plan.repoPath, plan);
      journal.commit = initializeGitRepo(plan.repoPath, plan.input.key);
      syncOwnedTree(plan.repoPath);
      advanceJournal(journalFile, journal, "repo-staged");
    }

    if (journal.commit === null) throw new OnboardingError("立项 journal 缺少 scaffold commit");

    const dataParent = directoryIdentity(dirname(plan.projectDataPath), "data parent");
    if (dataParent.real !== dirname(plan.projectDataPath)) throw new OnboardingError(`data parent 不再是 plan 固定的 physical 目录：${dataParent.path}`);
    let dataAtFinal = existsSync(plan.projectDataPath);
    const dataAtStage = existsSync(dataStage);
    if (dataAtFinal && dataAtStage) throw new OnboardingError("data 的 final 与 staging 同时存在；拒绝猜测所有权");
    if (dataAtStage) throw new OnboardingError(`检测到旧版 data staging；当前实现拒绝无 no-replace 保证的 promotion，请人工审计：${dataStage}`);
    if (dataAtFinal && journal.dataDigest === null) {
      readOwnerMarker(plan.projectDataPath, "data", journal);
      throw new OnboardingError("data 在完整内容摘要持久化前中断；目录内文件无法逐项证明归属，保留现场拒绝自动删除或重建");
    }
    if (dataAtFinal) {
      assertOwnedData(plan.projectDataPath, journal, true);
      ownedDataFinal = true;
      syncOwnedTree(plan.projectDataPath);
      advanceJournal(journalFile, journal, "data-staged");
    } else {
      if (STATE_ORDER[journal.state] >= STATE_ORDER["data-staged"]) {
        throw new OnboardingError("journal 声明 data 已生成，但受管 data 缺失；拒绝重建未知缺口");
      }
      reserveOwnedFinal(plan.projectDataPath, "data", journal, dataParent);
      ownedDataFinal = true;
      dataAtFinal = true;
      syncOwnedTree(plan.projectDataPath);
      runtime.afterDataReserved?.();
      scaffoldData(plan.projectDataPath, plan, journal.createdAt, journal.commit);
      journal.dataDigest = managedDataDigest(plan.projectDataPath);
      syncOwnedTree(plan.projectDataPath);
      advanceJournal(journalFile, journal, "data-staged");
    }

    // Both atomically-reserved final trees are now complete and durable. Retain the historical
    // state ordering so old journals remain parseable even though no clobbering rename is needed.
    advanceJournal(journalFile, journal, "repo-promoted");
    runtime.afterRepoPromoted?.();
    advanceJournal(journalFile, journal, "data-promoted");

    withWorkspaceConfigLock(root, ({ raw: lockedRaw, config, replace }) => {
      if (hash(lockedRaw) !== plan.configDigest) {
        throw new OnboardingError("预览后 config.json 已变化；为避免基于陈旧计划发布，请重新生成计划并确认新指纹");
      }
      const projects = projectsObject(config);
      const entries = onboardingProjectEntries(config);
      if (Object.prototype.hasOwnProperty.call(projects, plan.input.key)) throw new OnboardingError(`项目 key '${plan.input.key}' 已存在`);
      for (const [key, project] of entries) {
        if (project.ticketPrefix === plan.input.ticketPrefix) throw new OnboardingError(`ticketPrefix 已被项目 '${key}' 使用`);
        if (resolve(resolveRepoPath(root, project)) === plan.repoPath) throw new OnboardingError(`repoPath 已由项目 '${key}' 注册`);
      }
      if (!repoAtFinal || !dataAtFinal) throw new OnboardingError("受管 repo/data 在 config 发布前消失；拒绝发布悬空条目");
      assertOwnedRepo(plan.repoPath, journal!, true);
      assertOwnedData(plan.projectDataPath, journal!, true);
      runtime.beforeConfigReplace?.();
      config.projects = { ...projects, [plan.input.key]: plan.projectConfig };
      replace(config, () => {
        published = true;
        runtime.afterConfigRenamed?.();
      });
    }, { syncDirectory: runtime.syncConfigDirectory });

    const verification = verifyOnboarding(root, plan.input.key);
    if (!verification.ok) {
      const failed = verification.checks.filter((check) => !check.ok).map((check) => check.name).join("、");
      throw new OnboardingError(`立项已发布，但写后验证失败：${failed}；请停止调度并运行 writing-loop doctor`);
    }

    // config 已可见且 verify 通过后，所有权标记和 journal 只剩恢复用途；清理失败不能
    // 把已提交项目伪报为失败，后续同 plan 仍会由 receipt 幂等回读。
    try { removeOwnerMarkerIfPresent(plan.repoPath, "repo", journal); } catch { /* best effort */ }
    try { removeOwnerMarkerIfPresent(plan.projectDataPath, "data", journal); } catch { /* best effort */ }
    try { removeJournal(journalFile, journal.transactionId); } catch { /* best effort */ }

    return {
      planId: plan.planId,
      key: plan.input.key,
      title: plan.input.title,
      repoPath: plan.repoPath,
      projectDataPath: plan.projectDataPath,
      outlineTicketId: plan.outlineTicket.id,
      commit: journal.commit,
      createdAt: journal.createdAt,
      verification,
    };
  } catch (error) {
    const primary = error instanceof OnboardingError
      ? error
      : new OnboardingError(error instanceof Error ? error.message : String(error));
    if (!published && fresh && journal) {
      const failures: string[] = [];
      // 同进程可捕获故障保持旧语义：逆序回滚并只清理带本事务所有权证明的路径。
      if (ownedDataFinal) {
        rollbackOwnedPromotion(journal.plan.projectDataPath, journal.dataStagePath, "data", journal, journal.dataDigest !== null, failures);
      }
      if (ownedRepoFinal) {
        rollbackOwnedPromotion(journal.plan.repoPath, journal.repoStagePath, "repo", journal, journal.commit !== null, failures);
      }
      if (!failures.length) {
        try {
          safelyRemoveOwned(journal.dataStagePath, "data", journal, journal.dataDigest !== null);
          safelyRemoveOwned(journal.repoStagePath, "repo", journal, journal.commit !== null);
          removeJournal(journalFile, journal.transactionId);
        } catch (cleanupError) {
          failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      if (failures.length) {
        throw new OnboardingError(`${primary.message}；为避免触碰非本事务产物，自动回滚未完成：${failures.join("；")}`);
      }
    }
    if (!published && !fresh && claimedExistingJournal && journal && previousJournalOwnerPid !== undefined) {
      try {
        const current = parseJournal(journalFile);
        if (current.transactionId !== journal.transactionId) {
          throw new OnboardingError(`journal 已被另一事务替换：${journalFile}`);
        }
        // 捕获式硬停意味着本进程仍活但已不再执行恢复；在释放 lease 前原子还原上一个
        // crash owner。若进程在这次写前真正崩溃，catch 不会运行，当前 PID 会原样保留。
        current.ownerPid = previousJournalOwnerPid;
        atomicWriteJournal(journalFile, current);
        journal = current;
      } catch (restoreError) {
        throw new OnboardingError(`${primary.message}；恢复 journal inactive owner 失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    throw primary;
  } finally {
    releaseLease();
  }
}

export function verifyOnboarding(root: string, key: string): OnboardingVerification {
  assertProjectKey(key);
  const checks: OnboardingVerification["checks"] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  const data = projectDataDir(root, key);
  const receiptFile = join(data, "state", "onboarding.json");
  let dataReal = "";
  try {
    dataReal = assertProjectDataRoot(root, key);
    assertPlainDirectory(join(data, "state"));
    add("project-data-root", true, dataReal);
  } catch (error) {
    add("project-data-root", false, error instanceof Error ? error.message : String(error));
  }
  let receipt: {
    schemaVersion?: unknown; planId?: unknown; key?: unknown; ticketPrefix?: unknown;
    outlineTicketId?: unknown; createdAt?: unknown; commit?: unknown; repoPath?: unknown;
    projectConfig?: unknown; input?: unknown;
  } | undefined;
  try {
    if (!dataReal) throw new OnboardingError("项目 data 根无效，拒绝读取 receipt");
    receipt = JSON.parse(readBoundedText(receiptFile, RECEIPT_BYTES, "receipt", {
      requireComplete: true,
      allowedRootReal: dataReal,
    })) as typeof receipt;
    const receiptProject = record(receipt?.projectConfig, "receipt.projectConfig");
    const receiptInput = record(receipt?.input, "receipt.input");
    if (receipt?.schemaVersion !== 1 || typeof receipt.planId !== "string" || !/^wlplan_[0-9a-f]{24}$/.test(receipt.planId)
      || receipt.key !== key || typeof receipt.ticketPrefix !== "string" || !TICKET_PREFIX.test(receipt.ticketPrefix)
      || receipt.outlineTicketId !== `${receipt.ticketPrefix}-1`
      || typeof receipt.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(receipt.commit)
      || typeof receipt.repoPath !== "string" || !isAbsolute(receipt.repoPath)
      || receiptInput.key !== key || receiptInput.ticketPrefix !== receipt.ticketPrefix
      || receiptProject.ticketPrefix !== receipt.ticketPrefix || typeof receiptProject.repoPath !== "string") {
      throw new OnboardingError("receipt invariant identity 无效");
    }
    add("onboarding-receipt", true, `${receipt.planId} · ${receipt.commit.slice(0, 12)}`);
  } catch (error) {
    receipt = undefined;
    add("onboarding-receipt", false, error instanceof Error ? error.message : String(error));
  }

  let project: WlProject | undefined;
  let repo = "";
  try {
    const ws = loadConfig(root);
    project = Object.prototype.hasOwnProperty.call(ws.config.projects ?? {}, key) ? ws.config.projects?.[key] : undefined;
    if (!project || typeof project !== "object" || Array.isArray(project)) throw new OnboardingError("项目条目缺失或无效");
    repo = resolveRepoPath(root, project);
    if (receipt) {
      const receiptProject = receipt.projectConfig as Record<string, unknown>;
      const configured = resolve(root, repo);
      const receipted = resolve(root, String(receipt.repoPath));
      const planned = resolve(root, String(receiptProject.repoPath));
      if (project.ticketPrefix !== receipt.ticketPrefix || receiptProject.ticketPrefix !== receipt.ticketPrefix
        || configured !== receipted || planned !== receipted) {
        throw new OnboardingError("config 的 repoPath/ticketPrefix 与 onboarding receipt 冲突");
      }
    }
    add("config-entry", true, "项目条目与 receipt identity 一致");
  } catch (error) {
    project = undefined;
    repo = "";
    add("config-entry", false, error instanceof Error ? error.message : String(error));
  }

  const requiredRepo = [
    "README.md", "bible/north-star.md", "bible/characters.md", "bible/world.md", "outline.md",
    "ledgers/foreshadow.md", "ledgers/story-state.md", "ledgers/production.md",
  ];
  const invalidRepo: string[] = [];
  if (repo) {
    try {
      assertPlainDirectory(repo);
      const repoReal = realpathSync(repo);
      for (const file of requiredRepo) {
        const parts = file.split("/");
        let cursor = repo;
        for (const part of parts) {
          cursor = join(cursor, part);
          const info = lstatSync(cursor);
          if (info.isSymbolicLink()) throw new OnboardingError(`${file} 含符号链接`);
        }
        const info = lstatSync(cursor);
        if (!info.isFile() || !within(repoReal, realpathSync(cursor))) throw new OnboardingError(`${file} 不是 repo 内普通文件`);
      }
    } catch (error) { invalidRepo.push(error instanceof Error ? error.message : String(error)); }
  } else invalidRepo.push("config/receipt 未解析出 repo");
  add("repo-scaffold", invalidRepo.length === 0, invalidRepo.length ? invalidRepo.join("；") : repo);

  let head = "";
  let commitIsAncestor = false;
  if (repo && receipt && typeof receipt.commit === "string") {
    try {
      head = runGit(repo, ["rev-parse", "--verify", "HEAD"]);
      const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", receipt.commit, "HEAD"], {
        cwd: repo, encoding: "utf8", timeout: 30_000,
      });
      commitIsAncestor = ancestry.status === 0;
    } catch { head = ""; }
  }
  add("git-head", /^[0-9a-f]{40,64}$/i.test(head) && commitIsAncestor,
    head && receipt ? `${String(receipt.commit).slice(0, 12)} 是 ${head.slice(0, 12)} 的祖先` : "无可验证 HEAD/receipt commit");

  let ticketOk = false;
  let ticketDetail = "首票不存在";
  try {
    if (!dataReal) throw new OnboardingError("项目 data 根无效，拒绝读取 outline ticket");
    if (!receipt || typeof receipt.outlineTicketId !== "string") throw new OnboardingError("receipt 未提供原 outline ticket identity");
    assertPlainDirectory(join(data, "board"));
    assertPlainDirectory(join(data, "board", "tickets"));
    const ticketFile = join(data, "board", "tickets", `${receipt.outlineTicketId}.md`);
    const outline = parseTicketFrontmatter(readBoundedText(ticketFile, OUTLINE_HEAD_BYTES, "原 outline ticket", {
      allowedRootReal: dataReal,
    }), basename(ticketFile));
    ticketOk = Boolean(outline && !outline.malformed && outline.id === receipt.outlineTicketId
      && TICKET_STATES.has(outline.state) && outline.labels.includes("outline")
      && outline.labels.includes("showrunner") && outline.labels.includes("story-designer"));
    ticketDetail = ticketOk ? `${outline!.id} · ${outline!.state}` : "原 outline ticket identity/协议无效";
  } catch (error) { ticketDetail = error instanceof Error ? error.message : String(error); }
  add("outline-ticket", ticketOk, ticketDetail);

  const runtimeDirs = ["reports", "state", "lessons", "board/tickets"];
  const missingRuntime = runtimeDirs.filter((dir) => {
    try {
      if (!dataReal) return true;
      if (assertProjectDataRoot(root, key) !== dataReal) return true;
      let cursor = data;
      for (const part of dir.split("/")) {
        cursor = join(cursor, part);
        const info = lstatSync(cursor);
        if (!info.isDirectory() || info.isSymbolicLink()) return true;
      }
      return false;
    } catch { return true; }
  });
  add("runtime-layout", missingRuntime.length === 0, missingRuntime.length ? `缺少 ${missingRuntime.join("、")}` : data);
  return { ok: checks.every((check) => check.ok), checks };
}
