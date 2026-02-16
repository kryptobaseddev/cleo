/**
 * Audit Trail for MCP Server Mutations
 *
 * Logs all write operations to .cleo/audit-log.json for compliance
 * and debugging purposes.
 *
 * @task T2920
 * @task T2929
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';

/**
 * Audit entry interface
 */
export interface AuditEntry {
  timestamp: string;          // ISO-8601
  sessionId: string | null;   // Current session
  domain: string;             // Domain name
  operation: string;          // Operation name
  params: Record<string, unknown>; // Operation parameters
  result: {
    success: boolean;
    exitCode: number;
    duration: number;         // Milliseconds
  };
  metadata: {
    taskId?: string;          // Affected task
    userId?: string;          // User identifier
    source: "mcp";            // Always "mcp" for MCP server
    gateway?: 'cleo_mutate' | 'cleo_query';
  };
  error?: string;             // Error message if failed
}

/**
 * Maximum audit log size in bytes before rotation (default: 10MB)
 */
const MAX_AUDIT_LOG_SIZE = 10 * 1024 * 1024;

/**
 * Get audit log file path
 */
function getAuditLogPath(): string {
  // Default to .cleo/audit-log.json in project root
  return join(process.cwd(), '.cleo', 'audit-log.json');
}

/**
 * Get current session ID from environment or config
 */
function getCurrentSessionId(): string | null {
  // TODO: Integrate with session system when available
  return process.env.CLEO_SESSION_ID || null;
}

/**
 * Ensure .cleo directory exists
 */
