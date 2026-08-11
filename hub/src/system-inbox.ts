// Workspace-scoped Writing Loop maintenance inbox. Framework/process proposals belong here,
// never on a drama project's creative board. Records are immutable, content-addressed and
// bounded; a legacy project ticket can be durably captured before it is removed from the board.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { hasSymlinkComponent, readDirectoryNames, readRegularTextExact } from "./bounded-fs.ts";
import { productionCanonicalJson } from "./production-canonical-json.ts";
import { parseTicketFrontmatter } from "./status.ts";
import {
  assertProjectKey, dataRoot, projectDataDir, projectEntries, type WlConfig, WsError,
} from "./workspace.ts";

const MAX_PROPOSAL_BYTES = 256 * 1024;
const MAX_PROPOSALS = 500;
const ID_PATTERN = /^WLSYS-[a-f0-9]{24}$/;
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export type SystemProposalStatus = "open" | "applied" | "dismissed";

export type SystemProposalDraft = {
  version: 1;
  kind: "framework-improvement";
  title: string;
  summary: string;
  evidence: string[];
  proposedChange: string;
  source: {
    project: string;
    agent: string;
    projectTicket: { id: string; sha256: string; markdown: string } | null;
  };
};

export type SystemProposalResolution = {
  status: "applied" | "dismissed";
  at: string;
  note: string;
  commit: string | null;
};

export type SystemProposal = SystemProposalDraft & {
  id: string;
  fingerprint: string;
  status: SystemProposalStatus;
  createdAt: string;
  resolution: SystemProposalResolution | null;
};

export type SystemProposalList = {
  version: 1;
  proposals: SystemProposal[];
  counts: Record<SystemProposalStatus, number>;
  warnings: string[];
};

function fail(message: string): never { throw new WsError(`system inbox: ${message}`); }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asciiCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(asciiCompare);
  const expected = [...keys].sort(asciiCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} 字段必须精确为 ${expected.join(", ")}`);
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL.test(value)) {
    fail(`${label} 必须是 1–${max} 字符的安全非空字符串`);
  }
  return (value as string).trim();
}

function exactText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL.test(value)) {
    fail(`${label} 必须是 1–${max} 字符的安全非空字符串`);
  }
  return value as string;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || Number.isNaN(Date.parse(parsed))) fail(`${label} 必须是毫秒精度 UTC ISO 时间`);
  return parsed;
}

export function parseSystemProposalDraft(value: unknown): SystemProposalDraft {
  if (!record(value)) fail("proposal draft 必须是对象");
  const row = value as Record<string, unknown>;
  exactKeys(row, ["version", "kind", "title", "summary", "evidence", "proposedChange", "source"], "proposal draft");
  if (row.version !== 1 || row.kind !== "framework-improvement") fail("proposal draft version/kind 无效");
  if (!Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 32) {
    fail("evidence 必须含 1–32 条证据");
  }
  const evidence = row.evidence as unknown[];
  if (!record(row.source)) fail("source 必须是对象");
  const source = row.source as Record<string, unknown>;
  exactKeys(source, ["project", "agent", "projectTicket"], "source");
  const project = text(source.project, "source.project", 32);
  assertProjectKey(project);
  const agent = text(source.agent, "source.agent", 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) fail("source.agent 必须是安全 agent ID");
  let projectTicket: SystemProposalDraft["source"]["projectTicket"] = null;
  if (source.projectTicket !== null) {
    if (!record(source.projectTicket)) fail("source.projectTicket 必须是对象或 null");
    const projectTicketRow = source.projectTicket as Record<string, unknown>;
    exactKeys(projectTicketRow, ["id", "sha256", "markdown"], "source.projectTicket");
    const id = text(projectTicketRow.id, "source.projectTicket.id", 32);
    if (!TICKET_ID_PATTERN.test(id)) fail("source.projectTicket.id 无效");
    const digest = text(projectTicketRow.sha256, "source.projectTicket.sha256", 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) fail("source.projectTicket.sha256 无效");
    const markdown = exactText(projectTicketRow.markdown, "source.projectTicket.markdown", 128 * 1024);
    if (sha256(markdown) !== digest) fail("source.projectTicket markdown 与 sha256 不匹配");
    projectTicket = { id, sha256: digest, markdown };
  }
  return {
    version: 1,
    kind: "framework-improvement",
    title: text(row.title, "title", 180),
    summary: text(row.summary, "summary", 4_000),
    evidence: evidence.map((item, index) => text(item, `evidence[${index}]`, 2_000)),
    proposedChange: text(row.proposedChange, "proposedChange", 12_000),
    source: { project, agent, projectTicket },
  };
}

function fingerprintOf(draft: SystemProposalDraft): string {
  return sha256(productionCanonicalJson(draft));
}

export function parseSystemProposal(value: unknown): SystemProposal {
  if (!record(value)) fail("proposal 必须是对象");
  const row = value as Record<string, unknown>;
  exactKeys(row, ["version", "kind", "id", "fingerprint", "status", "createdAt", "title", "summary", "evidence", "proposedChange", "source", "resolution"], "proposal");
  const draft = parseSystemProposalDraft({
    version: row.version, kind: row.kind, title: row.title, summary: row.summary,
    evidence: row.evidence, proposedChange: row.proposedChange, source: row.source,
  });
  const id = text(row.id, "id", 30);
  const fingerprint = text(row.fingerprint, "fingerprint", 64);
  if (!ID_PATTERN.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint) || id !== `WLSYS-${fingerprint.slice(0, 24)}`) {
    fail("proposal id/fingerprint 无效");
  }
  if (fingerprintOf(draft) !== fingerprint) fail("proposal 内容与 fingerprint 漂移");
  if (!new Set(["open", "applied", "dismissed"]).has(String(row.status))) fail("proposal status 无效");
  const status = row.status as SystemProposalStatus;
  let resolution: SystemProposalResolution | null = null;
  if (row.resolution !== null) {
    if (!record(row.resolution)) fail("resolution 必须是对象或 null");
    const resolutionRow = row.resolution as Record<string, unknown>;
    exactKeys(resolutionRow, ["status", "at", "note", "commit"], "resolution");
    if (resolutionRow.status !== "applied" && resolutionRow.status !== "dismissed") fail("resolution.status 无效");
    const commit = resolutionRow.commit === null ? null : text(resolutionRow.commit, "resolution.commit", 64);
    if (commit !== null && !/^[a-f0-9]{7,64}$/.test(commit)) fail("resolution.commit 无效");
    resolution = {
      status: resolutionRow.status,
      at: timestamp(resolutionRow.at, "resolution.at"),
      note: text(resolutionRow.note, "resolution.note", 4_000),
      commit,
    };
  }
  if ((status === "open") !== (resolution === null) || (resolution && resolution.status !== status)) {
    fail("proposal status 与 resolution 不一致");
  }
  return { ...draft, id, fingerprint, status, createdAt: timestamp(row.createdAt, "createdAt"), resolution };
}

export function systemProposalDirectory(root: string): string {
  return join(dataRoot(root), "system", "proposals");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${path} 必须是真实目录`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(dirname(path));
  }
}

