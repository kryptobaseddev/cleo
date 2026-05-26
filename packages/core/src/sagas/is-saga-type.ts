/**
 * isSagaType — saga discriminator using canonical `type='saga'`.
 *
 * After T10636 (E10.W5), all rows with `type='epic' AND label='saga'`
 * were migrated to `type='saga'` and the legacy dual-shape fallback was
 * removed. Sagas are identified solely by `task.type === 'saga'`.
 *
 * Use {@link isSagaShape} for fully-typed {@link Task} rows with
 * compile-time narrowing; use `isSagaType` for wider `TaskRecord`-style
 * rows (where `type` is `string`).
 *
 * @param t - Any object with a `type` field.
 * @returns `true` when `t.type === 'saga'`.
 *
 * @task T10638 — E10.W5 legacy fallback removal
 * @see ADR-083-saga-as-tasktype.md §2.5
 */
export function isSagaType(t: {
  type?: string | null;
}): boolean {
  return t.type === 'saga';
}
