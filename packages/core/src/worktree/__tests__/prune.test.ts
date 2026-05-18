/**
 * Unit tests for `pruneOrphanedWorktreesByStatus` (T9547).
 *
 * Covers:
 *  - Happy path: orphan + merged candidates are pruned, branch deleted on merged.
 *  - --dry-run: returns the candidate set with `pruned=false` and writes no audit.
 *  - --paths filter: the SDK only acts on the CLI-confirmed subset.
 *  - Empty listing: zero candidates → success with `prunedCount=0`.
 *  - reasonForStatus: maps every statusCategory to a stable audit label.
 *  - Audit log: each successful prune appends one JSONL entry with the
 *    documented shape (timestamp, actor, action, target, branch, taskId,
 *    reason, success).
 *  - listWorktrees error propagation: an upstream failure surfaces through.
 *
 * @task T9547
 * @epic T9515
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// Capture every execFileSync call so we can assert which git commands ran
// without spawning real git or touching any worktrees.
const execCalls: Array<{ args: readonly string[]; throwError?: Error }> = [];
const execShouldThrow: Set<string> = new Set();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((_cmd: string, args?: readonly string[]) => {
      const argv = (args ?? []) as readonly string[];
      execCalls.push({ args: argv });
      const key = argv.join(' ');
      if (execShouldThrow.has(key)) {
        throw new Error(`mock: refused ${key}`);
      }
      return '' as never;
    }),
  };
});

// rmSync mock — let the fallback worktree-removal path succeed without I/O.
// `existsSync` is kept REAL so dry-run assertions on the audit file work.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(() => {}),
  };
});

import { pruneOrphanedWorktreesByStatus, reasonForStatus } from '../prune.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorktreeInfo(overrides: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: overrides.path ?? '/wt/T1',
    branch: overrides.branch ?? 'task/T1',
    taskId: overrides.taskId ?? 'T1',
    owningAgent: overrides.owningAgent ?? null,
    lastActivity: overrides.lastActivity ?? new Date().toISOString(),
    isLocked: overrides.isLocked ?? false,
    isStale: overrides.isStale ?? false,
    isMerged: overrides.isMerged ?? false,
    owningTaskStatus: overrides.owningTaskStatus ?? null,
    statusCategory: overrides.statusCategory ?? 'orphan',
  };
}

let projectRoot: string;
let auditLogPath: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-t9547-prune-'));
  auditLogPath = join(projectRoot, 'audit.jsonl');
  MOCK_LIST.value = [];
  MOCK_LIST.success = true;
  MOCK_LIST.errorMsg = '';
  execCalls.length = 0;
  execShouldThrow.clear();
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
// reasonForStatus
// ---------------------------------------------------------------------------

describe('reasonForStatus', () => {
  it('returns orphan-cancelled when task is cancelled', () => {
    expect(
      reasonForStatus(
        makeWorktreeInfo({
          statusCategory: 'orphan',
          owningTaskStatus: 'cancelled',
        }),
      ),
    ).toBe('orphan-cancelled');
  });

  it('returns orphan-missing-task when taskId present but no row', () => {
    expect(
      reasonForStatus(
        makeWorktreeInfo({
          statusCategory: 'orphan',
          taskId: 'T999',
          owningTaskStatus: null,
        }),
      ),
    ).toBe('orphan-missing-task');
  });

  it('returns orphaned-merged for merged status', () => {
    expect(reasonForStatus(makeWorktreeInfo({ statusCategory: 'merged' }))).toBe('orphaned-merged');
  });

  it('passes through other categories', () => {
    expect(reasonForStatus(makeWorktreeInfo({ statusCategory: 'stale' }))).toBe('stale');
    expect(reasonForStatus(makeWorktreeInfo({ statusCategory: 'locked' }))).toBe('locked');
    expect(reasonForStatus(makeWorktreeInfo({ statusCategory: 'active' }))).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('pruneOrphanedWorktreesByStatus — happy path', () => {
  it('prunes orphan + merged worktrees and writes audit entries', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: '/wt/T100',
        branch: 'task/T100',
        taskId: 'T100',
        statusCategory: 'orphan',
        owningTaskStatus: 'cancelled',
      }),
      makeWorktreeInfo({
        path: '/wt/T200',
        branch: 'task/T200',
        taskId: 'T200',
        statusCategory: 'merged',
        isMerged: true,
      }),
      makeWorktreeInfo({
        path: '/wt/T300',
        branch: 'task/T300',
        taskId: 'T300',
        statusCategory: 'active',
      }),
    ];

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot,
      auditLogPath,
      actor: 'unit-test',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');

    expect(result.data.prunedCount).toBe(2);
    expect(result.data.outcomes).toHaveLength(2);
    expect(result.data.outcomes.map((o) => o.path).sort()).toEqual(['/wt/T100', '/wt/T200']);
    const mergedOutcome = result.data.outcomes.find((o) => o.path === '/wt/T200');
    expect(mergedOutcome?.branchDeleted).toBe(true);
    expect(mergedOutcome?.reason).toBe('orphaned-merged');
    const orphanOutcome = result.data.outcomes.find((o) => o.path === '/wt/T100');
    expect(orphanOutcome?.reason).toBe('orphan-cancelled');

    // Audit log: one line per pruned worktree.
    const auditContent = readFileSync(auditLogPath, 'utf-8');
    const lines = auditContent.trim().split('\n');
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const e of entries) {
      expect(e['actor']).toBe('unit-test');
      expect(e['action']).toBe('prune');
      expect(e['success']).toBe(true);
      expect(typeof e['timestamp']).toBe('string');
    }
  });

  it('respects --dry-run: no audit log + no filesystem actions', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: '/wt/T100',
        branch: 'task/T100',
        taskId: 'T100',
        statusCategory: 'orphan',
        owningTaskStatus: 'cancelled',
      }),
    ];

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot,
      auditLogPath,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.prunedCount).toBe(0);
    expect(result.data.skippedCount).toBe(1);
    expect(result.data.outcomes[0]?.pruned).toBe(false);
    expect(result.data.dryRun).toBe(true);

    // No git removal calls, no audit log file written.
    const removeCalls = execCalls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCalls).toHaveLength(0);
    expect(existsSync(auditLogPath)).toBe(false);
  });

  it('filters by opts.paths so only the CLI-confirmed subset is pruned', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: '/wt/T100',
        branch: 'task/T100',
        taskId: 'T100',
        statusCategory: 'orphan',
      }),
      makeWorktreeInfo({
        path: '/wt/T200',
        branch: 'task/T200',
        taskId: 'T200',
        statusCategory: 'merged',
        isMerged: true,
      }),
    ];

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot,
      auditLogPath,
      paths: ['/wt/T200'],
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.outcomes).toHaveLength(1);
    expect(result.data.outcomes[0]?.path).toBe('/wt/T200');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('pruneOrphanedWorktreesByStatus — edge cases', () => {
  it('returns prunedCount=0 when no orphans exist', async () => {
    MOCK_LIST.value = [
      makeWorktreeInfo({ path: '/wt/T1', statusCategory: 'active' }),
      makeWorktreeInfo({ path: '/wt/T2', statusCategory: 'stale' }),
    ];

    const result = await pruneOrphanedWorktreesByStatus({ projectRoot, auditLogPath });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.prunedCount).toBe(0);
    expect(result.data.outcomes).toHaveLength(0);
  });

  it('propagates an upstream listWorktrees failure', async () => {
    MOCK_LIST.success = false;
    MOCK_LIST.errorMsg = 'not a git repo';

    const result = await pruneOrphanedWorktreesByStatus({ projectRoot, auditLogPath });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_GIT_FAILED');
    expect(result.error.message).toContain('not a git repo');
  });

  it('records error outcomes when git removal AND rmSync both fail', async () => {
    // Create a real path inside the tmpdir so the fallback existsSync() check
    // resolves to true and the function attempts rmSync (which we mock to throw).
    const fs = await import('node:fs');
    const targetPath = join(projectRoot, 'wt-error');
    fs.mkdirSync(targetPath, { recursive: true });

    MOCK_LIST.value = [
      makeWorktreeInfo({
        path: targetPath,
        branch: 'task/T100',
        taskId: 'T100',
        statusCategory: 'orphan',
      }),
    ];
    // Make `git worktree remove --force <path>` fail so we hit the rmSync fallback.
    execShouldThrow.add(`worktree remove --force ${targetPath}`);
    // Force rmSync to throw — primary failure path under test.
    vi.mocked(fs.rmSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await pruneOrphanedWorktreesByStatus({
      projectRoot,
      auditLogPath,
      actor: 'unit-test',
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected envelope success');
    expect(result.data.prunedCount).toBe(0);
    expect(result.data.errors).toHaveLength(1);
    expect(result.data.errors[0]?.path).toBe(targetPath);

    // Audit entry MUST exist for the failed attempt with success:false.
    const auditContent = readFileSync(auditLogPath, 'utf-8');
    const entry = JSON.parse(auditContent.trim()) as Record<string, unknown>;
    expect(entry['success']).toBe(false);
    expect(typeof entry['error']).toBe('string');
  });
});
