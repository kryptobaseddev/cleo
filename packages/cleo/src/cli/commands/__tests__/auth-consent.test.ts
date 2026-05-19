/**
 * Unit tests for `cleo auth consent` (T9598).
 *
 * Verifies:
 *   - `auth` exposes `consent` as a subcommand.
 *   - `--status` reads the consent flag and suppression state.
 *   - `--enable-claude-code` writes true to global config and removes suppression.
 *   - `--disable-claude-code` writes false to global config, adds suppression,
 *     and purges all source:claude-code pool entries (bug #6 fix).
 *   - No-flag invocation exits with E_INVALID_INPUT.
 *   - Mutually-exclusive flags exit with E_INVALID_INPUT.
 *   - `auth list` emits a hint when ~/.claude/.credentials.json exists but
 *     no claude-code entries are present in the pool.
 *
 * All external dependencies (config, credential-removal, credentials-store)
 * are mocked so no real files are read or written.
 *
 * @task T9598
 * @epic T9587
 */

import type { CommandDef } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command modules.
// ---------------------------------------------------------------------------

const mockGetConfigValue = vi.fn();
const mockSetConfigValue = vi.fn().mockResolvedValue({ key: '', value: false, scope: 'global' });

vi.mock('@cleocode/core/config.js', () => ({
  getConfigValue: (...a: unknown[]) => mockGetConfigValue(...a),
  setConfigValue: (...a: unknown[]) => mockSetConfigValue(...a),
}));

const mockIsSuppressed = vi.fn().mockReturnValue(false);
const mockAddSuppression = vi.fn();
const mockRemoveSuppression = vi.fn().mockReturnValue(false);

vi.mock('@cleocode/core/llm/credential-removal.js', () => ({
  REMOVAL_REGISTRY: { find: vi.fn() },
  addSuppression: (...a: unknown[]) => mockAddSuppression(...a),
  removeSuppression: (...a: unknown[]) => mockRemoveSuppression(...a),
  isSuppressed: (...a: unknown[]) => mockIsSuppressed(...a),
}));

const mockListCredentials = vi.fn().mockResolvedValue([]);
const mockRemoveCredential = vi.fn().mockResolvedValue(false);

vi.mock('@cleocode/core/llm/credentials-store.js', () => ({
  listCredentials: (...a: unknown[]) => mockListCredentials(...a),
  removeCredential: (...a: unknown[]) => mockRemoveCredential(...a),
}));

const mockSeed = vi.fn().mockResolvedValue({ added: 0, failed: 0, skipped: 0 });
const mockPoolList = vi.fn().mockResolvedValue([]);

vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => ({ seed: mockSeed, list: mockPoolList }),
}));

// Selective existsSync mock for the list hint tests.
// The mock routes calls for `~/.claude/.credentials.json` to a controllable
// flag (mockClaudeCredsExists) while passing every other path through to the
// real implementation so CLEO internals (session files, config paths, etc.)
// are unaffected.
let mockClaudeCredsExists = false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.claude/.credentials.json')) {
        return mockClaudeCredsExists;
      }
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    }),
  };
});

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

function lastEnvelope(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1]!);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo auth consent — subcommand registration', () => {
  it('auth command exposes consent subcommand', async () => {
    const subs = await getAuthSubs();
    expect(Object.keys(subs)).toContain('consent');
  });
});

