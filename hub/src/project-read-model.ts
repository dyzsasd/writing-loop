// writing-loop 编剧工作台的稳定只读投影。
// UI/API 只消费本模块 DTO，不各自重新解释 config、Markdown 票、剧本 repo 与运行遥测。
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { aggregate } from "./fires.ts";
import { hasSymlinkComponent, readDirectoryNames, readRegularTextHead } from "./bounded-fs.ts";
import { PROJECT_DOCUMENTS, listProjectEvaluationsBounded, listProjectReportsBounded } from "./project-detail.ts";
import { readStoryDesign } from "./story-design.ts";
import { episodeNumberFromFile, isCleanFire, listTickets, readFiresBounded, type FireRow, type Ticket } from "./status.ts";
import { projectDataDir, projectEntries, resolveRepoPath, WsError, type Workspace, type WlProject } from "./workspace.ts";

const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]);
const DIRECTORY_ENTRY_LIMIT = 2_048;
const SUMMARY_HEAD_BYTES = 64 * 1024;

export type SchedulerView = {
  state: "running" | "stopping" | "stale" | "stopped";
  pid: number | null;
  cli: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  inFlight: Array<{
    agent: string;
    pid: number | null;
    model: string;
    effort: string;
    startedAt: string;
    capSeconds: number;
    logFile: string;
  }>;
};

export type EpisodeView = {
  number: number;
  file: string;
  title: string;
  arc: string | null;
  hookType: string | null;
  words: number | null;
  updatedAt: string | null;
};

export type ProjectSnapshot = {
  key: string;
  title: string;
  enabled: boolean;
  repoPath: string;
  repoExists: boolean;
  format: string | null;
  genre: string | null;
  monetization: string | null;
  audience: string | null;
  seasonStrategy: "single-season" | "multi-season" | "undecided" | null;
  currentSeason: number | null;
  logline: string | null;
  progress: {
    frontier: number;
    written: number;
    totalEpisodes: number | null;
    percent: number | null;
    latestFile: string | null;
    storyArcs: number;
    evaluations: number;
  };
  board: {
    total: number;
    open: number;
    malformed: number;
    counts: Record<string, number>;
    needsAttention: Ticket[];
    inProgress: Ticket[];
    inReview: Ticket[];
    tickets: Ticket[];
  };
  scheduler: SchedulerView;
  telemetry: {
    totalFires: number;
    successfulFires: number;
    successRate: number | null;
    noops: number;
    lastFire: FireRow | null;
    byAgent: ReturnType<typeof aggregate>;
  };
  documents: Array<{
    key: string;
    label: string;
    path: string;
    exists: boolean;
    bytes: number;
    updatedAt: string | null;
  }>;
  reports: {
    count: number;
    operatorReviews: number;
    evaluations: number;
    latestAt: string | null;
  };
  latestEpisodes: EpisodeView[];
  lastActivityAt: string | null;
  warnings: Array<{ source: string; code: string; message: string }>;
};

export type WorkspaceSnapshot = {
  schemaVersion: 1;
  workspaceRoot: string;
  generatedAt: string;
  projectCount: number;
  enabledProjectCount: number;
  totals: {
    episodes: number;
    openTasks: number;
    needsAttention: number;
    runningAgents: number;
  };
  projects: ProjectSnapshot[];
};

type DiskRunState = {
  status?: unknown;
  pid?: unknown;
  cli?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  inFlight?: unknown;
};

const fileStat = (path: string): { bytes: number; updatedAt: string } | null => {
  try {
    const s = lstatSync(path);
    return s.isFile() && !s.isSymbolicLink() ? { bytes: s.size, updatedAt: s.mtime.toISOString() } : null;
  } catch { return null; }
};

const countMatching = (dir: string, re: RegExp): { count: number; truncated: boolean } => {
  const scan = readDirectoryNames(dir, DIRECTORY_ENTRY_LIMIT);
  return { count: scan.names.filter((name) => re.test(name)).length, truncated: scan.truncated };
};

const frontmatterField = (raw: string, key: string): string | null => {
  const end = raw.indexOf("\n---", 3);
  if (!raw.startsWith("---") || end < 0) return null;
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(raw.slice(0, end));
  const value = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  return value || null;
};

const episodeTitle = (raw: string, number: number): string => {
  const lines = raw.split(/\r?\n/);
  let inFrontmatter = lines[0]?.trim() === "---";
  for (let i = inFrontmatter ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      continue;
    }
    if (line.startsWith("#")) return line.replace(/^#+[ \t]*/, "").trim();
  }
  return `第 ${number} 集`;
};

