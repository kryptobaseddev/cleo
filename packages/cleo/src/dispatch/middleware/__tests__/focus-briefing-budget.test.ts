/**
 * Enforce `cleo focus` ≤ 1500 and `cleo briefing` token budgets through the
 * LIVE budget chokepoint (T11352).
 *
 * Before this epic the focus ≤1500 contract was only a TSDoc comment in
 * `focus.ts` with ZERO runtime enforcement, and the weak focus test merely
 * asserted `tokensEstimated > 0`. This test drives the REAL
 * `createBudgetEnforcement()` middleware (the same instance wired into
 * `createCliDispatcher`) for the `focus.show` and `session.briefing.show`
 * operations and asserts that an over-budget payload is TRUNCATED or raised as
 * `E_MVI_BUDGET_EXCEEDED` — NOT merely that an estimate is positive.
 *
 * The ceiling is read from the single named constant {@link FOCUS_TOKEN_CEILING}
 * (no magic-number duplication): the test asserts the enforced budget stamped
 * on the response equals that constant.
 *
 * @task T11352
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { describe, expect, it } from 'vitest';
import { BUDGET_EXCEEDED_CODE } from '../../lib/budget.js';
import { BRIEFING_TOKEN_CEILING, FOCUS_TOKEN_CEILING } from '../../lib/budget-ceilings.js';
import type { DispatchRequest, DispatchResponse, DispatchResponseMeta } from '../../types.js';
import { createBudgetEnforcement } from '../budget-enforcement.js';

/** Build a bare dispatch request for a given domain/operation. */
function req(domain: string, operation: string): DispatchRequest {
  return {
    gateway: 'query',
    domain,
    operation,
    params: {},
    source: 'cli',
    requestId: '00000000-0000-0000-0000-000000000000',
  };
}

/** Build a minimal always-present response meta block. */
function meta(domain: string, operation: string): DispatchResponseMeta {
  return {
    gateway: 'query',
    domain,
    operation,
    timestamp: '2026-05-29T00:00:00.000Z',
    duration_ms: 0,
    source: 'cli',
    requestId: '00000000-0000-0000-0000-000000000000',
  };
}

/** A focus-shaped payload far larger than 1500 tokens. */
function overBudgetFocusData(): Record<string, unknown> {
  return {
    identity: { id: 'T9973', type: 'task' },
    scope: { taskId: 'T9973', epicId: 'T9964' },
    blockers: Array.from({ length: 50 }, (_, i) => ({
      id: `B${i}`,
      reason: 'x'.repeat(300),
    })),
    readyWave: Array.from({ length: 50 }, (_, i) => ({
      id: `T${i}`,
      title: 'y'.repeat(300),
    })),
    tokensEstimated: 0,
  };
}

describe('focus ≤1500 + briefing budgets enforced via live chokepoint (T11352)', () => {
  it('focus.show routes through the chokepoint with the FOCUS_TOKEN_CEILING constant', async () => {
    const mw = createBudgetEnforcement();
    // Small payload → within budget, but enforcement meta still stamped.
    const small: DispatchResponse = {
      meta: meta('focus', 'show'),
      success: true,
      data: { identity: { id: 'T1', type: 'task' }, blockers: [], tokensEstimated: 0 },
    };
    const out = await mw(req('focus', 'show'), async () => small);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be).toBeDefined();
    // Ceiling comes from the single named constant — no magic number.
    expect(be['budget']).toBe(FOCUS_TOKEN_CEILING);
    expect(be['budget']).toBe(1500);
    expect(be['withinBudget']).toBe(true);
    expect(be['truncated']).toBe(false);
  });

  it('an OVER-budget focus payload is TRUNCATED (not a weak tokensEstimated>0 pass)', async () => {
    const mw = createBudgetEnforcement();
    const big: DispatchResponse = {
      meta: meta('focus', 'show'),
      success: true,
      data: overBudgetFocusData(),
    };
    const out = await mw(req('focus', 'show'), async () => big);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(FOCUS_TOKEN_CEILING);
    // The enforced outcome is a real reduction, not a no-op: either truncated
    // (preferred — focus uses 'truncate' mode) or, in the pathological case,
    // an E_MVI_BUDGET_EXCEEDED error. Both prove enforcement actually fired.
    if (out.success) {
      expect(be['truncated']).toBe(true);
      expect(be['withinBudget']).toBe(true);
      // After truncation the post-enforcement estimate fits under the ceiling
      // — proving the payload was genuinely reduced (NOT a weak no-op pass).
      expect(be['estimatedTokens'] as number).toBeLessThanOrEqual(FOCUS_TOKEN_CEILING);
      // The truncation indicator is present on the reduced data payload.
      expect(JSON.stringify(out.data)).toContain('_truncated');
    } else {
      expect(out.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    }
  });

  it('briefing.show routes through the chokepoint with the BRIEFING_TOKEN_CEILING constant', async () => {
    const mw = createBudgetEnforcement();
    const small: DispatchResponse = {
      meta: meta('session', 'briefing.show'),
      success: true,
      data: { handoff: null, nextTasks: [] },
    };
    const out = await mw(req('session', 'briefing.show'), async () => small);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(BRIEFING_TOKEN_CEILING);
    expect(be['withinBudget']).toBe(true);
  });

  it('an OVER-budget briefing payload is TRUNCATED through the same path', async () => {
    const mw = createBudgetEnforcement();
    const big: DispatchResponse = {
      meta: meta('session', 'briefing.show'),
      success: true,
      data: {
        handoff: { note: 'n'.repeat(500) },
        nextTasks: Array.from({ length: 200 }, (_, i) => ({
          id: `T${i}`,
          title: 'z'.repeat(200),
        })),
      },
    };
    const out = await mw(req('session', 'briefing.show'), async () => big);
    const be = out.meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(be['budget']).toBe(BRIEFING_TOKEN_CEILING);
    if (out.success) {
      expect(be['truncated']).toBe(true);
      // Post-enforcement the payload fits the briefing ceiling.
      expect(be['estimatedTokens'] as number).toBeLessThanOrEqual(BRIEFING_TOKEN_CEILING);
    } else {
      expect(out.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    }
  });

  it('unpoliced ops are NOT budget-enforced (no enforcement meta)', async () => {
    const mw = createBudgetEnforcement();
    const resp: DispatchResponse = {
      meta: meta('tasks', 'show'),
      success: true,
      data: { id: 'T1', title: 'x'.repeat(50_000) },
    };
    const out = await mw(req('tasks', 'show'), async () => resp);
    expect(out.meta['_budgetEnforcement']).toBeUndefined();
    expect(out.success).toBe(true);
  });
});
