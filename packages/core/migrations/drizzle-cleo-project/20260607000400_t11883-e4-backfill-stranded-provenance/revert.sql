-- Revert T11883 (E4) — intentional near-no-op.
--
-- The forward migration is an additive `INSERT OR IGNORE` backfill of stranded
-- provenance rows. There is no PK-stable marker distinguishing a row that this
-- migration inserted from one the runtime/exodus inserted, so a precise undo is
-- not possible (and not desirable — the data is valid, FK-consistent provenance).
-- The bare source tables remain until E5 drops them, so re-applying E4 is safe.
--
-- @task T11883
SELECT 1;
