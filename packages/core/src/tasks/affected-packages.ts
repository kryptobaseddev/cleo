/**
 * Affected-package test scope (owner decision D11150).
 *
 * Before merge, a test run limited to the workspace packages a branch diff
 * touches — plus every package that depends on them, transitively — counts for
 * `testsPassed`, recorded as `scope: 'affected'`. After merge, merged CI
 * (`ci:<pr>`, D11149) or a full run supersedes it.
 *
 * The set is derived deterministically:
 *  - each changed path maps to the workspace package whose directory holds it;
 *  - documentation outside the code roots is ignored;
 *  - CLEO-owned config (`.cleo/project-context.json`, `.cleo/config.json`) is
 *    judged by `tool:config-schema`, never by tests, so it is set aside as
 *    `cleoConfig` instead of widening the scope (T13779);
 *  - any other path outside every package (lockfile, root `package.json`,
 *    workspace/build/test config, `scripts/`, `.github/`) can affect every
 *    package, so the scope becomes `full` and a full run is required —
 *    unless the consumer checks or runs files (`outsideTests`, T13754): then
 *    a path below a top-level directory owes every test file outside every
 *    package under that directory, and only a repo-root file or a top-level
 *    directory with no test file stays `full`;
 *  - the dependents closure follows `dependencies`, `devDependencies`,
 *    `peerDependencies` and `optionalDependencies` between workspace packages.
 *
 * With `{projects}`, vitest itself names the projects to select; anything it
 * cannot resolve, or a changed package no project tests, refuses the scope
 * (fail closed: a full run, never a narrower one).
 *
 * @task T12635
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, matchesGlob, relative } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { originDefaultMergeBase } from '../git/base-ref.js';
import { pushWarning } from '../output.js';
import { isCiDocumentPath, readCiSatisfies } from '../release/ci-evidence.js';
import { LIGHT_FOOTPRINT_BYTES } from '../resources/admission-ledger.js';
import type { MergeVerdict } from './affected-scope.js';
import { type AffectedTemplate, resolveAffectedTemplate } from './affected-template.js';
import { splitCommandLine } from './command-line.js';
import {
  parseRawProjectContext,
  type ResolvedToolCommand,
  readRawProjectContext,
} from './tool-resolver.js';
import { AdmissionTimeoutError, acquireGlobalSlot, type ReleaseSlotFn } from './tool-semaphore.js';

/**
 * A path with `/` separators. `path.relative` and Windows callers produce `\`,
 * while package directories and git paths are compared with `/` (T12657).
 * Module-local: package-dir matching only, not a general path primitive.
 */
function slashSeparated(path: string): string {
  return path.replace(/\\/g, '/');
}

/** One workspace package. */
export interface WorkspacePackage {
  /** `package.json` name. */
  name: string;
  /** Directory relative to the workspace root (`packages/core`). */
  dir: string;
  /** Names of OTHER workspace packages it depends on. */
  deps: string[];
  /** Declares a `scripts.test`, so `{filters}`/`{packages}` runs test it. */
  hasTestScript: boolean;
}

/** The affected set, or the reason only a full run will do. */
export type AffectedScope =
  | {
      scope: 'affected';
      direct: string[];
      packages: string[];
      /**
       * Test files outside every workspace package a covering run must pass,
       * when `outsideTests` narrowed non-workspace paths (T13754).
       */
      outsideTests?: string[];
      /**
       * Changed CLEO-owned config files (T13779): judged by `tool:config-schema`,
       * never by a test run, so they do not widen the scope. Evidence that
       * leaves them to config-schema records them as `configPaths`.
       */
      cleoConfig?: string[];
    }
  | { scope: 'full'; reason: string };

/** A test file, by the names vitest, jest and node:test pick up. */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Workspace package patterns from `pnpm-workspace.yaml`, else
 * `package.json#workspaces`; null when neither declares a workspace (a
 * standalone single-package project, T13403).
 */
function workspacePatterns(root: string): string[] | null {
  const yaml = join(root, 'pnpm-workspace.yaml');
  if (existsSync(yaml)) {
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of readFileSync(yaml, 'utf-8').split('\n')) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const item = inPackages ? line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/) : null;
      if (item?.[1]) patterns.push(item[1]);
    }
    return patterns;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      workspaces?: unknown;
    };
    if (pkg.workspaces === undefined) return null;
    const ws = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(ws) ? ws.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Directories the workspace patterns name: each include expanded
 * ({@link expandPattern}), minus every directory a `!` exclusion matches
 * (T14047), as pnpm and npm/yarn workspaces apply them.
 */
