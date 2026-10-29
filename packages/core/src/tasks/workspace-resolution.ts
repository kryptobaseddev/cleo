/**
 * Whether a test run in a checkout tests that checkout's own workspace
 * packages (T14097).
 *
 * A worktree whose `node_modules` is a symlink to another checkout's resolves
 * `@scope/pkg` to THAT checkout's `packages/pkg/dist`, built from other source.
 * Its tests then exercise code that is not the tree under test, and a
 * `test-run:` receipt would bind to it. Observed: `done-plan.test.ts` in an
 * evidence worktree at main gave 51 false failures (`isCleoProvisionedWorktree
 * is not a function`) because `@cleocode/worktree` loaded the root checkout's
 * older build.
 *
 * Two findings, of different strength:
 *
 * - **Foreign resolution** — a workspace dependency whose real path is not this
 *   checkout's package directory and whose committed source differs from this
 *   checkout's (or either side has uncommitted changes). Precise; test runs and
 *   receipts refuse it. A provisioned worktree that shares the root checkout's
 *   `node_modules` while both hold the same clean source for that package is
 *   only warned about (`borrowed`): the build it loads is of identical source.
 * - **Stale dist** — a package whose build stamp records a hash of other
 *   source than its tracked `src/` holds now. The build writes the stamp
 *   ({@link writeSourceStamps}); file mtimes are no evidence, since a checkout
 *   or branch switch rewrites them without changing content. A dist without a
 *   stamp, or rebuilt after its stamp, cannot be judged and is not reported.
 *   Test runs and receipts refuse it (T14123).
 *
 * @module tasks/workspace-resolution
 * @task T14097
 * @task T14123
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { discoveryEnv } from '../git/work-tree.js';
import { inPackageDir, listWorkspacePackages, TEST_FILE } from './affected-packages.js';

/** A workspace dependency that resolves into another checkout. */
export interface ForeignResolution {
  /** The package doing the import. */
  readonly importer: string;
  /** The workspace dependency it imports. */
  readonly dependency: string;
  /** Where Node resolves it (real path). */
  readonly resolved: string;
  /** Where this checkout's own copy lives (real path). */
  readonly expected: string;
}

/** A workspace package whose build was made from other source than it holds now. */
export interface StaleDist {
  /** The package. */
  readonly package: string;
  /** Its directory, relative to the checkout root. */
  readonly dir: string;
}

/**
 * The build stamp in a package's `dist/`, written by {@link writeSourceStamps}.
 * Its bytes depend on the source alone, so a published package carries the
 * same stamp from any build of the same source (T14123). A `dist/` file newer
 * than the stamp file means a rebuild without a stamp.
 */
export interface SourceStamp {
  /** Stamp format version. */
  readonly schema: 2;
  /** {@link sourceHash} of the package's tracked non-test `src/` files at build time. */
  readonly sourceHash: string;
}

/** File name of the build stamp inside a package's `dist/`. */
export const SOURCE_STAMP_FILE = '.source-stamp.json';

/** Result of {@link checkWorkspaceResolution}. */
export interface WorkspaceResolutionReport {
  /** The checkout root that was checked. */
  readonly root: string;
  /** Dependencies resolving outside this checkout to different source (refused). */
  readonly foreign: readonly ForeignResolution[];
  /**
   * Dependencies resolving outside this checkout to a package whose committed
   * source is identical and clean on both sides (warned): a provisioned
   * worktree sharing the root checkout's `node_modules` at the same commit.
   */
  readonly borrowed: readonly ForeignResolution[];
  /** Packages whose dist was built from other source (refused, T14123). */
  readonly staleDist: readonly StaleDist[];
}

/** Real path, or null when it does not exist. */
function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Newest mtime of any file under `dir` (recursively), or -1 when it holds none. */
function newestMtime(dir: string): number {
  let newest = -1;
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === SOURCE_STAMP_FILE) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * The committed tree of a package directory, or null when it has uncommitted
 * changes or git cannot tell (then it is never taken as identical).
 */
