/**
 * LAFS Graceful Shutdown Module
 *
 * Handles graceful shutdown of LAFS servers.
 *
 * @packageDocumentation
 */

import type { Server } from 'http';

/** Configuration for the {@link gracefulShutdown} handler. */
export interface GracefulShutdownConfig {
  /**
   * Maximum time in milliseconds to wait for in-flight requests before forcing exit.
   * @defaultValue 30000
   */
  timeout?: number;

  /**
   * POSIX signals that trigger a graceful shutdown.
   * @defaultValue ['SIGTERM', 'SIGINT']
   */
  signals?: NodeJS.Signals[];

  /**
   * Callback invoked at the start of shutdown, before the server stops accepting connections.
   * @defaultValue undefined
   */
  onShutdown?: () => Promise<void> | void;

  /**
   * Callback invoked after all connections have closed (or the timeout elapsed).
   * @defaultValue undefined
   */
  onClose?: () => Promise<void> | void;
}

/** Snapshot of the current shutdown state. */
export interface ShutdownState {
  /** Whether a shutdown sequence is currently in progress. */
  isShuttingDown: boolean;

  /** Number of TCP connections still open. */
  activeConnections: number;

  /**
   * Timestamp when the shutdown sequence began.
   * @defaultValue undefined
   */
  shutdownStartTime?: Date;
}

const state: ShutdownState = {
  isShuttingDown: false,
  activeConnections: 0,
};

/**
 * Enable graceful shutdown for an HTTP server.
 *
 * @remarks
 * Registers listeners for the configured signals (and uncaught errors) that
 * trigger an orderly shutdown sequence: invoke the `onShutdown` callback,
 * stop accepting new connections, drain existing connections up to the
 * timeout, invoke the `onClose` callback, and exit the process. New
 * connections received after shutdown starts are immediately destroyed.
 *
 * @param server - The Node.js HTTP server to manage
 * @param config - Optional shutdown configuration
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { gracefulShutdown } from '@cleocode/lafs/shutdown';
 *
 * const app = express();
 * const server = app.listen(3000);
 *
 * gracefulShutdown(server, {
 *   timeout: 30000,
 *   signals: ['SIGTERM', 'SIGINT'],
 *   onShutdown: async () => {
 *     console.log('Shutting down...');
 *     await db.close();
 *   }
 * });
 * ```
 */
export function gracefulShutdown(server: Server, config: GracefulShutdownConfig = {}): void {
  const { timeout = 30000, signals = ['SIGTERM', 'SIGINT'], onShutdown, onClose } = config;

  // Track active connections
  server.on('connection', (socket) => {
    if (state.isShuttingDown) {
      socket.destroy();
      return;
    }

    state.activeConnections++;

    socket.on('close', () => {
      state.activeConnections--;
    });
  });

  // Handle shutdown signals
  signals.forEach((signal) => {
    process.on(signal, async () => {
      console.log(`${signal} received, starting graceful shutdown...`);

      await performShutdown(server, timeout, onShutdown, onClose);
    });
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error);
    await performShutdown(server, timeout, onShutdown, onClose);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason);
    await performShutdown(server, timeout, onShutdown, onClose);
  });
}

async function performShutdown(
  server: Server,
  timeout: number,
  onShutdown?: () => Promise<void> | void,
  onClose?: () => Promise<void> | void,
): Promise<void> {
  if (state.isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }

  state.isShuttingDown = true;
  state.shutdownStartTime = new Date();

  try {
    // Call user shutdown handler
    if (onShutdown) {
      await Promise.race([
        onShutdown(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout')), timeout),
        ),
      ]);
    }

    // Stop accepting new connections
    server.close((err) => {
      if (err) {
        console.error('Error closing server:', err);
      } else {
        console.log('Server closed');
      }
    });

    // Wait for active connections to close
    const startTime = Date.now();
    while (state.activeConnections > 0 && Date.now() - startTime < timeout) {
      console.log(`Waiting for ${state.activeConnections} connections to close...`);
      await sleep(1000);
    }

    if (state.activeConnections > 0) {
      console.warn(`Forcing shutdown with ${state.activeConnections} active connections`);
    }

    // Call user close handler
    if (onClose) {
      await onClose();
    }

    console.log('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a shutdown sequence is currently in progress.
 *
 * @remarks
 * Returns `true` once a shutdown signal has been received and the shutdown
 * handler has started executing. Useful for guards that need to short-circuit
 * work when the process is going down.
 *
 * @returns `true` if the server is shutting down, `false` otherwise
 *
 * @example
 * ```typescript
 * if (isShuttingDown()) {
 *   return; // skip expensive work
 * }
 * ```
 */
export function isShuttingDown(): boolean {
  return state.isShuttingDown;
}

/**
 * Get a snapshot of the current shutdown state.
 *
 * @remarks
 * Returns a shallow copy of the internal {@link ShutdownState}, including
 * whether shutdown is in progress, the active connection count, and the
 * shutdown start time (if applicable).
 *
 * @returns A copy of the current {@link ShutdownState}
 *
 * @example
 * ```typescript
 * const state = getShutdownState();
 * console.log(`Connections: ${state.activeConnections}`);
 * ```
 */
export function getShutdownState(): ShutdownState {
  return { ...state };
}

/**
 * Terminate the process immediately without waiting for connections to drain.
 *
 * @remarks
 * Calls `process.exit()` with the given exit code. Intended only for
 * emergency situations where a graceful shutdown has stalled or a fatal
 * condition prevents orderly teardown.
 *
 * @param exitCode - Process exit code
 *
 * @example
 * ```typescript
 * forceShutdown(1);
 * ```
 */
export function forceShutdown(exitCode: number = 1): void {
  console.log('Force shutting down...');
  process.exit(exitCode);
}

/**
 * Express middleware that rejects requests with 503 while the server is shutting down.
 *
 * @remarks
 * Should be mounted early in the middleware stack so that new requests are
 * immediately rejected once shutdown begins, preventing work from starting
 * that cannot complete before the process exits.
 *
 * @returns An Express-compatible middleware function
 *
 * @example
 * ```typescript
 * app.use(shutdownMiddleware());
 * ```
 */
export function shutdownMiddleware() {
  return (
    _req: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (state.isShuttingDown) {
      res.status(503).json({
        error: 'Service is shutting down',
        status: 'unavailable',
      });
      return;
    }
    next();
  };
}

/**
 * Wait until a shutdown sequence begins.
 *
 * @remarks
 * Polls the internal shutdown state every 100ms and resolves once
 * `isShuttingDown` becomes `true`. Useful for test harnesses or background
 * workers that need to block until the process is going down.
 *
 * @returns A promise that resolves when shutdown has started
 *
 * @example
 * ```typescript
 * await waitForShutdown();
 * ```
 */
export async function waitForShutdown(): Promise<void> {
  while (!state.isShuttingDown) {
    await sleep(100);
  }
}
