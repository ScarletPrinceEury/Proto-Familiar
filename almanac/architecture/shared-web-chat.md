---
title: "Shared web chat: a room is stamped per message, not per session"
topics: [architecture, village, sessions, memorization]
sources:
  - id: session-log-js
    type: file
    path: src/sessions/session-log.js
  - id: turn-record-js
    type: file
    path: src/sessions/turn-record.js
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: outgoing-filter-js
    type: file
    path: src/safety/outgoing-filter.js
  - id: message-sanitize
    type: file
    path: message-sanitize.mjs
  - id: public-app-js
    type: file
    path: public/app.js
  - id: shared-web-chat-test
    type: file
    path: tests/shared-web-chat.test.mjs
---

# Shared web chat: a room is stamped per message, not per session

Before 0.14.122, the ward's web chat had no concept of anyone else being present. Every
message the page sent was filed to memory as said in the ward's own room (`ward-private`),
even on a page where the ward had marked someone else present in "Speaking as" — the picker
that lets another person at the ward's keyboard claim a message as their own rather than
having it misattributed to the ward. A fact the ward said about themselves in front of that
other person was therefore stored at the tightest audience tag that exists, which [Content-based
memory gating](content-gating) and the coarser Village audience floor would both have kept
private — except the fact was never actually said in private. The fix threads an `audienceTag`
through the web chat the same way Discord's shared guild rooms already carry one, but it has to
solve a problem Discord doesn't have: a web chat page stays open for hours, and people join and
leave the conversation mid-session.

## The room is stamped per message, not per session

`audienceTag` became a server-owned message field — `SERVER_OWNED_MESSAGE_FIELDS` in
`src/sessions/session-log.js` lists it as the one field the client never gets to set or
overwrite on its own copy [@session-log-js]. The turn recorder (`src/sessions/turn-record.js`)
writes it onto the ward's message at `begin()` time, reading `meta.audienceTag` from whatever
the caller resolved the room to be for that particular message, and only when the room isn't
`ward-private` — a solo message carries no `audienceTag` at all, which keeps the vast majority
of logged messages byte-identical to before this feature [@turn-record-js].

Stamping per message rather than per session matters because a web chat session can span a
visitor arriving, leaving, and the ward continuing alone — a per-session tag would either
leak the visitor's presence onto messages they never heard, or keep tagging the ward's solo
messages as shared long after the room emptied. `message-sanitize.mjs`'s `collapseToolTurns`
strips `audienceTag` before history reaches a provider, so the tag is bookkeeping for memory
and the outgoing gate, never something the model reads as part of the conversation
[@message-sanitize].

**The stamp survives the page's own write path.** The web client keeps its own local copy of
the conversation and periodically saves it back to the server, and that save was always a
simpler, full-message-list writer than the turn recorder's add-or-replace-by-id primitive (see
[Turn record](turn-record)). Because the client's copy never carries `audienceTag` — it is
server-owned — a naive merge would have dropped the tag the moment the page saved over it.
`session-log.js` closes that gap with three small pure helpers exercised directly in
`tests/shared-web-chat.test.mjs` [@shared-web-chat-test]: `keepServerOwned(stored, incoming)`
keeps `stored`'s value for every field in `SERVER_OWNED_MESSAGE_FIELDS` unless `incoming`
explicitly carries its own; `withStoredRooms(page, stored)` re-applies the stored room onto a
page's message list by id before it is written back; and `mergeMessages` (the full-log merge
writer [Session unification](session-unification) already uses) calls through the same logic so
every write path — the turn recorder, the page's periodic save, and a historical log rewrite —
agrees on which copy of `audienceTag` wins [@session-log-js].

## Memorization reads a conversation room by room

A session that was ward-private for part of its length and shared for another part cannot be
handed to the extractor as one slice with one audience tag — doing so would either file the
shared portion as private or the private portion as shared. `roomRuns(messages, fallbackTag)`
in `src/memory/memorization.js` is the pure function that slices a message list at every point
the room changes: it walks the messages, and each time a `user`-role message carries its own
`audienceTag` the "current room" switches to that value (or back to `fallbackTag` when the
message carries none), with consecutive messages in the same room collapsing into one run
[@memorization-js]. A reply is kept with the message it answers, since a reply itself has no
independent room; the room a reply belongs to is whichever room was current when the question
that produced it arrived.

