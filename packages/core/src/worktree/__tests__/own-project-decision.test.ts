/**
 * The own/foreign decision behind the census's display-only status reads
 * (T14440, round 6): the own project is decided by realpath and
 * `.cleo/project.json` identity against the process's resolved project —
 * never a binding cache, never an ambient pin. A symlink or alias to a
 * foreign store must not count as own, and a missing identity is any doubt.
 *
 * The decision is exercised through the exported display label
 * (`projectStatusReadLabel`), whose fixture projects are always foreign here
 * (the vitest process runs in the cleocode checkout) and therefore never
 * claim a fresh read.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStatusReadLabel } from '../list.js';

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

describe('projectStatusReadLabel — own/foreign decision (T14440 round 6)', () => {
  it('a fixture project with an identity is foreign here (the process runs in the cleocode checkout) and reads as a labelled snapshot or unknown', async () => {
    // The fixture has a project.json but is NOT the process's resolved
    // project: the strict own-decision (realpath + id vs the resolved
    // project) answers foreign, and the label never claims a fresh read.
    const label = await projectStatusReadLabel(foreign);
    expect(['snapshot: may lag uncommitted writes', 'status unknown']).toContain(label);
  });

  it('a symlink to a foreign store is foreign too', async () => {
    const alias = join(base, 'alias-to-foreign');
    symlinkSync(foreign, alias, 'dir');
    expect(realpathSync(alias)).toBe(realpathSync(foreign));
    const label = await projectStatusReadLabel(alias);
    expect(['snapshot: may lag uncommitted writes', 'status unknown']).toContain(label);
  });

  it('a project without a project.json identity is foreign (strict: missing id is any doubt)', async () => {
    const anon = join(base, 'anon');
    mkdirSync(join(anon, '.cleo'), { recursive: true });
    // No project.json: the strict decision must not count it as own even if
    // a pin resolved it onto the own store.
    const label = await projectStatusReadLabel(anon);
    expect(['snapshot: may lag uncommitted writes', 'status unknown']).toContain(label);
  });

  it('an unresolvable target is status unknown, never a fresh read', async () => {
    expect(await projectStatusReadLabel(join(base, 'does-not-exist'))).toBe('status unknown');
  });
});