function listEpisodes(repoPath: string): { items: EpisodeView[]; total: number; frontier: number; truncated: boolean; truncatedFiles: number; unsafe: boolean } {
  if (hasSymlinkComponent(repoPath, ["episodes"])) {
    return { items: [], total: 0, frontier: 0, truncated: false, truncatedFiles: 0, unsafe: true };
  }
  const scan = readDirectoryNames(join(repoPath, "episodes"), DIRECTORY_ENTRY_LIMIT);
  const names = scan.names.map((file) => {
    const number = episodeNumberFromFile(file);
    return number === null ? null : { file, number };
  }).filter((row): row is { file: string; number: number } => row !== null)
    .sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
  const out: EpisodeView[] = [];
  let truncatedFiles = 0;
  for (const { file, number } of names.slice(-8)) {
    const path = join(repoPath, "episodes", file);
    const read = readRegularTextHead(path, SUMMARY_HEAD_BYTES);
    if (read) {
      if (read.truncated) truncatedFiles++;
      const raw = read.text;
      const wordsRaw = frontmatterField(raw, "words");
      const wordsValue = wordsRaw && /^\d{1,7}$/.test(wordsRaw) ? Number(wordsRaw) : Number.NaN;
      const words = Number.isSafeInteger(wordsValue) && wordsValue >= 0 && wordsValue <= 1_000_000 ? wordsValue : null;
      out.push({
        number,
        file,
        title: episodeTitle(raw, number),
        arc: frontmatterField(raw, "arc"),
        hookType: frontmatterField(raw, "hook-type"),
        words,
        updatedAt: read.updatedAt,
      });
    } else {
      out.push({ number, file, title: `第 ${number} 集`, arc: null, hookType: null, words: null, updatedAt: null });
    }
  }
  return { items: out, total: names.length, frontier: names.at(-1)?.number ?? 0, truncated: scan.truncated, truncatedFiles, unsafe: false };
}

function readLogline(repoPath: string): string | null {
  if (hasSymlinkComponent(repoPath, ["bible", "north-star.md"])) return null;
  const read = readRegularTextHead(join(repoPath, "bible", "north-star.md"), SUMMARY_HEAD_BYTES);
  if (!read) return null;
  const raw = read.text;
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##[ \t]+一句话故事/.test(line));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const value = lines[i].trim();
    if (/^##[ \t]/.test(value)) break;
    if (!value || value.startsWith("<!--") || value.startsWith(">") || value.includes("{片名}")) continue;
    return value.replace(/^[-*][ \t]+/, "").slice(0, 180);
  }
  return null;
}

const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error
      && String((error as NodeJS.ErrnoException).code) === "EPERM");
  }
};

export function readSchedulerView(dataDir: string, nowMs = Date.now()): SchedulerView {
  const path = join(dataDir, "run-state.json");
  let state: DiskRunState | null = null;
  const read = readRegularTextHead(path, 256 * 1024);
  try {
    const value: unknown = read && !read.truncated ? JSON.parse(read.text) : null;
    state = value && typeof value === "object" && !Array.isArray(value) ? value as DiskRunState : null;
  } catch { state = null; }
  const rawStatus = state?.status;
  const inflight = Array.isArray(state?.inFlight)
    ? state.inFlight.filter((v): v is SchedulerView["inFlight"][number] => {
        if (!v || typeof v !== "object") return false;
        const x = v as Record<string, unknown>;
        return typeof x.agent === "string" && typeof x.startedAt === "string";
      }).map((v) => ({
        agent: String(v.agent),
        pid: typeof v.pid === "number" ? v.pid : null,
        model: typeof v.model === "string" ? v.model : "",
        effort: typeof v.effort === "string" ? v.effort : "",
        startedAt: String(v.startedAt),
        capSeconds: typeof v.capSeconds === "number" ? v.capSeconds : 0,
        logFile: typeof v.logFile === "string" ? v.logFile : "",
      }))
    : [];
  let viewState: SchedulerView["state"] = "stopped";
  const statePid = typeof state?.pid === "number" && Number.isInteger(state.pid) ? state.pid : null;
  const lock = readRegularTextHead(join(dataDir, "wl-run.lock"), 256);
  const holder = lock && !lock.truncated
    ? /^holder pid=(\d+) at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n?$/.exec(lock.text) : null;
  const holderPid = holder ? Number(holder[1]) : null;
  const lockFresh = lock ? nowMs - Date.parse(lock.updatedAt) <= 60 * 60_000 : false;
  const lockProvesRunning = holderPid !== null && statePid === holderPid && lockFresh && processAlive(holderPid);
  if ((rawStatus === "running" || rawStatus === "stopping") && lockProvesRunning) viewState = rawStatus;
  else if (rawStatus === "running" || rawStatus === "stopping" || lock !== null) viewState = "stale";
  return {
    state: viewState,
    pid: statePid,
    cli: typeof state?.cli === "string" ? state.cli : null,
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : null,
    updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
    // 陈旧锁/孤立 running 快照代表进程已不可证实；不能继续把旧 agent 显示成“正在工作”。
    inFlight: viewState === "running" || viewState === "stopping" ? inflight : [],
  };
}