function workspaceDirs(root: string, patterns: readonly string[]): string[] {
  const excludes = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => p.slice(1).replace(/^\.\//, '').replace(/\/$/, ''));
  const dirs = patterns.filter((p) => !p.startsWith('!')).flatMap((p) => expandPattern(root, p));
  return [...new Set(dirs)].filter((dir) => !excludes.some((ex) => matchesGlob(dir, ex)));
}

/** Directories an include pattern names: `dir/*` (one level) or an exact directory. */
function expandPattern(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/$/, '');
  if (clean.endsWith('/*') && !clean.slice(0, -2).includes('*')) {
    const parent = clean.slice(0, -2);
    try {
      return readdirSync(join(root, parent), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${parent}/${e.name}`);
    } catch {
      return [];
    }
  }
  return clean.includes('*') ? [] : [clean];
}

/**
 * Whether `path` lies in the package directory `dir`. The root package of a
 * standalone project (`dir === ''`, T13403) holds every path inside the root.
 *
 * @param path - Root-relative path, `/` separators.
 * @param dir - Package directory relative to the root (`''` for the root itself).
 * @returns True when the package directory holds the path.
 * @task T13403
 */
export function inPackageDir(path: string, dir: string): boolean {
  if (dir === '') {
    return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  }
  return path === dir || path.startsWith(`${dir}/`);
}

/** A package's manifest fields, before workspace-internal deps are resolved. */
interface ManifestEntry {
  name: string;
  dir: string;
  all: string[];
  hasTestScript: boolean;
}

/** The `package.json` in `dir` (relative to `root`), or null when it is not a package. */
function readManifest(root: string, dir: string): ManifestEntry | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    if (typeof pkg.name !== 'string') return null;
    const all = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].flatMap((field) => Object.keys((pkg[field] as Record<string, unknown>) ?? {}));
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    return {
      name: pkg.name,
      dir: slashSeparated(relative(root, join(root, dir))),
      all,
      hasTestScript: typeof scripts['test'] === 'string' && scripts['test'].trim() !== '',
    };
  } catch {
    return null; // not a package
  }
}

/**
 * The workspace's packages and their workspace-internal dependencies.
 *
 * A project that declares no workspace (no `pnpm-workspace.yaml`, no
 * `package.json#workspaces`) is one package: its root `package.json`, with
 * `dir` `''` (T13403). Only when `root` is its git checkout's top level, since
 * changed paths are spelled relative to that top level; a root in a
 * subdirectory keeps no packages, so every change there stays `full`.
 *
 * @param root - Workspace root (the git checkout).
 * @returns Every package with a readable `package.json` name.
 * @task T12635
 * @task T13403
 */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const patterns = workspacePatterns(root);
  if (patterns === null) {
    const standalone = git(root, ['rev-parse', '--show-prefix']) ? null : readManifest(root, '');
    return standalone === null
      ? []
      : [{ name: standalone.name, dir: '', deps: [], hasTestScript: standalone.hasTestScript }];
  }
  const found = workspaceDirs(root, patterns).flatMap((dir) => readManifest(root, dir) ?? []);
  const names = new Set(found.map((p) => p.name));
  return found.map(({ name, dir, all, hasTestScript }) => ({
    name,
    dir,
    deps: [...new Set(all.filter((d) => names.has(d) && d !== name))],
    hasTestScript,
  }));
}

/**
 * The root package of a standalone (non-workspace) project, or null in a
 * workspace or when the root has no named `package.json` (T13403).
 *
 * @param root - Project root (the git checkout).
 * @returns The single root package, or null.
 * @task T13403
 */
export function standalonePackage(root: string): WorkspacePackage | null {
  const packages = listWorkspacePackages(root);
  return packages.length === 1 && packages[0]?.dir === '' ? packages[0] : null;
}

/**
 * Known-inert files besides documentation: editor and dependency-bot settings
 * nothing builds, tests, lints, runs or deploys. An allowlist, so an unknown
 * config (CI, deploy, hooks, `.cleo/` evidence rules) stays code (T13745).
 * shortcut: a fixed list; widen it only with a file no tool reads.
 */
const INERT_PATH =
  /^(?:renovate\.json5?|\.editorconfig|\.(?:vscode|idea|zed)\/.+|[^/]+\.code-workspace)$/;

/**
 * Whether a changed path is non-code (T13745): documentation
 * ({@link isCiDocumentPath}) or a known-inert editor or bot setting
 * (renovate, .editorconfig, .vscode/, .idea/, .zed/). Everything else is code.
 *
 * @param path - Repo-relative changed path.
 * @returns True when no build, test, lint, CI or deploy reads the path.
 * @task T13745
 */
export function isNonCodePath(path: string): boolean {
  const p = slashSeparated(path);
  return isCiDocumentPath(p) || INERT_PATH.test(p);
}

/** CLEO-owned config files and the CLEO schema each is validated against (T13758). */
const CLEO_CONFIG_SCHEMAS: Readonly<Record<string, string>> = {
  '.cleo/project-context.json': 'project-context.schema.json',
  '.cleo/config.json': 'config.schema.json',
};

/**
 * The CLEO schema a CLEO-owned config file is validated against, or null for
 * any other path (T13758). CLEO is these files' consumer, so its schema check
 * is a real, targeted test of a change to them.
 *
 * @param path - Repo-relative changed path.
 * @returns The schema file name, or null.
 * @task T13758
 */
export function cleoConfigSchemaFor(path: string): string | null {
  return CLEO_CONFIG_SCHEMAS[slashSeparated(path)] ?? null;
}

/**
 * Whether a change set is non-empty and made only of CLEO-owned config files
 * ({@link cleoConfigSchemaFor}); any other path removes the route (T13758).
 *
 * @param paths - The change's repo-relative paths.
 * @returns True for a CLEO-config-only change.
 * @task T13758
 */
export function isCleoConfigOnlyChange(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((p) => cleoConfigSchemaFor(p) !== null);
}

/**
 * Whether a change set is non-empty and made only of {@link isNonCodePath}
 * paths: no test reads it and no TypeScript changed (T13745).
 *
 * @param paths - The change's repo-relative paths.
 * @returns True for a non-code-only change.
 * @task T13745
 */
export function isNonCodeOnlyChange(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isNonCodePath);
}

/**
 * The test files a run must pass to speak for non-workspace paths (T13754),
 * or the paths nothing narrower than the whole suite can speak for.
 *
 * A path in a subdirectory is owned by its TOP-LEVEL directory and owes
 * every test file outside every package under it (tracked, or one the change
 * adds). Not the nearest directory with tests: `tooling/shared/util.mjs` is
 * also read by `tooling/bridge/*.test.mjs`, and a trivial test beside the
 * changed file must not narrow the run past them. A repo-root file
 * (lockfile, root config) or a top-level directory with no test file has no
 * owner and stays workspace-wide.
 * shortcut: a package importing a non-workspace module is not followed
 * (T13767); a run of that directory's tests is taken to speak for it, as the
 * CI path filters of a repo do.
 */
function outsideTestFiles(
  root: string,
  paths: readonly string[],
  packages: readonly WorkspacePackage[],
): { files: string[] } | { unscoped: string[] } {
  const tracked = (git(root, ['ls-files', '--', '*.test.*', '*.spec.*']) ?? '').split('\n');
  const added = paths.filter((f) => existsSync(join(root, f)));
  const tests = [...new Set([...tracked, ...added])].filter(
    (f) => TEST_FILE.test(f) && !packages.some((p) => p.dir !== '' && inPackageDir(f, p.dir)),
  );
  const files = new Set<string>();
  const unscoped: string[] = [];
  for (const path of paths) {
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : null;
    const owned = top === null ? [] : tests.filter((f) => inPackageDir(f, top));
    if (owned.length === 0) unscoped.push(path);
    for (const f of owned) files.add(f);
  }
  return unscoped.length > 0 ? { unscoped } : { files: [...files].sort() };
}

/**
 * `seeds` plus every workspace package that depends on one, transitively,
 * through declared workspace dependencies.
 *
 * @param packages - The workspace packages.
 * @param seeds - Package names to start from.
 * @returns The closure, seeds included.
 * @task T12635
 * @task T13783
 */
export function dependentsClosure(
  packages: readonly WorkspacePackage[],
  seeds: Iterable<string>,
): Set<string> {
  const affected = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of packages) {
      if (!affected.has(p.name) && p.deps.some((d) => affected.has(d))) {
        affected.add(p.name);
        grew = true;
      }
    }
  }
  return affected;
}

