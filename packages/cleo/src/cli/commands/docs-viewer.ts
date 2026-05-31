/**
 * CLI: `cleo docs serve | open | stop | viewer-status`.
 *
 * **R7 (T11258):** The standalone spawn loop that previously lived in this file
 * has been migrated to `../docs-viewer-subsystem.ts` (`createDocsViewerSubsystem`),
 * which expresses the docs-viewer server as a supervised daemon {@link Subsystem}.
 * This module is now **thin CLI dispatch only** — it reads state and delegates
 * lifecycle actions through the shared helpers exported from the subsystem module.
 *
 * Subcommands are registered into the existing `cleo docs` command surface in
 * `commands/docs.ts`.
 *
 * @epic T9631
 * @task T9646 — `cleo docs serve` local viewer
 * @task T9720 — HTTP server with slug-based routing
 * @task T9721 — `cleo docs open` + `cleo docs stop` + `cleo docs viewer-status`
 * @task T9722 — port allocation 7777 → 7800
 * @task T11508 R7-T1 — standalone spawn loop deleted; subsystem created
 * @task T11509 R7-T2 — CLI delegating to subsystem
 * @epic T11258 R7 — migrate docs-viewer.ts → daemon subsystem
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { spawn } from 'node:child_process';
import { ExitCode } from '@cleocode/contracts';
import { defineCommand } from 'citty';
import {
  isProcessAlive,
  readViewerPidFile,
  removeViewerPidFile,
  viewerPidFilePath,
} from '../../viewer/pidfile.js';
import {
  createDocsViewerSubsystem,
  getViewerPaths,
  getViewerStatus,
  VIEWER_DEFAULT_END_PORT,
  VIEWER_DEFAULT_HOST,
  VIEWER_DEFAULT_PORT,
} from '../docs-viewer-subsystem.js';
import { cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Open the system default browser at `url`. Best-effort, never throws. */
function openInBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* swallow — caller has already printed the URL */
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * `cleo docs serve` — start the viewer HTTP server via the daemon subsystem.
 *
 * Delegates to `createDocsViewerSubsystem().start()`. The standalone spawn
 * loop has been removed (R7 · T11508).
 */
const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Run docs viewer — prefer `cleo docs viewer start`',
  },
  args: {
    port: {
      type: 'string',
      description: 'Starting port (default 7777)',
      default: String(VIEWER_DEFAULT_PORT),
    },
    'end-port': {
      type: 'string',
      description: 'Last port to try when auto-incrementing (default 7800)',
      default: String(VIEWER_DEFAULT_END_PORT),
    },
    host: {
      type: 'string',
      description: 'Bind host (default 127.0.0.1)',
      default: VIEWER_DEFAULT_HOST,
    },
    'no-auto-port': {
      type: 'boolean',
      description: 'Disable auto-increment when start port is busy',
      default: false,
    },
  },
  async run({ args }) {
    const startPort = Number.parseInt(String(args.port), 10);
    const endPort = Number.parseInt(String(args['end-port']), 10);
    const host = String(args.host);
    const noAutoPort = Boolean(args['no-auto-port']);

    if (!Number.isFinite(startPort) || startPort < 1 || startPort > 65535) {
      cliError(`invalid --port: ${args.port}`, ExitCode.VALIDATION_ERROR, { name: 'E_VALIDATION' });
      return;
    }
    if (!Number.isFinite(endPort) || endPort < startPort) {
      cliError(`invalid --end-port: ${args['end-port']}`, ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return;
    }

    try {
      const subsystem = createDocsViewerSubsystem({ startPort, endPort, host, noAutoPort });
      const ctx = await subsystem.start();
      const { pidFile } = getViewerPaths();
      cliOutput(
        {
          running: true,
          pid: ctx.pid,
          port: ctx.port,
          host: ctx.host,
          url: `http://${ctx.host}:${ctx.port}`,
          pidFile,
        },
        {
          command: 'docs serve',
          operation: 'docs.serve',
          message: `viewer started on http://${ctx.host}:${ctx.port}`,
        },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'E_NO_PORT' || e.code === 'EADDRINUSE') {
        cliError(e.message ?? `port ${startPort} unavailable`, ExitCode.GENERAL_ERROR, {
          name: e.code === 'E_NO_PORT' ? 'E_NO_PORT' : 'EADDRINUSE',
        });
        return;
      }
      throw err;
    }
  },
});

/**
 * `cleo docs open <slug>` — open the browser to a doc URL, auto-starting the
 * viewer via the subsystem when no instance is running.
 */
