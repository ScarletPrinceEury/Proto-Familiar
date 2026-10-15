-- Identity canary stamps (0.14.79). An exact line the Familiar keeps in one of
-- its identity files to check its identity loaded whole. The registry is the
-- baseline: Proto-Familiar checks every registered stamp each turn and tells
-- the Familiar when one is missing, changed, or (at_end) no longer last.
-- Detection only: nothing here ever blocks an edit.
CREATE TABLE IF NOT EXISTS identity_canaries (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  filename   TEXT NOT NULL,
  text       TEXT NOT NULL,
  label      TEXT NOT NULL,
  at_end     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_canaries_file ON identity_canaries(category, filename);
