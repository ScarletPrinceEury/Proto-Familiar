-- Propose-only identity cleanup (0.14.78, ward + Familiar decision after the
-- first identity review). The graduation pass used to CUT identity files on its
-- own, and once cut a paragraph it never filed anywhere (the Familiar's own
-- lines about autonomy). Now it only proposes: an exact passage from the file,
-- the standing fact it would become, and why. Nothing changes until the
-- Familiar applies (or dismisses) the proposal with its own tools.
CREATE TABLE IF NOT EXISTS cleanup_proposals (
  id            TEXT PRIMARY KEY,      -- readable slug (summary-derived)
  category      TEXT NOT NULL,         -- identity category of the file
  filename      TEXT NOT NULL,
  passage       TEXT NOT NULL,         -- exact text from the file (verified at creation)
  fact          TEXT NOT NULL,         -- the standing fact it would become
  register      TEXT NOT NULL,         -- 'me' | 'ward'
  care_weight   TEXT,                  -- 'high' when it's a care detail about my human
  summary       TEXT NOT NULL,
  why           TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | applied | dismissed | stale
  memory_id     TEXT,                  -- the standing fact, once applied
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cleanup_proposals_status ON cleanup_proposals(status, filename);

-- When the pass last reviewed each file, so an unchanged file isn't re-reviewed
-- (and re-billed) every lifecycle pass while its proposals wait.
ALTER TABLE identity_files ADD COLUMN last_reviewed_at TEXT;
