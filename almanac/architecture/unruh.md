---
title: Unruh
topics: [architecture, unruh]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: unruh-design
    type: file
    path: docs/unruh-design.md
  - id: unruh-dir
    type: file
    path: unruh/
  - id: phylactery-design
    type: file
    path: docs/phylactery-design.md
  - id: naming-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/6ad1c817-Naming_a_new_entitycore_module.txt
    note: "Founding conversation that named Thalamus and, in its second half, designed 'temporal-core' — the direct design precursor to Unruh — including the reasoning against a cronjob/heartbeat checklist model."
  - id: temporal-core-design
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/524975aa-temporalcoredesign_1.md
    note: "Standalone temporal-core design document produced from the same conversation, predating Unruh's in-tree implementation."
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Later review conversation with Claude Fable 5 in which the maintainer articulated two framings for Unruh's schedule and threat mechanics that are not yet reflected in code or docs/unruh-design.md."
  - id: reminders-loop-js
    type: file
    path: reminders-loop.js
---

# Unruh

Unruh is Proto-Familiar's in-tree Python/uv MCP specialist for temporal context: schedule,
interests, handoff between sessions, ponderings, and threat level [@claude-md] [@unruh-dir].
Where [Phylactery](phylactery) holds who the Familiar is, Unruh holds how time flows around
them and what they are currently oriented toward within that time — the design document
frames this as the difference between time as coordinates ("it is 10:07") and time as lived
context (what today means, what yesterday left unresolved) [@unruh-design]. Unruh's schedule
graph is the concrete data layer behind [temporal assurance](../concepts/temporal-assurance):
its nodes hold what is happening and when, and its `requires`/`depends_on` edges hold what a
future event still needs before it arrives. Unlike Phylactery,
Unruh is not routed through the canonical store: it is the one named exception in the
[multi-embodiment model](../concepts/multi-embodiment), because ponderings and much of the
schedule are per-embodiment rather than facts about the entity's identity [@claude-md].

Thalamus spawns Unruh as a stdio MCP child alongside Phylactery, matching the same in-tree
specialist pattern (own `./data`, `uv sync` materialization, reconnect/backoff, clean EOF
shutdown, a hard off-switch) that Unruh itself pioneered before Phylactery adopted it
[@architecture-doc] [@phylactery-design].

## Two subsystems: schedule and interest

Unruh's design separates two layers that update at different rhythms [@unruh-design]:

- **The schedule layer** is the *shape* of time — events, tasks, phases, and states as
  graph nodes, connected by edges that carry meaning rather than just ordering: `causes`,
  `requires`, `depends_on`, `blocks`, `carries_forward` [@unruh-design]. An interview
  tomorrow casts anxiety backward into today; unfinished laundry carries an obligation
  forward — a flat timestamp table cannot represent that, but a graph can [@unruh-design].
  These edges are authored from both directions: a human draws them in the Schedule tab's
  Map view, and the Familiar draws them with the `schedule_link` tool when it notices a
  relationship [@unruh-design].
