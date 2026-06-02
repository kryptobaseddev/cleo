/**
 * @cleocode/core/worktree — Re-export of the @cleocode/worktree public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/worktree` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/worktree'`) instead of
 * the soon-to-be-private bare `@cleocode/worktree` specifier.
 *
 * Additive re-export only — the standalone `@cleocode/worktree` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { … } from '@cleocode/core/worktree';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/worktree';
