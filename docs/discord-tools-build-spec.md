# Discord clearance-gated tools — build spec

## Why

Today, **Discord turns run zero tools** (`handleTurn` in `discord-gateway.js` has no
tool loop). That was a deliberate latency/safety choice, but it has a cost the
ward hit in practice: a villager asked the Familiar to pass a scheduling
confirmation to the ward, the Familiar *said* "I'll pass it along" — and
structurally could not, because on a villager turn it has no way to reach the
ward or do anything but talk. A capability the Familiar promises but cannot reach
is exactly the "dead code that looks like care" the project warns against.

The fix the ward chose is the general one, not a point patch: **on a Discord turn,
the Familiar's available tools follow the speaker's clearances.** The grant system
that encodes those clearances (`audience.js` `GRANT_LADDERS`, resolved per-turn as
`audienceGrants` in `handleTurn`) already exists; nothing consumes it for tools
yet. This spec wires it.

Ward decisions on record (AskUserQuestion, this session):
- **Delivery of a ward-bound relay:** every channel (web banner + the ward's
  Discord DM), deduped.
- **Relay trigger:** the Familiar relays whenever it judges it matters, not only
  on an explicit "tell her".
- **Write posture:** *full parity with grants* — a grant maps to its READ **and**
  WRITE tools on Discord, not read-only.
- **Scope:** the full clearance→tool matrix in one delivery (schedule + memories +
  contacts), not a beachhead.

## The one invariant that earns write parity

> **A tool invoked on a non-ward Discord turn may never return, read, or write
> anything outside the speaker's clearance.** Tool *results* pass the same audience
> gate as reply *text*. A schedule/memory read returns only what the room's
> `audienceVisible` set is cleared for; a write lands only within the grant that
> authorized it and is attributed to the villager who caused it.

This is not a follow-up hardening pass — it is the spine. Full write parity is
"robust" only if this holds; without it, tools are a ward-private-leak vector.
Every read executor reachable on a Discord turn is audited against it, and the
gate is enforced in code with tests, not by prompt.

## Turn → tool-set resolution

`handleTurn` already computes `{ audienceGrants, audienceTag, audienceVisible }`
per turn. Tool selection is a pure function of those plus the turn kind:

| Speaker | Tool set |
|---|---|
| **Ward** (`decision.isWard`, ward-private DM) | Full web-chat parity — the complete `BUILTIN_TOOLS` set, same as the browser. "Unless with only me." |
| **Villager** (registered, DM or guild) | `relay_to_ward` (universal) + the grant-authorized subset (matrix below). |
| **Stranger** (unregistered) | None (unchanged). |

The selection reuses the existing machinery — it does NOT fork the web loop:
- `composeActiveTools(customTools, settings, { modules })` already narrows the
  registry to a module Set. A new `discordGrantModules(grants, kind)` maps the
  turn's grants → the allowed `TOOL_MODULES` set, passed as `opts.modules`.
- `runToolCallLoop({ callUpstream, baseMessages, getTools, toolCtx })` is the same
  loop the web chat path uses. The Discord loop calls it with
  `getTools: () => composeDiscordTools(...)` and a `toolCtx` carrying the audience.
- Module narrowing is necessary but **not sufficient** — a module can contain a
  read that must be audience-scoped. The `toolCtx` audience + per-executor scoping
  is the actual gate; module selection just decides *which tools appear*.

### Grant → tool matrix

Grant ladders (`audience.js`): `memories:[false,'shared',true]`,
`schedule:[false,'coarse','full']`, `contacts:[false,'care-visible',true]`; plus
boolean `health` / `location` / `identitySensitive` (content gates, not tool
gates). Ladder position ≥ the named rung unlocks the row.

