---
title: "Tomes And Keyword Lore"
topics: [architecture, tomes]
sources:
  - id: tome-lore-js
    type: file
    path: src/tomes/tome-lore.js
  - id: tome-store-js
    type: file
    path: src/tomes/tome-store.js
  - id: tome-macros-js
    type: file
    path: src/tomes/tome-macros.js
  - id: manual-tome-js
    type: file
    path: src/tomes/manual-tome.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: app-js
    type: file
    path: public/app.js
  - id: server-js
    type: file
    path: server.js
  - id: tomes-doc
    type: file
    path: docs/tomes.md
  - id: engineering-conventions
    type: file
    path: almanac/reference/engineering-conventions.md
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: room-lore-js
    type: file
    path: src/tomes/room-lore.js
  - id: tome-tags-js
    type: file
    path: src/tomes/tome-tags.js
  - id: tome-tagging-loop-js
    type: file
    path: src/tomes/tome-tagging-loop.js
  - id: gitignore
    type: file
    path: .gitignore
  - id: no-ignored-source-test
    type: file
    path: tests/no-ignored-source.test.mjs
  - id: adhd-tome-json
    type: file
    path: tomes/ADHD-Tome.json
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: content-tags-js
    type: file
    path: src/memory/content-tags.js
---

# Tomes And Keyword Lore

A Tome is a SillyTavern-style keyword lorebook: a JSON file of entries, each with trigger
keys, that gets scanned against recent chat and injected into the prompt only when its keys
appear [@tomes-doc]. Tomes are one of two long-running memory surfaces in Proto-Familiar — the
other is [Phylactery](phylactery)'s autonomously-retrieved canonical memory — and the two are
kept deliberately separate: a Tome entry fires because a keyword matched, not because the
Familiar decided the fact was relevant [@tomes-doc]. [Session memorization](session-memorization)
is the automated writer that populates one particular Tome (`Session Memories`) with this
shape of entry; this page covers the activation engine and entry format that every Tome, hand-authored
or auto-written, is scanned and injected through, plus the four features built directly on top
of it: live tome macros, the self-documenting Familiar Manual tome (0.11.22-alpha), the
Familiar's own named tomes (0.12.18-alpha), and the room-scoped content gate and share tags
(0.14.89–0.14.92) that decide what lore reaches a turn with someone other than the ward.

## Storage and the activation engine

Tomes live as individual JSON files under `tomes/` (git-ignored), one file per Tome, each
independently enabled or disabled and manageable through the Tomes modal [@tomes-doc]. An entry
activates when one of its **primary keys** — a case-insensitive substring or a `/regex/flags`
pattern — matches somewhere in the scan corpus: the most recent N user/assistant messages plus
the new input, where N is the ward-configurable **keyword scan depth** (`tomeScanDepth`,
default 4) [@tomes-doc] [@app-js]. Matched entries are folded into five injection slots keyed by
SillyTavern's position codes — `sys_top`, `before_char`, `after_char`, `sys_bottom`, `at_depth`
— plus support for secondary/selective keys, constant entries, probability, groups, recursion,
and per-entry scan-depth/case/whole-word overrides [@tome-lore-js].

This engine originally existed only in the browser, as `public/app.js`'s
`activateTomeEntries` running over `state.tomeCache` — the client's in-memory copy of every
enabled Tome, populated by `GET`ing each Tome file and never persisted itself [@app-js]. That
made a server-side turn (Discord, voice) blind to the ward's own lore: a keyword typed in a
Discord DM never triggered anything, because nothing on the server side ever scanned for it
[@discord-gateway-js]. `tome-lore.js` closes that gap with a faithful, pure Node port —
`normalizeEntry`, `matchKeyword`, `parseKeywordRegex`, and the scan/group/recursion functions
mirror `app.js`'s algorithm one-for-one, and every input (entries, messages, scan settings,
timed-effects state, rng) is injected rather than read from ambient state, so a Discord turn, a
voice turn, or a test can all drive it the same way [@tome-lore-js]. `tome-store.js`'s
`readAllTomes(tomesDir)` gives the server side its own read of the same files the client
loads into `tomeCache`: it filters out dotfile bookkeeping (`.consent-pending.json`,
`.memorization-queue.json`) via `isTomeFile`, and skips a corrupt tome file rather than
throwing, because a bad lore file must never break a chat turn [@tome-store-js].

