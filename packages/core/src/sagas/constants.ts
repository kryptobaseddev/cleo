/**
 * Saga constants — single source of truth (ADR-073 §1).
 *
 * Sagas (`SG-`) are labeled top-level Epics that group multiple member
 * Epics across releases. The label + relation type below are how the
 * storage layer encodes that linkage.
 *
 * Moved from `packages/core/src/tasks/list.ts` into the dedicated sagas
 * module per Saga T10113 (SG-SAGA-FIRST-CLASS) / Epic T10208
 * (E-SAGAS-CORE-MODULE) — see Package-Boundary Check in AGENTS.md.
 *
 * @task T10123
 * @task T10120
 * @epic T10208
 * @see ADR-073-above-epic-naming.md §1 — Task Hierarchy Charter
 */

/**
 * Label that elevates an Epic to a Saga (ADR-073 §1, invariant I1).
 *
 * Sagas are stored as `type='epic'` rows with this label and link to their
 * member Epics through `task_relations.type='groups'` edges instead of the
 * `parentId` column.
 *
 * @deprecated Since Wave 1 of Saga T10326 (Epic T10277) — saga is now a
 *   first-class {@link TaskType} value. Migrated rows carry `type='saga'`
 *   directly and no longer require this label (ADR-083 §2.5). The constant
 *   is retained during the deprecation window so legacy `type='epic' AND
 *   label='saga'` rows in long-lived sessions remain detectable via
 *   {@link isSagaShape}. Removal is gated to W3.C T10334 once the cutover
 *   metric confirms no live system still emits the legacy shape.
 *
 * Sweeps in W2.B (T10331) migrated production READ callsites to
 * {@link isSagaShape}; the SAGA_LABEL identifier remains referenced only by
 * (1) the saga write/repair paths that intentionally emit the label as a
 * migration-shim, (2) the I7 audit comparison string, and (3) tests that
 * exercise the deprecation-window dual-shape acceptance.
 *
 * @see ADR-083-saga-as-tasktype.md §2.5
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I3 (label is migration-only)
 * @see ADR-073-above-epic-naming.md §1 — Task Hierarchy Charter
 */
export const SAGA_LABEL = 'saga' as const; // saga-label-ok: T10638 — SSoT canonical definition

/**
 * Relation type that linked a Saga to its member Epics (ADR-073 §1).
 *
 * @deprecated Since T10638 (E10.W5), Saga membership uses `parent_id`
 *   containment rather than `task_relations.type='groups'`. This constant
 *   is retained only for backward-compatible read paths during migration
 *   and will be removed once all references are cleared.
 */
export const SAGA_GROUPS_RELATION = 'groups' as const;

/**
 * Binding-source tag used in `ListTasksResult.bindingSource` whenever
 * `listTasks` resolved children via the Saga membership path instead of
 * the default `parentId` filter.
 *
 * @deprecated Since T10638, saga membership is parent_id-based so this
 *   binding source distinction is no longer meaningful.
 */
export const LIST_BINDING_SAGA_GROUPS = 'saga.groups' as const;
