/**
 * isSagaType — dual-shape saga discriminator for the deprecation window.
 *
 * After Wave 1 of Saga T10326 (Epic T10277), `'saga'` is a first-class
 * {@link TaskType} value (ADR-083 §2.5). Existing rows with
 * `type='epic' AND label='saga' AND parent_id IS NULL` were migrated to
 * `type='saga'` and stripped of the redundant label by the
 * `20260523213708_t10277-saga-tasktype` migration.
 *
 * This helper accepts BOTH shapes so the codebase keeps working while the
 * deprecation window closes:
 *
 *   1. Canonical post-migration shape: `task.type === 'saga'`.
 *   2. Legacy label-encoded shape: `task.type === 'epic' && labels.includes('saga')`
 *      — still produced by fixtures, external imports, and test data that
 *      intentionally exercises the deprecation window.
 *
 * Wave 3 of the saga (T10334) drops the OR clause once the cutover metric
 * confirms no live system still emits the legacy shape. Until then, every
 * production read MUST go through this helper (or {@link isSagaShape} for
 * fully-typed {@link Task} rows) rather than inlining
 * `labels.includes('saga')`.
 *
 * Complement to {@link isSagaShape} (W2.A T10330): `isSagaShape` narrows
 * a strictly-typed `Task` to `SagaTask`; `isSagaType` accepts the wider
 * `TaskRecord`-style row shape (where `type` is `string` rather than the
 * `TaskType` union) and returns a plain `boolean`. Use `isSagaShape` when
 * the caller holds a fully-typed `Task` and wants compile-time narrowing
 * into the saga-gate input; use `isSagaType` when the caller holds a
 * `TaskRecord` (e.g. from `taskShow` / `taskList`) or a partial row from
 * a list response.
 *
 * @param t - Any object with `type` and optional `labels` fields.
 * @returns `true` when the task is a saga under either shape.
 *
 * @example
 * ```typescript
 * const result = await taskShow(projectRoot, id);
 * const task = result.data!.task; // TaskRecord — `type` is `string`
 * if (isSagaType(task)) {
 *   // dual-shape match — task is a saga (new OR legacy).
 * }
 * ```
 *
 * @task T10331 — W2.B sweep production callsites to isSagaType
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @epic T10277 — E-SAGA-TYPE-MIGRATION
 * @see ADR-083-saga-as-tasktype.md §2.5
 * @see ADR-073-above-epic-naming.md §1.2 invariant I3 — label is migration-only
 */
export function isSagaType(t: {
  type?: string | null;
  labels?: readonly string[] | null;
}): boolean {
  if (t.type === 'saga') return true;
  if (t.type === 'epic') {
    const labels = t.labels ?? [];
    return labels.includes('saga');
  }
  return false;
}
