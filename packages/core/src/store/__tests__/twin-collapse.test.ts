/**
 * Twin collapses (T12535): `schema_meta` → `tasks_schema_meta` and
 * `sticky_tags` → `brain_sticky_tags`, bare-authoritative, initial collapse
 * plus incremental re-merge on every open.
 *
 * Every case starts from a fresh migrated store put back into the
 * PRE-MIGRATION shape: the markers removed, the bare tables written the way
 * the 2026.9.20 build writes them (its allocation SQL on bare `schema_meta`,
 * its tags in bare `sticky_tags`), and the twins holding a seed or a frozen
 * exodus copy. "Old path" below means those raw writes to the bare tables;
 * "re-open" drops the bindings so the next `getDb` runs the collapse inside
 * the bind, as a new CLI process does.
 *
 * @task T12535
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateNextTaskId } from '../../sequence/index.js';
import { addSticky } from '../../sticky/create.js';
import { listStickies } from '../../sticky/list.js';
import { listSystemBackups } from '../../system/backup.js';
import { getBrainDb, getBrainNativeDb } from '../memory-sqlite.js';
import { SNAPSHOT_GATE_META_KEY } from '../snapshot-gate.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import {
  collapseTwinTables,
  inspectTwinCollapse,
  mergeSchemaMetaValue,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SEQ_MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`;
const STICKY_MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`;
const SEED = '{"counter":0,"lastId":"T000","checksum":"seed"}';

/** The allocation statement the 2026.9.20 build runs against BARE `schema_meta`. */
const OLD_ALLOCATE_SQL = `
  UPDATE schema_meta
  SET value = json_set(value,
    '$.counter', MAX(json_extract(value, '$.counter'), ?) + 1,
    '$.lastId', 'T' || printf('%03d', MAX(json_extract(value, '$.counter'), ?) + 1),
    '$.checksum', 'alloc-' || strftime('%s','now')
  )
  WHERE key = 'task_id_sequence'`;

let root: string;
let projectDir: string;

const dbPath = (): string => join(projectDir, '.cleo', 'cleo.db');
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function tasksNative(): DatabaseSync {
  const db = getNativeDb(projectDir);
  if (!db) throw new Error('tasks native handle not bound');
  return db;
}

function brainNative(): DatabaseSync {
  const db = getBrainNativeDb(projectDir);
  if (!db) throw new Error('brain native handle not bound');
  return db;
}

/** A new CLI process: drop every binding, bind tasks and brain again. */
async function reopen(): Promise<void> {
  resetDbState();
  await getDb(projectDir);
  await getBrainDb(projectDir);
}

/** sha256 over a table's rows in a stable order: the byte-level fingerprint. */
function tableDigest(db: DatabaseSync, table: string, orderBy: string, where = '1 = 1'): string {
  const rows = db.prepare(`SELECT * FROM main.${table} WHERE ${where} ORDER BY ${orderBy}`).all();
  return sha(JSON.stringify(rows));
}

/** `tasks_schema_meta` without the failure record a failed attempt leaves. */
const NO_FAILURE = "key NOT LIKE 'twin_collapse_failed:%'";

