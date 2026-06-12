/**
 * CLI command: cleo janitor
 *
 * Subcommands:
 *   cleo janitor run [--dry-run]  — run the janitor sweep (orphan reap +
 *                                   stale-lock/scope/debris cleanup)
 *
 * The janitor engine lives in `packages/core/src/gc/janitor.ts` and is
 * callable without a running daemon.  Every action is silent (audit JSONL
 * only); the CLI verb surfaces the structured counts via the LAFS envelope.
 *
 * @see packages/core/src/gc/janitor.ts — engine
 * @task T11995
 * @epic T11992
 */

import { runJanitor } from '@cleocode/core/gc/janitor.js';
import { resolveLegacyCleoDir } from '@cleocode/paths';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/** cleo janitor run — execute the janitor sweep */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run the janitor sweep: reap orphan processes, stop dead scopes, reclaim stale locks, prune temp debris.',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report planned actions without mutating anything',
      default: false,
    },
    'grace-min': {
      type: 'string',
      description:
        'Minimum age (minutes) of an unregistered process before reap eligibility (default: 10)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);
    const dryRun = args['dry-run'];
    const graceMinRaw = args['grace-min'] as string | undefined;
    const gracePeriodMs = graceMinRaw !== undefined ? Number(graceMinRaw) * 60_000 : undefined;

    try {
      const result = await runJanitor({ dryRun, cleoDir, gracePeriodMs });

      const dryLabel = dryRun ? ' (dry run)' : '';
      const total =
        result.reaped +
        result.scopesStopped +
        result.locksReclaimed +
        result.semaphoreSlotsCleared +
        result.worktreesPruned +
        result.worktreesQuarantined +
        result.tmpRemoved +
        result.attachmentsRepaired +
        result.configsRepaired;

      const humanMsg =
        `janitor${dryLabel} — ` +
          `${total} action(s): ` +
          [
            result.reaped > 0 && `${result.reaped} process(es) reaped`,
            result.scopesStopped > 0 && `${result.scopesStopped} scope(s) stopped`,
            result.locksReclaimed > 0 && `${result.locksReclaimed} lock(s) reclaimed`,
            result.semaphoreSlotsCleared > 0 &&
              `${result.semaphoreSlotsCleared} semaphore slot(s) cleared`,
            result.worktreesPruned > 0 && `${result.worktreesPruned} worktree(s) pruned`,
            result.worktreesQuarantined > 0 && `${result.worktreesQuarantined} quarantined`,
            result.tmpRemoved > 0 && `${result.tmpRemoved} tmp dir(s) removed`,
            result.attachmentsRepaired > 0 &&
              `${result.attachmentsRepaired} attachment(s) repaired`,
            result.configsRepaired > 0 && `${result.configsRepaired} config(s) repaired`,
            result.errors > 0 && `${result.errors} error(s)`,
          ]
            .filter(Boolean)
            .join(', ') || 'nothing to do';

      cliOutput(result, {
        command: 'janitor',
        operation: 'admin.janitor.run',
        message: humanMsg,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `janitor run failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'admin.janitor.run',
        },
      );
      process.exit(1);
    }
  },
});

/**
 * Root janitor command group — orphan process reaper + stale debris sweep.
 */
export const janitorCommand = defineCommand({
  meta: {
    name: 'janitor',
    description: 'Orphan process reaper and stale scope/lock/debris sweep (silent, idempotent)',
  },
  subCommands: {
    run: runCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
