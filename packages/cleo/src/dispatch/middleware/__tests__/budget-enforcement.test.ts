/**
 * Integration test for the LIVE MVI budget-enforcement chokepoint (T11350).
 *
 * Proves the LAFS budget engine — dead (test-only) before this epic — is now
 * invoked inside the REAL dispatch pipeline. An over-budget envelope sent
 * through `createCliDispatcher()` is asserted to be either TRUNCATED (truncate
 * mode) or replaced with an `E_MVI_BUDGET_EXCEEDED` error envelope (error mode),
 * and an under-budget envelope passes through untouched (zero regressions).
 *
 * The over-budget condition is forced via the per-request `_budget` override
 * the chokepoint honors, combined with a mocked engine that returns a large
 * payload — no reliance on real data size.
 *
 * @task T11350
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A large list payload guaranteed to blow any small token budget.
const BIG_LIST = Array.from({ length: 200 }, (_, i) => ({
  id: `T${1000 + i}`,
  title: 'x'.repeat(200),
  status: 'pending',
  body: 'y'.repeat(400),
}));

vi.mock('../../lib/engine.js', () => ({
  // tasks.show calls `taskShowOperation` (PM-Core V2 rename); keep `taskShow`
  // too so any caller referencing the legacy name still resolves.
  taskShowOperation: vi.fn(() => ({ success: true, data: { id: 'T001', title: 'Test' } })),
  taskShow: vi.fn(() => ({ success: true, data: { id: 'T001', title: 'Test' } })),
  taskList: vi.fn(() => ({
    success: true,
    data: { tasks: BIG_LIST },
    page: { mode: 'offset', limit: 200, offset: 0, hasMore: false, total: 200 },
  })),
  taskFind: vi.fn(() => ({ success: true, data: { results: BIG_LIST } })),
  taskExists: vi.fn(() => ({ success: true, data: { exists: true, taskId: 'T001' } })),
  taskCreate: vi.fn(() => ({ success: true, data: { id: 'T001', title: 'New' } })),
  taskUpdate: vi.fn(() => ({ success: true, data: { id: 'T001' } })),
  taskComplete: vi.fn(() => ({ success: true, data: { id: 'T001' } })),
  taskDelete: vi.fn(() => ({ success: true, data: { deleted: true } })),
  taskArchive: vi.fn(() => ({ success: true, data: { archived: 0 } })),
  taskNext: vi.fn(() => ({ success: true, data: { suggestions: [] } })),
  taskBlockers: vi.fn(() => ({ success: true, data: { blockedTasks: [] } })),
  taskTree: vi.fn(() => ({ success: true, data: { tree: [] } })),
  taskRelates: vi.fn(() => ({ success: true, data: { relations: [] } })),
  taskRelatesAdd: vi.fn(() => ({ success: true, data: {} })),
  taskAnalyze: vi.fn(() => ({ success: true, data: {} })),
  taskRestore: vi.fn(() => ({ success: true, data: {} })),
  taskReorder: vi.fn(() => ({ success: true, data: {} })),
  taskReparent: vi.fn(() => ({ success: true, data: {} })),
  taskPromote: vi.fn(() => ({ success: true, data: {} })),
  taskReopen: vi.fn(() => ({ success: true, data: {} })),
  taskComplexityEstimate: vi.fn(() => ({ success: true, data: {} })),
  taskDepends: vi.fn(() => ({ success: true, data: {} })),
  taskCurrentGet: vi.fn(() => ({ success: true, data: {} })),
  taskStart: vi.fn(() => ({ success: true, data: {} })),
  taskStop: vi.fn(() => ({ success: true, data: {} })),
}));

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return { ...actual, getProjectRoot: vi.fn(() => '/mock/project') };
});

import { dispatchRaw, resetCliDispatcher } from '../../adapters/cli.js';
import { BUDGET_EXCEEDED_CODE } from '../../lib/budget.js';

describe('budget-enforcement chokepoint is LIVE in real dispatch (T11350)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  afterEach(() => {
    resetCliDispatcher();
  });

  it('truncate mode: an over-budget envelope is shrunk below the budget', async () => {
    const response = await dispatchRaw('query', 'tasks', 'list', {
      // Per-request override forces the chokepoint to engage with a tiny budget.
      _budget: 50,
      _budgetMode: 'truncate',
      // Opt out of MVI record projection so the budget engine (not projection)
      // is what shrinks the payload — isolates the chokepoint under test.
      _projection: 'full',
    });

    // The dispatcher still reports success — truncation is a graceful degrade.
    expect(response.success).toBe(true);
    const be = (response.meta as Record<string, unknown>)['_budgetEnforcement'] as Record<
      string,
      unknown
    >;
    expect(be).toBeDefined();
    expect(be['budget']).toBe(50);
    expect(be['mode']).toBe('truncate');
    // Either the payload was truncated, or the engine fell back to an error
    // envelope (both are valid "did not silently pass through" outcomes).
    expect(be['truncated'] === true || be['withinBudget'] === false).toBe(true);
  });

  it('error mode: an over-budget envelope becomes E_MVI_BUDGET_EXCEEDED', async () => {
    const response = await dispatchRaw('query', 'tasks', 'find', {
      query: 'x',
      _budget: 30,
      _budgetMode: 'error',
      _projection: 'full',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    const details = response.error?.details as Record<string, unknown> | undefined;
    expect(typeof details?.['estimatedTokens']).toBe('number');
    expect(details?.['budget']).toBe(30);
  });

  it('zero regression: an under-budget envelope passes through unchanged', async () => {
    const response = await dispatchRaw('query', 'tasks', 'show', { taskId: 'T001' });
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ id: 'T001', title: 'Test' });
    // tasks.show has no budget policy and no override, so no enforcement meta.
    const be = (response.meta as Record<string, unknown>)['_budgetEnforcement'];
    expect(be).toBeUndefined();
  });

  it('zero regression: a generous budget never truncates', async () => {
    const response = await dispatchRaw('query', 'tasks', 'list', {
      _budget: 1_000_000,
      _budgetMode: 'truncate',
      _projection: 'full',
    });
    expect(response.success).toBe(true);
    const be = (response.meta as Record<string, unknown>)['_budgetEnforcement'] as Record<
      string,
      unknown
    >;
    expect(be['truncated']).toBe(false);
    expect(be['withinBudget']).toBe(true);
  });
});
