/** Budgeting must preserve caller-required facts and disclose omitted content. */
import { describe, expect, it } from 'vitest';
import { applyBudgetEnforcement } from '../src/budgetEnforcement.js';
import type { LAFSEnvelope } from '../src/types.js';

function envelope(result: LAFSEnvelope['result']): LAFSEnvelope {
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: { specVersion: '1.0.0', schemaVersion: '1.0.0', timestamp: '2026-09-19T00:00:00Z', operation: 'test', requestId: 'budget-truth', transport: 'cli', strict: false, mvi: 'standard', contextVersion: 1 },
    success: true,
    result,
  };
}

describe('budget truth fields', () => {
  it('retains required trailing diagnostics before optional examples', () => {
    const result = applyBudgetEnforcement(envelope({ id: 'T1', examples: 'x'.repeat(3000), coverage: { status: 'failed' }, pendingRepairs: ['R1'] }), 100, { truncateOnExceed: true, requiredFields: ['coverage', 'pendingRepairs'] });
    expect(result.withinBudget).toBe(true);
    expect(result.envelope.result).toMatchObject({ id: 'T1', coverage: { status: 'failed' }, pendingRepairs: ['R1'], _withheld: { examples: 3000 } });
  });

  it('rejects budgets that cannot carry mandatory facts and disclosure', () => {
    const result = applyBudgetEnforcement(envelope({ coverage: { status: 'failed' }, details: 'x'.repeat(100) }), 1, { truncateOnExceed: true, requiredFields: ['coverage'] });
    expect(result.withinBudget).toBe(false);
    expect(result.envelope.success).toBe(false);
    expect(result.envelope.error?.code).toBe('E_MVI_BUDGET_EXCEEDED');
  });

  it('merges previous omissions and measures Unicode bytes', () => {
    const result = applyBudgetEnforcement(envelope({ id: 'T1', _withheld: { original: 17 }, example: 'é😀'.repeat(1000) }), 60, { truncateOnExceed: true });
    expect(result.withinBudget).toBe(true);
    expect(result.envelope.result).toMatchObject({ _withheld: { original: 17, example: 6000 } });
  });
  it('measures an array together with its omitted-record count', () => {
    const source = Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: 'x'.repeat(100) }));
    const result = applyBudgetEnforcement(envelope(source), 50, { truncateOnExceed: true });
    expect(result.withinBudget).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);
    expect(result.envelope.result).toEqual([{ ...source[0], _truncated: true, remainingItems: 9 }]);
  });

});
