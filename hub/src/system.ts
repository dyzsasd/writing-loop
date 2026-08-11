#!/usr/bin/env node
// `writing-loop system` — workspace-level framework proposal inbox. It is intentionally separate
// from every drama board; creative schedulers never consume these records.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fileSystemProposal, listSystemProposals, migrateReflectProposalTicket, readSystemProposal,
  type SystemProposalStatus,
} from "./system-inbox.ts";
import { projectEntries, requireWorkspace, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop system — Writing Loop 系统改进收件箱
用法:
  writing-loop system proposal list [--json]
  writing-loop system proposal show WLSYS-ID [--json]
  writing-loop system proposal file --input proposal.json [--json]
  writing-loop system proposal migrate-ticket --project KEY --ticket ID
      [--status open|applied|dismissed] [--note TEXT] [--commit SHA] [--json]

系统建议写入 <workspace>/.writing-loop/system/proposals/，不会进入任何剧集项目看板。`);
}

const valueAfter = (args: string[], name: string): string | null => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
};

export function systemMain(argv = process.argv.slice(2)): number {
  const [group, action, ...rest] = argv;
  if (group === "--help" || group === "-h" || group === "help" || !group) { usage(); return group ? 0 : 2; }
  if (group !== "proposal" || !action) { usage(); return 2; }
  try {
    const ws = requireWorkspace();
    const asJson = rest.includes("--json");
    if (action === "list") {
      if (rest.some((arg) => arg !== "--json")) throw new WsError("system proposal list 只接受 --json");
      const list = listSystemProposals(ws.root);
      if (asJson) console.log(JSON.stringify(list, null, 2));
      else if (!list.proposals.length) console.log("系统改进收件箱为空。项目看板只保留创作任务。");
      else for (const proposal of list.proposals) console.log(`${proposal.id}  [${proposal.status}]  ${proposal.title}  ← ${proposal.source.project}/${proposal.source.agent}`);
      return 0;
    }
    if (action === "show") {
      const id = rest.find((arg) => !arg.startsWith("--"));
      if (!id || rest.some((arg) => arg !== id && arg !== "--json")) throw new WsError("system proposal show 需要一个 WLSYS-ID");
      const proposal = readSystemProposal(ws.root, id);
      if (!proposal) throw new WsError(`没有系统建议 '${id}'`);
      console.log(asJson ? JSON.stringify(proposal, null, 2) : `${proposal.id} [${proposal.status}]\n${proposal.title}\n\n${proposal.summary}\n\n${proposal.proposedChange}`);
      return 0;
    }
    if (action === "file") {
      const input = valueAfter(rest, "--input");
      if (!input) throw new WsError("system proposal file 缺少 --input proposal.json");
      const allowed = new Set(["--input", input, "--json"]);
      if (rest.some((arg) => !allowed.has(arg))) throw new WsError("system proposal file 含未知参数");
      const raw = readFileSync(input === "-" ? 0 : input, "utf8");
      const draft = JSON.parse(raw) as unknown;
      const source = draft && typeof draft === "object" && !Array.isArray(draft)
        ? (draft as { source?: { project?: unknown } }).source : undefined;
      const project = source?.project;
      if (typeof project !== "string" || !projectEntries(ws.config).some(([key]) => key === project)) {
        throw new WsError("proposal source.project 必须是当前 workspace 的项目");
      }
      const result = fileSystemProposal(ws.root, draft);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.created ? "已收件" : "已存在"} ${result.proposal.id}：${result.proposal.title}`);
      return 0;
    }
    if (action === "migrate-ticket") {
      const project = valueAfter(rest, "--project");
      const ticket = valueAfter(rest, "--ticket");
      const rawStatus = valueAfter(rest, "--status") ?? "open";
      if (!project || !ticket || !["open", "applied", "dismissed"].includes(rawStatus)) {
        throw new WsError("migrate-ticket 需要 --project KEY --ticket ID，status 只能是 open|applied|dismissed");
      }
      const status = rawStatus as SystemProposalStatus;
      const note = valueAfter(rest, "--note");
      const commit = valueAfter(rest, "--commit");
      if (status !== "open" && !note) throw new WsError("applied/dismissed 迁移必须提供 --note");
      const consumes = new Set(["--project", project, "--ticket", ticket, "--status", rawStatus, "--json"]);
      if (note) { consumes.add("--note"); consumes.add(note); }
      if (commit) { consumes.add("--commit"); consumes.add(commit); }
      if (rest.some((arg) => !consumes.has(arg))) throw new WsError("migrate-ticket 含未知参数");
      const result = migrateReflectProposalTicket(ws.root, ws.config, project, ticket, {
        status, ...(note ? { resolutionNote: note } : {}), ...(commit ? { resolutionCommit: commit } : {}),
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(`已把 ${ticket} 移出项目看板 → ${result.proposal.id} [${result.proposal.status}]`);
      return 0;
    }
    throw new WsError(`未知 system proposal 操作 '${action}'`);
  } catch (error) {
    console.error(`writing-loop system: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(systemMain());
