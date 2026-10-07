/**
 * The repair diff re-checks every row of a suspect table, emits its ops in a
 * `repair` frame, and clears the suspect key only after verification
 * (journal spec §4.4; S3d, T12987).
 *
 * Every store is a temp project `cleo.db` opened through the chokepoint;
 * uncaptured writes run with capture suspended, the way a bracketed rewriter
 * or an older build writes.
 *
 * @task T12987
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { runBracketedMigrations } from '../../migration-runner.js';
import { naturalRowUid } from '../../row-identity.js';
import {
  captureTableDef,
  finishCaptureFrame,
  generateCaptureTriggers,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { syncMigrationHooks } from '../migration-hooks.js';
import {
  BASELINE_KEY_PREFIX,
  baselineRowMeta,
  planRepair,
  repairSuspectTables,
  streamStarted,
} from '../repair.js';
import { rowChash, sealPending } from '../sealer.js';
import { markSuspect } from '../structural.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sync-repair-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  // Written against row uids off; on by default since T13305 (C2). The
  // capture + fill-on interplay (K captures alongside I/U/D) is T13311.
  vi.stubEnv('CLEO_ROW_UID_FILL', '0');
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

let clock = T0;
const opts = { scope: 'project', replica: REPLICA, env: {}, allowUnreleased: true } as const;
const seal = (db: DatabaseSync) => sealPending(db, { ...opts, now: () => ++clock });
const repair = (db: DatabaseSync, extra: { dryRun?: boolean } = {}) =>
  repairSuspectTables(db, { ...opts, now: () => ++clock, ...extra });

function captured(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const addTask = (db: DatabaseSync, id: string) =>
  captured(
    db,
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`,
  );

/** An uncaptured write, as a bracketed rewriter or an older build makes it. */
function uncaptured(db: DatabaseSync, sql: string): void {
  db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')");
  db.exec(sql);
  db.exec('DELETE FROM cleo_trigger_suspend');
}

const n = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

const suspect = (db: DatabaseSync) =>
  (
    db.prepare("SELECT key FROM _sync_meta WHERE key LIKE 'suspect:%'").all() as Array<{
      key: string;
    }>
  ).map((r) => r.key.slice('suspect:'.length));

interface Op {
  t: string;
  u: string;
  o: string;
  k?: Record<string, unknown>;
  a?: Record<string, unknown>;
  b?: Record<string, unknown>;
}

/** The ops of `repair`-via transactions, in order. */
const repairOps = (db: DatabaseSync): Op[] =>
  (
    db
      .prepare(
        `SELECT o.body FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
         WHERE t.via = 'repair' AND t.kind = 'repair' ORDER BY t.local_seq, o.idx`,
      )
      .all() as Array<{ body: string }>
  ).map((r) => JSON.parse(r.body) as Op);

const metaOf = (db: DatabaseSync, tbl: string, uid: string) =>
  db
    .prepare('SELECT chash, deleted, held, version FROM _sync_row_meta WHERE tbl = ? AND uid = ?')
    .get(tbl, uid) as
    | { chash: string | null; deleted: number; held: number; version: number }
    | undefined;

const liveChash = (db: DatabaseSync, uid: string) => {
  const def = captureTableDef(db, 'project', 'tasks_tasks');
  if (!def) throw new Error('fixture: tasks_tasks is not in the sync set');
  return rowChash(db, 'project', def, uid);
};

const ledger = (db: DatabaseSync, tbl: string) =>
  db.prepare('SELECT live, held FROM _sync_ledger WHERE tbl = ?').get(tbl) as
    | { live: number; held: number }
    | undefined;

/** A store whose tasks_tasks row meta is baselined, with T1 and T2 sealed. */
async function baselinedStore(): Promise<DatabaseSync> {
  const db = await store();
  addTask(db, 'T1');
  addTask(db, 'T2');
  seal(db);
  markSuspect(db, 'project', ['tasks_tasks']);
  const r = repair(db);
  expect(r.tables.find((t) => t.table === 'tasks_tasks')?.cleared).toBe(true);
  db.exec("DELETE FROM _sync_meta WHERE key LIKE 'suspect:%'");
  return db;
}

