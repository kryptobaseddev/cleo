/**
 * Tests for the T897 agent_registry v3 schema extension.
 *
 * Verifies that `ensureGlobalSignaldockDb()` applies the T897 migration on
 * fresh installs, that all eight new `agents` columns and both new
 * `agent_skills` columns are present with the declared types / defaults,
 * and that re-running the migration loop is a no-op (true idempotency under
 * the SQLite "no ADD COLUMN IF NOT EXISTS" constraint).
 *
 * Tests run against an isolated tmp directory via a `vi.doMock` override of
 * `paths.js` — the real `$XDG_DATA_HOME/cleo/signaldock.db` is never touched.
 *
 * @task T897
 * @epic T889
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Expected `agents` column set post-T897. Each entry pairs the SQL column
 * name with a flag indicating whether a non-null default must be asserted.
 */
const EXPECTED_AGENT_V3_COLUMNS: ReadonlyArray<{
  name: string;
  type: string;
  notNull: boolean;
  dflt: string | null;
}> = [
  { name: 'tier', type: 'TEXT', notNull: true, dflt: "'global'" },
  { name: 'can_spawn', type: 'INTEGER', notNull: true, dflt: '0' },
  { name: 'orch_level', type: 'INTEGER', notNull: true, dflt: '2' },
  { name: 'reports_to', type: 'TEXT', notNull: false, dflt: null },
  { name: 'cant_path', type: 'TEXT', notNull: false, dflt: null },
  { name: 'cant_sha256', type: 'TEXT', notNull: false, dflt: null },
  { name: 'installed_from', type: 'TEXT', notNull: false, dflt: null },
  { name: 'installed_at', type: 'TEXT', notNull: false, dflt: null },
];

