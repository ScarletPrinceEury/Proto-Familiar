---
title: "Outgoing tripwire: catching private material on the way out"
topics: [architecture, village, safety]
sources:
  - id: outgoing-tripwire-js
    type: file
    path: src/village/outgoing-tripwire.js
  - id: held-relays-js
    type: file
    path: src/village/held-relays.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: server-js
    type: file
    path: server.js
---

# Outgoing tripwire: catching private material on the way out

The outgoing tripwire is a privacy-class check on text about to leave the ward's own room —
a `relay_message`, a room reply, or a warm reach-out to a villager — looking for the ward's
own private material rather than for an adversarial instruction. It is the outbound counterpart
to [Injection guard](injection-guard-gap): that module scans text coming *in* from a third party
for an attempt to manipulate the model; this one scans text going *out* for something the ward
never meant to leave the room at all.

## The incident: private material that was never stored as private

A referral code that was, in disguised form, the ward's own full legal name reached a group
channel through `relay_message`. Nothing in the existing content-gating or audience machinery
could have caught it: [Content-based memory gating](content-gating)'s restricted-memory check
only matches things that were actually *stored* as private, and this text was never stored
anywhere — it existed only in the conversation that produced the relay. A pattern-based filter
that only ever checks what was already marked sensitive has a structural blind spot for anything
that was never written down as sensitive in the first place.

## Two checks of different strength

`src/village/outgoing-tripwire.js` is deliberately pure — no I/O, no settings reads, every list
passed in by the caller — so it can be unit-tested directly and reused identically at every
outbound seam [@outgoing-tripwire-js]. It runs two independent checks:

**The keep-between-us list.** `privateIdentifiers`, a list the ward sets directly in the
Knowledge editor's settings and that is never put into any prompt, is matched against outgoing
text with spelling-variant tolerance: an entry like "Robin Smith" also catches `Robin_Smith01`,
`robin.smith`, `RobinSmith`, and the reversed order `Smith Robin` [@outgoing-tripwire-js]. This
check runs on **every** path out to someone other than the ward, not just relays — a live room
reply gets each match swapped for the literal string `[private]` via `redactProtected`, and a
relay with a match is held outright rather than redacted, because a relay is explicitly carrying
the ward's own words to a third party and a silently-edited relay could misrepresent what the
ward actually said [@outgoing-tripwire-js].

**The shape check.** `relayShapeHits` looks for things that merely *look* dangerous regardless of
the keep-between-us list: a known name welded into a handle (`RobinSmith`, `Sam42`), a
code-or-id-shaped token, an email or phone number, or an invite/referral link
[@outgoing-tripwire-js]. This check runs on relays only, deliberately — in an ordinary live room,
people share handles and codes with each other on purpose, and flagging every mention would make
the feature unusable there. A relay is different: it is explicitly the Familiar carrying the
ward's own material somewhere else, so the bar for "pause and check" is lower.

## Why there is no tool to release a hold

A shape-check hit holds the relay in `tomes/.held-relays.json` (`src/village/held-relays.js`)
rather than sending it, redacting it, or asking the Familiar to decide [@held-relays-js]. Release
is deliberately **not** a capability the Familiar has: only the ward can release a held relay,
either the "Send it" button in the web chat or `!send <id>` in their own Discord DM
[@held-relays-js]. The reasoning is structural, not a trust judgment about the Familiar: an
override the Familiar itself can reach is exactly the override a cleverly-worded piece of injected
text could talk it into using, which would defeat the whole point of pausing on a shape hit in the
first place. What the Familiar *can* do is compose and send a new version of the relay with the
flagged material left out — the hold blocks that one specific text, not the underlying intent to
relay something.

A hold that matched the keep-between-us list specifically is never sendable even on the ward's own
release — `releaseHeldRelay` re-checks the list at release time, so an identifier added to the
list *after* the hold was created still blocks it [@held-relays-js]. That list is the ward's own
hard line; the system's answer to "but I actually want this sent" is "send it yourself," not "let
the Familiar override its own list." An unreleased hold expires after `HOLD_DAYS` (7 days) and
stops being sendable through this path at all [@held-relays-js].

## Where it runs

Discord's room-reply path calls `checkRelay`/`redactProtected` ahead of `gateRoomReply` (the
semantic outgoing filter described in [Injection guard](injection-guard-gap)'s Village section),
so a reply can be privacy-redacted and separately content-gated before it ever reaches a shared
channel [@discord-gateway-js]. `relay_message` and warm reach-out both check before composing the
delivery, so a held relay never partially sends.

## Telling the Familiar up front, not just catching it after (0.14.124)

Everything above catches private material already drafted. `othersPresentLine({ voice })` goes
the other direction: it is a first-person instruction the Familiar reads *before* it speaks,
turning the same class of thing this module catches into something it is told to leave out in
the first place — "Other people can read this, so I leave out codes, ids, links, contact info and
anyone's full real name." (or "hear this" when `voice: true`) [@outgoing-tripwire-js]. This is not
a third check layered onto the two above; the pattern and keep-between-us checks still run
unchanged on whatever the Familiar actually drafts.

The line is injected wherever a room is known to have someone other than the ward in it:
`presenceBlock()` includes it for Discord `guild` and `villager-dm` rooms but never for
`ward-dm` [@discord-gateway-js]; the web chat and voice paths in `server.js` append it beside the
`[Now]` time anchor whenever the resolved `audienceTag` isn't `ward-private` [@server-js]. Before
this, the web chat in particular told the Familiar nothing about
who else was present unless a registered villager happened to be in the room or was actively
typing — see [A room's audience that can't be resolved falls back toward
strangers](../decisions/audience-resolution-fails-to-strangers) for the companion fix that landed
in the same pass, closing a related gap where an unreadable Village registry resolved a
someone-else-present room as the ward's own private one instead.

## Related

- [Injection guard: wiring history](injection-guard-gap) — the inbound counterpart: pattern
  scanning for adversarial third-party text, as opposed to this page's outbound scan for the
  ward's own private material.
- [Content-based memory gating](content-gating) — the stored-memory privacy axis this tripwire
  exists specifically because that axis cannot see unstored, in-conversation-only private text.
- [Location Privacy](../decisions/location-privacy) — a different, narrower structural privacy
  boundary (coordinates never reach the model at all) for a comparison of "never generated" versus
  "generated but caught on the way out."
- [A room's audience that can't be resolved falls back toward strangers](../decisions/audience-resolution-fails-to-strangers) —
  the 0.14.124 decision `othersPresentLine` shipped alongside: a failed Village registry read
  during room resolution must land on the narrowest gate, never the ward's own.
- [Shared web chat](shared-web-chat) — the 0.14.122 feature that first gave the web chat a
  per-message room concept, which is what made a room-resolution failure on this surface possible.
- [Villager proactive context](villager-proactive-context) — a different privacy check on an
  outbound message, the Pillar D semantic filter applied to a warm reach-out instead of a live
  room reply, and the fail-closed-instead-of-open direction that makes sense for it.
