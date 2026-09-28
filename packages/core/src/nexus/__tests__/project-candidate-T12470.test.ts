/**
 * A checkout that merely DECLARES a registered project id is a `candidate`
 * location, never a live binding (T12470 · T12529).
 *
 * `.cleo/project-id` is committed to git, so any directory can declare any
 * project's id. The per-command encounter runs under every command, read-only
 * ones included, so it must never repoint an existing registry row — or hand
 * over that row's permissions — to a new path. Promotion to live happens only
 * through an explicit command, or a verified move (old path gone on this
 * device + matching git root commit or remote).
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12470
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectIdentity } from '../../doctor/project-identity.js';
import { getCleoHome, recordProjectEncounter } from '../../paths.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import { resetDbState } from '../../store/sqlite.js';
import { readCheckoutNonce } from '../checkout-nonce.js';
import { currentDeviceId } from '../path-map.js';
import { nexusRegister, nexusUpdateIndexStats } from '../registry.js';

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-candidate-T12470-')));
  vi.stubEnv('CLEO_HOME', join(testDir, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', undefined);
  mkdirSync(join(testDir, 'cleo-home'), { recursive: true });
  // No-argument registry calls need a caller project of their own.
  const caller = join(testDir, 'caller');
  mkdirSync(join(caller, '.cleo'), { recursive: true });
  mkdirSync(join(caller, '.git'), { recursive: true });
  vi.stubEnv('CLEO_ROOT', caller);
  originalCwd = process.cwd();
  process.chdir(caller);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../../store/nexus-sqlite.js');
  resetNexusDbState();
  vi.unstubAllEnvs();
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Run git quietly in `cwd`. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real git repository with one commit, a tracked id and project-info.json. */
function makeRepo(root: string, projectId: string, remote?: string): string {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  writeFileSync(join(root, '.cleo', 'project-id'), `${projectId}\n`);
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  // Content includes the root so two repos never share a root commit hash.
  writeFileSync(join(root, 'README'), `${projectId} ${root}`);
  git(root, 'add', 'README', '.cleo/project-id');
  git(root, 'commit', '-q', '-m', 'root');
  return root;
}

async function registry() {
  const { getNexusRegistryDb } = await import('../../store/nexus-sqlite.js');
  const schema = await import('../../store/schema/nexus-schema.js');
  return { db: await getNexusRegistryDb(getCleoHome()), ...schema };
}

async function registryRow(projectId: string) {
  const { db, projectRegistry } = await registry();
  return db.select().from(projectRegistry).where(eq(projectRegistry.projectId, projectId)).get();
}

async function locationState(projectId: string, path: string) {
  const { db, projectLocations } = await registry();
  return db
    .select({ state: projectLocations.state })
    .from(projectLocations)
    .where(
      and(
        eq(projectLocations.projectId, projectId),
        eq(projectLocations.deviceId, currentDeviceId()),
        eq(projectLocations.path, path),
      ),
    )
    .get()?.state;
}

describe('hostile clone declaring a registered id (T12470 · T12529)', () => {
  it('a read-only encounter leaves the victim row and permissions untouched and records a candidate', async () => {
    const victim = makeRepo(join(testDir, 'victim'), 'victim-id-T12470');
    await nexusRegister(victim, 'victim', 'write');
    const before = await registryRow('victim-id-T12470');
    expect(before).toMatchObject({ projectPath: victim, permissions: 'write' });

    // Only `git init` plus a copied tracked id — no project-info.json.
    const hostile = join(testDir, 'hostile');
    mkdirSync(join(hostile, '.cleo'), { recursive: true });
    git(hostile, 'init', '-q');
    copyFileSync(join(victim, '.cleo', 'project-id'), join(hostile, '.cleo', 'project-id'));

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await recordProjectEncounter(hostile)).toBe('recorded');
      await recordProjectEncounter(hostile); // repeated commands stay candidates
    } finally {
      stderr.mockRestore();
    }

    const after = await registryRow('victim-id-T12470');
    expect(after?.projectPath).toBe(victim);
    expect(after?.permissions).toBe('write');
    expect(after?.brainDbPath).toBe(before?.brainDbPath);
    expect(await locationState('victim-id-T12470', victim)).toBe('live');
    expect(await locationState('victim-id-T12470', hostile)).toBe('candidate');
    const { db, projectRegistry } = await registry();
    expect(db.select().from(projectRegistry).all()).toHaveLength(1);
  });

  it('a move without the nonce stays a candidate (unrelated repo)', async () => {
    const original = makeRepo(join(testDir, 'orig'), 'unverified-T12470');
    await nexusRegister(original, 'orig');
    await rm(original, { recursive: true, force: true });
    const other = makeRepo(join(testDir, 'other'), 'unverified-T12470');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await recordProjectEncounter(other);
    expect((await registryRow('unverified-T12470'))?.projectPath).toBe(original);
    expect(await locationState('unverified-T12470', other)).toBe('candidate');
  });
});

