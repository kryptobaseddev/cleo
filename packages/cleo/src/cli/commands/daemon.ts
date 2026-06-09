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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGCDaemonStatus, spawnGCDaemon, stopGCDaemon } from '@cleocode/core/gc/daemon.js';
import {
  bootstrapDaemon as bootstrapSentientDaemon,
  getSentientDaemonStatus,
} from '@cleocode/core/sentient';
import { resolveLegacyCleoDir } from '@cleocode/paths';
import { type ServeGatewayHandle, serveGateway } from '@cleocode/runtime/gateway';
import { defineCommand } from 'citty';
import { createCliGatewayHandler } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Default loopback TCP port for the `cleo daemon serve` HTTP gateway.
 *
 * Bound to `127.0.0.1` by default (loopback only) — the gateway is
 * local-process-facing and secrets are never serialized onto the wire
 * (sealed-handle resolution stays server-side). Exposing it on a public
 * interface is an explicit `--host` decision.
 */
const DEFAULT_GATEWAY_HTTP_PORT = 7777;

/**
 * Block until the process receives a termination signal, then close the gateway
 * listener. Resolves once the listener is torn down so the caller can exit
 * cleanly. The HTTP adapter never calls `process.exit` — lifecycle stays here.
 *
 * @param handle - The live gateway server handle to close on shutdown.
 */
async function blockUntilSignal(handle: ServeGatewayHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      void handle.close().finally(resolve);
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Display the daemon status via cliOutput.
 *
 * Renders both the GC daemon status and the cross-project hygiene loop
 * summary (T1637) in a single call. JSON mode returns a combined payload
 * via formatSuccess; human mode via renderGeneric.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory (GC daemon)
 * @param projectRoot - Absolute path to the project root (sentient state)
 * @task T1724
 */
async function showDaemonStatus(cleoDir: string, projectRoot: string): Promise<void> {
  try {
    const gcStatus = await getGCDaemonStatus(cleoDir);

    // Sentient status (includes T1637 hygiene + T1683/T1684 Studio fields).
    // Best-effort — sentient daemon may not be running; missing state file
    // yields sensible defaults.
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
    let supervisesStudio: boolean | null = null;
    let studioStatus: string | null = null;
    try {
      const sentientStatus = await getSentientDaemonStatus(projectRoot);
      hygieneLastRunAt = sentientStatus.hygieneLastRunAt;
      hygieneSummary = sentientStatus.hygieneSummary;
      hygieneStats = sentientStatus.hygieneStats;
      supervisesStudio = sentientStatus.supervisesStudio;
      studioStatus = sentientStatus.studioStatus;
    } catch {
      // Sentient not initialised — hygiene and Studio fields remain null/default.
    }

    const data = {
      gc: gcStatus,
      hygiene: {
        lastRunAt: hygieneLastRunAt,
        summary: hygieneSummary,
        stats: hygieneStats,
      },
      studio: {
        supervises: supervisesStudio,
        status: studioStatus,
      },
    };

    const runningStr = gcStatus.running ? `running (PID ${gcStatus.pid})` : 'stopped';
    const diskStr =
      gcStatus.lastDiskUsedPct !== null ? `${gcStatus.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
    const escalationNote = gcStatus.escalationNeeded
      ? " — WARNING: Disk threshold breached. Run 'cleo gc run' to reclaim space."
      : '';
    cliOutput(data, {
      command: 'daemon',
      operation: 'daemon.status',
      message: `GC Daemon: ${runningStr}, Disk: ${diskStr}${escalationNote}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cliError(
      `Error reading daemon status: ${message}`,
      'E_INTERNAL',
      { name: 'E_INTERNAL' },
      {
        operation: 'daemon.status',
      },
    );
    process.exit(1);
  }
}

/**
 * Resolve the absolute path to install-daemon-service.mjs from the
 * compiled CLI package tree.
 *
 * Works for both esbuild single-file bundles and tsc multi-file builds by
 * probing candidate paths in order of likelihood (T1684 hotfix):
 *
 *   1. Single-file bundle: `dist/cli/index.js` → 2 dirs up → `<pkg>/scripts/`
 *   2. Multi-file tsc:     `dist/cli/commands/daemon.js` → 3 dirs up → `<pkg>/scripts/`
 *
 * @returns Absolute path to install-daemon-service.mjs.
 */
function resolveDaemonInstallerScript(): string {
  const filePath = fileURLToPath(import.meta.url);

  // Probe candidate 1: esbuild bundle — dist/cli/index.js (2 dirs above the file = pkg root)
  const candidate1 = join(filePath, '..', '..', '..', 'scripts', 'install-daemon-service.mjs');
  if (existsSync(candidate1)) return candidate1;

  // Probe candidate 2: tsc multi-file — dist/cli/commands/daemon.js (3 dirs above = pkg root)
  const candidate2 = join(
    filePath,
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'install-daemon-service.mjs',
  );
  return candidate2;
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
    const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);
    const foreground = (args.foreground as boolean | undefined) ?? false;

    // --foreground: run the sentient daemon bootstrap in-process so that
    // systemd / launchd can own the process lifecycle.
    if (foreground) {
      const projectRoot = process.cwd();
      cliOutput(
        {
          pid: process.pid,
          mode: 'foreground',
          message: 'Starting sentient daemon in foreground mode',
        },
        {
          command: 'daemon',
          operation: 'daemon.start',
          message: `[CLEO DAEMON] Starting sentient daemon in foreground mode (PID ${process.pid})`,
        },
      );
      // bootstrapDaemon never returns — it schedules cron jobs and blocks.
      await bootstrapSentientDaemon(projectRoot);
      return;
    }

    // Detached mode (default): spawn a background child process.
    try {
      const status = await getGCDaemonStatus(cleoDir);
      if (status.running && status.pid) {
        cliOutput(
          { running: true, pid: status.pid, message: `Daemon already running (PID ${status.pid})` },
          {
            command: 'daemon',
            operation: 'daemon.start',
            message: `Daemon already running (PID ${status.pid})`,
          },
        );
        return;
      }

      const pid = await spawnGCDaemon(cleoDir);
      cliOutput(
        {
          pid,
          cleoDir,
          logs: join(cleoDir, 'logs', 'gc.log'),
          message: `GC daemon started (PID ${pid})`,
        },
        {
          command: 'daemon',
          operation: 'daemon.start',
          message: `GC daemon started (PID ${pid}) — Logs: ${join(cleoDir, 'logs', 'gc.log')}`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error starting daemon: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'daemon.start',
        },
      );
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
    const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);

    try {
      const stopResult = await stopGCDaemon(cleoDir);
      cliOutput(stopResult, {
        command: 'daemon',
        operation: 'daemon.stop',
        message: stopResult.stopped
          ? `GC daemon stopped (${stopResult.reason})`
          : stopResult.reason,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error stopping daemon: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'daemon.stop',
        },
      );
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
    const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);
    await showDaemonStatus(cleoDir, process.cwd());
  },
});

