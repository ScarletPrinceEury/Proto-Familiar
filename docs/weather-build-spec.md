# Weather sense — build spec

**Status: SPEC — ward-directed, first in the implementation queue (before
vision/voice/browser).** The ward's design note is the spine of this spec;
everything else is fitting it to the repo's existing seams.

## 0. Why (and why before vision)

The Familiar is timeblind no longer (event alerts, leads, phases) — but it is
still **weather-blind**, and weather is the single biggest *physical* modifier
of what its human can actually do in a day. For a ward for whom leaving the
house is a real obstacle (`obstacle_tags: ["outside"]` is already a first-class
signal in this codebase), "it will be pouring at 15:00" is not trivia — it's
the difference between a plan that works and a plan that quietly fails and
costs a rough evening. A companion who holds your day should also hold the sky
over it.

It precedes vision/voice/browser because it's small, self-contained, rides
existing seams (the gcal-source fetch pattern, the reminders tick, the [Now]
block, tool-surfacing, readiness), and immediately feeds the consequence /
preparation machinery the Initiative just finished.

## 1. Privacy model (the load-bearing constraint)

The ward's rule: **locations stay local. They are never told to the LLM.**

| datum | stored | sent to weather API | visible to the LLM |
|---|---|---|---|
| Location query (city/ZIP the ward typed) | Unruh (local DB) | once, at entry, to geocode | **never** |
| Coordinates (lat/lon from geocoding) | Unruh (local DB) | on every forecast fetch | **never** |
| Ward-chosen label ("home", "work", "Chen's") | Unruh | never | **yes** — labels only |
| Which label is current | Unruh | — | **yes** ("where my human is") |
| The weather itself | cache | — | yes (code-formatted) |

