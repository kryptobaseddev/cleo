-- Reverse the initial consolidated migration.
-- Drop tables in reverse dependency order to avoid FK violations.

-- Attachment collaboration tables (depend on attachments)
DROP TABLE IF EXISTS attachment_contributors;
DROP TABLE IF EXISTS attachment_approvals;
DROP TABLE IF EXISTS attachment_versions;

-- Organization agent keys (depends on organization + agents)
DROP TABLE IF EXISTS org_agent_keys;

-- Better-auth tables (depend on users)
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;

-- Junction tables (depend on agents + capabilities/skills)
DROP TABLE IF EXISTS agent_skills;
DROP TABLE IF EXISTS agent_capabilities;

-- Registry tables
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS capabilities;

-- Attachments (standalone with conversation FK)
DROP TABLE IF EXISTS attachments;

-- Message pins
DROP TABLE IF EXISTS message_pins;

-- FTS triggers and virtual table (depend on messages)
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_ai;
DROP TABLE IF EXISTS messages_fts;

-- Delivery pipeline
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS delivery_jobs;

-- Connections (depend on agents)
DROP TABLE IF EXISTS connections;

-- Claim codes (depend on agents + users)
DROP TABLE IF EXISTS claim_codes;

-- Messages (depend on conversations)
DROP TABLE IF EXISTS messages;

-- Conversations
DROP TABLE IF EXISTS conversations;

-- Agents (depend on users + organization)
DROP TABLE IF EXISTS agents;

-- Organization
DROP TABLE IF EXISTS organization;

-- Users (root table)
DROP TABLE IF EXISTS users;