describe('repair diff re-checks every row of a suspect table (T12987)', () => {
  it('rows a migration rewrote while the table was suspect are ALL repaired (T13202)', async () => {
    const db = await baselinedStore();
    addTask(db, 'T3');
    seal(db);
    markSuspect(db, 'project', ['tasks_tasks']);
    // The re-baseline skips a suspect table entirely, so these rows are
    // left for the repair diff, with no capture of their own.
    const lineage = join(dir, 'extra');
    mkdirSync(join(lineage, '20991231000000_backfill'), { recursive: true });
    writeFileSync(
      join(lineage, '20991231000000_backfill', 'migration.sql'),
      'UPDATE `tasks_tasks` SET `title` = upper(`title`)',
    );
    runBracketedMigrations(
      db,
      drizzle({ client: db }),
      [{ folder: lineage }],
      syncMigrationHooks(db, 'project'),
    );
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);

    const r = repair(db);
    const t = r.tables.find((x) => x.table === 'tasks_tasks');
    expect(t?.counts.updates).toBe(3);
    expect(t?.cleared).toBe(true);
    const ops = repairOps(db).filter((o) => o.t === 'tasks_tasks');
    expect(ops.map((o) => `${o.o}:${o.u}`).sort()).toEqual(['U:uid-T1', 'U:uid-T2', 'U:uid-T3']);
    // The full after-image travels; the before-image is unknown, so no `b`.
    const u1 = ops.find((o) => o.u === 'uid-T1');
    expect(u1?.a?.title).toBe('TITLE T1');
    expect(u1?.a?.status).toBe('pending');
    expect(u1?.b).toBeUndefined();
    for (const uid of ['uid-T1', 'uid-T2', 'uid-T3']) {
      expect(metaOf(db, 'tasks_tasks', uid)?.chash).toBe(liveChash(db, uid));
    }
    expect(suspect(db)).not.toContain('tasks_tasks');
  });

  it('an uncaptured update of one row is found among clean rows', async () => {
    const db = await baselinedStore();
    uncaptured(db, "UPDATE tasks_tasks SET priority = 'high' WHERE id = 'T2'");
    markSuspect(db, 'project', ['tasks_tasks']);
    expect(planRepair(db, 'project', 'tasks_tasks').updates.map((r) => r.uid)).toEqual(['uid-T2']);
    repair(db);
    const ops = repairOps(db).filter((o) => o.t === 'tasks_tasks');
    expect(ops.map((o) => `${o.o}:${o.u}`)).toEqual(['U:uid-T2']);
    expect(ops[0]?.a?.priority).toBe('high');
  });

  it('a column cleared to NULL uncaptured travels as null (no before to compare with)', async () => {
    const db = await baselinedStore();
    captured(db, "UPDATE tasks_tasks SET description = 'desc' WHERE id = 'T1'");
    seal(db);
    uncaptured(db, "UPDATE tasks_tasks SET description = NULL WHERE id = 'T1'");
    markSuspect(db, 'project', ['tasks_tasks']);
    repair(db);
    const u = repairOps(db).find((o) => o.u === 'uid-T1');
    expect(u?.a).toHaveProperty('description', null);
    expect(metaOf(db, 'tasks_tasks', 'uid-T1')?.chash).toBe(liveChash(db, 'uid-T1'));
  });

  it('an uncaptured insert into a baselined table is an I, and the ledger follows', async () => {
    const db = await baselinedStore();
    uncaptured(
      db,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES ('T9', 'nine', 'task', 'pending', 'medium', 'uid-T9', 'fp-T9')`,
    );
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.cleared).toBe(true);
    const ins = repairOps(db).find((o) => o.u === 'uid-T9');
    expect(ins?.o).toBe('I');
    expect(ins?.a?.title).toBe('nine');
    expect(ledger(db, 'tasks_tasks')?.live).toBe(3);
  });

  it('an orphaned meta row (uncaptured delete) is a D, its meta a tombstone', async () => {
    const db = await baselinedStore();
    uncaptured(db, "DELETE FROM tasks_tasks WHERE id = 'T2'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.counts.deletes).toBe(1);
    expect(r.tables[0]?.cleared).toBe(true);
    const ops = repairOps(db).filter((o) => o.t === 'tasks_tasks');
    expect(ops).toEqual([expect.objectContaining({ o: 'D', u: 'uid-T2', bfp: 'fp-T2' })]);
    expect(metaOf(db, 'tasks_tasks', 'uid-T2')?.deleted).toBe(1);
    expect(ledger(db, 'tasks_tasks')?.live).toBe(1);
  });

  it('an orphaned natural row carries its key from row meta', async () => {
    const db = await baselinedStore();
    captured(db, "INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'bug')");
    seal(db);
    markSuspect(db, 'project', ['tasks_task_labels']);
    repair(db); // baselines the label table
    db.exec("DELETE FROM _sync_meta WHERE key LIKE 'suspect:%'");
    uncaptured(db, "DELETE FROM tasks_task_labels WHERE task_id = 'T1'");
    markSuspect(db, 'project', ['tasks_task_labels']);
    const r = repair(db);
    expect(r.tables[0]?.cleared).toBe(true);
    const uid = naturalRowUid('project', 'tasks_task_labels', ['uid-T1', 'bug']);
    const d = repairOps(db).find((o) => o.t === 'tasks_task_labels');
    expect(d).toEqual(
      expect.objectContaining({ o: 'D', u: uid, k: { task_id: 'uid-T1', label: 'bug' } }),
    );
  });

  it('held rows are skipped: no spurious D for a held insert (R6-3)', async () => {
    const db = await baselinedStore();
    uncaptured(db, "DELETE FROM tasks_tasks WHERE id = 'T2'");
    db.exec("UPDATE _sync_row_meta SET held = 1 WHERE tbl = 'tasks_tasks' AND uid = 'uid-T2'");
    db.exec("UPDATE _sync_ledger SET held = 1 WHERE tbl = 'tasks_tasks'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.counts).toEqual(expect.objectContaining({ deletes: 0, held: 1 }));
    expect(r.tables[0]?.cleared).toBe(true);
    expect(repairOps(db).filter((o) => o.t === 'tasks_tasks')).toEqual([]);
  });

  it('a held live row that differs is skipped too: no U for a held update', async () => {
    const db = await baselinedStore();
    uncaptured(db, "UPDATE tasks_tasks SET title = 'rewound' WHERE id = 'T1'");
    db.exec("UPDATE _sync_row_meta SET held = 1 WHERE tbl = 'tasks_tasks' AND uid = 'uid-T1'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.counts).toEqual(expect.objectContaining({ updates: 0, held: 1 }));
    expect(repairOps(db).filter((o) => o.t === 'tasks_tasks')).toEqual([]);
  });
});

describe('the suspect key clears only after verification (T12987)', () => {
  it('a row without uid keeps the table suspect, with the reason', async () => {
    const db = await baselinedStore();
    uncaptured(
      db,
      `INSERT INTO tasks_tasks (id, title, type, status, priority)
       VALUES ('T7', 'no uid', 'task', 'pending', 'medium')`,
    );
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.cleared).toBe(false);
    expect(r.tables[0]?.reason).toMatch(/without uid/);
    expect(suspect(db)).toContain('tasks_tasks');
  });

  it('a ledger that disagrees with the count keeps the table suspect', async () => {
    const db = await baselinedStore();
    db.exec("UPDATE _sync_ledger SET live = live + 5 WHERE tbl = 'tasks_tasks'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.cleared).toBe(false);
    expect(r.tables[0]?.reason).toMatch(/ledger 7 differs from count 2/);
    expect(suspect(db)).toContain('tasks_tasks');
  });

  it('a dry run writes, seals and clears nothing', async () => {
    const db = await baselinedStore();
    uncaptured(db, "UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const txns = n(db, 'SELECT count(*) AS n FROM _sync_txn');
    const r = repair(db, { dryRun: true });
    expect(r.tables[0]?.counts.updates).toBe(1);
    expect(r.tables[0]?.cleared).toBe(false);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_txn')).toBe(txns);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_capture')).toBe(0);
    expect(suspect(db)).toContain('tasks_tasks');
  });
});

describe('a table never baselined is baselined, not journaled (T12987)', () => {
  it('pre-sync rows get meta and no op; the ledger is the count', async () => {
    const db = await store();
    uncaptured(
      db,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp, updated_at)
       VALUES ('P1', 'old', 'task', 'pending', 'medium', 'uid-P1', 'fp-P1', '2026-01-02T03:04:05.000Z')`,
    );
    addTask(db, 'T1');
    seal(db);
    uncaptured(db, "UPDATE tasks_tasks SET title = 'edited' WHERE id = 'T1'");
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    const t = r.tables[0];
    expect(t?.baselined).toBe(false);
    expect(t?.counts).toEqual(
      expect.objectContaining({ inserts: 0, updates: 1, baselinedRows: 1 }),
    );
    expect(t?.cleared).toBe(true);
    // P1 is baselined with its genesis HLC, never emitted.
    expect(repairOps(db).map((o) => `${o.o}:${o.u}`)).toEqual(['U:uid-T1']);
    const p1 = db
      .prepare(
        "SELECT hlc, version, chash FROM _sync_row_meta WHERE tbl = 'tasks_tasks' AND uid = 'uid-P1'",
      )
      .get() as { hlc: string; version: number; chash: string };
    expect(
      p1.hlc.startsWith(String(Date.parse('2026-01-02T03:04:05.000Z')).padStart(13, '0')),
    ).toBe(true);
    expect(p1.version).toBe(0);
    expect(p1.chash).toBe(liveChash(db, 'uid-P1'));
    expect(ledger(db, 'tasks_tasks')?.live).toBe(2);
    expect(
      n(db, `SELECT count(*) AS n FROM _sync_meta WHERE key = '${BASELINE_KEY_PREFIX}tasks_tasks'`),
    ).toBe(1);
  });
});

