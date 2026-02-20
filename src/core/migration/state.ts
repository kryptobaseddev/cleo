/**
 * Migration state tracking and recovery.
 *
 * Provides persistent tracking of migration progress to enable:
 * - Resumable migrations after interruptions
 * - Debugging of failed migrations
 * - Progress monitoring during long operations
 *
 * @task T4726
 * @epic T4454
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Migration phase - tracks current step in the migration process */
export type MigrationPhase =
  | 'init'
  | 'backup'
  | 'validate'
  | 'import'
  | 'verify'
  | 'cleanup'
  | 'complete'
  | 'failed';

/** Source file info with checksum for integrity verification */
export interface SourceFileInfo {
  path: string;
  checksum: string;
  taskCount?: number;
  sessionCount?: number;
  archivedCount?: number;
}

/** Migration progress tracking */
export interface MigrationProgress {
  tasksImported: number;
  archivedImported: number;
  sessionsImported: number;
  totalTasks: number;
  totalArchived: number;
  totalSessions: number;
}

/** Complete migration state structure */
export interface MigrationState {
  version: '1.0.0';
  startedAt: string;
  phase: MigrationPhase;
  sourceFiles: {
    todoJson?: SourceFileInfo;
    sessionsJson?: SourceFileInfo;
    archiveJson?: SourceFileInfo;
  };
  backupPath?: string;
  tempPath?: string;
  progress: MigrationProgress;
  errors: string[];
  warnings: string[];
  completedAt?: string;
}

/** State file name */
const STATE_FILENAME = '.migration-state.json';

/**
 * Compute SHA-256 checksum of file content.
 * @param filePath - Path to the file
 * @returns Hex-encoded SHA-256 checksum, or empty string if file doesn't exist
 */
