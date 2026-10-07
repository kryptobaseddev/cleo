/**
 * `cleo login nexus` guided first run glue (T13102): `--yes` passes consent
 * `yes` and never prompts; a terminal is asked on stderr through the wizard
 * prompt (default yes); a non-interactive run outside CI is unattended
 * (T13288: core takes each question's safe default, never prompting) and CI
 * is never asked and prints the exact next command on stderr and in
 * `data.firstRun`; a first-run failure
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
    offer: null,
    backup: null,
    restore: null,
    projects: [],
    nextCommand: null,
    choices: [],
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
    offer: null,
    backup: null,
    restore: null,
    projects: [],
    nextCommand: null,
    choices: [],
    warnings: [],
    ...fields,
  };
}

const savedTTY = process.stdin.isTTY;
const savedErrTTY = process.stderr.isTTY;
const savedFormat = process.env['CLEO_FORMAT'];
const savedCI = process.env['CI'];
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

/** stdin and stderr on a terminal (or not); `stderr` defaults to the same. */
function setTTY(value: boolean, stderrValue: boolean = value): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: stderrValue, configurable: true });
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
  // CI sets CI=true; the prompt tests stand for a person at a terminal.
  delete process.env['CI'];
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
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: savedErrTTY, configurable: true });
  if (savedCI === undefined) delete process.env['CI'];
  else process.env['CI'] = savedCI;
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

  it('a terminal: consent prompt, asked on stderr with the default core chooses, and the prompt closed', async () => {
    setTTY(true);
    runNexusFirstRun.mockImplementationOnce(
      async (o: { confirm: (q: string, defaultYes: boolean) => Promise<boolean> }) => {
        await o.confirm('Link it?', true);
        await o.confirm('Restore it?', false);
        return firstRun({ state: 'declined', nextCommand: 'cleo project link && cleo cloud push' });
      },
    );
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'prompt' });
    expect(ioCreated).toHaveBeenCalledWith(process.stdin, process.stderr);
    expect(confirm).toHaveBeenCalledWith('Link it?', true);
    expect(confirm).toHaveBeenCalledWith('Restore it?', false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a terminal stdin with stderr redirected never prompts (the prompt would be invisible): unattended (T13288)', async () => {
    setTTY(true, false);
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'unattended' });
    expect(ioCreated).not.toHaveBeenCalled();
  });

  it('under CI a terminal never prompts', async () => {
    setTTY(true);
    process.env['CI'] = 'true';
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'never' });
    expect(ioCreated).not.toHaveBeenCalled();
  });

  it('a choice left to the user is printed as choice lines on stderr, with no next line', async () => {
    runNexusFirstRun.mockResolvedValueOnce(
      firstRun({
        state: 'restore-failed',
        offer: 'restore',
        choices: [
          { command: 'cleo cloud restore p --into /r --force', effect: 'take the backup' },
          { command: 'cleo project link && cleo cloud push --force', effect: 'keep this copy' },
        ],
      }),
    );
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(err()).toContain('choice: cleo cloud restore p --into /r --force  (take the backup)\n');
    expect(err()).toContain(
      'choice: cleo project link && cleo cloud push --force  (keep this copy)\n',
    );
    expect(err()).not.toContain('next:');
    expect(envelope().data.firstRun.choices).toHaveLength(2);
  });

  it('non-interactive (an agent): consent unattended, no prompt, and the core report on stderr and in the envelope (T13288)', async () => {
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'unattended' });
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

  it('non-interactive under CI: consent never (CI never acts)', async () => {
    process.env['CI'] = 'true';
    await runNexusLoginCommand({ provider: 'nexus' }, 'login.run', vi.fn());
    expect(firstRunOpts()).toMatchObject({ consent: 'never' });
    expect(ioCreated).not.toHaveBeenCalled();
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

  it('restored: "Signed in, restored, linked" with the snapshot and the safety backup', () => {
    const line = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'restored',
        link,
        offer: 'restore',
        restore: {
          status: 'restored',
          snapshot: null,
          tables: 4,
          safetyBackup: '/tmp/safety.tar',
        },
      }),
    );
    expect(line.startsWith('Signed in, restored, linked.')).toBe(true);
    expect(line).toContain('4 tables verified');
    expect(line).toContain('/tmp/safety.tar');
  });

  it('a restore offer says the cloud holds a backup this copy never synced', () => {
    const offered = nexusFirstRunSummary(
      LOGIN,
      firstRun({ state: 'offered', offer: 'restore', nextCommand: 'RESTORE-CMD' }),
    );
    expect(offered).toContain('holds a backup of this project that this copy never synced');
    expect(offered).toContain('RESTORE-CMD');
    expect(
      nexusFirstRunSummary(
        LOGIN,
        firstRun({ state: 'declined', offer: 'restore', nextCommand: 'R' }),
      ),
    ).toContain('Not restored');
  });

  it('restore-failed with choices lists each command and its effect', () => {
    const text = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'restore-failed',
        choices: [
          { command: 'CMD-A', effect: 'effect a' },
          { command: 'CMD-B', effect: 'effect b' },
        ],
      }),
    );
    expect(text).toContain('Choose one:');
    expect(text).toContain('  CMD-A  (effect a)');
    expect(text).toContain('  CMD-B  (effect b)');
  });

  it('offered, declined and failures name the next command', () => {
    for (const state of [
      'offered',
      'declined',
      'link-failed',
      'backup-failed',
      'restore-failed',
    ] as const) {
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
            restoreCommand: 'cleo cloud restore p1',
            restoreByNameCommand: "cleo cloud restore 'Demo Board'",
          },
          {
            ...base,
            projectId: 'p4',
            name: 'twin',
            hasBackup: true,
            onThisDevice: false,
            restoreCommand: 'cleo cloud restore p4',
            restoreByNameCommand: null,
          },
          {
            ...base,
            projectId: 'p2',
            name: 'empty',
            hasBackup: false,
            onThisDevice: false,
            restoreCommand: null,
            restoreByNameCommand: null,
          },
          {
            ...base,
            projectId: 'p3',
            name: 'here',
            hasBackup: true,
            onThisDevice: true,
            restoreCommand: null,
            restoreByNameCommand: null,
          },
        ],
      }),
    );
    expect(text).toContain(
      "  Demo Board (last sync 2026-10-01T00:00:00.000Z): cleo cloud restore 'Demo Board'",
    );
    // A name several projects share falls back to the id for the person too.
    expect(text).toContain('  twin (backed up): cleo cloud restore p4');
    expect(text).toContain('  empty (no backup yet)');
    expect(text).toContain('  here (already on this machine)');
  });

  it('a server label cannot forge a row or carry control (#1958 LOW-1)', () => {
    const forged =
      'evil\x1b[31m\u2028\n  Prod (already on this machine): cleo cloud restore attacker';
    const text = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'projects',
        projects: [
          {
            projectId: 'p1',
            name: forged,
            nameSource: 'label',
            label: forged,
            organizationName: null,
            lastSyncAt: null,
            hasBackup: true,
            onThisDevice: false,
            restoreCommand: 'cleo cloud restore p1',
            restoreByNameCommand: `cleo cloud restore '${forged}'`,
          },
        ],
      }),
    );
    // The header and exactly one project row.
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain(
      '  evil Prod (already on this machine): cleo cloud restore attacker (backed up)',
    );
    expect(text).not.toMatch(/[\x1b\u2028]/);
    const linked = nexusFirstRunSummary(
      LOGIN,
      firstRun({
        state: 'backed-up',
        link: {
          apiUrl: API,
          localProjectId: 'l-1',
          remoteProjectId: 'p1',
          organizationId: 'o-1',
          label: forged,
          streamId: 'project:p1',
          linkedAt: '2026-10-01T00:00:00.000Z',
        },
      }),
    );
    expect(linked.split('\n')).toHaveLength(1);
    expect(linked).toContain('Project "evil Prod (already on this machine)');
  });

  it('projects: an empty account says how to start', () => {
    expect(nexusFirstRunSummary(LOGIN, firstRun({ state: 'projects' }))).toContain(
      'no Cleo Nexus projects yet',
    );
  });
});
