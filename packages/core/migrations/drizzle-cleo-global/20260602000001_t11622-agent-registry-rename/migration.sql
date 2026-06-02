-- T11622 (SG-AGENT-IDENTITY E4): Signaldock → Agent Registry physical rename.
--
-- The frozen consolidation migration (20260531000001_t11363-consolidation-cleo-global)
-- has SHIPPED and hard-codes the `signaldock_*` table + index names; it MUST NOT be
-- regenerated. This forward migration renames those 13 tables (+ their 21 standalone
-- indexes) to the `agent_registry_*` prefix that the renamed schema module
-- (`schema/cleo-global/agent-registry.ts`) now declares.
--
-- O(1) metadata-only rename in SQLite (zero row copy). Runs exactly once, in lexical
-- order AFTER the consolidation migration created `signaldock_*` — so on BOTH a fresh
-- install (consolidation just created `signaldock_*`) and an existing dev/test
-- `cleo.db` already holding `signaldock_*`, the source tables are present when this
-- runs. The journal then prevents re-runs.
--
-- Indexes do not auto-rename on ALTER TABLE … RENAME, so each standalone index is
-- dropped and recreated under the `idx_agent_registry_*` name on the renamed table.
-- UNIQUE/PK/FK constraints are carried by the table rename automatically.
--
-- The legacy per-source ledgers `_signaldock_meta` / `_signaldock_migrations` are NOT
-- touched here — they belong to the legacy bare-shape store path and are matched by
-- the exodus INTERNAL_LEDGER_PATTERN regex regardless of prefix.
--
-- @task T11622
-- @saga T11586 (SG-AGENT-IDENTITY)
-- @epic T11245 (SG-DB-SUBSTRATE-V2 consolidated global schema)
ALTER TABLE `signaldock_users` RENAME TO `agent_registry_users`;--> statement-breakpoint
ALTER TABLE `signaldock_organization` RENAME TO `agent_registry_organization`;--> statement-breakpoint
ALTER TABLE `signaldock_agents` RENAME TO `agent_registry_agents`;--> statement-breakpoint
ALTER TABLE `signaldock_claim_codes` RENAME TO `agent_registry_claim_codes`;--> statement-breakpoint
ALTER TABLE `signaldock_capabilities` RENAME TO `agent_registry_capabilities`;--> statement-breakpoint
ALTER TABLE `signaldock_skills` RENAME TO `agent_registry_skills`;--> statement-breakpoint
ALTER TABLE `signaldock_agent_capabilities` RENAME TO `agent_registry_agent_capabilities`;--> statement-breakpoint
ALTER TABLE `signaldock_agent_skills` RENAME TO `agent_registry_agent_skills`;--> statement-breakpoint
ALTER TABLE `signaldock_agent_connections` RENAME TO `agent_registry_agent_connections`;--> statement-breakpoint
ALTER TABLE `signaldock_accounts` RENAME TO `agent_registry_accounts`;--> statement-breakpoint
ALTER TABLE `signaldock_sessions` RENAME TO `agent_registry_sessions`;--> statement-breakpoint
ALTER TABLE `signaldock_verifications` RENAME TO `agent_registry_verifications`;--> statement-breakpoint
ALTER TABLE `signaldock_org_agent_keys` RENAME TO `agent_registry_org_agent_keys`;--> statement-breakpoint
DROP INDEX `idx_signaldock_accounts_user_id`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agent_connections_agent`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agent_connections_transport`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agent_connections_heartbeat`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agent_skills_source`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_owner`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_class`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_privacy`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_org`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_transport_type`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_is_active`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_last_used`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_tier`;--> statement-breakpoint
DROP INDEX `idx_signaldock_agents_cant_path`;--> statement-breakpoint
DROP INDEX `idx_signaldock_claim_codes_agent`;--> statement-breakpoint
DROP INDEX `idx_signaldock_org_agent_keys_org`;--> statement-breakpoint
DROP INDEX `idx_signaldock_org_agent_keys_agent`;--> statement-breakpoint
DROP INDEX `idx_signaldock_organization_slug`;--> statement-breakpoint
DROP INDEX `idx_signaldock_sessions_user_id`;--> statement-breakpoint
DROP INDEX `idx_signaldock_users_slug`;--> statement-breakpoint
DROP INDEX `idx_signaldock_verifications_identifier`;--> statement-breakpoint
CREATE INDEX `idx_agent_registry_accounts_user_id` ON `agent_registry_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agent_connections_agent` ON `agent_registry_agent_connections` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agent_connections_transport` ON `agent_registry_agent_connections` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agent_connections_heartbeat` ON `agent_registry_agent_connections` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agent_skills_source` ON `agent_registry_agent_skills` (`source`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_owner` ON `agent_registry_agents` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_class` ON `agent_registry_agents` (`class`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_privacy` ON `agent_registry_agents` (`privacy_tier`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_org` ON `agent_registry_agents` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_transport_type` ON `agent_registry_agents` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_is_active` ON `agent_registry_agents` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_last_used` ON `agent_registry_agents` (`last_used_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_tier` ON `agent_registry_agents` (`tier`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_agents_cant_path` ON `agent_registry_agents` (`cant_path`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_claim_codes_agent` ON `agent_registry_claim_codes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_org_agent_keys_org` ON `agent_registry_org_agent_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_org_agent_keys_agent` ON `agent_registry_org_agent_keys` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_organization_slug` ON `agent_registry_organization` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_sessions_user_id` ON `agent_registry_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_users_slug` ON `agent_registry_users` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_agent_registry_verifications_identifier` ON `agent_registry_verifications` (`identifier`);
