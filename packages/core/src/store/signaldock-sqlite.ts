/**
 * SQLite store for global-tier signaldock.db — canonical agent identity database.
 *
 * Post-T310 (ADR-037), signaldock.db lives at `$XDG_DATA_HOME/cleo/signaldock.db`
 * (resolved via getCleoHome()). It holds cross-project agent identity, capabilities
 * catalog, and cloud-sync tables. Project-local messaging state has moved to
 * conduit.db (managed by conduit-sqlite.ts, T344).
 *
 * GLOBAL-TIER ONLY. This module MUST NOT resolve paths under any project's .cleo/
 * directory. The path guard in getGlobalSignaldockDbPath() enforces this invariant.
 *
 * @task T346
 * @epic T310
 * @related ADR-037
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getCleoHome } from '../paths.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncClass } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
};

/**
 * Database file name within the global cleo home directory.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_DB_FILENAME = 'signaldock.db';

/**
 * Schema version for global signaldock databases.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_SCHEMA_VERSION = '2026.4.12';

/**
 * @deprecated Use GLOBAL_SIGNALDOCK_SCHEMA_VERSION. Retained during T310
 * migration window. Will be removed after all callers migrate (T355).
 */
export const SIGNALDOCK_SCHEMA_VERSION = GLOBAL_SIGNALDOCK_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the GLOBAL-tier signaldock.db path. Post-T310, signaldock.db
 * holds canonical agent identity + cloud-sync tables. Project-local
 * messaging state lives in conduit.db (T344).
 *
 * Resolves to `getCleoHome() + '/signaldock.db'`.
 * Guard: asserts the resolved path starts with getCleoHome() (defense in depth,
 * mirrors the ADR-036 pattern used by getNexusDbPath in nexus-sqlite.ts).
 *
 * @task T346
 * @epic T310
 * @why ADR-037 split single signaldock.db into project conduit + global signaldock
 * @throws {Error} If resolved path is not under getCleoHome() — indicates a code
 *   path that bypasses canonical path resolution. Fix the caller, do not suppress.
 */
export function getGlobalSignaldockDbPath(): string {
  const cleoHome = getCleoHome();
  const dbPath = join(cleoHome, GLOBAL_SIGNALDOCK_DB_FILENAME);
  if (!dbPath.startsWith(cleoHome)) {
    throw new Error(
      `BUG: getGlobalSignaldockDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). signaldock.db is global-only per ADR-037. ` +
        `This indicates a code path that bypasses path resolution — ` +
        `fix the caller, do not suppress this error.`,
    );
  }
  return dbPath;
}

/**
 * @deprecated Use getGlobalSignaldockDbPath() directly. Retained during T310
 * migration window so the TypeScript build does not break until all callers
 * are updated (tracked in T355 accessor refactor).
 *
 * When called WITHOUT arguments: returns the global-tier path (forwards to
 * getGlobalSignaldockDbPath()).
 *
 * When called WITH a non-undefined `cwd` argument: throws a migration error
 * immediately. The project-tier path is now owned by conduit-sqlite.ts (T344).
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export function getSignaldockDbPath(cwd?: string): string {
  if (cwd !== undefined) {
    throw new Error(
      'getSignaldockDbPath(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only at $XDG_DATA_HOME/cleo/signaldock.db. ' +
        'Use getGlobalSignaldockDbPath(), or for project-local messaging use ' +
        'getConduitDbPath() from conduit-sqlite.ts (T344).',
    );
  }
  return getGlobalSignaldockDbPath();
}

// ---------------------------------------------------------------------------
// Embedded migration SQL — consolidated global-tier schema.
// Source: spec §2.2, ADR-037.
// All incremental ALTER TABLE migrations from the pre-T310 schema are
// collapsed into the single initial migration below. This avoids the
// multi-step ALTER pattern and ensures fresh installs get the full schema
// in one idempotent pass.
// ---------------------------------------------------------------------------

/**
 * Ordered migration entries for the global signaldock.db.
 * Add new migrations to the END of this array.
 *
 * @task T346
 * @epic T310
 */
