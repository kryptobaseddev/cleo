/**
 * The guided first run of `cleo login nexus` (T13102): which path it takes
 * (link and back up, ask, never ask, already linked, list projects, skip) and
 * how each step's failure is reported. Link, push and the project list are
 * stubs here; the first run against a fake Cleo Nexus with the real push and
 * restore is in `nexus-vault.test.ts` ("guided first run").
 *
 * Every test uses its own temp CLEO home and project; no request leaves the process.
 *
 * @task T13102
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CloudPushResult,
  CloudRestoreResult,
  NexusNamedProject,
  NexusProjectLink,
  NexusProjectLinkResult,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEXUS_API_URL_ENV, NexusAccountError } from '../nexus-auth.js';
import { NEXUS_DEVICE_ENV } from '../nexus-device.js';
import {
  NEXUS_FIRST_RUN_QUESTION,
  NEXUS_FIRST_RUN_RESTORE_QUESTION,
  type NexusFirstRunOptions,
  runNexusFirstRun,
  W_NEXUS_FIRST_RUN_BACKUP,
  W_NEXUS_FIRST_RUN_LINK,
  W_NEXUS_FIRST_RUN_PROJECTS,
  W_NEXUS_FIRST_RUN_RESTORE,
} from '../nexus-first-run.js';
import type { NexusNamedProjectsResult } from '../nexus-project-names.js';

/** The defaults the first run uses when no stub is given: spies over the real modules. */
const defaults = vi.hoisted(() => ({
  link: vi.fn(),
  push: vi.fn(),
}));
vi.mock('../nexus-link.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../nexus-link.js')>();
  return { ...mod, linkProjectToNexus: defaults.link };
});
vi.mock('../nexus-vault.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../nexus-vault.js')>();
  return { ...mod, pushNexusVault: defaults.push };
});

const API = 'https://api.nexus.test';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';
const OTHER_DEVICE = '0198a1b2-0000-7000-8000-0000000000d2';
const REPLICA = '0198a1b2-0000-7000-8000-0000000000e1';
const ORG = '0198a1b2-0000-7000-8000-0000000000f1';
const NOW = '2026-10-02T12:00:00.000Z';
/** What a run that did not link and back up names (the API is the default origin here). */
const LINK_AND_BACK_UP = 'cleo project link && cleo cloud push';

