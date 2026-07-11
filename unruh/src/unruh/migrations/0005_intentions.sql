-- Intentions (Initiative Pass 3).
--
-- A first-class "my intention" object: a future the Familiar writes for
-- itself. The substrate for planning, follow-through, and "rounds" (phase-
-- bound standing intentions — self-maintenance as identity, not cron).
--
-- Distinct enough from schedule/interest nodes to warrant its own table
-- (its own trigger/condition/status/visibility shape), following the
-- handoff precedent. Intentions are per-embodiment cognition — the ward's
-- schedule surfaces must never silently grow Familiar-internal rows, so
-- these live apart and are never mixed into the schedule layer.
--
-- Time is LOCAL-naive, exactly like the rest of Unruh (trigger_at is the
-- ward's wall-clock; no offset, no tz math by the model).
CREATE TABLE IF NOT EXISTS intentions (
  id             TEXT PRIMARY KEY,             -- readable slug from `what`
  what           TEXT NOT NULL,                -- the intention itself, first person
  why            TEXT,                         -- the payoff-turn rationale (may be NULL)
  refs_json      TEXT NOT NULL DEFAULT '[]',   -- JSON array of slug ids (schedule/memory), dereferenced fresh at fire — never snapshotted
  trigger_kind   TEXT NOT NULL DEFAULT 'none', -- 'at' | 'phase' | 'on_next_contact' | 'none'
  trigger_at     TEXT,                         -- local-naive ISO when trigger_kind='at'
  trigger_phase  TEXT,                         -- phase label when trigger_kind='phase' (a round)
  recurring      INTEGER NOT NULL DEFAULT 0,   -- 1 = a standing round (re-fires each occurrence); 0 = one-shot
  condition_json TEXT NOT NULL DEFAULT '{}',   -- tiny vocab tripwire: {minContactGapMs, needsStatus, unresolvedRefs}
  status         TEXT NOT NULL DEFAULT 'active',-- 'active' | 'done' | 'dropped'
  source         TEXT,                         -- 'chat' | 'pondering' | 'reflection' | 'noticing'
  visibility     TEXT,                         -- per-intention override: 'shared' | 'private' | NULL=inherit global
  last_fired_date TEXT,                        -- local YYYY-MM-DD of the last occurrence that fired (per-occurrence dedup for rounds)
  created_at     TEXT NOT NULL,                -- local-naive ISO
  updated_at     TEXT NOT NULL                 -- local-naive ISO
);

CREATE INDEX IF NOT EXISTS idx_intentions_status        ON intentions(status);
CREATE INDEX IF NOT EXISTS idx_intentions_trigger       ON intentions(trigger_kind);
CREATE INDEX IF NOT EXISTS idx_intentions_trigger_phase ON intentions(trigger_phase);

-- The global rounds-visibility default lives in meta ('rounds_visibility',
-- default 'shared' — transparency unless the Familiar chooses otherwise).
-- Per-intention `visibility` overrides it. Seeded lazily by the accessor;
-- no row here so a fresh DB inherits the code default.
