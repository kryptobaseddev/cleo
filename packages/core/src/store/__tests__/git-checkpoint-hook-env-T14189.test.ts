/**
 * T14189 — a `cleo` call inside a git hook inherits git's `GIT_INDEX_FILE`.
 * The checkpoint pointed git at `.cleo/.git` by overriding only `GIT_DIR` and
 * `GIT_WORK_TREE`, so its `git add` staged `.cleo` state files (config.json,
 * project-info.json) into the HOOK's index as root paths, where the next
 * commit would carry them. The checkpoint must leave a calling hook's index
 * untouched and still commit to its own repository.
 *
 * Real git, scratch repositories under a temp dir; no real store is touched.
 *
 * @task T14189
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoveryEnv } from '../../git/work-tree.js';
import { ensureCleoGitRepo } from '../../scaffold/ensure-dirs.js';
import { checkpointGitDir } from '../checkpoint-git-dir.js';
import { gitCheckpoint } from '../git-checkpoint.js';

/** Run git with no ambient repo variables, returning trimmed stdout. */
function git(args: string[], cwd: string): string {
  return execFileSync(
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
    { cwd, env: discoveryEnv(), encoding: 'utf-8' },
  ).trim();
}

describe('T14189: the checkpoint never writes a calling hook’s index', () => {
  let base: string;
  let hookRepo: string;
  let project: string;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cleo-t14189-'));
    // The repository whose hook is running: one tracked file, a clean index.
    hookRepo = join(base, 'hook-repo');
    mkdirSync(hookRepo);
    git(['init', '-q'], hookRepo);
    writeFileSync(join(hookRepo, 'README.md'), 'hook repo\n');
    git(['add', 'README.md'], hookRepo);
    git(['commit', '-q', '-m', 'init'], hookRepo);
    // A project whose .cleo/ holds changed state files and a checkpoint repo.
    project = join(base, 'project');
    mkdirSync(join(project, '.cleo'), { recursive: true });
    vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
    vi.stubEnv('GIT_CHECKPOINT_SUPPRESS', undefined);
    await ensureCleoGitRepo(project);
    writeFileSync(join(project, '.cleo', 'config.json'), '{"checkpoint":{"enabled":true}}\n');
    writeFileSync(join(project, '.cleo', 'project-info.json'), '{"projectId":"p-t14189"}\n');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('leaves GIT_INDEX_FILE’s index unchanged and commits to .cleo’s own repository', async () => {
    const hookIndex = join(hookRepo, '.git', 'index');
    const before = readFileSync(hookIndex);
    // What git exports to a hook (pre-commit / commit-msg).
    vi.stubEnv('GIT_INDEX_FILE', hookIndex);

    await gitCheckpoint('manual', 'T14189', project);

    vi.stubEnv('GIT_INDEX_FILE', undefined);
    expect(readFileSync(hookIndex).equals(before)).toBe(true);
    expect(git(['diff', '--cached', '--name-only'], hookRepo)).toBe('');
    // Not vacuous: the checkpoint did commit, to .cleo/.git.
    const committed = git(
      [
        `--git-dir=${checkpointGitDir(join(project, '.cleo'))}`,
        'show',
        '--name-only',
        '--format=',
        'HEAD',
      ],
      project,
    );
    expect(committed.split('\n')).toEqual(
      expect.arrayContaining(['config.json', 'project-info.json']),
    );
  });
});
