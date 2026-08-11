# writing-loop

**English** · [中文](README.zh-CN.md) · [Français](README.fr.md)

**An autonomous short-drama writers' room in a folder.** Nine launchable agents
(Showrunner, Story-Designer, Episode-Writer, Reviewer, Script-Doctor, Evaluator,
Market-Watch, Reflect, Sweep) plan, outline, write, review, and score
**vertical micro-drama (竖屏短剧)** scripts — coordinating purely through ticket
state on a local file board. You bring the premise; the room turns it into a
coherent 60–100 episode serial.

You are the **showrunner-of-showrunners**, not the line editor: work enters
through the Showrunner (never straight to a writer), keystone episodes get the
Story-Designer's own pen first, every draft is verified independently of the
writer's own claims, and milestones are gated by a rubric you can read.

> ### ▶ Start here → **[Guide: From a Novel to a Script](docs/GUIDE.md)**
> The single most useful doc — the complete, hands-on path from installing the
> plugin to shipping your first deliverable (the 一卡包). Read this first.

> How it works inside — the layers, the ledgers, the gate topology, the
> anti-drift protocols: [`docs/DESIGN.md`](docs/DESIGN.md). This README is about
> **using** it.

---

## What it is

One folder = one project = one drama = one local board. Inside, a small team
keeps a long serial coherent through four things citron-grade AI scripts skip:

- **A story bible** (`bible/north-star.md` + characters + world) — the frozen
  strategic layer: one-line story, positioning, the emotion engine, the ending
  promise, and the creative red lines.
- **A master outline** (`outline.md`) — unit table, the five climax anchors, the
  paywall plan, the season-level foreshadow registry, and set-piece/sequel-hook
  plans.
- **Per-episode beat cards** (`arcs/arc-NN-*.md`) — the contract between skeleton
  and final draft: every episode's hard hook, three-axis progression, payoff,
  end-hook, foreshadow ops, and **do-not-write** boundaries, plus the losing
  candidates and why they lost.
- **Three ledgers** (`ledgers/`) — `foreshadow.md` (planted → refreshed → paid),
  `story-state.md` (rebuildable state + per-episode end-state + passivity marks),
  and `production.md` (scene/character registry + cost counters). Every episode
  reads them before writing and writes a **delta declaration** back, line-cited,
  in the same commit.

Milestones are gated by a **4-dimension / 16-indicator rubric** run by the
Evaluator: a three-episode micro-gate, an outline lock gate, the
**first-paywall pack (一卡包)** gate — the first real delivery milestone — then
the paywall-2, paywall-3, and finale gates.

Two ways to start a project: **novel adaptation** (拆书 — deconstruct the source
into three worksheets) or **original creation** (with a light teardown of one or
two comparison dramas).

## Quick start

**1. Install the plugin** (once). In **Claude Code**:

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

Or in **Codex** (Claude Code and Codex expose the plugin/slash transport; see
conventions §24–§25):

```
codex plugin marketplace add dyzsasd/writing-loop
```

OpenCode is the third first-class scheduler Harness. It receives the nine writers'
room agent skills inline after a project has been created; use Studio or the
`writing-loop project plan/create` commands for OpenCode-only onboarding.

Codex is also an optional in-loop accelerant (opt-in via the project's `codex`
config): **image generation** — turn the bible's visual tokens into character /
scene concept art — and an **independent second-engine review** for the Reviewer /
Script-Doctor. Absent or disabled ⇒ everything behaves exactly the same.

To use Studio or the commands directly, install the **`writing-loop` npm CLI**
for deterministic onboarding, the built-in scheduler, and board tooling. The
`add-script` skill can fall back to the core bundled with the installed plugin;
existing projects can also run slash agents without a global CLI.

```bash
npm i -g @dyzsasd/writing-loop    # writing-loop run / status / doctor / fires …
```

From a workspace folder, open the local writers' room:

