/**
 * Twin collapse, slice 1 (T12535): the runtime writes and reads the PREFIXED
 * twin of `schema_meta` and `sticky_tags`, never the bare legacy table.
 *
 * Each writer runs through its real code path on a fresh migrated project
 * store. Both twins are counted before and after: the prefixed twin gains the
 * rows and the bare twin gains none. Each reader is then shown a value planted
 * only in the prefixed twin, next to a conflicting value planted only in the
 * bare twin, and must return the prefixed one.
 *
 * The two pairs were chosen because their physical schemas are identical
 * (columns, types, defaults, PK, FKs, indexes; no CHECKs); every other live
 * bare table differs from its twin and is held back for the slice-2 merge
 * rules.
 *
 * @task T12535
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateNextTaskId, showSequence } from '../../sequence/index.js';
import { addSticky } from '../../sticky/create.js';
import { listStickies } from '../../sticky/list.js';
import { getBrainAccessor } from '../memory-accessor.js';
import { closeBrainDb, getBrainNativeDb } from '../memory-sqlite.js';
import {
  readSnapshotGeneration,
  runGatedSnapshot,
  SNAPSHOT_GATE_META_KEY,
} from '../snapshot-gate.js';
import { getDb, getNativeDb, getSchemaVersion, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor, setMetaValue } from '../sqlite-data-accessor.js';

let root: string;
let projectDir: string;

function count(db: DatabaseSync, table: string, where = '1 = 1'): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
}

function tasksNative(): DatabaseSync {
  const db = getNativeDb(projectDir);
  if (!db) throw new Error('tasks native handle not bound');
  return db;
}

function brainNative(): DatabaseSync {
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain native handle not bound');
  return db;
}

/** Row counts of both twins, for a before/after comparison. */
function twins(db: DatabaseSync, bare: string, prefixed: string, where?: string) {
  return { bare: count(db, bare, where), prefixed: count(db, prefixed, where) };
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
});

