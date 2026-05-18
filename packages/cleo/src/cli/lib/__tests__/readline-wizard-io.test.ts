/**
 * Tests for {@link ReadlineWizardIO} (T9599).
 *
 * Verifies:
 *   - info/warn/error all write to stderr, never stdout (bug #1).
 *   - prompt/confirm/select propagate {@link StdinClosedError} when stdin
 *     closes before a response is received (bug #10).
 *
 * @task T9599
 */

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadlineWizardIO, StdinClosedError } from '../readline-wizard-io.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ReadlineWizardIO backed by in-memory streams.
 *
 * @param inputLines - Lines (without newline) to push into stdin in order.
 *   Pass `null` as a sentinel to push EOF immediately after the lines.
 * @param eofImmediate - If true, end the input stream immediately (before
 *   any readline question can get an answer).
 */
function makeIO(inputLines: string[] = [], eofImmediate = false): ReadlineWizardIO {
  const input = new PassThrough();
  const output = new PassThrough(); // discard readline echo
  const io = new ReadlineWizardIO(input, output);
  if (eofImmediate) {
    // Close stdin immediately — the readline close event fires and aborts.
    setImmediate(() => input.end());
  } else {
    for (const line of inputLines) {
      input.write(`${line}\n`);
    }
    input.end();
  }
  return io;
}

// ---------------------------------------------------------------------------
// Stdout discipline (T9599 bug #1)
// ---------------------------------------------------------------------------

describe('stdout discipline — info/warn/error route to stderr, never stdout', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('info() writes to stderr only', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    io.info('hello from info');
    io.close();
    input.end();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('hello from info'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('hello from info'));
  });

  it('warn() writes to stderr only', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    io.warn('warning message');
    io.close();
    input.end();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('warning message'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('warning message'));
  });

  it('error() writes to stderr only', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    io.error('error message');
    io.close();
    input.end();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('error message'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('error message'));
  });

  it('select() menu items write to stderr, never stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    // Feed the answer through the input stream
    setImmediate(() => {
      input.write('1\n');
      input.end();
    });
    await io.select('Pick one', ['alpha', 'beta'] as const);
    io.close();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Pick one'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('Pick one'));
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('alpha'));
  });
});

// ---------------------------------------------------------------------------
// EOF handling (T9599 bug #10)
// ---------------------------------------------------------------------------

describe('EOF handling — StdinClosedError on stdin close', () => {
  it('prompt() throws StdinClosedError when stdin closes immediately', async () => {
    const io = makeIO([], true);
    await expect(io.prompt('Your name?')).rejects.toThrow(StdinClosedError);
    io.close();
  });

  it('confirm() throws StdinClosedError when stdin closes immediately', async () => {
    const io = makeIO([], true);
    await expect(io.confirm('Are you sure?', false)).rejects.toThrow(StdinClosedError);
    io.close();
  });

  it('select() throws StdinClosedError when stdin closes immediately', async () => {
    const io = makeIO([], true);
    await expect(io.select('Pick one', ['a', 'b'] as const)).rejects.toThrow(StdinClosedError);
    io.close();
  });

  it('StdinClosedError has the correct codeName', async () => {
    const io = makeIO([], true);
    let caughtError: unknown;
    try {
      await io.prompt('Name?');
    } catch (err) {
      caughtError = err;
    } finally {
      io.close();
    }
    expect(StdinClosedError.is(caughtError)).toBe(true);
    expect((caughtError as StdinClosedError).codeName).toBe('E_SETUP_STDIN_CLOSED');
  });

  it('normal prompt() resolves when stdin provides an answer', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      input.write('Atlas\n');
      input.end();
    });
    const answer = await io.prompt('Name?');
    io.close();
    expect(answer).toBe('Atlas');
  });
});
