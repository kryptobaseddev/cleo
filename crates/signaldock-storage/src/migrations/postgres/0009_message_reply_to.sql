-- Add reply_to column for message threading.
ALTER TABLE messages ADD COLUMN reply_to UUID REFERENCES messages(id);
CREATE INDEX idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
