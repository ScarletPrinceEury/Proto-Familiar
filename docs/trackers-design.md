# Trackers — design document

**Status: DESIGN (ward-directed). Implementation queued after the existing
build specs (weather → vision → voice → browser).** This is the *why and
shape* document; a build spec follows once the design settles.

## 0. What this is (and is not)

Trackers give the Familiar a way to hold **state about its human's life that
isn't a schedule item and isn't a memory**: whether the laundry is clean, what
is in the pantry and when it goes bad, where a menstrual cycle stands, how
mood has moved across a week. Pragmatic instruments, not gamification — they
exist so the ward can prepare for daily challenges and so the Familiar can
learn the prep steps and consequences that surround them. (A streak can be
*rendered* from a ledger for a ward who enjoys one — a formatter, never a
mechanic.)

The ward's three hard requirements shape everything below:
1. **Templates + full custom tooling** — common trackers work out of the box;
   the Familiar can build new ones itself.
2. **Complexity must scale down** — a laundry tracker is one fact; it must
   not carry mood-tracker machinery.
3. **Minimal questionnaires** — data arrives by inference from ordinary
   conversation, with at most an occasional, gentle clarifying question.

## 1. The core insight: three archetypes, one substrate

Every tracker the ward named — and every one we could think of — reduces to
one of three shapes, in increasing order of complexity:

| archetype | example | what it stores | hard part |
|---|---|---|---|
| **state** | clean laundry | one current value + transition history | nothing — deliberately trivial |
| **inventory** | pantry | a set of items, each with attributes (qty, expiry) | projecting item dates into time |
| **series** | mood, menses, sleep, meds | timestamped observations against a small schema | correlation & prediction |

**One store serves all three** (an Unruh migration: `trackers` +
`tracker_entries`), because the differences are in the *schema descriptor*
and the *derivations*, not the storage. A tracker row carries:

```
tracker(id slug, label, archetype, schema_json, config_json,
        sensitive INTEGER, created_at, updated_at)
tracker_entries(id slug, tracker_id, ts local-naive, payload_json,
                source, superseded INTEGER)
```

`schema_json` is a small field spec (`{name, type: enum|number|scale|
quantity|date|text, required?}`); `config_json` holds per-archetype knobs
(staleness threshold, projection rules, prediction on/off). A laundry tracker
is `archetype:'state'`, one enum field, done — requirement 2 satisfied by
construction, not by discipline.

**Templates are data, not code** (the `seed_routine.json` / requirement-
template precedent): shipped descriptor files for pantry / laundry / menses /
mood / meds / sleep that `tracker_create_from_template` instantiates. A
custom tracker is the same call with a hand-built descriptor
(`tracker_create`), which the Familiar composes itself — the schema vocabulary
is small enough to describe fully in one first-person tool description.

Unruh owns the store because tracker data is *temporal* state (the ponderings/
intentions precedent: per-embodiment, time-anchored, not canonical identity).
What IS canonical is addressed in §5.

## 2. Capture: how data arrives without questionnaires

Three paths, in priority order — the first two do almost all the work:

**2.1 Live logging in conversation (a chat tool).** The ward says "hung up
the laundry" or "we're out of milk" mid-conversation; the Familiar calls
`tracker_log(tracker_id, payload)` in the same turn. This is the common case
and it is *zero* friction — no question was asked; the ward was already
talking. A `trackers` tool-surfacing module triggers on tracker labels and
domain words **generated from the registry** (the `villagerNameRegex`
precedent: the trigger regex is built from the trackers that actually exist,
so a "pantry" tracker makes food talk surface the tools).

**2.2 Passive inference riding memorization.** The session-fact extraction
pipeline already reads every conversation once (session end / idle / sweep).
Its output schema gains an optional `tracker_observations[]` — exactly the
`schedule_refs` precedent: the prompt gets a compact legend of existing
trackers + their fields, the model tags what the conversation *revealed*
("mentioned sleeping badly", "bought groceries incl. milk"), and code
validates every observation against the schema before it lands (ids from the
legend only; malformed dropped). This is the backstop for everything nobody
logged live, and it costs **no new LLM call**.

**2.3 Clarification as a cue, never a form.** A code gate — not the model —
detects *woefully incomplete*: a required field missing on a recent entry, or
a tracker past its staleness threshold (per-tracker, in `config_json`). The
result is a **capped, aging cue line** riding existing turns (the gcal
projection-cue machinery: one or two items max, expires after a few turns,
auto-clears when the data arrives), plus a line in the noticing situation
report when genuinely stale. The Familiar then asks *one* natural question if
the moment fits — or doesn't. There is no questionnaire anywhere in the
design; there is a Familiar who knows what it doesn't know.

## 3. Surfacing & derivation: ride the temporal graph

Trackers must be *reachable by the Familiar* (the capability rule) and must
*reach the ward* through surfaces that already exist:

