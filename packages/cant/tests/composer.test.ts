/**
 * Unit tests for the JIT Agent Composer ({@link composeSpawnPayload}).
 *
 * @remarks
 * These tests exercise the full composition pipeline: context resolution,
 * mental model injection, token budget enforcement, and tier escalation.
 * A mock {@link ContextProvider} returns predetermined slices to isolate
 * the composer logic from BRAIN.
 *
 * Vitest with describe/it blocks per project conventions.
 */

import { describe, expect, it } from 'vitest';
import {
  type AgentDefinition,
  type ContextProvider,
  type ContextSlice,
  type MentalModelSlice,
  TIER_CAPS,
  composeSpawnPayload,
  escalateTier,
  estimateTokens,
} from '../src/composer';

// ---------------------------------------------------------------------------
// Mock ContextProvider
// ---------------------------------------------------------------------------

/**
 * Create a mock {@link ContextProvider} that returns predetermined slices.
 *
 * @param contextMap - Map of source name to content string.
 * @param mentalModelContent - Content for the mental model, or empty string.
 * @returns A mock context provider.
 */
function createMockProvider(
  contextMap: Record<string, string> = {},
  mentalModelContent = '',
): ContextProvider {
  return {
    async queryContext(source: string, _query: string, _maxTokens: number): Promise<ContextSlice> {
      const content = contextMap[source] ?? '';
      return {
        source,
        content,
        tokens: estimateTokens(content),
      };
    },
    async loadMentalModel(
      _agentName: string,
      _projectHash: string,
      _maxTokens: number,
    ): Promise<MentalModelSlice> {
      return {
        content: mentalModelContent,
        tokens: estimateTokens(mentalModelContent),
        lastConsolidated: mentalModelContent.length > 0 ? '2026-04-01T00:00:00Z' : null,
      };
    },
  };
}

/**
 * Create a minimal {@link AgentDefinition} with sensible defaults.
 *
 * @param overrides - Partial overrides for the agent definition.
 * @returns A complete agent definition.
 */
function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test-agent',
    tier: 'mid',
    prompt: 'You are a test agent.',
    skills: ['ct-cleo'],
    tools: ['Read', 'Edit', 'Bash'],
    contextSources: [],
    mentalModel: null,
    onOverflow: 'escalate_tier',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escalateTier
// ---------------------------------------------------------------------------

