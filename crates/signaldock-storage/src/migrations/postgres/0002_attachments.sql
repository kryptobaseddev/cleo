ALTER TABLE messages ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
