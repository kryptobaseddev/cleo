/**
 * Tests for the cleo-git-shim denylist (T1118 L2).
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
import { RESTRICTED_ROLES, findDeniedOp } from '../denylist.js';

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
