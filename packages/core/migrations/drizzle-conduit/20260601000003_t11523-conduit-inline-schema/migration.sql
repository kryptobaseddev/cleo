-- T11523 (E6-L3): Forward Drizzle migration carrying the conduit-domain schema
-- that previously lived ONLY as an inline `CREATE TABLE IF NOT EXISTS` blob
-- (`CONDUIT_SCHEMA_SQL`) applied by `applyConduitSchema()` in conduit-sqlite.ts.
--
-- E6-L3 routes `ensureConduitDb()` through `openDualScopeDb('project')` (the
-- consolidated `cleo.db` chokepoint, ADR-068/069). The inline DDL is removed and
-- replaced by this migration (T11523 AC: inline DDL → forward Drizzle migration),
-- matching the T1407 baseline marker + the L1/L2 precedent.
--
-- The conduit legacy physical table names are BARE (`conversations`, `messages`,
-- `delivery_jobs`, …) while the consolidated schema (`cleo-project/conduit.ts`)
-- carries the `conduit_` domain prefix (`conduit_conversations`, …). They are
-- therefore DISJOINT physical names — the legacy runtime-shape tables co-exist
-- harmlessly alongside the consolidated `conduit_*` tables in the same `cleo.db`,
-- exactly like the tasks domain (legacy `tasks` ≠ consolidated `tasks_tasks`).
-- No DROP/rebuild is needed (unlike the brain domain, E6-L2).
--
-- All DDL is reproduced VERBATIM from `CONDUIT_SCHEMA_SQL` (legacy runtime shape):
-- 16 tables + indexes + FTS5 virtual table + 3 FTS5 triggers. Every statement is
-- `IF NOT EXISTS`, so re-running on a DB that already has the tables is idempotent.
-- The exodus migration (T11248 / T11553) later renames these to `conduit_*`.

-- -------------------------------------------------------------------------
-- Project-scoped conversations (LocalTransport DM threads).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Project-scoped agent-to-agent messages (LocalTransport content).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    status TEXT NOT NULL DEFAULT 'pending',
    attachments TEXT NOT NULL DEFAULT '[]',
    group_id TEXT,
    metadata TEXT DEFAULT '{}',
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- FTS5 virtual table for full-text search on message content.
-- NOTE: Must be migrated using VACUUM INTO, not DDL-only copy, to preserve
-- triggers. The INSERT INTO messages_fts(messages_fts) VALUES('rebuild')
-- is idempotent — safe to run on every open.
-- -------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, from_agent_id, content='messages', content_rowid='rowid');
--> statement-breakpoint
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id)
        VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO messages_fts(rowid, content, from_agent_id)
        VALUES (new.rowid, new.content, new.from_agent_id);
END;
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Async delivery queue for deferred message dispatch.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_jobs (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 6,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status, next_attempt_at);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Dead-letter queue for messages that exceeded max delivery attempts.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dead_letters (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dead_letters_message ON dead_letters(message_id);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Pinned messages within a conversation.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_pins (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, pinned_by)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pins_conversation ON message_pins(conversation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pins_agent ON message_pins(pinned_by);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- File/blob attachments associated with messages.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
    slug TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    content BLOB NOT NULL,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'text',
    title TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT,
    mode TEXT NOT NULL DEFAULT 'draft',
    version_count INTEGER NOT NULL DEFAULT 1,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Version history for attachments (collaborative editing).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment_versions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    author_agent_id TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'patch',
    patch_text TEXT,
    storage_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    tokens INTEGER NOT NULL,
    change_summary TEXT,
    sections_modified TEXT NOT NULL DEFAULT '[]',
    tokens_added INTEGER NOT NULL DEFAULT 0,
    tokens_removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(slug, version_number)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug ON attachment_versions(slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author ON attachment_versions(author_agent_id);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Approval records for attachment content review.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment_approvals (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    reviewer_agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT,
    version_reviewed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(slug, reviewer_agent_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug ON attachment_approvals(slug);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Contributor statistics per attachment (who edited, how much).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment_contributors (
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    version_count INTEGER NOT NULL DEFAULT 0,
    total_tokens_added INTEGER NOT NULL DEFAULT 0,
    total_tokens_removed INTEGER NOT NULL DEFAULT 0,
    first_contribution_at INTEGER NOT NULL,
    last_contribution_at INTEGER NOT NULL,
    PRIMARY KEY (slug, agent_id)
);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- NEW: Per-project agent reference overrides (ADR-037 §3, Q6=A).
-- agent_id is a SOFT FK to global signaldock.db:agents.agent_id.
-- Cross-DB FK enforcement is not possible in SQLite; the accessor layer
-- (T355) validates on every cross-DB join.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_agent_refs (
    agent_id TEXT PRIMARY KEY,
    attached_at TEXT NOT NULL,
    role TEXT,
    capabilities_override TEXT,
    last_used_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
-- Partial index: covers the dominant query path (list enabled agents).
CREATE INDEX IF NOT EXISTS idx_project_agent_refs_enabled
    ON project_agent_refs(enabled) WHERE enabled = 1;
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- A2A Topics (T1252 — Wave 9 Agent-to-Agent coordination pub-sub).
-- Topics are named channels that agents can publish to / subscribe from.
-- Topic names follow "<epicId>.<waveId>" or "<epicId>.coordination".
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    epic_id TEXT NOT NULL,
    wave_id INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topics_epic ON topics(epic_id);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- A2A Topic subscriptions — links an agent_id to a topic_id.
-- Created by subscribeTopic(); removed by unsubscribeTopic().
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_subscriptions (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    subscribed_at INTEGER NOT NULL,
    PRIMARY KEY (topic_id, agent_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_agent ON topic_subscriptions(agent_id);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- A2A Topic messages — broadcast messages published to a topic.
-- payload is stored as JSON text.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_topic_messages_topic_created ON topic_messages(topic_id, created_at);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- A2A Topic message ACKs — per-subscriber delivery tracking.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_message_acks (
    message_id TEXT NOT NULL REFERENCES topic_messages(id) ON DELETE CASCADE,
    subscriber_agent_id TEXT NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    PRIMARY KEY (message_id, subscriber_agent_id)
);
--> statement-breakpoint

-- -------------------------------------------------------------------------
-- Schema tracking tables (mirrors _signaldock_meta / _signaldock_migrations).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _conduit_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS _conduit_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
