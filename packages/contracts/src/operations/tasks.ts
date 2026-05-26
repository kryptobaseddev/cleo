/**
 * Tasks Domain Operations — wire-format contracts for the tasks dispatch domain.
 *
 * Contains only types that appear in the `TasksOps` discriminated union (the
 * authoritative wire-format spec) plus shared primitives (`TaskOp`,
 * `MinimalTask`, `TaskPriority`, `TaskStatus`) used cross-domain.
 *
 * Legacy pre-dispatch aliases (`TasksCreateParams`, `TasksUpdateParams`, etc.)
 * were removed in T1446 (T1435-W2). Use the dispatch-level types
 * (`TasksAddParams`, `TasksUpdateQueryParams`, etc.) that appear in `TasksOps`.
 *
 * Canonical type definitions live in the contracts package at:
 *   packages/contracts/src/task.ts (TaskStatus, TaskPriority, Task, etc.)
 * These operation types are the API contract (wire format).
 * Internal domain types import from the canonical location above.
 *
 * @task T1446 — strip redundant Params/Result aliases (T1435-W2)
 * @task T1703 — Fill Result=unknown stubs with canonical typed shapes
 */

import type { ImpactReport } from '../facade.js';
import type { TaskAnalysisResult, TaskRef } from '../results.js';
/**
 * Common task types (API contract — matches CLI src/types/task.ts)
 */
import type { TaskStatus } from '../status-registry.js';
import type { TaskPriority, TaskType } from '../task.js';
import type { TaskRecord } from '../task-record.js';
import type { ExternalTask, ExternalTaskLink, ReconcileResult } from '../task-sync.js';
import type {
  CompletionEvaluateParams,
  CompletionEvaluateResult,
  CompletionExplainParams,
  CompletionExplainResult,
  CompletionListParams,
  CompletionListResult,
  CompletionProjectionRepairParams,
  CompletionProjectionRepairResult,
  TaskComplexityFactor,
  TaskDependsResult,
  TaskLabelInfo,
  TaskMutationDryRunSummary,
  TaskMutationEnvelope,
  TaskMutationWarning,
  TaskPlanResult,
  TaskTreeNode,
  TaskView,
} from '../tasks.js';
import type { DocsType } from './docs.js';
import type { JsonSchema, OperationInputContract } from './input-contract.js';

export type { TaskPriority, TaskStatus };

export interface TaskOp {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority?: TaskPriority;
  parent?: string;
  depends?: string[];
  labels?: string[];
  created: string;
  updated: string;
  completed?: string;
  notes?: string[];
}

export interface MinimalTask {
  id: string;
  title: string;
  status: TaskStatus;
  parent?: string;
}

/**
 * Query Operations
 */

// tasks.list
export interface TasksListParams {
  parent?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: string;
  phase?: string;
  label?: string;
  children?: boolean;
  limit?: number;
  offset?: number;
  compact?: boolean;
}
export interface TasksListResult {
  tasks: TaskOp[];
  total: number;
  filtered: number;
}

// tasks.find
/**
 * Parameters for `tasks.find`.
 *
 * @remarks
 * Re-synced to match `taskFind(projectRoot, query, limit, options)` in the
 * dispatch layer. Legacy contract exposed only `{query, limit}` and hid
 * the 7 additional filter options agents actually need.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface TasksFindParams {
  /** Free-text search query. @task T963 */
  query: string;
  /** Max results. @task T963 */
  limit?: number;
  /** Exact task ID lookup (bypasses search). @task T963 */
  id?: string;
  /** When true, require exact string match instead of fuzzy. @task T963 */
  exact?: boolean;
  /** Filter by status. @task T963 */
  status?: TaskStatus;
  /** When true, include archived tasks in the search. @task T963 */
  includeArchive?: boolean;
  /** Offset into the results (pagination). @task T963 */
  offset?: number;
  /**
   * Comma-separated field projection (e.g. `'id,title,status'`) to shrink
   * the wire payload.
   * @task T963
   */
  fields?: string;
  /** When true, emit verbose per-match diagnostic fields. @task T963 */
  verbose?: boolean;
  /**
   * Filter by kind axis (T944 — orthogonal axes). Renamed from role per T9072.
   * @task T963 / T944
   * @task T9072
   */
  kind?: string;
  /**
   * Unified urgency surface (T9905).
   *
   * When `true`, the predicate is
   *
   *   `priority IN ('critical','high') OR severity IN ('P0','P1')`
   *
   * combining the two orthogonal urgency axes (priority + severity) into a
   * single filter. Composes with other filters via AND.
   *
   * @task T9905
   */
  urgent?: boolean;
  /**
   * Filter by label — selects tasks whose `labels` array contains this
   * value. Composes with other filters via AND.
   *
   * Closes GH#393 — gives `cleo find --label <name>` parity with the
   * positional `cleo labels <name>` surface.
   *
   * @task T9904
   */
  label?: string;
  /**
   * Filter by parent task ID — restricts the result set to tasks whose
   * `parentId` equals this value. Mirrors the `--parent` axis on
   * `cleo list`. When the parent task is a Saga (Epic with
   * `label='saga'`), routing goes through `task_relations.type='groups'`
   * member IDs instead of the `parentId` column (ADR-073 §1).
   *
   * Composes with other filters via AND. Closes T10108 — pre-fix,
   * `cleo find "" --parent <id>` returned every task in the project
   * because the empty-string query bypassed all filters via
   * `fuzzyScore('', '<title>')===80`.
   *
   * @task T10108
   * @saga T9862
   */
  parent?: string;
}
export type TasksFindResult = MinimalTask[];

/**
 * Mutate Operations
 */

// tasks.current (get currently active task)
export type TasksCurrentParams = Record<string, never>;
export interface TasksCurrentResult {
  taskId: string | null;
  since?: string;
  sessionId?: string;
}

// tasks.show (with optional history/ivtrHistory/relations flags)
export interface TasksShowParams {
  taskId: string;
  /** When true, include task change history. */
  history?: boolean;
  /** When true, include IVTR phase history. */
  ivtrHistory?: boolean;
  /** When true, include expanded relation/doc ID lists alongside compact counts. */
  relations?: boolean;
}

/**
 * Minimal attachment entry surfaced in the `tasks.show` envelope.
 *
 * A lightweight projection of a docs attachment — enough to identify and
 * navigate to the full attachment via `cleo docs fetch <slug|id>`, without
 * the full byte payload.
 *
 * Fields are a subset of {@link import('./docs.js').DocsAttachmentRow}:
 *   - `attachmentId` — store ID (att_* or UUID)
 *   - `slug`         — human-friendly name (present when set on `cleo docs add`)
 *   - `type`         — taxonomy classification (e.g. 'adr', 'research')
 *   - `kind`         — storage kind ('local-file', 'url', 'blob', etc.)
 *
 * @task T9966
 * @epic T9964
 */
export interface TaskShowAttachmentEntry {
  /** Attachment identifier (att_* or UUID). */
  attachmentId: string;
  /** Human-friendly slug, unique per project. Present when assigned at add time. */
  slug?: string;
  /** Taxonomy classification. Present when assigned at add time. */
  type?: DocsType;
  /** Storage kind — discriminant for the full attachment variant. */
  kind: string;
}

export interface TaskShowRelationsEntry {
  /** Direct dependency IDs. */
  depends: string[];
  /** Explicit blockedBy entries from the task record. */
  blockedBy: string[];
  /** Non-dependency task relation links. */
  relates: Array<{ taskId: string; type: string; reason?: string }>;
  /** Direct child task IDs. */
  children: string[];
  /** Linked docs attachment IDs/slugs. */
  docs: Array<{ attachmentId: string; slug?: string; type?: DocsType; kind: string }>;
}

/**
 * Result of `tasks.show` — the full task record plus its canonical view
 * projection. `view` is null when the task has no lifecycle pipeline.
 *
 * @task T1703
 * @task T9966 — attachments[] always present (empty array when none)
 */
export interface TasksShowResult {
  /** Full task record (string-widened for dispatch layer serialization). */
  task: TaskRecord;
  /** Canonical task view projection produced by `computeTaskView`. Null when unavailable. */
  view: TaskView | null;
  /**
   * Attachments linked to this task via the docs store.
   *
   * Always an array — empty (`[]`) when no attachments exist. Never `null`.
   * Each entry carries enough context to navigate to the full attachment
   * via `cleo docs fetch <slug|attachmentId>`.
   *
   * @task T9966
   */
  attachments: TaskShowAttachmentEntry[];
  /**
   * Acceptance-criterion rows hydrated from the `task_acceptance_criteria`
   * table (T10502). Each entry carries the stable UUID `id`, the
   * `AC<ordinal>` alias, the ordinal itself, and the canonical AC text.
   *
   * Optional — undefined when the task has no rows in the table (e.g.
   * legacy tasks not yet backfilled by T10505). Consumers should fall
   * back to `task.acceptance` (the legacy JSON string) in that case.
   *
   * @task T10508
   * @epic T10381
   */
  acRows?: TaskShowAcRowEntry[];
  /** Expanded relation/doc lists returned only when `cleo show --relations` is requested. */
  relations?: TaskShowRelationsEntry;
}

