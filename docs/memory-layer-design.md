# Proto-Familiar Memory Layer — design (milestone: "Philactery")

Status: **proposal / not yet built.** This doc is the shape we react to before
any code lands. It reframes three things we've been circling — autonomous
memorization, the outgoing-message filter (third security gate), and the
`memories: 'shared'` unlock — as facets of **one** capability: Proto-Familiar
owning a real, RAG-based, audience-aware memory specialist.

Naming note: named by the human — **Philactery**. A phylactery is the vessel that
holds a soul; the spelling is theirs. It follows the Unruh precedent (a name with
character, not a literal brain region) and fits the entity-as-subject stance — this
is where the Familiar's continuity *lives*, not merely an anatomical label. Module
at `./philactery/`.

**Grounding principle:** this system is modeled on **how entity-core and Unruh
already work** — a separate, in-tree MCP service that thalamus spawns as a stdio
child, with its own data store, queried during `enrich()` and degrading gracefully
when absent. Its **retrieval is RAG** (semantic/vector search), the same basis
entity-core uses — because entity-core's RAG has been markedly **more precise than
the keyword-triggered tomes**, and that precision is what we want.

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
thalamus exactly like entity-core. Philactery is its sibling for memory.

### What we adopt vs. reject

- **Adopt:** entity-core's **RAG memory architecture** — embedding-backed semantic
  search over tiered, consolidatable memory records. We model on it (we have read
  access to the sibling checkout + `docs/entity-core.md` +
  `Research/entity-core-memory-identity-analysis.md`), reimplemented as our own.
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

The line that keeps us honest: entity-core and Philactery split by **responsibility**
(canonical-self vs. gated/situational memory), **never** holding two copies of one
fact.

---

## 2. What exists today (verified, June 2026)

**The three-service spine (thalamus.js):**
- **entity-core** — Deno/TS MCP child (`deno run -A --unstable-cron …`), cwd = its
  root, env carries the designated connection's LLM key/base/model (embeddings +
  consolidation). Tools: `identity_get_all`, `memory_search` (vector RAG → scored
  results with excerpt/granularity/date), `memory_create/list/read`, `graph_*`,
  snapshots. Tiers: daily/weekly/monthly/yearly/significant; LLM consolidation rolls
  them up. **Its RAG is the precise retrieval we want to emulate.**
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
              │        Philactery (NEW, in-tree MCP)
              │        RAG memory · audience-native ·
              └──────  timestamped · gated at query time
                         ▲ write              ▼ read (semantic + gated)
                  autonomous memorization   web · Discord · outgoing filter
