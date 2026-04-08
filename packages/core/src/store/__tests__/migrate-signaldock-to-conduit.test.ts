/**
 * Unit tests for migrate-signaldock-to-conduit.ts (T358).
 *
 * Covers all 9 required test scenarios:
 *   1. Fresh install (no legacy) — needsMigration=false, no-op
 *   2. TC-062/TC-060/TC-061: needsMigration detection variants
 *   3. Legacy with 0 agents — migrated, conduit+global+bak created
 *   4. Legacy with 3 agents — all 3 in global, 3 project_agent_refs, requires_reauth=1
 *   5. Multi-project deduplication — INSERT OR IGNORE, global single row
 *   6. Legacy with messages + conversations — all rows copied to conduit
 *   7. TC-068: Broken legacy integrity_check — aborts, no conduit, no bak
 *   8. TC-067: Idempotent re-run — second call is no-op
 *   9. .pre-t310.bak alongside conduit.db — needsMigration=false
 *
 * Tests use real SQLite in isolated tmp directories. `getCleoHome()` and
 * `getGlobalSalt()` are mocked to prevent touching real XDG_DATA_HOME and
 * to avoid machine-key dependency in tests.
 *
 * @task T358
 * @epic T310
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Logger mock — prevents pino from opening real log files during tests
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// global-salt mock — prevents filesystem access to real salt file
// ---------------------------------------------------------------------------

vi.mock('../global-salt.js', () => ({
  getGlobalSalt: () => Buffer.alloc(32, 0xab),
  __clearGlobalSaltCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh isolated tmp directory pair (projectRoot + cleoHome).
 */
