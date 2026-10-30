/**
 * A manifest-only workspace change (root `package.json` dependency fields and
 * the pnpm lockfile) is scoped by the lockfile importers it touched after its
 * merge (T14163, owner decision 2026-10-30; axiom T2650).
 *
 * @task T14163
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { manifestScopedChange, pnpmImporterChanges } from '../manifest-scope.js';
import { testRunCoversChange } from '../test-run-binding.js';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function write(file: string, body: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), body);
}

const rootManifest = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: 'ws', private: true, devDependencies: { typescript: '^5.0.0' }, ...extra }, null, 2)}\n`;

const appManifest = (deps: Record<string, string> = {}) =>
  `${JSON.stringify({ name: '@x/app', dependencies: { '@x/lib': 'workspace:*', ...deps } }, null, 2)}\n`;

/** A pnpm v9 lockfile; `mutate` edits the plain object first. */
function lockfile(mutate: (lock: Record<string, Record<string, unknown>>) => void = () => {}): string {
  const lock: Record<string, Record<string, unknown>> = {
    settings: { autoInstallPeers: true },
    importers: {
      '.': { devDependencies: { typescript: { specifier: '^5.0.0', version: '5.0.0' } } },
      'packages/app': {
        dependencies: { '@x/lib': { specifier: 'workspace:*', version: 'link:../lib' } },
      },
      'packages/lib': { dependencies: { ms: { specifier: '^2.1.0', version: '2.1.3' } } },
    },
    packages: {
      'ms@2.1.3': { resolution: { integrity: 'sha512-ms' } },
      'typescript@5.0.0': { resolution: { integrity: 'sha512-ts' } },
    },
    snapshots: { 'ms@2.1.3': {}, 'typescript@5.0.0': {} },
  };
  mutate(lock);
  return stringify({ lockfileVersion: '9.0', ...lock });
}

/** Commit `files` on a branch and merge it into main with --no-ff; returns the merge. */
function mergeChange(files: Record<string, string>): string {
  git(['switch', '-q', '-c', 'change']);
  for (const [file, body] of Object.entries(files)) write(file, body);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'change']);
  git(['switch', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'Merge change', 'change']);
  return git(['rev-parse', 'HEAD']);
}

const changedBy = (merge: string): string[] =>
  git(['diff', '--name-only', `${merge}^1`, merge]).split('\n').filter(Boolean);

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'manifest-scope-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@e.x']);
  write('package.json', rootManifest());
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write('pnpm-lock.yaml', lockfile());
  write('packages/app/package.json', appManifest());
  write('packages/app/src/app.ts', 'export const app = 1;\n');
  write('packages/app/src/app.test.ts', "import './app';\n");
  write(
    'packages/lib/package.json',
    `${JSON.stringify({ name: '@x/lib', dependencies: { ms: '^2.1.0' } }, null, 2)}\n`,
  );
  write('packages/lib/src/lib.ts', 'export const lib = 1;\n');
  write('packages/lib/src/lib.test.ts', "import './lib';\n");
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** The T2650 shape: a package adds a dependency; the lockfile records it under that importer. */
function t2650(): string {
  return mergeChange({
    'packages/app/src/app.ts': "import pad from 'left-pad';\nexport const app = pad('1', 2);\n",
    'packages/app/package.json': appManifest({ 'left-pad': '^1.3.0' }),
    'pnpm-lock.yaml': lockfile((lock) => {
      const app = (lock.importers as Record<string, Record<string, Record<string, unknown>>>)[
        'packages/app'
      ];
      if (app?.dependencies) app.dependencies['left-pad'] = { specifier: '^1.3.0', version: '1.3.0' };
      lock.packages['left-pad@1.3.0'] = { resolution: { integrity: 'sha512-lp' } };
      lock.snapshots['left-pad@1.3.0'] = {};
    }),
  });
}

describe('manifest-only workspace changes after the merge (T14163)', () => {
  it('the T2650 shape is scoped to the importer that changed, and a run of its tests stands in', () => {
    const merge = t2650();
    const changed = changedBy(merge);
    expect(changed).toContain('pnpm-lock.yaml');
    expect(manifestScopedChange(repo, `${merge}^1`, merge, changed)).toEqual({
      importers: ['packages/app'],
      paths: ['packages/app/package.json', 'packages/app/src/app.ts'],
    });
    const ran = ['packages/app/src/app.test.ts'];
    const after = testRunCoversChange(repo, changed, ran, { mergeCommit: merge });
    expect(after).toMatchObject({ ok: true, manifestScoped: ['packages/app'] });
    // Without the merge (before it, or no post-merge context) it stays workspace-wide.
    expect(testRunCoversChange(repo, changed, ran)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('workspace-wide'),
    });
  });

  it('a scripts edit in the root package.json stays workspace-wide', () => {
    const merge = mergeChange({
      'package.json': rootManifest({ scripts: { test: 'vitest run --coverage' } }),
      'packages/app/src/app.ts': 'export const app = 2;\n',
    });
    expect(manifestScopedChange(repo, `${merge}^1`, merge, changedBy(merge))).toBeNull();
    expect(
      testRunCoversChange(repo, changedBy(merge), ['packages/app/src/app.test.ts'], {
        mergeCommit: merge,
      }),
    ).toMatchObject({ ok: false });
  });

  it('a snapshot no changed importer reaches is unattributable and stays workspace-wide', () => {
    const before = lockfile();
    const after = lockfile((lock) => {
      lock.snapshots['ms@2.1.3'] = { dependencies: { debug: '4.3.4' } };
    });
    expect(pnpmImporterChanges(before, after)).toBeNull();
    const merge = mergeChange({
      'pnpm-lock.yaml': after,
      'packages/app/src/app.ts': 'export const app = 3;\n',
    });
    expect(manifestScopedChange(repo, `${merge}^1`, merge, changedBy(merge))).toBeNull();
  });

  it('a lockfile settings change stays workspace-wide', () => {
    expect(
      pnpmImporterChanges(
        lockfile(),
        lockfile((lock) => {
          lock.settings = { autoInstallPeers: false };
        }),
      ),
    ).toBeNull();
  });

  it('a root dependency bump counts as every package', () => {
    const merge = mergeChange({
      'package.json': rootManifest({ devDependencies: { typescript: '^5.1.0' } }),
      'pnpm-lock.yaml': lockfile((lock) => {
        const root = (lock.importers as Record<string, Record<string, Record<string, unknown>>>)['.'];
        if (root?.devDependencies)
          root.devDependencies.typescript = { specifier: '^5.1.0', version: '5.1.0' };
        delete lock.packages['typescript@5.0.0'];
        delete lock.snapshots['typescript@5.0.0'];
        lock.packages['typescript@5.1.0'] = { resolution: { integrity: 'sha512-ts2' } };
        lock.snapshots['typescript@5.1.0'] = {};
      }),
    });
    const scope = manifestScopedChange(repo, `${merge}^1`, merge, changedBy(merge));
    expect(scope?.importers).toEqual(['.']);
    expect(scope?.paths.sort()).toEqual(['packages/app/package.json', 'packages/lib/package.json']);
    // A test file in every package covers it; one package alone does not.
    expect(
      testRunCoversChange(repo, changedBy(merge), ['packages/app/src/app.test.ts'], {
        mergeCommit: merge,
      }),
    ).toMatchObject({ ok: false });
    expect(
      testRunCoversChange(
        repo,
        changedBy(merge),
        ['packages/app/src/app.test.ts', 'packages/lib/src/lib.test.ts'],
        { mergeCommit: merge },
      ),
    ).toMatchObject({ ok: true, manifestScoped: ['.'] });
  });
});
