/**
 * Web subsystem — expresses the CLEO Studio web server as a supervised daemon
 * {@link Subsystem} via `defineSubsystem()`.
 *
 * This is the **R6 migration target**: the standalone spawn loop that previously
 * lived in `commands/web.ts` is moved here so a `SubsystemRegistry` can drive
 * its `start → healthProbe → shutdown` lifecycle identically to every other
 * long-running concern (the gateway, the GC cron, …).
 *
 * The CLI command (`cleo web start/stop/status/restart`) delegates the heavy
 * lifecycle logic here; the command handlers themselves remain thin citty
 * dispatch. No `@cleocode/cleo` dependency is introduced in this module — it
 * only imports from `@cleocode/contracts`, `@cleocode/core`, and Node built-ins.
 *
 * Context threaded from `start()` into `shutdown()`:
 * - `pid`      — the child process PID for SIGTERM/SIGKILL escalation.
 * - `pidFile`  — path to the atomic PID file for cleanup on shutdown.
 * - `logFile`  — path to the server log (informational).
 *
 * @packageDocumentation
 * @module @cleocode/cleo/cli
 *
 * @task T11506 R6-T1 — create web-subsystem.ts; delete standalone spawn
 * @task T11257 R6 — migrate web command → daemon subsystem
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubsystemHealth, SubsystemState } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/core';
import { defineSubsystem } from '@cleocode/runtime/daemon';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TCP port the Studio web server binds to (preserved from the old web.ts). */
export const WEB_DEFAULT_PORT = 3456;

/** Default bind host (loopback only by default). */
export const WEB_DEFAULT_HOST = '127.0.0.1';

/** Logical subsystem name — matches the supervised `child_id`. */
export const WEB_SUBSYSTEM_NAME = 'cleo-web';

/** Grace-period iterations at 500 ms each (30 s total) before SIGKILL. */
const SIGTERM_GRACE_ITERATIONS = 60;

/** Startup poll iterations at 500 ms each (15 s total). */
const STARTUP_POLL_ITERATIONS = 30;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Studio `build/` directory for the web server.
 *
 * Resolution order (first match wins):
 *
 *  1. `CLEO_STUDIO_DIR` environment variable — explicit override for testing
 *     and advanced deployments.
 *  2. `<cleo-package-root>/studio-dist/` — the bundled build produced by the
 *     monorepo `postbuild` copy step and included in the `@cleocode/cleo` npm
 *     tarball. This is the batteries-included path that works from a plain
 *     `npm install -g @cleocode/cleo` with no repo checkout (T11979).
 *  3. `<project-root>/packages/studio/build` relative to `CLEO_ROOT` / `cwd`
 *     — legacy dev-checkout fallback. Kept for backward compat; the
 *     `postbuild` step is required before `cleo web start` in a dev checkout.
 *
 * @returns The absolute path to the Studio build directory, or `undefined` when
 *   none of the candidates exist on disk.
 */
export function resolveStudioDir(): string | undefined {
  // 1. Explicit override.
  const envOverride = process.env['CLEO_STUDIO_DIR'];
  if (envOverride !== undefined && envOverride.length > 0 && existsSync(envOverride)) {
    return envOverride;
  }

  // 2. Bundled path (T11979): <cleo-package-root>/studio-dist/
  //    import.meta.url resolves to the compiled .js file under dist/cli/;
  //    walking up 3 levels reaches the package root.
  try {
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const bundled = join(pkgRoot, 'studio-dist');
    if (existsSync(join(bundled, 'index.js'))) {
      return bundled;
    }
  } catch {
    // import.meta.url unavailable or path resolution failed — fall through.
  }

  // 3. Dev-checkout fallback: packages/studio/build relative to project root.
  const projectRoot = process.env['CLEO_ROOT'] ?? process.cwd();
  const devPath = join(projectRoot, 'packages', 'studio', 'build');
  if (existsSync(join(devPath, 'index.js'))) {
    return devPath;
  }

  return undefined;
}

/**
 * Resolve the Studio `build/client/` static asset directory for gateway
 * static serving (T11979).
 *
 * Returns the `client/` subdirectory of the resolved Studio build dir, or
 * `undefined` when no build exists. This path is injected into the gateway's
 * HTTP server to serve Studio static assets at `/studio`.
 *
 * @returns Absolute path to `build/client/`, or `undefined`.
 */
export function resolveStudioStaticDir(): string | undefined {
  const buildDir = resolveStudioDir();
  if (buildDir === undefined) return undefined;
  const clientDir = join(buildDir, 'client');
  return existsSync(clientDir) ? clientDir : undefined;
}

/**
 * Resolve the runtime file paths for the web server.
 *
 * All paths are rooted under `getCleoHome()` so they follow the XDG convention
 * used by the rest of the CLEO runtime.
 */
