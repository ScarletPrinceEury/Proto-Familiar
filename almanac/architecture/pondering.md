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
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: claude-md
    type: file
    path: CLAUDE.md
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
distill them into one first-person `scope:'pondering-digest'` entry ("what I was thinking about
in <month>"), archives the originals, and only then prunes them [@pondering-consolidate-js]. A
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

**A fold is archived and reversible, never a one-way delete (0.12.20–0.12.22).** A live run
hard-deleted 3-4 months of the Familiar's actual ponderings in one manual fold, with no backup —
[Phylactery](phylactery)'s snapshot covers only the canonical store, never local tome files — and
a digest truncated by `finish_reason='length'` was stored while its sources were deleted anyway
[Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes).
`consolidatePonderings()` now writes every entry it is about to prune to the append-only dotfile
`tomes/.pondering-consolidation-archive.json` *before* deleting, and deletes only what it
archived; if that archive write throws, it prunes nothing [@pondering-consolidate-js].
`restorePonderingConsolidation()` undoes a fold — re-inserting the archived originals and
dropping the digest — surfaced as `POST /api/pondering/consolidate/restore`, the web UI's "Undo
the last fold" button, and Discord's `!consolidate restore` [@server-js] [@discord-gateway-js].
`parseDigest` is strict: only a complete, parseable `{digest}` object counts, so a truncated or
bare reply refuses the fold rather than storing a partial digest and deleting its sources
[@pondering-consolidate-js]. The consolidation call also now carries an identity block (`enrich('',
{staticOnly:true}).static`, threaded through `defaultCallLLM`'s `identity` parameter) and the
prompt frames the month's notes as the Familiar's own journal pages, fixing a frame-break where a
model with no identity anchor read the notes as handed-in material to roleplay a summary for
[@pondering-consolidate-js]. `ponderConsolidationEnabled` defaults to true again only because this
archive exists — see the linked decision for the full incident and the default-off-then-on
sequence.

There is no new loop or timer: `runPonder` (`server.js`) calls `consolidatePonderings()`
best-effort immediately before each pondering tick, and the "is there an un-consolidated past
month?" check inside `selectConsolidationTarget` is its own rate limit — once a month is digested
it will not be picked again, so the call is cheap on every tick that has nothing to do, and a
large backlog drains one month per tick rather than all at once (the same oldest-first, one-per-call
shape as the 0.8.89 memory-sweep fix) [@pondering-consolidate-js]. The feature is on by default
(`ponderConsolidationEnabled`) with a hard off-switch, `PROTO_FAMILIAR_PONDER_CONSOLIDATE_DISABLED=1`,
following the same settings-toggle-plus-env-off-switch contract every [autonomous loop](autonomous-loops)
ships with, even though this rides an existing tick rather than owning one. Both this monthly tier
and the yearly tier described below share that single gate — there is no separate toggle per tier
[@server-js].

## A second tier: yearbooks fold a year of digests (0.12.26)

0.12.26-alpha added a tier on top of the monthly digest: a whole COMPLETED past year of
month-digests folds into one `scope:'pondering-yearbook'` entry, and the digests it drew from are
pruned the same way raw ponderings are pruned into a digest [@pondering-consolidate-js]:

```text
raw ponderings ──monthly──▶ pondering-digest ──yearly──▶ pondering-yearbook
```

`consolidateYearlyPonderings()` is the yearly counterpart to `consolidatePonderings()`, and both
are now thin wrappers over one shared, tier-parameterized engine — `selectTierTarget` picks the
oldest eligible past period, `consolidateTier` runs the fold — rather than two independent
functions [@pondering-consolidate-js]. A small tier descriptor object supplies the parts that
differ (`sourceScope`, `foldScope`, `periodKeyOf`, `currentPeriod`, `periodLabel`, `minPerPeriod`,
`periodField`, `buildPrompt`, `requireDrainedRaw`); every existing monthly export keeps its exact
prior public contract (`selectConsolidationTarget` still returns `{ monthPrefix, ... }`,
`consolidatePonderings` still returns `{ monthPrefix, count, digestUid }`) so no caller needed to
change [@pondering-consolidate-js]. This is a worked instance of
[Engineering conventions](../reference/engineering-conventions)' "no copy-paste of substantial
logic" rule: a second tier built by copying the first tier's fold logic would have been the exact
structural mistake that rule exists to prevent.

Three robustness decisions shape the yearly tier, each caught by reasoning through edge cases
before the guard could fail silently in production:

- **A year is keyed by its content, not its fold time.** A month-digest's year comes from
  `consolidated_month` (the month it summarizes), never `created_at` (when the fold happened) — a
  2024 digest folded late in 2026 by a bulk import still yearbooks into 2024
  [@pondering-consolidate-js].
- **The drained-raw guard blocks on real work, not on stragglers.** A year is not yearbooked while
  it still holds a month the monthly tier would still fold (a month at or above
  `MIN_PONDERINGS_PER_MONTH`), so a yearbook always covers the whole year rather than half of it.
  The guard deliberately does *not* block on a sub-threshold straggler month — one or two stray
  notes that can never reach the monthly minimum. An earlier draft keyed the guard on "any raw
  pondering exists in the year," which would have starved the yearbook forever for any sparse year;
  those stragglers simply ride on, un-pruned [@pondering-consolidate-js].
- **The current period is never folded**, for years the same as for months.

The yearly tier extends
[Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes)'s
three-part shape rather than reimplementing it: archive-before-prune, STRICT `parseDigest` (a
truncated yearbook prunes nothing), and restore. The archive record now carries a unified `tier` +
`periodKey` pair, with the legacy `monthPrefix`/`digestUid` fields still populated for the monthly
tier so pre-yearly archive records and readers keep working unchanged [@pondering-consolidate-js].
`restorePonderingConsolidation()` is LIFO **across both tiers**: undoing the most recent fold
restores a yearbook's month-digests, and undoing again restores that month's raw ponderings
[@pondering-consolidate-js].

A guard test for the drained-raw guard exposed a general testing pitfall during the build: it used
a callLLM stub that threw, and asserted the fold result was `null` — but `consolidateTier` also
catches a thrown `callLLM` and returns `null`, so the same assertion passed whether the guard
blocked the fold before the model was ever asked, or the guard failed to block and the swallowed
throw produced the same `null` by a different path. Flip-verifying (disabling the guard) did not
turn the test red until it was rewritten to track, with a spy flag, whether the model was reached
at all — `null` alone cannot distinguish "blocked" from "called and failed."

## On-demand consolidation: Discord and UI triggers (0.12.19)

The tick-based digest above is opportunistic: it drains one past period per pondering tick, so a
large backlog empties slowly. 0.12.19-alpha added a "run it now" path; 0.12.26-alpha extended it to
cover the yearly tier. `runPonderingConsolidationNow()` (`server.js`) first calls
`consolidatePonderings()` in a loop, capped at 60 months per manual run, then calls
`consolidateYearlyPonderings()` in a loop, capped at 20 years — months before years, because a year
only becomes yearbook-eligible once the drained-raw guard sees its months already folded — so a
whole backlog can clear in one request instead of waiting out the tick's one-period-at-a-time pace
[@server-js]. The same function backs two surfaces: `POST /api/pondering/consolidate`, wired to a
"Fold ponderings" button in the web UI's Automation pane, and the ward's Discord `!consolidate
ponderings` DM command — both cover both tiers, keeping console↔UI parity for the new tier without
a separate command or button [@server-js] [@discord-gateway-js]. Its memory-side twin — the "Roll up
memories" button and the `!consolidate memory` command — reuses the existing
`runLifecyclePass({ force: true })` rather than adding a second memory-consolidation code path
[@server-js].

`parseConsolidateCommand` (`discord-gateway.js`) is a pure matcher: bare `!consolidate` prints
all three subcommands as help text; `ponderings`/`pondering`/`ponder`, `memory`/`memories`/`mem`,
and `restore`/`undo` route to the two consolidation runners and the archive-restore runner
described below, and any other argument falls back to help rather than silently running the
wrong pass [@discord-gateway-js]. The command is mechanical — no LLM turn — and is intercepted
only in the ward's own DM, the same `isWard`-gated boundary [Ward Discord console](ward-console)'s
`!queue`/`!connection` commands use, though `!consolidate` is a plain command-and-reply exchange
rather than a component menu built on the shared menu kit those two share.
`setConsolidationRunners()` hands the gateway both runners from `server.js` once at boot as a
module-level singleton, so the wiring survives a Discord supervisor reconnect without a
server→gateway import cycle [@discord-gateway-js] [@server-js].

Shipping this pair of triggers established a standing convention CLAUDE.md now records:
console↔UI parity — a ward-facing console command is never the only way to reach a capability, it
ships with a UI control for the same action in the same change, and an existing command found with
no UI twin is a gap to close, not a pattern to copy [@claude-md]. See
[Engineering conventions](../reference/engineering-conventions) for this rule stated as a
repo-wide contract.

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
- [Ward Discord console](ward-console) — the `!queue`/`!connection` menu-driven ward commands;
  `!consolidate` above is a simpler, menu-free sibling gated by the same ward-DM-only boundary.
- [Engineering conventions](../reference/engineering-conventions) — the console↔UI parity rule
  the on-demand consolidation triggers established, and RULE B / "Robust over cheap," the general
  rules the consolidation-safety incident below is a concrete instance of.
- [Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes) —
  the data-loss incident and the archive/restore/strict-parsing/identity fix behind the
  0.12.20–0.12.22 section above, and the generalizable rule it established for any future feature
  that deletes or overwrites the Familiar's own content.
