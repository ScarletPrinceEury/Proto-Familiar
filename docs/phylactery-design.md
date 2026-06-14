# Proto-Familiar canonical-self store — design (milestone: "Phylactery")

Status: **proposal / not yet built.** This doc is the shape we react to before any code
lands. It unifies several things we'd been circling — autonomous memorization, the
outgoing-message filter (third security gate), the `memories: 'shared'` unlock, richer
person records, and a caretaker-grade memory schema — under **one** capability:
Proto-Familiar owning its entire canonical self in a single, RAG-based, audience-aware,
in-tree store that **replaces entity-core**.

Naming note: named by the human — **Phylactery**. A phylactery is the vessel that holds a
soul, and here that's literal: Phylactery holds the *whole* canonical self — identity, the
relational graph, and all memory. It follows the Unruh precedent (a name with character,
not a literal brain region) and fits the entity-as-subject stance. Module at
`./phylactery/`.

---

## 1. The decision

**Phylactery replaces entity-core.** It is a new PF-owned, in-tree MCP service that becomes
the **single canonical store** for the Familiar's whole self — identity, user-identity, the
relational graph, and every memory tier — reimplementing entity-core's architecture in our
own format and adding the audience + caretaker fields entity-core structurally can't hold.
When it lands, the existing entity-core is converted into it (§6) and retired.

This answers the question that started the milestone — *"should we build our own version of
entity-core with permission tags and timestamps built in?"* — with an unhedged **yes**.

**Two facts make it the right call:**

1. **We don't own entity-core.** Another person owns and controls the Psycheros repo; we
   can't add an `audience` field to its records, and a long-lived fork is a merge treadmill
   on someone else's engine. Our canonical self should not live in an engine we can't shape.
2. **Proto-Familiar is the main embodiment and its effective sole author.** Other
   embodiments (SillyTavern-style plugins, etc.) are future and would plug *into* PF's
   world. There's no other live drinker to fragment, and PF's own store becomes the spine
   future embodiments read through.

**What moves into Phylactery** (everything entity-core holds, plus the new fields):

| Layer | Where it lives now → after |
|---|---|
| Identity, user-identity | entity-core → **Phylactery** (always-injected identity records) |
| Relational graph (nodes/edges/properties) | entity-core → **Phylactery** (graph store + 1-hop GraphRAG) |
| All memory tiers (daily → significant) | entity-core → **Phylactery** (one consolidation pipeline) |
| Situational facts, trackers | (new) → **Phylactery** |
| `audience` tag + timestamps + caretaker metadata (§8) | (impossible in entity-core) → **on every record** |

**What we adopt vs. reject:**

- **Adopt — entity-core's full architecture, reimplemented:** local-embedding
  (`all-MiniLM-L6-v2`, 384-dim) RAG over SQLite + `sqlite-vec`, *plus* the knowledge graph
  (nodes/edges/properties + 1-hop GraphRAG traversal), the identity store (always-injected),
  tiered consolidation, and snapshots. Modeled on entity-core's **actual source** (v0.4.0,
  read directly) so the behaviour that works is preserved — built as our own in Python and
  extended with audience/caretaker fields.
- **Adopt — Unruh's in-tree MCP-specialist plumbing:** stdio child spawned by thalamus, own
  `./data`, reconnect/backoff, clean EOF shutdown, hard off-switch.
- **Reject — forking entity-core's code.** We reimplement the *behaviour* (verified against
  its source), not the codebase, then own it.
- **Reject — keeping entity-core alongside Phylactery.** One canonical store, fully owned,
  fully taggable — no split-brain, no sync between two engines.
