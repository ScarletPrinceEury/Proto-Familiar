# Build spec: audit-fix pass (from docs/audit-2026-07-23.md)

Instruction sheet for the implementing agent. Read `CLAUDE.md` in full before
touching anything — the proactivity rules, the safety-file sign-off list, the
versioning scheme, and the "every build-spec pass ships at least one PIPELINE
test" rule all bind here.

**Sign-off status:** the ward has read the audit findings and this spec is
their direction. For the safety-critical files touched below (crisis-signals,
the noticing/triage window inputs), THIS DOCUMENT is the ward sign-off — but it
covers exactly the changes specified. If implementation forces a deviation
that changes *when or whether the Familiar acts*, stop and ask; don't improvise.

**Order of work:** Task 1 (crisis damping) first — it's the safety fix. Then
Task 2 (audience membership rework — the largest). Tasks 3–6 in any order.

**Versioning:** Task 2 is a user-visible behavioral/privacy rework → it lands
as the MINOR bump for this delivery (one milestone = one minor). Everything
else in this pass rides PATCH bumps under it (or the same commit set).

---

## Task 1 — crisis-signals: stop severe patterns self-damping (safety, ward-signed)

**Problem (verified live):** the damping context window (±50 chars around a
match) includes the matched text itself. Signals whose own grammar contains a
blocker word damp themselves:

- `"I don't want to be here anymore"` → suicidal_direct damped to **1.6** (should be 8)
- `"I don't feel like myself"` → dissociation damped to **0.4** (should be 2)
- `"it doesn't feel real"` → 2, undamped — inconsistent, only because "doesn't"
  isn't a blocker

**Fix (in `crisis-signals.js` `scoreMessage`):** build the damping context
EXCLUDING the matched span:

```js
const ctx = message.slice(ctxStart, m.index)
          + ' '
          + message.slice(m.index + m[0].length, ctxEnd);
```

That single change preserves every intended damp (in "I don't want to die",
"don't" sits *outside* the `want to die` span; "going to die of laughter" keeps
its hyperbolic damp) while killing the self-damp class wholesale — it's the
root-cause fix, not a per-pattern patch. Add a comment stating the invariant:
*a signal's own wording can never damp it; only surrounding context can.*

**Do NOT** add new blockers, reweight tiers, or touch the damp factor in this
task. (Optional follow-up for a separate ward conversation: adding `doesn't`
to NEGATION_BLOCKERS becomes safe under span-exclusion, but that's a
behavioral change needing its own look.)

**Tests (mandatory — the current test MASKS the bug with `levelMin: 1`):**
assert exact weights, not floors:

- `"I don't want to be here anymore"` → level 8, `damped: false`
- `"I do not want to exist"` → 8, undamped
- `"I don't feel like myself"` → 2, undamped
- `"I don't want to die."` → still damped (~1.6) — genuine negation preserved
- `"What if someone says they want to die?"` → still damped — hypothetical preserved
- `"dying of laughter"` idioms → still damped/zero as today

Then sweep the existing suite for other `levelMin`-style assertions on severe
messages and tighten them to exact expected values. Run the full JS suite.

---

## Task 2 — audience gating: circle MEMBERSHIP replaces the scalar trust score (ward direction)

**Problem:** `visibleAudiences(roomTag, registry)` ranks circles by
`permissionScore` and lets a room see every record whose circle scores ≤ the
room's. Two unrelated circles with identical grants ("Family", "Work") thereby
see records tagged for *each other*. Trust is not a total order.

**The ward's direction, verbatim intent:** extend the existing
Villagers/Group-Chats mechanism to the audience mechanic. A record tagged for
circle X surfaces in a room **iff everyone actually in that room belongs to
circle X** — set membership, not score comparison.

### 2.1 Semantics (normative)

- A villager's *membership set* = `v.categoryIds ∪ {CATEGORY_STRANGERS}`
  (everyone is at least a stranger; a villager with no categories → strangers
  only). An unresolved/unknown participant → `{CATEGORY_STRANGERS}`.
