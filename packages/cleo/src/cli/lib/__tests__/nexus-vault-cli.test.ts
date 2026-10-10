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
const enableSyncPush = vi.fn();
const cloudSync = vi.fn();
const restoreNexusVault = vi.fn();
const verifyNexusVault = vi.fn();
const nexusVaultStatus = vi.fn();
const releaseNexusVaultLease = vi.fn();
const nexusCloudActivity = vi.fn();
const linkProjectToNexus = vi.fn();
const resolveNexusProjectRef = vi.fn();
const assertNexusRestoreTarget = vi.fn();

vi.mock('@cleocode/core/cloud/nexus-vault.js', () => ({
  cloudSync,
  enableSyncPush,
  pushNexusVault,
  restoreNexusVault,
  verifyNexusVault,
  nexusVaultStatus,
  releaseNexusVaultLease,
}));
vi.mock('@cleocode/core/cloud/nexus-cloud-activity.js', () => ({ nexusCloudActivity }));
vi.mock('@cleocode/core/cloud/nexus-link.js', () => ({ linkProjectToNexus }));
vi.mock('@cleocode/core/cloud/nexus-project-names.js', () => ({
  assertNexusRestoreTarget,
  resolveNexusProjectRef,
}));
vi.mock('@cleocode/core/cloud/nexus-cloud-status.js', () => ({
  NexusCloudOfflineError: class NexusCloudOfflineError extends Error {},
}));

