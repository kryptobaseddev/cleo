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
  WorkGraphDependencyEdge,
  WorkGraphDirectEdge,
  WorkGraphEdge,
  WorkGraphEdgeDirection,
  WorkGraphEdgeSource,
  WorkGraphHierarchyInputNode,
  WorkGraphHierarchyValidationOptions,
  WorkGraphHierarchyValidationResult,
  WorkGraphHierarchyViolation,
  WorkGraphNode,
  WorkGraphNodeRef,
  WorkGraphPageInfo,
  WorkGraphPaginationOptions,
  WorkGraphPercentDenominator,
  WorkGraphProjectionMismatch,
  WorkGraphReader,
  WorkGraphReadyFrontierBlockedBy,
  WorkGraphReadyFrontierOptions,
  WorkGraphReadyFrontierResult,
  WorkGraphReadyFrontierTask,
  WorkGraphRelationEdge,
  WorkGraphRelationEdgesOptions,
  WorkGraphRelationEdgesResult,
  WorkGraphRelationKind,
  WorkGraphRelationQueryService,
  WorkGraphRollupCounts,
  WorkGraphSnapshot,
  WorkGraphSubtreePercentages,
  WorkGraphSubtreeSummaryOptions,
  WorkGraphSubtreeSummaryResult,
  WorkGraphTaskRelationType,
  WorkGraphTraversalDirection,
  WorkGraphTraversalOptions,
  WorkGraphTraversalResult,
  WorkGraphTreeNode,
  WorkGraphTreeOptions,
  WorkGraphTreeResult,
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
export type { SqliteWorkGraphRelationReader } from './relations.js';
export {
  createSqliteWorkGraphRelationQueryService,
  SqliteWorkGraphRelationQueryService,
} from './relations.js';
export type {
  WorkGraphContainmentCycleFinding,
  WorkGraphMaxDepthFinding,
  WorkGraphReparentFinding,
  WorkGraphReparentNodeType,
  WorkGraphReparentParentTypeFinding,
  WorkGraphReparentPreflightInput,
  WorkGraphReparentPreflightResult,
  WorkGraphReparentTargetNotFoundFinding,
} from './reparent-preflight.js';
export {
  E_WORKGRAPH_CONTAINMENT_CYCLE,
  E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
  E_WORKGRAPH_REPARENT_TARGET_NOT_FOUND,
  preflightWorkGraphReparent,
} from './reparent-preflight.js';
