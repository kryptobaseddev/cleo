/**
 * Manifest-only workspace changes, scoped by the lockfile's importers (T14163,
 * owner decision 2026-10-30; npm and yarn T14167).
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
 * rule (a passing test file in each, and in every dependent) applies.
 *
 * Lockfiles read: `pnpm-lock.yaml` (importers), `package-lock.json` v3 (the
 * `packages` entries without a `node_modules` segment are the importers:
 * `""` is the root) and Yarn Berry `yarn.lock` (the `@workspace:<dir>`
 * entries). npm v1/v2 lockfiles (a legacy `dependencies` tree) and Yarn
 * Classic lockfiles cannot be attributed and stay workspace-wide (T14167).
 *
 * @task T14163
 * @task T14167
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

/** The pnpm lockfile. */
export const PNPM_LOCKFILE = 'pnpm-lock.yaml';

/** The npm lockfile (T14167). */
export const NPM_LOCKFILE = 'package-lock.json';

/** The Yarn lockfile (T14167). */
export const YARN_LOCKFILE = 'yarn.lock';

/**
 * The scoping function, as callers pass it after `await import('./manifest-scope.js')`.
 * The module (and its YAML parser) is loaded only where a post-merge stand-in
 * is judged, never on the CLI's startup paths (T14163, gate 39).
 */
export type ManifestScoper = (
  root: string,
  base: string,
  head: string,
  changed: readonly string[],
) => ManifestScope | null;

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

/** An importer key as the scope names it: `.` for the root, else its directory. */
const importerDir = (key: string): string => (key === '' || key === '.' ? '.' : key);

/** Dependency names an npm `packages` entry declares, peers included (npm installs them). */
function npmDependencyNames(entry: Mapping): string[] {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
    (field) => Object.keys(mappingAt(entry, field)),
  );
}

/**
 * The `packages` key `name` resolves to from the entry at `from`, by Node's
 * lookup: `<from>/node_modules/<name>`, then each enclosing `node_modules`
 * directory up to the root.
 */
function npmResolve(packages: Mapping, from: string, name: string): string | null {
  let dir = from;
  for (;;) {
    const key = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
    if (isMapping(packages[key])) return key;
    if (dir === '') return null;
    const up = dir.lastIndexOf('/node_modules/');
    dir = up === -1 ? '' : dir.slice(0, up);
  }
}

/** Every npm `packages` key reachable from the given importer keys. */
function npmReachable(lock: Mapping, importers: readonly string[]): Set<string> {
  const packages = mappingAt(lock, 'packages');
  const seen = new Set<string>();
  const pending = [...importers];
  while (pending.length > 0) {
    const from = pending.pop() ?? '';
    const entry = mappingAt(packages, from);
    for (const name of npmDependencyNames(entry)) {
      const key = npmResolve(packages, from, name);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      // A workspace link is a sibling importer: its own change names it.
      if (mappingAt(packages, key).link !== true) pending.push(key);
    }
  }
  return seen;
}

/**
 * The importers an npm `package-lock.json` (lockfileVersion 3) change touched,
 * or null when part of it cannot be attributed to a changed importer.
 *
 * @param before - Lockfile text before the change, or null when absent.
 * @param after - Lockfile text after the change, or null when absent.
 * @returns The changed importers (`.` is the root), or null.
 * @task T14167
 */
export function npmImporterChanges(
  before: string | null,
  after: string | null,
): { importers: string[] } | null {
  const b = parseMapping(before, 'json');
  const a = parseMapping(after, 'json');
  if (b === null || a === null) return null;
  // v1/v2 carry the legacy `dependencies` tree; only v3's `packages` is read.
  if (b.lockfileVersion !== 3 || a.lockfileVersion !== 3) return null;
  if (changedKeys(b, a).some((k) => k !== 'packages')) return null;
  const changed = changedKeys(mappingAt(b, 'packages'), mappingAt(a, 'packages'));
  const isImporter = (key: string): boolean => !`/${key}/`.includes('/node_modules/');
  const importers = changed.filter(isImporter);
  const covered = new Set([...npmReachable(b, importers), ...npmReachable(a, importers)]);
  if (changed.some((key) => !isImporter(key) && !covered.has(key))) return null;
  return { importers: importers.map(importerDir) };
}

