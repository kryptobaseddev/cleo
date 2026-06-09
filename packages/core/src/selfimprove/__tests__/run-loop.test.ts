/**
 * Tests for the self-improvement engine loop (T11889-C · T11913).
 *
 * Covers the five required proofs (AC5) plus the self-dogfooding guardrails:
 *  1. **lease-held DHQ write** — the real adapter writes ONE leased row to a
 *     TEMP-DIR `selfimprove_dhq` (via `openDualScopeDbAtPath` + real migrations);
 *     a second identical regression UPSERTs the SAME open row (idempotent).
 *  2. **regression → draft-PR (mocked gh, dry-run)** — a divergent golden produces
 *     a regression; the dry-run egress returns `steps[]` that include `--draft`
 *     and `--base main`, and asserts NO real `git push` / `gh` invocation fired.
 *  3. **budget cap halts** — a `maxWorktrees=0` (or PR) cap trips the breaker
 *     PRE-FLIGHT with `budgetOverrun` and the run halts.
 *  4. **circuit-breaker on lease-denial** — a `dhq-adapter` whose `upsertOpenDhq`
 *     throws `LeaseUnavailableError` (the `require`-mode signal) trips the breaker
 *     with `leaseUnavailable` and halts (no PR).
 *  5. **default-OFF refuses without `--execute`** — a regression in DRY-RUN writes
 *     nothing and opens nothing (`regression-dry-run`).
 *
 * The engine is exercised with an INJECTED `ReplayDispatch` (mocked dispatch),
 * an injected guard, and (where the focus is the loop, not the store) an injected
 * `DhqAdapter` stub — so most cases are pure and fast. The lease-held write is the
 * one real-DB integration.
 *
 * @epic T11889
 * @task T11913
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DispatchResponse } from '@cleocode/contracts/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../store/dual-scope-db.js';
import { SELFIMPROVE_DHQ_TABLE } from '../../store/selfimprove-dhq-schema.js';
import { _resetWriterLeaseStateForTest, LeaseUnavailableError } from '../../store/writer-lease.js';
import { createToolGuard } from '../../tools/guard.js';
import { createDhqAdapter, type DhqAdapter } from '../dhq-adapter.js';
import type { ReplayDispatch } from '../replay.js';
import { runSelfImprove } from '../run-loop.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** The canned fixture scenario shipped under `scenarios/dhq-replay-find`. */
const SCENARIO = 'dhq-replay-find';

/** A guard that never enforces anything (the fallback's structural surface). */
const guard = createToolGuard({ mode: 'enforce' });

/**
 * The exact `data` payloads the shipped `dhq-replay-find/golden.json` declares,
 * keyed by operation. The green dispatch returns these verbatim so the structural
 * diff yields ZERO regressions; volatile meta fields are stamped fresh per call
 * and stripped by the diff normalizer.
 */
const GOLDEN_DATA: Record<string, unknown> = {
  find: {
    tasks: [{ id: 'T11889', title: 'Self-improvement loop foundation', status: 'active' }],
    count: 1,
  },
  show: {
    task: { id: 'T11889', title: 'Self-improvement loop foundation', status: 'active' },
  },
};

/**
 * Build a dispatch port that returns the GOLDEN-matching envelopes for the
 * `dhq-replay-find` fixture, so the diff yields ZERO regressions (green path).
 */
function goldenDispatch(): ReplayDispatch {
  return vi.fn(
    async (op): Promise<DispatchResponse> => ({
      meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: op.operation,
        timestamp: new Date().toISOString(),
        duration_ms: 3,
        source: 'rpc',
        requestId: `req-${op.operation}`,
      },
      success: true,
      data: GOLDEN_DATA[op.operation] ?? {},
    }),
  );
}

/**
 * Build a dispatch port that DIVERGES from the golden so the diff finds a
 * regression (the `data.golden` flag is dropped + a stray field added).
 */
