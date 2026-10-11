-- T12915 (epic T12323) — row uid for the global agent registry.
--
-- Adds a nullable `uid` column and a unique index on it to
-- `agent_registry_agents`, declared natural on its slug (`agent_id`): every
-- device derives the same uid for the same agent. The random text `id` stays a
-- LOCAL key that never travels. Spec: `cleo docs fetch t12341-uid-scheme`;
-- owner decision: `cleo docs fetch t13467-global-secrets-sync-design`.
--
-- The column is filled by TypeScript at open (store/row-identity.ts) and by the
-- per-connection TEMP trigger. Only ADD COLUMN and CREATE INDEX: no row is
-- rebuilt or touched, so the gate 36 DML rules do not apply.
--
-- @task T12915
-- @epic T12323

ALTER TABLE `agent_registry_agents` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_agent_registry_agents_uid` ON `agent_registry_agents` (`uid`);
