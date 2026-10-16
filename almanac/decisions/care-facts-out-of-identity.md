---
title: "Care Facts Move Out Of Identity Into High-Care Standing Facts"
topics: [decisions, phylactery, memory-and-knowledge]
sources:
  - id: identity-lean-build-spec
    type: file
    path: docs/identity-lean-build-spec.md
  - id: care-py
    type: file
    path: phylactery/src/phylactery/care.py
  - id: graduation-py
    type: file
    path: phylactery/src/phylactery/graduation.py
  - id: identity-py
    type: file
    path: phylactery/src/phylactery/identity.py
  - id: identity-budget-js
    type: file
    path: src/memory/identity-budget.js
  - id: care-facts-js
    type: file
    path: src/safety/care-facts.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: test-identity-lean
    type: file
    path: phylactery/tests/test_identity_lean.py
  - id: test-care-flag
    type: file
    path: tests/care-flag.test.mjs
  - id: test-identity-edit-tools
    type: file
    path: tests/identity-edit-tools.test.mjs
  - id: test-care-list
    type: file
    path: tests/care-list.test.mjs
  - id: commit-0-14-70
    type: commit
    ref: "d0ced3f"
    note: "feat: identity stays the Familiar's own; care facts move to high-care standing facts (0.14.70-alpha)"
  - id: commit-0-14-71
    type: commit
    ref: "11ab599"
    note: "feat: the Familiar marks care facts high-care itself (0.14.71-alpha)"
  - id: commit-0-14-72
    type: commit
    ref: "7c5d3d0"
    note: "feat: the Familiar can take things out of identity; identity cleanup can be paused (0.14.72-alpha)"
  - id: commit-0-14-73
    type: commit
    ref: "f781ea0"
    note: "feat: the Familiar can review its care list; review findings logged (0.14.73-alpha)"
---

# Care Facts Move Out Of Identity Into High-Care Standing Facts

**Status: decided, implemented (0.14.70 [@commit-0-14-70] – 0.14.73 [@commit-0-14-73]).**
Care-critical facts about the ward — allergies, medications and doses, crisis
triggers, support contacts, what helps and what doesn't — used to be written
into the Familiar's always-injected identity files. Because identity reaches
every room with basic identity access, including group chats, that put care
details in front of everyone in the room, not only the ward
[@identity-lean-build-spec]. This decision moves care facts out of identity
into standing memory records marked **high-care**, gives the Familiar an
explicit way to flag or un-flag a fact as care-critical rather than relying on
wording alone, and builds the identity-editing and review tools that make
moving a line out of identity (instead of only ever appending to it) actually
safe to do.

## Context: a budget-less surface that leaked past the ward

