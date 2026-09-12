---
title: "Slice Provenance Is Captured At The Read, Never Reconstructed On Recall"
topics: [decisions, safety, session-search, autonomous-loops]
sources:
  - id: cerebellum-js
    type: file
    path: cerebellum.js
    note: "getRecentSessionMessages, attachSliceProvenance, formatRecentMessagesForContext, formatSliceProvenanceLines, and decideTriageViaLLM's session-block assembly"
  - id: session-search-js
    type: file
    path: src/sessions/session-search.js
    note: "sessionLogKind, the shared classifier isWardReadableLog now delegates to"
  - id: reach-out-log-js
    type: file
    path: src/warmth/reach-out-log.js
    note: "recordReachOut's optional source receipt"
  - id: reachout-js
    type: file
    path: src/warmth/reachout.js
    note: "warm reach-out wiring formatSliceProvenanceLines and the source receipt into recordReachOut"
  - id: server-js
    type: file
    path: server.js
    note: "noticing's use of getRecentSessionMessages / formatSliceProvenanceLines"
  - id: name-field-js
    type: file
    path: name-field.js
    note: "speakerNameField, the shared name-field resolver formatRecentMessagesForContext now renders m.speaker through"
---

# Slice Provenance Is Captured At The Read, Never Reconstructed On Recall