describe('forged move evidence never takes the row (T12470 H2)', () => {
  /** Register a victim with a remote, then delete it: the row's path is gone. */
  async function goneVictim(id: string): Promise<{ victim: string; mirror: string }> {
    const victim = makeRepo(join(testDir, `victim-${id}`), id, `https://example.invalid/${id}.git`);
    await nexusRegister(victim, `victim-${id}`, 'write');
    // Keep the victim's objects reachable for clone / fetch after it is gone.
    const mirror = join(testDir, `mirror-${id}`);
    git(testDir, 'clone', '-q', '--mirror', victim, mirror);
    await rm(victim, { recursive: true, force: true });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { victim, mirror };
  }

  async function expectUntouched(id: string, victim: string, attacker: string) {
    const row = await registryRow(id);
    expect(row?.projectPath).toBe(victim);
    expect(row?.permissions).toBe('write');
    expect(await locationState(id, attacker)).toBe('candidate');
  }

  it('a clone of the same repository (same root commit and remote)', async () => {
    const { victim, mirror } = await goneVictim('clone-T12470');
    const clone = join(testDir, 'clone');
    git(testDir, 'clone', '-q', mirror, clone);
    git(clone, 'remote', 'set-url', 'origin', 'https://example.invalid/clone-T12470.git');
    await recordProjectEncounter(clone);
    await expectUntouched('clone-T12470', victim, clone);
  });

  it('`git init` + the victim remote, no commits', async () => {
    const { victim } = await goneVictim('remote-T12470');
    const fake = join(testDir, 'fake-remote');
    mkdirSync(join(fake, '.cleo'), { recursive: true });
    git(fake, 'init', '-q');
    git(fake, 'remote', 'add', 'origin', 'https://example.invalid/remote-T12470.git');
    writeFileSync(join(fake, '.cleo', 'project-id'), 'remote-T12470\n');
    await recordProjectEncounter(fake);
    await expectUntouched('remote-T12470', victim, fake);
  });

  it('a root commit faked through refs/replace', async () => {
    const { victim, mirror } = await goneVictim('replace-T12470');
    const fake = makeRepo(join(testDir, 'fake-replace'), 'replace-T12470');
    rmSync(join(fake, '.cleo', 'project-info.json'));
    git(fake, 'fetch', '-q', mirror, 'HEAD');
    const victimRoot = execFileSync('git', ['rev-list', '--max-parents=0', 'FETCH_HEAD'], {
      cwd: fake,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')[0] as string;
    const ownRoot = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fake,
      encoding: 'utf-8',
    }).trim();
    git(fake, 'replace', '--graft', ownRoot, victimRoot);
    // Plain git now reports the victim's root; the evidence collector must not.
    const plain = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: fake,
      encoding: 'utf-8',
    }).trim();
    expect(plain).toBe(victimRoot);
    const { collectCheckoutEvidence } = await import('../identity.js');
    expect((await collectCheckoutEvidence(fake)).gitRootCommit).toBe(ownRoot);

    await recordProjectEncounter(fake);
    await expectUntouched('replace-T12470', victim, fake);
  });
});

describe('proven moves are promoted automatically (T12470 H2)', () => {
  it('`mv` carries the untracked nonce and takes the row', async () => {
    const original = makeRepo(join(testDir, 'before'), 'moved-T12470');
    await nexusRegister(original, 'moved', 'write');
    const nonce = readCheckoutNonce(original);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const moved = join(testDir, 'elsewhere', 'after');
    mkdirSync(join(testDir, 'elsewhere'), { recursive: true });
    renameSync(original, moved);

    expect(await recordProjectEncounter(moved)).toBe('recorded');
    const row = await registryRow('moved-T12470');
    expect(row).toMatchObject({ projectPath: moved, permissions: 'write' });
    expect(await locationState('moved-T12470', moved)).toBe('live');
    expect(await locationState('moved-T12470', original)).toBe('missing');
  });

  it('a fresh checkout with `.cleo/` restored from a backup takes the row', async () => {
    const original = makeRepo(join(testDir, 'lost'), 'restored-T12470');
    await nexusRegister(original, 'restored', 'write');
    const backup = join(testDir, 'backup-cleo');
    cpSync(join(original, '.cleo'), backup, { recursive: true });
    const restored = join(testDir, 'restored');
    git(testDir, 'clone', '-q', original, restored);
    await rm(original, { recursive: true, force: true });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Before the restore the fresh clone is only a candidate.
    await recordProjectEncounter(restored);
    expect(await locationState('restored-T12470', restored)).toBe('candidate');
    cpSync(backup, join(restored, '.cleo'), { recursive: true });

    await recordProjectEncounter(restored);
    expect(await registryRow('restored-T12470')).toMatchObject({
      projectPath: restored,
      permissions: 'write',
    });
    expect(await locationState('restored-T12470', restored)).toBe('live');
  });
});

