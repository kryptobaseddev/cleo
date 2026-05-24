/**
 * `cleo doctor db-substrate` — fleet/integrity/orphan walker.
 *
 * Walks every entry in `DB_INVENTORY` for the current project plus the
 * global tier, runs `PRAGMA integrity_check` on each existing DB, and
 * surfaces the result as a LAFS envelope. With `--fleet`, walks every
 * immediate-child `.cleo/`-bearing project under a fleet root
 * (`/mnt/projects/` by default; override via `--fleet-root`).
 *
 * Additionally detects two structural anomalies and surfaces them as
 * warnings:
 *
 *   - `orphan-project-root` — a `.cleo/` at a project-PARENT path
 *     (T9550 regression class).
 *   - `nested-nexus-duplicate` — `<cleoHome>/nexus/{nexus,signaldock}.db`
 *     duplicates of the flat-layout canonical files.
 *
 * T10312 hardens the integrity_check path: bounded wall-clock timeout
 * (`--integrity-timeout-ms`, default 60_000) and auto-quarantine of
 * corrupt DBs to `<projectRoot>/.cleo/quarantine/<role>-malformed-<iso>/`
 * (opt out with `--no-quarantine`).
 *
 * @task T10307
 * @task T10312 — bounded timeout + auto-quarantine
 * @epic T10282
 * @saga T10281
 * @see ADR-068 — CLEO Database Charter
 */

import type { DbSubstrateAuditResult, DbSubstrateSurveyOptions } from '@cleocode/contracts';
import { getProjectRoot, pushWarning } from '@cleocode/core';
import { surveyDbSubstrate, surveyFleetDbSubstrate } from '@cleocode/core/doctor/db-substrate.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Default fleet root scanned when `--fleet` is passed without
 * `--fleet-root`. Matches the convention documented in the saga audit:
 * `/mnt/projects/<project>/.cleo/`.
 */
const DEFAULT_FLEET_ROOT = '/mnt/projects';

/**
 * Emit `meta.warnings` entries for every structural anomaly detected
 * during the survey. Warnings are surfaced via `pushWarning` so they
 * land in the envelope's `meta.warnings` array (`@cleocode/lafs`
 * convention).
 *
 * @param result - The substrate audit result whose warnings should
 *   be pushed.
 */
function pushSubstrateWarnings(result: DbSubstrateAuditResult): void {
  for (const warning of result.warnings) {
    // Build a base context shared by every warning kind; orphan-project-root
    // warnings additionally carry `parentWorkspace` (T10308 attribution
    // for the offending sibling workspace).
    const context: Record<string, string | number | null> = {
      kind: warning.kind,
      path: warning.path,
      lastWriteMs: warning.lastWriteMs,
    };
    if (warning.kind === 'orphan-project-root') {
      context['parentWorkspace'] = warning.parentWorkspace ?? null;
    }
    pushWarning({
      code:
        warning.kind === 'orphan-project-root'
          ? 'W_DB_SUBSTRATE_ORPHAN_PROJECT_ROOT'
          : 'W_DB_SUBSTRATE_NESTED_NEXUS_DUPLICATE',
      message:
        warning.kind === 'orphan-project-root'
          ? `Orphan project-root .cleo/ at ${warning.path} (T9550 regression class — review then remove)` +
            (warning.parentWorkspace
              ? ` — attributed to workspace: ${warning.parentWorkspace}`
              : '')
          : `Nested-nexus duplicate at ${warning.path} (structural duplicate of the canonical flat layout)`,
      severity: 'warn',
      context,
    });
  }

  // T10310 — surface every pragma-drift item as a per-DB warning so
  // operators see drift in `meta.warnings` even when the per-entry
  // `pragmaDrift` array is only inspected by structured-output consumers.
  for (const projectSurvey of result.projects) {
    for (const [role, entry] of Object.entries(projectSurvey.dbs)) {
      if (entry.pragmaDrift === null || entry.pragmaDrift.length === 0) continue;
      for (const drift of entry.pragmaDrift) {
        pushWarning({
          code: 'W_DB_SUBSTRATE_PRAGMA_DRIFT',
          message:
            `Pragma drift on ${role} (${entry.filePath}): ` +
            `expected ${drift.pragma}=${drift.expected}, actual=${drift.actual ?? '<unmeasurable>'}`,
          severity: 'warn',
          context: {
            role,
            filePath: entry.filePath,
            pragma: drift.pragma,
            expected: drift.expected,
            actual: drift.actual,
          },
        });
      }
    }
  }

  // T10323: surface cross-DB orphan-row reports as `meta.warnings` too,
  // one warning per invariant that detected ≥1 orphan. Skipped invariants
  // are NOT surfaced as warnings — they're informational only.
  for (const report of result.crossDbOrphans) {
    if (report.skipped || report.orphanCount === 0) continue;
    pushWarning({
      code: `W_DB_SUBSTRATE_CROSS_DB_${report.invariant}`,
      message: `${report.invariant}: ${report.orphanCount} orphan row${
        report.orphanCount === 1 ? '' : 's'
      } — ${report.description}. ${report.suggestedFix}`,
      severity: 'warn',
      context: {
        invariant: report.invariant,
        orphanCount: report.orphanCount,
        sample: report.sample.join(','),
        suggestedFix: report.suggestedFix,
      },
    });
  }
}

