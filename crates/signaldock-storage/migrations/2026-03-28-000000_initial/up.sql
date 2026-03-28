-- Consolidated initial migration for SignalDock storage.
-- Merges all 19 sqlx migrations (0001–0019) into a single Diesel migration
-- that produces the full schema in one shot.
--
-- Source migrations:
--   0001_initial.sql           — users, agents, conversations, messages, claim_codes, connections
--   0002_attachments.sql       — messages.attachments column
--   0003_payment_config.sql    — agents.payment_config column
--   0004_delivery_jobs.sql     — delivery_jobs, dead_letters
--   0005_user_default_agent.sql — users.default_agent_id
--   0006_message_group_id.sql  — messages.group_id
--   0007_agent_api_key_hash.sql — agents.api_key_hash
--   0008_message_metadata.sql  — messages.metadata
--   0009_message_reply_to.sql  — messages.reply_to
--   0010_fts5_messages.sql     — FTS5 virtual table + triggers
--   0011_message_pins.sql      — message_pins
--   0012_attachments.sql       — attachments table
--   0013_capability_skill_registry.sql — capabilities, skills, junction tables + seeds
--   0014_migrate_freetext_to_junction.sql — data migration (freetext -> junction)
--   0015_users_better_auth_compat.sql — better-auth columns + accounts, sessions, verifications
--   0016_agent_organizations.sql — agents.organization_id + org_agent_keys
--   0017_create_organization_table.sql — organization table
--   0018_attachment_versioning.sql — attachment_versions, attachment_approvals, attachment_contributors
--   0019_better_auth_slug_columns.sql — slug columns on users + organization

-- ============================================================================
-- 1. Core domain tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    name                TEXT,
    slug                TEXT,
    default_agent_id    TEXT,
    -- better-auth compat columns (from 0015, 0019)
    username            TEXT,
    display_username    TEXT,
    email_verified      INTEGER NOT NULL DEFAULT 0,
    image               TEXT,
    role                TEXT NOT NULL DEFAULT 'user',
    banned              INTEGER NOT NULL DEFAULT 0,
    ban_reason          TEXT,
    ban_expires         TEXT,
    two_factor_enabled  INTEGER NOT NULL DEFAULT 0,
    metadata            TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);

-- ============================================================================
-- 2. Organization (must exist before agents FK)
-- ============================================================================

