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

import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';

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
  delete process.env.CLEO_ROW_UID_FILL;
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-row-identity-heal-T12878-')));
  dbPath = join(testDir, '.cleo', 'cleo.db');
});

afterEach(() => {
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
    expect(db.prepare('SELECT count(*) AS n FROM tasks_row_identity_meta').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual(
      journalBefore,
    );
    // No per-connection uid triggers: the fill stays opt-in.
    expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'trg_row_uid_%'")
        .get(),
    ).toEqual({ n: 0 });
    const schemaAfterFirst = schemaText(db);
    const hashAfterFirst = contentHash(db, dataTablesOf(db));

    // A second open changes nothing: schema and content are identical.
    const again = await openProject();
    expect(schemaText(again)).toBe(schemaAfterFirst);
    expect(contentHash(again, dataTablesOf(again))).toEqual(hashAfterFirst);
  });

  it('a store that already has the full schema is left exactly as it is', async () => {
    const db = await openProject();
    const schema = schemaText(db);
    const again = await openProject();
    expect(schemaText(again)).toBe(schema);
  });
});
