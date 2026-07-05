-- Stewardship Pass 2b: requirement templates.
--
-- A template bundles the prerequisites for a KIND of undertaking that
-- carries a barrier for my human — "leaving the house" (tag: outside) needs
-- clean clothes, shoes by the door. It is keyed by the obstacle tag it
-- matches, so when that tag is on an event the motor layer can pull the
-- bundle in as SUGGESTED requires-edges and prune what doesn't apply this
-- time. The template proposes; the instance decides.
--
-- Storage only. Applying a template (resolve-or-create the prerequisite
-- tasks + link `requires` edges) is orchestrated in the JS motor layer from
-- these records plus the existing schedule wrappers — deliberately NOT a
-- schedule node, so templates never leak into the schedule window.
CREATE TABLE IF NOT EXISTS templates (
  id                 TEXT PRIMARY KEY,             -- readable slug id
  tag                TEXT NOT NULL UNIQUE,         -- obstacle tag it keys off ('outside')
  label              TEXT NOT NULL,                -- human name ('leaving the house')
  prerequisites_json TEXT NOT NULL DEFAULT '[]',   -- ordered list of prerequisite task labels
  created_at         TEXT NOT NULL,                -- ISO-8601 local-naive
  updated_at         TEXT NOT NULL
);
