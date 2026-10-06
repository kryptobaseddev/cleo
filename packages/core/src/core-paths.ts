/**
 * CORE's own path helpers (`./paths.ts`) under a subpath of their own.
 *
 * `@cleocode/core/paths` is the curated `@cleocode/paths` surface, so the
 * helpers `./paths.ts` defines (worktree routing, the CANT workflows
 * directory, …) were reachable only through the CORE barrel. This subpath
 * lets dispatch handlers import them without loading the barrel (T13126).
 *
 * @module
 * @task T13126
 */

export * from './paths.js';