/**
 * One acceptance-criterion entry in {@link TasksShowResult.acRows}.
 *
 * Mirrors the `AcDetail` shape from `@cleocode/core/tasks/show.js` but
 * lives in contracts so dispatch-layer consumers don't depend on core.
 *
 * @task T10508
 */
export interface TaskShowAcRowEntry {
  /** UUIDv4 stable identifier, immutable for the AC's lifetime. */
  id: string;
  /** Display alias derived from ordinal — `AC1`, `AC2`, etc. */
  alias: string;
  /** 1-based ordinal — never reused per task (gaps remain on shrink). */
  ordinal: number;
  /** The AC statement text. Structured gates round-trip as JSON. */
  text: string;
}

// tasks.tree dispatch params (with optional withBlockers flag — dispatch alias)
export interface TasksTreeDispatchParams {
  taskId?: string;
  withBlockers?: boolean;
}
/**
 * Result of `tasks.tree` — the hierarchical task tree.
 *
 * @task T1703
 */
export interface TasksTreeDispatchResult {
  /** Hierarchical tree of task nodes. */
  tree: TaskTreeNode[];
  /** Total number of nodes (tasks) in the tree. */
  totalNodes: number;
}

// tasks.blockers dispatch params (with optional analyze/limit)
export interface TasksBlockersQueryParams {
  analyze?: boolean;
  limit?: number;
}
/**
 * Result of `tasks.blockers` — blocked tasks with blocking chain analysis.
 *
 * @task T1703
 */
export interface TasksBlockersQueryResult {
  /** Tasks that are currently blocked. */
  blockedTasks: Array<{
    id: string;
    title: string;
    status: string;
    depends?: string[];
    blockingChain: string[];
  }>;
  /** Tasks that block the most other tasks (critical path). */
  criticalBlockers: Array<{ id: string; title: string; blocksCount: number }>;
  /** Human-readable summary of the blocking situation. */
  summary: string;
  /** Total number of blocked tasks. */
  total: number;
  /** Maximum number of blocked tasks returned. */
  limit: number;
}

// tasks.depends (with action routing for overview/cycles)
export interface TasksDependsParams {
  taskId?: string;
  direction?: 'upstream' | 'downstream' | 'both';
  tree?: boolean;
  action?: 'overview' | 'cycles';
}
/**
 * Result of `tasks.depends` — dependency analysis for a task or the full project.
 *
 * When `action='overview'` or `action='cycles'` is used, returns a different
 * shape (overview or cycle-detection result). The base shape covers the
 * per-task dependency analysis case.
 *
 * @task T1703
 */
export type TasksDependsResult = TaskDependsResult;

// tasks.slice
/** Localized task/workgraph node returned by `tasks.slice`. */
export interface TasksSliceNode {
  id: string;
  title: string;
  status: TaskStatus;
  type?: TaskType;
  priority?: TaskPriority;
  /** Canonical wire field for parent task ID (ADR-057 D2). */
  parent?: string;
  children: string[];
  depends: string[];
  dependents: string[];
  depth: number;
}

/** Params for `tasks.slice` — fixed-radius local WorkGraph context around a task. */
export interface TasksSliceParams {
  taskId: string;
  /** Slice direction. `around` returns upstream, downstream, and siblings. Defaults to `around`. */
  direction?: 'upstream' | 'downstream' | 'around';
  /** Back-compat alias for dependency traversal depth. */
  radius?: number;
  /** Dependency traversal depth for upstream/downstream. Defaults to 1. */
  depth?: number;
  /** Maximum nodes per returned section. Defaults to unbounded. */
  budget?: number;
  /** Include direct non-dependency `relates` neighbors in a `related` bucket. */
  includeRelates?: boolean;
}

/** Result of `tasks.slice` — center task, deps, dependents, siblings, and optional relations. */
export interface TasksSliceResult {
  taskId: string;
  direction: 'upstream' | 'downstream' | 'around';
  depth: number;
  radius: number;
  budget?: number;
  includeRelates: boolean;
  center: TasksSliceNode;
  upstream: TasksSliceNode[];
  downstream: TasksSliceNode[];
  siblings: TasksSliceNode[];
  related?: TasksSliceNode[];
}

// tasks.analyze dispatch params (with optional taskId and tierLimit)
export interface TasksAnalyzeQueryParams {
  taskId?: string;
  tierLimit?: number;
}
/**
 * Result of `tasks.analyze` — task quality analysis with tier breakdown.
 *
 * Extends `TaskAnalysisResult` (from contracts/results.ts) with the
 * `tierLimit` used for the analysis.
 *
 * @task T1703
 */
export type TasksAnalyzeQueryResult = TaskAnalysisResult & { tierLimit: number };

// ---------------------------------------------------------------------------
// tasks.context — Task-scoped context pack with token budget (T10629)
// ---------------------------------------------------------------------------

/** Params for `tasks.context` — bounded task context pack. */
export interface TasksContextParams {
  /** Task ID to build context for. */
  taskId: string;
  /**
   * Scope mode: `saga` resolves member-epic rollup + ready frontier across
   * all members; `epic` resolves child-task rollup + ready frontier for the
   * epic. When omitted or `undefined`, behaves as a single-task context pack
   * (T10629 baseline). @defaultValue undefined (task-only)
   */
  scope?: 'saga' | 'epic';
  /** Maximum token budget for the returned pack. @defaultValue 1500 */
  budgetTokens?: number;
  /** Include acceptance criteria in the pack. @defaultValue true */
  includeAcceptance?: boolean;
  /** Include blocker summary in the pack. @defaultValue true */
  includeBlockers?: boolean;
  /** Include attached docs in the pack. @defaultValue true */
  includeDocs?: boolean;
  /** Include graph edges (upstream/downstream/siblings/related) in the pack. @defaultValue true */
  includeEdges?: boolean;
  /** Include recent activity (audit log) in the pack. @defaultValue true */
  includeActivity?: boolean;
  /** Maximum number of recent activity events. @defaultValue 10 */
  activityLimit?: number;
  /** Maximum depth for graph edges when includeEdges is true. @defaultValue 1 */
  edgeDepth?: number;
}

/** A single omitted section with reason and count. */
export interface TasksContextOmission {
  /** Section path that was omitted (e.g. "acceptance", "blockers", "docs", "edges.upstream", "activity"). */
  path: string;
  /** Reason for omission. */
  reason: 'budget_exceeded' | 'not_requested' | 'not_available';
  /** Human-readable explanation. */
  message: string;
  /** Number of items omitted, when countable. */
  count?: number;
  /**
   * CLI command to expand this section, when an expansion path exists
   * (e.g. `"cleo orchestrate ready T10547"`, `"cleo saga rollup T10538"`).
   * @task T10630
   */
  expansionCommand?: string;
}

/** Budget accounting for a task context pack. */
export interface TasksContextBudget {
  /** Caller-provided token budget. */
  tokenBudget: number;
  /** Estimated tokens consumed by the returned payload. */
  estimatedTokens: number;
  /** Remaining tokens after payload selection. */
  remainingTokens: number;
  /** True when one or more sections were truncated or omitted. */
  truncated: boolean;
}

/** Single AC entry in the context pack. */
export interface TasksContextAcceptanceEntry {
  /** AC alias (e.g. "AC1") or UUID. */
  alias: string;
  /** Full acceptance criterion text. */
  text: string;
  /** Whether this AC has evidence bindings. */
  hasEvidence?: boolean;
}

/** Single blocker entry in the context pack. */
export interface TasksContextBlockerEntry {
  /** Blocking task ID. */
  taskId: string;
  /** Title of the blocking task. */
  title: string;
  /** Status of the blocking task. */
  status: string;
  /** Blocker kind: dependency or gate. */
  kind: 'dependency' | 'gate';
}

/** Single doc entry in the context pack. */
export interface TasksContextDocEntry {
  /** Doc slug or attachment identifier. */
  slug: string;
  /** Doc type. */
  type: string;
  /** Human-readable title or description. */
  title: string;
}

/** Single activity event in the context pack. */
export interface TasksContextActivityEvent {
  /** ISO timestamp. */
  timestamp: string;
  /** Action type. */
  action: string;
  /** Actor who performed the action. */
  actor?: string;
  /** Free-form details. */
  details?: string;
}

/**
 * Rollup summary for a saga or epic scope.
 * @task T10630
 */
export interface TasksScopeRollup {
  /** Total number of member epics (saga) or child tasks (epic). */
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
  /** Completion percentage (0–100). */
  completionPct: number;
}

/**
 * A single member epic entry in a saga context pack.
 * @task T10630
 */
export interface TasksScopeMember {
  /** Epic task ID. */
  epicId: string;
  /** Epic title. */
  title: string;
  /** Current status. */
  status: string;
}

/**
 * A single ready-frontier entry in a saga/epic context pack.
 * @task T10630
 */
export interface TasksScopeReadyEntry {
  /** Task ID that is ready to execute. */
  id: string;
  /** Task title. */
  title: string;
  /** Priority level. */
  priority: string;
  /** Declared dependency IDs. */
  depends: string[];
}

