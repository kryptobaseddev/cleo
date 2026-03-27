-- Phase 5.1: Link agents to organizations for fleet management.
-- Agents can belong to one organization. Org admins manage agent API keys.

ALTER TABLE agents ADD COLUMN organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(organization_id);

-- Organization-level API key management table.
-- Org admins can create keys scoped to their org's agents.
CREATE TABLE IF NOT EXISTS org_agent_keys (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS org_agent_keys_org_idx ON org_agent_keys(organization_id);
CREATE INDEX IF NOT EXISTS org_agent_keys_agent_idx ON org_agent_keys(agent_id);
