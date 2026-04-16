-- T173: Add agent_credentials table for unified agent registry.
-- Stores agent API keys encrypted at rest (AES-256-GCM, machine-key bound).
-- Replaces loose clawmsgr-*.json config files.
-- See: docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.1
CREATE TABLE IF NOT EXISTS `agent_credentials` (
    `agent_id` text PRIMARY KEY NOT NULL,
    `display_name` text NOT NULL,
    `api_key_encrypted` text NOT NULL,
    `api_base_url` text NOT NULL DEFAULT 'https://api.signaldock.io',
    `classification` text,
    `privacy_tier` text NOT NULL DEFAULT 'public',
    `capabilities` text NOT NULL DEFAULT '[]',
    `skills` text NOT NULL DEFAULT '[]',
    `transport_config` text NOT NULL DEFAULT '{}',
    `is_active` integer NOT NULL DEFAULT 1,
    `last_used_at` integer,
    `created_at` integer NOT NULL,
    `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_credentials_active` ON `agent_credentials` (`is_active`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_credentials_last_used` ON `agent_credentials` (`last_used_at`);
