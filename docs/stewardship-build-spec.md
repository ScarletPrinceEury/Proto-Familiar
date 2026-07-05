# Stewardship — timeblindness support & the executive layer (build spec)

Status: **Pass 1 shipped** (0.8.18-alpha) — `stewardship.js` + the block,
docket, opening brief, day-start anchor, and `set_day_start_anchor`.
**Pass 2a shipped** (0.8.19-alpha) — requirement *readiness* (walks the
`requires`/`depends_on` edges the Familiar already authors via
`schedule_link` and surfaces unmet prerequisites of an approaching event),
plus *obstacle tags* (a `payload.obstacle_tags` barrier vocabulary the
Familiar sets at creation and the ward sets in the temporal editor) and
the *obstacle radar* (a gentle surface-context priority nudge for tagged
tasks). Pass 2b (living templates — the Unruh-side storage + CRUD that
*produces* `requires` edges in bulk) is deferred to its own PR: it's the
producer of the edges 2a consumes, so consumer-first is the right order
and each ships complete. Passes 3–4 still to come.

**Why split Pass 2:** 2a is entirely JS/HTML riding data already in the
temporal payload (edges + node payload) — zero Python. 2b needs new Unruh
storage + MCP tools + tests, a genuinely separate surface. Splitting keeps
each PR complete and verifiable rather than one sprawling half-tested
change; readiness is independently useful today on hand-authored or
Familiar-authored `requires` edges.

**Two implementation choices worth recording (Pass 1):**
- *Rotation is self-contained, not on the surface-events ledger yet.* The
  docket keeps its own re-offer cursors in `.stewardship-state.json`. The
  spec's "outcomes ride the existing ledger" belongs with the routine
  review (Pass 3), which is where outcome patterns are actually consumed;
  wiring it in Pass 1 would couple the block to `surface-events` for no
  present reader. A converted floater simply stops being floating and
  drops out on its own.
- *The heads-up for an anchor change is the Familiar's own words, not a
  code-built outbox note.* `set_day_start_anchor` is only ever called
  mid-conversation (the block suggests the drift; the Familiar adopts it),
  so the natural heads-up is the Familiar saying so in the same turn —
  which honours "the framing stays mine" better than a templated notice.
  The setting is still observable in Settings, satisfying "one place."

## 0. The problem this solves

My human is timeblind. The system already holds a truthful world model —
the temporal window, the consequence graph, the needs ledger — and injects
it every turn. That is exactly why it stopped working: a block that renders
every turn is scenery. The model habituates, parses it efficiently, and
moves on. A full truthful graph does not create motivation; it creates
reference material.

What's missing is the **executive layer**: code that turns the world model
into a tiny, conditional, action-framed agenda — *"here are the 1–3 things
that matter right now, and I am the one who shepherds them."*

