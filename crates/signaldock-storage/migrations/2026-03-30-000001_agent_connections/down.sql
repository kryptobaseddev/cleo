DROP INDEX IF EXISTS idx_agent_connections_heartbeat;
DROP INDEX IF EXISTS idx_agent_connections_transport;
DROP INDEX IF EXISTS idx_agent_connections_agent;
DROP TABLE IF EXISTS agent_connections;
DROP INDEX IF EXISTS idx_agents_transport_type;
-- SQLite does not support DROP COLUMN; transport_type remains but is unused.
