/**
 * Tests for GitNexus file inference module.
 *
 * @task T1330
 */

import { describe, expect, it, vi } from 'vitest';
import { inferFilesViaGitNexus } from '../infer-files-via-gitnexus.js';

// Mock execFileSync
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

describe('inferFilesViaGitNexus', () => {
  it('should extract files from gitnexus query response', () => {
    // Mock GitNexus response with processes containing symbols
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

    const files = inferFilesViaGitNexus('Add auth flow', 'Implement OAuth2 authentication');

    expect(files).toEqual(['packages/core/src/auth.ts', 'packages/cli/src/login.ts']);
  });

  it('should handle duplicate file paths (use Set)', () => {
    // Mock response where the same file is referenced multiple times
    const gitnexusResponse = [
      {
        name: 'auth-module',
        symbols: [
          { name: 'func1', location: 'packages/core/src/auth.ts:10:0' },
          { name: 'func2', location: 'packages/core/src/auth.ts:50:0' },
        ],
      },
    ];

    mockExecFileSync.mockReturnValue(JSON.stringify(gitnexusResponse));

    const files = inferFilesViaGitNexus('Task', 'Description');

    expect(files).toEqual(['packages/core/src/auth.ts']);
  });

  it('should return empty array when gitnexus is unavailable', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gitnexus not found');
    });

    const files = inferFilesViaGitNexus('Task', 'Description');

    expect(files).toEqual([]);
  });

  it('should return empty array when gitnexus returns invalid JSON', () => {
    mockExecFileSync.mockReturnValue('not valid json {]');

    const files = inferFilesViaGitNexus('Task', 'Description');

    expect(files).toEqual([]);
  });

  it('should handle response with files array instead of symbols', () => {
    const gitnexusResponse = [
      {
        name: 'process1',
        files: ['packages/core/src/file1.ts', 'packages/cli/src/file2.ts'],
      },
    ];

    mockExecFileSync.mockReturnValue(JSON.stringify(gitnexusResponse));

    const files = inferFilesViaGitNexus('Task', 'Description');

    expect(files).toEqual(['packages/core/src/file1.ts', 'packages/cli/src/file2.ts']);
  });

  it('should work with title only (no description)', () => {
    const gitnexusResponse = [
      {
        name: 'process1',
        symbols: [{ name: 'func', location: 'packages/file.ts:1:0' }],
      },
    ];

    mockExecFileSync.mockReturnValue(JSON.stringify(gitnexusResponse));

    const files = inferFilesViaGitNexus('Task title');

    expect(files).toEqual(['packages/file.ts']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gitnexus',
      ['query', '--json', '--limit', '5', 'Task title'],
      expect.any(Object),
    );
  });

  it('should combine title and description in query', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    inferFilesViaGitNexus('Fix bug', 'Resolve auth issue in login flow');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gitnexus',
      ['query', '--json', '--limit', '5', 'Fix bug Resolve auth issue in login flow'],
      expect.any(Object),
    );
  });
});
