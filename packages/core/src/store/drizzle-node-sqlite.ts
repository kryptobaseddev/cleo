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
 * @task T13126
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { drizzle as drizzleFn } from 'drizzle-orm/node-sqlite';

const requireFromHere = createRequire(import.meta.url);

/** The driver module's shape, as far as the store uses it. */
interface NodeSqliteDriver {
  drizzle: typeof drizzleFn;
}

let cached: typeof drizzleFn | null = null;

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
  if (cached === null) {
    const driver = requireFromHere(
      esmDriverPath() ?? 'drizzle-orm/node-sqlite',
    ) as NodeSqliteDriver;
    cached = driver.drizzle;
  }
  return cached;
}
