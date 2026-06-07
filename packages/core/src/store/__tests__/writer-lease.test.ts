/**
 * Unit + integration tests for the DbWriterLease local-mode engine (T11627 ST-2).
 *
 * Covers the spec test plan rows assigned to ST-2:
 *   - T6  — mode degradation: off (pass-through), supervisor→local demote, require throws.
 *   - T7  — re-entrancy: nested same-lane acquire shares one grant (refcount/depth).
 *   - T8  — AC1 partial-unique: two holders → exactly one active row; loser queues.
 *   - T12 — stale-holder reclaim: dead-pid holder reclaimed after TTL; epoch bumps;
 *           the stale-epoch holder's heartbeat no-ops (E_WRITER_LEASE_STALE semantics).
 *   - T13 — reclaim race: two reclaimers → exactly one wins (BEGIN IMMEDIATE).
 *   - T16 — starvation/aging: a deadline-exceeded waiter is enqueued for promotion.
 *   - AC2 — project + global scopes arbitrate independently (distinct files).
 *   - AC3 — local/off/require all work with NO supervisor running.
 *
 * Every test injects a TEMP-DIR cleo.db (no canonical-path side effects, no
 * supervisor) via `_setNativeDbResolverForTest`. DBs are migrated through the real
 * dual-scope chokepoint so the raw partial-unique index (AC1) is genuinely present.
 *
 * @task T11627
 * @epic T11625
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import {
  _resetWriterLeaseStateForTest,
  _setNativeDbResolverForTest,
  acquireWriterLease,
  type LeaseScope,
  LeaseUnavailableError,
  resolveLeaseMode,
  withWriterLease,
} from '../writer-lease.js';
import {
  assertWriterLeaseActiveIndexPresent,
  WRITER_LEASES_ACTIVE_INDEX,
  WRITER_LEASES_TABLE,
  WRITER_QUEUE_TABLE,
} from '../writer-lease-schema.js';

let testRoot: string;
let projectNative: DatabaseSync;
let globalNative: DatabaseSync;

/** Open + migrate an isolated temp cleo.db for a scope and return its native handle. */
async function openTempScope(scope: LeaseScope, dir: string): Promise<DatabaseSync> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'cleo.db');
  const handle =
    scope === 'project'
      ? await openDualScopeDbAtPath('project', dbPath)
      : await openDualScopeDbAtPath('global', dbPath);
  return (handle.db as unknown as { $client: DatabaseSync }).$client;
}

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `writer-lease-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projectNative = await openTempScope('project', join(testRoot, 'project', '.cleo'));
  globalNative = await openTempScope('global', join(testRoot, 'global'));

  // Route the engine at the two isolated temp DBs (no supervisor, no canonical path).
  _setNativeDbResolverForTest(async (scope) =>
    scope === 'project' ? projectNative : globalNative,
  );
  delete process.env.CLEO_WRITER_LEASE_MODE;
  _resetWriterLeaseStateForTest();
  // _resetWriterLeaseStateForTest restores the DEFAULT resolver — re-inject ours.
  _setNativeDbResolverForTest(async (scope) =>
    scope === 'project' ? projectNative : globalNative,
  );
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

function countQueue(db: DatabaseSync, scope: string, lane: string): number {
  return (
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${WRITER_QUEUE_TABLE} WHERE scope = ? AND lane = ?`)
        .get(scope, lane) as { c: number } | undefined
    )?.c ?? 0
  );
}

// ── AC2 schema / bootstrap ──────────────────────────────────────────────────

