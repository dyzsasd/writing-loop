// writing-loop adaptation source intake: strict local registration, deterministic chunking,
// explicit provider-processing consent, and a durable source-analysis ticket. Raw source bytes
// remain outside the script repo; only the operator brief and source fingerprint are committed.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectDataDir, projectEntries, resolveRepoPath, type WlConfig, WsError } from "./workspace.ts";

const SOURCE_DIR = "source-intake.v1";
const MANIFEST_FILE = "manifest.v1.json";
const CONTROL_FILE = "control.v1.json";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_BRIEF_CHARS = 64 * 1024;
const MAX_RIGHTS_CHARS = 16 * 1024;
const TARGET_CHUNK_BYTES = 96 * 1024;
const MAX_SECTIONS_PER_CHUNK = 6;
const MAX_LINE_BYTES = 64 * 1024;
const HARNESSES = new Set(["claude", "codex", "opencode"]);
const ID_PATTERN = /^([A-Z][A-Z0-9]{0,7})-(\d+)\.md$/;
const HEADING = /^(?:第[〇零一二三四五六七八九十百千万两0-9]+(?:章|节|回|卷)(?:至[〇零一二三四五六七八九十百千万两0-9]+(?:章|节|回|卷))?(?:\s+.*)?|序章(?:\s+.*)?|楔子(?:\s+.*)?|引子(?:\s+.*)?|终章(?:\s+.*)?|后记(?:\s+.*)?|番外(?:\s+.*)?)$/u;

type JsonObject = Record<string, unknown>;

export type SourceProcessingConsent = {
  allowedHarnesses: Array<"claude" | "codex" | "opencode">;
  rawNovelContentMayBeSent: true;
  confirmedAt: string;
};

export type SourceIntakeRequest = {
  version: 1;
  sourceTitle: string;
  sourcePath: string;
  adaptationBrief: string;
  rightsScope: string;
  processingConsent: SourceProcessingConsent;
};

export type SourceChunk = {
  id: string;
  path: string;
  sha256: string;
  byteLength: number;
  startLine: number;
  endLine: number;
  sectionCount: number;
  headings: string[];
};

export type SourceIntakePlan = {
  version: 1;
  kind: "writing-loop/source-intake-plan";
  planId: string;
  projectKey: string;
  repoPath: string;
  runtimePath: string;
  source: {
    title: string;
    fileName: string;
    canonicalPath: string;
    sha256: string;
    byteLength: number;
    lineCount: number;
    normalizedSha256: string;
  };
  chunking: {
    algorithm: "heading-line-v1";
    chunkCount: number;
    targetBytes: number;
    maxSectionsPerChunk: number;
    first: Pick<SourceChunk, "id" | "startLine" | "endLine" | "headings">;
    last: Pick<SourceChunk, "id" | "startLine" | "endLine" | "headings">;
  };
  processingConsent: SourceProcessingConsent;
  warnings: string[];
  requiresConfirmation: true;
};

export type SourceIntakeManifest = {
  version: 1;
  kind: "writing-loop/source-intake";
  planId: string;
  projectKey: string;
  createdAt: string;
  source: {
    title: string;
    fileName: string;
    sha256: string;
    byteLength: number;
    lineCount: number;
    normalizedSha256: string;
    storedPath: "original/source.txt";
  };
  adaptation: {
    briefSha256: string;
    rightsScope: string;
    processingConsent: SourceProcessingConsent;
  };
  chunking: {
    algorithm: "heading-line-v1";
    targetBytes: number;
    maxSectionsPerChunk: number;
    chunks: SourceChunk[];
  };
};

export type SourceIntakeControl = {
  version: 1;
  kind: "writing-loop/source-analysis-control";
  planId: string;
  analysisTicketId: string;
  outlineTicketId: string;
  phase: "registered" | "analyzing" | "review-ready";
  selectedChunks: string[];
  completedChunks: string[];
  updatedAt: string;
};

export type SourceIntakeResult = {
  planId: string;
  projectKey: string;
  sourceSha256: string;
  chunkCount: number;
  analysisTicketId: string;
  outlineTicketId: string;
  repoCommit: string;
  replayed: boolean;
};

export type SourceAnalysisProgress = {
  projectKey: string;
  phase: SourceIntakeControl["phase"];
  selectedChunks: string[];
  completedChunks: string[];
  remainingChunks: string[];
};

export class SourceIntakeError extends WsError {
  constructor(message: string) { super(message); this.name = "SourceIntakeError"; }
}

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SourceIntakeError(`${label} 字段必须精确为 ${expected.join(", ")}`);
  }
};
const textField = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim()) throw new SourceIntakeError(`${label} 必须是非空字符串`);
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length > max || normalized.includes("\0")) throw new SourceIntakeError(`${label} 超出安全上限`);
  return normalized;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SourceIntakeError("canonical JSON 不接受非有限数");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) throw new SourceIntakeError("canonical JSON 只接受普通 JSON 值");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const iso = (value: string, label: string, nowMs: number): string => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new SourceIntakeError(`${label} 必须是规范 ISO 时间`);
  if (parsed > nowMs + 5 * 60_000) throw new SourceIntakeError(`${label} 不能在未来`);
  return value;
};
const errno = (error: unknown): string | undefined => error && typeof error === "object" && "code" in error
  ? String((error as NodeJS.ErrnoException).code) : undefined;

