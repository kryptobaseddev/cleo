/**
 * T11627 ST-3 — T5158 heal wiring tests (Seams 0 & 1) + T12042 identity binding.
 *
 * Covers:
 *   - T12042 — exact DB-bound writer-lease identity (WeakMap).
 *   - T12042 Finding 4 — alias path normalization in acquireWriterLease.
 *   - T12042 — registerDbIdentity hardening (idempotent same, throw mismatch).
 *   - T12042 — primitive-level row isolation: insertIdempotent + upsertIdempotent
 *     across project A / project B / global handles.
 *   - Seam 0 — withColdOpenLease serializes the cold-open critical section.
 *   - T9  — dual-scope cold-open lease independence.
 *   - T11 — two-writer arbitration.
 *   - T14 — T5158 regression.
 *
 * Every test runs against a TEMP-DIR cleo.db copy — never `.cleo/*.db`.
 *
 * @task T11627
 * @task T12042 (E6-L12b — explicit writer-lease identity)
 * @epic T11625
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperationExecutionContext } from '../background-ops.js';
import {
  _resetDualScopeDbCache,
  insertIdempotent,
  openDualScopeDbAtPath,
  upsertIdempotent,
} from '../dual-scope-db.js';
import { applyPerfPragmas } from '../sqlite-pragmas.js';
import {
  _resetWriterLeaseStateForTest,
  _setNativeDbResolverForTest,
  acquireWriterLease,
  assertWriterLeaseHeld,
  hasActiveGrant,
  type LeaseHandle,
  type LeaseScope,
  type LeaseTarget,
  makeWriterLeaseIdentity,
  registerDbIdentity,
  resolveDbIdentity,
  WriterLeaseRequiredError,
  withColdOpenLease,
  withWriterLease,
} from '../writer-lease.js';
import { WRITER_LEASES_TABLE, WRITER_QUEUE_TABLE } from '../writer-lease-schema.js';

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wl-coldopen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  delete process.env.CLEO_WRITER_LEASE_MODE;
  _resetWriterLeaseStateForTest();
});

afterEach(() => {
  _resetWriterLeaseStateForTest();
  _setNativeDbResolverForTest(undefined);
  _resetDualScopeDbCache();
  delete process.env.CLEO_WRITER_LEASE_MODE;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function openTempScope(scope: LeaseScope, dir: string): Promise<DatabaseSync> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'cleo.db');
  const handle =
    scope === 'project'
      ? await openDualScopeDbAtPath('project', dbPath)
      : await openDualScopeDbAtPath('global', dbPath);
  return (handle.db as unknown as { $client: DatabaseSync }).$client;
}

function countActive(db: DatabaseSync, scope: string, lane: string): number {
  return (
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM ${WRITER_LEASES_TABLE} WHERE scope = ? AND lane = ? AND active = 1`,
        )
        .get(scope, lane) as { c: number } | undefined
    )?.c ?? 0
  );
}

function countRows(db: DatabaseSync, table: string): number {
  return (
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined)?.c ?? 0
  );
}

// ── T12042 Finding 4 — alias path normalization in acquireWriterLease ───────

describe('T12042 Finding 4 — acquireWriterLease normalizes alias dbPath', () => {
  it('alias path resolves to one memoized grant + one active row', async () => {
    const native = await openTempScope('project', join(testRoot, 'alias', '.cleo'));
    const realPath = resolvePath(join(testRoot, 'alias', '.cleo', 'cleo.db'));

    _setNativeDbResolverForTest(
      async (): Promise<LeaseTarget> => ({
        native,
        dbPath: realPath,
      }),
    );

    // Pass an aliased path (with redundant segments) directly to acquireWriterLease.
    const aliasPath = join(testRoot, 'alias', '.cleo', '.', 'cleo.db');
    const h1 = await acquireWriterLease('project', 'tasks', { dbPath: aliasPath });
    // Same canonical path, different spelling — must share the grant.
    const h2 = await acquireWriterLease('project', 'tasks', { dbPath: realPath });

    expect(h2).toBe(h1); // same memoized grant (re-entrant)
    expect(h1.epoch).toBeGreaterThan(0);
    expect(countActive(native, 'project', 'tasks')).toBe(1); // one active row

    await h1.release();
    await h2.release();
    expect(countActive(native, 'project', 'tasks')).toBe(0);
  }, 20_000);

  it('acquire → hasActiveGrant → assertWriterLeaseHeld → release with aliased filesystem path', async () => {
    const native = await openTempScope('project', join(testRoot, 'alias2', '.cleo'));
    const realPath = resolvePath(join(testRoot, 'alias2', '.cleo', 'cleo.db'));
    const aliasPath = join(testRoot, 'alias2', '.cleo', '.', 'cleo.db');

    _setNativeDbResolverForTest(
      async (): Promise<LeaseTarget> => ({
        native,
        dbPath: realPath,
      }),
    );

    // Acquire with alias → memo key uses canonicalized (real) path.
    const h = await acquireWriterLease('project', 'brain', { dbPath: aliasPath });
    expect(h.epoch).toBeGreaterThan(0);

    // hasActiveGrant with the canonical path must find the grant.
    expect(hasActiveGrant('project', 'brain', realPath)).toBe(true);
    // hasActiveGrant with the alias path must also find it (both normalize to real).
    expect(hasActiveGrant('project', 'brain', aliasPath)).toBe(true);
    // assert must pass with either spelling.
    expect(() => assertWriterLeaseHeld('project', 'brain', realPath)).not.toThrow();
    expect(() => assertWriterLeaseHeld('project', 'brain', aliasPath)).not.toThrow();
    // Unrelated path must NOT find the grant.
    expect(hasActiveGrant('project', 'brain', join(testRoot, 'other', '.cleo', 'cleo.db'))).toBe(
      false,
    );
    expect(() =>
      assertWriterLeaseHeld('project', 'brain', join(testRoot, 'other', '.cleo', 'cleo.db')),
    ).toThrow(WriterLeaseRequiredError);

    await h.release();
    expect(hasActiveGrant('project', 'brain', realPath)).toBe(false);
    expect(hasActiveGrant('project', 'brain', aliasPath)).toBe(false);
  }, 20_000);
});

// ── T12042 — registerDbIdentity hardening ────────────────────────────────────

describe('T12042 — registerDbIdentity hardening', () => {
  it('same DB + same canonical identity is idempotent', () => {
    const db = {};
    const id = makeWriterLeaseIdentity('project', '/tmp/cleo.db');
    registerDbIdentity(db, id);
    expect(() => registerDbIdentity(db, id)).not.toThrow();
    expect(resolveDbIdentity(db)).toBe(id);
  });

  it('same DB with different scope must throw', () => {
    const db = {};
    registerDbIdentity(db, makeWriterLeaseIdentity('project', '/tmp/cleo.db'));
    expect(() => registerDbIdentity(db, makeWriterLeaseIdentity('global', '/tmp/cleo.db'))).toThrow(
      /E_WRITER_LEASE_IDENTITY_MISMATCH/,
    );
  });

  it('same DB with different dbPath must throw', () => {
    const db = {};
    registerDbIdentity(db, makeWriterLeaseIdentity('project', '/tmp/a/cleo.db'));
    expect(() =>
      registerDbIdentity(db, makeWriterLeaseIdentity('project', '/tmp/b/cleo.db')),
    ).toThrow(/E_WRITER_LEASE_IDENTITY_MISMATCH/);
  });
});

// ── T12042 — primitive row isolation across project A / B / global ────────────

/**
 * Build a stub drizzle DB that writes rows to the given native handle's test
 * table via raw SQL. The stub is registered with the correct identity so
 * insertIdempotent/upsertIdempotent can resolve scope+dbPath from it.
 */
