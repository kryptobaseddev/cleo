/**
 * 5-entity provider-experience dispatch handler tests (T11700 · epic T11666).
 *
 * Drives the REAL {@link AccountHandler} / {@link ProviderHandler} /
 * {@link ModelHandler} / {@link ProfileHandler} in isolation — the CORE entity-ops
 * engine (`accountAdd` / `accountList` / `providerList` / `modelQuery` /
 * `profileCreate` / …) is mocked, so the tests exercise ONLY the thin delegates'
 * contract:
 *
 *   1. **getSupportedOperations** — matches the OPERATIONS registry per domain.
 *   2. **Param validation** — a missing required param returns `E_INVALID_INPUT`
 *      (NOT `E_INVALID_OPERATION`) BEFORE any engine call.
 *   3. **Delegation + NON-SECRET envelope** — `account.list` / `account.add`
 *      surface ONLY the redacted `tokenPreview`; no raw secret crosses the
 *      boundary.
 *   4. **profile.create binds + validates** — the engine binding is invoked.
 *   5. **OperationDef + contract SSoT** — every new op is registered with the
 *      right gateway, carries an INPUT + OUTPUT contract (so `--describe`
 *      resolves), and the secret-bearing ops are MCP-default-denied.
 *
 * @epic T11666
 * @task T11700
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  accountAddMock,
  accountListMock,
  accountRemoveMock,
  providerListMock,
  providerShowMock,
  providerConnectMock,
  modelQueryMock,
  modelShowMock,
  profileCreateMock,
  profileListMock,
  profilePinMock,
  profileUseMock,
} = vi.hoisted(() => ({
  accountAddMock: vi.fn(),
  accountListMock: vi.fn(),
  accountRemoveMock: vi.fn(),
  providerListMock: vi.fn(),
  providerShowMock: vi.fn(),
  providerConnectMock: vi.fn(),
  modelQueryMock: vi.fn(),
  modelShowMock: vi.fn(),
  profileCreateMock: vi.fn(),
  profileListMock: vi.fn(),
  profilePinMock: vi.fn(),
  profileUseMock: vi.fn(),
}));

// Mock the CORE barrel — the handlers import the entity ops from
// `@cleocode/core/internal`. Stubbing it keeps the test off the heavy
// core/runtime dependency tree (sparse-worktree-safe).
vi.mock('@cleocode/core/internal', () => ({
  accountAdd: accountAddMock,
  accountList: accountListMock,
  accountRemove: accountRemoveMock,
  providerList: providerListMock,
  providerShow: providerShowMock,
  providerConnect: providerConnectMock,
  modelQuery: modelQueryMock,
  modelShow: modelShowMock,
  profileCreate: profileCreateMock,
  profileList: profileListMock,
  profilePin: profilePinMock,
  profileUse: profileUseMock,
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

import {
  accountAddInputContract,
  accountListInputContract,
  accountRemoveInputContract,
  CANONICAL_DOMAINS,
  modelQueryInputContract,
  modelShowInputContract,
  OPERATIONS,
  OUTPUT_CONTRACTS,
  profileCreateInputContract,
  profileListInputContract,
  profilePinInputContract,
  profileUseInputContract,
  providerConnectInputContract,
  providerListInputContract,
  providerShowInputContract,
} from '@cleocode/contracts';
import { AccountHandler, ModelHandler, ProfileHandler, ProviderHandler } from '../entities.js';

/** The 12 INPUT contracts that back the entity ops' `--describe` surface. */
const ENTITY_INPUT_CONTRACTS = {
  'account.add': accountAddInputContract,
  'account.list': accountListInputContract,
  'account.remove': accountRemoveInputContract,
  'provider.list': providerListInputContract,
  'provider.show': providerShowInputContract,
  'provider.connect': providerConnectInputContract,
  'model.query': modelQueryInputContract,
  'model.show': modelShowInputContract,
  'profile.create': profileCreateInputContract,
  'profile.list': profileListInputContract,
  'profile.pin': profilePinInputContract,
  'profile.use': profileUseInputContract,
} as const;

