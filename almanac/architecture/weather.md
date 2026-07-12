---
title: Weather
topics: [architecture, weather]
sources:
  - id: weather-build-spec
    type: file
    path: docs/weather-build-spec.md
  - id: weather-source
    type: file
    path: weather-source.js
  - id: weather-providers
    type: file
    path: weather-providers.js
  - id: weather-format
    type: file
    path: weather-format.js
  - id: weather-mirror
    type: file
    path: weather-mirror.js
  - id: unruh-location
    type: file
    path: unruh/src/unruh/location.py
  - id: unruh-migration
    type: file
    path: unruh/src/unruh/migrations/0006_locations.sql
---

# Weather

Weather sense shipped in Session W-A (0.8.76-alpha) as the first ward-private tier of the Familiar's **weather sense** [@weather-build-spec]. The Familiar now learns the weather where its human is and feels it in the `[Now]` block — entirely in code, with no new LLM call and no new background loop. The subsystem enforces a load-bearing invariant: **locations never reach the LLM** [@weather-build-spec].

## The invariant: locations stay local

A city or ZIP is geocoded exactly once at entry (via `weather-source.js geocode`), and only coordinates go to the weather API thereafter [@weather-build-spec]. The model reads a code-built qualitative line ("6°C (cold), light rain, easing off around 17:00") and the ward's own label ("home", "work") — never *where* a place is [@weather-build-spec].

Structural enforcement lives in [Unruh](unruh): `location_public` returns `{id, label, is_current}` only [@weather-build-spec]. The coordinate-bearing shapes — `location_private` and `weather_locations_private` — are called by Node code only and are never bound as model tools [@weather-build-spec]. Coordinates are data for the fetch, not knowledge for the entity. This boundary is structural, not procedural, so no future change can accidentally leak coordinates to the model.

## Why it rides existing requests instead of adding a loop

Per "ride existing requests, gate in code" (a pattern established elsewhere in the system): weather refresh is a self-gated fire-and-forget (`refreshWeatherIfDue`) hung on the 30-second reminders tick — no-op unless enabled and the current location's cache is older than 6 hours, guarded against overlap [@weather-build-spec]. It also runs at boot and is forced on a location add/switch/delete. There is no weather loop and no weather LLM call; the whole subsystem is pure code, and the model only ever *reads* the output [@weather-build-spec].

## Two inherited operating rules

Weather applies two invariants borrowed from [Exact Values Are Code's Job](../decisions/exact-values-in-code):

- **Exact-machine-values rule:** the model never types a weather value [@weather-build-spec]. `weather-format.js` turns machine numbers into words and bands; the model repeats the code-built line.
- **Honesty rule:** a forecast older than `WEATHER_STALE_MS` (12 hours) yields an empty line — the `[Now]` weather line *drops* rather than assert a stale reading [@weather-build-spec]. Missing or garbage fields do the same. Failure renders as absence, never as a wrong claim and never as a throw into the chat path (the graceful-degradation rule).

## Where weather appears

Weather appears only on four **ward-facing** `[Now]` call sites: triage, warmth, noticing, and ward-private web chat [@weather-build-spec]. Villager/Discord surfaces never receive it — the Discord gateway doesn't use `buildTimeAnchorBlock` at all, so the coordinate-free line structurally cannot reach a villager [@weather-build-spec]. The vague/gated tier for shared surfaces is deferred to Session W-B.

## Module map (W-A)

- `weather-source.js` — geocode (once) + fetchForecast (provider chain, local-naive stamp); Node owns the network (the gcal precedent); failure → `{ok:false}`, stale cache kept [@weather-source].
- `weather-providers.js` — Open-Meteo primary + MET Norway fallback, normalized to one internal shape [@weather-providers].
- `weather-format.js` — WMO words, qualitative bands, precip transition, the `[Now]` line, the honesty rule [@weather-format].
- `weather-mirror.js` — sync read-mirror (`last-activity.js` precedent) so the hot `[Now]` path reads without an async MCP round-trip; the single `readWeatherNowLine` call `buildTimeAnchorBlock` makes; honours `PROTO_FAMILIAR_WEATHER_DISABLED=1` [@weather-mirror].
- Unruh `location.py` + migration `0006_locations.sql` — the `locations` + `weather_cache` store; times inside cached JSON are local-naive (same frame as the forecast's hourly times) [@unruh-location] [@unruh-migration].

## Off-switch and testing

Off-switch: `weatherEnabled` (default ON) + `PROTO_FAMILIAR_WEATHER_DISABLED=1` [@weather-build-spec]. Tests: 25 Node + 12 Python; full suites green (1368 Node, 290 Python) [@weather-build-spec]. Shipped via PR #190.
