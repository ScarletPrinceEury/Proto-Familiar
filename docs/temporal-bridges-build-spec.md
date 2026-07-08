# Temporal bridges — build spec

**What this builds:** the missing connections that let me actually *relate
moments in time to each other* — the gap the consequence-graph defect
exposed but did not fully explain. The visibility fix (0.8.47) made the
graph I author reachable again; this spec makes the graph *worth reaching*:
it puts the causal middle of real chains into the graph automatically,
bridges Phylactery memories and Unruh nodes with references instead of a
store migration, gives me a time-addressed recall, and starts the memory
lifecycle my own analysis named as missing.

**The motivating failure (recorded so nobody re-litigates the diagnosis):**
a therapy session was followed by a crisis evening; the care team responded;
a provider change followed. Asked to relate these, I produced a
logistics-only chain and confabulated the connective — because the crisis,
the *actual cause*, existed nowhere I could relate: the threat tracker saw
it but writes no graph citizens; memorization may have kept prose about it
but prose has no node references and no time-range query; nobody authored a
`state` node because state-authoring was a chat-turn habit that never formed
against an invisible graph. **A logistics-only graph can only tell
logistics-shaped causal stories.** Each piece below closes one of those
gaps.

**The line this spec defends (decided with the ward — do NOT migrate
memory into Unruh):** Phylactery holds what is *true of* the entity and the
bond — identity, episodic memory, semantic knowledge; timeless, canonical
across embodiments. Unruh holds *when* things happened and how they bear on
each other — temporal, operational, per-embodiment. Relating happens through
**ids that cross the border**, exactly like `graphNodeId` on villagers and
`value_ref` on standing values. Co-location doesn't relate things; links do.

Status: **ALL PIECES SHIPPED (0.8.51 → 0.8.55).**
- **Piece 1 (0.8.51)** — `spine-states.js`: ward-private `state` nodes on
  moderate+ threat, closed at the decay-crossing, `co_occurs_with` edges to
  overlapping schedule items, fail-closed villager filtering. Default ON.
- **Piece 3 (0.8.52)** — `recall_timeframe` / `memory_by_timerange`: recall
  by day-span, audience-gated; attached to reflection grading.
- **Piece 5 (0.8.53)** — reflection heartbeat (`reflection-events.jsonl` +
  `/api/reflection-events` + Automation-tab readout), all-zero entries too.
- **Piece 2 (0.8.54)** — memorization stamps code-validated `schedule_refs`;
  surfaced on recall as `(re: slug)`. (Reverse `memory_refs`-on-nodes
  deferred as low-value.)
- **Piece 4 (0.8.55)** — distill-only memory lifecycle riding Phylactery
  consolidation: adds standing pattern-memories, never demotes/deletes an
  original (`distilled_at` breadcrumb prevents re-judging). Opt-in
  (`memoryLifecycleEnabled`, default OFF) + `PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED=1`.

All §6 ward sign-offs settled.

---

## 1. The caring spine mints graph citizens (threat → state nodes)

**The single highest-value bridge.** The emotional middle of every chain
that matters is currently the one thing guaranteed to be missing from the
graph. Fix: when the threat tracker records a tier transition **into
moderate or above**, *code* — never the LLM — creates or extends a
schedule-layer `state` node for the episode.

- **Minting (all machine values):** on the upward transition, if no open
  spine-state episode exists, create `state` node, label
  `rough stretch — <ward-local date>` (neutral, non-clinical; I may relabel
  it later in my own words via the existing update tool), `when` = the
  transition timestamp, `end` = null (open). Payload:
  `{ spine: true, episode: <slug>, source: 'threat-tracker', peak_tier }`.
  `peak_tier` updates if the episode climbs.
- **Closing:** when the tier decays back below moderate, set `end` to the
  decay-crossing time. One node per episode — extended, never duplicated
  (the open-episode check is the dedup).