/**
 * cleo daemon install — register the CLEO daemon as a user-level system service.
 *
 * Writes a systemd user unit (Linux) or launchd plist (macOS) and activates it.
 * Idempotent: re-running does not duplicate or restart the service unnecessarily.
 * Respects CLEO_DAEMON_DISABLE=1 to skip activation (CI/container environments).
 *
 * When `--saga <id>` or `--epic <id>` is given the service unit is scoped:
 * `CLEO_SENTIENT_SAGA` / `CLEO_SENTIENT_EPIC` are injected into the
 * service environment so the daemon only picks tasks within that scope.
 * Re-running with a different (or no) saga regenerates and reloads the unit.
 *
 * @task T11497 E5-HEADLESS AC3
 */
const installCommand = defineCommand({
  meta: {
    name: 'install',
    description: 'Register the CLEO daemon as a user-level system service (systemd / launchd)',
  },
  args: {
    saga: {
      type: 'string',
      description:
        'Scope the daemon to tasks within a Saga (sets CLEO_SENTIENT_SAGA in service env)',
      required: false,
    },
    epic: {
      type: 'string',
      description:
        'Scope the daemon to tasks directly under an Epic (sets CLEO_SENTIENT_EPIC in service env)',
      required: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    try {
      const scriptPath = resolveDaemonInstallerScript();
      const { installDaemonService } = (await import(scriptPath)) as {
        installDaemonService: (opts?: {
          scopeSagaId?: string;
          scopeEpicId?: string;
        }) => Promise<void>;
      };
      const scopeSagaId =
        typeof args.saga === 'string' && args.saga.length > 0 ? args.saga : undefined;
      const scopeEpicId =
        typeof args.epic === 'string' && args.epic.length > 0 ? args.epic : undefined;
      await installDaemonService({ scopeSagaId, scopeEpicId });

      const scopeNote =
        scopeEpicId !== undefined
          ? ` (scoped to epic ${scopeEpicId})`
          : scopeSagaId !== undefined
            ? ` (scoped to saga ${scopeSagaId})`
            : '';

      cliOutput(
        {
          platform: process.platform,
          scopeSagaId,
          scopeEpicId,
          message: `Daemon service installation complete${scopeNote}.`,
        },
        {
          command: 'daemon',
          operation: 'daemon.install',
          message: `CLEO: Daemon service installation complete${scopeNote}.`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error installing daemon service: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'daemon.install' },
      );
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
  async run({ args: _args }) {
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

      cliOutput(result, {
        command: 'daemon',
        operation: 'daemon.uninstall',
        message: `CLEO: ${result.message}`,
      });

      if (!result.success) process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error uninstalling daemon service: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'daemon.uninstall' },
      );
      process.exit(1);
    }
  },
});

