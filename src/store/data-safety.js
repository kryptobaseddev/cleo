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
import { eq } from 'drizzle-orm';
import { getLogger } from '../core/logger.js';
import { checkSequence, repairSequence } from '../core/sequence/index.js';
import { gitCheckpoint } from './git-checkpoint.js';
import { getDb } from './sqlite.js';
import { vacuumIntoBackup } from './sqlite-backup.js';
import * as schema from './tasks-schema.js';
const log = getLogger('data-safety');
const DEFAULT_CONFIG = {
    verifyWrites: true,
    detectCollisions: true,
    validateSequence: true,
    autoCheckpoint: true,
    strictMode: true,
};
/** Safety violation error. */
export class SafetyError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'SafetyError';
    }
}
/**
 * Check if a task ID already exists (collision detection).
 * @throws SafetyError if task exists and strict mode is enabled
 */
export async function checkTaskExists(taskId, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.detectCollisions)
        return false;
    const db = await getDb(cwd);
    const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
    const exists = existing.length > 0;
    if (exists && cfg.strictMode) {
        throw new SafetyError(`Task ID collision detected: ${taskId} already exists`, 'COLLISION_DETECTED', { taskId, existingTask: existing[0] });
    }
    return exists;
}
/**
 * Verify a task was actually written to the database.
 * @throws SafetyError if verification fails
 */
export async function verifyTaskWrite(taskId, expectedData, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.verifyWrites)
        return true;
    const db = await getDb(cwd);
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
    if (rows.length === 0) {
        if (cfg.strictMode) {
            throw new SafetyError(`Write verification failed: Task ${taskId} not found after write`, 'WRITE_VERIFICATION_FAILED', { taskId });
        }
        return false;
    }
    // Verify expected data if provided
    if (expectedData) {
        const row = rows[0];
        for (const [key, value] of Object.entries(expectedData)) {
            if (value !== undefined && row[key] !== value) {
                if (cfg.strictMode) {
                    throw new SafetyError(`Write verification failed: Task ${taskId} field ${key} mismatch`, 'WRITE_VERIFICATION_MISMATCH', { taskId, field: key, expected: value, actual: row[key] });
                }
                return false;
            }
        }
    }
    return true;
}
/**
 * Validate and repair sequence if necessary.
 * @returns true if sequence was valid or successfully repaired
 */
export async function validateAndRepairSequence(cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.validateSequence)
        return { valid: true, repaired: false };
    try {
        const check = await checkSequence(cwd);
        if (check.valid) {
            return { valid: true, repaired: false };
        }
        // Sequence is behind, repair it
        const repair = await repairSequence(cwd);
        if (repair.repaired) {
            log.warn({ oldCounter: repair.oldCounter, newCounter: repair.newCounter }, 'Sequence repaired');
            return {
                valid: true,
                repaired: true,
                oldCounter: repair.oldCounter,
                newCounter: repair.newCounter,
            };
        }
        // repairSequence returning repaired:false means "already valid, nothing to do"
        return { valid: true, repaired: false };
    }
    catch (err) {
        if (cfg.strictMode) {
            throw new SafetyError(`Sequence validation failed: ${String(err)}`, 'SEQUENCE_VALIDATION_FAILED', { error: String(err) });
        }
        return { valid: false, repaired: false };
    }
}
/**
 * Trigger auto-checkpoint after successful write.
 */
export async function triggerCheckpoint(context, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.autoCheckpoint)
        return;
    try {
        await gitCheckpoint('auto', context, cwd);
    }
    catch (err) {
        // Checkpoint failures are non-fatal but should be logged
        log.warn({ err }, 'Checkpoint failed (non-fatal)');
    }
    vacuumIntoBackup({ cwd }).catch(() => { }); // non-fatal SQLite snapshot
}
/**
 * Safely create a task with all safety mechanisms.
 * Wraps the actual createTask operation.
 */
export async function safeCreateTask(createFn, task, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // 1. Validate sequence before creation
    if (cfg.validateSequence) {
        await validateAndRepairSequence(cwd, config);
    }
    // 2. Check for collisions
    if (cfg.detectCollisions) {
        await checkTaskExists(task.id, cwd, config);
    }
    // 3. Perform the actual creation
    const result = await createFn();
    // 4. Verify the write
    if (cfg.verifyWrites) {
        await verifyTaskWrite(task.id, { title: task.title }, cwd, config);
    }
    // 5. Trigger checkpoint
    if (cfg.autoCheckpoint) {
        await triggerCheckpoint(`created ${task.id}`, cwd, config);
    }
    return result;
}
/**
 * Safely update a task with all safety mechanisms.
 */