describe('AC1 partial-unique index bootstrap (T8 prerequisite)', () => {
  it('the raw partial-unique active index is present after migration on both scopes', () => {
    expect(() => assertWriterLeaseActiveIndexPresent(projectNative)).not.toThrow();
    expect(() => assertWriterLeaseActiveIndexPresent(globalNative)).not.toThrow();

    const projIdx = projectNative
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .get(WRITER_LEASES_ACTIVE_INDEX) as { name: string } | undefined;
    expect(projIdx?.name).toBe(WRITER_LEASES_ACTIVE_INDEX);
  });

  it('assertWriterLeaseActiveIndexPresent throws when the index is dropped', () => {
    projectNative.exec(`DROP INDEX IF EXISTS ${WRITER_LEASES_ACTIVE_INDEX}`);
    expect(() => assertWriterLeaseActiveIndexPresent(projectNative)).toThrow(
      /E_WRITER_LEASE_INDEX_MISSING/,
    );
    // Re-create so afterEach teardown is clean.
    projectNative.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${WRITER_LEASES_ACTIVE_INDEX} ON ${WRITER_LEASES_TABLE} (scope, lane) WHERE active = 1`,
    );
  });
});

// ── T6 — mode degradation ─────────────────────────────────────────────────────

describe('T6 — mode degradation (AC3: no supervisor running)', () => {
  it("resolveLeaseMode defaults to 'local' when env unset", () => {
    delete process.env.CLEO_WRITER_LEASE_MODE;
    _resetWriterLeaseStateForTest();
    _setNativeDbResolverForTest(async (scope) =>
      scope === 'project' ? projectNative : globalNative,
    );
    expect(resolveLeaseMode()).toBe('local');
  });

  it("'off' mode is a pass-through: fn runs, no lease row written", async () => {
    process.env.CLEO_WRITER_LEASE_MODE = 'off';
    _resetWriterLeaseStateForTest();
    _setNativeDbResolverForTest(async (scope) =>
      scope === 'project' ? projectNative : globalNative,
    );

    let ran = false;
    const out = await withWriterLease('project', 'tasks', async (h) => {
      ran = true;
      expect(h.epoch).toBe(0); // sentinel — no row acquired
      return 'done';
    });
    expect(ran).toBe(true);
    expect(out).toBe('done');
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
  });

  it("'supervisor' mode demotes to local arbitration (no IPC wired in ST-2)", async () => {
    process.env.CLEO_WRITER_LEASE_MODE = 'supervisor';
    _resetWriterLeaseStateForTest();
    _setNativeDbResolverForTest(async (scope) =>
      scope === 'project' ? projectNative : globalNative,
    );

    const h = await acquireWriterLease('project', 'tasks');
    // Demoted to local → a real row exists.
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    expect(h.epoch).toBeGreaterThan(0);
    await h.release();
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
  });

  it("'require' mode throws LeaseUnavailableError when a live holder blocks acquire", async () => {
    process.env.CLEO_WRITER_LEASE_MODE = 'require';
    _resetWriterLeaseStateForTest();
    _setNativeDbResolverForTest(async (scope) =>
      scope === 'project' ? projectNative : globalNative,
    );

    // Seed a LIVE (this-pid) active holder directly so require cannot reclaim.
    const now = Date.now();
    projectNative
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','other-live',?,5,?,?,30000,1,1)`,
      )
      .run(process.pid, now, now);

    await expect(
      // reentrant:false so the seeded foreign holder is genuinely contended; a
      // short ttlMs bounds the acquire window so require throws fast.
      acquireWriterLease('project', 'tasks', { reentrant: false, ttlMs: 800 }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
  }, 35_000);
});

// ── T7 — re-entrancy ──────────────────────────────────────────────────────────

describe('T7 — re-entrancy (refcount / reentrancy_depth)', () => {
  it('nested same-lane acquire shares one grant; row freed only at depth 0', async () => {
    const outer = await acquireWriterLease('project', 'tasks');
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);

    const inner = await acquireWriterLease('project', 'tasks');
    expect(inner).toBe(outer); // same memoized handle — no second claim txn
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);

    const depthRow = projectNative
      .prepare(
        `SELECT reentrancy_depth AS d FROM ${WRITER_LEASES_TABLE} WHERE scope='project' AND lane='tasks' AND active=1`,
      )
      .get() as { d: number } | undefined;
    expect(depthRow?.d).toBe(2);

    await inner.release();
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1); // still held by outer

    await outer.release();
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0); // freed at depth 0
  });

  it('withWriterLease nested inside another withWriterLease re-enters', async () => {
    let innerEpoch = -1;
    let outerEpoch = -1;
    await withWriterLease('project', 'tasks', async (outer) => {
      outerEpoch = outer.epoch;
      await withWriterLease('project', 'tasks', async (inner) => {
        innerEpoch = inner.epoch;
        expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
      });
      // Inner released → still held by outer.
      expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    });
    expect(innerEpoch).toBe(outerEpoch);
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
  });
});

