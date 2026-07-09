# Guide: From a Novel to a Script

**English** · [中文](GUIDE.zh-CN.md) · [Français](GUIDE.fr.md)

> This is the most important doc: the complete, hands-on path from installing the
> plugin to shipping your first deliverable / testable **first-paywall pack
> (一卡包)**. It defaults to the **novel-adaptation** track; the **original-creation**
> differences are at the end.

---

## Prerequisites

- **Claude Code** installed (this project is a Claude Code plugin).
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

Each drama = its own git repo (“documents *are* the code”). Create an empty folder
and put the source novel inside:

```bash
mkdir -p ~/dramas/my-drama/source
git -C ~/dramas/my-drama init
cp /path/to/your-novel.txt ~/dramas/my-drama/source/novel.txt
```

> Key point: the novel text must live under the script repo's `source/` — the
> adaptation teardown works from it.

In Claude Code, change the working directory to this project folder
(`cd ~/dramas/my-drama`), then go to Step 2.

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
- **REGISTER**: registers the project in `~/.writing-loop/config.json`, creates the
  board dir `~/.writing-loop/my-drama/board/`, scaffolds `lessons.md`.
- **First outline ticket**: files one outline ticket (owner=showrunner,
  tier=story-designer).
- **VERIFY**: re-reads, validates, and tells you the next step.

> For the first run, add “use dry-run mode” — it only prints what it *would* do,
> writing nothing and committing nothing. Confirm the interview conclusions, then
> switch to `live`.

---

## Step 3 — Run the writers' room

Each agent is a slash command and is **stateless**: every run re-reads ground truth
from the board + repo and does whatever its role has ready, or no-ops. They hand off
**only through tickets** — you never pass work by hand.

**First cycle (the natural order for adaptation):**

```
/writing-loop:showrunner-agent       # promotes the outline ticket to Todo; then owns direction, gates, milestones
/writing-loop:story-designer-agent    # reads the teardown worksheets → writes outline.md + bible; then per-arc beat cards
/writing-loop:evaluator-agent         # outline-lock gate (market + content pre-score + compliance)
/writing-loop:episode-writer-agent    # writes episodes in order; keystone episodes are written by the Story-Designer
/writing-loop:reviewer-agent          # independent per-episode review (three-way classification + adjacent read + quoted assertions); fails route three ways
```

After that it's a **rotation**: `showrunner → story-designer → episode-writer →
reviewer → evaluator → script-doctor`, repeat, until a milestone.

You don't need to memorize the exact order — **the board enforces the real
ordering**: episode N can't be written until `ep-(N-1)` is Done; child tickets
aren't released until the outline passes its gate; milestone gates use `Blocked-by`
to block over-production. Any agent that finds nothing to do reports "no work" and
exits — just run the next one.

**To automate** (instead of typing them one by one): use `/loop` to rotate them on
an interval, or point system `cron` at these commands. Because every fire is
stateless, starting and stopping is always safe.

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

## Where the outputs are / how to check progress

- **Scripts**: `~/dramas/my-drama/episodes/ep-001.md …`
- **Outline & bible**: `outline.md`, `bible/`
- **Foreshadow / state / production ledgers**: `ledgers/` (the core of anti-fracture
  and anti-lost-foreshadow)
- **Evaluation reports**: `evaluation/`
- **Ticket board** (what the team is working on):
  `~/.writing-loop/my-drama/board/tickets/*.md`

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
# 4. Drive the room (switch config to live once confirmed, then rotate)
/writing-loop:showrunner-agent
/writing-loop:story-designer-agent
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

Want to see it in action? Give me a novel's text, or point me at one under
`examples/`, and I can actually run `add-script` + the first cycle and produce real
outputs (outline, first few episodes, evaluation report).
