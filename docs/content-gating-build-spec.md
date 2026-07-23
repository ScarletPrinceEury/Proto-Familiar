# Content-based memory gating — build spec

**Status: Phases 1–5 shipped — content-gating COMPLETE.**

**What this builds:** memories gated by **content**, not by a single audience
circle. Today a memory carries one `audience` (a Village category id), so a
villager who sits in two overlapping tiers can't be gated sensibly — a fact
either fits their one circle or it doesn't. This replaces that with content
**tags** (a topic + a sensitivity level) matched against what each tier is
granted per topic. Overlapping tiers become additive and useful.

**Ward decisions (locked):**
1. **A new explicit content-tag set** (not a reuse of the old `category`) — a
   fixed topic vocabulary × two levels (`open`/`sensitive`), e.g.
   `medical:open`, `medical:sensitive`, `sexuality:sensitive`, `family:open`.
2. **Most-permissive tier wins** — a villager sees a memory when *any* tier they
   belong to grants its topic at or above its level. (Grants are already unioned
   across a villager's categories in `audience.js`; this extends that union to
   the per-topic map.)

## The model

- **Topics** — fixed set in `CONTENT_TOPICS` (general, medical, mental-health,
  sexuality, gender, family, relationships, finances, legal, substance,
  religion, politics, work, location, contact-info). Fixed so the extractor,
  the tier-grant editor, and the gate all speak one language. `general` is the
  everyday catch-all.
- **Levels** — `open` < `sensitive` (`CONTENT_LEVELS`). `open` = shareable
  within a tier that knows this topic at all; `sensitive` = only a tier trusted
  with it deeply.
- **A memory's tag** — one `{topic, level}` (stored as `topic:level`).
- **A tier's grants (new axis)** — a per-topic level map, e.g.
  `{ general: 'open', medical: 'open', sexuality: 'none' }`. A topic absent from
  the map is `none` (fail-closed: a tier only sees topics explicitly granted).
- **The gate** — `memoryVisibleToVillager(tag, unionedGrants)`: visible ⟺ the
  villager's most-permissive granted level for the tag's topic ≥ the tag's
  level. An **untagged** memory is treated as `general:sensitive`, so it never
  leaks to a tier that only has baseline `general:open`.

## Phase 1 — the spine (DONE)

`content-tags.js` (pure, no I/O) + `tests/content-tags.test.mjs`:
vocabulary, `normalizeTag`, `topicVisibleToGrants`, `unionTopicGrants`,
`memoryVisibleToVillager`, and `categoryToTag` (the legacy bridge:
basics→general:open, health_info→medical:sensitive, emotional_content→
mental-health:sensitive, relationships→relationships:open, whereabouts→
location:open). This carries no migration risk and is the foundation everything
below builds on.

## Phase 2 — tier grants gain the per-topic axis

**Phase 2a (data model + migration + connected surfaces): DONE (0.9.19).**
- Village category `grants` carries a nested `topics` map (`{topic: open|sensitive}`),
  the ONE nested object `village.js:sanitizeGrants` preserves (validated via
  `content-tags.sanitizeTopicGrants`); everything else still stripped to primitives.
- **Migration** (`normalizeRegistry`, `deriveTopicGrantsFromCoarse`, first-time
  only — never overwrites a ward edit): `identitySensitive` → every topic at
  `sensitive` (the old "everything except address" — visibility-preserving, the
  ward narrows it later); `health` → `medical`/`mental-health` sensitive;
  `memories`/`identityBasic` → `general:open`; `location` → `location:open`.
- **Connected surfaces closed in the same pass** (this is where a naïve version
  breaks): `permissionScore` already ignores a nested object (adds 0, verified);
  `grantUnion`/`grantIntersection` special-case `topics` (deep union/intersect
  per topic — a boolean collapse would both destroy the map AND, as a bare
  `true`, inflate `permissionScore` → shift `audienceTagFor`); `upsertCategory`
  preserves `topics` across a topic-less save (the legacy editor doesn't send
  them); and the category-editor UI excludes `topics` from its free-form rows so
  it can't render/re-serialize it into a string. Tests cover each.

