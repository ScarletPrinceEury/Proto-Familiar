---
title: Pondering
topics: [architecture, autonomous-loops, pondering]
sources:
  - id: pondering-loop-js
    type: file
    path: src/pondering/pondering-loop.js
  - id: recent-ponderings-js
    type: file
    path: src/memory/recent-ponderings.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: autonomous-loops-doc
    type: file
    path: docs/architecture.md
  - id: pondering-js
    type: file
    path: src/pondering/pondering.js
  - id: ponder-research-js
    type: file
    path: src/pondering/ponder-research.js
  - id: unruh-interest-py
    type: file
    path: unruh/src/unruh/interest.py
  - id: unruh-server-py
    type: file
    path: unruh/src/unruh/server.py
  - id: server-js
    type: file
    path: server.js
  - id: pondering-consolidate-js
    type: file
    path: src/pondering/pondering-consolidate.js
---

# Pondering

The pondering loop is an autonomous worker that thinks aloud (in the Familiar's voice, not the ward's chat) about topics it is currently oriented toward, at a cadence weighted by interest and threat level [@pondering-loop-js]. Unlike triage or reminders, pondering is not prompted by external events or chat turns — it fires on its own, at the Familiar's initiative, carrying the [proactivity](../decisions/proactivity-over-caution) principle into background thought [@autonomous-loops-doc]. Ponderings are per-embodiment (not routed through [Phylactery](phylactery) canonical storage) and are surfaced on demand via the `read_pondering(uid)` tool [@cerebellum-js].

## One thought per tick

Each pondering tick generates one thought — a single, focused reflection on a topic, captured as one line in the `[Ponderings]` briefing block that appears in every turn's prompt [@pondering-loop-js]. This was a deliberate design choice to keep ponderings high-signal rather than verbose [@autonomous-loops-doc]. The one-line format is strict: the full thought is available on demand via the `read_pondering(uid)` tool for ward curiosity, but the default briefing appearance is summary-level.

The structured shape of a thought record is:

```json
{
  "uid": "unique-id",
  "topic": "topic-slug",
  "thought": "One-line summary of the reflection",
  "full_text": "The complete pondering (may be multiple sentences or paragraphs)",
  "created_at": "ISO timestamp",
  "cadence": "30m|1h|2h|6h"  // Last computed cadence based on interest weight
}
```

The one-line summary is what appears in the briefing; the full text is available via `read_pondering(uid)` for the Familiar to re-read on the ward's request or for the ward to inspect what the Familiar has been pondering about [@recent-ponderings-js].

## Cadence: interest-weighted and threat-gated

The pondering loop runs on a tiered cadence, NOT a fixed interval [@autonomous-loops-doc]. The cadence is computed from two inputs:

1. **Interest weight** — how much attention is currently oriented toward this topic [@pondering-loop-js]. Topics accrue weight from token volume, persistence across consecutive messages, and surviving session boundaries; weight decays over time.
2. **Threat level** — the scalar from [Unruh](unruh) that drives urgency [@autonomous-loops-doc]. When threat reaches moderate or higher, pondering stands down entirely (along with warmth and needs-tracking) to defer to [silence triage](safety-spine).

The cadence tiers are: 30 minutes (high interest), 1 hour, 2 hours, and 6 hours (low interest, background noise). A topic with very low interest still ponders, but only every 6 hours [@autonomous-loops-doc].

## Threads: wandering to a related topic (0.11.76)

Left alone, `runOneTick()`'s weighted pick makes every ponder an island: whichever interest
currently has the most weight wins, tick after tick, with no sense that one curiosity grew out
of another. Threads give the loop a way to wander instead. After the weighted pick, the loop
rolls a `threadChance` — a ward-configurable dial (`ponderThreadChance` in settings, default
0.35) clamped to `[0,1]` by `clampChance` so an invalid setting falls back to the default rather
than disabling threading or hopping unconditionally [@pondering-loop-js]. On a hit, it calls
`getRelated(picked.id)`, weighted-picks among the neighbours the same way it picked the original
interest, and ponders that neighbour instead of the original pick, carrying the original topic's
label through as `threadFrom` so the resulting thought can ground itself — "I got here from
thinking about X" — instead of appearing to change subject at random [@pondering-loop-js].

