/**
 * Unit tests for T364: cleo agent attach / detach CLI verbs (native citty).
 *
 * Tests cover the happy paths and E_NOT_FOUND branches for both subcommands.
 * All DB and registry calls are mocked — no real SQLite is touched.
 *
 * @task T364
 * @epic T310
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../agent.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal (dynamic import inside run handlers)
// ---------------------------------------------------------------------------

const mockAttachAgentToProject = vi.fn();
const mockDetachAgentFromProject = vi.fn();
const mockGetProjectAgentRef = vi.fn();
const mockLookupAgent = vi.fn();
const mockGetDb = vi.fn().mockResolvedValue(undefined);

vi.mock('@cleocode/core/internal', () => ({
  attachAgentToProject: (...args: unknown[]) => mockAttachAgentToProject(...args),
  detachAgentFromProject: (...args: unknown[]) => mockDetachAgentFromProject(...args),
  getProjectAgentRef: (...args: unknown[]) => mockGetProjectAgentRef(...args),
  lookupAgent: (...args: unknown[]) => mockLookupAgent(...args),
  getDb: (...args: unknown[]) => mockGetDb(...args),
  AgentRegistryAccessor: function AgentRegistryAccessor() {},
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
// Helpers
// ---------------------------------------------------------------------------

type RunContext = { args: Record<string, unknown>; rawArgs: string[] };
type RunFn = (ctx: RunContext) => Promise<void>;

/**
 * Extract the run function from a named subcommand of agentCommand.
 */
function getAgentSubRun(subName: string): RunFn {
  const subs = agentCommand.subCommands as Record<string, { run?: RunFn }>;
  const sub = subs[subName];
  if (!sub?.run) throw new Error(`agent ${subName} subcommand has no run function`);
  return sub.run;
}

// ---------------------------------------------------------------------------
// Tests — agent attach
// ---------------------------------------------------------------------------

describe('T364 cleo agent attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('calls attachAgentToProject and outputs success when agent exists globally', async () => {
    mockLookupAgent.mockReturnValue({ agentId: 'agent-1', displayName: 'Test Agent' });

    const run = getAgentSubRun('attach');
    await run({ args: { agentId: 'agent-1' }, rawArgs: [] });

    expect(mockAttachAgentToProject).toHaveBeenCalledWith(expect.any(String), 'agent-1', {
      role: null,
      capabilitiesOverride: null,
    });
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({ command: 'agent attach' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('passes role and capabilitiesOverride options through', async () => {
    mockLookupAgent.mockReturnValue({ agentId: 'agent-2', displayName: 'Role Agent' });

    const run = getAgentSubRun('attach');
    await run({
      args: { agentId: 'agent-2', role: 'reviewer', 'capabilities-override': '{"x":1}' },
      rawArgs: [],
    });

    expect(mockAttachAgentToProject).toHaveBeenCalledWith(expect.any(String), 'agent-2', {
      role: 'reviewer',
      capabilitiesOverride: '{"x":1}',
    });
  });

  it('sets exitCode=4 and does NOT call attach when agent does not exist globally', async () => {
    mockLookupAgent.mockReturnValue(null);

    const run = getAgentSubRun('attach');
    await run({ args: { agentId: 'ghost-agent' }, rawArgs: [] });

    expect(mockAttachAgentToProject).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ command: 'agent attach' }),
    );
    expect(process.exitCode).toBe(4);
  });

  it('sets exitCode=1 and outputs error when attachAgentToProject throws', async () => {
    mockLookupAgent.mockReturnValue({ agentId: 'agent-3', displayName: 'Err Agent' });
    mockAttachAgentToProject.mockImplementation(() => {
      throw new Error('conduit db locked');
    });

    const run = getAgentSubRun('attach');
    await run({ args: { agentId: 'agent-3' }, rawArgs: [] });

    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ command: 'agent attach' }),
    );
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — agent detach
// ---------------------------------------------------------------------------

describe('T364 cleo agent detach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('calls detachAgentFromProject and outputs success when ref exists', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-1', enabled: 1 });

    const run = getAgentSubRun('detach');
    await run({ args: { agentId: 'agent-1' }, rawArgs: [] });

    expect(mockDetachAgentFromProject).toHaveBeenCalledWith(expect.any(String), 'agent-1');
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({ command: 'agent detach' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode=4 and does NOT call detach when agent is not attached to project', async () => {
    mockGetProjectAgentRef.mockReturnValue(null);

    const run = getAgentSubRun('detach');
    await run({ args: { agentId: 'ghost-agent' }, rawArgs: [] });

    expect(mockDetachAgentFromProject).not.toHaveBeenCalled();
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ command: 'agent detach' }),
    );
    expect(process.exitCode).toBe(4);
  });

  it('sets exitCode=1 and outputs error when detachAgentFromProject throws', async () => {
    mockGetProjectAgentRef.mockReturnValue({ agentId: 'agent-4', enabled: 1 });
    mockDetachAgentFromProject.mockImplementation(() => {
      throw new Error('disk full');
    });

    const run = getAgentSubRun('detach');
    await run({ args: { agentId: 'agent-4' }, rawArgs: [] });

    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ command: 'agent detach' }),
    );
    expect(process.exitCode).toBe(1);
  });
});
