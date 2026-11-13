/**
 * Shared Vitest/Vite alias resolver for `@cleocode/*` workspace subpath imports.
 *
 * Why this exists (T11953 · DHQ-070)
 * ----------------------------------
 * Every `@cleocode/<pkg>` package ships an `exports` map that points public
 * subpaths (`./store/*`, `./gateway`, `./gc`, …) at built `dist/` artifacts.
 * Under vitest we want those same imports resolved to the TypeScript *source*
 * so the suite runs without first building each package — and, critically, so
 * it works in a freshly provisioned agent worktree where `dist/` does not yet
 * exist.
 *
 * Historically that was done with a hand-maintained alias MAP: one literal
 * `'@cleocode/core/store/sqlite.js' -> src/store/sqlite.ts` entry per subpath.
 * That list grew past 50 entries and every PR importing a new core/contracts
 * subpath in a test had to append another line — agents kept adding ad-hoc
 * aliases just to get `vitest` to resolve, which is the exact stall point
 * DHQ-070 describes. A missing entry surfaced only at test time as
 * `Cannot find package '@cleocode/core'` (vitest fell through to Node's
 * `exports` → `dist/` → nonexistent in a fresh worktree) — or, when a bare
 * `@cleocode/contracts` object-key alias greedily swallowed the subpath, as
 * `ENOTDIR … src/index.ts/gateway`.
 *
 * The fix is ONE generic alias entry instead of dozens of literals. Vite's
 * `resolve.alias` evaluates an ARRAY of `{ find, replacement, customResolver }`
 * entries top-to-bottom and uses ONLY the first entry whose `find` matches. A
 * single regex entry — placed at the FRONT of each config's alias array — maps
 * every `@cleocode/<pkg>` import, bare root or subpath, through its declared
 * package export to the corresponding TypeScript source. The `customResolver`
 * maps `dist/` and `dist/src/` targets back to `src/`, retains the conventional
 * `.js → .ts` and directory→`index.ts` fallbacks for internal imports, and returns
 * `null` for anything without an on-disk source. A `null` goes straight to
 * Vite's default resolution: no later alias entry is consulted, so a
 * `@cleocode/*` literal alias placed after this entry can never apply, and
 * {@link withWorkspaceSubpathAliases} rejects one (T14525).
 *
 * Because the resolver follows each package's `exports` map, two specifiers get
 * one module id exactly when their exports name one file. `@cleocode/core/paths`
 * (`paths-export.ts`) and `@cleocode/core/paths.js` (`paths.ts`) are different
 * modules here as in the published package, so a `vi.mock` of one form does not
 * mock the other: mock the specifier the code under test imports.
 *
 * Using an alias ARRAY entry (rather than a `resolveId` plugin) is deliberate:
 * in Vite 8 `resolve.alias` is applied earlier than user `enforce:'pre'`
 * `resolveId` hooks, so an alias entry is the only place that reliably wins
 * over Vite's default package resolution (which would load `dist/`).
 *
 * @task T11953
 * @epic T11679
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageExports, resolveExportsTarget } from './scripts/lib/package-exports.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const PACKAGE_EXPORTS = new Map<string, ReturnType<typeof readPackageExports>>();

/** Matches workspace packages and their subpaths, including bare package roots. */
const WORKSPACE_PACKAGE_RE = /^@cleocode\/([a-z0-9-]+)(?:\/(.+))?$/;

/**
 * `@cleocode/<pkg>` packages whose `src/` tree this resolver maps into. Derived
 * from the on-disk `packages/<name>/src` layout so it cannot drift from the
 * workspace. A package without a `src/` dir is simply absent and its imports
 * fall through to default resolution.
 */
function discoverWorkspacePackages(): Set<string> {
  const names = new Set<string>();
  // The package directory name equals the unscoped @cleocode/<name> for every
  // package in this monorepo, so a directory scan is sufficient.
  for (const dir of [
    'core',
    'contracts',
    'cleo',
    'runtime',
    'brain',
    'nexus',
    'lafs',
    'cant',
    'caamp',
    'adapters',
    'animations',
    'cleo-os',
    'git-shim',
    'paths',
    'playbooks',
    'skills',
    'studio',
    'utils',
    'worktree',
  ]) {
    if (existsSync(join(PACKAGES_DIR, dir, 'src'))) names.add(dir);
  }
  return names;
}