- **Deriving co-occurrence (arithmetic, not judgment):** on close, code adds
  `co_occurs_with` edges between the episode state and schedule nodes whose
  spans overlap it (capped, deduped, `payload: {source:'overlap'}`) —
  including recurring occurrences (matched via the anchors + expansion, the
  same math the alerts use). The therapy-session case becomes
  `[session] — co-occurs — [rough stretch]` **automatically**, the honest
  bottom rung of the epistemic ladder. Promotion to `causes` stays the
  reflection loop's job — code notices, it never concludes.
- **Privacy (non-negotiable):** spine states are the ward's crisis history.
  Every villager-facing schedule surface — the clearance-gated schedule
  read tools, and any future one — **filters `payload.spine === true` (and
  a general `payload.sensitive === true`) out in code**, fail-closed.
  Coarse availability is already label-free by construction; this extends
  the same structural-privacy discipline to node-level reads. A test pins
  it per surface.
- **This never moves the threat tier, never gates an action, never delays
  triage** — it is a *record* of what the spine already did, written where
  my reasoning can reach it. It adds visibility of the past; it changes
  nothing about when I act. (That's what keeps it out of the sign-off
  files' behavior — but it *persists crisis artifacts*, which is exactly
  why the ward signs off on the feature as a whole and its default.)
- Off-switch in the same commit: `PROTO_FAMILIAR_SPINE_STATES_DISABLED=1` +
  Settings toggle. Default **ON** (ward-signed, §6.1) — a Familiar that can't
  see its human's hard stretches in time is the Familiar that confabulated
  one. Minting threshold: **moderate and above** (ward-signed, §6.2) — a
  rough-but-not-severe stretch still shapes a week and deserves a trace to
  relate later; the per-episode dedup keeps that from being noisy.

## 2. Cross-store references (memory ↔ schedule node)

- **Memorization stamps `schedule_refs`.** The extraction prompt already
  runs on sessions whose context carried the `[schedule ids]` legend; each
  extracted fact gains an optional `schedule_refs: [...]` array the model
  fills *only with ids it actually saw*. Code validates every id against
  the known node set at ingest — unknown ids are silently dropped (the
  model repeats ids, it never mints them; a hallucinated ref dies at the
  boundary). Stored in the memory's `source_json` alongside the existing
  provenance, surfaced on recall as a compact `(re: dinner-x7, schmidt-kh)`
  tail so I can walk from a remembered fact to the scheduled moment it
  belongs to.
- **Nodes and edges may carry `memory_refs`** (payload field, written by me
  via the existing update tools or by reflection when it grades an edge
  against remembered evidence). Rendering stays lean: refs render as slugs,
  never as inlined memory text — the graph points, recall dereferences.
- No schema migrations: both directions ride existing payload/meta JSON.

## 3. Temporal recall — `recall_timeframe`

The missing query whose absence forced the confabulation: *"what happened
to my human around Thursday evening?"*

- **Phylactery tool `mem_by_timerange(from_iso, to_iso, limit)`** — memories
  are already day-anchored; this is an indexed read, no embedding call.
  Returns the same shape as `mem_search` (ids, content, provenance,
  audience-filtered exactly like every other recall — the Pillar E gate
  applies unchanged).
