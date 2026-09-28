/**
 * `cleo project move` / `cleo project reroot` — the relocation engine
 * (T12552 · T12555 · T12556 · T12558).
 *
 * - T12552: a dry run returns a plan and changes neither disk nor registry.
 * - T12555: only the ROOT-level `.git` / `node_modules` are skipped by a move;
 *   a nested repository survives.
 * - T12556: a copy never carries the source's checkout nonce, so moving the
 *   real project by hand can never hand the registry to the stale copy.
 * - T12558: move refuses child/ancestor targets before any IO; reroot renames
 *   `.cleo/` into a child and rebinds the registry, and its dry run is pure.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12552
 * @task T12555
 * @task T12556
 * @task T12558
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCheckoutNonce } from '../nexus/checkout-nonce.js';
import { currentDeviceId } from '../nexus/path-map.js';
import { nexusRegister } from '../nexus/registry.js';
import { getCleoHome, recordProjectEncounter } from '../paths.js';
import { moveProject, rerootProject } from '../project-lifecycle.js';
import { awaitBackgroundOps } from '../store/background-ops.js';
import { resetDbState } from '../store/sqlite.js';

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-relocate-T12552-')));
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
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await awaitBackgroundOps();
  resetDbState();
  const { resetNexusDbState } = await import('../store/nexus-sqlite.js');
  resetNexusDbState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** Run git quietly in `cwd`. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** `git rev-parse --show-toplevel` in `cwd`. */
function gitTop(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** A committed git repository at `root`. */
function makeGitRepo(root: string, file = 'README'): void {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, file), root);
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', 'root');
}

