/**
 * CLI command: cleo daemon
 *
 * Manages the CLEO GC sidecar daemon for autonomous transcript cleanup.
 *
 * Subcommands:
 *   cleo daemon start    — spawn detached daemon background process
 *   cleo daemon stop     — send SIGTERM to daemon (read PID from gc-state.json)
 *   cleo daemon status   — show PID, running state, last GC run, disk %
 *
 * The daemon is a node-cron v4 sidecar spawned as a detached Node.js process
 * with file-based stdio. It persists across CLI invocations. On startup it
 * performs crash recovery (pendingPrune) and missed-run recovery (> 24h elapsed).
 *
 * @see packages/cleo/src/gc/daemon.ts for spawn implementation
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getGCDaemonStatus, spawnGCDaemon, stopGCDaemon } from '../../gc/daemon.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo daemon` command group.
 *
 * @param program - Root CLI command to attach to
 */
export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Manage the CLEO GC sidecar daemon for autonomous transcript cleanup');

  // ---------------------------------------------------------------------------
  // cleo daemon start
  // ---------------------------------------------------------------------------

  daemon
    .command('start')
    .description('Spawn the GC daemon as a detached background process')
    .option('--cleo-dir <path>', 'Override .cleo/ directory path')
    .option('--json', 'Output result as JSON')
    .action(async (opts: { cleoDir?: string; json?: boolean }) => {
      const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');

      try {
        // Check if daemon is already running before spawning a duplicate
        const status = await getGCDaemonStatus(cleoDir);
        if (status.running && status.pid) {
          const result = {
            success: false,
            data: {
              running: true,
              pid: status.pid,
              message: `Daemon already running (PID ${status.pid})`,
            },
          };
          if (opts.json) {
            process.stdout.write(JSON.stringify(result) + '\n');
          } else {
            process.stdout.write(`Daemon already running (PID ${status.pid})\n`);
          }
          return;
        }

        const pid = await spawnGCDaemon(cleoDir);
        const result = {
          success: true,
          data: { pid, cleoDir, message: `GC daemon started (PID ${pid})` },
        };

        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stdout.write(`GC daemon started (PID ${pid})\n`);
          process.stdout.write(`Logs: ${join(cleoDir, 'logs', 'gc.log')}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { success: false, error: { code: 'E_INTERNAL', message } };
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stderr.write(`Error starting daemon: ${message}\n`);
        }
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // cleo daemon stop
  // ---------------------------------------------------------------------------

  daemon
    .command('stop')
    .description('Stop the GC daemon by sending SIGTERM to its PID')
    .option('--cleo-dir <path>', 'Override .cleo/ directory path')
    .option('--json', 'Output result as JSON')
    .action(async (opts: { cleoDir?: string; json?: boolean }) => {
      const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');

      try {
        const stopResult = await stopGCDaemon(cleoDir);
        const result = {
          success: stopResult.stopped,
          data: stopResult,
        };

        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else if (stopResult.stopped) {
          process.stdout.write(`GC daemon stopped (${stopResult.reason})\n`);
        } else {
          process.stdout.write(`${stopResult.reason}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = { success: false, error: { code: 'E_INTERNAL', message } };
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stderr.write(`Error stopping daemon: ${message}\n`);
        }
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // cleo daemon status (default action)
  // ---------------------------------------------------------------------------

  daemon
    .command('status')
    .description('Show daemon running state, PID, last GC run, and disk usage')
    .option('--cleo-dir <path>', 'Override .cleo/ directory path')
    .option('--json', 'Output result as JSON')
    .action(async (opts: { cleoDir?: string; json?: boolean }) => {
      const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');
      await showDaemonStatus(cleoDir, opts.json ?? false);
    });

  // Default action (cleo daemon → show status)
  daemon.action(async (opts: { cleoDir?: string; json?: boolean }) => {
    const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');
    await showDaemonStatus(cleoDir, opts.json ?? false);
  });
}

/**
 * Display the daemon status to stdout.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 * @param json - Output as JSON if true
 */
async function showDaemonStatus(cleoDir: string, json: boolean): Promise<void> {
  try {
    const status = await getGCDaemonStatus(cleoDir);
    const result = { success: true, data: status };

    if (json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const runningStr = status.running ? `running (PID ${status.pid})` : 'stopped';
      process.stdout.write(`Daemon:       ${runningStr}\n`);
      process.stdout.write(`Started at:   ${status.startedAt ?? 'never'}\n`);
      process.stdout.write(`Last GC run:  ${status.lastRunAt ?? 'never'}\n`);
      const diskStr =
        status.lastDiskUsedPct !== null ? `${status.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
      process.stdout.write(`Disk used:    ${diskStr}\n`);
      if (status.escalationNeeded) {
        process.stdout.write(
          `\nWARNING: Disk threshold breached. Run 'cleo gc run' to reclaim space.\n`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(
        JSON.stringify({ success: false, error: { code: 'E_INTERNAL', message } }) + '\n',
      );
    } else {
      process.stderr.write(`Error reading daemon status: ${message}\n`);
    }
    process.exit(1);
  }
}
