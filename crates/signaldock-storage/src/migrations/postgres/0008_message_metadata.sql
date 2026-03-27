-- Add metadata column for @mentions, /directives, #tags extracted from content.
ALTER TABLE messages ADD COLUMN metadata JSONB DEFAULT '{}';
