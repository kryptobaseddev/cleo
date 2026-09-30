/**
 * The persisted clock, the store-level flags and replica binding (journal
 * spec §1.4, §1.5, §5.1; review findings N5 and N6).
 *
 * Every store here is a fresh file under a `mkdtemp` directory, and every
 * registry is a file in that directory: no user store, no device registry and
 * no `getStableDeviceId()` is touched.
 *
 * @task T12342
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  healClock,
  loadClock,
  receiveClock,
  tickClock,
  withImmediateTransaction,
} from '../clock-store.js';
import { isSyncFlagOn, killSwitchVar, readSyncFlags, setSyncFlag } from '../flags.js';
import { encodeHlc, MAX_DRIFT_MS, parseHlc } from '../hlc.js';
import {
  activeReplica,
  defaultStat,
  fileIdentity,
  listReplicas,
  persistStoreSeq,
  rebindReplica,
  registerRebindHook,
  type StatFn,
  type SyncOpenOptions,
  syncOpenPass,
} from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { appliedSyncSchema, ensureSyncSchema } from '../schema.js';

const SCHEMA_ROOT = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const DEVICE = 'device-aaaaaaaa';
const OTHER_DEVICE = 'device-bbbbbbbb';
const T0 = 1_790_545_492_500;

let dir: string;
const open: DatabaseSync[] = [];

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  open.push(db);
  return db;
}

function close(db: DatabaseSync): void {
  db.close();
  open.splice(open.indexOf(db), 1);
}

/** A fresh store with one ordinary table and a row, like a real store. */
function freshStore(name = 'cleo.db'): { path: string; db: DatabaseSync } {
  const path = join(dir, name);
  const db = openDb(path);
  db.exec("CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY); INSERT INTO tasks_tasks VALUES ('T1');");
  return { path, db };
}

function registry(deviceId = DEVICE, file = 'replicas.json'): ReplicaRegistry {
  return new ReplicaRegistry(join(dir, file), deviceId);
}

function opts(path: string, extra: Partial<SyncOpenOptions> = {}): SyncOpenOptions {
  return {
    dbPath: path,
    scope: 'project',
    mode: 'test',
    registry: registry(),
    schemaRoot: SCHEMA_ROOT,
    now: () => new Date(T0),
    ...extra,
  };
}

function enable(db: DatabaseSync): void {
  setSyncFlag(db, 'sync.capture', true, { schemaRoot: SCHEMA_ROOT, now: new Date(T0) });
}

function syncTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '\\_sync%' ESCAPE '\\' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sync-s1-'));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('flags', () => {
  it('are all off on a store that never enabled one, and reading them writes nothing', () => {
    const { path, db } = freshStore();
    close(db);
    const before = sha(path);
    const again = openDb(path);
    expect(Object.values(readSyncFlags(again)).every((v) => v === false)).toBe(true);
    expect(syncTables(again)).toEqual([]);
    close(again);
    expect(sha(path)).toBe(before);
  });

  it('turning one on applies the sync schema once and persists the flag', () => {
    const { db } = freshStore();
    enable(db);
    expect(syncTables(db)).toEqual([
      '_sync_clock',
      '_sync_meta',
      '_sync_replica',
      '_sync_replica_active',
    ]);
    expect(appliedSyncSchema(db)).toEqual(['20260929140000_t12342-sync-clock']);
    expect(ensureSyncSchema(db, { root: SCHEMA_ROOT })).toEqual([]);
    expect(readSyncFlags(db)['sync.capture']).toBe(true);
    expect(readSyncFlags(db)['sync.push']).toBe(false);
  });

  it('turning one off on a store without the schema writes nothing', () => {
    const { db } = freshStore();
    expect(setSyncFlag(db, 'sync.push', false, { schemaRoot: SCHEMA_ROOT })).toBe(false);
    expect(syncTables(db)).toEqual([]);
  });

  it('the kill switch stops a flag in-process but never turns one on', () => {
    const { db } = freshStore();
    enable(db);
    expect(killSwitchVar('sync.capture')).toBe('CLEO_SYNC_CAPTURE');
    expect(isSyncFlagOn(db, 'sync.capture', {})).toBe(true);
    expect(isSyncFlagOn(db, 'sync.capture', { CLEO_SYNC_CAPTURE: '0' })).toBe(false);
    expect(isSyncFlagOn(db, 'sync.seal', { CLEO_SYNC_SEAL: '1' })).toBe(false);
    expect(readSyncFlags(db)['sync.capture']).toBe(true);
  });
});

