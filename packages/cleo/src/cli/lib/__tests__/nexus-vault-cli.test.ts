/**
 * `cleo cloud push | pull | restore | verify | vault | lease | activity` glue
 * (T12337, T12950, T12951): flags reach the core vault and activity calls
 * unchanged, invalid input exits 6 with E_VALIDATION, and the restore relink
 * callback never fails a restore that already succeeded.
 *
 * The core flows are mocked; nothing touches the network or a CLEO home.
 *
 * @task T12337
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pushNexusVault = vi.fn();
const restoreNexusVault = vi.fn();
const verifyNexusVault = vi.fn();
const nexusVaultStatus = vi.fn();
const releaseNexusVaultLease = vi.fn();
const nexusCloudActivity = vi.fn();
const linkProjectToNexus = vi.fn();

vi.mock('@cleocode/core/cloud/nexus-vault.js', () => ({
  pushNexusVault,
  restoreNexusVault,
  verifyNexusVault,
  nexusVaultStatus,
  releaseNexusVaultLease,
}));
vi.mock('@cleocode/core/cloud/nexus-cloud-activity.js', () => ({ nexusCloudActivity }));
vi.mock('@cleocode/core/cloud/nexus-link.js', () => ({ linkProjectToNexus }));
vi.mock('@cleocode/core/cloud/nexus-cloud-status.js', () => ({
  NexusCloudOfflineError: class NexusCloudOfflineError extends Error {},
}));

const {
  runCloudActivity,
  runCloudLease,
  runCloudPull,
  runCloudPush,
  runCloudRestore,
  runCloudVault,
  runCloudVerify,
} = await import('../nexus-vault-cli.js');

const API = 'https://api.nexus.test';
const base = { apiUrl: API, scope: 'project', streamId: 'project:p', warnings: [] };
const snapshot = {
  checkpointId: 'cp-1',
  parentCheckpointId: null,
  deviceId: 'd-1',
  deviceName: 'laptop',
  replicaId: 'r-1',
  coversSeq: 0,
  createdAt: null,
  sizeBytes: 10,
  rows: 3,
  endorsedBy: [],
};
const restoreResult = {
  ...base,
  status: 'restored',
  snapshot,
  target: '/x',
  verified: true,
  tables: 2,
  safetyBackup: null,
};

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
/**
 * Exit codes in call order. The real `process.exit` ends the process at the
 * first call; the stub throws instead, which a caller's catch may turn into a
 * second exit, so the first one is the one that counts.
 */
let exits: Array<string | number | null | undefined>;

/** Everything written to stdout and stderr so far. */
const written = () =>
  [...stdout.mock.calls, ...stderr.mock.calls].map((c: unknown[]) => String(c[0])).join('');

beforeEach(() => {
  pushNexusVault.mockReset().mockResolvedValue({
    ...base,
    status: 'pushed',
    snapshot,
    parentCheckpointId: null,
    deltaSegmentSeq: null,
    lease: null,
    forked: false,
  });
  restoreNexusVault.mockReset().mockResolvedValue(restoreResult);
  verifyNexusVault.mockReset().mockResolvedValue({
    ...base,
    verdict: 'match',
    localIntegrity: true,
    head: snapshot,
    lastSynced: 'cp-1',
    tables: [],
    devices: [],
    remedy: null,
  });
  nexusVaultStatus.mockReset().mockResolvedValue({
    ...base,
    headSeq: 0,
    head: snapshot,
    lineage: [snapshot],
    lastPushByDevice: [],
    pendingChanges: [],
    lastSynced: 'cp-1',
    leases: [],
  });
  releaseNexusVaultLease.mockReset().mockResolvedValue({ ...base, released: true });
  nexusCloudActivity
    .mockReset()
    .mockResolvedValue({ apiUrl: API, projectId: null, items: [], nextBefore: null, warnings: [] });
  linkProjectToNexus.mockReset().mockResolvedValue({ warnings: ['linked with a note'] });
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exits = [];
  exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exits.push(code);
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  exit.mockRestore();
});

const opts = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0]?.[0] as Record<string, unknown>;

