---
title: Trackers
topics: [architecture, memory-and-knowledge, trackers]
sources:
  - id: tracker-py
    type: file
    path: unruh/src/unruh/tracker.py
    note: "contains expiring_items function (§4 inventory-expiry projection) and EXPIRY_LEAD_DAYS constant"
  - id: tracker-test-py
    type: file
    path: unruh/tests/test_tracker.py
  - id: trackers-tb-test-mjs
    type: file
    path: tests/trackers-tb.test.mjs
  - id: thalamus-wrappers
    type: file
    path: thalamus.js
    offset: 1075
    limit: 80
  - id: cerebellum-tools
    type: file
    path: cerebellum.js
    offset: 1967
    limit: 100
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
  - id: server-js
    type: file
    path: server.js
    offset: 802
    limit: 10
  - id: tracker-projections
    type: file
    path: src/tracker/tracker-projections.js
    note: "contains buildEatFirstBlock function that renders the [Pantry — use first] block, and discussingFood (0.14.12 active food cue)"
  - id: tracker-projection-py
    type: file
    path: unruh/src/unruh/tracker_projection.py
    note: "T-C.3a: project_nodes() reconciles pantry reminder + menses hold schedule nodes"
  - id: tracker-projection-loop-js
    type: file
    path: src/schedule/tracker-projection-loop.js
  - id: pondering-js
    type: file
    path: src/pondering/pondering.js
    offset: 155
    limit: 45
    note: "buildReflectionPrompt's windowSeries/watchdog rendering (T-C.3b.1)"
  - id: server-reflection-js
    type: file
    path: server.js
    offset: 6120
    limit: 25
    note: "getReflectionInput() assembling windowSeries via tracker_reflection_series"
  - id: offer-tracker-js
    type: file
    path: src/tracker/offer-tracker.js
  - id: tracker-cues-js
    type: file
    path: src/tracker/tracker-cues.js
  - id: thalamus-cues
    type: file
    path: thalamus.js
    offset: 2405
    limit: 30
    note: "[Tracker cues] wiring — staleness-based ledger nudge, §5.3"
---

# Trackers

Trackers are the ward's private ledgers — habit logs, inventory lists, gauges, and state machines that the Familiar helps maintain. They are part of the [situational facts and trackers](phylactery) layer that Phylactery stores alongside identity and memory. T-B.1 (version 0.14.1-alpha) brought trackers into the live chat path with a full Node bridge, ward-only tool access, and automatic surfacing based on tracker labels and tracking-related language.

## The four archetypes

Trackers come in four shapes, each suited to a different kind of pattern [@tracker-py]:

- **State**: One field, one current value. Examples: laundry status (clean/in-progress/dirty), work mode (focus/collaborative/break). The tracker holds the current value and its history.
- **Inventory**: A collection of named items, each with attributes. Example: a pantry where each item tracks quantity, expiry date, and type. Each item is keyed by its `name` field, so adding milk twice updates the existing milk entry instead of creating a duplicate.
- **Series**: Dated entries over time. Examples: mood log, sleep log, medication tracking. Entries are timestamped and can be read over a window of days.
- **Gauge**: A decaying refill-based metric. Examples: hydration level (refills when the Familiar logs "just drank water"), meal satiety (refills when meals are logged). The level is derived from time since the last refill and a configurable decay curve, never set by hand. The Familiar logs events; code derives the current level and compares it against bands (fine, fading, low, overdue, extreme) [@tracker-py].

All trackers enforce exact-value discipline: the model never computes or sets a level — it logs events and code derives everything else. Schema validation, type checks, and the daily entry cap all live in `validate_entry`, the code gate every write passes through [@tracker-py].

## The Node bridge (T-B.1)

T-B.1 adds three integration layers that bring trackers into the live chat:

**Thalamus wrappers** (`thalamus.js`) degrade gracefully and never throw, following the [graceful degradation](../reference/engineering-conventions) pattern. Each wrapper calls the matching `tracker_*` MCP tool on Unruh: `createTracker`, `createTrackerFromTemplate`, `logTrackerEntry`, `readTracker`, `listTrackers`, `adjustTracker`, and `supersedeTrackerEntry` [@thalamus-wrappers]. A failed tool returns `{ok:false}`, not an exception, so the Familiar can handle tracker unavailability without losing a turn.

