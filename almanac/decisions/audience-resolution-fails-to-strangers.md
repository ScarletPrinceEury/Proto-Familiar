---
title: "A room's audience that can't be resolved falls back toward strangers, never toward ward-private"
topics: [decisions, village]
sources:
  - id: audience-js
    type: file
    path: src/village/audience.js
  - id: room-privacy-test
    type: file
    path: tests/room-privacy.test.mjs
  - id: outgoing-tripwire-js
    type: file
    path: src/village/outgoing-tripwire.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: server-js
    type: file
    path: server.js
  - id: audience-gating-build-spec
    type: file
    path: docs/audience-gating-build-spec.md
---

# A room's audience that can't be resolved falls back toward strangers, never toward ward-private

**Status: decided, implemented (0.14.124-alpha).** When the web chat has someone other than the
ward marked present and the Village registry cannot be read, the room resolves as one with a
stranger in it — the narrowest, least-trusting gate the system has — rather than falling back to
the ward's own private room. This is a general rule for any surface that resolves a room's
audience from a registry read that can fail: **a failed read must never produce the most
permissive answer.** It must produce the least permissive one that still reflects what is
actually known (someone else is here).

## Context

Before this fix, `/api/chat`'s web chat path derived a room's audience by reading the Village
registry when `sessionAudience` named someone present. If that read threw — a half-written
registry file, a transient disk error — the surrounding code had no explicit fallback, and the
room silently resolved as `ward-private`: full private context was assembled, the Pillar D
outgoing filter never ran (it skips entirely on `ward-private`), and any memory extracted from
the turn was filed at the tightest, least-shared audience tag — all while someone else was
actually present and reading the reply. The audience-gating build
spec's own fail-closed rule — a registry read failing during gating should fall back to the most
restrictive option, never "show all" — already governed the *recall* side of this surface
[@audience-gating-build-spec]; this web chat code path applied the opposite outcome to *room
resolution* on the same kind of failure, landing on the most permissive room instead of the most
restrictive one.

The failure mode is specific to *resolving* a known-non-solo room, not to an ordinary solo chat.
`sessionAudience` is only sent to the server at all when the page has someone marked present, so
a plain solo chat's gate derivation never enters this code path and stays exactly as fast and
unaffected as before.

## Decision

`strangerRoomGate()` in `src/village/audience.js` returns the gate a room with an unregistered
stranger in it would get from an empty registry: `{ grants: {}, tag: 'strangers', visible:
['strangers', 'ward-content-gated'], topics: {} }` — nothing granted, because whatever the ward
granted strangers specifically is stored in the very registry that could not be read
[@audience-js]. `roomGateOrStranger(sessionAudience, loadRegistry)` is the fail-safe wrapper every
such call site should use: it tries the normal `roomGate(sessionAudience, registry)` derivation
and falls back to `strangerRoomGate()` on any thrown error, from either the registry load or the
audience resolution itself, returning the error on the result (`error`, `null` when nothing went
wrong) so a caller can log it without the fallback ever throwing further [@audience-js].

A pinned test asserts that the fallback is not merely *a* private gate but *exactly* what a real,
registered stranger gets from an empty registry — `strangerRoomGate()` must equal
`roomGate({...}, { categories: [], villagers: [], locations: [] })` — so the fallback path and the
real stranger-tier path cannot silently drift apart from each other over time
[@room-privacy-test].

`roomGate(sessionAudience, registry)` itself is the companion piece this decision introduced: one
function that derives `grants`, `tag`, `visible`, and `topics` together, so `/api/chat`'s web
chat path and Discord's `resolveLocationGate` call the same derivation instead of each computing
the four values independently and risking exactly the kind of two-copies drift [Village presence
block](../architecture/village-presence) warns about for a different privacy gate
[@audience-js] [@discord-gateway-js].

**Discord needed no equivalent fallback.** `classifyMessage` needs a readable registry to route a
message at all; an unreadable registry there means no reply is produced, not a silent fallback to
a wrong gate. The fail-toward-strangers rule specifically addresses a surface — the web chat —
that can still assemble and send a reply even when the registry read inside its audience
resolution fails.

## Consequences

A chat turn that happens to occur during a registry read failure, with someone else marked
present, is now filed to memory as said in front of a stranger rather than as the ward's own
private words — the content gate (see [Content-based memory gating](../architecture/content-gating))
still decides who could ever actually recall it, so this is a conservative, not a lossy,
consequence: nothing is granted to the fallback room, but nothing ward-private leaks into it
either.

**A companion line was added at the same time.** Every room someone else can read now carries one
line telling the Familiar what it leaves out of its own words there: `othersPresentLine({ voice })`
in `src/village/outgoing-tripwire.js` returns "Other people can read this, so I leave out codes,
ids, links, contact info and anyone's full real name." (or "hear this" on a voice call)
[@outgoing-tripwire-js]. This is not a new filter — [Outgoing tripwire](../architecture/outgoing-tripwire)'s
pattern checks still run exactly as before — it is the same shape list turned into a first-person
instruction the Familiar reads before it speaks, so it is less likely to reach for a code, id, or
full name in a shared room in the first place. `presenceBlock()` in `discord-gateway.js` includes
the line for `guild` and `villager-dm` rooms but not `ward-dm` [@discord-gateway-js]; the web chat
and voice paths in `server.js` append the same line beside the `[Now]` time anchor whenever
`audienceTag !== 'ward-private'` [@server-js]. Before this, nothing told the Familiar in the web
chat specifically that anyone else was present unless a registered villager happened to be in the
room or someone else was mid-typing.

**The general rule for new surfaces.** Any future surface that resolves a room's audience from a
registry or similar lookup that can fail should derive its gate through `roomGate` (or an
equivalent single derivation) and fail toward the narrowest known-safe gate — a stranger, an
empty grant set — never toward the ward's own unscoped view. Resolving toward `ward-private` on
a read failure is specifically the bug this decision fixes, and a future surface that reintroduces
it would reintroduce the same incident.

## Related

- [Content-based memory gating](../architecture/content-gating) — the per-topic gate that still
  decides what a stranger-tier fallback room could ever recall, so this decision's "nothing
  granted" fallback is a floor, not the only gate in play.
- [Shared web chat](../architecture/shared-web-chat) — the 0.14.122 feature that gave the web
  chat a per-message room concept in the first place, making a registry-read failure during
  audience resolution possible on this surface at all.
- [Village presence block](../architecture/village-presence) — the earlier instance of extracting
  a two-reader privacy decision into one shared function, the same discipline `roomGate` applies
  here to audience derivation.
- [Trust tiers gate reads, not writes](trust-tiers-gate-reads-not-writes) — the read-only framing
  this fallback inherits: `roomGateOrStranger`'s worst case only narrows what a session can be
  told, never what it writes.
- [Outgoing tripwire](../architecture/outgoing-tripwire) — the pattern-based privacy scan
  `othersPresentLine` complements by turning the same "what not to share" list into something the
  Familiar is told up front, rather than only caught after the fact.
