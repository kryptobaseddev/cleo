/**
 * The foreign-store preflight in worktree listing (T14440, census AC3).
 *
 * The census (and any caller) lists other projects' worktrees; task-status
 * enrichment opens each project's store. A store whose journal holds rows
 * this build does not know was written by a newer, unreleased build, and the
 * listing must degrade to `owningTaskStatus: null` instead of opening it.
 *
 * Only the store, the migration probe and git are mocked; the classification
 * logic runs for real.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

const MOCK_TASK_ROWS = new Map<string, string>();
vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  getDb: vi.fn(async () => ({}) as never),
  getNativeTasksDb: vi.fn(
    () =>
      ({
        prepare: () => ({
          all: (...ids: string[]) =>
            ids
              .filter((id) => MOCK_TASK_ROWS.has(id))
              .map((id) => ({ id, status: MOCK_TASK_ROWS.get(id) })),
        }),
      }) as never,
  ),
}));

const aheadOfBuild = vi.fn<(projectRoot: string) => 'ok' | 'ahead' | 'unreadable'>(() => 'ok');
vi.mock('../../doctor/migrations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../doctor/migrations.js')>()),
  projectStoreAheadOfBuild: (...args: Parameters<typeof aheadOfBuild>) => aheadOfBuild(...args),
}));

import { listWorktrees } from '../list.js';

const mockExec = vi.mocked(execFileSync);

/** One porcelain worktree entry. */
function porcelain(entry: { path: string; branch: string }): string {
  return `worktree ${entry.path}\nHEAD sha-${entry.branch}\nbranch refs/heads/${entry.branch}\n`;
}

beforeEach(() => {
  MOCK_TASK_ROWS.clear();
  MOCK_TASK_ROWS.set('T1', 'done');
  aheadOfBuild.mockImplementation(() => 'ok');
  mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
    const argv = (args ?? []) as readonly string[];
    if (argv[0] === 'worktree' && argv[1] === 'list')
      return `${porcelain({ path: '/p/wt', branch: 'task/T1' })}\n` as never;
    if (argv[0] === 'rev-list' && argv[1] === '--first-parent') return 'sha-main\n' as never;
    if (argv[0] === 'log' && argv[1] === '-1') return '2026-11-10T00:00:00.000Z\n' as never;
    if (argv[0] === 'merge-base' && argv[1] === '--is-ancestor') {
      const err = new Error('not an ancestor');
      throw err;
    }
    if (argv[0] === 'rev-parse' && argv[1] === '--verify') return '' as never;
    if (argv[0] === 'rev-parse' && argv.includes('--git-common-dir'))
      throw new Error('no common dir');
    throw new Error(`unexpected git call: ${argv.join(' ')}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('foreign-store preflight (T14440 AC3)', () => {
  it('enriches task status when the foreign store is at or behind this build', async () => {
    aheadOfBuild.mockImplementation(() => 'ok');
    const out = await listWorktrees({ projectRoot: '/p' });
    if (!out.success) throw new Error(out.error?.message ?? 'listing failed');
    expect(out.data.worktrees[0]?.owningTaskStatus).toBe('done');
  });

  it('degrades to owningTaskStatus null when the store was written by a newer build', async () => {
    aheadOfBuild.mockImplementation(() => 'ahead');
    const out = await listWorktrees({ projectRoot: '/p' });
    if (!out.success) throw new Error(out.error?.message ?? 'listing failed');
    expect(out.data.worktrees[0]?.owningTaskStatus).toBeNull();
    expect(out.data.worktrees[0]?.taskId).toBe('T1'); // the listing itself is unaffected
  });

  it('the probe is asked once per listing, with the project root', async () => {
    await listWorktrees({ projectRoot: '/p' });
    expect(aheadOfBuild).toHaveBeenCalledWith('/p');
  });
});
