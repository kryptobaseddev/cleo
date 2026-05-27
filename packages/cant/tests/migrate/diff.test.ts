import { describe, it, expect } from 'vitest';
import { showDiff, showSummary } from '../../src/migrate/diff';
import type { MigrationResult } from '../../src/migrate/types';

describe('diff', () => {
  const sampleResult: MigrationResult = {
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

  describe('showDiff', () => {
    it('should include file header', () => {
      const output = showDiff(sampleResult, false);
      expect(output).toContain('AGENTS.md');
    });

    it('should include summary line', () => {
      const output = showDiff(sampleResult, false);
      expect(output).toContain('converted');
    });

    it('should show converted files', () => {
      const output = showDiff(sampleResult, false);
      expect(output).toContain('.cleo/agents/test-agent.cant');
      expect(output).toContain('agent');
    });

    it('should show unconverted sections', () => {
      const output = showDiff(sampleResult, false);
      expect(output).toContain('Lines 10-15');
      expect(output).toContain('classify');
    });

    it('should work with color enabled', () => {
      const output = showDiff(sampleResult, true);
      // Should contain ANSI codes
      expect(output).toContain('\x1b[');
    });

    it('should work with no color', () => {
      const output = showDiff(sampleResult, false);
      expect(output).not.toContain('\x1b[');
    });

    it('should handle result with only converted files', () => {
      const result: MigrationResult = {
        inputFile: 'test.md',
        outputFiles: sampleResult.outputFiles,
        unconverted: [],
        summary: '1 converted',
      };
      const output = showDiff(result, false);
      expect(output).toContain('Converted files');
      expect(output).not.toContain('Unconverted');
    });

    it('should handle result with only unconverted sections', () => {
      const result: MigrationResult = {
        inputFile: 'test.md',
        outputFiles: [],
        unconverted: sampleResult.unconverted,
        summary: '0 converted, 1 TODO',
      };
      const output = showDiff(result, false);
      expect(output).not.toContain('Converted files');
      expect(output).toContain('Unconverted');
    });
  });

  describe('showSummary', () => {
    it('should show file name and summary', () => {
      const output = showSummary(sampleResult);
      expect(output).toContain('AGENTS.md');
      expect(output).toContain('converted');
    });

    it('should list files that would be created', () => {
      const output = showSummary(sampleResult);
      expect(output).toContain('.cleo/agents/test-agent.cant');
    });

    it('should list unconverted sections', () => {
      const output = showSummary(sampleResult);
      expect(output).toContain('Lines 10-15');
    });

    it('should handle empty result', () => {
      const result: MigrationResult = {
        inputFile: 'empty.md',
        outputFiles: [],
        unconverted: [],
        summary: '0 converted',
      };
      const output = showSummary(result);
      expect(output).toContain('empty.md');
      expect(output).not.toContain('Would create');
    });
  });
});