CREATE TABLE IF NOT EXISTS organization (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    slug        TEXT,
    logo        TEXT,
    metadata    TEXT,
    owner_id    TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_slug ON organization(slug);

-- ============================================================================
-- 3. Agents
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    description         TEXT,
    class               TEXT NOT NULL DEFAULT 'custom',
    privacy_tier        TEXT NOT NULL DEFAULT 'public',
    owner_id            TEXT REFERENCES users(id),
    endpoint            TEXT,
    webhook_secret      TEXT,
    capabilities        TEXT NOT NULL DEFAULT '[]',
    skills              TEXT NOT NULL DEFAULT '[]',
    avatar              TEXT,
    messages_sent       INTEGER NOT NULL DEFAULT 0,
    messages_received   INTEGER NOT NULL DEFAULT 0,
    conversation_count  INTEGER NOT NULL DEFAULT 0,
    friend_count        INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'online',
    last_seen           INTEGER,
    -- from 0003
    payment_config      TEXT,
    -- from 0007
    api_key_hash        TEXT,
    -- from 0016
    organization_id     TEXT REFERENCES organization(id) ON DELETE SET NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(organization_id);

-- Wire up users.default_agent_id FK now that agents table exists
-- (SQLite does not enforce ALTER TABLE ADD CONSTRAINT, so this is documentation)

-- ============================================================================
-- 4. Conversations
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    participants    TEXT NOT NULL,
    visibility      TEXT NOT NULL DEFAULT 'private',
    message_count   INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

-- ============================================================================
-- 5. Messages (all columns from 0001 + 0002 + 0006 + 0008 + 0009)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    from_agent_id   TEXT NOT NULL,
    to_agent_id     TEXT NOT NULL,
    content         TEXT NOT NULL,
    content_type    TEXT NOT NULL DEFAULT 'text',
    status          TEXT NOT NULL DEFAULT 'pending',
    -- from 0002
    attachments     TEXT NOT NULL DEFAULT '[]',
    -- from 0006
    group_id        TEXT,
    -- from 0008
    metadata        TEXT DEFAULT '{}',
    -- from 0009
    reply_to        TEXT,
    created_at      INTEGER NOT NULL,
    delivered_at    INTEGER,
    read_at         INTEGER
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;

-- ============================================================================
-- 6. Claim codes
-- ============================================================================

CREATE TABLE IF NOT EXISTS claim_codes (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    code        TEXT NOT NULL UNIQUE,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    used_by     TEXT REFERENCES users(id),
    created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_codes_code_idx ON claim_codes(code);
CREATE INDEX IF NOT EXISTS claim_codes_agent_idx ON claim_codes(agent_id);

-- ============================================================================
-- 7. Connections
-- ============================================================================

CREATE TABLE IF NOT EXISTS connections (
    id              TEXT PRIMARY KEY,
    agent_a         TEXT NOT NULL REFERENCES agents(id),
    agent_b         TEXT NOT NULL REFERENCES agents(id),
    status          TEXT NOT NULL DEFAULT 'pending',
    initiated_by    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connections_agent_a_idx ON connections(agent_a);
CREATE INDEX IF NOT EXISTS connections_agent_b_idx ON connections(agent_b);

-- ============================================================================
-- 8. Delivery jobs (from 0004)
-- ============================================================================

CREATE TABLE IF NOT EXISTS delivery_jobs (
    id              TEXT PRIMARY KEY,
    message_id      TEXT NOT NULL,
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 6,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status, next_attempt_at);

-- ============================================================================
-- 9. Dead letters (from 0004)
-- ============================================================================

CREATE TABLE IF NOT EXISTS dead_letters (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    reason      TEXT NOT NULL,
    attempts    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_message ON dead_letters(message_id);

-- ============================================================================
-- 10. FTS5 full-text search (from 0010)
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    from_agent_id,
    content='messages',
    content_rowid='rowid'
);

-- Populate FTS index from existing messages.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');

-- Triggers to keep FTS in sync with messages table.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, from_agent_id)
    VALUES (new.rowid, new.content, new.from_agent_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
    VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
    VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO messages_fts(rowid, content, from_agent_id)
    VALUES (new.rowid, new.content, new.from_agent_id);
END;

-- ============================================================================
-- 11. Message pins (from 0011)
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_pins (
    id              TEXT PRIMARY KEY,
    message_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_by       TEXT NOT NULL,
    note            TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE(message_id, pinned_by)
);

CREATE INDEX IF NOT EXISTS idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pins_agent ON message_pins(pinned_by);

-- ============================================================================
-- 12. Attachments (from 0012 + 0018 versioning columns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachments (
    slug            TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent_id   TEXT NOT NULL,
    content         BLOB NOT NULL,
    original_size   INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    format          TEXT NOT NULL DEFAULT 'text',
    title           TEXT,
    tokens          INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL DEFAULT 0,
    -- from 0018 versioning
    storage_key     TEXT,
    mode            TEXT NOT NULL DEFAULT 'draft',
    version_count   INTEGER NOT NULL DEFAULT 1,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);

-- ============================================================================
-- 13. Capability and skill registries (from 0013)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capabilities (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    capability_id   TEXT NOT NULL REFERENCES capabilities(id),
    PRIMARY KEY (agent_id, capability_id)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    skill_id    TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

-- Seed: 19 capabilities
INSERT OR IGNORE INTO capabilities (id, slug, name, description, category, created_at) VALUES
('cap_chat', 'chat', 'Chat', 'Conversational message exchange', 'communication', strftime('%s','now')),
('cap_tools', 'tools', 'Tool Use', 'Can invoke external tools and APIs', 'execution', strftime('%s','now')),
('cap_code_gen', 'code_generation', 'Code Generation', 'Can write and generate source code', 'development', strftime('%s','now')),
('cap_code_review', 'code_review', 'Code Review', 'Can review and critique code', 'development', strftime('%s','now')),
('cap_search', 'search', 'Search', 'Can search and discover information', 'analysis', strftime('%s','now')),
('cap_orchestration', 'orchestration', 'Orchestration', 'Can coordinate and delegate to other agents', 'coordination', strftime('%s','now')),
('cap_messaging', 'messaging', 'Messaging', 'Can send/receive structured messages', 'communication', strftime('%s','now')),
('cap_streaming', 'streaming', 'Streaming', 'Supports SSE/streaming connections', 'communication', strftime('%s','now')),
('cap_webhooks', 'webhooks', 'Webhooks', 'Can receive webhook deliveries', 'communication', strftime('%s','now')),
('cap_file_ops', 'file_operations', 'File Operations', 'Can read/write files on the filesystem', 'execution', strftime('%s','now')),
('cap_web_browse', 'web_browsing', 'Web Browsing', 'Can browse and extract web content', 'analysis', strftime('%s','now')),
('cap_reasoning', 'reasoning', 'Reasoning', 'Multi-step logical reasoning', 'analysis', strftime('%s','now')),
('cap_automation', 'automation', 'Automation', 'Can automate repetitive tasks', 'execution', strftime('%s','now')),
('cap_testing', 'testing', 'Testing', 'Can write and execute tests', 'development', strftime('%s','now')),
('cap_git', 'git', 'Git Operations', 'Can perform git operations', 'development', strftime('%s','now')),
('cap_deploy', 'deployment', 'Deployment', 'Can deploy services and infrastructure', 'devops', strftime('%s','now')),
('cap_monitoring', 'monitoring', 'Monitoring', 'Can monitor systems and services', 'devops', strftime('%s','now')),
('cap_file_upload', 'file_upload', 'File Upload', 'Can upload and attach files', 'execution', strftime('%s','now')),
('cap_autonomous', 'autonomous', 'Autonomous', 'Can run autonomously with polling', 'execution', strftime('%s','now'));

-- Seed: 35 skills
INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at) VALUES
-- Languages
('skl_typescript', 'typescript', 'TypeScript', 'TypeScript language proficiency', 'language', strftime('%s','now')),
('skl_javascript', 'javascript', 'JavaScript', 'JavaScript language proficiency', 'language', strftime('%s','now')),
('skl_python', 'python', 'Python', 'Python language proficiency', 'language', strftime('%s','now')),
('skl_rust', 'rust', 'Rust', 'Rust language proficiency', 'language', strftime('%s','now')),
('skl_go', 'go', 'Go', 'Go language proficiency', 'language', strftime('%s','now')),
('skl_java', 'java', 'Java', 'Java language proficiency', 'language', strftime('%s','now')),
('skl_csharp', 'csharp', 'C#', 'C# language proficiency', 'language', strftime('%s','now')),
('skl_sql', 'sql', 'SQL', 'SQL query proficiency', 'language', strftime('%s','now')),
('skl_bash', 'bash', 'Bash', 'Shell scripting proficiency', 'language', strftime('%s','now')),
-- Frameworks
('skl_react', 'react', 'React', 'React framework proficiency', 'framework', strftime('%s','now')),
('skl_nextjs', 'nextjs', 'Next.js', 'Next.js framework proficiency', 'framework', strftime('%s','now')),
('skl_svelte', 'svelte', 'Svelte', 'Svelte framework proficiency', 'framework', strftime('%s','now')),
('skl_express', 'express', 'Express', 'Express.js framework proficiency', 'framework', strftime('%s','now')),
('skl_axum', 'axum', 'Axum', 'Axum web framework proficiency', 'framework', strftime('%s','now')),
('skl_django', 'django', 'Django', 'Django framework proficiency', 'framework', strftime('%s','now')),
('skl_electron', 'electron', 'Electron', 'Electron framework proficiency', 'framework', strftime('%s','now')),
-- Databases
('skl_sqlite', 'sqlite', 'SQLite', 'SQLite database proficiency', 'database', strftime('%s','now')),
('skl_postgres', 'postgres', 'PostgreSQL', 'PostgreSQL database proficiency', 'database', strftime('%s','now')),
('skl_redis', 'redis', 'Redis', 'Redis proficiency', 'database', strftime('%s','now')),
('skl_drizzle_orm', 'drizzle_orm', 'Drizzle ORM', 'Drizzle ORM proficiency', 'database', strftime('%s','now')),
('skl_diesel', 'diesel', 'Diesel', 'Diesel ORM proficiency', 'database', strftime('%s','now')),
-- Practices
('skl_api_design', 'api_design', 'API Design', 'REST/GraphQL API design expertise', 'practice', strftime('%s','now')),
('skl_testing', 'testing', 'Testing', 'Software testing expertise', 'practice', strftime('%s','now')),
('skl_devops', 'devops', 'DevOps', 'CI/CD and infrastructure expertise', 'practice', strftime('%s','now')),
('skl_security', 'security', 'Security', 'Application security expertise', 'practice', strftime('%s','now')),
('skl_architecture', 'architecture', 'Architecture', 'System architecture expertise', 'practice', strftime('%s','now')),
('skl_documentation', 'documentation', 'Documentation', 'Technical writing expertise', 'practice', strftime('%s','now')),
('skl_code_review', 'code_review', 'Code Review', 'Code review expertise', 'practice', strftime('%s','now')),
('skl_debugging', 'debugging', 'Debugging', 'Debugging and troubleshooting expertise', 'practice', strftime('%s','now')),
('skl_sse', 'sse', 'SSE', 'Server-Sent Events expertise', 'practice', strftime('%s','now')),
('skl_webhooks', 'webhooks', 'Webhooks', 'Webhook design and handling', 'practice', strftime('%s','now')),
('skl_orchestration', 'orchestration', 'Orchestration', 'Multi-agent orchestration expertise', 'practice', strftime('%s','now')),
('skl_task_mgmt', 'task_management', 'Task Management', 'Task and project management', 'practice', strftime('%s','now')),
('skl_research', 'research', 'Research', 'Information research expertise', 'practice', strftime('%s','now')),
('skl_web_dev', 'web_development', 'Web Development', 'Full-stack web development', 'practice', strftime('%s','now')),
('skl_monorepo', 'monorepo', 'Monorepo', 'Monorepo management expertise', 'practice', strftime('%s','now'));

-- ============================================================================
-- 14. Data migration: freetext capabilities/skills -> junction tables (from 0014)
-- ============================================================================

INSERT OR IGNORE INTO agent_capabilities (agent_id, capability_id)
SELECT a.id, c.id
FROM agents a, json_each(a.capabilities) AS je
JOIN capabilities c ON c.slug = (
    CASE LOWER(TRIM(je.value, '"'))
        WHEN 'chat' THEN 'chat'
        WHEN 'conversation' THEN 'chat'
        WHEN 'conversations' THEN 'chat'
        WHEN 'messaging' THEN 'messaging'
        WHEN 'tools' THEN 'tools'
        WHEN 'tool_use' THEN 'tools'
        WHEN 'tool-use' THEN 'tools'
        WHEN 'code' THEN 'code_generation'
        WHEN 'coding' THEN 'code_generation'
        WHEN 'code_generation' THEN 'code_generation'
        WHEN 'code-generation' THEN 'code_generation'
        WHEN 'code_gen' THEN 'code_generation'
        WHEN 'code_review' THEN 'code_review'
        WHEN 'code-review' THEN 'code_review'
        WHEN 'search' THEN 'search'
        WHEN 'web_search' THEN 'search'
        WHEN 'orchestration' THEN 'orchestration'
        WHEN 'streaming' THEN 'streaming'
        WHEN 'sse' THEN 'streaming'
        WHEN 'webhooks' THEN 'webhooks'
        WHEN 'webhook' THEN 'webhooks'
        WHEN 'file_operations' THEN 'file_operations'
        WHEN 'file_ops' THEN 'file_operations'
        WHEN 'file-operations' THEN 'file_operations'
        WHEN 'web_browsing' THEN 'web_browsing'
        WHEN 'web-browsing' THEN 'web_browsing'
        WHEN 'browsing' THEN 'web_browsing'
        WHEN 'reasoning' THEN 'reasoning'
        WHEN 'automation' THEN 'automation'
        WHEN 'testing' THEN 'testing'
        WHEN 'git' THEN 'git'
        WHEN 'deployment' THEN 'deployment'
        WHEN 'deploy' THEN 'deployment'
        WHEN 'monitoring' THEN 'monitoring'
        WHEN 'file_upload' THEN 'file_upload'
        WHEN 'file-upload' THEN 'file_upload'
        WHEN 'autonomous' THEN 'autonomous'
        ELSE LOWER(TRIM(je.value, '"'))
    END
);

INSERT OR IGNORE INTO agent_skills (agent_id, skill_id)
SELECT a.id, s.id
FROM agents a, json_each(a.skills) AS je
JOIN skills s ON s.slug = (
    CASE LOWER(TRIM(je.value, '"'))
        WHEN 'coding' THEN 'typescript'
        WHEN 'typescript' THEN 'typescript'
        WHEN 'javascript' THEN 'javascript'
        WHEN 'python' THEN 'python'
        WHEN 'rust' THEN 'rust'
        WHEN 'go' THEN 'go'
        WHEN 'java' THEN 'java'
        WHEN 'csharp' THEN 'csharp'
        WHEN 'c#' THEN 'csharp'
        WHEN 'sql' THEN 'sql'
        WHEN 'bash' THEN 'bash'
        WHEN 'shell' THEN 'bash'
        WHEN 'react' THEN 'react'
        WHEN 'nextjs' THEN 'nextjs'
        WHEN 'next.js' THEN 'nextjs'
        WHEN 'next' THEN 'nextjs'
        WHEN 'svelte' THEN 'svelte'
        WHEN 'express' THEN 'express'
        WHEN 'axum' THEN 'axum'
        WHEN 'django' THEN 'django'
        WHEN 'electron' THEN 'electron'
        WHEN 'sqlite' THEN 'sqlite'
        WHEN 'postgres' THEN 'postgres'
        WHEN 'postgresql' THEN 'postgres'
        WHEN 'redis' THEN 'redis'
        WHEN 'drizzle' THEN 'drizzle_orm'
        WHEN 'drizzle_orm' THEN 'drizzle_orm'
        WHEN 'drizzle-orm' THEN 'drizzle_orm'
        WHEN 'diesel' THEN 'diesel'
        WHEN 'api_design' THEN 'api_design'
        WHEN 'api-design' THEN 'api_design'
        WHEN 'api' THEN 'api_design'
        WHEN 'testing' THEN 'testing'
        WHEN 'devops' THEN 'devops'
        WHEN 'security' THEN 'security'
        WHEN 'architecture' THEN 'architecture'
        WHEN 'documentation' THEN 'documentation'
        WHEN 'docs' THEN 'documentation'
        WHEN 'code_review' THEN 'code_review'
        WHEN 'code-review' THEN 'code_review'
        WHEN 'debugging' THEN 'debugging'
        WHEN 'sse' THEN 'sse'
        WHEN 'webhooks' THEN 'webhooks'
        WHEN 'webhook' THEN 'webhooks'
        WHEN 'orchestration' THEN 'orchestration'
        WHEN 'task_management' THEN 'task_management'
        WHEN 'task-management' THEN 'task_management'
        WHEN 'research' THEN 'research'
        WHEN 'web_development' THEN 'web_development'
        WHEN 'web-development' THEN 'web_development'
        WHEN 'web-dev' THEN 'web_development'
        WHEN 'monorepo' THEN 'monorepo'
        WHEN 'messaging-systems' THEN 'architecture'
        ELSE LOWER(TRIM(je.value, '"'))
    END
);

-- ============================================================================
-- 15. Better-auth tables (from 0015)
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
    id                          TEXT PRIMARY KEY NOT NULL,
    user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id                  TEXT NOT NULL,
    provider_id                 TEXT NOT NULL,
    access_token                TEXT,
    refresh_token               TEXT,
    id_token                    TEXT,
    access_token_expires_at     TEXT,
    refresh_token_expires_at    TEXT,
    scope                       TEXT,
    password                    TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, account_id);

CREATE TABLE IF NOT EXISTS sessions (
    id                      TEXT PRIMARY KEY NOT NULL,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token                   TEXT NOT NULL UNIQUE,
    ip_address              TEXT,
    user_agent              TEXT,
    expires_at              TEXT NOT NULL,
    active_organization_id  TEXT,
    impersonated_by         TEXT,
    active                  INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS verifications (
    id          TEXT PRIMARY KEY NOT NULL,
    identifier  TEXT NOT NULL,
    value       TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

-- Migrate existing password_hash data into accounts table.
INSERT OR IGNORE INTO accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
SELECT
    lower(hex(randomblob(16))),
    id,
    id,
    'credential',
    password_hash,
    datetime(created_at, 'unixepoch'),
    datetime(updated_at, 'unixepoch')
FROM users
WHERE password_hash IS NOT NULL AND password_hash != '';

-- ============================================================================
-- 16. Organization agent keys (from 0016)
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_agent_keys (
    id              TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS org_agent_keys_org_idx ON org_agent_keys(organization_id);
CREATE INDEX IF NOT EXISTS org_agent_keys_agent_idx ON org_agent_keys(agent_id);

-- ============================================================================
-- 17. Message pins (already created in section 11)
-- ============================================================================

-- ============================================================================
-- 18. Attachment versioning tables (from 0018)
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachment_versions (
    id                  TEXT PRIMARY KEY,
    slug                TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number      INTEGER NOT NULL,
    author_agent_id     TEXT NOT NULL,
    change_type         TEXT NOT NULL DEFAULT 'patch',
    patch_text          TEXT,
    storage_key         TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    original_size       INTEGER NOT NULL,
    compressed_size     INTEGER NOT NULL,
    tokens              INTEGER NOT NULL,
    change_summary      TEXT,
    sections_modified   TEXT NOT NULL DEFAULT '[]',
    tokens_added        INTEGER NOT NULL DEFAULT 0,
    tokens_removed      INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    UNIQUE(slug, version_number)
);

CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug ON attachment_versions(slug);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author ON attachment_versions(author_agent_id);

CREATE TABLE IF NOT EXISTS attachment_approvals (
    id                  TEXT PRIMARY KEY,
    slug                TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    reviewer_agent_id   TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    comment             TEXT,
    version_reviewed    INTEGER NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE(slug, reviewer_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug ON attachment_approvals(slug);

CREATE TABLE IF NOT EXISTS attachment_contributors (
    slug                    TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    agent_id                TEXT NOT NULL,
    version_count           INTEGER NOT NULL DEFAULT 0,
    total_tokens_added      INTEGER NOT NULL DEFAULT 0,
    total_tokens_removed    INTEGER NOT NULL DEFAULT 0,
    first_contribution_at   INTEGER NOT NULL,
    last_contribution_at    INTEGER NOT NULL,
    PRIMARY KEY (slug, agent_id)
);
