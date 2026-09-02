// Phase 1 gateway process assembly: server-owned registry, bearer boundary, three kernels in one
// process behind the strict router, and the read-only execution-profile snapshot export.
//
// The fixture reuses the packaged representative H3 bundle so the template graph, the H3 contract
// and the stage bindings stay a single source of truth with `examples/production/representative-h3`.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import {
  ProductionGatewayAdapter,
  productionJobPutRequestDigest,
  productionJobWorkflowDigest,
} from "../src/production-job-gateway.ts";
import { parseVideoBackendLimits } from "../src/production-provider-adapter.ts";
import {
  SHOT_REQUEST_MEDIA_TYPE,
  parseShotRequest,
  shotRequestCanonicalJson,
  type ShotRequest,
} from "../src/production-shot-request.ts";
import { materializeProductionH3Workflow } from "../src/production-h3-graph.ts";
import {
  exportExecutionProfileSnapshot,
  parseProductionGatewayRuntimeConfig,
  productionGatewayH3Profiles,
  ProductionGatewayRuntimeConfigError,
} from "../src/production-gateway-runtime-config.ts";
import {
  ProductionGatewayCasAssetResolver,
  productionGatewayMain,
  startProductionGatewayProcess,
} from "../src/production-gateway-main.ts";
import {
  productionCasObjectPath,
  writeProductionCasObject,
} from "../src/production-cas.ts";
import { WorkspaceCasLocalAssetSource } from "../src/production-local-asset-source.ts";
import { productionGatewayBlobPath } from "../src/production-gateway.ts";

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
const TERMINAL_REMOTE_ID = "44444444-4444-4444-8444-444444444444";
const REJECTED_REMOTE_ID = "55555555-5555-4555-8555-555555555555";
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

// 打包示例的契约 v2 档：同一张图，prompt / seed 为 sentinel，stage 绑定前置 index 0 的 shot-request。
const exampleRuntimeV2 = JSON.parse(
  readFileSync(join(exampleRoot, "production-runtime-v2.json"), "utf8"),
) as Record<string, unknown>;
const templateTextV2 = readFileSync(
  join(exampleRoot, "workflows", "h3-fl2va-portrait-v2.json"), "utf8",
);
const templateWorkflowV2 = JSON.parse(templateTextV2) as Record<string, unknown>;
const exampleWorkflowV2 = (exampleRuntimeV2.workflows as Record<string, unknown>[])[0]!;
const exampleStageV2 = (exampleRuntimeV2.stagingProfiles as Record<string, unknown>[])[0]!;
const PROFILE_ID_V2 = String(exampleStageV2.profileId);
const STAGE_PROFILE_ID_V2 = `${PROFILE_ID_V2}-stage`;
const INTENT_EXECUTION_V2 = exampleStageV2.execution as ProductionIntentExecution;
const H3_CONTRACT_V2 = exampleWorkflowV2.h3GraphContract as Record<string, unknown>;
const STAGE_BINDINGS_V2 = exampleStageV2.bindings as Record<string, unknown>[];

const roots: string[] = [];
const root = (): string => {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "writing-loop-gateway-main-")));
  roots.push(value);
  return value;
};

