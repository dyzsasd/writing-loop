// 发布产物冒烟（仿 dev-loop test/build-artifact.ts 的动机）：`npm test` 跑的是 src/*.ts 源码
// （Node ≥23.6 type-stripping 零构建），发布装到用户机上的却是编译出的 dist/*.js ——
// 构建断裂 / 装机即死的入口在绿门里不可见。本套件 (a) 真跑发布构建，(b) 冒烟编译产物 bin，
// (c) 在「装机形」布局（dist/ 拷贝 + 包根插件负载、无仓库兄弟目录）下过一遍
// run --dry-run / status / fires / project plan-create-verify / doctor / install-claude-plugin 全链路。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // hub/
const pkgVersion = (JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8")) as { version: string }).version;
const packagedH3SmokePath = "examples/production/representative-h3/smoke.mjs";
const packagedH3SmokeCommand = `node node_modules/@dyzsasd/writing-loop/${packagedH3SmokePath}`;
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// 从 hubRoot 起子进程；捕获 status+stdout+合并输出。非零退出是断言数据，不抛。
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; unsetEnv?: string[] };
const run = (cmd: string, args: string[], opts: RunOptions = {}): { code: number; out: string; stdout: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  delete env.WRITING_LOOP_WORKSPACE;
  for (const key of opts.unsetEnv ?? []) delete env[key];
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? hubRoot, encoding: "utf8", env, timeout: 300_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};

const parseJson = <T>(raw: string): T | null => {
  try { return JSON.parse(raw) as T; }
  catch { return null; }
};

