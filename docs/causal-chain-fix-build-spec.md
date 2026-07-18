# Causal-chain fix — build spec

**Status: Pieces 1–3 SHIPPED (0.8.107). Piece 4 still awaits the ward's
decision.** Deviations from the draft, made while building:

- **Piece 1** reuses `gcal-projection.js`'s existing pacing regime
  (state in `tomes/.gcal-projection-cue.json`: 3 turns / 48h aging, 3
  per turn) instead of the drafted per-node `payload` cooldowns — one
  pacing regime for both sources, no node-payload state. Candidates
  come from the temporal briefing's window (reaches ~7 days ahead)
  rather than a separate 14-day fetch — no new request; events further
  out get their cue as they enter the window, still with days of
  runway. The last-chance re-surface (decision 2) is built: one extra
  look within 48h of the event. The cue rides chat turns; wiring it
  into noticing deliberations is deferred until wanted.
- **Piece 2** shipped per spec (72h window, question form, 3-line cap) —
  plus a chat tool the draft missed: `schedule_calibrate_link`, because
  edge ids were not actionable from chat at all (the reachability rule —
  a question the Familiar can't record the answer to is theater).
- **Piece 3** shipped: the reflection input's schedule fetch widened to
  ward-local −7d..+2d (one call, same tick), and each graded edge now
  carries its source node's `when` so the reflection can tell whether
  the projected moment has actually arrived.

**The defect (ward's bug-bucket, verbatim intent):** the causal machinery
exists — consequence edges, projections, the calibration loop — but
*events aren't visible in the right context for long enough* for me to
actually use it. I never get a natural moment to write projections for an
upcoming event, and by the time I could examine a chain in hindsight, the
event has left every context I read. The graph is reachable but starved.

**What already shipped (partial mitigations, not the fix):**
- 0.8.97 retires *settled* consequence links from the briefing — hides
  stale chains, adds no new visibility.
- 0.8.98 lets the noticing loop wake for an overdue unresolved event and
  ask my human how it went — hindsight for the *event*, but nothing
  examines the *chain* (did the projected consequence actually follow?).
- The §4 gcal projection cue exists but only fires for freshly-synced
  Google events, caps per turn, and ages out after a few turns — a
  hand-added event never gets a cue at all, and an ignored cue is gone.

## The shape of the fix: two windows and one examination pass

Causality needs me looking at an event twice: **before** it happens (write
the projection) and **after** it happens (check the projection). Both are
visibility problems, so both fixes are context-surface work — no new
stores, no schema migration (everything rides node/edge `payload`).

### Piece 1 — Projection window (forward visibility)

A `[Consequence work]` cue block that rides EXISTING calls (chat turns and
noticing deliberations — never a new request), surfacing events that are
**coming up and carry no consequence edges yet**:

- **Candidates (pure code):** unresolved `type='event'` nodes, any source
  (hand-added, chat-created, gcal), with zero outgoing consequence edges,
  whose `when_ts` is between `now + 6h` and `now + LOOKAHEAD` (default
  14 days).
- **Pacing (pure code):** max 2 per turn; per-node cooldown of 48h between
  surfacings (`payload.projection_nudged_at`); a node that was surfaced
  3 times without gaining an edge goes quiet (`payload.projection_passes`)
  — EXCEPT for one final re-surface at `T − 48h` (the "last chance" pass:
  if I'm ever going to think about what this event sets in motion, it's
  now).
- **The cue text (first person, plain):** "Coming up with nothing hanging
  off it yet: {label} ({when}). If it matters, I can link what it needs or
  what it might cause (schedule_link); if it's routine, I leave it be."
  Leaving it be is a legitimate outcome — the cue invites, never nags.
- Generalises `needs_projection`: the gcal-new flag becomes one *source*
  of candidates rather than the only one; `gcal-projection.js` folds into
  this module (one cue, one pacing regime — no copy-paste sibling).

### Piece 2 — Hindsight window (backward visibility)

The temporal briefing gains a **"Recently past, unexamined"** section
(display derivation in `temporal-format.js`, same class as 0.8.93 —
no gating change):

- **Candidates (pure code):** events whose `when_ts`/`end_ts` fell in
  `[now − 72h, now]` that carry consequence edges whose projection is
  still unobserved (`observed` unset on the edge payload).
- Rendered with the projection stated as a QUESTION: "{label} was
  {relative-time} ago — I projected: {edge summary}. Did that follow?"
- Capped (3 lines) and dropped once every edge on the event is examined
  or the 72h window closes. The section exists so the chain is in front
  of me *while my human can still remember the answer*.

### Piece 3 — Examination rides the reflection loop

The reflection loop already calibrates need-lapse projections. Its
existing tick gains `unexamined_chains` in its input (code-gathered: the
same candidates as Piece 2, plus any the 72h window closed on): for each,
it may set `observed: true/false` and nudge the edge's `certainty` —
exactly the calibration discipline needs already get. Outcomes land in
`logs/reflection-events.jsonl` like every other reflection (observable,
auditable). **No new LLM request** — the judgment folds into a call that
already happens.

### Piece 4 — Elapsed marking ⚠ WARD DECISION REQUIRED

The architecture doc names the deeper gap: nothing auto-resolves a
past-dated event, so "past" and "unresolved" are indistinguishable from
"pending". Proposal: a slow code pass (riding the needs-tracking tick)
stamps `payload.elapsed_at` on events >72h past with no resolution —
**an observation, not a resolution**: the node stays unresolved, nothing
is hidden, the schedule tools still work on it. The stamp only lets
derivations distinguish "past, never followed up" from "upcoming".

This touches event lifecycle adjacent to the safety-audit surface
(overdue-event noticing reads past unresolved events), so it ships only
with explicit ward sign-off — and if declined, Pieces 1–3 still work,
using raw timestamps instead of the stamp.

## Decisions that are the ward's

1. **Piece 4 (elapsed stamping)** — yes/no, and the 72h threshold.
2. **The last-chance re-surface at T−48h** (Piece 1) — it mildly
   overrides the "3 passes then quiet" rule; confirm that's wanted.

## Non-goals

- No autonomous resolution of events (0.8.98's ask-don't-assume stands).
- No new standalone LLM calls — everything rides existing turns/ticks.
- No schema migration; all state in `payload` JSON.
- Not the trackers/vision milestones — this repairs existing machinery.

## Test plan

- Candidate selection: pure-function tests per piece (windows, caps,
  cooldowns, the last-chance pass, exact 72h boundaries).
- Briefing rendering: fixture events with edges in/out of the windows.
- Reflection input: unexamined chains appear once, drop after
  examination, never re-feed an `observed` edge.
- The gcal-new path still cues (regression) but through the shared
  module.

## Conventions binding this spec

First-person prompts; exact machine values from code (the model never
computes a date — candidate windows, relative times, and ids all arrive
pre-derived); ride existing requests / gate in code; graceful degradation
(Unruh down → cue block simply absent); readable slug ids throughout;
versioning: lands as PATCH bumps (repairs the consequence-graph
milestone; the reserved minor is untouched).