const EXPECTED_AGENT_SKILLS_V3_COLUMNS: ReadonlyArray<{
  name: string;
  type: string;
  notNull: boolean;
}> = [
  { name: 'source', type: 'TEXT', notNull: true },
  { name: 'attached_at', type: 'TEXT', notNull: true },
];

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Create an isolated tmp dir per test. */
function makeTmpDir(suffix: string): string {
  const dir = join(tmpdir(), `cleo-migration-v3-${suffix}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read `PRAGMA table_info(table)` into a name-indexed map. */
function readTableInfo(db: DatabaseSync, table: string): Map<string, TableInfoRow> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T897 agent_registry v3 migration', () => {
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    cleoHome = makeTmpDir('v3');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(cleoHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('agents table carries all eight T897 v3 columns with correct types + defaults', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    const { path } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const db = new DatabaseSync(path);
    try {
      const info = readTableInfo(db, 'agents');
      for (const expected of EXPECTED_AGENT_V3_COLUMNS) {
        const col = info.get(expected.name);
        expect(col, `agents.${expected.name} must be present after T897`).toBeDefined();
        if (!col) continue;
        expect(col.type).toBe(expected.type);
        expect(col.notnull === 1).toBe(expected.notNull);
        if (expected.dflt !== null) {
          expect(col.dflt_value).toBe(expected.dflt);
        }
      }
    } finally {
      db.close();
    }
  });

  it('agent_skills table carries the two new v3 columns', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const db = new DatabaseSync(path);
    try {
      const info = readTableInfo(db, 'agent_skills');
      for (const expected of EXPECTED_AGENT_SKILLS_V3_COLUMNS) {
        const col = info.get(expected.name);
        expect(col, `agent_skills.${expected.name} must be present after T897`).toBeDefined();
        if (!col) continue;
        expect(col.type).toBe(expected.type);
        expect(col.notnull === 1).toBe(expected.notNull);
      }
    } finally {
      db.close();
    }
  });

  it('creates idx_agents_tier, idx_agents_cant_path, and idx_agent_skills_source', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const db = new DatabaseSync(path);
    try {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>;
      const names = new Set(indexes.map((i) => i.name));
      expect(names.has('idx_agents_tier')).toBe(true);
      expect(names.has('idx_agents_cant_path')).toBe(true);
      expect(names.has('idx_agent_skills_source')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('agents.tier column accepts valid tier literals', async () => {
    // NOTE: T1166 replaced the bare-SQL GLOBAL_EMBEDDED_MIGRATIONS runner with the
    // standard drizzle pipeline. The drizzle-generated migration SQL does not include
    // SQLite CHECK constraints (drizzle-orm sqlite-core does not emit them in
    // the generator output). The tier column constraint is enforced at the
    // application layer (agent-registry-accessor.ts) rather than at the DB layer.
    // This test verifies the column is present and accepts valid tier values.
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );
    const { path } = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    const db = new DatabaseSync(path);
    try {
      // Valid tier should succeed
      const insertValid = db.prepare(
        `INSERT INTO agents (id, agent_id, name, created_at, updated_at, tier, can_spawn, orch_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertValid.run('u-good', 'a-good', 'Good', 1, 1, 'project', 1, 0);

      const row = db
        .prepare('SELECT tier, can_spawn, orch_level FROM agents WHERE agent_id = ?')
        .get('a-good') as { tier: string; can_spawn: number; orch_level: number };
      expect(row.tier).toBe('project');
      expect(row.can_spawn).toBe(1);
      expect(row.orch_level).toBe(0);

      // All valid tiers should be storable
      for (const tier of ['project', 'global', 'packaged', 'fallback']) {
        const res = db
          .prepare(
            `INSERT INTO agents (id, agent_id, name, created_at, updated_at, tier)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(`id-${tier}`, `agent-${tier}`, tier, 1, 1, tier);
        expect(res.changes).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('re-running ensureGlobalSignaldockDb is idempotent (no double-ALTER error)', async () => {
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    const first = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();
    expect(first.action).toBe('created');

    // Second pass must NOT throw — SQLite's missing ADD COLUMN IF NOT EXISTS
    // means a naive re-apply would fail on `duplicate column`.
    const second = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();
    expect(second.action).toBe('exists');

    const db = new DatabaseSync(first.path);
    try {
      const info = readTableInfo(db, 'agents');
      // Each v3 column must appear exactly once
      for (const expected of EXPECTED_AGENT_V3_COLUMNS) {
        expect(info.has(expected.name)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('upgrade path: re-running ensureGlobalSignaldockDb after removing a drizzle journal entry does not error', async () => {
    // T1166: The bare-SQL _signaldock_migrations runner has been replaced by the
    // standard drizzle pipeline (__drizzle_migrations journal). This test verifies
    // that reconcileJournal Scenario 3 (column exists but journal entry absent)
    // correctly handles the case where a journal entry is removed and the migration
    // is re-tried — reconcileJournal detects the columns exist and re-inserts the
    // journal entry without re-running the DDL.
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    // Bootstrap the DB fully.
    const first = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();

    // Simulate a partial-upgrade DB: remove all journal entries so the
    // reconciler must re-discover which migrations have been applied.
    const db = new DatabaseSync(first.path);
    try {
      db.prepare('DELETE FROM "__drizzle_migrations"').run();
    } finally {
      db.close();
    }

    // Re-running must succeed — reconcileJournal Scenario 1 detects agents table
    // exists, bootstraps the journal with the initial migration marked as applied.
    const second = await ensureGlobalSignaldockDb();
    _resetGlobalSignaldockDb_TESTING_ONLY();
    expect(second.path).toBe(first.path);

    const verify = new DatabaseSync(second.path);
    try {
      const info = readTableInfo(verify, 'agents');
      expect(info.has('tier')).toBe(true);
      expect(info.has('cant_sha256')).toBe(true);

      // Journal must have been re-seeded
      const count = verify.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      };
      expect(count.cnt).toBeGreaterThanOrEqual(1);
    } finally {
      verify.close();
    }
  });
});
