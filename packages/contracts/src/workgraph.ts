/**
 * Public WorkGraph contracts for PM-Core V2.
 *
 * The WorkGraph is the product boundary for task containment and non-containment
 * relations. These contracts intentionally describe graph-shaped projections
 * only; persistence, SQL tables, and CLI rendering stay behind core adapters.
 *
 * @task T10575
 * @saga T10538
 */
import { z } from 'zod';
import { TASK_RELATION_TYPES } from './enums.js';
import { TASK_STATUSES } from './status-registry.js';
import type { TaskPriority, TaskStatus, TaskType, VerificationGate } from './task.js';

/** Stable error code for WorkGraph parent/type matrix violations. */
export const E_WORKGRAPH_PARENT_TYPE_MATRIX = 'E_WORKGRAPH_PARENT_TYPE_MATRIX';

/** Stable relation categories exposed by the WorkGraph public API. */
export type WorkGraphRelationKind =
  | 'contains'
  | 'depends_on'
  | 'blocks'
  | 'relates_to'
  | 'groups'
  | 'satisfies';

/** Direction to traverse from a starting WorkGraph node. */
export type WorkGraphTraversalDirection = 'ancestors' | 'descendants' | 'upstream' | 'downstream';

/** Direction filter for direct non-containment edge reads around one root node. */
export type WorkGraphEdgeDirection = 'out' | 'in' | 'both';

/** Raw `task_relations.relation_type` values preserved for relation-edge callers. */
export type WorkGraphTaskRelationType = (typeof TASK_RELATION_TYPES)[number];

/** Stable identifier for a task-like WorkGraph vertex. */
export interface WorkGraphNodeRef {
  /** Task, Saga, Epic, or Subtask ID. */
  readonly id: string;
  /** Hierarchy discriminator for this graph vertex. */
  readonly type: TaskType;
}

/** Public task vertex shape returned by WorkGraph readers. */
export interface WorkGraphNode extends WorkGraphNodeRef {
  /** Human-readable task title. */
  readonly title: string;
  /** Current lifecycle status of the task row. */
  readonly status: TaskStatus;
  /** Priority copied from the task row for queueing and display. */
  readonly priority: TaskPriority;
  /** Optional direct containment parent. Omitted for root nodes. */
  readonly parentId?: string;
}

/** Directed edge between two WorkGraph nodes. */
export interface WorkGraphEdge {
  /** Source task ID. */
  readonly fromId: string;
  /** Target task ID. */
  readonly toId: string;
  /** Public relation kind; storage-specific relation names are not exposed. */
  readonly kind: WorkGraphRelationKind;
}

/** Storage source for semantically distinct WorkGraph edge projections. */
export type WorkGraphEdgeSource = 'relation' | 'dependency';

/** Non-containment relation edge backed by one `task_relations` row. */
export interface WorkGraphRelationEdge extends WorkGraphEdge {
  /** Relation rows are advisory graph links, not scheduler blockers. */
  readonly source: 'relation';
  /** Raw relation type stored in `task_relations.relation_type`. */
  readonly relationType: WorkGraphTaskRelationType;
  /** Optional human-authored relation rationale from `task_relations.reason`. */
  readonly reason?: string;
}

/** Scheduler dependency edge backed by one `task_dependencies` row. */
export interface WorkGraphDependencyEdge extends WorkGraphEdge {
  /** Dependency rows drive scheduler blocking and are distinct from relation rows. */
  readonly source: 'dependency';
  /** Dependency edges always use the public dependency kind. */
  readonly kind: 'depends_on';
}

/** Direct edge returned by the relation edge query service. */
export type WorkGraphDirectEdge = WorkGraphRelationEdge | WorkGraphDependencyEdge;

/** A fully materialized WorkGraph projection. */
export interface WorkGraphSnapshot {
  /** Graph vertices keyed externally by `id`. */
  readonly nodes: readonly WorkGraphNode[];
  /** Directed graph edges between nodes. */
  readonly edges: readonly WorkGraphEdge[];
}

/** Cursor/limit controls shared by WorkGraph paginated readers. */
export interface WorkGraphPaginationOptions {
  /** Opaque cursor returned by the previous page. Omitted starts at the first row. */
  readonly cursor?: string;
  /** Maximum number of nodes to return. Implementations clamp invalid values. */
  readonly limit?: number;
}

/** Page metadata returned by WorkGraph paginated readers. */
export interface WorkGraphPageInfo {
  /** Cursor to pass to the next request when more rows exist. */
  readonly nextCursor?: string;
  /** True when additional rows are available after this page. */
  readonly hasMore: boolean;
}

/** Options shared by WorkGraph traversal readers. */
export interface WorkGraphTraversalOptions extends WorkGraphPaginationOptions {
  /** Starting node ID for the traversal. */
  readonly rootId: string;
  /** Direction to traverse from `rootId`. */
  readonly direction: WorkGraphTraversalDirection;
  /** Optional maximum edge depth; omitted means unbounded. */
  readonly maxDepth?: number;
  /** Include non-containment relation edges in addition to containment edges. */
  readonly includeRelations?: boolean;
}

/** Paginated traversal projection with explicit page metadata. */
export interface WorkGraphTraversalResult extends WorkGraphSnapshot {
  /** Requested traversal root. */
  readonly rootId: string;
  /** Direction traversed from the requested root. */
  readonly direction: WorkGraphTraversalDirection;
  /** Page metadata for cursor-based follow-up calls. */
  readonly pageInfo: WorkGraphPageInfo;
}

/** Options for descendant tree readers. */
export interface WorkGraphTreeOptions extends WorkGraphPaginationOptions {
  /** Starting parent ID whose descendants should be projected. */
  readonly rootId: string;
  /** Optional maximum descendant depth; omitted means unbounded. */
  readonly maxDepth?: number;
}