function readPinnedSource(file: string): { bytes: Buffer; stat: ReturnType<typeof fstatSync> } {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | noFollow); }
  catch (error) { throw new SourceIntakeError(`无法安全打开原著：${errno(error) ?? String(error)}`); }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new SourceIntakeError("原著必须是单链接普通文件");
    if (before.size <= 0n || before.size > BigInt(MAX_SOURCE_BYTES)) throw new SourceIntakeError(`原著字节数必须在 1–${MAX_SOURCE_BYTES} 之间`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new SourceIntakeError("原著读取中途截断");
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new SourceIntakeError("原著在读取期间发生变化");
    }
    return { bytes, stat: after };
  } finally { closeSync(fd); }
}

function parseRequest(root: string, repoPath: string, value: unknown, nowMs: number): {
  request: SourceIntakeRequest;
  sourcePath: string;
  bytes: Buffer;
  normalized: string;
} {
  if (!isRecord(value)) throw new SourceIntakeError("source intake 输入必须是 JSON 对象");
  exactKeys(value, ["version", "sourceTitle", "sourcePath", "adaptationBrief", "rightsScope", "processingConsent"], "source intake");
  if (value.version !== 1) throw new SourceIntakeError("source intake version 必须为 1");
  const sourceTitle = textField(value.sourceTitle, "sourceTitle", 200);
  const sourceInput = textField(value.sourcePath, "sourcePath", 2_048);
  const adaptationBrief = textField(value.adaptationBrief, "adaptationBrief", MAX_BRIEF_CHARS);
  const rightsScope = textField(value.rightsScope, "rightsScope", MAX_RIGHTS_CHARS);
  if (!isRecord(value.processingConsent)) throw new SourceIntakeError("processingConsent 必须是 JSON 对象");
  exactKeys(value.processingConsent, ["allowedHarnesses", "rawNovelContentMayBeSent", "confirmedAt"], "processingConsent");
  if (!Array.isArray(value.processingConsent.allowedHarnesses)
    || value.processingConsent.allowedHarnesses.length < 1
    || value.processingConsent.allowedHarnesses.length > 3
    || value.processingConsent.allowedHarnesses.some((item) => typeof item !== "string" || !HARNESSES.has(item))) {
    throw new SourceIntakeError("processingConsent.allowedHarnesses 必须是 claude/codex/opencode 的非空去重数组");
  }
  const allowedHarnesses = [...new Set(value.processingConsent.allowedHarnesses)] as SourceProcessingConsent["allowedHarnesses"];
  if (allowedHarnesses.length !== value.processingConsent.allowedHarnesses.length) throw new SourceIntakeError("allowedHarnesses 不能重复");
  if (value.processingConsent.rawNovelContentMayBeSent !== true) {
    throw new SourceIntakeError("必须明确确认 rawNovelContentMayBeSent:true；否则 writing-loop 只登记、不能调用模型拆书");
  }
  const confirmedAt = iso(textField(value.processingConsent.confirmedAt, "confirmedAt", 64), "confirmedAt", nowMs);
  const candidate = isAbsolute(sourceInput) ? resolve(sourceInput) : resolve(root, sourceInput);
  let canonicalPath: string;
  try { canonicalPath = realpathSync(candidate); }
  catch { throw new SourceIntakeError(`原著路径不存在：${candidate}`); }
  const rel = relative(root, canonicalPath);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SourceIntakeError("原著必须位于 workspace 内");
  if (rel === ".writing-loop" || rel.startsWith(`.writing-loop${sep}`)) throw new SourceIntakeError("原著不能预先放入 .writing-loop 运行态");
  const repoBoundary = existsSync(repoPath) ? realpathSync(repoPath) : resolve(repoPath);
  if (canonicalPath === repoBoundary || canonicalPath.startsWith(repoBoundary + sep)) throw new SourceIntakeError("原著全文不能放入剧本 Git repo");
  const lst = lstatSync(canonicalPath, { bigint: true });
  if (!lst.isFile() || lst.isSymbolicLink()) throw new SourceIntakeError("原著必须是普通文件，不能是 symlink");
  const { bytes } = readPinnedSource(canonicalPath);
  let normalized: string;
  try { normalized = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
  catch { throw new SourceIntakeError("原著必须是严格 UTF-8 文本"); }
  if (normalized.includes("\0")) throw new SourceIntakeError("原著不能包含 NUL");
  return {
    request: {
      version: 1, sourceTitle, sourcePath: canonicalPath, adaptationBrief, rightsScope,
      processingConsent: { allowedHarnesses, rawNovelContentMayBeSent: true, confirmedAt },
    },
    sourcePath: canonicalPath, bytes, normalized,
  };
}

function chunksFor(normalized: string): Array<SourceChunk & { content: string }> {
  const lines = normalized.split("\n");
  const out: Array<SourceChunk & { content: string }> = [];
  let start = 0;
  let bytes = 0;
  let sections = 0;
  let headings: string[] = [];

  const flush = (endExclusive: number): void => {
    if (endExclusive <= start) return;
    const content = lines.slice(start, endExclusive).join("\n") + "\n";
    const id = `chunk-${String(out.length + 1).padStart(4, "0")}`;
    out.push({
      id, path: `chunks/${id}.txt`, sha256: hash(content), byteLength: Buffer.byteLength(content),
      startLine: start + 1, endLine: endExclusive, sectionCount: sections, headings: [...headings], content,
    });
    start = endExclusive; bytes = 0; sections = 0; headings = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > MAX_LINE_BYTES) throw new SourceIntakeError(`原著第 ${index + 1} 行超过 ${MAX_LINE_BYTES} 字节`);
    const heading = HEADING.test(line.trimEnd()) && line.length === line.trimStart().length;
    if (heading && index > start && sections >= MAX_SECTIONS_PER_CHUNK) flush(index);
    if (bytes > 0 && bytes + lineBytes > TARGET_CHUNK_BYTES) flush(index);
    if (heading) { sections++; if (headings.length < 12) headings.push(line.trim()); }
    bytes += lineBytes;
  }
  flush(lines.length);
  if (!out.length || out.length > 4_096) throw new SourceIntakeError("原著分块数量超出安全边界");
  return out;
}