describe('flag off: the open pass writes nothing', () => {
  it('mode live with every flag off leaves the file, the schema and the registry untouched', () => {
    const { path, db } = freshStore();
    const reg = registry();
    const out = syncOpenPass(db, opts(path, { mode: 'live', registry: reg, deviceId: DEVICE }));
    expect(out).toEqual({ status: 'disabled' });
    expect(syncTables(db)).toEqual([]);
    expect(existsSync(reg.path)).toBe(false);
    close(db);
    const before = sha(path);
    const again = openDb(path);
    syncOpenPass(again, opts(path, { mode: 'live', registry: reg, deviceId: DEVICE }));
    close(again);
    expect(sha(path)).toBe(before);
  });

  it("mode 'off' writes nothing even with a flag on", () => {
    const { path, db } = freshStore();
    enable(db);
    const reg = registry();
    expect(syncOpenPass(db, opts(path, { mode: 'off', registry: reg }))).toEqual({
      status: 'off',
    });
    expect(listReplicas(db)).toEqual([]);
    expect(existsSync(reg.path)).toBe(false);
  });

  it("mode 'test' refuses to fall back to the device registry", () => {
    const { path, db } = freshStore();
    enable(db);
    expect(() => syncOpenPass(db, { ...opts(path), registry: undefined })).toThrow(
      /needs an explicit registry/,
    );
  });
});

describe('persisted clock', () => {
  it('survives a reopen and keeps increasing', () => {
    const { path, db } = freshStore();
    enable(db);
    const bound = syncOpenPass(db, opts(path));
    if (bound.status !== 'bound') throw new Error('not bound');
    const r = bound.replicaId;
    const first = withImmediateTransaction(db, () => tickClock(db, r, T0));
    const second = withImmediateTransaction(db, () => tickClock(db, r, T0));
    expect(second > first).toBe(true);
    close(db);

    const again = openDb(path);
    expect(syncOpenPass(again, opts(path))).toMatchObject({ status: 'bound', replicaId: r });
    // The wall clock went backwards across the restart; the clock did not.
    const third = withImmediateTransaction(again, () => tickClock(again, r, T0 - 10_000));
    expect(third > second).toBe(true);
    expect(parseHlc(third)).toEqual({ phys: T0, ctr: 2, replica: r });
  });

  it('refuses to tick outside a transaction', () => {
    const { path, db } = freshStore();
    enable(db);
    const bound = syncOpenPass(db, opts(path));
    if (bound.status !== 'bound') throw new Error('not bound');
    expect(() => tickClock(db, bound.replicaId, T0)).toThrow(/BEGIN IMMEDIATE/);
  });

  it('two connections serialize on the write lock and never issue the same HLC', () => {
    const { path, db } = freshStore();
    enable(db);
    const bound = syncOpenPass(db, opts(path));
    if (bound.status !== 'bound') throw new Error('not bound');
    const r = bound.replicaId;
    const other = openDb(path);
    other.exec('PRAGMA busy_timeout = 0');

    db.exec('BEGIN IMMEDIATE');
    const a = tickClock(db, r, T0);
    expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
    db.exec('COMMIT');

    const b = withImmediateTransaction(other, () => tickClock(other, r, T0));
    expect(b > a).toBe(true);
  });

  it('a received HLC beyond the skew bound is held and writes nothing', () => {
    const { path, db } = freshStore();
    enable(db);
    const bound = syncOpenPass(db, opts(path));
    if (bound.status !== 'bound') throw new Error('not bound');
    const r = bound.replicaId;
    const remote = encodeHlc({
      phys: T0 + MAX_DRIFT_MS + 1,
      ctr: 4,
      replica: '0192f1c2-0000-7000-8000-00000000000b',
    });
    const before = withImmediateTransaction(db, () => loadClock(db, r));
    expect(withImmediateTransaction(db, () => receiveClock(db, r, remote, T0))).toEqual({
      held: true,
    });
    expect(loadClock(db, r)).toEqual(before);
    const inBound = encodeHlc({
      phys: T0 + 1_000,
      ctr: 4,
      replica: '0192f1c2-0000-7000-8000-00000000000b',
    });
    const merged = withImmediateTransaction(db, () => receiveClock(db, r, inBound, T0));
    expect(merged).toEqual({
      held: false,
      clock: encodeHlc({ phys: T0 + 1_000, ctr: 5, replica: r }),
    });
  });

  it('heals to the largest HLC this replica left in the journal tables', () => {
    const { path, db } = freshStore();
    enable(db);
    const bound = syncOpenPass(db, opts(path));
    if (bound.status !== 'bound') throw new Error('not bound');
    const r = bound.replicaId;
    db.exec('CREATE TABLE _sync_op (hlc TEXT)');
    const mine = encodeHlc({ phys: T0 + 50, ctr: 7, replica: r });
    const foreign = encodeHlc({
      phys: T0 + 99,
      ctr: 0,
      replica: '0192f1c2-0000-7000-8000-00000000000b',
    });
    db.prepare('INSERT INTO _sync_op VALUES (?), (?)').run(mine, foreign);
    const healed = withImmediateTransaction(db, () => healClock(db, r));
    expect(encodeHlc(healed)).toBe(mine);
    expect(withImmediateTransaction(db, () => tickClock(db, r, T0))).toBe(
      encodeHlc({ phys: T0 + 50, ctr: 8, replica: r }),
    );
  });
});