/** Node returned by a paginated descendant tree projection. */
export interface WorkGraphTreeNode extends WorkGraphNode {
  /** One-based edge depth from the requested root. */
  readonly depth: number;
}

/** Paginated descendant tree projection. */
export interface WorkGraphTreeResult {
  /** Requested tree root. */
  readonly rootId: string;
  /** Descendant nodes ordered breadth-first by depth, position, creation time, and ID. */
  readonly nodes: readonly WorkGraphTreeNode[];
  /** Containment edges connecting the returned nodes to the requested root or page peers. */
  readonly edges: readonly WorkGraphEdge[];
  /** Page metadata for cursor-based follow-up calls. */
  readonly pageInfo: WorkGraphPageInfo;
}

/** Sparse status/type bucket counts returned by WorkGraph subtree rollups. */
export interface WorkGraphRollupCounts {
  /** Total nodes counted for this bucket. */
  readonly total: number;
  /** Counts by canonical task status. Statuses with zero rows may be omitted. */
  readonly byStatus: Partial<Record<TaskStatus, number>>;
  /** Counts by canonical task type. Types with zero rows may be omitted. */
  readonly byType: Partial<Record<TaskType, number>>;
}

/** Explicit denominator contract used for percentage fields in subtree summaries. */
export interface WorkGraphPercentDenominator {
  /** Stable denominator basis. */
  readonly basis: 'subtree-total';
  /** Numeric denominator used to compute every percentage in the result. */
  readonly total: number;
  /** Human-readable rule statement for CLIs and APIs. */
  readonly description: string;
}

/** Completion-style percentages derived from a subtree summary. */
export interface WorkGraphSubtreePercentages {
  /** Done descendants divided by `percentDenominator.total`. */
  readonly done: number;
  /** Active descendants divided by `percentDenominator.total`. */
  readonly active: number;
  /** Blocked descendants divided by `percentDenominator.total`. */
  readonly blocked: number;
  /** Pending descendants divided by `percentDenominator.total`. */
  readonly pending: number;
  /** Cancelled descendants divided by `percentDenominator.total`. */
  readonly cancelled: number;
}

/** Field-level mismatch proving a cached direct-child projection is stale. */
export interface WorkGraphProjectionMismatch {
  /** Compared rollup field. */
  readonly field: 'total' | `status:${TaskStatus}` | `type:${TaskType}`;
  /** Count supplied by the caller's projection. */
  readonly expected: number;
  /** Count observed from current WorkGraph storage. */
  readonly actual: number;
}

/** Options for storage-backed subtree summary and rollup reads. */
export interface WorkGraphSubtreeSummaryOptions {
  /** Root node whose descendants are summarized. The root node itself is excluded. */
  readonly rootId: string;
  /** Optional direct-child projection to compare against current storage. */
  readonly expectedDirectRollup?: WorkGraphRollupCounts;
}

/** Direct-child and full-subtree rollup summary for one WorkGraph root. */
export interface WorkGraphSubtreeSummaryResult {
  /** Requested summary root. */
  readonly rootId: string;
  /** Counts for depth=1 descendants only. */
  readonly direct: WorkGraphRollupCounts;
  /** Counts for all descendants below the root. */
  readonly subtree: WorkGraphRollupCounts;
  /** Explicit denominator rules used by `percentages`. */
  readonly percentDenominator: WorkGraphPercentDenominator;
  /** Percentage values rounded to two decimals. */
  readonly percentages: WorkGraphSubtreePercentages;
  /** True when `expectedDirectRollup` disagrees with current storage. */
  readonly staleProjection: boolean;
  /** Field-level projection drift details. */
  readonly projectionMismatches: readonly WorkGraphProjectionMismatch[];
}

/** Options for reading the ready frontier under a WorkGraph scope. */
export interface WorkGraphReadyFrontierOptions {
  /** Root node whose descendant scope should be grouped by readiness. */
  readonly rootId: string;
  /** Optional SQL task-role/kind filter applied before grouping. */
  readonly role?: string;
}

/** Dependency edge that keeps a frontier task from being runnable. */
export interface WorkGraphDependencyBlocker {
  /** Upstream dependency task ID. */
  readonly taskId: string;
  /** Current upstream dependency status. */
  readonly status: TaskStatus;
}

/** Verification gate that is not yet satisfied for a frontier task. */
export interface WorkGraphGateBlocker {
  /** Gate name from the task verification state. */
  readonly gate: VerificationGate;
}

/** Ready-frontier task with blocker metadata attached. */
export interface WorkGraphReadyFrontierTask extends WorkGraphNode {
  /** SQL task-role/kind value copied from the task row when available. */
  readonly role?: string;
  /** Upstream dependencies whose status is not done/cancelled. */
  readonly dependencyBlockers: readonly WorkGraphDependencyBlocker[];
  /** Verification gates whose value is not true. */
  readonly gateBlockers: readonly WorkGraphGateBlocker[];
}

/** Aggregate blocker -> task rollup for frontier diagnostics. */
export type WorkGraphReadyFrontierBlockedBy =
  | {
      /** Blocker category. */
      readonly kind: 'dependency';
      /** Dependency task ID blocking one or more frontier tasks. */
      readonly blockerId: string;
      /** Frontier task IDs blocked by this dependency. */
      readonly blocks: readonly string[];
    }
  | {
      /** Blocker category. */
      readonly kind: 'gate';
      /** Gate blocking one or more frontier tasks. */
      readonly gate: VerificationGate;
      /** Frontier task IDs blocked by this gate. */
      readonly blocks: readonly string[];
    };