function cleanTreeOf(dir: string): string | null {
  const checkout = checkoutRootOf(dir);
  if (checkout === null) return null;
  const rel = relative(checkout, dir).split('\\').join('/');
  if (rel === '' || rel.startsWith('..')) return null;
  const git = (args: readonly string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: checkout,
        encoding: 'utf-8',
        env: discoveryEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const status = git(['status', '--porcelain', '--', rel]);
  if (status === null || status !== '') return null;
  return git(['rev-parse', `HEAD:${rel}`]);
}

/** Whether two package directories hold the same committed, clean source. */
function sameSource(a: string, b: string): boolean {
  const left = cleanTreeOf(a);
  return left !== null && left === cleanTreeOf(b);
}

/** Tracked non-test files under each `<dir>/src`, keyed by dir. */
function trackedSources(root: string, dirs: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(dirs.map((d) => [d, []]));
  if (dirs.length === 0) return out;
  let listed: string;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', ...dirs.map((d) => `${d}/src`)], {
      cwd: root,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return out;
  }
  for (const file of listed.split('\0')) {
    if (file === '' || TEST_FILE.test(file) || file.includes('/__tests__/')) continue;
    const dir = dirs.find((d) => file.startsWith(`${d}/src/`));
    if (dir !== undefined) out.get(dir)?.push(file);
  }
  return out;
}

/**
 * Content hash of source files: each file's path and the sha256 of its bytes,
 * in path order. Identical source gives the same hash in any checkout, at any
 * mtime.
 *
 * @param root - The checkout root the paths are relative to.
 * @param files - Source files, relative to `root`.
 * @returns The hex sha256.
 * @task T14097
 */
export function sourceHash(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, file));
    } catch {
      continue;
    }
    hash.update(`${file}\0${createHash('sha256').update(bytes).digest('hex')}\0`);
  }
  return hash.digest('hex');
}

/**
 * The build stamp in `distDir` and when it was written, or null when it is
 * missing, unreadable or of another schema (an older stamp is not judged).
 */
