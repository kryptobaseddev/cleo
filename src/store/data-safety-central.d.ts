/**
 * Centralized Data Safety Manager
 *
 * SINGLE POINT OF SAFETY for ALL CLEO data operations.
 *
 * Design Principles:
 * - All data operations MUST flow through this layer
 * - Zero-config safety: works automatically for all callers
 * - Atomic operations: verify + checkpoint + log in single transaction
 * - Recoverable: every operation leaves system in valid state
 *
 * This eliminates the need for wrapper functions and ensures safety
 * at the architectural level, not as an afterthought.
 *
 * @task T4739
 * @epic T4732
 */
import type { Session } from '../types/session.js';
import type { TaskFile } from '../types/task.js';
import type { ArchiveFile, DataAccessor } from './data-accessor.js';
/** Safety violation error */
export declare class DataSafetyError extends Error {
    code: 'COLLISION' | 'WRITE_FAILED' | 'VERIFICATION_FAILED' | 'SEQUENCE_INVALID';
    context?: Record<string, unknown> | undefined;
    constructor(message: string, code: 'COLLISION' | 'WRITE_FAILED' | 'VERIFICATION_FAILED' | 'SEQUENCE_INVALID', context?: Record<string, unknown> | undefined);
}
/** Safety configuration - can be overridden per-operation */
export interface SafetyOptions {
    /** Verify data was written (default: true) */
    verify: boolean;
    /** Create git checkpoint (default: true) */
    checkpoint: boolean;
    /** Validate sequence (default: true) */
    validateSequence: boolean;
    /** Strict mode - throw on any issue (default: true) */
    strict: boolean;
}
/** Statistics for monitoring */
interface SafetyStats {
    writes: number;
    verifications: number;
    checkpoints: number;
    errors: number;
    lastCheckpoint: Date | null;
}
/** Get current safety statistics */
export declare function getSafetyStats(): SafetyStats;
/** Reset safety statistics (for testing) */
export declare function resetSafetyStats(): void;
/**
 * Safe wrapper for DataAccessor.saveTaskFile()
 *
 * Performs:
 * 1. Sequence validation
 * 2. Write operation
 * 3. Verification (read back and validate)
 * 4. Git checkpoint
 */
export declare function safeSaveTaskFile(accessor: DataAccessor, data: TaskFile, cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Preferred alias for task domain data writes.
 * Maintained alongside safeSaveTaskFile for compatibility.
 */
export declare function safeSaveTaskData(accessor: DataAccessor, data: TaskFile, cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Safe wrapper for DataAccessor.saveSessions()
 */
export declare function safeSaveSessions(accessor: DataAccessor, data: Session[], cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Safe wrapper for DataAccessor.saveArchive()
 */
export declare function safeSaveArchive(accessor: DataAccessor, data: ArchiveFile, cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Safe wrapper for single-task write operations (T5034).
 *
 * Performs:
 * 1. Sequence validation
 * 2. Write operation (caller-provided function)
 * 3. Git checkpoint
 *
 * Verification is lightweight — no full-file read-back. The write
 * itself is a targeted SQL operation that either succeeds or throws.
 */
export declare function safeSingleTaskWrite(_accessor: DataAccessor, taskId: string, writeFn: () => Promise<void>, cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Safe wrapper for DataAccessor.appendLog()
 *
 * Note: Log appends are fire-and-forget (no verification)
 * but we still checkpoint to ensure data is committed.
 */
export declare function safeAppendLog(accessor: DataAccessor, entry: Record<string, unknown>, cwd?: string, options?: Partial<SafetyOptions>): Promise<void>;
/**
 * Run comprehensive data integrity check.
 * Validates all data files and sequence consistency.
 */
export declare function runDataIntegrityCheck(accessor: DataAccessor, cwd?: string): Promise<{
    passed: boolean;
    errors: string[];
    warnings: string[];
    stats: SafetyStats;
}>;
/**
 * Force immediate checkpoint.
 * Use before destructive operations.
 */
export declare function forceSafetyCheckpoint(context: string, cwd?: string): Promise<void>;
/**
 * Disable all safety for current process.
 * DANGEROUS - only use for recovery operations.
 */
export declare function disableSafety(): void;
/**
 * Re-enable safety after being disabled.
 */
export declare function enableSafety(): void;
export {};
//# sourceMappingURL=data-safety-central.d.ts.map