- **Inventory → time.** An item with a date attribute (expiry) **projects a
  schedule node** (the ward's "attach food to time nodes"): code mints/updates
  a ward-private `type:'reminder'`-class node per expiring item (dedup on
  tracker entry id), so "eat the spinach first" rides the existing reminders/
  event-alert machinery — no new loop. An "eat-first" line (code-built, sorted
  by days-left) joins the temporal context when items are near expiry.
- **State → a fact line.** Current state renders as one line in temporal
  context when relevant (config: always / when-stale / on-topic). Laundry is
  one line, sometimes.
- **Series → prediction, in code.** Where a series supports it (menses:
  cycle-length arithmetic over history; meds: next-due), **code computes the
  prediction** and projects a window node ("likely period start ±2d") the
  same way inventory projects expiry. The model reads the projection; it
  never computes a date (exact-machine-values).
- **Series → correlation, via reflection.** The mood tracker does NOT get a
  correlation engine. Series entries become **windowed inputs to the existing
  reflection pass** (which already grades consequence edges, reads
  `windowMemories`, and consumes the needs ledger): code hands reflection the
  aligned series ("mood by day; outside-time by day; med adherence by day"),
  and the model does what it's for — reads the *pattern* and writes it down
  as consequence edges (`co_occurs_with` → tentative `causes`, the existing
  noticed→suspected→confirmed ladder) or an intention ("more outside time in
  the mornings"). Counting is code; meaning is the model; storage is the
  graph that already exists.
- **Prep/consequence.** Tracker-derived facts feed the surfaces that already
  weigh preparation: an outside-tagged event + a "low spoons" mood read is
  readiness context; an empty pantry near a low-energy stretch is a surface
  candidate. These are *inputs to existing calculators*, not new ones.

## 4. The mood tracker, specifically

Hardest case, so it gets its own statement. A mood tracker here is:
- a **series tracker** (scale field + free facet tags), captured almost
  entirely by **2.2 passive inference** (mood is exactly what conversation
  reveals and questionnaires poison — asking "rate your mood 1–5" daily is
  how tracking dies) with occasional 2.3 clarifications;
- correlated **only** through the reflection ladder (§3) against the series
  the system already has: needs ledger, outside/social time (schedule +
  obstacle tags), med trackers, sleep, menses phase, threat-tier history;
- distilled (§5) into durable understanding — which is the part the ward
  actually wants for "future installations."

## 5. Portability: raw series are local, distilled understanding is canonical

The ward's goal — *"invaluable for future installations so they can get a
good idea of their wards"* — is served by a split, per the repo's canonical-
store doctrine:

- **Raw ledgers live in Unruh** (per-embodiment temporal state, like
  ponderings and intentions).
- **Reflection distills durable learnings into Phylactery** — the store that
  travels: *"my human dips reliably ~2 days before menses"*, *"outside time
  lifts mood with about a day's lag"*, *"dairy expires on them more than
  anything else"* — as standing truths / `what_lapses_cost` sections /
  knowledge-graph edges, through the existing consent-gated writers. A future
  embodiment inherits the *understanding* without needing (or leaking) ten
  thousand raw datapoints. This is tome-graduation's philosophy applied to
  time-series: gather freely, distill deliberately, let the distillate be the
  legacy.

## 6. Privacy

- `sensitive: 1` trackers (menses, mood, meds — the template default for all
  three) are **ward-private everywhere, fail-closed**: never in gated
  context, never in villager-visible legends, their projections minted as
  sensitive nodes (the spine-state `stripSensitiveScheduleNodes` machinery
  already does this for exactly this class of node).
- Non-sensitive trackers (pantry, laundry) still default ward-private;
  audience opt-in per tracker is a later, deliberate choice.
- Passive capture honors the existing memorization consent gates — an
  inferred observation about a sensitive tracker is still an inference the
  ward can see and prune (entries carry `source:
  'chat'|'inferred'|'clarified'` for exactly this audit).

## 7. What the Familiar knows (capability rule)

Same-commit requirements when this builds: first-person tool descriptions
(`tracker_create/log/read/list/adjust`), the surfacing module with
registry-generated triggers, template awareness in the tool description
("I have templates for pantry, laundry, menses, mood, meds, sleep"), and —
because the ward asked for the Familiar to *offer* tracking where useful —
one line in the relevant injected surfaces (e.g. the stewardship agenda) when
a recurring untracked pattern shows (code-detected: the same lapse class
missed N times with no tracker attached → a cue, once, with a long cooldown).

## 8. Ward decisions (open)

1. **Template set for v1** — pantry, laundry, menses, mood, meds, sleep is
   the proposed six; trim or extend?
2. **Sensitive-by-default set** — menses/mood/meds proposed; sleep too?
3. **Prediction projections** — comfortable with code-projected cycle
   windows on the schedule surface (ward-private), or opt-in per tracker?
4. **Store split confirm** — raw ledgers in Unruh, distilled learnings to
   Phylactery via existing consent gates (§5): confirm this is the
   portability shape you want.
5. **Clarification budget** — how often may the Familiar ask (proposal: the
   cue machinery's own cap — at most one clarifying question per tracker per
   day, and only when the moment fits)?
6. **Offer-a-tracker cue** — the §7 "you keep missing X, want me to track
   it?" nudge: in v1, or hold until trackers have proven themselves?
