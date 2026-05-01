/**
 * CLI command group: cleo daemon — GC sidecar daemon management.
 *
 * Manages the CLEO GC sidecar daemon for autonomous transcript cleanup and
 * the sentient loop for cross-project hygiene + dream cycles. The daemon may
 * run in two modes:
 *
 *   Detached (default): `cleo daemon start`
 *     Spawns a detached Node.js child that survives parent exit (ADR-047).
 *
 *   Foreground: `cleo daemon start --foreground`
 *     Runs the daemon in-process. Used by systemd/launchd service units so
 *     the service manager owns the process lifecycle (restart, log routing).
 *
 * Subcommands:
 *   cleo daemon start [--foreground]  — spawn/run daemon
 *   cleo daemon stop                  — send SIGTERM to daemon
 *   cleo daemon status                — show PID, running state, last GC run, disk %
 *   cleo daemon install               — register user-level system service
 *   cleo daemon uninstall             — disable and remove service unit/plist
 *
 * Running `cleo daemon` without a subcommand is equivalent to `cleo daemon status`.
 *
 * @see packages/core/src/gc/daemon.ts for GC spawn implementation
 * @see packages/core/src/sentient/daemon.ts for sentient bootstrapDaemon
 * @see packages/cleo/scripts/install-daemon-service.mjs for service installer
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731 (original daemon)
 * @task T1682 (systemd / launchd auto-start)
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGCDaemonStatus, spawnGCDaemon, stopGCDaemon } from '@cleocode/core/gc/daemon.js';
import {
  bootstrapDaemon as bootstrapSentientDaemon,
  getSentientDaemonStatus,
} from '@cleocode/core/sentient';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Resolve the absolute path to install-daemon-service.mjs from the
 * compiled CLI package tree. Works for both tsc multi-file builds and
 * esbuild single-file bundles (where scripts/ is a sibling of bin/).
 *
 * @returns Absolute path to install-daemon-service.mjs.
 */
function resolveDaemonInstallerScript(): string {
  // dist/cli/commands/daemon.js → ../../.. → package root → scripts/
  const __filename = fileURLToPath(import.meta.url);
  // Walk up three levels: commands/ → cli/ → dist/ → package root
  const pkgRoot = join(__filename, '..', '..', '..', '..');
  return join(pkgRoot, 'scripts', 'install-daemon-service.mjs');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** cleo daemon start — spawn the GC daemon as a detached background process */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Spawn the GC daemon as a detached background process' },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    foreground: {
      type: 'boolean',
      description:
        'Run the sentient daemon in the foreground (used by systemd/launchd service units)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const jsonMode = (args.json as boolean | undefined) ?? false;
    const foreground = (args.foreground as boolean | undefined) ?? false;

    // --foreground: run the sentient daemon bootstrap in-process so that
    // systemd / launchd can own the process lifecycle.
    if (foreground) {
      const projectRoot = process.cwd();
      process.stdout.write(
        `[CLEO DAEMON] Starting sentient daemon in foreground mode (PID ${process.pid})\n`,
      );
      // bootstrapDaemon never returns — it schedules cron jobs and blocks.
      await bootstrapSentientDaemon(projectRoot);
      return;
    }

    // Detached mode (default): spawn a background child process.
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
    const jsonMode = (args.json as boolean | undefined) ?? false;

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
    await showDaemonStatus(cleoDir, process.cwd(), (args.json as boolean | undefined) ?? false);
  },
});

/**
 * cleo daemon install — register the CLEO daemon as a user-level system service.
 *
 * Writes a systemd user unit (Linux) or launchd plist (macOS) and activates it.
 * Idempotent: re-running does not duplicate or restart the service unnecessarily.
 * Respects CLEO_DAEMON_DISABLE=1 to skip activation (CI/container environments).
 */
const installCommand = defineCommand({
  meta: {
    name: 'install',
    description: 'Register the CLEO daemon as a user-level system service (systemd / launchd)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const jsonMode = (args.json as boolean | undefined) ?? false;

    try {
      const scriptPath = resolveDaemonInstallerScript();
      const { installDaemonService } = (await import(scriptPath)) as {
        installDaemonService: () => Promise<void>;
      };
      await installDaemonService();

      const result = {
        success: true,
        data: {
          platform: process.platform,
          message: 'Daemon service installation complete.',
        },
      };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stdout.write('CLEO: Daemon service installation complete.\n');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = { success: false, error: { code: 'E_INTERNAL', message } };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stderr.write(`Error installing daemon service: ${message}\n`);
      }
      process.exit(1);
    }
  },
});

/**
 * cleo daemon uninstall — disable and remove the user-level system service.
 *
 * Stops the running daemon, disables the unit/plist, and removes the service
 * file from disk. Idempotent: safe to run even if the service is not installed.
 */
const uninstallCommand = defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Disable and remove the user-level system service (systemd unit / launchd plist)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const jsonMode = (args.json as boolean | undefined) ?? false;

    try {
      const scriptPath = resolveDaemonInstallerScript();
      const { uninstallDaemonService } = (await import(scriptPath)) as {
        uninstallDaemonService: () => Promise<{
          platform: string;
          removed: string | null;
          success: boolean;
          message: string;
        }>;
      };
      const result = await uninstallDaemonService();

      const envelope = { success: result.success, data: result };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stdout.write(`CLEO: ${result.message}\n`);
      }

      if (!result.success) process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = { success: false, error: { code: 'E_INTERNAL', message } };
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        process.stderr.write(`Error uninstalling daemon service: ${message}\n`);
      }
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// Root command group
// ---------------------------------------------------------------------------

/**
 * Root daemon command group.
 *
 * Manages the CLEO GC sidecar daemon (ADR-047) and the sentient loop
 * (T1682: systemd / launchd auto-start). Running without a subcommand
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
    install: installCommand,
    uninstall: uninstallCommand,
  },
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // status print so `cleo daemon start` doesn't also run status. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    await showDaemonStatus(cleoDir, process.cwd(), (args.json as boolean | undefined) ?? false);
  },
});
