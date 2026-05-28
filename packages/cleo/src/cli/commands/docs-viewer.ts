/**
 * CLI: `cleo docs serve | open | stop | viewer-status`.
 *
 * Wires the {@link startViewer} server + pidfile helpers behind the four
 * subcommands required by T9646. Subcommands are registered into the existing
 * `cleo docs` command surface in `commands/docs.ts`.
 *
 * @epic T9631
 * @task T9646 — `cleo docs serve` local viewer
 * @task T9720 — HTTP server with slug-based routing
 * @task T9721 — `cleo docs open` + `cleo docs stop` + `cleo docs viewer-status`
 * @task T9722 — port allocation 7777 → 7800
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { open as fsOpen } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import { getCleoHome, getProjectRoot } from '@cleocode/core';
import { defineCommand } from 'citty';
import {
  isProcessAlive,
  readViewerPidFile,
  removeViewerPidFile,
  type ViewerPidRecord,
  viewerPidFilePath,
  writeViewerPidFile,
} from '../../viewer/pidfile.js';
import { startViewer } from '../../viewer/server.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

/**
 * Sentinel env var set on the detached child so the foreground `serve` code
 * path knows to skip re-detaching and stay in the foreground forever.
 */
const DETACHED_CHILD_ENV = 'CLEO_VIEWER_DETACHED_CHILD';

/**
 * Resolve the path to the `cleo` bin shim that this process was launched
 * from. Used to re-spawn ourselves as a detached child for `--detach`.
 */
function getCleoBinPath(): string {
  // The compiled CLI lives at packages/cleo/dist/cli/index.js. The bin shim at
  // packages/cleo/bin/cleo.js wraps it. We re-spawn the dist entry directly
  // (no need for the wrapper's extra `execFileSync` hop).
  const thisFile = fileURLToPath(import.meta.url);
  // dist/cli/commands/docs-viewer.js → ../../cli/index.js
  return join(thisFile, '..', '..', 'index.js');
}

/** Wait up to `timeoutMs` for `pid` to exit. Returns true if it exited. */
async function waitForExit(pid: number, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return !isProcessAlive(pid);
}

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

/**
 * Spawn a backgrounded copy of `cleo docs serve` and return the child handle.
 * The detached child re-enters `serveCommand.run` and (because the env-sentinel
 * is set) skips the re-detach branch.
 */
async function spawnDetachedServer(opts: {
  startPort: number;
  endPort: number;
  host: string;
  noAutoPort: boolean;
}): Promise<ChildProcess> {
  const logFile = join(getCleoHome(), 'viewer.log');
  const handle = await fsOpen(logFile, 'a').catch(() => null);
  const stdio: ('ignore' | number)[] = handle
    ? ['ignore', handle.fd, handle.fd]
    : ['ignore', 'ignore', 'ignore'];

  const args = [
    getCleoBinPath(),
    'docs',
    'serve',
    '--port',
    String(opts.startPort),
    '--end-port',
    String(opts.endPort),
    '--host',
    opts.host,
  ];
  if (opts.noAutoPort) args.push('--no-auto-port');

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio,
    env: { ...process.env, [DETACHED_CHILD_ENV]: '1' },
    cwd: getProjectRoot(),
  });
  child.unref();
  if (handle) await handle.close();
  return child;
}

/**
 * `cleo docs serve` — start the viewer HTTP server.
 *
 * In foreground mode the process blocks until SIGINT/SIGTERM.
 * In `--detach` mode the parent spawns a detached child, waits for the
 * child to bind (via health-probe), persists the pidfile, and exits.
 */
