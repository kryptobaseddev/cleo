/**
 * Tests for T1856: mandatory --depends (or --depends-waiver) for critical-priority tasks.
 *
 * Guardrail #1 from T1855: `cleo add --priority critical` without a declared
 * dependency silently breaks wave-order spawning when downstream work assumes
 * the critical task is load-bearing. This guard enforces a dependency declaration
 * or an explicit waiver at the CLI layer, before dispatch.
 *
 * Coverage:
 *  1. Rejection: --priority critical without --depends or --depends-waiver → E_VALIDATION exit 6
 *  2. Normal: --priority critical with --depends → dispatches successfully
 *  3. Waiver: --priority critical with --depends-waiver → dispatches with waiver in params
 *
 * Tests mock the dispatcher layer so no real SQLite database is touched.
 *
 * @task T1856
 * @epic T1855
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dispatch and renderer before importing the command under test
// ---------------------------------------------------------------------------

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();
const mockCliError = vi.fn();
const mockCliOutput = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
}));

// Mock Core inference — add.ts delegates to inferTaskAddParams (T1490)
const mockInferTaskAddParams = vi.fn();
vi.mock('@cleocode/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...original,
    inferTaskAddParams: (...args: unknown[]) => mockInferTaskAddParams(...args),
  };
});

// ---------------------------------------------------------------------------
// Import command after mocks are registered
// ---------------------------------------------------------------------------

import { addCommand } from '../add.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default inferTaskAddParams result — no inference, no files */
const noInference = { inferredParent: undefined, files: undefined, acceptance: undefined };

/** Invoke addCommand.run with the given args (title is required). */
async function invokeAdd(title: string, extraArgs: Record<string, unknown> = {}): Promise<void> {
  const runFn = addCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { title, ...extraArgs }, rawArgs: [] });
}

/** Build a standard success response for dispatchRaw. */
function successResponse(id = 'T001'): Record<string, unknown> {
  return {
    success: true,
    data: { id, title: 'Critical task' },
    _meta: {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'cli',
      requestId: 'r-test',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo add --priority critical dependency guard (T1856)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInferTaskAddParams.mockResolvedValue(noInference);
    mockDispatchRaw.mockResolvedValue(successResponse());
    // Prevent process.exit from killing the test runner
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  // -------------------------------------------------------------------------
  // 1. Rejection path
  // -------------------------------------------------------------------------

  it('rejects --priority critical without --depends or --depends-waiver (E_VALIDATION exit 6)', async () => {
    await expect(invokeAdd('Critical task', { priority: 'critical' })).rejects.toThrow(
      'process.exit(6)',
    );

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      string,
      { name: string; fix: string },
    ];
    expect(code).toBe('E_VALIDATION');
    expect(details.name).toBe('E_VALIDATION');
    expect(message.toLowerCase()).toContain('critical-priority');
    // Guidance must reference cleo find
    expect(details.fix).toContain('cleo find');

    // Dispatch must NOT have been called — validation aborts before dispatch
    expect(mockDispatchRaw).not.toHaveBeenCalled();
  });

  it('does NOT reject non-critical priority tasks missing --depends', async () => {
    await invokeAdd('High task', { priority: 'high' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();
  });

  it('does NOT reject tasks with no priority flag (priority undefined)', async () => {
    await invokeAdd('Normal task');

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 2. Normal path — --depends provided
  // -------------------------------------------------------------------------

  it('dispatches successfully when --priority critical and --depends is provided', async () => {
    await invokeAdd('Critical task', { priority: 'critical', depends: 'T100,T200' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['priority']).toBe('critical');
    expect(params['depends']).toEqual(['T100', 'T200']);
    expect(params['dependsWaiver']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. Waiver path — --depends-waiver provided
  // -------------------------------------------------------------------------

  it('dispatches successfully when --priority critical and --depends-waiver is provided', async () => {
    await invokeAdd('Critical task', {
      priority: 'critical',
      'depends-waiver': 'Root-level critical task — no upstream dependency exists yet',
    });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).toHaveBeenCalledOnce();

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['priority']).toBe('critical');
    expect(params['depends']).toBeUndefined();
    expect(params['dependsWaiver']).toBe(
      'Root-level critical task — no upstream dependency exists yet',
    );
  });

  it('does NOT set dependsWaiver when waiver flag is absent', async () => {
    await invokeAdd('High task', { priority: 'high', depends: 'T100' });

    const [, , , params] = mockDispatchRaw.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['dependsWaiver']).toBeUndefined();
  });
});
