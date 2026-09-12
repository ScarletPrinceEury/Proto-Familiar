---
title: Sessions
topics: [architecture, sessions]
sources:
  - id: session-log-js
    type: file
    path: src/sessions/session-log.js
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: session-search-js
    type: file
    path: src/sessions/session-search.js
---

# Sessions

A **session** is the ward's continuous conversation on one surface — web chat, a
Discord DM, a voice call. It is the unit the rest of the system reasons about: it
is logged to disk, it can be resumed, it is what memory is extracted *from*, and
its audience tag is what decides who may later read it. This page is the map of
the session cluster — start here, then follow the link that matches what you need
to know.

## The five pages

- **[Session lifecycle](session-lifecycle)** — when a session begins, how it ends,
  the one-active-session-per-surface rule, and the manual close-out for a session
  that never got an `endedAt` [@session-log-js].
- **[Session unification](session-unification)** — how turns on different surfaces
  that belong to the same stretch of a day are stitched into one logical session,
  so memory isn't fragmented per surface.
- **[Session memorization](session-memorization)** — the queue that summarises an
  idled or ended session into durable facts, routes them to Phylactery through the
  consent gate, and stores them at the session's own audience tag [@memorization-js].
- **[Session memory extraction](session-memory-extraction)** — the extraction call
  itself: the transcript it's handed (role-faithful, speaker-stamped), the facts and
  deferred follow-ups it pulls, and the `attribution_confidence` it records.
- **[Session search](session-search)** — reading the *raw transcript* back (what was
  literally said), as distinct from recalling distilled memory; and `isWardReadableLog`
  / `sessionLogKind`, the one rule for whose conversation a log is [@session-search-js].

## How they relate

Lifecycle and unification decide **what a session is**; memorization and extraction
decide **what durable knowledge it leaves behind**; search decides **how a past
session is read again**. The throughline is the session *log* — every one of these
reads or writes it, and the log's `audienceTag` + `location` (classified by
`sessionLogKind`) is what keeps a villager's room, a villager's private DM, and the
ward's own chat from ever being confused for one another. For where the knowledge a
session produces ultimately lives, see [Memory and Knowledge](memory-and-knowledge).