```bash
writing-loop init                 # once: create .writing-loop/ in this workspace
writing-loop studio               # http://127.0.0.1:8791/
writing-loop workspace list       # machine-local workspace registry
writing-loop snapshot             # the same multi-project read model as JSON
writing-loop project list         # includes paused dramas
writing-loop production status    # local authoritative take/QC ledger; no remote calls
writing-loop production enqueue --plan --project demo --input enqueue.json
writing-loop production enqueue --confirm wlprodplan_… --project demo --input enqueue.json
writing-loop-production-worker --config /etc/writing-loop/production-runtime.json --once --json
writing-loop production handoff --project demo --input handoff.json  # approved takes only; stdout JSON
writing-loop project plan --input request.json
writing-loop project create --input request.json --confirm wlplan_…
writing-loop project verify my-drama
```

A minimal `handoff.json` names an existing human-approved shot take; `createdAt`
must be canonical UTC ISO time and cannot predate the production revision being exported:

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

The command emits `{ digestAlgorithm, digest, handoff }`; it does not contact,
import into, or start video-creation-studio. Treat every emitted `AssetRef.uri` as
an opaque identity: only a trusted scheme-and-authority allowlist resolver may open
it, and consumers must never pass an arbitrary `https:` URI directly to `fetch`.

`init` gives the workspace a durable opaque ID in
`.writing-loop/workspace.json` and attempts to register its canonical path in the
bounded, machine-local registry at `$WRITING_LOOP_HOME/workspaces.json` (default:
`~/.writing-loop/workspaces.json`). A registry failure is reported without undoing a
successful init. You can also manage those pointers explicitly:

```bash
writing-loop workspace add ../another-room --label "Historical dramas"
writing-loop workspace list --json
writing-loop workspace remove ws_0123456789abcdef0123456789abcdef
writing-loop studio --workspace ws_0123456789abcdef0123456789abcdef
writing-loop studio --single       # keep the legacy one-workspace URL surface
```

The registry is a convenience index, never a source of project truth: normal CLI
root discovery still uses CWD / `WRITING_LOOP_WORKSPACE`, and `remove` deletes only
the local pointer. If more than one entry is registered, Studio opens
an editorial fleet page and namespaces every workspace route under `/w/<workspace-id>/`.
With one workspace (or `--single`) the existing `/p/...` and `/api/...` routes remain
unchanged.

Studio is a loopback-only, server-rendered view over the same plain files. It
shows the drama library, story maturity, creative lanes, human decision gates,
recent episodes, and live in-flight agents. “New project” and
`/writing-loop:add-script` both collect an operator-attended interview, then call
the same onboarding core: first a deterministic **zero-write plan**, then an
explicit `planId` confirmation, atomic reservation of the final directories,
journaled creation, and write-after-read verification.
The CLI commands above expose that same plan/create/verify boundary. Creation is
limited to a brand-new repo; Studio additionally keeps it inside the workspace.
Before config makes the project visible, a durable per-project journal lets the
exact same request and original `planId` resume after a real process crash once
the complete commit/manifest evidence is durable. Earlier partial trees are
preserved and hard-stop for manual audit;
after publication, the receipt makes retries idempotent. Recovery is an explicit
retry, not a daemon: changed config/templates, a live PID, modified artifacts,
or ambiguous ownership hard-stop for manual audit.

Project pages open allowlisted, read-only details for tickets, story documents,
episodes, reports, and evaluations. Their activity view is backed by the persistent,
rebuildable `ActivityIndexer` v2 cache in each project's runtime directory. Source
ledgers, tickets, and script files remain authoritative; a metadata signature avoids
deep rescans when they have not changed, and retention/bootstrap gaps are always
reported explicitly. Pagination cursors are bound to workspace, project, and index
generation. `run-state.json` remains a live overlay only and is never written into
historical activity.

Studio's SSE event IDs combine the stable snapshot with the projects' durable index
revisions. Browsers can resume with `Last-Event-ID` after the Studio process restarts;
a cursor from another workspace (or from the fleet stream) is rejected instead of
being silently reused. The stream is still a change notification, not an event-ledger
transport—the activity API is the bounded historical read surface.
Recorded models and duration are shown; token usage and cost remain **unknown / not
recorded** when the ledger has no evidence—Studio never invents an estimate.
Besides confirmed project creation, Studio's only writes are atomic pause/resume.
A running scheduler observes a pause, stops dispatching, and completes its
graceful drain before releasing the project lock.

