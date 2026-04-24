-- T1147 Wave 7: Add brain_v2_candidate staging table
--
-- Shadow-write envelope for the BRAIN noise sweep.
-- Holds one row per candidate entry targeted by the T1147 reconciler sweep.
-- Anchored to a brain_backfill_runs row (kind='noise-sweep-2440', status='staged').
--
-- Workflow:
--   1. W7-3 detector populates brain_v2_candidate rows + one brain_backfill_runs row.
--   2. Autonomous 100-entry stratified validation writes sample JSON to agent-outputs.
--   3. `cleo memory sweep --approve <runId>` triggers W7-4 executor:
--        - Opens cutover tx with PRAGMA busy_timeout = 10000
--        - Sets killSwitch=true in .cleo/sentient-state.json (Option A self-healing gate)
--        - Applies actions (purge/keep/reclassify/promote) to live tables
--        - Sets provenance_class = 'noise-purged' (purge) or 'swept-clean' (others)
--        - Updates brain_backfill_runs.status = 'approved'
--        - Restores killSwitch=false on commit AND rollback
--   4. `cleo memory sweep --status` reads brain_backfill_runs WHERE kind='noise-sweep-2440'
--   5. `cleo memory doctor --assert-clean` exits non-zero when pending rows exist here.
--
-- DEPENDS ON: 20260424000001_t1260-provenance-class (provenance_class columns must exist)
-- DEPENDS ON: brain_backfill_runs table (present since T1003)

CREATE TABLE IF NOT EXISTS brain_v2_candidate (
  id                   TEXT PRIMARY KEY,
  source_table         TEXT NOT NULL,        -- brain_observations|brain_learnings|brain_decisions|brain_patterns
  source_id            TEXT NOT NULL,        -- PK in source_table
  sweep_run_id         TEXT NOT NULL,        -- FK to brain_backfill_runs.id
  action               TEXT NOT NULL,        -- purge|keep|reclassify|promote
  new_quality_score    REAL,                 -- replacement score for reclassify/promote (nullable)
  new_invalid_at       TEXT,                 -- ISO 8601 invalid_at for purge (nullable)
  new_provenance_class TEXT,                 -- swept-clean|noise-purged (nullable until cutover)
  validation_status    TEXT NOT NULL DEFAULT 'pending', -- pending|applied|skipped
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bvc_sweep_run ON brain_v2_candidate(sweep_run_id);
CREATE INDEX IF NOT EXISTS idx_bvc_source ON brain_v2_candidate(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_bvc_status ON brain_v2_candidate(validation_status);