describe('maintenance and explicit reconcile never move a live row (T12470 M1)', () => {
  it('`cleo upgrade` registration leaves the row at the still-existing victim', async () => {
    const victim = makeRepo(join(testDir, 'alive'), 'upgrade-T12470');
    await nexusRegister(victim, 'alive', 'write');
    const clone = join(testDir, 'upgrade-clone');
    git(testDir, 'clone', '-q', victim, clone);
    // Even a copied nonce proves nothing while the victim path still exists.
    cpSync(join(victim, '.cleo', 'project-info.json'), join(clone, '.cleo', 'project-info.json'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { initNexusRegistration } = await import('../../init.js');
    const warnings: string[] = [];
    await initNexusRegistration(clone, [], warnings, { maintenance: true });
    expect(await registryRow('upgrade-T12470')).toMatchObject({
      projectPath: victim,
      permissions: 'write',
    });
    expect(await locationState('upgrade-T12470', clone)).toBe('candidate');
  });

  it('`nexus reconcile` / `init` refuse to repoint without --force-rebind', async () => {
    const victim = makeRepo(join(testDir, 'alive2'), 'rebind-T12470');
    await nexusRegister(victim, 'alive2', 'write');
    const clone = join(testDir, 'rebind-clone');
    git(testDir, 'clone', '-q', victim, clone);
    writeFileSync(
      join(clone, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'rebind-T12470' }),
    );
    const { nexusReconcile } = await import('../registry.js');
    expect(await nexusReconcile(clone)).toMatchObject({ status: 'candidate', oldPath: victim });
    expect((await registryRow('rebind-T12470'))?.projectPath).toBe(victim);

    const { initNexusRegistration } = await import('../../init.js');
    const warnings: string[] = [];
    await initNexusRegistration(clone, [], warnings);
    expect(warnings.join('\n')).toMatch(/--force-rebind/);
    expect((await registryRow('rebind-T12470'))?.projectPath).toBe(victim);

    expect(await nexusReconcile(clone, { forceRebind: true })).toMatchObject({
      status: 'path_updated',
    });
    expect(await registryRow('rebind-T12470')).toMatchObject({
      projectPath: clone,
      permissions: 'write',
    });
  });

  it('`cleo doctor project-identity --resolve` explicitly confirms a candidate', async () => {
    const first = makeRepo(join(testDir, 'first'), 'confirm-T12470');
    await nexusRegister(first, 'first', 'write');
    const second = join(testDir, 'second');
    git(testDir, 'clone', '-q', first, second);
    writeFileSync(
      join(second, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'confirm-T12470' }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await recordProjectEncounter(second);
    expect(await locationState('confirm-T12470', second)).toBe('candidate');

    const plan = await resolveProjectIdentity(second, { dryRun: true });
    expect(plan.steps.map((s) => s.action)).toEqual(['confirm-candidate-location']);
    expect((await registryRow('confirm-T12470'))?.projectPath).toBe(first);

    await resolveProjectIdentity(second);
    expect(await registryRow('confirm-T12470')).toMatchObject({
      projectPath: second,
      permissions: 'write',
    });
    expect(await locationState('confirm-T12470', second)).toBe('live');
    // Both checkouts are now confirmed: later encounters refresh, never flip.
    await recordProjectEncounter(first);
    expect((await registryRow('confirm-T12470'))?.projectPath).toBe(second);
  });
});

describe('implicit callers never mint an identity (T12470)', () => {
  it('nexus analyze stats never write .cleo/project-id', async () => {
    const bare = join(testDir, 'bare');
    mkdirSync(join(bare, '.cleo'), { recursive: true });
    git(bare, 'init', '-q');
    // Run as analyze does: from inside the project being indexed.
    vi.stubEnv('CLEO_ROOT', bare);
    const cwd = process.cwd();
    process.chdir(bare);
    const recorded = vi.spyOn(await import('../../paths.js'), 'recordProjectEncounter');
    try {
      await nexusUpdateIndexStats(bare, {
        nodeCount: 1,
        relationCount: 0,
        fileCount: 1,
      } as Parameters<typeof nexusUpdateIndexStats>[1]);
    } finally {
      process.chdir(cwd);
    }
    // The implicit path was actually exercised, and it minted nothing.
    expect(recorded).toHaveBeenCalled();
    expect(existsSync(join(bare, '.cleo', 'project-id'))).toBe(false);
    const { db, projectRegistry } = await registry();
    expect(db.select().from(projectRegistry).all()).toHaveLength(0);
  });

  it('the startup health check never writes .cleo/project-id', async () => {
    const bare = join(testDir, 'bare-health');
    mkdirSync(join(bare, '.cleo'), { recursive: true });
    git(bare, 'init', '-q');
    const { startupHealthCheck } = await import('../../system/health.js');
    await startupHealthCheck(bare);
    expect(existsSync(join(bare, '.cleo', 'project-id'))).toBe(false);
  });
});