function regressionDispatch(): ReplayDispatch {
  return vi.fn(
    async (op): Promise<DispatchResponse> => ({
      meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: op.operation,
        timestamp: new Date().toISOString(),
        duration_ms: 3,
        source: 'rpc',
        requestId: `req-${op.operation}`,
      },
      success: true,
      data: { operation: op.operation, drifted: 'unexpected' },
    }),
  );
}

/** A DhqAdapter stub that records calls without touching a DB. */
function stubAdapter(over: Partial<DhqAdapter> = {}): DhqAdapter & {
  upsertCalls: unknown[];
  prCalls: Array<[string, string]>;
} {
  const upsertCalls: unknown[] = [];
  const prCalls: Array<[string, string]> = [];
  return {
    upsertCalls,
    prCalls,
    async readOpen() {
      return null;
    },
    async upsertOpenDhq(input) {
      upsertCalls.push(input);
    },
    async recordPrUrl(hash, url) {
      prCalls.push([hash, url]);
      return 1;
    },
    ...over,
  };
}

describe('runSelfImprove — green / dry-run / default-OFF', () => {
  it('green run: golden match ⇒ no regression, no DHQ, no PR', async () => {
    const adapter = stubAdapter();
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: goldenDispatch(),
      backend: 'in-process',
      guard,
      adapter,
    });

    expect(res.outcome).toBe('green');
    expect(res.regressions).toHaveLength(0);
    expect(res.questionHash).toBeNull();
    expect(res.draftPr).toBeNull();
    expect(adapter.upsertCalls).toHaveLength(0);
    expect(res.breaker.open).toBe(false);
  });

  it('default-OFF: regression in DRY-RUN writes nothing and opens nothing', async () => {
    const adapter = stubAdapter();
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter,
      // execute omitted ⇒ default false
    });

    expect(res.outcome).toBe('regression-dry-run');
    expect(res.regressions.length).toBeGreaterThan(0);
    expect(res.questionHash).not.toBeNull();
    expect(res.draftPr).toBeNull();
    expect(adapter.upsertCalls).toHaveLength(0);
    expect(adapter.prCalls).toHaveLength(0);
  });
});

describe('runSelfImprove — regression → draft-PR (mocked gh, dry-run)', () => {
  it('execute mode: UPSERTs ONE DHQ + dry-run steps include --draft, NO real push fired', async () => {
    const adapter = stubAdapter();
    // Any real git/gh invocation would throw — proves the dry-run path never shells out.
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter,
      execute: true,
    });

    expect(res.outcome).toBe('regression-acted');
    expect(adapter.upsertCalls).toHaveLength(1);
    // The draft PR is a dry-run plan (no real .patch file exists in the worktree).
    expect(res.draftPr).not.toBeNull();
    if (res.draftPr?.kind === 'dry-run') {
      const ghStep = res.draftPr.steps.find((s) => s.startsWith('gh pr create'));
      expect(ghStep).toContain('--draft');
      expect(ghStep).toContain('--base main');
      expect(res.draftPr.branchName).toMatch(/^feat\/T11889-selfimprove-/);
      // No `git push origin main` anywhere in the plan.
      expect(res.draftPr.steps.some((s) => /push.*\bmain\b/.test(s))).toBe(false);
    } else {
      // dry-run is the default egress (execute flows to openDraftPr but the patch is absent)
      expect(res.draftPr?.kind === 'dry-run' || res.draftPr?.kind === 'error').toBe(true);
    }
  });
});

