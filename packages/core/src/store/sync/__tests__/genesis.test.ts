/**
 * The genesis cut (T12343 S4-1a; journal spec §2.11 §10, §3.5 Rule 2).
 *
 * Real stores: writes go through capture frames and the real sealer; the
 * replica is bound through the real bind pass against a scratch registry.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import {
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_RECIPE,
  ROW_IDENTITY_RECIPE_KEY,
} from '../../row-identity.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { isSyncFlagOn, setSyncFlag } from '../flags.js';
import {
  cutGenesis,
  GENESIS_CUT_KEY_PREFIX,
  GENESIS_PENDING_KEY_PREFIX,
  GENESIS_SOURCE_SEQ_KEY_PREFIX,
  genesisCutOf,
  genesisPending,
  UNDO_ENABLED_KEY,
} from '../genesis.js';
import { streamStarted } from '../repair.js';
import { ensureProjectReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { sealPending } from '../sealer.js';
import { buildSegment } from '../segments.js';
import { MIN_WRITER_VERSION_KEY } from '../writer-version.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'project:0192ffff-7f00-7000-8000-00000000000f';
let clock = Date.now();
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-genesis-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  mkdirSync(join(dir, 'p', '.cleo'), { recursive: true });
  dbPath = join(dir, 'p', '.cleo', 'cleo.db');
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const addTask = (id: string) =>
  `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp) VALUES ('${id}', 'title ${id}', 'task', 'pending', 'medium', 'uid-${id}', 'fp-${id}')`;

const n = (db: DatabaseSync, sql: string, ...args: Array<string | number>): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

const meta = (db: DatabaseSync, key: string): string | undefined =>
  (
    db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;

/** A store with one pre-capture row, capture and seal on, and a bound replica. */
async function store(): Promise<{ db: DatabaseSync; replica: string }> {
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('project', dbPath));
  db.exec(addTask('T0')); // before capture: no capture, no row meta
  // The identity fill's marker: this store's identity follows the current recipe.
  db.prepare(
    `INSERT INTO ${ROW_IDENTITY_META_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  const { replicaId } = ensureProjectReplica(db, {
    dbPath,
    mode: 'test',
    registry: new ReplicaRegistry(join(dir, 'registry.json'), 'host-1'),
  });
  return { db, replica: replicaId };
}

function write(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.exec(sql);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const seal = (db: DatabaseSync) =>
  sealPending(db, { scope: 'project', now: () => ++clock, env: {}, allowUnreleased: true });

const cut = (db: DatabaseSync) =>
  cutGenesis(db, {
    scope: 'project',
    stream: STREAM,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

/** Nothing of the cut was written. */
function expectUncut(db: DatabaseSync): void {
  expect(genesisCutOf(db, STREAM)).toBeUndefined();
  expect(meta(db, UNDO_ENABLED_KEY)).toBeUndefined();
  expect(isSyncFlagOn(db, 'sync.push', {})).toBe(false);
  expect(n(db, "SELECT count(*) AS n FROM _sync_txn WHERE state = 'folded'")).toBe(0);
}

describe('genesis cut (§2.11 §10)', () => {
  it('drains, folds every pre-cut transaction, baselines meta-less rows and turns push on in one cut', async () => {
    const { db, replica } = await store();
    write(db, addTask('T1'));
    seal(db);
    write(db, "UPDATE tasks_tasks SET priority = 'high' WHERE id = 'T1'"); // left live: the cut drains it
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBeGreaterThan(
      0,
    );
    expect(n(db, "SELECT count(*) AS n FROM _sync_row_meta WHERE tbl = 'tasks_tasks'")).toBe(1);

    // A store whose capture was enabled by an older build: the cut keeps pre-cut writers out.
    db.prepare('UPDATE _sync_meta SET value = ? WHERE key = ?').run(
      '0.0.1',
      MIN_WRITER_VERSION_KEY,
    );

    const r = cut(db);
    expect(r).toMatchObject({
      refused: null,
      already: false,
      stream: STREAM,
      sealed: 1,
      folded: 2,
    });
    const top = n(db, "SELECT seq AS n FROM sqlite_sequence WHERE name = '_sync_capture'");
    expect(r.cut).toBe(top);
    expect(r.baselined).toEqual({ tasks_tasks: 1 }); // T0, written before capture
    expect(meta(db, `${GENESIS_CUT_KEY_PREFIX}${STREAM}`)).toBe(String(top));
    expect(meta(db, `${GENESIS_SOURCE_SEQ_KEY_PREFIX}${STREAM}`)).toBe(String(top));
    expect(genesisPending(db, STREAM)).toBe(true);
    expect(meta(db, `${GENESIS_PENDING_KEY_PREFIX}${STREAM}`)).toBe(String(top));
    expect(meta(db, UNDO_ENABLED_KEY)).toBe('1');
    expect(meta(db, MIN_WRITER_VERSION_KEY)).not.toBe('0.0.1');
    expect(isSyncFlagOn(db, 'sync.push', {})).toBe(true);
    expect(streamStarted(db)).toBe(true);
    // Nothing live, nothing left sealed: every pre-cut effect is in genesis.
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);
    expect(n(db, "SELECT count(*) AS n FROM _sync_txn WHERE state = 'sealed'")).toBe(0);
    expect(n(db, "SELECT count(*) AS n FROM _sync_row_meta WHERE tbl = 'tasks_tasks'")).toBe(2);

    const sealer = (_seq: number, plaintext: Uint8Array) => Buffer.from(plaintext);
    const pack = () =>
      buildSegment(db, {
        stream: STREAM,
        replica,
        scope: 'project',
        project: null,
        sealer,
        signTxn: (_stream, txn) => txn,
        nowIso: new Date(++clock).toISOString(),
      });
    // A folded transaction is never packed.
    expect(pack()).toBeNull();

    // After the cut: a write records undo, seals normally, and is the first thing packed.
    write(db, addTask('T2'));
    expect(n(db, 'SELECT count(*) AS n FROM _sync_undo')).toBeGreaterThan(0);
    seal(db);
    const after = (
      db.prepare("SELECT txn FROM _sync_txn WHERE state = 'sealed'").all() as Array<{
        txn: string;
      }>
    ).map((t) => t.txn);
    expect(after).toHaveLength(1);
    expect(pack()?.txns).toEqual(after);
  });

  it('a second cut of the same stream changes nothing', async () => {
    const { db } = await store();
    write(db, addTask('T1'));
    const first = cut(db);
    write(db, addTask('T2'));
    const live = n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'");
    const again = cut(db);
    expect(again).toMatchObject({ already: true, cut: first.cut, refused: null, sealed: 0 });
    // Not even drained: the post-cut write is left for the normal seal.
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(live);
    expect(live).toBeGreaterThan(0);
  });

  it('refuses inside a transaction', async () => {
    const { db } = await store();
    db.exec('BEGIN IMMEDIATE');
    try {
      expect(() => cut(db)).toThrow(/outside a transaction/);
    } finally {
      db.exec('ROLLBACK');
    }
  });
});

describe('genesis preconditions (T13032 AC2 step 0): a refusal cuts nothing', () => {
  it('capture off', async () => {
    const { db } = await store();
    setCaptureEnabled(db, 'project', false, { schemaRoot: SYNC_SCHEMA });
    expect(cut(db).refused).toBe('sync.capture is off');
    expectUncut(db);
  });

  it('a capture trigger missing or drifted', async () => {
    const { db } = await store();
    const trigger = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_sync_cap_%'",
        )
        .get() as { name: string }
    ).name;
    db.exec(`DROP TRIGGER "${trigger}"`);
    expect(cut(db).refused).toMatch(/capture triggers differ.*cleo doctor sync-triggers --repair/);
    expectUncut(db);
  });

  it('sealing not allowed', async () => {
    const { db } = await store();
    const r = cutGenesis(db, { scope: 'project', stream: STREAM, env: {} });
    expect(r.refused).toMatch(/unreleased/);
    expectUncut(db);
  });

  it('no bound replica', async () => {
    const { db } = await store();
    db.exec('DELETE FROM _sync_replica');
    expect(cut(db).refused).toBe('no bound replica');
    expectUncut(db);
  });

  it('identity not on the current recipe', async () => {
    const { db } = await store();
    db.prepare(`DELETE FROM ${ROW_IDENTITY_META_TABLE} WHERE key = ?`).run(ROW_IDENTITY_RECIPE_KEY);
    expect(cut(db).refused).toMatch(/current recipe/);
    expectUncut(db);
  });

  it('a minted row without birth_fp', async () => {
    const { db } = await store();
    db.exec("UPDATE tasks_tasks SET birth_fp = NULL WHERE id = 'T0'");
    expect(cut(db).refused).toMatch(/tasks_tasks: 1.*identity fill/);
    expectUncut(db);
  });

  it('an owned guard trigger missing', async () => {
    const { db } = await store();
    db.exec('DROP TRIGGER tasks_tasks_parent_cycle_guard_insert');
    expect(cut(db).refused).toMatch(
      /owned triggers are unsound: tasks_tasks_parent_cycle_guard_insert \(missing\)/,
    );
    expectUncut(db);
  });

  it('a quarantined capture', async () => {
    const { db } = await store();
    db.prepare(
      "INSERT INTO _sync_quarantine (seq, tbl, op, rk, img, at_ms, reason, quarantined_at_ms) VALUES (1, 'tasks_tasks', 'U', 'x', '{}', 0, 'test', 0)",
    ).run();
    expect(cut(db).refused).toMatch(/quarantined captures.*sync-journal --repair/);
    expectUncut(db);
  });

  it('a legacy-only store (T13224): rows only in the bare legacy tables', async () => {
    const { db } = await store();
    db.exec('DELETE FROM tasks_tasks');
    db.exec('DROP TABLE IF EXISTS tasks');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)');
    db.exec("INSERT INTO tasks (id, title) VALUES ('L1', 'legacy')");
    expect(cut(db).refused).toMatch(/legacy-only store.*cleo doctor superseded-store --reconcile/);
    expectUncut(db);
  });

  it('a suspect table', async () => {
    const { db } = await store();
    db.prepare(
      "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('suspect:tasks_tasks', 'x', 'x')",
    ).run();
    expect(cut(db).refused).toMatch(/suspect tables \(tasks_tasks\).*sync-journal --repair/);
    expectUncut(db);
  });
});
