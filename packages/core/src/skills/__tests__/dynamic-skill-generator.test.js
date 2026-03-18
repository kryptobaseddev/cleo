import { describe, expect, it } from 'vitest';
import { generateDynamicSkillContent, generateMemoryProtocol, generateRoutingGuide, } from '../dynamic-skill-generator.js';
const mcpProvider = {
    providerId: 'claude-code',
    providerName: 'Claude Code',
    supportsMcp: true,
    supportsHooks: true,
    supportsSpawn: true,
    instructionFilePattern: 'CLAUDE.md',
};
const noMcpProvider = {
    providerId: 'cursor',
    providerName: 'Cursor',
    supportsMcp: false,
    supportsHooks: false,
    supportsSpawn: false,
    instructionFilePattern: '.cursor/rules/*.mdc',
};
describe('dynamic-skill-generator', () => {
    describe('generateMemoryProtocol', () => {
        it('generates MCP-based memory protocol for MCP-capable provider', () => {
            const result = generateMemoryProtocol(mcpProvider);
            expect(result).toContain('3-layer retrieval');
            expect(result).toContain('memory find');
            expect(result).toContain('memory timeline');
            expect(result).toContain('memory fetch');
            expect(result).toContain('memory observe');
        });
        it('generates CLI-based memory protocol for non-MCP provider', () => {
            const result = generateMemoryProtocol(noMcpProvider);
            expect(result).toContain('CLI for memory operations');
            expect(result).toContain('cleo memory find');
            expect(result).toContain('cleo memory observe');
        });
    });
    describe('generateRoutingGuide', () => {
        it('generates routing table for MCP provider', () => {
            const result = generateRoutingGuide(mcpProvider);
            expect(result).toContain('Preferred Channels');
            expect(result).toContain('Task discovery');
            expect(result).toContain('Brain search');
            expect(result).toContain('MCP');
        });
        it('generates fallback message for non-MCP provider', () => {
            const result = generateRoutingGuide(noMcpProvider);
            expect(result).toContain('does not support MCP');
            expect(result).toContain('CLI commands');
        });
    });
    describe('generateDynamicSkillContent', () => {
        it('includes provider name and ID in header', () => {
            const result = generateDynamicSkillContent(mcpProvider);
            expect(result).toContain('Claude Code');
            expect(result).toContain('claude-code');
        });
        it('includes capabilities section', () => {
            const result = generateDynamicSkillContent(mcpProvider);
            expect(result).toContain('MCP: Yes');
            expect(result).toContain('Hooks: Yes');
            expect(result).toContain('Spawn: Yes');
        });
        it('includes instruction file pattern when provided', () => {
            const result = generateDynamicSkillContent(mcpProvider);
            expect(result).toContain('CLAUDE.md');
        });
        it('shows correct capabilities for limited provider', () => {
            const result = generateDynamicSkillContent(noMcpProvider);
            expect(result).toContain('MCP: No');
            expect(result).toContain('Hooks: No');
            expect(result).toContain('Spawn: No');
        });
        it('includes both memory protocol and routing guide sections', () => {
            const result = generateDynamicSkillContent(mcpProvider);
            expect(result).toContain('Memory Protocol');
            expect(result).toContain('Preferred Channels');
        });
    });
});
//# sourceMappingURL=dynamic-skill-generator.test.js.map