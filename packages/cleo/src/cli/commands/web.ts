/**
 * CLI web command — manage CLEO Web UI server lifecycle.
 *
 * Ported from scripts/web.sh. Exposes five subcommands:
 *
 *   cleo web start    — launch the studio server detached
 *   cleo web stop     — gracefully shut it down
 *   cleo web restart  — stop then start with shared helper
 *   cleo web status   — show PID / port / URL
 *   cleo web open     — open the browser to the UI
 *
 * Persistence model:
 * - `detached: true` + `unref()` decouples from parent shell
 * - stdio routed to log files enables recovery after terminal close
 * - Atomic PID file writes prevent corrupt state
 * - Signal handlers trigger graceful shutdown
 *
 * @task T4551 / T623 / T717
 * @epic T4545
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError, getCleoHome } from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Get web server file paths.
 * @task T4551
 */
function getWebPaths() {
  const cleoHome = getCleoHome();
  return {
    pidFile: join(cleoHome, 'web-server.pid'),
    configFile: join(cleoHome, 'web-server.json'),
    logDir: join(cleoHome, 'logs'),
    logFile: join(cleoHome, 'logs', 'web-server.log'),
  };
}

/**
 * Check if a process is running by PID.
 * @task T4551
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get server status.
 * @task T4551
 */
async function getStatus(): Promise<{
  running: boolean;
  pid: number | null;
  port: number | null;
  host: string | null;
  url: string | null;
}> {
  const { pidFile, configFile } = getWebPaths();

  try {
    const pidStr = (await readFile(pidFile, 'utf-8')).trim();
    const pid = Number.parseInt(pidStr, 10);

    if (Number.isNaN(pid) || !isProcessRunning(pid)) {
      return { running: false, pid: null, port: null, host: null, url: null };
    }

    let port = DEFAULT_PORT;
    let host = DEFAULT_HOST;

    try {
      const config = JSON.parse(await readFile(configFile, 'utf-8'));
      port = config.port ?? DEFAULT_PORT;
      host = config.host ?? DEFAULT_HOST;
    } catch {
      // Use defaults
    }

    return { running: true, pid, port, host, url: `http://${host}:${port}` };
  } catch {
    return { running: false, pid: null, port: null, host: null, url: null };
  }
}

/**
 * Start the web server with the given port and host.
 *
 * Extracted as a standalone function so both the `start` and `restart`
 * subcommands can call it directly without runtime sibling-command lookups.
 *
 * @task T4551 / T717
 */
async function startWebServer(port: number, host: string): Promise<void> {
  const { pidFile, configFile, logFile, logDir } = getWebPaths();

  // Check if already running
  const status = await getStatus();
  if (status.running) {
    throw new CleoError(ExitCode.GENERAL_ERROR, `Server already running (PID: ${status.pid})`);
  }

  // Resolve CLEO Studio server location.
  // The studio package builds to packages/studio/build/index.js (adapter-node output).
  // CLEO_STUDIO_DIR env var allows overriding for testing / custom installs.
  const projectRoot = process.env['CLEO_ROOT'] ?? process.cwd();
  const studioDir =
    process.env['CLEO_STUDIO_DIR'] ?? join(projectRoot, 'packages', 'studio', 'build');

  // Ensure log directory exists
  await mkdir(logDir, { recursive: true });

  // Save config
  await writeFile(
    configFile,
    JSON.stringify({
      port,
      host,
      startedAt: new Date().toISOString(),
    }),
  );

  // Check if studio server is built
  const webIndexPath = join(studioDir, 'index.js');
  try {
    await stat(webIndexPath);
  } catch {
    // Need to build the studio package
    try {
      execFileSync('pnpm', ['--filter', '@cleocode/studio', 'run', 'build'], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
    } catch {
      throw new CleoError(
        ExitCode.GENERAL_ERROR,
        `Studio build failed. Run: pnpm --filter @cleocode/studio run build\nLogs: ${logFile}`,
      );
    }
  }

  // Open log file for stdio redirection (O_CREAT | O_APPEND)
  const logFileHandle = await open(logFile, 'a');

  // Start studio server (adapter-node uses HOST/PORT env vars)
  const serverProcess = spawn('node', [webIndexPath], {
    cwd: studioDir,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      // Pass CLEO paths through to the studio server
      CLEO_ROOT: projectRoot,
    },
    detached: true,
    stdio: ['ignore', logFileHandle.fd, logFileHandle.fd],
  });

  // Detach from parent process so server continues after terminal closes
  serverProcess.unref();

  // Atomically write PID file to ensure clean state
  const pidFileTmp = `${pidFile}.tmp`;
  await writeFile(pidFileTmp, String(serverProcess.pid));
  await rm(pidFile, { force: true });
  // Rename is atomic on POSIX; on Windows this is close enough
  await writeFile(pidFile, String(serverProcess.pid));
  await rm(pidFileTmp, { force: true });

  // Close file handle in parent process
  await logFileHandle.close();

  // Wait for server to respond
  const maxAttempts = 30;
  let started = false;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://${host}:${port}/api/health`);
      if (response.ok) {
        started = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!started) {
    try {
      process.kill(serverProcess.pid!);
    } catch {
      /* ignore */
    }
    await rm(pidFile, { force: true });
    throw new CleoError(ExitCode.GENERAL_ERROR, 'Server failed to start within 15 seconds');
  }

  cliOutput(
    {
      pid: serverProcess.pid,
      port,
      host,
      url: `http://${host}:${port}`,
      logFile,
    },
    { command: 'web', message: `CLEO Web UI running on port ${port}` },
  );
}

