# Audience-gated recall — build spec

> **Status:** draft for review. Privacy-critical. Closes the recall-side audience
> leak and completes the audience model the design intended. Patches on `0.7.x`
> (completing an incomplete safety feature, not a new milestone).

## 1. The real gap (verified against code, not docs)

The audience **foundation already exists** — the review/docs were behind the code:

| Thing | Reality |
|-------|---------|
| `audience` column on memories | ✅ exists (`migrations/0001_initial.sql`), indexed, default `ward-private` |
| `audience` column on graph nodes **and edges** | ✅ exists (structural, not a comment hack) |
| Outgoing filter (`search_restricted`, Pillar D) | ✅ exists **and is wired** (`outgoing-filter.js` → server.js + discord-gateway.js) |
| `fetchEligibility` gates whether memory/graph fetch runs | ✅ exists (`audience.js:303`) — a strangers room gets **no** memory fetch |
| The `<!-- gate: -->` markers | parsed for **identity files only** (`stripGatedSections`), **never** for graph nodes — so any gate-comments hand-written into graph-node *descriptions* are **inert** |

**The actual hole:** when a room IS trusted enough to run `memory_search`/`graph_subgraph` (it has the `memories:'shared'` / `graph` grant), those calls run **unfiltered** — `thalamus` never passes the room's `audienceTag`, so memory recall defaults to `ward-private` → `audience_filter_sql` → `"1=1"` → **everything, ward-private included**, and `graph.get_subgraph` ignores `audience` entirely. So ward-private memories/graph **enter the Familiar's context in trusted shared rooms.** The send-side outgoing filter is a partial backstop; the context itself is ungated.

**Plus a latent bug:** `audience_filter_sql` returns `audience IN (room_tag, 'ward-private')` for a non-ward room — including `ward-private`, which contradicts the module's own `is_allowed` and would keep leaking even once wired.

## 2. Design principle

**The trust model stays in JS** (`audience.js` owns categories + grant ladders + scores). The room `audienceTag` is a **Village category id** (or `ward-private`). JS computes the **set of audience tags a room is cleared to see** and passes it to Phylactery; Phylactery just filters `audience IN (set)`. No scoring duplicated in Python; no category-trust drift between the two.

```
audienceTag (category id)  ──audience.js: visibleAudiences()──▶  ["cat-friends", "cat-acquaint", …]
                                                                 (every category whose score ≤ room's,
                                                                  EXCLUDING ward-private; ward room → ALL)
        │
        └─ thalamus passes the set ─▶ memory_search(audiences=[…]) / graph_subgraph(audiences=[…])
                                       Python: WHERE audience IN (…)   (ward room → no filter)
```

## 3. Phases (leak closes first)

### Phase 1 — close the recall leak, with the category ladder
- **`audience.js` `visibleAudiences(roomTag, registry)`** → the set of audience tags a room may see: every category whose `permissionScore` ≤ the room category's score, **excluding `ward-private`**. Ward-private room → a sentinel meaning "all" (`null`). Strangers room → `[]` (sees nothing — though `fetchEligibility` already blocks the fetch there). This IS the category ladder.
- **`memory.py` `audience_filter_sql` + `search`** accept an **allowed-set** (list) instead of a single tag. `None`/ward sentinel → `1=1`; `[]` → `0=1` (nothing); else `audience IN (?,…)`. **Fixes the ward-private-in-the-IN-list bug.**
- **`graph.py` `get_subgraph`** gains the same audience filter (today it has none).
- **`thalamus`** computes `visibleAudiences` from the session's `audienceTag` (+ registry) and passes the set to both `memory_search` and `graph_subgraph`. The MCP tools (`server.py`) thread it through.
- Result: a shared room sees only memories/graph it's cleared for; ward-private never surfaces outside a ward-private session. Closes the leak.

### Phase 2 — write-time audience derivation (the §7 / open-question piece)
Today a memory's `audience` = the session's `audienceTag`. That's a safe ceiling (ward-private sessions → ward-private), but a fact's **sensitivity** and the **subject's** disclosure prefs should be able to make it *more* restrictive.