**Parity between the two engines is hand-maintained, not shared.** `public/app.js` is a
classic browser script with no ES modules, so it cannot import `tome-lore.js`; the comment at
the top of both files calls this out explicitly and says to change the matching logic in one
only if the same change is made in the other [@tome-lore-js] [@app-js]. Tests pin the shared
behavior, but there is no build step that would catch a silent drift the way a shared import
would. `discord-gateway.js`'s `activeDiscordLore()` is the server call site: it reads every
tome from disk, calls `activateLore()` with the settings' scan options and a `turnCount` derived
from the session's prior messages (since `delay` needs a turn count and Discord has no client
state to track it), and wraps the whole thing in a try/catch that logs and returns empty slots
on any failure — a bad tome degrades to no lore, never a broken turn [@discord-gateway-js]. The
feature has its own off-switch, `PROTO_FAMILIAR_DISCORD_TOMES_DISABLED=1`, independent of the
main Discord disable flag [@discord-gateway-js]. As of this port (0.11.21-alpha), timed effects
(`sticky`/`cooldown`) are not yet persisted across separate Discord turns — a documented v1
limitation — while `delay` works because it is driven by the turn count computed fresh each
call [@discord-gateway-js].

## Live tome macros: a fourth, deliberate macro boundary

[Engineering conventions](../reference/engineering-conventions) enumerates the three
server-side call sites where `macros.js`'s `substituteMacros` resolves `{{user}}`/`{{char}}` —
LLM prompts, tool results, and tool descriptions — specifically so a fourth is never added ad
hoc [@engineering-conventions]. Tome content is a deliberate exception to that closed list,
introduced in 0.11.22-alpha for a reason the other three boundaries do not share: a lorebook
entry can describe live, ward-facing state ("Vision is currently turned {{visionActive}}."),
and that description is only true if it is resolved at the moment the entry is injected, not
once at authoring time [@tome-macros-js].

`tome-macros.js`'s `resolveTomeMacros(text, settings)` is the server-side resolver. It first
calls `substituteMacros` for `{{user}}`/`{{char}}`, then walks its own `TOME_MACROS` table:
eight boolean **toggle macros** (`visionActive`, `voiceActive`, `discordActive`,
`ponderingActive`, `warmthActive`, `noticingActive`, `calendarActive`, `browserActive`), each
read from the ward-facing setting and rendered as the literal string `on`/`off`, plus four
**value macros** (`charName`, `userName`, `activeModel`, `scanDepth`) [@tome-macros-js]. Toggle
macros deliberately read the setting the ward can flip in the UI, not the deployment-level
`PROTO_FAMILIAR_*_DISABLED` environment off-switches — the browser cannot see an environment
variable, so reading the setting is what keeps the web and Discord copies of a tome entry
in agreement [@tome-macros-js]. An unresolved `{{token}}` outside this table is left untouched,
and a macro function that throws yields an empty string rather than propagating the error
[@tome-macros-js]. `tome-lore.js`'s `foldLoreForPrompt(activated, resolve)` takes this resolver
as an injected function rather than importing it directly, which keeps the activation engine
itself free of any settings-shaped dependency; `discord-gateway.js` passes
`(t) => resolveTomeMacros(t, settings)` as that resolver at its one call site
[@discord-gateway-js].

The browser side cannot import `tome-macros.js` for the same classic-script reason it cannot
import `tome-lore.js`, so `public/app.js`'s `applyNameVars` mirrors the same macro names by
hand — a comment at the mirror site calls out the parity requirement explicitly, and a test
pins the shared name set between the two [@app-js] [@tome-macros-js]. A future macro added to
`TOME_MACROS` needs the matching branch added to `applyNameVars` in the same change, or a tome
entry will render correctly on one surface and show a literal `{{token}}` on the other.

## The Familiar Manual: a self-documenting, protected tome

