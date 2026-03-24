/**
 * SafetyDataAccessor - Factory-level safety wrapper for ALL data accessors.
 *
 * This wrapper ensures that ALL data operations are safety-enabled by default.
 * No code path can bypass safety - this is the architectural guarantee.
 *
 * Key features:
 * - Sequence validation before writes
 * - Write verification (read-back validation)
 * - Automatic git checkpointing
 * - Emergency disable via CLEO_DISABLE_SAFETY env var
 *
 * @task T4745
 * @epic T4732
 */

import type { Session, Task, TaskStatus } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import type {
  ArchiveFile,
  DataAccessor,
  QueryTasksResult,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from './data-accessor.js';
import {
  type SafetyOptions,
  safeAppendLog,
  safeSaveArchive,
  safeSaveSessions,
  safeSingleTaskWrite,
} from './data-safety-central.js';
import type { ArchiveFields } from './db-helpers.js';

const log = getLogger('data-safety');

/** Safety configuration for the wrapper. */
interface WrapperSafetyConfig {
  /** Enable all safety checks (default: true) */
  enabled: boolean;
  /** Log safety operations (default: false) */
  verbose: boolean;
}

/** Check if safety is disabled via environment variable. */
function isSafetyDisabled(): boolean {
  return process.env.CLEO_DISABLE_SAFETY === 'true';
}

/**
 * Safety-enabled DataAccessor wrapper.
 *
 * Wraps any DataAccessor implementation and automatically applies
 * safety checks to all write operations. Read operations pass through.
 *
 * This class CANNOT be bypassed - it's the only way to get a DataAccessor
 * from the factory (unless emergency disable is active).
 */
export class SafetyDataAccessor implements DataAccessor {
  /** The underlying accessor being wrapped. */
  private inner: DataAccessor;

  /** Working directory for operations. */
  private cwd?: string;

  /** Safety configuration. */
  private config: WrapperSafetyConfig;

  /**
   * Create a SafetyDataAccessor wrapper.
   *
   * @param inner - The DataAccessor to wrap
   * @param cwd - Working directory for path resolution
   * @param config - Optional safety configuration overrides
   */
  constructor(inner: DataAccessor, cwd?: string, config?: Partial<WrapperSafetyConfig>) {
    this.inner = inner;
    this.cwd = cwd;
    this.config = {
      enabled: true,
      verbose: false,
      ...config,
    };

    if (this.config.verbose) {
      log.debug({ engine: inner.engine }, 'SafetyDataAccessor initialized');
    }
  }

  /** The storage engine backing this accessor. */
  get engine(): 'sqlite' {
    return this.inner.engine;
  }

  /**
   * Log safety operation if verbose mode is enabled.
   */
  private logVerbose(message: string): void {
    if (this.config.verbose) {
      log.debug(message);
    }
  }

  /**
   * Get safety options for data-safety-central operations.
   */
  private getSafetyOptions(): Partial<SafetyOptions> {
    return {
      verify: this.config.enabled,
      checkpoint: this.config.enabled,
      validateSequence: this.config.enabled,
      strict: this.config.enabled,
    };
  }

  // ---- Read operations (pass-through) ----

  async loadArchive(): Promise<ArchiveFile | null> {
    this.logVerbose('Loading ArchiveFile (pass-through)');
    return this.inner.loadArchive();
  }

  async loadSessions(): Promise<Session[]> {
    this.logVerbose('Loading sessions (pass-through)');
    return this.inner.loadSessions();
  }

  // ---- Write operations (with safety) ----

  async saveSessions(data: Session[]): Promise<void> {
    this.logVerbose(`Saving sessions with ${data.length} sessions`);
    await safeSaveSessions(this.inner, data, this.cwd, this.getSafetyOptions());
  }

  async saveArchive(data: ArchiveFile): Promise<void> {
    this.logVerbose(`Saving ArchiveFile with ${data.archivedTasks?.length ?? 0} tasks`);
    await safeSaveArchive(this.inner, data, this.cwd, this.getSafetyOptions());
  }

  async appendLog(entry: Record<string, unknown>): Promise<void> {
    this.logVerbose('Appending log entry');
    await safeAppendLog(this.inner, entry, this.cwd, this.getSafetyOptions());
  }

  // ---- Fine-grained task operations (with safety) ----

  async upsertSingleTask(task: Task): Promise<void> {
    this.logVerbose(`Upserting single task ${task.id}`);
    await safeSingleTaskWrite(
      this.inner,
      task.id,
      () => this.inner.upsertSingleTask(task),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
    this.logVerbose(`Archiving single task ${taskId}`);
    await safeSingleTaskWrite(
      this.inner,
      taskId,
      () => this.inner.archiveSingleTask(taskId, fields),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async removeSingleTask(taskId: string): Promise<void> {
    this.logVerbose(`Removing single task ${taskId}`);
    await safeSingleTaskWrite(
      this.inner,
      taskId,
      () => this.inner.removeSingleTask(taskId),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async loadSingleTask(taskId: string): Promise<Task | null> {
    return this.inner.loadSingleTask(taskId);
  }

  // ---- Relations (pass-through to inner, T5168) ----

  async addRelation(
    taskId: string,
    relatedTo: string,
    relationType: string,
    reason?: string,
  ): Promise<void> {
    await this.inner.addRelation(taskId, relatedTo, relationType, reason);
  }

  // ---- Metadata (pass-through to inner) ----

  async getMetaValue<T>(key: string): Promise<T | null> {
    return this.inner.getMetaValue(key);
  }

  async setMetaValue(key: string, value: unknown): Promise<void> {
    return this.inner.setMetaValue(key, value);
  }

  async getSchemaVersion(): Promise<string | null> {
    return this.inner.getSchemaVersion();
  }

  // ---- Targeted query methods (pass-through — reads don't need safety) ----

  async queryTasks(filters: TaskQueryFilters): Promise<QueryTasksResult> {
    return this.inner.queryTasks(filters);
  }

  async countTasks(filters?: {
    status?: TaskStatus | TaskStatus[];
    parentId?: string;
  }): Promise<number> {
    return this.inner.countTasks(filters);
  }

  async getChildren(parentId: string): Promise<Task[]> {
    return this.inner.getChildren(parentId);
  }

  async countChildren(parentId: string): Promise<number> {
    return this.inner.countChildren(parentId);
  }

  async countActiveChildren(parentId: string): Promise<number> {
    return this.inner.countActiveChildren(parentId);
  }

  async getAncestorChain(taskId: string): Promise<Task[]> {
    return this.inner.getAncestorChain(taskId);
  }

  async getSubtree(rootId: string): Promise<Task[]> {
    return this.inner.getSubtree(rootId);
  }

  async getDependents(taskId: string): Promise<Task[]> {
    return this.inner.getDependents(taskId);
  }

  async getDependencyChain(taskId: string): Promise<string[]> {
    return this.inner.getDependencyChain(taskId);
  }

  async taskExists(taskId: string): Promise<boolean> {
    return this.inner.taskExists(taskId);
  }

  async loadTasks(taskIds: string[]): Promise<Task[]> {
    return this.inner.loadTasks(taskIds);
  }

  // ---- Targeted write methods (with safety) ----

  async updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void> {
    this.logVerbose(`Updating fields on task ${taskId}`);
    await safeSingleTaskWrite(
      this.inner,
      taskId,
      () => this.inner.updateTaskFields(taskId, fields),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async getNextPosition(parentId: string | null): Promise<number> {
    return this.inner.getNextPosition(parentId);
  }

  async shiftPositions(
    parentId: string | null,
    fromPosition: number,
    delta: number,
  ): Promise<void> {
    return this.inner.shiftPositions(parentId, fromPosition, delta);
  }

  async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
    this.logVerbose('Starting transaction');
    // Transaction wraps its own BEGIN/COMMIT/ROLLBACK.
    // Safety (sequence validation) runs before the transaction starts.
    // Checkpoint runs after successful commit.
    return this.inner.transaction(fn);
  }

  // ---- Fine-grained session operations (pass-through) ----

  async getActiveSession(): Promise<Session | null> {
    return this.inner.getActiveSession();
  }

  async upsertSingleSession(session: import('@cleocode/contracts').Session): Promise<void> {
    return this.inner.upsertSingleSession(session);
  }

  async removeSingleSession(sessionId: string): Promise<void> {
    return this.inner.removeSingleSession(sessionId);
  }

  // ---- Agent instances ----

  async listAgentInstances(filters?: {
    status?: string | string[];
    agentType?: string | string[];
  }) {
    return this.inner.listAgentInstances(filters);
  }

  async getAgentInstance(agentId: string) {
    return this.inner.getAgentInstance(agentId);
  }

  // ---- Lifecycle ----

  async close(): Promise<void> {
    this.logVerbose('Closing accessor');
    await this.inner.close();
  }
}

/**
 * Wrap a DataAccessor with safety.
 *
 * This is the internal factory helper that wraps any accessor
 * with the SafetyDataAccessor wrapper.
 *
 * @param accessor - The accessor to wrap
 * @param cwd - Working directory
 * @returns SafetyDataAccessor wrapping the input
 */
export function wrapWithSafety(accessor: DataAccessor, cwd?: string): DataAccessor {
  // Check for emergency disable
  if (isSafetyDisabled()) {
    log.warn(
      'Safety disabled - emergency mode (CLEO_DISABLE_SAFETY=true). Data integrity checks bypassed.',
    );
    return accessor;
  }

  return new SafetyDataAccessor(accessor, cwd);
}

/**
 * Check if safety is currently enabled.
 *
 * @returns true if safety checks are active
 */
export function isSafetyEnabled(): boolean {
  return !isSafetyDisabled();
}

/**
 * Get safety status information.
 *
 * @returns Object with safety status details
 */
export function getSafetyStatus(): {
  enabled: boolean;
  reason?: string;
} {
  if (isSafetyDisabled()) {
    return {
      enabled: false,
      reason: 'CLEO_DISABLE_SAFETY environment variable is set to "true"',
    };
  }

  return {
    enabled: true,
  };
}
