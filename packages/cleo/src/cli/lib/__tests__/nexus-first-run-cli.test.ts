/**
 * `cleo login nexus` guided first run glue (T13102): `--yes` passes consent
 * `yes` and never prompts; a terminal is asked on stderr through the wizard
 * prompt (default yes); a non-interactive run is never asked and prints the
 * exact next command on stderr and in `data.firstRun`; a first-run failure
 * never fails the sign-in; and the human summary says "Signed in, linked,
 * backed up" or lists the restore commands.
 *
 * Sign-in and the core first run are mocked; nothing touches the network or a CLEO home.
 *
 * @task T13102
 */

import type { NexusFirstRunResult, NexusLoginResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runNexusFirstRun = vi.fn();
vi.mock('@cleocode/core/cloud/nexus-first-run.js', () => ({
  runNexusFirstRun,
  nexusFirstRunResult: (state: string, fields: Partial<NexusFirstRunResult> = {}) => ({
    state,
    reason: null,
    projectRoot: null,
    link: null,
    backup: null,
    projects: [],
    nextCommand: null,
    warnings: [],
    ...fields,
  }),
}));

const runNexusLogin = vi.fn();
vi.mock('../nexus-account-cli.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../nexus-account-cli.js')>();
  return { ...mod, runNexusLogin };
});

const confirm = vi.fn();
const close = vi.fn();
const ioCreated = vi.fn();
vi.mock('../readline-wizard-io.js', () => ({
  ReadlineWizardIO: class {
    constructor(input: unknown, output: unknown) {
      ioCreated(input, output);
    }
    confirm(question: string, defaultValue?: boolean) {
      return confirm(question, defaultValue);
    }
    close() {
      close();
    }
  },
}));

const { nexusFirstRunSummary, runNexusLoginCommand } = await import('../nexus-first-run-cli.js');

const API = 'https://api.nexus.test';
const LOGIN: NexusLoginResult = {
  apiUrl: API,
  user: { id: 'u-1', email: 'dev@example.test' },
  organization: null,
  expiresAt: null,
  credentialsPath: '/tmp/x',
  warnings: [],
  device: { deviceId: 'd-1', name: 'laptop', state: 'active', profile: 'device', created: true },
  scopes: ['projects:read'],
};

function firstRun(fields: Partial<NexusFirstRunResult>): NexusFirstRunResult {
  return {
    state: 'skipped',
    reason: null,
    projectRoot: null,
    link: null,
    backup: null,
    projects: [],
    nextCommand: null,
    warnings: [],
    ...fields,
  };
}

const savedTTY = process.stdin.isTTY;
const savedFormat = process.env['CLEO_FORMAT'];
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

const out = (): string => stdout.mock.calls.map((c: unknown[]) => String(c[0])).join('');
const err = (): string => stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('');
const envelope = () =>
  JSON.parse(
    out()
      .split('\n')
      .filter((l: string) => l.trim().startsWith('{'))
      .at(-1) ?? '{}',
  );
const firstRunOpts = () => runNexusFirstRun.mock.calls[0]?.[0] as Record<string, unknown>;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  runNexusLogin.mockReset().mockResolvedValue(LOGIN);
  runNexusFirstRun
    .mockReset()
    .mockResolvedValue(
      firstRun({ state: 'offered', nextCommand: 'cleo project link && cleo cloud push' }),
    );
  confirm.mockReset().mockResolvedValue(true);
  close.mockReset();
  ioCreated.mockReset();
  process.env['CLEO_FORMAT'] = 'json';
  setTTY(false);
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  exit.mockRestore();
  setTTY(savedTTY);
  if (savedFormat === undefined) delete process.env['CLEO_FORMAT'];
  else process.env['CLEO_FORMAT'] = savedFormat;
});

describe('consent', () => {
  it('--yes: consent yes, no prompt is opened, even on a terminal', async () => {
    setTTY(true);
    await runNexusLoginCommand({ provider: 'nexus', yes: true }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'yes', apiUrl: API, deviceId: 'd-1' });
    expect(firstRunOpts()).not.toHaveProperty('confirm');
    expect(ioCreated).not.toHaveBeenCalled();
  });

  it('a terminal: consent prompt, asked on stderr with yes as the default, and the prompt closed', async () => {
    setTTY(true);
    runNexusFirstRun.mockImplementationOnce(
      async (o: { confirm: (q: string) => Promise<boolean> }) => {
        await o.confirm('Link it?');
        return firstRun({ state: 'declined', nextCommand: 'cleo project link && cleo cloud push' });
      },
    );
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'prompt' });
    expect(ioCreated).toHaveBeenCalledWith(process.stdin, process.stderr);
    expect(confirm).toHaveBeenCalledWith('Link it?', true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('non-interactive: consent never, no prompt, and the next command on stderr and in the envelope', async () => {
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'never' });
    expect(firstRunOpts()).not.toHaveProperty('confirm');
    expect(ioCreated).not.toHaveBeenCalled();
    expect(err()).toContain('next: cleo project link && cleo cloud push\n');
    const env = envelope();
    expect(env.success).toBe(true);
    expect(env.data.user.email).toBe('dev@example.test');
    expect(env.data.firstRun).toMatchObject({
      state: 'offered',
      nextCommand: 'cleo project link && cleo cloud push',
    });
  });

  it('passes --read-only through and the enrolled device id', async () => {
    await runNexusLoginCommand({ provider: 'nexus', 'read-only': true }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ readOnly: true, deviceId: 'd-1' });
  });
});

