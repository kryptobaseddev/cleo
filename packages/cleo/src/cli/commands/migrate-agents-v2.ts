/**
 * CLI command: cleo migrate agents-v2
 *
 * One-time idempotent migration utility for existing CLEO installations.
 * Scans `.cleo/cant/agents/` and `.cleo/agents/` for `.cant` files that were
 * never registered in `signaldock.db.agents` (Bug 3 historical fallout —
 * `cleo init --install-seed-agents` only copied files, never wrote DB rows).
 *
 * After T1934, fresh installs register agents automatically. This walker
 * handles the backcompat case: existing installs with orphaned files on disk.
 *
 * For each `.cant` file found:
 * - If the agent is not registered: registers it via `installAgentFromCant()`
 *   and logs INFO.
 * - If already registered with the SAME sha256: skips (idempotent), logs INFO.
 * - If already registered with DIFFERENT sha256 (content drift / user
 *   customisation): logs a WARN entry to `.cleo/audit/migration-agents-v2.jsonl`
 *   and does NOT overwrite — lets the owner resolve via `cleo doctor`.
 *
 * Exit code 0 in all cases except filesystem read failure or parse error.
 *
 * @task T1938
 * @epic T1929
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureGlobalSignaldockDb,
  getGlobalSignaldockDbPath,
  getProjectRoot,
  installAgentFromCant,
} from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { cliError, cliOutput, humanInfo, humanLine, humanWarn } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome classification for a single .cant file processed by the walker. */
export type MigrationOutcome = 'registered' | 'skipped' | 'conflict';

/** A single entry in the migration audit log (.cleo/audit/migration-agents-v2.jsonl). */
export interface MigrationAuditEntry {
  /** ISO 8601 timestamp when this entry was written. */
  timestamp: string;
  /** Outcome of processing this agent. */
  type: MigrationOutcome;
  /** Declared agent name extracted from the .cant manifest. */
  agentName: string;
  /** Project-relative file path of the scanned .cant file. */
  filePath: string;
  /** SHA-256 hex digest of the EXISTING registry row (only present for 'conflict'). */
  existingSha256?: string;
  /** SHA-256 hex digest of the file on disk (only present for 'conflict'). */
  newSha256?: string;
  /** Human-readable action taken. */
  action: string;
  /**
   * Stable diagnostic ID consumed by `cleo doctor` to surface unresolved
   * conflicts.
   */
  doctor_diagnostic_id?: string;
}

/** Summary counters returned by the walker. */
export interface MigrationSummary {
  /** Agents newly registered in signaldock.db. */
  registered: number;
  /** Agents already registered with matching sha256 (skipped). */
  skipped: number;
  /** Agents with conflicting content between disk and DB (not overwritten). */
  conflicts: number;
  /** Agents that failed to parse or caused a filesystem error. */
  errors: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable audit log path (relative to project root). */
const AUDIT_LOG_RELATIVE = '.cleo/audit/migration-agents-v2.jsonl';

/** Diagnostic ID used in the audit log and surfaced by cleo doctor. */
const MIGRATE_CONFLICT_DIAGNOSTIC_ID = 'MIGRATE-AGENTS-V2-CONFLICT';

// ---------------------------------------------------------------------------
// Core walker logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute the hex-encoded SHA-256 checksum of the supplied bytes.
 *
 * @param bytes - Raw buffer whose digest to compute.
 * @returns 64-character lowercase hex string.
 * @task T1938
 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Extract the agent name from a `.cant` source without depending on the full
 * `@cleocode/cant` parser (which would create a circular dependency). The
 * minimal extractor mirrors what `agent-install.ts` does internally.
 *
 * @param source - Raw `.cant` file contents as a string.
 * @returns The declared agent name, or `null` if no recognisable header found.
 * @task T1938
 */
export function extractAgentName(source: string): string | null {
  let body = source;
  // Strip frontmatter if present.
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) {
      const afterFence = body.indexOf('\n', end + 4);
      body = afterFence >= 0 ? body.slice(afterFence + 1) : '';
    }
  }
  const headerMatch = body.match(/^\s*agent\s+([a-zA-Z][\w-]*)\s*:\s*$/m);
  if (!headerMatch) return null;
  return headerMatch[1] ?? null;
}

/**
 * Append a single JSON line to the migration audit log. Creates the directory
 * and file if they do not exist.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param entry - Audit entry to append.
 * @task T1938
 */