/** Ready-frontier grouping result for a WorkGraph scope. */
export interface WorkGraphReadyFrontierResult {
  /** Requested scope root. */
  readonly rootId: string;
  /** Optional role filter echoed from the request. */
  readonly role?: string;
  /** Grouped frontier rows. */
  readonly groups: {
    /** Tasks with no dependency blockers. */
    readonly ready: readonly WorkGraphReadyFrontierTask[];
    /** Tasks with one or more dependency blockers. */
    readonly blocked: readonly WorkGraphReadyFrontierTask[];
    /** Aggregate blocker rollup across both groups. */
    readonly blockedBy: readonly WorkGraphReadyFrontierBlockedBy[];
  };
}

/** Options for direct relation-edge reads around one WorkGraph node. */
export interface WorkGraphRelationEdgesOptions {
  /** Root task ID used by the direction filter. */
  readonly rootId: string;
  /** Which side of the stored edge should match `rootId`. Defaults to `both`. */
  readonly direction?: WorkGraphEdgeDirection;
  /**
   * Include `task_dependencies` edges in addition to `task_relations` rows.
   * Dependency edges stay tagged as `source: 'dependency'` and never carry a
   * relation reason.
   */
  readonly includeDependencies?: boolean;
}

/** Direct relation-edge read result with the normalized direction echoed. */
export interface WorkGraphRelationEdgesResult {
  /** Requested root task ID. */
  readonly rootId: string;
  /** Direction filter applied by the reader. */
  readonly direction: WorkGraphEdgeDirection;
  /** Relation rows, plus dependency rows only when explicitly requested. */
  readonly edges: readonly WorkGraphDirectEdge[];
}

/** Options for an aggregate WorkGraph audit read around one scope. */
export interface WorkGraphAuditOptions extends WorkGraphPaginationOptions {
  /** Root task ID whose graph projections should be audited. */
  readonly rootId: string;
  /** Optional maximum descendant depth for traversal/tree projections. */
  readonly maxDepth?: number;
  /** Include direct relation-edge diagnostics. Defaults to false. */
  readonly includeRelations?: boolean;
}

/** Aggregate WorkGraph audit result for CLI/API diagnostics. */
export interface WorkGraphAuditResult {
  /** Requested audit root. */
  readonly rootId: string;
  /** Storage-agnostic hierarchy invariant result. */
  readonly hierarchy: WorkGraphHierarchyValidationResult;
  /** Descendant traversal projection used by the audit. */
  readonly traversal: WorkGraphTraversalResult;
  /** Runnable/blocked descendant frontier under the same root. */
  readonly frontier: WorkGraphReadyFrontierResult;
  /** Direct and subtree rollup summary under the same root. */
  readonly rollup: WorkGraphSubtreeSummaryResult;
  /** Optional direct relation/dependency edge projection when requested. */
  readonly relationEdges?: WorkGraphRelationEdgesResult;
}

/** Reason a requested WorkGraph payload member was omitted from a bounded result. @task T10609 */
export type WorkGraphOmissionReason =
  | 'budget_exceeded'
  | 'not_requested'
  | 'not_available'
  | 'redacted'
  | 'truncated';

/** Bounded context-accounting summary shared by WorkGraph context pack and scaffold calls. @task T10609 */
export interface WorkGraphContextBudget {
  /** Caller-provided token budget for the response. */
  readonly tokenBudget: number;
  /** Estimated token usage of the returned payload. */
  readonly estimatedTokens: number;
  /** Remaining token budget after payload selection. */
  readonly remainingTokens: number;
  /** True when one or more requested payload members were omitted or truncated. */
  readonly truncated: boolean;
}

/** Machine-readable omission emitted when bounded WorkGraph payloads drop data. @task T10609 */
export interface WorkGraphOmission {
  /** Stable path/key of the omitted member. */
  readonly path: string;
  /** Why the member is absent from the result. */
  readonly reason: WorkGraphOmissionReason;
  /** Human-readable explanation for operators and prompt builders. */
  readonly message: string;
  /** Estimated tokens saved by omitting this member, when known. */
  readonly estimatedTokens?: number;
}

/** Parameters for building a bounded WorkGraph context pack. @task T10609 */
export interface WorkGraphContextPackParams extends WorkGraphPaginationOptions {
  /** Root task/saga/epic whose graph context should be packed. */
  readonly rootId: string;
  /** Maximum token budget for selected graph payloads. */
  readonly tokenBudget?: number;
  /** Include direct relation/dependency edges in the returned context. */
  readonly includeRelations?: boolean;
  /** Include readiness grouping under the requested scope. */
  readonly includeReadiness?: boolean;
  /** Include subtree rollup summary under the requested scope. */
  readonly includeRollup?: boolean;
}

/** Bounded graph context pack for orchestration prompts and API consumers. @task T10609 */
export interface WorkGraphContextPack {
  /** Requested graph scope root. */
  readonly rootId: string;
  /** ISO timestamp when the pack was generated. */
  readonly generatedAt: string;
  /** Budget accounting for the selected payload. */
  readonly budget: WorkGraphContextBudget;
  /** Hierarchy/tree slice selected for the pack. */
  readonly slice: WorkGraphSlice;
  /** Optional relation/dependency edges when requested and within budget. */
  readonly relationEdges?: WorkGraphRelationEdgesResult;
  /** Optional readiness grouping when requested and within budget. */
  readonly readiness?: WorkGraphReadinessResult;
  /** Optional subtree rollup when requested and within budget. */
  readonly rollup?: WorkGraphSubtreeSummaryResult;
  /** Omitted/truncated members with reasons. */
  readonly omissions: readonly WorkGraphOmission[];
}

