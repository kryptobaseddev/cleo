import { describe, it, expect } from 'vitest';
import { migrateMarkdown } from '../../src/migrate/converter';
import { cantToMarkdown } from '../../../caamp/src/core/instructions/cant-resolver';

/**
 * Roundtrip tests: Markdown -> CANT -> Markdown
 *
 * Validates that converting markdown to CANT and back preserves
 * the essential information (agent name, properties, permissions).
 * The output markdown format may differ from input, but the
 * semantic content must be retained.
 */
describe('roundtrip: markdown -> cant -> markdown', () => {
  it('should preserve agent name through roundtrip', () => {
    const md = `## Code Review Agent

- **Model**: Opus
- **Prompt**: Review code for correctness`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    expect(result.outputFiles).toHaveLength(1);

    const cantContent = result.outputFiles[0]?.content ?? '';
    const backToMd = cantToMarkdown(cantContent);

    expect(backToMd).toContain('code-review');
  });

  it('should preserve model property through roundtrip', () => {
    const md = `## Test Agent

- **Model**: Opus
- **Prompt**: Test agent`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    const cantContent = result.outputFiles[0]?.content ?? '';
    const backToMd = cantToMarkdown(cantContent);

    expect(backToMd.toLowerCase()).toContain('opus');
  });

  it('should preserve prompt through roundtrip', () => {
    const md = `## Deploy Agent

- **Model**: Sonnet
- **Prompt**: Handle deployments and releases`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    const cantContent = result.outputFiles[0]?.content ?? '';
    const backToMd = cantToMarkdown(cantContent);

    expect(backToMd).toContain('Handle deployments and releases');
  });

  it('should preserve skills list through roundtrip', () => {
    const md = `## Ops Agent

- **Model**: Opus
- **Prompt**: Operations
- **Skills**: ct-cleo, ct-orchestrator`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    const cantContent = result.outputFiles[0]?.content ?? '';
    const backToMd = cantToMarkdown(cantContent);

    expect(backToMd).toContain('ct-cleo');
    expect(backToMd).toContain('ct-orchestrator');
  });

  it('should produce valid CANT frontmatter', () => {
    const md = `## Simple Agent

- **Model**: Opus
- **Prompt**: Test`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    const cantContent = result.outputFiles[0]?.content ?? '';

    // Validate frontmatter structure
    expect(cantContent).toMatch(/^---\nkind: agent\nversion: 1\n---/);
  });

  it('should produce .cant content parseable by cantToMarkdown', () => {
    const md = `## Security Scanner Agent

- **Model**: Opus
- **Prompt**: Scan for vulnerabilities
- **Skills**: ct-cleo`;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    const cantContent = result.outputFiles[0]?.content ?? '';

    // Should not throw
    const backToMd = cantToMarkdown(cantContent);
    expect(backToMd).toBeTruthy();
    expect(backToMd).toContain('Agent');
  });

  it('should handle workflow roundtrip', () => {
    const md = `## Build Pipeline

1. Run \`pnpm run build\`
2. Run \`pnpm run test\``;

    const result = migrateMarkdown(md, 'test.md', { write: false, verbose: false });
    expect(result.outputFiles).toHaveLength(1);

    const cantContent = result.outputFiles[0]?.content ?? '';
    const backToMd = cantToMarkdown(cantContent);

    // Workflow body is preserved as cant code block
    expect(backToMd).toContain('Workflow');
  });
});
