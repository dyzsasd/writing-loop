# @dyzsasd/writing-loop

The `writing-loop` CLI — an autonomous short-drama (竖屏短剧, vertical micro-drama) writers'
room in a folder. Nine agents (Showrunner, Story-Designer, Episode-Writer, Reviewer,
Script-Doctor, Evaluator, Market-Watch, Reflect, Sweep) plan, outline, write, review, score,
and market-watch scripts through ticket state on a local file board. This package ships:

- the `writing-loop` bin (thin TS CLI, zero runtime dependencies);
- the built-in `wl-run` scheduler (`src/scheduler.ts`, native TypeScript, zero deps) — the
  actual engine that fires agents on Claude Code, Codex, or opencode: single-flight repo
  writers, keystone escalation, capSeconds walls, `fires.jsonl` telemetry;
- the full plugin payload (`skills/`, `references/`, `scripts/`, `templates/`,
  `.claude-plugin/`) so a single npm install carries everything the loop needs.

## Install

```sh
npm i -g @dyzsasd/writing-loop
```

Requires Node >= 20.11 to run the published CLI — nothing else (no python). Developing this
package from a repo checkout (running the `.ts` sources and tests directly) additionally
requires Node >= 23.6 (native type stripping).

## Quickstart

```sh
mkdir my-dramas && cd my-dramas
writing-loop init                    # scaffold <workspace>/.writing-loop/ + empty config.json
writing-loop install-claude-plugin   # let Claude Code install the plugin from npm (then /plugin …)
# in Claude Code: /writing-loop:add-script   ← the onboarding interview (拆书 or original)
writing-loop doctor                  # read-only health check (ends with DOCTOR_OK/FAILED + NEXT:)
writing-loop run --dry-run           # print every agent command wl-run would fire
writing-loop run                     # drive the whole writers' room (Ctrl-C = graceful stop)
writing-loop status                  # board summary: states, parked tickets, episode frontier, locks
writing-loop fires --last 20         # per-fire telemetry tail + per-agent success rates
```

## Commands

| command | what it does |
| --- | --- |
| `init [--dir D]` | scaffold `.writing-loop/` + empty `config.json` (idempotent, never overwrites) |
| `run [flags]` | run the built-in TS scheduler (`--project` / `--once` / `--dry-run` / `--plan N` / `--agents a,b` / `--for S` / `--cli claude\|codex\|opencode`) |
| `status [--project K] [--json]` | read-only board summary |
| `doctor` | read-only health check; warnings never fail, structural problems do |
| `fires [--project K] [--last N] [--json]` | fires.jsonl tail + per-agent aggregation |
| `sync-opencode [--dir D]` | render the workspace `providers{}` registry into `<workspace>/opencode.json` (create-or-merge, never touches `~/.config/opencode/`) |
| `install-claude-plugin [--version V] [--dry-run]` | register a local npm-source marketplace for Claude Code |
| `version` / `help` | you know these |

State layout: everything lives under `<workspace>/.writing-loop/` (a sibling of the script
repos, never inside their git history). The workspace root is found by walking up from the
CWD to the first directory containing `.writing-loop/`; `WRITING_LOOP_WORKSPACE` (absolute
path) overrides explicitly — a bad value is a hard error, never a silent fallback.

Docs: <https://github.com/dyzsasd/writing-loop> (`docs/GUIDE*.md`,
`references/config-schema.md`, `references/conventions.md`).