describe('NEW-8 order at a migration: seal and repair, then bracket, then re-baseline (T12987)', () => {
  const migrate = (db: DatabaseSync, sql: string) => {
    const lineage = join(dir, 'order');
    mkdirSync(join(lineage, '20991231000001_order'), { recursive: true });
    writeFileSync(join(lineage, '20991231000001_order', 'migration.sql'), sql);
    runBracketedMigrations(
      db,
      drizzle({ client: db }),
      [{ folder: lineage }],
      syncMigrationHooks(db, 'project', { replica: REPLICA, allowUnreleased: true, env: {} }),
    );
  };

  /** The sealed ops on `uid`, by `via`, oldest first. */
  const opsOn = (db: DatabaseSync, uid: string) =>
    (
      db
        .prepare(
          `SELECT t.via, o.body FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
           WHERE o.uid = ? ORDER BY t.local_seq, o.idx`,
        )
        .all(uid) as Array<{ via: string; body: string }>
    ).map((r) => ({ via: r.via, op: JSON.parse(r.body) as Op }));

  it('the real hooks seal the captured edit and repair the uncaptured one under the OLD values', async () => {
    const db = await baselinedStore();
    captured(db, "UPDATE tasks_tasks SET title = 'captured edit' WHERE id = 'T1'");
    uncaptured(db, "UPDATE tasks_tasks SET title = 'uncaptured edit' WHERE id = 'T2'");
    markSuspect(db, 'project', ['tasks_tasks']);

    migrate(db, 'UPDATE `tasks_tasks` SET `title` = upper(`title`)');

    // Sealed and repaired BEFORE the bracket: both ops carry pre-migration values.
    const t1 = opsOn(db, 'uid-T1').at(-1);
    expect(t1).toEqual({ via: 'accessor', op: expect.objectContaining({ o: 'U' }) });
    expect(t1?.op.a?.title).toBe('captured edit');
    const t2 = opsOn(db, 'uid-T2').at(-1);
    expect(t2).toEqual({ via: 'repair', op: expect.objectContaining({ o: 'U' }) });
    expect(t2?.op.a?.title).toBe('uncaptured edit');
    // The backfill itself is never emitted, and the re-baseline (after the
    // repair cleared the table) moved every row to the migrated hash.
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);
    expect(opsOn(db, 'uid-T1').some((o) => o.op.a?.title === 'CAPTURED EDIT')).toBe(false);
    for (const uid of ['uid-T1', 'uid-T2']) {
      expect(metaOf(db, 'tasks_tasks', uid)?.chash).toBe(liveChash(db, uid));
    }
    expect(suspect(db)).toEqual([]);
  });

  it('pending captures are sealed before the bracket even when no table is suspect', async () => {
    const db = await baselinedStore();
    captured(db, "UPDATE tasks_tasks SET title = 'captured edit' WHERE id = 'T1'");
    migrate(db, 'UPDATE `tasks_tasks` SET `title` = upper(`title`)');
    expect(opsOn(db, 'uid-T1').at(-1)?.op.a?.title).toBe('captured edit');
    expect(metaOf(db, 'tasks_tasks', 'uid-T1')?.chash).toBe(liveChash(db, 'uid-T1'));
  });
});