```

**Philactery = a new in-tree MCP memory specialist**, built on entity-core's RAG
basis, supervised by thalamus exactly like entity-core and Unruh:

- **Own data store** (`./philactery/data` or similar): memory records + their
  embeddings.
- **RAG retrieval**, not keyword triggers: embed the query, vector-similarity search,
  return scored results — the same precision profile as entity-core's `memory_search`.
  Embeddings go through the **same designated-connection plumbing** entity-core uses
  (reuse `loadEntityCoreEnv`'s pattern for the LLM/embeddings key).
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
  is null; ships with `PROTO_FAMILIAR_PHILACTERY_DISABLED=1` in the same commit
  (the established rule for every new peer/loop).

**Responsibility split (the contract):**
- **entity-core** — canonical self: identity, knowledge graph, ward-private-safe
  memory. Unchanged. Still fetch-gated (shared rooms don't pull it).
- **Philactery** — memory needing disclosure metadata: precise RAG recall +
  per-record audience tag, gated per room *and* checkable on the way out.
- **Tomes / World Info** — **retained, repurposed.** No longer the Familiar's
  autonomous memory. They become the **human-authored lorebook** (curated,
  keyword-triggered injection — the SillyTavern-familiar feature). Autonomous memory
  is RAG (Philactery); deliberate lore is keyword (tomes). Clean separation by
  authorship and trigger model.

### The audience tag on a record (reuses `audience.js`)

- `audience` = **minimum audience level allowed to hear it**: a category id
  (`cat-friends`, `cat-acquaint`, `CATEGORY_STRANGERS`, …) or `'ward-private'`
  (most restrictive, above every category).
- **Disclosure rule:** record `M` may surface/disclose in room `R` iff
  `permissionScore(R) >= requiredScore(M)`; `'ward-private'` scores above all
  categories. Same comparison `audienceTagFor()` already does for rooms — applied to
  memory. This milestone defines `requiredScore()` for the sentinel.

### Language / stack — open, with a lean

- **Deno/TS (mirror entity-core)** — lets us follow entity-core's *proven memory
  module structure* most directly, which is the basis the human explicitly wants.
  Spawn pattern already in thalamus (`deno run`). **Lean: this.**
- **Python (mirror Unruh)** — reuses Unruh's `uv`/venv installer plumbing and a rich
  embedding ecosystem.
- Either way the in-tree MCP-child plumbing in thalamus exists *twice* already; a
  third is template work, not invention. Embeddings are a provider API call in both.

---

## 4. Pillars (one milestone, phased)

Per CLAUDE.md a milestone owns one MINOR slot; landing = `0.6.0`, sub-features bump
PATCH. (Working assumption — human confirms the slot.)

- **A. Stand up the service.** `./philactery/` MCP server: data store, embedding
  client (designated-connection key), RAG `mem_search`, schema with native
  `audience` + timestamps. Model the record/tier/consolidation shape on entity-core.
- **B. Thalamus integration.** Spawn as a third stdio child (clone the entity-core /
  Unruh lifecycle: connect, reconnect/backoff, EOF shutdown, off-switch). Query in
  `enrich()` alongside the others (`allSettled`), passing the room `audienceTag` so
  results are gated at source. **This is what finally gives Discord & autonomous
  turns precise local memory.**
- **C. Autonomous memorization + routing.** Server-side enqueue at session end / idle
  rollover for **web and Discord** (worker exists; add triggers). Routing folded into
  the *existing* memorization LLM call (no new request): disclosure-sensitive memory →
  Philactery (tagged with the session's `audienceTag`); ward-private-safe canonical
  facts → entity-core; shared-room content (`audienceTag !== 'ward-private'`) →
  Philactery only, never entity-core. See §6 for the sensitivity rule.
- **D. Outgoing message filter (third gate).** §5.
- **E. `memories: 'shared'` unlock.** With Philactery records tagged and gated at
  query time, `fetchEligibility` stops gating `'shared'` OFF and instead lets the
  shared ladder return same-or-lower-sensitivity Philactery records. entity-core
  stays fetch-gated; the widening is safe because it targets the tagged store.
- **F. Migration — "convert current Familiars."** §7.

---

## 5. The outgoing message filter (third gate)

**Purpose (human's words):** *"if anything slips Thalamus' enrichment because it
snuck into an innocent memory as well as the tagged ones, it can't get out."* The
fetch gate decides what *enters* context; this gate decides what may *leave* a given
room.

**Where:** a post-response, pre-send step shared by Discord (`discord-gateway.js`,
before `sendChannelMessage`) and web chat (`/api/chat`). Symmetric — one gate, both
paths.

**How — riding Philactery's RAG (precise, not keyword overlap):**
1. The turn already knows the room's `audienceTag`.
2. Call `mem_search_restricted(draftReply, roomTag)` → Philactery returns records
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
  *Disclosure-sensitive* facts — passive or not — live in **Philactery** (RAG, can
  hold contextual facts) with a restrictive tag. Only *ward-private-safe* canonical
  facts go to entity-core.
- **(c) — structural guarantee.** entity-core is fetch-gated: shared rooms never pull
  it, ward-private rooms have no one to leak to. So the outgoing filter only ever
  needs to cover Philactery. Lean on this as the backstop.
- **(a) — last resort.** A tag-only "gate marker" record in Philactery for a fact
  that must live in entity-core *and* be gated. Edges toward the sidecar trap — avoid
  unless (b)/(c) prove insufficient.

**Recommendation:** adopt **(b)** as the routing rule, lean on **(c)** as the
guarantee. Decide before Phase C.

---

## 7. Migration — converting current Familiars

Existing installs have a populated *Session Memories* tome with no audience tags and
no embeddings. Converting a Familiar means **importing that local memory into
Philactery** (embedding + tagging it), not just stamping a field.

**Scope:** local tome memory → Philactery. We do **not** extract or mirror
entity-core memories — entity-core stays canonical.

**Mechanism:**
1. **Snapshot first.** Copy before mutating. (The branch name
   *"memories-disappearing"* is a standing reminder: never touch memory without a
   recoverable copy.)
2. **Import** each Session-Memories entry: embed its `content`, carry over its
   timestamps, write a Philactery record.
3. **Backfill a default audience.** Safe floor = **`ward-private`** — assume legacy
   notes are private until reviewed. Consequence: legacy memory won't surface in
   shared rooms until re-tagged. Conservative but leak-safe.
4. **Bulk re-tag affordance** so the conservative default isn't a life sentence
   (user-accessible).
5. **Optional, opt-in LLM classification** to *suggest* tags per record (rides the
   memorization prompt pattern). Off by default — token budget.
6. **Idempotent + non-destructive.** The source tome is preserved (it becomes/stays
   human-authored lore per §3); import is re-runnable and only adds missing records.

**Open question for the human:** keep `ward-private` as the legacy default
(leak-safe, recommended), or default broader (immediately useful, disclosure-permissive
until reviewed)? Safety-vs-utility — yours.

---

## 8. Open decisions (human sign-off)

1. **Milestone name:** **Philactery** (named by the human ✔). **Slot:** `0.6.x`?
   (proposed)
2. **Stack (§3):** Deno/TS to mirror entity-core's RAG (lean) vs. Python to mirror
   Unruh's plumbing.
3. **Legacy audience default (§7):** `ward-private` floor (recommended) vs. broader.
4. **Routing key (§6):** sensitivity-based **(b)** (recommended) vs. topic-class.
5. **Filter threshold + retry budget (§5):** similarity cutoff, rewrite-loop count,
   and the safe-refusal fallback wording.

Everything touching *when/whether the Familiar may disclose* (the filter, the gates)
falls under the CLAUDE.md safety-critical sign-off rule — §5 ships only with explicit
human approval of the behavior.

---

## 9. Why this is the robust answer, not the cheap one

- Solves the **problem space** (PF owns precise, gated memory), not the symptom.
- **Sustainable:** no duct tape syncing two stores; tags live where the memory lives;
  the split is by responsibility, which the codebase already follows for Unruh.
- **Grounded in what works:** entity-core's RAG (precision the human has measured) +
  Unruh's in-tree MCP plumbing (proven end to end) — not a from-scratch invention.
- **User-accessible:** tags are visible and editable by human and Familiar; migration
  is recoverable; the filter's action is observable.
- It's the exact substrate future SillyTavern-style embodiment-plugins would read
  through — PF becomes the hub, as intended.
