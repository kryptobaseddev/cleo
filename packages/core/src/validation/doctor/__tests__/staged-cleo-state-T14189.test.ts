/**
 * T14189 AC3 — refuse a commit whose index stages CLEO runtime state at ANY
 * path. The leak staged `.cleo` files at ROOT paths, which the managed
 * pre-commit's `^\.cleo/…$` rule let through. The managed hook and
 * `cleo doctor` apply one rule; each case runs both and they must agree.
 *
 * Real git and the real hook template, scratch repositories under a temp dir.
 *
 * @task T14189
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoveryEnv } from '../../../git/work-tree.js';
import { checkStagedCleoState, stagedCleoStatePaths } from '../checks.js';

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../templates/git-hooks/pre-commit',
);

let repo: string;

/** Run git in the scratch repository with no ambient repo variables. */
function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: discoveryEnv(), stdio: 'ignore' });
}

/** Write `body` at `path` (relative to the repo) and stage it. */
function stage(path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
  git('add', '-f', path);
}

/** Run the managed pre-commit hook the way git does (cwd = repo root). */
function hook(): { code: number; output: string } {
  const r = spawnSync('sh', [HOOK], { cwd: repo, env: discoveryEnv(), encoding: 'utf-8' });
  return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cleo-t14189-staged-'));
  git('init', '-q');
  mkdirSync(join(repo, '.cleo'));
  writeFileSync(join(repo, '.cleo', 'config.json'), '{"enforcement":{"session":{}}}\n');
  writeFileSync(join(repo, '.gitignore'), '.cleo/config.json\n');
  git('add', '.gitignore');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('T14189: CLEO runtime state staged at any path', () => {
  it.each([
    ['a database at the root', 'cleo.db', 'sqlite'],
    ['a database nested anywhere', 'wt/.cleo/brain.db', 'sqlite'],
    [
      'project-info.json carrying a projectId, at the root',
      'project-info.json',
      '{"projectId":"p1"}',
    ],
    ['the .cleo config itself', '.cleo/config.json', '{"enforcement":{"session":{}}}\n'],
    [
      'a byte-identical copy of .cleo/config.json, at the root',
      'config.json',
      '{"enforcement":{"session":{}}}\n',
    ],
  ])('refuses %s, naming the path and the reset', (_label, path, body) => {
    stage(path, body);
    expect(stagedCleoStatePaths(repo)).toEqual([path]);
    const check = checkStagedCleoState(repo);
    expect(check.status).toBe('failed');
    expect(check.fix).toBe(`git reset -q -- ${path}`);
    const run = hook();
    expect(run.code).toBe(1);
    expect(run.output).toContain(`git reset -q -- ${path}`);
  });

  it.each([
    ["a project's own config.json", 'config.json', '{"port":8080}\n'],
    ['a project-info.json without a projectId', 'docs/project-info.json', '{"name":"x"}'],
    ['an ordinary file', 'src/index.ts', 'export {};\n'],
  ])('allows %s', (_label, path, body) => {
    stage(path, body);
    expect(stagedCleoStatePaths(repo)).toEqual([]);
    expect(checkStagedCleoState(repo).status).toBe('passed');
    expect(hook().code).toBe(0);
  });
});
