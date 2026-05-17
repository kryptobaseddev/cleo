/**
 * Unit tests for the /api/credentials endpoints (T9426 · E3 §5.3 T-E3-7).
 *
 * Covers:
 *   - GET returns SafeCredentialEntry projections WITHOUT accessToken,
 *     refreshToken, extraHeaders, or metadata fields.
 *   - POST validates provider against the closed builtin set, label
 *     and apiKey length, and whitespace handling.
 *   - POST upserts via `addCredential` and the response carries
 *     no secret material.
 *   - DELETE dispatches to the per-source RemovalStep, persists
 *     suppression, and drops the entry from the store.
 *
 * The `@cleocode/core/llm/*` modules are mocked so the suite runs
 * without touching `~/.cleo/llm-credentials.json` or any global state.
 *
 * @task T9426
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-7)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Mock state — shared across the credential-store / credential-pool /
// credential-removal modules so handler invocations behave deterministically.
// -----------------------------------------------------------------------------

interface MockCredential {
  provider: string;
  label: string;
  authType: 'api_key' | 'oauth' | 'aws_sdk';
  accessToken: string;
  source?: string;
  priority: number;
  expiresAt?: number | null;
  refreshToken?: string;
  extraHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  disabled?: boolean;
}

let mockStore: MockCredential[] = [];
let removalCalls: Array<{ sourceId: string; provider: string; label: string }> = [];
let suppressionCalls: Array<{ provider: string; sourceId: string }> = [];

vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => ({
    list: () => Promise.resolve(mockStore.slice()),
  }),
}));

vi.mock('@cleocode/core/llm/credentials-store.js', () => ({
  addCredential: vi.fn(async (input: Omit<MockCredential, 'priority'> & { priority?: number }) => {
    const remaining = mockStore.filter(
      (c) => !(c.provider === input.provider && c.label === input.label),
    );
    const maxPriority = remaining.reduce((m, c) => (c.priority > m ? c.priority : m), -10);
    const next: MockCredential = {
      ...input,
      priority: input.priority ?? maxPriority + 10,
    };
    mockStore = [...remaining, next];
    return next;
  }),
  removeCredential: vi.fn(async (provider: string, label: string) => {
    const before = mockStore.length;
    mockStore = mockStore.filter((c) => !(c.provider === provider && c.label === label));
    return mockStore.length < before;
  }),
}));

vi.mock('@cleocode/core/llm/credential-removal.js', () => ({
  REMOVAL_REGISTRY: {
    find: (sourceId: string) => ({
      sourceId,
      description: `mock removal for ${sourceId}`,
      remove: async (args: { provider: string; label: string }) => {
        removalCalls.push({ sourceId, provider: args.provider, label: args.label });
        return {
          cleaned: sourceId === 'claude-code' ? ['/tmp/.claude/credentials.json'] : [],
          hints: sourceId === 'env' ? ['unset $ANTHROPIC_API_KEY in your shell'] : [],
          suppress: sourceId !== 'manual',
        };
      },
    }),
  },
  addSuppression: vi.fn((provider: string, sourceId: string) => {
    suppressionCalls.push({ provider, sourceId });
  }),
}));

// -----------------------------------------------------------------------------
// Lazy-imported handlers (after mocks above)
// -----------------------------------------------------------------------------

async function importHandlers(): Promise<{
  GET: typeof import('../+server.js').GET;
  POST: typeof import('../+server.js').POST;
  DELETE: typeof import('../[provider]/[label]/+server.js').DELETE;
}> {
  const list = await import('../+server.js');
  const del = await import('../[provider]/[label]/+server.js');
  return { GET: list.GET, POST: list.POST, DELETE: del.DELETE };
}

function makeEvent<T>(partial: T): Parameters<typeof import('../+server.js').GET>[0] {
  return partial as unknown as Parameters<typeof import('../+server.js').GET>[0];
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

beforeEach(() => {
  mockStore = [];
  removalCalls = [];
  suppressionCalls = [];
});

describe('GET /api/credentials', () => {
  it('returns SafeCredentialEntry projections with NO secret fields', async () => {
    mockStore = [
      {
        provider: 'anthropic',
        label: 'work',
        authType: 'api_key',
        accessToken: 'sk-ant-secret-VALUE',
        refreshToken: 'refresh-secret',
        extraHeaders: { 'x-internal': 'leak-me' },
        metadata: { internal: 'data' },
        source: 'manual',
        priority: 0,
      },
    ];

    const { GET } = await importHandlers();
    const res = await GET(makeEvent({}));
    const body = (await (res as Response).json()) as {
      success: boolean;
      data: { entries: Array<Record<string, unknown>> };
    };

    expect(body.success).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    const entry = body.data.entries[0]!;

    // Required safe fields
    expect(entry['provider']).toBe('anthropic');
    expect(entry['label']).toBe('work');
    expect(entry['source']).toBe('manual');
    expect(entry['authType']).toBe('api_key');

    // CRITICAL: no secret fields whatsoever
    expect(entry['accessToken']).toBeUndefined();
    expect(entry['refreshToken']).toBeUndefined();
    expect(entry['extraHeaders']).toBeUndefined();
    expect(entry['metadata']).toBeUndefined();

    // The serialized JSON must not contain any of the secret values verbatim.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('sk-ant-secret-VALUE');
    expect(wire).not.toContain('refresh-secret');
    expect(wire).not.toContain('leak-me');
  });

  it('falls back to source=manual for legacy entries without a source field', async () => {
    mockStore = [
      {
        provider: 'openai',
        label: 'legacy',
        authType: 'api_key',
        accessToken: 'k',
        priority: 0,
      },
    ];
    const { GET } = await importHandlers();
    const res = await GET(makeEvent({}));
    const body = (await (res as Response).json()) as {
      data: { entries: Array<{ source: string }> };
    };
    expect(body.data.entries[0]?.source).toBe('manual');
  });
});

describe('POST /api/credentials', () => {
  it('rejects unknown providers with E_VALIDATION', async () => {
    const { POST } = await importHandlers();
    const res = await POST(
      makeEvent({
        request: new Request('http://x/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'malicious', label: 'l', apiKey: 'k' }),
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_VALIDATION');
    expect(body.error.message).toContain('Unknown provider');
  });

  it('rejects api keys with surrounding whitespace', async () => {
    const { POST } = await importHandlers();
    const res = await POST(
      makeEvent({
        request: new Request('http://x/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'anthropic', label: 'l', apiKey: '  sk-padded  ' }),
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('E_VALIDATION');
    expect(body.error.message).toContain('whitespace');
  });

  it('rejects missing fields', async () => {
    const { POST } = await importHandlers();
    const res = await POST(
      makeEvent({
        request: new Request('http://x/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'anthropic' }),
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('upserts via addCredential and never echoes the apiKey value', async () => {
    const { POST } = await importHandlers();
    const res = await POST(
      makeEvent({
        request: new Request('http://x/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'anthropic',
            label: 'work',
            apiKey: 'sk-ant-very-secret-1234',
          }),
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { provider: string; label: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ provider: 'anthropic', label: 'work' });

    // The response wire MUST NOT contain the secret value.
    expect(JSON.stringify(body)).not.toContain('sk-ant-very-secret-1234');

    // The store now has the entry.
    expect(mockStore).toHaveLength(1);
    expect(mockStore[0]?.accessToken).toBe('sk-ant-very-secret-1234');
    expect(mockStore[0]?.source).toBe('manual');
  });
});

describe('DELETE /api/credentials/:provider/:label', () => {
  it('returns E_NOT_FOUND when the entry is missing', async () => {
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeEvent({ params: { provider: 'anthropic', label: 'ghost' } }));
    expect(res.status).toBe(404);
  });

  it('dispatches to RemovalRegistry.find, suppresses non-manual sources, and removes', async () => {
    mockStore = [
      {
        provider: 'anthropic',
        label: 'work',
        authType: 'api_key',
        accessToken: 'sk-secret',
        source: 'claude-code',
        priority: 0,
      },
    ];
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeEvent({ params: { provider: 'anthropic', label: 'work' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        provider: string;
        label: string;
        source: string;
        removed: boolean;
        cleaned: string[];
        hints: string[];
        suppressed: boolean;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.source).toBe('claude-code');
    expect(body.data.removed).toBe(true);
    expect(body.data.suppressed).toBe(true);
    expect(body.data.cleaned).toEqual(['/tmp/.claude/credentials.json']);
    expect(removalCalls).toEqual([
      { sourceId: 'claude-code', provider: 'anthropic', label: 'work' },
    ]);
    expect(suppressionCalls).toEqual([{ provider: 'anthropic', sourceId: 'claude-code' }]);
    expect(mockStore).toHaveLength(0);
  });

  it('does not suppress manual entries', async () => {
    mockStore = [
      {
        provider: 'openai',
        label: 'personal',
        authType: 'api_key',
        accessToken: 'sk-secret',
        source: 'manual',
        priority: 0,
      },
    ];
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeEvent({ params: { provider: 'openai', label: 'personal' } }));
    const body = (await res.json()) as {
      data: { suppressed: boolean };
    };
    expect(body.data.suppressed).toBe(false);
    expect(suppressionCalls).toHaveLength(0);
  });

  it('never echoes credential values in the response', async () => {
    mockStore = [
      {
        provider: 'anthropic',
        label: 'work',
        authType: 'api_key',
        accessToken: 'sk-ant-DO-NOT-LEAK-3333',
        refreshToken: 'rfr-NO-LEAK',
        source: 'manual',
        priority: 0,
      },
    ];
    const { DELETE } = await importHandlers();
    const res = await DELETE(makeEvent({ params: { provider: 'anthropic', label: 'work' } }));
    const wire = JSON.stringify(await res.json());
    expect(wire).not.toContain('sk-ant-DO-NOT-LEAK-3333');
    expect(wire).not.toContain('rfr-NO-LEAK');
  });
});
