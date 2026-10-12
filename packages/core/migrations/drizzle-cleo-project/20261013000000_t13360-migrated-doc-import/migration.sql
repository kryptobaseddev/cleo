-- T13360 (saga T13339, epic T13340) — honest migration of legacy docs into
-- the re-keyed store (spec `cleodocs-rearch-design` §5, D11165).
--
-- What this file does:
--
--   1. `conduit_attachment_versions` gains an `origin` column (nullable).
--      NULL means the version was written natively by this build; the string
--      'migrated' marks a row imported from the legacy docs store by the
--      T13360 data migration (spec §5: "every imported history row is labeled
--      origin: migrated"). ADD COLUMN only — no rebuild: the key columns
--      (id, uid, attachment_uid, version_number) are untouched, so the
--      FK-parent rebuild caveat does not apply.
--
--   2. Creates `conduit_doc_migration_ledger`, the AUDITABLE record for the
--      data migration (spec §5: the dangling-pointer docs are "content-
--      captured or marked dangling — never silently imported"; AC3). One row
--      per migrated doc slug, keyed by the slug itself; the `uid` column is
--      declared last (the row-identity heal appends a missing uid column at
--      the end, T13359 precedent) and its UNIQUE index is deliberately NOT
--      created here — `ensureRowIdentitySchema` owns `uq_<table>_uid` for
--      every declared table at every open. `status` is frozen at the DDL
--      layer to ('captured','dangling').
--
--      The table is SYNCING (portable-project, table-classification) with a
--      NATURAL row identity over (slug) in ROW_IDENTITY: both devices derive
--      one uid per slug, a re-run on either device coalesces onto the same
--      row, and the append-only accessor (never UPDATE, never DELETE) makes
--      every row an immutable audit receipt of what the migration did.
--
--   3. No DML runs here (the data import is the harness-run `cleo docs
--      migrate`), so nothing is non-deterministic (gate 36 rule 5); the
--      `datetime('now')` occurrences below are DDL column defaults, which are
--      exempt. No trigger is created (the owned-trigger clause rule does not
--      apply), no statement deletes from or re-keys an FK parent (rule 6),
--      and no `_sync_cap_` name appears (only `store/sync/machinery.ts` owns
--      those, gate 36 rule 2).
--
-- @task T13360
-- @epic T13340
-- @saga T13339

ALTER TABLE `conduit_attachment_versions` ADD COLUMN `origin` text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `conduit_doc_migration_ledger` (
	`slug` text NOT NULL,
	`doc_uid` text,
	`status` text DEFAULT 'captured' NOT NULL,
	`reason` text NOT NULL DEFAULT '',
	`legacy_path` text,
	`legacy_sha256` text,
	`versions_imported` integer DEFAULT 0 NOT NULL,
	`migrated_at` text DEFAULT (datetime('now')) NOT NULL,
	`uid` text,
	CONSTRAINT `conduit_doc_migration_ledger_pk` PRIMARY KEY(`slug`),
	CHECK ("status" IN ('captured','dangling')),
	CHECK ("migrated_at" IS NULL OR "migrated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_conduit_doc_migration_ledger_doc_uid` ON `conduit_doc_migration_ledger` (`doc_uid`);