function makeStubDb(
  native: DatabaseSync,
  identity: WriterLeaseIdentity,
): { db: Record<string, unknown>; calls: () => number } {
  let callCount = 0;
  const db = {
    insert() {
      return {
        values(_row: unknown) {
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  callCount += 1;
                  native.prepare('INSERT OR IGNORE INTO _t_iso (k, v) VALUES (?, ?)').run('x', 1);
                  return [{ k: 'x' }];
                },
              };
            },
            onConflictDoUpdate(opts: { target: unknown; set: unknown }) {
              void opts;
              return {
                async returning() {
                  callCount += 1;
                  native
                    .prepare(
                      'INSERT INTO _t_iso (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
                    )
                    .run('x', 99);
                  return [{ k: 'x' }];
                },
              };
            },
          };
        },
      };
    },
  };
  registerDbIdentity(db, identity);
  return { db, calls: () => callCount };
}

describe('T12042 — primitive row isolation: insertIdempotent + upsertIdempotent', () => {
  /** Open a real dual-scope handle, capture identity + native for inspection. */
  async function openIsolated(
    scope: LeaseScope,
    dir: string,
  ): Promise<{ native: DatabaseSync; dbPath: string; identity: WriterLeaseIdentity }> {
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'cleo.db');
    const handle =
      scope === 'project'
        ? await openDualScopeDbAtPath('project', dbPath)
        : await openDualScopeDbAtPath('global', dbPath);
    const native = (handle.db as unknown as { $client: DatabaseSync }).$client;
    native.exec('CREATE TABLE IF NOT EXISTS _t_iso (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    return { native, dbPath, identity: handle.identity };
  }

  it('insertIdempotent lands rows ONLY in the correct project-A DB, not B', async () => {
    const a = await openIsolated('project', join(testRoot, 'projA', '.cleo'));
    const b = await openIsolated('project', join(testRoot, 'projB', '.cleo'));

    _setNativeDbResolverForTest(async (_scope, dbPath): Promise<LeaseTarget> => {
      if (dbPath === a.dbPath) return { native: a.native, dbPath: a.dbPath };
      return { native: b.native, dbPath: b.dbPath };
    });

    const stubA = makeStubDb(a.native, a.identity);
    await insertIdempotent(stubA.db as any, {} as any, {} as any, 'k');

    expect(countRows(a.native, '_t_iso')).toBe(1);
    expect(countRows(b.native, '_t_iso')).toBe(0);
    expect(countActive(a.native, 'project', 'tasks')).toBe(0);
    expect(countActive(b.native, 'project', 'tasks')).toBe(0);
  }, 20_000);

  it('insertIdempotent across project-A and global lands in each exact DB', async () => {
    const p = await openIsolated('project', join(testRoot, 'p', '.cleo'));
    const g = await openIsolated('global', join(testRoot, 'g'));

    _setNativeDbResolverForTest(async (scope, dbPath): Promise<LeaseTarget> => {
      if (scope === 'global') return { native: g.native, dbPath: g.dbPath };
      return { native: p.native, dbPath: p.dbPath };
    });

    const stubP = makeStubDb(p.native, p.identity);
    const stubG = makeStubDb(g.native, g.identity);

    await insertIdempotent(stubP.db as any, {} as any, {} as any, 'k');
    await insertIdempotent(stubG.db as any, {} as any, {} as any, 'k');

    expect(countRows(p.native, '_t_iso')).toBe(1);
    expect(countRows(g.native, '_t_iso')).toBe(1);
    expect(countActive(p.native, 'project', 'tasks')).toBe(0);
    expect(countActive(g.native, 'global', 'tasks')).toBe(0);
  }, 20_000);

  it('upsertIdempotent conflict-update lands in the correct DB only', async () => {
    const a = await openIsolated('project', join(testRoot, 'upA', '.cleo'));
    const b = await openIsolated('project', join(testRoot, 'upB', '.cleo'));

    _setNativeDbResolverForTest(
      async (): Promise<LeaseTarget> => ({
        native: a.native,
        dbPath: a.dbPath,
      }),
    );

    const { db: dbA, calls } = makeStubDb(a.native, a.identity);
    const result = await upsertIdempotent(dbA as any, {} as any, {} as any, 'k', {} as any);
    expect(result).toBe(1);
    expect(calls()).toBe(1); // upsert chain was reached
    expect(countActive(a.native, 'project', 'tasks')).toBe(0);
    expect(countRows(b.native, '_t_iso')).toBe(0);
  }, 20_000);
});