let base: string;
let projectRoot: string;
let outside: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nexus-first-run-'));
  projectRoot = join(base, 'proj');
  outside = join(base, 'not-a-project');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(projectRoot, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  saved = {
    [NEXUS_DEVICE_ENV]: process.env[NEXUS_DEVICE_ENV],
    CLEO_HOME: process.env['CLEO_HOME'],
    CLEO_DIR: process.env['CLEO_DIR'],
    [NEXUS_API_URL_ENV]: process.env[NEXUS_API_URL_ENV],
  };
  process.env[NEXUS_DEVICE_ENV] = '1';
  // The fake origin is the default here, so printed commands carry no --api-url.
  process.env[NEXUS_API_URL_ENV] = API;
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
  defaults.link.mockReset();
  defaults.push.mockReset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

function linkEntry(extra: Partial<NexusProjectLink> = {}): NexusProjectLink {
  return {
    apiUrl: API,
    localProjectId: PROJECT_ID,
    remoteProjectId: PROJECT_ID,
    organizationId: ORG,
    label: 'proj',
    streamId: `project:${PROJECT_ID}`,
    linkedAt: NOW,
    replicaId: REPLICA,
    nexusDeviceId: DEVICE,
    attachedAt: NOW,
    ...extra,
  };
}

/** Write `.cleo/nexus-link.json` as `cleo project link` would. */
function writeLink(link: NexusProjectLink): void {
  writeFileSync(
    join(projectRoot, '.cleo', 'nexus-link.json'),
    JSON.stringify({ version: 1, links: { [API]: link } }),
  );
}

function linkResult(extra: Partial<NexusProjectLinkResult> = {}): NexusProjectLinkResult {
  return {
    link: linkEntry(),
    alreadyLinked: false,
    linkPath: join(projectRoot, '.cleo', 'nexus-link.json'),
    replica: { replicaId: REPLICA, deviceId: DEVICE, reboundFrom: null, presenceAt: NOW },
    attachError: null,
    warnings: [],
    ...extra,
  };
}

function pushResult(status: CloudPushResult['status'] = 'pushed'): CloudPushResult {
  return {
    apiUrl: API,
    scope: 'project',
    streamId: `project:${PROJECT_ID}`,
    status,
    snapshot: {
      checkpointId: 'cp-1',
      parentCheckpointId: null,
      deviceId: DEVICE,
      deviceName: 'laptop',
      replicaId: REPLICA,
      coversSeq: 1,
      createdAt: NOW,
      sizeBytes: 10,
      rows: 7,
      endorsedBy: [],
    },
    parentCheckpointId: null,
    deltaSegmentSeq: null,
    lease: null,
    forked: false,
    warnings: [],
  };
}

function restoreResult(): CloudRestoreResult {
  return {
    apiUrl: API,
    scope: 'project',
    streamId: `project:${PROJECT_ID}`,
    status: 'restored',
    snapshot: pushResult().snapshot,
    target: projectRoot,
    verified: true,
    tables: 4,
    safetyBackup: null,
    warnings: [],
  };
}

/** Stubbed link/push/restore/list, no cloud backup, and a recording prompt. */
function stubs() {
  return {
    link: vi.fn(async () => linkResult()),
    push: vi.fn(async () => pushResult()),
    restore: vi.fn(async (_o: Parameters<NonNullable<NexusFirstRunOptions['restore']>>[0]) =>
      restoreResult(),
    ),
    cloudBackup: vi.fn(async () => false),
    listProjects: vi.fn(
      async (): Promise<NexusNamedProjectsResult> => ({
        apiUrl: API,
        projects: [],
        incomplete: false,
        warnings: [],
      }),
    ),
    confirm: vi.fn(async () => true),
  };
}

function run(
  s: ReturnType<typeof stubs>,
  extra: Partial<NexusFirstRunOptions> & Pick<NexusFirstRunOptions, 'consent'>,
) {
  return runNexusFirstRun({
    apiUrl: API,
    projectRoot,
    deviceId: DEVICE,
    link: s.link,
    push: s.push,
    restore: s.restore,
    cloudBackup: s.cloudBackup,
    listProjects: s.listProjects,
    confirm: s.confirm,
    ...extra,
  });
}

function named(extra: Partial<NexusNamedProject> = {}): NexusNamedProject {
  return {
    projectId: PROJECT_ID,
    name: 'demo',
    nameSource: 'label',
    label: 'demo',
    organizationName: 'Personal',
    lastSyncAt: NOW,
    hasBackup: true,
    onThisDevice: false,
    restoreCommand: `cleo cloud restore ${PROJECT_ID}`,
    restoreByNameCommand: 'cleo cloud restore demo',
    ...extra,
  };
}

describe('guided first run inside an unlinked project', () => {
  it('--yes links through the link step, then pushes the project, without asking', async () => {
    const s = stubs();
    const steps: string[] = [];
    const r = await run(s, { consent: 'yes', onStep: (step) => steps.push(step) });
    expect(r.state).toBe('backed-up');
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.link).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: API, projectRoot }));
    expect(s.push).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, projectRoot, scope: 'project' }),
    );
    // Link strictly before push.
    expect(s.link.mock.invocationCallOrder[0]).toBeLessThan(
      s.push.mock.invocationCallOrder[0] ?? 0,
    );
    expect(steps).toEqual(['link', 'backup']);
    expect(r.backup).toEqual({ status: 'pushed', snapshot: pushResult().snapshot });
    expect(r.link?.remoteProjectId).toBe(PROJECT_ID);
    expect(r.nextCommand).toBeNull();
  });

  it('a terminal is asked once and a yes links and backs up', async () => {
    const s = stubs();
    const r = await run(s, { consent: 'prompt' });
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.confirm).toHaveBeenCalledWith(NEXUS_FIRST_RUN_QUESTION, true);
    expect(r.state).toBe('backed-up');
    expect(s.push).toHaveBeenCalledTimes(1);
  });

  it('a terminal that answers no is left unlinked with the next command', async () => {
    const s = stubs();
    s.confirm.mockResolvedValueOnce(false);
    const r = await run(s, { consent: 'prompt' });
    expect(r.state).toBe('declined');
    expect(r.nextCommand).toBe(LINK_AND_BACK_UP);
    expect(s.link).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('a prompt that fails (closed stdin, Ctrl-C) counts as no', async () => {
    const s = stubs();
    s.confirm.mockRejectedValueOnce(new Error('stdin closed'));
    const r = await run(s, { consent: 'prompt' });
    expect(r.state).toBe('declined');
    expect(s.link).not.toHaveBeenCalled();
  });

  it('a non-interactive run never asks, never links, and reports the exact next command', async () => {
    const s = stubs();
    const r = await run(s, { consent: 'never' });
    expect(r.state).toBe('offered');
    expect(r.nextCommand).toBe(LINK_AND_BACK_UP);
    expect(r.projectRoot).toBe(projectRoot);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.link).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('an unattended run (an agent, T13288) links and backs up without asking', async () => {
    const s = stubs();
    const r = await run(s, { consent: 'unattended' });
    expect(r.state).toBe('backed-up');
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.link).toHaveBeenCalledWith(expect.objectContaining({ apiUrl: API, projectRoot }));
    expect(s.push).toHaveBeenCalledWith(expect.objectContaining({ projectRoot, scope: 'project' }));
    expect(r.nextCommand).toBeNull();
  });

  it('prompt without a way to ask acts as never', async () => {
    const s = stubs();
    const r = await runNexusFirstRun({
      apiUrl: API,
      projectRoot,
      consent: 'prompt',
      link: s.link,
      push: s.push,
    });
    expect(r.state).toBe('offered');
    expect(s.link).not.toHaveBeenCalled();
  });

  it('a link failure is reported with its code and remedy, and nothing is pushed', async () => {
    const s = stubs();
    s.link.mockRejectedValueOnce(
      new NexusAccountError(
        'E_NEXUS_INVALID_LABEL',
        'this project is your home directory',
        'pass `--label <name>`',
      ),
    );
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('link-failed');
    expect(r.nextCommand).toBe(LINK_AND_BACK_UP);
    expect(r.warnings).toEqual([
      {
        code: W_NEXUS_FIRST_RUN_LINK,
        message:
          'E_NEXUS_INVALID_LABEL: this project is your home directory; pass `--label <name>`',
      },
    ]);
    expect(s.push).not.toHaveBeenCalled();
  });

  it('a link that could not attach this copy is not pushed (the push would refuse)', async () => {
    const s = stubs();
    s.link.mockResolvedValueOnce(
      linkResult({
        replica: null,
        attachError: { code: 'E_NEXUS_REPLICA_COPIED', message: 'copied store', fix: null },
        warnings: ['the project is linked, but this copy was not attached'],
      }),
    );
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('backup-failed');
    expect(r.link?.remoteProjectId).toBe(PROJECT_ID);
    expect(r.warnings.map((w) => w.code)).toEqual([
      'W_NEXUS_FIRST_RUN_LINK_NOTE',
      W_NEXUS_FIRST_RUN_BACKUP,
    ]);
    expect(r.warnings[1]?.message).toContain('E_NEXUS_REPLICA_COPIED');
    expect(s.push).not.toHaveBeenCalled();
  });

  it('a push failure leaves the project linked and names `cleo cloud push` as the next step', async () => {
    const s = stubs();
    s.push.mockRejectedValueOnce(
      new NexusAccountError('E_NEXUS_VAULT_LEASE_HELD', 'another device holds the lease'),
    );
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('backup-failed');
    expect(r.nextCommand).toBe('cleo cloud push');
    expect(r.link).not.toBeNull();
    expect(r.warnings).toEqual([
      {
        code: W_NEXUS_FIRST_RUN_BACKUP,
        message: 'E_NEXUS_VAULT_LEASE_HELD: another device holds the lease',
      },
    ]);
  });

  it('a push refused as behind (another device pushed since) names `cleo cloud pull`', async () => {
    const s = stubs();
    s.push.mockRejectedValueOnce(
      new NexusAccountError(
        'E_NEXUS_VAULT_BEHIND',
        "another device pushed snapshot cp-2 after this machine's last sync",
        'run `cleo cloud pull` first',
      ),
    );
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('backup-failed');
    expect(r.nextCommand).toBe('cleo cloud pull');
  });

  it('every printed command names a non-default API origin', async () => {
    process.env[NEXUS_API_URL_ENV] = 'https://api.cleocode.dev';
    const s = stubs();
    const r = await run(s, { consent: 'never' });
    expect(r.nextCommand).toBe(
      `cleo project link --api-url ${API} && cleo cloud push --api-url ${API}`,
    );
  });

  it('asks whether the cloud holds an unsynced backup of this project (by its id and root)', async () => {
    const s = stubs();
    await run(s, { consent: 'never' });
    expect(s.cloudBackup).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, projectRoot, projectId: PROJECT_ID }),
    );
  });

  it('an up-to-date push still counts as backed up', async () => {
    const s = stubs();
    s.push.mockResolvedValueOnce(pushResult('up-to-date'));
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('backed-up');
    expect(r.backup?.status).toBe('up-to-date');
  });

  it('without stubs it links with linkProjectToNexus and pushes with pushNexusVault', async () => {
    defaults.link.mockResolvedValueOnce(linkResult());
    defaults.push.mockResolvedValueOnce(pushResult());
    const r = await runNexusFirstRun({ apiUrl: API, projectRoot, consent: 'yes' });
    expect(r.state).toBe('backed-up');
    expect(defaults.link).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, projectRoot }),
    );
    expect(defaults.push).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, projectRoot, scope: 'project' }),
    );
  });
});

