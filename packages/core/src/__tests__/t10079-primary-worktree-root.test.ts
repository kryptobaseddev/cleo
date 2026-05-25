/**
 * T10079 — release/verify project-level root resolution.
 *
 * `cleo release plan` and `cleo verify --gate implemented --evidence files:...`
 * consume `resolveWorktreeRouting().canonicalRoot` at the dispatch boundary.
 * This test locks the routing primitive to the primary worktree even when the
 * caller is inside a subdirectory of a secondary XDG-style git worktree.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorktreeRouting } from '../paths.js';

const fixtures: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('T10079 primary worktree root routing', () => {
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('resolves canonicalRoot to the primary worktree from a secondary worktree subdir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cleo-t10079-'));
    fixtures.push(tmp);

    const primary = join(tmp, 'primary');
    const secondary = join(tmp, 'xdg', 'cleo', 'worktrees', 'hash', 'T10079');
    mkdirSync(join(primary, '.cleo'), { recursive: true });
    mkdirSync(join(primary, 'packages'), { recursive: true });
    writeFileSync(join(primary, 'packages', 'sentinel.ts'), 'export const primary = true;\n');

    git(primary, ['init', '-b', 'main']);
    git(primary, ['config', 'user.email', 'cleo@example.test']);
    git(primary, ['config', 'user.name', 'Cleo Test']);
    git(primary, ['add', '.']);
    git(primary, ['commit', '-m', 'initial']);
    git(primary, ['worktree', 'add', '-b', 'task/T10079', secondary, 'main']);

    const secondarySubdir = join(secondary, 'packages');
    const routing = resolveWorktreeRouting(secondarySubdir);

    expect(routing.isWorktree).toBe(true);
    expect(routing.worktreePath).toBe(secondary);
    expect(routing.canonicalRoot).toBe(realpathSync(primary));
  });
});
