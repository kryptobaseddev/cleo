/**
 * @cleocode/core/lafs — Re-export of the @cleocode/lafs public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/lafs` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/lafs'`) instead of the
 * soon-to-be-private bare `@cleocode/lafs` specifier.
 *
 * Additive re-export only — the standalone `@cleocode/lafs` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { … } from '@cleocode/core/lafs';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/lafs';
