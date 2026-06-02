/**
 * Unit tests for agent-registry-store.ts — global-tier refactor (T346, T310).
 *
 * All tests use a tmpdir override via vi.doMock('../../paths.js') so they
 * NEVER touch the real $XDG_DATA_HOME/cleo/ directory.
 *
 * Coverage (AC from T346):
 * - TC-020: getGlobalAgentRegistryDbPath returns path within getCleoHome()
 * - TC-021: ensureGlobalAgentRegistryDb creates file with global schema on fresh install
 * - TC-022: ensureGlobalAgentRegistryDb is idempotent
 * - TC-023: agents table contains requires_reauth column
 * - TC-024: All cloud-sync tables present (users, organization, accounts, sessions,
 *            verifications, claim_codes, org_agent_keys) with zero rows
 * - TC-025: capabilities and skills tables present
 * - TC-026: agent_capabilities and agent_skills junction tables present
 * - TC-027: agent_connections table present
 * Additional:
 * - getAgentRegistryDbPath() (no args) returns global path (deprecated alias)
 * - getAgentRegistryDbPath(cwd) THROWS migration error
 * - ensureAgentRegistryDb() (no args) forwards to ensureGlobalAgentRegistryDb
 * - ensureAgentRegistryDb(cwd) THROWS migration error
 * - checkGlobalAgentRegistryDbHealth returns health report for existing DB
 * - checkAgentRegistryDbHealth(cwd) THROWS migration error
 * - getGlobalAgentRegistryNativeDb returns null before init, handle after ensureGlobalAgentRegistryDb
 * - _resetGlobalAgentRegistryDb_TESTING_ONLY clears singleton
 * - GLOBAL_AGENT_REGISTRY_DB_FILENAME constant value
 * - GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION constant value
 * - AGENT_REGISTRY_SCHEMA_VERSION deprecated alias equals GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION
 *
 * @task T346
 * @epic T310
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: create an isolated tmp dir for each test
// ---------------------------------------------------------------------------

function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `cleo-signaldock-test-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// TC-020: getGlobalAgentRegistryDbPath returns path within getCleoHome()
// ---------------------------------------------------------------------------

describe('getGlobalAgentRegistryDbPath', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-020: returns a path that starts with the mocked getCleoHome() value', async () => {
    const cleoHome = makeTmpDir('path-tc020');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalAgentRegistryDbPath } = await import('../agent-registry-store.js');
    const result = getGlobalAgentRegistryDbPath();

    expect(result.startsWith(cleoHome)).toBe(true);
    // E6-L5 (T11525): signaldock now consolidates into the GLOBAL cleo.db.
    expect(result).toBe(join(cleoHome, 'cleo.db'));
  });

  it('returns path ending with cleo.db (E6-L5 consolidation)', async () => {
    const cleoHome = makeTmpDir('path-filename');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalAgentRegistryDbPath } = await import('../agent-registry-store.js');
    const result = getGlobalAgentRegistryDbPath();

    // E6-L5 (T11525): signaldock now consolidates into the GLOBAL cleo.db.
    expect(result.endsWith('cleo.db')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deprecated alias: getAgentRegistryDbPath
// ---------------------------------------------------------------------------

describe('getAgentRegistryDbPath (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with no args returns the global path', async () => {
    const cleoHome = makeTmpDir('deprecated-path-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getAgentRegistryDbPath, getGlobalAgentRegistryDbPath } = await import(
      '../agent-registry-store.js'
    );
    expect(getAgentRegistryDbPath()).toBe(getGlobalAgentRegistryDbPath());
  });

  it('with a cwd argument THROWS a migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-path-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getAgentRegistryDbPath } = await import('../agent-registry-store.js');
    expect(() => getAgentRegistryDbPath('/some/project')).toThrow('T310');
    expect(() => getAgentRegistryDbPath('/some/project')).toThrow('conduit-sqlite.ts');
  });
});

// ---------------------------------------------------------------------------
// TC-021 + TC-022: ensureGlobalAgentRegistryDb creates DB and is idempotent
// ---------------------------------------------------------------------------

describe('ensureGlobalAgentRegistryDb', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('ensure-global');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('TC-021: creates the signaldock.db file on fresh install', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const {
      ensureGlobalAgentRegistryDb,
      getGlobalAgentRegistryDbPath,
      _resetGlobalAgentRegistryDb_TESTING_ONLY,
    } = await import('../agent-registry-store.js');

    const result = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    expect(result.action).toBe('created');
    expect(result.path).toBe(getGlobalAgentRegistryDbPath());
    expect(existsSync(result.path)).toBe(true);
  });

  it('TC-022: is idempotent — second call returns action="exists"', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );

    const first = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const second = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    expect(first.action).toBe('created');
    expect(second.action).toBe('exists');
    expect(second.path).toBe(first.path);
  });

  it('creates global cleo home directory if it does not exist', async () => {
    const nestedHome = join(cleoHome, 'deep', 'nested');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => nestedHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );

    await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    expect(existsSync(nestedHome)).toBe(true);
    // E6-L5 (T11525): signaldock now consolidates into the GLOBAL cleo.db.
    expect(existsSync(join(nestedHome, 'cleo.db'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC-023: agents table has requires_reauth column
// ---------------------------------------------------------------------------

describe('agents table schema', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('schema-agents');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-023: agents table contains requires_reauth column', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      const cols = db.prepare('PRAGMA table_info(agents)').all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('requires_reauth');

      const reauthCol = cols.find((c) => c.name === 'requires_reauth');
      expect(reauthCol).toBeDefined();
      expect(reauthCol?.notnull).toBe(1);
      expect(reauthCol?.dflt_value).toBe('0');
    } finally {
      db.close();
    }
  });

  it('agents table has is_active column from former migration 000003', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      const cols = db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('is_active');
      expect(colNames).toContain('api_key_encrypted');
      expect(colNames).toContain('api_base_url');
      expect(colNames).toContain('transport_type');
      expect(colNames).toContain('transport_config');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TC-024: Cloud-sync tables present with zero rows
// ---------------------------------------------------------------------------

describe('cloud-sync tables', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('cloud-sync');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-024: users, organization, accounts, sessions, verifications, claim_codes, org_agent_keys all present with zero rows', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      const cloudTables = [
        'users',
        'organization',
        'accounts',
        'sessions',
        'verifications',
        'claim_codes',
        'org_agent_keys',
      ];
      for (const tbl of cloudTables) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tbl) as { name: string } | undefined;
        expect(row, `Expected table ${tbl} to exist`).toBeDefined();

        const count = db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).get() as { n: number };
        expect(count.n, `Expected table ${tbl} to have 0 rows on fresh install`).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// TC-025 + TC-026: capabilities, skills, junction tables present
// ---------------------------------------------------------------------------

describe('identity catalog tables', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('catalog');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-025: capabilities and skills tables are present', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      for (const tbl of ['capabilities', 'skills']) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tbl) as { name: string } | undefined;
        expect(row, `Expected table ${tbl} to exist`).toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it('TC-026: agent_capabilities and agent_skills junction tables are present', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      for (const tbl of ['agent_capabilities', 'agent_skills']) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tbl) as { name: string } | undefined;
        expect(row, `Expected junction table ${tbl} to exist`).toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it('TC-027: agent_connections table is present with correct columns', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_connections'")
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();

      const cols = db.prepare('PRAGMA table_info(agent_connections)').all() as Array<{
        name: string;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('agent_id');
      expect(colNames).toContain('transport_type');
      expect(colNames).toContain('last_heartbeat');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// No project-local tables in global signaldock.db
// ---------------------------------------------------------------------------

describe('project-local tables absent from global signaldock.db', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('no-project-tables');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('conversations, messages, delivery_jobs, dead_letters tables are NOT present', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const { path: dbPath } = await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const db = new DatabaseSync(dbPath);
    try {
      const projectTables = ['conversations', 'messages', 'delivery_jobs', 'dead_letters'];
      for (const tbl of projectTables) {
        const row = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tbl) as { name: string } | undefined;
        expect(
          row,
          `Table ${tbl} should NOT exist in global signaldock.db (belongs in conduit.db)`,
        ).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// checkGlobalAgentRegistryDbHealth
// ---------------------------------------------------------------------------

describe('checkGlobalAgentRegistryDbHealth', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('health');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns exists=false when DB does not exist', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { checkGlobalAgentRegistryDbHealth } = await import('../agent-registry-store.js');
    const health = await checkGlobalAgentRegistryDbHealth();

    expect(health).not.toBeNull();
    expect(health?.exists).toBe(false);
    expect(health?.tableCount).toBe(0);
  });

  it('returns exists=true with correct table count after ensureGlobalAgentRegistryDb', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const {
      ensureGlobalAgentRegistryDb,
      checkGlobalAgentRegistryDbHealth,
      _resetGlobalAgentRegistryDb_TESTING_ONLY,
    } = await import('../agent-registry-store.js');

    await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const health = await checkGlobalAgentRegistryDbHealth();
    expect(health?.exists).toBe(true);
    expect(health?.schemaVersion).toBe('2026.4.12');
    // Global schema has: users, organization, agents, claim_codes, capabilities, skills,
    // agent_capabilities, agent_skills, agent_connections, accounts, sessions, verifications,
    // org_agent_keys, _signaldock_meta, _signaldock_migrations (15 tables)
    expect(health?.tableCount).toBeGreaterThanOrEqual(13);
  });
});

// ---------------------------------------------------------------------------
// Deprecated: checkAgentRegistryDbHealth
// ---------------------------------------------------------------------------

describe('checkAgentRegistryDbHealth (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with cwd argument THROWS migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-health-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { checkAgentRegistryDbHealth } = await import('../agent-registry-store.js');
    await expect(checkAgentRegistryDbHealth('/some/project')).rejects.toThrow('T310');
  });

  it('with no args forwards to global health check', async () => {
    const cleoHome = makeTmpDir('deprecated-health-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { checkAgentRegistryDbHealth } = await import('../agent-registry-store.js');
    const health = await checkAgentRegistryDbHealth();
    // DB doesn't exist yet; should return exists=false
    expect(health?.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deprecated: ensureAgentRegistryDb
// ---------------------------------------------------------------------------

describe('ensureAgentRegistryDb (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with cwd argument THROWS migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-ensure-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureAgentRegistryDb } = await import('../agent-registry-store.js');
    await expect(ensureAgentRegistryDb('/some/project')).rejects.toThrow('T310');
  });

  it('with no args forwards to ensureGlobalAgentRegistryDb', async () => {
    const cleoHome = makeTmpDir('deprecated-ensure-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureAgentRegistryDb, _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import(
      '../agent-registry-store.js'
    );
    const result = await ensureAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    expect(result.action).toBe('created');
    // E6-L5 (T11525): signaldock now consolidates into the GLOBAL cleo.db.
    expect(result.path).toContain('cleo.db');
    expect(existsSync(result.path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getGlobalAgentRegistryNativeDb and _resetGlobalAgentRegistryDb_TESTING_ONLY
// ---------------------------------------------------------------------------

describe('getGlobalAgentRegistryNativeDb', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('native-db');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns null before ensureGlobalAgentRegistryDb is called', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalAgentRegistryNativeDb } = await import('../agent-registry-store.js');
    expect(getGlobalAgentRegistryNativeDb()).toBeNull();
  });

  it('returns a DatabaseSync handle after ensureGlobalAgentRegistryDb', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const {
      ensureGlobalAgentRegistryDb,
      getGlobalAgentRegistryNativeDb,
      _resetGlobalAgentRegistryDb_TESTING_ONLY,
    } = await import('../agent-registry-store.js');

    await ensureGlobalAgentRegistryDb();
    const handle = getGlobalAgentRegistryNativeDb();
    expect(handle).not.toBeNull();

    _resetGlobalAgentRegistryDb_TESTING_ONLY();
    expect(getGlobalAgentRegistryNativeDb()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('GLOBAL_AGENT_REGISTRY_DB_FILENAME is "signaldock.db"', async () => {
    const cleoHome = makeTmpDir('constants');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { GLOBAL_AGENT_REGISTRY_DB_FILENAME } = await import('../agent-registry-store.js');
    expect(GLOBAL_AGENT_REGISTRY_DB_FILENAME).toBe('signaldock.db');
  });

  it('GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION is "2026.4.12"', async () => {
    const cleoHome = makeTmpDir('constants2');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION } = await import('../agent-registry-store.js');
    expect(GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION).toBe('2026.4.12');
  });

  it('AGENT_REGISTRY_SCHEMA_VERSION deprecated alias equals GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION', async () => {
    const cleoHome = makeTmpDir('constants3');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { AGENT_REGISTRY_SCHEMA_VERSION, GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION } = await import(
      '../agent-registry-store.js'
    );
    expect(AGENT_REGISTRY_SCHEMA_VERSION).toBe(GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION);
  });
});
