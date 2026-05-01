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
import { getSentientDaemonStatus } from '@cleocode/core/sentient';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';

/**
 * Display the daemon status to stdout.
 *
 * Renders both the GC daemon status and the cross-project hygiene loop
 * summary (T1637) in a single call. JSON mode returns a combined payload.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory (GC daemon)
 * @param projectRoot - Absolute path to the project root (sentient state)
 * @param json - Output as JSON when true
 */
async function showDaemonStatus(
  cleoDir: string,
  projectRoot: string,
  json: boolean,
): Promise<void> {
  try {
    const gcStatus = await getGCDaemonStatus(cleoDir);

    // Sentient status (includes T1637 hygiene fields). Best-effort — sentient
    // daemon may not be running; missing state file yields sensible defaults.
    let hygieneLastRunAt: string | null = null;
    let hygieneSummary: string | null = null;
    let hygieneStats: {
      projectsChecked: number;
      projectsHealthy: number;
      tempGcCandidates: number;
      duplicateEpicGroups: number;
      worktreesPruned: number;
    } = {
      projectsChecked: 0,
      projectsHealthy: 0,
      tempGcCandidates: 0,
      duplicateEpicGroups: 0,
      worktreesPruned: 0,
    };
    try {
      const sentientStatus = await getSentientDaemonStatus(projectRoot);
      hygieneLastRunAt = sentientStatus.hygieneLastRunAt;
      hygieneSummary = sentientStatus.hygieneSummary;
      hygieneStats = sentientStatus.hygieneStats;
    } catch {
      // Sentient not initialised — hygiene fields remain null/default.
    }

    const result = {
      success: true,
      data: {
        gc: gcStatus,
        hygiene: {
          lastRunAt: hygieneLastRunAt,
          summary: hygieneSummary,
          stats: hygieneStats,
        },
      },
    };

    if (json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const runningStr = gcStatus.running ? `running (PID ${gcStatus.pid})` : 'stopped';
      process.stdout.write(`GC Daemon:       ${runningStr}\n`);
      process.stdout.write(`Started at:      ${gcStatus.startedAt ?? 'never'}\n`);
      process.stdout.write(`Last GC run:     ${gcStatus.lastRunAt ?? 'never'}\n`);
      const diskStr =
        gcStatus.lastDiskUsedPct !== null ? `${gcStatus.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
      process.stdout.write(`Disk used:       ${diskStr}\n`);
      if (gcStatus.escalationNeeded) {
        process.stdout.write(
          `\nWARNING: Disk threshold breached. Run 'cleo gc run' to reclaim space.\n`,
        );
      }
      // T1637: hygiene section
      process.stdout.write(`\nHygiene Loop (cross-project):\n`);
      process.stdout.write(`  Last run:        ${hygieneLastRunAt ?? 'never'}\n`);
      process.stdout.write(`  Summary:         ${hygieneSummary ?? 'not yet run'}\n`);
      if (hygieneStats.projectsChecked > 0) {
        process.stdout.write(
          `  Projects:        ${hygieneStats.projectsHealthy}/${hygieneStats.projectsChecked} healthy\n`,
        );
        if (hygieneStats.tempGcCandidates > 0) {
          process.stdout.write(
            `  Temp GC:         ${hygieneStats.tempGcCandidates} candidate(s) pending approval\n`,
          );
        }
        if (hygieneStats.duplicateEpicGroups > 0) {
          process.stdout.write(
            `  Duplicate epics: ${hygieneStats.duplicateEpicGroups} group(s) detected\n`,
          );
        }
        if (hygieneStats.worktreesPruned > 0) {
          process.stdout.write(
            `  Worktrees:       ${hygieneStats.worktreesPruned} stale worktree(s) pruned\n`,
          );
        }
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

/** cleo daemon status — show daemon running state, PID, last GC run, disk usage, and hygiene */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show daemon running state, PID, last GC run, disk usage, and cross-project hygiene summary',
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
    await showDaemonStatus(cleoDir, process.cwd(), args.json ?? false);
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
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // status print so `cleo daemon start` doesn't also run status. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    await showDaemonStatus(cleoDir, process.cwd(), args.json ?? false);
  },
});