export function getWebPaths(): {
  pidFile: string;
  configFile: string;
  logDir: string;
  logFile: string;
} {
  const cleoHome = getCleoHome();
  return {
    pidFile: join(cleoHome, 'web-server.pid'),
    configFile: join(cleoHome, 'web-server.json'),
    logDir: join(cleoHome, 'logs'),
    logFile: join(cleoHome, 'logs', 'web-server.log'),
  };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Check whether a process is alive by sending signal 0.
 *
 * Returns `true` if the process exists and is not a zombie; `false` otherwise.
 *
 * @param pid - OS process ID.
 */
export function isWebProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current web server status from the PID file and config file.
 *
 * Returns a structured status object usable by CLI command handlers.
 */
export async function getWebStatus(): Promise<{
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

    if (Number.isNaN(pid) || !isWebProcessRunning(pid)) {
      return { running: false, pid: null, port: null, host: null, url: null };
    }

    let port = WEB_DEFAULT_PORT;
    let host = WEB_DEFAULT_HOST;

    try {
      const config = JSON.parse(await readFile(configFile, 'utf-8')) as {
        port?: number;
        host?: string;
      };
      port = config.port ?? WEB_DEFAULT_PORT;
      host = config.host ?? WEB_DEFAULT_HOST;
    } catch {
      // Defaults are fine.
    }

    return { running: true, pid, port, host, url: `http://${host}:${port}` };
  } catch {
    return { running: false, pid: null, port: null, host: null, url: null };
  }
}

// ---------------------------------------------------------------------------
// Subsystem context
// ---------------------------------------------------------------------------

/**
 * The live context the web subsystem threads from `start()` into `shutdown()`.
 *
 * Carrying `pid` + `pidFile` lets `shutdown()` send SIGTERM/SIGKILL without
 * re-reading the PID file (which might be gone by shutdown time).
 */
export interface WebSubsystemContext {
  /** The child process PID. */
  readonly pid: number;
  /** Absolute path to the atomic PID file. */
  readonly pidFile: string;
  /** Absolute path to the server log file (informational). */
  readonly logFile: string;
  /** The bound port (for healthProbe reporting). */
  readonly port: number;
  /** The bind host (for healthProbe reporting). */
  readonly host: string;
}

// ---------------------------------------------------------------------------
// Subsystem factory
// ---------------------------------------------------------------------------

/** Options for a web subsystem instance. */
export interface WebSubsystemOptions {
  /** TCP port the server should bind. Defaults to {@link WEB_DEFAULT_PORT}. */
  port?: number;
  /** Bind host. Defaults to {@link WEB_DEFAULT_HOST}. */
  host?: string;
}

/**
 * Declare the CLEO Studio web server as a supervised daemon subsystem.
 *
 * The returned subsystem (frozen by `defineSubsystem`) is registered with a
 * `SubsystemRegistry`, which then drives its lifecycle uniformly:
 *
 *  - `start()`       — launches the Studio adapter-node server as a detached
 *    child process, writes the PID file atomically, and polls the health
 *    endpoint until it responds (or fails after 15 s).
 *  - `healthProbe()` — reads the PID file and returns a {@link SubsystemHealth}
 *    row. Reports `running` while the process is alive, `stopped` otherwise.
 *  - `shutdown()`    — sends SIGTERM with a 30 s grace period, escalating to
 *    SIGKILL on timeout, then removes the PID file.
 *
 * @param opts - Optional port / host overrides.
 * @returns A frozen subsystem ready to `register()` with a `SubsystemRegistry`.
 *
 * @example
 * ```ts
 * const registry = new SubsystemRegistry();
 * registry.register(createWebSubsystem({ port: 3456 }));
 * await registry.startAll();
 * ```
 */
