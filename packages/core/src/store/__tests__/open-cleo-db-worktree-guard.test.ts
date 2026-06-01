/**
 * Regression suite for T9806 — DB chokepoint refuses worktree-resident opens.
 *
 * Defense-in-depth on top of T9803. T9803 stops NEW orphan-`.cleo/` synthesis
 * at the path-resolution layer; T9806 stops re-use of OLD leaked `.cleo/`
 * directories that already exist inside worktrees from pre-T9803 installs.
 *
 * @task T9806
 * @saga T9800
 * @decision D009
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleoDb } from '../open-cleo-db.js';

function makeWorktreeFixture(label: string, gitContent: string): string {
  const dir = join(
    tmpdir(),
    `cleo-t9806-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  // Write `.git` as a FILE (gitlink) — simulates a `git worktree add` checkout.
  writeFileSync(join(dir, '.git'), gitContent);
  // Write a `.cleo/` directory + project-info.json so the path resolution
  // path-layer (T9803) succeeds and we exercise the T9806 guard layer.
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'wt-fixture-leaked' }),
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

describe('openCleoDb — worktree-isolation guard (T9806 / D009)', () => {
  let tempDir: string | undefined;
  let restoreEnv: () => void;

  beforeEach(() => {
    ({ restore: restoreEnv } = snapshotEnv());
    delete process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'];
    tempDir = undefined;
  });

  afterEach(() => {
    restoreEnv();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // E6-L6 (T11526): the legacy 8-role API was removed. The project-scope
  // consolidated `cleo.db` (formerly tasks/brain/conduit/sessions) is guarded
  // by cwd; the global-scope `cleo.db` (formerly nexus/signaldock/skills)
  // resolves from getCleoHome() and is intentionally NOT cwd-guarded.
  describe('AC-1: refuses open when .cleo/ parent is a worktree gitlink (project scope)', () => {
    it('throws E_WT_DB_ISOLATION_VIOLATION for role=project inside worktree', async () => {
      tempDir = makeWorktreeFixture(
        'project-refuse',
        'gitdir: /tmp/some-main/.git/worktrees/foo\n',
      );
      await expect(openCleoDb('project', tempDir)).rejects.toThrowError(
        /E_WT_DB_ISOLATION_VIOLATION/,
      );
    });
  });

  describe('AC-2: kill-switch CLEO_ALLOW_WORKTREE_DB_CREATE=1 bypasses guard', () => {
    it('does NOT throw E_WT_DB_ISOLATION_VIOLATION when override is set', async () => {
      tempDir = makeWorktreeFixture('override', 'gitdir: /tmp/some-main/.git/worktrees/override\n');
      process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] = '1';
      // Open may still fail for other reasons (DB modules not initialised in
      // a temp dir without migrations), but it must NOT fail with the
      // T9806-specific isolation-violation error.
      const errorPromise = openCleoDb('project', tempDir)
        .then(() => null as Error | null)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      const err = await errorPromise;
      if (err) {
        expect(err.message).not.toMatch(/E_WT_DB_ISOLATION_VIOLATION/);
      }
    });

    it('non-"1" values do NOT bypass the guard', async () => {
      tempDir = makeWorktreeFixture('override-bad', 'gitdir: /tmp/some-main/.git/worktrees/bad\n');
      process.env['CLEO_ALLOW_WORKTREE_DB_CREATE'] = 'true'; // not literally '1'
      await expect(openCleoDb('project', tempDir)).rejects.toThrowError(
        /E_WT_DB_ISOLATION_VIOLATION/,
      );
    });
  });

  describe('AC-3: global scope (formerly nexus/signaldock/skills) NOT cwd-guarded', () => {
    it('global open is allowed inside a worktree (global home path)', async () => {
      tempDir = makeWorktreeFixture('global-allow', 'gitdir: /tmp/some-main/.git/worktrees/sd\n');
      // The global cleo.db opens against ~/.local/share/cleo/cleo.db regardless
      // of cwd; the worktree guard intentionally skips it.
      const errorPromise = openCleoDb('global', tempDir)
        .then(() => null as Error | null)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      const err = await errorPromise;
      if (err) {
        expect(err.message).not.toMatch(/E_WT_DB_ISOLATION_VIOLATION/);
      }
    });
  });
});
