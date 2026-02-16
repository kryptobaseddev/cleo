/**
 * Import-specific logging functions for CLEO system.
 * Ported from lib/data/import-logging.sh
 *
 * Provides structured audit logging for import operations including
 * start, success, error, and conflict events.
 *
 * @task T4552
 * @epic T4545
 */

import { readJson, appendJsonl } from './json.js';
import { getLogPath } from '../core/paths.js';

/** Import package metadata extracted from the export file. */
export interface ImportPackageMeta {
  sourceFile: string;
  sourceProject: string;
  exportedAt: string;
  packageChecksum: string;
  taskCount: number;
}

/** Import conflict types. */
export type ImportConflictType =
  | 'duplicate_title'
  | 'missing_dependency'
  | 'missing_parent'
  | 'depth_exceeded'
  | 'phase_mismatch';

/** Import conflict resolution strategies. */
export type ImportConflictResolution =
  | 'skip'
  | 'rename'
  | 'force'
  | 'strip'
  | 'create_placeholder'
  | 'fail';

/** Import options for logging context. */
export interface ImportOptions {
  parent?: string;
  phase?: string;
  resetStatus?: boolean;
  [key: string]: unknown;
}

/** Import log entry base. */
interface ImportLogEntry {
  id: string;
  timestamp: string;
  action: string;
  taskId: string | null;
  actor: string;
  details: Record<string, unknown>;
  sessionId: string | null;
}

/**
 * Generate a log entry ID.
 * @task T4552
 */
function generateLogId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `log-${epoch}-${rand}`;
}

/**
 * Extract package metadata from an export file.
 * @task T4552
 */
export async function extractPackageMeta(
  sourceFilePath: string,
): Promise<ImportPackageMeta> {
  const data = await readJson<Record<string, unknown>>(sourceFilePath);
  const meta = (data as Record<string, Record<string, unknown>> | null)?._meta;

  return {
    sourceFile: sourceFilePath.split('/').pop() ?? sourceFilePath,
    sourceProject: (meta?.source as Record<string, string>)?.project ?? 'unknown',
    exportedAt: (meta?.exportedAt as string) ?? 'unknown',
    packageChecksum: (meta?.checksum as string) ?? 'unknown',
    taskCount: typeof meta?.taskCount === 'number' ? meta.taskCount : 0,
  };
}

/**
 * Write a log entry to the log file.
 * @task T4552
 */
async function writeLogEntry(
  action: string,
  taskId: string | null,
  details: Record<string, unknown>,
  sessionId?: string | null,
  cwd?: string,
): Promise<void> {
  const logPath = getLogPath(cwd);
  const entry: ImportLogEntry = {
    id: generateLogId(),
    timestamp: new Date().toISOString(),
    action,
    taskId,
    actor: 'system',
    details,
    sessionId: sessionId ?? null,
  };

  try {
    await appendJsonl(logPath, entry);
  } catch {
    // Log failure is non-fatal
  }
}

/**
 * Log import operation start with package metadata.
 * @task T4552
 */
export async function logImportStart(
  sourceFilePath: string,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  let meta: ImportPackageMeta;
  try {
    meta = await extractPackageMeta(sourceFilePath);
  } catch {
    meta = {
      sourceFile: sourceFilePath.split('/').pop() ?? sourceFilePath,
      sourceProject: 'unknown',
      exportedAt: 'unknown',
      packageChecksum: 'unknown',
      taskCount: 0,
    };
  }

  await writeLogEntry(
    'import',
    null,
    {
      ...meta,
      stage: 'start',
    },
    sessionId,
    cwd,
  );
}

/**
 * Log import operation completion with full metadata.
 * @task T4552
 */
export async function logImportSuccess(
  sourceFilePath: string,
  tasksImported: string[],
  idRemap: Record<string, string>,
  conflicts?: Array<{ type: string; resolution: string }>,
  options?: ImportOptions,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  let meta: ImportPackageMeta;
  try {
    meta = await extractPackageMeta(sourceFilePath);
  } catch {
    meta = {
      sourceFile: sourceFilePath.split('/').pop() ?? sourceFilePath,
      sourceProject: 'unknown',
      exportedAt: 'unknown',
      packageChecksum: 'unknown',
      taskCount: 0,
    };
  }

  await writeLogEntry(
    'import',
    null,
    {
      sourceFile: meta.sourceFile,
      sourceProject: meta.sourceProject,
      exportedAt: meta.exportedAt,
      packageChecksum: meta.packageChecksum,
      importedAt: new Date().toISOString(),
      tasksImported,
      idRemap,
      conflicts: conflicts ?? [],
      options: options ?? {},
      stage: 'success',
    },
    sessionId,
    cwd,
  );
}

/**
 * Log import operation error with diagnostic details.
 * @task T4552
 */
export async function logImportError(
  sourceFilePath: string,
  errorMessage: string,
  errorCode: string | number,
  stage: 'validation' | 'parsing' | 'remapping' | 'writing' | 'unknown' = 'unknown',
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  await writeLogEntry(
    'error_occurred',
    null,
    {
      sourceFile: sourceFilePath.split('/').pop() ?? sourceFilePath,
      stage,
      error: {
        message: errorMessage,
        code: String(errorCode),
        timestamp: new Date().toISOString(),
      },
    },
    sessionId,
    cwd,
  );
}

/**
 * Log import conflict detection and resolution.
 * @task T4552
 */
export async function logImportConflict(
  conflictType: ImportConflictType,
  taskId: string,
  conflictDetails: Record<string, unknown>,
  resolution: ImportConflictResolution,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  await writeLogEntry(
    'task_updated',
    taskId,
    {
      conflictType,
      resolution,
      details: conflictDetails,
    },
    sessionId,
    cwd,
  );
}
