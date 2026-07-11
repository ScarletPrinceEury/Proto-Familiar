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

**Also behind the seam (optional alternates, `weather-providers.js` mirroring
`websearch-providers.js`):**
- **MET Norway (api.met.no / Yr)** — also keyless (requires only an honest
  `User-Agent`), excellent quality, a good second keyless option.
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
Returns the whole day's code-formatted arc for the current location (or
another *label*): morning/afternoon/evening summary + notable hours (rain
windows, wind, temperature swing). First-person description: *"I check the
sky over my human's day — the full forecast where they are, or at another of
their places, when we're deciding whether and when to go out."*

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
- Deliberately **not** a threat/triage input, not a new wake condition in v1
  (weather alone never wakes the noticing turn — it flavours turns that were
  already happening; a "storm warning before an outside event" *alert* is a
  ward decision below).

## 6. Ward decisions (open)

1. **Severe-weather alert ping?** Should a storm/heat warning within N hours
   of an `outside` event produce a proactive outbox alert (riding the event-
   alert pass), or stay passive context until v2?
2. **Forecast horizon for `weather_today`** — today only (spec default), or
   include tomorrow when evening planning looks ahead?
3. **Second keyless provider** — ship the MET Norway adapter in v1 as an
   automatic fallback, or Open-Meteo only until it ever actually fails?
4. **Location labels in group rooms** — the current-location *label* is
   ward-private by default (a villager-visible "my human is at work" is a
   disclosure). Confirm: weather line + labels render on ward-private
   surfaces only, gated turns get nothing.

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
