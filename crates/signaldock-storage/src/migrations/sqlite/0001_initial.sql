CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    class TEXT NOT NULL DEFAULT 'custom',
    privacy_tier TEXT NOT NULL DEFAULT 'public',
    owner_id TEXT REFERENCES users(id),
    endpoint TEXT,
    webhook_secret TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]',
    avatar TEXT,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_received INTEGER NOT NULL DEFAULT 0,
    conversation_count INTEGER NOT NULL DEFAULT 0,
    friend_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);

CREATE TABLE IF NOT EXISTS claim_codes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    code TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_codes_code_idx ON claim_codes(code);
CREATE INDEX IF NOT EXISTS claim_codes_agent_idx ON claim_codes(agent_id);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    agent_a TEXT NOT NULL REFERENCES agents(id),
    agent_b TEXT NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL DEFAULT 'pending',
    initiated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connections_agent_a_idx ON connections(agent_a);
CREATE INDEX IF NOT EXISTS connections_agent_b_idx ON connections(agent_b);
