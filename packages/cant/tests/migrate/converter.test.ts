import { describe, it, expect } from 'vitest';
import { migrateMarkdown } from '../../src/migrate/converter';
import type { MigrationOptions } from '../../src/migrate/types';

const defaultOpts: MigrationOptions = {
  write: false,
  verbose: false,
};

describe('converter', () => {
  describe('migrateMarkdown', () => {
    it('should convert a simple agent section', () => {
      const md = `## Code Review Agent

- **Model**: Opus
- **Persistence**: Project-level
- **Prompt**: You review code for correctness and security.
- **Skills**: ct-cleo, ct-orchestrator`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0]?.kind).toBe('agent');
      expect(result.outputFiles[0]?.content).toContain('kind: agent');
      expect(result.outputFiles[0]?.content).toContain('agent code-review:');
      expect(result.outputFiles[0]?.content).toContain('model: "Opus"');
    });

    it('should convert agent with permissions', () => {
      const md = `## Ops Agent

- **Model**: Opus
- **Prompt**: Coordinate ops

**Permissions**:
- Tasks: read, write
- Session: read`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(1);
      const content = result.outputFiles[0]?.content ?? '';
      expect(content).toContain('permissions:');
      expect(content).toContain('tasks: read, write');
    });

    it('should convert a hook section with known event', () => {
      const md = `### On Session Start

1. Check in with the team
2. Review the current sprint state`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0]?.kind).toBe('hook');
      expect(result.outputFiles[0]?.content).toContain('kind: hook');
      expect(result.outputFiles[0]?.content).toContain('on SessionStart:');
    });

    it('should flag unknown hook events as unconverted', () => {
      const md = `### On Custom Event

Do something custom.`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      // "On Custom Event" matches hook pattern but unknown event
      expect(result.unconverted.length).toBeGreaterThanOrEqual(1);
    });

    it('should convert a workflow section with pipeline steps', () => {
      const md = `## Deploy Procedure

1. Run \`pnpm run build\`
2. Run \`pnpm run test\``;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(1);
      expect(result.outputFiles[0]?.kind).toBe('workflow');
      expect(result.outputFiles[0]?.content).toContain('kind: workflow');
      expect(result.outputFiles[0]?.content).toContain('workflow deploy-procedure:');
    });

    it('should flag workflow with conditional steps as unconverted', () => {
      const md = `## Deploy Procedure

1. Run \`pnpm run test\`
2. If tests pass, ask for approval
3. Run \`pnpm run deploy\``;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      // The conditional "If tests pass" should cause a fallback
      expect(result.unconverted.length).toBeGreaterThanOrEqual(1);
    });

    it('should flag unknown sections as unconverted', () => {
      const md = `## Architecture Overview

This describes the architecture of the system.`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(0);
      expect(result.unconverted).toHaveLength(1);
      expect(result.unconverted[0]?.reason).toContain('classify');
    });

    it('should handle multiple sections', () => {
      const md = `## Code Review Agent

- **Model**: Opus
- **Prompt**: Review code

## Architecture Overview

Some docs.

### On Session Start

1. Check in`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(2); // agent + hook
      expect(result.unconverted).toHaveLength(1); // architecture
    });

    it('should respect custom outputDir', () => {
      const md = `## Test Agent\n- **Model**: Opus\n- **Prompt**: test`;
      const result = migrateMarkdown(md, 'AGENTS.md', {
        ...defaultOpts,
        outputDir: '.cleo/custom',
      });
      expect(result.outputFiles[0]?.path).toContain('.cleo/custom/');
    });

    it('should produce a summary', () => {
      const md = `## Agent Test\n- **Model**: Opus\n- **Prompt**: test\n\n## Overview\nDocs here.`;
      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.summary).toContain('converted');
      expect(result.summary).toContain('TODO');
    });

    it('should handle empty content', () => {
      const result = migrateMarkdown('', 'AGENTS.md', defaultOpts);
      expect(result.outputFiles).toHaveLength(0);
      expect(result.unconverted).toHaveLength(0);
    });

    it('should flag standalone permissions section', () => {
      const md = `## Permissions

- Tasks: read, write
- Session: read`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.unconverted).toHaveLength(1);
      expect(result.unconverted[0]?.reason).toContain('parent agent');
    });

    it('should flag generic skills list as unconverted', () => {
      const md = `## Skills

- ct-cleo
- ct-orchestrator`;

      const result = migrateMarkdown(md, 'AGENTS.md', defaultOpts);
      expect(result.unconverted).toHaveLength(1);
      expect(result.unconverted[0]?.reason).toContain('Generic skills list');
    });

    it('should set inputFile in result', () => {
      const result = migrateMarkdown('## Test Agent\n- **Model**: Opus\n- **Prompt**: test', '/path/to/AGENTS.md', defaultOpts);
      expect(result.inputFile).toBe('/path/to/AGENTS.md');
    });
  });
});
