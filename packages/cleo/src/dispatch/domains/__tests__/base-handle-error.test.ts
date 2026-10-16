/**
 * `handleErrorResult` maps only real CleoErrors to their named code (T13725).
 *
 * @task T13725
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '@cleocode/core/errors';
import { describe, expect, it } from 'vitest';
import { handleErrorResult } from '../_base.js';

describe('handleErrorResult', () => {
  it('maps a CleoError to its named code and keeps fix and details', () => {
    const err = new CleoError(ExitCode.NOT_FOUND, "no doc or owner found for 'x'", {
      fix: 'Pass an owner id',
      details: { field: 'for' },
    });

    const res = handleErrorResult('query', 'docs', 'versions', err, Date.now());

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_NOT_FOUND');
    expect(res.error?.exitCode).toBe(ExitCode.NOT_FOUND);
    expect(res.error?.fix).toBe('Pass an owner id');
    expect(res.error?.details).toEqual({ field: 'for' });
  });

  it('keeps an execFile-style rejection with a numeric exit code as E_INTERNAL', () => {
    // A promisified execFile rejects with an Error whose `code` is the child's exit status.
    const err = Object.assign(new Error('Command failed: git status'), { code: 4 });

    const res = handleErrorResult('query', 'docs', 'versions', err, Date.now());

    expect(res.error).toEqual({ code: 'E_INTERNAL', message: 'Command failed: git status' });
  });
});
