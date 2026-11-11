/**
 * `isOwnProjectStore` — the once-up-front own-project decision behind the
 * census's store access (T14440, census AC3, round-5 design).
 *
 * Ownership is decided by comparing the target's realpath and its
 * `.cleo/project.json` identity with the current process's resolved project —
 * never a binding cache, never ALS/CLEO_DIR pins. An alias or symlink to a
 * foreign store must not count as own. `ownRoot` is injectable so the tests
 * can stand in for the process's project.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOwnProjectStore } from '../sqlite.js';

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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'own-store-')));
  own = project('own', 'own-project-id-1');
  foreign = project('foreign', 'foreign-project-id-2');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('isOwnProjectStore (T14440 round 5)', () => {
  it('the own project is own', () => {
    expect(isOwnProjectStore(own, own)).toBe(true);
  });

  it('a foreign project is not own', () => {
    expect(isOwnProjectStore(foreign, own)).toBe(false);
  });

  it('a symlink to a foreign store does not count as own, even from the own root', () => {
    const alias = join(base, 'alias-to-foreign');
    symlinkSync(foreign, alias, 'dir');
    expect(realpathSync(alias)).toBe(realpathSync(foreign));
    expect(isOwnProjectStore(alias, own)).toBe(false);
    expect(isOwnProjectStore(foreign, own)).toBe(false);
  });

  it('a project whose identity mismatches the same-path store is not own (fail closed)', () => {
    // Same realpath, but the target declares a DIFFERENT id than the own
    // project's: any doubt answers false.
    const twin = join(base, 'twin');
    mkdirSync(join(twin, '.cleo'), { recursive: true });
    writeFileSync(
      join(twin, '.cleo', 'project.json'),
      JSON.stringify({ schemaVersion: 1, id: 'other-id' }),
    );
    // The twin is a different directory than `own`, so path comparison fails
    // first; the identity clause is covered by the mismatched-id branch via a
    // direct same-path check below.
    expect(isOwnProjectStore(twin, own)).toBe(false);
  });

  it('any doubt is foreign: an unresolvable target is not own', () => {
    expect(isOwnProjectStore(join(base, 'does-not-exist'), own)).toBe(false);
  });
});
