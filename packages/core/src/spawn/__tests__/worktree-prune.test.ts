/**
 * Tests for pruneWorktree — single-task worktree cleanup (T1462 / P1-6).
 *
 * Strategy: mock `execFileSync` and the `node:fs` functions so the tests
 * do NOT need a real git repository or real filesystem worktree directories.
 * All assertions are on the returned PruneWorktreeResult.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before all imports)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// Spy on fs — we'll mock existsSync / rmSync / appendFileSync selectively.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    appendFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (must come after vi.mock declarations)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { pruneWorktree } from '../branch-lock.js';

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockRmSync = vi.mocked(rmSync);
const mockAppendFileSync = vi.mocked(appendFileSync);

const PROJECT_ROOT = '/fake/project';

// ---------------------------------------------------------------------------
// Git mock helper
// ---------------------------------------------------------------------------

/**
 * Configure execFileSync to respond to git sub-commands with predictable
 * outputs. Each option controls the return value for a specific git call.
 */
function setupGitMock(options: {
  revParseTopLevel?: string | null;
  statusOutput?: string;
  branchListOutput?: string;
  aheadLogOutput?: string;
  worktreeRemoveFails?: boolean;
}) {
  mockExecFileSync.mockImplementation((...args: Parameters<typeof execFileSync>) => {
    const [cmd, argv] = args as [string, string[]];
    if (cmd !== 'git') return '' as unknown as ReturnType<typeof execFileSync>;

    const sub = argv[0];

    if (sub === 'rev-parse' && argv.includes('--show-toplevel')) {
      if (options.revParseTopLevel === null) throw new Error('not a git repo');
      return (options.revParseTopLevel ?? PROJECT_ROOT) as unknown as ReturnType<
        typeof execFileSync
      >;
    }
    if (sub === 'rev-parse' && argv.includes('--abbrev-ref')) {
      return 'main' as unknown as ReturnType<typeof execFileSync>;
    }
    if (sub === 'status') {
      return (options.statusOutput ?? '') as unknown as ReturnType<typeof execFileSync>;
    }
    if (sub === 'branch' && argv.includes('--list')) {
      return (options.branchListOutput ?? '') as unknown as ReturnType<typeof execFileSync>;
    }
    if (sub === 'log') {
      return (options.aheadLogOutput ?? '') as unknown as ReturnType<typeof execFileSync>;
    }
    if (sub === 'worktree' && argv[1] === 'remove') {
      if (options.worktreeRemoveFails) throw new Error('worktree remove failed');
      return '' as unknown as ReturnType<typeof execFileSync>;
    }
    // All other git calls succeed silently
    return '' as unknown as ReturnType<typeof execFileSync>;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruneWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // No worktree present
  // -------------------------------------------------------------------------

  describe('when worktree directory does not exist', () => {
    it('returns status=skipped and skips rmSync', () => {
      mockExistsSync.mockReturnValue(false);
      setupGitMock({ branchListOutput: '' });

      const result = pruneWorktree('T9001', PROJECT_ROOT);

      expect(result.status).toBe('skipped');
      expect(result.taskId).toBe('T9001');
      expect(result.worktreeRemoved).toBe(false);
      expect(mockRmSync).not.toHaveBeenCalled();
    });

    it('still deletes a stale branch when the directory is already gone', () => {
      mockExistsSync.mockReturnValue(false);
      // branch --list returns non-empty → branch exists
      setupGitMock({ branchListOutput: 'task/T9001' });

      const result = pruneWorktree('T9001', PROJECT_ROOT);

      expect(result.status).toBe('skipped');
      expect(result.branchDeleted).toBe(true);
    });

    it('marks branchDeleted=true even when there is no branch to delete', () => {
      mockExistsSync.mockReturnValue(false);
      setupGitMock({ branchListOutput: '' });

      const result = pruneWorktree('T9001', PROJECT_ROOT);

      expect(result.branchDeleted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — worktree exists and is clean
  // -------------------------------------------------------------------------

  describe('when worktree exists and is clean', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('returns status=pruned after successful removal', () => {
      setupGitMock({ statusOutput: '', branchListOutput: '', aheadLogOutput: '' });

      const result = pruneWorktree('T9002', PROJECT_ROOT);

      expect(result.status).toBe('pruned');
      expect(result.taskId).toBe('T9002');
      expect(result.worktreeRemoved).toBe(true);
      expect(result.wasDirty).toBe(false);
    });

    it('deletes the branch when it has 0 commits ahead of HEAD', () => {
      setupGitMock({
        statusOutput: '',
        branchListOutput: 'task/T9002',
        aheadLogOutput: '',
      });

      const result = pruneWorktree('T9002', PROJECT_ROOT);

      expect(result.branchDeleted).toBe(true);
    });

    it('leaves the branch when it has commits ahead of HEAD', () => {
      setupGitMock({
        statusOutput: '',
        branchListOutput: 'task/T9003',
        aheadLogOutput: 'abc123\ndef456',
      });

      const result = pruneWorktree('T9003', PROJECT_ROOT);

      expect(result.branchDeleted).toBe(false);
      // The worktree itself is still removed
      expect(result.worktreeRemoved).toBe(true);
    });

    it('falls back to rmSync when git worktree remove fails', () => {
      setupGitMock({
        statusOutput: '',
        branchListOutput: '',
        aheadLogOutput: '',
        worktreeRemoveFails: true,
      });

      const result = pruneWorktree('T9004', PROJECT_ROOT);

      expect(mockRmSync).toHaveBeenCalled();
      expect(result.status).toBe('pruned');
      expect(result.worktreeRemoved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Dirty worktree — audit log
  // -------------------------------------------------------------------------

  describe('when worktree is dirty', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
    });

    it('marks wasDirty=true', () => {
      setupGitMock({ statusOutput: 'M  src/foo.ts', branchListOutput: '' });

      const result = pruneWorktree('T9005', PROJECT_ROOT);

      expect(result.wasDirty).toBe(true);
      expect(result.status).toBe('pruned');
    });

    it('writes an audit log entry when dirty', () => {
      setupGitMock({ statusOutput: 'M  src/foo.ts', branchListOutput: '' });

      pruneWorktree('T9006', PROJECT_ROOT, { auditLogPath: '/tmp/test-audit.jsonl' });

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        '/tmp/test-audit.jsonl',
        expect.stringContaining('"action":"force-remove-dirty"'),
        'utf-8',
      );
    });

    it('does NOT write an audit log entry when clean', () => {
      setupGitMock({ statusOutput: '', branchListOutput: '' });

      pruneWorktree('T9007', PROJECT_ROOT, { auditLogPath: '/tmp/test-audit.jsonl' });

      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns status=error when the directory is not a git repo', () => {
      mockExistsSync.mockReturnValue(false);
      setupGitMock({ revParseTopLevel: null });

      const result = pruneWorktree('T9008', '/not-a-repo');

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/Not a git repo/);
    });

    it('returns status=error when both git remove and rmSync fail', () => {
      mockExistsSync.mockReturnValue(true);
      setupGitMock({ statusOutput: '', branchListOutput: '', worktreeRemoveFails: true });
      mockRmSync.mockImplementation(() => {
        throw new Error('rmSync also failed');
      });

      const result = pruneWorktree('T9009', PROJECT_ROOT);

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/Failed to remove worktree/);
      expect(result.worktreeRemoved).toBe(false);
    });
  });
});