/** Paths no explicit typecheck-only declaration matches all of. */
const CATCH_ALL_PROBES: readonly string[] = ['a', 'x/y/z.ts'];

/**
 * The changed workspace packages whose every changed non-test path matches a
 * glob of `evidence.typecheckOnlyDependents` on the default branch (T13783): a
 * regenerated client (`lib/api-zod/**`) or declared seed/data files
 * (`lib/db/src/seed-data/**`, T13786). Edited test files are left out of the
 * judgement; the report must run them. A
 * package depending on the change only through these owes a typecheck, not
 * a test file. Read from the merge-base copy only, so a change cannot
 * declare its own globs; never inferred from names.
 *
 * @param root - Execution root.
 * @param changed - Root-relative changed paths.
 * @param workspace - Workspace packages, longest directory first.
 * @returns The package names.
 * @task T13783
 * @task T13786
 */
export function typecheckOnlyPackages(
  root: string,
  changed: readonly string[],
  workspace: readonly WorkspacePackage[],
): Set<string> {
  const mergeBase = originDefaultMergeBase(root);
  const declared = mergeBase
    ? declaredEvidencePatterns(root, mergeBase, 'typecheckOnlyDependents')
    : [];
  // A glob matching every path declares nothing: it would exempt every dependent.
  const catchAll = declared.filter((g) => CATCH_ALL_PROBES.every((p) => matchesGlob(p, g)));
  if (catchAll.length > 0)
    pushWarning({
      // @sync-invariant none:input-shape a warning on a declared glob; nothing is refused or written
      code: 'W_TYPECHECK_ONLY_CATCH_ALL',
      severity: 'warn',
      message: `evidence.typecheckOnlyDependents ignores catch-all glob(s) ${catchAll.join(', ')}: name the generated or data paths explicitly.`,
    });
  const globs = declared.filter((g) => !catchAll.includes(g));
  const matched = new Map<string, boolean>();
  if (globs.length === 0) return new Set();
  for (const path of changed.map(slashSeparated)) {
    // T13786: a test file edited beside the data cannot change what dependents
    // compile or run; it is owed to the report instead (every edited test file).
    if (TEST_FILE.test(path)) continue;
    const owner = workspace.find((p) => p.dir !== '' && inPackageDir(path, p.dir));
    if (!owner) continue;
    const matches = globs.some((g) => g === path || matchesGlob(path, g));
    matched.set(owner.name, (matched.get(owner.name) ?? true) && matches);
  }
  return new Set([...matched].filter(([, all]) => all).map(([name]) => name));
}

/**
 * Derive the affected-package set for a diff.
 *
 * @param root - Workspace root.
 * @param changedPaths - Repo-relative changed paths.
 * @param opts - `outsideTests`: narrow a non-workspace path to the test files
 *   of its directory ({@link AffectedScope} `outsideTests`) instead of the
 *   whole workspace, for consumers that check or run those files (T13754).
 *   CLEO-owned config files never widen the scope; they are returned as
 *   `cleoConfig` for `tool:config-schema` to judge (T13779).
 * @returns The directly changed packages plus their transitive dependents, or
 *   `full` naming the paths that affect the whole workspace.
 * @task T12635
 * @task T13754
 * @task T13779
 */
export function deriveAffectedPackages(
  root: string,
  changedPaths: readonly string[],
  opts: { outsideTests?: boolean } = {},
): AffectedScope {
  const packages = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const direct = new Set<string>();
  const workspaceWide: string[] = [];
  const cleoConfig: string[] = [];
  for (const path of changedPaths.map(slashSeparated)) {
    // T13779: CLEO's own config is judged by tool:config-schema, not by tests.
    if (cleoConfigSchemaFor(path) !== null) {
      cleoConfig.push(path);
      continue;
    }
    // A standalone root package holds every path, but docs stay ignored there
    // as they are outside the packages of a workspace (T13403).
    const owner = packages.find(
      (p) => inPackageDir(path, p.dir) && (p.dir !== '' || !isCiDocumentPath(path)),
    );
    if (owner) direct.add(owner.name);
    else if (!isCiDocumentPath(path)) workspaceWide.push(path);
  }
  let outsideTests: string[] | undefined;
  if (workspaceWide.length > 0) {
    const outside = opts.outsideTests ? outsideTestFiles(root, workspaceWide, packages) : null;
    if (outside === null || 'unscoped' in outside) {
      return {
        scope: 'full',
        reason: `outside every workspace package, so every package may be affected: ${(outside?.unscoped ?? workspaceWide).join(', ')}`,
      };
    }
    outsideTests = outside.files;
  }
  const affected = dependentsClosure(packages, direct);
  return {
    scope: 'affected',
    direct: [...direct].sort(),
    packages: [...affected].sort(),
    ...(outsideTests ? { outsideTests } : {}),
    ...(cleoConfig.length > 0 ? { cleoConfig } : {}),
  };
}

/** A vitest project as vitest itself resolves it: its name and root directory. */
export interface VitestProject {
  /** The name `--project` matches (vitest's own: `test.name`, else package.json name, else basename). */
  name: string;
  /** Project root relative to the workspace root (`''` for the root itself). */
  dir: string;
}

/** Marker that separates the resolver's JSON line from vite's own stdout noise. */
const VITEST_PROJECTS_MARK = '__CLEO_VITEST_PROJECTS__';

/** Vitest's resolved projects, or why they could not be resolved. */
export type VitestProjectsResult =
  | { ok: true; projects: VitestProject[] }
  | {
      ok: false;
      reason: string;
      /** Admission refused it now and the caller would not wait (T12656 review, T13133). */
      busy?: true;
    };

/**
 * The report a caller that will not wait gets while the machine budget is in
 * use (T13133: the admission ledger replaced the `test` slot).
 */
export const TEST_SLOT_BUSY = 'scope pending: the machine budget is in use';

/** The report a caller that will not wait gets while memory pressure refuses heavy work. */
export const MEMORY_PRESSURE_BUSY = 'scope pending: memory pressure';

/** Options for {@link listVitestProjects}. */
export interface ListVitestProjectsOptions {
  /** Admission (tests inject; defaults to the admission ledger as a light `test` run). */
  acquireSlot?: (canonical: 'test') => Promise<ReleaseSlotFn>;
  /**
   * Queue for admission (true: `cleo done`, about to run tests anyway), or
   * take it only if admitted now (false: `--plan`, which never waits — a
   * refusal reports {@link TEST_SLOT_BUSY} or {@link MEMORY_PRESSURE_BUSY}).
   * Default false.
   */
  wait?: boolean;
}

