// Phase 1 gateway process assembly: server-owned registry, bearer boundary, three kernels in one
// process behind the strict router, and the read-only execution-profile snapshot export.
//
// The fixture reuses the packaged representative H3 bundle so the template graph, the H3 contract
// and the stage bindings stay a single source of truth with `examples/production/representative-h3`.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskFromCreate,
  transitionProductionTask,
  type AssetRef,
  type ProductionTask,
  type ProductionTaskCreate,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import type { RemoteObservation } from "../src/production-adapter.ts";
import {
  createProductionDispatchIntent,
  type ProductionIntentDraft,
  type ProductionIntentExecution,
} from "../src/production-intent.ts";
import {
  HttpProductionInputStager,
  productionInputStageKey,
} from "../src/production-input-stager.ts";
import { HttpProductionArtifactIngestor } from "../src/production-ingestor.ts";
import { ProductionGatewayAdapter } from "../src/production-job-gateway.ts";
import { materializeProductionH3Workflow } from "../src/production-h3-graph.ts";
import {
  exportExecutionProfileSnapshot,
  parseProductionGatewayRuntimeConfig,
  ProductionGatewayRuntimeConfigError,
} from "../src/production-gateway-runtime-config.ts";
import {
  ProductionGatewayCasAssetResolver,
  productionGatewayMain,
  startProductionGatewayProcess,
} from "../src/production-gateway-main.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT = "drama-a";
const BACKEND = "gateway-h3-fl2va";
const PROFILE_ID = "h3-fl2va-portrait";
const STAGE_PROFILE_ID = "h3-fl2va-portrait-stage";
const BEARER = "gateway-registry-bearer-SECRET-0001";
const BEARER_ENV = "WRITING_LOOP_TEST_GATEWAY_BEARER";
const REMOTE_ID = "11111111-1111-4111-8111-111111111111";
const SHA = { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64) };
const at = (second: number): string => `2026-08-10T12:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("gateway-first-frame"),
]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]),
  Buffer.from("gateway-take"),
]);

const exampleRoot = join(import.meta.dirname, "..", "examples", "production", "representative-h3");
const exampleRuntime = JSON.parse(
  readFileSync(join(exampleRoot, "production-runtime.json"), "utf8"),
) as Record<string, unknown>;
const templateText = readFileSync(join(exampleRoot, "workflows", "h3-fl2va-portrait.json"), "utf8");
const templateWorkflow = JSON.parse(templateText) as Record<string, unknown>;
const exampleWorkflow = (exampleRuntime.workflows as Record<string, unknown>[])[0]!;
const exampleStage = (exampleRuntime.stagingProfiles as Record<string, unknown>[])[0]!;
const INTENT_EXECUTION = exampleStage.execution as ProductionIntentExecution;
const H3_CONTRACT = exampleWorkflow.h3GraphContract as Record<string, unknown>;
const STAGE_BINDINGS = exampleStage.bindings as Record<string, unknown>[];

const roots: string[] = [];
const root = (): string => {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "writing-loop-gateway-main-")));
  roots.push(value);
  return value;
};

type ConfigOverrides = {
  listenHost?: string;
  configMode?: number;
};

function registryConfig(dirs: {
  objectsRoot: string;
  ingestRoot: string;
  jobStateRoot: string;
  comfyPort: number;
}, overrides: ConfigOverrides = {}): Record<string, unknown> {
  return {
    version: 1,
    listen: { version: 1, host: overrides.listenHost ?? "127.0.0.1", port: 0 },
    auth: { version: 1, bearerEnv: BEARER_ENV },
    backends: [{
      version: 1,
      backendInstanceId: BACKEND,
      kind: "comfyui",
      comfyBaseUrl: `http://127.0.0.1:${dirs.comfyPort}`,
      profileIds: [PROFILE_ID],
    }],
    executionProfiles: [{
      version: 1,
      execution: {
        version: 1,
        kind: "writing-loop/execution-profile",
        profileId: PROFILE_ID,
        backendInstanceId: BACKEND,
        workflowSha256: exampleWorkflow.workflowSha256,
        modelSha256: exampleWorkflow.modelSha256,
        parametersSha256: exampleWorkflow.parametersSha256,
        resolution: "768p",
        aspectRatio: "9:16",
        generateAudio: true,
        modelFamily: "minimax-h3",
        operation: "comfyui-workflow",
        variant: "fl2va",
        shortEdge: 768,
        durationSeconds: 8,
      },
      workflowFile: "workflows/h3-fl2va-portrait.json",
      stageProfileId: STAGE_PROFILE_ID,
      h3GraphContract: H3_CONTRACT,
      priceTable: {
        version: 1,
        basis: "tariff",
        currency: "USD",
        microsPerOutputSecond: 430,
        priceAsOf: "2026-08-28T00:00:00.000Z",
        source: "GCP g4-standard-48 Spot asia-southeast1",
      },
      license: {
        version: 1,
        status: "verified",
        basis: "community",
        territories: ["SG"],
        licenseSha256: null,
        evidence: null,
        issuedBy: "MiniMaxAI",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        obligations: {
          attribution: "MiniMax H3",
          revenueThresholdUsd: 20_000_000,
          noModelImprovement: true,
        },
      },
      processingRegions: ["SG"],
    }],
    stageProfiles: [{
      version: 1,
      stageProfileId: STAGE_PROFILE_ID,
      providerCasNamespace: "wlcas/sha256",
      inputs: [{ version: 1, index: 0, slot: "first_frame", mediaTypes: ["image/png"] }],
      bindings: STAGE_BINDINGS,
    }],
    casAuthority: "wl-sg",
    objectsRoot: dirs.objectsRoot,
    ingestRoot: dirs.ingestRoot,
    jobStateRoot: dirs.jobStateRoot,
    admission: { version: 1, maxConcurrentPerBackend: 2 },
    reconcilePolicy: {
      version: 1,
      unknownRemoteJob: "provider-failed-preempted",
      minObservationAgeSeconds: 60,
    },
  };
}