/** Parameters for reading a bounded graph slice around a root. @task T10609 */
export interface WorkGraphSliceParams extends WorkGraphPaginationOptions {
  /** Root task/saga/epic whose slice should be projected. */
  readonly rootId: string;
  /** Traversal direction for the slice. */
  readonly direction?: WorkGraphTraversalDirection;
  /** Optional maximum edge depth for the slice. */
  readonly maxDepth?: number;
  /** Include direct relation/dependency edges adjacent to returned nodes. */
  readonly includeRelations?: boolean;
}

/** Bounded graph slice that carries nodes, edges, and pagination metadata together. @task T10609 */
export interface WorkGraphSlice extends WorkGraphSnapshot {
  /** Requested graph scope root. */
  readonly rootId: string;
  /** Direction used to materialize this slice. */
  readonly direction: WorkGraphTraversalDirection;
  /** Page metadata for cursor-based follow-up calls. */
  readonly pageInfo: WorkGraphPageInfo;
  /** Optional omission diagnostics when budget or pagination trims the slice. */
  readonly omissions?: readonly WorkGraphOmission[];
}

/** Parameters for direct WorkGraph readiness checks. @task T10609 */
export interface WorkGraphReadinessParams {
  /** Root task/saga/epic whose descendants should be checked. */
  readonly rootId: string;
  /** Optional SQL task-role/kind filter applied before grouping. */
  readonly role?: string;
  /** Include gate blockers in addition to dependency blockers. */
  readonly includeGateBlockers?: boolean;
}

/** Contract-backed readiness result with an explicit ready boolean. @task T10609 */
export interface WorkGraphReadinessResult extends WorkGraphReadyFrontierResult {
  /** True when at least one task is ready and no requested scope invariant failed. */
  readonly ready: boolean;
  /** Non-fatal readiness diagnostics. */
  readonly warnings: readonly string[];
}

/** Parameters for validating WorkGraph scaffold inputs before applying them. @task T10609 */
export interface WorkGraphScaffoldValidateParams {
  /** Root task/saga/epic that owns the scaffold proposal. */
  readonly rootId: string;
  /** Proposed nodes to create or reconcile. */
  readonly nodes: readonly WorkGraphHierarchyInputNode[];
  /** Proposed direct edges/relations to create or reconcile. */
  readonly edges?: readonly WorkGraphDirectEdge[];
  /** Preview validation only; echoed for callers that share validate/apply plumbing. */
  readonly dryRun?: boolean;
}

/** Validation diagnostic for a WorkGraph scaffold proposal. @task T10609 */
export interface WorkGraphScaffoldValidationIssue {
  /** Stable validation code. */
  readonly code: string;
  /** Human-readable validation message. */
  readonly message: string;
  /** Task or edge endpoint associated with the issue, when available. */
  readonly taskId?: string;
  /** Severity controls whether apply may proceed. */
  readonly severity: 'error' | 'warning';
}

/** Result contract for WorkGraph scaffold validation. @task T10609 */
export interface WorkGraphScaffoldValidateResult {
  /** Root task/saga/epic used for validation. */
  readonly rootId: string;
  /** True when no error-severity issues were found. */
  readonly valid: boolean;
  /** Echoes whether this was a dry-run validation. */
  readonly dryRun: boolean;
  /** Structured validation issues. */
  readonly issues: readonly WorkGraphScaffoldValidationIssue[];
  /** Hierarchy invariant result for the proposed nodes. */
  readonly hierarchy: WorkGraphHierarchyValidationResult;
}

/** Parameters for applying a previously validated WorkGraph scaffold proposal. @task T10609 */
export interface WorkGraphScaffoldApplyParams extends WorkGraphScaffoldValidateParams {
  /** Require callers to pass true to perform writes; false/omitted means preview. */
  readonly apply?: boolean;
}

// ---------------------------------------------------------------------------
// Planning Doc Generator (T10634)
// ---------------------------------------------------------------------------

/** Target audience for planning doc output. @task T10634 */
export type WorkGraphAudienceMode = 'agent' | 'maintainer';

/** Parameters for generating a planning doc from WorkGraph data. @task T10634 */
export interface WorkGraphPlanningDocParams {
  /** Root saga/epic whose graph should drive the planning doc. */
  readonly rootId: string;
  /** Audience mode — 'agent' for terse/LLM-optimized, 'maintainer' for human-readable. */
  readonly audience: WorkGraphAudienceMode;
  /** Optional token budget for agent-mode truncation. */
  readonly tokenBudget?: number;
  /** Include direct relation/dependency edges in the doc. */
  readonly includeRelations?: boolean;
  /** Include readiness grouping. */
  readonly includeReadiness?: boolean;
  /** Include rollup summary. */
  readonly includeRollup?: boolean;
}

/** Planning doc generated from WorkGraph data. @task T10634 */
export interface WorkGraphPlanningDoc {
  /** Requested root saga/epic ID. */
  readonly rootId: string;
  /** ISO timestamp when the doc was generated. */
  readonly generatedAt: string;
  /** Audience mode used for generation. */
  readonly audience: WorkGraphAudienceMode;
  /** Document title derived from the root task. */
  readonly title: string;
  /** Generated markdown content. */
  readonly content: string;
  /** Top-level section headings for TOC/navigation. */
  readonly sections: readonly string[];
  /** Estimated token count for the generated content. */
  readonly estimatedTokens: number;
  /** Budget accounting when tokenBudget is provided. */
  readonly budget?: {
    /** Caller-provided token budget. */
    readonly tokenBudget: number;
    /** Whether content was truncated to fit budget. */
    readonly truncated: boolean;
  };
}

