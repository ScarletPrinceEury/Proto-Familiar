---
title: Tool Surfacing and Provider-Safe Ceiling
topics: [architecture, providers, tools]
sources:
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
    note: "context-sensitive tool surfacing, module map, TOOL_MODULES, SAFE_TOOL_CEILING, surfacing logic"
  - id: server-js
    type: file
    path: server.js
    note: "server-side surfacing enforcement, tool composition, ceiling application"
  - id: cerebellum-js
    type: file
    path: cerebellum.js
    note: "tool registry, executor mapping, initial list composition"
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
    note: "Discord tool composition with surfacing + ceiling (composeDiscordTools, recomposeDiscordTools)"
  - id: architecture-doc
    type: file
    path: docs/architecture.md
    note: "architectural overview mentioning tool ceiling + surfacing (0.14.6)"
  - id: troubleshooting-doc
    type: file
    path: docs/troubleshooting.md
    note: "PROTO_FAMILIAR_MAX_TOOLS environment variable documentation"
---

# Tool Surfacing and Provider-Safe Ceiling

Proto-Familiar's full tool registry contains ~110 tools (~110 KB of schema), a size that breaks tool-calling on some providers — notably z.ai's GLM endpoints, which silently fail on oversized tool schemas [@architecture-doc]. Tool surfacing is a context-sensitive mechanism that selects which tool modules travel on each turn, and a hard provider-safe ceiling ensures no single turn ever exceeds the maximum tools a provider can safely handle.

## The registry and module organization

Every Familiar-facing tool belongs to exactly one module, defined in `TOOL_MODULES` [@tool-surfacing-js]. The module map covers ~20 modules:

- **core** — always advertised on every turn: time, memory in/out, identity, session info, interests, safety (crisis tools, distress flagging), and `request_tools` (the toolbox-lid mechanism).
- **Subject modules** — schedule, memory-edit, graph, village, web, weather, trackers, files, etc.
- **Contextual modules** — schedule-read vs. schedule-write (reads need result-reading; writes trigger differently), acks (acknowledgment tools), stewardship, intentions, and others.

The module map is comprehensive: a parity test asserts that every builtin tool has exactly one module assignment, so adding a tool without a module makes the test suite fail rather than silently vanishing [@tool-surfacing-js].

**Complementary tools need matching module placement, not just matching capability.** A tool
that only adds and a tool that only cuts are a pair, and if one rides in CORE while the other is
conditional, a turn can surface the half that adds without ever surfacing the half that cuts.
This shipped as a live bug: `update_identity` (append) is CORE, but `remove_from_identity`,
`delete_identity_section`, and `rewrite_identity_section` originally lived in the conditional
`memory-edit` module, so a turn that did not happen to surface `memory-edit` could add to
identity but had no way to remove anything — in the first identity review the Familiar, trying
to undo a duplicated section, "removed" it by appending it a second time instead, because the
only identity tool actually on offer that turn was the append one. The fix (0.14.75-alpha) moved
all three cut tools into CORE beside `update_identity`, keeping the add/cut pair reachable
together on every turn [@tool-surfacing-js]. A test pins the fix by asserting a core-only turn
offers all four, and that none of the four is on any villager allowlist. See
[Phylactery](phylactery)'s "Identity editing" section for the tools themselves and
[Care facts move out of identity into high-care standing facts](../decisions/care-facts-out-of-identity)
for why identity needed cut tools at all.

## Context-sensitive surfacing: when modules travel

The same turn may need different tool modules depending on the context — a turn mentioning "mood" should surface trackers, a turn with outside-event language should surface weather, a turn asking to search should surface web tools. Surfacing is **default-ON** and cheap (regex + block markers + a sticky TTL), never an LLM decision [@tool-surfacing-js].

Three channels bring modules into scope:

1. **Static vocabulary** — words like "mood", "sleep", "hydration", "pantry", "laundry" and actions like "log", "add to", "how are my" automatically surface the `trackers` module. Similar patterns exist for weather ("leaving the house", "outside"), web (search terms), schedule (calendar/event language), and others [@tool-surfacing-js].

2. **Registry regex** — an existing tracker's own label (e.g., "spoons" energy tracking) surfaces the `trackers` module if that label appears in the turn text. This is generated per-turn from active tracker labels [@tool-surfacing-js].

3. **Dynamic block** — a `[Tracker cues]`, `[Weather alerts]`, or other dynamic block injected into the context can carry its own `modules` hint, surfacing the module needed to act on that context [@tool-surfacing-js].

