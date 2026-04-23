/**
 * SQLite store for conduit.db — project-tier messaging and agent-ref database.
 *
 * Creates and manages .cleo/conduit.db using node:sqlite directly.
 * Applies the full conduit.db DDL (from spec §2.1) to bootstrap all
 * project-local messaging tables and the project_agent_refs override table.
 *
 * Architecture (ADR-037):
 *   conduit.db   — project-scoped (this module) — messaging, delivery, attachments,
 *                  project_agent_refs
 *   signaldock.db — global-scoped (T346) — agents, capabilities, cloud-sync tables
 *
 * CRUD accessors for project_agent_refs land in T353.
 * Cross-DB join accessor changes land in T355.
 * Migration executor from signaldock.db → conduit.db lands in T358.
 *
 * @task T344
 * @epic T310
 * @why ADR-037 splits single signaldock.db into project-tier conduit.db
 *      (this module) and global-tier signaldock.db (T346). This module owns
 *      the project-tier path helper, initializer, schema DDL, and health check.
 * @what Path helper, database initializer, schema applier, health check, and
 *       native DB accessor for project-local tables. No CRUD, no migrations.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// underscore-import: node:sqlite type alias required for createRequire interop.
// Vitest/Vite cannot resolve `node:sqlite` as an ESM import (strips `node:` prefix).
// Use createRequire as the runtime loader; keep type-only import for annotations.
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { ProjectAgentRef } from '@cleocode/contracts';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Database file name within .cleo/ directory. */
export const CONDUIT_DB_FILENAME = 'conduit.db';

/** Schema version for conduit.db — updated when DDL changes. */
export const CONDUIT_SCHEMA_VERSION = '2026.4.23';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _conduitNativeDb: DatabaseSync | null = null;
let _conduitDbPath: string | null = null;

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Full conduit.db schema SQL.
 *
 * All tables use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
 * CREATE TRIGGER IF NOT EXISTS for idempotency. Carried over verbatim from
 * the project-local tables in signaldock-sqlite.ts (migration
 * `2026-03-28-000000_initial` + subsequent migrations), minus the global-
 * identity tables (agents, capabilities, skills, agent_capabilities,
 * agent_skills, agent_connections, users, organization, accounts, sessions,
 * verifications, claim_codes, org_agent_keys) which move to global-tier
 * signaldock.db (T346).
 *
 * Additional new table: project_agent_refs (ADR-037 §3, Q6=A).
 *
 * NOTE: The `connections` table from the original migration is a cross-agent
 * social graph that references `agents(id)` — it is a global-identity
 * concern and stays with signaldock.db (T346). It is NOT included here.
 */
