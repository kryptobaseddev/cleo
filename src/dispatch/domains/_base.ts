/**
 * Shared base helpers for domain handlers.
 * DRY utility -- extracts the 4 common patterns found in all 10 domain handlers.
 *
 * All functions are standalone (not a class) to match the function-based helper style.
 * Handlers call these instead of re-implementing wrapEngineResult, errorResponse, etc.
 *
 * @epic T5671
 */

import type { DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';

/**
 * Engine result shape accepted by wrapResult.
 * Matches the union of what all engine functions return.
 */
export interface EngineResult {
  success: boolean;
  data?: unknown;
  page?: import('@cleocode/lafs-protocol').LAFSPage;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

/**
 * Wrap a native engine result into a DispatchResponse.
 * Handles success data, page metadata, and structured errors.
 */
export function wrapResult(
  result: EngineResult,
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  return {
    _meta: dispatchMeta(gateway, domain, operation, startTime),
    success: result.success,
    ...(result.success ? { data: result.data } : {}),
    ...(result.page ? { page: result.page } : {}),
    ...(result.error ? {
      error: {
        code: result.error.code,
        message: result.error.message,
        details: result.error.details as Record<string, unknown> | undefined,
        fix: result.error.fix,
        alternatives: result.error.alternatives,
      },
    } : {}),
  };
}

/**
 * Return a standard error response.
 */
export function errorResult(
  gateway: string,
  domain: string,
  operation: string,
  code: string,
  message: string,
  startTime: number,
): DispatchResponse {
  return {
    _meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code, message },
  };
}

/**
 * Return a standard "unsupported operation" error response.
 */
export function unsupportedOp(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): DispatchResponse {
  return {
    _meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code: 'E_INVALID_OPERATION', message: `Unknown ${domain} ${gateway}: ${operation}` },
  };
}

/**
 * Extract limit and offset pagination params from a params dict.
 */
export function getListParams(params?: Record<string, unknown>): { limit?: number; offset?: number } {
  const limit = typeof params?.limit === 'number' && params.limit > 0 ? params.limit : undefined;
  const offset = typeof params?.offset === 'number' && params.offset > 0 ? params.offset : undefined;
  return { limit, offset };
}

/**
 * Handle a caught error: extract message and return an internal error response.
 * Callers should log the error themselves (with their domain-specific logger)
 * before or after calling this.
 */
export function handleErrorResult(
  gateway: string,
  domain: string,
  operation: string,
  error: unknown,
  startTime: number,
): DispatchResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    _meta: dispatchMeta(gateway, domain, operation, startTime),
    success: false,
    error: { code: 'E_INTERNAL', message },
  };
}