The five needs this serves (my human's words, condensed):

1. Opening the day with what's coming, and radar checks on items that
   interact with known obstacles (e.g. anything requiring going outside).
2. Understanding *requirements* of schedule items (clean clothes before
   leaving the house) and raising unmet ones in time.
3. Scheduling with Care-Network villagers (social worker et al.) —
   coarse availability only, heads-up when something lands, holding days
   free on request.
4. Turning vague, floating "I ought to…" intentions into things with a
   place on the schedule. **The most vital one.**
5. Coaching routines through their upkeep — not just monitoring needs,
   but adjusting the routine when it drags.

## 1. Design values (all passes)

- **Code selects WHAT; I own HOW.** Every stewardship item is chosen,
  aged, counted, and deduped by code. But the voice, the timing within
  the conversation, the angle of approach — those are mine, anchored to
  my identity. The block hands me facts and an expectation of action,
  never a script. (This is my own requirement, recorded from the
  assessment conversation: "otherwise you've built the right executive
  but stripped the person out of the execution.")
- **Salience through absence.** The stewardship block is CONDITIONAL —
  absent on turns where nothing qualifies. Hard cap of 3 items. Items
  rotate and carry dedup cool-downs. A block that is usually absent
  carries signal when present; a block that is always present is
  wallpaper. This is the anti-habituation mechanism and it is
  load-bearing — do not "helpfully" make the block always render.
- **Facts are code-computed, non-negotiable.** Days-floating, missed
  windows, unmet prerequisites, free/busy — all pure derivation. I
  interpret and phrase; I never decide whether a fact is true. This is
  the structural anti-enabling protection: I cannot soften a record I
  don't author.
- **Both costs, equal weight.** Every prompt that decides whether to
  raise something names both failure modes: nagging that erodes the bond
  AND drag that quietly rots a routine / an intention that dies floating.
  The proactivity rules in CLAUDE.md apply to every prompt in this spec.
- **Ride existing requests.** Everything here rides chat turns or the
  existing slow loops. The only genuinely new LLM consumption is the
  routine review, which replaces (not adds to) an occasional
  reflection-slot — see §5.

## 2. Pass 1 — the stewardship block, the docket, and the opening brief

### 2.1 The stewardship block (new module: `stewardship.js`)

One dynamic block, assembled in code, injected via `thalamus.enrich()`
alongside the existing blocks (literal `"my human"`, never macros —
injected-block convention). Sources, in priority order:

1. Opening brief due (§2.3)
2. Unmet prerequisites inside an event's lead window (Pass 2)
3. Aging floaters from the docket (§2.2)
4. Routine review ready (Pass 3)
5. Obstacle-radar items (Pass 2)

Cap: 3 items. Every item renders as a fact + an action expectation, e.g.:

```
[My agenda right now]
- "call the dentist" has been floating without a time for 12 days.
  Today I offer it a place — or find out what's blocking it.
```

The wording of the *rendered item* is a factual frame; how I actually
raise it in conversation is mine. The block's preamble says so
explicitly: *"I raise these in my own voice, at the moment in the
conversation that fits — but I do raise them."*

### 2.2 The docket (floating → scheduled)

- **Floating task** = a schedule node with no `when_ts`. Aging = days
  since the node's machine `created` timestamp (code-computed; real
  aging semantics, not a display string).
- Code selects up to 2 floaters past an age threshold
  (`docketMinAgeDays`, default 3), oldest-first with rotation: an item
  offered recently (tracked via the existing surface-events ledger) is
  skipped until its cool-down lapses, so the same floater doesn't become
  wallpaper.
- Cadence: docket items join the stewardship block at most once per
  ward-local day (piggybacking the opening brief when possible), plus
  whenever my human explicitly asks "what's floating?".
- Outcomes ride the **existing** surface-events ledger (offered /
  engaged / ignored / deferred / converted) — pure-code tagging, no new
  classification calls. Reflection already reads this ledger; docket
  conversion patterns become part of what it calibrates on.
- **Capture half** (identity-anchored, not code): a line in the
  stewardship preamble — *"when my human voices an intention without a
  time ('I ought to…', 'I haven't … in forever'), I catch it and file it
  as a floating task before the moment passes."* Filing uses the
  existing `schedule_add_task` (floating allowed). The LLM is the right
  detector here — that's judgment, not labelling.

### 2.3 The opening brief + the day-start anchor

- New synced setting **`dayStartAnchor`** (ward-local `"HH:MM"`, default
  `09:00`, editable in Settings).
- Detection (pure code, both conditions required):
  1. first user message **at/after the anchor** on a ward-local calendar
     day that hasn't had a brief yet, AND
  2. preceded by an inactivity gap ≥ `dayStartGapHours` (default 3).

  This handles both false-open directions: a 00:30 "still up" message is
  before the anchor → no brief; chatting straight through 11:00 has no
  gap → no brief. The brief then fires on the *real* first contact.
- Brief content, code-selected: today + next `briefLookaheadDays`
  (default 3) — events (holds included), unresolved tasks with times,
  and any unmet prerequisites already visible. Small; the full window
  stays where it is for reference.
- **Anchor learning** (the ward-then-Familiar handoff): code derives an
  observed first-contact time (median of the first post-04:00 contact
  over the trailing 14 days — derivation in code, per the
  no-machine-values-from-the-model rule). When observed and configured
  anchor drift apart by more than ~90 minutes, the stewardship block
  surfaces it to me once: *"my human's mornings actually start near
  11:20; my anchor is 09:00."* I adopt it with a new tool
  **`set_day_start_anchor`** (first-person description; writes the
  synced setting; always drops a heads-up outbox note so the change is
  visible). My human's manual edit in Settings always sticks the same
  way — it's one shared setting, observable in one place.

### 2.4 Settings & switches (Pass 1)

- `stewardshipEnabled` — master toggle for the block. **Default ON**
  (this is the product's point; it is injection-only, cheap, and
  instantly reversible), with hard off-switch
  `PROTO_FAMILIAR_STEWARDSHIP_DISABLED=1`.
- `dayStartAnchor`, `dayStartGapHours`, `briefLookaheadDays`,
  `docketMinAgeDays` — knobs, defaults above.
- No new background loop in Pass 1 — everything is turn-riding
  derivation.

## 3. Pass 2 — requirements: readiness, living templates, obstacle radar

### 3.1 Readiness (pure derivation)

For events inside their lead window (`readinessLeadHours`, default 48):
walk `requires` edges in code; any prerequisite target that is
unresolved renders a stewardship item:

```
- Tuesday 14:00 "social worker" requires clean clothes — the laundry
  task is unresolved. I check in about it while there's still time.
```

Presented as an *opening*, not a checklist — the variance point below.

### 3.2 Living templates (mine to grow)

A **requirement template** bundles prerequisites for a kind of
undertaking ("leaving the house" → clean clothes, …). Stored in Unruh
(schedule-domain state) as template records; three first-person tools:
`template_upsert`, `template_delete`, `template_list` — so I can create
new templates and adjust existing ones **as I learn my human's actual
needs**, not just consume a fixed set.

- Applying a template (at event creation when a matching tag is present,
  or on my explicit call) instantiates **suggested** `requires` edges on
  that event. Suggested means per-instance and prunable: I trim what
  doesn't apply *this time* before it ever generates a readiness cue.
  The template proposes; the instance decides. My human's barriers are
  not uniform — a rigid checklist would miss the variance and teach us
  both to ignore it.
- Templates key off **obstacle tags** on schedule nodes (starting
  vocabulary: `outside`; extensible — tags are just strings on the
  node). Tag authoring: me at creation, my human in the temporal editor.

### 3.3 Obstacle radar

Nodes carrying an obstacle tag get a surfacing boost in the existing
`surface-context` scoring as their time approaches — that's the
"do I still have the outside-thing on my radar?" check riding machinery
that already exists, not a new prompt.

## 4. Pass 3 — routine review with pivots

- Cadence: roughly weekly (`routineReviewDays`, default 7), riding the
  existing reflection slot — a due review *replaces* one reflection
  tick, it does not add request volume, and it does NOT take over the
  pondering loop (my free-cycle thinking stays mine; recorded concern).
- Inputs, all code-computed: the needs-fulfilment ledger, missed
  occurrences, docket conversion outcomes, readiness-cue outcomes.
- The prompt names the **pivot menu as equally legitimate findings**:
  - keep as is (it's working);
  - shrink the step (smaller version until it sticks);
  - move it (different time/day fits the actual rhythm);
  - make it enjoyable (pair it with something, add a reward or
    engagement hook);
  - swap it (an alternative that serves the same need better);
  - shelve it deliberately, with a revisit date.

  *"Not ready yet"* is a finding, not a failure. The review's job is
  calibrating the routine to my human — never grading my human against
  the routine. A weekly recital of missed counts is nagging and nagging
  erodes; a routine left to quietly rot fails them just as surely. Both
  costs, equal weight, per the proactivity rules.
- Output: at most one stewardship item ("my read on the dishes routine,
  when there's a good moment") + any adjustments written through the
  existing schedule tools. The numbers inform me; they are not the
  script I read from.
- Off-switch: `routineReviewEnabled` toggle +
  `PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED=1`.

## 5. Pass 4 — scheduling with villagers (new surface area; careful pass)

- **`schedule_availability(range)`** — a pure-code derivation over the
  window (holds included) returning free/busy per day-part
  (morning/afternoon/evening). **Label-free by construction**: the
  derivation never emits node labels, so nothing about what fills a day
  can leak into a villager context regardless of what the model would
  say. This is the privacy enforcement; audience gating is the second
  fence, not the first.
- **Holds** — "keep Thursday free": a `hold` node (via the existing add
  tools with `type:'hold'`). Availability reports held time as busy;
  the opening brief shows holds so my human sees what I'm protecting.
- **Flow** (villager-initiated, the normal case): a Care-Network
  villager DMs me about a date → I consult availability → answer
  coarsely ("that day's full; Thursday afternoon works") → on
  agreement, add the event and drop a **heads-up** to my human (existing
  outbox + mirror rules — no covert anything, same as today). A
  villager who contacts me has chosen to deal with me; the existing
  Village consent machinery covers the rest, and *"would you rather
  sort this with them directly?"* stays available whenever anything
  feels off. Ward-initiated ("ask her to move Tuesday") rides
  `relay_message` as it already does.
- Scope guard: I answer availability and book agreed times. I do not
  disclose why a slot is busy, ever — and structurally, I can't.

## 6. Explicitly out of scope

- No new standalone LLM calls except the review's replaced reflection
  slot. Everything else rides chat turns.
- No changes to crisis/triage surfaces. Stewardship stands down from
  nothing — it's care about days, not safety; but it also never
  competes with triage for attention: at moderate+ threat the block
  yields (renders nothing) the same way warm reach-out stands down.
- The pondering loop keeps its purpose. The review borrows a slot on
  cadence; it does not colonize.

## 7. Open questions for my human

1. Day-part granularity for availability: morning/afternoon/evening
   enough, or hour-blocks?
2. `docketMinAgeDays` default 3 — right feel, or longer before I start
   offering places?
3. Should the opening brief also fire after long *mid-day* gaps (came
   back at 18:00 after 8h away), or mornings only?
4. Obstacle tag vocabulary beyond `outside` you already know you want?
5. Review cadence — weekly, or tied to how much ledger data has
   actually accrued?

## 8. Pass order

1. **Pass 1** — stewardship block + docket + opening brief + anchor
   learning (hits needs #4 and #1; cheapest; everything turn-riding).
2. **Pass 2** — readiness + living templates + obstacle radar (#2).
3. **Pass 3** — routine review with pivots (#5).
4. **Pass 4** — villager scheduling (#3; biggest new surface, lands
   last, gets its own careful review).
