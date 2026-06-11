/**
 * CLI web command — batteries-included Studio entry-point (T11980) and
 * web UI server lifecycle management.
 *
 * ## Batteries-included behaviour (T11980)
 *
 * Running bare `cleo web` (no subcommand):
 *   1. Ensures the daemon gateway is up (auto-starts `cleo daemon serve` as a
 *      DETACHED child if unreachable — respects `daemon.autoStart` config).
 *   2. Opens the Studio URL in the default browser (`xdg-open` / `open` / `start`).
 *   3. Prints the URL regardless; if Studio assets are absent in this install
 *      (T11979 ships them — in a parallel lane), prints a one-line note.
 *      NEVER touches static-asset serving code (T11979 owns that territory).
 *
 * NEVER activates the systemd cleo-daemon.service unit — auto-start here is
 * spawn-on-demand only.
 *
 * ## Existing subcommands (unchanged)
 *   cleo web start    — launch the Studio server via subsystem start()
 *   cleo web stop     — shut it down via subsystem shutdown()
 *   cleo web restart  — stop then start through the subsystem
 *   cleo web status   — show PID / port / URL via getWebStatus()
 *   cleo web open     — open the browser to the running UI
 *
 * @task T11980 — batteries-included cleo web root action
 * @task T11506 R6-T1
 * @task T11507 R6-T2
 * @task T11257 R6 — migrate web command → daemon subsystem
 * @epic T11243
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError } from '@cleocode/core';
import { defineCommand } from 'citty';
import {
  GATEWAY_DEFAULT_HOST,
  GATEWAY_DEFAULT_PORT,
  shouldAutoStartGateway,
  spawnGatewayIfDown,
} from '../lib/gateway-auto-start.js';
import { cliOutput } from '../renderers/index.js';
import {
  createWebSubsystem,
  getWebPaths,
  getWebStatus,
  WEB_DEFAULT_HOST,
  WEB_DEFAULT_PORT,
} from '../web-subsystem.js';

// ---------------------------------------------------------------------------
// Studio URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the Studio URL for the gateway.
 *
 * The gateway serves Studio assets at the root path (T11979 ships the bundle).
 * We point the browser at the root; if the bundle is not present the gateway
 * returns a 404 and we print a note — but the URL is correct either way.
 *
 * @param port - Gateway port (default 7777).
 * @param host - Gateway host (default 127.0.0.1).
 * @returns The Studio URL string.
 */
export function buildStudioUrl(port: number, host: string): string {
  return `http://${host}:${port}`;
}

