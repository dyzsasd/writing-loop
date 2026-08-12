// Studio HTTP 回归：writer-first 页面、稳定 JSON、loopback request guard、XSS escaping、
// 原子项目启停与 SSE 首帧。使用真实 ephemeral HTTP server，不依赖浏览器或外部网络。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectActivity } from "../src/activity.ts";
import { closeStudioServer, createStudioServer, isLoopbackPeer } from "../src/studio.ts";
import { projectPage, STYLE } from "../src/studio-view.ts";
import { fileSystemProposal } from "../src/system-inbox.ts";
import { buildWorkspaceSnapshot } from "../src/project-read-model.ts";
import { loadConfig } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-studio-")));
let snapshotCalls = 0;
const server = createStudioServer({
  root: tmp,
  pollMs: 250,
  maxStreams: 2,
  snapshotProvider: () => {
    snapshotCalls++;
    return buildWorkspaceSnapshot(loadConfig(tmp));
  },
});
ok(isLoopbackPeer("127.0.0.1") && isLoopbackPeer("127.42.0.9") && isLoopbackPeer("::1")
  && isLoopbackPeer("::ffff:127.0.0.1") && !isLoopbackPeer("192.0.2.10") && !isLoopbackPeer(undefined),
"Studio 请求守卫识别真实 loopback/IPv4-mapped 对端，不只信任 Host 请求头");
server.prependListener("request", (req, res) => {
  if (!(req.url ?? "").includes("stall=1")) return;
  const writable = res as unknown as { write(chunk: unknown, ...args: unknown[]): boolean };
  const original = writable.write.bind(res);
  let writes = 0;
  writable.write = (chunk: unknown, ...args: unknown[]): boolean => {
    const accepted = original(chunk, ...args);
    writes++;
    return writes < 2 && accepted;
  };
});
let serverStopped = false;

const rawStatus = (port: number, host: string): Promise<number> => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
    res.resume();
    res.once("end", () => resolve(res.statusCode ?? 0));
  });
  req.once("error", reject);
  req.end();
});

