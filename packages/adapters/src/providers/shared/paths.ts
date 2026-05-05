/**
 * Adapter-shared path helpers.
 *
 * Historically this module hand-rolled `getCleoTemplatesTildePath` to avoid a
 * circular `core ↔ adapters` import. With the introduction of `@cleocode/paths`
 * — a zero-dep leaf package consumed by core, adapters, worktree, brain, and
 * caamp — that workaround is no longer needed: every package imports from the
 * SSoT directly.
 *
 * @task T916 (original duplicate)
 * @task T1886 (consolidated into @cleocode/paths SSoT)
 */

export { getCleoTemplatesTildePath } from '@cleocode/paths';
