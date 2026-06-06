/**
 * `cleo doctor repair` — detect malformed CLEO databases and restore each from
 * its freshest validated snapshot (T11829 · DHQ-060).
 *
 * Thin CLI surface over {@link repairMalformedDbs} (CORE) which itself delegates
 * every actual repair to the existing {@link recoverMalformedDb} pipeline
 * (quarantine → snapshot-restore → `PRAGMA quick_check`). NO recovery logic lives
 * here — this command only collects flags, runs the core orchestrator, and emits
 * the LAFS envelope.
 *
 * Default: probe EVERY present DB in `DB_INVENTORY` and repair only what is
 * malformed. `--role <role>` narrows to one role. `--dry-run` reports what would
 * be repaired without touching any files. Exits non-zero when a needed repair
 * could not complete so CI / operators can gate on it.
 *
 * @task T11829 (DHQ-060)
 * @epic T11833
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/repair-malformed-dbs.ts — the orchestrator
 */

import { DB_INVENTORY, type DbRole, ExitCode } from '@cleocode/contracts';
import { getLogger, getProjectRoot } from '@cleocode/core';
import { repairMalformedDbs } from '@cleocode/core/store/repair-malformed-dbs.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

/**
 * `cleo doctor repair` subcommand.
 *
 * @task T11829
 */
export const doctorRepairCommand = defineCommand({
  meta: {
    name: 'repair',
    description:
      'Detect malformed CLEO databases (PRAGMA quick_check) and restore each from its ' +
      'freshest validated snapshot via the recovery pipeline (quarantine → restore → verify). ' +
      'Defaults to every present DB; use --role to narrow, --dry-run to plan without mutating.',
  },
  args: {
    role: {
      type: 'string',
      description: `Repair only this DB role (one of: ${DB_INVENTORY.map((e) => e.role).join(', ')})`,
      default: '',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'Detect + plan only — report what would be repaired without quarantining/restoring',
      default: false,
    },
  },
  run({ args }) {
    const roleArg = typeof args.role === 'string' ? args.role.trim() : '';
    const dryRun = args['dry-run'] === true;

    // Validate an explicit --role against the inventory before doing any work.
    if (roleArg.length > 0 && !DB_INVENTORY.some((e) => e.role === roleArg)) {
      const validRoles = DB_INVENTORY.map((e) => e.role).join(', ');
      cliError(
        `Unknown DB role "${roleArg}". Valid roles: ${validRoles}.`,
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION',
          fix: 'Run `cleo doctor repair --help` for the list of valid roles.',
        },
        { command: 'doctor repair' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    const result = repairMalformedDbs({
      projectRoot: getProjectRoot(),
      roles: roleArg.length > 0 ? [roleArg as DbRole] : undefined,
      dryRun,
      logger: getLogger('doctor-repair'),
    });

    for (const r of result.roles) {
      if (!r.healthy) {
        humanInfo(`  [${r.action.toUpperCase()}] ${r.role} — ${r.detail}`);
      }
    }

    const verb = dryRun ? 'would repair' : 'repaired';
    cliOutput(result, {
      command: 'doctor repair',
      message:
        result.malformedCount === 0
          ? `All ${result.roles.length} inspected DB(s) healthy — nothing to repair.`
          : `${result.malformedCount} malformed DB(s): ${verb} ${result.repairedCount}, ` +
            `${result.failedCount} failed.`,
    });

    // Non-zero exit when a needed repair could not complete.
    if (result.failedCount > 0) {
      process.exitCode = ExitCode.GENERAL_ERROR;
    }
  },
});
