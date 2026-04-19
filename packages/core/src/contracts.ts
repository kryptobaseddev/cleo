/**
 * @cleocode/core/contracts — Re-export of the @cleocode/contracts public surface.
 *
 * This subpath gives SDK consumers a stable, tree-shakeable import for the
 * type system without pulling in the full kernel from `@cleocode/core`.
 *
 * Stability: stable (per STABILITY.md).
 *
 * @example
 * import type { TasksAPI, SessionsAPI } from '@cleocode/core/contracts';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/contracts';
