/**
 * `cleo backup recover <role>` — operator-facing CLEO database recovery verb
 * (T10318 — generalised from the brain-only T10304 verb).
 *
 * Wraps {@link runBackupRecover} from `@cleocode/core/store/backup-recover.js`
 * (T10318 internal helper that itself delegates to {@link recoverMalformedDb}
 * from T10318 / generalised T10303) and exposes the recovery pipeline as a
 * discoverable CLI surface for every role in {@link DB_INVENTORY}.
 *
 * The chokepoint helper auto-recovers on the next `openCleoDb(role)` open,
 * so this verb exists for two scenarios the chokepoint does NOT cover:
 *
 *  1. **Pre-emptive recovery** — operator sees `ERR_SQLITE_ERROR errcode=11`
 *     in logs and wants to recover *before* the next session-start.
 *  2. **Pinned restore** — auto-recovery picked the freshest snapshot but the
 *     operator knows that one is poisoned too; `--from-snapshot <iso>` lets
 *     them pin an older one.
 *
 * Backward compatibility: `cleo backup recover brain` continues to work as an
 * explicit subcommand (a thin alias over `cleo backup recover <role>` with
 * `role='brain'`).
 *
 * @task T10318
 * @epic T10284
 * @saga T10281
 */

import { DB_INVENTORY, type DbRole, ExitCode } from '@cleocode/contracts';
import { getLogger, getProjectRoot } from '@cleocode/core';
import { BackupRecoverError, runBackupRecover } from '@cleocode/core/store/backup-recover.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Flag-narrowing helpers
// ---------------------------------------------------------------------------

