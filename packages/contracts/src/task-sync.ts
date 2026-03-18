/**
 * Task synchronization contracts for provider-agnostic task reconciliation.
 *
 * Replaces the legacy Claude Code-specific TodoWrite integration with a
 * provider-agnostic system. Any provider adapter can implement
 * AdapterTaskSyncProvider to sync its external task system with CLEO as SSoT.
 *
 * @task T5800
 */

// ---------------------------------------------------------------------------
// External task representation (provider-agnostic)
// ---------------------------------------------------------------------------

/** Normalized status for tasks coming from an external provider. */
export type ExternalTaskStatus = 'pending' | 'active' | 'completed' | 'removed';

/**
 * A task as reported by an external provider, normalized to a common shape.
 * Provider-specific adapters translate their native format into this.
 */
export interface ExternalTask {
  /** Provider-assigned identifier for this task (opaque to core). */
  externalId: string;
  /** Mapped CLEO task ID, or null if the task is new / unmatched. */
  cleoTaskId: string | null;
  /** Human-readable title. */
  title: string;
  /** Normalized status. */
  status: ExternalTaskStatus;
  /** Optional description text. */
  description?: string;
  /** Optional labels/tags from the provider. */
  labels?: string[];
  /** Arbitrary provider-specific metadata (opaque to core). */
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sync session state
// ---------------------------------------------------------------------------

/**
 * Persistent state for a sync session between CLEO and a provider.
 * Stored per-provider under `.cleo/sync/<providerId>-session.json`.
 */
export interface SyncSessionState {
  /** CLEO task IDs that were injected into the provider's task list. */
  injectedTaskIds: string[];
  /** Optional phase context when tasks were injected. */
  injectedPhase?: string;
  /** Per-task metadata at injection time. */
  taskMetadata?: Record<string, { phase?: string }>;
  /** ISO timestamp of the last successful reconciliation. */
  lastSyncAt?: string;
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Policy for resolving conflicts between CLEO and provider state.
 *
 * - `cleo-wins`: CLEO state takes precedence (default).
 * - `provider-wins`: Provider state takes precedence.
 * - `latest-wins`: Most recently modified value wins.
 * - `report-only`: Report conflicts without applying changes.
 */
export type ConflictPolicy = 'cleo-wins' | 'provider-wins' | 'latest-wins' | 'report-only';

// ---------------------------------------------------------------------------
// Reconciliation options and results
// ---------------------------------------------------------------------------

/** Options for the reconciliation engine. */
export interface ReconcileOptions {
  /** Provider ID (e.g. 'claude-code', 'cursor'). */
  providerId: string;
  /** Working directory (project root). */
  cwd?: string;
  /** If true, compute actions without applying them. */
  dryRun?: boolean;
  /** Conflict resolution policy. Defaults to 'cleo-wins'. */
  conflictPolicy?: ConflictPolicy;
  /** Default phase for newly created tasks. */
  defaultPhase?: string;
  /** Default labels for newly created tasks. */
  defaultLabels?: string[];
}

/** The type of action the reconciliation engine will take. */
export type ReconcileActionType = 'complete' | 'activate' | 'create' | 'remove' | 'skip' | 'conflict';

/** A single reconciliation action (planned or applied). */
export interface ReconcileAction {
  /** What kind of change. */
  type: ReconcileActionType;
  /** The CLEO task ID affected (null for creates before they happen). */
  cleoTaskId: string | null;
  /** The external task that triggered this action. */
  externalId: string;
  /** Human-readable description of the action. */
  summary: string;
  /** Whether this action was actually applied. */
  applied: boolean;
  /** Error message if the action failed during apply. */
  error?: string;
}

/** Result of a full reconciliation run. */
export interface ReconcileResult {
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Provider that was reconciled. */
  providerId: string;
  /** Individual actions taken (or planned). */
  actions: ReconcileAction[];
  /** Summary counts. */
  summary: {
    completed: number;
    activated: number;
    created: number;
    removed: number;
    skipped: number;
    conflicts: number;
    applied: number;
  };
  /** Whether sync session state was cleared after apply. */
  sessionCleared: boolean;
}

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

/**
 * Interface that provider adapters implement to expose their external
 * task system to the reconciliation engine.
 *
 * Provider-specific parsing lives here — core never sees native formats.
 */
export interface AdapterTaskSyncProvider {
  /**
   * Read the provider's current task state and return normalized ExternalTasks.
   *
   * @param projectDir - Project root directory.
   * @returns Array of external tasks in normalized form.
   */
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;

  /**
   * Optionally push CLEO task state back to the provider.
   * Not all providers support bidirectional sync.
   *
   * @param tasks - Current CLEO tasks to push.
   * @param projectDir - Project root directory.
   */
  pushTaskState?(tasks: ReadonlyArray<{ id: string; title: string; status: string }>, projectDir: string): Promise<void>;

  /**
   * Clean up provider-specific sync artifacts (e.g. state files).
   *
   * @param projectDir - Project root directory.
   */
  cleanup?(projectDir: string): Promise<void>;
}