So the model knows *"at my human's current location it's 6°C and raining until
about 17:00"* — it never knows where that location is. The one unavoidable
disclosure is to the weather API itself (you cannot fetch weather for a place
without naming the place); we minimise it by geocoding **once** at entry time
and thereafter sending **coordinates only** (no place name, no account, no API
key with Open-Meteo — requests aren't tied to an identity). ZIP/city
granularity is exactly right: forecasts don't get better below city scale, and
coarser coordinates disclose less.

## 2. Provider choice (recommendation: Open-Meteo, with a thin seam)

**Primary: [Open-Meteo](https://open-meteo.com).** It is the best fit by some
margin, and better than OpenWeatherMap for this use:

- **No API key, no signup, no account** — works out of the box (the repo's
  websearch keyless-floor philosophy) and nothing ties requests to an identity.
- Free for non-commercial use, ~10k requests/day — our budget is **4/day per
  location** (6-hourly); irrelevant load.
- Hourly forecasts (temp, precipitation probability + amount, wind, cloud
  cover, WMO weather codes) up to 16 days; also `current` conditions in the
  same call. One request covers everything we need.
- A separate **keyless geocoding API** (`geocoding-api.open-meteo.com`) for
  the once-at-entry city/ZIP → lat/lon step.

**Also behind the seam (`weather-providers.js` mirroring
`websearch-providers.js`):**
- **MET Norway (api.met.no / Yr)** — also keyless (requires only an honest
  `User-Agent`), excellent quality. **WARD-DECIDED: ships in v1 as the
  automatic fallback** — an Open-Meteo failure falls through to MET Norway
  before giving up on the line.
- **OpenWeatherMap** — needs a key + signup even for the free tier (1k
  calls/day). Supported as an adapter for wards who already have a key, never
  required.

A missing/down provider degrades to *no weather line* — absence renders as
absence, never an error in the chat path.

## 3. Storage & the ward surface (Unruh)

Migration `0006_locations.sql`, a dedicated table (the handoff/intentions
precedent — its own shape, never schedule nodes):

```
locations(
  id TEXT PK,            -- slug from label ("home-x7")
  label TEXT NOT NULL,   -- the ONLY part the LLM ever sees
  lat REAL, lon REAL,    -- from one-time geocoding; never in a prompt
  place_name TEXT,       -- geocoder's resolved name, ward-UI only (confirm dialog)
  is_current INTEGER,    -- exactly one row = 1
  created_at, updated_at
)
```

Forecast cache: `weather_cache` table keyed by location id —
`{fetched_at, provider, current_json, hourly_json}` (next ~24h hourly), one
row per location, replaced on refresh. Cached in Unruh because weather is
temporal context and Unruh owns that layer; **a small read-mirror**
(`tomes/.weather-now.json`, current-location current conditions only) is
written by the fetch loop so Node-side [Now] assembly (`buildTimeAnchorBlock`
in relative-time.js — also used by triage/warmth/noticing deliberations) can
read it **synchronously** without an MCP round-trip in paths that must never
block.

**Ward UI** (Temporal editor, a small "Places" pane): add a location (type a
city/ZIP → we geocode → show the resolved place name → ward confirms → store
label+coords), a radio for "I'm here now", delete. Marking current is also a
ward-only chat tool (`set_current_location(label)`) so "I'm at work now" in
chat just works — the tool takes and returns **labels only**.

**Villager-frequented places** are just more labeled locations (the ward adds
"Chen's place"); nothing villager-facing in v1 — no villager may read or set
any of this (fail-closed, like every ward-private surface).

## 4. The fetch half (Node — Unruh stays network-free)

Per the gcal precedent, **Unruh never touches the network**. `weather-source.js`
(Node) owns the HTTP: geocoding at entry, and the 6-hourly forecast refresh.

The refresh **rides the reminders loop's existing 30s tick** with a cheap code
gate (`ride existing requests, gate in code`): if `now - fetched_at > 6h` for
the current location → fetch → push into Unruh via a `weather_ingest` MCP tool
(parse/validate in Unruh, like `gcal_ingest`) → rewrite the read-mirror.
Non-current locations refresh lazily — only when actually asked about (the
tool call triggers a fetch if stale), so we don't spend requests on places
nobody's at. Fetch failure keeps the stale cache with its honest `fetched_at`;
past ~12h staleness the [Now] line drops rather than show old weather as
current (**honesty rule** — the baselines precedent: no data beats wrong
data).

Off-switches, same commit: `weatherEnabled` (default ON — but inert until the
ward adds a first location, so there is no zero-config network chatter) +
`PROTO_FAMILIAR_WEATHER_DISABLED=1`.

## 5. Surfaces (what the Familiar sees, and when)

**5.1 The [Now] line (every assembled Now block, ~zero marginal tokens).**
One code-built line appended by `buildTimeAnchorBlock` from the read-mirror:

```
Weather where my human is: 6°C, light rain, easing off around 17:00.
```

Code formats everything (WMO code → words, times from the hourly array — the
exact-machine-values rule; the model never computes a temperature or a time).
No location name, ever. Missing/stale cache → no line (absence as absence).

**5.2 The day at will — `weather_today` tool (CORE-adjacent read).**
Returns the code-formatted arc for **today AND tomorrow** (WARD-DECIDED —
evening planning looks ahead) for the current location (or another *label*):
morning/afternoon/evening summary + notable hours (rain windows, wind,
temperature swing). First-person description: *"I check the sky over my
human's day — today and tomorrow, where they are or at another of their
places — when we're deciding whether and when to go out."*

**5.2b Per-item weather — the outside join (WARD-DECIDED).**
The "Outside marker" already exists: `obstacle_tags: ["outside"]`, which the
Familiar already sets on events/tasks. Weather joins onto it: an
outside-tagged schedule item gets **its occurrence-time forecast** attached
wherever the item is deliberated about (the readiness note in 5.4, the
briefing legend line, `weather_today` when asked about that day). For an item
beyond the cached ~48h, the fetch half pulls that item's date **on demand**
(Open-Meteo serves 16 days out; one extra request, gated to items that are
actually outside-tagged and actually asked about/entering readiness). No new
marker, no new model judgment — the tag the Familiar already applies is the
signal, and code does the join.

**5.3 Tool surfacing.** A `weather` module in tool-surfacing:
- text triggers: leaving-the-house / outdoor language (`outside|go out|
  errand|walk|leave the house|umbrella|rain|snow|heat|cold|weather|cycle|
  drive over|head to|hang laundry`, tuned generously per the miss-log rule);
- block triggers: the readiness/stewardship agenda markers and the gcal
  projection cue (`[New on my human's calendar…]`) — a new outside event is
  exactly when the sky matters.

**5.4 Consequence & preparation (the Initiative hookup).**
- **Readiness (stewardship):** when an `obstacle_tags:["outside"]` item is
  inside its readiness lead AND the cached forecast for its hour is adverse
  (precip probability / temperature extremes — pure code thresholds), the
  readiness line carries a code-built weather note ("outside, and rain is
  likely around then") so the Familiar's prep nudge is weather-aware.
- **Projection cue:** the gcal projection line reminds the Familiar it can
  check `weather_today` while thinking a new appointment through (lead times:
  "across town in the rain → more lead", riding Pass 5's `schedule_set_lead`).
- **Noticing:** `weather_today` joins the noticing toolset (read-only, cheap);
  a due outside-tagged intention deliberates with the sky in reach.
- **Severe-weather alert (WARD-DECIDED: proactive, in v1).** When the cached
  forecast turns adverse (pure code thresholds: storm/heavy-rain WMO codes,
  temperature extremes) within lead range of an `outside`-tagged item, the
  event-alert pass emits a code-built "weather heads-up" outbox ping alongside
  the existing coming-up alert machinery (same dedup discipline — one ping per
  occurrence, `payload`-stamped like `alerts`). Weather alone (no outside item
  affected) stays passive context.
- Deliberately **not** a threat/triage input, not a new wake condition in v1
  (weather never wakes the noticing turn — it flavours turns that were
  already happening).

**5.5 Qualitative translation — code speaks the numbers (ward-directed).**
Temperatures and precipitation are like times: the model needs the *meaning*
alongside the value, and code must supply it (the exact-machine-values rule —
`plainInterval` is the precedent). Every rendered value carries a code-derived
qualitative band: `34°C (very hot)`, `2mm/h (light rain)`, `55km/h gusts
(strong wind)`. Fixed sensible bands in code (`weather-format.js`), not model
judgment; the model reads the interpretation, never computes it.

**5.6 The vague tier — gated audiences (WARD-DECIDED).**
On non-ward-private surfaces the weather renders **dumbed down**: qualitative
only, past/ongoing phrasing, no numbers, no units, no times, no labels —
*"it rained recently"*, *"today was hot"* — because precise values + units are
a soft geolocation ("x°C, so metric, so…"). One pure formatter
(`formatWeatherVague`) is the gate, applied structurally on every gated turn
(fail-closed: if the audience is unclear, vague or nothing). The ward-private
surfaces keep the full code-formatted detail.

## 6. Ward decisions (ALL RESOLVED)

1. **Severe-weather alert ping** → **proactive, v1** (§5.4): adverse forecast
   within lead of an `outside`-tagged item rides the event-alert pass.
2. **`weather_today` horizon** → **today + tomorrow** (§5.2); plus the
   outside join (§5.2b): outside-tagged items carry their occurrence-time
   forecast, fetched on demand for dates beyond the cache.
3. **Second provider** → **MET Norway ships in v1** as the automatic
   keyless fallback (§2).
4. **Gated audiences** → **the vague tier** (§5.6): qualitative-only weather
   ("it rained recently", "today was hot"), no numbers/units/times/labels —
   fail-closed to vague-or-nothing. Ward-private keeps full detail.

Plus the ward-directed translation principle (§5.5): every value renders with
a code-derived qualitative band — `34°C (very hot)` — the plainInterval
precedent applied to weather.

## 7. Build order & sizing

1. **Session W-A:** Unruh migration + locations CRUD + `weather_ingest` +
   cache reads; Node `weather-source.js` (geocode + fetch + seam) + refresh
   gate on the reminders tick + read-mirror; [Now] line. Tests: pure
   formatters, gate arithmetic, ingest validation, mirror honesty rule.
2. **Session W-B:** `weather_today` + `set_current_location` tools + the
   `weather` surfacing module + Places UI pane + readiness/projection/noticing
   hookups + docs.

Versioning: 0.8.x patches (the UI overhaul still owns the minor slot).
Every value the model reads is code-formatted; the model never computes
weather numbers, times, or coordinates.
