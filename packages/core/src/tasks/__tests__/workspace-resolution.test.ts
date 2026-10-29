/**
 * T14097 — a test run must test its own checkout's workspace packages.
 *
 * Fixtures are two real git checkouts of a two-package pnpm workspace
 * (`@x/app` depends on `@x/lib`). One resolves `@x/lib` through its own
 * package link; the other has a root `node_modules` symlinked to the first
 * checkout's, the incident's shape.
 *
 * @task T14097
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAtom } from '../evidence.js';
import {
  borrowedBuildWarning,
  checkWorkspaceResolution,
  foreignResolutionReason,
  packagesNamedByTestArgs,
  SOURCE_STAMP_FILE,
  staleDistReason,
  UNSTAMPED_DIST_FIX,
  unstampedDistWarning,
  workspaceResolutionError,
  writeSourceStamps,
} from '../workspace-resolution.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, body: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A committed two-package workspace; its dist is newer than its source. */
function checkout(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-resolution-')));
  made.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'ws', private: true }));
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write(
    root,
    'packages/lib/package.json',
    JSON.stringify({ name: '@x/lib', main: 'dist/index.js' }),
  );
  write(root, 'packages/lib/src/index.ts', 'export const lib = 1;\n');
  write(root, 'packages/lib/dist/index.js', 'export const lib = 1;\n');
  write(
    root,
    'packages/app/package.json',
    JSON.stringify({ name: '@x/app', dependencies: { '@x/lib': 'workspace:*' } }),
  );
  write(root, 'packages/app/src/app.test.ts', "import '@x/lib';\n");
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('add', '-A');
  git(
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'init',
  );
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(root, 'packages/lib/src/index.ts'), past, past);
  return root;
}

/** Link `@x/lib` for `@x/app` the way pnpm does, inside the checkout. */
function linkOwn(root: string): void {
  mkdirSync(join(root, 'packages/app/node_modules/@x'), { recursive: true });
  symlinkSync(join(root, 'packages/lib'), join(root, 'packages/app/node_modules/@x/lib'));
}

