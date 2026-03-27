-- Add default_agent_id to users so they can set a preferred sending identity.
-- NULL means auto-select first owned agent.
ALTER TABLE users ADD COLUMN default_agent_id TEXT REFERENCES agents(agent_id) ON DELETE SET NULL;