const GLOBAL_EMBEDDED_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '2026-04-12-000000_initial_global_signaldock',
    sql: `-- Global-tier signaldock.db initial migration (T310, ADR-037 §2.2).
-- Consolidated from pre-T310 incremental migrations. Global identity and
-- cloud-sync tables only. Project-local messaging state is in conduit.db.

-- Cloud-sync: user accounts (zero rows in pure-local mode).
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    slug TEXT,
    default_agent_id TEXT,
    username TEXT,
    display_username TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT,
    ban_expires TEXT,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON users(slug);

-- Cloud-sync: organization/team records.
CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT,
    logo TEXT,
    metadata TEXT,
    owner_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_slug ON organization(slug);

-- Global identity: canonical agent registry (cross-project).
-- api_key_encrypted uses KDF: HMAC-SHA256(machine-key || global-salt, agentId) — ADR-037 §5.
-- requires_reauth=1 is set during T310 migration for all pre-existing agents.
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    class TEXT NOT NULL DEFAULT 'custom',
    privacy_tier TEXT NOT NULL DEFAULT 'public',
    owner_id TEXT REFERENCES users(id),
    endpoint TEXT,
    webhook_secret TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    skills TEXT NOT NULL DEFAULT '[]',
    avatar TEXT,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    messages_received INTEGER NOT NULL DEFAULT 0,
    conversation_count INTEGER NOT NULL DEFAULT 0,
    friend_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen INTEGER,
    payment_config TEXT,
    api_key_hash TEXT,
    organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    api_key_encrypted TEXT,
    api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io',
    classification TEXT,
    transport_config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    requires_reauth INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_idx ON agents(agent_id);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents(owner_id);
CREATE INDEX IF NOT EXISTS agents_class_idx ON agents(class);
CREATE INDEX IF NOT EXISTS agents_privacy_idx ON agents(privacy_tier);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents(organization_id);
CREATE INDEX IF NOT EXISTS idx_agents_transport_type ON agents(transport_type);
CREATE INDEX IF NOT EXISTS idx_agents_is_active ON agents(is_active);
CREATE INDEX IF NOT EXISTS idx_agents_last_used ON agents(last_used_at);
CREATE INDEX IF NOT EXISTS idx_agents_reauth ON agents(requires_reauth) WHERE requires_reauth = 1;

-- Cloud-sync: one-time agent claim tokens (api.signaldock.io provisioning).
CREATE TABLE IF NOT EXISTS claim_codes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    code TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claim_codes_code_idx ON claim_codes(code);
CREATE INDEX IF NOT EXISTS claim_codes_agent_idx ON claim_codes(agent_id);

-- Identity catalog: pre-seeded capability slugs (19 entries).
CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Identity catalog: pre-seeded skill slugs (36 entries).
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Junction: agent <-> capability catalog bindings.
CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    PRIMARY KEY (agent_id, capability_id)
);

-- Junction: agent <-> skill catalog bindings.
CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

-- Live transport connection tracking (heartbeat state).
CREATE TABLE IF NOT EXISTS agent_connections (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    transport_type TEXT NOT NULL DEFAULT 'http',
    connection_id TEXT,
    connected_at BIGINT NOT NULL,
    last_heartbeat BIGINT NOT NULL,
    connection_metadata TEXT,
    created_at BIGINT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
    UNIQUE(agent_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_agent ON agent_connections(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_transport ON agent_connections(transport_type);
CREATE INDEX IF NOT EXISTS idx_agent_connections_heartbeat ON agent_connections(last_heartbeat);

-- Cloud-sync: OAuth/provider accounts.
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

-- Cloud-sync: authenticated sessions.
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

-- Cloud-sync: email/2FA verification tokens.
CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

-- Org-scoped agent API keys (cloud use; zero rows locally).
CREATE TABLE IF NOT EXISTS org_agent_keys (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS org_agent_keys_org_idx ON org_agent_keys(organization_id);
CREATE INDEX IF NOT EXISTS org_agent_keys_agent_idx ON org_agent_keys(agent_id);`,
  },
];

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

/** Singleton native DatabaseSync handle for the current process. */
let _globalSignaldockNativeDb: DatabaseSync | null = null;

/**
 * Apply the global signaldock schema to an already-open database.
 * Idempotent — uses `CREATE TABLE IF NOT EXISTS` and migration tracking.
 *
 * @param db - An open DatabaseSync instance at the global path
 * @task T346
 * @epic T310
 */