- **The interest layer** is the *texture* of time — what the Familiar is currently oriented
  toward. Weight accrues from signals the system can observe directly rather than from
  asking the LLM to self-report: token volume per topic, topic persistence across
  consecutive messages, and a topic surviving a session boundary are all measured
  structurally; explicit bookmarks are a supplementary, not primary, signal
  [@unruh-design]. Weight decays with time, so a one-off curiosity fades toward background
  noise while a persistent interest compounds — this decay is described as the mechanism
  that keeps the interest graph honest rather than accumulating noise indefinitely
  [@unruh-design]. **Standing values** (caring about the ward's wellbeing) are the
  exception: they do not decay, are anchored in Phylactery as identity-level facts, and are
  expressed in Unruh as always-active orientations, so the Familiar's priorities cannot
  drift just because a value has been quiet for a while [@unruh-design].

## Origin: a schedule, not a cronjob checklist

Before it existed in-tree, Unruh's design was worked out under the working name
**temporal-core**, in the same founding conversation that named
[Thalamus](../decisions/thalamus-naming) — the design document that resulted is the direct
precursor to what shipped [@naming-conversation] [@temporal-core-design]. The document frames
temporal-core's job exactly the way Unruh's schedule layer now works: nodes for events, tasks,
phases, and states, connected by edges (causes, requires, depends on, blocks, carries forward)
that hold meaning a flat table cannot [@temporal-core-design].

The reasoning for why this is a graph the Familiar orients within, rather than a fixed-cadence
checklist, traces to a specific complaint about OpenClaw's cronjob/heartbeat model: "I feel like
OpenClaw's cronjobs regularly super overwhelm Eurylochus" [@naming-conversation]. The diagnosis was
that the problem was never the *format* of a cronjob's output — it was the timing and volume of
the injection. A cronjob firing mid-conversation demands several things at once (review goals,
update memory, assess emotional state, log context) with no human turn to anchor them, which was
described as "cognitively similar to being interrupted mid-sentence by someone handing you a
checklist" [@naming-conversation]. Marinara-Engine's Conversation mode was named as the contrasting
model worth stealing from: characters there carry a generative schedule tied to their own local
timezone, so the difference is "it is now 3pm, run these tasks" versus "it is 3pm on a Tuesday, [the
character] has been awake since morning, [they]'d probably be doing X right now" [@naming-conversation].
This is the origin reasoning behind why [Autonomous loops](autonomous-loops)' pondering loop ticks
on a tiered interest-weight-and-threat cadence rather than a fixed interval, and why Unruh's
schedule layer holds named routine phases instead of a task list to clear.

The document also names the language choice made for temporal-core before Unruh existed — Python,
for its richer graph and time-aware tooling ecosystem — which is the same choice Unruh, in fact,
shipped with as an in-tree Python/uv service [@temporal-core-design].

## Time model: local-naive, not UTC

