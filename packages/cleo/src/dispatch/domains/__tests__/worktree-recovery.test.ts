/**
 * Focused dispatch wiring tests for worktree adopt recovery (T10457).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const adoptWorktreeMock = vi.hoisted(() => vi.fn());
const recoverPartialWorktreeMock = vi.hoisted(() => vi.fn());

vi.mock('@cleocode/core/internal', () => ({
  adoptWorktree: adoptWorktreeMock,
  destroyWorktree: vi.fn(),
  forceUnlockWorktree: vi.fn(),
  getLogger: vi.fn(() => ({ error: vi.fn() })),
  getProjectRoot: vi.fn(() => '/repo'),
  listWorktrees: vi.fn(),
  pruneOrphanedWorktreesByStatus: vi.fn(),
  recoverPartialWorktree: recoverPartialWorktreeMock,
}));

import { WorktreeHandler } from '../worktree.js';

describe('WorktreeHandler adopt recovery wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adoptWorktreeMock.mockResolvedValue({
      success: true,
      data: {
        path: '/repo/.claude/worktrees/session-abc',
        branch: 'task/T10457',
        taskId: 'T10457',
        source: 'claude-agent',
        isNew: true,
        adoptedAt: '2026-05-25T00:00:00.000Z',
      },
    });
    recoverPartialWorktreeMock.mockReturnValue({
      success: true,
      actions: ['pnpm-install', 'unlock-git-index'],
      signals: {
        hasUncommittedChanges: false,
        nodeModulesMissing: true,
        indexLockPresent: true,
        worktreeExists: true,
      },
    });
  });

  it('runs recovery after a successful adopt when recover=true', async () => {
    const handler = new WorktreeHandler();

    const response = await handler.mutate('adopt', {
      worktreePath: '/repo/.claude/worktrees/session-abc',
      source: 'claude-agent',
      taskId: 'T10457',
      recover: true,
    });

    expect(adoptWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/repo',
        worktreePath: '/repo/.claude/worktrees/session-abc',
        source: 'claude-agent',
        taskId: 'T10457',
      }),
    );
    expect(recoverPartialWorktreeMock).toHaveBeenCalledWith(
      '/repo',
      '/repo/.claude/worktrees/session-abc',
      'T10457',
    );
    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      taskId: 'T10457',
      recovery: { success: true, actions: ['pnpm-install', 'unlock-git-index'] },
    });
  });
});
