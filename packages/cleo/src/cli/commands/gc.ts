/**
 * CLI command: cleo gc
 *
 * Manual GC trigger and status reporting.
 *
 * Subcommands:
 *   cleo gc run     — manual GC trigger (blocking, for debugging/immediate need)
 *   cleo gc status  — show last run stats, disk%, escalation state
 *
 * The GC engine checks disk pressure on `~/.cleo/` and prunes transcripts
 * under `~/.claude/projects/` based on the five-tier threshold model.
 *
 * @see packages/core/src/gc/runner.ts for GC logic
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @task T1724
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { runGC } from '@cleocode/core/gc/runner.js';
import { readGCState } from '@cleocode/core/gc/state.js';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Format a byte count into a human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Human-readable string (e.g. `"1.2 GB"`, `"340 MB"`, `"0 B"`)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp] ?? 'B'}`;
}

/** cleo gc run — trigger GC immediately (blocking) */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Run GC immediately (blocking). Prunes old transcripts based on disk pressure.',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be pruned without deleting anything',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const dryRun = args['dry-run'];

    try {
      const gcResult = await runGC({ cleoDir, dryRun });
      const dryLabel = dryRun ? ' (dry run)' : '';
      const humanMsg =
        `GC run complete${dryLabel} — ` +
        `Disk: ${gcResult.diskUsedPct.toFixed(1)}% (${gcResult.threshold.toUpperCase()}), ` +
        `Pruned: ${gcResult.pruned.length} paths, ${formatBytes(gcResult.bytesFreed)} freed` +
        (gcResult.escalationSet && gcResult.escalationReason
          ? ` — WARNING: ${gcResult.escalationReason}`
          : '');
      cliOutput(gcResult, {
        command: 'gc',
        operation: 'gc.run',
        message: humanMsg,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `GC run failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'gc.run',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo gc status — show last GC run stats, disk usage, and escalation state */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show last GC run stats, disk usage, and escalation state',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const statePath = join(cleoDir, 'gc-state.json');

    try {
      const state = await readGCState(statePath);
      const diskStr =
        state.lastDiskUsedPct !== null ? `${state.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
      cliOutput(state, {
        command: 'gc',
        operation: 'gc.status',
        message:
          `Last run: ${state.lastRunAt ?? 'never'}, ` +
          `Disk: ${diskStr}, ` +
          `Escalation: ${state.escalationNeeded ? 'YES — run cleo gc run' : 'no'}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error reading GC status: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'gc.status',
        },
      );
      process.exit(1);
    }
  },
});

/**
 * Root GC command group — transcript garbage collection manual trigger and status.
 *
 * Subcommands dispatch directly to the GC runner and state reader without
 * going through the dispatch layer (GC is a local utility, not a domain operation).
 */
export const gcCommand = defineCommand({
  meta: {
    name: 'gc',
    description: 'Transcript garbage collection: manual trigger and status',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