function sourceFactsForTarget(root: string, key: string, repoPath: string, value: unknown, nowMs: number) {
  const repoIdentity = existsSync(repoPath) ? realpathSync(repoPath) : resolve(repoPath);
  const parsed = parseRequest(root, repoPath, value, nowMs);
  const chunks = chunksFor(parsed.normalized);
  const source = {
    title: parsed.request.sourceTitle, fileName: basename(parsed.sourcePath), canonicalPath: parsed.sourcePath,
    sha256: hash(parsed.bytes), byteLength: parsed.bytes.length,
    lineCount: parsed.normalized.split("\n").length, normalizedSha256: hash(parsed.normalized),
  };
  const planSeed = {
    version: 1, projectKey: key, repoPath: repoIdentity, source,
    adaptationBrief: parsed.request.adaptationBrief, rightsScope: parsed.request.rightsScope,
    processingConsent: parsed.request.processingConsent,
    chunking: { algorithm: "heading-line-v1", targetBytes: TARGET_CHUNK_BYTES, maxSectionsPerChunk: MAX_SECTIONS_PER_CHUNK,
      chunks: chunks.map(({ content: _content, ...chunk }) => chunk) },
  };
  return { repoPath: repoIdentity, parsed, chunks, source, planSeed, planId: `wlsrc_${hash(canonical(planSeed)).slice(0, 32)}` };
}

function sourceFacts(root: string, key: string, config: WlConfig, value: unknown, nowMs: number) {
  const entry = projectEntries(config).find(([candidate]) => candidate === key);
  if (!entry) throw new SourceIntakeError(`config.json 无项目 '${key}'`);
  const repoPath = resolveRepoPath(root, entry[1]);
  if (!statSync(repoPath).isDirectory()) throw new SourceIntakeError(`项目 repo 不存在：${repoPath}`);
  return sourceFactsForTarget(root, key, repoPath, value, nowMs);
}

function planFromFacts(root: string, key: string, facts: ReturnType<typeof sourceFactsForTarget>): SourceIntakePlan {
  const first = facts.chunks[0];
  const last = facts.chunks[facts.chunks.length - 1];
  const pick = (chunk: SourceChunk): Pick<SourceChunk, "id" | "startLine" | "endLine" | "headings"> =>
    ({ id: chunk.id, startLine: chunk.startLine, endLine: chunk.endLine, headings: chunk.headings });
  return {
    version: 1, kind: "writing-loop/source-intake-plan", planId: facts.planId, projectKey: key,
    repoPath: facts.repoPath, runtimePath: join(projectDataDir(root, key), SOURCE_DIR), source: facts.source,
    chunking: { algorithm: "heading-line-v1", chunkCount: facts.chunks.length, targetBytes: TARGET_CHUNK_BYTES,
      maxSectionsPerChunk: MAX_SECTIONS_PER_CHUNK, first: pick(first), last: pick(last) },
    processingConsent: facts.parsed.request.processingConsent,
    warnings: ["原著全文不进入 Git；获授权的 harness 只会按 source-analysis 票逐块读取。"], requiresConfirmation: true,
  };
}

export function planSourceIntakeForTarget(root: string, key: string, repoPath: string, value: unknown,
  nowMs = Date.now()): SourceIntakePlan {
  return planFromFacts(root, key, sourceFactsForTarget(root, key, repoPath, value, nowMs));
}

export function planSourceIntake(root: string, key: string, config: WlConfig, value: unknown, nowMs = Date.now()): SourceIntakePlan {
  return planFromFacts(root, key, sourceFacts(root, key, config, value, nowMs));
}

function fsyncFile(file: string): void {
  const fd = openSync(file, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function fsyncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurable(file: string, data: string | Buffer, mode: number): void {
  writeFileSync(file, data, { flag: "wx", mode });
  fsyncFile(file);
}
function atomicReplace(file: string, data: string, mode = 0o600): void {
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeDurable(temp, data, mode);
  renameSync(temp, file);
  fsyncDir(dirname(file));
}
function readJson(file: string): unknown {
  const lst = lstatSync(file, { bigint: true });
  if (!lst.isFile() || lst.isSymbolicLink() || lst.nlink !== 1n || lst.size > 4n * 1024n * 1024n) {
    throw new SourceIntakeError(`不安全的 JSON 文件：${file}`);
  }
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new SourceIntakeError(`JSON 无法解析：${file}`); }
}

function sourceControlFiles(root: string, key: string): { dir: string; manifestFile: string; controlFile: string } {
  const dir = join(projectDataDir(root, key), SOURCE_DIR);
  return { dir, manifestFile: join(dir, MANIFEST_FILE), controlFile: join(dir, CONTROL_FILE) };
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new SourceIntakeError(`${label} 必须是非空字符串数组`);
  }
  if (new Set(value).size !== value.length) throw new SourceIntakeError(`${label} 不能重复`);
  return [...value];
}

function digestField(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new SourceIntakeError(`${label} 必须是 SHA-256`);
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new SourceIntakeError(`${label} 必须是安全整数`);
  return Number(value);
}

