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

import type { DataAccessor } from './data-accessor.js';
import type { TaskFile } from '../types/task.js';
import type { SessionsFile } from '../types/session.js';
import type { ArchiveFile } from './data-accessor.js';
import { gitCheckpoint } from './git-checkpoint.js';
import {
  checkSequence,
  repairSequence,
} from '../core/sequence/index.js';

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
    console.warn(`[SAFETY] Sequence behind: counter=${check.counter}, maxId=T${check.maxIdInData}. Repairing...`);
    const repair = await repairSequence(cwd);
    
    if (!repair.repaired && options.strict) {
      throw new DataSafetyError(
        `Sequence repair failed: ${repair.message}`,
        'SEQUENCE_INVALID',
        { check, repair },
      );
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
    console.warn(`[SAFETY] Checkpoint failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Verify TaskFile was written correctly.
 * Reads back and validates basic structure.
 */
async function verifyTaskFile(data: TaskFile, accessor: DataAccessor, options?: SafetyOptions): Promise<void> {
  if (!options?.verify) return;

  stats.verifications++;
  
  const readBack = await accessor.loadTaskFile();
  
  // Basic structural validation
  if (!readBack.tasks) {
    throw new DataSafetyError(
      'TaskFile verification failed: tasks array missing after write',
      'VERIFICATION_FAILED',
      { expected: data.tasks?.length, actual: readBack.tasks },
    );
  }

  // Task count validation
  if (readBack.tasks.length !== data.tasks?.length) {
    throw new DataSafetyError(
      `TaskFile verification failed: task count mismatch. Expected ${data.tasks?.length}, got ${readBack.tasks.length}`,
      'VERIFICATION_FAILED',
      { expected: data.tasks?.length, actual: readBack.tasks.length },
    );
  }

  // Verify specific tasks if we know what we wrote
  if (data.tasks && data.tasks.length > 0) {
    const lastTask = data.tasks[data.tasks.length - 1];
    const found = readBack.tasks.find(t => t.id === lastTask!.id);
    if (!found && options.strict) {
      throw new DataSafetyError(
        `TaskFile verification failed: last written task ${lastTask!.id} not found`,
        'VERIFICATION_FAILED',
        { taskId: lastTask!.id },
      );
    }
  }
}



/**
 * Verify SessionsFile was written correctly.
 */
async function verifySessionsFile(data: SessionsFile, accessor: DataAccessor, options?: SafetyOptions): Promise<void> {
  if (!options?.verify) return;

  stats.verifications++;
  
  const readBack = await accessor.loadSessions();
  
  if (readBack.sessions.length !== data.sessions.length) {
    throw new DataSafetyError(
      `SessionsFile verification failed: count mismatch. Expected ${data.sessions.length}, got ${readBack.sessions.length}`,
      'VERIFICATION_FAILED',
      { expected: data.sessions.length, actual: readBack.sessions.length },
    );
  }
}

/**
 * Verify ArchiveFile was written correctly.
 */
async function verifyArchiveFile(data: ArchiveFile, accessor: DataAccessor, options?: SafetyOptions): Promise<void> {
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
 * Safe wrapper for DataAccessor.saveTaskFile()
 * 
 * Performs:
 * 1. Sequence validation
 * 2. Write operation
 * 3. Verification (read back and validate)
 * 4. Git checkpoint
 */
export async function safeSaveTaskFile(
  accessor: DataAccessor,
  data: TaskFile,
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options };
  
  // 1. Validate sequence
  await ensureSequenceValid(cwd, opts);
  
  // 2. Perform write
  await accessor.saveTaskFile(data);
  stats.writes++;
  
  // 3. Verify write
  await verifyTaskFile(data, accessor, opts);
  
  // 4. Checkpoint
  const taskCount = data.tasks?.length ?? 0;
  await checkpoint(`saved TaskFile (${taskCount} tasks)`, cwd, opts);
}

/** @deprecated Use safeSaveTaskFile instead. */
export const safeSaveTodoFile = safeSaveTaskFile;

/**
 * Safe wrapper for DataAccessor.saveSessions()
 */
export async function safeSaveSessions(
  accessor: DataAccessor,
  data: SessionsFile,
  cwd?: string,
  options?: Partial<SafetyOptions>,
): Promise<void> {
  const opts = { ...DEFAULT_SAFETY, ...options };
  
  await accessor.saveSessions(data);
  stats.writes++;
  
  await verifySessionsFile(data, accessor, opts);
  await checkpoint(`saved Sessions (${data.sessions.length} sessions)`, cwd, opts);
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

  // 2. Verify data files can be loaded
  try {
    const tasks = await accessor.loadTaskFile();
    if (!tasks.tasks) {
      errors.push('TaskFile missing tasks array');
    }
  } catch (err) {
    errors.push(`TaskFile load failed: ${String(err)}`);
  }

  try {
    const sessions = await accessor.loadSessions();
    if (!sessions.sessions) {
      errors.push('SessionsFile missing sessions array');
    }
  } catch (err) {
    errors.push(`SessionsFile load failed: ${String(err)}`);
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
export async function forceSafetyCheckpoint(
  context: string,
  cwd?: string,
): Promise<void> {
  console.log(`[SAFETY] Forcing checkpoint: ${context}`);
  await gitCheckpoint('manual', context, cwd);
}

/**
 * Disable all safety for current process.
 * DANGEROUS - only use for recovery operations.
 */
export function disableSafety(): void {
  console.warn('[SAFETY] ⚠️  ALL SAFETY CHECKS DISABLED ⚠️');
  console.warn('[SAFETY] This should only be used for emergency recovery!');
  
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
  console.log('[SAFETY] Safety checks re-enabled');
  
  Object.assign(DEFAULT_SAFETY, {
    verify: true,
    checkpoint: true,
    validateSequence: true,
    strict: true,
  });
}
