-- Content-gating (build spec Phase 3): a per-memory content tag ("topic:level",
-- e.g. "medical:sensitive") that the recall gate (Phase 4) matches against each
-- Village tier's per-topic grants. Nullable + backfilled from the existing
-- `category` for old rows (memory.backfill_content_tags). Indexed for the gate.
ALTER TABLE memories ADD COLUMN content_tag TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_content_tag ON memories(content_tag);