/** Result contract for applying a WorkGraph scaffold proposal. @task T10609 */
export interface WorkGraphScaffoldApplyResult extends WorkGraphScaffoldValidateResult {
  /** True when mutations were written. */
  readonly applied: boolean;
  /** Number of nodes created or reconciled. */
  readonly nodesChanged: number;
  /** Number of edges created or reconciled. */
  readonly edgesChanged: number;
}

const taskTypeSchema = z.enum(['saga', 'epic', 'task', 'subtask']);
const taskPrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);
const taskStatusSchema = z.enum(TASK_STATUSES);
const verificationGateSchema = z.enum([
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
  'nexusImpact',
]);
const workGraphRelationKindSchema = z.enum([
  'contains',
  'depends_on',
  'blocks',
  'relates_to',
  'groups',
  'satisfies',
]);
const workGraphTraversalDirectionSchema = z.enum([
  'ancestors',
  'descendants',
  'upstream',
  'downstream',
]);
const workGraphEdgeDirectionSchema = z.enum(['out', 'in', 'both']);
const paginationParamsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
const workGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: taskTypeSchema,
  title: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  parentId: z.string().min(1).optional(),
});
const workGraphEdgeSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: workGraphRelationKindSchema,
});
const workGraphHierarchyEdgeSchema = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
    kind: z.literal('contains'),
  })
  .strict();
const workGraphPageInfoSchema = z.object({
  nextCursor: z.string().min(1).optional(),
  hasMore: z.boolean(),
});
const workGraphRollupCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: z.partialRecord(taskStatusSchema, z.number().int().nonnegative()),
  byType: z.partialRecord(taskTypeSchema, z.number().int().nonnegative()),
});
const workGraphSubtreePercentagesSchema = z.object({
  done: z.number().nonnegative(),
  active: z.number().nonnegative(),
  blocked: z.number().nonnegative(),
  pending: z.number().nonnegative(),
  cancelled: z.number().nonnegative(),
});
const workGraphProjectionMismatchSchema = z.object({
  field: z.string().min(1),
  expected: z.number().int().nonnegative(),
  actual: z.number().int().nonnegative(),
});
const workGraphReadyFrontierTaskSchema = workGraphNodeSchema.extend({
  role: z.string().min(1).optional(),
  dependencyBlockers: z.array(z.object({ taskId: z.string().min(1), status: taskStatusSchema })),
  gateBlockers: z.array(z.object({ gate: verificationGateSchema })),
});
const workGraphRelationEdgeSchema = workGraphEdgeSchema.extend({
  source: z.literal('relation'),
  relationType: z.enum(TASK_RELATION_TYPES),
  reason: z.string().min(1).optional(),
});
const workGraphDependencyEdgeSchema = workGraphEdgeSchema.extend({
  source: z.literal('dependency'),
  kind: z.literal('depends_on'),
});

const workGraphOmissionReasonSchema = z.enum([
  'budget_exceeded',
  'not_requested',
  'not_available',
  'redacted',
  'truncated',
]);
const workGraphContextBudgetSchema = z.object({
  tokenBudget: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
const workGraphOmissionSchema = z.object({
  path: z.string().min(1),
  reason: workGraphOmissionReasonSchema,
  message: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative().optional(),
});
const workGraphDirectEdgeSchema = z.discriminatedUnion('source', [
  workGraphRelationEdgeSchema,
  workGraphDependencyEdgeSchema,
]);

/** Zod params for a bounded WorkGraph context pack. @task T10609 */
export const workGraphContextPackParamsSchema = paginationParamsSchema.extend({
  rootId: z.string().min(1),
  tokenBudget: z.number().int().positive().optional(),
  includeRelations: z.boolean().optional(),
  includeReadiness: z.boolean().optional(),
  includeRollup: z.boolean().optional(),
});

/** Zod params for a bounded WorkGraph graph slice. @task T10609 */
export const workGraphSliceParamsSchema = paginationParamsSchema.extend({
  rootId: z.string().min(1),
  direction: workGraphTraversalDirectionSchema.optional(),
  maxDepth: z.number().int().nonnegative().optional(),
  includeRelations: z.boolean().optional(),
});

/** Zod result contract for a bounded WorkGraph graph slice. @task T10609 */
export const workGraphSliceSchema = z.object({
  rootId: z.string().min(1),
  direction: workGraphTraversalDirectionSchema,
  nodes: z.array(workGraphNodeSchema),
  edges: z.array(workGraphEdgeSchema),
  pageInfo: workGraphPageInfoSchema,
  omissions: z.array(workGraphOmissionSchema).optional(),
});

/** Zod params for direct WorkGraph readiness checks. @task T10609 */
export const workGraphReadinessParamsSchema = z.object({
  rootId: z.string().min(1),
  role: z.string().min(1).optional(),
  includeGateBlockers: z.boolean().optional(),
});

/** Zod result contract for direct WorkGraph readiness checks. @task T10609 */
export const workGraphReadinessResultSchema = z.object({
  rootId: z.string().min(1),
  role: z.string().min(1).optional(),
  ready: z.boolean(),
  warnings: z.array(z.string()),
  groups: z.object({
    ready: z.array(workGraphReadyFrontierTaskSchema),
    blocked: z.array(workGraphReadyFrontierTaskSchema),
    blockedBy: z.array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('dependency'),
          blockerId: z.string().min(1),
          blocks: z.array(z.string().min(1)),
        }),
        z.object({
          kind: z.literal('gate'),
          gate: verificationGateSchema,
          blocks: z.array(z.string().min(1)),
        }),
      ]),
    ),
  }),
});

