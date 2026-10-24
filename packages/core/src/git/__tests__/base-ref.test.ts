/**
 * Base ref and commits-behind (T14007), against real repositories: a checkout
 * on an old branch is measured against origin's default branch, not its own
 * HEAD; a remote-less repository falls back to its local default branch; a
 * detached HEAD still resolves the base; and NEXUS freshness reports how far
 * the indexed revision trails the base.
 *
 * @task T14007
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureAgainstBase } from '../../nexus/freshness.js';
import {
  changedFilesSince,
  commitsBetween,
  originDefaultMergeBase,
  resolveBaseRef,
  resolveOriginDefault,
  revParse,
} from '../base-ref.js';

let dir: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A repo with `count` commits on `main`; returns the sha of each. */
function repo(path: string, count: number): string[] {
  git(dir, ['init', '-q', '-b', 'main', path]);
  git(path, ['config', 'user.name', 't']);
  git(path, ['config', 'user.email', 't@example.com']);
  git(path, ['config', 'commit.gpgsign', 'false']);
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    writeFileSync(join(path, 'f.txt'), `${i}\n`);
    git(path, ['add', 'f.txt']);
    git(path, ['commit', '-q', '-m', `c${i}`]);
    shas.push(git(path, ['rev-parse', 'HEAD']));
  }
  return shas;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-base-ref-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A clone whose origin/main is 3 commits ahead of its checked-out `old` branch. */
function behindClone(): { clone: string; shas: string[] } {
  const upstream = join(dir, 'upstream');
  const shas = repo(upstream, 5);
  const clone = join(dir, 'clone');
  git(dir, ['clone', '-q', upstream, clone]);
  git(clone, ['switch', '-q', '-c', 'old', shas[1]!]);
  return { clone, shas };
}

describe('base ref (T14007)', () => {
  it('measures an old branch against origin/main, not its own HEAD', () => {
    const { clone, shas } = behindClone();
    expect(resolveOriginDefault(clone)).toBe('origin/main');
    expect(resolveBaseRef(clone)).toBe('origin/main');
    expect(revParse(clone, 'origin/main')).toBe(shas[4]);
    expect(commitsBetween(clone, shas[1]!, 'origin/main')).toBe(3);
    expect(commitsBetween(clone, shas[1]!, 'HEAD')).toBe(0);
    expect(originDefaultMergeBase(clone)).toBe(shas[1]);
  });

  it('falls back to the local default branch without a remote, and resolves when detached', () => {
    const local = join(dir, 'local');
    const shas = repo(local, 3);
    expect(resolveOriginDefault(local)).toBeNull();
    expect(resolveBaseRef(local)).toBe('main');
    git(local, ['switch', '-q', '--detach', shas[0]!]);
    expect(resolveBaseRef(local)).toBe('main');
    expect(commitsBetween(local, shas[0]!, 'main')).toBe(2);
  });

  it('answers for its own repository even with an ambient GIT_DIR (inside a git hook)', () => {
    const { clone } = behindClone();
    const other = join(dir, 'other');
    repo(other, 1);
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(other, '.git');
    try {
      expect(resolveOriginDefault(clone)).toBe('origin/main');
      expect(resolveBaseRef(clone)).toBe('origin/main');
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }
  });

  it('falls back to origin/master when origin/HEAD is missing', () => {
    const upstream = join(dir, 'upstream-master');
    git(dir, ['init', '-q', '-b', 'master', upstream]);
    git(upstream, ['config', 'user.name', 't']);
    git(upstream, ['config', 'user.email', 't@example.com']);
    git(upstream, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(upstream, 'f.txt'), 'x\n');
    git(upstream, ['add', 'f.txt']);
    git(upstream, ['commit', '-q', '-m', 'c0']);
    const clone = join(dir, 'clone-master');
    git(dir, ['clone', '-q', upstream, clone]);
    git(clone, ['remote', 'set-head', 'origin', '--delete']);
    expect(resolveOriginDefault(clone)).toBe('origin/master');
    expect(resolveBaseRef(clone)).toBe('origin/master');
  });

  it('counts tracked files changed since a revision without a walk (T14014)', () => {
    const { clone, shas } = behindClone();
    expect(changedFilesSince(clone, shas[1]!)).toBe(0);
    writeFileSync(join(clone, 'f.txt'), 'edited\n');
    expect(changedFilesSince(clone, shas[1]!)).toBe(1);
    expect(changedFilesSince(clone, 'f'.repeat(40))).toBeNull();
  });

  it('answers null for an unknown revision or a directory without commits', () => {
    const empty = join(dir, 'empty');
    git(dir, ['init', '-q', empty]);
    expect(resolveBaseRef(empty)).toBeNull();
    const local = join(dir, 'local');
    repo(local, 1);
    expect(commitsBetween(local, 'f'.repeat(40), 'main')).toBeNull();
  });

  it('NEXUS freshness reports commits behind the base and the index age', async () => {
    const { clone, shas } = behindClone();
    const native = new DatabaseSync(':memory:');
    native.exec(
      'CREATE TABLE _nexus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0)',
    );
    native
      .prepare('INSERT INTO _nexus_meta (key, value) VALUES (?, ?)')
      .run('graph_assessment', JSON.stringify({ assessedRevision: shas[1] }));
    const indexedAt = new Date(Date.now() - 3 * 86_400_000 - 1000).toISOString();

    const measured = await measureAgainstBase(drizzle({ client: native }), clone, indexedAt);

    expect(measured).toEqual({
      indexedRevision: shas[1],
      baseRef: 'origin/main',
      baseRevision: shas[4],
      commitsBehind: 3,
      commitsBehindHead: 0,
      changedFilesSinceIndex: 0,
      ageDays: 3,
    });
    native.close();
  });

  it('NEXUS freshness reports nulls when no revision or index time is recorded', async () => {
    const local = join(dir, 'local');
    const shas = repo(local, 1);
    const native = new DatabaseSync(':memory:');
    native.exec(
      'CREATE TABLE _nexus_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0)',
    );

    const measured = await measureAgainstBase(drizzle({ client: native }), local, null);

    expect(measured).toEqual({
      indexedRevision: null,
      baseRef: 'main',
      baseRevision: shas[0],
      commitsBehind: null,
      commitsBehindHead: null,
      changedFilesSinceIndex: null,
      ageDays: null,
    });
    native.close();
  });
});
