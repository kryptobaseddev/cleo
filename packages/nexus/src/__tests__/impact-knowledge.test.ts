/** Truthful raw graph impact regressions for missing coverage and ambiguous symbols. */
import type { GraphNode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { analyzeImpact, ImpactSymbolAmbiguityError } from '../intelligence/impact.js';

function symbol(id: string, filePath: string): GraphNode {
  return {
    id,
    kind: 'function',
    name: 'orgNameTaken',
    filePath,
    startLine: 1,
    endLine: 2,
    language: 'typescript',
    exported: true,
  };
}
describe('raw graph knowledge impact', () => {
  it('reports unknown when an empty graph cannot assess the target', () => {
    expect(analyzeImpact('orgNameTaken', [], []).riskLevel).toBe('unknown');
  });
  it('requires an exact ID when two checkouts contain the same name', () => {
    const candidates = [
      symbol('function:one:orgNameTaken', 'one.ts'),
      symbol('function:two:orgNameTaken', 'two.ts'),
    ];
    try {
      analyzeImpact('orgNameTaken', candidates, []);
      throw new Error('Expected ambiguity');
    } catch (error) {
      expect(error).toBeInstanceOf(ImpactSymbolAmbiguityError);
      if (error instanceof ImpactSymbolAmbiguityError)
        expect(error.candidates.map((item) => item.id)).toEqual(candidates.map((item) => item.id));
    }
    expect(analyzeImpact(candidates[1]!.id, candidates, []).riskLevel).toBe('none');
  });
  it('prefers an exact ID over another node with the same display name', () => {
    const exact = symbol('orgNameTaken', 'one.ts');
    expect(analyzeImpact('orgNameTaken', [exact, symbol('second', 'two.ts')], []).riskLevel).toBe(
      'none',
    );
  });
});
