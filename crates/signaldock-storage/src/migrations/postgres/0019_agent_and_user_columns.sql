-- Add columns needed by the API server that were previously only
-- applied via SQLite startup compat migrations.

-- Agent transport and lifecycle columns
ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS transport_type TEXT NOT NULL DEFAULT 'http';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS classification TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS transport_config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- User auth and admin columns (better-auth-rs)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_agent_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS slug TEXT;

-- Agent connection tracking
CREATE TABLE IF NOT EXISTS agent_connections (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    connection_id TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    connection_metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    UNIQUE(agent_id, connection_id)
);

-- Capability and skill registries
CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Junction tables for agent capabilities/skills
CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, capability_id)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, skill_id)
);

-- Delivery job queue
CREATE TABLE IF NOT EXISTS delivery_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status
    ON delivery_jobs(status, next_attempt_at);

-- Dead letter queue for permanently failed deliveries
CREATE TABLE IF NOT EXISTS dead_letters (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
