-- Locations + weather cache (Weather sense, Session W-A).
--
-- Locations are the ward's places (home, work, a friend's) at city/ZIP
-- granularity. The LABEL is the only part that ever reaches the LLM; the
-- coordinates are local-only, sent to the weather API and nowhere else. Its
-- own table (the handoff/intentions precedent) — never a schedule node, and
-- never mixed into anything a villager can read.
CREATE TABLE IF NOT EXISTS locations (
  id          TEXT PRIMARY KEY,            -- slug from label ("home-x7")
  label       TEXT NOT NULL,               -- the ONLY part the LLM ever sees
  lat         REAL,                        -- from one-time geocoding; never in a prompt
  lon         REAL,                        -- ditto
  place_name  TEXT,                        -- geocoder's resolved name; ward-UI confirm only
  timezone    TEXT,                        -- IANA zone from geocoding; for provider-time normalisation
  is_current  INTEGER NOT NULL DEFAULT 0,  -- exactly one row = 1 (enforced in code)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_current ON locations(is_current);

-- Forecast cache, one row per location, replaced on each refresh. The Node
-- fetch half writes here via weather_ingest; Unruh stays network-free. Times
-- inside the JSON are LOCAL-naive for the location (the Node normaliser
-- converts provider times once), so the model never does timezone maths.
CREATE TABLE IF NOT EXISTS weather_cache (
  location_id  TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- 'open-meteo' | 'met-norway' | ...
  fetched_at   TEXT NOT NULL,              -- local-naive ISO; the honesty clock
  current_json TEXT NOT NULL DEFAULT '{}', -- {temp_c, weather_code, precip_mm, wind_kmh}
  hourly_json  TEXT NOT NULL DEFAULT '[]', -- [{time, temp_c, weather_code, precip_mm, precip_prob, wind_kmh}] next ~48h
  updated_at   TEXT NOT NULL
);
