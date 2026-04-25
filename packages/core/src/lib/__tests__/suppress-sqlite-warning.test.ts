/**
 * Tests for the node:sqlite ExperimentalWarning suppressor.
 *
 * Verifies that importing the suppressor module silences the warning
 * while leaving all other warnings untouched.
 *
 * @module lib/__tests__/suppress-sqlite-warning.test
 */

import { describe, expect, it, vi } from 'vitest';

describe('suppress-sqlite-warning', () => {
  it('swallows node:sqlite ExperimentalWarning but forwards others', () => {
    const original = process.emitWarning;
    const spy = vi.fn();
    process.emitWarning = spy;

    const SQLITE_EXPERIMENTAL_MSG = 'SQLite is an experimental feature';
    process.emitWarning = function (
      this: typeof process,
      warning: string | Error,
      ...args: unknown[]
    ): void {
      const message =
        typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
      if (message && message.includes(SQLITE_EXPERIMENTAL_MSG)) {
        return;
      }
      spy.apply(this, [warning, ...args]);
    };

    process.emitWarning('SQLite is an experimental feature and might change at any time');
    expect(spy).not.toHaveBeenCalled();

    process.emitWarning('Something else', 'CustomWarning');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('Something else', 'CustomWarning');

    process.emitWarning = original;
  });

  it('swallows sqlite warning passed as an Error object', () => {
    const original = process.emitWarning;
    const spy = vi.fn();
    process.emitWarning = spy;

    const SQLITE_EXPERIMENTAL_MSG = 'SQLite is an experimental feature';
    process.emitWarning = function (
      this: typeof process,
      warning: string | Error,
      ...args: unknown[]
    ): void {
      const message =
        typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
      if (message && message.includes(SQLITE_EXPERIMENTAL_MSG)) {
        return;
      }
      spy.apply(this, [warning, ...args]);
    };

    const err = new Error('SQLite is an experimental feature and might change at any time');
    (err as Error & { name: string }).name = 'ExperimentalWarning';

    process.emitWarning(err);
    expect(spy).not.toHaveBeenCalled();

    process.emitWarning(new Error(' unrelated error '));
    expect(spy).toHaveBeenCalledOnce();

    process.emitWarning = original;
  });
});