try {
  ok(STYLE.includes(".workspace-grid>*{min-width:0}") && STYLE.includes("max-width:100%;grid-template-columns"), "移动端回归：宽泳道只能在自身内部滚动，不撑宽整页");
  const data = join(tmp, ".writing-loop");
  const projectData = join(data, "demo");
  const tickets = join(projectData, "board", "tickets");
  const repo = join(tmp, "demo-repo");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  writeFileSync(join(data, "workspace.json"), JSON.stringify({
    version: 1, id: `ws_${"f".repeat(32)}`,
  }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    futureField: { doNotLose: true },
    projects: {
      demo: { title: "纸月亮 <script>danger()</script>", repoPath: "demo-repo", enabled: true,
        seasonStrategy: "multi-season", currentSeason: 2, totalEpisodes: 8 },
    },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "bible", "north-star.md"), "## 一句话故事\n她写下的每一场戏都会成真。\n");
  writeFileSync(join(repo, "episodes", "ep-001.md"), "# 第一集：纸上的雨\n");
  writeFileSync(join(tickets, "WL-1.md"), `---
id: WL-1
title: 决定女主是否说出真相
type: Feature
state: In Review
owner: showrunner
labels: [writing-loop, needs-showrunner]
priority: 1
updated: 2026-08-09T10:00:00.000Z
---
Episode: 1
`);
  writeFileSync(join(projectData, "wl-run.lock"), `holder pid=${process.pid} at ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);
  writeFileSync(join(projectData, "run-state.json"), JSON.stringify({
    status: "running", pid: process.pid, cli: "codex", startedAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    inFlight: [{ agent: "reviewer", pid: process.pid, model: "gpt-5", effort: "high", startedAt: "2026-08-09T10:00:00.000Z", capSeconds: 600, logFile: "logs/reviewer.log" }],
  }));
  fileSystemProposal(tmp, {
    version: 1, kind: "framework-improvement", title: "系统建议不进入剧本看板",
    summary: "来自 reflect 的框架维护事项。", evidence: ["project=demo"],
    proposedChange: "路由到 workspace 系统收件箱。",
    source: { project: "demo", agent: "reflect", projectTicket: null },
  }, { now: () => new Date("2026-08-11T20:30:00.000Z") });

  const viewWorkspace = loadConfig(tmp);
  const viewSnapshot = buildWorkspaceSnapshot(viewWorkspace);
  const viewActivity = buildProjectActivity(viewWorkspace, "demo");
  viewActivity.usage.cost = {
    state: "known",
    value: { currency: "USD", amountMicros: 1, basis: "reported" },
    source: "ledger",
  };
  const activityCostHtml = projectPage(viewSnapshot, viewSnapshot.projects[0]!, undefined, {
    activity: viewActivity,
  });
  ok(activityCostHtml.includes("&lt;$0.01") && !activityCostHtml.includes("$0.00"),
    "Studio activity 正数 sub-cent 成本复用整数 formatter，不伪装成 $0.00");

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const root = await fetch(`${base}/`);
  const html = await root.text();
  ok(root.status === 200 && html.includes("作品书架") && html.includes("故事从这里继续"), "workspace 首页使用编剧场景信息架构");
  ok(html.includes("系统改进收件箱") && html.includes("1</b><span>OPEN SYSTEM ITEMS"),
    "workspace 首页把系统维护入口与作品书架分层展示");
  const systemPage = await fetch(`${base}/system`);
  const systemHtml = await systemPage.text();
  ok(systemPage.status === 200 && systemHtml.includes("系统问题，不混进故事")
    && systemHtml.includes("系统建议不进入剧本看板") && systemHtml.includes("来源 demo/reflect"),
  "Studio /system 独立展示 workspace 级框架建议及来源");
  const systemApi = await fetch(`${base}/api/system/proposals`);
  const systemProjection = await systemApi.json() as { counts?: { open?: number }; proposals?: Array<{ source?: { project?: string } }> };
  ok(systemApi.status === 200 && systemProjection.counts?.open === 1
    && systemProjection.proposals?.[0]?.source?.project === "demo",
  "系统建议 API 是 project board 之外的独立只读投影");
  ok(html.includes("纸月亮 &lt;script&gt;danger()&lt;/script&gt;") && !html.includes("<script>danger()"), "项目动态文本经过 HTML escaping");
  const csp = root.headers.get("content-security-policy") ?? "";
  const scriptBody = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const scriptHash = createHash("sha256").update(scriptBody).digest("base64");
  ok(csp.includes("frame-ancestors 'none'") && csp.includes(`script-src 'sha256-${scriptHash}'`) && !csp.includes("script-src 'unsafe-inline'"), "HTML 带 framing 防护且实际内联脚本与 CSP 哈希逐字匹配");
  ok(root.headers.get("referrer-policy") === "same-origin", "真实同源 form POST 保留可验证来源且不向跨站泄露 referrer");

  const page = await fetch(`${base}/p/demo?notice=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
  const pageHtml = await page.text();
  if (page.status !== 200) console.error(`project page ${page.status}: ${pageHtml}`);
  ok(page.status === 200 && pageHtml.includes("故事脊柱") && pageHtml.includes("等待你的决定")
    && pageHtml.includes("审读正在工作") && pageHtml.includes("多季项目 · 第 2 季")
    && pageHtml.includes("本季 8 集"),
  "项目页呈现季制、当前季、创作成熟度、人工门与 live agent");
  ok(pageHtml.includes("原著分析") && pageHtml.includes("故事结构") && pageHtml.includes("人物设定")
    && pageHtml.includes("美术资产") && pageHtml.includes("分集与质量"),
  "项目概览提供完整的创作工作台信息架构，不再只呈现看板");
  ok(pageHtml.includes("创作资产") && pageHtml.includes("全季结构") && pageHtml.includes("人物与世界")
    && !pageHtml.includes("story/outline.v1.json") && !pageHtml.includes("story/assets.v1.json"),
  "项目首页只呈现创作概念，不向编剧暴露 JSON 实现文件");
  ok(pageHtml.includes("一句话故事已定") && pageHtml.includes("故事结构尚未过门"), "成熟度使用结构化创作信号，不把脚手架当作过门");
  ok(!pageHtml.includes("<img src=x") && pageHtml.includes("&lt;img src=x"), "notice 参数不会注入 HTML");

  writeFileSync(join(repo, "bible", "north-star.md"), "## 一句话故事（Vision）\n<!-- 等待立项采访写入 -->\n");
  const scaffoldPage = await fetch(`${base}/p/demo`);
  ok((await scaffoldPage.text()).includes("核心方向仍待定"), "成熟度不会把三份 bible 模板的存在误报为核心方向就绪");

  const api = await fetch(`${base}/api/snapshot?project=demo`);
  const projection = await api.json() as { project?: { key?: string; scheduler?: { inFlight?: unknown[] } } };
  ok(api.status === 200 && projection.project?.key === "demo" && projection.project.scheduler?.inFlight?.length === 1, "project JSON 与页面消费同一稳定投影");
  const health = await fetch(`${base}/api/health`);
  ok(health.status === 200 && (await health.json() as { ok?: boolean }).ok === true, "health endpoint 可探活");
  const head = await fetch(`${base}/`, { method: "HEAD" });
  ok(head.status === 200 && (await head.text()) === "" && Number(head.headers.get("content-length")) > 0, "HEAD 复用路由且不返回正文");
  ok((await fetch(`${base}/p/ghost`)).status === 404 && (await fetch(`${base}/api/snapshot?project=ghost`)).status === 404, "未知项目的 HTML/JSON 都返回 404");
  ok((await fetch(`${base}/api/projects/ghost/activity`)).status === 404
    && (await fetch(`${base}/api/projects/ghost/resources/ticket/WL-1`)).status === 404,
  "未知项目的 activity/resource API 使用 404，而非把缺失误报成配置冲突");

  const ticketDetail = await fetch(`${base}/p/demo/ticket/WL-1`);
  const ticketDetailHtml = await ticketDetail.text();
  ok(ticketDetail.status === 200 && ticketDetailHtml.includes("交接与流转评论") && ticketDetailHtml.includes("WL-1"), "Ticket 卡片拥有按需只读详情页");
  const ticketApi = await fetch(`${base}/api/projects/demo/resources/ticket/WL-1`);
  const ticketProjection = await ticketApi.json() as { ticket?: { summary?: { id?: string } }; content?: string };
  ok(ticketApi.status === 200 && ticketApi.headers.get("etag")?.startsWith("\"") === true
    && ticketProjection.ticket?.summary?.id === "WL-1" && ticketProjection.content?.includes("Episode: 1") === true,
  "资源 API 返回 Ticket detail DTO、原始 Markdown 与 ETag");
  ok((await fetch(`${base}/api/projects/demo/resources/ticket/WL-404`)).status === 404
    && (await fetch(`${base}/p/demo/ticket/WL-404`)).status === 404,
  "合法 registry id 但资源不存在时，JSON 与 HTML 详情都返回 404");
  const activityApi = await fetch(`${base}/api/projects/demo/activity?limit=10`);
  const activityProjection = await activityApi.json() as { items?: Array<{ kind?: string }>; live?: Array<{ agent?: string }>; usage?: { cost?: { state?: string } } };
  ok(activityApi.status === 200 && activityProjection.items?.some((event) => event.kind?.startsWith("ticket.")) === true
    && activityProjection.live?.[0]?.agent === "reviewer" && activityProjection.usage?.cost?.state === "unknown",
  "project-scoped activity API 合并 Ticket 历史、live overlay，并诚实标成本未知");
  ok((await fetch(`${base}/api/projects/demo/activity?before=not-json`)).status === 400, "损坏 activity cursor 属于客户端 400，而非配置冲突 409");
  ok((await fetch(`${base}/api/projects/demo/resources/ticket/%252e%252e`)).status === 400, "资源 API 在 registry 查询前拒绝双编码 dot-dot id");
  ok((await fetch(`${base}/api/projects/demo/resources/document/characters`)).status === 404, "旧人物 Markdown 不再属于文档 registry");

  ok(await rawStatus(port, "evil.example") === 400, "Host guard 阻断 DNS rebinding 风格请求");
  const crossed = await fetch(`${base}/p/demo/toggle`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
    body: "enabled=false",
    redirect: "manual",
  });
  ok(crossed.status === 400, "跨源 POST 被 Origin guard 阻断");
  const wrongScheme = await fetch(`${base}/p/demo/toggle`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://127.0.0.1:${port}` },
    body: "enabled=false",
    redirect: "manual",
  });
  ok(wrongScheme.status === 400, "同 Host 但不同 scheme 仍按跨源请求阻断");
  ok((JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as { projects: { demo: { enabled: boolean } } }).projects.demo.enabled, "被拒写请求不改变配置");

  const wrongType = await fetch(`${base}/p/demo/toggle`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(wrongType.status === 400, "缺少同源 Origin 的写请求先于内容解析被拒绝");
  const wrongTypeSameOrigin = await fetch(`${base}/p/demo/toggle`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
  ok(wrongTypeSameOrigin.status === 415, "同源写入口仍只接受明确的 form 编码");
  const oversized = await fetch(`${base}/p/demo/toggle`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: `enabled=false&padding=${"x".repeat(65 * 1024)}`,
  });
  ok(oversized.status === 413 && (await oversized.json() as { error?: string }).error?.includes("64 KiB") === true,
  "真实超限 POST 被完整排空并返回结构化 413，不重置 socket");
  const wrongSnapshotMethod = await fetch(`${base}/api/snapshot`, { method: "POST", headers: { origin: base } });
  ok(wrongSnapshotMethod.status === 405 && wrongSnapshotMethod.headers.get("allow") === "GET, HEAD", "已知只读路由的方法错配返回 405 + Allow");
  const wrongToggleMethod = await fetch(`${base}/p/demo/toggle`);
  ok(wrongToggleMethod.status === 405 && wrongToggleMethod.headers.get("allow") === "POST", "已知写路由的 GET 方法错配返回 405 + Allow");
  const newlineKey = await fetch(`${base}/p/demo%0A/toggle`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "enabled=false",
    redirect: "manual",
  });
  ok(newlineKey.status === 400, "URL key 的末尾换行不能利用 JavaScript $ 锚点绕过校验");
  const toggled = await fetch(`${base}/p/demo/toggle`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "enabled=false",
    redirect: "manual",
  });
  const changed = JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as {
    futureField?: { doNotLose?: boolean }; projects: { demo: { enabled: boolean } };
  };
  ok(toggled.status === 303 && toggled.headers.get("location")?.startsWith("/p/demo?notice=") === true, "合法启停使用 POST/303/GET");
  ok(changed.projects.demo.enabled === false && changed.futureField?.doNotLose === true, "Studio 启停原子落盘并保留未知字段");

  const newPage = await fetch(`${base}/projects/new`);
  const newHtml = await newPage.text();
  ok(newPage.status === 200 && newHtml.includes("生成零写入立项计划") && newHtml.includes("原著与改编方向")
    && newHtml.includes("YOU PROVIDE") && newHtml.includes("WRITING-LOOP DECIDES")
    && newHtml.includes("先扫描整部原著，再提出季界、当前季取材")
    && newHtml.includes('name="seasonStrategy"') && newHtml.includes('name="currentSeason"')
    && newHtml.includes('name="sourcePath"') && newHtml.includes('name="adaptationBrief"')
    && newHtml.includes('name="sourceHarness"') && newHtml.includes('name="allowRawSourceProcessing"')
    && !newHtml.includes('name="compressionRatio"') && !newHtml.includes('name="highlightCount"')
    && !newHtml.includes('name="sourceNamedCharacters"'),
  "Studio 立项表只要求操作者提供原著、改编方向、权利范围与 Harness，不把拆书输出反推给操作者填写");
  const onboardingForm = new URLSearchParams({
    key: "new-drama", title: "新剧 <安全>", repoPath: "new-drama", kind: "original",
    logline: "她能听见每个谎言在月光下碎裂。", audience: "女性 25-40 岁付费用户",
    complianceNotes: "不涉政；违法有后果；不美化控制；遵守平台边界。", nonGoals: "不复制未授权 IP",
    genre: "revenge-slap", monetization: "paid-app", format: "live-action",
    seasonStrategy: "single-season", currentSeason: "1", totalEpisodes: "80",
    card1: "9,10,11", card2: "26,28,30", card3: "60", wordMin: "900", wordMax: "1300",
    maxPrimaryScenes: "5", maxNamedCharacters: "20", ticketPrefix: "ND", intakeMode: "autonomous", mode: "live",
    comparables: "公开结构对标", differentiation: "谎言视觉化",
  });
  const outsideForm = new URLSearchParams(onboardingForm);
  outsideForm.set("key", "outside-drama");
  outsideForm.set("ticketPrefix", "OD");
  outsideForm.set("repoPath", join(tmp, "outside-drama"));
  const outsidePlan = await fetch(`${base}/projects/plan`, { method: "POST", headers: { origin: base }, body: outsideForm });
  ok(outsidePlan.status === 400 && !existsSync(join(tmp, "outside-drama")), "Studio 立项拒绝绝对/外部 repoPath");

  const planned = await fetch(`${base}/projects/plan`, { method: "POST", headers: { origin: base }, body: onboardingForm });
  const planHtml = await planned.text();
  const planId = /name="planId" value="([^"]+)"/.exec(planHtml)?.[1] ?? "";
  const payload = /name="payload" value="([^"]+)"/.exec(planHtml)?.[1] ?? "";
  ok(planned.status === 200 && /^wlplan_[0-9a-f]{24}$/.test(planId) && payload.length > 20
    && planHtml.includes("Preview · no writes") && !existsSync(join(tmp, "new-drama")), "立项预览返回绑定指纹且严格零写");
  const invalidOnboarding = new URLSearchParams(onboardingForm);
  invalidOnboarding.set("key", "invalid-drama");
  invalidOnboarding.set("repoPath", "invalid-drama");
  invalidOnboarding.set("comparables", "");
  const invalidHtmlResponse = await fetch(`${base}/projects/plan`, {
    method: "POST", headers: { origin: base, accept: "text/html,application/xhtml+xml" }, body: invalidOnboarding,
  });
  const invalidHtml = await invalidHtmlResponse.text();
  ok(invalidHtmlResponse.status === 400 && invalidHtmlResponse.headers.get("content-type")?.startsWith("text/html") === true
    && invalidHtml.includes("这次操作没有完成") && invalidHtml.includes("返回立项表")
    && !existsSync(join(tmp, "invalid-drama")),
  "浏览器立项校验失败呈现可读 HTML 且保持零写，API 错误语义不被静默吞掉");
  const tampered = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  tampered.title = "被篡改的新剧";
  const tamperedCreate = await fetch(`${base}/projects/create`, {
    method: "POST", headers: { origin: base }, redirect: "manual",
    body: new URLSearchParams({ planId, payload: Buffer.from(JSON.stringify(tampered)).toString("base64url") }),
  });
  ok(tamperedCreate.status === 409 && !existsSync(join(tmp, "new-drama")), "隐藏 payload 被篡改时 plan 指纹失效且不落半项目");
  const created = await fetch(`${base}/projects/create`, {
    method: "POST", headers: { origin: base }, redirect: "manual", body: new URLSearchParams({ planId, payload }),
  });
  const afterOnboarding = JSON.parse(readFileSync(join(data, "config.json"), "utf8")) as {
    futureField?: { doNotLose?: boolean }; projects?: Record<string, { title?: string }>;
  };
  ok(created.status === 303 && created.headers.get("location")?.startsWith("/p/new-drama?notice=") === true,
  "确认计划后以 POST/303/GET 完整立项");
  ok(afterOnboarding.projects?.["new-drama"]?.title === "新剧 <安全>" && afterOnboarding.futureField?.doNotLose === true
    && existsSync(join(tmp, "new-drama", ".git")) && existsSync(join(data, "new-drama", "board", "tickets", "ND-1.md")),
  "Studio 立项一次发布 config、Git repo、运行态板与唯一首票且保留未知字段");
  const createdPage = await fetch(`${base}/p/new-drama`);
  const createdHtml = await createdPage.text();
  ok(createdPage.status === 200 && createdHtml.includes("新剧 &lt;安全&gt;") && createdHtml.includes("创作时间线")
    && createdHtml.includes("立项"), "新项目页面 escaping 正确并立即呈现立项时间线");

  const sourceNovel = join(tmp, "adaptation-source.txt");
  writeFileSync(sourceNovel, Array.from({ length: 6 }, (_, index) => `第${index + 1}章 测试\n${"原著结构内容".repeat(1_000)}\n`).join(""));
  const adaptationForm = new URLSearchParams({
    key: "adapted-drama", title: "改编新剧", repoPath: "adapted-drama", kind: "adaptation",
    logline: "一个自信知道王朝结局的人，发现自己的历史记忆正在失效。", audience: "男性 25-44 岁海外流媒体用户",
    complianceNotes: "仅作内部开发；发行前完成版权、分级和史实复核。", nonGoals: "不逐章照搬原著",
    genre: "brain-hole", monetization: "reelshort-sub", format: "reelshort-en",
    seasonStrategy: "multi-season", currentSeason: "1", totalEpisodes: "60",
    card1: "", card2: "", card3: "", wordMin: "500", wordMax: "800",
    maxPrimaryScenes: "4", maxNamedCharacters: "18", ticketPrefix: "AD", intakeMode: "autonomous", mode: "live",
    sourceTitle: "测试原著", sourcePath: sourceNovel,
    adaptationBrief: "保留权力升级与历史失效的核心钩子，由 writing-loop 自主拆解并决定第一季结构。",
    rightsScope: "仅限内部改编开发，发行前补齐权利链", sourceHarness: "claude", allowRawSourceProcessing: "true",
  });
  const noConsentForm = new URLSearchParams(adaptationForm);
  noConsentForm.set("key", "no-consent");
  noConsentForm.set("repoPath", "no-consent");
  noConsentForm.set("ticketPrefix", "NC");
  noConsentForm.delete("allowRawSourceProcessing");
  const noConsent = await fetch(`${base}/projects/plan`, {
    method: "POST", headers: { origin: base, accept: "text/html,application/xhtml+xml" }, body: noConsentForm,
  });
  ok(noConsent.status === 400 && (await noConsent.text()).includes("明确允许")
    && !existsSync(join(tmp, "no-consent")) && !existsSync(join(data, "no-consent")),
  "改编立项未明确授权所选 Harness 读取原著时零写拒绝");

  const adaptationPlanned = await fetch(`${base}/projects/plan`, { method: "POST", headers: { origin: base }, body: adaptationForm });
  const adaptationPlanHtml = await adaptationPlanned.text();
  const adaptationPlanId = /name="planId" value="([^"]+)"/.exec(adaptationPlanHtml)?.[1] ?? "";
  const adaptationPayload = /name="payload" value="([^"]+)"/.exec(adaptationPlanHtml)?.[1] ?? "";
  ok(adaptationPlanned.status === 200 && /^wlplan_[0-9a-f]{24}$/.test(adaptationPlanId)
    && adaptationPlanHtml.includes("自动原著分析") && adaptationPlanHtml.includes("adaptation-source.txt")
    && adaptationPlanHtml.includes("chunks · claude")
    && !existsSync(join(tmp, "adapted-drama")),
  "改编预览绑定本地原著指纹、分块与 Harness，并保持严格零写");
  const adaptationCreated = await fetch(`${base}/projects/create`, {
    method: "POST", headers: { origin: base }, redirect: "manual",
    body: new URLSearchParams({ planId: adaptationPlanId, payload: adaptationPayload }),
  });
  const adaptationNotice = decodeURIComponent(adaptationCreated.headers.get("location") ?? "");
  const outlineTicket = readFileSync(join(data, "adapted-drama", "board", "tickets", "AD-1.md"), "utf8");
  const sourceTicket = readFileSync(join(data, "adapted-drama", "board", "tickets", "AD-2.md"), "utf8");
  ok(adaptationCreated.status === 303 && adaptationNotice.includes("原著分析票 AD-2 已进入自治队列")
    && outlineTicket.includes("state: Backlog") && outlineTicket.includes("source-pending")
    && sourceTicket.includes("state: Todo") && sourceTicket.includes("source-analysis")
    && sourceTicket.includes("source-analyst") && !sourceTicket.includes("source-analysis, story-designer")
    && existsSync(join(data, "adapted-drama", "source-intake.v1", "original", "source.txt")),
  "确认改编立项后自动登记原著、创建分析票并停靠大纲票，不要求手工 source 命令");
  ok(readFileSync(join(tmp, "adapted-drama", "bible", "north-star.md"), "utf8").includes("由 writing-loop 自主拆解")
    && readFileSync(join(tmp, "adapted-drama", "source", "adaptation-brief.md"), "utf8").includes("操作者改编设计"),
  "项目开发总建议同时进入 North Star 与 source intake，成为自治规划的权威输入");
  const sourceWorkbench = await fetch(`${base}/p/adapted-drama/source`);
  const sourceWorkbenchHtml = await sourceWorkbench.text();
  const storyApi = await fetch(`${base}/api/projects/adapted-drama/story`);
  const storyProjection = await storyApi.json() as { version?: number; project?: string; source?: { chunkCount?: number }; summary?: { stage?: string } };
  ok(sourceWorkbench.status === 200 && sourceWorkbenchHtml.includes("原著分析")
    && sourceWorkbenchHtml.includes("不可变分块") && !sourceWorkbenchHtml.includes("原著结构内容"),
  "原著工作台显示指纹/分块/checkpoint 而不泄露原著正文");
  ok(storyApi.status === 200 && storyProjection.version === 1 && storyProjection.project === "adapted-drama"
    && Number(storyProjection.source?.chunkCount) > 0 && storyProjection.summary?.stage === "source",
  "project story API 与 Studio 共用本地 source/story 读模型");
  const qualityWorkbench = await fetch(`${base}/p/adapted-drama/quality`);
  ok(qualityWorkbench.status === 200 && (await qualityWorkbench.text()).includes("S00 · 结构化故事资产已建立"),
  "质量页在 companion 尚未建立时诚实显示 fail，而不是伪绿或空白");
  const timelineWorkbench = await fetch(`${base}/p/adapted-drama/timeline`);
  const timelineHtml = await timelineWorkbench.text();
  ok(timelineWorkbench.status === 200 && timelineHtml.includes("双轨时间线")
    && timelineHtml.includes("故事世界时序") && timelineHtml.includes("观众揭示顺序"),
  "Studio 时间线页面始终可访问，并明确区分 chronology 与 reveal order");
  const assetWorkbench = await fetch(`${base}/p/adapted-drama/assets`);
  ok(assetWorkbench.status === 200 && (await assetWorkbench.text()).includes("人物与世界"),
  "Studio 提供独立的人物与世界工作台，而非把全部剧情事实藏在人物卡或美术页");
  const wrongStoryMethod = await fetch(`${base}/api/projects/adapted-drama/story`, { method: "POST", headers: { origin: base } });
  ok(wrongStoryMethod.status === 405 && wrongStoryMethod.headers.get("allow") === "GET, HEAD",
  "story API 保持只读，Studio 不能绕过 agent/票据直接改故事资产");

  const stalled = await fetch(`${base}/api/stream?stall=1`);
  const stalledReader = stalled.body!.getReader();
  await stalledReader.read();
  writeFileSync(join(repo, "bible", "north-star.md"), "## 一句话故事\n触发一帧新的共享 snapshot。\n");
  const stalledClosed = await Promise.race([
    (async () => {
      for (let index = 0; index < 4; index++) if ((await stalledReader.read()).done) return true;
      return false;
    })(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  ok(stalledClosed, "SSE 客户端产生 backpressure 时主动断开，队列不会随长驻 Studio 无界增长");

  const configFile = join(data, "config.json");
  const configBeforeStreamFailure = readFileSync(configFile, "utf8");
  rmSync(configFile);
  const failedStream = await fetch(`${base}/api/stream`);
  ok(failedStream.status === 409, "SSE 初始化时配置不可读会返回结构化错误");
  writeFileSync(configFile, configBeforeStreamFailure);

  const abort = new AbortController();
  const abortSecond = new AbortController();
  const callsBeforeStreams = snapshotCalls;
  const stream = await fetch(`${base}/api/stream`, { signal: abort.signal });
  const secondStream = await fetch(`${base}/api/stream`, { signal: abortSecond.signal });
  const first = await stream.body?.getReader().read();
  const firstText = first?.value ? new TextDecoder().decode(first.value) : "";
  ok(stream.status === 200 && stream.headers.get("content-type")?.startsWith("text/event-stream") === true && firstText.includes("data: "), "SSE 建连立即给稳定指纹首帧");
  ok(secondStream.status === 200, "失败的 SSE 初始化会归还连接槽，不造成永久配额泄漏");
  const callsAfterConnect = snapshotCalls;
  await new Promise((resolve) => setTimeout(resolve, 650));
  const pollCalls = snapshotCalls - callsAfterConnect;
  ok(callsAfterConnect - callsBeforeStreams === 1 && pollCalls >= 2 && pollCalls <= 3,
  "多个 SSE 客户端共享一次 snapshot 轮询器，不按连接数重复全量扫描");
  const closed = await Promise.race([
    closeStudioServer(server).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  serverStopped = closed;
  ok(closed, "关闭 Studio 会主动终止 SSE，不因打开的浏览器页面卡住 Ctrl-C");
  abort.abort();
  abortSecond.abort();
} finally {
  if (!serverStopped) await closeStudioServer(server);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSTUDIO_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
