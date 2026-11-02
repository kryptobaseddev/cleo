/**
 * T14183 — repo-reading checks read the checkout they are started from.
 *
 * `resolveInvokingCheckout()` backs `check canon`, `check canon docs`, the
 * test checks, `docs rot` and the release verbs: from a CLEO worktree it is
 * that worktree (not the root checkout), and an explicit `CLEO_ROOT` wins.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInvokingCheckout } from '../paths.js';

beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const fixtures: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A root checkout with `.cleo/` and a linked worktree of it. */
function rootAndWorktree(): { root: string; worktree: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t14183-')));
  fixtures.push(tmp);
  const root = join(tmp, 'root');
  const worktree = join(tmp, 'worktrees', 'hash', 'T14183');
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'readme.md'), '# root\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'cleo@example.test']);
  git(root, ['config', 'user.name', 'Cleo Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  git(root, ['worktree', 'add', '-b', 'task/T14183', worktree, 'main']);
  return { root, worktree };
}

describe('resolveInvokingCheckout (T14183)', () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });

  it('is the worktree when run from inside it, and the root checkout from the root', () => {
    const { root, worktree } = rootAndWorktree();
    expect(resolveInvokingCheckout(join(worktree, 'docs'))).toBe(worktree);
    expect(resolveInvokingCheckout(root)).toBe(root);
  });

  it('an explicit CLEO_ROOT wins over the invoking worktree', () => {
    const { root, worktree } = rootAndWorktree();
    vi.stubEnv('CLEO_ROOT', root);
    expect(resolveInvokingCheckout(worktree)).toBe(root);
  });
});