**Rule (recommended — most-restrictive wins, session is the ceiling):**
```
audience = mostRestrictive( sessionTag, categoryFloor(fact.category), villagerFloor(subjects) )
```
- `sessionTag` — where it was created. **A ceiling: never widened beyond this.** (A memory made in a ward-private chat stays ward-private even if it's about a "friends"-category villager — we don't widen private knowledge.)
- `categoryFloor` — per remember-category sensitivity: `health_info`, `emotional_content` → `ward-private`; `relationships`, `whereabouts`, `basics` → no floor (use ceiling). Conservative.
- `villagerFloor` — if a subject villager's category is *more* restrictive than the ceiling, tighten to it.

> **Open decision for you:** should a villager's *disclosure preference* ever **widen** a memory (e.g. "my health is fine to share with close friends" → a health memory about them becomes `cat-friends` instead of `ward-private`)? Widening is the privacy-risky direction. **Recommendation: NO for v1** — derivation only ever tightens; widening requires the memory to have actually been created in that wider room. The `remember` map already governs *whether* to store; `audience` governs *where it may surface*, and erring restrictive is correct.

### Phase 3 — graph-node audience is settable; retire the inert comments
- A Familiar/UI way to set a graph node's structural `audience` (the field exists; nothing writes it deliberately yet — `graph_relate`/`graph_node_create` default `ward-private`).
- Audit and remove the inert `<!-- gate: sensitive -->` comments from graph-node descriptions (they never did anything). Document that graph gating is the structural field + Phase 1 filtering.

## 4. Cross-cutting
- **Versioning:** `0.7.x` patch per phase.
- **Fail-closed everywhere:** unknown tag → not in the visible set → not shown. Empty set → nothing. A registry read failing during enrich → fall back to **ward-private-only** recall (most restrictive), never "show all".
- **Both gates remain:** Phase 1 is the recall/context gate; the existing outgoing filter stays as the send gate. Defense in depth.
- **Tests:** `visibleAudiences` ladder (pure), `audience_filter_sql` set semantics + the ward-private fix, write-time derivation rule, graph filter.
- **docs/architecture.md** updated per phase; this leak + fix recorded.

## 5. Order & the one decision
Phase 1 (close the leak) → Phase 2 (write-time derivation) → Phase 3 (graph audience + cleanup).
The only thing I need from you before Phase 2: the **widen-or-tighten-only** decision above (recommend tighten-only).

## 6. The LLMs must not have to learn the schema (discoverability & operability)

CLAUDE.md: *every capability must be reachable by the Familiar.* For privacy the
safest reading is stronger — **the extraction LLM and the Familiar must not be
relied on to know about the `audience` field at all.** A field they must remember
to set is a field they will sometimes forget, and a forgotten privacy tag leaks.
So:

- **Memory audience is DERIVED IN CODE, never asked of the LLM.** The
  memorization extractor already produces `category` (health_info, …) and
  `subjects` (villager names) and the job already carries the session
  `audienceTag`. Phase 2 derives `audience` from exactly those three in
  `memorization.js`/`createMemoryFull` — the model is never asked for an audience.
  *Consequence:* `category` and `subjects` accuracy is now **privacy-load-bearing**;
  the extraction prompt stays as is, but this dependency gets a comment so nobody
  weakens those fields later thinking they're cosmetic.
- **Graph-node audience is DERIVED IN CODE too.** When `graph_relate` (the
  memorization auto-graph path) or the chat graph tools create a node that
  resolves to a villager, the node's `audience` is set from that villager's
  category — in the resolve-or-create step, not by the model. A node with no
  villager link defaults `ward-private` (fail-closed). The Familiar is never
  asked to tag a node.
- **What the Familiar IS told (because it acts on it):**
  - The **few** tools where it can deliberately tighten privacy (e.g. a future
    `set_audience`/mark-private, or graph-node audience override) ship a
    first-person description that teaches the *intent* ("I keep this to just
    {{user}} and me / to our close circle"), per the discoverability rule — not
    the field name, the meaning.
  - **Awareness in context:** a short line the Familiar reads when it's in a
    non-ward-private room, so it understands it is seeing a **filtered** view of
    its own memory/graph (it won't recall ward-private things here) and that what
    it stores here is tagged for *this* room. Without this it could get confused
    ("why can't I remember X?") or wrongly assume it has the full picture. This
    rides the existing presence/audience context block — no new call.
- **Net:** the model keeps doing what it already does (extract `category` +
  `subjects`, speak in-room); the privacy tagging is the code's job. The only
  thing the Familiar *learns* is the human-meaning of acting more privately and
  the fact that recall is room-filtered — both in its own voice, both on surfaces
  it already reads.

