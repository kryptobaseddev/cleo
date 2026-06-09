-- T11889 (T11889-A · T11911) — the self-improvement-loop DHQ sink (`selfimprove_dhq`).
--
-- One row per Dogfood-Harness-Question raised by `cleo selfimprove run`: the loop
-- replays a canned scenario, diffs the LAFS envelopes against a golden, and on
-- regression UPSERTs exactly ONE row here via the leased Gate-3 accessor
-- (selfimprove-dhq-store.ts). On green it writes nothing.
--
-- Co-located inside EACH scope's consolidated cleo.db (this file is byte-identical
-- in drizzle-cleo-project and drizzle-cleo-global so the two lineages produce the
-- SAME migration hash — the consolidated single-file journal converges across both
-- under the CONSOLIDATED_JOURNAL_LINEAGES cross-lineage guard, T11829). Pure runtime
-- infrastructure (like `_writer_leases` from T11627 and `pi_session_*` from T11899)
-- — NOT part of the exodus target shape under `schema/cleo-project/`.
--
-- ## Idempotency invariant (partial UNIQUE index)
--
-- At most ONE row per `question_hash` may carry `status = 'open'`, so a repeated
-- regression UPSERTs the same open row instead of spamming duplicates. drizzle-orm
-- cannot model a partial WHERE unique index, so it is emitted here as raw SQL (the
-- established repo pattern — cf. `_writer_leases.active`, T11627 ·
-- `project_agent_refs.enabled`). The drizzle schema (selfimprove-dhq-schema.ts)
-- declares ONLY the full-column table plus the two non-partial indexes drizzle CAN
-- emit; the runtime bootstrap asserts this partial index exists
-- (assertSelfimproveDhqOpenIndexPresent).
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-project) which already creates dozens of tables, so `selfimprove_dhq` is
-- NEVER the first CREATE on a fresh DB — rootpage 2 is already owned by
-- `__drizzle_migrations` / the baseline tables. No journal pre-create is required
-- (the lease cold-open path pre-creates `__drizzle_migrations` before any first
-- table, so the precondition holds even on a freshly cold-opened DB).
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op. Each
-- statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11889
-- @task T11911
-- @epic T11889

CREATE TABLE IF NOT EXISTS `selfimprove_dhq` (
  `id` INTEGER PRIMARY KEY,
  `dhq_id` TEXT NOT NULL,
  `scenario` TEXT NOT NULL,
  `question_hash` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `regression_json` TEXT NOT NULL,
  `status` TEXT NOT NULL DEFAULT 'open',
  `severity` TEXT,
  `pr_url` TEXT,
  `run_id` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_selfimprove_dhq_status` ON `selfimprove_dhq` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_selfimprove_dhq_scenario` ON `selfimprove_dhq` (`scenario`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_selfimprove_dhq_open` ON `selfimprove_dhq` (`question_hash`) WHERE `status` = 'open';
