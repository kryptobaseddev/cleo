ALTER TABLE `brain_observations` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `idx_brain_observations_content_hash` ON `brain_observations` (`content_hash`);