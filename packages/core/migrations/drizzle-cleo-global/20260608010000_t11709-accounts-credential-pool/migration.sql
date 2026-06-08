-- T11709 (EP-PROVIDER-VAULT · epic T10410 · saga SG-VAULT-CORE T10409) — the
-- pooled-LLM-credential `accounts` table in the consolidated GLOBAL cleo.db
-- (drizzle-cleo-global scope ONLY — this is a cross-project, machine-wide
-- credential pool with no project-tier analog, so it is NOT mirrored into
-- drizzle-cleo-project).
--
-- One row per LLM credential ("account") for one provider: the encrypted
-- secret/refresh material plus rotation / cooldown / health metadata the pool
-- runner consults to select the next live account and retire dead ones. Replaces
-- the legacy plaintext JSON blob with a queryable, `cleo health`-visible table.
--
-- `secret_enc` / `refresh_enc` are encryptGlobal() ciphertext (T11710), NEVER
-- plaintext. This is DISTINCT from `agent_registry_accounts` (the better-auth
-- OAuth-account table) — different physical name, different purpose.
--
-- ## Active-account pointer (raw partial unique index)
--
-- `is_active` is the per-provider "currently-selected" pointer: AT MOST ONE row
-- per `provider` may carry `is_active = 1`. drizzle-orm cannot model a partial
-- `WHERE` unique index, so it is emitted here as raw SQL (the established repo
-- pattern — cf. `_writer_leases.active`, T11627 · `project_agent_refs.enabled`).
-- The drizzle schema (accounts.ts) declares only the full-column table plus the
-- non-partial `(provider, label)` unique index that drizzle CAN emit.
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-global) which already creates dozens of tables, so `accounts` is NEVER the
-- first CREATE on a fresh DB — rootpage 2 is already owned by
-- `__drizzle_migrations` / the baseline tables. No journal pre-create is required.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op. Each
-- statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11709
-- @epic T10410
-- @saga T10409

CREATE TABLE IF NOT EXISTS `accounts` (
  `id` integer PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `label` text NOT NULL,
  `auth_type` text NOT NULL,
  `secret_enc` text,
  `refresh_enc` text,
  `expires_at` text,
  `priority` integer NOT NULL DEFAULT 0,
  `source` text,
  `status` text NOT NULL DEFAULT 'ok',
  `last_error_code` text,
  `cooldown_reset_at` text,
  `request_count` integer NOT NULL DEFAULT 0,
  `metadata` text NOT NULL DEFAULT '{}',
  `is_active` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("status" IN ('ok', 'exhausted', 'dead')),
  CHECK ("is_active" IN (0, 1)),
  CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("cooldown_reset_at" IS NULL OR "cooldown_reset_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_accounts_provider_label` ON `accounts` (`provider`, `label`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_accounts_active_provider` ON `accounts` (`provider`) WHERE `is_active` = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_accounts_provider_status_priority` ON `accounts` (`provider`, `status`, `priority`);
