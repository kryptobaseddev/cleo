import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetCleoPlatformPathsCache, getCleoHome } from '../cleo-paths.js';
import {
  computeProjectHash,
  getCleoWorktreesRoot,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from '../worktree-paths.js';

describe('worktree-paths', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = '/test/cleo-home';
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
    _resetCleoPlatformPathsCache();
  });

  it('computeProjectHash returns 16 lowercase hex chars', () => {
    const hash = computeProjectHash('/mnt/projects/cleocode');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toHaveLength(16);
  });

  it('computeProjectHash is deterministic for the same input', () => {
    const a = computeProjectHash('/some/project/root');
    const b = computeProjectHash('/some/project/root');
    expect(a).toBe(b);
  });

  it('computeProjectHash differs for different inputs', () => {
    const a = computeProjectHash('/project/a');
    const b = computeProjectHash('/project/b');
    expect(a).not.toBe(b);
  });

  it('T14126: a linked worktree hashes as the main checkout that owns it', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'paths-t14126-')));
    try {
      const main = join(base, 'project');
      mkdirSync(main);
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
      git(main, 'init', '-q', '-b', 'main');
      git(
        main,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@e.x',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'i',
      );
      const wt = join(base, 'worktrees', 'c0bc20de146ccd00', 'T1');
      git(main, 'worktree', 'add', '-q', wt);
      const ownHash = createHash('sha256').update(wt).digest('hex').slice(0, 16);
      expect(computeProjectHash(wt)).not.toBe(ownHash);
      expect(computeProjectHash(wt)).toBe(computeProjectHash(main));
      // A gitlink that is not a linked worktree (a submodule) hashes as itself.
      const sub = join(base, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, '.git'), `gitdir: ${join(main, '.git', 'modules', 'sub')}\n`);
      expect(computeProjectHash(sub)).toBe(
        createHash('sha256').update(sub).digest('hex').slice(0, 16),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolveWorktreeRootForHash builds <cleoHome>/worktrees/<hash>', () => {
    const hash = 'a'.repeat(16);
    expect(resolveWorktreeRootForHash(hash)).toBe(`${getCleoHome()}/worktrees/${hash}`);
  });

  it('resolveWorktreeRootForHash honours explicit override', () => {
    expect(resolveWorktreeRootForHash('xxxx', '/custom/wtr')).toBe('/custom/wtr');
  });

  it('resolveTaskWorktreePath appends taskId', () => {
    const hash = 'b'.repeat(16);
    expect(resolveTaskWorktreePath(hash, 'T9999')).toBe(`${getCleoHome()}/worktrees/${hash}/T9999`);
  });

  it('getCleoWorktreesRoot returns <cleoHome>/worktrees', () => {
    expect(getCleoWorktreesRoot()).toBe(`${getCleoHome()}/worktrees`);
  });
});
