-- Add api_key_hash column for agent API key authentication.
-- Stores SHA-256 hash of the agent's sk_live_ API key.
ALTER TABLE agents ADD COLUMN api_key_hash TEXT;
