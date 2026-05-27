/**
 * Regression suite for T9961 — `getDb()` direct-caller worktree-isolation guard.
 *
 * T9806 added the worktree-isolation guard inside `openCleoDb('tasks', cwd)`,
 * but only ~28 callers route through it. T9961 extracts the guard into
 * `worktree-isolation-guard.ts` and calls it from `getDb()` directly, so all
 * ~61 direct callers (tasks.find / tasks.show / tasks.list domain handlers)
 * benefit automatically.
 *
 * This test exercises the `getDb()` path directly — verifying the guard fires
 * for callers that never touch `openCleoDb`.
 *
 * @task T9961
 * @see T9806 for the `openCleoDb` side (open-cleo-db-worktree-guard.test.ts)
 * @saga T9800
 * @decision D009
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDbState } from '../sqlite.js';

/**
 * Create a temp directory that simulates a git worktree containing a leaked
 * `.cleo/` directory (pre-T9803 install artifact).
 *
 * Structure:
 *   <dir>/
 *     .git          ← FILE (gitlink, not a directory) — worktree marker
 *     .cleo/
 *       project-info.json
 */
function makeWorktreeFixture(label: string): string {
  const dir = join(
    tmpdir(),
    `cleo-t9961-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  // Write `.git` as a FILE (gitlink) — simulates a `git worktree add` checkout.
  writeFileSync(join(dir, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/t9961\n');
  // Write a `.cleo/` directory + project-info.json so path resolution (T9803)
  // succeeds and we exercise the T9806/T9961 guard layer.
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'wt-fixture-t9961-leaked' }),
  );
  return dir;
}

function snapshotEnv(): { restore: () => void } {
  const saved = process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'];
  return {
    restore() {
      if (saved === undefined) delete process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'];
      else process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] = saved;
    },
  };
}

describe('getDb() — worktree-isolation guard via direct caller path (T9961 / D009)', () => {
  let tempDir: string | undefined;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ restore: restoreEnv } = snapshotEnv());
    delete process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'];
    tempDir = undefined;
    // Reset the sqlite singleton so each test starts fresh
    resetDbState();
  });

  afterEach(() => {
    restoreEnv();
    resetDbState();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  describe('AC-1: getDb() throws E_WT_DB_ISOLATION_VIOLATION for worktree-resident opens', () => {
    it('throws when .cleo/ parent is a worktree (gitlink .git file)', async () => {
      tempDir = makeWorktreeFixture('direct-caller');
      await expect(getDb(tempDir)).rejects.toThrowError(/E_WT_DB_ISOLATION_VIOLATION/);
    });

    it('error message names the tasks role', async () => {
      tempDir = makeWorktreeFixture('role-label');
      const err = await getDb(tempDir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/tasks/);
    });
  });

  describe('AC-2: kill-switch CLEO_ALLOW_WORKTREE_DB_CREATE=1 bypasses guard', () => {
    it('does NOT throw E_WT_DB_ISOLATION_VIOLATION when override is set', async () => {
      tempDir = makeWorktreeFixture('override');
      process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] = '1';
      // The open may still fail for other reasons (migrations in a bare temp
      // dir), but it MUST NOT fail with the T9806/T9961 isolation-violation.
      const result = await getDb(tempDir).then(
        () => null as Error | null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      if (result instanceof Error) {
        expect(result.message).not.toMatch(/E_WT_DB_ISOLATION_VIOLATION/);
      }
      // If result is null, the DB opened successfully — no isolation error fired.
    });

    it('non-"1" values do NOT bypass the guard', async () => {
      tempDir = makeWorktreeFixture('override-bad');
      process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] = 'true'; // not literally '1'
      await expect(getDb(tempDir)).rejects.toThrowError(/E_WT_DB_ISOLATION_VIOLATION/);
    });
  });

  describe('AC-3: canonical project root (dir .git) is NOT blocked', () => {
    it('does not throw for a normal project with .git as a directory', async () => {
      // A real project directory has `.git` as a directory, not a gitlink file.
      // We cannot easily run the full getDb() in a temp dir (needs migrations),
      // but we can confirm the guard logic only activates on gitlink files.
      // Tested indirectly: if this test file runs at all from this repo (which
      // has `.git` as a directory), the singleton was already opened without
      // the guard firing.
      //
      // Explicit assertion: assertDbPathIsNotWorktreeResident with a dir .git
      // must not throw.
      const { assertDbPathIsNotWorktreeResident } = await import('../worktree-isolation-guard.js');
      // Use process.cwd() — in this repo, .git is a real directory.
      expect(() => assertDbPathIsNotWorktreeResident('tasks')).not.toThrow();
    });
  });
});
