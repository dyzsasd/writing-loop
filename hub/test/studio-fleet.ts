// Multi-workspace Studio regression: explicit workspace namespaces must isolate projects that
// share the same key, and SSE cursors must survive a process restart without leaking scopes.
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStudioServer, createStudioServer, type StudioWorkspaceEntry } from "../src/studio.ts";

const IDS = {
  alpha: `ws_${"a".repeat(32)}`,
  beta: `ws_${"b".repeat(32)}`,
  corrupt: `ws_${"c".repeat(32)}`,
  corruptActual: `ws_${"d".repeat(32)}`,
} as const;

let failures = 0;
const ok = (condition: boolean, message: string): void => {
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures++;
};

type Fixture = { root: string; ticket: string; config: string };

function fixture(parent: string, name: string, title: string, marker: string, identityId: string): Fixture {
  const root = join(parent, name);
  const data = join(root, ".writing-loop");
  const projectData = join(data, "demo");
  const tickets = join(projectData, "board", "tickets");
  const repo = join(root, "repo");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  const config = join(data, "config.json");
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: identityId }, null, 2) + "\n");
  writeFileSync(config, JSON.stringify({
    version: 1,
    projects: { demo: { title, repoPath: "repo", enabled: true, totalEpisodes: 6 } },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "bible", "north-star.md"), `## 一句话故事\n${marker} 的故事脊柱。\n`);
  writeFileSync(join(repo, "bible", "characters.md"), `# ${marker} 人物\n`);
  writeFileSync(join(repo, "bible", "world.md"), `# ${marker} 世界\n`);
  writeFileSync(join(repo, "outline.md"), `# ${marker} 总大纲\n`);
  writeFileSync(join(repo, "episodes", "ep-001.md"), `# ${marker} 第一集\n`);
  const ticket = join(tickets, "WL-1.md");
  writeFileSync(ticket, `---
id: WL-1
title: ${marker} 决策
type: Feature
state: In Review
owner: showrunner
labels: [writing-loop, needs-showrunner]
priority: 1
created: 2026-08-10T08:00:00.000Z
updated: 2026-08-10T09:00:00.000Z
---
Episode: 1
## Context
${marker} 私有内容。
---
## Comments
### 2026-08-10T09:30:00.000Z — writer
${marker} 初稿完成。
### 2026-08-10T10:00:00.000Z — operator
${marker} 需要加强结尾。
`);
  return { root: realpathSync(root), ticket, config };
}

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
  let text = "";
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => stream.controller.abort(), timeoutMs);
  try {
    while (!text.includes("\n\n")) {
      const chunk = await stream.reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function closeStream(stream: OpenStream | null): Promise<void> {
  if (!stream) return;
  try { await stream.reader?.cancel(); } catch { /* already closed */ }
  stream.controller.abort();
}

function eventId(frame: string): string {
  return /^id: ([^\r\n]+)$/m.exec(frame)?.[1] ?? "";
}

const parent = realpathSync(mkdtempSync(join(tmpdir(), "wl-studio-fleet-")));
const alpha = fixture(parent, "alpha", "甲室同名项目", "ALPHA_ONLY", IDS.alpha);
const beta = fixture(parent, "beta", "乙室同名项目", "BETA_ONLY", IDS.beta);
const corrupt = fixture(parent, "corrupt-pointer", "绝不能被路由", "CORRUPT_ONLY", IDS.corruptActual);
const catalog: StudioWorkspaceEntry[] = [
  { id: IDS.alpha, label: "甲号编剧室", root: alpha.root },
  { id: IDS.beta, label: "乙号编剧室", root: beta.root },
  // The catalog claims ws_c, while the durable root identity is ws_d. Studio must preserve this
  // as a degraded fleet card but never let ws_c become a read or write namespace.
  { id: IDS.corrupt, label: "损坏指针", root: corrupt.root },
];
const options = {
  root: alpha.root,
  defaultWorkspaceId: IDS.alpha,
  workspaceProvider: (): StudioWorkspaceEntry[] => catalog,
  pollMs: 250,
  maxStreams: 8,
} as const;

let server = createStudioServer(options);
let base = "";
let alphaInitial: OpenStream | null = null;
let betaInitial: OpenStream | null = null;
let resumed: OpenStream | null = null;
let fleetStream: OpenStream | null = null;

async function listen(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

try {
  base = await listen();
  const fleet = await fetch(`${base}/`);
  const fleetHtml = await fleet.text();
  ok(fleet.status === 200 && fleetHtml.includes("所有故事，各有自己的房间")
    && fleetHtml.includes("甲号编剧室") && fleetHtml.includes("乙号编剧室")
    && fleetHtml.includes(`/w/${IDS.alpha}/`) && fleetHtml.includes(`/w/${IDS.beta}/`)
    && fleetHtml.includes("损坏指针") && !fleetHtml.includes(`/w/${IDS.corrupt}/`),
  "fleet 首页列出健康 namespace，并把 identity mismatch 保留为不可点击的 degraded 卡片");

  const health = await fetch(`${base}/api/health`);
  const healthJson = await health.json() as { workspaces?: number; readyWorkspaces?: number; projects?: number };
  ok(health.status === 200 && healthJson.workspaces === 3 && healthJson.readyWorkspaces === 2 && healthJson.projects === 2,
  "fleet health 聚合工作区与项目数量");

  const corruptPage = await fetch(`${base}/w/${IDS.corrupt}/`);
  const corruptSnapshot = await fetch(`${base}/w/${IDS.corrupt}/api/snapshot`);
  const corruptWrite = await fetch(`${base}/w/${IDS.corrupt}/p/demo/toggle`, {
    method: "POST", headers: { origin: base }, body: new URLSearchParams({ enabled: "false" }), redirect: "manual",
  });
  const corruptConfig = JSON.parse(readFileSync(corrupt.config, "utf8")) as { projects: { demo: { enabled: boolean } } };
  ok(corruptPage.status === 409 && corruptSnapshot.status === 409 && corruptWrite.status === 409
    && corruptConfig.projects.demo.enabled === true,
  "identity mismatch 条目不能读取 snapshot/页面、不能写入，也不能借 claimed ID 路由到实际 root");

  const legacy = await fetch(`${base}/p/demo?notice=legacy`, { redirect: "manual" });
  ok(legacy.status === 307 && legacy.headers.get("location") === `/w/${IDS.alpha}/p/demo?notice=legacy`,
  "多工作区 GET 将旧 URL 暂时重定向到默认 workspace");
  const unsafeLegacyWrite = await fetch(`${base}/p/demo/toggle`, {
    method: "POST", headers: { origin: base }, body: new URLSearchParams({ enabled: "false" }), redirect: "manual",
  });
  ok(unsafeLegacyWrite.status === 409, "多工作区拒绝缺少 workspace 命名空间的写请求");
  ok((await fetch(`${base}/w/demo/`)).status === 400
    && (await fetch(`${base}/w/${encodeURIComponent(`%${IDS.alpha}`)}/`)).status === 400,
  "workspace router 拒绝短 ID 与双编码 ID");

  const alphaPage = await fetch(`${base}/w/${IDS.alpha}/p/demo`);
  const betaPage = await fetch(`${base}/w/${IDS.beta}/p/demo`);
  const alphaHtml = await alphaPage.text();
  const betaHtml = await betaPage.text();
  ok(alphaPage.status === 200 && alphaHtml.includes("甲室同名项目") && alphaHtml.includes("ALPHA_ONLY")
    && !alphaHtml.includes("BETA_ONLY") && alphaHtml.includes(`data-stream="/w/${IDS.alpha}/api/stream"`),
  "甲 workspace 页面只呈现甲的同名项目并使用 scoped stream");
  ok(betaPage.status === 200 && betaHtml.includes("乙室同名项目") && betaHtml.includes("BETA_ONLY")
    && !betaHtml.includes("ALPHA_ONLY") && betaHtml.includes(`data-stream="/w/${IDS.beta}/api/stream"`),
  "乙 workspace 页面只呈现乙的同名项目并使用 scoped stream");

  const alphaSnapshotResponse = await fetch(`${base}/w/${IDS.alpha}/api/snapshot?project=demo`);
  const betaSnapshotResponse = await fetch(`${base}/w/${IDS.beta}/api/snapshot?project=demo`);
  const alphaSnapshot = await alphaSnapshotResponse.json() as { project?: { title?: string } };
  const betaSnapshot = await betaSnapshotResponse.json() as { project?: { title?: string } };
  ok(alphaSnapshot.project?.title === "甲室同名项目" && betaSnapshot.project?.title === "乙室同名项目",
  "snapshot API 以 workspace ID 隔离相同 project key");

  const alphaResource = await fetch(`${base}/w/${IDS.alpha}/api/projects/demo/resources/ticket/WL-1`);
  const betaResource = await fetch(`${base}/w/${IDS.beta}/api/projects/demo/resources/ticket/WL-1`);
  const alphaResourceJson = await alphaResource.json() as { content?: string };
  const betaResourceJson = await betaResource.json() as { content?: string };
  ok(alphaResourceJson.content?.includes("ALPHA_ONLY") === true && !alphaResourceJson.content?.includes("BETA_ONLY"),
  "资源 API 不会把乙 workspace 的同名 Ticket 泄漏给甲");
  ok(betaResourceJson.content?.includes("BETA_ONLY") === true && !betaResourceJson.content?.includes("ALPHA_ONLY"),
  "资源 API 不会把甲 workspace 的同名 Ticket 泄漏给乙");

  const alphaActivityResponse = await fetch(`${base}/w/${IDS.alpha}/api/projects/demo/activity?limit=1`);
  const alphaActivity = await alphaActivityResponse.json() as { workspaceId?: string; nextBeforeCursor?: string | null };
  ok(alphaActivityResponse.status === 200 && alphaActivity.workspaceId === IDS.alpha && Boolean(alphaActivity.nextBeforeCursor),
  "ActivityIndexer page 写入 workspace identity 且返回 v2 分页 cursor");
  const foreignActivityCursor = await fetch(`${base}/w/${IDS.beta}/api/projects/demo/activity?limit=1&before=${encodeURIComponent(alphaActivity.nextBeforeCursor ?? "")}`);
  ok(foreignActivityCursor.status === 400, "activity before cursor 绑定 workspace/project/generation，不能跨室复用");

  const toggled = await fetch(`${base}/w/${IDS.alpha}/p/demo/toggle`, {
    method: "POST", headers: { origin: base }, body: new URLSearchParams({ enabled: "false" }), redirect: "manual",
  });
  const alphaConfig = JSON.parse(readFileSync(alpha.config, "utf8")) as { projects: { demo: { enabled: boolean } } };
  const betaConfig = JSON.parse(readFileSync(beta.config, "utf8")) as { projects: { demo: { enabled: boolean } } };
  ok(toggled.status === 303 && toggled.headers.get("location")?.startsWith(`/w/${IDS.alpha}/p/demo?notice=`) === true
    && alphaConfig.projects.demo.enabled === false && betaConfig.projects.demo.enabled === true,
  "scoped toggle 只原子更新目标 workspace 并保留 scoped redirect");

  alphaInitial = await openStream(`${base}/w/${IDS.alpha}/api/stream`);
  const alphaFrame = await readFrame(alphaInitial);
  const alphaCursor = eventId(alphaFrame);
  betaInitial = await openStream(`${base}/w/${IDS.beta}/api/stream`);
  const betaFrame = await readFrame(betaInitial);
  const betaCursor = eventId(betaFrame);
  ok(/^wlsse1_ws_[a-f0-9]{32}_[a-f0-9]{64}$/.test(alphaCursor)
    && alphaCursor.startsWith(`wlsse1_${IDS.alpha}_`) && betaCursor.startsWith(`wlsse1_${IDS.beta}_`),
  "SSE 首帧 ID 明确绑定各自 workspace");
  await closeStream(alphaInitial); alphaInitial = null;
  await closeStream(betaInitial); betaInitial = null;
  await closeStudioServer(server);

  // A fresh server instance must read the durable ActivityIndexer revision and reproduce the
  // exact scope cursor. This is the Last-Event-ID contract that an in-memory poller cannot offer.
  server = createStudioServer(options);
  base = await listen();
  resumed = await openStream(`${base}/w/${IDS.alpha}/api/stream`, alphaCursor);
  const resumedFrame = await readFrame(resumed);
  ok(resumed.response.status === 200 && resumedFrame.includes("cursor-current") && !resumedFrame.includes("data:"),
  "Last-Event-ID 在 Studio 重启后仍精确恢复，不重复发送未变化快照");
  ok((await fetch(`${base}/w/${IDS.alpha}/api/stream`, { headers: { "last-event-id": "broken" } })).status === 400,
  "损坏 Last-Event-ID 返回 400");
  ok((await fetch(`${base}/w/${IDS.beta}/api/stream`, { headers: { "last-event-id": alphaCursor } })).status === 400,
  "SSE Last-Event-ID 不能跨 workspace 复用");

  appendFileSync(alpha.ticket, `\n### 2026-08-10T11:00:00.000Z — operator\nALPHA_ONLY activity-only append。\n`);
  const changedFrame = await readFrame(resumed, 3_000);
  const changedCursor = eventId(changedFrame);
  ok(changedCursor.startsWith(`wlsse1_${IDS.alpha}_`) && changedCursor !== alphaCursor,
  "只追加 Ticket comment 也推进 ActivityIndexer revision 并触发 scoped SSE");

  const betaResumed = await openStream(`${base}/w/${IDS.beta}/api/stream`, betaCursor);
  const betaResumedFrame = await readFrame(betaResumed);
  ok(betaResumedFrame.includes("cursor-current") && !betaResumedFrame.includes("data:"),
  "甲的 activity-only 变化不会推进乙的 SSE cursor");
  await closeStream(betaResumed);

  fleetStream = await openStream(`${base}/api/stream`);
  const fleetCursor = eventId(await readFrame(fleetStream));
  catalog[0] = { ...catalog[0], label: "甲号编剧室 · 新标签" };
  const fleetChangedFrame = await readFrame(fleetStream, 3_000);
  const fleetChangedCursor = eventId(fleetChangedFrame);
  const relabeledFleet = await fetch(`${base}/`);
  ok(fleetChangedCursor.startsWith("wlsse1_fleet_") && fleetChangedCursor !== fleetCursor
    && (await relabeledFleet.text()).includes("甲号编剧室 · 新标签"),
  "registry label 变化会推进 fleet SSE cursor 并刷新总台卡片，而非等待脚本内容变化");
  await closeStream(fleetStream); fleetStream = null;

  const alphaIndex = JSON.parse(readFileSync(join(alpha.root, ".writing-loop", "demo", "activity-index.v2.json"), "utf8")) as { workspaceId?: string; revision?: number };
  const betaIndex = JSON.parse(readFileSync(join(beta.root, ".writing-loop", "demo", "activity-index.v2.json"), "utf8")) as { workspaceId?: string; revision?: number };
  ok(alphaIndex.workspaceId === IDS.alpha && betaIndex.workspaceId === IDS.beta && (alphaIndex.revision ?? 0) > (betaIndex.revision ?? 0),
  "持久 activity index 分别记录 workspace identity，甲变更不会改写乙 index");
} finally {
  await closeStream(alphaInitial);
  await closeStream(betaInitial);
  await closeStream(resumed);
  await closeStream(fleetStream);
  await closeStudioServer(server);
  rmSync(parent, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSTUDIO_FLEET_OK" : `\n${failures} 项检查失败`);
process.exit(failures === 0 ? 0 : 1);
