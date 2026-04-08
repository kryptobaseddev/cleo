/**
 * Regression test: cliError signature compatibility.
 *
 * Guards against T4808 regression where the cliError function signature
 * in src/cli/renderers/index.ts diverged from the call sites in:
 *   - src/dispatch/adapters/cli.ts (dispatchFromCli error path)
 *   - src/cli/commands/add.ts (add command error path)
 *
 * Also covers T336 regression: cliError was discarding its third
 * CliErrorDetails argument (_details unused prefix) and stripping
 * fix/alternatives/details/codeName from every error envelope.
 *
 * @task T4808
 * @task T336
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFormatContext } from '../../format-context.js';
import { type CliErrorDetails, cliError } from '../index.js';

// Mock format context so cliError can run without side effects
vi.mock('../../format-context.js', () => ({
  getFormatContext: vi.fn(() => ({ format: 'json', quiet: false })),
}));

// Mock @cleocode/lafs and @cleocode/core to prevent the a2a/bridge.ts import
// chain from trying to load @a2a-js/sdk (not installed in this worktree).
// These modules are not exercised by cliError tests — cliError only calls
// getFormatContext() and console.log/error.
vi.mock('@cleocode/lafs', () => ({
  applyFieldFilter: vi.fn(),
  extractFieldFromResult: vi.fn(),
}));
vi.mock('@cleocode/core', () => ({
  formatSuccess: vi.fn(() => '{}'),
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
      cliError('Task not found', 4, {
        name: 'E_NOT_FOUND',
        details: { taskId: 'T999' },
        fix: 'Use ct find to verify task exists',
      });
    }).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 2. The add.ts call pattern: cliError(message, exitCode, { name, details, fix })
  //    See: src/cli/commands/add.ts:61-65
  // -----------------------------------------------------------------------
  it('accepts the add command call pattern: (string, number, { name?: string })', () => {
    // add.ts passes response.error?.code which can be undefined
    expect(() => {
      cliError('Validation error', 6, {
        name: undefined,
        details: undefined,
        fix: undefined,
      });
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
    const spy = vi.spyOn(console, 'log');
    spy.mockClear();
    cliError('Not found', 4);

    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(output.success).toBe(false);
    expect(output.error.message).toBe('Not found');
    expect(output.error.code).toBe(4);
  });

  // -----------------------------------------------------------------------
  // T336 regression: third argument was previously ignored (_details)
  // -----------------------------------------------------------------------

  it('emits codeName, fix, details, and alternatives when all are provided', () => {
    const spy = vi.spyOn(console, 'log');
    spy.mockClear();

    cliError('Validation failed', 6, {
      name: 'E_VALIDATION',
      fix: 'do X',
      details: { field: 'title' },
      alternatives: [{ action: 'A', command: 'c' }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(output.success).toBe(false);
    expect(output.error.codeName).toBe('E_VALIDATION');
    expect(output.error.fix).toBe('do X');
    expect(output.error.details).toEqual({ field: 'title' });
    expect(output.error.alternatives).toEqual([{ action: 'A', command: 'c' }]);
  });

  it('omits optional fields from JSON when they are not provided', () => {
    const spy = vi.spyOn(console, 'log');
    spy.mockClear();

    cliError('Something failed', 1);

    const output = JSON.parse(spy.mock.calls[0]![0] as string);
    expect('codeName' in output.error).toBe(false);
    expect('fix' in output.error).toBe(false);
    expect('alternatives' in output.error).toBe(false);
    expect('details' in output.error).toBe(false);
  });

  it('omits optional fields when details object has all-undefined values', () => {
    const spy = vi.spyOn(console, 'log');
    spy.mockClear();

    cliError('Validation error', 6, {
      name: undefined,
      details: undefined,
      fix: undefined,
      alternatives: undefined,
    });

    const output = JSON.parse(spy.mock.calls[0]![0] as string);
    expect('codeName' in output.error).toBe(false);
    expect('fix' in output.error).toBe(false);
    expect('alternatives' in output.error).toBe(false);
    expect('details' in output.error).toBe(false);
  });

  it('prints Fix hint on second line in human format', () => {
    vi.mocked(getFormatContext).mockReturnValueOnce({
      format: 'human',
      source: 'flag',
      quiet: false,
    });

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrSpy.mockClear();

    cliError('Bad input', 6, { fix: 'run cleo doctor' });

    const calls = stderrSpy.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0]).toContain('Bad input');
    expect(calls[1]![0]).toBe('Fix: run cleo doctor');
  });

  it('does not print Fix hint in human format when fix is not a string', () => {
    vi.mocked(getFormatContext).mockReturnValueOnce({
      format: 'human',
      source: 'flag',
      quiet: false,
    });

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stderrSpy.mockClear();

    cliError('Bad input', 6, { fix: { nested: 'object' } });

    const calls = stderrSpy.mock.calls;
    // Only one call — the error line; no Fix: line
    expect(calls.length).toBe(1);
  });
});
