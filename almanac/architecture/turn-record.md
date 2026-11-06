---
title: "Turn record: a turn is written as it happens, on every surface"
topics: [architecture, sessions]
sources:
  - id: turn-record-js
    type: file
    path: src/sessions/turn-record.js
  - id: session-log-js
    type: file
    path: src/sessions/session-log.js
  - id: server-js
    type: file
    path: server.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: message-sanitize
    type: file
    path: message-sanitize.mjs
---

# Turn record: a turn is written as it happens, on every surface

A **turn** — the ward's message, whatever tool rounds the Familiar runs, and the reply — is
written into its session log incrementally, through each round, rather than committed as one
block once the whole turn finishes. `src/sessions/turn-record.js` is the one module every
surface (web chat, voice, Discord) now uses to do this, replacing three separate and differently
incomplete recording strategies that predate it (0.14.106).

## What each surface was missing before this

Before the shared recorder, each surface wrote a turn to its [session](sessions) log at a
different, incomplete moment: the web chat committed the ward's message, every tool round, and
the reply together, only once the whole turn finished — a closed tab lost all three, and the
retry/fallback ladder re-ran a turn whose tools had already executed, duplicating memory writes
and, in one case, appending an identity section to two files. Voice kept only the words, dropping
the `_toolRounds` `/api/chat` had already run — including three `relay_message` sends on a call
that hung up before the words were stored. Discord stored only the reply, so its tool rounds never
reached the log at all; collapsed history had no record of them, and the "[Last turn …]" line
([Engineering conventions](../reference/engineering-conventions)'s `lastTurnRecord`) never fired
on Discord, because `lastTurnRecord` looked at `session.messages` plus a placeholder for the
current message, and that message was already in `session.messages` under Discord's
persist-first ordering — so no previous turn was ever found to report on.

## The envelope and the three things `openTurn` can decide

A caller sends a `turn` envelope — `{ sessionId, turnId, userMessage, replyMessageId, location,
prevTurnId?, retry? }` — and `openTurn` (`turn-record.js`) is the gate every surface calls before
running a turn's model request [@turn-record-js]. It returns one of three outcomes:

- **Refuse — still running.** A second send of the same `turnId` while its first attempt is still
  mid-round is refused with `_turnStillRunning`; `awaitTurnSettled` lets a caller wait briefly for
  the in-flight attempt to finish writing rather than racing it [@turn-record-js].
- **Refuse — already ran tools.** A `turnId` this process has already run tools for (an in-memory
  set, `ranToolsHere`) or, for an explicit `retry`, a `turnId` the session log itself shows ran
  tools (`turnRanTools`, read from disk so this check survives a server restart) is refused with
  `_turnAlreadyRan` and the stored record handed back [@turn-record-js]. This is the mechanism
  that makes a tool round truly non-repeatable: a retry or fallback-connection resend can never
  re-run a write, it can only receive back what already happened.
- **Proceed, with a prior-turn handoff.** A `prevTurnId` names a turn the calling client never
  received whole — cut off, or a reloaded page. `openTurn` waits for that turn to finish writing
  and hands its record back as `_priorTurnRecord`, so the new turn's caller starts already knowing
  what the previous one actually did, and the client's own history catches up to the server's
  [@turn-record-js].

When none of those apply, `openTurn` returns a `createTurnRecorder` instance bound to the
envelope, backed by `appendSessionMessages` (`session-log.js`) as its write function
[@turn-record-js].

## What the recorder writes, and when

`createTurnRecorder` exposes a small lifecycle a tool loop or chat handler drives directly
[@turn-record-js]:

- `begin()` — persists the ward's message immediately, before the model call starts.
- `round({ toolCalls, results, content })` — persists one finished tool round (the assistant
  carrier holding the calls, then one `role:'tool'` message per result) as soon as its results are
  back, not at the end of the turn.
- `setPartial(text)` — keeps the words written so far, in case the turn is cut off before
  `finish`.
- `finish(text)` — persists the reply once it lands; an empty reply is stored as nothing, and a
  reply replaces any cut-off partial an earlier attempt at the same turn left under the same id.
- `settle()` — called once the request is over regardless of outcome. A turn that began but never
  finished gets whatever partial reply was captured (`cutOff: true`) plus an app note —
  `[App note: that turn was cut off before I finished answering. The tools above had already
  run.]` when tools ran, a shorter form otherwise — built by `cutOffNote`/`cutOffNoteText`
  [@turn-record-js]. A turn where nothing happened at all (no rounds, no partial) is left as just
  the ward's message, which is safe to retry because nothing has run yet.

Every message carries the turn's `turnId` and a stable id, which is what lets a second writer of
the same turn (notably the web client's own local copy) union with the server's record instead of
duplicating it, rather than requiring the two to agree on exactly one writer.

## The write primitive: add-or-replace by id, not a full-log rewrite

`appendSessionMessages(sessionId, messages, { logsDir, defaults, remove })` in `session-log.js`
does add-or-replace by message id, inserts by timestamp, supports removing specific ids (used to
drop a stale cut-off note once a delayed `finish` actually lands), and runs under the same
per-session lock as the full-log writer [@session-log-js]. This exists as its own primitive rather
than routing a partial message list through the ordinary full-log merge writer, because that
merge path assumes a complete message list and would drop any legacy id-less message it didn't
recognize as already present.

## Ordering invariants worth knowing before touching this path

A few sequencing details are deliberate, not incidental, and each was the fix for a real
incident:

- **A round is recorded before the stream loop's client-disconnect check.** The tools ran whether
  or not anyone is still listening by the time the round finishes, so the record must land first;
  checking `clientGone()` before persisting would make a server crash or a cleanup bug able to
  discard evidence of a write that already happened [@server-js].
- **`settle()` runs in the route's own `finally`, not on the response's `close` event.** A
  disconnect fires `close` while a tool call can still be executing; writing the cut-off note at
  that moment would record it before the round it is describing, misordering the log.
- **Discord is its own single writer**, wrapping `answerTurn` inside `handleTurn` so the recorder
  settles exactly once per turn. A deliberate silence (`[pass]`, a deferral, a quiet villager
  ending) calls `finish(null)` so no cut-off note is manufactured for a turn that was never
  supposed to produce words; only a genuinely abandoned turn gets one [@discord-gateway-js].
- **Shared-room records log calls only, never results.** In a room with someone other than the
  ward present, the record (and the "[Last turn …]" line built from it) names which tools ran but
  withholds their results, since a tool's result can carry more than was actually said aloud in
  that room.
- **A voice log's audience tag now comes from its first journaled line.** Before this fix, a voice
  session's `audienceTag` was only ever stamped by its hang-up write, so a call that crashed
  before hanging up left an untagged log that the memory sweep would default to reading as
  ward-private regardless of who was actually on the call. A web chat log carrying no tag was,
  at the time of this fix, a separate, open ward decision rather than something this fix
  addressed; [Shared web chat](shared-web-chat) (0.14.122) closed that gap by having `begin()`
  stamp `meta.audienceTag` onto the ward's message whenever the room isn't `ward-private`.
- **Memorization skips app notes.** `isReadableMessage`, which memorization's `filterReadable`
  now *is* rather than merely calls, excludes the `app-note` kind these cut-off and claim-check
  notes carry, so a cut-off note or an unbacked-claim note is never mistaken for something the
  ward or Familiar actually said when a session is summarized [@message-sanitize].

## Gotchas when working on this code

**There is no in-process test harness for `/api/chat` itself**, because `server.js` listens on
import — a test file cannot drive the route directly. `openTurn`'s logic lives in
`turn-record.js` specifically so its decisions (refuse-running, refuse-already-ran, prior-turn
handoff) are testable against real session-log files without needing a live HTTP server; the
stream loop's own ordering (the point above about recording before the disconnect check) was
verified instead by booting the branch's real server on a spare port against a fake provider.

**Booting `server.js` inside a git worktree touches tracked files.** Starting the server runs the
tome migrations against the tracked condition tomes and seeds manual/call-state files that are
normally runtime-local. Any such run inside a worktree must have those touched files reverted
before a commit, or they will appear as unintended changes to tracked JSON.

**Not every finish reason is treated as "tools ran."** A tool round that ends for a reason other
than `'tool_calls'` is not specially recorded as "did not run" — a stored round always counts as
tools-ran for the retry-blocking purposes above. This was a deliberate scope cut rather than an
oversight: across roughly a thousand logged turns at the time of the fix, no such drop was
observed, so the narrower, already-shipped behavior was judged sufficient rather than adding
complexity for an unobserved case.

## Related

- [Sessions](sessions) — the cluster hub; this page is the session-log *write* mechanism the
  other four session pages (lifecycle, unification, memorization, search) all read from.
- [Session lifecycle](session-lifecycle) — how a session begins and ends; this page covers how a
  single turn inside that lifecycle gets written, not when the session itself closes.
- [Session unification](session-unification) — the multi-writer merge lock
  (`persistSessionLog`/`mergeMessages`) that `appendSessionMessages` is a narrower, id-based
  sibling of.
- [Engineering conventions](../reference/engineering-conventions) — `lastTurnRecord` and the
  tool-call-scaffolding collapse this page's recorded rounds feed into on the next turn, and RULE
  B (budget exhaustion is never silence), which the cut-off note is one instance of.
- [Plain facts about limits, never a verdict](../decisions/plain-facts-about-limits) — the voice
  rule the cut-off note and the unbacked-claim note both follow.
- [Shared web chat](shared-web-chat) — the 0.14.122 feature that gave the web chat the
  per-message `audienceTag` this page's voice-log note once flagged as a missing piece.
