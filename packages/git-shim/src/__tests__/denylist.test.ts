/**
 * Tests for the git-shim denylist (T1118 L2).
 *
 * Verifies:
 * - Blocked operations are correctly identified for restricted roles.
 * - Allowed operations pass through.
 * - Flag-based matching works for subcommands like `branch` and `reset`.
 *
 * @task T1118
 * @task T1121
 */

import { describe, expect, it } from 'vitest';
import {
  findDeniedOp,
  porcelainDestinations,
  protectedPorcelainDestinations,
  protectedPushRefspec,
  RESTRICTED_ROLES,
  splitGitArgv,
} from '../denylist.js';

describe('RESTRICTED_ROLES', () => {
  it('includes worker, lead, subagent', () => {
    expect(RESTRICTED_ROLES.has('worker')).toBe(true);
    expect(RESTRICTED_ROLES.has('lead')).toBe(true);
    expect(RESTRICTED_ROLES.has('subagent')).toBe(true);
  });

  it('does not include orchestrator', () => {
    expect(RESTRICTED_ROLES.has('orchestrator')).toBe(false);
  });
});

describe('findDeniedOp', () => {
  describe('unconditionally blocked subcommands', () => {
    it('blocks git checkout', () => {
      const result = findDeniedOp('checkout', []);
      expect(result).not.toBeNull();
      expect(result?.subcommand).toBe('checkout');
    });

    it('blocks git checkout with args', () => {
      const result = findDeniedOp('checkout', ['main']);
      expect(result).not.toBeNull();
    });

    it('blocks git switch', () => {
      expect(findDeniedOp('switch', [])).not.toBeNull();
    });

    it('blocks git rebase', () => {
      expect(findDeniedOp('rebase', [])).not.toBeNull();
    });

    it('blocks git rebase -i', () => {
      expect(findDeniedOp('rebase', ['-i', 'HEAD~3'])).not.toBeNull();
    });

    it('blocks git update-ref', () => {
      expect(findDeniedOp('update-ref', ['HEAD', 'abc123'])).not.toBeNull();
    });
  });

  describe('flag-gated blocked subcommands', () => {
    it('blocks git branch -b', () => {
      expect(findDeniedOp('branch', ['-b', 'my-branch'])).not.toBeNull();
    });

    it('blocks git branch -D', () => {
      expect(findDeniedOp('branch', ['-D', 'my-branch'])).not.toBeNull();
    });

    it('blocks git branch -d', () => {
      expect(findDeniedOp('branch', ['-d', 'my-branch'])).not.toBeNull();
    });

    it('allows git branch (list)', () => {
      expect(findDeniedOp('branch', [])).toBeNull();
    });

    it('allows git branch -a (list all)', () => {
      expect(findDeniedOp('branch', ['-a'])).toBeNull();
    });

    it('blocks git reset --hard', () => {
      expect(findDeniedOp('reset', ['--hard'])).not.toBeNull();
    });

    it('allows git reset --soft', () => {
      expect(findDeniedOp('reset', ['--soft', 'HEAD~1'])).toBeNull();
    });

    it('allows git reset (mixed)', () => {
      expect(findDeniedOp('reset', ['HEAD~1'])).toBeNull();
    });

    it('blocks git clean -f', () => {
      expect(findDeniedOp('clean', ['-f'])).not.toBeNull();
    });

    it('blocks git clean -fdx', () => {
      expect(findDeniedOp('clean', ['-fdx'])).not.toBeNull();
    });

    it('blocks git stash pop', () => {
      expect(findDeniedOp('stash', ['pop'])).not.toBeNull();
    });

    it('blocks git stash apply', () => {
      expect(findDeniedOp('stash', ['apply'])).not.toBeNull();
    });

    it('allows git stash push', () => {
      expect(findDeniedOp('stash', ['push'])).toBeNull();
    });

    it('allows git stash list', () => {
      expect(findDeniedOp('stash', ['list'])).toBeNull();
    });

    it('blocks git push --force', () => {
      expect(findDeniedOp('push', ['--force'])).not.toBeNull();
    });

    it('blocks git push -f', () => {
      expect(findDeniedOp('push', ['-f', 'origin', 'main'])).not.toBeNull();
    });

    it('allows git push (normal)', () => {
      expect(findDeniedOp('push', ['origin', 'task/T1118'])).toBeNull();
    });

    it('blocks git worktree add', () => {
      expect(findDeniedOp('worktree', ['add', '/some/path'])).not.toBeNull();
    });

    it('blocks git worktree remove', () => {
      expect(findDeniedOp('worktree', ['remove', '/some/path'])).not.toBeNull();
    });

    it('allows git worktree list', () => {
      expect(findDeniedOp('worktree', ['list'])).toBeNull();
    });
  });

  describe('always-allowed subcommands', () => {
    const allowed = [
      ['status', []],
      ['log', ['--oneline']],
      ['diff', ['HEAD~1']],
      ['show', ['HEAD']],
      ['add', ['.']],
      ['commit', ['-m', 'message']],
      ['fetch', ['origin']],
      ['ls-files', []],
      ['rev-parse', ['HEAD']],
      ['cat-file', ['-p', 'HEAD:file.ts']],
    ] as const;

    for (const [sub, args] of allowed) {
      it(`allows git ${sub}`, () => {
        expect(findDeniedOp(sub, [...args])).toBeNull();
      });
    }
  });
});

