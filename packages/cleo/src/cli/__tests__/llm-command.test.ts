/**
 * CLI wiring tests for `cleo llm` subcommands (T9258).
 *
 * Two layers under test:
 *   1. Citty subcommand wiring — every documented subcommand exists, has
 *      meta, and routes through `dispatchFromCli('mutate' | 'query', 'llm',
 *      <op>, <params>)`.
 *   2. Engine-level redaction + envelope shape — `llmList` returns
 *      `tokenPreview` (last 4 chars), `llmAdd` accepts `sk-ant-oat-*` and
 *      auto-detects `'oauth'`, `llmWhoami` returns one entry per role.
 *
 * Full end-to-end dispatch through the citty parser is covered indirectly
 * via the dispatch-domain tests; here we focus on the CLI-shape contract.
 *
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for the CLI layer — patched BEFORE importing the command module so
// the static `dispatchFromCli` binding inside llm.ts is replaced.
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);

vi.mock('../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
}));

// Mocks for the core engine layer — used by the engine-level tests below.
// `vi.hoisted` so the mock functions exist before the dynamic import resolves.
const coreMocks = vi.hoisted(() => {
  return {
    listCredentials: vi.fn(),
    addCredential: vi.fn(),
    removeCredential: vi.fn(),
    getCredentialByLabel: vi.fn(),
    resolveLLMForRole: vi.fn(),
    setConfigValue: vi.fn(),
  };
});

vi.mock('@cleocode/core/internal', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listCredentials: coreMocks.listCredentials,
    addCredential: coreMocks.addCredential,
    removeCredential: coreMocks.removeCredential,
    getCredentialByLabel: coreMocks.getCredentialByLabel,
    resolveLLMForRole: coreMocks.resolveLLMForRole,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { CommandDef } from 'citty';
import { llmCommand } from '../commands/llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getLlmSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof llmCommand.subCommands === 'function'
      ? await llmCommand.subCommands()
      : llmCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

async function runSub(
  cmd: CommandDef,
  args: Record<string, unknown>,
  rawArgs: string[] = [],
): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');
  await runFn({ args, rawArgs, cmd: resolved });
}

// ---------------------------------------------------------------------------
// CLI wiring tests
// ---------------------------------------------------------------------------

describe('cleo llm — CLI wiring', () => {
  beforeEach(() => {
    mockDispatchFromCli.mockClear();
  });

  it('exposes every documented subcommand', async () => {
    const subs = await getLlmSubs();
    expect(Object.keys(subs).sort()).toEqual(
      ['add', 'list', 'profile', 'remove', 'test', 'use', 'whoami'].sort(),
    );
  });

  it('add — dispatches mutate/llm/add with provider + apiKey + label', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['add']!, {
      provider: 'anthropic',
      'api-key': 'sk-ant-oat-abc1234',
      label: 'work',
    });
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('mutate');
    expect(call[1]).toBe('llm');
    expect(call[2]).toBe('add');
    expect(call[3]).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-abc1234',
      label: 'work',
    });
  });

  it('list — dispatches query/llm/list with no params when provider absent', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['list']!, {});
    expect(mockDispatchFromCli).toHaveBeenCalledTimes(1);
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[2]).toBe('list');
    expect(call[3]).toEqual({});
  });

  it('list — forwards positional provider filter', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['list']!, { provider: 'openai' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[3]).toEqual({ provider: 'openai' });
  });

  it('remove — dispatches mutate/llm/remove with provider + label', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['remove']!, { provider: 'anthropic', label: 'work' });
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('mutate');
    expect(call[2]).toBe('remove');
    expect(call[3]).toEqual({ provider: 'anthropic', label: 'work' });
  });

  it('whoami — dispatches query/llm/whoami', async () => {
    const subs = await getLlmSubs();
    await runSub(subs['whoami']!, {});
    const call = mockDispatchFromCli.mock.calls[0]!;
    expect(call[0]).toBe('query');
    expect(call[2]).toBe('whoami');
    expect(call[3]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Engine-level redaction + envelope shape tests
// ---------------------------------------------------------------------------

describe('llm cli-ops engine — redaction + envelope shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('llmList — redacts accessToken to last 4 chars via tokenPreview', async () => {
    coreMocks.listCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'work',
        authType: 'oauth',
        accessToken: 'sk-ant-oat-1234567890aB7q',
        priority: 0,
        source: 'cli-input',
      },
    ]);
    const { llmList } = await import('@cleocode/core/internal');
    const result = await llmList({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.credentials).toHaveLength(1);
    const view = result.data.credentials[0]!;
    expect(view.tokenPreview).toBe('…aB7q');
    expect((view as unknown as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it('llmAdd — auto-detects oauth from sk-ant-oat-* prefix', async () => {
    coreMocks.addCredential.mockImplementation(async (input) => ({
      provider: input.provider,
      label: input.label,
      authType: input.authType,
      accessToken: input.accessToken,
      priority: 0,
      source: input.source,
    }));
    const { llmAdd } = await import('@cleocode/core/internal');
    const result = await llmAdd({
      provider: 'anthropic',
      apiKey: 'sk-ant-oat-zzz9999',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.detectedAuthType).toBe('oauth');
    expect(result.data.credential.tokenPreview).toBe('…9999');
  });

  it('llmAdd — defaults non-OAuth tokens to api_key', async () => {
    coreMocks.addCredential.mockImplementation(async (input) => ({
      provider: input.provider,
      label: input.label,
      authType: input.authType,
      accessToken: input.accessToken,
      priority: 0,
      source: input.source,
    }));
    const { llmAdd } = await import('@cleocode/core/internal');
    const result = await llmAdd({
      provider: 'openai',
      apiKey: 'sk-proj-aaaaXYZ1',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.detectedAuthType).toBe('api_key');
  });

  it('llmWhoami — returns one entry per RoleName when role filter absent', async () => {
    coreMocks.resolveLLMForRole.mockImplementation(async (role: string) => ({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      client: null,
      credential: { provider: 'anthropic', apiKey: 'tok', source: 'env', authType: 'api_key' },
      source: 'implicit-fallback' as const,
      credentialLabel: undefined,
    }));
    const { llmWhoami } = await import('@cleocode/core/internal');
    const result = await llmWhoami({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries).toHaveLength(5);
    expect(result.data.entries.map((e) => e.role).sort()).toEqual([
      'consolidation',
      'derivation',
      'extraction',
      'hygiene',
      'judgement',
    ]);
    expect(result.data.entries.every((e) => e.hasCredential)).toBe(true);
  });

  it('llmWhoami — surfaces hasCredential=false when resolver returns null credential', async () => {
    coreMocks.resolveLLMForRole.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      client: null,
      credential: null,
      source: 'implicit-fallback',
      credentialLabel: undefined,
    });
    const { llmWhoami } = await import('@cleocode/core/internal');
    const result = await llmWhoami({ role: 'extraction' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.entries[0]!.hasCredential).toBe(false);
    expect(result.data.entries[0]!.credentialSource).toBeUndefined();
  });

  it('llmWhoami — rejects unknown role with E_INVALID_INPUT', async () => {
    const { llmWhoami } = await import('@cleocode/core/internal');
    const result = await llmWhoami({ role: 'not-a-role' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });

  it('llmRemove — returns removed=true when underlying store removed an entry', async () => {
    coreMocks.removeCredential.mockResolvedValue(true);
    const { llmRemove } = await import('@cleocode/core/internal');
    const result = await llmRemove({ provider: 'anthropic', label: 'work' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ removed: true, provider: 'anthropic', label: 'work' });
  });

  it('llmRemove — rejects empty label with E_INVALID_INPUT', async () => {
    const { llmRemove } = await import('@cleocode/core/internal');
    const result = await llmRemove({ provider: 'anthropic', label: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});