/** Result of `tasks.context` — bounded task context pack with omission tracking. */
export interface TasksContextResult {
  /** Task ID this pack describes. */
  taskId: string;
  /** ISO timestamp when the pack was generated. */
  generatedAt: string;
  /** Budget accounting. */
  budget: TasksContextBudget;
  /** Task identity (title, status, type, priority, description). */
  identity: {
    id: string;
    title: string;
    status: string;
    type?: string;
    priority?: string;
    description?: string;
    parentId?: string | null;
  };
  /** Acceptance criteria, when requested and within budget. */
  acceptance?: TasksContextAcceptanceEntry[];
  /** Blockers, when requested and within budget. */
  blockers?: TasksContextBlockerEntry[];
  /** Attached docs, when requested and within budget. */
  docs?: TasksContextDocEntry[];
  /** Graph edges, when requested and within budget. */
  edges?: {
    upstream: TasksSliceNode[];
    downstream: TasksSliceNode[];
    siblings: TasksSliceNode[];
    related?: TasksSliceNode[];
  };
  /** Recent activity events, when requested and within budget. */
  activity?: TasksContextActivityEvent[];
  /**
   * Saga/epic rollup summary — present when `scope` is `'saga'` or
   * `'epic'` and rollup data is available. @task T10630
   */
  rollup?: TasksScopeRollup;
  /**
   * Saga member epics — present when `scope` is `'saga'` and member data
   * is available. @task T10630
   */
  members?: TasksScopeMember[];
  /**
   * Ready frontier — parallel-safe tasks that can be dispatched now.
   * Present when `scope` is `'saga'` or `'epic'` and ready data is
   * available. @task T10630
   */
  readyFrontier?: TasksScopeReadyEntry[];
  /** Omitted/truncated sections with reasons and counts. */
  omissions: TasksContextOmission[];
  /** Expansion hints for omitted sections. */
  expansionHints: Record<string, string>;
}

// tasks.deps.validate
/**
 * Parameters for `tasks.deps.validate`.
 *
 * @task T1857
 * @epic T1855
 */
export interface TasksDepsValidateParams {
  /** Scope to direct children of this epic (optional). */
  epicId?: string;
  /** Which tasks to include: all, open, or critical-priority only. @defaultValue 'all' */
  scope?: 'all' | 'open' | 'critical';
}

/**
 * A single dep-graph issue found by `tasks.deps.validate`.
 *
 * @task T1857
 * @epic T1855
 */
export interface DepGraphIssue {
  /** Machine-readable issue code. */
  code: 'E_ORPHAN' | 'E_CIRCULAR' | 'E_CROSS_EPIC_GAP' | 'E_STALE_DEP' | 'E_MISSING_REF';
  /** The task ID where the issue originates. */
  taskId: string;
  /** Human-readable description. */
  message: string;
  /** Related task IDs (dep IDs, cycle members, etc.). */
  relatedIds?: string[];
  /** Source epic ID (for E_CROSS_EPIC_GAP issues). */
  epicA?: string;
  /** Target epic ID (for E_CROSS_EPIC_GAP issues). */
  epicB?: string;
}

/**
 * Result of `tasks.deps.validate`.
 *
 * @task T1857
 * @epic T1855
 */
export interface TasksDepsValidateResult {
  /** True when no issues were found. */
  valid: boolean;
  /** All detected issues. Empty when valid. */
  issues: DepGraphIssue[];
  /** Human-readable summary line. */
  summary: string;
}

// tasks.deps.tree
/**
 * Parameters for `tasks.deps.tree`.
 *
 * @task T1857
 * @epic T1855
 */
export interface TasksDepsTreeParams {
  /** Epic ID to visualize (required). */
  epicId: string;
  /** Output format. @defaultValue 'text' */
  format?: 'text' | 'mermaid' | 'json';
}

/** A node in the deps tree JSON output. */
export interface DepsTreeNode {
  /** Task ID. */
  id: string;
  /** Task title. */
  title: string;
  /** Task status. */
  status: string;
  /** Direct dependency IDs. */
  depends: string[];
}

/** An edge in the deps tree JSON output. */
export interface DepsTreeEdge {
  /** Source task ID (dependency). */
  from: string;
  /** Target task ID (dependent). */
  to: string;
}

/**
 * Result of `tasks.deps.tree`.
 *
 * @task T1857
 * @epic T1855
 */
export interface TasksDepsTreeResult {
  /** The epic ID the tree is scoped to. */
  epicId: string;
  /** Output format that was rendered. */
  format: 'text' | 'mermaid' | 'json';
  /**
   * Rendered text or Mermaid output (when format is 'text' or 'mermaid').
   * Null when format is 'json'.
   */
  rendered: string | null;
  /** Structured node list (always populated). */
  nodes: DepsTreeNode[];
  /** Directed edges in the graph (dependency → dependent). */
  edges: DepsTreeEdge[];
  /** Task IDs on the critical path (longest dep chain), or empty if none. */
  criticalPath: string[];
}

// tasks.impact
export interface TasksImpactParams {
  change: string;
  matchLimit?: number;
}
/**
 * Result of `tasks.impact` — impact prediction report for a free-text change.
 *
 * @task T1703
 */
export type TasksImpactResult = ImpactReport;

// tasks.next dispatch params (with count and explain)
export interface TasksNextQueryParams {
  count?: number;
  explain?: boolean;
}
/**
 * Result of `tasks.next` — suggested tasks to work on next.
 *
 * @task T1703
 */
export interface TasksNextQueryResult {
  /** Ranked list of suggested tasks. */
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    /** Reasons this task is recommended. Only present when `explain: true`. */
    reasons?: string[];
  }>;
  /** Total number of candidate tasks considered before ranking. */
  totalCandidates: number;
}

// tasks.plan
export type TasksPlanParams = Record<string, never>;
/**
 * Result of `tasks.plan` — composite planning view.
 *
 * @task T1703
 */
export type TasksPlanResult = TaskPlanResult;

// tasks.relates (with mode routing for suggest/discover)
export interface TasksRelatesParams {
  taskId: string;
  mode?: 'suggest' | 'discover';
  threshold?: number;
  /** List edges where taskId is the source, target, or either side. Defaults to both. */
  direction?: 'out' | 'in' | 'both';
  /** Filter by relation type, or `depends`/`depends_on` for dependency edges. */
  type?: string;
  /** Include scheduler dependency edges in list output. Defaults to true. */
  includeDependencies?: boolean;
}
/**
 * Result of `tasks.relates` — task relations list.
 *
 * @task T1703
 */
export interface TasksRelatesResult {
  /** The task ID whose relations were loaded. */
  taskId: string;
  /** All relations for this task. */
  relations: Array<{
    taskId: string;
    type: string;
    reason?: string;
    direction?: 'out' | 'in';
    source?: 'relation' | 'dependency';
    ready?: boolean;
    status?: string;
  }>;
  /** Direction filter applied by list output. */
  direction?: 'out' | 'in' | 'both';
  /** Total number of relations. */
  count: number;
}

// tasks.relates.add-batch
export interface TasksRelatesAddBatchEntry {
  taskId?: string;
  from?: string;
  relatedId?: string;
  to?: string;
  type: string;
  reason?: string;
}
export interface TasksRelatesAddBatchParams {
  relations?: TasksRelatesAddBatchEntry[];
  edges?: TasksRelatesAddBatchEntry[];
  dryRun?: boolean;
  reasonWaiver?: string;
}
export interface TasksRelatesAddBatchResult {
  dryRun: boolean;
  validatedCount: number;
  created: number;
  wouldCreate: number;
  relations: Array<{
    from: string;
    to: string;
    type: string;
    reason?: string;
    waivedReason?: boolean;
  }>;
  warnings: Array<{
    code: string;
    message: string;
    edge?: { from: string; to: string; type: string };
  }>;
}

// tasks.complexity.estimate
export interface TasksComplexityEstimateParams {
  taskId: string;
}
/**
 * Result of `tasks.complexity.estimate` — complexity score breakdown.
 *
 * @task T1703
 */
export interface TasksComplexityEstimateResult {
  /** Normalized size category. */
  size: 'small' | 'medium' | 'large';
  /** Raw numeric complexity score. */
  score: number;
  /** Individual factors contributing to the score. */
  factors: TaskComplexityFactor[];
  /** Maximum depth of the dependency graph. */
  dependencyDepth: number;
  /** Number of direct subtasks. */
  subtaskCount: number;
  /** Number of associated files. */
  fileCount: number;
}

// tasks.history
export interface TasksHistoryParams {
  taskId?: string;
  limit?: number;
}
/**
 * Result of `tasks.history` — audit log entries for a task.
 *
 * Each entry is a structured audit record; fields are consistent across
 * entries but the `details`, `before`, and `after` sub-objects are
 * operation-specific.
 *
 * @task T1703
 */
export type TasksHistoryResult = Array<Record<string, unknown>>;

// tasks.label.list
export type TasksLabelListParams = Record<string, never>;
/**
 * Result of `tasks.label.list` — all labels with task counts.
 *
 * @task T1703
 */
export interface TasksLabelListResult {
  /** All labels used in active tasks, sorted by count descending. */
  labels: TaskLabelInfo[];
  /** Total number of distinct labels. */
  count: number;
}

