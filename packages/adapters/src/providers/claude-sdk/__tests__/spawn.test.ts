/**
 * Tests for ClaudeSDKSpawnProvider
 *
 * The SDK `query()` function is mocked so tests run without a real
 * ANTHROPIC_API_KEY or network connection.
 *
 * @task T581
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSDKSpawnProvider } from '../spawn.js';

// ---------------------------------------------------------------------------
// Mock the SDK module
// ---------------------------------------------------------------------------

/** Minimal SDK message iterator builder for tests. */
function makeQueryIterator(messages: Array<Record<string, unknown>>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock CANT enrichment so tests don't need the cleo CLI.
vi.mock('../../../cant-context.js', () => ({
  buildCantEnrichedPrompt: vi.fn(({ basePrompt }: { basePrompt: string }) =>
    Promise.resolve(basePrompt),
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getQueryMock() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSDKSpawnProvider', () => {
  let provider: ClaudeSDKSpawnProvider;

  beforeEach(() => {
    provider = new ClaudeSDKSpawnProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      // Mock fs.existsSync to return false for all key paths so no tier
      // resolves (env var, stored key file, or OAuth credentials file).
      const { existsSync } = await import('node:fs');
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      vi.spyOn({ existsSync }, 'existsSync').mockReturnValue(false);
      // Use vi.mock for node:fs to prevent reading real ~/.claude/.credentials.json
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn().mockImplementation(() => {
          throw new Error('mocked: file not found');
        }),
      }));
      try {
        // Re-import spawn module with mocked fs to get fresh resolver state
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
    it('returns completed status with aggregated output', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-abc',
            tools: [],
            mcp_servers: [],
            model: 'claude-sonnet-4-5',
            permissionMode: 'bypassPermissions',
            cwd: '/tmp',
            slash_commands: [],
            output_style: 'auto',
          },
          {
            type: 'assistant',
            session_id: 'sess-abc',
            message: {
              content: [
                { type: 'text', text: 'Hello from' },
                { type: 'text', text: ' the SDK.' },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-abc',
            result: 'Done.',
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 80,
            num_turns: 1,
            total_cost_usd: 0.001,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      const result = await provider.spawn({
        taskId: 'T001',
        prompt: 'Do something.',
        workingDirectory: '/tmp',
      });

      expect(result.status).toBe('completed');
      expect(result.providerId).toBe('claude-sdk');
      expect(result.taskId).toBe('T001');
      expect(result.output).toContain('Hello from');
      expect(result.output).toContain('the SDK.');
      expect(result.output).toContain('Done.');
      expect(result.exitCode).toBe(0);
      expect(result.startTime).toBeTruthy();
      expect(result.endTime).toBeTruthy();
    });

    it('passes allowedTools from context options', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-xyz',
            result: '',
            is_error: false,
            duration_ms: 10,
            duration_api_ms: 8,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      await provider.spawn({
        taskId: 'T002',
        prompt: 'Read only.',
        options: { toolAllowlist: ['Read', 'Grep'] },
      });

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: ['Read', 'Grep'],
          }),
        }),
      );
    });

    it('uses default tools when no toolAllowlist provided', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-xyz',
            result: '',
            is_error: false,
            duration_ms: 10,
            duration_api_ms: 8,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      await provider.spawn({ taskId: 'T003', prompt: 'Default tools.' });

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            allowedTools: expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
          }),
        }),
      );
    });

    it('sets permissionMode to bypassPermissions', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-perm',
            result: '',
            is_error: false,
            duration_ms: 5,
            duration_api_ms: 4,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      await provider.spawn({ taskId: 'T004', prompt: 'Permissions.' });

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // spawn — error paths
  // -------------------------------------------------------------------------

  describe('spawn() — error handling', () => {
    it('returns failed status on SDK error subtype', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'error_during_execution',
            session_id: 'sess-err',
            is_error: true,
            errors: ['Something went wrong'],
            duration_ms: 50,
            duration_api_ms: 40,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      const result = await provider.spawn({ taskId: 'T005', prompt: 'Fail.' });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Something went wrong');
    });

    it('returns failed status when query() throws', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockImplementation(() => {
        throw new Error('Network error');
      });

      const result = await provider.spawn({ taskId: 'T006', prompt: 'Throw.' });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('Network error');
    });

    it('returns failed status when error_max_turns reached', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'error_max_turns',
            session_id: 'sess-max',
            is_error: true,
            errors: [],
            duration_ms: 200,
            duration_api_ms: 180,
            num_turns: 10,
            total_cost_usd: 0.05,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      const result = await provider.spawn({ taskId: 'T007', prompt: 'Max turns.' });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Session resume
  // -------------------------------------------------------------------------

  describe('spawn() — session resume', () => {
    it('passes resume option when resumeSessionId is provided', async () => {
      const queryMock = await getQueryMock();
      queryMock.mockReturnValue(
        makeQueryIterator([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-resume',
            result: 'resumed',
            is_error: false,
            duration_ms: 20,
            duration_api_ms: 15,
            num_turns: 1,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          },
        ]),
      );

      await provider.spawn({
        taskId: 'T008',
        prompt: 'Continue work.',
        options: { resumeSessionId: 'prior-session-id' },
      });

      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: 'prior-session-id',
          }),
        }),
      );
    });
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
