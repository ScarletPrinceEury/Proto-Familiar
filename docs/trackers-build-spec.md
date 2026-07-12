# Trackers — build spec

**Status: SPEC.** Rationale and evidence live in
[`trackers-design.md`](trackers-design.md) + [`trackers-research.md`](trackers-research.md);
this document is the implementation contract. All design/ward decisions are
RESOLVED there — a builder changes none of them. Queued after weather (and
before/alongside vision at the ward's discretion).

Conventions binding this spec: first-person prompts & tool descriptions;
slug ids (`insert_with_slug_retry`); local-naive time; exact machine values
in code; graceful degradation (off-switch in the same commit); ride existing
requests / gate in code; no copy-paste of substantial logic.

---

## 1. Unruh store (migration `000N_trackers.sql`, next free number)

```sql
CREATE TABLE IF NOT EXISTS trackers (
  id          TEXT PRIMARY KEY,          -- slug from label ("mood-x7")
  label       TEXT NOT NULL,
  archetype   TEXT NOT NULL,             -- 'state' | 'inventory' | 'series'
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
State archetype: exactly one field, enforced at create.

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
- **5.2 Passive — memorization.** `buildPrompt` gains (exactly like
  `schedule_refs`): a compact tracker legend (id · label · field names; NO
  sensitive entry contents, just schemas) + an optional
  `tracker_observations` array on each fact:
  `{"tracker": "<id from legend>", "ts": "<local ISO, the moment it was
  ABOUT>", "payload": {...}}`. Code gate on ingest: id must be in the
  legend, payload passes `validate_entry`, else dropped. Stored
  `source:'inferred'`. The memorization prompt DOES see mood-send tags
  (§8) — that is the calibration corpus.
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
  context. Enforcement is structural: the field lives in message metadata
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
  byte-identical to the untagged payload (snapshot).
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
   (validation, caps, staleness, watchdog, predict fixtures).
2. **T-B:** thalamus wrappers + cerebellum tools + surfacing module (static
   + registry regex) + 5.2 memorization capture + 5.3 cues + T2/T3 tests.
3. **T-C:** projections (expiry nodes, eat-first, menses windows) +
   `windowSeries` reflection input + watchdog line + 5.4 offer cue +
   T4/T5/T7/T8 tests.
4. **T-D:** mood-send UI + soft lock + T1 learning-only enforcement +
   threat link (**ward sign-off on §6 constants + palette wording + 5.4
   final text happens in this session's review**) + T6/T9 tests + docs.

Each session: `docs/architecture.md` same commit; version bumps as 0.8.x
patches (the UI overhaul still owns the minor slot).

**Do-not-touch:** no changes to crisis-signals tiers/weights beyond adding
the bounded mood-tag source; no triage/threat gates or clamps; no villager
grant widening; the §6 constants and the 5.4/palette wording ship only with
explicit ward review in T-D.

**Ward-review-at-merge checklist (T-D):** palette wording (incl. `wired` as
the elevated pole) · offer-cue final text · `MOOD_TAG_DELTA`/daily cap ·
laundry state enum wording.
