/**
 * LAFS Graceful Shutdown Module
 * 
 * Handles graceful shutdown of LAFS servers
 */

import { Server } from 'http';

export interface GracefulShutdownConfig {
  timeout?: number;
  signals?: NodeJS.Signals[];
  onShutdown?: () => Promise<void> | void;
  onClose?: () => Promise<void> | void;
}

export interface ShutdownState {
  isShuttingDown: boolean;
  activeConnections: number;
  shutdownStartTime?: Date;
}

const state: ShutdownState = {
  isShuttingDown: false,
  activeConnections: 0
};

/**
 * Enable graceful shutdown for an HTTP server
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
export function gracefulShutdown(
  server: Server,
  config: GracefulShutdownConfig = {}
): void {
  const {
    timeout = 30000,
    signals = ['SIGTERM', 'SIGINT'],
    onShutdown,
    onClose
  } = config;

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
  onClose?: () => Promise<void> | void
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
          setTimeout(() => reject(new Error('Shutdown timeout')), timeout)
        )
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
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if server is shutting down
 */
export function isShuttingDown(): boolean {
  return state.isShuttingDown;
}

/**
 * Get shutdown state
 */
export function getShutdownState(): ShutdownState {
  return { ...state };
}

/**
 * Force immediate shutdown (emergency use only)
 */
export function forceShutdown(exitCode: number = 1): void {
  console.log('Force shutting down...');
  process.exit(exitCode);
}

/**
 * Middleware to reject requests during shutdown
 * 
 * @example
 * ```typescript
 * app.use(shutdownMiddleware());
 * ```
 */
export function shutdownMiddleware() {
  return (req: any, res: any, next: any) => {
    if (state.isShuttingDown) {
      res.status(503).json({
        error: 'Service is shutting down',
        status: 'unavailable'
      });
      return;
    }
    next();
  };
}

/**
 * Wait for shutdown to complete
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
