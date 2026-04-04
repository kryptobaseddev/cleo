/**
 * Tasks Domain Operations (22 operations)
 *
 * Query operations: 10
 * Mutate operations: 12
 *
 * SYNC: Canonical type definitions live in the CLI package at:
 *   src/types/task.ts (TaskStatus, TaskPriority, Task, etc.)
 * These operation types are the API contract (wire format).
 * Internal domain types must stay aligned with CLI definitions.
 */

/**
 * Common task types (API contract — matches CLI src/types/task.ts)
 */
import type { TaskStatus } from '../status-registry.js';

export type { TaskStatus };
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

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

// tasks.get
export interface TasksGetParams {
  taskId: string;
}
export type TasksGetResult = TaskOp;

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
export interface TasksFindParams {
  query: string;
  limit?: number;
}
export type TasksFindResult = MinimalTask[];

// tasks.exists
export interface TasksExistsParams {
  taskId: string;
}
export interface TasksExistsResult {
  exists: boolean;
  taskId: string;
}

// tasks.tree
export interface TasksTreeParams {
  rootId?: string;
  depth?: number;
}
export interface TaskTreeNode {
  task: TaskOp;
  children: TaskTreeNode[];
  depth: number;
}
export type TasksTreeResult = TaskTreeNode[];

// tasks.blockers
export interface TasksBlockersParams {
  taskId: string;
}
export interface Blocker {
  taskId: string;
  title: string;
  status: TaskStatus;
  blockType: 'dependency' | 'parent' | 'gate';
}
export type TasksBlockersResult = Blocker[];

// tasks.deps
export interface TasksDepsParams {
  taskId: string;
  direction?: 'upstream' | 'downstream' | 'both';
}
export interface TaskDependencyNode {
  taskId: string;
  title: string;
  status: TaskStatus;
  distance: number;
}
export interface TasksDepsResult {
  taskId: string;
  upstream: TaskDependencyNode[];
  downstream: TaskDependencyNode[];
}

// tasks.analyze
export interface TasksAnalyzeParams {
  epicId?: string;
}
export interface TriageRecommendation {
  taskId: string;
  title: string;
  priority: number;
  reason: string;
  readiness: 'ready' | 'blocked' | 'pending';
}
export type TasksAnalyzeResult = TriageRecommendation[];

// tasks.next
export interface TasksNextParams {
  epicId?: string;
  count?: number;
}
export interface SuggestedTask {
  taskId: string;
  title: string;
  score: number;
  rationale: string;
}
export type TasksNextResult = SuggestedTask[];

/**
 * Mutate Operations
 */

// tasks.create
export interface TasksCreateParams {
  title: string;
  description: string;
  parent?: string;
  depends?: string[];
  priority?: TaskPriority;
  labels?: string[];
}
export type TasksCreateResult = TaskOp;

// tasks.update
export interface TasksUpdateParams {
  taskId: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  notes?: string;
  parent?: string | null; // Set parent ID, or null/"" to promote to root
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  type?: string;
  size?: string;
}
export type TasksUpdateResult = TaskOp;

// tasks.complete
export interface TasksCompleteParams {
  taskId: string;
  notes?: string;
  archive?: boolean;
}
export interface TasksCompleteResult {
  taskId: string;
  completed: string;
  archived: boolean;
}

// tasks.delete
export interface TasksDeleteParams {
  taskId: string;
  force?: boolean;
}
export interface TasksDeleteResult {
  taskId: string;
  deleted: true;
}

// tasks.archive
export interface TasksArchiveParams {
  taskId?: string;
  before?: string;
}
export interface TasksArchiveResult {
  archived: number;
  taskIds: string[];
}

// tasks.unarchive
export interface TasksUnarchiveParams {
  taskId: string;
}
export type TasksUnarchiveResult = TaskOp;

// tasks.reparent
export interface TasksReparentParams {
  taskId: string;
  newParent: string;
}
export type TasksReparentResult = TaskOp;

// tasks.promote
export interface TasksPromoteParams {
  taskId: string;
}
export type TasksPromoteResult = TaskOp;

// tasks.reorder
export interface TasksReorderParams {
  taskId: string;
  position: number;
}
export interface TasksReorderResult {
  taskId: string;
  newPosition: number;
}

// tasks.restore (completed tasks) — alias: reopen
export interface TasksReopenParams {
  taskId: string;
}
export type TasksReopenResult = TaskOp;

// tasks.start (begin working on a task)
export interface TasksStartParams {
  taskId: string;
}
export interface TasksStartResult {
  taskId: string;
  sessionId: string;
  timestamp: string;
}

// tasks.stop (stop working on current task)
export type TasksStopParams = Record<string, never>;
export interface TasksStopResult {
  stopped: true;
  previousTask?: string;
}

// tasks.current (get currently active task)
export type TasksCurrentParams = Record<string, never>;
export interface TasksCurrentResult {
  taskId: string | null;
  since?: string;
  sessionId?: string;
}
