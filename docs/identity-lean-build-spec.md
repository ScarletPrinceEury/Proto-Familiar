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
with its old behaviour reintroduced.
