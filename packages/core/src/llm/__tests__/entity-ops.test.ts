/**
 * Engine-level tests for the 5-entity provider-experience ops (T11700).
 *
 * Verifies the CORE `entity-ops.ts` composition layer in isolation — the
 * underlying accessors (`cli-ops.ts` account ops, the config reader/writer, the
 * catalog model validator) are mocked, so the tests exercise ONLY the entity-ops
 * contract:
 *
 *   - **account.*** delegate to the proven `llm*` pool ops; the redacted view
 *     (tokenPreview ONLY) is surfaced — never the raw secret.
 *   - **profile.create** BINDS + VALIDATES: the pinned account must exist; the
 *     model must be in the catalog; the binding persists into `llm.profiles[name]`.
 *   - **profile.pin / profile.use** require an existing profile + a valid role.
 *
 * @epic T11666
 * @task T11700
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  llmAdd: vi.fn(),
  llmList: vi.fn(),
  llmRemove: vi.fn(),
  setConfigValue: vi.fn().mockResolvedValue({ key: 'x', value: 'y', scope: 'global' }),
  loadConfig: vi.fn(),
  validateModelForProvider: vi.fn().mockReturnValue({ valid: true, reason: 'found' }),
}));

vi.mock('../cli-ops.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, llmAdd: m.llmAdd, llmList: m.llmList, llmRemove: m.llmRemove };
});

vi.mock('../../config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, setConfigValue: m.setConfigValue, loadConfig: m.loadConfig };
});

vi.mock('../catalog-model-resolver.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, validateModelForProvider: m.validateModelForProvider };
});

import {
  accountAdd,
  accountList,
  accountRemove,
  profileCreate,
  profileList,
  profilePin,
  profileUse,
} from '../entity-ops.js';

describe('entity-ops engine (T11700)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.setConfigValue.mockResolvedValue({ key: 'x', value: 'y', scope: 'global' });
    m.validateModelForProvider.mockReturnValue({ valid: true, reason: 'found' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // account.*
  // -------------------------------------------------------------------------

  describe('account.add', () => {
    it('delegates to llmAdd and surfaces ONLY the redacted view (no raw secret)', async () => {
      m.llmAdd.mockResolvedValue({
        success: true,
        data: {
          credential: {
            provider: 'anthropic',
            label: 'work',
            authType: 'api_key',
            tokenPreview: '…aB7q',
          },
          detectedAuthType: 'api_key',
        },
      });
      const res = await accountAdd({
        provider: 'anthropic',
        token: 'sk-ant-supersecret',
        label: 'work',
      });
      expect(res.success).toBe(true);
      expect(m.llmAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          apiKey: 'sk-ant-supersecret',
          label: 'work',
        }),
      );
      if (res.success) {
        expect(JSON.stringify(res.data)).not.toContain('supersecret');
        expect((res.data.account as { tokenPreview: string }).tokenPreview).toBe('…aB7q');
        expect(res.data.detectedAuthType).toBe('api_key');
      }
    });

    it('propagates a write failure from llmAdd', async () => {
      m.llmAdd.mockResolvedValue({
        success: false,
        error: { code: 'E_CREDENTIAL_WRITE_FAILED', message: 'disk full' },
      });
      const res = await accountAdd({ provider: 'anthropic', token: 'x' });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_CREDENTIAL_WRITE_FAILED');
    });
  });

  describe('account.list', () => {
    it('delegates to llmList and never leaks a secret (tokenPreview only)', async () => {
      m.llmList.mockResolvedValue({
        success: true,
        data: {
          credentials: [
            { provider: 'anthropic', label: 'work', authType: 'oauth', tokenPreview: 'oat-…7Y2k' },
          ],
        },
      });
      const res = await accountList({});
      expect(res.success).toBe(true);
      if (res.success) {
        expect(JSON.stringify(res.data)).not.toContain('accessToken');
        expect((res.data.accounts[0] as { tokenPreview: string }).tokenPreview).toBe('oat-…7Y2k');
      }
    });

    it('passes the provider filter through', async () => {
      m.llmList.mockResolvedValue({ success: true, data: { credentials: [] } });
      await accountList({ provider: 'openai' });
      expect(m.llmList).toHaveBeenCalledWith({ provider: 'openai' });
    });
  });

  describe('account.remove', () => {
    it('maps a removal into the {count, deleted} envelope', async () => {
      m.llmRemove.mockResolvedValue({
        success: true,
        data: { removed: true, provider: 'anthropic', label: 'work' },
      });
      const res = await accountRemove({ provider: 'anthropic', label: 'work' });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.count).toBe(1);
        expect(res.data.deleted).toEqual(['anthropic:work']);
      }
    });

    it('reports count=0 when nothing was removed (idempotent)', async () => {
      m.llmRemove.mockResolvedValue({
        success: true,
        data: { removed: false, provider: 'anthropic', label: 'ghost' },
      });
      const res = await accountRemove({ provider: 'anthropic', label: 'ghost' });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.count).toBe(0);
        expect(res.data.deleted).toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // profile.* — bind + validate + persist
  // -------------------------------------------------------------------------

  describe('profile.create', () => {
    it('binds an account + model and persists into llm.profiles[name]', async () => {
      m.llmList.mockResolvedValue({
        success: true,
        data: { credentials: [{ provider: 'anthropic', label: 'work', tokenPreview: '…x' }] },
      });
      const res = await profileCreate({
        name: 'fast',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'work',
      });
      expect(res.success).toBe(true);
      // Persisted the provider + model + credentialLabel under llm.profiles.fast.
      expect(m.setConfigValue).toHaveBeenCalledWith(
        'llm.profiles.fast.provider',
        'anthropic',
        undefined,
        { global: true },
      );
      expect(m.setConfigValue).toHaveBeenCalledWith(
        'llm.profiles.fast.model',
        'claude-3-5-haiku-latest',
        undefined,
        { global: true },
      );
      expect(m.setConfigValue).toHaveBeenCalledWith(
        'llm.profiles.fast.credentialLabel',
        'work',
        undefined,
        { global: true },
      );
      if (res.success) {
        expect(res.data.count).toBe(1);
        expect(res.data.created).toEqual(['fast']);
        expect(res.data.profile.name).toBe('fast');
      }
    });

    it('REJECTS when the pinned account does not exist (E_ACCOUNT_NOT_FOUND)', async () => {
      m.llmList.mockResolvedValue({
        success: true,
        data: { credentials: [{ provider: 'anthropic', label: 'work', tokenPreview: '…x' }] },
      });
      const res = await profileCreate({
        name: 'p',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        label: 'ghost',
      });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_ACCOUNT_NOT_FOUND');
      expect(m.setConfigValue).not.toHaveBeenCalled();
    });

    it('REJECTS when the model is not in the catalog (E_MODEL_NOT_IN_CATALOG)', async () => {
      m.validateModelForProvider.mockReturnValue({ valid: false, reason: 'not-found' });
      const res = await profileCreate({
        name: 'p',
        provider: 'anthropic',
        model: 'made-up-model',
      });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_MODEL_NOT_IN_CATALOG');
      expect(m.setConfigValue).not.toHaveBeenCalled();
    });

    it('does NOT validate the account when no label is pinned', async () => {
      const res = await profileCreate({
        name: 'p',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
      });
      expect(res.success).toBe(true);
      // llmList (the account-existence check) is skipped when label is absent.
      expect(m.llmList).not.toHaveBeenCalled();
    });
  });

  describe('profile.list', () => {
    it('reads llm.profiles from config', async () => {
      m.loadConfig.mockResolvedValue({
        llm: {
          profiles: {
            fast: {
              provider: 'anthropic',
              model: 'claude-3-5-haiku-latest',
              credentialLabel: 'work',
            },
          },
        },
      });
      const res = await profileList({});
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.profiles).toEqual([
          {
            name: 'fast',
            provider: 'anthropic',
            model: 'claude-3-5-haiku-latest',
            credentialLabel: 'work',
          },
        ]);
      }
    });

    it('returns an empty list when no profiles are configured', async () => {
      m.loadConfig.mockResolvedValue({});
      const res = await profileList({});
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.profiles).toEqual([]);
    });
  });

  describe('profile.pin', () => {
    it('REJECTS an unknown role with E_INVALID_INPUT before any write', async () => {
      m.loadConfig.mockResolvedValue({
        llm: { profiles: { fast: { provider: 'a', model: 'm' } } },
      });
      const res = await profilePin({ name: 'fast', role: 'not-a-role' });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_INVALID_INPUT');
      expect(m.setConfigValue).not.toHaveBeenCalled();
    });

    it('REJECTS pinning a non-existent profile (E_NOT_FOUND)', async () => {
      m.loadConfig.mockResolvedValue({ llm: { profiles: {} } });
      const res = await profilePin({ name: 'ghost', role: 'extraction' });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_NOT_FOUND');
    });

    it('pins a valid role to an existing profile', async () => {
      m.loadConfig.mockResolvedValue({
        llm: { profiles: { fast: { provider: 'a', model: 'm' } } },
      });
      const res = await profilePin({ name: 'fast', role: 'extraction' });
      expect(res.success).toBe(true);
      expect(m.setConfigValue).toHaveBeenCalledWith(
        'llm.roles.extraction.profile',
        'fast',
        undefined,
        { global: true },
      );
    });
  });

  describe('profile.use', () => {
    it('REJECTS a non-existent profile (E_NOT_FOUND)', async () => {
      m.loadConfig.mockResolvedValue({ llm: { profiles: {} } });
      const res = await profileUse({ name: 'ghost' });
      expect(res.success).toBe(false);
      if (!res.success) expect(res.error.code).toBe('E_NOT_FOUND');
      expect(m.setConfigValue).not.toHaveBeenCalled();
    });

    it('sets llm.defaultProfile for an existing profile', async () => {
      m.loadConfig.mockResolvedValue({
        llm: { profiles: { fast: { provider: 'a', model: 'm' } } },
      });
      const res = await profileUse({ name: 'fast' });
      expect(res.success).toBe(true);
      expect(m.setConfigValue).toHaveBeenCalledWith('llm.defaultProfile', 'fast', undefined, {
        global: true,
      });
      if (res.success) expect(res.data.profile).toBe('fast');
    });
  });
});