`processJobByRoom(job, deps, run)` is the wrapper the queue worker actually calls:
`roomRuns` slices `job.messages` by `job.audienceTag` as the fallback, and when there is more
than one run, it calls the ordinary `processJob` extractor once per run, threading
`priorThrough` forward so each run's day-anchored offset bookkeeping (see [Session
memorization](session-memorization)) stays correct across the split [@memorization-js]. The
common case — a slice said entirely in one room, which is nearly every slice — takes the
`runs.length <= 1` fast path and calls `processJob` exactly once, unchanged from before this
feature [@memorization-js]. A run that fails on a `scope: 'day'` job re-throws immediately
(a day-anchored job's offset tracking cannot tolerate a partially-applied split); for other
scopes, one run failing does not stop the remaining runs from still being memorized at their
own, correct room [@memorization-js].

## With others present, a reply comes whole, never streamed

A streamed reply renders on screen token by token as the model produces it, which means the
room would see a shared reply before [Content-based memory gating](content-gating)'s sibling
check — the Pillar D semantic outgoing filter and the keep-between-us list described in
[Outgoing tripwire](outgoing-tripwire) — ever got a chance to look at the finished text.
`gateRoomReply` in `src/safety/outgoing-filter.js` already ran this check for non-streaming
paths; 0.14.122 added `uncheckedStreamRefusal({ stream, audienceTag })`, which refuses a
request that asks to stream while the resolved `audienceTag` is anything other than
`ward-private` or empty, returning `{ error, _streamRefused: true }` instead of opening the
stream [@outgoing-filter-js]. A page built before this feature that still requests a stream for
a room with someone else present gets this 409-style refusal with a message telling it to
reload, rather than ever opening a channel the outgoing gate cannot inspect before it reaches
the room [@outgoing-filter-js].

## "Speaking as" becomes a handover, not just an attribution label

"Speaking as" (0.14.87) already let someone else at the ward's keyboard claim a message as
theirs instead of having it misfiled as the ward's own. 0.14.122 turned that one-off
attribution into a standing handover: picking a name in the picker hands the chat to that
person, and it stays theirs — every subsequent message is attributed to them, not re-prompted
per message — until the ward explicitly taps "Me again" or `HANDOVER_IDLE_MS` (10 minutes) of
inactivity elapses, tracked by a 30-second interval checking the time since the handover's last
message [@public-app-js]. A banner stays visible for the whole handover so it is never ambiguous
whose turn it currently is, and picking someone adds them to the room's "who's here" roster —
the same roster [Village presence block](village-presence) reads to decide whether to inject a
known villager's identity facts into the turn, so a handed-over conversation is gated for that
person the same way a Discord shared room is [@public-app-js].

## A test-suite gotcha: this subsystem reaches live children through imports

`tests/shared-web-chat.test.mjs` imports `src/memory/memorization.js`, and `memorization.js`
reaches `thalamus.js` at module load time. Without
`PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` and `PROTO_FAMILIAR_UNRUH_DISABLED=1` set *before* those
imports run, the test file would spawn the real Phylactery and Unruh child processes, and a live
child left running is exactly what keeps `npm test` from ever exiting [@shared-web-chat-test].
The test file sets both env vars as its first executable lines, ahead of every `import`, for
this reason.

## Related

- [Turn record](turn-record) — the add-or-replace-by-id write primitive `audienceTag`
  piggybacks on, and the page whose own "a web chat log still carries no tag" gap this feature
  closed.
- [Content-based memory gating](content-gating) — the per-topic sensitivity axis that now
  actually applies to a shared web chat message, instead of every such message being filed at
  the tightest possible audience by default.
- [Village presence block](village-presence) — reads the same "who's here" roster a handover
  adds a person to, so a handed-over conversation gets that person's pronouns and distinguishing
  facts the same way a Discord shared room does.
- [Outgoing tripwire](outgoing-tripwire) — the keep-between-us and shape checks `gateRoomReply`
  runs alongside the Pillar D semantic filter before a shared-room reply is allowed to leave.
- [Session memorization](session-memorization) — the queue and day-anchored offset tracking
  `processJobByRoom` threads `priorThrough` through when a slice splits across rooms.
- [Session unification](session-unification) — the multi-writer merge lock `mergeMessages`
  belongs to, now carrying the same server-owned-field discipline `audienceTag` needs.
