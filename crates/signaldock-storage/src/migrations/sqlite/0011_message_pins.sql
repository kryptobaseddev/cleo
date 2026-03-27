-- Pinned messages table for bookmarking important messages.
CREATE TABLE IF NOT EXISTS message_pins (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, pinned_by)
);
CREATE INDEX idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX idx_pins_agent ON message_pins(pinned_by);
