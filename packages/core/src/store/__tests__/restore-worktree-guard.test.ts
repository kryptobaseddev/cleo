/**
 * T12680 — a manual restore run from inside a linked git worktree.
 *
 * Path resolution maps a worktree to its owning project, so `cleo restore
 * backup` there overwrote the owner's LIVE store without a word, and with an
 * uninitialised owner it restored into the worktree's own `.cleo/`. A
 * worktree of a bare repository was refused as an "unreadable gitlink".
 *
 * Every repository here is a scratch repo under a temp dir; no real store is
 * touched.
 *
 * @task T12680
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeWorktreeOwner } from '../../project-scope.js';
import { fileRestore, restoreBackup } from '../../system/backup.js';

let dir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

/** A repo with one commit; `cleo` seeds an initialised `.cleo/` with a backup. */
function makeRepo(name: string, cleo: boolean): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'README'), 'x');
  git(root, 'add', 'README');
  git(root, 'commit', '-qm', 'init');
  if (cleo) seedCleo(root);
  return root;
}

/** An initialised `.cleo/`: identity, live config, and one backup of each kind. */
function seedCleo(root: string): void {
  const cleo = join(root, '.cleo');
  mkdirSync(join(cleo, 'backups', 'sqlite'), { recursive: true });
  mkdirSync(join(cleo, 'backups', 'operational'), { recursive: true });
  writeFileSync(join(cleo, 'project-info.json'), JSON.stringify({ projectId: 'proj-live' }));
  writeFileSync(join(cleo, 'config.json'), '{"live":true}');
  writeFileSync(
    join(cleo, 'backups', 'sqlite', 'b1.meta.json'),
    JSON.stringify({ files: ['config.json'], timestamp: '2026-09-01T00:00:00Z' }),
  );
  writeFileSync(join(cleo, 'backups', 'sqlite', 'config.json.b1'), '{"restored":true}');
  writeFileSync(join(cleo, 'backups', 'operational', 'config.json.1'), '{"restored":true}');
}

const live = (root: string): string => readFileSync(join(root, '.cleo', 'config.json'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-t12680-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('restore from a worktree whose owner is an initialised project', () => {
  let main: string;
  let wt: string;
  beforeEach(() => {
    main = makeRepo('main', true);
    wt = join(dir, 'wt');
    git(main, 'worktree', 'add', '-q', wt);
  });

  it('restore by id names the owner store and refuses without confirmation', () => {
    expect(() => restoreBackup(main, { backupId: 'b1', cwd: wt })).toThrow(
      /E_WT_STORE_REWRITE_CONFIRM_REQUIRED.*LIVE store .*main\/\.cleo; this worktree's owning project .*main \(projectId proj-live\)/,
    );
    expect(live(main)).toBe('{"live":true}');
  });

  it('restore by id proceeds with --confirm-owner-store', () => {
    const result = restoreBackup(main, { backupId: 'b1', cwd: wt, confirmOwnerStore: true });
    expect(result.filesRestored).toEqual(['config.json']);
    expect(live(main)).toBe('{"restored":true}');
  });

  it('restore --file refuses without confirmation and proceeds with it', async () => {
    vi.stubEnv('CLEO_DIR', join(main, '.cleo'));
    await expect(fileRestore(main, 'config.json', { cwd: wt })).rejects.toThrow(
      /E_WT_STORE_REWRITE_CONFIRM_REQUIRED/,
    );
    expect(live(main)).toBe('{"live":true}');
    await fileRestore(main, 'config.json', { cwd: wt, confirmOwnerStore: true });
    expect(live(main)).toBe('{"restored":true}');
  });

  it('a restore run from the project itself needs no confirmation', () => {
    restoreBackup(main, { backupId: 'b1', cwd: main });
    expect(live(main)).toBe('{"restored":true}');
  });
});

describe('restore from a worktree whose owner cannot hold the store', () => {
  it('uninitialised owner: refused even with confirmation, the worktree store untouched', () => {
    const main = makeRepo('plain', false);
    const wt = join(dir, 'wt-plain');
    git(main, 'worktree', 'add', '-q', wt);
    seedCleo(wt); // the store resolution falls back to the worktree itself
    expect(() => restoreBackup(wt, { backupId: 'b1', cwd: wt, confirmOwnerStore: true })).toThrow(
      /E_WT_STORE_REWRITE_REFUSED.*not an initialised CLEO project/,
    );
    expect(live(wt)).toBe('{"live":true}');
  });

  it('bare repository: the message names the bare repo and the remedy', () => {
    const source = makeRepo('src', false);
    const bare = join(dir, 'app.git');
    git(dir, 'clone', '-q', '--bare', source, bare);
    const wt = join(dir, 'bare-wt');
    git(bare, 'worktree', 'add', '-q', wt);
    const owner = describeWorktreeOwner(wt);
    expect(owner).not.toMatch(/unreadable gitlink/);
    expect(owner).toMatch(/app\.git is a bare git repository/);
    expect(owner).toMatch(/cleo init/);
    seedCleo(wt);
    expect(() => restoreBackup(wt, { backupId: 'b1', cwd: wt, confirmOwnerStore: true })).toThrow(
      /E_WT_STORE_REWRITE_REFUSED.*bare git repository/,
    );
    expect(live(wt)).toBe('{"live":true}');
  });
});
