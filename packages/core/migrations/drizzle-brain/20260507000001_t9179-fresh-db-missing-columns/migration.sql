-- T9179: Forward migrations for columns only delivered via ensureColumns() on fresh DBs.
--
-- Three columns exist in the Drizzle schema definition (memory-schema.ts) and in
-- ensureColumns() safety-net calls in memory-sqlite.ts, but were never added as
-- explicit ALTER TABLE migrations:
--
--   1. brain_retrieval_log.retrieval_order (integer)
--      brain_retrieval_log.delta_ms        (integer)
--      — T673-M1 explicitly omitted these, assuming they "already existed via
--        self-healing DDL". That assumption fails on a fresh DB. This migration
--        adds them so fresh installs get the columns via Drizzle, not ensureColumns().
--
--   2. brain_observations.stability_score (real DEFAULT 0.5)
--      — Added via ensureColumns() in memory-sqlite.ts T1001 block but was never
--        committed as a Drizzle migration. This migration provides the forward DDL.
--
-- All three columns are declared in memory-schema.ts with their correct types.
-- These ALTER TABLE statements are idempotent-safe because Drizzle's migration
-- runner tracks journal state, and the ensureColumns() safety-net will skip them
-- if they already exist.
--
-- SAFE FOR: SQLite 3.35+ (ALTER TABLE ADD COLUMN is atomic)

ALTER TABLE brain_retrieval_log ADD COLUMN retrieval_order INTEGER;
--> statement-breakpoint
ALTER TABLE brain_retrieval_log ADD COLUMN delta_ms INTEGER;
--> statement-breakpoint
ALTER TABLE brain_observations ADD COLUMN stability_score REAL DEFAULT 0.5;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brain_observations_stability_score
  ON brain_observations (stability_score);