describe('push to a protected branch (T13522)', () => {
  it('denies a push whose destination is main or master, in every refspec spelling', () => {
    for (const args of [
      ['origin', 'main'],
      ['origin', 'HEAD:main'],
      ['origin', 'task/T1:refs/heads/main'],
      ['-u', 'origin', '+master'],
    ]) {
      expect(findDeniedOp('push', args)?.subcommand).toBe('push');
    }
  });

  it('allows pushing a task branch, and names the offending refspec', () => {
    expect(findDeniedOp('push', ['-u', 'origin', 'task/T13522'])).toBeNull();
    expect(findDeniedOp('push', ['origin', 'main-fix'])).toBeNull();
    expect(protectedPushRefspec(['origin', 'HEAD:main'])).toBe('HEAD:main');
    // the first positional is the remote, never a destination
    expect(protectedPushRefspec(['main'])).toBeNull();
  });
});

describe('every-ref pushes and global options (T13533)', () => {
  it('denies push --all and --mirror in any position', () => {
    for (const args of [
      ['--all'],
      ['origin', '--all'],
      ['--mirror', 'origin'],
      ['-u', '--all', 'origin'],
    ]) {
      expect(findDeniedOp('push', args)?.subcommand).toBe('push');
    }
  });

  it('finds the subcommand after global options, so they cannot hide a denied push', () => {
    expect(splitGitArgv(['-C', '.', 'push', 'origin', 'main'])).toEqual({
      global: ['-C', '.'],
      subcommand: 'push',
      args: ['origin', 'main'],
      unknownGlobal: null,
    });
    expect(splitGitArgv(['-c', 'k=v', '--no-pager', 'push', '--all'])).toEqual({
      global: ['-c', 'k=v', '--no-pager'],
      subcommand: 'push',
      args: ['--all'],
      unknownGlobal: null,
    });
    expect(splitGitArgv(['--git-dir', '/x/.git', 'status'])).toEqual({
      global: ['--git-dir', '/x/.git'],
      subcommand: 'status',
      args: [],
      unknownGlobal: null,
    });
    // An option the parser does not know is reported, so the shim can fail closed.
    expect(splitGitArgv(['--future-opt', 'HEAD', 'push', '--all']).unknownGlobal).toBe(
      '--future-opt',
    );
    expect(splitGitArgv(['--git-dir=/x/.git', 'push']).unknownGlobal).toBeNull();
    expect(splitGitArgv([])).toEqual({
      global: [],
      subcommand: undefined,
      args: [],
      unknownGlobal: null,
    });
  });

  it('refuses a pattern destination and sees past --attr-source (T13535)', () => {
    expect(findDeniedOp('push', ['origin', 'refs/heads/*:refs/heads/*'])?.subcommand).toBe('push');
    expect(splitGitArgv(['--attr-source', 'HEAD', 'push', '--all', 'origin']).subcommand).toBe(
      'push',
    );
  });

  it('reads protected destinations from a porcelain dry run', () => {
    const out = [
      'To /tmp/remote.git',
      '*\trefs/heads/task/T1:refs/heads/task/T1\t[new branch]',
      '=\trefs/heads/x:refs/heads/main\t[up to date]',
      '-\t:refs/heads/master\t[deleted]',
      'Done',
    ].join('\n');
    expect(protectedPorcelainDestinations(out)).toEqual(['refs/heads/main', 'refs/heads/master']);
    expect(porcelainDestinations(out)).toEqual([
      'refs/heads/task/T1',
      'refs/heads/main',
      'refs/heads/master',
    ]);
    expect(
      protectedPorcelainDestinations('To /r\n*\trefs/heads/a:refs/heads/a\t[new branch]\n'),
    ).toEqual([]);
  });
});
