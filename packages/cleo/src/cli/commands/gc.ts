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
 * @see packages/cleo/src/gc/runner.ts for GC logic
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { runGC } from '../../gc/runner.js';
import { readGCState } from '../../gc/state.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo gc` command group.
 *
 * @param program - Root CLI command to attach to
 */
export function registerGCCommand(program: Command): void {
  const gc = program
    .command('gc')
    .description('Transcript garbage collection: manual trigger and status');

  // ---------------------------------------------------------------------------
  // cleo gc run
  // ---------------------------------------------------------------------------

  gc.command('run')
    .description('Run GC immediately (blocking). Prunes old transcripts based on disk pressure.')
    .option('--cleo-dir <path>', 'Override .cleo/ directory path')
    .option('--dry-run', 'Report what would be pruned without deleting anything')
    .option('--json', 'Output result as JSON')
    .action(async (opts: { cleoDir?: string; dryRun?: boolean; json?: boolean }) => {
      const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');
      const dryRun = opts.dryRun ?? false;

      try {
        const gcResult = await runGC({ cleoDir, dryRun });
        const result = { success: true, data: gcResult };

        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          const dryLabel = dryRun ? ' (dry run)' : '';
          process.stdout.write(`GC run complete${dryLabel}\n`);
          process.stdout.write(
            `Disk: ${gcResult.diskUsedPct.toFixed(1)}% (${gcResult.threshold.toUpperCase()})\n`,
          );
          process.stdout.write(
            `Pruned: ${gcResult.pruned.length} paths, ${formatBytes(gcResult.bytesFreed)} freed\n`,
          );
          if (gcResult.escalationSet && gcResult.escalationReason) {
            process.stdout.write(`\nWARNING: ${gcResult.escalationReason}\n`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { success: false, error: { code: 'E_INTERNAL', message } };
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stderr.write(`GC run failed: ${message}\n`);
        }
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // cleo gc status
  // ---------------------------------------------------------------------------

  gc.command('status')
    .description('Show last GC run stats, disk usage, and escalation state')
    .option('--cleo-dir <path>', 'Override .cleo/ directory path')
    .option('--json', 'Output result as JSON')
    .action(async (opts: { cleoDir?: string; json?: boolean }) => {
      const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');
      const statePath = join(cleoDir, 'gc-state.json');

      try {
        const state = await readGCState(statePath);
        const result = { success: true, data: state };

        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stdout.write(`Last run:     ${state.lastRunAt ?? 'never'}\n`);
          process.stdout.write(`Last result:  ${state.lastRunResult ?? 'none'}\n`);
          process.stdout.write(`Bytes freed:  ${formatBytes(state.lastRunBytesFreed)}\n`);
          const diskStr =
            state.lastDiskUsedPct !== null ? `${state.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
          process.stdout.write(`Disk used:    ${diskStr}\n`);
          process.stdout.write(`Failures:     ${state.consecutiveFailures}\n`);
          process.stdout.write(
            `Escalation:   ${state.escalationNeeded ? 'YES — run cleo gc run' : 'no'}\n`,
          );
          if (state.escalationReason) {
            process.stdout.write(`Reason:       ${state.escalationReason}\n`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { success: false, error: { code: 'E_INTERNAL', message } };
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stderr.write(`Error reading GC status: ${message}\n`);
        }
        process.exit(1);
      }
    });
}

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
