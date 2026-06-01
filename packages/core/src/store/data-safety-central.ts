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

import type { Session, Task } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import { checkSequence, repairSequence } from '../sequence/index.js';
import type { ArchiveFile, DataAccessor } from './data-accessor.js';
import { gitCheckpoint } from './git-checkpoint.js';
import { getDb } from './sqlite.js';
import { vacuumIntoBackup } from './sqlite-backup.js';
import * as schema from './tasks-schema.js';

const log = getLogger('data-safety');

/** Safety violation error */
export class DataSafetyError extends Error {
  constructor(
    message: string,
    public code: 'COLLISION' | 'WRITE_FAILED' | 'VERIFICATION_FAILED' | 'SEQUENCE_INVALID',
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DataSafetyError';
  }
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

const DEFAULT_SAFETY: SafetyOptions = {
  verify: true,
  checkpoint: true,
  validateSequence: true,
  strict: true,
};

/** Statistics for monitoring */
interface SafetyStats {
  writes: number;
  verifications: number;
  checkpoints: number;
  errors: number;
  lastCheckpoint: Date | null;
}

const stats: SafetyStats = {
  writes: 0,
  verifications: 0,
  checkpoints: 0,
  errors: 0,
  lastCheckpoint: null,
};

/** Get current safety statistics */
export function getSafetyStats(): SafetyStats {
  return { ...stats };
}

/** Reset safety statistics (for testing) */
export function resetSafetyStats(): void {
  stats.writes = 0;
  stats.verifications = 0;
  stats.checkpoints = 0;
  stats.errors = 0;
  stats.lastCheckpoint = null;
}

/**
 * Verify sequence integrity before write.
 * Auto-repairs if sequence is behind database.
 */
async function ensureSequenceValid(cwd?: string, options?: SafetyOptions): Promise<void> {
  if (!options?.validateSequence) return;

  const check = await checkSequence(cwd);

  if (!check.valid) {
    log.warn({ counter: check.counter, maxId: check.maxIdInData }, 'Sequence behind, repairing');
    const repair = await repairSequence(cwd);

    if (!repair.repaired && options.strict) {
      throw new DataSafetyError(`Sequence repair failed: ${repair.message}`, 'SEQUENCE_INVALID', {
        check,
        repair,
      });
    }
  }
}

/**
 * Create a checkpoint after successful write.
 * Non-blocking - failures are logged but don't fail the operation.
 */
async function checkpoint(context: string, cwd?: string, options?: SafetyOptions): Promise<void> {
  if (!options?.checkpoint) return;

  try {
    await gitCheckpoint('auto', context, cwd);
    stats.checkpoints++;
    stats.lastCheckpoint = new Date();
  } catch (err) {
    // Checkpoint failures are non-fatal but logged
    log.warn({ err }, 'Checkpoint failed (non-fatal)');
  }

  vacuumIntoBackup({ cwd }).catch(() => {}); // non-fatal SQLite snapshot
}

/**
 * Verify sessions were written correctly.
 */
async function verifySessions(
  data: Session[],
  accessor: DataAccessor,
  options?: SafetyOptions,
): Promise<void> {
  if (!options?.verify) return;

  stats.verifications++;

  const readBack = await accessor.loadSessions();

  if (readBack.length !== data.length) {
    throw new DataSafetyError(
      `Sessions verification failed: count mismatch. Expected ${data.length}, got ${readBack.length}`,
      'VERIFICATION_FAILED',
      { expected: data.length, actual: readBack.length },
    );
  }
}

/**
 * Verify ArchiveFile was written correctly.
 */
async function verifyArchiveFile(
  data: ArchiveFile,
  accessor: DataAccessor,
  options?: SafetyOptions,
): Promise<void> {
  if (!options?.verify) return;

  stats.verifications++;

  const readBack = await accessor.loadArchive();

  if (!readBack) {
    throw new DataSafetyError(
      'ArchiveFile verification failed: file not found after write',
      'VERIFICATION_FAILED',
    );
  }

  if (readBack.archivedTasks.length !== data.archivedTasks.length) {
    throw new DataSafetyError(
      `ArchiveFile verification failed: count mismatch. Expected ${data.archivedTasks.length}, got ${readBack.archivedTasks.length}`,
      'VERIFICATION_FAILED',
      { expected: data.archivedTasks.length, actual: readBack.archivedTasks.length },
    );
  }
}

/**
 * Safe wrapper for DataAccessor.saveSessions()
 */
export async function safeSaveSessions(
  accessor: DataAccessor,
  data: Session[],
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options };

