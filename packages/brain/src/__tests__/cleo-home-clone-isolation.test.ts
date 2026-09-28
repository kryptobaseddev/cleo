/**
 * Two clones of one project share its id, but each reads its OWN `.cleo/`
 * (T12470).
 *
 * The registry names one checkout per project id — whichever was confirmed
 * last. `getCleoProjectDir` must use that answer only when it names the
 * checkout the caller is in; otherwise clone A's brain adapters would read
 * clone B's `.cleo/`.
 *
 * @task T12470
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCleoProjectDir } from '../cleo-home.js';

let root: string;
let cwd: string;

/** A clone: a git toplevel whose `.cleo/` declares the shared id. */
function makeClone(dir: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });
  writeFileSync(join(dir, '.cleo', 'project-id'), 'shared-id-T12470\n');
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'brain-clones-T12470-')));
  cwd = process.cwd();
  vi.stubEnv('CLEO_HOME', join(root, 'home'));
  vi.stubEnv('CLEO_ROOT', undefined);
  mkdirSync(join(root, 'home'), { recursive: true });
  _resetCleoPlatformPathsCache();
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  _resetCleoPlatformPathsCache();
  rmSync(root, { recursive: true, force: true });
});

describe('getCleoProjectDir with two clones of one project (T12470)', () => {
  it('returns the caller clone, not whichever clone the registry names', () => {
    const cloneA = makeClone(join(root, 'clone-a'));
    const cloneB = makeClone(join(root, 'clone-b'));
    // The registry names clone B (registered last).
    const db = new DatabaseSync(join(root, 'home', 'cleo.db'));
    db.exec(
      'CREATE TABLE nexus_project_registry (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO nexus_project_registry VALUES (?, ?)').run('shared-id-T12470', cloneB);
    db.close();

    process.chdir(cloneA);
    expect(getCleoProjectDir()).toBe(join(cloneA, '.cleo'));
    process.chdir(cloneB);
    expect(getCleoProjectDir()).toBe(join(cloneB, '.cleo'));
  });
});
