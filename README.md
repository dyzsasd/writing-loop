# writing-loop

**English** · [中文](README.zh-CN.md)

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

**1. Install the plugin** (once, inside Claude Code):

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

**2. Start a project** — run the intake skill from an empty project folder. It
interviews you (genre, audience profile, monetization, compliance pre-screen;
for adaptations, the source text + book-teardown), scaffolds the bible /
outline / ledgers / episodes tree, registers the project, and files the very
first ticket (the outline ticket):

```
/writing-loop:add-script
```

**3. Run the room.** Each agent is a slash command; a fire is stateless and
reads ground truth from the board + repo every time. Drive them in the natural
order, or point external `cron` at them:

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

There is **no separate CLI and no server** — the board is plain files under
`~/.writing-loop/<project-key>/board/`, and scheduling is either a manual slash
call or your own `cron`. Copy the folder and you've migrated machines.

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

- **Local board only.** The single backend is a plain file board under
  `~/.writing-loop/` (protocol in [`references/conventions.md`](references/conventions.md)
  §18). No Linear, no hub, no network share. Scheduling is manual slash or your
  own `cron`.
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
