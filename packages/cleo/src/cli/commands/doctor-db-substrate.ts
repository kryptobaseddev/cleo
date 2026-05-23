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
 * @task T10307
 * @epic T10282
 * @saga T10281
 * @see ADR-068 — CLEO Database Charter
 */

import type { DbSubstrateAuditResult } from '@cleocode/contracts';
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
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const isFleet = args.fleet === true;
    const result: DbSubstrateAuditResult = isFleet
      ? surveyFleetDbSubstrate(
          typeof args['fleet-root'] === 'string' && args['fleet-root'].length > 0
            ? args['fleet-root']
            : DEFAULT_FLEET_ROOT,
        )
      : surveyDbSubstrate(getProjectRoot());

    pushSubstrateWarnings(result);

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
