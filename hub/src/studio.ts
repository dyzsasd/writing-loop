#!/usr/bin/env node
// writing-loop Studio：只监听 loopback 的本地编剧工作台。
// 读路径来自稳定 snapshot；写路径仅限计划确认式立项与 lossless/atomic 项目启停。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { type AddressInfo } from "node:net";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { ActivityIndexer } from "./activity-index.ts";
import { commitOnboarding, planOnboarding } from "./onboarding.ts";
import { buildProductionCoordinatorReadModel, type ProductionCoordinatorReadModel } from "./production-coordinator-read-model.ts";
import { readProductionCoordinatorControlState } from "./production-coordinator-store.ts";
import { buildProductionReadModel, type ProductionReadModel } from "./production-read-model.ts";
import { readProductionState } from "./production-store.ts";
import { listProjectEvaluations, listProjectReports, readProjectResource, type ProjectResourceKind } from "./project-detail.ts";
import { buildWorkspaceSnapshot, snapshotFingerprint, type WorkspaceSnapshot } from "./project-read-model.ts";
import { setProjectEnabled } from "./workspace-store.ts";
import {
  LIVE_SCRIPT, fleetPage, newProjectPage, notFoundPage, onboardingPlanPage, operationErrorPage, projectPage, resourcePage,
  workspacePage, type FleetWorkspaceView,
} from "./studio-view.ts";
import { findWorkspaceRoot, loadConfig, PROJECT_KEY_PATTERN, WsError } from "./workspace.ts";
import {
  ensureWorkspaceIdentity, inspectWorkspaceRegistry, readWorkspaceIdentity, registerWorkspace, resolveRegisteredWorkspace,
  type RegisteredWorkspace,
} from "./workspace-registry.ts";

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const BODY_LIMIT = 64 * 1024;
const SCRIPT_HASH = createHash("sha256").update(LIVE_SCRIPT).digest("base64");

export type StudioOptions = {
  root: string;
  /** Optional fleet catalog. When omitted Studio preserves the legacy single-workspace URL surface. */
  workspaceProvider?: () => StudioWorkspaceEntry[];
  /** Workspace selected by legacy unscoped URLs and CLI startup. Must match root's durable identity. */
  defaultWorkspaceId?: string;
  pollMs?: number;
  maxStreams?: number;
  /** Deterministic snapshot injection for integration tests; production loads the supplied root. */
  snapshotProvider?: (root: string) => WorkspaceSnapshot;
  /** Synchronous, local-only production projection. It must never probe a remote backend. */
  productionProvider?: (root: string, workspaceId: string, project: string) => ProductionReadModel;
  /** Local crash-recovery projection; never performs provider I/O. */
  productionControlProvider?: (root: string, workspaceId: string, project: string) => ProductionCoordinatorReadModel;
};

export type StudioWorkspaceEntry = {
  id: string;
  label: string;
  root: string;
  /** Registry health is preserved for fleet display but only `ok` entries are routable. */
  status?: "ok" | "missing" | "corrupt";
  diagnostic?: string;
};

type CatalogWorkspace = Omit<StudioWorkspaceEntry, "status"> & {
  status: "ok" | "missing" | "corrupt";
};
type WorkspaceScope = CatalogWorkspace & { base: string };

export class StudioError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "StudioError"; this.status = status; }
}

const commonHeaders = {
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  // 同源 HTML form POST 需要一个可验证的 source。Chrome 在 no-referrer 下会把
  // 导航式 POST 的 Origin 降为 `null`，反而让我们的 Origin/Referer guard 拒绝
  // Studio 自己的表单；same-origin 不向跨站泄露 referrer，同时保留本机同源证据。
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

function send(res: ServerResponse, status: number, contentType: string, body: string, head = false): void {
  res.writeHead(status, { ...commonHeaders, "content-type": contentType, "content-length": Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown, head = false): void =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value, null, 2) + "\n", head);

const sendHtml = (res: ServerResponse, status: number, body: string, head = false): void =>
  send(res, status, "text/html; charset=utf-8", body, head);

function requestUrl(req: IncomingMessage): URL {
  try { return new URL(req.url ?? "/", "http://writing-loop.local"); }
  catch { throw new StudioError("请求 URL 无效"); }
}

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized);
}

function checkLocalRequest(req: IncomingMessage): void {
  if (!isLoopbackPeer(req.socket.remoteAddress)) throw new StudioError("拒绝非本机网络对端");
  const host = req.headers.host?.trim() ?? "";
  if (!LOCAL_HOST.test(host)) throw new StudioError("拒绝非本机 Host");
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) {
    if (req.method === "POST") throw new StudioError("写请求必须携带同源 Origin 或 Referer");
    return;
  }
  let sourceUrl: URL;
  try { sourceUrl = new URL(source); }
  catch { throw new StudioError("Origin/Referer 无效"); }
  // Studio 只提供明文 loopback HTTP；同源必须同时匹配 scheme + host + port，不能把
  // https://127.0.0.1 或其他协议仅因 Host 相同而误当同源。
  if (sourceUrl.protocol !== "http:" || sourceUrl.host.toLowerCase() !== host.toLowerCase()) {
    throw new StudioError("拒绝跨源写请求");
  }
}

