/**
 * Tests for T1856: mandatory --depends (or --depends-waiver) when promoting a
 * task to critical priority via `cleo update`.
 *
 * Guardrail #1 from T1855: `cleo update T### --priority critical` without a
 * dependency declaration on the task silently breaks wave-order spawning.
 * When the caller does not supply --depends / --add-depends / --depends-waiver,
 * the command fetches the existing task and checks for pre-existing dependencies
 * before applying the guard.
 *
 * Coverage:
 *  1. Rejection: --priority critical, no --depends/--add-depends/--depends-waiver,
 *     and existing task has no depends → E_VALIDATION exit 6
 *  2. Pass-through: existing task already has depends → update proceeds
 *  3. Normal: caller provides --depends alongside --priority critical → proceeds
 *  4. Waiver: caller provides --depends-waiver → proceeds with waiver in params
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

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);
const mockDispatchRaw = vi.fn();
const mockCliError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
}));

vi.mock('../../renderers/index.js', () => ({
  cliError: (...args: unknown[]) => mockCliError(...args),
  cliOutput: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import command after mocks are registered
// ---------------------------------------------------------------------------

import { updateCommand } from '../update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Invoke updateCommand.run with a taskId and optional arg overrides. */
async function invokeUpdate(
  taskId: string,
  extraArgs: Record<string, unknown> = {},
): Promise<void> {
  const runFn = updateCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args: { taskId, ...extraArgs }, rawArgs: [] });
}

/** Build a tasks.show response with optional depends array. */
function showResponse(depends?: string[]): Record<string, unknown> {
  return {
    success: true,
    data: {
      id: 'T100',
      title: 'Existing task',
      priority: 'high',
      depends: depends ?? [],
    },
    _meta: {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'cli',
      requestId: 'r-show',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo update --priority critical dependency guard (T1856)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
    // Prevent process.exit from killing the test runner
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  // -------------------------------------------------------------------------
  // 1. Rejection path — existing task has no depends
  // -------------------------------------------------------------------------

  it('rejects --priority critical when existing task has no depends and no waiver/new-depends (E_VALIDATION exit 6)', async () => {
    // Existing task has empty depends array
    mockDispatchRaw.mockResolvedValue(showResponse([]));

    await expect(invokeUpdate('T100', { priority: 'critical' })).rejects.toThrow('process.exit(6)');

    // tasks.show was called to fetch existing task
    expect(mockDispatchRaw).toHaveBeenCalledWith('query', 'tasks', 'show', { taskId: 'T100' });

    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code, details] = mockCliError.mock.calls[0] as [
      string,
      string,
      { name: string; fix: string },
    ];
    expect(code).toBe('E_VALIDATION');
    expect(details.name).toBe('E_VALIDATION');
    expect(message.toLowerCase()).toContain('critical-priority');
    expect(details.fix).toContain('cleo find');

    // Final update dispatch must NOT have been called
    expect(mockDispatchFromCli).not.toHaveBeenCalled();
  });

  it('rejects when existing task has undefined depends (no key in record)', async () => {
    // Simulate task record with no depends field at all
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { id: 'T100', title: 'Existing task', priority: 'high' },
      _meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        source: 'cli',
        requestId: 'r-show',
      },
    });

    await expect(invokeUpdate('T100', { priority: 'critical' })).rejects.toThrow('process.exit(6)');

    expect(mockCliError).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 2. Pass-through — existing task already has depends
  // -------------------------------------------------------------------------

  it('allows --priority critical when existing task already has depends', async () => {
    mockDispatchRaw.mockResolvedValue(showResponse(['T050', 'T060']));

    await invokeUpdate('T100', { priority: 'critical' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 3. Normal path — caller provides --depends
  // -------------------------------------------------------------------------

  it('dispatches successfully when --priority critical and --depends is provided (no task fetch)', async () => {
    // dispatchRaw should NOT be called for tasks.show — the guard is skipped
    // when --depends is already present in the args.
    await invokeUpdate('T100', { priority: 'critical', depends: 'T200' });

    expect(mockCliError).not.toHaveBeenCalled();
    // Verify show was not called (caller declared depends themselves)
    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();

    const [, , , params] = mockDispatchFromCli.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['priority']).toBe('critical');
    expect(params['depends']).toEqual(['T200']);
  });

  it('dispatches successfully when --priority critical and --add-depends is provided (no task fetch)', async () => {
    await invokeUpdate('T100', { priority: 'critical', 'add-depends': 'T300' });

    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();

    const [, , , params] = mockDispatchFromCli.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['addDepends']).toEqual(['T300']);
  });

  // -------------------------------------------------------------------------
  // 4. Waiver path — caller provides --depends-waiver
  // -------------------------------------------------------------------------

  it('dispatches successfully when --priority critical and --depends-waiver is provided', async () => {
    await invokeUpdate('T100', {
      priority: 'critical',
      'depends-waiver': 'Standalone critical task — architect approved',
    });

    expect(mockCliError).not.toHaveBeenCalled();
    // tasks.show must NOT be called when waiver is provided
    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();

    const [, , , params] = mockDispatchFromCli.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(params['priority']).toBe('critical');
    expect(params['dependsWaiver']).toBe('Standalone critical task — architect approved');
  });

  // -------------------------------------------------------------------------
  // Guard is only active when --priority critical is explicitly set
  // -------------------------------------------------------------------------

  it('does NOT guard when --priority is not critical', async () => {
    await invokeUpdate('T100', { priority: 'high' });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });

  it('does NOT guard when --priority is absent', async () => {
    await invokeUpdate('T100', { title: 'Renamed task' });

    expect(mockDispatchRaw).not.toHaveBeenCalled();
    expect(mockCliError).not.toHaveBeenCalled();
    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
  });
});
