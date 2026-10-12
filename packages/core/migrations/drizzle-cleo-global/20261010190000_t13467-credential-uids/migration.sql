-- T13467 (epic T12323) — row uid for the global credential tables.
--
-- Adds a nullable `uid` column and a unique index on it to `accounts`,
-- `service_connections`, `service_configs` and `agent_service_grants`, declared
-- natural on their non-secret identifiers (uid spec D4 as amended 2026-10-11:
-- `cleo docs fetch t12341-uid-scheme`; design: `cleo docs fetch
-- t13467-global-secrets-sync-design`). The INTEGER `id` stays a LOCAL key; the
-- secret columns travel sealed, never in the clear.
--
-- The column is filled by TypeScript at open (store/row-identity.ts) and by the
-- per-connection TEMP trigger. Only ADD COLUMN and CREATE INDEX: no row is
-- rebuilt or touched, so the gate 36 DML rules do not apply.
--
-- @task T13467
-- @epic T12323

ALTER TABLE `accounts` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_accounts_uid` ON `accounts` (`uid`);
--> statement-breakpoint
ALTER TABLE `service_connections` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_service_connections_uid` ON `service_connections` (`uid`);
--> statement-breakpoint
ALTER TABLE `service_configs` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_service_configs_uid` ON `service_configs` (`uid`);
--> statement-breakpoint
ALTER TABLE `agent_service_grants` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_agent_service_grants_uid` ON `agent_service_grants` (`uid`);