// ── T12042 — identity isolation: release/renew/assert cannot cross projects ────

describe('T12042 — writer-lease identity isolation (project A / B / global)', () => {
  it('a project identity release cannot free a different project identity row', async () => {
    const dirA = join(testRoot, 'isoA', '.cleo');
    const dirB = join(testRoot, 'isoB', '.cleo');

    const nativeA = await openTempScope('project', dirA);
    const nativeB = await openTempScope('project', dirB);

    const idA = makeWriterLeaseIdentity('project', join(dirA, 'cleo.db'));
    const idB = makeWriterLeaseIdentity('project', join(dirB, 'cleo.db'));

    _setNativeDbResolverForTest(async (_scope, dbPath): Promise<LeaseTarget> => {
      if (dbPath === idB.dbPath) return { native: nativeB, dbPath: idB.dbPath };
      return { native: nativeA, dbPath: idA.dbPath };
    });

    const hA = await acquireWriterLease(idA.scope, 'tasks', { dbPath: idA.dbPath });
    const hB = await acquireWriterLease(idB.scope, 'tasks', { dbPath: idB.dbPath });

    expect(countActive(nativeA, 'project', 'tasks')).toBe(1);
    expect(countActive(nativeB, 'project', 'tasks')).toBe(1);

    await hA.release();
    expect(countActive(nativeA, 'project', 'tasks')).toBe(0);
    expect(countActive(nativeB, 'project', 'tasks')).toBe(1);

    await hB.release();
    expect(countActive(nativeB, 'project', 'tasks')).toBe(0);
    expect(countActive(nativeA, 'project', 'tasks')).toBe(0);
  }, 20_000);

  it("a project identity release must not gate a global identity's release", async () => {
    const projNative = await openTempScope('project', join(testRoot, 'iso-p', '.cleo'));
    const globNative = await openTempScope('global', join(testRoot, 'iso-g'));

    const projId = makeWriterLeaseIdentity('project', join(testRoot, 'iso-p', '.cleo', 'cleo.db'));
    const globId = makeWriterLeaseIdentity('global', join(testRoot, 'iso-g', 'cleo.db'));

    _setNativeDbResolverForTest(async (scope, dbPath): Promise<LeaseTarget> => {
      if (scope === 'global') return { native: globNative, dbPath: globId.dbPath };
      return { native: projNative, dbPath: projId.dbPath };
    });

    const hP = await acquireWriterLease(projId.scope, 'tasks', { dbPath: projId.dbPath });
    const hG = await acquireWriterLease(globId.scope, 'tasks', { dbPath: globId.dbPath });

    expect(countActive(projNative, 'project', 'tasks')).toBe(1);
    expect(countActive(globNative, 'global', 'tasks')).toBe(1);

    await hP.release();
    expect(countActive(projNative, 'project', 'tasks')).toBe(0);
    expect(countActive(globNative, 'global', 'tasks')).toBe(1);

    await hG.release();
    expect(countActive(globNative, 'global', 'tasks')).toBe(0);
  }, 20_000);
});

