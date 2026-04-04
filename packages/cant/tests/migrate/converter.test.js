"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const converter_1 = require("../../src/migrate/converter");
const defaultOpts = {
    write: false,
    verbose: false,
};
(0, vitest_1.describe)('converter', () => {
    (0, vitest_1.describe)('migrateMarkdown', () => {
        (0, vitest_1.it)('should convert a simple agent section', () => {
            const md = `## Code Review Agent

- **Model**: Opus
- **Persistence**: Project-level
- **Prompt**: You review code for correctness and security.
- **Skills**: ct-cleo, ct-orchestrator`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
            (0, vitest_1.expect)(result.outputFiles[0]?.kind).toBe('agent');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('kind: agent');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('agent code-review:');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('model: "Opus"');
        });
        (0, vitest_1.it)('should convert agent with permissions', () => {
            const md = `## Ops Agent

- **Model**: Opus
- **Prompt**: Coordinate ops

**Permissions**:
- Tasks: read, write
- Session: read`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
            const content = result.outputFiles[0]?.content ?? '';
            (0, vitest_1.expect)(content).toContain('permissions:');
            (0, vitest_1.expect)(content).toContain('tasks: read, write');
        });
        (0, vitest_1.it)('should convert a hook section with known event', () => {
            const md = `### On Session Start

1. Check in with the team
2. Review the current sprint state`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
            (0, vitest_1.expect)(result.outputFiles[0]?.kind).toBe('hook');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('kind: hook');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('on SessionStart:');
        });
        (0, vitest_1.it)('should flag unknown hook events as unconverted', () => {
            const md = `### On Custom Event

Do something custom.`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            // "On Custom Event" matches hook pattern but unknown event
            (0, vitest_1.expect)(result.unconverted.length).toBeGreaterThanOrEqual(1);
        });
        (0, vitest_1.it)('should convert a workflow section with pipeline steps', () => {
            const md = `## Deploy Procedure

1. Run \`pnpm run build\`
2. Run \`pnpm run test\``;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(1);
            (0, vitest_1.expect)(result.outputFiles[0]?.kind).toBe('workflow');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('kind: workflow');
            (0, vitest_1.expect)(result.outputFiles[0]?.content).toContain('workflow deploy-procedure:');
        });
        (0, vitest_1.it)('should flag workflow with conditional steps as unconverted', () => {
            const md = `## Deploy Procedure

1. Run \`pnpm run test\`
2. If tests pass, ask for approval
3. Run \`pnpm run deploy\``;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            // The conditional "If tests pass" should cause a fallback
            (0, vitest_1.expect)(result.unconverted.length).toBeGreaterThanOrEqual(1);
        });
        (0, vitest_1.it)('should flag unknown sections as unconverted', () => {
            const md = `## Architecture Overview

This describes the architecture of the system.`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(0);
            (0, vitest_1.expect)(result.unconverted).toHaveLength(1);
            (0, vitest_1.expect)(result.unconverted[0]?.reason).toContain('classify');
        });
        (0, vitest_1.it)('should handle multiple sections', () => {
            const md = `## Code Review Agent

- **Model**: Opus
- **Prompt**: Review code

## Architecture Overview

Some docs.

### On Session Start

1. Check in`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(2); // agent + hook
            (0, vitest_1.expect)(result.unconverted).toHaveLength(1); // architecture
        });
        (0, vitest_1.it)('should respect custom outputDir', () => {
            const md = `## Test Agent\n- **Model**: Opus\n- **Prompt**: test`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', {
                ...defaultOpts,
                outputDir: '.cleo/custom',
            });
            (0, vitest_1.expect)(result.outputFiles[0]?.path).toContain('.cleo/custom/');
        });
        (0, vitest_1.it)('should produce a summary', () => {
            const md = `## Agent Test\n- **Model**: Opus\n- **Prompt**: test\n\n## Overview\nDocs here.`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.summary).toContain('converted');
            (0, vitest_1.expect)(result.summary).toContain('TODO');
        });
        (0, vitest_1.it)('should handle empty content', () => {
            const result = (0, converter_1.migrateMarkdown)('', 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.outputFiles).toHaveLength(0);
            (0, vitest_1.expect)(result.unconverted).toHaveLength(0);
        });
        (0, vitest_1.it)('should flag standalone permissions section', () => {
            const md = `## Permissions

- Tasks: read, write
- Session: read`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.unconverted).toHaveLength(1);
            (0, vitest_1.expect)(result.unconverted[0]?.reason).toContain('parent agent');
        });
        (0, vitest_1.it)('should flag generic skills list as unconverted', () => {
            const md = `## Skills

- ct-cleo
- ct-orchestrator`;
            const result = (0, converter_1.migrateMarkdown)(md, 'AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.unconverted).toHaveLength(1);
            (0, vitest_1.expect)(result.unconverted[0]?.reason).toContain('Generic skills list');
        });
        (0, vitest_1.it)('should set inputFile in result', () => {
            const result = (0, converter_1.migrateMarkdown)('## Test Agent\n- **Model**: Opus\n- **Prompt**: test', '/path/to/AGENTS.md', defaultOpts);
            (0, vitest_1.expect)(result.inputFile).toBe('/path/to/AGENTS.md');
        });
    });
});
//# sourceMappingURL=converter.test.js.map