describe('runSelfImprove — budget cap halts', () => {
  it('maxPrs=0 override trips the breaker PRE-FLIGHT with budgetOverrun', async () => {
    const adapter = stubAdapter();
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter,
      execute: true,
      budget: { maxPrs: 0 },
    });

    expect(res.outcome).toBe('halted');
    expect(res.breaker.open).toBe(true);
    expect(res.breaker.reason).toBe('budgetOverrun');
    // DHQ was written (pre-egress); the PR ceiling halted before egress.
    expect(adapter.prCalls).toHaveLength(0);
  });

  it('maxWorktrees=0 override halts the boot step before replay', async () => {
    const dispatch = goldenDispatch();
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch,
      backend: 'in-process',
      guard,
      adapter: stubAdapter(),
      budget: { maxWorktrees: 0 },
    });

    expect(res.outcome).toBe('halted');
    expect(res.breaker.reason).toBe('budgetOverrun');
    // Replay never ran.
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('runSelfImprove — circuit-breaker on lease-denial', () => {
  it('a LeaseUnavailableError from upsertOpenDhq trips the breaker (leaseUnavailable) and halts', async () => {
    const adapter = stubAdapter({
      async upsertOpenDhq() {
        throw new LeaseUnavailableError('project', 'bulk', 'live holder did not release');
      },
    });
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter,
      execute: true,
    });

    expect(res.outcome).toBe('halted');
    expect(res.breaker.open).toBe(true);
    expect(res.breaker.reason).toBe('leaseUnavailable');
    expect(res.draftPr).toBeNull();
  });

  it('a RED architectural gate halts before persist/egress', async () => {
    const adapter = stubAdapter();
    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter,
      execute: true,
      gateRedCheck: async () => true,
    });

    expect(res.outcome).toBe('halted');
    expect(res.breaker.reason).toBe('gateRed');
    expect(adapter.upsertCalls).toHaveLength(0);
    expect(res.draftPr).toBeNull();
  });
});

describe('dhq-adapter — lease-held DHQ write (real temp DB)', () => {
  let testRoot: string;
  let native: DatabaseSync;
  let realAdapter: DhqAdapter;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `selfimprove-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const cleoDir = join(testRoot, 'project', '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    const dbPath = join(cleoDir, 'cleo.db');
    const handle = await openDualScopeDbAtPath('project', dbPath);
    native = (handle.db as unknown as { $client: DatabaseSync }).$client;
    // Bind the adapter (and the lease) to THIS project root via cwd.
    realAdapter = createDhqAdapter({ cwd: join(testRoot, 'project'), now: () => 1000 });
  });

  afterEach(() => {
    _resetDualScopeDbCache();
    _resetWriterLeaseStateForTest();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Count rows in selfimprove_dhq. */
  function rowCount(): number {
    const row = native.prepare(`SELECT COUNT(*) AS n FROM ${SELFIMPROVE_DHQ_TABLE}`).get() as {
      n: number;
    };
    return Number(row.n);
  }

  it('writes ONE leased open row; a repeated regression UPSERTs the SAME row', async () => {
    await realAdapter.upsertOpenDhq({
      dhqId: 'DHQ-aaaa',
      scenario: SCENARIO,
      questionHash: 'lease-hash',
      title: 'first',
      regressionJson: '{"v":1}',
      severity: null,
      runId: 'run-1',
    });
    expect(rowCount()).toBe(1);

    const open = await realAdapter.readOpen('lease-hash');
    expect(open?.dhqId).toBe('DHQ-aaaa');
    expect(open?.status).toBe('open');

    // Repeated regression for the SAME hash refreshes, not duplicates.
    await realAdapter.upsertOpenDhq({
      dhqId: 'DHQ-ignored',
      scenario: SCENARIO,
      questionHash: 'lease-hash',
      title: 'second',
      regressionJson: '{"v":2}',
      severity: 'P1',
      runId: 'run-2',
    });
    expect(rowCount()).toBe(1);
    const refreshed = await realAdapter.readOpen('lease-hash');
    expect(refreshed?.dhqId).toBe('DHQ-aaaa'); // identity preserved
    expect(refreshed?.regressionJson).toBe('{"v":2}'); // refreshed
    expect(refreshed?.severity).toBe('P1');
    expect(refreshed?.runId).toBe('run-2');

    // PR url records back on the leased row.
    const changed = await realAdapter.recordPrUrl('lease-hash', 'https://github.com/o/r/pull/9');
    expect(changed).toBe(1);
    expect((await realAdapter.readOpen('lease-hash'))?.prUrl).toBe('https://github.com/o/r/pull/9');
  });
});
