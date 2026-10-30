/**
 * Manifest-only workspace changes, scoped by the lockfile's importers (T14163,
 * owner decision 2026-10-30).
 *
 * A change to the root `package.json` or the lockfile is outside every
 * workspace package, so a targeted test-run cannot speak for it and only the
 * whole suite (or merged CI) can. A project with no required CI, whose
 * dependency bumps always touch the lockfile, was left with the whole suite.
 *
 * After the merge, such a change is scoped instead when nothing in it is
 * unattributable:
 *
 *  - the root `package.json` changed only its dependency fields;
 *  - every changed lockfile entry is an importer, or a package or snapshot
 *    reachable from a changed importer (before or after the change); any other
 *    lockfile change (settings, overrides, catalogs, an unreachable package)
 *    leaves the change workspace-wide;
 *  - each changed importer is a workspace package, or the root importer, which
 *    counts as every package.
 *
 * The change then stands for the changed packages plus the importers'
 * packages, each represented by its own `package.json`, so the usual targeted
 * rule (a passing test file in each, and in every dependent) applies. pnpm
 * lockfiles only; other lockfiles stay workspace-wide.
 *
 * @task T14163
 */

import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { listWorkspacePackages } from './affected-packages.js';

/** The root `package.json` fields a manifest-only change may touch. */
export const MANIFEST_DEPENDENCY_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** The lockfile this scoping reads. */
export const PNPM_LOCKFILE = 'pnpm-lock.yaml';

/** A manifest-only change, scoped to packages. */
export interface ManifestScope {
  /** Lockfile importers the change touched (`.` is the root, every package). */
  importers: string[];
  /** The change's paths with the root manifests replaced by each scoped package's `package.json`. */
  paths: string[];
}

/** A YAML or JSON mapping, read loosely. */
type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `git show <rev>:<path>`, or null when the file is absent there. */
function show(root: string, rev: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** A mapping parsed from `text`, `{}` when absent, or null when unreadable. */
function parseMapping(text: string | null, format: 'json' | 'yaml'): Mapping | null {
  if (text === null) return {};
  try {
    const value: unknown = format === 'json' ? JSON.parse(text) : parseYaml(text);
    return isMapping(value) ? value : null;
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Keys of two mappings whose values differ (added and removed included). */
function changedKeys(before: Mapping, after: Mapping): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => !same(before[k], after[k]),
  );
}

const mappingAt = (m: Mapping, key: string): Mapping => {
  const v = m[key];
  return isMapping(v) ? v : {};
};

/**
 * Whether two root `package.json` texts differ only in dependency fields.
 *
 * @param before - The manifest before the change, or null when absent.
 * @param after - The manifest after the change, or null when absent.
 * @returns True when every other field is unchanged.
 * @task T14163
 */
export function rootManifestDependencyOnly(before: string | null, after: string | null): boolean {
  const b = parseMapping(before, 'json');
  const a = parseMapping(after, 'json');
  if (b === null || a === null) return false;
  return changedKeys(b, a).every((k) => MANIFEST_DEPENDENCY_FIELDS.includes(k));
}

/** `name@version` keys an importer or snapshot names through its dependency sections. */
function dependencyKeys(entry: Mapping): string[] {
  const keys: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(mappingAt(entry, field))) {
      // Importers: { specifier, version }; snapshots: a version string.
      const version = isMapping(spec) ? spec.version : spec;
      if (typeof version === 'string' && !version.startsWith('link:'))
        keys.push(`${name}@${version}`);
    }
  }
  return keys;
}

