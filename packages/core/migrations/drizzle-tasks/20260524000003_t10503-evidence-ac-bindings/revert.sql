-- T10503 — Reversal of `evidence_ac_bindings` table creation.
--
-- Drops indexes first (defensive — SQLite would drop them as part of
-- DROP TABLE, but explicit drops make the reversal idempotent against
-- a partial-apply scenario).
--
-- @task T10503

DROP INDEX IF EXISTS `idx_evidence_ac_bindings_evidence_atom_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_evidence_ac_bindings_ac_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `uq_evidence_ac_bindings_atom_ac_type`;
--> statement-breakpoint
DROP TABLE IF EXISTS `evidence_ac_bindings`;
