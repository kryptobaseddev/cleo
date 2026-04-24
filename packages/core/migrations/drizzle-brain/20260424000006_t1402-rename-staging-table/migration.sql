-- T1402: Rename brain_v2_candidate → brain_observations_staging (semantic clarity)
--
-- The shadow-write staging table for the T1147 BRAIN noise sweep was named
-- `brain_v2_candidate` in the original migration (20260424000005). The "v2"
-- prefix read like a schema version number but was intended as "the v2
-- (cleaned) version of each row awaiting validation." Owner flagged the name
-- as misleading during T-COUNCIL-VERIFICATION-2026-04-24 audit. The correct
-- semantic is "staging" — rows awaiting validation before cutover to live
-- brain_observations.
--
-- Safety:
--   - SQLite 3.25+ supports atomic ALTER TABLE RENAME TO.
--   - Table is empty on the development DB at rename time (0 rows confirmed).
--   - Any downstream install with pending rows (hypothetical — no public
--     sweep has run against 2440-entry corpus yet) preserves data via
--     ALTER TABLE RENAME (name changes, rows preserved).
--   - Old indexes (idx_bvc_*) dropped; new indexes (idx_bos_*) recreated.
--   - brain_backfill_runs is unchanged — the sweep run-log table keeps
--     its original name (only the staging table is renamed).
--
-- DEPENDS ON: 20260424000005_t1147-add-brain-v2-candidate (brain_v2_candidate must exist)

ALTER TABLE brain_v2_candidate RENAME TO brain_observations_staging;

DROP INDEX IF EXISTS idx_bvc_sweep_run;
DROP INDEX IF EXISTS idx_bvc_source;
DROP INDEX IF EXISTS idx_bvc_status;

CREATE INDEX IF NOT EXISTS idx_bos_sweep_run ON brain_observations_staging(sweep_run_id);
CREATE INDEX IF NOT EXISTS idx_bos_source ON brain_observations_staging(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_bos_status ON brain_observations_staging(validation_status);
