-- T10504 — Create `task_acceptance_criteria_history` retention table.
--
-- Append-only log of acceptance-criterion text changes. Records the AC
-- text BEFORE each change so drift forensics can answer:
--   * "show the latest drift event for AC X" (idx + LIMIT 1)
--   * "was this AC ever in the form the bound evidence atom recorded?"
--   * "how many edits since the atom was bound?"
--
-- Per T10494 research doc `ac-history-model-decision` (decision D013),
-- this is a DEDICATED 5-column table, NOT an extension of the
-- docs-provenance attachments mechanism. Rationale:
--   1. AC versions are machine-managed positional clauses, not
--      author-published artefacts — wrong taxonomic home.
--   2. Sidesteps the BUILTIN_DOC_KINDS / canon.yml / writer-registry
--      churn that would slow the T10381 8-PR sequence.
--   3. ~24× lower row-count multiplier than the attachments alternative.
--
-- ## Why no FK on ac_id
--
-- `ac_id` is INTENTIONALLY NOT declared `REFERENCES
-- task_acceptance_criteria(id)`. AC rows can be deleted (parent-task
-- cancel cascade, explicit edit removal); the drift forensics use-case
-- requires history to outlive the AC row. Orphan rows are an accepted
-- cost for unbounded auditability.
--
-- ## Why INTEGER AUTOINCREMENT primary key
--
-- High-volume append-only log. Sequential integer PKs are ~2× faster
-- than UUIDs for the dominant access pattern (sequential insert, scan
-- by ac_id). The PK is opaque — no consumer addresses rows by `id`;
-- the `(ac_id, recorded_at DESC)` index drives the only read path.
--
-- ## reason values
--
-- 'drift' | 'edit' | 'backfill' | 'cancel' | 'restore' | future kinds.
-- NOT enforced via CHECK constraint — locking values behind a migration
-- would block legitimate future event kinds.
--
-- ## Schema independence
--
-- This table has ZERO foreign keys (intentional, per above). It is
-- ORDER-INDEPENDENT vs sibling T10502 (`task_acceptance_criteria`) and
-- T10503 (`evidence_ac_bindings`). The 14-digit timestamp ends in `04`
-- to order CLEANLY after T10502 (`02`) and T10503 (`03`) on main.
--
-- DEPENDS ON: nothing (independent of T10502, T10503, attachments).
-- SAFE FOR:   SQLite 3.35+ (CREATE TABLE is unconditional and atomic).
--
-- @task T10504
-- @epic T10381 (E-DRIZZLE-MIGRATION)
-- @saga T10377 (SG-IVTR-AC-BINDING)
-- @decision D013
-- @adr ADR-079-r1 §D6

CREATE TABLE `task_acceptance_criteria_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `ac_id` text NOT NULL,
  `recorded_at` text NOT NULL DEFAULT (datetime('now')),
  `previous_text` text NOT NULL,
  `reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ac_history_ac_id_recorded_at`
  ON `task_acceptance_criteria_history` (`ac_id`, `recorded_at` DESC);