The room runs on exactly **three first-class Harnesses** — Claude Code (default),
Codex, or OpenCode. Their process shapes, prompt transports, provider boundary,
readiness checks, and the separate no-GPU script-writing boundary are documented in
[`docs/HARNESS.md`](docs/HARNESS.md). Select one with
`writing-loop run --cli claude|codex|opencode`; other `--cli` values are rejected.

**2. Start a project** — from an initialized workspace, use Studio's “New
project” or run the intake skill. Choose a path for a repo that does not exist
yet; do not create the folder first. The attended interview covers genre,
audience, monetization and compliance (plus rights and teardown thresholds for
adaptations). It shows a zero-write plan for approval, then the shared core
creates the document tree, registers the project, files the first outline
ticket, and verifies all three ground truths:

```
/writing-loop:add-script
```

**3. Run the room.** Each agent is a stateless skill: Claude Code and Codex can
invoke it as a slash command, while the OpenCode Harness receives the same nine
agent skills inline. Every fire re-reads ground truth from the board + repo. Drive
them in the natural order, or point external `cron` at them:

```
/writing-loop:showrunner-agent        # files the outline ticket, gates designs, promotes the queue
/writing-loop:story-designer-agent     # writes outline + bible, then per-arc beat cards, spawns episode tickets
/writing-loop:episode-writer-agent     # pulls episode tickets in order, writes drafts, declares ledger deltas
/writing-loop:reviewer-agent           # independent per-episode verification (three-way classification, cited assertions)
/writing-loop:evaluator-agent          # runs milestone-eval gates (outline lock, first-paywall pack, finale …)
/writing-loop:script-doctor-agent      # slow-cadence rotating series-level audit
/writing-loop:market-watch-agent       # weekly trend + platform-policy watch
/writing-loop:reflect-agent            # daily retro + lessons curation
/writing-loop:sweep-agent              # board hygiene, mislabel repair, orphan recovery
```

There is **no remote backend** — the board remains plain files under
`<workspace>/.writing-loop/<project-key>/board/`. The optional Studio process is
local-only and reconstructs its UI from those files; scheduling is still a
manual slash call, `writing-loop run`, or your own `cron`. Copy the folder and
you've migrated machines.

The Showrunner keeps the queue shallow (Backlog-first; only it promotes to
Todo), episode tickets flow strictly in episode order behind a sequential
prerequisite, and every fail routes through a three-tier path
(notes-rework → `Mode: direct-write` → human-park) instead of stalling.

## The agents

| Agent | dev-loop archetype | Job |
|---|---|---|
| **Showrunner** 总编剧 | PM | Sole owner of the north-star + outline; intake and direction; files creative tickets; runs the design gate; triggers milestone-eval tickets; the Backlog gate. |
| **Story-Designer** 细纲师 | senior-dev | Turns an arc ticket into per-episode beat cards (with candidate competition + rejected takes), spawns episode child-tickets, **writes keystone episodes personally**, takes `Mode: direct-write` escalations, runs punch-up. |
| **Episode-Writer** 编剧 | junior-dev | Pulls an episode ticket, reads its beat card + ledgers + the previous episode, writes the draft, self-checks, declares the ledger delta, hands off for review. |
| **Reviewer** 审读 | QA | Independent per-episode verification: three-way classification, adjacent-episode read, delta reconciliation — **every narrative assertion must carry a script quote**. Routes fails three ways. |
| **Script-Doctor** 剧本医生 | Architect | Slow-cadence, SHA-gated, rotating series-level audit (foreshadow closure, hook sequences, five anchors, passivity slide, fingerprint consistency, ledger replay). Files, never edits. |
| **Evaluator** 评估官 | — | Executes milestone-eval tickets: the six gates, the rubric, the red lines. Splits every report into *machine-assertable* vs *pending-live-data*. |
| **Market-Watch** 市场监察 | Ops | Weekly trend-board + platform-policy scan; dated genre-window assessments; a closing/red-ocean window or new policy files a `needs-showrunner` ticket. |
| **Reflect** | Reflect | Daily retrospective; curates the operator-level `lessons.md` from recurring evidence. |
| **Sweep** | Sweep | Lifecycle hygiene: mislabel repair, orphan recovery, board-health digest. |

