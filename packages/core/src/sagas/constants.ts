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
 * @see ADR-073-above-epic-naming.md §1 — Task Hierarchy Charter
 */
export const SAGA_LABEL = 'saga' as const;

/**
 * Relation type that links a Saga to its member Epics (ADR-073 §1).
 *
 * Written by `tasks.saga.add` and read by `tasks.saga.members`.
 */
export const SAGA_GROUPS_RELATION = 'groups' as const;

/**
 * Binding-source tag used in `ListTasksResult.bindingSource` (and propagated
 * upstream into LAFS envelope meta by the dispatch layer) whenever
 * `listTasks` resolved children via the Saga `task_relations.type='groups'`
 * path instead of the default `parentId` filter.
 */
export const LIST_BINDING_SAGA_GROUPS = 'saga.groups' as const;
