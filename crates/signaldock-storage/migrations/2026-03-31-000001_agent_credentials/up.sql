-- Move agent credentials into signaldock.db agents table.
-- Previously stored in tasks.db agent_credentials (T234 clean-cut).
-- signaldock.db agents is now the SSoT for ALL agent data.

ALTER TABLE agents ADD COLUMN api_key_encrypted TEXT;
ALTER TABLE agents ADD COLUMN api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io';
ALTER TABLE agents ADD COLUMN classification TEXT;
ALTER TABLE agents ADD COLUMN transport_config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN last_used_at INTEGER;

CREATE INDEX idx_agents_is_active ON agents(is_active);
CREATE INDEX idx_agents_last_used ON agents(last_used_at);