// ── T12042 — insertIdempotent + resolveDbIdentity ────────────────────────────

describe('T12042 — write primitive resolves identity from exact DB binding (WeakMap)', () => {
  it('insertIdempotent resolves identity from registered DB handle', async () => {
    const projectNative = await openTempScope('project', join(testRoot, 'choke', '.cleo'));
    const dbPath = join(testRoot, 'choke', '.cleo', 'cleo.db');
    const identity = makeWriterLeaseIdentity('project', dbPath);

    _setNativeDbResolverForTest(async () => ({ native: projectNative, dbPath }));

    projectNative.exec(
      'CREATE TABLE IF NOT EXISTS _t_choke (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
    );

    let activeDuringWrite = -1;
    const stubDb = {
      insert() {
        return {
          values() {
            return {
              onConflictDoNothing() {
                return {
                  async returning() {
                    activeDuringWrite = countActive(projectNative, 'project', 'tasks');
                    projectNative
                      .prepare('INSERT OR IGNORE INTO _t_choke (k, v) VALUES (?, ?)')
                      .run('a', 1);
                    return [{ k: 'a' }];
                  },
                };
              },
            };
          },
        };
      },
    } as Record<string, unknown>;

    registerDbIdentity(stubDb, identity);
    const inserted = await insertIdempotent(stubDb as any, {} as any, {} as any, 'k');
    expect(inserted).toBe(1);
    expect(activeDuringWrite).toBe(1);
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
  }, 20_000);

  it('resolveDbIdentity throws for unregistered DB handle', () => {
    expect(() => resolveDbIdentity({})).toThrow(/E_WRITER_LEASE_IDENTITY_UNREGISTERED/);
  });

  it('a real DualScopeDbHandle carries identity bound at construction', async () => {
    const handle = await openDualScopeDbAtPath('project', join(testRoot, 'ds', '.cleo', 'cleo.db'));
    expect(handle.identity.scope).toBe('project');
    expect(handle.identity.dbPath).toBe(handle.dbPath);
    expect(() => resolveDbIdentity(handle.db)).not.toThrow();
    const resolved = resolveDbIdentity(handle.db);
    expect(resolved.scope).toBe('project');
    expect(resolved.dbPath).toBe(handle.dbPath);
    handle.close();
  }, 20_000);
});

// ── Seam 0 — withColdOpenLease ─────────────────────────────────────────────────

