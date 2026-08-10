// 按需详情读取：摘要 snapshot 不携带完整 Markdown；Ticket、剧情文档、分集与报告只在
// 用户打开详情时读取。所有请求都先通过服务端 registry 解析，绝不接受任意 path。
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { hasSymlinkComponent, readDirectoryNames } from "./bounded-fs.ts";
import { episodeNumberFromFile, parseTicketFrontmatter, type Ticket } from "./status.ts";
import { assertProjectKey, projectDataDir, projectEntries, resolveRepoPath, WsError, type Workspace, type WlProject } from "./workspace.ts";

export const PROJECT_DOCUMENTS = [
  ["north-star", "北极星", "bible/north-star.md"],
  ["characters", "人物圣经", "bible/characters.md"],
  ["world", "世界圣经", "bible/world.md"],
  ["outline", "总大纲", "outline.md"],
  ["foreshadow", "伏笔账本", "ledgers/foreshadow.md"],
  ["story-state", "故事状态", "ledgers/story-state.md"],
  ["production", "制作账本", "ledgers/production.md"],
] as const;

const DETAIL_LIMIT = 1024 * 1024;
const DIRECTORY_ENTRY_LIMIT = 2_048;
const REPORT_LIMIT = 200;
const REPORT_NAME = /^[A-Za-z0-9_.\-\u4e00-\u9fff]{1,160}\.md$/u;

export type TicketComment = {
  at: string | null;
  actor: string;
  body: string;
  stateChange: { from: string; to: string } | null;
};

export type TicketDetail = {
  summary: Ticket;
  created: string | null;
  relatedTo: string[];
  duplicateOf: string | null;
  sections: {
    context: string | null;
    contextPack: string | null;
    acceptanceCriteria: string | null;
    howToVerify: string | null;
  };
  comments: TicketComment[];
};

export type ProjectResourceKind = "ticket" | "document" | "episode" | "report" | "evaluation";
export type ProjectResource = {
  schemaVersion: 1;
  project: string;
  kind: ProjectResourceKind;
  id: string;
  title: string;
  relativePath: string;
  updatedAt: string;
  bytes: number;
  etag: string;
  content: string;
  truncated: boolean;
  ticket: TicketDetail | null;
};
export type ProjectResourceReadOptions = {
  maxBytes?: number;
  tailBytes?: number;
  ticketFile?: string;
  /** Test seam used to deterministically exercise an intermediate-directory replacement race. */
  beforeOpen?: (target: string) => void;
};

export type ReportSummary = {
  id: string;
  file: string;
  label: string;
  bytes: number;
  updatedAt: string;
  review: boolean;
};
export type ReportList = { rows: ReportSummary[]; truncated: boolean };

const ownProject = (ws: Workspace, key: string): WlProject => {
  assertProjectKey(key);
  const project = projectEntries(ws.config).find(([candidate]) => candidate === key)?.[1];
  if (!project) throw new WsError(`config.json 无项目 '${key}'`);
  return project;
};