/** Read a boolean flag from citty's `Record<string, unknown>` parsed args. */
function readBoolFlag(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

/** Read a string flag from citty's `Record<string, unknown>` parsed args. */
function readStringFlag(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Shared executor — every leaf delegates to this single function
// ---------------------------------------------------------------------------

/**
 * Shared executor used by both the generic `cleo backup recover <role>` path
 * and the brain-specific backward-compat alias. Centralises envelope-emission
 * and error-mapping so the two surfaces stay byte-identical for the brain
 * case post-T10318.
 *
 * @internal
 */
function executeRecover(role: DbRole, args: Record<string, unknown>): void {
  const projectRoot = getProjectRoot();
  const dryRun = readBoolFlag(args, 'dry-run');
  const fromSnapshot = readStringFlag(args, 'from-snapshot');
  const noDelta = readBoolFlag(args, 'no-delta');
  const operation = `backup.recover.${role}`;

  try {
    const result = runBackupRecover({
      role,
      projectRoot,
      logger: getLogger(`backup-recover-${role}`),
      dryRun,
      fromSnapshot: fromSnapshot.length > 0 ? fromSnapshot : undefined,
      noDelta,
    });

    cliOutput(result, {
      command: 'backup',
      operation,
    });

    if (result.dryRun) {
      humanInfo(
        `[dry-run] Would restore role "${role}" from ${result.restoredFrom} (${
          result.dataLossWindowHours !== null
            ? `~${result.dataLossWindowHours}h data-loss window`
            : 'data-loss window unknown'
        }). Re-run without --dry-run to execute (project root: ${projectRoot}).`,
      );
    } else {
      humanInfo(
        `Recovered "${role}" DB from ${result.restoredFrom}. Corrupt DB quarantined at ${result.quarantinedTo}.`,
      );
    }
  } catch (err) {
    if (err instanceof BackupRecoverError) {
      cliError(
        err.message,
        err.code,
        {
          name: err.codeName,
          ...(err.fix ? { fix: err.fix } : {}),
        },
        { operation },
      );
      process.exitCode = err.code;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    cliError(message, ExitCode.GENERAL_ERROR, { name: 'E_RECOVERY_FAILED' }, { operation });
    process.exitCode = ExitCode.GENERAL_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Backward-compat leaf — `cleo backup recover brain`
// ---------------------------------------------------------------------------

/**
 * `cleo backup recover brain` — backward-compatible brain.db recovery leaf.
 *
 * Pre-T10318 this was the only `cleo backup recover` subcommand. Post-T10318
 * it is a thin alias over the generic executor with `role='brain'`. The
 * envelope shape (which now carries an explicit `role: 'brain'` field) is the
 * one observable behaviour change — every other field stays identical to
 * the T10304 surface.
 *
 * Kept as an explicit subcommand (rather than dispatched via the generic
 * positional `<role>` arg) so:
 * - `cleo backup recover brain --help` continues to surface specifically.
 * - Existing scripts that hard-code `cleo backup recover brain` keep working.
 *
 * The export name deliberately omits the `*Command` / `*SubCommand` suffix to
 * keep the command-manifest generator from flagging a collision against the
 * top-level `brainCommand` (`cleo brain ...`).
 *
 * @task T10318
 * @epic T10284
 */
export const backupRecoverBrainLeaf = defineCommand({
  meta: {
    name: 'brain',
    description:
      'Recover a malformed brain.db from the freshest validated snapshot (Saga T10281 SG-BRAIN-DB-RESILIENCE)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be done without quarantining or copying any files',
      default: false,
    },
    'from-snapshot': {
      type: 'string',
      description:
        'Pin recovery to a specific snapshot — absolute path or ISO timestamp prefix (e.g. 2026-05-23)',
      default: '',
    },
    'no-delta': {
      type: 'boolean',
      description:
        'Skip the sqlite3 .recover delta-merge step (reserved — current pipeline does not delta-merge; flag plumbed for forward-compat)',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Bypass any safety prompts (currently a no-op; reserved)',
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const argsBag: Record<string, unknown> = args;
    executeRecover('brain', argsBag);
  },
});

// ---------------------------------------------------------------------------
// Generic group — `cleo backup recover <role>`
// ---------------------------------------------------------------------------

/**
 * Validate a positional `<role>` arg against the canonical DB_INVENTORY.
 *
 * @internal
 */
function parseRoleArg(value: string): DbRole {
  const trimmed = value.trim();
  for (const entry of DB_INVENTORY) {
    if (entry.role === trimmed) {
      return entry.role;
    }
  }
  const validRoles = DB_INVENTORY.map((e) => e.role).join(', ');
  throw new BackupRecoverError(
    `Unknown DB role "${trimmed}". Valid roles: ${validRoles}.`,
    ExitCode.VALIDATION_ERROR,
    'E_UNKNOWN_ROLE',
    'Run `cleo backup recover --help` for the list of valid roles.',
  );
}

/**
 * `cleo backup recover` — recovery verb group.
 *
 * @remarks
 * Accepts an optional positional `<role>` argument (T10318) that selects any
 * role from {@link DB_INVENTORY}. When called with no argument, surfaces the
 * usage. The brain-specific subcommand is kept as a backward-compat alias.
 *
 * @task T10318
 * @epic T10284
 */
export const backupRecoverSubCommand = defineCommand({
  meta: {
    name: 'recover',
    description:
      'Recover a malformed CLEO database from snapshot — accepts any role from DB_INVENTORY (T10318)',
  },
  args: {
    role: {
      type: 'positional',
      description: `Canonical DB role (one of: ${DB_INVENTORY.map((e) => e.role).join(', ')})`,
      required: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be done without quarantining or copying any files',
      default: false,
    },
    'from-snapshot': {
      type: 'string',
      description:
        'Pin recovery to a specific snapshot — absolute path or ISO timestamp prefix (e.g. 2026-05-23)',
      default: '',
    },
    'no-delta': {
      type: 'boolean',
      description:
        'Skip the sqlite3 .recover delta-merge step (reserved — current pipeline does not delta-merge; flag plumbed for forward-compat)',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Bypass any safety prompts (currently a no-op; reserved)',
      default: false,
    },
  },
  subCommands: {
    brain: backupRecoverBrainLeaf,
  },
  async run({ args }): Promise<void> {
    const argsBag: Record<string, unknown> = args;
    const roleArg = readStringFlag(argsBag, 'role');

    // No positional + no subcommand → surface usage. citty fires the parent
    // `run` AFTER a subcommand resolves, so this branch only triggers when
    // the operator typed `cleo backup recover` with no leaf and no role.
    if (roleArg.length === 0) {
      const validRoles = DB_INVENTORY.map((e) => e.role).join(', ');
      cliError(
        `Missing role. Try \`cleo backup recover <role>\` (one of: ${validRoles}).`,
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION',
          fix: 'Run `cleo backup recover --help` to see available roles and flags.',
        },
        { operation: 'backup.recover' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    let role: DbRole;
    try {
      role = parseRoleArg(roleArg);
    } catch (err) {
      if (err instanceof BackupRecoverError) {
        cliError(
          err.message,
          err.code,
          {
            name: err.codeName,
            ...(err.fix ? { fix: err.fix } : {}),
          },
          { operation: 'backup.recover' },
        );
        process.exitCode = err.code;
        return;
      }
      throw err;
    }

    executeRecover(role, argsBag);
  },
});