function parseManifest(value: unknown): SourceIntakeManifest {
  if (!isRecord(value)) throw new SourceIntakeError("source intake manifest 必须是 JSON 对象");
  exactKeys(value, ["version", "kind", "planId", "projectKey", "createdAt", "source", "adaptation", "chunking"], "source intake manifest");
  if (value.version !== 1 || value.kind !== "writing-loop/source-intake"
    || typeof value.planId !== "string" || !/^wlsrc_[0-9a-f]{32}$/.test(value.planId)
    || typeof value.projectKey !== "string" || !value.projectKey
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || new Date(Date.parse(value.createdAt)).toISOString() !== value.createdAt) {
    throw new SourceIntakeError("source intake manifest identity 无效");
  }
  if (!isRecord(value.source)) throw new SourceIntakeError("source manifest.source 无效");
  exactKeys(value.source, ["title", "fileName", "sha256", "byteLength", "lineCount", "normalizedSha256", "storedPath"], "source manifest.source");
  const title = textField(value.source.title, "source.title", 200);
  const fileName = textField(value.source.fileName, "source.fileName", 512);
  if (basename(fileName) !== fileName || value.source.storedPath !== "original/source.txt") throw new SourceIntakeError("source manifest 路径无效");
  if (!isRecord(value.adaptation)) throw new SourceIntakeError("source manifest.adaptation 无效");
  exactKeys(value.adaptation, ["briefSha256", "rightsScope", "processingConsent"], "source manifest.adaptation");
  const rightsScope = textField(value.adaptation.rightsScope, "adaptation.rightsScope", MAX_RIGHTS_CHARS);
  if (!isRecord(value.adaptation.processingConsent)) throw new SourceIntakeError("source manifest processingConsent 无效");
  const consent = value.adaptation.processingConsent;
  exactKeys(consent, ["allowedHarnesses", "rawNovelContentMayBeSent", "confirmedAt"], "source manifest processingConsent");
  if (!Array.isArray(consent.allowedHarnesses) || consent.allowedHarnesses.length < 1 || consent.allowedHarnesses.length > 3
    || consent.allowedHarnesses.some((item) => typeof item !== "string" || !HARNESSES.has(item))
    || new Set(consent.allowedHarnesses).size !== consent.allowedHarnesses.length
    || consent.rawNovelContentMayBeSent !== true || typeof consent.confirmedAt !== "string"
    || !Number.isFinite(Date.parse(consent.confirmedAt))
    || new Date(Date.parse(consent.confirmedAt)).toISOString() !== consent.confirmedAt) {
    throw new SourceIntakeError("source manifest processingConsent 无效");
  }
  if (!isRecord(value.chunking)) throw new SourceIntakeError("source manifest.chunking 无效");
  exactKeys(value.chunking, ["algorithm", "targetBytes", "maxSectionsPerChunk", "chunks"], "source manifest.chunking");
  if (value.chunking.algorithm !== "heading-line-v1" || value.chunking.targetBytes !== TARGET_CHUNK_BYTES
    || value.chunking.maxSectionsPerChunk !== MAX_SECTIONS_PER_CHUNK || !Array.isArray(value.chunking.chunks)
    || value.chunking.chunks.length < 1 || value.chunking.chunks.length > 4_096) {
    throw new SourceIntakeError("source manifest chunking contract 无效");
  }
  let previousEnd = 0;
  const chunks = value.chunking.chunks.map((raw, index): SourceChunk => {
    if (!isRecord(raw)) throw new SourceIntakeError("source manifest chunk 无效");
    exactKeys(raw, ["id", "path", "sha256", "byteLength", "startLine", "endLine", "sectionCount", "headings"], "source manifest chunk");
    const id = `chunk-${String(index + 1).padStart(4, "0")}`;
    const startLine = safeInteger(raw.startLine, "chunk.startLine", 1);
    const endLine = safeInteger(raw.endLine, "chunk.endLine", startLine);
    if (raw.id !== id || raw.path !== `chunks/${id}.txt` || startLine !== previousEnd + 1
      || !Array.isArray(raw.headings) || raw.headings.length > 12
      || raw.headings.some((heading) => typeof heading !== "string" || heading.length > MAX_LINE_BYTES)) {
      throw new SourceIntakeError("source manifest chunk identity/order 无效");
    }
    previousEnd = endLine;
    return { id, path: raw.path, sha256: digestField(raw.sha256, "chunk.sha256"),
      byteLength: safeInteger(raw.byteLength, "chunk.byteLength", 1), startLine, endLine,
      sectionCount: safeInteger(raw.sectionCount, "chunk.sectionCount"), headings: [...raw.headings] as string[] };
  });
  return {
    version: 1, kind: "writing-loop/source-intake", planId: value.planId, projectKey: value.projectKey,
    createdAt: value.createdAt,
    source: { title, fileName, sha256: digestField(value.source.sha256, "source.sha256"),
      byteLength: safeInteger(value.source.byteLength, "source.byteLength", 1),
      lineCount: safeInteger(value.source.lineCount, "source.lineCount", 1),
      normalizedSha256: digestField(value.source.normalizedSha256, "source.normalizedSha256"), storedPath: "original/source.txt" },
    adaptation: { briefSha256: digestField(value.adaptation.briefSha256, "adaptation.briefSha256"), rightsScope,
      processingConsent: { allowedHarnesses: [...consent.allowedHarnesses] as SourceProcessingConsent["allowedHarnesses"],
        rawNovelContentMayBeSent: true, confirmedAt: consent.confirmedAt } },
    chunking: { algorithm: "heading-line-v1", targetBytes: TARGET_CHUNK_BYTES,
      maxSectionsPerChunk: MAX_SECTIONS_PER_CHUNK, chunks },
  };
}

