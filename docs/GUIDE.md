# Guide: From a Novel to a Script

**English** · [中文](GUIDE.zh-CN.md) · [Français](GUIDE.fr.md)

> This is the most important doc: the complete, hands-on path from installing the
> plugin to shipping your first deliverable / testable **first-paywall pack
> (一卡包)**. It defaults to the **novel-adaptation** track; the **original-creation**
> differences are at the end.

---

## Prerequisites

- **Claude Code or Codex** CLI installed — either works (install commands in the
  README; this guide uses Claude Code in its examples).
- `git` on your machine.
- The novel as **plain text** (`.txt` / `.md`; convert PDF/EPUB to text first).

---

## Step 0 — Install the plugin

Inside Claude Code:

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

You now have the `/writing-loop:*` slash commands (9 agents + `add-script`).

---

## Step 1 — Make the script project folder, drop in the novel

**Workspace vs. script repo**: a **workspace** is a plain folder holding one or more
**script repos** (each drama is its own git repo — “documents *are* the code”) plus a
`.writing-loop/` runtime-state dir (config + board + lessons, created automatically by
`add-script`). **Copying this one workspace folder = migrating every drama + its
in-flight tickets** (see "Migration" at the end).

Below, `~/dramas/` is your workspace and `my-drama/` is one drama's repo:

```bash
mkdir -p ~/dramas/my-drama/source          # ~/dramas = workspace, my-drama = script repo
git -C ~/dramas/my-drama init
cp /path/to/your-novel.txt ~/dramas/my-drama/source/novel.txt
```

> Key point: the novel text must live under the script repo's `source/` — the
> adaptation teardown works from it.

In Claude Code, change the working directory to this project folder
(`cd ~/dramas/my-drama`), then go to Step 2. (`add-script` treats `~/dramas/` as the
workspace root and creates `.writing-loop/` under it; for the first drama it confirms
that root with you.)

---

## Step 2 — Onboard the project (adaptation) — one command

```
/writing-loop:add-script
```

It **interviews you** (it re-asks for anything missing; it never sneaks
placeholders into config). For the adaptation track, be ready to answer:

**Required for every project**

- **key**: lowercase project key (e.g. `my-drama`) — the data-dir name + ticket
  prefix + config key; unique across the workspace.
- **title**: the drama's title.
- **Audience profile (hard gate)**: must include **gender + age** (region / paying
  habits recommended). Vague or missing = blocked — this is the entry-side
  prevention of evaluation red-line ①.
- **Compliance pre-screen**: politics / crime (unpunished illegality) / romance
  ethics / platform-policy boundaries, one by one; the conclusions are written into
  `bible/north-star.md`'s Non-goals (a lasting constraint, re-checked at every gate).
- **genre profile**: `brain-hole` / `revenge-slap` / `profession-unit` are
  calibrated; female-lead `sweet-pet` / `angst` are **UNCALIBRATED** — you'll get an
  explicit warning that the parameters are tentative and quality is at risk.
- **monetization**: `paid-app` / `free-hongguo` / `reelshort-sub` (reshapes paywall
  and gate semantics).
- **format**: `live-action` / `ai-anime` / `reelshort-en` (sets the word band and
  the production budget table; for ai-anime, cheap VFX is a strength).
- **Scale**: `totalEpisodes`, `paywall` (backup card numbers; card 1 ⊂ episodes
  8–12), `maxPrimaryScenes`, `maxNamedCharacters`.

**Adaptation-only (runs automatically)**

- The novel text is already in `source/` → it runs the **book-selection checklist**
  (can the mainline compress ≥10:1? set-piece density? character compressibility?)
  and flags risk if it falls short.
- It produces the **three teardown worksheets** into `source/`: `mainline.md`
  (mainline skeleton), `highlights.md` (set-piece / thrill-beat list — the IP's core
  asset), `characters-function.md` (character function table, compressed to 3–5 core
  / ≤20 named).