/** A Yarn Berry entry's descriptors: its key, split on `, `. */
const yarnDescriptors = (key: string): string[] => key.split(/,\s*/);

/** Every Yarn entry key reachable from the given workspace entry keys. */
function yarnReachable(lock: Mapping, roots: readonly string[]): Set<string> {
  const byDescriptor = new Map<string, string>();
  for (const key of Object.keys(lock))
    for (const descriptor of yarnDescriptors(key)) byDescriptor.set(descriptor, key);
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const entry = mappingAt(lock, pending.pop() ?? '');
    for (const [name, range] of Object.entries(mappingAt(entry, 'dependencies'))) {
      // A workspace dependency is a sibling importer: its own change names it.
      if (typeof range !== 'string' || range.startsWith('workspace:')) continue;
      const key = byDescriptor.get(`${name}@${range}`);
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      pending.push(key);
    }
  }
  return seen;
}

/** The workspace directory a Yarn entry resolves to, or null for a package. */
function yarnWorkspace(entry: unknown): string | null {
  const resolution = isMapping(entry) ? entry.resolution : undefined;
  if (typeof resolution !== 'string') return null;
  const at = resolution.indexOf('@workspace:', 1);
  return at === -1 ? null : resolution.slice(at + '@workspace:'.length);
}

/**
 * The importers a Yarn Berry `yarn.lock` change touched, or null when part of
 * it cannot be attributed to a changed workspace (a Yarn Classic lockfile,
 * which has no workspace entries, always is).
 *
 * @param before - Lockfile text before the change, or null when absent.
 * @param after - Lockfile text after the change, or null when absent.
 * @returns The changed importers (`.` is the root), or null.
 * @task T14167
 */
export function yarnImporterChanges(
  before: string | null,
  after: string | null,
): { importers: string[] } | null {
  const b = parseMapping(before, 'yaml');
  const a = parseMapping(after, 'yaml');
  if (b === null || a === null) return null;
  // Yarn Classic has no `__metadata` and no workspace entries.
  if (!isMapping(b.__metadata) || !isMapping(a.__metadata)) return null;
  const changed = changedKeys(b, a);
  // `__metadata` (lockfile version, cache key) reaches every package.
  if (changed.includes('__metadata')) return null;
  const workspaceKeys = changed.filter(
    (key) => yarnWorkspace(b[key]) !== null || yarnWorkspace(a[key]) !== null,
  );
  const covered = new Set([...yarnReachable(b, workspaceKeys), ...yarnReachable(a, workspaceKeys)]);
  if (changed.some((key) => !workspaceKeys.includes(key) && !covered.has(key))) return null;
  const dirs = workspaceKeys.map((key) => yarnWorkspace(a[key]) ?? yarnWorkspace(b[key]) ?? '');
  return { importers: [...new Set(dirs.map(importerDir))] };
}

/** Each lockfile this scoping reads, with its importer attribution. */
const LOCKFILES: Readonly<
  Record<string, (before: string | null, after: string | null) => { importers: string[] } | null>
> = {
  [PNPM_LOCKFILE]: pnpmImporterChanges,
  [NPM_LOCKFILE]: npmImporterChanges,
  [YARN_LOCKFILE]: yarnImporterChanges,
};

/**
 * Scope a change whose only paths outside every workspace package are the
 * root `package.json` and its lockfiles (pnpm, npm v3, Yarn Berry), comparing
 * `base` with `head`.
 *
 * @param root - The checkout.
 * @param base - The commit before the change (the merge's first parent).
 * @param head - The commit with the change (the merge commit).
 * @param changed - The change's paths, relative to `root`.
 * @returns The scope, or null when the change stays workspace-wide.
 * @task T14163
 * @task T14167
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
  if (
    outside.length === 0 ||
    outside.some((p) => p !== 'package.json' && !Object.hasOwn(LOCKFILES, p))
  )
    return null;
  if (
    outside.includes('package.json') &&
    !rootManifestDependencyOnly(show(root, base, 'package.json'), show(root, head, 'package.json'))
  )
    return null;
  let importers: string[] = [];
  for (const [lockfile, attribute] of Object.entries(LOCKFILES)) {
    if (!outside.includes(lockfile)) continue;
    const lock = attribute(show(root, base, lockfile), show(root, head, lockfile));
    if (lock === null) return null;
    importers = [...new Set([...importers, ...lock.importers])];
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
