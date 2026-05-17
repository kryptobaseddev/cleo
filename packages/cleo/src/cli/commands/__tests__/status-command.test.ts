/**
 * CLI wiring tests for `cleo status` (T9424).
 *
 * Verifies the thin CLI wrapper over `getCleoStatus()`:
 *
 *   - JSON mode emits the full {@link CleoStatus} envelope via the LAFS
 *     `cliOutput` path with `meta.operation === 'status.show'`.
 *   - Human mode emits all six sections (Identity, Credentials, Config,
 *     Session, Harness, Daemon) on stdout.
 *   - `[INVALID]` and `[EXPIRED]` badges appear when credentials report
 *     `lastStatus === 'invalid'` or `isExpired === true`.
 *   - `hasSecretsInProjectConfig: true` raises a `WARNING:` banner at the
 *     top of human output.
 *   - Exit code is non-zero when any credential is `lastStatus === 'invalid'`
 *     and zero otherwise.
 *
 * `@cleocode/core/status/index.js` is mocked so the test runs without
 * touching the real credential pool, session store, or daemon-status API.
 *
 * @task T9424
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-5)
 */

import type { CommandDef } from 'citty';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command module.
// ---------------------------------------------------------------------------

const mockGetCleoStatus = vi.fn();

vi.mock('@cleocode/core/status', () => ({
  getCleoStatus: () => mockGetCleoStatus(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { setFormatContext } from '../../format-context.js';
import { statusCommand } from '../status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runStatus(args: Record<string, unknown>): Promise<void> {
  const resolved = (
    typeof statusCommand === 'function'
      ? await (statusCommand as () => Promise<CommandDef>)()
      : statusCommand
  ) as CommandDef;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('status command has no run function');
  await runFn({ args, rawArgs: [], cmd: resolved });
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

/**
 * Build a default healthy snapshot. Tests override individual fields by
 * spreading on top of this object.
 */
function healthyStatus(): Record<string, unknown> {
  return {
    identity: {
      agentId: 'agt-test-001',
      loggedIn: true,
      identityFile: '/tmp/.cleo/identity.json',
    },
    credentials: [
      {
        provider: 'anthropic',
        source: 'claude-code',
        hasCredential: true,
        authType: 'oauth',
        expiresAt: Date.now() + 60 * 60 * 1000,
        isExpired: false,
        lastStatus: 'ok',
        label: 'claude-code-import',
      },
    ],
    config: {
      globalConfigPath: '/home/test/.cleo/config.json',
      projectConfigPath: '/tmp/project/.cleo/config.json',
      activeConfigPath: '/tmp/project/.cleo/config.json',
      hasSecretsInProjectConfig: false,
      secretsWarnings: [],
    },
    session: {
      active: true,
      sessionId: 'sess-001',
      focusedTask: 'T9424',
    },
    harness: {
      active: 'claude-code',
      healthy: true,
      issues: [],
    },
    daemon: {
      running: true,
      pid: 12345,
      lastTickAt: Date.now() - 5000,
      killSwitchActive: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo status — CLI wiring (T9424)', () => {
  beforeEach(() => {
    mockGetCleoStatus.mockReset();
    process.env['NO_COLOR'] = '1';
    // Reset the format singleton to the documented default (json/agent-first)
    // so individual tests can opt into human mode via setFormatContext below.
    setFormatContext({ format: 'json', source: 'default', quiet: false });
  });

  it('--json mode emits the CleoStatus envelope with meta.operation=status.show', async () => {
    mockGetCleoStatus.mockResolvedValue(healthyStatus());
    setFormatContext({ format: 'json', source: 'default', quiet: false });

    const stdout = captureStdout();
    try {
      await runStatus({ json: true });
    } finally {
      stdout.restore();
    }

    expect(mockGetCleoStatus).toHaveBeenCalledTimes(1);
    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('status.show');
    expect(env.data).toMatchObject({
      identity: { agentId: 'agt-test-001', loggedIn: true },
      credentials: [{ provider: 'anthropic', lastStatus: 'ok' }],
      harness: { active: 'claude-code' },
      daemon: { running: true, pid: 12345 },
    });
  });

  it('human mode renders all six sections', async () => {
    mockGetCleoStatus.mockResolvedValue(healthyStatus());
    setFormatContext({ format: 'human', source: 'default', quiet: false });

    const stdout = captureStdout();
    try {
      await runStatus({});
    } finally {
      stdout.restore();
    }

    const text = stdout.lines.join('');
    expect(text).toContain('Identity');
    expect(text).toContain('Credentials');
    expect(text).toContain('Config');
    expect(text).toContain('Session');
    expect(text).toContain('Harness');
    expect(text).toContain('Daemon');
    // Identity fields surfaced.
    expect(text).toContain('agt-test-001');
    expect(text).toContain('/tmp/.cleo/identity.json');
    // No invalid badge on healthy credentials.
    expect(text).not.toContain('[INVALID]');
    expect(text).not.toContain('[EXPIRED]');
    // No WARNING banner when project config is clean.
    expect(text).not.toContain('WARNING:');
  });

  it('human mode shows [EXPIRED] for credentials with isExpired:true', async () => {
    const snapshot = healthyStatus();
    (snapshot['credentials'] as Array<Record<string, unknown>>)[0]!['isExpired'] = true;
    mockGetCleoStatus.mockResolvedValue(snapshot);
    setFormatContext({ format: 'human', source: 'default', quiet: false });

    const stdout = captureStdout();
    try {
      await runStatus({});
    } finally {
      stdout.restore();
    }

    expect(stdout.lines.join('')).toContain('[EXPIRED]');
  });

  it('human mode shows [INVALID] when lastStatus=invalid and exits 1', async () => {
    const snapshot = healthyStatus();
    (snapshot['credentials'] as Array<Record<string, unknown>>)[0]!['lastStatus'] = 'invalid';
    mockGetCleoStatus.mockResolvedValue(snapshot);
    setFormatContext({ format: 'human', source: 'default', quiet: false });

    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    try {
      await expect(runStatus({})).rejects.toThrow('__EXIT_1__');
    } finally {
      stdout.restore();
      exitSpy.mockRestore();
    }

    expect(stdout.lines.join('')).toContain('[INVALID]');
  });

  it('JSON mode also exits 1 when a credential is invalid', async () => {
    const snapshot = healthyStatus();
    (snapshot['credentials'] as Array<Record<string, unknown>>)[0]!['lastStatus'] = 'invalid';
    mockGetCleoStatus.mockResolvedValue(snapshot);
    setFormatContext({ format: 'json', source: 'default', quiet: false });

    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    try {
      await expect(runStatus({ json: true })).rejects.toThrow('__EXIT_1__');
    } finally {
      stdout.restore();
      exitSpy.mockRestore();
    }

    const env = JSON.parse(stdout.lines[stdout.lines.length - 1]!);
    expect(env.success).toBe(true);
    expect(env.data.credentials[0].lastStatus).toBe('invalid');
  });

  it('human mode surfaces hasSecretsInProjectConfig warning prominently', async () => {
    const snapshot = healthyStatus();
    (snapshot['config'] as Record<string, unknown>)['hasSecretsInProjectConfig'] = true;
    (snapshot['config'] as Record<string, unknown>)['secretsWarnings'] = [
      'llm.providers.anthropic.apiKey is set in project config',
    ];
    mockGetCleoStatus.mockResolvedValue(snapshot);
    setFormatContext({ format: 'human', source: 'default', quiet: false });

    const stdout = captureStdout();
    try {
      await runStatus({});
    } finally {
      stdout.restore();
    }

    const text = stdout.lines.join('');
    // Banner is at the very top — verify it appears before the Identity section.
    expect(text.indexOf('WARNING:')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('WARNING:')).toBeLessThan(text.indexOf('Identity'));
    expect(text).toContain('llm.providers.anthropic.apiKey');
  });

  it('exit 0 by default when all credentials are healthy', async () => {
    mockGetCleoStatus.mockResolvedValue(healthyStatus());
    setFormatContext({ format: 'json', source: 'default', quiet: false });

    const stdout = captureStdout();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    try {
      // Should NOT throw — exit 0 path does not call process.exit.
      await runStatus({ json: true });
    } finally {
      stdout.restore();
      exitSpy.mockRestore();
    }

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('human mode shows "(no credentials)" placeholder when pool is empty', async () => {
    const snapshot = healthyStatus();
    snapshot['credentials'] = [];
    mockGetCleoStatus.mockResolvedValue(snapshot);
    setFormatContext({ format: 'human', source: 'default', quiet: false });

    const stdout = captureStdout();
    try {
      await runStatus({});
    } finally {
      stdout.restore();
    }

    expect(stdout.lines.join('')).toContain('(no credentials');
  });
});