/** Resolutions keyed by tree state, so plan + record in one `cleo done` resolve once. */
const vitestProjectsMemo = new Map<string, Promise<VitestProjectsResult>>();

/**
 * Key for the tree's current state, or null outside git: HEAD, the tracked
 * diff, and each untracked file's path, size and mtime — `status` alone names
 * an untracked file but misses edits to it (T12656 review).
 */
function treeStateKey(root: string): string | null {
  const head = git(root, ['rev-parse', 'HEAD']);
  const diff = git(root, ['diff', 'HEAD']);
  const untracked = untrackedChangePaths(root);
  if (head === null || diff === null || untracked === null) return null;
  const hash = createHash('sha256').update(diff);
  for (const path of untracked) {
    try {
      const st = statSync(join(root, path));
      hash.update(`\0${path}\0${st.size}\0${st.mtimeMs}`);
    } catch {
      hash.update(`\0${path}\0gone`);
    }
  }
  return `${root}\0${head}\0${hash.digest('hex')}`;
}

/**
 * Ask vitest which projects the workspace config resolves to (T12635 review).
 *
 * Runs the workspace's OWN vitest (resolved from `root`) in a child process and
 * reads `createVitest(...).projects`, so globs, inline project objects,
 * unnamed projects and every future config shape are named exactly as
 * `--project` will match them. No config parsing happens here.
 *
 * The child runs asynchronously under machine-wide admission as a light `test`
 * run (loading a workspace's configs is test tooling, but one small process),
 * and results are memoized per tree state, so `cleo done` planning and
 * recording resolve once (T12657, T13133).
 *
 * @param root - Workspace root.
 * @param opts - Slot acquisition override.
 * @returns The projects, or the reason they could not be resolved.
 * @task T12635
 * @task T12657
 */
export function listVitestProjects(
  root: string,
  opts: ListVitestProjectsOptions = {},
): Promise<VitestProjectsResult> {
  const key = treeStateKey(root);
  const hit = key === null ? undefined : vitestProjectsMemo.get(key);
  if (hit) return hit;
  // Loading a workspace's vitest configs is one small process: it asks the
  // admission ledger for a light footprint, not a whole test run's (T13133).
  const acquire =
    opts.acquireSlot ??
    (opts.wait === true
      ? (canonical: 'test') =>
          acquireGlobalSlot(canonical, { footprintBytes: LIGHT_FOOTPRINT_BYTES })
      : (canonical: 'test') =>
          acquireGlobalSlot(canonical, {
            footprintBytes: LIGHT_FOOTPRINT_BYTES,
            timeoutMs: 0,
          }));
  const pending = resolveVitestProjects(root, acquire);
  if (key !== null) {
    vitestProjectsMemo.set(key, pending);
    // A busy slot is not an answer about the tree: never remember it.
    void pending.then((r) => {
      if (!r.ok && r.busy) vitestProjectsMemo.delete(key);
    });
  }
  return pending;
}

async function resolveVitestProjects(
  root: string,
  acquireSlot: (canonical: 'test') => Promise<ReleaseSlotFn>,
): Promise<VitestProjectsResult> {
  const script = [
    "const { createVitest } = await import('vitest/node');",
    "const v = await createVitest('test', { watch: false }, {}, {});",
    'const out = v.projects.map((p) => ({ name: p.name, root: p.config.root }));',
    'await v.close();',
    `process.stdout.write('\\n${VITEST_PROJECTS_MARK}' + JSON.stringify(out) + '\\n');`,
    'process.exit(0);',
  ].join('\n');
  let stdout: string;
  let release: ReleaseSlotFn;
  try {
    release = await acquireSlot('test');
  } catch (err) {
    // Pressure is reported as pressure, not as a busy budget.
    const pressure = err instanceof AdmissionTimeoutError && err.refusal.memoryPressure !== null;
    return { ok: false, busy: true, reason: pressure ? MEMORY_PRESSURE_BUSY : TEST_SLOT_BUSY };
  }
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: root, encoding: 'utf-8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    return {
      ok: false,
      reason: `vitest could not resolve its projects in ${root}: ${stderr.trim().slice(-300) || String(err)}`,
    };
  } finally {
    await release();
  }
  const line = stdout.split('\n').find((l) => l.startsWith(VITEST_PROJECTS_MARK));
  try {
    const parsed = JSON.parse(line?.slice(VITEST_PROJECTS_MARK.length) ?? '') as Array<{
      name: unknown;
      root: unknown;
    }>;
    const projects = parsed.map((p) => {
      if (typeof p.name !== 'string' || typeof p.root !== 'string') throw new Error('bad entry');
      return { name: p.name, dir: slashSeparated(relative(root, p.root)) };
    });
    return { ok: true, projects };
  } catch {
    return { ok: false, reason: `vitest returned no readable project list in ${root}` };
  }
}

/** Test targets for an affected run, or why only a full run is safe. */
export type AffectedTestTargets =
  | { ok: true; projects: string[]; untested: string[] }
  | { ok: false; reason: string; busy?: true };

/**
 * The vitest projects an affected run must select (T12635 review).
 *
 * Fails CLOSED: anything that cannot be resolved yields `ok: false`, so the
 * caller runs the full suite, never a narrower one.
 *
 * - Projects come from vitest itself ({@link listVitestProjects}); a project
 *   covers a package when vitest names it after the package, or its root is
 *   the package directory.
 * - Every project that covers NO workspace package (e.g. the root `scripts`
 *   project, whose tests read live package files such as templates and skills)
 *   is always appended, since no package dependency edge reaches it.
 * - A DIRECTLY changed package with no project refuses the affected scope;
 *   an affected dependent with none is reported in `untested`.
 *
 * @param root - Workspace root.
 * @param packages - Affected package names (direct plus dependents).
 * @param direct - The directly changed packages.
 * @param resolve - Project resolver (vitest by default).
 * @returns Project names to run and the dependents that have none, or a refusal.
 * @task T12635
 */
