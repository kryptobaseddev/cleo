import { describe, expect, it } from 'vitest';
import { generateDynamicSkillContent, generateMemoryProtocol, generateRoutingGuide, } from '../dynamic-skill-generator.js';
const cliProvider = {
    providerId: 'claude-code',
    providerName: 'Claude Code',
    supportsMcp: false,
    supportsHooks: true,
    supportsSpawn: true,
    instructionFilePattern: 'CLAUDE.md',
};
const limitedProvider = {
    providerId: 'cursor',
    providerName: 'Cursor',
    supportsMcp: false,
    supportsHooks: false,
    supportsSpawn: false,
    instructionFilePattern: '.cursor/rules/*.mdc',
};
describe('dynamic-skill-generator', () => {
    describe('generateMemoryProtocol', () => {
        it('generates CLI-based memory protocol for all providers', () => {
            const result = generateMemoryProtocol(cliProvider);
            expect(result).toContain('CLI for memory operations');
            expect(result).toContain('cleo memory find');
            expect(result).toContain('cleo memory observe');
        });
        it('generates CLI-based memory protocol for limited provider', () => {
            const result = generateMemoryProtocol(limitedProvider);
            expect(result).toContain('CLI for memory operations');
            expect(result).toContain('cleo memory find');
            expect(result).toContain('cleo memory observe');
        });
    });
    describe('generateRoutingGuide', () => {
        it('generates CLI routing table', () => {
            const result = generateRoutingGuide(cliProvider);
            expect(result).toContain('Preferred Channels');
            expect(result).toContain('Task discovery');
            expect(result).toContain('Brain search');
            expect(result).toContain('CLI commands for all operations');
        });
        it('generates same CLI routing for limited provider', () => {
            const result = generateRoutingGuide(limitedProvider);
            expect(result).toContain('Preferred Channels');
            expect(result).toContain('CLI commands for all operations');
        });
    });
    describe('generateDynamicSkillContent', () => {
        it('includes provider name and ID in header', () => {
            const result = generateDynamicSkillContent(cliProvider);
            expect(result).toContain('Claude Code');
            expect(result).toContain('claude-code');
        });
        it('includes capabilities section', () => {
            const result = generateDynamicSkillContent(cliProvider);
            expect(result).toContain('Channel: CLI (direct)');
            expect(result).toContain('Hooks: Yes');
            expect(result).toContain('Spawn: Yes');
        });
        it('includes instruction file pattern when provided', () => {
            const result = generateDynamicSkillContent(cliProvider);
            expect(result).toContain('CLAUDE.md');
        });
        it('shows correct capabilities for limited provider', () => {
            const result = generateDynamicSkillContent(limitedProvider);
            expect(result).toContain('Channel: CLI (direct)');
            expect(result).toContain('Hooks: No');
            expect(result).toContain('Spawn: No');
        });
        it('includes both memory protocol and routing guide sections', () => {
            const result = generateDynamicSkillContent(cliProvider);
            expect(result).toContain('Memory Protocol');
            expect(result).toContain('Preferred Channels');
        });
    });
});
//# sourceMappingURL=dynamic-skill-generator.test.js.map