function createIsolatedDirs(): {
  projectRoot: string;
  home: string;
  cleanup: () => void;
} {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const base = join(tmpdir(), `cleo-t358-${uid}`);
  const projectRoot = join(base, 'project');
  const home = join(base, 'cleo-home');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    projectRoot,
    home,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Creates a minimal global signaldock.db with the agents table and
 * required schema tracking tables.
 */
function createGlobalSignaldockDb(
  cleoHomeDir: string,
  seedAgents: Array<{
    id: string;
    agent_id: string;
    name: string;
    created_at?: number;
    updated_at?: number;
    requires_reauth?: number;
  }> = [],
): string {
  const dbPath = join(cleoHomeDir, 'signaldock.db');
  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'custom',
      privacy_tier TEXT NOT NULL DEFAULT 'public',
      capabilities TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      messages_sent INTEGER NOT NULL DEFAULT 0,
      messages_received INTEGER NOT NULL DEFAULT 0,
      conversation_count INTEGER NOT NULL DEFAULT 0,
      friend_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'online',
      payment_config TEXT,
      api_key_hash TEXT,
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
    CREATE TABLE IF NOT EXISTS capabilities (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_id TEXT NOT NULL, capability_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, capability_id)
    );
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL, skill_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL,
      transport_type TEXT NOT NULL DEFAULT 'http', connection_id TEXT,
      connected_at BIGINT NOT NULL, last_heartbeat BIGINT NOT NULL,
      connection_metadata TEXT, created_at BIGINT NOT NULL,
      UNIQUE(agent_id, connection_id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS claim_codes (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_agent_keys (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _signaldock_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS _signaldock_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  for (const agent of seedAgents) {
    db.prepare(
      `INSERT OR IGNORE INTO agents
         (id, agent_id, name, created_at, updated_at, requires_reauth)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      agent.agent_id,
      agent.name,
      agent.created_at ?? now,
      agent.updated_at ?? now,
      agent.requires_reauth ?? 0,
    );
  }
  db.close();
  return dbPath;
}

/**
 * Creates a minimal legacy signaldock.db at `<projectRoot>/.cleo/signaldock.db`.
 */
function createLegacySignaldockDb(
  projectRoot: string,
  agents: Array<{
    id: string;
    agent_id: string;
    name: string;
    classification?: string;
    created_at?: number;
    last_used_at?: number;
    api_key_encrypted?: string;
  }> = [],
  messages: Array<{
    id: string;
    conversation_id: string;
    from_agent_id: string;
    to_agent_id: string;
    content: string;
    created_at: number;
  }> = [],
  conversations: Array<{
    id: string;
    participants: string;
    created_at: number;
    updated_at: number;
  }> = [],
): string {
  const dbPath = join(projectRoot, '.cleo', 'signaldock.db');
  const db = new DatabaseSync(dbPath);
  const now = Math.floor(Date.now() / 1000);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class TEXT NOT NULL DEFAULT 'custom',
      classification TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      api_key_encrypted TEXT,
      last_used_at INTEGER,
      requires_reauth INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      participants TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
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
  `);

  for (const agent of agents) {
    db.prepare(
      `INSERT INTO agents
         (id, agent_id, name, classification, created_at, updated_at, api_key_encrypted, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agent.id,
      agent.agent_id,
      agent.name,
      agent.classification ?? null,
      agent.created_at ?? now,
      now,
      agent.api_key_encrypted ?? null,
      agent.last_used_at ?? null,
    );
  }

  for (const conv of conversations) {
    db.prepare(
      `INSERT INTO conversations (id, participants, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(conv.id, conv.participants, conv.created_at, conv.updated_at);
  }

  for (const msg of messages) {
    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, from_agent_id, to_agent_id, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      msg.id,
      msg.conversation_id,
      msg.from_agent_id,
      msg.to_agent_id,
      msg.content,
      msg.created_at,
    );
  }

  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// Run migration with isolated cleoHome mock
// ---------------------------------------------------------------------------

/**
 * Import and run the migration with the cleoHome mock pointing to `home`.
 * Each call resets modules to get a fresh import chain.
 */
async function runMigration(
  projectRoot: string,
  home: string,
): Promise<import('../migrate-signaldock-to-conduit.js').MigrationResult> {
  vi.resetModules();
  vi.doMock('../../paths.js', () => ({
    getCleoHome: () => home,
    getProjectRoot: () => projectRoot,
  }));
  vi.doMock('../global-salt.js', () => ({
    getGlobalSalt: () => Buffer.alloc(32, 0xab),
    __clearGlobalSaltCache: vi.fn(),
  }));
  vi.doMock('../signaldock-sqlite.js', () => ({
    ensureGlobalSignaldockDb: vi.fn(async () => ({
      action: 'exists',
      path: join(home, 'signaldock.db'),
    })),
    getGlobalSignaldockDbPath: () => join(home, 'signaldock.db'),
  }));
  const { migrateSignaldockToConduit } = await import('../migrate-signaldock-to-conduit.js');
  return migrateSignaldockToConduit(projectRoot);
}

async function getNeedsMigration(projectRoot: string, home: string): Promise<boolean> {
  vi.resetModules();
  vi.doMock('../../paths.js', () => ({
    getCleoHome: () => home,
    getProjectRoot: () => projectRoot,
  }));
  const { needsSignaldockToConduitMigration } = await import('../migrate-signaldock-to-conduit.js');
  return needsSignaldockToConduitMigration(projectRoot);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('migrate-signaldock-to-conduit', () => {
  let dirs: ReturnType<typeof createIsolatedDirs>;

  beforeEach(() => {
    dirs = createIsolatedDirs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dirs.cleanup();
  });

  // -------------------------------------------------------------------------
  // Detection: TC-060, TC-061, TC-062
  // -------------------------------------------------------------------------
  describe('needsSignaldockToConduitMigration', () => {
    it('TC-061: returns false when signaldock.db absent (fresh install)', async () => {
      const result = await getNeedsMigration(dirs.projectRoot, dirs.home);
      expect(result).toBe(false);
    });

    it('TC-060: returns false when conduit.db exists (migration already done)', async () => {
      writeFileSync(join(dirs.projectRoot, '.cleo', 'conduit.db'), '');
      const result = await getNeedsMigration(dirs.projectRoot, dirs.home);
      expect(result).toBe(false);
    });

    it('TC-062: returns true when signaldock.db present AND conduit.db absent', async () => {
      createLegacySignaldockDb(dirs.projectRoot, []);
      const result = await getNeedsMigration(dirs.projectRoot, dirs.home);
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Fresh install — no legacy signaldock.db
  // -------------------------------------------------------------------------
  it('returns no-op when no legacy signaldock.db exists', async () => {
    const result = await runMigration(dirs.projectRoot, dirs.home);
    expect(result.status).toBe('no-op');
    expect(result.agentsCopied).toBe(0);
    expect(result.bakPath).toBeNull();
    expect(result.errors).toHaveLength(0);
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'conduit.db'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-063: Legacy with 0 agents
  // -------------------------------------------------------------------------
  it('TC-063: 0-agent migration creates conduit.db + global signaldock.db + .pre-t310.bak', async () => {
    createLegacySignaldockDb(dirs.projectRoot, []);
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);

    expect(result.status).toBe('migrated');
    expect(result.agentsCopied).toBe(0);
    expect(result.bakPath).not.toBeNull();
    expect(result.errors).toHaveLength(0);
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'conduit.db'))).toBe(true);
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'signaldock.db.pre-t310.bak'))).toBe(true);
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'signaldock.db'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-064: Legacy with 3 agents — all migrated, project_agent_refs created
  // -------------------------------------------------------------------------
  it('TC-064: 3 agents migrated to global; 3 project_agent_refs rows; requires_reauth=1', async () => {
    const now = Math.floor(Date.now() / 1000);
    createLegacySignaldockDb(dirs.projectRoot, [
      { id: 'id-1', agent_id: 'agent-alpha', name: 'Alpha', created_at: now },
      { id: 'id-2', agent_id: 'agent-beta', name: 'Beta', created_at: now },
      { id: 'id-3', agent_id: 'agent-gamma', name: 'Gamma', created_at: now },
    ]);
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);

    expect(result.status).toBe('migrated');
    expect(result.agentsCopied).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify project_agent_refs in conduit.db
    const conduitDb = new DatabaseSync(join(dirs.projectRoot, '.cleo', 'conduit.db'));
    const refs = conduitDb
      .prepare('SELECT agent_id FROM project_agent_refs ORDER BY agent_id')
      .all() as Array<{ agent_id: string }>;
    expect(refs.map((r) => r.agent_id)).toEqual(['agent-alpha', 'agent-beta', 'agent-gamma']);

    const allEnabled = conduitDb.prepare('SELECT enabled FROM project_agent_refs').all() as Array<{
      enabled: number;
    }>;
    for (const row of allEnabled) {
      expect(row.enabled).toBe(1);
    }
    conduitDb.close();

    // Verify requires_reauth=1 in global signaldock.db
    const globalDb = new DatabaseSync(join(dirs.home, 'signaldock.db'));
    const agents = globalDb
      .prepare('SELECT agent_id, requires_reauth FROM agents ORDER BY agent_id')
      .all() as Array<{ agent_id: string; requires_reauth: number }>;
    expect(agents).toHaveLength(3);
    for (const agent of agents) {
      expect(agent.requires_reauth).toBe(1);
    }
    globalDb.close();
  });

  // -------------------------------------------------------------------------
  // TC-066: Multi-project deduplication
  // -------------------------------------------------------------------------
  it('TC-066: same agent in two projects — INSERT OR IGNORE; global has one row', async () => {
    const now = Math.floor(Date.now() / 1000);

    // Pre-seed global with agent-x already present (migrated from project A)
    createGlobalSignaldockDb(dirs.home, [
      {
        id: 'existing-id',
        agent_id: 'agent-x',
        name: 'Agent X Original',
        created_at: now,
        updated_at: now,
      },
    ]);

    // Project B also has agent-x in its legacy signaldock.db
    createLegacySignaldockDb(dirs.projectRoot, [
      { id: 'legacy-id', agent_id: 'agent-x', name: 'Agent X Legacy', created_at: now },
    ]);

    const result = await runMigration(dirs.projectRoot, dirs.home);

    expect(result.status).toBe('migrated');
    expect(result.errors).toHaveLength(0);

    // Global should still have ONE agent-x (INSERT OR IGNORE preserved existing)
    const globalDb = new DatabaseSync(join(dirs.home, 'signaldock.db'));
    const agents = globalDb
      .prepare("SELECT agent_id, name FROM agents WHERE agent_id = 'agent-x'")
      .all() as Array<{ agent_id: string; name: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('Agent X Original');
    globalDb.close();

    // conduit.db should have a project_agent_refs row for agent-x
    const conduitDb = new DatabaseSync(join(dirs.projectRoot, '.cleo', 'conduit.db'));
    const refs = conduitDb
      .prepare("SELECT agent_id FROM project_agent_refs WHERE agent_id = 'agent-x'")
      .all() as Array<{ agent_id: string }>;
    expect(refs).toHaveLength(1);
    conduitDb.close();
  });

  // -------------------------------------------------------------------------
  // TC-070/TC-071: Messages + conversations copied
  // -------------------------------------------------------------------------
  it('TC-070/TC-071: 5 messages + 2 conversations preserved in conduit.db', async () => {
    const now = Math.floor(Date.now() / 1000);
    const conversations = [
      { id: 'conv-1', participants: '["a1","a2"]', created_at: now, updated_at: now },
      { id: 'conv-2', participants: '["a1","a3"]', created_at: now + 1, updated_at: now + 1 },
    ];
    const messages = [
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        from_agent_id: 'a1',
        to_agent_id: 'a2',
        content: 'hello',
        created_at: now,
      },
      {
        id: 'msg-2',
        conversation_id: 'conv-1',
        from_agent_id: 'a2',
        to_agent_id: 'a1',
        content: 'world',
        created_at: now + 1,
      },
      {
        id: 'msg-3',
        conversation_id: 'conv-2',
        from_agent_id: 'a1',
        to_agent_id: 'a3',
        content: 'foo',
        created_at: now + 2,
      },
      {
        id: 'msg-4',
        conversation_id: 'conv-2',
        from_agent_id: 'a3',
        to_agent_id: 'a1',
        content: 'bar',
        created_at: now + 3,
      },
      {
        id: 'msg-5',
        conversation_id: 'conv-1',
        from_agent_id: 'a1',
        to_agent_id: 'a2',
        content: 'baz',
        created_at: now + 4,
      },
    ];

    createLegacySignaldockDb(dirs.projectRoot, [], messages, conversations);
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);

    expect(result.status).toBe('migrated');
    expect(result.errors).toHaveLength(0);

    const conduitDb = new DatabaseSync(join(dirs.projectRoot, '.cleo', 'conduit.db'));

    const convRows = conduitDb.prepare('SELECT id FROM conversations ORDER BY id').all() as Array<{
      id: string;
    }>;
    expect(convRows.map((r) => r.id)).toEqual(['conv-1', 'conv-2']);

    const msgRows = conduitDb.prepare('SELECT id FROM messages ORDER BY id').all() as Array<{
      id: string;
    }>;
    expect(msgRows.map((r) => r.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);

    conduitDb.close();
  });

  // -------------------------------------------------------------------------
  // TC-072: FTS search after migration
  // -------------------------------------------------------------------------
  it('TC-072: messages_fts search returns results after migration', async () => {
    const now = Math.floor(Date.now() / 1000);
    createLegacySignaldockDb(
      dirs.projectRoot,
      [],
      [
        {
          id: 'fts-msg-1',
          conversation_id: 'fts-conv-1',
          from_agent_id: 'fa1',
          to_agent_id: 'fa2',
          content: 'searchable migration content',
          created_at: now,
        },
      ],
      [{ id: 'fts-conv-1', participants: '["fa1","fa2"]', created_at: now, updated_at: now }],
    );
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);
    expect(result.status).toBe('migrated');

    const conduitDb = new DatabaseSync(join(dirs.projectRoot, '.cleo', 'conduit.db'));
    const ftsResults = conduitDb
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'migration'")
      .all() as Array<{ rowid: number }>;
    expect(ftsResults.length).toBeGreaterThan(0);
    conduitDb.close();
  });

  // -------------------------------------------------------------------------
  // TC-068: Broken legacy integrity_check
  // -------------------------------------------------------------------------
  it('TC-068: corrupt legacy DB aborts; no conduit.db; no .pre-t310.bak', async () => {
    // Write a non-SQLite file as legacy DB
    const legacyPath = join(dirs.projectRoot, '.cleo', 'signaldock.db');
    writeFileSync(legacyPath, 'CORRUPTED DATA NOT A VALID SQLITE FILE AT ALL!!!');
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);

    expect(result.status).toBe('failed');
    expect(result.errors.length).toBeGreaterThan(0);
    // No conduit.db created
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'conduit.db'))).toBe(false);
    // No .pre-t310.bak created
    expect(existsSync(legacyPath + '.pre-t310.bak')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-067: Idempotent re-run
  // -------------------------------------------------------------------------
  it('TC-067: second migration call is a no-op', async () => {
    createLegacySignaldockDb(dirs.projectRoot, []);
    createGlobalSignaldockDb(dirs.home, []);

    // First run
    const result1 = await runMigration(dirs.projectRoot, dirs.home);
    expect(result1.status).toBe('migrated');

    // Second run — conduit.db now exists
    const result2 = await runMigration(dirs.projectRoot, dirs.home);
    expect(result2.status).toBe('no-op');
    expect(result2.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 9: .pre-t310.bak alongside conduit.db
  // -------------------------------------------------------------------------
  it('needsMigration returns false when conduit.db exists alongside .pre-t310.bak', async () => {
    writeFileSync(join(dirs.projectRoot, '.cleo', 'conduit.db'), '');
    writeFileSync(join(dirs.projectRoot, '.cleo', 'signaldock.db.pre-t310.bak'), '');

    const result = await getNeedsMigration(dirs.projectRoot, dirs.home);
    expect(result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-073: .pre-t310.bak preserved (not deleted)
  // -------------------------------------------------------------------------
  it('TC-073: legacy file renamed to .pre-t310.bak and preserved', async () => {
    createLegacySignaldockDb(dirs.projectRoot, []);
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);
    expect(result.status).toBe('migrated');

    const bakPath = join(dirs.projectRoot, '.cleo', 'signaldock.db.pre-t310.bak');
    expect(existsSync(bakPath)).toBe(true);
    expect(existsSync(join(dirs.projectRoot, '.cleo', 'signaldock.db'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-090: Migrated agents have requires_reauth=1
  // -------------------------------------------------------------------------
  it('TC-090: migrated agents have requires_reauth=1 in global signaldock.db', async () => {
    const now = Math.floor(Date.now() / 1000);
    createLegacySignaldockDb(dirs.projectRoot, [
      { id: 'r1', agent_id: 'reauth-agent-1', name: 'Reauth1', created_at: now },
      { id: 'r2', agent_id: 'reauth-agent-2', name: 'Reauth2', created_at: now },
    ]);
    createGlobalSignaldockDb(dirs.home, []);

    const result = await runMigration(dirs.projectRoot, dirs.home);
    expect(result.status).toBe('migrated');

    const globalDb = new DatabaseSync(join(dirs.home, 'signaldock.db'));
    const agents = globalDb
      .prepare(
        'SELECT agent_id, requires_reauth FROM agents WHERE agent_id IN (?,?) ORDER BY agent_id',
      )
      .all('reauth-agent-1', 'reauth-agent-2') as Array<{
      agent_id: string;
      requires_reauth: number;
    }>;
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent.requires_reauth).toBe(1);
    }
    globalDb.close();
  });
});
