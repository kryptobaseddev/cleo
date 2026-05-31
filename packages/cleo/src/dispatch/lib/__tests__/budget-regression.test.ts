/**
 * Budget chokepoint forward-only regression test (T11424).
 *
 * Asserts that the budget.ts module still imports the canonical symbols from
 * @cleocode/lafs and that the focus ≤ 1500 token enforcement wired in T11285/T11350
 * remains operational. Any refactor that moves these symbols or renames the imports
 * will fail this test — intentional; the budget chokepoint MUST stay green.
 *
 * @task T11424
 * @epic T11394 E7-LAFS-CANONICAL
 */

import { describe, expect, it } from 'vitest';
import { BUDGET_EXCEEDED_CODE, enforceBudget, isWithinBudget } from '../budget.js';

// ─────────────────────────────────────────────────────────────────────────────
// Symbol-resolution regression: confirms the canonical LAFS imports are wired
// ─────────────────────────────────────────────────────────────────────────────

describe('budget chokepoint — import contract regression (T11424)', () => {
  it('BUDGET_EXCEEDED_CODE is a non-empty string (resolves from @cleocode/lafs)', () => {
    expect(typeof BUDGET_EXCEEDED_CODE).toBe('string');
    expect(BUDGET_EXCEEDED_CODE.length).toBeGreaterThan(0);
  });

  it('enforceBudget is callable (applyBudgetEnforcement wired)', () => {
    const response = { success: true, data: { ok: true } };
    const result = enforceBudget(response, 10000);
    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('enforcement');
    expect(result).toHaveProperty('exceeded');
    expect(typeof result.exceeded).toBe('boolean');
  });

  it('isWithinBudget is callable (checkBudget wired)', () => {
    const response = { success: true, data: { ok: true } };
    expect(typeof isWithinBudget(response, 10000)).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Focus ≤ 1500 enforcement: simulates the dispatch chokepoint behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('budget chokepoint — focus ≤ 1500 token enforcement (T11285)', () => {
  it('small response is within a 1500-token budget', () => {
    const smallFocusResponse = {
      success: true,
      data: {
        identity: { id: 'T11394', title: 'E7 LAFS' },
        scope: { epicId: 'T11394' },
        blockers: [],
        readyWave: [],
      },
    };
    expect(isWithinBudget(smallFocusResponse, 1500)).toBe(true);
  });

  it('oversized response exceeds a 1-token budget (overflow detection works)', () => {
    const largeResponse = {
      success: true,
      data: {
        items: Array.from({ length: 200 }, (_, i) => ({
          id: `T${i}`,
          title: 'x'.repeat(200),
          description: 'y'.repeat(400),
        })),
      },
    };
    expect(isWithinBudget(largeResponse, 1)).toBe(false);
  });

  it('enforceBudget adds _budgetEnforcement meta to response', () => {
    const response = { success: true, data: { ok: true }, meta: { operation: 'focus.show' } };
    const { response: enforced } = enforceBudget(response, 1500);
    const meta = enforced['meta'] as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta['_budgetEnforcement']).toBeDefined();
    const be = meta['_budgetEnforcement'] as Record<string, unknown>;
    expect(typeof be['estimatedTokens']).toBe('number');
    expect(be['budget']).toBe(1500);
  });
});
