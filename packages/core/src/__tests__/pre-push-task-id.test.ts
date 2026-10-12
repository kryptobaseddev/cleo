/**
 * T10488 — pre-push T-ID enforcement, rebase-safe scan range.
 *
 * Verifies the unified pre-push hook at
 * `packages/core/templates/git-hooks/pre-push`:
 *
 *  - Rebased branches (origin/main moved forward with release/chore commits
 *    that don't carry T-IDs) MUST still be pushable; the scan range MUST
 *    exclude commits already reachable from any remote ref.
 *  - Local commits without a T-ID still cause refusal.
 *  - The override allowlist (Merge / Revert / fixup / squash / amend)
 *    still works.
 *
 * The hook is invoked by simulating git's stdin contract:
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 *
 * Tests are project-agnostic: each runs in a tmp git repo with a
 * synthetic "origin" remote (file:// URL pointing at a sibling bare repo).
 *
 * @packageDocumentation
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureProjectGitInitialCommit } from '../scaffold/ensure-dirs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the pre-push hook script under test.
 *
 * Lives in `packages/core/templates/git-hooks/pre-push` and is installed
 * to each consumer project's `.git/hooks/pre-push` by `ensureGitHooks`.
 */
const HOOK_PATH = resolve(__dirname, '..', '..', 'templates', 'git-hooks', 'pre-push');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Initialize a working repo with a sibling bare "origin" repo it pushes to.
 * Returns the working dir path. The bare repo is at `<dir>.origin`.
 */
function makeRepoWithOrigin(): { workDir: string; bareDir: string } {
  const base = mkdtempSync(join(tmpdir(), 't10488-'));
  const bareDir = join(base, 'origin.git');
  const workDir = join(base, 'work');

  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);
  execFileSync('git', ['init', '-q', '-b', 'main', workDir]);
  gitConfig(workDir);
  execFileSync('git', ['-C', workDir, 'remote', 'add', 'origin', bareDir]);
  return { workDir, bareDir };
}

