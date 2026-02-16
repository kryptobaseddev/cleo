/**
 * Tasks Domain Operations (19 operations)
 *
 * Query operations: 9
 * Mutate operations: 10
 *
 * SYNC: Canonical type definitions live in the CLI package at:
 *   src/types/task.ts (TaskStatus, TaskPriority, Task, etc.)
 * These MCP operation types are the API contract (wire format).
 * Internal domain types must stay aligned with CLI definitions.
 */

/**
 * Common task types (API contract — matches CLI src/types/task.ts)
 */
export type TaskStatus = 'pending' | 'active' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
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
export type TasksGetResult = Task;

// tasks.list
export interface TasksListParams {
  parent?: string;
  status?: TaskStatus;
  limit?: number;
}
export type TasksListResult = Task[];

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
  task: Task;
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
export interface DependencyNode {
  taskId: string;
  title: string;
  status: TaskStatus;
  distance: number;
}
export interface TasksDepsResult {
  taskId: string;
  upstream: DependencyNode[];
  downstream: DependencyNode[];
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
export type TasksCreateResult = Task;

// tasks.update
export interface TasksUpdateParams {
  taskId: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  notes?: string;
}
export type TasksUpdateResult = Task;

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
export type TasksUnarchiveResult = Task;

// tasks.reparent
export interface TasksReparentParams {
  taskId: string;
  newParent: string;
}
export type TasksReparentResult = Task;

// tasks.promote
export interface TasksPromoteParams {
  taskId: string;
}
export type TasksPromoteResult = Task;

// tasks.reorder
export interface TasksReorderParams {
  taskId: string;
  position: number;
}
export interface TasksReorderResult {
  taskId: string;
  newPosition: number;
}

// tasks.reopen
export interface TasksReopenParams {
  taskId: string;
}
export type TasksReopenResult = Task;
