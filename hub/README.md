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
writing-loop studio                  # open the loopback-only UI at http://127.0.0.1:8791/
writing-loop workspace list          # inspect the machine-local workspace ID registry
writing-loop snapshot                # print Studio's versioned multi-project read model as JSON
writing-loop project list            # list enabled and paused projects
writing-loop production status       # inspect the local authoritative render/QC ledger (no remote calls)
writing-loop production enqueue --plan --project demo --input enqueue.json
writing-loop production enqueue --confirm wlprodplan_... --project demo --input enqueue.json
writing-loop-production-worker --config /etc/writing-loop/production-runtime.json --once --json
writing-loop production handoff --project demo --input handoff.json  # approved takes → canonical Studio manifest

# Deterministic, confirmation-gated project creation
writing-loop project plan --input request.json
writing-loop project create --input request.json --confirm wlplan_...
writing-loop project verify my-drama
# Advanced recovery/migration for an already-created adaptation; normal onboarding
# records the novel and files source-analysis during project create.
writing-loop source status --project my-drama

writing-loop install-claude-plugin   # let Claude Code install the plugin from npm (then /plugin …)
# in Claude Code: /writing-loop:add-script   ← adaptation collects source + brief and queues source-analysis
writing-loop doctor                  # read-only health check (ends with DOCTOR_OK/FAILED + NEXT:)
writing-loop run --dry-run           # print every agent command wl-run would fire
writing-loop run                     # drive the whole writers' room (Ctrl-C = graceful stop)
writing-loop status                  # board summary: states, parked tickets, episode frontier, locks
writing-loop fires --last 20         # per-fire telemetry tail + per-agent success rates
```

## Harness CLIs

The scheduler accepts exactly `claude`, `codex`, and `opencode` as first-class
Harness IDs:

```sh
writing-loop run --cli claude
writing-loop run --cli codex
writing-loop run --cli opencode
```

Claude and Codex support slash or inline prompt transport; OpenCode is always inline.
The workspace `providers{}` registry is OpenCode-only and may describe
OpenAI-compatible endpoints. Per-agent `command` overrides are an operator escape hatch,
not additional certified Harnesses. Script writing does not contact ComfyUI/H3 and does
not require a GPU. See the repository's
[Harness contract](https://github.com/dyzsasd/writing-loop/blob/main/docs/HARNESS.md).

Minimal approved-take handoff input (`createdAt` is canonical UTC ISO and must not
predate the production revision being exported):

```json
{
  "version": 1,
  "handoffId": "handoff-episode-001-v1",
  "studioProjectId": "demo-episode-001",
  "pipeline": "cinematic",
  "createdAt": "2026-08-10T12:11:00.000Z",
  "delivery": {
    "version": 1,
    "aspectRatio": "9:16",
    "width": 1080,
    "height": 1920,
    "fps": 24,
    "container": "video/mp4",
    "language": "zh-CN"
  },
  "taskIds": ["take-shot-001-approved"]
}
```

`production handoff` emits `{ digestAlgorithm, digest, handoff }` to stdout; it
does not contact, import into, or start video-creation-studio. `AssetRef.uri` is an
opaque identity: only a trusted scheme-and-authority allowlist resolver may open it,
and consumers must never send an arbitrary `https:` URI directly to `fetch`.

## Commands

| command | what it does |
| --- | --- |
| `init [--dir D]` | scaffold `.writing-loop/` + empty `config.json`, ensure a stable workspace ID, and best-effort register the root (idempotent, never overwrites) |
| `studio [--host LOOPBACK] [--port N] [--workspace ID] [--single]` | serve the local writers' room; select an explicit registered ID, or force legacy single-workspace mode; non-loopback hosts are rejected |
| `workspace list [--json]` | inspect the bounded machine-local registry, including per-entry `missing`/`corrupt` diagnostics |
| `workspace add [DIR] [--label L]` | ensure that workspace's durable ID and add/update its canonical root pointer |
| `workspace remove ID` | remove only the local registry pointer; never delete the workspace or its identity |
| `snapshot [--project K] [--compact]` | print the same versioned, bounded multi-project read model used by Studio |
| `project list [--json]` | list every configured project, including paused projects |
| `project enable\|disable K` | atomically pause or resume a project while preserving unknown config fields |
| `project plan --input FILE` | validate an onboarding request and return a deterministic, strictly zero-write plan plus `planId` |
| `project create --input FILE --confirm PLAN_ID [--json]` | confirm that exact plan, atomically reserve its final paths, publish, and verify a new project |
| `project verify K [--json]` | independently verify config, repo/Git scaffold, first ticket, and runtime layout |
| `source plan --project K --input FILE` | pin a workspace-local novel, adaptation brief, rights and Harness consent into a deterministic zero-write plan |
| `source register --project K --input FILE --confirm PLAN_ID [--json]` | copy/chunk the novel into local 0600 runtime, commit only provenance/brief, and file writing-loop's source-analysis ticket |
| `source status --project K [--json]` | inspect selected/completed chunks and the source-analysis phase |
| `story status --project K [--json]` | inspect the strict story companion, derived assets and shared Studio quality model; read-only |
| `story validate --project K [--stage skeleton\|beats\|full] [--json]` | run deterministic story gates; scheduler agents call this automatically |
| `story context --project K --ticket ID --agent A [--max-bytes N] [--json]` | build a deterministic ticket/agent/episode-scoped Context Pack from structured assets; never reads raw novel text |
| `system proposal list\|show\|file\|migrate-ticket …` | maintain the immutable workspace-level system-improvement inbox; framework proposals never enter a drama board |
| `production status [--project K] [--json]` | inspect the scoped, durable render/take/QC ledger, including paused projects; never contacts a backend |
| `production enqueue --plan --project K --input FILE [--json]` | validate an immutable production intent and return a deterministic zero-write/zero-network plan |
| `production enqueue --confirm PLAN_ID --project K --input FILE [--json]` | persist that exact intent/task/dispatch request; endpoint/profile/token fields are rejected and no provider is contacted |
| `production handoff --project K --input FILE` | emit a canonical, digest-bound Studio handoff containing only human-approved takes; never contacts Studio |
| `run [flags]` | run the built-in TS scheduler (`--project` / `--once` / `--dry-run` / `--plan N` / `--agents a,b` / `--for S` / `--cli claude\|codex\|opencode`) |
| `status [--project K] [--json]` | read-only board summary |
| `doctor` | read-only health check; missing identity/registry are migration warnings, while corrupt identity/registry, unsafe/broken onboarding journals, invalid `WRITING_LOOP_HOME`, or crash-leftover exclusive locks fail without repairing files |
| `fires [--project K] [--last N] [--json]` | fires.jsonl tail + per-agent aggregation |
| `sync-opencode [--dir D]` | render the workspace `providers{}` registry into `<workspace>/opencode.json` (create-or-merge, never touches `~/.config/opencode/`) |
| `install-claude-plugin [--version V] [--dry-run]` | register a local npm-source marketplace for Claude Code |
| `version` / `help` | you know these |

`writing-loop-production-worker --config FILE --once [--json]` is a separate server-only binary.
Its owner-only runtime config and exact H3/Gateway fixture are documented in the
[Phase 3C AI-SPEC](https://github.com/dyzsasd/writing-loop/blob/main/docs/design/phase-3-remote-production/AI-SPEC.md#9b-phase-3c-%E9%83%A8%E7%BD%B2%E4%B8%8E-runtime-contract).
Run it from a systemd/launchd/container timer; Studio never holds its credentials.
The installed package also exposes a hermetic example smoke:

```sh
node node_modules/@dyzsasd/writing-loop/examples/production/representative-h3/smoke.mjs
```

It performs no network requests and exercises only the representative API-format config/template;
it has not passed a live ComfyUI `/prompt` and is not an H3 deployment claim.

Authoritative workspace/project state lives under `<workspace>/.writing-loop/` (a sibling of
the script repos, never inside their git history); only the rebuildable machine-local root
pointers live outside it. The workspace root is found by walking up from the
CWD to the first directory containing `.writing-loop/`; `WRITING_LOOP_WORKSPACE` (absolute
path) overrides explicitly — a bad value is a hard error, never a silent fallback. This
normal CLI discovery deliberately does not consult the machine registry.

Each workspace owns a strict v1 identity at `.writing-loop/workspace.json`:
`{"version":1,"id":"ws_<32 lowercase hex>"}`. The non-authoritative machine-local
registry is `$WRITING_LOOP_HOME/workspaces.json` (default `~/.writing-loop/workspaces.json`;
the override must be absolute) and stores at most 128 `{id,root,label?}` pointers. A copied
identity cannot be registered at two existing roots; moving a workspace can update the
pointer only after the former root has disappeared. Both files reject unknown fields,
symlinks, hardlinks and special files, and are replaced under independent O_EXCL locks with
fsync + atomic rename.
`doctor` also inspects identity, registry, config, and per-project activity-index locks with
bounded single-link reads. A dead owner or lock older than 60 minutes is a structural failure
with PID/mtime recovery guidance; Doctor reports but never removes the lock. Onboarding
journals use the same 1 MiB limit as the recovery parser and reject symlink, hardlink, FIFO,
device, and symlinked-parent paths.

## Studio and confirmed onboarding

Studio is a server-rendered, loopback-only view over the same plain files returned by
`writing-loop snapshot`. It shows the project library, story maturity, creative lanes,
human decision gates, recent episodes, and live in-flight agents. With multiple registry
entries its root is a fleet page (missing/invalid roots degrade per card) and every workspace
surface is namespaced under `/w/<workspace-id>/`; one workspace or `--single` preserves the
original unprefixed URLs.
Fleet and workspace streams are isolated, as are onboarding, resource, activity and toggle
writes. An unscoped GET in fleet mode redirects to the selected workspace; an unscoped write
is rejected.

Project pages expose allowlisted, read-only ticket, story-document, episode, report, and
evaluation details. Project activity is served by a persistent, rebuildable v2 index at
`.writing-loop/<project>/activity-index.v2.json`; source files remain authoritative and all
bootstrap/retention gaps are explicit. Pagination cursors bind workspace + project + index
generation. `run-state.json` is a live overlay, not invented history. Studio SSE IDs bind
either one workspace or the fleet and aggregate stable snapshot + index revisions;
`Last-Event-ID` resumes across Studio restarts without replaying an unchanged cursor, while
foreign or malformed cursors are rejected. Unknown token usage or cost remains explicitly
unknown/not recorded.

The workspace page also exposes a separate `/system` improvement inbox backed by immutable
`WLSYS-*` proposal records. It is deliberately outside every project board: framework,
scheduler, and cross-project skill work cannot inherit creative labels or block a drama.

The project workbench has dedicated overview, source, story, dual-order timeline, typed story-asset, character,
art and quality surfaces. Source pages expose fingerprints/checkpoints but never raw novel
content. `story/outline.v1.json` owns season structure; `story/assets.v1.json` owns typed facts,
relations, Markdown hashes, and chronology-versus-reveal events. Harnesses consume bounded
ticket-scoped Context Packs rather than scanning whole bibles and ledgers. Quality states keep skipped/not-applicable separate
from pass. All creative routes and `/api/projects/<key>/story` remain read-only.

Studio's “New project” flow, `/writing-loop:add-script`, and the CLI all call the same
onboarding core. The write boundary is deliberately plan → confirm → create:

1. `project plan` validates and normalizes the interview, computes the target paths and
   first ticket, and returns a deterministic `planId` without taking a lock or writing.
2. The operator reviews the plan and passes that `planId` to `project create` with the exact
   same input.
3. Creation atomically reserves the brand-new repo and project-data final names, populates
   them under the journal, publishes config last, then runs the same checks available through
   `project verify`. For an adaptation, the same confirmation then exact-replays a source plan
   bound into the onboarding fingerprint, publishes local chunks, and files `source-analysis`;
   no second operator command is part of the normal path.

Creation is crash-recoverable, but never guesses. A durable per-project journal lives at
`.writing-loop/.onboarding-transactions/<key>.json` and advances through the backward-compatible
labels `prepared → repo-staged → data-staged → repo-promoted → data-promoted`; “promoted” is now
a completeness checkpoint, not a staging-directory rename. Retrying with the
same normalized request and original `planId` may resume only when config, templates,
implementation version, ownership markers, the clean one-commit repo scaffold, the bounded
SHA-256 manifest of the complete project-data tree, and the receipt still match. Modified or
extra data, symlinks/special files, a live owner PID, changed inputs, or ambiguous ownership
hard-stop for manual audit. If a crash happened before a complete commit/data digest was
persisted, that reserved final tree is preserved rather than deleted or rebuilt. Recovery is an
explicit retry, not a daemon; after config is atomically published, the receipt makes the
same confirmed retry idempotent.

## Phase 2 + Phase 3C status

The Phase 2 foundation now includes confirmed onboarding, durable same-fingerprint crash
recovery, the shared Studio/CLI snapshot, allowlisted details, persistent bounded activity,
restart-resumable SSE, durable workspace identity, a bounded local registry, and a
multi-workspace Studio namespace. Phase 3A added the versioned production ledger and conservative
ComfyUI primitives. Phase 3B added immutable dispatch intents, rights/moderation/license/budget
gates, exact prepare→persist→single-submit envelopes, a project-scoped recovery lease and control
ledger, pure reconciliation, an idempotent private asset-ingest port, read-only control exposure in
CLI/Studio, and an approved-take `video-creation-studio` handoff manifest.

Phase 3C adds zero-network plan/confirm enqueue, a one-shot `writing-loop-production-worker`,
owner-only runtime configuration, per-workflow input policy, an H3 four-component model bundle and
fixed active-pipeline contract, source→consumer scoped staging, template→bound graph
materialization, verified stage receipts, durable admission settlement, and scope-bound
stage/job/output Gateway kernels behind one strict router. Endpoint, profile and credential values
remain server-only and cannot be supplied by Studio or enqueue argv. Raw ComfyUI is limited to an
uncredentialed literal-loopback development escape hatch; remote production goes through the
authenticated Gateway.

This is a deployable control plane and private Gateway kernel, not a bundled GPU appliance. A real
deployment must still supply H3/ComfyUI inference, TLS/mTLS, credential issuance, pinned server
profiles and model/custom-node attestation, an asset resolver/CAS location, and a durable admission
policy. The checked documentation fixture is representative API format and has not passed a live
ComfyUI `/prompt`; it is not an H3 deployment claim. The immutable
`modelFamily` is checked independently from its ComfyUI/direct transport so H3 cannot bypass its
license gate by being wrapped in a generic workflow. MiniMax H3 remains a video
generation execution backend (not the script-writing model); provider billing reconciliation and a
verified writable Studio API remain outside this release. Studio's production surface stays read-only.

Docs: <https://github.com/dyzsasd/writing-loop> (`docs/GUIDE*.md`,
`references/config-schema.md`, `references/conventions.md`).