/** The full set of new operation ids (the `--describe` coverage set). */
const ENTITY_OP_KEYS = [
  'account.add',
  'account.list',
  'account.remove',
  'provider.list',
  'provider.show',
  'provider.connect',
  'model.query',
  'model.show',
  'profile.create',
  'profile.list',
  'profile.pin',
  'profile.use',
] as const;

/** The secret-bearing mutations — MUST be MCP-default-denied (AC5/AC7). */
const SECRET_BEARING_OPS = [
  { domain: 'account', operation: 'add' },
  { domain: 'provider', operation: 'connect' },
] as const;

describe('5-entity provider-experience dispatch (T11700)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AccountHandler
  // -------------------------------------------------------------------------

  describe('AccountHandler', () => {
    it('declares list (query) + add/remove (mutate)', () => {
      expect(new AccountHandler().getSupportedOperations()).toEqual({
        query: ['list'],
        mutate: ['add', 'remove'],
      });
    });

    it('add rejects a missing token with E_INVALID_INPUT (not E_INVALID_OPERATION)', async () => {
      const res = await new AccountHandler().mutate('add', { provider: 'anthropic' });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(accountAddMock).not.toHaveBeenCalled();
    });

    it('add delegates and surfaces the redacted view ONLY — never the raw secret', async () => {
      accountAddMock.mockResolvedValue({
        success: true,
        data: {
          account: {
            provider: 'anthropic',
            label: 'work',
            authType: 'api_key',
            tokenPreview: '…aB7q',
          },
          detectedAuthType: 'api_key',
        },
      });
      const res = await new AccountHandler().mutate('add', {
        provider: 'anthropic',
        token: 'sk-ant-supersecret-raw-value',
        label: 'work',
      });
      expect(res.success).toBe(true);
      expect(accountAddMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', token: 'sk-ant-supersecret-raw-value' }),
      );
      // The raw secret is NEVER present anywhere in the result envelope.
      expect(JSON.stringify(res.data)).not.toContain('supersecret');
      const data = res.data as { account: { tokenPreview: string } };
      expect(data.account.tokenPreview).toBe('…aB7q');
    });

    it('list delegates and never leaks a secret (tokenPreview only)', async () => {
      accountListMock.mockResolvedValue({
        success: true,
        data: {
          accounts: [
            { provider: 'anthropic', label: 'work', authType: 'oauth', tokenPreview: 'oat-…7Y2k' },
          ],
        },
      });
      const res = await new AccountHandler().query('list', {});
      expect(res.success).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain('accessToken');
      const data = res.data as { accounts: Array<{ tokenPreview: string }> };
      expect(data.accounts[0]?.tokenPreview).toBe('oat-…7Y2k');
    });

    it('remove rejects a missing label with E_INVALID_INPUT', async () => {
      const res = await new AccountHandler().mutate('remove', { provider: 'anthropic' });
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(accountRemoveMock).not.toHaveBeenCalled();
    });

    it('returns E_INVALID_OPERATION for an unknown op', async () => {
      expect((await new AccountHandler().query('frob', {})).error?.code).toBe(
        'E_INVALID_OPERATION',
      );
      expect((await new AccountHandler().mutate('frob', {})).error?.code).toBe(
        'E_INVALID_OPERATION',
      );
    });
  });

  // -------------------------------------------------------------------------
  // ProviderHandler
  // -------------------------------------------------------------------------

  describe('ProviderHandler', () => {
    it('declares list/show (query) + connect (mutate)', () => {
      expect(new ProviderHandler().getSupportedOperations()).toEqual({
        query: ['list', 'show'],
        mutate: ['connect'],
      });
    });

    it('list delegates to providerList', async () => {
      providerListMock.mockResolvedValue({ success: true, data: { providers: [] } });
      const res = await new ProviderHandler().query('list', {});
      expect(res.success).toBe(true);
      expect(providerListMock).toHaveBeenCalledTimes(1);
    });

    it('show rejects a missing provider with E_INVALID_INPUT', async () => {
      const res = await new ProviderHandler().query('show', {});
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(providerShowMock).not.toHaveBeenCalled();
    });

    it('connect delegates and never returns the raw token', async () => {
      providerConnectMock.mockResolvedValue({
        success: true,
        data: {
          count: 1,
          created: ['anthropic:default'],
          account: { provider: 'anthropic', label: 'default', tokenPreview: '…aB7q' },
        },
      });
      const res = await new ProviderHandler().mutate('connect', {
        provider: 'claude',
        token: 'sk-ant-raw-secret-token',
      });
      expect(res.success).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain('raw-secret');
    });
  });

  // -------------------------------------------------------------------------
  // ModelHandler (query-only)
  // -------------------------------------------------------------------------

  describe('ModelHandler', () => {
    it('declares query/show (query) + NO mutations (query-only)', () => {
      expect(new ModelHandler().getSupportedOperations()).toEqual({
        query: ['query', 'show'],
        mutate: [],
      });
    });

    it('query delegates with provider + limit filters', async () => {
      modelQueryMock.mockResolvedValue({ success: true, data: { models: [], count: 0 } });
      const res = await new ModelHandler().query('query', { provider: 'anthropic', limit: 5 });
      expect(res.success).toBe(true);
      expect(modelQueryMock).toHaveBeenCalledWith({ provider: 'anthropic', limit: 5 });
    });

    it('show rejects a missing model with E_INVALID_INPUT', async () => {
      const res = await new ModelHandler().query('show', {});
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(modelShowMock).not.toHaveBeenCalled();
    });

    it('every mutation is E_INVALID_OPERATION (query-only)', async () => {
      expect((await new ModelHandler().mutate('query', {})).error?.code).toBe(
        'E_INVALID_OPERATION',
      );
    });
  });

  // -------------------------------------------------------------------------
  // ProfileHandler
  // -------------------------------------------------------------------------

  describe('ProfileHandler', () => {
    it('declares list (query) + create/pin/use (mutate)', () => {
      expect(new ProfileHandler().getSupportedOperations()).toEqual({
        query: ['list'],
        mutate: ['create', 'pin', 'use'],
      });
    });

    it('create rejects missing required params with E_INVALID_INPUT', async () => {
      const res = await new ProfileHandler().mutate('create', { name: 'fast' });
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(profileCreateMock).not.toHaveBeenCalled();
    });

    it('create binds an account + model (delegates with the full binding)', async () => {
      profileCreateMock.mockResolvedValue({
        success: true,
        data: {
          count: 1,
          created: ['fast'],
          profile: {
            name: 'fast',
            provider: 'anthropic',
            model: 'claude-3-5-haiku-latest',
            credentialLabel: 'work',
            role: null,
          },
        },
      });
      const res = await new ProfileHandler().mutate('create', {
        name: 'fast',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'work',
      });
      expect(res.success).toBe(true);
      expect(profileCreateMock).toHaveBeenCalledWith({
        name: 'fast',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'work',
      });
      const data = res.data as { count: number; profile: { name: string } };
      expect(data.count).toBe(1);
      expect(data.profile.name).toBe('fast');
    });

    it('create surfaces the engine binding-validation error (E_ACCOUNT_NOT_FOUND)', async () => {
      profileCreateMock.mockResolvedValue({
        success: false,
        error: { code: 'E_ACCOUNT_NOT_FOUND', message: "No account 'anthropic:ghost'." },
      });
      const res = await new ProfileHandler().mutate('create', {
        name: 'p',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'ghost',
      });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('E_ACCOUNT_NOT_FOUND');
    });

    it('pin rejects a missing role with E_INVALID_INPUT', async () => {
      const res = await new ProfileHandler().mutate('pin', { name: 'fast' });
      expect(res.error?.code).toBe('E_INVALID_INPUT');
      expect(profilePinMock).not.toHaveBeenCalled();
    });

    it('use delegates to profileUse', async () => {
      profileUseMock.mockResolvedValue({
        success: true,
        data: { count: 1, updated: ['fast'], profile: 'fast', scope: 'global' },
      });
      const res = await new ProfileHandler().mutate('use', { name: 'fast' });
      expect(res.success).toBe(true);
      expect(profileUseMock).toHaveBeenCalledWith({ name: 'fast' });
    });
  });

  // -------------------------------------------------------------------------
  // OperationDef + contract SSoT (AC1–AC5 · AC7 · --describe coverage)
  // -------------------------------------------------------------------------

  describe('OperationDef + contract SSoT', () => {
    it('declares all 4 entity domains as canonical', () => {
      for (const domain of ['account', 'provider', 'model', 'profile']) {
        expect(CANONICAL_DOMAINS).toContain(domain);
      }
    });

    it('registers every entity op with a resolvable OperationDef + gateway', () => {
      for (const key of ENTITY_OP_KEYS) {
        const [domain, operation] = key.split('.');
        const def = OPERATIONS.find((o) => o.domain === domain && o.operation === operation);
        expect(def, `missing OperationDef for ${key}`).toBeDefined();
        expect(def?.gateway === 'query' || def?.gateway === 'mutate').toBe(true);
      }
    });

    it('every entity op carries an INPUT + OUTPUT contract (so --describe resolves)', () => {
      for (const key of ENTITY_OP_KEYS) {
        const input = ENTITY_INPUT_CONTRACTS[key];
        expect(input, `missing INPUT contract for ${key}`).toBeDefined();
        expect(input.operation).toBe(key);
        expect(input.schema).toBeDefined();
        expect(OUTPUT_CONTRACTS[key], `missing OUTPUT contract for ${key}`).toBeDefined();
        // The OUTPUT contract declares a resultSchema (AC5) + valid --field pointers.
        expect(OUTPUT_CONTRACTS[key]?.dataSchema).toBeDefined();
        expect(Array.isArray(OUTPUT_CONTRACTS[key]?.fieldPointers)).toBe(true);
      }
    });

    it('secret-bearing ops (account.add, provider.connect) are MCP-default-denied', () => {
      for (const { domain, operation } of SECRET_BEARING_OPS) {
        const def = OPERATIONS.find((o) => o.domain === domain && o.operation === operation);
        expect(def?.gateway).toBe('mutate');
        // Default-deny: absent / false `mcpExposed` ⇒ NOT surfaced over MCP.
        expect(def?.mcpExposed ?? false).toBe(false);
      }
    });

    it('NO entity op opts into the MCP surface (curated default-deny)', () => {
      const mcpExposed = OPERATIONS.filter(
        (o) =>
          ['account', 'provider', 'model', 'profile'].includes(o.domain) && o.mcpExposed === true,
      );
      expect(mcpExposed).toEqual([]);
    });

    it('model is query-only — no model.* mutate op exists', () => {
      const mutateModel = OPERATIONS.filter((o) => o.domain === 'model' && o.gateway === 'mutate');
      expect(mutateModel).toEqual([]);
    });

    it('every handler getSupportedOperations matches the OPERATIONS registry', () => {
      const cases: Array<[string, { query: string[]; mutate: string[] }]> = [
        ['account', new AccountHandler().getSupportedOperations()],
        ['provider', new ProviderHandler().getSupportedOperations()],
        ['model', new ModelHandler().getSupportedOperations()],
        ['profile', new ProfileHandler().getSupportedOperations()],
      ];
      for (const [domain, supported] of cases) {
        const ops = OPERATIONS.filter((o) => o.domain === domain);
        const registryQuery = ops
          .filter((o) => o.gateway === 'query')
          .map((o) => o.operation)
          .sort();
        const registryMutate = ops
          .filter((o) => o.gateway === 'mutate')
          .map((o) => o.operation)
          .sort();
        expect([...supported.query].sort()).toEqual(registryQuery);
        expect([...supported.mutate].sort()).toEqual(registryMutate);
      }
    });
  });
});
