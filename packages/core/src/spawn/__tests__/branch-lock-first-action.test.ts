/**
 * `buildWorktreeSpawnResult` must emit a `FIRST ACTION: cd …` line that a
 * shell can run for ANY worktree path (T12528).
 *
 * The macOS default worktree root is `~/Library/Application Support/cleo/…`,
 * so an unquoted `cd ${path}` splits on the space and lands the agent in the
 * wrong directory (or fails). The line is now a single-quoted shell word.
 *
 * @task T12528
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The git/NAPI worktree primitives are irrelevant to preamble rendering; stub
// them so this unit test needs neither a built `@cleocode/worktree` nor a repo.
vi.mock('@cleocode/worktree', () => ({
  getGitRoot: vi.fn(),
  gitSilent: vi.fn(),
  gitSync: vi.fn(),
  integrateWorktree: vi.fn(),
  napiDestroyWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

import { buildWorktreeSpawnResult } from '../branch-lock.js';

/** Extract the command after `FIRST ACTION: ` from a preamble. */
function firstActionCommand(preamble: string): string {
  const line = preamble.split('\n').find((l) => l.startsWith('FIRST ACTION: '));
  if (!line) throw new Error('preamble has no FIRST ACTION line');
  return line.slice('FIRST ACTION: '.length);
}

describe('buildWorktreeSpawnResult — FIRST ACTION quoting (T12528)', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-first-action-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    ['a space', 'Application Support/wt/T1'],
    ['a single quote', "it's here/T1"],
    ['shell metacharacters', 'a $HOME `x` ; b/T1'],
  ])('emits a cd that lands in a path containing %s', (_label, rel) => {
    const path = join(base, rel);
    mkdirSync(path, { recursive: true });
    const result = buildWorktreeSpawnResult(
      { path, branch: 'task/T1', projectHash: 'abc', taskId: 'T1' } as never,
      '/tmp/shim',
    );
    const command = firstActionCommand(result.preamble);
    expect(command.startsWith("cd '")).toBe(true);
    const landed = execFileSync('bash', ['--noprofile', '--norc', '-c', `${command} && pwd -P`], {
      encoding: 'utf8',
    }).trim();
    expect(landed).toBe(path);
  });
});
