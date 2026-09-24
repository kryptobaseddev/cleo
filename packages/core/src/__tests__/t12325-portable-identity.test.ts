/**
 * Write-once portable project identity (T12325 · ADR-094).
 *
 * Proves the four acceptance criteria against real git and a real registry:
 * a fresh clone resolves the original id; a moved project keeps its id and
 * its ONE registry row is re-pointed; a missing id file is re-linked (from
 * project-info, the registry path, or a live checkout of the same remote),
 * never silently re-minted; and the tracked file is never rewritten.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatPortableProjectId,
  readPortableProjectId,
  resolveProjectByCwd,
} from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProjectOnEncounter } from '../paths.js';
import { ensureGitignore, ensureProjectInfo } from '../scaffold/ensure-config.js';
import {
  decideProjectIdentity,
  ensurePortableProjectId,
  normalizeRemoteUrl,
} from '../scaffold/project-identity.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
}

function readInfoId(root: string): string {
  const info = JSON.parse(readFileSync(join(root, '.cleo', 'project-info.json'), 'utf-8')) as {
    projectId: string;
  };
  return info.projectId;
}

async function registryRows(home: string): Promise<{ projectId: string; projectPath: string }[]> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectRegistry } = await import('../store/schema/nexus-schema.js');
  const db = await getNexusRegistryDb(home);
  return db
    .select({ projectId: projectRegistry.projectId, projectPath: projectRegistry.projectPath })
    .from(projectRegistry)
    .all();
}

let sandbox: string;

/** A fresh, empty CLEO home — one per simulated device. */
function newHome(name: string): string {
  const home = join(sandbox, `home-${name}`);
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  return home;
}

/** A git repo with an (initially untracked-state) `.cleo/` dir. */
function newRepo(name: string, remote?: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  return root;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-t12325-'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('AC2: a fresh clone resolves the same projectId', () => {
  it('commits .cleo/project-id, not project-info.json, and the clone adopts it', async () => {
    newHome('device-a');
    const origin = newRepo('origin');
    await ensureGitignore(origin);
    const created = await ensureProjectInfo(origin);
    const originalId = readInfoId(origin);
    expect(created.details).toContain('(minted)');
    expect(readPortableProjectId(origin)).toEqual({ status: 'valid', projectId: originalId });

    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'init');
    const tracked = git(origin, 'ls-files', '.cleo').split('\n');
    expect(tracked).toContain('.cleo/project-id');
    expect(tracked).not.toContain('.cleo/project-info.json');

    // A different device: empty registry, so only the tracked file can supply the id.
    newHome('device-b');
    const clone = join(sandbox, 'clone');
    git(sandbox, 'clone', '-q', origin, clone);
    expect(existsSync(join(clone, '.cleo', 'project-info.json'))).toBe(false);

    const result = await ensureProjectInfo(clone);
    expect(result.details).toContain('(tracked)');
    expect(readInfoId(clone)).toBe(originalId);
    expect(resolveProjectByCwd(clone)?.legacyUUID).toBe(originalId);
    expect(git(clone, 'status', '--porcelain')).toBe('');
  });
});

describe('AC4: moving a project keeps its projectId and updates only the path', () => {
  it('re-points the single registry row in place', async () => {
    const home = newHome('device');
    const before = newRepo('before');
    await ensureProjectInfo(before);
    const id = readInfoId(before);
    await registerProjectOnEncounter(before, id);
    expect(await registryRows(home)).toEqual([{ projectId: id, projectPath: before }]);

    const after = join(sandbox, 'after');
    renameSync(before, after);
    const moved = resolveProjectByCwd(after);
    expect(moved?.legacyUUID).toBe(id);
    await registerProjectOnEncounter(after, moved?.legacyUUID ?? '');

    expect(await registryRows(home)).toEqual([{ projectId: id, projectPath: after }]);
    expect(readPortableProjectId(after)).toEqual({ status: 'valid', projectId: id });
  });
});

