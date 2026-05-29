-- Revert for T11262 blob-storageKey heal.
--
-- A contract-conformance data heal is not cleanly reversible: re-emptying the
-- storageKey would reintroduce the `z.string().min(1)` contract violation it
-- fixed, and the original rows held no distinguishing marker (the value was
-- simply '' for every affected row). The heal is also idempotent and lossless
-- (the derived path is recomputable from sha256+mime at any time), so there is
-- nothing to restore. This revert is an intentional no-op.
SELECT 1;
