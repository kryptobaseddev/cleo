-- T11703 (M3 Provider SSoT · epic T11667) — the `providers` declarative-provider
-- SSoT table in the consolidated GLOBAL cleo.db (drizzle-cleo-global scope ONLY —
-- the provider definition set is a cross-project, machine-wide signal with no
-- project-tier analog, so it is NOT mirrored into drizzle-cleo-project).
--
-- One row per provider: the serializable ProviderDef (T11702) — identity, aliases,
-- auth methods, wire endpoint(s) (tagged-union JSON discriminated on `transport`),
-- models.dev catalog key, default headers, optional OAuth flow, declarative request
-- quirks. This table is the provider SSoT — seeded from the builtin ProviderDef set
-- derived from the in-process ProviderProfile builtins (T11703), and read by the
-- resolver / CLI / alias resolver (T11704). The non-serializable runtime hooks stay
-- on ProviderProfile; a row carries only DATA.
--
-- This carries NO secrets and NO encryption — it is declarative config DATA, distinct
-- from the `accounts` LLM-credential pool (T11709), the `service_*` vault (T11937),
-- and the `models_catalog` catalog (T11733). The OAuth `client_id` it stores is the
-- provider's PUBLIC first-party id; client SECRETS live in the service vault.
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-global) and many subsequent migrations, so `providers` is NEVER the first
-- CREATE on a fresh DB — rootpage 2 is already owned by `__drizzle_migrations` /
-- the baseline tables. No journal pre-create is required.
--
-- `IF NOT EXISTS` so a re-open over an already-migrated DB is a no-op (idempotent).
-- Each statement is separated by a drizzle breakpoint marker line so node:sqlite
-- prepare() does not silently truncate the multi-statement file to statement one
-- (the marker token is intentionally not spelled out in this comment — drizzle's
-- readMigrationFiles splits the file on that literal substring).
--
-- @task T11703
-- @epic T11667

CREATE TABLE IF NOT EXISTS `providers` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `aliases` text NOT NULL DEFAULT '[]',
  `auth_methods` text NOT NULL DEFAULT '[]',
  `endpoint` text NOT NULL,
  `alt_endpoints` text NOT NULL DEFAULT '[]',
  `models_dev_id` text NOT NULL,
  `default_headers` text NOT NULL DEFAULT '{}',
  `env_vars` text NOT NULL DEFAULT '[]',
  `oauth` text,
  `request_quirks` text NOT NULL DEFAULT '[]',
  `source` text NOT NULL DEFAULT 'seed',
  `seeded_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("seeded_at" IS NULL OR "seeded_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_providers_models_dev` ON `providers` (`models_dev_id`);
