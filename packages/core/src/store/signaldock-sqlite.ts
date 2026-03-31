/**
 * SQLite store for signaldock.db — local agent messaging database.
 *
 * Creates and manages .cleo/signaldock.db using node:sqlite directly.
 * Runs the consolidated Diesel migration SQL (from signaldock-storage crate)
 * to bootstrap all 22 tables for local agent infrastructure.
 *
 * This is the Node.js bootstrap path. In production cloud, the Rust
 * signaldock-storage crate manages this DB via Diesel ORM directly.
 * Locally, we create the DB here so that cleo init scaffolds the full
 * .cleo/ directory with all databases ready.
 *
 * @task T223
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getCleoDirAbsolute } from '../paths.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/** Database file name within .cleo/ directory. */
const DB_FILENAME = 'signaldock.db';

/** Schema version for signaldock databases. */
export const SIGNALDOCK_SCHEMA_VERSION = '2026.3.76';

/**
 * Get the path to the signaldock.db SQLite database file.
 */
export function getSignaldockDbPath(cwd?: string): string {
  const cleoDir = cwd ? join(cwd, '.cleo') : getCleoDirAbsolute();
  return join(cleoDir, DB_FILENAME);
}

// ---------------------------------------------------------------------------
// Embedded migration SQL — bundled so signaldock.db works in ANY project,
// not just the monorepo where crates/signaldock-storage/ exists.
// Source: crates/signaldock-storage/migrations/
// ---------------------------------------------------------------------------

/**
 * Ordered migration entries. Each has a name (for tracking) and SQL.
 * Add new migrations to the END of this array.
 */
const EMBEDDED_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '2026-03-28-000000_initial',
    sql: `-- Consolidated initial migration for SignalDock storage (19 sqlx migrations merged).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    name TEXT, slug TEXT, default_agent_id TEXT, username TEXT, display_username TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, ban_expires TEXT,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0, metadata TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);

CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT, logo TEXT, metadata TEXT,
    owner_id TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_slug ON organization(slug);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT, class TEXT NOT NULL DEFAULT 'custom',
    privacy_tier TEXT NOT NULL DEFAULT 'public', owner_id TEXT REFERENCES users(id),
    endpoint TEXT, webhook_secret TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]', avatar TEXT, messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_received INTEGER NOT NULL DEFAULT 0, conversation_count INTEGER NOT NULL DEFAULT 0,
    friend_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'online',
    last_seen INTEGER, payment_config TEXT, api_key_hash TEXT,
    organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(organization_id);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, participants TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private', message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text', status TEXT NOT NULL DEFAULT 'pending',
    attachments TEXT NOT NULL DEFAULT '[]', group_id TEXT, metadata TEXT DEFAULT '{}',
    reply_to TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS claim_codes (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id),
    code TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, used_at INTEGER,
    used_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claim_codes_code_idx ON claim_codes(code);
CREATE INDEX IF NOT EXISTS claim_codes_agent_idx ON claim_codes(agent_id);

CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, agent_a TEXT NOT NULL REFERENCES agents(id),
    agent_b TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL DEFAULT 'pending',
    initiated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_agent_a_idx ON connections(agent_a);
CREATE INDEX IF NOT EXISTS connections_agent_b_idx ON connections(agent_b);

CREATE TABLE IF NOT EXISTS delivery_jobs (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 6, next_attempt_at INTEGER NOT NULL,
    last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS dead_letters (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, job_id TEXT NOT NULL,
    reason TEXT NOT NULL, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_message ON dead_letters(message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, from_agent_id, content='messages', content_rowid='rowid');
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, from_agent_id) VALUES (new.rowid, new.content, new.from_agent_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id) VALUES('delete', old.rowid, old.content, old.from_agent_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, from_agent_id) VALUES('delete', old.rowid, old.content, old.from_agent_id);
    INSERT INTO messages_fts(rowid, content, from_agent_id) VALUES (new.rowid, new.content, new.from_agent_id);
END;

CREATE TABLE IF NOT EXISTS message_pins (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, UNIQUE(message_id, pinned_by)
);
CREATE INDEX IF NOT EXISTS idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pins_agent ON message_pins(pinned_by);

CREATE TABLE IF NOT EXISTS attachments (
    slug TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, from_agent_id TEXT NOT NULL,
    content BLOB NOT NULL, original_size INTEGER NOT NULL, compressed_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'text', title TEXT,
    tokens INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT, mode TEXT NOT NULL DEFAULT 'draft',
    version_count INTEGER NOT NULL DEFAULT 1, current_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);

CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL REFERENCES agents(id), capability_id TEXT NOT NULL REFERENCES capabilities(id),
    PRIMARY KEY (agent_id, capability_id)
);
CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id), skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, provider_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT,
    id_token TEXT, access_token_expires_at TEXT, refresh_token_expires_at TEXT, scope TEXT,
    password TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider_id, account_id);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE, ip_address TEXT, user_agent TEXT, expires_at TEXT NOT NULL,
    active_organization_id TEXT, impersonated_by TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

CREATE TABLE IF NOT EXISTS org_agent_keys (
    id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_agent_keys_org_idx ON org_agent_keys(organization_id);
CREATE INDEX IF NOT EXISTS org_agent_keys_agent_idx ON org_agent_keys(agent_id);

CREATE TABLE IF NOT EXISTS attachment_versions (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    version_number INTEGER NOT NULL, author_agent_id TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'patch', patch_text TEXT, storage_key TEXT NOT NULL,
    content_hash TEXT NOT NULL, original_size INTEGER NOT NULL, compressed_size INTEGER NOT NULL,
    tokens INTEGER NOT NULL, change_summary TEXT, sections_modified TEXT NOT NULL DEFAULT '[]',
    tokens_added INTEGER NOT NULL DEFAULT 0, tokens_removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, UNIQUE(slug, version_number)
);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug ON attachment_versions(slug);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author ON attachment_versions(author_agent_id);

CREATE TABLE IF NOT EXISTS attachment_approvals (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    reviewer_agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', comment TEXT,
    version_reviewed INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(slug, reviewer_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug ON attachment_approvals(slug);

CREATE TABLE IF NOT EXISTS attachment_contributors (
    slug TEXT NOT NULL REFERENCES attachments(slug) ON DELETE CASCADE,
    agent_id TEXT NOT NULL, version_count INTEGER NOT NULL DEFAULT 0,
    total_tokens_added INTEGER NOT NULL DEFAULT 0, total_tokens_removed INTEGER NOT NULL DEFAULT 0,
    first_contribution_at INTEGER NOT NULL, last_contribution_at INTEGER NOT NULL,
    PRIMARY KEY (slug, agent_id)
);`,
  },
  {
    name: '2026-03-30-000001_agent_connections',
    sql: `-- Add transport_type to agents table for connection mode classification.
ALTER TABLE agents ADD COLUMN transport_type TEXT NOT NULL DEFAULT 'http';
CREATE INDEX idx_agents_transport_type ON agents(transport_type);

CREATE TABLE agent_connections (
    id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http', connection_id TEXT,
    connected_at BIGINT NOT NULL, last_heartbeat BIGINT NOT NULL,
    connection_metadata TEXT, created_at BIGINT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    UNIQUE(agent_id, connection_id)
);
CREATE INDEX idx_agent_connections_agent ON agent_connections(agent_id);
CREATE INDEX idx_agent_connections_transport ON agent_connections(transport_type);
CREATE INDEX idx_agent_connections_heartbeat ON agent_connections(last_heartbeat);`,
  },
];