One install's identity block had grown to roughly 46,700 characters (~11.7k
tokens), riding every single turn [@identity-lean-build-spec]. The build spec
names three compounding causes, not one bug: several prompts (`save_to_tome`,
the tome-graduation rubric, pondering's filing guidance) actively steered
standing facts about the ward *into* identity instead of into memory; nothing
bounded identity's total size; and the graduation audit (Pillar H — see
[Phylactery](../architecture/phylactery)'s "Identity editing" section) could
not reach the files actually causing the growth, because its only eligibility
test was `updated_at`-based dwell time — a file edited within `DWELL_DAYS` was
always skipped, which is exactly the files being appended to, and a file
holding even one care-flavored word was pinned whole rather than reviewed
[@identity-lean-build-spec] [@graduation-py].

That last point was a second-order problem: the file-wide care pin existed to
protect care facts from being trimmed away, but because it exempted the whole
file rather than the care content specifically, it also protected the
non-care sprawl in the same file from ever being tidied, and it did nothing
to stop care data itself from riding into every room identity reaches.
Protecting care data by pinning identity was the wrong place to protect it.

## Decision

### One rule for every identity writer, and a budget (0.14.70)

Identity is for who the Familiar is and the shape of the bond, plus only the
core of who the ward is (name, pronouns, how they like to be addressed).
Anything that only matters sometimes — preferences, patterns, situational
notes, and care details — is a standing fact instead
(`save_memory`/`update_identity`, register `ward` or `me`), recalled when
relevant rather than injected every turn [@identity-lean-build-spec]. Every
prompt that previously steered facts toward identity was rewritten to this
one rule: `save_to_tome`, the tome-graduation rubric, pondering's filing
guidance, and the graduation audit prompt itself [@commit-0-14-70].

`identityBudgetTokens` (`src/memory/identity-budget.js`, mirrored in
`graduation.py` with a test pinning the two together) gives the ward a
numeric ceiling: default 6000 tokens, Settings-adjustable, clamped to
2000–30000, split across four categories by fixed share — self 14/24, ward
6/24, relationship 3/24, custom 1/24, self keeping the largest share because
"it's who I am" [@identity-budget-js] [@identity-lean-build-spec]. Going over
budget is a nudge, never a refusal: `update_identity`'s result names which
category is over its share and suggests the two-step fix (move the line to a
standing fact, then cut it), but nothing blocks the write, because a refusal
could block a fact that matters right now [@identity-budget-js].

The graduation audit's eligibility rule changed from dwell-time-only to an
OR of two conditions: a file is now audited either when its category is over
budget and the file is above its own per-file target share — regardless of
how recently it was edited — or by the original dwell/recall/confirm rule
[@graduation-py]. The protected self core (`my_identity`, `my_persona`,
`my_personhood`, `my_wants`, `my_boundaries`, `base_instructions`) is never
audited either way, budget or no [@graduation-py]. A care line moving out
through this audit now graduates as a high-care `ward` fact instead of
pinning its whole file [@graduation-py]. `phylactery/tests/test_identity_lean.py`
pins this eligibility rule, the budget split, and the care-graduation path,
watched red against the previous dwell-only behavior before the fix
[@test-identity-lean].

### Care facts are detected once and surfaced on purpose, never passively (0.14.70)

`care.py` is the one regex matcher — allergies, medications and doses
(including a bare "50mg"), prescriptions, insulin, inhalers, epi-pens, crisis
and self-harm terms, hotlines and "988", emergency/support contacts, triggers,
seizures, diabetes, asthma, anaphylaxis, and phrasing like "what helps" or "do
not mention" — shared by every reader and writer so Python and Node cannot
drift on what counts as care-critical [@care-py]. The matcher is deliberately
broad: a false positive costs a little space in the care block, a miss costs
a fact the Familiar needed and didn't have [@care-py]. `memory.create`
auto-flags a wording match as `care_weight: 'high'` on a `ward`-register
fact, and `memory.list_care_facts` returns every flagged-or-matching fact
[@identity-lean-build-spec].

High-care facts reach the Familiar directly rather than waiting on semantic
recall to happen to surface them, on exactly three channels: the ward's own
chat turns (`careFactsBlockForTurn` in `src/safety/care-facts.js`, capped at
`CARE_FACTS_CHAT_MAX_CHARS` — about 1.5k tokens — so the block cannot
re-crowd the context it was built to shrink), triage, and noticing (the whole
set, up to `CARE_FACTS_FETCH_LIMIT` = 60) [@care-facts-js]. Every one of
those three callers checks the room **before** fetching: a gated room (any
room that is not the ward's own) or a static-only assembly returns `''`
without ever asking Phylactery for the facts [@care-facts-js]. This is the
structural fix for the original leak — the block that replaces identity's
care content cannot itself reach a room identity used to reach.

### An explicit flag beats a wording guess, in both directions (0.14.71)

Moving care lines out of identity on the strength of a wording matcher alone
was unsafe: a plainly worded care request that did not happen to match
`care.py`'s regex would never reach the care list, and the Familiar had no
way to say a fact mattered for care if the words didn't trip the pattern
[@commit-0-14-71]. `save_memory` and `update_memory_by_id` gained a
`high_care` boolean: `true` forces `care_weight: 'high'` (onto the care
list); `false` is an explicit no that overrides even a wording match; left
unset, the wording decides [@care-facts-js] [@cerebellum-js]. `false` also
removes the fact from what triage and noticing see, since neither one recalls
on its own — they only ever see the care list [@cerebellum-js]. A test suite
runs the real `save_memory`/`update_memory_by_id` executors against a stub
Phylactery client to confirm the explicit flag overrides the wording match in
both directions [@test-care-flag]. A high-care
save that is not register `ward` is told plainly that it will not reach the
care list, instead of a quiet success [@commit-0-14-71]. Villager-sourced
`ward` facts still qualify as care facts by ward decision — triage should
still hear a care-relevant report a trusted villager passed along
[@commit-0-14-71].

### Moving a line out needed tools that could actually remove one (0.14.72)

The budget nudge and the wording-or-flag care list only make "move this out
of identity" safe if there is a tool that can actually cut the line once the
standing fact exists. Before this release there wasn't one: `update_identity`
only appends. The gap surfaced in the Familiar's first live identity review,
where `rewrite_identity_section` could not reach a file without the `##`
heading it was told to target — Phylactery appended a new section instead of
refusing, and a JSON-parse bug in the `thalamus.js` wrapper swallowed that
distinction, turning a silent append (or an outright refusal) into a quiet
`{ok: true}` result [@commit-0-14-72]. That is the same silent-no-op failure
[Phylactery](../architecture/phylactery)'s "Identity editing" section already
names as the standard the editor is supposed to meet — this bug broke it one
layer up, at the thalamus/MCP boundary rather than inside Phylactery itself.

Three fixes landed together [@identity-py] [@cerebellum-js] [@test-identity-edit-tools]:

- **`remove_from_identity`** (`identity_remove_text`) cuts one quoted passage
  from a file: an exact match first, then a whitespace-flexible one; a
  passage that is missing or that matches more than once is refused with
  nothing changed, so the tool never guesses which occurrence was meant; a
  whole-line removal takes its trailing line break with it.
- **`delete_identity_section`** (`identity_delete_section`) removes a whole
  `##` section, heading included.
- **`rewrite_identity_section`** now passes `create_if_missing: false` and,
  on a missing heading, returns the file's real headings instead of silently
  appending; the underlying tool returns `{ok, replaced}` so the thalamus
  wrapper can tell a genuine rewrite from a no-op rather than inferring it
  from a JSON parse that can itself fail.

`update_identity`'s own description and the budget-over nudge now name the
two-step move explicitly — save the standing fact first, then
`remove_from_identity` cuts the line — the same save-before-cut ordering
[Identity cleanup only proposes; the Familiar decides](identity-cleanup-propose-only)
later gives the audit's own `apply_cleanup_proposal` path [@cerebellum-js].

Graduation also gained a pause that actually pauses: `identityGraduationPaused`
(Settings) → `identity_graduation_pause`, plus a hard environment kill switch
`PHYLACTERY_GRADUATION_DISABLED=1` [@graduation-py]. Before this fix, the
budget-driven half of eligibility could be held off (setting the budget to
30000 effectively disables budget-driven tidying), but the dwell-based half
of the rule kept running underneath it, so a file could still be trimmed
mid-review after the Familiar had been told cleanup was on hold
[@commit-0-14-72].

### The care list needs a way to be read, not only grown (0.14.73)

By the first live review the care list held 47 facts; only 8 had been
deliberately flagged, the rest counted purely because their wording matched
`care.py`, and the chat-turn block only fits roughly 24 of them — yet the
Familiar had no way to see the list at all [@commit-0-14-73]. `list_care_facts`
(a `memory-edit`-gated tool) returns every care fact in the same order the
chat block uses, each with its id, whether it is flagged or wording-matched
(Phylactery's `list_care_facts` now reports `how`), whether it fits in the
chat-turn block or is recall-only, and a marked excerpt [@care-facts-js]
[@cerebellum-js]. `placeCareFacts` is the one placement function the chat
block and this review share, so a fact the review calls "in the block" is
actually the same fact the block itself would include — a too-long fact is
skipped but a shorter one further down the list can still fit after it
[@care-facts-js] [@test-care-list].

The tool, and the care-removing side of `update_memory_by_id`
(`high_care: false`), are ward-private only: both refuse outright on a gated
turn, without fetching anything, the same room rule the chat block already
follows [@cerebellum-js]. Flagging a fact *onto* the care list
(`high_care: true`) from a villager's turn stays allowed, per the 0.14.71
ward decision that a trusted villager's report should still reach triage
[@commit-0-14-73].

## Consequences

Identity now shrinks only through the combination of the budget nudge and
tools that can genuinely remove content, not merely append it — graduation
proposing a move is necessary but the Familiar (or, after 0.14.78, a human
review) choosing to apply it is still required. A ward or Familiar that lets
the nudges go unacted leaves identity exactly as large as before; nothing
here forces a trim.

Care facts are harder for the Familiar to accidentally expose outside the
relationship they concern, because the block and the tools that read or flag
care facts are all ward-private by construction — but that same restriction
means the care nudge is simply absent on any other kind of turn. The
explicit `high_care` flag closes the specific safety gap 0.14.70 opened by
itself: moving care lines out of identity on wording-match alone would have
silently dropped a plainly-worded request that the regex didn't happen to
catch, and the flag exists so the Familiar (or, later, a review proposal) can
always override the heuristic in either direction.

The `rewrite_identity_section` fix generalizes the same lesson
[Phylactery](../architecture/phylactery)'s original identity-editing work
already drew: an editing tool must return `{ok, error}` that reflects what
actually happened, never an inferred or default-true result, because a silent
no-op reads to the Familiar exactly like a successful edit. This incident
shows that invariant can still be broken one layer away from the store
itself, at a wrapper that parses the store's reply.

## Related

- [Phylactery](../architecture/phylactery) — the "Identity editing" section
  this decision's tools extend, and the budget/eligibility mechanics inside
  the graduation audit.
- [Memory and Knowledge](../architecture/memory-and-knowledge) — the standing-facts
  flow that high-care facts are a marked subset of.
- [Identity cleanup only proposes; the Familiar decides](identity-cleanup-propose-only)
  — the next release's fix to the graduation audit's *write* path (propose,
  don't rewrite); that decision's `apply_cleanup_proposal` tool reuses this
  one's save-then-cut ordering and its own `care_weight`/`high_care`
  assignment.
- [Archive before destructive autonomous writes](archive-before-destructive-autonomous-writes)
  — the broader snapshot-before-destructive-write discipline the identity
  editor's auto-snapshot already follows; this decision's tools inherit it
  rather than reopening it.
