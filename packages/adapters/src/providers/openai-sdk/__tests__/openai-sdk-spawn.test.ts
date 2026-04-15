/**
 * Tests for the OpenAI Agents SDK spawn provider.
 *
 * All OpenAI SDK calls are mocked — no real API keys or network calls
 * are required to run this suite.
 *
 * Test coverage:
 * - GuardrailTests: path ACL logic and guardrail builders
 * - HandoffTests: agent topology construction from tier/handoffs options
 * - SpawnProviderTests: spawn(), listRunning(), terminate(), canSpawn()
 * - AdapterTests: identity, capabilities, initialize, dispose, healthCheck
 * - InstallProviderTests: isInstalled, install, uninstall
 * - TraceProcessorTests: onSpanEnd event capture
 * - HandoffIntegrationTest: lead + worker topology with mocked runner
 *
 * @task T582
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist shared state so vi.mock factories can reference it
// ---------------------------------------------------------------------------

const { createdAgents, mockRunState, mockFsState } = vi.hoisted(() => {
  return {
    createdAgents: [] as Array<{ name?: string; handoffs?: unknown[]; model?: string }>,
    mockRunState: { result: { finalOutput: 'mock output' }, shouldThrow: false },
    mockFsState: { exists: false, content: '' },
  };
});

// ---------------------------------------------------------------------------
// Mock @openai/agents
// ---------------------------------------------------------------------------

vi.mock('@openai/agents', () => {
  class MockAgent {
    name: string;
    handoffs: unknown[];
    model: string;
    inputGuardrails: unknown[];
    instructions: string;

    constructor(opts: {
      name?: string;
      instructions?: string;
      model?: string;
      handoffs?: unknown[];
      inputGuardrails?: unknown[];
    }) {
      this.name = opts.name ?? 'agent';
      this.instructions = opts.instructions ?? '';
      this.model = opts.model ?? 'gpt-4.1';
      this.handoffs = opts.handoffs ?? [];
      this.inputGuardrails = opts.inputGuardrails ?? [];
      createdAgents.push({ name: this.name, handoffs: this.handoffs, model: this.model });
    }
  }

  const mockRunFn = async (agent: { name: string }) => {
    if (mockRunState.shouldThrow) throw new Error('mock SDK error');
    return { ...mockRunState.result, _agent: agent };
  };

  class MockRunner {
    run = vi.fn(mockRunFn);
  }

  class MockOpenAIProvider {}

  return {
    Agent: MockAgent,
    Runner: MockRunner,
    OpenAIProvider: MockOpenAIProvider,
    addTraceProcessor: vi.fn(),
    setTracingDisabled: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock node:fs for install provider tests
// ---------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('AGENTS.md')) return mockFsState.exists;
      return false;
    }),
    readFileSync: vi.fn(() => mockFsState.content),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock cant-context for spawn tests
// ---------------------------------------------------------------------------

vi.mock('../../cant-context.js', () => ({
  buildCantEnrichedPrompt: vi.fn(
    async ({ basePrompt }: { basePrompt: string }) => `[CANT] ${basePrompt}`,
  ),
}));

// ---------------------------------------------------------------------------
// Mock conduit-trace-writer to avoid CLI calls in unit tests
// ---------------------------------------------------------------------------

vi.mock('../../../providers/shared/conduit-trace-writer.js', () => ({
  writeSpanToConduit: vi.fn(async () => ({ written: true })),
  writeSpanBatchToConduit: vi.fn(async () => 0),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OpenAiSdkAdapter } from '../adapter.js';
import {
  buildDefaultGuardrails,
  buildPathGuardrail,
  buildToolAllowlistGuardrail,
  isPathAllowed,
} from '../guardrails.js';
import {
  buildAgentTopology,
  buildLeadAgent,
  buildStandaloneAgent,
  buildWorkerAgent,
  WORKER_ARCHETYPES,
} from '../handoff.js';
import { OpenAiSdkInstallProvider } from '../install.js';
import { OpenAiSdkSpawnProvider } from '../spawn.js';
import { CleoConduitTraceProcessor } from '../tracing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpanLike(overrides: Record<string, unknown> = {}): unknown {
  return {
    spanId: 'span-001',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    spanData: { type: 'agent', name: 'test-agent' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Path ACL helpers
// ---------------------------------------------------------------------------

describe('isPathAllowed', () => {
  it('allows all paths when glob list is empty', () => {
    expect(isPathAllowed('/any/path', [])).toBe(true);
  });

  it('allows a path matching a glob', () => {
    expect(isPathAllowed('/mnt/projects/foo.ts', ['/mnt/projects/**'])).toBe(true);
  });

  it('denies a path not matching any glob', () => {
    expect(isPathAllowed('/etc/passwd', ['/mnt/projects/**'])).toBe(false);
  });

  it('allows /tmp when /tmp/** is in the allowlist', () => {
    expect(isPathAllowed('/tmp/work.ts', ['/tmp/**'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guardrail builders
// ---------------------------------------------------------------------------

describe('buildPathGuardrail', () => {
  it('returns a guardrail named cleo_path_acl', () => {
    const guard = buildPathGuardrail(['/mnt/**']);
    expect(guard.name).toBe('cleo_path_acl');
  });

  it('passes when no path fields in input', async () => {
    const guard = buildPathGuardrail(['/allowed/**']);
    const result = await guard.execute({
      agent: {} as never,
      input: 'Tell me about the project',
      context: {} as never,
    });
    expect(result.tripwireTriggered).toBe(false);
  });

  it('trips when path field violates ACL', async () => {
    const guard = buildPathGuardrail(['/allowed/**']);
    const result = await guard.execute({
      agent: {} as never,
      input: JSON.stringify({ path: '/etc/shadow' }),
      context: {} as never,
    });
    expect(result.tripwireTriggered).toBe(true);
    expect((result.outputInfo as Record<string, unknown>).deniedPath).toBe('/etc/shadow');
  });

  it('passes when path field is within ACL', async () => {
    const guard = buildPathGuardrail(['/allowed/**']);
    const result = await guard.execute({
      agent: {} as never,
      input: JSON.stringify({ path: '/allowed/file.ts' }),
      context: {} as never,
    });
    expect(result.tripwireTriggered).toBe(false);
  });
});

describe('buildToolAllowlistGuardrail', () => {
  it('returns a guardrail named cleo_tool_allowlist', () => {
    const guard = buildToolAllowlistGuardrail(['read']);
    expect(guard.name).toBe('cleo_tool_allowlist');
  });

  it('always passes (structural enforcement)', async () => {
    const guard = buildToolAllowlistGuardrail(['read', 'bash']);
    const result = await guard.execute({
      agent: {} as never,
      input: 'run this',
      context: {} as never,
    });
    expect(result.tripwireTriggered).toBe(false);
    expect((result.outputInfo as Record<string, unknown>).checked).toBe(true);
  });
});

describe('buildDefaultGuardrails', () => {
  it('returns empty array when both lists are empty', () => {
    const guards = buildDefaultGuardrails([], []);
    expect(guards).toHaveLength(0);
  });

  it('includes path ACL guard when globs provided', () => {
    const guards = buildDefaultGuardrails(['/mnt/**'], []);
    expect(guards).toHaveLength(1);
    expect(guards[0]?.name).toBe('cleo_path_acl');
  });

  it('includes tool allowlist guard when tools provided', () => {
    const guards = buildDefaultGuardrails([], ['read']);
    expect(guards).toHaveLength(1);
    expect(guards[0]?.name).toBe('cleo_tool_allowlist');
  });

  it('includes both guards when both lists are non-empty', () => {
    const guards = buildDefaultGuardrails(['/mnt/**'], ['read']);
    expect(guards).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Handoff topology
// ---------------------------------------------------------------------------

describe('WORKER_ARCHETYPES', () => {
  it('contains worker-read, worker-write, worker-bash', () => {
    expect(WORKER_ARCHETYPES).toHaveProperty('worker-read');
    expect(WORKER_ARCHETYPES).toHaveProperty('worker-write');
    expect(WORKER_ARCHETYPES).toHaveProperty('worker-bash');
  });

  it('worker-read uses gpt-4.1-mini', () => {
    expect(WORKER_ARCHETYPES['worker-read']?.model).toBe('gpt-4.1-mini');
  });
});

describe('buildWorkerAgent', () => {
  it('returns null for unknown archetype', () => {
    expect(buildWorkerAgent('unknown-archetype', [])).toBeNull();
  });

  it('returns an Agent for a known archetype', () => {
    const agent = buildWorkerAgent('worker-read', []);
    expect(agent).not.toBeNull();
  });
});

describe('buildLeadAgent', () => {
  it('creates a lead agent with handoff workers', () => {
    const worker = buildWorkerAgent('worker-read', [])!;
    const lead = buildLeadAgent('You are a lead.', 'gpt-4.1', [worker], []);
    expect(lead).not.toBeNull();
  });
});

describe('buildStandaloneAgent', () => {
  it('creates an agent instance', () => {
    const agent = buildStandaloneAgent('Instructions', 'gpt-4.1-mini', []);
    expect(agent).not.toBeNull();
  });
});

describe('buildAgentTopology', () => {
  it('returns an agent when tier is worker', () => {
    const agent = buildAgentTopology({
      instructions: 'Do work',
      model: 'gpt-4.1-mini',
      tier: 'worker',
      handoffNames: ['worker-read'],
      guardrails: [],
    });
    expect(agent).not.toBeNull();
  });

  it('returns an agent when tier is lead', () => {
    const agent = buildAgentTopology({
      instructions: 'Lead the team',
      model: 'gpt-4.1',
      tier: 'lead',
      handoffNames: ['worker-read', 'worker-write'],
      guardrails: [],
    });
    expect(agent).not.toBeNull();
  });

  it('handles unknown archetype names gracefully', () => {
    const agent = buildAgentTopology({
      instructions: 'Lead',
      model: 'gpt-4.1',
      tier: 'lead',
      handoffNames: ['worker-read', 'nonexistent-worker'],
      guardrails: [],
    });
    expect(agent).not.toBeNull();
  });

  it('returns agent when tier is lead but no valid handoffs', () => {
    const agent = buildAgentTopology({
      instructions: 'Lead',
      model: 'gpt-4.1',
      tier: 'lead',
      handoffNames: [],
      guardrails: [],
    });
    expect(agent).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Spawn provider
// ---------------------------------------------------------------------------

describe('OpenAiSdkSpawnProvider', () => {
  let provider: OpenAiSdkSpawnProvider;

  beforeEach(() => {
    provider = new OpenAiSdkSpawnProvider();
    mockRunState.shouldThrow = false;
    mockRunState.result = { finalOutput: 'completed output' };
    createdAgents.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('canSpawn', () => {
    it('returns false when OPENAI_API_KEY is absent', async () => {
      const original = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const result = await provider.canSpawn();
      expect(result).toBe(false);
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    });

    it('returns true when OPENAI_API_KEY is set', async () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const result = await provider.canSpawn();
      expect(result).toBe(true);
      delete process.env.OPENAI_API_KEY;
    });
  });

  describe('listRunning', () => {
    it('returns empty array when no spawns are in progress', async () => {
      const running = await provider.listRunning();
      expect(running).toEqual([]);
    });
  });

  describe('terminate', () => {
    it('handles non-existent instance gracefully', async () => {
      await expect(provider.terminate('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('spawn — success path', () => {
    it('returns completed status on success', async () => {
      const result = await provider.spawn({
        taskId: 'T582',
        prompt: 'Do the work',
        options: { tier: 'worker', tracingDisabled: true },
      });
      expect(result.status).toBe('completed');
      expect(result.taskId).toBe('T582');
      expect(result.providerId).toBe('openai-sdk');
      expect(result.output).toBe('completed output');
      expect(result.endTime).toBeDefined();
    });

    it('has a valid instance ID prefixed with openai-sdk', async () => {
      const result = await provider.spawn({
        taskId: 'T582',
        prompt: 'Test',
        options: { tracingDisabled: true },
      });
      expect(result.instanceId).toMatch(/^openai-sdk-/);
    });
  });

  describe('spawn — failure path', () => {
    it('returns failed status when SDK throws', async () => {
      mockRunState.shouldThrow = true;
      const result = await provider.spawn({
        taskId: 'T582',
        prompt: 'Failing task',
        options: { tracingDisabled: true },
      });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('mock SDK error');
      expect(result.endTime).toBeDefined();
    });
  });

  describe('spawn — model override', () => {
    it('accepts explicit model option without error', async () => {
      const result = await provider.spawn({
        taskId: 'T582',
        prompt: 'Custom model',
        options: { model: 'gpt-4o', tier: 'worker', tracingDisabled: true },
      });
      expect(result.status).toBe('completed');
    });
  });
});

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

describe('OpenAiSdkAdapter', () => {
  let adapter: OpenAiSdkAdapter;

  beforeEach(() => {
    adapter = new OpenAiSdkAdapter();
  });

  afterEach(async () => {
    if (adapter.isInitialized()) await adapter.dispose();
    vi.clearAllMocks();
  });

  describe('identity', () => {
    it('has id openai-sdk', () => expect(adapter.id).toBe('openai-sdk'));
    it('has name OpenAI Agents SDK', () => expect(adapter.name).toBe('OpenAI Agents SDK'));
    it('has version 1.0.0', () => expect(adapter.version).toBe('1.0.0'));
  });

  describe('capabilities', () => {
    it('supports spawn', () => expect(adapter.capabilities.supportsSpawn).toBe(true));
    it('supports install', () => expect(adapter.capabilities.supportsInstall).toBe(true));
    it('does not support hooks', () => expect(adapter.capabilities.supportsHooks).toBe(false));
    it('uses AGENTS.md instruction pattern', () =>
      expect(adapter.capabilities.instructionFilePattern).toBe('AGENTS.md'));
  });

  describe('sub-providers', () => {
    it('provides a spawn provider', () =>
      expect(adapter.spawn).toBeInstanceOf(OpenAiSdkSpawnProvider));
    it('provides an install provider', () =>
      expect(adapter.install).toBeInstanceOf(OpenAiSdkInstallProvider));
  });

  describe('initialize', () => {
    it('sets initialized state', async () => {
      expect(adapter.isInitialized()).toBe(false);
      await adapter.initialize('/tmp/project');
      expect(adapter.isInitialized()).toBe(true);
    });

    it('stores project directory', async () => {
      await adapter.initialize('/tmp/project');
      expect(adapter.getProjectDir()).toBe('/tmp/project');
    });
  });

  describe('dispose', () => {
    it('resets initialized state', async () => {
      await adapter.initialize('/tmp/project');
      await adapter.dispose();
      expect(adapter.isInitialized()).toBe(false);
      expect(adapter.getProjectDir()).toBeNull();
    });
  });

  describe('healthCheck', () => {
    it('returns unhealthy when not initialized', async () => {
      const status = await adapter.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.details?.error).toBe('Adapter not initialized');
    });

    it('returns unhealthy when API key absent', async () => {
      const original = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      await adapter.initialize('/tmp/project');
      const status = await adapter.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.details?.apiKeyPresent).toBe(false);
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    });

    it('returns healthy when API key present', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      await adapter.initialize('/tmp/project');
      const status = await adapter.healthCheck();
      expect(status.healthy).toBe(true);
      delete process.env.OPENAI_API_KEY;
    });
  });
});

// ---------------------------------------------------------------------------
// Install provider
// ---------------------------------------------------------------------------

describe('OpenAiSdkInstallProvider', () => {
  let installProvider: OpenAiSdkInstallProvider;

  beforeEach(() => {
    installProvider = new OpenAiSdkInstallProvider();
    mockFsState.exists = false;
    mockFsState.content = '';
  });

  afterEach(() => vi.clearAllMocks());

  describe('isInstalled', () => {
    it('returns false (no plugin registry for SDK)', async () => {
      const result = await installProvider.isInstalled();
      expect(result).toBe(false);
    });
  });

  describe('install', () => {
    it('returns success result', async () => {
      const result = await installProvider.install({ projectDir: '/tmp/project' });
      expect(result.success).toBe(true);
      expect(result.installedAt).toBeTruthy();
    });

    it('marks instructionFileUpdated when AGENTS.md is created', async () => {
      mockFsState.exists = false;
      const result = await installProvider.install({ projectDir: '/tmp/project' });
      expect(result.instructionFileUpdated).toBe(true);
    });

    it('does not mark updated when references already present', async () => {
      mockFsState.exists = true;
      mockFsState.content = '@~/.cleo/templates/CLEO-INJECTION.md\n@.cleo/memory-bridge.md\n';
      const result = await installProvider.install({ projectDir: '/tmp/project' });
      expect(result.instructionFileUpdated).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('resolves without error', async () => {
      await expect(installProvider.uninstall()).resolves.toBeUndefined();
    });
  });

  describe('ensureInstructionReferences', () => {
    it('resolves without error', async () => {
      await expect(
        installProvider.ensureInstructionReferences('/tmp/project'),
      ).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Trace processor
// ---------------------------------------------------------------------------

describe('CleoConduitTraceProcessor', () => {
  let processor: CleoConduitTraceProcessor;

  beforeEach(() => {
    processor = new CleoConduitTraceProcessor('T582-test');
  });

  afterEach(() => vi.clearAllMocks());

  describe('onTraceStart', () => {
    it('resolves without error', async () => {
      await expect(processor.onTraceStart({} as never)).resolves.toBeUndefined();
    });
  });

  describe('onTraceEnd', () => {
    it('resolves without error', async () => {
      await expect(processor.onTraceEnd({} as never)).resolves.toBeUndefined();
    });
  });

  describe('onSpanStart', () => {
    it('resolves without error', async () => {
      await expect(processor.onSpanStart({} as never)).resolves.toBeUndefined();
    });
  });

  describe('onSpanEnd', () => {
    it('does not throw for a well-formed span', async () => {
      const span = makeSpanLike();
      await expect(processor.onSpanEnd(span as never)).resolves.toBeUndefined();
    });

    it('does not throw for a span with missing fields', async () => {
      await expect(processor.onSpanEnd({} as never)).resolves.toBeUndefined();
    });
  });

  describe('shutdown', () => {
    it('resolves without error', async () => {
      await expect(processor.shutdown(1000)).resolves.toBeUndefined();
    });
  });

  describe('forceFlush', () => {
    it('resolves without error', async () => {
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Handoff integration: lead + workers with mocked runner
// ---------------------------------------------------------------------------

describe('Handoff integration — lead routes to workers via SDK', () => {
  let provider: OpenAiSdkSpawnProvider;

  beforeEach(() => {
    provider = new OpenAiSdkSpawnProvider();
    mockRunState.shouldThrow = false;
    mockRunState.result = { finalOutput: 'handoff result' };
    createdAgents.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a lead agent when tier is lead with handoffs', async () => {
    const result = await provider.spawn({
      taskId: 'T582-handoff',
      prompt: 'Research and implement feature',
      options: {
        tier: 'lead',
        handoffs: ['worker-read', 'worker-write'],
        tracingDisabled: true,
      },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('handoff result');

    // A cleo-lead agent should have been created with 2 handoff workers
    const leadAgent = createdAgents.find((a) => a.name === 'cleo-lead');
    expect(leadAgent).toBeDefined();
    expect(leadAgent?.handoffs).toHaveLength(2);
  });

  it('result reflects correct providerId and taskId', async () => {
    const result = await provider.spawn({
      taskId: 'T582-verify',
      prompt: 'Verify result',
      options: { tier: 'lead', handoffs: ['worker-read'], tracingDisabled: true },
    });

    expect(result.providerId).toBe('openai-sdk');
    expect(result.taskId).toBe('T582-verify');
    expect(result.instanceId).toMatch(/^openai-sdk-/);
  });

  it('handoff workers use worker archetype model (gpt-4.1-mini)', async () => {
    createdAgents.length = 0;
    await provider.spawn({
      taskId: 'T582-model',
      prompt: 'Work',
      options: {
        tier: 'lead',
        handoffs: ['worker-read', 'worker-bash'],
        tracingDisabled: true,
      },
    });

    // Worker archetypes should use gpt-4.1-mini
    const workerAgents = createdAgents.filter(
      (a) => a.name === 'worker-read' || a.name === 'worker-bash',
    );
    expect(workerAgents.length).toBe(2);
    for (const worker of workerAgents) {
      expect(worker.model).toBe('gpt-4.1-mini');
    }
  });
});
