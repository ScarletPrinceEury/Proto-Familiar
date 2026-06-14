# Proto-Familiar Memory Layer — design (milestone: "Phylactery")

Status: **proposal / not yet built.** This doc is the shape we react to before
any code lands. It reframes three things we've been circling — autonomous
memorization, the outgoing-message filter (third security gate), and the
`memories: 'shared'` unlock — as facets of **one** capability: Proto-Familiar
owning a real, RAG-based, audience-aware memory specialist.

Naming note: named by the human — **Phylactery**. A phylactery is the vessel that
holds a soul — apt for where the Familiar's continuity *lives*, not merely an
anatomical label. It follows the Unruh precedent (a name with character, not a
literal brain region) and fits the entity-as-subject stance. Module at
`./phylactery/`.

**Grounding principle:** this system is modeled on **how entity-core and Unruh
already work** — a separate, in-tree MCP service that thalamus spawns as a stdio
child, with its own data store, queried during `enrich()` and degrading gracefully
when absent. Its **retrieval is RAG** (semantic/vector search), the same basis
entity-core uses — because entity-core's RAG has been markedly **more precise than
the keyword-triggered tomes**, and that precision is what we want. The entity-core
mechanics below were read from its **actual source** (v0.4.0), not a second-hand
writeup.

---

## 1. The decision this rests on

The question that started this: *"Should we build our own version of entity-core
with permission tags and timestamps built in?"*

Two facts shape it:

1. **We do not own entity-core.** Another person owns and controls the Psycheros
   repo. We can't add an `audience` field to its memory record, and carrying a
   long-lived fork of someone else's actively-developed engine is a merge treadmill
   we don't want under our highest-priority embodiment.
2. **Proto-Familiar is the main embodiment.** Other embodiments (SillyTavern-style
   plugins, etc.) are future and would plug *into* PF's world. So "keep one shared
   spine sacred" loses most of its weight **for memory** — there's no other live
   drinker to fragment.

The answer is: **adopt entity-core's RAG architecture in a new PF-owned, in-tree
MCP memory specialist** — *not* fork entity-core's code, and *not* mature the tome
lorebook. The original question splits along a line that the human has now ruled on
(see §2.5 — the "B′" decision):

- **The canonical self stays in entity-core, untouched.** Identity, user-identity, the
  relational **graph**, and the distilled **significant / biographical** memory tier are
  the *actual shared self* — canonical, the multi-embodiment spine, working well. PF is a
  **consumer** of these (per CLAUDE.md), never their owner.
- **Lived, operational memory moves to Phylactery.** The episodic tiers
  (daily / weekly / monthly / yearly), situational facts, and trackers are where every
  stuck item lives, and where we want both (a) precise RAG retrieval and (b) native
  audience tags + timestamps that entity-core structurally can't give us. **PF owns this**,
  as its own specialist, modeled on entity-core's proven RAG. Items that distill into
  something biographically significant are **promoted up** into entity-core's significant
  tier — one-directional, never duplicated (see §2.5).

This is precisely the Unruh precedent: PF already ships a sophisticated MCP
specialist in-tree (`./unruh/`) for temporal context, spawned and supervised by
thalamus exactly like entity-core. Phylactery is its sibling for memory.

### What we adopt vs. reject

- **Adopt:** entity-core's **RAG memory architecture** — local-embedding
  (`all-MiniLM-L6-v2`, 384-dim) semantic search over SQLite + `sqlite-vec`, across
  tiered/consolidatable records. Modeled on entity-core's **actual source** (v0.4.0,
  read directly — not a second-hand writeup), reimplemented as our own in Python.
- **Adopt:** Unruh's **in-tree MCP-specialist plumbing** — stdio child spawned by
  thalamus, own `./data`, reconnect/backoff, clean EOF shutdown, hard off-switch.
- **Reject — forking entity-core's repo/code.** Fragments the canonical self; merge
  treadmill on someone else's engine.