**Cerebellum tools** (first-person, ward-only, via `quietOk`) surface the tracker operations as first-class Familiar actions: `tracker_list`, `tracker_create`, `tracker_create_from_template`, `tracker_log`, `tracker_read`, `tracker_adjust` [@cerebellum-tools]. The visible-failure rule (RULE B in the build spec) means a failed or refused log is never silent — it renders as "nothing was recorded" so the Familiar and ward both know the entry did not stick. `tracker_supersede` stays HTTP/UI only; the Familiar corrects via `tracker_log`'s `supersedes` argument instead [@cerebellum-tools].

`renderTrackerRead` summarizes a read result gap-neutrally, never using streaky language like "broke your streak" or "missed a day" — invariant T4 ensures the rendering matches the psychology of actual habit-tracking, not the scorekeeper's rhetoric.

**Tool surfacing** (`tool-surfacing.js`) brings trackers into scope automatically via three channels [@tool-surfacing-js]. See [Tool Surfacing and Provider-Safe Ceiling](tool-surfacing) for the full system description, including context-sensitive module selection, the provider-safe ceiling mechanism, and how `request_tools` recovery works.

For trackers specifically:

1. Static vocabulary: words like "mood", "sleep", "hydration", "pantry", "laundry" and actions like "log", "add to", "how are my" all surface the `trackers` module automatically.
2. Registry regex: an existing tracker's own label (e.g., "spoons" energy tracking) surfaces the module if that label is mentioned, generated from `trackerTermsRegex(trackerLabels)` applied to the turn text.
3. Dynamic block: a `[Tracker cues]` block in the prompt surfaces the module, used when the Familiar is deciding whether to proactively check on a gauge.

Surfacing is gated by `trackersEnabled(settings)` / `PROTO_FAMILIAR_TRACKERS_DISABLED`, which defaults ON and is inert until a tracker exists [@server-js].

## Access control: fail-closed ward-only gate (invariant T2)

Tracker tools never appear in `villagerToolNames`, the fail-closed allowlist of what a Discord visitor or party guest can reach [@trackers-tb-test-mjs]. This means a villager turn, no matter what category grants they hold, cannot reach any tracker tool — tracker data is the ward's private patterns, never disclosed to a visitor. The gating lives in the allowlist, not in the tool registry: a visitor's compose call runs `composeDiscordTools` which routes through `villagerToolNames`, and the tracker tools simply are not there.

The fail-closed contract (invariant T2) is verified by three test assertions [@trackers-tb-test-mjs]:

1. `villagerToolNames` never contains a tracker tool, even at the highest grant level.
2. A full-grant Discord villager's tool set contains no tracker tools.
3. The ward's tool set does contain them when the `trackers` module is surfaced.

## Tool boundary guards (invariant T3)

Each tracker tool enforces its required arguments at the JavaScript boundary before ever reaching Unruh [@trackers-tb-test-mjs]. A `tracker_log` without a `tracker_id` refuses visibly ("tracker_id (string) is required") and records nothing — no silent success, no half-logged entry. This guard is redundant with Unruh's own `validate_entry` gate, but the redundancy is intentional: the boundary check fails fast without an MCP round-trip, and visible refusal prevents the "Familiar claimed it saved something but it didn't" class of bugs.

## Tests

`tests/trackers-tb.test.mjs` covers the three T-B.1 invariants: fail-closed gating (T2), surfacing selection (static vocabulary + registry + block), and tool-boundary arg guards (T3) [@trackers-tb-test-mjs]. The deeper validation gate — unknown-field drop, type checks, missing-required field, and daily entry cap — lives in Unruh's `validate_entry` and is covered by `unruh/tests/test_tracker.py` [@tracker-test-py].

## Inventory expiry tracking: "use first" (0.14.7)

Inventory-type trackers (the pantry archetype) can track expiry dates for each item via a per-tracker `project_dates` configuration flag. When enabled, Unruh's `expiring_items(conn, within_days=3, now)` query finds all items expiring within the lead window (default 3 days), including already-expired items, sorted soonest-first [@tracker-py].

The query is a pure derivation: code owns the date math, the model never computes days-left. Unruh exposes this via `tracker_expiring` MCP call, wrapped in thalamus as `trackerExpiring()`. The server injects the result into ward-only enrich contexts as a `[Pantry — use first]` block via `buildEatFirstBlock` in `src/tracker/tracker-projections.js` — rendering the item names with their days-left (e.g., "milk (2d) · cheese (today) · yogurt (expired)") up to a cap of 4 items, with a "+N more" tail if the pantry has overflow [@tracker-projections].

The lead window (3 days by default) is tunable via `EXPIRY_LEAD_DAYS` in the Python tracker layer. The projection is pure code: no LLM, no storage, no background loop — it rides the same context-building path every ward turn uses.

