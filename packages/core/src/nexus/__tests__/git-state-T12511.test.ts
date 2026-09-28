/**
 * Git state probe (T12511): bounded concurrency with a per-location timeout,
 * per-row errors, and remote freshness from FETCH_HEAD.
 *
 * Real `git` against temp repositories; a fake hanging `git` for timeouts.
 * Every registry case runs against a temp `CLEO_HOME`.
 *
 * @task T12511
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDeviceIdCacheForTests } from '../../llm/stable-device-id.js';
import { getCleoHome } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { projectGitState, projectLocations } from '../../store/schema/nexus-schema.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  isRemoteStale,
  listGitStates,
  parsePorcelainV2Status,
  probeGitState,
  probeGitStates,
  runProjectsGitStatus,
} from '../git-state.js';

let testDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-git-state-T12511-')));
  saved['CLEO_HOME'] = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(testDir, 'cleo-home');
  mkdirSync(process.env['CLEO_HOME'], { recursive: true });
  _resetDeviceIdCacheForTests();
});

afterEach(async () => {
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  _resetDeviceIdCacheForTests();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A repo with one commit on `main`. */
function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

/** A bare remote plus a clone tracking origin/main. */
function makeClone(name: string): { remote: string; clone: string } {
  const seed = makeRepo(join(testDir, `${name}-seed`));
  const remote = join(testDir, `${name}.git`);
  git(testDir, 'clone', '-q', '--bare', seed, remote);
  const clone = join(testDir, name);
  git(testDir, 'clone', '-q', remote, clone);
  return { remote, clone };
}

