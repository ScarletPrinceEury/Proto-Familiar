# Trackers — build spec

**Status: SPEC — reviewed against the live architecture 2026-09 (at `0.13.1-alpha`).**
Rationale and evidence live in
[`trackers-design.md`](trackers-design.md) + [`trackers-research.md`](trackers-research.md);
this document is the implementation contract. All design/ward decisions are
RESOLVED there — a builder changes none of them. Weather and vision (the features
this was originally queued behind) are long shipped; trackers are now the active
next feature. **See "Architecture reconciliation" below for the systems that landed
since this spec was first written and how they touch trackers — including a
version-slot change and an extension to invariant T1.**

Conventions binding this spec: first-person prompts & tool descriptions;
slug ids (`insert_with_slug_retry`); local-naive time; exact machine values
in code; graceful degradation (off-switch in the same commit); ride existing
requests / gate in code; no copy-paste of substantial logic.

**Inherited from the 0.9 vision post-mortem** (CLAUDE.md, "Lessons cut into
law"): trackers add LLM *judgment* (parsing a free-text entry into a
tracker's fields, choosing which tracker a message means), so —

- **RULE A** — any parse/classify call this spec adds goes through
  `callProviderChat` (≥4000 cap + `extractContent`), never a bespoke raw
  fetch. The "ride existing requests" convention above is the first line of
  defence: a tracker entry parsed *inside* the chat turn that already
  happened is preferred to a new standalone call — but if a standalone call
  is unavoidable, it still inherits both guarantees.
- **RULE B** — a tracker parse that fails, times out, or comes back empty is
  a *visible* "I couldn't log that" to my human plus a first-person note in
  my own context that the entry did NOT record — never a silent drop the
  Familiar later claims it saved.
- **RULE C** — the surface matrix: logging a tracker entry from web chat, from
  a ward Discord DM, from a villager turn (gated), and from a background
  reflection each gets a wired-or-N/A cell in the same pass, so one surface
  isn't silently left unable to log.
- **A PIPELINE test per pass** — at least one full turn (message → parse →
  stored entry) through the real assembly with a stubbed provider, not only
  pure-function schema/validation tests.

---

## 0. Architecture reconciliation (reviewed 2026-09)

Systems that landed AFTER this spec was first written and how they touch trackers.
The spec's anchors were all verified still present (`villagerNameRegex`,
`villagerToolNames`, `quietOk`, `stripSensitiveScheduleNodes`, `windowMemories`/
`recentMissedNeeds` in the reflection payload, `scoreThreatMessage`/`recordThreat`,
`gcal-projection` cue machinery, Unruh `db.slug_id`/`insert_with_slug_retry`,
`interest.py`). The adjustments:

- **Version slot moved. ⚠️ ward-confirm.** This spec claimed the `0.13` minor.
  Cross-channel continuity (Hippocampus, Stage 3) shipped there instead
  (`0.13.0`/`0.13.1` are on main). So trackers now take **`0.14`** and the
  plugin-surface milestone after it **`0.15`** (see §9). Nothing else changes; this
  is a renumber, flagged for the ward because they set the original assignment.

- **Memory-integrity gate (Stage 1, `0.12.27`).** `processJob` now runs
  `applyMemoryIntegrityGate` on each extracted **fact** before the Phylactery write.
  §5.2 `tracker_observations` are a SEPARATE structured array (routed to Unruh, not
  Phylactery) with their own code gate (`validate_entry`) — they are NOT free-text
  facts and do NOT pass through `scanFact`, which is correct: keep the two gates
  distinct. A malformed/adversarial observation is dropped by `validate_entry` (id
  not in legend, bad type), not by the injection scan.

- **Hippocampus buffer (Stage 3, `0.13.0`) is a NEW live-prompt surface.** It
  injects a `[Recently, elsewhere]` block into every turn. Two consequences:
  (a) **Invariant T1 now extends to it** — a `moodTag` must never enter the
  Hippocampus buffer either (the buffer records message *text*, never metadata; a
  builder must not pass `moodTag` into `recordEvent`). (b) Tracker data is
  ward-private wholesale and does NOT ride the buffer; the buffer is audience-gated
  and trackers simply never write to it.

- **Content-gating (two-axis, `0.9.17`–`0.9.24`).** Governs MEMORIES, not trackers.
  Trackers stay **ward-private wholesale** (§3, §7) and deliberately do NOT
  participate in the per-topic content gate. Confirmed compatible; per-tracker
  audience opt-in remains out of scope for v1.

- **Threat seams have grown.** Chat-path scoring routes through `scoreThreatMessage`
  (`0.12.0`) and the model's own read rides `flagDistress` (`threat-tracker.js`).
  §6's mood-tag link stays a DISTINCT bounded source — a direct
  `recordThreat({delta, source:'mood-tag'})`, not message scoring — and its
  constants join the ward safety sign-off set. The guarded files are
  `crisis-signals.js` / `crisis-classifier.js` / `threat-tracker.js`; the mood-tag
  constants live adjacent and ship only with the T-D ward review.

- **Schedule-node space is now shared** by needs (`payload.need`), consequence
  edges (`on_lapse`), and elapsed stamps (`payload.elapsed_at`). §4 tracker
  projection nodes (expiry reminders, menses windows) must carry their own
  `payload.tracker_ref`/`entry_ref` and stay distinguishable from those — never
  reuse a need/consequence payload shape.