function readSourceStamp(distDir: string): { stamp: SourceStamp; writtenMs: number } | null {
  const path = join(distDir, SOURCE_STAMP_FILE);
  let stamp: Partial<SourceStamp> | null;
  let writtenMs: number;
  try {
    stamp = JSON.parse(readFileSync(path, 'utf-8'));
    writtenMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  return stamp?.schema === 2 && typeof stamp.sourceHash === 'string'
    ? { stamp: { schema: 2, sourceHash: stamp.sourceHash }, writtenMs }
    : null;
}

/**
 * Stamp every built workspace package of a checkout with the hash of the
 * source its `dist/` was built from. The root build runs it last, so
 * {@link checkWorkspaceResolution} can tell a build of other source from one
 * whose source a checkout merely touched.
 *
 * @param root - The checkout root.
 * @returns The package directories stamped.
 * @task T14097
 */
export function writeSourceStamps(root: string): string[] {
  const built = listWorkspacePackages(root).filter(
    (p) => p.dir !== '' && existsSync(join(root, p.dir, 'dist')),
  );
  const sources = trackedSources(
    root,
    built.map((p) => p.dir),
  );
  const stamped: string[] = [];
  for (const p of built) {
    const dist = join(root, p.dir, 'dist');
    const stamp: SourceStamp = {
      schema: 2,
      sourceHash: sourceHash(root, sources.get(p.dir) ?? []),
    };
    writeFileSync(join(dist, SOURCE_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
    stamped.push(p.dir);
  }
  return stamped;
}

/**
 * Check how a checkout's workspace packages resolve their workspace
 * dependencies, the way Node looks them up: the importer's own
 * `node_modules`, then the root's. A real path outside this checkout's copy
 * of the dependency is foreign. Of the dependencies that resolve in-tree,
 * those whose build stamp records other source than their tracked `src/` holds
 * are stale.
 *
 * A checkout that declares no workspace has nothing to check; a dependency
 * that resolves nowhere is left to the runner, which reports it itself.
 *
 * @param root - The checkout root (its git top level).
 * @param scope - Package names whose dependency closure is checked; all packages when omitted or empty.
 * @returns The foreign resolutions and stale builds found.
 * @task T14097
 */
export function checkWorkspaceResolution(
  root: string,
  scope?: readonly string[],
): WorkspaceResolutionReport {
  const packages = listWorkspacePackages(root).filter((p) => p.dir !== '');
  const byName = new Map(packages.map((p) => [p.name, p]));
  const importers =
    scope === undefined || scope.length === 0
      ? packages
      : packages.filter((p) => scope.includes(p.name));
  // The dependency closure of the importers: every package a test there loads.
  const closure = new Set<string>();
  const pending = importers.map((p) => p.name);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const dep of byName.get(name)?.deps ?? []) pending.push(dep);
  }
  const foreign: ForeignResolution[] = [];
  const borrowed: ForeignResolution[] = [];
  const inTree = new Set<string>();
  for (const name of closure) {
    const importer = byName.get(name);
    if (importer === undefined) continue;
    for (const dep of importer.deps) {
      const own = byName.get(dep);
      if (own === undefined) continue;
      const expected = real(join(root, own.dir));
      const resolved =
        real(join(root, importer.dir, 'node_modules', dep)) ??
        real(join(root, 'node_modules', dep));
      if (expected === null || resolved === null) continue;
      const entry = { importer: name, dependency: dep, resolved, expected };
      if (resolved === expected) inTree.add(dep);
      else if (sameSource(expected, resolved)) borrowed.push(entry);
      else foreign.push(entry);
    }
  }
  const candidates = [...inTree]
    .map((n) => byName.get(n))
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .filter((p) => existsSync(join(root, p.dir, 'dist')));
  const sources = trackedSources(
    root,
    candidates.map((p) => p.dir),
  );
  const staleDist: StaleDist[] = [];
  for (const p of candidates) {
    const read = readSourceStamp(join(root, p.dir, 'dist'));
    // No stamp, or a rebuild since it was written: nothing proves the build old.
    if (read === null || newestMtime(join(root, p.dir, 'dist')) > read.writtenMs) continue;
    if (sourceHash(root, sources.get(p.dir) ?? []) !== read.stamp.sourceHash)
      staleDist.push({ package: p.name, dir: p.dir });
  }
  return { root, foreign, borrowed, staleDist };
}

/**
 * The workspace packages a test command names through its test-file
 * arguments, so a run of one file checks only what that file loads. Empty
 * when it names none (the whole workspace is then checked).
 *
 * @param root - The checkout root.
 * @param cwd - The directory the command runs in.
 * @param argv - The command and its arguments.
 * @returns Names of the packages owning the named test files.
 * @task T14097
 */
export function packagesNamedByTestArgs(
  root: string,
  cwd: string,
  argv: readonly string[],
): string[] {
  const packages = listWorkspacePackages(root)
    .filter((p) => p.dir !== '')
    .sort((a, b) => b.dir.length - a.dir.length);
  const named = new Set<string>();
  for (const arg of argv) {
    if (!TEST_FILE.test(arg)) continue;
    const rel = relative(root, isAbsolute(arg) ? arg : resolve(cwd, arg))
      .split('\\')
      .join('/');
    const owner = packages.find((p) => inPackageDir(rel, p.dir));
    if (owner !== undefined) named.add(owner.name);
  }
  return [...named];
}

/**
 * The git top level of `dir`, or null outside a checkout.
 *
 * @param dir - Any directory.
 * @returns The checkout root, or null.
 */
export function checkoutRootOf(dir: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf-8',
        env: discoveryEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * {@link checkWorkspaceResolution} for a test command run in `cwd`: the
 * checkout around it, scoped to the packages its test-file arguments name.
 *
 * @param cwd - The directory the command runs in.
 * @param argv - The command and its arguments.
 * @returns The report, or null outside a checkout.
 * @task T14097
 */
export function workspaceResolutionForTestRun(
  cwd: string,
  argv: readonly string[],
): WorkspaceResolutionReport | null {
  const root = checkoutRootOf(cwd);
  return root === null
    ? null
    : checkWorkspaceResolution(root, packagesNamedByTestArgs(root, cwd, argv));
}

/** The remedy for a foreign resolution, in this checkout. */
function remedy(report: WorkspaceResolutionReport): string {
  const deps = [...new Set(report.foreign.map((f) => f.dependency))];
  return (
    `Give this checkout its own install and build: in ${report.root}, remove a symlinked ` +
    'node_modules, run `pnpm install --frozen-lockfile`, then build what the tests import ' +
    `(\`pnpm ${deps.map((d) => `--filter "${d}..."`).join(' ')} run build\`).`
  );
}

/**
 * One sentence naming the foreign resolutions, or null when there are none.
 *
 * @param report - A {@link checkWorkspaceResolution} result.
 * @returns The refusal reason, with its remedy.
 * @task T14097
 */
export function foreignResolutionReason(report: WorkspaceResolutionReport): string | null {
  if (report.foreign.length === 0) return null;
  const shown = report.foreign
    .slice(0, 3)
    .map(
      (f) =>
        `${f.dependency} (imported by ${f.importer}) resolves to ${f.resolved}, not ${f.expected}`,
    )
    .join('; ');
  const more = report.foreign.length > 3 ? `; … (${report.foreign.length} in all)` : '';
  return (
    `Workspace packages resolve outside this checkout, so its tests would run another ` +
    `checkout's build: ${shown}${more}. ${remedy(report)}`
  );
}

/** The rebuild command for stale builds. */
function staleRemedy(report: WorkspaceResolutionReport): string {
  return `Rebuild them: \`pnpm ${report.staleDist.map((s) => `--filter "${s.package}"`).join(' ')} run build\`.`;
}

/**
 * One sentence naming the packages whose dist was built from other source,
 * or null when there are none (T14123).
 *
 * @param report - A {@link checkWorkspaceResolution} result.
 * @returns The refusal reason, with the rebuild command.
 * @task T14123
 */
export function staleDistReason(report: WorkspaceResolutionReport): string | null {
  if (report.staleDist.length === 0) return null;
  const shown = report.staleDist
    .slice(0, 3)
    .map((s) => s.package)
    .join(', ');
  const more = report.staleDist.length > 3 ? `, … (${report.staleDist.length} in all)` : '';
  return (
    `The dist of ${shown}${more} was built from other source than ${report.staleDist.length === 1 ? 'it holds' : 'they hold'} ` +
    `now, so tests importing ${report.staleDist.length === 1 ? 'it' : 'them'} would run that build. ${staleRemedy(report)}`
  );
}

/**
 * The warning for a borrowed build (identical source in another checkout),
 * or null when there is none.
 *
 * @param report - A {@link checkWorkspaceResolution} result.
 * @returns The warning text.
 * @task T14097
 */
export function borrowedBuildWarning(report: WorkspaceResolutionReport): string | null {
  if (report.borrowed.length === 0) return null;
  return `${[...new Set(report.borrowed.map((b) => b.dependency))].join(', ')} resolve${report.borrowed.length === 1 ? 's' : ''} to another checkout (${report.borrowed[0]?.resolved}) whose source is identical; its build is used.`;
}

/**
 * The refusal for a test run in this checkout, foreign resolution first, or
 * null when the run may proceed.
 *
 * @param report - A {@link checkWorkspaceResolution} result.
 * @returns The error to throw or report.
 * @task T14123
 */
export function workspaceResolutionError(
  report: WorkspaceResolutionReport,
): ForeignWorkspaceResolutionError | StaleDistError | null {
  // @sync-invariant none:input-shape a test run against another checkout's build is refused before anything is written
  if (report.foreign.length > 0) return new ForeignWorkspaceResolutionError(report);
  // @sync-invariant none:input-shape a test run against a dist built from other source is refused before anything is written
  if (report.staleDist.length > 0) return new StaleDistError(report);
  return null;
}

/**
 * `cleo run --class test` refused: a workspace package resolves into another
 * checkout (T14097).
 *
 * @task T14097
 */
export class ForeignWorkspaceResolutionError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_WORKSPACE_FOREIGN_CHECKOUT';

  /**
   * @param report - The check that found foreign resolutions.
   */
  constructor(report: WorkspaceResolutionReport) {
    super(ExitCode.CONFIG_ERROR, foreignResolutionReason(report) ?? 'foreign resolution', {
      fix: remedy(report),
      details: {
        field: 'node_modules',
        expected: `workspace packages resolved inside ${report.root}`,
        actual: report.foreign.map((f) => `${f.dependency} -> ${f.resolved}`).join(', '),
        root: report.root,
        foreign: report.foreign,
      },
    });
    this.name = 'ForeignWorkspaceResolutionError';
  }
}

/**
 * `cleo run --class test` or a test-run receipt refused: a workspace package's
 * dist was built from other source than it holds (T14123).
 *
 * @task T14123
 */
export class StaleDistError extends CleoError {
  /** Stable machine-readable error code. */
  readonly codeName = 'E_WORKSPACE_STALE_DIST';

  /**
   * @param report - The check that found stale builds.
   */
  constructor(report: WorkspaceResolutionReport) {
    super(ExitCode.CONFIG_ERROR, staleDistReason(report) ?? 'stale dist', {
      fix: staleRemedy(report),
      details: {
        field: 'dist',
        expected: `dist built from the source ${report.root} holds`,
        actual: report.staleDist.map((s) => `${s.package} (${s.dir}/dist)`).join(', '),
        root: report.root,
        staleDist: report.staleDist,
      },
    });
    this.name = 'StaleDistError';
  }
}