Plus the operator skill **`add-script`** — project intake, scaffold, and
registration.

Full role contracts: [`docs/DESIGN.md`](docs/DESIGN.md) §1 +
[`references/conventions.md`](references/conventions.md) (topology overview).

## The document system

Every project is a git repo where documents *are* the code:

```
<script-repo>/
  bible/{north-star,characters,world}.md   # frozen layer — changes go through the Showrunner / design gate
  outline.md                               # master outline: unit table + five climax anchors + paywall plan
                                           #   + season-level foreshadow registry + set-piece & sequel-hook plans
  arcs/arc-NN-<slug>.md                    # per-episode beat cards + candidate competition & rejected takes
  ledgers/                                 # active layer (O_EXCL locks; ≤15KB rollup discipline)
    foreshadow.md                          #   foreshadow ledger (planted → refreshed → paid; sequel-hook state)
    story-state.md                         #   current state + per-episode end-state summary + passivity marks
    production.md                          #   production budget: scene/character registry + cost counters
    archive/arc-NN.md                      #   per-arc rollup
  episodes/ep-NNN.md                       # frontmatter fingerprint (beat-card hash / model / rules-version) + script
  evaluation/                              # milestone reports + clip lists
  source/                                  # adaptation: source text + three teardown worksheets
                                           #   original: light teardown of comparison dramas
```

Two disciplines keep past-the-gate work from silently rotting: each episode
records the **content hash** of the beat card it was written against (the Doctor
diffs it every round to find stale episodes), and any post-gate edit to an
arc/outline runs a **delta re-review** that files continuity tickets for the
affected Done episodes.

## Milestone gates

The Evaluator runs six gates against the rubric and the red lines, only ever
from a Showrunner-filed `milestone-eval` ticket:

| Gate | Trigger | Focus |
|---|---|---|
| **3-episode micro-gate** | ep3 Done | Hook strength: counter-intuitive opening conflict, first climax, end-hook sequence. |
| **Outline lock gate** | outline drafted | Market layer (cites Market-Watch, dated) + content pre-score + compliance + foreshadow-registry coverage. |
| **First-paywall pack (一卡包)** | pre-paywall episodes Done | Paywall structure, completion-rate proxy, clip list, production tally, window recheck. **The first real delivery milestone.** |
| **Paywall-2 gate** | mid-serial | Mid-structure + cumulative production layer + market recheck. |
| **Paywall-3 gate** | 2/3 point | The 2/3 valley depth, track-switch credibility, finale asset muster (each cross-checked to the script). |
| **Finale gate** | full serial Done | Full rubric + grading + sequel-hook compatibility. |

Red-line hits either file an Urgent `redline` Bug (fixable) or park the eval
ticket for a human (veto-class). Market-layer scoring with no fresh data is
reported *inconclusive*, never guessed.

## Curing the citron disease

writing-loop's design starts from a post-mortem of a failed AI serial
(citron-script): it lacked no craft knowledge — it lacked **mechanical
guarantees between the planning layer and the execution layer.** Each symptom
gets a mechanism, not an exhortation:

| citron symptom | writing-loop mechanism |
|---|---|
| The draft is written **without seeing the previous episode** | Sequential prerequisite (episode N waits on `ep-(N-1)` in main) + every writer reads the previous end-frame and all three ledgers before writing. |
| **Foreshadow has zero representation** — planted and forgotten | `foreshadow.md` three-state ledger + season-level registry in the outline + the Doctor's machine closure audit (overdue, paid-before-planted, >8 episodes unrefreshed). |
| The **final draft is the only un-audited step** | Every episode is independently verified by the Reviewer via three-way classification, with **every narrative assertion backed by a script quote** (unquotable = inconclusive = not pass). |
| The **protagonist drifts passive** | A proactivity field on each beat card + cumulative `story-state` marks + the Doctor's 10-episode passivity slide (>30% files a Bug). |
| **Skeleton and final draft come apart**; climax beats land flat | The per-episode beat card is a binding contract; keystone episodes are written by the Story-Designer personally; milestone gates verify structure against the rubric. |

