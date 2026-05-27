/**
 * LAFS Health Check Module
 *
 * Provides health check endpoints for monitoring and orchestration.
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pkg: { version: string };
try {
  pkg = require('../../package.json');
} catch {
  pkg = require('../../../package.json');
}

/** Configuration for the {@link healthCheck} middleware. */
export interface HealthCheckConfig {
  /**
   * URL path at which the health endpoint is mounted.
   * @defaultValue '/health'
   */
  path?: string;

  /**
   * Array of custom health check functions to run on each request.
   * @defaultValue []
   */
  checks?: HealthCheckFunction[];
}

/**
 * A function that performs a single health check.
 *
 * @remarks
 * May be synchronous or asynchronous. Must return a {@link HealthCheckResult}
 * describing the outcome.
 */
export type HealthCheckFunction = () => Promise<HealthCheckResult> | HealthCheckResult;

/** Result of an individual health check. */
export interface HealthCheckResult {
  /** Human-readable name identifying this check. */
  name: string;

  /** Outcome status of the check. */
  status: 'ok' | 'warning' | 'error';

  /**
   * Optional descriptive message providing additional detail.
   * @defaultValue undefined
   */
  message?: string;

  /**
   * Execution duration of the check in milliseconds.
   * @defaultValue undefined
   */
  duration?: number;
}

/** Aggregated health status returned by the health endpoint. */
export interface HealthStatus {
  /** Overall service health derived from individual check results. */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** ISO-8601 timestamp of when the health check was performed. */
  timestamp: string;

  /** LAFS package version. */
  version: string;

  /** Server uptime in seconds since the middleware was initialised. */
  uptime: number;

  /** Individual check results. */
  checks: HealthCheckResult[];
}

/**
 * Health check middleware for Express applications.
 *
 * @remarks
 * Runs all configured checks on each request, determines an overall status
 * (`healthy`, `degraded`, or `unhealthy`), and responds with a JSON
 * {@link HealthStatus} body. Returns HTTP 200 for healthy/degraded and 503
 * for unhealthy. Two built-in checks (`envelopeValidation` and
 * `tokenBudgets`) are always appended.
 *
 * @param config - Optional health check configuration
 * @returns An Express-compatible middleware function that serves the health endpoint
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { healthCheck } from '@cleocode/lafs/health';
 *
 * const app = express();
 *
 * // Basic health check
 * app.use('/health', healthCheck());
 *
 * // Custom health checks
 * app.use('/health', healthCheck({
 *   checks: [
 *     async () => ({
 *       name: 'database',
 *       status: await checkDatabase() ? 'ok' : 'error'
 *     })
 *   ]
 * }));
 * ```
 */
export function healthCheck(config: HealthCheckConfig = {}) {
  const { path: _path = '/health', checks = [] } = config;

  const startTime = Date.now();

  return async (
    _req: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
  ) => {
    const timestamp = new Date().toISOString();
    const checkResults: HealthCheckResult[] = [];

    // Run all health checks
    for (const check of checks) {
      const start = Date.now();
      try {
        const result = await check();
        result.duration = Date.now() - start;
        checkResults.push(result);
      } catch (error) {
        checkResults.push({
          name: 'unknown',
          status: 'error',
          message: error instanceof Error ? error.message : 'Check failed',
          duration: Date.now() - start,
        });
      }
    }

    // Add default checks
    checkResults.push({
      name: 'envelopeValidation',
      status: 'ok',
    });

    checkResults.push({
      name: 'tokenBudgets',
      status: 'ok',
    });

    // Determine overall status
    const hasErrors = checkResults.some((c) => c.status === 'error');
    const hasWarnings = checkResults.some((c) => c.status === 'warning');

    const status: HealthStatus['status'] = hasErrors
      ? 'unhealthy'
      : hasWarnings
        ? 'degraded'
        : 'healthy';

    const health: HealthStatus = {
      status,
      timestamp,
      version: pkg.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      checks: checkResults,
    };

    const statusCode = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
    res.status(statusCode).json(health);
  };
}