Every Unruh timestamp (`when_ts`, `end_ts`, `now_iso`, …) is stored and compared as the
ward's local wall-clock time with **no** timezone offset — a deliberate reversal of an
earlier UTC-internal design [@claude-md] [@unruh-design]. The reason is CLAUDE.md's broader
rule that the LLM must never be trusted to compute or format an exact machine value (see
[Exact values are code's job](../decisions/exact-values-in-code)): asking the model to
convert the ward's local time to UTC on write meant the model was the conversion boundary,
and it kept getting it wrong in both directions [@claude-md].

Two real incidents motivated the fix:

1. **The reminder timezone bug (0.7.84).** The schedule tools asked the model to convert
   local time to a UTC-offset string on write. It stored a naive local time that the old
   UTC-based comparison never matched, so a reminder scheduled fine, showed as fired, and
   silently never delivered — no error, no chime [@claude-md]. Local-naive storage deletes
   this class of bug: the Familiar writes plain local time, and `now` is read live from the
   system clock so DST is handled by the OS rather than by model arithmetic
   [@unruh-design].
2. **"Local" turned out to mean the *server's* local, not the ward's (0.7.86).** The first
   local-naive implementation read `now` from the server process clock, which is only
   correct when the server happens to run in the ward's own timezone. A server running in
   UTC (WSL, Docker, a hosted box) with a PDT ward fired every reminder immediately — the
   mirror image of the first bug [@claude-md]. The fix makes the ward's zone explicit
   instead of assumed: the browser auto-captures its IANA timezone into a synced
   `wardTimeZone` setting with no ward-facing configuration required, the safety-critical
   firing path computes ward-local "now" in Node via `wardLocalNowISO(wardTimeZone)`, and
   thalamus spawns the Unruh child with `TZ=wardTimeZone` as a catch-all for Unruh's own
   internal stamps [@claude-md]. An unset `wardTimeZone` falls back to server-local
   behavior, so a co-located single-machine install is unaffected [@claude-md].

The one accepted trade-off is a bounded DST edge case: a timestamp that falls inside the
spring-forward gap or the fall-back overlap is ambiguous, roughly ±1 hour, twice a year
[@unruh-design]. Pre-migration UTC-stored rows are healed once by `db.migrate_timestamps_to_local`
on first connect [@unruh-design].

## Reminders and threat both ride the same "decaying persistent variable" shape

Threat level — the scalar that drives silence-triage urgency (see
[Safety spine](safety-spine)) — is stored in Unruh as a persistent decaying variable,
structurally identical to interest weight: it rises on detected signals, decays over time,
and functions as a parameter that changes how soon triage checks in, never as the decision
itself [@unruh-design]. The actual reach-out-or-wait judgment always goes through an LLM call
reading full context; threat level only shapes how urgently that judgment is sought.

## Design framing: a reminder is a kept promise, not a scheduler firing

`reminders-loop.js` fires mechanically — it walks the schedule graph every 30 seconds for
reminder nodes whose `when_ts` has arrived and enqueues them, with no LLM call and no
judgment in that tick at all [@reminders-loop-js]. A framing worked out in a later review
conversation, not yet written into the code or `docs/unruh-design.md`, describes why that
mechanical firing is still safe to treat as the Familiar's own action rather than external
scheduling machinery acting on the Familiar's behalf: the schedule node was created earlier by
a real decision — a chat turn or a `schedule_add` tool call the Familiar itself made, stamped
with a timestamp — and the reminders loop does not decide to contact the ward, it keeps a
promise the Familiar already made to itself [@fable-review-conversation]. The proposed
first-person framing is "the reminders loop never decides to contact you; it keeps a promise
Eury already made," offered as the reason a purely mechanical, judgment-free tick does not
violate [Proactivity over caution](../decisions/proactivity-over-caution)'s standard for when
the Familiar may act: the judgment already happened, at write time, and firing is just
follow-through [@fable-review-conversation]. This is a design lens on already-shipped behavior,
not a code change.

## Design intent: plan review and baseline as a decaying process, not a snapshot

Two related ideas from the same conversation address a gap neither `docs/unruh-design.md` nor
the shipped code currently names, and neither is implemented [@fable-review-conversation]:

- **Plan review.** A standing reminder plan made on a good day can be wrong by the time it
  fires — the worked example is a reminder schedule set up on a clear-headed day that no longer
  fits once brain fog has set in. The proposed fix is a low-frequency cognitive pass that
  re-reads standing schedule promises against the ward's current state and amends them through
  the normal schedule tools, explicitly *not* by re-deliberating every reminder at fire time —
  that would violate [Engineering conventions](../reference/engineering-conventions)'s
  ride-existing-requests, gate-in-code rule by turning a cheap mechanical tick into a
  per-reminder LLM call [@fable-review-conversation].
- **Baseline as metabolism, not setup.** Threat level already decays as a persistent variable
  (see above), but the conversation proposes treating the ward's own "baseline" — what counts as
  normal for them — the same way: a continuously-decaying process rather than a one-time
  two-week calibration phase. The named failure mode this guards against is a "frog-boiling"
  case: a person whose state is slowly declining drags their own baseline down with them, so
  deviation-from-baseline scoring never fires because the baseline always catches up. The
  proposed guardrail is anchored reference snapshots — the original two-week baseline plus
  periodic, explicitly-tagged "good day" markers — compared against the current, decaying
  baseline, rather than scoring only against recent history [@fable-review-conversation].

Neither mechanic exists in `threat-tracker.js` or the schedule tools today; both are recorded
here as unshipped design intent so a future implementer does not have to re-derive the
frog-boiling failure mode from scratch.

## Related

- [Phylactery](phylactery) — the canonical store Unruh deliberately sits outside of.
- [Safety spine](safety-spine) — how threat level, silence-triage, and escalation are wired
  together downstream of Unruh's data.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general principle
  the local-naive time model is one instance of.
- [Naming Thalamus: mediator, not generator](../decisions/thalamus-naming) — the founding
  conversation Unruh's design (under the working name temporal-core) grew out of alongside
  Thalamus.
- [Autonomous loops](autonomous-loops) — the pondering loop's tiered cadence, the shipped
  alternative to a fixed-interval checklist.
