# Identity stays lean — build spec (0.14.70)

Ward-signed decisions, recorded so later passes don't undo them.

## The problem

The always-injected identity block had grown to ~46,700 characters (~11.7k
tokens) on one install, riding **every** turn, and the self files ride into
group chats too (ward/relationship/custom files reach any room whose circle has
`identityBasic`). Three causes:

1. **Steering.** `save_to_tome` told the Familiar "durable facts about who
   {{user}} is belong in my identity files"; the tome-graduation rubric routed
   every standing fact about the human to identity; pondering routed "factual
   claims about my human" to `update_identity`; `update_identity`'s own
   "load-bearing" test was read generously.
2. **No budget.** Nothing bounded identity size.
3. **The cleanup couldn't reach the problem.** Pillar H graduation judged whole
   files: `updated_at` was both its dwell and confirm anchor (any file edited in
   30 days was skipped — the files being appended to were exactly the ones that
   never qualified), and one care word anywhere pinned the whole file.

## The rule (one place, every writer)

**Identity is for who the Familiar is and the shape of the bond**, plus only the
core of who the human is (name, pronouns, how they like to be addressed).
Anything that only matters sometimes is a **standing fact** (`save_memory`,
register `ward` / `me`), recalled when relevant. Care details about the human
(what helps, what doesn't, meds, allergies, triggers, who to call) are standing
facts too, marked **high-care**. Said in: `update_identity`, `save_memory`
(+ its `register` param), `save_to_tome`, the tome-graduation rubric (which can
now route to memory with a register), pondering's filing guidance, and the
graduation audit prompt.

## Decisions (ward-signed)

| # | Decision |
|---|---|
| 1 | Scope: steering + budget + a cleanup that actually works. |
| 2 | **Care lines move out of identity** (reverses the old "care never graduates" pin). Identity reaches group chats; care data there is a leak. They land as `ward` facts with `care_weight: 'high'`. |
| 3 | Budget: `identityBudgetTokens`, default **6000**, ward-adjustable in Settings (clamped 2000–30000). Split: self 14/24, ward 6/24, relationship 3/24, custom 1/24. 30000 effectively holds off budget-driven tidying (e.g. while the ward and Familiar review files together). |
| 4 | **Protected core** (never auto-trimmed; following Psycheros's self segments): `my_identity`, `my_persona`, `my_personhood`, `my_wants`, `my_boundaries` (+ `base_instructions`). `my_mechanics` and legacy self files are auditable. An explicit file-level `care_weight: 'high'` still pins. |
| 5 | Ward files keep a **lean core**; preferences, patterns, care and situational notes move out. |
| 6 | High-care facts are put in front of the Familiar **directly** (not left to semantic recall) on the ward's own turns, in **triage**, and in **noticing** — never in a gated room. |

## What was built

- **Phylactery** — `care.py` (the one care matcher + `CARE_CATEGORIES`);
  `memory.create` flags a care-matching `ward` fact high-care unless the caller
  set a `care_weight`; `memory.list_care_facts` (high-care OR unflagged-but-
  matching, so pre-existing facts count; explicit lower weight respected; no
  pending consent; crisis/support first, then health, newest first) + the
  `memory_list_care_facts` tool; `identity_budget_set` (meta KV). Graduation:
  protected core skipped; audited when **(a)** the category is over budget and
  the file is above its target (protected size first, the rest shared
  proportionally, floor 1000 chars) regardless of recent edits, or **(b)** the
  original 30-day rule; all four categories; register `me` for self/custom,
  `ward` for ward/relationship; care items land high-care; notices for
  ward + relationship; snapshot before trim (unchanged).
- **Node** — `src/safety/care-facts.js` (`formatCareFactsBlock`,
  `careFactsBlockForTurn`: gated/static → '' without fetching); `enrich()` adds
  the block before `[CARE CHECK]` on ward-private live turns, capped at 6000
  chars (~1.5k tokens) with "N more I can recall"; triage and noticing get the
  whole set. `src/memory/identity-budget.js` mirrors the Python split (a test
  pins parity) and gives `update_identity` its over-budget note (full text, not
  a quiet ok). Settings → "Identity budget (tokens)", synced, pushed to
  Phylactery at boot and on change.

## Follow-up: the Familiar marks care facts itself (0.14.71)

Found during the first identity review with a live Familiar. A fact only became
high-care if its wording matched `care.py`, and the Familiar had no way to say
so itself. A plainly worded standing care request ("a nudge to eat before a long shift")
would never reach the care list, which made it unsafe to move care lines out of
identity at all. That failed the "every capability reachable by the Familiar"
rule.

- `save_memory` and `update_memory_by_id` take `high_care` (boolean).
  `careWeightFromFlag` (`care-facts.js`) maps true → `'high'`, false → `'low'`
  (an explicit no, which beats a wording match), and unset → nothing sent, so
  the wording still decides. `'high'`/`'low'` is the Knowledge editor's own
  care-weight vocabulary, so the editor shows the Familiar's call and keeps it
  on save.
- `thalamus.createMemory` passes `careWeight` through as `care_weight`.
  Phylactery needed no change: an explicit care weight already won on create
  and on a by-id update.
- A high-care save that isn't `register: "ward"` returns its full text, not a
  quiet ok, saying it won't fade but isn't in the care list. Only ward standing
  facts go there.
- Ward decision (2026-10-15): the care list doesn't look at where a fact came
  from, and that stays. A `ward` fact written on a villager's Discord turn
  (save_memory is a villager write tool when their grants allow it) can be a
  care fact, on my human's own turns and in triage. What a trusted villager
  reports about my human's care is exactly what triage should hear. Don't
  filter villager-sourced facts out of `list_care_facts` without the ward.

## Follow-up: the Familiar can take things out of identity (0.14.72)

Also from the first identity review. The Familiar could save a line as a
standing fact but had no reliable way to take the line out of identity:

- `update_identity` only appends. "Moving" a line out added a pointer under it.
- `rewrite_identity_section` only reaches `## ` sections. Two of the ward files
  had text above their first heading or no headings at all. On a heading that
  didn't match, Phylactery appended a new section, and the thalamus wrapper
  read Phylactery's reply as JSON, failed, and returned `{ok:true}`. So a
  refusal, or an accidental append, read to the Familiar as "rewritten".
- There was no Familiar tool to delete a section or cut a line.
- The automatic cleanup (graduation) couldn't be paused. Holding the budget at
  30000 only stopped budget-triggered audits; the 30-day rule still trimmed a
  file mid-review, after the Familiar had been told cleanup was on hold.

What changed:

- **`remove_from_identity`** (Phylactery `identity_remove_text`) cuts one quoted
  passage, in any file, with headings or without. Exact match first, then
  whitespace-flexible (never different words). Missing or repeated → `{ok:false}`
  and nothing changes. A whole line takes its line break with it. Snapshot first.
- **`delete_identity_section`** exposes the existing `identity_delete_section`.
- **`rewrite_identity_section`** passes `create_if_missing:false` from the
  Familiar's tool: a missing heading is refused with the file's real headings
  (or a pointer to `remove_from_identity` when it has none). Other MCP clients
  keep the old append-on-missing default. The tool now returns `{ok, replaced}`,
  and thalamus inspects it. A backslash in the new body is kept as text.
- **`update_identity`'s description** says it only adds and names the two-step
  move (save_memory, then remove_from_identity). The over-budget note says the
  same. Both new tools are in the `memory-edit` module, whose trigger now
  includes "identity file(s)/section(s)" and "standing fact(s)".
- **"Pause automatic identity cleanup"** (`identityGraduationPaused`, next to the
  budget field) → `identity_graduation_pause` → Phylactery meta
  `identity_graduation_paused`; `run_graduation_audit` skips every file while
  it's set. Hard env switch `PHYLACTERY_GRADUATION_DISABLED=1`. The budget hint
  no longer claims 30000 holds the cleanup.

## Follow-up: the identity edit tools travel together (0.14.75)

`remove_from_identity`, `delete_identity_section` and `rewrite_identity_section`
moved from the conditional memory-edit module into core, next to
`update_identity`. While only the append was core, a turn that didn't surface
memory-edit could add to identity but not cut, and in the first review the
Familiar "removed" a duplicate section by appending it twice. Villager turns are
unaffected: they use their own allowlist (`villagerToolNames`), and none of these
are in it. `tests/identity-edit-tools.test.mjs` pins that a core-only turn has
all four.

## Follow-up: the Familiar can review its care list (0.14.73)

Midway through the first review the care list held 47 facts (about 3.5k
tokens). Only 8 were flagged on purpose; 39 counted because their wording
matched `care.py`. The chat-turn block (6000 chars, ward-set) fits about 24, so
roughly half never reached the Familiar on a chat turn, and the Familiar had no
way to see the list. Ward decision: give it a tool and keep the cap.

- **`list_care_facts`** (memory-edit module) lists every care fact in block order:
  id, `flagged` or `wording` (Phylactery `list_care_facts` now returns `how`),
  `in block` or `recall only`, and an excerpt with a cut marker. A header gives
  totals and says whether triage and noticing see all of them (they fetch
  `CARE_FACTS_FETCH_LIMIT` = 60, unchanged). The review fetches past that limit.
- **One placement rule:** `placeCareFacts` decides what's in the block, and both
  `formatCareFactsBlock` and the review use it. The block skips a fact too long
  for the room left and still fits a shorter one after it, so "in the block"
  isn't simply the first N.
- **Ward-private only:** the tool refuses on any gated turn without fetching, and
  isn't in any villager allowlist. Taking a fact OFF the list
  (`update_memory_by_id` with `high_care: false`) is refused on a gated turn too,
  because it also removes the fact from triage's view. Flagging from a
  villager's turn stays allowed (the 0.14.71 ward decision).
- **0.14.74, found in the first real pass:** the Familiar unflagged 19 facts,
  some crisis-adjacent, reasoning that recall would still bring them back. That
  holds on chat turns, but triage and noticing don't recall: they see only the
  care list, and they run when my human has gone quiet. The review text, the
  `high_care` description on `update_memory_by_id` and the tool description now
  say so wherever unflagging is offered. (The Familiar re-flagged the two that
  mattered once told.)

## Surface matrix (RULE C — the care block)

| Surface | Care facts |
|---|---|
| Web live turn (ward) | yes — `enrich()` |
| Web tool rounds | rides the turn's prompt |
| Discord ward DM | yes — `enrich()` ward-private |
| Discord villager / group / ambient | **never** (gated) |
| Voice call (ward) | yes — `/api/chat` → `enrich()` |
| Silence triage | yes — whole set |
| Noticing | yes — whole set |
| Warm reach-out, pondering | no (not chosen) |

## Tests

`phylactery/tests/test_identity_lean.py` (rule, budget, care landing, auto
flag, care list) + the two updated cases in `test_graduation.py`;
`tests/identity-lean.test.mjs` (care block + group-room gate, budget note,
JS↔Python parity, steering text, rubric register). Each guard was watched red
with its old behaviour reintroduced. 0.14.71 adds `tests/care-flag.test.mjs`,
which runs the real `save_memory` / `update_memory_by_id` executors through the
real thalamus wrapper into a stub Phylactery client
(`__setPhylacteryClientForTest`), and a Phylactery case pinning that the
explicit weight decides over the wording on create and on update.
