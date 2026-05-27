-- T10570 revert — remove acceptance projection freshness state and dirty queue.

DROP TABLE IF EXISTS `acceptance_projection_dirty`;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_acceptance_projection_state_status_freshness`;
--> statement-breakpoint

DROP TABLE IF EXISTS `acceptance_projection_state`;
