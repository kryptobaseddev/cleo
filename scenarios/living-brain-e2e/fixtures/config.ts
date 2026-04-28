/**
 * Application configuration module for the living-brain-e2e scenario.
 *
 * Provides the AppConfig interface and loadConfig factory used by both
 * auth.ts and server.ts, creating cross-module relationships in the
 * NEXUS call graph.
 */

/**
 * Application runtime configuration shape.
 */
export interface AppConfig {
  /** Human-readable application name */
  name: string;
  /** Authentication secret (hashed) */
  secret: string;
  /** HTTP listener port */
  port: number;
}

/**
 * Load the application configuration from the environment.
 *
 * @returns A fully-populated AppConfig with sane defaults
 */
export function loadConfig(): AppConfig {
  return {
    name: process.env['APP_NAME'] ?? 'living-brain-demo',
    secret: process.env['APP_SECRET'] ?? 'abc123',
    port: Number(process.env['PORT'] ?? '3000'),
  };
}
