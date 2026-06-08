-- T11761 (S3 · T11899) — Pi `SessionStorage` tree-persistence tables.
--
-- Backs `CleoSessionStorage` (packages/core/src/llm/pi/pi-session-storage.ts):
-- the durable cleo.db implementation of Pi's tree-structured `SessionStorage`
-- interface (@earendil-works/pi-agent-core). Every Pi session is a tree of
-- `SessionTreeEntry` nodes (id / parentId / timestamp / type / payload) plus one
-- leaf pointer per session; this file is the physical home for both.
--
-- Pure runtime infrastructure (like `_writer_leases` from T11627) — NOT part of
-- the exodus target shape under `schema/cleo-project/`. Co-located inside EACH
-- scope's consolidated cleo.db via the existing drizzle-cleo-project /
-- drizzle-cleo-global migration sets; this file is byte-identical across both
-- lineages so the two produce the SAME migration hash (the consolidated
-- single-file journal converges across both under CONSOLIDATED_JOURNAL_LINEAGES,
-- T11829). The Pi adapter resolves PROJECT scope; the global copy keeps the two
-- lineages' DDL convergent (the lease-table precedent).
--
-- ALL writes go through the writer lease (withWriterLease('project', 'bulk', …),
-- writer-lease.ts:1067) — the adapter NEVER opens a raw writer (Gate 3). These
-- tables are written by the store accessor (pi-session-store.ts) over the native
-- handle openDualScopeDb already holds, inside the leased section.
--
-- Each statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11899
-- @task T11761
-- @epic T10403

CREATE TABLE IF NOT EXISTS `pi_session_entries` (
  `session_id` TEXT NOT NULL,
  `entry_id` TEXT NOT NULL,
  `parent_id` TEXT,
  `type` TEXT NOT NULL,
  `payload_json` TEXT NOT NULL,
  `seq` INTEGER NOT NULL,
  `ts` TEXT NOT NULL,
  PRIMARY KEY (`session_id`, `entry_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_pi_session_entries_seq` ON `pi_session_entries` (`session_id`, `seq` ASC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_pi_session_entries_parent` ON `pi_session_entries` (`session_id`, `parent_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pi_session_leaf` (
  `session_id` TEXT PRIMARY KEY,
  `leaf_id` TEXT,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL
);