afterEach(() => {
  closeBrainDb();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('schema_meta → tasks_schema_meta: writers', () => {
  it('seedTasksMeta seeds the prefixed twin only', () => {
    const db = tasksNative();
    const seeded = "key IN ('schemaVersion', 'task_id_sequence')";
    expect(count(db, 'tasks_schema_meta', seeded)).toBe(2);
    expect(count(db, 'schema_meta', seeded)).toBe(0);
  });

  it('allocateNextTaskId advances the prefixed counter and mirrors only the counter to the bare row', async () => {
    const db = tasksNative();
    const before = twins(db, 'schema_meta', 'tasks_schema_meta');
    expect(await allocateNextTaskId(projectDir)).toBe('T001');
    expect(await allocateNextTaskId(projectDir)).toBe('T002');
    // The one sanctioned bare write (T12535): the task_id_sequence counter row.
    expect(twins(db, 'schema_meta', 'tasks_schema_meta')).toEqual({
      bare: before.bare + 1,
      prefixed: before.prefixed,
    });
    expect(count(db, 'schema_meta', "key <> 'task_id_sequence'")).toBe(before.bare);
    const counter = db
      .prepare(
        "SELECT json_extract(value, '$.counter') AS c FROM tasks_schema_meta WHERE key = 'task_id_sequence'",
      )
      .get() as { c: number };
    expect(counter.c).toBe(2);
  });

  it('setMetaValue (tasks accessor) lands in the prefixed twin only', async () => {
    const db = tasksNative();
    const before = twins(db, 'schema_meta', 'tasks_schema_meta');
    await setMetaValue(projectDir, 'focus_state', { currentTask: 'T777' });
    expect(twins(db, 'schema_meta', 'tasks_schema_meta')).toEqual({
      bare: before.bare,
      prefixed: before.prefixed + 1,
    });
    expect(count(db, 'tasks_schema_meta', "key = 'focus_state'")).toBe(1);
  });

  it('the snapshot gate persists its state in the prefixed twin (generation mirrored to the bare row)', async () => {
    const db = tasksNative();
    const before = twins(db, 'schema_meta', 'tasks_schema_meta');
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const result = await runGatedSnapshot(
      { backupDir, stateDb: db, prefixes: ['tasks'], mode: 'routine' },
      async () => 'written',
    );
    expect(result.snapshotted).toEqual(['tasks']);
    expect(twins(db, 'schema_meta', 'tasks_schema_meta')).toEqual({
      bare: before.bare + 1, // the generation mirror (T12535)
      prefixed: before.prefixed + 1,
    });
  });
});

describe('schema_meta → tasks_schema_meta: readers', () => {
  /** Plant a value in each twin; the reader must return the prefixed one. */
  function plant(key: string, prefixed: string, bare: string): void {
    const db = tasksNative();
    db.prepare(
      'INSERT INTO tasks_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, prefixed);
    db.prepare(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, bare);
  }

  it('the sequence reader reads the prefixed counter', async () => {
    plant(
      'task_id_sequence',
      '{"counter":41,"lastId":"T041","checksum":"prefixed"}',
      '{"counter":900,"lastId":"T900","checksum":"bare"}',
    );
    expect((await showSequence(projectDir)).counter).toBe(41);
    // Allocation also floors on the older build's bare counter (T12535), so an
    // id that build may have reserved is never issued here.
    expect(await allocateNextTaskId(projectDir)).toBe('T901');
  });

  it('getMetaValue (tasks accessor) reads the prefixed row', async () => {
    plant('focus_state', '{"currentTask":"T100"}', '{"currentTask":"T999"}');
    const accessor = await createSqliteDataAccessor(projectDir);
    expect(await accessor.getMetaValue('focus_state')).toEqual({ currentTask: 'T100' });
  });

  it('getSchemaVersion reads the prefixed row', async () => {
    plant('schemaVersion', 'prefixed-version', 'bare-version');
    expect(await getSchemaVersion(projectDir)).toBe('prefixed-version');
  });

  it('readSnapshotGeneration reads the prefixed gate state', () => {
    plant(
      SNAPSHOT_GATE_META_KEY,
      '{"generation":7,"prefixes":{}}',
      '{"generation":99,"prefixes":{}}',
    );
    expect(readSnapshotGeneration(tasksNative())).toBe(7);
  });
});

describe('sticky_tags → brain_sticky_tags', () => {
  it('create, update and delete write the prefixed junction only', async () => {
    const note = await addSticky({ content: 'tagged', tags: ['alpha', 'beta'] }, projectDir);
    const db = brainNative();
    const mine = `sticky_id = '${note.id}'`;
    expect(twins(db, 'sticky_tags', 'brain_sticky_tags', mine)).toEqual({ bare: 0, prefixed: 2 });

    const accessor = await getBrainAccessor(projectDir);
    await accessor.updateStickyNote(note.id, { tagsJson: JSON.stringify(['gamma']) });
    expect(twins(db, 'sticky_tags', 'brain_sticky_tags', mine)).toEqual({ bare: 0, prefixed: 1 });

    // A bare row for the same note must survive: the delete no longer touches it.
    db.prepare('INSERT INTO sticky_tags (sticky_id, tag) VALUES (?, ?)').run(note.id, 'legacy');
    await accessor.deleteStickyNote(note.id);
    expect(twins(db, 'sticky_tags', 'brain_sticky_tags', mine)).toEqual({ bare: 1, prefixed: 0 });
  });

  it('the tag filter reads the prefixed junction', async () => {
    const a = await addSticky({ content: 'a', tags: [] }, projectDir);
    const b = await addSticky({ content: 'b', tags: [] }, projectDir);
    const db = brainNative();
    db.prepare('INSERT INTO brain_sticky_tags (sticky_id, tag) VALUES (?, ?)').run(a.id, 'probe');
    db.prepare('INSERT INTO sticky_tags (sticky_id, tag) VALUES (?, ?)').run(b.id, 'probe');
    const found = await listStickies({ tags: ['probe'] }, projectDir);
    expect(found.map((n) => n.id)).toEqual([a.id]);
  });
});
