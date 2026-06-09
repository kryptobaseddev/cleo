/**
 * Tests for the durable DHQ adapter (T11889-C · T11913).
 *
 * Two adapter-discipline proofs (AC2 / risk R1):
 *  1. **Leased write path** — every WRITE method (`upsertOpenDhq`, `recordPrUrl`)
 *     goes through `withWriterLease('project','bulk',…)`. With the lease module
 *     mocked, each write acquires the `(project, bulk)` lease exactly once and runs
 *     the accessor INSIDE the leased section. Reads do NOT lease.
 *  2. **`selfimprove_dhq` ONLY** — the native handle the adapter hands to the
 *     accessor records every `prepare(sql)` it sees; the adapter's writes reference
 *     ONLY the `selfimprove_dhq` table (never a prod `tasks`/`brain` row). This is
 *     the adapter-discipline guarantee — the lease serializes, it does not confine.
 *
 * The store accessor + lease are MOCKED so this is a pure unit test (no DB).
 *
 * @epic T11889
 * @task T11913
 */

import { describe, expect, it, vi } from 'vitest';

// ── Mock the lease: capture (scope, lane) and run fn() inline ──────────────────
const leaseCalls: Array<{ scope: string; lane: string }> = [];
vi.mock('../../store/writer-lease.js', () => ({
  withWriterLease: vi.fn(
    async (scope: string, lane: string, fn: (h: unknown) => Promise<unknown>) => {
      leaseCalls.push({ scope, lane });
      return fn({});
    },
  ),
}));

// ── Mock the store accessor: a fake native handle that records prepared SQL ────
const preparedSql: string[] = [];
const fakeNative = {
  prepare(sql: string) {
    preparedSql.push(sql);
    return {
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      get: () => undefined,
      all: () => [],
    };
  },
};

vi.mock('../../store/selfimprove-dhq-store.js', async () => {
  // Pull the REAL accessor SQL (so the table-targeting assertion exercises the
  // genuine prepared statements) but stub the native-handle resolver.
  const actual = await vi.importActual<typeof import('../../store/selfimprove-dhq-store.js')>(
    '../../store/selfimprove-dhq-store.js',
  );
  return {
    ...actual,
    getSelfimproveDhqNativeDb: vi.fn(async () => fakeNative),
  };
});

import { createDhqAdapter } from '../dhq-adapter.js';

describe('dhq-adapter — lease discipline', () => {
  it('upsertOpenDhq acquires the (project, bulk) lease exactly once', async () => {
    leaseCalls.length = 0;
    const adapter = createDhqAdapter({ now: () => 42 });
    await adapter.upsertOpenDhq({
      dhqId: 'DHQ-x',
      scenario: 'scen',
      questionHash: 'h',
      title: 't',
      regressionJson: '{}',
      severity: null,
      runId: 'r',
    });
    expect(leaseCalls).toEqual([{ scope: 'project', lane: 'bulk' }]);
  });

  it('recordPrUrl acquires the (project, bulk) lease exactly once', async () => {
    leaseCalls.length = 0;
    const adapter = createDhqAdapter({ now: () => 42 });
    await adapter.recordPrUrl('h', 'https://x/pull/1');
    expect(leaseCalls).toEqual([{ scope: 'project', lane: 'bulk' }]);
  });

  it('readOpen does NOT acquire a lease (reads are lease-free)', async () => {
    leaseCalls.length = 0;
    const adapter = createDhqAdapter();
    await adapter.readOpen('h');
    expect(leaseCalls).toHaveLength(0);
  });
});

describe('dhq-adapter — writes target ONLY selfimprove_dhq', () => {
  it('every prepared write statement references selfimprove_dhq and no other table', async () => {
    preparedSql.length = 0;
    const adapter = createDhqAdapter({ now: () => 1 });

    await adapter.upsertOpenDhq({
      dhqId: 'DHQ-1',
      scenario: 'scen',
      questionHash: 'h',
      title: 't',
      regressionJson: '{}',
      severity: null,
      runId: 'r',
    });
    await adapter.recordPrUrl('h', 'url');

    expect(preparedSql.length).toBeGreaterThan(0);
    // Forbidden production tables the loop MUST NEVER write.
    const FORBIDDEN = ['tasks', 'brain', 'task_relations', 'sessions', 'audit_log'];
    for (const sql of preparedSql) {
      expect(sql).toContain('selfimprove_dhq');
      for (const tbl of FORBIDDEN) {
        // Word-boundary match so `selfimprove_dhq` itself never trips on a substring.
        expect(new RegExp(`\\b${tbl}\\b`).test(sql)).toBe(false);
      }
    }
  });
});
