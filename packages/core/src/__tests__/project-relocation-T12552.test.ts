/**
 * `cleo project move` / `cleo project reroot` — the relocation engine
 * (T12552 · T12555 · T12556 · T12558).
 *
 * Both relocations RENAME; nothing is copied.
 *
 * - T12552: a dry run returns a plan and changes neither disk nor registry.
 * - T12555: the whole tree moves — root `.git` and nested repositories alike.
 * - T12556: there is never a second copy, so no stale copy can be promoted;
 *   a concurrent WAL writer loses no rows.
 * - T12558: move refuses child/ancestor targets before any IO; reroot renames
 *   CLEO's entries into a child, leaves a tombstone, is resumable, and the old
 *   root refuses with E_PROJECT_MOVED instead of growing an empty store.
 *
 * Every case runs against a temp `CLEO_HOME`.
 *
 * @task T12552
 * @task T12555
 * @task T12556
 * @task T12558
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleoError } from '../errors.js';
import { readCheckoutNonce } from '../nexus/checkout-nonce.js';
import { generateProjectHash } from '../nexus/hash.js';
import { currentDeviceId } from '../nexus/path-map.js';
import { nexusRegister } from '../nexus/registry.js';
import { getCleoHome, recordProjectEncounter } from '../paths.js';
import { moveProject, rerootProject } from '../project-lifecycle.js';
import { getProjectRoot } from '../project-scope.js';
import { setProjectMovedRefusal } from '../project-tombstone.js';
import { awaitBackgroundOps } from '../store/background-ops.js';
import { getDb, resetDbState } from '../store/sqlite.js';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'github');

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-relocate-T12552-')));
  vi.stubEnv('CLEO_HOME', join(testDir, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
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

/**
 * A registered CLEO project: git repo with `.cleo/project-id` COMMITTED (as
 * ADR-094 requires), project-info.json, and its location recorded live.
 */
async function makeProject(root: string, projectId: string): Promise<string> {
  makeGitRepo(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-id'), `${projectId}\n`);
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId, projectHash: 'feedfacecafe' }),
  );
  git(root, 'add', '.cleo/project-id');
  git(root, 'commit', '-q', '-m', 'id');
  await nexusRegister(root, projectId, 'write');
  await recordProjectEncounter(root);
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

