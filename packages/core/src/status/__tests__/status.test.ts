/**
 * Unit tests for `getCleoStatus()` (T-E3-4 / T9423).
 *
 * Each sub-block is exercised in isolation by mocking exactly the helper(s)
 * the block reads. The mocks are declared at module scope so vitest hoists
 * them before the `getCleoStatus` import resolves (the standard
 * `vi.mock(path, factory)` pattern used elsewhere in `packages/core/src`).
 *
 * Spec: `docs/plans/E-CONFIG-AUTH-UNIFY.md` §5.3 T-E3-4.
 *
 * @task T9423
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('../../llm/credential-pool.js', () => ({
  getCredentialPool: vi.fn(),
}));

vi.mock('../../sentient/daemon-api.js', () => ({
  getDaemonStatus: vi.fn(),
}));

vi.mock('../../sessions/index.js', () => ({
  sessionStatus: vi.fn(),
}));

// Imported AFTER vi.mock declarations so the mocked module replaces the
// real one in the dependency graph.
import { getCredentialPool } from '../../llm/credential-pool.js';
import { getDaemonStatus } from '../../sentient/daemon-api.js';
import { sessionStatus } from '../../sessions/index.js';
import { getCleoStatus } from '../index.js';

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
let testRoot: string;

beforeEach(() => {
  // Per-test tmpdir as the project root + isolated cleo home.
  testRoot = join(
    tmpdir(),
    `cleo-status-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(testRoot, '.cleo'), { recursive: true });
  const cleoHome = join(testRoot, 'cleo-home');
  mkdirSync(cleoHome, { recursive: true });

  for (const k of [
    'HOME',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'CLEO_HOME',
    'CLEO_ROOT',
    'CLEO_HARNESS',
    'CLAUDECODE',
    'CLEO_PI',
  ]) {
    SAVED_ENV[k] = process.env[k];
  }
  // `getProjectRoot()` honors CLEO_ROOT first; pin to the per-test root.
  process.env['CLEO_ROOT'] = testRoot;
  process.env['CLEO_HOME'] = cleoHome;
  delete process.env['CLEO_HARNESS'];
  delete process.env['CLAUDECODE'];
  delete process.env['CLEO_PI'];

  // Mock baselines — every test overrides what it needs.
  vi.mocked(getCredentialPool).mockReturnValue({
    list: async () => [],
    // Cast through unknown to avoid pulling the full UnifiedCredentialPool
    // surface into this test fixture — only `list` is consumed by status.
  } as unknown as ReturnType<typeof getCredentialPool>);

  vi.mocked(sessionStatus).mockResolvedValue(null);

  vi.mocked(getDaemonStatus).mockResolvedValue({
    running: false,
    pid: null,
    uptime: null,
    lastHygieneRun: null,
    lastDreamCycle: null,
    supervisesStudio: false,
    studioStatus: 'disabled',
    sentient: {
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      lastCronFiredAt: null,
      killSwitch: false,
      killSwitchReason: null,
      stats: { ticks: 0, proposalsAccepted: 0, proposalsRejected: 0, errors: 0 },
      stuckCount: 0,
      activeTaskId: null,
      hygieneLastRunAt: null,
      hygieneSummary: null,
      hygieneStats: { orphans: 0, contentDefects: 0 },
      supervisesStudio: false,
      studioStatus: 'disabled',
    },
    // Cast: SentientStatus carries optional fields outside the spec's view;
    // the test fixture mirrors the shape returned by `getSentientDaemonStatus`.
  } as unknown as Awaited<ReturnType<typeof getDaemonStatus>>);
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Identity block
// ---------------------------------------------------------------------------

describe('getCleoStatus.identity', () => {
  it('defaults to null/loggedIn=false when no global config and no identity file', async () => {
    const status = await getCleoStatus();
    expect(status.identity.agentId).toBeNull();
    expect(status.identity.identityFile).toBeNull();
    expect(status.identity.loggedIn).toBe(false);
  });

  it('reads top-level agentId from global config and reports loggedIn=true', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(join(cleoHome, 'config.json'), JSON.stringify({ agentId: 'cleo-prime' }));

    const status = await getCleoStatus();
    expect(status.identity.agentId).toBe('cleo-prime');
    expect(status.identity.loggedIn).toBe(true);
  });

  it('reads nested identity.agentId from global config', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(
      join(cleoHome, 'config.json'),
      JSON.stringify({ identity: { agentId: 'nested-agent' } }),
    );

    const status = await getCleoStatus();
    expect(status.identity.agentId).toBe('nested-agent');
    expect(status.identity.loggedIn).toBe(true);
  });

  it('surfaces identityFile when the keypair exists on disk', async () => {
    mkdirSync(join(testRoot, '.cleo', 'keys'), { recursive: true });
    const keyPath = join(testRoot, '.cleo', 'keys', 'cleo-identity.json');
    writeFileSync(keyPath, JSON.stringify({ sk: 'a'.repeat(64), pk: 'b'.repeat(64) }));

    const status = await getCleoStatus();
    expect(status.identity.identityFile).toBe(keyPath);
    expect(status.identity.loggedIn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Credentials block
// ---------------------------------------------------------------------------

describe('getCleoStatus.credentials', () => {
  it('maps StoredCredential entries to CredentialStatusEntry rows', async () => {
    const now = Date.now();
    vi.mocked(getCredentialPool).mockReturnValue({
      list: async () => [
        {
          provider: 'anthropic',
          label: 'default',
          authType: 'api_key',
          accessToken: 'sk-test',
          priority: 0,
          source: 'env',
          expiresAt: now + 60_000,
          lastStatus: 'ok',
        },
        {
          provider: 'openai',
          label: 'stale',
          authType: 'oauth',
          accessToken: 'tok',
          priority: 10,
          source: 'unrecognised-source',
          expiresAt: now - 1_000,
        },
      ],
    } as unknown as ReturnType<typeof getCredentialPool>);

    const status = await getCleoStatus();
    expect(status.credentials).toHaveLength(2);

    const [first, second] = status.credentials;
    expect(first.provider).toBe('anthropic');
    expect(first.source).toBe('env');
    expect(first.hasCredential).toBe(true);
    expect(first.authType).toBe('api_key');
    expect(first.isExpired).toBe(false);
    expect(first.lastStatus).toBe('ok');
    expect(first.label).toBe('default');

    // Unknown seeder-source strings narrow to 'none'.
    expect(second.source).toBe('none');
    expect(second.isExpired).toBe(true);
    expect(second.authType).toBe('oauth');
  });

  it('returns an empty array when the credential pool throws', async () => {
    vi.mocked(getCredentialPool).mockReturnValue({
      list: async () => {
        throw new Error('store broken');
      },
    } as unknown as ReturnType<typeof getCredentialPool>);

    const status = await getCleoStatus();
    expect(status.credentials).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Config block
// ---------------------------------------------------------------------------

describe('getCleoStatus.config', () => {
  it('reports global path and a null projectConfigPath when no project config exists', async () => {
    const status = await getCleoStatus();
    expect(status.config.globalConfigPath).toContain('config.json');
    expect(status.config.projectConfigPath).toBeNull();
    expect(status.config.activeConfigPath).toBe(status.config.globalConfigPath);
    expect(status.config.hasSecretsInProjectConfig).toBe(false);
    expect(status.config.secretsWarnings).toEqual([]);
  });

  it('detects secrets in project config and emits one warning per provider', async () => {
    const projectConfigPath = join(testRoot, '.cleo', 'config.json');
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        llm: {
          providers: {
            anthropic: { apiKey: 'sk-secret' },
            openai: { apiKey: 'sk-also-secret' },
            gemini: {
              /* no key */
            },
          },
        },
      }),
    );

    const status = await getCleoStatus();
    expect(status.config.projectConfigPath).toBe(projectConfigPath);
    expect(status.config.activeConfigPath).toBe(projectConfigPath);
    expect(status.config.hasSecretsInProjectConfig).toBe(true);
    expect(status.config.secretsWarnings).toHaveLength(2);
    expect(status.config.secretsWarnings.some((w) => w.includes('anthropic'))).toBe(true);
    expect(status.config.secretsWarnings.some((w) => w.includes('openai'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session block
// ---------------------------------------------------------------------------

describe('getCleoStatus.session', () => {
  it('reports inactive when sessionStatus returns null', async () => {
    const status = await getCleoStatus();
    expect(status.session.active).toBe(false);
    expect(status.session.sessionId).toBeNull();
    expect(status.session.focusedTask).toBeNull();
  });

  it('reports active session id + focused task when one exists', async () => {
    vi.mocked(sessionStatus).mockResolvedValueOnce({
      id: 'ses_test_1',
      name: 'fake',
      status: 'active',
      scope: { type: 'project' },
      taskWork: { taskId: 'T9423', setAt: '2026-05-17T00:00:00Z' },
      startedAt: '2026-05-17T00:00:00Z',
    } as unknown as Awaited<ReturnType<typeof sessionStatus>>);

    const status = await getCleoStatus();
    expect(status.session.active).toBe(true);
    expect(status.session.sessionId).toBe('ses_test_1');
    expect(status.session.focusedTask).toBe('T9423');
  });

  it('falls back to inactive when the session store throws', async () => {
    vi.mocked(sessionStatus).mockRejectedValueOnce(new Error('db locked'));
    const status = await getCleoStatus();
    expect(status.session.active).toBe(false);
    expect(status.session.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Harness block
// ---------------------------------------------------------------------------

describe('getCleoStatus.harness', () => {
  // --- Layer 4: default ---

  it('defaults to unknown when no env vars or config are set', async () => {
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('unknown');
    expect(status.harness.healthy).toBe(true);
    expect(status.harness.issues).toEqual([]);
  });

  // --- Layer 1: explicit CLEO_HARNESS env var ---

  it('detects pi when CLEO_HARNESS=pi', async () => {
    process.env['CLEO_HARNESS'] = 'pi';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('pi');
  });

  it('detects claude-code when CLEO_HARNESS=claude-code', async () => {
    process.env['CLEO_HARNESS'] = 'claude-code';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  it('falls back to unknown for unrecognised CLEO_HARNESS values', async () => {
    process.env['CLEO_HARNESS'] = 'not-a-known-harness';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('unknown');
  });

  it('CLEO_HARNESS wins over CLAUDECODE=1 (layer 1 beats layer 2)', async () => {
    process.env['CLEO_HARNESS'] = 'pi';
    process.env['CLAUDECODE'] = '1';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('pi');
  });

  // --- Layer 2: provider auto-detect ---

  it('auto-detects claude-code when CLAUDECODE=1', async () => {
    process.env['CLAUDECODE'] = '1';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  it('auto-detects pi when CLEO_PI=1', async () => {
    process.env['CLEO_PI'] = '1';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('pi');
  });

  it('CLAUDECODE wins over CLEO_PI (layer 2 order: claude-code first)', async () => {
    process.env['CLAUDECODE'] = '1';
    process.env['CLEO_PI'] = '1';
    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  // --- Layer 3: global config harness.active ---

  it('reads harness.active from global config when no env vars are set', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(join(cleoHome, 'config.json'), JSON.stringify({ harness: { active: 'pi' } }));

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('pi');
  });

  it('reads harness.active=claude-code from global config', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(
      join(cleoHome, 'config.json'),
      JSON.stringify({ harness: { active: 'claude-code' } }),
    );

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  it('ignores unrecognised harness.active values in global config (falls back to unknown)', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(
      join(cleoHome, 'config.json'),
      JSON.stringify({ harness: { active: 'bogus-value' } }),
    );

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('unknown');
  });

  it('CLEO_HARNESS env wins over global config (layer 1 beats layer 3)', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(join(cleoHome, 'config.json'), JSON.stringify({ harness: { active: 'pi' } }));
    process.env['CLEO_HARNESS'] = 'claude-code';

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  it('CLAUDECODE=1 wins over global config (layer 2 beats layer 3)', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(join(cleoHome, 'config.json'), JSON.stringify({ harness: { active: 'pi' } }));
    process.env['CLAUDECODE'] = '1';

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('claude-code');
  });

  it('degrades to unknown when global config is corrupt', async () => {
    const cleoHome = process.env['CLEO_HOME'] ?? '';
    writeFileSync(join(cleoHome, 'config.json'), '{ invalid json >>>');

    const status = await getCleoStatus();
    expect(status.harness.active).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Daemon block
// ---------------------------------------------------------------------------

describe('getCleoStatus.daemon', () => {
  it('reports stopped/no kill-switch when the daemon is not running', async () => {
    const status = await getCleoStatus();
    expect(status.daemon.running).toBe(false);
    expect(status.daemon.pid).toBeNull();
    expect(status.daemon.lastTickAt).toBeNull();
    expect(status.daemon.killSwitchActive).toBe(false);
  });

  it('parses ISO lastTickAt into epoch ms and reflects kill-switch state', async () => {
    const iso = '2026-05-17T12:00:00.000Z';
    const expectedEpoch = Date.parse(iso);

    vi.mocked(getDaemonStatus).mockResolvedValueOnce({
      running: true,
      pid: 12345,
      uptime: iso,
      lastHygieneRun: null,
      lastDreamCycle: null,
      supervisesStudio: false,
      studioStatus: 'disabled',
      sentient: {
        running: true,
        pid: 12345,
        startedAt: iso,
        lastTickAt: iso,
        lastCronFiredAt: iso,
        killSwitch: true,
        killSwitchReason: 'manual',
        stats: { ticks: 1, proposalsAccepted: 0, proposalsRejected: 0, errors: 0 },
        stuckCount: 0,
        activeTaskId: null,
        hygieneLastRunAt: null,
        hygieneSummary: null,
        hygieneStats: { orphans: 0, contentDefects: 0 },
        supervisesStudio: false,
        studioStatus: 'disabled',
      },
    } as unknown as Awaited<ReturnType<typeof getDaemonStatus>>);

    const status = await getCleoStatus();
    expect(status.daemon.running).toBe(true);
    expect(status.daemon.pid).toBe(12345);
    expect(status.daemon.lastTickAt).toBe(expectedEpoch);
    expect(status.daemon.killSwitchActive).toBe(true);
  });

  it('falls back to a stopped snapshot when getDaemonStatus throws', async () => {
    vi.mocked(getDaemonStatus).mockRejectedValueOnce(new Error('no state file'));
    const status = await getCleoStatus();
    expect(status.daemon.running).toBe(false);
    expect(status.daemon.pid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Performance contract (sub-2-second)
// ---------------------------------------------------------------------------

describe('getCleoStatus performance', () => {
  it('completes well under the 2-second budget on a populated mock', async () => {
    vi.mocked(getCredentialPool).mockReturnValue({
      list: async () =>
        Array.from({ length: 50 }, (_, i) => ({
          provider: 'anthropic',
          label: `entry-${i}`,
          authType: 'api_key',
          accessToken: 'sk-test',
          priority: i,
          source: 'env',
        })),
    } as unknown as ReturnType<typeof getCredentialPool>);

    const start = Date.now();
    const status = await getCleoStatus();
    const elapsed = Date.now() - start;

    expect(status.credentials).toHaveLength(50);
    expect(elapsed).toBeLessThan(2_000);
  });
});