/** A registered CLEO project (git repo + tracked id + project-info.json). */
async function makeProject(root: string, projectId: string): Promise<string> {
  makeGitRepo(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-id'), `${projectId}\n`);
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  await nexusRegister(root, projectId, 'write');
  return root;
}

async function registry() {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const schema = await import('../store/schema/nexus-schema.js');
  return { db: await getNexusRegistryDb(getCleoHome()), ...schema };
}

/** Every registry, location and legacy path-map row, for before/after equality. */
async function registrySnapshot(): Promise<string> {
  const { db, projectRegistry, projectLocations, projectPaths } = await registry();
  return JSON.stringify({
    registry: db.select().from(projectRegistry).all(),
    locations: db.select().from(projectLocations).all(),
    paths: db.select().from(projectPaths).all(),
  });
}

async function registryPath(projectId: string): Promise<string | undefined> {
  const { db, projectRegistry } = await registry();
  return db.select().from(projectRegistry).where(eq(projectRegistry.projectId, projectId)).get()
    ?.projectPath;
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

/** Recursive `path → size:mtime` listing — any write shows up as a difference. */
function treeSnapshot(root: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      out.push(`${full}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.join('\n');
}

describe('T12552 — move --dry-run is a pure plan', () => {
  it('returns source, target and registry action, and leaves the target absent and every registry and location row unchanged', async () => {
    const source = await makeProject(join(testDir, 'src'), 'dry-T12552');
    await recordProjectEncounter(source);
    const target = join(testDir, 'dest');
    const rowsBefore = await registrySnapshot();
    const treeBefore = treeSnapshot(source);

    const result = await moveProject(target, source, { dryRun: true });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      dryRun: true,
      kind: 'move',
      projectId: 'dry-T12552',
      source,
      target,
      transfer: 'copy',
      excluded: ['.git'],
      registry: {
        action: 'rebind',
        livePath: target,
        demotedPath: source,
        demotedState: 'candidate',
        nonce: 'fresh',
      },
    });
    expect(result.data.entries).toEqual(expect.arrayContaining(['.cleo', 'README']));
    expect(existsSync(target)).toBe(false);
    expect(await registrySnapshot()).toBe(rowsBefore);
    expect(treeSnapshot(source)).toBe(treeBefore);
  });
});

describe('T12555 — the copy filter applies at the project root only', () => {
  it('a nested child git repository survives the move and `git rev-parse` works in it', async () => {
    const source = await makeProject(join(testDir, 'mono'), 'nested-T12555');
    makeGitRepo(join(source, 'child'), 'CHILD');
    // A workspace package's own node_modules is part of the tree.
    mkdirSync(join(source, 'pkg', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(source, 'pkg', 'node_modules', 'dep', 'index.js'), 'x');
    // The root-level node_modules is the only one skipped.
    mkdirSync(join(source, 'node_modules', 'big'), { recursive: true });
    const target = join(testDir, 'moved');

    const result = await moveProject(target, source);

    expect(result.success).toBe(true);
    expect(gitTop(join(target, 'child'))).toBe(realpathSync(join(target, 'child')));
    expect(existsSync(join(target, 'child', 'CHILD'))).toBe(true);
    expect(existsSync(join(target, 'pkg', 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(target, 'node_modules'))).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(false);
    if (result.success) expect(result.data.excluded).toEqual(['.git', 'node_modules']);
  });
});

describe('T12556 — a CLEO-made copy never carries the source nonce', () => {
  it('stamps the copy with a fresh nonce and rebinds the registry to it', async () => {
    const source = await makeProject(join(testDir, 'orig'), 'nonce-T12556');
    const sourceNonce = readCheckoutNonce(source);
    expect(sourceNonce).toMatch(/^[0-9a-f]{32}$/);
    const target = join(testDir, 'copy');

    const result = await moveProject(target, source);

    expect(result.success).toBe(true);
    const copyNonce = readCheckoutNonce(target);
    expect(copyNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(copyNonce).not.toBe(sourceNonce);
    expect(await registryPath('nonce-T12556')).toBe(target);
    expect(await locationState('nonce-T12556', target)).toBe('live');
    expect(await locationState('nonce-T12556', source)).toBe('candidate');
  });

  it('mv of the live project, then a command in the stale copy, leaves the real project live', async () => {
    const source = await makeProject(join(testDir, 'real'), 'race-T12556');
    await recordProjectEncounter(source);
    const copy = join(testDir, 'stale');
    expect((await moveProject(copy, source)).success).toBe(true);

    // Whichever location the registry now names is the real project.
    const live = await registryPath('race-T12556');
    expect(live === source || live === copy).toBe(true);
    const real = live as string;
    const stale = real === source ? copy : source;

    const movedReal = join(testDir, 'elsewhere', 'real-moved');
    mkdirSync(join(testDir, 'elsewhere'), { recursive: true });
    renameSync(real, movedReal);

    // Any command run in the stale copy is an encounter.
    await recordProjectEncounter(stale);
    expect(await registryPath('race-T12556')).not.toBe(stale);
    expect(await locationState('race-T12556', stale)).not.toBe('live');

    // The real project, wherever it went, is still the one that proves the move.
    await recordProjectEncounter(movedReal);
    expect(await registryPath('race-T12556')).toBe(movedReal);
    expect(await locationState('race-T12556', movedReal)).toBe('live');
  });
});

describe('T12558 — move refuses child and ancestor targets before any IO', () => {
  it('a child target is E_INVALID_TARGET with a fix pointing to reroot', async () => {
    const source = await makeProject(join(testDir, 'parent'), 'child-T12558');
    const target = join(source, 'app');
    const rowsBefore = await registrySnapshot();
    const treeBefore = treeSnapshot(source);

    const result = await moveProject(target, source);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_TARGET');
    expect(result.error.fix).toContain('cleo project reroot app');
    expect(existsSync(target)).toBe(false);
    expect(treeSnapshot(source)).toBe(treeBefore);
    expect(await registrySnapshot()).toBe(rowsBefore);
  });

  it('an ancestor target is E_INVALID_TARGET', async () => {
    const source = await makeProject(join(testDir, 'outer', 'inner'), 'ancestor-T12558');
    const treeBefore = treeSnapshot(join(testDir, 'outer'));

    const result = await moveProject(join(testDir, 'outer'), source);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_TARGET');
    expect(result.error.fix).toContain('cleo project reroot');
    expect(treeSnapshot(join(testDir, 'outer'))).toBe(treeBefore);
  });
});

describe('T12558 — cleo project reroot', () => {
  it('--dry-run returns the plan and touches no disk and no registry', async () => {
    const root = await makeProject(join(testDir, 'mono'), 'reroot-dry-T12558');
    await recordProjectEncounter(root);
    const child = join(root, 'app');
    mkdirSync(child);
    writeFileSync(join(root, '.worktreeinclude'), '.env\n');
    const rowsBefore = await registrySnapshot();
    const treeBefore = treeSnapshot(testDir);

    const result = await rerootProject(child, root, { dryRun: true });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      dryRun: true,
      kind: 'reroot',
      source: root,
      target: child,
      transfer: 'rename',
      entries: ['.cleo', '.worktreeinclude'],
      writes: ['.cleo/project-info.json'],
      registry: { livePath: child, demotedPath: root, demotedState: 'missing', nonce: 'carried' },
      blockers: [],
    });
    expect(treeSnapshot(testDir)).toBe(treeBefore);
    expect(await registrySnapshot()).toBe(rowsBefore);
  });

  it('renames .cleo into the child, keeps the same id and nonce, promotes the child and demotes the old root', async () => {
    const root = await makeProject(join(testDir, 'mono'), 'reroot-T12558');
    await recordProjectEncounter(root);
    const nonce = readCheckoutNonce(root);
    const child = join(root, 'app');
    makeGitRepo(child);
    writeFileSync(join(root, '.worktreeinclude'), '.env\n');
    writeFileSync(join(root, '.cleo', 'marker'), 'same-inode');
    // Run from the old root, as the CLI does: nothing may recreate .cleo/ there.
    vi.stubEnv('CLEO_ROOT', root);
    process.chdir(root);

    const result = await rerootProject(child, root);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      dryRun: false,
      projectId: 'reroot-T12558',
      oldRoot: root,
      newRoot: child,
      renamed: ['.cleo', '.worktreeinclude'],
      projectIdFile: 'present',
    });
    expect(existsSync(join(root, '.cleo'))).toBe(false);
    expect(existsSync(join(root, '.worktreeinclude'))).toBe(false);
    expect(readFileSync(join(child, '.cleo', 'marker'), 'utf-8')).toBe('same-inode');
    expect(readFileSync(join(child, '.worktreeinclude'), 'utf-8')).toBe('.env\n');
    expect(readFileSync(join(child, '.cleo', 'project-id'), 'utf-8').trim()).toBe('reroot-T12558');
    const info = JSON.parse(readFileSync(join(child, '.cleo', 'project-info.json'), 'utf-8'));
    expect(info.projectId).toBe('reroot-T12558');
    expect(info).not.toHaveProperty('projectRoot');
    expect(readCheckoutNonce(child)).toBe(nonce);
    // The checkpoint was taken before the rename, so it travelled with .cleo/.
    const backups = readdirSync(join(child, '.cleo', 'backups', 'sqlite'));
    expect(backups).toContain(`${result.data.checkpointId}.meta.json`);
    expect(await registryPath('reroot-T12558')).toBe(child);
    expect(await locationState('reroot-T12558', child)).toBe('live');
    expect(await locationState('reroot-T12558', root)).toBe('missing');
  });

  it('writes .cleo/project-id with the same id when it is absent', async () => {
    const root = await makeProject(join(testDir, 'noid'), 'reroot-noid-T12558');
    execFileSync('rm', [join(root, '.cleo', 'project-id')]);
    const child = join(root, 'app');
    mkdirSync(child);

    const result = await rerootProject(child, root);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.projectIdFile).toBe('written');
    expect(readFileSync(join(child, '.cleo', 'project-id'), 'utf-8')).toContain(
      'reroot-noid-T12558',
    );
  });

  it('refuses a target outside the project, and one that already holds .cleo', async () => {
    const root = await makeProject(join(testDir, 'r'), 'reroot-bad-T12558');
    const outside = join(testDir, 'outside');
    mkdirSync(outside);
    const out = await rerootProject(outside, root);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.error.code).toBe('E_INVALID_TARGET');

    const child = join(root, 'app');
    mkdirSync(join(child, '.cleo'), { recursive: true });
    const clash = await rerootProject(child, root);
    expect(clash.success).toBe(false);
    if (!clash.success) expect(clash.error.code).toBe('E_INVALID_TARGET');
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
  });

  it('refuses while a CLEO worktree exists for the project', async () => {
    const root = await makeProject(join(testDir, 'wt'), 'reroot-wt-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    const { computeProjectHash, resolveWorktreeRootForHash } = await import('@cleocode/paths');
    mkdirSync(join(resolveWorktreeRootForHash(computeProjectHash(root)), 'T1'), {
      recursive: true,
    });

    const plan = await rerootProject(child, root, { dryRun: true });
    expect(plan.success && plan.data.blockers.length).toBe(1);
    const result = await rerootProject(child, root);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_REROOT_BLOCKED');
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
  });
});
