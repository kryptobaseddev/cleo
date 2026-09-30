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
import type { LoggingConfig } from '@cleocode/contracts';
import { and, lt, notInArray, type SQL } from 'drizzle-orm';
import { getLogger } from './logger.js';
import { AC_BINDINGS_PRUNED_ACTION } from './store/ac-binding-prune.js';
import type { auditLog } from './store/schema/audit.js';
import type { tasksAuditLog } from './store/schema/cleo-project/audit.js';

const log = getLogger('prune');

export interface PruneResult {
  rowsArchived: number;
  rowsDeleted: number;
  archivePath?: string;
}

/**
 * Audit actions that age-based pruning never deletes, whatever their age.
 *
 * `ac.bindings.pruned` rows are the only surviving record of an evidence
 * binding whose acceptance criterion was removed. Alias-drift detection
 * (`E_AC_ALIAS_DRIFTED`, ADR-079-r2 §3) reads them to know what `AC<n>` used
 * to mean; pruning them would silently turn a drifted alias into a rebind.
 *
 * @task T12790
 */
export const AUDIT_PRUNE_EXEMPT_ACTIONS: readonly string[] = [AC_BINDINGS_PRUNED_ACTION];

/** An audit table age-based pruning may target: legacy `audit_log` or `tasks_audit_log`. */
export type PrunableAuditTable = typeof auditLog | typeof tasksAuditLog;

/**
 * The row predicate for age-based pruning of `table`: older than `cutoff` and
 * not an {@link AUDIT_PRUNE_EXEMPT_ACTIONS} action.
 *
 * Every prune — of either audit table — selects and deletes through this one
 * predicate, so retargeting the prune cannot drop the exemption.
 *
 * @param table  - The audit table being pruned
 * @param cutoff - ISO-8601 instant; rows strictly older are prunable
 * @returns The drizzle `WHERE` condition
 * @task T12790
 */
export function auditPruneCondition(table: PrunableAuditTable, cutoff: string): SQL {
  const condition = and(
    lt(table.timestamp, cutoff),
    notInArray(table.action, [...AUDIT_PRUNE_EXEMPT_ACTIONS]),
  );
  // `and()` of two defined conditions is always defined.
  if (!condition) throw new Error('auditPruneCondition: empty predicate');
  return condition;
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
 * Rows whose action is in {@link AUDIT_PRUNE_EXEMPT_ACTIONS} are never
 * selected, archived or deleted (T12790).
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

    const { getDb } = await import('./store/sqlite.js');
    const { auditLog } = await import('./store/tasks-schema.js');

    const db = await getDb(projectRoot);

    // Select rows to prune
    const oldRows = await db.select().from(auditLog).where(auditPruneCondition(auditLog, cutoff));

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
    await db.delete(auditLog).where(auditPruneCondition(auditLog, cutoff)).run();

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
