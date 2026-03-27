-- Attachments table for llmtxt compressed content blobs.
CREATE TABLE IF NOT EXISTS attachments (
    slug TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    content BLOB NOT NULL,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'text',
    title TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);
