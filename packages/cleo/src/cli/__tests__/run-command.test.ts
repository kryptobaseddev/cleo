/**
 * `cleo run` CLI surface (T12979): flags after `--` belong to the child, and
 * the runner's exit code mirrors the child's outcome.
 *
 * @task T12979
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Never spawn a real command from this file, even if the refusal regresses.
const runGoverned = vi.hoisted(() => vi.fn());
vi.mock('@cleocode/core/resources/run-governed.js', () => ({ runGoverned }));

import { runCommand, runExitCode } from '../commands/run.js';
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

describe('cleo run refuses watchers (#1777 round 6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runGoverned.mockReset();
  });

  it.each([
    [['turbo', 'run', 'dev']],
    [['pnpm', 'dev']],
    [['vitest', '--ui']],
    [['nx', 'run', 'app:serve']],
  ])('%j exits E_VALIDATION (6) without admission', async (argv) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = runCommand.run as (ctx: {
      args: Record<string, unknown>;
      rawArgs: string[];
    }) => Promise<void>;
    await expect(run({ args: { wait: false }, rawArgs: ['--', ...argv] })).rejects.toThrow(
      'exit 6',
    );
    expect(exit).toHaveBeenCalledWith(6);
    expect(runGoverned).not.toHaveBeenCalled();
  });
});