describe('cleo auth consent --status', () => {
  beforeEach(() => {
    process.env['CLEO_FORMAT'] = 'json';
    mockGetConfigValue.mockReset();
    mockIsSuppressed.mockReset().mockReturnValue(false);
  });

  it('reports consent enabled=true and suppressed=false', async () => {
    mockGetConfigValue.mockResolvedValue({ value: true });
    mockIsSuppressed.mockReturnValue(false);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { status: true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('auth.consent.status');
    const gates = (
      env.data as { gates: Array<{ gate: string; enabled: boolean; suppressed: boolean }> }
    ).gates;
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gate: 'claudeCode',
      configKey: 'auth.claudeCodeConsentGiven',
      enabled: true,
      suppressed: false,
    });
  });

  it('reports consent enabled=false and suppressed=true', async () => {
    mockGetConfigValue.mockResolvedValue({ value: false });
    mockIsSuppressed.mockReturnValue(true);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { status: true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const gates = (env.data as { gates: Array<{ enabled: boolean; suppressed: boolean }> }).gates;
    expect(gates[0]).toMatchObject({ enabled: false, suppressed: true });
  });

  it('treats undefined config value as enabled=false', async () => {
    mockGetConfigValue.mockResolvedValue({ value: undefined });

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { status: true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const gates = (env.data as { gates: Array<{ enabled: boolean }> }).gates;
    expect(gates[0]!.enabled).toBe(false);
  });
});

describe('cleo auth consent --enable-claude-code', () => {
  beforeEach(() => {
    process.env['CLEO_FORMAT'] = 'json';
    mockSetConfigValue.mockReset().mockResolvedValue({ key: '', value: true, scope: 'global' });
    mockRemoveSuppression.mockReset().mockReturnValue(false);
  });

  it('writes true to global config and removes suppression', async () => {
    mockRemoveSuppression.mockReturnValue(true); // was suppressed

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'enable-claude-code': true });
    } finally {
      stdout.restore();
    }

    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'auth.claudeCodeConsentGiven',
      true,
      undefined,
      { global: true },
    );
    expect(mockRemoveSuppression).toHaveBeenCalledWith('anthropic', 'claude-code');

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('auth.consent.enable');
    const data = env.data as {
      action: string;
      value: boolean;
      suppressionChanged: boolean;
      purgedCount: number;
    };
    expect(data.action).toBe('enabled');
    expect(data.value).toBe(true);
    expect(data.suppressionChanged).toBe(true);
    expect(data.purgedCount).toBe(0);
  });

  it('suppressionChanged=false when there was no suppression to remove', async () => {
    mockRemoveSuppression.mockReturnValue(false);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'enable-claude-code': true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { suppressionChanged: boolean };
    expect(data.suppressionChanged).toBe(false);
  });

  it('does NOT purge pool entries on enable', async () => {
    mockListCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'claude-code',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'token',
        priority: 100,
      },
    ]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'enable-claude-code': true });
    } finally {
      stdout.restore();
    }

    // removeCredential must NOT be called on enable.
    expect(mockRemoveCredential).not.toHaveBeenCalled();
  });
});

describe('cleo auth consent --disable-claude-code', () => {
  beforeEach(() => {
    process.env['CLEO_FORMAT'] = 'json';
    mockSetConfigValue.mockReset().mockResolvedValue({ key: '', value: false, scope: 'global' });
    mockAddSuppression.mockReset();
    mockIsSuppressed.mockReset().mockReturnValue(false);
    mockListCredentials.mockReset().mockResolvedValue([]);
    mockRemoveCredential.mockReset().mockResolvedValue(true);
  });

  it('writes false to global config and adds suppression', async () => {
    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'disable-claude-code': true });
    } finally {
      stdout.restore();
    }

    expect(mockSetConfigValue).toHaveBeenCalledWith(
      'auth.claudeCodeConsentGiven',
      false,
      undefined,
      { global: true },
    );
    expect(mockAddSuppression).toHaveBeenCalledWith('anthropic', 'claude-code');

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('auth.consent.disable');
    const data = env.data as { action: string; value: boolean };
    expect(data.action).toBe('disabled');
    expect(data.value).toBe(false);
  });

  it('purges all source:claude-code pool entries on disable (bug #6 fix)', async () => {
    mockListCredentials.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'claude-code',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'tok1',
        priority: 100,
      },
      {
        provider: 'anthropic',
        label: 'claude-code-alt',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'tok2',
        priority: 90,
      },
      {
        provider: 'openai',
        label: 'manual-key',
        source: 'manual',
        authType: 'api_key',
        accessToken: 'key',
        priority: 50,
      },
    ]);
    mockRemoveCredential.mockResolvedValue(true);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'disable-claude-code': true });
    } finally {
      stdout.restore();
    }

    // Only the two claude-code entries are purged, not the manual one.
    expect(mockRemoveCredential).toHaveBeenCalledTimes(2);
    expect(mockRemoveCredential).toHaveBeenCalledWith('anthropic', 'claude-code');
    expect(mockRemoveCredential).toHaveBeenCalledWith('anthropic', 'claude-code-alt');
    expect(mockRemoveCredential).not.toHaveBeenCalledWith('openai', 'manual-key');

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { purgedCount: number };
    expect(data.purgedCount).toBe(2);
  });

  it('purgedCount=0 when no claude-code entries exist in pool', async () => {
    mockListCredentials.mockResolvedValue([]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'disable-claude-code': true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { purgedCount: number };
    expect(data.purgedCount).toBe(0);
  });

  it('suppressionChanged=false when already suppressed before disable', async () => {
    mockIsSuppressed.mockReturnValue(true); // already suppressed

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['consent']!, { 'disable-claude-code': true });
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { suppressionChanged: boolean };
    expect(data.suppressionChanged).toBe(false);
  });
});

