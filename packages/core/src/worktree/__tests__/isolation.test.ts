/**
 * Unit tests for the centralized worktree isolation utility (T1759 + T1851).
 *
 * Tests cover:
 *  - Deterministic env+preamble output for given inputs
 *  - ISOLATION_ENV_KEYS canonical list
 *  - BoundaryContract shape
 *  - cwd equals worktreePath (not projectRoot)
 *  - T1851 regression: validateAbsolutePath rejects paths outside worktree root
 *
 * @task T1759
 * @task T1851
 */

import { describe, expect, it } from 'vitest';
import { ISOLATION_ENV_KEYS, provisionIsolatedShell, validateAbsolutePath } from '../isolation.js';

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

    it('absolutePathRules.allowedPrefixes includes the worktree root', () => {
      const { boundaryContract } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(boundaryContract.absolutePathRules.allowedPrefixes).toContain(
        SAMPLE_OPTS.worktreePath,
      );
    });

    it('absolutePathRules.deniedOutsideWorktree is true by default', () => {
      const { boundaryContract } = provisionIsolatedShell(SAMPLE_OPTS);
      expect(boundaryContract.absolutePathRules.deniedOutsideWorktree).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// T1851 regression — validateAbsolutePath
// ---------------------------------------------------------------------------

/**
 * These tests assert the P0 isolation fix (T1851) that closes the bypass
 * vector from T1763.
 *
 * T1763 reproduction: a worker used Edit/Write with the absolute path
 *   /mnt/projects/cleocode/.cleo/rcasd/T1763/file.md
 * while its worktreeRoot was
 *   /home/keatonhoskins/.local/share/cleo/worktrees/<hash>/T1763
 *
 * The git-shim could NOT catch this because it only intercepts `git` binary
 * calls. validateAbsolutePath is the new enforcement layer that fills that gap.
 */

const T1763_WORKTREE = '/home/keatonhoskins/.local/share/cleo/worktrees/abc123/T1763';

describe('validateAbsolutePath (T1851 regression)', () => {
  const { boundaryContract } = provisionIsolatedShell({
    worktreePath: T1763_WORKTREE,
    branch: 'task/T1763',
    role: 'worker',
    projectHash: 'abc123',
  });

  // -------------------------------------------------------------------------
  // Rejection cases (reproduces the T1763 breach)
  // -------------------------------------------------------------------------

  it('rejects absolute paths outside the worktree (T1763 breach vector)', () => {
    const result = validateAbsolutePath(
      '/mnt/projects/cleocode/.cleo/rcasd/T1763/file.md',
      boundaryContract,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejection result carries E_BOUNDARY_VIOLATION code', () => {
    const result = validateAbsolutePath(
      '/mnt/projects/cleocode/.cleo/rcasd/T1763/file.md',
      boundaryContract,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('E_BOUNDARY_VIOLATION');
    }
  });

  it('rejection message contains the offending path', () => {
    const offendingPath = '/mnt/projects/cleocode/.cleo/rcasd/T1763/file.md';
    const result = validateAbsolutePath(offendingPath, boundaryContract);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain(offendingPath);
    }
  });

  it('rejection message contains the worktreeRoot', () => {
    const result = validateAbsolutePath('/mnt/projects/cleocode/src/index.ts', boundaryContract);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain(T1763_WORKTREE);
    }
  });

  it('rejects /tmp paths when not in allowedPrefixes', () => {
    const result = validateAbsolutePath('/tmp/evil-script.sh', boundaryContract);
    expect(result.allowed).toBe(false);
  });

  it('rejects a path that shares a common prefix but differs by suffix', () => {
    // Prefix-extension attack: T1763-extra must NOT match prefix T1763
    const result = validateAbsolutePath(
      '/home/keatonhoskins/.local/share/cleo/worktrees/abc123/T1763-extra/file.ts',
      boundaryContract,
    );
    expect(result.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Allowed cases
  // -------------------------------------------------------------------------

  it('allows paths inside the worktree root', () => {
    const result = validateAbsolutePath(
      `${T1763_WORKTREE}/packages/core/src/index.ts`,
      boundaryContract,
    );
    expect(result.allowed).toBe(true);
  });

  it('allows the worktree root itself (exact match)', () => {
    const result = validateAbsolutePath(T1763_WORKTREE, boundaryContract);
    expect(result.allowed).toBe(true);
  });

  it('allows a nested subdirectory of the worktree', () => {
    const result = validateAbsolutePath(
      `${T1763_WORKTREE}/packages/contracts/src/branch-lock.ts`,
      boundaryContract,
    );
    expect(result.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Opt-out behaviour (orchestrator role with deniedOutsideWorktree=false)
  // -------------------------------------------------------------------------

  it('allows any path when deniedOutsideWorktree is false (orchestrator opt-out)', () => {
    const orchContract = provisionIsolatedShell({
      worktreePath: T1763_WORKTREE,
      branch: 'task/T1763',
      role: 'orchestrator',
      projectHash: 'abc123',
    }).boundaryContract;

    // Manually override the flag — simulates the orchestrator opt-out scenario.
    const loosened = {
      ...orchContract,
      absolutePathRules: {
        ...orchContract.absolutePathRules,
        deniedOutsideWorktree: false,
      },
    };

    const result = validateAbsolutePath('/mnt/projects/cleocode/src/index.ts', loosened);
    expect(result.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional allowed prefixes
  // -------------------------------------------------------------------------

  it('allows paths under an extra prefix added to allowedPrefixes', () => {
    const extended = {
      ...boundaryContract,
      absolutePathRules: {
        ...boundaryContract.absolutePathRules,
        allowedPrefixes: [
          ...boundaryContract.absolutePathRules.allowedPrefixes,
          '/tmp/ci-artefacts',
        ],
      },
    };
    const result = validateAbsolutePath('/tmp/ci-artefacts/report.json', extended);
    expect(result.allowed).toBe(true);
  });

  it('still rejects paths outside any of the allowed prefixes even when extras are present', () => {
    const extended = {
      ...boundaryContract,
      absolutePathRules: {
        ...boundaryContract.absolutePathRules,
        allowedPrefixes: [
          ...boundaryContract.absolutePathRules.allowedPrefixes,
          '/tmp/ci-artefacts',
        ],
      },
    };
    const result = validateAbsolutePath('/etc/passwd', extended);
    expect(result.allowed).toBe(false);
  });
});