function parseControl(value: unknown): SourceIntakeControl {
  if (!isRecord(value)) throw new SourceIntakeError("source analysis control 必须是 JSON 对象");
  exactKeys(value, ["version", "kind", "planId", "analysisTicketId", "outlineTicketId", "phase", "selectedChunks", "completedChunks", "updatedAt"], "source analysis control");
  if (value.version !== 1 || value.kind !== "writing-loop/source-analysis-control") throw new SourceIntakeError("source analysis control identity 无效");
  if (typeof value.planId !== "string" || !/^wlsrc_[0-9a-f]{32}$/.test(value.planId)
    || typeof value.analysisTicketId !== "string" || typeof value.outlineTicketId !== "string") {
    throw new SourceIntakeError("source analysis control ID 无效");
  }
  if (!new Set(["registered", "analyzing", "review-ready"]).has(String(value.phase))) {
    throw new SourceIntakeError("source analysis control phase 无效");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new SourceIntakeError("source analysis control updatedAt 无效");
  return {
    version: 1, kind: "writing-loop/source-analysis-control", planId: value.planId,
    analysisTicketId: value.analysisTicketId, outlineTicketId: value.outlineTicketId,
    phase: value.phase as SourceIntakeControl["phase"], selectedChunks: exactStringArray(value.selectedChunks, "selectedChunks"),
    completedChunks: exactStringArray(value.completedChunks, "completedChunks"), updatedAt: value.updatedAt,
  };
}

function mutateControl(root: string, key: string, mutate: (manifest: SourceIntakeManifest, control: SourceIntakeControl) => SourceIntakeControl): SourceIntakeControl {
  const files = sourceControlFiles(root, key);
  if (!existsSync(files.dir)) throw new SourceIntakeError("项目尚未登记原著");
  const lock = join(files.dir, ".control.lock");
  let fd: number;
  try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) { throw new SourceIntakeError(`source analysis control 被占用：${errno(error) ?? String(error)}`); }
  try {
    const manifest = parseManifest(readJson(files.manifestFile));
    const control = parseControl(readJson(files.controlFile));
    if (manifest.projectKey !== key || manifest.planId !== control.planId) throw new SourceIntakeError("source intake 状态不一致");
    const next = mutate(manifest, control);
    atomicReplace(files.controlFile, JSON.stringify(next, null, 2) + "\n");
    return next;
  } finally { closeSync(fd!); unlinkSync(lock); fsyncDir(files.dir); }
}
function git(repo: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new SourceIntakeError(`git ${args[0]} 失败：${String(result.stderr).trim()}`);
  return String(result.stdout).trim();
}
function repoDocument(manifest: SourceIntakeManifest, brief: string): string {
  const consent = manifest.adaptation.processingConsent;
  return `# 改编设计输入\n\n> 本文件由 writing-loop source intake 登记；原著全文不进入 Git。\n> Source-intake: \`${manifest.planId}\`\n\n## 原著指纹\n\n- 标题：${manifest.source.title}\n- 文件名：\`${manifest.source.fileName}\`\n- SHA-256：\`${manifest.source.sha256}\`\n- 字节数：${manifest.source.byteLength}\n- UTF-8 行数：${manifest.source.lineCount}\n- 本地分块：${manifest.chunking.chunks.length}\n\n## 操作者改编设计\n\n${brief}\n\n## 权利范围\n\n${manifest.adaptation.rightsScope}\n\n## 模型处理授权\n\n- 允许的 Harness：${consent.allowedHarnesses.join("、")}\n- 已明确允许按分析票把原著分块发送给上述 Harness：是\n- 确认时间：${consent.confirmedAt}\n`;
}
function sourceReadme(): string {
  return `# 原著分析工作区\n\n- \`adaptation-brief.md\`：操作者提供的改编设计与原著指纹。\n- \`analysis-plan.md\`：由 writing-loop story-designer 的 source-analysis 模式生成。\n- \`deconstruction/chunks/\`：逐块摘要；不复制大段原文。\n- \`mainline.md\` / \`highlights.md\` / \`characters-function.md\`：只有 source-analysis 汇总门通过后才填充。\n\n原著全文只存于项目运行态，不进入 Git；未经 intake 中的明确 Harness 授权不得读取。\n`;
}