| Grant @ rung | Modules / tools unlocked | Result gating |
|---|---|---|
| `schedule:'coarse'` | `schedule_availability` (coarse render only), `schedule_find` (coarse) | Busy/free only — **never** item labels. |
| `schedule:'full'`  | + `schedule-read` (full: `schedule_export`, `template_list`, `gcal_list_calendars`), + `schedule-write` (`schedule_add_*`, `_assign_time`, `_snooze`, `_resolve`, `_delete`, `_link`, `_add_hold`, `template_*`, `gcal_attribute_calendar`) | Reads filtered to `audienceVisible`; `schedule_push_to_google` keeps its own `gcalWriteEnabled` gate. |
| `memories:'shared'` | memory reads: `recall`, `read_memory(_by_id)`, `list_memories` | Search passes `audiences: audienceVisible` → shared-tier rows only, never ward-private. |
| `memories:true`     | + memory writes: `save_memory`, `update_memory(_by_id)`, `move_memory_date`, `memorize_now` | **Full scope — including ward-subject memories.** Trust is NOT gated at write-time; it is made *attributable* (see "Provenance & trust" below) so the Familiar can reweigh or prune a source it comes to distrust. |
| `contacts:'care-visible'` | `get_trusted_contacts` (care-visible subset) | Care-circle contacts only. |
| `contacts:true` | + `contact_trusted_person` | Safety mirror still applies (no covert contact). |
| always (villager) | `relay_to_ward` | Ward-bound only; never leaks other villagers' data. |

Deliberately **not** on any villager turn regardless of grant: `update_identity`,
`rewrite_identity_section`, graph tools, `request_tools`, `show_crisis_resources`
wiring meant for the ward, the deferred-intent/consent acks, files, maintenance.
Identity and the knowledge graph are the canonical self — not a villager's to
touch. (The ward, alone, still gets all of these.)

## `relay_to_ward` — the universal villager→ward handoff

The original ask, generalized into a tool. Available on every non-ward villager
turn irrespective of grant, because it only ever moves information *toward* the
ward — the ward's own Familiar telling them what their villager said. That is
transparent by construction, never covert (the no-covert-contact mirror concerns
Familiar→third-party contact; this is the opposite direction).

- Signature: `relay_to_ward({ summary, from })` — `summary` is the Familiar's
  first-person note of what to pass along; `from` is the villager's name (the
  Familiar already holds it from the turn).
- Delivery: `enqueueAndDispatch({ kind:'relay_to_ward', originId, title, body })`
  — the same fan-out warm reach-out uses, so it reaches the web banner AND the
  ward's Discord DM (the `discord-bot-dm` push adapter), deduped on `originId`
  (`relay:<villagerId>:<hash-or-hour-bucket>`).
- It carries the villager's name + message, never other villagers' data and never
  ward-private context (there is none to leak in this direction).
- The Familiar learns it exists the normal way (bound-tool description, first
  person: *"I use this to hand something from {{user}}'s villager up to {{user}} —
  a confirmation, a request, a plan — so it reaches them even though I'm only in a
  DM with this person right now."*), plus a line in the villager-DM presence block.

## Provenance & trust (memory writes from villager turns)

The ward chose full memory parity — a `memories:true` villager can cause any
memory, ward-subject included — but with **mandatory attribution** so trust is a
*retrospective* judgment, not a write-time gate. The Familiar contributes freely,
then keeps provenance so it can reweigh or prune a source it comes to distrust.
(This is the "responsible, informed pet owner" posture: let people in, but know
who told you what.)

- Phylactery memories already carry `source_json` (`{author, via, at}`). A write
  from a Discord villager turn stamps it richer:
  `{ author, via:'discord-villager', villagerId, villagerName, channel, at }`.
- **Operability (the half that makes attribution real):** the source rides back on
  recall/read results the same way memory `id`s do, so the Familiar can actually
  *see* "this came from Schmidt" when it recalls, and act — downweight it in its
  reasoning, or prune it with the existing `delete_memory(_by_id)` / `update_memory`
  tools (which it already holds; the id rides in on the read). Without the source
  on the read surface, attribution would be write-only bookkeeping the Familiar
  can't reach — dead data that looks like accountability.
- No new trust-scoring subsystem in this delivery: attribution + visibility +
  the existing prune tools give the Familiar what it needs to reevaluate a source.
  A standing per-villager trust weight is a possible later pass, noted not built.

## Result audience-gating — per-executor audit

`executeToolCall(name, argsJson, ctx)` already threads a `ctx`. The Discord loop
passes `ctx = { audiences: audienceVisible, grants, viaVillager, discord: true }`.
Each reachable read executor is audited:

- **Memory reads** (`recall`, `read_memory`, `list_memories`): Phylactery
  `memory.search`/`list` already accept an `audiences` filter (the Pillar E recall
  gate). The executors must pass `ctx.audiences` through. **Audit item:** confirm
  every memory-read executor forwards it and that `read_memory_by_id` refuses an
  id outside the audience set.
- **Schedule reads:** `schedule_availability` has coarse/full renders — coarse is
  inherently safe (busy/free, no labels). **Open risk (must resolve in Pass 1):**
  do Unruh schedule nodes carry audience tags? If not, a `schedule:'full'`
  villager reading labels could see ward-private events. Resolution: schedule
  reads on a Discord turn filter to nodes whose audience ∈ `audienceVisible`;
  **nodes with no audience tag default to ward-private (hidden from villagers)**.
  Full labels for a villager show only explicitly-shared items. This may need an
  audience field on schedule nodes — scoped in Pass 1, and if it's a real gap it
  gets its own sign-off before the full-read path ships.
- **Writes:** every write executor on a Discord turn stamps the causing villager
  (`source`/attribution) and clamps the written audience to the room's tag (never
  `ward-private`). Logged to an event log so a villager-driven write is auditable.