**Phase 2b (UI): DONE (0.9.20).** A collapsed-by-default "Content topics"
section in the category editor (`public/app.js`, Village pane) — one
None/Open/Sensitive select per topic. Rendered only for an EXISTING category
(a new one omits `topics` so the migration seeds it from coarse grants; the
ward then refines it). `vlReadGrants` emits an explicit `topics` map when the
section is present. The clear-all sentinel was resolved: `sanitizeGrants` now
keeps an explicit `topics` OBJECT even when empty (`{}` = "every topic hidden"),
so the migration's `topics === undefined` guard skips it and it persists instead
of re-deriving.

## Phase 3 — extraction tags each fact

**Phase 3a (storage layer): DONE (0.9.21).**
- Phylactery migration `0005_content_tag.sql` adds a nullable `content_tag TEXT`
  column + index. `memory.create` accepts an optional `content_tag` and derives
  one from `category` (Python `category_to_tag`, mirroring `content-tags.js`)
  when the caller omits it — fail-closed (unknown/empty → the category's mapping).
- `backfill_content_tags(conn, limit)` tags pre-existing NULL rows from their
  `category`, idempotently → `memory_backfill_content_tags` MCP tool +
  `backfillContentTags` thalamus wrapper, auto-run once at boot in `server.js`.
- 13 hand-built Python test fixtures patched with `content_tag TEXT`; new
  `test_content_tag.py` (mapping / create-derives / explicit-wins / idempotent).

**Phase 3b (extraction tagging): DONE (0.9.22).**
- Both extraction prompts (`memorization.js` `buildPrompt` /
  `buildSharedRoomPrompt`) gain a shared `content_tag` field (`CONTENT_TAG_JSON_LINE`
  + `CONTENT_TAG_FIELD_RULE`, defined once so the two prompts never drift): the
  model picks `topic:level`, first-person voice, framed as SEPARATE from
  `category` (how-filed vs who-sees-it). The full `CONTENT_TOPICS` vocabulary is
  interpolated so the prompt and the gate speak one language.
- `processJob` validates the model's tag in CODE — `normalizeTag(fact.content_tag)
  || categoryToTag(category)` → `"topic:level"` — so a missing/junk tag falls back
  to the category derivation (the exact-values rule; a mis-tag gates tighter,
  never leaks). Threaded `contentTag` → `createMemoryFull` → `args.content_tag`
  → the `memory_create` MCP tool (new `content_tag` param) → `memory.create`.
  All optional/back-compat: other `createMemoryFull` callers (tome-graduation)
  omit it and Phylactery derives from category, protected by the ward-private
  floor.
- Test: `memorization-v7.test.mjs` asserts both prompts carry the field, the
  topic vocabulary, both levels, and the "separate from category" framing.

**Still open in Phase 3:** the **category-slug `audience` remap** (0.9.18,
`remapCategoryAudiences`) already landed separately; the single-`audience` field
is retained as the ward-private floor (Phase 4 keeps it as the hard gate above
the tag), not retired.

## Phase 4 — recall gating uses the tag (DONE, 0.9.23)

The gate is **layered, not a replacement** — the two axes compose deliberately
(the ward's "two halves built as if the other didn't exist" concern answered by
making them one decision):

1. **Coarse floor** (`audiences` = `visibleAudiences`, unchanged): the room's
   ward-private + provenance ceiling — a memory made in a higher-trust context
   never surfaces in a lower one, and `ward-private` is excluded for every
   villager room. This is the hard floor.
2. **Fine content gate** (new): among what clears the floor, a memory surfaces
   only if `memory_visible_to_grants(content_tag, roomTopicGrants)` — the room's
   most-permissive-per-topic map (unioned within each villager's tiers,
   intersected across the room's participants). This is the per-topic control
   the single-audience ladder couldn't express.

**The seams, all wired in one pass (so the two halves can't drift):**
- `content-tags.js` / `content_gate.py` — the pure gate (JS + its Python mirror,
  the gate must run where the query runs; same cross-language pattern as
  `category_to_tag`/`slug_id`).
- `audience.js` `topicGrantsForRoom(effectiveGrants, roomTag)` — the COMPANION
  to `visibleAudiences`, derived together at every seam. Ward room → `null` (no
  content filter). Villager room with no topics → `{}` (fail-closed, nothing by
  content).
- Phylactery `memory.search` / `memory.by_timerange` take a `topic_grants` param
  and post-filter each row (overfetching so the per-row drop still fills the
  limit); the `memory_search`/`memory_by_timerange` MCP tools pass it through.
- Node recall path: `enrich` threads `topicGrants` into `memory_search`;
  `searchMemory`/`memByTimerange` wrappers take it; `server.js` `/api/chat` and
  `discord-gateway.js` `resolveLocationGate` derive `audienceTopics` alongside
  `audienceVisible`; the Discord tool ctx carries `topicGrants` and
  `cerebellum.discordReadTopicGrants(ctx)` (fail-closed to `{}`) is the
  companion to `discordReadAudiences`.
- **Ward-context recall stays unscoped** (pondering/reflection loop, tome-
  graduation dedup, the ward's own API endpoints) — the Familiar's own memory,
  `topicGrants` omitted → ward sees all, unchanged.
- **Graph nodes/edges keep the coarse audience gate** (they carry no
  `content_tag`) — `graph_node_search`/`graph_subgraph` are unchanged.

**Fail-closed everywhere**: no tag → `general:sensitive`; unknown topic/absent
grant → not shown; a villager room with an empty topic map → nothing by content.
Tests: `test_content_gate_recall.py` (recall-path pipeline through the real
store — visible/invisible, ward-private floor, empty-grants, untagged), plus the
`topicGrantsForRoom` and `discordReadTopicGrants` fail-closed unit tests.

## Phase 5 — memory-manager UI (DONE, 0.9.24)

- The memory manager (`public/app.js` KE Memories tab) shows the content tag as
  a badge (topic label · level, `keContentTagBadge`) beside the audience badge;
  the list search matches both the raw tag and the friendly topic label.
- The detail editor gains a topic `<select>` + level `<select>`
  (`keContentTagEditorHTML`) populated from the memory's current tag; "—
  untagged" clears it (→ `general:sensitive` at recall). The `PUT
  /api/entity/memories/by-id/:id` endpoint accepts `contentTag`, **canonicalises
  it in code** (`normalizeTag` → `topic:level`, `''` clears, unrecognised
  rejected — the exact-values rule) and threads it through `updateMemoryById` →
  `memory_update_by_id` → `update_memory_by_id`.
- Projections carry it: `list_memories` and `read_memory_by_id` now return
  `content_tag`. Badge colors (open = teal, sensitive = amber) tuned ≥4.5:1 per
  the WCAG line.

## Invariants (privacy-critical — hold these)

- **Fail-closed at every seam.** Unknown tag, unknown topic, absent grant, gate
  error → the memory is NOT shown to a villager. The ward always sees everything
  on a ward-private turn.
- **Most-permissive union is villager-scoped, not global.** Only the tiers a
  given villager belongs to are unioned — never all tiers.
- **The tag is a machine value at the boundary.** The model *suggests* topic +
  level; code validates against the fixed vocabulary and falls back to
  `categoryToTag` on anything invalid (the exact-values rule).
- **Every phase ships tests, including a recall-path pipeline test** (a memory
  tagged X, a villager in tiers Y/Z, asserted visible/invisible through the real
  recall assembly with a stubbed store) — pure-function tests can't catch a
  wiring gap in the gate.
