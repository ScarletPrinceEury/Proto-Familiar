---
title: "Elapsed-Time Macros Read Stored History, Not Date.now()"
topics: [decisions]
sources:
  - id: app-js
    type: file
    path: public/app.js
  - id: features-doc
    type: file
    path: docs/features.md
  - id: engineering-conventions
    type: file
    path: almanac/reference/engineering-conventions.md
---

# Elapsed-Time Macros Read Stored History, Not Date.now()

**Status: decided, implemented.** `{{elapsedTime}}` and `{{timeSinceLastSession}}` are two
prompt macros resolved by `applyNameVars` in `public/app.js`, alongside `{{user}}` and
`{{char}}`, so the LLM can be told when `{{user}}` is messaging the Familiar again after a
long absence [@app-js] [@features-doc]. Each macro measures a gap differently on purpose:
`{{elapsedTime}}` deliberately reads only timestamps already stored in chat history, never
`Date.now()`, while `{{timeSinceLastSession}}` deliberately does use `Date.now()` against a
cached prior-session boundary. Both format through the shared `formatDuration()` helper —
`47s`, `5m`, `2h 14m`, `3d 4h`, `just now` — so the two macros never diverge on units
[@app-js].

## Context

The obvious implementation of "tell the LLM how long it's been since the human last wrote"
is `Date.now() - lastUserMessage.timestamp`. That was tried and rejected for
`{{elapsedTime}}` [@app-js]. A macro built on `Date.now()` is unstable: it gives a different
answer every time the same conversation is rebuilt or regenerated, because its value depends
on when the macro happens to be evaluated rather than on anything actually recorded in the
conversation. It is also unsafe at a session boundary — the legacy module-level `elapsedTime`
field can end up pointing at a previous session's tail after a `loadPersisted()` restore
[@app-js].

`{{timeSinceLastSession}}` faces a different constraint: `applyNameVars` runs synchronously
inside `buildApiMessages`, so a macro that had to `fetch('/api/logs')` on every substitution
would block prompt assembly or force async plumbing through every callsite that builds a
prompt [@app-js].

## Decision

**`{{elapsedTime}}` reads two already-stored user-message timestamps and computes their
delta**, via `elapsedBetweenUserMessages()`, instead of comparing the last stored message to
`Date.now()` [@app-js]. It renders `no prior user message` when fewer than two timestamped
user messages exist yet. Restricting the read to `state.messages` keeps the value scoped to
the current session by construction, which is what protects it from the cross-session bug
that affects the legacy field [@app-js].

This shape has a one-turn lag as an accepted trade-off: the turn on which the user actually
returns still reflects the *prior* cadence, since the returning message becomes one of the two
compared timestamps only once it is itself stored — the absence becomes visible on the next
prompt build, not on the return turn itself [@app-js] [@features-doc]. The alternative
(`Date.now()` against the last stored message) would have shown the absence immediately, but
at the cost of a value that changes on every re-evaluation of the same conversation. Stability
of the stored-history value was prioritized over the one-turn lag.

**`{{timeSinceLastSession}}` compares `Date.now()` against a cached
`state.previousSessionEndedAt` ISO timestamp** — this macro is measuring wall-clock distance
from a past event rather than the gap between two stored things, so `Date.now()` is the
correct anchor here even though it was rejected for `{{elapsedTime}}` [@app-js]. It renders
`no prior session` when the cache is empty. The cache is kept in `localStorage` via
`saveSettings()` and updated directly at every event that ends a session — the 3-hour idle
`autoEndSession`, the manual Clear button, and cold-start stale-session finalization in
`init()` [@app-js]. `refreshPreviousSessionEndedAt()` backfills the cache by scanning
`/api/logs` only in the two cases where `localStorage` may not be authoritative: cold start
with an empty cache, and after `loadSession()` switches which session counts as "current,"
which changes the answer to "what's the previous session" [@app-js]. This split — direct
assignment on the hot path, scan-based backfill only on cold start or session-switch — keeps
the macro's steady-state cost at a `localStorage` read with no network call in the render
path [@app-js].

## Consequences

`{{elapsedTime}}`'s one-turn lag is a standing, accepted property of the macro, not a bug to
fix — a future change that tries to make the absence visible on the return turn itself would
have to reintroduce a `Date.now()`-based comparison and give up the stability guarantee this
decision chose instead. Both macros are resolved at the same substitution boundary as
`{{user}}`/`{{char}}` inside `applyNameVars`, and do not fire in the server-injected
static/dynamic context blocks (identity, temporal context, `[CARE CHECK]`, presence), which
author literal strings instead — see
[Engineering conventions: macro substitution boundaries](../reference/engineering-conventions)
for the full boundary set this participates in [@engineering-conventions].
