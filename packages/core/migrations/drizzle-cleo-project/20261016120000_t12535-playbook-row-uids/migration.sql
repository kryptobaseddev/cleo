-- T12535 (epic T12323) — row uids for the playbook tables (project store).
--
-- Adds a nullable `uid` column and a unique index on it to
-- `tasks_playbook_runs` and `tasks_playbook_approvals`. The runtime now writes
-- these prefixed twins (the bare `playbook_runs` / `playbook_approvals` are
-- frozen by the twin collapse, store/twin-collapse.ts), and without a uid
-- neither had capture triggers, so a playbook run or approval recorded on one
-- device never reached another (Stage C gate, T13549). Spec:
-- `cleo docs fetch t12341-uid-scheme`.
--
-- The columns are filled by TypeScript at open (store/row-identity.ts), and
-- rows inserted by this build get theirs from the per-connection TEMP trigger.
-- Only ADD COLUMN and CREATE INDEX: no table rebuild, no row touched.
--
-- @task T12535
-- @epic T12323

ALTER TABLE `tasks_playbook_runs` ADD COLUMN `uid` text;
--> statement-breakpoint
ALTER TABLE `tasks_playbook_approvals` ADD COLUMN `uid` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_playbook_runs_uid` ON `tasks_playbook_runs` (`uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_tasks_playbook_approvals_uid` ON `tasks_playbook_approvals` (`uid`);
