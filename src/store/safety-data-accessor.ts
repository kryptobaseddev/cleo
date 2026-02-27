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

import type { DataAccessor, ArchiveFile } from './data-accessor.js';
import type { Task, TaskFile } from '../types/task.js';
import type { Session } from '../types/session.js';
import type { ArchiveFields } from './db-helpers.js';
import {
  safeSaveTaskFile,
  safeSaveSessions,
  safeSaveArchive,
  safeAppendLog,
  safeSingleTaskWrite,
  type SafetyOptions,
} from './data-safety-central.js';
import { getLogger } from '../core/logger.js';

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
  constructor(
    inner: DataAccessor,
    cwd?: string,
    config?: Partial<WrapperSafetyConfig>,
  ) {
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

  async loadTaskFile(): Promise<TaskFile> {
    this.logVerbose('Loading TaskFile (pass-through)');
    // Call deprecated method on inner accessor (underlying implementations use old names)
    return this.inner.loadTaskFile();
  }

  async loadArchive(): Promise<ArchiveFile | null> {
    this.logVerbose('Loading ArchiveFile (pass-through)');
    return this.inner.loadArchive();
  }

  async loadSessions(): Promise<Session[]> {
    this.logVerbose('Loading sessions (pass-through)');
    return this.inner.loadSessions();
  }

  // ---- Write operations (with safety) ----

  async saveTaskFile(data: TaskFile): Promise<void> {
    this.logVerbose(`Saving TaskFile with ${data.tasks?.length ?? 0} tasks`);
    await safeSaveTaskFile(this.inner, data, this.cwd, this.getSafetyOptions());
  }

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
    if (!this.inner.upsertSingleTask) return;
    this.logVerbose(`Upserting single task ${task.id}`);
    await safeSingleTaskWrite(
      this.inner,
      task.id,
      () => this.inner.upsertSingleTask!(task),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
    if (!this.inner.archiveSingleTask) return;
    this.logVerbose(`Archiving single task ${taskId}`);
    await safeSingleTaskWrite(
      this.inner,
      taskId,
      () => this.inner.archiveSingleTask!(taskId, fields),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  async removeSingleTask(taskId: string): Promise<void> {
    if (!this.inner.removeSingleTask) return;
    this.logVerbose(`Removing single task ${taskId}`);
    await safeSingleTaskWrite(
      this.inner,
      taskId,
      () => this.inner.removeSingleTask!(taskId),
      this.cwd,
      this.getSafetyOptions(),
    );
  }

  // ---- Metadata (pass-through to inner) ----

  async getMetaValue<T>(key: string): Promise<T | null> {
    return this.inner.getMetaValue?.(key) ?? null;
  }

  async setMetaValue(key: string, value: unknown): Promise<void> {
    return this.inner.setMetaValue?.(key, value);
  }

  async getSchemaVersion(): Promise<string | null> {
    return this.inner.getSchemaVersion?.() ?? null;
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
export function wrapWithSafety(
  accessor: DataAccessor,
  cwd?: string,
): DataAccessor {
  // Check for emergency disable
  if (isSafetyDisabled()) {
    log.warn('Safety disabled - emergency mode (CLEO_DISABLE_SAFETY=true). Data integrity checks bypassed.');
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
