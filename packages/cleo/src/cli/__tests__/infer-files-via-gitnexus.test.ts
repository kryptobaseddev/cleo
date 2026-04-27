/**
 * Tests for GitNexus file inference module — re-export shim.
 *
 * T1490: `inferFilesViaGitNexus` has moved to `packages/core/src/tasks/infer-add-params.ts`.
 * This file validates that the CLI shim re-exports the function correctly.
 * The full behaviour tests live in `packages/core`.
 *
 * @task T1330
 * @task T1490
 */

import { describe, expect, it, vi } from 'vitest';

// Mock node:child_process using importOriginal so we don't break other
// modules that also use child_process (e.g. caamp lock.ts uses execFile).
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

describe('inferFilesViaGitNexus shim (T1490)', () => {
  it('re-exports inferFilesViaGitNexus from Core', async () => {
    const { inferFilesViaGitNexus } = await import('../infer-files-via-gitnexus.js');
    expect(typeof inferFilesViaGitNexus).toBe('function');
  });

  it('calls gitnexus and extracts file paths via the re-export', async () => {
    const gitnexusResponse = [
      {
        name: 'auth-setup',
        symbols: [
          { name: 'validateAuth', location: 'packages/core/src/auth.ts:42:0' },
          { name: 'setupOAuth', location: 'packages/core/src/auth.ts:100:0' },
        ],
      },
      {
        name: 'login-handler',
        symbols: [{ name: 'handleLogin', location: 'packages/cli/src/login.ts:15:0' }],
      },
    ];

    mockExecFileSync.mockReturnValue(JSON.stringify(gitnexusResponse));

    const { inferFilesViaGitNexus } = await import('../infer-files-via-gitnexus.js');
    const files = inferFilesViaGitNexus('Add auth flow', 'Implement OAuth2 authentication');

    expect(files).toEqual(['packages/core/src/auth.ts', 'packages/cli/src/login.ts']);
  });

  it('returns empty array when gitnexus is unavailable', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gitnexus not found');
    });

    const { inferFilesViaGitNexus } = await import('../infer-files-via-gitnexus.js');
    const files = inferFilesViaGitNexus('Task', 'Description');

    expect(files).toEqual([]);
  });
});