function applyGlobalSignaldockSchema(db: DatabaseSync): void {
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

  // Apply embedded migrations (skips already-applied ones)
  for (const migration of GLOBAL_EMBEDDED_MIGRATIONS) {
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
    VALUES ('schema_version', '${GLOBAL_SIGNALDOCK_SCHEMA_VERSION}', strftime('%s', 'now'))
  `);
}

/**
 * Ensure global signaldock.db exists with the full global schema applied.
 * Creates the global cleo home directory if it doesn't exist.
 * Idempotent — safe to call multiple times.
 *
 * @returns Object with action ('created' | 'exists') and the database path
 * @task T346
 * @epic T310
 */
export async function ensureGlobalSignaldockDb(): Promise<{
  action: 'created' | 'exists';
  path: string;
}> {
  const dbPath = getGlobalSignaldockDbPath();
  const alreadyExists = existsSync(dbPath);

  // Ensure global cleo home directory exists
  const cleoHome = getCleoHome();
  if (!existsSync(cleoHome)) {
    mkdirSync(cleoHome, { recursive: true });
  }

  const db = new DatabaseSyncClass(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA cache_size = -64000'); // 64 MB

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

    applyGlobalSignaldockSchema(db);

    // Store native handle for backup integration (getGlobalSignaldockNativeDb)
    _globalSignaldockNativeDb = db;

    return {
      action: alreadyExists && hasSchema ? 'exists' : 'created',
      path: dbPath,
    };
  } catch (err) {
    db.close();
    _globalSignaldockNativeDb = null;
    throw err;
  }
  // NOTE: We intentionally do NOT close `db` here — the native handle is
  // retained as _globalSignaldockNativeDb for backup integration. Callers
  // that need a short-lived open/close pattern should open the DB themselves.
}

/**
 * @deprecated Use ensureGlobalSignaldockDb(). Retained during T310 migration
 * window for callers in init.ts and agent-registry-accessor.ts.
 *
 * When called WITHOUT arguments: forwards to ensureGlobalSignaldockDb().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function ensureSignaldockDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  if (cwd !== undefined) {
    throw new Error(
      'ensureSignaldockDb(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use ensureGlobalSignaldockDb() for global identity, or ' +
        'ensureConduitDb(cwd) from conduit-sqlite.ts for project messaging (T344).',
    );
  }
  return ensureGlobalSignaldockDb();
}

/**
 * Check global signaldock.db health: table count, WAL mode, schema version.
 * Used by `cleo doctor` to verify global signaldock.db integrity.
 *
 * @returns Health report object, or object with exists=false if the DB does not exist.
 * @task T346
 * @epic T310
 */
export async function checkGlobalSignaldockDbHealth(): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getGlobalSignaldockDbPath();
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
      // Meta table may not exist on very old or partially-initialized DBs
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

/**
 * @deprecated Use checkGlobalSignaldockDbHealth(). Retained during T310 migration
 * window for callers in `cleo doctor` and other diagnostics.
 *
 * When called WITHOUT arguments: forwards to checkGlobalSignaldockDbHealth().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function checkSignaldockDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  if (cwd !== undefined) {
    throw new Error(
      'checkSignaldockDbHealth(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use checkGlobalSignaldockDbHealth() for global signaldock health, or ' +
        'checkConduitDbHealth(cwd) from conduit-sqlite.ts for project conduit health (T344).',
    );
  }
  return checkGlobalSignaldockDbHealth();
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for global signaldock.db.
 * Returns the handle stored by the most recent ensureGlobalSignaldockDb() call,
 * or null if the database has not yet been initialized in this process.
 *
 * Used by sqlite-backup.ts to activate the signaldock GLOBAL_SNAPSHOT_TARGET
 * (spec §6.2, T310).
 *
 * @task T346
 * @epic T310
 */
export function getGlobalSignaldockNativeDb(): DatabaseSync | null {
  return _globalSignaldockNativeDb;
}

/**
 * Reset the in-process global signaldock.db singleton.
 * ONLY for use in test isolation — never call in production code.
 *
 * @task T346
 * @epic T310
 */
export function _resetGlobalSignaldockDb_TESTING_ONLY(): void {
  if (_globalSignaldockNativeDb) {
    try {
      if (_globalSignaldockNativeDb.isOpen) {
        _globalSignaldockNativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _globalSignaldockNativeDb = null;
  }
}