/**
 * Resolve `@cleocode/<pkg>` or its subpaths to an existing TypeScript source file
 * under `packages/<pkg>/src`, or `null` if no source file exists (in which
 * case default resolution is left to handle the specifier). Declared exports
 * take precedence over conventional source paths.
 *
 * @param id - the raw import specifier
 * @param packages - the workspace packages this resolver may map into
 */
export function resolveWorkspaceSource(id: string, packages: Set<string>): string | null {
  const match = WORKSPACE_PACKAGE_RE.exec(id);
  if (match === null) return null;
  const [, pkg, rawSubpath] = match;
  if (pkg === undefined || !packages.has(pkg)) return null;

  const srcRoot = join(PACKAGES_DIR, pkg, 'src');
  let exportsMap = PACKAGE_EXPORTS.get(pkg);
  if (exportsMap === undefined) {
    exportsMap = readPackageExports(join(PACKAGES_DIR, pkg));
    PACKAGE_EXPORTS.set(pkg, exportsMap);
  }
  const target = resolveExportsTarget(exportsMap, rawSubpath ?? '', 'import');
  const exportedSource = target === null ? null : /^\.\/dist\/(?:src\/)?(.+)\.js$/.exec(target)?.[1];
  // ESM import specifiers carry a `.js` extension that maps to a `.ts` source.
  const base = rawSubpath?.replace(/\.js$/, '') ?? 'index';

  const candidates = [
    ...(exportedSource ? [`${exportedSource}.ts`] : []),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const rel of candidates) {
    const abs = resolve(srcRoot, rel);
    // Guard against `..` escapes outside the package src tree.
    if (!abs.startsWith(`${srcRoot}${sep}`)) continue;
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * A Vite alias array entry. Mirrors the public `Alias` shape from vite without
 * importing it (vitest/config re-exports vite's types but the structural form
 * here is stable and avoids a type-only import churn).
 */
export interface WorkspaceAliasEntry {
  /** Regex matched against the raw import specifier. */
  find: RegExp;
  /** Unused literal replacement — `customResolver` performs the real mapping. */
  replacement: string;
  /** Per-entry resolver: returns the source path, or `null` to pass through. */
  customResolver: (source: string) => string | null;
}

/**
 * Build the single generic alias entry that maps every `@cleocode/<pkg>` import,
 * bare root or subpath, to its TypeScript source. Use it as a vitest config's
 * whole `test.alias`, or through {@link withWorkspaceSubpathAliases} when the
 * config also needs non-workspace aliases.
 *
 * @example
 * ```ts
 * test: { alias: cleoWorkspaceSubpathAliases() }
 * ```
 */
export function cleoWorkspaceSubpathAliases(): WorkspaceAliasEntry[] {
  const packages = discoverWorkspacePackages();
  return [
    {
      find: WORKSPACE_PACKAGE_RE,
      // The replacement is intentionally inert — `customResolver` decides the
      // real target (and returns null to fall through when there is no source).
      replacement: '$&',
      customResolver(source) {
        return resolveWorkspaceSource(source, packages);
      },
    },
  ];
}

/** A single Vite alias array entry — either a custom-resolver regex or a string find. */
export type AliasArrayEntry =
  | WorkspaceAliasEntry
  | { find: string; replacement: string };

/**
 * Compose a vitest `test.alias` ARRAY from a map of NON-workspace aliases
 * (`$lib`, a pinned third-party file, …), prepending the generic `@cleocode/*`
 * resolver. Converting the object's entries to `{ find, replacement }` string
 * entries preserves Vite's exact-or-prefix matching semantics one-to-one.
 *
 * The resolver is the only `@cleocode/*` mapping: an entry the resolver's
 * pattern matches would sit behind it and never apply, so one throws (T14525).
 *
 * @param objectAliases - non-workspace aliases (specifier → replacement)
 * @throws {Error} when a key is a `@cleocode/*` specifier
 */
export function withWorkspaceSubpathAliases(
  objectAliases: Record<string, string>,
): AliasArrayEntry[] {
  const shadowed = Object.keys(objectAliases).filter((find) => WORKSPACE_PACKAGE_RE.test(find));
  if (shadowed.length > 0) {
    throw new Error(
      `vitest alias ${shadowed.join(', ')} can never apply: the workspace resolver matches it first. Remove it; the resolver maps it from the package exports.`,
    );
  }
  const converted: AliasArrayEntry[] = Object.entries(objectAliases).map(
    ([find, replacement]) => ({ find, replacement }),
  );
  return [...cleoWorkspaceSubpathAliases(), ...converted];
}