function ensureRuntime(root: string, key: string, facts: ReturnType<typeof sourceFacts>, createdAt: string): { manifest: SourceIntakeManifest; replayed: boolean } {
  const data = projectDataDir(root, key);
  const finalDir = join(data, SOURCE_DIR);
  const manifest: SourceIntakeManifest = {
    version: 1, kind: "writing-loop/source-intake", planId: facts.planId, projectKey: key, createdAt,
    source: { title: facts.source.title, fileName: facts.source.fileName, sha256: facts.source.sha256,
      byteLength: facts.source.byteLength, lineCount: facts.source.lineCount,
      normalizedSha256: facts.source.normalizedSha256, storedPath: "original/source.txt" },
    adaptation: { briefSha256: hash(facts.parsed.request.adaptationBrief), rightsScope: facts.parsed.request.rightsScope,
      processingConsent: facts.parsed.request.processingConsent },
    chunking: { algorithm: "heading-line-v1", targetBytes: TARGET_CHUNK_BYTES,
      maxSectionsPerChunk: MAX_SECTIONS_PER_CHUNK,
      chunks: facts.chunks.map(({ content: _content, ...chunk }) => chunk) },
  };
  if (existsSync(finalDir)) {
    const existing = parseManifest(readJson(join(finalDir, MANIFEST_FILE)));
    const expected = { ...manifest, createdAt: existing.createdAt };
    if (canonical(existing) !== canonical(expected)) {
      throw new SourceIntakeError("项目已有不同 source intake，拒绝覆盖");
    }
    const verifyBlob = (file: string, expectedLength: number, expectedSha256: string): void => {
      let pinned: ReturnType<typeof readPinnedSource>;
      try { pinned = readPinnedSource(file); }
      catch (error) { throw new SourceIntakeError(`source intake 运行态损坏：${error instanceof Error ? error.message : String(error)}`); }
      if (pinned.bytes.length !== expectedLength || hash(pinned.bytes) !== expectedSha256) {
        throw new SourceIntakeError(`source intake 运行态损坏：${relative(finalDir, file)} 与 manifest 不一致`);
      }
    };
    verifyBlob(join(finalDir, existing.source.storedPath), existing.source.byteLength, existing.source.sha256);
    for (const chunk of existing.chunking.chunks) verifyBlob(join(finalDir, chunk.path), chunk.byteLength, chunk.sha256);
    return { manifest: existing, replayed: true };
  }
  const temp = join(data, `.source-intake.${process.pid}.${randomUUID()}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    mkdirSync(join(temp, "original"), { mode: 0o700 });
    mkdirSync(join(temp, "chunks"), { mode: 0o700 });
    writeDurable(join(temp, "original", "source.txt"), facts.parsed.bytes, 0o600);
    for (const chunk of facts.chunks) writeDurable(join(temp, chunk.path), chunk.content, 0o600);
    writeDurable(join(temp, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", 0o600);
    fsyncDir(join(temp, "original")); fsyncDir(join(temp, "chunks")); fsyncDir(temp);
    renameSync(temp, finalDir); fsyncDir(data);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { manifest, replayed: false };
}

function ensureRepoDocs(repo: string, manifest: SourceIntakeManifest, brief: string): string {
  const status = git(repo, ["status", "--porcelain"]);
  const briefFile = join(repo, "source", "adaptation-brief.md");
  const readmeFile = join(repo, "source", "README.md");
  const briefBytes = repoDocument(manifest, brief);
  const readmeBytes = sourceReadme();
  if (status) {
    const expectedDirty = new Set(["?? source/README.md", "?? source/adaptation-brief.md"]);
    const rows = status.split("\n");
    if (rows.some((row) => !expectedDirty.has(row))) throw new SourceIntakeError("剧本 repo 有无关未提交改动，拒绝登记原著");
  }
  for (const [file, bytes] of [[briefFile, briefBytes], [readmeFile, readmeBytes]] as const) {
    if (existsSync(file)) {
      if (readFileSync(file, "utf8") !== bytes) throw new SourceIntakeError(`repo 文件与 source intake 漂移：${file}`);
    } else {
      writeFileSync(file, bytes, { flag: "wx", mode: 0o644 });
    }
  }
  const post = git(repo, ["status", "--porcelain"]);
  if (post) {
    git(repo, ["add", "--", "source/adaptation-brief.md", "source/README.md"]);
    git(repo, ["commit", "-m", `source: register ${manifest.source.title} for writing-loop analysis`]);
  }
  const commit = git(repo, ["log", "-1", "--format=%H", "--", "source/adaptation-brief.md"]);
  if (!/^[0-9a-f]{40}$/.test(commit) || git(repo, ["status", "--porcelain"])) throw new SourceIntakeError("source intake repo commit 未收敛");
  return commit;
}

function ticketLabels(raw: string, add: string): string {
  return raw.replace(/^labels:\s*\[([^\]]*)\]$/m, (_all, body: string) => {
    const labels = body.split(",").map((value) => value.trim()).filter(Boolean);
    if (!labels.includes(add)) labels.push(add);
    return `labels: [${labels.join(", ")}]`;
  });
}
function ensureBoard(root: string, key: string, config: WlConfig, planId: string, manifest: SourceIntakeManifest,
  now: string): { analysisTicketId: string; outlineTicketId: string } {
  const data = projectDataDir(root, key);
  const board = join(data, "board");
  const tickets = join(board, "tickets");
  const lock = join(board, "source-intake.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: now }) + "\n"); fsyncSync(lockFd);
  } catch (error) { throw new SourceIntakeError(`source intake 板锁被占用：${errno(error) ?? String(error)}`); }
  try {
    const entries = readdirSync(tickets).filter((name) => name.endsWith(".md"));
    const outlines: Array<{ file: string; id: string }> = [];
    let existingAnalysis: { file: string; id: string } | null = null;
    let prefix = "";
    let max = 0;
    for (const name of entries) {
      const match = ID_PATTERN.exec(name);
      if (match) { prefix ||= match[1]; if (match[1] === prefix) max = Math.max(max, Number(match[2])); }
      const file = join(tickets, name);
      const raw = readFileSync(file, "utf8");
      if (/^labels:.*\boutline\b.*\bstory-designer\b/m.test(raw) && match) {
        outlines.push({ file, id: `${match[1]}-${match[2]}` });
      }
      if (raw.includes(`Source-intake: ${planId}`) && match) existingAnalysis = { file, id: `${match[1]}-${match[2]}` };
    }
    const projectEntry = projectEntries(config).find(([candidate]) => candidate === key)?.[1];
    const configuredPrefix = typeof projectEntry?.ticketPrefix === "string" ? projectEntry.ticketPrefix : prefix;
    if (!configuredPrefix || (prefix && prefix !== configuredPrefix)) throw new SourceIntakeError("ticket prefix 无法安全解析");
    if (outlines.length !== 1) throw new SourceIntakeError(`必须恰有一张 outline ticket（找到 ${outlines.length} 张）`);
    const [{ file: outlineFile, id: outlineTicketId }] = outlines;
    const analysisTicketId = existingAnalysis?.id ?? `${configuredPrefix}-${max + 1}`;
    if (!existingAnalysis) {
      const ticket = `---\nid: ${analysisTicketId}\ntitle: ${JSON.stringify(`拆解《${manifest.source.title}》并生成三清单`)}\ntype: Feature\nstate: Todo\nowner: showrunner\nlabels: [writing-loop, Feature, source-analysis, story-designer]\npriority: 1\nassignee: null\nrelatedTo: [${outlineTicketId}]\nduplicateOf: null\ncreated: ${now}\nupdated: ${now}\n---\nSource-intake: ${planId}\nSource-manifest: ${SOURCE_DIR}/${MANIFEST_FILE}\nSource-phase: plan\n\n## Context\n由 writing-loop 自己完成原著范围规划、逐块摘要和三清单聚合；禁止调用外部拆书 Skill。\n\n## Context-pack\n需读（≤8 指针）：\`source/adaptation-brief.md\`；\`.writing-loop/${key}/${SOURCE_DIR}/${MANIFEST_FILE}\`；本票。\n关键事实：原著 SHA-256=${manifest.source.sha256}；共 ${manifest.chunking.chunks.length} 块；允许 Harness=${manifest.adaptation.processingConsent.allowedHarnesses.join(",")}。\n禁读：首次 plan fire 不读原著全文，只读 manifest 中的标题和分块元数据。\n\n## Acceptance criteria\n- 先产出 \`source/analysis-plan.md\`，再按计划每 fire 处理一个原著 chunk。\n- 每块摘要写入 \`source/deconstruction/chunks/<chunk-id>.md\`，不复制大段原文。\n- 全部选中块完成后，由同一 source-analysis 票聚合三张拆书清单并交 showrunner 验收。\n- outline ticket 在本票通过前保持 Backlog/source-pending。\n\n## How to verify\nmanifest hash、selected/completed chunk 覆盖、三清单阈值与相似性门全部可机械核对。\n\n---\n## Comments\n### ${now} — source-intake\n原著已登记；等待 story-designer source-analysis 模式。\n`;
      writeDurable(join(tickets, `${analysisTicketId}.md`), ticket, 0o600);
    }
    let outline = readFileSync(outlineFile, "utf8");
    if (!outline.includes(`Source-intake: ${planId}`)) {
      const wasTodo = /^state:\s*Todo$/m.test(outline);
      outline = outline.replace(/^state:\s*Todo$/m, "state: Backlog");
      outline = ticketLabels(outline, "source-pending");
      outline = outline.replace(/^updated:.*$/m, `updated: ${now}`);
      outline += `\n### ${now} — source-intake\nstate: ${wasTodo ? "Todo → Backlog" : "Backlog（保持）"}；Source-intake: ${planId}；Blocked-by: ${analysisTicketId}。\n`;
      atomicReplace(outlineFile, outline);
    }
    const counter = { prefix: configuredPrefix, next: Math.max(max + 2, Number(analysisTicketId.split("-").at(-1)) + 1) };
    atomicReplace(join(board, "counter.json"), JSON.stringify(counter, null, 2) + "\n");
    fsyncDir(tickets); fsyncDir(board);
    return { analysisTicketId, outlineTicketId };
  } finally {
    closeSync(lockFd!);
    unlinkSync(lock); fsyncDir(board);
  }
}