// ── T8 — AC1 partial-unique single active holder ──────────────────────────────

describe('T8 — AC1 single active holder per (scope, lane)', () => {
  it('a second non-reentrant acquire cannot take a second active row (engine enqueues)', async () => {
    const first = await acquireWriterLease('project', 'tasks', { reentrant: false });
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);

    // A second holder (reentrant:false → does NOT share the memo) cannot acquire
    // while the first is live; it enqueues and the deadline drives a degraded
    // fallback (no second active row is EVER created).
    process.env.CLEO_WRITER_LEASE_MODE = 'local';
    const secondPromise = acquireWriterLease('project', 'tasks', {
      reentrant: false,
      ttlMs: 1_000,
    });

    // Give the contended acquire time to enqueue.
    await new Promise((r) => setTimeout(r, 50));
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1); // STILL exactly one
    expect(countQueue(projectNative, 'project', 'tasks')).toBeGreaterThanOrEqual(1);

    await first.release();
    // Now the waiter can be granted on its next attempt.
    const second = await secondPromise;
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    await second.release();
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
  }, 35_000);

  it('the partial-unique index physically rejects a second active row inserted out-of-band', () => {
    const now = Date.now();
    projectNative
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','h1',1,1,?,?,30000,1,1)`,
      )
      .run(now, now);
    expect(() =>
      projectNative
        .prepare(
          `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','h2',2,2,?,?,30000,1,1)`,
        )
        .run(now, now),
    ).toThrow(); // UNIQUE constraint failed — AC1 enforced by the engine, not code
    // A released (active=0) row for the same lane is allowed (partial index).
    expect(() =>
      projectNative
        .prepare(
          `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','h3',3,3,?,?,30000,0,0)`,
        )
        .run(now, now),
    ).not.toThrow();
  });
});

// ── AC2 — per-scope independence ──────────────────────────────────────────────

describe('AC2 — project and global scopes arbitrate independently', () => {
  it('holding the project tasks lease does not block the global tasks lease', async () => {
    const proj = await acquireWriterLease('project', 'tasks');
    const glob = await acquireWriterLease('global', 'tasks');
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    expect(countActive(globalNative, 'global', 'tasks')).toBe(1);
    // Distinct files → distinct rows; neither serialized against the other.
    expect(proj.epoch).toBeGreaterThan(0);
    expect(glob.epoch).toBeGreaterThan(0);
    await proj.release();
    await glob.release();
    expect(countActive(projectNative, 'project', 'tasks')).toBe(0);
    expect(countActive(globalNative, 'global', 'tasks')).toBe(0);
  });

  it('different lanes within one scope are independent (tasks vs brain)', async () => {
    const tasks = await acquireWriterLease('project', 'tasks');
    const brain = await acquireWriterLease('project', 'brain');
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    expect(countActive(projectNative, 'project', 'brain')).toBe(1);
    await tasks.release();
    await brain.release();
  });
});

// ── T12 — stale-holder reclaim ────────────────────────────────────────────────

