/**
 * T14549 — git-tracked `.cleo/` runtime files: the doctor check, the
 * `--fix` untrack (git rm --cached only, working files byte-identical,
 * idempotent), the history scan, and the managed pre-commit hook.
 *
 * Real git and the real hook template in scratch repositories.
 *
 * @task T14549
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCleoHooks } from '../../git/hooks-install.js';
import { discoveryEnv } from '../../git/work-tree.js';
import { getGitignoreContent } from '../../scaffold/ensure-config.js';
import { stagedCleoStatePaths } from '../../validation/doctor/checks.js';
import {
  checkRuntimeFileHistory,
  checkTrackedCleoRuntime,
  isCleoRuntimePath,
  trackedCleoRuntimeWarning,
  untrackCleoRuntimeFiles,
} from '../cleo-runtime-tracking.js';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/git-hooks');

/** Runtime files the fixture commits (sorted, as `git ls-files` lists them). */
const RUNTIME = [
  '.cleo/backups/sqlite/cleo-20261113.db',
  '.cleo/brain.db',
  '.cleo/cleo.db',
  '.cleo/cleo.db-shm',
  '.cleo/cleo.db-wal',
  '.cleo/config.json',
  '.cleo/project-info.json',
  '.cleo/quarantine/rows.json',
];
/** Files that stay tracked. */
const KEPT = [
  '.cleo/.gitignore',
  '.cleo/adrs/ADR-001.md',
  '.cleo/project-id',
  '.cleo/project.json',
];

let repo: string;

