/**
 * Tests for the `cleo reconcile release` CLI command.
 *
 * These tests stub the `@cleocode/core` `release.runInvariants` function
 * so the CLI can be exercised in isolation — without a real git repo or
 * tasks.db. The end-to-end behavior of the invariant itself is covered by
 * `packages/core/src/release/invariants/__tests__/archive-reason-invariant.test.ts`.
 *
 * Exit-code matrix (from the task spec):
 *   0  — green run
 *   1  — at least one error
 *   2  — unreconciled tasks present (no errors)
 *
 * @task T1411
 * @epic T1407
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileCommand } from '../reconcile.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core to control runInvariants() output
// ---------------------------------------------------------------------------

const runInvariantsMock = vi.fn();

vi.mock('@cleocode/core', () => ({
  release: {
    runInvariants: (...args: unknown[]) => runInvariantsMock(...args),
  },
}));

/**
 * Invoke `cleo reconcile release` with the given args and capture the
 * resulting exit code (raised by `process.exit` inside the command).
 */
async function runReleaseSubcommand(args: Record<string, unknown>): Promise<{
  exitCode: number;
  stdout: string;
}> {
  const releaseSub = (
    reconcileCommand as unknown as {
      subCommands?: Record<
        string,
        { run: (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void> }
      >;
    }
  ).subCommands?.['release'];
  if (!releaseSub) throw new Error('release subcommand not found on reconcileCommand');

  const stdoutChunks: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

  let exitCode = 0;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__EXIT__:${exitCode}`);
  }) as never);

  try {
    await releaseSub.run({ args, rawArgs: [] });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__EXIT__')) throw err;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, stdout: stdoutChunks.join('') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo reconcile release', () => {
  beforeEach(() => {
    runInvariantsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 on a clean reconcile (no errors, no unreconciled)', async () => {
    runInvariantsMock.mockResolvedValueOnce({
      tag: 'v-test-1',
      processed: 2,
      reconciled: 2,
      unreconciled: 0,
      errors: 0,
      results: [
        {
          id: 'archive-reason',
          severity: 'info',
          message: 'tag v-test-1: 2 reconciled',
          processed: 2,
          reconciled: 2,
          unreconciled: 0,
          errors: 0,
        },
      ],
    });

    const { exitCode, stdout } = await runReleaseSubcommand({
      tag: 'v-test-1',
      'dry-run': false,
      json: false,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('reconcile release v-test-1');
    expect(stdout).toContain('archive-reason');
    expect(runInvariantsMock).toHaveBeenCalledWith(
      'v-test-1',
      expect.objectContaining({ dryRun: false }),
    );
  });

  it('exits 1 when an invariant raised errors', async () => {
    runInvariantsMock.mockResolvedValueOnce({
      tag: 'v-test-2',
      processed: 1,
      reconciled: 0,
      unreconciled: 0,
      errors: 1,
      results: [
        {
          id: 'archive-reason',
          severity: 'error',
          message: "invariant 'archive-reason' threw: synthetic failure",
          processed: 0,
          reconciled: 0,
          unreconciled: 0,
          errors: 1,
        },
      ],
    });

    const { exitCode } = await runReleaseSubcommand({
      tag: 'v-test-2',
      'dry-run': false,
      json: false,
    });

    expect(exitCode).toBe(1);
  });

  it('exits 2 when unreconciled tasks exist (no errors)', async () => {
    runInvariantsMock.mockResolvedValueOnce({
      tag: 'v-test-3',
      processed: 1,
      reconciled: 0,
      unreconciled: 1,
      errors: 0,
      results: [
        {
          id: 'archive-reason',
          severity: 'warning',
          message: 'tag v-test-3: 0 reconciled, 1 unreconciled',
          processed: 1,
          reconciled: 0,
          unreconciled: 1,
          errors: 0,
        },
      ],
    });

    const { exitCode } = await runReleaseSubcommand({
      tag: 'v-test-3',
      'dry-run': false,
      json: false,
    });

    expect(exitCode).toBe(2);
  });

  it('passes --dry-run through to runInvariants() and surfaces it in the summary', async () => {
    runInvariantsMock.mockResolvedValueOnce({
      tag: 'v-test-dry',
      processed: 0,
      reconciled: 0,
      unreconciled: 0,
      errors: 0,
      results: [],
    });

    const { exitCode, stdout } = await runReleaseSubcommand({
      tag: 'v-test-dry',
      'dry-run': true,
      json: false,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run)');
    expect(runInvariantsMock).toHaveBeenCalledWith(
      'v-test-dry',
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('emits raw JSON when --json is set', async () => {
    runInvariantsMock.mockResolvedValueOnce({
      tag: 'v-test-json',
      processed: 0,
      reconciled: 0,
      unreconciled: 0,
      errors: 0,
      results: [],
    });

    const { exitCode, stdout } = await runReleaseSubcommand({
      tag: 'v-test-json',
      'dry-run': false,
      json: true,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.tag).toBe('v-test-json');
    expect(parsed.processed).toBe(0);
  });
});