export function createWebSubsystem(
  opts: WebSubsystemOptions = {},
): ReturnType<typeof defineSubsystem<WebSubsystemContext>> {
  const port = opts.port ?? WEB_DEFAULT_PORT;
  const host = opts.host ?? WEB_DEFAULT_HOST;

  // Closure-captured live context so healthProbe() can report state without
  // arguments (the Subsystem contract passes no args to healthProbe).
  let live: WebSubsystemContext | undefined;

  return defineSubsystem<WebSubsystemContext>({
    name: WEB_SUBSYSTEM_NAME,

    async start(): Promise<WebSubsystemContext> {
      const { pidFile, configFile, logFile, logDir } = getWebPaths();

      // Guard: do not start if already running.
      const existing = await getWebStatus();
      if (existing.running && existing.pid !== null) {
        // Reuse the live context — the server is already up.
        const ctx: WebSubsystemContext = {
          pid: existing.pid,
          pidFile,
          logFile,
          port: existing.port ?? port,
          host: existing.host ?? host,
        };
        live = ctx;
        return ctx;
      }

      // Resolve Studio build directory using the priority-ordered resolver
      // (T11979): bundled path (npm install) → CLEO_STUDIO_DIR override →
      // dev-checkout fallback.
      const resolvedStudioDir = resolveStudioDir();
      const studioDir =
        resolvedStudioDir ??
        join(process.env['CLEO_ROOT'] ?? process.cwd(), 'packages', 'studio', 'build');
      const webIndexPath = join(studioDir, 'index.js');

      // Ensure log directory and config file exist.
      await mkdir(logDir, { recursive: true });
      await writeFile(
        configFile,
        JSON.stringify({ port, host, startedAt: new Date().toISOString() }),
      );

      // Build Studio if needed (dev-checkout only — the bundled path already has index.js).
      try {
        await stat(webIndexPath);
      } catch {
        const projectRoot = process.env['CLEO_ROOT'] ?? process.cwd();
        try {
          execFileSync('pnpm', ['--filter', '@cleocode/studio', 'run', 'build'], {
            cwd: projectRoot,
            stdio: 'ignore',
          });
        } catch {
          throw new Error(
            `Studio build failed. Run: pnpm --filter @cleocode/studio run build\nLogs: ${logFile}`,
          );
        }
      }

      // Open log file for stdio redirection (O_CREAT | O_APPEND).
      const logFileHandle = await open(logFile, 'a');

      // Spawn the Studio adapter-node server detached.
      const serverProcess = spawn('node', [webIndexPath], {
        cwd: studioDir,
        env: {
          ...process.env,
          HOST: host,
          PORT: String(port),
          CLEO_ROOT: process.env['CLEO_ROOT'] ?? process.cwd(),
        },
        detached: true,
        stdio: ['ignore', logFileHandle.fd, logFileHandle.fd],
      });

      // Detach from the parent process so the server survives terminal close.
      serverProcess.unref();

      // Atomically write PID file.
      const pidFileTmp = `${pidFile}.tmp`;
      await writeFile(pidFileTmp, String(serverProcess.pid));
      await rm(pidFile, { force: true });
      await writeFile(pidFile, String(serverProcess.pid));
      await rm(pidFileTmp, { force: true });

      await logFileHandle.close();

      // Poll for server readiness (up to 15 s).
      let started = false;
      for (let i = 0; i < STARTUP_POLL_ITERATIONS; i++) {
        try {
          const response = await fetch(`http://${host}:${port}/api/health`);
          if (response.ok) {
            started = true;
            break;
          }
        } catch {
          // Not ready yet.
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }

      if (!started) {
        // Best-effort kill the child so it doesn't become an orphan.
        try {
          process.kill(serverProcess.pid!, 'SIGTERM');
        } catch {
          /* ignore */
        }
        await rm(pidFile, { force: true });
        throw new Error('Studio web server failed to start within 15 seconds');
      }

      const ctx: WebSubsystemContext = {
        pid: serverProcess.pid!,
        pidFile,
        logFile,
        port,
        host,
      };
      live = ctx;
      return ctx;
    },

    healthProbe(): SubsystemHealth {
      if (live === undefined) {
        const stopped: SubsystemState = 'stopped';
        return {
          child_id: WEB_SUBSYSTEM_NAME,
          pid: 0,
          state: stopped,
          restart_count: 0,
          detail: 'not started',
        };
      }

      const alive = isWebProcessRunning(live.pid);
      const state: SubsystemState = alive ? 'running' : 'stopped';
      return {
        child_id: WEB_SUBSYSTEM_NAME,
        pid: alive ? live.pid : 0,
        state,
        restart_count: 0,
        detail: alive
          ? `url=http://${live.host}:${live.port} pid=${live.pid}`
          : `pid=${live.pid} exited`,
      };
    },

    async shutdown(context: WebSubsystemContext): Promise<void> {
      const { pidFile } = context;

      if (!isWebProcessRunning(context.pid)) {
        await rm(pidFile, { force: true });
        live = undefined;
        return;
      }

      // SIGTERM with grace period.
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(context.pid), '/T'], { stdio: 'ignore' });
        } else {
          process.kill(context.pid, 'SIGTERM');
        }
      } catch {
        /* ignore — process may have exited already */
      }

      for (let i = 0; i < SIGTERM_GRACE_ITERATIONS; i++) {
        if (!isWebProcessRunning(context.pid)) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }

      // Escalate to SIGKILL if still alive after grace period.
      if (isWebProcessRunning(context.pid)) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(context.pid), '/F', '/T'], { stdio: 'ignore' });
          } else {
            process.kill(context.pid, 'SIGKILL');
          }
        } catch {
          /* ignore */
        }
      }

      await rm(pidFile, { force: true });
      live = undefined;
    },
  });
}
