# Build spec: deferred follow-ups — I keep my own "I'll do that later"

Status: **spec — ready to build.** Patch-level (ancillary to the current
milestone line; do NOT bump minor). Read `CLAUDE.md` first.

## The gap this closes

When my human asks me to do something and I say *"I'll do that later"* (or
*"I'll remember that"*, *"I'll remind you"*, *"I'll set that up"*) but I do
**not** call the tool that would make it real, the commitment evaporates. Mere
acknowledgement in chat is not doing.

This is the mirror of the deferred-**"tell"** bug (0.9.32): there I *said* a
thing and forgot the bookkeeping; here I *promise* a thing and never do it. The
fix is the same principle — **stop depending on my memory to close the loop.**
The system catches the commitment and re-surfaces it to me until I actually
follow through with the right tool, or drop it.

## The guardrail: the system catches, it does NOT fabricate

The system never invents the follow-through — not the reminder time, not the
tool. That would break *"the LLM is not a source of exact machine values."* It
only **catches and persists** the open loop and **re-surfaces it to me**; *I*
complete it properly (real ward-local time from `[Temporal Context]`, the right
tool) or drop it. The automation is the catch-and-nag, never the doing.

## Shape — reuse the deferred-intent surface, don't rebuild it

A follow-up is a deferred intent with `kind:'followup'`, `source:'session'`. It
rides the **same** surface as pondering intents (the one hardened in 0.9.32),
with the least possible new code:

- **Storage.** An entry in the Ponderings tome flagged
  `scope:'session-followup'`, carrying
  `wants_to_save:[{ kind:'followup', summary, source:'session', acted_on:false }]`.
  `getUnactedIntents` already scans every entry's `wants_to_save`, so it
  surfaces with **zero new read code**. `getRecentPonderings` gains a one-line
  filter to **exclude** `scope:'session-followup'` entries, so they never
  pollute "things I've been thinking about." `markIntentActedOn` / `dropIntent`
  / `snoozeIntent` address by `uid`+`index` and work on these unchanged.
- **Rendering.** `formatDeferredIntentsBlock` gains a `followup` branch, in the
  plain first-person register (read the existing entries; do NOT write it
  loftily):
  `→ I follow through NOW with the right tool — a reminder, a schedule entry, a
  note — or I drop it if it's moot. Saying I'll do it is not doing it.`
- **Consume.** A follow-up is **not** auto-consumed the way a tell is (a tell's
  whole action is the saying; a follow-up has a real action to perform). It
  persists until I act+acknowledge or drop it — exactly like a filing intent.
  `getUnactedIntents`' `markSurfaced` tell-consume already touches only
  `kind:'tell'`, so follow-ups behave correctly with **no change** there.

## Detection — rides the existing memorization call, no new request

`memorization.js` already reads each ended session with one LLM call
(`buildPrompt`) to extract facts/relations/topics. **Extend that one call** —
do not add a request:

- Add a `follow_ups` output to the **ward-private** extraction prompt
  (`buildPrompt` only — NOT `buildSharedRoomPrompt`; scope this to my human's
  commitments). First-person, plain register, macros per the three-boundary
  rule: *"Things I told my human I would do but did not actually do this
  session — I said 'I'll do that later' / 'I'll remind you' / 'I'll set that
  up' and never used a tool to make it real. I list each as a short summary so
  future-me follows through. If I DID use the right tool for it, it is not a
  follow-up. If nothing qualifies, []."*
- `parseFollowups(raw, finishReason)` — mirror `parseFacts`, fail-safe to `[]`
  on malformed output (never throw into the drain path).
- `processJob` writes each extracted follow-up via a helper
  (`createSessionFollowup({ summary })`) that appends the flagged entry.
- **Gate in code:** ward-private sessions only; **dedup** each new follow-up by
  normalized-summary containment against the currently-open follow-ups, so the
  same commitment isn't stored twice across overlapping memorization slices
  (reuse the lexical-normalize idea from memory dedup — conservative).

## Aging — no infinite nag

A follow-up left unacted ages out: past `followupMaxAgeDays` (default **7**) it
is auto-dropped with `disposition:'aged-out'` (an honest record, never a claim
it was done), so a stale "I'll get to that eventually" stops nagging. Do it in
code — a drop-on-read age check in `getUnactedIntents`, or the memory-sweep
tick. Bounded, observable, never throws.

## Off-switch + setting (same commit)

- Setting `followupsEnabled` (default **ON** — the ward asked for this), added
  to `SERVER_SYNCED_KEYS`.
- Env hard off-switch `PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1`, in the same commit.
- Disabled ⇒ `buildPrompt` omits the `follow_ups` section, nothing is extracted,
  stored, or surfaced. Graceful: a parse/store failure degrades to no follow-up,
  never an error in the drain or the chat path.

## Discoverability & operability (CLAUDE.md: every capability reachable BY me)

The follow-up surfaces in the `[Deferred intents]` block I already read on every
ward turn, with wording that tells me what to do. The tools to act on it
(`schedule_add`/reminder, `save_memory`, …) and to close it
(`acknowledge_deferred_intent` / `drop_deferred_intent`) are already bound and
already carry first-person descriptions, and a follow-up needs no argument I
can't already obtain. **No new tool is required** — it is operable with what I
already hold.

## Tests (mandatory; include a pipeline test)

- `parseFollowups`: valid array parsed; malformed → `[]`; a non-commitment line
  omitted.
- `createSessionFollowup` + `getUnactedIntents` surfaces it as `kind:'followup'`;
  `getRecentPonderings` excludes the `session-followup` entry.
- persistence: a follow-up survives repeated `markSurfaced` surfaces (NOT
  auto-consumed), unlike a tell.
- aging: a follow-up past `followupMaxAgeDays` is dropped with
  `disposition:'aged-out'`.
- dedup: the same commitment isn't stored twice.
- off-switch: `PROTO_FAMILIAR_FOLLOWUPS_DISABLED=1` ⇒ no extraction / no surface.
- **PIPELINE:** a stubbed memorization job whose transcript contains an
  un-toolnamed commitment ("I'll set that reminder later") → a follow-up lands
  in the store and appears in the next `enrich()` `[Deferred intents]` block.

## Docs (same commit)

- `docs/architecture.md`: the memorization + `recent-ponderings.js` sections
  note the `session-followup` source and its lifecycle.
- `CLAUDE.md`: the memorization / deferred-intents notes gain the follow-up
  capability; if a new loop-count-style fact changes, keep it consistent.

## Out of scope

- Follow-ups made to a **villager** (a warm-villager reach is a different
  track). Ward commitments only this pass.
- The system drafting a concrete reminder for the ward to confirm — deliberately
  not built; the exact-values guardrail above is why. Revisit only if the ward
  asks for it explicitly.