const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: '[legacy] Run docs viewer — prefer `cleo docs viewer start`',
  },
  args: {
    port: {
      type: 'string',
      description: 'Starting port (default 7777)',
      default: '7777',
    },
    'end-port': {
      type: 'string',
      description: 'Last port to try when auto-incrementing (default 7800)',
      default: '7800',
    },
    host: {
      type: 'string',
      description: 'Bind host (default 127.0.0.1)',
      default: '127.0.0.1',
    },
    'no-auto-port': {
      type: 'boolean',
      description: 'Disable auto-increment when start port is busy',
      default: false,
    },
    detach: {
      type: 'boolean',
      description: 'Run in background; write pid to viewer.pid; exit immediately',
      default: false,
    },
  },
  async run({ args }) {
    const startPort = Number.parseInt(String(args.port), 10);
    const endPort = Number.parseInt(String(args['end-port']), 10);
    const host = String(args.host);
    const noAutoPort = Boolean(args['no-auto-port']);
    const detach = Boolean(args.detach);
    const isDetachedChild = process.env[DETACHED_CHILD_ENV] === '1';

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

    if (detach && !isDetachedChild) {
      // Parent path: spawn child, wait for health, write pidfile.
      const existing = await readViewerPidFile();
      if (existing && isProcessAlive(existing.pid)) {
        cliOutput(
          {
            running: true,
            pid: existing.pid,
            port: existing.port,
            host: existing.host,
            url: `http://${existing.host}:${existing.port}`,
            pidFile: viewerPidFilePath(),
          },
          {
            command: 'docs serve',
            operation: 'docs.serve',
            message: `viewer already running on http://${existing.host}:${existing.port}`,
          },
        );
        return;
      }

      const child = await spawnDetachedServer({ startPort, endPort, host, noAutoPort });
      if (!child.pid) {
        cliError('failed to spawn detached viewer process', ExitCode.GENERAL_ERROR, {
          name: 'E_SPAWN_FAILED',
        });
        return;
      }

      // Poll for the child's bound port by reading the pidfile it writes once
      // it has called listen(). Grace period: 10s.
      let record: ViewerPidRecord | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        record = await readViewerPidFile();
        if (record && record.pid === child.pid) break;
        if (!isProcessAlive(child.pid)) {
          cliError(
            'detached viewer exited before binding (check ~/.local/share/cleo/viewer.log)',
            ExitCode.GENERAL_ERROR,
            { name: 'E_VIEWER_EXITED' },
          );
          return;
        }
      }
      if (!record || record.pid !== child.pid) {
        cliError('timed out waiting for detached viewer to bind', ExitCode.GENERAL_ERROR, {
          name: 'E_VIEWER_TIMEOUT',
        });
        return;
      }
      cliOutput(
        {
          running: true,
          pid: record.pid,
          port: record.port,
          host: record.host,
          url: `http://${record.host}:${record.port}`,
          pidFile: viewerPidFilePath(),
        },
        {
          command: 'docs serve',
          operation: 'docs.serve',
          message: `viewer started on http://${record.host}:${record.port}`,
        },
      );
      return;
    }

    // Foreground path: bind, optionally write pidfile (always when detached
    // child, optional otherwise), block until SIGINT/SIGTERM.
    let handle: Awaited<ReturnType<typeof startViewer>>;
    try {
      handle = await startViewer({
        startPort,
        endPort,
        host,
        autoIncrement: !noAutoPort,
      });
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

    const record: ViewerPidRecord = {
      pid: process.pid,
      port: handle.port,
      host: handle.host,
      projectRoot: getProjectRoot(),
      startedAt: Date.now(),
    };
    await writeViewerPidFile(record);

    const url = `http://${handle.host}:${handle.port}`;
    if (isDetachedChild) {
      // Detached child: stay quiet on stdout (parent already printed) — log
      // file captures the rest. Just keep the loop alive.
    } else {
      humanInfo(`viewer listening on ${url} (Ctrl+C to stop)`);
      cliOutput(
        {
          running: true,
          pid: record.pid,
          port: record.port,
          host: record.host,
          url,
          pidFile: viewerPidFilePath(),
        },
        {
          command: 'docs serve',
          operation: 'docs.serve',
          message: `viewer running on ${url}`,
        },
      );
    }

    const shutdown = async (signal: NodeJS.Signals) => {
      handle.server.close();
      await removeViewerPidFile();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // Foreground mode (incl. detached child) — keep node running. server.close
    // events resolve the promise below so we still exit cleanly if the kernel
    // forcibly closes the listener.
    await new Promise<void>((res) => handle.server.on('close', res));
    await removeViewerPidFile();
  },
});

/**
 * `cleo docs open <slug>` — open the browser to a doc URL, auto-starting the
 * viewer in detached mode when no instance is running.
 */