describe('replica binding', () => {
  function bind(path: string, db: DatabaseSync, extra: Partial<SyncOpenOptions> = {}) {
    const out = syncOpenPass(db, opts(path, extra));
    if (out.status !== 'bound' && out.status !== 'rebound') throw new Error(out.status);
    return out;
  }

  it('binds a new store once, registers it, and a reopen keeps the replica', () => {
    const { path, db } = freshStore();
    enable(db);
    const first = bind(path, db);
    expect(first).toMatchObject({ status: 'bound', reasons: [], registryWritten: true });
    const row = activeReplica(db, 'project');
    expect(row?.deviceId).toBe(DEVICE);
    expect(registry().get(first.replicaId)).toMatchObject({ nonce: row?.nonce, scope: 'project' });
    close(db);
    const again = openDb(path);
    expect(bind(path, again)).toMatchObject({
      status: 'bound',
      replicaId: first.replicaId,
      registryWritten: false,
    });
  });

  it('a file copy rebinds (file-identity) and never touches the original', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db).replicaId;
    close(db);
    const copyPath = join(dir, 'copy.db');
    copyFileSync(path, copyPath);
    const copy = openDb(copyPath);
    const out = bind(copyPath, copy);
    expect(out).toMatchObject({
      status: 'rebound',
      previousReplicaId: original,
      reasons: ['file-identity'],
    });
    expect(out.replicaId).not.toBe(original);
    const rows = listReplicas(copy);
    expect(rows.find((r) => r.replicaId === original)).toMatchObject({ successor: out.replicaId });
    // The original's registration still points at the original and is not retired.
    expect(registry().get(original)).toMatchObject({
      dbRealpath: expect.stringContaining('cleo.db'),
    });
    expect(registry().get(original)?.retiredAt).toBeUndefined();
    const back = openDb(path);
    expect(bind(path, back)).toMatchObject({ status: 'bound', replicaId: original });
  });

  it('VACUUM INTO output rebinds', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db).replicaId;
    const snap = join(dir, 'snap.db');
    db.exec(`VACUUM INTO '${snap}'`);
    const s = openDb(snap);
    expect(bind(snap, s)).toMatchObject({ status: 'rebound', previousReplicaId: original });
  });

  it('a restore to a new file at the same path rebinds', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db).replicaId;
    close(db);
    const backup = join(dir, 'backup.db');
    copyFileSync(path, backup);
    rmSync(path);
    copyFileSync(backup, path); // a new inode at the old path
    const restored = openDb(path);
    expect(bind(path, restored)).toMatchObject({
      status: 'rebound',
      previousReplicaId: original,
      reasons: ['file-identity'],
    });
  });

  it('a rename within one filesystem keeps the replica and updates the registry', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db).replicaId;
    close(db);
    const moved = join(dir, 'moved.db');
    renameSync(path, moved);
    const m = openDb(moved);
    expect(bind(moved, m)).toMatchObject({
      status: 'bound',
      replicaId: original,
      registryWritten: true,
    });
    expect(registry().get(original)?.dbRealpath).toMatch(/moved\.db$/);
  });

  it('a store bound on another device rebinds (foreign-device)', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db, { registry: registry(OTHER_DEVICE, 'other.json') }).replicaId;
    expect(bind(path, db)).toMatchObject({
      status: 'rebound',
      previousReplicaId: original,
      reasons: ['foreign-device'],
    });
  });

  it('a lost registry only re-registers the store; no rebind (N6)', () => {
    const { path, db } = freshStore();
    enable(db);
    const original = bind(path, db).replicaId;
    rmSync(registry().path);
    expect(bind(path, db)).toMatchObject({
      status: 'bound',
      replicaId: original,
      registryWritten: true,
    });
    writeFileSync(registry().path, '{ not json');
    expect(bind(path, db)).toMatchObject({ status: 'bound', replicaId: original });
  });

  it('a restore into the same inode (rollback below the hwm) rebinds', () => {
    const { path, db } = freshStore();
    enable(db);
    const r = bind(path, db).replicaId;
    const reg = registry();
    const persist = (seq: number) => {
      withImmediateTransaction(db, () => persistStoreSeq(db, r, 'project:0123456789ab', seq));
      reg.advanceHwm(r, 'project:0123456789ab', seq);
    };
    persist(3);
    close(db);
    const snapshot = readFileSync(path);
    const inode = defaultStat(path).ino;
    const live = openDb(path);
    withImmediateTransaction(live, () => persistStoreSeq(live, r, 'project:0123456789ab', 5));
    reg.advanceHwm(r, 'project:0123456789ab', 5);
    close(live);
    writeFileSync(path, snapshot); // rewrite in place, like .backup() into the same file
    expect(defaultStat(path).ino).toBe(inode);
    const restored = openDb(path);
    expect(bind(path, restored)).toMatchObject({
      status: 'rebound',
      previousReplicaId: r,
      reasons: ['rollback'],
    });
  });

  it('a store ahead of a restored (older) registry does not rebind', () => {
    const { path, db } = freshStore();
    enable(db);
    const r = bind(path, db).replicaId;
    const reg = registry();
    const old = readFileSync(reg.path);
    withImmediateTransaction(db, () => persistStoreSeq(db, r, 'home:user_0001', 9));
    reg.advanceHwm(r, 'home:user_0001', 9);
    writeFileSync(reg.path, old);
    expect(bind(path, db)).toMatchObject({ status: 'bound', replicaId: r, registryWritten: true });
    expect(reg.get(r)?.hwm).toEqual({ 'home:user_0001': 9 });
  });

  it('the new replica continues the clock, and rebind hooks run in the rebind transaction', () => {
    const { path, db } = freshStore();
    enable(db);
    const r = bind(path, db).replicaId;
    const last = withImmediateTransaction(db, () => tickClock(db, r, T0 + 5));
    const seen: string[] = [];
    const off = registerRebindHook((hookDb, ctx) => {
      expect(hookDb.isTransaction).toBe(true);
      seen.push(`${ctx.previous.replicaId}->${ctx.current.replicaId}:${ctx.reasons.join(',')}`);
    });
    try {
      const out = rebindReplica(db, opts(path));
      expect(seen).toEqual([`${r}->${out.replicaId}:server-seq-conflict`]);
      const next = withImmediateTransaction(db, () => tickClock(db, out.replicaId, T0));
      expect(parseHlc(next)).toMatchObject({ phys: T0 + 5, ctr: parseHlc(last).ctr + 1 });
      expect(registry().get(r)).toMatchObject({ successor: out.replicaId });
    } finally {
      off();
    }
  });

  it('a throwing rebind hook rolls the whole rebind back', () => {
    const { path, db } = freshStore();
    enable(db);
    const r = bind(path, db).replicaId;
    const off = registerRebindHook(() => {
      throw new Error('hook failed');
    });
    try {
      expect(() => rebindReplica(db, opts(path))).toThrow('hook failed');
    } finally {
      off();
    }
    expect(activeReplica(db, 'project')?.replicaId).toBe(r);
    expect(listReplicas(db)).toHaveLength(1);
  });
});

