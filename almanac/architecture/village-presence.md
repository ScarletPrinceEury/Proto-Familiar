---
title: "Village presence block"
topics: [architecture, village, memory-and-knowledge]
sources:
  - id: village-presence-js
    type: file
    path: src/village/village-presence.js
  - id: village-card-js
    type: file
    path: src/village/village-card.js
  - id: server-js
    type: file
    path: server.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: village-presence-test
    type: file
    path: tests/village-presence.test.mjs
  - id: public-app-js
    type: file
    path: public/app.js
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Village presence block

The Village presence block (0.12.7-alpha) is a code-assembled `[Village]` context section
that injects a registered villager's pronouns and distinguishing facts into the current chat
turn whenever that person is speaking, present, or named — without spending a new LLM call
[@village-presence-js]. It closes a reach gap in [Architecture](../architecture)'s Village
surface: `village.js`'s registry held pronouns, relation, and communication-style notes all
along, but the only way those facts reached the Familiar's context was the `village_lookup`
tool (`cerebellum.js`), which it rarely thought to run mid-conversation [@village-presence-js]
[@cerebellum-js]. Two reported symptoms — misgendering people the Familiar should already know,
and being unable to tell registered villagers apart in casual talk — trace to the same root
cause: the distinguishing facts simply were not in front of the model at the moment it spoke
[@village-presence-js].

This is a different concept from the per-location presence *modes* (`strict`/`lurk`/`active`)
that `discord-gateway.js` already used to decide whether the Familiar speaks in an ambient
Discord room — see [Architecture](../architecture)'s Village section. The presence block described here
never decides whether to speak; it only decides what identity facts ride the turn once a turn is
already happening.

## Why the registry stays out of the static prompt

The Village registry is deliberately excluded from Thalamus's injected static prompt, and on
Discord only a speaker's *name* travels with a message, never their pronouns
[@village-presence-js]. Both exclusions exist for good reasons — a full registry dump would bloat
every prompt regardless of whether anyone from the Village is actually in play. The presence
block is built to honor that same lean-prompt goal rather than reverse it: `buildVillagePresenceBlock`
returns an empty string unless a known person is detected in the current turn, so the block adds
nothing to the vast majority of turns and only ever names the villagers actually relevant to this
one [@village-presence-js].

## Detection: two independent signals, one exclusion

`detectRelevantVillagers({ registry, text, participants, wardName })` in `village-presence.js`
returns the villagers relevant to a turn, each tagged with why they surfaced [@village-presence-js]:

- **`present`** — the villager is a registered participant the Discord classifier already
  resolved (`classifyMessage` populates `session.participants` as `{id, name}`). This signal is
  high confidence with zero false positives, since it only ever matches an id or name the
  classifier already committed to.
- **`mentioned`** — the villager's name appears in the turn's text. The scan is whole-word,
  case-insensitive, and Unicode-aware, and it checks the full name plus every name-part of length
  at least `MIN_NAME_TOKEN` (3) via `nameTokens()`, so a person named by first name mid-conversation
  is still caught [@village-presence-js]. A name shorter than three characters ("Al", "Jo") is
  skipped from the text scan on purpose — those tokens collide with ordinary words — but a
  short-named villager still surfaces through the `present` signal when they are actually a
  participant [@village-presence-js] [@village-presence-test].

The ward is never returned as a villager even if a villager happens to share the ward's
configured name, since `detectRelevantVillagers` compares against `wardName` and skips a match
[@village-presence-js].

## Field gating: one policy, two readers

Before this feature, `village_lookup` rendered villager cards with its `privateNotes`-ward-only
gate written inline in `cerebellum.js`. Adding the presence block as a second reader of the same
registry fields would have meant a second copy of that gate — exactly the two-copies-of-a-privacy-rule
drift [Content-based memory gating](content-gating) warns about for `audience.js`'s
`visibleAudiences`/`topicGrantsForRoom` pair. Instead, the gate was extracted once into
`disclosableVillagerFields(v, { wardPrivate })` in the new `village-card.js` module, and both
`village_lookup` and `buildVillagePresenceBlock` now call it [@village-card-js] [@cerebellum-js]
[@village-presence-js]. `village_lookup`'s rendered output is unchanged by the extraction, pinned
by its existing tests. The reusable rule this establishes: when a privacy or gating decision
gains a second reader, extract the decision into one shared helper rather than copying it.

`disclosableVillagerFields` encodes a ward decision (2026-09-16) about which registry fields are
fair game outside a ward-private turn [@village-card-js]:

- `pronouns`, `relationToWard`, `commStyleNotes`, and public `notes` are visible in any room,
  because they are how the Familiar refers to and tells people apart — withholding them would
  defeat the whole point of the feature.
- `privateNotes` rides a ward-private turn only. The instant anyone other than the ward is
  present, it is withheld and a `privateNotesWithheld: true` flag is set instead, so a caller can
  render "private notes withheld" without ever holding the note text in a non-ward context
  [@village-card-js].

The block surfaces registry fields only — it never surfaces memories. Memories about a villager
still flow exclusively through recall's own content/audience gate (see
[Content-based memory gating](content-gating)), so this new read path cannot become a bypass
around that gate; the code has no way to reach a memory from either module in this cluster
[@village-presence-js] [@village-card-js].

## Wiring: three turn-assembly seams, no new request

The block rides whichever LLM call is already about to happen — the "gate in cheap code, ride
the existing request" ordering [Ride existing requests; gate in code](../reference/engineering-conventions)
describes for LLM-adjacent features generally. It is wired at three seams, each supplying the
signals it already holds [@server-js] [@discord-gateway-js]:

- **Web `server.js` `/api/chat`** — calls `buildVillagePresenceBlock` with the turn's `userText`
  and the session's accumulated participants, and appends the result to `enrichedResult.dynamic`
  alongside the request's other supplementary blocks [@server-js].
- **Discord live turn (`handleTurn`)** — supplies `session.participants` plus the inbound
  message's `content`, so both the high-confidence roster and the free-text mention scan are
  active [@discord-gateway-js].
- **Discord revisit path** — a deferred `[later:...]` turn has no fresh inbound text, so it
  supplies `session.participants` alone; the accumulated roster is the whole signal for who is
  in play [@discord-gateway-js].

At every seam, `wardPrivate` is derived from the same audience resolution
(`audienceTag === 'ward-private'`) the turn's other gating already computed, so the presence
block's privacy behavior can never disagree with the room's own audience gate.

## Off-switch and failure mode

`villagePresenceOn(settings)` follows the same kill-switch-then-setting pattern used elsewhere in
the codebase (compare `weatherEnabled` in [Weather](weather)): the env var
`PROTO_FAMILIAR_VILLAGE_PRESENCE_DISABLED=1` wins outright, otherwise the synced setting
`villagePresenceEnabled` (default `true`, listed in `SERVER_SYNCED_KEYS`, exposed in Settings as
"Remind me who's here from the Village") controls it [@village-presence-js] [@public-app-js].
`buildVillagePresenceBlock` wraps its own detection call in a try/catch and returns `''` on any
failure, and every call site at the three seams above wraps the call in its own try/catch too —
so a malformed registry read degrades to an empty block rather than ever breaking the turn it
would have annotated [@village-presence-js] [@server-js] [@discord-gateway-js].

## A verification win worth keeping as a pattern

`disclosableVillagerFields`'s first implementation of its `has()` predicate was
`(s) => typeof s === 'string' && s.trim()`, which returns the trimmed *string* on a truthy match
rather than a boolean. Because `privateNotesWithheld` was computed as `!wardPrivate && has(v?.privateNotes)`,
that bug meant `privateNotesWithheld` held the note text itself instead of `true` whenever it
should have fired. The test `disclosableVillagerFields: privateNotes ride ward-private only`
caught this before it shipped, because it asserted the actual boolean shape of the gate's output
(`assert.equal(room.privateNotesWithheld, true)`) rather than only checking that a card rendered
[@village-presence-test]. The fix narrowed `has()` to `s.trim().length > 0` [@village-card-js].
This is the same class of lesson CLAUDE.md's voice-milestone post-mortem records —
"a test can assert a bug and defend it for weeks" — applied here to a privacy-gating predicate
instead of a model file-lookup; see [Voice](voice) for the earlier occurrence [@claude-md].

## Related

- [Architecture](../architecture) — the Village section this feature extends, and the distinct
  per-location presence-mode concept it should not be confused with.
- [Content-based memory gating](content-gating) — the audience/topic-grant pair this page's
  "one gate, shared by both readers" discipline is modeled on, and the reason memories stay on a
  separate gate this feature cannot bypass.
- [Trust tiers gate reads, not writes](../decisions/trust-tiers-gate-reads-not-writes) — the
  read-only framing of Village's category/grant system that this feature inherits: it only ever
  changes what a session is told, never what gets written into memory.
- [Weather](weather) — another feature using the same env-kill-switch-then-setting off-switch
  shape.
- [Voice](voice) — the earlier occurrence of the "a test can assert a bug and defend it for
  weeks" lesson this feature's verification win repeats.
