-- Migration 0018: Collaborative document versioning, approvals, and attribution.
-- Extends the attachment system from blob storage into a full collaborative
-- document infrastructure with lifecycle states, version history, approval
-- workflows, and contributor tracking.
--
-- Spec: docs/COLLABORATIVE-DOCUMENTS-SPEC.md
-- NOTE: Postgres needs the attachments base table (0012 equivalent) first.
-- This migration creates it if missing, then adds versioning tables.

-- ============================================================================
-- 0. Ensure attachments base table exists (Postgres was missing 0012)
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachments (
    slug TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    content BYTEA NOT NULL,
    original_size BIGINT NOT NULL,
    compressed_size BIGINT NOT NULL,
    content_hash TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'text',
    title TEXT,
    tokens BIGINT NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);

-- ============================================================================
-- 1. Extend attachments table with versioning + lifecycle columns
-- ============================================================================

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS version_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;

-- ============================================================================
-- 2. Version history table
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachment_versions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    author_agent_id TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'patch',
    patch_text TEXT,
    storage_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    original_size BIGINT NOT NULL,
    compressed_size BIGINT NOT NULL,
    tokens BIGINT NOT NULL,
    change_summary TEXT,
    sections_modified JSONB NOT NULL DEFAULT '[]'::jsonb,
    tokens_added BIGINT NOT NULL DEFAULT 0,
    tokens_removed BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    UNIQUE(slug, version_number)
);

CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug
    ON attachment_versions(slug);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author
    ON attachment_versions(author_agent_id);

-- ============================================================================
-- 3. Approval tracking table
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachment_approvals (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    reviewer_agent_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT,
    version_reviewed INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(slug, reviewer_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug
    ON attachment_approvals(slug);

-- ============================================================================
-- 4. Contributor summary (materialized for fast queries)
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachment_contributors (
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    version_count INTEGER NOT NULL DEFAULT 0,
    total_tokens_added BIGINT NOT NULL DEFAULT 0,
    total_tokens_removed BIGINT NOT NULL DEFAULT 0,
    first_contribution_at BIGINT NOT NULL,
    last_contribution_at BIGINT NOT NULL,
    PRIMARY KEY (slug, agent_id)
);