`manual-tome.js` ships a built-in Tome, the **Familiar Manual**, whose fourteen entries explain
a feature and where its setting lives, each keyed to how a ward would actually ask ("send you
pictures", "how do I use you") rather than to the feature's internal name [@manual-tome-js].
Every entry quotes at least one live toggle or value macro, so the manual's answer reflects
whatever is actually switched on right now instead of a frozen doc — the whole reason the macro
boundary above exists [@manual-tome-js].

The manual tome is seeded once, not managed like an ordinary Tome. `ensureManualTome(TOMES_DIR)`
runs at server boot (best-effort, wired into `server.js`) and checks a flag file,
`.manual-tome-seeded.json`, before writing anything: if the flag exists, it does nothing, so a
ward who has deleted or edited the manual is never overridden by a later boot
[@manual-tome-js] [@server-js]. The write itself is atomic — the tome is written to a `.tmp`
file and renamed into place — and the whole function never throws, because a seeding failure
must not block server startup [@manual-tome-js]. The shipped tome carries `enabled: true` and
`graduationExempt: true`: it is on by default, and the `graduationExempt` flag protects it from
`tome-graduation-loop.js` (see [Autonomous loops](autonomous-loops)), the opt-in background job
that promotes Tome facts into Phylactery — the manual is reference material the Familiar reads
and relays, not a fact about the ward that should ever be graduated into canonical memory
[@manual-tome-js].

## Familiar-kept tomes: named collections beyond the default (0.12.18)

Before 0.12.18-alpha, `save_to_tome` only ever wrote into one place: `addDefaultTomeEntry` in
`server.js` scans `tomes/` for the first tome with `enabled: true` (creating a `General` tome if
none exists yet) and files the entry there [@server-js]. That default lane is still the ordinary
path, but the Familiar can now also keep its own themed collections on top of it: `create_tome(name,
description?)` starts a named tome, `list_tomes` summarizes every tome it already keeps — name,
description, entry count, and whether it is enabled or `[protected]` — so it reuses a collection
instead of coining a near-duplicate, and `save_to_tome` gained an optional `tome` field that files
the entry into that named collection, creating it first if it does not already exist
[@cerebellum-js].

`createNamedTome` and `addTomeEntryByName` (`server.js`) both build on `findOrCreateTomeByName`,
the same by-name lookup [Session memorization](session-memorization) and the rest of the tome
storage layer already relies on. A Familiar-made tome is written `enabled: true`,
`graduationExempt: true` — the same runtime-tome convention the Familiar Manual above uses — so a
themed collection the Familiar deliberately started is never drained into Phylactery by
`tome-graduation-loop.js` the way an ordinary hand-authored Tome can be [@server-js]. `buildTomeEntry`,
the function that assembles the sixteen-field SillyTavern-shaped entry object, moved into
`tome-store.js` so the default-tome and named-tome save paths share one implementation instead of
risking the two field lists drifting apart by copy-paste [@tome-store-js]. `listTomesSummary`, also
in `tome-store.js`, is the read side behind `list_tomes`: it reads every tome file on disk and
flags the Familiar Manual specifically as `protected` (`graduationExempt` plus a name match), so
the Familiar sees at a glance which of its tomes is reference material rather than its own scratch
collection [@tome-store-js].

`save_to_tome`, `list_tomes`, and `create_tome` are all surfaced as `'core'` tools — always
advertised in every embodiment rather than gated behind a feature toggle — and there is no hard cap
on how many named tomes the Familiar can keep; the tool descriptions themselves are what is
expected to keep it checking `list_tomes` and reusing a collection before starting another one
[@tool-surfacing-js] [@cerebellum-js].

## The room gate: lore now passes the same content gate as memories (0.14.89–0.14.92)

Through 0.14.88-alpha, the activation engine described above had no audience awareness at all:
every enabled tome's entries were scanned and injected into every turn, Discord DMs and guild
channels included, with no distinction between the ward's own room and a shared one
[@discord-gateway-js]. The shipped condition tomes (`ADHD-Tome.json`, `Depression-Tome.json`,
and three siblings) ship each diagnosis as a `constant: true`, `enabled` entry — SillyTavern's
"always fire" flag — so a ward's diagnosis line (`"{{user}} has clinical depression"`) was
injected into the prompt the Familiar used to reply to a villager or a guild channel on *every*
turn, not just the ward's own [@adhd-tome-json] [@claude-md]. [Content-based memory
gating](content-gating) already solved exactly this problem for Phylactery memories — a
per-topic sensitivity tag plus per-tier grants — but Tomes, being a separate keyword-triggered
surface, had never been wired into it. The fix landed in two steps because the two concerns are
genuinely different code paths.