describe('guided first run inside a project the cloud backs up and this copy never synced', () => {
  const restoreCmd = () => `cleo cloud restore ${PROJECT_ID} --into ${projectRoot}`;

  it('--yes restores that backup into the project (then links it) instead of pushing', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    const steps: string[] = [];
    const r = await run(s, { consent: 'yes', onStep: (step) => steps.push(step) });
    expect(r.state).toBe('restored');
    expect(r.offer).toBe('restore');
    expect(steps).toEqual(['restore']);
    expect(s.push).not.toHaveBeenCalled();
    expect(s.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: API,
        scope: 'project',
        mode: 'restore',
        projectId: PROJECT_ID,
        into: projectRoot,
      }),
    );
    expect(r.restore).toEqual({
      status: 'restored',
      snapshot: pushResult().snapshot,
      tables: 4,
      safetyBackup: null,
    });
    // The restore's relink is the link step; a failure there is a warning, not a failed restore.
    const relink = s.restore.mock.calls[0]?.[0].relink;
    expect(await relink?.(projectRoot)).toEqual([]);
    expect(s.link).toHaveBeenCalledWith(expect.objectContaining({ projectRoot }));
    s.link.mockRejectedValueOnce(new NexusAccountError('E_NEXUS_REPLICA_COPIED', 'copied store'));
    const warned = await relink?.(projectRoot);
    expect(warned?.[0]).toContain('E_NEXUS_REPLICA_COPIED');
  });

  it('a terminal is asked the restore question', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    s.confirm.mockResolvedValueOnce(false);
    const r = await run(s, { consent: 'prompt' });
    // A restore replaces this copy's state: an empty answer means no.
    expect(s.confirm).toHaveBeenCalledWith(NEXUS_FIRST_RUN_RESTORE_QUESTION, false);
    expect(r.state).toBe('declined');
    expect(r.offer).toBe('restore');
    expect(r.nextCommand).toBe(restoreCmd());
    expect(s.restore).not.toHaveBeenCalled();
  });

  it('a non-interactive run restores nothing and names the exact restore command', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    const r = await run(s, { consent: 'never' });
    expect(r.state).toBe('offered');
    expect(r.offer).toBe('restore');
    expect(r.nextCommand).toBe(restoreCmd());
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.restore).not.toHaveBeenCalled();
    expect(s.link).not.toHaveBeenCalled();
  });

  it('an unattended run (T13288) never restores over this copy: it names the restore command', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    const r = await run(s, { consent: 'unattended' });
    expect(r.state).toBe('offered');
    expect(r.offer).toBe('restore');
    expect(r.nextCommand).toBe(restoreCmd());
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.restore).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('a restore refused for local rows it never synced leaves the choice to the user, not a loop', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    s.restore.mockRejectedValueOnce(
      new NexusAccountError(
        'E_NEXUS_VAULT_LOCAL_CHANGES',
        'this store has local changes',
        'pass --force (a safety backup is taken first)',
      ),
    );
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('restore-failed');
    // Rerunning the same restore would refuse the same way: no single next command.
    expect(r.nextCommand).toBeNull();
    expect(r.choices.map((c) => c.command)).toEqual([
      `${restoreCmd()} --force`,
      'cleo project link && cleo cloud push --force',
    ]);
    expect(r.warnings).toEqual([
      {
        code: W_NEXUS_FIRST_RUN_RESTORE,
        message:
          'E_NEXUS_VAULT_LOCAL_CHANGES: this store has local changes; pass --force (a safety backup is taken first)',
      },
    ]);
  });

  it('any other restore failure names the same restore command to retry', async () => {
    const s = stubs();
    s.cloudBackup.mockResolvedValueOnce(true);
    s.restore.mockRejectedValueOnce(new NexusAccountError('E_NEXUS_UNREACHABLE', 'no answer'));
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('restore-failed');
    expect(r.nextCommand).toBe(restoreCmd());
    expect(r.choices).toEqual([]);
  });
});

