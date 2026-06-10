/**
 * CLI wiring tests for `cleo auth` (T9416).
 *
 * Verifies:
 *   - `auth` exposes `list` + `remove` subcommands.
 *   - `auth list` calls `getCredentialPool().seed()` then `list()`,
 *      filters by --provider, and emits the LAFS envelope shape.
 *   - `auth remove` dispatches to the per-source RemovalStep, persists
 *      suppression when `suppress: true`, and removes the entry from
 *      the credential store.
 *
 * The credential pool, removal registry, and store are mocked so the
 * test never touches `~/.cleo/llm-credentials.json` or the real
 * suppression file.
 *
 * @task T9416
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

import type { CommandDef } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command module.
// ---------------------------------------------------------------------------

const mockSeed = vi.fn().mockResolvedValue({ added: 0, failed: 0, skipped: 0 });
const mockList = vi.fn();
const mockGetCredentialPool = vi.fn(() => ({
  seed: mockSeed,
  list: mockList,
}));

vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => mockGetCredentialPool(),
}));

const mockRemovalStep = {
  sourceId: 'claude-code' as const,
  description: 'mock',
  remove: vi.fn(),
};
const mockRegistryFind = vi.fn();
const mockAddSuppression = vi.fn();

vi.mock('@cleocode/core/llm/credential-removal.js', () => ({
  REMOVAL_REGISTRY: { find: (...a: unknown[]) => mockRegistryFind(...a) },
  addSuppression: (...a: unknown[]) => mockAddSuppression(...a),
}));

const mockRemoveCredential = vi.fn();

vi.mock('@cleocode/core/llm/credentials-store.js', () => ({
  removeCredential: (...a: unknown[]) => mockRemoveCredential(...a),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { authCommand } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAuthSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof authCommand.subCommands === 'function'
      ? await authCommand.subCommands()
      : authCommand.subCommands;
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

function captureStdout(): { restore: () => void; lines: string[] } {
  const orig = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

function captureStderr(): { restore: () => void; lines: string[] } {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((s: unknown) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo auth — CLI wiring', () => {
  beforeEach(() => {
    mockSeed.mockClear();
    mockList.mockReset();
    mockGetCredentialPool.mockClear();
    mockRegistryFind.mockReset();
    mockAddSuppression.mockReset();
    mockRemoveCredential.mockReset();
    mockRemovalStep.remove.mockReset();
    process.env['CLEO_FORMAT'] = 'json';
  });

  it('exposes consent + list + login + remove + migrate-project-secrets subcommands', async () => {
    // T9417 added migrate-project-secrets; T9598 added consent; T11725 added login.
    const subs = await getAuthSubs();
    expect(Object.keys(subs).sort()).toEqual([
      'consent',
      'list',
      'login',
      'migrate-project-secrets',
      'remove',
    ]);
  });

  it('list — seeds, lists, filters by --provider, emits LAFS envelope', async () => {
    mockList.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'claude-code-import',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'sk-FAKE',
        priority: 100,
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      {
        provider: 'openai',
        label: 'env:OPENAI_API_KEY',
        source: 'env',
        authType: 'api_key',
        accessToken: 'sk-OPENAI',
        priority: 50,
      },
    ]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['list']!, { provider: 'anthropic' });
    } finally {
      stdout.restore();
    }

    // seed() then list() — in that order.
    expect(mockSeed).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledTimes(1);

    // Last stdout line is the JSON envelope.
    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('auth.list');
    expect(env.data.entries).toHaveLength(1);
    expect(env.data.entries[0]).toMatchObject({
      provider: 'anthropic',
      label: 'claude-code-import',
      source: 'claude-code',
      authType: 'oauth',
    });
    expect(env.data.entries[0].expiryStatus).toMatch(/^expires in /);
  });

  it('list — labels expired and never entries correctly', async () => {
    mockList.mockResolvedValue([
      {
        provider: 'a',
        label: 'expired',
        source: 'env',
        authType: 'api_key',
        accessToken: 'x',
        priority: 1,
        expiresAt: Date.now() - 10_000,
      },
      {
        provider: 'b',
        label: 'never',
        source: 'manual',
        authType: 'api_key',
        accessToken: 'x',
        priority: 1,
      },
    ]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['list']!, {});
    } finally {
      stdout.restore();
    }

    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    const byLabel: Record<string, string> = Object.fromEntries(
      env.data.entries.map((e: { label: string; expiryStatus: string }) => [
        e.label,
        e.expiryStatus,
      ]),
    );
    expect(byLabel['expired']).toBe('expired');
    expect(byLabel['never']).toBe('never');
  });

  it('remove — happy path: dispatches RemovalStep, suppresses, removes entry', async () => {
    mockList.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'claude-code-import',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'sk-FAKE',
        priority: 100,
      },
    ]);
    mockRegistryFind.mockReturnValue(mockRemovalStep);
    mockRemovalStep.remove.mockResolvedValue({
      cleaned: [],
      hints: ['Do NOT delete ~/.claude/.credentials.json — re-seed suppressed.'],
      suppress: true,
    });
    mockRemoveCredential.mockResolvedValue(true);

    const stdout = captureStdout();
    const stderr = captureStderr();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['remove']!, {
        provider: 'anthropic',
        label: 'claude-code-import',
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(mockRegistryFind).toHaveBeenCalledWith('claude-code');
    expect(mockRemovalStep.remove).toHaveBeenCalledWith({
      provider: 'anthropic',
      label: 'claude-code-import',
    });
    expect(mockAddSuppression).toHaveBeenCalledWith('anthropic', 'claude-code');
    expect(mockRemoveCredential).toHaveBeenCalledWith('anthropic', 'claude-code-import');

    // Hint surfaced on stderr.
    const hintLine = stderr.lines.find((l) => l.startsWith('hint:'));
    expect(hintLine).toBeDefined();

    // Envelope on stdout.
    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      provider: 'anthropic',
      label: 'claude-code-import',
      source: 'claude-code',
      removed: true,
      suppressed: true,
    });
  });

  it('remove — entry not found emits E_NOT_FOUND envelope and exits 4', async () => {
    mockList.mockResolvedValue([]);

    const stdout = captureStdout();
    const stderr = captureStderr();
    const subs = await getAuthSubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    try {
      await expect(
        runSub(subs['remove']!, { provider: 'anthropic', label: 'nope' }),
      ).rejects.toThrow('__EXIT_4__');
    } finally {
      stdout.restore();
      stderr.restore();
      exitSpy.mockRestore();
    }

    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(false);
    expect(env.error.codeName).toBe('E_NOT_FOUND');
    expect(mockRegistryFind).not.toHaveBeenCalled();
    expect(mockRemoveCredential).not.toHaveBeenCalled();
  });

  it('remove — suppress:false skips addSuppression but still removes entry', async () => {
    mockList.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'manual-key',
        source: 'manual',
        authType: 'api_key',
        accessToken: 'x',
        priority: 1,
      },
    ]);
    mockRegistryFind.mockReturnValue({
      sourceId: 'manual',
      description: 'mock',
      remove: async () => ({ cleaned: [], hints: ['entry removed'], suppress: false }),
    });
    mockRemoveCredential.mockResolvedValue(true);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['remove']!, { provider: 'anthropic', label: 'manual-key' });
    } finally {
      stdout.restore();
    }

    expect(mockAddSuppression).not.toHaveBeenCalled();
    expect(mockRemoveCredential).toHaveBeenCalledWith('anthropic', 'manual-key');

    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.data.suppressed).toBe(false);
    expect(env.data.removed).toBe(true);
  });
});