async function ensureCleoDir(): Promise<void> {
  const cleoDir = join(process.cwd(), '.cleo');
  try {
    await fs.mkdir(cleoDir, { recursive: true });
  } catch (error) {
    // Ignore if already exists
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Log mutation to audit trail
 *
 * Appends a single-line JSON entry to .cleo/audit-log.json
 * Non-blocking - errors are logged but not thrown
 * Automatically rotates log if size exceeds limit
 *
 * @param entry Audit entry to log
 */
export async function logMutation(entry: AuditEntry): Promise<void> {
  try {
    // Check if audit logging is enabled
    const config = getConfig();
    if (!config.auditLog) {
      return; // Audit logging disabled
    }

    // Ensure .cleo directory exists
    await ensureCleoDir();

    // Get audit log path
    const logPath = getAuditLogPath();

    // Check if rotation is needed
    await checkAndRotateLog(logPath);

    // Serialize entry as single-line JSON
    const line = JSON.stringify(entry) + '\n';

    // Append to log file
    await fs.appendFile(logPath, line, 'utf8');
  } catch (error) {
    // Log error but don't throw - audit logging should not block operations
    console.error('Failed to write audit log entry:', error);
  }
}

/**
 * Log error to audit trail
 *
 * Convenience function for logging errors with full context
 *
 * @param domain Domain where error occurred
 * @param operation Operation that failed
 * @param error Error object or message
 * @param params Operation parameters
 * @param exitCode Exit code (default: 1)
 */
export async function logError(
  domain: string,
  operation: string,
  error: Error | string,
  params: Record<string, unknown> = {},
  exitCode: number = 1
): Promise<void> {
  // Check if audit logging is enabled
  const config = getConfig();
  if (!config.auditLog) {
    return; // Audit logging disabled
  }

  const errorMessage = error instanceof Error ? error.message : error;
  const taskId = typeof params.taskId === 'string' ? params.taskId : undefined;

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    sessionId: getCurrentSessionId(),
    domain,
    operation,
    params,
    result: {
      success: false,
      exitCode,
      duration: 0,
    },
    metadata: {
      taskId,
      source: 'mcp',
    },
    error: errorMessage,
  };

  await logMutation(entry);
}

/**
 * Read audit log entries
 *
 * @param options Filter options
 * @returns Array of audit entries
 */
export async function readAuditLog(options?: {
  since?: string;
  domain?: string;
  operation?: string;
  success?: boolean;
  limit?: number;
}): Promise<AuditEntry[]> {
  try {
    const logPath = getAuditLogPath();

    // Read log file
    const content = await fs.readFile(logPath, 'utf8');

    // Parse JSONL
    const entries = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AuditEntry);

    // Apply filters
    let filtered = entries;

    if (options?.since) {
      filtered = filtered.filter((e) => e.timestamp >= options.since!);
    }

    if (options?.domain) {
      filtered = filtered.filter((e) => e.domain === options.domain);
    }

    if (options?.operation) {
      filtered = filtered.filter((e) => e.operation === options.operation);
    }

    if (options?.success !== undefined) {
      filtered = filtered.filter((e) => e.result.success === options.success);
    }

    // Apply limit
    if (options?.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  } catch (error) {
    // If file doesn't exist, return empty array
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Get audit statistics
 *
 * @returns Audit statistics
 */
export async function getAuditStats(): Promise<{
  totalEntries: number;
  successCount: number;
  failureCount: number;
  byDomain: Record<string, number>;
  byOperation: Record<string, number>;
  avgDuration: number;
}> {
  const entries = await readAuditLog();

  const stats = {
    totalEntries: entries.length,
    successCount: entries.filter((e) => e.result.success).length,
    failureCount: entries.filter((e) => !e.result.success).length,
    byDomain: {} as Record<string, number>,
    byOperation: {} as Record<string, number>,
    avgDuration: 0,
  };

  // Count by domain
  for (const entry of entries) {
    stats.byDomain[entry.domain] = (stats.byDomain[entry.domain] || 0) + 1;
    const opKey = `${entry.domain}.${entry.operation}`;
    stats.byOperation[opKey] = (stats.byOperation[opKey] || 0) + 1;
  }

  // Calculate average duration
  const durations = entries.filter((e) => e.result.duration).map((e) => e.result.duration);
  if (durations.length > 0) {
    stats.avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  return stats;
}

/**
 * Clear audit log (use with caution)
 *
 * @returns Number of entries cleared
 */
export async function clearAuditLog(): Promise<number> {
  try {
    const entries = await readAuditLog();
    const count = entries.length;

    const logPath = getAuditLogPath();
    await fs.unlink(logPath);

    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

/**
 * Check and rotate audit log if size exceeds limit
 *
 * Rotates log to timestamped archive file when size exceeds MAX_AUDIT_LOG_SIZE
 *
 * @param logPath Path to audit log file
 */
async function checkAndRotateLog(logPath: string): Promise<void> {
  try {
    const stats = await fs.stat(logPath);

    if (stats.size >= MAX_AUDIT_LOG_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = join(
        process.cwd(),
        '.cleo',
        `audit-log-${timestamp}.json`
      );

      // Move current log to archive
      await fs.rename(logPath, archivePath);

      console.log(`Rotated audit log: ${archivePath} (${stats.size} bytes)`);
    }
  } catch (error) {
    // If file doesn't exist, no rotation needed
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to check/rotate audit log:', error);
    }
  }
}

/**
 * Manually rotate audit log
 *
 * Forces rotation regardless of size
 *
 * @returns Path to rotated log file
 */
export async function rotateLog(): Promise<string | null> {
  try {
    const logPath = getAuditLogPath();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = join(
      process.cwd(),
      '.cleo',
      `audit-log-${timestamp}.json`
    );

    // Check if log exists
    try {
      await fs.access(logPath);
    } catch {
      return null; // No log to rotate
    }

    // Move current log to archive
    await fs.rename(logPath, archivePath);

    return archivePath;
  } catch (error) {
    console.error('Failed to rotate audit log:', error);
    return null;
  }
}

/**
 * Archive old audit entries
 *
 * Moves entries older than specified date to archive file
 *
 * @param beforeDate ISO date string
 * @returns Number of entries archived
 */
export async function archiveAuditLog(beforeDate: string): Promise<number> {
  try {
    const entries = await readAuditLog();

    const toArchive = entries.filter((e) => e.timestamp < beforeDate);
    const toKeep = entries.filter((e) => e.timestamp >= beforeDate);

    if (toArchive.length === 0) {
      return 0;
    }

    // Write archive file
    const archivePath = join(
      process.cwd(),
      '.cleo',
      `audit-log-archive-${beforeDate}.json`
    );
    const archiveContent = toArchive.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(archivePath, archiveContent, 'utf8');

    // Write remaining entries back to log
    const logPath = getAuditLogPath();
    const logContent = toKeep.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(logPath, logContent, 'utf8');

    return toArchive.length;
  } catch (error) {
    console.error('Failed to archive audit log:', error);
    return 0;
  }
}

/**
 * Query audit log entries with filters
 *
 * @param options Query options
 * @returns Filtered audit entries
 */
export async function queryAudit(options?: {
  since?: string;
  domain?: string;
  operation?: string;
  success?: boolean;
  taskId?: string;
  sessionId?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const entries = await readAuditLog(options);

  // Additional filters for new fields
  let filtered = entries;

  if (options?.taskId) {
    filtered = filtered.filter((e) => e.metadata?.taskId === options.taskId);
  }

  if (options?.sessionId) {
    filtered = filtered.filter((e) => e.sessionId === options.sessionId);
  }

  return filtered;
}
