CREATE TABLE `accounts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` text,
	`refresh_token_expires_at` text,
	`scope` text,
	`password` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `idx_accounts_provider` UNIQUE(`provider_id`,`account_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_capabilities` (
	`agent_id` text NOT NULL,
	`capability_id` text NOT NULL,
	CONSTRAINT `agent_capabilities_pk` PRIMARY KEY(`agent_id`, `capability_id`),
	CONSTRAINT `fk_agent_capabilities_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`),
	CONSTRAINT `fk_agent_capabilities_capability_id_capabilities_id_fk` FOREIGN KEY (`capability_id`) REFERENCES `capabilities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agent_connections` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`transport_type` text DEFAULT 'http' NOT NULL,
	`connection_id` text,
	`connected_at` integer NOT NULL,
	`last_heartbeat` integer NOT NULL,
	`connection_metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `agent_connections_agent_id_connection_id_unique` UNIQUE(`agent_id`,`connection_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`attached_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `agent_skills_pk` PRIMARY KEY(`agent_id`, `skill_id`),
	CONSTRAINT `fk_agent_skills_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`),
	CONSTRAINT `fk_agent_skills_skill_id_skills_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`class` text DEFAULT 'custom' NOT NULL,
	`privacy_tier` text DEFAULT 'public' NOT NULL,
	`owner_id` text,
	`endpoint` text,
	`webhook_secret` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`avatar` text,
	`messages_sent` integer DEFAULT 0 NOT NULL,
	`messages_received` integer DEFAULT 0 NOT NULL,
	`conversation_count` integer DEFAULT 0 NOT NULL,
	`friend_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_seen` integer,
	`payment_config` text,
	`api_key_hash` text,
	`organization_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`transport_type` text DEFAULT 'http' NOT NULL,
	`api_key_encrypted` text,
	`api_base_url` text DEFAULT 'https://api.signaldock.io' NOT NULL,
	`classification` text,
	`transport_config` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer,
	`requires_reauth` integer DEFAULT 0 NOT NULL,
	`tier` text DEFAULT 'global' NOT NULL,
	`can_spawn` integer DEFAULT 0 NOT NULL,
	`orch_level` integer DEFAULT 2 NOT NULL,
	`reports_to` text,
	`cant_path` text,
	`cant_sha256` text,
	`installed_from` text,
	`installed_at` text,
	CONSTRAINT `fk_agents_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_agents_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `capabilities` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claim_codes` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`code` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_claim_codes_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`),
	CONSTRAINT `fk_claim_codes_used_by_users_id_fk` FOREIGN KEY (`used_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `org_agent_keys` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_agent_keys_organization_id_organization_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_agent_keys_agent_id_agents_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text,
	`logo` text,
	`metadata` text,
	`owner_id` text,
	`created_at` integer DEFAULT (strftime('%s','now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`ip_address` text,
	`user_agent` text,
	`expires_at` text NOT NULL,
	`active_organization_id` text,
	`impersonated_by` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`password_hash` text NOT NULL,
	`name` text,
	`slug` text,
	`default_agent_id` text,
	`username` text,
	`display_username` text,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT 0 NOT NULL,
	`ban_reason` text,
	`ban_expires` text,
	`two_factor_enabled` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_accounts_user_id` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_connections_agent` ON `agent_connections` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_connections_transport` ON `agent_connections` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_agent_connections_heartbeat` ON `agent_connections` (`last_heartbeat`);--> statement-breakpoint
CREATE INDEX `idx_agent_skills_source` ON `agent_skills` (`source`);--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_id`);--> statement-breakpoint
CREATE INDEX `agents_class_idx` ON `agents` (`class`);--> statement-breakpoint
CREATE INDEX `agents_privacy_idx` ON `agents` (`privacy_tier`);--> statement-breakpoint
CREATE INDEX `agents_org_idx` ON `agents` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_agents_transport_type` ON `agents` (`transport_type`);--> statement-breakpoint
CREATE INDEX `idx_agents_is_active` ON `agents` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_agents_last_used` ON `agents` (`last_used_at`);--> statement-breakpoint
CREATE INDEX `idx_agents_tier` ON `agents` (`tier`);--> statement-breakpoint
CREATE INDEX `idx_agents_cant_path` ON `agents` (`cant_path`);--> statement-breakpoint
CREATE INDEX `claim_codes_agent_idx` ON `claim_codes` (`agent_id`);--> statement-breakpoint
CREATE INDEX `org_agent_keys_org_idx` ON `org_agent_keys` (`organization_id`);--> statement-breakpoint
CREATE INDEX `org_agent_keys_agent_idx` ON `org_agent_keys` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_organization_slug` ON `organization` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_users_slug` ON `users` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_verifications_identifier` ON `verifications` (`identifier`);