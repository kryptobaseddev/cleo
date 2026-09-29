/**
 * Mixed versions after the `schema_meta` / `sticky_tags` twin collapse
 * (T12535): the 2026.9.20 build keeps allocating task ids from the BARE
 * `schema_meta` counter and retagging stickies through the BARE junction
 * while this build uses the twins.
 *
 * - Counters: every write of a counter key (`task_id_sequence`,
 *   `sqlite_snapshot_gate`, `file_meta`) also raises the bare row's counter
 *   field to the twin's, inside the same transaction, and the allocation
 *   floors on the bare counter too. Neither build can hand out an id the
 *   other has reserved but not stored yet.
 * - Sticky tags: after every merge the junction is recomputed from each
 *   note's `tags_json` (the shared column both builds write), so tag filters
 *   and displayed tags never disagree.
 *
 * "Old build" means the 2026.9.20 SQL run against the bare tables.
 *
 * @task T12535
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateNextTaskId } from '../../sequence/index.js';
import { addSticky } from '../../sticky/create.js';
import { listStickies } from '../../sticky/list.js';
import { getBrainAccessor } from '../memory-accessor.js';
import { closeBrainDb, getBrainDb } from '../memory-sqlite.js';
import { runGatedSnapshot, SNAPSHOT_GATE_META_KEY } from '../snapshot-gate.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import { inspectTwinCollapse, SCHEMA_META_COUNTER_FIELDS } from '../twin-collapse.js';

let root: string;
let projectDir: string;

function db(): DatabaseSync {
  const handle = getNativeDb(projectDir);
  if (!handle) throw new Error('tasks native handle not bound');
  return handle;
}

/** A new CLI process: drop every binding, bind tasks and brain again. */
async function reopen(): Promise<void> {
  resetDbState();
  await getDb(projectDir);
  await getBrainDb(projectDir);
}

