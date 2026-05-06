/**
 * Canonical CLI envelope shape tests (ADR-039).
 *
 * Verifies that `formatSuccess` and `formatError` always produce envelopes
 * conforming to the canonical CliEnvelope shape regardless of payload. CLI
 * output-format flag parsing lives in `@cleocode/lafs` (resolveOutputFormat);
 * the dead CORE duplicate at `core/src/ui/flags.ts` was deleted.
 */

import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { CleoError } from '../errors.js';
import { formatSuccess as _formatSuccess, type FormatOptions, formatError } from '../output.js';

/**
 * Wrapper that forces mvi='full' so envelope tests verify the full LAFS
 * shape rather than the agent-optimized projection.
 */
function formatSuccess<T>(
  data: T,
  message?: string,
  operationOrOpts?: string | FormatOptions,
): string {
  const opts: FormatOptions =
    typeof operationOrOpts === 'string'
      ? { operation: operationOrOpts, mvi: 'full' }
      : { mvi: 'full', ...(operationOrOpts ?? {}) };
  return _formatSuccess(data, message, opts);
}

describe('Canonical CLI envelopes (ADR-039)', () => {
  it('formatSuccess produces canonical envelope for show operation', () => {
    const json = formatSuccess(
      {
        task: { id: 'T4663', title: 'Wave 8: Full System Integration', status: 'active' },
      },
      undefined,
      'tasks.show',
    );
    const parsed = JSON.parse(json);

    expect(parsed.success).toBe(true);
    // ADR-039: canonical shape drops $schema and _meta; payload lives in data.
    expect(parsed.$schema).toBeUndefined();
    expect(parsed._meta).toBeUndefined();
    expect(parsed.meta).toBeDefined();
    expect(parsed.data.task.id).toBe('T4663');
  });

  it('formatSuccess produces canonical envelope for list operation', () => {
    const json = formatSuccess(
      {
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'pending' },
          { id: 'T002', title: 'Task 2', status: 'done' },
        ],
        total: 2,
      },
      undefined,
      'tasks.list',
    );
    const parsed = JSON.parse(json);

    expect(parsed.success).toBe(true);
    expect(parsed.data.tasks).toHaveLength(2);
    expect(parsed.data.total).toBe(2);
  });

  it('formatSuccess produces canonical envelope for dash operation', () => {
    const json = formatSuccess(
      {
        project: { name: 'cleo' },
        stats: { total: 50, pending: 10, active: 5, done: 35 },
      },
      undefined,
      'system.dash',
    );
    const parsed = JSON.parse(json);

    expect(parsed.success).toBe(true);
    expect(parsed.data.project.name).toBe('cleo');
    expect(parsed.data.stats.total).toBe(50);
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
