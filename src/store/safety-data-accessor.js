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
import { getLogger } from '../core/logger.js';
import { safeAppendLog, safeSaveArchive, safeSaveSessions, safeSaveTaskFile, safeSingleTaskWrite, } from './data-safety-central.js';
const log = getLogger('data-safety');
/** Check if safety is disabled via environment variable. */
function isSafetyDisabled() {
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
export class SafetyDataAccessor {
    /** The underlying accessor being wrapped. */
    inner;
    /** Working directory for operations. */
    cwd;
    /** Safety configuration. */
    config;
    /**
     * Create a SafetyDataAccessor wrapper.
     *
     * @param inner - The DataAccessor to wrap
     * @param cwd - Working directory for path resolution
     * @param config - Optional safety configuration overrides
     */
    constructor(inner, cwd, config) {
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
    get engine() {
        return this.inner.engine;
    }
    /**
     * Log safety operation if verbose mode is enabled.
     */
    logVerbose(message) {
        if (this.config.verbose) {
            log.debug(message);
        }
    }
    /**
     * Get safety options for data-safety-central operations.
     */
    getSafetyOptions() {
        return {
            verify: this.config.enabled,
            checkpoint: this.config.enabled,
            validateSequence: this.config.enabled,
            strict: this.config.enabled,
        };
    }
    // ---- Read operations (pass-through) ----
    async loadTaskFile() {
        this.logVerbose('Loading TaskFile (pass-through)');
        // Call deprecated method on inner accessor (underlying implementations use old names)
        return this.inner.loadTaskFile();
    }
    async loadArchive() {
        this.logVerbose('Loading ArchiveFile (pass-through)');
        return this.inner.loadArchive();
    }
    async loadSessions() {
        this.logVerbose('Loading sessions (pass-through)');
        return this.inner.loadSessions();
    }
    // ---- Write operations (with safety) ----
    async saveTaskFile(data) {
        this.logVerbose(`Saving TaskFile with ${data.tasks?.length ?? 0} tasks`);
        await safeSaveTaskFile(this.inner, data, this.cwd, this.getSafetyOptions());
    }
    async saveSessions(data) {
        this.logVerbose(`Saving sessions with ${data.length} sessions`);
        await safeSaveSessions(this.inner, data, this.cwd, this.getSafetyOptions());
    }
    async saveArchive(data) {
        this.logVerbose(`Saving ArchiveFile with ${data.archivedTasks?.length ?? 0} tasks`);
        await safeSaveArchive(this.inner, data, this.cwd, this.getSafetyOptions());
    }
    async appendLog(entry) {
        this.logVerbose('Appending log entry');
        await safeAppendLog(this.inner, entry, this.cwd, this.getSafetyOptions());
    }
    // ---- Fine-grained task operations (with safety) ----
    async upsertSingleTask(task) {
        if (!this.inner.upsertSingleTask)
            return;
        this.logVerbose(`Upserting single task ${task.id}`);
        await safeSingleTaskWrite(this.inner, task.id, () => this.inner.upsertSingleTask(task), this.cwd, this.getSafetyOptions());
    }
    async archiveSingleTask(taskId, fields) {
        if (!this.inner.archiveSingleTask)
            return;
        this.logVerbose(`Archiving single task ${taskId}`);
        await safeSingleTaskWrite(this.inner, taskId, () => this.inner.archiveSingleTask(taskId, fields), this.cwd, this.getSafetyOptions());
    }
    async removeSingleTask(taskId) {
        if (!this.inner.removeSingleTask)
            return;
        this.logVerbose(`Removing single task ${taskId}`);
        await safeSingleTaskWrite(this.inner, taskId, () => this.inner.removeSingleTask(taskId), this.cwd, this.getSafetyOptions());
    }
    // ---- Relations (pass-through to inner, T5168) ----
    async addRelation(taskId, relatedTo, relationType, reason) {
        if (!this.inner.addRelation)
            return;
        await this.inner.addRelation(taskId, relatedTo, relationType, reason);
    }
    // ---- Metadata (pass-through to inner) ----
    async getMetaValue(key) {
        return this.inner.getMetaValue?.(key) ?? null;
    }
    async setMetaValue(key, value) {
        return this.inner.setMetaValue?.(key, value);
    }
    async getSchemaVersion() {
        return this.inner.getSchemaVersion?.() ?? null;
    }
    // ---- Lifecycle ----
    async close() {
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
export function wrapWithSafety(accessor, cwd) {
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
export function isSafetyEnabled() {
    return !isSafetyDisabled();
}
/**
 * Get safety status information.
 *
 * @returns Object with safety status details
 */
export function getSafetyStatus() {
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
//# sourceMappingURL=safety-data-accessor.js.map