  await accessor.saveSessions(data);
  stats.writes++;

  await verifySessions(data, accessor, opts);
  await checkpoint(`saved Sessions (${data.length} sessions)`, cwd, opts);
}

/**
 * Safe wrapper for DataAccessor.saveArchive()
 */
export async function safeSaveArchive(
  accessor: DataAccessor,
  data: ArchiveFile,
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options };

  await accessor.saveArchive(data);
  stats.writes++;

  await verifyArchiveFile(data, accessor, opts);
  await checkpoint(`saved Archive (${data.archivedTasks.length} tasks)`, cwd, opts);
}

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
export async function safeSingleTaskWrite(
  _accessor: DataAccessor,
  taskId: string,
  writeFn: () => Promise<void>,
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options };

  // 1. Validate sequence
  await ensureSequenceValid(cwd, opts);

  // 2. Perform targeted write
  await writeFn();
  stats.writes++;

  // 3. Checkpoint (lightweight — no full-file verify)
  await checkpoint(`single-task ${taskId}`, cwd, opts);
}

/**
 * Safe wrapper for DataAccessor.appendLog()
 *
 * Note: Log appends are fire-and-forget (no verification)
 * but we still checkpoint to ensure data is committed.
 */
export async function safeAppendLog(
  accessor: DataAccessor,
  entry: Record<string, unknown>,
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options, verify: false }; // Logs don't need verification

  await accessor.appendLog(entry);
  stats.writes++;

  await checkpoint('log entry', cwd, opts);
}

/**
 * Run comprehensive data integrity check.
 * Validates all data files and sequence consistency.
 */
export async function runDataIntegrityCheck(
  accessor: DataAccessor,
  cwd?: string,
): Promise<{
  passed: boolean;
  errors: string[];
  warnings: string[];
  stats: SafetyStats;
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check sequence
  try {
    const seqCheck = await checkSequence(cwd);
    if (!seqCheck.valid) {
      errors.push(`Sequence invalid: counter=${seqCheck.counter}, maxId=T${seqCheck.maxIdInData}`);

      // Try to repair
      const repair = await repairSequence(cwd);
      if (repair.repaired) {
        warnings.push(`Auto-repaired sequence: ${repair.oldCounter} -> ${repair.newCounter}`);
      } else {
        errors.push('Sequence auto-repair failed');
      }
    }
  } catch (err) {
    errors.push(`Sequence check failed: ${String(err)}`);
  }

  // 2. Verify task data can be queried
  try {
    const count = await accessor.countTasks();
    if (count < 0) {
      errors.push('Task count returned negative value');
    }
  } catch (err) {
    errors.push(`Task data query failed: ${String(err)}`);
  }

  try {
    const sessions = await accessor.loadSessions();
    if (!Array.isArray(sessions)) {
      errors.push('Sessions data is not an array');
    }
  } catch (err) {
    errors.push(`Sessions load failed: ${String(err)}`);
  }

  // 3. Check for checkpoint recency
  if (stats.lastCheckpoint) {
    const minutesSinceCheckpoint = (Date.now() - stats.lastCheckpoint.getTime()) / 60000;
    if (minutesSinceCheckpoint > 60) {
      warnings.push(`Last checkpoint was ${Math.round(minutesSinceCheckpoint)} minutes ago`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    stats: getSafetyStats(),
  };
}

/**
 * Force immediate checkpoint.
 * Use before destructive operations.
 */
export async function forceSafetyCheckpoint(context: string, cwd?: string): Promise<void> {
  log.info({ context }, 'Forcing checkpoint');
  await gitCheckpoint('manual', context, cwd);
  vacuumIntoBackup({ cwd, force: true }).catch(() => {}); // non-fatal SQLite snapshot
}

/**
 * Disable all safety for current process.
 * DANGEROUS - only use for recovery operations.
 */
export function disableSafety(): void {
  log.warn('All safety checks disabled - emergency recovery mode');

  // Set all safety options to false
  Object.assign(DEFAULT_SAFETY, {
    verify: false,
    checkpoint: false,
    validateSequence: false,
    strict: false,
  });
}

/**
 * Re-enable safety after being disabled.
 */
export function enableSafety(): void {
  log.info('Safety checks re-enabled');

  Object.assign(DEFAULT_SAFETY, {
    verify: true,
    checkpoint: true,
    validateSequence: true,
    strict: true,
  });
}

// ===========================================================================
// Task-level safety wrappers (merged from the former `data-safety.ts`, T11527)
//
// These operate directly on the SQLite tasks table via `getDb()` and back the
// safe CRUD path in `tasks-sqlite.ts` (collision detection, write verification,
// sequence validation, auto-checkpoint). They predate the accessor-based
// `safe*` wrappers above and remain the entry point for `createTask`/
// `updateTaskSafe`/`deleteTaskSafe`.
// ===========================================================================

/** Per-operation safety configuration for the task-level wrappers. */
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

const DEFAULT_CONFIG: SafetyConfig = {
  verifyWrites: true,
  detectCollisions: true,
  validateSequence: true,
  autoCheckpoint: true,
  strictMode: true,
};

/** Safety violation error raised by the task-level wrappers. */
export class SafetyError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SafetyError';
  }
}

