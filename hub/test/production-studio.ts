// Studio production surface: scoped, read-only, escaped and independent from remote backends.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductionCoordinatorReadModel } from "../src/production-coordinator-read-model.ts";
import type { ProductionReadModel } from "../src/production-read-model.ts";
import { ProductionStore } from "../src/production-store.ts";
import { closeStudioServer, createStudioServer, type StudioWorkspaceEntry } from "../src/studio.ts";

const IDS = {
  alpha: `ws_${"a".repeat(32)}`,
  beta: `ws_${"b".repeat(32)}`,
} as const;

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

type OpenStream = {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  controller: AbortController;
};

async function openStream(url: string, lastEventId?: string): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: lastEventId ? { "last-event-id": lastEventId } : undefined,
    signal: controller.signal,
  });
  return { response, reader: response.body?.getReader() ?? null, controller };
}

async function readFrame(stream: OpenStream, timeoutMs = 2_500): Promise<string> {
  if (!stream.reader) return "";
  let body = "";
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => stream.controller.abort(), timeoutMs);
  try {
    while (!body.includes("\n\n")) {
      const chunk = await stream.reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function closeStream(stream: OpenStream | null): Promise<void> {
  if (!stream) return;
  try { await stream.reader?.cancel(); } catch { /* already closed */ }
  stream.controller.abort();
}

const eventId = (frame: string): string => /^id: ([^\r\n]+)$/m.exec(frame)?.[1] ?? "";

function fixture(parent: string, name: string, title: string, workspaceId: string, enabled: boolean): string {
  const root = join(parent, name);
  const data = join(root, ".writing-loop");
  const projectData = join(data, "demo");
  const repo = join(root, "repo");
  mkdirSync(join(projectData, "board", "tickets"), { recursive: true });
  mkdirSync(join(projectData, "reports"), { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "evaluation"), { recursive: true });
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: workspaceId }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title, repoPath: "repo", enabled, totalEpisodes: 6 } },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "bible", "north-star.md"), `## 一句话故事\n${title} 的故事。\n`);
  writeFileSync(join(repo, "episodes", "ep-001.md"), "# 第一集\n");
  return realpathSync(root);
}

const emptyCounts = (): ProductionReadModel["summary"]["byStatus"] => ({
  planned: 0,
  "dispatch-pending": 0,
  submitting: 0,
  submitted: 0,
  running: 0,
  ingesting: 0,
  "qc-pending": 0,
  approved: 0,
  rejected: 0,
  "submission-unknown": 0,
  failed: 0,
  "cancel-requested": 0,
  cancelled: 0,
  orphaned: 0,
});

function model(workspaceId: string, marker: string, revision: number): ProductionReadModel {
  const tasks: ProductionReadModel["tasks"] = Array.from({ length: 25 }, (_, index) => ({
    id: index === 0 ? `take-<script>${marker}</script>` : index === 24 ? `HIDDEN_${marker}` : `take-${index}`,
    idempotencyKey: `idem-${marker}-${index}`,
    kind: "shot" as const,
    episodeId: "ep-001",
    shotId: index === 0 ? `shot-\"><img src=x onerror=${marker}>` : `shot-${index}`,
    subjectRevision: 3,
    status: index === 0 ? "submission-unknown" as const : "planned" as const,
    revision: 4,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:01:00.000Z",
    backendInstanceId: index === 0 ? `<svg onload=${marker}>` : null,
    remoteJobId: index === 0 ? `remote-${marker}` : null,
    submissionState: index === 0 ? "unknown" as const : null,
    cancellationRequest: index === 0 ? {
      version: 1 as const,
      requestedFrom: "submitting" as const,
      requestedAt: "2026-08-10T12:00:30.000Z",
      reason: `operator <cancel-${marker}>`,
    } : null,
    cancellationConfirmation: null,
    assetCount: 0,
    cost: index === 0
      ? { version: 1, state: "known" as const, currency: "USD" as const, amountMicros: 2_500_000, basis: "estimated" as const }
      : { version: 1, state: "unknown" as const, reason: "provider-not-reported" as const },
    approval: null,
    statusMessage: index === 0 ? `<img src=x onerror=alert('${marker}')>` : null,
  }));
  const byStatus = emptyCounts();
  byStatus["submission-unknown"] = 1;
  byStatus.planned = 24;
  return {
    version: 1,
    workspaceId,
    project: "demo",
    revision,
    updatedAt: "2026-08-10T12:01:00.000Z",
    summary: {
      total: tasks.length,
      active: 1,
      terminal: 0,
      needsAttention: 1,
      byStatus,
      cost: {
        currency: "USD",
        estimatedAmountMicros: 2_500_000,
        estimatedTasks: 1,
        actual: {
          state: "unknown",
          amountMicros: null,
          knownAmountMicros: 0,
          unknownTasks: tasks.length,
          reason: "partial-or-unreported",
        },
      },
    },
    tasks,
  };
}