describe('baselineRowMeta, the one row-meta initializer (T12987, for T12342)', () => {
  it('baselines every live row without meta once, with the ledger and the marker', async () => {
    const db = await store();
    for (const id of ['P1', 'P2']) {
      uncaptured(
        db,
        `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
         VALUES ('${id}', 'pre-sync', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`,
      );
    }
    expect(baselineRowMeta(db, 'project', 'tasks_tasks', REPLICA, T0)).toBe(2);
    expect(metaOf(db, 'tasks_tasks', 'uid-P1')?.chash).toBe(liveChash(db, 'uid-P1'));
    expect(ledger(db, 'tasks_tasks')?.live).toBe(2);
    expect(
      n(db, `SELECT count(*) AS n FROM _sync_meta WHERE key = '${BASELINE_KEY_PREFIX}tasks_tasks'`),
    ).toBe(1);
    expect(baselineRowMeta(db, 'project', 'tasks_tasks', REPLICA, T0)).toBe(0);
    expect(baselineRowMeta(db, 'project', 'not_a_table', REPLICA, T0)).toBeNull();
  });
});

describe('after the stream starts, nothing is baselined silently (T13217)', () => {
  it('an uncaptured insert into a never-baselined table is journaled as an I', async () => {
    const db = await store();
    addTask(db, 'T1');
    seal(db);
    // A genesis cut was recorded: a checkpoint may already have left.
    db.exec(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('genesis_cut:project:x', '1', '2026-10-05T00:00:00.000Z')",
    );
    uncaptured(
      db,
      `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
       VALUES ('P1', 'after genesis', 'task', 'pending', 'medium', 'uid-P1', 'fp-P1')`,
    );
    markSuspect(db, 'project', ['tasks_tasks']);
    const r = repair(db);
    expect(r.tables[0]?.counts).toEqual(expect.objectContaining({ inserts: 1, baselinedRows: 0 }));
    expect(r.tables[0]?.cleared).toBe(true);
    expect(repairOps(db).map((o) => `${o.o}:${o.u}`)).toEqual(['I:uid-P1']);
    expect(ledger(db, 'tasks_tasks')?.live).toBe(2);
    expect(
      n(db, `SELECT count(*) AS n FROM _sync_meta WHERE key = '${BASELINE_KEY_PREFIX}tasks_tasks'`),
    ).toBe(1);
  });

  it('a segmented transaction also counts as a started stream', async () => {
    const db = await store();
    addTask(db, 'T1');
    seal(db);
    db.exec("UPDATE _sync_txn SET state = 'segmented'");
    expect(streamStarted(db)).toBe(true);
  });
});

