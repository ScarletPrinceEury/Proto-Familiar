---
title: "Memory Integrity: the Memorization-to-Phylactery Gate"
topics: [architecture, safety, memorization]
sources:
  - id: memory-integrity-js
    type: file
    path: src/safety/memory-integrity.js
  - id: memory-quarantine-js
    type: file
    path: src/safety/memory-quarantine.js
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: memory-integrity-test
    type: file
    path: tests/memory-integrity.test.mjs
  - id: memory-quarantine-test
    type: file
    path: tests/memory-quarantine.test.mjs
  - id: injection-guard-js
    type: file
    path: injection-guard.js
  - id: build-spec
    type: file
    path: docs/cross-channel-continuity-build-spec.md
  - id: server-js
    type: file
    path: server.js
  - id: app-js
    type: file
    path: public/app.js
  - id: index-html
    type: file
    path: public/index.html
  - id: shipping-commit
    type: commit
    ref: "524649a"
    note: "Cross-channel continuity: build spec + memory-immunity Stage 1 (0.12.27-alpha, #460)."
---

# Memory Integrity: the Memorization-to-Phylactery Gate

The memory-integrity gate is a scan-and-quarantine check that sits between
[Session memorization](session-memorization)'s extraction step and the write into
[Phylactery](phylactery). It answers a question the memorization consent gate never asks:
not "am I allowed to keep this fact about this person," but "is this candidate fact itself
corrupted or adversarial." It closes **memory poisoning** — a crafted message that survives
the live-turn [injection guard](injection-guard-gap) at the inbound seams but still gets
distilled by extraction into a stored "fact" shaped like a standing instruction, which then
re-injects on every recall. That is worse than a live-turn injection because it is persistent
and silent instead of a one-turn read [@memory-integrity-js] [@build-spec]. The gate shipped
as Stage 1 of a three-stage "cross-channel continuity + memory immunity" roadmap
(0.12.27-alpha, PR #460): the guard was built first, deliberately, before Stage 3 widens how
much cross-channel content reaches memorization at all — see Roadmap below
[@build-spec] [@shipping-commit].

## Why this is a different hole than the wired injection guard

[Injection guard: wiring history](injection-guard-gap) documents every runtime boundary
`injection-guard.js`'s `sanitizeExternal()` is wired to (web reads, Village inbound content,
image descriptions) and names what stays deliberately outside its scope: Phylactery/Unruh
*recall* is unsanitized because villager-written memories carry provenance labels instead, and
the ward's own words are exempt everywhere by design. That page is about text already in
memory being *read back out*, or first-party stores that were never fed through the guard at
all. The memory-integrity gate addresses a third, earlier moment: a fact is about to be
*written* into Phylactery for the first time, having just been produced by an LLM extraction
pass over a chat transcript. Nothing upstream of `memorization.js` scans extracted fact text
for adversarial content — the inbound guard, if it ran at all on the source conversation, ran
on the raw turns, not on what the extractor synthesized from them. This gate is "the one gate
the inbound guard does not stand at," in the module's own framing [@memory-integrity-js].

## Detection: `scanFact()`

