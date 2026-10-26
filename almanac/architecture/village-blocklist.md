---
title: "Village block list"
topics: [architecture, village]
sources:
  - id: blocklist-js
    type: file
    path: src/village/blocklist.js
  - id: village-js
    type: file
    path: src/village/village.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: voice-discord-server-js
    type: file
    path: src/voice/voice-discord-server.js
  - id: server-js
    type: file
    path: server.js
  - id: manual-tome-js
    type: file
    path: src/tomes/manual-tome.js
---

# Village block list

The Village block list (0.14.97-alpha) lets the ward name one person in a shared Discord
server who must never reach the Familiar, while the Familiar stays present in that server
with everyone else [@blocklist-js]. The list lives in the Village registry as
`registry.blocked` and syncs to Phylactery with the rest of the registry; the ward edits it
from the People panel's "Blocked accounts" row or a knock's "Block" action, and
`POST`/`DELETE /api/village/blocked` are the only ward-facing surface — nothing here is a
Familiar tool [@blocklist-js] [@server-js].

## A context filter, not a platform block

A Discord block hides the blocked person from the blocker, which is not the goal here. The
goal is that a blocked account's words never exist in the Familiar's context at all, while the
Familiar keeps functioning normally with everyone else in the room [@blocklist-js]. This is a
narrower, code-level sibling of the audience-circle system described in
[Architecture](../architecture)'s Village section: audience circles decide what a session may
be *told*, while the block list decides whether a person's own words enter the pipeline in the
first place.

## Drop on arrival, not store-then-filter

`discord-gateway.js`'s `classifyMessage` checks the block list immediately after the
own-message guard and before anything else: a blocked author's message returns
`{ action: 'ignore', reason: 'blocked' }` before storage, knock capture, media ingest, threat
scoring, or the observe/call-text interleave ever run [@discord-gateway-js]. Every stored line
is a future leak path — memorization, the hippocampus buffer, session history, or a later
`read_file` on a session log — so not storing the line in the first place closes all of those
paths at once, rather than relying on a filter to catch each one downstream [@blocklist-js].

## The ward is checked first

`classifyMessage` tests `wardUserId` before it tests the block list, and
`POST /api/village/blocked` refuses the ward's own Discord id outright [@discord-gateway-js]
[@server-js]. This exists because the ward's messages feed the safety path — threat scoring and
triage — so no list, including a hand-edited `village.json`, can ever silence the ward
[@blocklist-js].

## Blocking does not loosen the audience gate

A blocked person physically present in a guild room or on a voice call still counts as someone
who can read or hear a reply there; dropping their own words does not remove them from the
room's audience for gating purposes [@blocklist-js]. If blocking also pulled someone out of the
audience, that would be a privacy leak in the other direction — something ward-private said
aloud while a blocked person is still in the room would wrongly stop being gated as audible to
them.

## A display name is also the blocked person's text

When someone else mentions or replies to a blocked account, `resolveMentions` and
`directedAtOthers` render the name as `BLOCKED_NAME` ("someone I've blocked") instead of the
real name, because a display name is text the blocked account chose and can carry a prompt
injection the same as a message body [@blocklist-js] [@discord-gateway-js].

## Pre-feature history and `authorId`

Lines stored from before 0.14.97 carry only a `speaker` name, not an `authorId`, so
`withoutBlockedLines` falls back to matching those lines against the names the ward listed on
the block entry (`sanitizeBlockedNames`, capped at 6 names of 40 characters) [@blocklist-js].
Lines stored after this feature carry `authorId` and match on id directly. `authorId` exists
only to let a later block retroactively hide earlier lines from that account; it is never
rendered into a prompt itself. Because the name-based fallback can only hide too much, not too
little, that is the accepted direction of error for older history.

## Voice decides synchronously

A voice call's receiver subscribes to a speaker's audio the moment Discord reports them
speaking, before there is time for an async registry read. `village.js` keeps a `blockedCache`
Set refreshed on every registry read and write (`rememberBlocked`), and
`isBlockedAccountSync({ platform, id })` reads that cache so the voice adapter can make the
subscribe/drop decision synchronously [@village-js]. Text messages have no equivalent cache
because `classifyMessage` re-reads the registry on every message anyway. Two layers enforce the
voice case: `voice-discord-server.js` passes `isBlocked` into the call adapter's join spec so a
blocked account's audio is never subscribed or decoded, and `runTurn()` re-checks
`isBlockedAccountSync` against the resolved speaker before answering, as a belt-and-braces catch
for a block added mid-utterance [@voice-discord-server-js].

## Ward-only, documented through the Manual tome

The Familiar cannot add, remove, or otherwise act on block-list entries; it learns the feature
exists the same way it learns any other ward-facing mechanic, through the self-documenting
Familiar Manual tome's "Blocked accounts" entry (see [Tomes and keyword lore](tomes-and-lore))
[@manual-tome-js]. A blocked villager's own reports about the ward also stop reaching the
Familiar under this feature — that is inherent to dropping their words on arrival, and is the
ward's call to make when they choose to block someone.

## Related

- [Architecture](../architecture) — the Village cluster this feature extends, and the
  audience-circle system the block list sits in front of rather than replaces.
- [Village presence block](village-presence) — a different Village turn-assembly feature that
  reads the same registry; the block list acts earlier, before a turn is assembled at all.
- [Content-Based Memory Gating](content-gating) — the per-topic visibility axis for memories
  already in storage, distinct from this feature's drop-before-storage scope.
- [Tomes and keyword lore](tomes-and-lore) — the Familiar Manual tome mechanism that documents
  this feature to the Familiar itself.