describe('failures', () => {
  it('a first-run crash is a warning on a successful sign-in, never an exit', async () => {
    runNexusFirstRun.mockRejectedValueOnce(new Error('kaboom'));
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(exit).not.toHaveBeenCalled();
    const env = envelope();
    expect(env.success).toBe(true);
    expect(env.data.firstRun).toMatchObject({ state: 'skipped' });
    expect(err()).toContain('warning: kaboom (W_NEXUS_FIRST_RUN_FAILED)');
  });

  it('a sign-in failure exits through failNexus and runs no first run', async () => {
    runNexusLogin.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'E_NEXUS_ACCESS_DENIED' }),
    );
    await expect(runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn())).rejects.toThrow(
      /^exit:1$/,
    );
    expect(runNexusFirstRun).not.toHaveBeenCalled();
  });

  it('prints each first-run warning to stderr with its code', async () => {
    runNexusFirstRun.mockResolvedValueOnce(
      firstRun({
        state: 'backup-failed',
        nextCommand: 'cleo cloud push',
        warnings: [{ code: 'W_NEXUS_FIRST_RUN_BACKUP', message: 'E_NEXUS_VAULT_LEASE_HELD: held' }],
      }),
    );
    await runNexusLoginCommand({ provider: 'nexus', yes: true }, 'login.run', vi.fn());
    expect(err()).toContain('warning: E_NEXUS_VAULT_LEASE_HELD: held (W_NEXUS_FIRST_RUN_BACKUP)');
    expect(err()).toContain('next: cleo cloud push');
  });
});

describe('human summary', () => {
  const link = {
    apiUrl: API,
    localProjectId: 'p',
    remoteProjectId: 'p',
    organizationId: 'o',
    label: 'demo',
    streamId: 'project:p',
    linkedAt: 'now',
  };

  it('backed up: "Signed in, linked, backed up" with the snapshot', () => {
    const line = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'backed-up',
        link,
        backup: {
          status: 'pushed',
          snapshot: {
            checkpointId: 'cp-9',
            parentCheckpointId: null,
            deviceId: 'd-1',
            deviceName: 'laptop',
            replicaId: 'r',
            coversSeq: 1,
            createdAt: null,
            sizeBytes: 1,
            rows: 12,
            endorsedBy: [],
          },
        },
      }),
    );
    expect(line.startsWith('Signed in, linked, backed up.')).toBe(true);
    expect(line).toContain('Project "demo" is linked and backed up (snapshot cp-9, 12 rows)');
  });

  it('offered, declined and failures name the next command', () => {
    for (const state of ['offered', 'declined', 'link-failed', 'backup-failed'] as const) {
      expect(nexusFirstRunSummary(LOGIN, firstRun({ state, nextCommand: 'NEXT-CMD' }))).toContain(
        'NEXT-CMD',
      );
    }
  });

  it('projects: one line each, with its restore command or why there is none', () => {
    const base = {
      nameSource: 'label' as const,
      label: null,
      organizationName: null,
      lastSyncAt: null,
    };
    const text = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'projects',
        projects: [
          {
            ...base,
            projectId: 'p1',
            name: 'Demo Board',
            hasBackup: true,
            onThisDevice: false,
            lastSyncAt: '2026-10-01T00:00:00.000Z',
            restoreCommand: "cleo cloud restore 'Demo Board'",
          },
          {
            ...base,
            projectId: 'p2',
            name: 'empty',
            hasBackup: false,
            onThisDevice: false,
            restoreCommand: null,
          },
          {
            ...base,
            projectId: 'p3',
            name: 'here',
            hasBackup: true,
            onThisDevice: true,
            restoreCommand: null,
          },
        ],
      }),
    );
    expect(text).toContain(
      "  Demo Board (last sync 2026-10-01T00:00:00.000Z): cleo cloud restore 'Demo Board'",
    );
    expect(text).toContain('  empty (no backup yet)');
    expect(text).toContain('  here (already on this machine)');
  });

  it('projects: an empty account says how to start', () => {
    expect(nexusFirstRunSummary(LOGIN, firstRun({ state: 'projects' }))).toContain(
      'no Cleo Nexus projects yet',
    );
  });
});
