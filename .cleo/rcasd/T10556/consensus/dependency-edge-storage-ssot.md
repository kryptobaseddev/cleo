---
task: T10556
parent: T10539
saga: T10538 (SG-PM-CORE-V2)
type: consensus
status: complete
vote: APPROVE
confidence: 0.86
---

# T10556 Consensus: Dependency edge storage SSoT

## Decision

APPROVE: `task_dependencies` is the single source of truth for readiness-affecting task dependency edges in PM-Core V2.

A dependency edge means “task A cannot be ready/complete-flow-unblocked until task B is ready enough under the active readiness policy.” That edge is stored only as `task_dependencies(task_id=A, depends_on=B)`. The outward “blocks” view is a derived inverse of the same row (`B blocks A`) and is not stored as an independent canonical edge.

`task_relations` remains the SSoT for non-readiness traceability relationships: related work, duplicates, supersession, evidence/provenance/cross-reference, and other semantic associations that must not affect scheduling readiness unless explicitly promoted to `task_dependencies` by a dependency mutation.

## Storage taxonomy

| User/API concept | Canonical storage | Direction | Readiness effect | Notes |
|---|---|---|---|---|
| `depends` / `depends_on` | `task_dependencies` | `task_id -> depends_on` | Yes | The only readiness-gating edge. Used by `cleo deps`, blockers, next-ready selection, cycle checks, delete protection, and cross-epic dependency validation. |
| `blocks` | Derived from `task_dependencies` | `depends_on -> task_id` | Yes | A read/query projection only. Writing “A blocks B” inserts `task_dependencies(task_id=B, depends_on=A)`. Do not write a separate `task_relations.relation_type='blocks'` row for readiness. |
| `relates` / `related` | `task_relations` | `task_id -> related_to` | No | Traceability and discovery only. May carry a reason and typed semantic relation, but it does not gate readiness. |
| `duplicates`, `supersedes`, `references`, `groups`, provenance/evidence relations | `task_relations` | relation-specific | No by default | Non-containment and non-readiness. Any workflow that wants a gating edge must create a corresponding `task_dependencies` row rather than infer readiness from a relation type. |
| containment / parent-child | `tasks.parent_id` | `child -> parent` | Parent closure only, not dependency readiness | Included here to keep hierarchy separate from both dependency and traceability graphs. |

## Readiness semantics vs traceability semantics

Readiness is operational: it controls whether work is eligible to start, whether blocked counts are non-zero, whether dependency cycles exist, and whether a deletion/reparenting would orphan downstream readiness checks. Therefore readiness needs a narrow table with an unambiguous direction and primary key. Existing schema and consumers already give `task_dependencies` this shape: `(task_id, depends_on)` with a reverse lookup index on `depends_on`.

Traceability is explanatory: it records why two tasks are associated, how a task supersedes or duplicates another, which work is evidence/provenance-related, or which historical grouping remains useful during migration. Those edges may be many semantic types and may be useful in both directions, but they must not silently alter scheduling. `task_relations` is therefore the correct storage for traceability only.

The previous ambiguity comes from user-facing words: “blocks” sounds like an edge type, while the storage model already has a dependency row whose inverse is blocking. PM-Core V2 should normalize the write API so “depends” and “blocks” are two entry points to the same `task_dependencies` edge with opposite argument order. “Relates” remains a separate non-gating write to `task_relations`.

## Alternatives considered

1. Store all non-containment edges in `task_relations`, including dependencies.
   - Rejected: it widens readiness semantics to a multi-type table with a primary key that currently cannot represent multiple typed edges for the same directed pair. It also risks conflating traceability with scheduler/blocker behavior.

2. Dual-write dependency rows to both `task_dependencies` and `task_relations`.
   - Rejected: dual SSoT creates drift, duplicate graph results, stale “blocks” rows, and unclear conflict resolution when one table changes.

3. Make `task_relations.relation_type='blocks'` canonical and derive `depends` from it.
   - Rejected: existing dependencies, `cleo deps`, graph APIs, Studio queries, and validation already point at `task_dependencies`; flipping the SSoT would be a larger migration with no semantic gain.

4. Keep `blocks` as an independently stored `task_relations` edge while `depends` stays in `task_dependencies`.
   - Rejected: `depends` and `blocks` are inverse views of the same readiness fact. Independent storage permits contradictory state such as A depends on B while A also blocks B.

## Risk register

1. High — Legacy `task_relations.relation_type='blocks'` rows may exist and may be read by older UI/reporting paths. Mitigation: treat them as legacy traceability during migration, report them in dry runs, and only promote to `task_dependencies` with explicit endpoint-direction rules.
2. High — The current `task_relations` primary key `(task_id, related_to)` cannot store multiple relation types for one directed pair. Mitigation: keep readiness out of that table now; handle typed multi-edge changes in a dedicated relation-schema task if needed.
3. Medium — API clients may expect a `blocks` write to create a visible relation row. Mitigation: document `blocks` as a dependency-write alias and return both canonical `depends` and derived `blocks` projections in read models.
4. Medium — Cross-epic readiness validation can be bypassed if callers write relation rows instead of dependency rows. Mitigation: relation writes must not be accepted as readiness evidence; only dependency mutations trigger cycle/cross-epic checks.
5. Low — Historical docs use “relation” generically for dependencies. Mitigation: update docs to say “readiness dependency” for `task_dependencies` and “traceability relation” for `task_relations`.

## Contract implications

- `tasks.add.depends`, `tasks.update.addDepends`, and `tasks.update.removeDepends` target `task_dependencies` only.
- A future `tasks.blocks.add(source, blocked)` convenience operation should insert `task_dependencies(task_id=blocked, depends_on=source)`.
- `tasks.depends` returns upstream (`task_id -> depends_on`) and downstream (`depends_on -> task_id`) projections from `task_dependencies` only.
- `tasks.relates.add` targets `task_relations` and must document that it has no readiness effect.
- Readiness policies and next-work selectors must ignore `task_relations` unless a later task introduces an explicit, separately named promotion path.

## Acceptance trace

- AC1 — `task_dependencies` vs `task_relations` decision recorded: yes; `task_dependencies` is readiness SSoT and `task_relations` is traceability SSoT.
- AC2 — depends/blocks/relates taxonomy mapped to storage: yes; see Storage taxonomy.
- AC3 — readiness semantics distinguished from traceability: yes; see Readiness semantics vs traceability semantics.
