"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const diff_1 = require("../../src/migrate/diff");
(0, vitest_1.describe)('diff', () => {
    const sampleResult = {
        inputFile: 'AGENTS.md',
        outputFiles: [
            {
                path: '.cleo/agents/test-agent.cant',
                kind: 'agent',
                content: '---\nkind: agent\nversion: 1\n---\n\nagent test-agent:\n  model: "opus"\n',
            },
        ],
        unconverted: [
            {
                lineStart: 10,
                lineEnd: 15,
                reason: 'Could not classify section for automatic conversion',
                content: '## Overview\nSome documentation.',
            },
        ],
        summary: '1 section(s) converted, 1 section(s) left as TODO, (1 agent)',
    };
    (0, vitest_1.describe)('showDiff', () => {
        (0, vitest_1.it)('should include file header', () => {
            const output = (0, diff_1.showDiff)(sampleResult, false);
            (0, vitest_1.expect)(output).toContain('AGENTS.md');
        });
        (0, vitest_1.it)('should include summary line', () => {
            const output = (0, diff_1.showDiff)(sampleResult, false);
            (0, vitest_1.expect)(output).toContain('converted');
        });
        (0, vitest_1.it)('should show converted files', () => {
            const output = (0, diff_1.showDiff)(sampleResult, false);
            (0, vitest_1.expect)(output).toContain('.cleo/agents/test-agent.cant');
            (0, vitest_1.expect)(output).toContain('agent');
        });
        (0, vitest_1.it)('should show unconverted sections', () => {
            const output = (0, diff_1.showDiff)(sampleResult, false);
            (0, vitest_1.expect)(output).toContain('Lines 10-15');
            (0, vitest_1.expect)(output).toContain('classify');
        });
        (0, vitest_1.it)('should work with color enabled', () => {
            const output = (0, diff_1.showDiff)(sampleResult, true);
            // Should contain ANSI codes
            (0, vitest_1.expect)(output).toContain('\x1b[');
        });
        (0, vitest_1.it)('should work with no color', () => {
            const output = (0, diff_1.showDiff)(sampleResult, false);
            (0, vitest_1.expect)(output).not.toContain('\x1b[');
        });
        (0, vitest_1.it)('should handle result with only converted files', () => {
            const result = {
                inputFile: 'test.md',
                outputFiles: sampleResult.outputFiles,
                unconverted: [],
                summary: '1 converted',
            };
            const output = (0, diff_1.showDiff)(result, false);
            (0, vitest_1.expect)(output).toContain('Converted files');
            (0, vitest_1.expect)(output).not.toContain('Unconverted');
        });
        (0, vitest_1.it)('should handle result with only unconverted sections', () => {
            const result = {
                inputFile: 'test.md',
                outputFiles: [],
                unconverted: sampleResult.unconverted,
                summary: '0 converted, 1 TODO',
            };
            const output = (0, diff_1.showDiff)(result, false);
            (0, vitest_1.expect)(output).not.toContain('Converted files');
            (0, vitest_1.expect)(output).toContain('Unconverted');
        });
    });
    (0, vitest_1.describe)('showSummary', () => {
        (0, vitest_1.it)('should show file name and summary', () => {
            const output = (0, diff_1.showSummary)(sampleResult);
            (0, vitest_1.expect)(output).toContain('AGENTS.md');
            (0, vitest_1.expect)(output).toContain('converted');
        });
        (0, vitest_1.it)('should list files that would be created', () => {
            const output = (0, diff_1.showSummary)(sampleResult);
            (0, vitest_1.expect)(output).toContain('.cleo/agents/test-agent.cant');
        });
        (0, vitest_1.it)('should list unconverted sections', () => {
            const output = (0, diff_1.showSummary)(sampleResult);
            (0, vitest_1.expect)(output).toContain('Lines 10-15');
        });
        (0, vitest_1.it)('should handle empty result', () => {
            const result = {
                inputFile: 'empty.md',
                outputFiles: [],
                unconverted: [],
                summary: '0 converted',
            };
            const output = (0, diff_1.showSummary)(result);
            (0, vitest_1.expect)(output).toContain('empty.md');
            (0, vitest_1.expect)(output).not.toContain('Would create');
        });
    });
});
//# sourceMappingURL=diff.test.js.map