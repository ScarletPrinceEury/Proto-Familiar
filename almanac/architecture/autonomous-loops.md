---
title: Autonomous Loops
topics: [architecture, autonomous-loops]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Autonomous Loops

Autonomous loops are background workers that run alongside Proto-Familiar's HTTP server and
act without a human request — checking in during silence, firing a reminder, drifting off to
ponder an interest, syncing a calendar. CLAUDE.md counts ten of them, each booted in
`server.js`'s `app.listen()` callback and each stopped from the SIGTERM/SIGINT/SIGHUP handler
so a clean shutdown can await any in-flight tick [@claude-md] [@architecture-doc]. Loops exist
because the Familiar is designed to be a companion who can reach out, not a request-response
tool — see [Proactivity over caution](../decisions/proactivity-over-caution) for why that
design choice is treated as safety-critical rather than a nice-to-have.

## The shared contract

Every loop follows the same shape, stated in CLAUDE.md as a rule rather than a habit
[@claude-md]:

- **A settings toggle plus a hard `PROTO_FAMILIAR_*_DISABLED=1` environment off-switch**,
  shipped in the same commit as the loop itself — "we can add the switch later" is not an
  acceptable state to ship in [@claude-md].
- **Independent failure.** A loop crashing, or a peer it depends on being down, must never
  surface as an error in the human's live conversation. `enrich()`'s `Promise.allSettled`
  fan-out and `executeToolCall()`'s never-throw contract are the mechanisms underneath this
  guarantee — see [Architecture](../architecture) for how thalamus and cerebellum enforce it
  [@claude-md].
- **Reentrancy guards and a graceful stop.** A loop tracks whether a tick is in flight and a
  `stop*()` call awaits it rather than killing it mid-write.

## The loops

| Loop | File | Cadence | Default | Off-switch |
|---|---|---|---|---|
| Pondering | `pondering-loop.js` | tiered by interest weight + threat (30min–6h) | on | `PROTO_FAMILIAR_PONDERING_DISABLED=1` |
| Reminders + event alerts | `reminders-loop.js` + `event-alerts.js` | 30s poll | on | `PROTO_FAMILIAR_REMINDERS_DISABLED=1` / `PROTO_FAMILIAR_EVENT_ALERTS_DISABLED=1` |
| Silence triage | `silence-triage-loop.js` | 5min, LLM-set cool-down | on | `PROTO_FAMILIAR_TRIAGE_DISABLED=1` |
| Warm reach-out | `reachout-loop.js` + `reachout.js` | 10min, ~2h cool-down | on | `PROTO_FAMILIAR_WARMTH_DISABLED=1` |
| Discord gateway | `discord-gateway.js` | 30s supervisor | on (idles without a bot token) | `PROTO_FAMILIAR_DISCORD_DISABLED=1` |
| Memorization | `memorization.js` | 5s queue drain | on | `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` |
| Memory sweep | `memory-sweep-loop.js` | 10min | on | `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1` |
| Tome → Phylactery graduation | `tome-graduation-loop.js` | 30min | **off** | `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1` |
| Needs tracking | `needs-tracking-loop.js` | 30min | **off** | `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1` |
| Google Calendar sync | `gcal-sync-loop.js` | 60s base tick, ward-configurable interval | **off** | `PROTO_FAMILIAR_GCAL_DISABLED=1` |

(Sourced from CLAUDE.md's "Autonomous loops" section and `docs/architecture.md`'s
autonomous-loop boot list [@claude-md] [@architecture-doc]. Stewardship and the weekly
routine review are related but are *not* standalone loops: stewardship rides `enrich()` on
every chat turn, and the routine review rides an existing pondering reflection tick, rather
than owning a `setInterval` of its own [@architecture-doc].)

## Loops that write to the canonical self default off

Tome graduation and needs tracking are opt-in because they write to
[Phylactery](phylactery), the canonical self — the milestone note in CLAUDE.md treats writes
to canonical state as requiring an explicit ward decision, not a shipped default
[@architecture-doc]. Google Calendar sync is opt-in for a related but distinct reason: it is
the one loop that can eventually reach an external service the ward's real calendar depends
on, and its write-back path (`schedule_push_to_google`) is gated behind its own separate
opt-in on top of the loop being enabled at all [@architecture-doc].

## Loops that defer to crisis handling

Warm reach-out and needs tracking both stand down entirely once the ward's threat tier
reaches moderate or higher, so they never compete with silence-triage for the moment that
matters [@architecture-doc]. This is deliberately the opposite failure direction from the
incident recorded in
[Proactivity over caution](../decisions/proactivity-over-caution) — deferring a
companionship signal in favor of the crisis loop is adding caution in a place that costs
nothing, not the "bias toward staying quiet" pattern that caused real harm when it leaked
into the *safety* decision itself.

## Related

- [Safety spine](safety-spine) — the crisis-detection and escalation machinery
  silence-triage sits on top of.
- [Proactivity over caution](../decisions/proactivity-over-caution) — why these loops default
  to acting rather than waiting.
- [Engineering conventions](../reference/engineering-conventions) — the graceful-degradation
  and versioning rules that every loop above is written to follow.
