/**
 * CLI integration tests for `cleo agent list` (T362 — Wave 3 of T310 epic).
 *
 * Covers:
 *   TC-081: cleo agent list without --global returns only project-attached agents
 *   TC-082: cleo agent list in a project with no project_agent_refs rows returns empty
 *   TC-084: cleo agent list --global returns all global agents regardless of project refs
 *   TC-085: cleo agent list --include-disabled includes detached (enabled=0) rows
 *   TC-086: cleo agent list --global --include-disabled returns the full set
 *   TC-087: attachment annotation is visible in output ([attached] / [global] / [disabled])
 *   TC-088: cleo agent get <id> project-scoped uses includeGlobal=false
 *   TC-089: cleo agent get <id> --global uses includeGlobal=true
 *   TC-090: cleo agent get <id> --global surfaces projectRef=null annotation when not attached
 *
 * These tests mock `listAgentsForProject`, `lookupAgent`, and `getDb` so no
 * real SQLite databases are needed.
 *
 * @task T362 @epic T310
 * @see packages/cleo/src/cli/commands/agent.ts
 * @see .cleo/rcasd/T310/specification/T310-specification.md §5.2
 * @see .cleo/adrs/ADR-037-conduit-signaldock-separation.md §4
 */

import type { AgentWithProjectOverride, ProjectAgentRef } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerAgentCommand } from '../agent.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — defined before any imports so vi can hoist correctly.
// ---------------------------------------------------------------------------

const { mockListAgentsForProject, mockLookupAgent, mockGetDb, mockCliOutput } = vi.hoisted(() => ({
  mockListAgentsForProject: vi.fn(),
  mockLookupAgent: vi.fn(),
  mockGetDb: vi.fn().mockResolvedValue(undefined),
  mockCliOutput: vi.fn(),
}));

