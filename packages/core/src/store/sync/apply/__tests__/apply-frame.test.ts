/**
 * The apply frame and its write API (T12344 PR-2; journal spec §3.2, §3.3).
 *
 * The decisive property: what the write API records is exactly what the
 * capture triggers capture, so the sealer seals nothing for a write the apply
 * fully explains, and only the residual for anything else in the frame. The
 * stores are real project `cleo.db` files with capture and seal on, under a
 * `mkdtemp` directory.
 *
 * @task T12344
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../../dual-scope-db.js';
import { captureTableDef, setCaptureEnabled } from '../../capture.js';
import { setSyncFlag } from '../../flags.js';
import { readRowMeta } from '../../row-meta.js';
import { rowChash, sealPending } from '../../sealer.js';
import { ApplyFrameError, runApplyFrame, withApplyFrame } from '../frame.js';
import { ApplyWriteError, wireToSql } from '../write-api.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
let clock = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-apply-frame-'));
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

async function store(capture = true): Promise<DatabaseSync> {
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', dbPath));
  if (capture) {
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  return db;
}

/** Seal for real; a refused seal would make "seals nothing" vacuous, so it fails the test. */
function seal(db: DatabaseSync) {
  const r = sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });
  expect(r.refused ?? null, 'sealing was refused').toBeNull();
  return r;
}

const n = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

const sealedOps = (db: DatabaseSync) =>
  (
    db.prepare('SELECT o, body FROM _sync_op ORDER BY txn, idx').all() as Array<{
      o: string;
      body: string;
    }>
  ).map((r) => ({
    o: r.o,
    ...(JSON.parse(r.body) as { u?: string; a?: Record<string, unknown> }),
  }));

/** A task as a local write (sealed as ordinary ops). */
function localTask(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  db.prepare(
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
  ).run(id, `title ${id}`, `uid-${id}`, `fp-${id}`);
  db.exec('COMMIT');
}

