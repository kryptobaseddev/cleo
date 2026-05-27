/**
 * Tests for ClaudeSDKSpawnProvider — Vercel AI SDK edition.
 *
 * The Vercel AI SDK `generateText` call is mocked via a CLEO-native mock
 * that returns a deterministic response. Tests run without a real
 * ANTHROPIC_API_KEY or network connection.
 *
 * @task T581 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSDKSpawnProvider } from '../spawn.js';

// ---------------------------------------------------------------------------
// Mock Vercel AI SDK surface
// ---------------------------------------------------------------------------

/** Shared mock state tracked across tests. */
const { mockState } = vi.hoisted(() => {
  return {
    mockState: {
      text: 'mocked claude response',
      shouldThrow: false,
      lastCall: null as null | { model: unknown; prompt: string },
    },
  };
});

// Mock the '@ai-sdk/anthropic' surface: createAnthropic returns a factory
// function that produces a LanguageModel stand-in. CLEO only consumes the
// return value as an opaque handle passed to generateText.
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((_config: { apiKey: string }) => {
    return (modelId: string) => ({ __cleoMockModel: true, modelId });
  }),
}));

// Mock 'ai' generateText to drive deterministic test outputs.
vi.mock('ai', () => ({
  generateText: vi.fn(async ({ model, prompt }: { model: unknown; prompt: string }) => {
    mockState.lastCall = { model, prompt };
    if (mockState.shouldThrow) {
      throw new Error('mock AI SDK error');
    }
    return { text: mockState.text };
  }),
}));

// Mock CANT enrichment so tests don't need the cleo CLI.
vi.mock('../../../cant-context.js', () => ({
  buildCantEnrichedPrompt: vi.fn(({ basePrompt }: { basePrompt: string }) =>
    Promise.resolve(basePrompt),
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSDKSpawnProvider', () => {
  let provider: ClaudeSDKSpawnProvider;

  beforeEach(() => {
    provider = new ClaudeSDKSpawnProvider();
    mockState.shouldThrow = false;
    mockState.text = 'mocked claude response';
    mockState.lastCall = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockState.shouldThrow = false;
  });

  // -------------------------------------------------------------------------
  // canSpawn — 3-tier key resolution (T752)
  // -------------------------------------------------------------------------

  describe('canSpawn()', () => {
    it('returns true when ANTHROPIC_API_KEY is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect(await provider.canSpawn()).toBe(true);
    });

    it('returns false when no credentials are available', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      // Mock node:fs so the stored-key file and OAuth creds both fail to resolve.
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockImplementation(() => {
          throw new Error('mocked: file not found');
        }),
      }));
      try {
        vi.resetModules();
        const { ClaudeSDKSpawnProvider: FreshProvider } = await import('../spawn.js');
        const freshProvider = new FreshProvider();
        expect(await freshProvider.canSpawn()).toBe(false);
      } finally {
        vi.resetModules();
        vi.doUnmock('node:fs');
        if (saved !== undefined) {
          process.env.ANTHROPIC_API_KEY = saved;
        }
      }
    });

    it('returns true when OAuth credentials file exists (no API key env var)', async () => {
      const validCreds = JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 3_600_000, // 1 hour from now
        },
      });
      vi.doMock('node:fs', () => ({
        existsSync: vi
          .fn()
          .mockImplementation((p: string) => String(p).endsWith('.credentials.json')),
        readFileSync: vi.fn().mockImplementation((p: string) => {
          if (String(p).endsWith('.credentials.json')) return validCreds;
          throw new Error('mocked: file not found');
        }),
      }));
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        vi.resetModules();
        const { ClaudeSDKSpawnProvider: FreshProvider } = await import('../spawn.js');
        const freshProvider = new FreshProvider();
        expect(await freshProvider.canSpawn()).toBe(true);
      } finally {
        vi.resetModules();
        vi.doUnmock('node:fs');
        if (saved !== undefined) {
          process.env.ANTHROPIC_API_KEY = saved;
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // listRunning / terminate
  // -------------------------------------------------------------------------

  describe('listRunning()', () => {
    it('returns empty array when no spawns are active', async () => {
      expect(await provider.listRunning()).toEqual([]);
    });
  });

  describe('terminate()', () => {
    it('is a no-op for unknown instance IDs', async () => {
      await expect(provider.terminate('nonexistent')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // spawn — success path
  // -------------------------------------------------------------------------

  describe('spawn() — success', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
    });
    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('returns completed status with generated output', async () => {
      mockState.text = 'Hello from the SDK.';

      const result = await provider.spawn({
        taskId: 'T001',
        prompt: 'Do something.',
        workingDirectory: '/tmp',
      });

      expect(result.status).toBe('completed');
      expect(result.providerId).toBe('claude-sdk');
      expect(result.taskId).toBe('T001');
      expect(result.output).toBe('Hello from the SDK.');
      expect(result.exitCode).toBe(0);
      expect(result.startTime).toBeTruthy();
      expect(result.endTime).toBeTruthy();
    });

    it('forwards the enriched prompt to generateText', async () => {
      await provider.spawn({
        taskId: 'T002',
        prompt: 'Describe the project.',
      });

      expect(mockState.lastCall?.prompt).toBe('Describe the project.');
    });

    it('uses the default model when none is specified', async () => {
      await provider.spawn({
        taskId: 'T003',
        prompt: 'Default model.',
      });

      const model = mockState.lastCall?.model as
        | { __cleoMockModel: true; modelId: string }
        | undefined;
      expect(model?.modelId).toBe('claude-sonnet-4-5');
    });

    it('uses the requested model when provided in options', async () => {
      await provider.spawn({
        taskId: 'T004',
        prompt: 'Override model.',
        options: { model: 'claude-sonnet-4-6' },
      });

      const model = mockState.lastCall?.model as
        | { __cleoMockModel: true; modelId: string }
        | undefined;
      expect(model?.modelId).toBe('claude-sonnet-4-6');
    });
  });

  // -------------------------------------------------------------------------
  // spawn — error paths
  // -------------------------------------------------------------------------

  describe('spawn() — error handling', () => {
    it('returns failed status when no Anthropic credentials exist', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockImplementation(() => {
          throw new Error('mocked: file not found');
        }),
      }));
      try {
        vi.resetModules();
        const { ClaudeSDKSpawnProvider: FreshProvider } = await import('../spawn.js');
        const freshProvider = new FreshProvider();
        const result = await freshProvider.spawn({
          taskId: 'T005',
          prompt: 'No creds.',
        });
        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(1);
        expect(result.error).toContain('No Anthropic credentials');
      } finally {
        vi.resetModules();
        vi.doUnmock('node:fs');
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
    });

    it('returns failed status when generateText throws', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockState.shouldThrow = true;

      const result = await provider.spawn({ taskId: 'T006', prompt: 'Throw.' });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('mock AI SDK error');
      delete process.env.ANTHROPIC_API_KEY;
    });
  });
});