function appendAuditLog(projectRoot: string, entry: MigrationAuditEntry): void {
  const auditPath = join(projectRoot, AUDIT_LOG_RELATIVE);
  const auditDir = join(auditPath, '..');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }
  appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * Walk a single `.cant` agents directory and process each file.
 *
 * For each `.cant` file found:
 * 1. Parse the declared agent name.
 * 2. Check if the agent already has a row in signaldock.db.
 * 3a. Not registered → call `installAgentFromCant()` with project tier.
 * 3b. Registered, same sha256 → skip (idempotent).
 * 3c. Registered, different sha256 → log conflict, do not overwrite.
 *
 * @param db           - Open handle to global signaldock.db.
 * @param scanDir      - Absolute path to the agents directory to scan.
 * @param projectRoot  - Absolute path to the project root.
 * @param summary      - Mutable counters updated in-place.
 * @param verbose      - When true, log INFO lines to stdout.
 * @task T1938
 */
export function walkAgentsDir(
  db: DatabaseSync,
  scanDir: string,
  projectRoot: string,
  summary: MigrationSummary,
  verbose: boolean,
): void {
  if (!existsSync(scanDir)) return;

  let files: string[];
  try {
    files = readdirSync(scanDir).filter((f) => f.endsWith('.cant'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    humanWarn(`Error: failed to enumerate ${scanDir}: ${msg}`);
    summary.errors++;
    return;
  }

  for (const filename of files) {
    const cantPath = join(scanDir, filename);
    const relPath = cantPath.replace(`${projectRoot}/`, '');

    // Read the file and compute sha256.
    let sourceBytes: Buffer;
    let sourceText: string;
    try {
      sourceBytes = readFileSync(cantPath);
      sourceText = sourceBytes.toString('utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      humanWarn(`Error: failed to read ${cantPath}: ${msg}`);
      summary.errors++;
      appendAuditLog(projectRoot, {
        timestamp: new Date().toISOString(),
        type: 'conflict',
        agentName: filename.replace(/\.cant$/, ''),
        filePath: relPath,
        action: `read-error: ${msg}`,
      });
      continue;
    }

    const newSha256 = sha256Hex(sourceBytes);

    // Extract the declared agent name.
    const agentName = extractAgentName(sourceText);
    if (!agentName) {
      humanWarn(`Warning: no agent declaration found in ${cantPath} — skipping.`);
      summary.errors++;
      continue;
    }

    // Check existing row in signaldock.db.
    const existingRow = db
      .prepare('SELECT cant_sha256 FROM agents WHERE agent_id = ?')
      .get(agentName) as { cant_sha256: string | null } | undefined;

    if (existingRow) {
      const existingSha256 = existingRow.cant_sha256 ?? '';

      if (existingSha256 === newSha256) {
        // Already registered with identical content — safe to skip.
        if (verbose) {
          humanLine(`  skipped (already registered): ${agentName}`);
        }
        appendAuditLog(projectRoot, {
          timestamp: new Date().toISOString(),
          type: 'skipped',
          agentName,
          filePath: relPath,
          action: 'already-registered-same-content',
        });
        summary.skipped++;
      } else {
        // Content differs — conflict. Log and surface via cleo doctor.
        humanWarn(
          `  WARN: conflict for ${agentName}: disk sha256=${newSha256.slice(0, 12)}... ` +
            `db sha256=${existingSha256.slice(0, 12)}... — NOT overwriting`,
        );
        appendAuditLog(projectRoot, {
          timestamp: new Date().toISOString(),
          type: 'conflict',
          agentName,
          filePath: relPath,
          existingSha256,
          newSha256,
          action: 'skipped-conflict-do-not-overwrite',
          doctor_diagnostic_id: MIGRATE_CONFLICT_DIAGNOSTIC_ID,
        });
        summary.conflicts++;
      }
    } else {
      // Not registered — install via the canonical pipeline.
      try {
        installAgentFromCant(db, {
          cantSource: cantPath,
          targetTier: 'project',
          installedFrom: 'manual',
          projectRoot,
        });
        if (verbose) {
          humanLine(`  registered: ${agentName} from ${relPath}`);
        }
        appendAuditLog(projectRoot, {
          timestamp: new Date().toISOString(),
          type: 'registered',
          agentName,
          filePath: relPath,
          action: 'registered-via-installAgentFromCant',
        });
        summary.registered++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        humanWarn(`  ERROR: failed to register ${agentName}: ${msg}`);
        summary.errors++;
        appendAuditLog(projectRoot, {
          timestamp: new Date().toISOString(),
          type: 'conflict',
          agentName,
          filePath: relPath,
          action: `install-error: ${msg}`,
        });
      }
    }
  }
}

/**
 * Execute the full migration walker for a given project root.
 *
 * Scans both `.cleo/cant/agents/` and `.cleo/agents/` and processes each
 * `.cant` file via {@link walkAgentsDir}.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param verbose     - When true, log INFO lines per agent to stdout.
 * @returns Final {@link MigrationSummary} counters.
 * @task T1938
 */
export async function runMigrateAgentsV2(
  projectRoot: string,
  verbose = true,
): Promise<MigrationSummary> {
  const summary: MigrationSummary = { registered: 0, skipped: 0, conflicts: 0, errors: 0 };

  // Bootstrap the global signaldock.db if it doesn't already exist.
  await ensureGlobalSignaldockDb();
  const db = new DatabaseSync(getGlobalSignaldockDbPath());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');

  try {
    // Scan canonical project-tier directory (post-T889).
    const canonicalDir = join(projectRoot, '.cleo', 'cant', 'agents');
    walkAgentsDir(db, canonicalDir, projectRoot, summary, verbose);

    // Scan legacy directory (pre-T889 installations).
    const legacyDir = join(projectRoot, '.cleo', 'agents');
    walkAgentsDir(db, legacyDir, projectRoot, summary, verbose);
  } finally {
    db.close();
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Doctor diagnostic reader
// ---------------------------------------------------------------------------

/**
 * Read the migration audit log and return all unresolved conflict entries.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Array of conflict entries from the audit log.
 * @task T1938
 */
export function readMigrationConflicts(projectRoot: string): MigrationAuditEntry[] {
  const auditPath = join(projectRoot, AUDIT_LOG_RELATIVE);
  if (!existsSync(auditPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(auditPath, 'utf8');
  } catch {
    return [];
  }

  const conflicts: MigrationAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as MigrationAuditEntry;
      if (
        entry.type === 'conflict' &&
        entry.doctor_diagnostic_id === MIGRATE_CONFLICT_DIAGNOSTIC_ID
      ) {
        conflicts.push(entry);
      }
    } catch {
      // Malformed line — skip.
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// CLI command definition
// ---------------------------------------------------------------------------

/**
 * `cleo migrate agents-v2` — idempotent migration walker for existing agent
 * installations.
 *
 * Walks `.cleo/cant/agents/` and `.cleo/agents/` in the current project and
 * registers any unregistered `.cant` files via `installAgentFromCant()`.
 * Conflicts (same agent name, different content) are logged to
 * `.cleo/audit/migration-agents-v2.jsonl` and surfaced by `cleo doctor`.
 *
 * @task T1938
 * @epic T1929
 */
export const migrateAgentsV2Command = defineCommand({
  meta: {
    name: 'agents-v2',
    description:
      'Register existing .cant agent files into signaldock.db (idempotent, conflict-safe)',
  },
  args: {
    quiet: {
      type: 'boolean',
      description: 'Suppress per-agent INFO lines; only print the summary',
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const verbose = args.quiet !== true;

    if (verbose) {
      humanInfo('Scanning .cleo/cant/agents/ and .cleo/agents/ for unregistered agents...');
    }

    try {
      const summary = await runMigrateAgentsV2(projectRoot, verbose);
      const summaryLine =
        `Migration complete: ${summary.registered} registered, ` +
        `${summary.skipped} skipped, ${summary.conflicts} conflicts.`;

      humanLine(summaryLine);

      if (summary.conflicts > 0) {
        humanLine(`  Conflicts logged to ${AUDIT_LOG_RELATIVE}. Run 'cleo doctor' for details.`);
      }

      cliOutput(
        {
          registered: summary.registered,
          skipped: summary.skipped,
          conflicts: summary.conflicts,
          errors: summary.errors,
          auditLog: summary.conflicts > 0 || summary.errors > 0 ? AUDIT_LOG_RELATIVE : null,
        },
        { command: 'migrate agents-v2', operation: 'migrate.agents-v2' },
      );

      if (summary.errors > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 'E_MIGRATION_FAILED', undefined, {
        operation: 'migrate.agents-v2',
      });
      process.exitCode = 1;
    }
  },
});