export async function affectedTestTargets(
  root: string,
  packages: readonly string[],
  direct: readonly string[],
  resolve: (root: string) => Promise<VitestProjectsResult> = listVitestProjects,
): Promise<AffectedTestTargets> {
  const resolved = await resolve(root);
  if (!resolved.ok) return resolved;
  const workspace = listWorkspacePackages(root);
  const covers = (project: VitestProject, pkg: WorkspacePackage): boolean =>
    project.name === pkg.name || project.dir === pkg.dir;
  const selected: string[] = [];
  const untested: string[] = [];
  for (const name of packages) {
    const pkg = workspace.find((p) => p.name === name);
    const project = pkg
      ? (resolved.projects.find((p) => p.name === pkg.name) ??
        resolved.projects.find((p) => covers(p, pkg)))
      : undefined;
    if (project) {
      if (!selected.includes(project.name)) selected.push(project.name);
    } else untested.push(name);
  }
  const uncovered = direct.filter((name) => untested.includes(name));
  if (uncovered.length > 0) {
    return {
      ok: false,
      reason: `no vitest project runs the tests of changed package(s) ${uncovered.join(', ')}`,
    };
  }
  for (const project of resolved.projects) {
    if (!workspace.some((pkg) => covers(project, pkg)) && !selected.includes(project.name))
      selected.push(project.name);
  }
  return { ok: true, projects: selected, untested };
}

/**
 * The packages a `{filters}`/`{packages}` run tests (T12657): a package with no
 * `scripts.test` runs nothing. A DIRECTLY changed one refuses the affected
 * scope; an affected dependent with none is reported in `untested`.
 *
 * @param root - Workspace root.
 * @param packages - Affected package names (direct plus dependents).
 * @param direct - The directly changed packages.
 * @returns The packages to pass and the dependents with no test script, or a refusal.
 * @task T12657
 */
export function scriptTestTargets(
  root: string,
  packages: readonly string[],
  direct: readonly string[],
): AffectedTestTargets {
  const workspace = listWorkspacePackages(root);
  const untested = packages.filter(
    (name) => workspace.find((p) => p.name === name)?.hasTestScript !== true,
  );
  const uncovered = direct.filter((name) => untested.includes(name));
  if (uncovered.length > 0) {
    return {
      ok: false,
      reason: `no test script in changed package(s) ${uncovered.join(', ')}`,
    };
  }
  return { ok: true, projects: [...packages], untested };
}

/**
 * Expand a `testing.affectedCommand` template into a spawnable command.
 * `{projects}` → `--project <name>` per package, `{filters}` → `--filter
 * <name>` per package, `{workspaces}` → `--workspace <name>` per package (npm,
 * T13125), `{packages}` → the names. Each expands to separate arguments. The template is split with POSIX `sh` quoting and run without a
 * shell, so shell syntax (`&&`, `|`, `$`, …) is refused rather than passed to
 * the target as literal words, which could run a different program and
 * false-PASS (T12718).
 *
 * @param template - e.g. `pnpm exec vitest run {projects}`.
 * @param packages - Affected package names.
 * @returns The executable and its arguments.
 * @throws When the template uses shell syntax or has an unterminated quote.
 * @task T12635
 */
