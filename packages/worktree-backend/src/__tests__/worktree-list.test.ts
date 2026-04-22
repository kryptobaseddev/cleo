/**
 * Tests for worktree listing operations.
 *
 * These tests do not require a real git repository. They test the filesystem
 * scanning logic directly.
 *
 * @task T1161
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listWorktrees, resolveWorktreeRoot } from '../worktree-list.js';

describe('resolveWorktreeRoot', () => {
  it('uses explicit override when provided', () => {
    const root = resolveWorktreeRoot('abc123def4567890', '/my/explicit/root');
    expect(root).toBe('/my/explicit/root');
  });

  it('returns path containing the project hash', () => {
    const hash = 'deadbeef12345678';
    const root = resolveWorktreeRoot(hash);
    expect(root).toContain(hash);
    expect(root).toContain('worktrees');
  });
});

describe('listWorktrees', () => {
  it('returns empty array when worktrees base does not exist', () => {
    const originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = '/nonexistent/path-that-does-not-exist';
    try {
      const entries = listWorktrees();
      expect(entries).toEqual([]);
    } finally {
      if (originalCleoHome === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = originalCleoHome;
      }
    }
  });

  it('returns entries from worktrees directory structure', () => {
    const base = join(tmpdir(), `list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hash = 'abc123def4567890';
    const worktreeDir = join(base, 'worktrees', hash, 'T9999');
    mkdirSync(worktreeDir, { recursive: true });

    const originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = base;

    try {
      // listWorktrees will try git on the dir; we filter by projectHash so it finds T9999
      const entries = listWorktrees({ projectHash: hash });
      // The entry should be there but branch may be null (not a real git worktree)
      const found = entries.find((e) => e.taskId === 'T9999');
      expect(found).toBeDefined();
      expect(found?.path).toBe(worktreeDir);
      expect(found?.projectHash).toBe(hash);
    } finally {
      if (originalCleoHome === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = originalCleoHome;
      }
      rmSync(base, { recursive: true });
    }
  });

  it('filters by projectHash when provided', () => {
    const base = join(tmpdir(), `list-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hashA = 'aaaa1111bbbb2222';
    const hashB = 'cccc3333dddd4444';
    mkdirSync(join(base, 'worktrees', hashA, 'T1000'), { recursive: true });
    mkdirSync(join(base, 'worktrees', hashB, 'T2000'), { recursive: true });

    const originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = base;

    try {
      const entries = listWorktrees({ projectHash: hashA });
      expect(entries.every((e) => e.projectHash === hashA)).toBe(true);
      // Should NOT include hashB entries
      expect(entries.find((e) => e.taskId === 'T2000')).toBeUndefined();
    } finally {
      if (originalCleoHome === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = originalCleoHome;
      }
      rmSync(base, { recursive: true });
    }
  });
});