describe('escalateTier', () => {
  it('escalates low to mid', () => {
    expect(escalateTier('low')).toBe('mid');
  });

  it('escalates mid to high', () => {
    expect(escalateTier('mid')).toBe('high');
  });

  it('returns null at high (cannot escalate further)', () => {
    expect(escalateTier('high')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates roughly 4 chars per token', () => {
    // 12 chars -> ceil(12/4) = 3 tokens
    expect(estimateTokens('Hello World!')).toBe(3);
  });

  it('rounds up for non-divisible lengths', () => {
    // 5 chars -> ceil(5/4) = 2 tokens
    expect(estimateTokens('Hello')).toBe(2);
  });

  it('handles long text proportionally', () => {
    const text = 'a'.repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// composeSpawnPayload
// ---------------------------------------------------------------------------

describe('composeSpawnPayload', () => {
  it('returns base prompt only with empty context sources', async () => {
    const agent = createAgent({ contextSources: [] });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPrompt).toBe('You are a test agent.');
    expect(payload.injectedContextSources).toEqual([]);
    expect(payload.mentalModelInjected).toBe(false);
    expect(payload.resolvedTier).toBe('mid');
    expect(payload.escalated).toBe(false);
  });

  it('injects context sources into system prompt', async () => {
    const agent = createAgent({
      contextSources: [
        { source: 'patterns', query: 'DRY', maxEntries: 5 },
        { source: 'decisions', query: 'auth', maxEntries: 3 },
      ],
    });
    const provider = createMockProvider({
      patterns: 'Use DRY principle everywhere.',
      decisions: 'We chose JWT for auth.',
    });

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPrompt).toContain('## Context (JIT-injected)');
    expect(payload.systemPrompt).toContain('### patterns');
    expect(payload.systemPrompt).toContain('Use DRY principle everywhere.');
    expect(payload.systemPrompt).toContain('### decisions');
    expect(payload.systemPrompt).toContain('We chose JWT for auth.');
    expect(payload.injectedContextSources).toEqual(['patterns', 'decisions']);
  });

  it('injects mental model with validation prefix', async () => {
    const agent = createAgent({
      mentalModel: {
        enabled: true,
        scope: 'project',
        maxTokens: 1000,
        validateOnLoad: true,
      },
    });
    const provider = createMockProvider({}, 'The project uses monorepo with pnpm.');

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPrompt).toContain('## Mental Model (validate before acting)');
    expect(payload.systemPrompt).toContain('VALIDATE THIS MENTAL MODEL');
    expect(payload.systemPrompt).toContain('Re-evaluate each claim against current code state');
    expect(payload.systemPrompt).toContain('The project uses monorepo with pnpm.');
    expect(payload.mentalModelInjected).toBe(true);
  });

  it('respects tier token caps for low tier (no context or mental model)', async () => {
    const agent = createAgent({
      tier: 'low',
      contextSources: [{ source: 'patterns', query: 'test', maxEntries: 5 }],
      mentalModel: {
        enabled: true,
        scope: 'project',
        maxTokens: 500,
        validateOnLoad: true,
      },
    });
    // Low tier has 0 contextSources and 0 mentalModel budget
    const provider = createMockProvider({ patterns: 'Some content' }, 'Some mental model');

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    // Low tier contextSources cap = 0, so no context should be injected
    expect(payload.injectedContextSources).toEqual([]);
    // Low tier mentalModel cap = 0, so mental model should not be injected
    expect(payload.mentalModelInjected).toBe(false);
  });

  it('escalates low to mid when base prompt exceeds low tier cap', async () => {
    // Low tier systemPrompt cap = 4000 tokens = ~16000 chars
    const largePrompt = 'x'.repeat(16004); // Just over 4000 tokens -> 4001 tokens
    const agent = createAgent({
      tier: 'low',
      prompt: largePrompt,
      onOverflow: 'escalate_tier',
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.declaredTier).toBe('low');
    expect(payload.resolvedTier).toBe('mid');
    expect(payload.escalated).toBe(true);
    expect(payload.model).toBe('claude-sonnet-4-6');
  });

  it('escalates mid to high when needed', async () => {
    // Mid tier systemPrompt cap = 12000 tokens = ~48000 chars
    const largePrompt = 'y'.repeat(48004); // Just over 12000 tokens -> 12001 tokens
    const agent = createAgent({
      tier: 'mid',
      prompt: largePrompt,
      onOverflow: 'escalate_tier',
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.declaredTier).toBe('mid');
    expect(payload.resolvedTier).toBe('high');
    expect(payload.escalated).toBe(true);
    expect(payload.model).toBe('claude-opus-4-6');
  });

  it('throws when high tier exceeded and onOverflow is fail', async () => {
    // High tier systemPrompt cap = 32000 tokens = ~128000 chars
    const hugePrompt = 'z'.repeat(128004); // Just over 32000 tokens
    const agent = createAgent({
      tier: 'high',
      prompt: hugePrompt,
      onOverflow: 'fail',
    });
    const provider = createMockProvider();

    await expect(composeSpawnPayload(agent, provider, 'proj-abc')).rejects.toThrow(
      /onOverflow is 'fail'/,
    );
  });

  it('throws when high tier exceeded even with escalate_tier', async () => {
    // High tier systemPrompt cap = 32000 tokens = ~128000 chars
    const hugePrompt = 'z'.repeat(128004); // Just over 32000 tokens
    const agent = createAgent({
      tier: 'high',
      prompt: hugePrompt,
      onOverflow: 'escalate_tier',
    });
    const provider = createMockProvider();

    await expect(composeSpawnPayload(agent, provider, 'proj-abc')).rejects.toThrow(
      /cannot escalate further/,
    );
  });

  it('selects correct model per tier', async () => {
    const lowAgent = createAgent({ tier: 'low', prompt: 'short' });
    const midAgent = createAgent({ tier: 'mid', prompt: 'short' });
    const highAgent = createAgent({ tier: 'high', prompt: 'short' });
    const provider = createMockProvider();

    const lowPayload = await composeSpawnPayload(lowAgent, provider, 'proj-abc');
    const midPayload = await composeSpawnPayload(midAgent, provider, 'proj-abc');
    const highPayload = await composeSpawnPayload(highAgent, provider, 'proj-abc');

    expect(lowPayload.model).toBe('claude-haiku-4-5');
    expect(lowPayload.fallbackModels).toEqual(['kimi-k2.5']);

    expect(midPayload.model).toBe('claude-sonnet-4-6');
    expect(midPayload.fallbackModels).toEqual(['kimi-k2.5', 'claude-haiku-4-5']);

    expect(highPayload.model).toBe('claude-opus-4-6');
    expect(highPayload.fallbackModels).toEqual(['claude-sonnet-4-6', 'kimi-k2.5']);
  });

  it('marks escalation in payload correctly', async () => {
    // Create a prompt that fits in mid (12000 tokens) but not in low (4000 tokens)
    // 4001 tokens = 16004 chars
    const mediumPrompt = 'a'.repeat(16004);
    const agent = createAgent({
      tier: 'low',
      prompt: mediumPrompt,
      onOverflow: 'escalate_tier',
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.escalated).toBe(true);
    expect(payload.declaredTier).toBe('low');
    expect(payload.resolvedTier).toBe('mid');
    expect(payload.agentName).toBe('test-agent');
  });

  it('does not escalate when content fits within declared tier', async () => {
    const agent = createAgent({
      tier: 'mid',
      prompt: 'A short prompt.',
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.escalated).toBe(false);
    expect(payload.declaredTier).toBe('mid');
    expect(payload.resolvedTier).toBe('mid');
  });

  it('escalates through multiple tiers (low -> high) when needed', async () => {
    // Create a prompt that exceeds mid tier too (12000 tokens = 48000 chars)
    const veryLargePrompt = 'b'.repeat(48004); // 12001 tokens, exceeds mid
    const agent = createAgent({
      tier: 'low',
      prompt: veryLargePrompt,
      onOverflow: 'escalate_tier',
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.declaredTier).toBe('low');
    expect(payload.resolvedTier).toBe('high');
    expect(payload.escalated).toBe(true);
    expect(payload.model).toBe('claude-opus-4-6');
  });

  it('preserves skills and tools in the payload', async () => {
    const agent = createAgent({
      skills: ['ct-cleo', 'ct-orchestrator', 'forge-ts'],
      tools: ['Read', 'Edit', 'Bash', 'Grep'],
    });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.skills).toEqual(['ct-cleo', 'ct-orchestrator', 'forge-ts']);
    expect(payload.tools).toEqual(['Read', 'Edit', 'Bash', 'Grep']);
  });

  it('does not inject mental model when mental model is null', async () => {
    const agent = createAgent({ mentalModel: null });
    const provider = createMockProvider({}, 'This should not appear');

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.mentalModelInjected).toBe(false);
    expect(payload.systemPrompt).not.toContain('Mental Model');
  });

  it('does not inject mental model when mental model is disabled', async () => {
    const agent = createAgent({
      mentalModel: {
        enabled: false,
        scope: 'project',
        maxTokens: 1000,
        validateOnLoad: true,
      },
    });
    const provider = createMockProvider({}, 'This should not appear');

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.mentalModelInjected).toBe(false);
    expect(payload.systemPrompt).not.toContain('Mental Model');
  });

  it('computes systemPromptTokens accurately', async () => {
    const agent = createAgent({ prompt: 'A short prompt.' });
    const provider = createMockProvider();

    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPromptTokens).toBe(estimateTokens(payload.systemPrompt));
  });
});
