/**
 * Data Safety Module - Critical protection layer for CLEO data operations.
 *
 * Implements:
 * - Write verification (verify data was actually persisted)
 * - Collision detection (prevent duplicate task IDs)
 * - Sequence validation (ensure sequence counter matches database)
 * - Auto-checkpoint integration (git commit after writes)
 *
 * @task T4739
 * @epic T4732
 */
import type { Session } from '../types/session.js';
import type { Task } from '../types/task.js';
/** Safety configuration options. */
export interface SafetyConfig {
    /** Enable write verification (default: true) */
    verifyWrites: boolean;
    /** Enable collision detection (default: true) */
    detectCollisions: boolean;
    /** Enable sequence validation (default: true) */
    validateSequence: boolean;
    /** Enable auto-checkpoint (default: true) */
    autoCheckpoint: boolean;
    /** Throw on safety violations (default: true) */
    strictMode: boolean;
}
/** Safety violation error. */
export declare class SafetyError extends Error {
    code: string;
    details?: Record<string, unknown> | undefined;
    constructor(message: string, code: string, details?: Record<string, unknown> | undefined);
}
/**
 * Check if a task ID already exists (collision detection).
 * @throws SafetyError if task exists and strict mode is enabled
 */
export declare function checkTaskExists(taskId: string, cwd?: string, config?: Partial<SafetyConfig>): Promise<boolean>;
/**
 * Verify a task was actually written to the database.
 * @throws SafetyError if verification fails
 */
export declare function verifyTaskWrite(taskId: string, expectedData?: Partial<Task>, cwd?: string, config?: Partial<SafetyConfig>): Promise<boolean>;
/**
 * Validate and repair sequence if necessary.
 * @returns true if sequence was valid or successfully repaired
 */
export declare function validateAndRepairSequence(cwd?: string, config?: Partial<SafetyConfig>): Promise<{
    valid: boolean;
    repaired: boolean;
    oldCounter?: number;
    newCounter?: number;
}>;
/**
 * Trigger auto-checkpoint after successful write.
 */
export declare function triggerCheckpoint(context: string, cwd?: string, config?: Partial<SafetyConfig>): Promise<void>;
/**
 * Safely create a task with all safety mechanisms.
 * Wraps the actual createTask operation.
 */
export declare function safeCreateTask(createFn: () => Promise<Task>, task: Task, cwd?: string, config?: Partial<SafetyConfig>): Promise<Task>;
/**
 * Safely update a task with all safety mechanisms.
 */
export declare function safeUpdateTask(updateFn: () => Promise<Task | null>, taskId: string, updates: Partial<Task>, cwd?: string, config?: Partial<SafetyConfig>): Promise<Task | null>;
/**
 * Safely delete a task with all safety mechanisms.
 */
export declare function safeDeleteTask(deleteFn: () => Promise<boolean>, taskId: string, cwd?: string, config?: Partial<SafetyConfig>): Promise<boolean>;
/**
 * Verify session write.
 */
export declare function verifySessionWrite(sessionId: string, cwd?: string, config?: Partial<SafetyConfig>): Promise<boolean>;
/**
 * Safely create a session with all safety mechanisms.
 */
export declare function safeCreateSession(createFn: () => Promise<Session>, session: Session, cwd?: string, config?: Partial<SafetyConfig>): Promise<Session>;
/**
 * Force a checkpoint before destructive operations.
 * Use this before migrations, bulk updates, etc.
 */
export declare function forceCheckpointBeforeOperation(operation: string, cwd?: string): Promise<void>;
/**
 * Run comprehensive data integrity check.
 * Reports all issues found.
 */
export declare function runDataIntegrityCheck(cwd?: string): Promise<{
    passed: boolean;
    issues: string[];
    repairs: string[];
}>;
//# sourceMappingURL=data-safety.d.ts.map