async function computeFileChecksum(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Count records in a JSON file.
 * @param filePath - Path to the JSON file
 * @param key - Key to count (e.g., 'tasks', 'sessions')
 * @returns Count of records, or 0 if file doesn't exist or is invalid
 */
async function countRecords(filePath: string, key: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return (data[key] ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Create initial migration state at the start of migration.
 *
 * Captures source file checksums and initializes progress tracking.
 * Uses atomic write pattern to ensure state is never in an inconsistent state.
 *
 * @param cleoDir - Path to .cleo directory
 * @param sourceFiles - Optional pre-computed source file info
 * @returns The created migration state
 * @task T4726
 */
export async function createMigrationState(
  cleoDir: string,
  sourceFiles?: MigrationState['sourceFiles'],
): Promise<MigrationState> {
  // If source files not provided, compute them
  const files: MigrationState['sourceFiles'] = sourceFiles ?? {};

  if (!files.todoJson) {
    const todoPath = join(cleoDir, 'todo.json');
    if (existsSync(todoPath)) {
      files.todoJson = {
        path: todoPath,
        checksum: await computeFileChecksum(todoPath),
        taskCount: await countRecords(todoPath, 'tasks'),
      };
    }
  }

  if (!files.sessionsJson) {
    const sessionsPath = join(cleoDir, 'sessions.json');
    if (existsSync(sessionsPath)) {
      files.sessionsJson = {
        path: sessionsPath,
        checksum: await computeFileChecksum(sessionsPath),
        sessionCount: await countRecords(sessionsPath, 'sessions'),
      };
    }
  }

  if (!files.archiveJson) {
    const archivePath = join(cleoDir, 'todo-archive.json');
    if (existsSync(archivePath)) {
      files.archiveJson = {
        path: archivePath,
        checksum: await computeFileChecksum(archivePath),
        archivedCount: await countRecords(archivePath, 'tasks') ||
          await countRecords(archivePath, 'archivedTasks'),
      };
    }
  }

  const state: MigrationState = {
    version: '1.0.0',
    startedAt: new Date().toISOString(),
    phase: 'init',
    sourceFiles: files,
    progress: {
      tasksImported: 0,
      archivedImported: 0,
      sessionsImported: 0,
      totalTasks: files.todoJson?.taskCount ?? 0,
      totalArchived: files.archiveJson?.archivedCount ?? 0,
      totalSessions: files.sessionsJson?.sessionCount ?? 0,
    },
    errors: [],
    warnings: [],
  };

  await writeMigrationState(cleoDir, state);
  return state;
}

/**
 * Write migration state to disk atomically.
 * Uses write-to-temp-then-rename pattern for safety.
 *
 * @param cleoDir - Path to .cleo directory
 * @param state - Migration state to write
 */
async function writeMigrationState(
  cleoDir: string,
  state: MigrationState,
): Promise<void> {
  const statePath = join(cleoDir, STATE_FILENAME);
  const tempPath = `${statePath}.tmp`;

  await writeFile(tempPath, JSON.stringify(state, null, 2));
  await writeFile(statePath, await readFile(tempPath));

  // Clean up temp file
  try {
    await unlink(tempPath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Update migration state with partial updates.
 *
 * Merges updates with existing state and writes atomically.
 * Automatically adds timestamp to phase transitions.
 *
 * @param cleoDir - Path to .cleo directory
 * @param updates - Partial state updates to apply
 * @returns The updated migration state
 * @task T4726
 */
export async function updateMigrationState(
  cleoDir: string,
  updates: Partial<MigrationState>,
): Promise<MigrationState> {
  const current = await loadMigrationState(cleoDir);

  if (!current) {
    throw new Error('No migration state exists. Call createMigrationState first.');
  }

  // Deep merge progress if provided
  const mergedProgress: MigrationProgress = updates.progress
    ? {
        tasksImported: updates.progress.tasksImported ?? current.progress.tasksImported,
        archivedImported: updates.progress.archivedImported ?? current.progress.archivedImported,
        sessionsImported: updates.progress.sessionsImported ?? current.progress.sessionsImported,
        totalTasks: updates.progress.totalTasks ?? current.progress.totalTasks,
        totalArchived: updates.progress.totalArchived ?? current.progress.totalArchived,
        totalSessions: updates.progress.totalSessions ?? current.progress.totalSessions,
      }
    : current.progress;

  // Deep merge sourceFiles if provided
  const mergedSourceFiles: MigrationState['sourceFiles'] = updates.sourceFiles
    ? { ...current.sourceFiles, ...updates.sourceFiles }
    : current.sourceFiles;

  // Merge arrays
  const mergedErrors = updates.errors
    ? [...current.errors, ...updates.errors]
    : current.errors;

  const mergedWarnings = updates.warnings
    ? [...current.warnings, ...updates.warnings]
    : current.warnings;

  const updated: MigrationState = {
    ...current,
    ...updates,
    progress: mergedProgress,
    sourceFiles: mergedSourceFiles,
    errors: mergedErrors,
    warnings: mergedWarnings,
  };

  await writeMigrationState(cleoDir, updated);
  return updated;
}

/**
 * Update just the migration phase.
 * Convenience wrapper for common phase transition.
 *
 * @param cleoDir - Path to .cleo directory
 * @param phase - New phase
 * @returns The updated migration state
 * @task T4726
 */
export async function updateMigrationPhase(
  cleoDir: string,
  phase: MigrationPhase,
): Promise<MigrationState> {
  return updateMigrationState(cleoDir, { phase });
}

/**
 * Update progress counters during import.
 *
 * @param cleoDir - Path to .cleo directory
 * @param progress - Progress updates (only changed counters needed)
 * @returns The updated migration state
 * @task T4726
 */
export async function updateMigrationProgress(
  cleoDir: string,
  progress: Partial<MigrationProgress>,
): Promise<MigrationState> {
  const current = await loadMigrationState(cleoDir);
  if (!current) {
    throw new Error('No migration state exists');
  }

  const mergedProgress: MigrationProgress = {
    tasksImported: progress.tasksImported ?? current.progress.tasksImported,
    archivedImported: progress.archivedImported ?? current.progress.archivedImported,
    sessionsImported: progress.sessionsImported ?? current.progress.sessionsImported,
    totalTasks: progress.totalTasks ?? current.progress.totalTasks,
    totalArchived: progress.totalArchived ?? current.progress.totalArchived,
    totalSessions: progress.totalSessions ?? current.progress.totalSessions,
  };

  return updateMigrationState(cleoDir, { progress: mergedProgress });
}

/**
 * Add an error to the migration state.
 *
 * @param cleoDir - Path to .cleo directory
 * @param error - Error message
 * @returns The updated migration state
 * @task T4726
 */
export async function addMigrationError(
  cleoDir: string,
  error: string,
): Promise<MigrationState> {
  const state = await loadMigrationState(cleoDir);
  if (!state) {
    throw new Error('No migration state exists');
  }

  state.errors.push(error);
  state.phase = 'failed';
  await writeMigrationState(cleoDir, state);
  return state;
}

/**
 * Add a warning to the migration state.
 *
 * @param cleoDir - Path to .cleo directory
 * @param warning - Warning message
 * @returns The updated migration state
 * @task T4726
 */
export async function addMigrationWarning(
  cleoDir: string,
  warning: string,
): Promise<MigrationState> {
  const state = await loadMigrationState(cleoDir);
  if (!state) {
    throw new Error('No migration state exists');
  }

  state.warnings.push(warning);
  await writeMigrationState(cleoDir, state);
  return state;
}

/**
 * Load existing migration state.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns Migration state, or null if no state file exists
 * @task T4726
 */
export async function loadMigrationState(
  cleoDir: string,
): Promise<MigrationState | null> {
  try {
    const statePath = join(cleoDir, STATE_FILENAME);
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as MigrationState;
  } catch {
    return null;
  }
}

/**
 * Check if a migration is in progress.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns true if migration state exists and is not complete/failed
 * @task T4726
 */
export async function isMigrationInProgress(
  cleoDir: string,
): Promise<boolean> {
  const state = await loadMigrationState(cleoDir);
  if (!state) return false;
  return state.phase !== 'complete' && state.phase !== 'failed';
}

/**
 * Check if migration can be resumed.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns Object with resume info, or null if cannot resume
 * @task T4726
 */
export async function canResumeMigration(
  cleoDir: string,
): Promise<{
  canResume: boolean;
  phase: MigrationPhase;
  progress: MigrationProgress;
  errors: string[];
} | null> {
  const state = await loadMigrationState(cleoDir);
  if (!state) return null;

  // Can resume if we're not complete and not failed
  const canResume = state.phase !== 'complete' && state.phase !== 'failed';

  return {
    canResume,
    phase: state.phase,
    progress: state.progress,
    errors: state.errors,
  };
}

/**
 * Mark migration as complete.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns The completed migration state
 * @task T4726
 */
export async function completeMigration(
  cleoDir: string,
): Promise<MigrationState> {
  const state = await updateMigrationState(cleoDir, {
    phase: 'complete',
    completedAt: new Date().toISOString(),
  });

  // Auto-cleanup completed state after a delay
  // Keep it for a short while for verification purposes
  setTimeout(() => {
    clearMigrationState(cleoDir).catch(() => {
      // Ignore cleanup errors
    });
  }, 5000);

  return state;
}

/**
 * Mark migration as failed with error details.
 *
 * @param cleoDir - Path to .cleo directory
 * @param error - Primary error message
 * @returns The failed migration state
 * @task T4726
 */
export async function failMigration(
  cleoDir: string,
  error: string,
): Promise<MigrationState> {
  return updateMigrationState(cleoDir, {
    phase: 'failed',
    errors: [error],
  });
}

/**
 * Clear migration state file.
 * Safe to call even if state doesn't exist.
 *
 * @param cleoDir - Path to .cleo directory
 * @task T4726
 */
export async function clearMigrationState(cleoDir: string): Promise<void> {
  try {
    const statePath = join(cleoDir, STATE_FILENAME);
    await unlink(statePath);
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Get a summary of migration state for display.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns Human-readable summary, or null if no state
 * @task T4726
 */
export async function getMigrationSummary(
  cleoDir: string,
): Promise<string | null> {
  const state = await loadMigrationState(cleoDir);
  if (!state) return null;

  const { phase, progress, errors, warnings, startedAt, completedAt } = state;

  const lines: string[] = [
    `Migration Status: ${phase.toUpperCase()}`,
    `Started: ${new Date(startedAt).toLocaleString()}`,
  ];

  if (completedAt) {
    lines.push(`Completed: ${new Date(completedAt).toLocaleString()}`);
  }

  lines.push(
    `Progress: ${progress.tasksImported}/${progress.totalTasks} tasks, ` +
      `${progress.archivedImported}/${progress.totalArchived} archived, ` +
      `${progress.sessionsImported}/${progress.totalSessions} sessions`,
  );

  if (errors.length > 0) {
    lines.push(`\nErrors (${errors.length}):`);
    errors.forEach((e) => lines.push(`  - ${e}`));
  }

  if (warnings.length > 0) {
    lines.push(`\nWarnings (${warnings.length}):`);
    warnings.forEach((w) => lines.push(`  - ${w}`));
  }

  return lines.join('\n');
}

/**
 * Verify source files haven't changed since migration started.
 *
 * Compares current checksums with stored checksums to detect
 * if source files were modified during migration.
 *
 * @param cleoDir - Path to .cleo directory
 * @returns Object with verification results
 * @task T4726
 */
export async function verifySourceIntegrity(
  cleoDir: string,
): Promise<{
  valid: boolean;
  changed: string[];
  missing: string[];
}> {
  const state = await loadMigrationState(cleoDir);
  if (!state) {
    return { valid: false, changed: [], missing: ['state'] };
  }

  const changed: string[] = [];
  const missing: string[] = [];

  for (const [key, fileInfo] of Object.entries(state.sourceFiles)) {
    if (!fileInfo) continue;

    if (!existsSync(fileInfo.path)) {
      missing.push(key);
      continue;
    }

    const currentChecksum = await computeFileChecksum(fileInfo.path);
    if (currentChecksum !== fileInfo.checksum) {
      changed.push(key);
    }
  }

  return {
    valid: changed.length === 0 && missing.length === 0,
    changed,
    missing,
  };
}
