-- T13359 (saga T13339, epic T13340) — decisions-vs-ADRs methodology (spec
-- `cleodocs-rearch-design` §4/§10, D11165): the two-way link table between
-- D#### brain ledger decisions and curated ADR docs.
--
-- What this file does:
--
--   1. Creates `decision_adr_links`, a SYNCING, append-only table keyed by
--      the NATURAL composite key (decision_id, adr_slug) — the spec §10
--      requirement that both devices derive the same row uid for one pair, so
--      concurrent identical links coalesce instead of breaking a unique
--      index on apply. The composite PRIMARY KEY is the natural key itself
--      (the `conduit_doc_slug_aliases` pattern, T13354).
--
--   2. Append-only means no DELETE and no resurrection: an unlink is a
--      one-way monotonic latch flipping `status` to 'revoked' (the row IS
--      the tombstone and survives sync/restore); a revoked pair is never
--      re-linked. The `CHECK (status IN ('linked','revoked'))` freezes the
--      value set at the DDL layer.
--
--   3. No FOREIGN keys: `decision_id` is a cross-DB soft reference (the
--      ledger lives in brain.db, not this cleo.db), and `adr_slug` is a
--      mutable doc alias (a rename must not break links — old slugs resolve
--      through `conduit_doc_slug_aliases` at read time).
--
--   4. The table starts EMPTY (AC4): the ~360 existing ledger decisions are
--      untouched — no ledger rewrite, no backfill. No DML runs here, so
--      there is nothing non-deterministic (gate 36 rule 5); the
--      `datetime('now')` occurrences below are DDL column defaults, which are
--      exempt. No trigger is created (the owned-trigger clause rule does not
--      apply), and no statement deletes from or re-keys an FK parent
--      (gate 36 rule 6).
--
--   5. The `uid` column is declared last (the row-identity heal appends a
--      missing uid column at the end; Gate B's replay compares column order)
--      and its UNIQUE index is deliberately NOT created here: the open-time
--      identity heal (store/row-identity.ts, ensureRowIdentitySchema) owns
--      `uq_<table>_uid` for every declared table at every open, so fresh and
--      existing stores alike get it (the T13354 precedent).
--
-- @task T13359
-- @epic T13340
-- @saga T13339

CREATE TABLE IF NOT EXISTS `decision_adr_links` (
	`decision_id` text NOT NULL,
	`adr_slug` text NOT NULL,
	`status` text DEFAULT 'linked' NOT NULL,
	`linked_by` text,
	`revoked_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`uid` text,
	CONSTRAINT `decision_adr_links_pk` PRIMARY KEY(`decision_id`, `adr_slug`),
	CHECK ("status" IN ('linked','revoked')),
	CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
	CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_adr_links_adr_slug` ON `decision_adr_links` (`adr_slug`);
