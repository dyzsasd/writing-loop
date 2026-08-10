import {
  parseProductionTaskEvent,
  type AssetRef,
  type ProductionTaskEvent,
} from "../src/production-domain.ts";
import { ProductionStore } from "../src/production-store.ts";
import {
  buildVideoStudioHandoff,
  videoStudioHandoffCanonicalJson,
  parseVideoStudioHandoffCreate,
  videoStudioHandoffDigest,
} from "../src/production-studio-handoff.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throws = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; } catch (error) { return error instanceof Error && error.message.includes(needle); }
};

const WS = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const at = (second: number): string => `2026-08-10T15:00:${String(second).padStart(2, "0")}.000Z`;
const asset = (uri: string, sha256: string, mediaType = "application/json"): AssetRef => ({
  version: 1, uri, sha256, byteLength: 42, mediaType,
});

const root = mkdtempSync(join(tmpdir(), "writing-loop-studio-handoff-"));
mkdirSync(join(root, ".writing-loop", "demo"), { recursive: true });
const store = new ProductionStore(root, WS, "demo");

function createTake(id: string, shotId: string, createdAt: string): void {
  store.create({
    version: 1,
    id,
    idempotencyKey: `idem-${id}`,
    createdAt,
    subject: {
      version: 1,
      kind: "shot",
      shot: {
        version: 1,
        episode: {
          version: 1,
          episodeId: "ep-001",
          revision: 2,
          source: asset("s3://writing-loop-assets/demo/episode-001.json", SHA_A),
        },
        shotId,
        revision: 1,
        source: asset(`s3://writing-loop-assets/demo/${shotId}.json`, SHA_B),
      },
    },
  });
}

function apply(id: string, type: ProductionTaskEvent["type"], second: number, extra: Record<string, unknown> = {}): void {
  const task = store.read().tasks.find((item) => item.id === id)!;
  store.apply(parseProductionTaskEvent({
    version: 1,
    type,
    eventId: `${id}-${task.revision}-${type}`,
    taskId: id,
    expectedRevision: task.revision,
    occurredAt: at(second),
    ...extra,
  }));
}

function approve(id: string, second: number): void {
  apply(id, "dispatch-requested", second);
  apply(id, "submission-started", second + 1, {
    backendInstanceId: "comfy-prod",
    remoteJobId: id === "take-a"
      ? "11111111-1111-4111-8111-111111111111"
      : id === "take-b"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
    requestDigest: SHA_A,
  });
  const remoteJobId = store.read().tasks.find((task) => task.id === id)!.remoteJobId;
  apply(id, "submission-confirmed", second + 2, { backendInstanceId: "comfy-prod", remoteJobId });
  apply(id, "ingestion-started", second + 3);
  apply(id, "qc-requested", second + 4, {
    assets: [asset(`s3://writing-loop-assets/demo/${id}.mp4`, id === "take-a" ? SHA_A : SHA_B, "video/mp4")],
    cost: { version: 1, state: "known", currency: "USD", amountMicros: 500_000, basis: "reported" },
  });
  apply(id, "approved", second + 5, { decidedBy: "director", note: "approved take" });
}

createTake("take-b", "shot-002", at(0));
createTake("take-a", "shot-001", at(1));
approve("take-a", 2);
approve("take-b", 9);

const create = {
  version: 1 as const,
  handoffId: "handoff-001",
  studioProjectId: "demo-episode-001",
  pipeline: "cinematic" as const,
  createdAt: at(20),
  delivery: {
    version: 1 as const,
    aspectRatio: "9:16" as const,
    width: 1080,
    height: 1920,
    fps: 24 as const,
    container: "video/mp4" as const,
    language: "zh-CN",
  },
  taskIds: ["take-b", "take-a"],
};
const handoff = buildVideoStudioHandoff(store.read(), create);
ok(handoff.takes.map((take) => take.shot.shotId).join(",") === "shot-001,shot-002"
  && handoff.requiresAgentOrchestration === true,
"handoff 只含 approved take、按稳定 shotId 排序并明确仍需 Studio agent 编排");
ok(videoStudioHandoffDigest(handoff) === videoStudioHandoffDigest(buildVideoStudioHandoff(store.read(), create)),
"相同权威 revision 与 create 产生稳定 handoff digest");
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse()
    .map(([key, item]) => [key, reverseKeys(item)]));
};
const reorderedHandoff = reverseKeys(handoff);
ok(videoStudioHandoffDigest(reorderedHandoff) === videoStudioHandoffDigest(handoff)
  && videoStudioHandoffCanonicalJson(reorderedHandoff) === videoStudioHandoffCanonicalJson(handoff),
"handoff digest 采用跨 repo 可复核的递归稳定键序，不受 JSON 解析后的 deep key order 影响");
ok(handoff.takes.every((take) => take.assets.every((item) => item.uri.startsWith("s3://"))),
"handoff 只传 stable AssetRef，不传本机或临时 provider URL");

createTake("take-pending", "shot-003", at(20));
ok(throws(() => buildVideoStudioHandoff(store.read(), { ...create, taskIds: ["take-pending"] }), "尚未 approved"),
"未经过人工 QC approval 的 take 不能导出到视频 Studio");

ok(throws(() => parseVideoStudioHandoffCreate({
  ...create,
  studioProjectId: "../escape",
}), "kebab-case"), "Studio project id 拒绝路径穿越");
ok(throws(() => parseVideoStudioHandoffCreate({
  ...create,
  delivery: { ...create.delivery, width: 1920, height: 1080 },
}), "不一致"), "delivery 尺寸必须与竖屏 aspect ratio 一致");
ok(throws(() => parseVideoStudioHandoffCreate({
  ...create,
  remoteUrl: "https://studio.example/api",
}), "未知字段"), "handoff create 不接受浏览器/调用方注入远程 Studio endpoint");
ok(throws(() => buildVideoStudioHandoff(store.read(), { ...create, createdAt: at(10) }), "不得早于"),
  "handoff createdAt 不得伪装成早于所绑定 production revision/QC 的历史清单");

createTake("take-duplicate", "shot-001", at(21));
approve("take-duplicate", 22);
ok(throws(() => buildVideoStudioHandoff(store.read(), { ...create, createdAt: at(30), taskIds: ["take-a", "take-duplicate"] }), "重复 shotId"),
"同一 handoff 不允许两个 approved take 冒充同一镜头的唯一裁定");

if (fails) {
  console.error(`PRODUCTION_STUDIO_HANDOFF_FAILED ${fails}`);
  process.exit(1);
}
console.log("\nPRODUCTION_STUDIO_HANDOFF_OK");
