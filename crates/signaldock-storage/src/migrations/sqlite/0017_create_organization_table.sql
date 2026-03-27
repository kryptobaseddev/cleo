-- Phase A: Create the organization table that migration 16 references.
-- SQLite does not enforce FK constraints by default, so the reference in
-- migration 16 worked without this table existing. This migration creates
-- it properly for use by the org CRUD endpoints.

CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
