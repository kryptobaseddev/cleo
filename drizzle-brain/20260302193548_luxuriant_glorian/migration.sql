CREATE TABLE `brain_page_edges` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`weight` real DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `brain_page_edges_pk` PRIMARY KEY(`from_id`, `to_id`, `edge_type`)
);
--> statement-breakpoint
CREATE TABLE `brain_page_nodes` (
	`id` text PRIMARY KEY,
	`node_type` text NOT NULL,
	`label` text NOT NULL,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_brain_edges_from` ON `brain_page_edges` (`from_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_edges_to` ON `brain_page_edges` (`to_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_nodes_type` ON `brain_page_nodes` (`node_type`);