describe('ClaudeSDKAdapter', () => {
  it('exports a default CLEOProviderAdapter-compatible class', async () => {
    const mod = await import('../index.js');
    const adapter = new mod.default();

    expect(adapter.id).toBe('claude-sdk');
    expect(adapter.name).toBe('Claude SDK (Vercel AI SDK)');
    expect(adapter.version).toBe('2.0.0');
    expect(adapter.capabilities.supportsSpawn).toBe(true);
    expect(adapter.spawn).toBeInstanceOf(mod.ClaudeSDKSpawnProvider);
  });
});

// ---------------------------------------------------------------------------
// SessionStore unit tests
// ---------------------------------------------------------------------------

describe('SessionStore', () => {
  it('stores and retrieves entries', async () => {
    const { SessionStore } = await import('../session-store.js');
    const store = new SessionStore();

    store.add({ instanceId: 'i1', sessionId: undefined, taskId: 'T1', startTime: '2026-01-01' });
    expect(store.get('i1')).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it('updates session ID', async () => {
    const { SessionStore } = await import('../session-store.js');
    const store = new SessionStore();

    store.add({ instanceId: 'i2', sessionId: undefined, taskId: 'T2', startTime: '2026-01-01' });
    store.setSessionId('i2', 'sdk-session-123');
    expect(store.get('i2')?.sessionId).toBe('sdk-session-123');
  });

  it('removes entries', async () => {
    const { SessionStore } = await import('../session-store.js');
    const store = new SessionStore();

    store.add({ instanceId: 'i3', sessionId: undefined, taskId: 'T3', startTime: '2026-01-01' });
    store.remove('i3');
    expect(store.get('i3')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('lists active entries', async () => {
    const { SessionStore } = await import('../session-store.js');
    const store = new SessionStore();

    store.add({ instanceId: 'i4', sessionId: undefined, taskId: 'T4', startTime: '2026-01-01' });
    store.add({ instanceId: 'i5', sessionId: undefined, taskId: 'T5', startTime: '2026-01-02' });
    expect(store.listActive()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ToolBridge unit tests
// ---------------------------------------------------------------------------

describe('resolveTools()', () => {
  it('returns default tools when called with no args', async () => {
    const { resolveTools, DEFAULT_TOOLS } = await import('../tool-bridge.js');
    expect(resolveTools()).toEqual([...DEFAULT_TOOLS]);
  });

  it('returns provided list unchanged', async () => {
    const { resolveTools } = await import('../tool-bridge.js');
    expect(resolveTools(['Read', 'Bash'])).toEqual(['Read', 'Bash']);
  });

  it('returns default tools when empty array passed', async () => {
    const { resolveTools, DEFAULT_TOOLS } = await import('../tool-bridge.js');
    expect(resolveTools([])).toEqual([...DEFAULT_TOOLS]);
  });
});
