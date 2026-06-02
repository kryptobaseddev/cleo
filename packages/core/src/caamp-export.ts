/**
 * @cleocode/core/caamp — Re-export of the @cleocode/caamp public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/caamp` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/caamp'`) instead of the
 * soon-to-be-private bare `@cleocode/caamp` specifier.
 *
 * Additive re-export only — the standalone `@cleocode/caamp` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { … } from '@cleocode/core/caamp';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/caamp';
