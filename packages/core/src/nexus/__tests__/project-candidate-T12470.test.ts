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
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
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
import { currentDeviceId } from '../path-map.js';
import { nexusRegister, nexusUpdateIndexStats } from '../registry.js';

let testDir: string;

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-candidate-T12470-')));
  vi.stubEnv('CLEO_HOME', join(testDir, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', undefined);
  mkdirSync(join(testDir, 'cleo-home'), { recursive: true });
});

afterEach(async () => {
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

  it('a move without verifiable evidence stays a candidate', async () => {
    const original = makeRepo(join(testDir, 'orig'), 'unverified-T12470');
    await nexusRegister(original, 'orig');
    // Declares the id from an unrelated repository at a new path, and the
    // original is gone: no matching root commit or remote → still candidate.
    await rm(original, { recursive: true, force: true });
    const other = makeRepo(join(testDir, 'other'), 'unverified-T12470');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await recordProjectEncounter(other);
    expect((await registryRow('unverified-T12470'))?.projectPath).toBe(original);
    expect(await locationState('unverified-T12470', other)).toBe('candidate');
  });

  it('a verified move (old path gone, same root commit) is promoted', async () => {
    const original = makeRepo(join(testDir, 'before'), 'moved-T12470');
    await nexusRegister(original, 'moved', 'write');
    const moved = join(testDir, 'elsewhere', 'after');
    mkdirSync(join(testDir, 'elsewhere'), { recursive: true });
    renameSync(original, moved);

    expect(await recordProjectEncounter(moved)).toBe('recorded');
    const row = await registryRow('moved-T12470');
    expect(row).toMatchObject({ projectPath: moved, permissions: 'write' });
    expect(await locationState('moved-T12470', moved)).toBe('live');
    expect(await locationState('moved-T12470', original)).toBe('missing');
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
