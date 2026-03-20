/**
 * Task synchronization contracts for provider-agnostic task reconciliation.
 *
 * Defines the interface for syncing external issue/task systems (Linear, Jira,
 * GitHub Issues, GitLab, etc.) with CLEO as SSoT. Provider adapters normalize
 * their native formats into ExternalTask[], and the reconciliation engine
 * handles diffing, creating, updating, and linking.
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
  /** Human-readable title. */
  title: string;
  /** Normalized status. */
  status: ExternalTaskStatus;
  /** Optional description text. */
  description?: string;
  /** Optional priority mapping (provider decides how to map). */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Optional task type mapping. */
  type?: 'epic' | 'task' | 'subtask';
  /** Optional labels/tags from the provider. */
  labels?: string[];
  /** Optional URL to the external task (for linking). */
  url?: string;
  /** Optional parent external ID (for hierarchy). */
  parentExternalId?: string;
  /** Arbitrary provider-specific metadata (opaque to core). */
  providerMeta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// External task link (DB-backed tracking)
// ---------------------------------------------------------------------------

/** How an external task link was established. */
export type ExternalLinkType = 'created' | 'matched' | 'manual' | 'transferred';

/** Direction of the sync that established the link. */
export type SyncDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * A link between a CLEO task and an external provider task.
 * Stored in the external_task_links table in tasks.db.
 */
export interface ExternalTaskLink {
  /** Link ID (UUID). */
  id: string;
  /** CLEO task ID. */
  taskId: string;
  /** Provider identifier (e.g. 'linear', 'jira', 'github'). */
  providerId: string;
  /** Provider-assigned external task ID. */
  externalId: string;
  /** URL to the external task. */
  externalUrl?: string | null;
  /** Title at time of last sync. */
  externalTitle?: string | null;
  /** How this link was established. */
  linkType: ExternalLinkType;
  /** Sync direction. */
  syncDirection: SyncDirection;
  /** Provider-specific metadata (JSON). */
  metadata?: Record<string, unknown>;
  /** When the link was first established. */
  linkedAt: string;
  /** When the external task was last synchronized. */
  lastSyncAt?: string | null;
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
  /** Provider ID (e.g. 'linear', 'jira', 'github'). */
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
export type ReconcileActionType =
  | 'create'
  | 'update'
  | 'complete'
  | 'activate'
  | 'skip'
  | 'conflict';

/** A single reconciliation action (planned or applied). */
export interface ReconcileAction {
  /** What kind of change. */
  type: ReconcileActionType;
  /** The CLEO task ID affected (null for creates before they happen). */
  cleoTaskId: string | null;
  /** The external task ID that triggered this action. */
  externalId: string;
  /** Human-readable description of the action. */
  summary: string;
  /** Whether this action was actually applied. */
  applied: boolean;
  /** The link ID if a link was created or updated. */
  linkId?: string;
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
    created: number;
    updated: number;
    completed: number;
    activated: number;
    skipped: number;
    conflicts: number;
    total: number;
    applied: number;
  };
  /** Links created or updated during this reconciliation. */
  linksAffected: number;
}

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

/**
 * Interface that provider adapters implement to expose their external
 * task system to the reconciliation engine.
 *
 * Provider-specific parsing lives in the adapter — core never sees native formats.
 * Consumers implement this interface to integrate their issue tracker with CLEO.
 *
 * @example
 * ```typescript
 * class LinearAdapter implements ExternalTaskProvider {
 *   async getExternalTasks(projectDir: string): Promise<ExternalTask[]> {
 *     const issues = await linearClient.issues({ projectId: '...' });
 *     return issues.map(issue => ({
 *       externalId: issue.id,
 *       title: issue.title,
 *       status: mapLinearStatus(issue.state),
 *       description: issue.description,
 *       priority: mapLinearPriority(issue.priority),
 *       labels: issue.labels.map(l => l.name),
 *       url: issue.url,
 *       providerMeta: { linearId: issue.identifier },
 *     }));
 *   }
 * }
 * ```
 */
export interface ExternalTaskProvider {
  /**
   * Read the provider's current task state and return normalized ExternalTasks.
   *
   * @param projectDir - Project root directory.
   * @returns Array of external tasks in normalized form.
   */
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;

  /**
   * Optionally push CLEO task state back to the provider (outbound sync).
   * Not all providers support bidirectional sync.
   *
   * @param tasks - Current CLEO tasks to push.
   * @param projectDir - Project root directory.
   */
  pushTaskState?(
    tasks: ReadonlyArray<{ id: string; title: string; status: string }>,
    projectDir: string,
  ): Promise<void>;
}
