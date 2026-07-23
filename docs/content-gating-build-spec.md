# Content-based memory gating — build spec

**Status: Phase 1 shipped (`content-tags.js` + tests); Phases 2–5 pending.**

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

- Extraction prompts (`memorization.js` `buildPrompt` / `buildSharedRoomPrompt`)
  gain a `contentTag` field per fact: the model picks the topic + level. First
  person, natural voice (the 0.9.14 rewrite style). Keep the existing
  `category` for now (back-compat + the consent gate still uses it); the tag is
  additional. Fail-closed: an omitted/invalid tag → `categoryToTag(category)`
  in code, never trusted blank.
- Store the tag on the memory (Phylactery `memories` — a `content_tag` column,
  or fold into existing metadata). `memory.create` passthrough.
- **Migration of existing memories**: backfill `content_tag` from the stored
  `category` via `categoryToTag` (a Phylactery migration, idempotent, like the
  embedding backfill). This is also where the **category-slug `audience` remap**
  deferred from 0.9.16 lands — or the `audience` field is retired in favour of
  the tag (decide at build time: the tag + tier grants may fully replace the
  single-audience field; keep `audience` only if a non-topic gate still needs
  it, e.g. ward-private).

## Phase 4 — recall gating uses the tag

- Replace the single-`audience` filter at recall with
  `memoryVisibleToVillager(memory.content_tag, unionTopicGrants(roomTiers))`.
  The seam is wherever memories are scoped to a room/villager today
  (`audience.js` + the Phylactery recall audience filter + the Discord
  audience-scoped recall). **Fail-closed everywhere**: no tag or no matching
  grant → not shown to a villager (ward-private turns are unaffected — the ward
  sees everything).
- Keep `ward-private` as the hard floor: a ward-private memory (no third-party
  subject) never surfaces to any villager regardless of tag.

## Phase 5 — memory-manager UI

- The memory manager (`public/app.js` KE Memories tab) shows the content tag as
  a badge (topic + level) and lets the ward edit it, same pattern as the
  audience badge fix (0.9.15). Search matches the tag.

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