const {
  cloudRestoreSummary,
  cloudVerifySummary,
  deepVerifyClause,
  runCloudActivity,
  runCloudLease,
  runCloudPull,
  runCloudPush,
  runCloudRestore,
  runCloudSync,
  runCloudVault,
  runCloudVerify,
  runSyncEnablePush,
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
  replica: null,
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
  assertNexusRestoreTarget.mockReset();
  resolveNexusProjectRef
    .mockReset()
    .mockImplementation(async (ref: string) => ({ projectId: ref, name: null, matchedBy: 'id' }));
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

  it('sync enable push passes scope and the API URL, never the unreleased opt-in (T12343)', async () => {
    enableSyncPush.mockReset().mockResolvedValue({
      ...base,
      status: 'enabled',
      cut: 7,
      sealed: 1,
      folded: 2,
      baselined: {},
      snapshot,
      deltaSegmentSeq: null,
      replicaSeqFloor: null,
    });
    await runSyncEnablePush({ 'api-url': API, scope: 'global' });
    expect(opts(enableSyncPush)).toEqual({ apiUrl: API, scope: 'global' });
    expect(written()).toContain('cp-1');
  });

  it('cloud sync passes the API URL, and a scope only when one is given (T12996)', async () => {
    cloudSync.mockReset().mockResolvedValue({
      apiUrl: API,
      streams: [
        {
          scope: 'project',
          streamId: 'project:p',
          status: 'synced',
          refused: null,
          sealed: 1,
          built: 1,
          sent: 1,
          duplicates: 0,
          received: 2,
          staged: 2,
          redelivered: 0,
          applied: 2,
          held: 0,
          conflicts: 0,
          after: 7,
          head: 7,
        },
      ],
      warnings: [],
    });
    await runCloudSync({ 'api-url': API });
    expect(opts(cloudSync)).toEqual({ apiUrl: API });
    await runCloudSync({ scope: 'global' });
    expect(cloudSync.mock.calls[1]?.[0]).toEqual({ apiUrl: undefined, scope: 'global' });
    expect(written()).toContain('project:p');
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
    expect(resolveNexusProjectRef).toHaveBeenCalledWith('p-remote', { apiUrl: undefined });
  });

  it('pull ignores --checkpoint, --project and --into', async () => {
    await runCloudPull({ scope: 'global', checkpoint: 'cp-0', project: 'p', into: '/tmp/x' });
    const o = opts(restoreNexusVault);
    expect(o).toMatchObject({ scope: 'global', mode: 'pull', force: false });
    expect(o).not.toHaveProperty('checkpointId');
    expect(o).not.toHaveProperty('projectId');
    expect(o).not.toHaveProperty('into');
    expect(resolveNexusProjectRef).not.toHaveBeenCalled();
  });

  it('verify, vault and lease release pass scope and the API URL', async () => {
    await runCloudVerify({ 'api-url': API, scope: 'global' });
    await runCloudVault({ scope: 'global' });
    await runCloudLease({ action: 'release', scope: 'global' });
    await runCloudLease({});
    expect(opts(verifyNexusVault)).toEqual({ apiUrl: API, scope: 'global', deep: false });
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

describe('cleo cloud verify --deep (T13291)', () => {
  it('passes deep only for --deep', async () => {
    await runCloudVerify({ deep: true });
    await runCloudVerify({ deep: 'yes' });
    expect(opts(verifyNexusVault)).toEqual({ apiUrl: undefined, scope: 'project', deep: true });
    expect(verifyNexusVault.mock.calls[1]?.[0]).toEqual({
      apiUrl: undefined,
      scope: 'project',
      deep: false,
    });
  });

  it('the verify line carries the deep part and points at cleo backup verify', () => {
    const r = {
      ...base,
      scope: 'project' as const,
      verdict: 'untrusted' as const,
      remedy: null,
      localIntegrity: true,
      head: null,
      lastSynced: null,
      tables: [],
      devices: [],
      deep: {
        snapshots: [],
        segments: { from: 0, checked: 3, ok: true, problem: null },
      },
    };
    expect(cloudVerifySummary(r)).toBe(
      'Verify project: untrusted; local integrity ok; deep: 0/0 snapshot bundle(s) verified, 3 segment(s) after seq 0 verified. Local backups: `cleo backup verify`.',
    );
    const { deep: _deep, ...plain } = r;
    expect(cloudVerifySummary(plain)).toBe(
      'Verify project: untrusted; local integrity ok. Local backups: `cleo backup verify`.',
    );
  });

  it('the deep clause counts what passed and names the first failure', () => {
    expect(deepVerifyClause(undefined)).toBe('');
    const ok = { checkpointId: 'cp-1', deviceId: 'd-1', sizeBytes: 10, ok: true, problem: null };
    expect(
      deepVerifyClause({
        snapshots: [ok],
        segments: { from: 4, checked: 2, ok: true, problem: null },
      }),
    ).toBe('; deep: 1/1 snapshot bundle(s) verified, 2 segment(s) after seq 4 verified');
    expect(
      deepVerifyClause({
        snapshots: [
          ok,
          { ...ok, checkpointId: 'cp-2', ok: false, problem: 'bundle does not match its hash' },
        ],
        segments: { from: 0, checked: 1, ok: false, problem: 'segment 2 does not decrypt' },
      }),
    ).toBe(
      '; deep: 1/2 snapshot bundle(s) verified (cp-2 FAILED: bundle does not match its hash), 1 segment(s) after seq 0 verified, then FAILED: segment 2 does not decrypt',
    );
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

  it.each([
    'abc',
    '0',
    '201',
    '2.5',
    '-1',
  ])('activity --limit %s fails with E_VALIDATION (exit 6) before any call (T13007)', async (limit) => {
    await expect(runCloudActivity({ limit })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(6);
    expect(written()).toContain('E_VALIDATION');
    expect(nexusCloudActivity).not.toHaveBeenCalled();
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
    ['E_NEXUS_VAULT_TARGET_OCCUPIED', 22],
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

describe('cloudRestoreSummary (T13109)', () => {
  it('names the retired and the new replica after a placement', () => {
    const line = cloudRestoreSummary({
      ...restoreResult,
      status: 'restored',
      replica: { retired: 'r-old', current: 'r-new', reason: 'vault-restore' },
    });
    expect(line).toBe(
      'Restored project snapshot cp-1 into /x: 2 table(s) verified by count and hash; replica r-old retired → r-new.',
    );
    const copied = cloudRestoreSummary({
      ...restoreResult,
      status: 'restored',
      replica: { retired: 'r-old', current: 'r-new', reason: 'file-identity' },
    });
    expect(copied).toContain(
      '; this copy now has its own replica r-new (file-identity: it carried r-old from a copied file).',
    );
    expect(copied).not.toContain('retired');
    const foreign = cloudRestoreSummary({
      ...restoreResult,
      status: 'restored',
      replica: { retired: 'r-old', current: 'r-new', reason: 'foreign-device' },
    });
    expect(foreign).toContain('(foreign-device: it carried r-old from another device)');
  });

  it('says nothing about replicas when the store had none', () => {
    expect(cloudRestoreSummary({ ...restoreResult, status: 'restored' })).not.toContain('replica');
  });
});

describe('cleo cloud restore <name> (T13102)', () => {
  it('resolves the positional name to the project id and restores that id', async () => {
    resolveNexusProjectRef.mockResolvedValueOnce({
      projectId: 'p-resolved',
      name: 'Demo Board',
      matchedBy: 'name',
    });
    await runCloudRestore({ name: 'demo board', 'api-url': API });
    expect(resolveNexusProjectRef).toHaveBeenCalledWith('demo board', { apiUrl: API });
    expect(opts(restoreNexusVault)).toMatchObject({ mode: 'restore', projectId: 'p-resolved' });
    expect(written()).toContain('Restoring "Demo Board" (project p-resolved)');
  });

  it('the same name as positional and --project is accepted once', async () => {
    await runCloudRestore({ name: 'demo', project: 'demo' });
    expect(resolveNexusProjectRef).toHaveBeenCalledTimes(1);
    expect(opts(restoreNexusVault)).toMatchObject({ projectId: 'demo' });
  });

  it('different values as positional and --project fail with E_VALIDATION before any call', async () => {
    await expect(runCloudRestore({ name: 'a', project: 'b' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(6);
    expect(written()).toContain('E_VALIDATION');
    expect(resolveNexusProjectRef).not.toHaveBeenCalled();
    expect(restoreNexusVault).not.toHaveBeenCalled();
  });

  it('a project name with --scope global fails with E_VALIDATION', async () => {
    await expect(runCloudRestore({ name: 'demo', scope: 'global' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(6);
    expect(resolveNexusProjectRef).not.toHaveBeenCalled();
    expect(restoreNexusVault).not.toHaveBeenCalled();
  });

  it('an ambiguous name exits 6 with the candidates in error.details, restoring nothing', async () => {
    const candidates = [
      { projectId: 'p-1', name: 'demo', restoreCommand: 'cleo cloud restore p-1' },
      { projectId: 'p-2', name: 'Demo', restoreCommand: 'cleo cloud restore p-2' },
    ];
    resolveNexusProjectRef.mockRejectedValueOnce(
      Object.assign(new Error('"DEMO" matches 2 projects'), {
        code: 'E_NEXUS_PROJECT_AMBIGUOUS',
        fix: 'restore one by its id: cleo cloud restore p-1 | cleo cloud restore p-2',
        publicDetails: { ref: 'DEMO', candidates },
      }),
    );
    await expect(runCloudRestore({ name: 'DEMO' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(6);
    const out = written();
    expect(out).toContain('E_NEXUS_PROJECT_AMBIGUOUS');
    expect(out).toContain('cleo cloud restore p-2');
    // The candidates travel as error.details, not only in the message.
    expect(out).toContain('"candidates"');
    expect(restoreNexusVault).not.toHaveBeenCalled();
  });

  it('without --into the current directory is checked for an enclosing project; with --into it is not', async () => {
    await runCloudRestore({ name: 'demo' });
    expect(assertNexusRestoreTarget).toHaveBeenCalledTimes(1);
    expect(assertNexusRestoreTarget).toHaveBeenCalledWith();
    await runCloudRestore({ name: 'demo', into: '/tmp/x' });
    expect(assertNexusRestoreTarget).toHaveBeenCalledTimes(1);
  });

  it('a nested target exits 22 (E_NEXUS_VAULT_TARGET_OCCUPIED) before resolving or restoring', async () => {
    assertNexusRestoreTarget.mockImplementationOnce(() => {
      throw Object.assign(new Error('inside the CLEO project at /p'), {
        code: 'E_NEXUS_VAULT_TARGET_OCCUPIED',
        fix: 'pass --into /p',
      });
    });
    await expect(runCloudRestore({ name: 'demo' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(22);
    expect(resolveNexusProjectRef).not.toHaveBeenCalled();
    expect(restoreNexusVault).not.toHaveBeenCalled();
  });

  it('an unknown name exits 4 (E_NEXUS_PROJECT_NOT_FOUND)', async () => {
    resolveNexusProjectRef.mockRejectedValueOnce(
      Object.assign(new Error('no project is named "nope"'), {
        code: 'E_NEXUS_PROJECT_NOT_FOUND',
        fix: 'run `cleo cloud projects`',
      }),
    );
    await expect(runCloudRestore({ name: 'nope' })).rejects.toThrow(/^exit:/);
    expect(exits[0]).toBe(4);
    expect(written()).toContain('E_NEXUS_PROJECT_NOT_FOUND');
    expect(restoreNexusVault).not.toHaveBeenCalled();
  });
});