- **Fidelity tier**: defaults to **close-adaptation (贴改)**; **shell-borrowing is
  disabled by default** and written into Non-goals.
- **Rights boundary**: bounded by the license (recorded in north-star); no
  recognizable elements from other IP.

Then `add-script` automatically:

- **SCAFFOLD**: generates `bible/` (north-star / characters / world), `outline.md`,
  `ledgers/` (foreshadow / story-state / production + archive/), `episodes/`,
  `evaluation/`; `git commit`.
- **REGISTER**: registers the project in `~/dramas/.writing-loop/config.json`, creates the
  board dir `~/dramas/.writing-loop/my-drama/board/`, scaffolds the `lessons/` dir
  (one shared file + one per role).
- **First outline ticket**: files one outline ticket (owner=showrunner,
  tier=story-designer).
- **VERIFY**: re-reads, validates, and tells you the next step.

> The `add-script` interview asks for the mode — answer `dry-run` the first time:
> it only prints what it *would* do, writing nothing and committing nothing. Once
> you've confirmed the interview conclusions, run `/writing-loop:add-script` again
> and answer `live` to onboard for real.

---

## Step 3 — Run the writers' room

Each agent is a slash command and is **stateless**: every run re-reads ground truth
from the board + repo and does whatever its role has ready, or no-ops. They hand off
**only through tickets** — you never pass work by hand.

**First cycle (the natural order for adaptation):**

```
/writing-loop:showrunner-agent       # owns direction, gates, milestones and later releases (the outline ticket was filed straight to Todo by add-script — §5a exemption — so the story-designer can pick it up directly)
/writing-loop:story-designer-agent    # reads the teardown worksheets → writes outline.md + bible; then per-arc beat cards
/writing-loop:market-watch-agent      # dated genre-window assessment — the outline-lock gate's market layer depends on it; missing data makes that item inconclusive, and red-line cases park for you to supply it
/writing-loop:evaluator-agent         # outline-lock gate (market + content pre-score + compliance)
/writing-loop:episode-writer-agent    # writes episodes in order; keystone episodes are written by the Story-Designer
/writing-loop:reviewer-agent          # independent per-episode review (three-way classification + adjacent read + quoted assertions); fails route three ways
```