function meta(db: DatabaseSync, table: string, key: string): string | undefined {
  return (
    db.prepare(`SELECT value FROM main.${table} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function setMeta(db: DatabaseSync, table: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO main.${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const counterOf = (value: string | undefined): number =>
  (JSON.parse(value ?? '{"counter":-1}') as { counter: number }).counter;

const maxStoredId = (db: DatabaseSync): number =>
  (
    db
      .prepare(
        "SELECT COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) AS m FROM tasks_tasks WHERE id GLOB 'T[0-9]*'",
      )
      .get() as { m: number }
  ).m;

/** Allocate through the 2026.9.20 path (bare counter, floored at the stored ids). */
function allocateOldPath(db: DatabaseSync, store: boolean): string {
  const floor = maxStoredId(db);
  db.prepare(OLD_ALLOCATE_SQL).run(floor, floor);
  const id = `T${String(counterOf(meta(db, 'schema_meta', 'task_id_sequence'))).padStart(3, '0')}`;
  if (store) db.prepare('INSERT INTO tasks_tasks (id, title) VALUES (?, ?)').run(id, `old ${id}`);
  return id;
}

/** Put the tasks side back in the pre-migration shape. */
function preMigrationTasks(twinCounter: number | null): DatabaseSync {
  const db = tasksNative();
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(SEQ_MARKER);
  setMeta(db, 'schema_meta', 'task_id_sequence', SEED); // 2026.9.20 seeds the BARE table
  setMeta(db, 'schema_meta', 'schemaVersion', '"live"');
  if (twinCounter === null) {
    db.prepare("DELETE FROM main.tasks_schema_meta WHERE key = 'task_id_sequence'").run();
  } else {
    setMeta(
      db,
      'tasks_schema_meta',
      'task_id_sequence',
      JSON.stringify({ counter: twinCounter, lastId: `T${twinCounter}`, checksum: 'exodus' }),
    );
  }
  return db;
}

/** Put the brain side back in the pre-migration shape with tagged notes. */
async function preMigrationSticky(): Promise<{ db: DatabaseSync; a: string; b: string }> {
  const a = (await addSticky({ content: 'a', tags: [] }, projectDir)).id;
  const b = (await addSticky({ content: 'b', tags: [] }, projectDir)).id;
  const db = brainNative();
  db.prepare('DELETE FROM main.brain_schema_meta WHERE key = ?').run(STICKY_MARKER);
  const bare = db.prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)');
  bare.run(a, 'alpha');
  bare.run(a, 'beta');
  bare.run(b, 'gamma');
  bare.run('SN-gone', 'orphan'); // its note no longer exists
  const twin = db.prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)');
  twin.run(a, 'alpha'); // exodus copy of a live row
  twin.run(b, 'frozen'); // exodus copy of a tag the old build removed since
  return { db, a, b };
}

function twinTags(db: DatabaseSync): string[] {
  return (
    db
      .prepare('SELECT sticky_id, tag FROM main.brain_sticky_tags ORDER BY sticky_id, tag')
      .all() as Array<{ sticky_id: string; tag: string }>
  ).map((r) => `${r.sticky_id}:${r.tag}`);
}

function migrationSnapshots(): string[] {
  const dir = join(projectDir, '.cleo', 'backups', 'sqlite');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('cleo.db.migration-')) : [];
}

function readRows(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : [];
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `twin-collapse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
  await getBrainDb(projectDir);
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('fresh store', () => {
  it('collapses both pairs on first bind without a snapshot (nothing to carry)', () => {
    expect(meta(tasksNative(), 'tasks_schema_meta', SEQ_MARKER)).toBeDefined();
    expect(meta(brainNative(), 'brain_schema_meta', STICKY_MARKER)).toBeDefined();
    expect(migrationSnapshots()).toEqual([]);
    expect(inspectTwinCollapse(tasksNative()).map((s) => s.state)).toEqual([
      'collapsed',
      'collapsed',
    ]);
  });
});

describe('(a) task-id collision probe across the upgrade', () => {
  it('ids never repeat, and the counter is MAX(bare, twin): twin stale', async () => {
    const db = preMigrationTasks(2); // stale exodus copy in the twin
    // The old build reserves T001..T005 and stores none of them as a task, so
    // only the counter protects them.
    const before = [1, 2, 3, 4, 5].map(() => allocateOldPath(db, false));
    expect(before).toEqual(['T001', 'T002', 'T003', 'T004', 'T005']);
    await reopen();
    expect(counterOf(meta(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'))).toBe(5);
    const after = [
      await allocateNextTaskId(projectDir),
      await allocateNextTaskId(projectDir),
      await allocateNextTaskId(projectDir),
    ];
    expect(after).toEqual(['T006', 'T007', 'T008']);
    expect(new Set([...before, ...after]).size).toBe(8);
  });

  it('the twin counter wins when it is the larger one', async () => {
    const db = preMigrationTasks(9);
    for (let i = 0; i < 5; i++) allocateOldPath(db, false);
    await reopen();
    expect(counterOf(meta(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'))).toBe(9);
    expect(await allocateNextTaskId(projectDir)).toBe('T010');
  });

  it('interleaved old and new builds never collide, and the counter never goes down', async () => {
    preMigrationTasks(null);
    await reopen();
    const ids: string[] = [];
    let lastCounter = 0;
    for (let round = 0; round < 4; round++) {
      // Old build: allocate in the bare table; one id stored, one only reserved.
      ids.push(allocateOldPath(tasksNative(), true));
      ids.push(allocateOldPath(tasksNative(), false));
      // New build, in a new process: allocate in the twin and store the task.
      await reopen();
      const counter = counterOf(meta(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'));
      expect(counter).toBeGreaterThanOrEqual(lastCounter);
      lastCounter = counter;
      const id = await allocateNextTaskId(projectDir);
      tasksNative().prepare('INSERT INTO tasks_tasks (id, title) VALUES (?, ?)').run(id, 'new');
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the bare table is authoritative at the initial collapse (Blocker A)', () => {
  it('drops frozen twin-only project_meta and file_meta, keeps the counters', async () => {
    const db = preMigrationTasks(3);
    setMeta(db, 'tasks_schema_meta', 'project_meta', '{"name":"fixture","currentPhase":"core"}');
    setMeta(db, 'tasks_schema_meta', 'file_meta', '{"schemaVersion":"2.10.0","generation":7}');
    setMeta(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY, '{"generation":4,"prefixes":{}}');
    const [receipt] = collapseTwinTables(db, dbPath());
    expect(receipt).toMatchObject({ table: 'schema_meta', status: 'initial' });
    expect(receipt?.dropped).toEqual(['file_meta', 'project_meta']);
    const accessor = await createSqliteDataAccessor(projectDir);
    expect(await accessor.getMetaValue('project_meta')).toBeNull(); // "No current phase set"
    expect(await accessor.getSchemaVersion()).toBeNull(); // no frozen "2.10.0"
    expect(counterOf(meta(db, 'tasks_schema_meta', 'task_id_sequence'))).toBe(3);
    expect(meta(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY)).toBeDefined();
    expect(meta(db, 'schema_meta', 'schemaVersion')).toBe('"live"'); // bare untouched
  });

  it('keeps the twin whole when the bare table holds no carried key (exodus landed it there)', () => {
    const db = tasksNative();
    db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(SEQ_MARKER);
    setMeta(db, 'tasks_schema_meta', 'project_meta', '{"name":"from-legacy"}');
    const [receipt] = collapseTwinTables(db, dbPath());
    expect(receipt).toMatchObject({ status: 'initial', dropped: [] });
    expect(meta(db, 'tasks_schema_meta', 'project_meta')).toBe('{"name":"from-legacy"}');
  });

  it('applies the documented rule per key', () => {
    const db = preMigrationTasks(4);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T900"}');
    setMeta(db, 'tasks_schema_meta', 'focus_state', '{"currentTask":"T100"}');
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}');
    setMeta(db, 'schema_meta', SNAPSHOT_GATE_META_KEY, '{"generation":3,"prefixes":{}}');
    setMeta(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY, '{"generation":8,"prefixes":{}}');
    setMeta(db, 'schema_meta', 'file_meta', '{"generation":12,"lastSessionId":"ses_live"}');
    setMeta(db, 'tasks_schema_meta', 'file_meta', '{"generation":20,"lastSessionId":"ses_old"}');
    for (let i = 0; i < 2; i++) allocateOldPath(db, false);
    const [receipt] = collapseTwinTables(db, dbPath());
    expect(receipt?.snapshotPath).not.toBeNull();
    expect(meta(db, 'tasks_schema_meta', 'focus_state')).toBe('{"currentTask":"T900"}');
    expect(meta(db, 'tasks_schema_meta', 'project_meta')).toBe('{"name":"live"}');
    expect(meta(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY)).toBe(
      '{"generation":8,"prefixes":{}}',
    );
    expect(meta(db, 'tasks_schema_meta', 'file_meta')).toBe(
      '{"generation":20,"lastSessionId":"ses_old"}',
    );
    expect(counterOf(meta(db, 'tasks_schema_meta', 'task_id_sequence'))).toBe(4);
    expect(meta(db, 'tasks_schema_meta', 'backfill:terminal-pipeline-stage')).toBeUndefined();
  });

  it('mergeSchemaMetaValue: counters take the larger value, never a sum or a reset', () => {
    const seq = (n: number) => JSON.stringify({ counter: n, lastId: `T${n}`, checksum: 'x' });
    expect(mergeSchemaMetaValue('task_id_sequence', seq(7), seq(3))).toBe('bare');
    expect(mergeSchemaMetaValue('task_id_sequence', seq(3), seq(7))).toBe('twin');
    expect(mergeSchemaMetaValue('task_id_sequence', seq(5), seq(5))).toBe('twin');
    expect(mergeSchemaMetaValue('task_id_sequence', 'not json', seq(1))).toBe('twin');
    expect(mergeSchemaMetaValue('task_id_sequence', seq(1), 'not json')).toBe('bare');
    expect(mergeSchemaMetaValue('task_id_sequence', seq(1), undefined)).toBe('bare');
    expect(
      mergeSchemaMetaValue(SNAPSHOT_GATE_META_KEY, '{"generation":2}', '{"generation":2}'),
    ).toBe('bare');
    expect(mergeSchemaMetaValue('file_meta', '{"generation":3}', '{"generation":9}')).toBe('twin');
    expect(mergeSchemaMetaValue('file_meta', '{"generation":9}', '{"generation":3}')).toBe('bare');
    expect(mergeSchemaMetaValue('backfill:x', '{}', undefined)).toBe('skip');
    expect(mergeSchemaMetaValue(`${TWIN_COLLAPSE_MARKER_PREFIX}x`, '{}', undefined)).toBe('skip');
    expect(mergeSchemaMetaValue('focus_state:ses_1', 'bare', 'twin')).toBe('bare');
  });
});

describe('incremental re-merge: the old build keeps writing the bare tables', () => {
  it('old-path writes after the marker appear in the new build reads', async () => {
    const db = preMigrationTasks(0);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T1"}');
    setMeta(db, 'schema_meta', 'parallel_state', '{"active":false}');
    await reopen();
    const accessor = await createSqliteDataAccessor(projectDir);
    // This build writes a key the old build never has.
    await accessor.setMetaValue('focus_state:ses_new', { currentTask: 'T7' });
    // The old build changes, adds and deletes keys in the bare table.
    setMeta(tasksNative(), 'schema_meta', 'focus_state', '{"currentTask":"T2"}');
    setMeta(tasksNative(), 'schema_meta', 'project_meta', '{"name":"old-build"}');
    tasksNative().prepare("DELETE FROM main.schema_meta WHERE key = 'parallel_state'").run();
    expect(inspectTwinCollapse(tasksNative())[0]).toMatchObject({
      state: 'bare-changed',
      changedSinceMerge: 3,
    });

    await reopen();
    const next = await createSqliteDataAccessor(projectDir);
    expect(await next.getMetaValue('focus_state')).toEqual({ currentTask: 'T2' });
    expect(await next.getMetaValue('project_meta')).toEqual({ name: 'old-build' });
    expect(await next.getMetaValue('parallel_state')).toBeNull(); // the deletion propagated
    expect(await next.getMetaValue('focus_state:ses_new')).toEqual({ currentTask: 'T7' });
    expect(inspectTwinCollapse(tasksNative())[0]?.state).toBe('collapsed');
  });

  it('a bare counter lower than the twin never moves the twin counter down', async () => {
    preMigrationTasks(0);
    await reopen();
    for (let i = 0; i < 6; i++) await allocateNextTaskId(projectDir); // twin → 6
    allocateOldPath(tasksNative(), false); // bare → 1
    await reopen();
    expect(counterOf(meta(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'))).toBe(6);
  });

  it('a one-shot (v1) marker is upgraded: bare rows carried again, nothing deleted', () => {
    const db = preMigrationTasks(0);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T5"}');
    setMeta(db, 'tasks_schema_meta', 'focus_state', '{"currentTask":"T1"}');
    setMeta(db, 'tasks_schema_meta', 'written_by_new_build', '"keep"');
    setMeta(db, 'tasks_schema_meta', SEQ_MARKER, '{"task":"T12535","collapsedAt":"2026-09-28"}');
    const [receipt] = collapseTwinTables(db, dbPath());
    expect(receipt?.status).toBe('incremental');
    expect(meta(db, 'tasks_schema_meta', 'focus_state')).toBe('{"currentTask":"T5"}');
    expect(meta(db, 'tasks_schema_meta', 'written_by_new_build')).toBe('"keep"');
  });
});

describe('sticky_tags', () => {
  it('initial collapse: the twin equals the bare set (frozen tags dropped, orphans skipped)', async () => {
    const { db, a, b } = await preMigrationSticky();
    const receipt = collapseTwinTables(db, dbPath()).find((r) => r.table === 'sticky_tags');
    expect(receipt).toMatchObject({
      status: 'initial',
      inserted: 2,
      deleted: 1,
      skipped: 1,
      dropped: [`${b}\tfrozen`],
    });
    expect(twinTags(db)).toEqual([`${a}:alpha`, `${a}:beta`, `${b}:gamma`].sort());
    expect(db.prepare('SELECT COUNT(*) AS c FROM main.sticky_tags').get()).toEqual({ c: 4 });
  });

  it('incremental: old-build tag changes propagate, and this build’s own tag edits survive', async () => {
    const { db, a, b } = await preMigrationSticky();
    collapseTwinTables(db, dbPath());
    // This build adds a tag to a and removes gamma from b.
    db.prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)').run(a, 'new');
    db.prepare("DELETE FROM main.brain_sticky_tags WHERE sticky_id = ? AND tag = 'gamma'").run(b);
    // The old build removes beta from a and adds delta to b.
    db.prepare("DELETE FROM main.sticky_tags WHERE sticky_id = ? AND tag = 'beta'").run(a);
    db.prepare('INSERT INTO main.sticky_tags (sticky_id, tag) VALUES (?, ?)').run(b, 'delta');

    await reopen();
    expect(twinTags(brainNative())).toEqual([`${a}:alpha`, `${a}:new`, `${b}:delta`].sort());
    expect((await listStickies({ tags: ['delta'] }, projectDir)).map((n) => n.id)).toEqual([b]);
    expect(await listStickies({ tags: ['beta'] }, projectDir)).toEqual([]);
  });
});

describe('(b) idempotency', () => {
  it('a second run is a no-op for both pairs', async () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T900"}');
    const { db: brain } = await preMigrationSticky();
    collapseTwinTables(db, dbPath());
    const tasks = tableDigest(db, 'tasks_schema_meta', 'key');
    const sticky = tableDigest(brain, 'brain_sticky_tags', 'sticky_id, tag');
    const brainKv = tableDigest(brain, 'brain_schema_meta', 'key');
    expect(collapseTwinTables(db, dbPath()).map((r) => r.status)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(tableDigest(db, 'tasks_schema_meta', 'key')).toBe(tasks);
    expect(tableDigest(brain, 'brain_sticky_tags', 'sticky_id, tag')).toBe(sticky);
    expect(tableDigest(brain, 'brain_schema_meta', 'key')).toBe(brainKv);
    expect(migrationSnapshots()).toHaveLength(1); // one snapshot for both pairs
  });
});

describe('(c) failure injection mid-migration', () => {
  it('schema_meta: both tables stay byte-identical, the error is E_TWIN_COLLAPSE_FAILED, retry completes', () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'activeSession', '"ses_1"'); // merged first (key order)
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}'); // the injected failure
    const bare = tableDigest(db, 'schema_meta', 'key');
    const twin = tableDigest(db, 'tasks_schema_meta', 'key');
    db.exec(
      "CREATE TEMP TRIGGER inject_fail BEFORE INSERT ON main.tasks_schema_meta WHEN NEW.key = 'project_meta' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    let caught: unknown;
    try {
      collapseTwinTables(db, dbPath());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 55, message: expect.stringMatching(/injected failure/) });
    expect(db.isTransaction).toBe(false);
    expect(tableDigest(db, 'schema_meta', 'key')).toBe(bare);
    // Only the failure record (written outside the rolled-back transaction) differs.
    expect(tableDigest(db, 'tasks_schema_meta', 'key', NO_FAILURE)).toBe(twin);
    expect(inspectTwinCollapse(db)[0]).toMatchObject({
      state: 'failed',
      failure: { cause: expect.stringMatching(/injected failure/) },
    });

    db.exec('DROP TRIGGER temp.inject_fail');
    expect(collapseTwinTables(db, dbPath())[0]?.status).toBe('initial');
    expect(meta(db, 'tasks_schema_meta', 'project_meta')).toBe('{"name":"live"}');
    expect(inspectTwinCollapse(db)[0]?.state).toBe('collapsed'); // failure record cleared
  });

  it('sticky_tags: a failure at the marker leaves both tables byte-identical', async () => {
    const { db } = await preMigrationSticky();
    const bare = tableDigest(db, 'sticky_tags', 'sticky_id, tag');
    const twin = tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag');
    db.exec(
      `CREATE TEMP TRIGGER inject_fail BEFORE INSERT ON main.brain_schema_meta WHEN NEW.key = '${STICKY_MARKER}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    expect(() => collapseTwinTables(db, dbPath())).toThrow(/injected failure/);
    expect(tableDigest(db, 'sticky_tags', 'sticky_id, tag')).toBe(bare);
    expect(tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag')).toBe(twin);
    expect(inspectTwinCollapse(db)[1]?.state).toBe('failed');
    db.exec('DROP TRIGGER temp.inject_fail');
    expect(collapseTwinTables(db, dbPath())[1]?.status).toBe('initial');
    expect(inspectTwinCollapse(db)[1]?.state).toBe('collapsed');
  });
});

describe('verification loop', () => {
  it('schema_meta: a value altered behind the merge fails verification and rolls back', () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}');
    const twin = tableDigest(db, 'tasks_schema_meta', 'key');
    db.exec(
      "CREATE TEMP TRIGGER tamper AFTER INSERT ON main.tasks_schema_meta WHEN NEW.key = 'project_meta' BEGIN UPDATE main.tasks_schema_meta SET value = 'tampered' WHERE key = 'project_meta'; END",
    );
    expect(() => collapseTwinTables(db, dbPath())).toThrow(/did not verify/);
    db.exec('DROP TRIGGER temp.tamper');
    expect(tableDigest(db, 'tasks_schema_meta', 'key', NO_FAILURE)).toBe(twin);
  });

  it('sticky_tags: a row removed behind the merge fails verification and rolls back', async () => {
    const { db } = await preMigrationSticky();
    const twin = tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag');
    db.exec(
      "CREATE TEMP TRIGGER tamper AFTER INSERT ON main.brain_sticky_tags WHEN NEW.tag = 'beta' BEGIN DELETE FROM main.brain_sticky_tags WHERE tag = 'beta'; END",
    );
    expect(() => collapseTwinTables(db, dbPath())).toThrow(/did not verify/);
    db.exec('DROP TRIGGER temp.tamper');
    expect(tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag')).toBe(twin);
  });
});

describe('concurrency guard: the marker is re-read under the write lock', () => {
  it('a collapse another process committed while we waited for the lock is not merged again', async () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T1"}');
    // The other process holds the write lock and commits its own collapse of
    // the same bare table, after which its user moved focus to T42 in the
    // twin. Merging again here would reset focus_state to the bare T1.
    const seen: Record<string, string> = {};
    for (const row of db
      .prepare(
        "SELECT key, value FROM main.schema_meta WHERE key NOT LIKE 'backfill:%' ORDER BY key",
      )
      .all() as Array<{ key: string; value: string }>) {
      seen[row.key] = sha(row.value);
    }
    const marker = JSON.stringify({
      version: 2,
      task: 'T12535',
      collapsedAt: 'x',
      lastMergedAt: 'x',
      snapshot: null,
      seen,
      dropped: [],
    });
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('BEGIN IMMEDIATE');
      const up = db.prepare("INSERT INTO tasks_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      up.run('focus_state', '{"currentTask":"T42"}');
      up.run(process.argv[2], process.argv[3]);
      process.stdout.write('locked\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 800);
    `;
    const child = spawn(process.execPath, ['-e', script, dbPath(), SEQ_MARKER, marker], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    await new Promise<void>((done) => child.stdout.once('data', () => done()));
    const [receipt] = collapseTwinTables(db, dbPath());
    await exited;
    expect(receipt?.status).toBe('unchanged');
    expect(meta(db, 'tasks_schema_meta', 'focus_state')).toBe('{"currentTask":"T42"}');
  }, 30_000);
});

describe('snapshot: inventoried and rotated', () => {
  it('cleo backup list shows the migration snapshot, and the migration type rotates at 10', () => {
    const dir = join(projectDir, '.cleo', 'backups', 'sqlite');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const id = `migration-2020010${i}-000000`;
      const file = join(dir, `cleo.db.${id}`);
      writeFileSync(file, 'old');
      utimesSync(file, new Date(2020, 0, i + 1), new Date(2020, 0, i + 1));
      writeFileSync(
        join(dir, `${id}.meta.json`),
        JSON.stringify({
          backupId: id,
          type: 'migration',
          timestamp: `2020-01-0${i + 1}`,
          files: ['cleo.db'],
        }),
      );
    }
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}');
    const [receipt] = collapseTwinTables(db, dbPath());
    const listed = listSystemBackups(projectDir).find((b) =>
      receipt?.snapshotPath?.endsWith(`cleo.db.${b.backupId}`),
    );
    expect(listed).toMatchObject({ type: 'migration', files: ['cleo.db'] });
    const files = migrationSnapshots();
    expect(files).toHaveLength(10);
    expect(files).not.toContain('cleo.db.migration-20200100-000000');
  });
});

describe('(d) Gate B: bare rows are a subset of the post-merge twin', () => {
  it('fingerprint-store + compare-fingerprints (merge mode) pass', async () => {
    const { db } = await preMigrationSticky();
    const work = join(root, 'gate-b');
    mkdirSync(work, { recursive: true });
    const pre = join(work, 'pre.db');
    const projection = join(work, 'bare-as-twin.db');
    const post = join(work, 'post.db');
    db.exec(`VACUUM INTO '${pre}'`);
    // The carried bare rows under the twin's name, in an otherwise identical
    // store: the SOURCE side of the subset check.
    db.exec(`VACUUM INTO '${projection}'`);
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const proj = new Sqlite(projection);
    proj.exec('DELETE FROM brain_sticky_tags');
    proj.exec(
      'INSERT INTO brain_sticky_tags (sticky_id, tag) SELECT s.sticky_id, s.tag FROM sticky_tags s WHERE EXISTS (SELECT 1 FROM brain_sticky_notes n WHERE n.id = s.sticky_id)',
    );
    proj.close();

    collapseTwinTables(db, dbPath());
    db.exec(`VACUUM INTO '${post}'`);

    const fingerprint = (file: string, label: string): string => {
      const out = join(work, `${label}.json`);
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/fingerprint-store.mjs'),
          '--db',
          file,
          '--label',
          label,
          '--out',
          out,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      return out;
    };
    const compare = (source: string, replica: string, allowDeleted?: string): string =>
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/compare-fingerprints.mjs'),
          '--source',
          source,
          '--replica',
          replica,
          '--mode',
          'merge',
          ...(allowDeleted ? ['--allow-deleted', allowDeleted] : []),
        ],
        { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
      );
    const fpPre = fingerprint(pre, 'pre');
    const fpProjection = fingerprint(projection, 'bare-as-twin');
    const fpPost = fingerprint(post, 'post');
    // Control: the same check against the PRE-migration twin fails.
    expect(() => compare(fpProjection, fpPre)).toThrow();
    // Every carried bare row is in the post-merge twin …
    const subset = compare(fpProjection, fpPost);
    // … and the pre-migration store lost exactly one syncing row: the frozen
    // twin tag the bare-authoritative rule drops, passed as an allowed deletion.
    const postRows = new Set(readRows(`${fpPost}.rows`));
    const dropped = readRows(`${fpPre}.rows`).filter((r) => !postRows.has(r));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.startsWith('brain_sticky_tags\t')).toBe(true);
    const allowed = join(work, 'allowed-deleted.rows');
    writeFileSync(allowed, `${dropped.join('\n')}\n`);
    const lossless = compare(fpPre, fpPost, allowed);
    if (process.env.T12535_GATE_B_OUT)
      writeFileSync(process.env.T12535_GATE_B_OUT, [subset, lossless].join('\n---\n'));
    expect(subset).toMatch(/PASS/);
    expect(lossless).toMatch(/PASS/);
  }, 120_000);
});