function gitConfig(dir: string): void {
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

function commit(dir: string, subject: string, file = 'a.txt', content?: string): string {
  const path = join(dir, file);
  writeFileSync(path, content ?? `${subject}\n`);
  execFileSync('git', ['-C', dir, 'add', file]);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', subject]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

/**
 * Invoke the pre-push hook with a synthetic stdin payload, simulating
 * git's call contract.
 *
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 */
function runHook(
  repoDir: string,
  stdinLine: string,
  args: [string, string] = ['origin', 'file:///dev/null'],
): RunResult {
  const result = spawnSync('/bin/sh', [HOOK_PATH, ...args], {
    cwd: repoDir,
    env: { ...process.env },
    input: stdinLine,
    encoding: 'utf-8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

describe('T10488 — pre-push hook task-ID enforcement', () => {
  it('hook file exists', () => {
    // Sanity — the script must ship in the package.
    const r = spawnSync('test', ['-f', HOOK_PATH]);
    expect(r.status).toBe(0);
  });

  it('rejects a new-branch push containing a commit without a task ID', () => {
    const { workDir } = makeRepoWithOrigin();
    // Seed origin with a no-task-id commit, then push it so it's a remote ref.
    const initial = commit(workDir, 'chore: initial');
    // Push initial commit to origin so subsequent local commits are "new".
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    // Add a local commit that lacks a T-ID.
    const offender = commit(workDir, 'wip: forgot the task id', 'b.txt');

    // Simulate "git push origin main" for an existing branch (origin already has `initial`).
    const stdin = `refs/heads/main ${offender} refs/heads/main ${initial}\n`;
    const r = runHook(workDir, stdin);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing task IDs/);
    expect(r.stderr).toContain(offender);
  });

  it('accepts a push when every new commit carries a T-ID', () => {
    const { workDir } = makeRepoWithOrigin();
    const initial = commit(workDir, 'T1: initial');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    const good = commit(workDir, 'feat(T10488): proper task id', 'b.txt');
    const stdin = `refs/heads/main ${good} refs/heads/main ${initial}\n`;
    const r = runHook(workDir, stdin);
    expect(r.status).toBe(0);
  });

  // ── The bug this task fixes ───────────────────────────────────────
  //
  // Scenario: feature branch was based on origin/main@A, commits its own
  // T-ID-tagged work, then origin/main moves forward with release-ship /
  // chore(changelog) / ci: nudge commits (which legitimately don't carry
  // task IDs because they're release plumbing emitted by automation).
  //
  // When the operator rebases their feature branch onto the new origin/main,
  // the rebased branch's history (from the OLD remote_sha) now includes
  // those release commits. The naive `$remote_sha..$local_sha` scan range
  // includes those release commits and the hook rejects the push.
  //
  // After the fix, the scan range MUST exclude commits already on any
  // remote ref (origin/main in particular), so release commits never get
  // scanned for T-IDs.
  it('accepts a rebased push containing release commits on origin/main that lack task IDs', () => {
    const { workDir, bareDir } = makeRepoWithOrigin();

    // 1. Seed origin/main with an initial commit.
    commit(workDir, 'T1: seed');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    // 2. Create a feature branch off main and add T-ID-tagged work.
    execFileSync('git', ['-C', workDir, 'checkout', '-q', '-b', 'task/T10488']);
    const featureBefore = commit(workDir, 'feat(T10488): work item 1', 'feature.txt');
    // Push the feature branch to origin so we have a remote_sha for it.
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'task/T10488']);

    // 3. Meanwhile, origin/main moves forward with non-T-ID commits.
    //    Simulate by checking out main, committing release plumbing, pushing.
    execFileSync('git', ['-C', workDir, 'checkout', '-q', 'main']);
    commit(workDir, 'release: ship v2026.5.120', 'CHANGELOG.md', 'changelog\n');
    commit(workDir, 'chore(changelog): regenerate', 'CHANGELOG.md', 'changelog v2\n');
    commit(workDir, 'ci: nudge workflow_run', 'ci-nudge.txt', '.\n');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    // 4. Rebase the feature branch onto the new origin/main.
    execFileSync('git', ['-C', workDir, 'checkout', '-q', 'task/T10488']);
    execFileSync('git', ['-C', workDir, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', workDir, 'rebase', '-q', 'origin/main']);

    const localSha = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    expect(localSha).not.toBe(featureBefore); // rebase rewrote the commit

    // 5. Force-push: stdin reports the OLD remote_sha = featureBefore (pre-rebase).
    //    Before the fix, the hook would scan `featureBefore..localSha`, which
    //    contains the 3 release commits + the rebased feature commit. The 3
    //    release commits lack T-IDs and the hook rejects the push.
    //    After the fix, only the feature commit (the only one NOT on origin/main)
    //    is scanned, and it carries the T-ID.
    const stdin = `refs/heads/task/T10488 ${localSha} refs/heads/task/T10488 ${featureBefore}\n`;
    const r = runHook(workDir, stdin);

    expect(r.status).toBe(0);
    // Sanity: nothing should be flagged.
    expect(r.stderr).not.toMatch(/missing task IDs/);
    expect(bareDir).toContain('origin.git'); // touch unused so lint is happy
  });

  it('still rejects a rebased push when a local commit truly lacks a T-ID', () => {
    const { workDir } = makeRepoWithOrigin();

    commit(workDir, 'T1: seed');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    execFileSync('git', ['-C', workDir, 'checkout', '-q', '-b', 'task/T10488']);
    commit(workDir, 'feat(T10488): tagged work', 'feature.txt');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'task/T10488']);

    execFileSync('git', ['-C', workDir, 'checkout', '-q', 'main']);
    commit(workDir, 'release: ship v2026.5.121', 'CHANGELOG.md', 'changelog\n');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    execFileSync('git', ['-C', workDir, 'checkout', '-q', 'task/T10488']);
    execFileSync('git', ['-C', workDir, 'fetch', '-q', 'origin']);
    execFileSync('git', ['-C', workDir, 'rebase', '-q', 'origin/main']);

    // Add a fresh commit AFTER the rebase that lacks a T-ID.
    const offender = commit(workDir, 'oops no task id', 'bad.txt');

    const localSha = offender;
    const featureBefore = execFileSync('git', ['-C', workDir, 'rev-parse', 'origin/task/T10488'], {
      encoding: 'utf-8',
    }).trim();

    const stdin = `refs/heads/task/T10488 ${localSha} refs/heads/task/T10488 ${featureBefore}\n`;
    const r = runHook(workDir, stdin);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing task IDs/);
    expect(r.stderr).toContain(offender);
  });

  it('honours the merge/revert/fixup/squash/amend allowlist', () => {
    const { workDir } = makeRepoWithOrigin();
    const initial = commit(workDir, 'T1: seed');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    const merge = commit(workDir, 'Merge branch task/T123', 'b.txt');
    const stdin = `refs/heads/main ${merge} refs/heads/main ${initial}\n`;
    const r = runHook(workDir, stdin);
    expect(r.status).toBe(0);
  });

  it("pushes the history a real `cleo init` creates: its empty 'initial: cleo init' commit (T13577)", async () => {
    const { workDir } = makeRepoWithOrigin();
    // The same step `cleo init` runs (ensure-dirs), not a hand-made look-alike.
    expect((await ensureProjectGitInitialCommit(workDir)).action).toBe('created');
    expect(
      execFileSync('git', ['-C', workDir, 'log', '-1', '--pretty=%s'], {
        encoding: 'utf-8',
      }).trim(),
    ).toBe('initial: cleo init');
    const init = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    const r = runHook(workDir, `refs/heads/main ${init} refs/heads/allowed ${ZERO_SHA}\n`);
    expect(r.status, r.stderr).toBe(0);
  });

  it('the init allowance is the exact subject only: an untagged commit or a longer subject is refused (T13577)', () => {
    const { workDir } = makeRepoWithOrigin();
    execFileSync('git', [
      '-C',
      workDir,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'initial: cleo init',
    ]);
    const untagged = commit(workDir, 'chore: no task id', 'b.txt');
    const lookalike = commit(workDir, 'initial: cleo init and more', 'c.txt');
    const r = runHook(workDir, `refs/heads/main ${lookalike} refs/heads/allowed ${ZERO_SHA}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(untagged);
    expect(r.stderr).toContain(lookalike);
    expect(r.stderr).not.toMatch(/initial: cleo init\n/);
  });

  it('refuses the init subject on a commit that has a parent (T13582)', () => {
    const { workDir } = makeRepoWithOrigin();
    const seed = commit(workDir, 'T1: seed');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);
    execFileSync('git', [
      '-C',
      workDir,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'initial: cleo init',
    ]);
    const later = execFileSync('git', ['-C', workDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    const r = runHook(workDir, `refs/heads/main ${later} refs/heads/main ${seed}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(later);
  });

  it('handles branch-deletion push (local_sha = ZERO_SHA) gracefully', () => {
    const { workDir } = makeRepoWithOrigin();
    const initial = commit(workDir, 'T1: seed');
    execFileSync('git', ['-C', workDir, 'push', '-q', '--no-verify', 'origin', 'main']);

    const stdin = `(delete) ${ZERO_SHA} refs/heads/feature ${initial}\n`;
    const r = runHook(workDir, stdin);
    expect(r.status).toBe(0);
  });
});

describe('T13577 — commit-msg accepts the cleo init commit by exact subject', () => {
  const COMMIT_MSG = join(dirname(HOOK_PATH), 'commit-msg');
  const check = (subject: string): number => {
    const dir = mkdtempSync(join(tmpdir(), 't13577-'));
    const file = join(dir, 'MSG');
    writeFileSync(file, `${subject}\n`);
    return spawnSync('/bin/sh', [COMMIT_MSG, file], { cwd: dir, encoding: 'utf-8' }).status ?? -1;
  };

  it("accepts 'initial: cleo init' as the first commit and refuses an untagged or longer subject", () => {
    expect(check('initial: cleo init')).toBe(0);
    expect(check('chore: no task id')).toBe(1);
    expect(check('initial: cleo init and more')).toBe(1);
  });

  it('refuses the init subject once HEAD exists: it is not the first commit (T13582)', () => {
    const dir = mkdtempSync(join(tmpdir(), 't13582-'));
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    gitConfig(dir);
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'T1: seed']);
    const file = join(dir, 'MSG');
    writeFileSync(file, 'initial: cleo init\n');
    const r = spawnSync('/bin/sh', [COMMIT_MSG, file], { cwd: dir, encoding: 'utf-8' });
    expect(r.status).toBe(1);
  });
});