/**
 * cleo daemon serve — start the HTTP gateway listener in the foreground.
 *
 * Wires the existing HTTP gateway adapter (`startHttpServer` /
 * `defineGatewaySubsystem`, T11254) into a runnable call-site (T11919 AC5): it
 * assembles the in-process CLI gateway handler (full middleware chain) and
 * starts the HTTP transport over it, serving the versioned `/v1/<domain>/<op>`
 * REST facade plus `GET /v1/health`.
 *
 * Loopback-only by default (`127.0.0.1:7777`) — secrets are never serialized
 * onto the wire (sealed-handle resolution stays server-side). Per North-Star the
 * daemon stays OFF by default; this only provides the serve call-site so it CAN
 * serve when explicitly invoked. The NDJSON IPC / RPC transport is unaffected
 * and co-listens when separately configured (AC3).
 *
 * Runs in the foreground and blocks until SIGTERM/SIGINT, then closes the
 * listener cleanly. The streaming routes (SSE — T11921, WS — T11922) extend the
 * same listener; this command owns only the unary HTTP serve call-site.
 *
 * @task T11919 (M5 · AC5)
 */
const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the HTTP gateway listener (versioned /v1 REST facade, loopback by default)',
  },
  args: {
    port: {
      type: 'string',
      description: `TCP port to bind (default ${DEFAULT_GATEWAY_HTTP_PORT}; 0 = ephemeral)`,
    },
    host: {
      type: 'string',
      description: 'Host/interface to bind (default 127.0.0.1 — loopback only)',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    try {
      const portArg = args.port as string | undefined;
      const port =
        portArg !== undefined && portArg.length > 0
          ? Number.parseInt(portArg, 10)
          : DEFAULT_GATEWAY_HTTP_PORT;
      if (Number.isNaN(port) || port < 0 || port > 65535) {
        cliError(
          `Invalid --port '${portArg}'; expected an integer in [0, 65535]`,
          'E_INVALID_INPUT',
          { name: 'E_INVALID_INPUT' },
          { operation: 'daemon.serve' },
        );
        process.exit(2);
      }
      const host = (args.host as string | undefined) ?? '127.0.0.1';

      const handle = await serveGateway({ handler: createCliGatewayHandler(), port, host });
      cliOutput(
        {
          pid: process.pid,
          host: handle.host,
          port: handle.port,
          scope: handle.scope,
          facade: '/v1',
          message: `HTTP gateway listening on http://${handle.host}:${handle.port}/v1`,
        },
        {
          command: 'daemon',
          operation: 'daemon.serve',
          message: `HTTP gateway listening on http://${handle.host}:${handle.port}/v1 (PID ${process.pid})`,
        },
      );
      // Foreground: block until a termination signal, then close cleanly.
      await blockUntilSignal(handle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error starting HTTP gateway: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'daemon.serve' },
      );
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
    serve: serveCommand,
    install: installCommand,
    uninstall: uninstallCommand,
  },
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // status print so `cleo daemon start` doesn't also run status. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const cleoDir = resolveLegacyCleoDir(args['cleo-dir'] as string | undefined);
    await showDaemonStatus(cleoDir, process.cwd());
  },
});