function writeRegistry(
  dirs: { objectsRoot: string; ingestRoot: string; jobStateRoot: string; comfyPort: number },
  configRoot: string,
  overrides: ConfigOverrides = {},
): string {
  mkdirSync(join(configRoot, "workflows"), { recursive: true, mode: 0o700 });
  writeFileSync(join(configRoot, "workflows", "h3-fl2va-portrait.json"), templateText, { mode: 0o600 });
  const configFile = join(configRoot, "gateway-registry.json");
  writeFileSync(
    configFile,
    `${JSON.stringify(registryConfig(dirs, overrides), null, 2)}\n`,
    { mode: overrides.configMode ?? 0o600 },
  );
  return configFile;
}

function casAsset(bytes: Uint8Array, mediaType: string): AssetRef {
  const sha256 = digest(bytes);
  return { version: 1, uri: `cas://wl-sg/sha256/${sha256}`, sha256, byteLength: bytes.byteLength, mediaType };
}

const FIRST_FRAME = casAsset(PNG, "image/png");

function dispatchIntent(taskId = "take-h3-001"): ReturnType<typeof createProductionDispatchIntent> {
  const source = (uri: string, sha256: string): AssetRef => ({
    version: 1, uri, sha256, byteLength: 123, mediaType: "application/json",
  });
  const draft: ProductionIntentDraft = {
    version: 1,
    taskId,
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "ep-001",
          revision: 1,
          source: source("s3://trusted-inputs/episode.json", SHA.a),
        },
        shotId: "shot-001-01",
        revision: 1,
        source: source("s3://trusted-inputs/shot.json", SHA.b),
      },
    },
    createdAt: at(0),
    useTerritories: ["SG"],
    execution: structuredClone(INTENT_EXECUTION),
    inputs: [structuredClone(FIRST_FRAME)],
    budget: { version: 1, currency: "USD", estimatedAmountMicros: 3_440, maximumAmountMicros: 5_160 },
    rights: {
      version: 1,
      status: "cleared",
      territories: ["SG"],
      evidence: source("s3://trusted-inputs/rights.json", SHA.c),
      expiresAt: null,
    },
    moderation: {
      version: 1,
      status: "passed",
      reviewedAt: at(1),
      evidence: source("s3://trusted-inputs/moderation.json", SHA.d),
    },
    license: {
      version: 1,
      status: "verified",
      basis: "community",
      territories: ["SG"],
      licenseSha256: SHA.d,
      evidence: source("s3://trusted-inputs/license.txt", SHA.d),
      issuedBy: "MiniMax",
      issuedAt: at(0),
      expiresAt: null,
    },
  };
  return createProductionDispatchIntent(draft);
}

