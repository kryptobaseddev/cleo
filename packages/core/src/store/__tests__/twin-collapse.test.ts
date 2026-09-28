/**
 * Atomic twin collapses (T12535): `schema_meta` → `tasks_schema_meta` and
 * `sticky_tags` → `brain_sticky_tags`.
 *
 * Every case starts from a fresh migrated store put back into the
 * PRE-MIGRATION shape: the collapse marker removed, and the bare tables
 * written the way the previous release wrote them (the old allocation SQL on
 * bare `schema_meta`, tags in bare `sticky_tags`). The twins hold what an
 * upgraded store holds: a seed or a stale exodus copy.
 *
 * Covered: (a) task-id collision probe across the upgrade, (b) idempotency,
 * (c) failure injection mid-migration, (d) the Gate B subset proof with
 * `scripts/fingerprint-store.mjs` + `scripts/compare-fingerprints.mjs`, and
 * the documented per-key merge rules.
 *
 * @task T12535
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateNextTaskId } from '../../sequence/index.js';
import { addSticky } from '../../sticky/create.js';
import { closeBrainDb, getBrainDb, getBrainNativeDb } from '../memory-sqlite.js';
import { SNAPSHOT_GATE_META_KEY } from '../snapshot-gate.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import {
  collapseSchemaMetaTwin,
  collapseStickyTagsTwin,
  mergeSchemaMetaValue,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SEQ_MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`;
const STICKY_MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}sticky_tags`;

/** The allocation statement the previous release ran against BARE `schema_meta`. */
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

