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

/**
 * Characters and shapes that can never be a task identifier.
 *
 * ## Why this exists alongside {@link TASK_ID_REGEX}
 *
 * `TASK_ID_REGEX` describes the *canonical* id the generator produces. It is
 * NOT what the store actually contains, and enforcing it at the write path
 * would break working features. Measured against a live store of 3,198 tasks:
 *
 * | id | origin |
 * |---|---|
 * | `T-RECONCILE-FOLLOWUP-v2026.5.63-6` | generated ON PURPOSE by `archive-reason-invariant.ts` |
 * | `T932EP` | unknown, pre-existing |
 * | `/mnt/projects/cleocode` | the corruption this guard exists to stop |
 *
 * So CLEO deliberately mints structured ids that its own canonical pattern
 * rejects — and, separately, that `cleo show` rejects too, which makes those
 * release follow-up tasks as unreachable as the corrupt row. That is a real
 * defect, but it is a **design** question about the id space, and settling it
 * inside a guard that stops path-shaped garbage would be scope creep with a
 * broken `cleo release reconcile` as the cost.
 *
 * This predicate therefore rejects only what cannot be an identifier under any
 * shape: empty, whitespace, path separators, control characters, or absurd
 * length. It catches the actual harm without taking a position on digits.
 */
const FORBIDDEN_IN_TASK_ID = /[\s/\\\x00-\x1f\x7f]/;

/** Longest plausible identifier; anything beyond this is not an id. */
const MAX_TASK_ID_LENGTH = 64;

/**
 * Whether `value` is storable as a task identifier.
 *
 * Deliberately broader than {@link isTaskId}: it admits every id shape CLEO
 * actually mints (including the structured `T-RECONCILE-FOLLOWUP-…` ids the
 * release reconciler creates) while rejecting values that are not identifiers
 * at all. Use this at write chokepoints; use {@link isTaskId} when you
 * genuinely need the canonical generated shape.
 *
 * @param value - candidate identifier.
 * @returns `true` when `value` can be stored as an id.
 *
 * @example
 * ```ts
 * isStorableTaskId('T12128');                          // true
 * isStorableTaskId('T-RECONCILE-FOLLOWUP-v2026.5.63-6'); // true — CLEO mints these
 * isStorableTaskId('/mnt/projects/cleocode');          // false — a path
 * isStorableTaskId('see T1234 for details');           // false — whitespace
 * ```
 */
export function isStorableTaskId(value: unknown): value is TaskId {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_TASK_ID_LENGTH) return false;
  if (FORBIDDEN_IN_TASK_ID.test(value)) return false;
  // An identifier must start with a letter — this rejects paths beginning
  // `./`, `~`, or a digit-only value that is really a count.
  return /^[A-Za-z]/.test(value);
}