const CONDUIT_SCHEMA_SQL = `
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
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_from_agent_idx ON messages(from_agent_id);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;

-- -------------------------------------------------------------------------
-- FTS5 virtual table for full-text search on message content.
-- NOTE: Must be migrated using VACUUM INTO, not DDL-only copy, to preserve
-- triggers. The INSERT INTO messages_fts(messages_fts) VALUES('rebuild')
-- is idempotent — safe to run on every open.
-- -------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, from_agent_id, content='messages', content_rowid='rowid');
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
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
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status ON delivery_jobs(status, next_attempt_at);

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
CREATE INDEX IF NOT EXISTS idx_dead_letters_message ON dead_letters(message_id);

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
CREATE INDEX IF NOT EXISTS idx_pins_conversation ON message_pins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pins_agent ON message_pins(pinned_by);

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
CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS attachments_agent_idx ON attachments(from_agent_id);

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
CREATE INDEX IF NOT EXISTS idx_attachment_versions_slug ON attachment_versions(slug);
CREATE INDEX IF NOT EXISTS idx_attachment_versions_author ON attachment_versions(author_agent_id);

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
CREATE INDEX IF NOT EXISTS idx_attachment_approvals_slug ON attachment_approvals(slug);

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
-- Partial index: covers the dominant query path (list enabled agents).
CREATE INDEX IF NOT EXISTS idx_project_agent_refs_enabled
    ON project_agent_refs(enabled) WHERE enabled = 1;

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
CREATE INDEX IF NOT EXISTS idx_topics_epic ON topics(epic_id);

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
CREATE INDEX IF NOT EXISTS idx_topic_subscriptions_agent ON topic_subscriptions(agent_id);

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
CREATE INDEX IF NOT EXISTS idx_topic_messages_topic_created ON topic_messages(topic_id, created_at);

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

-- -------------------------------------------------------------------------
-- Schema tracking tables (mirrors _signaldock_meta / _signaldock_migrations).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _conduit_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE TABLE IF NOT EXISTS _conduit_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the project-tier conduit.db path.
 *
 * Always resolves to `<projectRoot>/.cleo/conduit.db`. The caller is
 * responsible for supplying the absolute project root (e.g. via
 * `getProjectRoot()` from `../paths.js`).
 *
 * @task T344
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Absolute path to `<projectRoot>/.cleo/conduit.db`.
 */
export function getConduitDbPath(projectRoot: string): string {
  return join(projectRoot, '.cleo', CONDUIT_DB_FILENAME);
}

/**
 * Applies the conduit.db schema idempotently using CREATE TABLE IF NOT EXISTS.
 *
 * Exposed for the migration executor (T358) which needs to apply the schema
 * to a newly created conduit.db during the signaldock.db → conduit.db
 * migration. Also called internally by `ensureConduitDb` on every open.
 *
 * @task T344
 * @epic T310
 * @param db - An open node:sqlite DatabaseSync instance.
 */
export function applyConduitSchema(db: DatabaseSync): void {
  db.exec(CONDUIT_SCHEMA_SQL);
}

/**
 * Opens or creates conduit.db for the given project root.
 *
 * On first call for a given projectRoot:
 *   1. Creates `<projectRoot>/.cleo/` directory if missing.
 *   2. Opens (or creates) the SQLite file.
 *   3. Sets WAL mode and enables foreign keys.
 *   4. Applies all DDL via `applyConduitSchema` (idempotent).
 *   5. Records `schema_version` in `_conduit_meta`.
 *   6. Records the initial migration in `_conduit_migrations`.
 *   7. Stores the open handle in the module singleton.
 *
 * On subsequent calls the existing singleton is returned immediately if the
 * resolved path matches; otherwise the previous handle is closed and a new
 * one is opened (test-isolation safety).
 *
 * Caller MUST call `closeConduitDb()` when done to release the handle.
 *
 * @task T344
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Object with `action` (`'created'` | `'exists'`) and `path`.
 */
export function ensureConduitDb(projectRoot: string): {
  action: 'created' | 'exists';
  path: string;
} {
  const dbPath = getConduitDbPath(projectRoot);

  // If singleton already open at the same path, skip re-initialization.
  if (_conduitNativeDb && _conduitDbPath === dbPath) {
    return { action: 'exists', path: dbPath };
  }

  // Close any stale singleton pointing at a different path (e.g. between tests).
  if (_conduitNativeDb) {
    closeConduitDb();
  }

  const alreadyExists = existsSync(dbPath);

  // Ensure parent .cleo/ directory exists.
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA cache_size = -64000'); // 64 MB

  // Check whether the schema sentinel table already exists before applying DDL.
  const hasSchema = (() => {
    try {
      const result = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
        .get() as { name: string } | undefined;
      return !!result;
    } catch {
      return false;
    }
  })();

  // Apply schema (idempotent — all statements use IF NOT EXISTS).
  applyConduitSchema(db);

  // Record schema version and initial migration.
  db.exec(
    `INSERT OR REPLACE INTO _conduit_meta (key, value, updated_at)
     VALUES ('schema_version', '${CONDUIT_SCHEMA_VERSION}', strftime('%s', 'now'))`,
  );
  db.prepare(
    `INSERT OR IGNORE INTO _conduit_migrations (name, applied_at)
     VALUES (?, strftime('%s', 'now'))`,
  ).run('2026-04-12-000000_initial_conduit');
  db.prepare(
    `INSERT OR IGNORE INTO _conduit_migrations (name, applied_at)
     VALUES (?, strftime('%s', 'now'))`,
  ).run('2026-04-23-000000_t1252_a2a_topics');

  _conduitNativeDb = db;
  _conduitDbPath = dbPath;

  return {
    action: alreadyExists && hasSchema ? 'exists' : 'created',
    path: dbPath,
  };
}

/**
 * Returns the live node:sqlite DatabaseSync handle for conduit.db.
 *
 * Returns `null` if `ensureConduitDb` has not been called yet for this
 * process, or if `closeConduitDb` has been called since the last open.
 *
 * @task T344
 * @epic T310
 * @returns The open DatabaseSync instance, or `null` if not initialized.
 */
export function getConduitNativeDb(): DatabaseSync | null {
  return _conduitNativeDb;
}

/**
 * Closes the conduit.db connection and resets the module singleton.
 *
 * Safe to call multiple times. No-op if the database is already closed.
 *
 * @task T344
 * @epic T310
 */
export function closeConduitDb(): void {
  if (_conduitNativeDb) {
    try {
      if (_conduitNativeDb.isOpen) {
        _conduitNativeDb.close();
      }
    } catch {
      // Ignore close errors — the handle is being discarded regardless.
    }
    _conduitNativeDb = null;
  }
  _conduitDbPath = null;
}

// ---------------------------------------------------------------------------
// project_agent_refs CRUD accessors (T353)
// ---------------------------------------------------------------------------

/**
 * Attaches an agent to the current project. If a row exists with enabled=0,
 * re-enables it (update attached_at timestamp). If a row exists with enabled=1,
 * no-op. Inserts a new row otherwise.
 *
 * @param db - conduit.db handle (from ensureConduitDb).
 * @param agentId - Global signaldock.db:agents.id (soft FK, not validated here).
 * @param opts - Optional role and capabilities override.
 * @task T353
 * @epic T310
 */
export function attachAgentToProject(
  db: DatabaseSync,
  agentId: string,
  opts?: { role?: string | null; capabilitiesOverride?: string | null },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_agent_refs (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
     VALUES (?, ?, ?, ?, NULL, 1)
     ON CONFLICT(agent_id) DO UPDATE SET
       enabled = 1,
       attached_at = CASE WHEN project_agent_refs.enabled = 0 THEN excluded.attached_at ELSE project_agent_refs.attached_at END,
       role = excluded.role,
       capabilities_override = excluded.capabilities_override`,
  ).run(agentId, now, opts?.role ?? null, opts?.capabilitiesOverride ?? null);
}

