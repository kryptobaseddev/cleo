-- Add group_id to messages for deduplicating fan-out copies in group conversations.
-- All copies of a fan-out message share the same group_id; NULL for 1-on-1 messages.
ALTER TABLE messages ADD COLUMN group_id TEXT;
CREATE INDEX idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