- **Migration number is concrete:** the next free Unruh migration is **`0007`** →
  `0007_trackers.sql` (highest current is `0006_locations.sql`).

- **A 4th archetype: `gauge` (§10).** A ward idea (2026-09) — decaying *upkeep*
  (eating, hydration, meds): full after the event, drains as neglected, refills on
  logging, with a check-first → crisis safety ladder at genuinely-medical extremes.
  Specified in **§10** below; it builds on this spec's store/tools/cues and rides
  the same `0.14` milestone (build passes G-A/G-B/G-C, §9). Safety-critical (threat +
  emergency-contact paths, ward sign-off).

---

## 1. Unruh store (migration `0007_trackers.sql`)

```sql
CREATE TABLE IF NOT EXISTS trackers (
  id          TEXT PRIMARY KEY,          -- slug from label ("mood-x7")
  label       TEXT NOT NULL,
  archetype   TEXT NOT NULL,             -- 'state' | 'inventory' | 'series' | 'gauge'
  schema_json TEXT NOT NULL DEFAULT '[]',-- ordered field specs (see §1.1)
  config_json TEXT NOT NULL DEFAULT '{}',-- per-tracker knobs (see §1.2)
  sensitive   INTEGER NOT NULL DEFAULT 0,
  template    TEXT,                      -- template id it was created from, or NULL (custom)
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracker_entries (
  id          TEXT PRIMARY KEY,          -- slug from tracker label + kind
  tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  ts          TEXT NOT NULL,             -- local-naive; when the observation is ABOUT
  payload_json TEXT NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL,             -- 'chat' | 'inferred' | 'clarified' | 'send-button'
  superseded  INTEGER NOT NULL DEFAULT 0,-- corrected/replaced entries stay for audit
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracker_entries_tracker_ts ON tracker_entries(tracker_id, ts);
```

### 1.1 Field-spec vocabulary (the whole schema language — do not extend in v1)

`schema_json` is an array of `{name, type, required?, values?, min?, max?, unit?}`
with `type` ∈ **`enum`** (needs `values: []`), **`number`** (optional
`min`/`max`/`unit`), **`scale`** (needs `min`,`max`; integers), **`quantity`**
(number + free `unit` string), **`date`** (local-naive ISO, day or datetime),
**`text`**, **`text[]`**, **`boolean`**. Validation is code
(`validate_entry(schema, payload)`): unknown fields **dropped**, missing
`required` fields reported (feeds the §5 cue), type mismatches rejected with
a readable error. Inventory archetype: `schema_json` describes ONE ITEM's
fields (each entry = one item upsert, keyed by a required `name` field).
State archetype: exactly one field, enforced at create. **Gauge archetype:
decaying upkeep with a check-first safety ladder — its own section, §10.**

### 1.2 `config_json` knobs (all optional; defaults in parens)

`staleness_hours` (per template below) · `ask_cap_per_day` (per template —
the WARD-DECIDED per-tracker clarification budget) · `predict`
(false; template-set) · `project_dates` (false; inventory/menses set it) ·
`watchdog` (true) · `entry_cap_per_day` (24; erp: 8).

### 1.3 `tracker.py` — pure functions over a Connection (interest.py shape)

`create_tracker(conn, *, label, archetype, schema, config, sensitive,
template=None)` · `create_from_template(conn, *, template_id)` (loads
`templates/trackers/<id>.json`) · `log_entry(conn, *, tracker_id, payload,
ts=None, source='chat')` (validates; enforces `entry_cap_per_day` —
cap-exceeded returns `{ok:false, code:'entry_cap'}`, never silently drops) ·
`supersede_entry(conn, *, id)` + `log_entry(..., supersedes=id)` for
corrections · `read_tracker(conn, *, id, days=14)` (current state /
inventory list / windowed series, code-summarized) · `list_trackers(conn)` ·
`adjust_tracker(conn, *, id, label?, schema?, config?, sensitive?)`
(additive schema edits only — a field may be added, never removed/retyped;
history must stay valid) · `drop_tracker(conn, *, id)` (ward-only surface) ·
`stale_trackers(conn, *, now)` · `incomplete_entries(conn, *, days=2)` ·
`entry_rate_flag(conn, *, id)` (§6 watchdog: 7-day rate > 3× trailing
28-day median AND ≥ 10 entries → flagged) · `predict_windows(conn, *, id,
now)` (§4; menses only in v1).

**MCP tools (server.py, first-person):** `tracker_create`,
`tracker_create_from_template`, `tracker_log`, `tracker_read`,
`tracker_list`, `tracker_adjust`, `tracker_supersede`. `tracker_drop` is
NOT exposed over MCP in v1 (ward deletes via UI/HTTP only — a Familiar
never destroys a ledger).

## 2. Templates (data files: `unruh/src/unruh/templates/trackers/*.json`)

Shipped exactly as specified; **erp and menses are `suggested: false`** (the
Familiar never proactively offers them — §7). `sensitive: true` on
**mood, sleep, meds, menses** (WARD-DECIDED). Field lists are the contract;
enum wording inside them is **ward-reviewed at build time** (esp. the mood
palette) but the *shape* is fixed:

| id | archetype | sensitive | fields (required marked *) | config |
|---|---|---|---|---|
| `mood` | series | ✓ | mood*: enum PALETTE · note: text · activity: text | staleness 36h · ask_cap 1/day |
| `sleep` | series | ✓ | hours*: number(0–24) · quality: enum(good,ok,poor) · needed_less: boolean | staleness 48h · ask_cap 1/day |
| `meds` | series | ✓ | med*: text · taken*: boolean · taken_at: date · wearing_off_at: date | staleness 30h · ask_cap 1/day |
| `outings` | series | — | went_out*: boolean · destination: text · accompanied: enum(alone,accompanied) · anticipated: scale(0–10) · actual: scale(0–10) · duration_min: number | staleness 7d · ask_cap 2/week |
| `pantry` | inventory | — | name*: text · qty: quantity · expires: date · category: text | project_dates · ask_cap 1/week |
| `laundry` | state | — | state*: enum(clean, in-progress, dirty) | staleness 7d · ask_cap 1/week |
| `menses` | series | ✓ | flow*: enum(none,spotting,light,medium,heavy) · symptoms: text[] | predict · project_dates · ask_cap 1/day · suggested:false |
| `erp` | series | ✓ | trigger*: text · suds_before: scale(0–100) · suds_after: scale(0–100) · outcome*: enum(resisted,delayed,performed) · safety_behaviors: text[] | **ask_cap 0** · entry_cap 8/day · suggested:false |

**PALETTE (ward-reviews wording before merge):** `good · calm · tired ·
stressed · low · irritable · numb · wired` — the 8th, `wired`, is the
**elevated pole** the bipolar research requires (a mood series without an
elevated state cannot see hypomania). Code maps each label to fixed
`(valence, elevation)` constants in `tracker.py` (e.g. low → (−2, 0),
wired → (+1, +2)); correlation and the §8 threat link key on those
constants, never on string matching in prompts.

## 3. Node bridge & chat tools

- **thalamus.js wrappers** (degrade to `{ok:false}`, never throw):
  `createTracker`, `createTrackerFromTemplate`, `logTrackerEntry`,
  `readTracker`, `listTrackers`, `adjustTracker`, `supersedeTrackerEntry`,
  `trackerCues` (stale + incomplete, §5), `trackerPredictions`.
- **cerebellum tools** (first-person; ward-only — trackers hold the ward's
  private patterns; NOT in `villagerToolNames`): `tracker_create`,
  `tracker_create_from_template` (description names the template ids and
  that erp/menses exist), `tracker_log`, `tracker_read`, `tracker_list`,
  `tracker_adjust`. Success via `quietOk`.
- **tool-surfacing:** new module `trackers`. Static triggers:
  `/\b(track(er|ing)?|log (it|this|that)|inventory|pantry|groceries|laundry|slept|sleep(ing)?|meds?|medication|took my|period|cycle|cramps|went out(side)?|left the house|mood)\b/i`.
  **Dynamic triggers from the registry** (the `villagerNameRegex` precedent):
  `trackerTermsRegex(labels)` — every existing tracker's label (≥3 chars,
  escaped) surfaces the module. Block trigger: `[Tracker cues]`.
- **Gated turns:** tracker tools absent; tracker data NEVER in gated
  context (sensitive or not — v1 is ward-private wholesale; per-tracker
  audience opt-in is explicitly out of scope).

## 4. Projections & derived surfaces (all code, no LLM)

- **Inventory expiry → schedule nodes.** For pantry-class trackers with
  `project_dates`: items with `expires` within `EXPIRY_LEAD_DAYS` (3) get a
  ward-private reminder-class node minted/updated (payload
  `{tracker_ref, entry_ref}`; dedup on entry id; item consumed/superseded →
  node resolved by code). Plus a code-built **eat-first line** in temporal
  context when ≥1 item is within lead: `Pantry, use first: spinach (1d) ·
  yoghurt (2d)` (sorted by days-left, capped 4 items).
- **Menses prediction (`predict_windows`, ALWAYS ON per ward).** Honesty
  gate: **≥ 2 completed cycles** of history, else no window. Mean cycle
  length over up to the last 6 cycles; window = predicted start ± 3 days
  (constant in v1, not SD — small-n SD lies). Projects ONE ward-private,
  sensitive, hold-class node ("likely period window"), re-derived on new
  entries, deduped by cycle index. The model never computes a date.
- **Reflection inputs.** `windowSeries` joins the reflection payload the way
  `windowMemories` did: per sensitive-allowed tracker, a code-aligned
  by-day array over the reflection window (mood valence/elevation, sleep
  hours, meds adherence, outings count + anticipated-vs-actual gaps, missed
  needs already present). Reflection's existing ladder does the reading;
  distillation to Phylactery rides the existing consent-gated writers.
  The **anticipated-vs-actual gap** is precomputed by code per outing entry.
- **Watchdog (§6 design/OCD finding).** `entry_rate_flag` per tracker rides
  the reflection input as a one-line private signal; reflection may turn it
  into a gentle observation — never an accusation, never a villager-visible
  anything.

## 5. Capture

