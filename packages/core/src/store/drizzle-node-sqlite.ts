/**
 * Synchronous, lazy access to drizzle's `node-sqlite` driver.
 *
 * The store opens databases synchronously, so it cannot `await import()` the
 * driver, and the driver statically imports `node:sqlite`, so it is not
 * imported at module load either (T1331 / T11280). Before this module the four
 * openers each called `createRequire(...)('drizzle-orm/node-sqlite')`. That
 * resolves with the `require` condition to drizzle's CommonJS build: a second
 * copy of drizzle (~300 modules) beside the ES module build the schema modules
 * import, loaded by every command that opened a store.
 *
 * This loads the ES module build, the instance the schema already uses,
 * through `require(esm)`: `import.meta.resolve` picks the `import` condition,
 * and requiring that file returns the module the ESM loader caches. When
 * `import.meta.resolve` is unavailable (some test transforms), it falls back
 * to the CommonJS build, as before.
 *
 * `require(esm)` refuses a module graph that uses top-level await
 * (`ERR_REQUIRE_ASYNC_MODULE`). Should a drizzle release add one, every store
 * open would throw, so that error also falls back to the CommonJS build: the
 * store keeps working on the heavier pre-T13126 path, and gate 39
 * (`scripts/check-cli-startup-graph.mjs`), which forbids drizzle's `.cjs`
 * files in its store-opening probes, fails the build that brought it in.
 *
 * @task T13126
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { drizzle as drizzleFn } from 'drizzle-orm/node-sqlite';

const requireFromHere = createRequire(import.meta.url);

/** The driver module's shape, as far as the store uses it. */
export interface NodeSqliteDriver {
  drizzle: typeof drizzleFn;
}

let cached: typeof drizzleFn | null = null;

/** The CommonJS specifier: `require` resolves it with the `require` condition. */
const CJS_DRIVER_SPECIFIER = 'drizzle-orm/node-sqlite';

/** Path of the driver's ES module build, or `null` when it cannot be resolved here. */
function esmDriverPath(): string | null {
  if (typeof import.meta.resolve !== 'function') return null;
  try {
    const url = import.meta.resolve('drizzle-orm/node-sqlite');
    return url.startsWith('file:') ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

/**
 * drizzle's `node-sqlite` `drizzle()` factory, loaded on first call.
 *
 * @returns The factory from the same drizzle instance the schema modules use.
 * @example
 * ```ts
 * const db = loadNodeSqliteDrizzle()({ client: nativeDb, schema });
 * ```
 */
export function loadNodeSqliteDrizzle(): typeof drizzleFn {
  cached ??= requireDriver(requireFromHere, esmDriverPath()).drizzle;
  return cached;
}

/** Whether `error` is Node's refusal to `require()` an ES module graph with top-level await. */
function isRequireAsyncModuleError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_REQUIRE_ASYNC_MODULE';
}

/**
 * Require the driver: the ES module build at `esmPath` when there is one,
 * else, or when that graph uses top-level await, the CommonJS build.
 *
 * @param req - The `require` to load with.
 * @param esmPath - File path of the ES module build, or `null` when unresolved.
 * @returns The driver module.
 * @throws Any other load error, unchanged.
 * @example
 * ```ts
 * const { drizzle } = requireDriver(createRequire(import.meta.url), null);
 * ```
 */
export function requireDriver(req: NodeJS.Require, esmPath: string | null): NodeSqliteDriver {
  if (esmPath === null) return req(CJS_DRIVER_SPECIFIER) as NodeSqliteDriver;
  try {
    return req(esmPath) as NodeSqliteDriver;
  } catch (error) {
    if (!isRequireAsyncModuleError(error)) throw error;
    return req(CJS_DRIVER_SPECIFIER) as NodeSqliteDriver;
  }
}
