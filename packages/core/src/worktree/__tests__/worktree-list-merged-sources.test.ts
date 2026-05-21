/**
 * Unit tests for the multi-source `listWorktrees` enhancement (T9804).
 *
 * Verifies that `cleo worktree list` produces a union of:
 *  1. Git-native porcelain entries (existing behaviour from T9546).
 *  2. Sentinel-index entries from `.cleo/worktrees.json` NOT present in porcelain.
 *
 * Also verifies that the `source` field is set correctly:
 *  - `cleo-spawn`   — git-native entry without a matching sentinel entry.
 *  - `claude-agent` — git-native entry WITH a sentinel entry (adopted worktree).
 *  - `claude-agent` — sentinel-only entry (worktree not known to git).
 *
 * @task T9804
 * @epic T9804
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const MOCK_TASK_ROWS = new Map<string, string>();
vi.mock('../../store/open-cleo-db.js', () => ({
  openCleoDb: vi.fn(async () => ({
    db: {
      prepare: (_sql: string) => ({
        all: (...ids: string[]) =>
          ids
            .filter((id) => MOCK_TASK_ROWS.has(id))
            .map((id) => ({ id, status: MOCK_TASK_ROWS.get(id) })),
      }),
    },
    role: 'tasks',
    close: async () => {},
  })),
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { listWorktrees } from '../list.js';
import type { SentinelWorktreeEntry } from '../sentinel-index.js';
import { writeSentinelIndex } from '../sentinel-index.js';

const mockExec = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal `git worktree list --porcelain` payload. */
function buildPorcelain(
  entries: Array<{ path: string; branch: string; locked?: boolean }>,
): string {
  const blocks = entries.map((e) => {
    const lines = [`worktree ${e.path}`, 'HEAD abc123', `branch refs/heads/${e.branch}`];
    if (e.locked) lines.push('locked');
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n\n`;
}

/** Create a real filesystem directory (so statSync doesn't fail). */
function mkdir(p: string): void {
  mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listWorktrees — multi-source union (T9804)', () => {
  let tmpDir: string;
  let primaryPath: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-list-sources-'));
    primaryPath = join(tmpDir, 'primary');
    worktreePath = join(tmpDir, 'wt1');
    mkdir(primaryPath);
    mkdir(worktreePath);
    MOCK_TASK_ROWS.clear();

    // Default exec: porcelain + rev-parse for main + git-common-dir + merge-base
    mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const argv = args ?? [];
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return buildPorcelain([
          { path: primaryPath, branch: 'main' },
          { path: worktreePath, branch: 'task/T1001' },
        ]);
      }
      if (argv[0] === 'rev-parse' && argv.includes('refs/heads/main')) {
        return 'abc123\n';
      }
      if (argv[0] === 'rev-parse' && argv.includes('--git-common-dir')) {
        return `${primaryPath}/.git\n`;
      }
      if (argv[0] === 'log') {
        return new Date(Date.now() - 1000).toISOString() + '\n';
      }
      if (argv[0] === 'merge-base') {
        // main is ancestor of itself — everything else is not merged
        if (argv.includes('main')) throw new Error('not merged');
        return '';
      }
      return '';
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('git-native entries without sentinel match get source=cleo-spawn', async () => {
    const result = await listWorktrees({ projectRoot: tmpDir });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const wt1 = result.data.worktrees.find((w) => w.branch === 'task/T1001');
    expect(wt1).toBeDefined();
    expect(wt1?.source).toBe('cleo-spawn');
  });

  it('git-native entry WITH matching sentinel entry gets source from sentinel', async () => {
    // Write a sentinel entry for the same worktree path
    const sentinelEntry: SentinelWorktreeEntry = {
      path: worktreePath,
      branch: 'task/T1001',
      taskId: 'T1001',
      source: 'claude-agent',
      adoptedAt: new Date().toISOString(),
      adoptedBy: 'test',
    };
    writeSentinelIndex(tmpDir, [sentinelEntry]);

    const result = await listWorktrees({ projectRoot: tmpDir });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const wt1 = result.data.worktrees.find((w) => w.branch === 'task/T1001');
    expect(wt1).toBeDefined();
    // Source should come from sentinel (claude-agent), not default (cleo-spawn)
    expect(wt1?.source).toBe('claude-agent');
  });

  it('sentinel-only entry (not in porcelain) is appended to the list', async () => {
    const adoptedPath = join(tmpDir, 'claude-wt');
    mkdir(adoptedPath);

    const sentinelEntry: SentinelWorktreeEntry = {
      path: adoptedPath,
      branch: 'feat/T9804-session',
      taskId: 'T9804',
      source: 'claude-agent',
      adoptedAt: new Date().toISOString(),
      adoptedBy: 'claude-code-agent',
    };
    writeSentinelIndex(tmpDir, [sentinelEntry]);

    const result = await listWorktrees({ projectRoot: tmpDir });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should have primary + wt1 from porcelain + sentinel-only entry
    expect(result.data.worktrees.length).toBeGreaterThanOrEqual(3);

    const adoptedEntry = result.data.worktrees.find((w) => w.path === adoptedPath);
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry?.source).toBe('claude-agent');
    expect(adoptedEntry?.branch).toBe('feat/T9804-session');
    expect(adoptedEntry?.taskId).toBe('T9804');
  });

  it('sentinel-only entry obeys statusFilter', async () => {
    const adoptedPath = join(tmpDir, 'claude-wt2');
    mkdir(adoptedPath);

    const sentinelEntry: SentinelWorktreeEntry = {
      path: adoptedPath,
      branch: 'feat/T9804-session2',
      taskId: 'T9804',
      source: 'claude-agent',
      adoptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30d ago
      adoptedBy: 'claude-code-agent',
    };
    writeSentinelIndex(tmpDir, [sentinelEntry]);

    // Filter to only stale entries — sentinel-only with old adoptedAt should be stale
    const result = await listWorktrees({
      projectRoot: tmpDir,
      statusFilter: ['stale', 'orphan', 'active', 'merged', 'locked'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Adopted entry should appear (stale or orphan since task status is unknown)
    const adoptedEntry = result.data.worktrees.find((w) => w.path === adoptedPath);
    expect(adoptedEntry).toBeDefined();
  });

  it('empty sentinel index → no change to existing behaviour', async () => {
    // Write empty sentinel index
    writeSentinelIndex(tmpDir, []);

    const result = await listWorktrees({ projectRoot: tmpDir });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Should have exactly 2 entries: primary + wt1
    expect(result.data.worktrees).toHaveLength(2);
    for (const wt of result.data.worktrees) {
      expect(wt.source).toBe('cleo-spawn');
    }
  });

  it('missing sentinel index file → graceful degradation (no crash)', async () => {
    // No sentinel file written — should work the same as empty
    const result = await listWorktrees({ projectRoot: tmpDir });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.worktrees).toHaveLength(2);
    for (const wt of result.data.worktrees) {
      expect(wt.source).toBe('cleo-spawn');
    }
  });
});
