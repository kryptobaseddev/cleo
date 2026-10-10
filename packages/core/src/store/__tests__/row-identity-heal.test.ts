/**
 * The row-identity schema is healed on every open, whatever the fill flag
 * (T12878; T12341 spec §12.2).
 *
 * 9.25 journaled the uid migration on live cleocode without running it
 * (journal Scenario 3 Case A: the columns and indexes a pre-release build had
 * added made the probe mark it applied). The store was left without four
 * identity tables, the graveyard trigger and two alias columns, with stale
 * pre-release uid values in place. This fixture recreates exactly that state
 * with the fill flag OFF and checks that an open restores the full schema,
 * changes no row value, and that a second open does nothing.
 *
 * @task T12878
 * @epic T12323
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rowIdentityDoctorCheck } from '../../doctor/row-identity.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import {
  healRowIdentitySchema,
  missingRowIdentitySchema,
  prepareRowIdentity,
  readRowIdentityHealHistory,
  readRowIdentityHealReceipt,
} from '../row-identity.js';
import { setSyncFlag } from '../sync/flags.js';
import { verifyOwnedTriggers } from '../sync/trigger-classes.js';
import { setWorktreeBuildGuardForTests } from '../worktree-build-guard.js';

const SYNC_SCHEMA_ROOT = join(import.meta.dirname, '../../../migrations/sync-journal');

const UID_MIGRATION = '20260928120000_t12341-row-uids';
const MISSING_TABLES = [
  'tasks_uid_aliases',
  'tasks_ac_uid_graveyard',
  'tasks_row_identity_meta',
  'tasks_identity_quarantine',
];

let testDir: string;
let dbPath: string;

beforeEach(() => {
  // Row uids off (the kill switch; on by default since T13305): the heal runs anyway.
  process.env.CLEO_ROW_UID_FILL = '0';
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-row-identity-heal-T12878-')));
  dbPath = join(testDir, '.cleo', 'cleo.db');
});

afterEach(() => {
  setWorktreeBuildGuardForTests(null);
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openProject(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  return getDualScopeNativeDb(await openDualScopeDbAtPath('project', dbPath));
}

const names = (db: DatabaseSync, type: string) =>
  (
    db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as {
      name: string;
    }[]
  ).map((r) => r.name);

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(
    (c) => c.name,
  );

/**
 * Tables an open itself writes whatever this change does: the writer lease
 * bookkeeping of the cold-open lease. Not row data.
 */
const OPEN_BOOKKEEPING = new Set(['_writer_leases', '_writer_queue']);

/** The data tables: every table but SQLite's own and the open's bookkeeping. */
const dataTablesOf = (db: DatabaseSync) =>
  names(db, 'table').filter((t) => !t.startsWith('sqlite_') && !OPEN_BOOKKEEPING.has(t));

/** A content hash of every row of each given table (all columns, rowid order). */
function contentHash(db: DatabaseSync, tables: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const h = createHash('sha256');
    for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()) {
      h.update(JSON.stringify(row));
    }
    out[table] = h.digest('hex');
  }
  return out;
}

/** The schema text (every object's CREATE statement). */
const schemaText = (db: DatabaseSync) =>
  JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());

/** Put the store in the live-cleocode state after 9.25 (flag off). */
function simulateStampedMigration(): void {
  const raw = new DatabaseSync(dbPath);
  try {
    // Rows a pre-release build filled: stale uid and fingerprint values.
    raw.exec(`INSERT INTO tasks_tasks (id, title, status, priority, type, created_at, uid, birth_fp)
        VALUES ('T001', 'Epic', 'pending', 'medium', 'epic', '2026-09-20T09:00:00.000Z',
                '0192d0c0-0000-7000-8000-00000000000a', 'prerelease-fp-a'),
               ('T002', 'Task', 'pending', 'medium', 'task', '2026-09-20T09:01:00.000Z',
                '0192d0c0-0000-7000-8000-00000000000b', 'prerelease-fp-b'),
               ('T003', 'Written since', 'pending', 'medium', 'task', '2026-09-30 12:00:00', NULL, NULL);
      INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key, uid, birth_fp)
        VALUES ('ac-1', 'T002', 1, 'tests pass', 'text', 'text:1:x',
                '0192d0c0-0000-7000-8000-0000000000c1', 'prerelease-fp-c');
      INSERT INTO tasks_task_labels (task_id, label, uid) VALUES ('T002', 'bug', 'stale-label-uid');`);
    // The early alias table and the missing tables / trigger.
    raw.exec(`DROP TRIGGER IF EXISTS trg_tasks_ac_uid_graveyard;
      ${MISSING_TABLES.map((t) => `DROP TABLE ${t};`).join('\n')}
      ALTER TABLE tasks_display_id_aliases DROP COLUMN displaced_hlc;
      ALTER TABLE tasks_display_id_aliases DROP COLUMN entity_birth_fp;`);
    expect(
      raw
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE name = ?')
        .get(UID_MIGRATION),
      'the uid migration stays journaled (stamped)',
    ).toEqual({ n: 1 });
  } finally {
    raw.close();
  }
}