function parsePackJson(stdout: string): Array<{ files?: Array<{ path: string }> }> {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  try { return JSON.parse(stdout.slice(start)) as Array<{ files?: Array<{ path: string }> }>; }
  catch { return []; }
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-build-artifact-")));
const machineHome = join(tmp, "machine-home");
try {
  // ── AC1：发布/prepack 构建成功，emit 编译入口 + 把插件负载拷到包根 ──
  const build = run("npm", ["run", "build"]);
  ok(build.code === 0, `npm run build → 退出 0（发布构建编译 dist/）${build.code !== 0 ? `：${build.out.slice(-400)}` : ""}`);
  const distDir = join(hubRoot, "dist");
  ok(existsSync(join(distDir, "cli.js")), "dist/cli.js emit（包的 bin 入口）");
  ok(existsSync(join(distDir, "run.js")) && existsSync(join(distDir, "scheduler.js")), "dist/run.js + dist/scheduler.js emit（内建 TS 调度器随包编译）");
  ok(existsSync(join(distDir, "studio.js")) && existsSync(join(distDir, "snapshot.js")) && existsSync(join(distDir, "project.js")), "dist emit Studio / snapshot / project parity 入口");
  ok(existsSync(join(distDir, "onboarding.js")) && existsSync(join(distDir, "activity.js")) && existsSync(join(distDir, "project-detail.js")),
    "dist emit onboarding / activity / project-detail Phase 2 服务");
  ok(existsSync(join(distDir, "activity-index.js")) && existsSync(join(distDir, "workspace-registry.js"))
    && existsSync(join(distDir, "workspace-registry-cli.js")) && existsSync(join(distDir, "studio-view.js")),
    "dist emit ActivityIndexer / workspace registry / multi-workspace Studio 服务");
  ok(existsSync(join(distDir, "production.js")) && existsSync(join(distDir, "production-domain.js"))
    && existsSync(join(distDir, "production-store.js")) && existsSync(join(distDir, "production-read-model.js"))
    && existsSync(join(distDir, "production-adapter.js")),
  "dist emit production CLI / authoritative store / read model / remote adapter");
  ok(existsSync(join(distDir, "source.js")) && existsSync(join(distDir, "source-intake.js")),
  "dist emit source intake CLI / immutable chunking core");
  ok(existsSync(join(distDir, "story.js")) && existsSync(join(distDir, "story-design.js"))
    && existsSync(join(distDir, "story-assets.js")) && existsSync(join(distDir, "visual-production.js")),
  "dist emit story quality CLI / strict companion + story/visual asset resolvers");
  ok(existsSync(join(distDir, "system.js")) && existsSync(join(distDir, "system-inbox.js")),
  "dist emit workspace-level system proposal CLI / immutable inbox");
  ok(existsSync(join(distDir, "production-intent.js"))
    && existsSync(join(distDir, "production-enqueue.js"))
    && existsSync(join(distDir, "production-recovery.js"))
    && existsSync(join(distDir, "production-coordinator-domain.js"))
    && existsSync(join(distDir, "production-coordinator-store.js"))
    && existsSync(join(distDir, "production-coordinator-lock.js"))
    && existsSync(join(distDir, "production-coordinator-read-model.js"))
    && existsSync(join(distDir, "production-canonical-json.js"))
    && existsSync(join(distDir, "production-money.js"))
    && existsSync(join(distDir, "production-reconcile.js"))
    && existsSync(join(distDir, "production-ingestor.js"))
    && existsSync(join(distDir, "production-input-stager.js"))
    && existsSync(join(distDir, "production-h3-graph.js"))
    && existsSync(join(distDir, "production-stage-gateway.js"))
    && existsSync(join(distDir, "production-coordinator.js"))
    && existsSync(join(distDir, "production-runtime-config.js"))
    && existsSync(join(distDir, "production-runner.js"))
    && existsSync(join(distDir, "production-gateway.js"))
    && existsSync(join(distDir, "production-gateway-router.js"))
    && existsSync(join(distDir, "production-job-gateway.js"))
    && existsSync(join(distDir, "production-worker.js"))
    && existsSync(join(distDir, "production-worker-lock.js"))
    && existsSync(join(distDir, "production-studio-handoff.js")),
    "dist emit Phase 3B kernel + Phase 3C enqueue/staging/runtime/gateway/worker");
  ok(existsSync(join(hubRoot, "skills", "showrunner-agent", "SKILL.md"))
    && existsSync(join(hubRoot, "references", "conventions.md"))
    && existsSync(join(hubRoot, "scripts", "board-lock.sh"))
    && existsSync(join(hubRoot, "templates"))
    && existsSync(join(hubRoot, ".claude-plugin", "plugin.json")),
    "包根含完整插件负载（skills/references/scripts/templates/.claude-plugin —— build 拷贝）");
  const packageReadme = readFileSync(join(hubRoot, "README.md"), "utf8");
  ok(packageReadme.includes("https://github.com/dyzsasd/writing-loop/blob/main/docs/design/phase-3-remote-production/AI-SPEC.md")
    && !packageReadme.includes("](../docs/design/phase-3-remote-production/"),
  "发布包 README 的 Phase 3C 规格链接指向可安装后访问的仓库文档，而非包外相对路径");
  ok(packageReadme.includes(packagedH3SmokeCommand)
    && packageReadme.includes("performs no network requests")
    && packageReadme.includes("has not passed a live ComfyUI `/prompt`"),
  "发布包 README 可发现实际 pack 路径下的 H3 smoke，并明确零网络 representative / 非 live 声明");
  ok(!existsSync(join(hubRoot, "scripts", "wl-run.py")) && !existsSync(join(hubRoot, "scripts", "test-wl-run.py")),
    "包内 scripts/ 无 wl-run.py / test-wl-run.py（python 调度器已退役，board-lock.sh 等 agent 工具保留）");

  const pack = run("npm", ["--silent", "pack", "--dry-run", "--json"]);
  const packed = new Set(parsePackJson(pack.stdout)[0]?.files?.map((f) => f.path) ?? []);
  ok(pack.code === 0
    && packed.has("dist/cli.js") && packed.has("dist/scheduler.js")
    && packed.has("dist/onboarding.js") && packed.has("dist/activity.js") && packed.has("dist/activity-index.js")
    && packed.has("dist/project-detail.js") && packed.has("dist/workspace-registry.js")
    && packed.has("dist/workspace-registry-cli.js") && packed.has("dist/studio-view.js")
    && packed.has("dist/source.js") && packed.has("dist/source-intake.js")
    && packed.has("dist/story.js") && packed.has("dist/story-design.js") && packed.has("dist/story-assets.js")
    && packed.has("dist/visual-production.js")
    && packed.has("dist/system.js") && packed.has("dist/system-inbox.js")
    && packed.has("dist/production.js") && packed.has("dist/production-domain.js")
    && packed.has("dist/production-store.js") && packed.has("dist/production-read-model.js")
    && packed.has("dist/production-adapter.js")
    && packed.has("dist/production-intent.js") && packed.has("dist/production-enqueue.js")
    && packed.has("dist/production-recovery.js")
    && packed.has("dist/production-coordinator-domain.js")
    && packed.has("dist/production-coordinator-store.js") && packed.has("dist/production-coordinator-lock.js")
    && packed.has("dist/production-coordinator-read-model.js")
    && packed.has("dist/production-canonical-json.js")
    && packed.has("dist/production-money.js")
    && packed.has("dist/production-reconcile.js") && packed.has("dist/production-ingestor.js")
    && packed.has("dist/production-input-stager.js") && packed.has("dist/production-h3-graph.js")
    && packed.has("dist/production-stage-gateway.js")
    && packed.has("dist/production-coordinator.js")
    && packed.has("dist/production-runtime-config.js") && packed.has("dist/production-runner.js")
    && packed.has("dist/production-gateway.js") && packed.has("dist/production-gateway-router.js")
    && packed.has("dist/production-job-gateway.js")
    && packed.has("dist/production-worker.js") && packed.has("dist/production-worker-lock.js")
    && packed.has("dist/production-studio-handoff.js")
    && packed.has("examples/production/representative-h3/README.md")
    && packed.has("examples/production/representative-h3/production-runtime.json")
    && packed.has("examples/production/representative-h3/workflows/h3-fl2va-portrait.json")
    && packed.has(packagedH3SmokePath)
    && packed.has("skills/showrunner-agent/SKILL.md")
    && packed.has("references/story-design-schema.md") && packed.has("references/story-assets-schema.md")
    && packed.has("references/visual-production-schema.md")
    && packed.has("scripts/board-lock.sh")
    && packed.has(".claude-plugin/plugin.json")
    && ![...packed].some((p) => p.endsWith("wl-run.py")),
    "npm pack 装载 story/visual resolver + 插件负载 + 自洽 H3 runtime/template/smoke example，且不含 wl-run.py");

  // ── AC2：编译产物能跑（.ts→.js 兄弟 import 改写成立） ──
  const ver = run(process.execPath, [join(distDir, "cli.js"), "version"]);
  ok(ver.code === 0 && ver.stdout.trim() === pkgVersion, `编译 cli.js version → 退出 0 且 == package.json（${pkgVersion}）`);
  const help = run(process.execPath, [join(distDir, "cli.js"), "help"]);
  ok(help.code === 0 && help.out.includes("project plan --input request.json")
    && help.out.includes("project create --input request.json --confirm PLAN_ID")
    && help.out.includes("project verify KEY") && help.out.includes("workspace add [DIR]")
    && help.out.includes("source plan --project K --input FILE")
    && help.out.includes("source register --project K --input FILE --confirm PLAN_ID")
    && help.out.includes("source status --project K [--json]")
    && help.out.includes("story status --project K [--json]")
    && help.out.includes("story validate --project K [--stage skeleton|beats|full]")
    && help.out.includes("story context --project K --ticket ID --agent A")
    && help.out.includes("system proposal list [--json]")
    && help.out.includes("production status [--project K] [--json]")
    && help.out.includes("production enqueue --plan --project K --input FILE")
    && help.out.includes("--confirm PLAN_ID")
    && help.out.includes("production handoff --project K --input FILE")
    && help.out.includes("bundle export --out FILE.tar.gz")
    && help.out.includes("bundle import FILE.tar.gz --dir NEW_ROOT"),
  "编译 cli.js help → 立项、原著登记、story gates、workspace registry、production 与 bundle 命令可发现");
  const bundleHelp = run(process.execPath, [join(distDir, "cli.js"), "bundle", "--help"]);
  ok(bundleHelp.code === 0 && bundleHelp.out.includes("MOVE 语义") && bundleHelp.out.includes("project enable"),
    "编译 cli.js bundle --help → 迁移顺序（导出→传输→导入→doctor→enable→run）可读");
  const runHelp = run(process.execPath, [join(distDir, "cli.js"), "run", "--help"]);
  ok(runHelp.code === 0 && runHelp.out.includes("--cli claude|codex|opencode"), "编译 cli.js run --help → 调度器用法可读");
  const studioHelp = run(process.execPath, [join(distDir, "cli.js"), "studio", "--help"]);
  ok(studioHelp.code === 0 && studioHelp.out.includes("--port 8791")
    && studioHelp.out.includes("--workspace ID") && studioHelp.out.includes("--single"),
  "编译 cli.js studio --help → 多工作区选择与兼容模式用法可读");
  const workerHelp = run(process.execPath, [join(distDir, "production-worker.js"), "--help"]);
  ok(workerHelp.code === 0 && workerHelp.out.includes("--config FILE --once")
    && workerHelp.out.includes("不接受 endpoint、token、workflow 或模型覆盖"),
  "编译 production worker 入口可运行，且明示 server-only 配置边界");

  // ── AC3：装机形布局（dist/ 拷贝 + 包根插件负载；无仓库 ../skills 兄弟可回退） ──
  const inst = join(tmp, "pkg"); // inst/dist/cli.js → here=inst/dist，包根 = inst
  cpSync(distDir, join(inst, "dist"), { recursive: true });
  for (const d of ["skills", "references", "scripts", "templates", ".claude-plugin", "examples"]) {
    cpSync(join(hubRoot, d), join(inst, d), { recursive: true });
  }
  cpSync(join(hubRoot, "package.json"), join(inst, "package.json"));
  const instCli = join(inst, "dist", "cli.js");
  const instWorker = join(inst, "dist", "production-worker.js");
  const instWorkerHelp = run(process.execPath, [instWorker, "--help"], { cwd: inst });
  ok(instWorkerHelp.code === 0 && instWorkerHelp.out.includes("--config FILE --once"),
    "装机形 production worker bin 在无仓库兄弟目录时仍可运行");
  const instProductionExample = run(process.execPath, [
    join(inst, "examples", "production", "representative-h3", "smoke.mjs"),
  ], { cwd: inst });
  ok(instProductionExample.code === 0
    && instProductionExample.out.includes("PACKAGED_H3_PRODUCTION_SMOKE_OK")
    && !instProductionExample.out.includes("attempted network I/O"),
  `装机形 H3 example → strict config parse + template→bound + fake-port runtime/worker --once（零网络）${
    instProductionExample.code !== 0 ? `：${instProductionExample.out.slice(-600)}` : ""}`);

  // fixture workspace：单项目 + 已有票/账本/遥测（status/fires 有内容可断言）
  const ws = join(tmp, "ws");
  const proj = join(ws, ".writing-loop", "demo");
  mkdirSync(join(proj, "board", "tickets"), { recursive: true });
  mkdirSync(join(ws, "repo", "episodes"), { recursive: true });
  writeFileSync(join(ws, ".writing-loop", "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "装机冒烟剧", repoPath: "repo", enabled: true, audience: "女频·25-40", paywall: { card1: [9, 10] } } },
  }, null, 2));
  writeFileSync(join(ws, "repo", "episodes", "ep-003.md"), "# ep-003\n");
  writeFileSync(join(proj, "board", "tickets", "WL-1.md"),
    "---\nid: WL-1\ntitle: ep-004 写作\ntype: Feature\nstate: In Review\nowner: reviewer\nlabels: [writing-loop, episode, keystone]\nupdated: 2026-07-18T08:00:00Z\n---\nbody\n");
  writeFileSync(join(proj, "fires.jsonl"),
    JSON.stringify({ agent: "showrunner", model: "opus", effort: "max", startedAt: "2026-07-18T08:00:00.000Z", endedAt: "2026-07-18T08:01:00.000Z", durationSeconds: 60, exitCode: 0, timedOut: false, noop: false, keystoneEscalated: false }) + "\n");

  const instDry = run(process.execPath, [instCli, "run", "--dry-run", "--project", "demo"], { cwd: ws });
  ok(instDry.code === 0 && instDry.out.includes("wl-run --dry-run")
    && instDry.out.includes("claude") && instDry.out.includes("/writing-loop:showrunner-agent")
    && instDry.out.includes("KEYSTONE 升档中"),
    "装机形 run --dry-run → 内建调度器渲染 claude 命令 + keystone 升档谓词读到板（包根插件负载解析成功）");
  const instInline = run(process.execPath, [instCli, "run", "--dry-run", "--project", "demo", "--cli", "opencode"], { cwd: ws });
  ok(instInline.code === 0 && instInline.out.includes("opencode run") && instInline.out.includes("【writing-loop 调度器上下文】"),
    "装机形 run --dry-run --cli opencode → 从包根 skills/ 组装 inline prompt（无仓库兄弟目录可回退）");
  const instStatus = run(process.execPath, [instCli, "status", "--project", "demo"], { cwd: ws });
  ok(instStatus.code === 0 && instStatus.out.includes("WL-1") && instStatus.out.includes("ep-003"),
    "装机形 status → 板/前沿可读");
  const instFires = run(process.execPath, [instCli, "fires", "--project", "demo"], { cwd: ws });
  ok(instFires.code === 0 && instFires.out.includes("showrunner"), "装机形 fires → 遥测尾巴可读");
  const instSnapshot = run(process.execPath, [instCli, "snapshot", "--project", "demo", "--compact"], { cwd: ws });
  ok(instSnapshot.code === 0 && instSnapshot.out.includes('{"schemaVersion":1,"generatedAt":')
    && instSnapshot.out.includes('"project":{"key":"demo"') && instSnapshot.out.includes('"frontier":3'),
  "装机形 snapshot → 与 HTTP 相同的 versioned 项目 envelope 可读");
  const instProjects = run(process.execPath, [instCli, "project", "list", "--json"], { cwd: ws });
  ok(instProjects.code === 0 && instProjects.out.includes('"key": "demo"'), "装机形 project list → 多项目管理入口可读");
  const instWorkspaceAdd = run(process.execPath, [instCli, "workspace", "add", ws, "--label", "装机冒烟编剧室"], {
    cwd: ws, env: { WRITING_LOOP_HOME: machineHome },
  });
  const installedWorkspaceId = /registered (ws_[a-f0-9]{32})/.exec(instWorkspaceAdd.stdout)?.[1] ?? "";
  const instWorkspaceList = run(process.execPath, [instCli, "workspace", "list", "--json"], {
    cwd: ws, env: { WRITING_LOOP_HOME: machineHome },
  });
  const installedRegistry = parseJson<{ entries?: Array<{ id?: string; root?: string; status?: string }> }>(instWorkspaceList.stdout);
  ok(instWorkspaceAdd.code === 0 && instWorkspaceList.code === 0
    && installedRegistry?.entries?.some((entry) => entry.id === installedWorkspaceId && entry.root === ws && entry.status === "ok") === true,
  "装机形 workspace add/list → 发布包创建稳定 identity 并读取隔离的本机 registry");
  const instProduction = run(process.execPath, [instCli, "production", "status", "--project", "demo", "--json"], { cwd: ws });
  const installedProduction = parseJson<{ workspace?: { id?: string }; projects?: Array<{ production?: { revision?: number; tasks?: unknown[] } }> }>(instProduction.stdout);
  ok(instProduction.code === 0 && installedProduction?.workspace?.id === installedWorkspaceId
    && installedProduction.projects?.[0]?.production?.revision === 0
    && installedProduction.projects[0].production?.tasks?.length === 0,
  "装机形 production status → 发布包只读本地权威账本，missing state 明确为空 v1");

  const approvedAt = "2026-07-18T08:02:00.000Z";
  writeFileSync(join(proj, "production-state.v1.json"), JSON.stringify({
    version: 1,
    workspaceId: installedWorkspaceId,
    project: "demo",
    revision: 7,
    updatedAt: approvedAt,
    tasks: [{
      version: 1,
      id: "take-installed-001",
      idempotencyKey: "idem-installed-001",
      subject: {
        version: 1,
        kind: "shot",
        shot: {
          version: 1,
          episode: {
            version: 1,
            episodeId: "ep-003",
            revision: 1,
            source: {
              version: 1,
              uri: "s3://writing-loop-assets/demo/ep-003.md",
              sha256: "a".repeat(64),
              byteLength: 9,
              mediaType: "text/markdown",
            },
          },
          shotId: "shot-001",
          revision: 1,
          source: {
            version: 1,
            uri: "s3://writing-loop-assets/demo/shot-001.json",
            sha256: "b".repeat(64),
            byteLength: 42,
            mediaType: "application/json",
          },
        },
      },
      status: "approved",
      revision: 7,
      createdAt: "2026-07-18T08:00:00.000Z",
      updatedAt: approvedAt,
      backendInstanceId: "comfy-installed",
      remoteJobId: "11111111-1111-4111-8111-111111111111",
      submissionOutbox: {
        version: 1,
        requestDigest: "c".repeat(64),
        preparedAt: "2026-07-18T08:00:10.000Z",
        state: "acknowledged",
      },
      cancellationRequest: null,
      cancellationConfirmation: null,
      assets: [{
        version: 1,
        uri: "s3://writing-loop-assets/demo/take-installed-001.mp4",
        sha256: "d".repeat(64),
        byteLength: 4_200,
        mediaType: "video/mp4",
      }],
      cost: { version: 1, state: "known", currency: "USD", amountMicros: 800_000, basis: "reported" },
      approval: {
        version: 1,
        decision: "approved",
        taskRevision: 6,
        subjectRevision: 1,
        decidedAt: approvedAt,
        decidedBy: "director",
        note: "picture lock",
      },
      statusMessage: null,
      eventReceipts: Array.from({ length: 6 }, (_, index) => ({
        version: 1,
        eventId: `installed-event-${index + 1}`,
        payloadDigest: String(index + 1).repeat(64),
      })),
    }],
  }, null, 2) + "\n");
  const installedHandoffInput = join(ws, "handoff-installed.json");
  writeFileSync(installedHandoffInput, JSON.stringify({
    version: 1,
    handoffId: "handoff-installed-001",
    studioProjectId: "demo-episode-003",
    pipeline: "cinematic",
    createdAt: "2026-07-18T08:03:00.000Z",
    delivery: {
      version: 1,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 24,
      container: "video/mp4",
      language: "zh-CN",
    },
    taskIds: ["take-installed-001"],
  }, null, 2));
  const instHandoff = run(process.execPath, [
    instCli, "production", "handoff", "--project", "demo", "--input", installedHandoffInput,
  ], { cwd: ws });
  const installedHandoff = parseJson<{
    digestAlgorithm?: string;
    digest?: string;
    handoff?: { contract?: string; takes?: Array<{ taskId?: string }>; requiresAgentOrchestration?: boolean };
  }>(instHandoff.stdout);
  ok(instHandoff.code === 0
    && installedHandoff?.digestAlgorithm === "sha256:writing-loop-canonical-json-v1"
    && /^[a-f0-9]{64}$/.test(installedHandoff.digest ?? "")
    && installedHandoff.handoff?.contract === "citronetic-video-creation-studio-codex-handoff-v1"
    && installedHandoff.handoff.requiresAgentOrchestration === true
    && installedHandoff.handoff.takes?.[0]?.taskId === "take-installed-001",
  `装机形 production handoff → 编译包导出 approved take + canonical digest${instHandoff.code !== 0 ? `：${instHandoff.out.slice(-400)}` : ""}`);

  // 真实 CLI 的 plan → confirm/create → verify；隔离 global/system git config，确保 scaffold
  // commit 只依赖 onboarding 自带的命令级 user.name/user.email，而不偷用测试机身份。
  const onboardingInputFile = join(ws, "onboarding-request.json");
  writeFileSync(onboardingInputFile, JSON.stringify({
    key: "cli-smoke",
    title: "装机立项冒烟剧",
    repoPath: "cli-smoke-repo",
    kind: "original",
    logline: "落魄编剧发现她写下的每一场戏都会在现实中成真。",
    audience: "女性 25-40 岁，一二线城市付费用户",
    complianceNotes: "不涉政；违法行为有后果；遵守平台内容政策。",
    nonGoals: ["不借用未授权 IP"],
    genre: "revenge-slap",
    monetization: "paid-app",
    format: "live-action",
    totalEpisodes: 80,
    paywall: { card1: [9, 10, 11], card2: [26, 28, 30], card3: [60] },
    episodeWordBand: [900, 1300],
    maxPrimaryScenes: 5,
    maxNamedCharacters: 20,
    ticketPrefix: "CLI",
    intakeMode: "autonomous",
    mode: "live",
    comparables: "公开短剧结构对标",
    differentiation: "以改写戏剧因果作为反制机制",
  }, null, 2));
  const instPlan = run(process.execPath, [instCli, "project", "plan", "--input", onboardingInputFile], { cwd: ws });
  const planned = parseJson<{ planId?: string; kind?: string; requiresConfirmation?: boolean; outlineTicket?: { id?: string } }>(instPlan.stdout);
  ok(instPlan.code === 0 && planned?.kind === "writing-loop/onboarding-plan"
    && planned.requiresConfirmation === true && planned.outlineTicket?.id === "CLI-1" && !existsSync(join(ws, "cli-smoke-repo")),
  "装机形 project plan --input → 返回确认指纹且严格零写");

  const emptyGitConfig = join(tmp, "empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
  const isolatedGit: RunOptions = {
    cwd: ws,
    env: { GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: "1" },
    unsetEnv: [
      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "EMAIL",
    ],
  };
  const instCreate = run(process.execPath, [
    instCli, "project", "create", "--input", onboardingInputFile,
    "--confirm", planned?.planId ?? "missing-plan-id", "--json",
  ], isolatedGit);
  const created = parseJson<{ key?: string; commit?: string; outlineTicketId?: string; verification?: { ok?: boolean } }>(instCreate.stdout);
  ok(instCreate.code === 0 && created?.key === "cli-smoke" && created.outlineTicketId === "CLI-1"
    && /^[0-9a-f]{40,64}$/i.test(created.commit ?? "") && created.verification?.ok === true
    && existsSync(join(ws, "cli-smoke-repo", ".git"))
    && existsSync(join(ws, ".writing-loop", "cli-smoke", "board", "tickets", "CLI-1.md")),
  `装机形 project create --input --confirm → 无全局 Git 身份仍原子发布三处 ground truth${instCreate.code !== 0 ? `：${instCreate.out.slice(-400)}` : ""}`);

  const instVerify = run(process.execPath, [instCli, "project", "verify", "cli-smoke", "--json"], { cwd: ws });
  const verified = parseJson<{ project?: string; ok?: boolean; checks?: Array<{ ok?: boolean }> }>(instVerify.stdout);
  ok(instVerify.code === 0 && verified?.project === "cli-smoke" && verified.ok === true
    && verified.checks?.every((check) => check.ok === true) === true,
  "装机形 project verify KEY → 独立核验 repo / Git / 首票 / runtime layout");
  const instDoctor = run(process.execPath, [instCli, "doctor"], { cwd: ws, env: { WRITING_LOOP_HOME: machineHome } });
  ok(instDoctor.code === 0 && instDoctor.out.includes("WRITING_LOOP_DOCTOR_OK") && instDoctor.out.includes("NEXT:"),
    `装机形 doctor → DOCTOR_OK + NEXT:（暖警告不失败）${instDoctor.code !== 0 ? `：${instDoctor.out.slice(-400)}` : ""}`);
  ok(!instDoctor.out.includes("python"), "doctor 输出无任何 python 检查（调度器已原生化）");

  const mktDir = join(tmp, "claude-marketplace");
  const instMkt = run(process.execPath, [instCli, "install-claude-plugin", "--dest", mktDir], { cwd: ws });
  const mktFile = join(mktDir, ".claude-plugin", "marketplace.json");
  const mkt = existsSync(mktFile) ? JSON.parse(readFileSync(mktFile, "utf8")) as { plugins?: Array<{ source?: { source?: string; package?: string; version?: string } }> } : null;
  ok(instMkt.code === 0
    && mkt?.plugins?.[0]?.source?.source === "npm"
    && mkt?.plugins?.[0]?.source?.package === "@dyzsasd/writing-loop"
    && mkt?.plugins?.[0]?.source?.version === pkgVersion,
    "装机形 install-claude-plugin → 写 npm-source marketplace.json 且版本钉住本 CLI");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nBUILD_ARTIFACT_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