function ingestingTask(taskId: string, remoteJobId: string): ProductionTask {
  const create: ProductionTaskCreate = {
    version: 1,
    id: taskId,
    idempotencyKey: `idem-${taskId}`,
    subject: dispatchIntent(taskId).subject,
    createdAt: at(0),
  };
  const event = (
    task: ProductionTask,
    type: ProductionTaskEvent["type"],
    id: string,
    second: number,
    extra: Record<string, unknown> = {},
  ): ProductionTaskEvent => ({
    version: 1,
    type,
    eventId: id,
    taskId: task.id,
    expectedRevision: task.revision,
    occurredAt: at(second),
    ...extra,
  } as ProductionTaskEvent);
  let task = taskFromCreate(create);
  task = transitionProductionTask(task, event(task, "dispatch-requested", `${taskId}-dispatch`, 1));
  task = transitionProductionTask(task, event(task, "submission-started", `${taskId}-submit`, 2, {
    backendInstanceId: BACKEND, remoteJobId, requestDigest: SHA.c,
  }));
  task = transitionProductionTask(task, event(task, "submission-confirmed", `${taskId}-confirmed`, 3, {
    backendInstanceId: BACKEND, remoteJobId,
  }));
  return transitionProductionTask(task, event(task, "ingestion-started", `${taskId}-ingest`, 4));
}

type ComfyServer = { port: number; prompts: string[]; close(): Promise<void> };