export function buildAffectedTestCommand(
  template: string,
  packages: readonly string[],
  projects: readonly string[] = packages,
): { cmd: string; args: string[] } {
  const words = splitCommandLine(template, 'testing.affectedCommand');
  const expanded = words.flatMap((word) => {
    if (word === '{projects}') return projects.flatMap((p) => ['--project', p]);
    if (word === '{filters}') return packages.flatMap((p) => ['--filter', p]);
    if (word === '{workspaces}') return packages.flatMap((p) => ['--workspace', p]);
    if (word === '{packages}') return [...packages];
    return [word];
  });
  return { cmd: expanded[0] ?? '', args: expanded.slice(1) };
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The checkout's own untracked, not-ignored files, or null when git fails
 * (T14052). Nothing inside a nested repository or linked worktree counts: git
 * lists a nested checkout it recognises as one `dir/` entry, and descends into
 * one whose `.git` file it cannot resolve (`.worktrees/x/.npmrc`), so both are
 * dropped — any path below a directory (under the root) holding a `.git` file
 * or directory belongs to that other checkout, not to this change.
 *
 * @param root - Execution root; the listed paths are relative to it.
 * @returns Root-relative untracked file paths.
 * @task T14052
 */
function untrackedChangePaths(root: string): string[] | null {
  const listed = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (listed === null) return null;
  const nested = new Map<string, boolean>();
  const isNestedCheckout = (dir: string): boolean => {
    let hit = nested.get(dir);
    if (hit === undefined) {
      hit = existsSync(join(root, dir, '.git'));
      nested.set(dir, hit);
    }
    return hit;
  };
  return listed.split('\n').filter((path) => {
    if (path === '' || path.endsWith('/')) return false;
    const parts = slashSeparated(path).split('/');
    for (let i = 1; i < parts.length; i++) {
      if (isNestedCheckout(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

// T14007: one home for origin's default branch (git/base-ref.ts); re-exported for callers.
export { originDefaultMergeBase };

/**
 * Files CLEO itself writes into a project for its harness hooks (T12983,
 * T13124): never part of a change's scope, tracked or not. A hand-installed
 * `.opencode/plugins/cleo-heavy-command.js` that no task touched made every
 * change in an opencode project "workspace-wide" and forced a full suite
 * (gh#1805).
 *
 * @task T13135
 */
export const CLEO_MANAGED_SCOPE_EXCLUDES: readonly string[] = Object.freeze([
  '.claude/settings.local.json',
  '.codex/hooks.json',
  '.opencode/plugins/cleo-heavy-command.js',
]);

/**
 * A string-list key of the project's `evidence` block, read from the
 * MERGE-BASE version of `.cleo/project-context.json` (`git show
 * <mergeBase>:…`) — never the working copy. A change could otherwise declare
 * its own patterns and drop its own code from evidence (review of #1823); a
 * pattern counts only once it is on the default branch.
 *
 * @param root - Execution root (the CLEO root of the checkout).
 * @param mergeBase - `merge-base(origin/<default>, HEAD)`.
 * @param key - `scopeExcludes` (T13135), `runtimePaths` (T13554) or
 *   `typecheckOnlyDependents` (T13783).
 * @returns The declared patterns; none when the file or key is absent there.
 * @task T13554
 */
export function declaredEvidencePatterns(
  root: string,
  mergeBase: string,
  key: 'scopeExcludes' | 'runtimePaths' | 'typecheckOnlyDependents',
): string[] {
  const raw = git(root, ['show', `${mergeBase}:./.cleo/project-context.json`]);
  const evidence = raw === null ? null : parseRawProjectContext(raw)?.['evidence'];
  const declared =
    evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)[key]
      : undefined;
  return Array.isArray(declared)
    ? declared.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
}

/**
 * The project context evidence reads its commands from (review of #2302): the
 * default-branch (merge-base) copy of `.cleo/project-context.json` whenever
 * the working copy differs from it, so a change cannot relax the test, lint
 * or typecheck commands that judge it; the working copy otherwise. A tracked
 * file the default branch lacks yields none (the change added it).
 *
 * @param storeRoot - CLEO store root (holds the working copy).
 * @param root - Execution root (the git checkout).
 * @returns The context to read commands from, or null.
 * @task T13779
 */
export function evidenceProjectContext(
  storeRoot: string,
  root: string,
): Record<string, unknown> | null {
  const working = readRawProjectContext(storeRoot);
  const mergeBase = originDefaultMergeBase(root);
  if (!mergeBase) return working;
  const raw = git(root, ['show', `${mergeBase}:./.cleo/project-context.json`]);
  if (raw === null) {
    const tracked = git(root, ['ls-files', '--', '.cleo/project-context.json']);
    return tracked ? null : working;
  }
  const base = parseRawProjectContext(raw);
  return isDeepStrictEqual(base, working) ? working : base;
}

/**
 * The project's declared `evidence.scopeExcludes` ({@link declaredEvidencePatterns}).
 *
 * @param root - Execution root (the CLEO root of the checkout).
 * @param mergeBase - `merge-base(origin/<default>, HEAD)`.
 * @returns The declared patterns; none when the file or key is absent there.
 * @task T13135
 */
export function declaredScopeExcludes(root: string, mergeBase: string): string[] {
  return declaredEvidencePatterns(root, mergeBase, 'scopeExcludes');
}

/** The project context file: a declared exclude never removes it from scope. */
const PROJECT_CONTEXT_PATH = '.cleo/project-context.json';

/**
 * Whether a root-relative path is out of evidence scope: one of
 * {@link CLEO_MANAGED_SCOPE_EXCLUDES}, or a match for a declared pattern (exact
 * path, or `path.matchesGlob` with `**` crossing directories). A declared
 * pattern never removes `.cleo/project-context.json` or a path inside a
 * workspace package — code always stays in scope (review of #1823).
 *
 * @param rel - Path relative to the CLEO root, `/` separators.
 * @param declared - From {@link declaredScopeExcludes}.
 * @param packageDirs - Workspace package directories, relative to the root.
 * @returns `true` when the path never counts as part of a change.
 * @task T13135
 */
export function isScopeExcluded(
  rel: string,
  declared: readonly string[],
  packageDirs: readonly string[],
): boolean {
  if (CLEO_MANAGED_SCOPE_EXCLUDES.includes(rel)) return true;
  if (rel === PROJECT_CONTEXT_PATH) return false;
  if (packageDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return false;
  return declared.some((pattern) => pattern === rel || matchesGlob(rel, pattern));
}

/**
 * Built-in session-state directories: an untracked file under one is never
 * part of a change (T13780). Everything else is declared through
 * `evidence.scopeExcludes`, never by a blanket dot-directory rule.
 */
const UNTRACKED_STATE_DIRS: readonly string[] = ['.cleo/rcasd/', '.claude/'];

/** The changed paths evidence scoping counts, and the ones it set aside. */
export interface ScopedChangedPaths {
  /** Paths that count, as {@link changedPathsSinceDefault} returns them. */
  readonly paths: string[];
  /** Changed paths set aside as out of scope (managed hook files, declared excludes). */
  readonly excluded: string[];
  /**
   * With `narrowUntracked` (T14000): untracked files outside every directory
   * the tracked change touches — another agent's work in a shared checkout,
   * not this change. Evidence records them so `cleo complete` can refuse it
   * once one of them is committed. Empty otherwise.
   */
  readonly untrackedSetAside: string[];
}

/**
 * The most untracked files a binding sets aside (T14000, review of #2426).
 * Above it the run is not narrowed: every untracked file counts, as before,
 * so an atom never carries thousands of paths.
 */
export const MAX_UNTRACKED_SET_ASIDE = 500;

/**
 * Whether an untracked path lies in a directory the tracked change touches
 * (T14000): under the directory of a changed path, or at the root next to a
 * changed root-level path.
 */
function nearTrackedChange(path: string, dirs: ReadonlySet<string>): boolean {
  const at = path.lastIndexOf('/');
  if (at < 0) return dirs.has('');
  for (const dir of dirs) {
    if (dir !== '' && (path === dir || path.startsWith(`${dir}/`))) return true;
  }
  return false;
}

/**
 * Paths the tree under test changed relative to origin's default branch:
 * committed (`merge-base(origin/<default>, HEAD)..HEAD`), uncommitted tracked
 * edits and untracked files — the tests run on the working tree, so all matter
 * — split into the ones that count and the ones set aside as out of scope
 * ({@link isScopeExcluded}, T13135).
 *
 * An untracked file that is tool or session state is not the change at all
 * (T13780): one under {@link UNTRACKED_STATE_DIRS} (`.cleo/rcasd/`,
 * `.claude/`), or one the default branch's `evidence.scopeExcludes` matches
 * (this repo declares `.opencode/**`). Every other untracked file counts,
 * whatever directory holds it (`.github/`, `.husky/`): a file a later commit
 * adds keeps the same tree hash, so leaving it out of scope would let
 * evidence recorded before the commit skip it (review of #2302).
 *
 * Excludes are anchored at the CLEO root: diff paths are relative to the git
 * top level, so a CLEO root in a subdirectory strips its prefix before
 * matching; untracked paths are already root-relative.
 *
 * With `narrowUntracked` (T14000, the test-run and qa-run bindings), an
 * untracked file counts only when it lies in a directory the tracked change
 * touches ({@link nearTrackedChange}); the rest is returned as
 * `untrackedSetAside`, so a shared dirty checkout cannot refuse a run the
 * plan asked for, and the binding records what it left out. More than
 * {@link MAX_UNTRACKED_SET_ASIDE} such files are not set aside at all.
 *
 * @param root - Execution root.
 * @param opts - `narrowUntracked` for the bindings (T14000).
 * @returns The split, or null when no origin default branch exists or git fails.
 * @task T12635
 * @task T13135
 */
export function scopedChangedPaths(
  root: string,
  opts: { readonly narrowUntracked?: boolean } = {},
): ScopedChangedPaths | null {
  const mergeBase = originDefaultMergeBase(root);
  if (!mergeBase) return null;
  // A git failure is not an empty diff (T12657): no answer, so no scoped run.
  const committed = git(root, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']);
  const uncommitted = git(root, ['diff', '--name-only', '--no-renames', 'HEAD']);
  const untracked = untrackedChangePaths(root);
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (committed === null || uncommitted === null || untracked === null || prefix === null) {
    return null;
  }
  const declared = declaredScopeExcludes(root, mergeBase);
  // A standalone root package (`dir` '') holds every path; declared excludes
  // still apply there, as they did before it was a package (T13403).
  const packageDirs = listWorkspacePackages(root)
    .map((p) => p.dir)
    .filter((dir) => dir !== '');
  const out = (path: string, anchor: string): boolean => {
    const slashed = slashSeparated(path);
    if (!slashed.startsWith(anchor)) return false; // outside the CLEO root
    return isScopeExcluded(slashed.slice(anchor.length), declared, packageDirs);
  };
  const lines = (text: string): string[] => text.split('\n').filter(Boolean);
  const paths = new Set<string>();
  const excluded = new Set<string>();
  const setAside = new Set<string>();
  for (const path of [...lines(committed), ...lines(uncommitted)]) {
    (out(path, prefix) ? excluded : paths).add(path);
  }
  const trackedDirs = new Set(
    [...paths].map((p) => {
      const slashed = slashSeparated(p);
      const at = slashed.lastIndexOf('/');
      return at < 0 ? '' : slashed.slice(0, at);
    }),
  );
  for (const path of untracked) {
    const rel = slashSeparated(path);
    if (UNTRACKED_STATE_DIRS.some((dir) => rel.startsWith(dir))) continue;
    // Declared or managed state: never package code (isScopeExcluded refuses those).
    if (isScopeExcluded(rel, declared, packageDirs)) continue;
    if (opts.narrowUntracked === true && !nearTrackedChange(slashSeparated(path), trackedDirs)) {
      setAside.add(path);
      continue;
    }
    paths.add(path);
  }
  // Too many to record: judge them all, as an un-narrowed run does.
  if (setAside.size > MAX_UNTRACKED_SET_ASIDE) {
    for (const path of setAside) paths.add(path);
    setAside.clear();
  }
  return {
    paths: [...paths].sort(),
    excluded: [...excluded].sort(),
    untrackedSetAside: [...setAside].sort(),
  };
}

/**
 * Paths the tree under test changed relative to origin's default branch that
 * count for evidence scope: {@link scopedChangedPaths}' `paths`.
 *
 * @param root - Execution root.
 * @returns The paths (committed, uncommitted and untracked), or null when no
 *   origin default branch exists or git fails.
 * @task T12635
 * @task T13135
 */
export function changedPathsSinceDefault(root: string): string[] | null {
  return scopedChangedPaths(root)?.paths ?? null;
}

/** A planned affected-scope run, or why only the full suite will do. */
export type AffectedTestRun =
  | {
      ok: true;
      /** Canonical `test`, so it shares `tool:test`'s caps and cache discipline. */
      command: ResolvedToolCommand;
      /** Affected packages (direct plus dependents). */
      packages: string[];
      /** Test projects the run selects (with `{projects}`; else the packages). */
      projects: string[];
      /** Affected dependents with no test project. */
      untested: string[];
      /** The template the command came from, declared or derived (T13125). */
      template: AffectedTemplate;
      /** Test files outside every package the run names, for a non-workspace change (T13754). */
      testFiles?: string[];
      /** Changed CLEO config the run leaves to `tool:config-schema` (T13779). */
      configPaths?: string[];
    }
  | {
      ok: false;
      /** `E_EVIDENCE_TOOL_UNAVAILABLE` when unconfigured, else `E_EVIDENCE_INSUFFICIENT`. */
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE' | 'E_EVIDENCE_INSUFFICIENT';
      reason: string;
      /** The scope is not refused, only unresolved yet: the `test` slot was busy. */
      pending?: true;
    };

/**
 * Plan the affected-scope test run for the tree at `root` — the one path both
 * `tool:test-affected` validation and `cleo done` planning use. Fails closed:
 * no template, no origin default branch, a workspace-wide change, an empty
 * set, or unresolvable test projects each refuse the scope.
 *
 * @param storeRoot - CLEO store root (project context).
 * @param root - Execution root whose diff defines the set.
 * @param opts - `wait`: queue for the `test` slot (`cleo done`); `--plan` does not.
 * @returns The command and its receipt fields, or the refusal reason.
 * @task T12635
 */
export async function planAffectedTestRun(
  storeRoot: string,
  root: string,
  opts: { wait?: boolean } = {},
): Promise<AffectedTestRun> {
  const testing = (
    evidenceProjectContext(storeRoot, root) as {
      testing?: { affectedCommand?: unknown; command?: unknown };
    } | null
  )?.testing;
  // T13125: a declared template, else one derived from testing.command.
  const resolved = resolveAffectedTemplate(testing, root);
  if (resolved === null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
      reason:
        'tool:test-affected needs testing.affectedCommand in .cleo/project-context.json, e.g. ' +
        '"pnpm exec vitest run {projects}" ({projects}/{filters}/{workspaces}/{packages} expand per ' +
        'package); none could be derived from testing.command.',
    };
  }
  const template = resolved.template;
  // T12718: a template the runner cannot split without a shell is a config
  // error, refused before anything runs — never a pass for a truncated argv.
  let templateWords: string[];
  try {
    templateWords = splitCommandLine(template, 'testing.affectedCommand');
  } catch (error) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
      reason: `${error instanceof Error ? error.message : String(error)} (.cleo/project-context.json)`,
    };
  }
  const changed = changedPathsSinceDefault(root);
  if (changed === null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `tool:test-affected cannot diff ${root} against origin's default branch (none found, or git failed); use tool:test.`,
    };
  }
  // T13403: a standalone project's one package is the whole project, so an
  // affected run would be the whole suite under another command; tool:test
  // keeps running testing.command, as before the root became a package.
  if (standalonePackage(root) !== null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        'This single-package project is its one package, so an affected run is the whole suite; ' +
        'use tool:test, or a test-run: report of the changed test files.',
    };
  }
  const scope = deriveAffectedPackages(root, changed, { outsideTests: true });
  if (scope.scope === 'full') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `The change touches paths ${scope.reason}. Run the full suite: tool:test.`,
    };
  }
  const outside = scope.outsideTests ?? [];
  const config = scope.cleoConfig ? { configPaths: scope.cleoConfig } : {};
  if (outside.length > 0) {
    // T13754: one affected command cannot both select packages and name files.
    if (scope.packages.length > 0) {
      return {
        ok: false,
        codeName: 'E_EVIDENCE_INSUFFICIENT',
        reason:
          `The change touches workspace package(s) ${scope.packages.join(', ')} and test files ` +
          `outside every package (${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}). ` +
          'Record a test-run: report that runs those files and a test file of each affected package',
      };
    }
    // With a vitest template the files replace {projects}, so the repo's own
    // config collects them (an uncollectable file fails the run); otherwise
    // node's built-in runner, the one every Node project has.
    const { cmd, args } = templateWords.includes('{projects}')
      ? {
          cmd: templateWords[0]!,
          args: templateWords.slice(1).flatMap((w) => (w === '{projects}' ? outside : [w])),
        }
      : { cmd: 'node', args: ['--test', ...outside] };
    return {
      ok: true,
      command: {
        canonical: 'test',
        displayName: 'test-affected',
        cmd,
        args,
        source: 'project-context',
      },
      packages: [],
      projects: [],
      untested: [],
      template: resolved,
      testFiles: outside,
      ...config,
    };
  }
  if (scope.packages.length === 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: scope.cleoConfig
        ? `The change touches no workspace package, only CLEO config (${scope.cleoConfig.join(', ')}); use tool:config-schema.`
        : 'The change touches no workspace package, so there is nothing to test by scope; use tool:test.',
    };
  }
  const targets = templateWords.includes('{projects}')
    ? await affectedTestTargets(root, scope.packages, scope.direct, (r) =>
        listVitestProjects(r, { wait: opts.wait === true }),
      )
    : scriptTestTargets(root, scope.packages, scope.direct);
  if (!targets.ok) {
    return targets.busy
      ? { ok: false, codeName: 'E_EVIDENCE_INSUFFICIENT', reason: targets.reason, pending: true }
      : {
          ok: false,
          codeName: 'E_EVIDENCE_INSUFFICIENT',
          reason: `${targets.reason}; use tool:test.`,
        };
  }
  const { projects, untested } = targets;
  const { cmd, args } = buildAffectedTestCommand(template, scope.packages, projects);
  return {
    ok: true,
    command: {
      canonical: 'test',
      displayName: 'test-affected',
      cmd,
      args,
      source: 'project-context',
    },
    packages: scope.packages,
    projects,
    untested,
    template: resolved,
    ...config,
  };
}

