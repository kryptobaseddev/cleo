/**
 * Tests for @cleocode/worktree path resolution utilities.
 *
 * @task T1161
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from '../paths.js';

describe('computeProjectHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = computeProjectHash('/some/project/root');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns consistent hashes for the same input', () => {
    const a = computeProjectHash('/mnt/projects/myapp');
    const b = computeProjectHash('/mnt/projects/myapp');
    expect(a).toBe(b);
  });

  it('returns different hashes for different paths', () => {
    const a = computeProjectHash('/mnt/projects/app-a');
    const b = computeProjectHash('/mnt/projects/app-b');
    expect(a).not.toBe(b);
  });
});

describe('resolveWorktreeRootForHash', () => {
  const originalCleoHome = process.env['CLEO_HOME'];

  afterEach(() => {
    if (originalCleoHome === undefined) {
      delete process.env['CLEO_HOME'];
    } else {
      process.env['CLEO_HOME'] = originalCleoHome;
    }
  });

  it('uses CLEO_HOME override when set', () => {
    process.env['CLEO_HOME'] = '/custom/cleo-home';
    const root = resolveWorktreeRootForHash('abc123def456789a');
    expect(root).toBe('/custom/cleo-home/worktrees/abc123def456789a');
  });

  it('uses explicit worktreeRoot override over everything else', () => {
    process.env['CLEO_HOME'] = '/custom/cleo-home';
    const root = resolveWorktreeRootForHash('abc123def456789a', '/explicit/override');
    expect(root).toBe('/explicit/override');
  });

  it('includes the project hash in the path', () => {
    const hash = 'deadbeef12345678';
    const root = resolveWorktreeRootForHash(hash, '/test/base');
    // With explicit override, just uses that path
    expect(root).toBe('/test/base');
  });

  it('includes the project hash when using env-paths fallback', () => {
    delete process.env['CLEO_HOME'];
    const hash = 'abc123def4567890';
    const root = resolveWorktreeRootForHash(hash);
    expect(root).toContain('worktrees');
    expect(root).toContain(hash);
  });
});

describe('resolveTaskWorktreePath', () => {
  it('appends taskId to the worktree root', () => {
    const path = resolveTaskWorktreePath('abc123', 'T1234', '/base/worktrees/abc123');
    expect(path).toBe('/base/worktrees/abc123/T1234');
  });

  it('uses hash + taskId segments', () => {
    const path = resolveTaskWorktreePath('hash16charslong', 'T9999', '/root');
    expect(path).toBe('/root/T9999');
  });
});