/** Zod result contract for a bounded WorkGraph context pack. @task T10609 */
export const workGraphContextPackSchema = z.object({
  rootId: z.string().min(1),
  generatedAt: z.string().min(1),
  budget: workGraphContextBudgetSchema,
  slice: workGraphSliceSchema,
  relationEdges: z
    .object({
      rootId: z.string().min(1),
      direction: workGraphEdgeDirectionSchema,
      edges: z.array(workGraphDirectEdgeSchema),
    })
    .optional(),
  readiness: workGraphReadinessResultSchema.optional(),
  rollup: z.lazy(() => tasksRollupResultSchema).optional(),
  omissions: z.array(workGraphOmissionSchema),
});

/** Zod params for WorkGraph scaffold validation. @task T10609 */
export const workGraphScaffoldValidateParamsSchema = z.object({
  rootId: z.string().min(1),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      type: taskTypeSchema,
      parentId: z.string().min(1).nullable().optional(),
    }),
  ),
  edges: z.array(workGraphDirectEdgeSchema).optional(),
  dryRun: z.boolean().optional(),
});

const workGraphScaffoldValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  taskId: z.string().min(1).optional(),
  severity: z.enum(['error', 'warning']),
});

/** Zod result contract for WorkGraph scaffold validation. @task T10609 */
export const workGraphScaffoldValidateResultSchema = z.object({
  rootId: z.string().min(1),
  valid: z.boolean(),
  dryRun: z.boolean(),
  issues: z.array(workGraphScaffoldValidationIssueSchema),
  hierarchy: z.object({
    valid: z.boolean(),
    violations: z.array(
      z.object({
        code: z.literal(E_WORKGRAPH_PARENT_TYPE_MATRIX),
        taskId: z.string().min(1),
        taskType: taskTypeSchema,
        parentId: z.string().min(1).nullable(),
        parentType: taskTypeSchema.optional(),
        message: z.string().min(1),
      }),
    ),
  }),
});

/** Zod params for WorkGraph scaffold apply. @task T10609 */
export const workGraphScaffoldApplyParamsSchema = workGraphScaffoldValidateParamsSchema.extend({
  apply: z.boolean().optional(),
});

/** Zod result contract for WorkGraph scaffold apply. @task T10609 */
export const workGraphScaffoldApplyResultSchema = workGraphScaffoldValidateResultSchema.extend({
  applied: z.boolean(),
  nodesChanged: z.number().int().nonnegative(),
  edgesChanged: z.number().int().nonnegative(),
});

/** Zod params for WorkGraph planning doc generation. @task T10634 */
export const workGraphPlanningDocParamsSchema = z.object({
  rootId: z.string().min(1),
  audience: z.enum(['agent', 'maintainer']),
  tokenBudget: z.number().int().positive().optional(),
  includeRelations: z.boolean().optional(),
  includeReadiness: z.boolean().optional(),
  includeRollup: z.boolean().optional(),
});

/** Zod result contract for WorkGraph planning doc. @task T10634 */
export const workGraphPlanningDocSchema = z.object({
  rootId: z.string().min(1),
  generatedAt: z.string().min(1),
  audience: z.enum(['agent', 'maintainer']),
  title: z.string().min(1),
  content: z.string(),
  sections: z.array(z.string().min(1)),
  estimatedTokens: z.number().int().nonnegative(),
  budget: z
    .object({
      tokenBudget: z.number().int().positive(),
      truncated: z.boolean(),
    })
    .optional(),
});

/** Zod params for `tasks.traverse`. */
export const tasksTraverseParamsSchema = paginationParamsSchema.extend({
  rootId: z.string().min(1),
  direction: workGraphTraversalDirectionSchema,
  maxDepth: z.number().int().nonnegative().optional(),
  includeRelations: z.boolean().optional(),
});

/** Zod result contract for `tasks.traverse`. */
export const tasksTraverseResultSchema = z.object({
  rootId: z.string().min(1),
  direction: workGraphTraversalDirectionSchema,
  nodes: z.array(workGraphNodeSchema),
  edges: z.array(workGraphEdgeSchema),
  pageInfo: workGraphPageInfoSchema,
});

/** Zod params for `tasks.tree`. */
export const tasksTreeParamsSchema = paginationParamsSchema.extend({
  rootId: z.string().min(1),
  maxDepth: z.number().int().nonnegative().optional(),
});

/** Zod result contract for `tasks.tree`. */
export const tasksTreeResultSchema = z.object({
  rootId: z.string().min(1),
  nodes: z.array(workGraphNodeSchema.extend({ depth: z.number().int().positive() })),
  edges: z.array(workGraphHierarchyEdgeSchema),
  pageInfo: workGraphPageInfoSchema,
});

/** Zod params for `tasks.rollup`. */
export const tasksRollupParamsSchema = z.object({
  rootId: z.string().min(1),
  expectedDirectRollup: workGraphRollupCountsSchema.optional(),
});

/** Zod result contract for `tasks.rollup`. */
export const tasksRollupResultSchema = z.object({
  rootId: z.string().min(1),
  direct: workGraphRollupCountsSchema,
  subtree: workGraphRollupCountsSchema,
  percentDenominator: z.object({
    basis: z.literal('subtree-total'),
    total: z.number().int().nonnegative(),
    description: z.string().min(1),
  }),
  percentages: workGraphSubtreePercentagesSchema,
  staleProjection: z.boolean(),
  projectionMismatches: z.array(workGraphProjectionMismatchSchema),
});

/** Zod params for `tasks.frontier`. */
export const tasksFrontierParamsSchema = z.object({
  rootId: z.string().min(1),
  role: z.string().min(1).optional(),
});

