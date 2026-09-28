/**
 * `cleo init` inside a directory nested under an initialized CLEO root (T12562).
 *
 * From a child git repository, init used to resolve the ANCESTOR project,
 * fail with "Project already initialized. DANGER ZONE: use --force", and
 * with `--force` re-initialize the ancestor's store. These tests pin the
 * target selection and prove the parent store is byte-identical afterwards.
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
    expect(files).toContain(`tasks.db.${backupId}`);
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
  });

  it('initializes a submodule-style gitlink checkout in place', async () => {
    const before = parentHashes();
    const sub = join(root, 'vendored');
    await mkdir(join(root, '.git', 'modules'), { recursive: true });
    execFileSync(
      'git',
      ['init', '-q', '--separate-git-dir', join(root, '.git', 'modules', 'vendored'), sub],
      { stdio: 'ignore' },
    );
    expect(readFileSync(join(sub, '.git'), 'utf-8')).toContain('modules');
    process.chdir(sub);

    const result = await initProject({ name: 'vendored' });
    await closeStores();

    expect(result.directory).toBe(join(sub, '.cleo'));
    expect(parentHashes()).toEqual(before);
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
