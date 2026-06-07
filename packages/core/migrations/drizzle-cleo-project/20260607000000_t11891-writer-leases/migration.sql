-- T11627 (ST-2) — DbWriterLease arbitration tables (local-mode, daemon-disabled).
--
-- Co-located inside EACH scope's consolidated cleo.db (this file is byte-identical
-- in drizzle-cleo-project and drizzle-cleo-global so the two lineages produce the
-- SAME migration hash — the consolidated single-file journal converges across both
-- under the CONSOLIDATED_JOURNAL_LINEAGES cross-lineage guard, T11829).
--
-- The lease engine (packages/core/src/store/writer-lease.ts) arbitrates a single
-- in-process writer per (scope, lane) via BEGIN IMMEDIATE + epoch-CAS over the
-- `_writer_leases` row, healing the T5158 multi-writer corruption WITHOUT a running
-- supervisor daemon.
--
-- AC1 (at most one active writer per scope/lane) is enforced by the PARTIAL UNIQUE
-- index `ux_writer_leases_active … WHERE active = 1`. drizzle-orm cannot model a
-- partial WHERE index, so it is emitted here as raw SQL (the established repo
-- pattern — cf. project_agent_refs.enabled in conduit-schema). The drizzle schema
-- (writer-lease-schema.ts) declares ONLY the full-column tables; the runtime
-- bootstrap asserts this index exists (assertWriterLeaseActiveIndexPresent).
--
-- Each statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one.
-- (The marker token is intentionally NOT spelled out in this comment: drizzle's
-- readMigrationFiles splits the file on that literal substring, so writing it here
-- would split the comment mid-line and corrupt statement one.)
--
-- @task T11627
-- @epic T11625

CREATE TABLE IF NOT EXISTS `_writer_leases` (
  `id` INTEGER PRIMARY KEY,
  `scope` TEXT NOT NULL,
  `lane` TEXT NOT NULL,
  `holder_id` TEXT NOT NULL,
  `holder_pid` INTEGER NOT NULL,
  `epoch` INTEGER NOT NULL,
  `acquired_at` INTEGER NOT NULL,
  `heartbeat_at` INTEGER NOT NULL,
  `ttl_ms` INTEGER NOT NULL,
  `reentrancy_depth` INTEGER NOT NULL DEFAULT 1,
  `active` INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_writer_leases_active` ON `_writer_leases` (`scope`, `lane`) WHERE `active` = 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_writer_queue` (
  `ticket` INTEGER PRIMARY KEY AUTOINCREMENT,
  `scope` TEXT NOT NULL,
  `lane` TEXT NOT NULL,
  `holder_id` TEXT NOT NULL,
  `priority` INTEGER NOT NULL DEFAULT 100,
  `enqueued_at` INTEGER NOT NULL,
  `deadline_at` INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_writer_queue_order` ON `_writer_queue` (`scope`, `lane`, `priority` ASC, `ticket` ASC);