describe('AC3: a missing id file is re-linked, never silently re-minted', () => {
  it('adopts the existing project-info id into a missing tracked file', async () => {
    newHome('device');
    const root = newRepo('legacy');
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'c78d09c3a8ee', name: 'legacy' }),
    );
    const result = await ensureProjectInfo(root);
    expect(result.action).toBe('skipped');
    expect(result.details).toContain('.cleo/project-id written');
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: 'c78d09c3a8ee' });
  });

  it('re-links from the registry row at the same path when both files are gone', async () => {
    const home = newHome('device');
    const root = newRepo('lost');
    await ensureProjectInfo(root);
    const id = readInfoId(root);
    await registerProjectOnEncounter(root, id);
    rmSync(join(root, '.cleo', 'project-info.json'));
    rmSync(join(root, '.cleo', 'project-id'));

    const result = await ensureProjectInfo(root);
    expect(readInfoId(root)).toBe(id);
    expect(result.details).toContain('(registry-path)');
    expect(result.details).toContain('re-linked');
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: id });
    expect(await registryRows(home)).toHaveLength(1);
  });

  it('re-links from a live checkout of the same remote', async () => {
    newHome('device');
    const first = newRepo('first', 'git@github.com:acme/widget.git');
    await ensureProjectInfo(first);
    const id = readInfoId(first);
    await registerProjectOnEncounter(first, id);

    const second = newRepo('second', 'https://github.com/acme/widget');
    const decision = await decideProjectIdentity(second, undefined);
    expect(decision).toMatchObject({ projectId: id, source: 'registry-remote' });
  });

  it('refuses to guess between several candidates, and mints only on explicit request', async () => {
    newHome('device');
    for (const name of ['one', 'two']) {
      const root = newRepo(name, 'https://github.com/acme/forked');
      await ensureProjectInfo(root, { mintNewIdentity: true });
      await registerProjectOnEncounter(root, readInfoId(root));
    }
    const third = newRepo('three', 'https://github.com/acme/forked.git');
    await expect(ensureProjectInfo(third)).rejects.toThrow(/2 registered identities/);
    expect(existsSync(join(third, '.cleo', 'project-info.json'))).toBe(false);
    expect(readPortableProjectId(third)).toEqual({ status: 'absent' });

    const minted = await ensureProjectInfo(third, { mintNewIdentity: true });
    expect(minted.details).toContain('minted a new identity on explicit request');
  });

  it('refuses to mint over a malformed tracked file, and leaves it untouched', async () => {
    newHome('device');
    const root = newRepo('corrupt');
    const path = join(root, '.cleo', 'project-id');
    writeFileSync(path, 'two\nlines\n');
    await expect(ensureProjectInfo(root)).rejects.toThrow(/refusing to mint/);
    expect(readFileSync(path, 'utf-8')).toBe('two\nlines\n');
  });
});

describe('write-once: the tracked file is never rewritten', () => {
  it('keeps the local id on conflict and reports it', async () => {
    newHome('device');
    const root = newRepo('conflict');
    writeFileSync(join(root, '.cleo', 'project-id'), formatPortableProjectId('tracked-y'));
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'local-x', name: 'conflict' }),
    );
    const result = await ensureProjectInfo(root);
    expect(readInfoId(root)).toBe('local-x');
    expect(result.details).toContain('.cleo/project-id conflict');
    expect(result.details).toContain('identity conflict');
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: 'tracked-y' });
  });

  it('ensurePortableProjectId writes once and then only compares', async () => {
    const root = join(sandbox, 'once');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    expect(await ensurePortableProjectId(root, 'first-id')).toBe('written');
    expect(await ensurePortableProjectId(root, 'first-id')).toBe('present');
    expect(await ensurePortableProjectId(root, 'other-id')).toBe('conflict');
    expect(readPortableProjectId(root)).toEqual({ status: 'valid', projectId: 'first-id' });
  });

  it('normalises equivalent remote spellings', () => {
    expect(normalizeRemoteUrl('git@github.com:Acme/Widget.git')).toBe('github.com/acme/widget');
    expect(normalizeRemoteUrl('https://user@github.com/acme/widget/')).toBe(
      'github.com/acme/widget',
    );
    expect(normalizeRemoteUrl('ssh://git@host:2222/acme/widget.git')).toBe('host:2222/acme/widget');
  });
});