## The provider-safe ceiling (0.14.6)

The problem: the full registry is ~110 tools, which breaks tool-calling on providers like z.ai/GLM. Before 0.14.6, nothing capped what a turn sent — surfacing happened passively, and some turns would still exceed provider limits.

The solution: a hard ceiling, default 64 tools per turn, tunable via `maxToolsPerTurn` in settings or `PROTO_FAMILIAR_MAX_TOOLS` environment variable [@tool-surfacing-js] [@server-js]. When the composed tool list would exceed the ceiling:

1. **Auto-trim via surfacing** — even if the ward's surfacing toggle is OFF, the turn auto-trims by narrowing which modules travel [@tool-surfacing-js]. This ensures that a large registry can never break tool-calling by itself.

2. **Hard enforcement** — a final `enforceToolCeiling` call hard-caps the list while **always keeping CORE** (safety tools, `request_tools`, and identity) [@tool-surfacing-js]. The safety floor ensures the Familiar always has crisis tools and the ability to request any module via `request_tools`.

3. **Recovery via `request_tools`** — the toolbox-lid mechanism (`request_tools`, the tool that asks for other modules) is always advertised. If surfacing trimmed away a needed module, the Familiar can reach it in the next round via `request_tools`.

## Discord parity (0.14.6)

Discord turns previously always surfaced the full registry (never surfaced), creating a provider ceiling violation when the Familiar ran on z.ai via Discord. The fix brings Discord tool composition into parity with the web path:

**Ward Discord turns** now run the same surfacing + ceiling logic as web turns, with `composeDiscordTools` taking a `modules` Set parameter that narrows its composition [@discord-gateway-js]. When the Familiar requests a module via Discord's `request_tools` equivalent, the call flows through `recomposeDiscordTools` (wired via `getTools`) to pull the requested module into scope for the next turn, maintaining the recovery contract.

**Villager Discord turns** (a Discord guest or party member) keep their fail-closed grant-based allowlist and only get the ceiling guard — they cannot request arbitrary modules [@discord-gateway-js].

## The module-composition flow

1. `cerebellum.js` holds the tool registry and executor mapping [@cerebellum-js]; `server.js` measures the full registry at boot and throughout a turn.
2. For each turn, `composeActiveTools` (web) or `composeDiscordTools` (Discord) applies surfacing logic and receives a narrowed `modules` Set if the full list would exceed the ceiling.
3. Each call site that builds tool lists (chat proxy, autonomous loops, Discord gateway) calls `enforceToolCeiling` as a final guard.
4. The result is a provider-safe tool list that never breaks z.ai, GLM, or other provider-limited backends.

## Settings and safety

`toolCeiling(settings)` reads the ward's custom ceiling (if set and > 0) or returns `SAFE_TOOL_CEILING` (64) [@tool-surfacing-js]. An invalid setting (negative, non-numeric, too small) defaults to the safe baseline without raising an error — the ward gets the knob but not a way to reintroduce the ceiling breach through misconfiguration. The ceiling is tunable via the `maxToolsPerTurn` setting or `PROTO_FAMILIAR_MAX_TOOLS` environment variable [@troubleshooting-doc].

The off-switch `PROTO_FAMILIAR_SURFACING_DISABLED=1` turns off surfacing logic entirely, but the hard ceiling still applies — surfacing auto-trim is bypassed, but `enforceToolCeiling` remains a non-negotiable guard [@tool-surfacing-js].

## The tool roster: a names-only reminder, and saying "I can't" plainly

Deep into a long conversation, the model loses track of which tools it actually has this
round — the provider puts the full tools schema at the very top of the prompt, far from where
the model is actually reading by the time a conversation has grown long, and it has been
observed narrating calls it never made or "calling" a tool that was not even in that turn's set
[@tool-surfacing-js]. `formatToolRoster(tools)` (0.14.74-alpha) is a short, names-only, first-person block that
rides at the END of the context every round instead, grouped by module, naming which other
modules could still be pulled in with `request_tools`, with a hard off-switch
(`PROTO_FAMILIAR_TOOL_ROSTER_DISABLED=1`) [@tool-surfacing-js]. `anchorWithToolRoster` appends it
under the turn's time anchor; it renders as `''` on a closing text round (no tools) or when the
roster is disabled. It shipped alongside a per-turn tool-call diagnostic log built from the same
review (`src/diagnostics/turn-log.js`) — see [Autonomous loops](autonomous-loops)'s Diagnostics
panel section for that mechanism, and [Engineering conventions](../reference/engineering-conventions)'s
collapseToolTurns section for the specific narrated-call pattern it later helped diagnose.

