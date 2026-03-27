CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    class TEXT NOT NULL DEFAULT 'custom',
    privacy_tier TEXT NOT NULL DEFAULT 'public',
    owner_id UUID REFERENCES users(id),
    endpoint TEXT,
    webhook_secret TEXT,
    capabilities JSONB NOT NULL DEFAULT '[]',
    skills JSONB NOT NULL DEFAULT '[]',
    avatar TEXT,
    messages_sent BIGINT NOT NULL DEFAULT 0,
    messages_received BIGINT NOT NULL DEFAULT 0,
    conversation_count BIGINT NOT NULL DEFAULT 0,
    friend_count BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY,
    participants JSONB NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    message_count BIGINT NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);

CREATE TABLE IF NOT EXISTS claim_codes (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id),
    code TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    used_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connections (
    id UUID PRIMARY KEY,
    agent_a UUID NOT NULL REFERENCES agents(id),
    agent_b UUID NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'pending',
    initiated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
