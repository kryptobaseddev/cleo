/**
 * The canonical shape of a task identifier (T12128).
 *
 * ## Why this file exists
 *
 * The repo carried at least five different opinions about what a task ID looks
 * like, and they disagreed with each other:
 *
 * | pattern | where | disagrees about |
 * |---|---|---|
 * | `/^T[0-9]{1,7}$/` | `goal.ts`, `evidence-atom-schema.ts` (8 sites) | upper bound |
 * | `/^T(\d{3,})$/` | `tasks/id-generator.ts` | rejects `T12`, allows `T123456789` |
 * | `/^T\d{3,}$/` | `sentient/tick.ts`, `nexus/query.ts` | same |
 * | `/\bT(\d{4,})\b/` | `lifecycle/consolidate-rcasd.ts` | unanchored, 4-digit minimum |
 * | `/^(T\d+(-[A-Z]\w*)?\|E-\d+...)$/` | `changesets.ts` | allows suffixes and `E-` |
 *
 * Disagreement between validators is survivable. What was not survivable is
 * that **none of them ran on the write path**. A project path was written into
 * the `id` column of `tasks_tasks` — `id='/mnt/projects/cleocode'`,
 * `title='Task /mnt/projects/cleocode'`, `type=null` — and the row is now
 * **immortal**: `cleo list` returns it, but `cleo show`, `cleo update` and
 * `cleo delete` all reject the id as malformed before they can reach it. The
 * read-side validators that would have prevented it are the ones that make it
 * unfixable.
 *
 * {@link TASK_ID_REGEX} deliberately adopts the `{1,7}` shape already used at
 * eight sites rather than inventing a sixth opinion. It is permissive by
 * design: the job here is to reject values that are not task IDs at all, not to
 * re-litigate how many digits a task ID should have. Narrowing it later is a
 * separate decision with its own migration.
 *
 * @module
 * @task T12128
 */

/**
 * Canonical task-identifier pattern: `T` followed by 1-7 digits.
 *
 * Anchored at both ends — an unanchored variant would accept `see T1234 for
 * details` as an id, which is how prose ends up in an id column.
 */
export const TASK_ID_REGEX = /^T[0-9]{1,7}$/;

/**
 * A string known to be a well-formed task identifier.
 *
 * Branded so a validated id cannot be confused with an arbitrary string at a
 * call site that matters.
 */
export type TaskId = string & { readonly __brand: 'TaskId' };

/**
 * Whether `value` is a well-formed task identifier.
 *
 * @param value - candidate identifier.
 * @returns `true` when `value` matches {@link TASK_ID_REGEX}.
 *
 * @example
 * ```ts
 * isTaskId('T12128');               // true
 * isTaskId('/mnt/projects/cleo');   // false — the value that got written
 * isTaskId('see T1234 for details');// false — anchoring matters
 * ```
 */
export function isTaskId(value: unknown): value is TaskId {
  return typeof value === 'string' && TASK_ID_REGEX.test(value);
}
