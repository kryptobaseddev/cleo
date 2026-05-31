/**
 * Docs-viewer subsystem — expresses the CLEO docs-viewer HTTP server as a
 * supervised daemon {@link Subsystem} via `defineSubsystem()`.
 *
 * This is the **R7 migration target**: the standalone spawn loop that previously
 * lived in `commands/docs-viewer.ts` (`serveCommand`) is moved here so a
 * `SubsystemRegistry` can drive its `start → healthProbe → shutdown` lifecycle
 * identically to every other long-running concern (the gateway, the GC cron,
 * the web server, …).
 *
 * The CLI subcommands (`cleo docs serve | open | stop | viewer-status | viewer`)
 * delegate the heavy lifecycle logic here; the command handlers themselves remain
 * thin citty dispatch. No new `@cleocode/cleo` circular-dependency is introduced
 * in this module — it only imports from `@cleocode/contracts`, `@cleocode/core`,
 * `@cleocode/runtime/daemon`, and Node built-ins.
 *
 * Context threaded from `start()` into `shutdown()`:
 * - `pid`      — the process PID (this process in foreground, child PID when
 *                the server is spawned detached).
 * - `pidFile`  — path to the atomic viewer PID file for cleanup on shutdown.
 * - `port`     — the bound TCP port (for healthProbe reporting).
 * - `host`     — the bind host (for healthProbe reporting).
 *
 * @packageDocumentation
 * @module @cleocode/cleo/cli
 *
 * @task T11508 R7-T1 — create docs-viewer-subsystem.ts; delete standalone spawn
 * @task T11509 R7-T2 — wire into daemon entry; update docs serve to delegate
 * @epic T11258 R7 — migrate docs-viewer.ts → daemon subsystem
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubsystemHealth, SubsystemState } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/core';
import { defineSubsystem } from '@cleocode/runtime/daemon';
import {
  isProcessAlive,
  readViewerPidFile,
  removeViewerPidFile,
  viewerPidFilePath,
  writeViewerPidFile,
} from '../viewer/pidfile.js';
import { startViewer } from '../viewer/server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TCP start port for the docs viewer (preserved from docs-viewer.ts). */
export const VIEWER_DEFAULT_PORT = 7777;

/** Default TCP end port (auto-increment ceiling). */
export const VIEWER_DEFAULT_END_PORT = 7800;

/** Default bind host (loopback only by default). */
export const VIEWER_DEFAULT_HOST = '127.0.0.1';

/** Logical subsystem name — matches the supervised `child_id`. */
export const VIEWER_SUBSYSTEM_NAME = 'cleo-docs-viewer';

/** Grace-period iterations at 500 ms each (10 s total) before SIGKILL. */
const SIGTERM_GRACE_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime file paths used by the docs-viewer subsystem.
 *
 * All paths are rooted under `getCleoHome()` so they follow the XDG convention
 * used by the rest of the CLEO runtime.
 */
