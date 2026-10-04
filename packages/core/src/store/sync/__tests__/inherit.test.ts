/**
 * A new replica never re-emits inherited rows (journal spec §1.5 H3; T12753).
 *
 * A store copied with unsealed captures and sealed-but-unsent transactions in
 * its outbox rebinds on open. Everything the old replica left becomes
 * `inherited`: the sealer seals none of it, and only what the copy writes
 * after the rebind is sealed, under the new replica.
 *
 * Every store is a temp project `cleo.db` opened through the chokepoint.
 *
 * @task T12753
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { markInheritedRows } from '../inherit.js';
import { activeReplica, rebindReplica, type SyncOpenOptions, syncOpenPass } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { sealPending } from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const DEVICE = 'device-inherit-test';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-inherit-'));
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

async function store(path: string): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', path);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

function openOpts(path: string): SyncOpenOptions {
  return {
    dbPath: path,
    scope: 'project',
    mode: 'test',
    deviceId: DEVICE,
    registry: new ReplicaRegistry(join(dir, 'replicas.json'), DEVICE),
    schemaRoot: SYNC_SCHEMA,
    now: () => new Date(T0),
  };
}

function bind(db: DatabaseSync, path: string): string {
  const out = syncOpenPass(db, openOpts(path));
  if (out.status !== 'bound' && out.status !== 'rebound') throw new Error(out.status);
  return out.replicaId;
}

let clock = T0;
const seal = (db: DatabaseSync) =>
  sealPending(db, {
    scope: 'project',
    replica: activeReplica(db, 'project')?.replicaId,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

function addTask(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  db.prepare(
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
  ).run(id, `title ${id}`, `uid-${id}`, `fp-${id}`);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const states = (db: DatabaseSync, table: '_sync_capture' | '_sync_txn') =>
  Object.fromEntries(
    (
      db
        .prepare(`SELECT state, count(*) AS n FROM ${table} GROUP BY state ORDER BY state`)
        .all() as Array<{ state: string; n: number }>
    ).map((r) => [r.state, r.n]),
  );

const txnIds = (db: DatabaseSync) =>
  (db.prepare('SELECT txn FROM _sync_txn ORDER BY local_seq').all() as Array<{ txn: string }>).map(
    (r) => r.txn,
  );

const opUids = (db: DatabaseSync, txn: string) =>
  (
    db.prepare('SELECT uid FROM _sync_op WHERE txn = ? ORDER BY idx').all(txn) as Array<{
      uid: string;
    }>
  ).map((r) => r.uid);

describe('a rebind marks the old replica outbox inherited (T12753)', () => {
  it('a copy never seals or re-sends what the original captured or sealed', async () => {
    const db = await store(dbPath);
    const original = bind(db, dbPath);
    addTask(db, 'T1');
    expect(seal(db).txns).toBe(1); // sealed, not yet carried by a segment
    addTask(db, 'T2'); // captured, not yet sealed
    db.close();
    _resetDualScopeDbCache();

    const copyPath = join(dir, 'project', '.cleo', 'copy.db');
    copyFileSync(dbPath, copyPath);
    const copy = await store(copyPath);
    const successor = bind(copy, copyPath);
    expect(successor).not.toBe(original);

    expect(states(copy, '_sync_capture')).toEqual({ inherited: 1 });
    expect(states(copy, '_sync_txn')).toEqual({ inherited: 1 });
    const inheritedTxn = txnIds(copy)[0] ?? '';
    expect(inheritedTxn.startsWith(`${original}:`)).toBe(true);

    // Nothing the original left is sealed again.
    const nothing = seal(copy);
    expect(nothing).toMatchObject({ txns: 0, captures: 0 });
    expect(txnIds(copy)).toEqual([inheritedTxn]);

    // What the copy writes after the rebind seals under the new replica only.
    addTask(copy, 'T3');
    expect(seal(copy).txns).toBe(1);
    const ids = txnIds(copy);
    expect(ids).toHaveLength(2);
    const fresh = ids[1] ?? '';
    expect(fresh.startsWith(`${successor}:`)).toBe(true);
    expect(opUids(copy, fresh)).toEqual(['uid-T3']);

    const last = copy.prepare("SELECT value FROM _sync_meta WHERE key = 'rebind:last'").get() as {
      value: string;
    };
    expect(JSON.parse(last.value)).toMatchObject({
      from: original,
      to: successor,
      inherited: { captures: 1, txns: 1 },
    });
  });

  it('a rollback rebind of the same file inherits the outbox too', async () => {
    const db = await store(dbPath);
    const original = bind(db, dbPath);
    addTask(db, 'T1');
    const out = rebindReplica(db, openOpts(dbPath));
    expect(out.previousReplicaId).toBe(original);
    expect(states(db, '_sync_capture')).toEqual({ inherited: 1 });
    expect(seal(db)).toMatchObject({ txns: 0, captures: 0 });
  });

  it('marks nothing on a store without the outbox tables, and leaves segmented transactions to S4', async () => {
    const db = await store(dbPath);
    bind(db, dbPath);
    addTask(db, 'T1');
    seal(db);
    db.exec("UPDATE _sync_txn SET state = 'segmented'");
    expect(markInheritedRows(db)).toEqual({ captures: 0, txns: 0 });
    expect(states(db, '_sync_txn')).toEqual({ segmented: 1 });
    db.exec('DROP TABLE _sync_txn');
    db.exec('DROP TABLE _sync_capture');
    expect(markInheritedRows(db)).toEqual({ captures: 0, txns: 0 });
  });
});
