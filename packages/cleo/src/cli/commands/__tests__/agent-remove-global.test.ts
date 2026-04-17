/**
 * Unit tests for T366: cleo agent remove --global and --force-global.
 *
 * Covers TC-085, TC-086, TC-087 from the task acceptance criteria:
 *   TC-085: default (no --global) calls detachAgentFromProject only
 *   TC-086: --global with active project ref aborts with E_VALIDATION (exit 6)
 *           unless --force-global is supplied
 *   TC-087: --global --force-global bypasses warning and calls removeGlobal
 *
 * All DB and registry calls are mocked — no real SQLite is touched.
 * Pattern mirrors agent-attach.test.ts.
 *
 * @task T366
 * @epic T310
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../agent.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal
// ---------------------------------------------------------------------------

const mockDetachAgentFromProject = vi.fn();
const mockGetProjectAgentRef = vi.fn();
const mockRemoveGlobal = vi.fn().mockResolvedValue(undefined);
const mockGetDb = vi.fn().mockResolvedValue(undefined);

vi.mock('@cleocode/core/internal', () => ({
  detachAgentFromProject: (...args: unknown[]) => mockDetachAgentFromProject(...args),
  getProjectAgentRef: (...args: unknown[]) => mockGetProjectAgentRef(...args),
  getDb: (...args: unknown[]) => mockGetDb(...args),
  // AgentRegistryAccessor — provide an inline constructor to avoid hoisting issues
  // (arrow functions cannot be used as constructors).
  AgentRegistryAccessor: function AgentRegistryAccessor(this: {
    removeGlobal: typeof mockRemoveGlobal;
  }) {
    this.removeGlobal = mockRemoveGlobal;
  },
  // Stubs required by other agent.ts handlers loaded via the same module
  attachAgentToProject: vi.fn(),
  lookupAgent: vi.fn(),
  checkAgentHealth: vi.fn(),
  detectCrashedAgents: vi.fn(),
  detectStaleAgents: vi.fn(),
  getHealthReport: vi.fn(),
  STALE_THRESHOLD_MS: 60_000,
}));

// Mock cliOutput so tests can inspect calls without a full renderer stack.
const mockCliOutput = vi.fn();
vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Get the remove subcommand run function from the native citty agentCommand.
 *
 * @returns The run handler from the citty subcommand.
 */
function getRemoveRun(): (ctx: {
  args: Record<string, unknown>;
  rawArgs: string[];
}) => Promise<void> {
  const sub = agentCommand.subCommands?.remove;
  if (!sub || typeof sub !== 'object' || !('run' in sub) || typeof sub.run !== 'function') {
    throw new Error('agent remove subcommand has no run handler');
  }
  return sub.run as (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// TC-085: Default (no --global) — project-scoped detach only
// ---------------------------------------------------------------------------

describe('TC-085 cleo agent remove (default, no --global)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('calls detachAgentFromProject and outputs success when ref exists', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-1', enabled: 1 });

    const run = getRemoveRun();
    await run({ args: { agentId: 'agent-1', global: false, 'force-global': false }, rawArgs: [] });

    expect(mockDetachAgentFromProject).toHaveBeenCalledWith(expect.any(String), 'agent-1');
    expect(mockRemoveGlobal).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ scope: 'project' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode=4 and does NOT call detach when agent is not attached to project', async () => {
    mockGetProjectAgentRef.mockReturnValue(null);

    const run = getRemoveRun();
    await run({
      args: { agentId: 'ghost-agent', global: false, 'force-global': false },
      rawArgs: [],
    });

    expect(mockDetachAgentFromProject).not.toHaveBeenCalled();
    expect(mockRemoveGlobal).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'E_NOT_FOUND' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBe(4);
  });

  it('sets exitCode=1 and outputs error when detachAgentFromProject throws', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-err', enabled: 1 });
    mockDetachAgentFromProject.mockImplementation(() => {
      throw new Error('disk full');
    });

    const run = getRemoveRun();
    await run({
      args: { agentId: 'agent-err', global: false, 'force-global': false },
      rawArgs: [],
    });

    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'E_REMOVE' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TC-086: --global with active project ref aborts unless --force-global
// ---------------------------------------------------------------------------

describe('TC-086 cleo agent remove --global (safety gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('aborts with E_VALIDATION (exitCode=6) when active ref exists and --force-global not given', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-2', enabled: 1 });

    const run = getRemoveRun();
    await run({ args: { agentId: 'agent-2', global: true, 'force-global': false }, rawArgs: [] });

    expect(mockRemoveGlobal).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'E_VALIDATION' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBe(6);
  });

  it('does NOT abort when active ref exists but --force-global is supplied', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-3', enabled: 1 });

    const run = getRemoveRun();
    await run({ args: { agentId: 'agent-3', global: true, 'force-global': true }, rawArgs: [] });

    expect(mockRemoveGlobal).toHaveBeenCalledWith('agent-3', { force: true });
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ scope: 'global' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TC-087: --global with no active ref — proceeds directly
// ---------------------------------------------------------------------------

describe('TC-087 cleo agent remove --global (no active project ref)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('calls removeGlobal and outputs success when no active project ref exists', async () => {
    mockGetProjectAgentRef.mockReturnValue(null);

    const run = getRemoveRun();
    await run({ args: { agentId: 'agent-4', global: true, 'force-global': false }, rawArgs: [] });

    expect(mockRemoveGlobal).toHaveBeenCalledWith('agent-4', { force: false });
    expect(mockDetachAgentFromProject).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ removed: 'agent-4', scope: 'global' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode=1 when removeGlobal throws', async () => {
    mockGetProjectAgentRef.mockReturnValue(null);
    mockRemoveGlobal.mockRejectedValue(new Error('Agent not found globally: agent-missing'));

    const run = getRemoveRun();
    await run({
      args: { agentId: 'agent-missing', global: true, 'force-global': false },
      rawArgs: [],
    });

    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'E_REMOVE' }),
      }),
      expect.objectContaining({ command: 'agent remove' }),
    );
    expect(process.exitCode).toBe(1);
  });
});
