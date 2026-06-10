-- T11937 (EP-UNIVERSAL-SERVICE-VAULT · epic T11765 · saga SG-VAULT-CORE T10409 ·
-- M2 W1a) — the universal SERVICE-credential vault in the consolidated GLOBAL
-- cleo.db (drizzle-cleo-global scope ONLY — machine-wide service credentials with
-- no project-tier analog, exactly like the `accounts` LLM-credential pool T11709,
-- so NOT mirrored into drizzle-cleo-project).
--
-- Three tables, cannibalized from onecli `app_connections` / `app_configs` /
-- `agent_app_connections` with EVERY org/project/billing column dropped:
--
--   service_connections   — one connected credential per (provider, label);
--                           credentials_enc = encryptGlobal({access,refresh}) blob.
--   service_configs        — per-provider BYOC OAuth app (enabled + client_secret_enc).
--   agent_service_grants   — per-agent access + session_policy (the trust gate
--                            evaluates this BEFORE any decrypt).
--
-- `credentials_enc` / `client_secret_enc` are encryptGlobal() ciphertext (T11710),
-- NEVER plaintext. These are DISTINCT from the LLM `accounts` table (model-API
-- credentials) — different physical names, different consumers, shared crypto.
--
-- ## Page-2 invariant
--
-- This migration runs AFTER the consolidation baseline (…_t11363-consolidation-
-- cleo-global) which already creates dozens of tables, so none of these tables is
-- the first CREATE on a fresh DB — rootpage 2 is already owned by
-- `__drizzle_migrations` / the baseline tables. No journal pre-create is required.
--
-- ## Idempotency + breakpoints
--
-- `IF NOT EXISTS` on every statement so a re-open over an already-migrated DB is a
-- no-op. Each statement is separated by a drizzle breakpoint marker line so
-- node:sqlite prepare() does not silently truncate the multi-statement file to
-- statement one (the marker token is the literal drizzle readMigrationFiles split
-- substring — additive/forward-only).
--
-- ## CHECK constraints (schema-parity SSoT — T11364)
--
-- The consolidated schema-parity gate re-derives the CHECK set from the drizzle
-- schema metadata (boolean → IN (0,1); enum → IN (...); `_at` TEXT → ISO-8601
-- GLOB). The CHECKs below MUST match that derivation byte-for-byte.
--
-- @task T11937
-- @epic T11765
-- @saga T10409

CREATE TABLE IF NOT EXISTS `service_connections` (
  `id` integer PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `label` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `credentials_enc` text,
  `scopes` text NOT NULL DEFAULT '[]',
  `expires_at` text,
  `metadata` text NOT NULL DEFAULT '{}',
  `connected_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("status" IN ('active', 'expired', 'revoked')),
  CHECK ("expires_at" IS NULL OR "expires_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("connected_at" IS NULL OR "connected_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_service_connections_provider_label` ON `service_connections` (`provider`, `label`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_service_connections_provider_status` ON `service_connections` (`provider`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `service_configs` (
  `id` integer PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 0,
  `client_secret_enc` text,
  `settings` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  CHECK ("enabled" IN (0, 1)),
  CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ux_service_configs_provider` ON `service_configs` (`provider`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_service_grants` (
  `agent_id` text NOT NULL,
  `service_connection_id` integer NOT NULL,
  `session_policy` text NOT NULL DEFAULT '{"mode":"allow"}',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (`agent_id`, `service_connection_id`),
  FOREIGN KEY (`service_connection_id`) REFERENCES `service_connections`(`id`),
  CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  CHECK ("updated_at" IS NULL OR "updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_service_grants_agent` ON `agent_service_grants` (`agent_id`);