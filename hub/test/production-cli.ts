// Production CLI: read surfaces plus crash-safe, zero-network local enqueue.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionMain } from "../src/production.ts";
import { readRegularTextExact } from "../src/bounded-fs.ts";
import { ProductionCoordinatorStore } from "../src/production-coordinator-store.ts";
import { parseProductionTaskEvent, type ProductionTaskEvent } from "../src/production-domain.ts";
import {
  MAX_PRODUCTION_STATE_BYTES,
  ProductionStore,
  productionStatePath,
  readProductionState,
} from "../src/production-store.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};

function capture(args: string[], cwd: string): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...values: unknown[]) => { out.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { err.push(values.map(String).join(" ")); };
  try { return { code: productionMain(args, cwd), out: out.join("\n"), err: err.join("\n") }; }
  finally { console.log = oldLog; console.error = oldError; }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-production-cli-")));
const workspaceId = `ws_${"a".repeat(32)}`;
try {
  const data = join(root, ".writing-loop");
  mkdirSync(join(data, "demo"), { recursive: true });
  writeFileSync(join(data, "workspace.json"), JSON.stringify({ version: 1, id: workspaceId }, null, 2) + "\n");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "暂停制片剧", repoPath: "repo", enabled: false } },
  }, null, 2) + "\n");
  mkdirSync(join(root, "repo"));

  const store = new ProductionStore(root, workspaceId, "demo");
  store.create({
    version: 1,
    id: "take-cli-001",
    idempotencyKey: "idem-cli-001",
    subject: {
      version: 1,
      kind: "episode",
      episode: {
        version: 1,
        episodeId: "ep-001",
        revision: 2,
        source: {
          version: 1,
          uri: "s3://writing-loop-assets/demo/episode-001.md",
          sha256: "a".repeat(64),
          byteLength: 12,
          mediaType: "text/markdown",
        },
      },
    },
    createdAt: "2026-08-10T12:00:00.000Z",
  });
  const estimatedState = store.read();
  estimatedState.tasks[0]!.cost = {
    version: 1, state: "known", currency: "USD", amountMicros: 3_500_000, basis: "estimated",
  };
  writeFileSync(productionStatePath(root, "demo"), JSON.stringify(estimatedState, null, 2) + "\n");
  const coordinatorStore = new ProductionCoordinatorStore(root, workspaceId, "demo");
  const reservedControl = {
    version: 1 as const,
    taskId: "take-cli-001",
    observedTaskRevision: 1,
    budgetReservation: {
      version: 1 as const,
      state: "reserved" as const,
      currency: "USD" as const,
      reservedAmountMicros: 3_500_000,
      reservedAt: "2026-08-10T12:00:00.000Z",
      exposedAt: null,
      releasedAt: null,
    },
    retryState: { version: 1 as const, attempt: 0, notBefore: null, lastFailure: null },
    cancelAttempt: null,
    lastObservation: null,
    pendingEvent: null,
  };
  coordinatorStore.put({
    expectedRevision: 0,
    updatedAt: "2026-08-10T12:00:00.000Z",
    task: reservedControl,
  });
  coordinatorStore.put({
    expectedRevision: 1,
    updatedAt: "2026-08-10T12:00:01.000Z",
    task: {
      ...reservedControl,
      budgetReservation: {
        ...reservedControl.budgetReservation,
        state: "exposed" as const,
        exposedAt: "2026-08-10T12:00:01.000Z",
      },
    },
  });

  const text = capture(["status", "--project", "demo"], root);
  ok(text.code === 0 && text.out.includes("demo [paused] 暂停制片剧")
    && text.out.includes("take-cli-001")
    && text.out.includes("1 项实际成本未知；估算 $3.50（1 项）")
    && text.out.includes("control r2") && text.out.includes("敞口 $3.50"),
  "production status 可读取暂停项目，并把 estimated/actual/control exposure 明确分栏");

  const jsonResult = capture(["status", "--json"], root);
  const payload = JSON.parse(jsonResult.out) as {
    version?: number;
    workspace?: { id?: string; root?: string };
    projects?: Array<{
      enabled?: boolean;
      production?: { revision?: number; tasks?: unknown[] };
      coordinator?: { revision?: number; summary?: { budget?: { exposedAmountMicros?: number } } };
    }>;
  };
  ok(jsonResult.code === 0 && payload.version === 1 && payload.workspace?.id === workspaceId
    && payload.workspace.root === root && payload.projects?.[0].enabled === false
    && payload.projects[0].production?.revision === 1 && payload.projects[0].production?.tasks?.length === 1
    && payload.projects[0].coordinator?.revision === 2
    && payload.projects[0].coordinator?.summary?.budget?.exposedAmountMicros === 3_500_000,
  "--json 输出稳定 ledger + coordinator control read-model envelope");

  const help = capture(["--help"], join(root, "repo"));
  ok(help.code === 0 && help.out.includes("不会连接 ComfyUI、H3"),
    "production help 无需读取 workspace，明确命令是本地只读面");
  const badArgs = capture(["status", "--remote-url", "http://evil.test"], root);
  ok(badArgs.code === 2 && badArgs.err.includes("未知参数") && badArgs.out.includes("只读取"),
    "CLI 拒绝让操作者从命令行注入任意 remote endpoint");
  const missing = capture(["status", "--project", "ghost"], root);
  ok(missing.code === 1 && missing.err.includes("没有项目 'ghost'"), "未知项目返回运行错误而非空成功");

  const dispatched = spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "production", "status", "--project", "demo", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  ok(dispatched.status === 0 && JSON.parse(dispatched.stdout).projects[0].production.tasks.length === 1,
    "顶层 writing-loop dispatcher 正确路由 production 子命令");

  store.create({
    version: 1,
    id: "take-handoff-001",
    idempotencyKey: "idem-handoff-001",
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "ep-001",
          revision: 2,
          source: {
            version: 1,
            uri: "s3://writing-loop-assets/demo/episode-001.md",
            sha256: "a".repeat(64),
            byteLength: 12,
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
    createdAt: "2026-08-10T12:10:00.000Z",
  });
  const handoffEvent = (
    type: ProductionTaskEvent["type"],
    second: number,
    extra: Record<string, unknown> = {},
  ): void => {
    const task = store.read().tasks.find((row) => row.id === "take-handoff-001")!;
    store.apply(parseProductionTaskEvent({
      version: 1,
      type,
      eventId: `cli-handoff-${task.revision}-${type}`,
      taskId: task.id,
      expectedRevision: task.revision,
      occurredAt: `2026-08-10T12:10:${String(second).padStart(2, "0")}.000Z`,
      ...extra,
    }));
  };
  const remoteJobId = "11111111-1111-4111-8111-111111111111";
  handoffEvent("dispatch-requested", 1);
  handoffEvent("submission-started", 2, {
    backendInstanceId: "comfy-prod", remoteJobId, requestDigest: "c".repeat(64),
  });
  handoffEvent("submission-confirmed", 3, { backendInstanceId: "comfy-prod", remoteJobId });
  handoffEvent("ingestion-started", 4);
  handoffEvent("qc-requested", 5, {
    assets: [{
      version: 1,
      uri: "s3://writing-loop-assets/demo/take-handoff-001.mp4",
      sha256: "d".repeat(64),
      byteLength: 4_200,
      mediaType: "video/mp4",
    }],
    cost: { version: 1, state: "known", currency: "USD", amountMicros: 800_000, basis: "reported" },
  });
  handoffEvent("approved", 6, { decidedBy: "director", note: "picture lock" });
  const handoffInput = join(root, "handoff.json");
  writeFileSync(handoffInput, JSON.stringify({
    version: 1,
    handoffId: "handoff-cli-001",
    studioProjectId: "demo-episode-001",
    pipeline: "cinematic",
    createdAt: "2026-08-10T12:11:00.000Z",
    delivery: {
      version: 1,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 24,
      container: "video/mp4",
      language: "zh-CN",
    },
    taskIds: ["take-handoff-001"],
  }, null, 2));
  const handoffResult = capture(["handoff", "--project", "demo", "--input", handoffInput], root);
  const handoffPayload = JSON.parse(handoffResult.out) as {
    digestAlgorithm?: string;
    digest?: string;
    handoff?: { contract?: string; requiresAgentOrchestration?: boolean; takes?: Array<{ taskId?: string }> };
  };
  ok(handoffResult.code === 0 && /^[a-f0-9]{64}$/.test(handoffPayload.digest ?? "")
    && handoffPayload.digestAlgorithm === "sha256:writing-loop-canonical-json-v1"
    && handoffPayload.handoff?.contract === "citronetic-video-creation-studio-codex-handoff-v1"
    && handoffPayload.handoff.requiresAgentOrchestration === true
    && handoffPayload.handoff.takes?.[0]?.taskId === "take-handoff-001",
  "production handoff 只把人工 approved take 输出为带 digest 的 agent-orchestrated Studio 清单");

  const largeHandoffInput = join(root, "handoff-large.json");
  const largeTaskIds = Array.from({ length: 2_048 }, (_, index) =>
    `take-${String(index).padStart(4, "0")}-`.padEnd(128, "x"));
  const largeHandoffText = JSON.stringify({
    version: 1,
    handoffId: "handoff-cli-large",
    studioProjectId: "demo-episode-001",
    pipeline: "cinematic",
    createdAt: "2026-08-10T12:12:00.000Z",
    delivery: {
      version: 1,
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 24,
      container: "video/mp4",
      language: "zh-CN",
    },
    taskIds: largeTaskIds,
  });
  writeFileSync(largeHandoffInput, largeHandoffText);
  const largeHandoff = capture(["handoff", "--project", "demo", "--input", largeHandoffInput], root);
  ok(Buffer.byteLength(largeHandoffText) > 256 * 1024
    && Buffer.byteLength(largeHandoffText) <= MAX_PRODUCTION_STATE_BYTES
    && largeHandoff.code === 1 && largeHandoff.err.includes("不存在")
    && !largeHandoff.err.includes("bytes、读取期间不变"),
  "schema 上限内且超过 256 KiB 的 handoff input 可完整读取，并进入 task 语义校验");

  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "暂停制片剧", repoPath: "repo", enabled: true } },
  }, null, 2) + "\n");
  const enqueueInput = join(root, "enqueue.json");
  const enqueueAsset = (name: string, digest: string) => ({
    version: 1,
    uri: `s3://writing-loop-assets/demo/${name}`,
    sha256: digest,
    byteLength: 100,
    mediaType: "application/json",
  });
  writeFileSync(enqueueInput, JSON.stringify({
    version: 1,
    taskId: "take-cli-enqueue",
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "ep-001",
          revision: 2,
          source: enqueueAsset("episode.json", "4".repeat(64)),
        },
        shotId: "shot-002",
        revision: 1,
        source: enqueueAsset("shot-002.json", "5".repeat(64)),
      },
    },
    createdAt: "2026-08-10T12:20:00.000Z",
    useTerritories: ["CN"],
    execution: {
      version: 1,
      operation: "comfyui-workflow",
      modelFamily: "generic",
      backendInstanceId: "comfy-primary",
      workflowSha256: "6".repeat(64),
      modelSha256: "7".repeat(64),
      parametersSha256: "8".repeat(64),
    },
    inputs: [enqueueAsset("shot-002.json", "5".repeat(64))],
    budget: {
      version: 1, currency: "USD", estimatedAmountMicros: 1_000_000, maximumAmountMicros: 2_000_000,
    },
    rights: {
      version: 1, status: "cleared", territories: ["CN"],
      evidence: enqueueAsset("rights.json", "9".repeat(64)), expiresAt: null,
    },
    moderation: {
      version: 1, status: "passed", reviewedAt: "2026-08-10T12:15:00.000Z",
      evidence: enqueueAsset("moderation.json", "a".repeat(64)),
    },
    license: {
      version: 1,
      status: "verified",
      basis: "community",
      territories: ["CN"],
      licenseSha256: "b".repeat(64),
      evidence: enqueueAsset("license.json", "c".repeat(64)),
      issuedBy: "model-owner",
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    },
  }, null, 2));
  const stateBeforePlan = readProductionState(root, workspaceId, "demo");
  const enqueuePlan = capture([
    "enqueue", "--plan", "--project", "demo", "--input", enqueueInput, "--json",
  ], root);
  const planPayload = JSON.parse(enqueuePlan.out) as { mode?: string; planId?: string; taskId?: string };
  const stateAfterPlan = readProductionState(root, workspaceId, "demo");
  ok(enqueuePlan.code === 0 && planPayload.mode === "plan"
    && /^[a-f0-9]{64}$/.test(planPayload.planId ?? "")
    && planPayload.taskId === "take-cli-enqueue"
    && stateAfterPlan.revision === stateBeforePlan.revision
    && !stateAfterPlan.tasks.some((task) => task.id === "take-cli-enqueue"),
  "production enqueue --plan 返回 scope-bound 确认指纹且严格零写入");
  const missingConfirmation = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput,
  ], root);
  ok(missingConfirmation.code === 2 && missingConfirmation.err.includes("--plan 或 --confirm")
    && readProductionState(root, workspaceId, "demo").revision === stateBeforePlan.revision,
  "production enqueue 拒绝未显式选择 plan/confirm 的间接计费写入");
  const wrongConfirmation = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput, "--confirm", "0".repeat(64),
  ], root);
  ok(wrongConfirmation.code === 1 && wrongConfirmation.err.includes("确认指纹不匹配")
    && readProductionState(root, workspaceId, "demo").revision === stateBeforePlan.revision,
  "production enqueue 在本地 intent 发布前拒绝错误确认指纹");
  const enqueueResult = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput,
    "--confirm", planPayload.planId ?? "", "--json",
  ], root);
  const enqueuePayload = JSON.parse(enqueueResult.out) as {
    intentCreated?: boolean; taskCreated?: boolean; dispatchApplied?: boolean;
    task?: { id?: string; status?: string; remoteJobId?: string | null };
    state?: { revision?: number };
  };
  ok(enqueueResult.code === 0 && enqueuePayload.intentCreated === true
    && enqueuePayload.taskCreated === true && enqueuePayload.dispatchApplied === true
    && enqueuePayload.task?.id === "take-cli-enqueue"
    && enqueuePayload.task.status === "dispatch-pending" && enqueuePayload.task.remoteJobId === null,
  "production enqueue 只发布本地 immutable intent/task/dispatch，尚无 remote side effect");
  const enqueueReplay = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput,
    "--confirm", planPayload.planId ?? "", "--json",
  ], root);
  const replayPayload = JSON.parse(enqueueReplay.out) as typeof enqueuePayload;
  ok(enqueueReplay.code === 0 && replayPayload.intentCreated === false
    && replayPayload.taskCreated === false && replayPayload.dispatchApplied === false
    && replayPayload.state?.revision === enqueuePayload.state?.revision,
  "production enqueue 精确重试不增加权威 revision");
  const enqueueEndpointInjection = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput,
    "--confirm", planPayload.planId ?? "", "--remote-url", "http://evil.test",
  ], root);
  ok(enqueueEndpointInjection.code === 2 && enqueueEndpointInjection.err.includes("未知参数"),
    "production enqueue 不接受 endpoint/token 注入参数");
  ok(!enqueueEndpointInjection.err.includes("evil.test"),
    "production enqueue usage error 不回显可能携带 token/URL 的原始 argv");
  const secretAction = capture(["SUPER_SECRET_ACTION_CANARY"], root);
  ok(secretAction.code === 2 && secretAction.err.includes("未知操作")
    && !secretAction.err.includes("SUPER_SECRET_ACTION_CANARY"),
  "production 未知 action 不向 stderr 回显可能的 credential");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1,
    projects: { demo: { title: "暂停制片剧", repoPath: "repo", enabled: false } },
  }, null, 2) + "\n");
  const pausedEnqueue = capture([
    "enqueue", "--project", "demo", "--input", enqueueInput, "--confirm", planPayload.planId ?? "",
  ], root);
  ok(pausedEnqueue.code === 1 && pausedEnqueue.err.includes("已暂停"),
    "暂停项目拒绝新增 dispatch intent");

  const mutableInput = join(root, "handoff-mutable.json");
  writeFileSync(mutableInput, "{\"version\":1}");
  ok(readRegularTextExact(mutableInput, MAX_PRODUCTION_STATE_BYTES, {
    afterRead: () => writeFileSync(mutableInput, "{\"version\":2,\"changed\":true}"),
  }) === null,
  "handoff exact reader 拒绝同 inode 在读取决策窗口内被并发改写");

  writeFileSync(productionStatePath(root, "demo"), "{broken");
  const corrupt = capture(["status", "--project", "demo"], root);
  ok(corrupt.code === 1 && /JSON|损坏/.test(corrupt.err),
    "CLI 对损坏的权威 production state 硬错，不显示伪造空状态");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nPRODUCTION_CLI_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