/** Zod result contract for `tasks.frontier`. */
export const tasksFrontierResultSchema = z.object({
  rootId: z.string().min(1),
  role: z.string().min(1).optional(),
  groups: z.object({
    ready: z.array(workGraphReadyFrontierTaskSchema),
    blocked: z.array(workGraphReadyFrontierTaskSchema),
    blockedBy: z.array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('dependency'),
          blockerId: z.string().min(1),
          blocks: z.array(z.string().min(1)),
        }),
        z.object({
          kind: z.literal('gate'),
          gate: verificationGateSchema,
          blocks: z.array(z.string().min(1)),
        }),
      ]),
    ),
  }),
});

/** Zod params for `tasks.workgraph.audit`. */
export const tasksWorkGraphAuditParamsSchema = paginationParamsSchema.extend({
  rootId: z.string().min(1),
  maxDepth: z.number().int().nonnegative().optional(),
  includeRelations: z.boolean().optional(),
});

/** Zod result contract for `tasks.workgraph.audit`. */
export const tasksWorkGraphAuditResultSchema = z.object({
  rootId: z.string().min(1),
  hierarchy: z.object({
    valid: z.boolean(),
    violations: z.array(
      z.object({
        code: z.literal(E_WORKGRAPH_PARENT_TYPE_MATRIX),
        taskId: z.string().min(1),
        taskType: taskTypeSchema,
        parentId: z.string().min(1).nullable(),
        parentType: taskTypeSchema.optional(),
        message: z.string().min(1),
      }),
    ),
  }),
  traversal: tasksTraverseResultSchema,
  frontier: tasksFrontierResultSchema,
  rollup: tasksRollupResultSchema,
  relationEdges: z
    .object({
      rootId: z.string().min(1),
      direction: workGraphEdgeDirectionSchema,
      edges: z.array(
        z.discriminatedUnion('source', [
          workGraphRelationEdgeSchema,
          workGraphDependencyEdgeSchema,
        ]),
      ),
    })
    .optional(),
});

export type TasksTraverseParamsInput = z.input<typeof tasksTraverseParamsSchema>;
export type TasksTreeParamsInput = z.input<typeof tasksTreeParamsSchema>;
export type TasksRollupParamsInput = z.input<typeof tasksRollupParamsSchema>;
export type TasksFrontierParamsInput = z.input<typeof tasksFrontierParamsSchema>;
export type TasksWorkGraphAuditParamsInput = z.input<typeof tasksWorkGraphAuditParamsSchema>;

/** Minimal public reader facade for future WorkGraph implementations. */
export interface WorkGraphReader {
  /** Read a graph snapshot for the current project context. */
  snapshot(): Promise<WorkGraphSnapshot> | WorkGraphSnapshot;
  /** Traverse from a root node using storage-hidden graph semantics. */
  traverse(
    options: WorkGraphTraversalOptions,
  ): Promise<WorkGraphTraversalResult> | WorkGraphTraversalResult;
  /** Read a paginated descendant tree rooted at a task-like node. */
  tree(options: WorkGraphTreeOptions): Promise<WorkGraphTreeResult> | WorkGraphTreeResult;
  /** Read direct and full-subtree rollup counts rooted at a task-like node. */
  summarizeSubtree(
    options: WorkGraphSubtreeSummaryOptions,
  ): Promise<WorkGraphSubtreeSummaryResult> | WorkGraphSubtreeSummaryResult;
}

/** Task vertex returned by containment-only WorkGraph queries. */
export type WorkGraphContainmentNode = WorkGraphNode;

/** Ancestor chain for one requested WorkGraph root. */
export interface WorkGraphContainmentAncestorsResult {
  /** Requested task ID. */
  readonly rootId: string;
  /** Ancestors ordered from hierarchy root down to direct parent. */
  readonly ancestors: readonly WorkGraphContainmentNode[];
}

/** Direct children for one requested WorkGraph parent. */
export interface WorkGraphContainmentChildrenResult {
  /** Requested parent task ID. */
  readonly rootId: string;
  /** Direct children ordered by task position/creation order. */
  readonly children: readonly WorkGraphContainmentNode[];
}

/**
 * Storage-backed containment lookup facade.
 *
 * Implementations MUST answer from `tasks.parent_id` only. They MUST NOT read
 * `task_relations`, including `groups`, because Saga membership is not direct
 * containment.
 */
export interface WorkGraphContainmentQueryService {
  /** Load ancestor chains for many roots in one batched query. */
  getAncestors(rootIds: readonly string[]): readonly WorkGraphContainmentAncestorsResult[];
  /** Load direct children for many parents in one batched query. */
  getChildren(parentIds: readonly string[]): readonly WorkGraphContainmentChildrenResult[];
  /** Group dependency-ready and dependency-blocked descendants for one scope. */
  readyFrontier(options: WorkGraphReadyFrontierOptions): WorkGraphReadyFrontierResult;
}

/** Storage-backed relation lookup facade for direct non-containment graph edges. */
export interface WorkGraphRelationQueryService {
  /**
   * List direct edges around `rootId` using `task_relations` by default.
   * Implementations MUST NOT conflate scheduler dependencies with relation rows;
   * dependency edges are included only when explicitly requested and remain
   * tagged as `source: 'dependency'`.
   */
  listRelationEdges(options: WorkGraphRelationEdgesOptions): WorkGraphRelationEdgesResult;
}

/** Minimal task hierarchy row accepted by the WorkGraph invariant validator. */
export interface WorkGraphHierarchyInputNode {
  /** Stable task, saga, epic, or subtask identifier. */
  readonly id: string;
  /** Canonical hierarchy discriminator for the node. */
  readonly type: TaskType;
  /** Direct containment parent; absent/null means root. */
  readonly parentId?: string | null;
}

