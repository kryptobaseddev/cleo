/**
 * Unit tests for signaldock-sqlite.ts — global-tier refactor (T346, T310).
 *
 * All tests use a tmpdir override via vi.doMock('../../paths.js') so they
 * NEVER touch the real $XDG_DATA_HOME/cleo/ directory.
 *
 * Coverage (AC from T346):
 * - TC-020: getGlobalSignaldockDbPath returns path within getCleoHome()
 * - TC-021: ensureGlobalSignaldockDb creates file with global schema on fresh install
 * - TC-022: ensureGlobalSignaldockDb is idempotent
 * - TC-023: agents table contains requires_reauth column
 * - TC-024: All cloud-sync tables present (users, organization, accounts, sessions,
 *            verifications, claim_codes, org_agent_keys) with zero rows
 * - TC-025: capabilities and skills tables present
 * - TC-026: agent_capabilities and agent_skills junction tables present
 * - TC-027: agent_connections table present
 * Additional:
 * - getSignaldockDbPath() (no args) returns global path (deprecated alias)
 * - getSignaldockDbPath(cwd) THROWS migration error
 * - ensureSignaldockDb() (no args) forwards to ensureGlobalSignaldockDb
 * - ensureSignaldockDb(cwd) THROWS migration error
 * - checkGlobalSignaldockDbHealth returns health report for existing DB
 * - checkSignaldockDbHealth(cwd) THROWS migration error
 * - getGlobalSignaldockNativeDb returns null before init, handle after ensureGlobalSignaldockDb
 * - _resetGlobalSignaldockDb_TESTING_ONLY clears singleton
 * - GLOBAL_SIGNALDOCK_DB_FILENAME constant value
 * - GLOBAL_SIGNALDOCK_SCHEMA_VERSION constant value
 * - SIGNALDOCK_SCHEMA_VERSION deprecated alias equals GLOBAL_SIGNALDOCK_SCHEMA_VERSION
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
// TC-020: getGlobalSignaldockDbPath returns path within getCleoHome()
// ---------------------------------------------------------------------------

describe('getGlobalSignaldockDbPath', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-020: returns a path that starts with the mocked getCleoHome() value', async () => {
    const cleoHome = makeTmpDir('path-tc020');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalSignaldockDbPath } = await import('../signaldock-sqlite.js');
    const result = getGlobalSignaldockDbPath();

    expect(result.startsWith(cleoHome)).toBe(true);
    expect(result).toBe(join(cleoHome, 'signaldock.db'));
  });

  it('returns path ending with signaldock.db', async () => {
    const cleoHome = makeTmpDir('path-filename');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalSignaldockDbPath } = await import('../signaldock-sqlite.js');
    const result = getGlobalSignaldockDbPath();

    expect(result.endsWith('signaldock.db')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deprecated alias: getSignaldockDbPath
// ---------------------------------------------------------------------------

describe('getSignaldockDbPath (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with no args returns the global path', async () => {
    const cleoHome = makeTmpDir('deprecated-path-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getSignaldockDbPath, getGlobalSignaldockDbPath } = await import(
      '../signaldock-sqlite.js'
    );
    expect(getSignaldockDbPath()).toBe(getGlobalSignaldockDbPath());
  });

  it('with a cwd argument THROWS a migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-path-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getSignaldockDbPath } = await import('../signaldock-sqlite.js');
    expect(() => getSignaldockDbPath('/some/project')).toThrow('T310');
    expect(() => getSignaldockDbPath('/some/project')).toThrow('conduit-sqlite.ts');
  });
});

// ---------------------------------------------------------------------------
// TC-021 + TC-022: ensureGlobalSignaldockDb creates DB and is idempotent
// ---------------------------------------------------------------------------

describe('ensureGlobalSignaldockDb', () => {
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
      ensureGlobalSignaldockDb,
      getGlobalSignaldockDbPath,
      _resetGlobalSignaldockDb_TESTING_ONLY,
    } = await import('../signaldock-sqlite.js');

    const result = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    expect(result.action).toBe('created');
    expect(result.path).toBe(getGlobalSignaldockDbPath());
    expect(existsSync(result.path)).toBe(true);
  });

  it('TC-022: is idempotent — second call returns action="exists"', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    const first = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const second = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    expect(first.action).toBe('created');
    expect(second.action).toBe('exists');
    expect(second.path).toBe(first.path);
  });

  it('creates global cleo home directory if it does not exist', async () => {
    const nestedHome = join(cleoHome, 'deep', 'nested');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => nestedHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    expect(existsSync(nestedHome)).toBe(true);
    expect(existsSync(join(nestedHome, 'signaldock.db'))).toBe(true);
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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path: dbPath } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

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
// checkGlobalSignaldockDbHealth
// ---------------------------------------------------------------------------

describe('checkGlobalSignaldockDbHealth', () => {
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

    const { checkGlobalSignaldockDbHealth } = await import('../signaldock-sqlite.js');
    const health = await checkGlobalSignaldockDbHealth();

    expect(health).not.toBeNull();
    expect(health?.exists).toBe(false);
    expect(health?.tableCount).toBe(0);
  });

  it('returns exists=true with correct table count after ensureGlobalSignaldockDb', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const {
      ensureGlobalSignaldockDb,
      checkGlobalSignaldockDbHealth,
      _resetGlobalSignaldockDb_TESTING_ONLY,
    } = await import('../signaldock-sqlite.js');

    await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const health = await checkGlobalSignaldockDbHealth();
    expect(health?.exists).toBe(true);
    expect(health?.schemaVersion).toBe('2026.4.12');
    // Global schema has: users, organization, agents, claim_codes, capabilities, skills,
    // agent_capabilities, agent_skills, agent_connections, accounts, sessions, verifications,
    // org_agent_keys, _signaldock_meta, _signaldock_migrations (15 tables)
    expect(health?.tableCount).toBeGreaterThanOrEqual(13);
  });
});

// ---------------------------------------------------------------------------
// Deprecated: checkSignaldockDbHealth
// ---------------------------------------------------------------------------

describe('checkSignaldockDbHealth (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with cwd argument THROWS migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-health-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { checkSignaldockDbHealth } = await import('../signaldock-sqlite.js');
    await expect(checkSignaldockDbHealth('/some/project')).rejects.toThrow('T310');
  });

  it('with no args forwards to global health check', async () => {
    const cleoHome = makeTmpDir('deprecated-health-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { checkSignaldockDbHealth } = await import('../signaldock-sqlite.js');
    const health = await checkSignaldockDbHealth();
    // DB doesn't exist yet; should return exists=false
    expect(health?.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deprecated: ensureSignaldockDb
// ---------------------------------------------------------------------------

describe('ensureSignaldockDb (deprecated alias)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('with cwd argument THROWS migration error', async () => {
    const cleoHome = makeTmpDir('deprecated-ensure-cwd');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureSignaldockDb } = await import('../signaldock-sqlite.js');
    await expect(ensureSignaldockDb('/some/project')).rejects.toThrow('T310');
  });

  it('with no args forwards to ensureGlobalSignaldockDb', async () => {
    const cleoHome = makeTmpDir('deprecated-ensure-noargs');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const result = await ensureSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    expect(result.action).toBe('created');
    expect(result.path).toContain('signaldock.db');
    expect(existsSync(result.path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getGlobalSignaldockNativeDb and _resetGlobalSignaldockDb_TESTING_ONLY
// ---------------------------------------------------------------------------

describe('getGlobalSignaldockNativeDb', () => {
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

  it('returns null before ensureGlobalSignaldockDb is called', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { getGlobalSignaldockNativeDb } = await import('../signaldock-sqlite.js');
    expect(getGlobalSignaldockNativeDb()).toBeNull();
  });

  it('returns a DatabaseSync handle after ensureGlobalSignaldockDb', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const {
      ensureGlobalSignaldockDb,
      getGlobalSignaldockNativeDb,
      _resetGlobalSignaldockDb_TESTING_ONLY,
    } = await import('../signaldock-sqlite.js');

    await ensureGlobalSignaldockDb();
    const handle = getGlobalSignaldockNativeDb();
    expect(handle).not.toBeNull();

    _resetGlobalSignaldockDb_TESTING_ONLY();
    expect(getGlobalSignaldockNativeDb()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('GLOBAL_SIGNALDOCK_DB_FILENAME is "signaldock.db"', async () => {
    const cleoHome = makeTmpDir('constants');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { GLOBAL_SIGNALDOCK_DB_FILENAME } = await import('../signaldock-sqlite.js');
    expect(GLOBAL_SIGNALDOCK_DB_FILENAME).toBe('signaldock.db');
  });

  it('GLOBAL_SIGNALDOCK_SCHEMA_VERSION is "2026.4.12"', async () => {
    const cleoHome = makeTmpDir('constants2');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { GLOBAL_SIGNALDOCK_SCHEMA_VERSION } = await import('../signaldock-sqlite.js');
    expect(GLOBAL_SIGNALDOCK_SCHEMA_VERSION).toBe('2026.4.12');
  });

  it('SIGNALDOCK_SCHEMA_VERSION deprecated alias equals GLOBAL_SIGNALDOCK_SCHEMA_VERSION', async () => {
    const cleoHome = makeTmpDir('constants3');
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { SIGNALDOCK_SCHEMA_VERSION, GLOBAL_SIGNALDOCK_SCHEMA_VERSION } = await import(
      '../signaldock-sqlite.js'
    );
    expect(SIGNALDOCK_SCHEMA_VERSION).toBe(GLOBAL_SIGNALDOCK_SCHEMA_VERSION);
  });
});