function safeMarkdown(
  root: string,
  parts: string[],
  limit = DETAIL_LIMIT,
  tailBytes = 0,
  beforeOpen?: (target: string) => void,
): { content: string; bytes: number; updatedAt: string; truncated: boolean } {
  const rootReal = realpathSync(root);
  const target = join(rootReal, ...parts);
  let originalCursor = rootReal;
  for (const component of parts) {
    if (!component || component === "." || component === ".." || component.includes("\0")) throw new WsError("详情文件路径无效");
    originalCursor = join(originalCursor, component);
    if (lstatSync(originalCursor).isSymbolicLink()) throw new WsError("详情接口不跟随符号链接");
  }
  const targetReal = realpathSync(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) throw new WsError("详情文件越出允许的项目根");
  const rel = relative(rootReal, targetReal);
  if (!rel || rel.startsWith("..") || rel.includes("\0")) throw new WsError("详情文件路径无效");
  beforeOpen?.(target);
  let fd: number | undefined;
  try {
    fd = openSync(targetReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new WsError("详情目标不是普通文件");
    // Re-resolve the original path after open and bind it to the fd identity. This catches an
    // intermediate directory replaced between validation and open; O_NOFOLLOW covers the final
    // component while this second pass covers the component chain.
    let afterCursor = rootReal;
    for (const component of parts) {
      afterCursor = join(afterCursor, component);
      if (lstatSync(afterCursor).isSymbolicLink()) throw new WsError("详情接口不跟随符号链接");
    }
    const afterReal = realpathSync(target);
    if (afterReal !== rootReal && !afterReal.startsWith(rootReal + sep)) throw new WsError("详情文件越出允许的项目根");
    const afterStat = statSync(afterReal);
    if (afterStat.dev !== stat.dev || afterStat.ino !== stat.ino) throw new WsError("详情文件在打开竞争窗中被替换");
    const readRange = (start: number, length: number): Buffer => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(fd!, buffer, offset, length - offset, start + offset);
        if (!count) break;
        offset += count;
      }
      return buffer.subarray(0, offset);
    };
    const headLength = Math.min(stat.size, limit);
    const tailStart = tailBytes > 0 ? Math.max(headLength, stat.size - tailBytes) : stat.size;
    const head = readRange(0, headLength);
    const tail = tailStart < stat.size ? readRange(tailStart, stat.size - tailStart) : Buffer.alloc(0);
    const gap = tailBytes > 0 && tailStart > headLength;
    const content = head.toString("utf8") + (gap ? "\n\n<!-- bounded middle omitted -->\n\n## Comments\n" : "") + tail.toString("utf8");
    if (content.includes("\0")) throw new WsError("详情接口只允许文本 Markdown");
    return { content, bytes: stat.size, updatedAt: stat.mtime.toISOString(), truncated: gap || (tailBytes === 0 && stat.size > limit) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const stripQuotes = (value: string): string => value.trim().replace(/^["']|["']$/g, "");
const yamlArray = (raw: string): string[] => {
  const match = /^\[(.*)\]$/.exec(raw.trim());
  return match ? match[1].split(",").map(stripQuotes).filter(Boolean) : [];
};

function section(body: string, heading: RegExp): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const value = out.join("\n").trim();
  return value || null;
}

export function parseTicketDetail(content: string, file = ""): TicketDetail {
  const summary = (awaitTicketSummary(content, file));
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const end = lines.slice(1).findIndex((line) => line.trim() === "---") + 1;
  if (end <= 0) throw new WsError(`票 ${file || summary.id} 缺少闭合 frontmatter`);
  const frontmatter = lines.slice(1, end);
  const scalar = (key: string): string => {
    const line = frontmatter.find((item) => item.startsWith(`${key}:`));
    return line ? stripQuotes(line.slice(key.length + 1)) : "";
  };
  const body = lines.slice(end + 1).join("\n");
  const commentsStart = body.search(/^##[ \t]+Comments[ \t]*$/m);
  const commentsBody = commentsStart >= 0 ? body.slice(commentsStart) : "";
  const commentRe = /^###[ \t]+([^\n—]+?)[ \t]+—[ \t]+([^\n]+)\r?$/gm;
  const commentHeaders = [...commentsBody.matchAll(commentRe)];
  const comments: TicketComment[] = [];
  for (let index = 0; index < commentHeaders.length; index++) {
    const match = commentHeaders[index];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = commentHeaders[index + 1]?.index ?? commentsBody.length;
    const commentBody = commentsBody.slice(bodyStart, bodyEnd).trim();
    const change = /state:[ \t]*([^\n→]+?)[ \t]*→[ \t]*([^\n。；]+)/i.exec(commentBody);
    comments.push({
      at: Number.isNaN(Date.parse(match[1].trim())) ? null : match[1].trim(),
      actor: match[2].trim(),
      body: commentBody,
      stateChange: change ? { from: change[1].trim(), to: change[2].trim() } : null,
    });
  }
  return {
    summary,
    created: scalar("created") || null,
    relatedTo: yamlArray(scalar("relatedTo")),
    duplicateOf: scalar("duplicateOf") && !["null", "~"].includes(scalar("duplicateOf")) ? scalar("duplicateOf") : null,
    sections: {
      context: section(body, /^##[ \t]+Context$/i),
      contextPack: section(body, /^##[ \t]+Context-pack$/i),
      acceptanceCriteria: section(body, /^##[ \t]+Acceptance criteria$/i),
      howToVerify: section(body, /^##[ \t]+How to verify$/i),
    },
    comments,
  };
}

// parseTicketFrontmatter 保持唯一摘要解析器；单独函数让上方同步 parser 清晰处理 null。
function awaitTicketSummary(content: string, file: string): Ticket {
  const parsed = parseTicketFrontmatter(content, file);
  if (!parsed) throw new WsError(`票 ${file || "(unknown)"} 无法解析 frontmatter`);
  return parsed;
}

const reportId = (file: string): string => createHash("sha256").update(file).digest("hex").slice(0, 16);

function listMarkdownDir(dir: string): ReportList {
  const scanned = readDirectoryNames(dir, DIRECTORY_ENTRY_LIMIT);
  const out: ReportSummary[] = [];
  for (const file of scanned.names) {
    if (!REPORT_NAME.test(file)) continue;
    try {
      const path = join(dir, file);
      const lst = lstatSync(path);
      if (!lst.isFile() || lst.isSymbolicLink()) continue;
      out.push({
        id: reportId(file),
        file,
        label: file.replace(/\.md$/, "").replace(/[-_]+/g, " "),
        bytes: lst.size,
        updatedAt: lst.mtime.toISOString(),
        review: file.endsWith(".review.md"),
      });
    } catch { /* 扫描间隙变化即跳过 */ }
  }
  out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.file.localeCompare(b.file));
  return { rows: out.slice(0, REPORT_LIMIT), truncated: scanned.truncated || out.length > REPORT_LIMIT };
}

export function listProjectReports(ws: Workspace, key: string): ReportSummary[] {
  return listProjectReportsBounded(ws, key).rows;
}

export function listProjectReportsBounded(ws: Workspace, key: string): ReportList {
  ownProject(ws, key);
  if (hasSymlinkComponent(ws.root, [".writing-loop", key, "reports"])) {
    throw new WsError(`项目 '${key}' 的运行态路径含符号链接`);
  }
  return listMarkdownDir(join(projectDataDir(ws.root, key), "reports"));
}

export function listProjectEvaluations(ws: Workspace, key: string): ReportSummary[] {
  return listProjectEvaluationsBounded(ws, key).rows;
}

export function listProjectEvaluationsBounded(ws: Workspace, key: string): ReportList {
  const project = ownProject(ws, key);
  return listMarkdownDir(join(resolveRepoPath(ws.root, project), "evaluation"));
}

function reportFileById(rows: ReportSummary[], id: string): string | null {
  return rows.find((row) => row.id === id)?.file ?? null;
}

export function readProjectResource(
  ws: Workspace,
  key: string,
  kind: ProjectResourceKind,
  id: string,
  options: ProjectResourceReadOptions = {},
): ProjectResource {
  const project = ownProject(ws, key);
  if (id.length < 1 || id.length > 180 || /[\0\\/]/.test(id)) throw new WsError("详情 id 无效");
  const repo = resolveRepoPath(ws.root, project);
  let root: string;
  let parts: string[];
  let title: string;
  let ticket: TicketDetail | null = null;
  let relativePath: string;

  if (kind === "ticket") {
    const file = options.ticketFile ?? `${id}.md`;
    if (basename(file) !== file || !file.endsWith(".md") || file.length > 200) throw new WsError(`没有创作任务 '${id}'`);
    root = ws.root;
    parts = [".writing-loop", key, "board", "tickets", file];
    title = id;
    relativePath = `board/tickets/${file}`;
  } else if (kind === "document") {
    const doc = PROJECT_DOCUMENTS.find(([docKey]) => docKey === id);
    if (!doc) throw new WsError(`没有剧情文档 '${id}'`);
    root = repo;
    parts = doc[2].split("/");
    title = doc[1];
    relativePath = doc[2];
  } else if (kind === "episode") {
    if (!/^\d{1,6}$/.test(id)) throw new WsError("分集 id 必须是数字");
    let file: string | null = null;
    try {
      file = readDirectoryNames(join(repo, "episodes"), DIRECTORY_ENTRY_LIMIT).names.find((name) => {
        return episodeNumberFromFile(name) === Number(id);
      }) ?? null;
    } catch { file = null; }
    if (!file) throw new WsError(`没有第 ${Number(id)} 集`);
    root = repo;
    parts = ["episodes", file];
    title = `第 ${Number(id)} 集`;
    relativePath = `episodes/${file}`;
  } else if (kind === "report") {
    const file = reportFileById(listProjectReports(ws, key), id);
    if (!file) throw new WsError(`没有报告 '${id}'`);
    root = ws.root;
    parts = [".writing-loop", key, "reports", file];
    title = file.replace(/\.md$/, "");
    relativePath = `reports/${file}`;
  } else {
    const file = reportFileById(listProjectEvaluations(ws, key), id);
    if (!file) throw new WsError(`没有评估 '${id}'`);
    root = repo;
    parts = ["evaluation", file];
    title = file.replace(/\.md$/, "");
    relativePath = `evaluation/${file}`;
  }

  const limit = Math.min(DETAIL_LIMIT, Math.max(1, Math.trunc(options.maxBytes ?? DETAIL_LIMIT)));
  const tailBytes = Math.min(DETAIL_LIMIT, Math.max(0, Math.trunc(options.tailBytes ?? 0)));
  let read: ReturnType<typeof safeMarkdown>;
  try { read = safeMarkdown(root, parts, limit, tailBytes, options.beforeOpen); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code) : "";
    if (kind === "ticket" && (code === "ENOENT" || code === "ENOTDIR")) throw new WsError(`没有创作任务 '${id}'`);
    throw error;
  }
  if (kind === "ticket") {
    ticket = parseTicketDetail(read.content, basename(parts.at(-1)!));
    if (ticket.summary.id !== id) throw new WsError(`没有创作任务 '${id}'`);
    title = ticket.summary.title;
  }
  if (kind === "episode") {
    const heading = /^#[ \t]+(.+)$/m.exec(read.content)?.[1]?.trim();
    if (heading) title = heading;
  }
  return {
    schemaVersion: 1,
    project: key,
    kind,
    id,
    title,
    relativePath,
    updatedAt: read.updatedAt,
    bytes: read.bytes,
    etag: createHash("sha256").update(read.content).digest("hex"),
    content: read.content,
    truncated: read.truncated,
    ticket,
  };
}
