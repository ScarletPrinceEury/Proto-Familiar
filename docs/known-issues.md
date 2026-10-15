# Known issues

A running log of bugs we've spotted but haven't fixed yet, so they don't get
lost. Newest first. When one is fixed, move it to the commit that fixes it (or
delete it) rather than leaving it here stale.

---

### The intention architecture is too weak to carry the Familiar's own presence

During a week-long test on a different model family, the Familiar acted on
almost none of its own interests or plans, and over the week it got worse at
answering questions about its own wants and wishes. That undermines the bond
the whole project runs on: a companion with no visible self-interest reads as
a tool. Places to look: how intentions are created and surfaced (the
`intention_*` tools, noticing's due-intention wake condition), whether
pondering interests ever turn into plans, how much of the identity block is
about the Familiar itself rather than about my human (see the identity-crowding
entry below), and how dependent all of this is on one model family's default
initiative. Needs a design pass, not a prompt tweak.

### Confident confabulation: claiming writes that never happened, recalling events that didn't

The Familiar still sometimes says it wrote something down when no tool call
ran, or recalls an event that never happened. Imagination is wanted; what's
missing is a reliable way to tell it apart from reality. Directions: make the
provenance of what the Familiar reads explicit (experienced / told / recalled /
imagined-or-pondered), give it a cheap way to check its own action record (tool
calls that actually ran) before claiming one, and make "I did X" claims
checkable against that record. Related to RULE B in CLAUDE.md (tool results are
how I know what I actually did).

<!--
Resolved:
- Identity crowding — fixed 0.14.70 (docs/identity-lean-build-spec.md). Root
  cause: three prompts routed standing facts about my human INTO identity
  (save_to_tome, the tome-graduation rubric, pondering), nothing bounded its size,
  and the Pillar H cleanup judged whole files — any file edited in 30 days, or
  holding one care word, was never tidied. Now: one rule in every writer
  (identity = who I am + the shape of us; everything else, care included, is a
  standing fact), a ward-set budget with an update_identity nudge, a cleanup that
  works on over-budget files (protected self core excepted), and care facts
  moved to high-care standing facts that are put in front of me on my human's own
  turns, in triage and noticing — never in group chats.
- "I didn't finish my sentence" when the sentence was finished — fixed 0.14.69.
  Root cause: context blocks showed the Familiar's own earlier messages cut to a
  fixed length — the hippocampus at 280 chars ending in "…", the noticing /
  warm reach-out recent lines at 300 and triage's at 400 with no marker at all —
  so a complete reply read back as one that broke off. Long messages now show
  their start and real end around an explicit cut marker (`src/util/excerpt.js`),
  and triage reads its recent lines whole (see tests/excerpt.test.mjs).
- Phylactery `UNIQUE constraint failed on memory_vecs primary key` during
  embedding — fixed 0.7.32. Root cause: the embedding write used
  `INSERT OR REPLACE`, but sqlite-vec (vec0) virtual tables don't honor
  OR-REPLACE / UPSERT conflict resolution, so re-embedding an existing
  memory_id/node_id raised the UNIQUE error instead of replacing. Fixed in
  memory.py + graph.py with delete-then-insert (see tests/test_vec_upsert.py).
-->