type ConfigOverrides = {
  listenHost?: string;
  configMode?: number;
  maxInputImageBytes?: number;
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
      maxInputImageBytes: overrides.maxInputImageBytes ?? 16 * 1024 * 1024,
      profileIds: [PROFILE_ID, PROFILE_ID_V2],
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
    }, {
      version: 1,
      execution: {
        version: 1,
        kind: "writing-loop/execution-profile",
        profileId: PROFILE_ID_V2,
        backendInstanceId: BACKEND,
        workflowSha256: exampleWorkflowV2.workflowSha256,
        modelSha256: exampleWorkflowV2.modelSha256,
        parametersSha256: exampleWorkflowV2.parametersSha256,
        resolution: "768p",
        aspectRatio: "9:16",
        generateAudio: true,
        modelFamily: "minimax-h3",
        operation: "comfyui-workflow",
        variant: "fl2va",
        shortEdge: 768,
        durationSeconds: 8,
      },
      workflowFile: `workflows/${PROFILE_ID_V2}.json`,
      stageProfileId: STAGE_PROFILE_ID_V2,
      h3GraphContract: H3_CONTRACT_V2,
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
    }, {
      version: 1,
      stageProfileId: STAGE_PROFILE_ID_V2,
      providerCasNamespace: "wlcas/sha256",
      inputs: [
        {
          version: 1,
          index: 0,
          slot: "shot-request",
          mediaTypes: ["application/vnd.writing-loop.shot-request+json"],
        },
        { version: 1, index: 1, slot: "first_frame", mediaTypes: ["image/png"] },
      ],
      bindings: STAGE_BINDINGS_V2,
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
  writeFileSync(join(configRoot, "workflows", `${PROFILE_ID_V2}.json`), templateTextV2, { mode: 0o600 });
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

/** 契约 v2 的 inputs[0]：stage kernel 内容校验它，并把 prompt / seed 投影进回执。 */
function shotRequestFor(seed: number | null, text = "夜色中的天台，人物背对镜头缓慢后拉"): ShotRequest {
  const source = (sha256: string): AssetRef => ({
    version: 1, uri: `cas://wl-sg/sha256/${sha256}`, sha256, byteLength: 8_192, mediaType: "text/markdown",
  });
  return parseShotRequest({
    version: 1,
    kind: "writing-loop/shot-request",
    shotId: "shot-001-01",
    subject: {
      version: 1,
      episode: { version: 1, episodeId: "ep-001", revision: 1, source: source(SHA.a) },
      shotId: "shot-001-01",
      revision: 1,
      source: source(SHA.a),
    },
    provenance: {
      storyDesignSha256: SHA.b,
      assetsRevision: 12,
      visualProductionSha256: null,
      beatCardHash: "8137791889ad",
      scriptLine: 17,
      mergedScriptLines: [],
    },
    scene: {
      sceneId: "S01", subscene: null, timeOfDay: "night", interior: "ext",
      lightingStateId: "LIGHT_NIGHT", dressingVariantId: "DRESS_A",
    },
    camera: {
      shot_size: "wide", camera_movement: "dolly_out", lens_mm: 35, lighting_key: "natural",
      depth_of_field: "deep", color_temperature: "neutral", cameraId: "CAM_A",
    },
    cast: [],
    props: [],
    crowd: null,
    action: "蒸汽机车穿过城楼门洞。",
    productionTags: ["特效"],
    dialogue: [],
    output: {
      aspectRatio: "9:16", generateAudio: true, durationSeconds: 8,
      storyboardDurationSeconds: 8, fps: 24, seed,
    },
    continuity: {
      stageGroup: "EP001-S1",
      prevShotId: null,
      anchorMode: "keyframes",
      firstFrame: {
        asset: structuredClone(FIRST_FRAME),
        origin: { kind: "operator-upload", note: "首帧由操作者上传" },
        containsRealFace: false,
      },
      lastFrame: null,
      references: [],
      referencePolicy: "trim_by_priority",
      droppedReferences: [],
      spatialPasses: [],
      fingerprint: { modelSha256: SHA.b, workflowSha256: SHA.a, seed, seedReproducible: seed !== null },
    },
    prompt: {
      text,
      negativeText: null,
      language: "zh-CN",
      authoredBy: "episode-writer",
      compiler: "production-shot-request@1",
      selectedTranslation: null,
    },
    compile: { draftSha256: SHA.d, policyDigest: SHA.a, degradations: [] },
  });
}

function dispatchIntent(
  taskId = "take-h3-001",
  overrides: {
    execution?: ProductionIntentExecution;
    inputs?: AssetRef[];
  } = {},
): ReturnType<typeof createProductionDispatchIntent> {
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
    execution: structuredClone(overrides.execution ?? INTENT_EXECUTION),
    inputs: overrides.inputs ?? [structuredClone(FIRST_FRAME)],
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

type ComfyPrompt = { promptId: string; prompt: Record<string, unknown> };
type ComfyServer = {
  port: number;
  prompts: string[];
  submitted: ComfyPrompt[];
  /** prompt_id 在此集合时 `/history/{id}` 返回一个已完成的历史项。 */
  terminal: Set<string>;
  /** prompt_id 在此集合时 `POST /prompt` 以 400 拒绝（provider 侧校验失败）。 */
  rejected: Set<string>;
  /** 大于 0 时把 `/queue` 与 `/history/*` 的响应推迟这么多毫秒（用于制造扫描超时）。 */
  delay: { ms: number };
  close(): Promise<void>;
};

async function startFakeComfy(): Promise<ComfyServer> {
  const prompts: string[] = [];
  const submitted: ComfyPrompt[] = [];
  const terminal = new Set<string>();
  const rejected = new Set<string>();
  const delay = { ms: 0 };
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const json = (value: unknown): void => {
      const body = JSON.stringify(value);
      const send = (): void => {
        outgoing.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
        });
        outgoing.end(body);
      };
      if (delay.ms > 0 && (url.pathname === "/queue" || url.pathname.startsWith("/history/"))) {
        setTimeout(send, delay.ms);
        return;
      }
      send();
    };
    if (incoming.method === "POST" && url.pathname === "/prompt") {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          prompt_id?: string;
          prompt?: Record<string, unknown>;
        };
        if (rejected.has(String(body.prompt_id))) {
          const failure = JSON.stringify({
            error: { type: "prompt_outputs_failed_validation", message: "invalid prompt" },
            node_errors: {},
          });
          outgoing.writeHead(400, {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(Buffer.byteLength(failure)),
          });
          outgoing.end(failure);
          return;
        }
        prompts.push(String(body.prompt_id));
        submitted.push({ promptId: String(body.prompt_id), prompt: body.prompt ?? {} });
        json({ prompt_id: body.prompt_id, number: prompts.length, node_errors: {} });
      });
      return;
    }
    if (incoming.method === "GET" && url.pathname === "/queue") {
      json({ queue_running: [], queue_pending: [] });
      return;
    }
    if (incoming.method === "GET" && url.pathname.startsWith("/history/")) {
      const promptId = url.pathname.slice("/history/".length);
      if (terminal.has(promptId)) {
        json({ [promptId]: { status: { completed: true }, outputs: {} } });
        return;
      }
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
    submitted,
    terminal,
    rejected,
    delay,
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
    && snapshot.casAuthority === "wl-sg" && snapshot.profiles.length === 2,
  "--export-profile-snapshot 导出只读 v1 快照（含契约 v1 与 v2 两档 profile）");
  const snapshotV2 = snapshot.profiles.find((entry) => entry.profileId === PROFILE_ID_V2);
  ok((snapshotV2?.limits as { seed?: string } | undefined)?.seed === "uint32"
    && (snapshot.profiles.find((entry) => entry.profileId === PROFILE_ID)!
      .limits as { seed?: string }).seed === "unsupported",
  "同一 registry 里 v1 / v2 两档并存，seed 能力按各自 graph 契约版本声明");
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
  // 只保留 v1 一档（backend 的 profileIds 随之收窄），用于观察单项字段变化对 digest 的影响。
  const v1OnlyConfig = (profileOverrides: Record<string, unknown>): Record<string, unknown> => {
    const base = registryConfig(snapshotDirs);
    return {
      ...base,
      backends: [{ ...(base.backends as Record<string, unknown>[])[0]!, profileIds: [PROFILE_ID] }],
      executionProfiles: [{
        ...(base.executionProfiles as Record<string, unknown>[])[0]!,
        ...profileOverrides,
      }],
    };
  };
  const driftedSnapshot = exportExecutionProfileSnapshot(
    parseProductionGatewayRuntimeConfig(v1OnlyConfig({ processingRegions: ["CN"] })),
  );
  ok(driftedSnapshot.profiles[0]!.profileDigest !== expectedSnapshot.profiles[0]!.profileDigest,
    "registry 内容变更后快照 digest 随之变化");

  // 多地域 profile：registry 与 worker 两侧共用同一份地域解析（去重、升序、拒绝集合别名），
  // 否则配置里的书写顺序会让两边算出不同的 profileDigest。
  const multiRegionConfig = (regions: readonly string[]): Record<string, unknown> =>
    v1OnlyConfig({ processingRegions: [...regions] });
  const sortedRegions = exportExecutionProfileSnapshot(
    parseProductionGatewayRuntimeConfig(multiRegionConfig(["SG", "US", "JP"])),
  );
  const writtenInAnotherOrder = exportExecutionProfileSnapshot(
    parseProductionGatewayRuntimeConfig(multiRegionConfig(["US", "JP", "SG"])),
  );
  ok(JSON.stringify(sortedRegions.profiles[0]!.processingRegions) === '["JP","SG","US"]'
    && sortedRegions.profiles[0]!.profileDigest === writtenInAnotherOrder.profiles[0]!.profileDigest,
  "多地域 profile 的 processingRegions 去重升序，profileDigest 不随配置书写顺序变化");
  const aliasRegion = ((): string => {
    try {
      parseProductionGatewayRuntimeConfig(multiRegionConfig(["EU"]));
      return "accepted";
    } catch (error) {
      return error instanceof ProductionGatewayRuntimeConfigError ? error.code : "other";
    }
  })();
  ok(aliasRegion === "config-invalid-schema", "集合别名 EU 作为处理地域在 registry 解析期被拒");
  const snapshotLimits = expectedSnapshot.profiles[0]!.limits;
  ok(parseVideoBackendLimits(snapshotLimits, "snapshot.limits").maxInputImageBytes === 16 * 1024 * 1024
    && JSON.stringify(snapshotLimits.durationSeconds.grid)
      === JSON.stringify(expectedSnapshot.profiles[0]!.durationGrid),
  "快照条目的 limits 通过 §4.3 严格读取器，且与 durationGrid 同源");

  // 契约 v2 的 stage profile 形态在 registry 解析期即被钉住（§6.5、§5.3）。
  const stageProfileDrift = (mutate: (profiles: Record<string, unknown>[]) => void): string => {
    const base = registryConfig(snapshotDirs);
    const profiles = structuredClone(base.stageProfiles) as Record<string, unknown>[];
    mutate(profiles);
    try {
      parseProductionGatewayRuntimeConfig({ ...base, stageProfiles: profiles });
      return "accepted";
    } catch (error) {
      return error instanceof ProductionGatewayRuntimeConfigError ? error.code : "other";
    }
  };
  // 去掉 shot-request slot 后 stage profile 自身仍自洽，漂移只有对着 pinned graph 才看得见：
  // 由 readProductionGatewayWorkflow 的模板断言在导出快照时拒绝。
  const missingSlotRoot = root();
  const missingSlotDirs = {
    objectsRoot: join(missingSlotRoot, "objects"),
    ingestRoot: join(missingSlotRoot, "ingest"),
    jobStateRoot: join(missingSlotRoot, "jobs"),
    comfyPort: comfy.port,
  };
  writeRegistry(missingSlotDirs, missingSlotRoot);
  const missingSlotConfig = registryConfig(missingSlotDirs);
  const missingSlotProfiles = structuredClone(missingSlotConfig.stageProfiles) as Record<string, unknown>[];
  missingSlotProfiles[1]!.inputs = (missingSlotProfiles[1]!.inputs as Record<string, unknown>[]).slice(1)
    .map((input, index) => ({ ...input, index }));
  missingSlotProfiles[1]!.bindings = (missingSlotProfiles[1]!.bindings as Record<string, unknown>[]).slice(1)
    .map((binding, index) => ({ ...binding, index }));
  const missingSlotFile = join(missingSlotRoot, "gateway-registry.json");
  writeFileSync(
    missingSlotFile,
    `${JSON.stringify({ ...missingSlotConfig, stageProfiles: missingSlotProfiles }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const missingSlotExit = await productionGatewayMain(
    ["--config", missingSlotFile, "--export-profile-snapshot", join(missingSlotRoot, "snapshot.json")],
    missingSlotRoot,
    { signalSource: null, env: { [BEARER_ENV]: BEARER } },
  );
  ok(missingSlotExit === 1 && !existsSync(join(missingSlotRoot, "snapshot.json")),
    "契约 v2 的 stage profile 去掉 index 0 的 shot-request slot 后，pinned graph 模板断言拒绝");
  ok(stageProfileDrift((profiles) => {
    profiles[0]!.inputs = [
      {
        version: 1,
        index: 0,
        slot: "shot-request",
        mediaTypes: ["application/vnd.writing-loop.shot-request+json"],
      },
      ...(profiles[0]!.inputs as Record<string, unknown>[]).map((input, index) => ({
        ...input, index: index + 1,
      })),
    ];
  }) === "config-invalid-schema",
  "契约 v1 的 stage profile 声明 shot-request slot 时在解析期被拒（bindings 无对应项）");
  ok(stageProfileDrift((profiles) => {
    profiles[1]!.inputs = (profiles[1]!.inputs as Record<string, unknown>[]).map((input, index) =>
      index === 0 ? { ...input, mediaTypes: ["image/png"] } : input);
  }) === "config-invalid-schema",
  "shot-request slot 声明别的 mediaType 时在解析期被拒（与 stage kernel 同一判定）");
  ok(stageProfileDrift((profiles) => {
    profiles[1]!.inputs = (profiles[1]!.inputs as Record<string, unknown>[]).map((input, index) =>
      index === 1
        ? { ...input, mediaTypes: ["application/vnd.writing-loop.shot-request+json"] }
        : input);
  }) === "config-invalid-schema",
  "非 index 0 的 slot 声明 shot-request mediaType 时在解析期被拒");

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
  // §6.4 assets PUT 的图片上限取自 registry 的同一个字段；这里用小值，让超限用例不必造大对象。
  const LIVE_MAX_INPUT_IMAGE_BYTES = 64 * 1024;
  const liveConfigFile = writeRegistry(liveDirs, liveRoot, {
    maxInputImageBytes: LIVE_MAX_INPUT_IMAGE_BYTES,
  });
  // 装配层默认注入系统 ffmpeg 提取器；这里换成 fake，让全进程冒烟不依赖宿主机上的 ffmpeg。
  const derivedFrame = Buffer.concat([PNG, Buffer.from("derived-last-frame")]);
  let extractedFrom: string | null = null;
  let missingFfmpeg = "";
  try {
    await startProductionGatewayProcess({
      configFile: liveConfigFile,
      env: { [BEARER_ENV]: BEARER },
      ffmpegProbe: async () => { throw new Error("spawn ENOENT"); },
    });
  } catch (error) { missingFfmpeg = error instanceof Error ? error.message : String(error); }
  ok(missingFfmpeg.includes("ffmpeg") && missingFfmpeg.includes("§5.3"),
    "宿主机缺可用 ffmpeg 时进程在任何内核持有 durable 状态前拒绝启动，并写明原因");

  let probeCalls = 0;
  const gateway = await startProductionGatewayProcess({
    configFile: liveConfigFile,
    env: { [BEARER_ENV]: BEARER },
    ffmpegProbe: async () => { probeCalls++; return "ffmpeg version test"; },
    lastFrameExtractor: async (input) => {
      extractedFrom = input.videoPath;
      return derivedFrame;
    },
  });
  try {
    const origin = `http://${gateway.server.address.host}:${gateway.server.address.port}`;
    ok(gateway.server.address.host === "127.0.0.1" && gateway.server.address.port > 0
      && probeCalls === 1,
    "进程绑定配置中的字面私网 IP，且装配期只做一次 ffmpeg 探针");

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

    // —— §6.4 输入上传路由：内容寻址的 PUT / HEAD ——
    const assetUrl = (sha256: string): string =>
      `${origin}/v1/scopes/${WS}/${PROJECT}/assets/sha256/${sha256}`;
    const putAsset = async (
      sha256: string,
      body: Uint8Array,
      bearer: string | null = BEARER,
    ): Promise<Response> => await fetch(assetUrl(sha256), {
      method: "PUT",
      redirect: "error",
      headers: {
        "content-type": "application/octet-stream",
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body,
    });
    const headAsset = async (sha256: string, bearer: string | null = BEARER): Promise<Response> =>
      await fetch(assetUrl(sha256), {
        method: "HEAD",
        redirect: "error",
        ...(bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
      });

    const uploadPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("uploaded-operator-keyframe"),
    ]);
    const uploadPngSha = digest(uploadPng);
    ok((await putAsset(uploadPngSha, uploadPng, null)).status === 401
      && (await headAsset(uploadPngSha, null)).status === 401,
    "缺失 Authorization 的 assets PUT / HEAD 被 bearer 层拒为 401");
    ok((await headAsset(uploadPngSha)).status === 404,
      "未上传的对象 HEAD 为 404");

    const wrongDigest = digest(Buffer.from("some other bytes entirely"));
    const mismatched = await putAsset(wrongDigest, uploadPng);
    ok(mismatched.status === 400
      && (await mismatched.json() as { error: string }).error === "bad-request"
      && !existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, wrongDigest))
      && (await headAsset(wrongDigest)).status === 404,
    "上传字节的 sha256 与路径中的 digest 不符时 400，且对象不落盘");

    const firstUpload = await putAsset(uploadPngSha, uploadPng);
    const firstBody = await firstUpload.json() as { sha256: string; byteLength: number; mediaType: string };
    ok(firstUpload.status === 200 && firstBody.sha256 === uploadPngSha
      && firstBody.byteLength === uploadPng.byteLength && firstBody.mediaType === "image/png"
      && existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, uploadPngSha)),
    "内容寻址上传：字节按 digest 入 ingest CAS，媒体类型由字节嗅探判定");
    const replay = await putAsset(uploadPngSha, uploadPng);
    ok(replay.status === 200
      && JSON.stringify(await replay.json()) === JSON.stringify(firstBody),
    "相同字节重放为幂等 200，响应逐字节相同");
    const headAfter = await headAsset(uploadPngSha);
    ok(headAfter.status === 200
      && headAfter.headers.get("content-length") === String(uploadPng.byteLength)
      && headAfter.headers.get("content-type") === "image/png"
      && (await headAfter.text()) === "",
    "上传后 HEAD 为 200 且不返回体");

    const oversize = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(LIVE_MAX_INPUT_IMAGE_BYTES, 0x41),
    ]);
    const oversizeSha = digest(oversize);
    ok((await putAsset(oversizeSha, oversize)).status === 413
      && !existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, oversizeSha)),
    "图片超过 registry 声明的 maxInputImageBytes 时 413，且不落盘");

    const videoSha = digest(MP4);
    ok((await putAsset(videoSha, MP4)).status === 415
      && !existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, videoSha)),
    "视频等非输入类型的上传被 415 拒绝（provider 产物只经 ingest 内核入库）");
    const notShotRequest = Buffer.from("{\"kind\":\"not-a-shot-request\"}", "utf8");
    const notShotRequestSha = digest(notShotRequest);
    ok((await putAsset(notShotRequestSha, notShotRequest)).status === 415
      && !existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, notShotRequestSha)),
    "既嗅探不出媒体类型、又不是 canonical ShotRequest 正本的字节被 415 拒绝，且不落盘");

    // 内容寻址下同名不同字节不可能由本路由产生；仓库被就地改坏时仍然拒绝覆盖。
    const honestPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("honest-content"),
    ]);
    const corruptPng = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("corrupted-store-content"),
    ]);
    const claimedSha = digest(honestPng);
    const corruptPath = productionGatewayBlobPath(liveDirs.ingestRoot, claimedSha);
    mkdirSync(join(corruptPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(corruptPath, corruptPng, { mode: 0o400 });
    const conflicted = await putAsset(claimedSha, honestPng);
    ok(conflicted.status === 409
      && (await conflicted.json() as { error: string }).error === "conflict"
      && readFileSync(corruptPath).equals(corruptPng),
    "同一 digest 下已存在不同字节时以 409 拒绝，绝不覆盖既有对象");
    // 每条失败路径都要把临时文件清干净：残留会随批次累积占满启动盘。
    const ingestTemporary = join(liveDirs.ingestRoot, "tmp");
    ok(!existsSync(ingestTemporary) || readdirSync(ingestTemporary).length === 0,
      "上传的成功与全部失败路径都不在 ingest tmp 目录留残留");

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
    ok(ingested.assets.length === 2 && ingested.assets[0]!.sha256 === digest(MP4)
      && ingested.assets[0]!.uri === `urn:sha256:${digest(MP4)}`
      && ingested.assets[0]!.mediaType === "video/mp4"
      && ingested.assets[1]!.sha256 === digest(derivedFrame)
      && ingested.assets[1]!.mediaType === "image/png"
      && String(extractedFrom).endsWith(digest(MP4)),
    "ingests 路由冒烟：主视频按内容寻址入 CAS，并由装配层的帧提取器登记尾帧为第二个 AssetRef");

    // —— H3 graph 契约 v2 全链路（§5.3、§6.4）：本机 workspace CAS 的 ShotRequest 与首帧
    // → worker stage 时自动上传 → PUT /jobs → fake ComfyUI 收到带逐镜 prompt / seed 的 v2 graph ——
    const workspaceRoot = root();
    mkdirSync(join(workspaceRoot, ".writing-loop", PROJECT), { recursive: true, mode: 0o700 });
    // 首帧走 operator-upload 轨道：正本只在本机，gateway 侧要由 worker 送过去。
    writeProductionCasObject(workspaceRoot, PROJECT, PNG);
    const uploadingStager = new HttpProductionInputStager({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
      localAssetSource: new WorkspaceCasLocalAssetSource({
        root: workspaceRoot,
        project: PROJECT,
        casAuthority: "wl-sg",
      }),
    });
    const stageShotRequest = (shotRequest: ShotRequest): AssetRef => {
      const bytes = Buffer.from(shotRequestCanonicalJson(shotRequest), "utf8");
      const written = writeProductionCasObject(workspaceRoot, PROJECT, bytes);
      return {
        version: 1,
        uri: `cas://wl-sg/sha256/${written.sha256}`,
        sha256: written.sha256,
        byteLength: bytes.byteLength,
        mediaType: SHOT_REQUEST_MEDIA_TYPE,
      };
    };
    const generatorNode = String((H3_CONTRACT_V2.generator as { nodeId: string }).nodeId);
    const noiseNode = String(
      ((H3_CONTRACT_V2.pipeline as Record<string, { nodeId: string }>).noise).nodeId,
    );
    const v2Adapter = new ProductionGatewayAdapter({
      baseUrl: origin,
      workspaceId: WS,
      project: PROJECT,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID_V2,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });

    const v2ShotRequest = shotRequestFor(4_242);
    const v2ShotAsset = stageShotRequest(v2ShotRequest);
    const v2Intent = dispatchIntent("take-h3-v2", {
      execution: structuredClone(INTENT_EXECUTION_V2),
      inputs: [v2ShotAsset, structuredClone(FIRST_FRAME)],
    });
    ok(!existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, v2ShotAsset.sha256))
      && existsSync(productionCasObjectPath(workspaceRoot, PROJECT, v2ShotAsset.sha256)),
    "stage 之前：ShotRequest 正本只在本机 workspace CAS，GPU VM 的 ingest CAS 还没有它");
    const v2Staged = await uploadingStager.stage(v2Intent);
    ok(v2Staged.bindings.map((binding) => binding.slot).join(",") === "shot-request,first_frame"
      && v2Staged.shotRequest?.prompt === v2ShotRequest.prompt.text
      && v2Staged.shotRequest.seed === 4_242
      && existsSync(productionGatewayBlobPath(liveDirs.ingestRoot, v2ShotAsset.sha256)),
    "契约 v2 stage：worker 先把缺失的 cas:// 输入上传到 gateway，回执 index 0 是 shot-request slot 并携带逐镜 prompt 与 seed");
    ok((await headAsset(v2ShotAsset.sha256)).status === 200
      && (await headAsset(FIRST_FRAME.sha256)).status === 200,
    "上传后两个输入对象在 assets 路由上都可见（HEAD 200）");
    const v2Materialized = materializeProductionH3Workflow(
      templateWorkflowV2,
      H3_CONTRACT_V2 as never,
      INTENT_EXECUTION_V2,
      STAGE_BINDINGS_V2 as never,
      v2Staged.bindings.map((binding) => ({
        index: binding.index,
        slot: binding.slot,
        assetSha256: binding.assetSha256,
        providerObjectKey: binding.providerObjectKey,
      })),
      PROFILE_ID_V2,
      { prompt: v2ShotRequest.prompt.text, seed: 4_242 },
    );
    const V2_REMOTE_ID = "22222222-2222-4222-8222-222222222222";
    const v2Submitted = await v2Adapter.submitPrepared(v2Adapter.prepareSubmission({
      idempotencyKey: v2Intent.idempotencyKey,
      remoteJobId: V2_REMOTE_ID,
      workflow: v2Materialized.workflow,
      inputBinding: {
        version: 1,
        stageKey: v2Staged.stageKey,
        bindingsDigest: v2Staged.bindingsDigest,
        intentDigest: v2Intent.idempotencyKey,
      },
    }));
    const v2Prompt = comfy.submitted.find((entry) => entry.promptId === V2_REMOTE_ID);
    const v2Generator = (v2Prompt?.prompt[generatorNode] as { inputs: Record<string, unknown> } | undefined)?.inputs;
    const v2Noise = (v2Prompt?.prompt[noiseNode] as { inputs: Record<string, unknown> } | undefined)?.inputs;
    ok(v2Submitted.remoteJobId === V2_REMOTE_ID
      && v2Generator?.prompt === v2ShotRequest.prompt.text
      && v2Noise?.noise_seed === 4_242,
    "契约 v2 提交给 ComfyUI 的 prompt body 里 generator.prompt 与 RandomNoise.noise_seed 是 ShotRequest 的值");

    // seed 为 null 时 pinned graph 的 noise_seed 无法材料化：gateway 在提交前 403。
    const nullSeedShotRequest = shotRequestFor(null, "无 seed 的镜头提示词");
    const nullSeedAsset = stageShotRequest(nullSeedShotRequest);
    const nullSeedIntent = dispatchIntent("take-h3-v2-null-seed", {
      execution: structuredClone(INTENT_EXECUTION_V2),
      inputs: [nullSeedAsset, structuredClone(FIRST_FRAME)],
    });
    const nullSeedStaged = await uploadingStager.stage(nullSeedIntent);
    const NULL_SEED_REMOTE_ID = "33333333-3333-4333-8333-333333333333";
    const nullSeedBody = {
      version: 1 as const,
      scope: { version: 1 as const, workspaceId: WS, project: PROJECT },
      backendInstanceId: BACKEND,
      remoteJobId: NULL_SEED_REMOTE_ID,
      idempotencyKey: nullSeedIntent.idempotencyKey,
      profile: { version: 1 as const, profileId: PROFILE_ID_V2, workflowDigest: SHA.a },
      inputBinding: {
        version: 1 as const,
        stageKey: nullSeedStaged.stageKey,
        bindingsDigest: nullSeedStaged.bindingsDigest,
        intentDigest: nullSeedIntent.idempotencyKey,
      },
    };
    const nullSeedResponse = await fetch(
      `${origin}/v1/scopes/${WS}/${PROJECT}/jobs/${NULL_SEED_REMOTE_ID}`,
      {
        method: "PUT",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BEARER}`,
          "x-writing-loop-idempotency-key": nullSeedIntent.idempotencyKey,
          "x-writing-loop-request-digest": productionJobPutRequestDigest(nullSeedBody),
        },
        body: JSON.stringify(nullSeedBody),
      },
    );
    ok(nullSeedStaged.shotRequest?.seed === null && nullSeedResponse.status === 403
      && !comfy.prompts.includes(NULL_SEED_REMOTE_ID),
    "契约 v2 的 ShotRequest seed 为 null 时 gateway 以 403 拒绝，且未向 ComfyUI 提交");

    // —— §7 扫描的两条负面前提：已终态、以及从未提交（not-submitted） ——
    const submitOnV1 = async (taskId: string, remoteJobId: string): Promise<Response | null> => {
      const jobIntent = dispatchIntent(taskId);
      const jobStaged = await stager.stage(jobIntent);
      const bound = materializeProductionH3Workflow(
        templateWorkflow,
        H3_CONTRACT as never,
        INTENT_EXECUTION,
        STAGE_BINDINGS as never,
        jobStaged.bindings.map((binding) => ({
          index: binding.index,
          slot: binding.slot,
          assetSha256: binding.assetSha256,
          providerObjectKey: binding.providerObjectKey,
        })),
        PROFILE_ID,
      );
      const putBody = {
        version: 1 as const,
        scope: { version: 1 as const, workspaceId: WS, project: PROJECT },
        backendInstanceId: BACKEND,
        remoteJobId,
        idempotencyKey: jobIntent.idempotencyKey,
        profile: {
          version: 1 as const,
          profileId: PROFILE_ID,
          workflowDigest: productionJobWorkflowDigest(bound.workflow),
        },
        inputBinding: {
          version: 1 as const,
          stageKey: jobStaged.stageKey,
          bindingsDigest: jobStaged.bindingsDigest,
          intentDigest: jobIntent.idempotencyKey,
        },
      };
      return await fetch(`${origin}/v1/scopes/${WS}/${PROJECT}/jobs/${remoteJobId}`, {
        method: "PUT",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BEARER}`,
          "x-writing-loop-idempotency-key": jobIntent.idempotencyKey,
          "x-writing-loop-request-digest": productionJobPutRequestDigest(putBody),
        },
        body: JSON.stringify(putBody),
      });
    };

    // 两个 ID 提到外层常量，重启段（try 之外）也要用。
    const terminalPut = await submitOnV1("take-h3-terminal", TERMINAL_REMOTE_ID);
    comfy.terminal.add(TERMINAL_REMOTE_ID);
    const terminalObserved = await adapter.inspect(TERMINAL_REMOTE_ID);
    ok(terminalPut?.status === 200 && terminalObserved.state === "succeeded",
      "已提交的 job 观察到 succeeded 后 gateway durable 记下终态");

    comfy.rejected.add(REJECTED_REMOTE_ID);
    const rejectedPut = await submitOnV1("take-h3-rejected", REJECTED_REMOTE_ID);
    ok(rejectedPut?.status === 422 && !comfy.prompts.includes(REJECTED_REMOTE_ID),
      "provider 校验失败的提交以 not-submitted 结清，job record 保留");

    // capabilities：jobs kernel 转发 raw adapter 的真实描述符（§4.3、§8.6）。
    const capabilities = await adapter.capabilities();
    const profileLimits = capabilities.limitsByModelId[PROFILE_ID];
    ok(capabilities.backendInstanceId === BACKEND
      && capabilities.modelFamilies.includes("minimax-h3")
      && capabilities.processingRegions.join(",") === "SG"
      && capabilities.providerJobIdMapping === "none"
      && profileLimits?.maxInputImageBytes === LIVE_MAX_INPUT_IMAGE_BYTES
      && profileLimits.aspectRatios.join(",") === "9:16"
      && profileLimits.resolutions.join(",") === "768p",
    "capabilities 路由转发 registry 推导出的真实 capability，而不是自造字面量");
    const derivedProfiles = productionGatewayH3Profiles(gateway.config);
    ok(profileLimits?.seed === "unsupported"
      && derivedProfiles[0]?.graphContractVersion
        === gateway.config.executionProfiles[0]!.h3GraphContract.version,
    "capability 的 graphContractVersion 取自 registry 的 h3GraphContract.version：v1 声明 seed 不受支持");
    const liveSnapshot = exportExecutionProfileSnapshot(gateway.config);
    ok(JSON.stringify(liveSnapshot.profiles[0]!.durationGrid)
      === JSON.stringify(profileLimits?.durationSeconds.grid)
      && JSON.stringify(liveSnapshot.profiles[0]!.limits) === JSON.stringify(profileLimits),
    "只读快照的 durationGrid 与 capabilities().limitsByModelId[profileId].durationSeconds.grid 同源相等");
    ok(gateway.recovery.scanned === 0 && gateway.recovery.rewritten === 0
      && gateway.recovery.unresolved === 0,
    "空 jobStateRoot 上的抢占扫描不改写任何记录");
  } finally {
    await gateway.close();
  }

  const closedProbe = await fetch(
    `http://127.0.0.1:${gateway.server.address.port}/v1/scopes/${WS}/${PROJECT}/jobs/${REMOTE_ID}`,
    { headers: { authorization: `Bearer ${BEARER}` }, redirect: "error" },
  ).then(() => "reachable", () => "closed");
  ok(closedProbe === "closed", "优雅停机后端口不再接受连接");

  // 慢响应：单 job 截止时间到不是整体失败，而是该 job 无判定（unresolved）并留待下次重启。
  comfy.delay.ms = 400;
  const slowSweep = await startProductionGatewayProcess({
    configFile: liveConfigFile,
    env: { [BEARER_ENV]: BEARER },
    ffmpegProbe: async () => "ffmpeg version test",
    jobTimeoutMs: 60,
  });
  try {
    ok(slowSweep.recovery.rewritten === 0 && slowSweep.recovery.unresolved === 2
      && slowSweep.server.address.port > 0,
    "扫描时 provider 响应超过单 job 截止时间：进程照常启动，该 job 计 unresolved 且不被改写");
  } finally {
    await slowSweep.close();
  }
  comfy.delay.ms = 0;

  // ── §7 Spot 抢占：同一 jobStateRoot 重新装配，ComfyUI 的进程内 history 已清空 ──
  const restarted = await startProductionGatewayProcess({
    configFile: liveConfigFile,
    env: { [BEARER_ENV]: BEARER },
    ffmpegProbe: async () => "ffmpeg version test",
  });
  try {
    ok(restarted.recovery.rewritten === 2 && restarted.recovery.unresolved === 0
      && restarted.recovery.scanned === 4,
    "重启后只把重启前 pending / running 且不在 /history 与 /queue 的两条 job 改写为抢占失败");
    const restartedAdapter = new ProductionGatewayAdapter({
      baseUrl: `http://${restarted.server.address.host}:${restarted.server.address.port}`,
      workspaceId: WS,
      project: PROJECT,
      backendInstanceId: BACKEND,
      profileId: PROFILE_ID,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });
    const afterPreemption = await restartedAdapter.inspect(REMOTE_ID);
    ok(afterPreemption.state === "failed"
      && afterPreemption.errorSummary === "provider_failed:preempted"
      && afterPreemption.outputs.length === 0,
    "worker 侧 inspect 读到 provider_failed:preempted，而不是无休止的 not-found");
    const afterTerminal = await restartedAdapter.inspect(TERMINAL_REMOTE_ID);
    ok(afterTerminal.state === "succeeded" && afterTerminal.errorSummary === null,
      "已记下终态的 job 在 ComfyUI history 清空后仍答 succeeded，不被改写为抢占失败");
    const afterRejected = await restartedAdapter.inspect(REJECTED_REMOTE_ID);
    ok(afterRejected.state === "not-found" && afterRejected.errorSummary === null,
      "从未提交（not-submitted）的 job 不被改写为抢占失败");

    // 重放 PUT：coordinator 重发同一请求时，响应里的 observation 也走抢占判定，而不是再问 provider。
    const restartedOrigin = `http://${restarted.server.address.host}:${restarted.server.address.port}`;
    const replayStager = new HttpProductionInputStager({
      baseUrl: restartedOrigin,
      workspaceId: WS,
      project: PROJECT,
      transport: "insecure-private-http",
      credentialResolver: () => BEARER,
    });
    const replayIntent = dispatchIntent();
    const replayStaged = await replayStager.stage(replayIntent);
    const replayBound = materializeProductionH3Workflow(
      templateWorkflow,
      H3_CONTRACT as never,
      INTENT_EXECUTION,
      STAGE_BINDINGS as never,
      replayStaged.bindings.map((binding) => ({
        index: binding.index,
        slot: binding.slot,
        assetSha256: binding.assetSha256,
        providerObjectKey: binding.providerObjectKey,
      })),
      PROFILE_ID,
    );
    const replayBody = {
      version: 1 as const,
      scope: { version: 1 as const, workspaceId: WS, project: PROJECT },
      backendInstanceId: BACKEND,
      remoteJobId: REMOTE_ID,
      idempotencyKey: replayIntent.idempotencyKey,
      profile: {
        version: 1 as const,
        profileId: PROFILE_ID,
        workflowDigest: productionJobWorkflowDigest(replayBound.workflow),
      },
      inputBinding: {
        version: 1 as const,
        stageKey: replayStaged.stageKey,
        bindingsDigest: replayStaged.bindingsDigest,
        intentDigest: replayIntent.idempotencyKey,
      },
    };
    const replayResponse = await fetch(`${restartedOrigin}/v1/scopes/${WS}/${PROJECT}/jobs/${REMOTE_ID}`, {
      method: "PUT",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
        "x-writing-loop-idempotency-key": replayIntent.idempotencyKey,
        "x-writing-loop-request-digest": productionJobPutRequestDigest(replayBody),
      },
      body: JSON.stringify(replayBody),
    });
    const replayed = await replayResponse.json() as {
      submissionState: string;
      observation: { state: string; errorSummary: string | null } | null;
    };
    ok(replayResponse.status === 200 && replayed.submissionState === "accepted"
      && replayed.observation?.state === "failed"
      && replayed.observation.errorSummary === "provider_failed:preempted"
      && comfy.prompts.filter((id) => id === REMOTE_ID).length === 1,
    "重放同一 PUT 时响应里的 observation 也读抢占记录，且不重复向 ComfyUI 提交");
    const secondSweep = await startProductionGatewayProcess({
      configFile: liveConfigFile,
      env: { [BEARER_ENV]: BEARER },
      ffmpegProbe: async () => "ffmpeg version test",
    });
    try {
      ok(secondSweep.recovery.rewritten === 0,
        "已改写过的 job record 在下一次重启时不再重复改写");
    } finally {
      await secondSweep.close();
    }
  } finally {
    await restarted.close();
  }
} finally {
  await comfy.close();
  for (const path of roots) rmSync(path, { recursive: true, force: true });
}

if (fails) {
  console.error(`\n${fails} production gateway main assertion(s) failed`);
  process.exit(1);
}
console.log("\nPRODUCTION_GATEWAY_MAIN_OK");