vi.mock('@cleocode/core/internal', () => ({
  listAgentsForProject: mockListAgentsForProject,
  lookupAgent: mockLookupAgent,
  getDb: mockGetDb,
  // Other exports used elsewhere in agent.ts that need stubs
  AgentRegistryAccessor: vi.fn(),
  checkAgentHealth: vi.fn(),
  detectCrashedAgents: vi.fn(),
  detectStaleAgents: vi.fn(),
  getHealthReport: vi.fn(),
  STALE_THRESHOLD_MS: 180000,
  createConduit: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal ProjectAgentRef for testing. */
function makeRef(enabled: 0 | 1 = 1): ProjectAgentRef {
  return {
    agentId: 'agent-alpha',
    attachedAt: '2026-04-01T00:00:00.000Z',
    role: null,
    capabilitiesOverride: null,
    lastUsedAt: null,
    enabled,
  };
}

/** Build a minimal AgentWithProjectOverride fixture. */
function makeAgent(
  agentId: string,
  overrides: Partial<AgentWithProjectOverride> = {},
): AgentWithProjectOverride {
  return {
    agentId,
    displayName: `Agent ${agentId}`,
    apiKey: 'sk_live_testkey123456789',
    apiBaseUrl: 'https://api.signaldock.io',
    classification: 'code_dev',
    privacyTier: 'public',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: {},
    isActive: true,
    lastUsedAt: '2026-04-07T12:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    projectRef: makeRef(1),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: invoke the action handler for a subcommand
// ---------------------------------------------------------------------------

/**
 * Registers the agent command group on a fresh ShimCommand tree, then
 * invokes the named subcommand's `_action` with the provided arguments.
 *
 * For subcommands with positional args, those values are placed before `opts`
 * in the spread (mirrors Commander's handler calling convention).
 */
async function invokeAgentSubcommand(
  subcommandName: string,
  positionalArgs: unknown[],
  opts: Record<string, unknown> = {},
): Promise<void> {
  const program = new Command();
  registerAgentCommand(program);

  const agentCmd = program.commands.find((c) => c.name() === 'agent');
  if (!agentCmd) throw new Error('agent command not registered');

  const sub = agentCmd.commands.find((c) => c.name() === subcommandName);
  if (!sub?._action) throw new Error(`${subcommandName} subcommand has no action registered`);

  await sub._action(...positionalArgs, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDb.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// cleo agent list
// ---------------------------------------------------------------------------

describe('cleo agent list', () => {
  it('TC-081: without --global returns only project-attached agents (INNER JOIN semantics)', async () => {
    const attached = makeAgent('agent-alpha', { projectRef: makeRef(1) });
    mockListAgentsForProject.mockReturnValue([attached]);

    await invokeAgentSubcommand('list', [], {});

    expect(mockListAgentsForProject).toHaveBeenCalledWith(expect.any(String), {
      includeGlobal: false,
      includeDisabled: false,
    });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(true);
    expect(outputCall[0].data).toHaveLength(1);
    expect(outputCall[0].data[0].agentId).toBe('agent-alpha');
  });

  it('TC-082: project with no project_agent_refs returns empty array', async () => {
    mockListAgentsForProject.mockReturnValue([]);

    await invokeAgentSubcommand('list', [], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(true);
    expect(outputCall[0].data).toHaveLength(0);
  });

  it('TC-084: --global returns all global agents regardless of project refs', async () => {
    const globalOnly = makeAgent('agent-global', { projectRef: null });
    const attached = makeAgent('agent-local', { projectRef: makeRef(1) });
    mockListAgentsForProject.mockReturnValue([globalOnly, attached]);

    await invokeAgentSubcommand('list', [], { global: true });

    expect(mockListAgentsForProject).toHaveBeenCalledWith(expect.any(String), {
      includeGlobal: true,
      includeDisabled: false,
    });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(true);
    expect(outputCall[0].data).toHaveLength(2);
  });

  it('TC-085: --include-disabled includes detached (enabled=0) rows', async () => {
    const detached = makeAgent('agent-detached', { projectRef: makeRef(0) });
    mockListAgentsForProject.mockReturnValue([detached]);

    await invokeAgentSubcommand('list', [], { includeDisabled: true });

    expect(mockListAgentsForProject).toHaveBeenCalledWith(expect.any(String), {
      includeGlobal: false,
      includeDisabled: true,
    });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(true);
    expect(outputCall[0].data).toHaveLength(1);
  });

  it('TC-086: --global --include-disabled passes both opts to listAgentsForProject', async () => {
    const globalAgent = makeAgent('agent-x', { projectRef: null });
    const disabledAgent = makeAgent('agent-y', { projectRef: makeRef(0) });
    mockListAgentsForProject.mockReturnValue([globalAgent, disabledAgent]);

    await invokeAgentSubcommand('list', [], { global: true, includeDisabled: true });

    expect(mockListAgentsForProject).toHaveBeenCalledWith(expect.any(String), {
      includeGlobal: true,
      includeDisabled: true,
    });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data).toHaveLength(2);
  });

  it('TC-087: attachment annotation is [attached] for attached agents', async () => {
    const agent = makeAgent('agent-alpha', { projectRef: makeRef(1) });
    mockListAgentsForProject.mockReturnValue([agent]);

    await invokeAgentSubcommand('list', [], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data[0].attachment).toBe('[attached]');
  });

  it('TC-087: attachment annotation is [global] for agents without a projectRef', async () => {
    const agent = makeAgent('agent-beta', { projectRef: null });
    mockListAgentsForProject.mockReturnValue([agent]);

    await invokeAgentSubcommand('list', [], { global: true });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data[0].attachment).toBe('[global]');
  });

  it('TC-087: attachment annotation is [disabled] for detached (enabled=0) agents', async () => {
    const agent = makeAgent('agent-gamma', { projectRef: makeRef(0) });
    mockListAgentsForProject.mockReturnValue([agent]);

    await invokeAgentSubcommand('list', [], { includeDisabled: true });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data[0].attachment).toBe('[disabled]');
  });

  it('output columns match spec §5.2: agentId, name, classification, transportType, isActive, lastUsedAt, attachment', async () => {
    const agent = makeAgent('agent-cols', { projectRef: makeRef(1) });
    mockListAgentsForProject.mockReturnValue([agent]);

    await invokeAgentSubcommand('list', [], {});

    const [outputCall] = mockCliOutput.mock.calls;
    const row = outputCall[0].data[0] as Record<string, unknown>;
    expect(row).toHaveProperty('agentId');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('classification');
    expect(row).toHaveProperty('transportType');
    expect(row).toHaveProperty('isActive');
    expect(row).toHaveProperty('lastUsedAt');
    expect(row).toHaveProperty('attachment');
  });

  it('outputs success=false with E_LIST on listAgentsForProject error', async () => {
    mockListAgentsForProject.mockImplementation(() => {
      throw new Error('DB unavailable');
    });

    await invokeAgentSubcommand('list', [], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(false);
    expect(outputCall[0].error.code).toBe('E_LIST');
  });
});

// ---------------------------------------------------------------------------
// cleo agent get --global
// ---------------------------------------------------------------------------

describe('cleo agent get --global', () => {
  it('TC-088: without --global calls lookupAgent with includeGlobal=false', async () => {
    const agent = makeAgent('agent-alpha', { projectRef: makeRef(1) });
    mockLookupAgent.mockReturnValue(agent);

    await invokeAgentSubcommand('get', ['agent-alpha'], {});

    expect(mockLookupAgent).toHaveBeenCalledWith(expect.any(String), 'agent-alpha', {
      includeGlobal: false,
    });
  });

  it('TC-089: with --global calls lookupAgent with includeGlobal=true', async () => {
    const agent = makeAgent('agent-alpha', { projectRef: null });
    mockLookupAgent.mockReturnValue(agent);

    await invokeAgentSubcommand('get', ['agent-alpha'], { global: true });

    expect(mockLookupAgent).toHaveBeenCalledWith(expect.any(String), 'agent-alpha', {
      includeGlobal: true,
    });
  });

  it('TC-090: --global returns "not attached to current project" when projectRef is null', async () => {
    const agent = makeAgent('agent-globalonly', { projectRef: null });
    mockLookupAgent.mockReturnValue(agent);

    await invokeAgentSubcommand('get', ['agent-globalonly'], { global: true });

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(true);
    expect(outputCall[0].data.projectRef).toBe('not attached to current project');
  });

  it('returns E_NOT_FOUND exit code 4 when lookupAgent returns null', async () => {
    mockLookupAgent.mockReturnValue(null);

    await invokeAgentSubcommand('get', ['nonexistent'], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].success).toBe(false);
    expect(outputCall[0].error.code).toBe('E_NOT_FOUND');
  });

  it('redacts the api key in output', async () => {
    const agent = makeAgent('agent-redact', {
      apiKey: 'sk_live_supersecretlongkey99',
      projectRef: makeRef(1),
    });
    mockLookupAgent.mockReturnValue(agent);

    await invokeAgentSubcommand('get', ['agent-redact'], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data.apiKey).toContain('...');
    expect(outputCall[0].data.apiKey).not.toContain('supersecret');
  });

  it('includes projectRef block when agent is attached', async () => {
    const ref = makeRef(1);
    const agent = makeAgent('agent-alpha', { projectRef: ref });
    mockLookupAgent.mockReturnValue(agent);

    await invokeAgentSubcommand('get', ['agent-alpha'], {});

    const [outputCall] = mockCliOutput.mock.calls;
    expect(outputCall[0].data.projectRef).toBeTruthy();
    expect(typeof outputCall[0].data.projectRef).toBe('object');
  });
});