**Step 1 (0.14.89): gate the leak at the entry and tome level.** `tome-lore.js` gained
`filterByAudience(activated, { wardPrivate })`, a pure helper that strips any entry tagged
`wardOnly: true` from an already-activated result unless the turn is ward-private
[@tome-lore-js]. The five shipped diagnosis constants were each tagged `wardOnly: true` directly
in their tracked JSON (symptom entries were left untagged, since the guidance itself is neutral
and the ward decided it should still reach people the ward has opened up to) [@adhd-tome-json]
[@claude-md]. A whole tome can carry the same flag — `tomeIsWardOnly` treats a tome as private
either because it is marked `wardOnly: true` or because its name is in `PRIVATE_TOME_NAMES`
(today just `Session Memories`) — so the Familiar's own session-summary tome never needed
per-entry tagging to stay out of shared rooms [@room-lore-js]. The web chat path, assumed at
first to be single-audience (the ward's own session), turned out not to be once a session could
have others present; `app.js` mirrors the same gate server-side before assembling the prompt
[@claude-md].

**Step 2 (0.14.90): gate by content, and gate before activation.** `src/tomes/room-lore.js` is
the server-side gate that actually replaced the entry-level patch above: `tomesForRoom(tomes, {
topicGrants })` filters every tome's entries for the room **before** keyword activation runs, not
after — a hidden entry filtered out after activation could still have woken a visible one through
recursion, so filtering has to happen first [@room-lore-js]. The gate reuses
`memoryVisibleToVillager` from `content-tags.js`, the exact same per-topic grant check memories
use: an entry tagged `self` (the Familiar's own thinking, not about the ward) reaches any room; an
entry with a `topic:level` content tag reaches a room whose grants cover that tag; an untagged
entry defaults to `general:sensitive`, same fail-closed default as an untagged memory; and a
`wardOnly` entry never reaches a shared room regardless of grants [@room-lore-js]
[@content-tags-js]. `topicGrants === null` is the existing recall convention for "this is the
ward's own room, no content filter at all" [@room-lore-js] [@content-tags-js].

A tome's own `roomShare` setting (`'content'` default, `'always'`, or `'never'`, set by the ward
in the Tomes modal) overrides the per-entry check for that whole tome; the shipped condition
tomes and the Familiar Manual are both `roomShare: 'always'` — their symptom/reference content is
meant to travel, while their `wardOnly`-tagged diagnosis constants still never do, because the
`wardOnly` check in `entryReachesRoom` runs before the `'always'` override is consulted
[@room-lore-js]. A private tome (`tomeIsWardOnly`) is forced to `'never'` regardless of its own
`roomShare` field [@room-lore-js].

Discord's `activeDiscordLore` now calls `loreForTurn` with the room's grants instead of the raw
activation engine [@room-lore-js] [@discord-gateway-js]. On the web, a session with others present
sends `serverLore: true` and builds no lore of its own; `/api/chat` is the only place that knows
the room's grants, so it calls `loreForTurn` plus `placeRoomLore` (which places the lead/tail/
at-depth blocks exactly where the browser's own lore placement would have) [@room-lore-js]. This
replaced both the 0.14.89 browser-side mirror and the post-activation `filterByAudience` patch —
`tome-lore.js`'s activation engine is audience-agnostic again, with the room gate owned entirely by
`room-lore.js` as a layer in front of it [@room-lore-js].

## Share tags: sorting individual entries into what a room may see (0.14.92)

The room gate above needs every entry to already carry a content tag to be useful; before
0.14.92, only the shipped condition tomes had been hand-tagged. `tome-tags.js` defines the share-
tag vocabulary an entry can carry: `contentTag: 'self'` (the Familiar's own thinking or general
knowledge, not about the ward — any room), a memory-style `contentTag: 'topic:level'` pair, `wardOnly:
true` (private, same as the room gate's own flag), or no tag at all, which both the gate above and
`entryShareKind` treat as unsorted and therefore `general:sensitive` [@tome-tags-js]. `checkTomeTag`
holds a tag the Familiar picked for itself: a note that mentions the ward or a registered villager
by name cannot be filed `self` or at the `:open` level — it is pulled to `:sensitive` instead, and
the fact that it was held (and by whom) is recorded rather than silently applied, so the result of
`save_to_tome` tells the caller what the tag actually became instead of a quiet "ok"
[@tome-tags-js]. A ward's own choice in the entry editor is never second-guessed this way
[@tome-tags-js].

`save_to_tome` now accepts an optional `content_tag` argument, checked through this same code
before it is written [@tome-tags-js] [@claude-md]. For the backlog of notes written before share
tags existed, `tome-tagging-loop.js` is an opt-in background worker (default off — the ward enables
"Sort my tome notes for shared rooms" in Settings) that reviews one batch of up to 12 unsorted
notes every 10 minutes on the memorization connection, in the Familiar's own voice, and only writes
a tag back if the note is still unsorted at write time (an edit by the ward mid-pass wins)
[@tome-tagging-loop-js]. It has the same hard off-switch shape as the rest of the loop set,
`PROTO_FAMILIAR_TOME_TAGGING_DISABLED=1`, and defers while a voice call is active
[@tome-tagging-loop-js]; see [Autonomous loops](autonomous-loops) for where it sits alongside the
rest of the background worker set.

## Two gotchas from shipping the room gate

**A `.gitignore` glob can hide a source file, not just stray runtime output.** The safety net
`src/**/tomes/` was added to catch a runtime `tomes/` directory mis-created under `src/` by a
mis-resolved `__dirname` path (it had happened once before, under `src/pondering/`). Glob `**`
matches zero directories as well as more than zero, so the same pattern also matched the real
source directory `src/tomes/` itself — the folder `room-lore.js` lives in. `room-lore.js` was
never committed in the 0.14.90 commit even though `server.js` and `discord-gateway.js`, which
import it, were: the local test suite passed because the file still existed on disk locally, but
`main` would have failed to boot for anyone who pulled [@gitignore] [@claude-md]. The fix adds an
explicit negation, `!/src/tomes/`, directly under the broader pattern, and
`tests/no-ignored-source.test.mjs` now fails whenever any tracked-looking source file is
git-ignored, specifically to catch this class of mistake again [@gitignore]
[@no-ignored-source-test]. A green local suite proves nothing about a file git never saw; `git
status` listing fewer files than were actually created is the tell.

**The shipped condition tomes are tracked JSON, but installs are expected to customize them
locally.** `tomes/ADHD-Tome.json` and its four siblings ship as ordinary git-tracked files, not
git-ignored runtime state, specifically so an update can still carry future improvements to their
wording [@adhd-tome-json]. A ward who edits one of those files' content directly in their own
install (rewording an entry to match how they actually want the Familiar to describe their
condition) is expected to mark it `skip-worktree` locally, the standard git mechanism for
"treat my local edits to this tracked file as intentional and don't flag them dirty." That
convention cuts the other way for this repository's own history: an upstream commit that edits
`tomes/*.json` content directly — which is exactly how the `wardOnly` tag above was added to the
five diagnosis constants — will not reach, and can conflict with, an install that has marked that
file `skip-worktree` to protect its own customization. The condition tomes are effectively frozen
content from the maintainer's side once shipped; any further change to their *behavior* (new
gating flags, new defaults) should be expressed in code that keys off the tome's name or a stable
field — the same pattern `PRIVATE_TOME_NAMES` and `roomShare` already use — rather than by hand-
editing the shipped JSON again.

## Where this fits

- [Session memorization](session-memorization) — the automated writer that populates the
  `Session Memories` tome using this same activation engine and entry format.
- [Pondering](pondering) — a second automated writer that reuses this same tome-file storage and
  locking (`findOrCreateTomeByName` / `modifyTomeFile`) for `Familiar's Ponderings`, but ships
  every entry `enabled: false` so it is never scanned into chat context by keyword the way an
  ordinary Tome is; see its monthly digest/consolidation section for the one place that tome gets
  pruned.
- [Phylactery](phylactery) — the canonical, autonomously-retrieved memory store that Tomes
  (keyword-triggered, not relevance-triggered) are deliberately kept separate from.
- [Autonomous loops](autonomous-loops) — `tome-graduation-loop.js`, the opt-in loop that
  promotes ordinary Tome facts into Phylactery, and which `graduationExempt` opts the manual
  tome out of.
- [Content-based memory gating](content-gating) — the per-topic sensitivity tag and grant model
  the room gate above (`room-lore.js`) reuses wholesale (`memoryVisibleToVillager`) so a Tome
  entry and a memory are gated by the same rule.
- [Autonomous loops](autonomous-loops) — also lists `tome-tagging-loop.js`, the opt-in share-tag
  sorting pass this page's share-tags section describes.
- [Ward Discord console](ward-console) — the `!queue`/`!connection` menus that sit alongside
  the Discord tome-lore path described above in the same gateway module.
- [Tome multi-writer merge policy](../decisions/tome-multi-writer-merge-policy) — a proposed,
  not-yet-built reconciliation design for a Tome written by more than one source; today's single
  automated writer (memorization) plus manual ward edits is the simpler model that shipped.
- [Engineering conventions](../reference/engineering-conventions) — the macro-substitution
  boundary list that tome content is a deliberate, named exception to.
