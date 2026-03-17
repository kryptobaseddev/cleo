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
import type { Session } from '../types/session.js';
import type { Task, TaskFile } from '../types/task.js';
import type { ArchiveFile, DataAccessor } from './data-accessor.js';
import type { ArchiveFields } from './db-helpers.js';
/** Safety configuration for the wrapper. */
interface WrapperSafetyConfig {
    /** Enable all safety checks (default: true) */
    enabled: boolean;
    /** Log safety operations (default: false) */
    verbose: boolean;
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
export declare class SafetyDataAccessor implements DataAccessor {
    /** The underlying accessor being wrapped. */
    private inner;
    /** Working directory for operations. */
    private cwd?;
    /** Safety configuration. */
    private config;
    /**
     * Create a SafetyDataAccessor wrapper.
     *
     * @param inner - The DataAccessor to wrap
     * @param cwd - Working directory for path resolution
     * @param config - Optional safety configuration overrides
     */
    constructor(inner: DataAccessor, cwd?: string, config?: Partial<WrapperSafetyConfig>);
    /** The storage engine backing this accessor. */
    get engine(): 'sqlite';
    /**
     * Log safety operation if verbose mode is enabled.
     */
    private logVerbose;
    /**
     * Get safety options for data-safety-central operations.
     */
    private getSafetyOptions;
    loadTaskFile(): Promise<TaskFile>;
    loadArchive(): Promise<ArchiveFile | null>;
    loadSessions(): Promise<Session[]>;
    saveTaskFile(data: TaskFile): Promise<void>;
    saveSessions(data: Session[]): Promise<void>;
    saveArchive(data: ArchiveFile): Promise<void>;
    appendLog(entry: Record<string, unknown>): Promise<void>;
    upsertSingleTask(task: Task): Promise<void>;
    archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;
    removeSingleTask(taskId: string): Promise<void>;
    addRelation(taskId: string, relatedTo: string, relationType: string, reason?: string): Promise<void>;
    getMetaValue<T>(key: string): Promise<T | null>;
    setMetaValue(key: string, value: unknown): Promise<void>;
    getSchemaVersion(): Promise<string | null>;
    close(): Promise<void>;
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
export declare function wrapWithSafety(accessor: DataAccessor, cwd?: string): DataAccessor;
/**
 * Check if safety is currently enabled.
 *
 * @returns true if safety checks are active
 */
export declare function isSafetyEnabled(): boolean;
/**
 * Get safety status information.
 *
 * @returns Object with safety status details
 */
export declare function getSafetyStatus(): {
    enabled: boolean;
    reason?: string;
};
export {};
//# sourceMappingURL=safety-data-accessor.d.ts.map