- **5.1 Live:** `tracker_log` in-turn (§3).
- **5.2 Passive — memorization.** **`buildPrompt` ONLY** (the ward-private
  extraction path) gains — exactly like `schedule_refs`, riding alongside the
  existing `relations`/`follow_ups` in the SAME response, no extra call: a compact
  tracker legend (id · label · field names; NO sensitive entry contents, just
  schemas) + an optional `tracker_observations` array on each fact:
  `{"tracker": "<id from legend>", "ts": "<local ISO, the moment it was
  ABOUT>", "payload": {...}}`. **`buildSharedRoomPrompt` (gated) never gets the
  legend or the array** (T2 fail-closed). Code gate on ingest: id must be in the
  legend, payload passes `validate_entry`, else dropped. Stored
  `source:'inferred'`. Note (§0): `tracker_observations` are structured and routed
  to Unruh — they are NOT Phylactery facts, so they do NOT pass through the
  memory-integrity `scanFact` gate; `validate_entry` is their gate. The
  memorization prompt DOES see mood-send tags (§8) — that is the calibration corpus.
- **5.3 Cues.** `trackerCues()` renders `[Tracker cues]` (marker travels
  with the module): stale trackers past `staleness_hours` + incomplete
  recent entries — capped at 2 lines, each cue re-offered at most once per
  `ask_cap` window (per-tracker, WARD-DECIDED), aged out after 3 renders,
  cleared on data arrival (gcal-cue machinery reused, not reimplemented).
  erp: `ask_cap 0` = never cued, structurally.
- **5.4 Offer-a-tracker (care-first, WARD-WORDED).** Code detector: same
  lapse class (needs ledger / readiness misses) ≥ 3 times in 30 days with no
  tracker attached → ONE cue line, 30-day cooldown per class. DRAFT wording
  the cue carries (final text ward-reviewed at merge, like every when-to-act
  prompt): *"About <X> — I've noticed it really stresses my human out. I
  could offer to track it together, to see if that helps."* Never
  deficit-framed; never offers erp/menses (suggested:false).

## 6. Mood-tagged send (web UI + server; Session T-D)

- **UI:** a compact mood control beside send (the 8-mood palette, one tap →
  sends). Plain send always reachable. **Soft lock:** `moodSendOnboardedAt`
  stamped in settings on first boot missing; for 14 days from that stamp the
  mood-send renders as the primary button; after, `moodSendEnabled` is a
  normal synced toggle (existing installs: stamp set to past ⇒ never locked,
  pure opt-in).
- **Wire format:** the tagged send posts `moodTag` alongside the message.
  Server writes (a) a mood-tracker entry `source:'send-button'`
  (auto-creates the mood tracker from template on first tag) and (b)
  `moodTag` into the stored session-log message metadata.
- **LEARNING-ONLY (INVARIANT T1):** `moodTag` NEVER enters any live prompt —
  not the chat turn, not history re-injection, not triage/warmth/noticing
  context, **and not the Hippocampus `[Recently, elsewhere]` buffer (Stage 3):
  its `recordEvent` takes message TEXT only, and `moodTag` must never be passed
  in.** Enforcement is structural: the field lives in message metadata
  that no prompt assembler reads; the ONLY consumers are the memorization
  prompt (calibration corpus) and the tracker entry. A snapshot test pins
  the assembled chat payload byte-free of `moodTag` for a tagged message.
- **Threat link (safety-critical; numbers are the ward-review surface):**
  labels with `valence ≤ −2` (`low`, `numb`) →
  `recordThreat({delta: MOOD_TAG_DELTA, source: 'mood-tag'})` with
  `MOOD_TAG_DELTA = 0.4` and **at most 2 counted per rolling 24h** (cap
  +0.8/day; dedup state rides the tracker, not the threat file). Mood tags
  alone can therefore reach ~moderate over days but never high/severe —
  flag_distress and crisis-signals stay the escalation paths. Constants live
  in `crisis-signals.js`-adjacent code and join the safety sign-off set.
- Discord/voice surfaces: none in v1 (web compose only).

## 7. Off-switches, privacy, HTTP

- `trackersEnabled` (default ON; inert until a tracker exists) +
  `PROTO_FAMILIAR_TRACKERS_DISABLED=1` — off = no tools surfaced, no cues,
  no projections, no capture (5.2 legend omitted), mood-send hidden.
- All tracker data ward-private in v1; sensitive trackers additionally
  excluded from *ward-side incidental* surfaces (their projections are
  sensitive nodes — `stripSensitiveScheduleNodes` already handles gated
  turns; the eat-first line etc. only ever renders ward-private anyway).
- HTTP for the UI: `GET /api/trackers`, `GET /api/trackers/:id`
  (windowed), `POST /api/trackers/:id/entries`, `DELETE /api/trackers/:id`
  (the ward-only drop), `GET /api/tracker-cues` (debug).
- UI: a Trackers tab in the Knowledge/Temporal editor (list, current
  state/series sparkline, add-entry form per schema, create-from-template).

## 8. Invariants (each pinned by a test)

- **T1 — learning-only:** a mood-tagged message's live chat payload is
  byte-identical to the untagged payload (snapshot); the same message's
  Hippocampus buffer write carries the text but no `moodTag` (Stage 3 surface).
- **T2 — fail-closed gating:** gated (villager) turns contain zero tracker
  tools, zero tracker context lines, zero tracker legend in any prompt.
