/**
 * `cleo run` CLI surface (T12979): flags after `--` belong to the child, and
 * the runner's exit code mirrors the child's outcome.
 *
 * @task T12979
 */

import { describe, expect, it } from 'vitest';
import { runExitCode } from '../commands/run.js';
import { extractIdempotencyKeyArg } from '../idempotency-context.js';

describe('cleo run argv', () => {
  it('leaves --idempotency-key after -- to the child command', () => {
    const r = extractIdempotencyKeyArg(['run', '--', 'tool', '--idempotency-key', 'k1']);
    expect(r.idempotencyKey).toBeUndefined();
    expect(r.argv).toEqual(['run', '--', 'tool', '--idempotency-key', 'k1']);
  });

  it('still reads a cleo --idempotency-key before --', () => {
    const r = extractIdempotencyKeyArg(['add', '--idempotency-key', 'k2', 'x']);
    expect(r.idempotencyKey).toBe('k2');
    expect(r.argv).toEqual(['add', 'x']);
  });
});

describe('runExitCode', () => {
  it('mirrors the child: code, 128+signal, 127 when it could not start', () => {
    expect(runExitCode({ exitCode: 0, signal: null, spawnError: null })).toBe(0);
    expect(runExitCode({ exitCode: 3, signal: null, spawnError: null })).toBe(3);
    expect(runExitCode({ exitCode: null, signal: 'SIGTERM', spawnError: null })).toBe(143);
    expect(runExitCode({ exitCode: null, signal: 'SIGKILL', spawnError: null })).toBe(137);
    expect(runExitCode({ exitCode: null, signal: null, spawnError: 'ENOENT' })).toBe(127);
  });
});
