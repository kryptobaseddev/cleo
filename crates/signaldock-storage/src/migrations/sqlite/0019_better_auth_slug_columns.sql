-- Migration 0019: Add slug columns expected by better-auth-diesel-sqlite.
--
-- The better-auth Diesel adapter's internal migrations expect a `slug`
-- column on `users` and `organization` tables. Migration 0015 added
-- better-auth compat columns but omitted slug. This caused a crash
-- when Diesel's CREATE TABLE IF NOT EXISTS attempted to reference slug
-- on tables that already existed without it.
--
-- Adding these columns keeps both ORMs (sqlx + Diesel) happy on the
-- same database file per DATABASE-ARCHITECTURE.md §3 (dual-ORM design).
--
-- Depends on: 0015_users_better_auth_compat.sql, 0017_create_organization_table.sql

-- User slug: URL-friendly identifier (e.g., "keaton-hoskins")
ALTER TABLE users ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);

-- Organization slug: URL-friendly identifier (e.g., "signaldock-team")
ALTER TABLE organization ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_slug ON organization(slug);

-- Organization metadata: additional org fields expected by better-auth OrganizationPlugin
ALTER TABLE organization ADD COLUMN logo TEXT;
ALTER TABLE organization ADD COLUMN metadata TEXT;