/** A fake git that never exits and leaves a grandchild holding its pipes. */
function hangingGit(): { bin: string; pidFile: string } {
  const bin = join(testDir, 'hang-git.sh');
  const pidFile = join(testDir, 'grandchild.pid');
  writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const target = (path: string, projectId = 'p1') => ({ projectId, deviceId: 'dev-a', path });

describe('AC1 — bounded concurrency and a per-location timeout (T12511)', () => {
  it('a hung git is killed at the per-row deadline together with its process group', async () => {
    const repo = makeRepo(join(testDir, 'r'));
    const { bin, pidFile } = hangingGit();
    const started = Date.now();
    const row = await probeGitState(target(repo), { timeoutMs: 400, gitBin: bin });
    const elapsed = Date.now() - started;
    expect(row.probeErrorCode).toBe('E_GIT_TIMEOUT');
    expect(row.probeError).toMatch(/400ms/);
    expect(elapsed).toBeLessThan(2_000);
    // The grandchild (think: ssh, a credential helper) died with the group.
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it('N hung locations run in ceil(N / concurrency) waves, every one recorded', async () => {
    const repo = makeRepo(join(testDir, 'r'));
    const { bin } = hangingGit();
    const targets = Array.from({ length: 12 }, (_, i) => target(repo, `p${i}`));
    const started = Date.now();
    const rows = await probeGitStates(targets, { concurrency: 4, timeoutMs: 300, gitBin: bin });
    const elapsed = Date.now() - started;
    expect(rows.map((r) => r.projectId)).toEqual(targets.map((t) => t.projectId));
    expect(rows.every((r) => r.probeErrorCode === 'E_GIT_TIMEOUT')).toBe(true);
    // 3 waves of 300ms: never all at once (≈300ms), never serial (≈3600ms).
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(2_500);
  });
});

describe('AC2 — probe errors are recorded per row, never swallowed (T12511)', () => {
  it('missing path', async () => {
    const row = await probeGitState(target(join(testDir, 'gone')));
    expect(row.probeErrorCode).toBe('E_PATH_MISSING');
    expect(row.probeError).toContain('gone');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'unreadable directory (EACCES)',
    async () => {
      const dir = makeRepo(join(testDir, 'locked'));
      chmodSync(dir, 0o000);
      try {
        const row = await probeGitState(target(dir));
        expect(row.probeErrorCode).toBe('E_PATH_ACCESS');
        expect(row.probeError).toMatch(/EACCES|EPERM/);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it('a CLEO root that is not a git repo, with and without a declared evidence.gitRoot', async () => {
    const root = join(testDir, 'multi');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    const bare = await probeGitState(target(root));
    expect(bare.probeErrorCode).toBe('E_NOT_GIT_REPO');

    makeRepo(join(root, 'app'));
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { gitRoot: 'app' } }),
    );
    const declared = await probeGitState(target(root));
    expect(declared.probeErrorCode).toBeNull();
    expect(declared.gitRoot).toBe(join(root, 'app'));
    expect(declared.branch).toBe('main');
  });

  it('detached HEAD, no upstream, shallow clone, dirty and untracked counts', async () => {
    const repo = makeRepo(join(testDir, 'r'));
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    const local = await probeGitState(target(repo));
    expect(local).toMatchObject({
      probeErrorCode: null,
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
      remoteName: null,
      remoteStale: false,
      dirtyCount: 1,
      untrackedCount: 1,
    });
    expect(local.headSha).toMatch(/^[0-9a-f]{40}$/);

    git(repo, 'checkout', '-q', '--detach');
    const detached = await probeGitState(target(repo));
    expect(detached).toMatchObject({ probeErrorCode: null, detached: true, branch: null });

    const { remote } = makeClone('src');
    const shallow = join(testDir, 'shallow');
    git(testDir, 'clone', '-q', '--depth', '1', `file://${remote}`, shallow);
    const s = await probeGitState(target(shallow));
    expect(s).toMatchObject({ probeErrorCode: null, shallow: true, upstream: 'origin/main' });
  });

  it('records every row — errors included — against its location key', async () => {
    const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
    const db = await getNexusRegistryDb(getCleoHome());
    const ok = makeRepo(join(testDir, 'ok'));
    const missing = join(testDir, 'missing');
    for (const [projectId, path, state] of [
      ['p-ok', ok, 'live'],
      ['p-missing', missing, 'missing'],
      ['p-super', join(testDir, 'x'), 'superseded'],
    ] as const) {
      db.insert(projectLocations).values({ projectId, deviceId: 'dev-a', path, state }).run();
    }
    db.insert(projectGitState)
      .values({
        projectId: 'p-ok',
        deviceId: 'dev-b',
        path: '/elsewhere/ok',
        branch: 'main',
        remoteName: 'origin',
        remoteFetchedAt: '2020-01-01T00:00:00.000Z',
        probedAt: '2026-01-01T00:00:00.000Z',
      })
      .run();

    const res = await runProjectsGitStatus(db, { concurrency: 2 }, { deviceId: 'dev-a' });
    expect(res.rows.map((r) => [r.projectId, r.probeErrorCode])).toEqual([
      ['p-missing', 'E_PATH_MISSING'],
      ['p-ok', null],
    ]);
    expect(res.summary).toMatchObject({ ok: 1, errored: 1 });
    expect(res.otherDevices).toHaveLength(1);
    expect(res.otherDevices[0]).toMatchObject({ deviceId: 'dev-b', current: false });
    expect(res.otherDevices[0]?.remoteStale).toBe(true);

    const stored = listGitStates(db).filter((r) => r.deviceId === 'dev-a');
    expect(stored.map((r) => [r.projectId, r.probeErrorCode, r.path])).toEqual([
      ['p-missing', 'E_PATH_MISSING', missing],
      ['p-ok', null, ok],
    ]);
    expect(stored[0]?.probeError).toContain('does not exist');

    // A second run replaces, never duplicates.
    await runProjectsGitStatus(db, {}, { deviceId: 'dev-a' });
    expect(listGitStates(db)).toHaveLength(3);
  });
});

describe('AC3 — remote state records fetched_at and is stale when old (T12511)', () => {
  it('fetched_at is FETCH_HEAD mtime; stale past the window; unknown fetch is stale', async () => {
    const { clone } = makeClone('c');
    const now = new Date();
    const never = await probeGitState(target(clone), { now: () => now });
    // A fresh clone has tracking refs but never wrote FETCH_HEAD.
    expect(never.upstream).toBe('origin/main');
    expect(never.remoteFetchedAt).toBeNull();
    expect(never.remoteStale).toBe(true);

    git(clone, 'fetch', '-q');
    const fetchHead = join(clone, '.git', 'FETCH_HEAD');
    const old = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(fetchHead, old, old);
    const stale = await probeGitState(target(clone), { now: () => now });
    // Filesystems differ in mtime precision (APFS: ns, ext4: ns, some: 1s).
    expect(Math.abs(Date.parse(String(stale.remoteFetchedAt)) - old.getTime())).toBeLessThan(1_000);
    expect(stale.remoteStale).toBe(true);

    const fresh = await probeGitState(target(clone), {
      now: () => now,
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(fresh.remoteStale).toBe(false);
    expect(fresh.remoteHeadSha).toBe(git(clone, 'rev-parse', 'origin/main'));
  });

  it('behind comes from the last fetch; --fetch refreshes it and fetched_at', async () => {
    const { remote, clone } = makeClone('f');
    // Advance the remote from another clone.
    const other = join(testDir, 'other');
    git(testDir, 'clone', '-q', remote, other);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    git(other, 'add', 'b.txt');
    git(other, 'commit', '-q', '-m', 'two');
    git(other, 'push', '-q', 'origin', 'main');

    const before = await probeGitState(target(clone));
    expect(before.behind).toBe(0); // no network: the old fetch knows nothing
    expect(before.remoteFetchedAt).toBeNull();

    const after = await probeGitState(target(clone), { fetch: true });
    expect(after.probeErrorCode).toBeNull();
    expect(after.behind).toBe(1);
    expect(after.remoteFetchedAt).not.toBeNull();
    expect(after.remoteStale).toBe(false);
    expect(after.remoteUrl).toBe(remote);
  });

  it('a failed fetch is recorded and keeps the local state', async () => {
    const { remote, clone } = makeClone('ff');
    await rm(remote, { recursive: true, force: true });
    const row = await probeGitState(target(clone), { fetch: true, timeoutMs: 10_000 });
    expect(row.probeErrorCode).toBe('E_FETCH_FAILED');
    expect(row.branch).toBe('main');
    expect(row.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('isRemoteStale: no remote is never stale', () => {
    const now = new Date();
    expect(isRemoteStale({ remoteName: null, upstream: null, remoteFetchedAt: null }, now, 1)).toBe(
      false,
    );
    expect(
      isRemoteStale({ remoteName: 'origin', upstream: null, remoteFetchedAt: null }, now, 1),
    ).toBe(true);
  });
});

describe('parsePorcelainV2Status (T12511)', () => {
  it('counts renames once and skips their original path', () => {
    const raw = [
      '# branch.oid abc',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '2 R. N... 100644 100644 100644 a b R100 new.txt',
      'old.txt',
      '1 .M N... 100644 100644 100644 a b x.txt',
      '? u.txt',
      '',
    ].join('\0');
    expect(parsePorcelainV2Status(raw)).toMatchObject({
      headSha: 'abc',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      dirtyCount: 2,
      untrackedCount: 1,
    });
  });
});