// tasks.sync.links
export interface TasksSyncLinksParams {
  providerId?: string;
  taskId?: string;
}
/**
 * Result of `tasks.sync.links` — external task links for a provider or task.
 *
 * @task T1703
 */
export interface TasksSyncLinksResult {
  /** All matching external task links. */
  links: ExternalTaskLink[];
  /** Total number of links returned. */
  count: number;
}

// tasks.sync.reconcile
export interface TasksSyncReconcileParams {
  providerId: string;
  externalTasks: ExternalTask[];
  dryRun?: boolean;
  conflictPolicy?: string;
  defaultPhase?: string;
  defaultLabels?: string[];
}
/**
 * Result of `tasks.sync.reconcile` — reconciliation summary.
 *
 * @task T1703
 */
export type TasksSyncReconcileResult = ReconcileResult;

// tasks.sync.links.remove
export interface TasksSyncLinksRemoveParams {
  providerId: string;
}
/**
 * Result of `tasks.sync.links.remove` — count of removed links.
 *
 * @task T1703
 */
export interface TasksSyncLinksRemoveResult {
  /** The provider whose links were removed. */
  providerId: string;
  /** Number of links removed. */
  removed: number;
}

// tasks.cancel
export interface TasksCancelParams {
  taskId: string;
  reason?: string;
  /** Explicit child handling mode. Defaults to 'block' so propagation is never implicit. */
  children?: 'block' | 'cascade' | 'orphan';
  /** Operator waiver for large cascade cancellation. */
  force?: boolean;
  /** Large-subtree cascade guard threshold. Defaults to 10 descendants. */
  cascadeThreshold?: number;
  /** Config-level cascade permission. Defaults to true. */
  allowCascade?: boolean;
}
/**
 * Result of `tasks.cancel` — cancellation confirmation.
 *
 * @task T1703
 * @task T9838 (idempotency — `alreadyCancelled` returned when re-cancelling)
 */
export interface TasksCancelResult {
  /** The task ID that was cancelled. */
  task: string;
  /** Whether the cancellation succeeded. */
  cancelled: boolean;
  /** The reason for cancellation, if provided. @defaultValue undefined */
  reason?: string;
  /** ISO 8601 timestamp of cancellation. */
  cancelledAt: string;
  /**
   * True when the task was already cancelled before this call — the
   * operation is a no-op and the response reflects the pre-existing
   * cancellation state. Idempotent re-cancellation (T9838).
   *
   * @defaultValue undefined
   */
  alreadyCancelled?: boolean;
  /** Explicit child handling mode applied by the operation. */
  childStrategy?: 'block' | 'cascade' | 'orphan';
  /** Child or descendant tasks affected by cascade/orphan handling. */
  affectedTasks?: string[];
  /** Count of affected child/descendant tasks. */
  affectedCount?: number;
}

// tasks.restore (with from routing: done → reopen, archived → unarchive)
export interface TasksRestoreParams {
  taskId: string;
  from?: 'done' | 'archived';
  status?: string;
  reason?: string;
  preserveStatus?: boolean;
  cascade?: boolean;
  notes?: string;
}
/**
 * Result of `tasks.restore` — restore confirmation with cascade details.
 *
 * @task T1703
 */
export interface TasksRestoreResult {
  /** The primary task ID that was restored. */
  task: string;
  /** All task IDs that were restored (includes cascade). */
  restored: string[];
  /** Number of tasks restored. */
  count: number;
}

// tasks.reparent (dispatch-level params include newParentId)
export interface TasksReparentQueryParams {
  taskId: string;
  /** New parent ID, or null/undefined to promote to root. */
  newParentId: string | null | undefined;
}
/**
 * Result of `tasks.reparent` — reparent confirmation.
 *
 * @task T1703
 */
export interface TasksReparentDispatchResult {
  /** The task ID that was reparented. */
  task: string;
  /** Whether the reparent succeeded. */
  reparented: boolean;
  /** Previous parent ID, or null if was root. */
  oldParent: string | null;
  /** New parent ID, or null if promoted to root. */
  newParent: string | null;
  /** New task type if it changed during reparent. @defaultValue undefined */
  newType?: string;
}

// tasks.reorder (dispatch-level params)
export interface TasksReorderQueryParams {
  taskId: string;
  position: number;
}
/**
 * Result of `tasks.reorder` — reorder confirmation.
 *
 * @task T1703
 */
export interface TasksReorderDispatchResult {
  /** The task ID that was reordered. */
  task: string;
  /** Whether the reorder succeeded. */
  reordered: boolean;
  /** The new position within sibling scope. */
  newPosition: number;
  /** Total number of siblings after reorder. */
  totalSiblings: number;
}

// tasks.relates.add — relatedId is canonical; targetId kept for backward compat (T5149)
export interface TasksRelatesAddParams {
  taskId: string;
  relatedId?: string;
  // SSoT-EXEMPT: targetId is a backward-compat alias for relatedId accepted since T5149; removal is a separate cleanup task
  targetId?: string;
  type: string;
  reason?: string;
}
/**
 * Result of `tasks.relates.add` — relation creation confirmation.
 *
 * @task T1703
 */
export interface TasksRelatesAddResult {
  /** Source task ID. */
  from: string;
  /** Target (related) task ID. */
  to: string;
  /** Relation type (e.g. "blocks", "related-to"). */
  type: string;
  /** Whether the relation was newly created (false if it already existed). */
  added: boolean;
}

export interface TasksRelatesAddBatchEntry {
  /** Source task ID. */
  taskId?: string;
  /** Source task ID alias accepted by file payloads. */
  from?: string;
  /** Target task ID. */
  relatedId?: string;
  /** Target task ID alias accepted by file payloads. */
  to?: string;
  /** Relation type: related|blocks|duplicates|absorbs|fixes|extends|supersedes|groups. */
  type: string;
  /** Audit reason for creating this advisory relation. Required unless reasonWaiver is set. */
  reason?: string;
}

export interface TasksRelatesAddBatchParams {
  /** Relation edges to add atomically. */
  relations?: TasksRelatesAddBatchEntry[];
  /** Relation edges alias for WorkGraph-flavored callers. */
  edges?: TasksRelatesAddBatchEntry[];
  /** Validate and report without writing. */
  dryRun?: boolean;
  /** Explicit reason-waiver text applied to any edge missing an edge-level reason. */
  reasonWaiver?: string;
}

export interface TasksRelatesAddBatchResult {
  /** Whether this dispatch only previewed writes. */
  dryRun: boolean;
  /** Validated relation count. */
  validatedCount: number;
  /** Number of relation rows inserted or previewed. */
  created: number;
  /** Dry-run prediction of rows that would be inserted. */
  wouldCreate: number;
  /** Accepted normalized relation edges. */
  relations: Array<{
    from: string;
    to: string;
    type: string;
    reason?: string;
    waivedReason?: boolean;
  }>;
  /** Non-fatal audit notes, including explicit missing-reason waivers. */
  warnings: Array<{
    code: string;
    message: string;
    edge?: { from: string; to: string; type: string };
  }>;
}

// tasks.relates.remove
export interface TasksRelatesRemoveParams {
  /** Source task ID. */
  taskId: string;
  /** Target task ID to remove the relation to. */
  relatedId: string;
  /** Optional relation type to narrow the deletion (omit to remove any type). */
  type?: string;
}
/**
 * Result of `tasks.relates.remove` — relation deletion confirmation.
 *
 * @task T9240
 */
export interface TasksRelatesRemoveResult {
  /** Source task ID. */
  from: string;
  /** Target (related) task ID. */
  to: string;
  /** Whether a relation was actually deleted. */
  removed: boolean;
}

// tasks.add-batch (atomic multi-task insert)
/**
 * Parameters for `tasks.add-batch`.
 *
 * Wraps N `tasks.add` inserts in a single transaction; any failure rolls
 * back ALL inserts. Closes the partial-batch bug in the CLI `add-batch`
 * command (T9813 / T9814).
 *
 * @task T9814
 */
export interface TasksAddBatchParams {
  /**
   * Array of task specs to insert. Must be non-empty.
   * Each spec accepts the same fields as `tasks.add` (except `dryRun`
   * which is hoisted to the batch level).
   */
  tasks: Array<{
    title: string;
    description?: string;
    parent?: string;
    depends?: string[];
    priority?: string;
    labels?: string[];
    type?: TaskType; // SSoT-EXEMPT:kind≠type — 'type' is hierarchy(saga|epic|task|subtask), 'kind' is intent(work|bug|...) — separate axes T944 // ssot-exempt-ok: pre-existing exempt, narrowed string→TaskType (T10328)
    acceptance?: string[];
    phase?: string;
    size?: string;
    notes?: string;
    files?: string[];
    kind?: string;
    scope?: string;
    severity?: string;
    forceDuplicate?: boolean;
  }>;
  /** Optional default parent ID applied when a task spec omits `parent`. */
  defaultParent?: string;
  /**
   * Dry-run mode: validate each spec and return predicted IDs without
   * writing to the database. Created count is always 0 in dry-run.
   */
  dryRun?: boolean;
}

