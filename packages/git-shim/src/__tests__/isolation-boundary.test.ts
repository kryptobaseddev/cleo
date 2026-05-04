/**
 * Tests for the T1761 isolation boundary check in the git-shim.
 *
 * Verifies:
 * - `isCwdInsideWorktree` correctly identifies in/out-of-boundary paths.
 * - `evaluateIsolationBoundary` fires ONLY for:
 *     - CLEO_AGENT_ROLE=worker
 *     - CLEO_WORKTREE_ROOT set to an absolute path
 *     - A mutation subcommand (add, commit, rm, mv, restore, apply, am)
 *     - cwd outside CLEO_WORKTREE_ROOT
 * - The check is skipped for non-worker roles (lead, subagent, orchestrator).
 * - The check is skipped when CLEO_WORKTREE_ROOT is absent.
 * - The check is skipped for read-only subcommands (log, status, diff).
 * - The check passes when cwd equals the worktree root or is a descendant.
 * - Drift detection: `ISOLATION_ENV_KEYS` from `@cleocode/contracts` contains
 *   exactly the two keys consumed by `evaluateIsolationBoundary`
 *   (`CLEO_WORKTREE_ROOT` and `CLEO_AGENT_ROLE`), so a schema change in
 *   contracts will cause this test to fail loudly.
 *
 * @task T1761
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISOLATION_ENV_KEYS } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateIsolationBoundary, isCwdInsideWorktree } from '../isolation-boundary.js';

// ---------------------------------------------------------------------------
// Environment management
// ---------------------------------------------------------------------------

const ENV_KEYS_UNDER_TEST = [
  'CLEO_AGENT_ROLE',
  'CLEO_WORKTREE_ROOT',
  'XDG_DATA_HOME',
  'CLEO_AUDIT_LOG_PATH',
];
const savedEnv: Record<string, string | undefined> = {};

let workspace: string;

beforeEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) savedEnv[key] = process.env[key];
  workspace = mkdtempSync(join(tmpdir(), 'cleo-git-shim-T1761-'));
  process.env['XDG_DATA_HOME'] = workspace;
  process.env['CLEO_AUDIT_LOG_PATH'] = join(workspace, 'audit', 'git-shim.jsonl');
});

afterEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    const v = savedEnv[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isCwdInsideWorktree — pure path helper
// ---------------------------------------------------------------------------

describe('isCwdInsideWorktree', () => {
  it('returns true when cwd equals the worktree root', () => {
    expect(isCwdInsideWorktree('/home/user/wt/T1761', '/home/user/wt/T1761')).toBe(true);
  });

  it('returns true when cwd is a direct child of the worktree root', () => {
    expect(isCwdInsideWorktree('/home/user/wt/T1761/packages', '/home/user/wt/T1761')).toBe(true);
  });

  it('returns true when cwd is a deeply nested descendant', () => {
    expect(
      isCwdInsideWorktree('/home/user/wt/T1761/packages/core/src', '/home/user/wt/T1761'),
    ).toBe(true);
  });

  it('returns false when cwd is the parent of the worktree root', () => {
    expect(isCwdInsideWorktree('/home/user/wt', '/home/user/wt/T1761')).toBe(false);
  });

  it('returns false when cwd is a sibling worktree', () => {
    expect(isCwdInsideWorktree('/home/user/wt/T1760', '/home/user/wt/T1761')).toBe(false);
  });

  it('returns false when cwd is the project root (main repo)', () => {
    expect(isCwdInsideWorktree('/mnt/projects/cleocode', '/home/user/wt/T1761')).toBe(false);
  });

  it('returns false when cwd shares a prefix but is not a descendant', () => {
    // "/home/user/wt/T1761extra" should NOT match "/home/user/wt/T1761"
    expect(isCwdInsideWorktree('/home/user/wt/T1761extra', '/home/user/wt/T1761')).toBe(false);
  });

  it('handles trailing slash on worktreeRoot gracefully', () => {
    // resolve() strips trailing slashes — both should behave identically
    expect(isCwdInsideWorktree('/home/user/wt/T1761/sub', '/home/user/wt/T1761/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateIsolationBoundary — env-driven logic
// ---------------------------------------------------------------------------

describe('evaluateIsolationBoundary', () => {
  const worktreeRoot = '/home/user/.local/share/cleo/worktrees/abc123/T1761';
  const outsideCwd = '/mnt/projects/cleocode';

  /**
   * Helper: spy on process.cwd() to return a synthetic value.
   */
  function mockCwd(path: string) {
    return vi.spyOn(process, 'cwd').mockReturnValue(path);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- worker + mutation subcommands + outside worktree = BLOCKED ----------------

  it('blocks git add when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);

    const result = evaluateIsolationBoundary('add');
    expect(result).not.toBeNull();
    expect(result?.code).toBe('E_GIT_BOUNDARY_CWD_OUTSIDE_WORKTREE');
    expect(result?.boundary).toBe('isolation');
    expect(result?.context['cwd']).toBe(outsideCwd);
    expect(result?.context['worktree_root']).toBe(worktreeRoot);
  });

  it('blocks git commit when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);

    const result = evaluateIsolationBoundary('commit');
    expect(result).not.toBeNull();
    expect(result?.code).toBe('E_GIT_BOUNDARY_CWD_OUTSIDE_WORKTREE');
  });

  it('blocks git rm when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('rm')).not.toBeNull();
  });

  it('blocks git mv when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('mv')).not.toBeNull();
  });

  it('blocks git restore when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('restore')).not.toBeNull();
  });

  it('blocks git apply when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('apply')).not.toBeNull();
  });

  it('blocks git am when worker cwd is outside CLEO_WORKTREE_ROOT', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('am')).not.toBeNull();
  });

  // -- cwd inside worktree = allowed -------------------------------------------

  it('allows git add when worker cwd equals the worktree root', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(worktreeRoot);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  it('allows git add when worker cwd is a subdirectory of worktree root', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(`${worktreeRoot}/packages/core/src`);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  // -- non-worker roles = skip check -------------------------------------------

  it('skips check when CLEO_AGENT_ROLE=lead', () => {
    process.env['CLEO_AGENT_ROLE'] = 'lead';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  it('skips check when CLEO_AGENT_ROLE=subagent', () => {
    process.env['CLEO_AGENT_ROLE'] = 'subagent';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  it('skips check when CLEO_AGENT_ROLE=orchestrator', () => {
    process.env['CLEO_AGENT_ROLE'] = 'orchestrator';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  it('skips check when CLEO_AGENT_ROLE is absent', () => {
    delete process.env['CLEO_AGENT_ROLE'];
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  // -- CLEO_WORKTREE_ROOT absent = skip check ----------------------------------

  it('skips check when CLEO_WORKTREE_ROOT is not set', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    delete process.env['CLEO_WORKTREE_ROOT'];
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  it('skips check when CLEO_WORKTREE_ROOT is empty string', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = '';
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('add')).toBeNull();
  });

  // -- read-only subcommands = skip check --------------------------------------

  it('skips check for git log (read-only)', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('log')).toBeNull();
  });

  it('skips check for git status (read-only)', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('status')).toBeNull();
  });

  it('skips check for git diff (read-only)', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('diff')).toBeNull();
  });

  it('skips check for git show (read-only)', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);
    expect(evaluateIsolationBoundary('show')).toBeNull();
  });

  // -- error message content ---------------------------------------------------

  it('includes cwd, worktree_root, and role in the violation context', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);

    const result = evaluateIsolationBoundary('commit');
    expect(result?.context).toMatchObject({
      cwd: outsideCwd,
      worktree_root: worktreeRoot,
      role: 'worker',
    });
  });

  it('message mentions the subcommand and outside-worktree context', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);

    const result = evaluateIsolationBoundary('add');
    expect(result?.message).toContain('git add');
    expect(result?.message).toContain('outside');
    expect(result?.message).toContain('worktree');
  });

  it('remediation mentions CLEO_ALLOW_GIT=1', () => {
    process.env['CLEO_AGENT_ROLE'] = 'worker';
    process.env['CLEO_WORKTREE_ROOT'] = worktreeRoot;
    mockCwd(outsideCwd);

    const result = evaluateIsolationBoundary('add');
    expect(result?.remediation).toContain('CLEO_ALLOW_GIT=1');
  });
});

