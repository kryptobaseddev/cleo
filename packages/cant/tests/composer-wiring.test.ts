/**
 * Composer Wiring Tests (T432)
 *
 * Verifies that `brainContextProvider` correctly implements the `ContextProvider`
 * interface from `composer.ts` and that `composeSpawnPayload` works end-to-end
 * with the BRAIN-backed provider using mocks.
 *
 * These tests exercise the T432 activation path without a real `brain.db` —
 * the BRAIN calls are mocked to return predetermined data.
 *
 * @task T432
 * @epic T377
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentDefinition,
  type ContextProvider,
  type SpawnPayload,
  composeSpawnPayload,
  estimateTokens,
} from '../src/composer.js';

// ---------------------------------------------------------------------------
// Mock @cleocode/core/internal before importing brainContextProvider
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core/internal', () => ({
  memoryFind: vi.fn(),
  memoryFetch: vi.fn(),
}));

// Import after mocking
const { memoryFind, memoryFetch } = await import('@cleocode/core/internal');
const { brainContextProvider } = await import('../src/context-provider-brain.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentDefinition for testing. */
function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test-agent',
    tier: 'mid',
    prompt: 'You are a test agent. Your task is to help with code.',
    skills: ['ct-cleo'],
    tools: ['Read', 'Edit'],
    contextSources: [],
    mentalModel: null,
    onOverflow: 'escalate_tier',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// brainContextProvider interface tests
// ---------------------------------------------------------------------------

