/**
 * Test CLEO-INJECTION.md v2.4.0 optimized CLI-only template.
 *
 * Validates the trimmed template:
 * 1. Has version 2.4.0 with CLI-only dispatch
 * 2. Contains all essential sections (session start, work loop, discovery, memory, errors)
 * 3. Uses `cleo` prefix exclusively (no `ct` prefix, no MCP syntax)
 * 4. Contains escalation section with skill pointers
 * 5. Is under 100 lines (optimized for token efficiency)
 *
 * @task T5096
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const thisFile = fileURLToPath(import.meta.url);
const corePackageRoot = resolve(dirname(thisFile), '..', '..');
const injectionPath = join(corePackageRoot, 'templates', 'CLEO-INJECTION.md');
const templateExists = existsSync(injectionPath);
describe('CLEO-INJECTION v2.4.0 CLI-only template', () => {
    const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';
    it('template file exists at templates/CLEO-INJECTION.md', () => {
        expect(templateExists).toBe(true);
    });
    describe('Version and identity', () => {
        it('has version 2.4.0', () => {
            expect(content).toContain('Version: 2.4.0');
        });
        it('declares CLI-only dispatch', () => {
            expect(content).toContain('CLI-only dispatch');
            expect(content).toContain('cleo <command>');
        });
    });
    describe('Contains essential sections', () => {
        it('includes Session Start sequence', () => {
            expect(content).toContain('## Session Start');
            expect(content).toContain('cleo session status');
            expect(content).toContain('cleo dash');
            expect(content).toContain('cleo current');
            expect(content).toContain('cleo next');
            expect(content).toContain('cleo show');
        });
        it('includes Work Loop', () => {
            expect(content).toContain('## Work Loop');
            expect(content).toContain('cleo complete');
        });
        it('includes Task Discovery', () => {
            expect(content).toContain('## Task Discovery');
            expect(content).toContain('cleo find');
            expect(content).toContain('cleo list');
        });
        it('includes Session Commands', () => {
            expect(content).toContain('## Session Commands');
            expect(content).toContain('cleo briefing');
        });
        it('includes Memory (BRAIN)', () => {
            expect(content).toContain('## Memory (BRAIN)');
            expect(content).toContain('cleo memory find');
            expect(content).toContain('cleo memory timeline');
            expect(content).toContain('cleo memory fetch');
            expect(content).toContain('cleo observe');
        });
        it('includes Error Handling', () => {
            expect(content).toContain('## Error Handling');
            expect(content).toContain('exit code');
            expect(content).toContain('E_NOT_FOUND');
        });
        it('includes Rules', () => {
            expect(content).toContain('## Rules');
            expect(content).toContain('small');
            expect(content).toContain('medium');
            expect(content).toContain('large');
        });
    });
    describe('CLI-only — no legacy MCP or ct syntax', () => {
        it('does not use ct prefix for commands', () => {
            expect(content).not.toMatch(/`ct /);
        });
        it('does not contain MCP query/mutate syntax', () => {
            expect(content).not.toContain('query({');
            expect(content).not.toContain('mutate({');
            expect(content).not.toContain('orchestrate.bootstrap');
        });
        it('does not contain TIER markers', () => {
            expect(content).not.toMatch(/<!-- TIER:\w+ -->/);
        });
        it('does not contain removed standard/orchestrator content', () => {
            expect(content).not.toContain('## RCASD-IVTR+C');
            expect(content).not.toContain('ORC-001');
            expect(content).not.toContain('## Spawn Pipeline');
        });
    });
    describe('Contains escalation section', () => {
        it('has Escalation section', () => {
            expect(content).toContain('## Escalation');
        });
        it('points to ct-cleo skill', () => {
            expect(content).toContain('ct-cleo');
        });
        it('points to ct-orchestrator skill', () => {
            expect(content).toContain('ct-orchestrator');
        });
    });
    describe('Template size', () => {
        it('is under 100 lines (token-optimized)', () => {
            const lines = content.split('\n').length;
            expect(lines).toBeLessThanOrEqual(100);
        });
        it('is at least 50 lines (not accidentally empty)', () => {
            const lines = content.split('\n').length;
            expect(lines).toBeGreaterThan(50);
        });
    });
});
//# sourceMappingURL=injection-mvi-tiers.test.js.map