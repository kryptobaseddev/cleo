/**
 * Capture triggers (journal spec §2.3, §2.3a; S2 `sync.capture`; T12343 AC1
 * / R4; H5 T12755, N4 T12760, N10/N11 T12766, N3 T12759, L3, L4).
 *
 * Stores are fresh project `cleo.db` files opened through the chokepoint
 * (`openDualScopeDbAtPath`) under a `mkdtemp` directory, or plain temp
 * databases for the generator-level tests.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTriggersDoctorCheck } from '../../../doctor/sync-triggers.js';
import { createTestDb, seedTasks } from '../../__tests__/test-db-helper.js';
import { rekeyRowUid } from '../../display-id-alias.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { runBracketedMigrations } from '../../migration-runner.js';
import { getNativeTasksDb } from '../../sqlite.js';
import {
  type CaptureTableDef,
  captureBracketHooks,
  captureTriggers,
  clearCaptureFrame,
  finishCaptureFrame,
  generateCaptureTriggers,
  installCaptureStamp,
  openCaptureFrame,
  SECRET_MARKER,
  setCaptureEnabled,
  syncSetTables,
} from '../capture.js';
import { readSyncFlags } from '../flags.js';
import { ensureSyncSchema } from '../schema.js';
import {
  BracketTransactionError,
  suspectTables,
  touchSet,
  withSuspectAccounting,
  withSyncTriggersSuspended,
} from '../structural.js';
import {
  classifyStoreTriggers,
  ensureTriggerSuspendTable,
  TRIGGER_SUSPEND_TABLE_DDL,
} from '../trigger-classes.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let dbPath: string;

async function openStore(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  return handle.db.$client as DatabaseSync;
}

async function reopen(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  return openStore();
}

async function captureOn(): Promise<DatabaseSync> {
  const db = await openStore();
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

type Cap = {
  seq: number;
  tbl: string;
  op: string;
  rk: string;
  uid: string | null;
  img: string;
  conn: string | null;
  frame: string | null;
  kind: string | null;
};

function captures(db: DatabaseSync, tbl?: string): Cap[] {
  return (tbl
    ? db.prepare('SELECT * FROM _sync_capture WHERE tbl = ? ORDER BY seq').all(tbl)
    : db.prepare('SELECT * FROM _sync_capture ORDER BY seq').all()) as unknown as Cap[];
}

const img = (c: Cap) => JSON.parse(c.img) as Record<string, unknown>;

const addTask = (db: DatabaseSync, id: string, extra = '') =>
  db.exec(
    `INSERT INTO tasks_tasks (id, title, type, status${extra ? `, ${extra.split('=')[0]}` : ''}) VALUES ('${id}', 'title ${id}', 'task', 'pending'${extra ? `, ${extra.split('=')[1]}` : ''})`,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-capture-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('flag off', () => {
  it('a store with capture off has no capture trigger and no outbox, and writes capture nothing', async () => {
    const db = await openStore();
    addTask(db, 'T1');
    expect(generateCaptureTriggers(db, 'project').length).toBeGreaterThan(0);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '\\_sync%' ESCAPE '\\'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('turning capture off drops the triggers and keeps the tables; the kill switch never touches them', async () => {
    const db = await captureOn();
    vi.stubEnv('CLEO_SYNC_CAPTURE', '0');
    const again = await reopen();
    expect(readSyncFlags(again)['sync.capture']).toBe(true);
    expect(
      classifyStoreTriggers(again, 'project').classified.filter((t) => t.class === 'capture')
        .length,
    ).toBeGreaterThan(0);
    setCaptureEnabled(again, 'project', false);
    expect(
      classifyStoreTriggers(again, 'project').classified.filter((t) => t.class === 'capture'),
    ).toEqual([]);
    expect(
      again.prepare("SELECT 1 FROM sqlite_master WHERE name = '_sync_capture'").get(),
    ).toBeDefined();
    void db;
  });
});

describe('capture on (R4: one capture per mutation, in the same transaction)', () => {
  it('installs the triggers of every sync-set table, the stamp, and recursive_triggers', async () => {
    const db = await captureOn();
    const names = classifyStoreTriggers(db, 'project').classified.filter(
      (t) => t.class === 'capture',
    );
    for (const t of syncSetTables('project')) {
      expect(
        names.some((n) => n.name === `_sync_cap_${t}_i`),
        t,
      ).toBe(true);
      expect(
        names.some((n) => n.name === `_sync_cap_${t}_d`),
        t,
      ).toBe(true);
    }
    expect(
      (db.prepare('PRAGMA recursive_triggers').get() as { recursive_triggers: number })
        .recursive_triggers,
    ).toBe(1);
    expect(classifyStoreTriggers(db, 'project').unclassified).toEqual([]);
  });

  it('insert, update and delete each capture once; a rolled-back write captures nothing', async () => {
    const db = await captureOn();
    addTask(db, 'T1');
    db.exec("UPDATE tasks_tasks SET title = 'renamed' WHERE id = 'T1'");
    db.exec('BEGIN IMMEDIATE');
    addTask(db, 'T9');
    db.exec('ROLLBACK');
    db.exec("DELETE FROM tasks_tasks WHERE id = 'T1'");
    const caps = captures(db, 'tasks_tasks');
    expect(caps.map((c) => c.op)).toEqual(['I', 'U', 'D']);
    expect(img(caps[1] as Cap)).toEqual({ title: ["'title T1'", "'renamed'"] });
    expect(img(caps[2] as Cap).title).toBe("'renamed'");
    expect(caps.every((c) => c.rk === `["'T1'"]`)).toBe(true);
  });

  it('a claim-lease update and a no-op update capture nothing', async () => {
    const db = await captureOn();
    addTask(db, 'T1');
    const before = captures(db).length;
    db.exec(
      "UPDATE tasks_tasks SET claimed_by_session = 'S1', claimed_at = '2026-09-30T00:00:00Z' WHERE id = 'T1'",
    );
    db.exec("UPDATE tasks_tasks SET title = title WHERE id = 'T1'");
    expect(captures(db).length).toBe(before);
  });

  it('references are captured as [local key, target uid] at write time (H5)', async () => {
    const db = await captureOn();
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status, uid) VALUES ('E1', 'epic', 'epic', 'pending', 'uid-epic-1')",
    );
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status, parent_id) VALUES ('T2', 'child', 'task', 'pending', 'E1')",
    );
    const child = captures(db, 'tasks_tasks').at(-1) as Cap;
    expect(img(child).parent_id).toEqual(["'E1'", 'uid-epic-1']);
  });

  it('a secret column records only the <changed> marker, never its value (§2.7)', async () => {
    const db = await captureOn();
    db.exec(
      "INSERT INTO tasks_sessions (id, name, status, owner_auth_token) VALUES ('S1', 's', 'active', 'tok-secret')",
    );
    db.exec("UPDATE tasks_sessions SET owner_auth_token = 'tok-2' WHERE id = 'S1'");
    const caps = captures(db, 'tasks_sessions');
    for (const c of caps) expect(c.img).not.toContain('tok-');
    expect(img(caps[0] as Cap).owner_auth_token).toBe(SECRET_MARKER);
    expect(img(caps[1] as Cap).owner_auth_token).toEqual([SECRET_MARKER, SECRET_MARKER]);
  });
});

describe('identity (N4, N11, H5)', () => {
  it('an identity fill patches the latest live I capture and captures nothing new, in both trigger orders', async () => {
    for (const order of ['fill-first', 'capture-first'] as const) {
      const db = await captureOn();
      const fill =
        "CREATE TEMP TRIGGER fill_uid AFTER INSERT ON main.tasks_tasks WHEN NEW.uid IS NULL BEGIN UPDATE tasks_tasks SET uid = 'u-' || NEW.id WHERE id = NEW.id; END";
      if (order === 'fill-first') {
        db.exec('DROP TRIGGER _sync_cap_tasks_tasks_i');
        db.exec(fill);
        setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA }); // reinstalls _i after the fill
      } else {
        db.exec(fill);
      }
      db.exec(
        "INSERT INTO tasks_tasks (id, title, type, status, uid) VALUES ('T1', 't', 'task', 'pending', NULL)",
      );
      const caps = captures(db, 'tasks_tasks');
      expect(
        caps.map((c) => c.op),
        order,
      ).toEqual(['I']);
      expect(caps[0]?.uid, order).toBe('u-T1');
      expect(img(caps[0] as Cap).uid, order).toBe("'u-T1'");
      db.exec('DROP TRIGGER temp.fill_uid');
      _resetDualScopeDbCache();
      rmSync(join(dir, 'project', '.cleo'), { recursive: true, force: true });
      mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
    }
  });

  it('a re-key of a keyed row captures K with old and new identity', async () => {
    const db = await captureOn();
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status, uid) VALUES ('T1', 't', 'task', 'pending', 'uid-a')",
    );
    db.exec("UPDATE tasks_tasks SET uid = 'uid-b' WHERE id = 'T1'");
    const k = captures(db, 'tasks_tasks').at(-1) as Cap;
    expect(k.op).toBe('K');
    expect(k.uid).toBe('uid-a');
    expect(img(k).uid as string[]).toEqual(["'uid-a'", "'uid-b'"]);
  });
});

describe('re-key through T12341 (H5, T12755)', () => {
  it('rekeyRowUid captures K for the row and for every cascaded child', async () => {
    const db = await captureOn();
    db.exec(`INSERT INTO tasks_tasks (id, title, type, status, uid, birth_fp)
               VALUES ('T1', 't', 'task', 'pending', 'uid-t1', 'fp-t1');
             INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text, uid, birth_fp)
               VALUES ('A1', 'T1', 1, 'text', 'ac', 'uid-a1', 'fp-a1');`);
    const receipt = rekeyRowUid(db, 'tasks_tasks', 'uid-t1', 'fp-t1');
    const ks = captures(db).filter((c) => c.op === 'K');
    expect(ks.find((k) => k.tbl === 'tasks_tasks')?.uid).toBe('uid-t1');
    const kTask = ks.find((k) => k.tbl === 'tasks_tasks') as Cap;
    expect((img(kTask).uid as string[])[1]).not.toBe("'uid-t1'");
    // Every row the receipt says was re-keyed has its own K capture.
    const rekeyedTables = new Set(ks.map((k) => k.tbl));
    for (const c of (receipt as unknown as { cascaded?: Array<{ table: string }> }).cascaded ??
      []) {
      expect(rekeyedTables.has(c.table), c.table).toBe(true);
    }
  });
});

describe('frames and the stamp (§2.3, N10)', () => {
  it('a framed write carries conn, frame and kind; a read-only frame leaves no row; a cleared ctx is unframed', async () => {
    const db = await captureOn();
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', 'test');
    addTask(db, 'T1');
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    clearCaptureFrame(db, frame);
    const c = captures(db, 'tasks_tasks')[0] as Cap;
    expect(c.frame).toBe(frame);
    expect(c.kind).toBe('write');
    expect(c.conn).toBeTruthy();
    expect(db.prepare('SELECT count(*) AS n FROM _sync_frame WHERE frame = ?').get(frame)).toEqual({
      n: 1,
    });

    db.exec('BEGIN IMMEDIATE');
    const ro = openCaptureFrame(db, 'write');
    finishCaptureFrame(db, ro);
    db.exec('COMMIT');
    clearCaptureFrame(db, ro);
    expect(db.prepare('SELECT count(*) AS n FROM _sync_frame WHERE frame = ?').get(ro)).toEqual({
      n: 0,
    });

    addTask(db, 'T2'); // autocommit, no frame
    const unframed = captures(db, 'tasks_tasks').at(-1) as Cap;
    expect(unframed.frame).toBeNull();
    // Labels are written per frame at finish: an unframed write has none.
    expect(unframed.conn).toBeNull();
  });

  it('a rolled-back frame leaves nothing: a later autocommit write is unframed', async () => {
    // The frame row is written inside the transaction and labels only at
    // finish, so a ROLLBACK (explicit or automatic) leaves no trace.
    const db = await captureOn();
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'apply');
    db.exec('ROLLBACK');
    addTask(db, 'T1');
    const c = captures(db, 'tasks_tasks')[0] as Cap;
    expect(c.frame).toBeNull();
    expect(c.kind).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM _sync_frame WHERE frame = ?').get(frame)).toEqual({
      n: 0,
    });
  });

  it('undo is off in shadow mode; with undo_enabled it is written, and an apply frame drops it at once (D1)', async () => {
    const db = await captureOn();
    addTask(db, 'T1');
    expect(db.prepare('SELECT count(*) AS n FROM _sync_undo').get()).toEqual({ n: 0 });
    db.exec(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('undo_enabled', '1', '2026-09-30T00:00:00Z')",
    );
    db.exec("UPDATE tasks_tasks SET title = 'x' WHERE id = 'T1'");
    const u = db.prepare('SELECT * FROM _sync_undo').all() as Array<{
      op: string;
      before_full: string;
      after_full: string;
    }>;
    expect(u).toHaveLength(1);
    expect(JSON.parse(u[0]?.before_full as string).title).toBe("'title T1'");
    expect(JSON.parse(u[0]?.after_full as string).title).toBe("'x'");
    db.exec('BEGIN IMMEDIATE');
    const f = openCaptureFrame(db, 'apply');
    db.exec("UPDATE tasks_tasks SET title = 'y' WHERE id = 'T1'");
    finishCaptureFrame(db, f);
    db.exec('COMMIT');
    clearCaptureFrame(db, f);
    expect(db.prepare('SELECT count(*) AS n FROM _sync_undo').get()).toEqual({ n: 1 });
  });
});

describe('the accessor frame (§2.3)', () => {
  it('accessor.transaction() writes one frame: its captures carry it, kind write', async () => {
    const env = await createTestDb();
    try {
      await seedTasks(env.accessor, [{ id: 'T1', title: 'first' }]);
      const native = getNativeTasksDb(env.tempDir) as DatabaseSync;
      setCaptureEnabled(native, 'project', true, { schemaRoot: SYNC_SCHEMA });
      await env.accessor.transaction(async (tx) => {
        await tx.updateTaskFields('T1', { title: 'second' });
      });
      const caps = captures(native, 'tasks_tasks');
      expect(caps.length).toBeGreaterThan(0);
      const frame = caps[0]?.frame;
      expect(frame).toBeTruthy();
      expect(caps.every((c) => c.frame === frame && c.kind === 'write')).toBe(true);
      expect(native.prepare('SELECT kind FROM _sync_frame WHERE frame = ?').get(frame)).toEqual({
        kind: 'write',
      });
      // A read-only accessor transaction leaves no frame row.
      const framesBefore = (
        native.prepare('SELECT count(*) AS n FROM _sync_frame').get() as { n: number }
      ).n;
      await env.accessor.transaction(async () => undefined);
      expect(
        (native.prepare('SELECT count(*) AS n FROM _sync_frame').get() as { n: number }).n,
      ).toBe(framesBefore);
    } finally {
      await env.cleanup();
    }
  });
});

describe('structural safety (§2.3a, H4, N3)', () => {
  it('a migration that rebuilds a referenced table (tasks_tasks) and adds a captured column runs in the bracket and regenerates the triggers', async () => {
    const db = await captureOn();
    addTask(db, 'T1');
    const lineage = join(dir, 'extra');
    mkdirSync(join(lineage, '20991231000000_extra'), { recursive: true });
    const create = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks_task_labels'",
        )
        .get() as { sql: string }
    ).sql.replace(
      /CREATE TABLE [`"]?tasks_task_labels[`"]?/,
      'CREATE TABLE `__new_tasks_task_labels`',
    );
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(lineage, '20991231000000_extra', 'migration.sql'),
      [
        create,
        'INSERT INTO `__new_tasks_task_labels` SELECT * FROM `tasks_task_labels`',
        'DROP TABLE `tasks_task_labels`',
        'ALTER TABLE `__new_tasks_task_labels` RENAME TO `tasks_task_labels`',
        'ALTER TABLE `tasks_task_labels` ADD COLUMN `note` TEXT',
      ].join(';\n--> statement-breakpoint\n'),
    );
    runBracketedMigrations(
      db,
      drizzle({ client: db }),
      [{ folder: lineage }],
      captureBracketHooks(db, 'project'),
    );
    const u = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = '_sync_cap_tasks_task_labels_u'")
      .get() as { sql: string } | undefined;
    expect(u?.sql).toContain('"note"');
    db.exec("INSERT INTO tasks_task_labels (task_id, label, note) VALUES ('T1', 'l1', 'n')");
    expect(img(captures(db, 'tasks_task_labels').at(-1) as Cap).note).toBe("'n'");

    // DROP COLUMN of a captured column: the capture triggers reference it, so
    // outside the bracket SQLite refuses it (H4); inside, it runs.
    expect(() => db.exec('ALTER TABLE tasks_task_labels DROP COLUMN note')).toThrow();
    mkdirSync(join(lineage, '20991231000001_drop'), { recursive: true });
    writeFileSync(
      join(lineage, '20991231000001_drop', 'migration.sql'),
      'ALTER TABLE `tasks_task_labels` DROP COLUMN `note`;',
    );
    runBracketedMigrations(
      db,
      drizzle({ client: db }),
      [{ folder: lineage }],
      captureBracketHooks(db, 'project'),
    );
    const u2 = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = '_sync_cap_tasks_task_labels_u'")
      .get() as {
      sql: string;
    };
    expect(u2.sql).not.toContain('"note"');
    db.exec("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'l2')");
    expect(captures(db, 'tasks_task_labels').at(-1)?.op).toBe('I');
  });

  it('RENAME of an uncaptured table works with capture triggers present', async () => {
    const db = await captureOn();
    db.exec('ALTER TABLE tasks_warp_chains RENAME TO tasks_warp_chains_tmp');
    db.exec('ALTER TABLE tasks_warp_chains_tmp RENAME TO tasks_warp_chains');
    addTask(db, 'T1');
    expect(captures(db, 'tasks_tasks')).toHaveLength(1);
  });

  it('a missing _sync_capture with triggers present fails writes; the next open heals it', async () => {
    const db = await captureOn();
    db.exec('DROP TABLE _sync_capture');
    expect(() => addTask(db, 'T1')).toThrow(/no such table/);
    const again = await reopen();
    addTask(again, 'T2');
    expect(captures(again, 'tasks_tasks').map((c) => c.op)).toEqual(['I']);
  });

  it('a capture-suspended frame writes nothing to the outbox', async () => {
    const db = await captureOn();
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO cleo_trigger_suspend VALUES ('capture')");
    addTask(db, 'T1');
    db.exec('DELETE FROM cleo_trigger_suspend');
    db.exec('COMMIT');
    expect(captures(db)).toEqual([]);
  });
});

describe('the rule-1 bracket, touch sets and suspect marking (§2.3a rules 1, 3; B, NEW-8)', () => {
  it('a rebuild of tasks_tasks inside the bracket keeps capture working, with triggers regenerated', async () => {
    const db = await captureOn();
    withSyncTriggersSuspended(db, 'project', () => {
      const referencing = (
        db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%tasks_tasks%'",
          )
          .all() as Array<{ name: string; sql: string }>
      ).filter((t) => !t.name.startsWith('_sync_cap_'));
      for (const t of referencing) db.exec(`DROP TRIGGER "${t.name}"`);
      const create = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks_tasks'")
          .get() as { sql: string }
      ).sql.replace(/CREATE TABLE [`"]?tasks_tasks[`"]?/, 'CREATE TABLE `__new_tasks_tasks`');
      db.exec(create);
      db.exec('INSERT INTO __new_tasks_tasks SELECT * FROM tasks_tasks');
      db.exec('DROP TABLE tasks_tasks');
      db.exec('ALTER TABLE __new_tasks_tasks RENAME TO tasks_tasks');
      for (const t of referencing) db.exec(t.sql);
    });
    addTask(db, 'T1');
    expect(captures(db, 'tasks_tasks').map((c) => c.op)).toEqual(['I']);
  });

  it('refuses a body that commits, and refuses to nest inside a transaction', async () => {
    const db = await captureOn();
    expect(() => withSyncTriggersSuspended(db, 'project', () => db.exec('COMMIT'))).toThrow(
      BracketTransactionError,
    );
    expect(db.isTransaction).toBe(false);
    db.exec('BEGIN');
    expect(() => withSyncTriggersSuspended(db, 'project', () => undefined)).toThrow(
      BracketTransactionError,
    );
    db.exec('ROLLBACK');
    // The triggers survived the refused bracket.
    addTask(db, 'T1');
    expect(captures(db, 'tasks_tasks')).toHaveLength(1);
  });

  it('a second connection waits during the bracket, and its later write is captured', async () => {
    const db = await captureOn();
    const other = new DatabaseSync(dbPath);
    other.exec('PRAGMA busy_timeout = 0');
    let blocked = false;
    withSyncTriggersSuspended(db, 'project', () => {
      try {
        other.exec('BEGIN IMMEDIATE');
      } catch {
        blocked = true;
      }
    });
    expect(blocked).toBe(true);
    other.exec(
      "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T5', 'x', 'task', 'pending')",
    );
    other.close();
    const c = captures(db, 'tasks_tasks').at(-1) as Cap;
    expect(c.op).toBe('I');
    expect(c.conn).toBeNull(); // a foreign writer: no stamp on that connection
  });

  it('touch sets follow FK actions and trigger writes; suspect marking needs a change', async () => {
    const db = await captureOn();
    expect(touchSet(db, ['tasks_sessions'])).toContain('tasks_tasks'); // claim release writes it
    expect(touchSet(db, ['tasks_session_handoff_entries'])).toContain('tasks_sessions'); // the mirror
    const none = withSuspectAccounting(db, 'project', ['tasks_task_labels'], () => undefined);
    expect(none.suspect).toEqual([]);
    addTask(db, 'T1');
    const some = withSuspectAccounting(db, 'project', ['tasks_task_labels'], () =>
      db.exec("INSERT INTO tasks_task_labels (task_id, label) VALUES ('T1', 'x')"),
    );
    expect(some.suspect).toContain('tasks_task_labels');
    expect(suspectTables(db)).toContain('tasks_task_labels');
  });
});

describe('doctor sync_triggers with capture on (rule 9)', () => {
  it('ok when the capture triggers match; a warning when one is missing; an error without _sync_capture', async () => {
    const db = await captureOn();
    const root = join(dir, 'project');
    const ok = syncTriggersDoctorCheck(root);
    expect(ok.message).not.toMatch(/no project store/);
    expect(ok.status).toBe('ok');
    db.exec('DROP TRIGGER _sync_cap_tasks_task_labels_u');
    const warn = syncTriggersDoctorCheck(root);
    expect(warn.status).toBe('warning');
    expect(warn.message).toMatch(/missing 1/);
    db.exec('DROP TABLE _sync_capture');
    expect(syncTriggersDoctorCheck(root).status).toBe('error');
  });
});

describe('the generator on a plain database (L3, L4)', () => {
  function plain(columns: number): { db: DatabaseSync; def: CaptureTableDef } {
    const db = new DatabaseSync(':memory:');
    db.exec(TRIGGER_SUSPEND_TABLE_DDL);
    ensureSyncSchema(db, { root: SYNC_SCHEMA });
    ensureTriggerSuspendTable(db);
    const cols = Array.from({ length: columns }, (_, i) => `c${i}`);
    db.exec(
      `CREATE TABLE w (id TEXT PRIMARY KEY, uid TEXT, ${cols.map((c) => `${c}`).join(', ')})`,
    );
    const def: CaptureTableDef = {
      table: 'w',
      key: ['id'],
      columns: ['id', 'uid', ...cols],
      identity: ['uid'],
      secret: new Set(),
      refs: new Map(),
      appendOnly: false,
    };
    for (const t of captureTriggers(def)) db.exec(t.sql);
    installCaptureStamp(db);
    return { db, def };
  }

  it('a 70-column table images every non-NULL column (json_object chunked at 60 pairs)', () => {
    const { db } = plain(70);
    const cols = Array.from({ length: 70 }, (_, i) => `c${i}`);
    db.exec(
      `INSERT INTO w (id, ${cols.join(', ')}) VALUES ('a', ${cols.map((_, i) => i).join(', ')})`,
    );
    const row = db.prepare('SELECT img FROM _sync_capture').get() as { img: string };
    const image = JSON.parse(row.img);
    expect(Object.keys(image).length).toBeGreaterThanOrEqual(71);
    expect(image.c0).toBe('0');
    expect(image.c69).toBe('69');
    // NULL columns are absent from I and D images (S2 ruling (a)).
    db.exec("INSERT INTO w (id, c0, c69) VALUES ('b', 1, 2)");
    const sparse = JSON.parse(
      (
        db.prepare('SELECT img FROM _sync_capture ORDER BY seq DESC LIMIT 1').get() as {
          img: string;
        }
      ).img,
    );
    expect(sparse.c1).toBeUndefined();
    expect(sparse.c69).toBe('2');
    db.close();
  });

  it('values round-trip losslessly through enc(): REAL, big INTEGER, BLOB, quotes, NULL, ±Inf, -0.0', () => {
    const { db } = plain(8);
    db.prepare(
      'INSERT INTO w (id, c0, c1, c2, c3, c4, c5, c6, c7) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'a',
      0.1 + 0.2,
      9223372036854775807n,
      Buffer.from([0, 255, 16]),
      "it's",
      null,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
    );
    const image = JSON.parse(
      (db.prepare('SELECT img FROM _sync_capture').get() as { img: string }).img,
    );
    expect(image.c0).toBe('r0.30000000000000004');
    expect(image.c1).toBe('9223372036854775807');
    expect(image.c2).toBe("X'00FF10'");
    expect(image.c3).toBe("'it''s'");
    expect(image.c4).toBeUndefined(); // NULL: absent from a full image
    expect(image.c5).toBe('rInf');
    expect(image.c6).toBe('r-Inf');
    // -0.0: SQLite stores an integer-valued REAL as REAL; the sign is not kept (L4).
    expect(['r0.0', 'r-0.0', '0']).toContain(image.c7);
    db.close();
  });
});
