/**
 * CLI command group: cleo daemon — GC sidecar daemon management.
 *
 * Manages the CLEO GC sidecar daemon for autonomous transcript cleanup.
 * The daemon is a node-cron v4 sidecar spawned as a detached Node.js process
 * with file-based stdio. It persists across CLI invocations.
 *
 * Subcommands:
 *   cleo daemon start  — spawn detached daemon background process
 *   cleo daemon stop   — send SIGTERM to daemon (read PID from gc-state.json)
 *   cleo daemon status — show PID, running state, last GC run, disk %
 *
 * Running `cleo daemon` without a subcommand is equivalent to `cleo daemon status`.
 *
 * @see packages/core/src/gc/daemon.ts for spawn implementation
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getGCDaemonStatus, spawnGCDaemon, stopGCDaemon } from '@cleocode/core/gc/daemon.js';
import { defineCommand } from 'citty';

/**
 * Display the daemon status to stdout.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory
 * @param json - Output as JSON when true
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

/** cleo daemon start — spawn the GC daemon as a detached background process */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Spawn the GC daemon as a detached background process' },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const jsonMode = args.json ?? false;

    try {
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
        if (jsonMode) {
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

      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write(`GC daemon started (PID ${pid})\n`);
        process.stdout.write(`Logs: ${join(cleoDir, 'logs', 'gc.log')}\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = { success: false, error: { code: 'E_INTERNAL', message } };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stderr.write(`Error starting daemon: ${message}\n`);
      }
      process.exit(1);
    }
  },
});

/** cleo daemon stop — stop the GC daemon by sending SIGTERM to its PID */
const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop the GC daemon by sending SIGTERM to its PID' },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const jsonMode = args.json ?? false;

    try {
      const stopResult = await stopGCDaemon(cleoDir);
      const result = {
        success: stopResult.stopped,
        data: stopResult,
      };

      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else if (stopResult.stopped) {
        process.stdout.write(`GC daemon stopped (${stopResult.reason})\n`);
      } else {
        process.stdout.write(`${stopResult.reason}\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = { success: false, error: { code: 'E_INTERNAL', message } };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stderr.write(`Error stopping daemon: ${message}\n`);
      }
      process.exit(1);
    }
  },
});

/** cleo daemon status — show daemon running state, PID, last GC run, and disk usage */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon running state, PID, last GC run, and disk usage',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    await showDaemonStatus(cleoDir, args.json ?? false);
  },
});

/**
 * Root daemon command group.
 *
 * Manages the CLEO GC sidecar daemon (ADR-047). Running without a subcommand
 * falls through to show status.
 */
export const daemonCommand = defineCommand({
  meta: {
    name: 'daemon',
    description: 'Manage the CLEO GC sidecar daemon for autonomous transcript cleanup',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    await showDaemonStatus(cleoDir, args.json ?? false);
  },
});
