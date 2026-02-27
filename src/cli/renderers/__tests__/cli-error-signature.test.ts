/**
 * Regression test: cliError signature compatibility.
 *
 * Guards against T4808 regression where the cliError function signature
 * in src/cli/renderers/index.ts diverged from the call sites in:
 *   - src/dispatch/adapters/cli.ts (dispatchFromCli error path)
 *   - src/cli/commands/add.ts (add command error path)
 *
 * If the signature changes incompatibly, these tests will fail at
 * compile-time (via tsc --noEmit) or at runtime (via vitest).
 *
 * @task T4808
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cliError, type CliErrorDetails } from '../index.js';

// Mock format context so cliError can run without side effects
vi.mock('../../format-context.js', () => ({
  getFormatContext: vi.fn(() => ({ format: 'json', quiet: false })),
}));

describe('cliError signature compatibility (T4808 regression)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // -----------------------------------------------------------------------
  // 1. The adapter call pattern: cliError(message, exitCode, { name, details, fix })
  //    See: src/dispatch/adapters/cli.ts:130-138
  // -----------------------------------------------------------------------
  it('accepts the dispatchFromCli call pattern: (string, number, CliErrorDetails)', () => {
    // This mirrors the exact call in cli.ts adapter
    expect(() => {
      cliError(
        'Task not found',
        4,
        {
          name: 'E_NOT_FOUND',
          details: { taskId: 'T999' },
          fix: 'Use ct find to verify task exists',
        },
      );
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 2. The add.ts call pattern: cliError(message, exitCode, { name, details, fix })
  //    See: src/cli/commands/add.ts:61-65
  // -----------------------------------------------------------------------
  it('accepts the add command call pattern: (string, number, { name?: string })', () => {
    // add.ts passes response.error?.code which can be undefined
    expect(() => {
      cliError(
        'Validation error',
        6,
        {
          name: undefined,
          details: undefined,
          fix: undefined,
        },
      );
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 3. Simple call pattern used by list.ts, find.ts, etc.
  //    cliError(message, exitCode) with no details
  // -----------------------------------------------------------------------
  it('accepts the simple call pattern: (string, number)', () => {
    expect(() => {
      cliError('Unknown error', 1);
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 4. Message-only call pattern
  // -----------------------------------------------------------------------
  it('accepts message-only call: (string)', () => {
    expect(() => {
      cliError('Something failed');
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 5. CliErrorDetails type contract
  //    All three fields (name, details, fix) must be optional
  // -----------------------------------------------------------------------
  it('CliErrorDetails allows all fields to be optional', () => {
    const empty: CliErrorDetails = {};
    expect(empty).toBeDefined();

    const partial: CliErrorDetails = { name: 'E_TEST' };
    expect(partial.name).toBe('E_TEST');

    const full: CliErrorDetails = {
      name: 'E_VALIDATION',
      details: { field: 'title', reason: 'too short' },
      fix: 'Provide a longer title',
    };
    expect(full.name).toBe('E_VALIDATION');
    expect(full.details).toBeDefined();
    expect(full.fix).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 6. Second arg accepts both number and string codes
  //    (adapters pass numeric exit codes, but the type allows string too)
  // -----------------------------------------------------------------------
  it('accepts string error code as second argument', () => {
    expect(() => {
      cliError('Config error', 'E_CONFIG_ERROR');
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 7. Verify output includes message and code
  // -----------------------------------------------------------------------
  it('outputs message and code in JSON format', () => {
    const spy = vi.spyOn(console, 'error');
    spy.mockClear();
    cliError('Not found', 4);

    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(output.success).toBe(false);
    expect(output.error.message).toBe('Not found');
    expect(output.error.code).toBe(4);
  });
});
