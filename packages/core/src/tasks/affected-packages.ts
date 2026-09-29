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

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isCiDocumentPath } from '../release/ci-evidence.js';
import type { ResolvedToolCommand } from './tool-resolver.js';

/** One workspace package. */
export interface WorkspacePackage {
  /** `package.json` name. */
  name: string;
  /** Directory relative to the workspace root (`packages/core`). */
  dir: string;
  /** Names of OTHER workspace packages it depends on. */
  deps: string[];
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
  const found: Array<{ name: string; dir: string; all: string[] }> = [];
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
      found.push({ name: pkg.name, dir: relative(root, join(root, dir)), all });
    } catch {
      // not a package
    }
  }
  const names = new Set(found.map((p) => p.name));
  return found.map(({ name, dir, all }) => ({
    name,
    dir,
    deps: [...new Set(all.filter((d) => names.has(d) && d !== name))],
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
  for (const path of changedPaths) {
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

/**
 * Ask vitest which projects the workspace config resolves to (T12635 review).
 *
 * Runs the workspace's OWN vitest (resolved from `root`) in a child process and
 * reads `createVitest(...).projects`, so globs, inline project objects,
 * unnamed projects and every future config shape are named exactly as
 * `--project` will match them. No config parsing happens here.
 *
 * @param root - Workspace root.
 * @returns The projects, or the reason they could not be resolved.
 * @task T12635
 */
export function listVitestProjects(
  root: string,
): { ok: true; projects: VitestProject[] } | { ok: false; reason: string } {
  const script = [
    "const { createVitest } = await import('vitest/node');",
    "const v = await createVitest('test', { watch: false }, {}, {});",
    'const out = v.projects.map((p) => ({ name: p.name, root: p.config.root }));',
    'await v.close();',
    `process.stdout.write('\\n${VITEST_PROJECTS_MARK}' + JSON.stringify(out) + '\\n');`,
    'process.exit(0);',
  ].join('\n');
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    return {
      ok: false,
      reason: `vitest could not resolve its projects in ${root}: ${stderr.trim().slice(-300) || String(err)}`,
    };
  }
  const line = stdout.split('\n').find((l) => l.startsWith(VITEST_PROJECTS_MARK));
  try {
    const parsed = JSON.parse(line?.slice(VITEST_PROJECTS_MARK.length) ?? '') as Array<{
      name: unknown;
      root: unknown;
    }>;
    const projects = parsed.map((p) => {
      if (typeof p.name !== 'string' || typeof p.root !== 'string') throw new Error('bad entry');
      return { name: p.name, dir: relative(root, p.root) };
    });
    return { ok: true, projects };
  } catch {
    return { ok: false, reason: `vitest returned no readable project list in ${root}` };
  }
}

/** Test targets for an affected run, or why only a full run is safe. */
export type AffectedTestTargets =
  | { ok: true; projects: string[]; untested: string[] }
  | { ok: false; reason: string };

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
export function affectedTestTargets(
  root: string,
  packages: readonly string[],
  direct: readonly string[],
  resolve: (root: string) => ReturnType<typeof listVitestProjects> = listVitestProjects,
): AffectedTestTargets {
  const resolved = resolve(root);
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
 * Expand a `testing.affectedCommand` template into a spawnable command.
 * `{projects}` → `--project <name>` per package, `{filters}` → `--filter
 * <name>` per package, `{packages}` → the names. Each expands to separate
 * arguments; the template is split on whitespace (no shell).
 *
 * @param template - e.g. `pnpm exec vitest run {projects}`.
 * @param packages - Affected package names.
 * @returns The executable and its arguments.
 * @task T12635
 */
export function buildAffectedTestCommand(
  template: string,
  packages: readonly string[],
  projects: readonly string[] = packages,
): { cmd: string; args: string[] } {
  const words = template.trim().split(/\s+/).filter(Boolean);
  const expanded = words.flatMap((word) => {
    if (word === '{projects}') return projects.flatMap((p) => ['--project', p]);
    if (word === '{filters}') return packages.flatMap((p) => ['--filter', p]);
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
 * Paths the tree under test changed relative to origin's default branch:
 * committed (`merge-base(origin/<default>, HEAD)..HEAD`) plus uncommitted
 * tracked edits — the tests run on the working tree, so both matter.
 *
 * @param root - Execution root.
 * @returns The paths, or null when no origin default branch exists.
 * @task T12635
 */
export function changedPathsSinceDefault(root: string): string[] | null {
  const symbolic = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const base =
    symbolic?.replace(/^refs\/remotes\//, '') ??
    ['origin/main', 'origin/master'].find(
      (ref) => git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`]) !== null,
    );
  if (!base) return null;
  const mergeBase = git(root, ['merge-base', base, 'HEAD']);
  if (!mergeBase) return null;
  const committed = git(root, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']) ?? '';
  const uncommitted = git(root, ['diff', '--name-only', '--no-renames', 'HEAD']) ?? '';
  return [...new Set(`${committed}\n${uncommitted}`.split('\n').filter(Boolean))].sort();
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
    }
  | {
      ok: false;
      /** `E_EVIDENCE_TOOL_UNAVAILABLE` when unconfigured, else `E_EVIDENCE_INSUFFICIENT`. */
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE' | 'E_EVIDENCE_INSUFFICIENT';
      reason: string;
    };

/**
 * Plan the affected-scope test run for the tree at `root` — the one path both
 * `tool:test-affected` validation and `cleo done` planning use. Fails closed:
 * no template, no origin default branch, a workspace-wide change, an empty
 * set, or unresolvable test projects each refuse the scope.
 *
 * @param storeRoot - CLEO store root (project context).
 * @param root - Execution root whose diff defines the set.
 * @returns The command and its receipt fields, or the refusal reason.
 * @task T12635
 */
export async function planAffectedTestRun(
  storeRoot: string,
  root: string,
): Promise<AffectedTestRun> {
  const { readRawProjectContext } = await import('./tool-resolver.js');
  const testing = (
    readRawProjectContext(storeRoot) as { testing?: { affectedCommand?: unknown } } | null
  )?.testing;
  const template = typeof testing?.affectedCommand === 'string' ? testing.affectedCommand : '';
  if (template.trim() === '') {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_UNAVAILABLE',
      reason:
        'tool:test-affected needs testing.affectedCommand in .cleo/project-context.json, e.g. ' +
        '"pnpm exec vitest run {projects}" ({projects}/{filters}/{packages} expand per package).',
    };
  }
  const changed = changedPathsSinceDefault(root);
  if (changed === null) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
      reason: `tool:test-affected cannot find origin's default branch in ${root} to diff against; use tool:test.`,
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
  let projects = scope.packages;
  let untested: string[] = [];
  if (template.split(/\s+/).includes('{projects}')) {
    const targets = affectedTestTargets(root, scope.packages, scope.direct);
    if (!targets.ok)
      return {
        ok: false,
        codeName: 'E_EVIDENCE_INSUFFICIENT',
        reason: `${targets.reason}; use tool:test.`,
      };
    projects = targets.projects;
    untested = targets.untested;
  }
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
  };
}
