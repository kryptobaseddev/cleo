"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const serializer_1 = require("../../src/migrate/serializer");
(0, vitest_1.describe)('serializer', () => {
    (0, vitest_1.describe)('serializeCantDocument', () => {
        (0, vitest_1.it)('should generate frontmatter with kind and version', () => {
            const doc = {
                kind: 'agent',
                version: 1,
                block: {
                    type: 'agent',
                    name: 'test-agent',
                    properties: [],
                    permissions: [],
                    children: [],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('---\nkind: agent\nversion: 1\n---');
        });
        (0, vitest_1.it)('should serialize agent with properties', () => {
            const doc = {
                kind: 'agent',
                version: 1,
                block: {
                    type: 'agent',
                    name: 'ops-lead',
                    properties: [
                        { key: 'model', value: 'opus' },
                        { key: 'prompt', value: 'Coordinate operations' },
                    ],
                    permissions: [],
                    children: [],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('agent ops-lead:');
            (0, vitest_1.expect)(result).toContain('  model: "opus"');
            (0, vitest_1.expect)(result).toContain('  prompt: "Coordinate operations"');
        });
        (0, vitest_1.it)('should serialize array properties', () => {
            const doc = {
                kind: 'agent',
                version: 1,
                block: {
                    type: 'agent',
                    name: 'test',
                    properties: [
                        { key: 'skills', value: ['ct-cleo', 'ct-orchestrator'] },
                    ],
                    permissions: [],
                    children: [],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('skills: ["ct-cleo", "ct-orchestrator"]');
        });
        (0, vitest_1.it)('should serialize permissions block', () => {
            const doc = {
                kind: 'agent',
                version: 1,
                block: {
                    type: 'agent',
                    name: 'test',
                    properties: [],
                    permissions: [
                        { domain: 'tasks', values: ['read', 'write'] },
                        { domain: 'session', values: ['read'] },
                    ],
                    children: [],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('  permissions:');
            (0, vitest_1.expect)(result).toContain('    tasks: read, write');
            (0, vitest_1.expect)(result).toContain('    session: read');
        });
        (0, vitest_1.it)('should serialize hook with body lines', () => {
            const doc = {
                kind: 'hook',
                version: 1,
                block: {
                    type: 'on',
                    name: 'SessionStart',
                    properties: [],
                    permissions: [],
                    children: [],
                    bodyLines: ['/checkin @all', 'session "Review sprint"'],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('on SessionStart:');
            (0, vitest_1.expect)(result).toContain('  /checkin @all');
            (0, vitest_1.expect)(result).toContain('  session "Review sprint"');
        });
        (0, vitest_1.it)('should serialize nested children', () => {
            const doc = {
                kind: 'workflow',
                version: 1,
                block: {
                    type: 'workflow',
                    name: 'deploy',
                    properties: [],
                    permissions: [],
                    children: [{
                            type: 'pipeline',
                            name: 'build',
                            properties: [],
                            permissions: [],
                            children: [{
                                    type: 'step',
                                    name: 'test',
                                    properties: [{ key: 'command', value: 'pnpm' }],
                                    permissions: [],
                                    children: [],
                                }],
                        }],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result).toContain('workflow deploy:');
            (0, vitest_1.expect)(result).toContain('  pipeline build:');
            (0, vitest_1.expect)(result).toContain('    step test:');
            (0, vitest_1.expect)(result).toContain('      command: "pnpm"');
        });
        (0, vitest_1.it)('should end with a trailing newline', () => {
            const doc = {
                kind: 'agent',
                version: 1,
                block: {
                    type: 'agent',
                    name: 'test',
                    properties: [],
                    permissions: [],
                    children: [],
                },
            };
            const result = (0, serializer_1.serializeCantDocument)(doc);
            (0, vitest_1.expect)(result.endsWith('\n')).toBe(true);
        });
    });
    (0, vitest_1.describe)('formatValue', () => {
        (0, vitest_1.it)('should quote strings', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)('hello')).toBe('"hello"');
        });
        (0, vitest_1.it)('should not double-quote numeric strings', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)('42')).toBe('42');
        });
        (0, vitest_1.it)('should not double-quote booleans', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)('true')).toBe('true');
            (0, vitest_1.expect)((0, serializer_1.formatValue)('false')).toBe('false');
        });
        (0, vitest_1.it)('should format arrays with quoted elements', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)(['a', 'b'])).toBe('["a", "b"]');
        });
        (0, vitest_1.it)('should format numbers', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)(42)).toBe('42');
        });
        (0, vitest_1.it)('should format booleans', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)(true)).toBe('true');
        });
        (0, vitest_1.it)('should escape quotes in strings', () => {
            (0, vitest_1.expect)((0, serializer_1.formatValue)('say "hello"')).toBe('"say \\"hello\\""');
        });
    });
    (0, vitest_1.describe)('propertiesToIR', () => {
        (0, vitest_1.it)('should map model property', () => {
            const result = (0, serializer_1.propertiesToIR)([{ key: 'model', value: 'opus' }]);
            (0, vitest_1.expect)(result[0]?.key).toBe('model');
            (0, vitest_1.expect)(result[0]?.value).toBe('opus');
        });
        (0, vitest_1.it)('should normalize persistence to persist', () => {
            const result = (0, serializer_1.propertiesToIR)([{ key: 'persistence', value: 'project' }]);
            (0, vitest_1.expect)(result[0]?.key).toBe('persist');
        });
        (0, vitest_1.it)('should convert skills to array', () => {
            const result = (0, serializer_1.propertiesToIR)([
                { key: 'skills', value: 'ct-cleo, ct-orchestrator' },
            ]);
            (0, vitest_1.expect)(result[0]?.value).toEqual(['ct-cleo', 'ct-orchestrator']);
        });
        (0, vitest_1.it)('should pass through unknown keys', () => {
            const result = (0, serializer_1.propertiesToIR)([{ key: 'custom', value: 'val' }]);
            (0, vitest_1.expect)(result[0]?.key).toBe('custom');
        });
    });
});
//# sourceMappingURL=serializer.test.js.map