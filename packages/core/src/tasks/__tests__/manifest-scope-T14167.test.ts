/**
 * A manifest-only workspace change is scoped by the npm (`package-lock.json`
 * v3) and Yarn Berry (`yarn.lock`) workspace entries it changed, as T14163
 * does for pnpm importers. Fixtures are real lockfiles from `npm install
 * --package-lock-only` (npm 11.20) and `yarn install --mode=update-lockfile`
 * (Yarn 4.5.3) of a two-package workspace, before and after `@x/app` adds
 * `left-pad`.
 *
 * @task T14167
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  manifestScopedChange,
  npmImporterChanges,
  yarnImporterChanges,
} from '../manifest-scope.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/lockfiles/${name}`, import.meta.url)), 'utf-8');

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function write(file: string, body: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), body);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const rootManifest = (devDependencies: Record<string, string> = { ms: '^2.1.0' }) =>
  json({ name: 'ws', private: true, workspaces: ['packages/*'], devDependencies });

const appManifest = (deps: Record<string, string> = {}) =>
  json({ name: '@x/app', version: '1.0.0', dependencies: { '@x/lib': '*', ...deps } });

/** A two-package npm or Yarn workspace whose lockfile is `lock` at `lockfile`. */
function init(lockfile: string, lock: string): void {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'manifest-scope-t14167-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@e.x']);
  write('package.json', rootManifest());
  write(lockfile, lock);
  write('packages/app/package.json', appManifest());
  write('packages/app/src/app.test.ts', 'export {};\n');
  write(
    'packages/lib/package.json',
    json({ name: '@x/lib', version: '1.0.0', dependencies: { debug: '^4.3.0' } }),
  );
  write('packages/lib/src/lib.test.ts', 'export {};\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
}

/** Commit `files` on a branch, merge it with --no-ff, and return the merge and its paths. */
function mergeChange(files: Record<string, string>): { merge: string; changed: string[] } {
  git(['switch', '-q', '-c', 'change']);
  for (const [file, body] of Object.entries(files)) write(file, body);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'change']);
  git(['switch', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'Merge change', 'change']);
  const merge = git(['rev-parse', 'HEAD']);
  const changed = git(['diff', '--name-only', `${merge}^1`, merge])
    .split('\n')
    .filter(Boolean);
  return { merge, changed };
}

const scope = ({ merge, changed }: { merge: string; changed: string[] }) =>
  manifestScopedChange(repo, `${merge}^1`, merge, changed);

beforeEach(() => {
  repo = '';
});

afterEach(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
});

describe('npm package-lock.json v3 (T14167)', () => {
  const before = fixture('npm-v3-before.json');
  const after = fixture('npm-v3-left-pad.json');

  it('AC1: a dependency added to one workspace is scoped to that workspace', () => {
    expect(npmImporterChanges(before, after)).toEqual({ importers: ['packages/app'] });
    init('package-lock.json', before);
    const change = mergeChange({
      'packages/app/package.json': appManifest({ 'left-pad': '^1.3.0' }),
      'package-lock.json': after,
    });
    expect(change.changed).toContain('package-lock.json');
    expect(scope(change)).toEqual({
      importers: ['packages/app'],
      paths: ['packages/app/package.json'],
    });
  });

  it('AC1: a root dependency bump counts as every workspace', () => {
    const bumped = JSON.parse(before) as { packages: Record<string, Record<string, unknown>> };
    bumped.packages[''] = { ...bumped.packages[''], devDependencies: { ms: '^2.1.3' } };
    init('package-lock.json', before);
    const result = scope(
      mergeChange({
        'package.json': rootManifest({ ms: '^2.1.3' }),
        'package-lock.json': json(bumped),
      }),
    );
    expect(result?.importers).toEqual(['.']);
    expect(result?.paths.sort()).toEqual([
      'packages/app/package.json',
      'packages/lib/package.json',
    ]);
  });

  it('AC2: a package entry no changed workspace reaches stays workspace-wide', () => {
    const tampered = JSON.parse(before) as { packages: Record<string, Record<string, unknown>> };
    tampered.packages['node_modules/ms'] = {
      ...tampered.packages['node_modules/ms'],
      integrity: 'x',
    };
    expect(npmImporterChanges(before, json(tampered))).toBeNull();
    init('package-lock.json', before);
    expect(
      scope(
        mergeChange({
          'package-lock.json': json(tampered),
          'packages/app/src/app.test.ts': 'export const a = 1;\n',
        }),
      ),
    ).toBeNull();
  });

  it('AC2: a v2 lockfile (legacy dependencies tree) stays workspace-wide', () => {
    const v2 = (text: string) => json({ ...JSON.parse(text), lockfileVersion: 2 });
    expect(npmImporterChanges(v2(before), v2(after))).toBeNull();
  });
});

describe('Yarn Berry yarn.lock (T14167)', () => {
  const before = fixture('yarn-berry-before.lock');
  const after = fixture('yarn-berry-left-pad.lock');

  it('AC1: a dependency added to one workspace is scoped to that workspace', () => {
    expect(yarnImporterChanges(before, after)).toEqual({ importers: ['packages/app'] });
    init('yarn.lock', before);
    const change = mergeChange({
      'packages/app/package.json': appManifest({ 'left-pad': '^1.3.0' }),
      'yarn.lock': after,
    });
    expect(scope(change)).toEqual({
      importers: ['packages/app'],
      paths: ['packages/app/package.json'],
    });
  });

  it('AC1: a change to the root workspace entry counts as every workspace', () => {
    const rootBump = before.replace(
      '"ws@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "ws@workspace:."\n  dependencies:\n    ms: "npm:^2.1.0"',
      '"ws@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "ws@workspace:."\n  dependencies:\n    ms: "npm:^2.1.3"',
    );
    expect(rootBump).not.toBe(before);
    expect(yarnImporterChanges(before, rootBump)).toEqual({ importers: ['.'] });
  });

  it('AC2: a package entry no changed workspace reaches stays workspace-wide', () => {
    const tampered = before.replace('checksum: 10c0/d924b57e', 'checksum: 10c0/00000000');
    expect(tampered).not.toBe(before);
    expect(yarnImporterChanges(before, tampered)).toBeNull();
    init('yarn.lock', before);
    expect(
      scope(
        mergeChange({
          'yarn.lock': tampered,
          'packages/app/src/app.test.ts': 'export const a = 1;\n',
        }),
      ),
    ).toBeNull();
  });

  it('AC2: a __metadata change and a Yarn Classic lockfile stay workspace-wide', () => {
    expect(
      yarnImporterChanges(before, before.replace('cacheKey: 10c0', 'cacheKey: 10c1')),
    ).toBeNull();
    const classic = '# yarn lockfile v1\n\n\nms@^2.1.0:\n  version "2.1.3"\n';
    expect(yarnImporterChanges(classic, `${classic}\n`)).toBeNull();
  });
});