const openCommand = defineCommand({
  meta: {
    name: 'open',
    description: '[legacy] Open docs viewer in browser — prefer `cleo docs viewer open`',
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
      default: '7777',
    },
    'end-port': {
      type: 'string',
      description: 'Last port to try (default 7800)',
      default: '7800',
    },
    host: {
      type: 'string',
      description: 'Bind host (default 127.0.0.1)',
      default: '127.0.0.1',
    },
    'no-launch': {
      type: 'boolean',
      description: 'Skip browser launch; just print the URL',
      default: false,
    },
  },
  async run({ args }) {
    const slug = args.slug ? String(args.slug) : undefined;
    let record = await readViewerPidFile();
    if (record && !isProcessAlive(record.pid)) {
      await removeViewerPidFile();
      record = null;
    }
    if (!record) {
      const startPort = Number.parseInt(String(args.port), 10);
      const endPort = Number.parseInt(String(args['end-port']), 10);
      const host = String(args.host);
      const child = await spawnDetachedServer({
        startPort,
        endPort,
        host,
        noAutoPort: false,
      });
      if (!child.pid) {
        cliError('failed to spawn detached viewer process', ExitCode.GENERAL_ERROR, {
          name: 'E_SPAWN_FAILED',
        });
        return;
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        record = await readViewerPidFile();
        if (record && record.pid === child.pid) break;
        if (!isProcessAlive(child.pid)) {
          cliError(
            'detached viewer exited before binding (check ~/.local/share/cleo/viewer.log)',
            ExitCode.GENERAL_ERROR,
            { name: 'E_VIEWER_EXITED' },
          );
          return;
        }
      }
      if (!record) {
        cliError('timed out waiting for viewer to bind', ExitCode.GENERAL_ERROR, {
          name: 'E_VIEWER_TIMEOUT',
        });
        return;
      }
    }

    const url = slug
      ? `http://${record.host}:${record.port}/docs/${encodeURIComponent(slug)}`
      : `http://${record.host}:${record.port}/`;

    if (!args['no-launch']) {
      openInBrowser(url);
    }

    cliOutput(
      {
        opened: true,
        slug: slug ?? null,
        pid: record.pid,
        port: record.port,
        host: record.host,
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

/** `cleo docs stop` — SIGTERM the viewer pid and clean up the pidfile. */
const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: '[legacy] Stop the docs viewer — prefer `cleo docs viewer stop`',
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

    try {
      process.kill(record.pid, 'SIGTERM');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ESRCH') {
        cliError(
          `failed to signal viewer pid ${record.pid}: ${e.message ?? e.code}`,
          ExitCode.GENERAL_ERROR,
          { name: 'E_SIGNAL_FAILED' },
        );
        return;
      }
    }

    const timeoutSec = Math.max(1, Number.parseInt(String(args.timeout), 10) || 10);
    const exited = await waitForExit(record.pid, timeoutSec * 1000);
    if (!exited) {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await removeViewerPidFile();

    cliOutput(
      {
        stopped: true,
        pid: record.pid,
        graceful: exited,
      },
      {
        command: 'docs stop',
        operation: 'docs.stop',
        message: exited
          ? `viewer (pid ${record.pid}) stopped gracefully`
          : `viewer (pid ${record.pid}) force-killed after ${timeoutSec}s`,
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
    description: '[legacy] Report viewer state — prefer `cleo docs viewer status`',
  },
  async run() {
    await runViewerStatus();
  },
});

const runViewerStatus = async (): Promise<void> => {
  const record = await readViewerPidFile();
  if (!record) {
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
  const alive = isProcessAlive(record.pid);
  if (!alive) {
    await removeViewerPidFile();
    cliOutput(
      {
        running: false,
        reason: 'stale pidfile',
        pid: record.pid,
        pidFile: viewerPidFilePath(),
      },
      {
        command: 'docs viewer-status',
        operation: 'docs.viewer-status',
        message: `stale pidfile removed (pid ${record.pid} not alive)`,
      },
    );
    return;
  }
  cliOutput(
    {
      running: true,
      pid: record.pid,
      port: record.port,
      host: record.host,
      projectRoot: record.projectRoot,
      startedAt: record.startedAt,
      uptimeMs: Date.now() - record.startedAt,
      url: `http://${record.host}:${record.port}`,
      pidFile: viewerPidFilePath(),
    },
    {
      command: 'docs viewer-status',
      operation: 'docs.viewer-status',
      message: `viewer running (pid ${record.pid})`,
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