const openCommand = defineCommand({
  meta: {
    name: 'open',
    description: 'Open docs viewer in browser — prefer `cleo docs viewer open`',
  },
  args: {
    slug: {
      type: 'positional',
      description: 'Doc slug to open (omit to open the viewer home page)',
      required: false,
    },
    port: {
      type: 'string',
      description: 'Starting port for the viewer (default 7777)',
      default: String(VIEWER_DEFAULT_PORT),
    },
    'end-port': {
      type: 'string',
      description: 'Last port to try (default 7800)',
      default: String(VIEWER_DEFAULT_END_PORT),
    },
    host: {
      type: 'string',
      description: 'Bind host (default 127.0.0.1)',
      default: VIEWER_DEFAULT_HOST,
    },
    'no-launch': {
      type: 'boolean',
      description: 'Skip browser launch; just print the URL',
      default: false,
    },
  },
  async run({ args }) {
    const slug = args.slug ? String(args.slug) : undefined;

    // Check if viewer is already running; start it via subsystem if not.
    let status = await getViewerStatus();
    if (!status.running) {
      const startPort = Number.parseInt(String(args.port), 10);
      const endPort = Number.parseInt(String(args['end-port']), 10);
      const host = String(args.host);
      try {
        const subsystem = createDocsViewerSubsystem({ startPort, endPort, host });
        await subsystem.start();
        status = await getViewerStatus();
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        cliError(e.message ?? 'failed to start docs viewer', ExitCode.GENERAL_ERROR, {
          name: 'E_VIEWER_START_FAILED',
        });
        return;
      }
    }

    if (!status.running || status.pid === null || status.port === null || status.host === null) {
      cliError('timed out waiting for viewer to bind', ExitCode.GENERAL_ERROR, {
        name: 'E_VIEWER_TIMEOUT',
      });
      return;
    }

    const url = slug
      ? `http://${status.host}:${status.port}/docs/${encodeURIComponent(slug)}`
      : `http://${status.host}:${status.port}/`;

    if (!args['no-launch']) {
      openInBrowser(url);
    }

    cliOutput(
      {
        opened: true,
        slug: slug ?? null,
        pid: status.pid,
        port: status.port,
        host: status.host,
        url,
      },
      {
        command: 'docs open',
        operation: 'docs.open',
        message: `opened ${url}`,
      },
    );
  },
});

/**
 * `cleo docs stop` — SIGTERM the viewer via the subsystem and clean up the
 * pidfile.
 */
const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the docs viewer — prefer `cleo docs viewer stop`',
  },
  args: {
    timeout: {
      type: 'string',
      description: 'Grace period in seconds before SIGKILL (default 10)',
      default: '10',
    },
  },
  async run({ args }) {
    const record = await readViewerPidFile();
    if (!record) {
      cliOutput(
        { stopped: false, reason: 'no pidfile' },
        {
          command: 'docs stop',
          operation: 'docs.stop',
          message: 'viewer not running (no pidfile)',
        },
      );
      return;
    }
    if (!isProcessAlive(record.pid)) {
      await removeViewerPidFile();
      cliOutput(
        { stopped: false, reason: 'stale pidfile', pid: record.pid },
        {
          command: 'docs stop',
          operation: 'docs.stop',
          message: `stale pidfile removed (pid ${record.pid} not alive)`,
        },
      );
      return;
    }

    // Delegate to subsystem shutdown for the SIGTERM → SIGKILL escalation.
    const { pidFile } = getViewerPaths();
    const subsystem = createDocsViewerSubsystem({
      startPort: record.port,
      host: record.host,
    });
    await subsystem.shutdown({
      pid: record.pid,
      pidFile,
      port: record.port,
      host: record.host,
    });

    const timeoutSec = Math.max(1, Number.parseInt(String(args.timeout), 10) || 10);
    cliOutput(
      {
        stopped: true,
        pid: record.pid,
        graceful: true,
        timeoutSec,
      },
      {
        command: 'docs stop',
        operation: 'docs.stop',
        message: `viewer (pid ${record.pid}) stopped`,
      },
    );
  },
});

/**
 * `cleo docs viewer-status` — report whether the viewer is running and its
 * pid/port/url.
 */
const viewerStatusCommand = defineCommand({
  meta: {
    name: 'viewer-status',
    description: 'Report viewer state — prefer `cleo docs viewer status`',
  },
  async run() {
    await runViewerStatus();
  },
});

const runViewerStatus = async (): Promise<void> => {
  const status = await getViewerStatus();
  if (!status.running || status.pid === null) {
    cliOutput(
      { running: false, pidFile: viewerPidFilePath() },
      {
        command: 'docs viewer-status',
        operation: 'docs.viewer-status',
        message: 'viewer not running',
      },
    );
    return;
  }
  cliOutput(
    {
      running: true,
      pid: status.pid,
      port: status.port,
      host: status.host,
      url: status.url,
      pidFile: viewerPidFilePath(),
    },
    {
      command: 'docs viewer-status',
      operation: 'docs.viewer-status',
      message: `viewer running (pid ${status.pid})`,
    },
  );
};

/**
 * `cleo docs viewer` — unified managed lifecycle for the docs viewer.
 *
 * Subcommands: start, stop, open, status.
 * Default (no subcommand): shows status.
 *
 * @saga T10516
 * @task T11135 — flatten viewer surface into single managed lifecycle
 */
const viewerCommand = defineCommand({
  meta: {
    name: 'viewer',
    description: 'Manage the docs web viewer lifecycle (start/stop/open/status)',
  },
  subCommands: {
    start: serveCommand,
    stop: stopCommand,
    open: openCommand,
    status: viewerStatusCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await runViewerStatus();
  },
});

export const docsViewerSubcommands = {
  serve: serveCommand,
  open: openCommand,
  stop: stopCommand,
  'viewer-status': viewerStatusCommand,
  viewer: viewerCommand,
};