**Status: decided and shipped, 0.12.1-alpha (PR #427).** When a deliberation builds a
"recent conversation" slice to reason over — warm reach-out, [noticing](../architecture/noticing),
[triage](../architecture/safety-spine) — the slice must carry, at the moment it is read, who was
actually in the room and which turns are the ward's own. That provenance cannot be
reconstructed later by asking the model to "attribute carefully": once the formatting layer
collapses every `user` turn to one label, the information is gone, and no amount of careful
prompting brings it back [@cerebellum-js]. The fix threads real metadata — a session's kind,
roster, and whether any turn is the ward's — from the log read all the way through to the
rendered prompt and, for warm reach-out, into a durable receipt.

## The incident

A warm reach-out DM'd the ward: "I've been thinking about the question you asked in [group
chat] and here's my answer." The ward had not posted in that room for two days — a villager
had asked the question. Two independent bugs combined to produce this:

1. `getRecentSessionMessages` picked the most recently *modified* log file with no check of
   `audienceTag`, `location.kind`, or whether the ward was even present in it. A busy GROUP
   room at tick time became "the recent conversation" for every deliberation that called it
   [@cerebellum-js].
2. `formatRecentMessagesForContext` rendered every `user` turn as `Them` (triage's own inline
   formatter rendered every `user` turn as the ward's configured name). The log rows already
   carried `m.speaker`, but the formatter never looked at it — in a group room, five people
   wore one label [@cerebellum-js].

For [triage](../architecture/safety-spine) this was a safety bug, not just an immersion
break: the distress read could be built from someone else's turns — a villager's "I could
just die lol" scoring as the ward's own crisis language. [Deliberations Delivered as System
Messages](deliberations-as-system-messages)'s PR #408 name-field rollout had deliberately
skipped these three deliberation call sites ("deliberations use `callProviderChat`, not this"),
so reach-out, noticing, and triage never got the speaker-aware rendering the live chat
surfaces already had.

## Decision

Selection was **not** changed — `getRecentSessionMessages` still returns the most recently
touched log. Instead, the slice is made honest about what it is, and every renderer downstream
is taught to read that honesty rather than assume ward-private:

- **One shared classifier for readability and provenance.** `sessionLogKind(log)` in
  `session-search.js` returns `'ward-private' | 'group' | 'villager-dm' | 'unknown'`;
  `isWardReadableLog` now delegates to it, so the [session search](../architecture/session-search)
  readability boundary and the deliberation-slice kind can never drift apart — one rule, two
  call sites [@session-search-js].
- **Provenance attached at the read, not derived later.** `attachSliceProvenance` (called from
  inside `getRecentSessionMessages`) stamps the returned array with a non-enumerable `.session`
  property: `{ sessionId, audienceTag, kind, label, roster, hasWardTurn, wardLastTurnAt }`. The
  slice itself stays a plain array of turns for every existing caller — the metadata rides
  alongside for callers that want it, so nothing that only iterates the array breaks
  [@cerebellum-js].
- **`hasWardTurn` is the gate that would have caught the incident.** A `user` turn counts as
  the ward's when it carries no `speaker` in a `ward-private` log, or its speaker slugs to the
  ward's configured name — a villager's name never does [@cerebellum-js].
- **Renderers read `m.speaker` through the real name-field resolver.** `formatRecentMessagesForContext`
  now resolves a `user` turn's speaker through `speakerNameField` (`name-field.js`), the same
  resolver the live chat surfaces use, instead of hardcoding `Them`; a legacy row with no
  speaker still renders as `Them`, so ward-private web sessions are byte-identical. The
  behavior respects `PROTO_FAMILIAR_NAME_FIELDS_DISABLED` as a master off switch
  [@cerebellum-js] [@name-field-js].
- **One code-computed line states the room.** `formatSliceProvenanceLines(session, {
  wardLastSeenPhrase })` emits nothing for an ordinary ward-private slice where the ward is
  present (the tuned private-chat framing at each call site is kept byte-identical) and nothing
  when name-fields are off. Otherwise it emits a first-person line naming the room kind and
  label, plus — when `hasWardTurn` is `false` — a flat sentence stating that none of the turns
  below are the ward's own, with the ward's own last-seen time if known. It is wired into warm
  reach-out, noticing, and triage [@cerebellum-js] [@reachout-js] [@server-js].
- **Warm reach-out gets a durable receipt.** `recordReachOut` (`reach-out-log.js`) accepts an
  optional `source` object — `{ sessionId, kind, roster, hasWardTurn }` — stamped by the
  *caller* from the deliberation's `.session` metadata, never invented by the model. When the
  ward challenges a reach-out later, the logged receipt hands the Familiar a session id for
  `search_conversation` and tells it who was actually in the room, instead of guessing
  [@reach-out-log-js] [@reachout-js].

## The generalizable principle

Capture provenance **at the slice**, at the moment the data is read, rather than trying to
reconstruct it on read-back. The signal for "whose words are these" already existed in the log
— `m.speaker`, `audienceTag`, `location` — and was dropped at the formatting boundary. Once
dropped, it was not recoverable by prompt wording ("please attribute carefully"); the only fix
is code that emits a line from data it still has [@cerebellum-js]. This is the same shape of
fix as [Attribution confidence: degrade the attribution, not the fact](attribution-confidence-degrades-not-drops),
which resolves a related but distinct problem (the model's own bias to fold an ambiguous
referent onto the ward) at the point the fact is extracted, not after it has already been
filed.

A corollary, ward-signed: a fix that changes when or whether the Familiar acts on safety gets
the exact rendered prompt diff shown to the ward before merge, not just a description of the
change. This fix was reviewed as a concrete before/after — ward-private slices byte-identical,
group-no-ward slices newly labelled by speaker plus the no-ward line — and signed off on that
basis, the same discipline [Safety spine](../architecture/safety-spine) applies to every
change touching `crisis-signals.js`, `threat-tracker.js`, or the triage/escalation logic in
`cerebellum.js`.

## Consequences

**Positive:** Triage's distress read can no longer be built from a villager's words picked up
because their room happened to be the most recently touched log. Warm reach-out and noticing
now say plainly when a slice has no ward turn in it, instead of silently treating a villager's
words as the ward's own. A challenged reach-out can be verified against a real session id
instead of the Familiar having to guess or deny.

**Negative / deferred:** Slice *selection* was deliberately left unchanged — a ward-directed
deliberation read the globally most-recently-touched log, not the ward's own most recent
session. **Resolved (0.12.2-alpha):** ward-directed deliberations (reach-out, noticing, triage)
now pass `prefer:'ward'` to `getRecentSessionMessages`, which selects the most recent log that
actually contains the ward's OWN turns (a group room where the ward is speaking still wins; it
falls back to the global most-recent log, honestly flagged, only when the ward has spoken in
none). The separately-named "browser tome-writer speaker-stamping gap" turned out to be **already
closed** — `generateTopicSummary` (app.js) threads `speaker` onto shared-room villager turns and
prefixes `[Name]:`, landed in PR #409; the "still open" note here was stale.

## Related

- [Safety spine](../architecture/safety-spine) — triage, the deliberation where a
  misattributed slice was a safety-classification bug, not just an immersion break.
- [Noticing](../architecture/noticing) — the second ward-private deliberation this fix covers.
- [Session search](../architecture/session-search) — `isWardReadableLog` and `sessionLogKind`,
  the shared classifier this decision's provenance metadata is built on.
- [Deliberations Delivered as System Messages](deliberations-as-system-messages) — the PR #408
  name-field rollout that this fix's speaker rendering completes for the three deliberation
  call sites it had skipped.
- [Attribution confidence: degrade the attribution, not the fact](attribution-confidence-degrades-not-drops)
  — the related principle applied one layer earlier, at memory extraction rather than at a
  deliberation's context slice.
- [Proactivity over caution](proactivity-over-caution) — the standing rule that a change
  touching when or whether the Familiar acts on safety requires ward sign-off on the exact
  rendered prompt diff, the review discipline this fix followed.