const latestIso = (values: Array<string | null | undefined>): string | null => {
  let best: { value: string; time: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isNaN(time) && (!best || time > best.time)) best = { value, time };
  }
  return best?.value ?? null;
};

function projectSnapshot(ws: Workspace, key: string, project: WlProject, nowMs: number): ProjectSnapshot {
  const repoPath = resolveRepoPath(ws.root, project);
  if (hasSymlinkComponent(ws.root, [".writing-loop", key, "board", "tickets"])) throw new WsError(`项目 '${key}' 的运行态路径含符号链接`);
  const dataDir = projectDataDir(ws.root, key);
  const warnings: ProjectSnapshot["warnings"] = [];
  const board = listTickets(join(dataDir, "board", "tickets"));
  if (board.truncated) warnings.push({ source: "tickets", code: "COUNT_TRUNCATED", message: "票目录超过有界 snapshot 窗口" });
  if (board.truncatedFiles) warnings.push({ source: "tickets", code: "FILE_TRUNCATED", message: `${board.truncatedFiles} 张票只读取前 64 KiB 摘要` });
  const counts: Record<string, number> = {};
  for (const ticket of board.tickets) counts[ticket.state] = (counts[ticket.state] ?? 0) + 1;
  const needsAttention = board.tickets.filter((ticket) => !TERMINAL.has(ticket.state) && ticket.labels.some((label) => label.startsWith("needs-")));
  const episodes = listEpisodes(repoPath);
  if (episodes.unsafe) warnings.push({ source: "episodes", code: "UNSAFE_PATH", message: "分集目录含符号链接；拒绝 snapshot 内容" });
  if (episodes.truncated) warnings.push({ source: "episodes", code: "COUNT_TRUNCATED", message: "分集目录超过有界 snapshot 窗口" });
  if (episodes.truncatedFiles) warnings.push({ source: "episodes", code: "FILE_TRUNCATED", message: `${episodes.truncatedFiles} 个分集只读取前 64 KiB 摘要` });
  const totalEpisodes = typeof project.totalEpisodes === "number" && Number.isFinite(project.totalEpisodes)
    ? Math.max(0, Math.trunc(project.totalEpisodes)) : null;
  const fireWindow = readFiresBounded(join(dataDir, "fires.jsonl"));
  const fires = fireWindow.rows;
  if (fireWindow.truncated) warnings.push({ source: "fires", code: "TAIL_TRUNCATED", message: "只读取 fires.jsonl 最后 512 KiB" });
  if (fireWindow.invalid) warnings.push({ source: "fires", code: "INVALID_ROW", message: `跳过 ${fireWindow.invalid} 条无效 fire JSONL` });
  const successfulFires = fires.filter(isCleanFire).length;
  const documents = PROJECT_DOCUMENTS.map(([docKey, label, path]) => {
    const parts = path.split("/");
    const unsafe = hasSymlinkComponent(repoPath, parts);
    if (unsafe) warnings.push({ source: `document:${docKey}`, code: "UNSAFE_PATH", message: `${path} 含符号链接；拒绝 snapshot 内容` });
    const stat = unsafe ? null : fileStat(join(repoPath, ...parts));
    return { key: docKey, label, path, exists: stat !== null, bytes: stat?.bytes ?? 0, updatedAt: stat?.updatedAt ?? null };
  });
  const reports = listProjectReportsBounded(ws, key);
  const evaluationPathUnsafe = hasSymlinkComponent(repoPath, ["evaluation"]);
  const evaluations = evaluationPathUnsafe ? { rows: [], truncated: false } : listProjectEvaluationsBounded(ws, key);
  if (reports.truncated) warnings.push({ source: "reports", code: "COUNT_TRUNCATED", message: "报告目录超过有界 snapshot 窗口" });
  if (evaluations.truncated) warnings.push({ source: "evaluations", code: "COUNT_TRUNCATED", message: "评估目录超过有界 snapshot 窗口" });
  let storyArcs = 0;
  try { storyArcs = readStoryDesign(ws.root, key, ws.config)?.manifest.episodes.reduce((ids, episode) => ids.add(episode.arc), new Set<string>()).size ?? 0; }
  catch { warnings.push({ source: "story-design", code: "INVALID_DOCUMENT", message: "结构化故事设计无法解析；详情见故事工作台" }); }
  const evaluationCount = evaluationPathUnsafe ? { count: 0, truncated: false } : countMatching(join(repoPath, "evaluation"), /\.md$/);
  if (evaluationPathUnsafe) warnings.push({ source: "evaluations", code: "UNSAFE_PATH", message: "评估目录含符号链接；拒绝 snapshot 内容" });
  if (evaluationCount.truncated && !evaluations.truncated) warnings.push({ source: "evaluations", code: "COUNT_TRUNCATED", message: "评估目录超过有界 snapshot 窗口" });
  const scheduler = readSchedulerView(dataDir, nowMs);
  const lastFire = fires.at(-1) ?? null;
  const lastActivityAt = latestIso([
    ...board.tickets.map((ticket) => ticket.updated),
    ...documents.map((doc) => doc.updatedAt),
    ...episodes.items.map((episode) => episode.updatedAt),
    ...reports.rows.map((report) => report.updatedAt),
    ...evaluations.rows.map((evaluation) => evaluation.updatedAt),
    lastFire?.endedAt,
    scheduler.updatedAt,
  ]);
  return {
    key,
    title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : key,
    enabled: project.enabled !== false,
    repoPath,
    repoExists: existsSync(repoPath),
    format: typeof project.format === "string" ? project.format : null,
    genre: typeof project.genre === "string" ? project.genre : null,
    monetization: typeof project.monetization === "string" ? project.monetization : null,
    audience: typeof project.audience === "string" ? project.audience : null,
    seasonStrategy: project.seasonStrategy === "single-season" || project.seasonStrategy === "multi-season"
      || project.seasonStrategy === "undecided" ? project.seasonStrategy : null,
    currentSeason: typeof project.currentSeason === "number" && Number.isSafeInteger(project.currentSeason)
      && project.currentSeason >= 1 && project.currentSeason <= 100 ? project.currentSeason : null,
    logline: readLogline(repoPath),
    progress: {
      frontier: episodes.frontier,
      written: episodes.total,
      totalEpisodes,
      percent: totalEpisodes && totalEpisodes > 0 ? Math.min(100, Math.round((episodes.frontier / totalEpisodes) * 100)) : null,
      latestFile: episodes.items.at(-1)?.file ?? null,
      storyArcs,
      evaluations: evaluationCount.count,
    },
    board: {
      total: board.tickets.length,
      open: board.tickets.filter((ticket) => !TERMINAL.has(ticket.state)).length,
      malformed: board.unparsed,
      counts,
      needsAttention,
      inProgress: board.tickets.filter((ticket) => ticket.state === "In Progress"),
      inReview: board.tickets.filter((ticket) => ticket.state === "In Review"),
      tickets: board.tickets,
    },
    scheduler,
    telemetry: {
      totalFires: fires.length,
      successfulFires,
      successRate: fires.length ? Math.round((successfulFires / fires.length) * 100) : null,
      noops: fires.filter((fire) => fire.noop).length,
      lastFire,
      byAgent: aggregate(fires),
    },
    documents,
    reports: {
      count: reports.rows.length,
      operatorReviews: reports.rows.filter((report) => report.review).length,
      evaluations: evaluations.rows.length,
      latestAt: latestIso([...reports.rows.map((report) => report.updatedAt), ...evaluations.rows.map((evaluation) => evaluation.updatedAt)]),
    },
    latestEpisodes: episodes.items.toReversed(),
    lastActivityAt,
    warnings,
  };
}

export function buildWorkspaceSnapshot(ws: Workspace, nowMs = Date.now()): WorkspaceSnapshot {
  const entries = projectEntries(ws.config);
  const projects = entries
    .map(([key, project]) => projectSnapshot(ws, key, project, nowMs))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0) || a.key.localeCompare(b.key));
  return {
    schemaVersion: 1,
    workspaceRoot: ws.root,
    generatedAt: new Date(nowMs).toISOString(),
    projectCount: projects.length,
    enabledProjectCount: projects.filter((project) => project.enabled).length,
    totals: {
      episodes: projects.reduce((n, project) => n + project.progress.written, 0),
      openTasks: projects.reduce((n, project) => n + project.board.open, 0),
      needsAttention: projects.reduce((n, project) => n + project.board.needsAttention.length, 0),
      runningAgents: projects.reduce((n, project) => n + project.scheduler.inFlight.length, 0),
    },
    projects,
  };
}

export function snapshotFingerprint(snapshot: WorkspaceSnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    projects: snapshot.projects,
    totals: snapshot.totals,
    enabledProjectCount: snapshot.enabledProjectCount,
  })).digest("hex");
}
