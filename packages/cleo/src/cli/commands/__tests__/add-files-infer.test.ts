/**
 * Tests for T1330: files eager scope via gitnexus inference.
 *
 * When `--files-infer` flag is passed and `--files` is not provided,
 * the add command should invoke GitNexus to suggest touched files
 * based on task title and description.
 *
 * If GitNexus returns results, they are populated in the files array.
 * If GitNexus is unavailable or returns nothing, a warning is printed
 * and files remain empty (existing atomicity check at spawn time fires).
 *
 * @task T1330
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../add.js';

// ---------------------------------------------------------------------------
// Mock the dispatch adapter and renderers
// ---------------------------------------------------------------------------

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

// Mock GitNexus inference
const mockInferFilesViaGitNexus = vi.fn();
vi.mock('../../infer-files-via-gitnexus.js', () => ({
  inferFilesViaGitNexus: (...args: unknown[]) => mockInferFilesViaGitNexus(...args),
}));

// Mock session-engine to prevent T1329 parent-inference side effects in these tests
vi.mock('../../../dispatch/engines/session-engine.js', () => ({
  taskCurrentGet: vi
    .fn()
    .mockResolvedValue({ success: true, data: { currentTask: null, currentPhase: null } }),
}));

// Mock stderr
const mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke addCommand.run with the given args.
 */
async function invokeAdd(args: Record<string, unknown>): Promise<void> {
  const runFn = addCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args, rawArgs: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('add command with --files-infer', () => {
  beforeEach(() => {
    mockDispatchRaw.mockClear();
    mockHandleRawError.mockClear();
    mockInferFilesViaGitNexus.mockClear();
    mockStderrWrite.mockClear();
  });

  it('should infer files when --files-infer is passed and --files is absent', async () => {
    // Setup: GitNexus returns two suggested files
    mockInferFilesViaGitNexus.mockReturnValue([
      'packages/core/src/auth.ts',
      'packages/cli/src/login.ts',
    ]);

    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        id: 'T123',
        title: 'Add auth flow',
        files: ['packages/core/src/auth.ts', 'packages/cli/src/login.ts'],
      },
    });

    // Invoke add with --files-infer but no --files
    await invokeAdd({
      title: 'Add auth flow',
      description: 'Implement OAuth2 authentication',
      'files-infer': true,
    });

    // Verify that inference was called with title and description
    expect(mockInferFilesViaGitNexus).toHaveBeenCalledWith(
      'Add auth flow',
      'Implement OAuth2 authentication',
    );

    // Verify that dispatch was called with inferred files
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'Add auth flow',
        files: ['packages/core/src/auth.ts', 'packages/cli/src/login.ts'],
      }),
    );

    // No warning should be printed (inference succeeded)
    expect(mockStderrWrite).not.toHaveBeenCalled();
  });

  it('should warn when --files-infer returns no results', async () => {
    // Setup: GitNexus returns empty array
    mockInferFilesViaGitNexus.mockReturnValue([]);

    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T123', title: 'Vague task', files: [] },
    });

    // Invoke add with --files-infer but no --files
    await invokeAdd({
      title: 'Vague task',
      'files-infer': true,
    });

    // Verify that inference was called
    expect(mockInferFilesViaGitNexus).toHaveBeenCalledWith('Vague task', undefined);

    // Verify that warning was printed
    expect(mockStderrWrite).toHaveBeenCalledWith(
      expect.stringContaining('No files inferred by GitNexus'),
    );

    // Verify that dispatch was called without files
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'Vague task',
      }),
    );
  });

  it('should use explicit --files instead of inference', async () => {
    // Setup: GitNexus would return files
    mockInferFilesViaGitNexus.mockReturnValue(['packages/inferred.ts']);

    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T123', title: 'Task', files: ['packages/explicit.ts'] },
    });

    // Invoke add with both --files and --files-infer
    // Explicit --files should take precedence
    await invokeAdd({
      title: 'Task',
      'files-infer': true,
      files: 'packages/explicit.ts',
    });

    // Verify that inference was NOT called (--files takes precedence)
    expect(mockInferFilesViaGitNexus).not.toHaveBeenCalled();

    // Verify that dispatch was called with explicit files
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        files: ['packages/explicit.ts'],
      }),
    );
  });

  it('should not infer files when --files-infer is false or absent', async () => {
    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T123', title: 'Task' },
    });

    // Invoke add WITHOUT --files-infer
    await invokeAdd({
      title: 'Task',
    });

    // Verify that inference was NOT called
    expect(mockInferFilesViaGitNexus).not.toHaveBeenCalled();

    // Verify that dispatch was called without files
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'Task',
      }),
    );
  });
});