describe('row-identity schema heal on every open (T12878)', () => {
  it('restores the full schema with the flag off, changes no row value, and is a no-op the second time', async () => {
    (await openProject()).exec('SELECT 1');
    _resetDualScopeDbCache();
    simulateStampedMigration();

    const before = new DatabaseSync(dbPath, { readOnly: true });
    const dataTables = dataTablesOf(before);
    const hashBefore = contentHash(before, dataTables);
    const journalBefore = before.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get();
    for (const t of MISSING_TABLES) expect(names(before, 'table')).not.toContain(t);
    before.close();

    const db = await openProject();
    for (const t of MISSING_TABLES) expect(names(db, 'table'), t).toContain(t);
    expect(names(db, 'trigger')).toContain('trg_tasks_ac_uid_graveyard');
    expect(columns(db, 'tasks_display_id_aliases')).toEqual(
      expect.arrayContaining(['displaced_hlc', 'entity_birth_fp']),
    );
    // Not one row value changed: the stale identity values are still there
    // (re-deriving them is the opt-in refill's job).
    expect(contentHash(db, dataTables)).toEqual(hashBefore);
    expect(db.prepare("SELECT uid, birth_fp FROM tasks_tasks WHERE id = 'T001'").get()).toEqual({
      uid: '0192d0c0-0000-7000-8000-00000000000a',
      birth_fp: 'prerelease-fp-a',
    });
    expect(db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T003'").get()).toEqual({
      uid: null,
    });
    // The only meta row is the heal's own receipt: no recipe marker (no fill).
    expect(db.prepare('SELECT key FROM tasks_row_identity_meta').all()).toEqual([
      { key: 'row_identity_schema_healed' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual(
      journalBefore,
    );
    // No per-connection uid triggers: the fill stays opt-in.
    expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'trg_row_uid_%'")
        .get(),
    ).toEqual({ n: 0 });
    // The heal is recorded, and `cleo doctor` shows it.
    const receipt = readRowIdentityHealReceipt(db);
    expect(receipt?.objects).toEqual(
      expect.arrayContaining([
        'table tasks_uid_aliases',
        'table tasks_ac_uid_graveyard',
        'table tasks_row_identity_meta',
        'table tasks_identity_quarantine',
        'tasks_display_id_aliases.displaced_hlc',
        'tasks_display_id_aliases.entity_birth_fp',
      ]),
    );
    expect(missingRowIdentitySchema(db)).toEqual([]);
    process.env.CLEO_DIR = join(testDir, '.cleo');
    let doctor: ReturnType<typeof rowIdentityDoctorCheck>;
    try {
      doctor = rowIdentityDoctorCheck(testDir);
    } finally {
      delete process.env.CLEO_DIR;
    }
    expect(doctor.status).toBe('ok');
    expect(doctor.message).toContain('identity schema healed on');
    const schemaAfterFirst = schemaText(db);
    const hashAfterFirst = contentHash(db, dataTablesOf(db));

    // A second open changes nothing: schema and content are identical.
    const again = await openProject();
    expect(schemaText(again)).toBe(schemaAfterFirst);
    expect(contentHash(again, dataTablesOf(again))).toEqual(hashAfterFirst);
  });

  it('with sync capture on, the heal runs inside the schema pass before capture is installed (T12343 S2 order)', async () => {
    (await openProject()).exec('SELECT 1');
    _resetDualScopeDbCache();
    simulateStampedMigration();
    // A captured table also lost its identity columns (and their indexes), so
    // capture installed BEFORE the heal would be built without them.
    const raw = new DatabaseSync(dbPath);
    try {
      for (const { name } of raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks_task_labels' AND sql LIKE '%uid%'",
        )
        .all() as { name: string }[]) {
        raw.exec(`DROP INDEX "${name}"`);
      }
      raw.exec('ALTER TABLE tasks_task_labels DROP COLUMN uid');
      setSyncFlag(raw, 'sync.capture', true, { schemaRoot: SYNC_SCHEMA_ROOT });
    } finally {
      raw.close();
    }

    const db = await openProject();
    expect(missingRowIdentitySchema(db)).toEqual([]);
    expect(columns(db, 'tasks_task_labels')).toContain('uid');
    // Capture saw the healed shape: the re-key trigger exists (it needs uid)
    // and the insert image carries the healed column.
    const capture = names(db, 'trigger').filter((t) =>
      t.startsWith('_sync_cap_tasks_task_labels_'),
    );
    expect(capture).toEqual(
      expect.arrayContaining(['_sync_cap_tasks_task_labels_i', '_sync_cap_tasks_task_labels_k']),
    );
    const insertSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = '_sync_cap_tasks_task_labels_i'")
        .get() as { sql: string }
    ).sql;
    expect(insertSql).toContain('uid');
    // The heal and its receipt were never journaled, and every owned trigger
    // matches its owned DDL after the pass.
    expect(db.prepare('SELECT count(*) AS n FROM _sync_capture').get()).toEqual({ n: 0 });
    expect(verifyOwnedTriggers(db)).toEqual([]);
  });

  it('a worktree-built CLI never heals a store it may not change (T12687 guard)', async () => {
    (await openProject()).exec('SELECT 1');
    _resetDualScopeDbCache();
    simulateStampedMigration();
    // A main checkout holding this store, and a linked worktree holding a build.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-row-identity-heal-guard-')));
    const main = join(repo, 'main');
    mkdirSync(join(main, '.cleo'), { recursive: true });
    writeFileSync(join(main, 'README.md'), 'x\n');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(main, 'init', '-b', 'main');
    git(main, 'add', 'README.md');
    git(
      main,
      '-c',
      'user.email=t@example.test',
      '-c',
      'user.name=T',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'init',
    );
    const worktree = join(repo, 'wt');
    git(main, 'worktree', 'add', '-b', 'build', worktree, 'main');
    const build = join(worktree, 'packages', 'core', 'dist', 'store', 'row-identity.js');
    mkdirSync(join(build, '..'), { recursive: true });
    writeFileSync(build, '');
    const store = join(main, '.cleo', 'cleo.db');
    copyFileSync(dbPath, store);
    try {
      setWorktreeBuildGuardForTests({
        codePath: build,
        provenance: null,
        env: {},
        honourTestSandbox: false,
      });
      const refused = new DatabaseSync(store);
      try {
        expect(healRowIdentitySchema(refused, 'project')).toEqual([]);
        expect(missingRowIdentitySchema(refused)).toContain('table tasks_uid_aliases');
      } finally {
        refused.close();
      }
      // The explicit opt-in (or a released build) heals it.
      setWorktreeBuildGuardForTests({
        codePath: build,
        provenance: null,
        env: { CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1' },
        honourTestSandbox: false,
      });
      const allowed = new DatabaseSync(store);
      try {
        expect(healRowIdentitySchema(allowed, 'project').length).toBeGreaterThan(0);
        expect(missingRowIdentitySchema(allowed)).toEqual([]);
      } finally {
        allowed.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  /** Heal with the flag off, change criteria through a plain connection, then open with the fill on. */
  async function healThenEditThenFill(edit: (raw: DatabaseSync) => void): Promise<DatabaseSync> {
    (await openProject()).exec('SELECT 1');
    _resetDualScopeDbCache();
    simulateStampedMigration();
    await openProject(); // flag off: the heal restores the graveyard trigger
    _resetDualScopeDbCache();
    const raw = new DatabaseSync(dbPath);
    try {
      edit(raw);
      expect(
        raw.prepare('SELECT count(*) AS n FROM tasks_ac_uid_graveyard').get(),
        'the restored trigger recorded the flag-off deletion',
      ).toEqual({ n: 1 });
    } finally {
      raw.close();
    }
    process.env.CLEO_ROW_UID_FILL = '1';
    return openProject();
  }

  it('a criterion deleted and recreated while the flag is off never relinks a stale fingerprint (review F1)', async () => {
    const db = await healThenEditThenFill((raw) => {
      raw.exec(`DELETE FROM tasks_task_acceptance_criteria WHERE id = 'ac-1';
        INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key)
          VALUES ('ac-1', 'T002', 1, 'tests pass', 'text', 'text:1:x');`);
    });
    const row = db
      .prepare("SELECT uid, birth_fp FROM tasks_task_acceptance_criteria WHERE id = 'ac-1'")
      .get() as { uid: string; birth_fp: string };
    expect(row.birth_fp).not.toBe('prerelease-fp-c');
    expect(row.uid).not.toBe('0192d0c0-0000-7000-8000-0000000000c1');
    expect(db.prepare('SELECT count(*) AS n FROM tasks_ac_uid_graveyard').get()).toEqual({ n: 0 });
    // It is exactly what the release recipe derives from scratch.
    const copy = join(testDir, 'copy.db');
    db.exec(`VACUUM INTO '${copy}'`);
    const fresh = new DatabaseSync(copy);
    try {
      fresh.exec(
        "UPDATE tasks_task_acceptance_criteria SET uid = NULL, birth_fp = NULL WHERE id = 'ac-1'",
      );
      prepareRowIdentity(fresh, 'project');
      expect(
        fresh
          .prepare("SELECT uid, birth_fp FROM tasks_task_acceptance_criteria WHERE id = 'ac-1'")
          .get(),
      ).toEqual(row);
    } finally {
      fresh.close();
    }
  });

  it('a flag-off deletion never hands its uid to an unrelated new criterion (review F1, ordinal fallback)', async () => {
    const db = await healThenEditThenFill((raw) => {
      raw.exec(`DELETE FROM tasks_task_acceptance_criteria WHERE id = 'ac-1';
        INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key)
          VALUES ('ac-2', 'T002', 1, 'docs updated', 'text', 'text:1:y');`);
    });
    const row = db
      .prepare("SELECT uid, birth_fp FROM tasks_task_acceptance_criteria WHERE id = 'ac-2'")
      .get() as { uid: string; birth_fp: string };
    expect(row.uid).not.toBe('0192d0c0-0000-7000-8000-0000000000c1');
    expect(row.birth_fp).not.toBe('prerelease-fp-c');
  });

  it('reports a missing uid index, heals it, and keeps every earlier receipt (review F2)', async () => {
    (await openProject()).exec('SELECT 1');
    _resetDualScopeDbCache();
    simulateStampedMigration();
    await openProject();
    _resetDualScopeDbCache();
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('DROP INDEX uq_tasks_tasks_uid');
      expect(missingRowIdentitySchema(raw)).toEqual(['index uq_tasks_tasks_uid']);
    } finally {
      raw.close();
    }
    process.env.CLEO_DIR = join(testDir, '.cleo');
    try {
      const doctor = rowIdentityDoctorCheck(testDir);
      expect(doctor.status).toBe('warning');
      expect(doctor.message).toContain('index uq_tasks_tasks_uid');
    } finally {
      delete process.env.CLEO_DIR;
    }
    const db = await openProject();
    expect(missingRowIdentitySchema(db)).toEqual([]);
    const history = readRowIdentityHealHistory(db);
    expect(history).toHaveLength(2);
    expect(history[1]?.objects).toEqual(['index uq_tasks_tasks_uid']);
    expect(history[0]?.objects).toContain('table tasks_uid_aliases');
  });

  it('the global store declares no identity table: its heal is a no-op', async () => {
    const globalDb = new DatabaseSync(join(testDir, 'global.db'));
    try {
      expect(healRowIdentitySchema(globalDb, 'global')).toEqual([]);
    } finally {
      globalDb.close();
    }
  });

  it('a store that already has the full schema is left exactly as it is', async () => {
    const db = await openProject();
    const schema = schemaText(db);
    const again = await openProject();
    expect(schemaText(again)).toBe(schema);
  });
});