/**
 * Check if a task ID already exists (collision detection).
 * @throws SafetyError if task exists and strict mode is enabled
 */
export async function checkTaskExists(
  taskId: string,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.detectCollisions) return false;

  const db = await getDb(cwd);
  const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();

  const exists = existing.length > 0;

  if (exists && cfg.strictMode) {
    throw new SafetyError(
      `Task ID collision detected: ${taskId} already exists`,
      'COLLISION_DETECTED',
      { taskId, existingTask: existing[0] },
    );
  }

  return exists;
}

/**
 * Verify a task was actually written to the database.
 * @throws SafetyError if verification fails
 */
export async function verifyTaskWrite(
  taskId: string,
  expectedData?: Partial<Task>,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.verifyWrites) return true;

  const db = await getDb(cwd);
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).all();

  if (rows.length === 0) {
    if (cfg.strictMode) {
      throw new SafetyError(
        `Write verification failed: Task ${taskId} not found after write`,
        'WRITE_VERIFICATION_FAILED',
        { taskId },
      );
    }
    return false;
  }

  // Verify expected data if provided
  if (expectedData) {
    const row = rows[0]!;
    for (const [key, value] of Object.entries(expectedData)) {
      if (value !== undefined && row[key as keyof typeof row] !== value) {
        if (cfg.strictMode) {
          throw new SafetyError(
            `Write verification failed: Task ${taskId} field ${key} mismatch`,
            'WRITE_VERIFICATION_MISMATCH',
            { taskId, field: key, expected: value, actual: row[key as keyof typeof row] },
          );
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
export async function validateAndRepairSequence(
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<{ valid: boolean; repaired: boolean; oldCounter?: number; newCounter?: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.validateSequence) return { valid: true, repaired: false };

  try {
    const check = await checkSequence(cwd);

    if (check.valid) {
      return { valid: true, repaired: false };
    }

    // Sequence is behind, repair it
    const repair = await repairSequence(cwd);

    if (repair.repaired) {
      log.warn(
        { oldCounter: repair.oldCounter, newCounter: repair.newCounter },
        'Sequence repaired',
      );
      return {
        valid: true,
        repaired: true,
        oldCounter: repair.oldCounter,
        newCounter: repair.newCounter,
      };
    }

    // repairSequence returning repaired:false means "already valid, nothing to do"
    return { valid: true, repaired: false };
  } catch (err) {
    if (cfg.strictMode) {
      throw new SafetyError(
        `Sequence validation failed: ${String(err)}`,
        'SEQUENCE_VALIDATION_FAILED',
        { error: String(err) },
      );
    }
    return { valid: false, repaired: false };
  }
}

/**
 * Trigger auto-checkpoint after a successful task write.
 */
export async function triggerCheckpoint(
  context: string,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.autoCheckpoint) return;

  try {
    await gitCheckpoint('auto', context, cwd);
  } catch (err) {
    // Checkpoint failures are non-fatal but should be logged
    log.warn({ err }, 'Checkpoint failed (non-fatal)');
  }

  vacuumIntoBackup({ cwd }).catch(() => {}); // non-fatal SQLite snapshot
}

/**
 * Safely create a task with all safety mechanisms.
 * Wraps the actual createTask operation.
 */
export async function safeCreateTask(
  createFn: () => Promise<Task>,
  task: Task,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<Task> {
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

  // 4. Trigger checkpoint
  if (cfg.autoCheckpoint) {
    await triggerCheckpoint(`created ${task.id}`, cwd, config);
  }

  return result;
}

/**
 * Safely update a task with all safety mechanisms.
 */
export async function safeUpdateTask(
  updateFn: () => Promise<Task | null>,
  taskId: string,
  _updates: Partial<Task>,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<Task | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 1. Perform the actual update
  const result = await updateFn();

  if (!result) return null;

  // 2. Trigger checkpoint
  if (cfg.autoCheckpoint) {
    await triggerCheckpoint(`updated ${taskId}`, cwd, config);
  }

  return result;
}

/**
 * Safely delete a task with all safety mechanisms.
 */
export async function safeDeleteTask(
  deleteFn: () => Promise<boolean>,
  taskId: string,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 1. Perform the actual deletion
  const result = await deleteFn();

  if (!result) return false;

  // 2. Trigger checkpoint
  if (cfg.autoCheckpoint) {
    await triggerCheckpoint(`deleted ${taskId}`, cwd, config);
  }

  return result;
}

/**
 * Verify a session write landed in the database.
 * @throws SafetyError if verification fails in strict mode
 */
export async function verifySessionWrite(
  sessionId: string,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.verifyWrites) return true;

  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .all();

  if (rows.length === 0) {
    if (cfg.strictMode) {
      throw new SafetyError(
        `Write verification failed: Session ${sessionId} not found after write`,
        'SESSION_WRITE_VERIFICATION_FAILED',
        { sessionId },
      );
    }
    return false;
  }

  return true;
}

/**
 * Safely create a session with all safety mechanisms.
 */
export async function safeCreateSession(
  createFn: () => Promise<Session>,
  session: Session,
  cwd?: string,
  config: Partial<SafetyConfig> = {},
): Promise<Session> {
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
export async function forceCheckpointBeforeOperation(
  operation: string,
  cwd?: string,
): Promise<void> {
  log.info({ operation }, 'Forcing checkpoint before operation');

  try {
    await gitCheckpoint('manual', `pre-${operation}`, cwd);
  } catch (err) {
    log.error({ err }, 'Failed to create pre-operation checkpoint');
    // Don't throw - checkpoint failures shouldn't block operations
  }

  vacuumIntoBackup({ cwd, force: true }).catch(() => {}); // non-fatal SQLite snapshot
}

/**
 * Run a sequence-focused integrity check keyed only by working directory.
 *
 * Distinct from the accessor-based {@link runDataIntegrityCheck} above — this
 * variant needs no {@link DataAccessor} and reports sequence issues/repairs
 * only. Retained for the lightweight `cwd`-only integrity probe.
 */
export async function runSequenceIntegrityCheck(cwd?: string): Promise<{
  passed: boolean;
  issues: string[];
  repairs: string[];
}> {
  const issues: string[] = [];
  const repairs: string[] = [];

  // 1. Check sequence
  try {
    const seqCheck = await checkSequence(cwd);
    if (!seqCheck.valid) {
      issues.push(
        `Sequence invalid: counter ${seqCheck.counter} < max ID T${seqCheck.maxIdInData}`,
      );

      // Auto-repair
      const repair = await repairSequence(cwd);
      if (repair.repaired) {
        repairs.push(`Sequence repaired: ${repair.oldCounter} -> ${repair.newCounter}`);
      } else {
        issues.push('Sequence repair failed');
      }
    }
  } catch (err) {
    issues.push(`Sequence check failed: ${String(err)}`);
  }

  return {
    passed: issues.length === repairs.length,
    issues,
    repairs,
  };
}
