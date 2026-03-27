-- Phase 1.5: Add better-auth columns to existing users table for
-- single-database consolidation. These columns allow the better-auth
-- Diesel adapter to operate on the same users table as sqlx.
--
-- SQLite ALTER TABLE only supports ADD COLUMN, one at a time.
-- IF NOT EXISTS is not supported on ADD COLUMN, so we use a
-- no-op trick: the migration runner skips already-applied migrations.

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN display_username TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN ban_reason TEXT;
ALTER TABLE users ADD COLUMN ban_expires TEXT;
ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN metadata TEXT;

-- Create the accounts table for better-auth credential provider.
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TEXT,
    refresh_token_expires_at TEXT,
    scope TEXT,
    password TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, account_id);

-- Sessions table for better-auth session management.
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    active_organization_id TEXT,
    impersonated_by TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Verification tokens table.
CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