function meta(table: string, key: string): string | undefined {
  return (
    db().prepare(`SELECT value FROM main.${table} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
  )?.value;
}

const field = (value: string | undefined, name: string): number | undefined =>
  value === undefined ? undefined : (JSON.parse(value) as Record<string, number>)[name];

/**
 * The 2026.9.20 allocation (`sequence/index.ts` at v2026.9.20): floor at the
 * highest stored id, advance the BARE counter, probe `tasks_tasks`.
 */
function allocateOldBuild(store: boolean): string {
  const floor = (
    db()
      .prepare(
        "SELECT COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) AS m FROM tasks_tasks WHERE id GLOB 'T[0-9]*' AND substr(id, 2) NOT GLOB '*[^0-9]*'",
      )
      .get() as { m: number }
  ).m;
  db()
    .prepare(`
      UPDATE schema_meta
      SET value = json_set(value,
        '$.counter', MAX(json_extract(value, '$.counter'), ?) + 1,
        '$.lastId', 'T' || printf('%03d', MAX(json_extract(value, '$.counter'), ?) + 1),
        '$.checksum', 'alloc-' || strftime('%s','now')
      )
      WHERE key = 'task_id_sequence'`)
    .run(floor, floor);
  const id = `T${String(field(meta('schema_meta', 'task_id_sequence'), 'counter')).padStart(3, '0')}`;
  if (store) insertTask(id, 'old build');
  return id;
}

function insertTask(id: string, title: string): void {
  db().prepare('INSERT INTO tasks_tasks (id, title) VALUES (?, ?)').run(id, title);
}

/**
 * An upgraded store: the older build's bare counter row exists (a copy of the
 * twin's), as on every store the 2026.9.20 build has opened.
 */
async function upgradedStore(): Promise<void> {
  db()
    .prepare(
      "INSERT OR REPLACE INTO main.schema_meta (key, value) SELECT key, value FROM main.tasks_schema_meta WHERE key = 'task_id_sequence'",
    )
    .run();
  await reopen();
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `counter-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
  await getBrainDb(projectDir);
});

afterEach(() => {
  closeBrainDb();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('task ids: the two builds never issue the same id', () => {
  it('collision probe: an id this build reserved (not stored yet) is never re-issued by the old build', async () => {
    await upgradedStore();
    const mine = await allocateNextTaskId(projectDir); // reserved, not stored
    const theirs = allocateOldBuild(false);
    expect(theirs).not.toBe(mine);
    expect(Number(theirs.slice(1))).toBe(Number(mine.slice(1)) + 1);
  });

  it('interleave: the old build allocates and stores between this build allocating and inserting', async () => {
    await upgradedStore();
    const ids: string[] = [];
    for (let round = 0; round < 3; round++) {
      const mine = await allocateNextTaskId(projectDir);
      const theirs = allocateOldBuild(true); // lands before this build's insert
      insertTask(mine, 'new build'); // must not collide
      ids.push(mine, theirs);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the reverse: an id the old build reserved (not stored yet) is never issued by this build', async () => {
    await upgradedStore();
    const theirs = allocateOldBuild(false);
    const mine = await allocateNextTaskId(projectDir);
    expect(mine).not.toBe(theirs);
  });

  it('the bare counter never goes down, and the next open reports no conflict', async () => {
    await upgradedStore();
    for (let i = 0; i < 3; i++) await allocateNextTaskId(projectDir);
    const twin = field(meta('tasks_schema_meta', 'task_id_sequence'), 'counter');
    expect(field(meta('schema_meta', 'task_id_sequence'), 'counter')).toBe(twin);
    await reopen();
    expect(field(meta('tasks_schema_meta', 'task_id_sequence'), 'counter')).toBe(twin);
    expect(inspectTwinCollapse(db())[0]).toMatchObject({ state: 'collapsed', conflicts: [] });
  });
});

describe('the other counters are mirrored the same way', () => {
  it('file_meta.generation: the bare record keeps its fields, its generation follows the twin', async () => {
    db()
      .prepare("INSERT OR REPLACE INTO main.schema_meta (key, value) VALUES ('file_meta', ?)")
      .run(JSON.stringify({ lastSessionId: 'ses_old', generation: 3 }));
    await reopen();
    const accessor = await createSqliteDataAccessor(projectDir);
    await accessor.setMetaValue('file_meta', { lastSessionId: 'ses_new', generation: 8 });
    expect(JSON.parse(meta('schema_meta', 'file_meta') ?? '{}')).toEqual({
      lastSessionId: 'ses_old',
      generation: 8,
    });
  });

  it('sqlite_snapshot_gate.generation follows the twin in the bare row', async () => {
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    await runGatedSnapshot(
      { backupDir, stateDb: db(), prefixes: ['tasks'], mode: 'routine' },
      async () => 'written',
    );
    const twin = field(meta('tasks_schema_meta', SNAPSHOT_GATE_META_KEY), 'generation');
    expect(twin).toBeGreaterThan(0);
    expect(field(meta('schema_meta', SNAPSHOT_GATE_META_KEY), 'generation')).toBe(twin);
  });

  it('the collapse counts the snapshot gate key as a counter (spelled out to avoid an import cycle)', () => {
    expect(SCHEMA_META_COUNTER_FIELDS[SNAPSHOT_GATE_META_KEY]).toBe('generation');
  });

  it('a non-counter key is never written to the bare table', async () => {
    const accessor = await createSqliteDataAccessor(projectDir);
    await accessor.setMetaValue('focus_state', { currentTask: 'T9' });
    expect(meta('schema_meta', 'focus_state')).toBeUndefined();
  });
});

describe('sticky tags: the junction always matches tags_json', () => {
  it('both builds retag one note: the merged junction follows tags_json (no drift)', async () => {
    const note = await addSticky({ content: 'n', tags: ['x'] }, projectDir);
    await reopen();
    const accessor = await getBrainAccessor(projectDir);
    await accessor.updateStickyNote(note.id, { tagsJson: JSON.stringify(['y']) }); // this build
    // The old build: rewrites the shared note row's tags_json and its BARE junction.
    db().prepare('UPDATE brain_sticky_notes SET tags_json = ? WHERE id = ?').run('["z"]', note.id);
    db().prepare('DELETE FROM sticky_tags WHERE sticky_id = ?').run(note.id);
    db().prepare('INSERT INTO sticky_tags (sticky_id, tag) VALUES (?, ?)').run(note.id, 'z');
    await reopen();
    expect(
      db().prepare('SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ?').all(note.id),
    ).toEqual([{ tag: 'z' }]);
    expect((await listStickies({ tags: ['z'] }, projectDir)).map((n) => n.id)).toEqual([note.id]);
    expect(await listStickies({ tags: ['y'] }, projectDir)).toEqual([]);
  });

  it('a note whose junction drifted from tags_json is repaired by the next merge', async () => {
    const a = await addSticky({ content: 'a', tags: ['keep'] }, projectDir);
    const b = await addSticky({ content: 'b', tags: ['t1'] }, projectDir);
    // Drift on note a (twin junction only), plus an old-build write on b so a merge runs.
    db()
      .prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)')
      .run(a.id, 'stale');
    db().prepare('INSERT INTO sticky_tags (sticky_id, tag) VALUES (?, ?)').run(b.id, 't1');
    await reopen();
    expect(
      db()
        .prepare('SELECT tag FROM main.brain_sticky_tags WHERE sticky_id = ? ORDER BY tag')
        .all(a.id),
    ).toEqual([{ tag: 'keep' }]);
  });
});