/**
 * Create a health check function that verifies database connectivity.
 *
 * @remarks
 * Wraps a caller-supplied connection check and returns a {@link HealthCheckResult}
 * with status `'ok'` or `'error'` depending on whether the connection succeeds.
 * Exceptions thrown by `checkConnection` are caught and reported as errors.
 *
 * @param config - Database check configuration
 * @param config.checkConnection - Async function returning `true` if the database is reachable
 * @param config.name - Display name for this check in health output
 * @returns A {@link HealthCheckFunction} suitable for use in {@link HealthCheckConfig.checks}
 *
 * @example
 * ```typescript
 * const dbCheck = createDatabaseHealthCheck({
 *   checkConnection: async () => await db.ping()
 * });
 *
 * app.use('/health', healthCheck({
 *   checks: [dbCheck]
 * }));
 * ```
 */
export function createDatabaseHealthCheck(config: {
  checkConnection: () => Promise<boolean>;
  name?: string;
}): HealthCheckFunction {
  return async () => {
    try {
      const isConnected = await config.checkConnection();
      return {
        name: config.name || 'database',
        status: isConnected ? 'ok' : 'error',
        message: isConnected ? 'Connected' : 'Connection failed',
      };
    } catch (error) {
      return {
        name: config.name || 'database',
        status: 'error',
        message: error instanceof Error ? error.message : 'Database check failed',
      };
    }
  };
}

/**
 * Create a health check function that probes an external HTTP service.
 *
 * @remarks
 * Sends a `GET` request to the configured URL with an abort timeout. Returns
 * status `'ok'` when the response is successful (HTTP 2xx) and `'error'`
 * otherwise. Network failures and timeouts are caught and reported.
 *
 * @param config - External service check configuration
 * @param config.name - Display name for this check in health output
 * @param config.url - URL to probe for health status
 * @param config.timeout - Request timeout in milliseconds
 * @returns A {@link HealthCheckFunction} suitable for use in {@link HealthCheckConfig.checks}
 *
 * @example
 * ```typescript
 * const apiCheck = createExternalServiceHealthCheck({
 *   name: 'payment-api',
 *   url: 'https://api.payment.com/health',
 *   timeout: 5000
 * });
 * ```
 */
export function createExternalServiceHealthCheck(config: {
  name: string;
  url: string;
  timeout?: number;
}): HealthCheckFunction {
  return async () => {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeout || 5000);

      const response = await fetch(config.url, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      return {
        name: config.name,
        status: response.ok ? 'ok' : 'error',
        message: response.ok ? 'Service healthy' : `HTTP ${response.status}`,
        duration: Date.now() - start,
      };
    } catch (error) {
      return {
        name: config.name,
        status: 'error',
        message: error instanceof Error ? error.message : 'Service unreachable',
        duration: Date.now() - start,
      };
    }
  };
}

/**
 * Liveness probe -- a minimal check confirming the process is running.
 *
 * @remarks
 * Returns a 200 response with `{ status: 'alive', timestamp }`. Intended for
 * Kubernetes liveness probes or equivalent orchestrator health checks that
 * only need to verify the process has not crashed.
 *
 * @returns An Express-compatible middleware function
 *
 * @example
 * ```typescript
 * app.get('/health/live', livenessProbe());
 * ```
 */
export function livenessProbe() {
  return (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Readiness probe -- verifies the service can accept traffic.
 *
 * @remarks
 * Runs all configured health checks and responds with 200 (`ready`) when
 * every check passes or 503 (`not ready`) when any check reports an error.
 * Intended for Kubernetes readiness probes or load balancer health checks.
 *
 * @param config - Optional configuration with custom health check functions
 * @returns An Express-compatible async middleware function
 *
 * @example
 * ```typescript
 * app.get('/health/ready', readinessProbe({
 *   checks: [dbCheck, cacheCheck]
 * }));
 * ```
 */
export function readinessProbe(config: { checks?: HealthCheckFunction[] } = {}) {
  return async (
    _req: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
  ) => {
    const checkResults: HealthCheckResult[] = [];

    if (config.checks) {
      for (const check of config.checks) {
        try {
          const result = await check();
          checkResults.push(result);
        } catch (error) {
          checkResults.push({
            name: 'unknown',
            status: 'error',
            message: error instanceof Error ? error.message : 'Check failed',
          });
        }
      }
    }

    const hasErrors = checkResults.some((c) => c.status === 'error');

    if (hasErrors) {
      res.status(503).json({
        status: 'not ready',
        checks: checkResults,
      });
    } else {
      res.status(200).json({
        status: 'ready',
        checks: checkResults,
      });
    }
  };
}
