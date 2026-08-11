// Regression: framework proposals are content-addressed in the workspace system inbox and a
// legacy reflect proposal is removed from the drama board only after its complete bytes are kept.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileSystemProposal, listSystemProposals, migrateReflectProposalTicket, parseSystemProposal,
  readSystemProposal, systemProposalDirectory, type SystemProposalDraft,
} from "../src/system-inbox.ts";
import type { WlConfig } from "../src/workspace.ts";

let failures = 0;
const check = (condition: unknown, label: string): void => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) failures++;
};
const throws = (fn: () => unknown, text: string): boolean => {
  try { fn(); return false; } catch (error) { return String(error).includes(text); }
};
const throwsAny = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

const root = mkdtempSync(join(tmpdir(), "wl-system-inbox-"));
try {
  mkdirSync(join(root, ".writing-loop", "drama", "board", "tickets"), { recursive: true });
  const config: WlConfig = { version: 1, projects: { drama: { title: "剧", repoPath: "drama" } } };
  writeFileSync(join(root, ".writing-loop", "config.json"), JSON.stringify(config));
  const draft: SystemProposalDraft = {
    version: 1,
    kind: "framework-improvement",
    title: "把框架建议移出项目创作板",
    summary: "系统维护事项不应该伪装成剧情工作。",
    evidence: ["reflect fire 12", "project=drama"],
    proposedChange: "写入 workspace 级系统收件箱。",
    source: { project: "drama", agent: "reflect", projectTicket: null },
  };
  const first = fileSystemProposal(root, draft, { now: () => new Date("2026-08-11T20:30:00.000Z") });
  const replay = fileSystemProposal(root, draft, { now: () => new Date("2026-08-11T21:30:00.000Z") });
  check(first.created && !replay.created && first.proposal.id === replay.proposal.id,
    "同一系统建议 content-addressed exact replay，不重复占位");
  check(first.proposal.id.startsWith("WLSYS-") && readSystemProposal(root, first.proposal.id)?.title === draft.title,
    "系统建议使用独立 WLSYS 身份且可严格读取");
  check(listSystemProposals(root).counts.open === 1, "系统收件箱单独汇总 open 建议");

  const ticketId = "DRAMA-3";
  const ticketFile = join(root, ".writing-loop", "drama", "board", "tickets", `${ticketId}.md`);
  const legacy = `---\nid: ${ticketId}\ntitle: "[reflect-proposal] doctor 空启动"\ntype: Improvement\nstate: Backlog\nowner: showrunner\nlabels: [writing-loop, Improvement, showrunner, blocked, needs-showrunner, external-prereq]\npriority: 4\nassignee: null\ncreated: 2026-08-11T19:42:29Z\nupdated: 2026-08-11T19:42:29Z\n---\nBail-shape: external-prereq\n\n## Context\n完整证据。\n`;
  writeFileSync(ticketFile, legacy);
  const migrated = migrateReflectProposalTicket(root, config, "drama", ticketId, {
    status: "applied",
    resolutionNote: "已改为系统收件箱",
    resolutionCommit: "abcdef1",
    now: () => new Date("2026-08-11T22:00:00.000Z"),
  });
  check(migrated.removedTicket && !existsSync(ticketFile), "迁移完成后项目创作板不再保留框架 Ticket");
  check(migrated.proposal.status === "applied" && migrated.proposal.source.projectTicket?.markdown === legacy,
    "系统记录保留原 Ticket 全文、来源与处理结论");
  check(migrated.proposal.source.projectTicket?.sha256 === createHash("sha256").update(legacy).digest("hex"),
    "迁移 provenance 绑定原 Ticket 精确字节摘要");
  check(listSystemProposals(root).proposals.length === 2, "创作板与系统收件箱在存储层彻底隔离");

  const stored = join(systemProposalDirectory(root), `${first.proposal.id}.json`);
  const parsed = JSON.parse(readFileSync(stored, "utf8")) as Record<string, unknown>;
  parsed.title = "被篡改";
  check(throws(() => parseSystemProposal(parsed), "fingerprint"), "持久记录内容漂移 fail closed");

  const badRoot = mkdtempSync(join(tmpdir(), "wl-system-inbox-link-"));
  try {
    mkdirSync(join(badRoot, ".writing-loop"), { recursive: true });
    symlinkSync(root, join(badRoot, ".writing-loop", "system"));
    check(throwsAny(() => fileSystemProposal(badRoot, draft)), "system inbox 父路径符号链接零写拒绝");
  } finally { rmSync(badRoot, { recursive: true, force: true }); }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} SYSTEM_INBOX_TESTS_FAILED` : "\nSYSTEM_INBOX_OK");
process.exit(failures ? 1 : 0);