export function getViewerPaths(): {
  pidFile: string;
  logFile: string;
  logDir: string;
} {
  const cleoHome = getCleoHome();
  return {
    pidFile: viewerPidFilePath(),
    logFile: join(cleoHome, 'viewer.log'),
    logDir: cleoHome,
  };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Check whether a docs-viewer process is alive by sending signal 0.
 *
 * Returns `true` if the process exists; `false` otherwise. Delegates to
 * `isProcessAlive` from the viewer pidfile module so both paths use
 * a single signal-0 probe implementation.
 *
 * @param pid - OS process ID.
 */
export function isViewerProcessRunning(pid: number): boolean {
  return isProcessAlive(pid);
}

/**
 * Read the current docs-viewer status from the pidfile.
 *
 * Returns a structured status object usable by CLI command handlers.
 */
export async function getViewerStatus(): Promise<{
  running: boolean;
  pid: number | null;
  port: number | null;
  host: string | null;
  url: string | null;
}> {
  const record = await readViewerPidFile();
  if (!record) return { running: false, pid: null, port: null, host: null, url: null };
  if (!isProcessAlive(record.pid)) {
    await removeViewerPidFile();
    return { running: false, pid: null, port: null, host: null, url: null };
  }
  return {
    running: true,
    pid: record.pid,
    port: record.port,
    host: record.host,
    url: `http://${record.host}:${record.port}`,
  };
}

// ---------------------------------------------------------------------------
// Subsystem context
// ---------------------------------------------------------------------------

/**
 * The live context the docs-viewer subsystem threads from `start()` into
 * `shutdown()`.
 *
 * Carrying `pid` + `pidFile` lets `shutdown()` send SIGTERM/SIGKILL without
 * re-reading the pidfile (which might be gone by shutdown time).
 */
export interface DocsViewerSubsystemContext {
  /** The docs-viewer server process PID. */
  readonly pid: number;
  /** Absolute path to the atomic pidfile. */
  readonly pidFile: string;
  /** The bound TCP port (for healthProbe reporting). */
  readonly port: number;
  /** The bind host (for healthProbe reporting). */
  readonly host: string;
}

// ---------------------------------------------------------------------------
// Subsystem factory
// ---------------------------------------------------------------------------

/** Options for a docs-viewer subsystem instance. */
export interface DocsViewerSubsystemOptions {
  /** TCP port to try first. Defaults to {@link VIEWER_DEFAULT_PORT}. */
  startPort?: number;
  /** Last port to try when auto-incrementing. Defaults to {@link VIEWER_DEFAULT_END_PORT}. */
  endPort?: number;
  /** Bind host. Defaults to {@link VIEWER_DEFAULT_HOST}. */
  host?: string;
  /** When `true`, disable auto-increment when start port is busy. */
  noAutoPort?: boolean;
}

/**
 * Declare the CLEO docs-viewer HTTP server as a supervised daemon subsystem.
 *
 * The returned subsystem (frozen by `defineSubsystem`) is registered with a
 * `SubsystemRegistry`, which then drives its lifecycle uniformly:
 *
 *  - `start()`       — binds the HTTP server via `startViewer`, writes the
 *    pidfile atomically, and returns a {@link DocsViewerSubsystemContext}.
 *    If the viewer is already running (live pidfile + alive pid), reuses the
 *    existing instance without spawning a second one.
 *  - `healthProbe()` — reads the pidfile and returns a {@link SubsystemHealth}
 *    row. Reports `running` while the process is alive, `stopped` otherwise.
 *  - `shutdown()`    — sends SIGTERM with a 10 s grace period, escalating to
 *    SIGKILL on timeout, then removes the pidfile.
 *
 * @param opts - Optional port / host / auto-increment overrides.
 * @returns A frozen subsystem ready to `register()` with a `SubsystemRegistry`.
 *
 * @example
 * ```ts
 * const registry = new SubsystemRegistry();
 * registry.register(createDocsViewerSubsystem({ startPort: 7777 }));
 * await registry.startAll();
 * ```
 */
export function createDocsViewerSubsystem(
  opts: DocsViewerSubsystemOptions = {},
): ReturnType<typeof defineSubsystem<DocsViewerSubsystemContext>> {
  const startPort = opts.startPort ?? VIEWER_DEFAULT_PORT;
  const endPort = opts.endPort ?? VIEWER_DEFAULT_END_PORT;
  const host = opts.host ?? VIEWER_DEFAULT_HOST;
  const autoIncrement = !(opts.noAutoPort ?? false);

  // Closure-captured live context so healthProbe() can report state without
  // arguments (the Subsystem contract passes no args to healthProbe).
  let live: DocsViewerSubsystemContext | undefined;

  return defineSubsystem<DocsViewerSubsystemContext>({
    name: VIEWER_SUBSYSTEM_NAME,

    async start(): Promise<DocsViewerSubsystemContext> {
      const { pidFile, logDir } = getViewerPaths();

      // Guard: do not start if already running — reuse existing instance.
      const existing = await getViewerStatus();
      if (existing.running && existing.pid !== null) {
        const ctx: DocsViewerSubsystemContext = {
          pid: existing.pid,
          pidFile,
          port: existing.port ?? startPort,
          host: existing.host ?? host,
        };
        live = ctx;
        return ctx;
      }

      // Ensure the log directory exists (XDG home).
      await mkdir(logDir, { recursive: true });

      // Bind the viewer HTTP server in-process.
      const handle = await startViewer({
        startPort,
        endPort,
        host,
        autoIncrement,
      });

      // Write the pidfile so stop / open / status can find us.
      await writeViewerPidFile({
        pid: process.pid,
        port: handle.port,
        host: handle.host,
        projectRoot: process.cwd(),
        startedAt: Date.now(),
      });

      const ctx: DocsViewerSubsystemContext = {
        pid: process.pid,
        pidFile,
        port: handle.port,
        host: handle.host,
      };
      live = ctx;
      return ctx;
    },

    healthProbe(): SubsystemHealth {
      if (live === undefined) {
        const stopped: SubsystemState = 'stopped';
        return {
          child_id: VIEWER_SUBSYSTEM_NAME,
          pid: 0,
          state: stopped,
          restart_count: 0,
          detail: 'not started',
        };
      }

      const alive = isViewerProcessRunning(live.pid);
      const state: SubsystemState = alive ? 'running' : 'stopped';
      return {
        child_id: VIEWER_SUBSYSTEM_NAME,
        pid: alive ? live.pid : 0,
        state,
        restart_count: 0,
        detail: alive
          ? `url=http://${live.host}:${live.port} pid=${live.pid}`
          : `pid=${live.pid} exited`,
      };
    },

    async shutdown(context: DocsViewerSubsystemContext): Promise<void> {
      // If the process is already gone, just clean up the pidfile.
      if (!isViewerProcessRunning(context.pid)) {
        await removeViewerPidFile();
        live = undefined;
        return;
      }

      // SIGTERM with grace period.
      try {
        process.kill(context.pid, 'SIGTERM');
      } catch {
        /* ignore — process may have exited already */
      }

      for (let i = 0; i < SIGTERM_GRACE_ITERATIONS; i++) {
        if (!isViewerProcessRunning(context.pid)) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }

      // Escalate to SIGKILL if still alive after grace period.
      if (isViewerProcessRunning(context.pid)) {
        try {
          process.kill(context.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }

      await removeViewerPidFile();
      live = undefined;
    },
  });
}