- **T3 — validation gate:** `log_entry` / 5.2 ingest drop unknown fields,
  reject bad types, report missing required; nothing malformed lands.
- **T4 — no breakable streaks:** no code path resets cumulative counts;
  `read_tracker` summaries render gaps neutrally (regression: banned
  tokens `streak|broke|missed day` in tracker summary output).
- **T5 — prediction honesty:** `predict_windows` returns nothing under 2
  completed cycles; window arithmetic is pure and tested on fixtures.
- **T6 — threat-link bounds:** mood-tag deltas cap at 2/24h; only
  valence ≤ −2 labels fire; disabled threat detector ⇒ no-op.
- **T7 — erp guards:** ask_cap 0 renders no cue ever; entry cap returns a
  readable refusal, not a silent drop; erp/menses never appear in the
  offer cue (suggested:false).
- **T8 — watchdog:** the 3×-median flag fires on a fixture burst and rides
  the reflection input; it renders nowhere else.
- **T9 — soft lock:** pre-existing installs (stamp in past) are never
  locked; new stamps lock exactly 14 days; plain send works throughout.

## 9. Build order (Opus sessions) & versioning

1. **T-A:** migration + `tracker.py` + templates + MCP tools + Python tests
   (validation, caps, staleness, watchdog, predict fixtures). **✓ SHIPPED
   (0.14.0-alpha):** `0007_trackers.sql`, `unruh/src/unruh/tracker.py` (all four
   archetypes incl. `gauge`'s `gauge_level`), `templates/trackers/*.json` (laundry /
   pantry / mood / sleep / hydration / meals), the seven `tracker_*` MCP tools
   (`tracker_drop` UI/HTTP-only), 15 `test_tracker.py` cases.
