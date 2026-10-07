/**
 * `cleo init` inside a directory nested under an initialized CLEO root (T12562).
 *
 * From a child git repository, init used to resolve the ANCESTOR project,
 * fail with "Project already initialized. DANGER ZONE: use --force", and
 * with `--force` re-initialize the ancestor's store. These tests pin the
 * target selection, prove the parent store is byte-identical afterwards, and
 * check which store a WRITE made after each init scenario actually reaches.
 *
 * @task T12562
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../errors.js';
import { initProject as engineInitProject } from '../init/engine-ops.js';
import { INIT_ERROR_CODES, initProject } from '../init.js';

/** Parent-store files whose bytes must never change from a nested init. */
const PARENT_FILES = ['cleo.db', 'config.json', 'project-info.json'];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** Run init and return the refusal, failing the test if it resolved. */
async function refusal(opts: Parameters<typeof initProject>[0]): Promise<CleoError> {
  const err = await initProject(opts).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CleoError);
  return err as CleoError;
}

/**
 * Add a task from the CURRENT directory, resolving the project exactly as a
 * command run there would, so a test can see which store the write reached.
 */
async function probeWrite(title: string): Promise<void> {
  const { addTask } = await import('../tasks/add.js');
  await addTask({
    title,
    type: 'saga',
    description: `write probe ${title}`,
    acceptance: ['a1', 'a2', 'a3', 'a4', 'a5'],
  });
  await closeStores();
}

/** Whether `<dir>/.cleo/cleo.db` holds a task titled `title`. */
function storeHas(dir: string, title: string): boolean {
  const path = join(dir, '.cleo', 'cleo.db');
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks_tasks WHERE title = ?').get(title) as
      | { n: number }
      | undefined;
    return (row?.n ?? 0) > 0;
  } finally {
    db.close();
  }
}