function controlModel(workspaceId: string, revision: number, exposureMicros = 4_000_000): ProductionCoordinatorReadModel {
  return {
    version: 1,
    workspaceId,
    project: "demo",
    revision,
    updatedAt: "2026-08-10T12:01:01.000Z",
    summary: {
      tracked: 1,
      pendingEvents: 1,
      tasksWithRetryHistory: 1,
      cancellationAttempts: 0,
      lastObservedNotFound: 1,
      budget: { reservedAmountMicros: 0, exposedAmountMicros: exposureMicros },
    },
    tasks: [{
      version: 1,
      taskId: "take-control-001",
      observedTaskRevision: 4,
      budget: {
        state: exposureMicros > 0 ? "exposed" : "released",
        reservedAmountMicros: 4_000_000,
        reservedAt: "2026-08-10T12:00:00.000Z",
        exposedAt: "2026-08-10T12:00:01.000Z",
        releasedAt: exposureMicros > 0 ? null : "2026-08-10T12:01:01.000Z",
      },
      retry: { attempt: 1, notBefore: "2026-08-10T12:02:00.000Z", operation: "inspect", code: "remote-unavailable" },
      cancelAttempt: "none",
      remote: { state: "not-found", observedAt: "2026-08-10T12:01:00.000Z" },
      pendingEvent: "submission-confirmed",
    }],
  };
}

const parent = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-studio-")));
const alpha = fixture(parent, "alpha", "甲室项目", IDS.alpha, true);
const beta = fixture(parent, "beta", "乙室暂停项目", IDS.beta, false);
const catalog: StudioWorkspaceEntry[] = [
  { id: IDS.alpha, label: "甲室", root: alpha },
  { id: IDS.beta, label: "乙室", root: beta },
];
const calls: Array<{ root: string; workspaceId: string; project: string }> = [];
const controlCalls: Array<{ root: string; workspaceId: string; project: string }> = [];
const productionRevisions: Record<string, number> = { [IDS.alpha]: 7, [IDS.beta]: 7 };
const controlRevisions: Record<string, number> = { [IDS.alpha]: 3, [IDS.beta]: 3 };
let controlExposureMicros = 4_000_000;
const productionProvider = (root: string, workspaceId: string, project: string): ProductionReadModel => {
  calls.push({ root, workspaceId, project });
  return model(workspaceId, workspaceId === IDS.alpha ? "ALPHA_XSS" : "BETA_XSS", productionRevisions[workspaceId] ?? 0);
};
const productionControlProvider = (root: string, workspaceId: string, project: string): ProductionCoordinatorReadModel => {
  controlCalls.push({ root, workspaceId, project });
  return controlModel(workspaceId, controlRevisions[workspaceId] ?? 0, controlExposureMicros);
};