/** Run git in the scratch repository with no ambient repo variables. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: discoveryEnv(), encoding: 'utf-8' });
}

/** Write `body` at `path` (relative to the repo). */
function write(path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

/** sha256 of every fixture file's bytes. */
function digests(): Record<string, string> {
  return Object.fromEntries(
    [...RUNTIME, ...KEPT].map((p) => [
      p,
      createHash('sha256')
        .update(readFileSync(join(repo, p)))
        .digest('hex'),
    ]),
  );
}

/** Run the shipped pre-commit hook the way git does (cwd = repo root). */
function hook(): { code: number; output: string } {
  const r = spawnSync('sh', [join(TEMPLATES, 'pre-commit')], {
    cwd: repo,
    env: discoveryEnv(),
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cleo-t14549-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'core.hooksPath', '/dev/null');
  write('.cleo/.gitignore', getGitignoreContent());
  write('.cleo/project.json', '{"schemaVersion":1,"id":"p1","name":"p"}\n');
  write('.cleo/project-id', 'p1\n');
  write('.cleo/adrs/ADR-001.md', '# ADR\n');
  for (const p of RUNTIME) write(p, `runtime bytes of ${p}\n\u0000\u0001`);
  git('add', '-f', '--', ...RUNTIME, ...KEPT);
  git('commit', '-q', '-m', 'T14549 fixture: track the store');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('T14549: git-tracked .cleo runtime files', () => {
  it('classifies runtime paths from the template deny block, never the identity files', () => {
    for (const p of RUNTIME) expect(isCleoRuntimePath(p), p).toBe(true);
    for (const p of KEPT) expect(isCleoRuntimePath(p), p).toBe(false);
    expect(isCleoRuntimePath('cleo.db')).toBe(false);
  });

  it('doctor reports an error naming each tracked runtime file (AC1)', () => {
    const check = checkTrackedCleoRuntime(repo);
    expect(check.status).toBe('failed');
    expect(check.details['tracked']).toEqual(RUNTIME);
    for (const p of RUNTIME) expect(check.message).toContain(p);
    expect(check.message).not.toContain('project.json');
    expect(check.fix).toBe('cleo doctor --fix');
    expect(trackedCleoRuntimeWarning(repo)).toContain('cleo doctor --fix');
  });

  it('doctor reports the commit that added the runtime files (AC6)', () => {
    const head = git('rev-parse', 'HEAD').trim();
    const check = checkRuntimeFileHistory(repo);
    expect(check.status).toBe('warning');
    expect(check.message).toContain(head.slice(0, 12));
    const additions = check.details['additions'] as Array<{ sha: string; paths: string[] }>;
    expect(additions).toHaveLength(1);
    expect(additions[0]?.sha).toBe(head);
    expect([...(additions[0]?.paths ?? [])].sort()).toEqual(RUNTIME);
  });

  it('--fix untracks with git rm --cached only, keeps files byte-identical, is idempotent (AC2)', async () => {
    const before = digests();
    const fixed = await untrackCleoRuntimeFiles(repo);
    expect(fixed.action).toBe('fixed');
    expect(fixed.untracked).toEqual(RUNTIME);
    expect(fixed.commitCommand).toMatch(/^git commit -m /);
    expect(fixed.message).toContain(fixed.commitCommand);

    expect(digests()).toEqual(before);
    const tracked = git('ls-files', '.cleo').trim().split('\n');
    expect(tracked.sort()).toEqual(KEPT);
    // Staged deletions only: the owner commits them; nothing was committed.
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(git('diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(RUNTIME);
    expect(readFileSync(join(repo, '.cleo', '.gitignore'), 'utf-8')).toContain('quarantine/');

    expect(checkTrackedCleoRuntime(repo).status).toBe('passed');
    expect(trackedCleoRuntimeWarning(repo)).toBeNull();
    const again = await untrackCleoRuntimeFiles(repo);
    expect(again.action).toBe('skipped');
    expect(again.untracked).toEqual([]);
    expect(digests()).toEqual(before);
  });

  it('reports nothing outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cleo-t14549-plain-'));
    try {
      expect(checkTrackedCleoRuntime(plain).status).toBe('info');
      expect(checkRuntimeFileHistory(plain).status).toBe('info');
      expect(trackedCleoRuntimeWarning(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('T14549: managed pre-commit refuses staged .cleo runtime files (AC3)', () => {
  beforeEach(async () => {
    await untrackCleoRuntimeFiles(repo);
    git('commit', '-q', '-m', 'T14549 untrack');
  });

  it.each([
    ['a backup', '.cleo/backups/sqlite/next.db'],
    ['a quarantined row file', '.cleo/quarantine/more.json'],
    ['a log', '.cleo/log.json'],
  ])('refuses %s and names the fix; doctor agrees', (_label, path) => {
    write(path, 'x\n');
    git('add', '-f', '--', path);
    expect(stagedCleoStatePaths(repo)).toEqual([path]);
    const run = hook();
    expect(run.code).toBe(1);
    expect(run.output).toContain(path);
    expect(run.output).toContain('git rm --cached -q --');
  });

  it('allows a tracked .cleo file the deny list does not name', () => {
    write('.cleo/adrs/ADR-002.md', '# ADR 2\n');
    git('add', '--', '.cleo/adrs/ADR-002.md');
    expect(stagedCleoStatePaths(repo)).toEqual([]);
    expect(hook().code).toBe(0);
  });

  it('chains an existing foreign pre-commit: its content is kept and it still runs', async () => {
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const foreign = '#!/bin/sh\necho ran > "$(git rev-parse --git-dir)/foreign-ran"\n';
    writeFileSync(join(hooksDir, 'pre-commit'), foreign, { mode: 0o755 });
    git('config', '--unset', 'core.hooksPath');

    const result = await installCleoHooks(repo, { names: ['pre-commit'] });
    expect(result.installed).toEqual(['pre-commit']);
    expect(readFileSync(join(hooksDir, 'pre-commit.cleo-chained'), 'utf-8')).toBe(foreign);
    expect(readFileSync(join(hooksDir, 'pre-commit'), 'utf-8')).toBe(
      readFileSync(join(TEMPLATES, 'pre-commit'), 'utf-8'),
    );

    write('src/ok.ts', 'export {};\n');
    git('add', '--', 'src/ok.ts');
    git('commit', '-q', '-m', 'T14549 ordinary commit');
    expect(existsSync(join(repo, '.git', 'foreign-ran'))).toBe(true);

    write('.cleo/backups/later.db', 'x\n');
    git('add', '-f', '--', '.cleo/backups/later.db');
    const refused = spawnSync('git', ['commit', '-q', '-m', 'T14549 leak'], {
      cwd: repo,
      env: discoveryEnv(),
      encoding: 'utf-8',
    });
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain('.cleo/backups/later.db');
  });
});