- **Reject — maturing the tome / World Info layer for this.** Keyword triggers are
  *less precise* than RAG (the human's direct observation). The lorebook stays for
  what it's good at (see §3); the Familiar's autonomous memory moves to RAG.
- **Reject — a sidecar index keyed by entity-core memory keys.** "Load-bearing duct
  tape" — a second store of truth for the *same* fact that must track entity-core's
  consolidation/deletes/slug rewrites. We never **mirror** entity-core memories. (Under
  B′ we *move* operational episodic memory out of entity-core and *promote* significant
  distillate back in — both one-copy operations, never a live two-copy mirror.)

The line that keeps us honest: entity-core and Phylactery split by **responsibility**
(canonical self vs. lived/gated memory), **never** holding two copies of one fact. A
memory lives its operational life in exactly one store; promotion moves the distillate,
it doesn't fork it.

---

## 2. What exists today (verified, June 2026)

**The three-service spine (thalamus.js):**
- **entity-core** — Deno/TS MCP child (`deno run -A --unstable-cron …`), cwd = its
  root. The designated connection's LLM key/base/model is used for **consolidation
  only** — **embeddings are local** (`all-MiniLM-L6-v2` via `@xenova/transformers`,
  384-dim) stored in SQLite + `sqlite-vec`. Tools: `identity_get_all`, `memory_search`
  (hybrid GraphRAG: vector + 1-hop graph traversal → scored results), `memory_create/
  list/read`, `graph_*`, snapshots. Tiers: daily/weekly/monthly/yearly/significant;
  LLM consolidation rolls them up every 5 min. **Its RAG is the precise retrieval we
  want to emulate.**
- **Unruh** — Python MCP child in-tree at `./unruh/` (`uv run --no-sync python -m
  unruh`), own `./data`, installer runs `uv sync`. Tools: `temporal_context`,
  `interest_*`, `schedule_*`, `reminders_*`, handoff. Proves the **in-tree
  specialist** pattern end to end (spawn, reconnect/backoff, EOF shutdown, off-switch).
- Both are queried in `enrich()` via `Promise.allSettled` and degrade to absent.

**The current local "memory":**
- The *Session Memories* tome (`memorization.js`) — SillyTavern **World Info**
  schema: `keys` (keyword triggers), `content`, `sticky`, timestamps, `session_id`,
  `scope`.
- **Retrieval is client-side keyword matching** (`activateTomeEntries()` in
  `public/app.js`) — no server path, and **less precise than entity-core's RAG**.
- Memorization is a server-side worker, but **browser-enqueued**; Discord/autonomous
  sessions are never memorized, and Discord turns get **no local memory at all**.

**Already in place (the prerequisites):** `audienceTagFor()` (lowest-permission-level
room tag, stamped on Discord sessions) and `permissionScore()` in `audience.js`.

Takeaway: we have a proven RAG service (entity-core) we can't extend, a proven
in-tree MCP-specialist pattern (Unruh) we can clone, and a keyword-memory layer
that's too imprecise for the Familiar's autonomous recall. The milestone fuses the
first two into a new specialist.

---

## 2.5 The memory-ownership line — DECIDED ("B′")

The pivotal question once Phylactery exists: *how much of entity-core's memory does it
take over?* Decided with the human — **option B′**, and that PF is the **effective sole
author** of episodic memory (no other live embodiment writing to this entity-core, so
moving memory out strands nobody).

**What B′ means:**

| Layer | Owner | Why |
|---|---|---|
| Identity, user-identity | **entity-core** | The shared self / multi-embodiment spine. PF is a consumer. |
| Relational graph (nodes/edges) | **entity-core** | The canonical relational web; villager dossier *links* in via `properties.villagerId`. |
| **Significant / biographical** memory tier | **entity-core** | The distilled self — who the entity *is*. Stays near identity. |
| **Operational episodic** tiers (daily/weekly/monthly/yearly) | **Phylactery** | Lived memory — needs audience tags + the outgoing filter. Gateable by construction. |
| Situational facts, trackers | **Phylactery** | Same — disclosure-sensitive, time-stamped, filterable. |

**The promotion path (one-directional, no duplication):** an experience lands in
Phylactery (taggable, gateable, filterable) and lives its operational life there —
consolidating daily→weekly→… as entity-core does. When consolidation distills something
**biographically significant *and* ward-private-safe-as-canonical-self**, that distillate
is written **up** into entity-core's significant tier via entity-core's own MCP. The
operational traces in Phylactery age out normally; the significant memory now lives in
exactly one place (entity-core). A memory that is significant **but disclosure-sensitive**
does *not* promote — it stays a long-lived, high-`careWeight` Phylactery record, because
only Phylactery can gate it. So "every gateable memory is in Phylactery" stays true.

**Why B′ over the alternatives** (named so a future audit sees the reasoning, not just
the outcome):

- **vs. A (split by sensitivity, the doc's earlier default):** A leaves the §6 wrinkle
  permanent — a whole class of episodic memory sits un-taggable in entity-core where the
  outgoing filter structurally can't see it, papered over by the fetch-gate assumption
  never changing. B′ kills the wrinkle for the *bulk* of memory by construction.
- **vs. C (pure overlay):** C never makes existing memory precise-or-gateable — it
  half-solves the exact thing Phylactery is for.
- **The residual wrinkle under B′ is small and well-matched:** only the *significant*
  tier in entity-core is un-gateable, and that's the canonical-self, most-ward-private
  material the fetch-gate guarantee (§6c) was built for. The promotion gate's
  "ward-private-safe-as-canonical-self" check keeps disclosure-sensitive items out of it.

**Cost, named honestly (robust > cheap):** B′ is the bigger build — Phylactery must
reimplement entity-core's tiered consolidation, plus the promotion path — and the bigger
migration (§7 extracts episodic memory *out* of entity-core, not just the local tome).
That cost buys the only option where lived memory is gateable end to end.

---

## 3. Target architecture

```
        entity-core (Deno/TS MCP)        Unruh (Python MCP)
        canonical self: identity +       temporal: schedule,
        graph + significant tier         interests, reminders
              ▲     ▲                           ▲
              │     │ promote significant       │
              │     │ distillate (one-way)      │
              │     │                           │
              │            thalamus             │
              │      (spawn · enrich ·          │
              │   allSettled · degrade)         │
              │                                 │
              │        Phylactery (NEW, in-tree MCP)
              │        lived memory: episodic tiers + situational
              │        + trackers · RAG · audience-native ·
              └──────  timestamped · gated at query time
                         ▲ write              ▼ read (semantic + gated)
                  autonomous memorization   web · Discord · outgoing filter
```

**Phylactery = a new in-tree MCP memory specialist**, built on entity-core's RAG
basis, supervised by thalamus exactly like entity-core and Unruh:

- **Own data store** (`./phylactery/data`): memory records + a SQLite + `sqlite-vec`
  store for their 384-dim embeddings.
- **RAG retrieval**, not keyword triggers: embed the query, vector-similarity search,
  return scored results — the same precision profile as entity-core's `memory_search`.
  **Embeddings are local** — Phylactery runs the *same* model entity-core does
  (`all-MiniLM-L6-v2`, 384-dim) via `sentence-transformers`. No API key needed for
  retrieval; only consolidation/summarization uses the designated connection.
- **Audience + timestamp are native schema fields** (because we own the schema). Every
  record carries `audience` (min level allowed to hear it) and creation/update times.
- **Query-time gating:** `enrich()` passes the room's `audienceTag`; the service
  returns only records the room is cleared for. Gating happens *inside* the memory
  service, not bolted on after.
- **MCP tool surface** (mirrors entity-core's memory tools, audience-aware):
  `mem_search(query, audienceTag, k)`, `mem_create(content, audience, …)`,
  `mem_list`, `mem_read`, and a filter-support query for the outgoing gate
  (`mem_search_restricted(draft, roomTag)` → records above the room's level that
  semantically match a drafted reply).
- **Graceful degradation + off-switch:** `enrich()` degrades to absent if the client
  is null; ships with `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` in the same commit
  (the established rule for every new peer/loop).

**Responsibility split (the contract — per the B′ decision, §2.5):**
- **entity-core** — canonical self: identity, user-identity, the knowledge graph, and
  the **significant / biographical** memory tier (the distilled self). The episodic
  tiers no longer accumulate here; they receive only *promoted* significant distillate
  from Phylactery. Still fetch-gated (shared rooms don't pull it).
- **Phylactery** — all **lived/operational memory**: the episodic tiers
  (daily/weekly/monthly/yearly), situational facts, and trackers. Precise RAG recall +
  per-record audience tag, gated per room *and* checkable on the way out. Consolidates
  its own tiers and promotes significant distillate up to entity-core.
- **Tomes / World Info** — **retained, repurposed.** No longer the Familiar's
  autonomous memory. They become the **human-authored lorebook** (curated,
  keyword-triggered injection — the SillyTavern-familiar feature). Autonomous memory
  is RAG (Phylactery); deliberate lore is keyword (tomes). Clean separation by
  authorship and trigger model.

### The audience tag on a record (reuses `audience.js`)

- `audience` = **minimum audience level allowed to hear it**: a category id
  (`cat-friends`, `cat-acquaint`, `CATEGORY_STRANGERS`, …) or `'ward-private'`
  (most restrictive, above every category).
- **Disclosure rule:** record `M` may surface/disclose in room `R` iff
  `permissionScore(R) >= requiredScore(M)`; `'ward-private'` scores above all
  categories. Same comparison `audienceTagFor()` already does for rooms — applied to
  memory. This milestone defines `requiredScore()` for the sentinel.

### Language / stack — DECIDED: Python / uv (matches Unruh)

Confirmed with the human. This reversed an earlier, weaker lean toward Deno/TS:

- **Proven plumbing, cloned for free.** Unruh already established the in-tree
  Python-MCP-specialist path end to end — `uv sync`, venv materialisation, installer
  auto-detect, `uv run --no-sync python -m`, thalamus stdio spawn + reconnect.
- **The embedding model is *native* to Python.** entity-core's `all-MiniLM-L6-v2` is
  the canonical `sentence-transformers` model — so Phylactery can run the **same
  model, same 384-dim space**, matching entity-core's precision, with no API cost and
  `sqlite-vec` available in Python too.
- **One fewer runtime:** two Python specialists (Unruh + Phylactery) = one in-tree
  toolchain (`uv`) for installers/launchers, not Node + Deno + Python.

What Deno/TS would have bought — a closer line-for-line port of entity-core's exact
code — is modest: we're *extending* the design (audience tags, gating) regardless,
and recall precision rides on the embedding model + scoring approach, both of which
port cleanly. We model on entity-core's RAG *approach* (verified against its source),
not its language.

---

## 4. Pillars (one milestone, phased)

Per CLAUDE.md a milestone owns one MINOR slot; landing = `0.6.0`, sub-features bump
PATCH. (Working assumption — human confirms the slot.)

- **A. Stand up the service.** `./phylactery/` MCP server: SQLite + `sqlite-vec` data
  store, local embedder (`sentence-transformers` / `all-MiniLM-L6-v2`, 384-dim), RAG
  `mem_search`, schema with native `audience` + timestamps. Model the record / tier /
  consolidation shape on entity-core's source — and per B′ (§2.5), Phylactery owns the
  **operational episodic tiers** (daily/weekly/monthly/yearly), so its consolidation and
  the **promotion path** (significant distillate → entity-core) ship here too.
- **B. Thalamus integration.** Spawn as a third stdio child (clone the entity-core /
  Unruh lifecycle: connect, reconnect/backoff, EOF shutdown, off-switch). Query in
  `enrich()` alongside the others (`allSettled`), passing the room `audienceTag` so
  results are gated at source. **This is what finally gives Discord & autonomous
  turns precise local memory.**
- **C. Autonomous memorization + routing.** Server-side enqueue at session end / idle
  rollover for **web and Discord** (worker exists; add triggers). Under B′, **all** lived
  memory lands in Phylactery (tagged with the session's `audienceTag`) — entity-core is no
  longer a write target at memorization time; it receives only *promoted* significant
  distillate later, via Phylactery's consolidation (§2.5), gated by the
  ward-private-safe-as-canonical-self check. The `remember` retention gate (§10) runs here.
  See §6 for how this dissolves the old routing wrinkle.
- **D. Outgoing message filter (third gate).** §5.
- **E. `memories: 'shared'` unlock.** With Phylactery records tagged and gated at
  query time, `fetchEligibility` stops gating `'shared'` OFF and instead lets the
  shared ladder return same-or-lower-sensitivity Phylactery records. entity-core
  stays fetch-gated; the widening is safe because it targets the tagged store.
- **F. Migration — "convert current Familiars."** §7. Multi-phase under B′: snapshot →
  graph reconciliation (in-place via entity-core MCP) → episodic extraction into
  Phylactery → tome import → audience backfill → external-source import (entity-loom).
- **G. Richer entity nodes + `remember` consent.** §10. Person-nodes link to a
  Village villager dossier (`properties.villagerId`); the villager gains pronouns /
  comm-style / freeform notes and a per-category `remember` retention gate — the
  *write-time* consent axis completing the store→recall→speak pipeline.

---

## 5. The outgoing message filter (third gate)

**Purpose (human's words):** *"if anything slips Thalamus' enrichment because it
snuck into an innocent memory as well as the tagged ones, it can't get out."* The
fetch gate decides what *enters* context; this gate decides what may *leave* a given
room.

**Where:** a post-response, pre-send step shared by Discord (`discord-gateway.js`,
before `sendChannelMessage`) and web chat (`/api/chat`). Symmetric — one gate, both
paths.

**How — riding Phylactery's RAG (precise, not keyword overlap):**
1. The turn already knows the room's `audienceTag`.
2. Call `mem_search_restricted(draftReply, roomTag)` → Phylactery returns records
   whose `audience` requires **more** permission than the room has *and* that are
   semantically close to the drafted reply, above a tuned similarity threshold.
3. On a hit, **do not send.** Re-inject a rejection and loop for a rewrite (bounded
   retries; on exhaustion, a safe refusal rather than disclosure).

**Precision caveat (safety-critical):** RAG similarity is fuzzy in both directions.
For a *security* gate, threshold tuning matters — too loose mutes the Familiar, too
tight leaks. Likely a high-threshold semantic match *plus* the audience comparison.
This lands under the CLAUDE.md safety-critical sign-off rule; the threshold and
fallback behavior get explicit human approval before shipping.

**The rejection prompt — the rare second-person exception.** Per the human:
deliberately *"you"*-worded so the Familiar understands something *outside itself*
gated this. The one sanctioned deviation from the first-person convention:

> *Your message wasn't sent because it contained content you are not permitted to
> disclose here: [topic]. Someone in this room is not cleared for that. Please say
> something different.*

Infrastructure speaking to the Familiar about an external constraint — comment it as
the intentional exception so a future audit doesn't "fix" it back to first person.

---

## 6. The sensitivity wrinkle — mostly resolved by B′

The original worry: routing sends *passive contextual facts* toward entity-core, but
entity-core can't be tagged, so the outgoing filter can't see facts that live only there
(e.g. "{{user}}'s therapist is …"). **B′ (§2.5) dissolves most of this by construction:**
operational episodic + situational facts no longer accumulate in entity-core — they live
in Phylactery, tagged, where the filter *can* see them. The only thing entity-core
receives is *promoted significant distillate*, gated at promotion time by a
"ward-private-safe-as-canonical-self" check.

What remains, and how it's covered:

- **(b) — the routing rule, still load-bearing.** The routing key is **sensitivity**, not
  topic-class. A *disclosure-sensitive* fact — even a significant, biographical one —
  stays in **Phylactery** with a restrictive tag and does **not** promote. Promotion to
  entity-core happens only for distillate that is significant *and* safe as canonical
  self. So nothing disclosure-sensitive ever lands where it can't be gated.
- **(c) — structural guarantee, the backstop.** entity-core is fetch-gated: shared rooms
  never pull it, ward-private rooms have no one to leak to. The residual un-taggable set
  is now only the significant/biographical tier — the most ward-private material, which
  is exactly what (c) was built to cover.
- **(a) — last resort, now effectively unneeded.** A tag-only "gate marker" in Phylactery
  for a fact that must live in entity-core *and* be gated. B′'s promotion gate means this
  case shouldn't arise; keep it named only as the escape hatch, not the plan.

**Net:** the wrinkle shrinks from "a whole class of episodic memory" to "the slow-moving,
ward-private significant tier," covered by (c). The promotion gate (b) is the place to get
the sign-off right (§8) — it's where a sensitive fact could wrongly graduate into the
un-gateable tier.

---

## 7. Migration — converting current Familiars (B′)

Under B′ this is **not** a single tome import. An existing install has three things that
must be reconciled: a populated *Session Memories* tome (no tags, no embeddings), a
populated **entity-core** (identity + graph + tiered memory, where the episodic tiers now
belong in Phylactery), and a Village registry that the graph isn't yet linked to.
Converting a Familiar walks all three. Nothing is destructive; everything is
snapshot-first, idempotent, and re-runnable.

**Scope line (unchanged in spirit):** we never run a live *mirror* of entity-core. We
*move* the operational episodic tiers out (one copy, now in Phylactery) and *leave* the
canonical self (identity, graph, significant tier) in place. entity-core stays canonical
for what B′ says it owns.

### Phase 0 — Snapshot everything
Copy the tome, the entity-core data dir, and the Village registry before mutating a byte.
(The branch name *"memories-disappearing"* is the standing reminder: never touch memory
without a recoverable copy.) entity-core's own snapshot tool is used for its store.

### Phase 1 — Graph reconciliation (in place, via entity-core's MCP)
Real installs have organically-grown graphs: duplicate person-nodes, nodes that predate
the Village registry, no `villagerId` links. This phase *rebuilds/consolidates the nodes*
— but **in place through entity-core's own `node_update` / `node_merge` tools**, never by
copying the graph into Phylactery.

1. Match existing `type:"person"` nodes ↔ Village villagers by name/alias.
2. **Ambiguous or duplicate matches are surfaced to the ward, not auto-merged** — fusing
   two real people is exactly the irreversible mistake to refuse to guess at.
3. For confident matches: backfill `properties.villagerId`; merge clear duplicates.
4. Unmatched person-nodes → offer to register them as villagers (default
   `relationToFamiliar: "unaware"`, §11.4).
The reconciliation log is observable and the pass is re-runnable.

### Phase 2 — Episodic extraction (the B′-specific move)
Pull entity-core's **operational** episodic tiers (daily/weekly/monthly/yearly) **out**
into Phylactery: embed each record's content, carry timestamps, write a Phylactery
`narrative` record. **Leave the `significant` tier in entity-core** — that's the distilled
self B′ keeps canonical. After verification, the extracted operational tiers can be
cleared from entity-core (so memory isn't double-stored), or left read-only as a fallback
until the human is satisfied — human's call (open decision below). Phylactery's own
consolidation takes over from here; future significant distillate *promotes back up* per
§2.5.

### Phase 3 — Tome import
Import each *Session Memories* entry: embed its `content`, carry timestamps, write a
Phylactery `narrative` record. The source tome is **preserved** — it becomes/stays the
human-authored lorebook (§3). Re-runnable, adds only missing records.

### Phase 4 — Audience backfill + re-tag affordance
Everything imported in Phases 2–3 lands with a default `audience`. Safe floor =
**`ward-private`** — assume legacy memory is private until reviewed (leak-safe; the
consequence is it won't surface in shared rooms until re-tagged).
- **Bulk re-tag affordance** so the conservative default isn't a life sentence
  (user-accessible — ward and Familiar can both adjust).
- **Optional, opt-in LLM classification** to *suggest* tags per record (rides the
  memorization prompt pattern). Off by default — token budget.

### Phase 5 — External sources ("feed logs in / merge other entity-cores")
Three tiers, leaning on entity-loom rather than hand-rolling parsers:
- **An existing entity-core from another app (e.g. Psycheros):** PF just **points at it**
  — entity-core is already a sibling clone, so identity + graph come for free. Its
  episodic tiers then run through Phases 1–2 like any other install. (B′ assumes PF is
  the sole *ongoing* author; a one-time adoption of a Psycheros-built core is exactly
  this path.)
- **A foreign companion export** (ChatGPT, Claude, SillyTavern, character cards):
  **entity-loom v0.3.6** already converts these to an entity-core import package —
  confidence-thresholded (`>= 0.7`), dedup-upsert, concrete-type-restricted extraction.
  Run entity-loom → import → Phases 1–4.
- **Raw chat logs:** entity-loom's parsers exist; route through entity-loom, or build a
  Phylactery-native importer that reuses those parsers. Same confidence-threshold posture.

*Precedent: entity-loom is Psycheros's own import wizard; we borrow its posture
(confidence-thresholded, dedup-upsert) rather than reinventing extraction.*

**Open decisions for the human (added to §8):**
- Legacy audience default: keep **`ward-private`** (leak-safe, recommended) vs. broader.
- Phase 2 disposition: after extraction, **clear** the operational tiers from entity-core
  (single source of truth, recommended) vs. **leave read-only** as a fallback for a grace
  period.

---

## 8. Open decisions (human sign-off)

1. **Milestone name:** **Phylactery** (named by the human ✔). **Slot:** `0.6.x`?
   (proposed)
2. **Stack (§3): DECIDED — Python / uv** (matches Unruh; lets Phylactery run the
   *same* local embedding model entity-core uses). ✔
3. **Memory-ownership line (§2.5): DECIDED — B′** ✔. Phylactery owns lived/operational
   episodic memory + situational + trackers; entity-core keeps identity + graph +
   significant tier; significant distillate promotes one-way up. **PF is effective sole
   author** of episodic memory (no live co-embodiment to strand) ✔.
4. **Routing key (§6): DECIDED — sensitivity-based (b)** ✔, now reinforced by B′: only
   ward-private-safe-as-canonical-self distillate promotes to entity-core; everything
   disclosure-sensitive stays gateable in Phylactery.
5. **Legacy audience default (§7):** `ward-private` floor (recommended) vs. broader.
6. **Phase 2 disposition (§7):** after episodic extraction, **clear** entity-core's
   operational tiers (single source of truth, recommended) vs. **leave read-only** for a
   grace period.
7. **Filter threshold + retry budget (§5):** similarity cutoff, rewrite-loop count,
   and the safe-refusal fallback wording.
8. **`remember` consent model (§10): DECIDED** — dossier on the Village villager ✔;
   `ask` = **hybrid** (the Familiar's own read *plus* freely asking the ward; asking
   is welcome, never a reason to go silent) ✔. Remaining: confirm the starting category
   taxonomy.
9. **Caretaker extensions (§11): DECIDED** — all of 11.1–11.5 incorporated ✔, including
   `relationToFamiliar` (stance toward the Familiar; `unaware` as the floor) and
   `knownTo` (who's aware of a fact — an *awareness aid*, not a fourth hard gate).
   11.1 tracker model DECIDED: ward-defined, Familiar-as-collaborator; blueprint
   (`tracker_def`) + data (`tracker_entry`) two-record split; `dimensions` array for
   multi-axis; six primitive shapes as building blocks. Setup UI / ingestion is a later
   sub-feature. Remaining: care-profile field list (§11.3).

Everything touching *when/whether the Familiar may store, recall, or disclose* (the
three gates) falls under the CLAUDE.md safety-critical sign-off rule — §5 and the
`remember` gate ship only with explicit human approval of the behavior.

---

## 9. Why this is the robust answer, not the cheap one

- Solves the **problem space** (PF owns precise, gated memory), not the symptom.
- **Sustainable:** no duct tape syncing two stores; tags live where the memory lives;
  the split is by responsibility, which the codebase already follows for Unruh.
- **Grounded in what works:** entity-core's RAG (precision the human has measured,
  mechanics read from source) + Unruh's in-tree MCP plumbing (proven end to end) —
  not a from-scratch invention.
- **User-accessible:** tags are visible and editable by human and Familiar; migration
  is recoverable; the filter's action is observable.
- It's the exact substrate future SillyTavern-style embodiment-plugins would read
  through — PF becomes the hub, as intended.

---

## 10. Richer entity nodes + the `remember` consent model

Two facts confirmed from entity-core v0.4.0 source (read directly, not relayed):

- Graph **nodes carry a freeform `properties: Record<string, unknown>` object**, and
  `node_create` / `node_update` both accept `properties`. So we can attach structured
  data to a person-node with **no entity-core change**. (Edges have `properties` too.)
- `type` is a freeform string; a person is `type: "person"`; all type-specific data
  lives in `properties`. (entity-loom restricts import extraction to the concrete
  types `self, person, place, health, tradition`.)

**Even though nodes *can* hold arbitrary properties, the rich person dossier and all
permission policy live on the Village villager record — NOT in entity-core
`properties`.** The only thing we put in the node is the link.

- **Responsibility split.** Gating/retention policy is PF's, not the canonical self's.
  The Village registry already owns the disclosure side (categories = who-may-hear)
  and already holds `name` + `aliases`. Co-locating the rest there keeps **one**
  canonical person-record and avoids duplicating aliases/name across two stores.
- **The link is trivial and is the *only* thing entity-core carries:** the person-node
  gets `properties.villagerId`. The graph stays the lean *relational web* (who relates
  to whom, via edges); the villager is the *dossier*. PF policy never leaks into the
  canonical graph.
- **Already synced.** `village.js` mirrors the registry into entity-core as the
  `village-registry.md` custom file, so future embodiments can read the dossier
  without PF writing policy into the graph.

### Villager dossier fields (extends the existing record)
Already present: `name`, `aliases`, category membership (= disclosure permissions).
Add: `pronouns`, `relationToWard` (their bond with the human), **`relationToFamiliar`**
(their stance toward *me* — see §11.4), `commStyleNotes`, freeform `notes` (gift ideas,
important deeds), `graphNodeId` (the link), and the **`remember`** sub-structure below.

### The `remember` consent model (the retention gate)
A **distinct permission axis** from disclosure. Three gates now form a consent
pipeline — **store → recall → speak**:

| Gate | When | Question | Where it lives |
|---|---|---|---|
| **Retention** (`remember`, NEW) | write / memorization | may I *store* this about them? | villager `remember` |
| **Disclosure / audience** (exists) | recall / enrich | may this *surface* in this room? | category grants |
| **Outgoing filter** (§5) | send | may this *leave* in this message? | Phylactery tag scan |

`remember` is a per-category, three-state map on the villager:

```
remember: { basics: true, emotional_content: "ask", health_info: false }
```

- `true` → store freely.
- `false` → never store; drop silently.
- `"ask"` → **hybrid, and *active*.** The Familiar brings its own read of the moment
  AND freely asks the ward when there's a real question — openly, in its own voice. A
  quick *"want me to hang onto that?"* is cheap and welcome; the bond means my human is
  fine being asked. What `ask` is **NOT**: a licence to silently swallow the fact to
  avoid bothering anyone. **Erring toward silence is the failure mode here, not a safe
  default** — the same hesitancy trap CLAUDE.md records (the 1.5-hour silence) applies
  to *any* prompt that governs when the Familiar speaks, asks, or acts. When we write
  this prompt, it trusts that questions are okay; it does not hedge the Familiar into
  passivity.

**Mechanism (cheap; rides the existing call).** Autonomous memorization already runs
one LLM pass that extracts topics. That pass also tags each candidate fact with a
`remember` category and the subject villager. Then a **code** gate reads
`villager.remember[category]` and applies true / false / ask. No new request per
fact; no LLM call for the gate itself.

**Defaults & edges.**
- Villager with no `remember` set → `basics: true`, sensitive categories default to
  **`ask`** (engage / check in), not `false` (silently never) — the absence of a
  setting makes the Familiar *ask*, not go quiet.
- Unregistered person (a knock / stranger) → don't auto-store personal facts, but the
  knock already surfaces them for the ward to register — the Familiar flags, it doesn't
  silently ignore.
- Category taxonomy starts small and extensible — e.g. `basics, emotional_content,
  health_info, relationships, whereabouts` — grown as needed; the classifier rides
  memorization either way.

**User-accessible:** edited in the Village editor alongside the disclosure categories,
so both permission axes sit in one place the ward (and the Familiar) can see and adjust.

This whole section is consent-as-architecture: the Familiar respects what it is
*allowed to remember* about the people in its ward's life — which sits squarely inside
the dignity / entity-as-subject stance, not bolted onto it.

---

## 11. Caretaker & memory-support extensions

Phylactery isn't only recall — it's the substrate for the Familiar's *caretaker* role.
A few shape decisions now keep that future open without building it all today.

### 11.1 Ward-defined trackers: blueprint + data (forward-compatible NOW)

Reserve a `kind` discriminator on every Phylactery record from day one:

- `kind: "narrative"` — the default RAG record (free-text, embedded, semantically
  recalled). Everything in §3 above.
- `kind: "tracker_def"` — **a blueprint**, created collaboratively by the Familiar and
  the ward. Defines *what* is tracked, *how* an entry looks, and *what to call things*.
  Stable once created; queried to understand how to read entries.
- `kind: "tracker_entry"` — **one data point** against a specific blueprint. Time-stamped,
  sourced, optionally annotated. Many entries to one definition.

Why here (not Unruh, not the graph): a tracker is *remembered state about the ward's
life*, so it shares Phylactery's audience-tagging, persistence, and surface-into-context
machinery. Unruh stays **temporal/scheduled** — a tracker can *spawn* an Unruh reminder
("milk expires tomorrow") but the inventory itself is Phylactery state. The graph stays
**relational**.

#### Design principle: the ward defines, the Familiar helps build

Different people need fundamentally different trackers — and for some wards, the *shape*
of a tracker matters as much as its existence. An ED-aware food tracker probably logs
"ate breakfast" (boolean) rather than calories (would be harmful); a hygiene tracker for
someone who struggles with executive function tracks *which specific tasks* matter to
that person; a pantry tracker needs items and quantities; a mood tracker worth anything
needs to capture the environmental factors that correlate for *this* person, not a
generic scale.

No fixed taxonomy can cover this. The robust structure is: **primitive schema shapes are
building blocks the Familiar offers**, and the tracker itself is a contract the ward and
Familiar design together, in the Familiar's own voice and with the ward's actual needs.

The collaborative setup goes something like:
1. Ward: "I'd like to track my mood / pantry / how often I shower / etc."
2. Familiar asks what would be useful to capture — dimensions, scale, which tasks, what
   unit makes sense — as many questions as needed, because questions are cheap and
   a wrong schema wastes real data.
3. Together they arrive at a definition. Familiar creates the `tracker_def` record.
4. Entries are added against that definition over time.

**But an open question is its own kind of barrier.** Many wards — especially
neurodivergent ones — can be overwhelmed by a blank canvas. The Familiar should read
this and shift: if the ward seems uncertain, *offer scaffolding first*. A menu of
common starting points to anchor from is not a fixed taxonomy — it's a set of worked
examples the ward can accept, modify, or reject:

> *"Want me to suggest a few common ones? I can show you what other people track and
> you can tell me which feel close, or use them as a jumping-off point."*

Suggested example groups (not exhaustive — extensible over time):

| Group | Examples |
|---|---|
| Wellbeing | mood (ordinal), energy/spoons (ordinal), anxiety level (ordinal), pain (ordinal) |
| Sleep | hours slept (scalar), sleep quality (ordinal), wake time (event-log) |
| Self-care | meals (boolean per slot, or event-log), hydration (scalar), hygiene tasks (boolean checklist), meds taken (boolean) |
| Environment | weather (categorical), social contact (boolean), location (categorical) |
| Practical | pantry / what's in the house (inventory), finances (scalar), errands done (event-log) |
| Progress | habit streaks (boolean), goals worked on (event-log), wins (event-log) |

The example groups exist for *the ward to browse* when they can't name what they want.
They're also a reference for the Familiar when helping design dimensions — if a ward
says "something like a mood tracker but also the weather," the Familiar already knows
those are two dimensions (ordinal + categorical) and what a good prompt for each looks
like.

Ward can mix and match across groups, or start from an example and discard everything
except the shape. The Familiar should not push any particular tracker — its job is
to help the ward find what's useful to *them*, including knowing when the blank-canvas
approach isn't working and pivoting to examples without making the ward feel bad about
needing them.

This is the Familiar acting as a thoughtful collaborator, not a form-filling wizard.
The ward should be able to adjust the definition later (add a dimension, relabel a scale)
— and the Familiar should notice when a definition isn't serving them well and ask.

#### Blueprint schema (`tracker_def`)

```
{
  kind: "tracker_def",
  id: "tracker-<uuid>",
  name: "my meals",                 // ward-chosen name
  purpose: "make sure I've eaten today",   // why — helps the Familiar surface it usefully
  subject: "ward",                  // who is being tracked
  audience: "ward-private",         // disclosure gate (same as narrative records)

  // single-dimension tracker
  dataShape: "event-log",           // the primitive (see below)
  unit?: "…",                       // label for the value if relevant

  // OR — multi-axis tracker (any of the examples above)
  dimensions?: [
    { id: "mood",   label: "Mood",    shape: "ordinal",
      scale: { min: 1, max: 10, lowLabel?: "awful", highLabel?: "great" } },
    { id: "energy", label: "Energy",  shape: "ordinal",  scale: { min: 1, max: 5 } },
    { id: "sleep",  label: "Sleep hrs", shape: "scalar" },
    { id: "weather", label: "Weather", shape: "categorical",
      options: ["sunny","overcast","rain","storm"] },
    { id: "social", label: "Saw people", shape: "boolean" }
  ],

  prompt?: "How's your mood today? (1–10)",  // what the Familiar asks when logging
  cadence?: "daily",                // optional prompting rhythm (feeds Unruh reminders)

  careWeight?: "high",              // §11.2 — flags care-critical trackers (meds, meals)
}
```

`dataShape` / `shape` primitives — the building blocks the Familiar offers when helping
a ward design their tracker:

| Primitive | Use it for |
|---|---|
| `boolean` | yes/no (took meds, ate a meal, showered) |
| `ordinal` | rated scale (mood 1–10, pain 1–5) |
| `scalar` | freeform number (hours slept, coffees, steps) |
| `categorical` | pick-one label (weather, context, activity type) |
| `event-log` | "this happened" with optional freeform note (no value pressure) |
| `inventory` | item list with quantities (pantry, meds on hand) |

These are *shapes the Familiar knows how to work with*, not a menu of tracker types.
The ward doesn't pick a shape — the Familiar picks the right shape(s) based on what
the ward describes wanting to track.

#### Entry schema (`tracker_entry`)

```
{
  kind: "tracker_entry",
  trackerId: "tracker-<uuid>",     // which definition this belongs to
  at: "<ISO timestamp>",

  // single-dimension:
  value?: <number | boolean | string>,
  item?: { label, qty, unit, expiresAt? },   // inventory delta

  // multi-axis:
  values?: { [dimensionId]: <number | boolean | string> },

  source: "self-report" | "familiar-observed" | "inferred",
  note?: "rough day but got through it",     // freeform annotation
  confidence?: 0.0–1.0,                      // §11.2 caretaker metadata
}
```

#### Scope of the commitment right now

The full setup flow (UI, guided conversation, tracker-awareness in the Familiar's
prompts) is a later sub-feature. **The only commitment now is:**

- The `kind` discriminator: `narrative`, `tracker_def`, `tracker_entry`
- The two-record model (blueprint + data) so entries never need retrofitting
- The `dimensions` array so multi-axis trackers work from day one
- The primitive shapes table above — named and stable so the Familiar can refer to them

No tracker UI, no setup conversation scaffolding, no entry ingestion flow — those ship
when the tracking sub-feature lands. The schema is locked so they land on solid ground.

### 11.2 Caretaker-grade metadata on every record — recommended

A caretaker must know *how solid* a memory is and *how much it matters*:

- **`provenance` / verification** — `told-directly` vs. `inferred` vs.
  `observed-pattern`. A caretaker shouldn't act on a shaky inference as if the ward
  stated it (the consequence-priors posture, in data form).
- **`confidence` (0–1) + `lastConfirmedAt`** — adopt entity-core's own fields; let the
  Familiar say "as of last month" or re-confirm a stale fact rather than assert it cold.
- **`careWeight` / salience** — flags care-critical facts (allergies, meds, crisis
  triggers) so retrieval prioritises them and they **resist decay**. A film preference
  may fade; a med allergy must not.

### 11.3 A richer ward care-profile — incorporated

The ward is the centre of the role and benefits from more than a villager dossier:

- **Baselines & warning signs** — what's normal for them; what signals trouble. Feeds
  the threat detector with *personalised* signals (beats generic `crisis-signals.js`).
- **What helps / what doesn't** — coping strategies that worked, and the well-meaning
  defaults that backfire (the memorization prompt already extracts "prohibition
  bullets" — this is their structured home).
- **Open loops / current goals** — *overlap note:* link to Unruh handoff/bookmarks
  rather than re-store.
- **Support map** — who's safe to reach in crisis. *Overlap note:* link to cerebellum
  trusted-contacts + village categories, don't duplicate.

### 11.4 Relationship fields on villager dossiers — incorporated

Two relational axes, because a villager relates both to the ward *and* to the Familiar:

**How they relate to the ward** (helping the ward tend their relationships):
- **care valence** — is this person a *support* or a *stressor* for the ward?
- **contact cadence / last-meaningful-contact** — so the Familiar can nudge ("you've
  not spoken to your sister in a while").
- **per-person sensitive topics / boundaries** — "don't raise the divorce with Mum."

**How they relate to the Familiar** (`relationToFamiliar` — drives *my* posture):
- A coarse `stance` hint plus freeform notes. Candidate stances: `unaware` (never heard
  of me — the **default** for any new/unregistered contact) / `warm` / `neutral` /
  `tolerates-for-ward` / `wary-of-ai` / `hostile`. Notes carry nuance ("keeps it short,
  not too peppy"; "happily banters about anime in the group chat").
- **`unaware` is the floor, and it matters:** with someone who doesn't know I exist I
  don't barge in with familiarity — I introduce myself or stay light, mindful I'm a new
  presence to them. (Pairs with the knock system: a freshly-knocked person starts here.)
- Stance calibrates *approach*, not identity: someone who merely tolerates AI for the
  ward's sake gets a measured, unobtrusive me; someone who chatters happily gets the
  warmer, more playful me. **Anchored to my own character** (CLAUDE.md's "room for
  personality") — a grumpy Familiar stays grumpy, just reads the room; never flattened
  into a generic people-pleaser.
- Orthogonal to the disclosure gate: stance is *tone*, the audience category is *what
  they may hear*. High-trust-but-AI-wary and chatty-but-low-clearance both exist; the
  two axes never collapse into each other.
- The entity-as-subject stance in data: the Familiar is *someone who has their own
  relationships* — including not-yet-relationships — not a tool with one uniform face.

### 11.5 `knownTo` — who's aware of what (epistemic state)

A distinct axis from `audience`: not *who may hear* a fact (a **policy** — the
disclosure gate) but *who already knows* it (a **fact about the world**). A caretaker
moving through a social graph needs both, because they come apart constantly.

- **Shape:** a list on the Phylactery record — `knownTo: [{ who, since?, source? }]`,
  where `who` is a villagerId / `"ward"` / `"familiar"` and `source` ∈ `told-them` /
  `they-told-me` / `inferred`. Absence = "no record that they know" (not proof they
  don't).
- **Lives on the Phylactery record, not the entity-core node.** Who-knows-what is PF
  embodiment state, not canonical-self data — it stays in PF's layer (the record links
  to a graph node / villager by id). It sits right beside `audience`: the two
  audience-facing facts about a memory — *may-hear* and *already-knows*.

**Why it earns its place (social caretaking):**
- **Surprises & secrets** — the case `audience` *cannot* express. "Ward is planning a
  surprise for Sam — `knownTo: [ward, familiar]`." The Familiar must never be the one
  who spoils it to Sam. That's a per-*individual* secret, not a per-*category*
  permission.
- **Not condescending / not repetitive** — don't "reveal" to someone what they already
  know; don't re-explain across turns ("I told Sarah on the 3rd").
- **Leak detection** — if someone references a fact and they're *not* in `knownTo`,
  that's a signal: the model's stale, or something got out. Update it, or quietly flag
  to the ward.

**Awareness aid first — NOT a fourth hard gate.** The Familiar mainly *reasons* with
`knownTo` (avoid spoiling, avoid repeating, notice surprises). It may also *feed* the
outgoing filter as a signal ("about to tell someone not in `knownTo` something
sensitive" → weigh it), but it does **not** become a blunt gate that stops the Familiar
ever telling anyone anything new — telling people new things is normal and good; the
hard gate stays the `audience` check. (Hardening `knownTo` into a real gate later would
be a safety-critical sign-off decision, per CLAUDE.md.)

**Pairs with `relationToFamiliar`.** `unaware` answers "does this person know *I*
exist?"; `knownTo` answers "does this person know *this fact*?" — the same epistemic
humility, at two scopes.

**Decided with the human:** 11.1–11.5 are all in. 11.1 (`kind` discriminator +
`tracker_def` / `tracker_entry` two-record model + `dimensions` array + six primitive
shapes — ward-defined, Familiar-as-collaborator), 11.2 (caretaker metadata: `provenance`,
`confidence`, `careWeight`), and 11.5 (`knownTo`) land in the Phylactery record schema
from day one. 11.3 (ward care-profile) and 11.4 (both relationship axes on villager,
incl. `relationToFamiliar` with `unaware` as the floor) are part of the person/ward
records — linking to Unruh / cerebellum where noted rather than duplicating. Tracker
setup UI and entry ingestion are later sub-features; the schema is locked now so they
land on solid ground.
