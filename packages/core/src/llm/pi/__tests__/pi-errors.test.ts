/**
 * Tests for Pi error / exit containment (T11761 · S1 · T11897).
 *
 * @epic T10403
 * @task T11761
 * @task T11897
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPiContainmentError, PiContainmentError, wrapPiCall, wrapPiError } from '../pi-errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PiContainmentError', () => {
  it('carries the string piCode and a numeric CleoError exit code', () => {
    const err = new PiContainmentError('E_PI_LOOP_FAILED', 'boom');
    expect(err).toBeInstanceOf(PiContainmentError);
    expect(err.piCode).toBe('E_PI_LOOP_FAILED');
    expect(err.name).toBe('PiContainmentError');
    // numeric ExitCode super-field is present (GENERAL_ERROR = 1 default)
    expect(typeof err.code).toBe('number');
    // projects the piCode into LAFS details
    const lafs = err.toLAFSError();
    expect(lafs.details).toMatchObject({ fieldDetails: { piCode: 'E_PI_LOOP_FAILED' } });
  });

  it('isPiContainmentError narrows correctly', () => {
    expect(isPiContainmentError(new PiContainmentError('E_PI_ABORTED', 'x'))).toBe(true);
    expect(isPiContainmentError(new Error('x'))).toBe(false);
    expect(isPiContainmentError(null)).toBe(false);
  });
});

describe('wrapPiError', () => {
  it('passes a PiContainmentError through unchanged', () => {
    const original = new PiContainmentError('E_PI_PROCESS_EXIT_TRAPPED', 'exit');
    expect(wrapPiError(original)).toBe(original);
  });

  it('wraps an arbitrary Error as E_PI_LOOP_FAILED with cause', () => {
    const cause = new Error('underlying');
    const wrapped = wrapPiError(cause);
    expect(wrapped.piCode).toBe('E_PI_LOOP_FAILED');
    expect(wrapped.cause).toBe(cause);
  });

  it('wraps a non-Error thrown value', () => {
    const wrapped = wrapPiError('string failure');
    expect(wrapped.piCode).toBe('E_PI_LOOP_FAILED');
    expect(wrapped.message).toContain('string failure');
  });
});

describe('wrapPiCall — happy path + result passthrough', () => {
  it('returns the wrapped fn result and restores process.exit afterwards', async () => {
    const realExit = process.exit;
    const result = await wrapPiCall(async () => 42);
    expect(result).toBe(42);
    // exit hook restored
    expect(process.exit).toBe(realExit);
  });

  it('passes a live AbortSignal into fn', async () => {
    let received: AbortSignal | undefined;
    await wrapPiCall(async (sig) => {
      received = sig;
      return 'ok';
    });
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });
});

describe('wrapPiCall — process.exit trap', () => {
  it('converts a process.exit() call inside fn into E_PI_PROCESS_EXIT_TRAPPED', async () => {
    const realExit = process.exit;
    await expect(
      wrapPiCall(async () => {
        // simulate a Pi-internal exit attempt
        process.exit(1);
        return 'never';
      }),
    ).rejects.toMatchObject({ piCode: 'E_PI_PROCESS_EXIT_TRAPPED' });
    // daemon survives + hook restored
    expect(process.exit).toBe(realExit);
  });

  it('restores process.exit even when fn throws a non-exit error', async () => {
    const realExit = process.exit;
    await expect(
      wrapPiCall(async () => {
        throw new Error('regular failure');
      }),
    ).rejects.toMatchObject({ piCode: 'E_PI_LOOP_FAILED' });
    expect(process.exit).toBe(realExit);
  });
});

describe('wrapPiCall — process.exitCode mutation trap', () => {
  it('neutralizes a process.exitCode mutation and restores the property', async () => {
    const before = process.exitCode;
    await expect(
      wrapPiCall(async () => {
        // simulate a Pi-internal exitCode mutation
        process.exitCode = 137;
        return 'never';
      }),
    ).rejects.toMatchObject({ piCode: 'E_PI_EXIT_CODE_MUTATION_TRAPPED' });
    // restored: still writable + value unchanged from before the run
    expect(process.exitCode).toBe(before);
    // and the property is writable again post-restore (legitimate writes work)
    process.exitCode = before ?? 0;
    expect(process.exitCode).toBe(before ?? 0);
  });
});

describe('wrapPiCall — abort routing', () => {
  it('rejects with E_PI_ABORTED when the signal is already aborted (fn never runs)', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'ran');
    await expect(wrapPiCall(fn, controller.signal)).rejects.toMatchObject({
      piCode: 'E_PI_ABORTED',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates an external abort into the signal handed to fn', async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    const promise = wrapPiCall(async (sig) => {
      // observe the propagation: abort mid-flight then resolve once seen
      return await new Promise<string>((resolve) => {
        sig.addEventListener('abort', () => {
          seen.push(sig.aborted);
          resolve('aborted-observed');
        });
      });
    }, controller.signal);
    controller.abort();
    await expect(promise).resolves.toBe('aborted-observed');
    expect(seen).toEqual([true]);
  });

  it('normalizes a thrown AbortError to E_PI_ABORTED', async () => {
    const controller = new AbortController();
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      wrapPiCall(async () => {
        throw abortErr;
      }, controller.signal),
    ).rejects.toMatchObject({ piCode: 'E_PI_ABORTED' });
  });
});
