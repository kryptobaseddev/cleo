-- Create FTS5 virtual table for full-text search on messages.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    from_agent_id,
    content='messages',
    content_rowid='rowid'
);

-- Populate FTS index from existing messages.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');

-- Triggers to keep FTS in sync with messages table.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, from_agent_id)
    VALUES (new.rowid, new.content, new.from_agent_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
    VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
    VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO messages_fts(rowid, content, from_agent_id)
    VALUES (new.rowid, new.content, new.from_agent_id);
END;