/** A second checkout whose root node_modules is a symlink to `other`'s. */
/** Commit a different `@x/lib` source in `root`: an older or newer checkout. */
function diverge(root: string): void {
  write(root, 'packages/lib/src/index.ts', 'export const lib = 2;\n');
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qam',
      'diverge',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

function borrowing(other: string): string {
  mkdirSync(join(other, 'node_modules/@x'), { recursive: true });
  symlinkSync(join(other, 'packages/lib'), join(other, 'node_modules/@x/lib'));
  const root = checkout();
  symlinkSync(join(other, 'node_modules'), join(root, 'node_modules'));
  return root;
}

describe('checkWorkspaceResolution (T14097)', () => {
  it('a checkout resolving its own packages, with a stamped dist, has nothing to report', () => {
    const root = checkout();
    linkOwn(root);
    writeSourceStamps(root);
    const report = checkWorkspaceResolution(root);
    expect(report.foreign).toEqual([]);
    expect(report.staleDist).toEqual([]);
    expect(foreignResolutionReason(report)).toBeNull();
    expect(workspaceResolutionError(report)).toBeNull();
    expect(unstampedDistWarning(report)).toBeNull();
  });

  it('a built package with no stamp warns once, naming the packages and the root build, and is not refused', () => {
    const root = checkout();
    linkOwn(root);
    const report = checkWorkspaceResolution(root);
    expect(report.unstamped).toEqual([{ package: '@x/lib', dir: 'packages/lib' }]);
    expect(workspaceResolutionError(report)).toBeNull();
    const warning = unstampedDistWarning(report) ?? '';
    expect(warning.split('\n')).toHaveLength(1);
    expect(warning).toContain('No build stamp for @x/lib');
    expect(warning).toContain(UNSTAMPED_DIST_FIX);
    expect(UNSTAMPED_DIST_FIX).toContain('pnpm run build');
  });

  it('a node_modules symlinked to a checkout with different source is foreign, and the reason names both paths and the remedy', () => {
    const other = checkout();
    diverge(other);
    const root = borrowing(other);
    const report = checkWorkspaceResolution(root);
    expect(report.foreign).toEqual([
      {
        importer: '@x/app',
        dependency: '@x/lib',
        resolved: join(other, 'packages/lib'),
        expected: join(root, 'packages/lib'),
      },
    ]);
    const reason = foreignResolutionReason(report) ?? '';
    expect(reason).toContain(
      `@x/lib (imported by @x/app) resolves to ${join(other, 'packages/lib')}`,
    );
    expect(reason).toContain('pnpm install --frozen-lockfile');
    expect(reason).toContain('--filter "@x/lib..."');
  });

  it('a checkout borrowing node_modules from one with identical clean source is only warned about', () => {
    const other = checkout();
    const root = borrowing(other);
    const report = checkWorkspaceResolution(root);
    expect(report.foreign).toEqual([]);
    expect(report.borrowed.map((b) => b.dependency)).toEqual(['@x/lib']);
    expect(workspaceResolutionError(report)).toBeNull();
    expect(borrowedBuildWarning(report)).toContain(
      `@x/lib resolves to another checkout (${join(other, 'packages/lib')}) whose source is identical`,
    );
    // An uncommitted edit on either side makes it foreign again.
    write(root, 'packages/lib/src/index.ts', 'export const lib = 3;\n');
    expect(checkWorkspaceResolution(root).foreign.map((f) => f.dependency)).toEqual(['@x/lib']);
  });

  it('a fresh checkout of the stamped source stays silent, whatever its mtimes (the CI case)', () => {
    const root = checkout();
    linkOwn(root);
    expect(writeSourceStamps(root)).toEqual(['packages/lib']);
    // A checkout after the build rewrites the source: newer mtimes, same bytes.
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(join(root, 'packages/lib/src/index.ts'), later, later);
    const report = checkWorkspaceResolution(root);
    expect(report.staleDist).toEqual([]);
    expect(unstampedDistWarning(report)).toBeNull();
    expect(workspaceResolutionError(report)).toBeNull();
  });

  it('the stamp depends on the source alone, so every build of the same source ships the same bytes', () => {
    const root = checkout();
    writeSourceStamps(root);
    const stamp = join(root, 'packages/lib/dist', SOURCE_STAMP_FILE);
    const first = readFileSync(stamp, 'utf-8');
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(join(root, 'packages/lib/dist/index.js'), later, later);
    writeSourceStamps(root);
    expect(readFileSync(stamp, 'utf-8')).toBe(first);
    expect(JSON.parse(first)).toEqual({ schema: 2, sourceHash: expect.any(String) });
  });

  it('a stamped dist built from other source is refused, naming the package and the rebuild command', () => {
    const root = checkout();
    linkOwn(root);
    writeSourceStamps(root);
    write(root, 'packages/lib/src/index.ts', 'export const lib = 2;\n');
    const report = checkWorkspaceResolution(root);
    expect(report.foreign).toEqual([]);
    expect(report.staleDist).toEqual([{ package: '@x/lib', dir: 'packages/lib' }]);
    expect(staleDistReason(report)).toContain('The dist of @x/lib was built from other source');
    const err = workspaceResolutionError(report);
    expect(err?.codeName).toBe('E_WORKSPACE_STALE_DIST');
    expect(err?.fix).toBe('Rebuild them: `pnpm --filter "@x/lib" run build`.');
  });

  it('a dist with no stamp, an older-schema stamp, or one rebuilt after its stamp, is never refused', () => {
    const root = checkout();
    linkOwn(root);
    write(root, 'packages/lib/src/index.ts', 'export const lib = 2;\n');
    expect(checkWorkspaceResolution(root).staleDist).toEqual([]);
    write(
      root,
      `packages/lib/dist/${SOURCE_STAMP_FILE}`,
      JSON.stringify({ schema: 1, sourceHash: 'x', distNewestMs: 0 }),
    );
    // An older-schema stamp counts as no stamp: warned, never refused.
    const old = checkWorkspaceResolution(root);
    expect(old.staleDist).toEqual([]);
    expect(old.unstamped.map((u) => u.package)).toEqual(['@x/lib']);
    writeSourceStamps(root);
    write(root, 'packages/lib/src/index.ts', 'export const lib = 3;\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'packages/lib/dist/index.js'), later, later);
    const rebuilt = checkWorkspaceResolution(root);
    expect(rebuilt.staleDist).toEqual([]);
    expect(rebuilt.unstamped).toEqual([]);
    expect(existsSync(join(root, 'packages/lib/dist', SOURCE_STAMP_FILE))).toBe(true);
  });

  it('scopes to the packages a run names through its test files', () => {
    const root = checkout();
    expect(
      packagesNamedByTestArgs(root, join(root, 'packages/app'), [
        'vitest',
        'run',
        'src/app.test.ts',
      ]),
    ).toEqual(['@x/app']);
    expect(packagesNamedByTestArgs(root, root, ['vitest', 'run'])).toEqual([]);
    expect(checkWorkspaceResolution(root, ['@x/lib']).foreign).toEqual([]);
  });
});

describe('a test-run receipt is never recorded from a checkout testing another one (T14097)', () => {
  it('validateAtom refuses the report with E_WORKSPACE_FOREIGN_CHECKOUT', async () => {
    const other = checkout();
    diverge(other);
    const root = borrowing(other);
    const file = join(root, 'packages/app/src/app.test.ts');
    write(
      root,
      'report.json',
      JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        success: true,
        startTime: Date.now(),
        testResults: [
          { name: file, status: 'passed', assertionResults: [{ status: 'passed', title: 't' }] },
        ],
      }),
    );
    const r = await validateAtom({ kind: 'test-run', path: 'report.json' }, root);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codeName).toBe('E_WORKSPACE_FOREIGN_CHECKOUT');
    expect(!r.ok && r.reason).toContain(join(other, 'packages/lib'));
  });

  it('validateAtom refuses a receipt from a checkout whose dist was built from other source (T14123)', async () => {
    const root = checkout();
    linkOwn(root);
    writeSourceStamps(root);
    write(root, 'packages/lib/src/index.ts', 'export const lib = 2;\n');
    const file = join(root, 'packages/app/src/app.test.ts');
    write(
      root,
      'report.json',
      JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        success: true,
        startTime: Date.now(),
        testResults: [
          { name: file, status: 'passed', assertionResults: [{ status: 'passed', title: 't' }] },
        ],
      }),
    );
    const r = await validateAtom({ kind: 'test-run', path: 'report.json' }, root);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codeName).toBe('E_WORKSPACE_STALE_DIST');
    expect(!r.ok && r.reason).toContain('pnpm --filter "@x/lib" run build');
  });
});
