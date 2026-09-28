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
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject } from '../init.js';

/** Parent-store files whose bytes must never change from a nested init. */
const PARENT_FILES = ['cleo.db', 'config.json', 'project-info.json'];

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
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

    const err = await initProject({ name: 'sub' }).then(
      () => null,
      (e: Error) => e,
    );
    await closeStores();

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(root);
    expect(err?.message).not.toContain('--force');
    expect(err?.message).toContain('--here');
    expect(existsSync(join(sub, '.cleo'))).toBe(false);
    expect(parentHashes()).toEqual(before);
  });

  it('refuses --force against an ancestor root', async () => {
    const before = parentHashes();
    const sub = join(root, 'sub');
    await mkdir(sub);
    process.chdir(sub);

    await expect(initProject({ name: 'sub', force: true })).rejects.toThrow(/Refusing --force/);
    await closeStores();

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

  it('takes a VACUUM INTO snapshot before a forced re-init of cwd', async () => {
    const backupDir = join(root, '.cleo', 'backups', 'sqlite');
    const snapshots = (): string[] =>
      existsSync(backupDir) ? readdirSync(backupDir).filter((f) => /^tasks-.*\.db$/.test(f)) : [];
    const before = new Set(snapshots());

    await initProject({ name: 'parent', force: true });
    await closeStores();

    expect(snapshots().filter((f) => !before.has(f)).length).toBeGreaterThan(0);
  });
});