/**
 * Open a URL in the system default browser.
 *
 * Platform dispatch:
 *  - Linux  → `xdg-open`
 *  - macOS  → `open`
 *  - win32  → `cmd /c start`
 *
 * Never throws — a spawn failure (opener missing) is silently swallowed; the
 * caller MUST print the URL to stderr/stdout for the user regardless.
 *
 * @param url - The URL to open.
 */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'linux') {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
    // Other platforms (FreeBSD, etc.) — no opener; the printed URL suffices.
  } catch {
    // Opener unavailable or spawn failed — the caller already printed the URL.
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** cleo web start — launch the CLEO Studio server via the daemon subsystem */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start the web server' },
  args: {
    port: {
      type: 'string',
      description: 'Server port',
      default: String(WEB_DEFAULT_PORT),
    },
    host: {
      type: 'string',
      description: 'Server host',
      default: WEB_DEFAULT_HOST,
    },
  },
  async run({ args }) {
    try {
      const port = Number.parseInt(args.port, 10);
      const host = args.host;
      const subsystem = createWebSubsystem({ port, host });
      const ctx = await subsystem.start();
      const { logFile } = getWebPaths();
      cliOutput(
        {
          pid: ctx.pid,
          port: ctx.port,
          host: ctx.host,
          url: `http://${ctx.host}:${ctx.port}`,
          logFile,
        },
        { command: 'web', message: `CLEO Web UI running on port ${ctx.port}` },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo web stop — gracefully shut down the running server via the daemon subsystem */
const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop the web server' },
  async run() {
    try {
      const { pidFile, logFile } = getWebPaths();
      const status = await getWebStatus();

      if (!status.running || status.pid === null) {
        await rm(pidFile, { force: true });
        cliOutput({ running: false }, { command: 'web', message: 'Server is not running' });
        return;
      }

      // Synthesise the context from live state and delegate to subsystem shutdown.
      // This reuses the SIGTERM → SIGKILL escalation logic from the subsystem
      // without re-spawning a new process.
      const subsystem = createWebSubsystem({
        port: status.port ?? WEB_DEFAULT_PORT,
        host: status.host ?? WEB_DEFAULT_HOST,
      });
      await subsystem.shutdown({
        pid: status.pid,
        pidFile,
        logFile,
        port: status.port ?? WEB_DEFAULT_PORT,
        host: status.host ?? WEB_DEFAULT_HOST,
      });

      cliOutput({ stopped: true }, { command: 'web', message: 'CLEO Web UI stopped' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo web restart — stop then start via the subsystem */
const restartCommand = defineCommand({
  meta: { name: 'restart', description: 'Restart the web server' },
  args: {
    port: {
      type: 'string',
      description: 'Server port',
      default: String(WEB_DEFAULT_PORT),
    },
    host: {
      type: 'string',
      description: 'Server host',
      default: WEB_DEFAULT_HOST,
    },
  },
  async run({ args }) {
    try {
      const port = Number.parseInt(args.port, 10);
      const host = args.host;
      const { pidFile, logFile } = getWebPaths();
      const status = await getWebStatus();

      // Stop the existing process if running.
      if (status.running && status.pid !== null) {
        const stopSubsystem = createWebSubsystem({
          port: status.port ?? port,
          host: status.host ?? host,
        });
        await stopSubsystem.shutdown({
          pid: status.pid,
          pidFile,
          logFile,
          port: status.port ?? port,
          host: status.host ?? host,
        });
      }

      // Start fresh via the subsystem.
      const startSubsystem = createWebSubsystem({ port, host });
      const ctx = await startSubsystem.start();

      cliOutput(
        {
          pid: ctx.pid,
          port: ctx.port,
          host: ctx.host,
          url: `http://${ctx.host}:${ctx.port}`,
          logFile,
        },
        { command: 'web', message: `CLEO Web UI running on port ${ctx.port}` },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo web status — show PID, port, host, and URL */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Check server status' },
  async run() {
    try {
      const status = await getWebStatus();
      cliOutput(status, { command: 'web' });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo web open — open the browser to the running UI */
const openCommand = defineCommand({
  meta: { name: 'open', description: 'Open browser to the UI' },
  async run() {
    try {
      const status = await getWebStatus();
      if (!status.running || !status.url) {
        throw new CleoError(
          ExitCode.GENERAL_ERROR,
          'Web server is not running. Start with: cleo web start',
        );
      }

      const url = status.url;
      openBrowser(url);
      cliOutput({ url }, { command: 'web', message: `Open browser to: ${url}` });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// Root command group
// ---------------------------------------------------------------------------

/**
 * Native citty command group for CLEO Web UI server management.
 *
 * ## Root behaviour (T11980 batteries-included)
 *
 * `cleo web` with NO subcommand:
 *   1. Ensures the daemon gateway is up (auto-starts as a detached child when
 *      `daemon.autoStart` is not `false` in the project config).
 *   2. Opens `http://<host>:<port>` in the default browser.
 *   3. Always prints the URL. If Studio assets are not present in this install
 *      (T11979 ships them in a parallel lane), prints a one-liner note.
 *
 * NEVER activates the systemd cleo-daemon.service unit.
 *
 * ## Subcommands (unchanged)
 * start, stop, restart, status, open.
 *
 * @task T11980
 * @task T4551 / T623 / T717
 * @epic T4545
 */
export const webCommand = defineCommand({
  meta: { name: 'web', description: 'Open CLEO Studio in the browser (starts gateway on demand)' },
  args: {
    port: {
      type: 'string',
      description: `Gateway port (default ${GATEWAY_DEFAULT_PORT})`,
    },
    host: {
      type: 'string',
      description: `Gateway host (default ${GATEWAY_DEFAULT_HOST})`,
    },
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    status: statusCommand,
    open: openCommand,
  },
  async run({ cmd, rawArgs, args }) {
    // Delegate to subcommands when a subcommand name is present.
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;

    // ---------------------------------------------------------------------------
    // Batteries-included: ensure gateway up, then open Studio in the browser.
    // ---------------------------------------------------------------------------
    const portArg = args.port as string | undefined;
    const hostArg = args.host as string | undefined;
    const port =
      portArg !== undefined && portArg.length > 0
        ? Number.parseInt(portArg, 10)
        : GATEWAY_DEFAULT_PORT;
    const host = hostArg ?? GATEWAY_DEFAULT_HOST;

    // Read daemon.autoStart from config (tolerantly — default true).
    let autoStart = true;
    try {
      const { getRawConfig } = await import('@cleocode/core');
      const cfg = await getRawConfig();
      autoStart = shouldAutoStartGateway(cfg as Record<string, unknown> | undefined);
    } catch {
      // Config unavailable — proceed with default.
    }

    const studioUrl = buildStudioUrl(port, host);

    if (autoStart) {
      // Spawn gateway on demand; ignore failures (we always print the URL).
      await spawnGatewayIfDown({ port, host });
    }

    // Open the browser — always, even if gateway is not reachable.
    openBrowser(studioUrl);

    // Print the URL to stderr so it is visible regardless of --output mode.
    // Agents reading stdout still get a clean LAFS envelope; humans at a
    // terminal see the URL on stderr. stdout-write-allowed: web command URL
    // print (T11980 batteries-included surface).
    process.stderr.write(`Opening Studio: ${studioUrl}\n`);

    // Note about Studio assets: T11979 ships the static bundle in a parallel
    // lane. If it is not yet merged, the gateway returns a 404 at the root.
    // We do NOT check for the bundle here — that is T11979's concern.
    // Print a one-line note so the user knows what to expect.
    process.stderr.write(
      '  Note: Studio static bundle ships in T11979 (parallel lane).\n' +
        '  If the page is blank, the bundle may not yet be deployed in this install.\n',
    );

    cliOutput(
      { url: studioUrl, port, host, gatewayAutoStart: autoStart },
      { command: 'web', message: `Studio URL: ${studioUrl}` },
    );
  },
});
