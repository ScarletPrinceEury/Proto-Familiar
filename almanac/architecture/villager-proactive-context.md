---
title: "Villager proactive context"
topics: [architecture, village, memory-and-knowledge]
sources:
  - id: villager-context-js
    type: file
    path: src/warmth/villager-context.js
  - id: reach-out-log-js
    type: file
    path: src/warmth/reach-out-log.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: server-js
    type: file
    path: server.js
  - id: thalamus-js
    type: file
    path: thalamus.js
  - id: audience-js
    type: file
    path: src/village/audience.js
  - id: village-js
    type: file
    path: src/village/village.js
  - id: public-app-js
    type: file
    path: public/app.js
  - id: memory-py
    type: file
    path: phylactery/src/phylactery/memory.py
  - id: server-py
    type: file
    path: phylactery/src/phylactery/server.py
  - id: villager-context-test
    type: file
    path: tests/villager-context.test.mjs
  - id: memory-by-subject-test
    type: file
    path: phylactery/tests/test_memory_by_subject.py
---

# Villager proactive context

Villager proactive context (0.12.12–0.12.13-alpha) is the villager-side mirror of the ward's
own turn continuity: in a 1:1 Discord DM with a villager whose category grants
`proactiveContext`, the Familiar walks into the turn already knowing its own thread with that
person — what it last said to them, and, when enabled, what they have recently been talking
about — instead of resetting every time [@villager-context-js]. It is built as a separate,
villager-scoped proactive surface rather than as a permission layered onto the ward's existing
`liveTurn` continuity, because the content `liveTurn` already carries is entirely ward-private
and could not simply be un-gated for a third party; see
[liveTurn is scoped to the ward's own turns](../decisions/live-turn-scoped-to-ward) for why that
split was necessary and deferred until this feature built it.

The block is assembled at Discord turn-assembly time and appended to `enriched.dynamic` — no new
LLM call — by `buildVillagerContextBlock` in `src/warmth/villager-context.js`
[@villager-context-js]. It is gated three ways, all required: the villager's room grants
`proactiveContext`, the turn is a 1:1 DM with a known focal villager, and the feature's
off-switch is on. Any miss returns an empty string. v1 targets villager DMs only, because a group
room has no single focal person to be "about" — group-room proactive context is a deferred
nuance, not a gap in v1/v2 [@villager-context-js].

## Why this needed to be its own surface, not a grant on `liveTurn`

`liveTurn`'s proactive content inside `thalamus.enrich()` — deferred-intent recall, reach-out
recall, the recent-memory cross-check, the calendar cue, and spine sync — is all wrapped in a
`!gated` guard, so it only ever renders on a ward-*private* turn regardless of what `liveTurn` is
passed [@thalamus-js]. Granting `liveTurn` to a villager's room would therefore do one of two
wrong things: surface nothing, because the content stays ward-gated behind `!gated`, or — if the
gate were loosened instead — fire the ward-state reconciliation calls
(`session_mark_handoff_consumed`, `interest_demote_standing`) on a villager's turn, which is the
wrong turn touching ward continuity. The
[liveTurn decision](../decisions/live-turn-scoped-to-ward) page names this exact tension and
records that making "a villager gets some live context" real would require a
never-grantable ward-only `reconcileWardState` half plus a separately grantable
`proactiveContext` half — and a villager-scoped proactive surface for the grant to actually
reveal. This feature is that surface: `villager-context.js` never touches Unruh reconciliation
state and reads only through its own gated readers.

## The `proactiveContext` grant

`proactiveContext` is a new boolean grant on Village categories, exposed in the ward's grant
editor as "Proactive relationship context" [@public-app-js]. It required no change to
`audience.js`'s `isGranted`, which already treats any boolean grant key as true/false directly,
and no change to `village.js`'s `sanitizeGrants`, which keeps any boolean grant key without an
explicit allowlist — only the nested `topics` map gets special handling
[@audience-js] [@village-js]. It is off by default; the ward sets it per category. A global
master toggle `villagerContextEnabled` (synced setting) and an env kill-switch
`PROTO_FAMILIAR_VILLAGER_CONTEXT_DISABLED=1` both gate the feature ahead of the per-category
grant, checked by `villagerContextOn(settings)` [@villager-context-js].

`villagerContextEligible({ focalVillager, grants })` is the pure gate: it requires a focal
villager with an `id` and `isGranted('proactiveContext', grants)` [@villager-context-js]. At the
Discord call site, the focal villager is only populated when `decision.kind === 'villager-dm'`,
so the block can never target anyone in a shared guild room [@discord-gateway-js].

## Stage 1 — reach-out recall ("what I last said to them")

The reach-out log (`src/warmth/reach-out-log.js`) already backed the ward's own
`[I reached out first]` block, but ward reach-outs (logged from `server.js` on channel
`ward-banner`) and villager reach-outs (delivered through `deliverVillagerReach`) had never been
symmetric: only the ward's knocks were logged [@reach-out-log-js] [@server-js]. Stage 1 closed
that gap:

- `recordReachOut` gained an optional `recipientId`, stored on the log item only when it is a
  non-empty string; `deliverVillagerReach` in `server.js` now calls it with
  `channel: 'villager-dm', recipientId: villager.id` after every successful relay, keyed to that
  villager [@reach-out-log-js] [@server-js].
- `recentReachOuts` gained a `recipientId` filter with three states: omitted returns every knock
  (back-compat with existing callers), `null` returns only the ward's own knocks (no
  `recipientId` stored), and a villager id string returns only that villager's knocks
  [@reach-out-log-js]. The ward's own enrich call now passes `recipientId: null` explicitly so a
  villager reach can never bleed into the ward's block [@thalamus-js].
