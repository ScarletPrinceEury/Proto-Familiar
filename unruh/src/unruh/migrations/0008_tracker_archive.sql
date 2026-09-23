-- Tracker archive support (ward-facing management, build spec §7).
--
-- A soft PAUSE, distinct from drop_tracker's hard delete: an archived tracker
-- keeps every entry but goes quiet — excluded from the Familiar's active list,
-- its cues, its projections, and passive memorization capture — and can be
-- un-archived at any time. NULL = active; a local-naive timestamp = archived.
ALTER TABLE trackers ADD COLUMN archived_at TEXT;
