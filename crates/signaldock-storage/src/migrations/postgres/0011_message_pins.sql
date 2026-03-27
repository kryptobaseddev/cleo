-- Pinned messages table for bookmarking important messages.
CREATE TABLE IF NOT EXISTS message_pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id),
    conversation_id UUID NOT NULL,
    pinned_by TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, pinned_by)
);
CREATE INDEX idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX idx_pins_agent ON message_pins(pinned_by);
