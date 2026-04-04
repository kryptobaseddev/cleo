import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { resolveCantImports, cantToMarkdown } from '../../src/core/instructions/cant-resolver.js';
// Mock fs module
vi.mock('node:fs', async () => {
    const actual = await vi.importActual('node:fs');
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
describe('cant-resolver', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });
    describe('resolveCantImports', () => {
        it('should pass through non-import lines unchanged', () => {
            const content = '@AGENTS.md\nSome content\n# Heading';
            const result = resolveCantImports(content, '/project');
            expect(result.resolvedContent).toBe(content);
            expect(result.importedFiles).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
        });
        it('should resolve a .cant import', () => {
            const cantContent = `---
kind: agent
version: 1
---

agent test-agent:
  model: "opus"
  prompt: "test"`;
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(cantContent);
            const content = '@import .cleo/agents/test-agent.cant';
            const result = resolveCantImports(content, '/project');
            expect(result.importedFiles).toHaveLength(1);
            expect(result.errors).toHaveLength(0);
            expect(result.resolvedContent).toContain('Agent: test-agent');
        });
        it('should handle quoted import paths', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('---\nkind: agent\nversion: 1\n---\nagent x:\n  model: "opus"');
            const content = '@import ".cleo/agents/x.cant"';
            const result = resolveCantImports(content, '/project');
            expect(result.importedFiles).toHaveLength(1);
        });
        it('should report error for missing files', () => {
            mockExistsSync.mockReturnValue(false);
            const content = '@import .cleo/agents/missing.cant';
            const result = resolveCantImports(content, '/project');
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain('not found');
            expect(result.resolvedContent).toContain('CANT import error');
        });
        it('should prevent path traversal outside project root', () => {
            const content = '@import ../../etc/passwd.cant';
            const result = resolveCantImports(content, '/project');
            expect(result.errors).toHaveLength(1);
            expect(result.resolvedContent).toContain('CANT import error');
        });
        it('should handle parse errors gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => { throw new Error('Read error'); });
            const content = '@import .cleo/agents/bad.cant';
            const result = resolveCantImports(content, '/project');
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain('Failed to parse');
        });
        it('should handle multiple imports', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('---\nkind: agent\nversion: 1\n---\nagent a:\n  model: "opus"');
            const content = '@import .cleo/agents/a.cant\n@import .cleo/agents/b.cant';
            const result = resolveCantImports(content, '/project');
            expect(result.importedFiles).toHaveLength(2);
        });
        it('should preserve non-import lines between imports', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('---\nkind: agent\nversion: 1\n---\nagent x:\n  model: "opus"');
            const content = '@AGENTS.md\n@import .cleo/agents/x.cant\nSome text';
            const result = resolveCantImports(content, '/project');
            const lines = result.resolvedContent.split('\n');
            expect(lines[0]).toBe('@AGENTS.md');
            expect(lines[lines.length - 1]).toBe('Some text');
        });
        it('should ignore non-.cant import lines', () => {
            const content = '@import ./file.md';
            const result = resolveCantImports(content, '/project');
            expect(result.resolvedContent).toBe(content);
            expect(result.importedFiles).toHaveLength(0);
        });
    });
    describe('cantToMarkdown', () => {
        it('should convert agent kind to markdown', () => {
            const cant = `---
kind: agent
version: 1
---

agent ops-lead:
  model: "opus"
  prompt: "Coordinate operations"
  skills: ["ct-cleo", "ct-orchestrator"]`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('## Agent: ops-lead');
            expect(md).toContain('**Model**: opus');
            expect(md).toContain('**Prompt**: Coordinate operations');
            expect(md).toContain('**Skills**: ct-cleo, ct-orchestrator');
        });
        it('should convert agent with permissions', () => {
            const cant = `---
kind: agent
version: 1
---

agent test:
  model: "opus"
  permissions:
    tasks: read, write
    session: read`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('**Permissions**');
            expect(md).toContain('Tasks: read, write');
        });
        it('should convert skill kind to markdown', () => {
            const cant = `---
kind: skill
version: 1
---

skill ct-deploy:
  description: "Deployment automation"
  tier: "core"`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('## Skill: ct-deploy');
            expect(md).toContain('**Description**: Deployment automation');
        });
        it('should convert hook kind to markdown', () => {
            const cant = `---
kind: hook
version: 1
---

on SessionStart:
  /checkin @all`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('### On Session Start');
            expect(md).toContain('`/checkin @all`');
        });
        it('should convert workflow kind to cant code block', () => {
            const cant = `---
kind: workflow
version: 1
---

workflow deploy:
  pipeline build:
    step test:
      command: "pnpm"`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('## Workflow: deploy');
            expect(md).toContain('```cant');
        });
        it('should handle unknown kind gracefully', () => {
            const cant = `---
kind: custom
version: 1
---

something here`;
            const md = cantToMarkdown(cant);
            expect(md).toContain('unknown kind');
        });
        it('should handle content without frontmatter', () => {
            const md = cantToMarkdown('just some text');
            expect(md).toContain('unknown kind');
        });
    });
});
//# sourceMappingURL=cant-resolver.test.js.map