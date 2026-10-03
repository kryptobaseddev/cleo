/**
 * ESM resolve fast path for the CLI process (T13126).
 *
 * ## Why it exists
 *
 * Node 24's default ESM resolver works out the format of every `.js` file it
 * resolves by calling `getPackageScopeConfig(url)`. That call spreads the
 * package's deserialized `package.json`, and the spread fires the lazy
 * `exports` getter, so the package's ENTIRE `exports` map is JSON-parsed again
 * on every import edge. The cost scales with (import edges inside a package) x
 * (size of that package's `exports` map):
 *
 * - `drizzle-orm@1.0.0-rc.4` ships a 290 KB `package.json` with 718 exports.
 *   Importing `drizzle-orm/sqlite-core` alone peaked at 301 MB RSS (measured
 *   2026-10-03, Node 24.21), against 60 MB for the same code through its CJS
 *   build, which never takes that path. Every CLEO command that opens a store
 *   paid it, as ~140 MB of short-lived garbage whose peak varied with GC timing.
 * - `@cleocode/core`'s own 10 KB `exports` map is re-parsed for each of its
 *   ~1,200 modules.
 *
 * ## What it does
 *
 * A synchronous resolve hook (`module.registerHooks`) answers the two cases
 * that dominate, and defers everything else to Node unchanged:
 *
 * 1. Relative `./x.js` / `../x.mjs` / `./x.cjs` imports from a `file:` parent:
 *    the URL is joined, the file is checked and realpath'd exactly as Node's
 *    `finalizeResolution` does, and the format comes from the nearest
 *    `package.json` `type`, read ONCE per package and cached per directory.
 * 2. Bare package specifiers: Node's own answer is cached per (specifier,
 *    parent directory, conditions). Node resolves a bare specifier from the
 *    parent's DIRECTORY (the `node_modules` walk, self-reference and `#imports`
 *    all start there), so every file in one directory gets the same answer.
 *
 * Anything it cannot answer with certainty goes to `nextResolve`: a `require()`
 * (only `import` conditions take the fast path), import attributes, query or
 * hash suffixes, percent-encoding, backslashes, missing files, directories,
 * a `package.json` without an explicit `type` (Node runs syntax detection),
 * and `--preserve-symlinks`. Errors therefore keep Node's exact codes and
 * messages, because Node produces them.
 *
 * Disable with `CLEO_RESOLVE_FAST_PATH=0` to compare against Node's resolver.
 *
 * @task T13126
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { ResolveFnOutput, ResolveHookContext, ResolveHookSync } from 'node:module';
// A namespace import, not `{ registerHooks }`: a named import of an export the
// running Node lacks is a LINK error, which would fire before `cli/index.ts`
// gets to run its Node version guard and explain the floor.
import * as nodeModule from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Module format a fast-path resolution can assert, or `null` when Node must decide. */
type ScopeFormat = 'module' | 'commonjs' | null;