async function closeStores(): Promise<void> {
  try {
    const { closeAllDatabases } = await import('../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  try {
    const { closeConduitDb } = await import('../store/conduit-sqlite.js');
    closeConduitDb();
  } catch {
    /* ignore */
  }
}

describe('cleo init under an initialized ancestor (T12562)', () => {
  let testDir: string;
  let root: string;
  let origCwd: string;
  const savedEnv: Record<string, string | undefined> = {};
  const PINS = ['CLEO_DIR', 'CLEO_ROOT', 'CLEO_PROJECT_ROOT'];

  function parentHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of PARENT_FILES) out[f] = sha256(join(root, '.cleo', f));
    return out;
  }

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-init-nested-')));
    root = join(testDir, 'root');
    origCwd = process.cwd();
    for (const k of PINS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    await mkdir(root);
    gitInit(root);
    process.chdir(root);
    await initProject({ name: 'parent' });
    await closeStores();
    for (const f of PARENT_FILES) expect(existsSync(join(root, '.cleo', f))).toBe(true);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    for (const k of PINS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await closeStores();
    await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('initializes a nested git repo in place and leaves the parent store byte-identical', async () => {
    const before = parentHashes();
    const child = join(root, 'child');
    await mkdir(child);
    gitInit(child);
    process.chdir(child);

    const result = await initProject({ name: 'child', detect: true, newIdentity: true });
    await closeStores();

    expect(result.initialized).toBe(true);
    expect(result.directory).toBe(join(child, '.cleo'));
    expect(existsSync(join(child, '.cleo', 'config.json'))).toBe(true);
    expect(existsSync(join(child, '.cleo', 'project-info.json'))).toBe(true);
    expect(parentHashes()).toEqual(before);

    await probeWrite('probe nested repo write');
    expect(storeHas(child, 'probe nested repo write')).toBe(true);
    expect(storeHas(root, 'probe nested repo write')).toBe(false);
    expect(parentHashes()).toEqual(before);
  });

  it('names the ancestor root absolutely and never suggests --force from a plain subdirectory', async () => {
    const before = parentHashes();
    const sub = join(root, 'sub');
    await mkdir(sub);
    process.chdir(sub);

    const err = await refusal({ name: 'sub' });
    await closeStores();

    expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.ancestorProject);
    expect(err.message).toContain(root);
    expect(err.message).not.toContain('--force');
    expect(err.fix).not.toContain('--force');
    expect(err.message).toContain('--here');
    expect(existsSync(join(sub, '.cleo'))).toBe(false);
    expect(parentHashes()).toEqual(before);

    await probeWrite('probe plain subdir write');
    expect(storeHas(root, 'probe plain subdir write')).toBe(true);
    expect(existsSync(join(sub, '.cleo'))).toBe(false);
  });

  it('dispatch engine keeps the ancestor refusal code and fix instead of "use force=true"', async () => {
    const sub = join(root, 'sub');
    await mkdir(sub);
    process.chdir(sub);

    const result = await engineInitProject(sub, { projectName: 'sub' });
    await closeStores();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(INIT_ERROR_CODES.ancestorProject);
    expect(result.error?.message).not.toMatch(/force/);
    expect(result.error?.fix).toContain('--here');
  });

  it('refuses --force against an ancestor root', async () => {
    const before = parentHashes();
    const sub = join(root, 'sub');
    await mkdir(sub);
    process.chdir(sub);

    const err = await refusal({ name: 'sub', force: true });
    await closeStores();

    expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.forceNotCwd);
    expect(err.message).toMatch(/Refusing --force/);
    expect(err.fix).not.toContain('--force');
    expect(err.fix).toContain('--here');

    expect(parentHashes()).toEqual(before);
  });

  it('--here initializes a plain subdirectory without touching the parent', async () => {
    const before = parentHashes();
    const sub = join(root, 'sub');
    await mkdir(sub);
    process.chdir(sub);

    const result = await initProject({ name: 'sub', here: true });
    await closeStores();

    expect(result.directory).toBe(join(sub, '.cleo'));
    expect(parentHashes()).toEqual(before);

    await probeWrite('probe here write');
    expect(storeHas(sub, 'probe here write')).toBe(true);
    expect(storeHas(root, 'probe here write')).toBe(false);
  });

  it('names the resolved root when re-initializing cwd without --force', async () => {
    await expect(initProject({ name: 'parent' })).rejects.toThrow(
      `Project already initialized at ${root}.`,
    );
  });

  it('snapshots what --force resets, so a config.json marker is recoverable', async () => {
    const configPath = join(root, '.cleo', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, t12562Marker: 'keep-me' }, null, 2));

    const result = await initProject({ name: 'parent', force: true });
    await closeStores();

    // --force really does reset config.json, so the marker must live in the backup.
    expect(readFileSync(configPath, 'utf-8')).not.toContain('t12562Marker');
    const backupDir = join(root, '.cleo', 'backups', 'sqlite');
    const files = readdirSync(backupDir);
    const configCopy = files.find((f) => f.startsWith('config.json.pre-force-init-'));
    expect(configCopy).toBeDefined();
    expect(readFileSync(join(backupDir, configCopy as string), 'utf-8')).toContain('keep-me');
    const backupId = (configCopy as string).slice('config.json.'.length);
    // T13245: the store copy is one `cleo.db.<id>` (was `tasks.db.<id>`).
    expect(files).toContain(`cleo.db.${backupId}`);
    expect(files).toContain(`project-info.json.${backupId}`);
    expect(files).toContain(`${backupId}.meta.json`);
    expect(result.created.some((c) => c.includes(backupId))).toBe(true);
  });

  it('refuses --force and changes nothing when the snapshot cannot be written', async () => {
    const backupDir = join(root, '.cleo', 'backups', 'sqlite');
    await mkdir(backupDir, { recursive: true });
    const before = parentHashes();
    chmodSync(backupDir, 0o500);
    try {
      const err = await refusal({ name: 'parent', force: true });
      expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.snapshotFailed);
    } finally {
      chmodSync(backupDir, 0o700);
    }
    await closeStores();
    // The files --force resets are untouched. (cleo.db is opened to snapshot
    // it, which may checkpoint it; --force never resets it.)
    const after = parentHashes();
    expect(after['config.json']).toBe(before['config.json']);
    expect(after['project-info.json']).toBe(before['project-info.json']);
  });

  it('refuses init and --here inside a linked worktree of the parent', async () => {
    git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'init');
    const wt = join(testDir, 'wt');
    git(root, 'worktree', 'add', '-q', wt);
    const before = parentHashes();
    process.chdir(wt);

    for (const opts of [{}, { here: true }, { force: true }]) {
      const err = await refusal({ name: 'wt', ...opts });
      expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.inWorktree);
      expect(err.message).toContain(root);
      expect(err.message).not.toContain('--here');
    }
    await closeStores();

    expect(existsSync(join(wt, '.cleo'))).toBe(false);
    expect(parentHashes()).toEqual(before);

    await probeWrite('probe worktree write');
    expect(storeHas(root, 'probe worktree write')).toBe(true);
    expect(existsSync(join(wt, '.cleo'))).toBe(false);
  });

  /** A real submodule at `root/vendor/lib`, cloned from a committed repo. */
  function addSubmodule(): string {
    const src = join(testDir, 'libsrc');
    gitInit(src);
    git(src, 'commit', '-q', '--allow-empty', '-m', 'lib');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'vendor/lib');
    const lib = join(root, 'vendor', 'lib');
    expect(readFileSync(join(lib, '.git'), 'utf-8')).toContain('modules');
    return lib;
  }

  it('refuses init and --here in a submodule, and a later write lands in the superproject', async () => {
    const lib = addSubmodule();
    const before = parentHashes();
    process.chdir(lib);

    for (const opts of [{}, { here: true }, { force: true }]) {
      const err = await refusal({ name: 'lib', ...opts });
      expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.gitlinkUnsupported);
      expect(err.message).toContain(`CLEO resolves this checkout to ${root}`);
      expect(err.fix).not.toContain('--force');
    }
    await closeStores();
    expect(existsSync(join(lib, '.cleo'))).toBe(false);
    expect(parentHashes()).toEqual(before);

    await probeWrite('probe submodule write');
    expect(storeHas(root, 'probe submodule write')).toBe(true);
    expect(existsSync(join(lib, '.cleo'))).toBe(false);
  });

  it('refuses a submodule even when it carries reroot relocation state (T12558)', async () => {
    // The state a reroot leaves when the old root is a submodule: a tracked
    // .cleo/project-id plus a VALID tombstone pointing into the submodule.
    const lib = addSubmodule();
    const id = 'vendored-T12558';
    await mkdir(join(lib, '.cleo'), { recursive: true });
    writeFileSync(join(lib, '.cleo', 'project-id'), `${id}\n`);
    await mkdir(join(lib, 's', '.cleo'), { recursive: true });
    writeFileSync(join(lib, 's', '.cleo', 'project-id'), `${id}\n`);
    writeFileSync(
      join(lib, '.cleo-moved.json'),
      JSON.stringify({ projectId: id, movedTo: join(lib, 's'), at: 'x' }),
    );
    const before = parentHashes();
    process.chdir(lib);

    for (const opts of [{}, { here: true }, { here: true, newIdentity: true }, { force: true }]) {
      const err = await refusal({ name: 'lib', ...opts });
      expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.gitlinkUnsupported);
      expect(err.message).toContain(`CLEO resolves this checkout to ${root}`);
    }
    await closeStores();
    expect(readFileSync(join(lib, '.cleo', 'project-id'), 'utf-8').trim()).toBe(id);
    expect(existsSync(join(lib, '.cleo', 'cleo.db'))).toBe(false);
    expect(existsSync(join(lib, '.cleo', 'project-info.json'))).toBe(false);
    expect(existsSync(join(lib, '.cleo', 'audit'))).toBe(false);
    expect(parentHashes()).toEqual(before);
  });

  it('refuses init in a separate-git-dir checkout under the project', async () => {
    const sep = join(root, 'vendored');
    await mkdir(join(testDir, 'sepgit'), { recursive: true });
    execFileSync('git', ['init', '-q', '--separate-git-dir', join(testDir, 'sepgit', 'v'), sep], {
      stdio: 'ignore',
    });
    process.chdir(sep);

    const err = await refusal({ name: 'vendored' });
    await closeStores();

    expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.gitlinkUnsupported);
    expect(existsSync(join(sep, '.cleo'))).toBe(false);
  });

  it('names the submodule checkout, not its git dir, for a worktree of a submodule', async () => {
    const lib = addSubmodule();
    const libWt = join(testDir, 'libwt');
    git(lib, 'worktree', 'add', '-q', libWt);
    process.chdir(libWt);

    const err = await refusal({ name: 'libwt' });
    await closeStores();

    expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.inWorktree);
    expect(err.message).toContain(`linked git worktree of ${lib}.`);
    expect(err.message).not.toContain(join('.git', 'modules'));
    expect(err.fix).not.toContain(join('.git', 'modules'));
  });

  it('snapshots hooks from a custom core.hooksPath before --force', async () => {
    const husky = join(root, '.husky');
    await mkdir(husky);
    writeFileSync(join(husky, 'pre-commit'), '#!/bin/sh\necho custom-hook\n');
    git(root, 'config', 'core.hooksPath', '.husky');

    await initProject({ name: 'parent', force: true });
    await closeStores();

    const backupDir = join(root, '.cleo', 'backups', 'sqlite');
    const copy = readdirSync(backupDir).find((f) => f.startsWith('hooks-path-pre-commit.'));
    expect(copy).toBeDefined();
    expect(readFileSync(join(backupDir, copy as string), 'utf-8')).toContain('custom-hook');
  });

  it('points at the uninitialized repo between cwd and the ancestor project', async () => {
    const before = parentHashes();
    const child = join(root, 'child4');
    await mkdir(join(child, 'src'), { recursive: true });
    gitInit(child);
    process.chdir(join(child, 'src'));

    const err = await refusal({ name: 'src' });
    await closeStores();

    expect(err.details?.['codeName']).toBe(INIT_ERROR_CODES.ancestorProject);
    expect(err.message).toContain(`run \`cleo init\` in ${child}`);
    expect(err.message).not.toContain('--here');
    expect(err.message).not.toContain('--force');
    expect(existsSync(join(child, 'src', '.cleo'))).toBe(false);
    expect(parentHashes()).toEqual(before);
  });
});
