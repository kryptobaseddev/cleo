-- T13362 (saga T13339, epic T13340) — retire the legacy docs-publications.json
-- sidecar: the publication ledger moves into the project `cleo.db` as store
-- rows, and the pre-commit drift hook / CI docs-drift gate read the table.
--
-- What this file does:
--
--   1. Creates `docs_publications`, the SYNCING (portable-project,
--      table-classification) publication ledger. One row per published
--      (owner, blob, path) triple; `cleo docs publish` upserts on that
--      natural key and the drift surfaces (`cleo docs status`, the
--      pre-commit hook, the attachment janitor's publication-sha protection)
--      read it back. Identity is NATURAL over (owner_id, blob_name,
--      published_path) in ROW_IDENTITY: both devices derive one uid per
--      triple and a re-publish on either device coalesces on apply.
--
--      The `uid` column is declared last (the row-identity heal appends a
--      missing uid column at the end, T13359 precedent) and its UNIQUE index
--      is deliberately NOT created here — `ensureRowIdentitySchema` owns
--      `uq_<table>_uid` for every declared table at every open.
--
--   2. No DML runs here (the legacy `.cleo/docs-publications.json` entries are
--      seeded lazily by the read shim on first access, idempotently), so
--      nothing is non-deterministic (gate 36 rule 5); the `datetime('now')`
--      occurrences in OTHER folders are irrelevant — this file has no column
--      defaults at all. No trigger is created (the owned-trigger clause rule
--      does not apply), no statement deletes from or re-keys an FK parent
--      (rule 6), and no `_sync_cap_` name appears (rule 2).
--
-- @task T13362
-- @epic T13340
-- @saga T13339

CREATE TABLE IF NOT EXISTS `docs_publications` (
	`owner_id` text NOT NULL,
	`blob_name` text NOT NULL,
	`published_path` text NOT NULL,
	`last_blob_sha` text NOT NULL,
	`published_at` text NOT NULL,
	`uid` text,
	CONSTRAINT `docs_publications_pk` PRIMARY KEY(`owner_id`, `blob_name`, `published_path`),
	CHECK ("published_at" IS NULL OR "published_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_docs_publications_published_path` ON `docs_publications` (`published_path`);