describe('a crash mid-baseline leaves nothing half-written (T12987)', () => {
  it('the on-disk state of a process killed mid-baseline re-runs cleanly', async () => {
    const db = await store();
    for (const id of ['P1', 'P2', 'P3']) {
      uncaptured(
        db,
        `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
         VALUES ('${id}', 'pre-sync ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`,
      );
    }
    markSuspect(db, 'project', ['tasks_tasks']);
    // At P2's meta write, copy the files exactly as a SIGKILL would leave
    // them (the WAL holds P1's uncommitted meta), then abort.
    const crash = join(dir, 'crash');
    mkdirSync(crash, { recursive: true });
    db.function('kill_mid_baseline', () => {
      for (const suffix of ['', '-wal']) {
        if (existsSync(dbPath + suffix))
          copyFileSync(dbPath + suffix, join(crash, `cleo.db${suffix}`));
      }
      throw new Error('killed mid-baseline');
    });
    db.exec(
      `CREATE TEMP TRIGGER kill_mid_baseline AFTER INSERT ON _sync_row_meta
       WHEN NEW.uid = 'uid-P2' BEGIN SELECT kill_mid_baseline(); END`,
    );
    expect(() => repair(db)).toThrow(/killed mid-baseline/);
    _resetDualScopeDbCache();

    const after = new DatabaseSync(join(crash, 'cleo.db'));
    try {
      // Nothing of the baseline survived: no meta, no marker, no ledger.
      expect(n(after, "SELECT count(*) AS n FROM _sync_row_meta WHERE tbl = 'tasks_tasks'")).toBe(
        0,
      );
      expect(
        n(
          after,
          `SELECT count(*) AS n FROM _sync_meta WHERE key = '${BASELINE_KEY_PREFIX}tasks_tasks'`,
        ),
      ).toBe(0);
      expect(ledger(after, 'tasks_tasks')).toBeUndefined();
      expect(suspect(after)).toContain('tasks_tasks');
      // The re-run baselines all three and clears the key.
      const r = repair(after);
      expect(r.tables[0]?.counts.baselinedRows).toBe(3);
      expect(r.tables[0]?.cleared).toBe(true);
      expect(n(after, "SELECT count(*) AS n FROM _sync_row_meta WHERE tbl = 'tasks_tasks'")).toBe(
        3,
      );
      expect(ledger(after, 'tasks_tasks')?.live).toBe(3);
      expect(suspect(after)).toEqual([]);
    } finally {
      after.close();
    }
  });
});

