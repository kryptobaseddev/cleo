-- T889 / T904 / W4-6: playbook_runs + playbook_approvals in tasks.db
CREATE TABLE IF NOT EXISTS `playbook_runs` (
  `run_id`           TEXT NOT NULL PRIMARY KEY,
  `playbook_name`    TEXT NOT NULL,
  `playbook_hash`    TEXT NOT NULL,
  `current_node`     TEXT,
  `bindings`         TEXT NOT NULL DEFAULT '{}',
  `error_context`    TEXT,
  `status`           TEXT NOT NULL DEFAULT 'running'
                       CHECK (`status` IN ('running','paused','completed','failed','cancelled')),
  `iteration_counts` TEXT NOT NULL DEFAULT '{}',
  `epic_id`          TEXT,
  `session_id`       TEXT,
  `started_at`       TEXT NOT NULL DEFAULT (datetime('now')),
  `completed_at`     TEXT
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `playbook_approvals` (
  `approval_id`  TEXT NOT NULL PRIMARY KEY,
  `run_id`       TEXT NOT NULL,
  `node_id`      TEXT NOT NULL,
  `token`        TEXT NOT NULL UNIQUE,
  `requested_at` TEXT NOT NULL DEFAULT (datetime('now')),
  `approved_at`  TEXT,
  `approver`     TEXT,
  `reason`       TEXT,
  `status`       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (`status` IN ('pending','approved','rejected')),
  `auto_passed`  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (`run_id`) REFERENCES `playbook_runs`(`run_id`) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_playbook_runs_status` ON `playbook_runs`(`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_playbook_approvals_run_id` ON `playbook_approvals`(`run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_playbook_approvals_status` ON `playbook_approvals`(`status`);