## Persistent projection nodes: pantry reminders and menses holds (T-C.3a, 0.14.11)

The "use first" line above is pure derivation with nothing durable behind it — it exists only in a rendered context block and vanishes if a tick is missed. T-C.3a gives the same two projections (inventory expiry and menses prediction) durable, ward-private citizens in [Unruh](unruh)'s schedule graph: real nodes a reminder can fire against and an availability check can see. `project_nodes()` in `unruh/src/unruh/tracker_projection.py` reconciles both projections in one atomic pass; `tracker-projection-loop.js` drives it on a 30-minute tick through the `tracker_project` MCP tool and its thalamus wrapper, `projectTrackerNodes` [@tracker-projection-py] [@tracker-projection-loop-js].

- **Pantry expiry → a `reminder` node** per near-expiry item. This is a ward decision made explicitly in this milestone: the node fires a banner the moment an item enters the `EXPIRY_LEAD_DAYS` window, the active choice over waiting until expiry day or staying silent. Dedup is on the item's `entry_id` across every past resolution, fired or not, so a grocery haul mints one banner per item and no item ever re-nags once its node has fired. A still-open node whose item leaves the expiring set — consumed, superseded, or re-logged with a fresh date — is resolved `done` rather than left dangling [@tracker-projection-py].
- **Menses prediction → one `hold` node** per predicted cycle. A hold is negative space: it marks the window busy for availability checks and never fires a banner, the appropriate register for a sensitive projection the Familiar should hold quietly rather than announce. It is deduped on `cycle_index`, its times are updated in place as the prediction drifts, and it is retired (`resolution='cancelled'`) the moment a cycle is superseded or the honesty gate (fewer than two completed cycles) stops returning a window at all [@tracker-projection-py].

Both node kinds carry `payload.sensitive = true`, which `stripSensitiveScheduleNodes` removes from any gated (villager) turn's schedule view, so a projection built from private tracker data cannot leak into a Discord guest's calendar read.

The loop rides `trackersEnabled` (default ON, inert until a tracker exists) and stands down entirely at moderate-or-higher threat — a pantry banner must never fire into a crisis, the same posture [Autonomous loops](autonomous-loops) already gives needs-tracking and warm reach-out. Its own hard off-switch is `PROTO_FAMILIAR_TRACKER_PROJECTION_DISABLED=1`, on top of the whole-feature `PROTO_FAMILIAR_TRACKERS_DISABLED=1` [@tracker-projection-loop-js].

Across all of T-C.3 — these projection nodes, the reflection inputs below, and the offer cue below — one posture holds: none of the three is composed into the Familiar's toolset. Code mints, updates, and resolves every node and count; the model reads and interprets, but never calls a tool to create or destroy one of these on its own initiative. This extends [Exact values are code's job](../decisions/exact-values-in-code) from "the model must not format an exact value" to "the model must not be handed the surface that writes one."

## Active food cue: from ambient awareness to a named moment (0.14.12)