/** A snapshot key without its peer suffix: `a@1.0.0(react@18.0.0)` → `a@1.0.0`. */
const packageKey = (key: string): string => key.replace(/\(.*$/, '');

/** Every package key reachable from the given importers through the snapshots. */
function reachable(lock: Mapping, importers: readonly string[]): Set<string> {
  const snapshots = mappingAt(lock, 'snapshots');
  const packages = mappingAt(lock, 'packages');
  const seen = new Set<string>();
  const pending = importers.flatMap((i) =>
    dependencyKeys(mappingAt(mappingAt(lock, 'importers'), i)),
  );
  while (pending.length > 0) {
    const key = pending.pop() ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    seen.add(packageKey(key));
    // Lockfile v9 keeps the graph in `snapshots`; older ones in `packages`.
    const node = isMapping(snapshots[key]) ? snapshots[key] : packages[key];
    if (isMapping(node)) pending.push(...dependencyKeys(node));
  }
  return seen;
}

/**
 * The importers a pnpm lockfile change touched, or null when part of it cannot
 * be attributed to a changed importer.
 *
 * @param before - Lockfile text before the change, or null when absent.
 * @param after - Lockfile text after the change, or null when absent.
 * @returns The changed importers (`.` is the root), or null.
 * @task T14163
 */
export function pnpmImporterChanges(
  before: string | null,
  after: string | null,
): { importers: string[] } | null {
  const b = parseMapping(before, 'yaml');
  const a = parseMapping(after, 'yaml');
  if (b === null || a === null) return null;
  // Settings, overrides, catalogs and the like reach every package.
  const graph = new Set(['importers', 'packages', 'snapshots']);
  if (changedKeys(b, a).some((k) => !graph.has(k))) return null;
  const importers = changedKeys(mappingAt(b, 'importers'), mappingAt(a, 'importers'));
  const covered = new Set([...reachable(b, importers), ...reachable(a, importers)]);
  for (const section of ['packages', 'snapshots']) {
    for (const key of changedKeys(mappingAt(b, section), mappingAt(a, section)))
      if (!covered.has(key) && !covered.has(packageKey(key))) return null;
  }
  return { importers };
}

/**
 * Scope a change whose only paths outside every workspace package are the
 * root `package.json` and the pnpm lockfile, comparing `base` with `head`.
 *
 * @param root - The checkout.
 * @param base - The commit before the change (the merge's first parent).
 * @param head - The commit with the change (the merge commit).
 * @param changed - The change's paths, relative to `root`.
 * @returns The scope, or null when the change stays workspace-wide.
 * @task T14163
 */
export function manifestScopedChange(
  root: string,
  base: string,
  head: string,
  changed: readonly string[],
): ManifestScope | null {
  const packages = listWorkspacePackages(root).filter((p) => p.dir !== '');
  if (packages.length === 0) return null;
  const inPackage = (path: string): boolean =>
    packages.some((p) => path === p.dir || path.startsWith(`${p.dir}/`));
  const outside = changed.filter((p) => !inPackage(p));
  if (outside.length === 0 || outside.some((p) => p !== 'package.json' && p !== PNPM_LOCKFILE))
    return null;
  if (
    outside.includes('package.json') &&
    !rootManifestDependencyOnly(show(root, base, 'package.json'), show(root, head, 'package.json'))
  )
    return null;
  let importers: string[] = [];
  if (outside.includes(PNPM_LOCKFILE)) {
    const lock = pnpmImporterChanges(
      show(root, base, PNPM_LOCKFILE),
      show(root, head, PNPM_LOCKFILE),
    );
    if (lock === null) return null;
    importers = lock.importers;
  }
  // The root's own dependencies reach every package, lockfile or not.
  if (outside.includes('package.json') && !importers.includes('.')) importers = [...importers, '.'];
  const scoped = new Set<string>();
  for (const importer of importers) {
    if (importer === '.') {
      for (const p of packages) scoped.add(p.dir);
      continue;
    }
    const pkg = packages.find((p) => p.dir === importer);
    if (pkg === undefined) return null;
    scoped.add(pkg.dir);
  }
  const paths = [...changed.filter(inPackage), ...[...scoped].map((dir) => `${dir}/package.json`)];
  return { importers, paths: [...new Set(paths)] };
}
