---
title: "liveTurn Is Scoped to the Ward's Own Turns, Not to Any Real Chat Turn"
topics: [decisions, sessions, unruh]
sources:
  - id: thalamus-js
    type: file
    path: thalamus.js
    note: "enrich()'s liveTurn parameter, its !gated content guards, and the two unguarded reconciliation calls (session_mark_handoff_consumed, interest_demote_standing)."
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
    note: "handleTurn passes liveTurn: decision.isWard (0.12.10-alpha, commit 0d1c6dd)."
---

# liveTurn Is Scoped to the Ward's Own Turns, Not to Any Real Chat Turn

**Status: decided, implemented (0.12.10-alpha).** `thalamus.enrich()`'s `liveTurn` flag now passes
as `decision.isWard` from the Discord gateway instead of a hardcoded `false`, so a Discord message
from the ward gets the same continuity `/api/chat` (web) has always given them — deferred-intent
recall, reach-out follow-up, and ward-state reconciliation — while a villager or ambient turn
still never touches it [@discord-gateway-js]. The flag was left `false` on Discord out of
conservatism when it was designed around one endpoint, not because flipping it was known to be
unsafe; verifying that made the flip low-risk once [Unified Ward Sessions](../architecture/session-unification)
made Discord and web the same session.

## Context

`enrich()`'s `liveTurn` parameter was written when only `/api/chat` (web) called it with `true`.
Discord's `handleTurn` always passed `false` [@thalamus-js]. Once web private chat and Discord DM
became [one continuous session](../architecture/session-unification), that asymmetry stopped being
harmless: the ward's Discord turns went shallower than their web turns in the *same conversation*
— the Familiar couldn't see the warm thing it meant to bring up, forgot it had knocked between
sessions, and could re-ask something the ward had already answered on web.

Auditing `liveTurn`'s call sites inside `enrich()` found it conflates two different concerns
[@thalamus-js]:

- **Ward-private content** — deferred intents, reach-out recall ("what I said when I knocked"),
  the today+yesterday recent-memory cross-check, the calendar-projection cue, and spine-state sync.
  Every one of these already carries its own `!gated` guard inside `enrich()` (`gated =
  !eligibility.wardPrivate`), so they only ever render on a ward-*private* turn regardless of what
  `liveTurn` is passed [@thalamus-js].
- **Ward-state reconciliation** — `session_mark_handoff_consumed` and `interest_demote_standing`.
  These fire on *any* `liveTurn` turn with **no** audience check, and they act on the ward's Unruh
  state (Unruh is ward-scoped) [@thalamus-js]. A villager turn with `liveTurn: true` would have
  consumed the ward's handoff or reconciled the ward's interest values off a villager's chatter —
  the wrong turn touching ward continuity.

Because the content half self-hides via `!gated` and the reconciliation half does not gate on
audience at all, the only variable that needed to change was *whether the calling turn belongs to
the ward*, not a second flag.

## Decision

`handleTurn` in `discord-gateway.js` passes `liveTurn: decision.isWard` [@discord-gateway-js]. This
produces three cases, all matching web's existing behavior:

- **Ward DM** (`decision.isWard` true, `gated` false since a DM is ward-private): full continuity
  — both the content half and the reconciliation half run, exactly as `/api/chat` has always run
  them for the ward.
- **Ward speaking in a shared guild** (`decision.isWard` true, `gated` true): reconciliation only.
  The content half self-hides via its existing `!gated` guards; the ward's Unruh state still
  reconciles because that operates on the ward regardless of who else is in the room.
- **Villager or ambient turn** (`decision.isWard` false): `liveTurn: false`, identical to before.
  Ward continuity is never touched by someone else's message. The ambient revisit path — never a
  ward turn — is unchanged.

`lastUserMessageAt` stays `null` on Discord: idle-mode bookmark surfacing depends on the web
client's gap clock, which Discord does not track, so that piece of `liveTurn`'s web behavior stays
web-only for now [@discord-gateway-js].

### Why flipping it was safe on a now-shared session

The reconciliation ops are not merely gated by audience — they are also safe against the
concurrency this decision creates (web and Discord now able to trigger the same ward-state writes
from the same unified session):

- Local file state (deferred-intent `markSurfaced`, the reach-out log, spine episode, calendar-cue
  aging) goes through `withLock(key, fn)` in `thalamus.js`, a per-file mutex that serializes
  read-modify-write instead of corrupting on a race [@thalamus-js].
- MCP state (Unruh writes) goes over a single stdio child processing one request at a time, and
  both reconciliation ops are idempotent — `mark_handoff_consumed` and `demote_standing` are no-ops
  the second time they run [@thalamus-js].

So the flip did not require a new enqueue layer; the existing locking and idempotency were already
load-bearing enough to make `liveTurn: decision.isWard` safe the moment it was tried.

## Consequences

Discord's ward turns now carry the same continuity web turns always have, which is a direct,
positive consequence of [Unified Ward Sessions](../architecture/session-unification) actually
delivering on its premise (one conversation, not two conversations that happen to share a log).

The conflation this decision resolves is still latent in the flag's *name*, not its current
behavior: `liveTurn` bundles "may this turn write ward-state?" with "should it show ward-private
proactive content?" They move together correctly for the ward's own turns, which is why a single
boolean is sufficient today. But a future "villager gets some live context" permission cannot be a
flag flip on the same boolean: the content half is ward-scoped (there is nothing ward-private to
show a villager) and the reconciliation half must never fire on a villager turn regardless of any
permission granted to them. Making that real means splitting the flag into a ward-only,
never-grantable `reconcileWardState` and a separately grantable `proactiveContext` — and building a
villager-scoped proactive surface for the grant to actually reveal. That split was deferred here,
not built, so the next requirement that needs the two halves apart would not have to rediscover
that they were always two concepts sharing one name.

**Update (0.12.12–0.12.13-alpha):** that requirement arrived. A `proactiveContext` boolean grant
now exists on Village categories, and
[Villager proactive context](../architecture/villager-proactive-context) is the villager-scoped
surface built for it — a separate module (`src/warmth/villager-context.js`) that reads its own
reach-out and gated-memory sources and never touches `liveTurn` or Unruh reconciliation state.
`reconcileWardState` was never split out as a named flag because it did not need to be: the
reconciliation calls stayed exactly where they were, gated on `decision.isWard`, and the new
surface simply never calls them.

## Related

- [Unified Ward Sessions](../architecture/session-unification) — the session-identity merge that
  made this asymmetry visible: a discontinuity now shows up as a chat *inside one conversation*
  going shallower, not as a difference between two separate logs.
- [Prompt-Cache-Aware Context Ordering](prompt-cache-aware-context-ordering) — a companion
  0.12.9-alpha fix from the same web-vs-Discord audit, addressing *where* dynamic content lands in
  the prompt rather than *which* dynamic content renders.
- [Unruh](../architecture/unruh) — the ward-scoped specialist whose state the reconciliation half
  of `liveTurn` writes to.
- [Villager proactive context](../architecture/villager-proactive-context) — the villager-scoped
  proactive surface that this decision's deferred split motivated.
