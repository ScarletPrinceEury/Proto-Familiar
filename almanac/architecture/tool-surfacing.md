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

## Consequences and constraints

- A turn's tool list is now determined by context, not just request, and changes from turn to turn. A feature expecting a specific tool present every turn must either land in CORE or work with `request_tools` recovery.
- The "always advertise" safety floor for crisis tools means crisis tools are always visible, matching the philosophical commitment: the Familiar's hand on the safety toolbox lid is unconditional and reachable on every turn.
- Providers with tool-count limits (now known to include z.ai/GLM) are now supported without requiring massive schema compression on the operator's side.

## Related

- [Trackers](trackers) — applies surfacing to bring tracker modules into scope based on vocabulary and tracker labels.
- [Weather](weather) — surfaces the weather module based on leaving-the-house language and readiness blocks.
- [Providers and Connection Readiness](providers) — handles which connection/model is used; surfacing/ceiling is orthogonal (both are necessary for provider compatibility).
- [Engineering conventions](../reference/engineering-conventions) — the exact-values and graceful-degradation rules that tool composition follows.
- request_tools — the toolbox-lid mechanism (a CORE tool always advertised) that provides recovery when surfacing trims a needed module, letting the Familiar request any module for the next round.