The edges a hop can follow are the `related_to` edges [Unruh](unruh) writes: `interest_record`
accepts a `related_to` label naming the topic a new curiosity grew out of, and when that label
resolves to an existing node the two are linked with an idempotent `related_to` edge (either
direction already counts as linked, so re-recording the same pair is a no-op); `interest_related`
returns the topics one hop from a given node, decay-weighted [@unruh-interest-py]
[@unruh-server-py]. Only `drawn_to` curiosities (see
[Self-originated interest and the `me` register](../decisions/self-originated-interest-and-me-register))
are ever linked this way — standing values and bookmarks never get `related_to` edges, so a
thread always wanders through the Familiar's own accumulated curiosities, never through facts
it is holding on the ward's behalf.

## The `read_pondering` tool

`read_pondering(uid)` is a cerebellum tool (surfaced as a 'core' tool in every embodiment) that returns the full text of a saved pondering [@cerebellum-js] [@tool-surfacing-js]. This lets the ward ask "what have you been thinking about?" or the Familiar to re-read a past reflection if it wants to build on it. The tool takes a `uid` (the saved pondering's unique id, available in the briefing line), looks up the full record, and returns `{ uid, topic, thought, full_text, created_at }` [@cerebellum-js].

Because ponderings are per-embodiment and stored locally (in `recent-ponderings.js` memory or in a local sqlite table), `read_pondering` is synchronous and never calls out to Phylactery [@cerebellum-js].

## Looking things up before writing (Pass 4, 0.11.7)

`ponderOnce()` (`pondering.js`) can research a topic before it writes the thought, instead of
only recombining what the Familiar already holds [@pondering-js]. The gate runs only for an
interest ponder — never a reflection-mode tick — and requires `settings.ponderWebEnabled` (default
true), `settings.webSearchEnabled` true, and the env off-switch
`PROTO_FAMILIAR_PONDER_WEB_DISABLED` unset [@pondering-js]. When it fires, `ponderOnce()` calls
`researchForPonder()` from [Browser](browser)'s `ponder-research.js`, then folds the result into
`buildPonderPrompt()`'s `sourcesText` argument: either a cited-sources block naming what was
found, or — when the shared daily read budget is spent — an honest line saying the Familiar is
thinking from what it already holds rather than looking anything up [@pondering-js]
[@ponder-research-js]. A research failure is swallowed and treated as "no sources this ponder,"
since the lookup is best-effort and must never turn a background thought into a failed tick
[@pondering-js].

This research call is the one place a pondering tick reaches outside the Familiar's own stored
context, and it runs read-only and code-bounded for that reason — see
[Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code)'s
Pass 4 section for why the loop hands the model no tool surface at all, only the ability to name
what it wants looked up.

## A second creation path for villager tells (0.12.15)

`ponderOnce()`'s intent-parsing pass already turns a ponder's `wants_to_save` and `drawn_to`
fields into memory writes and new standing curiosities; 0.12.15 gave a `tell` intent an optional
`recipient` field so a free pondering cycle can also form a "meaning to bring up with them" tell
for someone in the ward's Village, not only for the ward [@pondering-js]. `runPonder`
(`server.js`) injects a small roster — up to 8 villagers whose category grants
`proactiveContext` — into `grounding.villagers` before the call, and only when villager context
is on at all; the common ponder gets no roster and renders unchanged [@server-js].
`ponderOnce()` validates any `recipient` against that injected roster: a matching id is
partitioned out of the ward-facing result into `result.villager_tells`, and a non-matching id is
downgraded to an ordinary ward tell rather than trusted or dropped [@pondering-js]. `runPonder`
then routes each `villager_tells` entry to the villager's own tell store, fire-and-forget, the
same way it records a `drawn_to` curiosity [@server-js]. See
[Villager proactive context](villager-proactive-context)'s Stage 3 section for the full villager
tell lifecycle (storage, gating, and the show-once surfacing this creates the writes for) and for
`getUnactedIntents`'s defense-in-depth skip of any tell still carrying a `recipient`
[@recent-ponderings-js].

## Digesting a month of ponderings so they don't pile up forever (0.12.18)

Every tick writes one more entry into the ponderings tome, and before 0.12.18-alpha nothing
ever folded them back down — the [memory system](memory-and-knowledge) has a consolidation
ladder for daily-to-yearly rollup, but ponderings had no equivalent [@pondering-consolidate-js].
`consolidatePonderings()` (`pondering-consolidate.js`) closes that gap: it finds the OLDEST past
calendar month that still holds at least three eligible `scope:'pondering'` entries, has an LLM
distill them into one first-person `scope:'pondering-digest'` entry ("what I was turning over in
<month>"), and prunes the originals once the digest is written [@pondering-consolidate-js]. A
digest entry ships `enabled: false` — it is an artifact for the Familiar or ward to read back,
never something that re-injects itself into a future prompt by keyword match the way an ordinary
Tome entry would.

The eligibility check is the load-bearing guard: a pondering that still carries an UNACTED
`wants_to_save` intent (a pending tell or follow-up nothing has filed yet) is never eligible and
is re-validated under `modifyTomeFile`'s write lock immediately before the prune, so a tell that
became pending between the read and the write survives [@pondering-consolidate-js]. The current,
still-filling month is never a candidate. Consolidation stays LOCAL to the ponderings tome rather
than writing anything to [Phylactery](phylactery) — a digest of per-embodiment thinking is still
per-embodiment, not a canonical fact about the ward, the same reasoning that keeps ordinary
ponderings out of Phylactery in the first place (see below).

There is no new loop or timer: `runPonder` (`server.js`) calls `consolidatePonderings()`
best-effort immediately before each pondering tick, and the "is there an un-consolidated past
month?" check inside `selectConsolidationTarget` is its own rate limit — once a month is digested
it will not be picked again, so the call is cheap on every tick that has nothing to do, and a
large backlog drains one month per tick rather than all at once (the same oldest-first, one-per-call
shape as the 0.8.89 memory-sweep fix) [@pondering-consolidate-js]. The feature is on by default
(`ponderConsolidationEnabled`) with a hard off-switch, `PROTO_FAMILIAR_PONDER_CONSOLIDATE_DISABLED=1`,
following the same settings-toggle-plus-env-off-switch contract every [autonomous loop](autonomous-loops)
ships with, even though this rides an existing tick rather than owning one.

## Why ponderings stay per-embodiment

Ponderings are not written to Phylactery, the canonical store, because they are thoughts in progress rather than conclusions about the ward or the world [@pondering-loop-js]. A pondering is context-sensitive to the current embodiment's conversation history, interruptions, current mood, and recent focus. The thought "I wonder if Chen is overcommitting again" makes sense in a particular chat session or embodiment flow, not as a fact to inject into every future conversation [@autonomous-loops-doc]. Ponderings are meant to be read in the moment or on-demand via `read_pondering`, not accumulated into standing identity.

## Related

- [Autonomous loops](autonomous-loops) — the full list of loops, their cadences, and off-switches.
- [Memory and knowledge](memory-and-knowledge) — Phylactery's daily-to-yearly consolidation
  ladder that the pondering-tome digest above deliberately mirrors in shape but keeps separate
  from, since a digest of ponderings is still per-embodiment thinking, not a canonical fact.
- [Safety spine](safety-spine) — how pondering, warmth, and needs-tracking stand down during crisis.
- [Unruh](unruh) — the interest and threat scoring systems that shape pondering cadence.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the design principle that ponderings embody.
- [Browser: click-and-fill web access](browser) — the `ponder-research.js`/`ponder-web-budget.js`
  modules the research gate above calls, and the rest of the browser subsystem they share code
  with.
- [Browser milestone: guardrails in code, not prompts](../decisions/browser-guardrails-in-code) —
  why Pass 4's research loop hands the model no tool surface, only the ability to name a lookup.
- [Self-originated interest and the `me` register](../decisions/self-originated-interest-and-me-register) —
  why `drawn_to` curiosities exist, and the `related_to` threading behavior detailed above.
- [Villager proactive context](villager-proactive-context) — Stage 3's full villager-tell
  lifecycle and its other creation path, the `note_to_tell_villager` chat tool.