/**
 * Detaches an agent from the current project by setting enabled=0.
 * Does NOT delete the row (preserves attachment history for audit).
 *
 * @param db - conduit.db handle (from ensureConduitDb).
 * @param agentId - Agent ID to detach.
 * @task T353
 * @epic T310
 */
export function detachAgentFromProject(db: DatabaseSync, agentId: string): void {
  db.prepare(`UPDATE project_agent_refs SET enabled = 0 WHERE agent_id = ?`).run(agentId);
}

/**
 * Lists project_agent_refs rows. By default returns only enabled=1 rows.
 * Pass enabledOnly=false to return all rows regardless of enabled state.
 *
 * @param db - conduit.db handle (from ensureConduitDb).
 * @param opts - Filter options. Defaults to `{ enabledOnly: true }`.
 * @returns Array of ProjectAgentRef rows ordered by attached_at DESC.
 * @task T353
 * @epic T310
 */
export function listProjectAgentRefs(
  db: DatabaseSync,
  opts?: { enabledOnly?: boolean },
): ProjectAgentRef[] {
  const enabledOnly = opts?.enabledOnly ?? true;
  const sql = enabledOnly
    ? `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM project_agent_refs WHERE enabled = 1
       ORDER BY attached_at DESC`
    : `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM project_agent_refs
       ORDER BY attached_at DESC`;
  const rows = db.prepare(sql).all() as Array<{
    agent_id: string;
    attached_at: string;
    role: string | null;
    capabilities_override: string | null;
    last_used_at: string | null;
    enabled: number;
  }>;
  return rows.map((r) => ({
    agentId: r.agent_id,
    attachedAt: r.attached_at,
    role: r.role,
    capabilitiesOverride: r.capabilities_override,
    lastUsedAt: r.last_used_at,
    enabled: r.enabled,
  }));
}

/**
 * Returns a single project_agent_refs row by agentId, or null if not found.
 *
 * @param db - conduit.db handle (from ensureConduitDb).
 * @param agentId - Agent ID to look up.
 * @returns The ProjectAgentRef row, or null if the agent is not attached.
 * @task T353
 * @epic T310
 */
export function getProjectAgentRef(db: DatabaseSync, agentId: string): ProjectAgentRef | null {
  const row = db
    .prepare(
      `SELECT agent_id, attached_at, role, capabilities_override, last_used_at, enabled
       FROM project_agent_refs WHERE agent_id = ?`,
    )
    .get(agentId) as
    | {
        agent_id: string;
        attached_at: string;
        role: string | null;
        capabilities_override: string | null;
        last_used_at: string | null;
        enabled: number;
      }
    | undefined;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    attachedAt: row.attached_at,
    role: row.role,
    capabilitiesOverride: row.capabilities_override,
    lastUsedAt: row.last_used_at,
    enabled: row.enabled,
  };
}

/**
 * Updates the last_used_at timestamp for an agent to now.
 * No-op if the agent_id does not exist in project_agent_refs.
 *
 * @param db - conduit.db handle (from ensureConduitDb).
 * @param agentId - Agent ID to update.
 * @task T353
 * @epic T310
 */
export function updateProjectAgentLastUsed(db: DatabaseSync, agentId: string): void {
  db.prepare(`UPDATE project_agent_refs SET last_used_at = ? WHERE agent_id = ?`).run(
    new Date().toISOString(),
    agentId,
  );
}

/**
 * Checks conduit.db health — table count, WAL mode, schema version, and
 * foreign keys status.
 *
 * Used by `cleo doctor` to verify conduit.db integrity. Does NOT require
 * `ensureConduitDb` to have been called; opens and closes the DB internally.
 *
 * @task T344
 * @epic T310
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Health report object. `exists: false` when conduit.db is absent.
 */
export function checkConduitDbHealth(projectRoot: string): {
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} {
  const dbPath = getConduitDbPath(projectRoot);

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

  const db = new DatabaseSync(dbPath);
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
        .prepare("SELECT value FROM _conduit_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = meta?.value ?? null;
    } catch {
      // _conduit_meta may not exist on a partially-initialized DB.
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
