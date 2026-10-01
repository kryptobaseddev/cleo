/**
 * The cloud vault manifest over real temp SQLite files with real classified
 * table names: what is listed, how the keyed hash behaves, and how
 * `carryMachineState` carries machine-local rows into a staged snapshot.
 *
 * @task T12336
 * @epic T12322
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildVaultManifest,
  carryMachineState,
  compareVaultManifests,
  emptyVaultTableHash,
  isVaultManifestTable,
  sameVaultManifest,
  VAULT_MANIFEST_SCHEMA_VERSION,
  vaultDatabaseKey,
  vaultFilesEntry,
  vaultLocalColumns,
} from '../vault-manifest.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const KEY = crypto.randomBytes(32);

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-vault-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A project-scope store: `tasks_tasks` (portable-project), `brain_observations`
 * (portable-personal), `tasks_sessions` (portable-personal, credential column),
 * `tasks_agent_credentials` (portable-secret), `_sync_replica` (local-only),
 * and an unclassified table.
 */
function projectDb(
  name: string,
  opts: {
    root?: string;
    narrativeRoot?: string;
    tasks?: Array<[string, string]>;
    token?: string | null;
  } = {},
): string {
  const file = path.join(tmp, `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT, files_json TEXT);
    CREATE TABLE brain_observations (id TEXT PRIMARY KEY, narrative TEXT);
    CREATE TABLE tasks_sessions (id TEXT PRIMARY KEY, owner_auth_token TEXT);
    CREATE TABLE tasks_agent_credentials (id TEXT PRIMARY KEY, api_key_encrypted TEXT);
    CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, device_id TEXT);
    CREATE TABLE zz_not_classified (id TEXT);
  `);
  const root = opts.root ?? '/a/root';
  const ins = db.prepare('INSERT INTO tasks_tasks VALUES (?, ?, ?, ?)');
  for (const [id, title] of opts.tasks ?? [
    ['T1', 'one'],
    ['T2', 'two'],
  ])
    ins.run(
      id,
      title,
      `${root}/src/${id}.ts`,
      JSON.stringify({ path: `${root}/docs/${id}.md`, note: 'n' }),
    );
  db.prepare('INSERT INTO brain_observations VALUES (?, ?)').run(
    'O1',
    `edited ${opts.narrativeRoot ?? root}/src/x.ts`,
  );
  db.prepare('INSERT INTO tasks_sessions VALUES (?, ?)').run('S1', opts.token ?? null);
  db.prepare('INSERT INTO tasks_agent_credentials VALUES (?, ?)').run('C1', 'secret');
  db.prepare('INSERT INTO _sync_replica VALUES (?, ?)').run(`r-${name}`, `d-${name}`);
  db.prepare('INSERT INTO zz_not_classified VALUES (?)').run('x');
  db.close();
  return file;
}

const build = (file: string, root: string | null = '/a/root', key: Uint8Array = KEY) =>
  buildVaultManifest(file, { scope: 'project', hashKey: key, root });

describe('isVaultManifestTable', () => {
  it('lists syncing non-secret tables only', () => {
    expect(isVaultManifestTable('project', 'tasks_tasks')).toBe(true);
    expect(isVaultManifestTable('project', 'brain_observations')).toBe(true);
    expect(isVaultManifestTable('project', 'tasks_agent_credentials')).toBe(false);
    expect(isVaultManifestTable('project', '_sync_replica')).toBe(false);
    expect(isVaultManifestTable('project', 'zz_not_classified')).toBe(false);
    expect(isVaultManifestTable('global', 'nexus_project_registry')).toBe(true);
    expect(isVaultManifestTable('global', 'accounts')).toBe(false);
    expect(isVaultManifestTable('global', '_sync_replica')).toBe(false);
  });
});