function loadSnapshot(root: string): WorkspaceSnapshot {
  return buildWorkspaceSnapshot(loadConfig(root));
}

function loadProduction(root: string, workspaceId: string, project: string): ProductionReadModel {
  return buildProductionReadModel(readProductionState(root, workspaceId, project));
}

function loadProductionControl(root: string, workspaceId: string, project: string): ProductionCoordinatorReadModel {
  return buildProductionCoordinatorReadModel(readProductionCoordinatorControlState(root, workspaceId, project));
}

const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{32}$/;

function decodeWorkspaceId(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return WORKSPACE_ID_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

function normalizeCatalog(options: StudioOptions): CatalogWorkspace[] {
  const rows: StudioWorkspaceEntry[] = options.workspaceProvider?.() ?? (() => {
    let durableId: string;
    try { durableId = readWorkspaceIdentity(options.root).id; }
    catch (error) {
      throw new StudioError(`workspace identity 无法读取：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (options.defaultWorkspaceId !== undefined && options.defaultWorkspaceId !== durableId) {
      throw new StudioError(`--workspace/defaultWorkspaceId 与 root 的 durable identity 不匹配（实际 ${durableId}）`, 409);
    }
    return [{
      id: durableId,
      label: basename(options.root) || "writing-loop workspace",
      root: options.root,
    }];
  })();
  const ids = new Set<string>();
  const roots = new Set<string>();
  const out: CatalogWorkspace[] = [];
  for (const row of rows) {
    if (!WORKSPACE_ID_PATTERN.test(row.id) || typeof row.label !== "string" || !row.label.trim() || !isAbsolute(row.root)) {
      throw new StudioError("workspace registry 含无效条目", 409);
    }
    if (row.status !== undefined && !new Set(["ok", "missing", "corrupt"]).has(row.status)) {
      throw new StudioError("workspace registry 含无效状态", 409);
    }
    if (row.diagnostic !== undefined && (typeof row.diagnostic !== "string" || row.diagnostic.length > 2_048)) {
      throw new StudioError("workspace registry 含无效诊断", 409);
    }
    let root: string;
    try { root = realpathSync(row.root); }
    catch { root = resolve(row.root); }
    if (ids.has(row.id)) throw new StudioError(`workspace registry 重复 ID '${row.id}'`, 409);
    if (roots.has(root)) throw new StudioError(`workspace registry 重复路径 '${root}'`, 409);
    ids.add(row.id);
    roots.add(root);
    let status = row.status ?? "ok";
    let diagnostic = row.diagnostic;
    // A fleet provider represents explicit workspace identities. Rebind every nominally healthy
    // row to the durable identity before it can become a route; this also protects custom
    // providers and closes the inspect→route gap for copied/replaced workspace roots.
    if (options.workspaceProvider && status === "ok") {
      try {
        const identity = readWorkspaceIdentity(root);
        if (identity.id !== row.id) {
          status = "corrupt";
          diagnostic = `identity ID 不匹配（实际 ${identity.id}）`;
        }
      } catch (error) {
        status = "corrupt";
        diagnostic = error instanceof Error ? error.message : String(error);
      }
    }
    out.push({ id: row.id, label: row.label.trim(), root, status, ...(diagnostic ? { diagnostic } : {}) });
  }
  return out;
}

function decodeProject(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    const match = PROJECT_KEY_PATTERN.exec(value);
    return match?.[0].length === value.length ? value : null;
  } catch { return null; }
}

const validProjectKey = (value: string): boolean => {
  const match = PROJECT_KEY_PATTERN.exec(value);
  return match?.[0].length === value.length;
};

const hasProject = (snapshot: WorkspaceSnapshot, key: string): boolean =>
  snapshot.projects.some((project) => project.key === key);

const missingResource = (error: unknown): boolean => error instanceof WsError
  && /^(?:没有创作任务|没有剧情文档|没有第 \d+ 集|没有报告|没有评估)/.test(error.message);

function decodeId(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(value) && !value.includes("..") ? value : null;
  } catch { return null; }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const tooLarge = (): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(new StudioError("请求体超过 64 KiB", 413));
      // Keep draining the socket so the client receives the structured 413 response and the
      // connection cannot be reset merely because its body crossed the application limit.
      req.resume();
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) tooLarge();
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > BODY_LIMIT) {
        tooLarge();
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

const requireFormType = (req: IncomingMessage): void => {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new StudioError("只接受 application/x-www-form-urlencoded", 415);
  }
};

const formInteger = (form: URLSearchParams, key: string): number => {
  const raw = form.get(key) ?? "";
  if (!/^-?\d+$/.test(raw)) throw new StudioError(`${key} 必须是整数`);
  return Number(raw);
};

const formNumbers = (form: URLSearchParams, key: string): number[] => {
  const raw = form.get(key)?.trim() ?? "";
  if (!raw) return [];
  const values = raw.split(",").map((part) => part.trim());
  if (values.some((part) => !/^\d+$/.test(part))) throw new StudioError(`${key} 必须是逗号分隔的正整数`);
  return values.map(Number);
};

function assertStudioRepoPath(root: string, payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new StudioError("立项 payload 必须是对象");
  const repoPath = (payload as Record<string, unknown>).repoPath;
  if (typeof repoPath !== "string" || !repoPath.trim()) throw new StudioError("repoPath 必须是非空字符串");
  if (isAbsolute(repoPath) || repoPath.includes("\\") || repoPath.split("/").some((part) => part === "..")) {
    throw new StudioError("Studio 自动立项只接受 workspace 内、不含 .. 或反斜杠的相对 repoPath");
  }
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, repoPath);
  if (target === rootReal || !target.startsWith(rootReal + sep)) throw new StudioError("Studio repoPath 必须位于当前 workspace 内");
}

export function onboardingInputFromForm(root: string, form: URLSearchParams): Record<string, unknown> {
  const kind = form.get("kind") ?? "original";
  const payload: Record<string, unknown> = {
    key: form.get("key") ?? "",
    title: form.get("title") ?? "",
    repoPath: form.get("repoPath") ?? "",
    kind,
    logline: form.get("logline") ?? "",
    audience: form.get("audience") ?? "",
    complianceNotes: form.get("complianceNotes") ?? "",
    nonGoals: (form.get("nonGoals") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    genre: form.get("genre") ?? "",
    monetization: form.get("monetization") ?? "",
    format: form.get("format") ?? "",
    totalEpisodes: formInteger(form, "totalEpisodes"),
    paywall: { card1: formNumbers(form, "card1"), card2: formNumbers(form, "card2"), card3: formNumbers(form, "card3") },
    episodeWordBand: [formInteger(form, "wordMin"), formInteger(form, "wordMax")],
    maxPrimaryScenes: formInteger(form, "maxPrimaryScenes"),
    maxNamedCharacters: formInteger(form, "maxNamedCharacters"),
    ticketPrefix: form.get("ticketPrefix") ?? "WL",
    intakeMode: form.get("intakeMode") ?? "autonomous",
    mode: form.get("mode") ?? "live",
    assetLibrary: null,
    marketDataPath: null,
    comparables: form.get("comparables") ?? "",
    differentiation: form.get("differentiation") ?? "",
  };
  if (kind === "adaptation") {
    payload.adaptation = {
      rightsScope: form.get("rightsScope") ?? "",
      compressionRatio: formInteger(form, "compressionRatio"),
      highlightCount: formInteger(form, "highlightCount"),
      namedCharacterCount: formInteger(form, "sourceNamedCharacters"),
      riskAcknowledged: form.get("riskAcknowledged") === "true",
    };
  }
  assertStudioRepoPath(root, payload);
  return payload;
}

function decodeOnboardingPayload(root: string, encoded: string): unknown {
  if (!encoded || encoded.length > BODY_LIMIT) throw new StudioError("立项 payload 无效或过大");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new StudioError("立项 payload 无法解析"); }
  assertStudioRepoPath(root, value);
  return value;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...commonHeaders, location, "content-length": "0" });
  res.end();
}

function temporaryRedirect(res: ServerResponse, location: string): void {
  res.writeHead(307, { ...commonHeaders, location, "content-length": "0" });
  res.end();
}

function allowedMethods(pathname: string): string[] | null {
  if (["/", "/api/health", "/api/snapshot", "/projects/new"].includes(pathname)
    || /^\/api\/projects\/[^/]+\/(?:activity|production|production-control|resources\/(?:ticket|document|episode|report|evaluation)\/[^/]+)$/.test(pathname)
    || /^\/p\/[^/]+(?:\/(?:ticket|document|episode|report|evaluation)\/[^/]+)?$/.test(pathname)) return ["GET", "HEAD"];
  if (pathname === "/api/stream") return ["GET"];
  if (pathname === "/projects/plan" || pathname === "/projects/create" || /^\/p\/[^/]+\/toggle$/.test(pathname)) return ["POST"];
  return null;
}

function errorStatus(error: unknown): number {
  if (error instanceof StudioError) return error.status;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return 404;
  if (error instanceof WsError) {
    if (/activity cursor|详情 id 无效|分集 id 必须是数字|非法项目 key/.test(error.message)) return 400;
    return 409;
  }
  return 500;
}

export function createStudioServer(options: StudioOptions): Server {
  const pollMs = Math.max(250, options.pollMs ?? 1_500);
  const maxStreams = Math.max(1, options.maxStreams ?? 16);
  const snapshotNow = options.snapshotProvider ?? loadSnapshot;
  const productionNow = options.productionProvider ?? loadProduction;
  const productionControlNow = options.productionControlProvider ?? loadProductionControl;
  const productionFor = (root: string, workspaceId: string, project: string): ProductionReadModel => {
    const value = productionNow(root, workspaceId, project);
    if (value.version !== 1 || value.workspaceId !== workspaceId || value.project !== project) {
      throw new StudioError("production provider 返回了跨 workspace/project 或未知版本的 read model", 409);
    }
    return value;
  };
  const productionControlFor = (root: string, workspaceId: string, project: string): ProductionCoordinatorReadModel => {
    const value = productionControlNow(root, workspaceId, project);
    if (value.version !== 1 || value.workspaceId !== workspaceId || value.project !== project) {
      throw new StudioError("production control provider 返回了跨 workspace/project 或未知版本的 read model", 409);
    }
    return value;
  };
  const fleetMode = options.workspaceProvider !== undefined;
  type StreamClient = { response: ServerResponse; workspaceId: string | null };
  const streamClients = new Set<StreamClient>();
  const streamCursors = new Map<string, string>();
  let streamTimer: NodeJS.Timeout | null = null;
  let heartbeatAt = 0;

  const catalog = (): CatalogWorkspace[] => normalizeCatalog(options);
  const defaultWorkspace = (rows: CatalogWorkspace[]): CatalogWorkspace | null => {
    const requested = options.defaultWorkspaceId;
    if (requested) return rows.find((row) => row.id === requested && row.status === "ok") ?? null;
    let root: string;
    try { root = realpathSync(options.root); } catch { root = resolve(options.root); }
    return rows.find((row) => row.root === root && row.status === "ok")
      ?? rows.find((row) => row.status === "ok") ?? null;
  };
  const scopeKey = (workspaceId: string | null): string => workspaceId ?? "fleet";
  const workspaceCursor = (row: CatalogWorkspace): string => {
    if (row.status !== "ok") throw new StudioError(`workspace '${row.id}' 当前不可用（${row.status}）`, 409);
    const snapshot = snapshotNow(row.root);
    const ws = loadConfig(row.root);
    const indexer = new ActivityIndexer(ws);
    // snapshotFingerprint intentionally excludes generatedAt and workspaceRoot for ordinary
    // content stability. The scoped Studio page does render its root, though, so a registry
    // move must still invalidate the browser view.
    const digest = createHash("sha256").update(snapshotFingerprint(snapshot))
      .update("\0root\0").update(row.root);
    for (const project of snapshot.projects) {
      const indexed = indexer.buildPage(row.id, project.key, { limit: 1 });
      digest.update("\0").update(project.key).update("\0").update(indexed.sseCursor);
      const production = productionFor(row.root, row.id, project.key);
      digest.update("\0production\0").update(String(production.revision)).update("\0").update(production.updatedAt ?? "");
      const control = productionControlFor(row.root, row.id, project.key);
      digest.update("\0production-control\0").update(String(control.revision)).update("\0").update(control.updatedAt ?? "");
    }
    return digest.digest("hex");
  };
  const scopeCursor = (workspaceId: string | null): string => {
    const rows = catalog();
    if (workspaceId) {
      const row = rows.find((entry) => entry.id === workspaceId && entry.status === "ok");
      if (!row) throw new StudioError(`没有 workspace '${workspaceId}'`, 404);
      const digest = workspaceCursor(row);
      return `wlsse1_${workspaceId}_${digest}`;
    }
    const digest = createHash("sha256");
    for (const row of rows) {
      // Fleet cards also render the machine-local label. Treat registry metadata changes as UI
      // changes even when every underlying script snapshot/activity revision is unchanged.
      digest.update(row.id).update("\0").update(row.label).update("\0").update(row.root).update("\0")
        .update(row.status).update("\0").update(row.diagnostic ?? "").update("\0");
      if (row.status === "ok") {
        try { digest.update(workspaceCursor(row)); }
        catch (error) { digest.update(`error:${error instanceof Error ? error.message : String(error)}`); }
      }
      digest.update("\0");
    }
    return `wlsse1_fleet_${digest.digest("hex")}`;
  };
  const fleetSnapshot = (): FleetWorkspaceView[] => catalog().map((row) => {
    if (row.status !== "ok") return {
      id: row.id, label: row.label, root: row.root,
      status: row.status === "missing" ? "missing" as const : "invalid" as const,
      snapshot: null,
      error: row.diagnostic ?? `registry entry ${row.status}`,
    };
    try {
      return { ...row, status: "ready" as const, snapshot: snapshotNow(row.root), error: null };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      return {
        ...row,
        status: code === "ENOENT" || code === "ENOTDIR" ? "missing" as const : "invalid" as const,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const removeStream = (client: StreamClient): void => {
    if (!streamClients.delete(client)) return;
    if (!streamClients.size && streamTimer) {
      clearInterval(streamTimer);
      streamTimer = null;
      streamCursors.clear();
    }
  };
  const broadcast = (workspaceId: string | null, payload: string): void => {
    for (const client of [...streamClients]) {
      if (client.workspaceId !== workspaceId) continue;
      try {
        if (!client.response.write(payload)) {
          removeStream(client);
          client.response.end();
        }
      }
      catch { removeStream(client); }
    }
  };
  const pollStreams = (): void => {
    const scopes = new Set([...streamClients].map((client) => client.workspaceId));
    for (const workspaceId of scopes) {
      try {
        const key = scopeKey(workspaceId);
        const next = scopeCursor(workspaceId);
        if (next !== streamCursors.get(key)) {
          streamCursors.set(key, next);
          broadcast(workspaceId, `id: ${next}\ndata: ${next}\n\n`);
        }
      } catch (error) {
        broadcast(workspaceId, `event: error\ndata: ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n\n`);
      }
    }
    if (Date.now() - heartbeatAt >= 15_000) {
      heartbeatAt = Date.now();
      for (const workspaceId of scopes) broadcast(workspaceId, ": keep-alive\n\n");
    }
  };
  const ensureStreamPoller = (): void => {
    if (streamTimer) return;
    heartbeatAt = Date.now();
    streamTimer = setInterval(pollStreams, pollMs);
    streamTimer.unref();
  };

  return createServer(async (req, res) => {
    let requestScope: WorkspaceScope | null = null;
    let routedPath = "/";
    try {
      checkLocalRequest(req);
      const url = requestUrl(req);
      const method = req.method ?? "GET";
      const head = method === "HEAD";
      const rows = catalog();
      const workspaceMatch = /^\/w\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (workspaceMatch) {
        const id = decodeWorkspaceId(workspaceMatch[1]);
        if (!id) { sendJson(res, 400, { error: "workspace id 无效" }, head); return; }
        const row = rows.find((entry) => entry.id === id);
        if (!row) { sendJson(res, 404, { error: `没有 workspace '${id}'` }, head); return; }
        if (row.status !== "ok") {
          sendJson(res, 409, { error: `workspace '${id}' 当前不可用（${row.status}）：${row.diagnostic ?? "registry 指针需检查"}` }, head);
          return;
        }
        requestScope = { ...row, base: `/w/${encodeURIComponent(row.id)}` };
        routedPath = workspaceMatch[2] || "/";
      } else if (!fleetMode) {
        const row = rows[0];
        requestScope = { ...row, base: "" };
        routedPath = url.pathname;
      } else if (url.pathname !== "/" && url.pathname !== "/api/health" && url.pathname !== "/api/stream") {
        const fallback = defaultWorkspace(rows);
        if (!fallback) { sendJson(res, 409, { error: "没有可用 workspace；先运行 writing-loop workspace add DIR" }, head); return; }
        if (method === "GET" || head) {
          temporaryRedirect(res, `/w/${encodeURIComponent(fallback.id)}${url.pathname}${url.search}`);
          return;
        }
        sendJson(res, 409, { error: "多工作区 Studio 的写请求必须使用 /w/:workspace-id 命名空间" });
        return;
      } else {
        routedPath = url.pathname;
      }

      const allowed = allowedMethods(routedPath);
      if (allowed && !allowed.includes(method)) {
        res.setHeader("allow", allowed.join(", "));
        sendJson(res, 405, { error: "Method Not Allowed" }, head);
        return;
      }

      if ((method === "GET" || head) && routedPath === "/api/health") {
        if (!requestScope && fleetMode) {
          const workspaces = fleetSnapshot();
          sendJson(res, 200, {
            ok: true,
            service: "writing-loop-studio",
            schemaVersion: 2,
            workspaces: workspaces.length,
            readyWorkspaces: workspaces.filter((workspace) => workspace.status === "ready").length,
            projects: workspaces.reduce((sum, workspace) => sum + (workspace.snapshot?.projectCount ?? 0), 0),
          }, head);
          return;
        }
        const snapshot = snapshotNow(requestScope!.root);
        sendJson(res, 200, {
          ok: true,
          service: "writing-loop-studio",
          schemaVersion: snapshot.schemaVersion,
          projects: snapshot.projectCount,
        }, head);
        return;
      }

      if (method === "GET" && routedPath === "/api/stream") {
        if (streamClients.size >= maxStreams) {
          sendJson(res, 503, { error: "SSE 连接数已达上限" });
          return;
        }
        // 初始化投影可能因 config 暂时不可读而失败；必须在占用连接槽之前完成，否则一次
        // 失败请求会永久吃掉 maxStreams 配额且没有 close handler 能归还。
        const workspaceId = requestScope?.id ?? null;
        const key = scopeKey(workspaceId);
        let current = streamCursors.get(key);
        if (!current) {
          current = scopeCursor(workspaceId);
          streamCursors.set(key, current);
        }
        const lastEventId = String(req.headers["last-event-id"] ?? "");
        if (lastEventId.length > 256 || (lastEventId && !/^wlsse1_(?:fleet|ws_[a-f0-9]{32})_[a-f0-9]{64}$/.test(lastEventId))) {
          sendJson(res, 400, { error: "SSE Last-Event-ID 无效" });
          return;
        }
        if (lastEventId && workspaceId && !lastEventId.startsWith(`wlsse1_${workspaceId}_`)) {
          sendJson(res, 400, { error: "SSE cursor 与 workspace 不匹配" });
          return;
        }
        if (lastEventId && !workspaceId && !lastEventId.startsWith("wlsse1_fleet_")) {
          sendJson(res, 400, { error: "SSE cursor 与 fleet 不匹配" });
          return;
        }
        res.writeHead(200, {
          ...commonHeaders,
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const client: StreamClient = { response: res, workspaceId };
        streamClients.add(client);
        const initial = lastEventId === current ? `retry: ${pollMs}\n: cursor-current\n\n` : `id: ${current}\ndata: ${current}\n\n`;
        if (!res.write(initial)) {
          removeStream(client);
          res.end();
          return;
        }
        const close = (): void => removeStream(client);
        res.once("close", close);
        res.once("error", close);
        ensureStreamPoller();
        return;
      }

      if ((method === "GET" || head) && routedPath === "/api/snapshot") {
        const snapshot = snapshotNow(requestScope!.root);
        const key = url.searchParams.get("project");
        if (!key) {
          sendJson(res, 200, snapshot, head);
          return;
        }
        const project = validProjectKey(key) ? snapshot.projects.find((item) => item.key === key) : undefined;
        if (!project) {
          sendJson(res, 404, { error: `没有项目 '${key}'` }, head);
          return;
        }
        sendJson(res, 200, { schemaVersion: snapshot.schemaVersion, generatedAt: snapshot.generatedAt, project }, head);
        return;
      }

      const activityMatch = /^\/api\/projects\/([^/]+)\/activity$/.exec(routedPath);
      if ((method === "GET" || head) && activityMatch) {
        const key = decodeProject(activityMatch[1]);
        if (!key) { sendJson(res, 400, { error: "项目 key 无效" }, head); return; }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw === null ? 30 : Number(limitRaw);
        if (limitRaw !== null && (!/^\d+$/.test(limitRaw) || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
          sendJson(res, 400, { error: "limit 必须是 1–100 的整数" }, head);
          return;
        }
        const snapshot = snapshotNow(requestScope!.root);
        if (!hasProject(snapshot, key)) { sendJson(res, 404, { error: `没有项目 '${key}'` }, head); return; }
        const ws = loadConfig(requestScope!.root);
        sendJson(res, 200, new ActivityIndexer(ws).buildPage(requestScope!.id, key, {
          limit, before: url.searchParams.get("before"),
        }), head);
        return;
      }

      const productionMatch = /^\/api\/projects\/([^/]+)\/production$/.exec(routedPath);
      if ((method === "GET" || head) && productionMatch) {
        const key = decodeProject(productionMatch[1]);
        if (!key) { sendJson(res, 400, { error: "项目 key 无效" }, head); return; }
        const snapshot = snapshotNow(requestScope!.root);
        if (!hasProject(snapshot, key)) { sendJson(res, 404, { error: `没有项目 '${key}'` }, head); return; }
        sendJson(res, 200, productionFor(requestScope!.root, requestScope!.id, key), head);
        return;
      }

      const productionControlMatch = /^\/api\/projects\/([^/]+)\/production-control$/.exec(routedPath);
      if ((method === "GET" || head) && productionControlMatch) {
        const key = decodeProject(productionControlMatch[1]);
        if (!key) { sendJson(res, 400, { error: "项目 key 无效" }, head); return; }
        const snapshot = snapshotNow(requestScope!.root);
        if (!hasProject(snapshot, key)) { sendJson(res, 404, { error: `没有项目 '${key}'` }, head); return; }
        sendJson(res, 200, productionControlFor(requestScope!.root, requestScope!.id, key), head);
        return;
      }

      const resourceApiMatch = /^\/api\/projects\/([^/]+)\/resources\/(ticket|document|episode|report|evaluation)\/([^/]+)$/.exec(routedPath);
      if ((method === "GET" || head) && resourceApiMatch) {
        const key = decodeProject(resourceApiMatch[1]);
        const id = decodeId(resourceApiMatch[3]);
        if (!key || !id) { sendJson(res, 400, { error: "详情参数无效" }, head); return; }
        const snapshot = snapshotNow(requestScope!.root);
        if (!hasProject(snapshot, key)) { sendJson(res, 404, { error: `没有项目 '${key}'` }, head); return; }
        let resource: ReturnType<typeof readProjectResource>;
        try { resource = readProjectResource(loadConfig(requestScope!.root), key, resourceApiMatch[2] as ProjectResourceKind, id); }
        catch (error) {
          if (missingResource(error)) { sendJson(res, 404, { error: (error as Error).message }, head); return; }
          throw error;
        }
        res.setHeader("etag", `\"${resource.etag}\"`);
        sendJson(res, 200, resource, head);
        return;
      }

      if ((method === "GET" || head) && routedPath === "/projects/new") {
        const snapshot = snapshotNow(requestScope!.root);
        sendHtml(res, 200, newProjectPage(snapshot, requestScope!.base), head);
        return;
      }

      if (method === "POST" && routedPath === "/projects/plan") {
        requireFormType(req);
        const payload = onboardingInputFromForm(requestScope!.root, new URLSearchParams(await readBody(req)));
        let plan: ReturnType<typeof planOnboarding>;
        try { plan = planOnboarding(requestScope!.root, payload); }
        catch (error) {
          if (error instanceof WsError) throw new StudioError(error.message, 400);
          throw error;
        }
        const encoded = Buffer.from(JSON.stringify(plan.input)).toString("base64url");
        sendHtml(res, 200, onboardingPlanPage(snapshotNow(requestScope!.root), plan, encoded, requestScope!.base));
        return;
      }

      if (method === "POST" && routedPath === "/projects/create") {
        requireFormType(req);
        const form = new URLSearchParams(await readBody(req));
        const planId = form.get("planId") ?? "";
        if (!/^wlplan_[0-9a-f]{24}$/.test(planId)) { sendJson(res, 400, { error: "planId 无效" }); return; }
        const payload = decodeOnboardingPayload(requestScope!.root, form.get("payload") ?? "");
        const result = commitOnboarding(requestScope!.root, payload, planId);
        redirect(res, `${requestScope!.base}/p/${encodeURIComponent(result.key)}?notice=${encodeURIComponent(`立项完成；首票 ${result.outlineTicketId}`)}`);
        return;
      }

      if ((method === "GET" || head) && routedPath === "/") {
        if (!requestScope && fleetMode) {
          sendHtml(res, 200, fleetPage(fleetSnapshot()), head);
          return;
        }
        const snapshot = snapshotNow(requestScope!.root);
        sendHtml(res, 200, workspacePage(snapshot, requestScope!.base), head);
        return;
      }

      const resourcePageMatch = /^\/p\/([^/]+)\/(ticket|document|episode|report|evaluation)\/([^/]+)$/.exec(routedPath);
      if ((method === "GET" || head) && resourcePageMatch) {
        const snapshot = snapshotNow(requestScope!.root);
        const key = decodeProject(resourcePageMatch[1]);
        const id = decodeId(resourcePageMatch[3]);
        const project = key ? snapshot.projects.find((item) => item.key === key) : undefined;
        if (!project || !key || !id) {
          sendHtml(res, 404, notFoundPage(snapshot, "没有找到这份创作工件。", requestScope!.base), head);
          return;
        }
        let resource: ReturnType<typeof readProjectResource>;
        try { resource = readProjectResource(loadConfig(requestScope!.root), key, resourcePageMatch[2] as ProjectResourceKind, id); }
        catch (error) {
          if (missingResource(error)) { sendHtml(res, 404, notFoundPage(snapshot, "没有找到这份创作工件。", requestScope!.base), head); return; }
          throw error;
        }
        sendHtml(res, 200, resourcePage(snapshot, project, resource, requestScope!.base), head);
        return;
      }

      const projectMatch = /^\/p\/([^/]+)$/.exec(routedPath);
      if ((method === "GET" || head) && projectMatch) {
        const snapshot = snapshotNow(requestScope!.root);
        const key = decodeProject(projectMatch[1]);
        const project = key ? snapshot.projects.find((item) => item.key === key) : undefined;
        if (!project) {
          sendHtml(res, 404, notFoundPage(snapshot, "没有找到这部剧。", requestScope!.base), head);
          return;
        }
        const ws = loadConfig(requestScope!.root);
        sendHtml(res, 200, projectPage(snapshot, project, url.searchParams.get("notice") ?? undefined, {
          activity: new ActivityIndexer(ws).buildPage(requestScope!.id, project.key, { limit: 24 }),
          production: productionFor(requestScope!.root, requestScope!.id, project.key),
          productionControl: productionControlFor(requestScope!.root, requestScope!.id, project.key),
          reports: listProjectReports(ws, project.key),
          evaluations: listProjectEvaluations(ws, project.key),
        }, requestScope!.base), head);
        return;
      }

      const toggleMatch = /^\/p\/([^/]+)\/toggle$/.exec(routedPath);
      if (method === "POST" && toggleMatch) {
        const key = decodeProject(toggleMatch[1]);
        if (!key) {
          sendJson(res, 400, { error: "项目 key 无效" });
          return;
        }
        requireFormType(req);
        const form = new URLSearchParams(await readBody(req));
        const enabledRaw = form.get("enabled");
        if (enabledRaw !== "true" && enabledRaw !== "false") {
          sendJson(res, 400, { error: "enabled 必须是 true 或 false" });
          return;
        }
        const enabled = enabledRaw === "true";
        setProjectEnabled(requestScope!.root, key, enabled);
        redirect(res, `${requestScope!.base}/p/${encodeURIComponent(key)}?notice=${encodeURIComponent(enabled ? "项目已恢复创作" : "项目已暂停")}`);
        return;
      }

      const snapshot = requestScope ? snapshotNow(requestScope.root) : fleetSnapshot().find((workspace) => workspace.snapshot)?.snapshot;
      if (method !== "GET" && method !== "HEAD" && method !== "POST") {
        res.setHeader("allow", "GET, HEAD, POST");
        sendJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (snapshot) sendHtml(res, 404, notFoundPage(snapshot, "没有找到这个页面。", requestScope?.base ?? ""));
      else sendJson(res, 404, { error: "Not Found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = errorStatus(error);
      const wantsHtml = String(req.headers.accept ?? "").split(",").some((value) => value.trim().startsWith("text/html"));
      const onboardingNavigation = /^\/projects\/(?:plan|create)$/.test(routedPath);
      if (!res.headersSent && wantsHtml && onboardingNavigation && requestScope) {
        try { sendHtml(res, status, operationErrorPage(snapshotNow(requestScope.root), message, requestScope.base)); }
        catch { sendJson(res, status, { error: message }); }
      } else if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });
}

// server.close() 本身会等待 keep-alive/SSE；主动断开已建立连接，才能保证 Ctrl-C 可收尾。
export function closeStudioServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

type CliOptions = { host: string; port: number; workspaceId: string | null; single: boolean };

export function parseStudioArgs(argv: string[]): CliOptions {
  let host = "127.0.0.1";
  let port = 8791;
  let workspaceId: string | null = null;
  let single = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") {
      host = argv[++i] ?? "";
    } else if (arg === "--port") {
      const value = argv[++i] ?? "";
      port = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new StudioError("--port 必须是 1–65535 的整数");
    } else if (arg === "--workspace") {
      workspaceId = argv[++i] ?? "";
      if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new StudioError("--workspace 需要 ws_<32 hex> ID");
    } else if (arg === "--single") {
      single = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("writing-loop studio [--host 127.0.0.1|localhost|::1] [--port 8791] [--workspace ID] [--single]");
      process.exit(0);
    } else {
      throw new StudioError(`未知参数 '${arg}'`);
    }
  }
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new StudioError("Studio 目前只允许监听 127.0.0.1、localhost 或 ::1");
  }
  return { host, port, workspaceId, single };
}

const registryCatalog = (): StudioWorkspaceEntry[] => inspectWorkspaceRegistry().entries.map((entry) => ({
  id: entry.id,
  label: entry.label?.trim() || basename(entry.root) || entry.id,
  root: entry.root,
  status: entry.status,
  ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
}));

async function main(): Promise<void> {
  try {
    const cli = parseStudioArgs(process.argv.slice(2));
    const discoveredRoot = findWorkspaceRoot();
    let current: RegisteredWorkspace | null = null;
    if (discoveredRoot) {
      try { current = registerWorkspace(discoveredRoot); }
      catch (error) {
        // A corrupt/locked convenience registry must not make an otherwise healthy explicit
        // workspace unusable. A copied identity is different: when the registry can still see a
        // live root with the same ID, swallowing that conflict could route `/w/:id` to the wrong
        // story room. Preserve the registry's hard-stop in that case.
        const identity = ensureWorkspaceIdentity(discoveredRoot);
        const root = realpathSync(discoveredRoot);
        const conflict = inspectWorkspaceRegistry().entries.find((entry) =>
          entry.id === identity.id && entry.root !== root && entry.status !== "missing");
        if (conflict) throw error;
        current = { id: identity.id, root: discoveredRoot, label: basename(discoveredRoot) || identity.id };
      }
    }
    let selected: RegisteredWorkspace | null = cli.workspaceId ? resolveRegisteredWorkspace(cli.workspaceId) : current;
    const initialCatalog = registryCatalog();
    if (!selected) {
      const healthy = inspectWorkspaceRegistry().entries.find((entry) => entry.status === "ok");
      if (healthy) selected = { id: healthy.id, root: healthy.root, ...(healthy.label ? { label: healthy.label } : {}) };
    }
    if (!selected && !initialCatalog.length) {
      throw new StudioError("没有可用 workspace——在目标目录运行 writing-loop init，或 writing-loop workspace add DIR");
    }
    if (cli.single && !selected) {
      throw new StudioError("--single 需要一个健康 workspace；先运行 writing-loop workspace list 修复 degraded 指针");
    }
    const root = selected?.root ?? initialCatalog[0].root;
    const effectiveCatalog = (): StudioWorkspaceEntry[] => {
      const rows = registryCatalog();
      if (current && !rows.some((row) => row.id === current!.id)) rows.push({
        id: current.id, root: current.root, label: current.label ?? basename(current.root) ?? current.id, status: "ok",
      });
      return rows;
    };
    // A sole degraded pointer still needs the fleet shell so the operator can see the diagnostic;
    // it must never fall through to legacy single-workspace routing.
    const fleet = !cli.single && (effectiveCatalog().length > 1 || !selected);
    const server = createStudioServer({
      root,
      defaultWorkspaceId: selected?.id,
      ...(fleet ? { workspaceProvider: effectiveCatalog } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cli.port, cli.host, resolve);
    });
    const address = server.address() as AddressInfo;
    const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    console.log(`writing-loop studio: http://${displayHost}:${address.port}/`);
    console.log(`${fleet ? "多工作区创作总台" : "本地编剧工作台"}已启动；Ctrl-C 停止。浏览器写操作限于计划确认式立项与项目暂停/恢复。`);
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void closeStudioServer(server).then(() => process.exit(0), (error) => {
        console.error(`writing-loop studio: 停止失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(`writing-loop studio: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
