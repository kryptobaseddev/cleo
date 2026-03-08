/**
 * Audit log pruning with optional archive-before-delete.
 *
 * Prunes audit_log rows older than a configurable retention period.
 * When archiveBeforePrune is enabled, exports prunable rows to
 * a gzip-compressed JSONL file before deletion.
 *
 * Never throws — logs warnings on failure. Safe for fire-and-forget
 * startup wiring.
 *
 * @task T5339
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { LoggingConfig } from '../types/config.js';
import { getLogger } from './logger.js';

const log = getLogger('prune');

export interface PruneResult {
  rowsArchived: number;
  rowsDeleted: number;
  archivePath?: string;
}

/**
 * Prune old audit_log rows from tasks.db.
 *
 * 1. If auditRetentionDays is 0 or undefined, skip age-based pruning.
 * 2. Compute cutoff timestamp from auditRetentionDays.
 * 3. If archiveBeforePrune, select rows older than cutoff and write to
 *    .cleo/backups/logs/audit-YYYY-MM-DD.jsonl.gz.
 * 4. Delete rows older than cutoff from audit_log.
 *
 * Idempotent — safe to call multiple times.
 * Never throws — returns zero counts on any error.
 *
 * @param cleoDir  - Absolute path to .cleo directory
 * @param config   - LoggingConfig with auditRetentionDays and archiveBeforePrune
 */
export async function pruneAuditLog(cleoDir: string, config: LoggingConfig): Promise<PruneResult> {
  try {
    if (!config.auditRetentionDays || config.auditRetentionDays <= 0) {
      log.debug('auditRetentionDays is 0 or unset; skipping audit prune');
      return { rowsArchived: 0, rowsDeleted: 0 };
    }

    const cutoff = new Date(Date.now() - config.auditRetentionDays * 86_400_000).toISOString();

    // Derive projectRoot from cleoDir (cleoDir = /path/to/project/.cleo)
    const projectRoot = join(cleoDir, '..');

    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const { lt } = await import('drizzle-orm');

    const db = await getDb(projectRoot);

    // Select rows to prune
    const oldRows = await db.select().from(auditLog).where(lt(auditLog.timestamp, cutoff));

    if (oldRows.length === 0) {
      log.debug('No audit_log rows older than cutoff; nothing to prune');
      return { rowsArchived: 0, rowsDeleted: 0 };
    }

    let archivePath: string | undefined;
    let rowsArchived = 0;

    // Archive before pruning (if enabled)
    if (config.archiveBeforePrune) {
      try {
        const archiveDir = join(cleoDir, 'backups', 'logs');
        mkdirSync(archiveDir, { recursive: true });

        const dateStamp = new Date().toISOString().slice(0, 10);
        archivePath = join(archiveDir, `audit-${dateStamp}.jsonl.gz`);

        // Build JSONL content: one JSON object per line
        const lines = oldRows.map((row) => JSON.stringify(row));
        const jsonlContent = lines.join('\n') + '\n';

        // Gzip compress and write via streaming pipeline
        const gzip = createGzip();
        const outStream = createWriteStream(archivePath);
        const inStream = Readable.from([jsonlContent]);

        await pipeline(inStream, gzip, outStream);

        rowsArchived = oldRows.length;
        log.info(
          { archivePath, rowsArchived },
          `Archived ${rowsArchived} audit rows to ${archivePath}`,
        );
      } catch (archiveErr) {
        // Archive failure must NOT prevent pruning — log and continue
        log.warn({ err: archiveErr }, 'Failed to archive audit rows; continuing with deletion');
        archivePath = undefined;
      }
    }

    // Delete prunable rows
    await db.delete(auditLog).where(lt(auditLog.timestamp, cutoff)).run();

    log.info(
      { rowsDeleted: oldRows.length, cutoff },
      `Pruned ${oldRows.length} audit_log rows older than ${cutoff}`,
    );

    return {
      rowsArchived,
      rowsDeleted: oldRows.length,
      archivePath,
    };
  } catch (err) {
    log.warn({ err }, 'audit log pruning failed');
    return { rowsArchived: 0, rowsDeleted: 0 };
  }
}
