/**
 * `INSERT OR REPLACE` on an FK parent cascades into its children (T12787).
 *
 * REPLACE resolves a uniqueness conflict by DELETING the existing row and then
 * inserting the new one. With `foreign_keys=ON`, SQLite runs the ON DELETE
 * action of every foreign key referencing the deleted row — `CASCADE` deletes
 * the children, `SET NULL` detaches them — even though a row with the same key
 * is back a moment later, and even with `recursive_triggers` off. An UPSERT
 * (`INSERT … ON CONFLICT … DO UPDATE`) updates the row in place and fires no
 * delete action. This suite pins that SQLite behaviour and proves each
 * converted writer keeps the children.
 *
 * @task T12787
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Single numeric column of a one-row query. */
function num(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, number> | undefined;
  return Number(row === undefined ? 0 : Object.values(row)[0]);
}

describe('SQLite: REPLACE on an FK parent runs the ON DELETE action (T12787)', () => {
  const setup = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA recursive_triggers = OFF;
      CREATE TABLE parent (id TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE cascade_child (id TEXT PRIMARY KEY,
        pid TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
      CREATE TABLE setnull_child (id TEXT PRIMARY KEY,
        pid TEXT REFERENCES parent(id) ON DELETE SET NULL);
      INSERT INTO parent VALUES ('a', 'old');
      INSERT INTO cascade_child VALUES ('c1', 'a'), ('c2', 'a');
      INSERT INTO setnull_child VALUES ('n1', 'a');
    `);
    return db;
  };

  it('INSERT OR REPLACE with the SAME key deletes CASCADE children and nulls SET NULL ones', () => {
    const db = setup();
    db.exec("INSERT OR REPLACE INTO parent (id, v) VALUES ('a', 'new')");
    expect(db.prepare("SELECT v FROM parent WHERE id = 'a'").get()).toEqual({ v: 'new' });
    expect(num(db, 'SELECT COUNT(*) FROM cascade_child')).toBe(0);
    expect(num(db, 'SELECT COUNT(*) FROM setnull_child WHERE pid IS NULL')).toBe(1);
    db.close();
  });

  it('REPLACE INTO behaves identically', () => {
    const db = setup();
    db.exec("REPLACE INTO parent (id, v) VALUES ('a', 'new')");
    expect(num(db, 'SELECT COUNT(*) FROM cascade_child')).toBe(0);
    db.close();
  });

  it('an UPSERT updates in place: children survive, values updated', () => {
    const db = setup();
    db.exec(
      "INSERT INTO parent (id, v) VALUES ('a', 'new') ON CONFLICT(id) DO UPDATE SET v = excluded.v",
    );
    expect(db.prepare("SELECT v FROM parent WHERE id = 'a'").get()).toEqual({ v: 'new' });
    expect(num(db, "SELECT COUNT(*) FROM cascade_child WHERE pid = 'a'")).toBe(2);
    expect(num(db, "SELECT COUNT(*) FROM setnull_child WHERE pid = 'a'")).toBe(1);
    db.close();
  });

  it('an INSERT … SELECT UPSERT needs `WHERE true` and keeps the children too', () => {
    const db = setup();
    db.exec("CREATE TABLE src (id TEXT, v TEXT); INSERT INTO src VALUES ('a', 'new')");
    db.exec(
      'INSERT INTO parent (id, v) SELECT id, v FROM src WHERE true ' +
        'ON CONFLICT DO UPDATE SET id = excluded.id, v = excluded.v',
    );
    expect(db.prepare("SELECT v FROM parent WHERE id = 'a'").get()).toEqual({ v: 'new' });
    expect(num(db, 'SELECT COUNT(*) FROM cascade_child')).toBe(2);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// legacy-tasks-lineage carry-forward (INSERT … SELECT)
// ---------------------------------------------------------------------------

describe('legacy lineage carry-forward keeps children and lets snapshot rows win (T12787)', () => {
  let root: string;
  let dbPath: string;
  let migrations: string;

  /** A two-migration lineage: FK parent + CASCADE child + a secondary UNIQUE, with seeded rows. */
  const LINEAGE = [
    [
      '20260101000000_init',
      [
        'CREATE TABLE `p` (`id` TEXT PRIMARY KEY NOT NULL, `v` TEXT NOT NULL);',
        'CREATE TABLE `c` (`id` TEXT PRIMARY KEY NOT NULL, `pid` TEXT NOT NULL REFERENCES `p`(`id`) ON DELETE CASCADE);',
        'CREATE TABLE `u` (`id` TEXT PRIMARY KEY NOT NULL, `k` TEXT NOT NULL UNIQUE, `v` TEXT NOT NULL);',
      ].join('\n--> statement-breakpoint\n'),
    ],
    [
      '20260102000000_seed',
      [
        "INSERT INTO `p` (`id`, `v`) VALUES ('a', 'seeded');",
        "INSERT INTO `c` (`id`, `pid`) VALUES ('seed-child', 'a');",
        "INSERT INTO `u` (`id`, `k`, `v`) VALUES ('s1', 'k1', 'seeded');",
      ].join('\n--> statement-breakpoint\n'),
    ],
  ] as const;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-t12787-lineage-'));
    migrations = join(root, 'migrations');
    for (const [name, sql] of LINEAGE) {
      mkdirSync(join(migrations, name), { recursive: true });
      writeFileSync(join(migrations, name, 'migration.sql'), sql);
    }
    dbPath = join(root, 'cleo.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)',
    );
    for (const [, sql] of LINEAGE) {
      for (const stmt of sql.split('--> statement-breakpoint')) db.exec(stmt);
    }
    // This database's own history diverged from the seeds: the snapshot holds it.
    db.exec(`
      UPDATE p SET v = 'history' WHERE id = 'a';
      INSERT INTO c (id, pid) VALUES ('hist-child', 'a');
      DELETE FROM c WHERE id = 'seed-child';
      DELETE FROM u WHERE id = 's1';
      INSERT INTO u (id, k, v) VALUES ('x1', 'k1', 'history');
    `);
    db.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('snapshot rows replace same-key seeded rows (PK and secondary UNIQUE) without dropping children', async () => {
    const { rebuildLegacyTasksLineage } = await import('../legacy-tasks-lineage.js');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const result = rebuildLegacyTasksLineage(db, dbPath, migrations, []);
      expect(result.migrationsApplied).toBe(2);

      // Parent: the snapshot row won over the seeded one, updated in place.
      expect(db.prepare("SELECT v FROM p WHERE id = 'a'").get()).toEqual({ v: 'history' });
      // Children: the seeded child (never in the snapshot) and the carried one both survive.
      expect(
        (db.prepare('SELECT id FROM c ORDER BY id').all() as Array<{ id: string }>).map(
          (r) => r.id,
        ),
      ).toEqual(['hist-child', 'seed-child']);
      // Secondary UNIQUE: the snapshot row replaced the seeded row colliding on `k`.
      expect(db.prepare('SELECT id, k, v FROM u').all()).toEqual([
        { id: 'x1', k: 'k1', v: 'history' },
      ]);
      expect(num(db, 'PRAGMA foreign_keys')).toBe(1);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// _agent_registry_meta sentinel (the write swallows errors, so prove it lands)
// ---------------------------------------------------------------------------

describe('_agent_registry_meta schema_version sentinel is an UPSERT (T12787)', () => {
  let base: string;
  let cleoHome: string;

  beforeEach(() => {
    vi.resetModules();
    base = mkdtempSync(join(tmpdir(), 'cleo-t12787-agentmeta-'));
    cleoHome = join(base, 'cleo-home');
    mkdirSync(cleoHome, { recursive: true });
    writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
    writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });
    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return { ...actual, getCleoHome: () => cleoHome };
    });
  });

  afterEach(async () => {
    const { _resetGlobalAgentRegistryDb_TESTING_ONLY } = await import('../agent-registry-store.js');
    _resetGlobalAgentRegistryDb_TESTING_ONLY();
    vi.doUnmock('../../paths.js');
    rmSync(base, { recursive: true, force: true });
  });

  it('rewrites a stale sentinel in place, one row', async () => {
    const {
      ensureGlobalAgentRegistryDb,
      _resetGlobalAgentRegistryDb_TESTING_ONLY,
      GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION,
    } = await import('../agent-registry-store.js');
    _resetGlobalAgentRegistryDb_TESTING_ONLY();
    await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const dbPath = join(cleoHome, 'cleo.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE _agent_registry_meta SET value = 'stale' WHERE key = 'schema_version'");
    raw.close();

    await ensureGlobalAgentRegistryDb();
    _resetGlobalAgentRegistryDb_TESTING_ONLY();

    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(check.prepare('SELECT key, value FROM _agent_registry_meta').all()).toEqual([
        { key: 'schema_version', value: GLOBAL_AGENT_REGISTRY_SCHEMA_VERSION },
      ]);
    } finally {
      check.close();
    }
  });
});
