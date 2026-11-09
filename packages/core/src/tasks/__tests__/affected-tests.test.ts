/**
 * File-level affected test selection (T14366).
 *
 * Pinned:
 *  1. a changed module selects the test files that import it, transitively,
 *     across packages, and not unrelated tests of the same package;
 *  2. re-exports are followed by name, unless the re-exported module runs code
 *     on load;
 *  3. it fails closed (`full` with a reason) for root config, non-module files
 *     and a changed module no test reaches;
 *  4. tests outside every package, and tests that read source trees, always run.
 *
 * @task T14366
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectsOfTestFiles, selectAffectedTestFiles } from '../affected-tests.js';

let root: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function pkg(dir: string, name: string, deps: Record<string, string> = {}): void {
  write(`${dir}/package.json`, JSON.stringify({ name, version: '1.0.0', dependencies: deps }));
}

function select(...changed: string[]) {
  return selectAffectedTestFiles(root, changed);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'affected-tests-')));
  write('package.json', JSON.stringify({ name: 'root', private: true }));
  write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  pkg('packages/a', '@x/a');
  pkg('packages/b', '@x/b', { '@x/a': 'workspace:*' });
  write('packages/a/src/leaf.ts', 'export function leaf(): number {\n  return 1;\n}\n');
  write('packages/a/src/other.ts', 'export const other = 2;\n');
  write('packages/a/src/mid.ts', "import { leaf } from './leaf.js';\nexport const mid = leaf();\n");
  write(
    'packages/a/src/index.ts',
    "export { mid } from './mid.js';\nexport * from './other.js';\nexport type { T } from './types.js';\n",
  );
  write('packages/a/src/types.ts', 'export interface T {\n  n: number;\n}\n');
  write('packages/a/src/mid.test.ts', "import { mid } from './mid.js';\n");
  write('packages/a/src/other.test.ts', "import { other } from './other.js';\n");
  write('packages/b/src/uses-mid.test.ts', "import { mid } from '@x/a';\n");
  write('packages/b/src/uses-other.test.ts', "import { other } from '@x/a';\n");
  write('packages/b/src/mocks.test.ts', "vi.mock('@x/a/leaf.js', () => ({}));\n");
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('selectAffectedTestFiles', () => {
  it('selects the tests that reach a changed module, across packages and through barrels', () => {
    const sel = select('packages/a/src/leaf.ts');
    expect(sel).toMatchObject({
      mode: 'affected',
      testFiles: [
        'packages/a/src/mid.test.ts',
        'packages/b/src/mocks.test.ts',
        'packages/b/src/uses-mid.test.ts',
      ],
      changedModules: ['packages/a/src/leaf.ts'],
      symbols: ['packages/a/src/leaf.ts#leaf'],
    });
  });

  it('follows `export *` by name: other.ts reaches only its own importers', () => {
    const sel = select('packages/a/src/other.ts');
    expect(sel.mode === 'affected' && sel.testFiles).toEqual([
      'packages/a/src/other.test.ts',
      'packages/b/src/uses-other.test.ts',
    ]);
  });

  it('a re-exported module that runs code on load reaches every importer of the barrel', () => {
    write('packages/a/src/other.ts', 'export const other = 2;\nregister(other);\n');
    const sel = select('packages/a/src/other.ts');
    expect(sel.mode === 'affected' && sel.testFiles).toEqual([
      'packages/a/src/other.test.ts',
      'packages/b/src/uses-mid.test.ts',
      'packages/b/src/uses-other.test.ts',
    ]);
  });

  it('an import written in a comment is not an edge, and a regex literal is not a load effect', () => {
    write(
      'packages/a/src/other.ts',
      "/** e.g. import { leaf } from './leaf.js' */\nexport const other = /['\"`]/;\n",
    );
    expect(select('packages/a/src/leaf.ts')).toMatchObject({
      testFiles: [
        'packages/a/src/mid.test.ts',
        'packages/b/src/mocks.test.ts',
        'packages/b/src/uses-mid.test.ts',
      ],
    });
    expect(select('packages/a/src/other.ts')).toMatchObject({
      testFiles: ['packages/a/src/other.test.ts', 'packages/b/src/uses-other.test.ts'],
    });
  });

  it('a changed test file selects itself', () => {
    const sel = select('packages/a/src/other.test.ts');
    expect(sel.mode === 'affected' && sel.testFiles).toEqual(['packages/a/src/other.test.ts']);
  });

  it('always runs tests outside every package and tests that read source trees', () => {
    write('scripts/__tests__/gate.test.mjs', "import { x } from '../gate.mjs';\n");
    write(
      'packages/b/src/scan.test.ts',
      "import { readFileSync } from 'node:fs';\nreadFileSync(join(import.meta.dirname, '../src/x.ts'));\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: root });
    const sel = select('packages/a/src/other.ts');
    expect(sel.mode === 'affected' && sel.testFiles).toEqual([
      'packages/a/src/other.test.ts',
      'packages/b/src/scan.test.ts',
      'packages/b/src/uses-other.test.ts',
      'scripts/__tests__/gate.test.mjs',
    ]);
  });

  it('fails closed to full for root config, non-module files and unreached modules', () => {
    expect(select('pnpm-lock.yaml')).toMatchObject({ mode: 'full' });
    expect(select('packages/a/src/fixture.json')).toEqual({
      mode: 'full',
      reason:
        'the import graph cannot see packages/a/src/fixture.json (read at runtime or configures the run)',
    });
    expect(select('packages/a/vitest.config.ts')).toMatchObject({ mode: 'full' });
    write('packages/a/src/orphan.ts', 'export const orphan = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    expect(select('packages/a/src/orphan.ts')).toEqual({
      mode: 'full',
      reason: 'no test file reaches packages/a/src/orphan.ts, directly or transitively',
    });
    expect(select()).toEqual({ mode: 'full', reason: 'the diff is empty' });
  });

  it('a deleted module still selects the tests that import it', () => {
    rmSync(join(root, 'packages/a/src/leaf.ts'));
    const sel = select('packages/a/src/leaf.ts');
    expect(sel.mode === 'affected' && sel.testFiles).toContain('packages/a/src/mid.test.ts');
  });
});

describe('projectsOfTestFiles', () => {
  it('names the project whose root is the longest prefix of each file', () => {
    expect(
      projectsOfTestFiles(
        ['packages/a/src/x.test.ts', 'scripts/__tests__/y.test.mjs', 'elsewhere/z.test.ts'],
        [
          { name: 'root', dir: 'scripts' },
          { name: '@x/a', dir: 'packages/a' },
        ],
      ),
    ).toEqual(['@x/a', 'root']);
  });
});