function dbPath(): string {
  return join(projectDir, '.cleo', 'cleo.db');
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

/** sha256 over a table's rows in a stable order: the byte-level fingerprint. */
function tableDigest(db: DatabaseSync, table: string, orderBy: string): string {
  const rows = db.prepare(`SELECT * FROM main.${table} ORDER BY ${orderBy}`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function metaValue(db: DatabaseSync, table: string, key: string): string | undefined {
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

function counterOf(value: string | undefined): number {
  return (JSON.parse(value ?? '{}') as { counter: number }).counter;
}

/** Put the tasks side back in the pre-migration shape: no marker, live bare seed. */
function preMigrationTasks(twinCounter: number | null): DatabaseSync {
  const db = tasksNative();
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(SEQ_MARKER);
  // The previous release seeded the BARE table on every open.
  setMeta(db, 'schema_meta', 'task_id_sequence', '{"counter":0,"lastId":"T000","checksum":"seed"}');
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

/** Allocate through the previous release's path (bare table), returning the ids. */
function allocateOldPath(db: DatabaseSync, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    db.prepare(OLD_ALLOCATE_SQL).run(0, 0);
    ids.push(
      `T${String(counterOf(metaValue(db, 'schema_meta', 'task_id_sequence'))).padStart(3, '0')}`,
    );
  }
  return ids;
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
  // The twin already holds one of them (an exodus copy) and one of its own.
  const twin = db.prepare('INSERT INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)');
  twin.run(a, 'alpha');
  twin.run(b, 'twin-only');
  return { db, a, b };
}

function snapshots(): string[] {
  const dir = join(projectDir, '.cleo', 'backups');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('cleo-pre-t12535-')) : [];
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
  closeBrainDb();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('fresh store', () => {
  it('collapses both twins on first bind without a snapshot (nothing to carry)', () => {
    expect(metaValue(tasksNative(), 'tasks_schema_meta', SEQ_MARKER)).toBeDefined();
    expect(metaValue(brainNative(), 'brain_schema_meta', STICKY_MARKER)).toBeDefined();
    expect(snapshots()).toEqual([]);
  });
});

describe('(a) task-id collision probe across the upgrade', () => {
  it('ids never repeat, and the counter is MAX(bare, twin) — twin stale', async () => {
    const db = preMigrationTasks(2); // stale exodus copy in the twin
    // The previous release reserved T001..T005; none of them is stored as a
    // task (e.g. purged), so only the counter protects them.
    const before = allocateOldPath(db, 5);
    expect(before).toEqual(['T001', 'T002', 'T003', 'T004', 'T005']);

    // Upgrade: the next open runs the collapse inside the bind.
    resetDbState();
    await getDb(projectDir);
    expect(counterOf(metaValue(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'))).toBe(5);

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
    allocateOldPath(db, 5);
    resetDbState();
    await getDb(projectDir);
    expect(counterOf(metaValue(tasksNative(), 'tasks_schema_meta', 'task_id_sequence'))).toBe(9);
    expect(await allocateNextTaskId(projectDir)).toBe('T010');
  });

  it('a twin without the key takes the bare counter', async () => {
    const db = preMigrationTasks(null);
    allocateOldPath(db, 3);
    resetDbState();
    await getDb(projectDir);
    expect(await allocateNextTaskId(projectDir)).toBe('T004');
  });
});

describe('schema_meta merge rules', () => {
  it('applies the documented rule per key', () => {
    const db = preMigrationTasks(4);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T900"}');
    setMeta(db, 'tasks_schema_meta', 'focus_state', '{"currentTask":"T100"}');
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}');
    setMeta(db, 'schema_meta', SNAPSHOT_GATE_META_KEY, '{"generation":3,"prefixes":{}}');
    setMeta(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY, '{"generation":8,"prefixes":{}}');
    setMeta(db, 'tasks_schema_meta', 'twin_only', 'kept');
    allocateOldPath(db, 2);

    const receipt = collapseSchemaMetaTwin(db, dbPath());
    expect(receipt.status).toBe('collapsed');
    expect(receipt.snapshotPath).not.toBeNull();
    expect(snapshots()).toHaveLength(1);

    expect(metaValue(db, 'tasks_schema_meta', 'focus_state')).toBe('{"currentTask":"T900"}'); // bare wins
    expect(metaValue(db, 'tasks_schema_meta', 'project_meta')).toBe('{"name":"live"}'); // carried
    expect(metaValue(db, 'tasks_schema_meta', SNAPSHOT_GATE_META_KEY)).toBe(
      '{"generation":8,"prefixes":{}}',
    ); // larger generation
    expect(counterOf(metaValue(db, 'tasks_schema_meta', 'task_id_sequence'))).toBe(4); // MAX(2, 4)
    expect(metaValue(db, 'tasks_schema_meta', 'twin_only')).toBe('kept');
    expect(metaValue(db, 'tasks_schema_meta', 'backfill:terminal-pipeline-stage')).toBeUndefined();
    // The bare table itself is never modified.
    expect(metaValue(db, 'schema_meta', 'focus_state')).toBe('{"currentTask":"T900"}');
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
    expect(mergeSchemaMetaValue('backfill:x', '{}', undefined)).toBe('skip');
    expect(mergeSchemaMetaValue(`${TWIN_COLLAPSE_MARKER_PREFIX}x`, '{}', undefined)).toBe('skip');
    expect(mergeSchemaMetaValue('focus_state:ses_1', 'bare', 'twin')).toBe('bare');
  });
});

describe('sticky_tags union', () => {
  it('carries every bare tag whose note exists, keeps twin-only rows, skips orphans', async () => {
    const { db, a, b } = await preMigrationSticky();
    const receipt = collapseStickyTagsTwin(db, dbPath());
    expect(receipt).toMatchObject({ status: 'collapsed', inserted: 2, kept: 1, skipped: 1 });
    const rows = db
      .prepare('SELECT sticky_id, tag FROM main.brain_sticky_tags ORDER BY sticky_id, tag')
      .all();
    expect(rows).toEqual(
      [
        { sticky_id: a, tag: 'alpha' },
        { sticky_id: a, tag: 'beta' },
        { sticky_id: b, tag: 'gamma' },
        { sticky_id: b, tag: 'twin-only' },
      ].sort((x, y) => (x.sticky_id + x.tag).localeCompare(y.sticky_id + y.tag)),
    );
    expect(db.prepare('SELECT COUNT(*) AS c FROM main.sticky_tags').get()).toEqual({ c: 4 });
  });
});

describe('(b) idempotency', () => {
  it('schema_meta: a second run is a no-op, and re-running the merge gives the same table', () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'focus_state', '{"currentTask":"T900"}');
    allocateOldPath(db, 3);
    collapseSchemaMetaTwin(db, dbPath());
    const first = tableDigest(db, 'tasks_schema_meta', 'key');

    expect(collapseSchemaMetaTwin(db, dbPath()).status).toBe('already-collapsed');
    expect(tableDigest(db, 'tasks_schema_meta', 'key')).toBe(first);

    // Without the marker, the merge itself converges to the same rows.
    const withoutMarker = (): string => {
      const rows = db
        .prepare('SELECT key, value FROM main.tasks_schema_meta WHERE key <> ? ORDER BY key')
        .all(SEQ_MARKER);
      return JSON.stringify(rows);
    };
    const merged = withoutMarker();
    db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(SEQ_MARKER);
    expect(collapseSchemaMetaTwin(db, dbPath()).status).toBe('collapsed');
    expect(withoutMarker()).toBe(merged);
  });

  it('sticky_tags: a second run is a no-op, and re-running the merge gives the same table', async () => {
    const { db } = await preMigrationSticky();
    collapseStickyTagsTwin(db, dbPath());
    const first = tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag');
    expect(collapseStickyTagsTwin(db, dbPath()).status).toBe('already-collapsed');
    db.prepare('DELETE FROM main.brain_schema_meta WHERE key = ?').run(STICKY_MARKER);
    expect(collapseStickyTagsTwin(db, dbPath())).toMatchObject({
      status: 'collapsed',
      inserted: 0,
    });
    expect(tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag')).toBe(first);
  });
});

describe('(c) failure injection mid-migration', () => {
  it('schema_meta: both tables stay byte-identical, and the next run completes', () => {
    const db = preMigrationTasks(2);
    setMeta(db, 'schema_meta', 'activeSession', '"ses_1"'); // merged first (key order)
    setMeta(db, 'schema_meta', 'project_meta', '{"name":"live"}'); // the injected failure
    allocateOldPath(db, 3);
    const bare = tableDigest(db, 'schema_meta', 'key');
    const twin = tableDigest(db, 'tasks_schema_meta', 'key');
    db.exec(
      "CREATE TEMP TRIGGER inject_fail BEFORE INSERT ON main.tasks_schema_meta WHEN NEW.key = 'project_meta' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    expect(() => collapseSchemaMetaTwin(db, dbPath())).toThrow(/injected failure/);
    expect(tableDigest(db, 'schema_meta', 'key')).toBe(bare);
    expect(tableDigest(db, 'tasks_schema_meta', 'key')).toBe(twin);
    expect(db.isTransaction).toBe(false);

    db.exec('DROP TRIGGER temp.inject_fail');
    expect(collapseSchemaMetaTwin(db, dbPath()).status).toBe('collapsed');
    expect(metaValue(db, 'tasks_schema_meta', 'project_meta')).toBe('{"name":"live"}');
    expect(counterOf(metaValue(db, 'tasks_schema_meta', 'task_id_sequence'))).toBe(3);
  });

  it('sticky_tags: a failure at the marker leaves both tables byte-identical', async () => {
    const { db } = await preMigrationSticky();
    const bare = tableDigest(db, 'sticky_tags', 'sticky_id, tag');
    const twin = tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag');
    db.exec(
      `CREATE TEMP TRIGGER inject_fail BEFORE INSERT ON main.brain_schema_meta WHEN NEW.key = '${STICKY_MARKER}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    expect(() => collapseStickyTagsTwin(db, dbPath())).toThrow(/injected failure/);
    expect(tableDigest(db, 'sticky_tags', 'sticky_id, tag')).toBe(bare);
    expect(tableDigest(db, 'brain_sticky_tags', 'sticky_id, tag')).toBe(twin);
    db.exec('DROP TRIGGER temp.inject_fail');
    expect(collapseStickyTagsTwin(db, dbPath()).status).toBe('collapsed');
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
    // The bare rows under the twin's name, in an otherwise identical store: the
    // SOURCE side of the subset check (orphans excluded: the rule does not carry them).
    db.exec(`VACUUM INTO '${projection}'`);
    const { DatabaseSync: Sqlite } = await import('node:sqlite');
    const proj = new Sqlite(projection);
    proj.exec('DELETE FROM brain_sticky_tags');
    proj.exec(
      'INSERT INTO brain_sticky_tags (sticky_id, tag) SELECT s.sticky_id, s.tag FROM sticky_tags s WHERE EXISTS (SELECT 1 FROM brain_sticky_notes n WHERE n.id = s.sticky_id)',
    );
    proj.close();

    collapseStickyTagsTwin(db, dbPath());
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
    const compare = (source: string, replica: string): string =>
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
        ],
        { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' },
      );
    const fpPre = fingerprint(pre, 'pre');
    const fpProjection = fingerprint(projection, 'bare-as-twin');
    const fpPost = fingerprint(post, 'post');
    // Control: the same check against the PRE-migration twin fails, so the
    // oracle does see the bare rows the twin lacked.
    expect(() => compare(fpProjection, fpPre)).toThrow();
    // Every bare (carried) row is in the post-merge twin …
    const subset = compare(fpProjection, fpPost);
    // … and no syncing row of the pre-migration store was lost.
    const lossless = compare(fpPre, fpPost);
    if (process.env.T12535_GATE_B_OUT)
      writeFileSync(process.env.T12535_GATE_B_OUT, [subset, lossless].join('\n---\n'));
    expect(subset).toMatch(/PASS/);
    expect(lossless).toMatch(/PASS/);
  }, 120_000);
});