export function commitSourceIntake(root: string, key: string, config: WlConfig, value: unknown, confirmation: string,
  runtime: { now?: () => Date } = {}): SourceIntakeResult {
  const nowDate = runtime.now?.() ?? new Date();
  const facts = sourceFacts(root, key, config, value, nowDate.getTime());
  if (confirmation !== facts.planId) throw new SourceIntakeError("source intake 确认指纹不匹配");
  const createdAt = nowDate.toISOString();
  const runtimeResult = ensureRuntime(root, key, facts, createdAt);
  const repoCommit = ensureRepoDocs(facts.repoPath, runtimeResult.manifest, facts.parsed.request.adaptationBrief);
  const board = ensureBoard(root, key, config, facts.planId, runtimeResult.manifest, createdAt);
  const control: SourceIntakeControl = {
    version: 1, kind: "writing-loop/source-analysis-control", planId: facts.planId,
    analysisTicketId: board.analysisTicketId, outlineTicketId: board.outlineTicketId,
    phase: "registered", selectedChunks: [], completedChunks: [], updatedAt: createdAt,
  };
  const controlFile = join(projectDataDir(root, key), SOURCE_DIR, CONTROL_FILE);
  if (existsSync(controlFile)) {
    const existing = readJson(controlFile);
    if (canonical(existing) !== canonical(control)) {
      if (!isRecord(existing) || existing.planId !== facts.planId || existing.analysisTicketId !== board.analysisTicketId) {
        throw new SourceIntakeError("source analysis control 漂移");
      }
    }
  } else writeDurable(controlFile, JSON.stringify(control, null, 2) + "\n", 0o600);
  return { planId: facts.planId, projectKey: key, sourceSha256: facts.source.sha256,
    chunkCount: facts.chunks.length, analysisTicketId: board.analysisTicketId,
    outlineTicketId: board.outlineTicketId, repoCommit, replayed: runtimeResult.replayed };
}

