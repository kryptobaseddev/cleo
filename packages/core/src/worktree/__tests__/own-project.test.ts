/**
 * The own/foreign decision behind the census's display-only status reads
 * (T14440, round 6): the own project is decided by realpath and
 * portable identity against the process's resolved project —
 * never a binding cache, never an ambient pin. A symlink or alias to a
 * foreign store must not count as own, and a missing identity is any doubt.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as projectPaths from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOwnProjectStore } from '../own-project.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

let base: string;
let own: string;
let foreign: string;

/** A registered project with its own `.cleo/project.json` identity. */
function project(name: string, id: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  writeFileSync(
    join(root, '.cleo', 'project.json'),
    JSON.stringify({ schemaVersion: 1, id, name }),
  );
  return root;
}

let prevCleoDir: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'own-store-')));
  own = project('own', 'own-project-id-1');
  foreign = project('foreign', 'foreign-project-id-2');
  // The store resolver walks up from the target for a `.cleo/` dir, bounded
  // by $HOME — a tmpdir outside it resolves unpredictably. Pin CLEO_DIR the
  // way a real registered project resolves: to the OWN project's .cleo.
  prevCleoDir = process.env['CLEO_DIR'];
  process.env['CLEO_DIR'] = join(own, '.cleo');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = prevCleoDir;
  rmSync(base, { recursive: true, force: true });
});

describe('isOwnProjectStore — strict own decision (T14440 rounds 6-7)', () => {
  it('an identical realpath and matching id is own', () => {
    expect(isOwnProjectStore(own, own)).toBe(true);
    writeFileSync(join(own, '.cleo', 'cleo.db'), 'own store');
    expect(isOwnProjectStore(own, own)).toBe(true);
  });

  it('an identical realpath with only a valid legacy id is own', () => {
    rmSync(join(own, '.cleo', 'project.json'));
    writeFileSync(join(own, '.cleo', 'project-id'), 'own-project-id-1\n');
    expect(isOwnProjectStore(own, own)).toBe(true);
  });

  it.each(['', 'invalid/id'])('an invalid legacy id %j stays foreign', (id) => {
    rmSync(join(own, '.cleo', 'project.json'));
    writeFileSync(join(own, '.cleo', 'project-id'), id);
    expect(isOwnProjectStore(own, own)).toBe(false);
  });

  it('different legacy ids at the same realpath stay foreign', () => {
    rmSync(join(own, '.cleo', 'project.json'));
    writeFileSync(join(own, '.cleo', 'project-id'), 'own-project-id-1\n');
    const readIdentity = projectPaths.readPortableProjectId;
    const read = vi.spyOn(projectPaths, 'readPortableProjectId').mockImplementationOnce((root) => {
      const original = readIdentity(root);
      writeFileSync(join(own, '.cleo', 'project-id'), 'other-id\n');
      return original;
    });
    expect(isOwnProjectStore(own, own)).toBe(false);
    expect(read).toHaveBeenNthCalledWith(1, own);
    expect(read).toHaveBeenNthCalledWith(2, own);
  });

  it('a conflicting CLEO_DIR cannot redirect the own project to a foreign store', () => {
    const previousRoot = process.env['CLEO_ROOT'];
    process.env['CLEO_ROOT'] = own;
    process.env['CLEO_DIR'] = join(foreign, '.cleo');
    try {
      expect(isOwnProjectStore(own)).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env['CLEO_ROOT'];
      else process.env['CLEO_ROOT'] = previousRoot;
    }
  });

  it('a store file symlink to foreign metadata is not own', () => {
    const foreignStore = join(foreign, '.cleo', 'cleo.db');
    writeFileSync(foreignStore, 'foreign store');
    symlinkSync(foreignStore, join(own, '.cleo', 'cleo.db'));
    expect(isOwnProjectStore(own, own)).toBe(false);
  });

  it('a dangling store symlink cannot authorize creating a foreign store', () => {
    symlinkSync(join(foreign, '.cleo', 'missing.db'), join(own, '.cleo', 'cleo.db'));
    expect(isOwnProjectStore(own, own)).toBe(false);
  });

  it('a matching realpath without a declared id is foreign', () => {
    rmSync(join(own, '.cleo', 'project.json'));
    expect(isOwnProjectStore(own, own)).toBe(false);
  });

  it('a foreign project is not own', () => {
    expect(isOwnProjectStore(foreign, own)).toBe(false);
  });

  it('a symlink to a foreign store does not count as own', () => {
    const alias = join(base, 'alias-to-foreign');
    symlinkSync(foreign, alias, 'dir');
    expect(realpathSync(alias)).toBe(realpathSync(foreign));
    expect(isOwnProjectStore(alias, own)).toBe(false);
  });

  it('an invalid identity at the same realpath is foreign', () => {
    writeFileSync(join(own, '.cleo', 'project.json'), '{ invalid project identity');
    writeFileSync(join(own, '.cleo', 'project-id'), 'own-project-id-1\n');
    expect(isOwnProjectStore(own, own)).toBe(false);
  });

  it('different declared ids at the same realpath are foreign', () => {
    const readIdentity = projectPaths.readPortableProjectId;
    const read = vi.spyOn(projectPaths, 'readPortableProjectId').mockImplementationOnce((root) => {
      const original = readIdentity(root);
      writeFileSync(
        join(own, '.cleo', 'project.json'),
        JSON.stringify({ schemaVersion: 1, id: 'other-id', name: 'own' }),
      );
      return original;
    });
    expect(isOwnProjectStore(own, own)).toBe(false);
    expect(read).toHaveBeenNthCalledWith(1, own);
    expect(read).toHaveBeenNthCalledWith(2, own);
  });

  it('any doubt (unresolvable target) is foreign', () => {
    expect(isOwnProjectStore(join(base, 'does-not-exist'), own)).toBe(false);
  });
});
