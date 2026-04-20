/**
 * Types for TASKS → NEXUS bridge operations.
 *
 * Enables querying which tasks touched which symbols (T1067).
 * Supports forward lookup (task → symbols) and reverse lookup (symbol → tasks).
 *
 * @task T1067
 * @epic T1042
 */

/**
 * A single task reference in a symbol context.
 * Used by getTasksForSymbol() reverse-lookup queries.
 */
export interface TaskReference {
  /** Task ID (e.g., 'T001'). */
  taskId: string;
  /** Display label for the task. */
  label: string;
  /** Edge weight (confidence) that this task touched the symbol. */
  weight: number;
  /** Human-readable match strategy used ('git-log-file', 'file-symbol-match', etc.). */
  matchStrategy: string;
}

/**
 * A single symbol reference in a task context.
 * Used by getSymbolsForTask() forward-lookup queries.
 */
export interface SymbolReference {
  /** Nexus node ID (format: '<filePath>::<name>' or '<filePath>'). */
  nexusNodeId: string;
  /** Display label for the symbol (file path or function name). */
  label: string;
  /** Symbol kind ('function', 'class', 'file', etc.). */
  kind: string;
  /** File path where this symbol is defined. */
  filePath: string | null;
  /** Edge weight (confidence) that the task touched this symbol. */
  weight: number;
  /** Human-readable match strategy used ('git-log-file', 'file-symbol-match', etc.). */
  matchStrategy: string;
}

/**
 * Result from linkTaskToSymbols() operation.
 */
export interface LinkTaskResult {
  /** Number of task_touches_symbol edges created or found. */
  linked: number;
  /** Task ID that was linked. */
  taskId: string;
  /** Number of files processed from task.files_json. */
  filesProcessed: number;
  /** Number of symbols found in those files. */
  symbolsFound: number;
}

/**
 * Result from runGitLogTaskLinker() git-log sweep operation.
 */
export interface GitLogLinkerResult {
  /** Total number of task_touches_symbol edges created or found across all tasks. */
  linked: number;
  /** Commits processed from git log since --since. */
  commitsProcessed: number;
  /** Unique task IDs extracted from commit messages. */
  tasksFound: number;
  /** Last commit hash processed (stored for idempotency). */
  lastCommitHash: string | null;
}