export function readSourceIntakeStatus(root: string, key: string): { manifest: SourceIntakeManifest; control: SourceIntakeControl } | null {
  const dir = join(projectDataDir(root, key), SOURCE_DIR);
  if (!existsSync(dir)) return null;
  const manifest = parseManifest(readJson(join(dir, MANIFEST_FILE)));
  const control = parseControl(readJson(join(dir, CONTROL_FILE)));
  if (manifest.projectKey !== key || manifest.planId !== control.planId) throw new SourceIntakeError("source intake 状态不一致");
  return { manifest, control };
}

export function selectSourceAnalysisChunks(root: string, key: string, chunkIds: string[], now = new Date()): SourceAnalysisProgress {
  if (!Array.isArray(chunkIds) || chunkIds.length < 1 || new Set(chunkIds).size !== chunkIds.length) {
    throw new SourceIntakeError("必须选择至少一个且不重复的 chunk ID");
  }
  const control = mutateControl(root, key, (manifest, current) => {
    const order = manifest.chunking.chunks.map((chunk) => chunk.id);
    const indices = chunkIds.map((id) => order.indexOf(id));
    if (indices.some((index) => index < 0)) throw new SourceIntakeError("选择包含 manifest 外的 chunk ID");
    if (indices.some((index, offset) => index !== indices[0] + offset)) {
      throw new SourceIntakeError("source analysis 必须按 manifest 顺序选择连续 chunk 窗口");
    }
    if (current.phase === "review-ready") throw new SourceIntakeError("source analysis 已冻结，不能重选范围");
    if (current.selectedChunks.length && canonical(current.selectedChunks) !== canonical(chunkIds)) {
      throw new SourceIntakeError("source analysis 范围已选定，拒绝漂移");
    }
    return { ...current, phase: "analyzing", selectedChunks: [...chunkIds], updatedAt: now.toISOString() };
  });
  return { ...progress(control), projectKey: key };
}

function progress(control: SourceIntakeControl): SourceAnalysisProgress {
  const done = new Set(control.completedChunks);
  return { projectKey: "", phase: control.phase, selectedChunks: [...control.selectedChunks],
    completedChunks: [...control.completedChunks], remainingChunks: control.selectedChunks.filter((id) => !done.has(id)) };
}

export function checkpointSourceAnalysisChunk(root: string, key: string, config: WlConfig, chunkId: string, commit: string,
  now = new Date()): SourceAnalysisProgress {
  if (!/^chunk-[0-9]{4}$/.test(chunkId) || !/^[0-9a-f]{40}$/.test(commit)) throw new SourceIntakeError("chunk ID 或 commit SHA 无效");
  const entry = projectEntries(config).find(([candidate]) => candidate === key);
  if (!entry) throw new SourceIntakeError(`config.json 无项目 '${key}'`);
  const repo = resolveRepoPath(root, entry[1]);
  const summary = join(repo, "source", "deconstruction", "chunks", `${chunkId}.md`);
  const control = mutateControl(root, key, (manifest, current) => {
    if (current.phase !== "analyzing" || !current.selectedChunks.includes(chunkId)) throw new SourceIntakeError("chunk 不在当前分析范围");
    const fact = manifest.chunking.chunks.find((chunk) => chunk.id === chunkId);
    if (!fact) throw new SourceIntakeError("chunk 不在 manifest");
    if (!existsSync(summary)) throw new SourceIntakeError(`缺少 chunk 摘要：${summary}`);
    const raw = readFileSync(summary, "utf8");
    if (!raw.includes(`Source-intake: ${manifest.planId}`) || !raw.includes(`Source-chunk: ${chunkId}`)
      || !raw.includes(`Source-sha256: ${fact.sha256}`)) throw new SourceIntakeError("chunk 摘要缺少精确 provenance 标记");
    const fileCommit = git(repo, ["log", "-1", "--format=%H", "--", relative(repo, summary)]);
    if (fileCommit !== commit || git(repo, ["status", "--porcelain"])) throw new SourceIntakeError("chunk 摘要 commit 不匹配或 repo 不干净");
    const completed = current.completedChunks.includes(chunkId) ? current.completedChunks : [...current.completedChunks, chunkId];
    return { ...current, completedChunks: completed, updatedAt: now.toISOString() };
  });
  return { ...progress(control), projectKey: key };
}

export function finalizeSourceAnalysis(root: string, key: string, config: WlConfig, now = new Date()): SourceAnalysisProgress {
  const entry = projectEntries(config).find(([candidate]) => candidate === key);
  if (!entry) throw new SourceIntakeError(`config.json 无项目 '${key}'`);
  const repo = resolveRepoPath(root, entry[1]);
  const control = mutateControl(root, key, (manifest, current) => {
    if (current.phase !== "analyzing" && current.phase !== "review-ready") throw new SourceIntakeError("source analysis 尚未进入 analyzing");
    if (!current.selectedChunks.length || current.completedChunks.length !== current.selectedChunks.length
      || current.selectedChunks.some((id) => !current.completedChunks.includes(id))) throw new SourceIntakeError("仍有未完成的 source chunk");
    for (const name of ["mainline.md", "highlights.md", "characters-function.md"]) {
      const file = join(repo, "source", name);
      const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (raw.length < 400 || !raw.includes(`Source-intake: ${manifest.planId}`)) {
        throw new SourceIntakeError(`${name} 尚未形成带 provenance 的结构化拆解`);
      }
    }
    if (git(repo, ["status", "--porcelain"])) throw new SourceIntakeError("repo 有未提交改动，不能提交 source-analysis 验收");
    return { ...current, phase: "review-ready", updatedAt: now.toISOString() };
  });
  return { ...progress(control), projectKey: key };
}

export const SOURCE_INTAKE_RUNTIME_DIR = SOURCE_DIR;
