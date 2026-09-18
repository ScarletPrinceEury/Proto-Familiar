-- Trackers — the ward's private ledgers (build spec: docs/trackers-build-spec.md §1).
--
-- Four archetypes: state / inventory / series / gauge. Own tables (the handoff /
-- intentions / locations precedent) — NEVER schedule nodes, never mixed into
-- anything a villager can read (trackers are ward-private wholesale in v1). The
-- LABEL and field schemas are the only structural surface; sensitive entry
-- contents live behind the audience gate at the Node layer.
CREATE TABLE IF NOT EXISTS trackers (
  id          TEXT PRIMARY KEY,            -- slug from label ("mood-x7")
  label       TEXT NOT NULL,
  archetype   TEXT NOT NULL,               -- 'state' | 'inventory' | 'series' | 'gauge'
  schema_json TEXT NOT NULL DEFAULT '[]',  -- ordered field specs (build spec §1.1)
  config_json TEXT NOT NULL DEFAULT '{}',  -- per-tracker knobs (§1.2; incl. §10 gauge config)
  sensitive   INTEGER NOT NULL DEFAULT 0,
  template    TEXT,                         -- template id it was created from, or NULL (custom)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One entry per observation. A corrected/replaced entry stays for audit
-- (superseded=1). For a `gauge`, an entry IS a refill (the event happened, so the
-- gauge goes full); for `inventory`, an entry is one item upsert keyed by `name`.
CREATE TABLE IF NOT EXISTS tracker_entries (
  id           TEXT PRIMARY KEY,           -- slug from tracker label + kind
  tracker_id   TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  ts           TEXT NOT NULL,              -- local-naive; the moment the observation is ABOUT
  payload_json TEXT NOT NULL DEFAULT '{}',
  source       TEXT NOT NULL,              -- 'chat' | 'inferred' | 'clarified' | 'send-button'
  superseded   INTEGER NOT NULL DEFAULT 0, -- corrected/replaced entries stay for audit
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracker_entries_tracker_ts ON tracker_entries(tracker_id, ts);