2. **T-B:** thalamus wrappers + cerebellum tools + surfacing module (static
   + registry regex) + 5.2 memorization capture + 5.3 cues + T2/T3 tests.
   - **T-B.1 ✓ SHIPPED (0.14.1-alpha):** the live chat path — the seven
     `thalamus.js` tracker wrappers (`createTracker`,
     `createTrackerFromTemplate`, `logTrackerEntry`, `readTracker`,
     `listTrackers`, `adjustTracker`, `supersedeTrackerEntry`); the six
     ward-only cerebellum tools (`tracker_list`/`_create`/
     `_create_from_template`/`_log`/`_read`/`_adjust`, first-person, via
     `quietOk`, with `renderTrackerRead` gap-neutral summaries — T4 tokens
     banned); the `trackers` tool-surfacing module (static vocabulary +
     `[Tracker cues]` block + `trackerTermsRegex(labels)` registry regex
     wired into `selectModules`/`explainSelection` and threaded from
     `server.js` as `trackerLabels`); the `trackersEnabled` /
     `PROTO_FAMILIAR_TRACKERS_DISABLED` gate in `composeActiveTools`; and
     `tests/trackers-tb.test.mjs` (T2 fail-closed gating + off-switch +
     surfacing + T3 boundary guards). The `tracker_supersede` wrapper stays
     HTTP/UI-only (the Familiar corrects via `tracker_log`'s `supersedes`
     arg). `tracker_create_from_template` names the six real shipped
     templates (`mood`/`sleep`/`pantry`/`laundry`/`hydration`/`meals`).
   - **T-B.2 ✓ SHIPPED (0.14.2-alpha):** §5.2 passive memorization capture.
     `buildPrompt` (ward-private ONLY — `buildSharedRoomPrompt` never gets it,
     T2 fail-closed) offers a compact tracker legend (id · label · archetype ·
     field names — no entry contents) + an optional per-fact
     `tracker_observations` array, riding the SAME extraction response as
     `schedule_refs`/`relations`/`follow_ups` (no extra call).
     `parseTrackerObservations(facts, validIds)` code-gates each observation
     against the legend (off-legend id or non-object payload dropped, deduped,
     capped); `processJob` logs the survivors via `logTrackerEntry` as
     `source:'inferred'` — a refusal (bad payload / entry cap) is Unruh's own
     visible verdict (`validate_entry`), logged, never fabricated as success.
     The `tracker_log` MCP tool + `logTrackerEntry` wrapper gained a `source`
     param (default `chat`; passive path passes `inferred`).
     `tests/memorization-tracker-obs.test.mjs` (prompt-side, the
     `parseTrackerObservations` gate, + a PIPELINE run through real `processJob`:
     ward-private logs inferred / off-legend dropped, shared-room never fetches
     the legend, off-switch stops capture).
   - **T-B.3 ✓ SHIPPED (0.14.4-alpha):** §5.3 cues — the `[Tracker cues]`
     block. Unruh `cue_candidates` (currently-stale trackers with each one's
     `ask_cap_per_day`, gauges excluded) behind the `tracker_cues` MCP tool +
     the `trackerCues` thalamus wrapper. `src/tracker/tracker-cues.js` mirrors
     the gcal-projection aging shape (per-id state, prune-on-arrival, a hard
     `MAX_RENDERS`=3 age-out, `MAX_PER_TURN`=2) with one tracker-specific gate:
     each tracker's `ask_cap_per_day` paces re-offers per ward-local day, and
     `ask_cap 0` (erp) is never cued — structurally. The block is wired into
     `enrich()`'s dynamic sections (ward-private, live turns only, gated by
     `trackersEnabled`) and travels with the `trackers` surfacing module (its
     `[Tracker cues]` marker, registered in T-B.1). The gcal + tracker cue
     stores now share `src/util/json-state.js` (extracted, not duplicated).
     Tests: `cue_candidates` (Python), `tests/tracker-cues.test.mjs` (aging /
     ask-cap / erp-opt-out / age-out / prune / cap / block text).
     - **Deferred (with rationale):** the "incomplete recent entries" half of
       §5.3 (`incomplete_entries`) is intentionally NOT shipped. Every crisp
       definition of "incomplete" (a stored entry missing an *optional* field)
       fires on entries my human omitted a field from on purpose → a naggy,
       low-value cue that cuts against the anti-nag stance. Staleness ("this
       ledger's gone quiet") is the high-value, well-defined signal; revisit
       incomplete-entries only with a ward-agreed notion of what makes an entry
       worth re-touching. `trackerPredictions` (menses windows, §4) belongs to
       T-C (projections), not the cue pass.
3. **T-C:** projections (expiry nodes, eat-first, menses windows) +
   `windowSeries` reflection input + watchdog line + 5.4 offer cue +
   T4/T5/T7/T8 tests.
   - **T-C.1 ✓ SHIPPED (0.14.7-alpha):** the pantry **"use first" line** (§4
     inventory expiry). Unruh `expiring_items(conn, within_days=3, now)` —
     pantry-class items (inventory + `project_dates`) whose `expires` is within
     the lead (`EXPIRY_LEAD_DAYS`=3), already-expired included, soonest-first,
     code-owned day maths — behind the `tracker_expiring` MCP tool + the
     `trackerExpiring` thalamus wrapper. `src/tracker/tracker-projections.js`
     `buildEatFirstBlock` renders `[Pantry — use first]\nspinach (expired) ·
     yoghurt (2d)` (cap 4 + "+N more"); wired into `enrich()`'s dynamic sections
     (ward-private, live turns, `trackersEnabled`) and travelling with the
     `trackers` surfacing module (its `[Pantry — use first]` marker). Pure
     derivation — no loop, no stored state; it clears the moment the item is
     used/superseded. Tests: `expiring_items` (Python, project_dates gating +
     within-lead + soonest-first + no-date skip), `tests/tracker-projections.test.mjs`.
   - **T-C.2 ✓ SHIPPED (0.14.8-alpha):** the **likely period window** as a
     derived line (§4 menses prediction). Unruh `predictions(conn, now)` scans
     `config.predict` trackers, runs the already-built `predict_windows` (honesty
     gate: ≥2 completed cycles), keeps real windows — behind the
     `tracker_predictions` MCP tool + the `trackerPredictions` thalamus wrapper.
     `buildMensesWindowBlock` (`tracker-projections.js`) renders a hedged,
     locale-free `[Likely period window]\ncycle: around Oct 3 – Oct 9 (predicted
     from 4 cycles)` in `enrich()` (ward-private, live turns, pure derivation —
     code owns the dates). Consistent with T-C.1: a derived line, no loop.
     Travels with the `trackers` surfacing module (`[Likely period window]`
     marker). Tests: `predictions` (Python, honesty gate + non-predict excluded),
     `tests/tracker-projections.test.mjs` (hedged wording, date range, cycle
     count).
   - **T-C.3 (next):** the persistent NODE projections — the pantry expiry
     **reminder nodes** and the menses **hold-node** (both need a projection tick
     that mints/updates/resolves ward-private schedule nodes), plus the
     reflection inputs (`windowSeries` + the watchdog line + the §5.4 offer cue).
4. **T-D:** mood-send UI + soft lock + T1 learning-only enforcement +
   threat link (**ward sign-off on §6 constants + palette wording + 5.4
   final text happens in this session's review**) + T6/T9 tests + docs.
5. **G-A / G-B / G-C:** the `gauge` archetype (§10) — G-A store+derivation, G-B
   cues+UI+capture, **G-C the safety ladder (ward sign-off, §10.6/§10.7)**. These
   extend the milestone after the core archetypes; see §10.11 for the pass detail.

Each session: `docs/architecture.md` same commit. **Trackers are the next
milestone and own the `0.14` minor** — sub-work through the build order above
bumps `0.14.x` patches, and the milestone lands as `0.14.0`. (⚠️ **Renumbered from
`0.13` — ward-confirm.** `0.13` was reassigned to trackers in an earlier pass, but
cross-channel continuity / Hippocampus shipped there instead — `0.13.0`/`0.13.1`
are on main — so trackers move to `0.14` and the plugin-surface milestone after
this takes **`0.15`**. The `0.12.0` = crisis-classifier note still holds.)

**Do-not-touch:** no changes to crisis-signals tiers/weights beyond adding
the bounded mood-tag source; no triage/threat gates or clamps; no villager
grant widening; the §6 constants and the 5.4/palette wording ship only with
explicit ward review in T-D.

**Ward-review-at-merge checklist (T-D):** palette wording (incl. `wired` as
the elevated pole) · offer-cue final text · `MOOD_TAG_DELTA`/daily cap ·
laundry state enum wording.

---

## 10. The `gauge` archetype — decaying upkeep (SAFETY-CRITICAL)

A ward idea (2026-09). Some things aren't events you log — they're **upkeep that
decays when neglected**. Eating, hydration, meds, going outside, a break. A `gauge`
starts full right after you tend it, sits in "fine" for a normal interval, then
**drains over time**, and the draining *is* the rising importance — "it's been six
hours, this is getting important." Logging the event **refills** it. Unlike `series`
(a list of dated entries) or the existing **needs** system (a fixed `[when,end]`
window with a pass/fail verdict), a gauge is a **continuous level** with no fixed
clock — more honest for things people don't do on a timetable. This section adds the
archetype on top of §1–§9; everything there (RULE A/B/C, the pipeline test, the
conventions, ward-private wholesale, off-switch discipline) binds here too.

### 10.1 ⚠️ The load-bearing safety truth: logged ≠ actual

**A gauge measures time since the ward last LOGGED the thing, not since they last
did it.** They eat at a friend's, don't mention it, and the gauge drains toward
"critical" while they're fine. So the extreme path may **never** auto-escalate on
the gauge alone. Crossing the extreme threshold is a **prompt to CHECK**, and a
human-confirmable check stands between "my data looks alarming" and "I raised the
alarm." This is the inverse of the 1.5-hour-silence failure: there we under-acted on
a real signal; here the risk is over-acting on a fake one, and the check prevents it.
**This gate is invariant G1, pinned by a test.**

### 10.2 The archetype (extends §1)

`archetype = 'gauge'`. A gauge stores its refills as `tracker_entries` exactly like
`series` (each logged event = one entry; `ts` = when it was ABOUT). What makes it
distinct: its **read semantics** (a derived level + band, not a list), its **decay
config**, and the **safety ladder** below — a first-class archetype on shared
plumbing (the ward's call: a real gauge system, not a bolt-on view). `schema_json`
is the refill event's optional fields (most gauges need none — the entry's
*existence* is the signal). **The level is pure derivation, never stored, never
model-authored** (exact-values §, mirroring the schedule/menses rule):
`gaugeLevel(lastRefillTs, config, now)` → `{ level: 0..1, band, hoursSince }`.

### 10.3 `config.gauge` (all hours; ward-set per gauge, template defaults)

```
{
  grace_hours,     // stays "fine" this long after a refill (normal interval)
  low_hours,       // enters "getting low" (a gentle cue)
  overdue_hours,   // enters "overdue" (a firmer cue)
  extreme_hours,   // medical-danger threshold → opens a CHECK (never auto-escalate)
  escalation: {    // OPT-IN, per gauge, ward-only. Absent = check only, never crisis.
    enabled: false,
    checkin_deadline_hours,  // after the check opens, how long unresolved before crisis
    contact: false,          // ring an emergency contact on unresolved crisis (further opt-in)
    contact_id,              // which trusted contact (village.js), ward-chosen
  }
}
```

`grace ≤ low ≤ overdue ≤ extreme`, validated at create. Bands (pure code):

| band | when | surface |
|---|---|---|
| `fine` | `hoursSince < grace` | nothing |
| `fading` | `grace..low` | nothing (headroom) |
| `low` | `low..overdue` | a **gentle** cue (§5.3) |
| `overdue` | `overdue..extreme` | a **firmer** cue |
| `extreme` | `≥ extreme` | **opens a check** (§10.6) — NOT a cue, NOT an escalation |

`gaugeLevel` maps hoursSince to a 0..1 level (1.0 through `grace`, linearly to 0.0
at `extreme`) plus the band. Pure, fixtured, tested. `read_tracker` for a gauge
returns `{ band, level, hoursSince, lastRefillAt, config }` (code summary, no LLM);
recent refills ride along for the §4 reflection input.

### 10.4 Refill sources (extends §5)

A gauge refills through the SAME capture paths — no new mechanism: the live
`tracker_log` tool ("just ate"), passive memorization (§5.2 `tracker_observations`,
same `validate_entry` gate), and a **one-tap refill button** in the Trackers UI (a
gauge's most common interaction). There is deliberately **no way for the model to
set the level** — it only logs a refill; code derives the level.

### 10.5 Cues (extends §5.3)

`low`/`overdue` bands render through the existing `[Tracker cues]` machinery — gentle
then firmer. `extreme` does NOT cue; it opens a check (§10.6).

### 10.6 ⚠️ The safety ladder — check-first, then crisis (SAFETY SIGN-OFF)

A gauge with `escalation.enabled` runs a bounded check on the existing upkeep tick
(`needs-tracking-loop` — reuse it, don't add a loop). Per gauge, per decay cycle
(one open check at a time; a refill closes it):

**Step 1 — CHECK (care, not crisis).** When band first reaches `extreme` and no check
is open: open one (`checkOpenedAt` stamped) and hand the Familiar a **care reach-out**
through the existing warm channel (`reach_out_to_ward` / noticing), worded to ask
directly, in the Familiar's own voice: *"I haven't seen you [eat] in [3 days] —
that's long enough I need to actually ask: are you okay? Have you been [eating]?"*
**No threat raised here. No contact rung here.**

**Step 2a — resolved.** The ward logs a refill or says they're fine → refill, close
the check, done. The check *was* the action. (Most real firings end here.)

**Step 2b — unresolved.** No response within `escalation.checkin_deadline_hours`, OR
the ward confirms they genuinely haven't → **now it's a real signal**, and only now
does it enter the crisis apparatus that already exists:
- a **bounded** threat raise via the model's own-read channel (`flag_distress` /
  `threat-tracker.js`), `source:'gauge-critical'`. A CONFIRMED multi-day
  no-food/no-water is a genuine emergency, so it may reach a high tier — but ONLY on
  the confirmed/unresponsive branch, never on the gauge alone.
- if `escalation.contact`, the trusted-contact path via the EXISTING machinery
  (`contactDeadlineFor` / `CONTACT_ESCALATION_DELAY_MS`, the **no-covert-contact
  mirror** — every reach mirrored to the ward), to the ward-chosen `contact_id`
  (village.js). Deadline-gated, so the ward still gets a final window.

The gauge **bridges** two existing systems (care-check → crisis) with a mandatory
confirm gate between; it reimplements neither. All crisis/contact safety rules (no
covert contact, deadline windows, mirroring, `PROTO_FAMILIAR_THREAT_DISABLED`
stand-down) apply unchanged.

### 10.7 ⚠️ Extreme thresholds (ward-reviewed medical values — sign-off at G-C)

`extreme_hours` must be genuinely health-threatening, not "late for lunch." DRAFT
starting values, ward-reviewed before merge:

| gauge | grace | low | overdue | extreme | escalation default |
|---|---|---|---|---|---|
| hydration | 3h | 6h | 12h | **~48h** (no water logged) | opt-in |
| meals | 5h | 10h | 24h | **~72h** (no food logged) | opt-in |
| meds (life-critical) | per-med | — | — | ward-set per med | opt-in |

Non-medical gauges (going outside, a break) get NO escalation block — they cue and
stop. Escalation is opt-in per gauge, off by default; `extreme_hours`,
`checkin_deadline_hours`, and the contact are all ward-set.

### 10.8 Off-switches, privacy, UI (extends §7)

Governed by `trackersEnabled` / `PROTO_FAMILIAR_TRACKERS_DISABLED`, plus
`PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED=1` — a hard kill for the WHOLE check→crisis
ladder (gauges still decay + cue, never escalate); escalation also stands down under
`PROTO_FAMILIAR_THREAT_DISABLED`. Gauges are ward-private wholesale (§7); their data
and check-ins never reach a gated/villager surface, never the Hippocampus buffer
(§0), and carry no live-prompt metadata (T1 discipline). The only outward reach is
the ward-chosen contact on the confirmed-crisis branch, mirrored to the ward. UI: a
calm band + fill meter (not alarmist), the one-tap refill, and — for escalation-eligible
gauges — the escalation editor (thresholds, deadline, contact picker, all default
off). Console↔UI parity holds.

### 10.9 Invariants (each pinned by a test)

- **G1 — check-first is mandatory (THE safety invariant).** No code path raises
  threat or contacts anyone from a gauge without FIRST opening a check AND that check
  going unresolved past the deadline. Fixture: `extreme` band, no check opened →
  zero `recordThreat`, zero contact calls.
- **G2 — a refill closes everything.** Logging a refill while a check is open (or a
  crisis is escalating, pre-contact) resolves it: full, closed, no further escalation.
- **G3 — level is pure + model-free.** `gaugeLevel` is a pure function of
  `(lastRefillTs, config, now)`; the model only logs refills. Fixtured across bands
  incl. exact boundaries.
- **G4 — escalation opt-in + bounded.** No `escalation.enabled` → never escalates
  however low; `PROTO_FAMILIAR_GAUGE_ESCALATION_DISABLED` / `_THREAT_DISABLED` →
  no-op; the threat raise fires only on the confirmed/unresponsive branch.
- **G5 — no covert contact.** A contact reach is always mirrored to the ward (reuse
  + regression-pin the mirror for the gauge source).
- **G6 — PIPELINE.** One full run: decay to `extreme` → check opens (real
  `reach_out_to_ward`, stubbed provider) → (a) a refill closes it with no escalation,
  (b) a simulated deadline-pass drives the bounded threat raise + (opted-in) the
  mirrored contact path — through the real assembly, not caller stubs.

### 10.10 Build passes (extend §9; each: off-switch + tests + docs + version, same commit)

1. **G-A:** `gauge` archetype in the store + `gaugeLevel`/bands (pure) + gauge
   `read_tracker` + refill via `tracker_log` + G3 fixtures.
2. **G-B:** cues (§10.5) + the UI meter + one-tap refill + memorization refill (§10.4)
   + reflection input (recent refills) + G-fixtures.
3. **G-C (SAFETY — ward sign-off in this pass):** the check→crisis ladder — check via
   `reach_out_to_ward`, the confirm gate, the bounded `flag_distress` raise, the
   opt-in `contactDeadlineFor` contact path + mirror. G1/G2/G4/G5/G6 tests. **Ward
   reviews: `extreme_hours` per template, `checkin_deadline` defaults, the reach-out
   wording, and that G1 (check-first) holds.**

**Do-not-touch (gauge):** no crisis-signals tier/weight changes beyond the bounded
`gauge-critical` source on the CONFIRMED branch; the check-first gate and all
§10.6/§10.7 constants ship only with explicit ward review in G-C.