const server = createStudioServer({
  root: alpha,
  defaultWorkspaceId: IDS.alpha,
  workspaceProvider: () => catalog,
  productionProvider,
  productionControlProvider,
  pollMs: 250,
});
let alphaStream: OpenStream | null = null;
let betaStream: OpenStream | null = null;

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const alphaUrl = `${base}/w/${IDS.alpha}/api/projects/demo/production`;
  const betaUrl = `${base}/w/${IDS.beta}/api/projects/demo/production`;
  const alphaControlUrl = `${base}/w/${IDS.alpha}/api/projects/demo/production-control`;

  const alphaResponse = await fetch(alphaUrl);
  const alphaBody = await alphaResponse.json() as ProductionReadModel;
  const betaResponse = await fetch(betaUrl);
  const betaBody = await betaResponse.json() as ProductionReadModel;
  ok(alphaResponse.status === 200 && alphaBody.workspaceId === IDS.alpha && alphaBody.project === "demo"
    && betaResponse.status === 200 && betaBody.workspaceId === IDS.beta,
  "同名项目的 production API 严格使用 /w/:workspace-id scope，暂停项目仍可读");
  ok(calls.some((call) => call.root === alpha && call.workspaceId === IDS.alpha && call.project === "demo")
    && calls.some((call) => call.root === beta && call.workspaceId === IDS.beta && call.project === "demo"),
  "Studio 只把 canonical root + workspaceId + project 交给本地 provider");
  const alphaControlResponse = await fetch(alphaControlUrl);
  const alphaControlBody = await alphaControlResponse.json() as ProductionCoordinatorReadModel;
  ok(alphaControlResponse.status === 200 && alphaControlBody.workspaceId === IDS.alpha
    && alphaControlBody.summary.budget.exposedAmountMicros === 4_000_000
    && controlCalls.some((call) => call.root === alpha && call.workspaceId === IDS.alpha && call.project === "demo"),
  "production-control API 只返回同 scope 的本地 crash-recovery read model");

  const head = await fetch(alphaUrl, { method: "HEAD" });
  ok(head.status === 200 && (await head.text()) === "" && Number(head.headers.get("content-length")) > 0,
    "production API 的 HEAD 保留 GET 元数据且无 body");
  const wrongMethod = await fetch(alphaUrl, { method: "POST", headers: { origin: base } });
  ok(wrongMethod.status === 405 && wrongMethod.headers.get("allow") === "GET, HEAD",
  "production API 是严格只读面，写 method 返回 405");
  const wrongControlMethod = await fetch(alphaControlUrl, { method: "POST", headers: { origin: base } });
  ok(wrongControlMethod.status === 405 && wrongControlMethod.headers.get("allow") === "GET, HEAD",
    "production-control API 同样是严格只读面");
  ok((await fetch(`${base}/w/${IDS.alpha}/api/projects/ghost/production`)).status === 404,
    "未知项目在调用 production provider 前返回 404");

  const pageResponse = await fetch(`${base}/w/${IDS.alpha}/p/demo`);
  const page = await pageResponse.text();
  ok(pageResponse.status === 200 && page.includes("制片流水线") && page.includes("提交结果未知")
    && page.includes("仅显示最近 24 / 25 个 take") && !page.includes("HIDDEN_ALPHA_XSS")
    && page.includes("估算 $2.50 · 实际未知") && page.includes("实际 / 估算成本")
    && page.includes("取消未终止制作") && page.includes("operator &lt;cancel-ALPHA_XSS&gt;")
    && page.includes("CONTROL r3") && page.includes("1 待落账 · 1 有重试历史 · 1 末次观察缺失")
    && page.includes("潜在计费敞口 $4.00"),
  "项目页呈现面向短剧的有界制片流水线，而非无界渲染完整账本");
  ok(!page.includes("<script>ALPHA_XSS</script>") && !page.includes("<svg onload=ALPHA_XSS>")
    && !page.includes("<img src=x onerror=alert('ALPHA_XSS')>")
    && page.includes("&lt;script&gt;ALPHA_XSS&lt;/script&gt;"),
  "远端 ID、错误和镜头文本在 HTML 中统一 escaping");
  controlExposureMicros = 0;
  const releasedPage = await (await fetch(`${base}/w/${IDS.alpha}/p/demo`)).text();
  ok(releasedPage.includes("当前无未结计费敞口")
    && !releasedPage.includes("潜在计费敞口 $0.00"),
  "全部 reservation released 后 Studio 使用中性零敞口语义，不渲染红色 $0.00 风险");
  ok(pageResponse.headers.get("content-security-policy")?.includes("connect-src 'self'") === true
    && pageResponse.headers.get("cache-control") === "no-store",
  "production 面保持 Studio CSP/self-only 与 no-store 安全头");

  alphaStream = await openStream(`${base}/w/${IDS.alpha}/api/stream`);
  const alphaInitialCursor = eventId(await readFrame(alphaStream));
  betaStream = await openStream(`${base}/w/${IDS.beta}/api/stream`);
  const betaInitialCursor = eventId(await readFrame(betaStream));
  await closeStream(betaStream);
  betaStream = null;
  ok(alphaStream.response.status === 200 && alphaInitialCursor.startsWith(`wlsse1_${IDS.alpha}_`)
    && betaInitialCursor.startsWith(`wlsse1_${IDS.beta}_`)
    && calls.some((call) => call.workspaceId === IDS.alpha),
    "SSE cursor 只读取同步本地 production revision，不要求浏览器或 poller 访问远端服务");

  productionRevisions[IDS.alpha]++;
  const productionCursor = eventId(await readFrame(alphaStream, 3_000));
  ok(productionCursor.startsWith(`wlsse1_${IDS.alpha}_`) && productionCursor !== alphaInitialCursor,
    "alpha production revision 推进会发送新的 scoped SSE frame");

  betaStream = await openStream(`${base}/w/${IDS.beta}/api/stream`, betaInitialCursor);
  const betaCurrent = await readFrame(betaStream);
  ok(betaCurrent.includes("cursor-current") && !betaCurrent.includes("data:"),
    "alpha production revision 不会推进 beta workspace cursor");
  await closeStream(betaStream);
  betaStream = null;

  controlRevisions[IDS.alpha]++;
  const controlCursor = eventId(await readFrame(alphaStream, 3_000));
  ok(controlCursor.startsWith(`wlsse1_${IDS.alpha}_`) && controlCursor !== productionCursor,
    "alpha production-control revision 推进也会发送新的 scoped SSE frame");
  betaStream = await openStream(`${base}/w/${IDS.beta}/api/stream`, betaInitialCursor);
  const betaAfterControl = await readFrame(betaStream);
  ok(betaAfterControl.includes("cursor-current") && !betaAfterControl.includes("data:"),
    "alpha production-control revision 同样不会推进 beta workspace cursor");
  await closeStream(betaStream);
  betaStream = null;
} finally {
  await closeStream(alphaStream);
  await closeStream(betaStream);
  await closeStudioServer(server);
}

