/**
 * `cleo doctor projects` — machine-wide integrity check of the project
 * registry, keyed by project id (ADR-094).
 *
 * Without flags (or with `--dry-run`) it is read-only: every registry row is
 * probed and classified (moved, ambiguous, split, missing, temp, root,
 * unreadable), and each non-ok row is listed with the exact remedy. `--apply`
 * rebinds moved rows by id and records missing locations, writing a receipt;
 * `--rollback <receiptId>` restores the rows that receipt changed.
 *
 * Not to be confused with `cleo doctor-projects` (per-project DB health).
 *
 * @task T12471
 * @see ADR-094 — write-once portable project identity
 */

import {
  applyProjectRegistryRepair,
  inspectProjectRegistry,
  RegistryRepairError,
  rollbackProjectRegistryRepair,
} from '@cleocode/core/doctor/projects.js';
import { NexusRegistryReadError } from '@cleocode/core/nexus/registry-errors.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Parse a positive integer flag; `undefined` when absent or invalid. */
const positiveInt = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * `cleo doctor projects` subcommand.
 *
 * Exits 1 when the dry run finds any row that needs attention, so it can gate
 * a script; exits non-zero when a rollback is refused.
 *
 * @task T12471
 */
export const doctorRegistryCommand = defineCommand({
  meta: {
    name: 'projects',
    description:
      'Machine-wide registry integrity: rebind moved projects by id, flag split identities, ' +
      'missing, temp and home/root rows, each with the exact remedy. Read-only by default; ' +
      '--apply writes a receipt, --rollback <receiptId> restores the prior rows.',
  },
  args: {
    'dry-run': { type: 'boolean', description: 'Report only (the default); write nothing' },
    apply: { type: 'boolean', description: 'Rebind moved rows and record missing locations' },
    rollback: { type: 'string', description: 'Restore the rows changed by this receipt id' },
    roots: {
      type: 'string',
      description: 'Comma-separated extra directories to scan for .cleo/project-id',
    },
    'max-depth': { type: 'string', description: 'Scan depth below each root (default 2)' },
    concurrency: { type: 'string', description: 'Filesystem reads in flight (default 16)' },
    'timeout-ms': { type: 'string', description: 'Budget per filesystem probe (default 2000)' },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const operation = args.rollback
      ? 'doctor.projects.rollback'
      : args.apply && !args['dry-run']
        ? 'doctor.projects.apply'
        : 'doctor.projects.inspect';
    try {
      if (typeof args.rollback === 'string' && args.rollback.length > 0) {
        const result = await rollbackProjectRegistryRepair(args.rollback);
        cliOutput(result, { command: 'doctor', operation });
        return;
      }
      const opts = {
        roots:
          typeof args.roots === 'string'
            ? args.roots
                .split(',')
                .map((root) => root.trim())
                .filter((root) => root.length > 0)
            : undefined,
        maxDepth: positiveInt(args['max-depth']),
        concurrency: positiveInt(args.concurrency),
        timeoutMs: positiveInt(args['timeout-ms']),
      };
      if (operation === 'doctor.projects.apply') {
        cliOutput(await applyProjectRegistryRepair(opts), { command: 'doctor', operation });
        return;
      }
      const report = await inspectProjectRegistry(opts);
      cliOutput(report, { command: 'doctor', operation });
      if (
        (report.findings.some((f) => f.kind !== 'other-device') ||
          report.ambiguousAliases.length > 0) &&
        (process.exitCode ?? 0) === 0
      )
        process.exitCode = 1;
    } catch (error) {
      // T12512: an unreadable registry keeps its typed code, exit 75 and fix.
      if (error instanceof NexusRegistryReadError) {
        cliError(
          error.message,
          error.code,
          { name: error.codeName, fix: error.fix, details: error.details },
          { operation },
        );
        process.exitCode = error.code;
        return;
      }
      const code = error instanceof RegistryRepairError ? error.code : 'E_DOCTOR_PROJECTS_FAILED';
      const exitCode = code === 'E_NOT_FOUND' ? 4 : 1;
      cliError(
        error instanceof Error ? error.message : String(error),
        exitCode,
        { name: code },
        {
          operation,
        },
      );
      process.exitCode = exitCode;
    }
  },
});
