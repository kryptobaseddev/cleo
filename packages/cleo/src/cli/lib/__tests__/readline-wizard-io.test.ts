/**
 * Tests for {@link ReadlineWizardIO} (T9599, T9612).
 *
 * Verifies:
 *   - info/warn/error all write to stderr, never stdout (bug #1).
 *   - prompt/confirm/select propagate {@link StdinClosedError} when stdin
 *     closes before a response is received (bug #10).
 *   - Bracketed-paste sequences are stripped from prompt/confirm/select
 *     input (T9612).
 *   - {@link WizardInterruptError} is thrown on SIGINT (T9612).
 *   - {@link stripBracketedPaste} helper works in isolation.
 *
 * @task T9599
 * @task T9612
 */

import { PassThrough } from 'node:stream';
import { WizardInterruptError } from '@cleocode/core/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadlineWizardIO, StdinClosedError, stripBracketedPaste } from '../readline-wizard-io.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ReadlineWizardIO backed by in-memory streams.
 *
 * @param inputLines - Lines (without newline) to push into stdin in order.
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

/**
 * Emit `'SIGINT'` on the underlying readline interface of a
 * {@link ReadlineWizardIO} to simulate Ctrl-C without needing a real TTY.
 *
 * `readline` only propagates `'SIGINT'` from the input stream when
 * `terminal: true` (a real TTY). In tests we use PassThrough streams, so
 * we must emit directly on the rl interface. {@link ReadlineWizardIO}
 * exposes `rl` as `protected` specifically for this purpose.
 */
function simulateSigint(io: ReadlineWizardIO): void {
  (io as unknown as { rl: { emit(event: string): void } }).rl.emit('SIGINT');
}

// ---------------------------------------------------------------------------
// stripBracketedPaste unit tests (T9612)
// ---------------------------------------------------------------------------

describe('stripBracketedPaste — unit', () => {
  it('removes opening bracketed-paste marker', () => {
    expect(stripBracketedPaste('\x1b[200~hello')).toBe('hello');
  });

  it('removes closing bracketed-paste marker', () => {
    expect(stripBracketedPaste('hello\x1b[201~')).toBe('hello');
  });

  it('removes both markers around a pasted value', () => {
    expect(stripBracketedPaste('\x1b[200~sk-ant-api-key\x1b[201~')).toBe('sk-ant-api-key');
  });

  it('removes multiple occurrences of each marker', () => {
    expect(stripBracketedPaste('\x1b[200~foo\x1b[200~bar\x1b[201~')).toBe('foobar');
  });

  it('returns unchanged string when no markers present', () => {
    expect(stripBracketedPaste('plain-value')).toBe('plain-value');
  });

  it('trims surrounding whitespace', () => {
    expect(stripBracketedPaste('  value  ')).toBe('value');
  });

  it('handles empty string', () => {
    expect(stripBracketedPaste('')).toBe('');
  });
});

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

// ---------------------------------------------------------------------------
// Bracketed-paste sanitization via ReadlineWizardIO (T9612)
// ---------------------------------------------------------------------------

describe('bracketed-paste sanitization in ReadlineWizardIO', () => {
  it('prompt() strips bracketed-paste markers from pasted input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      // Simulate a paste: terminal wraps pasted text with escape sequences.
      input.write('\x1b[200~sk-ant-api-key\x1b[201~\n');
      input.end();
    });
    const answer = await io.prompt('API key?');
    io.close();
    expect(answer).toBe('sk-ant-api-key');
  });

  it('prompt() trims whitespace after stripping paste markers', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      input.write('  some-value  \n');
      input.end();
    });
    const answer = await io.prompt('Value?');
    io.close();
    expect(answer).toBe('some-value');
  });

  it('select() strips bracketed-paste markers from numeric choice input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      // Paste a numeric choice — should still work after stripping.
      input.write('\x1b[200~2\x1b[201~\n');
      input.end();
    });
    const result = await io.select('Choose provider', ['anthropic', 'openai'] as const);
    io.close();
    expect(result).toBe('openai');
  });

  it('confirm() handles bracketed-paste markers on y/n input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      input.write('\x1b[200~y\x1b[201~\n');
      input.end();
    });
    const result = await io.confirm('Proceed?', false);
    io.close();
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SIGINT / WizardInterruptError (T9612)
// ---------------------------------------------------------------------------

describe('SIGINT handling — WizardInterruptError on Ctrl-C', () => {
  it('prompt() throws WizardInterruptError when SIGINT fires on readline', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    // Start a prompt, then simulate Ctrl-C by emitting 'SIGINT' directly on
    // the readline interface. readline only propagates SIGINT from the input
    // stream when terminal:true (a real TTY); with a PassThrough we emit
    // directly on the rl interface as readline itself does on TTY Ctrl-C.
    const promptPromise = io.prompt('Enter value?');
    setImmediate(() => simulateSigint(io));
    await expect(promptPromise).rejects.toThrow(WizardInterruptError);
    io.close();
    input.end();
  });

  it('WizardInterruptError is not StdinClosedError', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    const promptPromise = io.prompt('Enter value?');
    setImmediate(() => simulateSigint(io));
    let caught: unknown;
    try {
      await promptPromise;
    } catch (err) {
      caught = err;
    } finally {
      io.close();
      input.end();
    }
    expect(caught).toBeInstanceOf(WizardInterruptError);
    expect(StdinClosedError.is(caught)).toBe(false);
  });

  it('WizardInterruptError has isWizardInterruptError discriminator', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    const promptPromise = io.prompt('Enter value?');
    setImmediate(() => simulateSigint(io));
    let caught: unknown;
    try {
      await promptPromise;
    } catch (err) {
      caught = err;
    } finally {
      io.close();
      input.end();
    }
    expect((caught as WizardInterruptError).isWizardInterruptError).toBe(true);
  });

  it('select() throws WizardInterruptError when SIGINT fires during option prompt', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    const selectPromise = io.select('Choose provider', ['anthropic', 'openai'] as const);
    setImmediate(() => simulateSigint(io));
    await expect(selectPromise).rejects.toThrow(WizardInterruptError);
    io.close();
    input.end();
  });
});

// ---------------------------------------------------------------------------
// select() happy-path (existing behaviour preserved)
// ---------------------------------------------------------------------------

describe('select() — happy path', () => {
  it('accepts a valid numeric choice', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      input.write('2\n');
      input.end();
    });
    const result = await io.select('Choose', ['alpha', 'beta', 'gamma'] as const);
    io.close();
    expect(result).toBe('beta');
  });

  it('accepts a verbatim option name', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    setImmediate(() => {
      input.write('gamma\n');
      input.end();
    });
    const result = await io.select('Choose', ['alpha', 'beta', 'gamma'] as const);
    io.close();
    expect(result).toBe('gamma');
  });

  it('throws when option list is empty', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineWizardIO(input, output);
    input.end();
    await expect(io.select('Choose', [] as const)).rejects.toThrow('option list is empty');
    io.close();
  });
});
