/**
 * Core WorkGraph public module boundary.
 *
 * This module gives core consumers a stable import path while hiding SQLite
 * tables, relation rows, and CLI command implementation details behind
 * core-owned readers.
 *
 * @task T10575
 * @task T10577
 * @saga T10538
 */

export type {
  WorkGraphContainmentAncestorsResult,
  WorkGraphContainmentChildrenResult,
  WorkGraphContainmentNode,
  WorkGraphContainmentQueryService,
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
export type { SqliteWorkGraphContainmentReader } from './containment.js';
export {
  createSqliteWorkGraphContainmentQueryService,
  SqliteWorkGraphContainmentQueryService,
} from './containment.js';