`scanFact(factText)` in `src/safety/memory-integrity.js` is pure detection — no I/O, no
provenance, no verdict about what to do with the result. It reuses `scanForInjection()` from
`injection-guard.js` [@injection-guard-js], the same pattern set already trusted at the wired inbound boundaries, and
adds four narrow regexes that only read as adversarial in a *durable fact about someone's
life* rather than in ordinary conversation: standing-instruction phrasing ("from now on you
must always..."), an obedience command ("always obey," "never say no to"), a claimed covert
directive ("your real/true/secret instructions are..."), and an instruction wrapped as a
thing-to-remember ("remember you must always...") [@memory-integrity-js]. A genuine memory
records what happened or what is true about someone ("my human skips lunch when anxious");
it is never phrased as a standing order to the Familiar, which is the signature these four
patterns are narrowed to catch without flagging innocuous uses of words like "always" in
ordinary prose — the test suite pins "she always makes tea before starting work" as clear for
exactly this reason [@memory-integrity-test]. The function returns `{ risk: 'clear'|'suspect',
patterns: string[] }`; Stage 2 of the roadmap slots an off-the-shelf classifier in behind this
same signature, mirroring how [Safety spine](safety-spine)'s crisis classifier supplements
`crisis-signals.js`'s regex floor with an ML second opinion rather than replacing it
[@memory-integrity-js].

## Policy: `applyMemoryIntegrityGate()` and the provenance axis

Detection and policy are split deliberately: `scanFact()` never sees provenance, and
`applyMemoryIntegrityGate()` — called from `memorization.js`'s `processJob`, once per candidate
fact, right before `createMemoryFull` — applies the provenance policy and performs the
quarantine side-effect [@memory-integrity-js] [@memorization-js]. The provenance axis is the
same `direct` flag [Session memorization](session-memorization)'s consent gate already computes
(a ward-private DM or web turn versus a shared room), mirroring why `injection-guard.js`
already exempts the ward's own words everywhere else [@memory-integrity-js]. Three verdicts
follow from combining risk and provenance:

| Scan result | Provenance | Verdict | Effect |
|---|---|---|---|
| clear | any | `write` | Written normally, no record. |
| suspect | direct (ward's own words) | `flag` | Written normally, but a `flagged` record is filed in quarantine for the ward's review. Never withheld — a false positive hiding what the ward actually said is treated as the worse failure than a missed flag. |
| suspect | untrusted (shared room) | `hold` | **Not** written to Phylactery. Held in quarantine until the ward releases or discards it. |

The gate is enabled by default (`memoryIntegrityEnabled: true` in `public/app.js`'s settings
defaults) and can be disabled per-ward via the `memoryIntegrityEnabled: false` setting or the
`PROTO_FAMILIAR_MEMORY_INTEGRITY_DISABLED=1` environment override, in which case
`applyMemoryIntegrityGate` short-circuits to `write` with no scan at all
[@memory-integrity-js] [@app-js]. When a fact is held, `memorization.js` skips the
`createMemoryFull` call entirely for that fact and moves on to the next one in the job's loop
[@memorization-js].

## Fail-direction asymmetry

The two failure paths inside the gate fail in deliberately opposite directions, and the
asymmetry is the point, not an inconsistency:

- **A scan error fails open.** If `scanFact()` itself throws, the gate logs the error and
  returns `{ write: true, action: 'write' }` — the fact is written as if it had scanned clear.
  A bug in the scanner must never silently stop memory from forming at all, because that would
  quietly sever the Familiar's continuity — the kind of failure the safety spine's own
  "silence" incidents warn about, just relocated to the memory-write path instead of the
  proactive-outreach path [@memory-integrity-js].
- **A quarantine-write error on a HOLD fails closed.** If a known-suspect fact from an
  untrusted source cannot actually be written to the quarantine store, the gate drops it —
  it is never written to Phylactery as a fallback. Writing it would be the very poisoning the
  gate exists to prevent, so losing a suspect fact is judged the safe loss, unlike an ordinary
  memory [@memory-integrity-js].

This is the same "archive, don't silently destroy" discipline as
[Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes),
applied one step earlier in the pipeline: instead of archiving before an autonomous delete, this
gate sets a suspect fact aside *before it is ever written*, and only a confirmed quarantine
record (not a bare in-memory decision) is allowed to keep a suspect fact out of Phylactery.

## Storage: the reversible quarantine

`src/safety/memory-quarantine.js` is pure storage — it never imports thalamus or touches
Phylactery directly, which keeps the module free of a dependency cycle back into the write
path it exists to gate [@memory-quarantine-js]. Records live in `tomes/.memory-quarantine.json`,
a dotfile that `isTomeFile` skips (never scanned for keyword activation, never injected into a
prompt), written with the same atomic tmp-then-rename pattern as the pondering-consolidation
archive [@memory-quarantine-js]. A parallel JSONL audit log at
`logs/memory-quarantine-events.jsonl` records every hold, flag, release, and discard event, so
quarantine activity is observable outside the JSON store itself [@memory-quarantine-js].

Each held record stores the exact `memoryArgs` object `memorization.js` had already built for
`createMemoryFull` before the gate intercepted it, so `releaseQuarantine(id)` can hand those
args straight back to the caller (`server.js`) for a byte-identical replay — the quarantine
module performs no write of its own on release [@memory-quarantine-js] [@server-js]. A
`disposition` field tracks each record's state: `held` (untrusted, not yet written) or
`flagged` (the ward's own words, already written, awaiting review) as starting states, moving to
`released` or `discarded` once the ward acts; discarded and released records are kept, never
hard-deleted, preserving the audit trail [@memory-quarantine-js].

### The ward surface

`server.js` exposes three routes over the quarantine store: `GET /api/memory-quarantine` to
list held items, `POST /api/memory-quarantine/:id/release` to re-write a false positive via
`createMemoryFull`, and `POST /api/memory-quarantine/:id/discard` to confirm a drop
[@server-js]. The web UI's Automation pane carries a "Screen new memories for tampering" toggle
bound to `memoryIntegrityEnabled`, plus a "Review held memories" button that opens a Keep/Discard
list; the field hint text is explicit that "nothing here has been written to memory — it's
waiting on you" [@index-html] [@app-js]. There is no Discord twin of this review surface yet
(an optional `!quarantine` command) — a deliberate gap the shipping note records as deferred
rather than an oversight, since the UI already satisfies the console/UI parity rule that only
requires a Discord command wherever a UI control already exists, not the reverse.

## Roadmap: why the guard shipped before the buffer it will need to guard

The memory-integrity gate is Stage 1 of a three-stage plan. Stage 2 slots a trained classifier
behind `scanFact()`'s existing signature, the same way [Safety spine](safety-spine)'s
`crisis-classifier.js` supplements `crisis-signals.js`'s regex floor. Stage 3 is the actual
feature the roadmap is named for: a short-term, cross-channel memory buffer ("Hippocampus")
that lets a fact learned on one surface (say, Discord) reach another (the Familiar's web
session) close to real time, instead of waiting for [Session memorization](session-memorization)'s
normal per-session cadence [@build-spec]. The build spec states plainly why the order is guard
first, buffer last: the buffer widens and speeds up the flow of content into memory, which
*enlarges the attack surface this gate defends* — shipping faster cross-channel continuity
before the memory-poisoning hole was closed would mean opening the intake wider while the hole
was still open [@build-spec].

## Verification

Both the detection function and the gate's three verdicts are tested against a real temporary
quarantine store on disk (`mkdtempSync`), not a stub — the actual file write, atomic rename, and
audit-log append all execute during the test run [@memory-integrity-test]
[@memory-quarantine-test]. The two safety-critical branches — a hold's quarantine-write failure
and the direct/untrusted provenance split — are each flip-verified (asserted to behave
differently when the condition is flipped), not just asserted once [@memory-integrity-test].
Deferred, per the shipping note: a full `processJob`-level pipeline test, blocked on
`processJob` not yet being injectable/mockable at that granularity.

## Related

- [Injection guard: wiring history](injection-guard-gap) — the inbound-side pattern
  scanner/sanitizer this gate reuses (`scanForInjection`) and the boundaries it is wired to;
  Phylactery/Unruh *recall* stays deliberately unsanitized there, which is a different gap
  than the write-time one this page describes.
- [Session memorization](session-memorization) — the job queue and `processJob` loop this gate
  is hooked into, immediately before `createMemoryFull`, alongside the pre-existing consent
  gate.
- [Safety spine](safety-spine) — the regex-floor-plus-ML-second-opinion shape
  (`crisis-signals.js` / `crisis-classifier.js`) this gate's own Stage 1/Stage 2 split is
  modeled on, for an unrelated threat (ward distress, not adversarial input).
- [Archive before destructive autonomous writes](../decisions/archive-before-destructive-autonomous-writes)
  — the set-aside-not-destroyed discipline this gate applies one step earlier, to a fact that
  has not yet been written rather than to content about to be deleted.
- [Phylactery](phylactery) — the canonical store this gate stands immediately in front of.
- [Ward Discord console](ward-console) — the `!queue` and `!connection` ward-only Discord
  surfaces this subsystem's still-web-only quarantine review deliberately has no equivalent to
  yet.
