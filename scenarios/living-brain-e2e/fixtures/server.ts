/**
 * HTTP server module for the living-brain-e2e scenario.
 *
 * Imports validateUser from auth.ts, creating a call-graph edge
 * that proves the NEXUS substrate tracks inter-module dependencies.
 */

import { validateUser } from './auth.js';
import { loadConfig } from './config.js';

/**
 * Start the application server on the specified port.
 *
 * @param port - TCP port to bind to (defaults to config value)
 */
export function startServer(port?: number): void {
  const config = loadConfig();
  const bindPort = port ?? config.port;
  console.log(`[server] Listening on port ${bindPort} — ${config.name}`);
}

/**
 * Handle an incoming HTTP request by validating the bearer token.
 *
 * @param token - Bearer token from the Authorization header
 * @returns true if the request is authenticated
 */
export function handleRequest(token: string): boolean {
  return validateUser(token);
}