/** Structured hierarchy invariant violation for CLI/API callers. */
export interface WorkGraphHierarchyViolation {
  /** Stable machine-readable error code. */
  readonly code: typeof E_WORKGRAPH_PARENT_TYPE_MATRIX;
  /** Child node that violates the parent/type matrix. */
  readonly taskId: string;
  /** Child node type. */
  readonly taskType: TaskType;
  /** Parent ID when present; null for invalid root/non-root shape. */
  readonly parentId: string | null;
  /** Parent type when parent row is known. */
  readonly parentType?: TaskType;
  /** Human-readable remediation summary. */
  readonly message: string;
}

/** Result returned by the WorkGraph hierarchy invariant validator. */
export interface WorkGraphHierarchyValidationResult {
  /** True when every node satisfies the parent/type matrix. */
  readonly valid: boolean;
  /** Ordered list of matrix violations in input order. */
  readonly violations: readonly WorkGraphHierarchyViolation[];
}

/** Options for WorkGraph hierarchy invariant validation. */
export interface WorkGraphHierarchyValidationOptions {
  /** Throw on the first violation instead of returning all diagnostics. */
  readonly throwOnViolation?: boolean;
}

const ROOT_TASK_TYPES: ReadonlySet<TaskType> = new Set(['saga', 'epic']);

const PARENT_TYPE_MATRIX: Readonly<Record<TaskType, readonly TaskType[]>> = {
  saga: [],
  epic: ['saga'],
  task: ['epic'],
  subtask: ['task'],
};

/**
 * Return true when the task type can exist without a parent in the canonical
 * PM-Core V2 containment tree.
 *
 * @param type - Task type to test.
 */
export function canWorkGraphTaskTypeBeRoot(type: TaskType): boolean {
  return ROOT_TASK_TYPES.has(type);
}

/**
 * Return true when a parent type can contain a child type in the canonical
 * PM-Core V2 containment tree.
 *
 * @param childType - Child task type.
 * @param parentType - Candidate parent task type.
 */
export function isAllowedWorkGraphParentType(childType: TaskType, parentType: TaskType): boolean {
  return PARENT_TYPE_MATRIX[childType].includes(parentType);
}

function describeAllowedParents(type: TaskType): string {
  const allowed = PARENT_TYPE_MATRIX[type];
  return allowed.length === 0 ? 'root only' : allowed.join('|');
}

function formatHierarchyViolation(violation: WorkGraphHierarchyViolation): string {
  return `${violation.code}: task ${violation.taskId} type=${violation.taskType} parent=${violation.parentId ?? '<root>'} parentType=${violation.parentType ?? '<missing>'}; ${violation.message}`;
}

/** Error thrown by fail-fast WorkGraph hierarchy validation. */
export class WorkGraphHierarchyInvariantError extends Error {
  /** Stable machine-readable code for the invariant breach. */
  readonly code = E_WORKGRAPH_PARENT_TYPE_MATRIX;

  /** Structured diagnostic for the first hierarchy invariant violation. */
  readonly violation: WorkGraphHierarchyViolation;

  /**
   * Build a WorkGraph hierarchy invariant error from a structured violation.
   * @param violation - The first violation encountered by the validator.
   */
  constructor(violation: WorkGraphHierarchyViolation) {
    super(formatHierarchyViolation(violation));
    this.name = 'WorkGraphHierarchyInvariantError';
    this.violation = violation;
  }
}

function makeViolation(
  node: WorkGraphHierarchyInputNode,
  parent: WorkGraphHierarchyInputNode | undefined,
): WorkGraphHierarchyViolation {
  const parentId = node.parentId ?? null;
  const parentType = parent?.type;
  const expected = describeAllowedParents(node.type);
  const actual = parentId === null ? 'root' : (parentType ?? 'missing parent');
  return {
    code: E_WORKGRAPH_PARENT_TYPE_MATRIX,
    taskId: node.id,
    taskType: node.type,
    parentId,
    parentType,
    message: `tasks.parent_id must follow saga->epic, epic->task, and task->subtask; sagas and standalone epics may be roots; expected ${node.type} parent ${expected}, got ${actual}`,
  };
}

/**
 * Validate WorkGraph hierarchy rows against CLEO's canonical type/parent matrix.
 *
 * The validator mirrors the SQLite trigger invariant in a storage-agnostic form
 * for core adapters, projections, and API callers: sagas and standalone epics
 * may be roots, sagas may contain epics, epics may contain tasks, tasks may
 * contain subtasks, and subtasks are leaves. Saga membership uses `parentId`
 * containment, never `task_relations.groups`.
 *
 * @param nodes - Task-like hierarchy rows to validate.
 * @param options - Optional fail-fast behavior for enforcement call sites.
 * @returns Structured validation result with all violations in input order.
 * @task T10576
 * @saga T10538
 */
export function validateWorkGraphHierarchy(
  nodes: readonly WorkGraphHierarchyInputNode[],
  options: WorkGraphHierarchyValidationOptions = {},
): WorkGraphHierarchyValidationResult {
  const byId = new Map<string, WorkGraphHierarchyInputNode>();
  for (const node of nodes) byId.set(node.id, node);

  const violations: WorkGraphHierarchyViolation[] = [];
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    const parent = parentId === null ? undefined : byId.get(parentId);
    const allowedParents = PARENT_TYPE_MATRIX[node.type];
    const valid =
      parentId === null
        ? canWorkGraphTaskTypeBeRoot(node.type)
        : parent !== undefined && isAllowedWorkGraphParentType(node.type, parent.type);

    if (!valid) {
      const violation = makeViolation(node, parent);
      if (options.throwOnViolation) throw new WorkGraphHierarchyInvariantError(violation);
      violations.push(violation);
    }
  }

  return { valid: violations.length === 0, violations };
}