/**
 * Ensure signaldock.db exists and has the full schema applied.
 *
 * Idempotent — safe to call multiple times. Uses `CREATE TABLE IF NOT EXISTS`
 * and `CREATE INDEX IF NOT EXISTS` throughout.
 *
 * @returns Object with action ('created' | 'exists') and the database path.
 */
export async function ensureSignaldockDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  const dbPath = getSignaldockDbPath(cwd);
  const alreadyExists = existsSync(dbPath);

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  // Open or create the database
  const db = new DatabaseSyncClass(dbPath);

  try {
    // Set pragmas for optimal performance
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA cache_size = -64000'); // 64MB

    // Check if schema already applied (agents table as sentinel)
    const hasSchema = (() => {
      try {
        const result = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
          .get() as { name: string } | undefined;
        return !!result;
      } catch {
        return false;
      }
    })();

    // Ensure migration tracking tables exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _signaldock_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS _signaldock_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Apply embedded migrations (works in ANY project, not just monorepo)
    for (const migration of EMBEDDED_MIGRATIONS) {
      // Skip already-applied migrations
      const applied = db
        .prepare('SELECT name FROM _signaldock_migrations WHERE name = ?')
        .get(migration.name) as { name: string } | undefined;
      if (applied) continue;

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(migration.sql);
        db.prepare('INSERT INTO _signaldock_migrations (name) VALUES (?)').run(migration.name);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    // Record schema version
    db.exec(`
      INSERT OR REPLACE INTO _signaldock_meta (key, value, updated_at)
      VALUES ('schema_version', '${SIGNALDOCK_SCHEMA_VERSION}', strftime('%s', 'now'))
    `);

    return {
      action: alreadyExists && hasSchema ? 'exists' : 'created',
      path: dbPath,
    };
  } finally {
    db.close();
  }
}

/**
 * Check signaldock.db health — table count, WAL mode, schema version.
 *
 * Used by `cleo doctor` to verify signaldock.db integrity.
 *
 * @returns Health report object or null if DB doesn't exist.
 */
export async function checkSignaldockDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getSignaldockDbPath(cwd);
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      path: dbPath,
      tableCount: 0,
      walMode: false,
      schemaVersion: null,
      foreignKeysEnabled: false,
    };
  }

  const db = new DatabaseSyncClass(dbPath);
  try {
    const tables = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number };

    const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fkEnabled = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    let schemaVersion: string | null = null;
    try {
      const meta = db
        .prepare("SELECT value FROM _signaldock_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // Meta table may not exist
    }

    return {
      exists: true,
      path: dbPath,
      tableCount: tables.count,
      walMode: journalMode.journal_mode === 'wal',
      schemaVersion,
      foreignKeysEnabled: fkEnabled.foreign_keys === 1,
    };
  } finally {
    db.close();
  }
}