/** Relative specifiers the fast path answers: `./` or `../`, ending in a JS extension. */
const RELATIVE_JS_SPECIFIER = /^\.\.?\/[^?#%\\]*\.(js|mjs|cjs)$/;

/** Environment switch that turns the fast path off (`0` or `false`). */
const DISABLE_ENV = 'CLEO_RESOLVE_FAST_PATH';

/**
 * Filesystem operations the fast path performs, injectable for tests.
 *
 * Each mirrors the `node:fs` call of the same name and throws the same way.
 */
export interface FastResolveFs {
  /** `true` when `path` exists and is a regular file. Throws when it does not exist. */
  readonly isFile: (path: string) => boolean;
  /** Canonical path with symlinks resolved, as `fs.realpathSync`. */
  readonly realpath: (path: string) => string;
  /** UTF-8 contents of `path`, or `undefined` when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
}

/** The real filesystem. */
const NODE_FS: FastResolveFs = {
  isFile: (path) => statSync(path).isFile(),
  realpath: (path) => realpathSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * The `type` a `package.json` declares, as a module format.
 *
 * Only an explicit `"module"` or `"commonjs"` counts. A missing or other value
 * returns `null`, because Node then detects the format from the source text,
 * which the fast path deliberately does not attempt.
 */
function declaredFormat(raw: string): ScopeFormat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Node reports an invalid package.json itself (ERR_INVALID_PACKAGE_CONFIG).
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null;
  const { type } = parsed;
  if (type === 'module') return 'module';
  if (type === 'commonjs') return 'commonjs';
  return null;
}

/**
 * Create the fast-path resolve hook. Each call owns fresh caches.
 *
 * @param fs - Filesystem operations; defaults to the real filesystem.
 * @returns A synchronous resolve hook for `module.registerHooks`.
 * @example
 * ```ts
 * registerHooks({ resolve: createFastResolve() });
 * ```
 */
export function createFastResolve(fs: FastResolveFs = NODE_FS): ResolveHookSync {
  /** Directory -> format of its package scope (`null`: Node decides). */
  const scopeByDir = new Map<string, ScopeFormat>();
  /** `specifier \0 parentDir \0 conditions` -> Node's resolution of a bare specifier. */
  const bareByKey = new Map<string, ResolveFnOutput>();

  /** Format of the package scope that contains `dir`, walking up like Node does. */
  const scopeFormat = (dir: string): ScopeFormat => {
    const visited: string[] = [];
    let current = dir;
    let found: ScopeFormat = null;
    for (;;) {
      const cached = scopeByDir.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(current);
      // Node stops at a `node_modules` directory: its package.json is never a scope.
      if (basename(current) === 'node_modules') break;
      const raw = fs.readText(join(current, 'package.json'));
      if (raw !== undefined) {
        found = declaredFormat(raw);
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const seen of visited) scopeByDir.set(seen, found);
    return found;
  };

  /** Resolve a relative JS specifier, or `null` to defer to Node. */
  const resolveRelative = (
    specifier: string,
    parentURL: string,
    extension: string,
  ): ResolveFnOutput | null => {
    let real: string;
    try {
      const path = fileURLToPath(new URL(specifier, parentURL));
      if (!fs.isFile(path)) return null;
      real = fs.realpath(path);
    } catch {
      // Missing file, directory, unreadable path: Node raises the precise error.
      return null;
    }
    const format: ScopeFormat =
      extension === 'mjs'
        ? 'module'
        : extension === 'cjs'
          ? 'commonjs'
          : scopeFormat(dirname(real));
    if (format === null) return null;
    return { url: pathToFileURL(real).href, format, shortCircuit: true };
  };

  return (specifier, context: ResolveHookContext, nextResolve) => {
    const { parentURL, conditions } = context;
    const fastEligible =
      parentURL?.startsWith('file:') === true &&
      conditions.includes('import') &&
      Object.keys(context.importAttributes ?? {}).length === 0;
    if (!fastEligible || parentURL === undefined) return nextResolve(specifier, context);

    const relative = RELATIVE_JS_SPECIFIER.exec(specifier);
    if (relative) {
      return (
        resolveRelative(specifier, parentURL, relative[1] ?? '') ?? nextResolve(specifier, context)
      );
    }

    // Bare package specifier (no scheme, not relative or absolute).
    const bare =
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('#') &&
      !specifier.includes(':') &&
      !specifier.includes('\\');
    if (!bare) return nextResolve(specifier, context);
    const key = `${specifier}\0${parentURL.slice(0, parentURL.lastIndexOf('/'))}\0${conditions.join(',')}`;
    const cached = bareByKey.get(key);
    if (cached) return cached;
    const resolved = nextResolve(specifier, context);
    bareByKey.set(key, { url: resolved.url, format: resolved.format, shortCircuit: true });
    return resolved;
  };
}

/** Whether Node runs with `--preserve-symlinks`, under which it skips the realpath. */
function preservesSymlinks(): boolean {
  const flag = '--preserve-symlinks';
  if (process.execArgv.includes(flag)) return true;
  return (process.env['NODE_OPTIONS'] ?? '').split(/\s+/).includes(flag);
}

let installed = false;

/**
 * Register the fast path for this process, once.
 *
 * Call it before the CLI's first dynamic `import()`: modules already loaded
 * are unaffected. It is a no-op when `CLEO_RESOLVE_FAST_PATH` is `0` or
 * `false`, under `--preserve-symlinks`, or when the running Node lacks
 * `module.registerHooks`.
 *
 * @returns `true` when the hook is active after the call.
 * @example
 * ```ts
 * installModuleResolveFastPath();
 * const { run } = await import('./heavy-command.js');
 * ```
 */
export function installModuleResolveFastPath(): boolean {
  if (installed) return true;
  const setting = process.env[DISABLE_ENV];
  if (setting === '0' || setting === 'false') return false;
  if (preservesSymlinks()) return false;
  if (typeof nodeModule.registerHooks !== 'function') return false;
  nodeModule.registerHooks({ resolve: createFastResolve() });
  installed = true;
  return true;
}
