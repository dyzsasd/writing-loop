// Strict Fetch-compatible composition boundary for the three private production gateway kernels.
//
// This router does not parse credentials, bodies, scope IDs or provider data. It only selects a
// server-owned handler from an exact resource segment and HTTP method. Each handler remains the
// authority for its own strict DTO, authentication, deadline and durable state.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface ProductionGatewayRouteHandler {
  handle(request: Request): Promise<Response>;
  close(): void;
}

export type ProductionGatewayRouterOptions = {
  jobs: ProductionGatewayRouteHandler;
  stages: ProductionGatewayRouteHandler;
  artifacts: ProductionGatewayRouteHandler;
};

export type ProductionGatewayRouterListenOptions = {
  bindHost?: string;
  bindPort?: number;
};

export type ProductionGatewayRouterServer = {
  router: ProductionGatewayRouter;
  address: { host: string; port: number };
  close(): Promise<void>;
};

type RouteTarget = keyof ProductionGatewayRouterOptions;

const METHODS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  jobs: new Set(["GET", "PUT"]),
  stages: new Set(["PUT"]),
  ingests: new Set(["PUT"]),
  // §6.4: one content-addressed object, read with GET, probed with HEAD, published with PUT.
  assets: new Set(["GET", "HEAD", "PUT"]),
  // §8.6: the scope-level capability resource has no per-object segment.
  capabilities: new Set(["GET"]),
});

function fixedJson(status: number, error: "not-found" | "service-unavailable" | "internal"): Response {
  return new Response(JSON.stringify({ version: 1, error }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function validHandler(value: unknown): value is ProductionGatewayRouteHandler {
  return value !== null && typeof value === "object"
    && typeof (value as ProductionGatewayRouteHandler).handle === "function"
    && typeof (value as ProductionGatewayRouteHandler).close === "function";
}

function privateBindHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    if (octets[0] === 127 || octets[0] === 10
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254)) return host;
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    if (normalized === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return host;
  }
  throw new TypeError("production gateway router bindHost must be a literal private IP");
}

function bindPort(value: number | undefined): number {
  const port = value ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("production gateway router bindPort invalid");
  }
  return port;
}

function route(request: Request): RouteTarget | null {
  const url = new URL(request.url);
  if (url.search || url.hash || url.pathname.startsWith("//")) return null;
  const parts = url.pathname.split("/");
  if (parts.length < 6 || parts[0] !== "" || parts[1] !== "v1" || parts[2] !== "scopes"
    || parts[3] === "" || parts[4] === "" || parts[5] === "") return null;
  const resource = parts[5]!;
  const methods = METHODS[resource];
  if (methods === undefined || !methods.has(request.method)) return null;
  // Only `capabilities` is a scope-level resource; every other one addresses exactly one object.
  if (resource === "capabilities") return parts.length === 6 ? "jobs" : null;
  if (parts.length < 7 || parts[6] === "") return null;
  if (resource === "jobs") return "jobs";
  if (resource === "stages") return "stages";
  return "artifacts";
}

export class ProductionGatewayRouter implements ProductionGatewayRouteHandler {
  readonly #handlers: Readonly<ProductionGatewayRouterOptions>;
  #closed = false;

  constructor(options: ProductionGatewayRouterOptions) {
    if (!options || typeof options !== "object" || !validHandler(options.jobs)
      || !validHandler(options.stages) || !validHandler(options.artifacts)) {
      throw new TypeError("production gateway router handlers invalid");
    }
    this.#handlers = Object.freeze({
      jobs: options.jobs,
      stages: options.stages,
      artifacts: options.artifacts,
    });
  }

  async handle(request: Request): Promise<Response> {
    if (this.#closed) return fixedJson(503, "service-unavailable");
    const target = route(request);
    if (target === null) return fixedJson(404, "not-found");
    try { return await this.#handlers[target].handle(request); }
    catch { return fixedJson(500, "internal"); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Set<ProductionGatewayRouteHandler>();
    for (const handler of Object.values(this.#handlers)) {
      if (closed.has(handler)) continue;
      closed.add(handler);
      try { handler.close(); }
      catch { /* close is best-effort; all remaining handlers still receive shutdown. */ }
    }
  }
}

function nodeRequest(incoming: IncomingMessage, host: string, port: number): Request {
  const rawPath = incoming.url ?? "/";
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) throw new TypeError("invalid request target");
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort(new Error("client-aborted")));
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(incoming) as globalThis.ReadableStream<Uint8Array>;
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return new Request(`http://${authority}:${port}${rawPath}`, {
    method,
    headers,
    body,
    signal: controller.signal,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function sendNodeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) { outgoing.end(); return; }
  const source = Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>);
  await new Promise<void>((resolvePromise) => {
    const done = (): void => resolvePromise();
    outgoing.once("close", done);
    outgoing.once("finish", done);
    source.once("error", () => outgoing.destroy());
    source.pipe(outgoing);
  });
}

/**
 * Starts one private-IP HTTP boundary for already-authenticated gateway kernels. Production TLS or
 * mTLS termination remains an infrastructure concern; binding wildcard/public hostnames is denied.
 */
export async function startProductionGatewayRouter(
  router: ProductionGatewayRouter,
  options: ProductionGatewayRouterListenOptions = {},
): Promise<ProductionGatewayRouterServer> {
  if (!(router instanceof ProductionGatewayRouter)) throw new TypeError("production gateway router invalid");
  const host = privateBindHost(options.bindHost);
  const requestedPort = bindPort(options.bindPort);
  let effectivePort = requestedPort;
  let server: Server | null = createServer((incoming, outgoing) => {
    let request: Request;
    try { request = nodeRequest(incoming, host, effectivePort); }
    catch { void sendNodeResponse(fixedJson(404, "not-found"), outgoing); return; }
    void router.handle(request).then(
      (response) => sendNodeResponse(response, outgoing),
      () => sendNodeResponse(fixedJson(500, "internal"), outgoing),
    ).catch(() => { if (!outgoing.destroyed) outgoing.destroy(); });
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server!.once("error", reject);
      server!.listen(requestedPort, host, () => {
        server!.removeListener("error", reject);
        resolvePromise();
      });
    });
    const actual = server.address();
    if (actual === null || typeof actual === "string") throw new TypeError("production gateway address invalid");
    effectivePort = actual.port;
    return {
      router,
      address: { host, port: actual.port },
      close: async () => {
        router.close();
        const current = server;
        if (current === null) return;
        server = null;
        await new Promise<void>((resolvePromise) => current.close(() => resolvePromise()));
      },
    };
  } catch (error) {
    router.close();
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()) ?? resolvePromise());
    throw error;
  }
}
