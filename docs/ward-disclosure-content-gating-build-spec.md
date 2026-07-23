# Build spec: ward self-disclosure governed by content tags (per-circle, per-topic)

Instruction sheet for the implementing agent. Read `CLAUDE.md` in full first,
especially the content-gating section and the ward-sign-off rules — **this is
the single most sensitive privacy path in the system.** It changes the DEFAULT
visibility of the ward's own facts (medical, emotional, etc.) to Village
circles. Do not implement it until the ward has approved this spec, and do not
deviate from it in a way that widens disclosure without asking.

Extends `docs/content-gating-build-spec.md` (which built the per-topic content
gate) and the audit membership rework in `docs/audit-fixes-build-spec.md` Task 2.

## The gap this closes (ward-confirmed direction)

Today a memory must clear TWO ANDed gates to reach a villager:

1. **Coarse circle membership** (`visibleAudiences` / the memory's `audience`
   tag) — who the room is.
2. **Fine per-topic content** (`topicGrantsForRoom` / the memory's
   `content_tag`) — what kind of content, at what sensitivity.

The per-topic mechanism the ward wants — *"Emergency Contacts + Care Network may
know medical; Close Friends may know emotional; Emergency Contacts do NOT get
emotional"* — is fully built (`content-tags.js`, `content_gate.py`, each
category's `grants.topics` map, the extractor's `content_tag`). BUT
`deriveMemoryAudience` tags a fact **about the ward themselves**, shared in a
private DM, as coarse `ward-private` (and *floors* `health_info`/
`emotional_content` there explicitly). `ward-private` is in no villager room's
visible circle set, so the coarse gate excludes the fact **before the content
gate runs.** Net: the per-topic permissions are dead letters for exactly the
ward-about-self facts the ward wants to disclose selectively.

**Ward decision (confirmed):**
- **Third-party privacy & provenance stays on the coarse membership gate.** A
  fact ABOUT a villager, or made IN a shared room, keeps today's circle
  behavior — unchanged.
- **The ward's own self-disclosure is governed by the content tag × each
  circle's topic grants** — not fenced to `ward-private` by default.

## The mechanism — a content-gated coarse sentinel

A memory carries ONE `audience` tag, so "visible to any circle granted this
topic" (possibly several unrelated circles) can't be a single circle id. Solve
it with a sentinel coarse value that PASSES the coarse gate for every gated
room and defers entirely to the content gate:

- New constant in `audience.js`: `AUDIENCE_TAG_WARD_OPEN = 'ward-content-gated'`
  (name is cosmetic; keep it obviously distinct from `ward-private`).
- `visibleAudiences(sessionAudience, registry)` includes this sentinel in the
  returned array for **every gated (non-ward) room** — exactly like `strangers`
  is always present. (Ward sessions still return `null` = sees all, unchanged.)
- A memory tagged `audience = 'ward-content-gated'` therefore clears the coarse
  floor in any villager room, and its actual visibility is decided by the
  content gate: `content_tag` vs the room's `topic_grants`.

Why this is correct and why the two open sub-questions resolve for free:

- **Fail-closed when no circle grants the topic (my Q1 — confirmed yes, and it's
  automatic):** if no circle's `grants.topics` permits the fact's `content_tag`,
  no room's content gate passes → the fact surfaces to NO villager → effectively
  ward-private. Strangers (empty `topics`) never see a content-gated fact. No
  separate fallback mechanism is needed — it falls out of the content gate.
- **Per-fact ward-private override (my Q2 — confirmed available, also
  automatic):** the ward tags a specific memory `audience = 'ward-private'`
  (the memory manager already supports editing `audience` via
  `updateMemoryById`). Not the sentinel → in no villager room's set → hidden
  regardless of content grants. So a per-fact hard-private override exists with
  no new code.

## Exactly what changes

### 1. `audience.js`
- Add `export const AUDIENCE_TAG_WARD_OPEN = 'ward-content-gated';`.
- `roomCircleSet` / `visibleAudiences`: add `AUDIENCE_TAG_WARD_OPEN` to the set
  for every gated room (alongside the always-present `CATEGORY_STRANGERS`). Do
  NOT add it to `audienceTagFor`'s tag selection (it is a memory-audience
  sentinel, never a room tag). Ward (`null`) path unchanged.
- `deriveMemoryAudience`: for a fact with **no third-party subjects** made in a
  **ward-private session** (`sessionTag === AUDIENCE_TAG_WARD_PRIVATE`), return
  `AUDIENCE_TAG_WARD_OPEN` instead of `ward-private`. Remove the
  `SENSITIVE_CATEGORIES → ward-private` floor **for this path only** — the
  `content_tag` (health_info → `medical:sensitive`, emotional_content →
  `mental-health:sensitive` via `categoryToTag`) now carries the sensitivity and
  the circle topic grants decide. **Everything else in `deriveMemoryAudience` is
  unchanged:** a fact WITH subjects (third-party) keeps the current
  circle/disclosure logic and the sensitive floor; a ward-self fact made in a
  SHARED room keeps its session-bounded circle tag (that room already saw it).

### 2. Recall path — verify, likely no change
- The Python `memory.search` already applies the coarse `audience IN (audiences)`
  AND the content `topic_grants` filter. The sentinel is just another string in
  the `audiences` array, so `audience_in_sql` needs no change. **Grep the Python
  for any special-casing of the literal `'ward-private'`** in the audience
  filter; if the coarse filter treats only `None` as unscoped (expected), the
  sentinel flows through untouched. Add nothing unless a special-case is found.
- Confirm ward-context recall (pondering, tome-graduation dedup, ward endpoints)
  still omits `audiences`/`topic_grants` → ward sees the sentinel-tagged and
  ward-private facts alike (unchanged — ward is unscoped).