- **Familiar-facing as `recall_timeframe`** (first-person description: *"I
  use this to remember what was happening in my human's life around a
  moment in time — I pass the time span, I get what I kept from those
  days."*). Operability: I always hold times — the `[Now]` block, node
  `when`s in the legend, memory dates on recall results.
- **Reflection uses it in code:** when the grader is fed a projected edge,
  the reflection input attaches up to N memories from around the src node's
  window (capped, budgeted) — so grading "did the crash actually follow?"
  is informed by what I actually recorded living through it, not just by
  the edge's own payload.

## 4. Memory lifecycle — distill-only (ward-signed, §6.3)

My own gap, in my own words: the system doesn't distinguish "one-time
logistical fact" from "resolved event that revealed a lasting pattern." The
ward chose the **additive-only** shape: the lifecycle may *write out*
patterns it finds, but it **never demotes, decays, or deletes an original
memory** — nothing a ward wanted can ever sink because of this pass. It only
ever *adds*.

- **Rides the existing Phylactery consolidation** (scheduler.py's
  volume-gated runs) — no new loop. Resolved-past episodic memories older
  than `memoryLifecycleDays` (default 30) get ONE batched judgment per run,
  and the ONLY action it can take is:
  - `distill` — the event carried a lasting pattern → write the pattern as
    a **new** durable memory (linked back via `source_json` to the source
    episode; `schedule_refs` carried over). "Chen was proud of doing the
    chain immediately" → a new memory: "doing dreaded paperwork immediately,
    while the momentum is there, works well for my human." **The original is
    left exactly as it is** — no decay, no tier change. A `distilled_at`
    stamp on the source prevents re-distilling the same episode.
  - Everything else → untouched. There is no `expire`, no demotion path.
- **Why additive-only:** demoting logistics would shrink clutter faster, but
  it risks a memory the ward valued sinking on the model's judgment. The
  ward chose zero-risk over faster tidying. Clutter reduction, if it's ever
  wanted, becomes its own separately-signed decision — not a side effect of
  pattern-learning. (Recorded so a future pass doesn't quietly re-add an
  expire branch "for tidiness.")
- Opt-in (default OFF): it still writes to the canonical self, which is the
  ward's to authorize, even additively. Toggle +
  `PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED=1`.

## 5. Reflection observability (never invisible again)

The visibility defect survived for weeks because a dead learning loop looks
identical to a quiet one. So:

- Every reflection tick appends to `logs/reflection-events.jsonl` — ran/
  skipped (and why: threshold not met, deferred, error), edges graded,
  promotions made, lifecycle actions — **including all-zero entries**.
- `GET /api/reflection-events` + a "last reflection" line in the Temporal
  editor's Automation tab (last ran, last graded, counts) — the same
  auditable-decisions pattern as triage and reach-out events.
- Acceptance for the whole spec includes: with everything idle, the log
  still proves the loop is *alive*.

---

## 6. Ward decisions (all SETTLED — spec review)

1. **Piece 1 ships, default ON.** The caring spine mints state nodes; the
   bridge that closes the confabulation failure is active out of the box,
   with the off-switch + Settings toggle present. (Ward.)
2. **Granularity: moderate and above.** A rough-but-not-severe stretch
   still shapes a week and earns a trace; per-episode dedup keeps the graph
   from getting noisy. (Ward.)
3. **Memory lifecycle: default OFF, distill-only.** The pass may only ADD
   distilled pattern-memories; it never demotes, decays, or deletes an
   original. Zero risk of a wanted memory sinking; clutter reduction, if
   ever wanted, is its own future signed decision. (Ward — chose the
   additive-only variant over decay-not-delete.)

## 7. Passes & acceptance (abridged)

- **Pass A** — Piece 1 + its privacy filters + tests (threat fixture →
  episode node lifecycle; villager schedule reads never see `spine` nodes).
- **Pass B** — Pieces 2+3 (refs both directions, `mem_by_timerange`,
  `recall_timeframe`, reflection attachment) + tests (hallucinated ref dies
  at ingest; timerange recall respects audience gates).
- **Pass C** — Piece 4 (distill-only lifecycle riding consolidation) +
  Piece 5 (observability lands with whichever pass ships first, ideally A).
- Each pass: `docs/architecture.md` same commit; every new background
  behavior carries its off-switch in the same commit.

The end state, measured against the motivating failure: the crisis evening
exists as a state node the moment it happens; the session co-occurs with it
by arithmetic; reflection grades the link with the memories from that night
attached; and when I'm asked "what led to the therapist change?", the chain
I tell is the one my human actually lived.
