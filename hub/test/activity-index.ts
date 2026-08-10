// Persistent activity index: restart-stable cursors, incremental merge, bounded retention and
// hostile-filesystem/atomic-write safety.
import {
  appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ActivityIndexer } from "../src/activity-index.ts";
import { loadConfig, WsError } from "../src/workspace.ts";

let fails = 0;
const ok = (condition: boolean, message: string): void => {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) fails++;
};
const throwsWs = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false; }
  catch (error) { return error instanceof WsError && error.message.includes(needle); }
};
const event = (id: string, type: "project.created" | "project.paused" | "project.resumed", minute: number): string => JSON.stringify({
  id, type, at: `2026-08-10T10:${String(minute).padStart(2, "0")}:00.000Z`, actor: "operator", title: id, detail: id,
});

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wl-activity-index-")));
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
try {
  const data = join(tmp, ".writing-loop");
  const projectData = join(data, "demo");
  const repo = join(tmp, "repo");
  mkdirSync(join(projectData, "board", "tickets"), { recursive: true });
  mkdirSync(join(projectData, "reports"), { recursive: true });
  mkdirSync(join(repo, "episodes"), { recursive: true });
  mkdirSync(join(repo, "evaluation"), { recursive: true });
  mkdirSync(join(repo, "bible"), { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    version: 1, projects: { demo: { title: "Index", repoPath: "repo", enabled: true } },
  }));
  const ledger = join(projectData, "events.jsonl");
  const fallbackLedgerRow = JSON.stringify({
    type: "project.created", at: "2026-08-10T10:00:00.000Z", actor: "operator", title: "fallback", detail: "no producer id",
  });
  writeFileSync(ledger, `${fallbackLedgerRow}\n${event("e1", "project.created", 1)}\n${event("e2", "project.paused", 2)}\n${event("e3", "project.resumed", 3)}\n`);
  const ws = loadConfig(tmp);

  let deepScans = 0;
  const firstIndexer = new ActivityIndexer(ws, { hooks: { beforeDeepScan: () => { deepScans++; } } });
  const first = firstIndexer.buildPage("ws-main", "demo", { limit: 1, nowMs: NOW });
  const indexFile = join(projectData, "activity-index.v2.json");
  ok(first.schemaVersion === 2 && first.items[0]?.id === "e3" && deepScans === 1, "首次调用从现有 bounded activity scan bootstrap v2 index");
  ok(Boolean(first.nextBeforeCursor) && first.sseCursor !== first.nextBeforeCursor, "before cursor 与 SSE cursor 使用独立协议");

  const restarted = new ActivityIndexer(ws, { hooks: { beforeDeepScan: () => { deepScans++; } } });
  const restartPage = restarted.buildPage("ws-main", "demo", { limit: 1, nowMs: NOW });
  ok(restartPage.generation === first.generation && restartPage.revision === first.revision
    && restartPage.nextBeforeCursor === first.nextBeforeCursor && deepScans === 1,
  "重启读取持久 generation/revision，源未变时跳过深扫且 cursor 不漂移");
  const idleLock = join(projectData, ".activity-index.v2.lock");
  writeFileSync(idleLock, "another unchanged observer\n");
  const unchangedWhileLocked = restarted.buildPage("ws-main", "demo", { limit: 1, nowMs: NOW });
  ok(unchangedWhileLocked.revision === restartPage.revision && readFileSync(idleLock, "utf8") === "another unchanged observer\n"
    && deepScans === 1, "源未变化的 SSE/页面轮询走无写 fast path，不争抢或改写 activity lock");
  unlinkSync(idleLock);

  appendFileSync(ledger, `${event("e4", "project.paused", 4)}\n`);
  const appended = restarted.buildPage("ws-main", "demo", { limit: 10, nowMs: NOW });
  const appendedAgain = restarted.buildPage("ws-main", "demo", { limit: 10, nowMs: NOW });
  ok(appended.items.filter((row) => row.id === "e4").length === 1
    && appendedAgain.items.filter((row) => row.id === "e4").length === 1
    && appendedAgain.revision === appended.revision && deepScans === 2,
  "append 事件按稳定 id 幂等 merge；重复 refresh 不重复事件或 revision");

  const beforeLedgerRotation = appendedAgain;
  const ledgerCopy = join(projectData, "events.compacted");
  writeFileSync(ledgerCopy, readFileSync(ledger));
  renameSync(ledgerCopy, ledger);
  const afterLedgerRotation = restarted.buildPage("ws-main", "demo", { limit: 100, nowMs: NOW });
  const fallbackEvents = afterLedgerRotation.items.filter((row) => row.source === "events" && row.summary === "no producer id");
  ok(afterLedgerRotation.revision === beforeLedgerRotation.revision + 1 && fallbackEvents.length === 1,
    "无 producer id 的 project ledger row 在 compact/rotate 后保持内容 identity，只推进 revision 不重复事件");

  const fires = join(projectData, "fires.jsonl");
  const fallbackFireRow = JSON.stringify({
    agent: "rotate-writer", model: "gpt-5", provider: "openai", durationSeconds: 1, exitCode: 0,
    startedAt: "2026-08-10T10:10:00.000Z", endedAt: "2026-08-10T10:10:01.000Z", timedOut: false, noop: false,
  });
  writeFileSync(fires, `${fallbackFireRow}\n`);
  const beforeFireRotation = restarted.buildPage("ws-main", "demo", { limit: 100, nowMs: NOW });
  const fireCopy = join(projectData, "fires.compacted");
  writeFileSync(fireCopy, readFileSync(fires));
  renameSync(fireCopy, fires);
  const afterFireRotation = restarted.buildPage("ws-main", "demo", { limit: 100, nowMs: NOW });
  ok(afterFireRotation.revision === beforeFireRotation.revision + 1
    && afterFireRotation.items.filter((row) => row.source === "fires" && row.actor.id === "rotate-writer").length === 1,
  "fire fallback id 在 ledger compact/rotate 后保持内容 identity，只推进 revision 不重复事件");
  unlinkSync(fires);
  restarted.refresh("ws-main", "demo", { nowMs: NOW });

  writeFileSync(join(projectData, "board", "tickets", "WL-1.md"), `---\nid: WL-1\ntitle: Signature\nstate: Todo\nupdated: 2026-08-10T10:05:00.000Z\n---\n`);
  restarted.refresh("ws-main", "demo", { nowMs: NOW });
  writeFileSync(join(repo, "episodes", "ep-001.md"), "# Episode 1\n");
  restarted.refresh("ws-main", "demo", { nowMs: NOW });
  ok(deepScans === 8, "ticket 与 artifact 元数据改动都会推进 source signature/checkpoint 并触发深扫");

  const cursorValue = first.nextBeforeCursor!;
  const decoded = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as Record<string, unknown>;
  const mutated = (key: string, value: string): string => Buffer.from(JSON.stringify({ ...decoded, [key]: value })).toString("base64url");
  ok(throwsWs(() => restarted.buildPage("ws-main", "demo", { before: mutated("workspaceId", "wrong"), refresh: false }), "workspace"),
    "v2 before cursor 拒绝错误 workspaceId");
  ok(throwsWs(() => restarted.buildPage("ws-main", "demo", { before: mutated("project", "other"), refresh: false }), "项目"),
    "v2 before cursor 拒绝错误 project");
  ok(throwsWs(() => restarted.buildPage("ws-main", "demo", { before: mutated("generation", "stale"), refresh: false }), "generation"),
    "v2 before cursor 拒绝错误 generation");

  const retentionRoot = join(tmp, "retention");
  const retentionData = join(retentionRoot, ".writing-loop", "demo");
  mkdirSync(join(retentionData, "board", "tickets"), { recursive: true });
  mkdirSync(join(retentionData, "reports"), { recursive: true });
  mkdirSync(join(retentionRoot, "repo", "episodes"), { recursive: true });
  mkdirSync(join(retentionRoot, "repo", "evaluation"), { recursive: true });
  writeFileSync(join(retentionRoot, ".writing-loop", "config.json"), JSON.stringify({ projects: { demo: { repoPath: "repo" } } }));
  const retentionLedger = join(retentionData, "events.jsonl");
  writeFileSync(retentionLedger, `${"x".repeat(130 * 1024)}\n${event("r1", "project.created", 1)}\n${event("r2", "project.paused", 2)}\n${event("r3", "project.resumed", 3)}\n`);
  const retention = new ActivityIndexer(loadConfig(retentionRoot), { maxEvents: 2 });
  const retainedFirst = retention.buildPage("ws-retention", "demo", { limit: 1, nowMs: NOW });
  const oldCursor = retainedFirst.nextBeforeCursor!;
  ok(retainedFirst.truncated && retainedFirst.warnings.some((warning) => warning.code === "RETENTION_TRUNCATED")
    && retainedFirst.warnings.some((warning) => warning.code === "BOOTSTRAP_GAP")
    && retainedFirst.warnings.some((warning) => warning.code === "TAIL_TRUNCATED"),
  "bootstrap 永久保留 bounded scan gap，retention 硬上限也显式告警");
  const retainedRestart = new ActivityIndexer(loadConfig(retentionRoot), { maxEvents: 2 })
    .buildPage("ws-retention", "demo", { limit: 1, refresh: false, nowMs: NOW });
  ok(retainedRestart.warnings.some((warning) => warning.code === "BOOTSTRAP_GAP"), "bootstrap truncation/gap warning 跨重启持久保留");
  appendFileSync(retentionLedger, `${event("r4", "project.paused", 4)}\n${event("r5", "project.resumed", 5)}\n`);
  retention.refresh("ws-retention", "demo", { nowMs: NOW });
  ok(throwsWs(() => retention.buildPage("ws-retention", "demo", { before: oldCursor, refresh: false }), "已过期"),
    "retention 丢弃 cursor anchor 后明确报告 cursor 过期，不返回空页");

  let lockObserved = false;
  let concurrent!: ActivityIndexer;
  const locking = new ActivityIndexer(ws, { hooks: { beforeDeepScan: () => {
    lockObserved = throwsWs(() => concurrent.refresh("ws-lock", "demo", { nowMs: NOW }), "另一个进程");
  } } });
  concurrent = new ActivityIndexer(ws);
  // A distinct workspace id cannot reuse the existing index, so isolate the lock test by removing
  // only the rebuildable cache (the source ledgers remain untouched).
  unlinkSync(indexFile);
  locking.refresh("ws-lock", "demo", { nowMs: NOW });
  ok(lockObserved, "每项目 O_EXCL lock 串行化并发 refresh");

  const safeBytes = readFileSync(indexFile);
  const backup = join(projectData, "activity-index.backup");
  const victim = join(tmp, "victim");
  writeFileSync(victim, "victim\n");
  renameSync(indexFile, backup);
  symlinkSync(victim, indexFile);
  ok(throwsWs(() => locking.read("ws-lock", "demo"), "普通文件"), "index symlink 被拒绝");
  unlinkSync(indexFile);
  renameSync(backup, indexFile);
  renameSync(indexFile, backup);
  linkSync(victim, indexFile);
  ok(throwsWs(() => locking.read("ws-lock", "demo"), "硬链接"), "index hardlink 被拒绝");
  unlinkSync(indexFile);
  renameSync(backup, indexFile);
  const fifoAvailable = spawnSync("mkfifo", [join(projectData, "probe.fifo")]).status === 0;
  if (fifoAvailable) {
    unlinkSync(join(projectData, "probe.fifo"));
    renameSync(indexFile, backup);
    const fifo = spawnSync("mkfifo", [indexFile]);
    ok(fifo.status === 0 && throwsWs(() => locking.read("ws-lock", "demo"), "普通文件"), "index FIFO 在 open 前被拒绝，不阻塞读取");
    unlinkSync(indexFile);
    renameSync(backup, indexFile);
  } else ok(true, "当前平台无 mkfifo，FIFO 路径跳过");
  ok(readFileSync(indexFile).equals(safeBytes), "安全路径测试未改写已有 index 内容");

  appendFileSync(ledger, `${event("atomic", "project.paused", 6)}\n`);
  const beforeFailure = readFileSync(indexFile);
  const failing = new ActivityIndexer(ws, { hooks: { beforeRename: () => { throw new Error("injected rename failure"); } } });
  let injected = false;
  try { failing.refresh("ws-lock", "demo", { nowMs: NOW }); } catch (error) { injected = (error as Error).message.includes("injected"); }
  const afterFailure = readFileSync(indexFile);
  const afterRestart = new ActivityIndexer(ws).buildPage("ws-lock", "demo", { limit: 100, refresh: false, nowMs: NOW });
  ok(injected && beforeFailure.equals(afterFailure) && !afterRestart.items.some((row) => row.id === "atomic"),
    "temp fsync 后 rename 故障保留旧索引；重启仍能读取已提交版本");
  const recovered = new ActivityIndexer(ws).buildPage("ws-lock", "demo", { limit: 100, nowMs: NOW });
  ok(recovered.items.filter((row) => row.id === "atomic").length === 1, "故障后锁 inode-safe 释放，后续 refresh 可恢复且不丢事件");

  appendFileSync(join(projectData, "fires.jsonl"), `${JSON.stringify({
    agent: "writer", model: "gpt-5", provider: "openai", durationSeconds: 7, exitCode: 0,
    startedAt: "2026-08-10T11:00:00.000Z", endedAt: "2026-08-10T11:00:07.000Z", timedOut: false, noop: false,
  })}\n`);
  writeFileSync(join(projectData, "run-state.json"), JSON.stringify({
    status: "running", pid: process.pid,
    inFlight: [{ agent: "showrunner", pid: 7, model: "opus", effort: "high", startedAt: "2026-08-10T11:59:00.000Z" }],
  }));
  writeFileSync(join(projectData, "wl-run.lock"), `holder pid=${process.pid} at 2026-08-10T11:59:00Z\n`);
  utimesSync(join(projectData, "wl-run.lock"), new Date(NOW - 1_000), new Date(NOW - 1_000));
  const overlay = new ActivityIndexer(ws).buildPage("ws-lock", "demo", { limit: 100, nowMs: NOW });
  ok(overlay.usage.observedFires === 1 && overlay.usage.durationSeconds === 7 && overlay.live[0]?.agent === "showrunner",
    "v2 index 保留最新 usage，live 始终作为非持久 overlay 读取");

  const malformed = JSON.parse(readFileSync(indexFile, "utf8")) as {
    generation: string; items: Array<{ subject?: unknown }>; usage: unknown;
  };
  const generationBeforeMalformed = malformed.generation;
  delete malformed.items[0]?.subject;
  malformed.usage = {};
  writeFileSync(indexFile, `${JSON.stringify(malformed)}\n`);
  const rebuiltMalformed = new ActivityIndexer(ws).buildPage("ws-lock", "demo", { limit: 100, nowMs: NOW });
  ok(rebuiltMalformed.generation !== generationBeforeMalformed
    && rebuiltMalformed.items.every((item) => Boolean(item.subject?.label))
    && rebuiltMalformed.usage.cost.state !== undefined
    && rebuiltMalformed.warnings.some((warning) => warning.code === "INDEX_REBUILT"),
  "嵌套 event/usage shape 损坏的合法 JSON cache 会自动重建，不让 Studio 页面永久 500");

  const legacyBinding = JSON.parse(readFileSync(indexFile, "utf8")) as { workspaceId: string; generation: string };
  const generationBeforeBindingMigration = legacyBinding.generation;
  legacyBinding.workspaceId = "legacy-single-workspace-id";
  writeFileSync(indexFile, `${JSON.stringify(legacyBinding)}\n`);
  const rebound = new ActivityIndexer(ws).buildPage("ws-lock", "demo", { limit: 100, nowMs: NOW });
  ok(rebound.workspaceId === "ws-lock" && rebound.generation !== generationBeforeBindingMigration
    && rebound.warnings.some((warning) => warning.code === "INDEX_REBUILT"),
  "旧 synthetic workspaceId 的可重建 cache 自动换 generation 迁移，不要求用户手删文件");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nACTIVITY_INDEX_OK" : `\n${fails} 项检查失败`);
process.exit(fails === 0 ? 0 : 1);
