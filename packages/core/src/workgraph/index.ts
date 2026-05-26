/**
 * Core WorkGraph public module boundary.
 *
 * This module is intentionally type-only for T10575: it gives core consumers a
 * stable import path while hiding SQLite tables, relation rows, and CLI command
 * implementation details behind future core-owned readers.
 *
 * @task T10575
 * @saga T10538
 */

export type {
  WorkGraphEdge,
  WorkGraphHierarchyInputNode,
  WorkGraphHierarchyValidationOptions,
  WorkGraphHierarchyValidationResult,
  WorkGraphHierarchyViolation,
  WorkGraphNode,
  WorkGraphNodeRef,
  WorkGraphReader,
  WorkGraphRelationKind,
  WorkGraphSnapshot,
  WorkGraphTraversalDirection,
  WorkGraphTraversalOptions,
} from '@cleocode/contracts';
export {
  E_WORKGRAPH_PARENT_TYPE_MATRIX,
  validateWorkGraphHierarchy,
  WorkGraphHierarchyInvariantError,
} from '@cleocode/contracts';