describe('withApplyFrame (§3.2)', () => {
  it('commits the body and labels its captures as an apply frame', async () => {
    const db = await store();
    withApplyFrame(db, 'project', '{"agent":"remote"}', (api) => {
      expect(api.frame).toEqual(expect.any(String));
      api.insertRow('tasks_tasks', 'uid-R1', {
        id: 'R1',
        title: 'remote',
        type: 'task',
        status: 'pending',
        birth_fp: 'fp-R1',
      });
    });
    expect(n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'R1'")).toBe(1);
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE kind = 'apply'")).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('a thenable result rolls back and throws E_SYNC_APPLY_ASYNC', async () => {
    const db = await store();
    const asyncBody = (api: Parameters<Parameters<typeof withApplyFrame>[3]>[0]): never => {
      api.insertRow('tasks_tasks', 'uid-R1', {
        id: 'R1',
        title: 'x',
        type: 'task',
        status: 'pending',
        birth_fp: 'fp',
      });
      return Promise.resolve(1) as never;
    };
    expect(() => withApplyFrame(db, 'project', null, asyncBody)).toThrow(
      expect.objectContaining({ code: 'E_SYNC_APPLY_ASYNC' }),
    );
    expect(n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'R1'")).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('refuses to nest inside a transaction, and the API is dead after the frame', async () => {
    const db = await store();
    db.exec('BEGIN');
    expect(() => withApplyFrame(db, 'project', null, () => 1)).toThrow(ApplyFrameError);
    db.exec('ROLLBACK');
    let leaked: Parameters<Parameters<typeof withApplyFrame>[3]>[0] | undefined;
    withApplyFrame(db, 'project', null, (api) => {
      leaked = api;
    });
    expect(() => leaked?.readRow('tasks_tasks', 'x')).toThrow(
      expect.objectContaining({ code: 'E_SYNC_APPLY_ENDED' }),
    );
  });

  it('runApplyFrame awaits the preparation, then runs the synchronous body on the handle queue', async () => {
    const db = await store();
    const out = await runApplyFrame(
      db,
      'project',
      null,
      async () => 'prepared-title',
      (api, title) => {
        api.insertRow('tasks_tasks', 'uid-R1', {
          id: 'R1',
          title,
          type: 'task',
          status: 'pending',
          birth_fp: 'fp',
        });
        return api.readRow('tasks_tasks', 'uid-R1')?.title;
      },
    );
    expect(out).toBe('prepared-title');
  });

  it('with capture off it writes without a frame or intents', async () => {
    const db = await store(false);
    withApplyFrame(db, 'project', null, (api) => {
      expect(api.frame).toBeNull();
      api.insertRow('tasks_tasks', 'uid-R1', {
        id: 'R1',
        title: 'x',
        type: 'task',
        status: 'pending',
        birth_fp: 'fp',
      });
    });
    expect(n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'R1'")).toBe(1);
  });
});

describe('the write API records exactly what the triggers capture (§3.3)', () => {
  it('an applied insert seals nothing', async () => {
    const db = await store();
    localTask(db, 'L1');
    seal(db);
    const opsBefore = sealedOps(db).length;
    withApplyFrame(db, 'project', null, (api) => {
      api.insertRow('tasks_tasks', 'uid-R1', {
        id: 'R1',
        title: 'remote',
        type: 'task',
        status: 'pending',
        priority: 'high',
        birth_fp: 'fp-R1',
      });
    });
    const r0 = seal(db);
    expect(r0, JSON.stringify(sealedOps(db).slice(opsBefore))).toMatchObject({ txns: 0, ops: 0 });
    expect(sealedOps(db)).toHaveLength(opsBefore);
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);
  });

  it('applied field writes and deletes seal nothing', async () => {
    const db = await store();
    localTask(db, 'L1');
    localTask(db, 'L2');
    seal(db);
    const opsBefore = sealedOps(db).length;
    withApplyFrame(db, 'project', null, (api) => {
      api.writeFields('tasks_tasks', 'uid-L1', { title: 'remote title', priority: 'critical' });
      api.writeFields('tasks_tasks', 'uid-L1', { title: 'remote title 2' }); // frame-net: last wins
      api.deleteRow('tasks_tasks', 'uid-L2');
    });
    expect(seal(db).ops).toBe(0);
    expect(sealedOps(db)).toHaveLength(opsBefore);
    expect(
      n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'L1' AND title = 'remote title 2'"),
    ).toBe(1);
  });

  it('only what the apply did not write seals: a side effect in the frame is residual', async () => {
    const db = await store();
    localTask(db, 'L1');
    seal(db);
    withApplyFrame(db, 'project', null, (api) => {
      api.writeFields('tasks_tasks', 'uid-L1', { title: 'remote title' });
      // A raw write inside the frame (what a validator side effect looks like).
      db.exec("UPDATE tasks_tasks SET priority = 'low' WHERE id = 'L1'");
    });
    const r1 = seal(db);
    const last = sealedOps(db).at(-1);
    expect(last, JSON.stringify(r1)).toBeDefined();
    expect(last).toMatchObject({ o: 'U', u: 'uid-L1', a: { priority: 'low' } });
    expect(last?.a).not.toHaveProperty('title');
  });

  it('values are recorded as stored: a number written into a TEXT column is subtracted', async () => {
    const db = await store();
    localTask(db, 'L1');
    seal(db);
    let stored: Record<string, string> = {};
    withApplyFrame(db, 'project', null, (api) => {
      stored = api.writeFields('tasks_tasks', 'uid-L1', { title: 42 });
    });
    expect(stored.title).toBe("'42'"); // TEXT affinity stored it as text
    expect(seal(db).ops).toBe(0);
  });

  it('refuses a table outside the sync set, an unknown column, the uid, and a missing row', async () => {
    const db = await store();
    localTask(db, 'L1');
    withApplyFrame(db, 'project', null, (api) => {
      expect(() => api.writeFields('sqlite_sequence', 'x', { a: 1 })).toThrow(ApplyWriteError);
      expect(() => api.writeFields('tasks_tasks', 'uid-L1', { no_such_col: 1 })).toThrow(
        ApplyWriteError,
      );
      expect(() => api.writeFields('tasks_tasks', 'uid-L1', { uid: 'other' })).toThrow(
        ApplyWriteError,
      );
      expect(() => api.writeFields('tasks_tasks', 'uid-missing', { title: 'x' })).toThrow(
        ApplyWriteError,
      );
      expect(api.deleteRow('tasks_tasks', 'uid-missing')).toBe(false);
    });
  });
});

describe('wireToSql', () => {
  it('maps the typed escapes to node:sqlite parameters', () => {
    expect(wireToSql('a')).toBe('a');
    expect(wireToSql(null)).toBeNull();
    expect(wireToSql(5)).toBe(5n);
    expect(wireToSql({ $i: '9007199254740993' })).toBe(9007199254740993n);
    expect(wireToSql({ $r: '1.5' })).toBe(1.5);
    expect(wireToSql({ $r: 'Inf' })).toBe(Number.POSITIVE_INFINITY);
    expect(wireToSql({ $r: '-Inf' })).toBe(Number.NEGATIVE_INFINITY);
    expect(wireToSql({ $b: Buffer.from('hi').toString('base64') })).toEqual(Buffer.from('hi'));
  });
});

describe('K11: the apply module writes only through the write API', () => {
  it('no apply module but write-api.ts holds raw write SQL, and none uses REPLACE', () => {
    const root = resolve(import.meta.dirname, '..');
    const files = readdirSync(root).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const code = readFileSync(join(root, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(code, `${f} uses REPLACE`).not.toMatch(/\bREPLACE\b/i);
      if (f !== 'write-api.ts') {
        expect(code, `${f} writes raw SQL`).not.toMatch(
          /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i,
        );
      }
    }
  });
});

describe('row meta through the shared writer (§1.6)', () => {
  const R = '22222222-2222-4222-8222-222222222222';
  const h = (ms: number) => `${String(1_790_000_000_000 + ms).padStart(13, '0')}-000000-${R}`;
  /** Every non-identity captured column of tasks_tasks at one HLC. */
  const allAt = (db: DatabaseSync, hlc: string): Record<string, string> => {
    const def = captureTableDef(db, 'project', 'tasks_tasks');
    if (!def) throw new Error('tasks_tasks is not captured');
    return Object.fromEntries(
      def.columns.filter((c) => !def.identity.includes(c)).map((c) => [c, hlc]),
    );
  };

  it('a losing remote field leaves the stored HLC unchanged, and an all-losing write is a no-op', async () => {
    const db = await store();
    localTask(db, 'L1');
    withApplyFrame(db, 'project', null, (api) => {
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: allAt(db, h(10)),
        origin: R,
        actor: null,
        deleted: false,
      });
    });
    const before = readRowMeta(db, 'tasks_tasks', 'uid-L1');
    const stored = withApplyFrame(db, 'project', null, (api) =>
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: { title: h(5) },
        origin: R,
        actor: null,
        deleted: false,
      }),
    );
    expect(stored).toBe(h(10));
    expect(readRowMeta(db, 'tasks_tasks', 'uid-L1')).toEqual(before);
    // A winning field moves only itself.
    withApplyFrame(db, 'project', null, (api) =>
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: { title: h(20) },
        origin: R,
        actor: null,
        deleted: false,
      }),
    );
    const after = readRowMeta(db, 'tasks_tasks', 'uid-L1');
    expect(after?.hlc).toBe(h(20));
    expect(JSON.parse(after?.fhlc ?? '{}')).toMatchObject({ priority: h(10) });
  });

  it('a remote delete names the fields at its HLC; a stale delete never tombstones the row', async () => {
    const db = await store();
    localTask(db, 'L1');
    withApplyFrame(db, 'project', null, (api) => {
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: allAt(db, h(10)),
        origin: R,
        actor: null,
        deleted: false,
      });
    });
    withApplyFrame(db, 'project', null, (api) => {
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: allAt(db, h(5)),
        origin: R,
        actor: null,
        deleted: true,
      });
    });
    expect(readRowMeta(db, 'tasks_tasks', 'uid-L1')?.deleted).toBe(0);
    withApplyFrame(db, 'project', null, (api) => {
      expect(api.deleteRow('tasks_tasks', 'uid-L1')).toBe(true);
      api.setRowMeta('tasks_tasks', 'uid-L1', {
        fieldHlc: allAt(db, h(30)),
        origin: R,
        actor: null,
        deleted: true,
      });
    });
    expect(readRowMeta(db, 'tasks_tasks', 'uid-L1')).toMatchObject({ deleted: 1, hlc: h(30) });
  });
});

describe('integers bind as integers (§2.6)', () => {
  it('an applied integer is stored as an integer, and its chash matches the locally written value', async () => {
    const db = await store();
    localTask(db, 'L1');
    db.exec("UPDATE tasks_tasks SET position = 7 WHERE id = 'L1'");
    const def = captureTableDef(db, 'project', 'tasks_tasks');
    if (!def) throw new Error('tasks_tasks is not captured');
    const local = rowChash(db, 'project', def, 'uid-L1');
    withApplyFrame(db, 'project', null, (api) => {
      api.writeFields('tasks_tasks', 'uid-L1', { position: 8 });
      api.writeFields('tasks_tasks', 'uid-L1', { position: 7 });
    });
    expect(
      n(
        db,
        "SELECT count(*) AS n FROM tasks_tasks WHERE id = 'L1' AND typeof(position) = 'integer'",
      ),
    ).toBe(1);
    expect(rowChash(db, 'project', def, 'uid-L1')).toBe(local);
  });
});
