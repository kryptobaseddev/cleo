import { describe, expect, it } from 'vitest';
import { getOperationsByChannel, getPreferredChannel, getRoutingForDomain, } from '../routing-table.js';
describe('routing-table', () => {
    describe('getPreferredChannel (via capability matrix)', () => {
        it('returns mcp for memory.find', () => {
            expect(getPreferredChannel('memory', 'find')).toBe('mcp');
        });
        it('returns mcp for memory.fetch', () => {
            expect(getPreferredChannel('memory', 'fetch')).toBe('mcp');
        });
        it('returns cli for pipeline.release.ship', () => {
            expect(getPreferredChannel('pipeline', 'release.ship')).toBe('cli');
        });
        it('returns either for admin.version', () => {
            expect(getPreferredChannel('admin', 'version')).toBe('either');
        });
        it('returns either for unknown operations', () => {
            expect(getPreferredChannel('nonexistent', 'op')).toBe('either');
        });
        it('returns mcp for tasks.show', () => {
            expect(getPreferredChannel('tasks', 'show')).toBe('mcp');
        });
        it('returns mcp for session.status', () => {
            expect(getPreferredChannel('session', 'status')).toBe('mcp');
        });
        it('returns mcp for admin.dash', () => {
            expect(getPreferredChannel('admin', 'dash')).toBe('mcp');
        });
    });
    describe('getRoutingForDomain', () => {
        it('returns entries covering all 10 canonical domains', () => {
            const domains = [
                'memory',
                'tasks',
                'session',
                'admin',
                'tools',
                'check',
                'pipeline',
                'orchestrate',
                'nexus',
                'sticky',
            ];
            for (const domain of domains) {
                const entries = getRoutingForDomain(domain);
                expect(entries.length).toBeGreaterThan(0);
                expect(entries.every((e) => e.domain === domain)).toBe(true);
            }
        });
        it('returns all memory domain entries', () => {
            const entries = getRoutingForDomain('memory');
            expect(entries.length).toBeGreaterThan(0);
            expect(entries.every((e) => e.domain === 'memory')).toBe(true);
        });
        it('every entry has required fields with valid channel', () => {
            const entries = getRoutingForDomain('tasks');
            for (const entry of entries) {
                expect(entry.domain).toBeTruthy();
                expect(entry.operation).toBeTruthy();
                expect(['mcp', 'cli', 'either']).toContain(entry.preferredChannel);
            }
        });
        it('returns empty array for unknown domain', () => {
            expect(getRoutingForDomain('nonexistent')).toEqual([]);
        });
    });
    describe('getOperationsByChannel', () => {
        it('returns mcp-preferred operations', () => {
            const mcpOps = getOperationsByChannel('mcp');
            expect(mcpOps.length).toBeGreaterThan(0);
            expect(mcpOps.every((e) => e.preferredChannel === 'mcp')).toBe(true);
        });
        it('returns cli-preferred operations', () => {
            const cliOps = getOperationsByChannel('cli');
            expect(cliOps.length).toBeGreaterThan(0);
            expect(cliOps.every((e) => e.preferredChannel === 'cli')).toBe(true);
        });
        it('mcp-preferred operations outnumber cli-preferred', () => {
            const mcpCount = getOperationsByChannel('mcp').length;
            const cliCount = getOperationsByChannel('cli').length;
            expect(mcpCount).toBeGreaterThan(cliCount);
        });
        it('has no duplicate domain+operation pairs within a channel', () => {
            const mcpOps = getOperationsByChannel('mcp');
            const keys = mcpOps.map((e) => `${e.domain}.${e.operation}`);
            const unique = new Set(keys);
            expect(unique.size).toBe(keys.length);
        });
    });
});
//# sourceMappingURL=routing-table.test.js.map