/**
 * Service-vault OAuth dispatch handler tests (T11939 · epic T11765).
 *
 * Drives the REAL {@link ServiceHandler} in isolation — the CORE OAuth engine
 * (`buildAuthUrl` / `exchangeCode` / `selfHealConnection`) is mocked, so the test
 * exercises ONLY the thin delegate's contract:
 *
 *   1. **getSupportedOperations** — query `auth-url`; mutate `exchange`,
 *      `refresh`, `self-heal`.
 *   2. **Param validation** — a missing required param returns `E_INVALID_INPUT`
 *      (NOT `E_INVALID_OPERATION`) BEFORE any engine call.
 *   3. **Delegation** — a well-formed call delegates to CORE and shapes a
 *      NON-SECRET envelope (the plaintext token never crosses the boundary).
 *   4. **OperationDef SSoT** — the four `service.*` entries exist in OPERATIONS
 *      with the right gateway/requiredParams, and `service` is a canonical domain.
 *
 * @task T11939
 * @epic T11765
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildAuthUrlMock, exchangeCodeMock, selfHealMock } = vi.hoisted(() => ({
  buildAuthUrlMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  selfHealMock: vi.fn(),
}));

// Mock the CORE barrel — the handler imports the OAuth functions from
// `@cleocode/core/internal`. Stubbing it keeps the test off the heavy
// core/runtime dependency tree (sparse-worktree-safe).
vi.mock('@cleocode/core/internal', () => ({
  buildAuthUrl: buildAuthUrlMock,
  exchangeCode: exchangeCodeMock,
  selfHealConnection: selfHealMock,
}));

// Stub `createDispatchMeta` so `_base → _meta` does not pull the full
// `@cleocode/runtime/gateway` source graph (an unbuilt tree in sparse worktrees).
vi.mock('@cleocode/runtime/gateway', () => ({
  createDispatchMeta: (gateway: string, domain: string, operation: string) => ({
    gateway,
    domain,
    operation,
    requestId: 'test-request-id',
    duration_ms: 0,
    timestamp: new Date(0).toISOString(),
  }),
}));

import { CANONICAL_DOMAINS, OPERATIONS } from '@cleocode/contracts';
import { ServiceHandler } from '../service.js';

describe('ServiceHandler dispatch (T11939)', () => {
  let handler: ServiceHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ServiceHandler();
  });

  it('declares the auth-url query + exchange/refresh/self-heal mutations', () => {
    expect(handler.getSupportedOperations()).toEqual({
      query: ['auth-url'],
      mutate: ['exchange', 'refresh', 'self-heal'],
    });
  });

  describe('auth-url (query)', () => {
    it('rejects a missing provider with E_INVALID_INPUT (not E_INVALID_OPERATION)', async () => {
      const res = await handler.query('auth-url', {});
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(buildAuthUrlMock).not.toHaveBeenCalled();
    });

    it('delegates to CORE buildAuthUrl and returns the URL + verifier', async () => {
      buildAuthUrlMock.mockResolvedValue({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        codeVerifier: 'verifier-123',
        state: 'state-abc',
        redirectUri: 'http://127.0.0.1:7878/cb',
      });
      const res = await handler.query('auth-url', { provider: 'google', state: 'state-abc' });
      expect(res.success).toBe(true);
      expect(buildAuthUrlMock).toHaveBeenCalledWith('google', { state: 'state-abc' });
      const data = res.data as { authUrl: string; codeVerifier: string };
      expect(data.authUrl).toContain('accounts.google.com');
      expect(data.codeVerifier).toBe('verifier-123');
    });

    it('returns E_INVALID_OPERATION for an unknown query op', async () => {
      const res = await handler.query('frobnicate', {});
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  describe('exchange (mutate)', () => {
    it('rejects missing required params with E_INVALID_INPUT', async () => {
      const res = await handler.mutate('exchange', { provider: 'google' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(exchangeCodeMock).not.toHaveBeenCalled();
    });

    it('delegates to CORE exchangeCode and shapes a mutate envelope (no plaintext)', async () => {
      exchangeCodeMock.mockResolvedValue({
        connectionId: 7,
        provider: 'google',
        label: 'personal',
        expiresAt: '2030-01-01T00:00:00.000Z',
        hasRefreshToken: true,
      });
      const res = await handler.mutate('exchange', {
        provider: 'google',
        code: 'auth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:7878/cb',
        label: 'personal',
      });
      expect(res.success).toBe(true);
      const data = res.data as {
        count: number;
        created: string[];
        connection: { connectionId: number };
      };
      expect(data.count).toBe(1);
      expect(data.created).toEqual(['7']);
      expect(data.connection.connectionId).toBe(7);
      // No token field anywhere in the envelope.
      expect(JSON.stringify(res.data)).not.toContain('access');
    });
  });

  describe('refresh (mutate)', () => {
    it('rejects missing params with E_INVALID_INPUT', async () => {
      const res = await handler.mutate('refresh', { provider: 'google' });
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(selfHealMock).not.toHaveBeenCalled();
    });

    it('returns E_NOT_FOUND when the connection cannot be resolved', async () => {
      selfHealMock.mockResolvedValue({ sealed: null, refreshed: false, expiresAt: null });
      const res = await handler.mutate('refresh', {
        agentId: 'a',
        provider: 'google',
        label: 'work',
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_NOT_FOUND');
    });

    it('delegates with a forced refresh and returns a non-secret updated envelope', async () => {
      selfHealMock.mockResolvedValue({
        sealed: { provider: 'google', account: 'work', tokenPreview: 'oat-…1234', fetch: vi.fn() },
        refreshed: true,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      const res = await handler.mutate('refresh', {
        agentId: 'a',
        provider: 'google',
        label: 'work',
      });
      expect(res.success).toBe(true);
      expect(selfHealMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a', provider: 'google', label: 'work' }),
      );
      const data = res.data as { count: number; updated: string[]; refreshed: boolean };
      expect(data.refreshed).toBe(true);
      expect(data.updated).toEqual(['google:work']);
    });
  });

  describe('self-heal (mutate)', () => {
    it('rejects missing params with E_INVALID_INPUT', async () => {
      const res = await handler.mutate('self-heal', { agentId: 'a' });
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(selfHealMock).not.toHaveBeenCalled();
    });

    it('returns a non-secret resolved/refreshed reference', async () => {
      selfHealMock.mockResolvedValue({
        sealed: { provider: 'google', account: 'work', tokenPreview: 'oat-…1234', fetch: vi.fn() },
        refreshed: false,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      const res = await handler.mutate('self-heal', {
        agentId: 'a',
        provider: 'google',
        label: 'work',
      });
      expect(res.success).toBe(true);
      const data = res.data as { resolved: boolean; refreshed: boolean; count: number };
      expect(data.resolved).toBe(true);
      expect(data.refreshed).toBe(false);
      expect(data.count).toBe(0);
      // No token plaintext in the envelope (only the preview-free reference).
      expect(JSON.stringify(res.data)).not.toContain('fetch');
    });

    it('returns E_INVALID_OPERATION for an unknown mutate op', async () => {
      const res = await handler.mutate('frobnicate', {});
      expect(res.error?.code).toBe('E_INVALID_OPERATION');
    });
  });

  describe('OperationDef SSoT', () => {
    it('registers all four service.* ops with the right gateway + requiredParams', () => {
      const ops = OPERATIONS.filter((o) => o.domain === 'service');
      const byOp = new Map(ops.map((o) => [o.operation, o]));
      expect(byOp.get('auth-url')?.gateway).toBe('query');
      expect(byOp.get('auth-url')?.requiredParams).toEqual(['provider']);
      expect(byOp.get('exchange')?.gateway).toBe('mutate');
      expect(byOp.get('exchange')?.requiredParams).toEqual([
        'provider',
        'code',
        'codeVerifier',
        'redirectUri',
      ]);
      expect(byOp.get('refresh')?.gateway).toBe('mutate');
      expect(byOp.get('self-heal')?.gateway).toBe('mutate');
    });

    it('declares `service` as a canonical domain', () => {
      expect(CANONICAL_DOMAINS).toContain('service');
    });

    it('the handler getSupportedOperations matches the OPERATIONS registry', () => {
      const ops = OPERATIONS.filter((o) => o.domain === 'service');
      const registryQuery = ops
        .filter((o) => o.gateway === 'query')
        .map((o) => o.operation)
        .sort();
      const registryMutate = ops
        .filter((o) => o.gateway === 'mutate')
        .map((o) => o.operation)
        .sort();
      const supported = new ServiceHandler().getSupportedOperations();
      expect([...supported.query].sort()).toEqual(registryQuery);
      expect([...supported.mutate].sort()).toEqual(registryMutate);
    });
  });
});
