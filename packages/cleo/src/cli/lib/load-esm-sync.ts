/**
 * Load a workspace ES module synchronously, at the moment it is first needed.
 *
 * Synchronous CLI code (`cliOutput`, the renderers) sometimes needs a module
 * that only one branch uses: CORE's human renderers for human-format output,
 * or the output-contract table for a failed `--field` pointer. A static import
 * makes every command pay for it, and `await import()` would make the caller
 * async. `require(esm)` (stable in every supported Node) loads it on the spot.
 * The specifier resolves with the `import` condition (`import.meta.resolve`),
 * so the result is the same module instance a static import would give,
 * including its load-time side effects.
 *
 * @task T13126
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

/**
 * Load `specifier` (a package specifier such as `@cleocode/core/render/index`)
 * and return its module namespace. Repeated calls return the cached module.
 *
 * @typeParam T - The module's namespace type, e.g. `typeof import('…')`.
 * @param specifier - Package specifier, resolved from this package.
 * @returns The module namespace.
 * @throws When the module cannot be resolved, or uses top-level await
 *   (`ERR_REQUIRE_ASYNC_MODULE`).
 * @example
 * ```ts
 * import type * as Render from '@cleocode/core/render/index';
 * const render = loadEsmSync<typeof Render>('@cleocode/core/render/index');
 * ```
 */
export function loadEsmSync<T>(specifier: string): T {
  return requireFromHere(fileURLToPath(import.meta.resolve(specifier)));
}