The "use first" block was ambient on every turn — passive awareness that never insisted on itself. Nothing told the Familiar *this is the moment* when the ward actually brought food up. `discussingFood(text, itemNames)` in `tracker-projections.js` is a pure-code gate: it fires on general food/kitchen vocabulary, or when the ward names a near-expiry item directly by its own logged name (word-bounded, case-insensitive, at least 3 characters so a short name can't match inside an unrelated word) [@tracker-projections]. When it fires, `buildEatFirstBlock`'s `foodTopic` option appends one plain "bring it up now" line to the existing block, named directly with no "if it fits" hedge. No new LLM call: the gate and the extra line both ride the same enrich pass every turn already runs [@tracker-projections].

## Reflection inputs: grading a forecast against the recorded pattern (T-C.3b.1, 0.14.13)

[Pondering](pondering)'s reflection tick already grades how the Familiar's own surfacings landed — did a raised task get engaged, deferred, or ignored? T-C.3b.1 gives it a second, independent kind of evidence: whether a *tracked pattern* actually bore out a forecast, not just whether a notification was acted on. `reflection_series(conn, days=10)` in `unruh/src/unruh/tracker.py` returns, per non-archived tracker with entries in the window, a by-day array: a numeric field becomes the day's mean, an enum/text/bool field becomes the day's value(s), and — when a tracker happens to carry both an `anticipated` and an `actual` numeric field — the day also carries the mean gap between them. That gap case is written generically against any tracker with those two field names rather than hardcoded to one tracker's schema, so a future anticipated/actual tracker gets the signal for free [@tracker-py].

Each tracker's series also folds in its `entry_rate_flag` watchdog: a private signal that fires when a ledger's 7-day entry rate exceeds three times its trailing 28-day median and has logged at least 10 entries that week [@tracker-py]. `buildReflectionPrompt` (`pondering.js`) renders the series only when at least one tracker has entries that window, so an empty result costs no tokens and adds no "here's nothing" noise, and it frames the watchdog explicitly as something the Familiar *may* choose to raise gently, in its own words — never an accusation, and never something that leaves the reflection [@pondering-js]. `server.js`'s `getReflectionInput()` assembles `windowSeries` by calling the `tracker_reflection_series` MCP tool only when trackers are enabled, and treats an Unruh outage as "grade from edges and memories alone" rather than a failed tick [@server-reflection-js]. Because reflection runs entirely in ward context, sensitive trackers are included in the series — the same "held with care, not withheld" posture the hold nodes above take toward menses data.

## Offer-a-tracker cue (T-C.3b.2, 0.14.14)

The trackers build spec's §5.4 names a second proactive surface: when the ward keeps lapsing on the same kind of need with no tracker watching it, the Familiar can offer — once, gently — to start tracking it together. `offer-tracker.js` implements this as a pure-code detector over the needs ledger already fetched for the turn's recurring anchors, so the miss-counting costs nothing new: `lapseClassesFromNeeds()` counts `missed` resolutions per need-window anchor over a 30-day window (`WINDOW_DAYS`), keeping only classes at or above 3 lapses (`MIN_LAPSES`), merged by normalized label [@offer-tracker-js]. `pruneOfferClasses()` then drops any class matching a sensitive-health pattern (menses, compulsion, ritual, urge) — those concerns stay opt-in only and are never suggested by the Familiar — and any class still inside its own 30-day cooldown (`COOLDOWN_DAYS`), read from `tomes/.offer-tracker.json` [@offer-tracker-js]. Only after a class survives both filters does `nextOfferCue()` make the one `listTrackers` read needed to check whether an existing tracker already covers the concern, by token overlap between the class label and tracker labels; if none does, `buildOfferTrackerBlock` renders the `[Might be worth offering to track]` cue and the class's cooldown is stamped so the same offer will not resurface for another month [@offer-tracker-js]. The block names the recurring snag plainly and states the offer as the Familiar's own initiative, while keeping the choice to actually track it with the ward — care-first rather than deficit-framed.

**Deferred with a stated reason.** The build spec's other §5.4 lapse source, "readiness misses," is not wired in. Stewardship's readiness flag is ephemeral — it marks an approaching event with an open prerequisite, and nothing keeps a durable per-item miss ledger to count over 30 days the way the needs ledger does. `lapseClassesFromNeeds()` is written source-agnostic on purpose, so a durable readiness-lapse ledger could plug into this same detector later without reshaping it [@offer-tracker-js].

## What shipped since T-B.1, and what remains deferred

Two of the three features named as deferred when T-B.1 shipped have since landed: the stale-ledger `[Tracker cues]` renderer nudges a quiet ledger past its own `staleness_hours`, paced by an `ask_cap_per_day` cap, on live ward turns only [@tracker-cues-js] [@thalamus-cues]; and menses prediction windows and pantry/menses schedule nodes both now exist (the `[Likely period window]` block and the T-C.3a projection nodes described above). One deferral remains open:

- **Passive memorization capture** — integrating tracker entries into the [Session memorization](session-memorization) pipeline so the Familiar can ingest logged entries (source: 'inferred') into daily memory, gated by `validate_entry`. Not yet shipped as of T-C.3.

The live chat path is complete without it; it remains an additive feature.

## Related

- [Phylactery](phylactery) — the store that holds trackers alongside identity and memory.
- [Unruh](unruh) — the temporal-context specialist that stores tracker data and the projection nodes T-C.3a mints; trackers are per-embodiment like Unruh's threat state.
- [Pondering](pondering) — the reflection tick that T-C.3b.1's `windowSeries` and watchdog flags feed into.
- [Autonomous loops](autonomous-loops) — the tracker-projection loop's cadence, off-switch, and crisis-defer contract in the wider loop roster.
- [Session memorization](session-memorization) — the pipeline that might ingest tracker entries in the deferred passive-capture phase.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general discipline T-C.3a's "never in the Familiar's toolset" posture extends.
- [Engineering conventions](../reference/engineering-conventions) — the exact-values discipline and graceful-degradation rules that trackers follow.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the behavioral-change sign-off requirement mentioned in the ward-only access guarantee.
