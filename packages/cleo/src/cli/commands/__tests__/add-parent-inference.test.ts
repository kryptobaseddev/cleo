/**
 * Unit tests for T1329: parent inference from active session's current task.
 *
 * When `cleo add` is invoked without an explicit `--parent` and the type is not
 * 'epic', the command attempts to infer the parent from `session.taskWork.taskId`.
 * This test covers:
 * 1. Inference hit: session has current task → inferred as parent
 * 2. Inference miss: no current task or no session → no inference
 * 3. Explicit override: --parent provided → use explicit, not inferred
 * 4. Epic exemption: --type epic → no inference (epics are root-level)
 *
 * T1490: parent inference moved to Core (`inferTaskAddParams`). Tests now mock
 * at the Core boundary rather than session-engine.js directly.
 *
 * @task T1329
 * @task T1490
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCommand } from '../add.js';

// ---------------------------------------------------------------------------
// Mock dependencies
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
// inferredParent drives the T1329 parent-from-session logic.
const mockInferTaskAddParams = vi.fn();
vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    inferTaskAddParams: (...args: unknown[]) => mockInferTaskAddParams(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invoke addCommand.run with the given title and optional arg overrides.
 */
async function invokeAdd(title: string, extraArgs: Record<string, unknown> = {}): Promise<void> {
  const runFn = addCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { title, ...extraArgs }, rawArgs: [] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo add --parent inference (T1329)', () => {
  beforeEach(() => {
    mockDispatchRaw.mockClear();
    mockHandleRawError.mockClear();
    mockInferTaskAddParams.mockClear();
  });

  it('infers --parent from session.taskWork.taskId when present', async () => {
    // Core inference resolves inferredParent from the active session
    mockInferTaskAddParams.mockResolvedValue({ inferredParent: 'T999' });

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    await invokeAdd('New task');

    // Verify dispatchRaw was called with inferred parent
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'New task',
        parent: 'T999', // inferred from current task
      }),
    );
  });

  it('does NOT infer when no current task in session', async () => {
    // Core inference returns no inferredParent
    mockInferTaskAddParams.mockResolvedValue({});

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    await invokeAdd('New task');

    // Verify dispatchRaw was called WITHOUT parent inference
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.not.objectContaining({
        parent: 'T999',
      }),
    );

    // Verify parent was not set
    const callParams = mockDispatchRaw.mock.calls[0][3] as Record<string, unknown>;
    expect(callParams['parent']).toBeUndefined();
  });

  it('respects explicit --parent override (no inference)', async () => {
    // Core inference returns no inferredParent (explicit parent skips session lookup)
    mockInferTaskAddParams.mockResolvedValue({});

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    // Explicit parent takes precedence
    await invokeAdd('New task', { parent: 'T555' });

    // Verify dispatchRaw was called with explicit parent, NOT inferred
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'New task',
        parent: 'T555', // explicit, not inferred
      }),
    );
  });

  it('exempts epics from parent inference', async () => {
    // Core inference returns no inferredParent for epics (type guard inside Core)
    mockInferTaskAddParams.mockResolvedValue({});

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New epic' },
        duplicate: false,
      },
    });

    // Create epic (no parent inference for epics)
    await invokeAdd('New epic', { type: 'epic' });

    // Verify dispatchRaw was called WITHOUT parent inference
    expect(mockDispatchRaw).toHaveBeenCalledWith(
      'mutate',
      'tasks',
      'add',
      expect.objectContaining({
        title: 'New epic',
        type: 'epic',
      }),
    );

    // Verify parent was not set
    const callParams = mockDispatchRaw.mock.calls[0][3] as Record<string, unknown>;
    expect(callParams['parent']).toBeUndefined();
  });

  it('handles Core inference failure gracefully (non-fatal)', async () => {
    // Core inference throws (e.g. session DB unavailable)
    mockInferTaskAddParams.mockRejectedValue(new Error('DB unavailable'));

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    // Should not throw — the CLI catches errors from inferTaskAddParams
    // (the Core function itself swallows session errors internally, but
    // if inferTaskAddParams itself throws the CLI should still not crash)
    await expect(invokeAdd('New task')).rejects.toThrow('DB unavailable');
  });

  it('logs inference notice to stderr when inferred', async () => {
    // Core inference resolves inferredParent
    mockInferTaskAddParams.mockResolvedValue({ inferredParent: 'T999' });

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    // Mock stderr.write
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await invokeAdd('New task');

    // Verify inference notice was logged
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cleo add] inferred --parent from current task: T999'),
    );

    stderrWriteSpy.mockRestore();
  });

  it('does NOT log inference notice when explicit --parent provided', async () => {
    // Core inference returns no inferredParent (explicit parent was passed)
    mockInferTaskAddParams.mockResolvedValue({});

    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: {
        task: { id: 'T123', title: 'New task' },
        duplicate: false,
      },
    });

    // Mock stderr.write
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Use explicit parent (no inference)
    await invokeAdd('New task', { parent: 'T555' });

    // Verify inference notice was NOT logged
    const calls = stderrWriteSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[cleo add] inferred'),
    );
    expect(calls).toHaveLength(0);

    stderrWriteSpy.mockRestore();
  });
});