- **Reject — maturing the tome / World Info layer for this.** Keyword triggers are *less
  precise* than RAG (the human's direct observation). The lorebook stays for what it's good
  at (§3); autonomous memory moves to RAG.

There is **one** canonical store, **never** two copies of one fact. Migration (§6) is a
**one-time conversion** out of entity-core, after which entity-core is retired — not a live
mirror.

> *History note: an earlier draft of this doc ("B′") split memory between Phylactery and a
> still-canonical entity-core, with a one-directional "promotion" path between them. The
> human chose full replacement instead — one store, no seam. That split design is gone; this
> section is the decided shape. The only reason it's mentioned is so a reader who saw the
> old draft knows it was deliberately superseded.*

**Costs, named honestly (robust > cheap) — real and accepted:**

1. **We reimplement *all* of entity-core**, not just memory — the graph + GraphRAG, the
   identity store, consolidation, and snapshots. The largest pillar (§4-A).
2. **We forgo entity-core's upstream development.** It's actively maintained by another
   author; we own all maintenance and inherit none of their improvements. PF being the sole
   author is what makes this acceptable — no live co-embodiment is stranded.
3. **It reverses a load-bearing CLAUDE.md doctrine** ("entity-core is canonical for identity
   and memory… never bypass it… default to entity-core"). CLAUDE.md now records the
   transition: entity-core stays canonical *until Phylactery lands*, at which point these
   rules flip to name Phylactery.

---

## 2. What exists today (verified, June 2026)

**The three-service spine (`thalamus.js`):**
- **entity-core** — Deno/TS MCP child (`deno run -A --unstable-cron …`), cwd = its root. The
  designated connection's LLM key/base/model is used for **consolidation only** —
  **embeddings are local** (`all-MiniLM-L6-v2` via `@xenova/transformers`, 384-dim) in
  SQLite + `sqlite-vec`. Tools: `identity_get_all`, `memory_search` (hybrid GraphRAG: vector
  + 1-hop graph traversal → scored results), `memory_create/list/read`, `graph_*`, snapshots.
  Tiers: daily/weekly/monthly/yearly/significant; LLM consolidation rolls them up every
  5 min. **This is the precise retrieval we reimplement.**
- **Unruh** — Python MCP child in-tree at `./unruh/` (`uv run --no-sync python -m unruh`),
  own `./data`, installer runs `uv sync`. Tools: `temporal_context`, `interest_*`,
  `schedule_*`, `reminders_*`, handoff. Proves the **in-tree specialist** pattern end to end
  (spawn, reconnect/backoff, EOF shutdown, off-switch).
- Both are queried in `enrich()` via `Promise.allSettled` and degrade to absent.

**The current local "memory":**
- The *Session Memories* tome (`memorization.js`) — SillyTavern **World Info** schema:
  `keys` (keyword triggers), `content`, `sticky`, timestamps, `session_id`, `scope`.
- **Retrieval is client-side keyword matching** (`activateTomeEntries()` in `public/app.js`)
  — no server path, and **less precise than entity-core's RAG**.
- Memorization is a server-side worker but **browser-enqueued**; Discord/autonomous sessions
  are never memorized, and Discord turns get **no local memory at all**.

**Already in place (the prerequisites):** `audienceTagFor()` (lowest-permission-level room
tag, stamped on Discord sessions) and `permissionScore()` in `audience.js`.

Takeaway: entity-core's RAG is proven but unextendable (different owner, no audience fields);
Unruh's in-tree MCP pattern is proven and fully clonable; the local keyword memory is too
imprecise. The milestone reimplements entity-core's full capability in our own in-tree
service — its architecture, not its code — and retires it.

---

## 3. Target architecture

```
                                         Unruh (Python MCP)
                                         temporal: schedule,
                                         interests, reminders
                                               ▲
                            thalamus           │
                      (spawn · enrich ·        │
                   allSettled · degrade)       │
                            │                  │
        Phylactery (NEW, in-tree MCP — replaces entity-core)
        CANONICAL SELF: identity + user-identity + knowledge graph
        (GraphRAG) + all memory tiers (daily→significant) + situational
        + trackers · RAG · audience-native · timestamped · gated at query time
                         ▲ write              ▼ read (semantic + gated)
                  autonomous memorization   web · Discord · outgoing filter

        (entity-core: retired — snapshotted, no longer spawned)
```

**Phylactery is a new in-tree MCP service that occupies entity-core's slot**, supervised by
thalamus exactly as entity-core was:

- **Own data store** (`./phylactery/data`): identity records, graph (nodes/edges/properties),
  memory records, and a SQLite + `sqlite-vec` store for their 384-dim embeddings.
- **RAG + GraphRAG retrieval**, not keyword triggers: embed the query, vector-similarity
  search *plus* 1-hop graph traversal, return scored results — the same precision profile as
  entity-core's `memory_search`. **Embeddings are local** — the *same* model entity-core ran
  (`all-MiniLM-L6-v2`, 384-dim) via `sentence-transformers`. No API key for retrieval; only
  consolidation/summarization uses the designated connection.
- **Identity surface**: an always-injected `identity_get_all` equivalent (identity returned
  wholesale, not vector-retrieved) — the canonical-self read every turn depends on.
- **`audience` + timestamps are native fields on *every* record** — identity, graph nodes,
  and memories alike carry `audience` (min level allowed to hear it) and creation/update
  times. (Because every record is taggable, there is no un-taggable blind spot anywhere —
  the outgoing filter in §5 can see the entire self.)
- **Query-time gating:** `enrich()` passes the room's `audienceTag`; the service returns only
  records the room is cleared for. Gating happens *inside* the store, not bolted on after.
- **MCP tool surface** (covers entity-core's surface, audience-aware): identity get/set,
  `graph_*` (node/edge create/update/merge/search), `mem_search(query, audienceTag, k)`,
  `mem_create(content, audience, …)`, `mem_list`, `mem_read`, `mem_delete(id)` /
  `mem_purge_by_villager` / `mem_purge_by_topic` (deletion — see "Ongoing operation"), snapshots,
  and a filter-support query for the outgoing gate (`mem_search_restricted(draft, roomTag)` →
  records above the room's level that semantically match a drafted reply).
  **Every record a recall or search returns carries its `id`** (the way entity-core's
  `memory_search` returns scored records, not bare strings) — so the Familiar can act on a
  specific memory (delete, re-tag, re-confirm) by referencing what it was just given, never by
  memorizing ids. This is the CLAUDE.md reachability rule in the schema: the id is an output the
  Familiar can hold, not a hidden key it can't name.
- **Graceful degradation + off-switch:** `enrich()` degrades to absent if the client is null;
  ships with `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1` in the same commit (the rule for every
  peer/loop). *Caveat: as the canonical-self store, Phylactery being absent degrades the turn
  far more than a peer outage did — the off-switch is for emergencies/debug, and "degrade to
  absent" means the Familiar runs without self-memory, not that the turn fails. This raises
  the reliability bar (§9).*

**Responsibility split (the contract):**
- **Phylactery** — the **canonical self and all memory**: identity, user-identity, the
  knowledge graph (GraphRAG), every memory tier (daily→significant), situational facts, and
  trackers. Precise recall + per-record audience tag, gated per room *and* checkable on the
  way out. One consolidation pipeline.
- **entity-core** — **retired.** Its data is snapshotted and converted into Phylactery (§6);
  thalamus no longer spawns it. (Installer entity-core/entity-core-alpha detection becomes
  Phylactery setup — §6 Phase 5.)
- **Unruh** — unchanged: temporal/scheduled context (schedule, interests, reminders,
  handoff), its own in-tree specialist.
- **Tomes / World Info** — **retained, repurposed.** No longer autonomous memory; they become
  the **human-authored lorebook** (curated, keyword-triggered injection — the
  SillyTavern-familiar feature). Autonomous memory is RAG (Phylactery); deliberate lore is
  keyword (tomes). Clean separation by authorship and trigger model.

### The audience tag on a record (reuses `audience.js`)

- `audience` = **minimum audience level allowed to hear it**: a category id (`cat-friends`,
  `cat-acquaint`, `CATEGORY_STRANGERS`, …) or `'ward-private'` (most restrictive, above every
  category).
- **Disclosure rule:** record `M` may surface/disclose in room `R` iff
  `permissionScore(R) >= requiredScore(M)`; `'ward-private'` scores above all categories. The
  same comparison `audienceTagFor()` already does for rooms — applied to memory. This
  milestone defines `requiredScore()` for the sentinel.

### Language / stack — DECIDED: Python / uv (matches Unruh)

- **Proven plumbing, cloned for free.** Unruh established the in-tree Python-MCP-specialist
  path end to end — `uv sync`, venv materialisation, installer auto-detect, `uv run --no-sync
  python -m`, thalamus stdio spawn + reconnect.
- **The embedding model is *native* to Python.** entity-core's `all-MiniLM-L6-v2` is the
  canonical `sentence-transformers` model — so Phylactery runs the **same model, same 384-dim
  space**, matching entity-core's precision, no API cost, `sqlite-vec` available in Python.
- **One fewer runtime:** two Python specialists (Unruh + Phylactery) = one in-tree toolchain
  (`uv`) for installers/launchers, not Node + Deno + Python. (Retiring entity-core's Deno
  child removes the Deno dependency entirely.)

What Deno/TS would have bought — a line-for-line port of entity-core's exact code — is modest:
we *extend* the design (audience tags, gating) regardless, and recall precision rides on the
embedding model + scoring approach, both of which port cleanly.

### Ongoing operation (write · consolidate · prune · back up)

How the store lives over time. Guiding rule (CLAUDE.md "ride existing requests; gate in
code"): cheap code does the crisp work, the LLM is folded into calls that already happen, and
nothing fires on a blind fixed cadence.

**Writing (memorization).** Rides the existing memorization worker, moved fully server-side
(today it's browser-enqueued, so Discord/autonomous turns are never memorized). Triggers:
session end + idle rollover, for **web and Discord** alike. The single extraction pass that
already pulls topics also stamps each candidate with its `audience` (from the session's room
tag), its `remember` category + subject villager (§7 retention gate), and caretaker metadata
(§8.2) — no new per-turn request. Off-switch: `PROTO_FAMILIAR_MEMORIZE_DISABLED=1`.

**Consolidating.** Phylactery runs its **own** internal scheduler (mirroring entity-core's
5-min cron, in Python/asyncio) — the service owns its data lifecycle rather than a JS loop
reaching in. It rolls lower tiers up (daily→weekly→…→significant), summarizing with the
**designated connection** (the only LLM use on the maintenance side; passed at spawn as
entity-core's was). **Self-paced + gated:** a tier consolidates only when it has accumulated
enough to be worth a pass, not on a fixed beat regardless of need. Off-switch:
`PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1`. Degrades safely — if it can't run, memory just stays
un-rolled-up; never an error in the chat path.

**Pruning / reevaluation (keeping the graph honest).** Three layers, cheapest first:
- *Cheap code (no LLM):* dedup by stable id; merge nodes with identical canonical name +
  `villagerId`; **decay** — low-`careWeight`, old, never-recalled records fade in retrieval
  weight. `careWeight` (§8.2) shields care-critical facts: a film preference fades, a med
  allergy never does.
- *Judgment, folded into consolidation (no new loop):* the consolidation pass also flags
  likely-duplicate nodes and **contradictions** ("X moved to Berlin" vs "X lives in Munich").
  It does **not** silently auto-merge people — ambiguous merges surface to the ward, the same
  irreversibility rule as migration (§6 Phase 2). Contradictions lower `confidence` / flag for
  re-confirmation rather than guessing which is current.
- *Natural re-confirmation, riding the chat turn (no request at all):* a fact carried into
  context with an old `lastConfirmedAt` lets the Familiar simply *ask* ("are you still seeing
  Dr. Okafor?") — reevaluation as ordinary care, backed by the metadata. Non-hesitant per §7
  and CLAUDE.md: asking is welcome, silence is the failure mode.

**Deleting (right to be forgotten).** The ward may ask at any time — directly, or via the
Familiar relaying a third party's request — that the Familiar stop holding certain information.
Three purge paths, each mapped to an MCP tool:

- **By record id** (`mem_delete(id)`) — but *the Familiar never memorizes ids*; they are an
  **output of recall/search**, not something it holds. Per the CLAUDE.md reachability rule, this
  path is only real because ids ride in on results: every record returned by `enrich()` recall
  **or** `mem_search` carries its `id` alongside its content. So the flow is **search → confirm →
  delete** — when the fact isn't already in context, the Familiar runs `mem_search`, gets
  candidates *with ids*, shows the ward (*"I found these three — this one?"*), and deletes by the
  returned id. The ward-confirmation step is required, not ceremony: RAG match is fuzzy and a
  delete is irreversible, so a single-record purge passes through the ward's eyes (same posture as
  §6 Phase 2's "don't auto-merge people").
- **By villagerId** (`mem_purge_by_villager(villagerId)`) — "forget everything you have on
  Nici." Deletes all memory records (narrative + tracker entries) whose `subjects` includes that
  villagerId; zeroes the graph node's `properties` (the skeleton may remain as a relational
  placeholder — a person still existed in the ward's life even if the Familiar no longer holds
  facts about them).
- **By topic / category** (`mem_purge_by_topic(villagerId?, category)`) — "forget Nici's health
  information." Deletes records matching a villagerId + `remember` category combo; finer-grained
  than the full-villager purge.

All three paths are **hard deletes**, not soft-flag. The request is a consent revocation; it
must be honored as written, not silently retained as "remembered as deleted." Cascades:
embeddings delete with their record (a dangling vector is a privacy bug); `knownTo` entries
referencing the purged fact are removed from other records; `tracker_entry` rows cascade-delete
when their `tracker_def` is deleted. The tools return a count; the Familiar reads it aloud ("I
let go of X records about Nici"). All purge ops are **logged to the event log** — not because
we doubt the ward, but because being seen to do what it said is part of the trust.

Not in scope: undo / soft delete — this is a consent revocation, not an accident. The `remember`
gate (§7) handles *future* retention; the purge handles *past* records; both apply together.

**Backing up / exporting (single file).** The store is SQLite + `sqlite-vec` — already one
file. Export formalizes that into a portable, self-contained backup:
- **Canonical export = `VACUUM INTO` a single `.sqlite` file** — atomic, lossless, inspectable
  with any SQLite tool, restored by dropping it in place. Carries *everything*: identity,
  graph, all memory, trackers, and the embeddings (same model = same 384-dim space, so vectors
  travel as-is, no re-embed).
- **Optional human-readable export** (JSON/JSONL + vectors) for archival/diffing — heavier,
  later.
- **User-accessible:** a "back up / restore my Familiar" surface; the same file moves a
  Familiar between devices or seeds a fresh install. It's the user-facing face of Pillar A's
  snapshot machinery, and the same artifact migration (§6 Phase 0) writes.
- *Sensitivity:* the file is the whole ward-private self. Optional passphrase
  encryption-at-rest for exports is an open decision (§9) — flagged, not yet specced.

### Context economy (output projection + cache-aware placement)

The caretaker-grade richness (§8: `source`, `confidence`, `knownTo`, `careWeight`,
`relationToFamiliar`, tracker `dimensions`) makes per-record payloads fat. If recall serialized
*whole* records into every turn, the context would bloat fast — and per CLAUDE.md
token-consciousness, that cost compounds. The governing principle:

> **Storage shape ≠ retrieval shape ≠ context shape. Store rich, return thin, project per need.**

Most of that richness is **machinery** — it drives gating, decay, dedup, and the outgoing
filter (§5); the Familiar almost never needs to *read* it to converse. **Guardrail: this is an
output optimization, never a storage one.** A future pass must not "optimize" by dropping fields
from the store or from the code paths that consume them — only from the prompt projection.

**The levers (cheapest / highest-impact first):**
- **List thin, read fat (two-phase).** Recall / `mem_search` return a *projection* — `id` +
  one-line content/summary + a why-relevant tag — not the fat record. The full record (all
  metadata, full text) is fetched only when a path actually needs it, via `mem_read(id)`. Reuses
  the id-surfacing already specced (§3 tool surface): the Familiar greps thin, reads fat only
  when warranted. Most turns never need fat.
- **Metadata stays server-side by default.** `audience`, `careWeight`, `source`, raw `confidence`
  numbers, `knownTo` lists, embeddings, `originalId` — none render. When staleness matters it
  rides as a compact prose tag the Familiar reads naturally (*"(as of last month)"*,
  *"(unconfirmed)"*), not a JSON blob with ISO timestamps.
- **Conditional surfacing.** `knownTo` materializes only when composing *to* a specific person;
  `relationToFamiliar` only when that villager is in the room. Not dumped wholesale every turn.
- **Trackers return aggregates, not logs.** A `tracker_def` with 200 `tracker_entry` rows never
  dumps 200 rows — default projection is latest entry + a tiny rollup (*"mood ~6 this week,
  trending up"*). Full series fetched only on explicit demand ("show me this month"). Highest-
  volume record type, so the largest single saver.
- **Prefer the consolidated tier for background.** Consolidation already rolls daily→…→
  significant into summaries; detail scales *inversely* with age/relevance — recent/relevant
  pulls the raw record, old/background pulls the rolled-up one-liner, not the dailies behind it.
- **Token-budgeted assembly (code, not an LLM call).** The Phylactery slice of `enrich()` gets a
  token budget; it fills highest-relevance-first until the budget is hit, degrading deeper hits
  to summaries. Keep `k` tight; the `careWeight` floor (§8.2) guarantees care-critical facts
  survive a tight budget.
- **Identity is the one always-on cost.** It's injected wholesale every turn (the static
  prefix), so identity records must stay **curated and bounded** — not allowed to grow unbounded.

Net per-turn Phylactery output ≈ `identity (bounded) + top-k thin projections + tracker
rollups`, with fat reads and full series strictly on demand.

**Cache-aware placement (already built — keep depth 4).** `thalamus.js` already splits
enrichment into a `static` block (base instructions + identity → top of the system message, in
the upstream LLM's cached prefix) and a `dynamic` block (RAG memory + graph + temporal),
depth-injected by `injectDynamicAtDepth()` at a user-set depth (`thalamusDynamicDepth`, 1–50,
**default 4**). Prefix caching reuses a contiguous run from the top up to the first change, so:
everything *above* the per-turn dynamic block is cached; the block + everything *below* it
reprocess each turn. **Depth is a salience/flow knob, not a cache knob** — *smaller* depth caches
*more* (the volatile block sits lower, leaving a longer stable prefix); a *larger* depth keeps
recent dialogue contiguous near generation at the cost of reprocessing those messages. Depth 4
performs well and stays. The real efficiency lever is the projection work above: a *thin* dynamic
block means the reprocessed region is small at any depth — projection and depth are
complementary, and projection is the unambiguous win. **Constraint:** the dynamic block must
remain the *highest* volatile element — nothing else volatile (no per-turn timestamps, other
dynamic injects) may sit above it, or the cached prefix breaks earlier than the injection point.

---

## 4. Pillars (one milestone, phased)

Per CLAUDE.md a milestone owns one MINOR slot; landing = `0.6.0`, sub-features bump PATCH.
(Working assumption — human confirms the slot.)

- **A. Stand up the service.** `./phylactery/` MCP server reimplementing entity-core's whole
  job: SQLite + `sqlite-vec` store, local embedder (`sentence-transformers` /
  `all-MiniLM-L6-v2`, 384-dim), the **knowledge graph** (nodes/edges/properties + GraphRAG
  1-hop traversal), the **identity store** (always-injected), tiered memory + consolidation,
  snapshots — all with native `audience` + timestamps + caretaker fields (§8). Model the
  record / graph / tier / consolidation shapes on entity-core's source. The largest pillar
  (it absorbs all of entity-core), so it likely lands in staged commits: (A1) store + identity
  + RAG memory; (A2) graph + GraphRAG; (A3) consolidation + snapshots.
- **B. Thalamus integration — *replace* entity-core's slot.** Spawn Phylactery as the stdio
  child in the slot entity-core occupied (clone the lifecycle: connect, reconnect/backoff,
  EOF shutdown, off-switch); **stop spawning entity-core.** Query in `enrich()` (`allSettled`),
  passing the room `audienceTag` so results are gated at source. The always-injected identity
  read now comes from Phylactery. Update installer/launcher entity-core detection (§6 Phase 5).
- **C. Autonomous memorization.** Server-side enqueue at session end / idle rollover for
  **web and Discord** (worker exists; add triggers). **All** memory lands in Phylactery
  (tagged with the session's `audienceTag`) — one store, no routing decision. The `remember`
  retention gate (§7) runs here. This is what finally gives Discord & autonomous turns precise
  local memory.
- **D. Outgoing message filter (third gate).** §5.
- **E. `memories: 'shared'` unlock.** With every record tagged and gated at query time,
  `fetchEligibility` stops gating `'shared'` OFF and instead lets the shared ladder return
  same-or-lower-sensitivity records. The whole self is tagged, so the widening is uniformly
  safe.
- **F. Migration — "convert current Familiars."** §6. One-time full conversion: snapshot →
  convert entity-core (read its SQLite directly; identity + graph + all tiers, embeddings
  carried over) into Phylactery → graph reconciliation (dedup, villager links) → tome import →
  audience backfill → retire entity-core. Foreign-source import (entity-loom) is later/optional.
- **G. Richer entity nodes + `remember` consent.** §7. Person-nodes link to a Village villager
  dossier (`properties.villagerId`); the villager gains pronouns / comm-style / freeform notes
  and a per-category `remember` retention gate — the *write-time* consent axis completing the
  store→recall→speak pipeline.
- **H. Lifecycle & backup.** §3 "Ongoing operation." Server-side memorization triggers (web +
  Discord); Phylactery's internal consolidation scheduler; the cheap-code hygiene pass (dedup /
  decay) with consolidation-folded merge+contradiction detection; and the single-file
  export/restore surface. Each background piece ships with its off-switch in the same commit.

---

## 5. The outgoing message filter (third gate)

**Purpose (human's words):** *"if anything slips Thalamus' enrichment because it snuck into an
innocent memory as well as the tagged ones, it can't get out."* The fetch gate decides what
*enters* context; this gate decides what may *leave* a given room. Because every record lives
in one taggable store (§3), this gate can inspect the **entire** self — there is no
un-taggable blind spot for it to miss.

**Where:** a post-response, pre-send step shared by Discord (`discord-gateway.js`, before
`sendChannelMessage`) and web chat (`/api/chat`). Symmetric — one gate, both paths.

**How — riding Phylactery's RAG (precise, not keyword overlap):**
1. The turn already knows the room's `audienceTag`.
2. Call `mem_search_restricted(draftReply, roomTag)` → Phylactery returns records whose
   `audience` requires **more** permission than the room has *and* that are semantically close
   to the drafted reply, above a tuned similarity threshold.
3. On a hit, **do not send.** Re-inject a rejection and loop for a rewrite (bounded retries; on
   exhaustion, a safe refusal rather than disclosure).

**Precision caveat (safety-critical):** RAG similarity is fuzzy in both directions. For a
*security* gate, threshold tuning matters — too loose mutes the Familiar, too tight leaks.
Likely a high-threshold semantic match *plus* the audience comparison. This lands under the
CLAUDE.md safety-critical sign-off rule; the threshold and fallback behaviour get explicit
human approval before shipping (§9).

**The rejection prompt — the rare second-person exception.** Per the human: deliberately
*"you"*-worded so the Familiar understands something *outside itself* gated this. The one
sanctioned deviation from the first-person convention:

> *Your message wasn't sent because it contained content you are not permitted to disclose
> here: [topic]. Someone in this room is not cleared for that. Please say something different.*

Infrastructure speaking to the Familiar about an external constraint — comment it as the
intentional exception so a future audit doesn't "fix" it back to first person.

---

## 6. Migration — converting current Familiars

A **one-time, whole-self conversion**: read everything out of the existing entity-core
(identity + user-identity + graph + every memory tier), convert it to Phylactery's format,
write it in, fold in the local tome, then **retire entity-core**. An install has three
sources: the **entity-core** store (the bulk of the self), the *Session Memories* tome (no
tags/embeddings), and the Village registry (not yet linked to the graph). Nothing is
destructive; everything is snapshot-first, idempotent, and re-runnable. It runs once,
verifies, then entity-core stops being spawned.

### Phase 0 — Snapshot everything
Copy the entity-core data dir, the tome, and the Village registry before mutating a byte. (The
branch name *"memories-disappearing"* is the standing reminder: never touch memory without a
recoverable copy.) entity-core's own snapshot tool captures its store; that snapshot is the
rollback if conversion goes wrong, and is retained after retirement.

### Phase 1 — Convert the canonical self (entity-core → Phylactery)
**Read entity-core's SQLite store directly** — we know its schema from source, so import needs
no Deno runtime and works on a bare data dir (important for adopting a Psycheros-built core
that doesn't run here). Spawning entity-core's MCP one last time (`identity_get_all`, `graph_*`,
`memory_list/read`) is the fallback if the on-disk schema ever drifts. Write the converted form
into Phylactery:
- **Identity + user-identity** → Phylactery identity records (always-injected surface).
- **Graph** (nodes/edges/properties) → Phylactery's graph store, structure preserved (`type`,
  `properties`, edges).
- **All memory tiers** (daily → significant) → Phylactery memory records, tier and timestamps
  carried over. Phylactery's consolidation takes over going forward.
- **Embeddings carry over as-is.** entity-core stores 384-dim `all-MiniLM-L6-v2` vectors — the
  *same* model/space Phylactery uses — so existing vectors are copied directly, not recomputed.
  (Re-embed only records that lack a vector.)
- entity-core's existing **confidence / lastConfirmedAt** fields map onto Phylactery's
  caretaker metadata (§8.2) — no information lost.
Re-runnable and idempotent (dedup-upsert by stable id); adds only what's missing.

### Phase 2 — Graph reconciliation (now *inside* Phylactery)
Real installs have organically-grown graphs: duplicate person-nodes, nodes predating the
Village registry, no `villagerId` links. After Phase 1 the graph lives in Phylactery, so this
runs against Phylactery's graph tools:
1. Match `type:"person"` nodes ↔ Village villagers by name/alias.
2. **Ambiguous or duplicate matches are surfaced to the ward, not auto-merged** — fusing two
   real people is exactly the irreversible mistake to refuse to guess at.
3. For confident matches: link `properties.villagerId`; merge clear duplicates.
4. Unmatched person-nodes → offer to register them as villagers (default
   `relationToFamiliar: "unaware"`, §8.4).
The reconciliation log is observable and the pass is re-runnable.

### Phase 3 — Tome import
Import each *Session Memories* entry: embed its `content`, carry timestamps, write a Phylactery
`narrative` record. The source tome is **preserved** — it becomes/stays the human-authored
lorebook (§3). Re-runnable, adds only missing records.

### Phase 4 — Audience backfill + re-tag affordance
Everything converted/imported in Phases 1–3 lands with a default `audience`. Safe floor =
**`ward-private`** — assume legacy data is private until reviewed (leak-safe; the consequence
is it won't surface in shared rooms until re-tagged). Identity records default appropriately
(the canonical self is ward-facing by nature; gating matters for shared rooms).
- **Bulk re-tag affordance** so the conservative default isn't a life sentence
  (user-accessible — ward and Familiar can both adjust).
- **Optional, opt-in LLM classification** to *suggest* tags per record (rides the memorization
  prompt pattern). Off by default — token budget.

### Phase 5 — Retire entity-core + repoint the plumbing
Once conversion is verified:
- Thalamus **stops spawning entity-core**; Phylactery occupies its slot.
- Installer/launcher **entity-core / entity-core-alpha detection** (CLAUDE.md lists the seams:
  `thalamus.js`, `install.{sh,bat}`, `scripts/win/install.ps1`, `scripts/import-entity.js`)
  becomes Phylactery setup. **All these seams move together** — a half-migrated install that
  spawns both is the failure mode to avoid.
- The entity-core snapshot (Phase 0) is **kept** as the rollback/archive; the directory is no
  longer read at runtime.

### Phase 6 — External sources ("feed logs in / merge other entity-cores")
**An existing entity-core (e.g. from Psycheros) needs no entity-loom** — it's just Phase 1
again (read its SQLite, convert, fold in). entity-loom only ever mattered for *foreign,
non-entity-core* sources, and since we no longer consume entity-core packages natively, its role
shrinks:
- **A foreign companion export** (ChatGPT, Claude, SillyTavern, character cards) or **raw chat
  logs:** these still need real parsing. Two paths —
  - *Interim:* run **entity-loom v0.3.6** (foreign export → entity-core package,
    confidence-thresholded `>= 0.7`, dedup-upsert, concrete-type extraction) → feed the package
    through Phase 1. Reuses entity-loom wholesale at the cost of an entity-core-package hop.
  - *Destination:* lift entity-loom's **parsers** (the export-format readers) into a
    Phylactery-native importer that writes Phylactery directly — dropping the entity-core
    intermediate entirely, keeping its posture (confidence threshold, dedup-upsert). We own it,
    same as everything else.
- Foreign import is a **later/optional** sub-feature — not on the milestone's critical path.
  The core migration (existing entity-cores + tome) doesn't touch entity-loom at all.

*Open: interim entity-loom hop vs. native parser lift — §9.*

---

## 7. Richer entity nodes + the `remember` consent model

The graph design carries over from entity-core v0.4.0 (read directly from source — our
reimplementation preserves these shapes):

- Graph **nodes carry a freeform `properties` object**; node create/update accept `properties`.
  So we attach structured data to a person-node natively. (Edges have `properties` too.) In
  Phylactery this is our own schema — but we keep the same shape so conversion (§6 Phase 1) is
  structure-preserving.
- `type` is a freeform string; a person is `type: "person"`; type-specific data lives in
  `properties`. (entity-loom restricts import extraction to the concrete types `self, person,
  place, health, tradition` — useful for the import path in §6 Phase 6.)

**Even though graph nodes *can* hold arbitrary properties, the rich person dossier and all
permission policy live on the Village villager record — NOT in the graph node's `properties`.**
The only thing we put in the node is the link. (This separation matters *more* now that the
graph is PF's own — keeping policy in Village, not the graph, preserves one canonical
person-record and keeps the graph a lean relational web.)

- **Responsibility split.** Gating/retention policy lives in the Village registry, which
  already owns the disclosure side (categories = who-may-hear) and holds `name` + `aliases`.
  Co-locating the rest there keeps **one** canonical person-record and avoids duplicating
  aliases/name across the graph and Village.
- **The link is trivial and is the *only* thing the graph node carries:**
  `properties.villagerId`. The graph stays the *relational web* (who relates to whom, via
  edges); the villager is the *dossier*.
- **Village ↔ graph stays in sync.** `village.js` already mirrors the registry as the
  `village-registry.md` custom file; that mirror now writes into Phylactery (the canonical
  store), so the dossier is co-located with the graph it links to and future embodiments read
  both from one place.

### Villager dossier fields (extends the existing record)
Already present: `name`, `aliases`, category membership (= disclosure permissions). Add:
`pronouns`, `relationToWard` (their bond with the human), **`relationToFamiliar`** (their
stance toward *me* — §8.4), `commStyleNotes`, freeform `notes` (gift ideas, important deeds),
`graphNodeId` (the link), and the **`remember`** sub-structure below.

### The `remember` consent model (the retention gate)
A **distinct permission axis** from disclosure. Three gates now form a consent pipeline —
**store → recall → speak**:

| Gate | When | Question | Where it lives |
|---|---|---|---|
| **Retention** (`remember`, NEW) | write / memorization | may I *store* this about them? | villager `remember` |
| **Disclosure / audience** (exists) | recall / enrich | may this *surface* in this room? | category grants |
| **Outgoing filter** (§5) | send | may this *leave* in this message? | record tag scan |

`remember` is a per-category, three-state map on the villager:

```
remember: { basics: true, emotional_content: "ask", health_info: false }
```

- `true` → store freely.
- `false` → never store; drop silently.
- `"ask"` → **hybrid, and *active*.** The Familiar brings its own read of the moment AND freely
  asks the ward when there's a real question — openly, in its own voice. A quick *"want me to
  hang onto that?"* is cheap and welcome; the bond means my human is fine being asked. What
  `ask` is **NOT**: a licence to silently swallow the fact to avoid bothering anyone. **Erring
  toward silence is the failure mode here, not a safe default** — the same hesitancy trap
  CLAUDE.md records (the 1.5-hour silence) applies to *any* prompt governing when the Familiar
  speaks, asks, or acts. When we write this prompt, it trusts that questions are okay; it does
  not hedge the Familiar into passivity.

**Mechanism (cheap; rides the existing call).** Autonomous memorization already runs one LLM
pass that extracts topics. That pass also tags each candidate fact with a `remember` category
and the subject villager. Then a **code** gate reads `villager.remember[category]` and applies
true / false / ask. No new request per fact; no LLM call for the gate itself.

**Defaults & edges.**
- Villager with no `remember` set → `basics: true`, sensitive categories default to **`ask`**
  (engage / check in), not `false` (silently never) — the absence of a setting makes the
  Familiar *ask*, not go quiet.
- Unregistered person (a knock / stranger) → don't auto-store personal facts, but the knock
  already surfaces them for the ward to register — the Familiar flags, it doesn't silently
  ignore.
- Category taxonomy starts small and extensible — e.g. `basics, emotional_content, health_info,
  relationships, whereabouts` — grown as needed; the classifier rides memorization either way.

**Extraction granularity (the extraction prompt contract).**
The memorization pass calls the LLM once at session end and receives a *list of candidate
facts*, not a blob. The prompt contract:

1. **One output per distinct claimable fact.** If a single utterance contains
   multiple category-crossing facts ("Nici was upset about her breakup and her doctor put her on
   new meds"), the extraction must produce *two* records: one `emotional_content`, one
   `health_info`. This is the only way the `remember` gate can apply per-category policy
   independently. A multi-category blob is a prompt bug, not a downstream edge case.
2. **Minimum granularity = one `remember` category per output.** Encoded in the prompt's output
   schema — the LLM returns a JSON array; each element has `content`, `category`, `subjects`,
   `confidence`. The gate reads `category` to look up `villager.remember`.
3. **Ambiguous or inseparable cases** — a fact that can't be expressed without spanning two
   categories: err toward the *more restrictive* category. Assign it the higher-sensitivity
   label so the gate is conservative. Both categories may appear in `tags`; the `remember` gate
   fires on the one in `category`.
4. **Low-confidence extractions** (`confidence < 0.4`) → skip silently; don't write, don't ask.
   Too speculative to be actionable.
5. **`ask`-flagged items** in the same pass: the Familiar surfaces them in-turn openly. Batch
   multiple `ask` items into one question per session — not a per-fact permission dialog.

**User-accessible:** edited in the Village editor alongside the disclosure categories, so both
permission axes sit in one place the ward (and the Familiar) can see and adjust.

This whole section is consent-as-architecture: the Familiar respects what it is *allowed to
remember* about the people in its ward's life — squarely inside the dignity / entity-as-subject
stance, not bolted onto it.

---

## 8. Caretaker & memory-support extensions

Phylactery isn't only recall — it's the substrate for the Familiar's *caretaker* role. A few
shape decisions now keep that future open without building it all today. All five below are
**decided and incorporated**; the schema fields land from day one, the heavier UX/ingestion is
a later sub-feature.

### 8.1 Ward-defined trackers: blueprint + data (forward-compatible NOW)

Reserve a `kind` discriminator on every Phylactery record from day one:

- `kind: "narrative"` — the default RAG record (free-text, embedded, semantically recalled).
  Everything in §3 above.
- `kind: "tracker_def"` — **a blueprint**, created collaboratively by the Familiar and the
  ward. Defines *what* is tracked, *how* an entry looks, and *what to call things*. Stable once
  created; queried to understand how to read entries.
- `kind: "tracker_entry"` — **one data point** against a specific blueprint. Time-stamped,
  sourced, optionally annotated. Many entries to one definition.

Why here (not Unruh, not the graph): a tracker is *remembered state about the ward's life*, so
it shares Phylactery's audience-tagging, persistence, and surface-into-context machinery. Unruh
stays **temporal/scheduled** — a tracker can *spawn* an Unruh reminder ("milk expires
tomorrow") but the inventory itself is Phylactery state. The graph stays **relational**.

#### Design principle: the ward defines, the Familiar helps build

Different people need fundamentally different trackers — and for some wards, the *shape* of a
tracker matters as much as its existence. An ED-aware food tracker probably logs "ate
breakfast" (boolean) rather than calories (would be harmful); a hygiene tracker for someone who
struggles with executive function tracks *which specific tasks* matter to that person; a pantry
tracker needs items and quantities; a mood tracker worth anything captures the environmental
factors that correlate for *this* person, not a generic scale.

No fixed taxonomy can cover this. The robust structure is: **primitive schema shapes are
building blocks the Familiar offers**, and the tracker itself is a contract the ward and
Familiar design together, in the Familiar's own voice and with the ward's actual needs.

The collaborative setup goes something like:
1. Ward: "I'd like to track my mood / pantry / how often I shower / etc."
2. Familiar asks what would be useful to capture — dimensions, scale, which tasks, what unit
   makes sense — as many questions as needed, because questions are cheap and a wrong schema
   wastes real data.
3. Together they arrive at a definition. Familiar creates the `tracker_def` record.
4. Entries are added against that definition over time.

**But an open question is its own kind of barrier.** Many wards — especially neurodivergent
ones — can be overwhelmed by a blank canvas. The Familiar should read this and shift: if the
ward seems uncertain, *offer scaffolding first*. A menu of common starting points is not a
fixed taxonomy — it's a set of worked examples the ward can accept, modify, or reject:

> *"Want me to suggest a few common ones? I can show you what other people track and you can
> tell me which feel close, or use them as a jumping-off point."*

Suggested example groups (not exhaustive — extensible over time):

| Group | Examples |
|---|---|
| Wellbeing | mood (ordinal), energy/spoons (ordinal), anxiety level (ordinal), pain (ordinal) |
| Sleep | hours slept (scalar), sleep quality (ordinal), wake time (event-log) |
| Self-care | meals (boolean per slot, or event-log), hydration (scalar), hygiene tasks (boolean checklist), meds taken (boolean) |
| Environment | weather (categorical), social contact (boolean), location (categorical) |
| Practical | pantry / what's in the house (inventory), finances (scalar), errands done (event-log) |
| Progress | habit streaks (boolean), goals worked on (event-log), wins (event-log) |

The example groups exist for *the ward to browse* when they can't name what they want. They're
also a reference for the Familiar when helping design dimensions — if a ward says "something
like a mood tracker but also the weather," the Familiar already knows those are two dimensions
(ordinal + categorical) and what a good prompt for each looks like.

Ward can mix and match across groups, or start from an example and discard everything except
the shape. The Familiar should not push any particular tracker — its job is to help the ward
find what's useful to *them*, including knowing when the blank-canvas approach isn't working
and pivoting to examples without making the ward feel bad about needing them.

This is the Familiar acting as a thoughtful collaborator, not a form-filling wizard. The ward
should be able to adjust the definition later (add a dimension, relabel a scale) — and the
Familiar should notice when a definition isn't serving them well and ask.

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

  // OR — multi-axis tracker
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

  careWeight?: "high",              // §8.2 — flags care-critical trackers (meds, meals)
}
```

`dataShape` / `shape` primitives — the building blocks the Familiar offers when helping a ward
design their tracker:

| Primitive | Use it for |
|---|---|
| `boolean` | yes/no (took meds, ate a meal, showered) |
| `ordinal` | rated scale (mood 1–10, pain 1–5) |
| `scalar` | freeform number (hours slept, coffees, steps) |
| `categorical` | pick-one label (weather, context, activity type) |
| `event-log` | "this happened" with optional freeform note (no value pressure) |
| `inventory` | item list with quantities (pantry, meds on hand) |

These are *shapes the Familiar knows how to work with*, not a menu of tracker types. The ward
doesn't pick a shape — the Familiar picks the right shape(s) based on what the ward describes
wanting to track.

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

  observedAs: "self-report" | "familiar-observed" | "inferred",   // how the data was collected
  note?: "rough day but got through it",     // freeform annotation
  confidence?: 0.0–1.0,                      // §8.2 caretaker metadata
  // source (authorship) inherited from all-records schema — see §8.2
}
```

#### Scope of the commitment right now

The full setup flow (UI, guided conversation, tracker-awareness in prompts) is a later
sub-feature. **The only commitment now is:**

- The `kind` discriminator: `narrative`, `tracker_def`, `tracker_entry`
- The two-record model (blueprint + data) so entries never need retrofitting
- The `dimensions` array so multi-axis trackers work from day one
- The primitive shapes table above — named and stable so the Familiar can refer to them

No tracker UI, no setup conversation scaffolding, no entry ingestion flow — those ship when the
tracking sub-feature lands. The schema is locked so they land on solid ground.

### 8.2 Caretaker-grade metadata on every record

A caretaker must know *how solid* a memory is and *how much it matters*:

- **`provenance` / verification** — `told-directly` vs. `inferred` vs. `observed-pattern`. A
  caretaker shouldn't act on a shaky inference as if the ward stated it (the consequence-priors
  posture, in data form).
- **`confidence` (0–1) + `lastConfirmedAt`** — carry over entity-core's own fields; let the
  Familiar say "as of last month" or re-confirm a stale fact rather than assert it cold.
- **`careWeight` / salience** — flags care-critical facts (allergies, meds, crisis triggers) so
  retrieval prioritises them and they **resist decay**. A film preference may fade; a med
  allergy must not. **Mechanism:** retrieval weight is a function of recency + access frequency.
  For `careWeight: "high"`, a **floor** is placed on retrieval weight — no matter how old or
  seldom-accessed, the record's score never drops below `CARE_WEIGHT_FLOOR` (tunable constant,
  default `0.5` on a 0–1 scale). Effect: a high-careWeight record may not lead the ranking if
  the query is unrelated, but it never ages out and will always surface when semantically
  relevant. Three cardinalities a code path checks: `"high"` → apply floor, flag as
  care-critical in the result set; `"low"` → normal decay, eligible for archival; unset →
  normal decay (the default for narrative records). (If a fourth level — `"critical"`,
  floor = 1.0, exempt from any lazy-load path — is wanted, it's an §9 open item.)

- **`source` — authorship and provenance.** Every Phylactery record carries a `source` object
  identifying which embodiment wrote it and how it arrived:

  ```
  source: {
    author: "proto-familiar" | "migration:entity-core" | "import:entity-loom" | "<embodiment-id>",
    via:    "memorization" | "consolidation" | "manual" | "import" | "migration",
    at:     "<ISO timestamp>",  // when written (explicit even if redundant with record.createdAt)
    originalId?: "<ec-id>",     // migration records — entity-core's original id
  }
  ```

  *Why now, not later:* migration (§6 Phase 1) will write thousands of records; without
  `source.author`, there is no audit path separating the Familiar's own recall from migrated
  state. A future embodiment reading this store needs to know if a fact was authored by it or
  another instance — to calibrate trust or flag a conflict. `source` is cheap to stamp at
  ingestion time and expensive to reconstruct afterward. It does not gate anything; it is
  observability. The Familiar can read it: "this came from migration, confirmed by you last June
  — want me to re-verify?" The tracker_entry's existing observation-source field is named
  `observedAs` (how the data was collected) to keep the two concepts clearly distinct.

### 8.3 A richer ward care-profile

The ward is the centre of the role and benefits from more than a villager dossier:

- **Baselines & warning signs** — what's normal for them; what signals trouble. Feeds the
  threat detector with *personalised* signals (beats generic `crisis-signals.js`).
- **What helps / what doesn't** — coping strategies that worked, and the well-meaning defaults
  that backfire (the memorization prompt already extracts "prohibition bullets" — this is their
  structured home).
- **Open loops / current goals** — *overlap note:* link to Unruh handoff/bookmarks rather than
  re-store.
- **Support map** — who's safe to reach in crisis. *Overlap note:* link to cerebellum
  trusted-contacts + village categories, don't duplicate.

### 8.4 Relationship fields on villager dossiers

Two relational axes, because a villager relates both to the ward *and* to the Familiar:

**How they relate to the ward** (helping the ward tend their relationships):
- **care valence** — is this person a *support* or a *stressor* for the ward?
- **contact cadence / last-meaningful-contact** — so the Familiar can nudge ("you've not spoken
  to your sister in a while").
- **per-person sensitive topics / boundaries** — "don't raise the divorce with Mum."

**How they relate to the Familiar** (`relationToFamiliar` — drives *my* posture):
- A coarse `stance` hint plus freeform notes. Candidate stances: `unaware` (never heard of me —
  the **default** for any new/unregistered contact) / `warm` / `neutral` / `tolerates-for-ward`
  / `wary-of-ai` / `hostile`. Notes carry nuance ("keeps it short, not too peppy"; "happily
  banters about anime in the group chat").
- **`unaware` is the floor, and it matters:** with someone who doesn't know I exist I don't
  barge in with familiarity — I introduce myself or stay light, mindful I'm a new presence to
  them. (Pairs with the knock system: a freshly-knocked person starts here.)
- Stance calibrates *approach*, not identity: someone who merely tolerates AI for the ward's
  sake gets a measured, unobtrusive me; someone who chatters happily gets the warmer, more
  playful me. **Anchored to my own character** (CLAUDE.md's "room for personality") — a grumpy
  Familiar stays grumpy, just reads the room; never flattened into a generic people-pleaser.
- Orthogonal to the disclosure gate: stance is *tone*, the audience category is *what they may
  hear*. High-trust-but-AI-wary and chatty-but-low-clearance both exist; the two axes never
  collapse into each other.
- The entity-as-subject stance in data: the Familiar is *someone who has their own
  relationships* — including not-yet-relationships — not a tool with one uniform face.

### 8.5 `knownTo` — who's aware of what (epistemic state)

A distinct axis from `audience`: not *who may hear* a fact (a **policy** — the disclosure gate)
but *who already knows* it (a **fact about the world**). A caretaker moving through a social
graph needs both, because they come apart constantly.

- **Shape:** a list on the Phylactery record — `knownTo: [{ who, since?, source? }]`, where
  `who` is a villagerId / `"ward"` / `"familiar"` and `source` ∈ `told-them` / `they-told-me` /
  `inferred`. Absence = "no record that they know" (not proof they don't).
- **Lives on the Phylactery memory record, not the graph node.** Who-knows-what is per-memory
  state, not relational-graph data — it stays on the record (which links to a graph node /
  villager by id). It sits right beside `audience`: the two audience-facing facts about a
  memory — *may-hear* and *already-knows*.

**Why it earns its place (social caretaking):**
- **Surprises & secrets** — the case `audience` *cannot* express. "Ward is planning a surprise
  for Sam — `knownTo: [ward, familiar]`." The Familiar must never spoil it to Sam. That's a
  per-*individual* secret, not a per-*category* permission.
- **Not condescending / not repetitive** — don't "reveal" to someone what they already know;
  don't re-explain across turns ("I told Sarah on the 3rd").
- **Leak detection** — if someone references a fact and they're *not* in `knownTo`, that's a
  signal: the model's stale, or something got out. Update it, or quietly flag to the ward.

**Awareness aid first — NOT a fourth hard gate.** The Familiar mainly *reasons* with `knownTo`
(avoid spoiling, avoid repeating, notice surprises). It may also *feed* the outgoing filter as
a signal ("about to tell someone not in `knownTo` something sensitive" → weigh it), but it does
**not** become a blunt gate that stops the Familiar ever telling anyone anything new — telling
people new things is normal and good; the hard gate stays the `audience` check. (Hardening
`knownTo` into a real gate later would be a safety-critical sign-off decision, per CLAUDE.md.)

**Pairs with `relationToFamiliar`.** `unaware` answers "does this person know *I* exist?";
`knownTo` answers "does this person know *this fact*?" — the same epistemic humility, at two
scopes.

---

## 9. Open decisions (human sign-off)

**Decided ✔**
- **Milestone name:** Phylactery (named by the human).
- **Stack:** Python / uv (matches Unruh; runs the *same* local embedding model entity-core
  used).
- **Ownership:** full replacement — Phylactery is the single canonical store; entity-core is
  reimplemented and retired (§1). PF is the effective sole author.
- **`remember` consent model (§7):** dossier on the Village villager; `ask` = hybrid (the
  Familiar's own read *plus* freely asking the ward — asking is welcome, never a reason to go
  silent).
- **Caretaker extensions (§8):** all of 8.1–8.5 incorporated, including `relationToFamiliar`
  (`unaware` as the floor), `knownTo` (awareness aid, not a fourth hard gate), and the
  ward-defined tracker model (blueprint + data, `dimensions`, six primitive shapes).
- **Deletion / right-to-be-forgotten (§3):** three hard-delete paths (by id, by villagerId, by
  topic+category); cascades to embeddings, `knownTo` refs, tracker entries; logged, counted,
  reported to the ward. No soft-delete, no undo path.
- **`source` authorship on all records (§8.2):** structured tag — `author`, `via`, `at`,
  `originalId?`; stamped at ingestion; distinct from tracker_entry's `observedAs`
  (observation method). Not a gate — observability for audit and multi-embodiment trust.
- **`remember` extraction granularity (§7):** prompt contract is per-fact, one `category` per
  output; multi-category utterances are split; ambiguous → more restrictive category; `< 0.4`
  confidence → skip; `ask` items batched into one in-turn question per session.
- **`careWeight` decay mechanism (§8.2):** floor-based — `"high"` records can never score
  below `CARE_WEIGHT_FLOOR` (default 0.5) regardless of age; `"low"` / unset decay normally.
  Optional `"critical"` level (floor = 1.0) flagged as still-open if the human wants to nail
  it before code.

**Still open**
1. **Milestone slot:** `0.6.x`? (proposed)
2. **Legacy audience default (§6 Phase 4):** `ward-private` floor (recommended) vs. broader.
3. **Cutover style (§6 Phase 5):** hard (convert → verify → retire in one run, recommended)
   vs. grace period (keep the entity-core snapshot readable as a fallback for N days).
4. **Reliability bar (§3):** as the canonical-self store, Phylactery being down is more serious
   than a peer outage. Confirm "degrade to absent = run without self-memory, turn still
   succeeds" is the intended posture, and whether a stricter health/restart policy is wanted.
5. **Filter threshold + retry budget (§5):** similarity cutoff, rewrite-loop count, and the
   safe-refusal fallback wording.
6. **`remember` category taxonomy (§7):** confirm the starting set.
7. **Ward care-profile field list (§8.3):** confirm fields vs. what links out to
   Unruh/cerebellum.
8. **Consolidation cadence + thresholds (§3 "Ongoing operation"):** the tick interval and the
   "enough accumulated to roll up" threshold per tier (default toward entity-core's 5-min tick,
   gated by volume).
9. **Export format + encryption (§3 "Ongoing operation"):** single `.sqlite` only (recommended)
   vs. also a JSON/JSONL human-readable export; and whether exports get optional passphrase
   encryption-at-rest (the file is the whole ward-private self).
10. **Foreign-source import (§6 Phase 6):** interim entity-loom hop vs. lifting its parsers into
    a Phylactery-native importer — and whether foreign import is in this milestone at all
    (proposed: later/optional, off the critical path).
11. **Context-economy knobs (§3 "Context economy"):** default `k` for thin recall, the Phylactery
    slice's per-turn token budget in `enrich()`, and whether *any* metadata field is allowed to
    surface in the default projection (proposed: none — staleness only, as a compact prose tag).
    Dynamic-injection depth stays at the current default of **4** (decided — salience/flow knob,
    not a cache knob).

Everything touching *when/whether the Familiar may store, recall, or disclose* (the three
gates) falls under the CLAUDE.md safety-critical sign-off rule — §5 and the `remember` gate
ship only with explicit human approval of the behaviour.

---

## 10. Why this is the robust answer, not the cheap one

- Solves the **problem space** (PF owns its precise, gated canonical self), not the symptom.
- **Sustainable:** one canonical store — no split-brain, no promotion path, no live sync
  between engines; every fact carries its tags in the store it lives in. No un-taggable blind
  spot for the outgoing filter, by construction rather than by papering over.
- **Grounded in what works:** reimplements entity-core's proven architecture (precision the
  human has measured, mechanics read from source) on Unruh's in-tree MCP plumbing (proven end
  to end) — not a from-scratch invention.
- **User-accessible:** tags are visible and editable by human and Familiar; migration is
  one-time, snapshot-backed, and recoverable; the filter's action is observable.
- It's the exact substrate future SillyTavern-style embodiment-plugins would read through —
  with the whole self in one PF-owned store, PF *is* the hub, as intended.
- **The cost is owned, not hidden (§1):** we maintain the full engine and forgo entity-core's
  upstream work. The human weighed that and chose it; robustness here means PF controlling its
  own continuity end to end.