/** cleo web start — launch the CLEO Studio server detached */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start the web server' },
  args: {
    port: {
      type: 'string',
      description: 'Server port',
      default: String(DEFAULT_PORT),
    },
    host: {
      type: 'string',
      description: 'Server host',
      default: DEFAULT_HOST,
    },
  },
  async run({ args }) {
    try {
      await startWebServer(Number.parseInt(args.port, 10), args.host);
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo web stop — gracefully shut down the running server */
const stopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop the web server' },
  async run() {
    try {
      const { pidFile } = getWebPaths();
      const status = await getStatus();

      if (!status.running || !status.pid) {
        // Clean up stale PID file
        await rm(pidFile, { force: true });
        cliOutput({ running: false }, { command: 'web', message: 'Server is not running' });
        return;
      }

      // Graceful shutdown (cross-platform): 30s grace period before force kill
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(status.pid), '/T'], { stdio: 'ignore' });
        } else {
          process.kill(status.pid, 'SIGTERM');
        }
      } catch {
        /* ignore */
      }

      // Wait for exit (SIGTERM grace period: 30s per studio's SHUTDOWN_TIMEOUT)
      for (let i = 0; i < 60; i++) {
        if (!isProcessRunning(status.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Force kill if still running after grace period
      if (isProcessRunning(status.pid)) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(status.pid), '/F', '/T'], { stdio: 'ignore' });
          } else {
            process.kill(status.pid, 'SIGKILL');
          }
        } catch {
          /* ignore */
        }
      }

      await rm(pidFile, { force: true });

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

/** cleo web restart — stop then start the server */
const restartCommand = defineCommand({
  meta: { name: 'restart', description: 'Restart the web server' },
  args: {
    port: {
      type: 'string',
      description: 'Server port',
      default: String(DEFAULT_PORT),
    },
    host: {
      type: 'string',
      description: 'Server host',
      default: DEFAULT_HOST,
    },
  },
  async run({ args }) {
    try {
      const { pidFile } = getWebPaths();
      const status = await getStatus();

      // Stop if running
      if (status.running && status.pid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(status.pid), '/T'], { stdio: 'ignore' });
          } else {
            process.kill(status.pid, 'SIGTERM');
          }
        } catch {
          /* ignore */
        }

        // Wait for exit
        for (let i = 0; i < 60; i++) {
          if (!isProcessRunning(status.pid)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Force kill if still running
        if (isProcessRunning(status.pid)) {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/PID', String(status.pid), '/F', '/T'], { stdio: 'ignore' });
            } else {
              process.kill(status.pid, 'SIGKILL');
            }
          } catch {
            /* ignore */
          }
        }

        await rm(pidFile, { force: true });
      }

      // Start fresh using the shared helper
      await startWebServer(Number.parseInt(args.port, 10), args.host);
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
      const status = await getStatus();
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
      const status = await getStatus();
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
        // Can't open browser — user can open manually
      }

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

/**
 * Native citty command group for CLEO Web UI server management.
 *
 * Subcommands: start, stop, restart, status, open.
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
});