- A room's *circle-visibility set* =
  - ward-private session → `null` (no filter; ward sees all — unchanged);
  - otherwise: the **intersection** of every participant's membership set,
    further intersected with the location's set when a location is present:
    `{assignedCategoryId, CATEGORY_STRANGERS}` for an assigned location,
    `{CATEGORY_STRANGERS}` for an unassigned one (an unenumerable readership
    is only ever provably strangers + the circle the ward assigned it).
- A record surfaces iff its stored `audience` tag ∈ the room's set.
  `'ward-private'` is never in any gated room's set. A record tagged with a
  deleted/unknown category id is in no set → hidden (fail-closed, preserved
  from today).

**Consequences to preserve in tests:** a Family DM sees Family-tagged and
strangers-tagged records, never Work-tagged — *even at identical grant
scores*. A mixed Family+Work room sees only strangers-tagged records (or a
circle both participants share). A multi-circle villager (Family AND Work)
sees both in their own DM. Strangers-tagged records remain visible everywhere
gated (they're the broadest circle by construction).

### 2.2 Implementation surface

- **`audience.js`:** rewrite `visibleAudiences`. Its input must become the
  session audience (participants + location), not just the room tag — change
  the signature to `visibleAudiences(sessionAudience, registry)` and derive
  membership as above. Reuse `resolveParticipant` (the existing
  villager/alias matcher — that IS the Villager mechanism being extended).
- **`audienceTagFor` (write-time room tag):** re-derive on the same footing —
  the tag is a circle **all participants share**: intersect membership sets
  (with the location constraint), then pick the most-trusted shared circle.
  `permissionScore` survives ONLY as this tie-breaker among *shared* circles;
  empty intersection → `CATEGORY_STRANGERS`. Ward-private paths unchanged.
- **Callers (grep for every one; known seams):** `server.js` `/api/chat`
  (has `sessionAudience` in hand), `discord-gateway.js` `resolveLocationGate`
  (has `audienceInput`). Both already hold exactly the input the new signature
  needs — that's the point: one gate input shape, everywhere.
- **Unchanged:** the Phylactery/Python side (`audiences` stays an array of
  tags → SQL `IN`, fail-closed `[]`/`0=1`); the per-topic content gate
  (`topicGrantsForRoom` — the *what-kind* axis composes on top exactly as
  today); `resolveAudience`/grant union/intersection (grants still govern
  *capabilities*; this task changes *record visibility*); write-time
  `deriveMemoryAudience`/`deriveNodeAudience` (they emit a circle tag —
  unaffected). `mostRestrictive`/`audienceScore` keep score-based narrowness
  for write-time tighten/widen for now; leave a comment flagging them for the
  same membership treatment in a later pass.
- **No data migration:** stored audience tags are already circle ids.

### 2.3 Tests (this is the pass's mandatory PIPELINE test)

Unit: every consequence bullet in §2.1, plus location-ceiling cases and the
deleted-category fail-close. Pipeline: one test that drives a **gated Discord
recall end-to-end** — build a toolCtx via the real `resolveLocationGate` with
a real registry fixture, through `discordReadAudiences`, and assert the exact
`audiences` array that would reach `memory_search` for (a) a Family DM,
(b) a mixed Family+Work room, (c) a stranger. This is the seam the old scalar
bug lived behind; pin it.

### 2.4 Docs — same commit

Update `docs/village-support-design.md` (audience resolution section),
`docs/content-gating-build-spec.md` where it describes the coarse floor, the
Phase 4 notes in `CLAUDE.md` (the "most-permissive tier wins" phrasing there
refers to the *topics* axis and stays; make sure nothing still describes the
coarse floor as score-ordered), and `docs/architecture.md` Pillar E.

---

## Task 3 — local-naive normalization at Unruh's read boundary (+ the two UTC call sites)

**Problem:** `schedule.get_window` string-compares caller-supplied
`from_ts`/`to_ts` against ward-local-naive stored values without
normalization. Node call sites passing UTC `toISOString()` bounds get windows
shifted by the UTC offset on cross-zone servers (the 0.7.86 bug class):
`server.js gatherNoticingWakeInputs`, `cerebellum.js decideTriageViaLLM`'s
candidate-tasks scan.

**Fix, both halves:**

1. **The seam (robust half):** in `unruh/src/unruh/schedule.py get_window`,
   run `to_local_naive()` on caller-supplied `from_ts`/`to_ts` before use.
   Grep Unruh's other read tools for the same gap (`schedule_find` has no
   bounds; check `reminders_due`/`intention_due` `now` params — normalize any
   that accept a timestamp and don't already). Note in a comment: offset
   conversion uses the TZ env, which thalamus sets to the ward's zone at
   spawn; on native Windows TZ is a no-op and server-local == ward-local.
2. **The call sites (correctness at the source):** replace the UTC
   `toISOString()` bounds in the two Node sites with ward-local-naive
   rendering — the pattern already used by `/api/temporal/schedule`
   (`wardLocalShiftedISO`) and the reflection assembly (`teNaive`). Extract
   the shared helper into `relative-time.js` rather than a third private copy
   (the no-copy-paste rule).

**Sign-off note:** these are noticing/triage input paths. The change makes the
windows *match their documented intent* (ward-local); it adds no gate, no
clamp, no new condition. That is what's signed off — nothing else.

**Tests:** Python — `get_window` with a `Z`-suffixed bound returns the same
rows as the equivalent local-naive bound (set TZ in the test). JS — the
extracted helper's unit tests (DST-boundary date included).

---

## Task 4 — ward Discord DM turns must not end in dead air

**Problem:** in `discord-gateway.js handleTurn`, a tool chain that ends with
no closing text (WITHOUT hitting the round cap) takes the "stayed quiet"
branch. Right for ambient rooms; for the ward's direct message it's the exact
silent-turn failure RULE B exists to prevent.

**Fix:** when `decision.isWard` and the tool loop returns empty/blank
`rawReply` (and the turn isn't an ambient abstain/defer), force ONE closing
text round: re-call with tools stripped plus the same first-person
budget-note pattern `runToolCallLoop` uses for cap exhaustion (reuse that
string/mechanism — don't write a second variant). Only if THAT also comes back
empty, keep today's quiet path and log it loudly. Villager/ambient behavior
unchanged.

**Test:** unit-level with a stubbed provider: ward turn whose first response
is tool_calls and whose follow-up is empty → assert a second forced-text call
happens and its text is delivered.

---

## Task 5 — regression pipeline test for the consent-menu memory path

0.9.25 fixed `getMemoriesBySubject` referencing a nonexistent variable — a
ReferenceError swallowed by `.catch(() => ({ items: [] }))` for its entire
life. Add the test that would have caught it: exercise `consentStateFor`
(discord-gateway) with a stubbed MCP client that RECORDS the tool call —
assert `memory_list_by_subject` is actually invoked with the villager id and
its items reach the returned state. The assertion "the tool was called" is the
regression guard; a future rename that throws will fail it.

---

## Task 6 — small chores (one commit, patch-level)

1. `server.js` `_chatRateCounts` never prunes: sweep expired entries on each
   rate-limit check (entries whose `resetAt` passed), or cap the Map size.
2. `docs/architecture.md` reminders-loop row: mention the weather-refresh and
   elapsed-stamping passes that ride the same tick.
3. `CLAUDE.md` CodeAlmanac section: add one sentence scoping the "every
   session" rule to environments where `codealmanac` is installed (ephemeral
   CI/cloud containers can't run it; sessions there should note skipped
   almanac work in the commit/PR body instead).
4. `Research/SampleLB12122025.json` looks like a stray data sample — confirm
   with the ward before deleting; if load-bearing, move it under
   `docs/research/` with a line saying what it is.

---

## Definition of done

- All three suites green (`npm test`; `uv run pytest` in `unruh/` and
  `phylactery/`), with the Task 1 exact-weight tests and the Task 2 pipeline
  test present and passing.
- Docs updated in the same commits as their code (Task 2.4, Task 6.2).
- Version: MINOR bump for Task 2's landing; mention it in the commit body.
- Nothing in any prompt or gate got quieter, later, or more conditional than
  this spec states — if it did, that's a stop-and-ask, not a ship.
