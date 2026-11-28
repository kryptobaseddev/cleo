/**
 * T14625: the merge-commit gate checkout printed by `mergedGateVerifyCommand`
 * must give every workspace package its dependencies, not only the root's.
 *
 * A pnpm workspace whose package `a` depends on workspace package `b`: pnpm
 * links `b` into `packages/a/node_modules` only. The printed command runs with
 * a stub `cleo` on PATH (`run` executes its command, `verify` records whether
 * `b` resolves from `packages/a` and whether the tree is clean and equal to
 * the merge tree). A project without a pnpm lockfile keeps the root link.
 *
 * T14628: the command then removes the checkout with `git worktree remove`
 * (no `--force`) whether the gate passed or failed, keeps it and names its
 * path only when git refuses, and exits with the gate run's status.
 *
 * @task T14625
 * @task T14628
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergedGateVerifyCommand } from '../gate-runner.js';

let base: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Commit everything in `root` and return the commit sha. */
function commitAll(root: string): string {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'merge']);
  return git(root, ['rev-parse', 'HEAD']);
}

/** What the stub `cleo verify` saw inside the checkout, and how the command ended. */
interface PrintedRun {
  resolves: string;
  dirty: string;
  tree: string;
  checkout: string;
  status: number | null;
  stderr: string;
}

/**
 * Run the printed command with a stub `cleo` on PATH: `run` executes its
 * command; `verify` reports whether `dep` resolves from `pkgDir`, whether the
 * checkout is clean, its tree hash and its path, then runs `verifyTail` (its
 * exit status is the gate run's).
 */
function runPrinted(
  root: string,
  merge: string,
  pkgDir: string,
  dep: string,
  verifyTail = 'exit 0',
): PrintedRun {
  const bin = join(base, 'bin');
  const report = join(base, 'report.json');
  write(
    join(bin, 'cleo'),
    [
      '#!/bin/sh',
      'if [ "$1" = run ]; then',
      '  while [ "$1" != -- ]; do shift; done; shift; exec "$@"',
      'fi',
      `resolves=$(cd ${pkgDir} && node -e "try{require.resolve('${dep}');process.stdout.write('yes')}catch{process.stdout.write('no')}")`,
      'dirty=$(git status --porcelain --untracked-files=no)',
      'tree=$(git rev-parse HEAD^{tree})',
      `printf '{"resolves":"%s","dirty":"%s","tree":"%s","checkout":"%s"}' "$resolves" "$dirty" "$tree" "$PWD" > ${JSON.stringify(report)}`,
      verifyTail,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'cleo'), 0o755);
  const run = spawnSync('/bin/sh', ['-c', mergedGateVerifyCommand('T1', root, merge)], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: base },
    encoding: 'utf-8',
  });
  const seen = JSON.parse(readFileSync(report, 'utf-8')) as Omit<PrintedRun, 'status' | 'stderr'>;
  return { ...seen, status: run.status, stderr: run.stderr };
}

/** Paths of every worktree git still registers for `root`. */
function worktrees(root: string): string[] {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** A one-commit repository with nothing to install. */
function plainRepo(): { root: string; merge: string } {
  const root = join(base, 'repo');
  write(join(root, 'package.json'), '{"name":"app","private":true}\n');
  return { root, merge: commitAll(root) };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-t14625-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('mergedGateVerifyCommand dependency layout (T14625)', () => {
  it('gives each workspace package its own node_modules and keeps the merge tree clean', () => {
    const root = join(base, 'repo');
    write(join(root, 'package.json'), '{"name":"ws","private":true}\n');
    write(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    write(join(root, '.gitignore'), 'node_modules/\n.pnpm-store/\n');
    write(
      join(root, 'packages/a/package.json'),
      '{"name":"a","version":"1.0.0","private":true,"dependencies":{"b":"workspace:*"}}\n',
    );
    write(
      join(root, 'packages/b/package.json'),
      '{"name":"b","version":"1.0.0","private":true,"main":"index.js"}\n',
    );
    write(join(root, 'packages/b/index.js'), 'module.exports = 1;\n');
    execFileSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'ignore' });
    // The source checkout has deps installed: only its root node_modules could be linked.
    execFileSync('pnpm', ['install', '--offline'], { cwd: root, stdio: 'ignore' });
    const merge = commitAll(root);

    expect(runPrinted(root, merge, 'packages/a', 'b')).toMatchObject({
      resolves: 'yes',
      dirty: '',
      tree: git(root, ['rev-parse', `${merge}^{tree}`]),
    });
  }, 60_000);

  it('links the root node_modules for a project without pnpm-lock.yaml (npm, Yarn, Bun)', () => {
    const root = join(base, 'repo');
    write(
      join(root, 'package.json'),
      '{"name":"app","private":true,"dependencies":{"dep":"1.0.0"}}\n',
    );
    write(join(root, '.gitignore'), 'node_modules/\n');
    write(join(root, 'index.js'), 'module.exports = 0;\n');
    const merge = commitAll(root);
    // Installed by another manager into the source checkout's root only.
    write(join(root, 'node_modules/dep/package.json'), '{"name":"dep","version":"1.0.0"}\n');
    write(join(root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');

    expect(runPrinted(root, merge, '.', 'dep')).toMatchObject({
      resolves: 'yes',
      dirty: '',
      tree: git(root, ['rev-parse', `${merge}^{tree}`]),
    });
  });
});

describe('mergedGateVerifyCommand checkout removal (T14628)', () => {
  it.each([
    ['passed', 'exit 0', 0],
    ['failed', 'exit 3', 1],
  ])('removes the checkout after a %s gate run and exits with its status', (_, tail, status) => {
    const { root, merge } = plainRepo();
    const run = runPrinted(root, merge, '.', 'none', tail);
    expect(run.status).toBe(status);
    expect(run.tree).toBe(git(root, ['rev-parse', `${merge}^{tree}`]));
    expect(existsSync(run.checkout)).toBe(false);
    expect(worktrees(root)).toHaveLength(1);
    expect(run.stderr).not.toContain('kept the gate checkout');
  });

  it('unlinks the root node_modules link it made, so removal is not refused', () => {
    const { root, merge } = plainRepo();
    write(join(root, 'node_modules/dep/package.json'), '{"name":"dep","version":"1.0.0"}\n');
    write(join(root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
    const run = runPrinted(root, merge, '.', 'dep');
    expect(run).toMatchObject({ resolves: 'yes', status: 0 });
    expect(existsSync(run.checkout)).toBe(false);
    expect(existsSync(join(root, 'node_modules/dep/package.json'))).toBe(true);
  });

  it.each([
    ['passed', 'exit 0', 0],
    ['failed', 'exit 3', 1],
  ])('keeps a checkout git refuses to remove after a %s run and prints its path', (_, tail, status) => {
    const { root, merge } = plainRepo();
    const run = runPrinted(root, merge, '.', 'none', `echo kept > untracked.txt; ${tail}`);
    expect(run.status).toBe(status);
    expect(existsSync(join(run.checkout, 'untracked.txt'))).toBe(true);
    expect(run.stderr).toContain(`cleo: kept the gate checkout ${run.checkout}`);
    expect(worktrees(root)).toHaveLength(2);
  });
});