## Graceful degradation & control (non-negotiable per repo rules)

- The tool loop **never breaks the reply.** `executeToolCall` already returns
  structured failures into the loop instead of throwing; the Discord loop inherits
  that. A tool peer down → the Familiar still replies.
- **Hard off-switch in the same delivery:** `PROTO_FAMILIAR_DISCORD_TOOLS_DISABLED=1`
  reverts to today's no-tools-on-Discord behavior. Plus a Settings toggle
  (`discordToolsEnabled`, default … see Open questions).
- Latency: villagers with no grants get an empty tool set → no tool round, same
  cost as today. Tools only appear when a grant authorizes them.
- Rate limits, the outgoing audience filter on reply text, and the batching path
  are unchanged and still wrap the tool loop.

## Passes

1. **Machinery + gate + relay + safe reads.** The Discord tool loop in
   `handleTurn` (reusing `runToolCallLoop`), `discordGrantModules` + a
   `composeDiscordTools` selector, `toolCtx` audience threading, the per-executor
   read audit (memory reads confirmed audience-scoped; resolve the schedule-node
   audience question), `relay_to_ward`, the off-switch. Tests: selection matrix,
   result-gate (no ward-private leak), relay delivery.
2. **Write parity + attribution.** Enable the grant-authorized write tools on
   Discord with villager attribution + audience-clamp + an event log; the
   schedule-write and memory-write paths. Tests: a villager can write only within
   grant, writes are attributed, no ward-private write.
3. **Discoverability + docs + version.** First-person tool descriptions surfaced
   on the turn, the villager-DM presence-block affordance lines, `architecture.md`
   + `CLAUDE.md` (retire the "no tools on Discord" statement deliberately), the
   Settings toggle UI.

## Ward decisions (resolved)

1. **Default state — ON.** `discordToolsEnabled` defaults true (+ the hard
   `PROTO_FAMILIAR_DISCORD_TOOLS_DISABLED=1` env off-switch and a Settings toggle).
   Grants already gate *what* each villager can do, so the gate is the control;
   tools come online for granted villagers on merge.
2. **Memory-write blast radius — full scope + attribution.** A `memories:true`
   villager can write ward-subject memories too; provenance is stamped on every
   such write and surfaced on recall so the Familiar can reevaluate trust and prune
   (see "Provenance & trust"). Not consent-gated at write-time.

## Open (factual, resolved in code during Pass 1)

- **Schedule-node audience:** if Unruh nodes aren't audience-tagged, the
  `schedule:'full'` read path filters to explicitly-shared items and defaults
  untagged nodes to ward-private (hidden from villagers) — full-label villager
  reads show only shared items until/unless node audience tagging is added. This
  is an implementation detail settled by reading the schema, not a ward decision.