async function liveLocations(projectId: string): Promise<string[]> {
  const { db, projectLocations } = await registry();
  return db
    .select({ path: projectLocations.path })
    .from(projectLocations)
    .where(and(eq(projectLocations.projectId, projectId), eq(projectLocations.state, 'live')))
    .all()
    .map((r) => r.path);
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

/** Copy CLEO's GitHub init templates into `<root>/.github`. */
function installCleoGithubTemplates(root: string): void {
  mkdirSync(join(root, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  for (const f of readdirSync(join(TEMPLATES, 'ISSUE_TEMPLATE'))) {
    copyFileSync(join(TEMPLATES, 'ISSUE_TEMPLATE', f), join(root, '.github', 'ISSUE_TEMPLATE', f));
  }
}

describe('T12552 — move --dry-run is a pure plan', () => {
  it('returns source, target, blockers and registry action; target absent; registry and tree unchanged', async () => {
    const source = await makeProject(join(testDir, 'src'), 'dry-T12552');
    const target = join(testDir, 'dest');
    const rowsBefore = await registrySnapshot();
    const treeBefore = treeSnapshot(testDir);

    const result = await moveProject(target, source, { dryRun: true });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      dryRun: true,
      kind: 'move',
      projectId: 'dry-T12552',
      source,
      target,
      transfer: 'rename',
      entries: ['.'],
      writes: [],
      blockers: [],
      registry: {
        action: 'rebind',
        livePath: target,
        demotedPath: source,
        demotedState: 'missing',
        nonce: 'carried',
      },
    });
    expect(result.data.checkpoint).toContain(join('backups', 'dry-T12552'));
    expect(existsSync(target)).toBe(false);
    expect(treeSnapshot(testDir)).toBe(treeBefore);
    expect(await registrySnapshot()).toBe(rowsBefore);
  });
});

describe('T12555 · T12556 — move renames the whole root', () => {
  it('carries root .git, a nested repo, the nonce and project-info.json byte-identical; the old path is gone', async () => {
    const source = await makeProject(join(testDir, 'mono'), 'rename-T12556');
    makeGitRepo(join(source, 'child'), 'CHILD');
    mkdirSync(join(source, 'node_modules', 'dep'), { recursive: true });
    const nonce = readCheckoutNonce(source);
    const infoBefore = readFileSync(join(source, '.cleo', 'project-info.json'));
    const target = join(testDir, 'moved', 'mono');

    const result = await moveProject(target, source);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(existsSync(source)).toBe(false);
    expect(gitTop(target)).toBe(realpathSync(target));
    expect(gitTop(join(target, 'child'))).toBe(realpathSync(join(target, 'child')));
    expect(existsSync(join(target, 'node_modules', 'dep'))).toBe(true);
    expect(readCheckoutNonce(target)).toBe(nonce);
    expect(readFileSync(join(target, '.cleo', 'project-info.json')).equals(infoBefore)).toBe(true);
    expect(await registryPath('rename-T12556')).toBe(target);
    expect(await locationState('rename-T12556', target)).toBe('live');
    expect(await locationState('rename-T12556', source)).toBe('missing');
    expect(await liveLocations('rename-T12556')).toEqual([target]);
    // The checkpoint lives OUTSIDE the moved tree.
    expect(result.data.checkpointPath.startsWith(join(testDir, 'cleo-home', 'backups'))).toBe(true);
    expect(readdirSync(result.data.checkpointPath)).toContain(
      `${result.data.checkpointId}.meta.json`,
    );
  });

  it('after a move no writable .cleo remains at the old path, even after commands at the new one', async () => {
    const source = await makeProject(join(testDir, 'old'), 'nowrite-T12556');
    const target = join(testDir, 'new');
    vi.stubEnv('CLEO_ROOT', source);
    process.chdir(source);

    expect((await moveProject(target, source)).success).toBe(true);
    await recordProjectEncounter(target);
    await getDb(target);

    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(source, '.cleo'))).toBe(false);
  });

  it('a concurrent WAL writer during the move loses no rows and leaves an intact database', async () => {
    const source = await makeProject(join(testDir, 'busy'), 'wal-T12556');
    await getDb(source); // create the real store
    resetDbState();
    const dbFile = join(source, '.cleo', 'cleo.db');
    const setup = new DatabaseSync(dbFile);
    setup.exec('CREATE TABLE wal_probe (n INTEGER PRIMARY KEY)');
    setup.close();

    // A separate process commits one row at a time for ~1.5 s, then reports
    // how many commits succeeded.
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
         const ins = db.prepare('INSERT INTO wal_probe DEFAULT VALUES');
         let ok = 0; const end = Date.now() + 1500;
         process.stdout.write('ready\\n');
         while (Date.now() < end) { try { ins.run(); ok++; } catch (e) { process.stderr.write(String(e)); break; } }
         db.close(); process.stdout.write('count=' + ok + '\\n');`,
        dbFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = new Promise<void>((done) => writer.on('exit', () => done()));
    let out = '';
    writer.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    await vi.waitFor(() => expect(out).toContain('ready'), { timeout: 10_000 });

    const target = join(testDir, 'busy-moved');
    const result = await moveProject(target, source);
    await exited;

    const committed = Number(/count=(\d+)/.exec(out)?.[1] ?? '-1');
    expect(committed).toBeGreaterThan(0);
    if (!result.success) {
      // A refusal is acceptable: then nothing moved and the source is intact.
      expect(existsSync(dbFile)).toBe(true);
      return;
    }
    const moved = new DatabaseSync(join(target, '.cleo', 'cleo.db'), { readOnly: true });
    try {
      expect(moved.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(moved.prepare('SELECT count(*) AS n FROM wal_probe').get()).toEqual({ n: committed });
    } finally {
      moved.close();
    }
  }, 60_000);
});

describe('T12558 — move refuses bad targets before any IO', () => {
  it('a child directory target is E_INVALID_TARGET with a fix pointing to reroot', async () => {
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

  it('a FILE target inside the project does not suggest reroot', async () => {
    const source = await makeProject(join(testDir, 'filetarget'), 'file-T12558');
    const result = await moveProject(join(source, 'README'), source);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_TARGET');
    expect(result.error.fix).not.toContain('reroot');
  });

  it('an ancestor target is E_INVALID_TARGET', async () => {
    const source = await makeProject(join(testDir, 'outer', 'inner'), 'ancestor-T12558');
    const treeBefore = treeSnapshot(join(testDir, 'outer'));
    const result = await moveProject(join(testDir, 'outer'), source);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('E_INVALID_TARGET');
    expect(treeSnapshot(join(testDir, 'outer'))).toBe(treeBefore);
  });

  it('refuses while a CLEO worktree is bound, with a conflict exit class', async () => {
    const source = await makeProject(join(testDir, 'wtm'), 'move-wt-T12558');
    const { computeProjectHash, resolveWorktreeRootForHash } = await import('@cleocode/paths');
    mkdirSync(join(resolveWorktreeRootForHash(computeProjectHash(source)), 'T1'), {
      recursive: true,
    });
    const plan = await moveProject(join(testDir, 'x'), source, { dryRun: true });
    expect(plan.success && plan.data.blockers).toHaveLength(1);
    const result = await moveProject(join(testDir, 'x'), source);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_MOVE_BLOCKED');
    expect(result.error.exitCode).toBe(ExitCode.CONCURRENT_MODIFICATION);
    expect(existsSync(source)).toBe(true);
  });
});

describe('T12557 alignment — relocation never recomputes projectHash or writes projectRoot', () => {
  /** A stored hash that is NOT what the raw path would hash to. */
  const STORED_HASH = 'feedfacecafe';

  function info(root: string): { raw: Buffer; parsed: Record<string, unknown> } {
    const raw = readFileSync(join(root, '.cleo', 'project-info.json'));
    return { raw, parsed: JSON.parse(raw.toString()) as Record<string, unknown> };
  }

  it('move (rename) keeps project-info.json byte-identical: stored hash kept, no projectRoot', async () => {
    const source = await makeProject(join(testDir, 'hash-move'), 'hash-move-T12557');
    const target = join(testDir, 'hash-moved');
    const before = info(source);
    // Premise: the stored hash differs from both raw-path hashes, so any
    // recompute on either side of the move would be visible.
    expect(before.parsed.projectHash).toBe(STORED_HASH);
    expect(generateProjectHash(source)).not.toBe(STORED_HASH);
    expect(generateProjectHash(target)).not.toBe(STORED_HASH);
    expect(before.parsed).not.toHaveProperty('projectRoot');

    expect((await moveProject(target, source)).success).toBe(true);

    const after = info(target);
    expect(after.raw.equals(before.raw)).toBe(true);
    expect(after.parsed.projectHash).toBe(STORED_HASH);
    expect(after.parsed).not.toHaveProperty('projectRoot');
  });

  it('reroot keeps project-info.json byte-identical: stored hash kept, no projectRoot', async () => {
    const root = await makeProject(join(testDir, 'hash-reroot'), 'hash-reroot-T12557');
    const child = join(root, 'app');
    mkdirSync(child);
    const before = info(root);
    expect(before.parsed.projectHash).toBe(STORED_HASH);
    expect(generateProjectHash(child)).not.toBe(STORED_HASH);

    expect((await rerootProject(child, root)).success).toBe(true);

    const after = info(child);
    expect(after.raw.equals(before.raw)).toBe(true);
    expect(after.parsed.projectHash).toBe(STORED_HASH);
    expect(after.parsed).not.toHaveProperty('projectRoot');
  });
});

describe('T12558 — cleo project reroot', () => {
  it('--dry-run returns the plan and touches no disk and no registry', async () => {
    const root = await makeProject(join(testDir, 'mono'), 'reroot-dry-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    writeFileSync(join(root, '.worktreeinclude'), '.env\n');
    installCleoGithubTemplates(root);
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
      entries: ['.cleo', '.worktreeinclude', '.github'],
      excluded: [],
      writes: [join(root, '.cleo-moved.json')],
      registry: { livePath: child, demotedPath: root, demotedState: 'missing', nonce: 'carried' },
      blockers: [],
    });
    expect(treeSnapshot(testDir)).toBe(treeBefore);
    expect(await registrySnapshot()).toBe(rowsBefore);
  });

  it("leaves a repository's own .github behind", async () => {
    const root = await makeProject(join(testDir, 'ownci'), 'reroot-gh-T12558');
    installCleoGithubTemplates(root);
    mkdirSync(join(root, '.github', 'workflows'));
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    mkdirSync(join(root, 'app'));
    const result = await rerootProject(join(root, 'app'), root, { dryRun: true });
    expect(result.success && result.data.entries).toEqual(['.cleo']);
    expect(result.success && result.data.excluded.map((e) => e.entry)).toEqual(['.github']);
  });

  it('renames CLEO entries into the child, keeps id, nonce and project-info.json, leaves a tombstone and one live row', async () => {
    const root = await makeProject(join(testDir, 'mono'), 'reroot-T12558');
    const nonce = readCheckoutNonce(root);
    const child = join(root, 'app');
    makeGitRepo(child);
    writeFileSync(join(root, '.worktreeinclude'), '.env\n');
    installCleoGithubTemplates(root);
    writeFileSync(join(root, '.cleo', 'marker'), 'same-inode');
    const infoBefore = readFileSync(join(root, '.cleo', 'project-info.json'));
    // Run from the old root, as the CLI does: nothing may recreate .cleo/ there.
    vi.stubEnv('CLEO_ROOT', root);
    process.chdir(root);

    const result = await rerootProject(child, root);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      dryRun: false,
      resumed: false,
      projectId: 'reroot-T12558',
      oldRoot: root,
      newRoot: child,
      renamed: ['.cleo', '.worktreeinclude', '.github'],
      projectIdFile: 'present',
      tombstone: join(root, '.cleo-moved.json'),
    });
    expect(existsSync(join(root, '.cleo'))).toBe(false);
    expect(existsSync(join(root, '.github'))).toBe(false);
    expect(readFileSync(join(child, '.cleo', 'marker'), 'utf-8')).toBe('same-inode');
    expect(readFileSync(join(child, '.cleo', 'project-id'), 'utf-8').trim()).toBe('reroot-T12558');
    expect(readFileSync(join(child, '.cleo', 'project-info.json')).equals(infoBefore)).toBe(true);
    expect(readCheckoutNonce(child)).toBe(nonce);
    expect(JSON.parse(readFileSync(join(root, '.cleo-moved.json'), 'utf-8'))).toMatchObject({
      projectId: 'reroot-T12558',
      movedTo: child,
    });
    expect(result.data.checkpointPath.startsWith(join(testDir, 'cleo-home', 'backups'))).toBe(true);
    expect(readdirSync(result.data.checkpointPath)).toContain(
      `${result.data.checkpointId}.meta.json`,
    );
    expect(await registryPath('reroot-T12558')).toBe(child);
    expect(await locationState('reroot-T12558', root)).toBe('missing');
    expect(await liveLocations('reroot-T12558')).toEqual([child]);
  });

  it('writes .cleo/project-id with the same id when it is absent', async () => {
    const root = await makeProject(join(testDir, 'noid'), 'reroot-noid-T12558');
    rmSync(join(root, '.cleo', 'project-id'));
    mkdirSync(join(root, 'app'));
    const result = await rerootProject(join(root, 'app'), root);
    expect(result.success && result.data.projectIdFile).toBe('written');
    expect(readFileSync(join(root, 'app', '.cleo', 'project-id'), 'utf-8')).toContain(
      'reroot-noid-T12558',
    );
  });

  it('refuses a target outside the project, one that already holds .cleo, and a bound worktree', async () => {
    const root = await makeProject(join(testDir, 'r'), 'reroot-bad-T12558');
    mkdirSync(join(testDir, 'outside'));
    const out = await rerootProject(join(testDir, 'outside'), root);
    expect(!out.success && out.error.code).toBe('E_INVALID_TARGET');

    mkdirSync(join(root, 'app', '.cleo'), { recursive: true });
    const clash = await rerootProject(join(root, 'app'), root);
    expect(!clash.success && clash.error.code).toBe('E_INVALID_TARGET');

    mkdirSync(join(root, 'b'));
    const { computeProjectHash, resolveWorktreeRootForHash } = await import('@cleocode/paths');
    mkdirSync(join(resolveWorktreeRootForHash(computeProjectHash(root)), 'T1'), {
      recursive: true,
    });
    const blocked = await rerootProject(join(root, 'b'), root);
    expect(!blocked.success && blocked.error.code).toBe('E_REROOT_BLOCKED');
    expect(!blocked.success && blocked.error.exitCode).toBe(ExitCode.CONCURRENT_MODIFICATION);
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
  });

  it('resumes after a crash between the rename and the rebind, leaving exactly one live row', async () => {
    const root = await makeProject(join(testDir, 'crash'), 'reroot-crash-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    // Simulated crash: the rename happened, nothing after it did.
    renameSync(join(root, '.cleo'), join(child, '.cleo'));
    expect(await registryPath('reroot-crash-T12558')).toBe(root);

    const plan = await rerootProject(child, child, { dryRun: true });
    expect(plan.success && plan.data.source).toBe(root);

    const result = await rerootProject(child, child);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ resumed: true, oldRoot: root, newRoot: child });
    expect(await registryPath('reroot-crash-T12558')).toBe(child);
    expect(await locationState('reroot-crash-T12558', root)).toBe('missing');
    expect(await liveLocations('reroot-crash-T12558')).toEqual([child]);
    expect(existsSync(join(root, '.cleo-moved.json'))).toBe(true);
  });

  it('the old root refuses with E_PROJECT_MOVED — also after `git checkout -- .` — and never grows an empty store', async () => {
    const root = await makeProject(join(testDir, 'tomb'), 'reroot-tomb-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    expect((await rerootProject(child, root)).success).toBe(true);
    vi.stubEnv('CLEO_ROOT', undefined);

    mkdirSync(join(root, 'docs'));
    expect(() => getProjectRoot(join(root, 'docs'))).toThrow(/E_PROJECT_MOVED/);
    expect(() => getProjectRoot(root)).toThrow(/E_PROJECT_MOVED/);

    // `git checkout -- .` restores the tracked .cleo/project-id in the parent.
    git(root, 'checkout', '--', '.');
    expect(existsSync(join(root, '.cleo', 'project-id'))).toBe(true);
    expect(() => getProjectRoot(root)).toThrow(/E_PROJECT_MOVED/);

    // Even without the tombstone, the registry marks this location missing.
    rmSync(join(root, '.cleo-moved.json'));
    await expect(getDb(root)).rejects.toThrow(/E_PROJECT_MOVED/);
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(false);
  });
});

describe('T12558 round 2 — the protection layer', () => {
  /** A rerooted project: `root/.cleo` renamed into `root/app`. */
  async function rerooted(name: string, id: string): Promise<{ root: string; child: string }> {
    const root = await makeProject(join(testDir, name), id);
    const child = join(root, 'app');
    mkdirSync(child);
    expect((await rerootProject(child, root)).success).toBe(true);
    vi.stubEnv('CLEO_ROOT', undefined);
    return { root, child };
  }

  it('the refusal is typed: exit PROJECT_MOVED, a cd fix, details.movedTo', async () => {
    const { root, child } = await rerooted('typed', 'typed-T12558');
    let caught: unknown;
    try {
      getProjectRoot(root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const err = caught as CleoError;
    expect(err.code).toBe(ExitCode.PROJECT_MOVED);
    expect(err.toLAFSError().code).toBe('E_PROJECT_MOVED');
    expect(err.fix).toContain(`cd "${child}"`);
    expect(err.details?.['movedTo']).toBe(child);
  });

  it('reroot keeps the tombstone out of git via .git/info/exclude', async () => {
    const { root } = await rerooted('exclude', 'exclude-T12558');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '/.cleo-moved.json',
    );
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.cleo-moved.json');
  });

  it('a committed / stale / forged tombstone is ignored with a warning and never bricks a project', async () => {
    const root = await makeProject(join(testDir, 'clone'), 'clone-T12558');
    await getDb(root);
    resetDbState();
    rmSync(join(root, '.cleo', 'cleo.db'));
    vi.stubEnv('CLEO_ROOT', undefined);
    const collector = new WarningCollector();
    mkdirSync(join(root, 'inner'));
    // Three distinct defects: wrong id, movedTo outside the root, no .cleo/ there.
    const bogus = [
      { projectId: 'someone-else', movedTo: join(root, 'inner'), at: 'x' },
      { projectId: 'clone-T12558', movedTo: join(testDir, 'nowhere'), at: 'x' },
      { projectId: 'clone-T12558', movedTo: join(root, 'inner'), at: 'x' },
    ];
    for (const tombstone of bogus) {
      writeFileSync(join(root, '.cleo-moved.json'), JSON.stringify(tombstone));
      await withWarningCollector(collector, async () => {
        expect(getProjectRoot(root)).toBe(root);
        await getDb(root);
      });
      expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(true);
      // Start the next case with no store again, so both checks run.
      resetDbState();
      for (const f of ['cleo.db', 'cleo.db-wal', 'cleo.db-shm']) {
        rmSync(join(root, '.cleo', f), { force: true });
      }
    }
    // Exactly one warning per bogus tombstone, although resolution and the
    // store guard both read it.
    const ignored = (collector.drain() ?? []).filter((w) => w.code === 'W_TOMBSTONE_IGNORED');
    expect(ignored).toHaveLength(bogus.length);
  });

  it('`git checkout -- .` then an encounter keeps the old root `missing`, so the store guard still refuses', async () => {
    const { root } = await rerooted('encounter', 'encounter-T12558');
    rmSync(join(root, '.cleo-moved.json'));
    git(root, 'checkout', '--', '.');
    // Every CLI command records an encounter for its cwd before running.
    await recordProjectEncounter(root);

    expect(await locationState('encounter-T12558', root)).toBe('missing');
    await expect(getDb(root)).rejects.toThrow(/E_PROJECT_MOVED/);
    expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(false);
  });

  it('`cleo doctor` can resolve past the tombstone; the store guard still refuses an empty store', async () => {
    const { root } = await rerooted('doctor', 'doctor-T12558');
    setProjectMovedRefusal(false);
    try {
      let message = '';
      try {
        getProjectRoot(root);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain('E_PROJECT_MOVED');
      // Even with resolution open, nothing may CREATE an empty store there.
      git(root, 'checkout', '--', '.');
      await expect(getDb(root)).rejects.toThrow(/E_PROJECT_MOVED/);
      expect(existsSync(join(root, '.cleo', 'cleo.db'))).toBe(false);
    } finally {
      setProjectMovedRefusal(true);
    }
  });

  it('init in a sibling below a rerooted root refuses before writing, and names `--here`', async () => {
    const { root } = await rerooted('mono-init', 'mono-init-T12558');
    const sibling = join(root, 'app2');
    mkdirSync(sibling);
    process.chdir(sibling);
    const { initProject } = await import('../init.js');
    await expect(initProject({})).rejects.toThrow(/E_PROJECT_MOVED/);
    expect(existsSync(join(sibling, '.cleo'))).toBe(false);
    try {
      getProjectRoot(sibling);
    } catch (err) {
      expect((err as CleoError).fix).toContain('cleo init --here');
    }
  });

  it('a git worktree blocker names `git worktree prune`', async () => {
    const source = await makeProject(join(testDir, 'gwt'), 'gwt-T12558');
    mkdirSync(join(source, '.git', 'worktrees', 'stale'), { recursive: true });
    const result = await moveProject(join(testDir, 'gwt-moved'), source);
    expect(!result.success && result.error.code).toBe('E_MOVE_BLOCKED');
    expect(!result.success && result.error.fix).toContain('git worktree prune');
  });
});

describe('T12558 round 3 — no false refusals, no redirect across checkouts', () => {
  /** A project inside a plain directory `dir` of the repository at `repo`. */
  async function makeSubdirProject(repo: string, sub: string, projectId: string): Promise<string> {
    const root = join(repo, sub);
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'project-id'), `${projectId}\n`);
    writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
    await nexusRegister(root, projectId, 'write');
    await recordProjectEncounter(root);
    return root;
  }

  it('a fresh clone into a directory a project was MOVED away from is a normal checkout, not a refusal', async () => {
    const source = await makeProject(join(testDir, 'A'), 'moved-away-T12558');
    const target = join(testDir, 'M');
    expect((await moveProject(target, source)).success).toBe(true);
    expect(await locationState('moved-away-T12558', source)).toBe('missing');

    // Clone the (moved) repository back into the now-empty old path.
    execFileSync('git', ['clone', '-q', target, source]);
    vi.stubEnv('CLEO_ROOT', undefined);
    await recordProjectEncounter(source);

    expect(getProjectRoot(source)).toBe(source);
    await getDb(source);
    expect(existsSync(join(source, '.cleo', 'cleo.db'))).toBe(true);
  });

  it('a registry-proven refusal (no tombstone) says so: fix offers `cleo init --here`, not deleting a tombstone', async () => {
    const root = await makeProject(join(testDir, 'reg'), 'reg-T12558');
    mkdirSync(join(root, 'app'));
    expect((await rerootProject(join(root, 'app'), root)).success).toBe(true);
    rmSync(join(root, '.cleo-moved.json'));
    git(root, 'checkout', '--', '.');
    vi.stubEnv('CLEO_ROOT', undefined);

    let caught: CleoError | undefined;
    try {
      await getDb(root);
    } catch (err) {
      caught = err as CleoError;
    }
    expect(caught?.code).toBe(ExitCode.PROJECT_MOVED);
    expect(caught?.details?.['evidence']).toBe('registry');
    expect(caught?.fix).toContain('cleo init --here');
    expect(caught?.fix).not.toContain('.cleo-moved.json');
  });

  it('a refused init scaffolds nothing (registry arm, restored tracked .cleo files)', async () => {
    const root = await makeProject(join(testDir, 'noscaffold'), 'noscaffold-T12558');
    mkdirSync(join(root, 'app'));
    expect((await rerootProject(join(root, 'app'), root)).success).toBe(true);
    rmSync(join(root, '.cleo-moved.json'));
    git(root, 'checkout', '--', '.');
    vi.stubEnv('CLEO_ROOT', undefined);
    process.chdir(root);
    const before = treeSnapshot(root);

    const { initProject } = await import('../init.js');
    await expect(initProject({})).rejects.toThrow(/E_PROJECT_MOVED/);

    expect(treeSnapshot(root)).toBe(before);
  });

  it('a relative `movedTo` decoy is ignored', async () => {
    const root = await makeProject(join(testDir, 'decoy'), 'decoy-T12558');
    mkdirSync(join(root, 'app', '.cleo'), { recursive: true });
    writeFileSync(join(root, 'app', '.cleo', 'project-id'), 'decoy-T12558\n');
    writeFileSync(
      join(root, '.cleo-moved.json'),
      JSON.stringify({ projectId: 'decoy-T12558', movedTo: 'app', at: 'x' }),
    );
    rmSync(join(root, '.cleo', 'project-info.json'));
    // No store yet, so the tombstone check actually runs (registration may
    // have opened one).
    resetDbState();
    for (const f of ['cleo.db', 'cleo.db-wal', 'cleo.db-shm']) {
      rmSync(join(root, '.cleo', f), { force: true });
    }
    vi.stubEnv('CLEO_ROOT', undefined);
    // From the root, a relative `app` WOULD resolve to the decoy's .cleo/.
    process.chdir(root);
    expect(existsSync(join('app', '.cleo', 'project-id'))).toBe(true);
    expect(getProjectRoot(root)).toBe(root);
  });

  it('a committed tombstone does not redirect a same-machine second clone to the first checkout', async () => {
    const first = await makeProject(join(testDir, 'first'), 'twoclones-T12558');
    mkdirSync(join(first, 'app'));
    writeFileSync(join(first, 'app', 'KEEP'), 'x');
    git(first, 'add', 'app/KEEP');
    git(first, 'commit', '-q', '-m', 'app');
    expect((await rerootProject(join(first, 'app'), first)).success).toBe(true);
    git(first, 'add', '-f', '.cleo-moved.json');
    git(first, 'commit', '-q', '-m', 'committed tombstone');

    const second = join(testDir, 'second');
    execFileSync('git', ['clone', '-q', first, second]);
    expect(existsSync(join(second, '.cleo-moved.json'))).toBe(true);
    vi.stubEnv('CLEO_ROOT', undefined);

    expect(getProjectRoot(second)).toBe(second);
    await getDb(second);
    expect(existsSync(join(second, '.cleo', 'cleo.db'))).toBe(true);
  });

  it('the tombstone exclude works when the old root is a SUBDIRECTORY of the repository', async () => {
    const repo = join(testDir, 'repo');
    makeGitRepo(repo);
    const root = await makeSubdirProject(repo, 'sub', 'subdir-T12558');
    mkdirSync(join(root, 'app'));

    expect((await rerootProject(join(root, 'app'), root)).success).toBe(true);

    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '/sub/.cleo-moved.json',
    );
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.cleo-moved.json');
  });

  it('the tombstone exclude works when `.git` is a FILE (linked worktree)', async () => {
    const main = join(testDir, 'main');
    makeGitRepo(main);
    const linked = join(testDir, 'linked');
    git(main, 'worktree', 'add', '-q', linked);
    expect(statSync(join(linked, '.git')).isFile()).toBe(true);
    const root = await makeSubdirProject(linked, 'svc', 'gitfile-T12558');
    mkdirSync(join(root, 'app'));

    expect((await rerootProject(join(root, 'app'), root)).success).toBe(true);

    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: linked,
      encoding: 'utf-8',
    });
    expect(status).not.toContain('.cleo-moved.json');
  });

  it('undoing a reroot by hand reconciles to exactly one live location', async () => {
    const root = await makeProject(join(testDir, 'undo'), 'undo-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    expect((await rerootProject(child, root)).success).toBe(true);
    // Undo by hand: move .cleo back, drop the tombstone.
    renameSync(join(child, '.cleo'), join(root, '.cleo'));
    rmSync(join(root, '.cleo-moved.json'));

    await recordProjectEncounter(root);

    expect(await registryPath('undo-T12558')).toBe(root);
    expect(await liveLocations('undo-T12558')).toEqual([root]);
  });
});
