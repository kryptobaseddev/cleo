/**
 * Unit tests for T364: cleo agent attach / detach CLI verbs.
 *
 * Tests cover the happy paths and E_NOT_FOUND branches for both subcommands.
 * All DB and registry calls are mocked — no real SQLite is touched.
 *
 * Pattern mirrors add-description.test.ts: register the command tree on a
 * fresh ShimCommand, find the subcommand by name, and invoke its `_action`
 * callback directly.
 *
 * @task T364
 * @epic T310
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerAgentCommand } from '../agent.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal (dynamic import inside action handlers)
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
  // AgentRegistryAccessor is instantiated to init DBs; provide a no-op ctor via
  // an inline function (avoids the vi.mock hoisting issue with class declarations).
  AgentRegistryAccessor: function AgentRegistryAccessor() {},
  // Other symbols used elsewhere in agent.ts — safe stubs
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

/**
 * Register the agent command tree and extract the named subcommand's action.
 *
 * @param subName - Subcommand name, e.g. `'attach'` or `'detach'`.
 * @returns The action handler extracted from the ShimCommand tree.
 */
function getAgentSubAction(subName: string): (...args: unknown[]) => Promise<void> {
  const program = new Command();
  registerAgentCommand(program);
  const agentCmd = program.commands.find((c) => c.name() === 'agent');
  if (!agentCmd) throw new Error('agent command not registered');
  const sub = agentCmd.commands.find((c) => c.name() === subName);
  if (!sub?._action) throw new Error(`agent ${subName} subcommand has no action registered`);
  return sub._action as (...args: unknown[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tests — agent attach
// ---------------------------------------------------------------------------

describe('T364 cleo agent attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset exitCode between tests
    process.exitCode = undefined;
  });

  it('calls attachAgentToProject and outputs success when agent exists globally', async () => {
    mockLookupAgent.mockReturnValue({ agentId: 'agent-1', displayName: 'Test Agent' });

    const action = getAgentSubAction('attach');
    await action('agent-1', {});

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

    const action = getAgentSubAction('attach');
    await action('agent-2', { role: 'reviewer', capabilitiesOverride: '{"x":1}' });

    expect(mockAttachAgentToProject).toHaveBeenCalledWith(expect.any(String), 'agent-2', {
      role: 'reviewer',
      capabilitiesOverride: '{"x":1}',
    });
  });

  it('sets exitCode=4 and does NOT call attach when agent does not exist globally', async () => {
    mockLookupAgent.mockReturnValue(null);

    const action = getAgentSubAction('attach');
    await action('ghost-agent', {});

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

    const action = getAgentSubAction('attach');
    await action('agent-3', {});

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

    const action = getAgentSubAction('detach');
    await action('agent-1');

    expect(mockDetachAgentFromProject).toHaveBeenCalledWith(expect.any(String), 'agent-1');
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({ command: 'agent detach' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode=4 and does NOT call detach when agent is not attached to project', async () => {
    mockGetProjectAgentRef.mockReturnValue(null);

    const action = getAgentSubAction('detach');
    await action('ghost-agent');

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

    const action = getAgentSubAction('detach');
    await action('agent-4');

    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ command: 'agent detach' }),
    );
    expect(process.exitCode).toBe(1);
  });
});
