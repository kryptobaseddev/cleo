/**
 * TodoWrite types for Claude TodoWrite state merge operations.
 *
 * @task T4551
 */

/** TodoWrite item status as exported by Claude. */
export type TodoWriteItemStatus = 'pending' | 'in_progress' | 'completed';

/** TodoWrite item as exported by Claude. */
export interface TodoWriteItem {
  content: string;
  status: TodoWriteItemStatus;
  activeForm?: string;
}

/** TodoWrite state file format. */
export interface TodoWriteState {
  todos: TodoWriteItem[];
}

/** Sync session state for TodoWrite integration. */
export interface TodoWriteSyncSessionState {
  injected_tasks: string[];
  injectedPhase?: string;
  task_metadata?: Record<string, { phase?: string }>;
}

/** Detected changes from TodoWrite state analysis. */
export interface TodoWriteChangeSet {
  completed: string[];
  progressed: string[];
  newTasks: string[];
  removed: string[];
}

/** Action type for a TodoWrite merge change. */
export type TodoWriteChangeAction = 'complete' | 'create' | 'update';

/** A single change applied during TodoWrite merge. */
export interface TodoWriteChange {
  taskId: string;
  action: TodoWriteChangeAction;
  details?: string;
}

/** Result of a TodoWrite merge operation. */
export interface TodoWriteMergeResult {
  dryRun: boolean;
  changes: {
    completed: number;
    progressed: number;
    new: number;
    removed: number;
    applied: number;
  };
  sessionCleared?: boolean;
}