/**
 * Emit `meta.warnings` entries for every per-DB outcome that needs
 * operator attention: auto-quarantine fired, integrity_check exceeded
 * the configured timeout, or both.
 *
 * @param result - The substrate audit result to walk.
 *
 * @task T10312
 */
function pushPerDbWarnings(result: DbSubstrateAuditResult): void {
  for (const projectSurvey of result.projects) {
    for (const [role, dbEntry] of Object.entries(projectSurvey.dbs)) {
      if (dbEntry.quarantinedTo !== null) {
        pushWarning({
          code: 'W_DB_SUBSTRATE_AUTO_QUARANTINED',
          message:
            `Auto-quarantined corrupt ${role} DB at ${dbEntry.filePath} → ${dbEntry.quarantinedTo}.` +
            ` Recover via: cleo backup recover ${role}`,
          severity: 'warn',
          context: {
            role,
            filePath: dbEntry.filePath,
            quarantinedTo: dbEntry.quarantinedTo,
            integrityCheckMs: dbEntry.integrityCheckMs,
          },
        });
      }
      if (dbEntry.timedOut) {
        pushWarning({
          code: 'W_DB_SUBSTRATE_INTEGRITY_TIMEOUT',
          message:
            `integrity_check on ${role} DB at ${dbEntry.filePath} took ${dbEntry.integrityCheckMs}ms` +
            ` — slow substrate flagged for operator attention`,
          severity: 'warn',
          context: {
            role,
            filePath: dbEntry.filePath,
            integrityCheckMs: dbEntry.integrityCheckMs,
          },
        });
      }
    }
  }
}

/**
 * `cleo doctor db-substrate` subcommand.
 *
 * Read-only — performs zero writes. Exits non-zero (`process.exitCode = 2`)
 * when `summary.corrupt > 0` so CI gates can wire the command into a
 * green/red signal. Missing DBs do not drive the exit code on their
 * own — a fresh project legitimately has many missing optional roles.
 *
 * @task T10307
 */
export const doctorDbSubstrateCommand = defineCommand({
  meta: {
    name: 'db-substrate',
    description:
      'Walk every DB in the inventory + report integrity, row counts, orphan dirs. ' +
      'Use --fleet for a multi-project survey under --fleet-root (default /mnt/projects).',
  },
  args: {
    fleet: {
      type: 'boolean',
      description: 'Multi-project survey — walk every .cleo/-bearing subdir under --fleet-root',
    },
    'fleet-root': {
      type: 'string',
      description: 'Fleet root path (default: /mnt/projects). Only used with --fleet.',
    },
    'integrity-timeout-ms': {
      type: 'string',
      description:
        'Wall-clock budget for each PRAGMA integrity_check call (ms; default 60000; 0 disables).',
    },
    'no-quarantine': {
      type: 'boolean',
      description:
        'Disable auto-quarantine of corrupt DBs (leaves them in place; report-only mode).',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const isFleet = args.fleet === true;

    // Parse --integrity-timeout-ms — fall through to the default when the
    // operator omitted it or passed a non-finite/negative value.
    let parsedTimeoutMs: number | undefined;
    if (
      typeof args['integrity-timeout-ms'] === 'string' &&
      args['integrity-timeout-ms'].length > 0
    ) {
      const n = Number.parseInt(args['integrity-timeout-ms'], 10);
      if (Number.isFinite(n) && n >= 0) {
        parsedTimeoutMs = n;
      }
    }
    const options: DbSubstrateSurveyOptions = {
      ...(parsedTimeoutMs !== undefined ? { integrityCheckTimeoutMs: parsedTimeoutMs } : {}),
      autoQuarantine: args['no-quarantine'] !== true,
    };

    const result: DbSubstrateAuditResult = isFleet
      ? surveyFleetDbSubstrate(
          typeof args['fleet-root'] === 'string' && args['fleet-root'].length > 0
            ? args['fleet-root']
            : DEFAULT_FLEET_ROOT,
          options,
        )
      : surveyDbSubstrate(getProjectRoot(), options);

    pushSubstrateWarnings(result);
    pushPerDbWarnings(result);

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.db-substrate.run',
    });

    // Non-zero exit on corruption — missing DBs alone do NOT trip exit.
    if (result.summary.corrupt > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 2;
    }
  },
});