export async function safeUpdateTask(updateFn, taskId, updates, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // 1. Perform the actual update
    const result = await updateFn();
    if (!result)
        return null;
    // 2. Verify the write
    if (cfg.verifyWrites) {
        await verifyTaskWrite(taskId, updates, cwd, config);
    }
    // 3. Trigger checkpoint
    if (cfg.autoCheckpoint) {
        await triggerCheckpoint(`updated ${taskId}`, cwd, config);
    }
    return result;
}
/**
 * Safely delete a task with all safety mechanisms.
 */
export async function safeDeleteTask(deleteFn, taskId, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // 1. Perform the actual deletion
    const result = await deleteFn();
    if (!result)
        return false;
    // 2. Verify the deletion (task should NOT exist)
    if (cfg.verifyWrites) {
        const db = await getDb(cwd);
        const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();
        if (rows.length > 0) {
            if (cfg.strictMode) {
                throw new SafetyError(`Delete verification failed: Task ${taskId} still exists after delete`, 'DELETE_VERIFICATION_FAILED', { taskId });
            }
        }
    }
    // 3. Trigger checkpoint
    if (cfg.autoCheckpoint) {
        await triggerCheckpoint(`deleted ${taskId}`, cwd, config);
    }
    return result;
}
/**
 * Verify session write.
 */
export async function verifySessionWrite(sessionId, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.verifyWrites)
        return true;
    const db = await getDb(cwd);
    const rows = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .all();
    if (rows.length === 0) {
        if (cfg.strictMode) {
            throw new SafetyError(`Write verification failed: Session ${sessionId} not found after write`, 'SESSION_WRITE_VERIFICATION_FAILED', { sessionId });
        }
        return false;
    }
    return true;
}
/**
 * Safely create a session with all safety mechanisms.
 */
export async function safeCreateSession(createFn, session, cwd, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    // 1. Perform the actual creation
    const result = await createFn();
    // 2. Verify the write
    if (cfg.verifyWrites) {
        await verifySessionWrite(session.id, cwd, config);
    }
    // 3. Trigger checkpoint
    if (cfg.autoCheckpoint) {
        await triggerCheckpoint(`session ${session.id} started`, cwd, config);
    }
    return result;
}
/**
 * Force a checkpoint before destructive operations.
 * Use this before migrations, bulk updates, etc.
 */
export async function forceCheckpointBeforeOperation(operation, cwd) {
    log.info({ operation }, 'Forcing checkpoint before operation');
    try {
        await gitCheckpoint('manual', `pre-${operation}`, cwd);
    }
    catch (err) {
        log.error({ err }, 'Failed to create pre-operation checkpoint');
        // Don't throw - checkpoint failures shouldn't block operations
    }
    vacuumIntoBackup({ cwd, force: true }).catch(() => { }); // non-fatal SQLite snapshot
}
/**
 * Run comprehensive data integrity check.
 * Reports all issues found.
 */
export async function runDataIntegrityCheck(cwd) {
    const issues = [];
    const repairs = [];
    // 1. Check sequence
    try {
        const seqCheck = await checkSequence(cwd);
        if (!seqCheck.valid) {
            issues.push(`Sequence invalid: counter ${seqCheck.counter} < max ID T${seqCheck.maxIdInData}`);
            // Auto-repair
            const repair = await repairSequence(cwd);
            if (repair.repaired) {
                repairs.push(`Sequence repaired: ${repair.oldCounter} -> ${repair.newCounter}`);
            }
            else {
                issues.push('Sequence repair failed');
            }
        }
    }
    catch (err) {
        issues.push(`Sequence check failed: ${String(err)}`);
    }
    // 2. Check for ghost entries (would need to compare structured audit log with database)
    // This is a complex check that would require loading the entire log
    // For now, we skip this but document it as needed
    return {
        passed: issues.length === repairs.length,
        issues,
        repairs,
    };
}
//# sourceMappingURL=data-safety.js.map