/**
 * Why a scope-aware `tool:test` runs the whole suite when no affected template
 * is declared or derivable (T13125), naming `ci:<pr>` as the preferred
 * `testsPassed` evidence when the project accepts it.
 *
 * @param storeRoot - CLEO store root (project context).
 * @returns The reason recorded on the `tool` atom.
 * @task T13125
 */
export function wholeSuiteReason(storeRoot: string): string {
  const base =
    'no testing.affectedCommand is declared and none can be derived from testing.command, so ' +
    'every tool:test runs the whole suite (cleo doctor proposes one where it can)';
  return readCiSatisfies(storeRoot)
    ? `${base}; evidence.ciSatisfies is set, so ci:<pr> (the merged PR's CI) is the preferred testsPassed evidence`
    : base;
}

/** How a scope-aware `tool:test` will run (T12959). */
export type ScopedTestRun =
  | {
      /** Only the affected packages and their dependents. */
      scope: 'affected';
      /** The planned affected run. */
      run: Extract<AffectedTestRun, { ok: true }>;
    }
  | {
      /** The whole suite (`testing.command`). */
      scope: 'full';
      /** Why the affected scope was not used ({@link wholeSuiteReason} when none exists). */
      reason: string | null;
    }
  | {
      /** Unresolved: the `test` slot was busy while listing test projects. */
      scope: 'pending';
      /** The planner's reason. */
      reason: string;
    };

