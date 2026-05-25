# T10553 WorkGraph containment and relation graph specification

Status: Draft accepted for SG-PM-CORE-V2 E1.W0
Task: T10553
Scope: WorkGraph hierarchy and non-containment relations for Saga, Epic, Task, and Subtask nodes.
Normative language: The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

## 1. Model

A WorkGraph has two distinct edge families:

1. Containment edges: a single-parent hierarchy used for ownership, rollup, traversal, completion aggregation, depth limits, and `parentId`/tree views.
2. Relation edges: typed semantic links such as depends, blocks, relates, duplicates, supersedes, groups, or other non-parent relationships.

Implementations MUST store, validate, query, and present containment edges separately from relation edges. A relation edge MUST NOT be promoted, inferred, projected, or counted as a containment edge unless a separate explicit containment edge satisfying this specification exists.

## 2. Node kinds and containment depth

The canonical containment ladder is:

Root -> Saga -> Epic -> Task -> Subtask

Depth is measured in containment edges beneath root:

| Kind | Depth | Containment role |
| --- | ---: | --- |
| Saga | 1 | Multi-release grouping container |
| Epic | 2 | Shippable initiative container |
| Task | 3 | Executable work item container |
| Subtask | 4 | Leaf-level execution item |

A WorkGraph implementation MUST treat the maximum containment depth as 4 including Saga and Subtask, or as 3 when evaluating only the legacy Epic -> Task -> Subtask ladder. Implementations that expose a `maxDepth=3` compatibility setting MUST define that setting as applying to Epic-contained work only and MUST NOT count Saga relation-based grouping as satisfying containment.

## 3. Parent containment matrix

The following matrix defines the only valid immediate containment parents. `Allowed` means the child MAY use that parent kind. `Forbidden` means the child MUST NOT use that parent kind.

| Child kind | No parent / root | Saga parent | Epic parent | Task parent | Subtask parent |
| --- | --- | --- | --- | --- | --- |
| Saga | Allowed | Forbidden | Forbidden | Forbidden | Forbidden |
| Epic | Allowed | Allowed | Forbidden | Forbidden | Forbidden |
| Task | Forbidden | Forbidden | Allowed | Forbidden | Forbidden |
| Subtask | Forbidden | Forbidden | Forbidden | Allowed | Forbidden |

Normative requirements:

1. A Saga MUST be root-contained and MUST NOT have a Saga, Epic, Task, or Subtask parent.
2. An Epic MAY be root-contained or MAY be contained by a Saga. An Epic MUST NOT be contained by an Epic, Task, or Subtask.
3. A Task MUST be contained by exactly one Epic. A Task MUST NOT be root-contained, Saga-contained, Task-contained, or Subtask-contained.
4. A Subtask MUST be contained by exactly one Task. A Subtask MUST NOT be root-contained, Saga-contained, Epic-contained, or Subtask-contained.
5. A containment parent MUST exist before a child edge is created, except during validated import transactions that atomically create all referenced nodes.
6. A node MUST have at most one containment parent at any time.

## 4. Cycle invariant

Containment edges MUST form a directed acyclic graph with single-parent tree semantics per connected component.

An implementation MUST reject any create, import, restore, promote, or reparent operation that would make a node its own ancestor or descendant. The rejection check MUST be transitive, not limited to immediate parent-child pairs.

Examples that MUST be rejected:

- Setting a Saga parent to any of its descendant Epics, Tasks, or Subtasks.
- Reparenting an Epic under a Saga that is already contained below that Epic by corrupted or imported state.
- Reparenting a Task under itself or under one of its Subtasks.

## 5. Depth invariant

A containment path MUST satisfy both the parent matrix and the configured depth budget.

Implementations MUST validate depth after applying the proposed mutation and before committing the mutation. A reparent operation MUST consider the full moved subtree, not just the moved node. If moving a subtree would place any descendant beyond the maximum allowed containment depth, the operation MUST be rejected atomically.

A Subtask SHOULD be treated as a leaf for containment. If future versions introduce deeper execution nodes, they MUST extend this specification with a new matrix row and MUST NOT silently allow Subtask -> child containment.

## 6. Reparent invariant

Reparenting is a containment mutation. A reparent operation MUST:

1. Validate that the proposed parent-child kind pair is allowed by the matrix.
2. Validate that both source node and target parent exist and are active unless the operation explicitly supports archived restoration.
3. Validate that the resulting containment graph remains acyclic.
4. Validate that the resulting path and all moved descendants remain within the depth budget.
5. Move only the containment edge. It MUST NOT create, delete, or reinterpret relation edges.
6. Be atomic: if any validation fails, the original parent edge and sibling ordering MUST remain unchanged.
7. Emit auditable evidence identifying the node, old parent, new parent, actor, timestamp, and validation result.

Promote/demote operations are specialized reparent operations and MUST satisfy the same invariants. A promote operation MAY remove an Epic parent to make it root-contained only when the child kind permits root containment. It MUST NOT promote a Task or Subtask to root.

## 7. Relation graph non-containment rule

Relation edges are non-containment edges. They MAY express semantic relationships but MUST NOT satisfy parentage, ownership, rollup, traversal, or depth requirements.

Required behavior:

1. A relation such as `groups`, `relates`, `depends`, `blocks`, `duplicates`, or `supersedes` MUST NOT make the target appear as a containment child.
2. A relation edge MUST NOT allow a Task to satisfy its required Epic parent.
3. A relation edge MUST NOT allow a Subtask to satisfy its required Task parent.
4. A Saga-to-Epic `groups` relation MAY be used for release-theme aggregation, but it MUST NOT be counted as an Epic containment parent unless an explicit Saga -> Epic containment edge also exists and passes the matrix.
5. Tree, rollup, frontier, and completion aggregation queries MUST use containment edges only unless an API explicitly asks for relation expansion and labels the result as relation-expanded rather than containment.
6. Cycle detection for containment MUST ignore relation-only cycles, and relation validation MUST NOT weaken containment cycle checks.

## 8. Acceptance criteria mapping

| AC | Requirement coverage |
| --- | --- |
| AC1: Saga/Epic/Task/Subtask parent matrix defined | Section 3 defines the complete immediate-parent matrix and normative requirements for every kind. |
| AC2: cycle/depth/reparent invariants defined | Sections 4, 5, and 6 define cycle, depth, and reparent invariants. |
| AC3: relation graph cannot satisfy containment | Section 7 defines the relation graph non-containment rule. |
