/**
 * CLI web command — manage CLEO Web UI server lifecycle.
 *
 * **R6 (T11257):** The standalone pidfile + spawn loop that previously lived
 * in this file has been migrated to `../web-subsystem.ts` (`createWebSubsystem`),
 * which expresses the Studio server as a supervised daemon {@link Subsystem}.
 * This module is now **thin CLI dispatch only** — it reads state and delegates
 * lifecycle actions through the shared helpers exported from the subsystem module.
 *
 * Subcommands:
 *   cleo web start    — launch the Studio server via subsystem start()
 *   cleo web stop     — shut it down via subsystem shutdown()
 *   cleo web restart  — stop then start through the subsystem
 *   cleo web status   — show PID / port / URL via getWebStatus()
 *   cleo web open     — open the browser to the running UI
 *
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
import { defineCommand, showUsage } from 'citty';
import { cliOutput } from '../renderers/index.js';
import {
  createWebSubsystem,
  getWebPaths,
  getWebStatus,
  WEB_DEFAULT_HOST,
  WEB_DEFAULT_PORT,
} from '../web-subsystem.js';

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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error starting web server: ${msg}`);
      process.exit(ExitCode.GENERAL_ERROR);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error stopping web server: ${msg}`);
      process.exit(ExitCode.GENERAL_ERROR);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error restarting web server: ${msg}`);
      process.exit(ExitCode.GENERAL_ERROR);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error reading web server status: ${msg}`);
      process.exit(ExitCode.GENERAL_ERROR);
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
      const platform = process.platform;

      try {
        if (platform === 'linux') {
          spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else if (platform === 'darwin') {
          spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else if (platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch {
        // Can't open browser — user can open manually.
      }

      cliOutput({ url }, { command: 'web', message: `Open browser to: ${url}` });
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error opening web UI: ${msg}`);
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

// ---------------------------------------------------------------------------
// Root command group
// ---------------------------------------------------------------------------

/**
 * Native citty command group for CLEO Web UI server management.
 *
 * Subcommands: start, stop, restart, status, open.
 *
 * @task T4551 / T623 / T717
 * @epic T4545
 */
export const webCommand = defineCommand({
  meta: { name: 'web', description: 'Manage CLEO Web UI server' },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    status: statusCommand,
    open: openCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