describe('the JSON-null before slot is a repair capture only (T12987)', () => {
  it('no generated U trigger writes a null before slot; the repair image does', async () => {
    const db = await store();
    const triggers = generateCaptureTriggers(db, 'project').filter((t) => t.name.endsWith('_u'));
    expect(triggers.length).toBeGreaterThan(5);
    for (const t of triggers) expect(t.sql).not.toMatch(/json_array\(NULL/);
  });

  it('a captured update never records a null before or after, NULLs and references included', async () => {
    const db = await baselinedStore();
    captured(
      db,
      "UPDATE tasks_tasks SET type = 'subtask', description = 'd', parent_id = 'T1' WHERE id = 'T2'",
    );
    captured(
      db,
      "UPDATE tasks_tasks SET type = 'task', description = NULL, parent_id = NULL WHERE id = 'T2'",
    );
    const imgs = (
      db.prepare("SELECT img FROM _sync_capture WHERE op = 'U' AND state = 'live'").all() as Array<{
        img: string;
      }>
    ).map((r) => JSON.parse(r.img) as Record<string, [unknown, unknown]>);
    expect(imgs.length).toBe(2);
    for (const img of imgs) {
      expect(Object.keys(img)).toEqual(expect.arrayContaining(['description', 'parent_id']));
      for (const [before, after] of Object.values(img)) {
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
      }
    }
  });

  it('a null before outside a repair frame is quarantined, never sealed as unknown', async () => {
    const db = await baselinedStore();
    db.prepare(
      `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms) VALUES ('tasks_tasks', 'U', ?, 'uid-T1', ?, 1)`,
    ).run(JSON.stringify(["'T1'"]), JSON.stringify({ title: [null, "'forged'"] }));
    const r = seal(db);
    expect(r.quarantined).toEqual([expect.objectContaining({ tbl: 'tasks_tasks' })]);
    expect(r.ops).toBe(0);
  });
});