### 3. Memory manager UI (ward-facing, Phase-5-adjacent)
- The audience editor must show three understandable states for a memory:
  a **circle name** (shared to that circle), **"private to us"** (`ward-private`),
  and **"visible by content rules"** (`ward-content-gated`) — and let the ward
  switch any memory between them. This is how the ward exercises the per-fact
  override and audits what's content-gated. Keep the copy plain
  (`docs/ui-ux-guidelines.md`).

### 4. Docs — same commit(s)
- `docs/content-gating-build-spec.md`: add a section for the ward-self content-
  gated path and the sentinel.
- `docs/architecture.md` Pillar E: note the sentinel and the ward-self vs
  third-party split.
- `CLAUDE.md` content-gating note: state that ward-about-self facts default to
  content-gated (not ward-private), third-party facts stay coarse-gated, and the
  per-fact `ward-private` override.

## Migration — the Familiar re-tags existing facts, with judgment (ward direction)

Existing ward-self memories are all tagged coarse `ward-private` (the old model's
only option), and carry only a coarse `content_tag` derived from their category
by the Phase-3 backfill. Two BAD options bracket the right one: leaving them
stranded forever (too conservative — the whole feature never reaches the ward's
existing history), or a MECHANICAL blanket re-tag (dangerous — blind widening of
every private fact by rule). **The right option: the Familiar re-tags them with
judgment**, because it holds the context each fact needs and "which circle should
know this about my ward" is a per-fact judgment, not a script — and the same pass
can correct the `content_tag` (full context sets the real one; a fact the backfill
filed `general` may truly be `medical:sensitive`).

This is DISCLOSURE — the single narrow cost-category the proactivity rules tell
the Familiar to be genuinely careful about. So the pass is bounded by three
guardrails, non-negotiable:

1. **Conservative / fail-safe default.** Unsure → the fact STAYS `ward-private`.
   The Familiar only content-gates a fact when it's genuinely confident the ward
   would want the granting circle(s) to be able to know it. Erring toward privacy
   is the safe direction.
2. **Ward-visible and revertible.** Re-tagging the ward's private data is never
   silent. Reuse the existing pattern the system already has for the Familiar
   moving the ward's private data — a `[GRADUATION NOTICE]`-style block + the
   consent-queue flow: the Familiar surfaces, in its own voice, what it has
   opened (or proposes to open) about the ward and to which circles, non-blocking,
   with easy per-fact revert to `ward-private`.
   - **Sensitive content** (medical / mental-health / sexuality / gender /
     finances / legal / substance) → **propose and wait for ward approval**
     before any widening (mirror the memory-consent ask-gate).
   - **Ordinary content** → may auto-open with a notify + easy revert.
   - The ward can also just say *"open my medical to Care Network"* and the
     Familiar applies it in bulk.
3. **Rides existing requests, gated in code.** A batched lifecycle/graduation-
   style pass (code selects candidates: `audience == ward-private`, no
   third-party subject), ONE batched LLM judgment per batch — never a per-fact
   LLM call. Own off-switch; never touches the chat path.

Fail-closed still holds after re-tag: a content-gated fact only reaches a circle
whose topic grants permit its `content_tag`; nothing a circle isn't granted
surfaces. **Decision point for the ward:** confirm the sensitive-content ⇒
propose-and-approve vs ordinary-content ⇒ auto-open-and-notify split above, or
choose propose-and-approve for ALL widenings.

## Out of scope
- **Graph nodes/edges** keep the coarse gate only (no `content_tag` — CLAUDE.md).
  A ward-self graph node stays `ward-private` per `deriveNodeAudience`. Not
  touched here.
- The write-time `mostRestrictive`/`audienceScore` tighten/widen helpers
  (flagged in the membership rework for a later pass) are not in scope.

## Tests (mandatory; the audit-fixes pass's automated tests went to Sonnet/Haiku
subagents — do the same here)
- `audience.js` unit: `visibleAudiences` includes the sentinel for gated rooms,
  never for the ward (null); `deriveMemoryAudience` returns the sentinel for a
  ward-private-session ward-self fact (incl. the two sensitive categories), and
  STILL returns a circle/ward-private for third-party facts and shared-room
  facts (regression — third-party unchanged).
- **Pipeline test (mandatory):** a ward-self `medical:sensitive` fact tagged
  `ward-content-gated` → visible in a room whose circle grants `medical:sensitive`
  (e.g. Emergency Contacts), and NOT visible in a room granted only `mental-health`
  (Close Friends) or nothing (strangers). Drive it through the real
  `visibleAudiences → discordReadAudiences` + the content gate (`content_gate.py`
  or `content-tags.js memoryVisibleToVillager`) so the two-gate composition is
  pinned. Include the fail-closed case (no circle grants the topic → no villager).
- Python `content_gate`/`memory.search` test: a sentinel-audience row with a
  `content_tag` surfaces to a room whose `topic_grants` permit it and is hidden
  otherwise.
- Re-tag pass: candidate selection is code-gated to `audience == ward-private`
  with no third-party subject (never selects a third-party or shared-room fact);
  the conservative default keeps a fact `ward-private` when the judgment is
  absent/unsure; a sensitive-content widening routes to the propose-and-approve
  path, not an immediate write. (Stub the batched LLM judgment.)

## Definition of done
- All three suites green; the pipeline test present and passing.
- Docs updated in the same commits as code.
- No ward-self fact is disclosed to a villager who lacks the topic grant.
- The re-tag pass never widens a fact without the Familiar's conservative
  judgment; sensitive content is never opened without ward approval; every
  widening is ward-visible and per-fact revertible.
- Patch-level version bump (ward decision on prior passes: no minor).
- Anything that would widen disclosure beyond this spec is a stop-and-ask.
