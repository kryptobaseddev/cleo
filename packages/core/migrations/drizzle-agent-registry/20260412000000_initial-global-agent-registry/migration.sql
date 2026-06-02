-- T11622 (SG-AGENT-IDENTITY E4) — COMPLETE-CUTOVER to prefixed `agent_registry_*`
-- (folds T11578 AC2).
--
-- BEFORE the cutover this migration created the 13 BARE legacy tables (`agents`,
-- `users`, `capabilities`, …) that the agent-registry runtime READ + WROTE. After
-- the cutover the runtime targets the PREFIXED consolidated `agent_registry_*`
-- tables, which are owned by the consolidated cleo-global migration
-- (20260531000001 + the 20260602000001_t11622 rename) — the single SSoT for the
-- registry table shape. This migration no longer creates them.
--
-- It now carries ONLY the two legacy per-source health-probe ledger tables, kept
-- for the backwards-compatible `checkGlobalAgentRegistryDbHealth()` consumer and as
-- the reconcile sentinel (`_agent_registry_meta`) so `reconcileJournal` Scenario 2
-- (orphan deletion) stays dormant on first open — exactly the conduit AC4 pattern.
-- `__drizzle_migrations` is the canonical journal; these are supplementary.
--
-- @task T11622
-- @saga T11586 (SG-AGENT-IDENTITY)
-- @epic T11249
CREATE TABLE IF NOT EXISTS `_agent_registry_meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `_agent_registry_migrations` (
	`name` text PRIMARY KEY,
	`applied_at` integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
