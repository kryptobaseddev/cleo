-- Migration 0018: Collaborative document versioning, approvals, and attribution.
-- Extends the attachment system from blob storage into a full collaborative
-- document infrastructure with lifecycle states, version history, approval
-- workflows, and contributor tracking.
--
-- Spec: docs/COLLABORATIVE-DOCUMENTS-SPEC.md
-- Depends on: 0012_attachments.sql (attachments table)

-- ============================================================================
-- 1. Extend attachments table with versioning + lifecycle columns
-- ============================================================================

-- S3 object key for the current version blob (NULL = still in SQL blob column)
ALTER TABLE attachments ADD COLUMN storage_key TEXT;

-- Document lifecycle mode: draft → review → locked → archived
ALTER TABLE attachments ADD COLUMN mode TEXT NOT NULL DEFAULT 'draft';

-- Total number of versions
ALTER TABLE attachments ADD COLUMN version_count INTEGER NOT NULL DEFAULT 1;

-- Currently active version number
ALTER TABLE attachments ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;

-- ============================================================================
-- 2. Version history table
-- ============================================================================

CREATE TABLE IF NOT EXISTS attachment_versions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    author_agent_id TEXT NOT NULL,
    -- 'initial' = first version, 'patch' = unified diff, 'full_replace' = complete rewrite
    change_type TEXT NOT NULL DEFAULT 'patch',
    -- Unified diff text (NULL for initial version or full_replace)
    patch_text TEXT,
    -- S3 object key for the full content snapshot at this version
    storage_key TEXT NOT NULL,
    -- SHA-256 of the decompressed content at this version
    content_hash TEXT NOT NULL,
    -- Byte sizes
    original_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    -- Estimated token count at this version
    tokens INTEGER NOT NULL,
    -- One-line description from author or auto-generated
    change_summary TEXT,
    -- JSON array of heading names modified in this version
    sections_modified TEXT NOT NULL DEFAULT '[]',
    -- Token delta for this version
    tokens_added INTEGER NOT NULL DEFAULT 0,
    tokens_removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
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
    -- 'pending' | 'approved' | 'rejected'
    status TEXT NOT NULL DEFAULT 'pending',
    comment TEXT,
    -- Which version the reviewer evaluated
    version_reviewed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
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
    total_tokens_added INTEGER NOT NULL DEFAULT 0,
    total_tokens_removed INTEGER NOT NULL DEFAULT 0,
    first_contribution_at INTEGER NOT NULL,
    last_contribution_at INTEGER NOT NULL,
    PRIMARY KEY (slug, agent_id)
);
