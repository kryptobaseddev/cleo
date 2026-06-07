/**
 * T10 — AC4 brain isolation (T11627 ST-4 · Seam 2).
 *
 * Asserts the spec test-plan row T10:
 *   - A lease-less write to the dedicated brain WRITE handle throws
 *     `E_WRITER_LEASE_REQUIRED` (AC4 guard — enforcement, not convention).
 *   - The `brain` lane is held INDEPENDENTLY of the `tasks` chokepoint within
 *     one scope (holding `tasks` does not satisfy / block a `brain` write, and
 *     vice-versa).
 *   - `off` mode is exempt from the AC4 guard (no lease; busy_timeout serializes).
 *
 * Every test injects a TEMP-DIR cleo.db (no canonical-path side effects, no
 * supervisor) via `_setNativeDbResolverForTest`, migrated through the real
 * dual-scope chokepoint so the raw partial-unique index (AC1) is present.
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
  assertWriterLeaseHeld,
  hasActiveGrant,
  type LeaseScope,
  WriterLeaseRequiredError,
} from '../writer-lease.js';
import { WRITER_LEASES_TABLE } from '../writer-lease-schema.js';

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

function injectResolver(): void {
  _setNativeDbResolverForTest(async (scope) =>
    scope === 'project' ? projectNative : globalNative,
  );
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

beforeEach(async () => {
  testRoot = join(
    tmpdir(),
    `writer-lease-brain-ac4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projectNative = await openTempScope('project', join(testRoot, 'project', '.cleo'));
  globalNative = await openTempScope('global', join(testRoot, 'global'));

  delete process.env.CLEO_WRITER_LEASE_MODE;
  _resetWriterLeaseStateForTest();
  injectResolver();
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

// ── AC4 guard — lease-less write throws ──────────────────────────────────────

describe('T10 — AC4 brain isolation (lease-less write throws)', () => {
  it('assertWriterLeaseHeld throws E_WRITER_LEASE_REQUIRED when no brain grant is held', () => {
    // No lease acquired → the AC4 guard must throw the typed error.
    expect(() => assertWriterLeaseHeld('project', 'brain')).toThrow(WriterLeaseRequiredError);
    expect(() => assertWriterLeaseHeld('project', 'brain')).toThrow(/E_WRITER_LEASE_REQUIRED/);
  });

  it('the thrown error carries the stable E_WRITER_LEASE_REQUIRED codeName', () => {
    try {
      assertWriterLeaseHeld('project', 'brain');
      throw new Error('expected assertWriterLeaseHeld to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WriterLeaseRequiredError);
      expect((err as WriterLeaseRequiredError).codeName).toBe('E_WRITER_LEASE_REQUIRED');
    }
  });

  it('a held brain grant satisfies the guard (no throw)', async () => {
    const h = await acquireWriterLease('project', 'brain');
    expect(hasActiveGrant('project', 'brain')).toBe(true);
    expect(() => assertWriterLeaseHeld('project', 'brain')).not.toThrow();
    await h.release();
    // Released → guard throws again.
    expect(hasActiveGrant('project', 'brain')).toBe(false);
    expect(() => assertWriterLeaseHeld('project', 'brain')).toThrow(WriterLeaseRequiredError);
  });

  it("'off' mode is EXEMPT from the AC4 guard (no lease, busy_timeout serializes)", () => {
    process.env.CLEO_WRITER_LEASE_MODE = 'off';
    _resetWriterLeaseStateForTest();
    injectResolver();
    // off-mode → assertion is a no-op pass-through even with no grant held.
    expect(() => assertWriterLeaseHeld('project', 'brain')).not.toThrow();
  });
});

// ── brain lane independence from tasks ───────────────────────────────────────

describe('T10 — brain lane held independently of the tasks chokepoint', () => {
  it('holding the tasks lease does NOT satisfy the brain AC4 guard', async () => {
    const tasks = await acquireWriterLease('project', 'tasks');
    expect(hasActiveGrant('project', 'tasks')).toBe(true);
    // The brain lane is a DISTINCT grant — a tasks grant must not satisfy it.
    expect(hasActiveGrant('project', 'brain')).toBe(false);
    expect(() => assertWriterLeaseHeld('project', 'brain')).toThrow(WriterLeaseRequiredError);
    await tasks.release();
  });

  it('brain and tasks leases are held simultaneously, each its own active row', async () => {
    const tasks = await acquireWriterLease('project', 'tasks');
    const brain = await acquireWriterLease('project', 'brain');
    // Two distinct active rows in the same scope file — independent lanes.
    expect(countActive(projectNative, 'project', 'tasks')).toBe(1);
    expect(countActive(projectNative, 'project', 'brain')).toBe(1);
    expect(() => assertWriterLeaseHeld('project', 'tasks')).not.toThrow();
    expect(() => assertWriterLeaseHeld('project', 'brain')).not.toThrow();
    await tasks.release();
    // tasks released → brain still satisfies its own guard.
    expect(() => assertWriterLeaseHeld('project', 'brain')).not.toThrow();
    expect(() => assertWriterLeaseHeld('project', 'tasks')).toThrow(WriterLeaseRequiredError);
    await brain.release();
    expect(countActive(projectNative, 'project', 'brain')).toBe(0);
  });
});
