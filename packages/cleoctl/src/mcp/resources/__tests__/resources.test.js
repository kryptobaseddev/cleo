import { describe, expect, it } from 'vitest';
import { listMemoryResources, readMemoryResource } from '../index.js';
describe('MCP memory resources', () => {
    describe('listMemoryResources', () => {
        it('returns all 4 resource definitions', () => {
            const resources = listMemoryResources();
            expect(resources).toHaveLength(4);
        });
        it('includes cleo://memory/recent', () => {
            const resources = listMemoryResources();
            const recent = resources.find((r) => r.uri === 'cleo://memory/recent');
            expect(recent).toBeDefined();
            expect(recent.name).toBe('Recent Observations');
            expect(recent.mimeType).toBe('text/markdown');
        });
        it('includes cleo://memory/learnings', () => {
            const resources = listMemoryResources();
            const learnings = resources.find((r) => r.uri === 'cleo://memory/learnings');
            expect(learnings).toBeDefined();
            expect(learnings.name).toBe('Active Learnings');
        });
        it('includes cleo://memory/patterns', () => {
            const resources = listMemoryResources();
            const patterns = resources.find((r) => r.uri === 'cleo://memory/patterns');
            expect(patterns).toBeDefined();
            expect(patterns.name).toBe('Active Patterns');
        });
        it('includes cleo://memory/handoff', () => {
            const resources = listMemoryResources();
            const handoff = resources.find((r) => r.uri === 'cleo://memory/handoff');
            expect(handoff).toBeDefined();
            expect(handoff.name).toBe('Session Handoff');
        });
        it('all resources have description and mimeType', () => {
            const resources = listMemoryResources();
            for (const r of resources) {
                expect(r.description).toBeTruthy();
                expect(r.mimeType).toBe('text/markdown');
                expect(r.uri).toMatch(/^cleo:\/\/memory\//);
            }
        });
    });
    describe('readMemoryResource', () => {
        it('returns null for unknown URI', async () => {
            const result = await readMemoryResource('cleo://unknown/resource');
            expect(result).toBeNull();
        });
        it('returns markdown content for cleo://memory/recent (no brain.db)', async () => {
            const result = await readMemoryResource('cleo://memory/recent');
            expect(result).not.toBeNull();
            expect(result.mimeType).toBe('text/markdown');
            expect(result.uri).toBe('cleo://memory/recent');
            expect(typeof result.text).toBe('string');
        });
        it('returns markdown content for cleo://memory/learnings (no brain.db)', async () => {
            const result = await readMemoryResource('cleo://memory/learnings');
            expect(result).not.toBeNull();
            expect(result.mimeType).toBe('text/markdown');
        });
        it('returns markdown content for cleo://memory/patterns (no brain.db)', async () => {
            const result = await readMemoryResource('cleo://memory/patterns');
            expect(result).not.toBeNull();
            expect(result.mimeType).toBe('text/markdown');
        });
        it('returns markdown content for cleo://memory/handoff (no brain.db)', async () => {
            const result = await readMemoryResource('cleo://memory/handoff');
            expect(result).not.toBeNull();
            expect(result.mimeType).toBe('text/markdown');
        });
        it('respects token budget parameter', async () => {
            const result = await readMemoryResource('cleo://memory/recent', 10);
            expect(result).not.toBeNull();
            expect(typeof result.text).toBe('string');
        });
    });
});
//# sourceMappingURL=resources.test.js.map