describe('guided first run inside a linked project', () => {
  it('a project attached from this device is left alone, even with --yes', async () => {
    writeLink(linkEntry());
    const s = stubs();
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('already-linked');
    expect(r.link?.replicaId).toBe(REPLICA);
    expect(s.link).not.toHaveBeenCalled();
    expect(s.push).not.toHaveBeenCalled();
  });

  it('a link attached from another device id (this machine re-enrolled) is offered again', async () => {
    writeLink(linkEntry({ nexusDeviceId: OTHER_DEVICE }));
    const s = stubs();
    const r = await run(s, { consent: 'never' });
    expect(r.state).toBe('offered');
    expect(r.link?.nexusDeviceId).toBe(OTHER_DEVICE);
  });

  it('a link with no replica attached is offered again', async () => {
    writeLink(linkEntry({ replicaId: undefined, nexusDeviceId: undefined, attachedAt: undefined }));
    const s = stubs();
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('backed-up');
    expect(s.link).toHaveBeenCalledTimes(1);
  });
});

describe('guided first run outside a project', () => {
  it("lists the account's projects with this device id and names the single restore command", async () => {
    const s = stubs();
    s.listProjects.mockResolvedValueOnce({
      apiUrl: API,
      projects: [
        named(),
        named({ projectId: 'p2', name: 'old', restoreCommand: null, hasBackup: false }),
      ],
      incomplete: false,
      warnings: [],
    });
    const r = await run(s, { consent: 'yes', projectRoot: outside });
    expect(r.state).toBe('projects');
    expect(s.listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, deviceId: DEVICE }),
    );
    expect(r.projects.map((p) => p.name)).toEqual(['demo', 'old']);
    // The machine-read command is by id; the name is for the human line.
    expect(r.nextCommand).toBe(`cleo cloud restore ${PROJECT_ID}`);
    expect(s.link).not.toHaveBeenCalled();
    expect(s.confirm).not.toHaveBeenCalled();
  });

  it('several restorable projects name no single next command', async () => {
    const s = stubs();
    s.listProjects.mockResolvedValueOnce({
      apiUrl: API,
      projects: [
        named(),
        named({ projectId: 'p2', name: 'b', restoreCommand: 'cleo cloud restore b' }),
      ],
      incomplete: false,
      warnings: [],
    });
    const r = await run(s, { consent: 'never', projectRoot: outside });
    expect(r.nextCommand).toBeNull();
  });

  it('a list failure is a warning, never a failed login', async () => {
    const s = stubs();
    s.listProjects.mockRejectedValueOnce(
      new NexusAccountError('E_NEXUS_UNREACHABLE', 'no answer from the API'),
    );
    const r = await run(s, { consent: 'never', projectRoot: outside });
    expect(r.state).toBe('projects');
    expect(r.nextCommand).toBe('cleo cloud projects');
    expect(r.warnings).toEqual([
      { code: W_NEXUS_FIRST_RUN_PROJECTS, message: 'E_NEXUS_UNREACHABLE: no answer from the API' },
    ]);
  });
});

describe('guided first run skips', () => {
  it('a read-only device', async () => {
    const s = stubs();
    const r = await run(s, { consent: 'yes', readOnly: true });
    expect(r.state).toBe('skipped');
    expect(r.reason).toContain('read-only');
    expect(s.link).not.toHaveBeenCalled();
    expect(s.listProjects).not.toHaveBeenCalled();
  });

  it('device credentials off (CLEO_NEXUS_DEVICE=0)', async () => {
    process.env[NEXUS_DEVICE_ENV] = '0';
    const s = stubs();
    const r = await run(s, { consent: 'yes' });
    expect(r.state).toBe('skipped');
    expect(r.reason).toContain('CLEO_NEXUS_DEVICE=0');
    expect(s.link).not.toHaveBeenCalled();
  });
});