/**
 * Result of `tasks.add-batch`.
 *
 * @task T9814
 * @task T10599 (dry-run semantics: wouldCreate, wouldAffect, validatedCount, insertedCount, validationFindings)
 */
export interface TasksAddBatchResult extends TaskMutationEnvelope<number, [], []> {
  /** Number of tasks actually created (0 on rollback or dry-run). */
  created: number;
  /** Per-task results in input order. */
  tasks: TasksAddResult[];
  /** Whether this was a dry run. */
  dryRun?: boolean;
  /**
   * Number of tasks that would be created if the dry run were executed for real.
   * Only present when `dryRun` is `true`. Use this for `--output count` in
   * dry-run mode — `created` is always 0 in a dry run.
   *
   * @task T10599
   */
  wouldCreate?: number;
  /**
   * Generic number of rows/entities that would be affected by the dry-run operation.
   * For `tasks.add-batch`, this equals `wouldCreate`.
   *
   * @task T10599
   */
  wouldAffect?: number;
  /**
   * Number of task specs that successfully passed validation during a dry run.
   * Always equals `wouldCreate` when no validation errors occurred; may be less
   * when partial validation failures are tolerated.
   *
   * @task T10599
   */
  validatedCount?: number;
  /**
   * Number of tasks durably written to the database.
   * - Live run: equals `created`.
   * - Dry run: always `0` (no writes performed).
   *
   * Kept separate from `created` so callers can distinguish "batch was a
   * dry run with 0 writes" from "batch was live but created nothing due to
   * rollback/validation failure".
   *
   * @task T10599
   */
  insertedCount?: number;
  /**
   * Per-task non-blocking validation warnings emitted during a dry run.
   * Only present when at least one task spec produced a warning.
   * Index matches the position of the spec in the `tasks` input array.
   *
   * @task T10599
   */
  validationFindings?: Array<{ index: number; warnings: string[] }>;
  /** Standard dry-run/preflight projection shared by task mutations. @task T10608 */
  dryRunSummary?: TaskMutationDryRunSummary;
  /** Structured partial-success warnings, flattened across batch entries. @task T10608 */
  mutationWarnings: TaskMutationWarning[];
  /** Updated task records; empty for add-batch. @task T10608 */
  updated: [];
  /** Deleted task records; empty for add-batch. @task T10608 */
  deleted: [];
  /** Total number of live rows/entities affected. @task T10608 */
  affectedCount: number;
}

// tasks.add (dispatch-level params — extends TasksCreateParams)
export interface TasksAddParams {
  title: string;
  description?: string;
  /** Canonical wire field for parent task ID. @see ADR-057 D2 */
  parent?: string;
  depends?: string[];
  priority?: string;
  labels?: string[];
  type?: TaskType; // SSoT-EXEMPT:kind≠type — 'type' is hierarchy(saga|epic|task|subtask), 'kind' is intent(work|bug|...) — separate axes T944 // ssot-exempt-ok: pre-existing exempt, narrowed string→TaskType (T10328)
  acceptance?: string[];
  phase?: string;
  size?: string;
  notes?: string;
  files?: string[];
  dryRun?: boolean;
  parentSearch?: string;
  /** Canonical wire field for task kind axis (T9072: renamed from role). @see ADR-057 D2 */
  kind?: string;
  scope?: string;
  severity?: string;
  /**
   * Bypass the E_DUPLICATE_TASK_LIKELY guard.
   *
   * When true, `cleo add` will proceed even if the new task's title and
   * description score >= 0.92 similarity against active tasks. The bypass
   * is audited to `.cleo/audit/duplicate-bypass.jsonl` (ADR-051 pattern).
   *
   * @task T1633
   */
  forceDuplicate?: boolean;
}
/**
 * Result of `tasks.add` — the newly created task.
 *
 * @task T1703
 */
export interface TasksAddResult extends TaskMutationEnvelope<TaskRecord[], [], []> {
  /** The created task record. */
  task: TaskRecord;
  /** Whether a duplicate was detected (but bypassed via forceDuplicate). */
  duplicate: boolean;
  /** Whether this was a dry run (task not actually saved). @defaultValue undefined */
  dryRun?: boolean;
  /** Non-blocking validation warnings. @defaultValue undefined */
  warnings?: string[];
  /** Standardized created bucket; contains `task` on live create, empty on dry-run. @task T10608 */
  created: TaskRecord[];
  /** Standardized updated bucket; empty for create. @task T10608 */
  updated: [];
  /** Standardized deleted bucket; empty for create. @task T10608 */
  deleted: [];
  /** Total number of live rows/entities affected. @task T10608 */
  affectedCount: number;
  /** Structured partial-success/preflight warnings. @task T10608 */
  mutationWarnings: TaskMutationWarning[];
  /** Standard dry-run/preflight projection. @task T10608 */
  dryRunSummary?: TaskMutationDryRunSummary;
}

// tasks.update (dispatch-level params — extends TasksUpdateParams)
export interface TasksUpdateQueryParams {
  taskId: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  notes?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  acceptance?: string[];
  /** Canonical wire field for parent task ID. @see ADR-057 D2 */
  parent?: string | null;
  type?: TaskType; // SSoT-EXEMPT:kind≠type — 'type' is hierarchy(saga|epic|task|subtask), 'kind' is intent(work|bug|...) — separate axes T944 // ssot-exempt-ok: pre-existing exempt, narrowed string→TaskType (T10328)
  size?: string;
  files?: string[];
  /** Add files incrementally (mirrors --add-labels pattern). @task T9242 */
  addFiles?: string[];
  /** Remove files incrementally (mirrors --remove-labels pattern). @task T9242 */
  removeFiles?: string[];
  pipelineStage?: string;
  /** Canonical wire field for task kind axis (T9072: renamed from role). */
  kind?: string;
  /** Task scope axis — granularity of work. @task T944 */
  scope?: string;
  /**
   * Severity level — valid for any kind (T9073). Orthogonal to priority.
   * Appends a signed attestation to `.cleo/audit/severity-attestation.jsonl`.
   */
  severity?: string;
  /**
   * Operator override reason for AC-immutability guard (T1590).
   * Required to mutate `acceptance` once stage >= implementation.
   */
  reason?: string;
  /** Dependency declaration waiver for critical-priority tasks (T1856). */
  dependsWaiver?: string;
  /** Clear the blockedBy free-text reason (set to undefined). @task T9241 */
  clearBlockedBy?: boolean;
  /** Set related tasks (replaces existing). @task T9327 */
  relates?: Array<{ taskId: string; type: string; reason?: string }>;
  /** Add related tasks without overwriting existing. @task T9327 */
  addRelates?: Array<{ taskId: string; type: string; reason?: string }>;
  /** Remove related tasks by taskId. @task T9327 */
  removeRelates?: string[];
}
/**
 * Result of `tasks.update` — the updated task record with change list.
 *
 * @task T1703
 */
export interface TasksUpdateQueryResult extends TaskMutationEnvelope<[], TaskRecord[], []> {
  /** Updated task record. */
  task: TaskRecord;
  /** Human-readable list of fields that were changed. @defaultValue undefined */
  changes?: string[];
  /** Whether this was a dry run (no mutation persisted). @defaultValue undefined */
  dryRun?: boolean;
  /** Standardized created bucket; empty for update. @task T10608 */
  created: [];
  /** Standardized updated bucket; contains the updated task on live update, empty on dry-run. @task T10608 */
  updated: TaskRecord[];
  /** Standardized deleted bucket; empty for update. @task T10608 */
  deleted: [];
  /** Total number of live rows/entities affected. @task T10608 */
  affectedCount: number;
  /** Structured partial-success/preflight warnings. @task T10608 */
  mutationWarnings: TaskMutationWarning[];
  /** Standard dry-run/preflight projection. @task T10608 */
  dryRunSummary?: TaskMutationDryRunSummary;
}

// tasks.complete (dispatch-level params)
export interface TasksCompleteQueryParams {
  taskId: string;
  notes?: string;
  force?: unknown;
  /**
   * Reason for overriding the `E_EPIC_HAS_PENDING_CHILDREN` guard.
   *
   * When provided, `cleo complete <epicId>` is allowed even if the epic
   * still has pending or active children. The reason is appended to
   * `.cleo/audit/premature-close.jsonl` (ADR-051 pattern).
   *
   * @task T1632
   */
  overrideReason?: string;
  /** Reason for acknowledging CRITICAL nexus impact risk (bypasses nexusImpact gate). */
  acknowledgeRisk?: string;
  /**
   * Comma-separated AC tokens (UUIDs or `AC<n>` aliases) waived from the
   * AC-coverage gate (T10509). MUST be paired with {@link waiveReason} —
   * the gate rejects the call when one is set without the other.
   *
   * Waivers are recorded to `.cleo/audit/ac-waiver.jsonl` per ADR-079-r4 §4.
   *
   * @task T10509
   * @saga T10377 (SG-IVTR-AC-BINDING)
   */
  waiveAc?: string;
  /**
   * Justification text for the {@link waiveAc} waiver. Mandatory whenever
   * `waiveAc` is non-empty.
   *
   * @task T10509
   */
  waiveReason?: string;
}
/**
 * Result of `tasks.complete` — completion confirmation with unblocked tasks.
 *
 * @task T1703
 */
