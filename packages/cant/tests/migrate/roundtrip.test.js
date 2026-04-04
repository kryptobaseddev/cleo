"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const converter_1 = require("../../src/migrate/converter");
const cant_resolver_1 = require("../../../caamp/src/core/instructions/cant-resolver");
/**
 * Roundtrip tests: Markdown -> CANT -> Markdown
 *
 * Validates that converting markdown to CANT and back preserves
 * the essential information (agent name, properties, permissions).
 * The output markdown format may differ from input, but the
 * semantic content must be retained.
 */
(0, vitest_1.describe)('roundtrip: markdown -> cant -> markdown', () => {
    (0, vitest_1.it)('should preserve agent name through roundtrip', () => {
        const md = `## Code Review Agent

- **Model**: Opus
- **Prompt**: Review code for correctness`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
        const cantContent = result.outputFiles[0]?.content ?? '';
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        (0, vitest_1.expect)(backToMd).toContain('code-review');
    });
    (0, vitest_1.it)('should preserve model property through roundtrip', () => {
        const md = `## Test Agent

- **Model**: Opus
- **Prompt**: Test agent`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        const cantContent = result.outputFiles[0]?.content ?? '';
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        (0, vitest_1.expect)(backToMd.toLowerCase()).toContain('opus');
    });
    (0, vitest_1.it)('should preserve prompt through roundtrip', () => {
        const md = `## Deploy Agent

- **Model**: Sonnet
- **Prompt**: Handle deployments and releases`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        const cantContent = result.outputFiles[0]?.content ?? '';
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        (0, vitest_1.expect)(backToMd).toContain('Handle deployments and releases');
    });
    (0, vitest_1.it)('should preserve skills list through roundtrip', () => {
        const md = `## Ops Agent

- **Model**: Opus
- **Prompt**: Operations
- **Skills**: ct-cleo, ct-orchestrator`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        const cantContent = result.outputFiles[0]?.content ?? '';
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        (0, vitest_1.expect)(backToMd).toContain('ct-cleo');
        (0, vitest_1.expect)(backToMd).toContain('ct-orchestrator');
    });
    (0, vitest_1.it)('should produce valid CANT frontmatter', () => {
        const md = `## Simple Agent

- **Model**: Opus
- **Prompt**: Test`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        const cantContent = result.outputFiles[0]?.content ?? '';
        // Validate frontmatter structure
        (0, vitest_1.expect)(cantContent).toMatch(/^---\nkind: agent\nversion: 1\n---/);
    });
    (0, vitest_1.it)('should produce .cant content parseable by cantToMarkdown', () => {
        const md = `## Security Scanner Agent

- **Model**: Opus
- **Prompt**: Scan for vulnerabilities
- **Skills**: ct-cleo`;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        const cantContent = result.outputFiles[0]?.content ?? '';
        // Should not throw
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        (0, vitest_1.expect)(backToMd).toBeTruthy();
        (0, vitest_1.expect)(backToMd).toContain('Agent');
    });
    (0, vitest_1.it)('should handle workflow roundtrip', () => {
        const md = `## Build Pipeline

1. Run \`pnpm run build\`
2. Run \`pnpm run test\``;
        const result = (0, converter_1.migrateMarkdown)(md, 'test.md', { write: false, verbose: false });
        (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
        const cantContent = result.outputFiles[0]?.content ?? '';
        const backToMd = (0, cant_resolver_1.cantToMarkdown)(cantContent);
        // Workflow body is preserved as cant code block
        (0, vitest_1.expect)(backToMd).toContain('Workflow');
    });
});
//# sourceMappingURL=roundtrip.test.js.map