describe('Seam 0 — withColdOpenLease (cold-open critical section)', () => {
  it('bootstraps the lease tables on the passed handle and claims+releases the row', async () => {
    const dbPath = join(testRoot, 'seam0', 'cleo.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const nativeDb = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(nativeDb, { mmapSizeBytes: 0, cacheSizeKb: 8000 });

    let activeDuring = -1;
    const out = await withColdOpenLease('project', nativeDb, async () => {
      activeDuring = countActive(nativeDb, 'project', 'tasks');
      return 'ready';
    });
    expect(out).toBe('ready');
    expect(activeDuring).toBe(1);
    expect(countActive(nativeDb, 'project', 'tasks')).toBe(0);
    const tbl = nativeDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(WRITER_QUEUE_TABLE) as { name: string } | undefined;
    expect(tbl?.name).toBe(WRITER_QUEUE_TABLE);
    nativeDb.close();
  });

  it("'off' mode is a pure pass-through: fn runs, no lease row written", async () => {
    process.env.CLEO_WRITER_LEASE_MODE = 'off';
    _resetWriterLeaseStateForTest();
    const dbPath = join(testRoot, 'seam0-off', 'cleo.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const nativeDb = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(nativeDb, { mmapSizeBytes: 0, cacheSizeKb: 8000 });

    let ran = false;
    await withColdOpenLease('project', nativeDb, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    const tbl = nativeDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(WRITER_LEASES_TABLE) as { name: string } | undefined;
    expect(tbl).toBeUndefined();
    nativeDb.close();
  });
});

// ── T9 — dual-scope independence ───────────────────────────────────────────────

describe('T9 — dual-scope cold-open leases are independent', () => {
  it('a project and a global cold-open lease do not serialize against each other', async () => {
    const projPath = join(testRoot, 't9p', 'cleo.db');
    const globPath = join(testRoot, 't9g', 'cleo.db');
    mkdirSync(dirname(projPath), { recursive: true });
    mkdirSync(dirname(globPath), { recursive: true });
    const proj = new DatabaseSync(projPath, { allowExtension: true });
    const glob = new DatabaseSync(globPath, { allowExtension: true });
    applyPerfPragmas(proj, { mmapSizeBytes: 0, cacheSizeKb: 8000 });
    applyPerfPragmas(glob, { mmapSizeBytes: 0, cacheSizeKb: 8000 });

    let globalRan = false;
    await withColdOpenLease('project', proj, async () => {
      expect(countActive(proj, 'project', 'tasks')).toBe(1);
      await withColdOpenLease('global', glob, async () => {
        globalRan = true;
        expect(countActive(glob, 'global', 'tasks')).toBe(1);
      });
    });
    expect(globalRan).toBe(true);
    expect(countActive(proj, 'project', 'tasks')).toBe(0);
    expect(countActive(glob, 'global', 'tasks')).toBe(0);
    proj.close();
    glob.close();
  });
});

// ── T11 — two-writer arbitration (local, daemon OFF) ───────────────────────────

describe('T11 — two independent handles to one file serialize cleanly (local)', () => {
  it('two cold-open leases on the SAME file via distinct handles never both hold the row', async () => {
    const dbPath = join(testRoot, 't11', 'cleo.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const a = new DatabaseSync(dbPath, { allowExtension: true });
    const b = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(a, { mmapSizeBytes: 0, cacheSizeKb: 8000 });
    applyPerfPragmas(b, { mmapSizeBytes: 0, cacheSizeKb: 8000 });

    let maxConcurrent = 0;
    let inSection = 0;
    const section = (h: DatabaseSync) =>
      withColdOpenLease('project', h, async () => {
        inSection += 1;
        maxConcurrent = Math.max(maxConcurrent, inSection);
        await new Promise((r) => setTimeout(r, 40));
        inSection -= 1;
      });

    await Promise.all([section(a), section(b)]);
    expect(maxConcurrent).toBe(1);
    expect(countActive(a, 'project', 'tasks')).toBe(0);
    a.close();
    b.close();
  }, 20_000);
});

// ── T14 — T5158 regression (concurrent cold-open writers serialize) ─────────────

async function runConcurrentColdOpens(
  dbPath: string,
  count: number,
  mode: 'local' | 'off',
  raceWindowMs: number,
): Promise<{ id: number; error: string | null }[]> {
  process.env.CLEO_WRITER_LEASE_MODE = mode;
  _resetWriterLeaseStateForTest();
  const handles: DatabaseSync[] = Array.from({ length: count }, () => {
    const h = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(h, { mmapSizeBytes: 0, cacheSizeKb: 8000 });
    return h;
  });

  const writer = async (
    h: DatabaseSync,
    id: number,
  ): Promise<{ id: number; error: string | null }> => {
    try {
      await withColdOpenLease(
        'project',
        h,
        async () => {
          h.exec(
            'CREATE TABLE IF NOT EXISTS _t14_counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
          );
          h.exec(
            'CREATE TABLE IF NOT EXISTS _t14_provenance (writer_id INTEGER PRIMARY KEY, observed INTEGER NOT NULL)',
          );
          h.exec('INSERT OR IGNORE INTO _t14_counter (id, n) VALUES (1, 0)');
          const before =
            (
              h.prepare('SELECT n FROM _t14_counter WHERE id = 1').get() as
                | { n: number }
                | undefined
            )?.n ?? 0;
          await new Promise((r) => setTimeout(r, raceWindowMs));
          h.prepare('UPDATE _t14_counter SET n = ? WHERE id = 1').run(before + 1);
          h.prepare('INSERT INTO _t14_provenance (writer_id, observed) VALUES (?, ?)').run(
            id,
            before,
          );
        },
        { ttlMs: 30_000 },
      );
      return { id, error: null };
    } catch (err) {
      return { id, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  };

  try {
    return await Promise.all(handles.map((h, id) => writer(h, id)));
  } finally {
    for (const h of handles) {
      try {
        h.close();
      } catch {
        /* idempotent */
      }
    }
  }
}

function counterValue(db: DatabaseSync): number {
  return (
    (db.prepare('SELECT n FROM _t14_counter WHERE id = 1').get() as { n: number } | undefined)?.n ??
    0
  );
}

function provenanceCount(db: DatabaseSync): number {
  return (
    (db.prepare('SELECT COUNT(*) AS c FROM _t14_provenance').get() as { c: number } | undefined)
      ?.c ?? 0
  );
}

describe('T14 — T5158 regression: concurrent cold-open writers serialize (local, daemon OFF)', () => {
  const WRITERS = 6;
  const RACE_WINDOW_MS = 20;

  it("'local' mode serializes the cold-open write-txn: every increment lands, zero E_NOT_INITIALIZED", async () => {
    const dbPath = join(testRoot, 't14-local', 'cleo.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    const results = await runConcurrentColdOpens(dbPath, WRITERS, 'local', RACE_WINDOW_MS);

    const errors = results.filter((r) => r.error !== null);
    expect(errors, JSON.stringify(errors)).toHaveLength(0);

    const verify = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(verify, { mmapSizeBytes: 0, cacheSizeKb: 8000 });
    expect(counterValue(verify)).toBe(WRITERS);
    expect(provenanceCount(verify)).toBe(WRITERS);
    expect(countActive(verify, 'project', 'tasks')).toBe(0);
    verify.close();
  }, 60_000);

  it("'off' mode reproduces the lost-update race (guards the heal's value)", async () => {
    const dbPath = join(testRoot, 't14-off', 'cleo.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    const results = await runConcurrentColdOpens(dbPath, WRITERS, 'off', RACE_WINDOW_MS);
    expect(results.filter((r) => r.error !== null)).toHaveLength(0);
    const verify = new DatabaseSync(dbPath, { allowExtension: true });
    applyPerfPragmas(verify, { mmapSizeBytes: 0, cacheSizeKb: 8000 });
    expect(counterValue(verify)).toBeLessThan(WRITERS);
    verify.close();
  }, 60_000);
});

describe('captured cold-open lease lifetime', () => {
  function context(budgetMs = 2000) {
    return createOperationExecutionContext(
      {
        projectId: 'cold',
        projectRoot: testRoot,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: 'cold-open',
      },
      { budgetMs },
    );
  }

  it('refuses expired scope before cold-open bootstrap mutations', async () => {
    const native = new DatabaseSync(join(testRoot, 'empty.db'));
    const execution = context(0);
    try {
      await expect(
        withColdOpenLease('project', native, async () => 'forbidden', { execution }),
      ).rejects.toThrow();
      expect(native.prepare('SELECT name FROM sqlite_master').all()).toEqual([]);
    } finally {
      execution.close();
      native.close();
    }
  });

  it('cancels a genuinely contended cold-open without executing its migration callback', async () => {
    const native = new DatabaseSync(join(testRoot, 'contended.db'));
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withColdOpenLease('project', native, async () => {
      entered();
      await gate;
    });
    await ready;
    const execution = context(25);
    let writes = 0;
    try {
      await expect(
        withColdOpenLease(
          'project',
          native,
          async () => {
            writes += 1;
          },
          { execution },
        ),
      ).rejects.toThrow();
      expect(writes).toBe(0);
      expect(countActive(native, 'project', 'tasks')).toBe(1);
      expect(countRows(native, WRITER_QUEUE_TABLE)).toBe(0);
    } finally {
      execution.close();
      release();
      await holder;
      native.close();
    }
  });

  it('cancels the actual default resolver before a contended cold opener can migrate later', async () => {
    const target = join(testRoot, 'default-resolver.db');
    const holderNative = new DatabaseSync(target);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withColdOpenLease('project', holderNative, async () => {
      entered();
      await gate;
    });
    await ready;
    const execution = context(30);
    _setNativeDbResolverForTest(undefined);
    try {
      await expect(
        acquireWriterLease('project', 'brain', { dbPath: target, execution }),
      ).rejects.toThrow();
      expect(holderNative.isOpen).toBe(true);
      release();
      await holder;
      // The abandoned canonical initializer resumes after the lease releases.
      // Observe beyond its polling interval to detect a late migration/publication.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      const fresh = new DatabaseSync(target, { readOnly: true });
      try {
        expect(
          fresh
            .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='tasks_tasks'")
            .get()?.count,
        ).toBe(0);
        expect(fresh.prepare('SELECT count(*) AS count FROM main._writer_queue').get()?.count).toBe(
          0,
        );
      } finally {
        fresh.close();
      }
      const retry = await openDualScopeDbAtPath('project', target);
      expect(retry.isOpen).toBe(true);
      expect(
        retry.db.$client.prepare("SELECT name FROM sqlite_master WHERE name='tasks_tasks'").get()
          ?.name,
      ).toBe('tasks_tasks');
    } finally {
      execution.close();
      release();
      await holder;
      holderNative.close();
    }
  });

  it('never recreates a removed project when releasing a cancelled scoped lease', async () => {
    const directory = join(testRoot, 'removed-project');
    const target = join(directory, '.cleo', 'cleo.db');
    const execution = context();
    _setNativeDbResolverForTest(undefined);
    const lease = await acquireWriterLease('project', 'brain', { dbPath: target, execution });
    execution.close();
    _resetDualScopeDbCache();
    rmSync(directory, { recursive: true });
    await lease.release();
    await lease.release();
    expect(existsSync(directory)).toBe(false);
    expect(lease.cleanupPending).toBe(true);
  });

  it('scoped heartbeat and release never borrow an unrelated native transaction', async () => {
    const target = join(testRoot, 'release-owned.db');
    const execution = context();
    const lease = await acquireWriterLease('project', 'brain', { dbPath: target, execution });
    const opened = await openDualScopeDbAtPath('project', target);
    const native = opened.db.$client;
    const before = native
      .prepare("SELECT heartbeat_at FROM main._writer_leases WHERE lane='brain'")
      .get()?.heartbeat_at;
    native.exec(
      "CREATE TABLE release_owner_proof (value TEXT); BEGIN; INSERT INTO release_owner_proof VALUES ('unrelated')",
    );
    try {
      lease.heartbeat();
      await lease.release();
      expect(native.isTransaction).toBe(true);
      expect(native.prepare('SELECT value FROM release_owner_proof').get()?.value).toBe(
        'unrelated',
      );
      expect(
        native.prepare("SELECT heartbeat_at FROM main._writer_leases WHERE lane='brain'").get()
          ?.heartbeat_at,
      ).toBe(before);
      expect(
        native.prepare("SELECT active FROM main._writer_leases WHERE lane='brain'").get()?.active,
      ).toBe(1);
      expect(lease.cleanupPending).toBe(true);
    } finally {
      native.exec('ROLLBACK');
      execution.close();
    }
  });

  it.each([
    'replacement',
    'shared',
  ] as const)('scoped release preserves a %s holder and remains idempotent', async (kind) => {
    const target = join(testRoot, 'release-replacement.db');
    const original = context();
    const successor = context();
    const first = await acquireWriterLease('project', 'brain', {
      dbPath: target,
      execution: original,
    });
    const opened = await openDualScopeDbAtPath('project', target);
    const native = opened.db.$client;
    if (kind === 'replacement')
      native.exec("UPDATE main._writer_leases SET active=0 WHERE lane='brain'");
    const second = await acquireWriterLease('project', 'brain', {
      dbPath: target,
      execution: successor,
      reentrant: kind === 'shared',
    });
    try {
      original.close();
      await first.release();
      await first.release();
      expect(
        native
          .prepare("SELECT epoch FROM main._writer_leases WHERE lane='brain' AND active=1")
          .get()?.epoch,
      ).toBe(second.epoch);
      expect(second.cleanupPending).toBe(false);
      await second.release();
      expect(
        native
          .prepare(
            "SELECT count(*) AS count FROM main._writer_leases WHERE lane='brain' AND active=1",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      original.close();
      successor.close();
      await second.release();
    }
  });

  it('returns an admitted committed write even when scoped teardown cleanup must be deferred', async () => {
    const target = join(testRoot, 'committed-release.db');
    const execution = context();
    let held: LeaseHandle | undefined;
    const result = await withWriterLease(
      'project',
      'brain',
      async (lease) => {
        held = lease;
        const opened = await openDualScopeDbAtPath('project', target);
        opened.db.$client.exec(
          "CREATE TABLE committed_release (value TEXT); INSERT INTO committed_release VALUES ('committed')",
        );
        execution.close();
        _resetDualScopeDbCache();
        return 'committed';
      },
      { dbPath: target, execution },
    );
    expect(result).toBe('committed');
    expect(held?.cleanupPending).toBe(true);
    const fresh = new DatabaseSync(target, { readOnly: true });
    try {
      expect(fresh.prepare('SELECT value FROM committed_release').get()?.value).toBe('committed');
    } finally {
      fresh.close();
    }
  });

  it('preserves a completed migration result if cancellation follows its synchronous commit', async () => {
    const native = new DatabaseSync(join(testRoot, 'committed.db'));
    const execution = context();
    try {
      const result = await withColdOpenLease(
        'project',
        native,
        async () => {
          native.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('committed')");
          execution.close();
          return 'committed';
        },
        { execution },
      );
      expect(result).toBe('committed');
      expect(native.prepare('SELECT value FROM proof').get()?.value).toBe('committed');
      expect(countActive(native, 'project', 'tasks')).toBe(0);
    } finally {
      execution.close();
      native.close();
    }
  });
});

describe('required operation-owned schema leases', () => {
  it('keeps required exclusion when compatibility mode is off', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-off'));
    const path = join(testRoot, 'required-off', 'cleo.db');
    process.env.CLEO_WRITER_LEASE_MODE = 'off';
    _resetWriterLeaseStateForTest();
    await withColdOpenLease(
      'project',
      native,
      async (ownership) => {
        ownership.assertHeld(native);
        expect(countActive(native, 'project', 'tasks')).toBe(1);
      },
      { requiredIdentity: makeWriterLeaseIdentity('project', path) },
    );
    expect(countActive(native, 'project', 'tasks')).toBe(0);
  });

  it('excludes unrelated async callers but admits awaited lexical nesting', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-nesting'));
    const path = join(testRoot, 'required-nesting', 'cleo.db');
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withColdOpenLease(
      'project',
      native,
      async () => {
        await withColdOpenLease(
          'project',
          native,
          async (nested) => {
            nested.assertHeld(native);
          },
          { requiredIdentity: makeWriterLeaseIdentity('project', path) },
        );
        entered();
        await gate;
      },
      { requiredIdentity: makeWriterLeaseIdentity('project', path) },
    );
    await ready;
    let peerEntered = false;
    const peer = withColdOpenLease(
      'project',
      native,
      async () => {
        peerEntered = true;
      },
      { requiredIdentity: makeWriterLeaseIdentity('project', path) },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(peerEntered).toBe(false);
    } finally {
      release();
      await Promise.all([holder, peer]);
    }
    expect(peerEntered).toBe(true);
    expect(countActive(native, 'project', 'tasks')).toBe(0);
  });

  it('releases its own handle after the callback closes the domain connection', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-close'));
    const path = join(testRoot, 'required-close', 'cleo.db');
    expect(
      await withColdOpenLease(
        'project',
        native,
        async () => {
          native.close();
          return 'closed intentionally';
        },
        { requiredIdentity: makeWriterLeaseIdentity('project', path) },
      ),
    ).toBe('closed intentionally');
    const fresh = new DatabaseSync(path);
    try {
      expect(countActive(fresh, 'project', 'tasks')).toBe(0);
    } finally {
      fresh.close();
    }
  });

  it('preserves a thrown callback error after callback closure', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-throw'));
    const path = join(testRoot, 'required-throw', 'cleo.db');
    const original = new Error('original callback failure');
    await expect(
      withColdOpenLease(
        'project',
        native,
        async () => {
          native.close();
          throw original;
        },
        { requiredIdentity: makeWriterLeaseIdentity('project', path) },
      ),
    ).rejects.toBe(original);
    const fresh = new DatabaseSync(path);
    try {
      expect(countActive(fresh, 'project', 'tasks')).toBe(0);
    } finally {
      fresh.close();
    }
  });

  it('rejects a different callback file before entry and releases the claimed file', async () => {
    const left = await openTempScope('project', join(testRoot, 'required-left'));
    const right = await openTempScope('project', join(testRoot, 'required-right'));
    let entered = false;
    await expect(
      withColdOpenLease(
        'project',
        left,
        async () => {
          entered = true;
        },
        {
          requiredIdentity: makeWriterLeaseIdentity(
            'project',
            join(testRoot, 'required-right', 'cleo.db'),
          ),
        },
      ),
    ).rejects.toThrow('another database');
    expect(entered).toBe(false);
    expect(countActive(right, 'project', 'tasks')).toBe(0);
  });

  it('rejects a former handle generation after replacement at the identical path', async () => {
    const path = join(testRoot, 'former-generation.db');
    const original = new DatabaseSync(path);
    await withColdOpenLease('project', original, async () => undefined);
    const capturedIdentity = makeWriterLeaseIdentity('project', path);
    renameSync(path, path + '.original');
    copyFileSync(path + '.original', path);
    let entered = false;
    try {
      await expect(
        withColdOpenLease(
          'project',
          original,
          async () => {
            entered = true;
          },
          { requiredIdentity: capturedIdentity },
        ),
      ).rejects.toThrow('file was replaced');
      expect(entered).toBe(false);
    } finally {
      original.close();
    }
    const fresh = new DatabaseSync(path);
    try {
      expect(countActive(fresh, 'project', 'tasks')).toBe(0);
    } finally {
      fresh.close();
    }
  });

  it('cancels required contention without entering or taking a compatibility fallback', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-cancel'));
    const path = join(testRoot, 'required-cancel', 'cleo.db');
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withColdOpenLease(
      'project',
      native,
      async () => {
        entered();
        await gate;
      },
      { requiredIdentity: makeWriterLeaseIdentity('project', path) },
    );
    await ready;
    const execution = createOperationExecutionContext(
      {
        projectId: 'fixture',
        projectRoot: testRoot,
        actor: 'fixture',
        operation: 'schema',
        idempotencyKey: 'cancel',
      },
      { budgetMs: 25 },
    );
    let peerEntered = false;
    try {
      await expect(
        withColdOpenLease(
          'project',
          native,
          async () => {
            peerEntered = true;
          },
          {
            requiredIdentity: makeWriterLeaseIdentity('project', path),
            execution,
          },
        ),
      ).rejects.toThrow();
      expect(peerEntered).toBe(false);
      expect(countActive(native, 'project', 'tasks')).toBe(1);
      expect(countRows(native, WRITER_QUEUE_TABLE)).toBe(0);
    } finally {
      execution.close();
      release();
      await holder;
    }
  });

  it('refuses a stale epoch at the explicit checkpoint without releasing its successor', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-stale'));
    const path = join(testRoot, 'required-stale', 'cleo.db');
    await expect(
      withColdOpenLease(
        'project',
        native,
        async (ownership) => {
          native
            .prepare(`UPDATE ${WRITER_LEASES_TABLE} SET epoch = epoch + 1 WHERE active = 1`)
            .run();
          ownership.assertHeld();
        },
        { requiredIdentity: makeWriterLeaseIdentity('project', path) },
      ),
    ).rejects.toThrow('stale');
    expect(countActive(native, 'project', 'tasks')).toBe(1);
    native.exec(`UPDATE ${WRITER_LEASES_TABLE} SET active = 0`);
  });

  it('rejects same-path file replacement instead of publishing callback success', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-replacement'));
    const path = join(testRoot, 'required-replacement', 'cleo.db');
    await expect(
      withColdOpenLease(
        'project',
        native,
        async () => {
          renameSync(path, path + '.original');
          copyFileSync(path + '.original', path);
          return 'must not publish';
        },
        { requiredIdentity: makeWriterLeaseIdentity('project', path) },
      ),
    ).rejects.toThrow('file replaced');
  });

  it('expires detached lexical membership after its original callback exits', async () => {
    const native = await openTempScope('project', join(testRoot, 'required-detached'));
    const path = join(testRoot, 'required-detached', 'cleo.db');
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let detached: Promise<void> | undefined;
    let entered = false;
    await withColdOpenLease(
      'project',
      native,
      async () => {
        detached = (async () => {
          await gate;
          await withColdOpenLease(
            'project',
            native,
            async () => {
              entered = true;
            },
            { requiredIdentity: makeWriterLeaseIdentity('project', path) },
          );
        })();
      },
      { requiredIdentity: makeWriterLeaseIdentity('project', path) },
    );
    const outcome = expect(detached).rejects.toThrow('expired lexical');
    resume();
    await outcome;
    expect(entered).toBe(false);
  });
});
