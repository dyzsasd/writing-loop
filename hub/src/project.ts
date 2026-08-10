// `writing-loop project` —— workspace 项目清单、安全启停与 plan-confirm-create 立项。
// /writing-loop:add-script 或 Studio 负责采访；所有落盘都复用 onboarding core。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commitOnboarding, planOnboarding, verifyOnboarding } from "./onboarding.ts";
import { setProjectEnabled } from "./workspace-store.ts";
import { projectEntries, requireWorkspace, resolveRepoPath, WsError } from "./workspace.ts";

function usage(): void {
  console.log(`writing-loop project — 项目立项、清单与调度启停
用法:
  writing-loop project list [--json]
  writing-loop project enable KEY
  writing-loop project disable KEY
  writing-loop project plan --input request.json
  writing-loop project create --input request.json --confirm PLAN_ID [--json]
  writing-loop project verify KEY [--json]

plan 严格零写；create 只有在确认指纹仍匹配 config/templates 时才发布完整 repo、板与 config。
采访可在 Studio 或 Claude Code 的 /writing-loop:add-script 完成。`);
}

type ProjectRow = {
  key: string;
  title: string;
  repoPath: string;
  enabled: boolean;
};

export function projectMain(argv = process.argv.slice(2)): number {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "-h" || action === "help") { usage(); return 0; }
  if (!action) { usage(); return 2; }

  try {
    const ws = requireWorkspace();
    if (action === "list") {
      let asJson = false;
      for (const arg of rest) {
        if (arg === "--json") asJson = true;
        else { console.error(`writing-loop project list: 未知参数 '${arg}'`); usage(); return 2; }
      }
      const rows: ProjectRow[] = projectEntries(ws.config).map(([key, project]) => ({
        key,
        title: typeof project.title === "string" ? project.title : "",
        repoPath: resolveRepoPath(ws.root, project),
        enabled: project.enabled !== false,
      }));
      if (asJson) {
        console.log(JSON.stringify({ workspace: ws.root, projects: rows }, null, 2));
      } else if (!rows.length) {
        console.log(`writing-loop project — ${ws.root}\n\n尚无项目；运行 writing-loop studio 打开立项向导，或在 Claude Code 里运行 /writing-loop:add-script。`);
      } else {
        console.log(`writing-loop project — ${ws.root}\n`);
        for (const row of rows) {
          const state = row.enabled ? "[active]" : "[paused]";
          console.log(`  ${row.key.padEnd(20)} ${state.padEnd(8)} ${row.title || "未命名"}\n    ${row.repoPath}`);
        }
      }
      return 0;
    }

    if (action === "enable" || action === "disable") {
      if (rest.length !== 1 || !rest[0]) {
        console.error(`writing-loop project ${action}: 需要且只接受一个 KEY`);
        usage();
        return 2;
      }
      const key = rest[0];
      const enabled = action === "enable";
      const project = setProjectEnabled(ws.root, key, enabled);
      console.log(`项目 ${key}（${typeof project.title === "string" ? project.title : "未命名"}）已${enabled ? "启用" : "暂停"}。`);
      return 0;
    }

    if (action === "plan" || action === "create") {
      let inputFile: string | null = null;
      let confirmation: string | null = null;
      let asJson = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--input") {
          inputFile = rest[++i] ?? null;
          if (!inputFile) { console.error(`writing-loop project ${action}: --input 需要文件路径或 -`); return 2; }
        } else if (arg === "--confirm" && action === "create") {
          confirmation = rest[++i] ?? null;
          if (!confirmation) { console.error("writing-loop project create: --confirm 需要 PLAN_ID"); return 2; }
        } else if (arg === "--json" && action === "create") asJson = true;
        else { console.error(`writing-loop project ${action}: 未知参数 '${arg}'`); usage(); return 2; }
      }
      if (!inputFile) { console.error(`writing-loop project ${action}: 缺少 --input request.json`); return 2; }
      if (action === "create" && !confirmation) { console.error("writing-loop project create: 缺少 --confirm PLAN_ID"); return 2; }
      let payload: unknown;
      try {
        const raw = readFileSync(inputFile === "-" ? 0 : inputFile, "utf8");
        payload = JSON.parse(raw);
      } catch (error) {
        throw new WsError(`无法读取立项输入 ${inputFile}：${error instanceof Error ? error.message : String(error)}`);
      }
      if (action === "plan") {
        console.log(JSON.stringify(planOnboarding(ws.root, payload), null, 2));
        return 0;
      }
      const result = commitOnboarding(ws.root, payload, confirmation!);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`项目 ${result.key}（${result.title}）已完整立项。`);
        console.log(`  repo: ${result.repoPath}`);
        console.log(`  scaffold: ${result.commit.slice(0, 12)}`);
        console.log(`  首票: ${result.outlineTicketId}`);
        console.log("NEXT: writing-loop studio（或 /showrunner-agent）");
      }
      return 0;
    }

    if (action === "verify") {
      const positional = rest.filter((arg) => arg !== "--json");
      const key = positional[0];
      const asJson = rest.includes("--json");
      if (!key || positional.length !== 1 || rest.some((arg) => arg.startsWith("--") && arg !== "--json")) {
        console.error("writing-loop project verify: 需要且只接受一个 KEY（可加 --json）");
        return 2;
      }
      const verification = verifyOnboarding(ws.root, key);
      if (asJson) console.log(JSON.stringify({ project: key, ...verification }, null, 2));
      else {
        console.log(`writing-loop project verify — ${key}`);
        for (const check of verification.checks) console.log(`  ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
      }
      return verification.ok ? 0 : 1;
    }

    console.error(`writing-loop project: 未知操作 '${action}'`);
    usage();
    return 2;
  } catch (error) {
    console.error(`writing-loop project: ${error instanceof WsError ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(projectMain());
}