describe('buildVaultManifest', () => {
  it('lists only syncing non-secret tables, with row counts', () => {
    const { manifest, skipped } = build(projectDb('a'));
    expect(manifest.schemaVersion).toBe(VAULT_MANIFEST_SCHEMA_VERSION);
    expect(Object.keys(manifest.tables).sort()).toEqual([
      'brain_observations',
      'tasks_sessions',
      'tasks_tasks',
    ]);
    expect(manifest.tables['tasks_tasks']?.rows).toBe(2);
    expect(manifest.tables['tasks_tasks']?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(skipped).toEqual([]);
  });

  it('is independent of row insertion order', () => {
    const a = build(
      projectDb('a', {
        tasks: [
          ['T1', 'one'],
          ['T2', 'two'],
          ['T3', 'three'],
        ],
      }),
    );
    const b = build(
      projectDb('b', {
        tasks: [
          ['T3', 'three'],
          ['T1', 'one'],
          ['T2', 'two'],
        ],
      }),
    );
    expect(a.manifest.tables['tasks_tasks']).toEqual(b.manifest.tables['tasks_tasks']);
    expect(sameVaultManifest(a.manifest, b.manifest)).toBe(true);
  });

  it('changes with the key and with the content', () => {
    const file = projectDb('a');
    const base = build(file).manifest;
    const otherKey = build(file, '/a/root', crypto.randomBytes(32)).manifest;
    expect(otherKey.tables['tasks_tasks']?.rows).toBe(2);
    expect(otherKey.tables['tasks_tasks']?.hash).not.toBe(base.tables['tasks_tasks']?.hash);

    const changed = build(
      projectDb('b', {
        tasks: [
          ['T1', 'one'],
          ['T2', 'TWO'],
        ],
      }),
    ).manifest;
    expect(changed.tables['tasks_tasks']?.rows).toBe(2);
    expect(changed.tables['tasks_tasks']?.hash).not.toBe(base.tables['tasks_tasks']?.hash);
    expect(changed.tables['brain_observations']).toEqual(base.tables['brain_observations']);
  });

  it('hashes relocatable cells as relocated, so a relocated store hashes as its source', () => {
    const a = build(projectDb('a', { root: '/a/root' }), '/a/root').manifest;
    // What a restore to /b/root leaves: locators rewritten, history (the narrative) as written.
    const b = build(
      projectDb('b', { root: '/b/root', narrativeRoot: '/a/root' }),
      '/b/root/',
    ).manifest;
    expect(sameVaultManifest(a, b)).toBe(true);
    // Without a root nothing is re-rooted, so the locators differ.
    const raw = build(projectDb('c', { root: '/b/root', narrativeRoot: '/a/root' }), null).manifest;
    expect(raw.tables['tasks_tasks']?.hash).not.toBe(a.tables['tasks_tasks']?.hash);
    // History is hashed as written: a narrative naming another root is different content.
    const rewritten = build(projectDb('d', { root: '/b/root' }), '/b/root').manifest;
    expect(rewritten.tables['tasks_tasks']).toEqual(a.tables['tasks_tasks']);
    expect(rewritten.tables['brain_observations']?.hash).not.toBe(
      a.tables['brain_observations']?.hash,
    );
  });

  it('reads integers past 2^53 without throwing, and hashes them exactly', () => {
    const big = (n: bigint) => {
      const file = projectDb(`big${n}`);
      const db = new DatabaseSync(file);
      db.exec('ALTER TABLE tasks_tasks ADD COLUMN born INTEGER');
      db.prepare("UPDATE tasks_tasks SET born = ? WHERE id = 'T1'").run(n);
      db.close();
      return build(file).manifest.tables['tasks_tasks']?.hash;
    };
    expect(big(1790866045380296367n)).not.toBe(big(1790866045380296368n));
  });

  it('hashes credential columns as cleared, so an unencrypted bundle matches its live store', () => {
    const live = build(projectDb('a', { token: 'OWNER-TOKEN' })).manifest;
    const redacted = build(projectDb('b', { token: null })).manifest;
    expect(redacted.tables['tasks_sessions']).toEqual(live.tables['tasks_sessions']);
  });
});

describe('compareVaultManifests / sameVaultManifest', () => {
  it('compares table by table over the union of both sides', () => {
    const a = build(projectDb('a')).manifest;
    const b = build(
      projectDb('b', {
        tasks: [
          ['T1', 'one'],
          ['T2', 'two'],
          ['T9', 'nine'],
        ],
      }),
    ).manifest;
    const extra = {
      tables: { ...b.tables, tasks_extra: { rows: 1, hash: 'f'.repeat(64) } },
    };
    const diff = compareVaultManifests(a, extra);
    expect(diff.map((d) => d.table)).toEqual([
      'brain_observations',
      'tasks_extra',
      'tasks_sessions',
      'tasks_tasks',
    ]);
    expect(diff.find((d) => d.table === 'tasks_tasks')).toEqual({
      table: 'tasks_tasks',
      localRows: 2,
      cloudRows: 3,
      match: false,
    });
    expect(diff.find((d) => d.table === 'tasks_extra')).toEqual({
      table: 'tasks_extra',
      localRows: null,
      cloudRows: 1,
      match: false,
    });
    expect(diff.find((d) => d.table === 'brain_observations')?.match).toBe(true);
    expect(sameVaultManifest(a, a)).toBe(true);
    expect(sameVaultManifest(a, b)).toBe(false);
    expect(sameVaultManifest(a, { tables: {} })).toBe(false);
  });
});

describe('emptyVaultTableHash', () => {
  it('equals the hash of a listed table with no rows', () => {
    const file = projectDb('a', { tasks: [] });
    const { manifest } = build(file);
    expect(manifest.tables['tasks_tasks']).toEqual({
      rows: 0,
      hash: emptyVaultTableHash(KEY, 'tasks_tasks'),
    });
    expect(emptyVaultTableHash(crypto.randomBytes(32), 'tasks_tasks')).not.toBe(
      manifest.tables['tasks_tasks']?.hash,
    );
  });
});

describe('carryMachineState', () => {
  const rows = (file: string, sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };

  it('carries local-only rows into the staged copy and leaves syncing rows alone', () => {
    const staged = projectDb('staged', {
      tasks: [
        ['T1', 'snapshot'],
        ['T5', 'snapshot five'],
      ],
    });
    const live = projectDb('live', { tasks: [['T1', 'live']] });
    const out = carryMachineState(staged, live, 'project');
    expect(out.preserved).toEqual(['_sync_replica']);
    expect(out.skipped).toEqual([]);
    expect(rows(staged, 'SELECT * FROM _sync_replica')).toEqual([
      { replica_id: 'r-live', device_id: 'd-live' },
    ]);
    expect(rows(staged, 'SELECT id, title FROM tasks_tasks ORDER BY id')).toEqual([
      { id: 'T1', title: 'snapshot' },
      { id: 'T5', title: 'snapshot five' },
    ]);
    // The live store is read only.
    expect(rows(live, 'SELECT * FROM _sync_replica')).toEqual([
      { replica_id: 'r-live', device_id: 'd-live' },
    ]);
  });

  it('carries rows holding integers past 2^53', () => {
    const staged = projectDb('staged');
    const live = projectDb('live');
    const ldb = new DatabaseSync(live);
    ldb.exec('DROP TABLE _sync_replica');
    ldb.exec('CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, device_id INTEGER)');
    ldb.prepare('INSERT INTO _sync_replica VALUES (?, ?)').run('r', 1790866045380296367n);
    ldb.close();
    const sdb = new DatabaseSync(staged);
    sdb.exec('DROP TABLE _sync_replica');
    sdb.exec('CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, device_id INTEGER)');
    sdb.close();
    expect(carryMachineState(staged, live, 'project').preserved).toEqual(['_sync_replica']);
    const db = new DatabaseSync(staged, { readOnly: true });
    const select = db.prepare('SELECT device_id FROM _sync_replica');
    select.setReadBigInts(true);
    expect(select.all()).toEqual([{ device_id: 1790866045380296367n }]);
    db.close();
  });

  it('empties a local-only table absent here, and skips one shaped differently', () => {
    const staged = projectDb('staged');
    const sdb = new DatabaseSync(staged);
    sdb.exec(`CREATE TABLE _sync_clock (k TEXT PRIMARY KEY, v INTEGER);
      INSERT INTO _sync_clock VALUES ('snap', 1);`);
    sdb.close();
    const live = projectDb('live');
    const ldb = new DatabaseSync(live);
    ldb.exec('DROP TABLE _sync_replica');
    ldb.exec(`CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, device_id TEXT, extra TEXT);
      INSERT INTO _sync_replica VALUES ('r-live', 'd-live', 'x');`);
    ldb.close();
    const out = carryMachineState(staged, live, 'project');
    // Machine state never comes from another machine: absent here means empty here.
    expect(out.preserved).toEqual(['_sync_clock']);
    expect(rows(staged, 'SELECT * FROM _sync_clock')).toEqual([]);
    expect(out.skipped).toEqual(['_sync_replica']);
    expect(rows(staged, 'SELECT * FROM _sync_replica')).toEqual([
      { replica_id: 'r-staged', device_id: 'd-staged' },
    ]);
  });

  it('empties a local-only table the live store holds no rows in', () => {
    const staged = projectDb('staged');
    const live = projectDb('live');
    const ldb = new DatabaseSync(live);
    ldb.exec('DELETE FROM _sync_replica');
    ldb.close();
    const out = carryMachineState(staged, live, 'project');
    expect(out.preserved).toEqual(['_sync_replica']);
    expect(rows(staged, 'SELECT * FROM _sync_replica')).toEqual([]);
  });

  it('carries credential cells and portable-secret rows from live rows by primary key (T12966)', () => {
    // The snapshot: credentials cleared, as an unencrypted bundle carries them.
    const staged = projectDb('staged', { token: null });
    const sdb = new DatabaseSync(staged);
    sdb.exec(`UPDATE tasks_agent_credentials SET api_key_encrypted = NULL;
      INSERT INTO tasks_sessions VALUES ('S2', NULL);
      INSERT INTO tasks_agent_credentials VALUES ('C2', NULL);`);
    sdb.close();
    const live = projectDb('live', { token: 'LIVE-TOKEN' });
    const ldb = new DatabaseSync(live);
    ldb.exec(`UPDATE tasks_agent_credentials SET api_key_encrypted = 'K1';
      INSERT INTO tasks_sessions VALUES ('S3', 'GONE-TOKEN');
      INSERT INTO tasks_agent_credentials VALUES ('C3', 'K3');`);
    ldb.close();
    const out = carryMachineState(staged, live, 'project');
    expect(rows(staged, 'SELECT id, owner_auth_token FROM tasks_sessions ORDER BY id')).toEqual([
      { id: 'S1', owner_auth_token: 'LIVE-TOKEN' },
      { id: 'S2', owner_auth_token: null },
    ]);
    // A secret row this machine holds and the snapshot lacks is kept.
    expect(
      rows(staged, 'SELECT id, api_key_encrypted FROM tasks_agent_credentials ORDER BY id'),
    ).toEqual([
      { id: 'C1', api_key_encrypted: 'K1' },
      { id: 'C2', api_key_encrypted: null },
      { id: 'C3', api_key_encrypted: 'K3' },
    ]);
    expect(out.carried).toEqual(
      expect.arrayContaining([
        { table: 'tasks_sessions', columns: ['owner_auth_token'], rows: 1 },
        { table: 'tasks_agent_credentials', columns: ['api_key_encrypted'], rows: 2 },
      ]),
    );
    // S3's token has no row to go to in the snapshot: reported with its remedy.
    expect(out.lost).toEqual([
      {
        table: 'tasks_sessions',
        rows: 1,
        remedy: expect.stringContaining('cleo session start'),
      },
    ]);
  });

  it('reports credentials of a table it cannot match by key', () => {
    const staged = projectDb('staged', { token: null });
    const live = projectDb('live', { token: 'LIVE-TOKEN' });
    for (const f of [staged, live]) {
      const db = new DatabaseSync(f);
      db.exec(
        `DROP TABLE tasks_sessions; CREATE TABLE tasks_sessions (id TEXT, owner_auth_token TEXT);`,
      );
      db.prepare('INSERT INTO tasks_sessions VALUES (?, ?)').run(
        'S1',
        f === live ? 'LIVE-TOKEN' : null,
      );
      db.close();
    }
    const out = carryMachineState(staged, live, 'project');
    expect(out.skipped).toContain('tasks_sessions');
    expect(out.lost.map((l) => l.table)).toEqual(['tasks_sessions']);
  });
});

describe('column-level local-only cells (T12967)', () => {
  function registryDb(name: string, rowsIn: Array<[string, string, string]>): string {
    const file = path.join(tmp, `${name}.db`);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE nexus_project_registry (project_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL,
      project_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, brain_db_path TEXT)`);
    const ins = db.prepare('INSERT INTO nexus_project_registry VALUES (?, ?, ?, ?, ?)');
    for (const [id, p, n] of rowsIn) ins.run(id, `hash:${p}`, p, n, `${p}/.cleo/brain.db`);
    db.close();
    return file;
  }
  const hashOf = (file: string) =>
    buildVaultManifest(file, { scope: 'global', hashKey: KEY, root: null }).manifest.tables[
      'nexus_project_registry'
    ];

  it('lists the registry columns that never sync', () => {
    expect(vaultLocalColumns('global', 'nexus_project_registry')).toEqual(
      expect.arrayContaining(['project_path', 'project_hash', 'brain_db_path', 'tasks_db_path']),
    );
    expect(vaultLocalColumns('global', 'nexus_project_registry')).not.toContain('name');
    expect(vaultLocalColumns('project', 'tasks_sessions')).toEqual(['owner_auth_token']);
  });

  it('hashes them as NULL: machines that differ only in paths match', () => {
    const a = hashOf(registryDb('a', [['p1', '/a/p1', 'one']]));
    const b = hashOf(registryDb('b', [['p1', '/b/p1', 'one']]));
    const renamed = hashOf(registryDb('c', [['p1', '/a/p1', 'ONE']]));
    expect(b).toEqual(a);
    expect(renamed?.hash).not.toBe(a?.hash);
  });

  it("restore keeps this machine's values for them, by primary key", () => {
    const staged = registryDb('staged', [
      ['p1', '/a/p1', 'one'],
      ['p2', '/a/p2', 'two'],
    ]);
    const live = registryDb('live', [['p1', '/b/p1', 'one (old name)']]);
    const out = carryMachineState(staged, live, 'global');
    const db = new DatabaseSync(staged, { readOnly: true });
    const got = db
      .prepare(
        'SELECT project_id, project_path, project_hash, brain_db_path, name FROM nexus_project_registry ORDER BY 1',
      )
      .all();
    db.close();
    expect(got).toEqual([
      {
        project_id: 'p1',
        project_path: '/b/p1',
        project_hash: 'hash:/b/p1',
        brain_db_path: '/b/p1/.cleo/brain.db',
        name: 'one',
      },
      {
        project_id: 'p2',
        project_path: '/a/p2',
        project_hash: 'hash:/a/p2',
        brain_db_path: '/a/p2/.cleo/brain.db',
        name: 'two',
      },
    ]);
    expect(out.carried.map((c) => c.table)).toEqual(['nexus_project_registry']);
    expect(out.lost).toEqual([]);
  });
});

describe('pseudo-table entries (T12969)', () => {
  it('keys other databases with names the wire contract accepts', () => {
    expect(vaultDatabaseKey('blobs/manifest.db')).toBe('zz_vault_db_blobs_manifest_db');
    expect(vaultDatabaseKey('attachments/index.db')).toBe('zz_vault_db_attachments_index_db');
    const long = vaultDatabaseKey(`${'deep/'.repeat(20)}x.db`);
    expect(long).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
  });

  it('hashes the file inventory by path and content, independent of order', () => {
    const a = vaultFilesEntry(
      [
        { relPath: 'adrs/1.md', sha256: 'a'.repeat(64) },
        { relPath: 'notes/x.md', sha256: 'b'.repeat(64) },
      ],
      KEY,
    );
    const b = vaultFilesEntry(
      [
        { relPath: 'notes/x.md', sha256: 'b'.repeat(64) },
        { relPath: 'adrs/1.md', sha256: 'a'.repeat(64) },
      ],
      KEY,
    );
    const edited = vaultFilesEntry(
      [
        { relPath: 'adrs/1.md', sha256: 'c'.repeat(64) },
        { relPath: 'notes/x.md', sha256: 'b'.repeat(64) },
      ],
      KEY,
    );
    expect(a).toEqual(b);
    expect(a.rows).toBe(2);
    expect(edited.rows).toBe(2);
    expect(edited.hash).not.toBe(a.hash);
  });
});
