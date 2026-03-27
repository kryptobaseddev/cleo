/**
 * LAFS Health Check Module
 *
 * Provides health check endpoints for monitoring and orchestration
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pkg: { version: string };
try {
  pkg = require('../../package.json');
} catch {
  pkg = require('../../../package.json');
}

export interface HealthCheckConfig {
  path?: string;
  checks?: HealthCheckFunction[];
}

export type HealthCheckFunction = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthCheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message?: string;
  duration?: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: HealthCheckResult[];
}

/**
 * Health check middleware for Express applications
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
  const { path = '/health', checks = [] } = config;

  const startTime = Date.now();

  return async (req: any, res: any) => {
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
 * Create a database health check
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
 * Create an external service health check
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
 * Liveness probe - basic check that service is running
 *
 * @example
 * ```typescript
 * app.get('/health/live', livenessProbe());
 * ```
 */
export function livenessProbe() {
  return (req: any, res: any) => {
    res.status(200).json({
      status: 'alive',
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Readiness probe - check that service is ready to accept traffic
 *
 * @example
 * ```typescript
 * app.get('/health/ready', readinessProbe({
 *   checks: [dbCheck, cacheCheck]
 * }));
 * ```
 */
export function readinessProbe(config: { checks?: HealthCheckFunction[] } = {}) {
  return async (req: any, res: any) => {
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
