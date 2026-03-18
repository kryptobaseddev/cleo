import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokenBudget } from '../budget.js';
describe('budget', () => {
    describe('estimateTokens', () => {
        it('estimates empty string as 0 tokens', () => {
            expect(estimateTokens('')).toBe(0);
        });
        it('estimates ~4 chars per token', () => {
            const text = 'a'.repeat(100);
            expect(estimateTokens(text)).toBe(25);
        });
        it('rounds up fractional tokens', () => {
            expect(estimateTokens('abc')).toBe(1);
        });
    });
    describe('truncateToTokenBudget', () => {
        it('returns text unchanged when within budget', () => {
            const text = 'short text';
            expect(truncateToTokenBudget(text, 100)).toBe(text);
        });
        it('truncates text exceeding budget', () => {
            const text = 'a'.repeat(2000);
            const result = truncateToTokenBudget(text, 100);
            expect(result.length).toBeLessThan(text.length);
            expect(result).toContain('[Truncated:');
        });
        it('truncates at line boundary when possible', () => {
            const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
            const text = lines.join('\n');
            const result = truncateToTokenBudget(text, 50);
            expect(result).toContain('[Truncated:');
            const contentBeforeTruncation = result.split('\n\n[Truncated:')[0];
            expect(contentBeforeTruncation.endsWith('\n')).toBe(false);
        });
        it('uses default budget of 500 tokens when none specified', () => {
            const text = 'x'.repeat(10000);
            const result = truncateToTokenBudget(text);
            expect(result).toContain('[Truncated:');
            expect(result).toContain('budget: 500');
        });
        it('includes token count and budget in truncation notice', () => {
            const text = 'x'.repeat(4000);
            const result = truncateToTokenBudget(text, 100);
            expect(result).toMatch(/\[Truncated: ~\d+ tokens, budget: 100\]/);
        });
    });
});
//# sourceMappingURL=budget.test.js.map