- `formatVillagerReachRecall(villagerName, knocks)` renders the villager-facing sub-block,
  reusing `formatReachOutBlock`'s body lines but deliberately stripping the
  "where this came from" provenance line — the session id and speaker roster that line carries is
  ward bookkeeping (see
  [Slice provenance is captured at the read](../decisions/slice-provenance-captured-at-read)) and
  must never ride into a villager-facing turn [@villager-context-js] [@reach-out-log-js].

## Stage 2 — gated recent memory ("what we've been talking about")

Stage 2 adds a second, optional sub-block: thin recent-memory items where the villager is a
subject. The ward's decision, ward-signed, was a fail-closed SUBJECT-plus-content gate applied
belt-and-suspenders, reusing the exact two-axis gate `memory.search` already applies rather than
inventing a second one [@memory-py]:

- Python's `list_by_subject(villager_id, ...)` gained optional `audiences` and `topic_grants`
  parameters. When both are supplied — a villager-facing proactive read — it applies the coarse
  audience floor (`audience_in_sql`) *and* the fine content-tag gate
  (`memory_visible_to_grants`), the same pair described in
  [Content-based memory gating](content-gating), over-fetching by 4x so the post-filter still
  fills the caller's limit [@memory-py]. When both are omitted, the read stays ungated — the
  villager `!consent` menu (a person may see everything held about themselves) and the ward's own
  "what do you know about X" are unchanged [@memory-py].
- The `memory_list_by_subject` MCP tool and `thalamus.getMemoriesBySubject` thread the two
  parameters through unchanged [@server-py] [@thalamus-js]. The Discord call site passes the
  villager's own room gate fail-closed: `audiences: audienceVisible ?? []`,
  `topicGrants: audienceTopics ?? {}` — a missing gate value becomes "nothing visible," never
  "ungated" [@discord-gateway-js].
- `formatVillagerMemoryRecall(villagerName, items)` renders the second sub-block, and
  `buildVillagerContextBlock` only calls the memory reader at all when one is injected
  (`memoryReader`); a failing memory read still leaves Stage 1's reach recall standing — the
  block degrades, it never blocks the turn [@villager-context-js].

## Wiring and failure mode

`buildVillagerContextBlock` is called once per Discord turn, after the Village presence block, in
`handleTurn` [@discord-gateway-js]. Both readers (`reader` for reach-outs, `memoryReader` for
memory) are injectable, which is what makes the block unit-testable without touching Phylactery
or the filesystem [@villager-context-js] [@villager-context-test]. Each reader call is
individually wrapped in `try/catch`; a failure in either one is swallowed and simply omits that
sub-block rather than failing the turn [@villager-context-js].

## The reusable lessons

1. **When a grant would surface ward-scoped content to a third party, build a parallel
   third-party-scoped surface instead of loosening the ward gate.** The ward-private `!gated`
   blocks inside `enrich()` stayed exactly as they were; the villager got its own module and its
   own render path.
2. **Reuse the existing gate at the layer the query already runs**, rather than adding a second
   filter downstream. Stage 2 did not add a Node-side content filter after the fact; it extended
   the Python `list_by_subject` to apply the same `audience_in_sql` plus
   `memory_visible_to_grants` pair `memory.search` uses, so there remains one gating
   implementation, fail-closed, tested where it runs [@memory-by-subject-test].
3. **Fail-closed at the wiring boundary, not only inside the gate function.**
   `audiences: audienceVisible ?? []` / `topicGrants: audienceTopics ?? {}` at the Discord call
   site means a missing upstream value can never accidentally produce an ungated read
   [@discord-gateway-js].
4. **A constant fake embedding can make a dedupe path merge test rows that must coexist.** The
   Stage 2 Python gating tests first failed because the shared fake-embedding fixture returns one
   constant vector, so two same-subject seed rows scored similarity 1.00 and one was deduped away
   before the gate was ever exercised — a test-fixture trap, not a code bug. The fix used a
   text-varying fake embedding (`_distinct_embed`) for any seed set where multiple rows about the
   same subject must survive [@memory-by-subject-test].

## Related

- [liveTurn is scoped to the ward's own turns](../decisions/live-turn-scoped-to-ward) — the
  decision that named the ward-vs-villager conflation this feature resolves, and deferred building
  the villager-scoped surface until now.
- [Content-based memory gating](content-gating) — the audience-floor-plus-content-tag pair Stage
  2 reuses rather than duplicating.
- [Village presence block](village-presence) — the other villager-facing, gated, code-assembled
  turn-annotation block appended to `enriched.dynamic` at the same Discord turn-assembly seam.
- [Slice provenance is captured at the read](../decisions/slice-provenance-captured-at-read) — the
  session-id/roster receipt on a reach-out log entry that Stage 1's recall block deliberately
  omits for a villager.
- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) — the
  read-only framing of Village's category/grant system this feature's `proactiveContext` grant
  inherits.
