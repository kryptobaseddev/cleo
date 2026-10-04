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
 *  - any other path outside every package (lockfile, root `package.json`,
 *    workspace/build/test config, `scripts/`, `.github/`) can affect every
 *    package, so the scope becomes `full` and a full run is required;
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
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { isCiDocumentPath, readCiSatisfies } from '../release/ci-evidence.js';
import type { MergeVerdict } from './affected-scope.js';
import { type AffectedTemplate, resolveAffectedTemplate } from './affected-template.js';
import { splitCommandLine } from './command-line.js';
import type { ResolvedToolCommand } from './tool-resolver.js';
import { acquireGlobalSlot, type ReleaseSlotFn } from './tool-semaphore.js';

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
  | { scope: 'affected'; direct: string[]; packages: string[] }
  | { scope: 'full'; reason: string };

/** Workspace package patterns from `pnpm-workspace.yaml`, else `package.json#workspaces`. */
function workspacePatterns(root: string): string[] {
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
    const ws = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(ws) ? ws.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/** Directories a pattern names: `dir/*` (one level) or an exact directory. */
function expandPattern(root: string, pattern: string): string[] {
  if (pattern.startsWith('!')) return [];
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
 * The workspace's packages and their workspace-internal dependencies.
 *
 * @param root - Workspace root (the git checkout).
 * @returns Every package with a readable `package.json` name.
 * @task T12635
 */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const found: Array<{ name: string; dir: string; all: string[]; hasTestScript: boolean }> = [];
  for (const dir of workspacePatterns(root).flatMap((p) => expandPattern(root, p))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      if (typeof pkg.name !== 'string') continue;
      const all = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].flatMap((field) => Object.keys((pkg[field] as Record<string, unknown>) ?? {}));
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      found.push({
        name: pkg.name,
        dir: slashSeparated(relative(root, join(root, dir))),
        all,
        hasTestScript: typeof scripts['test'] === 'string' && scripts['test'].trim() !== '',
      });
    } catch {
      // not a package
    }
  }
  const names = new Set(found.map((p) => p.name));
  return found.map(({ name, dir, all, hasTestScript }) => ({
    name,
    dir,
    deps: [...new Set(all.filter((d) => names.has(d) && d !== name))],
    hasTestScript,
  }));
}

/**
 * Derive the affected-package set for a diff.
 *
 * @param root - Workspace root.
 * @param changedPaths - Repo-relative changed paths.
 * @returns The directly changed packages plus their transitive dependents, or
 *   `full` naming the paths that affect the whole workspace.
 * @task T12635
 */
export function deriveAffectedPackages(
  root: string,
  changedPaths: readonly string[],
): AffectedScope {
  const packages = listWorkspacePackages(root).sort((a, b) => b.dir.length - a.dir.length);
  const direct = new Set<string>();
  const workspaceWide: string[] = [];
  for (const path of changedPaths.map(slashSeparated)) {
    const owner = packages.find((p) => path === p.dir || path.startsWith(`${p.dir}/`));
    if (owner) direct.add(owner.name);
    else if (!isCiDocumentPath(path)) workspaceWide.push(path);
  }
  if (workspaceWide.length > 0) {
    return {
      scope: 'full',
      reason: `outside every workspace package, so every package may be affected: ${workspaceWide.join(', ')}`,
    };
  }
  const affected = new Set(direct);
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
  return { scope: 'affected', direct: [...direct].sort(), packages: [...affected].sort() };
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
      /** The `test` slot was busy and the caller would not wait (T12656 review). */
      busy?: true;
    };

/** The report a caller that will not wait gets while the `test` slot is held. */
export const TEST_SLOT_BUSY = 'scope pending: test slot busy';

/** Options for {@link listVitestProjects}. */
export interface ListVitestProjectsOptions {
  /** Heavy-tool slot acquisition (tests inject; defaults to the global `test` semaphore). */
  acquireSlot?: (canonical: 'test') => Promise<ReleaseSlotFn>;
  /**
   * Queue for the `test` slot (true: `cleo done`, about to run tests anyway),
   * or take it only if free now (false: `--plan`, which never waits — a held
   * slot reports {@link TEST_SLOT_BUSY}). Default false.
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
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (head === null || diff === null || untracked === null) return null;
  const hash = createHash('sha256').update(diff);
  for (const path of untracked.split('\n').filter(Boolean)) {
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
 * The child runs asynchronously under the heavy-tool `test` semaphore (loading
 * a workspace's configs is test tooling), and results are memoized per tree
 * state, so `cleo done` planning and recording resolve once (T12657).
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
  const acquire =
    opts.acquireSlot ??
    (opts.wait === true
      ? acquireGlobalSlot
      : (canonical: 'test') => acquireGlobalSlot(canonical, { timeoutMs: 1, pollMs: 1 }));
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
  } catch {
    return { ok: false, busy: true, reason: TEST_SLOT_BUSY };
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
 * The merge-base of HEAD and origin's default branch — where the branch's own
 * commits begin.
 *
 * @param root - Execution root.
 * @returns The merge-base commit, or null when no origin default branch
 *   exists or git fails.
 * @task T12965
 */
export function originDefaultMergeBase(root: string): string | null {
  const symbolic = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const base =
    symbolic?.replace(/^refs\/remotes\//, '') ??
    ['origin/main', 'origin/master'].find(
      (ref) => git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]) !== null,
    );
  return base ? git(root, ['merge-base', base, 'HEAD']) || null : null;
}

/**
 * Paths the tree under test changed relative to origin's default branch:
 * committed (`merge-base(origin/<default>, HEAD)..HEAD`), uncommitted tracked
 * edits and untracked files — the tests run on the working tree, so all matter.
 *
 * @param root - Execution root.
 * @returns The paths (committed, uncommitted and untracked), or null when no
 *   origin default branch exists or git fails.
 * @task T12635
 */
export function changedPathsSinceDefault(root: string): string[] | null {
  const mergeBase = originDefaultMergeBase(root);
  if (!mergeBase) return null;
  // A git failure is not an empty diff (T12657): no answer, so no scoped run.
  const committed = git(root, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']);
  const uncommitted = git(root, ['diff', '--name-only', '--no-renames', 'HEAD']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (committed === null || uncommitted === null || untracked === null) return null;
  return [
    ...new Set(`${committed}\n${uncommitted}\n${untracked}`.split('\n').filter(Boolean)),
  ].sort();
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
  const { readRawProjectContext } = await import('./tool-resolver.js');
  const testing = (
    readRawProjectContext(storeRoot) as {
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
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `The change touches paths ${scope.reason}. Run the full suite: tool:test.`,
    };
  }
  if (scope.packages.length === 0) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason:
        'The change touches no workspace package, so there is nothing to test by scope; use tool:test.',
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
  const { readRawProjectContext } = await import('./tool-resolver.js');
  const testing = (
    readRawProjectContext(storeRoot) as {
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