function ensureInbox(root: string): string {
  const base = dataRoot(root);
  if (hasSymlinkComponent(root, [".writing-loop"])) fail(".writing-loop 不能是符号链接");
  ensureDirectory(base);
  ensureDirectory(join(base, "system"));
  ensureDirectory(join(base, "system", "proposals"));
  if (hasSymlinkComponent(root, [".writing-loop", "system", "proposals"])) fail("system inbox 路径不能含符号链接");
  return systemProposalDirectory(root);
}

function readProposalFile(file: string): SystemProposal | null {
  const raw = readRegularTextExact(file, MAX_PROPOSAL_BYTES);
  if (raw === null) return null;
  try { return parseSystemProposal(JSON.parse(raw)); }
  catch { return null; }
}

export function fileSystemProposal(
  root: string,
  rawDraft: unknown,
  options: { status?: SystemProposalStatus; resolutionNote?: string; resolutionCommit?: string | null; now?: () => Date } = {},
): { proposal: SystemProposal; created: boolean } {
  const draft = parseSystemProposalDraft(rawDraft);
  const status = options.status ?? "open";
  if (!new Set(["open", "applied", "dismissed"]).has(status)) fail("status 无效");
  const now = (options.now ?? (() => new Date()))().toISOString();
  const resolution = status === "open" ? null : {
    status,
    at: now,
    note: text(options.resolutionNote, "resolutionNote", 4_000),
    commit: options.resolutionCommit === null || options.resolutionCommit === undefined
      ? null : text(options.resolutionCommit, "resolutionCommit", 64),
  } as SystemProposalResolution;
  const fingerprint = fingerprintOf(draft);
  const proposal = parseSystemProposal({
    ...draft, id: `WLSYS-${fingerprint.slice(0, 24)}`, fingerprint, status, createdAt: now, resolution,
  });
  const dir = ensureInbox(root);
  const file = join(dir, `${proposal.id}.json`);
  const serialized = JSON.stringify(proposal, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_PROPOSAL_BYTES) fail("proposal 超过 256 KiB");
  const existing = readProposalFile(file);
  if (existing) return { proposal: existing, created: false };
  let fd: number | undefined;
  const temporary = join(dir, `.proposal-${process.pid}-${randomUUID()}.tmp`);
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    try { linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = readProposalFile(file);
      if (!winner || winner.fingerprint !== fingerprint) fail(`并发 proposal winner ${file} 损坏或冲突`);
      return { proposal: winner as SystemProposal, created: false };
    }
    unlinkSync(temporary);
    fsyncDirectory(dir);
    return { proposal, created: true };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* preserve primary error */ }
    try { unlinkSync(temporary); } catch { /* published or never created */ }
  }
}

