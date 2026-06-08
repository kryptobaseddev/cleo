/**
 * T11762 ST-4 — `--field` E_FIELD_NOT_FOUND remediation loop.
 *
 * Regression coverage for the DHQ-057 user-facing symptom: a failed `--field`
 * JSON pointer (`cleo show T123 --field /data/title`) used to raise a BARE
 * `E_FIELD_NOT_FOUND` ("Pointer … did not resolve") with ZERO guidance — even
 * when the operation HAS a registered output contract whose valid pointers were
 * reachable only via the opt-in `--describe` call. The loop was open.
 *
 * After ST-4 the failure branch in `cliOutput` consults
 * `getOutputContract(opts.operation)` and enriches the error envelope with:
 *   - `fix`          — "Valid pointers for <op>: …" (+ the contract `shapeNote`).
 *   - `alternatives` — up to 5 `{action, command}` pairs the agent can re-run.
 * An op WITHOUT a contract degrades gracefully to the `--describe` hint.
 *
 * These are integration tests: they drive the REAL `getOutputContract` registry
 * (no mock of the contract data) through the REAL `cliOutput` field branch, so
 * the asserted pointers (`/data/task/title`) are the live `tasks.show` contract.
 *
 * @task T11905
 * @task T11762 ST-4
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFieldContext } from '../../field-context.js';
import { setFormatContext } from '../../format-context.js';
import { cliOutput } from '../index.js';

/**
 * Drive `cliOutput` with a failing `--field` JSON pointer and capture the LAFS
 * error envelope it writes to stdout. `process.exit` is stubbed to throw a
 * sentinel so the synchronous `cliError(...) → process.exit(4)` path is
 * observable without tearing down the test runner.
 */
function captureFieldError(
  data: unknown,
  field: string,
  opts: { command: string; operation?: string },
): { envelope: Record<string, unknown>; exitCode: number | undefined } {
  setFormatContext({ format: 'json', source: 'flag', quiet: false });
  setFieldContext({ field, mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });

  let captured = '';
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });

  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__process_exit_${code}__`);
  }) as never);

  try {
    cliOutput(data, opts);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__process_exit_')) throw err;
  } finally {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const line = captured.split('\n').filter((l) => l.trim().length > 0)[0] ?? '{}';
  return { envelope: JSON.parse(line) as Record<string, unknown>, exitCode };
}

describe('cliOutput --field remediation (T11762 ST-4 · DHQ-057)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setFieldContext({ mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    vi.restoreAllMocks();
  });

  it('enriches E_FIELD_NOT_FOUND with the tasks.show contract pointers (the DHQ-057 repro)', () => {
    // The classic failure: agent guesses /data/title; the real pointer is
    // /data/task/title (the title is nested under `task`).
    const { envelope, exitCode } = captureFieldError(
      { task: { id: 'T1', title: 'Hello' }, view: {}, attachments: [] },
      '/data/title',
      { command: 'show', operation: 'tasks.show' },
    );

    expect(exitCode).toBe(4);
    const error = envelope['error'] as Record<string, unknown>;
    expect(envelope['success']).toBe(false);
    expect(error['code']).toBe(4);
    expect(error['codeName']).toBe('E_FIELD_NOT_FOUND');

    // `fix` lists the valid pointers, INCLUDING the correct one the agent missed.
    expect(typeof error['fix']).toBe('string');
    const fix = error['fix'] as string;
    expect(fix).toContain('Valid pointers for tasks.show');
    expect(fix).toContain('/data/task/title');
  });

  it('emits alternatives as {action,command}[] re-runnable against the failing op', () => {
    const { envelope } = captureFieldError(
      { task: { id: 'T1', title: 'Hello' }, view: {}, attachments: [] },
      '/data/title',
      { command: 'show', operation: 'tasks.show' },
    );

    const error = envelope['error'] as Record<string, unknown>;
    const alternatives = error['alternatives'] as Array<{ action: string; command: string }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBeGreaterThan(0);
    // At most 5 (the contract's high-value pointer slice).
    expect(alternatives.length).toBeLessThanOrEqual(5);
    for (const alt of alternatives) {
      expect(typeof alt.action).toBe('string');
      expect(alt.command).toMatch(/^cleo show --field \/data\//);
    }
    // The corrected pointer is offered as a directly runnable alternative.
    const corrected = alternatives.find((a) => a.command.includes('/data/task/title'));
    expect(corrected).toBeDefined();
    expect(corrected?.action).toBe('extract /data/task/title');
  });

  it('degrades to the --describe hint when the op has NO contract', () => {
    // A genuinely-unregistered operation resolves a `null` contract — the loop
    // must NOT throw; it falls back to the introspection hint.
    const { envelope, exitCode } = captureFieldError({ anything: 1 }, '/data/missing', {
      command: 'frobnicate',
      operation: 'nonexistent.operation',
    });

    expect(exitCode).toBe(4);
    const error = envelope['error'] as Record<string, unknown>;
    expect(error['codeName']).toBe('E_FIELD_NOT_FOUND');
    expect(error['fix']).toBe('Run: cleo frobnicate --describe');
    // No fabricated alternatives when there is no contract to source them from.
    expect('alternatives' in error).toBe(false);
  });

  it('degrades to the --describe hint when opts.operation is absent', () => {
    // Without an operation id there is nothing to resolve a contract against;
    // the hint is keyed off the command name only.
    const { envelope } = captureFieldError({ anything: 1 }, '/data/missing', {
      command: 'show',
    });

    const error = envelope['error'] as Record<string, unknown>;
    expect(error['codeName']).toBe('E_FIELD_NOT_FOUND');
    expect(error['fix']).toBe('Run: cleo show --describe');
    expect('alternatives' in error).toBe(false);
  });
});
