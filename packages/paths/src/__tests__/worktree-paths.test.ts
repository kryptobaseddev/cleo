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