export interface TasksCompleteQueryResult {
  /** The completed task record. */
  task: TaskRecord;
  /** IDs of parent epics that were automatically completed. @defaultValue undefined */
  autoCompleted?: string[];
  /** Tasks that became unblocked by this completion. @defaultValue undefined */
  unblockedTasks?: Array<Pick<TaskRef, 'id' | 'title'>>;
}

// tasks.delete (dispatch-level params)
export interface TasksDeleteQueryParams {
  taskId: string;
  force?: boolean;
}
/**
 * Result of `tasks.delete` — deletion confirmation with cascade details.
 *
 * @task T1703
 */
export interface TasksDeleteQueryResult extends TaskMutationEnvelope<[], [], boolean> {
  /** The deleted task record. */
  deletedTask: TaskRecord;
  /** Whether the deletion was applied (always true on success). */
  deleted: boolean;
  /** IDs of child tasks cascade-deleted along with the parent. @defaultValue undefined */
  cascadeDeleted?: string[];
  /** Whether this was a dry run (no mutation persisted). @defaultValue undefined */
  dryRun?: boolean;
  /** Standardized created bucket; empty for delete. @task T10608 */
  created: [];
  /** Standardized updated bucket; empty for delete. @task T10608 */
  updated: [];
  /** Total number of live rows/entities affected. @task T10608 */
  affectedCount: number;
  /** Structured partial-success/preflight warnings. @task T10608 */
  mutationWarnings: TaskMutationWarning[];
  /** Standard dry-run/preflight projection. @task T10608 */
  dryRunSummary?: TaskMutationDryRunSummary;
}

// tasks.archive (dispatch-level params)
export interface TasksArchiveQueryParams {
  taskId?: string;
  before?: string;
  taskIds?: string[];
  includeCancelled?: boolean;
  dryRun?: boolean;
}
/**
 * Result of `tasks.archive` — archive operation summary.
 *
 * @task T1703
 */
export interface TasksArchiveQueryResult {
  /** Number of tasks archived. */
  archivedCount: number;
  /** IDs of tasks that were archived. */
  archivedTasks: Array<{ id: string }>;
}

// tasks.claim
export interface TasksClaimParams {
  taskId: string;
  agentId: string;
}
/**
 * Result of `tasks.claim` — agent claim confirmation.
 *
 * @task T1703
 */
export interface TasksClaimResult {
  /** The task ID that was claimed. */
  taskId: string;
  /** The agent ID that now holds the claim. */
  agentId: string;
}

// tasks.unclaim
export interface TasksUnclaimParams {
  taskId: string;
}
/**
 * Result of `tasks.unclaim` — agent release confirmation.
 *
 * @task T1703
 */
export interface TasksUnclaimResult {
  /** The task ID whose claim was released. */
  taskId: string;
}

// tasks.start (dispatch-level)
export interface TasksStartQueryParams {
  taskId: string;
}
/**
 * Result of `tasks.start` — work-start confirmation.
 *
 * @task T1703
 */
export interface TasksStartQueryResult {
  /** The task ID that is now active. */
  taskId: string;
  /** The task ID that was previously active (auto-stopped), or null. */
  previousTask: string | null;
}

// tasks.stop (dispatch-level)
export type TasksStopQueryParams = Record<string, never>;
/**
 * Result of `tasks.stop` — work-stop confirmation.
 *
 * @task T1703
 */
export interface TasksStopQueryResult {
  /** Whether the active task was successfully cleared. */
  cleared: boolean;
  /** The task ID that was active before stopping, or null if none. */
  previousTask: string | null;
}

// ---------------------------------------------------------------------------
// tasks.saga.* — Saga management (ADR-073, T9521)
// ---------------------------------------------------------------------------

/** Params for `tasks.saga.create` — create a labeled top-level Epic as a Saga. */
export interface TasksSagaCreateParams {
  /** Saga title (3–500 characters). */
  title: string;
  /** Saga description. */
  description?: string;
  /** Pipe-separated acceptance criteria. */
  acceptance?: string[];
  /** Validate and preview the Saga without writing rows. */
  dryRun?: boolean;
}

/**
 * Result of `tasks.saga.create` — the newly created Saga task.
 *
 * @see ADR-073
 * @task T9521
 */
export interface TasksSagaCreateResult {
  /** The created task record (type=epic, labels includes 'saga'). */
  task: TaskRecord;
  /** True when this is a validation-only preview. */
  dryRun?: boolean;
  /** Number of Saga tasks that would be created by a successful dry-run. */
  wouldCreate?: number;
  /** Generic affected-entity count for dry-run projection. */
  wouldAffect?: number;
  /** Number of Saga specs validated during dry-run preflight. */
  validatedCount?: number;
  /** Number of rows durably inserted; always 0 for dry-run. */
  insertedCount?: number;
}

/** Params for `tasks.saga.add` — link an Epic to a Saga. */
export interface TasksSagaAddParams {
  /** Saga task ID (must have label='saga'). */
  sagaId: string;
  /** Epic task ID to link as a member. */
  epicId: string;
}

/**
 * Result of `tasks.saga.add` — relation creation confirmation.
 *
 * @task T9521
 */
export interface TasksSagaAddResult {
  /** Saga task ID. */
  sagaId: string;
  /** Epic task ID linked as member. */
  epicId: string;
  /** Whether the relation was newly created. */
  added: boolean;
}

/**
 * Params for `tasks.saga.detach` — remove a Saga member relation
 * (`task_relations.type='groups'`). Idempotent.
 *
 * @task T10118
 * @see ADR-073-above-epic-naming.md §1.2 invariant I7
 */
export interface TasksSagaDetachParams {
  /** Saga task ID (the `from` side of the groups relation). */
  sagaId: string;
  /** Member task ID (the `to` side of the groups relation). */
  memberId: string;
  /** Optional human-readable reason recorded in the audit log entry. */
  reason?: string;
}

/**
 * Result of `tasks.saga.detach` — relation removal confirmation + audit
 * record (always appended even on idempotent no-op).
 *
 * @task T10118
 */
export interface TasksSagaDetachResult {
  /** Saga task ID. */
  sagaId: string;
  /** Member task ID that was detached. */
  memberId: string;
  /** True when a row was actually removed; false on idempotent no-op. */
  removed: boolean;
  /** Reason recorded in the audit log entry. */
  reason: string;
  /** ISO 8601 timestamp recorded in the audit log entry. */
  timestamp: string;
}

/** Params for `tasks.saga.list` — list all Sagas. */
export type TasksSagaListParams = Record<string, never>;

/**
 * A single I5-violation warning entry returned by `tasks.saga.list` when a
 * saga row carries a non-null `parentId` (ADR-073 §1.2 invariant I5).
 *
 * @task T10117
 */
export interface TasksSagaInvariantI5Warning {
  /** Fixed warning code. */
  code: 'E_SAGA_INVARIANT_VIOLATION_I5';
  /** Saga task ID whose `parentId` violates invariant I5. */
  sagaId: string;
  /** The non-null `parentId` value found on the saga row. */
  offendingParentId: string;
}

/**
 * Result of `tasks.saga.list` — all labeled top-level Epics.
 *
 * @task T9521
 * @task T10117 — added optional `warnings` array for I5 violations
 */
export interface TasksSagaListResult {
  /** Array of Saga task records. */
  sagas: TaskRecord[];
  /** Total count. */
  total: number;
  /**
   * One entry per saga with a non-null `parentId`. Omitted entirely when no
   * violations were observed (pre-T10117 envelope shape preserved).
   */
  warnings?: TasksSagaInvariantI5Warning[];
}

/** Params for `tasks.saga.members` — list member Epics linked to a Saga. */
export interface TasksSagaMembersParams {
  /** Saga task ID. */
  sagaId: string;
}

/**
 * Result of `tasks.saga.members` — member Epics linked via type='groups'.
 *
 * @task T9521
 */
export interface TasksSagaMembersResult {
  /** Saga task ID. */
  sagaId: string;
  /** Member Epic task IDs and their relation details. */
  members: Array<{ epicId: string; type: string; reason?: string }>;
  /** Total count. */
  total: number;
}

/**
 * Params for `tasks.saga.repair` — detach an I5-violating `parentId` from a
 * Saga and re-attach via `task_relations.type='groups'`.
 *
 * @task T10117
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */
export interface TasksSagaRepairParams {
  /** Saga task ID (must have `label='saga'`). */
  sagaId: string;
}

/**
 * Result of `tasks.saga.repair` — idempotent detach + re-attach.
 *
 * @task T10117
 */
export interface TasksSagaRepairResult {
  /** Saga task ID that was inspected. */
  sagaId: string;
  /** `true` when the call performed a state change; `false` for no-op. */
  repaired: boolean;
  /** The detached `parentId` value, or `null` when no detach was needed. */
  detachedParentId: string | null;
  /**
   * The `groups` edge that was written, or `null` for the idempotent no-op
   * and the missing-former-parent edge case.
   */
  attachedRelation: {
    from: string;
    to: string;
    type: 'groups';
  } | null;
  /** Free-form notes the CLI renderer can surface alongside the result. */
  note?: string;
}

