/**
 * T14168: the lazy merge sweep never starts from a CLI built in a worktree, and
 * never for `release` run from a CLEO worktree (it would run git and a real
 * sweep in the project checkout it was not started in).
 *
 * @task T14168
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorktreeBuildGuardForTests } from '../../store/worktree-build-guard.js';
import { lazySweepBlockedReason } from '../merge-close.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

let tmp = '';
let primary = '';
let worktree = '';

beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  tmp = mkdtempSync(join(tmpdir(), 'cleo-t14168-'));
  primary = join(tmp, 'primary');
  worktree = join(tmp, 'wt');
  mkdirSync(join(primary, '.cleo'), { recursive: true });
  writeFileSync(join(primary, 'README.md'), 'x\n');
  git(primary, ['init', '-q', '-b', 'main']);
  git(primary, ['config', 'user.email', 'cleo@example.test']);
  git(primary, ['config', 'user.name', 'Cleo Test']);
  git(primary, ['add', '.']);
  git(primary, ['commit', '-q', '-m', 'initial']);
  git(primary, ['worktree', 'add', '-q', '-b', 'task/T14168', worktree, 'main']);
  // A released build: no linked worktree in its stamp.
  setWorktreeBuildGuardForTests({ provenance: { linkedWorktree: null } });
});

afterEach(() => {
  setWorktreeBuildGuardForTests(null);
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('lazySweepBlockedReason (T14168)', () => {
  it('blocks release from a CLEO worktree, and allows it from the project checkout', async () => {
    expect(await lazySweepBlockedReason('release', worktree)).toContain('worktree');
    expect(await lazySweepBlockedReason('release', primary)).toBeNull();
    // Other lazy-sweep commands keep sweeping from a worktree (unchanged).
    expect(await lazySweepBlockedReason('briefing', worktree)).toBeNull();
  });

  it('blocks every command when the CLI was built in a worktree', async () => {
    setWorktreeBuildGuardForTests({ provenance: { linkedWorktree: worktree } });
    for (const command of ['release', 'briefing', 'show']) {
      expect(await lazySweepBlockedReason(command, primary)).toContain('dev build never sweeps');
    }
  });
});
