ALTER TABLE `audit_log` ADD `project_hash` text;--> statement-breakpoint
CREATE INDEX `idx_audit_log_project_hash` ON `audit_log` (`project_hash`);