describe('T12 — stale-holder reclaim', () => {
  it('a TTL-expired, dead-pid holder is reclaimed; epoch bumps', async () => {
    // Seed a stale holder: heartbeat far in the past + a pid that cannot exist.
    const past = Date.now() - 120_000;
    const deadPid = 2_147_483_640; // implausibly high → process.kill(pid,0) throws ESRCH
    projectNative
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','dead-holder',?,7,?,?,30000,1,1)`,
      )
      .run(deadPid, past, past);

    const h = await acquireWriterLease('project', 'tasks', { reentrant: false });
    // Reclaimed in place → still exactly one active row, epoch bumped past 7.
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    expect(h.epoch).toBeGreaterThan(7);

    // The stale holder's heartbeat (old epoch 7) must no-op — epoch guard.
    projectNative
      .prepare(
        `UPDATE ${WRITER_LEASES_TABLE} SET heartbeat_at = ? WHERE scope='project' AND lane='tasks' AND epoch = 7 AND active = 1`,
      )
      .run(Date.now());
    const activeEpoch = projectNative
      .prepare(
        `SELECT epoch AS e FROM ${WRITER_LEASES_TABLE} WHERE scope='project' AND lane='tasks' AND active=1`,
      )
      .get() as { e: number } | undefined;
    expect(activeEpoch?.e).toBe(h.epoch); // unchanged by the stale-epoch UPDATE
    await h.release();
  }, 35_000);

  it('a TTL-expired but LIVE-pid holder is NOT reclaimed (deadline → degraded fallback)', async () => {
    const past = Date.now() - 120_000;
    projectNative
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','live-but-stale',?,9,?,?,30000,1,1)`,
      )
      .run(process.pid, past, past); // our own pid → alive

    // local mode: cannot reclaim a live pid; acquire degrades to a no-op handle
    // after the deadline rather than stealing the lease.
    process.env.CLEO_WRITER_LEASE_MODE = 'local';
    const h = await acquireWriterLease('project', 'tasks', { reentrant: false, ttlMs: 500 });
    // The original live holder's row is still the only active one.
    const holder = projectNative
      .prepare(
        `SELECT holder_id AS hid FROM ${WRITER_LEASES_TABLE} WHERE scope='project' AND lane='tasks' AND active=1`,
      )
      .get() as { hid: string } | undefined;
    expect(holder?.hid).toBe('live-but-stale');
    expect(h.epoch).toBe(0); // degraded no-op handle
    await h.release();
  }, 35_000);
});

// ── T13 — reclaim race ────────────────────────────────────────────────────────

describe('T13 — reclaim race (BEGIN IMMEDIATE serialization)', () => {
  it('two concurrent reclaimers of one stale row → exactly one active row survives', async () => {
    const past = Date.now() - 120_000;
    const deadPid = 2_147_483_641;
    projectNative
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','tasks','dead-2',?,11,?,?,30000,1,1)`,
      )
      .run(deadPid, past, past);

    // Two acquires race the reclaim. BEGIN IMMEDIATE serializes them; the partial-
    // unique index guarantees the end state is exactly one active row regardless of
    // interleaving. (Single-process, but exercises the reclaim-then-grant path twice.)
    const [a, b] = await Promise.all([
      acquireWriterLease('project', 'tasks', { reentrant: false, ttlMs: 1_000 }).catch(() => null),
      acquireWriterLease('project', 'tasks', { reentrant: false, ttlMs: 1_000 }).catch(() => null),
    ]);

    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    // Release whatever grants were handed out (no-op handles release cleanly too).
    if (a) await a.release();
    if (b) await b.release();
  }, 35_000);
});

// ── T16 — starvation / aging ──────────────────────────────────────────────────

describe('T16 — starvation / aging (deadline-based queue promotion)', () => {
  it('a contended waiter is enqueued with a deadline_at for aging promotion', async () => {
    const held = await acquireWriterLease('project', 'tasks', { reentrant: false });
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);

    const waiterPromise = acquireWriterLease('project', 'tasks', {
      reentrant: false,
      priority: 200,
      ttlMs: 1_000,
    });
    await new Promise((r) => setTimeout(r, 50));

    const q = projectNative
      .prepare(
        `SELECT priority AS p, deadline_at AS d, enqueued_at AS e FROM ${WRITER_QUEUE_TABLE} WHERE scope='project' AND lane='tasks' ORDER BY ticket ASC LIMIT 1`,
      )
      .get() as { p: number; d: number; e: number } | undefined;
    expect(q?.p).toBe(200);
    expect(q?.d).toBeGreaterThan(q?.e ?? 0); // deadline is in the future of enqueue

    await held.release();
    const waiter = await waiterPromise;
    // Once granted, the waiter's queue row is removed.
    expect(countQueue(projectNative, 'project', 'tasks')).toBe(0);
    await waiter.release();
  }, 35_000);
});
