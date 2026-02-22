/**
 * CLI web command - manage CLEO Web UI server lifecycle.
 * Ported from scripts/web.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome } from '../../core/paths.js';

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

    if (isNaN(pid) || !isProcessRunning(pid)) {
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
  const webCmd = program
    .command('web')
    .description('Manage CLEO Web UI server');

  webCmd
    .command('start')
    .description('Start the web server')
    .option('--port <port>', 'Server port', String(DEFAULT_PORT))
    .option('--host <host>', 'Server host', DEFAULT_HOST)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const port = parseInt(opts['port'] as string, 10);
        const host = opts['host'] as string;
        const { pidFile, configFile, logFile } = getWebPaths();

        // Check if already running
        const status = await getStatus();
        if (status.running) {
          throw new CleoError(ExitCode.GENERAL_ERROR, `Server already running (PID: ${status.pid})`);
        }

        // Resolve MCP server location — uses src/mcp/ from the main @cleocode/cleo package
        const projectRoot = process.env['CLEO_ROOT'] ?? process.cwd();
        const distMcpDir = join(projectRoot, 'dist', 'mcp');

        // Ensure log directory exists
        await mkdir(join(getCleoHome(), 'logs'), { recursive: true });

        // Save config
        await writeFile(configFile, JSON.stringify({
          port,
          host,
          startedAt: new Date().toISOString(),
        }));

        // Check if MCP server is built (dist/mcp/index.js from @cleocode/cleo)
        const webIndexPath = join(distMcpDir, 'index.js');
        try {
          await stat(webIndexPath);
        } catch {
          // Need to build
          try {
            execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'ignore' });
          } catch {
            throw new CleoError(ExitCode.GENERAL_ERROR, `Build failed. Check logs: ${logFile}`);
          }
        }

        // Start server
        const serverProcess = spawn('node', [webIndexPath], {
          cwd: projectRoot,
          env: {
            ...process.env,
            CLEO_WEB_PORT: String(port),
            CLEO_WEB_HOST: host,
          },
          detached: true,
          stdio: 'ignore',
        });

        serverProcess.unref();
        await writeFile(pidFile, String(serverProcess.pid));

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
          try { process.kill(serverProcess.pid!); } catch { /* ignore */ }
          await rm(pidFile, { force: true });
          throw new CleoError(ExitCode.GENERAL_ERROR, 'Server failed to start within 15 seconds');
        }

        cliOutput({
          pid: serverProcess.pid,
          port,
          host,
          url: `http://${host}:${port}`,
        }, { command: 'web', message: `CLEO Web UI running on port ${port}` });
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
          cliOutput(
            { running: false },
            { command: 'web', message: 'Server is not running' },
          );
          return;
        }

        // Graceful shutdown
        try { process.kill(status.pid, 'SIGTERM'); } catch { /* ignore */ }

        // Wait for exit
        for (let i = 0; i < 10; i++) {
          if (!isProcessRunning(status.pid)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Force kill if still running
        if (isProcessRunning(status.pid)) {
          try { process.kill(status.pid, 'SIGKILL'); } catch { /* ignore */ }
        }

        await rm(pidFile, { force: true });

        cliOutput(
          { stopped: true },
          { command: 'web', message: 'CLEO Web UI stopped' },
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
          throw new CleoError(ExitCode.GENERAL_ERROR, 'Web server is not running. Start with: cleo web start');
        }

        // Try to open browser
        const url = status.url;
        const platform = process.platform;

        try {
          if (platform === 'linux') {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
          } else if (platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
          }
        } catch {
          // Can't open browser
        }

        cliOutput(
          { url },
          { command: 'web', message: `Open browser to: ${url}` },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