async function startFakeComfy(): Promise<ComfyServer> {
  const prompts: string[] = [];
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown): void => {
      const body = JSON.stringify(value);
      outgoing.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
      });
      outgoing.end(body);
    };
    if (incoming.method === "POST" && url.pathname === "/prompt") {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt_id?: string };
        prompts.push(String(body.prompt_id));
        json({ prompt_id: body.prompt_id, number: prompts.length, node_errors: {} });
      });
      return;
    }
    if (incoming.method === "GET" && url.pathname === "/queue") {
      json({ queue_running: [], queue_pending: [] });
      return;
    }
    if (incoming.method === "GET" && url.pathname.startsWith("/history/")) {
      json({});
      return;
    }
    if (incoming.method === "GET" && url.pathname === "/view") {
      outgoing.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(MP4.byteLength),
      });
      outgoing.end(MP4);
      return;
    }
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end("{}");
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake comfy address invalid");
  return {
    port: address.port,
    prompts,
    close: async () => await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

const comfy = await startFakeComfy();
try {
  // ── Registry config: fail-closed bind host and owner-only file mode ──
  const publicBind = registryConfig(
    { objectsRoot: "/tmp/objects", ingestRoot: "/tmp/ingest", jobStateRoot: "/tmp/jobs", comfyPort: comfy.port },
    { listenHost: "0.0.0.0" },
  );
  let wildcardRejected = false;
  try { parseProductionGatewayRuntimeConfig(publicBind); }
  catch (error) { wildcardRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(wildcardRejected, "listen.host 为 0.0.0.0 时装配前拒绝");
  let publicRejected = false;
  try {
    parseProductionGatewayRuntimeConfig(registryConfig(
      { objectsRoot: "/tmp/objects", ingestRoot: "/tmp/ingest", jobStateRoot: "/tmp/jobs", comfyPort: comfy.port },
      { listenHost: "203.0.113.9" },
    ));
  } catch (error) { publicRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(publicRejected, "listen.host 为公网 IP 时装配前拒绝");

  let sharedRootRejected = false;
  try {
    parseProductionGatewayRuntimeConfig(registryConfig({
      objectsRoot: "/tmp/shared", ingestRoot: "/tmp/shared", jobStateRoot: "/tmp/jobs",
      comfyPort: comfy.port,
    }));
  } catch (error) { sharedRootRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(sharedRootRejected, "三个 durable root 指向同一目录时拒绝");
  const mediaTypeRejected = (mediaTypes: string[]): boolean => {
    try {
      const bad = registryConfig({
        objectsRoot: "/tmp/objects", ingestRoot: "/tmp/ingest", jobStateRoot: "/tmp/jobs",
        comfyPort: comfy.port,
      });
      ((bad.stageProfiles as Record<string, unknown>[])[0]!.inputs as Record<string, unknown>[])[0]!
        .mediaTypes = mediaTypes;
      parseProductionGatewayRuntimeConfig(bad);
      return false;
    } catch (error) { return error instanceof ProductionGatewayRuntimeConfigError; }
  };
  ok(mediaTypeRejected(["application/pdf"]),
    "stage profile 的 mediaTypes 不在 stage kernel 白名单内时装配前拒绝");
  ok(mediaTypeRejected(["image/webp", "image/png"]),
    "stage profile 的 mediaTypes 非字典序升序时装配前拒绝（否则每个 stages 请求 500）");
  let nestedRootRejected = false;
  try {
    parseProductionGatewayRuntimeConfig(registryConfig({
      objectsRoot: "/tmp/state", ingestRoot: "/tmp/state/ingest", jobStateRoot: "/tmp/jobs",
      comfyPort: comfy.port,
    }));
  } catch (error) { nestedRootRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(nestedRootRejected, "durable root 互相嵌套时拒绝");
  let multiBackendRejected = false;
  try {
    const twoBackends = registryConfig({
      objectsRoot: "/tmp/objects", ingestRoot: "/tmp/ingest", jobStateRoot: "/tmp/jobs",
      comfyPort: comfy.port,
    });
    const backends = twoBackends.backends as Record<string, unknown>[];
    twoBackends.backends = [backends[0]!, { ...backends[0]!, backendInstanceId: "gateway-h3-second" }];
    parseProductionGatewayRuntimeConfig(twoBackends);
  } catch (error) { multiBackendRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(multiBackendRejected, "单进程配置第二个 backend 时在解析层拒绝");
  let unboundProfileRejected = false;
  try {
    const orphan = registryConfig({
      objectsRoot: "/tmp/objects", ingestRoot: "/tmp/ingest", jobStateRoot: "/tmp/jobs",
      comfyPort: comfy.port,
    });
    (orphan.backends as Record<string, unknown>[])[0]!.profileIds = ["h3-other-profile"];
    parseProductionGatewayRuntimeConfig(orphan);
  } catch (error) { unboundProfileRejected = error instanceof ProductionGatewayRuntimeConfigError; }
  ok(unboundProfileRejected, "backend 引用未登记 profileId 时拒绝");

  const looseRoot = root();
  const looseDirs = {
    objectsRoot: join(looseRoot, "objects"),
    ingestRoot: join(looseRoot, "ingest"),
    jobStateRoot: join(looseRoot, "jobs"),
    comfyPort: comfy.port,
  };
  const looseConfig = writeRegistry(looseDirs, looseRoot, { configMode: 0o644 });
  const looseExit = await productionGatewayMain(
    ["--config", looseConfig], looseRoot, { signalSource: null, env: { [BEARER_ENV]: BEARER } },
  );
  ok(looseExit === 1, "registry config 文件权限不是 0400/0600 时进程拒绝启动");

  // ── Read-only execution profile snapshot ──
  const snapshotRoot = root();
  const snapshotDirs = {
    objectsRoot: join(snapshotRoot, "objects"),
    ingestRoot: join(snapshotRoot, "ingest"),
    jobStateRoot: join(snapshotRoot, "jobs"),
    comfyPort: comfy.port,
  };
  const snapshotConfigFile = writeRegistry(snapshotDirs, snapshotRoot);
  const snapshotOut = join(snapshotRoot, "export", "execution-profiles.json");
  const snapshotExit = await productionGatewayMain(
    ["--config", snapshotConfigFile, "--export-profile-snapshot", snapshotOut],
    snapshotRoot,
    { signalSource: null, env: { [BEARER_ENV]: BEARER } },
  );
  const snapshot = JSON.parse(readFileSync(snapshotOut, "utf8")) as {
    version: number;
    kind: string;
    casAuthority: string;
    profiles: Array<Record<string, unknown>>;
  };
  const expectedSnapshot = exportExecutionProfileSnapshot(
    parseProductionGatewayRuntimeConfig(registryConfig(snapshotDirs)),
  );
  ok(snapshotExit === 0 && snapshot.version === 1
    && snapshot.kind === "writing-loop/execution-profile-snapshot"
    && snapshot.casAuthority === "wl-sg" && snapshot.profiles.length === 1,
  "--export-profile-snapshot 导出只读 v1 快照");
  const snapshotBytes = readFileSync(snapshotOut);
  ok(snapshotBytes.equals(Buffer.from(`${JSON.stringify(expectedSnapshot, null, 2)}\n`, "utf8"))
    && (statSync(snapshotOut).mode & 0o777) === 0o600,
  "导出的快照文件与同一 registry 配置的序列化逐字节一致，且 mode 为 0600");
  ok(snapshot.profiles[0]!.profileDigest === expectedSnapshot.profiles[0]!.profileDigest
    && /^[a-f0-9]{64}$/.test(String(snapshot.profiles[0]!.profileDigest))
    && (snapshot.profiles[0]!.execution as { workflowSha256: string }).workflowSha256
      === exampleWorkflow.workflowSha256
    && JSON.stringify(snapshot.profiles[0]!.durationGrid) === "[8]"
    && (snapshot.profiles[0]!.priceTable as { microsPerOutputSecond: number }).microsPerOutputSecond === 430
    && !("licenseObligations" in (snapshot.profiles[0]!.execution as Record<string, unknown>))
    && (snapshot.profiles[0]!.license as { obligations?: { attribution?: string } }).obligations?.attribution
      === "MiniMax H3",
  "快照 profile digest 与配置一致，并携带 workflowSha256、时长网格、价目与 license.obligations");
  const driftedSnapshot = exportExecutionProfileSnapshot(parseProductionGatewayRuntimeConfig({
    ...registryConfig(snapshotDirs),
    executionProfiles: [{
      ...(registryConfig(snapshotDirs).executionProfiles as Record<string, unknown>[])[0]!,
      processingRegions: ["CN"],
    }],
  }));
  ok(driftedSnapshot.profiles[0]!.profileDigest !== expectedSnapshot.profiles[0]!.profileDigest,
    "registry 内容变更后快照 digest 随之变化");

  const oversizedRoot = root();
  const oversizedDirs = {
    objectsRoot: join(oversizedRoot, "objects"),
    ingestRoot: join(oversizedRoot, "ingest"),
    jobStateRoot: join(oversizedRoot, "jobs"),
    comfyPort: comfy.port,
  };
  const oversizedConfig = writeRegistry(oversizedDirs, oversizedRoot);
  writeFileSync(
    join(oversizedRoot, "workflows", "h3-fl2va-portrait.json"),
    `${JSON.stringify({ ...templateWorkflow, padding: { class_type: "Note", inputs: { text: "x".repeat(5 * 1024 * 1024) } } })}\n`,
    { mode: 0o600 },
  );
  const oversizedExit = await productionGatewayMain(
    ["--config", oversizedConfig, "--export-profile-snapshot", join(oversizedRoot, "snapshot.json")],
    oversizedRoot,
    { signalSource: null, env: { [BEARER_ENV]: BEARER } },
  );
  ok(oversizedExit === 1 && !existsSync(join(oversizedRoot, "snapshot.json")),
    "pinned graph 超过 4 MB 读取上限时拒绝，且不落快照");

  const driftedGraphRoot = root();
  const driftedGraphDirs = {
    objectsRoot: join(driftedGraphRoot, "objects"),
    ingestRoot: join(driftedGraphRoot, "ingest"),
    jobStateRoot: join(driftedGraphRoot, "jobs"),
    comfyPort: comfy.port,
  };
  const driftedGraphConfig = writeRegistry(driftedGraphDirs, driftedGraphRoot);
  writeFileSync(
    join(driftedGraphRoot, "workflows", "h3-fl2va-portrait.json"),
    `${JSON.stringify({ ...templateWorkflow, "999": { class_type: "PreviewImage", inputs: {} } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const driftedExit = await productionGatewayMain(
    ["--config", driftedGraphConfig, "--export-profile-snapshot", join(driftedGraphRoot, "snapshot.json")],
    driftedGraphRoot,
    { signalSource: null, env: { [BEARER_ENV]: BEARER } },
  );
  ok(driftedExit === 1, "pinned graph 与 execution profile digest 漂移时拒绝导出快照");

  // ── Whole-process assembly against a fake ComfyUI on loopback ──
  const liveRoot = root();
  const liveDirs = {
    objectsRoot: join(liveRoot, "objects"),
    ingestRoot: join(liveRoot, "ingest"),
    jobStateRoot: join(liveRoot, "jobs"),
    comfyPort: comfy.port,
  };
  const liveConfigFile = writeRegistry(liveDirs, liveRoot);
  const gateway = await startProductionGatewayProcess({
    configFile: liveConfigFile,
    env: { [BEARER_ENV]: BEARER },
  });
  try {
    const origin = `http://${gateway.server.address.host}:${gateway.server.address.port}`;
    ok(gateway.server.address.host === "127.0.0.1" && gateway.server.address.port > 0,
      "进程绑定配置中的字面私网 IP");

    // The continuity input is already in the gateway's own ingest CAS, exactly like a last frame
    // that a previous take produced (§6.4). The stage kernel resolves it through `cas://`.
    const blobDirectory = join(liveDirs.ingestRoot, "blobs", "sha256", FIRST_FRAME.sha256.slice(0, 2));
    mkdirSync(blobDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(blobDirectory, FIRST_FRAME.sha256), PNG, { mode: 0o400 });

    const intent = dispatchIntent();
    const stageKey = productionInputStageKey(WS, PROJECT, intent);
    const unauthenticated = await fetch(
      `${origin}/v1/scopes/${WS}/${PROJECT}/stages/${stageKey}`,
      {
        method: "PUT",
        redirect: "error",
        headers: { "content-type": "application/json", "x-writing-loop-idempotency-key": stageKey },
        body: "{}",
      },
    );
    ok(unauthenticated.status === 401 && (await unauthenticated.json() as { error: string }).error === "unauthorized",
      "缺失 Authorization 的 stages 请求被 bearer 层拒为 401");
    const wrongBearer = await fetch(
      `${origin}/v1/scopes/${WS}/${PROJECT}/jobs/${REMOTE_ID}`,
      { headers: { authorization: `Bearer ${BEARER}-wrong` }, redirect: "error" },
    );
    ok(wrongBearer.status === 401, "错误 bearer 的 jobs 请求被拒为 401");
    const missingIngestBearer = await fetch(
      `${origin}/v1/scopes/${WS}/${PROJECT}/ingests/${SHA.a}`,
      {
        method: "PUT",
        redirect: "error",
        headers: { "content-type": "application/json", "x-writing-loop-idempotency-key": SHA.a },
        body: "{}",
      },
    );
    ok(missingIngestBearer.status === 401, "缺失 Authorization 的 ingests 请求被拒为 401");
    const missingAssetBearer = await fetch(
      `${origin}/v1/scopes/${WS}/${PROJECT}/assets/sha256/${SHA.a}`, { redirect: "error" },
    );
    ok(missingAssetBearer.status === 401, "缺失 Authorization 的 assets GET 被拒为 401");

    // stages: real private-network staging by the worker-side client.
    const stager = new HttpProductionInputStager({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });
    const staged = await stager.stage(intent);
    ok(staged.stageKey === stageKey && staged.bindings.length === 1
      && staged.bindings[0]!.slot === "first_frame"
      && staged.bindings[0]!.assetSha256 === FIRST_FRAME.sha256
      && staged.bindings[0]!.providerObjectKey
        === `wlcas/sha256/${FIRST_FRAME.sha256.slice(0, 2)}/${FIRST_FRAME.sha256}`,
    "stages 路由冒烟：cas:// 首帧经私网 HTTP 登记为 provider CAS 对象");

    // A symlink planted at the blob path must not let the stage kernel read outside the CAS.
    const outside = join(liveRoot, "outside-the-cas.png");
    writeFileSync(outside, PNG, { mode: 0o600 });
    const probeRoot = root();
    const probeDirectory = join(probeRoot, "blobs", "sha256", FIRST_FRAME.sha256.slice(0, 2));
    mkdirSync(probeDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(probeDirectory, FIRST_FRAME.sha256));
    const symlinkResolver = new ProductionGatewayCasAssetResolver("wl-sg", probeRoot);
    let symlinkRejected = false;
    try {
      await symlinkResolver.resolve(
        { version: 1, workspaceId: WS, project: PROJECT },
        FIRST_FRAME,
        new AbortController().signal,
      );
    } catch { symlinkRejected = true; }
    ok(symlinkRejected, "cas resolver 用 lstat 判定，blob 路径为 symlink 时拒绝而不跟随");
    const linkedDigest = digest(PNG);
    const linkedDirectory = join(liveDirs.ingestRoot, "blobs", "sha256", linkedDigest.slice(0, 2));
    const linkedBlob = join(linkedDirectory, linkedDigest);
    rmSync(linkedBlob);
    symlinkSync(outside, linkedBlob);
    let symlinkStageRejected = false;
    try { await stager.stage(dispatchIntent("take-h3-symlink-stage")); }
    catch { symlinkStageRejected = true; }
    rmSync(linkedBlob);
    writeFileSync(linkedBlob, PNG, { mode: 0o400 });
    ok(symlinkStageRejected, "blob 位置换成 symlink 后 stages 请求被拒，不跟随到 CAS 之外");

    const wrongBearerStager = new HttpProductionInputStager({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      transport: "insecure-private-http",
      credentialResolver: () => `${BEARER}-wrong`,
    });
    let stageRejected = false;
    try { await wrongBearerStager.stage(intent); }
    catch { stageRejected = true; }
    ok(stageRejected, "错误 bearer 的 worker stage 调用被拒");

    // jobs: the bound workflow the worker computes must match what the gateway rebuilds.
    const materialized = materializeProductionH3Workflow(
      templateWorkflow,
      H3_CONTRACT as never,
      INTENT_EXECUTION,
      STAGE_BINDINGS as never,
      staged.bindings.map((binding) => ({
        index: binding.index,
        slot: binding.slot,
        assetSha256: binding.assetSha256,
        providerObjectKey: binding.providerObjectKey,
      })),
      PROFILE_ID,
    );
    const adapter = new ProductionGatewayAdapter({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });
    const submitted = await adapter.submitPrepared(adapter.prepareSubmission({
      idempotencyKey: intent.idempotencyKey,
      remoteJobId: REMOTE_ID,
      workflow: materialized.workflow,
      inputBinding: {
        version: 1,
        stageKey: staged.stageKey,
        bindingsDigest: staged.bindingsDigest,
        intentDigest: intent.idempotencyKey,
      },
    }));
    ok(submitted.remoteJobId === REMOTE_ID && submitted.providerIdempotency === false
      && comfy.prompts.length === 1 && comfy.prompts[0] === REMOTE_ID,
    "jobs 路由冒烟：gateway 从 server-owned template 重建 bound graph 并向 ComfyUI 提交恰好一次");

    const observed = await adapter.inspect(REMOTE_ID);
    ok(observed.remoteJobId === REMOTE_ID && observed.state === "not-found",
      "jobs GET 路由把 raw 观察经同一 bearer 边界回传");

    // ingests: the gateway pulls the audited output locator from the same loopback ComfyUI.
    const ingestor = new HttpProductionArtifactIngestor({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });
    const task = ingestingTask("take-h3-001", REMOTE_ID);
    const observation: RemoteObservation = {
      remoteJobId: REMOTE_ID,
      state: "succeeded",
      observedAt: at(5),
      outputs: [{
        nodeId: "70", kind: "video", filename: "take.mp4", subfolder: "video/final", folderType: "output",
      }],
      errorSummary: null,
      responseDigest: SHA.b,
    };
    const ingested = await ingestor.ingest(task, observation);
    ok(ingested.assets.length === 1 && ingested.assets[0]!.sha256 === digest(MP4)
      && ingested.assets[0]!.uri === `urn:sha256:${digest(MP4)}`
      && ingested.assets[0]!.mediaType === "video/mp4",
    "ingests 路由冒烟：产物按内容寻址入 CAS 并回 urn:sha256 AssetRef");
  } finally {
    await gateway.close();
  }

  const closedProbe = await fetch(
    `http://127.0.0.1:${gateway.server.address.port}/v1/scopes/${WS}/${PROJECT}/jobs/${REMOTE_ID}`,
    { headers: { authorization: `Bearer ${BEARER}` }, redirect: "error" },
  ).then(() => "reachable", () => "closed");
  ok(closedProbe === "closed", "优雅停机后端口不再接受连接");
} finally {
  await comfy.close();
  for (const path of roots) rmSync(path, { recursive: true, force: true });
}

if (fails) {
  console.error(`\n${fails} production gateway main assertion(s) failed`);
  process.exit(1);
}
console.log("\nPRODUCTION_GATEWAY_MAIN_OK");
