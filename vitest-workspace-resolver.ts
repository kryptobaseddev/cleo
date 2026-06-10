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
 * entries top-to-bottom, first match wins. A single regex entry — placed at the
 * FRONT of each config's alias array so it beats the bare-package object
 * aliases — maps any `@cleocode/<pkg>/<subpath>` import to the corresponding
 * `packages/<pkg>/src/<subpath>` TypeScript file. The `customResolver` performs
 * the `.js → .ts` rewrite and the directory→`index.ts` fallback, and returns
 * `null` for anything without an on-disk source so default resolution still
 * handles it (e.g. a genuinely external specifier).
 *
 * Using an alias ARRAY entry (rather than a `resolveId` plugin) is deliberate:
 * in Vite 8 `resolve.alias` is applied earlier than user `enforce:'pre'`
 * `resolveId` hooks, so an alias entry is the only place that reliably wins
 * over the existing bare-package aliases.
 *
 * @task T11953
 * @epic T11679
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** Matches `@cleocode/<pkg>/<subpath>` (subpath required — bare roots excluded). */
const WORKSPACE_SUBPATH_RE = /^@cleocode\/([a-z0-9-]+)\/(.+)$/;

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
 * Resolve `@cleocode/<pkg>/<subpath>` to an existing TypeScript source file
 * under `packages/<pkg>/src`, or `null` if no source file exists (in which
 * case default resolution is left to handle the specifier).
 *
 * @param id - the raw import specifier
 * @param packages - the workspace packages this resolver may map into
 */
export function resolveWorkspaceSource(id: string, packages: Set<string>): string | null {
  const match = WORKSPACE_SUBPATH_RE.exec(id);
  if (match === null) return null;
  const [, pkg, rawSubpath] = match;
  if (pkg === undefined || rawSubpath === undefined || !packages.has(pkg)) return null;

  const srcRoot = join(PACKAGES_DIR, pkg, 'src');
  // ESM import specifiers carry a `.js` extension that maps to a `.ts` source.
  const base = rawSubpath.replace(/\.js$/, '');

  // Try, in order: `<base>.ts`, then `<base>/index.ts` (directory subpath).
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  for (const rel of candidates) {
    const abs = resolve(srcRoot, rel);
    // Guard against `..` escapes outside the package src tree.
    if (!abs.startsWith(srcRoot)) continue;
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
 * Build the single generic alias entry that maps every
 * `@cleocode/<pkg>/<subpath>` import to its TypeScript source. Spread this at
 * the FRONT of a vitest config's `test.alias` ARRAY so it wins over the
 * bare-package object aliases.
 *
 * @example
 * ```ts
 * test: { alias: [...cleoWorkspaceSubpathAliases(), { find: '@cleocode/core', replacement: … }] }
 * ```
 */
export function cleoWorkspaceSubpathAliases(): WorkspaceAliasEntry[] {
  const packages = discoverWorkspacePackages();
  return [
    {
      find: WORKSPACE_SUBPATH_RE,
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
 * Compose a vitest `test.alias` ARRAY from an existing object alias map,
 * prepending the generic `@cleocode/<pkg>/<subpath>` resolver so it wins over
 * every bare-package alias. Converting the object's entries to `{ find,
 * replacement }` string entries preserves Vite's exact-or-prefix matching
 * semantics one-to-one, so existing aliases keep behaving identically.
 *
 * This is the SINGLE seam each vitest config wires in; the per-subpath alias
 * literals (`@cleocode/core/store/sqlite.js`, …) become redundant and can be
 * deleted incrementally without re-introducing the DHQ-070 stall point.
 *
 * @param objectAliases - the legacy object alias map (string → string)
 */
export function withWorkspaceSubpathAliases(
  objectAliases: Record<string, string>,
): AliasArrayEntry[] {
  const converted: AliasArrayEntry[] = Object.entries(objectAliases).map(
    ([find, replacement]) => ({ find, replacement }),
  );
  return [...cleoWorkspaceSubpathAliases(), ...converted];
}
