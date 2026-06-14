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
lorebook. Two layers in the original question pull opposite ways:

- **Identity** (self / user / relationship prose, the knowledge graph, relationship
  history) is the *actual shared self* — canonical, maintained upstream, working
  well. **Identity stays in entity-core, untouched.**
- **Memory** is where every stuck item lives, and where we want both (a) precise RAG
  retrieval and (b) native audience tags + timestamps that entity-core structurally
  can't give us. **PF owns this, as its own specialist, modeled on entity-core's
  proven RAG.**

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
  consolidation/deletes/slug rewrites. We never mirror entity-core memories.

The line that keeps us honest: entity-core and Phylactery split by **responsibility**
(canonical-self vs. gated/situational memory), **never** holding two copies of one
fact.

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

## 3. Target architecture

```
        entity-core (Deno/TS MCP)        Unruh (Python MCP)
        canonical identity + graph       temporal: schedule,
        + ward-private-safe memory       interests, reminders
              ▲                                 ▲
              │            thalamus             │
              │      (spawn · enrich ·          │
              │   allSettled · degrade)         │
              │                                 │
              │        Phylactery (NEW, in-tree MCP)
              │        RAG memory · audience-native ·
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

**Responsibility split (the contract):**
- **entity-core** — canonical self: identity, knowledge graph, ward-private-safe
  memory. Unchanged. Still fetch-gated (shared rooms don't pull it).
- **Phylactery** — memory needing disclosure metadata: precise RAG recall +
  per-record audience tag, gated per room *and* checkable on the way out.
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
  consolidation shape on entity-core's source.
- **B. Thalamus integration.** Spawn as a third stdio child (clone the entity-core /
  Unruh lifecycle: connect, reconnect/backoff, EOF shutdown, off-switch). Query in
  `enrich()` alongside the others (`allSettled`), passing the room `audienceTag` so
  results are gated at source. **This is what finally gives Discord & autonomous
  turns precise local memory.**
- **C. Autonomous memorization + routing.** Server-side enqueue at session end / idle
  rollover for **web and Discord** (worker exists; add triggers). Routing folded into
  the *existing* memorization LLM call (no new request): disclosure-sensitive memory →
  Phylactery (tagged with the session's `audienceTag`); ward-private-safe canonical
  facts → entity-core; shared-room content (`audienceTag !== 'ward-private'`) →
  Phylactery only, never entity-core. The `remember` retention gate (§10) runs here.
  See §6 for the sensitivity rule.
- **D. Outgoing message filter (third gate).** §5.
- **E. `memories: 'shared'` unlock.** With Phylactery records tagged and gated at
  query time, `fetchEligibility` stops gating `'shared'` OFF and instead lets the
  shared ladder return same-or-lower-sensitivity Phylactery records. entity-core
  stays fetch-gated; the widening is safe because it targets the tagged store.
- **F. Migration — "convert current Familiars."** §7.
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

## 6. The sensitivity wrinkle (open design point)

Routing sends *passive contextual facts* toward entity-core, but entity-core can't be
tagged, so the outgoing filter can't see facts that live only there
(e.g. "{{user}}'s therapist is …").

Resolutions, preferred first:

- **(b) — recommended.** Routing key is **sensitivity**, not topic-class.
  *Disclosure-sensitive* facts — passive or not — live in **Phylactery** (RAG, can
  hold contextual facts) with a restrictive tag. Only *ward-private-safe* canonical
  facts go to entity-core.
- **(c) — structural guarantee.** entity-core is fetch-gated: shared rooms never pull
  it, ward-private rooms have no one to leak to. So the outgoing filter only ever
  needs to cover Phylactery. Lean on this as the backstop.
- **(a) — last resort.** A tag-only "gate marker" record in Phylactery for a fact
  that must live in entity-core *and* be gated. Edges toward the sidecar trap — avoid
  unless (b)/(c) prove insufficient.

**Recommendation:** adopt **(b)** as the routing rule, lean on **(c)** as the
guarantee. Decide before Phase C.

---

## 7. Migration — converting current Familiars

Existing installs have a populated *Session Memories* tome with no audience tags and
no embeddings. Converting a Familiar means **importing that local memory into
Phylactery** (embedding + tagging it), not just stamping a field.

**Scope:** local tome memory → Phylactery. We do **not** extract or mirror
entity-core memories — entity-core stays canonical.

**Mechanism:**
1. **Snapshot first.** Copy before mutating. (The branch name
   *"memories-disappearing"* is a standing reminder: never touch memory without a
   recoverable copy.)
2. **Import** each Session-Memories entry: embed its `content`, carry over its
   timestamps, write a Phylactery record.
3. **Backfill a default audience.** Safe floor = **`ward-private`** — assume legacy
   notes are private until reviewed. Consequence: legacy memory won't surface in
   shared rooms until re-tagged. Conservative but leak-safe.
4. **Bulk re-tag affordance** so the conservative default isn't a life sentence
   (user-accessible).
5. **Optional, opt-in LLM classification** to *suggest* tags per record (rides the
   memorization prompt pattern). Off by default — token budget.
6. **Idempotent + non-destructive.** The source tome is preserved (it becomes/stays
   human-authored lore per §3); import is re-runnable and only adds missing records.

*Precedent: entity-loom v0.3.6 — Psycheros's own import wizard — converts foreign
companion exports into an import package using confidence-thresholded
(`confidence >= 0.7`), dedup-upsert, concrete-type-restricted extraction. Our
tome→Phylactery import is narrower, but borrows that posture (and its parsers exist
if we ever want to import raw chat history into Phylactery).*

**Open question for the human:** keep `ward-private` as the legacy default
(leak-safe, recommended), or default broader (immediately useful, disclosure-permissive
until reviewed)? Safety-vs-utility — yours.

---

## 8. Open decisions (human sign-off)

1. **Milestone name:** **Phylactery** (named by the human ✔). **Slot:** `0.6.x`?
   (proposed)
2. **Stack (§3): DECIDED — Python / uv** (matches Unruh; lets Phylactery run the
   *same* local embedding model entity-core uses). ✔
3. **Legacy audience default (§7):** `ward-private` floor (recommended) vs. broader.
4. **Routing key (§6):** sensitivity-based **(b)** (recommended) vs. topic-class.
5. **Filter threshold + retry budget (§5):** similarity cutoff, rewrite-loop count,
   and the safe-refusal fallback wording.
6. **`remember` consent model (§10): DECIDED** — dossier on the Village villager ✔;
   `ask` = **hybrid** (the Familiar's own read *plus* freely asking the ward; asking
   is welcome, never a reason to go silent) ✔. Remaining: confirm the starting category
   taxonomy.
7. **Caretaker extensions (§11): DECIDED** — all of 11.1–11.4 incorporated ✔, including
   `relationToFamiliar` (a villager's stance toward the Familiar — driving posture,
   identity-anchored — with `unaware`/never-heard-of-me as the default for new
   contacts). Remaining detail: starting tracker types + care-profile field list.

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

### 11.1 Two record kinds: narrative + tracker (forward-compatible NOW)

Reserve a `kind` discriminator on every Phylactery record from day one:

- `kind: "narrative"` — the default RAG record (free-text, embedded, semantically
  recalled). Everything in §3 above.
- `kind: "tracker"` — **structured, typed, time-stamped state.** The home for pantry
  contents, mood, meds, hydration, sleep, symptoms, spending, energy/"spoons" —
  anything tracked *over time* or *as inventory*.

Why here (not Unruh, not the graph): a tracker is *remembered state about the ward's
life*, so it shares Phylactery's audience-tagging, persistence, and surface-into-
context machinery. Unruh stays **temporal/scheduled** — a tracker can *spawn* an Unruh
reminder ("milk expires tomorrow") but the inventory itself is Phylactery state. The
graph stays **relational**.

Tracker shape (sketch — full feature is later; reserving the shape is now):

```
{ kind: "tracker", name: "mood",   trackerType: "ordinal",   subject: "ward",
  scale: "1-5", entries: [{ value, at, source, note? }],      audience: "ward-private" }
{ kind: "tracker", name: "pantry", trackerType: "inventory", subject: "ward",
  items: [{ label, qty, unit, expiresAt?, addedAt }],          audience: … }
```

`trackerType` candidates: `scalar | ordinal | inventory | event-log | boolean`.
Building the tracking UI / ingestion is a later sub-feature; **the only commitment now
is the `kind` field + the tracker shape, so narrative records never have to be migrated
to make room.**

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

**Decided with the human:** all of 11.1–11.4 are in. 11.1 (the `kind` + tracker shape)
and 11.2 (caretaker metadata) land in the schema from the start; 11.3 (ward
care-profile) and 11.4 (both relationship axes, incl. `relationToFamiliar` with
`unaware` as the floor) are part of the person/ward records — linking to Unruh /
cerebellum where noted rather than duplicating.