export function readSystemProposal(root: string, id: string): SystemProposal | null {
  if (!ID_PATTERN.test(id)) return null;
  if (hasSymlinkComponent(root, [".writing-loop", "system", "proposals"])) return null;
  return readProposalFile(join(systemProposalDirectory(root), `${id}.json`));
}

export function listSystemProposals(root: string): SystemProposalList {
  const scan = readDirectoryNames(systemProposalDirectory(root), MAX_PROPOSALS + 1);
  const warnings: string[] = [];
  if (scan.truncated || scan.names.length > MAX_PROPOSALS) warnings.push("系统建议超过 500 条，只展示有界集合");
  const proposals: SystemProposal[] = [];
  for (const name of scan.names.filter((item) => ID_PATTERN.test(item.replace(/\.json$/, "")) && item.endsWith(".json")).slice(0, MAX_PROPOSALS)) {
    const proposal = readProposalFile(join(systemProposalDirectory(root), name));
    if (proposal && `${proposal.id}.json` === name) proposals.push(proposal);
    else warnings.push(`忽略损坏的系统建议 ${basename(name)}`);
  }
  proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || asciiCompare(a.id, b.id));
  return {
    version: 1,
    proposals,
    counts: {
      open: proposals.filter((item) => item.status === "open").length,
      applied: proposals.filter((item) => item.status === "applied").length,
      dismissed: proposals.filter((item) => item.status === "dismissed").length,
    },
    warnings,
  };
}

function assertKnownProject(config: WlConfig, project: string): void {
  if (!projectEntries(config).some(([key]) => key === project)) fail(`config.json 无项目 '${project}'`);
}

export function migrateReflectProposalTicket(
  root: string,
  config: WlConfig,
  project: string,
  ticketId: string,
  options: { status?: SystemProposalStatus; resolutionNote?: string; resolutionCommit?: string | null; now?: () => Date } = {},
): { proposal: SystemProposal; created: boolean; removedTicket: boolean } {
  assertProjectKey(project);
  assertKnownProject(config, project);
  if (!TICKET_ID_PATTERN.test(ticketId)) fail("ticket ID 无效");
  const tickets = join(projectDataDir(root, project), "board", "tickets");
  const file = join(tickets, `${ticketId}.md`);
  const markdown = readRegularTextExact(file, 128 * 1024);
  if (markdown === null) fail(`无法安全读取 ${file}`);
  const ticketMarkdown = markdown as string;
  const ticket = parseTicketFrontmatter(ticketMarkdown, `${ticketId}.md`);
  if (!ticket || ticket.id !== ticketId || ticket.malformed || ticket.type !== "Improvement"
    || ticket.owner !== "showrunner" || !ticket.title.startsWith("[reflect-proposal] ")
    || !["writing-loop", "blocked", "needs-showrunner", "external-prereq"].every((label) => ticket.labels.includes(label))) {
    fail(`${ticketId} 不是可迁移的 reflect 框架提案票`);
  }
  const validTicket = ticket!;
  const digest = sha256(ticketMarkdown);
  const proposalDraft: SystemProposalDraft = {
    version: 1,
    kind: "framework-improvement",
    title: validTicket.title.slice("[reflect-proposal] ".length),
    summary: `来自项目 ${project} 的 reflect 运行证据。该事项属于 Writing Loop 框架维护，不属于剧集创作任务。`,
    evidence: [`project=${project}`, `legacyTicket=${ticketId}`, `legacyTicketSha256=${digest}`],
    proposedChange: "原始提案、验收标准和评论已完整保存在 source.projectTicket.markdown；由 Writing Loop 维护者在系统层处理。",
    source: { project, agent: "reflect", projectTicket: { id: ticketId, sha256: digest, markdown: ticketMarkdown } },
  };
  const filed = fileSystemProposal(root, proposalDraft, options);
  const lock = `${file}.lock`;
  let lockFd: number | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  try {
    lockFd = openSync(lock, "wx", 0o600);
    const identity = fstatSync(lockFd);
    lockIdentity = { dev: identity.dev, ino: identity.ino };
    writeFileSync(lockFd, `holder pid=${process.pid} at=${new Date().toISOString()}\n`, "utf8");
    fsyncSync(lockFd);
    const current = readRegularTextExact(file, 128 * 1024);
    if (current === null || sha256(current) !== digest) fail(`${ticketId} 在迁移期间发生变化，未移除`);
    unlinkSync(file);
    fsyncDirectory(tickets);
    return { ...filed, removedTicket: true };
  } finally {
    if (lockFd !== undefined) try { closeSync(lockFd); } catch { /* preserve primary error */ }
    try {
      const current = statSync(lock);
      if (lockIdentity && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) unlinkSync(lock);
    } catch { /* no owned lock remains */ }
  }
}
