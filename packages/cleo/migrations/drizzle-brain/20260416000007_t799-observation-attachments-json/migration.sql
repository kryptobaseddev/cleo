-- T799 BRAIN: Add attachments_json column to brain_observations
--
-- Context: T799 Observation × Attachment wiring.
-- Extends brain_observations to record attachment SHA-256 refs so that
-- `cleo memory observe --attach <sha256>` can link an observation to one or
-- more content attachments from the tasks.db attachment store.
--
-- Column: attachments_json TEXT NULLABLE
--   JSON array of SHA-256 hex strings, e.g. '["a1b2...","c3d4..."]'.
--   Null = no attachments. Non-null = one or more soft refs.
--   Referential integrity is NOT enforced at the DB level.
--
-- Reversibility: this is an additive nullable column with no default.
-- Rolling back: DROP COLUMN (SQLite 3.35+) or use a schema migration.

ALTER TABLE brain_observations ADD COLUMN attachments_json TEXT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_observations_attachments`
  ON `brain_observations` (`attachments_json`)
  WHERE `attachments_json` IS NOT NULL;
