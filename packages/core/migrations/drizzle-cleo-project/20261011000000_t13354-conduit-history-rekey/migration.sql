-- T13354 (saga T13339, epic T13340) — CleoDocs schema re-key: the conduit
-- history tables key on the immutable doc row uid, not the mutable slug.
--
-- Spec: `cleo docs fetch cleodocs-rearch-design` §3 + §10 (team-sync verdict,
-- T13365, incorporated); decision D11165.
--
-- What this file does:
--
--   1. `conduit_attachments` gains the Stage C row identity columns (`uid`,
--      `birth_fp`) and a unique index on `uid` — ADD COLUMN only, no rebuild:
--      the doc row is the FK parent of the whole history family, so nothing
--      here touches its keys. Existing rows keep NULL until the open pass
--      fills them deterministically (store/row-identity.ts, the T12341
--      pattern); rows inserted by this build get theirs from the
--      per-connection TEMP trigger and `defaultRowUid`.
--
--   2. `conduit_attachment_versions` is rebuilt (canonical recipe: create
--      `__new_…`, INSERT … SELECT, DROP, RENAME — the T11649 pattern):
--      - the `slug` FK (ON DELETE CASCADE) is gone; `slug` survives as a
--        nullable display/legacy column (no key, no FK) so the
--        signaldock→conduit column-intersection copy still carries it;
--      - `attachment_uid` REFERENCES `conduit_attachments(uid)` and
--        `parent_version_uid` REFERENCES the table's own `uid`, both with
--        NO cascade — history survives the parent;
--      - the UNIQUE(slug, version_number) constraint is dropped:
--        `version_number` is a locally minted display ordinal that collides
--        across devices, never a key (identity = uid + parent_version_uid
--        DAG);
--      - the table gains `uid` / `birth_fp` (NULL until the open fill).
--      The INSERT … SELECT carries every legacy row verbatim (new columns
--      NULL); it calls no non-deterministic function.
--
--   3. `conduit_attachment_approvals` is rebuilt the same way: keyed by
--      `version_uid` (+ nullable `section_id`); the UNIQUE(slug, reviewer)
--      constraint is dropped because approvals are append-only now — a
--      revoke is a new row (tombstone), never an UPDATE/DELETE. `updated_at`
--      is carried for legacy rows; new rows leave it equal to `created_at`.
--      `version_uid` stays NULL on legacy rows (the old key was the display
--      ordinal, which cannot be resolved to a uid inside SQL).
--
--   4. `conduit_attachment_contributors` is rebuilt keyed
--      (attachment_uid, agent_id) with the slug carried as a nullable legacy
--      column. The table is DERIVED (rebuilt from versions after apply) and
--      NOT synced (spec §10), so it gets no uid columns.
--
--   5. New tables: `conduit_doc_slug_aliases` (old slug → doc uid lookup,
--      natural identity over (slug, doc_uid), uid is the primary key),
--      `conduit_doc_heads` (current-version projection per doc: references
--      `head_version_uid`, merge rule docs.head.max-hlc, conflicts recorded
--      on losing concurrent heads) and `section_crdt_states` (LOCAL-ONLY
--      Loro snapshot per doc section — deliberately no FK into a syncing
--      table, T12778; an apply that lands a version resets/rebases this
--      state instead of cascading).
--
-- Foreign keys are OFF for the rebuild window (the recipe requires it). No
-- statement deletes from or re-keys an FK parent (gate 36 rule 6), no DML
-- calls a non-deterministic function (gate 36 rule 5 — the `datetime('now')`
-- occurrences below are DDL column defaults, which are exempt), and no
-- trigger is created here (the owned-trigger clause rule does not apply).
--
-- @task T13354
-- @epic T13340
-- @saga T13339

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 1 — conduit_attachments: row identity columns (ADD COLUMN, no rebuild)
-- --------------------------------------------------------------------------
ALTER TABLE `conduit_attachments` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `conduit_attachments` ADD COLUMN `birth_fp` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_conduit_attachments_uid` ON `conduit_attachments` (`uid`);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 2 — rebuild conduit_attachment_versions (re-keyed to the doc uid)
-- --------------------------------------------------------------------------
DROP INDEX IF EXISTS `idx_conduit_attachment_versions_slug`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conduit_attachment_versions_author`;
--> statement-breakpoint
CREATE TABLE `__new_conduit_attachment_versions` (
	`id` text PRIMARY KEY,
	`uid` text,
	`birth_fp` text,
	`attachment_uid` text,
	`parent_version_uid` text,
	`slug` text,
	`version_number` integer NOT NULL,
	`author_agent_id` text NOT NULL,
	`change_type` text DEFAULT 'patch' NOT NULL,
	`patch_text` text,
	`storage_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`original_size` integer NOT NULL,
	`compressed_size` integer NOT NULL,
	`tokens` integer NOT NULL,
	`change_summary` text,
	`sections_modified` text DEFAULT '[]' NOT NULL,
	`tokens_added` integer DEFAULT 0 NOT NULL,
	`tokens_removed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_conduit_attachment_versions_attachment_uid` FOREIGN KEY (`attachment_uid`) REFERENCES `conduit_attachments`(`uid`) ON DELETE NO ACTION,
	CONSTRAINT `fk_conduit_attachment_versions_parent_version_uid` FOREIGN KEY (`parent_version_uid`) REFERENCES `conduit_attachment_versions`(`uid`) ON DELETE NO ACTION,
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `__new_conduit_attachment_versions` (
	`id`, `slug`, `version_number`, `author_agent_id`, `change_type`,
	`patch_text`, `storage_key`, `content_hash`, `original_size`,
	`compressed_size`, `tokens`, `change_summary`, `sections_modified`,
	`tokens_added`, `tokens_removed`, `created_at`
)
SELECT
	`id`, `slug`, `version_number`, `author_agent_id`, `change_type`,
	`patch_text`, `storage_key`, `content_hash`, `original_size`,
	`compressed_size`, `tokens`, `change_summary`, `sections_modified`,
	`tokens_added`, `tokens_removed`, `created_at`
FROM `conduit_attachment_versions`;
--> statement-breakpoint
DROP TABLE `conduit_attachment_versions`;
--> statement-breakpoint
ALTER TABLE `__new_conduit_attachment_versions` RENAME TO `conduit_attachment_versions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conduit_attachment_versions_uid` ON `conduit_attachment_versions` (`uid`);
--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_versions_attachment` ON `conduit_attachment_versions` (`attachment_uid`);
--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_versions_parent` ON `conduit_attachment_versions` (`parent_version_uid`);
--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_versions_author` ON `conduit_attachment_versions` (`author_agent_id`);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 3 — rebuild conduit_attachment_approvals (version-uid keyed,
--          append-only with tombstone revokes)
-- --------------------------------------------------------------------------
DROP INDEX IF EXISTS `idx_conduit_attachment_approvals_slug`;
--> statement-breakpoint
CREATE TABLE `__new_conduit_attachment_approvals` (
	`id` text PRIMARY KEY,
	`uid` text,
	`birth_fp` text,
	`attachment_uid` text,
	`version_uid` text,
	`section_id` text,
	`slug` text,
	`reviewer_agent_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	`version_reviewed` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_conduit_attachment_approvals_attachment_uid` FOREIGN KEY (`attachment_uid`) REFERENCES `conduit_attachments`(`uid`) ON DELETE NO ACTION,
	CONSTRAINT `fk_conduit_attachment_approvals_version_uid` FOREIGN KEY (`version_uid`) REFERENCES `conduit_attachment_versions`(`uid`) ON DELETE NO ACTION,
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `__new_conduit_attachment_approvals` (
	`id`, `slug`, `reviewer_agent_id`, `status`, `comment`,
	`version_reviewed`, `created_at`, `updated_at`
)
SELECT
	`id`, `slug`, `reviewer_agent_id`, `status`, `comment`,
	`version_reviewed`, `created_at`, `updated_at`
FROM `conduit_attachment_approvals`;
--> statement-breakpoint
DROP TABLE `conduit_attachment_approvals`;
--> statement-breakpoint
ALTER TABLE `__new_conduit_attachment_approvals` RENAME TO `conduit_attachment_approvals`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_conduit_attachment_approvals_uid` ON `conduit_attachment_approvals` (`uid`);
--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_approvals_attachment` ON `conduit_attachment_approvals` (`attachment_uid`);
--> statement-breakpoint
CREATE INDEX `idx_conduit_attachment_approvals_version` ON `conduit_attachment_approvals` (`version_uid`);
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 4 — rebuild conduit_attachment_contributors (derived rollup keyed on
--          the doc uid; NOT synced — rebuilt from versions after apply)
-- --------------------------------------------------------------------------
CREATE TABLE `__new_conduit_attachment_contributors` (
	`attachment_uid` text,
	`slug` text,
	`agent_id` text NOT NULL,
	`version_count` integer DEFAULT 0 NOT NULL,
	`total_tokens_added` integer DEFAULT 0 NOT NULL,
	`total_tokens_removed` integer DEFAULT 0 NOT NULL,
	`first_contribution_at` text NOT NULL,
	`last_contribution_at` text NOT NULL,
	CONSTRAINT `conduit_attachment_contributors_pk` PRIMARY KEY(`attachment_uid`, `agent_id`),
	CONSTRAINT `fk_conduit_attachment_contributors_attachment_uid` FOREIGN KEY (`attachment_uid`) REFERENCES `conduit_attachments`(`uid`) ON DELETE NO ACTION,
	CHECK ("first_contribution_at" IS NULL OR "first_contribution_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("last_contribution_at" IS NULL OR "last_contribution_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
INSERT INTO `__new_conduit_attachment_contributors` (
	`slug`, `agent_id`, `version_count`, `total_tokens_added`,
	`total_tokens_removed`, `first_contribution_at`, `last_contribution_at`
)
SELECT
	`slug`, `agent_id`, `version_count`, `total_tokens_added`,
	`total_tokens_removed`, `first_contribution_at`, `last_contribution_at`
FROM `conduit_attachment_contributors`;
--> statement-breakpoint
DROP TABLE `conduit_attachment_contributors`;
--> statement-breakpoint
ALTER TABLE `__new_conduit_attachment_contributors` RENAME TO `conduit_attachment_contributors`;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Step 5 — new tables: slug aliases, head projection, local CRDT state
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `conduit_doc_slug_aliases` (
	`slug` text NOT NULL,
	`doc_uid` text NOT NULL,
	`reason` text DEFAULT 'rename' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`uid` text,
	CONSTRAINT `conduit_doc_slug_aliases_pk` PRIMARY KEY(`slug`, `doc_uid`),
	CONSTRAINT `fk_conduit_doc_slug_aliases_doc_uid` FOREIGN KEY (`doc_uid`) REFERENCES `conduit_attachments`(`uid`) ON DELETE NO ACTION,
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conduit_doc_slug_aliases_slug` ON `conduit_doc_slug_aliases` (`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conduit_doc_heads` (
	`attachment_uid` text PRIMARY KEY,
	`head_version_uid` text NOT NULL,
	`head_hlc` text NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`last_conflict_json` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`uid` text,
	CONSTRAINT `fk_conduit_doc_heads_attachment_uid` FOREIGN KEY (`attachment_uid`) REFERENCES `conduit_attachments`(`uid`) ON DELETE NO ACTION,
	CONSTRAINT `fk_conduit_doc_heads_head_version_uid` FOREIGN KEY (`head_version_uid`) REFERENCES `conduit_attachment_versions`(`uid`) ON DELETE NO ACTION,
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `section_crdt_states` (
	`attachment_uid` text NOT NULL,
	`section_id` text NOT NULL,
	`snapshot` blob NOT NULL,
	`base_version_uid` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `section_crdt_states_pk` PRIMARY KEY(`attachment_uid`, `section_id`),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint

-- Note: the uid unique indexes on the two new tables are deliberately NOT
-- created here. The open-time identity heal (store/row-identity.ts,
-- ensureRowIdentitySchema) owns them: in the Gate B replay a pre-identity
-- copy drops the uid columns, and a migration-time CREATE INDEX would run
-- before the heal re-adds them ("no such column"). The heal creates
-- `uq_<table>_uid` for every declared table at every open, on every store,
-- so fresh and existing stores alike get the index.

PRAGMA foreign_keys = ON;
