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
 * T1490: inference moved to Core (`inferTaskAddParams`). Tests now mock at the
 * Core boundary rather than the lower-level `inferFilesViaGitNexus` function.
 *
 * @task T1330
 * @task T1490
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

// Mock Core inference — add.ts now delegates all inference to inferTaskAddParams (T1490)
const mockInferTaskAddParams = vi.fn();
vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    inferTaskAddParams: (...args: unknown[]) => mockInferTaskAddParams(...args),
  };
});

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
    mockInferTaskAddParams.mockClear();
    mockStderrWrite.mockClear();
  });

  it('should infer files when --files-infer is passed and --files is absent', async () => {
    // Setup: Core inference returns two suggested files
    mockInferTaskAddParams.mockResolvedValue({
      files: ['packages/core/src/auth.ts', 'packages/cli/src/login.ts'],
    });

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

    // Verify that Core inference was called with correct input
    expect(mockInferTaskAddParams).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        title: 'Add auth flow',
        description: 'Implement OAuth2 authentication',
        filesInfer: true,
      }),
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
    // Setup: Core inference signals a warning (no files inferred)
    mockInferTaskAddParams.mockResolvedValue({
      filesInferWarning: true,
    });

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

    // Verify that Core inference was called
    expect(mockInferTaskAddParams).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        title: 'Vague task',
        filesInfer: true,
      }),
    );

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
    // Setup: Core inference returns explicit files (filesRaw path)
    mockInferTaskAddParams.mockResolvedValue({
      files: ['packages/explicit.ts'],
    });

    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T123', title: 'Task', files: ['packages/explicit.ts'] },
    });

    // Invoke add with both --files and --files-infer
    // The Core inference function receives both and uses explicit --files
    await invokeAdd({
      title: 'Task',
      'files-infer': true,
      files: 'packages/explicit.ts',
    });

    // Verify that Core inference was called with filesRaw set
    expect(mockInferTaskAddParams).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filesRaw: 'packages/explicit.ts',
      }),
    );

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
    // Setup: Core inference returns nothing
    mockInferTaskAddParams.mockResolvedValue({});

    // Setup: dispatch succeeds
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T123', title: 'Task' },
    });

    // Invoke add WITHOUT --files-infer
    await invokeAdd({
      title: 'Task',
    });

    // Verify that Core inference was called (it's always called now, but without filesInfer)
    expect(mockInferTaskAddParams).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        title: 'Task',
        filesInfer: undefined,
      }),
    );

    // Verify that dispatch was called without files
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'Task',
      }),
    );
    const callParams = mockDispatchRaw.mock.calls[0][3] as Record<string, unknown>;
    expect(callParams['files']).toBeUndefined();
  });
});
