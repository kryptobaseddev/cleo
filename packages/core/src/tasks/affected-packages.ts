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
): { cmd: string; args: string[] } {
  const words = template.trim().split(/\s+/).filter(Boolean);
  const expanded = words.flatMap((word) => {
    if (word === '{projects}') return packages.flatMap((p) => ['--project', p]);
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

/**
 * The affected-scope test command for the tree at `root`, when the project
 * declares `testing.affectedCommand` and the diff has a non-empty affected set.
 * Canonical `test`, so it shares `tool:test`'s caps and cache discipline.
 *
 * @param storeRoot - CLEO store root (project context).
 * @param root - Execution root whose diff defines the set.
 * @returns The command and the packages, or null when a scoped run does not apply.
 * @task T12635
 */
export async function resolveAffectedTestCommand(
  storeRoot: string,
  root: string,
): Promise<{ command: ResolvedToolCommand; packages: string[] } | null> {
  const { readRawProjectContext } = await import('./tool-resolver.js');
  const testing = (
    readRawProjectContext(storeRoot) as { testing?: { affectedCommand?: unknown } } | null
  )?.testing;
  const template = typeof testing?.affectedCommand === 'string' ? testing.affectedCommand : '';
  if (template.trim() === '') return null;
  const changed = changedPathsSinceDefault(root);
  if (changed === null) return null;
  const scope = deriveAffectedPackages(root, changed);
  if (scope.scope === 'full' || scope.packages.length === 0) return null;
  const { cmd, args } = buildAffectedTestCommand(template, scope.packages);
  return {
    command: {
      canonical: 'test',
      displayName: 'test-affected',
      cmd,
      args,
      source: 'project-context',
    },
    packages: scope.packages,
  };
}
