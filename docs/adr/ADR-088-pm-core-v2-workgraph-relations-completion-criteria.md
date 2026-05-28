---
id: adr-pm-core-v2-workgraph-relations-completion
tasks: [T10549]
kind: adr
status: Draft
date: 2026-05-25
saga: T10538 (SG-PM-CORE-V2)
epic: T10539
summary: PM-Core V2 canonicalizes Saga/Epic/Task/Subtask as one typed WorkGraph, reserves parent_id for containment only, reserves task_relations for non-containment relations only, and defines typed completion criteria semantics for deterministic rollups.
---

# ADR: PM-Core V2 WorkGraph, Relations, and Completion Criteria

## Status

Draft for SG-PM-CORE-V2 (T10538), authored under task T10549 and parent epic T10539.

## Date

2026-05-25

## Context

PM-Core V2 needs a greenfield project-management core that works for standalone tasks, multi-epic efforts, and long-lived sagas without mixing hierarchy, relation, and completion semantics. The current planning outline for SG-PM-CORE-V2 (T10538) establishes these core invariants:

- Saga, Epic, Task, and Subtask are all tasks with a canonical type discriminator.
- Containment must be a single tree edge so traversal, rollup, closure, and completion behavior are deterministic.
- Secondary relations are useful for ordering, grouping, dependency, evidence, and cross-reference semantics, but they must not be allowed to masquerade as hierarchy.
- Completion criteria need typed, machine-checkable semantics so parent completion can be derived from direct children when appropriate, while preserving explicit text and evidence-bound acceptance criteria.

The design must also retire label-encoded saga semantics as the target architecture: saga identity is a task type, not a label convention or a relation-only grouping trick.

## Decision

PM-Core V2 will use one canonical WorkGraph backed by `tasks` rows and explicit relation/completion tables.

1. `type=saga` is canonical.
   - Saga is represented by `tasks.type = 'saga'`.
   - Saga is not represented canonically by `label='saga'`, an `SG-` display prefix alone, or `task_relations.relation_type='groups'`.
   - Epic, Task, and Subtask remain peer values in the same task type discriminator.

2. `tasks.parent_id` is containment only.
   - `parent_id` is the only containment edge in PM-Core V2.
   - Direct children, ancestor traversal, descendant traversal, closure rollups, and default parent completion are all derived from `parent_id`.
   - The parent matrix is: saga parent is null; epic parent is a saga or null; task parent is an epic; subtask parent is a task.
   - Reparenting moves the whole subtree rooted at the moved task. A caller-visible result must identify the moved root, old/new parent, descendants whose projected depth or type changed, reopened ancestors, and warnings. Reparenting must validate cycles and tier violations for the full subtree before mutation and must refresh affected projections, rollups, and audit events after mutation.

3. `task_relations` is non-containment only.
   - `task_relations` may represent ordering, grouping/cross-reference, evidence, supersession, duplicate, advisory blocking, or other secondary graph semantics.
   - `task_relations` must never satisfy containment, child listing, ancestor/descendant traversal, parent rollup, parent completion, nesting-budget, or closure semantics.
   - A relation can explain why work is associated, but it cannot make that work a parent or child.
   - `task_relations.relation_type='groups'` is a soft association only. It is allowed for dotted-line cross-saga or provenance grouping, but not for Saga membership, child listing, readiness, closure, or completion.
   - `task_relations.relation_type='blocks'` is advisory only. If one task, epic, or saga must wait for another before execution, the hard edge must be represented by `task_dependencies` and surfaced through dependency/readiness APIs.

4. Hard dependencies are scheduler edges and may be projected across containment.
   - `task_dependencies` is the hard dependency graph. These edges drive blocked/readiness calculations and wave planning.
   - A future PM-Core V2 hardening task must specify whether a Saga/Epic-level dependency is inherited by descendant Epics/Tasks/Subtasks for readiness purposes, how that inheritance is displayed, and how cycles are detected across direct and inherited dependency edges.
   - Until that inherited-dependency rule lands, agents must not infer blocking behavior from soft relation rows.

5. Retyping is a full-subtree graph mutation, not a scalar field edit.
   - Changing a row between Saga/Epic/Task/Subtask can invalidate parent and child edges. Retype operations must provide a dry-run plan that lists the affected subtree, required descendant type changes, invalid descendants, reopened ancestors, and rollback behavior before any mutation.
   - Invalid retype plans must fail atomically without partial subtree writes.

6. Completion criteria are typed and deterministic.
   - `task_acceptance_criteria.kind` is one of `text`, `child_task`, or `evidence_bound`.
   - `child_task` criteria require `target_task_id` and are deterministic projections from direct `parent_id` children.
   - `text` and `evidence_bound` criteria must not use `target_task_id`.
   - A parent with children uses `child_task` criteria by default; mixed criteria mode is migration-only or explicit advanced scope.
   - Cancelled children do not automatically satisfy parent completion; they require waiver or replacement evidence.
   - Adding or reopening required child work under a done parent must reopen affected ancestors or create explicit regression/rework.

## Consequences

- SG-PM-CORE-V2 migrations must move canonical saga semantics toward `tasks.type = 'saga'` and away from label-only saga detection.
- Existing `task_relations.groups` usage can remain as a non-containment association only where still needed for provenance or cross-reference; it must not drive hierarchy or completion behavior.
- CLI, core services, projections, and rollups can share one invariant: if code needs parent/child semantics, it reads `tasks.parent_id`, not `task_relations`.
- Relation APIs must name their non-containment semantics explicitly and avoid field names or output labels that imply parentage.
- Hard dependency APIs must remain distinct from soft relation APIs so agents can safely draw solid scheduler edges separately from dotted-line context edges.
- Completion APIs can expose parent closure as a contract over typed criteria instead of ad hoc status aggregation.
- Legacy data migrations need dry-run evidence, backup/restore rehearsal, and owner-approved apply before changing live task databases.
- Open follow-up work: T11202 specifies soft relation and inherited dependency semantics; T11203 specifies safe reparent/retype cascade output and atomicity (see `docs/specs/CLEO-TASKS-API-SPEC.md` §8); T11204 sweeps stale `groups` doctrine from docs, skills, and contracts.

## Acceptance Trace

- T10549 AC1: The ADR states `type=saga` is canonical.
- T10549 AC2: The ADR states `parent_id` is containment only.
- T10549 AC3: The ADR states `task_relations` is non-containment only.

## Cross-References

- T10538 — SG-PM-CORE-V2 parent saga.
- T10539 — parent epic for this ADR task.
- T10549 — ADR drafting task.
