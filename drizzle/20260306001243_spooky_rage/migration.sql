PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_warp_chain_instances` (
	`id` text PRIMARY KEY,
	`chain_id` text NOT NULL,
	`epic_id` text NOT NULL,
	`variables` text,
	`stage_to_task` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text,
	`gate_results` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	CONSTRAINT `fk_warp_chain_instances_chain_id_warp_chains_id_fk` FOREIGN KEY (`chain_id`) REFERENCES `warp_chains`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_warp_chain_instances`(`id`, `chain_id`, `epic_id`, `variables`, `stage_to_task`, `status`, `current_stage`, `gate_results`, `created_at`, `updated_at`)
SELECT i.`id`, i.`chain_id`, i.`epic_id`, i.`variables`, i.`stage_to_task`, i.`status`, i.`current_stage`, i.`gate_results`, i.`created_at`, i.`updated_at`
FROM `warp_chain_instances` i
INNER JOIN `warp_chains` c ON c.`id` = i.`chain_id`;--> statement-breakpoint
DROP TABLE `warp_chain_instances`;--> statement-breakpoint
ALTER TABLE `__new_warp_chain_instances` RENAME TO `warp_chain_instances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_warp_instances_chain` ON `warp_chain_instances` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_epic` ON `warp_chain_instances` (`epic_id`);--> statement-breakpoint
CREATE INDEX `idx_warp_instances_status` ON `warp_chain_instances` (`status`);