/**
 * Per-saga reconciliation action returned by `tasks.saga.reconcile`.
 *
 * @task T10121
 */
export type TasksSagaReconcileAction = 'close' | 'no-op' | 'blocked' | 'error';

/**
 * Params for `tasks.saga.reconcile` — idempotent cron-safe saga auto-close
 * repair. Re-applies the T10116 auto-close logic for sagas whose members
 * reached 100% terminal status via paths OTHER than `completeTask` (bulk
 * SQL repair, crash recovery, manual state edits).
 *
 * @task T10121
 * @see ADR-073-above-epic-naming.md §1.3
 */
export interface TasksSagaReconcileParams {
  /**
   * Optional single saga to reconcile. When omitted, the verb walks every
   * saga returned by `taskList({ type: 'epic', label: 'saga' })`.
   */
  sagaId?: string;
  /**
   * When `true`, run in report-only mode — log what would happen without
   * mutating any rows or writing to the audit log.
   */
  dryRun?: boolean;
}

/**
 * Per-saga reconciliation outcome surfaced inside
 * {@link TasksSagaReconcileResult}.
 *
 * @task T10121
 */
export interface TasksSagaReconcileEntry {
  /** Saga task ID this entry refers to. */
  sagaId: string;
  /** The action the reconciler took for this saga. */
  action: TasksSagaReconcileAction;
  /** Member task IDs considered by the closure check. */
  members: string[];
  /** Members that satisfied the terminal-status predicate. */
  terminalMembers: string[];
  /** Members that did NOT satisfy the terminal-status predicate. */
  pendingMembers: string[];
  /** Saga status BEFORE this run. */
  statusBefore: string;
  /** Saga status AFTER this run (== `statusBefore` for no-op/blocked/error). */
  statusAfter: string;
  /** Free-form human-readable reason recorded for the audit entry. */
  reason: string;
  /** ISO 8601 timestamp the decision was recorded. */
  timestamp: string;
}

/**
 * Result of `tasks.saga.reconcile` — aggregate counters + per-saga entries
 * in stable id order.
 *
 * @task T10121
 */
export interface TasksSagaReconcileResult {
  /** Total number of sagas inspected (== `entries.length`). */
  total: number;
  /** Number of sagas the run flipped to `status='done'`. */
  closed: number;
  /** Number of sagas already in the correct terminal state. */
  noOp: number;
  /** Number of sagas blocked behind a concurrent lock holder. */
  blocked: number;
  /** Number of sagas with pending non-terminal members (not closed). */
  pending: number;
  /** Number of sagas that errored out during reconciliation. */
  errors: number;
  /** Whether this run ran in dry-run mode. */
  dryRun: boolean;
  /** Detailed per-saga entries in stable id order. */
  entries: TasksSagaReconcileEntry[];
}

/** Params for `tasks.saga.rollup` — aggregate member Epic statuses. */
export interface TasksSagaRollupParams {
  /** Saga task ID. */
  sagaId: string;
}

/**
 * Result of `tasks.saga.rollup` — aggregated status counts across member Epics.
 *
 * @task T9521
 */
export interface TasksSagaRollupResult {
  /** Saga task ID. */
  sagaId: string;
  /** Total number of member Epics. */
  total: number;
  /** Number of member Epics with status='done'. */
  done: number;
  /** Number of member Epics with status='active'. */
  active: number;
  /** Number of member Epics with status='blocked'. */
  blocked: number;
  /** Number of member Epics with status='pending'. */
  pending: number;
  /** Completion percentage (done / total * 100), 0 when total=0. */
  completionPct: number;
}

// ---------------------------------------------------------------------------
// Typed operation record (Wave D adapter — T1425)
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the tasks domain.
 *
 * Maps each operation name (as dispatched by the registry — no domain prefix)
 * to its `[Params, Result]` tuple. Used by `TypedDomainHandler<TasksOps>`
 * in the dispatch layer to provide compile-time narrowing of params.
 *
 * @task T1425 — tasks typed-dispatch migration
 */
export type TasksOps = {
  // Query ops
  readonly show: readonly [TasksShowParams, TasksShowResult];
  readonly list: readonly [TasksListParams, TasksListResult];
  readonly find: readonly [TasksFindParams, TasksFindResult];
  readonly tree: readonly [TasksTreeDispatchParams, TasksTreeDispatchResult];
  readonly blockers: readonly [TasksBlockersQueryParams, TasksBlockersQueryResult];
  readonly depends: readonly [TasksDependsParams, TasksDependsResult];
  readonly slice: readonly [TasksSliceParams, TasksSliceResult];
  readonly 'deps.validate': readonly [TasksDepsValidateParams, TasksDepsValidateResult];
  readonly 'deps.tree': readonly [TasksDepsTreeParams, TasksDepsTreeResult];
  readonly analyze: readonly [TasksAnalyzeQueryParams, TasksAnalyzeQueryResult];
  readonly impact: readonly [TasksImpactParams, TasksImpactResult];
  readonly next: readonly [TasksNextQueryParams, TasksNextQueryResult];
  readonly plan: readonly [TasksPlanParams, TasksPlanResult];
  readonly 'completion.list': readonly [CompletionListParams, CompletionListResult];
  readonly 'completion.evaluate': readonly [CompletionEvaluateParams, CompletionEvaluateResult];
  readonly 'completion.explain': readonly [CompletionExplainParams, CompletionExplainResult];
  readonly 'projection.repair': readonly [
    CompletionProjectionRepairParams,
    CompletionProjectionRepairResult,
  ];
  readonly relates: readonly [TasksRelatesParams, TasksRelatesResult];
  readonly 'complexity.estimate': readonly [
    TasksComplexityEstimateParams,
    TasksComplexityEstimateResult,
  ];
  readonly history: readonly [TasksHistoryParams, TasksHistoryResult];
  readonly current: readonly [TasksCurrentParams, TasksCurrentResult];
  readonly 'label.list': readonly [TasksLabelListParams, TasksLabelListResult];
  readonly 'sync.links': readonly [TasksSyncLinksParams, TasksSyncLinksResult];
  // T10629 — task-scoped context pack with token budget
  readonly context: readonly [TasksContextParams, TasksContextResult];
  // Mutate ops
  readonly add: readonly [TasksAddParams, TasksAddResult];
  readonly 'add-batch': readonly [TasksAddBatchParams, TasksAddBatchResult];
  readonly update: readonly [TasksUpdateQueryParams, TasksUpdateQueryResult];
  readonly complete: readonly [TasksCompleteQueryParams, TasksCompleteQueryResult];
  readonly cancel: readonly [TasksCancelParams, TasksCancelResult];
  readonly delete: readonly [TasksDeleteQueryParams, TasksDeleteQueryResult];
  readonly archive: readonly [TasksArchiveQueryParams, TasksArchiveQueryResult];
  readonly restore: readonly [TasksRestoreParams, TasksRestoreResult];
  readonly reparent: readonly [TasksReparentQueryParams, TasksReparentDispatchResult];
  readonly reorder: readonly [TasksReorderQueryParams, TasksReorderDispatchResult];
  readonly 'relates.add': readonly [TasksRelatesAddParams, TasksRelatesAddResult];
  readonly 'relates.add-batch': readonly [TasksRelatesAddBatchParams, TasksRelatesAddBatchResult];
  readonly 'relates.remove': readonly [TasksRelatesRemoveParams, TasksRelatesRemoveResult];
  readonly start: readonly [TasksStartQueryParams, TasksStartQueryResult];
  readonly stop: readonly [TasksStopQueryParams, TasksStopQueryResult];
  readonly 'sync.reconcile': readonly [TasksSyncReconcileParams, TasksSyncReconcileResult];
  readonly 'sync.links.remove': readonly [TasksSyncLinksRemoveParams, TasksSyncLinksRemoveResult];
  readonly claim: readonly [TasksClaimParams, TasksClaimResult];
  readonly unclaim: readonly [TasksUnclaimParams, TasksUnclaimResult];
  // Saga sub-domain ops (ADR-073)
  readonly 'saga.create': readonly [TasksSagaCreateParams, TasksSagaCreateResult];
  readonly 'saga.add': readonly [TasksSagaAddParams, TasksSagaAddResult];
  readonly 'saga.detach': readonly [TasksSagaDetachParams, TasksSagaDetachResult];
  readonly 'saga.list': readonly [TasksSagaListParams, TasksSagaListResult];
  readonly 'saga.members': readonly [TasksSagaMembersParams, TasksSagaMembersResult];
  readonly 'saga.rollup': readonly [TasksSagaRollupParams, TasksSagaRollupResult];
  /** T10117 — repair an I5-violating saga. */
  readonly 'saga.repair': readonly [TasksSagaRepairParams, TasksSagaRepairResult];
  /** T10121 — idempotent cron-safe auto-close repair (supersedes T10098 scope). */
  readonly 'saga.reconcile': readonly [TasksSagaReconcileParams, TasksSagaReconcileResult];
};