describe('brainContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('queryContext', () => {
    it('returns empty slice when maxTokens is 0', async () => {
      const provider = brainContextProvider('/test/project');
      const result = await provider.queryContext('patterns', 'test query', 0);

      expect(result.source).toBe('patterns');
      expect(result.content).toBe('');
      expect(result.tokens).toBe(0);
      // memoryFind should not be called when budget is 0
      expect(memoryFind).not.toHaveBeenCalled();
    });

    it('returns empty slice when memoryFind returns no results', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: { results: [], total: 0 },
      });

      const provider = brainContextProvider('/test/project');
      const result = await provider.queryContext('patterns', 'DRY principle', 1000);

      expect(result.content).toBe('');
      expect(result.tokens).toBe(0);
    });

    it('fetches full entries when hits are found', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: {
          results: [{ id: 'P-abc123', title: 'DRY Pattern', type: 'pattern' }],
          total: 1,
        },
      });

      vi.mocked(memoryFetch).mockResolvedValue({
        success: true,
        data: {
          entries: [{ id: 'P-abc123', title: 'DRY Pattern', content: 'Do not repeat yourself.' }],
        },
      });

      const provider = brainContextProvider('/test/project');
      const result = await provider.queryContext('patterns', 'DRY', 1000);

      expect(result.source).toBe('patterns');
      expect(result.content).toContain('DRY Pattern');
      expect(result.content).toContain('Do not repeat yourself.');
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('falls back to titles when memoryFetch fails', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: {
          results: [{ id: 'P-abc123', title: 'DRY Pattern', type: 'pattern' }],
          total: 1,
        },
      });

      vi.mocked(memoryFetch).mockResolvedValue({
        success: false,
        error: { code: 'E_BRAIN_FETCH', message: 'DB error' },
      });

      const provider = brainContextProvider('/test/project');
      const result = await provider.queryContext('patterns', 'DRY', 1000);

      // Falls back to hit titles
      expect(result.content).toContain('DRY Pattern');
    });

    it('returns empty slice on memoryFind error', async () => {
      vi.mocked(memoryFind).mockRejectedValue(new Error('DB unavailable'));

      const provider = brainContextProvider('/test/project');
      const result = await provider.queryContext('patterns', 'DRY', 1000);

      expect(result.content).toBe('');
      expect(result.tokens).toBe(0);
    });

    it('truncates content to token budget', async () => {
      const longContent = 'x'.repeat(10000);
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: {
          results: [{ id: 'P-abc123', title: 'Long Entry', type: 'pattern' }],
          total: 1,
        },
      });
      vi.mocked(memoryFetch).mockResolvedValue({
        success: true,
        data: { entries: [{ id: 'P-abc123', title: 'Long Entry', content: longContent }] },
      });

      const provider = brainContextProvider('/test/project');
      // Budget of 100 tokens = ~400 chars
      const result = await provider.queryContext('patterns', 'test', 100);

      expect(result.tokens).toBeLessThanOrEqual(100);
      expect(result.content.length).toBeLessThanOrEqual(400 + 20); // title prefix included
    });
  });

  describe('loadMentalModel', () => {
    it('returns empty slice when maxTokens is 0', async () => {
      const provider = brainContextProvider('/test/project');
      const result = await provider.loadMentalModel('test-agent', 'proj-hash', 0);

      expect(result.content).toBe('');
      expect(result.tokens).toBe(0);
      expect(result.lastConsolidated).toBeNull();
      expect(memoryFind).not.toHaveBeenCalled();
    });

    it('includes agent filter in memoryFind call', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: { results: [], total: 0 },
      });

      const provider = brainContextProvider('/test/project');
      await provider.loadMentalModel('ops-lead', 'proj-abc', 1000);

      expect(memoryFind).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'ops-lead',
          tables: ['observations'],
        }),
        '/test/project',
      );
    });

    it('returns mental model content from observations', async () => {
      vi.mocked(memoryFind).mockResolvedValue({
        success: true,
        data: {
          results: [
            {
              id: 'O-abc123',
              title: 'Mental Model v2',
              type: 'observation',
              date: '2026-04-08T00:00:00Z',
            },
          ],
          total: 1,
        },
      });

      vi.mocked(memoryFetch).mockResolvedValue({
        success: true,
        data: {
          entries: [
            {
              id: 'O-abc123',
              title: 'Mental Model v2',
              content: 'The codebase uses pnpm monorepo.',
              date: '2026-04-08T00:00:00Z',
            },
          ],
        },
      });

      const provider = brainContextProvider('/test/project');
      const result = await provider.loadMentalModel('ops-lead', 'proj-abc', 1000);

      expect(result.content).toContain('Mental Model v2');
      expect(result.content).toContain('pnpm monorepo');
      expect(result.lastConsolidated).toBe('2026-04-08T00:00:00Z');
      expect(result.tokens).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: composeSpawnPayload + brainContextProvider
// ---------------------------------------------------------------------------

describe('composeSpawnPayload with brainContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('composes payload with empty BRAIN (no context sources)', async () => {
    const agent = makeAgent({ contextSources: [] });
    const provider = brainContextProvider('/test/project');

    const payload: SpawnPayload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.agentName).toBe('test-agent');
    expect(payload.resolvedTier).toBe('mid');
    expect(payload.injectedContextSources).toEqual([]);
    expect(payload.mentalModelInjected).toBe(false);
    expect(payload.systemPrompt).toContain('You are a test agent.');
  });

  it('injects BRAIN context into system prompt when hits are found', async () => {
    vi.mocked(memoryFind).mockResolvedValue({
      success: true,
      data: {
        results: [{ id: 'P-abc', title: 'DRY Pattern', type: 'pattern' }],
        total: 1,
      },
    });
    vi.mocked(memoryFetch).mockResolvedValue({
      success: true,
      data: {
        entries: [{ id: 'P-abc', title: 'DRY Pattern', content: 'Avoid code duplication.' }],
      },
    });

    const agent = makeAgent({
      contextSources: [{ source: 'patterns', query: 'DRY', maxEntries: 3 }],
    });
    const provider = brainContextProvider('/test/project');
    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPrompt).toContain('## Context (JIT-injected)');
    expect(payload.systemPrompt).toContain('DRY Pattern');
    expect(payload.systemPrompt).toContain('Avoid code duplication.');
    expect(payload.injectedContextSources).toContain('patterns');
  });

  it('provides correct token count for composed payload', async () => {
    vi.mocked(memoryFind).mockResolvedValue({
      success: true,
      data: { results: [], total: 0 },
    });

    const agent = makeAgent();
    const provider = brainContextProvider('/test/project');
    const payload = await composeSpawnPayload(agent, provider, 'proj-abc');

    expect(payload.systemPromptTokens).toBe(estimateTokens(payload.systemPrompt));
  });

  it('implements ContextProvider interface correctly', () => {
    const provider: ContextProvider = brainContextProvider('/test/project');

    // Structural check — both methods must exist and be functions.
    expect(typeof provider.queryContext).toBe('function');
    expect(typeof provider.loadMentalModel).toBe('function');
  });
});
