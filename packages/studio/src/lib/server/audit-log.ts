/**
 * Append-only audit log for Studio admin actions.
 *
 * Writes newline-delimited JSON entries to
 * `<projectPath>/.cleo/audit/studio-actions.jsonl`. Every admin mutation
 * (scan, clean, delete, reindex, backup, doctor, gc, migrate) SHOULD
 * call {@link recordAudit} both pre- and post-action so a trail of
 * intent + outcome exists even when the underlying CLI fails.
 *
 * Reads are capped to the trailing N entries so the log can grow
 * indefinitely without blowing the Studio process.
 *
 * @task T990
 * @wave 1E
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Single line in `studio-actions.jsonl`.
 */
export interface AuditEntry {
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Short identifier of who triggered the action. */
  actor: string;
  /** Canonical action name — e.g. `project.scan`, `project.delete`. */
  action: string;
  /** Target the action affected (project id, path, etc). */
  target: string | null;
  /** Outcome category. */
  result: 'success' | 'failure' | 'dry-run' | 'initiated';
  /** Optional free-form detail string (error message, summary, …). */
  detail?: string | null;
  /** Optional structured metadata. */
  meta?: Record<string, unknown>;
}

/**
 * Resolve the audit log file path for the given project root.
 *
 * Defaults to `<projectPath>/.cleo/audit/studio-actions.jsonl`.
 */
export function resolveAuditLogPath(projectPath: string): string {
  return join(projectPath, '.cleo', 'audit', 'studio-actions.jsonl');
}

/**
 * Append a new audit entry. Never throws — logging failures must not
 * break an admin action. Swallows errors silently (they surface via
 * the action's own error envelope).
 */
export function recordAudit(projectPath: string, entry: Omit<AuditEntry, 'timestamp'>): void {
  try {
    const path = resolveAuditLogPath(projectPath);
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(path, `${JSON.stringify(full)}\n`, { encoding: 'utf8' });
  } catch {
    // intentional — logging is best-effort
  }
}

/**
 * Read the last `limit` audit entries (newest first).
 *
 * Returns `[]` when the file does not exist. Malformed lines are
 * skipped silently.
 */
export function readAuditLog(projectPath: string, limit = 50): AuditEntry[] {
  try {
    const path = resolveAuditLogPath(projectPath);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const entries: AuditEntry[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        const parsed = JSON.parse(line) as Partial<AuditEntry>;
        if (
          typeof parsed.timestamp === 'string' &&
          typeof parsed.actor === 'string' &&
          typeof parsed.action === 'string' &&
          (parsed.result === 'success' ||
            parsed.result === 'failure' ||
            parsed.result === 'dry-run' ||
            parsed.result === 'initiated')
        ) {
          entries.push({
            timestamp: parsed.timestamp,
            actor: parsed.actor,
            action: parsed.action,
            target: parsed.target ?? null,
            result: parsed.result,
            detail: parsed.detail ?? null,
            meta: parsed.meta,
          });
        }
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}
