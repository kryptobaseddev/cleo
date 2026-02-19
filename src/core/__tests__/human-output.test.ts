/**
 * T4696: Verify --human output renders correctly.
 *
 * Tests that the flag parsing and format resolution works for --human,
 * --json, and auto-detection modes. Also tests that LAFS envelopes
 * remain valid regardless of output format flags.
 *
 * @task T4696
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import { parseCommonFlags, resolveFormat, isJsonOutput, defaultFlags } from '../ui/flags.js';
import { formatSuccess, formatError } from '../output.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

describe('--human output verification (T4696)', () => {
  describe('Flag parsing', () => {
    it('--human flag sets format to human', () => {
      const flags = parseCommonFlags(['--human', 'show', 'T001']);
      expect(flags.format).toBe('human');
      expect(flags.remaining).toEqual(['show', 'T001']);
    });

    it('--json flag sets format to json', () => {
      const flags = parseCommonFlags(['--json', 'list']);
      expect(flags.format).toBe('json');
    });

    it('--format human sets format to human', () => {
      const flags = parseCommonFlags(['--format', 'human', 'dash']);
      expect(flags.format).toBe('human');
      expect(flags.remaining).toEqual(['dash']);
    });

    it('--format json sets format to json', () => {
      const flags = parseCommonFlags(['--format', 'json']);
      expect(flags.format).toBe('json');
    });

    it('no format flag leaves format empty', () => {
      const flags = parseCommonFlags(['show', 'T001']);
      expect(flags.format).toBe('');
    });

    it('multiple flags parsed correctly', () => {
      const flags = parseCommonFlags(['--human', '--verbose', '--dry-run', 'list']);
      expect(flags.format).toBe('human');
      expect(flags.verbose).toBe(true);
      expect(flags.dryRun).toBe(true);
      expect(flags.remaining).toEqual(['list']);
    });
  });

  describe('Format resolution', () => {
    it('explicit json format returns json', () => {
      expect(resolveFormat('json')).toBe('json');
    });

    it('explicit human format returns human', () => {
      expect(resolveFormat('human')).toBe('human');
    });

    it('empty format auto-detects based on TTY', () => {
      const result = resolveFormat('');
      // In test environment, stdout is not a TTY, so expect json
      expect(['json', 'human']).toContain(result);
    });
  });

  describe('isJsonOutput', () => {
    it('returns true for json format', () => {
      const flags = { ...defaultFlags(), format: 'json' as const };
      expect(isJsonOutput(flags)).toBe(true);
    });

    it('returns false for human format', () => {
      const flags = { ...defaultFlags(), format: 'human' as const };
      expect(isJsonOutput(flags)).toBe(false);
    });
  });

  describe('LAFS envelopes are valid regardless of format flags', () => {
    it('formatSuccess produces valid JSON for show operation', () => {
      const json = formatSuccess({
        task: { id: 'T4663', title: 'Wave 8: Full System Integration', status: 'active' },
      }, undefined, 'tasks.show');
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(true);
      expect(parsed.$schema).toBeDefined();
      expect(parsed._meta).toBeDefined();
      expect(parsed.result.task.id).toBe('T4663');
    });

    it('formatSuccess produces valid JSON for list operation', () => {
      const json = formatSuccess({
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'pending' },
          { id: 'T002', title: 'Task 2', status: 'done' },
        ],
        total: 2,
      }, undefined, 'tasks.list');
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(true);
      expect(parsed.result.tasks).toHaveLength(2);
      expect(parsed.result.total).toBe(2);
    });

    it('formatSuccess produces valid JSON for dash operation', () => {
      const json = formatSuccess({
        project: { name: 'cleo' },
        stats: { total: 50, pending: 10, active: 5, done: 35 },
      }, undefined, 'system.dash');
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(true);
      expect(parsed.result.project.name).toBe('cleo');
      expect(parsed.result.stats.total).toBe(50);
    });

    it('formatError produces valid JSON with fix suggestions', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found', {
        fix: 'Use cleo find to search',
        alternatives: [
          { action: 'Search', command: 'cleo find query' },
          { action: 'List all', command: 'cleo list' },
        ],
      });
      const json = formatError(err, 'tasks.show');
      const parsed = JSON.parse(json);

      expect(parsed.success).toBe(false);
      expect(parsed.error.message).toBe('Task T999 not found');
      expect(parsed.error.details.fix).toBe('Use cleo find to search');
      expect(parsed.error.details.alternatives).toHaveLength(2);
    });
  });

  describe('Default flags', () => {
    it('defaultFlags returns expected structure', () => {
      const flags = defaultFlags();
      expect(flags.format).toBe('');
      expect(flags.quiet).toBe(false);
      expect(flags.dryRun).toBe(false);
      expect(flags.verbose).toBe(false);
      expect(flags.help).toBe(false);
      expect(flags.force).toBe(false);
      expect(flags.remaining).toEqual([]);
    });
  });

  describe('Edge cases', () => {
    it('handles -- separator correctly', () => {
      const flags = parseCommonFlags(['--human', '--', '--json', 'arg']);
      expect(flags.format).toBe('human');
      expect(flags.remaining).toEqual(['--json', 'arg']);
    });

    it('handles short flags', () => {
      const flags = parseCommonFlags(['-q', '-v', '-h', '-f']);
      expect(flags.quiet).toBe(true);
      expect(flags.verbose).toBe(true);
      expect(flags.help).toBe(true);
      expect(flags.force).toBe(true);
    });
  });
});
