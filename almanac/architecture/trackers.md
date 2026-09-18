---
title: Trackers
topics: [architecture, memory-and-knowledge, trackers]
sources:
  - id: tracker-py
    type: file
    path: unruh/src/unruh/tracker.py
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

**Tool surfacing** (`tool-surfacing.js`) brings trackers into scope automatically via three channels [@tool-surfacing-js]:

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

## Deferred to T-B.2

Two features are explicitly deferred and documented in the build spec, not yet shipped:

1. **Passive memorization capture** — integrating tracker entries into the [Session memorization](session-memorization) pipeline so the Familiar can ingest logged entries (source: 'inferred') into daily memory, gated by `validate_entry`.
2. **Cues** — surfacing stale or overdue gauges via a `[Tracker cues]` renderer using the Google Calendar cue machinery, which requires new Unruh MCP surface exposure.

The live chat path is complete without these; both are additive features.

## Related

- [Phylactery](phylactery) — the store that holds trackers alongside identity and memory.
- [Unruh](unruh) — the temporal-context specialist that stores tracker data; trackers are per-embodiment like Unruh's threat state.
- [Session memorization](session-memorization) — the pipeline that might ingest tracker entries in the deferred T-B.2 phase.
- [Engineering conventions](../reference/engineering-conventions) — the exact-values discipline and graceful-degradation rules that trackers follow.
- [Proactivity over caution](../decisions/proactivity-over-caution) — the behavioral-change sign-off requirement mentioned in the ward-only access guarantee.
