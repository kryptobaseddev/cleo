/**
 * @cleocode/core/skills-lib — Re-export of the @cleocode/skills public surface.
 *
 * R10-L2 (T11581): batteries-included prep. This submodule lets SDK consumers
 * import the internalized `@cleocode/skills` package as a stable submodule of
 * `@cleocode/core` (`import { … } from '@cleocode/core/skills-lib'`) instead of
 * the soon-to-be-private bare `@cleocode/skills` specifier.
 *
 * Exposed under `./skills-lib` (not `./skills`) because `./skills/*` is already
 * a distinct wildcard subpath mapping into core's own `dist/skills/` tree
 * (skill-root, etc.). This dedicated entry re-exports the standalone skills
 * library surface (listSkills, getSkill, manifest, …).
 *
 * Additive re-export only — the standalone `@cleocode/skills` package is
 * unchanged and still published. Mirrors the `./contracts` shim pattern.
 *
 * @example
 * import { listSkills, getSkill } from '@cleocode/core/skills-lib';
 *
 * @package @cleocode/core
 */

export * from '@cleocode/skills';