// ---------------------------------------------------------------------------
// Drift detection — ISOLATION_ENV_KEYS must cover the vars this file uses
// ---------------------------------------------------------------------------

describe('drift detection: ISOLATION_ENV_KEYS alignment', () => {
  it('ISOLATION_ENV_KEYS includes CLEO_WORKTREE_ROOT', () => {
    expect(ISOLATION_ENV_KEYS).toContain('CLEO_WORKTREE_ROOT');
  });

  it('ISOLATION_ENV_KEYS includes CLEO_AGENT_ROLE', () => {
    expect(ISOLATION_ENV_KEYS).toContain('CLEO_AGENT_ROLE');
  });

  it('evaluateIsolationBoundary uses ISOLATION_ENV_KEYS[0] for CLEO_WORKTREE_ROOT and ISOLATION_ENV_KEYS[1] for CLEO_AGENT_ROLE', () => {
    // This test encodes the positional expectations so that if the const tuple
    // order changes in @cleocode/contracts, this test fails loudly — forcing a
    // corresponding update in shim.ts.
    expect(ISOLATION_ENV_KEYS[0]).toBe('CLEO_WORKTREE_ROOT');
    expect(ISOLATION_ENV_KEYS[1]).toBe('CLEO_AGENT_ROLE');
  });

  it('ISOLATION_ENV_KEYS has no unknown keys relative to GitShimEnv interface', () => {
    // GitShimEnv documents the env vars consumed by the shim as a whole.
    // ISOLATION_ENV_KEYS is the subset injected by provisionIsolatedShell.
    // All ISOLATION_ENV_KEYS must be a subset of the documented GitShimEnv keys.
    const knownShimEnvKeys = new Set([
      'CLEO_AGENT_ROLE',
      'CLEO_ALLOW_BRANCH_OPS',
      'CLEO_WORKTREE_ROOT',
      'CLEO_BRANCH_PROTECTION',
      'CLEO_WORKTREE_BRANCH',
      'CLEO_PROJECT_HASH',
    ]);
    for (const key of ISOLATION_ENV_KEYS) {
      expect(knownShimEnvKeys.has(key)).toBe(true);
    }
  });
});