describe('cleo auth consent — invalid invocations', () => {
  beforeEach(() => {
    process.env['CLEO_FORMAT'] = 'json';
  });

  it('exits 6 with E_INVALID_INPUT when no flag supplied', async () => {
    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    const subs = await getAuthSubs();
    try {
      await expect(runSub(subs['consent']!, {})).rejects.toThrow('__EXIT_6__');
    } finally {
      stdout.restore();
      exitSpy.mockRestore();
    }

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(false);
    expect((env.error as { codeName?: string }).codeName).toBe('E_INVALID_INPUT');
  });

  it('exits 6 with E_INVALID_INPUT when both enable and disable flags supplied', async () => {
    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    const subs = await getAuthSubs();
    try {
      await expect(
        runSub(subs['consent']!, { 'enable-claude-code': true, 'disable-claude-code': true }),
      ).rejects.toThrow('__EXIT_6__');
    } finally {
      stdout.restore();
      exitSpy.mockRestore();
    }

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(false);
    expect((env.error as { codeName?: string }).codeName).toBe('E_INVALID_INPUT');
  });
});

describe('cleo auth list — consent hint', () => {
  beforeEach(() => {
    process.env['CLEO_FORMAT'] = 'json';
    mockSeed.mockClear();
    mockPoolList.mockReset();
    mockClaudeCredsExists = false;
  });

  it('emits hint when ~/.claude/.credentials.json exists and no claude-code entry in pool', async () => {
    mockClaudeCredsExists = true;
    mockPoolList.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'manual-key',
        source: 'manual',
        authType: 'api_key',
        accessToken: 'key',
        priority: 50,
      },
    ]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['list']!, {});
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    expect(env.success).toBe(true);
    const data = env.data as { hint?: string };
    expect(data.hint).toBeDefined();
    expect(data.hint).toContain('cleo auth consent --enable-claude-code');
  });

  it('does not emit hint when claude-code entry is already in pool', async () => {
    mockClaudeCredsExists = true;
    mockPoolList.mockResolvedValue([
      {
        provider: 'anthropic',
        label: 'claude-code',
        source: 'claude-code',
        authType: 'oauth',
        accessToken: 'token',
        priority: 100,
      },
    ]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['list']!, {});
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { hint?: string };
    expect(data.hint).toBeUndefined();
  });

  it('does not emit hint when ~/.claude/.credentials.json does not exist', async () => {
    mockClaudeCredsExists = false;
    mockPoolList.mockResolvedValue([]);

    const stdout = captureStdout();
    const subs = await getAuthSubs();
    try {
      await runSub(subs['list']!, {});
    } finally {
      stdout.restore();
    }

    const env = lastEnvelope(stdout.lines);
    const data = env.data as { hint?: string };
    expect(data.hint).toBeUndefined();
  });
});