The full mapping (citron's ten lessons → their mechanical carriers) is in
[`docs/DESIGN.md`](docs/DESIGN.md) §0.

## Relationship to dev-loop

writing-loop is built on the **[dev-loop](https://github.com/dyzsasd/dev-loop)**
mechanism skeleton — same-origin by design. The ticket state machine, the
Backlog-first intake, the three-way verification, the claim/dedupe/blocked
protocols, the two-tier creation split (senior designs → junior implements), the
observe-and-file contract, the lessons + reflect self-evolution loop, and the
local file-board protocol are all carried over. The mapping:

| dev-loop | writing-loop |
|---|---|
| PM → strategy doc | Showrunner → north-star |
| senior-dev / junior-dev | Story-Designer / Episode-Writer |
| QA | Reviewer |
| Architect | Script-Doctor |
| Ops | Market-Watch |
| design doc | arc beat card |
| build/test gates | format + narrative gates |
| coverage mandate | ledger write-back mandate |
| auto-rollback | fail-revert protocol |

What's dropped: PRs / auto-merge / deploy, the multi-repo change-gate (the idea
survives in the Doctor), the Linear/hub backends (v1 is local-only), and the
Communication/Codex agents. See [`docs/DESIGN.md`](docs/DESIGN.md) §11 for the
full carry-over / replace / cut ledger.

## v1 boundaries

- **Local board only.** The single source of truth is a plain file board under
  `<workspace>/.writing-loop/` (protocol in [`references/conventions.md`](references/conventions.md)
  §18). Studio is a loopback-only projection, not a second backend. No Linear,
  cloud service, or network share. Scheduling is manual slash, the built-in
  scheduler, or your own `cron`.
- **Phase 2 foundation is complete, not full product parity.** Confirmed onboarding,
  journaled same-fingerprint crash recovery, allowlisted details, persistent bounded
  activity, restart-resumable SSE, stable workspace identity/registry, and the
  multi-workspace Studio namespace are delivered. Rich writing analytics and real
  provider cost collection still require new authoritative ledger fields; absent
  evidence remains `unknown`, never estimated.
- **Phase 3C delivers a remotely deployable production control plane and private Gateway kernels,
  not a bundled GPU appliance.** It builds on the Phase 3A/3B ledger, gates and crash-recoverable
  coordinator with zero-network plan/confirm enqueue, a one-shot production worker, owner-only
  runtime configuration, per-workflow input policy, an H3 four-model/fixed-pipeline contract,
  source→consumer staging, template→bound graph materialization, verified receipts, durable
  admission settlement, and scope-bound stage/job/output Gateway handlers behind a strict router. Studio's production
  HTTP surface remains read-only; endpoints, profiles and tokens cannot come from browser or
  enqueue arguments. A real deployment must still provide H3/ComfyUI inference, TLS/mTLS,
  credential issuance, pinned server profiles and model/custom-node attestation, asset storage,
  durable admission/quota, provider billing reconciliation, and any verified writable Studio API.
  The representative API-format fixture has not passed a live ComfyUI `/prompt` and is not an H3
  deployment claim. H3 is a shot-level audio/video generator, not the script-writing model.
- **Calibrated genres only.** The R-rule numeric parameters are calibrated
  (evidence-based) for **brainstorm-thrill / revenge-face-slap / episodic
  professional** dramas. Female-lead sweet-pet / tragic-romance profiles ship
  marked **`UNCALIBRATED`** (tentative parameters) — `add-script` warns
  explicitly when you start a project on an uncalibrated genre.
- Monetization and format are one-switch parameterized
  (`paid-app | free-hongguo | reelshort-sub`; `live-action | ai-anime |
  reelshort-en`), which reshapes gate positions and paywall semantics.

## License

[MIT](LICENSE).