describe('birthtime (N5)', () => {
  const statWith =
    (birth: (real: { ctimeNs: bigint }) => bigint, ino?: bigint): StatFn =>
    (p) => {
      const s = defaultStat(p);
      return { ino: ino ?? s.ino, birthtimeNs: birth(s), ctimeNs: s.ctimeNs };
    };

  it('a birthtime of 0 is stored as NULL', () => {
    const { path, db } = freshStore();
    enable(db);
    syncOpenPass(db, opts(path, { stat: statWith(() => 0n) }));
    expect(activeReplica(db, 'project')?.fileBirth).toBeNull();
  });

  it('a birthtime equal to the ctime at bind is stored as NULL', () => {
    const { path, db } = freshStore();
    enable(db);
    syncOpenPass(db, opts(path, { stat: statWith((s) => s.ctimeNs) }));
    expect(activeReplica(db, 'project')?.fileBirth).toBeNull();
    expect(
      fileIdentity(
        path,
        statWith((s) => s.ctimeNs),
      ).birth,
    ).toBeNull();
  });

  it('the libuv ctime fallback never rebinds across writes and reopens', () => {
    const { path, db } = freshStore();
    enable(db);
    const libuv = statWith((s) => s.ctimeNs); // birthtime always reported as the ctime
    const first = syncOpenPass(db, opts(path, { stat: libuv }));
    if (first.status !== 'bound') throw new Error(first.status);
    let cur = db;
    for (let i = 0; i < 3; i++) {
      cur.prepare('INSERT INTO tasks_tasks VALUES (?)').run(`T${i + 2}`);
      close(cur);
      cur = openDb(path);
      expect(syncOpenPass(cur, opts(path, { stat: libuv }))).toMatchObject({
        status: 'bound',
        replicaId: first.replicaId,
        reasons: [],
      });
    }
  });

  it('a real birthtime is compared only when both sides are known', () => {
    const { path, db } = freshStore();
    enable(db);
    const r = syncOpenPass(db, opts(path, { stat: statWith(() => 111n) }));
    if (r.status !== 'bound') throw new Error(r.status);
    // Unknown now (the filesystem stopped reporting it): no rebind.
    expect(syncOpenPass(db, opts(path, { stat: statWith(() => 0n) }))).toMatchObject({
      status: 'bound',
      replicaId: r.replicaId,
    });
    // Known and different, same inode: a different file.
    expect(syncOpenPass(db, opts(path, { stat: statWith(() => 222n) }))).toMatchObject({
      status: 'rebound',
      reasons: ['file-identity'],
    });
  });

  it('a device-number change (external volume remount) is not a rebind', () => {
    const { path, db } = freshStore();
    enable(db);
    let dev = 1n;
    const remounting: StatFn = (p) => {
      dev += 1n; // st_dev differs on every call; the binding never reads it
      return { ...defaultStat(p), dev } as ReturnType<StatFn>;
    };
    const r = syncOpenPass(db, opts(path, { stat: remounting }));
    if (r.status !== 'bound') throw new Error(r.status);
    expect(syncOpenPass(db, opts(path, { stat: remounting }))).toMatchObject({
      status: 'bound',
      replicaId: r.replicaId,
    });
  });
});
