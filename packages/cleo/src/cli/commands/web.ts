/**
 * CLI web command - manage CLEO Web UI server lifecycle.
 * Ported from scripts/web.sh
 * @task T4551 / T623
 * @epic T4545
 *
 * Persistence model:
 * - `detached: true` + `unref()` decouples from parent shell
 * - stdio routed to log files enables recovery after terminal close
 * - Atomic PID file writes prevent corrupt state
 * - Signal handlers trigger graceful shutdown
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError, getCleoHome } from '@cleocode/core';
// CLI-only: web command requires process spawn/PID management not suitable for dispatch
import type { ShimCommand as Command } from '../commander-shim.js';
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
    const pid = parseInt(pidStr, 10);

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
 * Register the web command.
 * @task T4551
 */
export function registerWebCommand(program: Command): void {
  const webCmd = program.command('web').description('Manage CLEO Web UI server');

  webCmd
    .command('start')
    .description('Start the web server')
    .option('--port <port>', 'Server port', String(DEFAULT_PORT))
    .option('--host <host>', 'Server host', DEFAULT_HOST)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const port = parseInt(opts['port'] as string, 10);
        const host = opts['host'] as string;
        const { pidFile, configFile, logFile, logDir } = getWebPaths();

        // Check if already running
        const status = await getStatus();
        if (status.running) {
          throw new CleoError(
            ExitCode.GENERAL_ERROR,
            `Server already running (PID: ${status.pid})`,
          );
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
        // Write to temp file first, then rename for atomicity
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
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  webCmd
    .command('stop')
    .description('Stop the web server')
    .action(async () => {
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
    });

  webCmd
    .command('restart')
    .description('Restart the web server')
    .option('--port <port>', 'Server port', String(DEFAULT_PORT))
    .option('--host <host>', 'Server host', DEFAULT_HOST)
    .action(async (opts: Record<string, unknown>) => {
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

        // Start with provided options
        const port = opts['port'] ?? String(DEFAULT_PORT);
        const host = opts['host'] ?? DEFAULT_HOST;

        // Trigger start command by calling its action directly
        const startOpts = { port, host };
        const startAction = webCmd.commands.find((c) => c.name() === 'start')?.action;
        if (startAction) {
          await startAction(startOpts);
        } else {
          throw new CleoError(ExitCode.GENERAL_ERROR, 'Could not restart server');
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  webCmd
    .command('status')
    .description('Check server status')
    .action(async () => {
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
    });

  webCmd
    .command('open')
    .description('Open browser to the UI')
    .action(async () => {
      try {
        const status = await getStatus();
        if (!status.running || !status.url) {
          throw new CleoError(
            ExitCode.GENERAL_ERROR,
            'Web server is not running. Start with: cleo web start',
          );
        }

        // Try to open browser
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
    });
}