The roster's closing line is a deliberate, plain statement of the structural fact "a tool only
runs when I actually call it" [@tool-surfacing-js], and, since 0.14.83-alpha, an explicit
permission to say so without self-blame: "If something I'd need isn't here, I just say I can't do
that from here, in my own voice, and move on. A missing tool is a gap in my kit, nothing I did
wrong" [@tool-surfacing-js]. That wording exists because an identity-verification review showed
the opposite habit shipping by default — any mention of a limit, including one that was plainly
the app's own gap, turning into self-blame and a new self-imposed rule. See [Plain facts about
limits, never a verdict](../decisions/plain-facts-about-limits) for the incident and the decision
this line, the round-cap note, and the last-turn record all now share.

## A tool's own description can contradict what it's actually offered

Surfacing and the ceiling both decide *whether* a tool is offered; neither one checks whether a
tool's own description still describes the turn it is being offered on. The browser-vs-plain-reader
choice (0.14.65-alpha) is the case that exposed this gap: with browsing on, `composeActiveTools`
already removed `read_webpage` and offered `browse_open` in its place, but `web_search`'s
description still told the Familiar its results were links "I can then open with `read_webpage`",
and `browse_open`'s own description added "`read_webpage` is cheaper for plain reading, so I try
that first" — both strings kept steering the model toward a tool that was not in that turn's list
at all, so it kept reaching for the wrong one regardless of what composition had actually decided
[@tool-surfacing-js]. See [Browser](browser)'s "The browser becomes how the Familiar reads pages"
section for the fix: `browser-gate.js`'s `browserReadsPages(settings)` is now the single predicate
both the tool filter and the tool descriptions read, so the two can no longer drift apart, and
`withPageReaderModule` keeps whichever reader is actually in play riding alongside the `web`
surfacing trigger so a search-then-open never burns a `request_tools` round just to reach a tool
that was always going to be offered. The general lesson for this page: a tool description is part
of the contract composition enforces, not just documentation — a description that recommends a
tool the current composition will never offer is a bug in the same family as an unreachable
capability, even though the tool itself is reachable.

## Consequences and constraints

- A turn's tool list is now determined by context, not just request, and changes from turn to turn. A feature expecting a specific tool present every turn must either land in CORE or work with `request_tools` recovery.
- The "always advertise" safety floor for crisis tools means crisis tools are always visible, matching the philosophical commitment: the Familiar's hand on the safety toolbox lid is unconditional and reachable on every turn.
- Providers with tool-count limits (now known to include z.ai/GLM) are now supported without requiring massive schema compression on the operator's side.

## Related

- [Autonomous loops](autonomous-loops) — the Diagnostics panel's "Tool turns" tab, built from the
  same 0.14.74-alpha review, that records per-round whether a call actually ran.
- [Phylactery](phylactery) — the identity-editing tools this page's module-placement worked
  example is about.
- [Browser](browser) — the one-page-reader-per-turn rule (0.14.65) that is this page's worked
  example of a tool description drifting from what composition actually offers.
- [Noticing](noticing) — `composeNoticingTools` (0.14.82) rebuilds the background noticing turn's toolset from this same module-surfacing and `request_tools` growth mechanism, replacing an earlier fixed tool list that silently fell behind live-turn capabilities.
- [Trackers](trackers) — applies surfacing to bring tracker modules into scope based on vocabulary and tracker labels.
- [Weather](weather) — surfaces the weather module based on leaving-the-house language and readiness blocks.
- [Providers and Connection Readiness](providers) — handles which connection/model is used; surfacing/ceiling is orthogonal (both are necessary for provider compatibility).
- [Engineering conventions](../reference/engineering-conventions) — the exact-values and graceful-degradation rules that tool composition follows, plus the companion `ROUND_CAP_NOTE`/`lastTurnRecord`/`findTextToolCalls` plain-fact self-report mechanisms.
- [Plain facts about limits, never a verdict](../decisions/plain-facts-about-limits) — the decision behind the tool roster's missing-tool line.
- request_tools — the toolbox-lid mechanism (a CORE tool always advertised) that provides recovery when surfacing trims a needed module, letting the Familiar request any module for the next round.
