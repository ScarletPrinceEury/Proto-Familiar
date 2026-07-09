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
---

# Unruh

Unruh is Proto-Familiar's in-tree Python/uv MCP specialist for temporal context: schedule,
interests, handoff between sessions, ponderings, and threat level [@claude-md] [@unruh-dir].
Where [Phylactery](phylactery) holds who the Familiar is, Unruh holds how time flows around
them and what they are currently oriented toward within that time — the design document
frames this as the difference between time as coordinates ("it is 10:07") and time as lived
context (what today means, what yesterday left unresolved) [@unruh-design]. Unlike Phylactery,
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

## Related

- [Phylactery](phylactery) — the canonical store Unruh deliberately sits outside of.
- [Safety spine](safety-spine) — how threat level, silence-triage, and escalation are wired
  together downstream of Unruh's data.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general principle
  the local-naive time model is one instance of.
