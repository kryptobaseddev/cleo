/**
 * Unit tests for `forceUnlockWorktree` (T9547).
 *
 * Covers:
 *  - Worktree located → `.git/index.lock` removed when present.
 *  - Worktree located → `git worktree unlock` runs when porcelain reports locked.
 *  - Worktree located, no lock state → success no-op with both flags false.
 *  - Worktree NOT located → engineError('E_WORKTREE_NOT_FOUND').
 *  - Uncommitted changes detected → warn-only, never touches working tree.
 *  - Audit-log entry shape (timestamp, actor, action, target, taskId, success).
 *  - listWorktrees error propagation.
 *
 * @task T9547
 * @epic T9515
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeInfo } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const MOCK_LIST: { value: WorktreeInfo[]; success: boolean; errorMsg: string } = {
  value: [],
  success: true,
  errorMsg: '',
};

vi.mock('../list.js', () => ({
  listWorktrees: vi.fn(async () => {
    if (!MOCK_LIST.success) {
      return {
        success: false,
        error: { code: 'E_GIT_FAILED', message: MOCK_LIST.errorMsg },
      };
    }
    return {
      success: true,
      data: { worktrees: MOCK_LIST.value },
    };
  }),
}));

// Track every git invocation; allow test to seed git-dir return + status state.
const execCalls: Array<{ argv: readonly string[] }> = [];
const execReturns: Map<string, string> = new Map();
const execThrowKeys: Set<string> = new Set();
let statusOutput = '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((_cmd: string, args?: readonly string[]) => {
      const argv = (args ?? []) as readonly string[];
      execCalls.push({ argv });
      const key = argv.join(' ');
      if (execThrowKeys.has(key)) {
        throw new Error(`mock: refused ${key}`);
      }
      if (argv[0] === 'status' && argv[1] === '--porcelain') {
        return statusOutput as never;
      }
      if (execReturns.has(key)) {
        return execReturns.get(key) as never;
      }
      return '' as never;
    }),
  };
});

import {
  detectUncommittedChanges,
  forceUnlockWorktree,
  resolveIndexLockCandidates,
} from '../force-unlock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktreeInfo(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: overrides.path ?? '/tmp/wt/T1',
    branch: overrides.branch ?? 'task/T1',
    taskId: overrides.taskId ?? 'T1',
    owningAgent: overrides.owningAgent ?? null,
    lastActivity: overrides.lastActivity ?? new Date().toISOString(),
    isLocked: overrides.isLocked ?? false,
    isStale: overrides.isStale ?? false,
    isMerged: overrides.isMerged ?? false,
    owningTaskStatus: overrides.owningTaskStatus ?? null,
    statusCategory: overrides.statusCategory ?? 'active',
  };
}

let projectRoot: string;
let auditLogPath: string;
let worktreePath: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-t9547-unlock-'));
  worktreePath = join(projectRoot, 'wt-T1');
  auditLogPath = join(projectRoot, 'audit.jsonl');
  MOCK_LIST.value = [];
  MOCK_LIST.success = true;
  MOCK_LIST.errorMsg = '';
  execCalls.length = 0;
  execReturns.clear();
  execThrowKeys.clear();
  statusOutput = '';
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* tmpdir cleanup best-effort */
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// detectUncommittedChanges
// ---------------------------------------------------------------------------

describe('detectUncommittedChanges', () => {
  it('returns true when status --porcelain prints lines', () => {
    statusOutput = ' M file.ts\n';
    expect(detectUncommittedChanges('/tmp/wt')).toBe(true);
  });

  it('returns false when status --porcelain is empty', () => {
    statusOutput = '';
    expect(detectUncommittedChanges('/tmp/wt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveIndexLockCandidates
// ---------------------------------------------------------------------------

describe('resolveIndexLockCandidates', () => {
  it('always includes the in-worktree .git/index.lock path', () => {
    const out = resolveIndexLockCandidates('/wt/T1');
    expect(out).toContain('/wt/T1/.git/index.lock');
  });

  it('appends the admin path returned by rev-parse --git-dir (absolute)', () => {
    execReturns.set('rev-parse --git-dir', '/repo/.git/worktrees/T1\n');
    const out = resolveIndexLockCandidates('/wt/T1');
    expect(out).toContain('/repo/.git/worktrees/T1/index.lock');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('forceUnlockWorktree — happy path', () => {
  it('removes .git/index.lock when present', async () => {
    // Set up a real worktree-like dir with a stale index.lock under .git/.
    const gitDir = join(worktreePath, '.git');
    rmSync(worktreePath, { recursive: true, force: true });
    // mkdir tree
    const fs = await import('node:fs');
    fs.mkdirSync(gitDir, { recursive: true });
    const indexLock = join(gitDir, 'index.lock');
    writeFileSync(indexLock, '');

    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: worktreePath,
        branch: 'task/T9547',
        taskId: 'T9547',
        isLocked: false,
      }),
    ];

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
      auditLogPath,
      actor: 'unit-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.indexLockRemoved).toBe(true);
    expect(result.data.worktreeUnlocked).toBe(false);
    expect(existsSync(indexLock)).toBe(false);

    // Audit log present.
    const auditContent = readFileSync(auditLogPath, 'utf-8');
    const entry = JSON.parse(auditContent.trim()) as Record<string, unknown>;
    expect(entry['action']).toBe('force-unlock');
    expect(entry['taskId']).toBe('T9547');
    expect(entry['actor']).toBe('unit-test');
    expect(entry['success']).toBe(true);
  });

  it('runs git worktree unlock when porcelain reports the worktree is locked', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: worktreePath,
        branch: 'task/T9547',
        taskId: 'T9547',
        isLocked: true,
      }),
    ];

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
      auditLogPath,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.worktreeUnlocked).toBe(true);

    const unlockCalls = execCalls.filter((c) => c.argv[0] === 'worktree' && c.argv[1] === 'unlock');
    expect(unlockCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('warns but does not delete uncommitted changes', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: worktreePath,
        branch: 'task/T9547',
        taskId: 'T9547',
      }),
    ];
    statusOutput = ' M src/index.ts\n';

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
      auditLogPath,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.hadUncommittedChanges).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('forceUnlockWorktree — edge cases', () => {
  it('returns E_WORKTREE_NOT_FOUND when no worktree matches the task ID', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({ path: '/wt/T9000', branch: 'task/T9000', taskId: 'T9000' }),
    ];

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
      auditLogPath,
      actor: 'unit-test',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_WORKTREE_NOT_FOUND');

    // Audit entry still recorded for the failed attempt.
    const auditContent = readFileSync(auditLogPath, 'utf-8');
    const entry = JSON.parse(auditContent.trim()) as Record<string, unknown>;
    expect(entry['success']).toBe(false);
    expect(entry['action']).toBe('force-unlock');
  });

  it('propagates upstream listWorktrees failure', async () => {
    MOCK_LIST.success = false;
    MOCK_LIST.errorMsg = 'fatal: not a git repository';

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_GIT_FAILED');
  });

  it('no-op success when worktree is found but has no lock state', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: worktreePath,
        branch: 'task/T9547',
        taskId: 'T9547',
        isLocked: false,
      }),
    ];

    const result = await forceUnlockWorktree({
      projectRoot,
      taskId: 'T9547',
      auditLogPath,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.indexLockRemoved).toBe(false);
    expect(result.data.worktreeUnlocked).toBe(false);
    expect(result.data.success).toBe(true);
  });
});