// ---------------------------------------------------------------------------
// OperationInputContract schemas (T9917 / Epic T9903 / Saga T9855)
// ---------------------------------------------------------------------------
//
// JSON Schema documents that describe the accepted input shape for each
// tasks.* mutate operation. The `tasks.add`, `tasks.add-batch`, and
// `tasks.update` schemas back the schema-first `mutate(operation, input)`
// DX surface introduced by T9914 and validated by T9915.
//
// Schemas live in `contracts/` because the CLI (`packages/cleo/`) and the
// CORE registry (`packages/core/`) both depend on them — contracts is the
// leaf package both packages already import from, so colocation avoids a
// fan-out violation (T10074).
//
// Each schema sets `additionalProperties: false` to reject typo'd flags
// outright instead of silently dropping them on the floor at the dispatch
// boundary.
// ---------------------------------------------------------------------------

/**
 * Per-task entry inside a `tasks.add-batch` payload.
 *
 * Mirrors the shape of {@link TasksAddBatchParams.tasks | TasksAddBatchParams.tasks[]}
 * exactly — every field is identical to a `tasks.add` spec EXCEPT `dryRun`,
 * which is hoisted to the batch level so a single dispatch can preview the
 * whole batch atomically.
 *
 * @task T9917
 */
export interface TasksAddBatchEntry {
  /** Task title (3–500 characters). Required. */
  title: string;
  /** Detailed task description (must differ meaningfully from title). */
  description?: string;
  /** Parent task ID (makes this task a subtask). */
  parent?: string;
  /** Dependency task IDs as a JSON array. */
  depends?: string[];
  /** Task priority (low | medium | high | critical). */
  priority?: string;
  /** Lowercase alphanumeric + hyphens + periods labels. */
  labels?: string[];
  /** Task type (saga | epic | task | subtask). */
  type?: TaskType; // SSoT-EXEMPT:kind≠type — same axis split as TasksAddBatchParams (T944) // ssot-exempt-ok: mirrors parent type
  /** Acceptance criteria as a JSON array; pipe-delimited strings are not canonical. */
  acceptance?: string[];
  /** Phase slug to assign the task to. */
  phase?: string;
  /** Scope size estimate (small | medium | large). */
  size?: string;
  /** Initial note entry for the task. */
  notes?: string;
  /** Files touched by the task (relative paths). */
  files?: string[];
  /** Task kind / intent axis (work | research | experiment | bug | spike | release). */
  kind?: string;
  /** Task scope / granularity axis (project | feature | unit). */
  scope?: string;
  /** Severity level (P0 | P1 | P2 | P3). */
  severity?: string;
  /** Bypass BRAIN duplicate-task rejection (audited). */
  forceDuplicate?: boolean;
}

/**
 * JSON Schema draft-07 document describing the accepted input shape for
 * the `tasks.add` mutate operation.
 *
 * Mirrors {@link TasksAddParams} field-for-field. Set
 * `additionalProperties: false` so a typo'd flag fails fast with a typed
 * `E_VAL_ADDITIONALPROPERTIES` error instead of being silently dropped.
 *
 * @task T9917
 */
export const TASKS_ADD_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 500 },
    description: { type: 'string' },
    parent: { type: 'string' },
    depends: { type: 'array', items: { type: 'string' } },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    labels: { type: 'array', items: { type: 'string' } },
    type: { type: 'string', enum: ['saga', 'epic', 'task', 'subtask'] },
    acceptance: { type: 'array', items: { type: 'string' } },
    phase: { type: 'string' },
    size: { type: 'string', enum: ['small', 'medium', 'large'] },
    notes: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    dryRun: { type: 'boolean' },
    parentSearch: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['work', 'research', 'experiment', 'bug', 'spike', 'release'],
    },
    scope: { type: 'string', enum: ['project', 'feature', 'unit'] },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    forceDuplicate: { type: 'boolean' },
  },
};

/**
 * Schema-first input contract for `tasks.add`.
 *
 * @task T9917
 */
export const tasksAddInputContract: OperationInputContract<TasksAddParams> = {
  operation: 'tasks.add',
  schema: TASKS_ADD_INPUT_SCHEMA,
  examples: [
    {
      name: 'minimal',
      value: { title: 'Ship E7-MUTATE-DX-SCHEMA-FIRST' },
      description: 'Smallest valid input — title is the only required field.',
    },
    {
      name: 'subtask-with-acceptance',
      value: {
        title: 'Wire validator into add command',
        parent: 'T9903',
        priority: 'high',
        acceptance: ['validator runs before dispatch', 'errors surface in envelope'],
      },
    },
  ],
};

/**
 * JSON Schema draft-07 document describing the accepted input shape for
 * the `tasks.add-batch` mutate operation.
 *
 * Wraps N `tasks.add` specs in a single atomic transaction. `dryRun` is
 * hoisted to the batch level (single rollback unit), so the per-entry
 * schema OMITS `dryRun` deliberately.
 *
 * @task T9917
 */
export const TASKS_ADD_BATCH_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['tasks'],
  additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string' },
          parent: { type: 'string' },
          depends: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          labels: {
            type: 'array',
            items: { type: 'string' },
            'x-fix-hint': 'pass labels as a JSON array, e.g. ["pm-core-v2", "wave.3"]',
          },
          type: { type: 'string', enum: ['saga', 'epic', 'task', 'subtask'] },
          acceptance: {
            type: 'array',
            items: { type: 'string' },
            'x-fix-hint': 'pass acceptance as a JSON array, not a pipe-delimited string',
          },
          phase: { type: 'string' },
          size: { type: 'string', enum: ['small', 'medium', 'large'] },
          notes: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          kind: {
            type: 'string',
            enum: ['work', 'research', 'experiment', 'bug', 'spike', 'release'],
          },
          scope: { type: 'string', enum: ['project', 'feature', 'unit'] },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          forceDuplicate: { type: 'boolean' },
        },
      },
    },
    defaultParent: { type: 'string' },
    dryRun: { type: 'boolean' },
  },
};

/**
 * Schema-first input contract for `tasks.add-batch`.
 *
 * @task T9917
 */
export const tasksAddBatchInputContract: OperationInputContract<TasksAddBatchParams> = {
  operation: 'tasks.add-batch',
  schema: TASKS_ADD_BATCH_INPUT_SCHEMA,
  examples: [
    {
      name: 'two-tasks',
      value: {
        tasks: [
          {
            title: 'first task',
            labels: ['pm-core-v2', 'wave.3'],
            acceptance: ['first acceptance criterion'],
          },
          {
            title: 'second task',
            labels: ['batch'],
            acceptance: ['second acceptance criterion'],
          },
        ],
      },
      description: 'Atomic insert of two tasks under no shared parent.',
    },
    {
      name: 'with-default-parent',
      value: {
        defaultParent: 'T9903',
        tasks: [{ title: 'a' }, { title: 'b', parent: 'T9914' }],
      },
      description: 'defaultParent applies to entries without an explicit parent.',
    },
  ],
};

/**
 * JSON Schema draft-07 document describing the accepted input shape for
 * the `tasks.update` mutate operation.
 *
 * Mirrors {@link TasksUpdateQueryParams}. `taskId` is REQUIRED. All other
 * fields are optional — `tasks.update` is a partial update; only the
 * fields supplied are mutated.
 *
 * @task T9917
 */
export const TASKS_UPDATE_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['taskId'],
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    description: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'active', 'blocked', 'done', 'cancelled'],
    },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    notes: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
    addLabels: { type: 'array', items: { type: 'string' } },
    removeLabels: { type: 'array', items: { type: 'string' } },
    depends: { type: 'array', items: { type: 'string' } },
    addDepends: { type: 'array', items: { type: 'string' } },
    removeDepends: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
    parent: { type: ['string', 'null'] },
    type: { type: 'string', enum: ['saga', 'epic', 'task', 'subtask'] },
    size: { type: 'string', enum: ['small', 'medium', 'large'] },
    files: { type: 'array', items: { type: 'string' } },
    addFiles: { type: 'array', items: { type: 'string' } },
    removeFiles: { type: 'array', items: { type: 'string' } },
    pipelineStage: { type: 'string' },
    kind: {
      type: 'string',
      enum: ['work', 'research', 'experiment', 'bug', 'spike', 'release'],
    },
    scope: { type: 'string', enum: ['project', 'feature', 'unit'] },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    reason: { type: 'string' },
    dependsWaiver: { type: 'string' },
    clearBlockedBy: { type: 'boolean' },
    relates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['taskId', 'type'],
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', minLength: 1 },
          type: { type: 'string', minLength: 1 },
          reason: { type: 'string' },
        },
      },
    },
    addRelates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['taskId', 'type'],
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', minLength: 1 },
          type: { type: 'string', minLength: 1 },
          reason: { type: 'string' },
        },
      },
    },
    removeRelates: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Schema-first input contract for `tasks.update`.
 *
 * @task T9917
 */
export const tasksUpdateInputContract: OperationInputContract<TasksUpdateQueryParams> = {
  operation: 'tasks.update',
  schema: TASKS_UPDATE_INPUT_SCHEMA,
  examples: [
    {
      name: 'set-status',
      value: { taskId: 'T9917', status: 'active' },
      description: 'Transition status to active.',
    },
    {
      name: 'add-labels-incrementally',
      value: {
        taskId: 'T9917',
        addLabels: ['saga.t9855', 'epic.t9903'],
      },
    },
  ],
};