/**
 * Decide how `tool:test` runs (T12959): the affected packages first whenever
 * an affected template is declared (`testing.affectedCommand`) or derivable
 * from `testing.command` (T13125), the full suite only when that scope cannot
 * be trusted. Full when the project opts out (`testing.preferAffected:
 * false`), has no template, or the change is not known to be unmerged (a scoped run counts before merge only, D11150);
 * otherwise whatever {@link planAffectedTestRun} decides, its refusal (root
 * config changed, no origin, nothing touched, …) becoming the full run's
 * recorded reason. An affected plan that would leave a dependent package
 * untested (no test project) also runs the full suite.
 *
 * @param storeRoot - CLEO store root (project context).
 * @param root - Execution root whose diff defines the set.
 * @param opts - `wait` queues for the `test` slot; `mergeState` resolves the
 *   task's merge state lazily, with why a lookup failed when one did (omitted
 *   when no task is in context).
 * @returns The scope and the plan, or why the full suite runs.
 * @example
 * ```ts
 * const plan = await planScopedTestRun(storeRoot, executionRoot, { wait: true });
 * if (plan.scope === 'affected') console.log(plan.run.packages);
 * ```
 * @task T12959
 */
export async function planScopedTestRun(
  storeRoot: string,
  root: string,
  opts: { wait?: boolean; mergeState?: () => Promise<MergeVerdict> } = {},
): Promise<ScopedTestRun> {
  const testing = (
    evidenceProjectContext(storeRoot, root) as {
      testing?: { affectedCommand?: unknown; command?: unknown; preferAffected?: unknown };
    } | null
  )?.testing;
  // T13125: no declared template and none derivable is the one case that
  // runs the whole suite on every verify; the reason says so and names the way
  // out, so the atom and `cleo done --plan` show it instead of staying silent.
  if (resolveAffectedTemplate(testing, root) === null) {
    return { scope: 'full', reason: wholeSuiteReason(storeRoot) };
  }
  if (testing?.preferAffected === false) {
    return { scope: 'full', reason: 'testing.preferAffected is false' };
  }
  if (opts.mergeState) {
    const { state, lookupFailed } = await opts.mergeState();
    if (state !== 'unmerged') {
      return {
        scope: 'full',
        reason:
          state === 'merged'
            ? 'the change has merged; an affected run counts before merge only'
            : `whether the change has merged cannot be determined (${lookupFailed ?? 'gh unreachable'}); an affected run counts before merge only`,
      };
    }
  }
  const run = await planAffectedTestRun(storeRoot, root, { wait: opts.wait === true });
  // T12959 review: an affected dependent with no test project would go
  // untested — the canonical tool:test fails closed to the full suite.
  if (run.ok && run.untested.length > 0) {
    return {
      scope: 'full',
      reason: `affected dependent package(s) ${run.untested.join(', ')} have no test project; an affected run would leave them untested`,
    };
  }
  if (run.ok) return { scope: 'affected', run };
  if (run.pending) return { scope: 'pending', reason: run.reason };
  return { scope: 'full', reason: run.reason };
}
