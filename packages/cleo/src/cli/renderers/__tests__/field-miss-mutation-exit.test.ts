/**
 * A `--field` pointer miss must never report that a MUTATION failed (gh#1420).
 *
 * ## The defect
 *
 * Pointer resolution runs AFTER the operation. When it failed, its error
 * replaced the envelope wholesale, so a gate write that COMMITTED reported
 * `success:false` and exit 4 — indistinguishable from a rejected write:
 *
 * ```
 * $ cleo verify T12187 --gate implemented --evidence "pr:1417" --field /data/task/verification
 * {"success":false,"error":{"code":4,"codeName":"E_FIELD_NOT_FOUND", ...}}   $? = 4
 * $ cleo verify T12187 --gate implemented --evidence "pr:1417"                $? = 0
 * ```
 *
 * The write landed in both cases. The natural handling of that false red —
 * `cleo verify … --field … || retry` — re-runs a write that already succeeded.
 *
 * Note the issue's own fallback ("at minimum use a distinct exit code") cannot
 * fix its own repro: ANY non-zero code triggers `||`. Only exit 0 does.
 *
 * ## Why the branch keys on the CQRS gateway
 *
 * `buildEnvelopeForPointer` hardcodes `success: true` because errors never
 * reach this render path, so by the time a pointer misses, the operation has
 * already succeeded. The only open question is whether it was a mutation.
 *
 * The gateway (`'query' | 'mutate'`) is declared by every dispatch and rides on
 * the response meta. `OPERATION_BUCKETS` is NOT the right source: it answers
 * "which bucket does this TASK mutation project into", holds six `tasks.*`
 * entries, and omits `check.gate.set` — so keying on it would classify
 * `cleo verify` as a read and miss the one operation this defect is about.
 *
 * ## Why stdout stays empty
 *
 * `--field` is a scalar-extract mode whose contract is "stdout is the value".
 * Emitting the envelope instead would give `v=$(cleo … --field /bad)` a JSON
 * blob that a caller consumes as an id — a confidently wrong-shaped answer,
 * worse than none.
 *
 * @task T12218 (gh#1420)
 */

import type { DispatchResponseMeta } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFieldContext } from '../../field-context.js';
import { setFormatContext } from '../../format-context.js';
import { cliOutput } from '../index.js';

function metaFor(gateway: 'query' | 'mutate', operation: string): DispatchResponseMeta {
  return {
    gateway,
    domain: operation.split('.')[0] ?? 'check',
    operation,
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 1,
    source: 'cli',
    requestId: 'req-test',
  } as DispatchResponseMeta;
}

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

function run(
  data: unknown,
  field: string,
  opts: { command: string; operation: string; responseMeta?: DispatchResponseMeta },
): Run {
  setFormatContext({ format: 'json', source: 'flag', quiet: false });
  setFieldContext({ field, mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });

  let stdout = '';
  let stderr = '';
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((c: string | Uint8Array): boolean => {
      stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((c: string | Uint8Array): boolean => {
      stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
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
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  setFieldContext(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  setFieldContext(null);
  setFormatContext(null);
});

const GATE_WRITE = { taskId: 'T12187', verification: { passed: true } };

describe('pointer miss on a MUTATION (gh#1420)', () => {
  it('does NOT exit non-zero — the write landed', () => {
    const r = run(GATE_WRITE, '/data/task/verification', {
      command: 'verify',
      operation: 'check.gate.set',
      responseMeta: metaFor('mutate', 'check.gate.set'),
    });
    // The load-bearing assertion. Any non-zero code triggers `|| retry`, which
    // re-runs a committed gate write.
    expect(r.exitCode).toBeUndefined();
  });

  it('says on STDERR that the operation succeeded, and leaves stdout empty', () => {
    const r = run(GATE_WRITE, '/data/task/verification', {
      command: 'verify',
      operation: 'check.gate.set',
      responseMeta: metaFor('mutate', 'check.gate.set'),
    });
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('E_FIELD_NOT_FOUND');
    expect(r.stderr).toContain('/data/task/verification');
    expect(r.stderr).toContain('SUCCEEDED');
  });

  it('still extracts a pointer that DOES resolve', () => {
    // Control: the mutation branch must not swallow the happy path.
    const r = run(GATE_WRITE, '/data/taskId', {
      command: 'verify',
      operation: 'check.gate.set',
      responseMeta: metaFor('mutate', 'check.gate.set'),
    });
    expect(r.stdout.trim()).toBe('T12187');
    expect(r.exitCode).toBeUndefined();
  });
});

describe('pointer miss on a READ is unchanged (gh#1420)', () => {
  it('still exits 4 — a read commits nothing, so there is no retry hazard', () => {
    // Control. `cleo show T123 --field /nonexistent` exiting 4 is CORRECT and
    // `field-flag.test.ts` pins it; the fix must not widen to reads.
    const r = run({ task: { id: 'T1' } }, '/data/nope', {
      command: 'show',
      operation: 'tasks.show',
      responseMeta: metaFor('query', 'tasks.show'),
    });
    expect(r.exitCode).toBe(4);
    expect(r.stdout).toContain('E_FIELD_NOT_FOUND');
  });
});
