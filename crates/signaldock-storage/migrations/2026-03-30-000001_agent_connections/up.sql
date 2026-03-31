-- Add transport_type to agents table for connection mode classification.
ALTER TABLE agents ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'http';
CREATE INDEX idx_agents_transport_type ON agents(transport_type);

-- Agent connections: tracks active SSE/WebSocket connections for heartbeat
-- and stale connection detection. HTTP agents don't create rows here.
CREATE TABLE agent_connections (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    connection_id TEXT,
    connected_at BIGINT NOT NULL,
    last_heartbeat BIGINT NOT NULL,
    connection_metadata TEXT,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    UNIQUE(agent_id, connection_id)
);

CREATE INDEX idx_agent_connections_agent ON agent_connections(agent_id);
CREATE INDEX idx_agent_connections_transport ON agent_connections(transport_type);
CREATE INDEX idx_agent_connections_heartbeat ON agent_connections(last_heartbeat);
