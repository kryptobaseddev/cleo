/**
 * @cleocode/core/git-shim — Re-export of the @cleocode/git-shim public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/git-shim` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/git-shim'`) instead of
 * the soon-to-be-private bare `@cleocode/git-shim` specifier.
 *
 * Additive re-export only — the standalone `@cleocode/git-shim` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { … } from '@cleocode/core/git-shim';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/git-shim';
