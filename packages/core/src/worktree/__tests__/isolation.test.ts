/**
 * Unit tests for the centralized worktree isolation utility (T1759).
 *
 * Tests cover:
 *  - Deterministic env+preamble output for given inputs
 *  - ISOLATION_ENV_KEYS canonical list
 *  - BoundaryContract shape
 *  - cwd equals worktreePath (not projectRoot)
 *
 * @task T1759
 */

import { describe, expect, it } from 'vitest';
import { ISOLATION_ENV_KEYS, provisionIsolatedShell } from '../isolation.js';

const SAMPLE_OPTS = {
  worktreePath: '/home/user/.local/share/cleo/worktrees/abc123/T1759',
  branch: 'task/T1759',
  role: 'worker' as const,
  projectHash: 'abc123def456',
};

describe('ISOLATION_ENV_KEYS', () => {
  it('contains the four canonical env keys', () => {
    expect(ISOLATION_ENV_KEYS).toEqual([
      'CLEO_WORKTREE_ROOT',
      'CLEO_AGENT_ROLE',
      'CLEO_WORKTREE_BRANCH',
      'CLEO_PROJECT_HASH',
    ]);
  });

  it('is a readonly tuple (length 4)', () => {
    expect(ISOLATION_ENV_KEYS).toHaveLength(4);
  });
});

describe('provisionIsolatedShell', () => {
  describe('cwd', () => {
    it('returns worktreePath as cwd, not projectRoot', () => {
      const result = provisionIsolatedShell(SAMPLE_OPTS);
      expect(result.cwd).toBe(SAMPLE_OPTS.worktreePath);
    });

    it('cwd equals worktreePath exactly', () => {
      const path = '/tmp/test-worktree/T9999';
      const result = provisionIsolatedShell({ ...SAMPLE_OPTS, worktreePath: path });
      expect(result.cwd).toBe(path);
      expect(result.cwd).not.toContain('/mnt/projects');
    });
  });

  describe('env', () => {
    it('returns all four canonical env vars', () => {
      const { env } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(env.CLEO_WORKTREE_ROOT).toBe(SAMPLE_OPTS.worktreePath);
      expect(env.CLEO_AGENT_ROLE).toBe('worker');
      expect(env.CLEO_WORKTREE_BRANCH).toBe(SAMPLE_OPTS.branch);
      expect(env.CLEO_PROJECT_HASH).toBe(SAMPLE_OPTS.projectHash);
    });

    it('env keys exactly match ISOLATION_ENV_KEYS', () => {
      const { env } = provisionIsolatedShell(SAMPLE_OPTS);
      const envKeys = Object.keys(env).sort();
      const canonicalKeys = [...ISOLATION_ENV_KEYS].sort();
      expect(envKeys).toEqual(canonicalKeys);
    });

    it('outputs orchestrator role when role=orchestrator', () => {
      const { env } = provisionIsolatedShell({ ...SAMPLE_OPTS, role: 'orchestrator' });
      expect(env.CLEO_AGENT_ROLE).toBe('orchestrator');
    });

    it('is deterministic — same inputs produce same output', () => {
      const a = provisionIsolatedShell(SAMPLE_OPTS);
      const b = provisionIsolatedShell(SAMPLE_OPTS);
      expect(a.env).toEqual(b.env);
      expect(a.cwd).toBe(b.cwd);
      expect(a.preamble).toBe(b.preamble);
    });

    it('each call returns a fresh env object (mutation isolation)', () => {
      const a = provisionIsolatedShell(SAMPLE_OPTS);
      const b = provisionIsolatedShell(SAMPLE_OPTS);
      // Mutating one result must not affect the other
      a.env.CLEO_AGENT_ROLE = 'mutated' as 'worker' | 'orchestrator';
      expect(b.env.CLEO_AGENT_ROLE).toBe('worker');
    });
  });

  describe('preamble', () => {
    it('contains the worktreePath in the cd command', () => {
      const { preamble } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(preamble).toContain(`cd "${SAMPLE_OPTS.worktreePath}" || exit 1`);
    });

    it('contains export for all isolation env keys', () => {
      const { preamble } = provisionIsolatedShell(SAMPLE_OPTS);
      for (const key of ISOLATION_ENV_KEYS) {
        expect(preamble).toContain(`export ${key}=`);
      }
    });

    it('contains the pwd guard case statement', () => {
      const { preamble } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(preamble).toContain('case "$PWD" in');
      expect(preamble).toContain('exit 1');
    });

    it('contains the section heading', () => {
      const { preamble } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(preamble).toContain('## Worktree Isolation');
    });

    it('ends with a trailing newline', () => {
      const { preamble } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(preamble).toMatch(/\n$/);
    });
  });

  describe('boundaryContract', () => {
    it('has worktreeRoot equal to worktreePath', () => {
      const { boundaryContract } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(boundaryContract.worktreeRoot).toBe(SAMPLE_OPTS.worktreePath);
    });

    it('has role matching the input', () => {
      const workerResult = provisionIsolatedShell({ ...SAMPLE_OPTS, role: 'worker' });
      const orchResult = provisionIsolatedShell({ ...SAMPLE_OPTS, role: 'orchestrator' });
      expect(workerResult.boundaryContract.role).toBe('worker');
      expect(orchResult.boundaryContract.role).toBe('orchestrator');
    });

    it('envKeys references the canonical ISOLATION_ENV_KEYS', () => {
      const { boundaryContract } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(boundaryContract.envKeys).toBe(ISOLATION_ENV_KEYS);
    });
  });
});
