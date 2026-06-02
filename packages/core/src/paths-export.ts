/**
 * @cleocode/core/paths — Re-export of the @cleocode/paths public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/paths` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/paths'`) instead of the
 * soon-to-be-private bare `@cleocode/paths` specifier.
 *
 * Additive re-export only — the standalone `@cleocode/paths` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { resolveCleoDir } from '@cleocode/core/paths';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/paths';