describe('flags reach the core calls', () => {
  it('push passes scope, force, hold and the API URL', async () => {
    await runCloudPush({ 'api-url': API, scope: 'global', force: true, hold: true });
    expect(opts(pushNexusVault)).toEqual({ apiUrl: API, scope: 'global', force: true, hold: true });
    await runCloudPush({});
    expect(pushNexusVault.mock.calls[1]?.[0]).toEqual({
      apiUrl: undefined,
      scope: 'project',
      force: false,
      hold: false,
    });
    expect(written()).toContain('cp-1');
  });

  it('restore passes checkpoint, project, into and force', async () => {
    await runCloudRestore({
      scope: 'project',
      checkpoint: 'cp-0',
      project: 'p-remote',
      into: '/tmp/target',
      force: true,
    });
    expect(opts(restoreNexusVault)).toMatchObject({
      apiUrl: undefined,
      scope: 'project',
      mode: 'restore',
      force: true,
      checkpointId: 'cp-0',
      projectId: 'p-remote',
      into: '/tmp/target',
    });
    expect(typeof opts(restoreNexusVault)['relink']).toBe('function');
  });

  it('pull ignores --checkpoint, --project and --into', async () => {
    await runCloudPull({ scope: 'global', checkpoint: 'cp-0', project: 'p', into: '/tmp/x' });
    const o = opts(restoreNexusVault);
    expect(o).toMatchObject({ scope: 'global', mode: 'pull', force: false });
    expect(o).not.toHaveProperty('checkpointId');
    expect(o).not.toHaveProperty('projectId');
    expect(o).not.toHaveProperty('into');
  });

  it('verify, vault and lease release pass scope and the API URL', async () => {
    await runCloudVerify({ 'api-url': API, scope: 'global' });
    await runCloudVault({ scope: 'global' });
    await runCloudLease({ action: 'release', scope: 'global' });
    await runCloudLease({});
    expect(opts(verifyNexusVault)).toEqual({ apiUrl: API, scope: 'global' });
    expect(opts(nexusVaultStatus)).toEqual({ apiUrl: undefined, scope: 'global' });
    expect(opts(releaseNexusVaultLease)).toEqual({ apiUrl: undefined, scope: 'global' });
    expect(releaseNexusVaultLease.mock.calls[1]?.[0]).toEqual({
      apiUrl: undefined,
      scope: 'project',
    });
  });

  it('activity passes limit (as a number), before, project and device', async () => {
    await runCloudActivity({
      'api-url': API,
      limit: '25',
      before: '1234',
      project: 'p-remote',
      device: 'd-2',
    });
    expect(opts(nexusCloudActivity)).toEqual({
      apiUrl: API,
      limit: 25,
      before: '1234',
      projectId: 'p-remote',
      deviceId: 'd-2',
    });
    await runCloudActivity({});
    expect(nexusCloudActivity.mock.calls[1]?.[0]).toEqual({ apiUrl: undefined });
  });
});

describe('invalid input', () => {
  it.each([
    ['push', runCloudPush],
    ['pull', runCloudPull],
    ['restore', runCloudRestore],
    ['verify', runCloudVerify],
    ['vault', runCloudVault],
  ] as const)('%s --scope bogus fails with E_VALIDATION (exit 6) before any call', async (_, run) => {
    await expect(run({ scope: 'bogus' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(6);
    expect(written()).toContain('E_VALIDATION');
    for (const fn of [pushNexusVault, restoreNexusVault, verifyNexusVault, nexusVaultStatus]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('lease foo fails with E_VALIDATION (exit 6) and releases nothing', async () => {
    await expect(runCloudLease({ action: 'foo' })).rejects.toThrow(/^exit:/);
    expect(exits).toEqual([6]);
    expect(written()).toContain('E_VALIDATION');
    expect(releaseNexusVaultLease).not.toHaveBeenCalled();
  });

  it.each([
    ['E_NEXUS_VAULT_LEASE_HELD', 7],
    ['E_NEXUS_VAULT_STORE_BUSY', 7],
    ['E_NEXUS_VAULT_BEHIND', 23],
    ['E_NEXUS_VAULT_LOCAL_CHANGES', 21],
    ['E_NEXUS_VAULT_VERIFY_FAILED', 20],
    ['E_NEXUS_VAULT_REFUSED', 1],
  ])('the refusal %s exits %i (T12976)', async (code, exitCode) => {
    pushNexusVault.mockRejectedValueOnce(Object.assign(new Error('refused'), { code }));
    await expect(runCloudPush({})).rejects.toThrow(/^exit:/);
    expect(exits).toEqual([exitCode]);
    expect(written()).toContain(code);
  });

  it('a core failure exits 1 with its code', async () => {
    pushNexusVault.mockRejectedValueOnce(
      Object.assign(new Error('server said no'), { code: 'E_NEXUS_REQUEST_FAILED' }),
    );
    await expect(runCloudPush({})).rejects.toThrow(/^exit:/);
    expect(exits).toEqual([1]);
    expect(written()).toContain('E_NEXUS_REQUEST_FAILED');
  });
});

describe('restore relink callback', () => {
  type Relink = (root: string) => Promise<string[]>;

  it('returns the link warnings, attaching the restored root with the same API URL', async () => {
    await runCloudRestore({ 'api-url': API, project: 'p', into: '/tmp/target' });
    const relink = opts(restoreNexusVault)['relink'] as Relink;
    await expect(relink('/tmp/target')).resolves.toEqual(['linked with a note']);
    expect(linkProjectToNexus).toHaveBeenCalledWith({ apiUrl: API, projectRoot: '/tmp/target' });
  });

  it('turns a linkProjectToNexus throw into a warning string', async () => {
    linkProjectToNexus.mockRejectedValueOnce(new Error('E_NEXUS_REPLICA_COPIED: copied'));
    await runCloudRestore({ project: 'p', into: '/tmp/target' });
    const relink = opts(restoreNexusVault)['relink'] as Relink;
    const warnings = await relink('/tmp/target');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^restored, but attaching this copy failed \(E_NEXUS_REPLICA_COPIED: copied\); run `cleo project link`$/,
    );
  });

  it('a non-Error throw is stringified', async () => {
    linkProjectToNexus.mockRejectedValueOnce('boom');
    await runCloudRestore({});
    const relink = opts(restoreNexusVault)['relink'] as Relink;
    await expect(relink('/r')).resolves.toEqual([
      'restored, but attaching this copy failed (boom); run `cleo project link`',
    ]);
  });
});