After that it's a **rotation**: `showrunner → story-designer → episode-writer →
reviewer → evaluator → script-doctor`, repeat, until a milestone.

**Keystone-tier reminder**: keystone episodes (first 3 / paywall episodes / finale)
must be reviewed by a top-tier reviewer — run `/writing-loop:reviewer-agent` on
`opus`/`max`, otherwise the episode is skipped for a higher-tier fire and the
pipeline stalls (sweep flags it in the board-health digest). The built-in scheduler
(`writing-loop run`, below) does this automatically: whenever a keystone episode is In Review,
the reviewer fire it launches is escalated to the top tier.

You don't need to memorize the exact order — **the board enforces the real
ordering**: episode N can't be written until `ep-(N-1)` is Done; child tickets
aren't released until the outline passes its gate; milestone gates use `Blocked-by`
to block over-production. Any agent that finds nothing to do reports "no work" and
exits — just run the next one.

**To automate** (instead of typing them one by one): the preferred route is the npm
CLI — install once globally, then run from the workspace folder:

```bash
npm i -g @dyzsasd/writing-loop     # once
writing-loop run --dry-run         # print every resolved fire command first
writing-loop run                   # one process drives all 9 agent loops, Ctrl-C to stop
```

(Prefer no global install? `npx @dyzsasd/writing-loop run` works the same. The
scheduler is implemented natively inside the npm package — no Python required.)
One process fires
every agent on its own cadence and guarantees what hand-run rotations and cron
can't: the four repo-writing roles (showrunner / story-designer / episode-writer /
evaluator) run one-at-a-time **by construction** (no interleaved commits); keystone
episodes automatically get a top-tier reviewer fire; every fire has a wall-clock cap
and is logged to `.writing-loop/<key>/fires.jsonl`. The scheduler is also
**work-gated**: before each fire it takes a cheap look at the board
(frontmatter-only parse) and simply doesn't spawn a session when that agent has
nothing to do — idle turns no longer pay the token tax of a full boot (conventions,
lessons, …). The reviewer's default tier is opus/high; only keystone acceptance is
escalated to the top tier. `--once` does a single pass;
per-agent cadence/model/effort live in the `scheduler` block of config.json (see
references/config-schema.md). Because every fire is stateless, starting and stopping
is always safe.

**Switching engines**: by default the scheduler fires through Claude Code; you can
move the whole room to Codex or opencode:

```bash
writing-loop run --cli opencode
```

opencode has no built-in default model — first set a `provider/model`-shaped tier in
config.json, e.g. `scheduler.agents.episode-writer.model = "openrouter/anthropic/claude-sonnet-4.5"`,
and run `opencode auth login` once beforehand. (`--cli codex` switches to Codex the
same way; tier names are converted automatically.)

---

## Step 4 — Watch the milestones; the first deliverable is the 一卡包

The Evaluator produces reports at key points (into `evaluation/`):

| Gate | Trigger | What you get |
|---|---|---|
| 3-episode micro-gate | ep3 Done | Hook-strength check (ep1 counter-intuitive conflict, ep3 first climax) |
| Outline-lock gate | outline drafted | Market + content pre-score, compliance, foreshadow-registry coverage |
| **First-paywall pack (一卡包)** | first 10 episodes Done | **The first truly deliverable / testable output**: Bible + first 10 episodes + clip list + completion-rate proxy score |
| Paywall-2 / -3 / Finale gates | mid / 2/3 point / full serial | Progressive scoring; the finale gate assigns an S+…C grade |

**After the first-paywall gate comes the "operator decision point"** — the system
stops and waits for your call: take the pack out to test with real data, or keep
producing. This is your main control lever.

---

## How the system reaches you (the human-in-the-loop circuit)

- **Human-parked tickets**: anything only you can decide (direction change, veto,
  fix-exhausted, waiting on launch data) surfaces as a parked ticket. With
  `comms.provider` configured, the system pushes one out-of-band notification
  (ticket ID + the decision needed); without it, check the daily digest's
  needs-attention section (under `~/dramas/.writing-loop/my-drama/reports/`).
- **Waiting at the gate**: after the first-paywall gate the system stops and waits
  for your decision — it never keeps producing on its own (see Step 4).
- **Giving an agent feedback**: write a `<report-name>.review.md` **sibling file**
  next to that agent's report (same `~/dramas/.writing-loop/my-drama/reports/`
  directory). On its next run the agent distills your notes into its own lessons
  role file (`lessons/<role>.md`), changing its behavior durably.
- **Evaluation reports**: under the script repo's `evaluation/`.

---

## Where the outputs are / how to check progress

- **Scripts**: `~/dramas/my-drama/episodes/ep-001.md …`
- **Outline & bible**: `outline.md`, `bible/`
- **Foreshadow / state / production ledgers**: `ledgers/` (the core of anti-fracture
  and anti-lost-foreshadow)
- **Evaluation reports**: `evaluation/`
- **Ticket board** (what the team is working on):
  `~/dramas/.writing-loop/my-drama/board/tickets/*.md`

> All runtime state (config + board + lessons + reports) lives under
> `~/dramas/.writing-loop/` — a **sibling of the script repos**, so ticket state
> **never pollutes your prose git history**.

---

## Migration: copy one workspace to move everything

Because config uses **relative `repoPath`** and the runtime state lives inside the
workspace, migrating everything (in-flight tickets included) is one copy:

```bash
cp -r ~/dramas /new/place/dramas      # scripts + outlines + ledgers + in-flight board, together
```

- Use **`cp` (not `git clone`)**: a clone brings only one script repo's creative
  output, not the in-flight tickets.
- To move only the **finished creative output** (no in-flight scheduling state):
  `git clone ~/dramas/my-drama` — each script repo is self-contained (bible / outline
  / ledgers / episodes all inside it).
- Don't put the workspace on a network share for concurrent multi-machine writing (it
  would race); sequential copy-to-migrate is fine.

---

## Upgrading the plugin (with a project in flight)

**Upgrading migrates no data** — board/ledger/script-repo formats are stable, and every
agent fire is stateless and re-reads the latest spec; upgrading = swap the plugin +
restart the loops. Five steps:

1. **Stop the loops at a safe moment**: for each agent's loop window, wait until the
   current fire finishes printing (no-op or done), then Ctrl-C; if an agent is
   mid-episode, let it commit first. (Even a mid-fire kill is covered by the 60-minute
   orphan recovery — you just waste half a run.)
2. **Update the plugin**: in Claude Code, open the `/plugin` menu and update
   writing-loop (the marketplace source points at GitHub and pulls the new version);
   failing that, uninstall then re-run `marketplace add dyzsasd/writing-loop` + install.
3. **Verify the version**: in a fresh session, run any agent — idle agents should
   exit with a one-line no-op (no long boot); or check that the plugin cache directory
   shows the new version number.
4. **Restart the loops** the same way you started them. The first showrunner fire will
   do one full boot ("first board snapshot counts as changed") — that's normal.
5. **Re-check model tiers while you're at it**: during the keystone phase (first 3
   episodes / paywall / finale), the reviewer must run at top tier (opus/max) — the
   upgraded sweep flags stalled keystone episodes in its digest.

(Optional) To adopt the copy-one-folder migration layout: **move** (`mv`, not copy —
two copies of the same project would shadow each other by proximity) the old
`~/.writing-loop/` into your workspace folder and switch `repoPath` in config to the
relative directory name; update any hardcoded path in your launcher script too. Not
migrating is fully compatible — the new resolver walks up and finds the old
`.writing-loop/` in your home directory.

---

## A minimal worked example (what you actually type)

```
# 1. Install (once)
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```
```bash
# 2. Make the repo, drop in the novel
mkdir -p ~/dramas/nanny-revenge/source && git -C ~/dramas/nanny-revenge init
cp ~/Downloads/nanny-novel.txt ~/dramas/nanny-revenge/source/novel.txt
```
```
# 3. Onboard (from inside ~/dramas/nanny-revenge) — dry-run first to review the interview
/writing-loop:add-script
# Answer roughly: key=nanny-revenge, title=<drama title>,
# audience=female 28-45 lower-tier-market paying users, genre=revenge-slap,
# monetization=paid-app, format=ai-anime, totalEpisodes=40, card1=episode 10
```
```
# 4. Drive the room (after the dry-run checks out, run add-script again answering live, then rotate)
/writing-loop:showrunner-agent
/writing-loop:story-designer-agent
/writing-loop:market-watch-agent
/writing-loop:evaluator-agent
/writing-loop:episode-writer-agent
/writing-loop:reviewer-agent
# …repeat the rotation until the first-paywall gate → decision point
```

---

## Two reminders

1. **Dry-run before live.** The interview conclusions (audience, genre, paywall
   positions) constrain the whole pipeline for a long time — worth double-checking.
2. **Female-lead sweet-pet / tragic-romance are UNCALIBRATED.** They run, but the
   beat parameters are tentative and `add-script` warns you; the three male-lead
   genres (brain-hole / revenge / profession) have evidence-based calibration and
   are the most reliable.

---

## What's different for original creation (not starting from a novel)

At Step 2, `add-script` takes the **original fork**: no source text; instead you
provide **comparison dramas** (+ heat + how you differ), and the system runs a light
teardown of 1–2 of them (structure skeleton / thrill list / hook sequence) into
`source/` for the outline stage. Everything else (Steps 3–4) is **identical** — the
two tracks fork only before the outline and converge after.

---

Want to see it in action? Give me any novel text you have on hand, and I can
actually run `add-script` + the first cycle and produce real outputs (outline,
first few episodes, evaluation report).