const badServer = createStudioServer({
  root: alpha,
  defaultWorkspaceId: IDS.alpha,
  productionProvider: (_root, _workspaceId, project) => model(IDS.beta, "WRONG_SCOPE", 1) satisfies ProductionReadModel & { project: typeof project },
});
try {
  await new Promise<void>((resolve, reject) => {
    badServer.once("error", reject);
    badServer.listen(0, "127.0.0.1", resolve);
  });
  const address = badServer.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/demo/production`);
  ok(response.status === 409, "Studio 拒绝 provider 返回的跨 workspace/project read model");
} finally {
  await closeStudioServer(badServer);
}

// Root-only embedding is the legacy single-workspace API. Once production state is non-empty it
// must derive the same durable workspace ID as the store; a synthetic all-zero ID would turn this
// valid ledger into a false cross-scope corruption error.
new ProductionStore(alpha, IDS.alpha, "demo").create({
  version: 1,
  id: "take-root-only-001",
  idempotencyKey: "idem-root-only-001",
  subject: {
    version: 1,
    kind: "episode",
    episode: {
      version: 1,
      episodeId: "ep-001",
      revision: 1,
      source: {
        version: 1,
        uri: "s3://writing-loop-assets/demo/episode-001.md",
        sha256: "a".repeat(64),
        byteLength: 12,
        mediaType: "text/markdown",
      },
    },
  },
  createdAt: "2026-08-10T12:02:00.000Z",
});
const rootOnlyServer = createStudioServer({ root: alpha });
try {
  await new Promise<void>((resolve, reject) => {
    rootOnlyServer.once("error", reject);
    rootOnlyServer.listen(0, "127.0.0.1", resolve);
  });
  const address = rootOnlyServer.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/demo/production`);
  const body = await response.json() as ProductionReadModel;
  ok(response.status === 200 && body.workspaceId === IDS.alpha && body.tasks[0]?.id === "take-root-only-001",
    "createStudioServer({root}) 从 durable workspace identity 读取非空 production ledger");
} finally {
  await closeStudioServer(rootOnlyServer);
  rmSync(parent, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_STUDIO_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
